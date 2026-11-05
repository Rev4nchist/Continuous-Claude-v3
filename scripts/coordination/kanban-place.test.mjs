import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLanes } from './kanban-place.mjs';

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
