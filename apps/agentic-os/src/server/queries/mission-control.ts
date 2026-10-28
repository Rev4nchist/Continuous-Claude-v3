import 'server-only';

import { checkDatabaseReady } from '@/db';

import {
  getActiveLaneCount,
  getFleetSessions,
  type FleetSessions,
  type ReadyItem,
  type SessionCard,
} from '@/server/queries/fleet-sessions';
import { getFleetOverview, type FleetOverview } from '@/server/queries/projects';
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

export type { ReadyItem, SessionCard };

export type MissionControlSnapshot = {
  fleet: FleetOverview;
  active: ActiveSessions;
  database: { ok: true; latencyMs: number } | { ok: false; error: string };
  /** Open, unanswered, non-stale asks of live sessions, oldest first. */
  ready: ReadyItem[];
  /** One card per live session. */
  cards: SessionCard[];
  tiles: StatTiles;
  sources: DataSource[];
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
  join: { matched: 0, quiet: 0, noSessionRow: 0, droppedEnded: 0, droppedStale: 0, unchecked: 0 },
  openPrs: 0,
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

function stateFilesSource(
  files: { ok: true; value: StateFiles } | { ok: false; error: string },
  fleet: FleetSessions,
): DataSource {
  const base = { id: 'state-files', label: 'Session state files' };
  if (!files.ok) return { ...base, status: 'error', detail: files.error };
  const { stats } = files.value;
  const { join } = fleet;
  if (stats.dirUnreadable) return { ...base, status: 'degraded', detail: 'directory unreadable' };
  const parts = [
    `files ${stats.filesSeen}`,
    `unreadable ${stats.unreadable}`,
    `oversize ${stats.oversize}`,
    `too many ${stats.tooMany}`,
    `no session row ${join.noSessionRow}`,
    `ended ${join.droppedEnded}`,
    // `stale` = session quiet for over 24 h. `quiet` = 15 min to 24 h: no card, asks in the strip.
    `stale ${join.droppedStale}`,
    `quiet ${join.quiet}`,
  ];
  if (join.unchecked > 0) parts.push(`unchecked ${join.unchecked}`);
  // `too many` shows in the detail but is not a fault by itself: the writer never prunes old files.
  const bad = stats.unreadable + stats.oversize + join.unchecked;
  return { ...base, status: bad > 0 ? 'degraded' : 'ok', detail: parts.join(', ') };
}

export async function getMissionControlSnapshot(): Promise<MissionControlSnapshot> {
  const [databaseRaw, fleet, active, files, lanes] = await Promise.all([
    checkDatabaseReady(),
    getFleetOverview(),
    getActiveSessions(),
    settle(readStateFiles),
    settle(getActiveLaneCount),
  ]);

  const database: MissionControlSnapshot['database'] = databaseRaw.ok
    ? databaseRaw
    : { ok: false, error: safeMessage(databaseRaw.error) };

  const joined = await settle(() => getFleetSessions(active, files.ok ? files.value : NO_FILES));
  const sessions = joined.ok ? joined.value : NO_FLEET;

  const tiles: StatTiles = {
    liveSessions: active.sessions.length,
    needsDave: new Set(sessions.ready.map((r) => r.sessionId)).size,
    blocked: sessions.cards.filter((c) => c.chip === 'blocked').length,
    activeLanes: lanes.ok ? lanes.value : 0,
    openPrs: sessions.openPrs,
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
    {
      id: 'lane-registry',
      label: 'Lane registry (agentic_os.lane)',
      status: lanes.ok ? 'ok' : 'error',
      detail: lanes.ok ? `active lanes ${lanes.value}` : lanes.error,
    },
  ];

  return {
    fleet,
    active,
    database,
    ready: sessions.ready,
    cards: sessions.cards,
    tiles,
    sources,
    generatedAt: new Date().toISOString(),
  };
}
