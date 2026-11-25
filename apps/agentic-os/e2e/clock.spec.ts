import { expect, test } from '@playwright/test';

import { CLOCK_KIND_LIMIT, clockOf, feedRefreshEntries, foldClock, laneClockEntries, type RawClock } from '../src/lib/clock';

/**
 * Pure checks of the clock fold (card agentic-os-readers, reader 4). The rules copy the lane CLI predicates that
 * apps/agentic-os/src/server/queries/lane-coord.ts already holds: LEASE_MINUTES 90, a parked lane has a lease more than
 * LEASE_MINUTES + 1 minutes ahead (lane.mjs :411-418), a reminder is future when due_at is ahead and remind_state is
 * 'scheduled' (REMINDER_DUE_PRED lane.mjs :327-328 is the due side). The DB twin is clock-db.spec.ts.
 * Pure Node. Each test names the source change that breaks it.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const row = (patch: Record<string, unknown> = {}) => ({ id: 'lane-a', ownerHeld: true, leaseExpiresAtMs: null as number | null, dueAtMs: null as number | null, remindState: null as string | null, ...patch });

test.describe('laneClockEntries', () => {
  test('C4 a lease more than 91 minutes ahead is a park end; 91 minutes or less is a lease end; a past lease is neither', () => {
    // Breaks when the park test moves off "more than LEASE_MINUTES + 1" or an expired lease becomes a clock entry (it is a stall).
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW + 6 * 60 * MIN }), NOW).map((e) => e.kind)).toEqual(['park-end']);
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW + 92 * MIN }), NOW).map((e) => e.kind)).toEqual(['park-end']);
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW + 91 * MIN }), NOW).map((e) => e.kind)).toEqual(['lease-end']);
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW + 40 * MIN }), NOW).map((e) => e.kind)).toEqual(['lease-end']);
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW - MIN }), NOW)).toEqual([]);
    expect(laneClockEntries(row({ leaseExpiresAtMs: NOW }), NOW)).toEqual([]);
  });

  test('C6 an unowned lane with a future lease shows nothing', () => {
    expect(laneClockEntries(row({ ownerHeld: false, leaseExpiresAtMs: NOW + 40 * MIN }), NOW)).toEqual([]);
  });

  test('C5 a reminder is future only when due_at is ahead and the state is scheduled', () => {
    // Breaks when acked, due, needs_dave or failed reminders count, or a past due time counts.
    const future = NOW + 24 * 60 * MIN;
    expect(laneClockEntries(row({ ownerHeld: false, dueAtMs: future, remindState: 'scheduled' }), NOW).map((e) => e.kind)).toEqual(['reminder']);
    for (const state of ['acked', 'due', 'needs_dave', 'failed', null]) {
      expect(laneClockEntries(row({ dueAtMs: future, remindState: state }), NOW), String(state)).toEqual([]);
    }
    expect(laneClockEntries(row({ dueAtMs: NOW - 60 * MIN, remindState: 'scheduled' }), NOW)).toEqual([]);
  });

  test('C5b a held lane with both a lease and a reminder gives both entries', () => {
    const out = laneClockEntries(row({ leaseExpiresAtMs: NOW + 40 * MIN, dueAtMs: NOW + 3 * 60 * MIN, remindState: 'scheduled' }), NOW);
    expect(out.map((e) => e.kind).sort()).toEqual(['lease-end', 'reminder']);
  });
});

test.describe('feedRefreshEntries', () => {
  test('C10 an "every Nm" feed refreshes at its export time plus N minutes; a daily feed at its next fire; no export time gives none', () => {
    // Breaks when the cadence is read from the wrong trigger shape or an overdue feed is shown as a future refresh.
    const feeds = [
      { label: 'Open PRs', exportedAtMs: NOW - 4 * MIN, trigger: 'every 15m' },
      { label: 'Lane snapshot', exportedAtMs: NOW - 600 * MIN, trigger: 'daily 23:55' },
      { label: 'No export', exportedAtMs: null, trigger: 'every 15m' },
      { label: 'Overdue', exportedAtMs: NOW - 40 * MIN, trigger: 'every 15m' },
      { label: 'Odd', exportedAtMs: NOW - MIN, trigger: 'monthly 1st' },
    ];
    const out = feedRefreshEntries(feeds, NOW);
    expect(out.find((e) => e.label === 'Open PRs')).toEqual({ kind: 'feed-refresh', label: 'Open PRs', atMs: NOW + 11 * MIN });
    expect(out.find((e) => e.label === 'Lane snapshot')?.atMs).toBe(Date.parse('2026-11-26T05:55:00Z'));
    expect(out.map((e) => e.label).sort()).toEqual(['Lane snapshot', 'Open PRs']);
  });
});

test.describe('foldClock', () => {
  const raw = (kind: RawClock['kind'], label: string, atMin: number): RawClock => ({ kind, label, atMs: NOW + atMin * MIN });

  test('C1 entries sort by time across kinds; ties keep a fixed kind order', () => {
    // Breaks when the sort is by kind first, or the tie order changes silently.
    const out = foldClock([raw('reminder', 'r', 30), raw('lease-end', 'l', 10), raw('feed-refresh', 'f', 30), raw('park-end', 'p', 30), raw('lease-end', 'l2', 30)], NOW);
    expect(out.map((e) => `${e.kind}:${e.label}`)).toEqual(['lease-end:l', 'park-end:p', 'lease-end:l2', 'reminder:r', 'feed-refresh:f']);
  });

  test('C2 a past entry is dropped, "in N min" rounds up and is never negative', () => {
    const out = foldClock([raw('lease-end', 'past', -1), { kind: 'reminder', label: 'soon', atMs: NOW + 30_000 }, raw('park-end', 'later', 61)], NOW);
    expect(out.map((e) => [e.label, e.inMin])).toEqual([['soon', 1], ['later', 61]]);
  });

  test('C9 each kind keeps its soonest 20 entries', () => {
    const many = Array.from({ length: 25 }, (_, i) => raw('reminder', `r${i}`, i + 1));
    const out = foldClock([...many, raw('park-end', 'p', 99)], NOW);
    expect(CLOCK_KIND_LIMIT).toBe(20);
    expect(out.filter((e) => e.kind === 'reminder')).toHaveLength(20);
    expect(out.filter((e) => e.kind === 'reminder').at(-1)?.label).toBe('r19');
    expect(out.filter((e) => e.kind === 'park-end')).toHaveLength(1);
  });

  test('C7 a hostile label (url, uuid, path) goes through cleanText and the entry holds nothing else', () => {
    const hostile = { kind: 'park-end' as const, label: 'lane https://example.invalid/x?t=1 0f5ea433-47f0-466d-aaab-5a7406258ff3 C:\\Users\\someone\\f.txt', atMs: NOW + 120 * MIN, note: 'NOTE_CANARY_7f3a', owner: 'owner-session-id' };
    const text = JSON.stringify(foldClock([hostile as RawClock], NOW));
    for (const bad of ['https://', '0f5ea433-47f0-466d-aaab-5a7406258ff3', 'someone', 'NOTE_CANARY_7f3a', 'owner-session-id']) expect(text, bad).not.toContain(bad);
  });

  test('C11 no entries gives an empty list', () => {
    expect(foldClock([], NOW)).toEqual([]);
  });

  test('C12 clockOf folds the lane rows and the feeds of one read into one sorted list', () => {
    // Breaks when a source (lane rows or feeds) is left out of the one list.
    const out = clockOf({
      rows: [row({ id: 'lane-p', leaseExpiresAtMs: NOW + 300 * MIN }), row({ id: 'lane-r', ownerHeld: false, dueAtMs: NOW + 20 * MIN, remindState: 'scheduled' })],
      feeds: [{ label: 'Open PRs', exportedAtMs: NOW - 10 * MIN, trigger: 'every 15m' }],
      nowMs: NOW,
    });
    expect(out.map((e) => `${e.kind}:${e.label}:${e.inMin}`)).toEqual(['feed-refresh:Open PRs:5', 'reminder:lane-r:20', 'park-end:lane-p:300']);
  });
});
