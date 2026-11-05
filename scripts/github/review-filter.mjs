#!/usr/bin/env node
/**
 * review-filter.mjs: the S5 filter of the local review engine (.claudedocs/2026-11-02-review-engine-p1-engine-core-spec.md, section 3).
 *
 * Usage: node scripts/github/review-filter.mjs --findings <json> --tree <dir> [--diff <file>] [--prior <json>] [--json]
 *
 * Takes the findings the agent wrote and checks each one against the review tree. The rules run in this order:
 *   1. no-file        the path is absolute, holds "..", is excluded, is an engine file, or is absent from the tree. A stripped file
 *                     (agent file or ignore file) is absent from the tree on purpose: it counts as present when PR.diff has hunks for it.
 *   2. no-line        startLine is below 1 or past EOF. endLine is clamped, never dropped. For a stripped file EOF is the last new-side
 *                     line of its hunks.
 *   3. inDiff         recomputed from the hunks of PR.diff. Off the diff: outside_diff, or nitpick for a style finding.
 *   4. claim-refuted  "`X` does not exist" and its kin. A grep hit that DEFINES or IMPORTS X (not a use, not a comment line), or an
 *                     existing path X, drops the finding. The tree is the PR author's, so a mere mention must not refute a claim.
 *                     A grep error keeps the finding and adds a problem. A NEVER_SUPPRESS finding is never dropped by this rule:
 *                     the evidence goes to problems.
 *   5. duplicate      same file, start lines within 3, same category or same title. The higher severity stays.
 *   6. thread         confidence >= threadMin. A NEVER_SUPPRESS finding always gets thread:true. This is not a drop.
 * Every drop is kept in `dropped` as { finding, reason, evidence }, for the false-drop gate.
 *
 * Output: one line "DROP <reason> <id>" per drop (or the full result with --json). Exit 0 ran, 2 bad input.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentFile, isExcluded } from './cursor-review.mjs';

const DEFAULT_LOGIC_EXT = ['ts', 'tsx', 'mjs', 'js', 'cjs', 'ps1', 'py', 'bat', 'sh'];
export const SEVERITY_RANK = { critical: 5, major: 4, minor: 3, trivial: 2, info: 1, unknown: 0 };
const STYLE_SEVERITY = new Set(['minor', 'trivial', 'info']);
const DUPLICATE_LINES = 3;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const CLAIM_RE = /`([^`\n]{1,200})`\s+(?:does not exist|is not defined|is undefined|no such (?:file|function))/gi;
// Files the engine writes into the tree. A finding on one is not a finding on the PR.
const ENGINE_FILE_RE = /^(?:\.review\/|(?:PR|DELTA)\.diff$)/;

/** Findings in these classes always get thread:true. Rules 1 and 2 still drop them; rule 4 does not. The pattern has no g flag, so test() keeps no state. */
export const NEVER_SUPPRESS = Object.freeze({
  categories: Object.freeze(['security']),
  titlePattern: /secret|injection|null deref|infinite loop|leak|validation/i,
});

export function isNeverSuppress(f) {
  return NEVER_SUPPRESS.categories.includes(f?.category) || NEVER_SUPPRESS.titlePattern.test(String(f?.title ?? ''));
}

