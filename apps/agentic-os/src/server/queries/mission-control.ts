import 'server-only';

import { checkDatabaseReady } from '@/db';

import {
  getActiveLaneCount,
  getFleetSessions,
  getHeldLanes,
  type FleetSessions,
  type HeldLane,
  type PrRow,
  type ReadyItem,
  type SessionCard,
} from '@/server/queries/fleet-sessions';
import { stateFilesSource } from '@/server/queries/fleet-join';
import type { FlowView } from '@/server/queries/lane-dash-parse';
import { DEFAULT_BOARD, getLaneBoard, getReadyCoord, type LaneBoard } from '@/server/queries/lane-board';
import { coordError, type CoordRow, type ReadyCoord } from '@/server/queries/lane-coord';
import { getFleetOverview, type FleetOverview } from '@/server/queries/projects';
import {
  getSessionDetail,
  type DetailUnavailable,
  type SessionDetail,
} from '@/server/queries/session-detail';
import { getActiveSessions, type ActiveSessions } from '@/server/queries/sessions';
import {
  foldSpendView,
  foldTiles,
  type BreaksTile,
  type QuotaTile,
  type SessionRow,
  type SpendFoldView,
  type SpendTile,
} from '@/server/queries/spend-fold';
import type { RollupResult } from '@/server/queries/spend-rollup-parse';
import { readSessionNames } from '@/server/sources/identity-names';
import { readLaneDash } from '@/server/sources/lane-dash';
import { readPrFeed, type PrFeedSnapshot } from '@/server/sources/pr-feed';
import { safeMessage } from '@/server/sources/safe-message';
import { readSpendRollup } from '@/server/sources/spend-rollup';
import { readStateFiles, type StateFiles, type StateSnapshot } from '@/server/sources/state-files';

/**
 * ONE snapshot, assembled in ONE place.
 *
 * The server-rendered page and the polling endpoint both call this, deliberately.
 * If the initial render and the 5-second refresh assembled their own shapes, the
 * screen would change composition on first poll — the classic dashboard bug where
 * a value is right for five seconds and then wrong forever, or vice versa. One
 * function means the first paint and the hundredth are the same contract.
 *
 * The three reads run concurrently but are NOT a transaction. They can therefore
 * disagree by a row or two if a session is inserted mid-flight, which is exactly
 * why `getFleetOverview()` computes its own buckets inside a single query and
 * nothing here re-derives a total by adding numbers across these three results.
 */
export type SourceStatus = 'ok' | 'degraded' | 'error';

/** One data source and how it fared on this read. `detail` never holds a session id, file content or local path. */
export type DataSource = { id: string; label: string; status: SourceStatus; detail: string };

export type StatTiles = {
  liveSessions: number;
  /** Cards whose chip is `working` / `waiting-on-dave` (the join's live cards). */
  working: number;
  waiting: number;
  needsDave: number;
  blocked: number;
  /** Sessions quiet over 15 minutes and up to 24 hours (the join's `quiet`). */
  quiet: number;
  activeLanes: number;
  /**
   * The open PRs of this repo, from the open-PR feed (the same file as the table). Null: no usable feed, so the
   * tile says "no feed" and never 0. It is NOT the PRs that live sessions watch (fault C1): that count is `prs.length`.
   */
  openPrs: number | null;
  /** The feed lists more PRs than the table shows (20): the tile reads "20+". */
  openPrsCapped: boolean;
  /** The feed is older than its stale limit: the tile says so. */
  openPrsStale: boolean;
  /** 7-day quota, from the live file with the newest `cache.lastUsedAt`. Null: not reported. */
  quota: QuotaTile;
  /** Engine and est sums over LIVE sessions only. */
  spend: SpendTile;
  /** Subagent rule breaks over LIVE sessions only. */
  breaks: BreaksTile;
};

export type { CoordRow, DetailUnavailable, LaneBoard, PrRow, ReadyCoord, ReadyItem, SessionCard, SessionDetail };

export const VIEW_IDS = ['overview', 'board', 'sessions', 'flow', 'spend'] as const;
export type ViewName = (typeof VIEW_IDS)[number];

