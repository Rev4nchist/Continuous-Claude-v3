#!/usr/bin/env node
// fix-chains.mjs: finds defects that slipped past every gate, with no CodeRabbit input.
//   For each merged PR it reads the commit subjects. A fix commit (fix, revert, hotfix) has its removed lines blamed
//   to an earlier PR merged in the 30 days before the fix PR (the same gh api step as escape.mjs:44). Each match is one escape row.
//   This module is the ONE writer of <stateDir>/escapes.jsonl and <stateDir>/escape-baseline.json.
// A fix with no blame target is counted, not guessed (T19): no removed lines, no PR in the window, a gh or git failure.
// A fix of the PR's own new lines (a review round) is no escape and no "no target": it has its own count.
// Usage: see USAGE below. No args and --help print it and touch neither git nor gh.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { bandOf } from '../../github/review-router.mjs';
import { ESCAPES_FILE, classifyCause, readEscapeRows, stateDirOf } from './escape-causes.mjs';

const DAY = 86_400_000;
const GIT_BUFFER = 64 * 1024 * 1024;
const BASELINE_FILE = 'escape-baseline.json';
const BAND_ORDER = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL', 'UNKNOWN'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIELD = '\x1f';

// ---------- git and gh ----------

/** git(args) => { status, stdout, stderr } in cwd. No shell. A call that runs past timeoutMs is killed and reads as a failure (status 1). */
export function makeGit(cwd, { timeoutMs = 120_000 } = {}) {
  return (args) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_BUFFER, timeout: timeoutMs, killSignal: 'SIGKILL' });
    return { status: r.error ? 1 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
  };
}

/** gh(args) => parsed JSON. Throws on a failed call. */
export function makeGh() {
  return async (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: GIT_BUFFER, timeout: 60_000 });
    if (r.status !== 0) throw new Error(`gh ${args[0]} failed: ${String(r.stderr ?? r.error?.message ?? '').split('\n')[0]}`);
    return JSON.parse(r.stdout);
  };
}

/** review-router.config.json from the repo root, or null when it cannot be read (the band is then UNKNOWN). */
export function loadRouterConfig(file = path.join(HERE, '..', '..', '..', 'review-router.config.json')) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);

// ---------- the merged PRs ----------

/**
 * Every first-parent merge "Merge pull request #N from ..." on ref, oldest first, and the sha the ref resolves to.
 * Returns { merges, head }. The merge set is also the test of a blamed PR: its merge commit must be one of these.
 */
export function readMerges({ git, ref = 'main' }) {
  const r = git(['log', '--first-parent', '--reverse', `--format=%H%x1f%P%x1f%cI%x1f%s`, ref]);
  if (r.status !== 0) throw new Error(`git log ${ref} failed: ${r.stderr.trim().split('\n')[0]}`);
  const merges = lines(r.stdout).flatMap((l) => {
    const [mergeSha, parents, mergedAt, subject] = l.split(FIELD);
    const m = /^Merge pull request #(\d+) from /.exec(subject ?? '');
    return m && parents.split(' ').length >= 2 ? [{ pr: Number(m[1]), mergeSha, mergedAt, base: `${mergeSha}^1`, head: `${mergeSha}^2` }] : [];
  });
  const head = git(['rev-parse', '--verify', ref]);
  if (head.status !== 0) throw new Error(`git rev-parse ${ref} failed: ${head.stderr.trim().split('\n')[0]}`);
  return { merges, head: head.stdout.trim() };
}

/** The merges of readMerges inside a range, by PR number (by position in history) or by date. */
export function pickRange(merges, { ref = 'main', since, until, fromPr, toPr }) {
  return byDate(byRange(merges, fromPr, toPr, ref), since, until);
}

/** First-parent PR merges on ref, oldest first. Range by PR number (by position) or by date. */
export function listMergedPrs({ git, ref = 'main', since, until, fromPr, toPr }) {
  return pickRange(readMerges({ git, ref }).merges, { ref, since, until, fromPr, toPr });
}

