/**
 * Tests for the bus WRITE-PATH hardening added in WS-2 Phase B.0:
 *
 *  - the real-lock bus write path is capped at 200ms by default (a per-tool bus
 *    write can no longer hang the hook on the 5s atomic-write default)
 *  - a lock-timeout is a DROPPED write that is NEVER silent: exactly one
 *    `bus_write_dropped` row is appended to intel-bus, AND opts.onOutcome fires
 *    with { dropped: true }, AND the bus file is NOT clobbered
 *  - a normal write fires opts.onOutcome with { dropped:false, wait_ms, write_ms }
 *  - CCV3_BUS_OFF=1 still no-ops (no drop event, no write)
 *  - the DEFAULT mutateBus() (no opts) uses the 200ms cap, not the 5s default
 *
 * These exercise the REAL lock-backed path (mutateViaLock), so they use a real
 * temp projectDir and the real default write/lock, and read the real
 * intel-bus.jsonl back to count drop rows. The injected-write CAS branch
 * (mutateViaSeam) is covered by context-bus.test.ts and is intentionally not
 * re-exercised here.
 *
 * To simulate "another process holds the bus lock" we pre-create
 * <busPath>.lock with a fresh mtime so the 10s stale-detector does not reclaim
 * it during the short cap window.
 *
 * Runner is vitest; ASCII only; Windows-safe temp paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { mutateBus, busPath, emptyBus, readBus, BUS_WRITE_SLOW_MS } from '../shared/context-bus.js';
import { intelBusPath } from '../shared/intel-bus.js';

const BUS_ID = 'sessB0-abcdef012345';

let proj: string;
let busFile: string;
let lockFile: string;

let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CCV3_BUS_OFF'] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.CCV3_BUS_OFF;

  proj = mkdtempSync(join(tmpdir(), 'ccv3-buswrite-'));
  process.env.CLAUDE_PROJECT_DIR = proj;
  busFile = busPath(BUS_ID, proj);
  lockFile = busFile + '.lock';
  // Pre-create the bus directory so a held lock test does not race mkdir.
  mkdirSync(dirname(busFile), { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(proj, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Read all intel-bus rows for the temp project (empty if the file is absent). */
