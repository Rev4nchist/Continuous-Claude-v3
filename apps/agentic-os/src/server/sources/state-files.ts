import 'server-only';

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redact } from './redact';

/**
 * Reader for the per-session state files the ccv3-mods plugin writes.
 *
 * Writer: .claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx (writeSnapshot), one
 * `<sessionId>.json` per session. Types: .claude/plugins/ccv3-mods/types/index.d.ts
 * (OsBrief, OsTask, PrWatch). The app does not import them (they live outside the app root).
 * This module copies only the fields the fleet view needs into StateSnapshot.
 *
 * Rules:
 *   - Every key is optional except `sessionId` (string) and `at` (epoch ms). A key with the
 *     wrong type is treated as absent. A file that is not JSON, or lacks either required
 *     key, counts as `unreadable`. Nothing here throws.
 *   - Every string that leaves this module is redacted FIRST and clipped SECOND. Clipping
 *     first could cut a token in half and leave a tail the patterns no longer match.
 *   - At most MAX_FILES files (newest first), each at most MAX_BYTES. Others are counted.
 */

const MAX_FILES = 200;
const MAX_BYTES = 1024 * 1024;
/** A string longer than this is cut BEFORE redaction, only to bound regex work. */
const PRE_REDACT_CAP = 20_000;

const CLIP = { title: 120, goal: 200, stopAt: 200, ask: 240, step: 240, id: 120, short: 120 };

export type StateTaskStatus = 'pending' | 'in_progress' | 'completed';
export type StatePlanStatus = 'todo' | 'doing' | 'done' | 'blocked';
export type StateAskKind = 'question' | 'approval' | 'decision' | 'block';

export type StateAsk = {
  kind: StateAskKind;
  text: string;
  recommend: string | null;
  answered: boolean;
};

export type StateBrief = {
  title: string | null;
  goal: string | null;
  stopAt: string | null;
  plan: { id: string; text: string; status: StatePlanStatus }[];
  ask: StateAsk[];
  proofs: { id: string; subject: string; kind: 'task' | 'plan' }[];
  /** Epoch milliseconds, or null when the file has none. */
  updatedAt: number | null;
};

export type StateSnapshot = {
  sessionId: string;
  /** Epoch milliseconds the file was written. */
  at: number;
  chip: string | null;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  ctx: number | null;
  tasks: { id: string; subject: string; status: StateTaskStatus }[];
  prs: { pr: number; state: string | null }[];
  brief: StateBrief | null;
};

export type StateFileStats = {
  dir: string;
  filesSeen: number;
  unreadable: number;
  oversize: number;
  tooMany: number;
  /** The directory exists but cannot be listed (not ENOENT). A missing directory is zero files. */
  dirUnreadable: boolean;
};

export type StateFiles = { snapshots: StateSnapshot[]; stats: StateFileStats };

// --- Field helpers (a wrong type is absent) ----------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Redact, then clip. Null when the value is not a string or is empty after trimming. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, PRE_REDACT_CAP).trim();
  if (trimmed === '') return null;
  return clip(redact(trimmed).text, max);
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

const TASK_STATUS = ['pending', 'in_progress', 'completed'] as const;
const PLAN_STATUS = ['todo', 'doing', 'done', 'blocked'] as const;
const ASK_KIND = ['question', 'approval', 'decision', 'block'] as const;
const PROOF_KIND = ['task', 'plan'] as const;

// --- Parsing ------------------------------------------------------------------------------------

function parseAsk(value: unknown): StateAsk[] {
  const out: StateAsk[] = [];
  for (const item of list(value, 50)) {
    if (!isRecord(item)) continue;
    const text = str(item.text, CLIP.ask);
    if (text === null) continue;
    out.push({
      kind: oneOf(item.kind, ASK_KIND) ?? 'question',
      text,
      recommend: str(item.recommend, CLIP.ask),
      answered: item.answered === true,
    });
  }
  return out;
}

function parsePlan(value: unknown): StateBrief['plan'] {
  const out: StateBrief['plan'] = [];
  list(value, 200).forEach((item, index) => {
    if (!isRecord(item)) return;
    const text = str(item.text, CLIP.step);
    if (text === null) return;
    out.push({
      id: str(item.id, CLIP.id) ?? String(index),
      text,
      status: oneOf(item.status, PLAN_STATUS) ?? 'todo',
    });
  });
  return out;
}

function parseProofs(value: unknown): StateBrief['proofs'] {
  const out: StateBrief['proofs'] = [];
  for (const item of list(value, 400)) {
    if (!isRecord(item)) continue;
    const id = str(item.id, CLIP.id);
    const subject = str(item.subject, CLIP.step);
    const kind = oneOf(item.kind, PROOF_KIND);
    if (id !== null && subject !== null && kind !== null) out.push({ id, subject, kind });
  }
  return out;
}

