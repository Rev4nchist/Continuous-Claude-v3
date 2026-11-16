// Temp folders for node:test files: make them through makeTempDir(), remove them when the file ends.
// Only the folders this module made are removed. Never a prefix match, never an age sweep.
// Pattern: scripts/harness-doctor.test.mjs (PR 597) and .claude/hooks/src/__tests__/correct-helpers.ts.
//
//   import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';
//   registerTempCleanup();               // once, at the top level of the test file
//   const dir = makeTempDir('my-test-'); // instead of mkdtempSync(path.join(os.tmpdir(), 'my-test-'))
import { after } from 'node:test';
import { lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every folder makeTempDir made in this process. Only these are removed. */
const made = [];

/** Make a folder like mkdtempSync(join(base, prefix)) and record its path. */
export function makeTempDir(prefix, base = tmpdir()) {
  const dir = mkdtempSync(join(base, prefix));
  made.push(dir);
  return dir;
}

// Unlink every junction or symlink under dir. It never follows one, so the target keeps its files.
function unlinkLinks(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        try { rmdirSync(path); } catch { unlinkSync(path); } // a directory junction needs rmdir on some systems
      } else if (st.isDirectory()) {
        unlinkLinks(path);
      }
    } catch {
      /* a vanished or locked entry: the remove below decides */
    }
  }
}

/** Remove the folders makeTempDir made, then forget them. A remove error is dropped: a leak is better than a failed test. */
export function removeTempDirs({ rm = rmSync } = {}) {
  for (const dir of made.splice(0)) {
    try {
      unlinkLinks(dir);
      rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leave it: a leak is better than a failed test */
    }
  }
}

/** Call once at the top level of a test file. node:test runs the hook when the file ends. */
export function registerTempCleanup() {
  after(() => removeTempDirs());
}
