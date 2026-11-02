#!/usr/bin/env node
/**
 * cursor-review.mjs: the local Cursor review runner of the review matrix (.claudedocs/2026-11-01-review-matrix.md, 3.2 and 3.3).
 *
 * Usage:
 *   node scripts/github/cursor-review.mjs (--pr <n> | --range <base>..<head>) (--band MID|ELEVATED|HIGH|CRITICAL | --model <id>)
 *        [--timeout-sec 1500] [--ledger <file>] [--out-dir <dir>] [--repo owner/name] [--remote fork] [--dry-run] [--keep-tree]
 *
 * What it does:
 *   1. Checks the model. Only grok-4.7-high and grok-4.7-xhigh run. Auto, any id with "fast", an unknown id and a missing
 *      model are refused. The CLI default model is never used. The band picks the model (CRITICAL: xhigh, else high; LOW: no Cursor).
 *   2. Checks the usage ledger (default ~/.claude/state/cursor-review-ledger.jsonl): at most 300 runs in a rolling 7 days across
 *      all sessions, at most 8 per PR or range. A run is reserved under a lock before the agent starts.
 *   3. Builds a clean review tree: `git archive` of the head (no .git, no review docs, no old artifacts) plus PR.diff.
 *   4. Runs `cursor-agent -p --mode ask --trust --output-format json --model <m>` in that tree. On Windows it runs the agent's
 *      own node.exe on index.js (the way cursor-agent.ps1 does), not the .cmd or .ps1 wrapper, so the pid it holds is the agent.
 *      A time-out (default 1500 s: the bake-off max for grok-4.7-high was 904 s) stops that pid and its whole process tree.
 *   5. Parses the answer (a final ```json block, else the Markdown headings Cursor writes) and writes, in .claude/cache/e2e/:
 *        <date>-cursor-review-<ref>-<time>.findings.json   the structured findings
 *        <date>-cursor-review-<ref>-<time>.summary.txt     a short text summary
 *        <date>-cursor-review-<ref>-<time>.raw.json        the raw agent output
 *
 * Exit codes: 0 ran (findings may exist), 1 run failure (time-out, agent error, unparseable answer, install missing),
 *             2 bad input or refused by a rule, 3 cap reached.
 *
 * Known limits (also in the matrix, 3.2 and 3.3):
 *   - Windows has no Cursor sandbox. `--mode ask` is the only guard. This script does not audit the transcript for reads
 *     outside the workspace (matrix 3.3 step 4); that audit is still manual.
 *   - The Cursor result JSON names no model, so the post-run model check (matrix 3.2) cannot run. The run is logged with
 *     modelVerified false. If a future CLI adds a `model` field that differs from --model, the run is voided (exit 1).
 *   - The tree kill walks the process table once, when the time-out fires (CIM, about 5 s). A process that is started after
 *     that snapshot, or that lost its parent earlier, is not found.
 *   - No automatic retry. The caller owns the one allowed retry; every retry is a new run in the ledger.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { OK: 0, FAILED: 1, REFUSED: 2, CAP: 3 };
export const MODEL_ALLOWLIST = new Set(['grok-4.7-high', 'grok-4.7-xhigh']);
export const BAND_MODEL = { MID: 'grok-4.7-high', ELEVATED: 'grok-4.7-high', HIGH: 'grok-4.7-high', CRITICAL: 'grok-4.7-xhigh' };
export const WEEKLY_CAP = 300;
export const WEEK_MS = 7 * 86_400_000;
export const PER_REF_CAP = 8;
export const DEFAULT_TIMEOUT_SEC = 1500;
export const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const SEVERITIES = ['critical', 'major', 'minor', 'info'];
/** Folders left out of the review tree: answers and old review output the model must not see. */
const TREE_EXCLUDES = ['.git', '.claudedocs', '.claude/cache', '.claude/reviews', 'artifacts', 'thoughts'];

// ---------- model and band ----------

