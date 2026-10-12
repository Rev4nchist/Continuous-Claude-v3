#!/usr/bin/env node
/**
 * adversary.mjs — owns the Codex run for the codex-adversary agent and prints a receipt.
 *
 * Nothing else proves a GPT model wrote the review, so this script parses Codex's own log header
 * and prints one machine-checkable line (CODEX-RECEIPT) before any answer. A caller that does not
 * see a receipt with status=ok must not present a review as Codex's.
 *
 *   node adversary.mjs run --project <dir> --mode code|plan (--base <ref> | --staged | --unstaged |
 *        --working-tree | --diff-file <abs> | --plan <abs>) [--focus t] [--focus-file <abs>]
 *        [--context-file <abs>] [--room <abs>] [--model id] [--effort e] [--timeout-s n]
 *        [--via who] [--format md|json]
 *   node adversary.mjs verify <run-id> [--allow-stub]
 *   node adversary.mjs models
 *   node adversary.mjs lift --run <id> --skill s --scope t --claude-only n --codex-only n --both n --project <dir>
 *
 * Exit codes, run: ok 0; bad_model, bad_args, auth, cli_missing 2; timeout 4; every other status 3.
 * verify and lift: 0 pass, 1 fail, refused or crash. models: 0. A bad command line: 2.
 * A stub or CODEX_BIN_JS run prints `stub=1` or `bin=env` right after `v1`, so it never matches RECEIPT_OK_RE.
 * Env: CODEX_ADVERSARY_MODEL/EFFORT, CODEX_ADVERSARY_HOME (default ~/.claude), CODEX_MODELS_CACHE,
 * CODEX_BIN_JS, CODEX_ADVERSARY_STUB (tests only). Zero dependencies.
 */
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync,
  statSync, realpathSync, readdirSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default reviewer (Dave, 2026-10-12). Change both here; nowhere else carries the default.
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_EFFORT = 'xhigh';

// The single allowlist. An id enters only after a live probe (`/harness-update codex`).
// `ceiling` is the highest effort a review may send; notes follow the server's own descriptions.
export const MODELS = {
  'gpt-6.1-sol': { ceiling: 'max', note: 'Latest workhorse; the default reviewer.' },
  'gpt-6-astra': { ceiling: 'max', note: 'Frontier; security, data loss, final gates. Highest cost.' },
  'gpt-5.6-sol': { ceiling: 'max', note: 'Older workhorse; fallback for gpt-6.1-sol.' },
  'gpt-5.6-terra': { ceiling: 'max', note: 'Older balanced tier; fallback when Sol is limited.' },
  'gpt-5.6-luna': { ceiling: 'max', note: 'Older fast tier; cheapest. Re-check loops, small diffs.' },
};
// `ultra` is absent on purpose: it delegates to sub-agents, which every run disables.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const RECEIPT_OK_RE = /^CODEX-RECEIPT v1 status=ok run=\S+ model=gpt-[\w.-]+ /;

const MAX_DIFF = 400 * 1024;
const MAX_PLAN = 300 * 1024;
const MAX_PROMPT = 600 * 1024;
const MAX_TIMEOUT_S = 1800;
const DEFAULT_TIMEOUT_S = 540;
const EXIT = { ok: 0, bad_model: 2, bad_args: 2, auth: 2, cli_missing: 2, timeout: 4 };
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Fallback framing, a copy of the inline framing in the codex-adversary agent. Used only when the sibling file is missing.
const EMBEDDED_FRAMING = `You are performing an adversarial software review. Your job is to BREAK CONFIDENCE
in this change, not to validate it. Default to skepticism. Assume the change can
fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.

Prioritize attack surface in this order:
1. Auth, permissions, tenant isolation
2. Data loss, corruption, or unrecoverable state
3. Rollback / idempotency / re-entrancy hazards
4. Race conditions and ordering bugs
5. Observability gaps (silent failures, missing logs/metrics)
6. Schema drift, migration hazards, backward incompatibility
7. Cross-system contracts (API shape, event payload, retry semantics)

Finding bar:
- Every finding cites file:line and a confidence score 0.0-1.0
- Every finding has a concrete recommendation, not just "consider"
- NO style feedback. NO praise. NO summaries of what the code does.
- If you cannot find a real issue at a given confidence threshold, say so.

Output JSON:
{
  "verdict": "needs-attention" | "approve",
  "findings": [
    { "file": "path:line", "category": "...", "confidence": 0.0-1.0, "issue": "...", "recommendation": "..." }
  ]
}`;

// The no-tools directive: on Windows a read-only sandbox denies every subprocess, which stalls the run.
const NO_TOOLS = `Everything you need is inline above — the full diff (mode=code) or plan body
(mode=plan). Do NOT run shell commands, git, or file reads: on Windows the
\`--sandbox read-only\` here denies ALL subprocess spawns (even harmless reads),
which stalls or fork-storms the run. Review from the inline context only; if
something outside it is genuinely needed, say so in a finding instead of
attempting to fetch it.`;

/** A refusal or precondition failure: it ends the run with `status` and writes a receipt. */
class Refusal extends Error {
  constructor(status, message, choices = '') {
    super(message);
    this.status = status;
    this.choices = choices;
  }
}
const refuse = (status, message, choices) => new Refusal(status, message, choices);

// ---- parsers (pure) ----------------------------------------------------------------------

