// Child processes for TREX: find docker, run a child with a time limit, pipe one child into another.
// Every child is non-detached, hidden, shell-free and piped. A time-out stops the whole process tree.
// The shape follows defaultCrRunner in scripts/github/pre-pr.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Importing pre-pr.mjs is safe: its main() runs only behind the isDirectRun guard.
import { resolveSpawn } from '../../github/pre-pr.mjs';
import { killTree } from '../../github/lib/proc.mjs';
import { pidAlive, withLock } from '../../github/lib/file-lock.mjs';
import { stripEnv } from './strip-env.mjs';

export const DOCKER_WIN = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const KEEP_BYTES = 8 * 1024 * 1024;
const noop = () => {};

/** DOCKER_BIN first, then the Docker Desktop path, then `docker` on the PATH. */
export function dockerBin(env = process.env, { exists = existsSync } = {}) {
  if (env.DOCKER_BIN) return env.DOCKER_BIN;
  return exists(DOCKER_WIN) ? DOCKER_WIN : 'docker';
}

function withDefaults(deps) {
  return {
    spawnFn: spawn,
    resolve: resolveSpawn,
    killer: (child) => killTree(child.pid),
    openStream: createWriteStream,
    killGraceMs: 5000,
    ...deps,
  };
}

const keep = (text, chunk) => (text.length >= KEEP_BYTES ? text : text + chunk);

/**
 * Starts one child. Returns { child, done, force }. `done` never rejects: it resolves with
 * { code, stdout, stderr, error? }. `force` ends the wait when a killed child never closes.
 * With capture false the stdout stays raw, so the caller can pipe it.
 */
function launch(cmd, args, o, d, { stdio, capture = true, log = null }) {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const out = { code: null, stdout: '', stderr: '' };
  const force = () => settle({ ...out });
  let child = null;
  try {
    const spec = d.resolve({ cmd, args });
    child = d.spawnFn(spec.cmd, spec.args, {
      cwd: o.cwd, env: o.env ?? stripEnv(process.env), windowsHide: true, shell: false, stdio,
    });
  } catch (err) {
    settle({ ...out, error: String(err.message) });
    return { child: null, done, force };
  }
  wire(child, out, settle, { capture, log, onExit: () => { try { o.onExit?.(child.pid); } catch { /* a sidecar failure must not stop the run */ } } });
  try { o.onSpawn?.(child.pid); } catch { /* a sidecar failure must not stop the run */ }
  return { child, done, force };
}

function wire(child, out, settle, { capture, log, onExit }) {
  const take = (key) => (chunk) => { out[key] = keep(out[key], chunk); log?.write(chunk); };
  if (capture) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', take('stdout'));
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', take('stderr'));
  child.on('error', (err) => { out.error = String(err.message); onExit(); settle({ ...out }); });
  child.on('close', (code) => { out.code = code; onExit(); settle({ ...out }); });
}

/** Arms one timer for all children. On expiry it kills each tree, then forces the wait after a grace time. */
function armTimer(procs, timeoutMs, d) {
  const state = { timedOut: false, clear: noop };
  if (!timeoutMs) return state;
  const timer = setTimeout(() => {
    state.timedOut = true;
    for (const p of procs) stopOne(p, d);
  }, timeoutMs);
  state.clear = () => clearTimeout(timer);
  return state;
}

function stopOne(p, d) {
  if (!p.child) return;
  try { d.killer(p.child); } catch { /* the grace timer below ends the wait */ }
  try { p.child.kill(); } catch { /* already gone */ }
  setTimeout(p.force, d.killGraceMs).unref();
}

function feedStdin(child, stdin) {
  child.stdin.on('error', noop);
  child.stdin.end(stdin === undefined ? undefined : stdin);
}

function openLog(o, d) {
  if (!o.logPath) return null;
  mkdirSync(path.dirname(o.logPath), { recursive: true });
  const stream = d.openStream(o.logPath);
  stream.on('error', noop);
  return stream;
}

/**
 * Runs one command and resolves { code, timedOut, stdout, stderr, error? }. It never throws.
 * opts: { cwd, env (default stripEnv), stdin, timeoutMs, logPath, onSpawn(pid), onExit(pid) }.
 * deps: { spawnFn, resolve, killer(child), openStream, killGraceMs } for tests.
 */
