import { expect, test } from '@playwright/test';

import * as sources from '../src/lib/reader-sources';
import { createGreenTracker } from '../src/lib/stalls';
import type { ReaderOutcome } from '../src/lib/reader-sources';
import { nextFireMs } from '../src/lib/tasks-parse';

/**
 * The five known limits of the readers (card agentic-os-readers-edge-limits): a partial or stale read is never called complete.
 * Pure Node, one failing spec per item. Every time value is passed in as an argument or built from a fixed date: no spec reads the real
 * clock (the lesson of the cr-paid-post break of 2026-11-25: a fixed test date met a real-clock rule).
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const at = (iso: string) => Date.parse(iso);
const ok = (patch: Record<string, unknown> = {}): ReaderOutcome => ({ ok: true, readAtMs: NOW - 2 * MIN, ...patch }) as ReaderOutcome;

test.describe('item 1: a capped or skipped PR feed is not complete', () => {
  test('E1a the partial reason names a cap and a skip count, and is null for a clean feed', () => {
    // Breaks when the feed flags capped and skipped are not read: the stalls source row would call a cut feed complete.
    expect(sources.prFeedPartial({ capped: false, skipped: 0 })).toBeNull();
    expect(sources.prFeedPartial({ capped: true, skipped: 0 })).toMatch(/capped/);
    expect(sources.prFeedPartial({ capped: false, skipped: 3 })).toMatch(/3 .*skipped/);
    expect(sources.prFeedPartial({ capped: true, skipped: 2 })).toMatch(/capped.*2 .*skipped/);
  });

  test('E1b a partial feed makes the stalls source row degraded, with the reason in the detail (no new status word)', () => {
    // Breaks when the reason is not passed as `partial` to the row: the snapshot would show ok for a cut feed.
    const reason = sources.prFeedPartial({ capped: true, skipped: 0 });
    const row = sources.readerSource('stalls', ok({ partial: reason ?? undefined }), NOW);
    expect(row.status).toBe('degraded');
    expect(row.detail).toMatch(/partial read \(.*capped.*\)/);
  });
});

test.describe('item 2: a cut lane query says so', () => {
  test('E2 capRows keeps the limit and reports a cut only when a row was dropped', () => {
    // Breaks when the query reads exactly the limit and cannot tell a cut from a fit: the caller asks for limit + 1 rows.
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `lane-${i}` }));
    const cut = sources.capRows(rows, 500);
    expect(cut.rows).toHaveLength(500);
    expect(cut.truncated).toBe(true);
    expect(cut.rows[499]).toEqual({ id: 'lane-499' });
    expect(sources.capRows(rows.slice(0, 500), 500)).toEqual({ rows: rows.slice(0, 500), truncated: false });
    expect(sources.capRows(rows.slice(0, 3), 500).truncated).toBe(false);
    expect(sources.capRows([], 500)).toEqual({ rows: [], truncated: false });
  });
});

test.describe('item 3: two overlapping polls cannot restore a green clock out of order', () => {
  const ready = { pr: 7, head: 'abc', ready: true, draft: false };

  test('E3a an older poll that finishes late does not bring back a clock that a newer poll dropped', () => {
    // Breaks when observe() trusts call order, not the poll time: the late older poll would restore "7@abc" with an old start.
    const tracker = createGreenTracker();
    tracker.observe([ready], at('2026-11-25T13:00:00Z'));
    expect(tracker.observe([], at('2026-11-25T13:00:20Z')).size).toBe(0); // the newer poll sees the PR gone
    const late = tracker.observe([ready], at('2026-11-25T13:00:10Z')); // the older poll finishes after it
    expect(late.has('7@abc')).toBe(false);
  });

  test('E3b a later poll after that still starts a fresh clock at its own time', () => {
    // Breaks when the guard blocks every later observe: the stall could never fire again.
    const tracker = createGreenTracker();
    tracker.observe([], at('2026-11-25T13:00:20Z'));
    tracker.observe([ready], at('2026-11-25T13:00:10Z')); // ignored
    expect(tracker.observe([ready], at('2026-11-25T13:00:30Z')).get('7@abc')).toBe(at('2026-11-25T13:00:30Z'));
  });
});

test.describe('item 4: a feed older than its limit raises no pr-green stall', () => {
  const LIMIT = 60 * MIN;
  const iso = (ms: number) => new Date(ms).toISOString();

  test('E4 the feed is fresh only inside its age limit, and only when its status is ok', () => {
    // Breaks when stallPrs checks the status and not the export age: a feed from yesterday could still raise a pr-green stall.
    expect(sources.prFeedFresh({ status: 'ok', exportedAt: iso(NOW - 59 * MIN) }, NOW, LIMIT)).toBe(true);
    expect(sources.prFeedFresh({ status: 'ok', exportedAt: iso(NOW - 61 * MIN) }, NOW, LIMIT)).toBe(false);
    expect(sources.prFeedFresh({ status: 'absent', exportedAt: null }, NOW, LIMIT)).toBe(false);
    expect(sources.prFeedFresh({ status: 'other-repo', exportedAt: iso(NOW) }, NOW, LIMIT)).toBe(false);
    expect(sources.prFeedFresh({ status: 'ok', exportedAt: null }, NOW, LIMIT), 'no data time: the read time stands in').toBe(true);
    expect(sources.prFeedFresh({ status: 'ok', exportedAt: 'not a date' }, NOW, LIMIT), 'a bad time is not fresh').toBe(false);
  });
});

test.describe('item 5: a wall time inside the spring DST gap does not come out an hour early', () => {
  test('E5 daily 02:30 on the change day is 03:30 CDT, never 01:30 CST', () => {
    // Breaks when chicagoToEpoch keeps its second pass in the gap: 2027-03-14 02:30 does not exist and came out as 01:30 CST (07:30Z).
    expect(nextFireMs('daily 02:30', at('2027-03-14T06:00:00Z'))).toBe(at('2027-03-14T08:30:00Z'));
  });

  test('E5b the same for a weekly trigger on that Sunday, and a normal day is unchanged', () => {
    expect(nextFireMs('weekly Sunday 02:30', at('2027-03-13T20:00:00Z'))).toBe(at('2027-03-14T08:30:00Z'));
    expect(nextFireMs('daily 02:30', at('2027-03-15T06:00:00Z'))).toBe(at('2027-03-15T07:30:00Z')); // 01:00 CDT: the next 02:30 CDT is the same day
    expect(nextFireMs('daily 07:50', at('2027-03-13T20:00:00Z'))).toBe(at('2027-03-14T12:50:00Z'));
  });
});
