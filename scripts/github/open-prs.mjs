#!/usr/bin/env node
// open-prs.mjs (card prflow-open-prs): writes <out>/open-prs.json, one row per open pull request, for the Fleet app.
// Default out folder: ~/.claude/state/lane-dash. The file stays on this machine. No model is called.
// Design: .claudedocs/e2e-prflow-open-prs/2026-11-13-design-note.md. Tests: scripts/github/open-prs.test.mjs.
//
// Row: pr, headRef, head, draft, labels (at most 20, 50 ASCII characters each), band (from bandOf), ready, ci (fixed codes),
// lastTap, status. Never in the file: a title, a body, a reasons text, a Greptile summary, a login, a url or a path.
// Rows are built from an allowlist of fields, never by spreading a response.
//
// lastTap is a pending or unused tap: the newest row in the decisions store for the PR (or its branch, for the ship and open-pr
// steps). A used tap is deleted from the store (decisionUse), so lastTap is null for a PR that was already acted on.
//
// Run: gh lists the open PRs (newest updated first, at most CAP = 20 are checked). Per PR, one gh files call feeds bandOf and
// a child process runs review-status.mjs <pr> --json. This file only runs review-status as a child; it takes nothing else
// from it and only bandOf from the router. The decisions store is read, never written.
// landed (card agentic-os-feeds-truth): {source, rows:[{pr, mergedAt, sha}]}, the 3 newest merged PRs by merge time. One more gh call per run,
// after the open list: pulls?state=closed&sort=updated&direction=desc&per_page=15, merged_at not null. If that call fails (any reason, a
// rate limit too) it is NOT an abort: the list comes from the local land ledger (~/.claude/state/land-outcomes.jsonl, field ts), source
// "ledger"; with no ledger rows it is {source:"none", rows:[]}.
// Abort (exit 10, old file kept): the list call or a files call fails, or the stderr of a review-status child that did not answer
// (an exit other than 0 or 1, or a time-out) says rate limit / HTTP 403 / HTTP 429. A child that answered (exit 0 or 1) is not read for it.
// A review-status exit 2 or a time-out gives a per-PR status. The run budget is 420 s: PRs not started by then get status deadline.
// Lock: <out>/.open-prs.lock holds "pid startedIso token". A live holder younger than 20 minutes makes this run exit 0 at once.
// A run deletes the lock only while its text is still this run's own (the token is unique per run).
// Exit codes: 0 written (or skipped by the lock), 10 gh abort, 1 write failure, 2 bad arguments.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandOf } from './review-router.mjs';
import { killTree as killProcessTree } from './lib/proc.mjs';
import { pidAlive } from './lib/file-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const REVIEW_STATUS = path.join(HERE, 'review-status.mjs');
const CONFIG_FILE = path.join(HERE, '..', '..', 'review-router.config.json');
const WIN_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const CAP = 20;
const PAGE = 100;
const MAX_PAGES = 10;
const BUDGET_MS = 420_000;
const MIN_LEFT_MS = 100_000;
const GH_MS = 30_000;
const STATUS_MS = 60_000;
const LOCK_STALE_MS = 20 * 60_000;
const FUTURE_SKEW_MS = 60_000;
const RATE = /API rate limit|secondary rate limit|HTTP (403|429)/i;
const STEPS = new Set(['ship', 'open-pr', 'review', 'land', 'paid-round']);
const BRANCH_STEPS = new Set(['ship', 'open-pr']);

class GhAbort extends Error {
  constructor(tail) { super(tail); this.tail = tail; }
}

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** Printable ASCII only, cut to n characters. */
const clean = (v, n) => asText(v).replace(/[^\x20-\x7e]/g, '?').slice(0, n);

// ---------------------------------------------------------------- stderr tail (masked)

/**
 * One stderr line, tokens and urls hidden, at most 200 characters. Mask first, cut last. The line is the first one that
 * matches `prefer` (when given), else the first non-empty one. A 40-hex head sha is not a secret and is not masked.
 */
export function maskTail(stderr, prefer) {
  const lines = asText(stderr).split(/\r?\n/);
  const line = (prefer && lines.find((l) => prefer.test(l))) ?? lines.find((l) => l.trim()) ?? '';
  return clean(line
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '<token>')
    .replace(/\b(Bearer)\s+(?!<token>)\S+/gi, '$1 <token>')
    .replace(/\b(token|Basic)\s+(?!<token>)(?=[A-Za-z0-9+/=._-]*\d)[A-Za-z0-9+/=._-]{8,}/gi, '$1 <token>')
    .replace(/https?:\/\/\S+/g, '<url>'), 200);
}