/**
 * Reads ONLY the block between the first two rules after `OpenAI Codex v<ver>`, and only before the
 * prompt echo (the first line that is exactly `user`). A header-shaped block inside the echo is ignored.
 */
export function parseHeader(logText) {
  const all = logText.split(/\r?\n/);
  const echoAt = all.findIndex((l) => l.trim() === 'user');
  const lines = echoAt < 0 ? all : all.slice(0, echoAt);
  const start = lines.findIndex((l) => /^OpenAI Codex v\S+/.test(l));
  if (start < 0) return null;
  const isRule = (l) => /^-{8,}\s*$/.test(l);
  const open = lines.findIndex((l, i) => i > start && isRule(l));
  const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && isRule(l));
  if (close < 0) return null;
  const fields = {};
  for (const line of lines.slice(open + 1, close)) {
    const m = /^([a-z ]+):\s*(.*?)\s*$/i.exec(line);
    if (m) fields[m[1].toLowerCase()] = m[2];
  }
  if (!fields.model) return null;
  return {
    cliVersion: /^OpenAI Codex v(\S+)/.exec(lines[start])[1], model: fields.model,
    provider: fields.provider ?? null, effort: fields['reasoning effort'] ?? null,
    sandbox: fields.sandbox ?? null, sessionId: fields['session id'] ?? null,
  };
}

/** The integer on the line after the LAST `tokens used` line; null when absent. */
export function parseTokens(logText) {
  const lines = logText.split(/\r?\n/);
  const at = lines.map((l) => l.trim()).lastIndexOf('tokens used');
  const next = at < 0 ? '' : (lines[at + 1] ?? '').trim().replace(/,/g, '');
  return /^\d+$/.test(next) ? Number(next) : null;
}

/** The answer as parsed JSON (object or array, ``` fences stripped), or null for prose. */
export function parseAnswer(text) {
  const body = text.trim().replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === 'object' ? value : null;
  } catch { return null; }
}

/**
 * First match wins. logText must already exclude the echoed prompt. The usage-limit and HTTP 400
 * patterns count only for a failed run (non-zero exit or no answer): a review may quote them.
 */
export function classify({ exitCode, timedOut, header, requestedModel, finalText, logText }) {
  const noAnswer = !finalText || !finalText.trim();
  const failing = exitCode !== 0 || noAnswer;
  if (timedOut) return 'timeout';
  if (failing && /You['’]ve hit your usage limit/.test(logText)) return 'usage_limited';
  if (failing && /"status":\s*400/.test(logText) && /not supported|requires a newer version/.test(logText)) return 'model_rejected';
  if (!header) return 'no_header';
  if (header.model !== requestedModel) return 'model_mismatch';
  if (header.provider !== 'openai') return 'provider_mismatch';
  if (noAnswer) return 'empty';
  return exitCode === 0 ? 'ok' : 'failed';
}

const dash = (v) => (v === null || v === undefined || v === '' ? '-' : v);

// A stub or env binary is marked right after `v1`, so RECEIPT_OK_RE (status=ok first) cannot match it.
const binMarker = (bin) => ({ stub: 'stub=1 ', env: 'bin=env ' }[bin] ?? '');

/** Line 1 of stdout. */
export function formatReceipt(r) {
  const sha = r.final_sha256 ? r.final_sha256.slice(0, 16) : '-';
  return `CODEX-RECEIPT v1 ${binMarker(r.bin)}status=${r.status} run=${r.run} model=${dash(r.model_observed)} ` +
    `requested=${dash(r.model_requested)} effort=${dash(r.effort)} provider=${dash(r.provider)} ` +
    `cli=${dash(r.cli)} session=${dash(r.session_id)} exit=${dash(r.exit_code)} ` +
    `final_bytes=${r.final_bytes} sha256=${sha} tokens=${dash(r.tokens)} duration_s=${r.duration_s} ` +
    `json=${r.json ? 1 : 0} via=${r.via}`;
}

// ---- model and effort ----------------------------------------------------------------------

export function validChoices() {
  const rows = Object.entries(MODELS).map(([id, m]) => `  ${id} (up to ${m.ceiling}) - ${m.note}`);
  return `Valid models:\n${rows.join('\n')}\nValid efforts: ${EFFORTS.join(', ')}`;
}

/** Flag, then env, then default. Refuses ids off the table and `ultra`. Never substitutes. */
export function pickModel(flags, env) {
  const model = flags.model || env.CODEX_ADVERSARY_MODEL || DEFAULT_MODEL;
  const effort = flags.effort || env.CODEX_ADVERSARY_EFFORT || DEFAULT_EFFORT;
  if (!Object.hasOwn(MODELS, model)) throw refuse('bad_model', `Model '${model}' is not on the allowlist`, validChoices());
  if (effort === 'ultra') throw refuse('bad_args', 'Effort ultra delegates to sub-agents, which this run disables', validChoices());
  if (!EFFORTS.includes(effort)) throw refuse('bad_args', `Effort '${effort}' is not known`, validChoices());
  return { model, effort };
}

function modelsCachePath(env) {
  return env.CODEX_MODELS_CACHE || join(homedir(), '.codex', 'models_cache.json');
}

/** { version, models: Map<slug, effort[]> } or null when the file is missing or malformed. */
export function readCache(env) {
  try {
    const data = JSON.parse(readFileSync(modelsCachePath(env), 'utf8'));
    if (!Array.isArray(data.models)) return null;
    const level = (l) => (typeof l === 'string' ? l : l?.effort);
    const entries = data.models.map((m) => [m.slug, (m.supported_reasoning_levels ?? []).map(level)]);
    return { version: String(data.client_version ?? ''), models: new Map(entries) };
  } catch { return null; }
}

function withinCeiling({ model, effort }, label) {
  if (EFFORTS.indexOf(effort) > EFFORTS.indexOf(MODELS[model].ceiling)) {
    throw refuse('bad_args', `${model} offers up to ${MODELS[model].ceiling}, not ${effort}`, validChoices());
  }
  return label;
}

/**
 * Checks the pick against the live cache. Only a cache written by the installed CLI version may
 * refuse: right after an upgrade the file still holds the old id list. Returns 'ok' | 'stale' | 'unreadable'.
 */
export function checkCache(pick, installed, env) {
  const cache = readCache(env);
  if (!cache) return withinCeiling(pick, 'unreadable');
  if (!installed || cache.version !== installed) return withinCeiling(pick, 'stale');
  const levels = cache.models.get(pick.model);
  if (!levels) throw refuse('bad_model', `Codex CLI ${installed} does not offer '${pick.model}'`, validChoices());
  if (!levels.includes(pick.effort)) {
    throw refuse('bad_args', `${pick.model} offers ${levels.join(', ')} here, not ${pick.effort}`, validChoices());
  }
  return 'ok';
}

// ---- argument parsing -------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['project', 'mode', 'base', 'diff-file', 'plan', 'focus', 'focus-file', 'context-file',
  'room', 'model', 'effort', 'timeout-s', 'via', 'format', 'run', 'skill', 'scope', 'claude-only', 'codex-only', 'both']);
