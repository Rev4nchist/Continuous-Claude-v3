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
/**
 * Why 20 ms and not the 2 ms of clock noise: the ratio only sees a super-linear term that is material at the size measured. A
 * mutation run (injected quadratic loop, package-install-guard-ecosystems) survived at a 2 ms floor, because the linear work still
 * dominated there. A higher floor measures at a larger n, where the quadratic term weighs more. Cost: about 0.5 s per assertScaling.
 */
export const FLOOR_MS = 20;
export const MAX_DOUBLINGS = 8;
/**
 * Growth guard: every doubling of n is compared with the one before. Linear work gives 2, quadratic 4, cubic 8, exponential far
 * more. A doubling that costs more than GROWTH_GUARD times fails at once and the larger sizes never run. Without it a runaway
 * (a mutant with an exponential regex) would hang the 4n sample, and a test that hangs is not red.
 * NOISE_MS floors the earlier time, so a sample below the clock noise cannot fake a big jump.
 */
export const GROWTH_GUARD = 6;
export const NOISE_MS = FLOOR_MS / 10;

export interface ScalingOptions {
  /** Clock in ms. The default is performance.now. A test of the helper passes a fake clock. */
  now?: () => number;
}

/** `early` is true when the growth guard stopped the run: `tLarge` is then the time at 2n and `ratio` is the guard's ratio. */
export interface ScalingResult { n: number; tSmall: number; tLarge: number; ratio: number; early: boolean }

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
  const runaway = (prev: number, next: number): ScalingResult | null =>
    next > GROWTH_GUARD * Math.max(prev, NOISE_MS)
      ? { n, tSmall: prev, tLarge: next, ratio: next / Math.max(prev, NOISE_MS), early: true }
      : null;
  for (let i = 0; i < MAX_DOUBLINGS && tSmall < FLOOR_MS; i++) {
    const next = await minTime(run, n * 2, now);
    const stop = runaway(tSmall, next);
    if (stop) return stop;
    n *= 2;
    tSmall = next;
  }
  // One more doubling as a guard before the 4n run: cubic or exponential work stops here.
  const mid = await minTime(run, n * 2, now);
  const stop = runaway(tSmall, mid);
  if (stop) return stop;
  const tLarge = await minTime(run, n * SCALE_FACTOR, now);
  return { n, tSmall, tLarge, ratio: tLarge / Math.max(tSmall, FLOOR_MS), early: false };
}

/** Throws when the work grows faster than MAX_RATIO over a SCALE_FACTOR increase in size. The message gives both times. */
export async function assertScaling(run: Run, n0: number, opts: ScalingOptions = {}): Promise<void> {
  const r = await scalingRatio(run, n0, opts);
  if (r.early) {
    throw new Error(
      `super-linear growth (growth guard): ${r.tSmall.toFixed(2)} ms at n=${r.n}, ${r.tLarge.toFixed(2)} ms at n=${r.n * 2}: ` +
      `ratio ${r.ratio.toFixed(1)} for one doubling, limit ${GROWTH_GUARD} (linear is 2)`,
    );
  }
  if (r.ratio > MAX_RATIO) {
    throw new Error(
      `super-linear growth: ${r.tSmall.toFixed(2)} ms at n=${r.n}, ${r.tLarge.toFixed(2)} ms at n=${r.n * SCALE_FACTOR}: ` +
      `ratio ${r.ratio.toFixed(1)}, limit ${MAX_RATIO} (linear is ${SCALE_FACTOR})`,
    );
  }
}
