// Tests for scripts/github/lib/file-lock.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/lib/file-lock.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLock } from './file-lock.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'file-lock-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
// The pid of a process that has exited: run one node process to completion and keep its pid.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

// Breaks if withLock stops returning fn's value or stops deleting the lock file after fn.
test('a free lock runs fn, returns its value and removes the lock file', () => {
  const file = path.join(tmp(), 'state.json');
  let inside = false;
  const out = withLock(file, {}, () => { inside = existsSync(`${file}.lock`); return 42; });
  assert.equal(out, 42);
  assert.equal(inside, true, 'the lock file exists while fn runs');
  assert.equal(existsSync(`${file}.lock`), false);
});

// Breaks if the unlink moves out of the finally block.
test('fn throwing still releases the lock, and the error reaches the caller', () => {
  const file = path.join(tmp(), 'state.json');
  assert.throws(() => withLock(file, {}, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(`${file}.lock`), false);
});

// Breaks if the wait loop ignores lockWaitMs, or runs fn without the lock.
test('a fresh lock held by someone else times out with reason lock and never runs fn', () => {
  const file = path.join(tmp(), 'state.json');
  writeFileSync(`${file}.lock`, 'other');
  let ran = false;
  const out = withLock(file, { lockWaitMs: 60, lockStaleMs: 30_000 }, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'lock');
  assert.equal(existsSync(`${file}.lock`), true, 'the other holder keeps its lock');
});

// Breaks if the stale check is removed or compares against the wait time instead of lockStaleMs.
test('a lock older than lockStaleMs is taken over', () => {
  const file = path.join(tmp(), 'state.json');
  writeFileSync(`${file}.lock`, 'dead');
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  const out = withLock(file, { lockWaitMs: 60, lockStaleMs: 30_000 }, () => 'mine');
  assert.equal(out, 'mine');
  assert.equal(existsSync(`${file}.lock`), false);
});

// Breaks if stale takeover ignores the owner pid: a slow but live holder would lose its lock (CodeRabbit Major on a041938).
test('an old lock whose owner process is alive is not taken over', () => {
  const file = path.join(tmp(), 'state.json');
  writeFileSync(`${file}.lock`, `${process.pid} live-token`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  let ran = false;
  const out = withLock(file, { lockWaitMs: 80, lockStaleMs: 30_000 }, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(out.reason, 'lock');
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), `${process.pid} live-token`, 'the live holder keeps its lock');
});

// Breaks if stale takeover stops treating a dead pid as gone.
test('an old lock whose owner process is dead is taken over', () => {
  const file = path.join(tmp(), 'state.json');
  writeFileSync(`${file}.lock`, `${deadPid()} dead-token`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(withLock(file, { lockWaitMs: 80, lockStaleMs: 30_000 }, () => 'mine'), 'mine');
});

// Breaks if release unlinks without checking the token: a former holder would delete its replacement's lock.
test('release keeps a lock that another holder now owns', () => {
  const file = path.join(tmp(), 'state.json');
  withLock(file, {}, () => { writeFileSync(`${file}.lock`, '1 someone-else'); });
  assert.equal(existsSync(`${file}.lock`), true);
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), '1 someone-else');
});

// Breaks if an unreadable or undeletable lock path retries with no sleep and no timeout (CodeRabbit Minor on a041938).
test('a lock path that cannot be read or removed times out as held instead of spinning', () => {
  const file = path.join(tmp(), 'state.json');
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  const began = Date.now();
  const out = withLock(file, { lockWaitMs: 100, lockStaleMs: 30_000 }, () => 'never');
  assert.equal(out.reason, 'lock');
  assert.ok(Date.now() - began < 5_000, 'returns near lockWaitMs');
});

// Breaks if every open error is treated as "held" (it would spin until the wait time, then report a false lock).
test('an error other than EEXIST is thrown, not reported as a held lock', () => {
  const file = path.join(tmp(), 'no-such-dir', 'state.json');
  assert.throws(() => withLock(file, { lockWaitMs: 60 }, () => 'never'), { code: 'ENOENT' });
});