// ---------------------------------------------------------------- reason text to fixed codes

const STATE = /^[a-z_]{1,20}$/;
const coded = (prefix, state) => (STATE.test(state) ? `${prefix}-${state}` : null);
const NONE = new Set(['', 'null', 'undefined']);
const RULES = [
  [/^status ".*" is (\S+)$/, (m) => coded('status', m[1])],
  [/^check ".*" is ([^/\s]+)\/(\S*)$/, (m) => coded('check', NONE.has(m[2]) ? m[1] : m[2])],
  [/^required checks not started on /, () => 'required-not-started'],
  [/^required checks missing on /, () => 'required-missing'],
  [/^required checks ended skipped or neutral on /, () => 'required-ended-skipped'],
  [/^mergeable_state is "([^"]*)"$/, (m) => coded('mergeable', m[1])],
];

function codeOf(reason) {
  for (const [re, make] of RULES) {
    const m = re.exec(reason);
    if (m) return make(m) ?? 'other';
  }
  return 'other';
}

/** The fixed CI codes of a review-status reasons list. Reason text is never copied. */
export const ciCodes = (reasons) => [...new Set((Array.isArray(reasons) ? reasons : []).filter((r) => typeof r === 'string').map(codeOf))].sort();

// ---------------------------------------------------------------- the decisions store (read only)

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readStore(home) {
  const file = process.env.CCV3_DECISIONS_FILE || path.join(home, '.claude', 'state', 'ccv3-mods', 'decisions.json');
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlain(s)) return {};
    const sections = [s.offers ?? {}, s.decisions ?? {}, s.misses ?? {}];
    return sections.every(isPlain) ? sections[1] : {};
  } catch { return {}; }
}

/** Decision rows as { step, key, head, label, at (ms) }. A row with an unknown step or a bad time is skipped. */
export function readTaps(home) {
  const taps = [];
  for (const [id, row] of Object.entries(readStore(home))) {
    const [step, key, head] = id.split('\n');
    const at = Date.parse(row?.at);
    if (STEPS.has(step) && key && head && Number.isFinite(at)) taps.push({ step, key, head: head.toLowerCase(), label: row?.label, at });
  }
  return taps;
}

/** The newest tap for the PR, or for its branch when the step is ship or open-pr. */
export function tapOf(taps, item) {
  const prKey = `${REPO}#${item.number}`;
  const branchKey = `${REPO}@${item.headRef}`;
  const mine = taps.filter((t) => t.key === prKey || (t.key === branchKey && BRANCH_STEPS.has(t.step)));
  const t = mine.reduce((a, b) => (a && a.at >= b.at ? a : b), null);
  return t ? { step: t.step, label: clean(t.label, 50), at: new Date(t.at).toISOString(), headMatches: t.head === item.head } : null;
}

// ---------------------------------------------------------------- calls (every dep may be sync or async, and may throw)

const failure = (e) => ({ status: null, stdout: '', stderr: asText(e?.message), timedOut: false, pid: undefined });

async function settle(fn) {
  try {
    const r = await fn();
    return { status: r?.status ?? null, stdout: asText(r?.stdout), stderr: asText(r?.stderr), timedOut: r?.timedOut === true, pid: r?.pid };
  } catch (e) { return failure(e); }
}

const leftMs = (ctx) => BUDGET_MS - (ctx.d.now().getTime() - ctx.start);

async function ghJson(ctx, args) {
  const res = await settle(() => ctx.d.runGh(args, { timeoutMs: Math.max(1, Math.min(GH_MS, leftMs(ctx))) }));
  if (RATE.test(res.stderr) || res.status !== 0) throw new GhAbort(maskTail(res.stderr, RATE) || `exit ${res.status}`);
  try { return JSON.parse(res.stdout); } catch { throw new GhAbort('answer is not JSON'); }
}

function pickItem(raw) {
  const sha = raw?.head?.sha;
  if (!Number.isInteger(raw?.number) || typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const labelNames = (Array.isArray(raw.labels) ? raw.labels : []).map((l) => l?.name).filter((n) => typeof n === 'string');
  return { number: raw.number, headRef: asText(raw.head.ref), head: sha.toLowerCase(), draft: raw.draft === true, labelNames, updated: Date.parse(raw.updated_at) || 0 };
}

async function listOpen(ctx) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await ghJson(ctx, ['api', `repos/${REPO}/pulls?state=open&per_page=${PAGE}&page=${page}`]);
    if (!Array.isArray(rows)) throw new GhAbort('list answer is not an array');
    all.push(...rows);
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES) ctx.d.log(`open-prs: list stopped at page ${MAX_PAGES}, it was full: later pull requests are not listed`);
  }
  return all.map(pickItem).filter(Boolean);
}

