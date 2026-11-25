/**
 * export-dash-data.test -- the pure parts of the lane dashboard export (no database).
 *
 *   node --test scripts/coordination/export-dash-data.test.mjs
 *
 * The database parts (SQL, fixtures, read-only transaction) are in export-dash-data.db.test.mjs.
 * Each test names the change that breaks it.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DATASETS, DOC_CAP_BYTES, buildProjectRows, buildRefreshDoc, buildSnapshotRow, checkInvariants,
  chicagoDay, clearRefreshFile, heldFields, holderName, sizeReport, sizeWarnings, SIZE_WARN_PCT, buildSnapshotRow as snapRow, clearRefreshPending, cutTitle, readSnapshots, TITLE_MAX, upsertSnapshot, writeExport,
} from './export-dash-data.mjs';
import * as exportMod from './export-dash-data.mjs';
import { compileRules } from './lane-dash-project.mjs';
import { normalizeConfig } from './lane-dash-config.mjs';
import { buildFlowRows } from './lane-dash-flow.mjs';
import { buildTileRows } from './lane-dash-metrics.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-export-'));
const T1 = '2026-11-08T01:00:00.000Z'; // 19:00 CT on 2026-11-07
const T2 = '2026-11-08T03:30:00.000Z'; // 21:30 CT on 2026-11-07 (same Chicago day)
const T3 = '2026-11-08T14:00:00.000Z'; // 08:00 CT on 2026-11-08

describe('cutTitle', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  it('keeps a title that fits, byte for byte', () => {
    // Breaks if a short title gains an ellipsis or loses characters.
    assert.equal(cutTitle('Plan: CCv3 local review engine'), 'Plan: CCv3 local review engine');
    const exact = 'x'.repeat(TITLE_MAX);
    assert.equal(cutTitle(exact), exact);
  });

  it('cuts a long title at a word boundary and adds one ellipsis', () => {
    // Breaks if the cut lands inside a word (the old export cut "MAX_RUNS b" mid-word) or the result is too long.
    const out = cutTitle(words(80));
    assert.ok(out.length <= TITLE_MAX, `length ${out.length}`);
    assert.ok(out.endsWith('…'));
    const body = out.slice(0, -1);
    assert.ok(words(80).startsWith(body));
    assert.match(words(80).slice(body.length), /^ /); // the next char in the source is a space: no word was split
  });

  it('hard-cuts a long title with no spaces, still ending in an ellipsis within the limit', () => {
    // Breaks if a single long token is returned whole or throws.
    const out = cutTitle('y'.repeat(400));
    assert.equal(out.length, TITLE_MAX);
    assert.ok(out.endsWith('…'));
  });

  it('does not cut the masked handle text in half and passes null as an empty string', () => {
    // Breaks if "#[handle]" is split by the cut, or null throws.
    const t = `${'a '.repeat(77)}#[handle] tail tail tail`;
    const out = cutTitle(t);
    assert.ok(!out.includes('#[') || out.includes('#[handle]'), out);
    assert.equal(cutTitle(null), '');
  });
});

describe('chicagoDay', () => {
  it('buckets by America/Chicago, across the 2026-11-01 DST change', () => {
    // Breaks if the day is the UTC date, or a fixed -06:00 / -05:00 offset is used.
    assert.equal(chicagoDay('2026-11-01T04:30:00Z'), '2026-10-31'); // 23:30 CDT on 10-31
    assert.equal(chicagoDay('2026-11-01T06:30:00Z'), '2026-11-01'); // 01:30 CDT, before the change
    assert.equal(chicagoDay('2026-11-01T07:30:00Z'), '2026-11-01'); // 01:30 CST, after the change
    assert.equal(chicagoDay('2026-11-02T05:30:00Z'), '2026-11-01'); // 23:30 CST on 11-01
    assert.equal(chicagoDay('2026-11-02T06:00:00Z'), '2026-11-02'); // midnight CST
  });

  it('accepts a Date, returns null for null and for an invalid value', () => {
    // Breaks if an invalid date throws RangeError out of Intl.format.
    assert.equal(chicagoDay(new Date('2026-07-04T12:00:00Z')), '2026-07-04');
    assert.equal(chicagoDay(null), null);
    assert.equal(chicagoDay(undefined), null);
    assert.equal(chicagoDay('not a date'), null);
  });
});

describe('upsertSnapshot', () => {
  it('replaces a row of the same day, appends a new day, keeps day order, does not mutate', () => {
    // Breaks if the upsert pushes a duplicate row for the same day or sorts by insertion.
    const rows = [{ day: '2026-11-06', open: 1 }, { day: '2026-11-07', open: 2 }];
    const frozen = JSON.stringify(rows);
    const same = upsertSnapshot(rows, { day: '2026-11-07', open: 9 });
    assert.deepEqual(same, [{ day: '2026-11-06', open: 1 }, { day: '2026-11-07', open: 9 }]);
    const next = upsertSnapshot(rows, { day: '2026-11-08', open: 3 });
    assert.deepEqual(next.map((r) => r.day), ['2026-11-06', '2026-11-07', '2026-11-08']);
    const early = upsertSnapshot(rows, { day: '2026-11-01', open: 0 });
    assert.deepEqual(early.map((r) => r.day), ['2026-11-01', '2026-11-06', '2026-11-07']);
    assert.equal(JSON.stringify(rows), frozen);
  });
});

const lane = (o = {}) => ({
  id: 'l', title: 't', project: 'p', track: 'x', band: null, state: 'backlog', priority: 50,
  created_at: '2026-11-01T15:00:00.000Z', created_day: '2026-11-01', first_claim_at: null, done_at: null, done_day: null,
  last_work_at: null, lease_expires_at: null, held: false, has_done_when: false, dave_ask_at: null, terminal: false, claims: 0, ...o,
});

describe('buildSnapshotRow', () => {
  it('counts open lanes by state, band and lease from the lanes rows', () => {
    // Breaks if done lanes are counted open, a lapsed lease is missed, or an unbanded lane is lost.
    const lanes = [
      lane({ id: 'a', state: 'backlog', band: 'P0' }),
      lane({ id: 'b', state: 'active', band: 'P1', claims: 1, last_work_at: T1, lease_expires_at: '2026-11-08T02:00:00.000Z' }),
      lane({ id: 'c', state: 'active', band: 'P2', claims: 2, last_work_at: T1, lease_expires_at: '2026-11-07T01:00:00.000Z' }),
      lane({ id: 'd', state: 'blocked' }),
      lane({ id: 'e', state: 'ready', band: 'P2', last_work_at: T1, claims: 1 }),
      lane({ id: 'f', state: 'done', done_at: T1, done_day: '2026-11-07', last_work_at: T1, claims: 1 }),
    ];
    const r = buildSnapshotRow(lanes, T1);
    assert.equal(r.day, '2026-11-07');
    assert.equal(r.snapshot_at, T1);
    assert.deepEqual(
      { open: r.open, done: r.done, backlog: r.backlog, ready: r.ready, active: r.active, blocked: r.blocked, lapsed: r.lapsed },
      { open: 5, done: 1, backlog: 1, ready: 1, active: 2, blocked: 1, lapsed: 1 },
    );
    assert.deepEqual({ p0: r.p0_open, p1: r.p1_open, p2: r.p2_open, none: r.unbanded_open }, { p0: 1, p1: 1, p2: 2, none: 1 });
    assert.equal(r.never_claimed_open, 2); // a and d
  });
});

const rules = () => compileRules({
  version: 1,
  projects: [
    { key: 'p', name: 'P', goal: 'g', done: 'd', terminalLanes: ['t1', 't2'] },
    { key: 'q', name: 'Q', goal: 'g', done: 'd' },
    { key: 'r', name: 'R', goal: 'g', done: 'd', terminalLanes: ['r1', 'ghost'], parked: true },
  ],
});
const cfg = () => normalizeConfig({});

describe('buildProjectRows (defect b)', () => {
  it('is Done only when every terminal lane is done; reports N of M', () => {
    // Breaks if Done means "zero open lanes" (the index.html:458 bug) or one done terminal lane is enough.
    const lanes = [
      lane({ id: 't1', project: 'p', terminal: true, state: 'done', done_at: '2026-11-05T15:00:00.000Z', done_day: '2026-11-05' }),
      lane({ id: 't2', project: 'p', terminal: true, state: 'ready' }),
      lane({ id: 'other', project: 'p', state: 'done', done_at: T1, done_day: '2026-11-07' }),
    ];
    const p = buildProjectRows(rules(), lanes, cfg()).find((x) => x.key === 'p');
    assert.equal(p.terminal_total, 2);
    assert.equal(p.terminal_done, 1);
    assert.equal(p.status, 'open');
    assert.equal(p.done_at, null);
    assert.equal(p.visible_until, null);
  });

  it('is Done when all terminal lanes are done even if other lanes are open; done_at is the latest terminal done', () => {
    // Breaks if open non-terminal lanes keep the project open, or done_at is the earliest instead of the latest.
    const lanes = [
      lane({ id: 't1', project: 'p', terminal: true, state: 'done', done_at: '2026-11-03T15:00:00.000Z', done_day: '2026-11-03' }),
      lane({ id: 't2', project: 'p', terminal: true, state: 'done', done_at: '2026-11-05T15:00:00.000Z', done_day: '2026-11-05' }),
      lane({ id: 'extra', project: 'p', state: 'backlog' }),
    ];
    const p = buildProjectRows(rules(), lanes, cfg()).find((x) => x.key === 'p');
    assert.equal(p.status, 'done');
    assert.equal(p.terminal_done, 2);
    assert.equal(p.done_at, '2026-11-05T15:00:00.000Z');
    assert.equal(p.done_day, '2026-11-05');
  });

  it('keeps a Done project in the rows and visible for 28 days after done_at', () => {
    // Breaks if a finished project is dropped from the rows (the index.html:462 bug) or the window is 7 days.
    const lanes = [
      lane({ id: 't1', project: 'p', terminal: true, state: 'done', done_at: '2026-10-18T15:00:00.000Z', done_day: '2026-10-18' }), // 3 weeks before 11-08
      lane({ id: 't2', project: 'p', terminal: true, state: 'done', done_at: '2026-10-18T16:00:00.000Z', done_day: '2026-10-18' }),
    ];
    const rows = buildProjectRows(rules(), lanes, cfg());
    const p = rows.find((x) => x.key === 'p');
    assert.ok(p, 'Done project is still in the rows');
    assert.equal(p.status, 'done');
    assert.equal(p.visible_until, '2026-11-15'); // 2026-10-18 + 28 days
  });

  it('a project with no terminal lanes is "no_end", never Done', () => {
    // Breaks if 0 of 0 counts as done.
    const rows = buildProjectRows(rules(), [], cfg());
    const q = rows.find((x) => x.key === 'q');
    assert.equal(q.terminal_total, 0);
    assert.equal(q.status, 'no_end');
    assert.equal(rows.find((x) => x.key === 'unassigned').status, 'no_end');
  });

  it('a terminal lane missing from the board counts toward M but is not done; a reopened one is not done', () => {
    // Breaks if a missing lane is skipped (project Done too early) or a reopened lane keeps its old done state.
    const lanes = [lane({ id: 'r1', project: 'r', terminal: true, state: 'ready', done_at: null })];
    const r = buildProjectRows(rules(), lanes, cfg()).find((x) => x.key === 'r');
    assert.equal(r.terminal_total, 2);
    assert.equal(r.terminal_done, 0);
    assert.equal(r.status, 'open');
    assert.equal(r.parked, true);
  });

  it('carries goal, done_when and the terminal ids as text, and a closing unassigned row', () => {
    // Breaks if the project rows lose the text the page shows.
    const rows = buildProjectRows(rules(), [], cfg());
    const p = rows.find((x) => x.key === 'p');
    assert.equal(p.done_when, 'd');
    assert.equal(p.terminal_lanes, 't1, t2');
    assert.equal(rows.at(-1).key, 'unassigned');
  });
});

describe('refresh trigger doc (defect g)', () => {
  it('starts pending with a key that is the exportedAt, and names its clearing call', () => {
    // Breaks if the doc has no key or no named clearing call (PR 2's pending key had none).
    const doc = buildRefreshDoc(T1, ['lanes.json', 'meta.json']);
    assert.equal(doc.pending, true);
    assert.equal(doc.key, T1);
    assert.deepEqual(doc.files, ['lanes.json', 'meta.json']);
    assert.equal(doc.cleared_at, null);
    assert.deepEqual(doc.clear_with, { tool: 'ArtifactData', action: 'write', target: 'datasets/lanes' });
  });

  it('the clearing call with the matching key resets it', () => {
    // Breaks if clearRefreshPending does not flip pending.
    const doc = buildRefreshDoc(T1, []);
    const cleared = clearRefreshPending(doc, T1, T2);
    assert.equal(cleared.pending, false);
    assert.equal(cleared.cleared_at, T2);
    assert.equal(doc.pending, true, 'does not mutate its input');
  });

  it('a clear for an older key does not reset a newer pending export', () => {
    // Breaks if any clear resets: an old upload would hide a newer export that was never uploaded.
    const newer = buildRefreshDoc(T3, []);
    const after = clearRefreshPending(newer, T1, T2);
    assert.equal(after.pending, true);
    assert.equal(after.cleared_at, null);
  });

  it('clearing twice is harmless and a missing doc stays absent', () => {
    // Breaks if a second clear moves cleared_at or a null doc throws.
    const once = clearRefreshPending(buildRefreshDoc(T1, []), T1, T2);
    assert.deepEqual(clearRefreshPending(once, T1, T3), once);
    assert.equal(clearRefreshPending(null, T1, T2), null);
  });
});

// ---- collected fixtures for checkInvariants and writeExport
function collected(exportedAt, { lanes = [lane({ id: 'a', state: 'backlog' }), lane({ id: 'b', state: 'done', done_at: exportedAt, done_day: chicagoDay(exportedAt) })], directOpen, bornDone } = {}) {
  const env = (rows) => ({ sql: 'x', exportedAt, rows });
  const today = chicagoDay(exportedAt);
  return {
    ...(bornDone ? { bornDone } : {}),
    directOpen: directOpen ?? lanes.filter((l) => l.state !== 'done').length,
    rework: [],
    envelopes: {
      lanes: env(lanes),
      assignments: env([]),
      projects: env(['p', 'unassigned'].map((key) => ({
        key, name: key, goal: '', done_when: '', terminal_lanes: '', terminal_total: 0, terminal_done: 0, status: 'no_end',
        done_at: null, done_day: null, visible_until: null, parked: false, proposed: false, focus: false,
      }))),
      targets: env([{ key: 'p0_cap', value: 5, label: 'x', source: 's' }]),
      meta: env([{
        exported_at: exportedAt, today, history_start: '2026-11-01', band_history_start: '2026-11-07', board: 'b', board_url: 'https://example.test/b',
        stale_after_hours: 36, projects_stale_after_hours: 168, timezone: 'America/Chicago',
        open_check: lanes.filter((l) => l.state !== 'done').length, done_check: lanes.filter((l) => l.state === 'done').length,
      }]),
    },
  };
}
/** Adds the snapshots, tiles and flow documents the way writeExport does, so checkInvariants sees all eight. */
const withSnapshots = (c) => {
  const e = c.envelopes;
  const exportedAt = e.lanes.exportedAt;
  const snapshots = { sql: 's', exportedAt, rows: [] };
  const tiles = {
    sql: 't', exportedAt,
    rows: buildTileRows({
      lanes: e.lanes.rows, assignments: e.assignments.rows, projects: e.projects.rows, targets: e.targets.rows, meta: e.meta.rows[0], snapshots: snapshots.rows,
    }),
  };
  const flow = {
    sql: 'f', exportedAt,
    rows: buildFlowRows({ lanes: e.lanes.rows, assignments: e.assignments.rows, rework: c.rework, targets: e.targets.rows, meta: e.meta.rows[0] }),
  };
  return { ...c, envelopes: { ...e, snapshots, tiles, flow } };
};

