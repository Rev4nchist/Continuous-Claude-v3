/**
 * trace-boot.ts -- the per-process hook latency tracer, injected into every bundle by esbuild.
 *
 * `npm run build` passes `--inject:src/lib/trace-boot.ts`, so esbuild puts this module in front of each hook entry.
 * No hook source calls it, so a rename cannot delete the call. Design: .claudedocs/2026-11-09-trace-hook-design.md
 * (Option A, with the Fable review fixes and Dave's decisions of 2026-11-09).
 *
 * One JSON line per hook process, written from the `exit` event to ~/.claude/cache/hook-trace-YYYY-MM-DD.jsonl:
 *   ts, name, event, tool, startupMs, durationMs, exitCode (0 or 1), code (real), sessionId, out, error, source.
 * The row never holds the command, the payload, the reason text or the stdout text. `out` is a class name.
 * `error` is a class too: the error name plus its string code ("Error/ENOENT"), never the message (a message can hold a path,
 * a URL or command text). `source` is `live` only when the script runs from <home>/.claude/hooks/dist; a run of the repo dist is `probe`.
 *
 * What it must never do:
 *   - touch process.stdin or process.stdout in the boot module. On Linux, building the stdin stream puts fd 0 in
 *     non-blocking mode, and a later readFileSync(0) then throws EAGAIN when the payload is late (44 hooks read that way).
 *     The taps are getters over the lazy properties: they run only when the hook itself first reads the property.
 *   - change an exit code, a stdout byte or a crash. Every statement is in try/catch. `exit` and
 *     `uncaughtExceptionMonitor` observe only.
 *   - write from a test: with the VITEST key set the module does nothing (guardSource would call such a row `test`).
 *
 * Mode (file ~/.claude/state/hook-trace-mode): `off`, `hot` or `all`. A missing file means hot. Hot keeps only
 * HOT_PROGRAMS: the programs the template registers on SessionStart or on Bash/PowerShell tool events. The test
 * trace-boot.test.ts compares the list with .claude/settings.json.template, so a renamed hook shows up.
 * `CCV3_HOOK_TRACE=0` also turns tracing off. A program outside the mode installs nothing at all.
 *
 * Test seams: CCV3_HOOK_TRACE_DIR (rows go there, source becomes `probe`), CCV3_HOOK_TRACE_MODE_FILE.
 *
 * Known limits (documented, not changed; the hook's own behaviour is never affected):
 *   - Exit inside an exit handler. This module registers its `exit` listener first, so it runs before any `exit` listener the hook
 *     adds. A hook that writes output or calls process.exit(n) inside its own exit handler gets a row with the code and `out` seen
 *     at the first listener (for example code 0, out none). No hook in src/*.ts registers an exit handler today.
 *   - Late session id. The tap keeps the first 64 KB (STDIN_KEEP) of the payload. A `session_id` key after that point gives
 *     sessionId null. The row still holds event and tool when they come first. Claude Code puts session_id early in the payload.
 *   - fs.readFileSync is wrapped. The wrapper reports name "readFileSync" and length 2, but String(fs.readFileSync) shows the wrapper source.
 */
import fs from 'fs';
import { homedir } from 'os';
import { basename, join, resolve, sep } from 'path';
import { syncBuiltinESMExports } from 'module';
import { guardSource } from '../shared/guard-log.js';

/** The string the static checks grep for in every dist bundle. It is also the global the boot module sets. */
export const TRACE_MARKER = '__CCV3_HOOK_TRACE_V1__';

/** Programs the template registers on SessionStart, or on PreToolUse/PostToolUse for Bash or PowerShell. Update with the template. */
export const HOT_PROGRAMS: readonly string[] = [
  'architecture-stats-sync', 'commit-preflight', 'decision-gate', 'destructive-command-guard', 'git-commit-roadmap',
  'hook-health-monitor', 'identity-probe', 'lane-agent-tag', 'lane-board-republish-reminder', 'lane-context',
  'mcp-activity-tracker', 'msys-crash-capture', 'package-install-guard', 'periodic-extract', 'pr-opened-review-loop',
  'pre-pr-gate', 'roadmap-completion', 'roadmap-reconcile', 'rule-router', 'scan-scope-guard', 'session-register',
  'session-start-context-loaders', 'session-start-continuity', 'session-start-docker', 'session-start-init-check',
  'session-start-intel-prune', 'session-start-memory-loaders', 'smarter-everyday', 'test-run-tracker',
];

