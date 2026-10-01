/**
 * Read-outcome logging for tldr-read-enforcer (plan 2026-09-30, T2; PR #70 review fixes).
 *
 * Failure modes each test pins (name the source change that breaks it):
 *  1. deny row loses the net-savings metrics the aggregator reads
 *     -> drop bytes_raw/bytes_injected from buildLogRow.
 *  2. an error fail_open row is counted as a success
 *     -> remove the `failures` branch for reason 'error'.
 *  3. the rollup drops events, double counts them, or wipes other keys
 *     -> change the per-key sum in aggregateJournal or the journal rename in rollupJournal.
 *  4. one corrupt or half-written journal line poisons every other count
 *     -> remove the per-line shape check in aggregateJournal.
 *  5. logging litters a project that has no .tldr dir
 *     -> remove the `.tldr` existsSync guard in recordRead.
 *  6. a deny, a non-daemon fail_open or an error fail_open is batched away instead of one row each
 *     -> widen isBatched in recordRead.
 *  7. batched events write one row each, or a daemon-down fail_open writes one row per Read
 *     -> remove 'daemon_unreachable*' from isBatched, or the size gate in recordRead.
 *  8. an unwritable stats path throws into the hook (would break the stdout contract)
 *     -> remove the try/catch in recordRead.
 *  9. NaN or negative durations reach the log
 *     -> remove the clamp in buildLogRow.
 * 10. events are lost between hook processes (the review measured 58% loss)
 *     -> replace the appendFileSync journal with a read-modify-write file.
 * 11. a second roller (lost race) throws or writes a duplicate row
 *     -> remove the ENOENT tolerance on the rename in rollupJournal.
 * 12. hook_activity.jsonl grows without bound
 *     -> remove the size check in appendLogRows.
 * 13. a daemon-down fail_open counts as a success
 *     -> set successes back to `count` for fail_open in buildLogRow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  readdirSync,
  truncateSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildLogRow,
  aggregateJournal,
  appendLogRows,
  rollupJournal,
  recordRead,
  LOG_MAX_BYTES,
} from '../tldr-read-enforcer.js';

let dir: string;
const statsDir = () => join(dir, '.tldr', 'stats');
const logPath = () => join(statsDir(), 'hook_activity.jsonl');
const jnl = () => join(statsDir(), 'tldr-read-enforcer.events.jnl');
const rows = () => readFileSync(logPath(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
const journalLines = () =>
  existsSync(jnl()) ? readFileSync(jnl(), 'utf-8').split('\n').filter(Boolean).length : 0;
const recorded = () =>
  (existsSync(logPath()) ? rows().reduce((s, r) => s + r.count, 0) : 0) + journalLines();

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

  it('never counts a fail_open as a success; the count stays in its own field', () => {
    const err: any = buildLogRow({ outcome: 'fail_open', reason: 'error', duration_ms: 3 });
    const down: any = buildLogRow({ outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 3 }, 7);
    expect([err.failures, err.successes]).toEqual([1, 0]);
    expect([down.failures, down.successes, down.count, down.invocations]).toEqual([0, 0, 7, 7]);
    const ok: any = buildLogRow({ outcome: 'allow', reason: 'prefilter', duration_ms: 1 }, 4);
    expect([ok.successes, ok.failures]).toEqual([4, 0]);
  });

  it('clamps NaN and negative durations to 0', () => {
    expect((buildLogRow({ outcome: 'allow', reason: 'prefilter', duration_ms: NaN }) as any).duration_ms).toBe(0);
    expect((buildLogRow({ outcome: 'allow', reason: 'prefilter', duration_ms: -5 }) as any).duration_ms).toBe(0);
  });
});

describe('aggregateJournal', () => {
  it('sums count and ms per outcome|reason key', () => {
    const text = 'allow|prefilter|1.5\nbelow_threshold|below_threshold|2\nallow|prefilter|0.5\n';
    expect(aggregateJournal(text)).toEqual([
      { key: 'allow|prefilter', n: 2, ms: 2 },
      { key: 'below_threshold|below_threshold', n: 1, ms: 2 },
    ]);
  });

  it('skips corrupt and half-written lines without losing the good ones', () => {
    const text = 'allow|prefilter|1\n\u0000\u0000garbage\nallow|prefil\n|||\nallow|prefilter|1\nfail_open|daemon_unreachable|x\n';
    const r = aggregateJournal(text);
    expect(r.find((x) => x.key === 'allow|prefilter')).toEqual({ key: 'allow|prefilter', n: 2, ms: 2 });
    expect(r.every((x) => x.n > 0)).toBe(true);
  });
});

describe('recordRead', () => {
  it('writes nothing and creates nothing when the project has no .tldr dir', () => {
    recordRead(dir, { outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 1 });
    expect(existsSync(join(dir, '.tldr'))).toBe(false);
  });

  it('logs deny, error and other fail_open events one row each, immediately', () => {
    mkdirSync(join(dir, '.tldr'));
    recordRead(dir, { outcome: 'deny', reason: 'summary_injected', duration_ms: 10, bytes_raw: 9000, bytes_injected: 1000, layers_returned: 2 });
    recordRead(dir, { outcome: 'fail_open', reason: 'error', duration_ms: 2 });
    recordRead(dir, { outcome: 'fail_open', reason: 'summary_insufficient', duration_ms: 2 });
    const r = rows();
    expect(r.map((x) => x.reason)).toEqual(['summary_injected', 'error', 'summary_insufficient']);
    expect(r[0].metrics.bytes_raw).toBe(9000);
    expect(r[1]).toMatchObject({ failures: 1, successes: 0 });
  });

  it('journals allow, below_threshold and daemon-down events: no log row below the rollup size', () => {
    mkdirSync(join(dir, '.tldr'));
    recordRead(dir, { outcome: 'below_threshold', reason: 'below_threshold', duration_ms: 1 });
    recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 0.5 });
    recordRead(dir, { outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 1 });
    recordRead(dir, { outcome: 'fail_open', reason: 'daemon_unreachable_cached', duration_ms: 1 });
    expect(existsSync(logPath())).toBe(false);
    expect(journalLines()).toBe(4);
  });

  it('rolls the journal up into one row per key past the size threshold, losing nothing', () => {
    mkdirSync(join(dir, '.tldr'));
    const total = 400;
    for (let i = 0; i < total; i++) {
      recordRead(dir, i % 2 === 0
        ? { outcome: 'fail_open', reason: 'daemon_unreachable', duration_ms: 1 }
        : { outcome: 'allow', reason: 'prefilter', duration_ms: 1 });
    }
    const r = rows();
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(total / 10); // batched, not one row per read
    expect(recorded()).toBe(total); // nothing lost, nothing double counted
    const down = r.filter((x) => x.reason === 'daemon_unreachable');
    expect(down.length).toBeGreaterThan(0);
    for (const x of down) expect(x).toMatchObject({ outcome: 'fail_open', successes: 0, failures: 0 });
    expect(readdirSync(statsDir()).filter((f) => f.includes('.rolling'))).toEqual([]);
  });

  it('tolerates a lost rollup race: no journal, no throw, no row', () => {
    mkdirSync(statsDir(), { recursive: true });
    writeFileSync(jnl(), 'allow|prefilter|1\n'.repeat(3));
    renameSync(jnl(), join(statsDir(), 'taken-by-the-other-roller')); // the other process wins the rename
    expect(() => rollupJournal(statsDir(), logPath())).not.toThrow();
    expect(existsSync(logPath())).toBe(false);
  });

  it('a torn journal tail does not reset the other counts', () => {
    mkdirSync(statsDir(), { recursive: true });
    for (let i = 0; i < 5; i++) recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 1 });
    const full = readFileSync(jnl(), 'utf-8');
    truncateSync(jnl(), full.length - 3); // tear the last line
    recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 1 });
    const agg = aggregateJournal(readFileSync(jnl(), 'utf-8'));
    // 4 intact lines survive; the torn one and the new one are the only ones at risk.
    expect(agg.find((x) => x.key === 'allow|prefilter')!.n).toBeGreaterThanOrEqual(4);
  });

  it('rotates hook_activity.jsonl to .1 at the size cap and keeps one generation', () => {
    mkdirSync(statsDir(), { recursive: true });
    writeFileSync(logPath(), 'x'.repeat(LOG_MAX_BYTES));
    writeFileSync(logPath() + '.1', 'older generation');
    appendLogRows(logPath(), [{ n: 1 }]);
    expect(readFileSync(logPath(), 'utf-8')).toBe('{"n":1}\n');
    expect(readFileSync(logPath() + '.1', 'utf-8')).toHaveLength(LOG_MAX_BYTES);
    expect(readdirSync(statsDir()).sort()).toEqual(['hook_activity.jsonl', 'hook_activity.jsonl.1']);
  });

  it('does not rotate below the cap', () => {
    mkdirSync(statsDir(), { recursive: true });
    writeFileSync(logPath(), 'x'.repeat(100) + '\n');
    appendLogRows(logPath(), [{ n: 1 }]);
    expect(existsSync(logPath() + '.1')).toBe(false);
  });

  it('does not throw when the stats path is unwritable', () => {
    mkdirSync(join(dir, '.tldr'));
    writeFileSync(join(dir, '.tldr', 'stats'), 'i am a file, not a dir');
    expect(() => recordRead(dir, { outcome: 'deny', reason: 'summary_injected', duration_ms: 1 })).not.toThrow();
    expect(() => recordRead(dir, { outcome: 'allow', reason: 'prefilter', duration_ms: 1 })).not.toThrow();
  });
});