/** A `view` from a query string: one of the known values, else null. Never an error. */
export function parseViewName(value: unknown): ViewName | null {
  const first = Array.isArray(value) ? value[0] : value;
  return VIEW_IDS.find((view) => view === first) ?? null;
}

const PROJECT_KEY_FORMAT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A board key from a query string (`?project=<key>`), checked against the registry key format.
 * Absent (null, undefined, empty array) -> `{ ok: true, key: null }`: the caller uses the default board.
 * Present but malformed (or over 64 characters) -> `{ ok: false }`: the API answers 400, the page uses the default board.
 */
export function parseProjectKey(value: unknown): { ok: true; key: string | null } | { ok: false } {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return { ok: true, key: null };
  if (typeof first !== 'string' || first.length > 64 || !PROJECT_KEY_FORMAT.test(first)) return { ok: false };
  return { ok: true, key: first };
}

/** A by-session row with the session name (from the identity file), or null when the session has none. */
export type SpendSessionRow = SessionRow & { name: string | null };

/**
 * The Spend tab: the fold of today's state files, the by-session names and the engine-by-model rollup.
 * `rollup.status` tells "not built yet" (absent or bad) from "schema not known".
 */
export type SpendView = Omit<SpendFoldView, 'bySession'> & { bySession: SpendSessionRow[]; rollup: RollupResult };

export type MissionControlSnapshot = {
  fleet: FleetOverview;
  active: ActiveSessions;
  database: { ok: true; latencyMs: number } | { ok: false; error: string };
  /** One row per session that waits on Dave: its first open, unanswered, non-stale ask, oldest first. */
  ready: ReadyItem[];
  /**
   * Lane-board signals for Dave, all boards: idle sessions with unread direct messages (counts only), parks that
   * end within 48 hours, due reminders. Ids, counts and times only. Separate from `ready` and `tiles.needsDave`.
   * A failed read is `status: 'error'` here and never fails the snapshot.
   */
  coord: ReadyCoord;
  /** One card per live session. */
  cards: SessionCard[];
  tiles: StatTiles;
  sources: DataSource[];
  /** The asked session (`?session=<id>`), or null. Non-null only when it passes the availability rules. */
  detail: SessionDetail | null;
  /** Set when a valid-format id was asked for and `detail` is null. */
  detailUnavailable: DetailUnavailable | null;
  /** PR rows of live sessions (max 20). Always present. */
  prs: PrRow[];
  /** The lane Board. Computed only when the request carries `view=board`, else null. */
  board: LaneBoard | null;
  /** The Spend tab. Computed only when the request carries `view=spend`, else null. Not `tiles.spend`. */
  spend: SpendView | null;
  /** The Flow tab: the lane-dashboard export, read only. Computed only when the request carries `view=flow`, else null. */
  flow: FlowView | null;
  /**
   * The Open pull requests table: open-prs.json and pr-spend.json, joined to lanes. Computed only for a request with
   * no `view` (the Overview and Sessions polls), else null, so the Board, Spend and Flow polls carry none of it.
   */
  prFeed: PrFeedSnapshot | null;
  /** When the server produced this, ISO-8601 UTC. The UI shows staleness relative
   *  to receipt rather than to this value — a clock difference between server and
   *  browser is not the user's problem to reason about. */
  generatedAt: string;
};

const NO_FILES: StateFiles = {
  snapshots: [],
  stats: { dir: '', filesSeen: 0, unreadable: 0, oversize: 0, tooMany: 0, dirUnreadable: false },
};

const NO_FLEET: FleetSessions = {
  cards: [],
  ready: [],
  join: { matched: 0, quiet: 0, noSessionRow: 0, droppedEnded: 0, droppedStale: 0, unchecked: 0, lookupFailed: 0 },
  prs: [],
};

/**
 * What a failed `getFleetOverview` reads as: nothing, and `reconciles: false`, so the page cannot pass it off as a
 * fleet of zero sessions that adds up. The `fleet-overview` source row says why.
 */
