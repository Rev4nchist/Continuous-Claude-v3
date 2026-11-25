import { cleanText } from '../server/queries/lane-coord';

import { nextFireMs } from './tasks-parse';

/**
 * The clock fold (card agentic-os-readers, reader 4). PURE: no 'server-only', no '@/' import.
 *
 * "Next on the clock": park ends, lease ends, future reminders and feed refreshes. The rules copy the lane CLI predicates
 * that src/server/queries/lane-coord.ts already holds (LEASE_MINUTES 90; a parked lane has a lease more than
 * LEASE_MINUTES + 1 minutes ahead, lane.mjs :411-418; a reminder is future when due_at is ahead and remind_state is
 * 'scheduled'). An expired lease is not a clock entry: it is a stall. An entry holds a kind, a cleaned label and times.
 */

const MIN = 60_000;
const PARK_AHEAD_MS = 91 * MIN;
export const CLOCK_KIND_LIMIT = 20;
export type ClockKind = 'park-end' | 'lease-end' | 'reminder' | 'feed-refresh';
/** The order of entries that fall on the same instant. */
const KIND_ORDER: readonly ClockKind[] = ['park-end', 'lease-end', 'reminder', 'feed-refresh'];

export type RawClock = { kind: ClockKind; label: string; atMs: number };
export type ClockEntry = { kind: ClockKind; label: string; atMs: number; inMin: number };
export type ClockLaneRow = { id: string; ownerHeld: boolean; leaseExpiresAtMs: number | null; dueAtMs: number | null; remindState: string | null };
export type ClockFeed = { label: string; exportedAtMs: number | null; trigger: string | null };

export function laneClockEntries(row: ClockLaneRow, nowMs: number): RawClock[] {
  const out: RawClock[] = [];
  if (row.ownerHeld && row.leaseExpiresAtMs !== null && row.leaseExpiresAtMs > nowMs) {
    out.push({ kind: row.leaseExpiresAtMs - nowMs > PARK_AHEAD_MS ? 'park-end' : 'lease-end', label: row.id, atMs: row.leaseExpiresAtMs });
  }
  if (row.dueAtMs !== null && row.dueAtMs > nowMs && row.remindState === 'scheduled') {
    out.push({ kind: 'reminder', label: row.id, atMs: row.dueAtMs });
  }
  return out;
}

/** A feed refreshes at its export time plus N minutes ("every Nm"), or at the next fire of a daily or weekly trigger. */
export function feedRefreshEntries(feeds: ClockFeed[], nowMs: number): RawClock[] {
  const out: RawClock[] = [];
  for (const feed of feeds) {
    if (feed.trigger === null) continue;
    const every = /^every (\d+)m$/.exec(feed.trigger);
    let atMs: number | null = null;
    if (every) {
      const n = Number(every[1]);
      if (feed.exportedAtMs !== null && n > 0) atMs = feed.exportedAtMs + n * MIN;
    } else {
      atMs = nextFireMs(feed.trigger, nowMs);
    }
    if (atMs !== null && atMs > nowMs) out.push({ kind: 'feed-refresh', label: feed.label, atMs });
  }
  return out;
}

/** All clock entries of one read: the lane rows and the feeds, folded. */
export function clockOf(input: { rows: ClockLaneRow[]; feeds: ClockFeed[]; nowMs: number }): ClockEntry[] {
  return foldClock([...input.rows.flatMap((row) => laneClockEntries(row, input.nowMs)), ...feedRefreshEntries(input.feeds, input.nowMs)], input.nowMs);
}

export function foldClock(entries: RawClock[], nowMs: number): ClockEntry[] {
  const future = entries.filter((e) => e.atMs > nowMs).sort((a, b) => a.atMs - b.atMs);
  const taken = new Map<ClockKind, number>();
  const kept = future.filter((e) => {
    const n = (taken.get(e.kind) ?? 0) + 1;
    taken.set(e.kind, n);
    return n <= CLOCK_KIND_LIMIT;
  });
  return kept
    .sort((a, b) => a.atMs - b.atMs || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((e) => ({ kind: e.kind, label: cleanText(e.label, 80) ?? 'unknown', atMs: e.atMs, inMin: Math.max(0, Math.ceil((e.atMs - nowMs) / MIN)) }));
}
