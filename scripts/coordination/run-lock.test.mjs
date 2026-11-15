// Isolated tests for scripts/coordination/run-lock.mjs (card coord-run-lock-and-go-row).
// No real memory, load, clock, process table or ~/.claude: every machine read is injected, the store is a temp folder.
//
// How the lock can fail, one test (or a few) each, with the source change that makes it fail:
//   no record          a granted run leaves no lock file                                  (skip the create)
//   warn mode          warn mode refuses, or logs nothing                                 (ignore MODE)
//   load bar           70 percent (pre-pr) or 80 percent (hook build) is not refused      (drop the bar, use the mean)
//   tiers              the slot count ignores free memory (9 GB 4, 7 GB 3, else 2)       (a fixed count)
//   floor              a heavy run starts under 5 GB                                      (drop the floor)
//   light kind         a hook build takes or is refused by a slot                         (count every kind)
//   spacing            two grants inside 2 minutes both pass                              (drop the spacing)
//   dead run           a dead pid, a reused pid or a past expiry keeps a slot             (trust the file)
//   race               two builders that measure in the same minute both start           (drop the gate file)
//   register           a loop already running is not counted, or is refused               (refuse, or skip the file)
//   unlocked run       an old-code pre-pr with no lock file is not counted                (count lock files only)
//   caveat             the move-of-main line is missing from an output                    (drop the line)
//   refusal text       a WAIT without the reason or the retry time                        (drop a field)
//   break              a break without a reason, or with no log line                      (skip the log)
//   unknown read       a failed process read ("unknown") removes the lock of a live run   (treat unknown as dead)
//   gate steal         a gate of a live holder is broken because its file is old          (age-based steal)
//   gate foreign       the finally step removes a gate file that another process now owns (remove without a check)
//   gate snapshot      process reads (pidStart, prePrProcs) run while the gate is held   (read inside the gate)
//   race               two processes both start; run behind a barrier, not in one process (drop the gate file)
//   V7.3 floor         under 5 GB a heavy start is refused with no loop live               (a floor for every kind)
//
//   future grant       a last-grant time in the future blocks every start                   (no upper bound on last.at)
//   kind lookup        "constructor" or "__proto__" passes as a kind                         (KINDS[kind] instead of Object.hasOwn)
//   cli pid            the CLI takes the parent shell as the pid, which ends with the call  (default to process.ppid)
//   cli entry          a junction or a case difference makes the CLI exit 0 with no output   (string compare of paths)
//   break log          a break logs a count only, or needs no --who                          (drop files or who check)
//   zone and minute    the zone is fixed text, the retry minute rounds down                  (a literal CST, no ceil)
//   long loop          a loop loses its slot after 6 hours                                   (loop expiry 360 minutes)
//   warn log order     a failed warn-log append leaves a lock and a last-grant behind        (write the lock first)
//   hook build         a hook build moves last-grant and blocks the next pre-pr              (write last-grant for every kind)
//   record             the lock holds no session label                                       (drop the field)
//   samples hook       RUN_LOCK_TEST_SAMPLES is ignored, so a test waits 6 seconds           (drop the hook)
//
// Gate file contract these tests pin: gate.lock holds JSON {"pid": N, "pidStart": M} of its holder.
// The "unknown" value these tests pin: pidStart(pid) returns the string 'unknown' when the read fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as RL from './run-lock.mjs';
import { acquire, breakLock, CAVEAT, KINDS, list, maxSlots, register, release, releaseSync, warnSummary } from './run-lock.mjs';

const T0 = Date.parse('2026-11-15T15:00:00Z');
const MIN = 60_000;
const RUN_LOCK = join(dirname(fileURLToPath(import.meta.url)), 'run-lock.mjs');

function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runlock-'));
  const st = { now: T0, free: 8, load: 10, alive: new Map(), procs: [], ...over };
  const three = (v) => (Array.isArray(v) ? v : [v, v, v]);
  const d = {
    dir,
    now: () => st.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    samples: async () => ({ free: three(st.free), load: three(st.load) }),
    pidStart: (pid) => (st.alive.has(pid) ? st.alive.get(pid) : null),
    prePrProcs: () => st.procs,
    selfPid: 9000,
  };
  return { dir, st, d, mode: (m) => writeFileSync(join(dir, 'MODE'), m) };
}
const live = (ctx, pid) => ctx.st.alive.set(pid, 1000 + pid);
// Take a lock for a live pid, then move the clock past the spacing so the next grant is not refused for it.
async function take(ctx, kind, pid) {
  live(ctx, pid);
  const r = await acquire({ kind, pid, holder: 't' }, ctx.d);
  ctx.st.now += 3 * MIN;
  return r;
}
const lockFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.lock') && f !== 'gate.lock');

