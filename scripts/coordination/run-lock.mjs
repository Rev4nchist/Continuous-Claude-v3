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
 *   gate.lock                   short exclusive file around every read-decide-write
 *   MODE                        "warn" or "grant". Missing or any other text: warn. Only the seat changes it.
 *   warn-log.jsonl              one line per start that grant mode would have refused (counts for the warn days)
 *   break-log.jsonl             one line per break: who, why. This log is the whole control on break: a file store
 *                               cannot check who runs it.
 *
 * GRANTED is not safe from a move of main (see CAVEAT). A run on old code holds no lock, so an UNLOCKED RUN seen
 * (a running pre-pr.mjs with no lock file) is counted as a slot in grant mode.
 *
 * Usage: node scripts/coordination/run-lock.mjs acquire --kind pre-pr [--pid N] [--head sha] [--holder name] [--minutes N] [--wait]
 *        ... release --pid N | register --kind loop --pid N [--holder name] [--minutes N] | list | summary
 *        ... break --pid N --reason "why" [--who name]
 * Exit: 0 granted, 3 wait, 1 usage or error.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const GATE_STALE_MS = 10_000;
const SPACING_MS = 2 * MIN;
const SAME_PROCESS_MS = 2_000; // a start time within this of the recorded one is the same process

export const CAVEAT = 'NOTE GRANTED is not safe from a move of main: pre-pr.mjs fails a CodeRabbit CLI run if main moves during it. The lock holds no merge tap and no blocklist commit.';

/** Run kinds. heavy: takes a slot (V7.3). A light kind needs no slot, only the load bar. loadMax: refused at a median load at or above it. */
export const KINDS = {
  'pre-pr': { heavy: true, loadMax: 70, minutes: 45 },
  suite: { heavy: true, loadMax: 70, minutes: 30 },
  'label-run': { heavy: true, loadMax: 70, minutes: 90 },
  loop: { heavy: true, loadMax: 70, minutes: 360 },
  'hook-build': { heavy: false, loadMax: 80, minutes: 10 },
};

/** V7.3: 9 GB or more free allows 4 live heavy runs, 7 GB 3, 5 GB 2, under 5 GB none. */
export function maxSlots(freeGB) {
  if (freeGB >= 9) return 4;
  if (freeGB >= 7) return 3;
  if (freeGB >= 5) return 2;
  return 0;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const num = (n) => Number(Number(n).toFixed(1));
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });

export const defaultDir = () => process.env.RUN_LOCK_DIR || join(os.homedir(), '.claude', 'state', 'run-locks');

// ---------- real machine reads (every one is injectable) ----------

