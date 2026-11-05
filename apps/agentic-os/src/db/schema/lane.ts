import { bigint, bigserial, index, integer, jsonb, text, timestamp } from 'drizzle-orm/pg-core';
import { agenticOs } from './project';

/**
 * Lanes — durable work threads that outlive the sessions working them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two or more Claude Code sessions now run concurrently on the same branch, and
 * they cannot see each other's conversation. The only channels between them are
 * this database, the filesystem, and the hooks that inject context. The first
 * attempt at a channel was a markdown file at the repo root; it failed for a
 * reason worth recording, because it is the reason this table is shaped the way
 * it is:
 *
 *   - Writing it took a 10-minute file claim, so the shared board CONTENDED WITH
 *     ITSELF. The second session to reach for it got denied by the very lock the
 *     board existed to coordinate.
 *   - It was passive. Nothing carried it into a session that did not think to
 *     open it, so "coordination" depended on remembering to look.
 *   - It had no atomic claim. Two sessions could read "lane free" in the same
 *     second and both start.
 *
 * A row fixes all three: writes are per-row so sessions do not block each other,
 * a hook can inject the current state every turn, and a conditional UPDATE makes
 * claiming a lane a single atomic decision with a definite winner.
 *
 * WHY NOT JUST USE `file_claims`
 * ------------------------------
 * Rejected deliberately. `file_claims` is per-FILE, mechanical, extremely
 * high-churn, and enforced INSIDE the Edit hot path with a millisecond budget.
 * A lane is per-WORK-ITEM, durable, coarse, and advisory — it answers "who is
 * building the reconciler" and survives every session that touches it. Folding
 * intent into the file lock would put lane semantics in the hot path and make
 * every board read a claim-path change. They are different clocks; they stay
 * different tables. The file lock stays the enforcement layer, this is the
 * intent layer, and neither needs the other to be correct.
 *
 * WHY NOT EXTEND `coordination_event`
 * -----------------------------------
 * That table is written by the LIVE hook bundle. Teaching it lane semantics
 * would mean rebuilding and redeploying `file-claims.mjs` — a global harness
 * deploy hitting every running session — to ship a coordination board. Additive
 * tables keep the blast radius entirely off the live lock. This whole layer can
 * be built, used, and thrown away without the lock ever noticing.
 */

/** Lane lifecycle. Text, not a pg enum, for the same reason `coordination_event.kind` is:
 *  adding a state should be a script change, not a migration on a shared database.
 *  The CLI validates against this list — Postgres does not.
 *
 *    backlog  — known work, nobody should start it without saying so
 *    ready    — scoped and unblocked, free to claim
 *    active   — a session holds it right now
 *    blocked  — started, then stopped on something external (name it in `note`)
 *    review   — work is done, evidence is pending, do not double-build
 *    done     — landed and verified
 */
export const LANE_STATES = ['backlog', 'ready', 'active', 'blocked', 'review', 'done'] as const;

