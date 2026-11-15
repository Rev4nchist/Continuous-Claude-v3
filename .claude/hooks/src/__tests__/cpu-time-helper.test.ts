/**
 * Card hooks-timing-tests-under-load: tests of the CPU-time helper (helpers/cpu-time.ts).
 *
 * Rule B of the card: a speed test measures the CPU time of its own process (user + system), not wall time. A stall (the process is
 * descheduled, waits for memory or a disk) costs wall time and no CPU time, so a busy suite cannot fail it. Measured on this machine
 * (experiment-cpu.json): 24 busy loops on 20 cores made wall time 4.68x and CPU time 1.24x; a waiting process used 0 ms of CPU.
 * Vitest 4 runs each test file in its own forked process (default pool), so process.cpuUsage() is that file's own work.
 *
 * Ways the helper can fail (one test each):
 *  1. user and system time are not added, or the unit is not milliseconds
 *  2. the clock goes backwards between two reads (a delta would be negative)
 *  3. a process that only waits shows CPU time (the helper measures wall time by mistake)
 *  4. cpuTimed does not return the value of the function
 */
import { describe, it, expect } from 'vitest';
import { cpuMs, cpuTimed } from './helpers/cpu-time.js';

describe('cpuMs', () => {
  it('1. adds user and system time and gives milliseconds (the usage is in microseconds)', () => {
    expect(cpuMs(() => ({ user: 1500, system: 500 }))).toBe(2);
    expect(cpuMs(() => ({ user: 0, system: 0 }))).toBe(0);
  });
  it('2. never goes backwards between two reads of the real clock', () => {
    const a = cpuMs();
    let x = 0;
    for (let i = 0; i < 20000; i++) x += i;
    const b = cpuMs();
    expect(x).toBeGreaterThan(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });
  it('3. a process that only waits uses almost no CPU time (wall time is not measured)', async () => {
    const c0 = cpuMs();
    const w0 = Date.now();
    await new Promise((r) => setTimeout(r, 120));
    const wall = Date.now() - w0;
    expect(wall).toBeGreaterThanOrEqual(100);
    expect(cpuMs() - c0).toBeLessThan(wall / 2);
  });
});

describe('the pool this clock needs', () => {
  // cpuMs() reads process.cpuUsage(). That is the work of ONE test file only when vitest runs each file in its own forked child process
  // (default pool `forks`, vitest 4). Under `--pool=threads` the files share one process and cpuUsage() counts the other threads too, so a
  // speed row would measure the work of other test files. The fault direction is safe (more CPU, never less: a false red, not a false green),
  // but a later change of the pool must not slip in unseen.
  it('5. this test file runs in a forked child process, not in a worker thread (seat delta read, 11-14)', async () => {
    const { isMainThread } = await import('node:worker_threads');
    expect(isMainThread, 'a worker thread: the pool is threads, process.cpuUsage() counts other files').toBe(true);
    expect(typeof process.send, 'no IPC channel: this is not a forked child of the vitest main process').toBe('function');
  });
});

describe('cpuTimed', () => {
  it('4. returns the value of the function and the CPU time it used', () => {
    let t = 0;
    const usage = () => ({ user: (t += 3000), system: 1000 }); // each read: user +3 ms
    const r = cpuTimed(() => 'result', usage);
    expect(r.value).toBe('result');
    expect(r.ms).toBe(3);
  });
  it('4b. works for an async function and returns its resolved value', async () => {
    let t = 0;
    const usage = () => ({ user: (t += 2000), system: 0 });
    const r = await cpuTimed(async () => 42, usage);
    expect(r.value).toBe(42);
    expect(r.ms).toBe(2);
  });
});
