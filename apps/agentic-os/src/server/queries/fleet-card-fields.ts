/**
 * Pure helpers for the level 1 session card: lease seconds, the goal line and the grouping of held
 * lanes. No database and no `server-only` import, so a unit test can load this file (fleet-sessions.ts
 * cannot be loaded outside Next). Same reason lane-sort.ts is its own file. The lease text and tone
 * (formatLease, leaseTone) live in components/fleet/format.ts, which the card imports.
 * Test: .claude/hooks/src/__tests__/fleet-level1-fields.test.ts.
 */

/** One lane a session holds. `leaseSecondsLeft` is negative when the lease has lapsed, null with no lease. */
export type HeldLane = {
  id: string;
  title: string | null;
  leaseSecondsLeft: number | null;
};

/** Seconds from the database clock to the lease end. Both are epoch seconds. Null when the lane has no lease. */
export function leaseSecondsLeft(
  expiresEpoch: number | null | undefined,
  dbNowEpoch: number,
): number | null {
  if (expiresEpoch === null || expiresEpoch === undefined || !Number.isFinite(expiresEpoch)) return null;
  return Math.round(expiresEpoch - dbNowEpoch);
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
