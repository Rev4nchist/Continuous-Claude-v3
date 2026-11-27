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
//   dead run           a dead pid or a reused pid keeps a slot                            (trust the file)
//   R3 expiry          a past expiry removes the lock of a run that is alive; or --minutes Infinity, 0 or a negative number is taken
//                      (expiry as the only test; no check of the minutes)
//   R1 unlocked age    a pre-pr in its own acquire (younger than 2 minutes, no lock) counts as an unlocked run (drop the age rule)
//   R2 wedged gate     a gate of a live holder is never broken, so one stuck or linked-back gate stops every acquire (no age limit);
//                      a failed gate remove is tried once only (no retry)
//   S1 re-read         the gate is moved aside after a change that the judgment did not see (no re-read before the move)
//   S2 CLI release     a release by hand leaves no log line (no log in the CLI release)
//   S3 pgrep           a failed pgrep gives a fake run with pid NaN (no pid filter)
//   S4 samples hook    the test hook works with the default store (no store check)
//   R4 hygiene         a temp folder or a junction stays after the run (no after step, no unlink of the link)
//   race               two builders that measure in the same minute both start           (drop the gate file)
//   register           a loop already running is not counted, or is refused               (refuse, or skip the file)
//   unlocked run       an old-code pre-pr with no lock file is not counted                (count lock files only)
//   caveat             the move-of-main line is missing from an output                    (drop the line)
//   refusal text       a WAIT without the reason or the retry time                        (drop a field)
//   break              a break without a reason, or with no log line                      (skip the log)
//   unknown read       a failed process read ("unknown") removes the lock of a live run   (treat unknown as dead)
//   gate steal         a gate of a live holder is broken while its file is under 120 s old (a shorter age limit)
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
//   F1 flaky cli       the CLI grant test reads the real process table: other pre-pr runs refuse it  (use a light kind)
//   F2 read producer   a time-out, a non-zero exit, empty output or an unparsable date reads as "gone"  (empty string is gone)
//   F3 two files       a renew after a failed read leaves two lock files, so one loop takes two slots   (no cleanup of the same pid and kind)
//   F4 pid reuse       a lock written after the snapshot is swept as dead (snapshot keyed by pid)        (key by pid)
//   F5 exit code       "wait" and an error share exit 3, so a caller cannot tell them apart             (return 3)
//   F6a gate break     a break removes a gate that a live holder just took (re-read, then delete)        (read then rmSync)
//   F6b unknown gate   a gate with an unknown start time is never broken after pid reuse                 (no age rule)
//   low                break log after removal; 5.0 GB boundary; release and break need --pid; a classifyEntry miss exits;
//                      the samples hook works with no test store; the warn row has no head
//   G3 light spacing   a hook build gets WAIT from the 2 minute spacing after a heavy start            (spacing without kind.heavy)
//   G4 list sweep      list deletes lock files with no gate, so it can delete a lock that a renew just wrote  (sweep outside withGate)
//   G4 list wedge      list waits for ever on a gate that stays held, or creates the store when it is missing (no fail open)
//
// Gate file contract these tests pin: gate.lock holds JSON {"pid": N, "pidStart": M} of its holder.
// The "unknown" value these tests pin: pidStart(pid) returns the string 'unknown' when the read fails.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as RL from './run-lock.mjs';
import { acquire, breakLock, CAVEAT, KINDS, list, maxSlots, register, release, releaseSync, warnSummary } from './run-lock.mjs';

const T0 = Date.parse('2026-11-15T15:00:00Z');
const MIN = 60_000;
const RUN_LOCK = join(dirname(fileURLToPath(import.meta.url)), 'run-lock.mjs');

// Test hygiene (R4): every temp folder of this file is made here and removed in the after step. A link is unlinked FIRST:
// a recursive remove through a junction would empty the folder it points at (the real scripts/coordination).
const made = [];
const links = [];
const mk = (prefix) => { const p = mkdtempSync(join(tmpdir(), prefix)); made.push(p); return p; };
const unlinkLink = (p) => { try { unlinkSync(p); } catch { try { rmdirSync(p); } catch { /* already gone */ } } };
after(() => {
  for (const l of links) unlinkLink(l);
  for (const p of made) { try { rmSync(p, { recursive: true, force: true }); } catch { /* a leftover shows in the folder count */ } }
});

function setup(over = {}) {
  const dir = mk('runlock-');
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

// Card run-lock-memory-only (Dave 11-17: no count tiers; 11-26: no limits that slow the flow). Free memory and load decide.
// Rows MO1 to MO7 fail on the code with the maxSlots tiers and the 2 minute spacing.
const KEEP_FLOOR_KINDS = ['suite', 'label-run'];

test('MO1: a third and a fourth heavy run at 6 GB free and load 40 are granted (no count tier)', async () => {
  const ctx = setup({ free: 6, load: 40 });
  ctx.mode('grant');
  for (let i = 0; i < 4; i++) {
    live(ctx, 100 + i);
    const r = await acquire({ kind: 'suite', pid: 100 + i, holder: 't' }, ctx.d);
    assert.equal(r.granted, true, `heavy run ${i + 1}: ${r.lines.join(' | ')}`);
  }
});

test('MO2: a heavy grant 30 s after another is granted, for suite, label-run and loop (no fixed gap)', async () => {
  for (const kind of ['suite', 'label-run', 'loop']) {
    const ctx = setup({ free: 8, load: 20 });
    ctx.mode('grant');
    live(ctx, 100);
    live(ctx, 101);
    assert.equal((await acquire({ kind, pid: 100, holder: 'a' }, ctx.d)).granted, true, `${kind} first`);
    ctx.st.now = T0 + 30_000;
    const r = await acquire({ kind, pid: 101, holder: 'b' }, ctx.d);
    assert.equal(r.granted, true, `${kind} 30 s later: ${r.lines.join(' | ')}`);
  }
});

test('MO3: under 5 GB a suite and a label run are refused with key floor, with no loop live; at exactly 5 GB they are granted', async () => {
  for (const kind of KEEP_FLOOR_KINDS) {
    const low = setup({ free: 4.9, load: 20 });
    low.mode('grant');
    live(low, 100);
    const r = await acquire({ kind, pid: 100, holder: 't' }, low.d);
    assert.equal(r.granted, false, `${kind} at 4.9 GB`);
    assert.ok(r.keys.includes('floor'), `${kind} keys: ${r.keys}`);
    assert.match(r.lines.join('\n'), /under 5 GB/);
    const edge = setup({ free: 5, load: 20 });
    edge.mode('grant');
    live(edge, 100);
    assert.equal((await acquire({ kind, pid: 100, holder: 't' }, edge.d)).granted, true, `${kind} at exactly 5 GB`);
  }
});

test('MO4: the load bar still refuses a heavy suite at a median of 70 and grants it at 69', async () => {
  for (const [load, ok] of [[70, false], [69, true]]) {
    const ctx = setup({ free: 8, load });
    ctx.mode('grant');
    live(ctx, 100);
    const r = await acquire({ kind: 'suite', pid: 100, holder: 't' }, ctx.d);
    assert.equal(r.granted, ok, `suite load ${load}`);
    if (!ok) assert.ok(r.keys.includes('load'), `keys: ${r.keys}`);
  }
});

test('MO5: every refusal says "try again" after 30 s (the two-read gap), not after 2 minutes', async () => {
  for (const kind of ['suite', 'pre-pr']) {
    const ctx = setup({ free: 8, load: 90 });
    ctx.mode('grant');
    live(ctx, 100);
    const r = await acquire({ kind, pid: 100, holder: 't' }, ctx.d);
    assert.equal(r.granted, false, kind);
    assert.equal(r.retryAt, T0 + 30_000, `${kind} retryAt`);
  }
});

test('MO6: a grant writes no last-grant.json, and an old recent last-grant.json delays nothing', async () => {
  const fresh = setup({ free: 8, load: 20 });
  fresh.mode('grant');
  live(fresh, 100);
  assert.equal((await acquire({ kind: 'suite', pid: 100, holder: 't' }, fresh.d)).granted, true);
  assert.equal(existsSync(join(fresh.dir, 'last-grant.json')), false, 'no spacing clock is written');
  const old = setup({ free: 8, load: 20 });
  old.mode('grant');
  writeFileSync(join(old.dir, 'last-grant.json'), JSON.stringify({ at: T0, kind: 'pre-pr', pid: 1 }));
  live(old, 101);
  assert.equal((await acquire({ kind: 'suite', pid: 101, holder: 't' }, old.d)).granted, true, 'an old file is ignored');
});

test('MO7: the GRANTED line of a heavy run names no slot count; a pre-pr under 5 GB with no loop gives the memory key once, not floor twice', async () => {
  const ctx = setup({ free: 8, load: 20 });
  ctx.mode('grant');
  live(ctx, 100);
  const g = await acquire({ kind: 'suite', pid: 100, holder: 't' }, ctx.d);
  const line = g.lines.find((l) => l.startsWith('GRANTED'));
  assert.match(line, /^GRANTED suite \(free 8 GB, load 20 percent, mode grant\)$/);
  const low = setup({ free: 4.9, load: 20 });
  low.mode('grant');
  live(low, 101);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, low.d);
  assert.deepEqual(r.keys, ['memory'], 'one floor refusal for a pre-pr with no loop live');
});

test('maxSlots follows V7.3: 9 GB 4, 7 GB 3, below 7 GB 2 (the under 5 GB loop floor is a separate rule)', () => {
  assert.equal(maxSlots(9), 4);
  assert.equal(maxSlots(8.99), 3);
  assert.equal(maxSlots(7), 3);
  assert.equal(maxSlots(6.99), 2);
  assert.equal(maxSlots(5), 2);
  assert.equal(maxSlots(4.99), 2, 'with no loop live, below 7 GB still allows 2');
});

// The V7.3 tiers apply to the other heavy kinds (suite, label run, loop). A pre-pr has its own limits (see the pre-pr phases tests).
test('slot count at 9.5, 7.5 and 6 GB: the next heavy run after the limit waits and names the count', async () => {
  for (const [free, limit] of [[9.5, 4], [7.5, 3], [6, 2]]) {
    const ctx = setup({ free });
    ctx.mode('grant');
    for (let i = 0; i < limit; i++) assert.equal((await take(ctx, 'suite', 100 + i)).granted, true, `${free} GB grant ${i + 1}`);
    live(ctx, 200);
    const r = await acquire({ kind: 'suite', pid: 200, holder: 't' }, ctx.d);
    assert.equal(r.granted, false, `${free} GB: grant ${limit + 1} waits`);
    assert.match(r.lines.join('\n'), new RegExp(`${limit} live heavy runs`));
  }
});

