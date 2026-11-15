/**
 * CPU-time clock for the speed tests of the hooks suite (card hooks-timing-tests-under-load, rule B).
 *
 * Why: a wall-clock limit ("finishes under 1 s") fails when the suite is busy, although the code did not change (decision-gate-app-repos
 * R5 F7b: 1021 ms loaded, 361 ms alone). A stall costs wall time and no CPU time. Measured here (experiment-cpu.json, 24 busy loops on
 * 20 cores): wall time 4.68x, CPU time 1.24x; a process that only waits used 0 ms of CPU.
 *
 * CPU time is NOT load-proof. In a full-suite proof run (11-14 22:4x, other sessions ran test files beside it) R5 F7b took 1047 ms of
 * CPU against 361 ms alone (about 2.9x): cache and hyperthread contention raise CPU time too, and garbage-collector threads count in it.
 * The 1.24x of the experiment holds for one workload and one load shape only. So a row with little headroom (alone time over a quarter
 * of its limit) uses cpuBest(): the MINIMUM of 3 samples. A disturbed sample is only ever slower, so the minimum is the honest reading,
 * and a real slowdown (a backtracking regex) is slow in every sample and still fails. CPU time on Windows ticks in about 15.6 ms steps:
 * a limit must stay far above that (the smallest limit in the suite is 200 ms).
 *
 * Use: `const t0 = cpuMs(); ...work...; expect(cpuMs() - t0).toBeLessThan(1000);` The limits stay what they were.
 * Tight row: `expect(cpuBest(() => cpuTimed(work).ms)).toBeLessThan(1000);`
 * Run the suite with the gate's flags: `--testTimeout=30000` (CI and pre-pr both use it). In the PowerShell tool `npm test -- --flag`
 * DROPS the flag: go through `cmd /c "npm test -- ..."` (see memory powershell-npm-drops-flags).
 *
 * Valid because vitest 4 runs each test file in its own forked process (default pool `forks`): process.cpuUsage() is then the work of
 * that file only. With `--pool=threads` it would count the other threads too.
 * Blind spot: a test that is slow by BLOCKING (a lock, a pipe, a sleep) uses no CPU, so it cannot fail on this clock. The speed tests
 * here are CPU-bound regex and scan work. A test that waits on a real process keeps a loose wall-clock bound (the vitest testTimeout).
 */

/** The shape of process.cpuUsage(): microseconds. A test of this helper passes a fake. */
export type Usage = () => { user: number; system: number };

/** CPU time of this process so far (user + system) in milliseconds. */
export const cpuMs = (usage: Usage = () => process.cpuUsage()): number => {
  const u = usage();
  return (u.user + u.system) / 1000;
};

/** Samples taken by cpuBest. */
export const BEST_SAMPLES = 3;

/** The minimum of `samples` measurements, each a CPU time in milliseconds that `measure` returns. */
export function cpuBest(measure: () => number, samples: number = BEST_SAMPLES): number {
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, measure());
  return best;
}

/** The async form: each sample is awaited (for example a child process that reports its own CPU time). */
export async function cpuBestAsync(measure: () => Promise<number>, samples: number = BEST_SAMPLES): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, await measure());
  return best;
}

/** Run `fn` and give back its value and the CPU milliseconds it used. An async `fn` is awaited. */
export function cpuTimed<T>(fn: () => Promise<T>, usage?: Usage): Promise<{ value: T; ms: number }>;
export function cpuTimed<T>(fn: () => T, usage?: Usage): { value: T; ms: number };
export function cpuTimed<T>(fn: () => T | Promise<T>, usage: Usage = () => process.cpuUsage()): { value: T; ms: number } | Promise<{ value: T; ms: number }> {
  const c0 = cpuMs(usage);
  const out = fn();
  if (out && typeof (out as Promise<T>).then === 'function') {
    return (out as Promise<T>).then((value) => ({ value, ms: cpuMs(usage) - c0 }));
  }
  return { value: out as T, ms: cpuMs(usage) - c0 };
}