function byRange(all, fromPr, toPr, ref) {
  const at = (n) => {
    const i = all.findIndex((p) => p.pr === n);
    if (i < 0) throw new Error(`PR #${n} is not a first-parent merge on ${ref}`);
    return i;
  };
  const from = fromPr === undefined ? 0 : at(fromPr);
  const to = toPr === undefined ? all.length - 1 : at(toPr);
  if (from > to) throw new Error(`PR #${fromPr} merged after PR #${toPr}: the range is empty`);
  return all.slice(from, to + 1);
}

function byDate(prs, since, until) {
  const lo = since === undefined ? -Infinity : Date.parse(since);
  const hi = until === undefined ? Infinity : Date.parse(until);
  return prs.filter((p) => Date.parse(p.mergedAt) >= lo && Date.parse(p.mergedAt) <= hi);
}

const FIX_RE = /^(?:(?:fix|revert|hotfix)(?:\([^)]*\))?!?:|Revert ")/i;
/** True for a conventional fix, revert or hotfix subject, and for a subject that starts `Revert "`. */
export const isFixSubject = (subject) => FIX_RE.test(String(subject ?? ''));

// ---------- removed lines ----------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

const ESCAPES = { '"': 0x22, '\\': 0x5c, t: 0x09, n: 0x0a, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b };