test('V7.3 as written: under 5 GB with no loop live a heavy run starts; 2 slots; the third waits', async () => {
  const ctx = setup({ free: 4.9 });
  ctx.mode('grant');
  assert.equal((await take(ctx, 'suite', 100)).granted, true, 'first heavy run under 5 GB, no loop live');
  assert.equal((await take(ctx, 'suite', 101)).granted, true, 'second heavy run');
  live(ctx, 102);
  const third = await acquire({ kind: 'suite', pid: 102, holder: 't' }, ctx.d);
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

// Card prepr-run-lock-start-gap. 25 Nov 15:12: two pre-prs started 9 s apart; the second was queued and granted 15:17:56. These two rows pin that.
test('G1 gap: a pre-pr that asks 9 s after a grant waits (spacing), is refused until 120 s after that grant, then passes', async () => {
  const ctx = setup({ free: 12, load: 20 });
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  assert.equal((await acquire({ kind: 'pre-pr', pid: 100, holder: 'a', head: 'aaaa1111' }, ctx.d)).granted, true);
  ctx.st.now = T0 + 9_000;
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222', wait: true }, ctx.d);
  assert.equal(r.granted, false);
  assert.ok(r.keys.includes('spacing'), `keys: ${r.keys}`);
  assert.equal(r.retryAt, T0 + 2 * MIN);
  assert.ok(r.waitFile, 'a wait record keeps its place in the queue');
  ctx.st.now = T0 + 2 * MIN - 1;
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222', wait: true }, ctx.d)).granted, false, '1 ms before the gap ends');
  ctx.st.now = T0 + 2 * MIN;
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222', wait: true }, ctx.d)).granted, true, 'at the gap');
});

test('G2 wait row: a pre-pr start that waits leaves ONE row in runs.jsonl (pid, head, keys, reason); a second ask of the same wait adds none; a grant adds none', async () => {
  const ctx = setup({ free: 12, load: 20 });
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  await acquire({ kind: 'pre-pr', pid: 100, holder: 'a', head: 'aaaa1111' }, ctx.d);
  const rowsOf = () => (existsSync(join(ctx.dir, 'runs.jsonl')) ? readFileSync(join(ctx.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  assert.equal(rowsOf().length, 0, 'a grant writes no wait row (the pre-pr writes its own start row)');
  ctx.st.now = T0 + 9_000;
  await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222', wait: true }, ctx.d);
  ctx.st.now = T0 + 60_000;
  await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222', wait: true }, ctx.d);
  const rows = rowsOf();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].event, 'wait');
  assert.equal(rows[0].queued, true);
  assert.equal(rows[0].pid, 101);
  assert.equal(rows[0].head, 'bbbb2222');
  assert.deepEqual(rows[0].keys, ['spacing']);
  assert.equal(rows[0].ts, T0 + 9_000);
  assert.match(rows[0].reasons.join(' '), /2 minutes/);
});

test('G4 wait row: a pre-pr start WITHOUT --wait-lock that is refused also leaves a row (queued false); each refused ask is one row', async () => {
  const ctx = setup({ free: 12, load: 20 });
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  await acquire({ kind: 'pre-pr', pid: 100, holder: 'a', head: 'aaaa1111' }, ctx.d);
  const rowsOf = () => (existsSync(join(ctx.dir, 'runs.jsonl')) ? readFileSync(join(ctx.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  ctx.st.now = T0 + 9_000;
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222' }, ctx.d);
  assert.equal(r.granted, false);
  ctx.st.now = T0 + 60_000;
  await acquire({ kind: 'pre-pr', pid: 101, holder: 'b', head: 'bbbb2222' }, ctx.d);
  const rows = rowsOf();
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.ok(rows.every((x) => x.event === 'wait' && x.pid === 101 && x.queued === false && x.keys.includes('spacing')), JSON.stringify(rows));
});

test('a dead pid and a reused pid (other start time) lose their slot; a past expiry keeps the lock of a run that is alive (R3)', async () => {
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
  ctx.st.now += 60 * MIN; // past the 45 minute default expiry, pid still alive and still the same process
  assert.equal((await list(ctx.d)).live.length, 1, 'a run proven alive keeps its lock past the expiry (a long pre-pr, a sleep, a loop with no renew)');
  assert.equal(lockFiles(ctx.dir).length, 1);
});

test('R3: a past expiry removes the lock only when the holder is not proven alive (pid gone, other start, unknown read)', async () => {
  for (const [name, pidStart] of [['gone', () => null], ['other start', () => 424242], ['unknown read', () => 'unknown']]) {
    const ctx = setup({ free: 6 });
    ctx.mode('grant');
    await take(ctx, 'pre-pr', 100);
    assert.equal(lockFiles(ctx.dir).length, 1);
    ctx.st.now += 60 * MIN;
    ctx.d.pidStart = pidStart;
    assert.equal((await list(ctx.d)).live.length, 0, `${name}: the expired lock is removed`);
    assert.equal(lockFiles(ctx.dir).length, 0, name);
  }
});

test('R3: a lock with no finite expiry counts as expired: removed when the holder is not proven alive, kept when it is', async () => {
  // Breaks when: a non-finite expiresAt (old code, --minutes Infinity) makes the lock immortal for a holder that is not proven alive.
  const old = (ctx) => { const f = join(ctx.dir, lockFiles(ctx.dir)[0]); const rec = JSON.parse(readFileSync(f, 'utf8')); rec.expiresAt = null; writeFileSync(f, JSON.stringify(rec)); };
  const a = setup({ free: 6 });
  a.mode('grant');
  await take(a, 'pre-pr', 100);
  old(a);
  a.d.pidStart = () => 'unknown'; // an unknown read is no proof
  assert.equal((await list(a.d)).live.length, 0, 'no expiry and no proof of life: removed');
  const b = setup({ free: 6 });
  b.mode('grant');
  await take(b, 'pre-pr', 101);
  old(b);
  assert.equal((await list(b.d)).live.length, 1, 'no expiry but proven alive: kept');
});

test('R2: the gate age limit is 120 s: a live holder gate of 119 s is kept, one of 121 s is broken', async () => {
  // Breaks when: GATE_MAX_MS moves anywhere between 91 s and 199 s (the loose 90 s and 200 s tests cannot see it).
  const mk2 = (ageS) => {
    const ctx = setup();
    ctx.mode('grant');
    live(ctx, 101);
    live(ctx, 102);
    const gate = join(ctx.dir, 'gate.lock');
    writeFileSync(gate, gateBody(102, 1102)); // pid 102 runs and its start matches: a live holder
    const t0 = new Date(Date.now() - ageS * 1000);
    utimesSync(gate, t0, t0);
    return { ctx, gate };
  };
  const old = mk2(121);
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, old.ctx.d)).granted, true, '121 s: broken');
  const young = mk2(119);
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, young.ctx.d).then((x) => ({ x }), (e) => ({ e }));
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(lockFiles(young.ctx.dir).length, 0, '119 s: a live holder keeps its gate, so no lock is written yet');
  rmSync(young.gate);
  assert.equal((await outcome).x?.granted, true);
});

test('R3: two expired locks of live runs still fill the slots in acquire', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  ctx.st.now += 60 * MIN;
  live(ctx, 102);
  const r = await acquire({ kind: 'pre-pr', pid: 102, holder: 't' }, ctx.d);
  assert.equal(r.granted, false, 'the runs are alive, so their slots count');
  assert.match(r.lines.join('\n'), /2 live heavy runs/);
});

test('R3: --minutes must be finite and above 0, in acquire and register (no null expiry, no silent default)', async () => {
  for (const minutes of [Infinity, -Infinity, 0, -5, NaN]) {
    const ctx = setup();
    ctx.mode('grant');
    live(ctx, 100);
    await assert.rejects(acquire({ kind: 'hook-build', pid: 100, holder: 't', minutes }, ctx.d), /--minutes/, `acquire ${minutes}`);
    await assert.rejects(register({ kind: 'loop', pid: 100, holder: 't', minutes }, ctx.d), /--minutes/, `register ${minutes}`);
    assert.equal(lockFiles(ctx.dir).length, 0, `${minutes}: no lock written`);
  }
  const ok = setup();
  live(ok, 100);
  assert.equal((await acquire({ kind: 'hook-build', pid: 100, holder: 't', minutes: 5 }, ok.d)).granted, true);
});

test('R3: the CLI refuses --minutes Infinity, 0, a negative number and text with exit 1 and no lock', () => {
  for (const bad of ['Infinity', '0', '-3', 'abc']) {
    const store = mk('runlock-cli-');
    writeFileSync(join(store, 'MODE'), 'grant');
    for (const verb of ['acquire', 'register']) {
      const kind = verb === 'acquire' ? 'hook-build' : 'loop';
      const r = runCli([verb, '--kind', kind, '--pid', String(process.pid), '--minutes', bad], store);
      assert.equal(r.status, 1, `${verb} --minutes ${bad}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--minutes/);
    }
    assert.equal(lockFiles(store).length, 0, `--minutes ${bad}: no lock`);
  }
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
  const store = mk('runlock-race-store-');
  const bar = mk('runlock-race-bar-');
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
  const store = mk('runlock-cli-');
  for (const verb of ['acquire', 'register']) {
    const r = runCli([verb, '--kind', 'pre-pr'], store);
    assert.equal(r.status, 1, `${verb}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--pid/, `${verb} names the missing option`);
  }
  assert.equal(lockFiles(store).length, 0);
});

test('item 7: the CLI with --pid for a live process still grants and writes the lock', () => {
  // A hook build is a light kind: it takes no slot, so the real process table (other live pre-pr runs) cannot refuse it.
  const store = mk('runlock-cli-');
  writeFileSync(join(store, 'MODE'), 'grant');
  const r = runCli(['acquire', '--kind', 'hook-build', '--pid', String(process.pid), '--holder', 'cli test'], store);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /GRANTED hook-build/);
  assert.equal(lockFiles(store).length, 1);
});

test('F1: three unlocked pre-pr runs refuse a heavy start and not a hook build (the cause of the flaky CLI test)', async () => {
  const ctx = setup({ free: 8, procs: [{ pid: 501, start: 1 }, { pid: 502, start: 1 }, { pid: 503, start: 1 }] });
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  const heavy = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(heavy.granted, false, 'three runs fill the 3 slots at 8 GB');
  const light = await acquire({ kind: 'hook-build', pid: 101, holder: 't' }, ctx.d);
  assert.equal(light.granted, true);
});

test('item 8: the CLI runs when its path is a junction or link to the folder (real paths compare)', () => {
  const store = mk('runlock-cli-');
  const link = join(mk('runlock-link-'), 'linked');
  symlinkSync(dirname(RUN_LOCK), link, 'junction');
  links.push(link);
  try {
    const viaLink = spawnSync(process.execPath, [join(link, 'run-lock.mjs'), 'summary'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, RUN_LOCK_DIR: store } });
    assert.equal(viaLink.status, 0, `${viaLink.stdout}${viaLink.stderr}`);
    assert.match(viaLink.stdout, /"total": 0/, 'the CLI printed its answer; it did not exit 0 with no output');
  } finally {
    unlinkLink(link); // first the link, so no later remove can follow it into the real folder
    assert.equal(existsSync(RUN_LOCK), true, 'the real run-lock.mjs is still there');
  }
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
  const env = { RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 95), RUN_LOCK_DIR: ctx.dir }; // the hook works only with a test store
  const t0 = Date.now();
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...noSamples, env });
  assert.ok(Date.now() - t0 < 3000, 'no real 2 second sleeps');
  assert.equal(r.granted, false);
  assert.match(r.lines.join('\n'), /load 95 percent/);
  assert.match(r.lines.join('\n'), /RUN_LOCK_TEST_SAMPLES/, 'a faked sample is visible in the output');
  // a garbage value is ignored: the real sampler runs (injected here so the test stays fast)
  let real = 0;
  const bad = await acquire({ kind: 'hook-build', pid: 100, holder: 't' }, { ...ctx.d, samples: async () => { real++; return { free: [8, 8, 8], load: [10, 10, 10] }; }, env: { RUN_LOCK_TEST_SAMPLES: 'not json' } });
  assert.equal(bad.granted, true);
  assert.equal(real, 1);
});

// ---------- critic round: F2 to F6 and the cheap lows ----------

const fakeSpawn = (r) => () => ({ stdout: '', stderr: '', ...r });
const readStart = (r, platform) => RL.realPidStart(4242, { spawn: fakeSpawn(r), platform });

