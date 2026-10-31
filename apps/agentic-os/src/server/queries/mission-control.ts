import 'server-only';

import { checkDatabaseReady } from '@/db';

import {
  getActiveLaneCount,
  getFleetSessions,
  getHeldLanes,
  type FleetSessions,
  type PrRow,
  type ReadyItem,
  type SessionCard,
} from '@/server/queries/fleet-sessions';
import { stateFilesSource } from '@/server/queries/fleet-join';
import { getLaneBoard, type LaneBoard } from '@/server/queries/lane-board';
import { getFleetOverview, type FleetOverview } from '@/server/queries/projects';
import {
  getSessionDetail,
  type DetailUnavailable,
  type SessionDetail,
} from '@/server/queries/session-detail';
import { getActiveSessions, type ActiveSessions } from '@/server/queries/sessions';
import { safeMessage } from '@/server/sources/safe-message';
import { readStateFiles, type StateFiles } from '@/server/sources/state-files';

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
  needsDave: number;
  blocked: number;
  activeLanes: number;
  openPrs: number;
};

export type { DetailUnavailable, LaneBoard, PrRow, ReadyItem, SessionCard, SessionDetail };

export const VIEW_IDS = ['overview', 'board', 'sessions'] as const;
export type ViewName = (typeof VIEW_IDS)[number];

/** A `view` from a query string: one of the three known values, else null. Never an error. */
export function parseViewName(value: unknown): ViewName | null {
  const first = Array.isArray(value) ? value[0] : value;
  return VIEW_IDS.find((view) => view === first) ?? null;
}

export type MissionControlSnapshot = {
  fleet: FleetOverview;
  active: ActiveSessions;
  database: { ok: true; latencyMs: number } | { ok: false; error: string };
  /** One row per session that waits on Dave: its first open, unanswered, non-stale ask, oldest first. */
  ready: ReadyItem[];
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

/**
 * `sessionId` must already pass parseSessionId(); the caller validates it.
 * `withBoard` is true only for a request that carries `view=board`.
 */
export async function getMissionControlSnapshot(
  sessionId: string | null = null,
  withBoard = false,
): Promise<MissionControlSnapshot> {
  const [databaseRaw, fleet, active, files, lanes, heldLanes, board] = await Promise.all([
    checkDatabaseReady(),
    getFleetOverview(),
    getActiveSessions(),
    settle(readStateFiles),
    settle(getActiveLaneCount),
    settle(getHeldLanes),
    withBoard ? getLaneBoard() : Promise.resolve(null),
  ]);

  const database: MissionControlSnapshot['database'] = databaseRaw.ok
    ? databaseRaw
    : { ok: false, error: safeMessage(databaseRaw.error) };

  const heldByOwner = heldLanes.ok ? heldLanes.value : new Map<string, string[]>();
  const stateFiles = files.ok ? files.value : NO_FILES;
  const nowMs = Date.now();
  const [joined, detailResult] = await Promise.all([
    settle(() => getFleetSessions(active, stateFiles, nowMs, heldByOwner)),
    sessionId === null
      ? Promise.resolve(null)
      : settle(() => getSessionDetail(sessionId, stateFiles, heldByOwner, nowMs)),
  ]);
  const sessions = joined.ok ? joined.value : NO_FLEET;

  const tiles: StatTiles = {
    liveSessions: active.sessions.length,
    needsDave: sessions.ready.length,
    blocked: sessions.cards.filter((c) => c.chip === 'blocked').length,
    activeLanes: lanes.ok ? lanes.value : 0,
    openPrs: sessions.prs.length,
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
  ];

  return {
    fleet,
    active,
    database,
    ready: sessions.ready,
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
    generatedAt: new Date().toISOString(),
  };
}
