#!/usr/bin/env node
/**
 * run-lock.mjs: a cooperative lock that GRANTS or refuses a heavy run (card coord-run-lock-and-go-row).
 *
 * Why: two builders that measure free memory in the same minute both start a heavy run (pre-pr, suite, label run,
 * loop). The lock counts the live runs, reads free memory and processor load, applies the V7.3 tiers and grants or
 * refuses. It is a FILE store: no database table, no migration, no change to lane.mjs.
 *
 * Store: ~/.claude/state/run-locks/ (override: RUN_LOCK_DIR)
 *   <kind>-<pid>-<start>.lock   one JSON file per live run (kind, pid, pidStart, holder, head, startedAt, expiresAt)
 *   (last-grant.json            retired by card run-lock-memory-only: no code reads or writes it, an old file is ignored)
 *   gate.lock                   short exclusive file around every read-decide-write. It holds JSON {pid, pidStart, nonce}
 *                               of its holder. Only file work runs inside it: every process read runs BEFORE it.
 *   MODE                        "warn" or "grant". Missing or any other text: warn. Only the seat changes it.
 *   LIMITS                      {"test": n, "heavy": n}: the pre-pr limits, which the seat can only LOWER (see readLimits). Missing: the code limits.
 *   warn-log.jsonl              one line per start that grant mode would have refused (counts for the warn days)
 *   break-log.jsonl             one line per break or CLI release: who, why (a break), and each removed file with its kind and holder. This log is
 *                               the whole control on break: a file store cannot check who runs it.
 *
 *   runs.jsonl                  one line per START and END of a pre-pr (logRun), with the wall time: the seat reads one file
 *
 * pre-pr phases (card prflow-prepr-speed): a pre-pr lock holds phase "test" (the gates, the only heavy part), "cr" (the CodeRabbit step, no
 * local load) or "wait" (queued, no place) and a heavy flag (the change set runs the hooks-vitest gate). A pre-pr is granted when: at most 2
 * pre-pr runs are in phase test, at most 1 of them heavy, free memory is 5 GB or more and load is under 70 on two reads 30 seconds apart
 * (the second read is skipped with the test hook) and no older waiter exists. A lock with no phase field
 * (old code) and an UNLOCKED RUN count as a heavy run in phase test. A refused pre-pr in grant mode that asks to wait (waitForGrant) leaves
 * a wait record under the file name of its future lock; grants go to the oldest wait record first. setPhase changes the phase of one lock
 * (temp file and rename). Every other heavy kind is granted by free memory (5 GB floor) and load alone: no count tier and no fixed
 * gap between grants (card run-lock-memory-only, Dave 11-17 and 11-26). A refused start asks again after 30 seconds. MODE is never written by this file: the seat sets it.
 *
 * Test hook: RUN_LOCK_TEST_SAMPLES='{"free":[8,8,8],"load":[10,10,10]}' replaces the three real samples (no 6 second wait).
 * It works only when RUN_LOCK_DIR is set to a test store: not unset, and not the default store. An output line says when it
 * is used. A bad value is ignored.
 *
 * GRANTED is not safe from a move of main (see CAVEAT). A run on old code holds no lock, so an UNLOCKED RUN seen
 * (a running pre-pr.mjs with no lock file) is counted as a slot in grant mode, but only when it started more than 2 minutes
 * ago: a younger one may still be in its own acquire.
 *
 * Expiry: a past expiresAt removes a lock only when its holder is not proven alive (pid gone, other start, or a failed read).
 * A run that is alive keeps its lock. A wait record past its expiry holds no queue place and is removed only when its holder is proven dead.
 * setHeavy turns a granted light lock heavy (the run's own change read found the hooks-vitest gate); it checks no limit. --minutes must be a finite number above 0.
 * Gate age: a gate file older than 120 seconds is broken whoever holds it (a wedge). Gated work is file work and takes milliseconds.
 *
 * Exit 1 of the CLI is a usage error or an error of the lock. A caller treats it as "run" (fail open), as pre-pr does: the lock
 * is cooperative and must never stop work because it is broken. Only exit 75 means wait.
 *
 * Usage: node scripts/coordination/run-lock.mjs acquire --kind pre-pr --pid N [--head sha] [--holder name] [--session label] [--minutes N] [--wait]
 *        ... release --pid N [--who name] | register --kind loop --pid N [--holder name] [--session label] [--minutes N] | list | summary
 *        ... break --pid N --reason "why" --who name
 * --pid is required for acquire, register, release and break: it is the process that holds the run. The parent shell of a CLI call ends with the call.
 * Exit: 0 granted, 75 the lock says wait (EX_TEMPFAIL), 1 usage or error. Exit 3 is not used: pre-pr uses it for its own error.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const GATE_STALE_MS = 10_000; // age limit for a gate file that holds no readable holder
const GATE_UNKNOWN_MS = 60_000; // age limit for a gate whose holder has no usable start time (pid reuse cannot be seen)
const LIST_GATE_MS = 2_000; // list is a read: it waits this long for the gate, then lists the live runs and removes nothing
export const EXIT_WAIT = 75; // "the lock says wait". Exit 3 stays free for an error of the caller (pre-pr uses 3).
const GATE_MAX_MS = 120_000; // a gate older than this is broken whoever holds it: the gated part is file work only
const GATE_RM_TRIES = 5; // the finally step tries this often to remove our gate (EBUSY, EPERM)
const UNLOCKED_MIN_AGE_MS = 2 * MIN; // a lock-less pre-pr younger than this may still be in its own acquire
const GATE_CHECK_EVERY = 10; // a waiter checks whether the gate holder is dead on every 10th try
const SAME_PROCESS_MS = 2_000; // a start time within this of the recorded one is the same process
const UNKNOWN = 'unknown'; // a process read that failed. It is not "no such process": the lock stays.

export const CAVEAT = 'NOTE GRANTED is not safe from a move of main: pre-pr.mjs fails a CodeRabbit CLI run if main moves during it. The lock holds no merge tap and no blocklist commit.';

/** Run kinds. heavy: the 5 GB floor (V7.3) and the load bar apply. A light kind needs only the load bar. loadMax: refused at a median load at or above it. */
export const KINDS = {
  'pre-pr': { heavy: true, loadMax: 70, minutes: 60 }, // gates 15 + CodeRabbit step 30 + margin
  suite: { heavy: true, loadMax: 70, minutes: 30 },
  'label-run': { heavy: true, loadMax: 70, minutes: 90 },
  loop: { heavy: true, loadMax: 70, minutes: 720 }, // 12 hours: a loop runs long, and register renews the lock
  'hook-build': { heavy: false, loadMax: 80, minutes: 10 },
};

