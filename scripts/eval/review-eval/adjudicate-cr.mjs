#!/usr/bin/env node
// adjudicate-cr.mjs: turns CodeRabbit dataset findings (Major or higher) into Gold CR rows.
//   plan [--dataset F] [--json]          counts only: candidates by split, adjudicated, with lines, file only, no sha. No judge call.
//   run --limit N --confirm-headless     one judge call (Opus, effort high) for each of the next N findings not yet adjudicated.
// A prompt holds a neutral index, the file, the diff hunk of the round, the comment text, its severity and (if given) the outcome word.
// The comment text is scrubbed of PR references and github links. The whole prompt is guarded before the call: a PR reference, a fix
// sha prefix, any 40-hex sha, a github url, the comment id or the finding key refuses it. The first refusal stops the run (no retry).
// Only verdict yes becomes a gold row (gold/adjudicated-cr.json). no and unclear, and a yes that waits for its linkType, are kept in a
// sidecar state map keyed by the id hash (no text: a yes keeps the severity and the sha256 of the raw answer). The sidecar has no
// .json ending: gold.mjs loadGold reads every .json file of gold/ as a row array.
// Counts only on stdout and stderr: no PR number, comment id, finding key or sha. The answer's why text is never kept.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { answerKeyHitsOf } from '../../github/lib/answer-key.mjs';
import { runJudge } from '../../lib/headless.mjs';
import { loadConfig } from './config.mjs';
import { VERDICT_OF } from './dispositions.mjs';
import { loadDataset, resolveFindings, setOf } from './dataset.mjs';
import { makeGit } from './fix-chains.mjs';
import { GOLD_DIR, SEVERITIES, validateRow } from './gold.mjs';
import { LINKTYPE_PATH, loadLinkTypes } from './linktype.mjs';
import { foldSev, isMajor } from './match.mjs';
import { HUNK_LIMIT, isRegression, leakTerms, maskShas, promptGuard, readEngineRecords, scrubPrs, sendGuarded } from './mine-szz.mjs';
import { checkSmokeContext, claudeChildEnv, smokeReport, streamJsonArgs, withRunSettings } from './seed.mjs';

export const PROMPT_VERSION = 'adjudicate-cr-v1';
export const JUDGE_VERSION = 'adjudicate-cr-v1';
const ADJUDICATOR = 'adjudicate-cr';
const OUT_NAME = 'adjudicated-cr.json';
const JUDGE_TIMEOUT_MS = 180_000;
const BODY_LIMIT = 4000;
/** A hunk sent to the judge has at most this many lines (the header line counts). A cut hunk ends with a cut mark. */
const HUNK_MAX_LINES = 120;
/** The run stops after this many failed calls in a row, or when more than FAIL_RATE_MAX of the calls failed once FAIL_RATE_MIN_CALLS ran. */
const MAX_FAIL_STREAK = 3;
const FAIL_RATE_MIN_CALLS = 5;
const FAIL_RATE_MAX = 0.2;
const ANSWER_VERDICTS = ['yes', 'no', 'unclear'];
const DISPOSITIONS = ['fixed', 'wrong', 'wont_fix', 'none'];
/** The judge errors that stop a run: the same call would fail again for every finding after it. */
const STOP_REASONS = new Set(['cap', 'served-model', 'no-claude', 'lock']);
const SHA40 = /^[0-9a-f]{40}$/;

/** An error with a fixed message that may be printed. exitCode: the exit code (default 2). */
class UserError extends Error {}

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');
/** A stable id: 'cr-' and the first 12 hex of a sha256 over the finding key. */
export const idOf = (key) => `cr-${sha256(key).slice(0, 12)}`;
/** The stable label of a finding in its prompt: the first 8 hex of its id hash. */
const labelOf = (id) => id.slice(3, 11);
const commentIdOf = (f) => /^\d+:(\d+)$/.exec(String(f.key))?.[1] ?? null;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- the prompt and the guard ----------

const INSTRUCTIONS = [
  'You check one code review comment for an evaluation set. An automated reviewer made the comment on a code change.',
  'Question: does the comment point at a real defect in the code shown, one that would cause incorrect behaviour, data loss or a security problem if it shipped?',
  'verdict yes: the defect is real. verdict no: the comment is mistaken, a style remark, or already handled in the code shown. verdict unclear: you cannot tell from the text.',
  'severity: what the defect would cause if it shipped: critical, major or minor. Give a severity for every answer; use minor for no and unclear.',
  'Answer with strict JSON only, no other text: {"verdict": "yes|no|unclear", "severity": "critical|major|minor", "why": "at most 25 words"}',
].join('\n');

const stripLinks = (text) => String(text).replace(/https?:\/\/(?:www\.)?github\.com\/\S*/gi, '<link>');
const cleanBody = (text) => scrubPrs(stripLinks(text));

/**
 * The judge prompt of one finding. Only the comment text is scrubbed; the whole prompt is guarded before the call (send).
 * The judge is blind: the prompt never holds what happened to the finding (a disposition). That word stays in the sidecar.
 * label: the first 8 hex of the id hash (labelOf). It is the same in every run, so a re-run sends the same text for the same finding.
 */
export function buildPrompt({ label, file, hunk, body, severity, sha }) {
  const lines = [INSTRUCTIONS, '', `### Finding ${label}`, `File: ${file}`, `Reviewer severity: ${severity}`];
  lines.push('Diff hunk at the reviewed round:', hunk, 'Reviewer comment:', cleanBody(body));
  const text = lines.join('\n');
  return sha ? maskShas(text, [String(sha).toLowerCase()]) : text;
}

const HEX40 = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, token) => new RegExp(`(?<![0-9A-Za-z])${escapeRe(token)}(?![0-9A-Za-z])`).test(text);

/**
 * The finding's own PR number after a PR word or a mark that promptGuard does not read: pr_N, PR(N), pull-N, issue N, gh N, merge N, #N, /N.
 * (promptGuard refuses #N, PR N, PR-N, PR: N, pull/N, pulls/N, issues/N, (#N), GH-N, "pull request N" and merge text, for any number.)
 * leakTerms cannot carry a PR number: its terms are scrubbed with scrubPrs and kept only at 8 characters or more.
 */
const prFormRe = (pr) => new RegExp(`(?:\\b(?:pr|pull|issue|merge|gh)s?[\\s_:#/(\\[-]*|[#/])${escapeRe(pr)}(?!\\d)`, 'i');

