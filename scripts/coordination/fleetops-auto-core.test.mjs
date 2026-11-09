// Isolated tests for scripts/coordination/fleetops-auto-core.mjs (pure functions, no I/O).
//
// How the core can fail, one test group each below (and the source change that makes the test fail):
//   skip rules      each of the four skip causes must skip, and the first cause wins        (drop one rule, or reorder)
//   gate            equal hash clears; a different hash or no stored hash leaves pending    (invert the compare)
//   no refresh doc  a clear with no refresh doc or key cannot run: skip, not clear          (drop the guard)
//   mask            exportedAt, meta exported_at, snapshot_at never change the hash         (drop one mask)
//   mask scope      a real field that looks like a mask target is NOT masked in other sets (mask every id the same way)
//   no mutation     maskDoc never changes its input                                          (mask in place)
//   real change     a changed lane row or tile row changes the hash                         (hash fewer files)
//   missing         a missing dataset throws, it never hashes "undefined"                    (drop the check)
//   flow, factory   hashSet never touches the flow or factory documents                     (loop over every key)
//   tiles stamp     a re-export of the same data a few minutes later (real buildTileRows) gives the same hash   (drop the tiles mask)
//   tiles real      a real tile change still changes the hash                               (mask the whole tiles set)
//   order           key order of the input object does not change the hash                  (iterate the input keys)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, hashSet, maskDoc, SET_IDS } from './fleetops-auto-core.mjs';
import { buildTileRows, formatChicago } from './lane-dash-metrics.mjs';

const REFRESH = { pending: true, key: '2026-11-09T14:59:00.000Z' };
const base = (over = {}) => ({
  switchOn: true, lockHeld: false, exportExit: 0, exportLockHeld: false,
  refresh: REFRESH, lastUploadedHash: 'aaa', newHash: 'bbb', ...over,
});

// ---------------------------------------------------------------- decide: skips

test('decide skips when the switch is off', () => {
  const d = decide(base({ switchOn: false }));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /switch/i);
});

test('decide skips when the tick lock is held', () => {
  const d = decide(base({ lockHeld: true }));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /lock/i);
});

test('decide skips when the export exits 1 (Docker down)', () => {
  const d = decide(base({ exportExit: 1 }));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /export/i);
});

test('decide skips on any other export failure too (a timeout is null, a crash is 2)', () => {
  assert.equal(decide(base({ exportExit: null })).action, 'skip');
  assert.equal(decide(base({ exportExit: 2 })).action, 'skip');
});

test('decide skips when the export lock is held, even with exit 0', () => {
  const d = decide(base({ exportLockHeld: true }));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /export lock/i);
});

test('decide: a skip cause beats a matching hash (no clear while the export is not fresh)', () => {
  for (const over of [{ switchOn: false }, { lockHeld: true }, { exportExit: 1 }, { exportLockHeld: true }]) {
    assert.equal(decide(base({ ...over, newHash: 'aaa' })).action, 'skip', JSON.stringify(over));
  }
});

// ---------------------------------------------------------------- decide: the gate

test('decide clears when the hash equals the last uploaded hash', () => {
  assert.equal(decide(base({ newHash: 'aaa' })).action, 'clear');
});

test('decide leaves pending when the hash differs', () => {
  const d = decide(base({ newHash: 'bbb' }));
  assert.equal(d.action, 'leave-pending');
  assert.match(d.reason, /changed/i);
});

test('decide leaves pending when no hash was ever uploaded', () => {
  for (const lastUploadedHash of [null, undefined, '']) {
    assert.equal(decide(base({ lastUploadedHash })).action, 'leave-pending', String(lastUploadedHash));
  }
});

test('decide: two missing hashes are not "equal"', () => {
  assert.equal(decide(base({ lastUploadedHash: null, newHash: null })).action, 'leave-pending');
});

test('decide cannot clear without a refresh doc or a key: skip', () => {
  for (const refresh of [null, undefined, {}, { pending: true }]) {
    assert.equal(decide(base({ refresh, newHash: 'aaa' })).action, 'skip', JSON.stringify(refresh));
  }
});

// ---------------------------------------------------------------- maskDoc

const lanes = () => ({ exportedAt: '2026-11-09T14:59:00.000Z', rows: [{ id: 'l1', snapshot_at: 'keep', exported_at: 'keep' }] });
const meta = () => ({ exportedAt: 'T1', rows: [{ exported_at: 'T1', open: 4 }] });
const snaps = () => ({ exportedAt: 'T1', rows: [{ day: '2026-11-08', snapshot_at: 'T0', open: 3 }, { day: '2026-11-09', snapshot_at: 'T1', open: 4 }] });