test('a grant writes a lock file with kind, pid, start time, holder and expiry', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 'Coord drill', head: 'abc12345' }, ctx.d);
  assert.equal(r.granted, true);
  const files = lockFiles(ctx.dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^pre-pr-100-/);
  const rec = JSON.parse(readFileSync(join(ctx.dir, files[0]), 'utf8'));
  assert.equal(rec.kind, 'pre-pr');
  assert.equal(rec.pid, 100);
  assert.equal(rec.pidStart, 1100);
  assert.equal(rec.holder, 'Coord drill');
  assert.equal(rec.head, 'abc12345');
  assert.ok(rec.expiresAt > rec.startedAt);
});

test('warn mode (no MODE file) grants a start that grant mode refuses, and logs it', async () => {
  const ctx = setup({ load: 90 });
  live(ctx, 100);
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(r.granted, true);
  assert.equal(r.warned, true);
  assert.ok(r.lines.some((l) => /^WOULD WAIT .*load/.test(l)), r.lines.join('\n'));
  const log = readFileSync(join(ctx.dir, 'warn-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(JSON.parse(log[0]).reasons.join(' '), /load/);
  assert.equal(lockFiles(ctx.dir).length, 1, 'warn mode still records the run, so the counts are real');
});

test('a garbage MODE file is warn mode, never grant', async () => {
  const ctx = setup({ load: 90 });
  ctx.mode('grnat');
  live(ctx, 100);
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(r.granted, true);
  assert.equal(r.warned, true);
});

test('warnSummary counts the logged WOULD WAIT lines by reason', async () => {
  const ctx = setup({ load: 90 });
  live(ctx, 100);
  await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  ctx.st.now += 3 * MIN;
  live(ctx, 101);
  await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  const s = warnSummary(ctx.dir);
  assert.equal(s.total, 2);
  assert.equal(s.byReason.load, 2);
});

test('load bar: pre-pr is refused at a median of 70, a hook build at 80, by the median not the mean', async () => {
  const ctx = setup();
  ctx.mode('grant');
  for (const [kind, load, ok] of [['pre-pr', 70, false], ['pre-pr', 69, true], ['hook-build', 80, false], ['hook-build', 79, true], ['pre-pr', [10, 90, 90], false], ['pre-pr', [90, 10, 10], true]]) {
    const c = setup({ load });
    c.mode('grant');
    live(c, 100);
    const r = await acquire({ kind, pid: 100, holder: 't' }, c.d);
    assert.equal(r.granted, ok, `${kind} load ${JSON.stringify(load)}`);
  }
  assert.ok(ctx);
});

test('maxSlots follows V7.3: 9 GB 4, 7 GB 3, below 7 GB 2 (the under 5 GB loop floor is a separate rule)', () => {
  assert.equal(maxSlots(9), 4);
  assert.equal(maxSlots(8.99), 3);
  assert.equal(maxSlots(7), 3);
  assert.equal(maxSlots(6.99), 2);
  assert.equal(maxSlots(5), 2);
  assert.equal(maxSlots(4.99), 2, 'with no loop live, below 7 GB still allows 2');
});

test('slot count at 9.5, 7.5 and 6 GB: the next heavy run after the limit waits and names the count', async () => {
  for (const [free, limit] of [[9.5, 4], [7.5, 3], [6, 2]]) {
    const ctx = setup({ free });
    ctx.mode('grant');
    for (let i = 0; i < limit; i++) assert.equal((await take(ctx, 'pre-pr', 100 + i)).granted, true, `${free} GB grant ${i + 1}`);
    live(ctx, 200);
    const r = await acquire({ kind: 'pre-pr', pid: 200, holder: 't' }, ctx.d);
    assert.equal(r.granted, false, `${free} GB: grant ${limit + 1} waits`);
    assert.match(r.lines.join('\n'), new RegExp(`${limit} live heavy runs`));
  }
});

test('V7.3 as written: under 5 GB with no loop live a heavy run starts; 2 slots; the third waits', async () => {
  const ctx = setup({ free: 4.9 });
  ctx.mode('grant');
  assert.equal((await take(ctx, 'pre-pr', 100)).granted, true, 'first heavy run under 5 GB, no loop live');
  assert.equal((await take(ctx, 'pre-pr', 101)).granted, true, 'second heavy run');
  live(ctx, 102);
  const third = await acquire({ kind: 'pre-pr', pid: 102, holder: 't' }, ctx.d);
  assert.equal(third.granted, false);
  assert.match(third.lines.join('\n'), /2 live heavy runs/);
});

test('V7.3 as written: under 5 GB while a registered loop is live a heavy run waits and names the loop; a hook build starts', async () => {
  const ctx = setup({ free: 4.9 });
  ctx.mode('grant');
  live(ctx, 300);
  await register({ kind: 'loop', pid: 300, holder: 'RE builder C' }, ctx.d);
  live(ctx, 100);
  const heavy = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(heavy.granted, false);
  assert.match(heavy.lines.join('\n'), /under 5 GB/);
  assert.match(heavy.lines.join('\n'), /loop/i);
  live(ctx, 101);
  const light = await acquire({ kind: 'hook-build', pid: 101, holder: 't' }, ctx.d);
  assert.equal(light.granted, true);
});

test('a hook build needs no slot: it starts when the heavy slots are full, and it does not take a heavy slot', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  const build = await take(ctx, 'hook-build', 102);
  assert.equal(build.granted, true);
  live(ctx, 103);
  const third = await acquire({ kind: 'pre-pr', pid: 103, holder: 't' }, ctx.d);
  assert.equal(third.granted, false, 'two heavy runs fill 2 slots; the hook build is not one of them');
  assert.match(third.lines.join('\n'), /2 live heavy runs/);
});

test('spacing: a second grant inside 2 minutes waits and names the retry time; after 2 minutes it passes', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  assert.equal((await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d)).granted, true);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(r.granted, false);
  assert.match(r.lines.join('\n'), /2 minutes/);
  assert.equal(r.retryAt, T0 + 2 * MIN);
  ctx.st.now = T0 + 2 * MIN;
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d)).granted, true);
});

