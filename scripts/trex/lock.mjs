// The TREX run lock: one run at a time on this machine.
// The lock is <primary checkout>/.claude/cache/trex/run.lock, made with flag wx. It holds {pid, started, argv, runId}.
// Why not withLock from file-lock.mjs: withLock runs a sync fn and deletes the lock when fn returns.
// An async run would return a Promise at once, so the lock would be gone before the run begins.
// This file uses pidAlive from file-lock.mjs and the same rule: replace a lock only when its owner pid is dead.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pidAlive } from '../github/lib/file-lock.mjs';

/** A lock file with no readable body is held until it is this old. A writer may sit between wx and write. */
const GRACE_MS = 5000;

export const lockPathFor = (primaryRoot) => path.join(primaryRoot, '.claude', 'cache', 'trex', 'run.lock');

/** The first worktree of `git worktree list --porcelain` is the primary checkout. Falls back to `fallback`. */
export function primaryRootOf(git, fallback) {
  const r = git(['worktree', 'list', '--porcelain']);
  const first = r.status === 0 ? /^worktree (.+)$/m.exec(r.stdout) : null;
  return first ? first[1].trim() : fallback;
}

const readText = (file) => {
  try { return readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};

function parseInfo(text) {
  try {
    const info = JSON.parse(text);
    return Number.isInteger(info?.pid) ? info : null;
  } catch { return null; }
}

/** { text, info } for a lock on disk, or null when there is none. info is null for a body that does not parse. */
function inspect(file) {
  const text = readText(file);
  return text === null ? null : { text, info: parseInfo(text) };
}

function young(file, nowMs) {
  try { return nowMs - statSync(file).mtimeMs < GRACE_MS; } catch { return false; }
}

/** Removes the lock only while it still holds the text we judged stale, so a fresh lock is never removed. */
function removeIfSame(file, text) {
  try { if (readText(file) === text) unlinkSync(file); } catch { /* gone, or not removable: the next create decides */ }
}

function createLock(file, body) {
  const fd = openSync(file, 'wx');
  try { writeSync(fd, body); } finally { closeSync(fd); }
}

/**
 * Takes the lock. Returns { ok: true, release } or { ok: false, pid } (pid is null for a lock with no readable body).
 * A lock whose owner pid is dead is replaced. A live owner keeps it, however long the run takes.
 * deps: { alive(pid), nowMs }.
 */
export function acquireLock(file, info, deps = {}) {
  const alive = deps.alive ?? pidAlive;
  const body = JSON.stringify(info);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createLock(file, body);
      return { ok: true, release: () => removeIfSame(file, body) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = inspect(file);
    if (held === null) continue;
    if (held.info ? alive(held.info.pid) : young(file, deps.nowMs ?? Date.now())) return { ok: false, pid: held.info?.pid ?? null };
    removeIfSame(file, held.text);
  }
  return { ok: false, pid: null };
}

/**
 * --unlock. Removes the lock only when its owner pid is dead.
 * Returns { state: 'none' | 'held' | 'removed', info }. info is the old lock body, so the caller can remove its containers.
 */
export function unlockRun(file, deps = {}) {
  const alive = deps.alive ?? pidAlive;
  const held = inspect(file);
  if (held === null) return { state: 'none', info: null };
  if (held.info && alive(held.info.pid)) return { state: 'held', info: held.info };
  if (!held.info && young(file, deps.nowMs ?? Date.now())) return { state: 'held', info: null };
  removeIfSame(file, held.text);
  return { state: 'removed', info: held.info };
}