/** Lower-case title with every run of non-alphanumerics folded to one space. */
export function normTitle(title) {
  return String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** sha1(file|startLine|normTitle), first 16 hex digits. */
export function findingId(f) {
  return createHash('sha1').update(`${f.file}|${f.startLine}|${normTitle(f.title)}`).digest('hex').slice(0, 16);
}

// ---- stripped files -----------------------------------------------------------------------------------------------------------

/**
 * Files the engine removes from the review tree besides AGENT_FILES. cursor-agent reads .gitignore, .cursorignore and .cursorindexingignore
 * and hides what they list, so a PR could hide PR.diff and .review/ from its own review. Matched by name at any depth.
 */
export const IGNORE_FILES = Object.freeze(['.cursorignore', '.cursorindexingignore', '.gitignore']);

const foldName = (x, platform) => (platform === 'win32' ? x.toLowerCase() : x);

export function isIgnoreFile(rel, platform = process.platform) {
  const base = String(rel).replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '';
  return IGNORE_FILES.some((n) => foldName(n, platform) === foldName(base, platform));
}

/** An agent file or an ignore file: the engine leaves it out of the tree and the model reads its diff from PR.diff. */
export const isStrippedFile = (rel, platform = process.platform) => isAgentFile(rel, platform) || isIgnoreFile(rel, platform);

/** Removes every ignore file under dir, at every depth. A symlink is removed by name and never followed. Returns the git-style paths removed. */
export function stripIgnoreFiles(dir, platform = process.platform) {
  const removed = [];
  const walk = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (isIgnoreFile(ent.name, platform) && !ent.isDirectory()) {
        rmSync(path.join(abs, ent.name), { force: true });
        removed.push(childRel);
      } else if (ent.isDirectory()) walk(path.join(abs, ent.name), childRel);
    }
  };
  walk(dir, '');
  return removed;
}

// ---- diff parsing -------------------------------------------------------------------------------------------------------------