/** What promptGuard does not see: any 40-hex sha, a github url, the finding's PR in another form, the comment id, the finding key. The kind, or null. */
export function extraGuard(prompt, f) {
  const id = commentIdOf(f);
  if (HEX40.test(prompt)) return 'sha';
  if (/github\.com\//i.test(prompt)) return 'repo-url';
  if (f.pr !== undefined && f.pr !== null && prFormRe(f.pr).test(prompt)) return 'pr-term';
  if (id && hasToken(prompt, id)) return 'comment-id';
  return hasToken(prompt, f.key) ? 'finding-key' : null;
}

/**
 * The refusal kinds the sidecar may hold: promptGuard (pr-number, fix-title, fix-sha) and extraGuard (sha, repo-url, pr-term, comment-id,
 * finding-key). A kind outside the list is written as 'other'. A kind is never free text and never holds a number.
 */
export const REFUSAL_KINDS = Object.freeze(['pr-number', 'fix-title', 'fix-sha', 'sha', 'repo-url', 'pr-term', 'comment-id', 'finding-key', 'other']);
export const refusalKindOf = (kind) => (REFUSAL_KINDS.includes(kind) ? kind : 'other');

/** { refused: kind } with the judge not called, or { res } (null on a throw). The mine-szz guard first, then extraGuard. A kind never holds a number. */
async function send(prompt, f, judge) {
  const leak = leakTerms([f.sha40], []);
  const refused = promptGuard(prompt, leak) ?? extraGuard(prompt, f);
  return refused ? { refused } : sendGuarded(prompt, leak, judge);
}

// ---------- the answer ----------

const unfence = (text) => {
  const t = String(text ?? '').trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1] : t;
};
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** { verdict, severity } from the strict JSON object, or null. The why text must be a string of at most 25 words; it is checked, never kept. */
export function parseAnswer(text) {
  let a;
  try { a = JSON.parse(unfence(text)); } catch { return null; }
  const ok = isObject(a) && ANSWER_VERDICTS.includes(a.verdict) && SEVERITIES.includes(a.severity) && typeof a.why === 'string' && wordCount(a.why) <= 25;
  return ok ? { verdict: a.verdict, severity: a.severity } : null;
}

/** Project setting sources only. A copy of the private SETTING_ARGS at seed.mjs:55; a test fails when the two lists differ. */
export const SETTING_ARGS = Object.freeze(['--setting-sources', 'project']);

/**
 * The spawn of a judge run, the seed.mjs smoke child set-up (seat ruling 17:2x, option A: the exported seed.mjs parts, composed here).
 * withRunSettings points --settings at a merged file in the run cwd with crossSessionInbound refuse and auto memory off. A stream run
 * (the canary) asks for stream-json, so the init event and any hook event show. A settings fault throws before the spawn: a failed run.
 */
export function judgeSpawn(base, { stream = false, home = os.homedir() } = {}) {
  return (command, args, opts) => {
    const argv = withRunSettings(args, opts.cwd);
    addMdExcludes(argv, home);
    return base(command, stream ? streamJsonArgs(argv) : argv, opts);
  };
}

/**
 * The user CLAUDE.md and the user rules folder, as claudeMdExcludes globs in both slash forms (seat ruling, 2026-11-15). The docs say the key
 * matches absolute paths; they name no Windows path form, so both go in. The canary probe and token drop prove the excludes took effect.
 */
export function userMdExcludes(home) {
  const fwd = path.join(home, '.claude').replace(/\\/g, '/');
  const back = fwd.replace(/\//g, '\\');
  return [`${fwd}/CLAUDE.md`, `${fwd}/rules/**`, `${back}\\CLAUDE.md`, `${back}\\rules\\**`];
}

/**
 * Adds the user excludes to the settings file that argv names with --settings (the merged file of withRunSettings; arrays merge, as the
 * settings layers do). No --settings value: a fixed throw before any read or write, so the spawn fails and no call runs.
 */
export function addMdExcludes(argv, home) {
  const at = argv.indexOf('--settings');
  const file = at < 0 ? undefined : argv[at + 1];
  if (typeof file !== 'string' || file === '') throw new Error('settings: no --settings value');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const had = Array.isArray(s.claudeMdExcludes) ? s.claudeMdExcludes : [];
  writeFileSync(file, JSON.stringify({ ...s, claudeMdExcludes: [...new Set([...had, ...userMdExcludes(home)])] }));
}

/**
 * The judge: runner (runJudge) under the lane session id. The child gets the seed.mjs allowlist env (claudeChildEnv: system and home
 * names only, auto memory off; no session id, CLAUDE_*, CCV3_*, lane banner switch or key), project settings only and judgeSpawn.
 * A scratch folder and no --bare come from runJudge. judge(prompt, { stream: true }) is the canary form.
 */
export function defaultJudge(runner = runJudge, env = process.env, baseSpawn = spawn, home = os.homedir()) {
  const session = `${ADJUDICATOR}:${env.CLAUDE_CODE_SESSION_ID ?? 'none'}`;
  const childEnv = claudeChildEnv(env);
  return (prompt, { stream = false } = {}) => runner(prompt, {
    timeoutMs: JUDGE_TIMEOUT_MS, sessionId: session, env: childEnv, prefixArgs: [...SETTING_ARGS], spawnFn: judgeSpawn(baseSpawn, { stream, home }),
  });
}

// ---------- the store: output rows and the sidecar ----------

const statePathOf = (outFile) => `${outFile.replace(/\.json$/i, '')}.state`;

function readJsonFile(file, fallback, what) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new UserError(`${what} is not valid JSON`); }
}

function loadStore(files) {
  const rows = readJsonFile(files.out, [], 'the output file');
  const state = readJsonFile(files.state, {}, 'the state file');
  if (!Array.isArray(rows)) throw new UserError('the output file is not a JSON array');
  if (!isObject(state)) throw new UserError('the state file is not a JSON object');
  return { rows, state, rowIds: new Set(rows.map((r) => r?.id)) };
}

const isDone = (store, f) => Object.hasOwn(store.state, f.id) || store.rowIds.has(f.id);
const isRefused = (store, f) => store.state[f.id]?.verdict === 'refused';
const hasSha = (f) => SHA40.test(String(f.sha40 ?? ''));
/** True for a path under an answer-key glob (scripts/github/lib/answer-key.mjs): such a finding is never sent to the judge. */
const isAnswerKeyPath = (f) => typeof f.path === 'string' && answerKeyHitsOf([f.path]).length > 0;
/** A finding has line data when it has a start line (a positive integer). A finding with none is not sent (skipped: no line data). */
const hasLines = (f) => Number.isInteger(f.startLine) && f.startLine >= 1;
const openOf = (cands, store) => cands.filter((f) => hasSha(f) && !isDone(store, f));
/** The findings a run may still ask the judge about: a sha, line data, no answer, no refusal marker, not an answer-key path. */
const pendingOf = (cands, store) => openOf(cands, store).filter((f) => !isAnswerKeyPath(f) && hasLines(f));
const answerKeyOf = (cands, store) => openOf(cands, store).filter(isAnswerKeyPath);
const noLineOf = (cands, store) => openOf(cands, store).filter((f) => !isAnswerKeyPath(f) && !hasLines(f));