export const DAY_CAP_BYTES = 32 * 1024 * 1024;
export const PRUNE_DAYS = 10;
const STDIN_KEEP = 64 * 1024;
const STDOUT_KEEP = 8 * 1024;
const ERROR_MAX = 120;

export type TraceMode = 'off' | 'hot' | 'all';
export type OutClass = 'allow' | 'deny' | 'ask' | 'inject' | 'message' | 'block' | 'none';
export type TraceSource = 'live' | 'test' | 'probe';

export interface TraceRow {
  ts: string; name: string; event: string | null; tool: string | null; startupMs: number; durationMs: number;
  exitCode: 0 | 1; code: number; sessionId: string | null; out: OutClass; error: string | null; source: TraceSource;
}

// ---- mode ----

/** Pure: env CCV3_HOOK_TRACE=0 is off; else the trimmed, lower-cased file text if it is off, hot or all; else hot (also for no file). */
export function traceModeFrom(env: NodeJS.ProcessEnv, modeText: string | null): TraceMode {
  if (env.CCV3_HOOK_TRACE === '0') return 'off';
  const t = (modeText ?? '').trim().toLowerCase();
  return t === 'off' || t === 'all' ? t : 'hot';
}

export function readTraceMode(env: NodeJS.ProcessEnv, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): TraceMode {
  let text: string | null = null;
  try { text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join(homedir(), '.claude', 'state', 'hook-trace-mode')); } catch { /* missing file: hot */ }
  return traceModeFrom(env, text);
}

export function shouldTrace(name: string, mode: TraceMode): boolean {
  return mode === 'all' || (mode === 'hot' && HOT_PROGRAMS.includes(name));
}

// ---- source and paths ----

const realPath = (p: string): string => { try { return fs.realpathSync(p); } catch { return resolve(p); } };
const caseKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `script` (after realpath) sits under <home>/.claude/hooks/dist: the live copy. The repo dist does not. */
function underLiveDist(script: string | undefined, home: string): boolean {
  if (!script) return false;
  try { return caseKey(realPath(script)).startsWith(caseKey(realPath(join(home, '.claude', 'hooks', 'dist'))) + sep); } catch { return false; }
}

/**
 * guardSource() (VITEST -> test, CCV3_GUARD_DECISIONS_LOG -> probe) plus CCV3_HOOK_TRACE_DIR as a second probe signal.
 * A row is live only when the script runs from the live dist: the AGENTS.md hook e2e step runs the REPO dist with the real HOME,
 * and that run must not make the doctor's hooks:trace-fresh pass before the change reaches the live copy.
 */
export function traceSource(env: NodeJS.ProcessEnv, script: string | undefined = process.argv[1], home: string = homedir()): TraceSource {
  const g = guardSource(env) as TraceSource;
  if (g !== 'live') return g;
  if (env.CCV3_HOOK_TRACE_DIR) return 'probe';
  return underLiveDist(script, home) ? 'live' : 'probe';
}

export const traceDir = (env: NodeJS.ProcessEnv): string => env.CCV3_HOOK_TRACE_DIR || join(homedir(), '.claude', 'cache');
export const dayFileName = (d: Date): string => `hook-trace-${d.toISOString().slice(0, 10)}.jsonl`;

// ---- payload and stdout ----

const SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const EVENT_NAME = /^[A-Za-z]{1,40}$/;
const TOOL_NAME = /^[\w.:-]{1,100}$/;
const pick = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

/** Only the three ids, never other payload text. A whole JSON payload is parsed; a cut one falls back to key regexes. */
export function extractPayloadFields(text: string): { sessionId: string | null; event: string | null; tool: string | null } {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return { sessionId: pick(o.session_id, SESSION_ID), event: pick(o.hook_event_name, EVENT_NAME), tool: pick(o.tool_name, TOOL_NAME) };
    }
  } catch { /* cut or not JSON: fall through */ }
  const key = (k: string, re: RegExp): string | null => pick(new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,100})"`).exec(text)?.[1], re);
  return { sessionId: key('session_id', SESSION_ID), event: key('hook_event_name', EVENT_NAME), tool: key('tool_name', TOOL_NAME) };
}

