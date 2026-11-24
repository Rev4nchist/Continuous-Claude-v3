/**
 * The pure part of the lane Board: lane rows and state counts in, columns out.
 *
 * PURE on purpose: no 'server-only', no '@/' import, so the pure Playwright config loads it in Node
 * (e2e/tiles-truth-fold.spec.ts). lane-board.ts holds the SQL and re-exports these names.
 *
 * Why a count is not `rows.length` (card agentic-os-tiles-truth, fault C4): the row query is bounded, and a bounded
 * query that counts its own rows reports the cut as if it were the board. The counts come from a second,
 * unbounded `GROUP BY state` query. A column shows "N of M" when its rows are fewer than its count.
 */
import { cleanText, laneCoordFields, type LaneCoordFields, type LaneCoordRaw } from './lane-coord';

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
  /** The true number of lanes in this state on the board, from SQL. Never the length of the rows that came back. */
  count: number;
  shown: number;
  lanes: BoardLane[];
};

export type LaneRow = {
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

/** The done column shows its newest lanes only, by design. */
export const DONE_SHOWN = 10;

const CLIP = { id: 60, title: 120, branch: 80, track: 40, ownerShortId: 12 };
const OWNER_STATES: readonly string[] = ['live', 'quiet', 'ended', 'unknown'];

function toLane(row: LaneRow): BoardLane {
  const hasOwner = typeof row.owner_session_id === 'string' && row.owner_session_id !== '';
  const ownerState = OWNER_STATES.includes(row.owner_state ?? '') ? (row.owner_state as OwnerState) : 'unknown';
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

export function stateOf(value: string | null): BoardState {
  return (BOARD_STATES as readonly string[]).includes(value ?? '') ? (value as BoardState) : 'backlog';
}

/** `GROUP BY state` rows to one count per board state. An unknown or null state counts as backlog, as `stateOf` does. */
export function countsByState(rows: readonly { state: string | null; n: number | string }[]): Map<BoardState, number> {
  const counts = new Map<BoardState, number>(BOARD_STATES.map((state) => [state, 0]));
  for (const row of rows) {
    const n = Number(row.n);
    const state = stateOf(row.state);
    counts.set(state, (counts.get(state) ?? 0) + (Number.isFinite(n) ? n : 0));
  }
  return counts;
}

/**
 * Rows already in the shared lane sort order (band, due_at, priority, id). Done rows are cut to the newest
 * DONE_SHOWN by update time. `counts` gives the true column counts.
 */
export function buildColumns(rows: readonly LaneRow[], counts: ReadonlyMap<BoardState, number>): BoardColumn[] {
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
    // A count never reads below the rows in hand, so a missing count row cannot show "3 of 0".
    return { state, count: Math.max(counts.get(state) ?? 0, lanes.length), shown: lanes.length, lanes };
  });
}

/** True when an OPEN column holds fewer rows than its count: the row query cut lanes the page cannot show. Done is cut by design. */
export function isTruncated(columns: readonly BoardColumn[]): boolean {
  return columns.some((column) => column.state !== 'done' && column.shown < column.count);
}
