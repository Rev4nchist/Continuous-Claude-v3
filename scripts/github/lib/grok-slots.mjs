// A machine-wide gate for cursor-agent runs: at most `max` (default 2) run at once across ALL sessions and processes.
// Evidence (2026-11-02, ~/.claude/state/cursor-review-ledger.jsonl): 9 solo runs, 0 time-outs; 6 overlapping runs, 5 time-outs.
//
// State file (default ~/.claude/state/grok-slots.json):
//   { active: [{ key, pid, startedAt, expiresAt, childPid? }], waiting: [{ key, pid, enqueuedAt, expiresAt }] }.
// - The file is read and written under withLock (file-lock.mjs) only at take, attach, dequeue and release. The lock is never held across the wait.
// - An active entry is live while its parent pid OR its agent (child) pid runs, and until its expiresAt. expiresAt is the run's own
//   time-out plus the kill grace (opts.ttlMs); an entry without one expires staleMs after startedAt. A crashed run cannot hold a slot for good.
// - First come, first served: a caller joins the waiting list and takes a slot only when its rank there is below the free slots,
//   so a newcomer cannot pass a waiter. A waiting entry is dropped when its pid is gone or it is older than its expiresAt.
// - One process may hold two slots (two runs in one process): the key is a random UUID, not the pid.
// - This process remembers the keys it holds. An entry with this pid and a key not held (a release that failed) is dropped at the next take.
// - A state error or a lock miss on the FIRST try returns reason 'lock' (the caller runs without a slot: a broken file must not stop
//   every review). Once the gate has read the state, such a miss is retried at the next poll until waitMs, then the result is 'busy'.
// - release() is idempotent, retries with backoff and never rejects.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive as defaultPidAlive, withLock } from './file-lock.mjs';

export const DEFAULT_MAX = 2;
export const DEFAULT_WAIT_MS = 60 * 60_000;
export const DEFAULT_POLL_MS = 15_000;
/** A waiting caller logs when it starts to wait, then at most once per this many ms. */
export const WAIT_LOG_EVERY_MS = 60_000;
export const DEFAULT_STALE_MS = 3 * 3_600_000;
export const DEFAULT_RELEASE_ATTEMPTS = 4;
export const DEFAULT_RELEASE_BACKOFF_MS = 250;
const WAITER_MARGIN_MS = 60_000;

/** Keys of the slots this process holds. */
const held = new Set();

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The max wait in ms: opts.waitMs, else CCV3_GROK_WAIT_MIN (whole minutes, 0 allowed), else DEFAULT_WAIT_MS. */
function resolveWaitMs(opts, env) {
  if (Number.isFinite(opts.waitMs)) return opts.waitMs;
  const raw = env.CCV3_GROK_WAIT_MIN;
  return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) * 60_000 : DEFAULT_WAIT_MS;
}

/** Positive integer from an env string, else the default. */
function resolveMax(opts, env) {
  if (Number.isInteger(opts.max) && opts.max > 0) return opts.max;
  const raw = env.CCV3_GROK_MAX_CONCURRENT;
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim()) ? Number(raw.trim()) : DEFAULT_MAX;
}

function resolveFile(opts, env) {
  return opts.file || env.CCV3_GROK_SLOTS_FILE || path.join(os.homedir(), '.claude', 'state', 'grok-slots.json');
}

const entriesOf = (list) => (Array.isArray(list) ? list.filter((e) => e && typeof e.key === 'string') : []);

/**
 * { active, waiting }. A missing file (ENOENT) or a corrupt one (JSON syntax error) reads as empty. Any other read error
 * (EBUSY and EPERM from a scanner, for example) is thrown: reading it as empty would let the next write erase live slots.
 */