function classifyObject(o: Record<string, unknown>): OutClass {
  const hso = (o.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const pd = hso.permissionDecision ?? o.permissionDecision;
  if (pd === 'deny' || pd === 'ask' || pd === 'allow') return pd;
  if (o.decision === 'block' || o.result === 'block') return 'block';
  if (typeof hso.additionalContext === 'string') return 'inject';
  if (typeof o.systemMessage === 'string') return 'message';
  return 'none';
}

/** The class of a hook's stdout by KEY tests. The text itself is never kept. */
export function classifyOut(text: string): OutClass {
  const t = text.trim();
  if (!t) return 'none';
  try {
    const o = JSON.parse(t) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? classifyObject(o as Record<string, unknown>) : 'none';
  } catch { /* cut at 8 KB, or several lines: key regexes */ }
  const pd = /"permissionDecision"\s*:\s*"(deny|ask|allow)"/.exec(t)?.[1];
  if (pd) return pd as OutClass;
  if (/"decision"\s*:\s*"block"/.test(t)) return 'block';
  if (/"additionalContext"\s*:/.test(t)) return 'inject';
  if (/"systemMessage"\s*:/.test(t)) return 'message';
  return 'none';
}

const ERROR_WORD = /^[A-Za-z0-9_.]{1,40}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,40}$/;

/**
 * A class, not text: the error name, plus "/" and its code when the code is a short word ("Error/ENOENT"). The message is dropped:
 * it can hold a path, a URL or command text that no mask catches. A thrown non-Error is its typeof. At most 120 characters.
 */
export function maskError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  try {
    const rawName: unknown = err.name;
    const name = typeof rawName === 'string' && ERROR_WORD.test(rawName) ? rawName : 'Error';
    const code = (err as { code?: unknown }).code;
    return (typeof code === 'string' && ERROR_CODE.test(code) ? `${name}/${code}` : name).slice(0, ERROR_MAX);
  } catch {
    return 'Error'; // a name or code getter that throws
  }
}

// ---- row and writer ----

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function buildRow(i: { ts: Date; name: string; event: string | null; tool: string | null; startupMs: number; durationMs: number; code: number; sessionId: string | null; out: OutClass; error: string | null; source: TraceSource }): TraceRow {
  return {
    ts: i.ts.toISOString(), name: i.name, event: i.event, tool: i.tool, startupMs: round1(i.startupMs), durationMs: round1(i.durationMs),
    exitCode: i.code === 0 ? 0 : 1, code: i.code, sessionId: i.sessionId, out: i.out, error: i.error, source: i.source,
  };
}

const DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.(?:jsonl|dropped)$/;

/** Deletes day files and .dropped files dated more than `days` before `day` (YYYY-MM-DD). Every other file stays. */
function pruneOld(dir: string, day: string, days: number): void {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(f);
    if (m && m[1] < cutoff) { try { fs.unlinkSync(join(dir, f)); } catch { /* another process pruned it */ } }
  }
}

/** One counter line, rewritten: a day over its cap must not grow a second file without bound. */
function bumpDropped(file: string): void {
  let n = 0;
  try { n = Number(JSON.parse(fs.readFileSync(file, 'utf8')).dropped) || 0; } catch { /* first drop */ }
  fs.writeFileSync(file, `${JSON.stringify({ dropped: n + 1, ts: new Date().toISOString() })}\n`);
}

/**
 * Appends one row to the day file of its UTC date. The first write of a day (the file is absent) makes the dir and prunes
 * files older than PRUNE_DAYS. A file at or over the cap drops the row and bumps the .dropped counter. Never throws.
 */
export function appendTraceRow(row: TraceRow, opts: { dir?: string; capBytes?: number; pruneDays?: number } = {}): 'written' | 'dropped' | 'error' {
  try {
    const dir = opts.dir ?? traceDir(process.env);
    const day = row.ts.slice(0, 10);
    const file = join(dir, `hook-trace-${day}.jsonl`);
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      fs.mkdirSync(dir, { recursive: true });
      try { pruneOld(dir, day, opts.pruneDays ?? PRUNE_DAYS); } catch { /* a prune failure must not lose the row */ }
    }
    if (size >= (opts.capBytes ?? DAY_CAP_BYTES)) { bumpDropped(join(dir, `hook-trace-${day}.dropped`)); return 'dropped'; }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    return 'written';
  } catch { return 'error'; }
}