test('a dead pid, a reused pid (other start time) and a past expiry each lose their slot', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  assert.equal((await list(ctx.d)).live.length, 2);
  ctx.st.alive.delete(100); // dead
  ctx.st.alive.set(101, 424242); // the pid now belongs to another process
  assert.equal((await list(ctx.d)).live.length, 0);
  assert.equal(lockFiles(ctx.dir).length, 0, 'the files are removed');
  await take(ctx, 'pre-pr', 102);
  ctx.st.now += 60 * MIN; // past the 45 minute default expiry, pid still alive
  assert.equal((await list(ctx.d)).live.length, 0);
});

// Two real processes. Each child holds at its first clock read until one shared wall-clock instant, so both leave the
// hold together and race through the decision. With the gate one waits for the other. With no gate both read
// "no last grant" and both grant. Four rounds, because the window without the gate is short.
const RACE_CHILD = (moduleUrl) => `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquire } from ${JSON.stringify(moduleUrl)};
const [store, bar, pid] = process.argv.slice(2);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
writeFileSync(join(bar, 'ready-' + pid), '');
let t2 = 0;
while (!t2) { try { t2 = Number(readFileSync(join(bar, 'go'), 'utf8')); } catch { /* not yet */ } if (!t2) nap(2); }
const d = {
  dir: store,
  now: () => { while (Date.now() < t2) { /* hold until both runs reach the same instant */ } return ${T0}; },
  sleep: () => new Promise((r) => setTimeout(r, 5)),
  samples: async () => ({ free: [8, 8, 8], load: [10, 10, 10] }),
  pidStart: (p) => 1000 + p,
  prePrProcs: () => [],
  selfPid: Number(pid),
};
try {
  const r = await acquire({ kind: 'pre-pr', pid: Number(pid), holder: 'child' + pid }, d);
  console.log(JSON.stringify({ granted: r.granted }));
} catch (e) {
  console.log(JSON.stringify({ error: String(e && e.message) }));
}
`;

