/**
 * Lane sort key: drift test for its three copies.
 *
 * The key lives in a plain-JS module (scripts/coordination/lane-sort.mjs), a hook twin
 * (shared/lane-sort.ts) and an SQL-only copy for the Agentic OS app (queries/lane-sort.ts).
 * A change to one copy that is not mirrored fails here.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tsTwin from '../shared/lane-sort.js';

// These sit outside tsc's rootDir, so load them by URL at run time.
const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const mjsTwin: typeof tsTwin = await import(/* @vite-ignore */ url('../../../../scripts/coordination/lane-sort.mjs'));
const appCopy: { laneOrderSql: (alias: string) => string } =
  await import(/* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/lane-sort.ts'));

const rows: tsTwin.SortableLane[] = [
  { id: 'a', band: null, priority: 1 },
  { id: 'b', band: 'P2', priority: 1 },
  { id: 'c', band: 'P1', priority: 50 },
  { id: 'd', band: 'P0', priority: 999 },
  { id: 'e', band: 'P0', priority: 5, due_at: '2026-11-08T00:00:00Z' },
  { id: 'f', band: 'P0', priority: 90, due_at: '2026-11-07T00:00:00Z' },
  { id: 'g', band: 'P0', priority: 5 },
  { id: 'h', band: 'P0', priority: 5, state: 'done' },
  { id: 'i', priority: 2 },
];

describe('lane sort twin drift', () => {
  it('both JS copies export the same names', () => {
    expect(Object.keys(mjsTwin).sort()).toEqual(Object.keys(tsTwin).sort());
    expect(Object.keys(tsTwin).sort()).toEqual(['bandRank', 'bandTag', 'compareLanes', 'laneOrderSql', 'sortOpenLanes']);
  });

  it('the comparator gives the same order and the same tags on both copies', () => {
    expect(mjsTwin.sortOpenLanes(rows).map((l) => l.id)).toEqual(tsTwin.sortOpenLanes(rows).map((l) => l.id));
    expect(tsTwin.sortOpenLanes(rows).map((l) => l.id)).toEqual(['f', 'e', 'g', 'd', 'c', 'b', 'a', 'i']);
    for (const band of ['P0', 'P1', 'P2', null, undefined, 'P9']) {
      expect(mjsTwin.bandTag(band)).toBe(tsTwin.bandTag(band));
    }
  });

  it('the SQL fragment is the same string in all three copies, for each alias in use', () => {
    for (const alias of ['l', 'lane']) {
      expect(mjsTwin.laneOrderSql(alias)).toBe(tsTwin.laneOrderSql(alias));
      expect(appCopy.laneOrderSql(alias)).toBe(tsTwin.laneOrderSql(alias));
    }
  });

  it('the SQL fragment reads the real columns directly, in key order', () => {
    expect(tsTwin.laneOrderSql('l')).toBe(
      "CASE l.band WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, l.due_at ASC NULLS LAST, l.priority, l.id",
    );
  });

  it('all three SQL copies refuse a bad alias', () => {
    for (const fn of [mjsTwin.laneOrderSql, tsTwin.laneOrderSql, appCopy.laneOrderSql]) {
      expect(() => fn('l; DROP TABLE x')).toThrow(/bad alias/);
    }
  });
});
