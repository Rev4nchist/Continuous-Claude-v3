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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, breakLock, CAVEAT, KINDS, list, maxSlots, register, release, warnSummary } from './run-lock.mjs';

const T0 = Date.parse('2026-11-15T15:00:00Z');
const MIN = 60_000;

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

test('maxSlots follows V7.3: 9 GB 4, 7 GB 3, below 2, under 5 GB none', () => {
  assert.equal(maxSlots(9), 4);
  assert.equal(maxSlots(8.99), 3);
  assert.equal(maxSlots(7), 3);
  assert.equal(maxSlots(6.99), 2);
  assert.equal(maxSlots(5), 2);
  assert.equal(maxSlots(4.99), 0);
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

test('under 5 GB a heavy run is refused with no run live; a hook build still starts', async () => {
  const ctx = setup({ free: 4.9 });
  ctx.mode('grant');
  live(ctx, 100);
  const heavy = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(heavy.granted, false);
  assert.match(heavy.lines.join('\n'), /under 5 GB/);
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

test('two builders that measure in the same minute: exactly one starts', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  const [a, b] = await Promise.all([
    acquire({ kind: 'pre-pr', pid: 100, holder: 'a' }, ctx.d),
    acquire({ kind: 'pre-pr', pid: 101, holder: 'b' }, ctx.d),
  ]);
  assert.equal([a, b].filter((r) => r.granted).length, 1);
  assert.equal(lockFiles(ctx.dir).length, 1);
  assert.equal(existsSync(join(ctx.dir, 'gate.lock')), false, 'the gate file is removed');
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