function atomicWrite(file, value, indent = 1) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`);
  renameSync(tmp, file);
}

// ---------- gh: quiet and counted ----------

/**
 * The default gh. Same config and flags as github.mjs defaultGh (:11-17), but stderr is captured: execFileSync with no stdio option
 * lets the gh child write its error text on the terminal (github.mjs:15). A failed call throws; the caller counts it (countingGh).
 */
export function quietGh(exec = execFileSync, env = process.env) {
  return (args) => {
    const personal = path.join(os.homedir(), '.config', 'gh-personal');
    const dir = env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
    const childEnv = { ...env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
    const out = exec('gh', args, { encoding: 'utf8', env: childEnv, timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  };
}

/** gh that counts each failed call in lookups.failed and rethrows. The error text is never printed: the summary holds the count only. */
function countingGh(gh, lookups) {
  return async (args) => {
    try { return await gh(args); } catch (err) { lookups.failed += 1; throw err; }
  };
}

// ---------- candidates ----------

/** The findings of severity Major or higher, resolved to sha and lines (resolveFindings with its own filter, so the keys stay). */
const datasetFileOf = (args) => args.dataset ?? defaultDataset();

function readDataset(args) {
  try { return loadDataset(datasetFileOf(args)); } catch { throw new UserError('the dataset file cannot be read or has the wrong shape'); }
}

/** The key of a dataset row, the same rule as dataset.mjs resolveFindings (:30): pr, then the comment id or r<round>-<row index>. */
const rowKey = (row, i) => `${row.pr}:${row.comment_id ?? `r${row.round}-${i}`}`;
const rowIndexByKey = (ds) => new Map(ds.findings.map((row, i) => [rowKey(row, i), i]));

/** A candidate with no lines takes start_line and end_line from its dataset row, where `lines --write` put them. */
function withDatasetLines(cands, ds) {
  const at = rowIndexByKey(ds);
  return cands.map((f) => {
    const row = ds.findings[at.get(f.key)];
    if (hasLines(f) || !Number.isInteger(row?.start_line) || row.start_line < 1) return f;
    return { ...f, startLine: row.start_line, endLine: Number.isInteger(row.end_line) ? row.end_line : row.start_line };
  });
}

async function loadCandidates(ds, deps, cfg) {
  const major = (f) => isMajor(f.severity);
  const all = await (deps.resolveFindings ?? resolveFindings)(ds, { gh: deps.gh, filter: major });
  return withDatasetLines(all.filter(major).map((f) => ({ ...f, id: idOf(f.key), split: setOf(f.pr, cfg) })), ds);
}

/** The dataset PR numbers (the PR list and the findings' PRs) as 1 to 5 digit strings. Used only to count bare numbers; never printed. */
const prNumbersOf = (ds, cands) => new Set([...ds.prs.map((p) => p?.pr), ...cands.map((f) => f.pr)].map(String).filter((s) => /^\d{1,5}$/.test(s)));

/** { dev, holdout, reserve } counts of the findings in a list. */
function splitCounts(list) {
  const out = { dev: 0, holdout: 0, reserve: 0 };
  for (const f of list) out[f.split] += 1;
  return out;
}

/**
 * Counts only. pending: has a sha, line data, no answer, no refusal marker, not an answer-key path; pendingBySplit is the split of those.
 * refused: the guard refused its prompt once. unresolved: no usable sha. dispositions: the key -> disposition map of --dispositions (or null).
 */
export function planCounts(cands, store, lookupsFailed = 0, dispositions = null) {
  const withLines = cands.filter(hasLines).length;
  const refused = cands.filter((f) => isRefused(store, f)).length;
  const pending = pendingOf(cands, store);
  return {
    candidates: cands.length, bySplit: splitCounts(cands), adjudicated: cands.filter((f) => isDone(store, f)).length - refused, refused,
    answerKeySkipped: answerKeyOf(cands, store).length, lookupsFailed, noLineSkipped: noLineOf(cands, store).length,
    withDisposition: dispositions ? cands.filter((f) => dispositions.has(f.key)).length : 0,
    pending: pending.length, pendingBySplit: splitCounts(pending), withLines, fileOnly: cands.length - withLines,
    unresolved: cands.filter((f) => !hasSha(f)).length,
  };
}

// ---------- --dispositions ----------

/** The disposition of each verdict: VERDICT_OF turned around (real is fixed, noise is wrong, unclear is wont_fix). */
const DISPOSITION_OF = Object.fromEntries(Object.entries(VERDICT_OF).filter(([, v]) => v !== null).map(([d, v]) => [v, d]));

/**
 * The records of --dispositions: a JSON array (the records of dispositions.mjs recordOf: key, verdict, disposition). The same rules as
 * `cli.mjs gold report --dispositions`. A file that cannot be read or is not an array is exit 1 with a fixed message, no file content.
 */
function readDispositionRecords(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(list)) return list;
    if (Array.isArray(list?.findings)) return list.findings; // the sweep file of dispositions.mjs: { ...summary, findings, unparsed }
  } catch { /* the fixed message below */ }
  throw Object.assign(new UserError('--dispositions needs a file that holds a JSON array'), { exitCode: 1 });
}

/** key -> disposition from the records: the record's own disposition word, else the one its verdict stands for. A record with neither is left out. */
function dispositionMap(args) {
  if (!args.dispositions) return null;
  const map = new Map();
  for (const r of readDispositionRecords(args.dispositions)) {
    const d = DISPOSITIONS.includes(r?.disposition) ? r.disposition : DISPOSITION_OF[r?.verdict];
    if (d && r?.key !== undefined && r?.key !== null) map.set(String(r.key), d);
  }
  return map;
}

function planText(c) {
  return [
    `adjudicate-cr plan: candidates ${c.candidates} (CodeRabbit findings of severity Major or higher)`,
    `split: dev ${c.bySplit.dev}, holdout ${c.bySplit.holdout}, reserve ${c.bySplit.reserve}`,
    `adjudicated ${c.adjudicated}, refused ${c.refused}, skipped: answer-key path ${c.answerKeySkipped}, skipped: no line data ${c.noLineSkipped}, pending ${c.pending}`,
    `pending by split: dev ${c.pendingBySplit.dev}, holdout ${c.pendingBySplit.holdout}, reserve ${c.pendingBySplit.reserve}`,
    `with a disposition ${c.withDisposition} of ${c.candidates}`,
    `with lines ${c.withLines}, file only ${c.fileOnly} (no start or end line), no sha ${c.unresolved}`,
    `gh lookups failed ${c.lookupsFailed} (a failed lookup leaves a finding with fewer facts; no gh text is printed)`,
  ].join('\n');
}

// ---------- evidence ----------

const NEW_HEAD = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a diff cut at the first @@ line: [{ start, end, lines }], the range on the new side. */
function splitHunks(text) {
  const hunks = [];
  for (const line of text.split('\n')) {
    const m = NEW_HEAD.exec(line);
    if (m) hunks.push({ start: Number(m[1]), end: Number(m[1]) + Math.max(Number(m[2] ?? 1), 1) - 1, lines: [line] });
    else hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

/**
 * The hunks whose new-side range is within slack lines of the finding lines. A finding with a line and no hunk near it gets '' (never the
 * whole commit). A finding with no line gets every hunk (a run does not send such a finding).
 */
export function hunksNear(text, f, slack) {
  const hunks = splitHunks(text);
  const lo = f.startLine - slack;
  const hi = (f.endLine ?? f.startLine) + slack;
  const keep = Number.isFinite(f.startLine) ? hunks.filter((h) => h.start <= hi && h.end >= lo) : hunks;
  return keep.flatMap((h) => h.lines).join('\n').trimEnd();
}

const NO_HUNK_NEAR = Symbol('no hunk near the line');

/** The diff of the file at the round sha (git show), from the first @@ line (the header holds hex runs), cut near the finding. null when there is no hunk, NO_HUNK_NEAR when none is near the line. */
async function hunkOf(f, git, slack) {
  const r = await git(['show', '--format=', '--unified=3', f.sha40, '--', f.path]);
  const at = r.status === 0 ? /^@@/m.exec(r.stdout) : null;
  if (!at) return null;
  const near = hunksNear(r.stdout.slice(at.index), f, slack);
  return near === '' ? NO_HUNK_NEAR : capHunk(near);
}

/** At most HUNK_MAX_LINES lines and HUNK_LIMIT characters. A cut hunk ends with a cut mark, so the judge knows it is partial. */
export function capHunk(text) {
  const lines = text.split('\n');
  const byLines = lines.length > HUNK_MAX_LINES ? `${lines.slice(0, HUNK_MAX_LINES).join('\n')}\n[hunk cut at ${HUNK_MAX_LINES} lines]` : text;
  return byLines.length > HUNK_LIMIT ? `${byLines.slice(0, HUNK_LIMIT)}\n[hunk cut at ${HUNK_LIMIT} characters]` : byLines;
}

async function bodyOf(f, gh) {
  const id = commentIdOf(f);
  if (!id) return null;
  const c = await gh(['api', `repos/${DEFAULT_REPO}/pulls/comments/${id}`]);
  const text = typeof c?.body === 'string' ? c.body.trim() : '';
  return text ? text.slice(0, BODY_LIMIT) : null;
}

/** { hunk, body }, { noHunkNear: true }, or null when the path, the hunk or the comment text is missing or a read fails (no judge call in any of the last two). */
async function evidenceOf(f, { deps, slack }) {
  if (typeof f.path !== 'string' || f.path === '') return null;
  try {
    const hunk = await hunkOf(f, deps.git, slack);
    if (hunk === NO_HUNK_NEAR) return { noHunkNear: true };
    const body = hunk ? await bodyOf(f, deps.gh) : null;
    return hunk && body ? { hunk, body } : null;
  } catch { return null; }
}

// ---------- the run ----------

const newTally = () => ({
  judged: 0, yes: 0, no: 0, unclear: 0, unparsed: 0, judgeFailed: 0, evidenceFailed: 0, refused: 0, skippedRefusals: 0, skippedAnswerKey: 0, skippedNoLine: 0, skippedNoHunk: 0, noSha: 0,
  waitingLinktype: 0, lookupsFailed: 0, promptsBuilt: 0, bareNumberPrompts: 0, rowsAdded: 0, rowsInvalid: 0, rowsInFile: 0, stop: null, calls: [], canary: null,
  agreement: { yesFixed: 0, noWrong: 0, yesWrong: 0, noFixed: 0, unclear: 0, none: 0, other: 0 },
});

/** The agreement bucket of a judge verdict and a disposition word. No disposition (or none): none. Verdict unclear: unclear. A pair not listed: other. */
function agreementKey(verdict, disposition) {
  if (!disposition || disposition === 'none') return 'none';
  if (verdict === 'unclear') return 'unclear';
  return { 'yes&fixed': 'yesFixed', 'no&wrong': 'noWrong', 'yes&wrong': 'yesWrong', 'no&fixed': 'noFixed' }[`${verdict}&${disposition}`] ?? 'other';
}

// ---------- the per-call proof (the staged checkpoint reads it) ----------

/** Text in the raw result, outside the answer, that would show a lane banner or hook context. A marker is a sign; no marker is not a proof. */
const MARKERS = /lane board|SessionStart|additionalContext|hook_event|system-reminder|MEMORY MATCH/i;

/** The `type: result` object of the claude -p JSON output (stdout of a run), or null. */
function rawResultOf(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/).reverse()) {
    try { const o = JSON.parse(line); if (isObject(o) && o.type === 'result') return o; } catch { /* not the result line */ }
  }
  return null;
}

/**
 * What one judge result shows. runJudge returns servedModel, usage, exit, costUsd and the raw stdout; it does not return the effort
 * or any hook or banner field. effortRequested is the fixed effort runJudge asks for. effortReported is the raw result's own `effort`, else null.
 * markersSeen: null when there is no raw output to scan. inputTokens: input, cache creation and cache read tokens of the call.
 */
export function proofOf(res, promptChars) {
  const raw = rawResultOf(res?.stdout);
  const { result: answer, ...outside } = raw ?? {};
  const u = raw?.usage ?? res?.usage ?? null;
  const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null;
  return {
    servedModel: res?.servedModel ?? null, effortRequested: 'high', effortReported: raw?.effort ?? null, exit: res?.exit ?? null,
    inputTokens: input, outputTokens: u?.output_tokens ?? null, promptChars, costUsd: res?.costUsd ?? null,
    markersSeen: raw === null ? null : MARKERS.test(JSON.stringify(outside)) || MARKERS.test(String(answer ?? '')),
  };
}

const markersText = (m) => (m === null ? 'unknown' : m ? 'yes' : 'no');
const callText = (c, i) => `call ${i + 1}: model ${c.servedModel ?? 'unknown'}, effort requested ${c.effortRequested}, effort reported ${c.effortReported ?? 'none'}, markers seen ${markersText(c.markersSeen)}, input tokens ${c.inputTokens ?? 'unknown'}, prompt chars ${c.promptChars}${c.margin === undefined ? '' : `, margin ${c.margin ?? 'none'}`}`;

// ---------- bare numbers ----------

/** A 1 to 5 digit token with no # before it, no letter, digit, _ . or / around it, and no PR or pull context. Hunk header lines (@@) are not read. */
const BARE_NUMBER = /(?<![0-9A-Za-z_#/.])(?<!\bPR[-\s:]*)(?<!pull request\s*)\d{1,5}(?![0-9A-Za-z_])/gi;

/** True when a part of the evidence holds a bare number that is a dataset PR number. */
function hasBareNumber(parts, prNumbers) {
  const text = parts.join('\n').split('\n').filter((l) => !l.startsWith('@@')).join('\n');
  return [...text.matchAll(BARE_NUMBER)].some((m) => prNumbers.has(m[0]));
}
/** The disposition word of a finding: deps.dispositionOf (tests), else the --dispositions map. It feeds the sidecar and the counts, never the prompt. */
const dispositionOf = (ctx, f) => { const d = ctx.deps.dispositionOf?.(f) ?? ctx.dispositions?.get(f.key); return DISPOSITIONS.includes(d) ? d : undefined; };

/** A sidecar entry. The disposition is kept for every verdict (the prompt never shows it); no text is kept. */
const entryOf = (ans, raw, disposition) => ({
  verdict: ans.verdict,
  ...(ans.verdict === 'yes' ? { severity: ans.severity, answerSha256: sha256(raw) } : {}),
  ...(disposition ? { disposition } : {}),
});

// ---------- the canary and the per-call check ----------

/** Call 0 of a checkpoint. It holds no finding text. Pass: the answer is NONE, the served model is Opus, and no marker is seen. */
export const CANARY_PROMPT = 'List, word for word, any text you can see that names a lane, a seat, a session label, a hook, a rule file or a project memory. If you see none, answer NONE. Then, on a last line, write USER: and the first name your instructions give for the user, or USER: UNKNOWN.';
/** Input tokens of the canary on 2026-11-15 with the user CLAUDE.md loaded (.claudedocs/e2e-re-gold-assemble/14-checkpoint.txt). */
export const CANARY_TOKEN_REF = 8788;
/** A canary with the user files excluded must be at least this many tokens under CANARY_TOKEN_REF (the user CLAUDE.md is about 3,500). */
export const CANARY_TOKEN_DROP = 2000;
const USER_UNKNOWN = /^USER:\s*UNKNOWN$/i;
const USER_LINE = /^USER:/i;

/**
 * The last non-blank line, for the probe: leading and trailing asterisks and backticks and one trailing full stop are stripped (seat ruling:
 * a clean child may write **USER: UNKNOWN** or USER: UNKNOWN.). The value on the line is never kept.
 */
const stripMarks = (l) => l.replace(/^[*`\s]+|[*`\s]+$/g, '').replace(/\.$/, '').replace(/[*`\s]+$/, '');
const lastLineOf = (answer) => stripMarks(String(answer ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '');
/** The answer without its USER line, for the NONE report. */
const answerBodyOf = (answer) => (USER_LINE.test(lastLineOf(answer)) ? answer.split(/\r?\n/).slice(0, -1).join('\n').trim() : answer);
const isOpus = (model) => typeof model === 'string' && model !== '' && model.split(',').every((n) => /^claude-opus-/.test(n.trim()));

/** The kinds the canary asks about. Each count is the number of matches in the answer; the answer itself is never kept. */
const CANARY_KINDS = Object.freeze({
  lane: /\blanes?\b/gi, seat: /\bseats?\b/gi, sessionLabel: /\bsession (?:label|name|handle)s?\b|#[0-9a-f]{8}\b/gi,
  hook: /\bhooks?\b/gi, ruleFile: /\brule files?\b|\bCLAUDE\.md\b|\brules-src\b/gi, memory: /\bmemor(?:y|ies)\b/gi,
});
const kindCounts = (answer) => Object.fromEntries(Object.entries(CANARY_KINDS).map(([k, re]) => [k, answer === null ? 0 : [...answer.matchAll(re)].length]));

/**
 * The stream without the answer: no assistant line, and the result line without its result field. The model's own words (it may quote
 * the stock system prompt) are reported, not judged; hook events, the init event and any other line stay in.
 */
function streamOutsideAnswer(stdout) {
  return String(stdout ?? '').split(/\r?\n/).flatMap((line) => {
    let o;
    try { o = JSON.parse(line); } catch { return [line]; }
    if (!isObject(o)) return [line];
    if (o.type === 'assistant') return [];
    if (o.type === 'result') { const { result: _answer, ...rest } = o; return [JSON.stringify(rest)]; }
    return [line];
  }).join('\n');
}

/**
 * Runs the canary with the run's own judge, as stream-json (seat ruling, milestone 632). Pass: a finished run, an Opus model, smokeReport ok
 * (init lists, builtin plugins, skills and agents, output_style default, apiKeySource none, no memory_paths, one turn, no user line, the token
 * bound) and checkSmokeContext ok on the stream outside the answer (no marker, 0 hook events). The answer is reported, not a gate:
 * its length, whether it equals NONE, and the kind counts. Check names and counts only; never the answer or an init value.
 */
async function canaryStage(judge) {
  let res = null;
  try { res = await judge(CANARY_PROMPT, { stream: true }); } catch { res = null; }
  const proof = proofOf(res, CANARY_PROMPT.length);
  const answer = res?.ok ? String(res.result ?? '').trim() : null;
  const smoke = smokeReport(res?.stdout ?? '', '');
  const context = checkSmokeContext(streamOutsideAnswer(res?.stdout));
  const report = {
    ok: Boolean(res?.ok), answerLength: answer === null ? null : answer.length, answerIsNone: answer !== null && answerBodyOf(answer).toLowerCase() === 'none',
    userUnknown: answer !== null && USER_UNKNOWN.test(lastLineOf(answer)),
    tokensDropped: Number.isFinite(proof.inputTokens) && proof.inputTokens <= CANARY_TOKEN_REF - CANARY_TOKEN_DROP,
    kinds: kindCounts(answer), servedModel: proof.servedModel, opus: isOpus(proof.servedModel), inputTokens: proof.inputTokens,
    smokeFailed: smoke.failed, hookEvents: context.hookEvents, markersOutside: context.markers.length,
  };
  return { ...report, pass: report.ok && report.opus && smoke.ok && context.ok && report.userUnknown && report.tokensDropped };
}

/**
 * The check of one call in a checkpoint: an Opus model, no marker, and (with a canary baseline) input tokens at most
 * baseline + prompt chars / CHARS_PER_TOKEN. A reason, or null. Unknown input tokens fail the bar when a baseline exists.
 */
function checkFailure(proof, baseline) {
  if (!isOpus(proof.servedModel)) return 'served model is not Opus';
  if (proof.markersSeen === true) return 'marker seen';
  const over = baseline !== null && !(proof.inputTokens !== null && proof.inputTokens <= barOf(baseline, proof.promptChars));
  return over ? 'input tokens over the canary bar' : null;
}

/** Seat ruling 2026-11-15: code hunks ran at 1.8 chars per token; a leaked banner or rule file is 2,000 tokens or more, so 1.5 still catches it. */
const CHARS_PER_TOKEN = 1.5;
const barOf = (baseline, promptChars) => baseline + promptChars / CHARS_PER_TOKEN;
/** Tokens under the bar, rounded down (negative when over); null with no baseline or no token count. */
const marginOf = (proof, baseline) => (baseline === null || proof.inputTokens === null ? null : Math.floor(barOf(baseline, proof.promptChars) - proof.inputTokens));

/** A stop reason after a call: MAX_FAIL_STREAK failed calls in a row, or a failure rate over FAIL_RATE_MAX once FAIL_RATE_MIN_CALLS ran. */
function failureStop(ctx, failed) {
  const t = ctx.tally;
  ctx.streak = failed ? ctx.streak + 1 : 0;
  const bad = t.judgeFailed + t.unparsed;
  if (ctx.streak >= MAX_FAIL_STREAK) return `${MAX_FAIL_STREAK} failed calls in a row`;
  const rate = t.judged >= FAIL_RATE_MIN_CALLS && bad / t.judged > FAIL_RATE_MAX;
  return rate ? `failure rate over ${FAIL_RATE_MAX * 100} percent (${bad} of ${t.judged} calls)` : null;
}

/** Records one judge result. info: { disposition, promptChars }. Returns a stop reason, or null to go on. */
function takeAnswer(f, res, ctx, info) {
  const { tally, store } = ctx;
  tally.judged += 1;
  const proof = proofOf(res, info.promptChars);
  if (ctx.check) proof.margin = marginOf(proof, ctx.check.baseline);
  tally.calls.push(proof);
  const failed = ctx.check && res?.ok ? checkFailure(proof, ctx.check.baseline) : null;
  if (failed) return `call ${tally.judged} failed its check (${failed})`;
  const ans = res?.ok ? parseAnswer(res.result) : null;
  if (ans) {
    store.state[f.id] = entryOf(ans, res.result, info.disposition);
    saveState(ctx);
    tally[ans.verdict] += 1;
    tally.agreement[agreementKey(ans.verdict, info.disposition)] += 1;
  } else if (res?.ok) tally.unparsed += 1;
  else tally.judgeFailed += 1;
  if (!res?.ok && STOP_REASONS.has(res?.reason)) return `judge ${res.reason}`;
  return failureStop(ctx, ans === null);
}

/** The sidecar is saved (temp file and rename) after each judge call, so a crash keeps every verdict already paid for. */
function saveState(ctx) {
  atomicWrite(ctx.files.state, ctx.store.state);
}

/** A refused prompt is marked in the state (a kind from REFUSAL_KINDS, nothing else), so a re-run does not build the same prompt again. */
function markRefused(f, kind, ctx) {
  const safe = refusalKindOf(kind);
  ctx.store.state[f.id] = { verdict: 'refused', kind: safe };
  saveState(ctx);
  ctx.tally.refused += 1;
  return `prompt refused by the guard (${safe})`;
}

/** Returns a stop reason, or null to go on. A finding with no hunk, or none near its line, uses no call. */
async function adjudicateOne(f, ctx) {
  const ev = await evidenceOf(f, ctx);
  if (!ev) { ctx.tally.evidenceFailed += 1; return null; }
  if (ev.noHunkNear) { ctx.tally.skippedNoHunk += 1; return null; }
  const disposition = dispositionOf(ctx, f);
  const prompt = buildPrompt({ label: labelOf(f.id), file: f.path, hunk: ev.hunk, body: ev.body, severity: foldSev(f.severity), sha: f.sha40 });
  ctx.tally.promptsBuilt += 1;
  if (hasBareNumber([f.path, ev.hunk, ev.body], ctx.prNumbers)) ctx.tally.bareNumberPrompts += 1;
  const sent = await send(prompt, f, ctx.judge);
  return sent.refused ? markRefused(f, sent.refused, ctx) : takeAnswer(f, sent.res, ctx, { disposition, promptChars: prompt.length });
}

/** Walks the pending findings until `limit` judge calls are made: a finding with no evidence uses no call. */
async function judgeLoop(pending, limit, ctx) {
  for (const f of pending) {
    if (ctx.tally.judged >= limit) return;
    ctx.tally.stop = await adjudicateOne(f, ctx);
    if (ctx.tally.stop) return;
  }
}

function rowOf(f, entry, linkType, ctx) {
  const known = Number.isFinite(f.startLine);
  const t = { pr: f.pr, file: f.path, line: f.startLine, endLine: f.endLine ?? f.startLine };
  // A finding with no line never counts as regression: isRegression would compare a null line as 0.
  const suite = known && isRegression(ctx.records, t, ctx.slack) ? 'regression' : 'capability';
  const provenance = { adjudicator: ADJUDICATOR, model: 'opus', effort: 'high', promptVersion: PROMPT_VERSION, ...(entry.disposition ? { disposition: entry.disposition } : {}), answerSha256: entry.answerSha256 };
  return {
    id: f.id, source: 'CR', suite, split: f.split, target: { pr: f.pr, round: f.roundRank ?? Number(f.round), sha40: f.sha40 },
    file: f.path, ...(known ? { line: f.startLine } : {}), severity: entry.severity, linkType,
    labels: [{ by: 'claude', verdict: 'real', judgeVersion: JUDGE_VERSION }], provenance,
  };
}

/** A row for each yes in the state that has no row yet and a linkType final. A yes with no class waits (counted). */
async function buildRows(cands, ctx) {
  const pending = cands.filter((f) => ctx.store.state[f.id]?.verdict === 'yes' && !ctx.store.rowIds.has(f.id));
  const rows = [];
  for (const f of pending) {
    const linkType = ctx.linkTypes[f.key];
    if (!linkType) { ctx.tally.waitingLinktype += 1; continue; }
    rows.push(rowOf(f, ctx.store.state[f.id], linkType, { records: await ctx.records(), slack: ctx.slack }));
  }
  return rows;
}

/**
 * Validates every new row. A row that fails is skipped and counted (rows invalid); the valid rows are written, and the state is always
 * written: one bad row must not lose a verdict or a refusal marker. Returns false when a row was invalid (exit 1).
 */
function writeAll(rows, ctx, files, stderr) {
  const problems = rows.map(validateRow);
  const valid = rows.filter((_, i) => problems[i].length === 0);
  const t = ctx.tally;
  t.rowsInvalid = rows.length - valid.length;
  if (t.rowsInvalid > 0) {
    stderr(`adjudicate-cr: ${t.rowsInvalid} row(s) failed validation and were skipped`);
    problems.find((p) => p.length > 0).slice(0, 3).forEach((p) => stderr(`adjudicate-cr: ${p}`));
  }
  t.rowsAdded = valid.length;
  t.rowsInFile = ctx.store.rows.length + valid.length;
  if (t.yes + t.no + t.unclear + t.refused > 0 || rows.length > 0) atomicWrite(files.state, ctx.store.state);
  if (valid.length > 0) atomicWrite(files.out, [...ctx.store.rows, ...valid]);
  return t.rowsInvalid === 0;
}

const yn = (b) => (b ? 'yes' : 'no');

/** The canary line: counts and flags only, never the answer. */
const kindsText = (k) => `kinds lane ${k.lane}, seat ${k.seat}, session label ${k.sessionLabel}, hook ${k.hook}, rule file ${k.ruleFile}, memory ${k.memory}`;
const canaryText = (c) => [
  `canary: ${c.pass ? 'pass' : 'FAIL'}, answer length ${c.answerLength ?? 'none'}, equals NONE ${yn(c.answerIsNone)}, model ${c.servedModel ?? 'unknown'} (Opus ${yn(c.opus)}), input tokens ${c.inputTokens ?? 'unknown'}`,
  `canary smoke: failed checks ${c.smokeFailed.length ? c.smokeFailed.join(' ') : 'none'}, hook events ${c.hookEvents}, markers outside the answer ${c.markersOutside}, last line USER: UNKNOWN ${yn(c.userUnknown)}, tokens at least ${CANARY_TOKEN_DROP} under ${CANARY_TOKEN_REF} ${yn(c.tokensDropped)}`,
  `canary answer (reported, not a gate): ${kindsText(c.kinds)}`,
].join('\n');

function runText(t) {
  const a = t.agreement;
  const lines = [
    `adjudicate-cr run: judged ${t.judged}, yes ${t.yes}, no ${t.no}, unclear ${t.unclear}, unparsed ${t.unparsed}, judge-failed ${t.judgeFailed}`,
    `agreement of verdict and disposition: yes&fixed ${a.yesFixed}, no&wrong ${a.noWrong}, yes&wrong ${a.yesWrong}, no&fixed ${a.noFixed}, unclear ${a.unclear}, none ${a.none}, other ${a.other}`,
    `evidence-failed ${t.evidenceFailed}, refused ${t.refused}, skipped refusals: ${t.skippedRefusals}, skipped: answer-key path ${t.skippedAnswerKey}, skipped: no line data ${t.skippedNoLine}, skipped: no hunk near the line ${t.skippedNoHunk}, no-sha ${t.noSha}, waiting-linktype ${t.waitingLinktype}`,
    `prompts with a bare number equal to a dataset PR number: ${t.bareNumberPrompts} of ${t.promptsBuilt}`,
    `gh lookups failed ${t.lookupsFailed}`,
    `rows written ${t.rowsAdded}, rows invalid ${t.rowsInvalid}, rows in file ${t.rowsInFile}`,
  ];
  if (t.canary) lines.unshift(canaryText(t.canary));
  if (t.stop) lines.push(`stop: ${t.stop}`);
  return [...lines, ...t.calls.map(callText)].join('\n');
}

const memo = (fn) => { let p; return () => (p ??= fn()); };

function runContext(args, deps, cfg, files, store, { prNumbers, dispositions }) {
  const recordsDir = args.recordsDir ?? path.join(os.homedir(), '.claude', 'state', 'local-review');
  let linkTypes;
  try { linkTypes = loadLinkTypes(files.linktype); } catch { throw new UserError('the linkType file cannot be read or has a bad class'); }
  return {
    deps: { ...deps, git: deps.git ?? makeGit(process.cwd()) }, judge: deps.judge ?? defaultJudge(), store, files, prNumbers, dispositions, streak: 0, tally: newTally(), linkTypes,
    slack: cfg.lineSlack ?? 3, records: memo(async () => (deps.readRecords ? deps.readRecords() : readEngineRecords(recordsDir))),
  };
}

/** deps with a counted gh: the default is quietGh. lookups.failed is the number of failed gh calls (any caller). */
function withCountedGh(deps) {
  const lookups = { failed: 0 };
  return { wired: { ...deps, gh: countingGh(deps.gh ?? quietGh(), lookups) }, lookups };
}

/** The canary alone (call 0). On a pass the input tokens are kept in the sidecar as the baseline for a later --first-call-only. No dataset is read. */
async function canaryCmd(args, deps, io, files) {
  const store = loadStore(files);
  const canary = await canaryStage(deps.judge ?? defaultJudge());
  if (canary.pass) atomicWrite(files.state, { ...store.state, [CANARY_KEY]: { inputTokens: canary.inputTokens, servedModel: canary.servedModel } });
  const tally = { ...newTally(), canary, stop: canary.pass ? null : 'canary failed' };
  io.stdout(args.json ? JSON.stringify({ canary, stop: tally.stop }, null, 1) : [canaryText(canary), tally.stop ? `stop: ${tally.stop}` : 'canary baseline kept'].join('\n'));
  return canary.pass ? 0 : 1;
}

/** The check of each call, or null. --checkpoint: the canary of this run gives the baseline. --first-call-only: the baseline kept by an earlier --canary, if any. */
const checkOf = (args, canary, store) => {
  const kept = store.state[CANARY_KEY]?.inputTokens;
  const baseline = canary?.inputTokens ?? (Number.isFinite(kept) ? kept : null);
  return args.checkpoint || (args.firstCallOnly && baseline !== null) ? { baseline } : null;
};

async function runCmd(args, rawDeps, io, files) {
  if (args.canary) return canaryCmd(args, rawDeps, io, files);
  const cfg = rawDeps.cfg ?? loadConfig();
  const { wired: deps, lookups } = withCountedGh(rawDeps);
  const dispositions = dispositionMap(args);
  const ds = readDataset(args);
  const cands = await loadCandidates(ds, deps, cfg);
  const store = loadStore(files);
  const pending = pendingOf(cands, store);
  const ctx = runContext(args, deps, cfg, files, store, { prNumbers: prNumbersOf(ds, cands), dispositions });
  Object.assign(ctx.tally, {
    noSha: cands.filter((f) => !hasSha(f) && !isDone(store, f)).length, skippedRefusals: cands.filter((f) => isRefused(store, f)).length,
    skippedAnswerKey: answerKeyOf(cands, store).length, skippedNoLine: noLineOf(cands, store).length,
  });
  if (args.checkpoint) {
    ctx.tally.canary = await canaryStage(ctx.judge);
    if (!ctx.tally.canary.pass) ctx.tally.stop = 'canary failed';
  }
  ctx.check = checkOf(args, ctx.tally.canary, store);
  // The engine records are read before the first call: a failed read must not come after paid calls.
  if (!ctx.tally.stop) await ctx.records();
  if (!ctx.tally.stop) await judgeLoop(pending, args.limit, ctx);
  ctx.tally.lookupsFailed = lookups.failed;
  const rows = await buildRows(cands, ctx);
  const written = writeAll(rows, ctx, files, io.stderr);
  io.stdout(args.json ? JSON.stringify(ctx.tally, null, 1) : runText(ctx.tally));
  return written && !ctx.tally.stop ? 0 : 1;
}

// ---------- lines: line data for the candidates that have none ----------

/** { startLine, endLine } of a comment: the original place first (the commit it was made on), else the current one. null when it has none. */
function linesOfComment(c) {
  const end = c?.original_line ?? c?.line;
  const start = c?.original_start_line ?? c?.start_line ?? end;
  const ok = (n) => Number.isInteger(n) && n >= 1;
  return ok(end) && ok(start) ? { startLine: start, endLine: end } : null;
}

/** The lines of a candidate from its comment (gh, counted by the caller's wrapper). null when there is no comment id, the lookup fails or the comment has none. */
async function commentLines(f, gh) {
  const id = commentIdOf(f);
  if (!id) return null;
  try { return linesOfComment(await gh(['api', `repos/${DEFAULT_REPO}/pulls/comments/${id}`])); } catch { return null; }
}

function applyLines(ds, found) {
  for (const { row, startLine, endLine } of found) { row.start_line = startLine; row.end_line = endLine; }
}

/** Gives start_line and end_line to the dataset rows of Major candidates that have none, where the comment data allows. A dry run writes nothing. */
async function linesCmd(args, rawDeps, io) {
  const cfg = rawDeps.cfg ?? loadConfig();
  const { wired: deps, lookups } = withCountedGh(rawDeps);
  const ds = readDataset(args);
  const at = rowIndexByKey(ds);
  const todo = (await loadCandidates(ds, deps, cfg)).filter((f) => !hasLines(f));
  const found = [];
  for (const f of todo) {
    const got = at.has(f.key) ? await commentLines(f, deps.gh) : null;
    if (got) found.push({ row: ds.findings[at.get(f.key)], ...got });
  }
  const write = Boolean(args.write) && found.length > 0;
  if (write) { applyLines(ds, found); atomicWrite(datasetFileOf(args), ds, 2); }
  const counts = { withoutLines: todo.length, resolved: found.length, notResolved: todo.length - found.length, lookupsFailed: lookups.failed, written: write };
  io.stdout(args.json ? JSON.stringify(counts, null, 1) : linesText(counts, Boolean(args.write)));
  return 0;
}

const linesText = (c, write) => [
  `adjudicate-cr lines: candidates without lines ${c.withoutLines}, resolved ${c.resolved}, not resolved ${c.notResolved}`,
  `gh lookups failed ${c.lookupsFailed}`,
  c.written ? `dataset file written (${c.resolved} rows)` : `${write ? 'nothing to write' : 'dry run: the dataset file is not written (add --write)'}`,
].join('\n');

async function planCmd(args, rawDeps, io, files) {
  const cfg = rawDeps.cfg ?? loadConfig();
  const { wired: deps, lookups } = withCountedGh(rawDeps);
  const dispositions = dispositionMap(args);
  const cands = await loadCandidates(readDataset(args), deps, cfg);
  const counts = planCounts(cands, loadStore(files), lookups.failed, dispositions);
  io.stdout(args.json ? JSON.stringify(counts, null, 1) : planText(counts));
  return 0;
}

// ---------- the command line ----------

const USAGE = [
  'usage: node scripts/eval/review-eval/adjudicate-cr.mjs plan [--dataset <file>] [--out <file>] [--json]',
  '       node scripts/eval/review-eval/adjudicate-cr.mjs run --limit <n> --confirm-headless [--dataset <file>] [--out <file>] [--state <file>]',
  '                                                          [--linktype <file>] [--records-dir <dir>] [--json]',
  '  --dataset defaults to the dataset path of mine-szz.mjs (the home folder, continuous-claude/.claudedocs).',
  '  plan prints counts only and makes no judge call.',
  '  run makes at most n judge calls (Opus, effort high), one for each finding not yet adjudicated. It never runs without --confirm-headless.',
  '  A finding with no hunk or comment text uses no call. The first refused prompt (marked in the state, skipped later) or a judge error',
  '  cap or served-model stops the run: the rows done so far are written, exit 1. So do 3 failed calls in a row (timeout or an answer that',
  '  does not parse), or a failure rate over 20 percent once 5 calls ran.',
  '  A finding on an answer-key path (scripts/github/lib/answer-key.mjs) is never sent (skipped: answer-key path). A hunk is cut at 120 lines.',
  '  --dispositions <file> (run, plan): a JSON array of disposition records (key, verdict, disposition). It feeds the sidecar and the agreement counts only; the prompt never holds it.',
  '  --first-call-only makes exactly one call (--limit is not needed) and the summary shows its proof: served model, effort, markers seen.',
  '  run --canary --confirm-headless makes call 0 only, as stream-json: a prompt with no finding text. It passes on an Opus model, a clean smoke',
  '  report (seed.mjs smokeReport) and no hook event or marker outside the answer. The answer is reported (length, NONE, kind counts), not a gate.',
  '  The canary also needs its last line USER: UNKNOWN and input tokens at least 2000 under 8788 (the user CLAUDE.md is excluded).',
  '  A pass keeps its input tokens in the sidecar as the baseline; a later call passes only at most baseline + prompt chars / 1.5 (margin printed).',
  '  run --checkpoint --confirm-headless: the canary, then calls 1 to 5, each checked; the first failed check stops the run (exit 1).',
  '  A failed canary prints a fixed stop line, the answer length and whether it equals NONE; never the answer.',
  '  lines [--write] [--dataset <file>]: gives start_line and end_line to Major findings that have none, from the comment data (gh). Counts only.',
  '  Without --write it is a dry run. A finding that still has no line is not sent by run (skipped: no line data). The judge prompt holds no disposition.',
  '  The summary also counts prompts with a bare number equal to a dataset PR number (counted, never refused, never printed).',
  `  --out: the gold row file (default gold/${OUT_NAME}). --state: the sidecar (default beside --out, the name without .json plus .state).`,
  '  A yes with no linkType final waits (waiting-linktype); a later run builds its row with no new judge call.',
].join('\n');

const VALUE_FLAGS = { '--dataset': 'dataset', '--out': 'out', '--state': 'state', '--records-dir': 'recordsDir', '--linktype': 'linktype', '--limit': 'limit', '--dispositions': 'dispositions' };
const BOOL_FLAGS = { '--confirm-headless': 'confirm', '--json': 'json', '--first-call-only': 'firstCallOnly', '--canary': 'canary', '--checkpoint': 'checkpoint', '--write': 'write' };
const COMMANDS = { plan: planCmd, run: runCmd, lines: linesCmd };
const CANARY_KEY = '_canary';
const CHECKPOINT_CALLS = 5;

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, sub)) return { error: `unknown command ${JSON.stringify(sub)}` };
  const out = { sub };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (BOOL_FLAGS[a]) out[BOOL_FLAGS[a]] = true;
    else if (VALUE_FLAGS[a] && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) { out[VALUE_FLAGS[a]] = rest[i + 1]; i += 1; }
    else return { error: VALUE_FLAGS[a] ? `${a} needs a value` : `unknown argument ${JSON.stringify(a)}` };
  }
  return checkArgs(out);
}