/** { ok, model, band } or { ok: false, reason }. A model is checked by exact match; there is no fallback to the CLI default. */
export function resolveModel({ model, band } = {}) {
  const hasBand = band !== undefined && band !== null && String(band).trim() !== '';
  const hasModel = model !== undefined && model !== null;
  if (!hasBand && !hasModel) return { ok: false, reason: 'pass --model or --band: the CLI default model is never used' };
  let want = null;
  let bandKey = null;
  if (hasBand) {
    bandKey = String(band).trim().toUpperCase();
    if (bandKey === 'LOW') return { ok: false, reason: 'band LOW runs no Cursor review (matrix section 10)' };
    want = BAND_MODEL[bandKey];
    if (!want) return { ok: false, reason: `unknown band ${JSON.stringify(band)}: use MID, ELEVATED, HIGH or CRITICAL` };
  }
  if (!hasModel) return { ok: true, model: want, band: bandKey };
  const m = String(model);
  if (/fast/i.test(m)) return { ok: false, reason: `model ${JSON.stringify(m)} is a fast variant: reviews never run in fast mode` };
  if (m.trim().toLowerCase() === 'auto') return { ok: false, reason: 'model auto is refused: pass an explicit grok-4.7 model' };
  if (!MODEL_ALLOWLIST.has(m)) return { ok: false, reason: `model ${JSON.stringify(m)} is not allowed: use ${[...MODEL_ALLOWLIST].join(' or ')}` };
  if (want && m !== want) return { ok: false, reason: `band ${bandKey} uses ${want}, not ${m}` };
  return { ok: true, model: m, band: bandKey };
}

// ---------- usage ledger ----------

export const defaultLedgerPath = (env = process.env) => env.CURSOR_REVIEW_LEDGER || path.join(os.homedir(), '.claude', 'state', 'cursor-review-ledger.jsonl');

/** { entries, damaged }. A missing file is empty. A line that is not a JSON object is skipped and counted. */
export function readLedger(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { entries: [], damaged: 0 }; }
  const entries = [];
  let damaged = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o)) entries.push(o); else damaged += 1;
    } catch { damaged += 1; }
  }
  return { entries, damaged };
}

/** The number of distinct runs inside the rolling window (optionally for one ref). A run counts by its earliest line. */
export function countRuns(entries, { now, ref, windowMs = WEEK_MS }) {
  const first = new Map();
  entries.forEach((e, i) => {
    const key = e.id ?? `line-${i}`;
    const t = Date.parse(e.ts);
    const prev = first.get(key);
    if (!prev || t < prev.t) first.set(key, { t, ref: e.ref });
  });
  const cutoff = now - windowMs;
  let n = 0;
  for (const { t, ref: r } of first.values()) {
    if (ref !== undefined && r !== ref) continue;
    if (Number.isNaN(t) || t >= cutoff) n += 1; // an unreadable time counts: the cap errs on the safe side
  }
  return n;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, { lockWaitMs = 5000, lockStaleMs = 30_000 }, fn) {
  const lock = `${file}.lock`;
  const began = Date.now();
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > lockStaleMs) { unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: 'lock', detail: `the ledger lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/**
 * Counts, then appends a start line, under a lock, so two sessions cannot both take the last slot.
 * { ok: true, id, count } or { ok: false, reason: 'cap' | 'ref-cap' | 'lock', count }.
 */
export function reserveRun(file, entry, { now = Date.now, cap = WEEKLY_CAP, perRefCap = PER_REF_CAP, ...lockOpts } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, lockOpts, () => {
    const { entries } = readLedger(file);
    const t = now();
    const total = countRuns(entries, { now: t });
    if (total >= cap) return { ok: false, reason: 'cap', count: total };
    const forRef = countRuns(entries, { now: t, ref: entry.ref });
    if (forRef >= perRefCap) return { ok: false, reason: 'ref-cap', count: forRef };
    const id = randomUUID();
    const line = { ts: new Date(t).toISOString(), phase: 'start', id, ref: entry.ref, model: entry.model, band: entry.band ?? null, sessionId: entry.sessionId ?? null };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return { ok: true, id, count: total + 1 };
  });
}

/** Appends the end line of a run. */
export function finishRun(file, id, patch, { now = Date.now } = {}) {
  appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), phase: 'end', id, ...patch })}\n`);
}

// ---------- prompt ----------

