import { bigserial, index, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { agenticOs } from './project';

/**
 * Coordination events — the instrument that had to exist before any UI.
 *
 * WHY THIS TABLE EXISTS
 * ---------------------
 * A file-claim block, or a takeover of a stale lock, is computed inside
 * `.claude/hooks/src/file-claims.ts` and then **thrown away**. No row, no log,
 * nothing. The event that constitutes the stated pain — "two of my sessions
 * collided" — is discarded at the exact moment it occurs, so no amount of later
 * archaeology can recover it. Every day without this table is a day of evidence
 * that cannot be reconstructed.
 *
 * WHY POSTGRES AND NOT JSONL
 * --------------------------
 * The obvious cheap answer is appending a line to a file. It does not work here:
 * every Claude Code session on this machine runs the same global hook binaries,
 * so N concurrent hook processes would append to one file with no locking, and
 * on Windows those appends interleave and corrupt each other. Writing to
 * Postgres also lets the event commit in the SAME transaction as the claim
 * decision it describes, so a recorded block always corresponds to a decision
 * that actually happened, and vice versa.
 *
 * WHO WRITES IT
 * -------------
 * Hooks, via raw node `pg` (`.claude/hooks/src/shared/coordination-events.ts`),
 * NOT via drizzle. Drizzle owns the DDL only. Hooks are short-lived processes on
 * a latency budget measured in milliseconds; adding an ORM to that path buys
 * nothing. This declaration is the schema's source of truth, not its access path.
 *
 * DELIBERATELY NOT HERE
 * ---------------------
 * - **No FK to `project`.** A raw `project` string arriving from a repo that was
 *   never seeded into `agentic_os.project` must not raise a constraint error,
 *   because that error would abort the claim transaction and, through it, an
 *   ordinary file edit. Instrumentation may never be able to veto work.
 * - **No row for the ordinary grant.** Only conflicts and degradations are
 *   recorded. Logging every successful claim would mean one row per Edit — the
 *   same unbounded accumulation that left `file_claims` with 8,170 dead rows.
 */
export const coordinationEvent = agenticOs.table(
  'coordination_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * What happened. Kept as text rather than a pg enum on purpose: adding a new
     * event kind should be a hook deploy, not a migration on a shared database.
     * The authoritative list lives with the writer, in coordination-events.ts.
     *
     *   claim_blocked   — an active session held the file; the edit was denied
     *   claim_takeover  — the holder was stale; this session took the claim
     *   claim_degraded  — the DB could not be reached; the edit was permitted
     *                     UNCHECKED (recorded on a later run, best-effort)
     *   blocked_on      — the session is waiting on a human (permission prompt
     *                     or idle notification) and may be sitting unwatched
     */
    kind: text('kind').notNull(),

    /** The session the event happened TO — the one blocked, or waiting. */
    sessionId: text('session_id').notNull(),

    /** Canonical project path, same spelling `file_claims.project` uses. */
    project: text('project'),

    /** Absolute path of the contested file. Null for non-file events. */
    filePath: text('file_path'),

    /** For a conflict: the session that held the claim. Null otherwise. */
    holderSessionId: text('holder_session_id'),

    /** Edit | Write for claim events; null for notifications. */
    toolName: text('tool_name'),

    /** Anything kind-specific: the notification text, the holder's claim age. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('coordination_event_occurred_at_idx').on(t.occurredAt),
    index('coordination_event_kind_idx').on(t.kind),
    index('coordination_event_session_idx').on(t.sessionId),
  ],
);
