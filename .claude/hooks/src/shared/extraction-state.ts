/**
 * Per-session extraction state (B9).
 *
 * File: <projectDir>/.claude/extraction-state.json, shared by every session in
 * the project. `last_extracted_line` is an index into ONE transcript, so it is
 * kept per session id. Writers: pre-compact-extract (this module, under the
 * lock) and opc/scripts/core/incremental_extract.py (same shape).
 *
 * Shape (version 2):
 *   { version: 2,
 *     recent_hashes: string[],                 // dedup hashes, shared
 *     sessions: { [sessionId]: { last_extracted_line, last_launched, last_extraction_time } } }
 *
 * Old flat shape, still readable:
 *   { session_id, last_extracted_line, recent_hashes, last_extraction_time, last_launched }
 * It maps to the one session named by `session_id`. A flat file with no
 * `session_id` maps to no session, so every session starts at line 0.
 */

export const STATE_VERSION = 2;
/** Keep the newest sessions only, so the file does not grow without bound. */
export const MAX_SESSIONS = 50;

export interface SessionEntry {
  last_extracted_line?: number;
  last_launched?: number;
  last_extraction_time?: string;
}

export interface ExtractionStateV2 {
  version: 2;
  recent_hashes: string[];
  sessions: Record<string, SessionEntry>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finiteNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

function cleanEntry(raw: unknown): SessionEntry {
  const o = isObject(raw) ? raw : {};
  const entry: SessionEntry = {};
  const line = finiteNumber(o.last_extracted_line);
  const launched = finiteNumber(o.last_launched);
  if (line !== undefined) entry.last_extracted_line = line;
  if (launched !== undefined) entry.last_launched = launched;
  if (typeof o.last_extraction_time === 'string') entry.last_extraction_time = o.last_extraction_time;
  return entry;
}

/** Parse file text of either shape. Never throws: bad input gives an empty state. */
export function parseState(text: string | null): ExtractionStateV2 {
  // Null prototype: a session id such as "__proto__" must stay a plain key.
  const sessions: Record<string, SessionEntry> = Object.create(null);
  const state: ExtractionStateV2 = { version: STATE_VERSION, recent_hashes: [], sessions };
  if (!text || !text.trim()) return state;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return state;
  }
  if (!isObject(data)) return state;

  if (Array.isArray(data.recent_hashes)) {
    state.recent_hashes = data.recent_hashes.filter((h): h is string => typeof h === 'string');
  }

  if (isObject(data.sessions)) {
    for (const [sid, entry] of Object.entries(data.sessions)) sessions[sid] = cleanEntry(entry);
  } else if (typeof data.session_id === 'string' && data.session_id) {
    // Old flat shape: its line and stamp belong to the session it names.
    sessions[data.session_id] = cleanEntry(data);
  }
  return state;
}

/** Line to start at for this session. A session with no entry starts at 0. */
export function sessionStartLine(state: ExtractionStateV2, sessionId: string): number {
  return state.sessions[sessionId]?.last_extracted_line ?? 0;
}

/** True when this session launched an extraction less than `cooldownMs` ago. */
export function inCooldown(
  state: ExtractionStateV2,
  sessionId: string,
  now: number,
  cooldownMs: number
): boolean {
  const launched = state.sessions[sessionId]?.last_launched;
  return launched !== undefined && now - launched < cooldownMs;
}

/** Copy of `state` with `last_launched` set for this session; other sessions untouched. */
export function withLaunchStamp(
  state: ExtractionStateV2,
  sessionId: string,
  now: number
): ExtractionStateV2 {
  const sessions: Record<string, SessionEntry> = Object.create(null);
  for (const [sid, entry] of Object.entries(state.sessions)) sessions[sid] = { ...entry };
  sessions[sessionId] = { ...sessions[sessionId], last_launched: now };

  const recency = (e: SessionEntry): number =>
    Math.max(e.last_launched ?? 0, Date.parse(e.last_extraction_time ?? '') || 0);
  const ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => recency(sessions[b]) - recency(sessions[a]));
    for (const sid of ids.slice(MAX_SESSIONS)) {
      if (sid !== sessionId) delete sessions[sid];
    }
  }
  return { version: STATE_VERSION, recent_hashes: state.recent_hashes, sessions };
}
