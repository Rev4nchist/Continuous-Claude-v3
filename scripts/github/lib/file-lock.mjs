// A cross-process file lock for small state files (ledgers, queues).
// Shared by cursor-review.mjs, the local review engine and the free-slot queue.
//
// The lock is `<file>.lock`, created with 'wx'. It holds "<pid> <token>".
// - A lock older than lockStaleMs is taken over only when its owner process is gone
//   (or the file names no pid, as locks written before 2026-11-02 do). A slow live holder keeps its lock.
// - Release deletes the lock only while it still holds this holder's token, so a former holder
//   never deletes a replacement lock.
// - Every retry path sleeps and respects lockWaitMs. An unreadable or undeletable lock counts as held.
// Known limit: two processes that judge the same dead lock stale at the same instant can race on the
// takeover. Each re-reads the lock and takes over only when it still holds the content it judged stale.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

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
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, token); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let taken = false;
      try {
        const stale = staleContent(lock, lockStaleMs);
        if (stale !== null && readLock(lock) === stale) { unlinkSync(lock); taken = true; }
      } catch { /* the lock vanished or cannot be removed: wait and retry below */ }
      if (taken) continue;
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: 'lock', detail: `the lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try { return fn(); } finally {
    try { if (readLock(lock) === token) unlinkSync(lock); } catch { /* already gone */ }
  }
}
