import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { readSessionNames } from '@/server/sources/identity-names';
import { safeMessage } from '@/server/sources/safe-message';

import {
  buildColumns,
  countsByState,
  DONE_SHOWN,
  isTruncated,
  type BoardColumn,
  type LaneRow,
} from './lane-board-fold';
import {
  readyCoordSql,
  RECLAIMABLE_TAG_SQL,
  toReadyCoord,
  waitsOnCol,
  type CoordRaw,
  type ReadyCoord,
} from './lane-coord';
import { laneOrderSql } from './lane-sort';

/**
 * The read-only lane Board (P1b part B2).
 *
 * Two bounded SELECTs on agentic_os.lane (open lanes LIMIT 500, done lanes the newest 10), joined to public.sessions
 * for the owner, and one GROUP BY state count. The counts, not the rows, give every column count and the total.
 * The app role is SELECT-only: nothing here writes. Owner liveness follows sessions.ts and
 * fleet-sessions.ts: live = quiet 15 minutes or less on GREATEST(last_heartbeat,
 * COALESCE(last_activity_at, last_heartbeat)); quiet = up to 24 hours; ended = the relative
 * rule (ended_at is the last thing that happened) or quiet for over 24 hours; unknown = the
 * owner id has no session row (or no timestamp). Ages and comparisons run in SQL, in UTC.
 *
 * Never selected into the DTO: scope, note, rationale, the full owner session id.
 * Coordination fields (band, due, parked-until, reclaimable, waits-on) come from the rules in lane-coord.ts,
 * copied from the lane CLI; the times are text, formatted on the server.
 * Every string is redacted, then scrubbed of absolute paths, then clipped.
 */

export { BOARD_STATES, type BoardColumn, type BoardLane, type BoardState, type OwnerState } from './lane-board-fold';

export type LaneBoard = {
  /** The board key this read covers (agentic_os.lane.project_key). */
  board: string;
  status: 'ok' | 'error';
  error: string | null;
  columns: BoardColumn[];
  /** Every lane of the board, from the SQL counts. Never the number of rows the bounded read returned. */
  total: number;
  /** True when an open column holds fewer lanes than its count: the bounded read cut some. The page says so. */
  truncated: boolean;
};

/** The board the page and the endpoint show when no `project` is asked for. */
export const DEFAULT_BOARD = 'continuous-claude';

/** Open lanes only. The done column has its own read (newest DONE_SHOWN), so a long done list never cuts an open lane. */
const OPEN_LANE_LIMIT = 500;
const LIVE_MAX_SECONDS = 15 * 60;
let laneDepSeen = false;
let laneDepCheckedAt = 0;
let laneDepPending: Promise<boolean> | null = null;
const LANE_DEP_RECHECK_MS = 60_000;

/** Throws when the check itself fails: a failed check is not "the table is absent". */
async function askLaneDep(): Promise<boolean> {
  const { rows } = await db.execute<{ has: boolean }>(sql`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`);
  laneDepSeen = rows[0]?.has === true;
  laneDepCheckedAt = Date.now();
  return laneDepSeen;
}

/**
 * lane.mjs:1013-1016. A true answer is kept for the life of the process. An "absent" answer is asked again after
 * 60 s, so migration 0006 shows without a restart. Without the table the waits-on column is the empty array:
 * a SELECT that names a missing lane_dep would fail the whole board read (42P01).
 * A check that FAILS is never kept: it rejects, getLaneBoard reports `status: 'error'`, and the next read asks again.
 * An "ok" board with empty waits-on lists must mean that no lane waits, not that the check failed.
 * Callers that arrive while a check runs share its answer. The 60 s wait starts when a check ends, not when it starts.
 */
async function hasLaneDep(): Promise<boolean> {
  if (laneDepSeen) return true;
  if (laneDepPending !== null) return laneDepPending;
  if (Date.now() - laneDepCheckedAt < LANE_DEP_RECHECK_MS) return false;
  laneDepPending = askLaneDep().finally(() => {
    laneDepPending = null;
  });
  return laneDepPending;
}

/**
 * One board only: lanes with `project_key = projectKey` (bound as a parameter by the drizzle sql tag).
 * The caller validates the key (parseProjectKey). Lane ids are global; each board is a project_key.
 * Never throws: a failed read becomes `status: 'error'` with a path-free message.
 */