const BOOL_FLAGS = new Set(['staged', 'unstaged', 'working-tree', 'allow-stub']);
const FILE_FLAGS = ['diff-file', 'plan', 'context-file', 'focus-file'];

/** Never throws: problems go to `errors` so `run` can still write a receipt for them. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name === null) positional.push(argv[i]);
    else if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (!VALUE_FLAGS.has(name)) errors.push(`Unknown flag --${name}`);
    else if (i + 1 >= argv.length) errors.push(`Flag --${name} needs a value`);
    else flags[name] = argv[++i];
  }
  return { positional, flags, errors };
}

/** kind is 'file' or 'dir'. A wrong kind is bad_args here instead of a crash later. */
function absolutePath(flag, value, kind) {
  if (!isAbsolute(value)) throw refuse('bad_args', `--${flag} must be an absolute path`);
  if (!existsSync(value)) throw refuse('bad_args', `--${flag} does not exist: ${value}`);
  const stat = statSync(value);
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) {
    throw refuse('bad_args', `--${flag} must be a ${kind === 'dir' ? 'directory' : 'file'}: ${value}`);
  }
  return value;
}

function checkRoom(room) {
  absolutePath('room', room, 'dir');
  if (!existsSync(join(room, 'CONTRACT.md'))) throw refuse('bad_args', `--room has no CONTRACT.md: ${room}`);
}

function readConfig(flags, rec) {
  const mode = flags.mode;
  if (mode !== 'code' && mode !== 'plan') throw refuse('bad_args', '--mode must be code or plan');
  const project = absolutePath('project', flags.project ?? process.cwd(), 'dir');
  rec.project = project;
  const timeoutS = flags['timeout-s'] === undefined ? DEFAULT_TIMEOUT_S : Number(flags['timeout-s']);
  if (!(timeoutS > 0 && timeoutS <= MAX_TIMEOUT_S)) throw refuse('bad_args', `--timeout-s must be 1 to ${MAX_TIMEOUT_S}`);
  const format = flags.format ?? 'md';
  if (format !== 'md' && format !== 'json') throw refuse('bad_args', '--format must be md or json');
  for (const f of FILE_FLAGS) if (flags[f]) absolutePath(f, flags[f], 'file');
  if (flags.room) checkRoom(flags.room);
  const sources = mode === 'plan' ? ['plan'] : ['base', 'staged', 'unstaged', 'working-tree', 'diff-file'];
  const given = sources.filter((s) => flags[s]);
  if (given.length !== 1) throw refuse('bad_args', `mode=${mode} needs exactly one of: ${sources.map((s) => `--${s}`).join(', ')}`);
  return { mode, project, timeoutS, format };
}

// ---- review target and prompt ---------------------------------------------------------------

// Git runs with the cleaned env and without external diff or textconv programs from repo config.
function runGit(project, gitArgs, env) {
  const r = spawnSync('git', ['-C', project, ...gitArgs], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: cleanEnv(env), windowsHide: true,
  });
  if (r.error?.code === 'ENOBUFS') throw refuse('bad_args', 'The git output is far above the size limit');
  if (r.error || r.status !== 0) throw refuse('bad_args', `git ${gitArgs[0]} failed: ${(r.stderr || r.error?.message || '').split('\n')[0]}`);
  return r.stdout;
}

const gitDiff = (project, extra, env) => runGit(project, ['diff', '--no-ext-diff', '--no-textconv', ...extra, '--'], env);

function countUntracked(project, env) {
  return runGit(project, ['ls-files', '--others', '--exclude-standard'], env).split('\n').filter(Boolean).length;
}