// --- Stale takeover is exclusive: real child processes call the real withLock on one planted dead lock. ---
// Failure modes: (1) a taker that judged the lock stale before another taker replaced it deletes the new live
// lock, so two holders run fn together; (2) the same with many takers starting at once; (3) the taker's removal
// step hits a live lock that replaced the stale one and must not destroy it; (4) takeover leaves tombstones behind.
const LOCK_URL = pathToFileURL(fileURLToPath(new URL('./file-lock.mjs', import.meta.url))).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plantDeadLock = (file) => {
  writeFileSync(`${file}.lock`, `${deadPid()} dead-token`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
};

// The child holds the lock for holdMs and logs "in/out <label>". Its mode hooks the FIRST fs call that starts a takeover:
// the unlink or rename of the lock path (earlier designs) or the create of `<lock>.takeover` (the mutex design). That call
// runs right after the stale judgement, so a pause there lets another process take the lock first.
//   pause: wait for <ctl>/go (any child writes it on entering fn).   swap: put a live lock in place.
//   gap: pause, and also pause at the rename design's restore (linkSync back to the lock) until <ctl>/go2.
const CHILD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [url, file, mode, ctl, log, holdMs, livePid, waitMs, label, start] = process.argv.slice(1);
const lock = file + '.lock';
const mutex = lock + '.takeover';
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const mark = (name) => fs.writeFileSync(ctl + '/' + name, '1');
const waitFor = (name) => { for (let end = Date.now() + 8000; !fs.existsSync(ctl + '/' + name) && Date.now() < end;) nap(10); };
let fired = false;
let gapFired = false;
const wrap = (name, hits, run) => { const real = fs[name]; fs[name] = (...a) => { if (hits(a)) run(); return real(...a); }; };
const atTakeover = (target) => (a) => !fired && mode !== 'plain' && a[0] === target;
const firstHook = () => {
  fired = true;
  if (mode === 'pause' || mode === 'gap') { mark('paused'); waitFor('go'); }
  if (mode === 'swap') { fs.unlinkSync(lock); fs.writeFileSync(lock, livePid + ' live-token'); }
};
for (const name of ['unlinkSync', 'renameSync']) wrap(name, atTakeover(lock), firstHook);
wrap('openSync', atTakeover(mutex), firstHook); // the lock's own create is not a takeover step
wrap('linkSync', (a) => mode === 'gap' && !gapFired && a[1] === lock, () => { gapFired = true; mark('paused2'); waitFor('go2'); });
syncBuiltinESMExports();
const { withLock } = await import(url);
for (let end = Date.now() + 8000; start !== '-' && !fs.existsSync(start) && Date.now() < end;) nap(1);
let ran = false;
const out = withLock(file, { lockWaitMs: Number(waitMs), lockStaleMs: 30000 }, () => {
  ran = true;
  fs.appendFileSync(log, 'in ' + label + '\\n');
  mark('go');
  nap(Number(holdMs));
  fs.appendFileSync(log, 'out ' + label + '\\n');
  return 'done';
});
console.log(JSON.stringify({ label, ran, out }));
`;

function startChild(dir, file, { mode = 'plain', holdMs = 100, waitMs = 8000, label = mode, start = '-' } = {}) {
  const args = ['--input-type=module', '-e', CHILD, LOCK_URL, file, mode, dir, path.join(dir, 'log.txt'), String(holdMs), String(process.pid), String(waitMs), label, start];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr, result: stdout.trim() ? JSON.parse(stdout.trim()) : null })));
  return { child, done };
}

// Reads the in/out log: the most holders inside fn at once, and how many entered. A missing log means no entries.
function overlapped(dir) {
  const logFile = path.join(dir, 'log.txt');
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  let inside = 0;
  let worst = 0;
  for (const line of lines) { inside += line.startsWith('in ') ? 1 : -1; worst = Math.max(worst, inside); }
  return { worst, entries: lines.filter((l) => l.startsWith('in ')).length };
}

// Breaks if the takeover removes the lock with a bare unlink: taker B judged the dead lock stale, taker A replaced it
// with a live lock and entered fn, then B deleted A's lock and entered fn too.
test('a taker that judged the lock stale earlier does not evict the holder that took over first', async () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  const slow = startChild(dir, file, { mode: 'pause', holdMs: 100, label: 'B' });
  for (let i = 0; i < 400 && !existsSync(path.join(dir, 'paused')); i++) await sleep(25);
  assert.ok(existsSync(path.join(dir, 'paused')), 'B reached its removal step');
  const fast = startChild(dir, file, { holdMs: 400, label: 'A' });
  const [b, a] = await Promise.all([slow.done, fast.done]);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(overlapped(dir), { worst: 1, entries: 2 }, 'both ran, one at a time');
});

// Breaks if several takers that see the same dead owner can each win the takeover (rounds repeat to catch a timing race).
test('many takers racing for one dead lock enter fn one at a time', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = tmp();
    const file = path.join(dir, 'state.json');
    plantDeadLock(file);
    const start = path.join(dir, 'start');
    const runs = Array.from({ length: 4 }, (_, i) => startChild(dir, file, { holdMs: 60, label: `P${i}`, start }));
    await sleep(600);
    writeFileSync(start, '1');
    const results = await Promise.all(runs.map((r) => r.done));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(overlapped(dir), { worst: 1, entries: 4 }, `round ${round}: four runs, one at a time`);
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.lock')), [], 'no lock or tombstone is left');
  }
});

// Breaks if the takeover treats the stale judgement as final: a live lock replaced the dead one before the removal step,
// and the taker deleted it and ran fn beside the live holder.
test('a live lock that replaces the stale one before the takeover step is kept', async () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  const run = await startChild(dir, file, { mode: 'swap', waitMs: 300 }).done;
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.result.ran, false, 'fn must not run beside the live holder');
  assert.equal(run.result.out.reason, 'lock');
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), `${process.pid} live-token`, 'the live lock is back in place');
  assert.deepEqual(readdirSync(dir).filter((n) => /\.(stale|takeover)$/.test(n)), [], 'no tombstone or takeover mutex is left');
});

// Breaks if the winning taker leaves its tombstone or its takeover mutex behind.
test('a takeover leaves no tombstone or mutex file', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  assert.deepEqual(withLock(file, {}, () => readdirSync(dir).filter((n) => /\.(stale|takeover)$/.test(n))), []);
  assert.deepEqual(readdirSync(dir), []);
});

const waitUntil = async (pred, ms) => { for (const end = Date.now() + ms; !pred() && Date.now() < end;) await sleep(20); return pred(); };
const logHas = (dir, text) => existsSync(path.join(dir, 'log.txt')) && readFileSync(path.join(dir, 'log.txt'), 'utf8').includes(text);

// CodeRabbit Major on e7eacce: taker B judged the lock stale, taker A replaced it and holds it, then B acts. Interleaving 1.
// Breaks if B moves or removes A's live lock: the path is absent, so a third process C enters fn beside A.
test('a taker that acts after another process took the lock never exposes the live lock to a third process', async () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  const b = startChild(dir, file, { mode: 'gap', holdMs: 50, waitMs: 3000, label: 'B' });
  assert.ok(await waitUntil(() => existsSync(path.join(dir, 'paused')), 10_000), 'B reached its takeover step');
  const a = startChild(dir, file, { holdMs: 1200, label: 'A' });
  assert.ok(await waitUntil(() => existsSync(path.join(dir, 'go')), 10_000), 'A entered fn');
  const gap = await waitUntil(() => existsSync(path.join(dir, 'paused2')), 500); // reached only by a design that moves the lock
  const c = startChild(dir, file, { holdMs: 50, label: 'C' });
  if (gap) { await sleep(400); writeFileSync(path.join(dir, 'go2'), '1'); }
  const results = await Promise.all([a.done, b.done, c.done]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(overlapped(dir), { worst: 1, entries: 3 }, 'A, B and C each ran, one at a time');
});

// CodeRabbit Major on e7eacce, interleaving 2: the live holder A releases while taker B is between its judgement and its action.
// Breaks if B puts back a lock that A has already released: an orphan lock stays and nobody can acquire the file.
test('a holder that releases while a taker is mid-takeover leaves no orphan lock', async () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  const b = startChild(dir, file, { mode: 'gap', holdMs: 50, waitMs: 1500, label: 'B' });
  assert.ok(await waitUntil(() => existsSync(path.join(dir, 'paused')), 10_000), 'B reached its takeover step');
  const a = startChild(dir, file, { holdMs: 300, label: 'A' });
  assert.ok(await waitUntil(() => existsSync(path.join(dir, 'go')), 10_000), 'A entered fn');
  if (await waitUntil(() => existsSync(path.join(dir, 'paused2')), 500)) {
    assert.ok(await waitUntil(() => logHas(dir, 'out A'), 3000), 'A left fn while B was mid-takeover');
    await sleep(200); // A's release has run
    writeFileSync(path.join(dir, 'go2'), '1');
  }
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  const d = await startChild(dir, file, { holdMs: 10, waitMs: 400, label: 'D' }).done;
  assert.equal(d.result.ran, true, 'the lock is acquirable after A released');
  assert.equal(overlapped(dir).worst, 1);
  assert.equal(existsSync(`${file}.lock`), false, 'no orphan lock remains');
});

// Breaks if a taker removes the lock without holding the takeover mutex: another taker is mid-takeover, so the lock must stay.
test('a taker that cannot get the takeover mutex leaves the stale lock untouched', () => {
  const file = path.join(tmp(), 'state.json');
  plantDeadLock(file);
  const before = readFileSync(`${file}.lock`, 'utf8');
  writeFileSync(`${file}.lock.takeover`, `${process.pid} other-taker`);
  let ran = false;
  const out = withLock(file, { lockWaitMs: 150, lockStaleMs: 30_000 }, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(out.reason, 'lock');
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), before, 'the stale lock is untouched');
  assert.equal(readFileSync(`${file}.lock.takeover`, 'utf8'), `${process.pid} other-taker`, 'the live taker keeps its mutex');
});

// Breaks if a takeover mutex left by a crashed taker is never cleared: every later taker would time out.
test('a takeover mutex whose owner is dead does not block the lock forever', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  plantDeadLock(file);
  writeFileSync(`${file}.lock.takeover`, `${deadPid()} crashed-taker`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock.takeover`, old, old);
  assert.equal(withLock(file, { lockWaitMs: 2000, lockStaleMs: 30_000 }, () => 'mine'), 'mine');
  assert.deepEqual(readdirSync(dir), []);
});
