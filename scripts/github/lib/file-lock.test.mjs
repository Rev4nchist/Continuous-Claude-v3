// Tests for scripts/github/lib/file-lock.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/lib/file-lock.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { withLock } from './file-lock.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'file-lock-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

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

// Breaks if every open error is treated as "held" (it would spin until the wait time, then report a false lock).
test('an error other than EEXIST is thrown, not reported as a held lock', () => {
  const file = path.join(tmp(), 'no-such-dir', 'state.json');
  assert.throws(() => withLock(file, { lockWaitMs: 60 }, () => 'never'), { code: 'ENOENT' });
});
