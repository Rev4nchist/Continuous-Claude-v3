// Tests for scripts/github/lib/grok-slots.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/lib/grok-slots.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_WAIT_MS, acquireGrokSlot, resolveWaitMs } from './grok-slots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const made = [];
const tmpFile = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'grok-slots-test-')); made.push(d); return path.join(d, 'grok-slots.json'); };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const readActive = (file) => JSON.parse(readFileSync(file, 'utf8')).active;

/** A fake clock: sleep moves time forward, so a 60 min wait takes no real time. `onSleep` runs on each sleep. */
function clock(onSleep = () => {}) {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; await onSleep(sleeps.length); },
    sleeps,
    advance: (ms) => { t += ms; },
  };
}
const alive = () => true;

// Breaks if the slot count is ignored (a third caller would get in) or the wait gives up before waitMs.
test('a third caller waits for a slot, then gets busy and is not recorded', async () => {
  const file = tmpFile();
  const c = clock();
  const base = { file, max: 2, waitMs: 1000, pollMs: 100 };
  const deps = { now: c.now, sleep: c.sleep, pidAlive: alive };
  const a = await acquireGrokSlot(base, deps);
  const b = await acquireGrokSlot(base, deps);
  assert.equal(a.ok && b.ok, true);
  assert.equal(c.sleeps.length, 0, 'two free slots need no wait');
  const third = await acquireGrokSlot(base, deps);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'busy');
  assert.match(third.detail, /no slot/);
  assert.equal(c.sleeps.length, 10, 'it polled every 100 ms for 1000 ms');
  assert.equal(readActive(file).length, 2, 'the failed caller left no entry');
});

// Breaks if the waiter stops re-reading the file after a sleep, or if release does not free the slot.
test('a waiter takes the slot when a holder releases it', async () => {
  const file = tmpFile();
  const holder = await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
  assert.equal(holder.ok, true);
  const c = clock((n) => { if (n === 3) holder.release(); });
  const waiter = await acquireGrokSlot({ file, max: 1, waitMs: 60_000, pollMs: 100 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(waiter.ok, true);
  assert.equal(c.sleeps.length, 3, 'it slept until the release, then took the slot');
  assert.equal(readActive(file).length, 1);
});

// Breaks if entries with a dead pid stop being dropped: a crashed run would hold a slot for hours.
test('an entry whose pid is dead is dropped', async () => {
  const file = tmpFile();
  const c = clock();
  writeFileSync(file, JSON.stringify({ active: [{ key: 'dead-run', pid: 111, startedAt: c.now() }] }));
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (pid) => pid !== 111 });
  assert.equal(r.ok, true);
  assert.deepEqual(readActive(file).map((e) => e.pid), [process.pid]);
});

