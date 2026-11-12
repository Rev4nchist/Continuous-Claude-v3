import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { readSessionNames } from '@/server/sources/identity-names';
import { safeMessage } from '@/server/sources/safe-message';

import {
  cleanText,
  laneCoordFields,
  readyCoordSql,
  RECLAIMABLE_TAG_SQL,
  toReadyCoord,
  waitsOnCol,
  type CoordRaw,
  type LaneCoordFields,
  type LaneCoordRaw,
  type ReadyCoord,
} from './lane-coord';
import { laneOrderSql } from './lane-sort';

/**
 * The read-only lane Board (P1b part B2).
 *
 * One bounded SELECT on agentic_os.lane (LIMIT 500), joined to public.sessions for the owner.
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

export const BOARD_STATES = ['backlog', 'ready', 'active', 'blocked', 'review', 'done'] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export type OwnerState = 'live' | 'quiet' | 'ended' | 'unknown';

export type BoardLane = {
  id: string;
  title: string;
  branch: string | null;
  ownerShortId: string | null;
  owner: OwnerState | null;
  leaseLapsed: boolean;
  track: string | null;
} & LaneCoordFields;

export type BoardColumn = {
  state: BoardState;
  count: number;
  shown: number;
  lanes: BoardLane[];
};

export type LaneBoard = {
  /** The board key this read covers (agentic_os.lane.project_key). */
  board: string;
  status: 'ok' | 'error';
  error: string | null;
  columns: BoardColumn[];
  total: number;
};

/** The board the page and the endpoint show when no `project` is asked for. */
export const DEFAULT_BOARD = 'continuous-claude';

const LANE_LIMIT = 500;
const DONE_SHOWN = 10;
const LIVE_MAX_SECONDS = 15 * 60;

const CLIP = { id: 60, title: 120, branch: 80, track: 40, ownerShortId: 12 };

type LaneRow = {
  id: string;
  title: string | null;
  branch: string | null;
  track: string | null;
  state: string | null;
  owner_session_id: string | null;
  lease_lapsed: boolean | null;
  owner_state: string | null;
  updated_epoch: number | string | null;
} & LaneCoordRaw;

const OWNER_STATES: readonly string[] = ['live', 'quiet', 'ended', 'unknown'];

function toLane(row: LaneRow): BoardLane {
  const hasOwner = typeof row.owner_session_id === 'string' && row.owner_session_id !== '';
  const ownerState = OWNER_STATES.includes(row.owner_state ?? '')
    ? (row.owner_state as OwnerState)
    : 'unknown';
  return {
    id: cleanText(row.id, CLIP.id) ?? '?',
    title: cleanText(row.title, CLIP.title) ?? '',
    branch: cleanText(row.branch, CLIP.branch),
    ownerShortId: hasOwner ? cleanText(row.owner_session_id?.slice(0, 8), CLIP.ownerShortId) : null,
    owner: hasOwner ? ownerState : null,
    leaseLapsed: hasOwner && row.lease_lapsed === true,
    track: cleanText(row.track, CLIP.track),
    ...laneCoordFields(row),
  };
}

function stateOf(value: string | null): BoardState {
  return (BOARD_STATES as readonly string[]).includes(value ?? '') ? (value as BoardState) : 'backlog';
}

/** Pure: rows already in the shared lane sort order (band, due_at, priority, id). Unknown states go to backlog. */
function bucketLanes(rows: LaneRow[]): BoardColumn[] {
  const buckets = new Map<BoardState, { lane: BoardLane; updated: number }[]>(
    BOARD_STATES.map((state) => [state, []]),
  );
  for (const row of rows) {
    const updated = Number(row.updated_epoch ?? 0);
    buckets.get(stateOf(row.state))?.push({ lane: toLane(row), updated: Number.isFinite(updated) ? updated : 0 });
  }
  return BOARD_STATES.map((state) => {
    const items = buckets.get(state) ?? [];
    if (state === 'done') {
      items.sort((a, b) => b.updated - a.updated || a.lane.id.localeCompare(b.lane.id));
    }
    const lanes = (state === 'done' ? items.slice(0, DONE_SHOWN) : items).map((item) => item.lane);
    return { state, count: items.length, shown: lanes.length, lanes };
  });
}

let laneDepSeen = false;
let laneDepCheckedAt = 0;
let laneDepPending: Promise<boolean> | null = null;
const LANE_DEP_RECHECK_MS = 60_000;

async function askLaneDep(): Promise<boolean> {
  try {
    const { rows } = await db.execute<{ has: boolean }>(sql`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`);
    laneDepSeen = rows[0]?.has === true;
  } catch {
    laneDepSeen = false;
  }
  return laneDepSeen;
}

/**
 * lane.mjs:1013-1016. A true answer is kept for the life of the process. A false or failed check is asked again
 * after 60 s, so migration 0006 shows without a restart. Without the table the waits-on column is the empty array:
 * a SELECT that names a missing lane_dep would fail the whole board read (42P01).
 * Callers that arrive while a check runs share its answer. The 60 s wait starts when a check ends, not when it starts.
 */
async function hasLaneDep(): Promise<boolean> {
  if (laneDepSeen) return true;
  if (laneDepPending !== null) return laneDepPending;
  if (Date.now() - laneDepCheckedAt < LANE_DEP_RECHECK_MS) return false;
  laneDepPending = askLaneDep().finally(() => {
    laneDepCheckedAt = Date.now();
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
    const { rows } = await db.execute<LaneRow>(sql`
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
      ORDER BY ${sql.raw(laneOrderSql('l'))}
      LIMIT ${LANE_LIMIT}
    `);
    const columns = bucketLanes(rows);
    return { board: projectKey, status: 'ok', error: null, columns, total: columns.reduce((sum, c) => sum + c.count, 0) };
  } catch (error) {
    return { board: projectKey, status: 'error', error: safeMessage(error), columns: [], total: 0 };
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