test('F2: a failed Windows process read (time-out, non-zero exit, empty output) is "unknown", never "gone"', () => {
  assert.equal(readStart({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, 'win32'), 'unknown', 'time-out');
  assert.equal(readStart({ status: 1, stdout: 'x' }, 'win32'), 'unknown', 'non-zero exit');
  assert.equal(readStart({ status: 0, stdout: '' }, 'win32'), 'unknown', 'empty output: no answer is not "no such process"');
  assert.equal(readStart({ status: 0, stdout: 'GONE\r\n' }, 'win32'), null, 'the explicit answer for a process that does not run');
  assert.equal(readStart({ status: 0, stdout: '2026-11-15T15:00:00.0000000Z\r\n' }, 'win32'), Date.parse('2026-11-15T15:00:00Z'));
  assert.equal(readStart({ status: 0, stdout: 'not a date' }, 'win32'), 'unknown', 'an unparsable date');
});

test('F2: a failed POSIX process read is "unknown"; only exit 1 with no output means "gone"', () => {
  assert.equal(typeof readStart({ status: 0, stdout: 'Sat Nov 15 09:00:00 2026\n' }, 'linux'), 'number');
  assert.equal(readStart({ status: 0, stdout: 'garbage\n' }, 'linux'), 'unknown', 'exit 0 with an unparsable date is not "gone"');
  assert.equal(readStart({ status: 0, stdout: '' }, 'linux'), 'unknown', 'exit 0 with no output');
  assert.equal(readStart({ status: 1, stdout: '', stderr: '' }, 'linux'), null, 'ps says the pid does not run');
  assert.equal(readStart({ status: 2, stdout: '' }, 'linux'), 'unknown', 'another exit code is an error');
  assert.equal(readStart({ status: null, error: new Error('spawn ps ENOENT') }, 'linux'), 'unknown', 'ps did not start');
  assert.equal(readStart({ status: null, signal: 'SIGTERM' }, 'linux'), 'unknown', 'ps was killed');
});

test('F2: every failed read keeps the lock of a live run (producer and consumer together)', async () => {
  for (const [platform, bad] of [['win32', { status: null, error: new Error('timed out') }], ['win32', { status: 1 }], ['win32', { status: 0, stdout: '' }], ['linux', { status: 0, stdout: 'garbage' }]]) {
    const ctx = setup({ free: 6 });
    ctx.mode('grant');
    await take(ctx, 'pre-pr', 100);
    ctx.d.pidStart = (pid) => (pid === 100 ? RL.realPidStart(pid, { spawn: fakeSpawn(bad), platform }) : ctx.st.alive.get(pid) ?? null);
    const out = await list(ctx.d);
    assert.equal(out.live.length, 1, `${platform} ${JSON.stringify(bad)}: the run stays live`);
    assert.equal(lockFiles(ctx.dir).length, 1);
  }
});

test('F2: a real live pid reads as a number and the pid of an exited child reads as null (smoke)', () => {
  assert.equal(typeof RL.realPidStart(process.pid), 'number');
  const child = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(RL.realPidStart(child.pid), null);
});

const unknownThenKnown = async (first, second) => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  live(ctx, 300);
  await register({ kind: 'loop', pid: 300, holder: 'x' }, { ...ctx.d, pidStart: (p) => (p === 300 ? first : null) });
  await register({ kind: 'loop', pid: 300, holder: 'x' }, { ...ctx.d, pidStart: (p) => (p === 300 ? second : null) });
  return ctx;
};

test('F3: one loop keeps one lock file when a renew reads its start time after a failed read, in both orders', async () => {
  for (const [first, second] of [['unknown', 1300], [1300, 'unknown']]) {
    const ctx = await unknownThenKnown(first, second);
    assert.equal(lockFiles(ctx.dir).length, 1, `${first} then ${second}: ${lockFiles(ctx.dir).join(', ')}`);
    assert.equal((await list({ ...ctx.d, pidStart: () => 'unknown' })).live.length, 1);
  }
});

test('F3: a renew by another kind or another pid keeps its own file', async () => {
  const ctx = setup({ free: 9.5 });
  live(ctx, 300);
  live(ctx, 301);
  await register({ kind: 'loop', pid: 300, holder: 'x' }, ctx.d);
  await register({ kind: 'loop', pid: 301, holder: 'x' }, ctx.d);
  await register({ kind: 'suite', pid: 300, holder: 'x' }, ctx.d);
  assert.equal(lockFiles(ctx.dir).length, 3);
});

// A new process takes pid 100 and writes its lock while we read the old holder's start time. The snapshot is keyed by
// lock FILE: a file that is not in it is unknown, so it stays.
const withRacingNewLock = async (verb) => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  const fresh = 'pre-pr-100-7777.lock';
  let wrote = false;
  ctx.d.pidStart = (pid) => {
    if (pid === 100 && !wrote) {
      wrote = true;
      writeFileSync(join(ctx.dir, fresh), JSON.stringify({ kind: 'pre-pr', pid: 100, pidStart: 7777, holder: 'new', startedAt: T0, expiresAt: T0 + 45 * MIN }));
      return null; // the OLD process is gone
    }
    return ctx.st.alive.get(pid) ?? null;
  };
  live(ctx, 200);
  if (verb === 'acquire') await acquire({ kind: 'pre-pr', pid: 200, holder: 't' }, ctx.d); else await list(ctx.d);
  return { ctx, fresh, wrote };
};

test('F4: a lock written after the snapshot (pid reuse) is not swept as dead, in acquire and in list', async () => {
  for (const verb of ['acquire', 'list']) {
    const { ctx, fresh, wrote } = await withRacingNewLock(verb);
    assert.equal(wrote, true);
    assert.ok(lockFiles(ctx.dir).includes(fresh), `${verb}: the new lock stays; files: ${lockFiles(ctx.dir).join(', ')}`);
    assert.ok(!lockFiles(ctx.dir).includes('pre-pr-100-1100.lock'), `${verb}: the old dead lock is removed`);
  }
});

test('F4: a lock file rewritten under the same name after the snapshot (an unknown start name) is kept', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  const name = 'pre-pr-100-unknown.lock';
  const rec = (startedAt) => JSON.stringify({ kind: 'pre-pr', pid: 100, pidStart: 'unknown', holder: 'x', startedAt, expiresAt: T0 + 45 * MIN });
  writeFileSync(join(ctx.dir, name), rec(T0 - MIN));
  ctx.d.pidStart = (pid) => { if (pid === 100) { writeFileSync(join(ctx.dir, name), rec(T0 - 1000)); } return null; };
  await list(ctx.d);
  assert.ok(lockFiles(ctx.dir).includes(name), 'the file now holds another run');
});

test('F5: the CLI exits 75 when the lock says wait, 1 on a usage error, and names 75 in its usage text', () => {
  const store = mk('runlock-cli-');
  writeFileSync(join(store, 'MODE'), 'grant');
  const wait = runCli(['acquire', '--kind', 'pre-pr', '--pid', String(process.pid)], store, { RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 95) });
  assert.equal(wait.status, 75, `${wait.stdout}${wait.stderr}`);
  assert.match(wait.stdout, /WAIT .*load 95/);
  assert.equal(lockFiles(store).length, 0);
  const usage = runCli(['bogus'], store);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /75/, 'the usage text documents the wait code');
});

test('F6a: a gate that another holder takes over while we break a dead one is not removed', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 102);
  const gate = join(ctx.dir, 'gate.lock');
  const liveBody = gateBody(102, 1102);
  writeFileSync(gate, gateBody(555, 5555)); // pid 555 does not run
  let swapped = false;
  ctx.d.beforeGateBreak = () => { if (!swapped) { swapped = true; writeFileSync(gate, liveBody); } }; // the dead gate was judged; a live holder takes the name
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((r) => ({ r }), (e) => ({ e }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(swapped, true, 'the test did swap the gate inside the break window');
  assert.equal(lockFiles(ctx.dir).length, 0, 'no lock is written while a live holder has the gate');
  assert.equal(readFileSync(gate, 'utf8'), liveBody, 'the live holder\'s gate is back under its name');
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => f.startsWith('gate.lock.')), [], 'no renamed leftover');
  rmSync(gate);
  const done = await outcome;
  assert.equal(done.r?.granted, true, done.e?.message);
});

test('F6a: a live gate that appears after we move the dead gate aside is not removed', async () => {
  // The first F6a test swaps BEFORE the re-read, so a read-then-delete also passes it. This one swaps AFTER the move:
  // only a move-then-compare keeps the live gate, because a delete by name would remove the new file.
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 102);
  const gate = join(ctx.dir, 'gate.lock');
  const liveBody = gateBody(102, 1102);
  writeFileSync(gate, gateBody(555, 5555)); // pid 555 does not run
  let swapped = false;
  ctx.d.afterGateRename = () => { if (!swapped) { swapped = true; writeFileSync(gate, liveBody); } }; // a live holder takes the gate name in this window (a plain write: it also replaces a file that is still there)
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((r) => ({ r }), (e) => ({ e }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(swapped, true, 'the test did swap the gate after the move');
  assert.equal(lockFiles(ctx.dir).length, 0, 'no lock is written while a live holder has the gate');
  assert.equal(readFileSync(gate, 'utf8'), liveBody, 'the live holder\'s gate survives');
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => f.startsWith('gate.lock.')), [], 'no renamed leftover');
  rmSync(gate);
  const done = await outcome;
  assert.equal(done.r?.granted, true, done.e?.message);
  assert.equal(lockFiles(ctx.dir).length, 1, 'one lock only: the run was granted once');
});

test('F6a: a dead gate that we break leaves no renamed file behind', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  writeFileSync(join(ctx.dir, 'gate.lock'), gateBody(555, 5555));
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d)).granted, true);
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => f.startsWith('gate.lock')), []);
});

test('F6b: a gate whose holder start time is "unknown" is broken by age (60 s) after pid reuse, and not before', async () => {
  const old = setup();
  old.mode('grant');
  live(old, 101);
  live(old, 102); // pid 102 runs now, but it may be a new process: the gate cannot say
  const gate = join(old.dir, 'gate.lock');
  writeFileSync(gate, gateBody(102, 'unknown'));
  const longAgo = new Date(Date.now() - 120_000);
  utimesSync(gate, longAgo, longAgo);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, old.d);
  assert.equal(r.granted, true, 'a 120 second old gate of an unknown holder is broken');

  const young = setup();
  young.mode('grant');
  live(young, 101);
  live(young, 102);
  const g2 = join(young.dir, 'gate.lock');
  writeFileSync(g2, gateBody(102, 'unknown'));
  const recent = new Date(Date.now() - 30_000);
  utimesSync(g2, recent, recent);
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, young.d).then((x) => ({ x }), (e) => ({ e }));
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(lockFiles(young.dir).length, 0, 'a 30 second old gate is not broken');
  rmSync(g2);
  assert.equal((await outcome).x?.granted, true);
});

test('F6b: a gate of an unknown start whose pid is gone is broken at once; an unreadable pid read keeps it', async () => {
  const gone = setup();
  gone.mode('grant');
  live(gone, 101);
  writeFileSync(join(gone.dir, 'gate.lock'), gateBody(555, 'unknown'));
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, gone.d)).granted, true);
  const unreadable = setup();
  unreadable.mode('grant');
  live(unreadable, 101);
  const gate = join(unreadable.dir, 'gate.lock');
  writeFileSync(gate, gateBody(102, 'unknown'));
  const longAgo = new Date(Date.now() - 90_000); // under the 120 s age limit for any gate (R2)
  utimesSync(gate, longAgo, longAgo);
  unreadable.d.pidStart = (p) => (p === 102 ? 'unknown' : unreadable.st.alive.get(p) ?? null);
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, unreadable.d).then((x) => ({ x }), (e) => ({ e }));
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(lockFiles(unreadable.dir).length, 0, 'both sides unknown: the lock cannot tell, so the gate stays');
  rmSync(gate);
  assert.equal((await outcome).x?.granted, true);
});

test('low: break writes its log line BEFORE it removes a file (a failed log keeps the lock)', async () => {
  const ctx = setup();
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  mkdirSync(join(ctx.dir, 'break-log.jsonl')); // an append to a folder throws
  await assert.rejects(breakLock({ pid: 100, reason: 'stuck', who: 'seat' }, ctx.d));
  assert.equal(lockFiles(ctx.dir).length, 1, 'no log line, so no removal');
});

test('low: at exactly 5.0 GB with a loop live a heavy run is granted (the floor is "under 5")', async () => {
  for (const [free, ok] of [[5, true], [4.99, false]]) {
    const ctx = setup({ free });
    ctx.mode('grant');
    live(ctx, 300);
    await register({ kind: 'loop', pid: 300, holder: 'x' }, ctx.d);
    live(ctx, 100);
    assert.equal((await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d)).granted, ok, `${free} GB`);
  }
});

test('low: the CLI refuses release and break with no --pid', () => {
  const store = mk('runlock-cli-');
  for (const args of [['release'], ['break', '--reason', 'r', '--who', 'w'], ['release', '--pid', 'abc']]) {
    const r = runCli(args, store);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--pid/);
  }
});

