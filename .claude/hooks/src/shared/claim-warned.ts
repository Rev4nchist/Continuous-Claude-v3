/**
 * One [WARN] per session and path (card coord-file-claims-all-writers, seat change 3).
 *
 * A shell command that names a held file but has no write cue only warns. A second read of the same
 * file in the same session is silent. The state lives in the hook's own cache folder under
 * ~/.claude, never in the project tree (a file in a reviewed tree voids a review run: PR 529, 546).
 * Override the folder with CCV3_FILE_CLAIMS_STATE_DIR (tests). Any error means "warn": a missing
 * state file must never hide a conflict.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function stateDir(): string {
  return process.env.CCV3_FILE_CLAIMS_STATE_DIR || join(homedir(), '.claude', 'cache', 'file-claims-warned');
}

const safeName = (s: string): string => s.replace(/[^\w.-]/g, '_').slice(0, 80) || 'session';

/** True the first time this session sees this path; records it. False on a repeat. */
export function firstWarning(sessionId: string, filePath: string): boolean {
  try {
    const dir = stateDir();
    const file = join(dir, `${safeName(sessionId)}.txt`);
    if (existsSync(file) && readFileSync(file, 'utf8').split('\n').includes(filePath)) return false;
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${filePath}\n`, { mode: 0o600 });
    return true;
  } catch {
    return true;
  }
}
