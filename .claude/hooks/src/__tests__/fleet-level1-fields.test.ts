/**
 * Fleet level 1 card fields: lease seconds, lease tone, lease text, goal fallback, lane grouping.
 *
 * The code lives in the Agentic OS app (apps/agentic-os/src/server/queries/fleet-card-fields.ts), a pure
 * file with no `server-only` and no database import, so this runner can load it. The app has no vitest
 * of its own. Same load-by-URL pattern as lane-sort-twin.test.ts.
 *
 * Each test names the change that breaks it:
 *   lease seconds   a swapped subtraction, a missing round, no null guard
 *   tone            a `<` for a `<=` at the boundaries, lapsed read as short
 *   goal            a swapped order, an empty brief goal that wins, a last-lane pick
 *   grouping        keeping the first lane only (the old behaviour), losing the order
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// The module sits outside this package's rootDir, so its shape is declared here and checked at run time.
type HeldLane = { id: string; title: string | null; leaseSecondsLeft: number | null };
type Fields = {
  LEASE_SHORT_SECONDS: number;
  leaseSecondsLeft: (expires: number | null | undefined, dbNow: number) => number | null;
  leaseTone: (seconds: number | null) => 'ok' | 'short' | 'lapsed' | 'none';
  formatLease: (seconds: number | null) => string;
  goalOf: (briefGoal: string | null | undefined, lanes: { title: string | null }[]) => string | null;
  groupHeldLanes: (
    rows: { id: string; title: string | null; owner_session_id: string; lease_expires_epoch: number | null }[],
    dbNow: number,
  ) => Map<string, HeldLane[]>;
};

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const f: Fields = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/fleet-card-fields.ts')
);

describe('leaseSecondsLeft', () => {
  it('is the lease end minus the database clock, in whole seconds', () => {
    expect(f.leaseSecondsLeft(1_000_300, 1_000_000)).toBe(300);
    expect(f.leaseSecondsLeft(1_000_300.4, 1_000_000)).toBe(300);
    expect(f.leaseSecondsLeft(1_000_300.6, 1_000_000)).toBe(301);
  });

  it('is negative once the lease has lapsed', () => {
    expect(f.leaseSecondsLeft(1_000_000, 1_000_120)).toBe(-120);
  });

  it('is null when the lane has no lease', () => {
    expect(f.leaseSecondsLeft(null, 1_000_000)).toBeNull();
    expect(f.leaseSecondsLeft(undefined, 1_000_000)).toBeNull();
    expect(f.leaseSecondsLeft(Number.NaN, 1_000_000)).toBeNull();
  });
});

describe('leaseTone', () => {
  it('reads amber (short) at the threshold and below, ok above it', () => {
    expect(f.leaseTone(f.LEASE_SHORT_SECONDS + 1)).toBe('ok');
    expect(f.leaseTone(f.LEASE_SHORT_SECONDS)).toBe('short');
    expect(f.leaseTone(1)).toBe('short');
  });

  it('reads lapsed at zero and below, and none with no lease', () => {
    expect(f.leaseTone(0)).toBe('lapsed');
    expect(f.leaseTone(-1)).toBe('lapsed');
    expect(f.leaseTone(null)).toBe('none');
  });
});

describe('formatLease', () => {
  it('counts down in hours and minutes, rounding the remainder down', () => {
    expect(f.formatLease(5_400)).toBe('lease 1h 30m left');
    expect(f.formatLease(3_599)).toBe('lease 59m left');
    expect(f.formatLease(90)).toBe('lease 1m left');
    expect(f.formatLease(59)).toBe('lease <1m left');
  });

  it('says how long ago a lapsed lease ended, and the no-lease case', () => {
    expect(f.formatLease(0)).toBe('lease lapsed just now');
    expect(f.formatLease(-300)).toBe('lease lapsed 5m ago');
    expect(f.formatLease(-7_200)).toBe('lease lapsed 2h ago');
    expect(f.formatLease(null)).toBe('no lease');
  });
});

describe('goalOf', () => {
  const lanes = [{ title: 'First lane title' }, { title: 'Second lane title' }];

  it('prefers the brief goal over any lane title', () => {
    expect(f.goalOf('Ship the card', lanes)).toBe('Ship the card');
  });

  it('falls back to the FIRST lane title, not the last', () => {
    expect(f.goalOf(null, lanes)).toBe('First lane title');
    expect(f.goalOf(undefined, lanes)).toBe('First lane title');
  });

  it('treats an empty or blank brief goal as missing', () => {
    expect(f.goalOf('', lanes)).toBe('First lane title');
    expect(f.goalOf('   \n ', lanes)).toBe('First lane title');
  });

  it('skips a lane with a blank title and takes the next one', () => {
    expect(f.goalOf(null, [{ title: ' ' }, { title: null }, { title: 'Third' }])).toBe('Third');
  });

  it('is null when no source has text (the first prompt is not in the data)', () => {
    expect(f.goalOf(null, [])).toBeNull();
    expect(f.goalOf('', [{ title: null }])).toBeNull();
  });

  it('collapses whitespace so the card line is one line', () => {
    expect(f.goalOf('Line one\n  line two', [])).toBe('Line one line two');
  });
});

describe('groupHeldLanes', () => {
  const now = 2_000_000;
  const rows = [
    { id: 'lane-a', title: 'A', owner_session_id: 's1', lease_expires_epoch: now + 600 },
    { id: 'lane-b', title: 'B', owner_session_id: 's2', lease_expires_epoch: null },
    { id: 'lane-c', title: 'C', owner_session_id: 's1', lease_expires_epoch: now - 60 },
    { id: 'lane-d', title: 'D', owner_session_id: 's1', lease_expires_epoch: now + 7_200 },
  ];

  it('keeps ALL lanes of an owner, in the order the query returned them', () => {
    const grouped = f.groupHeldLanes(rows, now);
    expect(grouped.get('s1')?.map((l) => l.id)).toEqual(['lane-a', 'lane-c', 'lane-d']);
    expect(grouped.get('s2')?.map((l) => l.id)).toEqual(['lane-b']);
  });

  it('carries each lane lease seconds: open, lapsed and none', () => {
    const grouped = f.groupHeldLanes(rows, now);
    expect(grouped.get('s1')?.map((l) => l.leaseSecondsLeft)).toEqual([600, -60, 7_200]);
    expect(grouped.get('s2')?.[0].leaseSecondsLeft).toBeNull();
  });

  it('reads a string epoch from the driver as a number', () => {
    const grouped = f.groupHeldLanes(
      [{ id: 'x', title: 'X', owner_session_id: 's9', lease_expires_epoch: String(now + 30) as unknown as number }],
      now,
    );
    expect(grouped.get('s9')?.[0].leaseSecondsLeft).toBe(30);
  });
});