export async function runChild(cmd, args, opts = {}, deps = {}) {
  const d = withDefaults(deps);
  const log = openLog(opts, d);
  const p = launch(cmd, args, opts, d, { stdio: ['pipe', 'pipe', 'pipe'], log });
  if (p.child) feedStdin(p.child, opts.stdin);
  const timer = armTimer([p], opts.timeoutMs, d);
  const r = await p.done;
  timer.clear();
  log?.end();
  return { ...r, timedOut: timer.timedOut };
}

/**
 * Runs a and b with a.stdout piped into b.stdin. a and b are { cmd, args, cwd?, env? }.
 * One timer kills both. Resolves { codeA, codeB, timedOut, stdoutB, stderrA, stderrB, error? }.
 */
export async function pipeChildren(a, b, opts = {}, deps = {}) {
  const d = withDefaults(deps);
  const log = openLog(opts, d);
  const pa = launch(a.cmd, a.args, { ...opts, ...a }, d, { stdio: ['ignore', 'pipe', 'pipe'], capture: false, log });
  const pb = launch(b.cmd, b.args, { ...opts, ...b }, d, { stdio: ['pipe', 'pipe', 'pipe'], log });
  joinPipe(pa, pb);
  const timer = armTimer([pa, pb], opts.timeoutMs, d);
  const [ra, rb] = await Promise.all([pa.done, pb.done]);
  timer.clear();
  log?.end();
  return {
    codeA: ra.code, codeB: rb.code, timedOut: timer.timedOut, stdoutB: rb.stdout,
    stderrA: ra.stderr, stderrB: rb.stderr, error: ra.error ?? rb.error,
  };
}

function joinPipe(pa, pb) {
  if (!pb.child) return;
  pb.child.stdin.on('error', noop);
  if (pa.child) pa.child.stdout.pipe(pb.child.stdin);
  else pb.child.stdin.end();
}

// ---------- pid sidecar ----------

const START_TOLERANCE_MS = 5000;

/** The start time of a process in ms since the epoch, or null when it cannot be read. Slow on Windows (PowerShell). */
export function processStartMs(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const win = platform === 'win32';
  const cmd = win ? 'powershell.exe' : 'ps';
  const args = win
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]
    : ['-o', 'lstart=', '-p', String(pid)];
  const r = run(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  // ps prints local time, which Date.parse reads as local time.
  const ms = r.status === 0 ? Date.parse(String(r.stdout).trim()) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

// An entry is { pid, started }. A bare number (older file) reads as { pid, started: null }, which is never owned.
const asEntry = (e) => (Number.isInteger(e) ? { pid: e, started: null } : e);
const readEntries = (file) => {
  try { return (JSON.parse(readFileSync(file, 'utf8')).pids ?? []).map(asEntry); } catch { return []; }
};

/**
 * Records child pids in a JSON file at spawn time, so a later run can stop leftovers (spec 13.3).
 * Use `onSpawn` and `onExit` as runChild options: a child that exits is removed from the file.
 * `live()` returns the recorded pids that still run. A pid can be reused by an unrelated process,
 * so `liveOwned()` also needs the process start time to match the recorded spawn time.
 * Cleanup rule for the bench: kill only the run.mjs tree (the pid in run.lock, with its recorded start),
 * and remove containers by the label trex.run=<runId>. Never kill a pid from `live()` alone.
 * deps: { alive, processStart(pid) -> ms | null, now() -> ms } for tests.
 */
export function makePidRecorder(file, { alive = pidAlive, processStart = processStartMs, now = Date.now } = {}) {
  const write = (edit) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const save = () => writeFileSync(file, JSON.stringify({ pids: edit(readEntries(file)) }));
    const r = withLock(file, {}, save);
    if (r?.ok === false) save(); // a lost pid is worse than a racy write
  };
  const owned = ({ pid, started }) => {
    if (!Number.isFinite(started) || !alive(pid)) return false;
    const began = processStart(pid);
    return Number.isFinite(began) && Math.abs(began - started) <= START_TOLERANCE_MS;
  };
  return {
    onSpawn: (pid) => write((all) => [...all.filter((e) => e.pid !== pid), { pid, started: now() }]),
    onExit: (pid) => write((all) => all.filter((e) => e.pid !== pid)),
    live: () => readEntries(file).filter((e) => alive(e.pid)).map((e) => e.pid),
    liveOwned: () => readEntries(file).filter(owned).map((e) => e.pid),
  };
}
