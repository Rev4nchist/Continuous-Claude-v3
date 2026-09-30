/**
 * Read-outcome logging for tldr-read-enforcer (plan 2026-09-30, T2).
 *
 * Failure modes each test pins (name the source change that breaks it):
 *  1. deny row loses the net-savings metrics the aggregator reads
 *     -> drop bytes_raw/bytes_injected from buildLogRow.
 *  2. an error fail_open row is counted as a success
 *     -> remove the `failures` branch for reason 'error'.
 *  3. batched counter never flushes, or flushes early, or wipes other keys
 *     -> change the `n >= flushAt` test in bumpCounter.
 *  4. a corrupt counter file throws or poisons later counts
 *     -> remove the shape check in bumpCounter.
 *  5. logging litters a project that has no .tldr dir
 *     -> remove the `.tldr` existsSync guard in recordRead.
 *  6. a deny/fail_open event is batched away instead of logged one per row
 *     -> add 'deny' to the batched set.
 *  7. batched events write one row each (log volume explosion)
 *     -> remove the counter in recordRead.
 *  8. an unwritable stats path throws into the hook (would break the stdout contract)
 *     -> remove the try/catch in recordRead.
 *  9. NaN or negative durations reach the log
 *     -> remove the clamp in buildLogRow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildLogRow, bumpCounter, recordRead, BATCH_FLUSH_AT } from '../tldr-read-enforcer.js';

let dir: string;
const logPath = () => join(dir, '.tldr', 'stats', 'hook_activity.jsonl');
const rows = () => readFileSync(logPath(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tldr-enforcer-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildLogRow', () => {
  it('keeps the deny metrics the stats aggregator reads, plus outcome and duration', () => {
    const row: any = buildLogRow(
      { outcome: 'deny', reason: 'summary_injected', duration_ms: 42.4, bytes_raw: 9000, bytes_injected: 1500, layers_returned: 2 },
      1,
      new Date('2026-09-30T12:00:00Z'),
    );
    expect(row).toMatchObject({
      hook_name: 'tldr-read-enforcer',
      invocations: 1,
      successes: 1,
      failures: 0,
      outcome: 'deny',
      duration_ms: 42.4,
      timestamp: '2026-09-30T12:00:00.000Z',
    });
    expect(row.metrics).toMatchObject({ reads_intercepted: 1, layers_returned: 2, bytes_raw: 9000, bytes_injected: 1500, duration_ms: 42.4 });
  });

  it('counts an error fail_open as a failure but a daemon-down fail_open as a success', () => {
    const err: any = buildLogRow({ outcome: 'fail_open', reason: 'error', duration_ms: 3 });
    const down: any = buildLogRow({ outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 3 });
    expect([err.failures, err.successes]).toEqual([1, 0]);
    expect([down.failures, down.successes]).toEqual([0, 1]);
  });

  it('clamps NaN and negative durations to 0', () => {
    expect((buildLogRow({ outcome: 'allow', reason: 'prefilter', duration_ms: NaN }) as any).duration_ms).toBe(0);
    expect((buildLogRow({ outcome: 'allow', reason: 'prefilter', duration_ms: -5 }) as any).duration_ms).toBe(0);
  });
});

describe('bumpCounter', () => {
  it('flushes one key at the threshold, resets it, and leaves other keys alone', () => {
    let state: any = { 'allow|prefilter': { n: 2, ms: 1 } };
    for (let i = 0; i < 4; i++) {
      const r = bumpCounter(state, 'below_threshold|below_threshold', 2, 5);
      expect(r.flush).toBeNull();
      state = r.state;
    }
    const last = bumpCounter(state, 'below_threshold|below_threshold', 2, 5);
    expect(last.flush).toEqual({ key: 'below_threshold|below_threshold', n: 5, ms: 10 });
    expect(last.state['below_threshold|below_threshold']).toBeUndefined();
    expect(last.state['allow|prefilter']).toEqual({ n: 2, ms: 1 });
  });

  it('treats a corrupt state as empty instead of throwing', () => {
    for (const bad of [null, undefined, 'x', 7, [1, 2], { k: 'nope' }]) {
      const r = bumpCounter(bad as any, 'allow|prefilter', 1, 5);
      expect(r.state['allow|prefilter']).toEqual({ n: 1, ms: 1 });
      expect(r.flush).toBeNull();
    }
  });
});

describe('recordRead', () => {
  it('writes nothing and creates nothing when the project has no .tldr dir', () => {
    recordRead(dir, { outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 1 });
    expect(existsSync(join(dir, '.tldr'))).toBe(false);
  });

  it('logs deny and fail_open events one row each, immediately', () => {
    mkdirSync(join(dir, '.tldr'));
    recordRead(dir, { outcome: 'deny', reason: 'summary_injected', duration_ms: 10, bytes_raw: 9000, bytes_injected: 1000, layers_returned: 2 });
    recordRead(dir, { outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 2 });
    const r = rows();
    expect(r.map((x) => x.outcome)).toEqual(['deny', 'fail_open']);
    expect(r[0].metrics.bytes_raw).toBe(9000);
  });

  it('batches below_threshold and allow events: no row until the threshold, then one row with the count', () => {
    mkdirSync(join(dir, '.tldr'));
    for (let i = 0; i < BATCH_FLUSH_AT - 1; i++) {
      recordRead(dir, { outcome: 'below_threshold', reason: 'below_threshold', duration_ms: 1 });
      recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 0.5 });
    }
    // 24 of each so far: neither key reached 25, so the log file must not exist yet.
    expect(existsSync(logPath())).toBe(false);
    recordRead(dir, { outcome: 'below_threshold', reason: 'below_threshold', duration_ms: 1 });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ outcome: 'below_threshold', count: BATCH_FLUSH_AT, invocations: BATCH_FLUSH_AT, duration_ms: BATCH_FLUSH_AT });
    expect(r[0].metrics.reads_seen).toBe(BATCH_FLUSH_AT);
  });

  it('does not throw when the stats path is unwritable or the counter file is corrupt', () => {
    mkdirSync(join(dir, '.tldr'));
    writeFileSync(join(dir, '.tldr', 'stats'), 'i am a file, not a dir');
    expect(() => recordRead(dir, { outcome: 'deny', reason: 'summary_injected', duration_ms: 1 })).not.toThrow();
    expect(() => recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 1 })).not.toThrow();
  });

  it('recovers from a corrupt counter file', () => {
    mkdirSync(join(dir, '.tldr', 'stats'), { recursive: true });
    writeFileSync(join(dir, '.tldr', 'stats', 'tldr-read-enforcer.counts.json'), '{not json');
    expect(() => recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 1 })).not.toThrow();
    const saved = JSON.parse(readFileSync(join(dir, '.tldr', 'stats', 'tldr-read-enforcer.counts.json'), 'utf-8'));
    expect(saved['allow|prefilter'].n).toBe(1);
  });
});