/** pre-pr phases: test (the gates, the only heavy part), cr (the CodeRabbit step, no local load), wait (queued, no place). */
export const PHASES = ['test', 'cr', 'wait'];
const PRE_PR_TEST_LIMIT = 2; // version 17: at most 2 pre-pr runs in the test phase
const PRE_PR_HEAVY_LIMIT = 1; // ... and at most 1 of them heavy (it runs the hooks-vitest gate)
const HEAVY_MIN_FREE_GB = 5; // V7.3: under this no new heavy run, whatever the count of other runs
const PRE_PR_MIN_FREE_GB = HEAVY_MIN_FREE_GB;
const SECOND_READ_MS = 30_000; // a pre-pr is granted only when two reads this far apart both pass
const RETRY_MS = SECOND_READ_MS; // a refused start asks again after the two-read gap, not after a fixed 2 minutes
const WAIT_RECORD_MIN = 10; // a wait record is renewed at every retry: a waiter that is alive keeps it
const WAIT_LIMIT_MS = 60 * MIN;
const WAIT_MIN_SLEEP_MS = 30_000;
/** A waiter never sleeps this long or longer: its wait record lives WAIT_RECORD_MIN, and an expired record loses the queue place. */
export const WAIT_MAX_SLEEP_MS = 5 * MIN;

/** How long a waiter sleeps before it asks again: until the retry time, at least 30 s, at most WAIT_MAX_SLEEP_MS and never past the time left. */
export const waitSleepMs = (retryAt, now, left) => Math.min(left, WAIT_MAX_SLEEP_MS, Math.max(WAIT_MIN_SLEEP_MS, retryAt - now));
/** A pre-pr lock with no phase field is old code: it counts as a heavy run in phase test (it fails toward waiting). */
const phaseOf = (r) => (r.kind === 'pre-pr' ? r.phase ?? 'test' : null);
const heavyOf = (r) => (r.phase === undefined ? true : r.heavy === true);
const isPrePrTest = (r) => r.kind === 'pre-pr' && phaseOf(r) === 'test';
const isWaiter = (r) => r.kind === 'pre-pr' && r.phase === 'wait';
/** A run that takes a V7.3 slot of another kind: heavy, and not a pre-pr outside its test phase. */
const takesSlot = (r) => KINDS[r.kind]?.heavy && (r.kind !== 'pre-pr' || phaseOf(r) === 'test');

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const num = (n) => Number(Number(n).toFixed(1));
/** Clock text with the zone name, e.g. "09:01 CST". The zone is the system zone unless one is given. A retry time rounds UP to the next minute. */
export function clockText(ms, timeZone, roundUp = true) {
  const t = roundUp ? Math.ceil(ms / MIN) * MIN : Math.floor(ms / MIN) * MIN;
  return new Date(t).toLocaleTimeString('en-US', { ...(timeZone ? { timeZone } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
}

/** Does the script run as the CLI? 'main' (real paths match, case-insensitive on Windows), 'import' (another script runs), or 'miss' (it is named run-lock.mjs but is not this file). */
export function classifyEntry(argv1, metaUrl) {
  if (!argv1) return 'import';
  const here = fileURLToPath(metaUrl);
  const canon = (p) => {
    let r = p;
    try { r = realpathSync.native(p); } catch { /* keep the given path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  if (canon(argv1) === canon(here)) return 'main';
  return basename(argv1).toLowerCase() === basename(here).toLowerCase() ? 'miss' : 'import';
}

const defaultStore = () => join(os.homedir(), '.claude', 'state', 'run-locks');
export const defaultDir = () => process.env.RUN_LOCK_DIR || defaultStore();
const sameFolder = (a, b) => { const n = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)); return n(a) === n(b); };

// ---------- real machine reads (every one is injectable) ----------

/** Output of a PowerShell command, or null when the call failed (start error, time-out, non-zero exit). An empty string is a real empty answer. */
function ps(command, spawn = spawnSync) {
  const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return r.error || r.status !== 0 ? null : String(r.stdout ?? '').trim();
}

/**
 * Start time of a process in epoch ms, null when it does not run, or 'unknown' when the read failed. Windows reuses pids,
 * so a pid alone proves nothing. "Gone" needs an explicit answer: a time-out, an error, no output or a date we cannot
 * parse is 'unknown', and the lock stays. io.spawn and io.platform let a test feed each case.
 */
export function realPidStart(pid, io = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const spawn = io.spawn || spawnSync;
  if ((io.platform || process.platform) === 'win32') {
    // GONE is printed on purpose: PowerShell exits non-zero for a missing process, and empty output must not mean "gone".
    const out = ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') } else { 'GONE' }`, spawn);
    if (out === null || out === '') return UNKNOWN;
    if (out === 'GONE') return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : UNKNOWN;
  }
  const r = spawn('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.error || r.status === null) return UNKNOWN;
  const text = String(r.stdout ?? '').trim();
  if (r.status === 1 && !text && !String(r.stderr ?? '').trim()) return null; // ps says no process matches
  const t = Date.parse(text);
  return r.status === 0 && Number.isFinite(t) ? t : UNKNOWN;
}

/**
 * A command line that runs run-wrap.mjs (the wrapper of card coord-run-lock-wrapper-loops). A wrapped pre-pr has two processes whose command line
 * holds pre-pr.mjs: the wrapper and its child. The wrapper is not a run (its child is), so it must never count as an unlocked run. The file name
 * must stand alone as a path part: a body file with "run-wrap.mjs" inside a longer name does not hide a real run.
 */
const WRAPPER_CMD = /(?:^|[\s"'\\/])run-wrap\.mjs(?:[\s"']|$)/;

/** Running pre-pr.mjs processes: [{pid, start}]. Used only to see a run on old code that holds no lock file. A run-wrap process is not one. A failed read gives []. io.spawn and io.platform let a test feed each case. */
export function realPrePrProcs(io = {}) {
  const spawn = io.spawn || spawnSync;
  if ((io.platform || process.platform) === 'win32') {
    const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'scripts[\\\\/]github[\\\\/]pre-pr\\.mjs' } | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))|$($_.CommandLine -replace '[\\r\\n]+',' ')\" }", spawn);
    return (out || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, at, ...cmd] = l.split('|'); return { pid: Number(pid), start: Date.parse(at), cmd: cmd.join('|') }; })
      .filter((p) => p.pid > 0 && !WRAPPER_CMD.test(p.cmd)).map(({ pid, start }) => ({ pid, start }));
  }
  const r = spawn('pgrep', ['-af', 'scripts/github/pre-pr\\.mjs'], { encoding: 'utf8' });
  // A failed pgrep has no stdout: it gives no process, never one fake run with pid NaN. A line is "pid" or "pid command".
  return String(r.stdout ?? '').split(/\r?\n/).map((l) => /^\s*(\d+)(?:\s+(.*))?$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] || '' })).filter((p) => Number.isInteger(p.pid) && p.pid > 0 && !WRAPPER_CMD.test(p.cmd))
    .map(({ pid }) => ({ pid, start: realPidStart(pid, io) }));
}

