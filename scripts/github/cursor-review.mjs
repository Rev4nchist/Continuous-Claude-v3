#!/usr/bin/env node
/**
 * cursor-review.mjs: the local Cursor review runner of the review matrix (.claudedocs/2026-11-01-review-matrix.md, 3.2 and 3.3).
 *
 * Usage:
 *   node scripts/github/cursor-review.mjs (--pr <n> | --range <base>..<head>) (--band MID|ELEVATED|HIGH|CRITICAL | --model <id>)
 *        [--timeout-sec 2400] [--ledger <file>] [--out-dir <dir>] [--repo owner/name] [--remote fork] [--dry-run] [--keep-tree]
 *
 * What it does:
 *   1. Checks the model. Only grok-4.7-high and grok-4.7-xhigh run. Auto, any id with "fast", an unknown id and a missing
 *      model are refused. The CLI default model is never used. The band picks the model (CRITICAL: xhigh, else high; LOW: no Cursor).
 *   2. Checks the usage ledger (default ~/.claude/state/cursor-review-ledger.jsonl): at most 300 runs in a rolling 7 days across
 *      all sessions, at most 8 per PR or range. A run is reserved under a lock before the agent starts.
 *   3. Builds a clean review tree: `git archive` of the head (no .git, no review docs, no old artifacts) plus PR.diff.
 *   4. Runs `cursor-agent -p --mode ask --trust --output-format stream-json --model <m>` in that tree. On Windows it runs the agent's
 *      own node.exe on index.js (the way cursor-agent.ps1 does), not the .cmd or .ps1 wrapper, so the pid it holds is the agent.
 *      A time-out (default 2400 s: grok output speed halved under load on 2026-11-02, so a ~40k-token answer took ~1600 s) stops that pid and its whole process tree.
 *      A machine-wide gate (lib/grok-slots.mjs) lets at most 2 runs go at once across all sessions; a run waits up to 60 min for a
 *      slot, and the time-out starts after it. CCV3_GROK_GATE=off skips the gate; CCV3_GROK_MAX_CONCURRENT changes the 2.
 *      On Windows it also (a) puts Git Bash first on the agent PATH (buildAgentEnv: hooks get that PATH, so a hook's `bash` is not the
 *      System32 WSL shim) and tests, before it starts, that `bash` runs in PowerShell with that env when an enabled hook uses bash (preflightHooks), (b) keeps 10 s between cursor-agent starts
 *      machine-wide (spaceAgentStart: two starts in one second race on ~/.cursor/cli-config.json) and (c) stops a run whose first 3 tool
 *      calls each take 30 s or more (tool-stall).
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
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from './lib/file-lock.mjs';
import { acquireGrokSlot } from './lib/grok-slots.mjs';
import { killTree } from './lib/proc.mjs';

export const EXIT = { OK: 0, FAILED: 1, REFUSED: 2, CAP: 3 };
export const MODEL_ALLOWLIST = new Set(['grok-4.7-high', 'grok-4.7-xhigh']);
export const BAND_MODEL = { MID: 'grok-4.7-high', ELEVATED: 'grok-4.7-high', HIGH: 'grok-4.7-high', CRITICAL: 'grok-4.7-xhigh' };
export const WEEKLY_CAP = 300;
export const WEEK_MS = 7 * 86_400_000;
export const PER_REF_CAP = 8;
export const DEFAULT_TIMEOUT_SEC = 2400;
export const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const SEVERITIES = ['critical', 'major', 'minor', 'info'];
/** Folders left out of the review tree: answers and old review output the model must not see. */
export const TREE_EXCLUDES = Object.freeze(['.git', '.claudedocs', '.claude/cache', '.claude/reviews', 'artifacts', 'thoughts']);
/**
 * Files and folders the review agent must never read as instructions, at any depth. Cursor loads agent rules (AGENTS.md, CLAUDE.md,
 * .cursorrules, .cursor), runs Claude Code project hooks (.claude/settings*.json) and starts MCP servers (.mcp.json) from the tree it
 * runs in, and it runs with --trust. A PR could add any of them and have its own review run them. PR.diff keeps their diff as data.
 */
export const AGENT_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.cursor', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json']);

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

/** The number of distinct runs inside the rolling window (optionally for one ref). A run counts by its earliest line. Runs that never started are skipped. */
export function countRuns(entries, { now, ref, windowMs = WEEK_MS }) {
  const first = new Map();
  // A run whose end line says notStarted (no grok slot came free, the agent never spawned) used no Cursor run: it is not counted.
  const unstarted = new Set(entries.filter((e) => e.notStarted === true && e.id).map((e) => e.id));
  entries.forEach((e, i) => {
    const key = e.id ?? `line-${i}`;
    if (unstarted.has(key)) return;
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
 * The final result of an agent run: the JSON text of the last stdout line that parses as an object with type 'result', else null. Pure.
 * `--output-format json` (one result line) and `--output-format stream-json` (system, user, thinking, tool_call and assistant events, then
 * the result) both end in that line, with the same fields: type, subtype, is_error, duration_ms, duration_api_ms, result, session_id,
 * request_id, usage (fixtures/cursor-review/cursor-238.json; .claude/cache/e2e/2026-11-03-trex-author-S18.raw.json, last line).
 */
export function resultFromStream(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const l of lines.reverse()) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && o.type === 'result') return l;
    } catch { /* not a JSON line */ }
  }
  return null;
}

