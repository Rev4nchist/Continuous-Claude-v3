/**
 * lane-sort.test -- the pure shared sort key for open lanes. No database.
 * The end-to-end proof is lane-band-sort-probe.mjs. The SQL twin is pinned by
 * .claude/hooks/src/__tests__/lane-sort-twin.test.ts.
 *
 *   node --test scripts/coordination/lane-sort.test.mjs
 *
 * One test per rule. Each test would fail if its rule in compareLanes or sortOpenLanes changed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bandRank, bandTag, compareLanes, laneOrderSql, sortOpenLanes } from './lane-sort.mjs';

const lane = (id, band, priority, due_at = null, state = 'ready') => ({ id, band, priority, due_at, state });
const ids = (rows) => rows.map((l) => l.id);

describe('compareLanes: the key is band, due_at, priority, id', () => {
  it('band order: P0, then P1, then P2, then Unsorted, whatever the priority numbers', () => {
    const rows = [lane('u', null, 1), lane('c', 'P2', 1), lane('b', 'P1', 50), lane('a', 'P0', 999)];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['a', 'b', 'c', 'u']);
  });
  it('NULL band, a missing band and an unknown band all sort last', () => {
    const rows = [lane('x', 'P9', 1), lane('y', undefined, 1), lane('z', null, 1), lane('p', 'P2', 500)];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['p', 'x', 'y', 'z']);
  });
  it('due_at before priority, inside a band', () => {
    const rows = [lane('high-prio-later', 'P1', 1, '2026-11-09T10:00:00Z'), lane('low-prio-soon', 'P1', 90, '2026-11-07T10:00:00Z')];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['low-prio-soon', 'high-prio-later']);
  });
  it('due_at NULLS LAST: a lane with a date sorts before one without, inside a band', () => {
    const rows = [lane('nodue', 'P0', 1), lane('due', 'P0', 99, '2030-01-01T00:00:00Z')];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['due', 'nodue']);
  });
  it('due_at reads Date objects and ISO strings the same way', () => {
    const rows = [lane('s', 'P0', 1, '2026-11-08T00:00:00Z'), lane('d', 'P0', 1, new Date('2026-11-07T00:00:00Z'))];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['d', 's']);
  });
  it('priority before id, when band and due_at tie', () => {
    const rows = [lane('a', 'P2', 20), lane('z', 'P2', 3)];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['z', 'a']);
  });
  it('id breaks the last tie, and compareLanes returns 0 only for equal keys', () => {
    assert.deepEqual(ids(sortOpenLanes([lane('b', null, 5), lane('a', null, 5)])), ['a', 'b']);
    assert.equal(compareLanes(lane('a', 'P1', 5), lane('a', 'P1', 5)), 0);
  });
});

describe('sortOpenLanes: done lanes are excluded', () => {
  it('a done P0 lane never appears, and the input array is not changed', () => {
    const rows = [lane('open', 'P2', 5), lane('finished', 'P0', 1, null, 'done')];
    assert.deepEqual(ids(sortOpenLanes(rows)), ['open']);
    assert.deepEqual(ids(rows), ['open', 'finished']);
  });
});

describe('bandTag and laneOrderSql', () => {
  it('bandTag shows the band, or "--" for Unsorted', () => {
    assert.deepEqual([bandTag('P0'), bandTag('P1'), bandTag('P2'), bandTag(null), bandTag(undefined)], ['P0', 'P1', 'P2', '--', '--']);
    assert.equal(bandRank('P0') < bandRank('P1') && bandRank('P1') < bandRank('P2') && bandRank('P2') < bandRank(null), true);
  });
  it('the SQL fragment is the same key: band CASE, due_at NULLS LAST, priority, id, on the alias given', () => {
    const sql = laneOrderSql('l');
    assert.equal(sql, "CASE l.band WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, l.due_at ASC NULLS LAST, l.priority, l.id");
  });
  it('the SQL fragment refuses an alias that is not a plain identifier (no injection)', () => {
    for (const bad of ['', 'l; DROP TABLE x', 'l.x', 'L', '1l', "l'"]) assert.throws(() => laneOrderSql(bad), /bad alias/);
  });
});