/** Decodes a git C-quoted name: the text between the quotes, with \" \\ \t \n and octal \ooo (bytes, read as UTF-8). */
function unquoteC(quoted) {
  const body = quoted.slice(1, quoted.lastIndexOf('"'));
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (body[i] !== '\\') bytes.push(...Buffer.from(body[i]));
    else if (oct) { bytes.push(parseInt(oct[0], 8)); i += oct[0].length; }
    else { bytes.push(ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The old path of a `--- a/x` header (plain, tab-suffixed or C-quoted), or null for /dev/null. */
function oldPathOf(header) {
  const raw = header.slice(4);
  const p = raw.startsWith('"') ? unquoteC(raw) : raw.replace(/\t.*$/, '');
  return p === '/dev/null' ? null : p.replace(/^a\//, '');
}

/**
 * From `git diff --unified=0` text: [{ path, ranges: [[from, to]] }], the OLD-side lines that a hunk removed or changed.
 * A pure addition (count 0) gives none. The hunk body is read by its line counts, so a removed line "-- a/x" is no header.
 */
export function removedRanges(diffText) {
  const byPath = new Map();
  const rows = String(diffText).split(/\r?\n/);
  let file = null;
  let left = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i];
    if (left > 0) { if (!line.startsWith('\\')) left -= 1; continue; }
    if (line.startsWith('--- ') && rows[i + 1]?.startsWith('+++ ')) { file = oldPathOf(line); continue; }
    const m = HUNK_RE.exec(line);
    if (!m || !file) continue;
    const [start, del, add] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
    left = del + add;
    if (del > 0) byPath.set(file, [...(byPath.get(file) ?? []), [start, start + del - 1]]);
  }
  return [...byPath].map(([p, ranges]) => ({ path: p, ranges }));
}

// ---------- bands ----------

/** Changed files of a merge commit from local git, or null when git cannot say. */
function filesOfMerge(git, mergeSha) {
  if (!mergeSha) return null;
  const r = git(['diff', '--name-only', `${mergeSha}^1`, mergeSha]);
  return r.status === 0 ? lines(r.stdout) : null;
}

const bandOfFiles = (files, config) => (files && config ? bandOf(files, config)?.band ?? 'UNKNOWN' : 'UNKNOWN');

/** Each merged PR with the risk band of its own files. */
export function withBands(prs, git, config) {
  return prs.map((p) => ({ ...p, band: bandOfFiles(filesOfMerge(git, p.mergeSha), config) }));
}

// ---------- one PR ----------

/** The PRs gh knows for a commit sha. null when the call fails. Both outcomes are cached for the run: a failed sha is not retried. */
async function prsOf(sha, { gh, repo, cache }) {
  if (cache.has(sha)) return cache.get(sha);
  let list = null;
  try {
    const found = await gh(['api', `repos/${repo}/commits/${sha}/pulls`]);
    list = Array.isArray(found) ? found : [];
  } catch { list = null; }
  cache.set(sha, list);
  return list;
}

const mergedMs = (p) => Date.parse(p.merged_at);

/** True when p merged before the fix PR and within the window. */
function inWindow(p, fixPr, windowDays) {
  const t = mergedMs(p);
  const at = Date.parse(fixPr.mergedAt);
  return p.number !== fixPr.pr && Number.isFinite(t) && t <= at && at - t <= windowDays * DAY;
}

/** Of the PRs one commit belongs to (a stacked chain lists several), the earliest merged: it brought the commit to the ref. Tie: lower number. */
const earliest = (prs) => prs.reduce((a, b) => (!a || mergedMs(b) < mergedMs(a) || (mergedMs(b) === mergedMs(a) && b.number < a.number) ? b : a), null);

/**
 * The primary blamed PR of one fix PR: the most recently merged. Tie: the higher PR number.
 * This is a rule of thumb (right in 4 of 4 doc cases), not a proven cause.
 */
export function pickPrimary(prs) {
  return prs.reduce((a, b) => (!a || mergedMs(b) > mergedMs(a) || (mergedMs(b) === mergedMs(a) && b.number > a.number) ? b : a), null);
}

/** The blamed commit shas of one old-side range, or null when git blame fails. -w skips whitespace-only changes (a standard SZZ filter). */
function blameShas(git, parent, file, [from, to]) {
  const r = git(['blame', '-w', '--porcelain', '-L', `${from},${to}`, parent, '--', file]);
  return r.status === 0 ? [...r.stdout.matchAll(/^([0-9a-f]{40,64}) \d+ \d+/gm)].map((m) => m[1]) : null;
}

/** Blames the removed lines of one fix commit. Updates stats; returns the foreign shas (not in the PR itself). */
function blameCommit(c, ctx, stats) {
  const diff = ctx.git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', `${c.sha}^`, c.sha]);
  if (diff.status !== 0) { stats.diffFailed += 1; return []; }
  stats.diffOk += 1;
  const found = new Set();
  for (const { path: file, ranges } of removedRanges(diff.stdout)) {
    stats.removed = true;
    blameRanges(ctx, `${c.sha}^`, file, ranges, stats).forEach((s) => found.add(s));
  }
  return [...found];
}

/** Blames each old-side range of one file at the parent commit. Returns the foreign shas. */
function blameRanges(ctx, parent, file, ranges, stats) {
  const foreign = [];
  for (const range of ranges) {
    stats.blameTried += 1;
    const shas = blameShas(ctx.git, parent, file, range);
    if (!shas) continue;
    stats.blameOk += 1;
    foreign.push(...shas.filter((s) => !ctx.own.has(s)));
  }
  return foreign;
}

/** Maps foreign shas to the PRs in the window. hits: blamedPr number -> { p, fixSha (first fix commit), fixFiles (of every fix commit that blamed it) }. */
async function collectHits(c, shas, ctx, stats, hits) {
  let files = null;
  for (const sha of shas) {
    stats.foreign.add(sha);
    const prs = await prsOf(sha, ctx);
    if (prs === null) { stats.ghFailed.add(sha); continue; }
    // The earliest main merge first, then the window: a commit under two main merges belongs to the older one.
    const p = earliest(prs.filter((x) => x.number !== ctx.prInfo.pr && ctx.mergeShas.has(x.merge_commit_sha)));
    if (!p || !inWindow(p, ctx.prInfo, ctx.windowDays)) continue;
    const h = hits.get(p.number) ?? { p, fixSha: c.sha, fixFiles: new Set() };
    hits.set(p.number, h);
    files ??= filesOf(ctx.git, c.sha);
    files.forEach((f) => h.fixFiles.add(f));
  }
}

const filesOf = (git, sha) => { const r = git(['diff', '--name-only', `${sha}^`, sha]); return r.status === 0 ? lines(r.stdout) : []; };

/** The reason of a run with no failure. In-PR-only is not a no-target. */
function quietReason(stats) {
  if (!stats.removed) return { noTarget: 'no-removed-lines' };
  if (stats.foreign.size === 0) return { noTarget: null, inPrOnly: true };
  return { noTarget: 'outside-window' };
}

/**
 * Why a fix PR has no row. A failure never reads as a quiet outcome: when every diff, every blame or every gh call failed,
 * the reason names that step; when only some failed, it is partial-failure.
 */
function reasonOf(stats) {
  const failed = stats.diffFailed > 0 || stats.blameOk < stats.blameTried || stats.ghFailed.size > 0;
  if (!failed) return quietReason(stats);
  if (stats.diffOk === 0) return { noTarget: 'diff-failed' };
  if (stats.blameTried > 0 && stats.blameOk === 0) return { noTarget: 'blame-failed' };
  if (stats.foreign.size > 0 && stats.ghFailed.size === stats.foreign.size) return { noTarget: 'gh-failed' };
  return { noTarget: 'partial-failure' };
}

/** The steps that failed in this run: 'diff', 'blame', 'gh'. Empty when every call worked. */
function failuresOf(stats) {
  return [stats.diffFailed > 0 && 'diff', stats.blameOk < stats.blameTried && 'blame', stats.ghFailed.size > 0 && 'gh'].filter(Boolean);
}

function rowOf(h, ctx) {
  const { p, fixSha, fixFiles } = h;
  const files = filesOfMerge(ctx.git, p.merge_commit_sha);
  const cause = classifyCause({ fixFiles: [...fixFiles], blamedFiles: files ?? [], gatesFor: ctx.gatesFor });
  return { mergeSha: ctx.prInfo.mergeSha, pr: ctx.prInfo.pr, band: bandOfFiles(files, ctx.config), blamedPr: p.number, blamedMergeSha: p.merge_commit_sha, fixSha, fixMergedAt: ctx.prInfo.mergedAt, cause };
}

async function walkPr(prInfo, opts) {
  const { git } = opts;
  const range = `${prInfo.base}..${prInfo.head}`;
  const log = git(['log', '--no-merges', '--reverse', `--format=%H%x1f%s`, range]);
  const own = git(['rev-list', range]);
  if (log.status !== 0 || own.status !== 0) throw new Error('git log failed');
  const fixes = lines(log.stdout).map((l) => l.split(FIELD)).filter(([, subject]) => isFixSubject(subject)).map(([sha]) => ({ sha }));
  if (fixes.length === 0) return { rows: [], noTarget: null, fix: false };
  const ctx = { ...opts, prInfo, own: new Set(lines(own.stdout)) };
  const stats = { removed: false, diffOk: 0, diffFailed: 0, blameTried: 0, blameOk: 0, foreign: new Set(), ghFailed: new Set() };
  const hits = new Map();
  for (const c of fixes) await collectHits(c, blameCommit(c, ctx, stats), ctx, stats, hits);
  const primary = pickPrimary([...hits.values()].map((h) => h.p))?.number;
  const rows = [...hits.values()].map((h) => ({ ...rowOf(h, ctx), primary: h.p.number === primary }));
  const failures = failuresOf(stats);
  const flag = failures.length > 0 ? { failed: true, failures } : {};
  return rows.length ? { rows, noTarget: null, fix: true, ...flag } : { rows: [], fix: true, ...reasonOf(stats), ...flag };
}

/**
 * The escape rows of one merged PR. prInfo: an item of listMergedPrs. Never throws.
 * Returns { rows, noTarget, fix } (and inPrOnly: true when every fix only changed the PR's own new lines).
 * failed: true, with failures (a list of 'diff', 'blame', 'gh'), is set when any call failed, also when rows exist: the rows may
 * miss a blamed PR, so the primary flag may sit on the wrong one. A caller must not store the rows of a failed result.
 * A PR that git cannot read at all gives { rows: [], noTarget: 'git-failed', fix: null }: it is not known to be a fix PR.
 * Each row has `primary`: true for the most recently merged blamed PR of the fix PR (tie: the higher PR number), false for the
 * others. That is a rule of thumb (right in 4 of 4 doc cases), not a proven cause.
 * opts: git, gh, repo, windowDays, prOfSha (a cache Map), routerConfig, gatesFor, ref (default main), mergeShas (the first-parent
 * merge shas of ref: a blamed PR must have one of them as its merge commit; default: read from git).
 */
export async function escapesForPr(prInfo, { git, gh, repo = DEFAULT_REPO, windowDays = 30, prOfSha = new Map(), routerConfig, gatesFor, ref = 'main', mergeShas } = {}) {
  const config = routerConfig === undefined ? loadRouterConfig() : routerConfig;
  try {
    const shas = mergeShas ?? new Set(readMerges({ git, ref }).merges.map((m) => m.mergeSha));
    return await walkPr(prInfo, { git, gh, repo, windowDays, cache: prOfSha, config, gatesFor, mergeShas: shas });
  } catch { return { rows: [], noTarget: 'git-failed', fix: null }; }
}

// ---------- the state files (this module is the only writer) ----------

const keyOf = (r) => `${r.mergeSha}:${r.blamedPr}`;

/** The mergeSha of one raw line of escapes.jsonl, or null for a line that is not a row (kept as it is). */
function mergeShaOfLine(line) {
  try { const row = JSON.parse(line); return row && typeof row === 'object' ? row.mergeSha ?? null : null; } catch { return null; }
}

/**
 * Stores the rows of the fix PRs in `rows`. The rows of a fix PR (one mergeSha) REPLACE every row the file has for that mergeSha:
 * a re-run that finds another primary must not leave the old one beside it. `processed` lists the mergeShas that this run read
 * to the end (no failed step): the old rows of each are cleared even when the run found no row for it. A PR that failed, or
 * is not in the run, is not in `processed`: its old rows stay. Rows of other mergeShas, and lines that are not
 * rows, stay byte for byte and in order; the new rows go at the end. The file is written to a temp file and renamed.
 * Returns { added, skipped, updated, removed }: new keys, rows equal to the old ones, same key with other content, old rows dropped.
 */
export function writeRows(stateDir, rows, processed = []) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, ESCAPES_FILE);
  const old = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '') : [];
  const mine = new Set([...rows.map((r) => r.mergeSha), ...processed]);
  const oldByKey = new Map(old.filter((l) => mine.has(mergeShaOfLine(l))).map((l) => [keyOf(JSON.parse(l)), l]));
  const fresh = new Map(rows.map((r) => [keyOf(r), JSON.stringify(r)]));
  const stats = tally(oldByKey, fresh, rows.length);
  const next = [...old.filter((l) => !mine.has(mergeShaOfLine(l))), ...fresh.values()];
  if (next.join('\n') !== old.join('\n')) atomicWrite(file, `${next.join('\n')}\n`);
  return stats;
}