const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });

/** Three samples of free memory (GB) and processor load (percent), 2 seconds apart. */
export async function realSamples(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const free = [];
  const load = [];
  let prev = cpuTimes();
  for (let i = 0; i < 3; i++) {
    await sleep(2000);
    const cur = cpuTimes();
    const total = cur.total - prev.total;
    load.push(total > 0 ? Math.round(100 * (1 - (cur.idle - prev.idle) / total)) : 0);
    free.push(os.freemem() / 2 ** 30);
    prev = cur;
  }
  return { free, load };
}

/** Samples from the test hook, or null when it is unset or bad. It works only when RUN_LOCK_DIR is set to a test store: not unset, not the default store. */
function hookedSamples(env) {
  if (!env.RUN_LOCK_DIR || sameFolder(env.RUN_LOCK_DIR, defaultStore())) return null;
  try {
    const s = JSON.parse(env.RUN_LOCK_TEST_SAMPLES);
    const ok = (a) => Array.isArray(a) && a.length > 0 && a.every((n) => Number.isFinite(n));
    return ok(s.free) && ok(s.load) ? { free: s.free, load: s.load } : null;
  } catch { return null; }
}

function defaults(deps = {}) {
  const env = deps.env || process.env;
  const hook = deps.samples ? null : hookedSamples(env);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    env,
    timeZone: deps.timeZone,
    samplesHooked: !!hook,
    dir: deps.dir || defaultDir(),
    now: deps.now || Date.now,
    sleep,
    samples: deps.samples || (hook ? async () => hook : () => realSamples(sleep)),
    pidStart: deps.pidStart || realPidStart,
    prePrProcs: deps.prePrProcs || realPrePrProcs,
    selfPid: deps.selfPid ?? process.pid,
    beforeGateBreak: deps.beforeGateBreak,
    afterGateRename: deps.afterGateRename,
    beforeSweepRemove: deps.beforeSweepRemove, // test seam: runs in sweep between the decision to remove a lock and the remove
    rmFile: deps.rmFile || rmSync, // test seam: the finally step removes our gate with this
  };
}

// ---------- store ----------

const readMode = (dir) => {
  try { return readFileSync(join(dir, 'MODE'), 'utf8').trim().toLowerCase() === 'grant' ? 'grant' : 'warn'; } catch { return 'warn'; }
};
/** The MODE of a store: 'grant' or 'warn'. Any other text, or a missing file, is warn. */
export const lockMode = (dir = defaultDir()) => readMode(dir);

/**
 * The pre-pr limits in force: { test, heavy, source }. Only the seat writes the LIMITS file ({"test": n, "heavy": n}), and it can only LOWER
 * the code limits: each value a whole number from 1 to its code limit, heavy not above test. Any other content (a raise, under 1, a
 * non-integer, heavy above test, bad JSON) gives 1 and 1: a bad file fails toward fewer runs. No file gives the code limits. Read at each acquire.
 */