describe('checkInvariants', () => {
  it('passes a consistent export', () => {
    // Breaks if a valid export is refused (false positive).
    assert.doesNotThrow(() => checkInvariants(withSnapshots(collected(T1))));
  });

  it('fails when a document is over 256 KB, and names the file', () => {
    // Breaks if the size cap is not checked per document, or is checked in characters not bytes.
    assert.equal(DOC_CAP_BYTES, 262144);
    const c = withSnapshots(collected(T1));
    c.envelopes.targets.rows = [{ key: 'big', value: 1, label: 'é'.repeat(140000), source: 's' }]; // 2 bytes per char
    assert.throws(() => checkInvariants(c), /targets.*(262144|256 KB)/s);
  });

  it('fails when exportedAt differs between documents', () => {
    // Breaks if the stamps are not compared across all eight documents.
    const c = withSnapshots(collected(T1));
    c.envelopes.meta.exportedAt = T2;
    assert.throws(() => checkInvariants(c), /exportedAt/);
    const d = withSnapshots(collected(T1));
    d.envelopes.snapshots.exportedAt = T2;
    assert.throws(() => checkInvariants(d), /exportedAt/);
  });

  it('covers the tiles document: missing, over 256 KB, or a different exportedAt each fail and name tiles.json', () => {
    // Breaks if tiles is left out of DATASETS, so its cap and stamp are never checked.
    assert.ok(DATASETS.includes('tiles'));
    const missing = withSnapshots(collected(T1));
    delete missing.envelopes.tiles;
    assert.throws(() => checkInvariants(missing), /tiles\.json is missing/);
    const notRows = withSnapshots(collected(T1));
    notRows.envelopes.tiles.rows = 'x';
    assert.throws(() => checkInvariants(notRows), /tiles\.json is missing or has no rows/);
    const big = withSnapshots(collected(T1));
    big.envelopes.tiles.rows = [{ id: 'x', tile: 1, kind: 'text', rank: null, value: null, text: 'é'.repeat(140000), tone: null }];
    assert.throws(() => checkInvariants(big), /tiles\.json.*(262144|256 KB)/s);
    const skew = withSnapshots(collected(T1));
    skew.envelopes.tiles.exportedAt = T2;
    assert.throws(() => checkInvariants(skew), /exportedAt/);
  });

  it('covers the flow document: missing, over 256 KB, or a different exportedAt each fail and name flow.json', () => {
    // Breaks if flow is left out of DATASETS, so its cap and stamp are never checked.
    assert.ok(DATASETS.includes('flow'));
    const missing = withSnapshots(collected(T1));
    delete missing.envelopes.flow;
    assert.throws(() => checkInvariants(missing), /flow\.json is missing/);
    const big = withSnapshots(collected(T1));
    big.envelopes.flow.rows = [{ id: 'x', tile: 'flow', kind: 'text', rank: null, value: null, text: 'é'.repeat(140000), tone: null }];
    assert.throws(() => checkInvariants(big), /flow\.json.*(262144|256 KB)/s);
    const skew = withSnapshots(collected(T1));
    skew.envelopes.flow.exportedAt = T2;
    assert.throws(() => checkInvariants(skew), /exportedAt/);
  });

  it('fails when a lane project is not in the projects rows', () => {
    // Breaks if the project/lanes cross check is removed.
    const c = withSnapshots(collected(T1, { lanes: [lane({ id: 'a', project: 'missing' })] }));
    assert.throws(() => checkInvariants(c), /missing/);
  });

  it('fails when the rebuilt open count differs from the direct count', () => {
    // Breaks if created-minus-done is not compared with the direct SELECT count.
    const c = withSnapshots(collected(T1, { directOpen: 7 }));
    assert.throws(() => checkInvariants(c), /open/);
  });

  it('a done lane with no done_at shows up as an open-count mismatch', () => {
    // Breaks if a state=done lane without a done event is silently counted done.
    const lanes = [lane({ id: 'x', state: 'done', done_at: null, done_day: null })];
    const c = withSnapshots(collected(T1, { lanes, directOpen: 0 }));
    assert.throws(() => checkInvariants(c), /open/);
  });

  it('a lane born done (only a seeded event) passes, and any other done lane without a done signal still fails', () => {
    // Breaks if bornDone is ignored (the first assertion) or if it excuses lanes that are not in the list (the second).
    const lanes = [lane({ id: 'x', state: 'done', done_at: null, done_day: null })];
    assert.doesNotThrow(() => checkInvariants(withSnapshots(collected(T1, { lanes, directOpen: 0, bornDone: ['x'] }))));
    assert.throws(() => checkInvariants(withSnapshots(collected(T1, { lanes, directOpen: 0, bornDone: ['other'] }))), /open/);
  });

  it('reports every problem, not only the first', () => {
    // Breaks if the check stops at the first failure.
    const c = withSnapshots(collected(T1, { lanes: [lane({ id: 'a', project: 'missing' })], directOpen: 9 }));
    c.envelopes.meta.exportedAt = T2;
    try { checkInvariants(c); assert.fail('should throw'); } catch (e) { assert.ok(e.problems.length >= 3, e.message); }
  });
});