test('maskDoc nulls the top-level exportedAt of every set', () => {
  for (const id of SET_IDS) assert.equal(maskDoc(id, { exportedAt: 'T', rows: [] }).exportedAt, null, id);
});

test('maskDoc nulls meta.rows[0].exported_at and keeps the other meta fields', () => {
  const m = maskDoc('meta', meta());
  assert.equal(m.rows[0].exported_at, null);
  assert.equal(m.rows[0].open, 4);
});

test('maskDoc nulls snapshot_at in every snapshots row and keeps day and counts', () => {
  const s = maskDoc('snapshots', snaps());
  assert.deepEqual(s.rows.map((r) => r.snapshot_at), [null, null]);
  assert.deepEqual(s.rows.map((r) => r.day), ['2026-11-08', '2026-11-09']);
  assert.deepEqual(s.rows.map((r) => r.open), [3, 4]);
});

test('maskDoc masks only what it must: lanes rows keep snapshot_at and exported_at', () => {
  const l = maskDoc('lanes', lanes());
  assert.equal(l.rows[0].snapshot_at, 'keep');
  assert.equal(l.rows[0].exported_at, 'keep');
});

test('maskDoc does not change its input', () => {
  const docs = { lanes: lanes(), meta: meta(), snapshots: snaps() };
  const before = JSON.stringify(docs);
  for (const [id, d] of Object.entries(docs)) maskDoc(id, d);
  assert.equal(JSON.stringify(docs), before);
});

// ---------------------------------------------------------------- hashSet

const docSet = () => ({
  lanes: lanes(),
  tiles: { exportedAt: 'T1', rows: [{ id: 't1', value: 5 }] },
  assignments: { exportedAt: 'T1', rows: [] },
  projects: { exportedAt: 'T1', rows: [{ project: 'p' }] },
  targets: { exportedAt: 'T1', rows: [] },
  meta: meta(),
  snapshots: snaps(),
});

test('hashSet: the same data gives the same 64-hex hash', () => {
  const h = hashSet(docSet());
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashSet(docSet()), h);
});

test('hashSet: a new exportedAt, meta exported_at and snapshot_at do not change the hash', () => {
  const next = docSet();
  for (const id of SET_IDS) next[id].exportedAt = '2026-11-09T15:30:00.000Z';
  next.meta.rows[0].exported_at = '2026-11-09T15:30:00.000Z';
  next.snapshots.rows[1].snapshot_at = '2026-11-09T15:30:00.000Z';
  assert.equal(hashSet(next), hashSet(docSet()));
});

test('hashSet: a real change in any one of the 7 sets changes the hash', () => {
  const h = hashSet(docSet());
  const change = {
    lanes: (d) => { d.lanes.rows[0].id = 'l2'; },
    tiles: (d) => { d.tiles.rows[0].value = 6; },
    assignments: (d) => { d.assignments.rows.push({ a: 1 }); },
    projects: (d) => { d.projects.rows[0].project = 'q'; },
    targets: (d) => { d.targets.rows.push({ t: 1 }); },
    meta: (d) => { d.meta.rows[0].open = 5; },
    snapshots: (d) => { d.snapshots.rows[1].open = 9; },
  };
  for (const id of SET_IDS) {
    const d = docSet();
    change[id](d);
    assert.notEqual(hashSet(d), h, `a change in ${id} must change the hash`);
  }
});

test('hashSet: the same content moved to a different set changes the hash', () => {
  const a = docSet();
  const b = docSet();
  a.targets = { exportedAt: 'T1', rows: [{ x: 1 }] };
  b.assignments = { exportedAt: 'T1', rows: [{ x: 1 }] };
  b.targets = { exportedAt: 'T1', rows: [] };
  a.assignments = { exportedAt: 'T1', rows: [] };
  assert.notEqual(hashSet(a), hashSet(b));
});

test('hashSet throws, naming the id, when a set is missing', () => {
  for (const id of SET_IDS) {
    const d = docSet();
    delete d[id];
    assert.throws(() => hashSet(d), new RegExp(id), `missing ${id}`);
  }
  assert.throws(() => hashSet({ ...docSet(), tiles: undefined }), /tiles/);
});