async function filesOf(ctx, pr) {
  const pages = await ghJson(ctx, ['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${pr}/files?per_page=100`]);
  if (!Array.isArray(pages)) throw new GhAbort('files answer is not an array');
  return pages.flat().filter(isPlain).map((f) => ({ filename: f.filename, previous_filename: f.previous_filename }));
}

async function statusOf(ctx, pr) {
  const res = await settle(() => ctx.d.runStatus(pr, { repo: REPO, timeoutMs: Math.max(1, Math.min(STATUS_MS, leftMs(ctx))) }));
  // Kill a timed-out child first: a rate-limit abort must not leave its gh tree alive.
  if (res.timedOut && Number.isInteger(res.pid) && res.pid > 0) {
    try { await ctx.d.killTree(res.pid); } catch { /* already gone */ }
  }
  const answered = res.status === 0 || res.status === 1;
  if (!answered && RATE.test(res.stderr)) throw new GhAbort(maskTail(res.stderr, RATE));
  return res;
}

// ---------------------------------------------------------------- rows

function listRow(item, status) {
  return {
    pr: item.number, headRef: clean(item.headRef, 100), head: item.head, draft: item.draft,
    labels: item.labelNames.slice(0, 20).map((n) => clean(n, 50)),
    band: null, ready: null, ci: [], lastTap: null, status,
  };
}

function verdict(item, res) {
  if (res.timedOut) return { status: 'review-status-timeout' };
  if (res.status !== 0 && res.status !== 1) return { status: 'review-status-failed' };
  let doc;
  try { doc = JSON.parse(res.stdout.trim().split(/\r?\n/).at(-1)); } catch { doc = null; }
  if (!isPlain(doc)) return { status: 'review-status-failed' };
  if (asText(doc.head).toLowerCase() !== item.head) return { status: 'head-moved' };
  return { status: 'ok', ready: typeof doc.ready === 'boolean' ? doc.ready : null, ci: ciCodes(doc.reasons) };
}

function bandFor(files, config, labels) {
  try { return bandOf(files, config, { labels })?.band ?? null; } catch { return null; }
}

async function checkPr(ctx, item, taps, config) {
  const files = await filesOf(ctx, item.number);
  const base = { ...listRow(item, 'ok'), band: bandFor(files, config, item.labelNames), lastTap: tapOf(taps, item) };
  return { ...base, ...verdict(item, await statusOf(ctx, item.number)) };
}

/** Newest updated_at first, the PR number breaks a tie. */
export function planKept(items, cap) {
  const sorted = [...items].sort((a, b) => b.updated - a.updated || b.number - a.number);
  return { kept: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

async function collect(ctx, cap) {
  const listed = await listOpen(ctx);
  const { kept, dropped } = planKept(listed, cap);
  if (dropped.length) ctx.d.log(`open-prs: capped, listed ${listed.length}, kept ${kept.length}`);
  const taps = readTaps(ctx.d.home);
  const config = (() => { try { return ctx.d.readConfig() ?? {}; } catch { return {}; } })();
  const rows = [];
  let deadlineHit = false;
  for (const item of kept) {
    if (leftMs(ctx) < MIN_LEFT_MS) { rows.push(listRow(item, 'deadline')); deadlineHit = true; continue; }
    rows.push(await checkPr(ctx, item, taps, config));
  }
  rows.push(...dropped.map((i) => listRow(i, 'capped')));
  rows.sort((a, b) => a.pr - b.pr);
  return { rows, listed: listed.length, kept: kept.length, deadlineHit };
}

// ---------------------------------------------------------------- the landed list

const LANDED_SHOWN = 3;
const CLOSED_PATH = `repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=15`;
const CCV3_NAMES = new Set(['rev4nchist/continuous-claude-v3', 'continuous-claude']);
const HEX_SHA = /^[0-9a-f]{7,40}$/i;
const isoOf = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const shaOf = (v) => (typeof v === 'string' && HEX_SHA.test(v) ? v.toLowerCase() : null);

/** Newest merge first, the PR number breaks a tie; at most LANDED_SHOWN rows. Rows are built from an allowlist. */
export function newestLanded(rows) {
  return rows.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : b.pr - a.pr)).slice(0, LANDED_SHOWN);
}

/** From the closed-PR answer: merged PRs only. null when the answer is not an array. */
export function landedFromGithub(answer) {
  if (!Array.isArray(answer)) return null;
  const rows = [];
  for (const raw of answer.filter(isPlain)) {
    const mergedAt = isoOf(raw.merged_at);
    if (!Number.isInteger(raw.number) || raw.number <= 0 || mergedAt === null) continue;
    rows.push({ pr: raw.number, mergedAt, sha: shaOf(raw.merge_commit_sha) });
  }
  return newestLanded(rows);
}

/** From the land ledger: the last row of a PR wins, another repo and a bad time are skipped, a bad line is skipped. */
export function landedFromLedger(text) {
  const byPr = new Map();
  for (const line of asText(text).split(/\r?\n/)) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const mergedAt = isPlain(o) ? isoOf(o.ts) : null;
    if (mergedAt === null || !Number.isInteger(o.pr) || o.pr <= 0) continue;
    if (typeof o.repo !== 'string' || !CCV3_NAMES.has(o.repo.trim().toLowerCase())) continue;
    const have = byPr.get(o.pr);
    if (!have || have.mergedAt <= mergedAt) byPr.set(o.pr, { pr: o.pr, mergedAt, sha: shaOf(o.mergeSha) });
  }
  return newestLanded([...byPr.values()]);
}

function ledgerLanded(d) {
  let text;
  try { text = readFileSync(path.join(d.home, '.claude', 'state', 'land-outcomes.jsonl'), 'utf8'); } catch { return { source: 'none', rows: [] }; }
  const rows = landedFromLedger(text);
  return rows.length > 0 ? { source: 'ledger', rows } : { source: 'none', rows: [] };
}

/** One closed-PR call. Any failure of it (a rate limit too) falls back to the ledger: the open rows are still worth writing. */
async function collectLanded(ctx) {
  try {
    const rows = landedFromGithub(await ghJson(ctx, ['api', CLOSED_PATH]));
    if (rows === null) throw new GhAbort('landed answer is not an array');
    return { source: 'github', rows };
  } catch (e) {
    if (!(e instanceof GhAbort)) throw e;
    return ledgerLanded(ctx.d);
  }
}

const summaryLine = (rows) => {
  const n = (s) => rows.filter((r) => r.status === s).length;
  return `open-prs: ${rows.length} rows, ok ${n('ok')}, capped ${n('capped')}, deadline ${n('deadline')}, failed ${rows.length - n('ok') - n('capped') - n('deadline')}`;
};

// ---------------------------------------------------------------- lock and write

const readText = (lock) => {
  try { return readFileSync(lock, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? undefined : null; }
};

/**
 * 'held' or 'stale'. text is the lock text, or null when it could not be read. A lock is stale when it started more than
 * 20 minutes ago, is dated more than a minute ahead of the clock, or names a dead pid. With no readable start date the file
 * mtime is the start. An empty or unreadable pid (a run between create and write) counts as held until it is stale.
 */
export function judgeLock(text, mtimeMs, nowMs) {
  const [pid, started] = (text ?? '').trim().split(' ');
  const startMs = Number.isFinite(Date.parse(started)) ? Date.parse(started) : mtimeMs;
  const age = nowMs - startMs;
  if (age > LOCK_STALE_MS || age < -FUTURE_SKEW_MS) return 'stale';
  const n = Number.parseInt(pid, 10);
  return n > 0 && !pidAlive(n) ? 'stale' : 'held';
}

/** 'gone' when the lock vanished, else 'held' or 'stale'. */
function lockState(lock, text, d) {
  if (text === undefined) return 'gone';
  try { return judgeLock(text, statSync(lock).mtimeMs, d.now().getTime()); } catch { return 'gone'; }
}

/**
 * Removes the lock only while its text is still the text that was judged stale. The re-read leaves a window of a few
 * system calls: a run that took the lock inside it loses it. That needs a fresh run at exactly that moment.
 */
function unlinkIfSame(lock, text) {
  if (readText(lock) !== text) return;
  try { unlinkSync(lock); } catch { /* another run took it; the retry finds out */ }
}

/** The lock text of this run when this run now owns the lock. null when a live run holds it. */
function takeLock(lock, d) {
  const mine = `${process.pid} ${d.now().toISOString()} ${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(lock, mine, { flag: 'wx' }); return mine; } catch (e) { if (e?.code !== 'EEXIST') throw e; }
    const text = readText(lock);
    const state = lockState(lock, text, d);
    if (state === 'held') return null;
    if (state === 'stale') { d.log('open-prs: taking over a stale lock'); unlinkIfSame(lock, text); }
  }
  return null;
}

/** Deletes the lock only while it still holds this run's text. */
function releaseLock(lock, mine) {
  if (readText(lock) !== mine) return;
  try { unlinkSync(lock); } catch { /* already gone */ }
}

function writeDoc(d, out, doc) {
  const tmp = path.join(out, 'open-prs.json.tmp');
  try {
    writeFileSync(tmp, JSON.stringify(doc));
    d.rename(tmp, path.join(out, 'open-prs.json'));
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never written */ }
  }
}

async function run(d, opts, out) {
  const ctx = { d, start: d.now().getTime() };
  let res;
  try {
    res = await collect(ctx, opts.cap);
    res.landed = await collectLanded(ctx);
  } catch (e) {
    if (!(e instanceof GhAbort)) throw e;
    d.err(`open-prs: gh failed (${e.tail}), old file kept`);
    return 10;
  }
  const doc = { schema: 1, exportedAt: d.now().toISOString(), repo: REPO, listed: res.listed, kept: res.kept, capped: res.listed > res.kept, deadlineHit: res.deadlineHit, rows: res.rows, landed: res.landed };
  try {
    writeDoc(d, out, doc);
  } catch (e) {
    d.err(`open-prs: write failed (${maskTail(e?.message)})`);
    return 1;
  }
  d.log(summaryLine(res.rows));
  return 0;
}

// ---------------------------------------------------------------- default dependencies

function ghEnv() {
  const env = { ...process.env };
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  if (!env.GH_CONFIG_DIR && existsSync(personal)) env.GH_CONFIG_DIR = personal;
  return env;
}

function defaultRunGh(args, { timeoutMs }) {
  const opts = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: ghEnv() };
  let r = spawnSync('gh', args, opts);
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') r = spawnSync(WIN_GH, args, opts);
  const note = r.error ? `gh ${r.error.code ?? 'failed'}` : '';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || note };
}

/** A child with its own timer. At the timer it returns timedOut with the pid; the caller kills the tree. */
export function runChild(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: ghEnv(), detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timer = null;
    const finish = (r) => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ pid: child.pid, stdout, stderr, ...r });
    };
    timer = setTimeout(() => finish({ status: null, timedOut: true }), timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => finish({ status: null, stderr: `spawn ${e.code ?? 'failed'}` }));
    child.on('close', (code) => finish({ status: code }));
  });
}

/** review-status.mjs <pr> --json as a child. */
const defaultRunStatus = (pr, { repo, timeoutMs }) => runChild(process.execPath, [REVIEW_STATUS, String(pr), '--repo', repo, '--json'], timeoutMs);

const defaultReadConfig = () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

// ---------------------------------------------------------------- command line

const USAGE = `usage: open-prs.mjs [--out <dir>] [--cap <n>]
  --out  output folder (default ~/.claude/state/lane-dash)
  --cap  most PRs checked in full (default ${CAP}); the rest get status capped`;

function parseArgs(argv) {
  const opts = { cap: CAP };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a !== '--out' && a !== '--cap') throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === '--out') opts.out = v;
    else if (/^[1-9]\d{0,3}$/.test(v)) opts.cap = Number(v);
    else throw new Error(`--cap needs a whole number from 1 to 9999\n${USAGE}`);
  }
  return opts;
}

function withDefaults(deps) {
  return {
    now: () => new Date(), home: os.homedir(), runGh: defaultRunGh, runStatus: defaultRunStatus, killTree: killProcessTree,
    readConfig: defaultReadConfig, rename: renameSync, log: console.log, err: console.error,
    ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)),
  };
}

/** Run. Returns the exit code. `deps` = {now, home, runGh, runStatus, killTree, readConfig, rename, log, err} (tests inject them). */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = withDefaults(deps);
  let opts;
  try { opts = parseArgs(argv); } catch (e) { d.err(`open-prs: ${e.message}`); return 2; }
  if (opts.help) { d.log(USAGE); return 0; }
  const out = path.resolve(opts.out ?? path.join(d.home, '.claude', 'state', 'lane-dash'));
  const lock = path.join(out, '.open-prs.lock');
  let mine;
  try {
    mkdirSync(out, { recursive: true });
    mine = takeLock(lock, d);
  } catch (e) {
    d.err(`open-prs: cannot take the lock (${maskTail(e?.message)})`);
    return 1;
  }
  if (!mine) { d.log('open-prs: another run holds the lock'); return 0; }
  try {
    return await run(d, opts, out);
  } finally {
    releaseLock(lock, mine);
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`open-prs: ${maskTail(e?.message)}`);
    process.exit(1);
  });
}