describe('writeExport', () => {
  it('writes the eight documents and the refresh doc, atomically, with no temp files left', () => {
    // Breaks if a document is skipped (tiles.json included), a temp file is left, or refresh.json is not written.
    const out = tmpDir();
    const r = writeExport(out, collected(T1));
    const names = fs.readdirSync(out).sort();
    assert.equal(DATASETS.length, 8);
    assert.deepEqual(names, ['assignments.json', 'flow.json', 'lanes-all.json', 'lanes.json', 'meta.json', 'projects.json', 'refresh.json', 'snapshots.json', 'targets.json', 'tiles.json']);
    assert.deepEqual(names, [...DATASETS.map((d) => `${d}.json`), 'lanes-all.json', 'refresh.json'].sort());
    for (const d of DATASETS) {
      const doc = JSON.parse(fs.readFileSync(path.join(out, `${d}.json`), 'utf8'));
      assert.equal(doc.exportedAt, T1, d);
      assert.ok(Array.isArray(doc.rows), d);
    }
    const refresh = JSON.parse(fs.readFileSync(path.join(out, 'refresh.json'), 'utf8'));
    assert.equal(refresh.pending, true);
    assert.equal(refresh.key, T1);
    assert.equal(r.exportedAt, T1);
  });

  it('tiles.json is built from the in-memory documents with exported_at as "now", and lists itself in refresh.json', () => {
    // Breaks if tiles is computed before the snapshots document, from the browser or process clock, or left out of the refresh file list.
    const out = tmpDir();
    // mock.timers replaces Date itself (new Date() too); a wrong clock would change the ages and the stamp
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
    try {
      writeExport(out, collected(T1, { lanes: [lane({ id: 'a', state: 'blocked', dave_ask_at: '2026-11-06T01:00:00.000Z', last_work_at: T1 })] }));
    } finally {
      mock.timers.reset();
    }
    const tiles = JSON.parse(fs.readFileSync(path.join(out, 'tiles.json'), 'utf8'));
    assert.deepEqual(Object.keys(tiles).sort(), ['exportedAt', 'rows', 'sql']);
    const get = (id) => tiles.rows.find((r) => r.id === id);
    assert.equal(tiles.exportedAt, T1);
    assert.equal(get('wait.count').value, 1);
    assert.equal(get('wait.oldest').value, 2); // 2026-11-08T01:00 minus 2026-11-06T01:00 on the export clock
    assert.equal(get('page.data_from').text, 'Nov 7, 7:00 PM CST');
    assert.equal(get('pile.trend.note').text, 'Trend after 7 daily snapshots: 1 so far'); // the snapshots document is built first
    const refresh = JSON.parse(fs.readFileSync(path.join(out, 'refresh.json'), 'utf8'));
    assert.ok(refresh.files.includes('tiles.json'));
    assert.ok(refresh.files.includes('flow.json'));
  });

  it('flow.json is built from the in-memory documents and the rework rows, with meta.today as "today", and carries no lane id', () => {
    // Breaks if the rework rows are not passed to buildFlowRows, flow is computed from a clock, or a lane id reaches flow.json.
    const out = tmpDir();
    const c = collected(T1, { lanes: [lane({ id: 'secret-lane', state: 'ready' })] });
    c.rework = [{ lane_id: 'secret-lane', done_at: '2026-11-07T15:00:00.000Z', reopen_at: '2026-11-07T16:00:00.000Z' }];
    c.reworkSql = 'SELECT rework-marker';
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
    try {
      writeExport(out, c);
    } finally {
      mock.timers.reset();
    }
    const flow = JSON.parse(fs.readFileSync(path.join(out, 'flow.json'), 'utf8'));
    assert.deepEqual(Object.keys(flow).sort(), ['exportedAt', 'rows', 'sql']);
    assert.equal(flow.exportedAt, T1);
    assert.ok(flow.sql.includes('rework-marker'));
    const get = (id) => flow.rows.find((r) => r.id === id);
    assert.equal(get('flow.bar.14.reopened').value, 1); // today is 2026-11-07 on the export clock: rank 14
    assert.equal(get('flow.week.rework.lanes').value, 1);
    assert.equal(get('flow.week.rework.pct').text, '100.0%');
    assert.ok(!JSON.stringify(flow).includes('secret-lane'));
  });

  it('adds one snapshot row per Chicago day: a second run the same day replaces, a new day appends, .bak is kept', () => {
    // Breaks if the snapshot upsert appends a duplicate day or the .bak copy is skipped.
    const out = tmpDir();
    writeExport(out, collected(T1));
    assert.equal(fs.existsSync(path.join(out, 'snapshots.json.bak')), false, 'no .bak when there was no previous file');
    writeExport(out, collected(T2, { lanes: [lane({ id: 'a' }), lane({ id: 'c' })] }));
    let snaps = readSnapshots(path.join(out, 'snapshots.json'));
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].open, 2);
    assert.equal(snaps[0].snapshot_at, T2);
    assert.ok(fs.existsSync(path.join(out, 'snapshots.json.bak')));
    writeExport(out, collected(T3));
    snaps = readSnapshots(path.join(out, 'snapshots.json'));
    assert.deepEqual(snaps.map((s) => s.day), ['2026-11-07', '2026-11-08']);
  });

  it('snapshots.json.bak is written once per Chicago day: later runs the same day keep it, the first run of a new day replaces it', () => {
    // Breaks if every 30-minute run overwrites the .bak, so it covers 30 minutes and not one day (lane fleetops-bak-once-a-day).
    const out = tmpDir();
    const bakFile = path.join(out, 'snapshots.json.bak');
    const snapFile = path.join(out, 'snapshots.json');
    writeExport(out, collected(T1));
    writeExport(out, collected(T2, { lanes: [lane({ id: 'a' }), lane({ id: 'c' })] })); // same day: the .bak is the T1 file
    const bakAfterSecond = fs.readFileSync(bakFile, 'utf8');
    assert.equal(readSnapshots(bakFile)[0].snapshot_at, T1);
    writeExport(out, collected(T2, { lanes: [lane({ id: 'a' }), lane({ id: 'c' }), lane({ id: 'd' })] })); // third run, same day
    assert.equal(fs.readFileSync(bakFile, 'utf8'), bakAfterSecond, 'a later run on the same day must not replace the .bak');
    assert.notEqual(fs.readFileSync(snapFile, 'utf8'), bakAfterSecond, 'the snapshots file moved on');
    const endOfDay = fs.readFileSync(snapFile, 'utf8');
    writeExport(out, collected(T3)); // first run of the next day: the .bak is the file as the old day left it
    assert.equal(fs.readFileSync(bakFile, 'utf8'), endOfDay);
    const bakDayTwo = fs.readFileSync(bakFile, 'utf8');
    writeExport(out, collected(T3, { lanes: [lane({ id: 'z' })] })); // later run, day two
    assert.equal(fs.readFileSync(bakFile, 'utf8'), bakDayTwo);
  });

  it('a snapshots file that does not parse fails the export and changes nothing', () => {
    // Breaks if a parse error is swallowed and an empty history is written over the old one.
    const out = tmpDir();
    const bad = '{"sql": "oops", "rows": [';
    fs.writeFileSync(path.join(out, 'snapshots.json'), bad);
    assert.throws(() => writeExport(out, collected(T1)), /snapshots\.json/);
    assert.equal(fs.readFileSync(path.join(out, 'snapshots.json'), 'utf8'), bad);
    assert.deepEqual(fs.readdirSync(out), ['snapshots.json']);
  });

  it('an empty snapshots file, or one without a rows array, also fails', () => {
    // Breaks if a zero-byte file is read as "no history" and replaced.
    for (const content of ['', '{}', '{"rows": 5}', 'null']) {
      const out = tmpDir();
      fs.writeFileSync(path.join(out, 'snapshots.json'), content);
      assert.throws(() => writeExport(out, collected(T1)), /snapshots\.json/, JSON.stringify(content));
      assert.equal(fs.readFileSync(path.join(out, 'snapshots.json'), 'utf8'), content);
    }
  });

  it('an invariant failure writes no data file, only export-error.json with reason checks', () => {
    // Breaks if documents are written before the invariants are checked, or the failure leaves no trace for the doctor.
    const out = tmpDir();
    assert.throws(() => writeExport(out, collected(T1, { directOpen: 99 })), /open/);
    assert.deepEqual(fs.readdirSync(out), ['export-error.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'export-error.json'), 'utf8')).reason, 'checks');
  });

  it('a held lock fails the export and writes nothing', () => {
    // Breaks if two exports can write the snapshot history at once.
    const out = tmpDir();
    fs.writeFileSync(path.join(out, '.export.lock'), String(process.pid));
    assert.throws(() => writeExport(out, collected(T1)), /lock/i);
    assert.deepEqual(fs.readdirSync(out), ['.export.lock']);
  });

  it('releases the lock after a successful run and after a failed one', () => {
    // Breaks if the lock is left behind and every later run fails.
    const out = tmpDir();
    writeExport(out, collected(T1));
    assert.ok(!fs.existsSync(path.join(out, '.export.lock')));
    assert.throws(() => writeExport(out, collected(T2, { directOpen: 99 })));
    assert.ok(!fs.existsSync(path.join(out, '.export.lock')));
  });
});