const waitFor = async (check, ms) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the children');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function raceRound() {
  const store = mkdtempSync(join(tmpdir(), 'runlock-race-store-'));
  const bar = mkdtempSync(join(tmpdir(), 'runlock-race-bar-'));
  writeFileSync(join(store, 'MODE'), 'grant');
  const script = join(bar, 'child.mjs');
  writeFileSync(script, RACE_CHILD(pathToFileURL(RUN_LOCK).href));
  const kids = [100, 101].map((pid) => {
    const p = spawn(process.execPath, [script, store, bar, String(pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const k = { pid, out: '', err: '', proc: p };
    p.stdout.on('data', (c) => { k.out += c; });
    p.stderr.on('data', (c) => { k.err += c; });
    k.done = new Promise((res) => p.on('close', res));
    return k;
  });
  try {
    await waitFor(() => kids.every((k) => existsSync(join(bar, `ready-${k.pid}`))), 30_000);
    writeFileSync(join(bar, 'go'), String(Date.now() + 600));
    await Promise.all(kids.map((k) => k.done));
  } finally {
    for (const k of kids) k.proc.kill();
  }
  const results = kids.map((k) => {
    try { return JSON.parse(k.out.trim().split('\n').pop()); } catch { return { error: `no result; stderr: ${k.err.slice(0, 300)}` }; }
  });
  return { store, results };
}

test('two builders that start in the same instant (two real processes): exactly one starts', { timeout: 120_000 }, async () => {
  for (let round = 1; round <= 4; round++) {
    const { store, results } = await raceRound();
    const text = `round ${round}: ${JSON.stringify(results)}`;
    assert.ok(results.every((r) => !r.error), text);
    assert.equal(results.filter((r) => r.granted).length, 1, text);
    assert.equal(lockFiles(store).length, 1, `${text}; lock files: ${lockFiles(store).join(', ')}`);
    assert.equal(existsSync(join(store, 'gate.lock')), false, `${text}; the gate file is removed`);
  }
});

// ---------- unknown process read, and the gate under load (fix list items 1 and 2) ----------

const gateBody = (pid, pidStart) => JSON.stringify({ pid, pidStart });

test('a failed process read ("unknown") keeps the lock of a live run and counts its slot', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  ctx.d.pidStart = (pid) => (pid === 100 || pid === 101 ? 'unknown' : ctx.st.alive.get(pid) ?? null);
  const out = await list(ctx.d);
  assert.equal(out.live.length, 2, 'both runs stay live when the read fails');
  assert.equal(lockFiles(ctx.dir).length, 2, 'the lock files are kept');
  live(ctx, 200);
  const third = await acquire({ kind: 'pre-pr', pid: 200, holder: 't' }, ctx.d);
  assert.equal(third.granted, false, 'the two unknown runs still fill the 2 slots at 6 GB');
  assert.match(third.lines.join('\n'), /2 live heavy runs/);
});

test('a gate of a live holder is not stolen after 10 seconds', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  const gate = join(ctx.dir, 'gate.lock');
  const held = gateBody(100, 1100);
  writeFileSync(gate, held);
  const old = new Date(Date.now() - 60_000);
  utimesSync(gate, old, old);
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((r) => ({ r }), (e) => ({ e }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(lockFiles(ctx.dir).length, 0, 'no lock is written while a live holder has the gate');
  assert.equal(readFileSync(gate, 'utf8'), held, 'the gate file is still the holder\'s');
  rmSync(gate); // the holder finishes
  const done = await outcome;
  assert.equal(done.r?.granted, true, done.e?.message);
});

test('a gate of a dead holder is broken at once, with no wait for its age', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  writeFileSync(join(ctx.dir, 'gate.lock'), gateBody(555, 5555)); // pid 555 does not run; the file is fresh
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(r.granted, true);
  assert.equal(lockFiles(ctx.dir).length, 1);
});

test('the finally step removes the gate only when its content is ours', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 555);
  const gate = join(ctx.dir, 'gate.lock');
  const foreign = gateBody(555, 1555);
  const realNow = ctx.d.now;
  let swapped = false;
  ctx.d.now = () => { // first clock read while we hold the gate: another process takes the gate file over
    if (!swapped && existsSync(gate)) { writeFileSync(gate, foreign); swapped = true; }
    return realNow();
  };
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(swapped, true, 'the test did swap the gate while acquire held it');
  assert.equal(r.granted, true);
  assert.equal(existsSync(gate), true, 'a gate that is not ours stays');
  assert.equal(readFileSync(gate, 'utf8'), foreign);
});

