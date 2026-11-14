/**
 * shared/claim-warned.ts (card coord-file-claims-all-writers, review F12).
 *
 * Ways it can fail (one test each):
 *  1. The second call for the same session, project and path warns again.
 *  2. Two projects with the same relative path share one warning (the key must hold the project).
 *  3. A new session is silenced by another session's state.
 *  4. State files older than 7 days are never removed.
 *  5. An unwritable state folder hides the warning (it must warn).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { firstWarning } from '../shared/claim-warned.js';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claim-warned-'));
  saved = process.env.CCV3_FILE_CLAIMS_STATE_DIR;
  process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(dir, 'state');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_FILE_CLAIMS_STATE_DIR;
  else process.env.CCV3_FILE_CLAIMS_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('firstWarning', () => {
  it('warns once per session, project and path', () => {
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(true);
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(false);
  });
  it('the same relative path in another project warns again', () => {
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(true);
    expect(firstWarning('s1', 'p2', 'src/a.ts')).toBe(true);
  });
  it('another session warns again', () => {
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(true);
    expect(firstWarning('s2', 'p1', 'src/a.ts')).toBe(true);
  });
  it('removes state files older than 7 days and keeps newer ones', () => {
    const state = join(dir, 'state');
    mkdirSync(state, { recursive: true });
    const old = join(state, 'old-session.txt');
    const fresh = join(state, 'fresh-session.txt');
    writeFileSync(old, 'x\n');
    writeFileSync(fresh, 'x\n');
    const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, t, t);
    firstWarning('s1', 'p1', 'src/a.ts');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it('an unwritable state folder still warns', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where a folder should be');
    process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(blocker, 'sub');
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(true);
    expect(firstWarning('s1', 'p1', 'src/a.ts')).toBe(true);
  });
});