describe('clearRefreshFile (PR 409 follow-up: same lock as writeExport, own temp name)', () => {
  const exported = () => {
    const out = tmpDir();
    writeExport(out, collected(T1));
    return out;
  };
  const refreshPath = (out) => path.join(out, 'refresh.json');

  it('a normal clear flips pending for the same key, leaves no lock or temp file, and ignores an older key', () => {
    // Breaks if taking the lock stops the clear from working, or the lock or a temp file is left behind.
    const out = exported();
    const stale = clearRefreshFile(out, '2020-01-01T00:00:00.000Z', T3);
    assert.equal(stale.pending, true);
    const doc = clearRefreshFile(out, T1, T3);
    assert.equal(doc.pending, false);
    assert.equal(doc.cleared_at, T3);
    assert.equal(JSON.parse(fs.readFileSync(refreshPath(out), 'utf8')).pending, false);
    assert.ok(!fs.existsSync(path.join(out, '.export.lock')));
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.includes('.tmp')), []);
    assert.equal(clearRefreshFile(tmpDir(), T1, T3), null);
  });

  it('a held lock throws like writeExport and leaves refresh.json unchanged', () => {
    // Breaks if clearRefreshFile skips the .export.lock that writeExport holds while it renames refresh.json.
    const out = exported();
    const before = fs.readFileSync(refreshPath(out), 'utf8');
    fs.writeFileSync(path.join(out, '.export.lock'), String(process.pid));
    assert.throws(() => clearRefreshFile(out, T1, T3), /lock/i);
    assert.equal(fs.readFileSync(refreshPath(out), 'utf8'), before);
    assert.ok(fs.existsSync(path.join(out, '.export.lock')), 'the other holder keeps its lock');
  });

  it('does not use writeExport\'s refresh.json.tmp name', () => {
    // Breaks if the clear writes or renames refresh.json.tmp, which a running export owns.
    const out = exported();
    const sentinel = path.join(out, 'refresh.json.tmp');
    fs.writeFileSync(sentinel, 'EXPORT-OWNED');
    clearRefreshFile(out, T1, T3);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'EXPORT-OWNED');
    assert.equal(JSON.parse(fs.readFileSync(refreshPath(out), 'utf8')).pending, false);
  });

  it('releases the lock when the refresh file does not parse', () => {
    // Breaks if the lock is left behind after a failed clear and every later export fails.
    const out = exported();
    fs.writeFileSync(refreshPath(out), '{oops');
    assert.throws(() => clearRefreshFile(out, T1, T3));
    assert.ok(!fs.existsSync(path.join(out, '.export.lock')));
  });
});

