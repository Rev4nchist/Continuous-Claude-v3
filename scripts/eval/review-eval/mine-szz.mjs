#!/usr/bin/env node
// mine-szz.mjs: turns the fix chains of fix-chains.mjs into Gold A rows, clean controls and the escape baseline copy.
//   For each escape row (fix commit, blamed PR) it blames the removed lines again, keeps the lines that the blamed PR wrote,
//   and maps them to the PR head. One gold candidate is one run of adjacent head lines. A pair that CodeRabbit flagged before
//   the fix is dropped (seat Q1). A candidate is labelled by the judge (Opus, effort high) in batches, under a daily slot.
//   The fix diff of a candidate is cut to the hunks near its blamed lines. Each judge prompt is scrubbed of PR references,
//   masked of fix shas (every commit of a fix PR), then guarded: a prompt that still holds a PR number, a fix title or a fix sha is not sent.
// Counts only: the report holds no PR number, no file name and no line. A dry run writes nothing.
// With --write the three gold files are built and checked in memory first, then written: one failed gate writes none.
// Named limits: review-body CodeRabbit findings have no line and are not read; one model family labels every row.
// Usage: see USAGE below. No args and --help print it and touch neither git, gh nor the file system.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runJudge, countDay, defaultHeadlessLedger, readHeadlessLedger } from '../../lib/headless.mjs';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { CODERABBIT_LOGIN } from '../../github/review-status.mjs';
import { loadConfig, HERE } from './config.mjs';
import { loadDataset, setOf } from './dataset.mjs';
import { readEscapeRows, stateDirOf } from './escape-causes.mjs';
import { makeGit, readMerges, removedRanges } from './fix-chains.mjs';
import { GOLD_DIR, GoldError, SEVERITIES, loadCleanControls, validateRow } from './gold.mjs';
import { crRounds, defaultGh } from './github.mjs';
import { VERDICTS } from './labels.mjs';

/** The default daily limit of the lane's judge calls (Dave's pace decision). --daily-calls sets another for one run. */
export const SZZ_DAILY_CALLS = 30;
export const BATCH_SIZE = 10;
/** A hunk longer than this (in characters) goes in a judge call of its own. */
export const HUNK_LIMIT = 6000;
/** A judge prompt holds at most this many characters; one item over it goes in a call of its own. */
export const BATCH_CHAR_LIMIT = 24_000;
/** The bar for the clean controls. It is Dave's number, not a tuning knob. */
export const CONTROLS_MIN = 30;
export const SINCE_DEFAULT = '2026-08-01';
export const MINER = 'mine-szz-v1';
export const JUDGE_VERSION = 'szz-label-v2';
export const LABELER = 'claude-opus-5-5';
/** The lane marker. It goes in the sessionId field of the headless ledger row, so this lane counts its own calls. */
export const LEDGER_TAG = 'szz-miner';

/** A judge call may carry 10 pairs or one oversize hunk: more time than the default 180 s. */
const JUDGE_TIMEOUT_MS = 300_000;
const DAY = 86_400_000;
// Dave 2026-11-14: widen both ways, target 30 controls.
const GROUP2_FROM = '2026-06-01T00:00:00Z';
const GROUP2_UNTIL = '2026-10-06T23:59:59Z';
const BANDS = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'];
const LABEL_CACHE = 'szz-labels.jsonl';
const BASELINE_FILE = 'escape-baseline.json';
const FAILURE_REASONS = ['partial-failure', 'diff-failed', 'blame-failed', 'gh-failed', 'git-failed'];
const NO_TARGET_REASONS = ['no-removed-lines', 'outside-window'];
const BLAME_REASONS = ['no-removed-lines', 'no-blamed-line', 'own-pr', 'file-gone', 'line-gone'];
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);
const bump = (obj, key, by = 1) => { obj[key] = (obj[key] ?? 0) + by; };
/** rmSync options: Windows can hold a just-closed file (EBUSY, EPERM) for a moment. */
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
/** A stable id: the prefix and the first 12 hex of a sha256 over the parts. The parts are shas, a file and a line, never a PR number. */
const stableId = (prefix, parts) => `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)}`;

// ---------- small pure helpers ----------

const HEADER_RE = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/gm;

/** From `git blame --porcelain` text: [{ sha, origLine, line }], one per line. A content line starts with a tab, so it never matches. */
export function parsePorcelain(text) {
  return [...String(text).matchAll(HEADER_RE)].map((m) => ({ sha: m[1], origLine: Number(m[2]), line: Number(m[3]) }));
}

/** Groups line numbers into runs of adjacent lines: [{ line, endLine }], sorted. */
export function runsOf(numbers) {
  const runs = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && n === last.endLine + 1) last.endLine = n;
    else runs.push({ line: n, endLine: n });
  }
  return runs;
}

/** Keeps the blamed lines whose commit belongs to the blamed PR and not to the fix PR. own: how many lines had an origin in the fix PR. */
export function keepBlamed(blamed, blamedSet, fixSet) {
  return { kept: blamed.filter((b) => blamedSet.has(b.sha) && !fixSet.has(b.sha)), own: blamed.filter((b) => fixSet.has(b.sha)).length };
}

/** Each kept line found at the head by its origin (sha, origin line): [{ old, head }]. old: its line in the blame that found it. */
function headPairs(kept, headBlame) {
  const byOrigin = new Map(headBlame.map((h) => [`${h.sha}:${h.origLine}`, h.line]));
  return kept.flatMap((k) => { const head = byOrigin.get(`${k.sha}:${k.origLine}`); return head === undefined ? [] : [{ old: k.line, head }]; });
}

/** Finds each kept line at the head by its origin (sha, origin line). lines: the head line numbers. missing: kept lines not at the head. */
export function mapToHead(kept, headBlame) {
  const pairs = headPairs(kept, headBlame);
  return { lines: pairs.map((p) => p.head), missing: kept.length - pairs.length };
}

/** The PR reference forms, in scrub order. scrubPrs removes them; promptGuard refuses a prompt that still holds one. */
const PR_PATTERNS = [
  /Merge pull request[^\n]*/gi,
  /\bpull request\s*#?\d+/gi,
  /\bPR[-\s]*#?\d+/gi,
  /\b(?:pulls?|issues)\/\d+/gi,
  /\(#\d+\)/g,
  /#\d+(?![0-9A-Za-z_])/g,
];

/**
 * Removes every PR reference from a text: (#N), #N, pull/N, pulls/N, issues/N, PR N, PR-N, pr N, "pull request N" and merge-commit text.
 * A #N followed by a letter or digit is kept (a hex colour such as #1a2b3c). An all-digit #N is scrubbed: the leak guard wins.
 */
export function scrubPrs(text) {
  return PR_PATTERNS.reduce((t, re) => t.replace(re, ''), String(text));
}

// ---------- the leak guard ----------

/**
 * Named limit: a fix title shorter than this (after the scrub) is not guarded, because a short word such as "wip" would refuse most
 * prompts. The report says so (NOTES.shortTitles).
 */
const TITLE_MIN = 8;
/** A maximal run of 7 to 64 hex characters (SHA_RE allows a 64-hex sha). One pattern for the mask; the guard looks for a sha prefix anywhere. */
const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,64}(?![0-9a-f])/gi;
const SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * The leak terms of a run: the fix shas (lower case) and the fix titles. A title is scrubbed and sha-masked the way the prompt is
 * (the guard sees the masked prompt), then trimmed and lower-cased; one under TITLE_MIN is not guarded. A title that occurs in the
 * fixed prompt text (templateText) would refuse every prompt: it is dropped and counted in inTemplate (a report note).
 */
export function leakTerms(shas, titles) {
  const s = [...new Set([...shas].map((x) => String(x ?? '').toLowerCase()).filter((x) => SHA_RE.test(x)))];
  const t = [...new Set([...titles].map((x) => maskShas(scrubPrs(x), s).trim().toLowerCase()).filter((x) => x.length >= TITLE_MIN))];
  const template = templateText();
  const kept = t.filter((x) => !template.includes(x));
  return { shas: s, titles: kept, inTemplate: t.length - kept.length };
}

/** Replaces each hex run that is a prefix of a fix sha with <sha>. A prefix inside a longer hex run stays: the guard refuses it. */
export function maskShas(text, shas) {
  return String(text).replace(HEX_RUN, (run) => (shas.some((s) => s.startsWith(run.toLowerCase())) ? '<sha>' : run));
}

/** The leak a prompt holds: 'pr-number', 'fix-title', 'fix-sha', or null for a clean prompt. */
export function promptGuard(prompt, leak) {
  const text = String(prompt);
  if (PR_PATTERNS.some((re) => text.search(re) >= 0)) return 'pr-number';
  const lower = text.toLowerCase();
  if (leak.titles.some((t) => lower.includes(t))) return 'fix-title';
  if (leak.shas.some((s) => lower.includes(s.slice(0, 7)))) return 'fix-sha';
  return null;
}

/** Sends a finished prompt to judge only when promptGuard passes it. Returns { refused: kind } (judge not called) or { res } (null on a throw). */
export async function sendGuarded(prompt, leak, judge) {
  const refused = promptGuard(prompt, leak);
  if (refused) return { refused };
  try { return { res: await judge(prompt) }; } catch { return { res: null }; }
}

// ---------- the diff cut ----------

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