function tally(oldByKey, fresh, rowCount) {
  let added = 0;
  let skipped = rowCount - fresh.size; // a duplicate inside one call
  let updated = 0;
  for (const [key, line] of fresh) {
    if (!oldByKey.has(key)) added += 1;
    else if (oldByKey.get(key) === line) skipped += 1;
    else updated += 1;
  }
  return { added, skipped, updated, removed: [...oldByKey.keys()].filter((k) => !fresh.has(k)).length };
}

/** Writes text to a temp file next to the target and renames it over the target: a reader never sees half a file. */
function atomicWrite(file, text) {
  const tmpFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tmpFile, text);
  renameSync(tmpFile, file);
}

/** True when the row blames this window PR: by merge sha, or by PR number. */
const blames = (r, p) => (r.blamedMergeSha !== undefined && r.blamedMergeSha === p.mergeSha) || r.blamedPr === p.pr;

/**
 * One row per risk band seen in the window PRs (mergedPrs: { pr, mergeSha, band }), in the band of the window PR:
 *   prsMerged   window PRs of the band.
 *   escapes     window PRs with at least one PRIMARY escape row (a distinct PR counts once), so escapes <= prsMerged always.
 *               It is a rule of thumb (the latest merged blamed PR; right in 4 of 4 doc cases), not a proven cause.
 *   escapeRows  primary rows blamed to window PRs of the band.
 *   allRows     all rows (primary or not) blamed to window PRs of the band: the noise stays visible.
 * A row with no `primary` field (an old file) counts as primary.
 * A row whose blamed PR is not a window PR is in no baseline row: rowsLeftOut counts them. Rows come from fix-chains only.
 */
