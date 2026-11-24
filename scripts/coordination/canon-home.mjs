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
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

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

export function canonProject(home = userHome()) {
  return normalizeProjectKey(repoPath(home));
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