function gitTarget(flags, project, env) {
  if (flags.staged) return { scope: 'staged', text: gitDiff(project, ['--staged'], env) };
  if (flags.unstaged) return { scope: 'unstaged', text: gitDiff(project, [], env) };
  if (flags['working-tree']) return { scope: 'working-tree', text: gitDiff(project, ['HEAD'], env) };
  if (flags.base.startsWith('-')) throw refuse('bad_args', '--base must be a ref, not an option');
  return { scope: `base:${flags.base}`, text: gitDiff(project, [`${flags.base}...HEAD`], env) };
}

function codeTarget(flags, project, env) {
  if (flags['diff-file']) return { scope: `file:${flags['diff-file']}`, text: readFileSync(flags['diff-file'], 'utf8'), untracked: 0 };
  const target = gitTarget(flags, project, env);
  return { ...target, untracked: countUntracked(project, env) };
}

/** Loads the diff or plan and applies the size bounds. `untracked` counts files a git diff cannot show. */
export function loadTarget(flags, cfg, env) {
  const isPlan = cfg.mode === 'plan';
  const target = isPlan
    ? { scope: flags.plan, text: readFileSync(flags.plan, 'utf8'), untracked: 0 }
    : codeTarget(flags, cfg.project, env);
  const label = isPlan ? 'plan' : 'diff';
  const limit = isPlan ? MAX_PLAN : MAX_DIFF;
  if (!target.text.trim()) throw refuse('bad_args', `The ${label} is empty`);
  if (Buffer.byteLength(target.text) > limit) throw refuse('bad_args', `The ${label} is above ${limit / 1024} KB`);
  return target;
}

export function loadFraming(dir = SCRIPT_DIR) {
  try {
    return { source: 'file', text: readFileSync(join(dir, 'adversarial-review.md'), 'utf8') };
  } catch { return { source: 'embedded', text: EMBEDDED_FRAMING }; }
}

const readIfThere = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** CONTRACT.md, status.json and every inbox/codex file of a workroom; missing parts are skipped. */
export function readRoom(room) {
  const parts = ['CONTRACT.md', 'status.json'].map((f) => [f, readIfThere(join(room, f))]);
  const inbox = join(room, 'inbox', 'codex');
  if (existsSync(inbox)) {
    for (const f of readdirSync(inbox)) {
      if (statSync(join(inbox, f)).isFile()) parts.push([`inbox/codex/${f}`, readIfThere(join(inbox, f))]);
    }
  }
  return parts.filter(([, text]) => text.trim()).map(([f, text]) => `## Workroom: ${f}\n\n${text}`).join('\n\n');
}

export function buildPrompt({ framing, mode, scope, focus, text, extra }) {
  const context = [text, ...extra.filter(Boolean)].join('\n\n');
  return `${framing}\n\n---\n\n# Review Target\n\nMode: ${mode}\nScope: ${scope}\n` +
    `Focus: ${focus || 'none given; pick the attack surface'}\n\n# Context\n\n${context}\n\n` +
    `# Instructions\n\nApply the framing above. Return JSON only.\n\n${NO_TOOLS}\n`;
}

// ---- starting Codex -------------------------------------------------------------------------

const envGet = (env, name) => Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Child env without the API keys, so Codex can only use the ChatGPT login. */
export function cleanEnv(env) {
  const drop = new Set(['openai_api_key', 'codex_api_key']);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toLowerCase())));
}

function findOnPath(name, env) {
  const dirs = (envGet(env, 'PATH') ?? '').split(delimiter).filter(Boolean);
  const hit = dirs.find((dir) => existsSync(join(dir, name)));
  return hit ? join(hit, name) : null;
}

/** Where the Codex binary came from: 'stub' (tests), 'env' (CODEX_BIN_JS) or 'path' (the real install). */
export function binKind(env) {
  if (env.CODEX_ADVERSARY_STUB) return 'stub';
  return env.CODEX_BIN_JS ? 'env' : 'path';
}

// npm installs codex.cmd next to node_modules/@openai/codex; running its JS entry avoids a shell.
function findCodexJs(env) {
  const shim = findOnPath('codex.cmd', env);
  const js = shim && join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return js && existsSync(js) ? js : null;
}

/** How to start Codex (or the stub) with `args`; null when the CLI cannot be found. Never uses a shell. */
export function codexCommand(args, env) {
  if (env.CODEX_ADVERSARY_STUB) return { cmd: process.execPath, args: [env.CODEX_ADVERSARY_STUB, ...args] };
  if (env.CODEX_BIN_JS) return existsSync(env.CODEX_BIN_JS) ? { cmd: process.execPath, args: [env.CODEX_BIN_JS, ...args] } : null;
  if (process.platform !== 'win32') return { cmd: 'codex', args };
  const js = findCodexJs(env);
  return js ? { cmd: process.execPath, args: [js, ...args] } : null;
}

/** Short synchronous Codex call (version, login). Throws cli_missing when it cannot start. */
function probe(args, env) {
  const inv = codexCommand(args, env);
  if (!inv) throw refuse('cli_missing', 'The codex JS entry was not found (npm i -g @openai/codex, or set CODEX_BIN_JS)');
  const r = spawnSync(inv.cmd, inv.args, {
    env: cleanEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true,
  });
  if (r.error) throw refuse(r.error.code === 'ENOENT' ? 'cli_missing' : 'failed', `Could not run codex: ${r.error.message}`);
  return `${r.stdout}${r.stderr}`;
}

