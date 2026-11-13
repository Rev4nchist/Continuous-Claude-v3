// Failure modes (re-score-paired step 3: the cluster bootstrap and the Wilson interval).
//  the seed does not fix the bounds        -> a test would flake
//  resampling by item, not by cluster      -> the bounds are too narrow for correlated items
//  one cluster that holds everything       -> every resample is the whole data: lo === hi === point
//  a null stat result counted as a sample  -> the bounds shift; `used` shows the count
//  Wilson with total 0, or at 0 and total  -> divide by zero, or a bound outside [0, 1]
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterBootstrap, mulberry32, wilson } from './bootstrap.mjs';

const mean = (items) => (items.length ? items.reduce((a, b) => a + b, 0) / items.length : null);
/** 12 clusters of 3 numbers from a fixed seed. */
function sampleClusters() {
  const next = mulberry32(42);
  return Array.from({ length: 12 }, () => Array.from({ length: 3 }, () => Math.round(next() * 100)));
}

test('mulberry32 gives floats in [0, 1) and the same sequence for one seed (breaks if the seed is ignored or the range reaches 1)', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(xs).size > 990);
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(8)));
});

test('mulberry32(1) gives its first 3 reference values (breaks if the mixing steps or the constant change)', () => {
  const g = mulberry32(1);
  assert.deepEqual([g(), g(), g()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
});

test('clusterBootstrap: one seed gives the same bounds; the point is the stat on all items; B and used are reported (breaks if the RNG is shared between calls or the point is a resample)', () => {
  const clusters = sampleClusters();
  const first = clusterBootstrap({ clusters, stat: mean, B: 500, seed: 3 });
  assert.deepEqual(clusterBootstrap({ clusters, stat: mean, B: 500, seed: 3 }), first);
  assert.equal(first.point, mean(clusters.flat()));
  assert.deepEqual([first.B, first.used], [500, 500]);
  assert.notDeepEqual(clusterBootstrap({ clusters, stat: mean, B: 500, seed: 4 }), first);
});

test('clusterBootstrap: with no seed it uses seed 1 (breaks if the default seed changes)', () => {
  const clusters = sampleClusters();
  assert.deepEqual(clusterBootstrap({ clusters, stat: mean, B: 50 }), clusterBootstrap({ clusters, stat: mean, B: 50, seed: 1 }));
});

test('clusterBootstrap: the bounds contain the point and lo is not above hi (breaks if the bounds swap)', () => {
  const r = clusterBootstrap({ clusters: sampleClusters(), stat: mean, B: 2000, seed: 1 });
  assert.ok(r.lo <= r.point && r.point <= r.hi, JSON.stringify(r));
  assert.ok(r.lo < r.hi);
});

/** A stat that ignores its items: the first call (the point) gives 0, call k gives k. The B resample values are 1..B, so a percentile is a known rank. */
const counter = () => {
  let calls = 0;
  return () => { calls += 1; return calls === 1 ? 0 : calls - 1; };
};

test('clusterBootstrap picks the percentile by rank: B 2000 and alpha 0.05 give the 51st and the 1950th value; B 100 and alpha 0.1 give the 6th and the 95th (breaks if an index is off by one or alpha is ignored)', () => {
  const clusters = [[1], [2]];
  const wide = clusterBootstrap({ clusters, stat: counter(), B: 2000, seed: 1, alpha: 0.05 });
  assert.deepEqual([wide.point, wide.lo, wide.hi, wide.used], [0, 51, 1950, 2000]);
  assert.deepEqual([clusterBootstrap({ clusters, stat: counter(), B: 2000, seed: 1 }).lo, clusterBootstrap({ clusters, stat: counter(), B: 2000, seed: 1 }).hi], [51, 1950], 'alpha defaults to 0.05');
  const mid = clusterBootstrap({ clusters, stat: counter(), B: 100, seed: 1, alpha: 0.1 });
  assert.deepEqual([mid.lo, mid.hi], [6, 95]);
});

test('clusterBootstrap on 100 single-item clusters pins the 95% bounds of the mean, and a larger alpha gives narrower bounds (breaks if lo is the minimum, hi is the maximum, or alpha is ignored)', () => {
  const clusters = Array.from({ length: 100 }, (_, i) => [i]);
  const a05 = clusterBootstrap({ clusters, stat: mean, B: 2000, seed: 1, alpha: 0.05 });
  assert.deepEqual([a05.point, a05.lo, a05.hi], [49.5, 43.84, 55.15]);
  const a50 = clusterBootstrap({ clusters, stat: mean, B: 2000, seed: 1, alpha: 0.5 });
  assert.deepEqual([a50.lo, a50.hi], [47.47, 51.35]);
  assert.ok(a50.hi - a50.lo < 0.5 * (a05.hi - a05.lo));
});

test('clusterBootstrap: one cluster that holds all items gives lo === hi === point (breaks if items are resampled inside the cluster)', () => {
  const r = clusterBootstrap({ clusters: [[1, 2, 3, 4, 5, 6]], stat: mean, B: 200, seed: 1 });
  assert.deepEqual([r.lo, r.hi, r.point], [3.5, 3.5, 3.5]);
});

test('clusterBootstrap resamples by cluster: correlated items in one cluster give wider bounds than the same items as single-item clusters (breaks if it resamples by item)', () => {
  const together = Array.from({ length: 10 }, (_, i) => Array(4).fill(i % 2));
  const apart = together.flat().map((x) => [x]);
  const wide = clusterBootstrap({ clusters: together, stat: mean, B: 2000, seed: 5 });
  const narrow = clusterBootstrap({ clusters: apart, stat: mean, B: 2000, seed: 5 });
  assert.equal(wide.point, narrow.point);
  assert.ok(wide.hi - wide.lo > 1.4 * (narrow.hi - narrow.lo), `${wide.hi - wide.lo} vs ${narrow.hi - narrow.lo}`);
});

test('clusterBootstrap skips a null stat result and counts the rest in used; no cluster gives all null (breaks if null is counted as a value or a missing cluster list throws)', () => {
  const lumpy = [[1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]];
  const r = clusterBootstrap({ clusters: lumpy, stat: (items) => (items.length >= 10 ? null : mean(items)), B: 400, seed: 2 });
  assert.ok(r.used > 0 && r.used < 400, String(r.used));
  assert.equal(r.B, 400);
  assert.deepEqual(clusterBootstrap({ clusters: [], stat: mean }), { point: null, lo: null, hi: null, B: 2000, used: 0 });
  assert.equal(clusterBootstrap({ clusters: [[]], stat: mean, B: 10 }).point, null);
});

test('wilson(5, 10) matches the hand value to 4 places; no total gives nulls; the bounds stay inside [0, 1] (breaks if the formula or the clamp changes)', () => {
  const w = wilson(5, 10);
  assert.ok(Math.abs(w.lo - 0.2366) < 5e-5 && Math.abs(w.hi - 0.7634) < 5e-5, JSON.stringify(w));
  assert.deepEqual(wilson(0, 0), { lo: null, hi: null });
  const zero = wilson(0, 10);
  assert.equal(zero.lo, 0);
  assert.ok(Math.abs(zero.hi - 3.8416 / 13.8416) < 1e-9, 'with found 0 the upper bound is z^2 / (n + z^2)');
  assert.equal(wilson(10, 10).hi, 1);
});

test('wilson takes z: z of 1 on 5 out of 10 gives 0.3492 to 0.6508 (breaks if z is ignored)', () => {
  const w = wilson(5, 10, 1);
  assert.ok(Math.abs(w.lo - 0.3492) < 5e-5 && Math.abs(w.hi - 0.6508) < 5e-5, JSON.stringify(w));
});