test('one process snapshot is taken BEFORE the gate: no process read runs while the gate file exists', async () => {
  const ctx = setup({ free: 9.5 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  live(ctx, 101);
  const gate = join(ctx.dir, 'gate.lock');
  const inside = [];
  const realStart = ctx.d.pidStart;
  ctx.d.pidStart = (pid) => { if (existsSync(gate)) inside.push(`pidStart(${pid})`); return realStart(pid); };
  ctx.d.prePrProcs = () => { if (existsSync(gate)) inside.push('prePrProcs()'); return ctx.st.procs; };
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(r.granted, true);
  assert.deepEqual(inside, [], 'the gated part does file work only');
});

test('register records a run that already runs, refuses nothing, and counts as a slot', async () => {
  const ctx = setup({ free: 6, load: 99 });
  ctx.mode('grant');
  live(ctx, 300);
  const r = await register({ kind: 'loop', pid: 300, holder: 'RE builder C' }, ctx.d);
  assert.equal(r.registered, true);
  assert.equal((await list(ctx.d)).live.length, 1);
  await assert.rejects(register({ kind: 'loop', pid: 301, holder: 'x' }, ctx.d), /not running/);
  const ctx2 = setup({ free: 6 });
  ctx2.mode('grant');
  await register({ kind: 'loop', pid: 300, holder: 'x' }, { ...ctx2.d, pidStart: () => 7 });
  ctx2.st.alive.set(400, 1);
  ctx2.st.now += 3 * MIN;
  ctx2.d.pidStart = (pid) => (pid === 300 ? 7 : ctx2.st.alive.get(pid) ?? null);
  const first = await acquire({ kind: 'pre-pr', pid: 400, holder: 't' }, ctx2.d);
  assert.equal(first.granted, true);
  ctx2.st.now += 3 * MIN;
  ctx2.st.alive.set(401, 1);
  const second = await acquire({ kind: 'pre-pr', pid: 401, holder: 't' }, ctx2.d);
  assert.equal(second.granted, false, 'the registered loop and one pre-pr fill the 2 slots at 6 GB');
});

test('an old-code pre-pr with no lock file prints UNLOCKED RUN seen and counts as a slot in grant mode', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  ctx.st.procs = [{ pid: 555, start: 5 }];
  live(ctx, 101);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(r.granted, false);
  assert.ok(r.lines.some((l) => /UNLOCKED RUN seen/.test(l)), r.lines.join('\n'));
  // a process that holds a lock, and the caller itself, are not unlocked runs
  const ctx2 = setup({ free: 6 });
  ctx2.mode('grant');
  await take(ctx2, 'pre-pr', 100);
  ctx2.st.procs = [{ pid: 100, start: 1100 }, { pid: 9000, start: 9 }];
  live(ctx2, 101);
  const ok = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx2.d);
  assert.equal(ok.granted, true);
  assert.ok(!ok.lines.some((l) => /UNLOCKED RUN seen/.test(l)));
});

test('list prints the mode, each live lock and any unlocked run', async () => {
  const ctx = setup();
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  ctx.st.procs = [{ pid: 555, start: 5 }];
  const out = await list(ctx.d);
  assert.match(out.lines.join('\n'), /mode: grant/);
  assert.match(out.lines.join('\n'), /pre-pr .*pid 100/);
  assert.match(out.lines.join('\n'), /UNLOCKED RUN seen/);
});

test('the caveat about a move of main is in every output: granted, waiting and warn', async () => {
  const granted = setup();
  granted.mode('grant');
  live(granted, 100);
  const a = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, granted.d);
  const waiting = setup({ load: 95 });
  waiting.mode('grant');
  live(waiting, 100);
  const b = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, waiting.d);
  const warn = setup({ load: 95 });
  live(warn, 100);
  const c = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, warn.d);
  for (const r of [a, b, c]) assert.ok(r.lines.includes(CAVEAT), r.lines.join('\n'));
  assert.match(CAVEAT, /not safe from a move of main/);
});

test('a refusal names the reason and the earliest time to try again', async () => {
  const ctx = setup({ load: 95 });
  ctx.mode('grant');
  live(ctx, 100);
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(r.granted, false);
  const wait = r.lines.find((l) => l.startsWith('WAIT '));
  assert.match(wait, /load 95 percent/);
  assert.match(wait, /try again after \d\d:\d\d/);
  assert.equal(lockFiles(ctx.dir).length, 0, 'a refused start leaves no lock');
});