/** The old-side range of a hunk head. A pure insertion (-a,0) sits after line a: its range is [a, a]. */
const oldRange = (m) => { const start = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]); return [start, start + Math.max(n, 1) - 1]; };

/**
 * Cuts the fix diff of one file to the hunks whose old-side range overlaps [span.line - slack, span.endLine + slack].
 * span: the blamed lines as numbered at the parent of the fix (the old side of the diff). A hunk is kept whole; lines before
 * the first hunk stay. No hunk in reach: the nearest one hunk is kept. Returns { hunk, hunksShown, hunksLeftOut }.
 */
export function cutHunks(text, span, slack) {
  const head = [];
  const hunks = [];
  for (const line of String(text).split('\n')) {
    const m = HUNK_HEAD.exec(line);
    if (m) hunks.push({ range: oldRange(m), lines: [line] });
    else (hunks.length ? hunks.at(-1).lines : head).push(line);
  }
  if (hunks.length === 0) return { hunk: String(text), hunksShown: 0, hunksLeftOut: 0 };
  const gap = ([a, b]) => Math.max(0, a - (span.endLine + slack), span.line - slack - b);
  const near = hunks.filter((h) => gap(h.range) === 0);
  const kept = near.length ? near : [hunks.reduce((best, h) => (gap(h.range) < gap(best.range) ? h : best))];
  return { hunk: [...head, ...kept.flatMap((h) => h.lines)].join('\n'), hunksShown: kept.length, hunksLeftOut: hunks.length - kept.length };
}

// ---------- the prompt and the answer ----------

const INSTRUCTIONS = [
  'You label code defects for an evaluation set. Each numbered pair below holds a fix (or an open defect) and the lines that a change wrote earlier.',
  'Question for each pair: did these blamed lines introduce the defect that this fix repairs?',
  'verdict real: the blamed lines carry the defect. verdict noise: the fix does not repair a defect in these lines (a refactor, a rename, whitespace, test churn, or another cause). verdict unclear: you cannot tell from the text.',
  'severity: what the defect would cause if it shipped: critical, major or minor. Give a severity for every pair, also for noise and unclear (use minor).',
  'Answer with strict JSON only, one object per pair, no other text: [{"pair": 1, "verdict": "real|noise|unclear", "severity": "critical|major|minor"}]',
].join('\n');

/** The fixed text of an item, apart from its data. templateText reads these, so a title that is template text is never a leak term. */
const ITEM_TEXT = {
  pair: '### Pair ',
  defect: 'Defect described (no fix exists yet): ',
  openBlamed: 'Blamed lines with context (> marks the blamed lines):',
  fixDiff: 'Fix diff for the file:',
  fixBlamed: 'Blamed lines as they stand in the reviewed head (> marks the blamed lines):',
};

/** The fixed text of every prompt, lower case: INSTRUCTIONS and the item strings, never a rendered item (a pair number is data). */
const templateText = () => [INSTRUCTIONS, ...Object.values(ITEM_TEXT)].join('\n').toLowerCase();

function itemText(item, i) {
  const head = `${ITEM_TEXT.pair}${i + 1}`;
  if (item.kind === 'open-bug') return [head, `${ITEM_TEXT.defect}${item.note}`, ITEM_TEXT.openBlamed, item.blamed].join('\n');
  // No fix subject: it is the PR title, a leak. The diff is cut to the hunks near the blamed lines (cutHunks).
  return [head, ITEM_TEXT.fixDiff, item.hunk, ITEM_TEXT.fixBlamed, item.blamed].join('\n');
}

/** The judge prompt for a batch of candidates. The whole text is scrubbed of PR references. */
export function buildPrompt(items) {
  return scrubPrs([INSTRUCTIONS, ...items.map(itemText)].join('\n\n'));
}

/** The prompt a judge call sends: buildPrompt, then each fix sha prefix masked. promptGuard checks it before the call. */
const judgePrompt = (items, leak) => maskShas(buildPrompt(items), leak.shas);

/**
 * Splits candidates into judge calls: up to `size` pairs a call, and a prompt of at most `chars` characters (buildPrompt length).
 * A hunk over `limit` characters, or an item that alone passes `chars`, is a call of its own.
 */
export function batchItems(items, { size = BATCH_SIZE, limit = HUNK_LIMIT, chars = BATCH_CHAR_LIMIT } = {}) {
  const out = [];
  let cur = [];
  let used = INSTRUCTIONS.length;
  const flush = () => { if (cur.length) out.push(cur); cur = []; used = INSTRUCTIONS.length; };
  for (const item of items) {
    const len = itemText(item, cur.length).length + 2; // buildPrompt joins the parts with a blank line
    if (String(item.hunk ?? '').length > limit || INSTRUCTIONS.length + itemText(item, 0).length + 2 > chars) { flush(); out.push([item]); continue; }
    if (used + len > chars) flush();
    cur.push(item);
    used += itemText(item, cur.length - 1).length + 2;
    if (cur.length >= size) flush();
  }
  flush();
  return out;
}

const unfence = (text) => {
  const t = String(text ?? '').trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1] : t;
};

/** The answers by pair index [{ verdict, severity }], or null when the text is not exactly one answer for each of n pairs. */
export function parseAnswer(text, n) {
  let list;
  try { list = JSON.parse(unfence(text)); } catch { return null; }
  if (!Array.isArray(list) || list.length !== n) return null;
  const out = new Array(n).fill(null);
  for (const a of list) {
    const ok = a && Number.isInteger(a.pair) && a.pair >= 1 && a.pair <= n && out[a.pair - 1] === null && VERDICTS.includes(a.verdict) && SEVERITIES.includes(a.severity);
    if (!ok) return null;
    out[a.pair - 1] = { verdict: a.verdict, severity: a.severity };
  }
  return out;
}

/** The judge calls of this lane on the Chicago day of `ms`: start rows of purpose eval-judge with the lane marker in sessionId. */
export function laneCallsToday(entries, ms) {
  return countDay(entries.filter((e) => e.purpose === 'eval-judge' && String(e.sessionId ?? '').startsWith(LEDGER_TAG)), ms);
}

// ---------- drops, suite, rows ----------

/** The line ranges of a comment: [start_line..line] and [original_start_line..original_line]. A missing end takes the other end. */
const spansOf = (c) => [[c.start_line, c.line], [c.original_start_line, c.original_line]]
  .map(([a, b]) => [a ?? b, b ?? a])
  .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b));

/**
 * True when a CodeRabbit line comment on the same file has a line range (either one) within `slack` lines of the candidate run,
 * and was made before the fix merged. A multi-line comment counts by its whole range, not only its end line.
 * No fixMergedAt (an open bug): a comment of any time counts. A comment with an unreadable time counts (fail closed).
 */
export function crDrops(comments, cand, slack) {
  const cut = cand.fixMergedAt ? Date.parse(cand.fixMergedAt) : Infinity;
  const onRun = (c) => spansOf(c).some(([a, b]) => Math.min(a, b) <= cand.endLine + slack && Math.max(a, b) >= cand.line - slack);
  return comments.some((c) => c?.user?.login === CODERABBIT_LOGIN && c.path === cand.file && !(Date.parse(c.created_at) >= cut) && onRun(c));
}

/** True when an engine record of the PR has a finding on the file within `slack` lines of the candidate run. */
export function isRegression(records, t, slack) {
  const hit = (f) => f?.file === t.file && f.startLine - slack <= t.endLine && (f.endLine ?? f.startLine) + slack >= t.line;
  return records.some((r) => r?.pr === t.pr && (r.findings ?? []).some(hit));
}

/**
 * One gold row (the gold.mjs contract) from a labelled candidate. The id is stable between runs: it hashes the dedup key
 * (blamed merge sha, file, line), so a row dropped before it does not shift it.
 */
export function goldRowOf({ cand, label, suite, cfg }) {
  const open = cand.kind === 'open-bug';
  const hunks = { hunksShown: cand.hunksShown, hunksLeftOut: cand.hunksLeftOut };
  const provenance = open
    ? { miner: MINER, kind: 'open-bug', blamedMergeSha: cand.blamedMergeSha, ...hunks }
    : { miner: MINER, fixSha: cand.fixSha, fixMergeSha: cand.fixMergeSha, blamedMergeSha: cand.blamedMergeSha, cause: cand.cause, primary: cand.primary, crBefore: false, ...hunks };
  return {
    id: stableId('A', [cand.blamedMergeSha, cand.file, cand.line]), source: 'A', suite, split: setOf(cand.blamedPr, cfg), target: { pr: cand.blamedPr, round: cand.round, sha40: cand.head },
    file: cand.file, line: cand.line, severity: label.severity, linkType: 'within-hunk',
    labels: [{ by: LABELER, verdict: label.verdict, judgeVersion: JUDGE_VERSION }], provenance,
  };
}

// ---------- controls ----------

const inWindow = (m, fix) => m.mergeSha !== fix.mergeSha && Date.parse(m.mergedAt) <= Date.parse(fix.mergedAt) && Date.parse(fix.mergedAt) - Date.parse(m.mergedAt) <= 30 * DAY;

