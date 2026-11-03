// Child processes for TREX: find docker, run a child with a time limit, pipe one child into another.
// Every child is non-detached, hidden, shell-free and piped. A time-out stops the whole process tree.
// The shape follows defaultCrRunner in scripts/github/pre-pr.mjs.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// TODO: import from scripts/github/lib/proc.mjs when review-engine-c0 lands.
// Importing pre-pr.mjs is safe: its main() runs only behind the isDirectRun guard.
import { killTree, resolveSpawn } from '../../github/pre-pr.mjs';
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
  wire(child, out, settle, { capture, log });
  try { o.onSpawn?.(child.pid); } catch { /* a sidecar failure must not stop the run */ }
  return { child, done, force };
}

function wire(child, out, settle, { capture, log }) {
  const take = (key) => (chunk) => { out[key] = keep(out[key], chunk); log?.write(chunk); };
  if (capture) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', take('stdout'));
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', take('stderr'));
  child.on('error', (err) => { out.error = String(err.message); settle({ ...out }); });
  child.on('close', (code) => { out.code = code; settle({ ...out }); });
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
 * opts: { cwd, env (default stripEnv), stdin, timeoutMs, logPath, onSpawn(pid) }.
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

const readPids = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')).pids ?? []; } catch { return []; }
};

/**
 * Records child pids in a JSON file at spawn time, so a later run can stop leftovers (spec 13.3).
 * Use `onSpawn` as the runChild option. `live()` returns the recorded pids that still run.
 */
export function makePidRecorder(file, { alive = pidAlive } = {}) {
  const append = (pid) => writeFileSync(file, JSON.stringify({ pids: [...readPids(file), pid] }));
  return {
    onSpawn(pid) {
      mkdirSync(path.dirname(file), { recursive: true });
      const r = withLock(file, {}, () => append(pid));
      if (r?.ok === false) append(pid); // a lost pid is worse than a racy write
    },
    live: () => readPids(file).filter((pid) => alive(pid)),
  };
}
