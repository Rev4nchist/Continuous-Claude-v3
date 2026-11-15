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
 *   last-grant.json             time of the last grant, for the 2 minute spacing
 *   gate.lock                   short exclusive file around every read-decide-write. It holds JSON {pid, pidStart, nonce}
 *                               of its holder. Only file work runs inside it: every process read runs BEFORE it.
 *   MODE                        "warn" or "grant". Missing or any other text: warn. Only the seat changes it.
 *   warn-log.jsonl              one line per start that grant mode would have refused (counts for the warn days)
 *   break-log.jsonl             one line per break: who, why, and each removed file with its kind and holder. This log is
 *                               the whole control on break: a file store cannot check who runs it.
 *
 * Test hook: RUN_LOCK_TEST_SAMPLES='{"free":[8,8,8],"load":[10,10,10]}' replaces the three real samples (no 6 second wait).
 * It works only when RUN_LOCK_DIR is set too (a test store). An output line says when it is used. A bad value is ignored.
 *
 * GRANTED is not safe from a move of main (see CAVEAT). A run on old code holds no lock, so an UNLOCKED RUN seen
 * (a running pre-pr.mjs with no lock file) is counted as a slot in grant mode.
 *
 * Usage: node scripts/coordination/run-lock.mjs acquire --kind pre-pr --pid N [--head sha] [--holder name] [--session label] [--minutes N] [--wait]
 *        ... release --pid N | register --kind loop --pid N [--holder name] [--session label] [--minutes N] | list | summary
 *        ... break --pid N --reason "why" --who name
 * --pid is required for acquire, register, release and break: it is the process that holds the run. The parent shell of a CLI call ends with the call.
 * Exit: 0 granted, 75 the lock says wait (EX_TEMPFAIL), 1 usage or error. Exit 3 is not used: pre-pr uses it for its own error.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const GATE_STALE_MS = 10_000; // age limit for a gate file that holds no readable holder
const GATE_UNKNOWN_MS = 60_000; // age limit for a gate whose holder has no usable start time (pid reuse cannot be seen)
export const EXIT_WAIT = 75; // "the lock says wait". Exit 3 stays free for an error of the caller (pre-pr uses 3).
const GATE_CHECK_EVERY = 10; // a waiter checks whether the gate holder is dead on every 10th try
const SPACING_MS = 2 * MIN;
const FUTURE_SKEW_MS = MIN; // a last-grant time later than now plus this is a bad file, not a recent grant
const SAME_PROCESS_MS = 2_000; // a start time within this of the recorded one is the same process
const UNKNOWN = 'unknown'; // a process read that failed. It is not "no such process": the lock stays.

export const CAVEAT = 'NOTE GRANTED is not safe from a move of main: pre-pr.mjs fails a CodeRabbit CLI run if main moves during it. The lock holds no merge tap and no blocklist commit.';

/** Run kinds. heavy: takes a slot (V7.3). A light kind needs no slot, only the load bar. loadMax: refused at a median load at or above it. */
export const KINDS = {
  'pre-pr': { heavy: true, loadMax: 70, minutes: 45 },
  suite: { heavy: true, loadMax: 70, minutes: 30 },
  'label-run': { heavy: true, loadMax: 70, minutes: 90 },
  loop: { heavy: true, loadMax: 70, minutes: 720 }, // 12 hours: a loop runs long, and register renews the lock
  'hook-build': { heavy: false, loadMax: 80, minutes: 10 },
};

/** V7.3: 9 GB or more free allows 4 live heavy runs, 7 GB 3, below 7 GB 2. Under 5 GB the loop floor applies (see acquire). */
export function maxSlots(freeGB) {
  if (freeGB >= 9) return 4;
  if (freeGB >= 7) return 3;
  return 2;
}

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

export const defaultDir = () => process.env.RUN_LOCK_DIR || join(os.homedir(), '.claude', 'state', 'run-locks');

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

/** Running pre-pr.mjs processes: [{pid, start}]. Used only to see a run on old code that holds no lock file. A failed read gives []. */
export function realPrePrProcs() {
  if (process.platform === 'win32') {
    const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'scripts[\\\\/]github[\\\\/]pre-pr\\.mjs' } | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }");
    return (out || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, at] = l.split('|'); return { pid: Number(pid), start: Date.parse(at) }; }).filter((p) => p.pid > 0);
  }
  const r = spawnSync('pgrep', ['-f', 'scripts/github/pre-pr\\.mjs'], { encoding: 'utf8' });
  return String(r.stdout).split(/\s+/).filter(Boolean).map((p) => ({ pid: Number(p), start: realPidStart(Number(p)) }));
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