test('low: a classifyEntry miss prints one note on stderr and still runs the CLI', () => {
  const store = mk('runlock-cli-');
  const wrapper = join(mk('runlock-miss-'), 'run-lock.mjs'); // named run-lock.mjs, not this file
  writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(RUN_LOCK).href)};\n`);
  const r = spawnSync(process.execPath, [wrapper, 'summary'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, RUN_LOCK_DIR: store } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal((r.stderr.match(/ran as/g) || []).length, 1, r.stderr);
  assert.match(r.stdout, /"total": 0/, 'the CLI ran');
});

test('low: RUN_LOCK_TEST_SAMPLES is used only when RUN_LOCK_DIR is set too', async () => {
  const ctx = setup();
  live(ctx, 100);
  const { samples, ...noSamples } = ctx.d;
  const env = { RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 95) }; // no RUN_LOCK_DIR: a stray variable must not fake a real run
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...noSamples, env });
  assert.doesNotMatch(r.lines.join('\n'), /RUN_LOCK_TEST_SAMPLES/, 'the hook is ignored');
});

test('low: the warn log row holds the head of the run', async () => {
  const ctx = setup({ load: 90 });
  live(ctx, 100);
  await acquire({ kind: 'pre-pr', pid: 100, holder: 't', head: 'abc12345' }, ctx.d);
  assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'warn-log.jsonl'), 'utf8').trim()).head, 'abc12345');
});

// ---------- seat list R1, R2, S1 to S4 ----------

test('R1: a pre-pr process younger than 2 minutes with no lock is not counted as an unlocked run; one older is', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100); // one live lock; the clock is now 3 minutes later
  const now = ctx.st.now;
  // two processes in their own acquire (6 seconds of samples, no lock yet): not slots
  ctx.st.procs = [{ pid: 501, start: now - 5_000 }, { pid: 502, start: now - 30_000 }];
  live(ctx, 101);
  const fresh = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(fresh.granted, true, fresh.lines.join('\n'));
  assert.ok(!fresh.lines.some((l) => /UNLOCKED RUN seen/.test(l)), fresh.lines.join('\n'));
  assert.equal((await list(ctx.d)).unlocked.length, 0, 'list agrees');
  // one process of 3 minutes with no lock is an old-code run: it takes the second slot
  const old = setup({ free: 6 });
  old.mode('grant');
  await take(old, 'pre-pr', 100);
  old.st.procs = [{ pid: 503, start: old.st.now - 3 * MIN }];
  live(old, 101);
  const stale = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, old.d);
  assert.equal(stale.granted, false);
  assert.ok(stale.lines.some((l) => /UNLOCKED RUN seen.*503/.test(l)), stale.lines.join('\n'));
  assert.equal((await list(old.d)).unlocked.length, 1);
});

test('R1: the age limit is more than 2 minutes; a start we cannot read is not counted', async () => {
  const ctx = setup({ free: 6 });
  await take(ctx, 'pre-pr', 100);
  const now = ctx.st.now;
  ctx.st.procs = [{ pid: 601, start: now - 2 * MIN }, { pid: 602, start: NaN }, { pid: 603, start: 'unknown' }, { pid: 604, start: null }];
  assert.equal((await list(ctx.d)).unlocked.length, 0, 'exactly 2 minutes, NaN, unknown and null are not counted');
  ctx.st.procs = [{ pid: 605, start: now - 2 * MIN - 1 }];
  assert.equal((await list(ctx.d)).unlocked.length, 1, '1 ms over 2 minutes is counted');
});

test('R1: in warn mode fresh unlocked processes cause no false WOULD WAIT line and no warn-log row', async () => {
  const ctx = setup({ free: 6 });
  await take(ctx, 'pre-pr', 100);
  const now = ctx.st.now;
  ctx.st.procs = [{ pid: 501, start: now - 1_000 }, { pid: 502, start: now - 2_000 }];
  live(ctx, 101);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d);
  assert.equal(r.granted, true);
  assert.equal(r.warned, false, r.lines.join('\n'));
  assert.ok(!r.lines.some((l) => /WOULD WAIT/.test(l)), r.lines.join('\n'));
  assert.equal(existsSync(join(ctx.dir, 'warn-log.jsonl')), false);
});

const OLD_GATE_S = 200; // older than the 120 s limit

test('R2: a gate older than 120 s is broken even when its holder is alive and the same process', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 102);
  const gate = join(ctx.dir, 'gate.lock');
  writeFileSync(gate, gateBody(102, 1102)); // pid 102 runs and its start matches: a live holder
  const longAgo = new Date(Date.now() - OLD_GATE_S * 1000);
  utimesSync(gate, longAgo, longAgo);
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((x) => ({ x }), (e) => ({ e }));
  assert.equal(r.x?.granted, true, r.e?.message ?? 'the gated part is file work only: 200 s is a wedge, not a long hold');
  assert.equal(existsSync(gate), false);
});

test('R2: a live holder gate that a breaker links back after the holder ended does not wedge every acquire', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 102);
  const gate = join(ctx.dir, 'gate.lock');
  writeFileSync(gate, gateBody(555, 5555)); // dead holder: this breaker judges it dead
  const liveBody = gateBody(102, 1102);
  let aged = false;
  // The file we moved aside is another text (a live holder's gate, whose own finally already ran): the breaker puts it back
  // and nobody removes it. Its file age is old, as a wedged gate is.
  ctx.d.afterGateRename = () => {
    if (aged) return;
    aged = true;
    const old = new Date(Date.now() - OLD_GATE_S * 1000);
    for (const f of readdirSync(ctx.dir).filter((n) => n.startsWith('gate.lock.broken-'))) {
      writeFileSync(join(ctx.dir, f), liveBody);
      utimesSync(join(ctx.dir, f), old, old);
    }
  };
  const r = await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((x) => ({ x }), (e) => ({ e }));
  assert.equal(aged, true, 'the test did run the moved-aside window');
  assert.equal(r.x?.granted, true, r.e?.message);
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => f.startsWith('gate.lock')), [], 'no gate and no renamed leftover');
});

test('R2: the finally step retries a failed gate remove a few times, and gives up quietly', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  let calls = 0;
  ctx.d.rmFile = (p) => { calls++; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); rmSync(p); };
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d)).granted, true);
  assert.equal(calls, 3, 'two EBUSY failures, then the third try removes the gate');
  assert.equal(existsSync(join(ctx.dir, 'gate.lock')), false);

  const stuck = setup();
  stuck.mode('grant');
  live(stuck, 101);
  let tries = 0;
  stuck.d.rmFile = () => { tries++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
  assert.equal((await acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, stuck.d)).granted, true, 'a failed remove never fails the grant');
  assert.ok(tries > 1 && tries <= 10, `bounded retry, got ${tries} tries`);
});

test('S1: a gate that changes between the judgment and the move is left alone: no move, no put-back', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 101);
  live(ctx, 102);
  const gate = join(ctx.dir, 'gate.lock');
  const liveBody = gateBody(102, 1102);
  writeFileSync(gate, gateBody(555, 5555));
  let swapped = false;
  let moved = 0;
  ctx.d.beforeGateBreak = () => { if (!swapped) { swapped = true; writeFileSync(gate, liveBody); } };
  ctx.d.afterGateRename = () => { moved++; };
  const outcome = acquire({ kind: 'pre-pr', pid: 101, holder: 't' }, ctx.d).then((r) => ({ r }), (e) => ({ e }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(swapped, true);
  assert.equal(moved, 0, 'the re-read sees another text, so the live gate is never moved aside');
  assert.equal(readFileSync(gate, 'utf8'), liveBody);
  rmSync(gate);
  assert.equal((await outcome).r?.granted, true);
});

test('S2: a CLI release writes one line to the break log with the pid, the kind and who', () => {
  const store = mk('runlock-cli-');
  writeFileSync(join(store, 'MODE'), 'grant');
  assert.equal(runCli(['acquire', '--kind', 'hook-build', '--pid', String(process.pid), '--holder', 'h'], store).status, 0);
  const rel = runCli(['release', '--pid', String(process.pid), '--who', 'RE seat'], store);
  assert.equal(rel.status, 0, `${rel.stdout}${rel.stderr}`);
  const lines = readFileSync(join(store, 'break-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.pid, process.pid);
  assert.equal(row.who, 'RE seat');
  assert.equal(row.kind, 'release');
  assert.deepEqual(row.files.map((f) => f.kind), ['hook-build']);
  assert.equal(lockFiles(store).length, 0, 'the lock is removed');
  // no --who: the row still names someone
  runCli(['acquire', '--kind', 'hook-build', '--pid', String(process.pid), '--holder', 'h'], store);
  runCli(['release', '--pid', String(process.pid)], store);
  const last = JSON.parse(readFileSync(join(store, 'break-log.jsonl'), 'utf8').trim().split('\n').pop());
  assert.ok(typeof last.who === 'string' && last.who.length > 0);
});

test('S3: a failed pgrep gives no process; a bad or non-positive pid in its output is dropped', () => {
  const calls = [];
  const failed = (cmd) => { calls.push(cmd); return { status: null, error: new Error('spawn pgrep ENOENT'), stdout: null, stderr: null }; };
  assert.deepEqual(RL.realPrePrProcs({ spawn: failed, platform: 'linux' }), [], 'no fake run with pid NaN');
  assert.ok(calls.includes('pgrep'), 'the injected spawn was used');
  const mixed = (cmd) => (cmd === 'pgrep' ? { status: 0, stdout: 'abc\n4242\n0\n-5\n' } : { status: 0, stdout: 'Sat Nov 15 09:00:00 2026\n' });
  const procs = RL.realPrePrProcs({ spawn: mixed, platform: 'linux' });
  assert.deepEqual(procs.map((p) => p.pid), [4242]);
});

test('G3: a light kind is governed only by the load bar: a hook build 30 seconds after a heavy start is granted', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  live(ctx, 101);
  assert.equal((await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d)).granted, true);
  ctx.st.now = T0 + 30_000;
  const build = await acquire({ kind: 'hook-build', pid: 101, holder: 't' }, ctx.d);
  assert.equal(build.granted, true, build.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'last-grant.json'), 'utf8')).at, T0, 'the hook build does not move the spacing clock');
  ctx.st.load = 85;
  live(ctx, 102);
  assert.equal((await acquire({ kind: 'hook-build', pid: 102, holder: 't' }, ctx.d)).granted, false, 'the load bar still refuses a hook build');
});

test('G4: list sweeps inside the gate: a renew that lands between the sweep decision and the remove keeps its lock', async () => {
  // The old list removed the file with no gate. A renew (register, same pid and kind) that wrote the same file name in that
  // window lost its lock. The seam starts a real register at that moment and does not wait for it: with the gate it waits for list.
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  live(ctx, 9000); // list and the renew take the gate as pid 9000: a waiter judges a gate dead when its holder pid has no start time
  await take(ctx, 'pre-pr', 100); // file pre-pr-100-1100.lock
  ctx.st.now = T0 + 60 * MIN; // past its expiry
  let snapshotTaken = false;
  ctx.d.pidStart = (pid) => (pid === 100 && !snapshotTaken ? 'unknown' : ctx.st.alive.get(pid) ?? null); // the snapshot read fails: expired and not proven alive
  let fired = 0;
  let renew = null;
  ctx.d.beforeSweepRemove = () => {
    if (fired++) return;
    snapshotTaken = true;
    renew = register({ kind: 'pre-pr', pid: 100, holder: 'renewed' }, { ...ctx.d, beforeSweepRemove: undefined });
  };
  await list(ctx.d);
  assert.equal(fired, 1, 'the sweep decided to remove the expired lock');
  await renew;
  assert.deepEqual(lockFiles(ctx.dir), ['pre-pr-100-1100.lock'], 'the renewed lock stays');
  assert.equal(JSON.parse(readFileSync(join(ctx.dir, 'pre-pr-100-1100.lock'), 'utf8')).holder, 'renewed');
  assert.equal(existsSync(join(ctx.dir, 'gate.lock')), false, 'the gate is freed');
});

test('G4: list on a missing store works and does not create it', async () => {
  const ctx = setup();
  const gone = join(ctx.dir, 'no-such-store');
  const out = await list({ ...ctx.d, dir: gone });
  assert.match(out.lines.join('\n'), /no live lock/);
  assert.equal(existsSync(gone), false, 'a read does not make the store');
});

test('G4: a gate that stays held does not wedge list: it falls back to a listing that removes nothing', async () => {
  const ctx = setup({ free: 6 });
  ctx.mode('grant');
  live(ctx, 9000);
  await take(ctx, 'pre-pr', 100);
  ctx.st.alive.delete(100); // the run is gone: a gated list would sweep its lock
  writeFileSync(join(ctx.dir, 'gate.lock'), JSON.stringify({ pid: 9000, pidStart: 1000 + 9000 })); // a live holder, a fresh file
  const out = await list(ctx.d);
  assert.deepEqual(out.live, [], 'the dead run is not listed');
  assert.deepEqual(lockFiles(ctx.dir), ['pre-pr-100-1100.lock'], 'no gate, so nothing is removed');
});

test('S4: RUN_LOCK_TEST_SAMPLES is ignored when RUN_LOCK_DIR is the default store', async () => {
  const defaultStore = join(os.homedir(), '.claude', 'state', 'run-locks');
  const sep = process.platform === 'win32' ? '\\' : '/';
  for (const text of [defaultStore, `${defaultStore}${sep}`, process.platform === 'win32' ? defaultStore.toUpperCase() : defaultStore]) {
    const ctx = setup();
    live(ctx, 100);
    const { samples, ...noSamples } = ctx.d; // the store stays the temp folder: the test never touches the real one
    const r = await acquire({ kind: 'hook-build', pid: 100, holder: 't' }, { ...noSamples, env: { RUN_LOCK_TEST_SAMPLES: SAMPLES_ENV(8, 95), RUN_LOCK_DIR: text } });
    assert.doesNotMatch(r.lines.join('\n'), /RUN_LOCK_TEST_SAMPLES/, `the hook is ignored for ${text}`);
  }
});

test('list has a short gate budget: a live gate holder of unknown start delays it by seconds, not by the 10 s of acquire', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  const lock = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, ctx.d);
  assert.equal(lock.granted, true);
  const gate = join(ctx.dir, 'gate.lock');
  writeFileSync(gate, gateBody(100, 'unknown')); // a live holder whose start time is unknown: the gate is not broken before 60 s
  ctx.d.sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // a real clock: the budget is time
  const t0 = Date.now();
  const out = await list(ctx.d);
  const took = Date.now() - t0;
  assert.ok(took < 5000, `list took ${took} ms behind a held gate; the budget is about 2 s`);
  assert.equal(out.live.length, 1, 'the listing still shows the live lock (it removes nothing)');
  assert.equal(readFileSync(gate, 'utf8'), gateBody(100, 'unknown'), 'the gate file is the holder\'s, untouched');
});

// ---------- card prflow-prepr-speed: pre-pr phases (version 17 in code) ----------
/** The start of a lock file name: `<kind>-<pid>-`. Built, not typed, so the text holds no kind-number token. */
const lockPrefix = (kind, pid) => [kind, pid, ''].join('-');
// A pre-pr in the test phase is the only heavy part. At most 2 may run in it, at most 1 of them heavy (it runs the hooks-vitest gate).
// A run in phase cr (the CodeRabbit step: no local load) and a waiting run (phase wait) take no place.
//
// How it can fail, one test each, with the source change that makes it fail:
//   F8   a third test-phase pre-pr is granted                    (keep the V7.3 tiers only)
//   F9   a second heavy pre-pr is granted                        (no heavy count)
//   F10  a run in phase cr still counts                          (count every live pre-pr)
//   F11  a phase change by a pid that does not hold the lock     (match by pid only, or by a file name that does not hold the start time)
//   F12  a dead owner holds a place                              (no sweep)
//   F13  one low read passes (a load spike)                      (one read, or the best of two reads)
//   F16  an old-code run with no lock is not counted as heavy    (count lock files only)
//   F18  --wait-lock waits for ever                              (no 60 minute limit)
//   F19  two waiters refuse each other (no lock file, counted as unlocked runs)    (no wait record)
//   F20  a newer waiter gets the place first                     (no order)
//   F25  an old-code lock with no phase frees a place            (a missing phase reads as cr)
//   L2   setPhase writes the file in place or matches the pid only  (no temp file and rename; no start time in the name)
// F14 (HOLD) has no test: the seat dropped the hold and unhold verbs.

const prePr = (ctx, pid, extra = {}) => acquire({ kind: 'pre-pr', pid, holder: 't', ...extra }, ctx.d);
const recOf = (ctx, file) => JSON.parse(readFileSync(join(ctx.dir, file), 'utf8'));

test('F8: a third test-phase pre-pr is refused in grant mode, at 8 GB where the V7.3 tier would allow 3', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  assert.equal((await take(ctx, 'pre-pr', 100)).granted, true);
  assert.equal((await take(ctx, 'pre-pr', 101)).granted, true);
  live(ctx, 102);
  const third = await prePr(ctx, 102);
  assert.equal(third.granted, false);
  assert.match(third.lines.join('\n'), /2 pre-pr runs in the test phase/);
});

test('F9: a second heavy pre-pr is refused, a light one is granted; the lock record holds heavy and phase test', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  live(ctx, 100);
  const first = await prePr(ctx, 100, { heavy: true });
  assert.equal(first.granted, true);
  assert.deepEqual([recOf(ctx, first.file).heavy, recOf(ctx, first.file).phase], [true, 'test']);
  ctx.st.now += 3 * MIN;
  live(ctx, 101);
  const heavy = await prePr(ctx, 101, { heavy: true });
  assert.equal(heavy.granted, false);
  assert.match(heavy.lines.join('\n'), /1 heavy pre-pr/);
  const light = await prePr(ctx, 101);
  assert.equal(light.granted, true);
  assert.equal(recOf(ctx, light.file).heavy, false);
});

test('F10: a pre-pr in phase cr takes no place: with two locks, one in phase cr, a third is granted', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  const a = await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  assert.equal(RL.setPhase({ file: a.file, pid: 100, phase: 'cr' }, ctx.d).changed, true);
  live(ctx, 102);
  assert.equal((await prePr(ctx, 102)).granted, true);
});

test('F11: setPhase by a pid that does not hold the lock changes nothing, and a reused pid with another start time is not the holder', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  const a = await take(ctx, 'pre-pr', 100);
  const before = readFileSync(join(ctx.dir, a.file), 'utf8');
  assert.equal(RL.setPhase({ file: a.file, pid: 999, phase: 'cr' }, ctx.d).changed, false, 'another pid');
  // A record of this pid from ANOTHER start time (a run that reused the pid) must be a real file: with no such file the test cannot tell
  // the ownership check from a missing file. Same pid, other start: the name is not ours and the record start is not the live start.
  const staleName = `${lockPrefix('pre-pr', 100)}9999.lock`;
  const stale = join(ctx.dir, staleName);
  const staleText = JSON.stringify({ kind: 'pre-pr', pid: 100, pidStart: 9999, holder: 'old run', startedAt: T0, expiresAt: T0 + 60 * MIN, heavy: false, phase: 'test' });
  writeFileSync(stale, staleText);
  assert.equal(RL.setPhase({ file: staleName, pid: 100, phase: 'cr' }, ctx.d).changed, false, 'same pid, other start time: the record is not ours');
  assert.equal(readFileSync(stale, 'utf8'), staleText, 'the record of the other start is untouched');
  assert.equal(readFileSync(join(ctx.dir, a.file), 'utf8'), before);
  assert.throws(() => RL.setPhase({ file: a.file, pid: 100, phase: 'bogus' }, ctx.d), /phase/);
});

test('L2: setPhase writes through a temp file and a rename: the record stays valid and no temp file is left', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  const a = await take(ctx, 'pre-pr', 100);
  RL.setPhase({ file: a.file, pid: 100, phase: 'cr' }, ctx.d);
  const rec = recOf(ctx, a.file);
  assert.equal(rec.phase, 'cr');
  assert.equal(rec.pid, 100);
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => !f.endsWith('.lock') && !['MODE', 'last-grant.json'].includes(f)), [], 'no temp file');
});

test('F12: a lock whose owner is gone holds no place: the acquire is granted and the file is removed', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  const dead = await take(ctx, 'pre-pr', 101);
  ctx.st.alive.delete(101);
  live(ctx, 102);
  assert.equal((await prePr(ctx, 102)).granted, true);
  assert.equal(existsSync(join(ctx.dir, dead.file)), false);
});

test('F13: one low read does not pass: 74 then 27 is refused, 27 then 74 is refused, and the second read comes 30 s later', async () => {
  for (const loads of [[74, 27], [27, 74]]) {
    const ctx = setup();
    ctx.mode('grant');
    live(ctx, 100);
    const sleeps = [];
    let n = 0;
    ctx.d.samples = async () => { const l = loads[Math.min(n++, 1)]; return { free: [8, 8, 8], load: [l, l, l] }; };
    ctx.d.sleep = (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, 1)); };
    const r = await prePr(ctx, 100);
    assert.equal(r.granted, false, JSON.stringify(loads));
    assert.match(r.lines.join('\n'), /load 74 percent/);
    if (loads[0] === 27) { assert.equal(n, 2); assert.ok(sleeps.includes(30_000), 'the second read waits 30 s'); }
  }
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  let reads = 0;
  ctx.d.samples = async () => { reads++; return { free: [8, 8, 8], load: [10, 10, 10] }; };
  assert.equal((await prePr(ctx, 100)).granted, true);
  assert.equal(reads, 2, 'two reads for a pre-pr');
  live(ctx, 101);
  reads = 0;
  await acquire({ kind: 'hook-build', pid: 101, holder: 't' }, ctx.d);
  assert.equal(reads, 1, 'another kind keeps one read');
});

test('F13b: samples from the test hook take no 30 s gap, and under 5 GB a pre-pr is refused', async () => {
  const ctx = setup();
  ctx.mode('grant');
  live(ctx, 100);
  const sleeps = [];
  const { samples, ...noSamples } = ctx.d;
  const env = { RUN_LOCK_DIR: ctx.dir, RUN_LOCK_TEST_SAMPLES: JSON.stringify({ free: [8, 8, 8], load: [10, 10, 10] }) };
  const r = await acquire({ kind: 'pre-pr', pid: 100, holder: 't' }, { ...noSamples, env, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  assert.equal(r.granted, true);
  assert.equal(sleeps.includes(30_000), false);
  const low = setup({ free: 4.5 });
  low.mode('grant');
  live(low, 100);
  const refused = await prePr(low, 100);
  assert.equal(refused.granted, false);
  assert.match(refused.lines.join('\n'), /free memory 4\.5 GB under 5 GB/);
});

test('F16: an old-code pre-pr with no lock file, older than 2 minutes, counts as one heavy test-phase run', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  ctx.st.procs = [{ pid: 555, start: T0 - 5 * MIN }];
  live(ctx, 100);
  const heavy = await prePr(ctx, 100, { heavy: true });
  assert.equal(heavy.granted, false);
  assert.match(heavy.lines.join('\n'), /UNLOCKED RUN/);
  live(ctx, 101);
  const light = await prePr(ctx, 101);
  assert.equal(light.granted, true, 'a light run still fits beside it');
  ctx.st.now += 3 * MIN;
  live(ctx, 102);
  assert.equal((await prePr(ctx, 102)).granted, false, 'the unlocked run and the light run fill the 2 places');
});

test('F25: an old-code pre-pr lock with no phase and no heavy field counts as heavy, phase test', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  live(ctx, 100);
  writeFileSync(join(ctx.dir, 'pre-pr-100-1100.lock'), JSON.stringify({ kind: 'pre-pr', pid: 100, pidStart: 1100, holder: 'old', head: null, session: null, startedAt: T0, expiresAt: T0 + 45 * MIN }));
  live(ctx, 101);
  const heavy = await prePr(ctx, 101, { heavy: true });
  assert.equal(heavy.granted, false);
  const light = await prePr(ctx, 101);
  assert.equal(light.granted, true);
});

test('F19: two waiters are no unlocked runs and are granted in turn, F20: the oldest waiter first', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  live(ctx, 201);
  const a = await prePr(ctx, 200, { wait: true });
  assert.equal(a.granted, false);
  ctx.st.now += MIN;
  const b = await prePr(ctx, 201, { wait: true });
  assert.equal(b.granted, false);
  assert.equal(recOf(ctx, readdirSync(ctx.dir).find((f) => f.startsWith(lockPrefix('pre-pr', 200)))).phase, 'wait');
  ctx.st.now += 3 * MIN;
  ctx.st.procs = [{ pid: 200, start: T0 - 9 * MIN }, { pid: 201, start: T0 - 9 * MIN }]; // the waiters run: they must not read as unlocked runs
  releaseSync({ pid: 100 }, ctx.d);
  const newer = await prePr(ctx, 201, { wait: true });
  assert.equal(newer.granted, false, 'a place is free, but an older waiter comes first');
  assert.match(newer.lines.join('\n'), /older waiter/);
  const older = await prePr(ctx, 200, { wait: true });
  assert.equal(older.granted, true);
  assert.equal(recOf(ctx, older.file).phase, 'test', 'the wait record became the lock');
  ctx.st.now += 3 * MIN;
  releaseSync({ pid: 101 }, ctx.d);
  assert.equal((await prePr(ctx, 201, { wait: true })).granted, true);
  assert.equal(readdirSync(ctx.dir).filter((f) => f.startsWith('pre-pr-')).length, 2);
});

test('a waiter whose process is gone is swept: it does not block the next grant', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  await prePr(ctx, 200, { wait: true });
  ctx.st.alive.delete(200);
  ctx.st.now += 3 * MIN;
  releaseSync({ pid: 100 }, ctx.d);
  live(ctx, 201);
  assert.equal((await prePr(ctx, 201, { wait: true })).granted, true);
});

test('a refusal in warn mode writes no wait record', async () => {
  const ctx = setup({ free: 8, load: 90 });
  live(ctx, 100);
  const r = await prePr(ctx, 100, { wait: true });
  assert.equal(r.granted, true);
  assert.equal(recOf(ctx, r.file).phase, 'test');
});

test('F18: waitForGrant gives up after 60 minutes with exit 75 and removes its wait record', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  const t0 = ctx.st.now;
  let tries = 0;
  const d = { ...ctx.d, sleep: async (ms) => { ctx.st.now += ms; }, samples: async () => { tries++; return { free: [8, 8, 8], load: [10, 10, 10] }; } };
  const r = await RL.waitForGrant({ kind: 'pre-pr', pid: 200, holder: 't' }, d, { maxMs: 60 * MIN });
  assert.equal(r.granted, false);
  assert.equal(r.exit, 75);
  assert.ok(ctx.st.now - t0 >= 60 * MIN, 'the clock ran 60 minutes');
  assert.ok(tries >= 3, `asked again and again (${tries})`);
  assert.equal(readdirSync(ctx.dir).filter((f) => f.startsWith(lockPrefix('pre-pr', 200))).length, 0, 'the wait record is gone');
});

test('waitForGrant returns the grant when a place frees up', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  // The place frees only during the WAIT sleep (not the 30 s second read inside an acquire), so the grant needs a second attempt.
  let reads = 0;
  const waits = [];
  const d = {
    ...ctx.d,
    samples: async () => { reads++; return { free: [8, 8, 8], load: [10, 10, 10] }; },
    sleep: async (ms) => {
      ctx.st.now += ms;
      if (ms === 30_000) return;
      const queued = readdirSync(ctx.dir).filter((f) => f.startsWith(lockPrefix('pre-pr', 200)));
      waits.push(queued.map((f) => recOf(ctx, f).phase));
      releaseSync({ pid: 100 }, ctx.d);
    },
  };
  const r = await RL.waitForGrant({ kind: 'pre-pr', pid: 200, holder: 't' }, d, { maxMs: 60 * MIN });
  assert.equal(r.granted, true);
  assert.deepEqual(waits, [['wait']], 'one wait sleep, and the refused first attempt left a wait record');
  assert.equal(reads, 4, 'two machine reads for each of two attempts: the retry happened');
  assert.equal(recOf(ctx, r.file).phase, 'test', 'the wait record became the lock');
});

test('list shows the phase of a pre-pr lock; a new pre-pr lock is good for 60 minutes; logRun appends one row to runs.jsonl', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  const a = await take(ctx, 'pre-pr', 100);
  const rec = recOf(ctx, a.file);
  assert.equal(rec.expiresAt - rec.startedAt, 60 * MIN);
  assert.match((await list(ctx.d)).lines.join('\n'), /pre-pr pid 100 .*phase test/);
  RL.logRun({ event: 'start', pid: 100, head: 'abc12345' }, ctx.d);
  RL.logRun({ event: 'end', pid: 100, minutes: 4.2 }, ctx.d);
  const rows = readFileSync(join(ctx.dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.event), ['start', 'end']);
  assert.ok(rows.every((r) => Number.isFinite(r.ts)));
  assert.equal(RL.lockMode(ctx.dir), 'grant');
});

test('L1: waitForGrant reads its options again at every attempt when they come as a function (the head changes while we wait)', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  const heads = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'];
  let n = 0;
  const d = { ...ctx.d, sleep: async (ms) => { ctx.st.now += ms; if (ms !== 30_000 && n === 2) releaseSync({ pid: 100 }, ctx.d); } }; // 30 s is the second machine read, not the wait
  const r = await RL.waitForGrant(() => ({ kind: 'pre-pr', pid: 200, holder: 't', head: heads[n++] }), d, { maxMs: 60 * MIN });
  assert.equal(r.granted, true);
  assert.equal(recOf(ctx, r.file).head, 'cccccccc', 'the lock holds the head of the last attempt');
});

// ---------- seat first read 14:05: the LIMITS file and the wait sleep cap ----------
// LIMITS: only the seat writes it; it can only LOWER the two pre-pr limits. How it fails, one test each:
//   LIM1  a LIMITS of {test:1, heavy:1} is ignored: a second test-phase pre-pr is granted             (limits read from code only)
//   LIM2  a value above the code limits, under 1, heavy above test, or bad JSON raises or keeps 2      (no clamp: anything else gives 1 and 1)
//   LIM3  no file keeps the code limits 2 and 1                                                        (a missing file read as bad)
//   LIM4  the WAIT line does not name the limit in force and where it came from                        (text without the source)
//   WS1   the wait sleep reaches the 10 minute life of the wait record, so the queue place is lost     (sleep to retryAt with no cap)
const writeLimits = (ctx, text) => writeFileSync(join(ctx.dir, 'LIMITS'), text);

test('LIM1: a LIMITS file of test 1 refuses a second test-phase pre-pr that the code limit 2 would grant', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  writeLimits(ctx, JSON.stringify({ test: 1, heavy: 1 }));
  assert.equal((await take(ctx, 'pre-pr', 100)).granted, true);
  live(ctx, 101);
  const second = await prePr(ctx, 101);
  assert.equal(second.granted, false);
  assert.match(second.lines.join('\n'), /1 pre-pr runs in the test phase, the limit in force is 1 \(LIMITS file\)/);
});

test('LIM2: a LIMITS file can only lower: raise, under 1, heavy above test, a non-integer and bad JSON all give 1 and 1', () => {
  for (const text of [JSON.stringify({ test: 3, heavy: 1 }), JSON.stringify({ test: 2, heavy: 2 }), JSON.stringify({ test: 0, heavy: 0 }), JSON.stringify({ test: 1, heavy: 2 }), JSON.stringify({ test: 1.5, heavy: 1 }), JSON.stringify({ heavy: 1 }), '{bad', '[]']) {
    const ctx = setup();
    writeLimits(ctx, text);
    const l = RL.readLimits(ctx.dir);
    assert.deepEqual([l.test, l.heavy], [1, 1], `LIMITS ${text}`);
    assert.match(l.source, /LIMITS file not valid/);
  }
  const ok = setup();
  writeLimits(ok, JSON.stringify({ test: 1, heavy: 1 }));
  assert.deepEqual(RL.readLimits(ok.dir), { test: 1, heavy: 1, source: 'LIMITS file' });
  const two = setup();
  writeLimits(two, JSON.stringify({ test: 2, heavy: 1 }));
  assert.deepEqual(RL.readLimits(two.dir), { test: 2, heavy: 1, source: 'LIMITS file' }, 'equal to the code limits is allowed');
});

test('LIM3: no LIMITS file keeps the code limits 2 and 1', () => {
  assert.deepEqual(RL.readLimits(setup().dir), { test: 2, heavy: 1, source: 'code' });
});

test('LIM4: with no file the WAIT line names the code limit; a heavy refusal names the heavy limit in force', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  assert.equal((await take(ctx, 'pre-pr', 100)).granted, true);
  assert.equal((await take(ctx, 'pre-pr', 101)).granted, true);
  live(ctx, 102);
  assert.match((await prePr(ctx, 102)).lines.join('\n'), /the limit in force is 2 \(code\)/);
  const h = setup({ free: 8 });
  h.mode('grant');
  live(h, 100);
  assert.equal((await prePr(h, 100, { heavy: true })).granted, true);
  h.st.now += 3 * MIN;
  live(h, 101);
  assert.match((await prePr(h, 101, { heavy: true })).lines.join('\n'), /heavy limit in force is 1 \(code\)/);
});

test('WS1: the wait sleep stays under the life of the wait record, whatever the retry time', () => {
  const now = 1_000_000;
  const cap = RL.WAIT_MAX_SLEEP_MS;
  assert.ok(cap < 10 * MIN, `the cap ${cap} ms is under the 10 minute record life`);
  assert.equal(RL.waitSleepMs(now + 30 * MIN, now, 60 * MIN), cap, 'a far retry time sleeps only the cap');
  assert.equal(RL.waitSleepMs(now + 10_000, now, 60 * MIN), 30_000, 'a near retry time sleeps the 30 s minimum');
  assert.equal(RL.waitSleepMs(now + 30 * MIN, now, 2 * MIN), 2 * MIN, 'never past the time left');
});

// ---------- card prflow-prepr-speed follow-up (CodeRabbit CLI run 1): order of waiters, wait record, limits, deadline, phase file, heavy ----------
// How it can fail, one test each, with the source change that makes it fail:
//   M1  an expired waiter that is alive still refuses a newer run (order), or its swept record makes it an unlocked run (slots)   (no expiry test in the older filter; sweep removes an expired waiter)
//   G   a wait record removes the test or cr record of its own pid, or leaves an older wait record of it                          (no remove; remove by pid only)
//   M2  a LIMITS file that cannot be read gives the code limits                                                                    (catch with no code test)
//   M4  a place that frees during the sleep is granted after the deadline, or a grant after the deadline stays held               (no deadline test before the acquire or after the grant)
//   H   setPhase with an explicit file name changes the record of a run that reused the pid                                        (no start check for a given name)
//   D   setHeavy is missing or leaves the lock light for the heavy limit                                                           (no setHeavy)

test('M1: an expired waiter that is alive refuses nobody and takes no place in the test count (record start readable, record start unreadable)', async () => {
  for (const unreadable of [false, true]) {
    const ctx = setup({ free: 8 });
    ctx.mode('grant');
    await take(ctx, 'pre-pr', 100);
    await take(ctx, 'pre-pr', 101);
    live(ctx, 200);
    assert.equal((await prePr(ctx, 200, { wait: true })).granted, false, 'the waiter waits');
    releaseSync({ pid: 101 }, ctx.d); // one test-phase lock is left: a waiter counted as a test run would fill the limit of 2
    ctx.st.procs = [{ pid: 200, start: T0 - 9 * MIN }]; // the waiter process runs
    live(ctx, 201);
    ctx.st.now += MIN;
    const young = await prePr(ctx, 201);
    assert.equal(young.granted, false, `control: a waiter with a live record comes first (unreadable ${unreadable})`);
    assert.deepEqual(young.keys, ['queue']);
    ctx.st.now += 11 * MIN; // past the 10 minute life of the wait record
    if (unreadable) { const read = ctx.d.pidStart; ctx.d.pidStart = (pid) => (pid === 200 ? 'unknown' : read(pid)); }
    const r = await prePr(ctx, 201);
    assert.equal(r.granted, true, `unreadable ${unreadable}: ${r.lines.join(' / ')}`);
  }
});

test('G: a wait record removes the other WAIT records of its pid and never a test or cr record', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  await take(ctx, 'pre-pr', 100);
  await take(ctx, 'pre-pr', 101);
  live(ctx, 200);
  const prefix = lockPrefix('pre-pr', 200);
  const rec = (phase, pidStart) => JSON.stringify({ kind: 'pre-pr', pid: 200, pidStart, holder: 'x', startedAt: T0, expiresAt: T0 + 60 * MIN, heavy: false, phase });
  writeFileSync(join(ctx.dir, `${prefix}unknown.lock`), rec('wait', 'unknown')); // left by a first attempt whose start read failed
  writeFileSync(join(ctx.dir, `${prefix}5555.lock`), rec('wait', 5555));
  writeFileSync(join(ctx.dir, `${prefix}7001.lock`), rec('cr', 1200));
  writeFileSync(join(ctx.dir, `${prefix}7002.lock`), rec('test', 1200));
  const r = await prePr(ctx, 200, { wait: true });
  assert.equal(r.granted, false);
  const left = readdirSync(ctx.dir).filter((f) => f.startsWith(prefix)).sort().map((f) => [f.slice(prefix.length), recOf(ctx, f).phase]);
  assert.deepEqual(left, [['1200.lock', 'wait'], ['7001.lock', 'cr'], ['7002.lock', 'test']]);
});

test('M2: a LIMITS that cannot be read gives 1 and 1; only a missing file gives the code limits', () => {
  const ctx = setup();
  mkdirSync(join(ctx.dir, 'LIMITS')); // reading a folder fails with EISDIR, not ENOENT
  const l = RL.readLimits(ctx.dir);
  assert.deepEqual([l.test, l.heavy], [1, 1]);
  assert.match(l.source, /cannot be read/);
  assert.deepEqual(RL.readLimits(setup().dir), { test: 2, heavy: 1, source: 'code' }, 'control: no file');
});

test('M4: the deadline is checked before each acquire, and a grant after the deadline is given back with exit 75 and no lock file', async () => {
  const slept = setup({ free: 8 });
  slept.mode('grant');
  await take(slept, 'pre-pr', 100);
  await take(slept, 'pre-pr', 101);
  live(slept, 200);
  // The clock passes the 5 minute limit during the wait sleep, and a place frees in the same sleep: the next acquire would grant.
  const dSleep = { ...slept.d, sleep: async (ms) => { if (ms === 30_000) { slept.st.now += ms; return; } slept.st.now += 10 * MIN; releaseSync({ pid: 100 }, slept.d); } };
  const a = await RL.waitForGrant({ kind: 'pre-pr', pid: 200, holder: 't' }, dSleep, { maxMs: 5 * MIN });
  assert.equal(a.granted, false, 'no grant after the deadline');
  assert.equal(a.exit, 75);
  assert.equal(a.timedOut, true);
  assert.deepEqual(readdirSync(slept.dir).filter((f) => f.startsWith(lockPrefix('pre-pr', 200))), [], 'no lock file and no wait record');
  // The clock passes the limit inside the acquire (the 30 s second read) and the grant succeeds: it is released.
  const inAcquire = setup({ free: 8 });
  inAcquire.mode('grant');
  live(inAcquire, 200);
  const dRead = { ...inAcquire.d, sleep: async (ms) => { inAcquire.st.now += ms === 30_000 ? 10 * MIN : ms; } };
  const b = await RL.waitForGrant({ kind: 'pre-pr', pid: 200, holder: 't' }, dRead, { maxMs: 5 * MIN });
  assert.equal(b.granted, false, 'a grant that comes after the deadline is not a grant');
  assert.equal(b.exit, 75);
  assert.deepEqual(readdirSync(inAcquire.dir).filter((f) => f.startsWith(lockPrefix('pre-pr', 200))), [], 'the lock was released');
});

test('H: setPhase with an explicit file name changes the record only when the name is the derived one or the record start is the live start', () => {
  const ctx = setup({ free: 8 });
  live(ctx, 100); // live start 1100
  const body = (pidStart) => JSON.stringify({ kind: 'pre-pr', pid: 100, pidStart, holder: 'x', startedAt: T0, expiresAt: T0 + 60 * MIN, heavy: false, phase: 'test' });
  const mine = `${lockPrefix('pre-pr', 100)}custom.lock`;
  const other = `${lockPrefix('pre-pr', 100)}reused.lock`;
  writeFileSync(join(ctx.dir, mine), body(1100));
  writeFileSync(join(ctx.dir, other), body(9999));
  assert.equal(RL.setPhase({ file: other, pid: 100, phase: 'cr' }, ctx.d).changed, false, 'the record start is not the live start');
  assert.equal(recOf(ctx, other).phase, 'test');
  assert.equal(RL.setPhase({ file: mine, pid: 100, phase: 'cr' }, ctx.d).changed, true, 'the record start is the live start');
  assert.equal(recOf(ctx, mine).phase, 'cr');
});

test('D: setHeavy turns a light lock heavy through a temp file and a rename, and the heavy limit then counts it', async () => {
  const ctx = setup({ free: 8 });
  ctx.mode('grant');
  live(ctx, 100);
  const a = await prePr(ctx, 100);
  assert.equal(recOf(ctx, a.file).heavy, false);
  assert.equal(RL.setHeavy({ file: a.file, pid: 999 }, ctx.d).changed, false, 'another pid');
  assert.equal(RL.setHeavy({ file: a.file, pid: 100 }, ctx.d).changed, true);
  const rec = recOf(ctx, a.file);
  assert.deepEqual([rec.heavy, rec.phase, rec.pid], [true, 'test', 100]);
  assert.deepEqual(readdirSync(ctx.dir).filter((f) => !f.endsWith('.lock') && !['MODE', 'last-grant.json'].includes(f)), [], 'no temp file');
  ctx.st.now += 3 * MIN;
  live(ctx, 101);
  const heavy = await prePr(ctx, 101, { heavy: true });
  assert.equal(heavy.granted, false);
  assert.match(heavy.lines.join('\n'), /1 heavy pre-pr/);
});

// ---- card coord-run-lock-reading: the lock row holds the free memory and load read at the grant ----
// How it can fail, one test each:
//   RD1 a granted acquire (heavy and light kind) writes grantFreeGB (one decimal) and grantLoadPct (whole percent)
//   RD2 a warn-mode grant that "would wait" is a grant: it writes them too
//   RD3 a refused grant (wait record) writes no reading
//   RD4 register writes no reading
//   RD5 setPhase keeps the reading
//   RD6 a row with no fields, or a bad value, lists with no reading text and no crash (never 0)
//   RD7 the list line of a row with a reading is the old line, byte for byte, plus one suffix at the end
const GRANT_FIELDS = ['grantFreeGB', 'grantLoadPct'];
const listLines = async (ctx) => (await list(ctx.d)).lines;

test('RD1: a granted acquire writes the free memory and load of its read into the row', async () => {
  const ctx = setup({ free: 7.34, load: 12 });
  ctx.mode('grant');
  live(ctx, 100);
  const heavy = await prePr(ctx, 100);
  assert.equal(heavy.granted, true);
  assert.equal(recOf(ctx, heavy.file).grantFreeGB, 7.3);
  assert.equal(recOf(ctx, heavy.file).grantLoadPct, 12);
  ctx.st.now += 3 * MIN;
  live(ctx, 101);
  const light = await acquire({ kind: 'hook-build', pid: 101, holder: 't' }, ctx.d);
  assert.equal(light.granted, true);
  assert.equal(recOf(ctx, light.file).grantFreeGB, 7.3);
  assert.equal(recOf(ctx, light.file).grantLoadPct, 12);
});

test('RD1b: a pre-pr stores the worse of its two reads, the value that decided the grant', async () => {
  const ctx = setup({ free: 9, load: 10 });
  ctx.mode('grant');
  const seq = [{ free: [9, 9, 9], load: [10, 10, 10] }, { free: [6.2, 6.2, 6.2], load: [40, 40, 40] }];
  ctx.d.samples = async () => seq.shift();
  ctx.d.samplesHooked = false;
  live(ctx, 100);
  const r = await prePr(ctx, 100);
  assert.equal(r.granted, true);
  assert.equal(recOf(ctx, r.file).grantFreeGB, 6.2);
  assert.equal(recOf(ctx, r.file).grantLoadPct, 40);
});

test('RD2: a warn-mode grant that would wait is a grant and writes the reading', async () => {
  const ctx = setup({ free: 8, load: 90 });
  live(ctx, 100);
  const r = await prePr(ctx, 100);
  assert.equal(r.granted, true);
  assert.equal(r.warned, true);
  assert.equal(recOf(ctx, r.file).grantLoadPct, 90);
  assert.equal(recOf(ctx, r.file).grantFreeGB, 8);
});

test('RD3: a refused grant leaves a wait record with no reading', async () => {
  const ctx = setup({ free: 8, load: 95 });
  ctx.mode('grant');
  live(ctx, 100);
  const r = await prePr(ctx, 100, { wait: true });
  assert.equal(r.granted, false);
  assert.ok(r.waitFile, 'a wait record is written');
  for (const k of GRANT_FIELDS) assert.equal(k in recOf(ctx, r.waitFile), false, `${k} on a wait record`);
});

test('RD4: register writes no reading: nothing was decided or read', async () => {
  const ctx = setup({ free: 7, load: 12 });
  ctx.mode('grant');
  live(ctx, 300);
  const r = await register({ kind: 'loop', pid: 300, holder: 'x' }, ctx.d);
  for (const k of GRANT_FIELDS) assert.equal(k in recOf(ctx, r.file), false, `${k} on a registered row`);
});

test('RD5: setPhase keeps the reading', async () => {
  const ctx = setup({ free: 7.34, load: 12 });
  ctx.mode('grant');
  live(ctx, 100);
  const r = await prePr(ctx, 100);
  assert.equal(RL.setPhase({ pid: 100, phase: 'cr' }, ctx.d).changed, true);
  assert.equal(recOf(ctx, r.file).phase, 'cr');
  assert.equal(recOf(ctx, r.file).grantFreeGB, 7.3);
  assert.equal(recOf(ctx, r.file).grantLoadPct, 12);
});

test('RD6: an old row and a row with a bad value list with no reading text, never 0', async () => {
  const ctx = setup();
  ctx.mode('grant');
  const base = (pid) => ({ kind: 'loop', pid, pidStart: 1000 + pid, holder: 'old', head: null, session: null, startedAt: T0, expiresAt: T0 + 60 * MIN });
  const rows = [base(200), { ...base(201), grantFreeGB: 'x', grantLoadPct: 5 }, { ...base(202), grantFreeGB: NaN, grantLoadPct: 5 }, { ...base(203), grantFreeGB: 4, grantLoadPct: null }];
  rows.forEach((row, i) => { live(ctx, 200 + i); writeFileSync(join(ctx.dir, `loop-${row.pid}-${row.pidStart}.lock`), JSON.stringify(row)); });
  const lines = (await listLines(ctx)).filter((l) => /^loop pid/.test(l));
  assert.equal(lines.length, 4, lines.join('\n'));
  for (const l of lines) assert.doesNotMatch(l, /read free|GB|pct|\b0 pct/, l);
});

test('RD7: a row with a reading lists as the old line byte for byte, plus one suffix at the end', async () => {
  const ctx = setup({ free: 7.34, load: 12 });
  ctx.mode('grant');
  live(ctx, 100);
  const r = await prePr(ctx, 100);
  const withReading = (await listLines(ctx)).find((l) => /^pre-pr pid 100/.test(l));
  const file = join(ctx.dir, r.file);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of GRANT_FIELDS) delete rec[k];
  writeFileSync(file, JSON.stringify(rec));
  const old = (await listLines(ctx)).find((l) => /^pre-pr pid 100/.test(l));
  assert.ok(old && withReading, 'both lines exist');
  assert.equal(withReading, `${old} read free 7.3 GB load 12 pct`);
});

// ---- card coord-run-lock-reading, part 2 (seat ruling 2026-11-22 16:2x): a run-wrap process is not a pre-pr run ----
// A wrapped pre-pr has two node processes whose command line holds scripts/github/pre-pr.mjs: the wrapper and its child. The wrapper was counted as an
// UNLOCKED RUN after 2 minutes and took the slot its own child waited for (deadlock). realPrePrProcs must drop a wrapper and keep the child.
//   RD8  win32: a command line that runs run-wrap.mjs is not counted; a plain pre-pr.mjs line is; a body path that holds "run-wrap" is still a run
//   RD9  pgrep: the same two forms (pgrep -af gives "pid command"); a bare pid (no command text) is still counted
const WRAPPED = 'node scripts/coordination/run-wrap.mjs --kind pre-pr --once-per head -- node scripts/github/pre-pr.mjs --body C:/x/pr-body.md --wait-lock';
const PLAIN = 'node scripts/github/pre-pr.mjs --body C:/x/pr-body.md --wait-lock';
const TRICKY = 'node scripts/github/pre-pr.mjs --body C:/x/notes-about-run-wrap.mjs.md --wait-lock';

test('RD8: on Windows a run-wrap command line is not a pre-pr run, its child and a plain run are', () => {
  const out = [`100|2026-11-22T22:00:00.000Z|${WRAPPED}`, `101|2026-11-22T22:00:01.000Z|${PLAIN}`, `102|2026-11-22T22:00:02.000Z|${TRICKY}`, `103|2026-11-22T22:00:03.000Z|C:\\Program Files\\nodejs\\node.exe C:\\r\\scripts\\coordination\\run-wrap.mjs --kind pre-pr -- node scripts/github/pre-pr.mjs`].join('\r\n');
  const procs = RL.realPrePrProcs({ spawn: () => ({ status: 0, stdout: out }), platform: 'win32' });
  assert.deepEqual(procs.map((p) => p.pid), [101, 102]);
  assert.equal(procs[0].start, Date.parse('2026-11-22T22:00:01.000Z'));
});

test('RD9: with pgrep a run-wrap command line is not a pre-pr run, its child and a plain run are', () => {
  const calls = [];
  const spawn = (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'pgrep' ? { status: 0, stdout: `100 ${WRAPPED}\n101 ${PLAIN}\n102 ${TRICKY}\n300\n` } : { status: 0, stdout: 'Sat Nov 15 09:00:00 2026\n' }; };
  const procs = RL.realPrePrProcs({ spawn, platform: 'linux' });
  assert.deepEqual(procs.map((p) => p.pid), [101, 102, 300]);
  assert.ok(calls.some((c) => c[0] === 'pgrep' && c.some((a) => /^-[a-z]*a[a-z]*$/.test(a))), 'pgrep must print the command line (-a) to tell a wrapper from a run');
});

// ---- card hook-build-run-lock (seat GO 2026-11-26 21:07 CST): a hook build registers a hook-build run lock while it builds ----
// The wrapper .claude/hooks/scripts/build-with-lock.mjs: register (no slot, no wait), run the build as a child with stdio inherited, release in a finally.
// How it can fail, one row each:
//   HB1  a build leaves no lock while it runs, or a lock after it ends, or no start and end line in runs.jsonl
//   HB2  a failed build (child exit 3) leaves its lock held, or the exit code is not passed on
//   HB3  a broken lock store stops or changes the build; the stderr line is missing outside CI or is printed inside CI
//   HB4  a second build while one is held waits, is refused, or does not register
//   HB5  a build longer than its expiry leaves a lock held (the release goes by pid, not by expiry)
//   HB6  the package.json build line does not run through the wrapper, or the old line is lost
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks');
const WRAPPER = join(HOOKS, 'scripts', 'build-with-lock.mjs');
const NODE_PROBE = (marker, dir, extra = '') => `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(fs.readdirSync(${JSON.stringify(dir)})))}catch(e){fs.writeFileSync(${JSON.stringify(marker)},'[]')}${extra}`;
function runWrapper(dir, args, env = {}) {
  const cleanEnv = { ...process.env, RUN_LOCK_DIR: dir, ...env };
  if (env.CI === undefined) delete cleanEnv.CI;
  return spawnSync(process.execPath, [WRAPPER, ...args], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 60000 });
}
const hookLocks = (dir) => (existsSync(dir) ? lockFiles(dir).filter((f) => f.startsWith('hook-build-')) : []);
const runsOf = (dir) => (existsSync(join(dir, 'runs.jsonl')) ? readFileSync(join(dir, 'runs.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

test('HB1: a build holds one hook-build lock while it runs, none after, and writes a start and an end line', () => {
  const dir = mk('hbl-');
  const marker = join(dir, 'seen.json');
  const r = runWrapper(dir, [process.execPath, '-e', NODE_PROBE(marker, dir)]);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(seen.filter((f) => /^hook-build-\d+-/.test(f)).length, 1, `during the build: ${seen.join(',')}`);
  assert.deepEqual(hookLocks(dir), []);
  const rows = runsOf(dir).filter((x) => x.kind === 'hook-build');
  assert.deepEqual(rows.map((x) => x.event), ['start', 'end']);
  assert.equal(rows[1].result, 'PASS');
  assert.equal(rows[0].pid, rows[1].pid);
});

test('HB2: a failed build (exit 3) passes its exit code on and leaves no lock; the end line says FAIL', () => {
  const dir = mk('hbl-');
  const r = runWrapper(dir, [process.execPath, '-e', 'process.exit(3)']);
  assert.equal(r.status, 3);
  assert.deepEqual(hookLocks(dir), []);
  const end = runsOf(dir).find((x) => x.event === 'end' && x.kind === 'hook-build');
  assert.equal(end?.result, 'FAIL');
});

test('HB3: a broken lock store never stops the build: same exit code, one stderr line outside CI, none inside CI', () => {
  const base = mk('hbl-');
  const notAFolder = join(base, 'file');
  writeFileSync(notAFolder, 'x');
  const store = join(notAFolder, 'store');
  const marker = join(base, 'ran.txt');
  const probe = `require('fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exit(4)`;
  const plain = runWrapper(store, [process.execPath, '-e', probe]);
  assert.equal(plain.status, 4, plain.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
  assert.equal(plain.stderr.split(/\r?\n/).filter((l) => /^hook-build-lock:/.test(l)).length, 1, plain.stderr);
  rmSync(marker);
  const ci = runWrapper(store, [process.execPath, '-e', probe], { CI: '1' });
  assert.equal(ci.status, 4);
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
  assert.equal(ci.stderr.trim(), '');
});