function readState(file, readFile) {
  let text;
  try { text = readFile(file, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return { active: [], waiting: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return { active: entriesOf(parsed?.active), waiting: entriesOf(parsed?.waiting) };
  } catch { return { active: [], waiting: [] }; }
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** True when `a` joined the waiting list before `b`. */
const before = (a, b) => a.enqueuedAt < b.enqueuedAt || (a.enqueuedAt === b.enqueuedAt && a.key < b.key);

/**
 * Takes a free slot or waits for one.
 * opts: { file, max, waitMs = CCV3_GROK_WAIT_MIN or 60 min, pollMs = 15 s, staleMs = 3 h, ttlMs, lockWaitMs, releaseAttempts, releaseBackoffMs }
 *   ttlMs: how long the entry may live (the run's time-out plus the kill grace). Default: staleMs.
 * deps: { now, sleep, pidAlive, env, log, readFile }  (all injectable for tests)
 * Resolves { ok: true, release(), attach(childPid), waitedMs } or { ok: false, reason: 'busy' | 'lock', detail, waitedMs }. Never rejects.
 */
export async function acquireGrokSlot(opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const readFile = deps.readFile ?? readFileSync;
  const log = deps.log ?? ((m) => process.stderr.write(`${m}\n`));
  const file = resolveFile(opts, env);
  const max = resolveMax(opts, env);
  const waitMs = resolveWaitMs(opts, env);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const ttlMs = opts.ttlMs ?? staleMs;
  const lockOpts = opts.lockWaitMs === undefined ? {} : { lockWaitMs: opts.lockWaitMs };
  const key = randomUUID();
  const began = now();

  const isLive = (e, t) => {
    const limit = Number.isFinite(e.expiresAt) ? e.expiresAt : e.startedAt + staleMs;
    if (!(t <= limit)) return false;
    const childLive = Number.isInteger(e.childPid) && pidAlive(e.childPid);
    // This process released it (or never held it) and a failed release left it behind: drop it, unless its agent still runs.
    if (e.pid === process.pid && !held.has(e.key)) return childLive;
    return pidAlive(e.pid) || childLive;
  };
  const isWaiting = (w, t) => w.key !== key && pidAlive(w.pid) && t <= w.expiresAt;

  const tryTake = () => withLock(file, lockOpts, () => {
    const t = now();
    const st = readState(file, readFile);
    const active = st.active.filter((e) => e.key !== key && isLive(e, t));
    const queue = st.waiting.filter((w) => isWaiting(w, t));
    const me = st.waiting.find((w) => w.key === key) ?? { key, pid: process.pid, enqueuedAt: t, expiresAt: t + waitMs + pollMs + WAITER_MARGIN_MS };
    const ahead = queue.filter((w) => before(w, me)).length;
    if (ahead < max - active.length) {
      held.add(key);
      try { writeState(file, { active: [...active, { key, pid: process.pid, startedAt: t, expiresAt: t + ttlMs }], waiting: queue }); } catch (err) { held.delete(key); throw err; }
      return { took: true };
    }
    writeState(file, { active, waiting: [...queue, me] });
    return { took: false, active: active.length };
  });

  /** Best effort: the waiting entry also ends with its pid or its expiresAt. */
  const dequeue = () => {
    try { withLock(file, lockOpts, () => { const st = readState(file, readFile); writeState(file, { active: st.active, waiting: st.waiting.filter((w) => w.key !== key) }); }); } catch { /* expires on its own */ }
  };

  const slot = makeSlot({ file, key, lockOpts, log, sleep, pidAlive, readFile, opts });
  let sawState = false;
  let detail = '';
  let lastLogAt = -Infinity;
  let busyNow = 0;
  for (;;) {
    let r;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      r = tryTake();
    } catch (err) { r = { ok: false, detail: `grok gate state error: ${err.message}` }; }
    if (r.ok === false) {
      detail = r.detail;
      if (!sawState) return { ok: false, reason: 'lock', detail, waitedMs: now() - began };
    } else {
      sawState = true;
      if (r.took) return { ok: true, release: slot.release, attach: slot.attach, waitedMs: now() - began };
      busyNow = r.active;
    }
    const waited = now() - began;
    if (waited >= waitMs) {
      dequeue();
      return { ok: false, reason: 'busy', detail: `no slot of ${max} free after ${waited} ms${detail ? `; last state error: ${detail}` : ''}`, waitedMs: waited };
    }
    if (waited - lastLogAt >= WAIT_LOG_EVERY_MS) {
      lastLogAt = waited;
      log(`grok gate: ${busyNow} of ${max} slots busy; waited ${Math.round(waited / 1000)} s of ${Math.round(waitMs / 1000)} s`);
    }
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

/** Builds attach() and release() for one key. */
function makeSlot({ file, key, lockOpts, log, sleep, pidAlive, readFile, opts }) {
  const attempts = opts.releaseAttempts ?? DEFAULT_RELEASE_ATTEMPTS;
  const backoffMs = opts.releaseBackoffMs ?? DEFAULT_RELEASE_BACKOFF_MS;
  let childPid = null;
  let pending = null;

  /** Writes the agent pid into the entry, so the slot stays taken while the agent runs even if this process dies. Never throws. */
  function attach(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    childPid = pid;
    try {
      const r = withLock(file, lockOpts, () => {
        const st = readState(file, readFile);
        writeState(file, { ...st, active: st.active.map((e) => (e.key === key ? { ...e, childPid: pid } : e)) });
      });
      return r?.ok !== false;
    } catch (err) {
      log(`grok gate: attach of the agent pid ${pid} failed: ${err.message}`);
      return false;
    }
  }

  async function doRelease() {
    held.delete(key); // from now on a take in this process drops the entry even when the removals below fail
    const orphan = childPid !== null && pidAlive(childPid); // the agent outlived the run (a kill that failed): keep the slot while it runs
    let detail = '';
    for (let i = 0; i < attempts; i += 1) {
      try {
        const r = withLock(file, lockOpts, () => {
          const st = readState(file, readFile);
          const active = orphan ? st.active.map((e) => (e.key === key ? { ...e, pid: 0, childPid } : e)) : st.active.filter((e) => e.key !== key);
          writeState(file, { ...st, active });
        });
        if (r?.ok !== false) return;
        detail = r.detail;
      } catch (err) { detail = err.message; }
      if (i < attempts - 1) await sleep(backoffMs * 2 ** i);
    }
    log(`grok gate: release of slot ${key} failed after ${attempts} tries: ${detail}; the entry expires with its pids or its expiresAt`);
  }

  /** Idempotent. The first try runs before this returns; the retries run after. */
  function release() {
    pending ??= doRelease().catch((err) => { log(`grok gate: release of slot ${key} failed: ${err.message}`); });
    return pending;
  }
  return { attach, release };
}