// Breaks if staleMs is ignored: a hung run whose pid was reused would block the gate for good.
test('an entry older than staleMs is dropped even when its pid runs', async () => {
  const file = tmpFile();
  const c = clock();
  const old = { key: 'old', pid: 222, startedAt: c.now() - 3 * 3_600_000 - 1 };
  const fresh = { key: 'fresh', pid: 333, startedAt: c.now() - 3 * 3_600_000 + 60_000 };
  writeFileSync(file, JSON.stringify({ active: [old, fresh] }));
  const r = await acquireGrokSlot({ file, max: 2, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, true, 'the old entry freed a slot');
  assert.deepEqual(readActive(file).map((e) => e.key).filter((k) => k === 'old'), []);
  assert.equal(readActive(file).some((e) => e.key === 'fresh'), true, 'an entry just inside staleMs stays');
  const again = await acquireGrokSlot({ file, max: 2, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(again.reason, 'busy', 'the fresh entry still counts');
});

test('opts.staleMs overrides the 3 h default', async () => {
  const file = tmpFile();
  const c = clock();
  writeFileSync(file, JSON.stringify({ active: [{ key: 'k', pid: 1, startedAt: c.now() - 2000 }] }));
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 0, staleMs: 1000 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, true);
});

// Breaks if a held lock throws or blocks the caller instead of returning reason 'lock'.
test('a held state lock returns reason lock and does not throw', async () => {
  const file = tmpFile();
  writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
  const r = await acquireGrokSlot({ file, max: 2, lockWaitMs: 60 }, { pidAlive: alive });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lock');
  assert.ok(r.detail);
});

// Breaks if release removes by pid (it would drop the sibling slot of the same process) or stops being idempotent.
test('two slots in one process get distinct keys; release removes only its own and is idempotent', async () => {
  const file = tmpFile();
  const deps = { pidAlive: alive };
  const a = await acquireGrokSlot({ file, max: 2 }, deps);
  const b = await acquireGrokSlot({ file, max: 2 }, deps);
  assert.equal(a.ok && b.ok, true, 'one pid holds two slots');
  const [ea, eb] = readActive(file);
  assert.notEqual(ea.key, eb.key);
  assert.equal(ea.pid, eb.pid);
  a.release();
  assert.deepEqual(readActive(file).map((e) => e.key), [eb.key]);
  a.release();
  a.release();
  assert.deepEqual(readActive(file).map((e) => e.key), [eb.key], 'a repeat release leaves the sibling alone');
  b.release();
  assert.deepEqual(readActive(file), []);
});

// Breaks if a second release of a key can remove a later holder: a released key is never reused.
test('a repeated release does not free the slot of a later holder', async () => {
  const file = tmpFile();
  const deps = { pidAlive: alive };
  const a = await acquireGrokSlot({ file, max: 1 }, deps);
  a.release();
  const next = await acquireGrokSlot({ file, max: 1 }, deps);
  a.release();
  assert.equal(readActive(file).length, 1);
  next.release();
});

// Breaks if release lets an error out (it runs in a finally block of a caller), or logs once per try instead of once at the end.
test('release never rejects when the lock stays held, retries, and logs once at the end', async () => {
  const file = tmpFile();
  const logs = [];
  const sleeps = [];
  const deps = { pidAlive: alive, log: (m) => logs.push(m), sleep: async (ms) => { sleeps.push(ms); } };
  const slot = await acquireGrokSlot({ file, max: 1, lockWaitMs: 30, releaseAttempts: 3, releaseBackoffMs: 10 }, deps);
  writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
  await assert.doesNotReject(slot.release());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /grok gate: release .* failed after 3 tries/);
  assert.deepEqual(sleeps, [10, 20], 'it backed off between the three tries');
});

// Finding: a failed release was never retried. Breaks if release gives up after one lock miss.
test('release retries after a lock miss and frees the slot once the lock clears', async () => {
  const file = tmpFile();
  const slot = await acquireGrokSlot({ file, max: 1, lockWaitMs: 30, releaseBackoffMs: 10 }, { pidAlive: alive, sleep: async () => { rmSync(`${file}.lock`, { force: true }); } });
  writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
  await slot.release();
  assert.deepEqual(readActive(file), []);
});

// Breaks if the held-keys set is dropped: an entry of this process with a key it does not hold would stay until it expires.
test('an entry of this process whose key it does not hold is dropped at the next take', async () => {
  const file = tmpFile();
  const c = clock();
  writeFileSync(file, JSON.stringify({ active: [{ key: 'leaked', pid: process.pid, startedAt: c.now(), expiresAt: c.now() + 10_000 }] }));
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, true);
  assert.equal(readActive(file).some((e) => e.key === 'leaked'), false);
});

// CodeRabbit CLI Minor on af3eb43. Breaks if the own-leak prune ignores a live agent pid: a failed release would let
// this process start a run above max while the orphaned agent still runs.
test('an entry of this process whose key it does not hold stays while its agent pid runs', async () => {
  const file = tmpFile();
  const c = clock();
  writeFileSync(file, JSON.stringify({ active: [{ key: 'leaked', pid: process.pid, childPid: 9004, startedAt: c.now(), expiresAt: c.now() + 10_000 }] }));
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p === process.pid || p === 9004 });
  assert.equal(r.reason, 'busy');
  const freed = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p === process.pid });
  assert.equal(freed.ok, true, 'it frees once the agent is gone');
});

// Breaks if release does not mark the key as not held before it touches the file: a failed removal would then keep a ghost slot for this process.
test('after a release whose removal failed, this process can take the slot again', async () => {
  const file = tmpFile();
  const deps = { pidAlive: alive, log: () => {}, sleep: async () => {} };
  const a = await acquireGrokSlot({ file, max: 1, lockWaitMs: 20, releaseAttempts: 1 }, deps);
  writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
  await a.release();
  rmSync(`${file}.lock`);
  assert.equal(readActive(file).length, 1, 'the failed release left the entry');
  const b = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, deps);
  assert.equal(b.ok, true);
});