export function installedVersion(env) {
  return /(\d+\.\d+\.\d+\S*)/.exec(probe(['--version'], env))?.[1] ?? null;
}

function checkLogin(env) {
  if (!probe(['login', 'status'], env).includes('Logged in using ChatGPT')) {
    throw refuse('auth', 'Codex is not logged in with a ChatGPT account (run: codex login)');
  }
}

export function execArgs({ model, effort, project, finalPath }) {
  return ['exec', '--model', model, '-c', `model_reasoning_effort=${effort}`, '--sandbox', 'read-only',
    '--ephemeral', '--disable', 'multi_agent', '--disable', 'hooks', '--skip-git-repo-check',
    '-C', project, '-o', finalPath, '-'];
}

// ---- stopping a run's process tree ----------------------------------------------------------
// Never taskkill /T and never a by-name sweep: both would hit parallel runs and the Codex app.

/**
 * Rows of { pid, ppid, start } from `<pid> <ppid> <start>` lines. start is epoch milliseconds (the
 * Windows listing) or a `ps -o lstart=` date. An unreadable date counts as young: the ppid link decides.
 */
export function parseProcessTable(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) return [];
    const start = /^\d+$/.test(m[3]) ? Number(m[3]) : Date.parse(m[3]);
    return [{ pid: Number(m[1]), ppid: Number(m[2]), start: Number.isNaN(start) ? Infinity : start }];
  });
}

/**
 * Pids to stop: the root plus every descendant of it (a detached grandchild keeps its ppid link),
 * counting only processes started at or after `since`. A reused pid older than that is left alone.
 */
export function treeToStop(rootPid, table, since) {
  const young = table.filter((p) => p.start >= since);
  const members = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of young) {
      if (members.has(p.ppid) && !members.has(p.pid)) { members.add(p.pid); grew = true; }
    }
  }
  return young.map((p) => p.pid).filter((pid) => members.has(pid) && pid > 1 && pid !== process.pid);
}

const POWERSHELL_TABLE = `Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ` +
  `ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`;

function listProcesses(env) {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_TABLE]]
    : ['ps', ['-e', '-o', 'pid=,ppid=,lstart=']];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...cleanEnv(env), LC_ALL: 'C' },
  });
  return r.error ? [] : parseProcessTable(r.stdout);
}

/** Stops the root and its descendants; returns the pids it signalled. If the listing fails, the root alone. */
export function killTree(pid, env, since = Date.now() - 60000) {
  const table = listProcesses(env);
  const stop = table.length ? treeToStop(pid, table, since) : [pid];
  if (process.platform !== 'win32' && stop.includes(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  for (const target of stop) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
  }
  return stop;
}

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Waits up to `waitMs` for the pids to exit; returns the ones still alive. Async so node can reap children. */
export async function survivors(pids, waitMs) {
  const deadline = Date.now() + waitMs;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(isAlive);
  }
  return alive;
}

// Ctrl+C or a kill signal to the runner must not leave Codex running: stop its tree, then exit.
function stopOnSignal(child, env, since) {
  const handler = (signal) => {
    killTree(child.pid, env, since);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
}

const NOT_EXITED = Symbol('not exited');

/** Runs `codex exec` with stdin from the prompt file and stdout+stderr into the log file. */
function runCodex(args, env, files, timeoutS) {
  const inv = codexCommand(args, env);
  const stdin = openSync(files.prompt, 'r');
  const out = openSync(files.log, 'a');
  const since = Date.now() - 2000;
  const child = spawn(inv.cmd, inv.args, {
    stdio: [stdin, out, out], env: cleanEnv(env), windowsHide: true, detached: process.platform !== 'win32',
  });
  closeSync(stdin);
  closeSync(out);
  const unhook = stopOnSignal(child, env, since);
  return new Promise((done) => {
    let timedOut = false;
    const finishRun = (res) => { unhook(); done({ timedOut, ...res }); };
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    const timer = setTimeout(async () => {
      timedOut = true;
      const stopped = killTree(child.pid, env, since);
      // The cleanup is ok only when the root exited and every pid the walk found is gone.
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000, NOT_EXITED))]);
      const left = await survivors(stopped.filter((p) => p !== child.pid), 3000);
      if (code === NOT_EXITED) left.push(child.pid);
      child.unref();
      finishRun({ exitCode: code === NOT_EXITED ? null : code, cleanup: left.length ? 'failed' : 'ok', pids: left });
    }, timeoutS * 1000);
    child.on('error', (e) => { clearTimeout(timer); finishRun({ exitCode: null, error: e.message }); });
    child.on('exit', (exitCode) => { if (!timedOut) { clearTimeout(timer); finishRun({ exitCode, cleanup: null }); } });
  });
}

// ---- one run ---------------------------------------------------------------------------------

const USAGE = 'Usage: adversary.mjs run --mode code|plan (--base <ref> | --staged | --unstaged | --working-tree | --diff-file <abs> | --plan <abs>) ...';
const utcStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const storageRoot = (env) => env.CODEX_ADVERSARY_HOME || join(homedir(), '.claude');
const runDirFor = (env, id) => join(storageRoot(env), 'cache', 'codex-adversary', 'runs', id);
const logPath = (env) => join(storageRoot(env), 'logs', 'codex-adversary.jsonl');