test('hashSet never reads the flow or factory documents', () => {
  const d = docSet();
  for (const id of ['flow', 'factory']) {
    Object.defineProperty(d, id, { enumerable: true, get() { throw new Error(`hashSet read ${id}`); } });
  }
  assert.equal(hashSet(d), hashSet(docSet()));
});

test('hashSet: the order of keys in the input does not change the hash', () => {
  const d = docSet();
  const reversed = Object.fromEntries(Object.entries(d).reverse());
  assert.equal(hashSet(reversed), hashSet(d));
});

test('SET_IDS is the fixed order lanes, tiles, assignments, projects, targets, meta, snapshots', () => {
  assert.deepEqual([...SET_IDS], ['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots']);
});

// ---------------------------------------------------------------- tiles carry a minute-precision stamp of meta.exported_at

const REAL_META = (exportedAt) => ({
  exported_at: exportedAt, today: '2026-11-09', history_start: '2026-10-27', band_history_start: '2026-11-07', board: 'b',
  board_url: 'https://example.test/board', stale_after_hours: 36, projects_stale_after_hours: 168, timezone: 'America/Chicago',
  open_check: 1, done_check: 0,
});
const REAL_LANE = (state) => ({
  id: 'x1', title: 't', project: 'p', track: null, band: 'P0', state, priority: null, created_at: '2026-11-01T12:00:00.000Z',
  created_day: '2026-11-01', first_claim_at: null, done_at: null, done_day: null, last_work_at: '2026-11-08T12:00:00.000Z',
  dave_ask_at: null, lease_expires_at: null, held: false, has_done_when: false, terminal: false, claims: 0,
});
/** The 7 sets as the export builds them, with the REAL buildTileRows. */
function realExport(exportedAt, laneState = 'active') {
  const meta = REAL_META(exportedAt);
  const asking = { ...REAL_LANE('blocked'), id: 'x2', dave_ask_at: '2026-11-08T05:00:00.000Z' };
  const lanes = [REAL_LANE(laneState), asking];
  const snapshots = [{ day: '2026-11-09', snapshot_at: exportedAt, open: 1 }];
  const tiles = buildTileRows({ lanes, assignments: [], projects: [], targets: [], meta, snapshots });
  const env = (rows) => ({ exportedAt, rows });
  return { lanes: env(lanes), tiles: env(tiles), assignments: env([]), projects: env([]), targets: env([]), meta: env([meta]), snapshots: env(snapshots) };
}
const T1 = '2026-11-09T15:03:11.000Z';
const T2 = '2026-11-09T15:05:11.000Z'; // 2 minutes later: the stamp text moves from 9:03 AM to 9:05 AM

test('tiles regression: two real exports of the same data 2 minutes apart have the same hash', () => {
  const a = realExport(T1);
  const b = realExport(T2);
  const stamped = a.tiles.rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(b.tiles.rows[i])).map((r) => r.id);
  assert.ok(['wait.detail', 'wip.live_at', 'page.data_from', 'page.stale.sentence', 'page.fresh.sentence'].every((id) => stamped.includes(id)), `the fixture must reproduce the bug: only ${stamped.join(',')} differ before masking`);
  assert.equal(hashSet(a), hashSet(b));
});

test('tiles regression: a real tile change (a lane changes state) still changes the hash', () => {
  assert.notEqual(hashSet(realExport(T1, 'active')), hashSet(realExport(T1, 'blocked')));
});

test('maskDoc(tiles) replaces only the stamp of meta.exported_at; another time in a tile stays', () => {
  const stamp = formatChicago(T1);
  const doc = { exportedAt: T1, rows: [{ id: 'a', text: `Live at ${stamp}.` }, { id: 'b', text: 'Oldest ask: Nov 7, 11:32 PM CST.' }, { id: 'c', text: stamp }] };
  const m = maskDoc('tiles', doc, T1);
  assert.ok(!JSON.stringify(m).includes(stamp));
  assert.equal(m.rows[1].text, 'Oldest ask: Nov 7, 11:32 PM CST.');
  assert.equal(JSON.stringify(doc).includes(stamp), true, 'the input must not change');
});

test('maskDoc(tiles) with no usable exported_at leaves the rows alone and does not throw', () => {
  const doc = { exportedAt: 'T', rows: [{ id: 'a', text: 'Live at x.' }] };
  for (const at of [undefined, null, 'T1', '']) assert.deepEqual(maskDoc('tiles', doc, at).rows, doc.rows, String(at));
});
