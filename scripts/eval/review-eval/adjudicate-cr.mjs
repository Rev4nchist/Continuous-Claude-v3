#!/usr/bin/env node
// adjudicate-cr.mjs: turns CodeRabbit dataset findings (Major or higher) into Gold CR rows.
//   plan [--dataset F] [--json]          counts only: candidates by split, adjudicated, with lines, file only, no sha. No judge call.
//   run --limit N --confirm-headless     one judge call (Opus, effort high) for each of the next N findings not yet adjudicated.
//   void-marked [--dataset F] [--json]   no judge call: deletes the verdict and the row of a finding whose live comment holds a fix marker.
// A prompt holds a neutral index, the file, the diff hunk of the round, the comment text and its severity. It never holds the outcome:
// the comment text loses its HTML comment blocks and every "Addressed in commit" line, and is scrubbed of PR references and github links.
// The whole prompt is guarded before the call: a PR reference, a fix sha prefix, any 40-hex sha, a github url, the comment id, the finding
// key, or a fix marker (an outcome word in the comment text, a check mark or "addressed in commit" anywhere) refuses it. A refused prompt is
// never sent and never retried; it is marked and the run goes on, and 3 refusals in one run stop it.
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

// v2 (seat ruling, 2026-11-15): ten lines of context, and the cumulative PR diff when the round commit does not change the path.
// v3 (seat ruling, 2026-11-15): the live comment body carries marker lines ("Addressed in commit ...") that leak the outcome. They and the
// HTML comment blocks are stripped, and a prompt that still holds a fix marker is refused.
export const PROMPT_VERSION = 'adjudicate-cr-v3';
export const JUDGE_VERSION = 'adjudicate-cr-v3';
/** The version of a state entry with no promptVersion field: every entry written before v2. */
const LEGACY_VERSION = 'adjudicate-cr-v1';
const versionOf = (entry) => entry?.promptVersion ?? LEGACY_VERSION;
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
 * The outcome words (seat ruling 2026-11-15). OUTCOME_WORDS_RE is tested on the comment text after the strip; MARKER_FORMS_RE on the whole
 * raw prompt, hunk and fences included, so the plain words are never tested on code. Each is one line to change. No g flag (.test keeps state).
 */
export const OUTCOME_WORDS_RE = /addressed in commits?|\baddressed\b|\bresolved\b|\bfixed in\b|\boutdated\b|[✅✔☑]/i;
export const MARKER_FORMS_RE = /addressed in commits?|[✅✔☑]/i;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** An HTML comment with no end runs to the end of the text (seat ruling 2026-11-15): all of it is hidden text. */
const OPEN_COMMENT = /<!--[\s\S]*$/;
const MARKED_LINE = /addressed in commits?/i;

/**
 * The comment body without the bot metadata and without the fix marker CodeRabbit appends after a fix: every HTML comment block, then every
 * line with "addressed in commit(s)" in any case (wider than parseMarker of dispositions.mjs, which reads the exact marker line only).
 * { text, lines, blocks }: the counts are of what was dropped.
 */
export function stripBody(body) {
  const raw = String(body ?? '');
  const closed = raw.replace(HTML_COMMENT, '');
  const noHtml = closed.replace(OPEN_COMMENT, '');
  const all = noHtml.split(/\r?\n/);
  const kept = all.filter((l) => !MARKED_LINE.test(l));
  const blocks = (raw.match(HTML_COMMENT) ?? []).length + (noHtml === closed ? 0 : 1);
  return { text: kept.join('\n'), lines: all.length - kept.length, blocks };
}

/**
 * The judge prompt of one finding. Only the comment text is stripped and scrubbed; the whole prompt is guarded before the call (send).
 * The judge is blind: the prompt never holds what happened to the finding (a disposition or a fix marker). That word stays in the sidecar.
 * label: the first 8 hex of the id hash (labelOf). It is the same in every run, so a re-run sends the same text for the same finding.
 */