export function readLimits(dir = defaultDir()) {
  let text;
  try { text = readFileSync(join(dir, 'LIMITS'), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { test: PRE_PR_TEST_LIMIT, heavy: PRE_PR_HEAVY_LIMIT, source: 'code' }; // only a missing file gives the code limits
    return { test: 1, heavy: 1, source: 'LIMITS file cannot be read, so 1 and 1' }; // EPERM, EISDIR, EBUSY: fewer runs
  }
  let v = null;
  try { v = JSON.parse(text); } catch { /* bad JSON: the fallback below */ }
  const ok = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
  if (v && typeof v === 'object' && ok(v.test, PRE_PR_TEST_LIMIT) && ok(v.heavy, PRE_PR_HEAVY_LIMIT) && v.heavy <= v.test) return { test: v.test, heavy: v.heavy, source: 'LIMITS file' };
  return { test: 1, heavy: 1, source: 'LIMITS file not valid, so 1 and 1' };
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const appendLine = (dir, name, obj) => appendFileSync(join(dir, name), `${JSON.stringify(obj)}\n`);

function lockRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.lock') && f !== 'gate.lock')
    .map((f) => ({ file: f, rec: readJson(join(dir, f)) })).filter((x) => x.rec && x.rec.kind && x.rec.pid);
}

/**
 * ONE process read per lock holder, taken BEFORE the gate. A PowerShell call can take 20 seconds: it must not run
 * while the gate is held. Returns Map lock file name -> { start, startedAt }. start is a number, null (no such process)
 * or 'unknown' (read failed). The key is the FILE, not the pid: a new run that reuses a pid writes a new file, and a file
 * that is not here is unknown. startedAt tells a file that was rewritten under the same name.
 */
function startsSnapshot(d) {
  const byPid = new Map();
  const starts = new Map();
  for (const { file, rec } of lockRecords(d.dir)) {
    if (!byPid.has(rec.pid)) byPid.set(rec.pid, d.pidStart(rec.pid));
    starts.set(file, { start: byPid.get(rec.pid), startedAt: rec.startedAt });
  }
  return starts;
}

/** A run is dead only when its pid is gone or now has another start time. An unknown read, or a lock newer than the snapshot, keeps it. */
function isDead(file, rec, starts) {
  const seen = starts.get(file);
  if (!seen || seen.startedAt !== rec.startedAt) return false; // written or rewritten after the snapshot: unknown
  if (seen.start === null) return true;
  if (typeof seen.start !== 'number' || typeof rec.pidStart !== 'number') return false;
  return Math.abs(seen.start - rec.pidStart) >= SAME_PROCESS_MS;
}

/** Is the holder proven alive: the snapshot has this exact file and the start time still matches? Gone, other start and unknown are not proof. */
function provenAlive(file, rec, starts) {
  const seen = starts.get(file);
  if (!seen || seen.startedAt !== rec.startedAt) return false;
  return typeof seen.start === 'number' && typeof rec.pidStart === 'number' && Math.abs(seen.start - rec.pidStart) < SAME_PROCESS_MS;
}

/**
 * Remove the lock files of a dead run. A past expiry removes a lock only when the holder is NOT proven alive: a long pre-pr,
 * a machine sleep or a loop with no renew must keep its slot. A lock with no finite expiry counts as expired, so only proof of life keeps it. File work only.
 * Return the live ones. remove false lists the live ones and removes nothing (list, when it cannot take the gate).
 * Callers that remove must hold the gate: a renew that writes the same file name must not meet our remove.
 */
function sweep(d, starts, remove = true) {
  const now = d.now();
  const live = [];
  for (const { file, rec } of lockRecords(d.dir)) {
    const expired = !Number.isFinite(rec.expiresAt) || rec.expiresAt <= now; // no finite expiry (old code) counts as expired; a proven-alive holder still keeps the lock
    // A lapsed wait record holds no queue place (prePrRefusals), but its process may still run. Only proof of death removes it: a removed record
    // would leave a live pre-pr with no lock file, and unlockedRuns would count it as a test run.
    const lapsedWaiter = expired && isWaiter(rec);
    if (isDead(file, rec, starts) || (expired && !lapsedWaiter && !provenAlive(file, rec, starts))) {
      if (remove) {
        d.beforeSweepRemove?.(file);
        try { rmSync(join(d.dir, file)); } catch { /* another session removed it */ }
      }
      continue;
    }
    live.push({ ...rec, file });
  }
  return live;
}

/**
 * A pre-pr process with no lock file, other than the caller. It counts only when its start is a number more than 2 minutes
 * old: a younger one may be in its own acquire (6 seconds of samples, no lock yet), and counting it makes parallel starts
 * refuse each other. A start we cannot read (NaN, unknown, null) is not counted: the lock fails open, as it does elsewhere.
 */
const unlockedRuns = (d, live, procs) => {
  const now = d.now();
  return procs.filter((p) => p.pid !== d.selfPid && !live.some((l) => l.pid === p.pid) && Number.isFinite(p.start) && now - p.start > UNLOCKED_MIN_AGE_MS);
};
const unlockedLine = (u) => `UNLOCKED RUN seen: ${u.length} pre-pr.mjs process(es) with no lock file (pid ${u.map((p) => p.pid).join(', ')}); counted as a slot in grant mode`;

// ---------- the gate ----------

const parseGate = (text) => { try { const g = JSON.parse(text); return g && Number.isInteger(g.pid) ? g : null; } catch { return null; } };

/** Is the gate file older than the limit? A file we cannot stat is not old. */
function gateOlderThan(gate, limitMs) {
  try { return Date.now() - statSync(gate).mtimeMs > limitMs; } catch { return false; }
}

/**
 * Is the holder of this gate dead? Uses a process read, so it runs only while we WAIT, never while we hold the gate.
 * A holder with no usable start time cannot be compared after pid reuse: the age of the gate file decides (60 seconds,
 * far more than file work needs).
 */
function gateHolderDead(d, text, gate) {
  if (gateOlderThan(gate, GATE_MAX_MS)) return true; // a live holder never keeps a gate this long: file work takes milliseconds. It is a wedge.
  const holder = parseGate(text);
  if (!holder) return gateOlderThan(gate, GATE_STALE_MS); // no readable holder (half-written, or an old format): only age can tell
  const start = d.pidStart(holder.pid);
  if (start === null) return true;
  if (typeof start !== 'number') return false; // our own read failed: we cannot tell
  if (typeof holder.pidStart !== 'number') return gateOlderThan(gate, GATE_UNKNOWN_MS);
  return Math.abs(start - holder.pidStart) >= SAME_PROCESS_MS;
}

/**
 * Break the gate file of a dead holder. A read-then-delete has a window: another process may replace the file in it. So
 * move the file to a unique name first (one process wins the move), then compare what we moved with what we judged.
 * Same text: drop it. Other text: it is a live holder's gate, so put it back (a hard link cannot overwrite a gate that a
 * third process took in the meantime).
 * The slow process read of the judgment sits before the move, so read the gate again right before the move and stop when
 * it changed. This narrows the window, it does not close it: a third process can still win the gate name between our
 * rename and the put-back. Then the put-back fails and that process owns the name. If the moved file was a live gate whose
 * holder already ended, the put-back makes a gate that nobody removes: the 120 second age limit breaks it.
 */
function breakDeadGate(d, gate) {
  let text;
  try { text = readFileSync(gate, 'utf8'); } catch { return false; }
  if (!gateHolderDead(d, text, gate)) return false;
  d.beforeGateBreak?.(); // test seam: runs in the window between the judgment and the move
  try { if (readFileSync(gate, 'utf8') !== text) return false; } catch { return false; } // changed or gone since the judgment
  const aside = `${gate}.broken-${randomUUID()}`;
  try { renameSync(gate, aside); } catch { return false; } // gone, or another process broke it first
  d.afterGateRename?.(); // test seam: runs after the move and before the compare. A live holder may take the free name here.
  let moved = null;
  try { moved = readFileSync(aside, 'utf8'); } catch { /* read failed: treat as foreign and put it back */ }
  if (moved !== text) { try { linkSync(aside, gate); } catch { /* the name is taken again: that holder owns it now */ } }
  try { rmSync(aside); } catch { /* already gone */ }
  return moved === text;
}

/** Run fn while we hold gate.lock. budgetMs (list only) ends the wait early: the caller then fails open. The gate holds our pid, start time and a nonce; we remove it only if it still holds that text. */
async function withGate(d, selfStart, fn, budgetMs = null) {
  mkdirSync(d.dir, { recursive: true });
  const began = Date.now();
  const gate = join(d.dir, 'gate.lock');
  const body = JSON.stringify({ pid: d.selfPid, pidStart: selfStart, nonce: randomUUID() });
  for (let i = 0; ; i++) {
    try { writeFileSync(gate, body, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (i >= 499 || (budgetMs !== null && Date.now() - began > budgetMs)) throw new Error('run-lock: the gate file stays held');
      if (i % GATE_CHECK_EVERY === 0 && breakDeadGate(d, gate)) continue;
      await d.sleep(20);
    }
  }
  try { return await fn(); } finally {
    // A remove can fail for a moment (EBUSY, EPERM: a virus scanner, an indexer). Try a few times, then give up: the gate
    // is then older than 120 seconds for the next process, which breaks it. A manual loop: rmSync maxRetries needs recursive.
    for (let i = 0; i < GATE_RM_TRIES; i++) {
      try { if (readFileSync(gate, 'utf8') === body) d.rmFile(gate); break; } catch (e) {
        if (e.code === 'ENOENT') break; // already gone
        await d.sleep(20);
      }
    }
  }
}

/** The session label for a lock: the caller's text, else "#sid8" from the session id in the environment. Never bare hex. */
function sessionLabel(opts, d) {
  if (String(opts.session || '').trim()) return String(opts.session).trim();
  const id = String(d.env.CLAUDE_CODE_SESSION_ID || '');
  return /^[0-9a-f-]{8,}$/i.test(id) ? `#${id.slice(0, 8)}` : null;
}

function writeLock(d, kind, opts, start, now, reading = null) {
  const rec = {
    kind, pid: opts.pid, pidStart: start, holder: opts.holder || 'unknown', head: opts.head || null, session: sessionLabel(opts, d),
    startedAt: now, expiresAt: now + (opts.minutes || KINDS[kind].minutes) * MIN,
    // The machine read that decided the grant (card coord-run-lock-reading). Only a granted acquire passes one: register and a wait record leave it out.
    ...(reading ? { grantFreeGB: reading.freeGB, grantLoadPct: reading.loadPct } : {}),
    ...(kind === 'pre-pr' ? { heavy: opts.heavy === true, phase: opts.phase || 'test' } : {}),
  };
  const file = `${kind}-${opts.pid}-${start}.lock`;
  writeFileSync(join(d.dir, file), JSON.stringify(rec, null, 1));
  // One run, one file. After a failed start read the name holds "unknown"; a later renew names it with the real start time.
  // Remove the other files of this pid and kind, so one loop never takes two slots. Runs inside the gate, after our write.
  for (const other of lockRecords(d.dir)) {
    if (other.file !== file && other.rec.pid === opts.pid && other.rec.kind === kind) {
      try { rmSync(join(d.dir, other.file)); } catch { /* another session removed it */ }
    }
  }
  return file;
}

// ---------- verbs ----------

/** The kind entry, or a usage error. Object.hasOwn: "constructor" and "__proto__" are not kinds. */
function knownKind(name) {
  if (typeof name !== 'string' || !Object.hasOwn(KINDS, name)) throw new Error(`unknown kind "${name}" (known: ${Object.keys(KINDS).join(', ')})`);
  return KINDS[name];
}

/** --minutes is a finite number above 0, or not given. Infinity would write a null expiry, 0 would fall back to the default without a word. */
function checkMinutes(minutes) {
  if (minutes == null) return;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) throw new Error(`--minutes must be a finite number above 0 (got ${minutes})`);
}

/** Median free memory (GB) and load (percent) of one read. */
const readOf = (s) => ({ freeGB: median(s.free), loadPct: median(s.load) });
const readPasses = (r, kind) => r.loadPct < kind.loadMax && r.freeGB >= PRE_PR_MIN_FREE_GB;

/**
 * The machine read of an acquire. A pre-pr is granted only when two reads 30 seconds apart both pass (a load spike must not slip
 * through between two samples). The second read is skipped when the first already refuses, and when the samples come from the test
 * hook. The worst of the reads is used.
 */
async function machineRead(d, opts, kind) {
  const first = readOf(await d.samples());
  if (opts.kind !== 'pre-pr' || d.samplesHooked || !readPasses(first, kind)) return first;
  await d.sleep(SECOND_READ_MS);
  const second = readOf(await d.samples());
  return { freeGB: Math.min(first.freeGB, second.freeGB), loadPct: Math.max(first.loadPct, second.loadPct) };
}

/** The refusals of version 17 for a pre-pr: places in the test phase, heavy places, free memory, older waiters. */
function prePrRefusals({ opts, live, unlocked, own, now, freeGB, refuse, limits }) {
  const tests = live.filter(isPrePrTest);
  const inTest = tests.length + unlocked.length;
  const heavyTest = tests.filter(heavyOf).length + unlocked.length;
  if (freeGB < PRE_PR_MIN_FREE_GB && !live.some((r) => r.kind === 'loop')) refuse('memory', `free memory ${num(freeGB)} GB under ${PRE_PR_MIN_FREE_GB} GB`);
  if (inTest >= limits.test) refuse('slots', `${inTest} pre-pr runs in the test phase, the limit in force is ${limits.test} (${limits.source})`);
  if (opts.heavy === true && heavyTest >= limits.heavy) refuse('heavy', `${heavyTest} heavy pre-pr run in the test phase (it runs the hooks-vitest gate), the heavy limit in force is ${limits.heavy} (${limits.source})`);
  const since = own?.waitSince ?? now;
  const orderOf = (r) => r.waitSince ?? r.startedAt;
  const older = live.filter((r) => isWaiter(r) && r.expiresAt > now && r.pid !== opts.pid && (orderOf(r) < since || (orderOf(r) === since && r.pid < opts.pid)));
  if (older.length) refuse('queue', `${older.length} older waiter(s) come first (pid ${older.map((r) => r.pid).join(', ')})`);
}

/**
 * The V7.3 memory floor, for every heavy kind: under 5 GB free no new heavy run. There is no count tier: free memory and load decide.
 * A pre-pr with no loop live already has its own refusal (key memory, in prePrRefusals), so it gets no second one here. A pre-pr
 * while a loop is live gets this one (the pre-pr line skips it on purpose: version 17 of the pre-pr refusals, left as it is).
 */
function floorRefusal({ opts, kind, live, freeGB, refuse }) {
  if (!kind.heavy || freeGB >= HEAVY_MIN_FREE_GB) return;
  const loopLive = live.some((r) => r.kind === 'loop');
  if (opts.kind === 'pre-pr' && !loopLive) return;
  refuse('floor', `free memory ${num(freeGB)} GB under ${HEAVY_MIN_FREE_GB} GB${loopLive ? ' while a loop is live' : ''}`);
}

/** The wait record of a refused pre-pr in grant mode: it takes no place, it holds the queue order. Same file name as the lock it becomes. */
function writeWaitRecord(d, opts, pid, start, own, now) {
  const file = `pre-pr-${pid}-${start}.lock`;
  const rec = { kind: 'pre-pr', pid, pidStart: start, holder: opts.holder || 'unknown', head: opts.head || null, session: sessionLabel(opts, d), startedAt: now, expiresAt: now + WAIT_RECORD_MIN * MIN, heavy: opts.heavy === true, phase: 'wait', waitSince: own?.waitSince ?? now };
  writeFileSync(join(d.dir, file), JSON.stringify(rec, null, 1));
  // After a failed start read the first record has the name "unknown": remove the other WAIT records of this pid. Never a test or cr record.
  for (const other of lockRecords(d.dir)) {
    if (other.file !== file && other.rec.pid === pid && isWaiter(other.rec)) {
      try { rmSync(join(d.dir, other.file)); } catch { /* another session removed it */ }
    }
  }
  return file;
}

/** Ask for a slot. Returns { granted, warned, lines, retryAt, reasons, file, freeGB, loadPct }. Throws on an unknown kind or a dead pid. opts.wait (grant mode, pre-pr): a refusal leaves a wait record. */
export async function acquire(opts, deps) {
  const d = defaults(deps);
  const kind = knownKind(opts.kind);
  checkMinutes(opts.minutes);
  const pid = opts.pid ?? d.selfPid;
  const start = d.pidStart(pid);
  if (start === null) throw new Error(`pid ${pid} is not running`);
  const { freeGB, loadPct } = await machineRead(d, opts, kind);
  const selfStart = pid === d.selfPid ? start : d.pidStart(d.selfPid);
  const starts = startsSnapshot(d);
  const procs = d.prePrProcs();
  return withGate(d, selfStart, async () => {
    const now = d.now();
    const mode = readMode(d.dir);
    const live = sweep(d, starts);
    const unlocked = unlockedRuns(d, live, procs);
    const own = live.find((r) => isWaiter(r) && r.pid === pid);
    const keys = [];
    const reasons = [];
    const refuse = (key, text) => { keys.push(key); reasons.push(text); };
    if (loadPct >= kind.loadMax) refuse('load', `load ${loadPct} percent (limit ${kind.loadMax} percent for ${opts.kind})`);
    if (opts.kind === 'pre-pr') prePrRefusals({ opts: { ...opts, pid }, live, unlocked, own, now, freeGB, refuse, limits: readLimits(d.dir) });
    floorRefusal({ opts, kind, live, freeGB, refuse });
    const heavyLive = live.filter(takesSlot).length + unlocked.length;
    const retryAt = reasons.length ? now + RETRY_MS : now;
    const lines = unlocked.length ? [unlockedLine(unlocked)] : [];
    if (d.samplesHooked) lines.unshift('NOTE samples come from RUN_LOCK_TEST_SAMPLES (a test hook), not from the machine');
    const wait = `${reasons.join('; ')}; try again after ${clockText(retryAt, d.timeZone)}`;
    const read = { freeGB: num(freeGB), loadPct };
    if (reasons.length && mode === 'grant') {
      const waitFile = opts.wait && opts.kind === 'pre-pr' ? writeWaitRecord(d, opts, pid, start, own, now) : undefined;
      // One row for each refused pre-pr start that has no wait record of its pid yet (a start with --wait-lock logs once, the first ask), so the seat reads a refused start in runs.jsonl. A failed write never stops the run.
      if (opts.kind === 'pre-pr' && !own) { try { appendLine(d.dir, 'runs.jsonl', { ts: now, event: 'wait', pid, head: opts.head || null, queued: Boolean(waitFile), keys, reasons }); } catch { /* a log problem never stops the run */ } }
      return { granted: false, warned: false, lines: [...lines, `WAIT ${wait}`, CAVEAT], retryAt, reasons, keys, waitFile, ...read };
    }
    // The warn log comes first: a failed append then leaves no lock and no last-grant behind.
    if (reasons.length) {
      appendLine(d.dir, 'warn-log.jsonl', { ts: now, kind: opts.kind, holder: opts.holder || 'unknown', head: opts.head || null, pid, keys, reasons, freeGB: num(freeGB), loadPct, heavyLive });
      lines.push(`WOULD WAIT ${wait}`);
    }
    const file = writeLock(d, opts.kind, { ...opts, pid }, start, now, { freeGB: num(freeGB), loadPct: Math.round(loadPct) });
    const slot = kind.heavy ? '' : ' no slot needed';
    lines.push(`GRANTED ${opts.kind}${slot} (free ${num(freeGB)} GB, load ${loadPct} percent, mode ${mode})`, CAVEAT);
    return { granted: true, warned: reasons.length > 0, lines, file, mode, reasons, keys, ...read };
  });
}

/**
 * Acquire and, in grant mode, wait for a place: ask again at the retry time until a grant or maxMs (60 minutes) pass. A timeout is
 * { granted: false, exit: 75 } and the wait record is removed. The caller frees the lock as before. Warn mode never waits (it grants).
 * opts may be a function: it is called at every attempt, so facts that change while we wait (the head, the heavy flag) are read again.
 */
export async function waitForGrant(opts, deps, { maxMs = WAIT_LIMIT_MS } = {}) {
  const d = defaults(deps);
  const began = d.now();
  const late = () => d.now() - began >= maxMs;
  // The timeout frees the wait record or a late grant. A grant after the deadline is no grant: granted false, so the caller exits 75.
  const stop = (r, o) => {
    releaseSync({ pid: o.pid ?? d.selfPid, kind: o.kind }, deps);
    return { ...r, granted: false, timedOut: true, exit: EXIT_WAIT };
  };
  let r = { granted: false, lines: [] };
  for (;;) {
    const now = typeof opts === 'function' ? opts() : opts;
    if (late()) return stop(r, now); // the sleep can end after the deadline: no acquire then
    r = await acquire({ ...now, wait: true }, deps);
    if (r.granted) return late() ? stop(r, now) : r; // the acquire itself (the 30 s second read) can pass the deadline
    const left = maxMs - (d.now() - began);
    if (left <= 0) return stop(r, now);
    await d.sleep(waitSleepMs(r.retryAt, d.now(), left));
  }
}

/**
 * Change fields of a pre-pr lock, synchronously: file work only, written to a temp file and renamed over the lock. The lock is found
 * by its file name (kind, pid and start time), so a reused pid with another start time is not the holder; the record must also name the
 * pid. A file name that is given and is not the derived name needs a record start equal to the live start of the pid. { changed: false }
 * when the file is not there or is not ours.
 */
function patchLock(opts, deps, patch) {
  const d = defaults(deps);
  const live = d.pidStart(opts.pid);
  const derived = `pre-pr-${opts.pid}-${live}.lock`;
  const name = basename(opts.file ?? derived);
  const file = join(d.dir, name);
  const rec = readJson(file);
  if (!rec || rec.pid !== opts.pid || rec.kind !== 'pre-pr') return { changed: false };
  const sameStart = typeof live === 'number' && typeof rec.pidStart === 'number' && Math.abs(live - rec.pidStart) < SAME_PROCESS_MS;
  if (name !== derived && !sameStart) return { changed: false };
  const temp = `${file}.tmp-${randomUUID()}`;
  try { writeFileSync(temp, JSON.stringify({ ...rec, ...patch }, null, 1)); renameSync(temp, file); } catch (err) {
    try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ }
    throw err;
  }
  return { changed: true };
}

