/**
 * Coordination event recording — the instrument, kept separate from the guard.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A file-claim block or a stale-lock takeover is decided in file-claims.ts and
 * then discarded. Nothing writes it down, so the event that constitutes the
 * actual pain ("two of my sessions collided") leaves no trace at the moment it
 * happens and cannot be reconstructed later. Same for a session sitting on a
 * permission prompt in a terminal nobody is watching.
 *
 * WHY POSTGRES, NOT A JSONL APPEND
 * --------------------------------
 * Every session on this machine runs the same global hook binaries, so an
 * append-only file would be written by N concurrent unrelated processes with no
 * locking. On Windows those appends interleave and shred each other. Postgres
 * also lets the event commit in the SAME transaction as the decision it
 * describes, so "a block was recorded" and "a block happened" cannot diverge.
 *
 * THE POSTURE THAT MATTERS
 * ------------------------
 * Instrumentation may never veto work. `recordEventInTransaction` runs inside a
 * SAVEPOINT: if the insert fails — table missing, permissions changed, schema
 * drifted — the savepoint is rolled back and the surrounding claim transaction
 * still commits. We lose the event and say so on stderr; we do not lose the
 * user's edit. That is the whole reason this is not just an inline INSERT.
 */

import type { Client } from 'pg';
import { withPgClientOrFallback } from './pg-client.js';

/**
 * The authoritative list of event kinds.
 *
 * Deliberately NOT a Postgres enum: adding a kind should be a hook deploy, not
 * a migration against a database three other applications share.
 */
export type CoordinationEventKind =
  /** An active session held the file; the edit was denied. */
  | 'claim_blocked'
  /** The holder's heartbeat was stale; this session took the claim. */
  | 'claim_takeover'
  /** The DB could not be reached, so the edit was permitted UNCHECKED. */
  | 'claim_degraded'
  /** The session is waiting on a human and may be sitting unwatched. */
  | 'blocked_on';

export interface CoordinationEvent {
  kind: CoordinationEventKind;
  /** The session the event happened TO — the one blocked, or waiting. */
  sessionId: string;
  project?: string | null;
  filePath?: string | null;
  /** For a conflict: whoever held the claim. */
  holderSessionId?: string | null;
  toolName?: string | null;
  detail?: Record<string, unknown>;
}

const INSERT_EVENT = `
  INSERT INTO agentic_os.coordination_event
    (kind, session_id, project, file_path, holder_session_id, tool_name, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
`;

function params(e: CoordinationEvent): unknown[] {
  return [
    e.kind,
    e.sessionId,
    e.project ?? null,
    e.filePath ?? null,
    e.holderSessionId ?? null,
    e.toolName ?? null,
    JSON.stringify(e.detail ?? {}),
  ];
}

/**
 * Record an event inside a transaction the caller already owns.
 *
 * Wrapped in a SAVEPOINT so a broken event table cannot abort the claim. In
 * Postgres any failed statement poisons the whole transaction, so without the
 * savepoint a missing `agentic_os.coordination_event` would roll back the claim
 * decision itself and turn an instrumentation bug into an editing outage.
 *
 * @returns true if the event was written, false if it was dropped.
 */
export async function recordEventInTransaction(
  client: Client,
  event: CoordinationEvent,
): Promise<boolean> {
  try {
    await client.query('SAVEPOINT coordination_event');
  } catch {
    // No savepoint means no protection, so do not attempt the insert at all —
    // a failure here would take the claim down with it.
    return false;
  }

  try {
    await client.query(INSERT_EVENT, params(event));
    await client.query('RELEASE SAVEPOINT coordination_event');
    return true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT coordination_event').catch(() => {
      /* connection already gone; the caller's own error handling takes over */
    });
    const msg = err instanceof Error ? err.message : String(err);
    // stderr only — stdout is the hook's protocol channel and must stay pure JSON.
    console.error(`[coordination] event ${event.kind} dropped: ${msg}`);
    return false;
  }
}

/**
 * Record an event on its own connection.
 *
 * For hooks with no claim transaction to join — the Notification hook, which is
 * pure instrumentation and has no decision to make.
 */
export async function recordEvent(
  event: CoordinationEvent,
): Promise<{ recorded: boolean; degraded: boolean }> {
  const { value, degraded } = await withPgClientOrFallback(
    async (client) => {
      await client.query(INSERT_EVENT, params(event));
      return true;
    },
    false,
    `recordEvent(${event.kind})`,
  );

  return { recorded: value, degraded };
}
