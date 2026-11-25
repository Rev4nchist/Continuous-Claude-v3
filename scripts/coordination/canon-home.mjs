/**
 * Home and canonical project for the coordination probes.
 *
 * The claim hooks key a project with normalizeProjectKey (session-id.ts):
 * backslashes become slashes, a trailing slash is dropped, and the path is
 * lowercased. A probe that inserts a different string never meets the row
 * the hook writes.
 *
 * CCV3_USER_HOME overrides os.homedir() so a Windows run can point at a
 * stand-in home. On Linux, os.homedir() already follows HOME.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function normalizeProjectKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function userHome() {
  const override = process.env.CCV3_USER_HOME;
  if (override && override.trim()) return override;
  return homedir();
}

export function repoPath(home = userHome()) {
  return join(home, 'continuous-claude');
}

/**
 * The common git dir of the repo whose top folder is `top`: the same steps as commonDirOf in
 * .claude/hooks/src/shared/claim-target.ts:86-107. `undefined`: no `.git` here, keep walking up. `null`: a `.git` that cannot be read.
 */
function commonDirOf(top) {
  const dotGit = join(top, '.git');
  let st;
  try { st = lstatSync(dotGit); } catch (err) { return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? undefined : null; }
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
 * The project key the file-claims hook writes for a probe: resolveRepoContext().project of claim-target.ts:189-209. It is the real
 * path of the git COMMON dir, so a link to a clone gives the clone, and a link to a linked worktree gives the PRIMARY checkout.
 * A folder that does not exist, or has no readable repo above it, keeps the plain path (the hook gives null there).
 * The twin test .claude/hooks/src/__tests__/canon-home-twin.test.ts compares both real functions.
 */
export function canonProject(home = userHome()) {
  const repo = repoPath(home);
  try {
    if (existsSync(repo)) {
      let cur = realpathSync.native(repo);
      for (;;) {
        const common = commonDirOf(cur);
        if (common === null) break;
        if (common !== undefined) return normalizeProjectKey(realpathSync.native(common).replace(/\\/g, '/').replace(/\/?\.git\/?$/, ''));
        const up = dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
  } catch { /* a file system error: keep the plain path */ }
  return normalizeProjectKey(repo);
}

/**
 * The claim key the file-claims hook stores for a file (card coord-probe-scratch-guard-followups, item 1). A probe seeds and reads
 * file_claims rows with it, so it must equal what the hook writes. The source is resolveClaimKey in
 * .claude/hooks/src/shared/claim-target.ts, lines 131-165:
 *   - the path relative to the repo top folder, forward slashes (line 146);
 *   - null when the path is outside the repo: empty, "..", "../x" or absolute (line 148; a folder named "..foo" is normal);
 *   - a file under .claude/cache is keyed by its absolute path with forward slashes (lines 149-156, isWorktreeCache at 66-69);
 *   - the key is lower-cased where the file system ignores case: win32 and darwin (FOLDS_CASE at 51, line 164).
 * The test rows are the ones of .claude/hooks/src/__tests__/claim-target.test.ts: 4 (new folders), 5 (outside), 8 (case), 16 ("..foo").
 * Not mirrored: realpath and git lookups (the probe repo is the home checkout, a real path) and the harness-class null (lines 157-163).
 */
export function claimKey(abs, { repo = repoPath(), platform = process.platform } = {}) {
  const fold = platform === 'win32' || platform === 'darwin';
  const rel = relative(repo, String(abs)).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  const folded = fold ? rel.toLowerCase() : rel;
  if (folded === '.claude/cache' || folded.startsWith('.claude/cache/')) {
    const key = String(abs).replace(/\\/g, '/');
    return fold ? key.toLowerCase() : key;
  }
  return folded;
}

/** The preflight: the claim key, or a throw when the path has none (the hook would store no relative key for it). */
export function assertClaimKey(abs, options) {
  const key = claimKey(abs, options);
  if (key === null) throw new Error(`no claim key for '${String(abs).slice(0, 120)}': the path is outside the repo, so the hook would never meet a row seeded with it`);
  return key;
}

/** A value inside a single-quoted SQL literal: doubles a quote. A backslash stays (standard_conforming_strings is on). */
export function sqlLit(value) {
  return String(value).replace(/'/g, "''");
}
