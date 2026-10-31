import { pgTable, text, timestamp, uuid, jsonb, vector } from 'drizzle-orm/pg-core';

/**
 * ============================ READ ONLY. NEVER WRITE. ============================
 *
 * Typed views of tables in the shared `public` schema. These are owned by OTHER
 * systems and this application must never insert, update, delete, or migrate them:
 *
 *   sessions / file_claims / agents  -> written by .claude/hooks/src/shared/db-utils-pg.ts
 *   archival_memory                  -> written by opc/scripts/core/ (Python)
 *
 * This file lives in src/db/readonly/ and is deliberately EXCLUDED from
 * drizzle.config.ts's `schema` glob (which covers only src/db/schema/*.ts).
 * Drizzle table declarations are not inert to drizzle-kit even under
 * `schemaFilter`, so keeping them out of the glob is the real guarantee that no
 * migration ever names a `public` object. `schemaFilter` is the second layer,
 * not the only one.
 *
 * Enforcement is also at the database level: the app connects as `agentic_os_app`,
 * which holds SELECT and nothing else. A write here fails with
 * "permission denied for table sessions" rather than succeeding quietly.
 * (Verified 2026-07-25.)
 */

/**
 * Cross-terminal session coordination. 2,352+ rows.
 *
 * IMPORTANT: this is NOT a clean list of Claude Code sessions. Only ~887 ids are
 * UUID-shaped (real sessions, matching a transcript filename). The other ~1,465
 * are `s-<base36>` ids from generateSessionId() in
 * .claude/hooks/src/shared/session-id.ts — a coordination-only fallback emitted
 * when a hook cannot see the real session id. Treat this table as one of two
 * session sources, never as the definitive roster.
 */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  startedAt: timestamp('started_at'),
  lastHeartbeat: timestamp('last_heartbeat'),
  memoryExtractedAt: timestamp('memory_extracted_at'),
  lastActivityAt: timestamp('last_activity_at'),
  lastPeriodicExtraction: timestamp('last_periodic_extraction'),

  /**
   * The session's END, written by .claude/hooks/src/coordination-release.ts on
   * SessionEnd (added 2026-07-28, migration 003-sessions-lifecycle.sql).
   *
   * NOT NULL is a trustworthy positive signal. NULL is UNKNOWN and must NEVER be
   * rendered as "crashed" — the session may be running, may have been killed
   * before the hook could fire, or may simply predate the writer, which was true
   * of all 2,453 rows on the day it shipped. Same contract as lastActivityAt.
   *
   * A session can resume, so readers must treat it as ended only when the end is
   * the LAST thing that happened: ended_at >= GREATEST(lastHeartbeat,
   * lastActivityAt). Nothing clears the column.
   */
  endedAt: timestamp('ended_at'),
  /** Claude Code's own reason string, verbatim. Unconstrained TEXT on purpose. */
  endReason: text('end_reason'),
});

/**
 * Cross-session file locks. Composite PK (file_path, project).
 *
 * COUNT CORRECTED 2026-07-28: this said "8,138+ rows", which was true when it was
 * written and had been false since coordination-release.ts started releasing
 * claims on SessionEnd. Measured today: 92. It is now a live WORKING SET that
 * rises and falls, not an append-only pile — so treat any number written here as
 * a dated observation rather than a property of the table, and re-measure rather
 * than quoting this line back.
 */
export const fileClaims = pgTable('file_claims', {
  filePath: text('file_path').notNull(),
  project: text('project').notNull(),
  sessionId: text('session_id'),
  claimedAt: timestamp('claimed_at'),
});

/**
 * Semantic memory. 603 rows, 100% embedded (BGE-large-en-v1.5, 1024-dim),
 * with an HNSW cosine index and a GIN full-text index already in place.
 *
 * Join notes: `projectId` is the reliable key (sha256(abspath)[:16]).
 * `sessionId` is mostly a handoff slug rather than a session UUID and joins
 * only ~26 sessions — do not build on it.
 */
export const archivalMemory = pgTable('archival_memory', {
  id: uuid('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id'),
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  embedding: vector('embedding', { dimensions: 1024 }),
  createdAt: timestamp('created_at', { withTimezone: true }),
  projectId: text('project_id'),
  scope: text('scope'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
});