test('release removes the lock of that pid and keeps the others', async () => {
  const ctx = setup({ free: 9.5 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  assert.equal((await release({ pid: 100 }, ctx.d)).removed, 1);
  assert.equal(lockFiles(ctx.dir).length, 1);
  assert.match(lockFiles(ctx.dir)[0], /-101-/);
  assert.equal((await release({ pid: 999 }, ctx.d)).removed, 0);
});

test('break needs a reason, removes the lock and writes a log line with who', async () => {
  const ctx = setup();
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await assert.rejects(breakLock({ pid: 100, reason: '', who: 'seat' }, ctx.d), /reason/);
  assert.equal(lockFiles(ctx.dir).length, 1);
  const r = await breakLock({ pid: 100, reason: 'stuck run', who: 'RE program seat' }, ctx.d);
  assert.equal(r.removed, 1);
  const log = JSON.parse(readFileSync(join(ctx.dir, 'break-log.jsonl'), 'utf8').trim());
  assert.equal(log.who, 'RE program seat');
  assert.equal(log.reason, 'stuck run');
});

test('an unknown kind is a usage error; the first version has no quiet-window kind', async () => {
  const ctx = setup();
  live(ctx, 100);
  await assert.rejects(acquire({ kind: 'nope', pid: 100, holder: 't' }, ctx.d), /unknown kind/);
  await assert.rejects(acquire({ kind: 'quiet-window', pid: 100, holder: 't' }, ctx.d), /unknown kind/);
  assert.deepEqual(Object.keys(KINDS).sort(), ['hook-build', 'label-run', 'loop', 'pre-pr', 'suite']);
});

test('releaseSync frees the lock before it returns: an exit handler waits for no promise', async () => {
  const ctx = setup();
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  assert.equal(lockFiles(ctx.dir).length, 1);
  const r = releaseSync({ pid: 100, kind: 'pre-pr' }, ctx.d); // no await: the file is gone when the call returns
  assert.equal(r.removed, 1);
  assert.equal(lockFiles(ctx.dir).length, 0);
  assert.equal(releaseSync({ pid: 100 }, ctx.d).removed, 0, 'a second call finds nothing and does not throw');
});

// ---------- SHOULD items 5 to 10 and 12, and the notes ----------

const SAMPLES_ENV = (free, load) => JSON.stringify({ free: [free, free, free], load: [load, load, load] });
const runCli = (args, store, env = {}) => spawnSync(process.execPath, [RUN_LOCK, ...args], {
  encoding: 'utf8', timeout: 60_000, env: { ...process.env, RUN_LOCK_DIR: store, RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 10), ...env },
});

test('item 5: a last-grant time in the future is ignored; one inside the small skew still spaces', async () => {
  const far = setup();
  far.mode('grant');
  live(far, 100);
  writeFileSync(join(far.dir, 'last-grant.json'), JSON.stringify({ at: T0 + 10 * MIN, kind: 'pre-pr', pid: 1 }));
  assert.equal((await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, far.d)).granted, true, 'a grant 10 minutes in the future is a bad file, not a reason');
  const near = setup();
  near.mode('grant');
  live(near, 100);
  writeFileSync(join(near.dir, 'last-grant.json'), JSON.stringify({ at: T0 + 20_000, kind: 'pre-pr', pid: 1 }));
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, near.d);
  assert.equal(r.granted, false, 'a few seconds of clock skew between two sessions still counts as a recent grant');
  assert.match(r.lines.join('\n'), /2 minutes/);
});

test('item 6: "constructor", "__proto__" and "toString" are not kinds, in acquire and in register', async () => {
  const ctx = setup();
  live(ctx, 100);
  for (const kind of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(acquire({ kind, pid: 100, holder: 't' }, ctx.d), /unknown kind/, `acquire ${kind}`);
    await assert.rejects(register({ kind, pid: 100, holder: 't' }, ctx.d), /unknown kind/, `register ${kind}`);
  }
  assert.equal(lockFiles(ctx.dir).length, 0);
});