/** Samples from the test hook, or null when it is unset or bad. It works only when RUN_LOCK_DIR is set too: a test store. */
function hookedSamples(env) {
  if (!env.RUN_LOCK_DIR) return null;
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
  };
}

// ---------- store ----------

const readMode = (dir) => {
  try { return readFileSync(join(dir, 'MODE'), 'utf8').trim().toLowerCase() === 'grant' ? 'grant' : 'warn'; } catch { return 'warn'; }
};
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

/** Remove the lock files of a dead run or a past expiry. File work only. Return the live ones. */
function sweep(d, starts) {
  const now = d.now();
  const live = [];
  for (const { file, rec } of lockRecords(d.dir)) {
    if (isDead(file, rec, starts) || rec.expiresAt <= now) { try { rmSync(join(d.dir, file)); } catch { /* another session removed it */ } continue; }
    live.push({ ...rec, file });
  }
  return live;
}

const unlockedRuns = (d, live, procs) => procs.filter((p) => p.pid !== d.selfPid && !live.some((l) => l.pid === p.pid));
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
 */
function breakDeadGate(d, gate) {
  let text;
  try { text = readFileSync(gate, 'utf8'); } catch { return false; }
  if (!gateHolderDead(d, text, gate)) return false;
  d.beforeGateBreak?.(); // test seam: runs in the window between the judgment and the move
  const aside = `${gate}.broken-${randomUUID()}`;
  try { renameSync(gate, aside); } catch { return false; } // gone, or another process broke it first
  let moved = null;
  try { moved = readFileSync(aside, 'utf8'); } catch { /* read failed: treat as foreign and put it back */ }
  if (moved !== text) { try { linkSync(aside, gate); } catch { /* the name is taken again: that holder owns it now */ } }
  try { rmSync(aside); } catch { /* already gone */ }
  return moved === text;
}