/**
 * Parses the stdout of `cursor-agent --output-format json` or `stream-json` (resultFromStream finds the result line). Pure.
 * { ok, isError, format: 'json' | 'markdown' | 'none', findings, clean, problems, usage, sessionId, durationMs, modelVerified, modelMismatch, text }
 * ok is false for an error result and for an answer with no findings block and no recognisable headings: "no major bugs" in
 * prose is not a pass.
 */
export function parseReviewOutput(stdout, { expectModel } = {}) {
  const base = { ok: false, isError: false, format: 'none', findings: [], clean: false, problems: [], usage: null, sessionId: null, durationMs: null, modelVerified: false, modelMismatch: false, text: '' };
  const line = resultFromStream(stdout);
  const result = line === null ? null : JSON.parse(line);
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

/** Credentials that never reach the agent. See buildAgentEnv. */
const SECRET_VARS = ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** POSIX shell variables that a Git Bash session sets. See buildAgentEnv. */
const POSIX_SHELL_VARS = ['SHELL', 'MSYSTEM', 'BASH', 'BASH_ENV'];

/** The key of the PATH variable in `env`, in its real casing (Windows copies hold `Path`), or undefined. */
const pathKey = (env) => Object.keys(env).find((k) => k.toLowerCase() === 'path');

/**
 * The folder whose bash.exe is Git Bash (Git for Windows), or null. Order: GIT_BASH_DIR, then the `..\bin` of the first PATH entry that
 * holds git.exe and whose `..\bin` holds bash.exe (Git\cmd\git.exe gives Git\bin; Git\mingw64\bin has no bash.exe, so the walk goes on),
 * then <ProgramFiles>\Git\bin. Reads no process table. Windows path rules; `exists` is injected for tests.
 */
export function resolveGitBashDir(env = process.env, { exists = existsSync } = {}) {
  const w = path.win32;
  const hasBash = (dir) => exists(w.join(dir, 'bash.exe'));
  const own = String(env.GIT_BASH_DIR ?? '').trim().replace(/[\\/]+$/, '');
  if (own && hasBash(own)) return own;
  const key = pathKey(env);
  for (const raw of key ? String(env[key]).split(';') : []) {
    const entry = raw.trim().replace(/^"|"$/g, '');
    if (!entry || !exists(w.join(entry, 'git.exe'))) continue;
    const bin = w.join(entry, '..', 'bin');
    if (hasBash(bin)) return bin;
  }
  const fallback = w.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin');
  return hasBash(fallback) ? fallback : null;
}

/** True when two PATH entries name the same folder: quotes, slash style, trailing slash and case are ignored. */
const samePathEntry = (a, b) => {
  const n = (x) => path.win32.normalize(x.trim().replace(/^"|"$/g, '')).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
};

/**
 * The environment for cursor-agent. Cursor runs the user's Claude Code hooks through `process.env.SHELL` when it is set. A session
 * started from Git Bash has SHELL=/bin/bash.exe, and bash cannot run Cursor's PowerShell hook launcher: every tool call then ends
 * "Hook blocked with message: --: eval: line 1: syntax error near unexpected token `('" (2026-11-01: all reads blocked, the model
 * still answered {"findings":[]}). The bake-off, started from PowerShell, had no SHELL and worked. So on Windows these variables are
 * dropped. It also sets what cursor-agent.cmd and cursor-agent.ps1 set (CURSOR_INVOKED_AS, NODE_COMPILE_CACHE).
 *
 * PATH guard (Windows only): the Git Bash folder (resolveGitBashDir) becomes the FIRST PATH entry, so a plugin hook that runs `bash`
 * gets Git Bash and not C:\Windows\system32\bash.exe, the WSL shim (2026-11-03: with WSL frozen every hook waited 60 s and every tool
 * call took 61 s; .claudedocs/2026-11-03-grok-slowdown-investigation.md). The PATH key keeps its casing and the folder is listed once.
 * Live test 2026-11-03 (hook `command -v bash`, one composer-2.5 run): Git Bash first on PATH -> the hook ran /usr/bin/bash (MINGW64), glob tool call 4.3 s; System32 WSL bash first and frozen -> hook killed at its 20 s time-out, tool call 21.2 s. So hooks get the PATH given to cursor-agent.
 * CCV3_BASH_GUARD in the result is that folder, or 'unresolved' when no Git Bash exists (PATH is then unchanged; the caller can log it).
 * Does not change `base`. `exists` is injected for tests.
 */
export function buildAgentEnv(base = process.env, platform = process.platform, { exists = existsSync } = {}) {
  const env = { ...base };
  // The agent has no use for these and runs a PR's tree: its own key and the GitHub tokens must not reach it.
  for (const k of SECRET_VARS) delete env[k];
  if (platform === 'win32') {
    for (const k of POSIX_SHELL_VARS) delete env[k];
    env.CURSOR_INVOKED_AS = 'cursor-agent.cmd';
    env.NODE_COMPILE_CACHE ||= path.win32.join(env.LOCALAPPDATA || os.tmpdir(), 'cursor-compile-cache');
    const dir = resolveGitBashDir(env, { exists });
    if (dir) {
      const key = pathKey(env) ?? 'Path';
      const rest = String(env[key] ?? '').split(';').filter((e) => e.trim() && !samePathEntry(e, dir));
      env[key] = [dir, ...rest].join(';');
    }
    env.CCV3_BASH_GUARD = dir ?? 'unresolved';
  } else {
    env.CURSOR_INVOKED_AS ||= 'cursor-agent';
  }
  return env;
}

// ---------- hook-shell preflight ----------

const GROK_REPORT = '.claudedocs/2026-11-03-grok-slowdown-investigation.md';
/** The text of a run that did not start because a Cursor hook runs `bash` and bash hangs where the hook runs. */
export const HOOK_BASH_MSG = `a Cursor hook runs bash and bash hangs in the PowerShell that cursor-agent uses, with the PATH given to the agent (WSL?); see ${GROK_REPORT}`;
export const HOOK_PROBE_MS = 10_000;

/** The first word of a command line; a quoted first word may hold spaces ("C:\Program Files\Git\bin\bash.exe" x.sh). */
function firstWord(segment) {
  const m = segment.trim().match(/^"([^"]*)"|^'([^']*)'|^(\S+)/);
  return m ? (m[1] ?? m[2] ?? m[3]) : '';
}