test('item 7: the CLI refuses acquire and register with no --pid, and writes no lock', () => {
  const store = mkdtempSync(join(tmpdir(), 'runlock-cli-'));
  for (const verb of ['acquire', 'register']) {
    const r = runCli([verb, '--kind', 'pre-pr'], store);
    assert.equal(r.status, 1, `${verb}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--pid/, `${verb} names the missing option`);
  }
  assert.equal(lockFiles(store).length, 0);
});

test('item 7: the CLI with --pid for a live process still grants and writes the lock', () => {
  const store = mkdtempSync(join(tmpdir(), 'runlock-cli-'));
  writeFileSync(join(store, 'MODE'), 'grant');
  const r = runCli(['acquire', '--kind', 'pre-pr', '--pid', String(process.pid), '--holder', 'cli test'], store);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /GRANTED pre-pr/);
  assert.equal(lockFiles(store).length, 1);
});

test('item 8: the CLI runs when its path is a junction or link to the folder (real paths compare)', () => {
  const store = mkdtempSync(join(tmpdir(), 'runlock-cli-'));
  const link = join(mkdtempSync(join(tmpdir(), 'runlock-link-')), 'linked');
  symlinkSync(dirname(RUN_LOCK), link, 'junction');
  const viaLink = spawnSync(process.execPath, [join(link, 'run-lock.mjs'), 'summary'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, RUN_LOCK_DIR: store } });
  assert.equal(viaLink.status, 0, `${viaLink.stdout}${viaLink.stderr}`);
  assert.match(viaLink.stdout, /"total": 0/, 'the CLI printed its answer; it did not exit 0 with no output');
});

test('item 8: classifyEntry says main, import or miss; a miss is named, not silent', () => {
  assert.equal(typeof RL.classifyEntry, 'function');
  const url = pathToFileURL(RUN_LOCK).href;
  assert.equal(RL.classifyEntry(RUN_LOCK, url), 'main');
  assert.equal(RL.classifyEntry(join(dirname(RUN_LOCK), 'run-lock.test.mjs'), url), 'import', 'another script that imports this file');
  assert.equal(RL.classifyEntry(undefined, url), 'import');
  assert.equal(RL.classifyEntry(join(tmpdir(), 'no-such-folder', 'run-lock.mjs'), url), 'miss', 'named run-lock.mjs, but not this file');
  if (process.platform === 'win32') assert.equal(RL.classifyEntry(RUN_LOCK.toUpperCase(), url), 'main', 'a case difference is the same file on Windows');
});

test('item 9: the summary says that warn mode counts run high', () => {
  const ctx = setup();
  const s = warnSummary(ctx.dir);
  assert.match(String(s.note), /counts run high/);
  assert.match(String(s.note), /slot/);
  const r = runCli(['summary'], ctx.dir);
  assert.match(r.stdout, /counts run high/);
});

test('item 10: a break needs --who, and the log names each removed file, its kind and its holder', async () => {
  const ctx = setup();
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await assert.rejects(breakLock({ pid: 100, reason: 'stuck run' }, ctx.d), /who/);
  await assert.rejects(breakLock({ pid: 100, reason: 'stuck run', who: '  ' }, ctx.d), /who/);
  assert.equal(lockFiles(ctx.dir).length, 1, 'a refused break removes nothing');
  const name = lockFiles(ctx.dir)[0];
  const r = await breakLock({ pid: 100, reason: 'stuck run', who: 'RE program seat' }, ctx.d);
  assert.equal(r.removed, 1);
  const log = JSON.parse(readFileSync(join(ctx.dir, 'break-log.jsonl'), 'utf8').trim());
  assert.deepEqual(log.files, [{ file: name, kind: 'pre-pr', holder: 't' }]);
  assert.equal(log.removed, 1);
});

test('note: the clock text takes its zone from the system (or an injected zone) and rounds the minute up', () => {
  assert.equal(typeof RL.clockText, 'function');
  assert.equal(RL.clockText(T0 + 1, 'America/Chicago'), '09:01 CST', 'round up, not down');
  assert.equal(RL.clockText(T0, 'America/Chicago'), '09:00 CST', 'an exact minute stays');
  assert.equal(RL.clockText(T0 + 1, 'America/New_York'), '10:01 EST', 'the zone is not a fixed word');
  assert.match(RL.clockText(T0), /^\d\d:\d\d \S+$/, 'with no zone the system zone is used');
});

test('note: a refusal prints the retry time in the injected zone, with no fixed CST', async () => {
  const ctx = setup({ load: 95 });
  ctx.mode('grant');
  live(ctx, 100);
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...ctx.d, timeZone: 'America/New_York' });
  assert.match(r.lines.find((l) => l.startsWith('WAIT ')), /try again after 10:02 EST$/);
});

test('note: a loop keeps its slot for 12 hours, and a second register renews it', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  live(ctx, 300);
  await register({ kind: 'loop', pid: 300, holder: 'RE builder C' }, ctx.d);
  ctx.st.now += 7 * 60 * MIN;
  assert.equal((await list(ctx.d)).live.length, 1, 'a loop of 7 hours keeps its slot');
  const renew = setup({ free: 6 });
  live(renew, 300);
  await register({ kind: 'loop', pid: 300, holder: 'x', minutes: 60 }, renew.d);
  renew.st.now += 50 * MIN;
  await register({ kind: 'loop', pid: 300, holder: 'x', minutes: 60 }, renew.d);
  renew.st.now += 50 * MIN;
  assert.equal((await list(renew.d)).live.length, 1, '100 minutes later the renewed 60 minute lock still lives');
  assert.equal(lockFiles(renew.dir).length, 1, 'one file, not two');
});

test('note: the warn log is written before the lock: a failed append leaves no lock and no last-grant', async () => {
  const ctx = setup({ load: 90 });
  mkdirSync(join(ctx.dir, 'warn-log.jsonl')); // an append to a folder throws
  live(ctx, 100);
  await assert.rejects(acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d));
  assert.equal(lockFiles(ctx.dir).length, 0, 'no orphan lock');
  assert.equal(existsSync(join(ctx.dir, 'last-grant.json')), false, 'no last-grant');
});

test('note: a hook build takes no slot and does not move last-grant, so the next pre-pr starts at once', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  assert.equal((await acquire({ kind: 'hook-build', pid: 100, holder: 't' }, ctx.d)).granted, true);
  assert.equal(existsSync(join(ctx.dir, 'last-grant.json')), false);
  const next = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(next.granted, true, next.lines.join('\n'));
});

test('note: the lock record holds the head and a session label (#sid8, never bare hex)', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  const env = { CLAUDE_CODE_SESSION_ID: '0d40499c-1111-2222-3333-444444444444' };
  await acquire({ kind: 'pre-pr', pid: 100, holder: 't', head: 'abc12345' }, { ...ctx.d, env });
  const rec = JSON.parse(readFileSync(join(ctx.dir, lockFiles(ctx.dir)[0]), 'utf8'));
  assert.equal(rec.head, 'abc12345');
  assert.equal(rec.session, '#0d40499c');
  live(ctx, 300);
  await register({ kind: 'loop', pid: 300, holder: 'x', head: 'def67890', session: 'trex #0d40499c' }, { ...ctx.d, env: {} });
  const loop = JSON.parse(readFileSync(join(ctx.dir, lockFiles(ctx.dir).find((f) => f.startsWith('loop'))), 'utf8'));
  assert.equal(loop.session, 'trex #0d40499c', 'a label given by the caller wins');
  assert.equal(loop.head, 'def67890');
});

test('note: the caveat line is on register and list too', async () => {
  const ctx = setup();
  live(ctx, 300);
  const reg = await register({ kind: 'loop', pid: 300, holder: 'x' }, ctx.d);
  assert.ok(reg.lines.includes(CAVEAT), reg.lines.join('\n'));
  assert.ok((await list(ctx.d)).lines.includes(CAVEAT));
});

test('item 12: RUN_LOCK_TEST_SAMPLES gives the samples with no 6 second wait, and the output says so', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  const { samples, ...noSamples } = ctx.d; // the real sampler, with the hook set
  const env = { RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 95) };
  const t0 = Date.now();
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...noSamples, env });
  assert.ok(Date.now() - t0 < 3000, 'no real 2 second sleeps');
  assert.equal(r.granted, false);
  assert.match(r.lines.join('\n'), /load 95 percent/);
  assert.match(r.lines.join('\n'), /RUN_LOCK_TEST_SAMPLES/, 'a faked sample is visible in the output');
  // a garbage value is ignored: the real sampler runs (injected here so the test stays fast)
  let real = 0;
  const bad = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...ctx.d, samples: async () => { real++; return { free: [8, 8, 8], load: [10, 10, 10] }; }, env: { RUN_LOCK_TEST_SAMPLES: 'not json' } });
  assert.equal(bad.granted, true);
  assert.equal(real, 1);
});
