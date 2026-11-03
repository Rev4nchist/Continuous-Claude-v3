// Tests for lock.mjs: pid reuse (L-lock) and the rename takeover. They use real files in a temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, unlockRun } from './lock.mjs';

const STARTED = '2026-11-02T12:00:00.000Z';
const T0 = Date.parse(STARTED);

function lockFile(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-lock-'));
  const file = path.join(dir, 'run.lock');
  if (body !== undefined) writeFileSync(file, JSON.stringify(body));
  return file;
}
const strays = (file) => readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file));

// Breaks if: a live pid with a later start time keeps the lock (the original owner died and the OS reused its pid).
test('L-lock: a live pid that started after the lock was written is a reused pid and the lock is replaced', () => {
  const file = lockFile({ pid: 4242, started: STARTED, runId: 'old' });
  const r = acquireLock(file, { pid: 1, started: 'now' }, { alive: () => true, processStart: () => T0 + 60_000 });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 1);
});

// Breaks if: the start check replaces a lock whose owner really runs, or runs without a start-time source.
test('L-lock: a live owner keeps the lock when its start time matches, is unknown, or no source is given', () => {
  const body = { pid: 4242, started: STARTED };
  for (const deps of [
    { alive: () => true, processStart: () => T0 - 800 },
    { alive: () => true, processStart: () => null },
    { alive: () => true, processStart: () => { throw new Error('no access'); } },
    { alive: () => true },
  ]) {
    const file = lockFile(body);
    const r = acquireLock(file, { pid: 1 }, deps);
    assert.deepEqual(r, { ok: false, pid: 4242 });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 4242);
  }
});

// Breaks if: --unlock keeps a lock whose pid was reused.
test('L-lock: --unlock removes a lock whose pid was reused, and keeps one whose owner matches', () => {
  const reused = lockFile({ pid: 4242, started: STARTED });
  assert.equal(unlockRun(reused, { alive: () => true, processStart: () => T0 + 60_000 }).state, 'removed');
  assert.equal(existsSync(reused), false);
  const owner = lockFile({ pid: 4242, started: STARTED });
  assert.equal(unlockRun(owner, { alive: () => true, processStart: () => T0 }).state, 'held');
  assert.equal(existsSync(owner), true);
});

// Breaks if: a takeover unlinks whatever is at the path after the stale text was read. The fake rename lets a rival
// create a fresh lock for a live owner in the window between the stale judgement and the move.
test('L-lock: a lock replaced in the takeover window is put back and the caller does not get the lock', () => {
  const file = lockFile({ pid: 7 });
  const rival = JSON.stringify({ pid: 9999, started: STARTED });
  const racing = (from, to) => { writeFileSync(from, rival); renameSync(from, to); };
  const r = acquireLock(file, { pid: 1 }, { alive: (pid) => pid === 9999, rename: racing });
  assert.deepEqual(r, { ok: false, pid: 9999 });
  assert.equal(readFileSync(file, 'utf8'), rival);
  assert.deepEqual(strays(file), []);
});

// Breaks if: the takeover leaves its renamed copy behind, or release removes a lock it does not own.
test('L-lock: a takeover leaves no stray file, and release removes only the lock it wrote', () => {
  const file = lockFile({ pid: 7 });
  const mine = acquireLock(file, { pid: 1, token: 'mine' }, { alive: () => false });
  assert.equal(mine.ok, true);
  assert.deepEqual(strays(file), []);
  writeFileSync(file, JSON.stringify({ pid: 2, token: 'other' }));
  mine.release();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'other');
  assert.deepEqual(strays(file), []);
});
