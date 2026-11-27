// A cross-process file lock for small state files (ledgers, queues).
// Shared by cursor-review.mjs, the local review engine and the free-slot queue.
//
// The lock is `<file>.lock`, created with 'wx'. It holds "<pid> <token>".
// - A lock older than lockStaleMs is taken over only when its owner process is gone
//   (or the file names no pid, as locks written before 2026-11-02 do). A slow live holder keeps its lock.
// - Release deletes the lock only while it still holds this holder's token, so a former holder
//   never deletes a replacement lock.
// - Every retry path sleeps and respects lockWaitMs. An unreadable or undeletable lock counts as held.
// - A takeover runs under a mutex, `<lock>.takeover`, created with 'wx' and holding "<pid> <token>".
//   A taker that cannot get the mutex does not touch the lock. The taker that holds it judges the lock
//   stale AGAIN, then unlinks it, then releases the mutex (only while it still holds its own token).
//   The lock never changes while the mutex is held: other takers wait outside, a dead owner cannot release,
//   and a fresh acquirer's 'wx' fails while the stale lock exists. After the unlink, 'wx' picks one winner.
//   No live lock is ever moved, so there is no gap in which the lock path is absent while its owner runs.
// - A mutex whose owner pid is gone and which is older than MUTEX_STALE_MS is removed by the next taker.
// Known limit: that removal is itself a read-then-unlink. It needs a taker that crashed inside the few
// syscalls between its mutex create and release, then two other processes that judge that dead mutex stale
// in the same gap, then a third event between their steps. The earlier rename design needed only two live
// takers and one fresh acquirer, so this window is far smaller and needs a crash.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

const MUTEX_STALE_MS = 2000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readLock = (lock) => { try { return readFileSync(lock, 'utf8'); } catch { return null; } };

/** True when pid names a process that still runs. EPERM means it runs under another user. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** A lock may be taken over when it is older than lockStaleMs and its owner is gone. */
function staleContent(lock, lockStaleMs) {
  const st = statSync(lock); // throws when the lock vanished: the caller retries
  if (Date.now() - st.mtimeMs <= lockStaleMs) return null;
  if (!st.isFile()) return null; // a folder or other object at the lock path is never removed
  const content = readLock(lock);
  if (content === null) return null;
  const pid = Number.parseInt(content.split(' ')[0], 10);
  return pidAlive(pid) ? null : content;
}

/** Creates `path` with 'wx' and writes the token. Throws EEXIST when the file exists. */
function createExclusive(path, token) {
  const fd = openSync(path, 'wx');
  try { writeSync(fd, token); } finally { closeSync(fd); }
}

/** Removes a takeover mutex whose owner is gone. Its content must be unchanged since the stale judgement. */
function clearDeadMutex(mutex) {
  const dead = staleContent(mutex, MUTEX_STALE_MS);
  if (dead !== null && readLock(mutex) === dead) unlinkSync(mutex);
}

/** Removes the lock when it is stale, under the takeover mutex. Returns true when this process removed it. */
function takeOver(lock, lockStaleMs) {
  const mutex = `${lock}.takeover`;
  const token = `${process.pid} ${randomUUID()}`;
  try { createExclusive(mutex, token); } catch (err) {
    if (err.code === 'EEXIST') clearDeadMutex(mutex);
    return false; // another taker is at work: leave the lock alone and retry
  }
  try {
    if (staleContent(lock, lockStaleMs) === null) return false; // a fresh lock replaced the one judged stale
    unlinkSync(lock);
    return true;
  } finally {
    try { if (readLock(mutex) === token) unlinkSync(mutex); } catch { /* already gone */ }
  }
}

/**
 * Runs fn while holding `<file>.lock` and returns its value.
 * Returns { ok: false, reason: 'lock', detail } when the lock stays held past lockWaitMs; fn does not run.
 * An open error other than EEXIST (for example a missing folder) is thrown.
 */
export function withLock(file, { lockWaitMs = 5000, lockStaleMs = 30_000 } = {}, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  const began = Date.now();
  for (;;) {
    try {
      createExclusive(lock, token);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let taken = false;
      try { // the cheap judgement filters; takeOver judges again under the mutex
        taken = staleContent(lock, lockStaleMs) !== null && takeOver(lock, lockStaleMs);
      } catch { /* the lock vanished: wait and retry below */ }
      if (taken) continue;
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: 'lock', detail: `the lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try { return fn(); } finally {
    try { if (readLock(lock) === token) unlinkSync(lock); } catch { /* already gone */ }
  }
}
