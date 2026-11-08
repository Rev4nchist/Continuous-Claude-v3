/**
 * D13: a lock whose directory does not exist (a session started in a folder with no `.claude/cache`)
 * must not log at error level. The doctor counts level === 'error' rows in hooks.log.
 *
 * How it can fail, and the test that catches it:
 *   - ENOENT on the lock dir still logs error                      -> L1
 *   - the lock dir is created under the arbitrary cwd              -> L1
 *   - the result changes (callers expect false / skipped write)    -> L1, L2
 *   - the warn row repeats on every call in one process            -> L3
 *   - real contention stops logging at error level                 -> L4
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logged: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
vi.mock('../shared/logger.js', () => {
  const mk = (level: string) => (msg: string, data?: Record<string, unknown>) => { logged.push({ level, msg, data }); };
  return { createLogger: () => ({ debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') }) };
});

import { acquireLockSync, mutateStateWithLock, writeStateWithLock } from '../shared/atomic-write.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccv3-lockdir-'));
  logged.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('acquireLockSync: lock directory missing', () => {
  it('L1: returns false, logs no error, creates no directory', () => {
    const missing = join(root, '.claude', 'cache', 'session', 'abc');
    const target = join(missing, 'context.json');
    expect(acquireLockSync(target)).toBe(false);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    const warn = logged.filter((l) => l.level === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0].msg).toMatch(/lock dir missing/i);
    expect(warn[0].data?.lockFile).toBe(target + '.lock');
  });

  it('L2: mutateStateWithLock still skips the write and returns false', () => {
    const target = join(root, 'gone', 'state.json');
    let called = false;
    const ok = mutateStateWithLock(target, () => { called = true; return '{}'; });
    expect(ok).toBe(false);
    expect(called).toBe(false);
    expect(logged.some((l) => l.msg.includes('lock not acquired, skipping write'))).toBe(true);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
    expect(existsSync(join(root, 'gone'))).toBe(false);
    // writeStateWithLock keeps its old behaviour: the atomic write then fails and logs its own error row.
    writeStateWithLock(join(root, 'gone2', 'state.json'), '{}');
    expect(existsSync(join(root, 'gone2'))).toBe(false);
  });

  it('L3: warns once per directory in one process', () => {
    const target = join(root, 'nodir', 'a.json');
    acquireLockSync(target);
    acquireLockSync(target);
    acquireLockSync(join(root, 'nodir', 'b.json'));
    expect(logged.filter((l) => l.level === 'warn' && /lock dir missing/i.test(l.msg))).toHaveLength(1);
  });
});

describe('acquireLockSync: real failures keep the error log', () => {
  it('L4: a held lock that times out still logs at error level', () => {
    const target = join(root, 'state.json');
    writeFileSync(target + '.lock', 'held');
    expect(acquireLockSync(target, 60)).toBe(false);
    expect(logged.some((l) => l.level === 'error' && /timed out/i.test(l.msg))).toBe(true);
  });
});
