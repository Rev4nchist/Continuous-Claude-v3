/**
 * tempDir() in correct-helpers.ts used to leave every folder behind: one probe run of
 * commit-preflight.test.ts left 220 `ccv3-correct-*` folders in %TEMP% (lane temp-folder-leak-hunt).
 * These tests fail if the helper stops removing what it made, or starts removing what it did not make.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTempDirs, tempDir } from './correct-helpers.js';

describe('correct-helpers temp folder cleanup', () => {
  it('removes every folder tempDir made, with the files inside', () => {
    const a = tempDir('cleanup-a');
    const b = tempDir('cleanup-b');
    writeFileSync(join(a, 'f.txt'), 'x');
    removeTempDirs();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('does not remove a folder it did not make, even with the same prefix', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'ccv3-correct-foreign-'));
    try {
      tempDir('cleanup-c');
      removeTempDirs();
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('a second removeTempDirs call is a no-op', () => {
    tempDir('cleanup-d');
    removeTempDirs();
    expect(() => removeTempDirs()).not.toThrow();
  });
});