// Finding: a lock miss or a state error during the wait must not end the wait and let the run spawn into a full gate.
test('a lock miss during the wait is retried until waitMs, then reported busy, never lock', async () => {
  const file = tmpFile();
  const c = clock((n) => { if (n === 1) writeFileSync(`${file}.lock`, `${process.pid} held-by-test`); });
  const live = { pid: 5, startedAt: c.now(), expiresAt: c.now() + 10 * 3_600_000 };
  writeFileSync(file, JSON.stringify({ active: [{ key: 'a', ...live }, { key: 'b', ...live }] }));
  const r = await acquireGrokSlot({ file, max: 2, waitMs: 1000, pollMs: 100, lockWaitMs: 20 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
  assert.equal(c.sleeps.length, 10, 'it kept polling for the whole wait');
  rmSync(`${file}.lock`, { force: true });
});

test('a lock miss during the wait that clears lets the waiter take the freed slot', async () => {
  const file = tmpFile();
  const holder = await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
  const c = clock((n) => {
    if (n === 1) writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
    if (n === 3) { rmSync(`${file}.lock`, { force: true }); holder.release(); }
  });
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 60_000, pollMs: 100, lockWaitMs: 20 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, true);
  assert.equal(c.sleeps.length, 3);
});

// Finding: readActive read every error as empty. Breaks if a non-ENOENT read error is swallowed (the next write would erase live slots).
test('a read error other than ENOENT is not read as an empty file and writes nothing', async () => {
  const file = tmpFile();
  const c = clock();
  const body = JSON.stringify({ active: [{ key: 'a', pid: 5, startedAt: c.now(), expiresAt: c.now() + 1e9 }] });
  writeFileSync(file, body);
  const busy = () => { throw Object.assign(new Error('resource busy'), { code: 'EBUSY' }); };
  const r = await acquireGrokSlot({ file, max: 2, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive, readFile: busy });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lock', 'a first-try state error means the gate cannot be used');
  assert.match(r.detail, /resource busy/);
  assert.equal(readFileSync(file, 'utf8'), body, 'the file is untouched');
  const missing = () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); };
  const again = await acquireGrokSlot({ file: tmpFile(), max: 2, waitMs: 0 }, { pidAlive: alive, readFile: missing });
  assert.equal(again.ok, true, 'ENOENT is an empty file');
});

test('a read error during the wait is retried, not turned into a spawn', async () => {
  const file = tmpFile();
  const c = clock();
  writeFileSync(file, JSON.stringify({ active: [{ key: 'a', pid: 5, startedAt: c.now(), expiresAt: c.now() + 1e9 }] }));
  let calls = 0;
  const flaky = (f, enc) => { calls += 1; if (calls === 2) throw Object.assign(new Error('scan'), { code: 'EPERM' }); return readFileSync(f, enc); };
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 500, pollMs: 100 }, { now: c.now, sleep: c.sleep, pidAlive: alive, readFile: flaky });
  assert.equal(r.reason, 'busy');
  assert.equal(c.sleeps.length, 5);
});