/** True when a hook command line runs bash, sh or wsl: the first word of the line or of any part after `|`, `&&`, `||`, `;`. */
export function isBashCommand(command) {
  if (typeof command !== 'string') return false;
  return command.split(/&&|\|\||[|;&]/).some((seg) => {
    const name = firstWord(seg).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    return name === 'bash' || name === 'sh' || name === 'wsl';
  });
}

const readJson = (fs, file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const listDir = (fs, dir) => { try { return fs.readdirSync(dir).map(String); } catch { return []; } };

/** Every string `command` in a hooks JSON, at any depth (Cursor and Claude layouts nest it differently). */
function commandsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => commandsIn(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.command === 'string') out.push(node.command);
    Object.values(node).forEach((n) => commandsIn(n, out));
  }
  return out;
}

/**
 * The bash hook commands cursor-agent would run: [{ file, command }]. Sources: <home>\.cursor\hooks.json, and for each plugin folder
 * <home>\.cursor\plugins\cache\<market>\<plugin>\<hash>\ the file that .cursor-plugin\plugin.json names under "hooks" (a string path, or
 * an inline object). Only that file is read. A renamed or deleted hooks file reads as no hooks. Reads only; `fs` = { readdirSync, readFileSync }.
 */
export function findBashHooks({ home, fs = { readdirSync, readFileSync } }) {
  const w = path.win32;
  const cursor = w.join(home, '.cursor');
  const sources = [{ file: w.join(cursor, 'hooks.json'), json: undefined }];
  const cache = w.join(cursor, 'plugins', 'cache');
  for (const market of listDir(fs, cache)) {
    for (const plugin of listDir(fs, w.join(cache, market))) {
      for (const hash of listDir(fs, w.join(cache, market, plugin))) {
        const dir = w.join(cache, market, plugin, hash);
        const manifestFile = w.join(dir, '.cursor-plugin', 'plugin.json');
        const hooks = readJson(fs, manifestFile)?.hooks;
        if (typeof hooks === 'string') sources.push({ file: w.resolve(dir, hooks), json: undefined });
        else if (hooks && typeof hooks === 'object') sources.push({ file: manifestFile, json: hooks });
      }
    }
  }
  const found = [];
  for (const { file, json } of sources) {
    for (const command of commandsIn(json ?? readJson(fs, file))) if (isBashCommand(command)) found.push({ file, command });
  }
  return found;
}