test('HB4: a second build while one is held still registers and runs, with no wait', async () => {
  const dir = mk('hbl-');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', windowsHide: true });
  const was = process.env.RUN_LOCK_DIR;
  process.env.RUN_LOCK_DIR = dir;
  try {
    await new Promise((r) => setTimeout(r, 300));
    await register({ kind: 'hook-build', pid: sleeper.pid, holder: 'first build', head: 'aaaa1111' });
    assert.equal(hookLocks(dir).length, 1);
    const marker = join(dir, 'seen.json');
    const t0 = Date.now();
    const r = runWrapper(dir, [process.execPath, '-e', NODE_PROBE(marker, dir)]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - t0 < 20_000, 'the wrapper waited');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).filter((f) => /^hook-build-\d+-/.test(f)).length, 2);
    assert.equal(hookLocks(dir).length, 1, 'only the lock of the first build is left');
  } finally {
    if (was === undefined) delete process.env.RUN_LOCK_DIR; else process.env.RUN_LOCK_DIR = was;
    sleeper.kill();
  }
});

test('HB5: a build that outlives its expiry still releases its own lock', () => {
  const dir = mk('hbl-');
  const r = runWrapper(dir, ['--minutes', '0.02', '--', process.execPath, '-e', 'setTimeout(()=>{},2500)']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hookLocks(dir), []);
  assert.equal(runsOf(dir).filter((x) => x.event === 'end' && x.kind === 'hook-build').length, 1);
});

