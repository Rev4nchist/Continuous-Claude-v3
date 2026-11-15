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
 * network share (no file read at all: sync calls have no time limit), a path whose lease class
 * would change. A path under `.claude/cache` (git-ignored, one copy per worktree: see
 * `isWorktreeCache`) keeps a per-worktree key: its real absolute path (card coord-file-claims-cache-key-canonical).
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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'fs';
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

/**
 * `.claude/cache/**` holds git-ignored files that each worktree makes for itself (the pre-pr summary,
 * its logs). One key for every worktree would make two sessions fight over files they cannot share
 * (card coord-file-claims-worktree-local). Such a file gets a key that differs per worktree (its real
 * absolute path). No .gitignore parser: a wrong ignore rule could weaken the
 * guard for a tracked file, and this prefix rule can only ever make a claim narrower for a file
 * under `.claude/cache`. The relative path is already resolved (".." gone) when this runs.
 *
 * The rule ASSUMES `.claude/cache/` is git-ignored (see the repo `.gitignore`). A file force-added
 * there loses the cross-worktree claim.
 */
const isWorktreeCache = (rel: string, fold: boolean): boolean => {
  const r = fold ? rel.toLowerCase() : rel;
  return r === '.claude/cache' || r.startsWith('.claude/cache/');
};

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
 * Resolve the claim key of `rawPath`, or null when the file is outside any repo or the repo cannot
 * be read (the caller keeps the old key, raw path plus cwd project). A file under `.claude/cache` (a
 * per-worktree file) gets its real absolute path as the key, so it differs per worktree and is one
 * key for every spelling of the path. Never throws.
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
        if (isWorktreeCache(rel, FOLDS_CASE.has(platform))) {
          // Card coord-file-claims-cache-key-canonical: a per-worktree file is keyed by its REAL absolute path (forward
          // slashes, case folded where the file system ignores case) plus the repo project. Every spelling of the
          // path (slash, case, "..", relative to the cwd, a link) is then one key, and two worktrees stay two keys.
          // The path is absolute, so the shell guard and the release hint read it as a stored absolute path.
          const absKey = realFile.replace(/\\/g, '/');
          return { filePath: FOLDS_CASE.has(platform) ? absKey.toLowerCase() : absKey, project };
        }
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

export interface RepoContext {
  /** Top folder of the repo that holds `dir`, real path, forward slashes. */
  top: string;
  /** Same project string as `ClaimKey.project`. */
  project: string;
}

/**
 * The repo of a folder (the payload cwd): its top folder and project key. File-claims uses it to
 * list the claims other sessions hold in that repo and to spell each claimed path in full. A
 * worktree inside the primary checkout resolves to its own top folder. Null when `dir` is outside
 * any repo or on a share, or a `.git` cannot be read. Reads files only. Never throws.
 */
export function resolveRepoContext(dir: string): RepoContext | null {
  try {
    if (!dir || isNetworkPath(dir)) return null;
    const anchor = nearestExisting(resolve(dir));
    if (!anchor) return null;
    let cur = real(anchor);
    for (;;) {
      const common = commonDirOf(cur);
      if (common === null) return null;
      if (common !== undefined) {
        const project = normalizeProjectKey(real(common).replace(/\\/g, '/').replace(/\/?\.git\/?$/, ''));
        return { top: cur.replace(/\\/g, '/'), project };
      }
      const up = dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  } catch {
    return null;
  }
}

/**
 * The top folders of the linked worktrees of the repo whose top folder is `top`: one `gitdir` file
 * per worktree under `<top>/.git/worktrees`. Reads files only. A repo with no worktrees, or a `top`
 * that is not a primary checkout, gives []. Never throws.
 */
export function listWorktreeTops(top: string): string[] {
  try {
    const dir = join(top, '.git', 'worktrees');
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      try {
        const gitFile = readFileSync(join(dir, name, 'gitdir'), 'utf8').trim();
        if (gitFile) out.push(dirname(gitFile).replace(/\\/g, '/'));
      } catch {
        // one unreadable entry does not hide the others
      }
    }
    return out;
  } catch {
    return [];
  }
}