// Finding: expiry ignored the run's own timeout. Breaks if expiresAt is ignored or staleMs overrides it.
test('an entry lives until its expiresAt: a run past 3 h stays counted, an expired live pid is dropped', async () => {
  const file = tmpFile();
  const c = clock();
  const longRun = { key: 'long', pid: 7, startedAt: c.now() - 4 * 3_600_000, expiresAt: c.now() + 3_600_000 };
  const expired = { key: 'expired', pid: 8, startedAt: c.now() - 1000, expiresAt: c.now() - 1 };
  writeFileSync(file, JSON.stringify({ active: [longRun, expired] }));
  const r = await acquireGrokSlot({ file, max: 2, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.ok, true, 'the expired entry freed a slot');
  assert.equal(readActive(file).some((e) => e.key === 'expired'), false);
  assert.equal(readActive(file).some((e) => e.key === 'long'), true);
  const third = await acquireGrokSlot({ file, max: 2, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(third.reason, 'busy', 'the 4 h old run still holds its slot');
});

test('opts.ttlMs sets the new entry expiresAt', async () => {
  const file = tmpFile();
  const c = clock();
  await acquireGrokSlot({ file, max: 1, ttlMs: 5000 }, { now: c.now, pidAlive: alive });
  const [e] = readActive(file);
  assert.equal(e.startedAt, c.now());
  assert.equal(e.expiresAt, c.now() + 5000);
});

// Finding: the slot followed the node parent only. Breaks if attach() is not stored or liveness ignores childPid.
test('attach records the agent pid; the slot stays taken while only the agent pid runs, and frees when it dies', async () => {
  const file = tmpFile();
  const c = clock();
  const slot = await acquireGrokSlot({ file, max: 1, ttlMs: 1e9 }, { now: c.now, pidAlive: alive });
  assert.equal(slot.attach(9001), true);
  const entry = readActive(file)[0];
  assert.equal(entry.childPid, 9001);
  writeFileSync(file, JSON.stringify({ active: [{ ...entry, pid: 123456 }] })); // another session sees a dead parent
  const blocked = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (pid) => pid === 9001 });
  assert.equal(blocked.reason, 'busy', 'the live agent pid keeps the slot');
  const bothGone = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: () => false });
  assert.equal(bothGone.ok, true);
});

// Breaks if release removes the entry of an agent that outlived the run (a failed kill): the next run would join a loaded account.
test('release keeps the slot of an agent pid that still runs, and frees it when the agent is gone', async () => {
  const file = tmpFile();
  const c = clock();
  const slot = await acquireGrokSlot({ file, max: 1, ttlMs: 1e9 }, { now: c.now, pidAlive: alive });
  slot.attach(9002);
  await slot.release();
  const [e] = readActive(file);
  assert.equal(e.childPid, 9002);
  assert.equal(e.pid, 0, 'the entry no longer follows this process');
  const next = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p === 9002 || p === process.pid });
  assert.equal(next.reason, 'busy');
  const freed = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p === process.pid });
  assert.equal(freed.ok, true, 'it frees when the agent is gone');
});

// CodeRabbit CLI Minor on 5adf6c0. Breaks if the orphan release does not write childPid: an attach that never
// reached the file leaves an entry with pid 0 and no childPid, which the next take prunes while the agent runs.
test('an orphan release writes the agent pid even when attach did not persist it', async () => {
  const file = tmpFile();
  const c = clock();
  const slot = await acquireGrokSlot({ file, max: 1, ttlMs: 1e9 }, { now: c.now, pidAlive: alive });
  slot.attach(9003);
  const [entry] = readActive(file);
  const { childPid: _lost, ...withoutChild } = entry;
  writeFileSync(file, JSON.stringify({ active: [withoutChild] })); // the attach write was lost
  await slot.release();
  const [e] = readActive(file);
  assert.equal(e.childPid, 9003);
  const next = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p === 9003 || p === process.pid });
  assert.equal(next.reason, 'busy', 'the running agent keeps its slot');
});

test('release removes the entry when the agent pid is gone', async () => {
  const file = tmpFile();
  const slot = await acquireGrokSlot({ file, max: 1 }, { pidAlive: (p) => p !== 9003 });
  slot.attach(9003);
  await slot.release();
  assert.deepEqual(readActive(file), []);
});

// Finding: no FIFO. Breaks if a newcomer can take a freed slot ahead of an earlier waiter.
test('first come, first served: a newcomer does not pass a waiter when a slot frees', async () => {
  const file = tmpFile();
  const holder = await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
  const t = { v: 1_000_000 };
  const now = () => t.v;
  let bResult;
  let polls = 0;
  const aSlot = await acquireGrokSlot({ file, max: 1, waitMs: 10_000, pollMs: 100 }, {
    now, pidAlive: alive,
    sleep: async () => {
      polls += 1;
      t.v += 100;
      if (polls === 1) {
        holder.release();
        // B arrives after the release and before A polls again: it must not take the free slot.
        bResult = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now, pidAlive: alive });
      }
    },
  });
  assert.equal(aSlot.ok, true, 'A, queued first, took the slot');
  assert.equal(bResult.ok, false);
  assert.equal(bResult.reason, 'busy', 'B waited behind A');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).waiting, [], 'neither is left in the waiting list');
});