export async function getLaneBoard(projectKey: string = DEFAULT_BOARD): Promise<LaneBoard> {
  try {
    const withDeps = await hasLaneDep();
    // Two bounded reads and one count. Open lanes are cut at OPEN_LANE_LIMIT in the shared sort order; done lanes are
    // the newest DONE_SHOWN by update time, so a long done list can never push an open lane out (fault C4).
    const readRows = (part: 'open' | 'done') => db.execute<LaneRow>(sql`
      SELECT l.id, l.title, l.branch, l.track, l.state, l.remind_state, l.owner_session_id,
        EXTRACT(EPOCH FROM l.updated_at)::float8 AS updated_epoch,
        l.band,
        EXTRACT(EPOCH FROM l.due_at)::float8 AS due_epoch,
        EXTRACT(EPOCH FROM l.lease_expires_at)::float8 AS lease_epoch,
        EXTRACT(EPOCH FROM now())::float8 AS now_epoch,
        ${sql.raw(RECLAIMABLE_TAG_SQL)} AS reclaimable,
        ${sql.raw(waitsOnCol(withDeps))} AS waits_on,
        (l.owner_session_id IS NOT NULL
          AND l.lease_expires_at IS NOT NULL
          AND l.lease_expires_at < now()) AS lease_lapsed,
        CASE
          WHEN l.owner_session_id IS NULL THEN NULL
          WHEN o.id IS NULL THEN 'unknown'
          WHEN o.has_ended THEN 'ended'
          WHEN o.quiet_seconds IS NULL THEN 'unknown'
          WHEN o.quiet_seconds <= ${LIVE_MAX_SECONDS} THEN 'live'
          -- Silent for over 24 h with no end recorded: still "quiet" (a missing signal is not an end, see sessions.ts).
          ELSE 'quiet'
        END AS owner_state
      FROM agentic_os.lane l
      LEFT JOIN (
        -- The relative "ended" rule of sessions.ts: ended_at must be the last thing that happened.
        SELECT s.id,
          COALESCE(
            s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)),
            s.ended_at IS NOT NULL
          ) AS has_ended,
          EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC')
            - GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat))))::int
            AS quiet_seconds
        FROM public.sessions s
      ) o ON o.id = l.owner_session_id
      WHERE l.project_key = ${projectKey}
        AND ${sql.raw(part === 'done' ? "l.state = 'done'" : "l.state IS DISTINCT FROM 'done'")}
      ORDER BY ${sql.raw(part === 'done' ? 'l.updated_at DESC, l.id' : laneOrderSql('l'))}
      LIMIT ${part === 'done' ? DONE_SHOWN : OPEN_LANE_LIMIT}
    `);
    const [open, done, counted] = await Promise.all([
      readRows('open'),
      readRows('done'),
      db.execute<{ state: string | null; n: number }>(sql`
        SELECT l.state, count(*)::int AS n FROM agentic_os.lane l WHERE l.project_key = ${projectKey} GROUP BY l.state
      `),
    ]);
    const counts = countsByState(counted.rows);
    const columns: BoardColumn[] = buildColumns([...open.rows, ...done.rows], counts);
    return {
      board: projectKey,
      status: 'ok',
      error: null,
      columns,
      total: columns.reduce((sum, c) => sum + c.count, 0),
      truncated: isTruncated(columns),
    };
  } catch (error) {
    return { board: projectKey, status: 'error', error: safeMessage(error), columns: [], total: 0, truncated: false };
  }
}

const READY_COORD_SQL = readyCoordSql();

/**
 * The Ready-for-Dave coordination rows, all boards. One statement with no bound value. Throws on a failed read:
 * mission-control settles it into coord.status = 'error'. Session names come from the identity files, by id.
 */
export async function getReadyCoord(): Promise<ReadyCoord> {
  const { rows } = await db.execute<CoordRaw>(sql.raw(READY_COORD_SQL));
  const sids = rows.flatMap((r) => (r.kind === 'unread' && typeof r.sid === 'string' ? [r.sid] : []));
  return toReadyCoord(rows, await readSessionNames(sids));
}