/** Change the phase of a pre-pr lock (see patchLock). */
export function setPhase(opts, deps) {
  if (!PHASES.includes(opts.phase)) throw new Error(`unknown phase "${opts.phase}" (known: ${PHASES.join(', ')})`);
  return patchLock(opts, deps, { phase: opts.phase });
}

/** Turn a pre-pr lock heavy (see patchLock): the run's own change read found the hooks-vitest gate after a light grant. It checks no limit. */
export function setHeavy(opts, deps) {
  return patchLock(opts, deps, { heavy: true });
}

/** One row in runs.jsonl (START and END of a pre-pr, with the wall time), so the seat reads one file. A failed write never stops the run. */
export function logRun(row, deps) {
  const d = defaults(deps);
  try { mkdirSync(d.dir, { recursive: true }); appendLine(d.dir, 'runs.jsonl', { ts: d.now(), ...row }); } catch { /* a log problem never stops the run */ }
}

/** Record a run that already runs (a loop, a label run). Nothing is refused: it is running. It counts as a slot. */
export async function register(opts, deps) {
  const d = defaults(deps);
  knownKind(opts.kind);
  checkMinutes(opts.minutes);
  const start = d.pidStart(opts.pid);
  if (start === null) throw new Error(`pid ${opts.pid} is not running`);
  const selfStart = opts.pid === d.selfPid ? start : d.pidStart(d.selfPid);
  const starts = startsSnapshot(d);
  return withGate(d, selfStart, async () => {
    sweep(d, starts);
    const file = writeLock(d, opts.kind, opts, start, d.now());
    return { registered: true, file, lines: [`REGISTERED ${opts.kind} pid ${opts.pid} holder ${opts.holder || 'unknown'}`, CAVEAT] };
  });
}