// ---- the boot ----

const keep = (cur: string, chunk: unknown, max: number): string => {
  if (cur.length >= max) return cur;
  const s = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '';
  return cur + s.slice(0, max - cur.length);
};

/** Replaces the lazy process[name] getter with one that calls the original on the hook's FIRST access, then lets `onStream` wrap the stream. */
function lazyTap(name: 'stdin' | 'stdout', onStream: (s: any) => void): void {
  const d = Object.getOwnPropertyDescriptor(process, name);
  if (!d || !d.get || !d.configurable) return;
  const orig = d.get;
  let seen: unknown;
  Object.defineProperty(process, name, {
    configurable: true, enumerable: d.enumerable,
    get(this: unknown) {
      const s = orig.call(this);
      if (s && s !== seen) { seen = s; try { onStream(s); } catch { /* observe only */ } }
      return s;
    },
  });
}

/** Installs the taps and the exit writer. Observes only. Does nothing when the mode or the program says no. */
export function bootTrace(env: NodeJS.ProcessEnv = process.env, _bootCall?: string): void {
  try {
    if (!process.argv[1]) return;
    const name = basename(process.argv[1], '.mjs');
    if (!shouldTrace(name, readTraceMode(env))) return;
    const startupMs = process.uptime() * 1000;
    const t0 = performance.now();
    const state = { v: 1, stdinTouched: false, stdoutTouched: false };
    (globalThis as Record<string, unknown>)[TRACE_MARKER] = state;
    let stdinText = '';
    let stdoutText = '';
    let errText: string | null = null;

    const rawRead = fs.readFileSync;
    fs.readFileSync = function (this: unknown, ...args: unknown[]) {
      const r = (rawRead as (...a: unknown[]) => unknown).apply(this, args);
      try { if (args[0] === 0 || args[0] === '/dev/stdin') stdinText = keep(stdinText, r, STDIN_KEEP); } catch { /* observe only */ }
      return r;
    } as typeof fs.readFileSync;
    // The wrapper must look like the original to a hook that reads these two properties.
    try {
      Object.defineProperty(fs.readFileSync, 'name', { value: 'readFileSync', configurable: true });
      Object.defineProperty(fs.readFileSync, 'length', { value: 2, configurable: true });
    } catch { /* cosmetic only */ }
    syncBuiltinESMExports();

    lazyTap('stdin', (s) => {
      state.stdinTouched = true;
      const emit = s.emit;
      s.emit = function (this: unknown, ev: unknown, chunk: unknown) {
        if (ev === 'data') { try { stdinText = keep(stdinText, chunk, STDIN_KEEP); } catch { /* observe only */ } }
        return emit.apply(this, arguments as unknown as unknown[]);
      };
    });
    lazyTap('stdout', (s) => {
      state.stdoutTouched = true;
      const write = s.write;
      s.write = function (this: unknown, chunk: unknown) {
        try { stdoutText = keep(stdoutText, chunk, STDOUT_KEEP); } catch { /* observe only */ }
        return write.apply(this, arguments as unknown as unknown[]);
      };
    });

    process.on('uncaughtExceptionMonitor', (err: unknown) => { try { errText = maskError(err); } catch { /* observe only */ } });
    process.on('exit', (code: number) => {
      try {
        const f = extractPayloadFields(stdinText);
        const row = buildRow({
          ts: new Date(), name, event: f.event, tool: f.tool, startupMs, durationMs: performance.now() - t0,
          code: typeof code === 'number' ? code : 0, sessionId: f.sessionId, out: classifyOut(stdoutText), error: errText, source: traceSource(env, process.argv[1]),
        });
        appendTraceRow(row, { dir: traceDir(env) });
      } catch { /* a trace bug must never change a hook */ }
    });
  } catch { /* never break the hook */ }
}

// Runs once per process when esbuild injects this file. A test imports it with VITEST set and gets no side effect.
// The string argument is a sentinel: trace-marker-check.mjs and trace-boot-static.test.ts grep each dist for it, so only
// THIS statement (the injected boot call) satisfies the check, not another import of this module that carries the marker.
if (!Object.hasOwn(process.env, 'VITEST')) bootTrace(process.env, '__CCV3_HOOK_TRACE_BOOT_V1__');