/**
 * The clean controls. Group 1: the dataset PRs with no finding at all. Group 2: PRs merged in the control window.
 * A PR is removed (first rule that matches): blamed by any escape row; merged within 30 days before a fix PR that failed (failedFixShas);
 * merged within 30 days before a fix PR with no target that touches a file of it (noTargetFixShas; unknown files remove it: fail closed).
 * A PR with no CodeRabbit round on its head is kept on its merged head (round null, counted noRoundHead); with no merged head it is
 * dropped (noHead). A failed round read drops it (roundFailed). headOf(m): the merged head from git, or null.
 * merges: [{ pr, mergeSha, mergedAt }] in history order.
 */
export async function buildControls({ datasetPrs, merges, escapeRows, failedFixShas, noTargetFixShas, filesOf, roundOf, headOf, cfg, from = GROUP2_FROM, until = GROUP2_UNTIL }) {
  const counts = { group1: 0, group2: 0, removedBlamed: 0, removedFailedFix: 0, removedUnmappedFix: 0, noRoundHead: 0, noHead: 0, roundFailed: 0, notOnMain: 0, total: 0 };
  const ruleOf = controlRule({ merges, escapeRows, failedFixShas, noTargetFixShas, filesOf });
  const byPr = new Map(merges.map((m) => [m.pr, m]));
  const group1 = [...new Set(datasetPrs)].flatMap((pr) => { if (byPr.has(pr)) return [byPr.get(pr)]; counts.notOnMain += 1; return []; });
  const taken = new Set(group1.map((m) => m.pr));
  const group2 = merges.filter((m) => Date.parse(m.mergedAt) >= Date.parse(from) && Date.parse(m.mergedAt) <= Date.parse(until) && !taken.has(m.pr));
  const controls = [];
  for (const [group, list, why] of [['group1', group1, 'dataset-no-finding'], ['group2', group2, 'pre-window-no-fix']]) {
    for (const m of list) {
      const rule = ruleOf(m);
      if (rule) { counts[rule] += 1; continue; }
      const t = await targetFor({ roundOf, headOf }, m, counts);
      if (!t) continue;
      counts[group] += 1;
      controls.push({ id: stableId('K', [m.mergeSha]), split: setOf(m.pr, cfg), target: t.target, provenance: t.head ? { why, head: t.head } : { why } });
    }
  }
  counts.total = controls.length;
  return { controls, counts };
}

/** The removal rule of a control candidate: 'removedBlamed', 'removedFailedFix', 'removedUnmappedFix' or null. */
function controlRule({ merges, escapeRows, failedFixShas, noTargetFixShas, filesOf }) {
  const blamed = new Set(escapeRows.flatMap((r) => [r.blamedPr, r.blamedMergeSha]));
  const failed = merges.filter((m) => failedFixShas.has(m.mergeSha));
  const unmapped = merges.filter((m) => noTargetFixShas.has(m.mergeSha));
  const fileCache = new Map();
  const files = (sha) => { if (!fileCache.has(sha)) fileCache.set(sha, filesOf(sha)); return fileCache.get(sha); };
  const shares = (a, b) => { const fa = files(a.mergeSha); const fb = files(b.mergeSha); return !fa || !fb || fa.some((f) => fb.includes(f)); };
  return (m) => {
    if (blamed.has(m.pr) || blamed.has(m.mergeSha)) return 'removedBlamed';
    if (failed.some((f) => inWindow(m, f))) return 'removedFailedFix';
    if (unmapped.some((f) => inWindow(m, f) && shares(m, f))) return 'removedUnmappedFix';
    return null;
  };
}

const SHA40_RE = /^[0-9a-f]{40}$/;
/** The provenance marker of a control on its merged head. gold.mjs allows round null only with it. */
const MERGED_HEAD = 'merged-head-no-round';

/**
 * The target of a control: { target, head? } or null (dropped). A failed round read counts as roundFailed: a failure is never
 * "no round", and no merged head is read for it (fail closed).
 */
async function targetFor({ roundOf, headOf }, m, counts) {
  let round;
  try { round = await roundOf(m.pr, m); } catch { counts.roundFailed += 1; return null; }
  if (round) return { target: { pr: m.pr, round: round.round, sha40: round.sha40 } };
  // Dave 2026-11-14: widen both ways, target 30 controls. No round: the merged head from git (first-parent merge ^2), never from gh.
  let head;
  try { head = headOf(m); } catch { head = null; }
  if (typeof head !== 'string' || !SHA40_RE.test(head)) { counts.noHead += 1; return null; }
  counts.noRoundHead += 1;
  return { target: { pr: m.pr, round: null, sha40: head }, head: MERGED_HEAD };
}

// ---------- baseline and output checks ----------

/** Problem lines for the escape-baseline bytes: it must be a JSON array with exactly one row for each risk band. [] means fine. */
export function baselineProblems(buf) {
  if (!buf) return [`${BASELINE_FILE}: missing`];
  let rows;
  try { rows = JSON.parse(buf.toString('utf8')); } catch { return [`${BASELINE_FILE}: not valid JSON`]; }
  if (!Array.isArray(rows)) return [`${BASELINE_FILE}: expected a JSON array`];
  return BANDS.flatMap((b) => { const n = rows.filter((r) => r?.band === b).length; return n === 1 ? [] : [`${BASELINE_FILE}: band ${b} has ${n} rows, expected 1`]; });
}

/** Problem lines for the gold rows (validateRow) and the controls (loadCleanControls on a temp folder). No value is printed. */
export function validateOutputs({ goldRows, controls }) {
  const problems = goldRows.flatMap((r, i) => validateRow(r).map((p) => `gold-a.json[${i}] ${p}`));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mine-szz-check-'));
  try {
    writeFileSync(path.join(dir, 'clean-controls.json'), JSON.stringify(controls));
    loadCleanControls(dir);
  } catch (err) {
    if (!(err instanceof GoldError)) throw err;
    problems.push(...err.problems);
  } finally {
    rmSync(dir, RM);
  }
  return problems;
}

/**
 * Writes all files or none. Each file is staged to a temp name; each old file is moved to <name>.bak; the temp files are
 * renamed in and read back (byte-equal to the staged content). On any failure every step is undone in reverse order:
 * the new files are removed and every .bak is moved back, so the gold set is never mixed. On success the .bak files go.
 * rename (tests): the rename function. The .tmp and .bak names do not end in .json, so loadGold never reads them.
 */
export function writeAll(dir, files, { rename = renameSync } = {}) {
  mkdirSync(dir, { recursive: true });
  const items = files.map((f) => { const dest = path.join(dir, f.name); return { ...f, dest, tmp: `${dest}.${process.pid}.tmp`, bak: `${dest}.bak` }; });
  const removeAll = (paths) => { for (const p of paths) { try { rmSync(p, RM); } catch { /* best effort */ } } };
  try {
    for (const t of items) writeFileSync(t.tmp, t.content);
  } catch (err) {
    removeAll(items.map((t) => t.tmp));
    throw err;
  }
  const undo = [];
  try {
    for (const t of items) if (existsSync(t.dest)) { rename(t.dest, t.bak); undo.push(() => rename(t.bak, t.dest)); }
    for (const t of items) {
      rename(t.tmp, t.dest);
      undo.push(() => rmSync(t.dest, RM));
      if (!readFileSync(t.dest).equals(Buffer.from(t.content))) throw new Error(`${t.name}: the written file is not byte-equal to the staged content`);
    }
  } catch (err) {
    const undoFailed = [];
    for (const step of undo.reverse()) { try { step(); } catch (e) { undoFailed.push(e.message); } }
    removeAll(items.map((t) => t.tmp));
    if (undoFailed.length) err.message += ` | rollback failed (${undoFailed.length}): ${undoFailed.join('; ')}; check the .bak files in ${dir}`;
    throw err;
  }
  removeAll(items.map((t) => t.bak));
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---------- the label cache ----------

/**
 * The cache key of a label. It holds JUDGE_VERSION, so a label of another judge version is asked again.
 * The leak-term list is not part of the cache key on purpose: the guard decides whether a prompt may be sent; it does not change
 * the label of a prompt that was sent. A changed term list re-checks prompts, it does not invalidate labels.
 */
export const labelKey = (c) => `${JUDGE_VERSION}:${c.fixSha}:${c.blamedMergeSha}:${c.file}:${c.line}`;

function readLabelCache(stateDir) {
  const file = path.join(stateDir, LABEL_CACHE);
  if (!existsSync(file)) return new Map();
  const rows = lines(readFileSync(file, 'utf8')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return new Map(rows.filter((r) => r?.key).map((r) => [r.key, r]));
}

function appendLabelCache(stateDir, rows) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, LABEL_CACHE);
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  atomicWrite(file, `${old}${rows.map((r) => `${JSON.stringify(r)}\n`).join('')}`);
}

// ---------- git steps for one pair ----------

class StepError extends Error {
  constructor(step) { super(step); this.step = step; }
}

function gitText(git, args, step) {
  const r = git(args);
  if (r.status !== 0) throw new StepError(step);
  return r.stdout;
}

const DIFF_FLAGS = ['--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M'];

/** The files of a fix diff with removed lines: [{ path (old side), ranges, hunk (from the first @@ line) }]. */
function fileBlocks(diff) {
  return diff.split(/^(?=diff --git )/m).flatMap((block) => {
    const [r] = removedRanges(block);
    const at = block.indexOf('\n@@');
    return r && at >= 0 ? [{ path: r.path, ranges: r.ranges, hunk: block.slice(at + 1).trimEnd() }] : [];
  });
}