export function buildBaseline(rows, mergedPrs, window) {
  const seen = [...new Set(mergedPrs.map((p) => p.band))];
  const ordered = [...BAND_ORDER.filter((b) => seen.includes(b)), ...seen.filter((b) => !BAND_ORDER.includes(b))];
  return ordered.map((band) => {
    const prs = mergedPrs.filter((p) => p.band === band);
    const hit = prs.map((p) => rows.filter((r) => blames(r, p) && r.primary !== false).length);
    const allRows = prs.reduce((n, p) => n + rows.filter((r) => blames(r, p)).length, 0);
    return { band, prsMerged: prs.length, escapes: hit.filter((n) => n > 0).length, escapeRows: hit.reduce((a, b) => a + b, 0), allRows, window };
  });
}

/** Rows whose blamed PR is not one of the window PRs. */
export const rowsLeftOut = (rows, mergedPrs) => rows.filter((r) => !mergedPrs.some((p) => blames(r, p))).length;

/** The PRs of the baseline window: from the first listed PR up to and including the PR whose merge sha is toSha. No sha: all. */
export function windowPrs(prs, toSha) {
  if (toSha === undefined) return prs;
  const i = prs.findIndex((p) => p.mergeSha === toSha);
  if (i < 0) throw new Error(`--window-to-sha ${toSha} is not a first-parent merge in the listed range`);
  return prs.slice(0, i + 1);
}

