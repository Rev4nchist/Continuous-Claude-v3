/**
 * Hooks vitest globalSetup: ONE run-owned temp folder for the whole run, removed at the end.
 * Why: the hook tests made about two folders per test in the real temp dir and never removed them (about 355,000 pig-* folders).
 * Design note: .claudedocs/e2e-temp-leak-round3/01-design-note.md
 *
 * setup():    makes <real temp>/ccv3-vt-<pid>-<random6> with an owner.json, points TEMP, TMP and TMPDIR at it
 *             (TMPDIR is the one that counts on Linux CI), and keeps the old value in CCV3_REAL_TEMP.
 *             Workers start after globalSetup and inherit the env, and vitest-run-temp.test.ts proves it inside a worker.
 * teardown(): removes only the path setup() recorded. Never a delete by name, age or prefix, never a scan of the real temp dir,
 *             and never through a link: every junction or symlink under the run folder is unlinked first. A link that
 *             cannot be unlinked, or a folder that cannot be read (only ENOENT is fine), stops the remove: one folder stays.
 * A crashed run (kill -9, power loss) leaves that one folder with its owner.json; the cleaner of card machine-hygiene-tool
 * reaps it by owner pid, not this file.
 */
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const RUN_PREFIX = 'ccv3-vt-';
const OWNER_FILE = 'owner.json';

let runRoot: string | null = null;
let realBase: string | null = null;

/** Make a run folder in `base` (default: the current tmpdir()) and write its owner file. Returns the folder path. */
export function makeRunRoot(base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, `${RUN_PREFIX}${process.pid}-`));
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return dir;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove one link without touching its target. A directory link on Windows needs rmdir, a file link needs unlink. */
function unlinkOne(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    /* a directory link on Windows: try rmdir, which removes the link and not the target */
  }
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The one read the tree walk makes. A test passes its own to simulate a folder that cannot be read. */
export interface TreeIo {
  readdir: (dir: string) => Dirent[];
}

const realIo: TreeIo = { readdir: (dir) => readdirSync(dir, { withFileTypes: true }) };

/**
 * Unlink every junction or symlink under `dir`, without following one. False when a link could not be removed
 * or a folder could not be read: an unreadable folder can hold a link, so only ENOENT (already gone) counts as fine.
 */
function unlinkLinks(dir: string, io: TreeIo): boolean {
  let entries: Dirent[];
  try {
    entries = io.readdir(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let ok = true;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink() || isLink(path)) {
      if (!unlinkOne(path)) ok = false;
    } else if (entry.isDirectory()) {
      if (!unlinkLinks(path, io)) ok = false;
    }
  }
  return ok;
}

/** Remove a folder and everything in it, never through a link. False (and nothing removed) when a link would not unlink or a folder could not be read. */
export function removeTree(dir: string, io: TreeIo = realIo): boolean {
  if (!unlinkLinks(dir, io)) return false;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a locked file must not fail a run: one folder stays */
  }
  return !pathExists(dir);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` is a run folder that makeRunRoot made in `base`: right parent, right name, a real directory, an owner file. */
function isRunRoot(dir: string, base: string): boolean {
  try {
    if (!basename(dir).startsWith(RUN_PREFIX)) return false;
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (realpathSync(dirname(dir)) !== realpathSync(base)) return false;
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as { pid?: unknown };
    return typeof owner.pid === 'number';
  } catch {
    return false;
  }
}

/** Remove one run folder, only when isRunRoot says it is one. Returns true when the folder is gone. */
export function removeRunRoot(dir: string, base: string = tmpdir()): boolean {
  if (!isRunRoot(dir, base)) return false;
  return removeTree(dir);
}

export function setup(): void {
  realBase = tmpdir();
  runRoot = makeRunRoot(realBase);
  process.env.CCV3_REAL_TEMP = realBase;
  process.env.CCV3_RUN_TEMP = runRoot;
  process.env.TEMP = runRoot;
  process.env.TMP = runRoot;
  process.env.TMPDIR = runRoot;
  // vitest may leave through process.exit after Ctrl+C; the exit handler is the same remove and runs once.
  process.once('exit', teardown);
}

export function teardown(): void {
  if (!runRoot || !realBase) return;
  const dir = runRoot;
  const base = realBase;
  runRoot = null;
  realBase = null;
  removeRunRoot(dir, base);
}
