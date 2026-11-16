/**
 * One [WARN] per session, project and path (card coord-file-claims-all-writers, seat change 3, review F12).
 *
 * A shell command that names a held file but has no write cue only warns. A second read of the same
 * file in the same session is silent. The state lives in the hook's own cache folder under
 * ~/.claude, never in the project tree (a file in a reviewed tree voids a review run: PR 529, 546).
 * Override the folder with CCV3_FILE_CLAIMS_STATE_DIR (tests). Any error means "warn": a missing
 * state file must never hide a conflict. A state file older than 7 days is removed on the next write.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PRUNE_MS = 7 * 24 * 3600 * 1000;

function stateDir(): string {
  return process.env.CCV3_FILE_CLAIMS_STATE_DIR || join(homedir(), '.claude', 'cache', 'file-claims-warned');
}

const safeName = (s: string): string => s.replace(/[^\w.-]/g, '_').slice(0, 80) || 'session';

function prune(dir: string): void {
  try {
    const cutoff = Date.now() - PRUNE_MS;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        // one file that cannot be read or removed does not stop the rest
      }
    }
  } catch {
    // the folder may not exist yet
  }
}

/** True the first time this session sees this project and path; records it. False on a repeat. */
export function firstWarning(sessionId: string, project: string, filePath: string): boolean {
  try {
    const dir = stateDir();
    const file = join(dir, `${safeName(sessionId)}.txt`);
    const key = `${project}|${filePath}`;
    if (existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(key)) return false;
    mkdirSync(dir, { recursive: true });
    prune(dir);
    appendFileSync(file, `${key}\n`, { mode: 0o600 });
    return true;
  } catch {
    return true;
  }
}

/** True when this session already recorded this project and path. Records nothing. Any error: false (show the warning). */
export function wasWarned(sessionId: string, project: string, filePath: string): boolean {
  try {
    const file = join(stateDir(), `${safeName(sessionId)}.txt`);
    return existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(`${project}|${filePath}`);
  } catch {
    return false;
  }
}