/** Free the lock files of one pid, synchronously: safe inside a process 'exit' handler, which waits for no promise. */
export function releaseSync(opts, deps) {
  const d = defaults(deps);
  const files = [];
  for (const { file, rec } of lockRecords(d.dir)) {
    if (rec.pid === opts.pid && (!opts.kind || rec.kind === opts.kind)) {
      try { rmSync(join(d.dir, file)); files.push({ file, kind: rec.kind, holder: rec.holder || 'unknown' }); } catch { /* another session removed it */ }
    }
  }
  return { removed: files.length, files };
}

export async function release(opts, deps) {
  return releaseSync(opts, deps);
}

/**
 * The CLI release: log one line to break-log.jsonl BEFORE the removal (pid, kind 'release', who, each file), then release.
 * A release by hand has no other trace. The pre-pr exit handler calls releaseSync, not this, so a normal run writes no line.
 * who is --who, else the session label, else "unknown". A failed log write does not block the release: the lock must go.
 */
export async function releaseLogged(opts, deps) {
  const d = defaults(deps);
  const listed = lockRecords(d.dir).filter(({ rec }) => rec.pid === opts.pid).map(({ file, rec }) => ({ file, kind: rec.kind, holder: rec.holder || 'unknown' }));
  const who = String(opts.who || '').trim() || sessionLabel({}, d) || 'unknown';
  try {
    mkdirSync(d.dir, { recursive: true });
    appendLine(d.dir, 'break-log.jsonl', { ts: d.now(), kind: 'release', who, pid: opts.pid, removed: listed.length, files: listed });
  } catch { /* the store is not writable: the release below finds nothing or fails too */ }
  return release({ pid: opts.pid }, d);
}