test('HB7: run by hand with no command and no npm, the wrapper refuses at once with one clear line, exit 1, no lock and no run line', () => {
  const dir = mk('hbl-');
  const r = runWrapper(dir, [], { npm_execpath: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^hook-build-lock: run the build through npm/m);
  assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, r.stderr);
  assert.deepEqual(hookLocks(dir), []);
  assert.deepEqual(runsOf(dir), []);
});

test('HB6: the build script of the hooks folder runs through the wrapper and keeps the old line as build:raw', () => {
  const pkg = JSON.parse(readFileSync(join(HOOKS, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /scripts\/build-with-lock\.mjs/);
  assert.match(pkg.scripts['build:raw'] ?? '', /esbuild src\/\*\.ts .*normalize-dist-paths\.mjs.*copy-parser-assets\.mjs.*write-build-inputs\.mjs/);
  assert.ok(existsSync(WRAPPER));
});

// ---- ruling B (seat 2026-11-26 21:31 CST, Dave away): the critic and aegis mediums of the first review pass ----
// How it can fail, one row each:
//   HB8   a SIGTERM to the wrapper leaves the build child running, releases the lock before the child ended, or exits with a code other than 143
//   HB9   a held gate file delays the build by the full register wait (about ten seconds): the wrapper must give up after a few seconds and run the build
//   HB10  the lock record has no session label (holder is the fixed text), so the wrap table cannot say whose build it is; with no session id it keeps the fixed holder
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntilTrue = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('HB8: a SIGTERM stops the build child first, then releases the lock, and the wrapper exits 143', { skip: process.platform === 'win32' && 'a Node signal kill on Windows runs no handler: Linux CI runs this row' }, async () => {
  const dir = mk('hbl-');
  const marker = join(dir, 'child.pid');
  const probe = `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const cleanEnv = { ...process.env, RUN_LOCK_DIR: dir };
  delete cleanEnv.CI;
  const wrapper = spawn(process.execPath, [WRAPPER, process.execPath, '-e', probe], { env: cleanEnv, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => wrapper.on('exit', (code, signal) => resolve({ code, signal })));
  let childPid = null;
  try {
    assert.ok(await waitUntilTrue(() => existsSync(marker), 15_000), 'the build child never started');
    childPid = Number(readFileSync(marker, 'utf8'));
    assert.equal(hookLocks(dir).length, 1, 'the lock is held while the child runs');
    wrapper.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 143, 'a SIGTERM exits with 128 + 15');
    assert.equal(alive(childPid), false, 'the build child must be stopped before the wrapper exits');
    assert.deepEqual(hookLocks(dir), []);
    assert.equal(runsOf(dir).filter((x) => x.event === 'end' && x.kind === 'hook-build').length, 1);
  } finally {
    if (childPid && alive(childPid)) { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } }
    try { wrapper.kill('SIGKILL'); } catch { /* gone */ }
  }
});

test('HB9: a gate file held by a live process delays the build by a few seconds at most, and the build still runs', async () => {
  const dir = mk('hbl-');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(dir, 'gate.lock'), JSON.stringify({ pid: holder.pid, pidStart: RL.realPidStart(holder.pid), nonce: 'hb9' }));
    const marker = join(dir, 'ran.txt');
    const t0 = Date.now();
    const r = runWrapper(dir, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`]);
    const took = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'ran', 'the build must run');
    assert.ok(took < 7000, `the wrapper waited ${took} ms for a gate that stays held: the register wait must end after a few seconds`);
    assert.equal(r.stderr.split(/\r?\n/).filter((l) => /^hook-build-lock:/.test(l)).length, 1, r.stderr);
    assert.deepEqual(hookLocks(dir), [], 'no lock is written after the wrapper gave up');
  } finally {
    holder.kill();
  }
});