/**
 * Tests the shell a Cursor hook really gets. cursor-agent runs a hook through `powershell.exe -ExecutionPolicy Bypass -NonInteractive -File
 * %TEMP%\ps-script-<uuid>.ps1`, and that PowerShell gets cursor-agent's own env (its process.env plus hook variables), so a hook's `bash` is
 * the first bash on the PATH we pass to cursor-agent (live test 2026-11-03, see buildAgentEnv). With Git Bash first it is Git Bash; if no
 * Git Bash was found, it can be C:\Windows\system32\bash.exe, which starts wsl.exe and hangs when WSL is frozen. This runs that case
 * before the agent starts. `env` must be the AGENT env (the env after buildAgentEnv that is passed to cursor-agent). (a) findBashHooks;
 * (b) none: ok at once, nothing spawned; (c) some: `powershell.exe -NoProfile -NonInteractive -Command 'bash -c "exit 0"'` with `env`,
 * hidden, SIGKILL after 10 s, no pipes (a stuck wsl.exe grandchild cannot hold one open). A time-out, a non-zero exit or a spawn error
 * fails. win32 only; other platforms pass.
 * { ok, hooks, ms, skipped? | reason? }; the reason names the first hook file and the report. deps are for tests.
 */
export function preflightHooks({ env = process.env, home, platform = process.platform, fs, spawnSyncFn = spawnSync, timeoutMs = HOOK_PROBE_MS } = {}) {
  if (platform !== 'win32') return { ok: true, hooks: [], ms: 0, skipped: 'not win32' };
  const hooks = findBashHooks({ home: home ?? env.USERPROFILE ?? os.homedir(), fs });
  if (hooks.length === 0) return { ok: true, hooks, ms: 0, skipped: '0 bash hooks found' };
  const t0 = Date.now();
  const r = spawnSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'bash -c "exit 0"'], { env, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', stdio: 'ignore' });
  const ms = Date.now() - t0;
  const fail = (why) => ({ ok: false, hooks, ms, reason: `bash -c "exit 0" in Windows PowerShell with the agent PATH ${why}; hook ${hooks[0].file}${hooks.length > 1 ? ` (+${hooks.length - 1} more)` : ''}: ${hooks[0].command}; report ${GROK_REPORT}` });
  if (r.error?.code === 'ETIMEDOUT') return fail(`timed out after ${Math.round(timeoutMs / 1000)} s`);
  if (r.error) return fail(`failed to run: ${r.error.message}`);
  if (r.status !== 0) return fail(`ended with exit ${r.status}`);
  return { ok: true, hooks, ms };
}

// ---------- start spacing and the cli-config race ----------

/** Least time between two cursor-agent starts, machine-wide. */
export const START_GAP_MS = 10_000;
/** An agent that dies this fast with the cli-config.json rename error never ran. */
export const CLI_CONFIG_RACE_MS = 15_000;
const CLI_CONFIG_RACE_RE = /EPERM: operation not permitted, rename .*cli-config\.json/;
/** A stamp this far ahead of the clock is junk (a bad clock or file), not a queue. */
const STAMP_FUTURE_LIMIT_MS = 10 * 60_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The start stamp file: next to the grok slot state (opts.file, CCV3_GROK_SLOTS_FILE, else ~/.claude/state), so both are machine-wide state in one folder. */
export function startStampPath(gateOpts = {}, env = process.env) {
  const slots = gateOpts.file || env.CCV3_GROK_SLOTS_FILE || path.join(os.homedir(), '.claude', 'state', 'grok-slots.json');
  return path.join(path.dirname(slots), 'cursor-agent-start.json');
}

/**
 * Two cursor-agent processes started in the same second both rewrite ~/.cursor/cli-config.json; one dies at once with EPERM on the rename
 * (session 5cbfb659). So starts are queued: under withLock (lib/file-lock.mjs) on the stamp file the caller books the first start time at
 * least `gapMs` after the last booked one, then sleeps the rest OUTSIDE the lock. Each caller books a later time, so starts in one instant
 * leave gapMs between them. Never throws: a lock miss or a file error returns { waitedMs: 0, lock: false } (a broken stamp must not stop
 * reviews). { waitedMs, startAt, lock? }. deps (tests): now, sleep, lockOpts.
 */
export async function spaceAgentStart({ file, gapMs = START_GAP_MS, now = Date.now, sleep = realSleep, lockOpts } = {}) {
  let booked;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    booked = withLock(file, lockOpts ?? {}, () => {
      const t = now();
      let last = -Infinity;
      try {
        const v = Number(JSON.parse(readFileSync(file, 'utf8')).lastStartAt);
        if (Number.isFinite(v) && v <= t + STAMP_FUTURE_LIMIT_MS) last = v;
      } catch { /* a missing or corrupt stamp means no earlier start */ }
      const startAt = Math.max(t, last + gapMs);
      writeFileSync(file, JSON.stringify({ lastStartAt: startAt }));
      return { t, startAt };
    });
  } catch (err) { return { waitedMs: 0, lock: false, detail: String(err?.message ?? err) }; }
  if (booked?.ok === false) return { waitedMs: 0, lock: false, detail: booked.detail };
  const waitedMs = booked.startAt - booked.t;
  if (waitedMs > 0) await sleep(waitedMs);
  return { waitedMs, startAt: booked.startAt };
}

/**
 * An agent that exits non-zero within `windowMs` with the cli-config.json rename error lost the start race: it never ran, so it is a
 * not-started result (error 'cli-config-race'), like a missing slot, and the ledger does not count it.
 */