function revSet(env, range) {
  if (!env.cache.has(range)) env.cache.set(range, new Set(lines(gitText(env.git, ['rev-list', range], 'rev-list'))));
  return env.cache.get(range);
}

const CONTEXT = 2;
const MAX_BLAMED_LINES = 40;

/** The lines of a file at a commit, cached. The empty part after the final newline is cut once, when the cache is filled. */
function fileLines(env, head, file) {
  const key = `${head}:${file}`;
  if (!env.cache.has(key)) {
    const all = gitText(env.git, ['show', key], 'show').split(/\r?\n/);
    if (all.at(-1) === '') all.pop();
    env.cache.set(key, all);
  }
  return env.cache.get(key);
}

/** The text of the blamed run with two lines of context, at most MAX_BLAMED_LINES lines and then a cut marker. The blamed lines start with `>`. */
function blamedText(env, head, file, run) {
  const all = fileLines(env, head, file);
  const from = Math.max(1, run.line - CONTEXT);
  const end = Math.min(all.length, run.endLine + CONTEXT);
  const to = Math.min(end, from + MAX_BLAMED_LINES - 1);
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(`${n >= run.line && n <= run.endLine ? '>' : ' '} ${String(n).padStart(4)}| ${all[n - 1]}`);
  if (end > to) out.push(`  ... ${end - to} more lines cut`);
  return out.join('\n');
}

/** The head lines of the kept lines of one file: { lines, pairs: [{ old, head }] } or { reason: 'file-gone' | 'line-gone' }. */
function headLines(env, head, file, kept) {
  if (env.git(['cat-file', '-e', `${head}:${file}`]).status !== 0) return { reason: 'file-gone' };
  const pairs = headPairs(kept, parsePorcelain(gitText(env.git, ['blame', '-w', '--porcelain', head, '--', file], 'blame')));
  return pairs.length ? { lines: pairs.map((p) => p.head), pairs } : { reason: 'line-gone' };
}

/**
 * One candidate run of a file. The fix diff is cut by the run's lines at the parent of the fix (the diff's old side), not by
 * its head lines: a commit between the reviewed head and the fix can shift them.
 */
function runItem(env, head, f, run, pairs) {
  const olds = pairs.filter((p) => p.head >= run.line && p.head <= run.endLine).map((p) => p.old);
  const cut = cutHunks(f.hunk, { line: Math.min(...olds), endLine: Math.max(...olds) }, env.slack);
  return { file: f.path, ...run, hunk: cut.hunk, hunksShown: cut.hunksShown, hunksLeftOut: cut.hunksLeftOut, blamed: blamedText(env, head, f.path, run) };
}

const REASON_ORDER = ['line-gone', 'file-gone', 'own-pr', 'no-blamed-line'];
const pickReason = (reasons) => REASON_ORDER.find((r) => reasons.has(r)) ?? 'no-blamed-line';

/** Blames the old-side ranges of one file at the parent of the fix commit. Returns { kept, own }. */
function blameFile(env, row, f, sets) {
  const origins = f.ranges.flatMap(([a, b]) => parsePorcelain(gitText(env.git, ['blame', '-w', '--porcelain', '-L', `${a},${b}`, `${row.fixSha}^`, '--', f.path], 'blame')));
  return keepBlamed(origins, sets.blamed, sets.fix);
}

/** Steps 1 to 4 for one escape row. Returns { runs, head } or { reason }. Throws a StepError when a git call fails. */
function mapPair(env, row) {
  const files = fileBlocks(gitText(env.git, ['diff', ...DIFF_FLAGS, `${row.fixSha}^`, row.fixSha], 'diff'));
  if (files.length === 0) return { reason: 'no-removed-lines' };
  const head = gitText(env.git, ['rev-parse', '--verify', `${row.blamedMergeSha}^2`], 'rev-parse').trim();
  const sets = { blamed: revSet(env, `${row.blamedMergeSha}^1..${row.blamedMergeSha}^2`), fix: revSet(env, `${row.mergeSha}^1..${row.mergeSha}^2`) };
  const reasons = new Set();
  const runs = [];
  for (const f of files) {
    const { kept, own } = blameFile(env, row, f, sets);
    if (kept.length === 0) { if (own) reasons.add('own-pr'); continue; }
    const h = headLines(env, head, f.path, kept);
    if (h.reason) reasons.add(h.reason);
    else runs.push(...runsOf(h.lines).map((r) => runItem(env, head, f, r, h.pairs)));
  }
  return runs.length ? { runs, head } : { reason: pickReason(reasons) };
}

// ---------- the gh stage ----------

const cached = (map, key, make) => { if (!map.has(key)) map.set(key, make(key)); return map.get(key); };

async function ghStage(env, base, mapped) {
  const rounds = await cached(env.rounds, base.blamedPr, (pr) => crRounds(pr, { gh: env.gh, repo: env.repo })).catch(() => { throw new StepError('rounds'); });
  const rank = rounds.findIndex((r) => r.sha40 === mapped.head) + 1;
  if (rank === 0) return { reason: 'head-not-reviewed' };
  const comments = await cached(env.comments, base.blamedPr, (pr) => env.commentsOf(pr)).catch(() => { throw new StepError('comments'); });
  const all = mapped.runs.map((r) => ({ ...base, ...r, head: mapped.head, round: rank }));
  const kept = all.filter((c) => !crDrops(comments, c, env.slack));
  return { cands: kept, dropped: all.length - kept.length };
}

/**
 * The title lines of a fix commit for the leak guard: its subject; for a merge commit also the first body line (GitHub puts the
 * PR title there). Cached. A failed read throws StepError('subject'): the pair fails, it is never mined unguarded.
 */
function titlesOf(env, sha, withBody) {
  const all = cached(env.subjects, sha, (s) => lines(gitText(env.git, ['log', '-1', '--format=%s%n%b', s], 'subject')).map((l) => l.trim()).filter(Boolean));
  return withBody ? all.slice(0, 2) : all.slice(0, 1);
}

/** One escape row to candidates. Returns { cands, dropped } or { reason, blame }. Throws a StepError on a failed git or gh step. */
async function minePair(env, row) {
  // Every commit of the fix PR is a leak term, not only fixSha and mergeSha. Read before mapPair: a pair with no candidate still
  // gives its shas. mapPair reads the same set from the cache. A failed rev-list fails the pair.
  for (const sha of revSet(env, `${row.mergeSha}^1..${row.mergeSha}^2`)) env.fixShas.add(sha);
  for (const t of [...titlesOf(env, row.fixSha, false), ...(row.mergeSha ? titlesOf(env, row.mergeSha, true) : [])]) env.titles.add(t);
  const mapped = mapPair(env, row);
  if (mapped.reason) return { reason: mapped.reason, blame: true };
  const base = { kind: 'fix', fixSha: row.fixSha, fixMergeSha: row.mergeSha, fixMergedAt: row.fixMergedAt, blamedPr: row.blamedPr, blamedMergeSha: row.blamedMergeSha, cause: row.cause, primary: row.primary !== false, band: row.band ?? 'UNKNOWN' };
  return ghStage(env, base, mapped);
}

// ---------- the open bug ----------

const earliest = (prs) => prs.reduce((a, b) => (!a || Date.parse(b.merged_at) < Date.parse(a.merged_at) || (Date.parse(b.merged_at) === Date.parse(a.merged_at) && b.number < a.number) ? b : a), null);

/** The origin of one open-bug line at the ref, and the earliest main merge (gh commits/<sha>/pulls) that holds it. { origin, pr } or { reason }. */
async function openBugPr(env, spec) {
  const origin = parsePorcelain(gitText(env.git, ['blame', '-w', '--porcelain', '-L', `${spec.line},${spec.line}`, env.ref, '--', spec.file], 'blame'))[0];
  if (!origin) return { reason: 'no-blamed-line' };
  const pulls = await env.pullsOf(origin.sha).catch(() => { throw new StepError('gh'); });
  const pr = earliest((Array.isArray(pulls) ? pulls : []).filter((p) => env.mergeShas.has(p.merge_commit_sha)));
  return pr ? { origin, pr } : { reason: 'open-bug-no-pr' };
}

/** One --open-bug file:line: blame it at the ref, map the origin commit to the earliest main merge that holds it, find the line at that PR head. */
async function mineOpenBug(env, spec, note) {
  const found = await openBugPr(env, spec);
  if (found.reason) return found;
  const { origin, pr } = found;
  env.openBugTargets.push({ blamedPr: pr.number, blamedMergeSha: pr.merge_commit_sha }); // a known defect: never a clean control
  const head = gitText(env.git, ['rev-parse', '--verify', `${pr.merge_commit_sha}^2`], 'rev-parse').trim();
  const h = headLines(env, head, spec.file, [origin]);
  if (h.reason) return { reason: h.reason };
  const run = { file: spec.file, line: h.lines[0], endLine: h.lines[0] };
  // An open bug has no fix diff: no hunk is shown or left out.
  const mapped = { head, runs: [{ ...run, hunk: note, hunksShown: 0, hunksLeftOut: 0, blamed: blamedText(env, head, spec.file, run) }] };
  const base = { kind: 'open-bug', fixSha: 'open-bug', blamedPr: pr.number, blamedMergeSha: pr.merge_commit_sha, cause: 'open-bug', primary: true, band: 'UNKNOWN', note };
  return ghStage(env, base, mapped);
}

