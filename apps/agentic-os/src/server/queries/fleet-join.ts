import type { StateFiles, StateSnapshot } from '@/server/sources/state-files';

import type { DataSource } from './mission-control';

/**
 * The join between state files and the session table, as pure code: no database and no server
 * imports, so the e2e specs can import it (e2e/fleet-join.spec.ts). The query itself stays in
 * fleet-sessions.ts and is passed in as `lookup`. The bucket rules are in fleet-sessions.ts.
 */

export const QUIET_MAX_SECONDS = 24 * 60 * 60;
export const LOOKUP_LIMIT = 200;

export type JoinStats = {
  matched: number;
  /** Snapshots of sessions quiet for 15 minutes to 24 hours: no card, asks still in the strip. */
  quiet: number;
  noSessionRow: number;
  droppedEnded: number;
  droppedStale: number;
  unchecked: number;
  /** Final snapshots (`endedAt`) whose session lookup failed. Not counted as ended: the database gave no answer. */
  lookupFailed: number;
};

export type LookupRow = { hasEnded: boolean; quietSeconds: number | null; projectKey: string | null };

/**
 * The final snapshot (written at session.end) says the session ended: `endedAt` is not older than the
 * latest thing the file knows happened. A session that came back (a later prompt, brief change or tool
 * call) writes a newer stamp and is not ended. Used only where the database has no answer.
 */
export function endedByFile(snapshot: StateSnapshot): boolean {
  return (
    snapshot.endedAt !== null &&
    snapshot.endedAt >= Math.max(snapshot.at, snapshot.brief?.updatedAt ?? 0, snapshot.step?.startedAt ?? 0)
  );
}

/**
 * Put every snapshot in exactly one bucket. `lookup` answers for the ids that are neither live nor in
 * the recently ended list: a Map by id, or null when the query failed. Returns the counts and the
 * rows of the quiet sessions (not ended, quiet 15 minutes to 24 hours).
 */
export async function joinSnapshots(
  bySession: Map<string, StateSnapshot>,
  liveIds: Set<string>,
  endedIds: Set<string>,
  lookup: (ids: string[]) => Promise<Map<string, LookupRow> | null>,
): Promise<{ join: JoinStats; quietRows: Map<string, LookupRow> }> {
  const join: JoinStats = {
    matched: 0,
    quiet: 0,
    noSessionRow: 0,
    droppedEnded: 0,
    droppedStale: 0,
    unchecked: 0,
    lookupFailed: 0,
  };
  const leftover: string[] = [];
  for (const id of bySession.keys()) {
    if (liveIds.has(id)) join.matched += 1;
    else if (endedIds.has(id)) join.droppedEnded += 1;
    else leftover.push(id);
  }

  // The database has no answer for this id: the final snapshot may still say it ended.
  // Otherwise it is counted under `fallback`.
  const noAnswer = (id: string, fallback: 'noSessionRow' | 'unchecked'): void => {
    const snapshot = bySession.get(id);
    if (snapshot !== undefined && endedByFile(snapshot)) join.droppedEnded += 1;
    else join[fallback] += 1;
  };

  // Walk only the ids that were queried. An id past the cap was never looked up, so it is
  // `unchecked`, never `noSessionRow`.
  const queried = leftover.slice(0, LOOKUP_LIMIT);
  for (const id of leftover.slice(LOOKUP_LIMIT)) noAnswer(id, 'unchecked');
  const known = await lookup(queried);
  const quietRows = new Map<string, LookupRow>();
  if (known === null) {
    // A failed query is a fault, not an end: a final snapshot is counted apart so the source row can say so.
    for (const id of queried) {
      const snapshot = bySession.get(id);
      if (snapshot !== undefined && endedByFile(snapshot)) join.lookupFailed += 1;
      else join.unchecked += 1;
    }
  } else {
    for (const id of queried) {
      const row = known.get(id);
      if (row === undefined) noAnswer(id, 'noSessionRow');
      else if (row.hasEnded) join.droppedEnded += 1;
      // No timestamp at all, or quiet for over 24 hours: stale.
      else if (row.quietSeconds === null || row.quietSeconds > QUIET_MAX_SECONDS) join.droppedStale += 1;
      else {
        // Not in the live roster and not ended: quiet. A session that woke up between the two
        // queries lands here too, and its asks still count.
        join.quiet += 1;
        quietRows.set(id, row);
      }
    }
  }
  return { join, quietRows };
}

/** The "Session state files" row of the source list: the reader's counts and the join's counts. */
export function stateFilesSource(
  files: { ok: true; value: StateFiles } | { ok: false; error: string },
  fleet: { join: JoinStats },
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
  if (join.lookupFailed > 0) parts.push(`lookup failed ${join.lookupFailed}`);
  // `too many` shows in the detail but is not a fault by itself: the writer never prunes old files.
  const bad = stats.unreadable + stats.oversize + join.unchecked + join.lookupFailed;
  return { ...base, status: bad > 0 ? 'degraded' : 'ok', detail: parts.join(', ') };
}
