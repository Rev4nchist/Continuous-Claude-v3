/**
 * Session identity: the TypeScript half of the identity-file contract.
 *
 * A session has one label, "<name> #<sid8>". The name is the Claude Code session
 * name (--name or /rename). sid8 is the first 8 chars of the session UUID.
 *
 * Contract file: ~/.claude/state/identity/<uuid>.json (override: CCV3_IDENTITY_DIR)
 *   { uuid, short, name, previous, cwd, endedAt, endReason, updatedAt }
 * Every surface (hooks, lane.mjs, launcher, band) reads or writes this one shape.
 * Writers merge: a field the writer does not name keeps its stored value.
 * Readers treat a missing or corrupt file as absent.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteSync } from './atomic-write.js';
import { spawnDetachedHidden } from '../lib/spawn-hidden.js';

export interface Identity {
  uuid: string;
  short: string;
  name: string | null;
  previous: string | null;
  cwd: string | null;
  endedAt: string | null;
  endReason: string | null;
  updatedAt: string;
}

/** The fields a writer may set. `undefined` keeps the stored value; `null` clears it. */
export type IdentityPatch = Partial<Pick<Identity, 'name' | 'previous' | 'cwd' | 'endedAt' | 'endReason'>>;

export const NAME_CLIP = 16;
/** A /clear is matched to the identity that ended this recently, in this cwd. */
export const CLEAR_WINDOW_MS = 120_000;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 512 * 1024;
const HEAD_LINES = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same id rule as scripts/coordination/session-label.mjs: a uuid becomes a file name. */
const SAFE_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Same dir rule as scripts/coordination/session-label.mjs and the launcher. */
export function identityDir(): string {
  return process.env.CCV3_IDENTITY_DIR || join(homedir(), '.claude', 'state', 'identity');
}

export const shortId = (uuid: string): string => uuid.slice(0, 8);

/** A uuid is a file name: refuse anything that could leave the identity folder. */
function identityPath(uuid: string): string | null {
  return SAFE_ID_RE.test(uuid) ? join(identityDir(), `${uuid}.json`) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function readIdentity(uuid: string | null | undefined): Identity | null {
  if (!uuid) return null;
  const file = identityPath(uuid);
  if (!file) return null;
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.uuid !== 'string') return null;
    // The file name is the identity: a uuid written inside the file must not redirect a lookup.
    return {
      uuid,
      short: shortId(uuid),
      name: asString(o.name),
      previous: asString(o.previous),
      cwd: asString(o.cwd),
      endedAt: asString(o.endedAt),
      endReason: asString(o.endReason),
      updatedAt: asString(o.updatedAt) ?? '',
    };
  } catch {
    return null;
  }
}

/** Merge `patch` into the stored identity and write it atomically. Null when the write fails. */
export function writeIdentity(uuid: string, patch: IdentityPatch): Identity | null {
  const file = identityPath(uuid);
  if (!file) return null;
  const cur = readIdentity(uuid);
  const pick = <K extends keyof IdentityPatch>(k: K): Identity[K] =>
    (patch[k] !== undefined ? patch[k] : cur ? cur[k] : null) as Identity[K];
  const next: Identity = {
    uuid,
    short: shortId(uuid),
    name: pick('name'),
    previous: pick('previous'),
    cwd: pick('cwd'),
    endedAt: pick('endedAt'),
    endReason: pick('endReason'),
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(identityDir(), { recursive: true });
    atomicWriteSync(file, JSON.stringify(next, null, 2));
    return next;
  } catch {
    return null;
  }
}

/** One line, clipped to NAME_CLIP chars. Empty becomes null. */
export function clipName(name: string | null | undefined): string | null {
  const one = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > NAME_CLIP ? one.slice(0, NAME_CLIP) : one;
}

/** "<name> #<sid8>", or "#<sid8>" alone when there is no name. */
export function label(uuid: string, name?: string | null): string {
  const n = clipName(name === undefined ? readIdentity(uuid)?.name : name);
  return n ? `${n} #${shortId(uuid)}` : `#${shortId(uuid)}`;
}