/** Run fn while we hold gate.lock. The gate holds our pid, start time and a nonce; we remove it only if it still holds that text. */
async function withGate(d, selfStart, fn) {
  mkdirSync(d.dir, { recursive: true });
  const gate = join(d.dir, 'gate.lock');
  const body = JSON.stringify({ pid: d.selfPid, pidStart: selfStart, nonce: randomUUID() });
  for (let i = 0; ; i++) {
    try { writeFileSync(gate, body, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (i >= 499) throw new Error('run-lock: the gate file stays held');
      if (i % GATE_CHECK_EVERY === 0 && breakDeadGate(d, gate)) continue;
      await d.sleep(20);
    }
  }
  try { return await fn(); } finally {
    try { if (readFileSync(gate, 'utf8') === body) rmSync(gate); } catch { /* already gone */ }
  }
}

/** The session label for a lock: the caller's text, else "#sid8" from the session id in the environment. Never bare hex. */
function sessionLabel(opts, d) {
  if (String(opts.session || '').trim()) return String(opts.session).trim();
  const id = String(d.env.CLAUDE_CODE_SESSION_ID || '');
  return /^[0-9a-f-]{8,}$/i.test(id) ? `#${id.slice(0, 8)}` : null;
}

function writeLock(d, kind, opts, start, now) {
  const rec = {
    kind, pid: opts.pid, pidStart: start, holder: opts.holder || 'unknown', head: opts.head || null, session: sessionLabel(opts, d),
    startedAt: now, expiresAt: now + (opts.minutes || KINDS[kind].minutes) * MIN,
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

/** Ask for a slot. Returns { granted, warned, lines, retryAt, reasons, file }. Throws on an unknown kind or a dead pid. */
export async function acquire(opts, deps) {
  const d = defaults(deps);
  const kind = knownKind(opts.kind);
  const pid = opts.pid ?? d.selfPid;
  const start = d.pidStart(pid);
  if (start === null) throw new Error(`pid ${pid} is not running`);
  const s = await d.samples();
  const freeGB = median(s.free);
  const loadPct = median(s.load);
  const selfStart = pid === d.selfPid ? start : d.pidStart(d.selfPid);
  const starts = startsSnapshot(d);
  const procs = d.prePrProcs();
  return withGate(d, selfStart, async () => {
    const now = d.now();
    const mode = readMode(d.dir);
    const live = sweep(d, starts);
    const unlocked = unlockedRuns(d, live, procs);
    const heavyLive = live.filter((r) => KINDS[r.kind]?.heavy).length + unlocked.length;
    const max = maxSlots(freeGB);
    const keys = [];
    const reasons = [];
    const refuse = (key, text) => { keys.push(key); reasons.push(text); };
    if (loadPct >= kind.loadMax) refuse('load', `load ${loadPct} percent (limit ${kind.loadMax} percent for ${opts.kind})`);
    if (kind.heavy) {
      // V7.3: under 5 GB a heavy start waits only while a loop is live (a registered loop counts); otherwise the slot tiers apply.
      if (freeGB < 5 && live.some((r) => r.kind === 'loop')) refuse('floor', `free memory ${num(freeGB)} GB under 5 GB while a loop is live`);
      else if (heavyLive >= max) refuse('slots', `${heavyLive} live heavy runs, V7.3 allows ${max} at ${num(freeGB)} GB`);
    }
    const lastRec = readJson(join(d.dir, 'last-grant.json'));
    const lastAt = lastRec && Number.isFinite(lastRec.at) && lastRec.at <= now + FUTURE_SKEW_MS ? lastRec.at : null; // a time far in the future is a bad file
    if (lastAt !== null && now - lastAt < SPACING_MS) refuse('spacing', `last grant at ${clockText(lastAt, d.timeZone, false)}, grants are 2 minutes apart`);
    const retryAt = Math.max(keys.includes('spacing') ? lastAt + SPACING_MS : 0, keys.some((k) => k !== 'spacing') ? now + SPACING_MS : 0, now);
    const lines = unlocked.length ? [unlockedLine(unlocked)] : [];
    if (d.samplesHooked) lines.unshift('NOTE samples come from RUN_LOCK_TEST_SAMPLES (a test hook), not from the machine');
    const wait = `${reasons.join('; ')}; try again after ${clockText(retryAt, d.timeZone)}`;
    if (reasons.length && mode === 'grant') {
      return { granted: false, warned: false, lines: [...lines, `WAIT ${wait}`, CAVEAT], retryAt, reasons, keys };
    }
    // The warn log comes first: a failed append then leaves no lock and no last-grant behind.
    if (reasons.length) {
      appendLine(d.dir, 'warn-log.jsonl', { ts: now, kind: opts.kind, holder: opts.holder || 'unknown', head: opts.head || null, pid, keys, reasons, freeGB: num(freeGB), loadPct, heavyLive });
      lines.push(`WOULD WAIT ${wait}`);
    }
    const file = writeLock(d, opts.kind, { ...opts, pid }, start, now);
    // A hook build takes no slot, so it must not start the 2 minute spacing for the next heavy run.
    if (kind.heavy) writeFileSync(join(d.dir, 'last-grant.json'), JSON.stringify({ at: now, kind: opts.kind, pid }));
    const slot = kind.heavy ? `slot ${heavyLive + 1} of ${max}` : 'no slot needed';
    lines.push(`GRANTED ${opts.kind} ${slot} (free ${num(freeGB)} GB, load ${loadPct} percent, mode ${mode})`, CAVEAT);
    return { granted: true, warned: reasons.length > 0, lines, file, mode, reasons, keys };
  });
}

/** Record a run that already runs (a loop, a label run). Nothing is refused: it is running. It counts as a slot. */
export async function register(opts, deps) {
  const d = defaults(deps);
  knownKind(opts.kind);
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

export async function list(deps) {
  const d = defaults(deps);
  const starts = startsSnapshot(d);
  const procs = d.prePrProcs();
  const live = sweep(d, starts);
  const unlocked = unlockedRuns(d, live, procs);
  const lines = [`mode: ${readMode(d.dir)}`, `store: ${d.dir}`];
  for (const r of live) lines.push(`${r.kind} pid ${r.pid} holder ${r.holder}${r.session ? ` session ${r.session}` : ''} since ${clockText(r.startedAt, d.timeZone, false)} until ${clockText(r.expiresAt, d.timeZone)}`);
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
  const minutes = a.minutes ? Number(a.minutes) : undefined;
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
  if (verb === 'release') { const r = await release({ pid }); console.log(`released ${r.removed} lock(s) of pid ${pid}`); return 0; }
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