function ps(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** Start time of a process in epoch ms, or null when it does not run. Windows reuses pids, so a pid alone proves nothing. */
export function realPidStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const out = ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`);
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const t = Date.parse(String(r.stdout).trim());
  return r.status === 0 && Number.isFinite(t) ? t : null;
}

/** Running pre-pr.mjs processes: [{pid, start}]. Used only to see a run on old code that holds no lock file. */
export function realPrePrProcs() {
  if (process.platform === 'win32') {
    const out = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'scripts[\\\\/]github[\\\\/]pre-pr\\.mjs' } | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }");
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, at] = l.split('|'); return { pid: Number(pid), start: Date.parse(at) }; }).filter((p) => p.pid > 0);
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

function defaults(deps = {}) {
  return {
    dir: deps.dir || defaultDir(),
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    samples: deps.samples || realSamples,
    pidStart: deps.pidStart || realPidStart,
    prePrProcs: deps.prePrProcs || realPrePrProcs,
    selfPid: deps.selfPid ?? process.pid,
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

/** Remove the lock files of a dead run (pid gone, or the pid now belongs to another process) or a past expiry. Return the live ones. */
function sweep(d) {
  const now = d.now();
  const live = [];
  for (const { file, rec } of lockRecords(d.dir)) {
    const start = d.pidStart(rec.pid);
    const same = start !== null && Math.abs(start - rec.pidStart) < SAME_PROCESS_MS;
    if (!same || rec.expiresAt <= now) { try { rmSync(join(d.dir, file)); } catch { /* another session removed it */ } continue; }
    live.push({ ...rec, file });
  }
  return live;
}

const unlockedRuns = (d, live) => d.prePrProcs().filter((p) => p.pid !== d.selfPid && !live.some((l) => l.pid === p.pid));
const unlockedLine = (u) => `UNLOCKED RUN seen: ${u.length} pre-pr.mjs process(es) with no lock file (pid ${u.map((p) => p.pid).join(', ')}); counted as a slot in grant mode`;

async function withGate(d, fn) {
  mkdirSync(d.dir, { recursive: true });
  const gate = join(d.dir, 'gate.lock');
  for (let i = 0; i < 500; i++) {
    try { writeFileSync(gate, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(gate).mtimeMs > GATE_STALE_MS) rmSync(gate); } catch { /* released meanwhile */ }
      await d.sleep(20);
      if (i === 499) throw new Error('run-lock: the gate file stays held');
    }
  }
  try { return await fn(); } finally { try { rmSync(gate); } catch { /* already gone */ } }
}

function writeLock(d, kind, opts, start, now) {
  const rec = {
    kind, pid: opts.pid, pidStart: start, holder: opts.holder || 'unknown', head: opts.head || null,
    startedAt: now, expiresAt: now + (opts.minutes || KINDS[kind].minutes) * MIN,
  };
  const file = `${kind}-${opts.pid}-${start}.lock`;
  writeFileSync(join(d.dir, file), JSON.stringify(rec, null, 1));
  return file;
}

// ---------- verbs ----------

/** Ask for a slot. Returns { granted, warned, lines, retryAt, reasons, file }. Throws on an unknown kind or a dead pid. */
export async function acquire(opts, deps) {
  const d = defaults(deps);
  const kind = KINDS[opts.kind];
  if (!kind) throw new Error(`unknown kind "${opts.kind}" (known: ${Object.keys(KINDS).join(', ')})`);
  const pid = opts.pid ?? d.selfPid;
  const start = d.pidStart(pid);
  if (start === null) throw new Error(`pid ${pid} is not running`);
  const s = await d.samples();
  const freeGB = median(s.free);
  const loadPct = median(s.load);
  return withGate(d, async () => {
    const now = d.now();
    const mode = readMode(d.dir);
    const live = sweep(d);
    const unlocked = unlockedRuns(d, live);
    const heavyLive = live.filter((r) => KINDS[r.kind]?.heavy).length + unlocked.length;
    const max = maxSlots(freeGB);
    const keys = [];
    const reasons = [];
    const refuse = (key, text) => { keys.push(key); reasons.push(text); };
    if (loadPct >= kind.loadMax) refuse('load', `load ${loadPct} percent (limit ${kind.loadMax} percent for ${opts.kind})`);
    if (kind.heavy) {
      if (freeGB < 5) refuse('floor', `free memory ${num(freeGB)} GB under 5 GB`);
      else if (heavyLive >= max) refuse('slots', `${heavyLive} live heavy runs, V7.3 allows ${max} at ${num(freeGB)} GB`);
    }
    const last = readJson(join(d.dir, 'last-grant.json'));
    if (last && now - last.at < SPACING_MS) refuse('spacing', `last grant at ${clock(last.at)} CST, grants are 2 minutes apart`);
    const retryAt = Math.max(keys.includes('spacing') ? last.at + SPACING_MS : 0, keys.some((k) => k !== 'spacing') ? now + SPACING_MS : 0, now);
    const lines = unlocked.length ? [unlockedLine(unlocked)] : [];
    const wait = `${reasons.join('; ')}; try again after ${clock(retryAt)} CST`;
    if (reasons.length && mode === 'grant') {
      return { granted: false, warned: false, lines: [...lines, `WAIT ${wait}`, CAVEAT], retryAt, reasons, keys };
    }
    const file = writeLock(d, opts.kind, { ...opts, pid }, start, now);
    writeFileSync(join(d.dir, 'last-grant.json'), JSON.stringify({ at: now, kind: opts.kind, pid }));
    if (reasons.length) {
      appendLine(d.dir, 'warn-log.jsonl', { ts: now, kind: opts.kind, holder: opts.holder || 'unknown', pid, keys, reasons, freeGB: num(freeGB), loadPct, heavyLive });
      lines.push(`WOULD WAIT ${wait}`);
    }
    const slot = kind.heavy ? `slot ${heavyLive + 1} of ${max}` : 'no slot needed';
    lines.push(`GRANTED ${opts.kind} ${slot} (free ${num(freeGB)} GB, load ${loadPct} percent, mode ${mode})`, CAVEAT);
    return { granted: true, warned: reasons.length > 0, lines, file, mode, reasons, keys };
  });
}

/** Record a run that already runs (a loop, a label run). Nothing is refused: it is running. It counts as a slot. */
export async function register(opts, deps) {
  const d = defaults(deps);
  if (!KINDS[opts.kind]) throw new Error(`unknown kind "${opts.kind}" (known: ${Object.keys(KINDS).join(', ')})`);
  const start = d.pidStart(opts.pid);
  if (start === null) throw new Error(`pid ${opts.pid} is not running`);
  return withGate(d, async () => {
    sweep(d);
    const file = writeLock(d, opts.kind, opts, start, d.now());
    return { registered: true, file, lines: [`REGISTERED ${opts.kind} pid ${opts.pid} holder ${opts.holder || 'unknown'}`] };
  });
}

/** Free the lock files of one pid. */
export async function release(opts, deps) {
  const d = defaults(deps);
  let removed = 0;
  for (const { file, rec } of lockRecords(d.dir)) {
    if (rec.pid === opts.pid && (!opts.kind || rec.kind === opts.kind)) { rmSync(join(d.dir, file)); removed++; }
  }
  return { removed };
}

/** Remove a lock by hand. A reason is required and the log line names who: that is the whole control. */
export async function breakLock(opts, deps) {
  const d = defaults(deps);
  if (!String(opts.reason || '').trim()) throw new Error('break needs a reason (--reason "why")');
  const { removed } = await release({ pid: opts.pid }, d);
  mkdirSync(d.dir, { recursive: true });
  appendLine(d.dir, 'break-log.jsonl', { ts: d.now(), who: opts.who || 'unknown', pid: opts.pid, reason: opts.reason, removed });
  return { removed };
}

export async function list(deps) {
  const d = defaults(deps);
  const live = sweep(d);
  const unlocked = unlockedRuns(d, live);
  const lines = [`mode: ${readMode(d.dir)}`, `store: ${d.dir}`];
  for (const r of live) lines.push(`${r.kind} pid ${r.pid} holder ${r.holder} since ${clock(r.startedAt)} until ${clock(r.expiresAt)} CST`);
  if (!live.length) lines.push('no live lock');
  if (unlocked.length) lines.push(unlockedLine(unlocked));
  return { live, unlocked, mode: readMode(d.dir), lines };
}

/** Counts of the logged WOULD WAIT lines, for the warn days: how many starts the lock would have held, and why. */
export function warnSummary(dir = defaultDir()) {
  const out = { total: 0, byReason: {}, byKind: {} };
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
  if (verb === 'acquire') {
    const opts = { kind: a.kind, pid: pid ?? process.ppid, head: a.head, holder: a.holder, minutes };
    const deadline = Date.now() + (a['max-wait'] ? Number(a['max-wait']) : 60) * MIN;
    for (;;) {
      const r = await acquire(opts);
      print(r.lines);
      if (r.granted) return 0;
      if (!a.wait || Date.now() >= deadline) return 3;
      await new Promise((res) => setTimeout(res, Math.max(30_000, r.retryAt - Date.now())));
    }
  }
  if (verb === 'register') { print((await register({ kind: a.kind, pid, holder: a.holder, minutes })).lines); return 0; }
  if (verb === 'release') { const r = await release({ pid }); console.log(`released ${r.removed} lock(s) of pid ${pid}`); return 0; }
  if (verb === 'break') { const r = await breakLock({ pid, reason: a.reason, who: a.who }); console.log(`broke ${r.removed} lock(s) of pid ${pid}`); return 0; }
  if (verb === 'list') { print((await list()).lines); return 0; }
  if (verb === 'summary') { console.log(JSON.stringify(warnSummary(), null, 1)); return 0; }
  console.error('usage: run-lock.mjs acquire|register|release|break|list|summary (see the header of this file)');
  return 1;
}

const isMain = (() => { try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, '\\') || fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`run-lock: ${e.message}`); process.exit(1); });
