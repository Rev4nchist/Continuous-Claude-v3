/**
 * Pending-publish files, shared by lane-board-republish-reminder (writes) and lane-board-stop-gate (reads).
 *
 * One file per (session, board): `<dir>/<pendingKey(session, board)>.json`
 *   = { since, verbs, board, askAt?, v?, stopBlocked? } (askAt: time of the last ask verb; v: shape marker)
 * A session on the default board uses `<session>.json`, the same name PR0 wrote, so old files stay valid.
 * Another board uses `<session>@<board>.json`.
 *
 * Both hooks import this module. It has no main(), so a hook bundle never runs the other hook.
 * Dot-files in the dir (`.render-<board>.json`, the auto-render debounce state) are not pending files.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_BOARD, pendingKey } from './lane-board.js';

type Env = Record<string, string | undefined>;

export interface Pending {
  since?: string;
  verbs?: string[];
  board?: string;
  stopBlocked?: boolean;
}

/** A pending file older than this is stale. The Stop gate deletes it. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export function pendingDir(env: Env = process.env): string {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'state', 'lane-board-pending');
}

export function pendingFile(sessionId: string, board: string = DEFAULT_BOARD, env: Env = process.env): string {
  return path.join(pendingDir(env), `${pendingKey(sessionId, board)}.json`);
}

export function readPending(file: string): Pending | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(s) ? (s as Pending) : null;
  } catch {
    return null;
  }
}

export interface PendingEntry {
  file: string;
  board: string;
  pending: Pending;
}

/** Every pending file of one session: `<sid>.json` and `<sid>@<board>.json`, sorted by file name. */
export function listPending(sessionId: string, env: Env = process.env): PendingEntry[] {
  const dir = pendingDir(env);
  const stem = pendingKey(sessionId, DEFAULT_BOARD);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: PendingEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const base = name.slice(0, -5);
    if (base !== stem && !base.startsWith(`${stem}@`)) continue;
    const file = path.join(dir, name);
    const pending = readPending(file);
    if (!pending) continue;
    const board = typeof pending.board === 'string' && pending.board ? pending.board : base === stem ? DEFAULT_BOARD : base.slice(stem.length + 1);
    out.push({ file, board, pending });
  }
  return out;
}

/** Delete pending files whose mtime is older than PENDING_MAX_AGE_MS. Returns how many went. Never throws. */
export function sweepStalePending(env: Env = process.env, now: number = Date.now()): number {
  const dir = pendingDir(env);
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) {
          fs.rmSync(file, { force: true });
          n += 1;
        }
      } catch {
        // one unreadable file never stops the sweep
      }
    }
  } catch {
    // no dir yet
  }
  return n;
}
