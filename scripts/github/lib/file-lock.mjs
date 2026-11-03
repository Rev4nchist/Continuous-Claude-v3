// A cross-process file lock for small state files (ledgers, queues).
// Shared by cursor-review.mjs, the local review engine and the free-slot queue.
//
// The lock is `<file>.lock`, created with 'wx'. It holds "<pid> <token>".
// - A lock older than lockStaleMs is taken over only when its owner process is gone
//   (or the file names no pid, as locks written before 2026-11-02 do). A slow live holder keeps its lock.
// - Release deletes the lock only while it still holds this holder's token, so a former holder
//   never deletes a replacement lock.
// - Every retry path sleeps and respects lockWaitMs. An unreadable or undeletable lock counts as held.
// - A takeover is exclusive. The taker renames the stale lock to a unique tombstone `<lock>.<uuid>.stale`.
//   A rename of one source succeeds for one process only; the others get ENOENT and retry. The taker then
//   checks that the tombstone holds the stale content it judged. If a live lock had replaced the stale one,
//   the taker hard-links it back (link fails rather than overwrites) and treats the lock as held.
// Known limits. They need a stale judgement, a full takeover by another process inside the read-to-rename gap,
// and then a second event inside the few syscalls between the rename and the restore. The lock is absent then:
// - A third process creates a lock in that gap. The restore fails with EEXIST, so the stolen holder runs fn
//   with no lock on disk, beside the new holder (an overlap).
// - The stolen holder releases in that gap. Its release finds no lock. The restore then leaves an orphan lock
//   with a live pid, which nobody can take over until that process exits (a liveness stall).
// The restore needs hard links (NTFS and POSIX have them; FAT and some network shares do not).
import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';

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

/** Removes the lock when it still holds `stale`. Returns true for the one process that removed it. */
function takeOver(lock, stale) {
  const tomb = `${lock}.${randomUUID()}.stale`;
  try { renameSync(lock, tomb); } catch { return false; } // ENOENT: another taker won, or the owner released
  try {
    if (readLock(tomb) === stale) return true;
    linkSync(tomb, lock); // not the lock we judged: put it back. EEXIST means a newer lock exists; keep that one.
  } catch { /* the lock could not be restored: it stays gone */ } finally {
    try { unlinkSync(tomb); } catch { /* the tombstone is already gone */ }
  }
  return false;
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
        taken = stale !== null && takeOver(lock, stale);
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