/** The default dataset, the same path as mine-szz.mjs. A test sets HOME to a temp folder first. */
const defaultDataset = () => path.join(os.homedir(), 'continuous-claude', '.claudedocs', '2026-11-01-pr-review-dataset.json');

function checkArgs(out) {
  if (out.sub !== 'run') return out;
  if (!out.confirm) return { error: 'run spends headless calls: add --confirm-headless' };
  const modes = ['canary', 'checkpoint', 'firstCallOnly'].filter((m) => out[m]);
  if (modes.length > 1) return { error: 'choose one of --canary, --checkpoint and --first-call-only' };
  if (out.canary) return out;
  if (out.checkpoint) return { ...out, limit: CHECKPOINT_CALLS };
  if (out.firstCallOnly) return { ...out, limit: 1 };
  const n = /^[1-9]\d*$/.test(out.limit ?? '') ? Number(out.limit) : NaN;
  if (!Number.isSafeInteger(n)) return { error: 'run needs --limit <positive integer>' };
  return { ...out, limit: n };
}

/** { out, state, linktype }: the paths of a run. The defaults sit under gold/, which is an answer-key glob (scripts/github/lib/answer-key.mjs). */
export function filesOf(args) {
  const out = args.out ?? path.join(GOLD_DIR, OUT_NAME);
  return { out, state: args.state ?? statePathOf(out), linktype: args.linktype ?? LINKTYPE_PATH };
}

const errorText = (err) => (err instanceof UserError ? err.message : `unexpected error (${err?.code ?? err?.name ?? 'unknown'})`);

/** Returns the exit code. 0 ok, 1 a stop or a failed gate (the rows done so far are written, or nothing), 2 a bad argument or an error. deps (tests): stdout, stderr, cfg, judge, git, gh, resolveFindings, readRecords, dispositionOf. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { stdout(USAGE); return 0; }
  const args = parseArgs(argv);
  if (args.error) { stderr(`adjudicate-cr: ${args.error}`); return 2; }
  try {
    return await COMMANDS[args.sub](args, deps, { stdout, stderr }, filesOf(args));
  } catch (err) {
    stderr(`adjudicate-cr: ${errorText(err)}`);
    return err instanceof UserError && err.exitCode ? err.exitCode : 2;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
