/**
 * Scaling check for the speed tests of the hooks suite (card hooks-timing-tests-under-load).
 *
 * Why: a test that says "finishes under 1 s" is a wall-clock bound. With 200 test files in parallel workers it fails when a worker
 * loses its core, even though the code did not change (decision-gate-app-repos R5 F7b: 1021 ms, alone 361 ms). These tests guard
 * against backtracking and other super-linear work, so they should test GROWTH, not speed.
 *
 * Rule (the same for every speed test):
 *   - run the workload at size n and at size SCALE_FACTOR * n;
 *   - take the MINIMUM of SAMPLES runs for each size (a preempted run is only ever slower, so the minimum drops it);
 *   - the ratio large / small must stay under MAX_RATIO.
 * Linear work gives SCALE_FACTOR (4). Quadratic work gives 16 and cubic 64. A busy suite slows both sizes alike, so the ratio holds.
 *
 * Floor: a sample under FLOOR_MS is below the noise of the clock. When the small size runs under it, n is doubled until it does not
 * (at most MAX_DOUBLINGS times), so the ratio is never taken from noise.
 */

export const SCALE_FACTOR = 4;
export const SAMPLES = 3;
/** Between linear (4) and quadratic (16): headroom 2.5x for noise on a linear workload, and a quadratic workload still fails. */
export const MAX_RATIO = 10;
export const FLOOR_MS = 2;
export const MAX_DOUBLINGS = 8;

export interface ScalingOptions {
  /** Clock in ms. The default is performance.now. A test of the helper passes a fake clock. */
  now?: () => number;
}

export interface ScalingResult { n: number; tSmall: number; tLarge: number; ratio: number }

type Run = (n: number) => void | Promise<unknown>;

async function minTime(run: Run, n: number, now: () => number): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = now();
    await run(n);
    best = Math.min(best, now() - t0);
  }
  return best;
}

/** Time of `run` at size n and at SCALE_FACTOR * n. n is raised while the small size is under FLOOR_MS. */
export async function scalingRatio(run: Run, n0: number, opts: ScalingOptions = {}): Promise<ScalingResult> {
  const now = opts.now ?? (() => performance.now());
  let n = n0;
  let tSmall = await minTime(run, n, now);
  for (let i = 0; i < MAX_DOUBLINGS && tSmall < FLOOR_MS; i++) {
    n *= 2;
    tSmall = await minTime(run, n, now);
  }
  const tLarge = await minTime(run, n * SCALE_FACTOR, now);
  return { n, tSmall, tLarge, ratio: tLarge / Math.max(tSmall, FLOOR_MS) };
}

/** Throws when the work grows faster than MAX_RATIO over a SCALE_FACTOR increase in size. The message gives both times. */
export async function assertScaling(run: Run, n0: number, opts: ScalingOptions = {}): Promise<void> {
  const r = await scalingRatio(run, n0, opts);
  if (r.ratio > MAX_RATIO) {
    throw new Error(
      `super-linear growth: ${r.tSmall.toFixed(2)} ms at n=${r.n}, ${r.tLarge.toFixed(2)} ms at n=${r.n * SCALE_FACTOR}: ` +
      `ratio ${r.ratio.toFixed(1)}, limit ${MAX_RATIO} (linear is ${SCALE_FACTOR})`,
    );
  }
}
