// Tests for lib/orphans.mjs (design B.7, contract point 7 cases 4 and 5).
// Failure modes (O1, O2): the seat listed as a worker orphan or with no line of its own; a parked long lane listed as an orphan;
// a blocked lane with no owner listed; a time printed in UTC. Run: node --test scripts/review-engine/orphans.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrphans, renderOrphans } from './lib/orphans.mjs';
import { fmtTime } from './lib/board-util.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row } from './fixtures/rows.fixture.mjs';

const OWNER = 'dddddddd-0000-4000-8000-00000000000d';
const ALIVE = new Date('2026-11-10T21:30:00.000Z');
const LEASE = new Date('2026-11-10T22:00:00.000Z');
const MAP = buildMap({ lanes: [{ id: 're-a' }, { id: 're-long' }, { id: 're-acc' }], long: ['re-long'] });
const seatLive = () => row('re-program', { state: 'review', owner_session_id: OWNER, reclaimable: false });
const dead = (id, state, over = {}) => row(id, {
  state, owner_session_id: OWNER, reclaimable: true, owner_alive_at: ALIVE, lease_expires_at: LEASE, note: 'was mid-edit', ...over,
});
const run = (rows, facts = MAP.facts) => listOrphans({ facts, rows });
const lines = (res) => renderOrphans(res).split('\n');

test('O1 the seat has its own line; a live holder gives the holder, an empty seat gives the time since', () => {
  assert.equal(lines(run([seatLive()]))[0], 'seat: re-program held live by dddddddd');
  const gone = run([dead('re-program', 'review')]);
  assert.equal(lines(gone)[0], 'seat: no live holder since 2026-11-10 15:30 CST');
  assert.equal(gone.exit, 1);
  const free = run([row('re-program', { state: 'ready', reclaimable: true, updated_at: new Date('2026-11-09T12:00:00.000Z') })]);
  assert.equal(lines(free)[0], 'seat: no live holder since 2026-11-09 06:00 CST');
});

test('O1b a dead seat is not also a worker orphan; no seat card is an empty seat', () => {
  const res = run([dead('re-program', 'active')]);
  assert.deepEqual(res.orphans, []);
  assert.equal(lines(res).filter((l) => l.startsWith('orphan:')).length, 0);
  const none = run([]);
  assert.equal(none.exit, 1);
  assert.match(lines(none)[0], /^seat: no live holder/);
});

test('O2 a long lane parked in review with a dead owner is a parked line, not an orphan, and alone it gives exit 0', () => {
  const res = run([seatLive(), dead('re-long', 'review', { branch: 're/re-long' })]);
  assert.deepEqual(res.orphans, []);
  assert.equal(res.parked.length, 1);
  assert.ok(lines(res).includes('parked: re-long branch re/re-long owner dddddddd lease 2026-11-10 16:00 CST note: was mid-edit'));
  assert.equal(res.exit, 0);
});

test('O2b a parked lane with an empty seat still gives exit 1; a long lane that is active and dead is an orphan', () => {
  assert.equal(run([dead('re-long', 'review')]).exit, 1);
  const active = run([seatLive(), dead('re-long', 'active')]);
  assert.deepEqual(active.orphans.map((o) => o.id), ['re-long']);
  assert.equal(active.parked.length, 0);
});

test('O3 a dead worker lane in active or review is an orphan line with the state, branch, owner, lease and last note; exit 1', () => {
  const res = run([seatLive(), dead('re-a', 'active', { branch: 're/re-a' }), dead('re-acc', 'review', { note: null, branch: null })]);
  const out = lines(res);
  assert.ok(out.includes('orphan: re-a active branch re/re-a owner dddddddd lease 2026-11-10 16:00 CST last note: was mid-edit'));
  assert.ok(out.includes('orphan: re-acc review branch - owner dddddddd lease 2026-11-10 16:00 CST last note: -'));
  assert.equal(res.exit, 1);
  assert.equal(out.at(-1), 'RESULT fail (2 orphans)');
});

test('O4 a blocked lane with no owner (the sweep), a live lane, a done lane and a backlog lane are not listed', () => {
  const rows = [
    seatLive(), row('re-acc', { state: 'blocked', note: 'sweep until 2026-11-24', reclaimable: true }),
    row('re-a', { state: 'active', owner_session_id: OWNER, reclaimable: false }),
    row('re-long', { state: 'done', owner_session_id: OWNER, reclaimable: true }), row('re-b', { state: 'backlog', reclaimable: true }),
  ];
  const res = run(rows);
  assert.deepEqual([res.orphans, res.parked, res.exit], [[], [], 0]);
  assert.equal(lines(res).at(-1), 'RESULT pass (0 orphans)');
});

test('O5 an active lane with no owner is an orphan with owner "-"; a re- lane that is not in the map is listed too', () => {
  const res = run([seatLive(), row('re-a', { state: 'active', reclaimable: true }), dead('re-stray', 'review')]);
  assert.deepEqual(res.orphans.map((o) => o.id), ['re-a', 're-stray']);
  assert.match(lines(res).find((l) => l.startsWith('orphan: re-a ')), /owner - /);
});

test('O6 with no Long lanes bullet every dead review lane is an orphan and the note says why', () => {
  const noLong = buildMap({ lanes: [{ id: 're-long' }] });
  const res = run([seatLive(), dead('re-long', 'review')], noLong.facts);
  assert.deepEqual(res.orphans.map((o) => o.id), ['re-long']);
  assert.deepEqual(res.notes, ['map fact missing: Long lanes bullet']);
  assert.ok(lines(res).includes('NOTE map fact missing: Long lanes bullet'));
});

test('O7 fmtTime prints Central time with the zone name, never a Z time; a null time is unknown', () => {
  assert.equal(fmtTime(new Date('2026-11-10T21:30:00.000Z')), '2026-11-10 15:30 CST');
  assert.equal(fmtTime(new Date('2026-07-01T17:05:00.000Z')), '2026-07-01 12:05 CDT');
  assert.equal(fmtTime(new Date('2026-11-11T05:59:00.000Z')), '2026-11-10 23:59 CST');
  assert.equal(fmtTime(null), 'unknown');
  assert.equal(fmtTime('2026-11-10T21:30:00.000Z'), '2026-11-10 15:30 CST');
});