function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

function newRecord(flags, env) {
  return {
    ts: new Date().toISOString(), run: `${utcStamp()}-${randomBytes(2).toString('hex')}`, status: 'failed',
    via: flags.via || 'manual', mode: flags.mode ?? null, scope: null, project: flags.project ?? process.cwd(),
    model_requested: flags.model || env.CODEX_ADVERSARY_MODEL || DEFAULT_MODEL, model_observed: null,
    effort: flags.effort || env.CODEX_ADVERSARY_EFFORT || DEFAULT_EFFORT, effort_requested: null,
    provider: null, cli: null, session_id: null, exit_code: null, final_bytes: 0, final_sha256: null,
    json: false, tokens: null, duration_s: 0, prompt_bytes: 0, framing: null, cache: null,
    usage_limited: false, stub: Boolean(env.CODEX_ADVERSARY_STUB), bin: binKind(env),
    untracked_not_reviewed: 0, cleanup: null, storage_error: null, reason: '',
  };
}

// The log echoes the whole prompt. Remove it so prompt text cannot fake a usage limit or a 400.
function stripEcho(log, prompt) {
  const variants = [prompt, prompt.replace(/\n/g, '\r\n')];
  const hit = variants.find((v) => log.includes(v));
  return hit ? log.replace(hit, () => '') : log;
}

function reasonFor(rec, logText, timeoutS, res) {
  if (res.error) return `Could not start Codex: ${res.error}`;
  const retry = /try again at ([^.\n]+)/.exec(logText)?.[1]?.trim();
  const stopped = res.cleanup === 'failed' ? `; cleanup failed, pid ${res.pids?.join(',')} may still run` : '';
  return {
    ok: '',
    timeout: `Codex did not finish within ${timeoutS} seconds and was stopped${stopped}`,
    usage_limited: `The ChatGPT usage limit is reached${retry ? `, try again at ${retry}` : ''}`,
    model_rejected: `Codex rejected model ${rec.model_requested} for this account or CLI version`,
    no_header: 'The Codex log has no header, so no model can be confirmed',
    model_mismatch: `The log header names ${rec.model_observed}, not ${rec.model_requested}`,
    provider_mismatch: `The log header names provider ${rec.provider}, not openai`,
    empty: `Codex wrote no answer (exit ${rec.exit_code})`,
    failed: `Codex exited with code ${rec.exit_code}`,
  }[rec.status];
}

function interpret(rec, res, files, prompt, timeoutS) {
  const log = readIfThere(files.log);
  const finalBuf = existsSync(files.final) ? readFileSync(files.final) : Buffer.alloc(0);
  const finalText = finalBuf.toString('utf8');
  const header = parseHeader(log);
  const logText = stripEcho(log, prompt);
  Object.assign(rec, {
    exit_code: res.exitCode, model_observed: header?.model ?? null, provider: header?.provider ?? null,
    cli: header?.cliVersion ?? null, session_id: header?.sessionId ?? null, effort: header?.effort ?? rec.effort,
    tokens: parseTokens(logText), final_bytes: finalBuf.length,
    final_sha256: finalBuf.length ? sha256(finalBuf) : null, json: parseAnswer(finalText) !== null,
    cleanup: res.cleanup ?? null,
  });
  rec.status = classify({ exitCode: res.exitCode, timedOut: res.timedOut, header, requestedModel: rec.model_requested, finalText, logText });
  rec.usage_limited = rec.status === 'usage_limited';
  rec.reason = reasonFor(rec, logText, timeoutS, res);
  return finalText;
}

function extraContext(flags) {
  const file = flags['context-file'];
  const fromFile = file ? `## Extra context: ${file}\n\n${readFileSync(file, 'utf8')}` : '';
  return [fromFile, flags.room ? readRoom(flags.room) : ''];
}

function focusText(flags) {
  const fromFile = flags['focus-file'] ? readFileSync(flags['focus-file'], 'utf8').trim() : '';
  return [flags.focus, fromFile].filter(Boolean).join('\n');
}

async function execute(flags, env, rec, state) {
  const cfg = readConfig(flags, rec);
  const pick = pickModel(flags, env);
  Object.assign(rec, { effort: pick.effort, effort_requested: pick.effort });
  rec.cache = checkCache(pick, installedVersion(env), env);
  checkLogin(env);
  const target = loadTarget(flags, cfg, env);
  Object.assign(rec, { scope: target.scope, untracked_not_reviewed: target.untracked });
  const framing = loadFraming();
  rec.framing = framing.source;
  const prompt = buildPrompt({ framing: framing.text, mode: cfg.mode, scope: target.scope, focus: focusText(flags),
    text: target.text, extra: extraContext(flags) });
  rec.prompt_bytes = Buffer.byteLength(prompt);
  if (rec.prompt_bytes > MAX_PROMPT) throw refuse('bad_args', `The whole prompt is above ${MAX_PROMPT / 1024} KB`);
  const dir = runDirFor(env, rec.run);
  const files = { prompt: join(dir, 'prompt.txt'), log: join(dir, 'log.txt'), final: join(dir, 'final.txt') };
  mkdirSync(dir, { recursive: true });
  writeFileSync(files.prompt, prompt);
  const args = execArgs({ ...pick, project: cfg.project, finalPath: files.final });
  const res = await runCodex(args, env, files, cfg.timeoutS);
  state.finalText = interpret(rec, res, files, prompt, cfg.timeoutS);
}