function markCliConfigRace(run, windowMs) {
  if (typeof run.status !== 'number' || run.status === 0 || run.timedOut || !(run.durationMs <= windowMs)) return run;
  if (!CLI_CONFIG_RACE_RE.test(`${run.stderr}\n${run.stdout}`)) return run;
  return { ...run, notStarted: true, error: 'cli-config-race', toolStats: null };
}

// ---------- tool-stall detector (stream-json) ----------

/** A successful tool call this slow is a stall (healthy calls take under 2 s; the 2026-11-02 hook stall was 61 s). */
export const STALL_MS = 30_000;
/** The run stops when its first STALL_CALLS successful tool calls each took STALL_MS or more. */
export const STALL_CALLS = 3;

/** True when the agent args ask for stream-json output. */
export const isStreamJson = (args = []) => args.some((a, i) => a === '--output-format=stream-json' || (a === '--output-format' && args[i + 1] === 'stream-json'));

/**
 * One stream-json line as a completed tool call: { startedAt, completedAt, ok } (epoch ms), else null. Fields (cursor-agent stream,
 * .claude/cache/e2e/2026-11-03-trex-author-S18.raw.json): type 'tool_call', subtype 'completed', tool_call.startedAtMs and
 * tool_call.completedAtMs (decimal strings), tool_call.<kind>ToolCall.result.success (ok) or .result.error (failed).
 */
export function readToolCall(line) {
  if (!line.includes('tool_call') || !line.includes('completed')) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev?.type !== 'tool_call' || ev.subtype !== 'completed' || !ev.tool_call) return null;
  const tc = ev.tool_call;
  const startedAt = Number(tc.startedAtMs);
  const completedAt = Number(tc.completedAtMs);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return null;
  const kind = Object.keys(tc).find((k) => k.endsWith('ToolCall') && tc[k] && typeof tc[k] === 'object');
  const result = kind ? tc[kind].result : undefined;
  return { startedAt, completedAt, ok: Boolean(result && result.success !== undefined && result.error === undefined) };
}

/**
 * Reads stdout chunks of a stream-json run line by line (a line may span chunks). feed(chunk) returns the stall times
 * (STALL_CALLS numbers) once the first STALL_CALLS successful calls were all >= STALL_MS, else null. Failed calls do not count for
 * the stall rule. stats() covers every completed call: { toolCalls, toolWaitMs (merged in-flight time), maxToolMs }.
 */
export function createToolTracker() {
  let carry = '';
  let stall = null;
  const calls = [];
  const okTimes = [];
  const take = (line) => {
    const c = readToolCall(line);
    if (!c) return;
    calls.push(c);
    if (!c.ok || okTimes.length >= STALL_CALLS) return;
    okTimes.push(c.completedAt - c.startedAt);
    if (okTimes.length === STALL_CALLS && okTimes.every((ms) => ms >= STALL_MS)) stall = [...okTimes];
  };
  const feed = (chunk) => {
    carry += chunk;
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const l of lines) take(l);
    // A last line with no newline yet: read it as soon as it is complete JSON.
    if (carry.endsWith('}') && readToolCall(carry)) { take(carry); carry = ''; }
    return stall;
  };
  const flush = () => { if (carry) { take(carry); carry = ''; } return stall; };
  const stats = () => {
    let wait = 0;
    let from = null;
    let to = null;
    for (const c of [...calls].sort((a, b) => a.startedAt - b.startedAt)) {
      if (from === null) { from = c.startedAt; to = c.completedAt; } else if (c.startedAt <= to) to = Math.max(to, c.completedAt); else { wait += to - from; from = c.startedAt; to = c.completedAt; }
    }
    if (from !== null) wait += to - from;
    return { toolCalls: calls.length, toolWaitMs: wait, maxToolMs: calls.reduce((m, c) => Math.max(m, c.completedAt - c.startedAt), 0) };
  };
  return { feed, flush, stats };
}

/** How long a time-out waits for the agent to die before it gives up. The grok gate adds it to the slot's lifetime. */
const KILL_GRACE_MS = 8000;
/** Extra life for a slot entry beyond the run time-out and the kill grace. */
const SLOT_MARGIN_MS = 60_000;

function defaultKiller(pid) {
  killTree(pid);
}

