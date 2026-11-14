/**
 * Card hooks-timing-tests-under-load: tests of the scaling helper (helpers/scaling.ts).
 *
 * The helper replaces a wall-clock limit ("finishes under 1 s") with a growth check: time at size SCALE_FACTOR * n divided by time
 * at size n, each the MINIMUM of 3 samples. A busy suite slows both sizes alike, so the ratio holds; a preempted sample is only ever
 * slower, so the minimum drops it. These tests use a fake clock: no wall time, so they cannot flake under load.
 *
 * Ways the helper can fail (one test each):
 *  1. a linear workload is rejected (false alarm)
 *  2. a quadratic or cubic workload is accepted (the test no longer guards anything)
 *  3. one preempted sample (50x slower, once) makes a linear workload fail (no minimum)
 *  4. a workload under the clock floor gives a noise ratio (no floor)
 *  5. the same load factor on both sizes changes the verdict (not load independent)
 *  6. an async workload (a child process timer) is not awaited
 */
import { describe, it, expect } from 'vitest';
import { scalingRatio, assertScaling, FLOOR_MS, MAX_RATIO, SCALE_FACTOR, SAMPLES } from './helpers/scaling.js';

/** A fake clock: `run` advances it by the cost of the workload. `spikeFirst` makes the first call of each size 50x slower. */
function fake(cost: (n: number) => number, opts: { load?: number; spikeFirst?: boolean } = {}) {
  let t = 0;
  const seen = new Map<number, number>();
  return {
    now: () => t,
    run: (n: number) => {
      const k = (seen.get(n) ?? 0) + 1;
      seen.set(n, k);
      t += cost(n) * (opts.load ?? 1) * (opts.spikeFirst && k === 1 ? 50 : 1);
    },
  };
}

describe('scaling helper constants', () => {
  it('states its rule: factor 4, 3 samples, ratio limit between linear (4) and quadratic (16), a floor in ms', () => {
    expect(SCALE_FACTOR).toBe(4);
    expect(SAMPLES).toBe(3);
    expect(MAX_RATIO).toBeGreaterThan(SCALE_FACTOR * 2);
    expect(MAX_RATIO).toBeLessThan(SCALE_FACTOR * SCALE_FACTOR);
    expect(FLOOR_MS).toBeGreaterThan(0);
  });
});

describe('scalingRatio', () => {
  it('1. a linear workload has a ratio near the scale factor', async () => {
    const f = fake((n) => n * 0.01);
    const r = await scalingRatio(f.run, 1000, { now: f.now });
    expect(r.ratio).toBeCloseTo(SCALE_FACTOR, 5);
  });
  it('2. a quadratic workload has a ratio of about the factor squared', async () => {
    const f = fake((n) => n * n * 0.00001);
    const r = await scalingRatio(f.run, 1000, { now: f.now });
    expect(r.ratio).toBeCloseTo(SCALE_FACTOR * SCALE_FACTOR, 5);
  });
  it('3. one preempted sample does not change the ratio (minimum of the samples)', async () => {
    const f = fake((n) => n * 0.01, { spikeFirst: true });
    const r = await scalingRatio(f.run, 1000, { now: f.now });
    expect(r.ratio).toBeCloseTo(SCALE_FACTOR, 5);
  });
  it('4. a workload under the floor raises the size until it is above the floor', async () => {
    const f = fake((n) => n * 0.0001); // 1000 -> 0.1 ms, under FLOOR_MS
    const r = await scalingRatio(f.run, 1000, { now: f.now });
    expect(r.tSmall).toBeGreaterThanOrEqual(FLOOR_MS);
    expect(r.n).toBeGreaterThan(1000);
    expect(r.ratio).toBeCloseTo(SCALE_FACTOR, 5);
  });
  it('5. the same load on both sizes gives the same ratio', async () => {
    const quiet = fake((n) => n * 0.01);
    const busy = fake((n) => n * 0.01, { load: 7 });
    const a = await scalingRatio(quiet.run, 1000, { now: quiet.now });
    const b = await scalingRatio(busy.run, 1000, { now: busy.now });
    expect(b.ratio).toBeCloseTo(a.ratio, 5);
  });
  it('6. awaits an async workload', async () => {
    let t = 0;
    const run = async (n: number) => { await Promise.resolve(); t += n * 0.01; };
    const r = await scalingRatio(run, 1000, { now: () => t });
    expect(r.ratio).toBeCloseTo(SCALE_FACTOR, 5);
  });
});

describe('assertScaling', () => {
  it('passes a linear workload under the load of a busy suite', async () => {
    const f = fake((n) => n * 0.01, { load: 7, spikeFirst: true });
    await expect(assertScaling(f.run, 1000, { now: f.now })).resolves.toBeUndefined();
  });
  it('fails a quadratic workload, and the message names both times and the ratio', async () => {
    const f = fake((n) => n * n * 0.00001);
    await expect(assertScaling(f.run, 1000, { now: f.now })).rejects.toThrow(/ratio .* limit/i);
  });
  it('fails a cubic workload', async () => {
    const f = fake((n) => n * n * n * 0.00000001);
    await expect(assertScaling(f.run, 1000, { now: f.now })).rejects.toThrow(/ratio/i);
  });
});
