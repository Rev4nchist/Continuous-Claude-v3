/**
 * Atomic Write Utilities for Claude Code Hooks
 *
 * Prevents state corruption from:
 * - Crash during write (partial JSON)
 * - Race conditions between terminals (concurrent writes)
 *
 * Strategy:
 * - atomicWriteSync: write to temp file, then rename (atomic on POSIX/NTFS)
 * - acquireLockSync: O_EXCL lock file with stale detection
 * - writeStateWithLock: combined atomic + locked write
 *
 * Usage:
 *   import { writeStateWithLock, readStateWithLock } from './shared/atomic-write.js';
 *   writeStateWithLock(stateFilePath, JSON.stringify(state, null, 2));
 */

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  constants,
} from 'fs';
import { dirname, basename, join } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('atomic-write');

const LOCK_STALE_MS = 10_000; // Lock older than 10s is considered stale
const LOCK_RETRY_MS = 50;     // Retry interval when waiting for lock
const LOCK_TIMEOUT_MS = 5_000; // Max time to wait for lock

/**
 * Write a file atomically: write to temp, then rename.
 * If the process crashes mid-write, the original file is untouched.
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpFile = join(dir, `.${basename(filePath)}.tmp.${process.pid}`);

  try {
    writeFileSync(tmpFile, content, 'utf-8');
    renameSync(tmpFile, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

/** Lock directories already reported in this process: one warn row per directory. */
const missingLockDirsLogged = new Set<string>();

function warnLockDirMissing(lockFile: string): void {
  const dir = dirname(lockFile);
  if (missingLockDirsLogged.has(dir)) return;
  missingLockDirsLogged.add(dir);
  log.warn('Lock dir missing, lock not acquired', { lockFile, dir });
}

/**
 * Acquire an exclusive lock file.
 * Uses O_EXCL (create-only) flag — fails if lock already exists.
 * Includes stale lock detection: if lock file is older than LOCK_STALE_MS, remove it.
 *
 * @returns true if lock acquired, false if timed out
 */
export function acquireLockSync(filePath: string, timeoutMs: number = LOCK_TIMEOUT_MS): boolean {
  const lockFile = filePath + '.lock';
  const startTime = Date.now();

  while (true) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if file exists
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      // Write PID for debugging
      writeFileSync(fd, `${process.pid}\n${Date.now()}`, 'utf-8');
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock exists — check if stale
        try {
          const stat = statSync(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn('Removing stale lock', { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync(lockFile);
            continue; // Retry immediately after removing stale lock
          }
        } catch {
          // Lock file disappeared between check and stat — retry
          continue;
        }

        // Lock is fresh — wait and retry
        if (Date.now() - startTime > timeoutMs) {
          log.error('Lock acquisition timed out', { lockFile, timeoutMs });
          return false;
        }

        // Busy wait (synchronous context — no setTimeout available)
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) { /* spin */ }
      } else if (err.code === 'ENOENT') {
        // The lock directory does not exist (a session started in a folder with no .claude/cache).
        // Do not create it under an arbitrary cwd. Callers see the same "not acquired" result.
        warnLockDirMissing(lockFile);
        return false;
      } else {
        // Unexpected error
        log.error('Lock acquisition failed', { lockFile, error: String(err) });
        return false;
      }
    }
  }
}

/**
 * Release a lock file.
 */
export function releaseLockSync(filePath: string): void {
  const lockFile = filePath + '.lock';
  try {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn('Failed to release lock', { lockFile, error: String(err) });
  }
}

/**
 * Write state with both locking and atomic write.
 * This is the primary API for hooks writing state files.
 *
 * If the lock cannot be acquired, falls back to direct atomic write
 * (better than losing state entirely).
 */