export function writeBaseline(stateDir, baseline) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
}

// ---------- command line ----------

const USAGE = 'usage: node scripts/eval/review-eval/fix-chains.mjs (--range <fromPr>..<toPr> | --since <iso> [--until <iso>]) [--write] [--baseline [--window-to-sha <sha>]] [--state-dir <dir>] [--json <file>] [--repo owner/name] [--ref <ref>]\n  Without --write it is a dry run: it prints and writes no state file.\n  --baseline: the window is the PRs of the range up to and including the merge --window-to-sha (default: the whole range). Fix PRs are mined over the whole range. --write with --baseline needs --window-to-sha.\n  --ref: the branch to walk (default main).';
const VALUE_FLAGS = { '--range': 'range', '--since': 'since', '--until': 'until', '--window-to-sha': 'windowToSha', '--state-dir': 'stateDir', '--json': 'json', '--repo': 'repo', '--ref': 'ref' };
const BOOL_FLAGS = { '--write': 'write', '--baseline': 'baseline', '--help': 'help', '-h': 'help' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) out[BOOL_FLAGS[a]] = true;
    else if (VALUE_FLAGS[a] && argv[i + 1] && !argv[i + 1].startsWith('--')) { out[VALUE_FLAGS[a]] = argv[i + 1]; i += 1; }
    else return { error: VALUE_FLAGS[a] ? `${a} needs a value` : `unknown argument ${JSON.stringify(a)}` };
  }
  return out.help ? out : checkArgs(out);
}