// Breaks if a waiter that gives up stays in the list: it would block every later caller until it expires.
test('a waiter that gives up leaves the waiting list; a dead waiter is pruned', async () => {
  const file = tmpFile();
  const c = clock();
  await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 300, pollMs: 100 }, { now: c.now, sleep: c.sleep, pidAlive: alive });
  assert.equal(r.reason, 'busy');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).waiting, []);
  writeFileSync(file, JSON.stringify({ active: [], waiting: [{ key: 'ghost', pid: 4444, enqueuedAt: c.now() - 5, expiresAt: c.now() + 1e9 }] }));
  const next = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { now: c.now, sleep: c.sleep, pidAlive: (p) => p !== 4444 });
  assert.equal(next.ok, true, 'a waiter with a dead pid does not block');
});

// Breaks if CCV3_GROK_MAX_CONCURRENT is not read, or an invalid value is not replaced by 2.
test('max comes from CCV3_GROK_MAX_CONCURRENT; an invalid value means 2', async () => {
  const one = tmpFile();
  const deps1 = { pidAlive: alive, env: { CCV3_GROK_MAX_CONCURRENT: '1' } };
  assert.equal((await acquireGrokSlot({ file: one, waitMs: 0 }, deps1)).ok, true);
  assert.equal((await acquireGrokSlot({ file: one, waitMs: 0 }, deps1)).reason, 'busy');
  for (const bad of ['abc', '0', '-3', '1.5', '']) {
    const f = tmpFile();
    const deps = { pidAlive: alive, env: { CCV3_GROK_MAX_CONCURRENT: bad } };
    assert.equal((await acquireGrokSlot({ file: f, waitMs: 0 }, deps)).ok, true, bad);
    assert.equal((await acquireGrokSlot({ file: f, waitMs: 0 }, deps)).ok, true, `${bad}: second`);
    assert.equal((await acquireGrokSlot({ file: f, waitMs: 0 }, deps)).reason, 'busy', `${bad}: third`);
  }
});

// Breaks if CCV3_GROK_SLOTS_FILE is not read: tests and probes would write to the real ~/.claude/state.
test('the state file comes from CCV3_GROK_SLOTS_FILE', async () => {
  const file = tmpFile();
  const r = await acquireGrokSlot({}, { pidAlive: alive, env: { CCV3_GROK_SLOTS_FILE: file } });
  assert.equal(r.ok, true);
  assert.equal(readActive(file).length, 1);
  r.release();
});

// Breaks if a corrupt state file wedges the gate instead of reading as empty.
test('a corrupt state file reads as empty', async () => {
  const file = tmpFile();
  writeFileSync(file, '{not json');
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 0 }, { pidAlive: alive });
  assert.equal(r.ok, true);
});

// The real thing: three node processes, one state file, max 2. Breaks if the take is not atomic across processes
// (three overlap) or if the third does not wait for a release.
test('three real processes with max 2 never hold more than 2 at once, and the third waits', { timeout: 60_000 }, async () => {
  const file = tmpFile();
  const child = path.join(path.dirname(file), 'child.mjs');
  const mod = pathToFileURL(path.join(HERE, 'grok-slots.mjs')).href;
  writeFileSync(child, [
    `import { acquireGrokSlot } from ${JSON.stringify(mod)};`,
    `const asked = Date.now();`,
    `const slot = await acquireGrokSlot({ file: ${JSON.stringify(file)}, max: 2, waitMs: 40000, pollMs: 50 });`,
    `if (!slot.ok) { console.log(JSON.stringify({ ok: false, reason: slot.reason })); process.exit(0); }`,
    `const acquired = Date.now();`,
    `await new Promise((r) => setTimeout(r, 1500));`,
    `const released = Date.now();`,
    `slot.release();`,
    `console.log(JSON.stringify({ ok: true, asked, acquired, released }));`,
  ].join('\n'));
  const runChild = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`child exit ${code}: ${err}`))));
  });
  const runs = await Promise.all([runChild(), runChild(), runChild()]);
  assert.equal(runs.every((r) => r.ok), true, JSON.stringify(runs));
  const events = runs.flatMap((r) => [{ t: r.acquired, d: 1 }, { t: r.released, d: -1 }]).sort((x, y) => x.t - y.t || x.d - y.d);
  let held = 0;
  let peak = 0;
  for (const e of events) { held += e.d; peak = Math.max(peak, held); }
  assert.ok(peak <= 2, `at most 2 held at once, saw ${peak}`);
  assert.equal(peak, 2, 'two did run together, so the test saw real concurrency');
  const byAcquire = [...runs].sort((x, y) => x.acquired - y.acquired);
  const firstRelease = Math.min(...runs.map((r) => r.released));
  assert.ok(byAcquire[2].acquired >= firstRelease, 'the third took its slot only after a release');
  assert.ok(byAcquire[2].acquired - byAcquire[2].asked >= 500, 'the third waited');
  assert.equal(existsSync(file) ? readActive(file).length : 0, 0, 'every slot was released');
});

