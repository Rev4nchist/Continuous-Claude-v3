/**
 * Lane dependency SQL builders: drift test for the two twins.
 *
 * The builders live in a plain-JS module (scripts/coordination/lane-dep.mjs) and a hook twin
 * (shared/lane-dep.ts). A change to one copy that is not mirrored fails here. The pinned strings
 * below are literals, not built from the code under test.
 * Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, "Point 4".
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tsTwin from '../shared/lane-dep.js';

// This sits outside tsc's rootDir, so load it by URL at run time.
const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const mjsTwin: typeof tsTwin = await import(/* @vite-ignore */ url('../../../../scripts/coordination/lane-dep.mjs'));

const NAMES = ['landedShaSql', 'laneMetSql', 'lifecycleWhere', 'openDepSql', 'waitsOnSql'];
type Builder = (alias: string) => string;
const builders = (twin: typeof tsTwin): Record<string, Builder> => ({
  landedShaSql: twin.landedShaSql,
  laneMetSql: twin.laneMetSql,
  openDepSql: twin.openDepSql,
  waitsOnSql: twin.waitsOnSql,
  lifecycleWhere: twin.lifecycleWhere,
});

// The pinned text of the contract for alias l, with every inner builder inlined.
const LANDED_L =
  "(SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = l.id AND " +
  "(ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) " +
  'ORDER BY ld_e.id DESC LIMIT 1)';
const MET_L = `(l.state = 'done' AND COALESCE(${LANDED_L} ~ '^[0-9a-f]{40}$', false))`;
const MET_XD =
  "(ld_x.state = 'done' AND COALESCE((SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = ld_x.id AND " +
  "(ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) " +
  "ORDER BY ld_e.id DESC LIMIT 1) ~ '^[0-9a-f]{40}$', false))";
const OPEN_EDGE_L =
  'ld_d.lane_id = l.id AND NOT EXISTS (SELECT 1 FROM agentic_os.lane ld_x WHERE ld_x.id = ld_d.depends_on ' +
  `AND ld_x.project_key = ld_d.project_key AND ${MET_XD})`;

const PINNED_L: Record<string, string> = {
  landedShaSql: LANDED_L,
  laneMetSql: MET_L,
  openDepSql: `EXISTS (SELECT 1 FROM agentic_os.lane_dep ld_d WHERE ${OPEN_EDGE_L})`,
  waitsOnSql: `ARRAY(SELECT ld_d.depends_on FROM agentic_os.lane_dep ld_d WHERE ${OPEN_EDGE_L} ORDER BY ld_d.depends_on)`,
};

describe('lane dep twin drift', () => {
  it('both copies export exactly the 5 names', () => {
    expect(Object.keys(mjsTwin).sort()).toEqual(NAMES);
    expect(Object.keys(tsTwin).sort()).toEqual(NAMES);
  });

  it('each export returns the same string in both copies, for the aliases l, lane and x', () => {
    const mjs = builders(mjsTwin);
    const ts = builders(tsTwin);
    for (const alias of ['l', 'lane', 'x']) {
      for (const name of NAMES) {
        expect(mjs[name](alias), `${name}('${alias}')`).toBe(ts[name](alias));
      }
    }
  });

  it('the 4 lane builders for alias l equal the pinned text of the contract', () => {
    for (const twin of [mjsTwin, tsTwin]) {
      const b = builders(twin);
      for (const name of Object.keys(PINNED_L)) expect(b[name]('l'), name).toBe(PINNED_L[name]);
    }
  });

  it('lifecycleWhere equals the pinned lifecycle text, and landedShaSql filters with it', () => {
    const pinned = "(e.kind IN ('done','state_changed') OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state'))";
    for (const twin of [mjsTwin, tsTwin]) {
      expect(twin.lifecycleWhere('e')).toBe(pinned);
      // The public builder refuses the ld_ prefix, so rename the alias in its text to get the inner form.
      const inner = twin.lifecycleWhere('e').replace(/\be\./g, 'ld_e.');
      expect(twin.landedShaSql('l')).toContain(`ld_e.lane_id = l.id AND ${inner} ORDER BY ld_e.id DESC LIMIT 1`);
    }
  });

  it('a different alias changes only the alias: the inner aliases stay ld_d, ld_x and ld_e', () => {
    for (const twin of [mjsTwin, tsTwin]) {
      expect(twin.openDepSql('lane')).toContain('ld_d.lane_id = lane.id');
      expect(twin.waitsOnSql('x')).toContain('ld_d.lane_id = x.id');
      expect(twin.laneMetSql('x')).toContain('ld_e.lane_id = x.id');
    }
  });

  it('every export refuses a bad alias, with the same message, in both copies', () => {
    for (const twin of [mjsTwin, tsTwin]) {
      const b = builders(twin);
      for (const name of NAMES) {
        for (const bad of ['l; DROP TABLE x', 'ld_x', 'ld_', 'L', '1l', '', 'l.x']) {
          expect(() => b[name](bad), `${name}(${JSON.stringify(bad)})`).toThrow(`lane-dep: bad alias "${bad}"`);
        }
      }
    }
  });

  it('a missing or non-string alias is refused', () => {
    for (const twin of [mjsTwin, tsTwin]) {
      expect(() => (twin.laneMetSql as (a?: unknown) => string)(undefined)).toThrow('lane-dep: bad alias "undefined"');
    }
  });
});
