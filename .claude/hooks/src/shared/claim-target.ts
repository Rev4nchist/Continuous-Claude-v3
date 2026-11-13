/**
 * The key of a file claim: the path relative to the top folder of the FILE's own repo, plus the
 * common git dir of that repo (the same project string `canonicalProject` gives).
 *
 * Why: a claim keyed by the raw absolute path never matches across worktrees (each has its own
 * folder), and a claim keyed by the cwd repo is blind when a session edits another repo.
 *
 * Reads files only. No git process: this runs on every Edit and Write. A walk up from the file
 * finds the folder that holds `.git`. A `.git` FILE ("gitdir: <path>") names a linked worktree's
 * git dir, and the `commondir` file there names the common dir. Any failure returns null, and the
 * caller keeps today's key (raw path, cwd project). So the change only ever makes the guard see
 * more, never less.
 *
 * Links: the nearest existing parent is resolved with realpath, so a file reached through a
 * junction or symlink gets the key of the real file.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
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
}

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
  } catch {
    return undefined;
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
    const abs = resolve(rawPath);
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
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
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