// ---------- the labels ----------

/** Applies cached labels, then (with --label) asks the judge for the rest, in batches, under the daily slot. Returns the label stats. */
async function labelStage(cands, ctx) {
  const cache = readLabelCache(ctx.stateDir);
  for (const c of cands) { const hit = cache.get(labelKey(c)); if (hit) applyHit(c, hit); }
  // The slot is counted again before each call, from the ledger and the clock of that moment: a call of another run and a new
  // Chicago day are seen. own: the calls of this run, ledger-shaped; a call takes the ledger id its judge returns, so it counts once.
  // Known limit: two runs can still race between this count and the ledger append in runJudge. Run one miner at a time.
  const own = [];
  const usedNow = () => laneCallsToday([...readHeadlessLedger(ctx.ledgerPath).entries, ...own], ctx.now());
  const max = ctx.args.dailyCalls ?? SZZ_DAILY_CALLS;
  const slot = { used: usedNow(), max, stopped: false };
  if (!ctx.args.label) return slot;
  for (const batch of batchItems(cleanItems(cands.filter((c) => !c.label), ctx))) {
    const limit = limitReached(usedNow(), max, own.length, ctx.args.stopAfter);
    if (limit) { Object.assign(slot, limit); break; }
    // The second check: the whole built prompt. A refused prompt makes no call, so it takes no slot. Its pairs stay unlabelled.
    const sent = await sendGuarded(judgePrompt(batch, ctx.leak), ctx.leak, (prompt) => askJudge(ctx, own, prompt));
    if (sent.refused) { bump(ctx.stats.failed, 'prompt-guard'); continue; }
    if (!keepAnswers(batch, sent.res, ctx)) bump(ctx.stats.failed, 'label');
    const stop = refusalStop(sent.res);
    if (stop) { Object.assign(slot, stop); break; }
  }
  slot.used = usedNow();
  return slot;
}

/** A cache hit: its label, and the hunk counts of the prompt that was labelled. A row without integer counts keeps this run's cut. */
function applyHit(c, hit) {
  c.label = { verdict: hit.verdict, severity: hit.severity };
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  if (count(hit.hunksShown) && count(hit.hunksLeftOut)) Object.assign(c, { hunksShown: hit.hunksShown, hunksLeftOut: hit.hunksLeftOut });
}

/** A refusal of the shared headless layer: no ledger id, so no call was made. */
const refusedRun = (res) => res?.ok === false && !res.id;

/**
 * One judge call under its own slot row in own. A refusal with no ledger id (cap, lock) made no call: its row goes, so it takes
 * no slot. A null result (the judge threw) keeps its row: a call may have started (fail safe for the slot).
 */
async function callOnce(ctx, own, prompt) {
  own.seq = (own.seq ?? 0) + 1; // a removed row never frees its id: ids stay unique within the run
  const call = { phase: 'start', purpose: 'eval-judge', sessionId: `${LEDGER_TAG}:this-run`, ts: new Date(ctx.now()).toISOString(), id: `this-run-${own.seq}` };
  own.push(call);
  const res = await ctx.judge(prompt);
  if (res?.id) call.id = res.id;
  if (refusedRun(res)) { const at = own.indexOf(call); if (at >= 0) own.splice(at, 1); }
  return res;
}

/** The judge call of a batch: a busy shared lock (reason lock) is tried once more; refusalStop stops the run after a second one. */
async function askJudge(ctx, own, prompt) {
  const res = await callOnce(ctx, own, prompt);
  return refusedRun(res) && res.reason === 'lock' ? callOnce(ctx, own, prompt) : res;
}

/**
 * The stop of a refused run, or null. The shared headless cap (scripts/lib/headless.mjs) refused it: every next call is refused
 * too. The shared lock stayed busy after one retry: stop, rather than spin on it.
 */
function refusalStop(res) {
  if (res?.reason === 'cap') return { stopped: true, stop: 'shared-cap', stopCount: res.count ?? null };
  if (refusedRun(res) && res.reason === 'lock') return { stopped: true, stop: 'shared-lock', stopCount: null };
  return null;
}

/** The limit that stops the next call, or null: the daily limit of the lane first, then the checkpoint of this run (--stop-after). */
function limitReached(used, max, ownCalls, stopAfter) {
  if (used >= max) return { stopped: true, stop: 'daily-limit', stopCount: max };
  if (stopAfter !== undefined && ownCalls >= stopAfter) return { stopped: true, stop: 'checkpoint', stopCount: stopAfter };
  return null;
}

/** The stop line of the label stage. It names the limit and its count. */
function stopText(lc) {
  if (lc.stop === 'checkpoint') return `stopped after ${lc.stopCount} calls (checkpoint)`;
  if (lc.stop === 'shared-cap') return `shared headless cap reached (${lc.stopCount ?? 'count unknown'})`;
  if (lc.stop === 'shared-lock') return 'shared headless lock busy';
  return `daily limit reached (${lc.stopCount})`;
}

/**
 * The first check: each item alone, as its own scrubbed and masked prompt, before the batching. A leaking item is left out
 * (failed prompt-guard, one per item) and stays unlabelled, so it never takes the clean items of a batch down with it.
 */
function cleanItems(items, ctx) {
  return items.filter((c) => {
    const leaks = promptGuard(judgePrompt([c], ctx.leak), ctx.leak) !== null;
    if (leaks) bump(ctx.stats.failed, 'prompt-guard');
    return !leaks;
  });
}

/** The answer of one judge call. Sets cand.label for each answered pair, and appends the cache rows when the flag allows. Returns false for a failed batch. */
function keepAnswers(batch, res, ctx) {
  const answers = res?.ok ? parseAnswer(res.result, batch.length) : null;
  if (!answers) return false;
  batch.forEach((c, i) => { c.label = answers[i]; });
  const row = (c) => ({ key: labelKey(c), fixSha: c.fixSha, blamedMergeSha: c.blamedMergeSha, file: c.file, line: c.line, hunksShown: c.hunksShown, hunksLeftOut: c.hunksLeftOut, ...c.label });
  if (ctx.args.allowLabelCacheWrite) appendLabelCache(ctx.stateDir, batch.map(row));
  return true;
}

// ---------- engine records ----------

const SKIP_RECORD_DIRS = new Set(['engine', 'cli-pairs']);

/** Engine records of the local review: <dir>/<branch>/<head>/<run>.json with pr and findings. Trace files and other folders are skipped. */
export function readEngineRecords(dir) {
  if (!existsSync(dir)) return [];
  const branches = subdirs(dir).filter((b) => !SKIP_RECORD_DIRS.has(path.basename(b)));
  return branches.flatMap(subdirs).flatMap((head) => readdirSync(head).filter((n) => n.endsWith('.json') && !n.endsWith('.trace.json')).flatMap((n) => readRecord(path.join(head, n))));
}

const subdirs = (d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));

/** [{ pr, findings }] for one record file, or [] when the file is not a record. */
function readRecord(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(r?.pr) && Array.isArray(r.findings) ? [{ pr: r.pr, findings: r.findings }] : [];
  } catch { return []; }
}

// ---------- the run ----------

const tally = (list, keyOf) => list.reduce((acc, x) => { bump(acc, keyOf(x)); return acc; }, {});
const isCounted = (c) => c.label?.verdict === 'real' && ['major', 'critical'].includes(c.label.severity);