/**
 * Runs the agent behind the machine-wide grok gate (lib/grok-slots.mjs): at most 2 cursor-agent runs at once across all sessions
 * (2026-11-02 ledger: solo runs 0 time-outs, overlapping runs 5 of 6). It waits for a slot, spawns, and frees the slot on every exit
 * path. The agent time-out starts after the slot is taken. With no slot after the wait it resolves without a spawn:
 * { status: null, error: 'grok-busy', timedOut: false, notStarted: true, durationMs: 0, waitedMs }. Every result has waitedMs (the
 * wait for the slot) and, when the agent started, spawnedAt (epoch ms); durationMs counts the agent only. CCV3_GROK_GATE=off skips the gate. A gate that cannot reach its state file
 * (reason 'lock', or a throw) is logged and the run goes ahead without a slot: a broken state file must not stop every review.
 * On win32 it first runs preflightHooks({ env: spec.env }) with the agent env (hooks get the PATH we pass to cursor-agent), before
 * the gate and before any spawn (also with the gate off). When a hook's bash hangs it resolves at once, with no slot and no spawn, like the
 * busy result: { status: null, error: 'hook-bash-hang', notStarted: true, timedOut: false, durationMs: 0, waitedMs: 0, stderr: HOOK_BASH_MSG
 * + reason }. A preflight that throws is logged and skipped.
 * On win32, after the slot is taken and just before the spawn (also with the gate off), it books a start time at least START_GAP_MS after
 * the last cursor-agent start on the machine (spaceAgentStart) and waits for it; the run time-out starts after. Two agents that start in one
 * second race on ~/.cursor/cli-config.json. A spacer that throws is logged and skipped. An agent that exits non-zero within
 * CLI_CONFIG_RACE_MS with that rename error (EPERM) is returned as { notStarted: true, error: 'cli-config-race' } after the slot is released.
 * In stream-json mode a stall (see spawnAgent) ends the run with status 1, error 'tool-stall' and stallMs. The result has toolStats
 * ({ toolCalls, toolWaitMs, maxToolMs }; null in json mode).
 * deps: { spawnFn, killer, killGraceMs, gate = acquireGrokSlot, gateOpts, gateEnv = process.env, gateLog, preflight = preflightHooks,
 * spacer = spaceAgentStart, raceWindowMs = CLI_CONFIG_RACE_MS, platform = process.platform }. The slot lives until the run time-out + killGraceMs + 60 s (gateOpts.ttlMs overrides) and records
 * the agent pid. Never throws.
 */
export async function runAgent(spec, deps = {}) {
  const { gate = acquireGrokSlot, gateOpts = {}, gateEnv = process.env, gateLog = (m) => process.stderr.write(`${m}\n`), preflight = preflightHooks, spacer = spaceAgentStart, raceWindowMs = CLI_CONFIG_RACE_MS, platform = process.platform, ...spawnDeps } = deps;
  if (platform === 'win32') {
    let pf = { ok: true };
    try { pf = await preflight({ env: spec.env ?? process.env }); } catch (err) { gateLog(`hook preflight: not usable (${err?.message ?? err}); running without it`); }
    if (!pf.ok) return { status: null, stdout: '', stderr: `${HOOK_BASH_MSG}: ${pf.reason ?? 'preflight failed'}`, timedOut: false, error: 'hook-bash-hang', notStarted: true, durationMs: 0, waitedMs: 0, toolStats: null };
  }
  const launch = async (extra = {}) => {
    if (platform === 'win32') {
      try { await spacer({ file: startStampPath(gateOpts, gateEnv) }); } catch (err) { gateLog(`start spacing: not usable (${err?.message ?? err}); starting now`); }
    }
    return markCliConfigRace(await spawnAgent(spec, { ...spawnDeps, ...extra }), raceWindowMs);
  };
  if (String(gateEnv.CCV3_GROK_GATE ?? '').trim().toLowerCase() === 'off') return { waitedMs: 0, ...(await launch()) };
  let slot;
  const ttlMs = spec.timeoutMs + (spawnDeps.killGraceMs ?? KILL_GRACE_MS) + SLOT_MARGIN_MS;
  try { slot = await gate({ ttlMs, ...gateOpts }); } catch (err) { slot = { ok: false, reason: 'lock', detail: String(err?.message ?? err) }; }
  if (!slot.ok && slot.reason === 'busy') {
    const waited = slot.waitedMs ?? 0;
    return { status: null, stdout: '', stderr: `grok gate: no slot in ${Math.round(waited / 60_000)} min`, timedOut: false, error: 'grok-busy', notStarted: true, durationMs: 0, waitedMs: waited, toolStats: null };
  }
  if (!slot.ok) gateLog(`grok gate: not usable (${slot.reason}: ${slot.detail}); running without a slot`);
  const onSpawn = (pid) => { try { slot.attach?.(pid); } catch { /* the entry then follows this process only, and expires */ } };
  try { return { waitedMs: slot.waitedMs ?? 0, ...(await launch({ onSpawn })) }; } finally {
    if (slot.ok) { try { await slot.release(); } catch { /* release never rejects; a failure here must not hide the result */ } }
  }
}

/**
 * Spawns the agent and resolves when it ends. A time-out stops the agent pid and its whole process tree (killTree from lib/proc.mjs:
 * the Windows tree-kill switch is forbidden here, so it walks the process table). Never throws; a spawn error is a result.
 * { status, stdout, stderr, timedOut, error, durationMs, toolStats, stallMs? }. Stream-json runs (--output-format stream-json) are read line by line
 * (createToolTracker): when the first STALL_CALLS successful tool calls each took STALL_MS or more, the agent tree is stopped at once and the
 * result is status 1, error 'tool-stall', stallMs [..], timedOut false.
 */