describe('heldFields and holderName (fleetops-category-expand)', () => {
  const EXP = '2026-11-13T16:00:00.000Z';
  const names = { 'aaaa1111-0000-4000-8000-000000000001': 'FleetOps builder' };
  const nameOf = (u) => names[u] ?? null;
  const row = (o = {}) => ({ owner_session_id: 'aaaa1111-0000-4000-8000-000000000001', note: 'GOAL: show the work. | NEXT: x at abc1234',
    lease_expires_at: new Date('2026-11-13T17:00:00Z'), ...o });

  it('a lane with no owner gets no keys at all', () => {
    // Breaks if goal or holder is written on every row (lanes.json has 27 KB of room left).
    assert.deepEqual(heldFields(row({ owner_session_id: null }), EXP, nameOf), {});
  });

  it('a held lane gets the GOAL sentence, the session name and parked false; the raw note never passes', () => {
    // Breaks if the note, the uuid or the SHA after " | " reaches the row.
    const f = heldFields(row(), EXP, nameOf);
    assert.deepEqual(f, { goal: 'show the work.', holder: 'FleetOps builder', parked: false });
    assert.ok(!JSON.stringify(f).includes('abc1234'));
    assert.ok(!JSON.stringify(f).includes('aaaa1111'));
  });

  it('an ended lease gives holder null: a gone session is not named', () => {
    // Breaks if held (owner not null) alone names the holder.
    assert.equal(heldFields(row({ lease_expires_at: new Date('2026-11-13T15:59:59Z') }), EXP, nameOf).holder, null);
    assert.equal(heldFields(row({ lease_expires_at: null }), EXP, nameOf).holder, null);
  });

  it('a parked note gives parked true and still finds the GOAL after " || "', () => {
    // Breaks if a waiting session reads as active work (seat word 10:51, item 6a).
    const f = heldFields(row({ note: 'PARKED until 2026-11-14 -- waits || GOAL: g. | NEXT: n' }), EXP, nameOf);
    assert.equal(f.parked, true);
    assert.equal(f.goal, 'g.');
  });

  it('holderName clips to 16 characters and masks hex ids; empty gives null', () => {
    // Breaks if a name holding a session id or handle reaches the dashboard.
    assert.equal(holderName('FleetOps builder #b2b46d90'), 'FleetOps builder');
    assert.ok(!/[0-9a-f]{8}/.test(holderName('b2b46d90-5361-424d-a80d') ?? ''));
    assert.equal(holderName(''), null);
    assert.equal(holderName(null), null);
    assert.equal(holderName('  '), null);
  });

  it('40 held lanes at the goal limit add under 12 KB', () => {
    // Breaks if the goal cut goes or more fields are added per held lane.
    const long = `GOAL: ${'word '.repeat(100)}`;
    const many = Array.from({ length: 40 }, () => heldFields(row({ note: long }), EXP, () => 'x'.repeat(40)));
    assert.ok(JSON.stringify(many).length < 12 * 1024, String(JSON.stringify(many).length));
  });
});

