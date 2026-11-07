import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLanes, boardMismatch, boardWriteKind, mergeUnknownColumns } from './kanban-place.mjs';
import * as place from './kanban-place.mjs';

const L = (id, state, priority) => ({ id, state, priority });
const lanes = [
  L('a', 'ready', 1), L('b', 'backlog', 2), L('c', 'blocked', 3),
  L('d', 'active', 4), L('e', 'review', 5), L('f', 'done', 6), L('g', 'ready', 7),
];

test('absent doc: ready goes to next, blocked to waiting, other open states to later, active apart, done dropped', () => {
  for (const doc of [null, undefined, {}, { columns: {} }, 'junk', 42, { columns: 'x' }]) {
    const p = placeLanes(doc, lanes);
    assert.deepEqual(p.now, []);
    assert.deepEqual(p.waiting, ['c']);
    assert.deepEqual(p.next, ['a', 'g']);
    assert.deepEqual(p.later, ['b', 'e']);
    assert.deepEqual(p.inProgress, ['d']);
  }
});

test('doc order is preserved inside and across columns', () => {
  const p = placeLanes({ columns: { now: ['g', 'a'], next: [], later: ['e', 'c'], waiting: ['b'] } }, lanes);
  assert.deepEqual(p.now, ['g', 'a']);
  assert.deepEqual(p.later, ['e', 'c']);
  assert.deepEqual(p.waiting, ['b']);
  assert.deepEqual(p.next, []);
});

test('ids in the doc that no lane has are dropped', () => {
  const p = placeLanes({ columns: { now: ['ghost', 'a'], later: ['gone'] } }, lanes);
  assert.deepEqual(p.now, ['a']);
  assert.ok(![].concat(p.now, p.next, p.later, p.waiting).includes('ghost'));
  assert.ok(![].concat(p.now, p.next, p.later, p.waiting).includes('gone'));
});

test('lanes missing from the doc land at the END of their default column', () => {
  const p = placeLanes({ columns: { next: ['g'], later: ['e'] } }, lanes);
  assert.deepEqual(p.next, ['g', 'a']);
  assert.deepEqual(p.later, ['e', 'b']);
  assert.deepEqual(p.waiting, ['c']);
});

test('an active lane is never in the four columns, even when the doc names it', () => {
  const p = placeLanes({ columns: { now: ['d', 'a'] } }, lanes);
  assert.deepEqual(p.now, ['a']);
  assert.deepEqual(p.inProgress, ['d']);
  assert.ok(![].concat(p.next, p.later, p.waiting).includes('d'));
});

test('a done lane is nowhere, even when the doc names it', () => {
  const p = placeLanes({ columns: { waiting: ['f'] } }, lanes);
  const all = [].concat(p.now, p.next, p.later, p.waiting, p.inProgress);
  assert.ok(!all.includes('f'));
});

test('an id listed twice is placed once, first column wins', () => {
  const p = placeLanes({ columns: { later: ['a'], now: ['a', 'a'] } }, lanes);
  assert.deepEqual(p.now, ['a']);
  assert.ok(!p.later.includes('a'));
  assert.ok(!p.next.includes('a'));
});

test('non-string and non-array entries in the doc are ignored, not thrown on', () => {
  const p = placeLanes({ columns: { now: [null, 7, {}, 'a'], next: 'g', later: undefined } }, lanes);
  assert.deepEqual(p.now, ['a']);
  assert.deepEqual(p.next, ['g']);
});

test('every open lane appears exactly once', () => {
  const p = placeLanes({ columns: { now: ['g'], waiting: ['b', 'ghost'] } }, lanes);
  const all = [].concat(p.now, p.next, p.later, p.waiting, p.inProgress).sort();
  assert.deepEqual(all, ['a', 'b', 'c', 'd', 'e', 'g']);
});

test('absent doc: blocked lanes fill waiting, sorted by DB priority then input order', () => {
  const p = placeLanes(null, [L('x', 'blocked', 9), L('y', 'blocked', 2), L('z', 'blocked', 2), L('w', 'blocked'), L('r', 'ready', 1)]);
  assert.deepEqual(p.waiting, ['y', 'z', 'x', 'w']);
  assert.deepEqual(p.next, ['r']);
  assert.deepEqual(p.later, []);
});