function spawnAgent({ command, args, cwd, timeoutMs, env = process.env }, { spawnFn = spawn, killer = defaultKiller, killGraceMs = KILL_GRACE_MS, onSpawn } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let error;
    let child;
    let stallMs = null;
    const tracker = isStreamJson(args) ? createToolTracker() : null;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      tracker?.flush();
      resolve({
        status, stdout, stderr, timedOut, error, spawnedAt: started, durationMs: Date.now() - started,
        ...(stallMs ? { stallMs } : {}), toolStats: tracker ? tracker.stats() : null,
      });
    };
    // The tool-stall stop mirrors the time-out: stop the tree, wait for the close (or the grace), then resolve with exit 1.
    const stall = async (times) => {
      stallMs = times;
      error = 'tool-stall';
      clearTimeout(limit);
      try { await killer(child?.pid); } catch { /* the grace timer below ends the wait */ }
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(() => finish(1), killGraceMs).unref();
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
    try { onSpawn?.(child.pid); } catch { /* a slot note must not stop the run */ }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (settled) return;
      stdout += c;
      if (!tracker || stallMs || timedOut) return;
      const times = tracker.feed(c);
      if (times) stall(times);
    });
    child.stderr.on('data', (c) => { if (!settled) stderr += c; });
    child.on('error', (err) => { error = String(err.message); finish(null); });
    child.on('close', (code) => finish(timedOut ? null : stallMs ? 1 : code));
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
 * Writes the files of commit `head` into `dir` with git itself, through a temp index in `work`: no tar, so the shell PATH cannot
 * change how file names are read (Windows PowerShell finds bsdtar first, which mangles UTF-8 names). The repo's own index is untouched.
 */
export function defaultExtract({ dir, work, root, head }) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(work, 'index') };
  const git = (args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const read = git(['read-tree', head]);
  if (read.error || read.status !== 0) return read;
  return git(['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', 'checkout-index', '-a', '-f', `--prefix=${dir.replaceAll('\\', '/')}/`]);
}

/**
 * True when `rel` (a git path, so always forward slashes) is one of TREE_EXCLUDES or sits under one. Matches whole path segments:
 * "artifacts-extra" is not "artifacts". On win32 the match ignores case, as the file system does, so it agrees with the rmSync of the folder.
 */