export function buildPrompt({ ref, files = [] }) {
  const shown = files.slice(0, 60);
  const more = files.length > shown.length ? `\n... and ${files.length - shown.length} more` : '';
  return [
    `You are reviewing a code change (${ref}). This folder is a clean copy of the new code. The change itself is the file PR.diff in the workspace root.`,
    'Read PR.diff first. Then read the changed source files around each hunk.',
    'Rules: read only inside the workspace. Do not look for other review notes, answers or comments. Do not run shell commands. Do not edit files.',
    'Look for: bugs; fail-open error paths; missed events; pagination and truncated reads; trust in external data; input validation; partial writes.',
    'Report only defects in the changed code, with the file and line in the new code. Rate a finding major only if realistic use can give wrong behaviour, a security bypass or data loss. Code that a comment documents as intended is not a major finding.',
    `Changed files (${files.length}):\n${shown.join('\n')}${more}`,
    'End your answer with exactly one fenced json block, and put nothing after it:',
    '```json',
    '{"findings":[{"file":"path/in/repo","line":123,"severity":"major|minor|info","title":"short title","body":"what is wrong, when it happens, how to fix"}]}',
    '```',
    'Use {"findings":[]} when you find no defect.',
  ].join('\n');
}

// ---------- output parser ----------

const HEADER = /^\s*(?:[-*]\s+)?(?:#{1,6}\s+|\*\*)\s*(Critical|Major|Minor|Nit|Nitpick|Info)\b\s*[—–-]+\s*(.*)$/i;
const LOCATION = /`([^`\s]*?):(\d+)(?:-(\d+))?`/;
const LOCATIONS = /`[^`\s]*:\d+(?:-\d+)?`/g;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function normSeverity(s) {
  const k = String(s ?? '').trim().toLowerCase();
  if (k === 'blocker') return 'critical';
  return SEVERITIES.includes(k) ? k : 'info';
}

function normLine(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return [Math.trunc(v), null];
  const m = /^\s*(\d+)(?:\s*[-–:]\s*(\d+))?\s*$/.exec(String(v ?? ''));
  return m ? [Number(m[1]), m[2] ? Number(m[2]) : null] : [null, null];
}

function fromJsonItems(items) {
  const findings = [];
  let dropped = 0;
  for (const it of items) {
    const file = typeof it?.file === 'string' ? it.file.trim() : '';
    const body = typeof it?.body === 'string' ? it.body.trim() : '';
    const title = (typeof it?.title === 'string' && it.title.trim()) || clip(body, 100);
    if (!file || !title) { dropped += 1; continue; }
    const [line, endFromLine] = normLine(it.line);
    const [lineEnd] = normLine(it.lineEnd ?? it.line_end ?? endFromLine);
    findings.push({ file, line, lineEnd: lineEnd ?? null, severity: normSeverity(it.severity), title, body });
  }
  return { findings, dropped };
}

/**
 * The findings list in the LAST fenced block, and only when that block ends the answer. A block that does not parse, or text after
 * it, gives null: an earlier fenced example (such as an empty list) must never turn a broken answer into a clean one. The block is
 * found from the end, so an earlier code fence cannot throw the pairing off. { items } or null.
 */
function jsonBlock(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.at(-1)?.trim() !== '```') return null;
  let open = lines.length - 2;
  while (open >= 0 && !lines[open].trim().startsWith('```')) open -= 1;
  if (open < 0 || !/^```(?:json)?\s*$/.test(lines[open].trim())) return null;
  try {
    const v = JSON.parse(lines.slice(open + 1, -1).join('\n'));
    if (Array.isArray(v)) return { items: v };
    if (v && Array.isArray(v.findings)) return { items: v.findings };
  } catch { /* not a findings block */ }
  return null;
}

/** Findings from the Markdown headings Cursor writes: `### Major — \`file:line\` — title` and `**Major — \`file:line\`**`. */
function markdownFindings(text) {
  const out = [];
  let cur = null;
  let inFence = false;
  const close = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    out.push({ file: cur.file, line: cur.line, lineEnd: cur.lineEnd, severity: cur.severity, title: cur.title || clip(body.split(/\r?\n/)[0] ?? '', 100) || cur.severity, body });
    cur = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; if (cur) cur.lines.push(line); continue; }
    if (!inFence) {
      const h = HEADER.exec(line);
      if (h) {
        close();
        const rest = h[2];
        const loc = LOCATION.exec(rest);
        const title = rest.replace(LOCATIONS, ' ').replace(/\*\*/g, ' ').replace(/^[\s,+—–-]*(?:(?:and|with)\b[\s,+]*)*/i, '').replace(/[\s,+—–-]+$/, '').replace(/\s+/g, ' ').trim();
        cur = { severity: normSeverity(h[1]), file: loc ? loc[1] || '(unspecified)' : '(unspecified)', line: loc ? Number(loc[2]) : null, lineEnd: loc && loc[3] ? Number(loc[3]) : null, title, lines: [] };
        continue;
      }
      if (/^\s*#{1,6}\s/.test(line) || /^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { close(); continue; }
    }
    if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

/**
 * Parses the stdout of `cursor-agent --output-format json`. Pure.
 * { ok, isError, format: 'json' | 'markdown' | 'none', findings, clean, problems, usage, sessionId, durationMs, modelVerified, modelMismatch, text }
 * ok is false for an error result and for an answer with no findings block and no recognisable headings: "no major bugs" in
 * prose is not a pass.
 */
export function parseReviewOutput(stdout, { expectModel } = {}) {
  const base = { ok: false, isError: false, format: 'none', findings: [], clean: false, problems: [], usage: null, sessionId: null, durationMs: null, modelVerified: false, modelMismatch: false, text: '' };
  let result = null;
  const lines = String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const l of [...lines].reverse()) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && o.type === 'result') { result = o; break; }
    } catch { /* not a JSON line */ }
  }
  if (!result) return { ...base, problems: ['no result JSON in the agent output'] };
  const p = { ...base, usage: result.usage ?? null, sessionId: result.session_id ?? null, durationMs: result.duration_ms ?? null, text: String(result.result ?? '') };
  const echo = typeof result.model === 'string' ? result.model : null;
  p.modelMismatch = Boolean(echo && expectModel && echo !== expectModel);
  p.modelVerified = Boolean(echo && expectModel && echo === expectModel);
  if (result.is_error === true || (result.subtype && result.subtype !== 'success')) {
    return { ...p, isError: true, problems: [`the agent reported an error: ${clip(p.text || String(result.subtype), 200)}`] };
  }
  const block = jsonBlock(p.text);
  if (block) {
    const { findings, dropped } = fromJsonItems(block.items);
    if (dropped > 0) p.problems.push(`dropped ${dropped} unusable finding item(s)`);
    p.format = 'json';
    p.findings = findings;
    p.clean = block.items.length === 0;
    p.ok = findings.length > 0 || p.clean;
    if (!p.ok) p.problems.push('the findings block holds no usable item');
    return voidIfNotRun(p);
  }
  const md = markdownFindings(p.text);
  if (md.length > 0) {
    if (md.some((f) => f.file === '(unspecified)')) p.problems.push('a finding names no file:line');
    return voidIfNotRun({ ...p, ok: true, format: 'markdown', findings: md });
  }
  return { ...p, problems: ['no findings block and no recognisable headings: the answer is not a pass'] };
}

