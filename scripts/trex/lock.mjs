// The TREX run lock: one run at a time on this machine.
// The lock is <primary checkout>/.claude/cache/trex/run.lock, made with flag wx. It holds {pid, started, argv, runId}.
// Why not withLock from file-lock.mjs: withLock runs a sync fn and deletes the lock when fn returns.
// An async run would return a Promise at once, so the lock would be gone before the run begins.
// This file uses pidAlive from file-lock.mjs and the same rule: replace a lock only when its owner pid is dead.
// A pid can be reused by an unrelated process. When deps.processStart(pid) gives a start time later than the lock's
// `started`, the owner cannot be the process that wrote the lock, so the lock is stale.
// A stale lock is taken over by renaming it away first, then checking what was moved. Known limit: a rival that creates a
// fresh lock between our move and our put-back keeps its file and the displaced holder loses its lock; the window is tiny.

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pidAlive } from '../github/lib/file-lock.mjs';

/** A lock file with no readable body is held until it is this old. A writer may sit between wx and write. */
const GRACE_MS = 5000;
/** A process starts before it writes its lock. This slack covers clock rounding. */
const START_SLACK_MS = 2000;

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

/** Puts a moved lock back at its path unless something new is there already. Never overwrites. */
function putBack(moved, file) {
  try { linkSync(moved, file); } catch { /* a new lock exists, or the link failed: the moved copy is dropped below */ }
}

/**
 * Removes the lock only while it holds the text we judged stale, so a fresh lock is never removed.
 * It renames the lock to a unique name, reads the moved file, and deletes it only when the text matches.
 * Otherwise it puts the moved file back. Returns true when the stale lock is gone.
 */
function removeIfSame(file, text, rename = renameSync) {
  const moved = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { rename(file, moved); } catch { return false; } // gone, or not movable: the next create decides
  let same = false;
  try {
    same = readText(moved) === text;
    if (!same) putBack(moved, file);
  } finally {
    try { unlinkSync(moved); } catch { /* best effort */ }
  }
  return same;
}

/** True when the lock's owner is running. A pid that started after the lock was written is a reused pid. */
function ownerRuns(info, deps) {
  if (!(deps.alive ?? pidAlive)(info.pid)) return false;
  const wrote = Date.parse(info.started);
  if (!deps.processStart || Number.isNaN(wrote)) return true;
  let began = null;
  try { began = deps.processStart(info.pid); } catch { began = null; }
  return !(Number.isFinite(began) && began > wrote + START_SLACK_MS);
}

function createLock(file, body) {
  const fd = openSync(file, 'wx');
  try { writeSync(fd, body); } finally { closeSync(fd); }
}

/**
 * Takes the lock. Returns { ok: true, release } or { ok: false, pid } (pid is null for a lock with no readable body).
 * A lock whose owner pid is dead is replaced. A live owner keeps it, however long the run takes.
 * deps: { alive(pid), processStart(pid) -> ms | null, nowMs, rename }.
 */
export function acquireLock(file, info, deps = {}) {
  const body = JSON.stringify(info);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createLock(file, body);
      return { ok: true, release: () => { removeIfSame(file, body); } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = inspect(file);
    if (held === null) continue;
    if (held.info ? ownerRuns(held.info, deps) : young(file, deps.nowMs ?? Date.now())) return { ok: false, pid: held.info?.pid ?? null };
    removeIfSame(file, held.text, deps.rename);
  }
  return { ok: false, pid: null };
}

/**
 * --unlock. Removes the lock only when its owner pid is dead.
 * Returns { state: 'none' | 'held' | 'removed', info }. info is the old lock body, so the caller can remove its containers.
 */
export function unlockRun(file, deps = {}) {
  const held = inspect(file);
  if (held === null) return { state: 'none', info: null };
  if (held.info && ownerRuns(held.info, deps)) return { state: 'held', info: held.info };
  if (!held.info && young(file, deps.nowMs ?? Date.now())) return { state: 'held', info: null };
  if (!removeIfSame(file, held.text, deps.rename)) return { state: 'held', info: held.info }; // it changed under us
  return { state: 'removed', info: held.info };
}