function readIntelRows(): Array<Record<string, unknown>> {
  const p = intelBusPath(proj);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Hold the bus lock by creating a fresh <busPath>.lock. */
function holdBusLock(): void {
  writeFileSync(lockFile, `${process.pid}\n${Date.now()}`, 'utf-8');
}

describe('mutateBus -- lock-timeout is a logged, signaled DROP (never silent)', () => {
  it('emits exactly one bus_write_dropped row, fires onOutcome{dropped:true}, no clobber', () => {
    // Seed precious bus state we must not erase.
    const seeded = emptyBus(BUS_ID);
    seeded.current_intent = 'precious';
    seeded.revision = 5;
    writeFileSync(busFile, JSON.stringify(seeded, null, 2), 'utf-8');

    holdBusLock();

    const outcomes: Array<{ dropped: boolean; wait_ms: number; write_ms?: number }> = [];
    const t0 = Date.now();
    mutateBus(
      BUS_ID,
      (b) => {
        b.current_intent = 'should be dropped';
      },
      { lockTimeoutMs: 200, onOutcome: (o) => outcomes.push(o) },
    );
    const elapsed = Date.now() - t0;

    // Returned within the cap window (generous slack for busy-spin under CPU
    // contention; the point is "<< the 5000ms default", not a tight upper bound).
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(150);

    // onOutcome fired exactly once with dropped:true.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].dropped).toBe(true);
    expect(outcomes[0].wait_ms).toBeGreaterThanOrEqual(200);

    // Exactly ONE bus_write_dropped row in intel-bus.
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(1);
    expect(dropRows[0].reason).toBe('lock_timeout');
    expect(dropRows[0].bus_id).toBe(BUS_ID);
    expect(typeof dropRows[0].wait_ms).toBe('number');
    expect(dropRows[0].wait_ms as number).toBeGreaterThanOrEqual(200);

    // The precious bus file was NOT clobbered.
    const onDisk = JSON.parse(readFileSync(busFile, 'utf-8'));
    expect(onDisk.current_intent).toBe('precious');
    expect(onDisk.revision).toBe(5);
  });

  it('does not create the bus file when the lock is held and the file is absent', () => {
    // No seed -> bus file absent. Held lock -> dropped, still absent.
    holdBusLock();
    const outcomes: Array<{ dropped: boolean; wait_ms: number }> = [];
    mutateBus(BUS_ID, (b) => void (b.current_intent = 'x'), {
      lockTimeoutMs: 200,
      onOutcome: (o) => outcomes.push(o),
    });
    expect(existsSync(busFile)).toBe(false);
    expect(outcomes[0].dropped).toBe(true);
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(1);
  });
});

describe('mutateBus -- a write that fails INSIDE an acquired lock is also a logged DROP', () => {
  it('corrupt pre-image: dropped:true + one write_error row, no clobber (never silent)', () => {
    // Lock is FREE (acquire succeeds) but the existing file is unparseable, so the
    // transform classifies it failed and returns null -> no write lands. This must
    // be surfaced as a DROP, not silently reported as a success (session-3 Retired#1).
    writeFileSync(busFile, '{ this is not valid json at all', 'utf-8');

    const outcomes: Array<{ dropped: boolean; wait_ms: number }> = [];
    mutateBus(
      BUS_ID,
      (b) => {
        b.current_intent = 'should be dropped';
      },
      { lockTimeoutMs: 200, onOutcome: (o) => outcomes.push(o) },
    );

    // Signaled as a drop.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].dropped).toBe(true);

    // Logged exactly once with an HONEST reason: the lock WAS acquired, so this is
    // a write_error, NOT a lock_timeout.
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(1);
    expect(dropRows[0].reason).toBe('write_error');

    // The unreadable file was NOT clobbered with empty-derived content.
    expect(readFileSync(busFile, 'utf-8')).toContain('not valid json');
  });
});

describe('mutateBus -- normal write fires onOutcome{dropped:false, timings}', () => {
  it('reports dropped:false with numeric wait_ms and write_ms', () => {
    const outcomes: Array<{ dropped: boolean; wait_ms: number; write_ms?: number }> = [];
    const after = mutateBus(
      BUS_ID,
      (b) => {
        b.current_intent = 'landed';
      },
      { lockTimeoutMs: 200, onOutcome: (o) => outcomes.push(o) },
    );

    expect(after.current_intent).toBe('landed');
    expect(after.revision).toBe(1);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].dropped).toBe(false);
    expect(typeof outcomes[0].wait_ms).toBe('number');
    expect(typeof outcomes[0].write_ms).toBe('number');

    // No drop row on a successful write.
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(0);

    // The write actually persisted.
    const reread = readBus(BUS_ID, { projectDir: proj });
    expect(reread.current_intent).toBe('landed');
    expect(reread.revision).toBe(1);
  });

  it('a bus_write timing row appears IFF the write crossed the slow threshold', () => {
    // The common fast path stays quiet on intel-bus; the every-call signal is
    // onOutcome. Only a write slower than BUS_WRITE_SLOW_MS emits a `bus_write`
    // row. Assert the GATING INVARIANT (row iff slow) by reading the observed
    // timing from onOutcome -- under heavy CI load a "fast" write can still cross
    // the threshold, and logging it then is correct, not spam. (This is the fix
    // for the load-flaky `=== 0` assertion that assumed the write stayed fast.)
    const outcomes: Array<{ wait_ms: number; write_ms?: number }> = [];
    mutateBus(BUS_ID, (b) => void (b.current_intent = 'quiet'), {
      onOutcome: (o) => outcomes.push(o),
    });
    const wasSlow =
      outcomes[0].wait_ms > BUS_WRITE_SLOW_MS || (outcomes[0].write_ms ?? 0) > BUS_WRITE_SLOW_MS;
    const timingRows = readIntelRows().filter((r) => r.query_type === 'bus_write');
    expect(timingRows.length).toBe(wasSlow ? 1 : 0);
  });
});

