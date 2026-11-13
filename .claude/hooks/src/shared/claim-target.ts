/**
 * The key of a file claim: the path relative to the top folder of the FILE's own repo, plus the
 * common git dir of that repo (the same project string `canonicalProject` gives).
 *
 * Why: a claim keyed by the raw absolute path never matches across worktrees (each has its own
 * folder), and a claim keyed by the cwd repo is blind when a session edits another repo.
 *
 * Reads files only. No git process: this runs on every Edit and Write. A walk up from the file
 * finds the folder that holds `.git` (the nearest one wins, so a worktree inside the primary
 * checkout and a repo inside a repo both key by the inner repo). A `.git` FILE ("gitdir: <path>")
 * names a linked worktree's git dir, and the `commondir` file there names the common dir.
 * Any failure returns null, and the caller keeps today's key (raw path, cwd project): a file
 * outside any repo, a `.git` entry that cannot be read (any error but "not found"), a path on a
 * network share (no file read at all: sync calls have no time limit), or a path whose lease class
 * would change.
 *
 * What it does not do:
 *  - A stored row with an absolute path (a live session that started before this change) is not
 *    seen by a new key until that row expires: the mixed state.
 *  - Case: the project is lower-cased, and the relative path is lower-cased only on win32 and
 *    darwin. On a platform that keeps case, two repos whose paths differ only by case can share a
 *    key, and on a case-sensitive volume on win32 or darwin two files can share one.
 *
 * Links: the nearest existing parent is resolved with realpath, so a file reached through a
 * junction or symlink gets the key of the real file.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { isHarnessPath } from './leases.js';
import { normalizeProjectKey } from './session-id.js';

export interface ClaimKey {
  /** Path relative to the top folder of the file's repo, forward slashes. */
  filePath: string;
  /** Normalized common dir of the file's repo, same form as `canonicalProject`. */
  project: string;
}

export interface ClaimKeyOptions {
  /** Test hook. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The payload cwd: a relative raw path resolves against it, not against the hook's own cwd. */
  cwd?: string;
}

/** A path on a network share (leading \ or //). Reading it has no time limit: keep the old key. */
const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

/** File systems that ignore case: fold the relative path there, keep the case on Linux. */
const FOLDS_CASE: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['win32', 'darwin']);

const real = (p: string): string => realpathSync.native(p);

/** The nearest existing folder or file at or above `abs`. */
function nearestExisting(abs: string): string | null {
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * The common git dir of the repo whose top folder is `top`.
 * `undefined`: no `.git` here, keep walking up. `null`: a `.git` that cannot be read, stop.
 */
function commonDirOf(top: string): string | null | undefined {
  const dotGit = join(top, '.git');
  let st;
  try {
    st = lstatSync(dotGit);
  } catch (err) {
    // Only "not found" means no .git here. Any other error (EACCES, EIO, ...) stops the walk, so a
    // repo that cannot be read never hands the file to an OUTER repo.
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const gitdir = resolve(top, m[1]);
  if (!existsSync(gitdir)) return null;
  const commonFile = join(gitdir, 'commondir');
  if (!existsSync(commonFile)) return gitdir;
  const common = resolve(gitdir, readFileSync(commonFile, 'utf8').trim());
  return existsSync(common) ? common : null;
}

/**
 * Resolve the claim key of `rawPath`, or null when the file is outside any repo (or the repo
 * cannot be read). Never throws.
 */
export function resolveClaimKey(rawPath: string, options: ClaimKeyOptions = {}): ClaimKey | null {
  try {
    const platform = options.platform ?? process.platform;
    if (isNetworkPath(rawPath)) return null; // before any file read
    const abs = options.cwd ? resolve(options.cwd, rawPath) : resolve(rawPath);
    if (isNetworkPath(abs)) return null; // a relative path under a cwd on a share
    const anchor = nearestExisting(abs);
    if (!anchor) return null;
    // Real parent plus the part that does not exist yet (a new file in a new folder).
    const realFile = join(real(anchor), relative(anchor, abs));

    let dir = dirname(realFile);
    for (;;) {
      const common = commonDirOf(dir);
      if (common === null) return null; // a .git that cannot be read: today's key
      if (common !== undefined) {
        const project = normalizeProjectKey(
          real(common).replace(/\\/g, '/').replace(/\/?\.git\/?$/, ''),
        );
        let rel = relative(dir, realFile).replace(/\\/g, '/');
        // Outside the repo: "..", or a path that starts with "../". A folder named "..foo" is fine.
        if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
        // The lease class is decided from the key (resolveFileClaim). A repo rooted inside a harness
        // folder (`<x>/.claude/skills/plugin`, or `~/.claude` itself) has a relative path with no
        // `.claude/<dir>` segment, and a link can make the raw and the real path differ. Main
        // classed the RAW path. Keep today's key unless the raw path, the real path and the key all
        // give one class: never weaker than before.
        const harness = isHarnessPath(rel);
        if (isHarnessPath(abs) !== harness || isHarnessPath(realFile) !== harness) return null;
        if (FOLDS_CASE.has(platform)) rel = rel.toLowerCase();
        return { filePath: rel, project };
      }
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
    return null;
  }
}