/** Remove a lock by hand. A reason and a name are required. The log line holds who, why and each removed file with its kind and holder: that is the whole control. */
export async function breakLock(opts, deps) {
  const d = defaults(deps);
  if (!String(opts.reason || '').trim()) throw new Error('break needs a reason (--reason "why")');
  if (!String(opts.who || '').trim()) throw new Error('break needs a name (--who "name")');
  // List first and log BEFORE any removal: a failed log write must not leave a removal with no record.
  const listed = lockRecords(d.dir).filter(({ rec }) => rec.pid === opts.pid).map(({ file, rec }) => ({ file, kind: rec.kind, holder: rec.holder || 'unknown' }));
  mkdirSync(d.dir, { recursive: true });
  appendLine(d.dir, 'break-log.jsonl', { ts: d.now(), who: String(opts.who).trim(), pid: opts.pid, reason: opts.reason, removed: listed.length, files: listed });
  const { removed, files } = await release({ pid: opts.pid }, d);
  return { removed, files };
}

/**
 * The sweep for list, inside the gate as register and acquire do. The process reads come first (the snapshot, the self start),
 * then file work only. A missing store has nothing to sweep: no gate, and the read must not create the store. A gate that
 * cannot be taken (it stays held) fails open: list the live runs and remove nothing.
 */
