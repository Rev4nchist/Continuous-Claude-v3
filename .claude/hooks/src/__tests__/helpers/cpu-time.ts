/**
 * CPU-time clock for the speed tests of the hooks suite (card hooks-timing-tests-under-load, rule B).
 *
 * Why: a wall-clock limit ("finishes under 1 s") fails when the suite is busy, although the code did not change (decision-gate-app-repos
 * R5 F7b: 1021 ms loaded, 361 ms alone). A stall costs wall time and no CPU time. Measured here (experiment-cpu.json, 24 busy loops on
 * 20 cores): wall time 4.68x, CPU time 1.24x; a process that only waits used 0 ms of CPU.
 *
 * Use: `const t0 = cpuMs(); ...work...; expect(cpuMs() - t0).toBeLessThan(1000);` The limits stay what they were.
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