const NO_FLEET_OVERVIEW: FleetOverview = {
  projects: [],
  unmatched: {
    sessionCount: 0,
    rawCount: 0,
    rejected: { sessionCount: 0, rawCount: 0 },
    notOnboarded: { sessionCount: 0, rawCount: 0 },
    unseen: { sessionCount: 0, rawCount: 0 },
  },
  byHarness: { claude: 0, uuidv7: 0, legacy: 0, other: 0 },
  duplicates: 0,
  nullProject: 0,
  totalSessionRows: 0,
  reconciles: false,
};

/** What a failed `getActiveSessions` reads as: no live session. The `active-sessions` source row says why. */
const NO_ACTIVE_SESSIONS: ActiveSessions = { windowMinutes: 0, sessions: [], recentlyEnded: [], truncated: false };

/** A source row for a core read: ok, or the redacted reason it failed. */
function coreSource(
  id: string,
  label: string,
  read: { ok: true; value: unknown } | { ok: false; error: string },
): DataSource {
  return read.ok ? { id, label, status: 'ok', detail: 'read' } : { id, label, status: 'error', detail: read.error };
}

/** Run a source read. One failing source must not fail the snapshot. */
async function settle<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    // Every message that reaches a DTO is redacted, path-free and clipped (safeMessage).
    return { ok: false, error: safeMessage(error) };
  }
}

/** The lane-registry row. On a board request it adds the rows seen, and shows a failed board read. */
function laneSource(
  lanes: { ok: true; value: number } | { ok: false; error: string },
  board: LaneBoard | null,
): DataSource {
  const base = { id: 'lane-registry', label: 'Lane registry (agentic_os.lane)' };
  if (!lanes.ok) return { ...base, status: 'error', detail: lanes.error };
  if (board === null) return { ...base, status: 'ok', detail: `active lanes ${lanes.value}` };
  if (board.status === 'error') return { ...base, status: 'error', detail: board.error ?? 'board read failed' };
  return { ...base, status: 'ok', detail: `active lanes ${lanes.value}, lanes ${board.total}` };
}

/** The Spend tab. Reads the rollup file and the names of the (at most 10) by-session rows; nothing else. */
async function buildSpendView(
  snapshots: readonly StateSnapshot[],
  liveIds: ReadonlySet<string>,
  nowMs: number,
): Promise<SpendView> {
  const folded = foldSpendView(snapshots, liveIds, nowMs);
  const [rollup, names] = await Promise.all([
    readSpendRollup(folded.day),
    readSessionNames(folded.bySession.map((row) => row.sessionId)),
  ]);
  return {
    ...folded,
    bySession: folded.bySession.map((row) => ({ ...row, name: names.get(row.sessionId) ?? null })),
    rollup,
  };
}

/**
 * `sessionId` must already pass parseSessionId(); the caller validates it.
 * `withBoard` is true only for a request that carries `view=board`.
 * `withSpend` is true only for a request that carries `view=spend`.
 * `withFlow` is true only for a request that carries `view=flow`.
 * `project` is the board key for that view; it must already pass parseProjectKey(). Default: continuous-claude.
 * The active-lane tile (getActiveLaneCount) stays machine-wide: it counts every board.
 */
