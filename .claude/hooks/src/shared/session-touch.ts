/**
 * Session activity touch — the writer `sessions.last_activity_at` never had.
 *
 * WHY THIS EXISTS
 * ---------------
 * `last_activity_at` has been declared in docker/init-schema.sql since the fork
 * and read by the Agentic OS fleet grid, but a repo-wide search on 2026-07-28
 * found ZERO writers. `count(last_activity_at)` returned 0 across all 2,435
 * rows. The column was dead, so the dashboard fell back to `last_heartbeat`.
 *
 * That fallback is not equivalent, and the difference is the whole point:
 *
 *   last_heartbeat  is written by heartbeat.ts on UserPromptSubmit ONLY.
 *                   It measures THE HUMAN typing.
 *   last_activity_at is written here on PostToolUse (every tool, any tool).
 *                   It measures THE AGENT working.
 *
 * Measured on a live session 2026-07-28 (sampled every 20s for 8 minutes while
 * the session was running a 12-agent workflow and dozens of tool calls):
 * last_heartbeat was written ONCE, and peak observed staleness was 505 seconds.
 * A dashboard whose subject is autonomous agents was therefore decaying toward
 * "dead" precisely while the agents did the most work. This closes that gap.
 *
 * WHY UPDATE-ONLY (never INSERT)
 * ------------------------------
 * Row creation belongs to session-register.ts / heartbeat.ts, which own the
 * `project` and `working_on` columns and the canonical-path normalization that
 * goes with them. If this module upserted, it would need its own opinion about
 * project spelling — and a second opinion about project spelling is exactly how
 * the 115-alias mess got made. An UPDATE against an id that does not exist is a
 * harmless zero-row no-op, which is the correct behavior for a liveness ping.
 *
 * WHY THROTTLED ON DISK
 * ---------------------
 * PostToolUse fires on EVERY tool call. An unthrottled DB round trip per tool
 * would add real latency to every action on a machine already carrying spawn
 * cost. The throttle is a per-session file in tmpdir — per-session deliberately,
 * unlike heartbeat.ts's single shared cache file, whose `cache.sessionId !==
 * sessionId` check makes two concurrent sessions invalidate each other on every
 * alternating prompt.
 *
 * Worst-case staleness after this change is THROTTLE_MS + the dashboard's 5s
 * poll ≈ 35s, against the 505s measured before it.
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * Nothing here may ever block or slow a tool response. Every path is wrapped,
 * every failure is swallowed, and the caller is never given anything to await
 * that could reject. Liveness telemetry is not worth breaking a session over.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Imported from pg-client directly, NOT from db-utils-pg: db-utils-pg imports
// withPgClient for its own use but does not re-export it, and going through it
// would also pull that module's whole surface into this bundle for nothing.
import { withPgClient } from './pg-client.js';

/** Minimum wall-clock gap between two DB writes for the same session. */
export const THROTTLE_MS = 30_000;

/**
 * Per-session throttle file. Session-scoped so concurrent sessions cannot
 * invalidate each other's throttle (see header).
 */
export function touchStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(tmpdir(), `claude-session-touch-${safe}.json`);
}

/**
 * True if enough wall-clock time has passed since the last recorded write.
 *
 * Returns true on a missing or corrupt state file — a lost throttle costs one
 * extra UPDATE, whereas failing closed would silently stop all liveness writes,
 * which is the failure mode this whole module exists to fix.
 */
export function shouldTouch(statePath: string, now: number = Date.now()): boolean {
  try {
    if (!existsSync(statePath)) return true;
    const raw = readFileSync(statePath, 'utf-8');
    if (!raw.trim()) return true;
    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at !== 'number') return true;
    return now - parsed.at >= THROTTLE_MS;
  } catch {
    return true;
  }
}

function recordTouch(statePath: string, now: number = Date.now()): void {
  try {
    writeFileSync(statePath, JSON.stringify({ at: now }));
  } catch {
    // Fail open — a throttle we cannot persist just means we write again sooner.
  }
}

/**
 * Stamp `sessions.last_activity_at = NOW()` for this session, at most once per
 * THROTTLE_MS. Resolves to true only if a DB write actually happened.
 *
 * NOW() is evaluated by the database, not by this process: `last_activity_at` is
 * `timestamp without time zone` holding UTC, and the container's TimeZone is
 * Etc/UTC (verified 2026-07-26, see the note on getActiveSessions in
 * db-utils-pg.ts). Computing the timestamp here would reintroduce exactly the
 * client-side timezone assumption that note removed.
 *
 * NEVER REJECTS.
 */
export async function touchSessionActivity(sessionId: string): Promise<boolean> {
  if (!sessionId || sessionId === 'unknown') return false;

  const statePath = touchStatePath(sessionId);
  if (!shouldTouch(statePath)) return false;

  // Recorded BEFORE the write, not after. If the DB is unreachable and each
  // call took the slow path, every tool call would pay a failed connection
  // attempt; stamping first bounds that cost to one attempt per THROTTLE_MS
  // whether the write succeeds or fails.
  recordTouch(statePath);

  try {
    await withPgClient(async (client) => {
      await client.query(
        `UPDATE sessions SET last_activity_at = NOW() WHERE id = $1`,
        [sessionId]
      );
    });
    return true;
  } catch {
    return false;
  }
}