test('a saved doc wins: a blocked lane the doc puts in later, now or next stays there', () => {
  const p = placeLanes({ columns: { later: ['c'], now: ['g'] } }, lanes);
  assert.deepEqual(p.later, ['c', 'b', 'e']);
  assert.deepEqual(p.waiting, []);
  const q = placeLanes({ columns: { next: ['c'] } }, lanes);
  assert.deepEqual(q.next, ['c', 'a', 'g']);
  assert.deepEqual(q.waiting, []);
});

test('a saved doc: a blocked lane the doc does not list falls back to waiting, after the ones the doc lists', () => {
  const two = [...lanes, L('h', 'blocked', 0)];
  const p = placeLanes({ columns: { waiting: ['c'], later: ['b'] } }, two);
  assert.deepEqual(p.waiting, ['c', 'h']);
  assert.deepEqual(p.later, ['b', 'e']);
});

test('a blocked lane that became active is in progress, not waiting', () => {
  const p = placeLanes(null, [L('c', 'active', 1)]);
  assert.deepEqual(p.waiting, []);
  assert.deepEqual(p.inProgress, ['c']);
});

test('defaults sort by DB priority, then by input order', () => {
  const p = placeLanes(null, [L('x', 'ready', 9), L('y', 'ready', 2), L('z', 'ready', 2), L('w', 'ready')]);
  assert.deepEqual(p.next, ['y', 'z', 'x', 'w']);
});

test('no lanes at all gives five empty lists', () => {
  assert.deepEqual(placeLanes(null, []), { now: [], next: [], later: [], waiting: [], inProgress: [] });
});

// ---- the board guard, the write kind and the unknown-id merge (the page save) ---------------------------------

test('boardMismatch: a doc stamped with another board is foreign; the same board, no stamp and no doc are fine', () => {
  assert.equal(boardMismatch({ board: 'zz-a', columns: {} }, 'zz-b'), true);
  assert.equal(boardMismatch({ board: 'zz-a', columns: {} }, 'zz-a'), false);
  // An old doc has no board field: it is allowed, and the next save stamps it.
  assert.equal(boardMismatch({ columns: {}, updatedAt: 'x' }, 'zz-a'), false);
  for (const doc of [null, undefined, 'junk', 7]) assert.equal(boardMismatch(doc, 'zz-a'), false);
});

test('boardMismatch fails closed on a stamp that is not a board key (null, number, empty, other case)', () => {
  for (const stamp of [null, 7, '', 'ZZ-A', ['zz-a'], {}]) assert.equal(boardMismatch({ board: stamp }, 'zz-a'), true, JSON.stringify(stamp));
});

test('boardWriteKind: update when a doc exists (it keeps appliedColumns and syncedAt), set only when there is none', () => {
  assert.equal(boardWriteKind({ columns: {} }), 'update');
  assert.equal(boardWriteKind({}), 'update');
  for (const doc of [null, undefined]) assert.equal(boardWriteKind(doc), 'set');
});

const COLS = (o) => ({ now: [], next: [], later: [], waiting: [], ...o });

test('mergeUnknownColumns: ids the page does not know come back, each in the column the saved doc had it in, after the page\'s own', () => {
  const known = [L('a', 'ready', 1), L('b', 'ready', 2)];
  const doc = { columns: { now: ['ghost1', 'a'], later: ['ghost2'], waiting: ['ghost3'] } };
  const merged = mergeUnknownColumns(doc, COLS({ now: ['b'], later: ['a'] }), known);
  assert.deepEqual(merged, COLS({ now: ['b', 'ghost1'], later: ['a', 'ghost2'], waiting: ['ghost3'] }));
});

test('mergeUnknownColumns: an id the page knows is never merged back (the page placed it), and none repeats', () => {
  const known = [L('a', 'ready', 1), L('b', 'ready', 2), L('d', 'done', 3)];
  // The page moved a from now to later; the saved doc still has it in now. d is done: known to the page, so dropped, not merged.
  const doc = { columns: { now: ['a', 'd', 'ghost'], next: ['ghost'], later: ['b'] } };
  const merged = mergeUnknownColumns(doc, COLS({ later: ['a', 'b'] }), known);
  assert.deepEqual(merged, COLS({ now: ['ghost'], later: ['a', 'b'] }));
  const all = [].concat(merged.now, merged.next, merged.later, merged.waiting);
  assert.equal(new Set(all).size, all.length, 'an id is in two columns');
});