export async function runReview(flags, env, errors = []) {
  const rec = newRecord(flags, env);
  const state = { finalText: '', choices: '' };
  const t0 = Date.now();
  try {
    if (errors.length) throw refuse('bad_args', errors[0], USAGE);
    await execute(flags, env, rec, state);
  } catch (e) {
    const known = e instanceof Refusal;
    Object.assign(rec, { status: known ? e.status : 'failed', reason: known ? e.message : `Runner error: ${e.message}` });
    state.choices = known ? e.choices : '';
  }
  rec.duration_s = Number(((Date.now() - t0) / 1000).toFixed(1));
  return finish(rec, state, flags, env);
}

// ---- output and storage ----------------------------------------------------------------------

// Line 2 of an ok run. A stub or env binary never says "Reviewed by OpenAI".
function okLine(rec) {
  const who = rec.bin === 'path'
    ? `Reviewed by OpenAI ${rec.model_observed} @ ${rec.effort} through Codex CLI ${rec.cli}. Not Claude.`
    : `STUB RUN (not a Codex review): the Codex binary came from ${rec.bin === 'stub' ? 'the test stub' : 'CODEX_BIN_JS'}.`;
  const untracked = rec.untracked_not_reviewed > 0 ? ` Untracked files not reviewed: ${rec.untracked_not_reviewed}.` : '';
  const storage = rec.storage_error ? ` storage_error=${rec.storage_error}` : '';
  return `${who} Scope: ${rec.scope}.${untracked}${storage}`;
}

function renderOutput(rec, state, format) {
  const line1 = formatReceipt(rec);
  const ok = rec.status === 'ok';
  const line2 = ok
    ? okLine(rec)
    : `NO CODEX REVIEW (${rec.status}): ${rec.reason}. There are no findings from Codex. Do not substitute a Claude review.`;
  const parts = [line1, line2];
  if (format === 'json') {
    const answer = ok ? parseAnswer(state.finalText) : null;
    const obj = { codex_receipt: line1, status: rec.status, model: rec.model_observed, effort: rec.effort,
      run: rec.run, answer, answer_raw: ok ? state.finalText : '' };
    if (state.choices) obj.choices = state.choices;
    parts.push('', JSON.stringify(obj, null, 2));
  } else if (ok) {
    parts.push('', '## Codex answer (verbatim)', '', state.finalText);
  }
  if (state.choices && format !== 'json') parts.push('', state.choices);
  return `${parts.join('\n')}\n`;
}

function writeRoomOutputs(room, rec, line1, finalText) {
  mkdirSync(join(room, 'findings'), { recursive: true });
  writeFileSync(join(room, 'findings', `booth-codex-${rec.run}.md`), `${line1}\n\n${finalText}\n`);
  const verdict = parseAnswer(finalText)?.verdict;
  const entry = [new Date().toISOString(), 'codex [reviewer]', verdict, `run=${rec.run}`, `model=${rec.model_observed}`];
  const thread = join(room, 'THREAD.md');
  const lead = readIfThere(thread) && !readIfThere(thread).endsWith('\n') ? '\n' : '';
  appendFileSync(thread, `${lead}${entry.filter(Boolean).join(' ')}\n`);
}

// Runs a storage step; returns a short error text instead of throwing.
function attempt(step) {
  try { step(); return null; } catch (e) { return e.code ?? String(e.message).split('\n')[0].slice(0, 60); }
}

function noteStorageError(rec, text) {
  rec.storage_error = [rec.storage_error, text].filter(Boolean).join('; ');
  rec.reason = [rec.reason, `storage_error=${text}`].filter(Boolean).join('; ');
}

// A failed write never changes the status: the receipt always prints, with the error named.
function persist(rec, state, flags, env) {
  const dir = runDirFor(env, rec.run);
  const saveReceipt = () => {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'log.txt'))) writeFileSync(join(dir, 'log.txt'), `${rec.reason}\n`);
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(rec, null, 2));
  };
  if (rec.status === 'ok' && flags.room) {
    const failed = attempt(() => writeRoomOutputs(flags.room, rec, formatReceipt(rec), state.finalText));
    if (failed) noteStorageError(rec, failed);
  }
  const errors = [attempt(saveReceipt), attempt(() => appendJsonl(logPath(env), rec))];
  for (const failed of errors) if (failed) noteStorageError(rec, failed);
}

function finish(rec, state, flags, env) {
  persist(rec, state, flags, env);
  const stdout = renderOutput(rec, state, flags.format === 'json' ? 'json' : 'md');
  return { code: EXIT[rec.status] ?? 3, stdout };
}

// ---- verify, models, lift ------------------------------------------------------------------