export const lane = agenticOs.table(
  'lane',
  {
    /** Human-typed slug (`coord-claim-degraded`). The id IS the handle two humans
     *  and two agents use to mean the same thing, so it is not a uuid. */
    id: text('id').primaryKey(),

    /**
     * Which project board the lane belongs to (see the per-project lanes plan).
     * The board key is cooperative, never a security boundary: no allow or deny
     * decision may rest on it. The default keeps every pre-0004 row, and every
     * writer that has never heard of boards, on the CCv3 board. On Postgres 16 a
     * constant default is metadata-only, so adding the column rewrites nothing.
     * No FK to agentic_os.project: a constraint error must not abort a lane write.
     */
    projectKey: text('project_key').notNull().default('continuous-claude'),

    title: text('title').notNull(),

    /** Grouping for the board: agentic-os | reporting | harness | projects. */
    track: text('track').notNull().default('unsorted'),

    /**
     * The collision contract, as path globs, comma-separated.
     *
     * This is the single most load-bearing field for parallel work. Two sessions
     * are safe to run at once precisely when their lanes' scopes are disjoint,
     * and the board's job is to make that answerable before either one starts —
     * not after a merge conflict. It is advisory: nothing enforces it but the
     * sessions reading it, which is why it must be written honestly and narrowly.
     */
    scope: text('scope'),

    branch: text('branch'),

    state: text('state').notNull().default('backlog'),

    /** Lower runs first. Ties broken by id, so the ordering is total and stable —
     *  two sessions asking "what is next" independently get the same answer. */
    priority: integer('priority').notNull().default(50),

    /**
     * Zero-or-one attached session. NULL means unclaimed.
     *
     * Never write this with a bare UPDATE. Claiming goes through a conditional
     * `WHERE owner_session_id IS NULL OR <reclaimable>` so that two sessions
     * racing produce exactly one winner and one loser that is TOLD it lost.
     */
    ownerSessionId: text('owner_session_id'),

    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    /**
     * When the claim lapses. Long by design — 90 minutes, not the file lock's 10.
     * A lane spans hours of work across many edits, so a lease short enough to be
     * safe for a single file would expire mid-thought here and invite a takeover
     * of work still in progress.
     *
     * Reclamation deliberately mirrors the rule that shipped for file claims and
     * needs BOTH an expired lease AND an owner that has stopped heartbeating.
     * Either alone is not enough: a live session with a lapsed lease is still
     * working, and a dead session inside its lease is still dead.
     */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    /** Custody generation, minted on every change of owner. Same role as
     *  `file_claims.fence`: evidence of a chain of custody, not enforcement. */
    fence: integer('fence').notNull().default(0),

    /** Current status in one line, kept by whoever holds the lane. This is what
     *  the other session reads to decide whether to wait or work around. */
    note: text('note'),

    /**
     * The standing case for the lane: what it is, why it matters, what is known.
     * Long-lived prose, distinct from `note` (which is this hour's status).
     *
     * It lives in the row rather than only on the rendered board because the
     * board is generated FROM this table. Prose that exists only in the HTML is
     * prose the next render silently drops — which is exactly what would have
     * happened to the eighteen hand-written lane rationales the first time the
     * board was regenerated from the database.
     */
    rationale: text('rationale'),

    /** What would make this lane done. The acceptance test, in a sentence. */
    doneWhen: text('done_when'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lane_state_idx').on(t.state),
    index('lane_owner_idx').on(t.ownerSessionId),
    index('lane_project_track_priority_idx').on(t.projectKey, t.track, t.priority),
    index('lane_project_state_priority_idx').on(t.projectKey, t.state, t.priority, t.id),
    // No unique index on (project_key, id): id is the primary key, so such an index
    // could never reject a row the primary key had not already rejected.
  ],
);

/**
 * The append-only record of everything that happened to lanes — and the message
 * bus between sessions.
 *
 * WHY ONE TABLE FOR EVENTS AND MESSAGES
 * -------------------------------------
 * Because for a session waking up, they are the same question: "what happened
 * since I last looked?" A peer claiming the lane next to mine and a peer leaving
 * me a note are both things I need injected, in order, from one watermark. Two
 * tables would need two watermarks and an interleave at read time.
 *
 * Unlike `coordination_event`, this DOES record ordinary success (claims,
 * releases). That table refused to, to avoid one row per Edit. Lane transitions
 * happen a few dozen times a day, not thousands, and the sequence IS the audit
 * trail of who worked what.
 */
export const laneEvent = agenticOs.table(
  'lane_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /** Board the event belongs to. Broadcasts are read per board through this column. */
    projectKey: text('project_key').notNull().default('continuous-claude'),

    /**
     * Which lane. NULL is legal and meaningful: a broadcast note addressed to
     * everyone on the branch belongs to no lane.
     *
     * No FK. Same reasoning as `coordination_event`'s missing project FK — a
     * constraint error here would abort a write from a hook or CLI in the middle
     * of someone's turn, and the record of coordination must never be able to
     * veto the work it describes. Referential integrity is worth less than never
     * being the thing that breaks a session.
     */
    laneId: text('lane_id'),

    /**
     *   claimed | released | state_changed | note | handoff | done | seeded
     *
     * `note` is the message-bus kind; everything else is a lifecycle fact.
     */
    kind: text('kind').notNull(),

    /** Who did it / who is speaking. */
    sessionId: text('session_id').notNull(),

    /** Directed message: the intended recipient. NULL = broadcast to the branch. */
    toSessionId: text('to_session_id'),

    /** Human-readable body. For lifecycle events, a one-line summary. */
    body: text('body'),

    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('lane_event_occurred_at_idx').on(t.occurredAt),
    index('lane_event_lane_idx').on(t.laneId),
    index('lane_event_to_session_idx').on(t.toSessionId),
    index('lane_event_project_id_idx').on(t.projectKey, t.id),
  ],
);

/**
 * How far each session has read the event log.
 *
 * WHY A WATERMARK AND NOT A TIMESTAMP COMPARISON
 * ----------------------------------------------
 * "Show me events newer than my last prompt" is wrong twice: the DB runs UTC
 * while this machine runs UTC-5 (a bug this project has already shipped once),
 * and a session that was idle for an hour would be handed an hour of history as
 * if it were new. A monotonic id read against a stored high-water mark has
 * neither failure mode and is exactly-once by construction.
 */
export const laneWatermark = agenticOs.table('lane_watermark', {
  sessionId: text('session_id').primaryKey(),
  lastEventId: bigint('last_event_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
