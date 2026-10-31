import { expect, test } from '@playwright/test';

import { joinSnapshots, stateFilesSource, type JoinStats, type LookupRow } from '../src/server/queries/fleet-join';
import type { StateFileStats, StateSnapshot } from '../src/server/sources/state-files';

/**
 * The join between state files and the session table, as pure code (no database, no server).
 * Ways it can fail, one test each:
 *   J1 the session lookup fails and a final snapshot (`endedAt`) is counted as ended, so the source row stays ok
 *   J2 a lookup that fails for a file with no `endedAt` stops counting as `unchecked`
 *   J3 the lookup answers "no row" and an ended file stops counting as ended (the E1 rule)
 *   J4 a lookup failure does not turn the state-files source row degraded, or its detail does not say so
 */

const NOW = 1_000_000_000_000;

/** The parts of a snapshot the join reads. */
function snapshot(sessionId: string, endedAt: number | null): StateSnapshot {
  return { sessionId, at: NOW, endedAt, brief: null, step: null } as unknown as StateSnapshot;
}

const STATS: StateFileStats = { dir: 'd', filesSeen: 2, unreadable: 0, oversize: 0, tooMany: 0, dirUnreadable: false };

async function run(files: StateSnapshot[], lookup: (ids: string[]) => Promise<Map<string, LookupRow> | null>) {
  return joinSnapshots(new Map(files.map((s) => [s.sessionId, s])), new Set(), new Set(), lookup);
}

test.describe('joinSnapshots', () => {
  test('J1 a failed lookup counts a final snapshot as lookupFailed, not as ended', async () => {
    const { join } = await run([snapshot('a', NOW)], async () => null);
    expect(join.lookupFailed).toBe(1);
    expect(join.droppedEnded).toBe(0);
  });

  test('J2 a failed lookup counts a file with no endedAt as unchecked', async () => {
    const { join } = await run([snapshot('a', null)], async () => null);
    expect(join.unchecked).toBe(1);
    expect(join.lookupFailed).toBe(0);
  });

  test('J3 a lookup with no row for the id still counts an ended file as ended', async () => {
    const { join } = await run([snapshot('a', NOW)], async () => new Map());
    expect(join.droppedEnded).toBe(1);
    expect(join.lookupFailed).toBe(0);
    expect(join.noSessionRow).toBe(0);
  });
});

test.describe('stateFilesSource', () => {
  const JOIN: JoinStats = {
    matched: 0,
    quiet: 0,
    noSessionRow: 0,
    droppedEnded: 0,
    droppedStale: 0,
    unchecked: 0,
    lookupFailed: 0,
  };
  const fleet = (join: JoinStats) => ({ cards: [], ready: [], join, prs: [] });
  const files = { ok: true as const, value: { snapshots: [], stats: STATS } };

  test('J4 a lookup failure degrades the row and the detail says so; none leaves it ok', () => {
    const failed = stateFilesSource(files, fleet({ ...JOIN, lookupFailed: 2 }));
    expect(failed.status).toBe('degraded');
    expect(failed.detail).toContain('lookup failed 2');
    const clean = stateFilesSource(files, fleet(JOIN));
    expect(clean.status).toBe('ok');
    expect(clean.detail).not.toContain('lookup failed');
  });
});