describe('buildProjectRows next_goal (fleetops-category-expand)', () => {
  it('passes next_goal from the rules; absent gives an empty string', () => {
    // Breaks if the export drops next_goal: the page then never shows the Next goal line.
    const r = compileRules({ version: 1, projects: [{ key: 'p', name: 'P', next_goal: 'Retire CodeRabbit for HIGH.' }, { key: 'q', name: 'Q' }] });
    const rows = buildProjectRows(r, [], cfg());
    assert.equal(rows.find((x) => x.key === 'p').next_goal, 'Retire CodeRabbit for HIGH.');
    assert.equal(rows.find((x) => x.key === 'q').next_goal, '');
    assert.equal(rows.find((x) => x.key === 'unassigned').next_goal, '');
  });
});

describe('lanes.json keeps open cards only (fleetops-lanes-file-size part 2)', () => {
  const OLD = '2026-10-20T15:00:00.000Z';
  const fixture = () => [
    lane({ id: 'open-1', state: 'backlog', project: 'p' }),
    lane({ id: 'open-2', state: 'active', project: 'p', held: true }),
    lane({ id: 'done-new', state: 'done', project: 'p', done_at: T1, done_day: chicagoDay(T1) }),
    lane({ id: 'done-old', state: 'done', project: 'p', created_at: OLD, created_day: '2026-10-20', done_at: OLD, done_day: '2026-10-20' }),
  ];

  it('writes only the lanes that are not done', () => {
    // Breaks if the trim is off, or keeps a done lane: lanes.json then grows with the whole history.
    const out = tmpDir();
    writeExport(out, collected(T1, { lanes: fixture() }));
    const doc = JSON.parse(fs.readFileSync(path.join(out, 'lanes.json'), 'utf8'));
    assert.deepEqual(doc.rows.map((l) => l.id).sort(), ['open-1', 'open-2']);
    assert.match(doc.sql, /open lanes only/);
  });

  it('every figure is the same as one built from the full lane list', () => {
    // Breaks if tiles, flow, snapshots or projects are built after the trim: closed counts would lose the done lanes.
    const out = tmpDir();
    const c = collected(T1, { lanes: fixture() });
    const r = writeExport(out, c);
    const read = (d) => JSON.parse(fs.readFileSync(path.join(out, `${d}.json`), 'utf8'));
    const full = withSnapshots(c).envelopes;
    const snaps = read('snapshots').rows;
    assert.deepEqual(snaps.at(-1), snapRow(fixture(), T1));
    const e = c.envelopes;
    const tiles = buildTileRows({ lanes: fixture(), assignments: e.assignments.rows, projects: e.projects.rows, targets: e.targets.rows, meta: e.meta.rows[0], snapshots: snaps });
    assert.deepEqual(read('tiles').rows, tiles);
    assert.deepEqual(read('flow').rows, full.flow.rows);
    assert.deepEqual(read('projects').rows, e.projects.rows);
    const closed = read('tiles').rows.find((x) => /^cat\.row\.\d+\.closed$/.test(x.id) && x.text.includes('of 4'));
    assert.ok(closed, 'a category row counts all 4 cards, the 2 done ones included');
    assert.equal(r.envelopes.lanes.rows.length, 2);
  });

  it('lanes-all.json keeps the full list on this machine; it is no dataset and not in refresh.json', () => {
    // Breaks if local tools lose the done lanes, or the full list reaches the upload list.
    const out = tmpDir();
    writeExport(out, collected(T1, { lanes: fixture() }));
    const all = JSON.parse(fs.readFileSync(path.join(out, 'lanes-all.json'), 'utf8'));
    assert.deepEqual(all.rows.map((l) => l.id).sort(), ['done-new', 'done-old', 'open-1', 'open-2']);
    assert.ok(!DATASETS.includes('lanes-all'));
    assert.ok(!JSON.parse(fs.readFileSync(path.join(out, 'refresh.json'), 'utf8')).files.includes('lanes-all.json'));
  });

  it('meta says how many lane rows exist and how many were written', () => {
    // Breaks if a reader of the Sources panel cannot see that lanes.json is partial.
    const out = tmpDir();
    writeExport(out, collected(T1, { lanes: fixture() }));
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).rows[0];
    assert.equal(meta.lanes_rows_total, 4);
    assert.equal(meta.lanes_rows_written, 2);
  });

  it('the project check still sees done lanes', () => {
    // Breaks if checkInvariants reads only the written rows: a done lane with an unknown project would pass unseen.
    const lanes = [...fixture(), lane({ id: 'ghost-done', state: 'done', project: 'ghost', done_at: T1, done_day: chicagoDay(T1) })];
    assert.throws(() => writeExport(tmpDir(), collected(T1, { lanes })), /ghost-done.*ghost/);
  });
});