export function buildPrompt({ label, file, hunk, body, severity, sha }) {
  const lines = [INSTRUCTIONS, '', `### Finding ${label}`, `File: ${file}`, `Reviewer severity: ${severity}`];
  lines.push('Diff hunk at the reviewed round:', hunk, 'Reviewer comment:', cleanBody(stripBody(body).text));
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
 * finding-key) and outcomeGuard (fix-marker). A kind outside the list is written as 'other'. A kind is never free text and never holds a number.
 */
export const REFUSAL_KINDS = Object.freeze(['pr-number', 'fix-title', 'fix-sha', 'sha', 'repo-url', 'pr-term', 'comment-id', 'finding-key', 'fix-marker', 'other']);
export const refusalKindOf = (kind) => (REFUSAL_KINDS.includes(kind) ? kind : 'other');

/** 'fix-marker' when the whole raw prompt holds a marker form, or the comment text (after the strip and scrub) holds an outcome word. Else null. */
const outcomeGuard = (prompt, comment) => (MARKER_FORMS_RE.test(prompt) || OUTCOME_WORDS_RE.test(comment) ? 'fix-marker' : null);

/** { refused: kind } with the judge not called, or { res } (null on a throw). outcomeGuard, the mine-szz guard, then extraGuard. A kind never holds a number. */
async function send(prompt, f, judge, comment) {
  const leak = leakTerms([f.sha40], []);
  const refused = outcomeGuard(prompt, comment) ?? promptGuard(prompt, leak) ?? extraGuard(prompt, f);
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

/** An unclear of an older prompt version is no verdict: it is pending again under the current version. A yes, no or refusal stays done. */
const isStaleUnclear = (entry) => entry?.verdict === 'unclear' && versionOf(entry) !== PROMPT_VERSION;
const isDone = (store, f) => store.rowIds.has(f.id) || (Object.hasOwn(store.state, f.id) && !isStaleUnclear(store.state[f.id]));
const isRefused = (store, f) => store.state[f.id]?.verdict === 'refused';
/** Two calls gave no strict JSON answer: the entry has no text and, like a refusal, ends the asking (a later run skips it). */
const isUnparsed = (store, f) => store.state[f.id]?.verdict === 'unparsed';
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
  const unparsed = cands.filter((f) => isUnparsed(store, f)).length;
  const pending = pendingOf(cands, store);
  return {
    candidates: cands.length, bySplit: splitCounts(cands), adjudicated: cands.filter((f) => isDone(store, f)).length - refused - unparsed, refused, unparsed,
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
    `adjudicated ${c.adjudicated}, refused ${c.refused}, unparsed ${c.unparsed}, skipped: answer-key path ${c.answerKeySkipped}, skipped: no line data ${c.noLineSkipped}, pending ${c.pending}`,
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
const NO_ROUND_DIFF = Symbol('no diff in the round commit');
/** Lines of context around each change (seat F2). The 120-line cap and the cut mark still apply. */
const CONTEXT_LINES = 10;

/** The diff text from its first @@ line (the header holds hex runs), or null when the read failed or holds no hunk. */
const fromFirstHunk = (r) => {
  const at = r.status === 0 ? /^@@/m.exec(r.stdout) : null;
  return at ? r.stdout.slice(at.index) : null;
};

/**
 * The diff of the file the reviewer saw at the round, cut near the finding. First the round commit (git show). When it does not change
 * the path, the cumulative PR diff of the path: git diff <base>...<round sha> (merge-base form, seat F1). Every range ends at the round
 * sha, so the judge never sees code after the round (the fix). No base or no diff: NO_ROUND_DIFF. NO_HUNK_NEAR when no hunk is near the line.
 */
async function hunkOf(f, git, slack, baseOf) {
  const round = fromFirstHunk(await git(['show', '--format=', `--unified=${CONTEXT_LINES}`, f.sha40, '--', f.path]));
  const roundNear = round === null ? '' : hunksNear(round, f, slack);
  if (roundNear !== '') return capHunk(roundNear);
  // The round commit does not change the path, or changes it far from the line (seat ruling 18:08): the cumulative diff of the PR.
  // Its new-side line numbers are the file at the round sha, so the near pick holds.
  const miss = round === null ? NO_ROUND_DIFF : NO_HUNK_NEAR;
  const base = await baseOf(f);
  if (!SHA40.test(String(base ?? ''))) return miss;
  const cumulative = fromFirstHunk(await git(['diff', `--unified=${CONTEXT_LINES}`, `${base}...${f.sha40}`, '--', f.path]));
  if (cumulative === null) return miss;
  const near = hunksNear(cumulative, f, slack);
  return near === '' ? NO_HUNK_NEAR : capHunk(near);
}

/** The base sha of the finding's PR (gh pulls read, quiet caller), once per PR. A failed read is counted by countingGh and gives null. */
function baseReader(gh) {
  const memo = new Map();
  return (f) => {
    if (!memo.has(f.pr)) memo.set(f.pr, Promise.resolve().then(() => gh(['api', `repos/${DEFAULT_REPO}/pulls/${f.pr}`])).then((p) => p?.base?.sha ?? null, () => null));
    return memo.get(f.pr);
  };
}

/** At most HUNK_MAX_LINES lines and HUNK_LIMIT characters. A cut hunk ends with a cut mark, so the judge knows it is partial. */
export function capHunk(text) {
  const lines = text.split('\n');
  const byLines = lines.length > HUNK_MAX_LINES ? `${lines.slice(0, HUNK_MAX_LINES).join('\n')}\n[hunk cut at ${HUNK_MAX_LINES} lines]` : text;
  return byLines.length > HUNK_LIMIT ? `${byLines.slice(0, HUNK_LIMIT)}\n[hunk cut at ${HUNK_LIMIT} characters]` : byLines;
}

/** The live comment body, trimmed and not cut: '' when it has none, null when the finding has no comment id. A failed read throws. */
async function rawBodyOf(f, gh) {
  const id = commentIdOf(f);
  if (!id) return null;
  const c = await gh(['api', `repos/${DEFAULT_REPO}/pulls/comments/${id}`]);
  return typeof c?.body === 'string' ? c.body.trim() : '';
}

/**
 * The comment text the judge may see: the whole raw body is stripped first, then cut to BODY_LIMIT (seat ruling 2026-11-15). A cut
 * before the strip could open a hidden block with no end, and the hidden blocks would use up the limit before the reviewer text.
 * { text, lines, blocks } (the strip counts), or null when no text is left.
 */
async function bodyOf(f, gh) {
  const raw = await rawBodyOf(f, gh);
  if (!raw) return null;
  const s = stripBody(raw);
  const text = s.text.trim().slice(0, BODY_LIMIT);
  return text ? { text, lines: s.lines, blocks: s.blocks } : null;
}

/**
 * { hunk, body: { text, lines, blocks } } (the body already stripped and cut, bodyOf), { noHunkNear: true }, { noRoundDiff: true },
 * or null when the path, the hunk or the comment text is missing or a read fails (no judge call in any of these).
 */
async function evidenceOf(f, ctx) {
  const { deps, slack } = ctx;
  if (typeof f.path !== 'string' || f.path === '') return null;
  ctx.baseOf ??= baseReader(deps.gh);
  try {
    const hunk = await hunkOf(f, deps.git, slack, ctx.baseOf);
    if (hunk === NO_HUNK_NEAR) return { noHunkNear: true };
    if (hunk === NO_ROUND_DIFF) return { noRoundDiff: true };
    const body = hunk ? await bodyOf(f, deps.gh) : null;
    return hunk && body ? { hunk, body } : null;
  } catch { return null; }
}

// ---------- the run ----------

const newTally = () => ({
  judged: 0, yes: 0, no: 0, unclear: 0, unparsed: 0, retried: 0, linesStripped: 0, htmlBlocksStripped: 0, judgeFailed: 0, evidenceFailed: 0, refused: 0, refusedKinds: {}, skippedRefusals: 0, skippedAnswerKey: 0, skippedNoLine: 0, skippedNoHunk: 0, skippedNoRoundDiff: 0, noSha: 0,
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
  verdict: ans.verdict, promptVersion: PROMPT_VERSION,
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

/**
 * Records one judge call: counts it, keeps its proof and runs its check (every mode, seat ruling 2026-11-15).
 * { stop } after a failed check, else { ans }: the parsed answer, or null for a failed call or an answer that does not parse.
 */
function recordCall(res, ctx, promptChars) {
  const { tally } = ctx;
  tally.judged += 1;
  const proof = proofOf(res, promptChars);
  if (ctx.check) proof.margin = marginOf(proof, ctx.check.baseline);
  tally.calls.push(proof);
  const failed = ctx.check && res?.ok ? checkFailure(proof, ctx.check.baseline) : null;
  if (failed) return { stop: `call ${tally.judged} failed its check (${failed})` };
  return { ans: res?.ok ? parseAnswer(res.result) : null };
}

/**
 * Settles a finding after its last call. info: { disposition, retried }. A verdict is stored. An answer that did not parse twice is stored
 * as { verdict: 'unparsed' } with no text, so a later run does not ask again. Returns a stop reason, or null to go on.
 * A checkpoint stops at any call with no verdict (a failed call, a timeout or an unparsed answer).
 */
function settle(f, res, ans, ctx, info) {
  const { tally, store } = ctx;
  if (ans) {
    store.state[f.id] = entryOf(ans, res.result, info.disposition);
    tally[ans.verdict] += 1;
    tally.agreement[agreementKey(ans.verdict, info.disposition)] += 1;
    saveState(ctx);
  } else if (res?.ok) {
    tally.unparsed += 1;
    if (info.retried) { store.state[f.id] = { verdict: 'unparsed', promptVersion: PROMPT_VERSION }; saveState(ctx); }
  } else tally.judgeFailed += 1;
  if (!res?.ok && STOP_REASONS.has(res?.reason)) return `judge ${res.reason}`;
  if (ctx.checkpoint && ans === null) return `call ${tally.judged} gave no verdict`;
  return failureStop(ctx, ans === null);
}

/**
 * The call or calls of one finding. ask() sends the same guarded prompt. An answer that does not parse is asked once more at once (one more
 * call, kept inside --limit; never in a checkpoint, which stops on it). info: { disposition, promptChars }. Returns a stop reason, or null.
 */
async function askJudge(f, ask, ctx, info) {
  let sent = await ask();
  if (sent.refused) return markRefused(f, sent.refused, ctx);
  let call = recordCall(sent.res, ctx, info.promptChars);
  if (call.stop) return call.stop;
  const retried = Boolean(sent.res?.ok) && call.ans === null && !ctx.checkpoint && ctx.tally.judged < ctx.limit;
  if (retried) {
    ctx.tally.retried += 1;
    sent = await ask();
    call = recordCall(sent.res, ctx, info.promptChars);
    if (call.stop) return call.stop;
  }
  return settle(f, sent.res, call.ans, ctx, { disposition: info.disposition, retried });
}

/** The sidecar is saved (temp file and rename) after each judge call, so a crash keeps every verdict already paid for. */
function saveState(ctx) {
  atomicWrite(ctx.files.state, ctx.store.state);
}

/** The run stops at this many refusals (seat ruling 18:08 CST: one refusal no longer stops a run; the prompt is never sent). */
const MAX_REFUSALS = 3;

/**
 * A refused prompt is marked in the state (a kind from REFUSAL_KINDS, nothing else), so a re-run does not build the same prompt again.
 * The prompt is never sent, so the run goes on; MAX_REFUSALS in one run is a stop.
 */
function markRefused(f, kind, ctx) {
  const safe = refusalKindOf(kind);
  ctx.store.state[f.id] = { verdict: 'refused', kind: safe };
  saveState(ctx);
  ctx.tally.refused += 1;
  ctx.tally.refusedKinds[safe] = (ctx.tally.refusedKinds[safe] ?? 0) + 1;
  return ctx.tally.refused >= MAX_REFUSALS ? `${MAX_REFUSALS} prompts refused by the guard` : null;
}

/** Returns a stop reason, or null to go on. A finding with no hunk, or none near its line, uses no call. */
async function adjudicateOne(f, ctx) {
  const ev = await evidenceOf(f, ctx);
  if (!ev) { ctx.tally.evidenceFailed += 1; return null; }
  if (ev.noHunkNear) { ctx.tally.skippedNoHunk += 1; return null; }
  if (ev.noRoundDiff) { ctx.tally.skippedNoRoundDiff += 1; return null; }
  const disposition = dispositionOf(ctx, f);
  // ev.body.text is stripped already; buildPrompt strips again, which changes nothing on stripped text.
  const prompt = buildPrompt({ label: labelOf(f.id), file: f.path, hunk: ev.hunk, body: ev.body.text, severity: foldSev(f.severity), sha: f.sha40 });
  Object.assign(ctx.tally, { promptsBuilt: ctx.tally.promptsBuilt + 1, linesStripped: ctx.tally.linesStripped + ev.body.lines, htmlBlocksStripped: ctx.tally.htmlBlocksStripped + ev.body.blocks });
  if (hasBareNumber([f.path, ev.hunk, ev.body.text], ctx.prNumbers)) ctx.tally.bareNumberPrompts += 1;
  const comment = cleanBody(ev.body.text);
  return askJudge(f, () => send(prompt, f, ctx.judge, comment), ctx, { disposition, promptChars: prompt.length });
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
  // The versions of the answer, not of this run: a v1 yes that waited for its linkType keeps v1 (prompt and judge versions move together).
  const provenance = { adjudicator: ADJUDICATOR, model: 'opus', effort: 'high', promptVersion: versionOf(entry), ...(entry.disposition ? { disposition: entry.disposition } : {}), answerSha256: entry.answerSha256 };
  return {
    id: f.id, source: 'CR', suite, split: f.split, target: { pr: f.pr, round: f.roundRank ?? Number(f.round), sha40: f.sha40 },
    file: f.path, ...(known ? { line: f.startLine } : {}), severity: entry.severity, linkType,
    labels: [{ by: 'claude', verdict: 'real', judgeVersion: versionOf(entry) }], provenance,
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
    `adjudicate-cr run: judged ${t.judged}, yes ${t.yes}, no ${t.no}, unclear ${t.unclear}, unparsed ${t.unparsed}, retried ${t.retried}, judge-failed ${t.judgeFailed}`,
    `agreement of verdict and disposition: yes&fixed ${a.yesFixed}, no&wrong ${a.noWrong}, yes&wrong ${a.yesWrong}, no&fixed ${a.noFixed}, unclear ${a.unclear}, none ${a.none}, other ${a.other}`,
    `evidence-failed ${t.evidenceFailed}, refused ${t.refused}${t.refused ? ` (kinds ${Object.entries(t.refusedKinds).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}, skipped refusals: ${t.skippedRefusals}, skipped: answer-key path ${t.skippedAnswerKey}, skipped: no line data ${t.skippedNoLine}, skipped: no hunk near the line ${t.skippedNoHunk}, skipped: no diff in the round commit ${t.skippedNoRoundDiff}, no-sha ${t.noSha}, waiting-linktype ${t.waitingLinktype}`,
    `comment text: lines stripped ${t.linesStripped}, HTML blocks stripped ${t.htmlBlocksStripped}`,
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
    limit: args.limit, checkpoint: Boolean(args.checkpoint),
    slack: cfg.lineSlack ?? 3, records: memo(async () => (deps.readRecords ? deps.readRecords() : readEngineRecords(recordsDir))),
  };
}

/** deps with a counted gh: the default is quietGh. lookups.failed is the number of failed gh calls (any caller). */
function withCountedGh(deps) {
  const lookups = { failed: 0 };
  return { wired: { ...deps, gh: countingGh(deps.gh ?? quietGh(), lookups) }, lookups };
}

/** Deletes the kept baseline after a failed canary, so a later run cannot lean on a stale one. Writes only when there was one. */
function dropBaseline(store, files) {
  if (!Object.hasOwn(store.state, CANARY_KEY)) return;
  delete store.state[CANARY_KEY];
  atomicWrite(files.state, store.state);
}

/**
 * The canary alone (call 0). On a pass the input tokens are kept in the sidecar, with the prompt version, as the baseline of every later
 * call (a run needs one for its version). A fail deletes the kept baseline. No dataset is read.
 */
async function canaryCmd(args, deps, io, files) {
  const store = loadStore(files);
  const canary = await canaryStage(deps.judge ?? defaultJudge());
  if (canary.pass) atomicWrite(files.state, { ...store.state, [CANARY_KEY]: { inputTokens: canary.inputTokens, servedModel: canary.servedModel, promptVersion: PROMPT_VERSION } });
  else dropBaseline(store, files);
  const tally = { ...newTally(), canary, stop: canary.pass ? null : 'canary failed' };
  io.stdout(args.json ? JSON.stringify({ canary, stop: tally.stop }, null, 1) : [canaryText(canary), tally.stop ? `stop: ${tally.stop}` : 'canary baseline kept'].join('\n'));
  return canary.pass ? 0 : 1;
}

/** The kept baseline (input tokens) when it is for the current prompt version, else null. */
function keptBaseline(store) {
  const kept = store.state[CANARY_KEY];
  return kept?.promptVersion === PROMPT_VERSION && Number.isFinite(kept.inputTokens) ? kept.inputTokens : null;
}

/** A run with calls and no --checkpoint needs the baseline kept by `run --canary` for this prompt version. Fixed message, exit 2, before any call. */
function requireBaseline(args, store) {
  if (args.checkpoint || keptBaseline(store) !== null) return;
  throw new UserError(`no canary baseline for ${PROMPT_VERSION}: run \`run --canary --confirm-headless\` first`);
}

/** The check of each call, in every mode. --checkpoint: the canary of this run gives the baseline. Else the baseline kept by `run --canary`. */
const checkOf = (args, canary, store) => ({ baseline: args.checkpoint ? canary.inputTokens : keptBaseline(store) });

async function runCmd(args, rawDeps, io, files) {
  if (args.canary) return canaryCmd(args, rawDeps, io, files);
  const cfg = rawDeps.cfg ?? loadConfig();
  const { wired: deps, lookups } = withCountedGh(rawDeps);
  const dispositions = dispositionMap(args);
  const store = loadStore(files);
  requireBaseline(args, store);
  const ds = readDataset(args);
  const cands = await loadCandidates(ds, deps, cfg);
  const pending = pendingOf(cands, store);
  const ctx = runContext(args, deps, cfg, files, store, { prNumbers: prNumbersOf(ds, cands), dispositions });
  Object.assign(ctx.tally, {
    noSha: cands.filter((f) => !hasSha(f) && !isDone(store, f)).length, skippedRefusals: cands.filter((f) => isRefused(store, f)).length,
    skippedAnswerKey: answerKeyOf(cands, store).length, skippedNoLine: noLineOf(cands, store).length,
  });
  if (args.checkpoint) {
    ctx.tally.canary = await canaryStage(ctx.judge);
    if (!ctx.tally.canary.pass) { ctx.tally.stop = 'canary failed'; dropBaseline(store, files); }
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

// ---------- void-marked: a verdict made on a prompt whose live comment holds a fix marker ----------

const VOIDABLE = ['yes', 'no', 'unclear'];
const verdictOfId = (store, id) => (VOIDABLE.includes(store.state[id]?.verdict) ? store.state[id].verdict : 'yes');

/** The ids to read: every yes, no or unclear of the state, and every row of the output file (so a half-finished void heals on a re-run). */
const voidIdsOf = (store) => new Set([
  ...Object.keys(store.state).filter((id) => VOIDABLE.includes(store.state[id]?.verdict)),
  ...store.rows.map((r) => r?.id).filter((id) => typeof id === 'string'),
]);

/**
 * 'marked', 'clean' or 'unread'. The whole live body is read (bodyOf cuts at BODY_LIMIT and the marker comes last). A finding that is no
 * longer a candidate, a failed read and an empty body are 'unread': the verdict stays. /addressed in commits?/i covers what parseMarker reads.
 */
async function markOf(f, gh) {
  try {
    const body = f ? await rawBodyOf(f, gh) : null;
    if (!body) return 'unread';
    return MARKED_LINE.test(body) ? 'marked' : 'clean';
  } catch { return 'unread'; }
}

/** Deletes the state entry (a yes, no or unclear) and the row of every id in `gone`. Writes a file only when it changed. Returns the rows removed. */
function applyVoid(store, files, gone) {
  const entries = [...gone].filter((id) => VOIDABLE.includes(store.state[id]?.verdict));
  entries.forEach((id) => { delete store.state[id]; });
  const rows = store.rows.filter((r) => !gone.has(r?.id));
  if (entries.length > 0) atomicWrite(files.state, store.state);
  if (rows.length !== store.rows.length) atomicWrite(files.out, rows);
  return store.rows.length - rows.length;
}

const voidText = (c) => `void-marked: checked ${c.checked}, voided ${c.voided} (yes ${c.yes}, no ${c.no}, unclear ${c.unclear}), rows removed ${c.rowsRemoved}, not checked ${c.notChecked}, clean ${c.clean}`;

/** No judge call, counts only. Exit 1 when a body could not be read (not checked above 0): that verdict stays and a re-run reads it again. */
async function voidMarkedCmd(args, rawDeps, io, files) {
  const cfg = rawDeps.cfg ?? loadConfig();
  const { wired: deps } = withCountedGh(rawDeps);
  const byId = new Map((await loadCandidates(readDataset(args), deps, cfg)).map((f) => [f.id, f]));
  const store = loadStore(files);
  const c = { checked: 0, voided: 0, yes: 0, no: 0, unclear: 0, rowsRemoved: 0, notChecked: 0, clean: 0 };
  const gone = new Set();
  for (const id of voidIdsOf(store)) {
    const mark = await markOf(byId.get(id), deps.gh);
    if (mark === 'unread') { c.notChecked += 1; continue; }
    c.checked += 1;
    if (mark === 'clean') { c.clean += 1; continue; }
    gone.add(id);
    c.voided += 1;
    c[verdictOfId(store, id)] += 1;
  }
  c.rowsRemoved = applyVoid(store, files, gone);
  io.stdout(args.json ? JSON.stringify(c, null, 1) : voidText(c));
  return c.notChecked > 0 ? 1 : 0;
}

// ---------- the command line ----------

const USAGE = [
  'usage: node scripts/eval/review-eval/adjudicate-cr.mjs plan [--dataset <file>] [--out <file>] [--json]',
  '       node scripts/eval/review-eval/adjudicate-cr.mjs void-marked [--dataset <file>] [--out <file>] [--state <file>] [--json]',
  '       node scripts/eval/review-eval/adjudicate-cr.mjs run --limit <n> --confirm-headless [--dataset <file>] [--out <file>] [--state <file>]',
  '                                                          [--linktype <file>] [--records-dir <dir>] [--json]',
  '  --dataset defaults to the dataset path of mine-szz.mjs (the home folder, continuous-claude/.claudedocs).',
  '  plan prints counts only and makes no judge call.',
  '  run makes at most n judge calls (Opus, effort high), one for each finding not yet adjudicated. It never runs without --confirm-headless.',
  '  A finding with no hunk or comment text uses no call. A refused prompt is never sent: it is marked in the state (a kind, no text) and skipped',
  '  later, and 3 refusals in one run stop it. The kinds: pr-number, fix-title, fix-sha, sha, repo-url, pr-term, comment-id, finding-key, fix-marker.',
  '  fix-marker: an outcome word in the comment text (addressed, resolved, fixed in, outdated, a check mark), or a check mark or "addressed in',
  '  commit" anywhere in the prompt. The comment text first loses its HTML comment blocks and every "Addressed in commit" line (counted).',
  '  A judge error (cap, served-model, no-claude, lock) stops the run: the rows done so far are written, exit 1. So do 3 failed calls in a row',
  '  (timeout or an answer that does not parse), or a failure rate over 20 percent once 5 calls ran.',
  '  An answer that does not parse is asked once more at once (inside --limit; never in --checkpoint). Unparsed twice: the finding is stored as',
  '  unparsed (no text) and later runs skip it. void-marked [--dataset <file>] [--json]: no judge call; for each verdict and row, reads the live',
  '  comment and deletes both when it holds "addressed in commit". Counts only. A body it cannot read stays and is counted (not checked): exit 1.',
  '  Every run mode checks each call against the canary baseline. run (not --checkpoint) is refused (exit 2) until `run --canary --confirm-headless`',
  '  has kept a baseline for this prompt version (adjudicate-cr-v3). A failed canary deletes the kept baseline.',
  '  A finding on an answer-key path (scripts/github/lib/answer-key.mjs) is never sent (skipped: answer-key path). A hunk is cut at 120 lines.',
  '  --dispositions <file> (run, plan): a JSON array of disposition records (key, verdict, disposition). It feeds the sidecar and the agreement counts only; the prompt never holds it.',
  '  --first-call-only makes exactly one call (--limit is not needed, no retry) and the summary shows its proof: served model, effort, markers seen.',
  '  run --canary --confirm-headless makes call 0 only, as stream-json: a prompt with no finding text. It passes on an Opus model, a clean smoke',
  '  report (seed.mjs smokeReport) and no hook event or marker outside the answer. The answer is reported (length, NONE, kind counts), not a gate.',
  '  The canary also needs its last line USER: UNKNOWN and input tokens at least 2000 under 8788 (the user CLAUDE.md is excluded).',
  '  A pass keeps its input tokens and the prompt version in the sidecar as the baseline; a later call passes only at most baseline + prompt chars / 1.5 (margin printed).',
  '  run --checkpoint --confirm-headless: its own canary, then calls 1 to 5, each checked; the first failed check, or the first call with no verdict, stops the run (exit 1).',
  '  A failed canary prints a fixed stop line, the answer length and whether it equals NONE; never the answer.',
  '  lines [--write] [--dataset <file>]: gives start_line and end_line to Major findings that have none, from the comment data (gh). Counts only.',
  '  Without --write it is a dry run. A finding that still has no line is not sent by run (skipped: no line data). The judge prompt holds no disposition.',
  '  The summary also counts prompts with a bare number equal to a dataset PR number (counted, never refused, never printed).',
  `  --out: the gold row file (default gold/${OUT_NAME}). --state: the sidecar (default beside --out, the name without .json plus .state).`,
  '  A yes with no linkType final waits (waiting-linktype); a later run builds its row with no new judge call.',
].join('\n');

const VALUE_FLAGS = { '--dataset': 'dataset', '--out': 'out', '--state': 'state', '--records-dir': 'recordsDir', '--linktype': 'linktype', '--limit': 'limit', '--dispositions': 'dispositions' };
const BOOL_FLAGS = { '--confirm-headless': 'confirm', '--json': 'json', '--first-call-only': 'firstCallOnly', '--canary': 'canary', '--checkpoint': 'checkpoint', '--write': 'write' };
const COMMANDS = { plan: planCmd, run: runCmd, lines: linesCmd, 'void-marked': voidMarkedCmd };
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