function pairEnv(args, deps, history) {
  const git = deps.git ?? makeGit(process.cwd());
  const gh = deps.gh ?? defaultGh;
  const repo = args.repo ?? DEFAULT_REPO;
  const comments = async (pr) => { const r = await gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/comments?per_page=100`]); return Array.isArray(r) && r.every(Array.isArray) ? r.flat() : r; };
  return {
    git, gh, repo, ref: args.ref ?? 'main', slack: deps.cfg.lineSlack ?? 3, mergeShas: new Set(history.merges.map((m) => m.mergeSha)), cache: new Map(),
    rounds: new Map(), comments: new Map(), subjects: new Map(), openBugTargets: [], fixShas: new Set(), titles: new Set(), commentsOf: comments, pullsOf: async (sha) => gh(['api', `repos/${repo}/commits/${sha}/pulls`]),
  };
}

/**
 * The escape rows to mine: since the date, primary rows first (only primary with --primary-only).
 * A row whose fixSha or mergeSha is not 40 lower-case hex never reaches git (an argument) and would drop out of the leak terms:
 * it counts as a failed pair ('fix-sha'). A row with an unreadable fix time cannot be placed: it counts as 'fix-time'. Never a silent drop.
 */
function candidateRows(all, args, stats) {
  const since = Date.parse(args.since ?? SINCE_DEFAULT);
  const wanted = all.filter((r) => !args.primaryOnly || r.primary !== false);
  const sha40 = (v) => typeof v === 'string' && SHA40_RE.test(v);
  const shaOk = keepOrFail(wanted, (r) => sha40(r.fixSha) && sha40(r.mergeSha), 'fix-sha', stats);
  const timed = keepOrFail(shaOk, (r) => Number.isFinite(Date.parse(r.fixMergedAt)), 'fix-time', stats);
  const rows = timed.filter((r) => Date.parse(r.fixMergedAt) >= since);
  return [...rows.filter((r) => r.primary !== false), ...rows.filter((r) => r.primary === false)];
}

/** The rows that pass ok. Each other row is a pair that failed for reason (stats.pairs and stats.failed). */
function keepOrFail(rows, ok, reason, stats) {
  const kept = rows.filter(ok);
  const n = rows.length - kept.length;
  stats.pairs += n;
  if (n) bump(stats.failed, reason, n);
  return kept;
}

/** The start of the control mining window (--control-since), in ms. The default is the group 2 start, so it cannot be forgotten. */
const controlSinceOf = (args) => Date.parse(args.controlSince ?? GROUP2_FROM);

/**
 * The control pass: the escape rows from --control-since up to --since go through the mapping step only (mapPair, git, no gh),
 * so a group 2 fix merged before --since still feeds the unmapped-fix control rule. No label, no candidate, no gold row, no leak
 * term and no main count. A row that does not map, or whose map fails (fail closed), is an unmapped fix.
 * Returns { from, pairs, unmappedFixes (count), failed, shas (the unmapped fix merge shas) }.
 */
function controlPass(allRows, args, env) {
  const from = controlSinceOf(args);
  const since = Date.parse(args.since ?? SINCE_DEFAULT);
  const ok = (r) => typeof r.fixSha === 'string' && SHA40_RE.test(r.fixSha) && typeof r.mergeSha === 'string' && SHA40_RE.test(r.mergeSha);
  // A bad sha or time is already a failed pair of the run (candidateRows): it is not counted twice and never reaches git.
  const rows = allRows.filter((r) => ok(r) && Date.parse(r.fixMergedAt) >= from && Date.parse(r.fixMergedAt) < since);
  const shas = new Set();
  let failed = 0;
  for (const row of rows) {
    let mapped;
    try { mapped = mapPair(env, row); } catch { failed += 1; mapped = { reason: 'failed' }; }
    if (mapped.reason) shas.add(row.mergeSha);
  }
  return { from: isoDay(from), pairs: rows.length, unmappedFixes: shas.size, failed, shas };
}

/** Runs one mining job and keeps the stats. A StepError is a failed pair; any other error is 'other'. */
async function attempt(job, stats, seen) {
  stats.pairs += 1;
  try {
    const r = await job();
    if (r.reason) { bump(stats.unmapped, r.reason); if (r.blame) stats.unmappedFixes.add(r.fixMergeSha); return []; }
    stats.crDropped += r.dropped;
    return r.cands.filter((c) => { const k = `${c.blamedMergeSha}:${c.file}:${c.line}`; if (seen.has(k)) { stats.duplicates += 1; return false; } seen.add(k); return true; });
  } catch (err) {
    bump(stats.failed, err instanceof StepError ? err.step : 'other');
    return [];
  }
}

async function mineAll(rows, args, env, stats) {
  const seen = new Set();
  const cands = [];
  for (const row of rows) {
    env.fixShas.add(row.fixSha).add(row.mergeSha); // every fix sha of the run is a leak term, also of a pair with no candidate (minePair adds the PR's other commits)
    cands.push(...await attempt(async () => ({ ...(await minePair(env, row)), fixMergeSha: row.mergeSha }), stats, seen));
  }
  for (const spec of args.openBugs) cands.push(...await attempt(() => mineOpenBug(env, spec, args.openBugNote), stats, seen));
  return cands;
}

function newStats() {
  return { pairs: 0, crDropped: 0, duplicates: 0, unmapped: {}, failed: {}, unmappedFixes: new Set() };
}

/** { merge sha -> head sha } of the first-parent merges, from one git call. */
function headsOf(git, ref) {
  const r = git(['log', '--first-parent', '--format=%H%x1f%P', ref]);
  if (r.status !== 0) throw new Error('git log failed');
  return new Map(lines(r.stdout).map((l) => l.split('\x1f')).map(([sha, parents]) => [sha, (parents ?? '').split(' ')[1]]));
}

function loadFixChains(args, deps) {
  if (deps.fixChains !== undefined) return deps.fixChains;
  if (!args.fixChainsJson) return null;
  try { return JSON.parse(readFileSync(args.fixChainsJson, 'utf8')); } catch { return undefined; }
}

function datasetPrsOf(args, deps) {
  try {
    const ds = deps.dataset ?? loadDataset(args.dataset ?? path.join(os.homedir(), 'continuous-claude', '.claudedocs', '2026-11-01-pr-review-dataset.json'));
    const hasFinding = new Set(ds.findings.map((f) => f.pr));
    return { prs: ds.prs.map((p) => p.pr).filter((pr) => !hasFinding.has(pr)), ok: true };
  } catch { return { prs: [], ok: false }; }
}

/**
 * The clean controls of the run. blamed: the escape rows plus the gold targets of this run (an open bug is not in the escape rows),
 * so a PR that is a gold target here is never a clean control. controlFixShas: the unmapped fixes of the control pass.
 */
async function controlsStage(args, deps, env, history, blamed, stats, controlFixShas) {
  const fixChains = loadFixChains(args, deps);
  const perPr = Array.isArray(fixChains?.perPr) ? fixChains.perPr : [];
  const heads = headsOf(env.git, env.ref);
  const dataset = datasetPrsOf(args, deps);
  const merges = history.merges.map((m) => ({ pr: m.pr, mergeSha: m.mergeSha, mergedAt: m.mergedAt }));
  const failedFixShas = new Set(perPr.filter((p) => FAILURE_REASONS.includes(p.noTarget)).map((p) => p.mergeSha));
  const noTargetFixShas = new Set([...perPr.filter((p) => p.fix === true && p.rows?.length === 0 && NO_TARGET_REASONS.includes(p.noTarget)).map((p) => p.mergeSha), ...stats.unmappedFixes, ...controlFixShas]);
  const filesOf = (sha) => { const r = env.git(['diff', '--name-only', `${sha}^1`, sha]); return r.status === 0 ? lines(r.stdout) : null; };
  // The merged head: the second parent of the first-parent merge, from git (headsOf). Never a sha that gh names.
  const headOf = (m) => heads.get(m.mergeSha) ?? null;
  const roundOf = async (pr, m) => {
    const rank = (await crRounds(pr, { gh: env.gh, repo: env.repo })).findIndex((r) => r.sha40 === headOf(m)) + 1;
    return rank ? { round: rank, sha40: headOf(m) } : null;
  };
  const built = await buildControls({ datasetPrs: dataset.prs, merges, escapeRows: blamed, failedFixShas, noTargetFixShas, filesOf, roundOf, headOf, cfg: deps.cfg });
  const fixChainsGiven = Array.isArray(fixChains?.perPr);
  return { ...built, fixChainsGiven, datasetOk: dataset.ok, coverage: fixChainsGiven ? coverageProblem(perPr, merges) : null };
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The 30-day rules remove a group 2 PR for a fix merged after it, so the fix-chains input must hold every fix from the first
 * group 2 merge on. The input starts at its earliest perPr merge (fix-chains lists every PR it walked, fix or not), dated through
 * the history. It covers group 2 when it starts at or before the first history merge in the group 2 window. Returns the problem
 * line or null. No group 2 merge in the history: nothing to cover.
 */
function coverageProblem(perPr, merges, from = GROUP2_FROM, until = GROUP2_UNTIL) {
  const lo = Date.parse(from);
  const hi = Date.parse(until);
  const first = merges.map((m) => Date.parse(m.mergedAt)).filter((t) => t >= lo && t <= hi).reduce((a, t) => Math.min(a, t), Infinity);
  if (first === Infinity) return null;
  const at = new Map(merges.map((m) => [m.mergeSha, Date.parse(m.mergedAt)]));
  const start = perPr.map((p) => at.get(p?.mergeSha)).filter(Number.isFinite).reduce((a, t) => Math.min(a, t), Infinity);
  if (start <= first) return null;
  return `fix-chains input does not cover group 2 (starts ${start === Infinity ? 'unknown' : isoDay(start)})`;
}

/** Notes for a run that could not apply a rule or keep a label. */
function extraNotes(args, controls) {
  const notes = [];
  if (args.label && !args.allowLabelCacheWrite) notes.push('labels of this run are not kept: --allow-label-cache-write is not set');
  if (!controls.fixChainsGiven) notes.push('partial-failure rule for the controls not applied: no --fix-chains-json');
  if (!controls.datasetOk) notes.push('dataset not read: group 1 of the controls is empty');
  if (controls.coverage) notes.push(controls.coverage);
  return notes;
}

function baselineStatus(stateDir, goldDir) {
  const src = existsSync(path.join(stateDir, BASELINE_FILE)) ? readFileSync(path.join(stateDir, BASELINE_FILE)) : null;
  if (baselineProblems(src).length) return 'source-invalid';
  const dest = path.join(goldDir, BASELINE_FILE);
  if (!existsSync(dest)) return 'absent';
  // Rows, not bytes (seat 2026-11-14): core.autocrlf checks the gold file out with CRLF, so a byte compare reports a false
  // "differs" for the same rows. A copy that does not parse differs.
  let same = false;
  try { same = isDeepStrictEqual(JSON.parse(readFileSync(dest, 'utf8')), JSON.parse(src.toString('utf8'))); } catch { same = false; }
  return same ? 'identical' : 'differs';
}

/** Gold rows from the real candidates, in mined order. noRecord (report only, not in the row): the blamed PR has no engine record at all. */
function goldRows(cands, records, deps) {
  const slack = deps.cfg.lineSlack ?? 3;
  return cands.filter((c) => c.label?.verdict === 'real').map((c) => {
    const suite = isRegression(records, { pr: c.blamedPr, file: c.file, line: c.line, endLine: c.endLine }, slack) ? 'regression' : 'capability';
    const noRecord = !records.some((r) => r?.pr === c.blamedPr);
    return { cand: c, row: goldRowOf({ cand: c, label: c.label, suite, cfg: deps.cfg }), noRecord };
  });
}

function reportOf(stats, cands, rows, slot, controls, args) {
  const labelled = cands.filter((c) => c.label);
  const counted = cands.filter(isCounted);
  const entryOf = (c) => rows.find((r) => r.cand === c);
  const rowOf = (c) => entryOf(c).row;
  const v = tally(labelled, (c) => c.label.verdict);
  return {
    pairs: stats.pairs, crDropped: stats.crDropped, duplicates: stats.duplicates, unmapped: stats.unmapped, failed: stats.failed,
    labelled: labelled.length, unlabelled: cands.length - labelled.length,
    verdicts: { real: v.real ?? 0, noise: v.noise ?? 0, unclear: v.unclear ?? 0 },
    goldRows: rows.length, counted: counted.length,
    countedBySplit: tally(counted, (c) => rowOf(c).split), countedBySuite: tally(counted, (c) => rowOf(c).suite),
    capabilityNoRecord: counted.filter((c) => rowOf(c).suite === 'capability' && entryOf(c).noRecord).length, countedByBand: tally(counted, (c) => c.band),
    yield: tally(counted, (c) => c.cause),
    labelCalls: { used: slot.used, max: slot.max, ...(slot.stopped ? { stopped: true, stop: slot.stop, stopCount: slot.stopCount } : {}) },
    controls: controls.counts, baseline: null, primaryOnly: Boolean(args.primaryOnly), notes: [NOTES.oneFamily, NOTES.reviewBody, NOTES.oneRun, NOTES.goldLines, NOTES.diffCut, NOTES.shortTitles, NOTES.group2From, NOTES.mergedHead], written: [],
  };
}

const NOTES = {
  oneFamily: 'one model family (claude-opus-5-5) labels every row',
  reviewBody: 'review-body CodeRabbit findings are not read (named limit)',
  oneRun: 'one miner run at a time: two runs can race on the daily slot (named limit)',
  goldLines: 'the judge prompt shows gold line numbers by design',
  diffCut: 'the fix diff is cut to the hunks near the blamed lines',
  shortTitles: `titles under ${TITLE_MIN} characters are not guarded (named limit)`,
  group2From: 'group 2 starts 2026-06-01 (Dave, 2026-11-14)',
  mergedHead: 'a control with no CodeRabbit round uses its merged head (Dave, 2026-11-14)',
};

function textReport(rep) {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const c = rep.controls;
  return [
    'mine-szz report (counts only)',
    `pairs: ${rep.pairs}`, `crDropped: ${rep.crDropped}`, `duplicates: ${rep.duplicates}`,
    `unmapped: ${kv(rep.unmapped)}`, `failed: ${kv(rep.failed)}`,
    `labelled: ${rep.labelled} (real ${rep.verdicts.real}, noise ${rep.verdicts.noise}, unclear ${rep.verdicts.unclear}), unlabelled: ${rep.unlabelled}`,
    `gold rows (real): ${rep.goldRows}`, `counted (real, major or critical): ${rep.counted}`,
    `counted by split: ${kv(rep.countedBySplit)}`, `counted by suite: ${kv(rep.countedBySuite)}`,
    `capability, no engine record for the PR: ${rep.capabilityNoRecord}`, `counted by risk band: ${kv(rep.countedByBand)}`,
    `yield (counted, by cause): ${kv(rep.yield)}`,
    `label calls today: ${rep.labelCalls.used} of ${rep.labelCalls.max}`,
    ...(rep.labelCalls.stopped ? [`labelling stopped: ${stopText(rep.labelCalls)}`] : []),
    `controls: group1 ${c.group1}, group2 ${c.group2} (from 06-01), merged head without round ${c.noRoundHead}, no merged head ${c.noHead}, removed blamed ${c.removedBlamed}, removed near a failed fix ${c.removedFailedFix}, removed near an unmapped fix ${c.removedUnmappedFix}, round failed ${c.roundFailed}, not on main ${c.notOnMain}, total ${c.total}`,
    `control mining from ${rep.controlMining.from}: pairs ${rep.controlMining.pairs}, unmapped fixes ${rep.controlMining.unmappedFixes}`,
    `baseline copy: ${rep.baseline}`,
    ...rep.notes,
  ];
}

// ---------- the gates and the write ----------

/** Problem lines for a partial run: a failed pair, an unlabelled candidate or a failed control round read. Counts only. */
function partialProblems(ctx) {
  const failed = Object.values(ctx.report.failed).reduce((a, b) => a + b, 0);
  const why = '(--allow-partial writes anyway)';
  return [
    ...(failed ? [`failed pairs: ${failed} ${why}`] : []),
    ...(ctx.report.unlabelled ? [`unlabelled candidates: ${ctx.report.unlabelled} ${why}`] : []),
    ...(ctx.controls.counts.roundFailed ? [`failed control round reads: ${ctx.controls.counts.roundFailed} ${why}`] : []),
  ];
}

function gateProblems(ctx) {
  const problems = validateOutputs({ goldRows: ctx.rows.map((r) => r.row), controls: ctx.controls.controls });
  if (!ctx.args.allowPartial) problems.push(...partialProblems(ctx));
  if (!ctx.controls.fixChainsGiven) problems.push('fix-chains: --fix-chains-json (the fix-chains --json dry run) is needed to write the controls: the partial-failure rule has no source');
  if (ctx.controls.coverage) problems.push(ctx.controls.coverage);
  // A later window misses group 2 fixes before it: the unmapped-fix rule would keep a control near one of them.
  if (controlSinceOf(ctx.args) > Date.parse(GROUP2_FROM)) problems.push(`control mining window starts after group 2 (${isoDay(controlSinceOf(ctx.args))})`);
  if (!ctx.controls.datasetOk) problems.push('dataset: cannot read the dataset file');
  if (ctx.controls.controls.length < CONTROLS_MIN) problems.push(`controls under ${CONTROLS_MIN}: ${ctx.controls.controls.length}`);
  return [...problems, ...baselineProblems(ctx.baselineBuf)];
}

/** All three files or none. writeAll checks each written file byte for byte (the baseline copy too) before the old files go. */
function writeOutputs(ctx, rename) {
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  writeAll(ctx.goldDir, [
    { name: 'gold-a.json', content: json(ctx.rows.map((r) => r.row)) },
    { name: 'clean-controls.json', content: json(ctx.controls.controls) },
    { name: BASELINE_FILE, content: ctx.baselineBuf },
  ], rename ? { rename } : {});
}

/** The --write path: gates first, then all three files. Returns the problem lines; [] means the files are written. A failed write throws. */
function writeStage(run, dirs, args, deps) {
  const baselineBuf = existsSync(path.join(dirs.stateDir, BASELINE_FILE)) ? readFileSync(path.join(dirs.stateDir, BASELINE_FILE)) : null;
  const problems = gateProblems({ ...run, baselineBuf, args });
  if (problems.length) return problems;
  writeOutputs({ ...run, baselineBuf, goldDir: dirs.goldDir }, deps.rename);
  run.report.written = ['gold-a.json', 'clean-controls.json', BASELINE_FILE];
  run.report.baseline = 'copied';
  return [];
}

// ---------- command line ----------

const USAGE = [
  'usage: node scripts/eval/review-eval/mine-szz.mjs [--since <iso>] [--state-dir <dir>] [--gold-dir <dir>] [--label] [--allow-label-cache-write] [--write]',
  '       [--open-bug <file>:<line> ... --open-bug-note <text>] [--primary-only] [--fix-chains-json <file>] [--dataset <file>] [--records-dir <dir>]',
  '       [--repo owner/name] [--ref <ref>] [--report <file>] [--json] [--allow-partial] [--daily-calls <n>] [--stop-after <n>] [--control-since <iso>]',
  '  Without --write it is a dry run: it reads git, gh and the state dir and writes no file.',
  '  --control-since <iso> (default: the group 2 start, 2026-06-01) maps the escape rows from that date up to --since only to feed the',
  '  unmapped-fix control rule: no label, no candidate, no gold row. --write refuses a date after the group 2 start.',
  `  --label asks the judge (Opus, effort high) for labels, at most ${SZZ_DAILY_CALLS} calls a Chicago day, 10 pairs a call. It never runs without this flag.`,
  '  --daily-calls <n> sets the daily limit of this lane for the run (a positive integer). The shared headless cap of',
  '  scripts/lib/headless.mjs still applies: its refusal fails the batch and stops the run ("shared headless cap reached").',
  '  A busy shared lock makes no call and takes no slot; the batch is tried once more, then the run stops ("shared headless lock busy").',
  '  --stop-after <n> stops labelling after n judge calls of this run (a checkpoint). The labels of those calls are kept.',
  '  The first limit reached stops the run; the report names it and its count.',
  '  --allow-label-cache-write keeps the labels in <state-dir>/szz-labels.jsonl. Without it a --label run keeps nothing.',
  '  The judge prompt shows gold line numbers by design. The fix diff is cut to the hunks near the blamed lines (lineSlack of config.json).',
  '  The judge prompt holds no fix subject. Prefixes of every commit of a fix PR are masked, in the prompt and in the fix titles alike.',
  '  A fix title that occurs in the prompt template is not guarded (the report counts them). Each item is guarded alone before the batching: an item that',
  '  still holds a PR number, a fix title or a fix sha is left out (failed prompt-guard) and stays unlabelled. The whole prompt is',
  `  guarded again before each call. Titles under ${TITLE_MIN} characters are not guarded (named limit).`,
  '  --write builds gold-a.json, clean-controls.json and escape-baseline.json in memory, checks them, then writes all three or none.',
  '  --write refuses a partial run (a failed pair, an unlabelled candidate, a failed control round read); --allow-partial writes anyway.',
  '  --report may sit outside the repo, or in .claudedocs/ or .claude/cache/e2e/ of the repo; never in the gold dir or the state dir.',
  '  Run one miner at a time: two runs can race on the daily slot.',
  '  --fix-chains-json: the fix-chains.mjs --json dry run. It names the fix PRs that failed or had no target; --write needs it.',
  '  It must cover group 2 of the controls (run it with --since 2026-06-01): --write refuses an input whose first PR merged after the',
  '  first group 2 merge ("fix-chains input does not cover group 2"); a dry run prints the same line as a note.',
  '  An escape row whose fixSha or mergeSha is not 40 lower-case hex is not mined (failed fix-sha).',
  '  --primary-only mines only primary escape rows (primary rows are always mined first).',
  '  The report holds counts only: no PR number, file name or line.',
].join('\n');

const VALUE_FLAGS = { '--since': 'since', '--state-dir': 'stateDir', '--gold-dir': 'goldDir', '--report': 'report', '--dataset': 'dataset', '--fix-chains-json': 'fixChainsJson', '--open-bug-note': 'openBugNote', '--repo': 'repo', '--ref': 'ref', '--records-dir': 'recordsDir', '--daily-calls': 'dailyCalls', '--stop-after': 'stopAfter', '--control-since': 'controlSince' };
/** The value flags that take a positive integer. checkArgs turns each into a number. */
const COUNT_FLAGS = { '--daily-calls': 'dailyCalls', '--stop-after': 'stopAfter' };
const BOOL_FLAGS = { '--label': 'label', '--allow-label-cache-write': 'allowLabelCacheWrite', '--write': 'write', '--allow-partial': 'allowPartial', '--json': 'json', '--primary-only': 'primaryOnly', '--help': 'help', '-h': 'help' };

function parseOpenBug(text) {
  const at = String(text).lastIndexOf(':');
  const line = Number(String(text).slice(at + 1));
  return at > 0 && Number.isSafeInteger(line) && line >= 1 ? { file: text.slice(0, at), line } : null;
}

function parseArgs(argv) {
  const out = { openBugs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (BOOL_FLAGS[a]) out[BOOL_FLAGS[a]] = true;
    else if (a === '--open-bug' && next !== undefined) { const spec = parseOpenBug(next); if (!spec) return { error: '--open-bug needs <file>:<line>' }; out.openBugs.push(spec); i += 1; }
    else if (VALUE_FLAGS[a] && next !== undefined && !next.startsWith('--')) { out[VALUE_FLAGS[a]] = next; i += 1; }
    else return { error: VALUE_FLAGS[a] || a === '--open-bug' ? `${a} needs a value` : `unknown argument ${JSON.stringify(a)}` };
  }
  return out.help ? out : checkArgs(out);
}

function checkArgs(out) {
  for (const [flag, key] of [['--since', 'since'], ['--control-since', 'controlSince']]) {
    if (out[key] !== undefined && !Number.isFinite(Date.parse(out[key]))) return { error: `${flag} ${JSON.stringify(out[key])} is not a date` };
  }
  if (out.openBugs.length && !out.openBugNote) return { error: '--open-bug needs --open-bug-note (the defect text of the card)' };
  if (out.ref?.startsWith('-')) return { error: `--ref ${JSON.stringify(out.ref)} is not a usable git ref` };
  for (const [flag, key] of Object.entries(COUNT_FLAGS)) {
    if (out[key] === undefined) continue;
    const n = /^[1-9]\d*$/.test(out[key]) ? Number(out[key]) : NaN;
    if (!Number.isSafeInteger(n)) return { error: `${flag} ${JSON.stringify(out[key])} is not a positive integer` };
    out[key] = n;
  }
  return out;
}

/** True when file resolves to the folder dir or a path below it. A child folder whose name starts with '..' is inside. */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The repo folders where a report may go: the e2e artifact folders. */
const REPORT_DIRS = ['.claudedocs', path.join('.claude', 'cache', 'e2e')];

/**
 * The report file must not sit in the gold dir or the state dir (it could overwrite an answer key), nor in the repo
 * outside REPORT_DIRS. Returns the problem line or null. root (tests): the repo root.
 */
export function reportPathProblem(args, goldDir, stateDir, root = REPO_ROOT) {
  if (!args.report) return null;
  const bad = `--report ${args.report} is inside the gold dir, the state dir or the repo (outside .claudedocs and .claude/cache/e2e)`;
  if ([goldDir, stateDir].some((d) => isInside(d, args.report))) return bad;
  const allowed = REPORT_DIRS.some((d) => isInside(path.join(root, d), args.report));
  return isInside(root, args.report) && !allowed ? bad : null;
}

/** The judge of a run: runner (runJudge) under the lane marker in sessionId, so laneCallsToday counts the call. */
export function defaultJudge(ctx, runner = runJudge) {
  const session = `${LEDGER_TAG}:${process.env.CLAUDE_CODE_SESSION_ID ?? 'none'}`;
  return (prompt) => runner(prompt, { timeoutMs: JUDGE_TIMEOUT_MS, ledgerPath: ctx.ledgerPath, now: ctx.now, sessionId: session });
}

async function mine(args, deps, dirs) {
  const git = deps.git ?? makeGit(process.cwd());
  const history = readMerges({ git, ref: args.ref ?? 'main' });
  const stats = newStats();
  const env = pairEnv(args, { ...deps, git }, history);
  const allRows = readEscapeRows(dirs.stateDir);
  const cands = await mineAll(candidateRows(allRows, args, stats), args, env, stats);
  const ctx = { args, stateDir: dirs.stateDir, ledgerPath: deps.ledgerPath ?? defaultHeadlessLedger(deps.env ?? process.env), now: deps.now ?? Date.now, stats, leak: leakTerms(env.fixShas, env.titles) };
  ctx.judge = deps.judge ?? defaultJudge(ctx);
  const slot = await labelStage(cands, ctx);
  const records = await (deps.readRecords ?? (() => readEngineRecords(args.recordsDir ?? path.join(os.homedir(), '.claude', 'state', 'local-review'))))();
  const rows = goldRows(cands, records, { cfg: deps.cfg });
  // After the labels: the control pass touches no candidate, label or leak term of this run.
  const { shas: controlFixShas, ...controlMining } = controlPass(allRows, args, env);
  const controls = await controlsStage(args, { ...deps }, env, history, [...allRows, ...env.openBugTargets], stats, controlFixShas);
  const report = reportOf(stats, cands, rows, slot, controls, args);
  report.controlMining = controlMining;
  report.notes.push(...extraNotes(args, controls), `fix titles that occur in the prompt template are not guarded: ${ctx.leak.inTemplate}`);
  return { cands, rows, controls, report };
}

function emit(run, args, stdout) {
  if (args.report) { mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true }); writeFileSync(args.report, `${textReport(run.report).join('\n')}\n`); }
  if (args.json) stdout(JSON.stringify(run.report, null, 2));
  else textReport(run.report).forEach((l) => stdout(l));
}

/**
 * Returns the exit code. 0 ok, 1 a gate failed (nothing written), 2 a bad argument or an unexpected error (a failed write is
 * rolled back). deps (tests): git, gh, judge, cfg, dataset, fixChains, readRecords, now, ledgerPath, env, rename, stdout, stderr.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = argv.length === 0 ? { help: true } : parseArgs(argv);
  if (args.help) { stdout(USAGE); return 0; }
  if (args.error) { stderr(`mine-szz: ${args.error}\n${USAGE}`); return 2; }
  const dirs = { stateDir: stateDirOf(args.stateDir, deps.env ?? process.env), goldDir: args.goldDir ?? GOLD_DIR };
  const bad = reportPathProblem(args, dirs.goldDir, dirs.stateDir);
  if (bad) { stderr(`mine-szz: ${bad}`); return 2; }
  try {
    const run = await mine(args, { ...deps, cfg: deps.cfg ?? loadConfig() }, dirs);
    run.report.baseline = baselineStatus(dirs.stateDir, dirs.goldDir);
    const problems = args.write ? writeStage(run, dirs, args, deps) : [];
    emit(run, args, stdout);
    problems.forEach((p) => stderr(`mine-szz: ${p}`));
    return problems.length ? 1 : 0;
  } catch (err) {
    stderr(`mine-szz: ${scrubPrs(String(err?.message ?? err).split('\n')[0])}`);
    return 2;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