async function sweepGated(d, starts) {
  if (!existsSync(d.dir)) return sweep(d, starts, false);
  const selfStart = d.pidStart(d.selfPid);
  try { return await withGate(d, selfStart, () => sweep(d, starts), LIST_GATE_MS); } catch { return sweep(d, starts, false); }
}

/** The reading at the grant as list text, at the END of the row line; empty for a row with no reading or a bad value (never 0). */
const readingText = (r) => (Number.isFinite(r.grantFreeGB) && Number.isFinite(r.grantLoadPct) ? ` read free ${r.grantFreeGB} GB load ${r.grantLoadPct} pct` : '');

export async function list(deps) {
  const d = defaults(deps);
  const starts = startsSnapshot(d);
  const procs = d.prePrProcs();
  const live = await sweepGated(d, starts);
  const unlocked = unlockedRuns(d, live, procs);
  const lines = [`mode: ${readMode(d.dir)}`, `store: ${d.dir}`];
  for (const r of live) lines.push(`${r.kind} pid ${r.pid} holder ${r.holder}${r.session ? ` session ${r.session}` : ''}${r.phase ? ` phase ${r.phase}` : ''} since ${clockText(r.startedAt, d.timeZone, false)} until ${clockText(r.expiresAt, d.timeZone)}${readingText(r)}`);
  if (!live.length) lines.push('no live lock');
  if (unlocked.length) lines.push(unlockedLine(unlocked));
  lines.push(CAVEAT);
  return { live, unlocked, mode: readMode(d.dir), lines };
}

const WARN_BIAS = 'Warn mode lets every start run. A start that grant mode would refuse still takes a slot and moves the 2 minute clock, so later starts see more load than grant mode would: these counts run high.';

/** Counts of the logged WOULD WAIT lines, for the warn days: how many starts the lock would have held, and why. */
export function warnSummary(dir = defaultDir()) {
  const out = { total: 0, byReason: {}, byKind: {}, note: WARN_BIAS };
  let text = '';
  try { text = readFileSync(join(dir, 'warn-log.jsonl'), 'utf8'); } catch { return out; }
  for (const l of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(l); } catch { continue; }
    out.total++;
    for (const k of row.keys || []) out.byReason[k] = (out.byReason[k] || 0) + 1;
    out.byKind[row.kind] = (out.byKind[row.kind] || 0) + 1;
  }
  return out;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'wait') o.wait = true;
    else o[key] = argv[++i];
  }
  return o;
}

async function cli(argv) {
  const a = parseArgs(argv);
  const verb = a._[0];
  const pid = a.pid ? Number(a.pid) : undefined;
  const minutes = 'minutes' in a ? Number(a.minutes) : undefined; // a bad value (0, text, Infinity, no value) reaches checkMinutes and is a usage error
  const print = (lines) => { for (const l of lines) console.log(l); };
  if (['acquire', 'register', 'release', 'break'].includes(verb) && !(Number.isInteger(pid) && pid > 0)) {
    throw new Error(`${verb} needs --pid N: the process that holds the run. The parent shell of this call ends with the call.`);
  }
  if (verb === 'acquire') {
    const opts = { kind: a.kind, pid, head: a.head, holder: a.holder, session: a.session, minutes };
    const deadline = Date.now() + (a['max-wait'] ? Number(a['max-wait']) : 60) * MIN;
    for (;;) {
      const r = await acquire(opts);
      print(r.lines);
      if (r.granted) return 0;
      if (!a.wait || Date.now() >= deadline) return EXIT_WAIT;
      await new Promise((res) => setTimeout(res, Math.max(30_000, r.retryAt - Date.now())));
    }
  }
  if (verb === 'register') { print((await register({ kind: a.kind, pid, head: a.head, holder: a.holder, session: a.session, minutes })).lines); return 0; }
  if (verb === 'release') { const r = await releaseLogged({ pid, who: a.who }); console.log(`released ${r.removed} lock(s) of pid ${pid}`); return 0; }
  if (verb === 'break') { const r = await breakLock({ pid, reason: a.reason, who: a.who }); console.log(`broke ${r.removed} lock(s) of pid ${pid}`); return 0; }
  if (verb === 'list') { print((await list()).lines); return 0; }
  if (verb === 'summary') { console.log(JSON.stringify(warnSummary(), null, 1)); return 0; }
  console.error(`usage: run-lock.mjs acquire|register|release|break|list|summary (see the header of this file). Exit: 0 granted, ${EXIT_WAIT} the lock says wait, 1 usage or error.`);
  return 1;
}

const entry = classifyEntry(process.argv[1], import.meta.url);
// A miss is a script named run-lock.mjs that is not this file. Say so once on stderr and run the CLI: a silent exit hides the cause.
if (entry === 'miss') console.error(`run-lock: this file ran as ${process.argv[1]}, but its real path is ${fileURLToPath(import.meta.url)}. The CLI runs anyway.`);
if (entry === 'main' || entry === 'miss') cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`run-lock: ${e.message}`); process.exit(1); });