function readRows(env) {
  return readIfThere(logPath(env)).split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// The log header must still say what the receipt says: a hand-edited log or receipt breaks the match.
function logHeaderProblem(dir, rec) {
  const header = parseHeader(readIfThere(join(dir, 'log.txt')));
  if (!header) return 'log.txt has no Codex header';
  const same = header.model === rec.model_observed && header.sessionId === rec.session_id && header.cliVersion === rec.cli &&
    header.provider === rec.provider && header.effort === rec.effort;
  return same ? null : 'the log.txt header differs from the receipt';
}

function receiptProblem(rec, allowStub) {
  if (rec.status !== 'ok') return `receipt status is ${rec.status}`;
  if (rec.bin !== 'path' && !allowStub) return `the run used a ${rec.bin ?? 'unknown'} Codex binary, not the installed CLI`;
  if (rec.model_observed !== rec.model_requested) return 'observed model differs from the requested model';
  return rec.provider === 'openai' ? null : 'provider is not openai';
}

/** A run verifies when receipt, final.txt, log.txt header and the jsonl row all agree on an ok run. */
export function verifyRun(id, { allowStub = false } = {}, env = process.env) {
  const fail = (reason) => ({ ok: false, reason });
  if (!/^[\w-]+$/.test(id ?? '')) return fail('run id is missing or malformed');
  const dir = runDirFor(env, id);
  if (!existsSync(join(dir, 'receipt.json'))) return fail('no run folder with a receipt.json');
  let rec;
  try { rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')); } catch { return fail('receipt.json is not valid JSON'); }
  const problem = receiptProblem(rec, allowStub);
  if (problem) return fail(problem);
  const finalPath = join(dir, 'final.txt');
  if (!existsSync(finalPath) || sha256(readFileSync(finalPath)) !== rec.final_sha256) {
    return fail('final.txt does not match the receipt sha256');
  }
  const row = readRows(env).find((r) => r.run === id);
  const rowOk = row && row.status === 'ok' && row.final_sha256 === rec.final_sha256 && row.model_observed === rec.model_observed;
  if (!rowOk) return fail('no matching ok row in the log');
  const headerProblem = logHeaderProblem(dir, rec);
  return headerProblem ? fail(headerProblem) : { ok: true, receipt: rec };
}

function verifyCommand(id, flags, env) {
  const v = verifyRun(id, { allowStub: Boolean(flags['allow-stub']) }, env);
  const root = `root=${storageRoot(env)}`;
  if (v.ok) return { code: 0, stdout: `VERIFY ok run=${id} model=${v.receipt.model_observed} ${root}\n` };
  return { code: 1, stdout: `VERIFY FAIL run=${id} reason=${v.reason} ${root}\n` };
}

function modelsCommand(env) {
  const cache = readCache(env);
  let installed = null;
  try { installed = installedVersion(env); } catch { /* the table is still useful without the CLI */ }
  const fresh = cache && installed && cache.version === installed;
  const state = !cache ? 'unreadable' : fresh ? 'fresh' : 'stale';
  const rows = Object.entries(MODELS).map(([id, m]) => {
    const levels = fresh ? (cache.models.get(id)?.join(',') ?? 'not offered') : '-';
    return `${id.padEnd(14)} ${m.ceiling.padEnd(6)} ${levels.padEnd(32)} ${m.note}`;
  });
  const head = `${'id'.padEnd(14)} ${'max'.padEnd(6)} ${'live levels'.padEnd(32)} note`;
  const foot = `default: ${DEFAULT_MODEL} @ ${DEFAULT_EFFORT}\ncache: ${state} (cache ${cache?.version || '-'}, installed ${installed ?? '-'})`;
  return { code: 0, stdout: `${[head, ...rows, foot].join('\n')}\n` };
}

function liftCommand(flags, env) {
  const counts = ['claude-only', 'codex-only', 'both'].map((k) => Number(flags[k]));
  const project = flags.project ?? process.cwd();
  const missing = ['run', 'skill', 'scope'].filter((k) => !flags[k]);
  if (missing.length || !counts.every(Number.isInteger) || counts.some((n) => n < 0) || !isAbsolute(project)) {
    return { code: 2, stdout: 'lift needs --run --skill --scope --claude-only --codex-only --both (counts >= 0) and an absolute --project\n' };
  }
  const v = verifyRun(flags.run, { allowStub: Boolean(flags['allow-stub']) }, env);
  if (!v.ok) return { code: 1, stdout: `LIFT REFUSED run=${flags.run} reason=${v.reason}\n` };
  const [claudeOnly, codexOnly, both] = counts;
  appendJsonl(join(project, '.claude', 'logs', 'codex-lift.jsonl'), {
    ts: new Date().toISOString(), skill: flags.skill, scope: flags.scope, model: 'codex', via: 'runner',
    reviewer_model: v.receipt.model_observed, reviewer_effort: v.receipt.effort, codex_run: flags.run,
    codex_status: v.receipt.status, claude_only: claudeOnly, codex_only: codexOnly, both,
  });
  return { code: 0, stdout: `LIFT ok run=${flags.run} skill=${flags.skill}\n` };
}

async function dispatch(command, rest, flags, errors, env) {
  if (command === 'run') return runReview(flags, env, errors);
  if (errors.length) return { code: 2, stdout: `${errors[0]}\n${USAGE}\n` };
  if (command === 'verify') return verifyCommand(rest[0], flags, env);
  if (command === 'models') return modelsCommand(env);
  if (command === 'lift') return liftCommand(flags, env);
  return { code: 2, stdout: `${USAGE}\nOther commands: verify <run-id>, models, lift\n` };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { positional, flags, errors } = parseArgs(argv);
  const result = await dispatch(positional[0], positional.slice(1), flags, errors, env);
  process.stdout.write(result.stdout);
  return result.code;
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
