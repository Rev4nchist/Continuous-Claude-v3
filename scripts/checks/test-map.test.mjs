// Tests for selectFlows in scripts/checks/test-map.mjs (TREX build spec section 8, engine spec section 7).
// Run: node --test scripts/checks/test-map.test.mjs
//
// How the unit can fail, and the test that catches it:
//   a backslash path (Windows) misses a flow glob                              -> M1   (drop norm)
//   a '!glob' is read as a plain glob, so an excluded file still scores        -> M2   (treat '!' as plain)
//   a symbol scores from a file name, or inside a longer word                  -> M3   (match the changed paths, drop the word boundary)
//   a score under the threshold is selected, or missing from belowThreshold    -> M4   (drop the threshold)
//   more than `cap` flows are selected                                         -> M5   (drop the slice)
//   ties come out in input order, not lastFailAt desc then id                  -> M6   (drop the tie sort)
//   path, symbol and surface scores stop adding up (3 + 2 + 1)                 -> M7
//   the engine form (array of paths, opts.hunks, min and max) is not read      -> M8
//   the call reorders or changes the caller's flow list                        -> M9   (sort in place)
//   a flow with no paths, or a junk row, throws                                -> M10
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFlows } from './test-map.mjs';

const flow = (id, extra = {}) => ({ id, paths: ['scripts/x/**'], ...extra });
const ids = (r) => r.selected.map((s) => s.id);

test('M1: a backslash path and a ./ path match the flow glob', () => {
  const r = selectFlows([flow('pre-pr')], { paths: ['scripts\\x\\a.mjs'] });
  assert.deepEqual(r.selected, [{ id: 'pre-pr', score: 3, reasons: ['path:scripts/x/a.mjs'] }]);
  assert.deepEqual(ids(selectFlows([flow('pre-pr')], { paths: ['./scripts/x/a.mjs'] })), ['pre-pr']);
});

test('M2: a !glob removes a path from the match, per path', () => {
  const f = flow('neg', { paths: ['scripts/x/**', '!scripts/x/a.mjs'] });
  assert.equal(selectFlows([f], { paths: ['scripts/x/a.mjs'] }).scores[0].score, 0);
  assert.deepEqual(ids(selectFlows([f], { paths: ['scripts/x/a.mjs', 'scripts/x/b.mjs'] })), ['neg']);
  assert.equal(selectFlows([flow('only-neg', { paths: ['!scripts/x/a.mjs'] })], { paths: ['scripts/x/b.mjs'] }).scores[0].score, 0);
});

test('M3: a symbol scores only from hunk text or hunk symbols, whole word, never from a file name', () => {
  const f = { id: 'sym', paths: ['docs/**'], symbols: ['parseHunks'] };
  const nameOnly = selectFlows([f], { paths: ['scripts/github/parseHunks.mjs'], hunks: [] });
  assert.equal(nameOnly.scores[0].score, 0);
  const inText = selectFlows([f], { paths: [], hunks: [{ path: 'a.mjs', text: '+  const h = parseHunks(diff);' }] });
  assert.deepEqual(inText.scores[0], { id: 'sym', score: 2, reasons: ['symbol:parseHunks'] });
  assert.equal(selectFlows([f], { paths: [], hunks: [{ path: 'a.mjs', text: '+ parseHunksX(1)' }] }).scores[0].score, 0);
  assert.equal(selectFlows([f], { paths: [], hunks: [{ path: 'a.mjs', symbols: ['parseHunks'] }] }).scores[0].score, 2);
});

test('M4: a flow under the threshold is not selected and is listed in belowThreshold', () => {
  const f = { id: 'weak', paths: ['docs/**'], symbols: ['sym'] };
  const r = selectFlows([f], { paths: [], hunks: [{ path: 'a', text: 'sym()' }] });
  assert.deepEqual([r.selected, r.belowThreshold], [[], ['weak']]);
  assert.deepEqual(ids(selectFlows([f], { paths: [], hunks: [{ path: 'a', text: 'sym()' }] }, { threshold: 2 })), ['weak']);
  assert.deepEqual(selectFlows([flow('none')], { paths: ['docs/a.md'] }).belowThreshold, [], 'a score of 0 is not "below"');
});

test('M5: at most cap flows are selected, five by default', () => {
  const flows = Array.from({ length: 7 }, (_, i) => flow(`f${i}`));
  assert.equal(selectFlows(flows, { paths: ['scripts/x/a.mjs'] }).selected.length, 5);
  assert.equal(selectFlows(flows, { paths: ['scripts/x/a.mjs'] }, { cap: 2 }).selected.length, 2);
  assert.equal(selectFlows(flows, { paths: ['scripts/x/a.mjs'] }).scores.length, 7, 'scores keeps every flow');
});

test('M6: ties sort by lastFailAt descending (never failed last), then by id', () => {
  const flows = [
    flow('b-never'), flow('a-never'),
    flow('old', { lastFailAt: '2026-10-01T00:00:00Z' }), flow('new', { lastFailedAt: '2026-11-01T00:00:00Z' }),
    flow('hi', { symbols: ['s'] }),
  ];
  const r = selectFlows(flows, { paths: ['scripts/x/a'], hunks: [{ path: 'a', text: 's' }] }, { cap: 9 });
  assert.deepEqual(ids(r), ['hi', 'new', 'old', 'a-never', 'b-never']);
});

test('M7: path 3 + symbol 2 + surface 1 add up, with a reason for each', () => {
  const f = { id: 'all', paths: ['scripts/x/**'], symbols: ['go'], surfaces: ['pre-pr'] };
  const r = selectFlows([f], { paths: ['scripts/x/a.mjs'], hunks: [{ path: 'scripts/x/a.mjs', text: 'go()' }], surfaceIds: ['pre-pr', 'other'] });
  assert.deepEqual(r.selected[0], { id: 'all', score: 6, reasons: ['path:scripts/x/a.mjs', 'symbol:go', 'surface:pre-pr'] });
  assert.equal(selectFlows([{ id: 's', surfaces: ['pre-pr'] }], { paths: [], surfaceIds: ['pre-pr'] }).scores[0].score, 1);
});

test('M8: the engine form works: an array of paths, hunks and surfaceIds in opts, min and max', () => {
  const f = { id: 'eng', paths: ['scripts/x/**'], symbols: ['go'] };
  const r = selectFlows([f], ['scripts/x/a.mjs'], { hunks: [{ path: 'scripts/x/a.mjs', text: 'go()' }], min: 6, max: 1 });
  assert.deepEqual(r.selected, [], 'min 6 raises the bar over a score of 5');
  assert.equal(r.scored[0].score, 5);
  assert.deepEqual(ids(selectFlows([f], ['scripts/x/a.mjs'], { min: 3, max: 1 })), ['eng']);
});

test('M9: the call does not reorder or change the caller flow list', () => {
  const flows = [flow('z'), flow('a'), flow('m')];
  const before = JSON.stringify(flows);
  selectFlows(flows, { paths: ['scripts/x/a.mjs'] });
  assert.equal(JSON.stringify(flows), before);
});

test('M10: a flow without paths, a junk row and an empty change give an empty pick, no throw', () => {
  const r = selectFlows([{ id: 'bare' }, null, { paths: ['x/**'] }, 'junk'], {});
  assert.deepEqual([r.selected, r.belowThreshold, r.scores.map((s) => s.id)], [[], [], ['bare']]);
  assert.deepEqual(selectFlows(undefined, undefined).selected, []);
});