describe('size warning and size failure (fleetops-lanes-file-size part 2)', () => {
  const CAP = DOC_CAP_BYTES;
  it('sizeReport names the largest document; sizeWarnings lists each one at 75% or more', () => {
    // Breaks if the early warning goes, or fires below 75%.
    const files = [{ name: 'lanes.json', bytes: Math.ceil(CAP * 0.8) }, { name: 'tiles.json', bytes: Math.floor(CAP * 0.74) }, { name: 'refresh.json', bytes: 400 }];
    assert.deepEqual(sizeReport(files), { name: 'lanes.json', bytes: Math.ceil(CAP * 0.8), pct: 80 });
    const lines = sizeWarnings(files);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^WARN size: lanes\.json \d+ of 262144 bytes \(80%\)$/);
    assert.equal(SIZE_WARN_PCT, 75);
  });

  it('lanes-all.json, local only with no cap, never warns and is never the largest document', () => {
    // Breaks if the full local list (91% on 2026-11-13) raises a false warning or a false doctor WARN.
    const files = [{ name: 'lanes-all.json', bytes: CAP }, { name: 'lanes.json', bytes: 1000 }];
    assert.deepEqual(sizeWarnings(files), []);
    assert.equal(sizeReport(files).name, 'lanes.json');
  });

  it('refresh.json carries largest_doc', () => {
    // Breaks if the harness doctor has nothing to read.
    const out = tmpDir();
    writeExport(out, collected(T1));
    const refresh = JSON.parse(fs.readFileSync(path.join(out, 'refresh.json'), 'utf8'));
    assert.equal(typeof refresh.largest_doc.name, 'string');
    assert.ok(refresh.largest_doc.bytes > 0 && refresh.largest_doc.pct >= 0);
  });

  it('a document over the cap writes export-error.json with reason size; the next good export removes it', () => {
    // Breaks if a failed export leaves no trace for the doctor, or an old failure stays after a good run.
    const out = tmpDir();
    const big = [lane({ id: 'huge', state: 'backlog', project: 'p', title: 'x'.repeat(CAP) })];
    assert.throws(() => writeExport(out, collected(T1, { lanes: big })), /over the 262144 byte/);
    const err = JSON.parse(fs.readFileSync(path.join(out, 'export-error.json'), 'utf8'));
    assert.equal(err.reason, 'size');
    assert.ok(err.problems.some((p) => /lanes\.json/.test(p)));
    assert.ok(!fs.existsSync(path.join(out, 'lanes.json')), 'nothing else is written');
    writeExport(out, collected(T1));
    assert.ok(!fs.existsSync(path.join(out, 'export-error.json')));
  });
});

