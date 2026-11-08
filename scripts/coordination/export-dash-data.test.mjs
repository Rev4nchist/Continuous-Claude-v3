/**
 * export-dash-data.test -- the pure parts of the lane dashboard export (no database).
 *
 *   node --test scripts/coordination/export-dash-data.test.mjs
 *
 * The database parts (SQL, fixtures, read-only transaction) are in export-dash-data.db.test.mjs.
 * Each test names the change that breaks it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DATASETS, DOC_CAP_BYTES, buildProjectRows, buildRefreshDoc, buildSnapshotRow, checkInvariants,
  chicagoDay, clearRefreshPending, readSnapshots, upsertSnapshot, writeExport,
} from './export-dash-data.mjs';
import { compileRules } from './lane-dash-project.mjs';
import { normalizeConfig } from './lane-dash-config.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dash-export-'));
const T1 = '2026-11-08T01:00:00.000Z'; // 19:00 CT on 2026-11-07
const T2 = '2026-11-08T03:30:00.000Z'; // 21:30 CT on 2026-11-07 (same Chicago day)
const T3 = '2026-11-08T14:00:00.000Z'; // 08:00 CT on 2026-11-08

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
    envelopes: {
      lanes: env(lanes),
      assignments: env([]),
      projects: env([{ key: 'p' }, { key: 'unassigned' }]),
      targets: env([{ key: 'p0_cap', value: 5, label: 'x', source: 's' }]),
      meta: env([{ exported_at: exportedAt, today }]),
    },
  };
}
const withSnapshots = (c) => ({ ...c, envelopes: { ...c.envelopes, snapshots: { sql: 's', exportedAt: c.envelopes.lanes.exportedAt, rows: [] } } });

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
    // Breaks if the stamps are not compared across all six documents.
    const c = withSnapshots(collected(T1));
    c.envelopes.meta.exportedAt = T2;
    assert.throws(() => checkInvariants(c), /exportedAt/);
    const d = withSnapshots(collected(T1));
    d.envelopes.snapshots.exportedAt = T2;
    assert.throws(() => checkInvariants(d), /exportedAt/);
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
  it('writes the six documents and the refresh doc, atomically, with no temp files left', () => {
    // Breaks if a document is skipped, a temp file is left, or refresh.json is not written.
    const out = tmpDir();
    const r = writeExport(out, collected(T1));
    const names = fs.readdirSync(out).sort();
    assert.deepEqual(names, [...DATASETS.map((d) => `${d}.json`), 'refresh.json'].sort());
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

  it('an invariant failure writes no file at all', () => {
    // Breaks if documents are written before the invariants are checked.
    const out = tmpDir();
    assert.throws(() => writeExport(out, collected(T1, { directOpen: 99 })), /open/);
    assert.deepEqual(fs.readdirSync(out), []);
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