function fileOffset(path: string, size: number, start: number, len: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(len, size - start));
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The last {"type":"custom-title","customTitle":...} line in the last 256 KB of a transcript. */
export function lastCustomTitle(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const lines = fileOffset(transcriptPath, size, start, TAIL_BYTES).split('\n');
    if (start > 0) lines.shift(); // a cut first line is not JSON
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"custom-title"')) continue;
      try {
        const o = JSON.parse(lines[i]) as { type?: string; customTitle?: unknown };
        if (o.type === 'custom-title' && asString(o.customTitle)) return String(o.customTitle);
      } catch { /* a damaged line: try the one before it */ }
    }
  } catch { /* unreadable transcript: no name */ }
  return null;
}

/** The session name for a hook payload: session_title first, else the transcript. */
export function resolveName(sessionTitle: unknown, transcriptPath: string | null | undefined): string | null {
  return asString(sessionTitle) ?? lastCustomTitle(transcriptPath);
}

/**
 * resume/fork: the direct parent. The transcript head replays older sessions, oldest
 * first, so the parent is the last other sessionId seen before the current id first
 * appears. If the current id never appears in the window, the last other id in it.
 */
export function previousFromTranscript(transcriptPath: string | null | undefined, current: string): string | null {
  if (!transcriptPath) return null;
  let parent: string | null = null;
  try {
    const size = statSync(transcriptPath).size;
    const lines = fileOffset(transcriptPath, size, 0, HEAD_BYTES).split('\n').slice(0, HEAD_LINES);
    for (const line of lines) {
      try {
        const id = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
        if (id === current) return parent;
        parent = id;
      } catch { /* a cut or damaged line */ }
    }
  } catch { /* unreadable transcript */ }
  return parent;
}

export const normCwd = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * clear: the one identity that ended with endReason "clear" in the last 120 s in this cwd.
 * Candidates another identity already names as `previous` are taken. With a name, same-name
 * candidates win. Null unless exactly one candidate remains: a wrong adopt moves another
 * session's lanes, so no adopt beats a guess.
 */
export function previousFromClear(
  current: string,
  cwd: string | null | undefined,
  now = Date.now(),
  name?: string | null,
): string | null {
  if (!cwd) return null;
  let cands: Identity[] = [];
  const claimed = new Set<string>();
  try {
    for (const f of readdirSync(identityDir())) {
      if (!f.endsWith('.json')) continue;
      const id = readIdentity(f.slice(0, -5));
      if (!id) continue;
      if (id.uuid !== current && id.previous) claimed.add(id.previous);
      if (id.uuid === current || id.endReason !== 'clear' || !id.endedAt || !id.cwd) continue;
      const at = Date.parse(id.endedAt);
      if (!Number.isFinite(at) || now - at > CLEAR_WINDOW_MS || at > now + 5000) continue;
      if (normCwd(id.cwd) !== normCwd(cwd)) continue;
      cands.push(id);
    }
  } catch { /* no identity folder yet */ }
  cands = cands.filter((c) => !claimed.has(c.uuid));
  const want = clipName(name)?.toLowerCase();
  if (want) {
    const same = cands.filter((c) => clipName(c.name)?.toLowerCase() === want);
    if (same.length) cands = same;
  }
  return cands.length === 1 ? cands[0].uuid : null;
}

/** The old session id for a SessionStart that continues another session, else null. */
export function resolvePrevious(
  source: string | undefined,
  current: string,
  transcriptPath: string | null | undefined,
  cwd: string | null | undefined,
  now = Date.now(),
  name?: string | null,
): string | null {
  if (source === 'resume' || source === 'fork') return previousFromTranscript(transcriptPath, current);
  if (source === 'clear') return previousFromClear(current, cwd, now, name);
  return null;
}

/**
 * Hand the old session's lanes and unread messages to the new one:
 * `lane.mjs adopt --from <old>` with CLAUDE_CODE_SESSION_ID=<new>.
 * Fire and forget. A failure or a missing lane.mjs never reaches the hook.
 */
export function runAdopt(
  newUuid: string,
  oldUuid: string,
  spawnFn: typeof spawnDetachedHidden = spawnDetachedHidden,
): boolean {
  try {
    const repo = process.env.CCV3_REPO || join(homedir(), 'continuous-claude');
    const lane = join(repo, 'scripts', 'coordination', 'lane.mjs');
    if (!existsSync(lane)) return false;
    const child = spawnFn(process.execPath, [lane, 'adopt', '--from', oldUuid], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: newUuid },
      // No spawn `timeout`: it does not bound a detached child. The pg timeouts in lane.mjs do.
      stdio: 'ignore',
    });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