function parseBrief(value: unknown): StateBrief | null {
  if (!isRecord(value)) return null;
  return {
    title: str(value.title, CLIP.title),
    goal: str(value.goal, CLIP.goal),
    stopAt: str(value.stopAt, CLIP.stopAt),
    plan: parsePlan(value.plan),
    ask: parseAsk(value.ask),
    proofs: parseProofs(value.proofs),
    updatedAt: num(value.updatedAt),
  };
}

function parseTasks(value: unknown): StateSnapshot['tasks'] {
  const out: StateSnapshot['tasks'] = [];
  for (const item of list(value, 200)) {
    if (!isRecord(item)) continue;
    const id = str(item.id, CLIP.id);
    const subject = str(item.subject, CLIP.step);
    if (id === null || subject === null) continue;
    out.push({ id, subject, status: oneOf(item.status, TASK_STATUS) ?? 'pending' });
  }
  return out;
}

function parsePrs(value: unknown): StateSnapshot['prs'] {
  const out: StateSnapshot['prs'] = [];
  for (const item of list(value, 50)) {
    if (!isRecord(item)) continue;
    const pr = num(item.pr);
    if (pr === null) continue;
    out.push({ pr, state: typeof item.state === 'string' ? clip(item.state, 40) : null });
  }
  return out;
}

/** Null when the text is not a valid state file. */
function parseSnapshot(text: string): StateSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  const at = num(raw.at);
  if (sessionId === '' || sessionId.length > 200 || at === null) return null;

  return {
    sessionId,
    at,
    chip: str(raw.chip, CLIP.short),
    repo: str(raw.repo, CLIP.short),
    branch: str(raw.branch, CLIP.short),
    worktree: str(raw.worktree, CLIP.short),
    ctx: num(raw.ctx),
    tasks: parseTasks(raw.tasks),
    prs: parsePrs(raw.prs),
    brief: parseBrief(raw.brief),
  };
}

// --- Directory ----------------------------------------------------------------------------------

function stateDir(): string {
  const fromEnv = process.env.AGENTIC_OS_STATE_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'state', 'agentic-os');
}

type Entry = { name: string; size: number; mtimeMs: number; link: boolean };

type Listing = { entries: Entry[]; dirUnreadable: boolean };

/**
 * `<name>.json` entries of the state dir. A symbolic link is listed but flagged: the caller
 * counts it as unreadable and never opens it, so a link cannot point the reader at another
 * file. A missing directory (ENOENT) is zero files. Any other readdir error (EACCES, ENOTDIR)
 * sets `dirUnreadable`.
 */
async function listEntries(dir: string): Promise<Listing> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { entries: [], dirUnreadable: !missing };
  }
  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.name.endsWith('.json'))
      .map(async (dirent): Promise<Entry | null> => {
        if (dirent.isSymbolicLink()) return { name: dirent.name, size: 0, mtimeMs: 0, link: true };
        try {
          const info = await lstat(join(dir, dirent.name));
          if (info.isSymbolicLink()) return { name: dirent.name, size: 0, mtimeMs: 0, link: true };
          return info.isFile()
            ? { name: dirent.name, size: info.size, mtimeMs: info.mtimeMs, link: false }
            : null;
        } catch {
          return null;
        }
      }),
  );
  return { entries: entries.filter((entry): entry is Entry => entry !== null), dirUnreadable: false };
}

/**
 * Read every state file in the state dir. Never throws: a missing directory is zero files,
 * an unlistable one sets `dirUnreadable`, a broken file or a symbolic link is `unreadable`.
 */
export async function readStateFiles(): Promise<StateFiles> {
  const dir = stateDir();
  const { entries, dirUnreadable } = await listEntries(dir);
  // Newest first, so a pile of old files cannot push a live session out of the cap.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

  const chosen = entries.slice(0, MAX_FILES);
  const stats: StateFileStats = {
    dir,
    filesSeen: entries.length,
    unreadable: 0,
    oversize: 0,
    tooMany: entries.length - chosen.length,
    dirUnreadable,
  };

  const snapshots: StateSnapshot[] = [];
  const bySession = new Map<string, StateSnapshot>();

  for (const entry of chosen) {
    if (entry.link) {
      stats.unreadable += 1;
      continue;
    }
    if (entry.size > MAX_BYTES) {
      stats.oversize += 1;
      continue;
    }
    let text: string;
    try {
      text = await readFile(join(dir, entry.name), 'utf8');
    } catch {
      stats.unreadable += 1;
      continue;
    }
    const snapshot = parseSnapshot(text);
    if (snapshot === null) {
      stats.unreadable += 1;
      continue;
    }
    // Two files for one session (a copy, a leftover): keep the newer write.
    const previous = bySession.get(snapshot.sessionId);
    if (previous === undefined || snapshot.at > previous.at) bySession.set(snapshot.sessionId, snapshot);
  }
  snapshots.push(...bySession.values());

  return { snapshots, stats };
}