function checkArgs(out) {
  if (out.ref?.startsWith('-')) return { error: `--ref ${JSON.stringify(out.ref)} is not a usable git ref` };
  if (out.write && out.baseline && out.windowToSha === undefined) return { error: '--write with --baseline needs --window-to-sha: a written baseline must name its window' };
  if (out.range !== undefined) {
    const m = /^(\d+)\.\.(\d+)$/.exec(out.range);
    if (!m) return { error: `--range ${JSON.stringify(out.range)} is not <fromPr>..<toPr>` };
    if (out.since !== undefined || out.until !== undefined) return { error: 'use --range or --since, not both' };
    return { ...out, fromPr: Number(m[1]), toPr: Number(m[2]) };
  }
  if (out.since === undefined) return { error: 'pass --range <fromPr>..<toPr> or --since <iso>' };
  for (const k of ['since', 'until']) if (out[k] !== undefined && !Number.isFinite(Date.parse(out[k]))) return { error: `--${k} ${JSON.stringify(out[k])} is not a date` };
  return out;
}

/** The no-target reasons of the results. 'git-failed' is a PR that was not read at all: it has its own count. */
const countReasons = (results) => results.reduce((acc, r) => (r.noTarget && r.noTarget !== 'git-failed' ? { ...acc, [r.noTarget]: (acc[r.noTarget] ?? 0) + 1 } : acc), {});

function totalsOf(results, rows) {
  const byReason = countReasons(results);
  return {
    mergedPrs: results.length,
    fixPrs: results.filter((r) => r.fix === true).length,
    gitFailures: results.filter((r) => r.noTarget === 'git-failed').length,
    escapeRows: rows.length,
    noTarget: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason, inPrOnly: results.filter((r) => r.inPrOnly).length },
  };
}

/**
 * A fix PR whose run had a failure is not stored: its rows may miss a blamed PR, so the primary flag may be wrong. The PR is
 * counted as partial-failure (its own noTarget) and the rows are dropped from the run; droppedRows says how many.
 */
function settle(result) {
  if (!result.failed || result.rows.length === 0) return result;
  return { ...result, rows: [], droppedRows: result.rows.length, noTarget: 'partial-failure' };
}

const droppedNote = (r) => (r.droppedRows ? `, ${r.droppedRows} row(s) not stored; failed steps: ${r.failures.join(', ')}` : '');
const prLine = (r) => r.noTarget === 'git-failed' ? `PR #${r.pr}: git could not read it` : `PR #${r.pr}: ${r.rows.length ? `${r.rows.length} escape row(s) (blamed ${r.rows.map((x) => `#${x.blamedPr}`).join(', ')})` : r.inPrOnly ? 'fix of its own lines only' : `no blame target (${r.noTarget}${droppedNote(r)})`}`;

function totalsLines(t) {
  const detail = Object.entries(t.noTarget.byReason).map(([k, n]) => `${k} ${n}`).join(', ');
  return [`merged PRs: ${t.mergedPrs}`, `fix PRs: ${t.fixPrs}`, `git failures: ${t.gitFailures}`, `escape rows: ${t.escapeRows}`, `no blame target: ${t.noTarget.total}${detail ? ` (${detail})` : ''}`, `fix commits inside their own PR only (not counted as no-target): ${t.noTarget.inPrOnly}`];
}

async function mineAll(prs, deps) {
  const cache = new Map();
  const results = [];
  for (const pr of prs) results.push(settle({ pr: pr.pr, mergeSha: pr.mergeSha, ...(await escapesForPr(pr, { ...deps, prOfSha: cache })) }));
  return results;
}