describe('sessionLabel and maskLabelKeys (lane-export-per-session)', () => {
  // Read through the namespace so a missing export fails these rows only, not the whole file.
  const sessionLabel = (...a) => exportMod.sessionLabel(...a);
  const maskLabelKeys = (...a) => exportMod.maskLabelKeys(...a);
  const U1 = 'aaaa1111-0000-4000-8000-000000000001';
  const nameOf = (u) => ({ [U1]: 'Builder one' })[u] ?? null;

  it('G1 sessionLabel writes "name #sid8", "#sid8" with no name, and null with no session', () => {
    // Breaks if the label drops the sid8, shows more than 8 hex of the uuid, or invents a label for a missing session.
    assert.equal(sessionLabel(U1, nameOf), 'Builder one #aaaa1111');
    assert.equal(sessionLabel('bbbb2222-0000-4000-8000-000000000002', nameOf), '#bbbb2222');
    assert.equal(sessionLabel(null, nameOf), null);
    assert.equal(sessionLabel(undefined, nameOf), null);
    assert.ok(!sessionLabel(U1, nameOf).includes(U1));
  });

  it('G2 sessionLabel keeps no hex run of the name: a uuid inside a name is dropped, the clip is the session-label clip', () => {
    // Breaks if a session named after its own uuid puts the uuid into the export.
    const l = sessionLabel(U1, () => `x ${U1} ${'y'.repeat(40)}`);
    assert.ok(!l.includes('aaaa1111-0000'), l);
    assert.match(l, /^x y{1,15} #aaaa1111$|^x #aaaa1111$/);
    assert.ok(l.length <= 16 + ' #aaaa1111'.length, l);
  });

  it('G3 maskLabelKeys masks a label whose sid8 prefix-matches a listed sha, keeps the name part, and counts it', () => {
    // Breaks if a label bypasses maskLaneRows, or a masked label loses its name (the row must stay readable).
    const rows = [{ by: 'Gone session #abcdef12' }, { by: 'Builder one #aaaa1111' }, { by: null }, { lane_id: 'x' }];
    const n = maskLabelKeys(rows, ['by'], ['abcdef1']);
    assert.equal(n, 1);
    assert.ok(rows[0].by.startsWith('Gone session '), rows[0].by);
    assert.ok(rows[0].by.includes('masked-id'), rows[0].by);
    assert.ok(!rows[0].by.includes('abcdef12'));
    assert.equal(rows[1].by, 'Builder one #aaaa1111');
    assert.equal(rows[2].by, null);
    assert.ok(!('by' in rows[3]));
  });

  it('G4 maskLabelKeys masks every named key and touches no other key', () => {
    // Breaks if only the first key is masked, or a lane title or id is changed by the label pass.
    const rows = [{ closed_by: 'A #abcdef12', holder_label: 'B #abcdef12', title: 'abcdef12 stays', id: 'abcdef12' }];
    assert.equal(maskLabelKeys(rows, ['closed_by', 'holder_label'], ['abcdef1']), 2);
    assert.ok(rows[0].closed_by.includes('masked-id') && rows[0].holder_label.includes('masked-id'));
    assert.equal(rows[0].title, 'abcdef12 stays');
    assert.equal(rows[0].id, 'abcdef12');
  });

  it('G5 maskLabelKeys with an empty id list changes nothing and says 0', () => {
    // Breaks if an empty list is treated as "mask everything". The caller drops the keys when the list is missing.
    const rows = [{ by: 'A #abcdef12' }];
    assert.equal(maskLabelKeys(rows, ['by'], []), 0);
    assert.equal(rows[0].by, 'A #abcdef12');
  });
});