export async function getMissionControlSnapshot(
  sessionId: string | null = null,
  withBoard = false,
  project: string = DEFAULT_BOARD,
  withSpend = false,
  withFlow = false,
): Promise<MissionControlSnapshot> {
  const withPrFeed = !withBoard && !withSpend && !withFlow;
  // The two core reads are settled like every other source (fault C11): one failed query used to throw out of
  // Promise.all and turn the whole poll into a 503 with no reason on screen. Now the snapshot still arrives, the
  // failed part reads empty, and `sources` names the failure.
  const [databaseRaw, fleetRead, activeRead, files, lanes, heldLanes, board, flow, coordRead, prFeedRead] = await Promise.all([
    checkDatabaseReady(),
    settle(getFleetOverview),
    settle(getActiveSessions),
    settle(readStateFiles),
    settle(getActiveLaneCount),
    settle(getHeldLanes),
    withBoard ? getLaneBoard(project) : Promise.resolve(null),
    withFlow ? readLaneDash() : Promise.resolve(null),
    // The Ready strip shows on every view, so this read runs on every poll.
    settle(getReadyCoord),
    // readPrFeed never throws: a missing file is "absent", a failed lane lookup shows dashes.
    // Read on every view: the Open PRs tile shows on every view and counts this feed. The table gets it on two views only.
    readPrFeed(),
  ]);

  const database: MissionControlSnapshot['database'] = databaseRaw.ok
    ? databaseRaw
    : { ok: false, error: safeMessage(databaseRaw.error) };

  const fleet = fleetRead.ok ? fleetRead.value : NO_FLEET_OVERVIEW;
  const active = activeRead.ok ? activeRead.value : NO_ACTIVE_SESSIONS;
  const coord: ReadyCoord = coordRead.ok ? coordRead.value : coordError(coordRead.error);
  const heldByOwner = heldLanes.ok ? heldLanes.value : new Map<string, HeldLane[]>();
  // The session detail takes lane ids only.
  const laneIdsByOwner = new Map([...heldByOwner].map(([owner, held]) => [owner, held.map((lane) => lane.id)]));
  const stateFiles = files.ok ? files.value : NO_FILES;
  const nowMs = Date.now();
  const [joined, detailResult] = await Promise.all([
    settle(() => getFleetSessions(active, stateFiles, nowMs, heldByOwner)),
    sessionId === null
      ? Promise.resolve(null)
      : settle(() => getSessionDetail(sessionId, stateFiles, laneIdsByOwner, nowMs)),
  ]);
  const sessions = joined.ok ? joined.value : NO_FLEET;

  // A state file has no live flag: fold only the files of the live sessions.
  const liveIds = new Set(active.sessions.map((s) => s.id));
  const cost = foldTiles(stateFiles.snapshots, liveIds);
  const spend = withSpend ? await buildSpendView(stateFiles.snapshots, liveIds, nowMs) : null;
  const tiles: StatTiles = {
    liveSessions: active.sessions.length,
    working: sessions.cards.filter((c) => c.chip === 'working').length,
    waiting: sessions.cards.filter((c) => c.chip === 'waiting-on-dave').length,
    needsDave: sessions.ready.length,
    blocked: sessions.cards.filter((c) => c.chip === 'blocked').length,
    quiet: sessions.join.quiet,
    activeLanes: lanes.ok ? lanes.value : 0,
    openPrs: prFeedRead.status === 'ok' ? prFeedRead.rows.length : null,
    openPrsCapped: prFeedRead.status === 'ok' && prFeedRead.capped,
    openPrsStale: prFeedRead.status === 'ok' && prFeedRead.stale,
    quota: cost.quota,
    spend: cost.spend,
    breaks: cost.breaks,
  };

  const sources: DataSource[] = [
    {
      id: 'database',
      label: 'Postgres (agentic_os_app)',
      status: database.ok ? 'ok' : 'error',
      detail: database.ok ? `${database.latencyMs}ms` : database.error,
    },
    joined.ok
      ? stateFilesSource(files, sessions)
      : { id: 'state-files', label: 'Session state files', status: 'error', detail: joined.error },
    laneSource(lanes, board),
    coreSource('fleet-overview', 'Project overview (sessions table)', fleetRead),
    coreSource('active-sessions', 'Live session roster (sessions table)', activeRead),
  ];

  return {
    fleet,
    active,
    database,
    ready: sessions.ready,
    coord,
    cards: sessions.cards,
    tiles,
    sources,
    detail: detailResult?.ok ? detailResult.value.detail : null,
    // A detail read that throws shows as "unknown id", so the panel never waits on it forever.
    detailUnavailable: !detailResult
      ? null
      : detailResult.ok
        ? detailResult.value.unavailable
        : { id: sessionId as string, reason: 'unknown id' },
    prs: sessions.prs,
    board,
    spend,
    flow,
    prFeed: withPrFeed ? prFeedRead : null,
    generatedAt: new Date().toISOString(),
  };
}