export function isExcluded(rel, platform = process.platform) {
  const fold = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const p = fold(String(rel).replace(/^\.\//, ''));
  return TREE_EXCLUDES.some((x) => p === fold(x) || p.startsWith(`${fold(x)}/`));
}

/**
 * True when `rel` (a git path, so forward slashes) is an AGENT_FILES entry or sits under one, at any depth: "a/b/AGENTS.md" and
 * "x/.cursor/rules/r.mdc" match. An entry matches whole path segments ("MY-AGENTS.md" does not match) and may span segments
 * (".claude/settings.json"). On win32 the match ignores case, as the file system does, so it agrees with the rmSync of the entry.
 */
export function isAgentFile(rel, platform = process.platform) {
  const fold = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const segs = fold(String(rel).replace(/^\.\//, '').replaceAll('\\', '/')).split('/').filter(Boolean);
  return AGENT_FILES.some((entry) => {
    const want = fold(entry).split('/');
    for (let i = 0; i + want.length <= segs.length; i += 1) {
      if (want.every((w, j) => segs[i + j] === w)) return true;
    }
    return false;
  });
}

/** Removes every agent file and folder under `dir`, at every depth. A symlink is removed by name and never followed. Returns the git-style paths removed. */
export function stripAgentFiles(dir, platform = process.platform) {
  const removed = [];
  const walk = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (isAgentFile(childRel, platform)) {
        rmSync(path.join(abs, ent.name), { recursive: true, force: true });
        removed.push(childRel);
      } else if (ent.isDirectory()) {
        walk(path.join(abs, ent.name), childRel);
      }
    }
  };
  walk(dir, '');
  return removed;
}

/** Git pathspecs that leave TREE_EXCLUDES out of PR.diff. On win32 they ignore case (icase), as isExcluded and the folder rmSync do. */
export function excludePathspecs(platform = process.platform) {
  const magic = platform === 'win32' ? 'exclude,icase' : 'exclude';
  return TREE_EXCLUDES.map((x) => `:(${magic})${x}`);
}

/** Changed paths between two commits, as git reports them with -z (no quoting), minus the folders left out of the tree. */
function changedPaths(root, base, head, diffFilter) {
  // --no-renames: a file moved into an excluded folder still lists its old path (as a delete) instead of one excluded rename.
  const args = ['diff', '--name-only', '--no-renames', '-z', ...(diffFilter ? [`--diff-filter=${diffFilter}`] : []), base, head];
  return gitOut(root, args).split('\0').filter(Boolean).filter((f) => !isExcluded(f));
}

/** A directory entry exists, even a symlink whose target does not (existsSync follows the link). */
function entryExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * Resolves the input to base and head, then builds the clean tree. The diff base is the merge base, so a branch that merged
 * main shows only its own change. { ref, base, head, dir, files, agentFiles, cleanup }. agentFiles are the changed paths that were
 * left out of the tree (see AGENT_FILES); `files` still lists them.
 */
export async function prepareReview({ root, input, tmpRoot = os.tmpdir(), gh = defaultGh, repo = DEFAULT_REPO, remote = 'fork', extract = defaultExtract, platform = process.platform }) {
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
    const tar = extract({ dir, work, root, head });
    if (tar.error) throw new Error(`tree checkout failed to start: ${tar.error.message}`);
    // Any non-zero status is a failed prepare: a part-way checkout leaves a partial tree, and a review of it could answer clean.
    if (tar.status !== 0) throw new Error(`tree checkout failed (status ${tar.status}): ${(tar.stderr ?? '').trim()}`);
    for (const x of TREE_EXCLUDES) rmSync(path.join(dir, x), { recursive: true, force: true });
    stripAgentFiles(dir, platform);
    writeFileSync(path.join(dir, 'PR.diff'), gitOut(root, ['diff', '--no-color', '--no-ext-diff', mergeBase, head, '--', '.', ...excludePathspecs(platform)]));
    const files = changedPaths(root, mergeBase, head);
    // A changed agent file is gone from the tree on purpose (its diff stays in PR.diff), so it is not "missing".
    const missing = changedPaths(root, mergeBase, head, 'ACMRT').filter((f) => !isAgentFile(f, platform) && !entryExists(path.join(dir, f)));
    if (missing.length > 0) throw new Error(`the review tree is missing ${missing.length} changed file(s): ${missing.slice(0, 5).join(', ')}`);
    const agentFiles = files.filter((f) => isAgentFile(f, platform));
    return { ref, base: mergeBase, head, dir, files, agentFiles, cleanup };
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

  const args = [...(agent.prefixArgs ?? []), '-p', '--mode', 'ask', '--trust', '--output-format', 'stream-json', '--model', m.model, prompt];
  const spec = { command: agent.cmd, args, cwd: prep.dir, timeoutMs, env: buildAgentEnv(env, deps.platform ?? process.platform, { exists: deps.exists }) };
  if (spec.env.CCV3_BASH_GUARD === 'unresolved') log('cursor-review: no Git Bash found (set GIT_BASH_DIR); `bash` on the agent PATH may be the WSL shim');
  const startedAt = now();
  let run;
  try { run = await (deps.runner ?? runAgent)(spec); } catch (err) { run = { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message), durationMs: now() - startedAt }; }
  const parsed = parseReviewOutput(run.stdout, { expectModel: m.model });

  let error = null;
  if (run.notStarted && run.error === 'hook-bash-hang') error = `${run.stderr?.startsWith(HOOK_BASH_MSG) ? run.stderr.trim() : HOOK_BASH_MSG}; the agent did not start (not counted against the caps)`;
  else if (run.notStarted && run.error === 'cli-config-race') error = `cli-config-race: cursor-agent died after ${Math.round((run.durationMs ?? 0) / 1000)} s on the ~/.cursor/cli-config.json rename (EPERM) because another cursor-agent started in the same second; the agent did not run (not counted against the caps); start it again`;
  else if (run.notStarted) error = `no grok slot came free in ${Math.round((run.waitedMs ?? 0) / 60_000)} min; the agent did not start (not counted against the caps)`;
  else if (run.timedOut) error = `TIMED OUT after ${Math.round(timeoutMs / 1000)} s: the agent and its process tree were stopped; no findings were read`;
  else if (run.error === 'tool-stall') error = `tool-stall: the first ${STALL_CALLS} successful tool calls each took ${STALL_MS / 1000} s or more (${(run.stallMs ?? []).join(', ')} ms); the agent and its process tree were stopped. See .claudedocs/2026-11-03-grok-slowdown-investigation.md`;
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
    waitedMs: run.waitedMs ?? 0, notStarted: Boolean(run.notStarted), ...(run.toolStats ? { toolStats: run.toolStats } : {}),
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
    modelVerified: rec.modelVerified, findingCount: rec.findings.length, usage: parsed.usage,
    waitedMs: rec.waitedMs, spawnedAt: run.spawnedAt ? new Date(run.spawnedAt).toISOString() : null, ...(run.notStarted ? { notStarted: true } : {}), ...(failed ? { error: clip(error, 300) } : {}),
    ...(run.toolStats ? { toolCalls: run.toolStats.toolCalls, toolWaitMs: run.toolStats.toolWaitMs, maxToolMs: run.toolStats.maxToolMs } : {}),
    ...(run.stallMs ? { stallMs: run.stallMs } : {}),
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