// Breaks if the wait loop logs nothing (a 60 min wait looks like a hang) or logs every poll (240 lines for 60 min).
test('a waiting caller logs when it starts to wait and about once a minute after, with the slots busy and the time waited', async () => {
  const file = tmpFile();
  const holder = await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
  assert.equal(holder.ok, true);
  const c = clock();
  const logs = [];
  const r = await acquireGrokSlot({ file, max: 1, waitMs: 300_000, pollMs: 15_000 }, { now: c.now, sleep: c.sleep, pidAlive: alive, log: (m) => logs.push(m) });
  assert.equal(r.reason, 'busy');
  assert.equal(logs.length, 5, 'waited 0, 60, 120, 180 and 240 s of 300 s');
  assert.match(logs[0], /1 of 1 slots busy.*waited 0 s of 300 s/);
  assert.match(logs[4], /waited 240 s of 300 s/);
  holder.release();
});

// Breaks if the log is written before the first take: a free slot must stay silent.
test('a caller that gets a slot at once logs nothing', async () => {
  const logs = [];
  const r = await acquireGrokSlot({ file: tmpFile(), max: 1, waitMs: 60_000 }, { pidAlive: alive, log: (m) => logs.push(m) });
  assert.equal(r.ok, true);
  assert.deepEqual(logs, []);
  r.release();
});

// Breaks if CCV3_GROK_WAIT_MIN is not read, a bad value is not replaced by the default, or opts.waitMs stops winning over the env.
test('the max wait comes from CCV3_GROK_WAIT_MIN; a bad value means the default; opts.waitMs wins', async () => {
  const waitedWith = async (env, opts = {}) => {
    const file = tmpFile();
    const holder = await acquireGrokSlot({ file, max: 1 }, { pidAlive: alive });
    const c = clock();
    const r = await acquireGrokSlot({ file, max: 1, pollMs: 60_000, ...opts }, { now: c.now, sleep: c.sleep, pidAlive: alive, env, log: () => {} });
    holder.release();
    assert.equal(r.reason, 'busy');
    return r.waitedMs;
  };
  assert.equal(await waitedWith({ CCV3_GROK_WAIT_MIN: '2' }), 120_000);
  assert.equal(await waitedWith({ CCV3_GROK_WAIT_MIN: '2' }, { waitMs: 60_000 }), 60_000);
  for (const bad of ['abc', '-1', '1.5', '', '0x10']) assert.equal(await waitedWith({ CCV3_GROK_WAIT_MIN: bad }), DEFAULT_WAIT_MS, bad);
});

// Finding (CodeRabbit PR 271): a CCV3_GROK_WAIT_MIN with enough digits to overflow Number gave Infinity, so the wait never ended.
// Breaks if resolveWaitMs lets a non-finite or timer-breaking value through.
test('an env wait that overflows or is too long for a timer means the default', () => {
  assert.equal(resolveWaitMs({}, { CCV3_GROK_WAIT_MIN: '9'.repeat(400) }), DEFAULT_WAIT_MS);
  assert.equal(resolveWaitMs({}, { CCV3_GROK_WAIT_MIN: '99999999' }), DEFAULT_WAIT_MS);
  assert.equal(resolveWaitMs({}, { CCV3_GROK_WAIT_MIN: '180' }), 180 * 60_000);
});
