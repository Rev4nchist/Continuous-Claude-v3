/**
 * Pure helpers for the level 1 session card: lease time left, the lease tone, the goal line
 * and the grouping of held lanes. No database and no `server-only` import, so a unit test can
 * load this file (fleet-sessions.ts cannot be loaded outside Next). Same reason lane-sort.ts
 * is its own file. Test: .claude/hooks/src/__tests__/fleet-level1-fields.test.ts.
 */

/** One lane a session holds. `leaseSecondsLeft` is negative when the lease has lapsed, null with no lease. */
export type HeldLane = {
  id: string;
  title: string | null;
  leaseSecondsLeft: number | null;
};

/** A lease with this many seconds or fewer left reads amber on the card. A lapsed lease is amber too. */
export const LEASE_SHORT_SECONDS = 15 * 60;

/** Seconds from the database clock to the lease end. Both are epoch seconds. Null when the lane has no lease. */
export function leaseSecondsLeft(
  expiresEpoch: number | null | undefined,
  dbNowEpoch: number,
): number | null {
  if (expiresEpoch === null || expiresEpoch === undefined || !Number.isFinite(expiresEpoch)) return null;
  return Math.round(expiresEpoch - dbNowEpoch);
}

export type LeaseTone = 'ok' | 'short' | 'lapsed' | 'none';

/** `lapsed` at 0 seconds or less, `short` at LEASE_SHORT_SECONDS or less, `none` with no lease. */
export function leaseTone(secondsLeft: number | null): LeaseTone {
  if (secondsLeft === null) return 'none';
  if (secondsLeft <= 0) return 'lapsed';
  return secondsLeft <= LEASE_SHORT_SECONDS ? 'short' : 'ok';
}

function oneLine(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * The goal line of a card: the brief goal, else the title of the first held lane. The third source
 * in the design, the first prompt, does not exist: the app drops prompt text on purpose
 * (fleet-data.spec.ts R4). Null when neither source has text.
 */
export function goalOf(
  briefGoal: string | null | undefined,
  lanes: readonly Pick<HeldLane, 'title'>[],
): string | null {
  const fromBrief = oneLine(briefGoal);
  if (fromBrief !== null) return fromBrief;
  for (const lane of lanes) {
    const fromLane = oneLine(lane.title);
    if (fromLane !== null) return fromLane;
  }
  return null;
}

/** Rows arrive in the shared lane sort order; every owner keeps all its lanes in that order. */
export function groupHeldLanes(
  rows: readonly { id: string; title: string | null; owner_session_id: string; lease_expires_epoch: number | null }[],
  dbNowEpoch: number,
): Map<string, HeldLane[]> {
  const byOwner = new Map<string, HeldLane[]>();
  for (const row of rows) {
    const held = byOwner.get(row.owner_session_id) ?? [];
    held.push({
      id: row.id,
      title: row.title,
      leaseSecondsLeft: leaseSecondsLeft(
        row.lease_expires_epoch === null ? null : Number(row.lease_expires_epoch),
        dbNowEpoch,
      ),
    });
    byOwner.set(row.owner_session_id, held);
  }
  return byOwner;
}

/** "lease 1h 20m left", "lease 12m left", "lease <1m left", "lease lapsed 5m ago", "no lease". */
export function formatLease(secondsLeft: number | null): string {
  if (secondsLeft === null) return 'no lease';
  if (secondsLeft <= 0) {
    const late = -secondsLeft;
    if (late < 45) return 'lease lapsed just now';
    if (late < 3_600) return `lease lapsed ${Math.round(late / 60)}m ago`;
    if (late < 86_400) return `lease lapsed ${Math.round(late / 3_600)}h ago`;
    return `lease lapsed ${Math.round(late / 86_400)}d ago`;
  }
  if (secondsLeft < 60) return 'lease <1m left';
  const minutes = Math.floor(secondsLeft / 60);
  if (minutes < 60) return `lease ${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `lease ${hours}h ${minutes % 60}m left`;
}