/** The model says it could not read the diff. */
const NOT_RUN = /\b(?:review (?:did not|didn't|could not|couldn't) run|(?:was|were) blocked|blocked by (?:a|the) hook|could(?: not|n't) (?:read|access|open)|unable to (?:read|access|open)|no basis for)/i;

/**
 * An empty findings list is a pass only when the model read the change. On 2026-11-01 the user's global Claude hooks (Cursor runs
 * them) blocked every read in the review tree, and the model still ended with {"findings":[]}. That answer is void, not clean.
 */
function voidIfNotRun(p) {
  if (p.findings.length === 0 && NOT_RUN.test(p.text)) {
    return { ...p, ok: false, clean: false, notRun: true, problems: [...p.problems, 'the answer says the review did not run (reads blocked or failed): the empty findings list is not a pass'] };
  }
  return p;
}

// ---------- the agent: resolve, run, time-out ----------

const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/**
 * The program and leading arguments that start cursor-agent. Windows: the newest version folder's node.exe on index.js,
 * as cursor-agent.ps1 does, so no cmd or powershell wrapper sits between this script and the agent. Elsewhere: `cursor-agent`.
 * { cmd, prefixArgs } or { error }.
 */
export function resolveAgent({ platform = process.platform, env = process.env, readdir = readdirSync, exists = existsSync } = {}) {
  if (platform !== 'win32') return { cmd: 'cursor-agent', prefixArgs: [] };
  const w = path.win32;
  const root = env.CURSOR_AGENT_DIR || w.join(env.LOCALAPPDATA ?? '', 'cursor-agent');
  const pair = (dir) => ({ node: w.join(dir, 'node.exe'), index: w.join(dir, 'index.js') });
  const direct = pair(root);
  if (exists(direct.node) && exists(direct.index)) return { cmd: direct.node, prefixArgs: [direct.index] };
  let names = [];
  try { names = readdir(w.join(root, 'versions')); } catch { /* handled below */ }
  const dated = names.map((n) => ({ n, m: VERSION_DIR.exec(n) })).filter((x) => x.m)
    .map(({ n, m }) => ({ n, key: Number(`${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`) }))
    .sort((a, b) => b.key - a.key || (a.n < b.n ? 1 : -1));
  for (const { n } of dated) {
    const v = pair(w.join(root, 'versions', n));
    if (exists(v.node) && exists(v.index)) return { cmd: v.node, prefixArgs: [v.index] };
  }
  return { error: `cursor-agent is not installed under ${root}\\versions (set CURSOR_AGENT_DIR to its folder)` };
}

/** POSIX shell variables that a Git Bash session sets. See buildAgentEnv. */
const POSIX_SHELL_VARS = ['SHELL', 'MSYSTEM', 'BASH', 'BASH_ENV'];

/**
 * The environment for cursor-agent. Cursor runs the user's Claude Code hooks through `process.env.SHELL` when it is set. A session
 * started from Git Bash has SHELL=/bin/bash.exe, and bash cannot run Cursor's PowerShell hook launcher: every tool call then ends
 * "Hook blocked with message: --: eval: line 1: syntax error near unexpected token `('" (2026-11-01: all reads blocked, the model
 * still answered {"findings":[]}). The bake-off, started from PowerShell, had no SHELL and worked. So on Windows these variables are
 * dropped. It also sets what cursor-agent.cmd and cursor-agent.ps1 set (CURSOR_INVOKED_AS, NODE_COMPILE_CACHE). Pure.
 */
export function buildAgentEnv(base = process.env, platform = process.platform) {
  const env = { ...base };
  if (platform === 'win32') {
    for (const k of POSIX_SHELL_VARS) delete env[k];
    env.CURSOR_INVOKED_AS = 'cursor-agent.cmd';
    env.NODE_COMPILE_CACHE ||= path.win32.join(env.LOCALAPPDATA || os.tmpdir(), 'cursor-compile-cache');
  } else {
    env.CURSOR_INVOKED_AS ||= 'cursor-agent';
  }
  return env;
}

async function defaultKiller(pid) {
  const { killTree } = await import('./pre-pr.mjs');
  killTree(pid);
}

/**
 * Runs the agent and resolves when it ends. A time-out stops the agent pid and its whole process tree (killTree from pre-pr.mjs:
 * the Windows tree-kill switch is forbidden here, so it walks the process table). Never throws; a spawn error is a result.
 * { status, stdout, stderr, timedOut, error, durationMs }
 */
export function runAgent({ command, args, cwd, timeoutMs, env = process.env }, { spawnFn = spawn, killer = defaultKiller, killGraceMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let error;
    let child;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      resolve({ status, stdout, stderr, timedOut, error, durationMs: Date.now() - started });
    };
    const limit = setTimeout(async () => {
      timedOut = true;
      try { await killer(child?.pid); } catch { /* the grace timer below ends the wait */ }
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(() => finish(null), killGraceMs).unref();
    }, timeoutMs);
    try {
      child = spawnFn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      error = String(err.message);
      finish(null);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (!settled) stdout += c; });
    child.stderr.on('data', (c) => { if (!settled) stderr += c; });
    child.on('error', (err) => { error = String(err.message); finish(null); });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

// ---------- the clean review tree ----------

const badInput = (msg) => Object.assign(new Error(msg), { code: 'BAD_INPUT' });

function gitOut(root, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  }
  return r.stdout;
}

function resolveRev(root, rev) {
  const out = gitOut(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  if (!out) throw badInput(`cannot resolve revision ${JSON.stringify(rev)} in ${root}`);
  return out.trim();
}

function defaultGh(args) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', env, timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
}

/**
 * Resolves the input to base and head, then builds the clean tree. The diff base is the merge base, so a branch that merged
 * main shows only its own change. { ref, base, head, dir, files, cleanup }.
 */
export async function prepareReview({ root, input, tmpRoot = os.tmpdir(), gh = defaultGh, repo = DEFAULT_REPO, remote = 'fork' }) {
  let head;
  let baseSide;
  let ref;
  if (input.pr !== undefined) {
    const pull = await gh(['api', `repos/${repo}/pulls/${input.pr}`]);
    head = pull?.head?.sha;
    const baseRef = pull?.base?.ref;
    const baseSha = pull?.base?.sha;
    if (!head || !baseRef) throw badInput(`PR ${input.pr}: gh returned no head sha or base ref`);
    if (!baseSha) throw badInput(`PR ${input.pr}: gh returned no base sha`);
    const have = (sha) => gitOut(root, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) !== null;
    if (!have(head)) gitOut(root, ['fetch', '--quiet', remote, `pull/${input.pr}/head`]);
    // The base is the sha GitHub reports, never a local branch: a stale local main would put other commits in the diff.
    if (!have(baseSha)) gitOut(root, ['fetch', '--quiet', remote, baseRef], { allowFail: true });
    if (!have(baseSha)) gitOut(root, ['fetch', '--quiet', remote, baseSha], { allowFail: true });
    head = resolveRev(root, head);
    baseSide = resolveRev(root, baseSha);
    ref = `pr-${input.pr}`;
  } else {
    const [a, b] = String(input.range).split(/\.{2,3}/);
    baseSide = resolveRev(root, a);
    head = resolveRev(root, b);
    ref = `range-${baseSide.slice(0, 8)}..${head.slice(0, 8)}`;
  }
  const mergeBase = (gitOut(root, ['merge-base', baseSide, head], { allowFail: true }) ?? baseSide).trim();
  const work = mkdtempSync(path.join(tmpRoot, 'cursor-review-'));
  const dir = path.join(work, 'tree');
  const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    mkdirSync(dir);
    gitOut(root, ['archive', '--format=tar', '-o', path.join(work, 'head.tar'), head]);
    // Relative names and cwd: an absolute C:\ path would read as host:path to GNU tar.
    const tar = spawnSync('tar', ['-xf', '../head.tar'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (tar.error) throw new Error(`tar failed to start: ${tar.error.message}`);
    if (tar.status !== 0 && readdirSync(dir).length === 0) throw new Error(`tar failed: ${(tar.stderr ?? '').trim()}`);
    rmSync(path.join(work, 'head.tar'), { force: true });
    for (const x of TREE_EXCLUDES) rmSync(path.join(dir, x), { recursive: true, force: true });
    writeFileSync(path.join(dir, 'PR.diff'), gitOut(root, ['diff', '--no-color', '--no-ext-diff', mergeBase, head]));
    const files = gitOut(root, ['diff', '--name-only', mergeBase, head]).split(/\r?\n/).filter(Boolean);
    return { ref, base: mergeBase, head, dir, files, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------- the run ----------

const two = (n) => String(n).padStart(2, '0');
const stamp = (d) => ({ day: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, time: `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}` });
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

function summaryText(rec) {
  const lines = [];
  if (rec.status === 'failed') {
    lines.push(`cursor-review FAILED: ${rec.error}`);
  } else {
    const counts = SEVERITIES.filter((s) => rec.counts[s]).map((s) => `${rec.counts[s]} ${s}`).join(', ');
    lines.push(`cursor-review ${rec.ref}: ${rec.findings.length} finding(s)${counts ? ` (${counts})` : ''}${rec.clean ? ', explicit clean answer' : ''}`);
  }
  lines.push(`model ${rec.model}${rec.band ? `, band ${rec.band}` : ''}, ${Math.round((rec.durationMs ?? 0) / 1000)} s, format ${rec.format}, head ${String(rec.head).slice(0, 12)}`);
  if (!rec.modelVerified) lines.push('note: the Cursor output names no model, so the run model was not verified (matrix 3.2 limit)');
  for (const p of rec.problems) lines.push(`note: ${p}`);
  const order = (s) => SEVERITIES.indexOf(s);
  for (const f of [...rec.findings].sort((a, b) => order(a.severity) - order(b.severity)).slice(0, 25)) {
    lines.push(`${f.severity.padEnd(8)} ${f.file}${f.line ? `:${f.line}${f.lineEnd ? `-${f.lineEnd}` : ''}` : ''}  ${clip(f.title, 120)}`);
  }
  if (rec.findings.length > 25) lines.push(`... and ${rec.findings.length - 25} more: read the findings file`);
  return `${lines.join('\n')}\n`;
}

/**
 * One review. opts: { input, band, model, ledgerPath, outDir, timeoutMs, dryRun, keepTree, root, repo, remote }.
 * deps (tests): { now, env, agent, prepare, runner }. Returns { exit, ... }.
 */
export async function runReview(opts, deps = {}) {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const log = deps.stderr ?? (() => {});
  const refuse = (exit, reason) => { log(`cursor-review: ${reason}`); return { exit, reason }; };

  const m = resolveModel({ model: opts.model, band: opts.band });
  if (!m.ok) return refuse(EXIT.REFUSED, m.reason);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_SEC * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) return refuse(EXIT.REFUSED, '--timeout-sec must be a number of at least 1');
  const agent = deps.agent ?? resolveAgent({ env });
  if (agent.error && !opts.dryRun) return refuse(EXIT.FAILED, agent.error);

  if (!opts.dryRun) {
    const used = countRuns(readLedger(opts.ledgerPath).entries, { now: now() });
    if (used >= WEEKLY_CAP) return refuse(EXIT.CAP, `weekly cap reached: ${used} of ${WEEKLY_CAP} runs in the last 7 days`);
  }

  let prep;
  try {
    prep = await (deps.prepare ?? prepareReview)({ root: opts.root, input: opts.input, repo: opts.repo, remote: opts.remote });
  } catch (err) {
    return refuse(err.code === 'BAD_INPUT' ? EXIT.REFUSED : EXIT.FAILED, err.message);
  }
  const prompt = buildPrompt({ ref: prep.ref, files: prep.files });
  if (opts.dryRun) {
    const info = `dry run: ${prep.ref}, model ${m.model}, tree ${prep.dir}, ${prep.files.length} changed file(s), prompt ${prompt.length} chars. No agent started, no ledger line.`;
    (deps.stdout ?? (() => {}))(info);
    if (!opts.keepTree && !deps.keepDryTree) prep.cleanup();
    return { exit: EXIT.OK, dryRun: true, dir: prep.dir, info };
  }

  const sessionId = env.CLAUDE_CODE_SESSION_ID || null;
  const reserved = reserveRun(opts.ledgerPath, { ref: prep.ref, model: m.model, band: m.band, sessionId }, { now });
  if (!reserved.ok) {
    prep.cleanup();
    return refuse(reserved.reason === 'lock' ? EXIT.FAILED : EXIT.CAP, reserved.detail ?? `${reserved.reason} reached (${reserved.count})`);
  }

  const args = [...(agent.prefixArgs ?? []), '-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--model', m.model, prompt];
  const spec = { command: agent.cmd, args, cwd: prep.dir, timeoutMs, env: buildAgentEnv(env, deps.platform ?? process.platform) };
  const startedAt = now();
  let run;
  try { run = await (deps.runner ?? runAgent)(spec); } catch (err) { run = { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message), durationMs: now() - startedAt }; }
  const parsed = parseReviewOutput(run.stdout, { expectModel: m.model });

  let error = null;
  if (run.timedOut) error = `TIMED OUT after ${Math.round(timeoutMs / 1000)} s: the agent and its process tree were stopped; no findings were read`;
  else if (run.error) error = `the agent did not start or crashed: ${run.error}`;
  else if (run.status !== 0) error = `the agent exited with status ${run.status}${run.stderr ? `: ${clip(run.stderr.trim(), 200)}` : ''}`;
  else if (parsed.modelMismatch) error = `model check failed: the output names a model other than ${m.model}; the run is void`;
  else if (!parsed.ok) error = parsed.problems.join('; ');

  const failed = error !== null;
  const counts = {};
  for (const f of parsed.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const rec = {
    schema: 1, status: failed ? 'failed' : 'ok', runId: reserved.id, ref: prep.ref, base: prep.base, head: prep.head, model: m.model, band: m.band,
    ts: new Date(now()).toISOString(), durationMs: run.durationMs ?? null, timedOut: Boolean(run.timedOut), error, format: parsed.format, clean: parsed.clean,
    modelVerified: parsed.modelVerified, usage: parsed.usage, cursorSessionId: parsed.sessionId, problems: parsed.problems,
    counts, findings: failed ? [] : parsed.findings,
  };
  const when = stamp(new Date(now()));
  const stem = path.join(opts.outDir, `${when.day}-cursor-review-${safe(prep.ref)}-${when.time}`);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(`${stem}.raw.json`, run.stdout ?? '');
  writeFileSync(`${stem}.findings.json`, `${JSON.stringify(rec, null, 2)}\n`);
  writeFileSync(`${stem}.summary.txt`, summaryText(rec));
  finishRun(opts.ledgerPath, reserved.id, {
    ref: prep.ref, model: m.model, band: m.band, sessionId, durationMs: rec.durationMs, exit: failed ? EXIT.FAILED : EXIT.OK, timedOut: rec.timedOut,
    modelVerified: rec.modelVerified, findingCount: rec.findings.length, usage: parsed.usage, ...(failed ? { error: clip(error, 300) } : {}),
  }, { now });
  if (!opts.keepTree) prep.cleanup();
  return { exit: failed ? EXIT.FAILED : EXIT.OK, runId: reserved.id, findingsPath: `${stem}.findings.json`, summaryPath: `${stem}.summary.txt`, rawPath: `${stem}.raw.json`, error };
}

// ---------- command line ----------

export function parseArgs(argv) {
  const out = { input: null };
  const bad = (error) => ({ error });
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--pr': { const v = next(); if (!/^\d+$/.test(v ?? '')) return bad(`--pr needs a PR number, got ${JSON.stringify(v)}`); if (out.input) return bad('pass --pr or --range, not both'); out.input = { pr: Number(v) }; break; }
      case '--range': { const v = next(); if (!/^[^\s.]\S*?\.{2,3}[^\s.]\S*$/.test(v ?? '')) return bad(`--range needs <base>..<head>, got ${JSON.stringify(v)}`); if (out.input) return bad('pass --pr or --range, not both'); out.input = { range: v }; break; }
      case '--band': out.band = next(); break;
      case '--model': out.model = next(); break;
      case '--timeout-sec': { const v = Number(next()); if (!Number.isFinite(v) || v < 1) return bad('--timeout-sec needs a number of at least 1'); out.timeoutMs = v * 1000; break; }
      case '--ledger': out.ledgerPath = next(); break;
      case '--out-dir': out.outDir = next(); break;
      case '--repo': out.repo = next(); break;
      case '--remote': out.remote = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--keep-tree': out.keepTree = true; break;
      default: return bad(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  if (!out.input) return bad('pass --pr <n> or --range <base>..<head>');
  return out;
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

/** Returns the exit code. deps (tests): runReview deps plus ledgerPath, stdout, stderr. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) { stderr(`cursor-review: ${args.error}`); return EXIT.REFUSED; }
  const env = deps.env ?? process.env;
  const root = deps.root ?? repoRoot();
  const opts = { ...args, root, ledgerPath: args.ledgerPath ?? deps.ledgerPath ?? defaultLedgerPath(env), outDir: args.outDir ?? deps.outDir ?? path.join(root, '.claude', 'cache', 'e2e') };
  const r = await runReview(opts, { ...deps, stdout, stderr });
  if (r.summaryPath) {
    stdout(readFileSync(r.summaryPath, 'utf8').trimEnd());
    stdout(`findings: ${r.findingsPath}`);
    stdout(`summary:  ${r.summaryPath}`);
  }
  return r.exit;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