test('mergeUnknownColumns: no doc, a doc with no columns, junk ids and junk columns change nothing; the page columns are not mutated', () => {
  const known = [L('a', 'ready', 1)];
  const mine = COLS({ now: ['a'] });
  for (const doc of [null, undefined, {}, { columns: 'x' }, { columns: { now: 'a', next: null } }, 'junk']) {
    assert.deepEqual(mergeUnknownColumns(doc, mine, known), COLS({ now: ['a'] }));
  }
  assert.deepEqual(mergeUnknownColumns({ columns: { now: [3, null, {}, '', 'g'] } }, mine, known).now, ['a', 'g']);
  const before = JSON.stringify(mine);
  mergeUnknownColumns({ columns: { now: ['g'] } }, mine, known);
  assert.equal(JSON.stringify(mine), before);
});

test('mergeUnknownColumns: ids named like object builtins are handled as ids', () => {
  const merged = mergeUnknownColumns({ columns: { now: ['__proto__', 'constructor', 'toString'] } }, COLS(), [L('a', 'ready', 1)]);
  assert.deepEqual(merged.now, ['__proto__', 'constructor', 'toString']);
});

// ---- PR-C: how many lanes a Do next card still sits under in By band, and when the Done chip shows.
// The new helpers are read through the namespace (imported at the top) so a missing export fails one test, not the whole file.
const B = (id, state, band) => ({ id, state, band });
const BANDED = [B('p0', 'ready', 'P0'), B('p0b', 'backlog', 'P0'), B('p0done', 'done', 'P0'), B('p1', 'ready', 'P1'), B('p2', 'backlog', 'P2'), B('u', 'ready', null)];

test('bandAhead: a P2 card counts only the OPEN P0 and P1 lanes, never a done one', () => {
  assert.equal(place.bandAhead(BANDED, 'p2'), 3);
});

test('bandAhead: a P1 card counts the open P0 lanes; a P0 card counts none', () => {
  assert.equal(place.bandAhead(BANDED, 'p1'), 2);
  assert.equal(place.bandAhead(BANDED, 'p0'), 0);
});

test('bandAhead: an Unsorted card (null, missing or junk band) counts every open banded lane; the lane itself is not counted', () => {
  assert.equal(place.bandAhead(BANDED, 'u'), 4);
  assert.equal(place.bandAhead([B('x', 'ready'), B('y', 'ready', 'P0')], 'x'), 1);
  assert.equal(place.bandAhead([B('x', 'ready', 'zz'), B('y', 'ready', 'P2')], 'x'), 1);
});

test('bandAhead: an unknown id, an empty list and junk input give 0', () => {
  assert.equal(place.bandAhead(BANDED, 'ghost'), 0);
  assert.equal(place.bandAhead([], 'p2'), 0);
  assert.equal(place.bandAhead(null, 'p2'), 0);
});

const NOW = '2026-11-06T10:00:00.000Z';
const BEFORE = '2026-11-06T09:00:00.000Z';
const AFTER = '2026-11-06T11:00:00.000Z';

test('doneChip: shows only for a pending done card on a lane that is not done yet', () => {
  assert.equal(place.doneChip({ status: 'done', updatedAt: NOW }, 'ready'), true, 'pending done on an open lane');
  assert.equal(place.doneChip({ status: 'done', updatedAt: NOW, syncedAt: BEFORE }, 'backlog'), true, 'edited after the sync is pending');
});

test('doneChip: not after the sync, not on a done lane, not for another status, not without a doc', () => {
  assert.equal(place.doneChip({ status: 'done', updatedAt: NOW, syncedAt: AFTER }, 'ready'), false, 'synced');
  assert.equal(place.doneChip({ status: 'done', updatedAt: NOW }, 'done'), false, 'lane already done');
  assert.equal(place.doneChip({ status: 'ready', updatedAt: NOW }, 'backlog'), false, 'another status');
  assert.equal(place.doneChip({ status: null, updatedAt: NOW }, 'ready'), false, 'status null after Undo');
  assert.equal(place.doneChip(null, 'ready'), false);
  assert.equal(place.doneChip(undefined, 'ready'), false);
});
