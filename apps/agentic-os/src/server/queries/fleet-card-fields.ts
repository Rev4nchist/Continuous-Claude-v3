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
  /** `lane.claimed_at` in epoch seconds: set only when the lane is claimed, so it is the claim time, not the last touch. Null when unknown. */
  claimedAtEpoch: number | null;
};

/** Where the GOAL line came from. `none` means no source had text. */
export type GoalSource = 'brief_set' | 'lane' | 'parsed' | 'none';

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
 * The title of the held lane claimed last (largest `claimedAtEpoch`), blank titles skipped. A lane with no
 * claim time ranks below any dated lane. Equal claims keep the list order (the first one wins). It scans
 * the list and never sorts it: the card draws the lanes in the shared lane order.
 */
function newestLaneTitle(lanes: readonly Pick<HeldLane, 'title' | 'claimedAtEpoch'>[]): string | null {
  let bestTitle: string | null = null;
  let bestClaim = -Infinity;
  for (const lane of lanes) {
    const title = oneLine(lane.title);
    if (title === null) continue;
    const claim = lane.claimedAtEpoch ?? -Infinity;
    if (bestTitle === null || claim > bestClaim) {
      bestTitle = title;
      bestClaim = claim;
    }
  }
  return bestTitle;
}

/**
 * The goal line of a card and where it came from. Order (design 2026-11-08, Option C):
 *   1. a goal the model set with `brief_set`
 *   2. the title of the held lane with the newest claim, tagged `lane`
 *   3. a goal the turn-end parser took from the text (`parsed`)
 *   4. none
 * A parsed goal ranks BELOW a lane: in the 2026-11-08 eval it was stale, process text or narration on
 * 3 of 4 live cards. A goal whose source the file does not record counts as parsed. The first prompt does
 * not exist as a source: the app drops prompt text on purpose (fleet-data.spec.ts R4).
 */
export function goalOf(
  briefGoal: string | null | undefined,
  briefGoalSource: 'brief_set' | 'parsed' | null | undefined,
  lanes: readonly Pick<HeldLane, 'title' | 'claimedAtEpoch'>[],
): { text: string | null; source: GoalSource } {
  const fromBrief = oneLine(briefGoal);
  if (fromBrief !== null && briefGoalSource === 'brief_set') return { text: fromBrief, source: 'brief_set' };
  const fromLane = newestLaneTitle(lanes);
  if (fromLane !== null) return { text: fromLane, source: 'lane' };
  if (fromBrief !== null) return { text: fromBrief, source: 'parsed' };
  return { text: null, source: 'none' };
}

/** The ANSWERED row of a card: the last decision of the brief and how many asks left the open list. */
export type Answered = {
  /** The decision with the largest `at`, or null. `ageSeconds` is whole seconds, never below zero. */
  decision: { text: string; by: string; ageSeconds: number } | null;
  /** Asks with `answered: true`. No age: `answeredAt` does not exist in the file yet (plugin step P2). */
  cleared: number;
};

/** Both ANSWERED parts from data the reader already carries. `nowMs` and `at` are epoch milliseconds. */
export function answeredOf(
  decisions: readonly { text: string; by: string; at: number }[],
  asks: readonly { answered: boolean }[],
  nowMs: number,
): Answered {
  let last: { text: string; by: string; at: number } | null = null;
  for (const d of decisions) {
    if (last === null || d.at > last.at) last = d;
  }
  return {
    decision:
      last === null
        ? null
        : { text: last.text, by: last.by, ageSeconds: Math.max(0, Math.round((nowMs - last.at) / 1000)) },
    cleared: asks.filter((a) => a.answered).length,
  };
}

/** Rows arrive in the shared lane sort order; every owner keeps all its lanes in that order. */
export function groupHeldLanes(
  rows: readonly {
    id: string;
    title: string | null;
    owner_session_id: string;
    lease_expires_epoch: number | null;
    claimed_at_epoch: number | null;
  }[],
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
      claimedAtEpoch:
        row.claimed_at_epoch === null || row.claimed_at_epoch === undefined || !Number.isFinite(Number(row.claimed_at_epoch))
          ? null
          : Number(row.claimed_at_epoch),
    });
    byOwner.set(row.owner_session_id, held);
  }
  return byOwner;
}

/** How long a session may be quiet and still count as live, in minutes. sessions.ts reads it for the Live tile and the strip. */
export const LIVE_WINDOW_MINUTES = 15;

/** The two fields of a stored ask that decide whether it counts. */
export type CountedAsk = { answered: boolean; source: 'brief_set' | 'parsed' };

/** RED stub (mods card fleet-stale-parsed-asks): today's rule, every unanswered ask counts. */
export function countedAsks<T extends CountedAsk>(asks: readonly T[], _chip: string | null, _stateAgeSeconds: number | null): T[] {
  return asks.filter((one) => !one.answered);
}
