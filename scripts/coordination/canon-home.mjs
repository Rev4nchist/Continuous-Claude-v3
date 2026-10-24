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
import { join } from 'node:path';

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