export function writeStateWithLock(filePath: string, content: string): void {
  const locked = acquireLockSync(filePath);

  try {
    atomicWriteSync(filePath, content);
  } catch (err) {
    log.error('State write failed', { filePath, error: String(err) });
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

/**
 * Options for mutateStateWithLock (WS-2 Phase B.0). All optional and fully
 * backward-compatible: omitting the bag (or passing `{}`) reproduces the
 * pre-B.0 behavior exactly -- a 5000ms lock wait and no instrumentation -- so
 * existing callers (writeStateWithLock, etc.) are byte-for-behavior identical.
 */
export interface MutateLockOptions {
  /**
   * Max time to wait for the lock, passed straight to acquireLockSync. DEFAULT
   * STAYS LOCK_TIMEOUT_MS (5000) so existing callers are unchanged; a caller
   * that needs a tight cap (e.g. the context bus at 200ms) sets this.
   */
  lockTimeoutMs?: number;
  /**
   * Fired ALWAYS, on BOTH the success and the timeout path, with the acquire
   * result and how long the wait took. This is how a caller observes a dropped
   * (lock-timeout) write instead of it being silent.
   */
  onLockOutcome?: (o: { acquired: boolean; wait_ms: number }) => void;
  /** Fired on the SUCCESS path only, with the atomic-write duration. */
  onWriteTiming?: (o: { write_ms: number }) => void;
}

/**
 * Read-modify-write a state file with the ENTIRE read -> apply -> write
 * sequence performed under a SINGLE lock hold. This is the race-free primitive:
 * unlike `read; then writeStateWithLock`, no other writer can slip in between
 * the read and the write, so there is no lost-update / TOCTOU window.
 *
 * Contract:
 *  - Acquires the lock ONCE (same lock file as writeStateWithLock, so the two
 *    are mutually exclusive on the same path). The wait is bounded by
 *    opts.lockTimeoutMs (default LOCK_TIMEOUT_MS = 5000, unchanged).
 *  - Reads the current file content INSIDE the lock. A genuinely-absent file
 *    (ENOENT) yields `null`. A file that EXISTS but cannot be read (EBUSY /
 *    EACCES / EPERM, etc.) is a TRANSIENT failure: the read error is rethrown
 *    to the caller's transform via the `current` argument being unavailable --
 *    instead we surface it by throwing, which mutateStateWithLock catches and
 *    turns into a safe no-op (returns false) so existing-but-unreadable state is
 *    never clobbered with derived-from-empty content.
 *  - Calls `transformFn(current)`. Returning a string writes it atomically
 *    (temp + rename) inside the same lock hold. Returning `null` is a NO-OP:
 *    nothing is written (the caller decided the current state must be left as-is).
 *  - Releases the lock in `finally`, always.
 *
 * Observability (B.0): opts.onLockOutcome fires ALWAYS with { acquired, wait_ms }
 * (success AND timeout), and opts.onWriteTiming fires on the success path with
 * { write_ms }. Both are no-ops when undefined -> zero cost for existing callers.
 *
 * Fail-open: never throws. On lock-acquire failure, a read failure of an
 * existing file, or a throwing transform, it returns `false` (no write) rather
 * than risk corrupting or erasing state.
 *
 * @returns true if a write happened, false if it was a no-op / safe abort.
 */
export function mutateStateWithLock(
  filePath: string,
  transformFn: (current: string | null) => string | null,
  opts: MutateLockOptions = {},
): boolean {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;

  const lockStart = Date.now();
  const locked = acquireLockSync(filePath, lockTimeoutMs);
  const waitMs = Date.now() - lockStart;

  // Report the acquire outcome ALWAYS (success or timeout). A failing callback
  // must never break the write path.
  if (opts.onLockOutcome) {
    try {
      opts.onLockOutcome({ acquired: locked, wait_ms: waitMs });
    } catch {
      /* observability must never throw into the write path */
    }
  }

  if (!locked) {
    // Could not get the lock -> do NOT write blind (that is exactly the clobber
    // we are preventing). Safe abort.
    log.warn('mutateStateWithLock: lock not acquired, skipping write', { filePath });
    return false;
  }

  try {
    // Read current content under the lock. Distinguish genuinely-absent (null)
    // from a read FAILURE of a file that exists (transient -> safe abort).
    let current: string | null;
    if (!existsSync(filePath)) {
      current = null; // ENOENT: legitimate empty case
    } else {
      try {
        current = readFileSync(filePath, 'utf-8');
      } catch (err) {
        // File exists but is unreadable right now (EBUSY/EACCES/EPERM). Do NOT
        // overwrite it with anything derived from "empty" -- abort safely.
        log.warn('mutateStateWithLock: existing file unreadable, aborting write', {
          filePath,
          error: String(err),
        });
        return false;
      }
    }

    let next: string | null;
    try {
      next = transformFn(current);
    } catch (err) {
      // A throwing transform must never corrupt the file.
      log.error('mutateStateWithLock: transform threw, leaving file untouched', {
        filePath,
        error: String(err),
      });
      return false;
    }

    if (next == null) {
      return false; // transform chose a no-op
    }

    const writeStart = Date.now();
    atomicWriteSync(filePath, next);
    if (opts.onWriteTiming) {
      try {
        opts.onWriteTiming({ write_ms: Date.now() - writeStart });
      } catch {
        /* observability must never throw into the write path */
      }
    }
    return true;
  } catch (err) {
    log.error('mutateStateWithLock: write failed', { filePath, error: String(err) });
    return false;
  } finally {
    releaseLockSync(filePath);
  }
}

/**
 * Read state with locking to prevent reading mid-write.
 * Falls back to direct read if lock can't be acquired.
 */
export function readStateWithLock(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  const locked = acquireLockSync(filePath, 2000); // Shorter timeout for reads

  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    log.error('State read failed', { filePath, error: String(err) });
    return null;
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}