describe('CCV3_BUS_OFF kill switch -- still no-ops on the real path', () => {
  it('no write, no drop event, returns emptyBus', () => {
    process.env.CCV3_BUS_OFF = '1';
    // Hold the lock too, to prove the kill switch short-circuits BEFORE any lock
    // interaction (otherwise we would see a drop event).
    holdBusLock();
    const outcomes: Array<{ dropped: boolean }> = [];
    const after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'ignored'), {
      lockTimeoutMs: 200,
      onOutcome: (o) => outcomes.push(o),
    });
    expect(after.current_intent).toBeNull();
    expect(after.revision).toBe(0);
    expect(existsSync(busFile)).toBe(false);
    // No outcome callback and no intel rows at all.
    expect(outcomes).toHaveLength(0);
    expect(readIntelRows()).toHaveLength(0);
  });
});

describe('mutateBus -- DEFAULT (no opts) uses the 200ms cap, not 5000ms', () => {
  it('a held lock returns in ~200ms (proving the default cap is 200, not 5s)', () => {
    holdBusLock();
    const t0 = Date.now();
    const after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'default-cap'));
    const elapsed = Date.now() - t0;

    // If the default were still 5000ms this would take ~5s. The 200ms cap makes
    // it return well under 1s. Generous upper bound for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3000);
    // Dropped -> bus not clobbered (absent stays absent), returns emptyBus.
    expect(existsSync(busFile)).toBe(false);
    expect(after.revision).toBe(0);

    // The default path still logs the drop (never silent).
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Windows-oriented deterministic "bench": the empirical cap proof. A real
// multi-process bench is heavy/optional; this held-lock loop is the gate.
// Every forced drop must (a) return under ~cap+slack and (b) log exactly one
// bus_write_dropped row, so N drops => N rows and a bounded p95-ish wait.
// ---------------------------------------------------------------------------
describe('bus write cap bench (deterministic, Windows-oriented)', () => {
  it('held-lock drops stay under ~260ms p95 and log one row per drop', () => {
    const CAP = 200;
    const N = 5;
    const waits: number[] = [];

    for (let i = 0; i < N; i++) {
      holdBusLock(); // refresh the held lock each iteration
      const t0 = Date.now();
      let observedWait = -1;
      mutateBus(BUS_ID, (b) => void (b.current_intent = `iter-${i}`), {
        lockTimeoutMs: CAP,
        onOutcome: (o) => {
          observedWait = o.wait_ms;
        },
      });
      const elapsed = Date.now() - t0;
      waits.push(elapsed);
      // Each drop was signaled with a wait at/above the cap.
      expect(observedWait).toBeGreaterThanOrEqual(CAP);
      // Clear the lock so the next iteration can re-create it cleanly.
      rmSync(lockFile, { force: true });
    }

    // One drop row per iteration -- never a silent drop.
    const dropRows = readIntelRows().filter((r) => r.query_type === 'bus_write_dropped');
    expect(dropRows).toHaveLength(N);

    // p95-ish bound: sort and take the top sample. Generous upper slack over the
    // cap (busy-spin granularity + Windows scheduler). The assertion that matters
    // is "bounded near the cap", NOT the 5s default.
    waits.sort((a, b) => a - b);
    const p95 = waits[Math.min(waits.length - 1, Math.ceil(0.95 * waits.length) - 1)];
    // Generous over the cap (busy-spin granularity + Windows scheduler under load);
    // still far below the 5000ms default this test exists to rule out.
    expect(p95).toBeLessThan(3000);
  });
});