/** Decodes a git-quoted path ("a/caf\303\251.mjs"): octal escapes are UTF-8 bytes. */
function unquote(p) {
  if (!p.startsWith('"')) return p;
  const s = p.slice(1, p.lastIndexOf('"'));
  const named = { t: '\t', n: '\n', '"': '"', '\\': '\\' };
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const oct = s[i] === '\\' ? /^[0-7]{3}/.exec(s.slice(i + 1)) : null;
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; } else if (s[i] === '\\') { bytes.push(...Buffer.from(named[s[i + 1]] ?? s[i + 1], 'utf8')); i += 1; } else bytes.push(...Buffer.from(s[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a "--- a/x" or "+++ b/x" header line; null for /dev/null. */
function headerPath(line) {
  const raw = line.slice(4).replace(/\t.*$/, '').trim();
  if (raw === '/dev/null') return null;
  return unquote(raw).replace(/^[ab]\//, '');
}

function startFile(s, line) {
  const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
  s.cur = { oldFile: m ? unquote(m[1]) : null, file: m ? unquote(m[2]) : null, hunks: [] };
  s.entries.push(s.cur);
  s.hunk = null;
}

function openHunk(s, m) {
  const num = (v) => (v === undefined ? 1 : Number(v));
  s.hunk = { oldStart: Number(m[1]), oldLines: num(m[2]), newStart: Number(m[3]), newLines: num(m[4]), lines: [] };
  s.o = s.hunk.oldStart;
  s.n = s.hunk.newStart;
  s.ro = s.hunk.oldLines;
  s.rn = s.hunk.newLines;
  s.cur.hunks.push(s.hunk);
}

function hunkLine(s, line) {
  const c = line[0];
  if (c === '\\') return;
  if (c === '+') { s.hunk.lines.push({ t: '+', new: s.n }); s.n += 1; s.rn -= 1; } else if (c === '-') { s.hunk.lines.push({ t: '-', old: s.o }); s.o += 1; s.ro -= 1; } else {
    s.hunk.lines.push({ t: ' ', old: s.o, new: s.n });
    s.o += 1; s.n += 1; s.ro -= 1; s.rn -= 1;
  }
}

function headerLine(s, line) {
  if (line.startsWith('--- ')) s.cur.oldFile = headerPath(line);
  else if (line.startsWith('+++ ')) s.cur.file = headerPath(line);
  else if (line.startsWith('rename from ')) s.cur.oldFile = unquote(line.slice(12));
  else if (line.startsWith('rename to ')) s.cur.file = unquote(line.slice(10));
  else {
    const m = HUNK_RE.exec(line);
    if (m) openHunk(s, m);
  }
}

/**
 * Parses a unified diff into Map<newPath, { file, oldFile, hunks:[{ oldStart, oldLines, newStart, newLines, lines:[{ t, old?, new? }] }] }>.
 * A deleted file is keyed by its old path. Lines may end in \r\n (core.autocrlf=true). The hunk counts decide where a hunk ends, so a
 * deleted line that reads "-- x" (shown as "--- x") is never taken for a file header.
 */
export function parseHunks(diffText) {
  const s = { entries: [], cur: null, hunk: null, o: 0, n: 0, ro: 0, rn: 0 };
  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    if (s.hunk && (s.ro > 0 || s.rn > 0)) hunkLine(s, line);
    else if (line.startsWith('diff --git ')) startFile(s, line);
    else if (s.cur) headerLine(s, line);
  }
  return new Map(s.entries.map((e) => [e.file ?? e.oldFile, e]));
}

function entryFor(hunks, file) {
  return hunks.get(file) ?? [...hunks.values()].find((e) => e.oldFile === file);
}

/**
 * Maps an old-side line number to the new side. { line, touched:false } for an untouched or context line (line is the new number);
 * { line:null, touched:true } for a line the diff removed or changed.
 */
export function mapLine(hunks, file, line) {
  const entry = hunks ? entryFor(hunks, file) : undefined;
  if (!entry) return { line, touched: false };
  let offset = 0;
  for (const h of entry.hunks) {
    const first = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    if (line < first) break;
    if (line >= first + h.oldLines) { offset += h.newLines - h.oldLines; continue; }
    const hit = h.lines.find((l) => l.old === line);
    return hit?.t === ' ' ? { line: hit.new, touched: false } : { line: null, touched: true };
  }
  return { line: line + offset, touched: false };
}

/**
 * True when the diff changed any line of file in [start, end] on the old side: a removed line in the range, or an insert strictly inside it
 * (before an old line p with start < p <= end). A same-length replacement is a removal plus an insert, so it counts. Context lines do not.
 */
export function rangeTouched(hunks, file, start, end) {
  const entry = hunks ? entryFor(hunks, file) : undefined;
  for (const h of entry?.hunks ?? []) {
    let next = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    for (const l of h.lines) {
      if (l.t === '+' && next > start && next <= end) return true;
      if (l.t === '-' && l.old >= start && l.old <= end) return true;
      if (l.t !== '+') next = l.old + 1;
    }
  }
  return false;
}

/** The last new-side line any hunk of file shows; 0 when the diff has no new-side lines for it. */
function newSideEof(hunks, file) {
  return Math.max(0, ...(entryFor(hunks, file)?.hunks ?? []).filter((h) => h.newLines > 0).map((h) => h.newStart + h.newLines - 1));
}

function inHunks(hunks, file, start, end) {
  const entry = entryFor(hunks, file);
  return (entry?.hunks ?? []).some((h) => h.newLines > 0 && start <= h.newStart + h.newLines - 1 && end >= h.newStart);
}

// ---- claims -------------------------------------------------------------------------------------------------------------------

/** The names X in "`X` does not exist" style claims, once each. A trailing "()" is dropped; a name with a space is not a name. */
export function absenceClaims(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(CLAIM_RE)) {
    const x = m[1].trim().replace(/\(\)$/, '');
    if (x && !/\s/.test(x)) out.add(x);
  }
  return [...out];
}

function logicExt() {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../../review-router.config.json', import.meta.url), 'utf8'));
    const list = cfg?.matrix?.logic_ext;
    return Array.isArray(list) && list.length > 0 ? list : DEFAULT_LOGIC_EXT;
  } catch { return DEFAULT_LOGIC_EXT; }
}

/** Default grep: `git grep --no-index -F -w -n` in the tree (it has no .git). Returns "path:line:text" lines. Throws on any git error. */
export function defaultGrep(x, { treeDir, exts }) {
  const globs = exts.map((e) => `*.${e}`);
  const r = spawnSync('git', ['grep', '--no-index', '-I', '-F', '-w', '-n', '-e', x, '--', ...globs], { cwd: treeDir, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep exited ${r.status}: ${(r.stderr ?? '').trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

// ---- rules --------------------------------------------------------------------------------------------------------------------

const bad = (reason, evidence) => ({ reason, evidence });
const isAbsolutePath = (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p);

/** The real path of a regular file inside the tree, else null. A symlink out of the tree is null. */
function fileInTree(treeDir, rel) {
  try {
    const root = realpathSync(treeDir);
    const real = realpathSync(path.join(root, rel));
    const inside = real === root || real.startsWith(root + path.sep);
    return inside && statSync(real).isFile() ? real : null;
  } catch { return null; }
}

function pathExists(treeDir, x) {
  if (isAbsolutePath(x) || x.split(/[\\/]/).includes('..')) return false;
  return existsSync(path.join(treeDir, x));
}

/** Rule 1. Returns { drop } or { abs }. */
function checkFile(f, treeDir, hunks) {
  const rel = f.file;
  if (typeof rel !== 'string' || rel === '') return { drop: bad('no-file', 'the finding names no file') };
  if (isAbsolutePath(rel)) return { drop: bad('no-file', `absolute path: ${rel}`) };
  if (rel.split('/').includes('..')) return { drop: bad('no-file', `path leaves the tree: ${rel}`) };
  if (isExcluded(rel) || ENGINE_FILE_RE.test(rel)) return { drop: bad('no-file', `excluded or engine path: ${rel}`) };
  const abs = fileInTree(treeDir, rel);
  if (abs) return { abs };
  // A stripped file is not in the tree on purpose; the model reviews it from PR.diff, so PR.diff must show it.
  if (isStrippedFile(rel) && hunks && entryFor(hunks, rel)) return { eof: newSideEof(hunks, rel) };
  return { drop: bad('no-file', `no such file in the review tree: ${rel}`) };
}

function countLines(text) {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Rule 2. Returns { drop } or { f } with endLine clamped to 1..EOF and not below startLine. */
function checkLine(f, file) {
  const eof = file.abs ? countLines(readFileSync(file.abs, 'utf8')) : file.eof;
  if (f.startLine === null || f.startLine < 1) return { drop: bad('no-line', `startLine ${f.startLine} is below 1`) };
  if (f.startLine > eof) return { drop: bad('no-line', `startLine ${f.startLine} is past EOF (${eof} lines)`) };
  const end = Math.min(Math.max(f.endLine ?? f.startLine, f.startLine), eof);
  return { f: { ...f, endLine: end } };
}

/** Rule 3. Without hunks the finding keeps its own inDiff and bucket. */
function placeFinding(f, hunks) {
  if (!hunks) return f;
  const inDiff = inHunks(hunks, f.file, f.startLine, f.endLine);
  return { ...f, inDiff, bucket: bucketFor(f, inDiff) };
}

// A style finding (maintainability, minor or lighter) is a nitpick on or off the diff. Else off the diff is outside_diff.
function bucketFor(f, inDiff) {
  if (f.category === 'maintainability' && STYLE_SEVERITY.has(f.severity)) return 'nitpick';
  if (inDiff) return f.bucket === 'outside_diff' ? 'actionable' : f.bucket;
  return f.bucket === 'nitpick' || f.bucket === 'follow_up' ? f.bucket : 'outside_diff';
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMENT_LINE = /^(?:\/\/|\/\*|\*|#(?!!)|<!--)/;

/** True when a grep line of text defines or imports x: a declaration keyword before x, an import, export or from line that names x, or a shell "x() {". A comment line never does. */
export function definesName(text, x) {
  const t = String(text).trim();
  if (COMMENT_LINE.test(t)) return false;
  const n = escapeRe(x);
  const decl = new RegExp(`\\b(?:function\\*?|class|def|const|let|var|interface|type|enum|namespace|fn|func)\\s+${n}(?![\\w$])`);
  const mod = new RegExp(`^(?:import|export|from)\\b.*(?<![\\w$])${n}(?![\\w$])`);
  const shell = new RegExp(`^${n}\\s*\\(\\)\\s*\\{`);
  return decl.test(t) || mod.test(t) || shell.test(t);
}

// The tree is the PR author's. A use, a call or a comment that names X must not refute the claim; only a definition or import elsewhere than the cited lines does.
function definingHit(hits, f, x) {
  const list = Array.isArray(hits) ? hits : [];
  return list.find((h) => {
    const m = /^(.*?):(\d+):(.*)$/s.exec(String(h));
    if (!m || (m[1] === f.file && Number(m[2]) >= f.startLine && Number(m[2]) <= f.endLine)) return false;
    return definesName(m[3], x);
  });
}

function claimEvidence(x, f, { treeDir, grep, exts }, problems) {
  if (pathExists(treeDir, x)) return `\`${x}\` exists as a path in the review tree`;
  try {
    const hit = definingHit(grep(x, { treeDir, exts }), f, x);
    return hit ? `\`${x}\` is defined or imported: ${hit}` : null;
  } catch (e) {
    problems.push(`grep failed for \`${x}\` (finding ${f.id}); the finding is kept: ${e.message}`);
    return null;
  }
}

/** Rule 4. Returns a drop or null. A grep error pushes a problem and keeps the finding. A NEVER_SUPPRESS finding is kept; the evidence goes to problems. */
function refuteClaims(f, ctx, problems) {
  for (const x of absenceClaims(`${f.title}\n${f.body}`)) {
    const evidence = claimEvidence(x, f, ctx, problems);
    if (!evidence) continue;
    if (!isNeverSuppress(f)) return bad('claim-refuted', evidence);
    problems.push(`finding ${f.id} is kept although its claim looks refuted (never-suppress class): ${evidence}`);
  }
  return null;
}

function isDuplicate(kept, cand) {
  if (kept.file !== cand.file || Math.abs(kept.startLine - cand.startLine) > DUPLICATE_LINES) return false;
  const sameKind = (kept.category != null && kept.category === cand.category) || normTitle(kept.title) === normTitle(cand.title);
  // A NEVER_SUPPRESS finding is only folded into another NEVER_SUPPRESS finding.
  return sameKind && (!isNeverSuppress(cand) || isNeverSuppress(kept));
}

const strength = (f) => [SEVERITY_RANK[f.severity] ?? 0, f.confidence ?? 3];

/** Rule 5. Walks the findings strongest first (severity, then confidence, then input order) and drops any that twin a kept one. */
export function dedupe(findings) {
  const order = findings.map((f, i) => ({ f, i })).sort((a, b) => {
    const [sa, ca] = strength(a.f);
    const [sb, cb] = strength(b.f);
    return sb - sa || cb - ca || a.i - b.i;
  });
  const keep = [];
  const dropped = [];
  for (const c of order) {
    const twin = keep.find((k) => isDuplicate(k.f, c.f));
    if (twin) dropped.push({ i: c.i, finding: c.f, reason: 'duplicate', evidence: `duplicate of ${twin.f.id} (${twin.f.file}:${twin.f.startLine}, ${twin.f.severity})` });
    else keep.push(c);
  }
  return {
    kept: keep.sort((a, b) => a.i - b.i).map((k) => k.f),
    dropped: dropped.sort((a, b) => a.i - b.i).map(({ i, ...d }) => d),
  };
}

const toInt = (v) => (v !== null && v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : null);

/** A repo path as findings carry it: forward slashes, no leading ./ . Non-strings pass through. */
export function normalizeRepoPath(p) {
  return typeof p === 'string' ? p.replaceAll('\\', '/').replace(/^\.\//, '') : p;
}

function normalize(r) {
  const o = r !== null && typeof r === 'object' && !Array.isArray(r) ? r : {};
  const conf = toInt(o.confidence);
  const f = {
    ...o,
    file: normalizeRepoPath(o.file),
    startLine: toInt(o.startLine),
    endLine: toInt(o.endLine),
    title: String(o.title ?? ''),
    body: String(o.body ?? ''),
    // A missing confidence counts as 3.
    confidence: conf === null ? 3 : Math.min(5, Math.max(1, conf)),
    // The model never sets these: a new finding is open, and firstSeenSha comes from the prior records or the head.
    status: 'open',
  };
  delete f.firstSeenSha;
  return { ...f, id: findingId(f) };
}

/** Rules 1 to 4 for one finding. Returns { f } to keep it, { drop } to drop it. */
function checkOne(f, ctx, problems) {
  const file = checkFile(f, ctx.treeDir, ctx.hunks);
  if (file.drop) return file;
  const line = checkLine(f, file);
  if (line.drop) return line;
  const placed = placeFinding(line.f, ctx.hunks);
  const refuted = refuteClaims(placed, ctx, problems);
  return refuted ? { drop: refuted } : { f: placed };
}

/**
 * Applies S5 to the raw findings. grep(x, { treeDir, exts }) returns hits (an array of "path:line:text", or true) and may throw.
 * prior: earlier findings; a kept finding with the same id inherits that firstSeenSha.
 * Returns { kept, dropped:[{ finding, reason, evidence }], problems:[string] }.
 */
export function filterFindings(raw, { treeDir, hunks = null, prior = [], grep = defaultGrep, threadMin = 3, exts = logicExt() } = {}) {
  const ctx = { treeDir, hunks, grep, exts };
  const dropped = [];
  const problems = [];
  const survivors = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const f = normalize(r);
    const out = r !== null && typeof r === 'object' ? checkOne(f, ctx, problems) : { drop: bad('no-file', 'the finding is not an object') };
    if (out.drop) dropped.push({ finding: f, ...out.drop });
    else survivors.push(out.f);
  }
  const dup = dedupe(survivors);
  const seen = new Map((prior ?? []).map((p) => [p.id, p.firstSeenSha]));
  const kept = dup.kept.map((f) => {
    const t = { ...f, thread: isNeverSuppress(f) || f.confidence >= threadMin };
    return seen.get(f.id) ? { ...t, firstSeenSha: seen.get(f.id) } : t;
  });
  return { kept, dropped: [...dropped, ...dup.dropped], problems };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  const flags = { '--findings': 'findings', '--tree': 'tree', '--diff': 'diff', '--prior': 'prior' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (flags[argv[i]] && argv[i + 1] !== undefined) out[flags[argv[i]]] = argv[++i];
    else return { error: `unknown or incomplete argument ${JSON.stringify(argv[i])}` };
  }
  if (!out.findings || !out.tree) return { error: 'pass --findings <json> and --tree <dir>' };
  return out;
}

function readJson(file) {
  const v = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(v) ? v : (v?.findings ?? []);
}

function readHunks(args) {
  const diff = args.diff ?? path.join(args.tree, 'PR.diff');
  return existsSync(diff) ? parseHunks(readFileSync(diff, 'utf8')) : null;
}

/** Returns the exit code. deps (tests): stdout, stderr, grep. */
export function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) { stderr(`review-filter: ${args.error}`); return 2; }
  let result;
  try {
    const opts = { treeDir: args.tree, hunks: readHunks(args), prior: args.prior ? readJson(args.prior) : [] };
    result = filterFindings(readJson(args.findings), deps.grep ? { ...opts, grep: deps.grep } : opts);
  } catch (e) { stderr(`review-filter: ${e.message}`); return 2; }
  if (args.json) stdout(JSON.stringify(result, null, 2));
  else for (const d of result.dropped) stdout(`DROP ${d.reason} ${d.finding.id}`);
  for (const p of result.problems) stderr(`PROBLEM ${p}`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