/** The baseline of the window PRs (a part of the range, or all of it). Returns { baseline, leftOut }. */
function baselineOf(win, rows, deps) {
  const banded = withBands(win, deps.git, deps.routerConfig);
  const last = win.at(-1);
  const window = { from: win[0]?.mergedAt ?? null, to: last?.mergedAt ?? null, toSha: last?.mergeSha ?? null };
  return { baseline: buildBaseline(rows, banded, window), leftOut: rowsLeftOut(rows, banded) };
}

/** True for a result whose PR was read to the end: git worked and no diff, blame or gh call failed. */
const readToTheEnd = (r) => r.noTarget !== 'git-failed' && !r.failed;

function emitFiles(args, run, stdout, dir) {
  if (args.json) {
    mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    writeFileSync(args.json, `${JSON.stringify(run, null, 2)}\n`);
  }
  if (!args.write) return;
  const w = writeRows(dir, run.rows, run.perPr.filter(readToTheEnd).map((r) => r.mergeSha));
  stdout(`rows written: ${w.added} added, ${w.skipped} skipped (${path.join(dir, ESCAPES_FILE)})`);
  if (run.baseline) { writeBaseline(dir, run.baseline); stdout(`baseline written: ${path.join(dir, BASELINE_FILE)}`); }
}

/** True when file resolves to the folder dir or to a path below it. A folder that only shares the name prefix is outside. */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Walks the PRs of the range. Returns { rows, perPr, totals, baseline?, baselineRowsLeftOut? }. */
async function mine(args, deps) {
  const git = deps.git ?? makeGit(process.cwd());
  const routerConfig = deps.routerConfig === undefined ? loadRouterConfig() : deps.routerConfig;
  const ref = args.ref ?? 'main';
  const history = readMerges({ git, ref });
  const prs = pickRange(history.merges, { ref, fromPr: args.fromPr, toPr: args.toPr, since: args.since, until: args.until });
  const win = args.baseline ? windowPrs(prs, args.windowToSha) : null;
  const mergeShas = new Set(history.merges.map((m) => m.mergeSha));
  const results = await mineAll(prs, { git, gh: deps.gh ?? makeGh(), repo: args.repo ?? DEFAULT_REPO, routerConfig, ref, mergeShas });
  const rows = results.flatMap((r) => r.rows);
  const run = { head: history.head, ref, rows, perPr: results, totals: totalsOf(results, rows) };
  if (!args.baseline) return run;
  const { baseline, leftOut } = baselineOf(win, rows, { git, routerConfig });
  return { ...run, baseline, baselineRowsLeftOut: leftOut };
}

function printRun(run, stdout) {
  stdout(`head: ${run.head} (${run.ref})`);
  run.perPr.filter((r) => r.fix || r.noTarget === 'git-failed').forEach((r) => stdout(prLine(r)));
  totalsLines(run.totals).forEach((l) => stdout(l));
  if (!run.baseline) return;
  const bands = run.baseline.map((b) => `${b.band} ${b.escapes}/${b.prsMerged} (${b.escapeRows} primary row(s), ${b.allRows} all)`);
  stdout(`baseline (primary rows: a rule of thumb, not a proven cause): ${bands.join(', ')}; rows left out (blamed PR not in the window): ${run.baselineRowsLeftOut}`);
}

/** Returns the exit code. deps (tests): git, gh, routerConfig, stdout, stderr, env. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = argv.length === 0 ? { help: true } : parseArgs(argv);
  if (args.help) { stdout(USAGE); return 0; }
  if (args.error) { stderr(`fix-chains: ${args.error}\n${USAGE}`); return 2; }
  const dir = stateDirOf(args.stateDir, deps.env ?? process.env);
  if (args.json && isInside(dir, args.json)) { stderr(`fix-chains: --json ${args.json} is inside the state dir ${dir}: it could overwrite a state file`); return 2; }
  try {
    const run = await mine(args, deps);
    printRun(run, stdout);
    emitFiles(args, run, stdout, dir);
    return 0;
  } catch (err) {
    stderr(`fix-chains: ${String(err?.message ?? err).split('\n')[0]}`);
    return 2;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
