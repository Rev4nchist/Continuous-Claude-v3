// A cross-process file lock for small state files (ledgers, queues).
// Moved unchanged from cursor-review.mjs so the review engine and the free-slot queue share one lock.
// The lock is `<file>.lock`, created with 'wx'. A lock older than lockStaleMs is taken over.
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs fn while holding `<file>.lock` and returns its value.
 * Returns { ok: false, reason: 'lock', detail } when another holder keeps the lock past lockWaitMs; fn does not run.
 * An open error other than EEXIST (for example a missing folder) is thrown.
 */
export function withLock(file, { lockWaitMs = 5000, lockStaleMs = 30_000 } = {}, fn) {
  const lock = `${file}.lock`;
  const began = Date.now();
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > lockStaleMs) { unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: 'lock', detail: `the lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}
