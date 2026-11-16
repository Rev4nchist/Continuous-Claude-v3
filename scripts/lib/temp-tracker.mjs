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

const REAL = { rm: rmSync, rmdir: rmdirSync, unlink: unlinkSync, readdir: readdirSync, lstat: lstatSync };

// Unlink one junction or symlink without following it. Returns true when the link is gone.
function unlinkOne(path, o) {
  try { o.rmdir(path); return true; } catch { /* a file symlink: rmdir refuses it */ }
  try { o.unlink(path); return true; } catch { return false; }
}

// Unlink every junction or symlink under dir. It never follows one, so the target keeps its files.
// It returns true only when dir was read and every link was unlinked. A false return means "leave this folder":
// a recursive remove over a tree that still holds a live link could follow it.
function unlinkLinks(dir, o) {
  let entries;
  try {
    entries = o.readdir(dir);
  } catch (e) {
    return e?.code === 'ENOENT'; // already gone is fine; a folder that cannot be read is left alone
  }
  let ok = true;
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try {
      st = o.lstat(path);
    } catch (e) {
      if (e?.code !== 'ENOENT') ok = false;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (!unlinkOne(path, o)) ok = false;
    } else if (st.isDirectory() && !unlinkLinks(path, o)) {
      ok = false;
    }
  }
  return ok;
}

/**
 * Remove the folders makeTempDir made, then forget them. A recorded path that is now a link loses only the link, never its target.
 * A folder that cannot be read, or that holds a link that will not unlink, is left in place: a leak is better than a followed link.
 * A remove error is dropped: a leak is better than a failed test. `over` replaces the fs calls (tests only).
 */
export function removeTempDirs(over = {}) {
  const o = { ...REAL, ...over };
  for (const dir of made.splice(0)) {
    try {
      let st;
      try {
        st = o.lstat(dir);
      } catch {
        continue; // gone
      }
      if (st.isSymbolicLink()) { unlinkOne(dir, o); continue; }
      if (!st.isDirectory()) continue;
      if (!unlinkLinks(dir, o)) continue;
      o.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leave it: a leak is better than a failed test */
    }
  }
}

/** Call once at the top level of a test file. node:test runs the hook when the file ends. */
export function registerTempCleanup() {
  after(() => removeTempDirs());
}
