import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { redact } from '@/server/sources/redact';
import { safeMessage, scrubPathsInText } from '@/server/sources/safe-message';

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
};

export type BoardColumn = {
  state: BoardState;
  count: number;
  shown: number;
  lanes: BoardLane[];
};

export type LaneBoard = {
  status: 'ok' | 'error';
  error: string | null;
  columns: BoardColumn[];
  total: number;
};

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
};

const OWNER_STATES: readonly string[] = ['live', 'quiet', 'ended', 'unknown'];

/** Redact, scrub absolute paths, flatten whitespace, then clip. Null when nothing is left. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = scrubPathsInText(redact(value.slice(0, 20_000)).text).replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

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
  };
}

function stateOf(value: string | null): BoardState {
  return (BOARD_STATES as readonly string[]).includes(value ?? '') ? (value as BoardState) : 'backlog';
}

/** Pure: rows already ordered by priority then id. Unknown states go to backlog. */
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

/** Never throws: a failed read becomes `status: 'error'` with a path-free message. */
export async function getLaneBoard(): Promise<LaneBoard> {
  try {
    const { rows } = await db.execute<LaneRow>(sql`
      SELECT l.id, l.title, l.branch, l.track, l.state, l.owner_session_id,
        EXTRACT(EPOCH FROM l.updated_at)::float8 AS updated_epoch,
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
      ORDER BY l.priority, l.id
      LIMIT ${LANE_LIMIT}
    `);
    const columns = bucketLanes(rows);
    return { status: 'ok', error: null, columns, total: columns.reduce((sum, c) => sum + c.count, 0) };
  } catch (error) {
    return { status: 'error', error: safeMessage(error), columns: [], total: 0 };
  }
}