test('HB10: the lock record carries the session label as holder and session; with no session id the holder keeps the fixed text', () => {
  const dir = mk('hbl-');
  const probeFor = (marker) => `const fs=require('fs'),p=require('path');const f=fs.readdirSync(${JSON.stringify(dir)}).find((x)=>/^hook-build-/.test(x));fs.writeFileSync(${JSON.stringify(marker)},f?fs.readFileSync(p.join(${JSON.stringify(dir)},f),'utf8'):'{}')`;
  const withId = join(dir, 'with-id.json');
  const r1 = runWrapper(dir, [process.execPath, '-e', probeFor(withId)], { CLAUDE_CODE_SESSION_ID: '0d40499c-1111-2222-3333-444444444444' });
  assert.equal(r1.status, 0, r1.stderr);
  const rec = JSON.parse(readFileSync(withId, 'utf8'));
  assert.equal(rec.session, '#0d40499c');
  assert.equal(rec.holder, '#0d40499c', 'the holder is the session label, as run-wrap writes it');
  const noId = join(dir, 'no-id.json');
  const r2 = runWrapper(dir, [process.execPath, '-e', probeFor(noId)], { CLAUDE_CODE_SESSION_ID: '' });
  assert.equal(r2.status, 0, r2.stderr);
  const bare = JSON.parse(readFileSync(noId, 'utf8'));
  assert.equal(bare.holder, 'hook build');
  assert.equal(bare.session, null);
});
