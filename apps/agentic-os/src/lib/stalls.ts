import { cleanText } from '../server/queries/lane-coord';

import type { NoteFlags, StartKind } from './note-flags';

/**
 * The five stall kinds (card agentic-os-readers, reader 1; seat ruling 2026-11-25 06:51). PURE: no 'server-only', no
 * '@/' import. Rules are COPIES of .claudedocs/re-execution/stall-watch.mjs (never run it), cited per rule below.
 *
 * Certainty: ci-failed and lease-ran-out are "sure". pr-green, waits-on-seat and start-no-end are "guessed":
 * the two note kinds read free text, and pr-green reads open-prs.json `ready`, which is review-status.mjs:1688
 * (reasons.length === 0): stricter than the stall-watch test at :67, so it is not the same rule.
 * A Stall carries a fixed sentence, never lane text (a lane id passes through cleanText).
 */

export const STALL_MIN = { waitsOnSeat: 10, startNoEnd: 25, prGreen: 5 } as const;
/** stall-watch.mjs:64: the check-run conclusions that count as failed. open-prs.mjs codes them `check-<conclusion>`. */
const FAILED_CI = new Set(['check-failure', 'check-timed_out', 'check-cancelled', 'check-action_required']);
const MIN = 60_000;

export type StallKind = 'ci-failed' | 'lease-ran-out' | 'waits-on-seat' | 'start-no-end' | 'pr-green';
export type StallLane = {
  id: string;
  state: string;
  updatedAtMs: number;
  ownerHeld: boolean;
  leaseExpiresAtMs: number | null;
  flags: NoteFlags;
};
export type StallPr = {
  pr: number;
  head: string;
  draft: boolean;
  ready: boolean | null;
  ci: string[];
  /** When the app first saw this head ready (createGreenTracker); null when it is not ready now. */
  greenSinceMs: number | null;
};
export type Stall = { kind: StallKind; subject: string; ageMin: number | null; certainty: 'sure' | 'guessed'; sentence: string };

const KIND_ORDER: readonly StallKind[] = ['ci-failed', 'lease-ran-out', 'waits-on-seat', 'start-no-end', 'pr-green'];

const subjectOf = (id: string): string => cleanText(id, 80) ?? 'unknown lane';
const minutes = (fromMs: number, nowMs: number): number => Math.floor((nowMs - fromMs) / MIN);

function startSentence(kind: StartKind): string {
  return `A ${kind} START in the lane note has no END. Guessed from the note.`;
}

function laneStalls(lane: StallLane, nowMs: number): Stall[] {
  const out: Stall[] = [];
  const subject = subjectOf(lane.id);
  const open = lane.state === 'active' || lane.state === 'review'; // stall-watch.mjs:79
  if (!open) return out;
  // lease ran out: lane.lease_expires_at is in the past while a session still holds the lane.
  if (lane.ownerHeld && lane.leaseExpiresAtMs !== null && lane.leaseExpiresAtMs < nowMs) {
    out.push({ kind: 'lease-ran-out', subject, ageMin: minutes(lane.leaseExpiresAtMs, nowMs), certainty: 'sure', sentence: 'The lease ended and the lane is still held.' });
  }
  if (lane.id === 're-program' || lane.flags.parked) return out; // stall-watch.mjs:79-81
  const age = minutes(lane.updatedAtMs, nowMs);
  if (!Number.isFinite(age)) return out; // stall-watch.mjs:83
  // waits-on-seat: state active only (stall-watch.mjs:88, a review lane is parked work); :92 threshold.
  if (lane.state === 'active' && lane.flags.waitsOnSeat && age >= STALL_MIN.waitsOnSeat) {
    out.push({ kind: 'waits-on-seat', subject, ageMin: age, certainty: 'guessed', sentence: 'The lane note says it waits on the seat. Guessed from the note.' });
  }
  // start-no-end: stall-watch.mjs:96.
  if (age >= STALL_MIN.startNoEnd) {
    for (const kind of lane.flags.startNoEnd) out.push({ kind: 'start-no-end', subject, ageMin: age, certainty: 'guessed', sentence: startSentence(kind) });
  }
  return out;
}

function prStalls(row: StallPr, nowMs: number): Stall[] {
  const subject = `PR ${row.pr}`;
  // ci-failed: stall-watch.mjs:63-65, at once, and the PR then skips the green test (:65 continue).
  if (row.ci.some((code) => FAILED_CI.has(code))) {
    return [{ kind: 'ci-failed', subject, ageMin: null, certainty: 'sure', sentence: 'A check failed on the head of this pull request.' }];
  }
  // pr-green: stall-watch.mjs:66-70, with `ready` for the test and the app's own first-seen time.
  if (row.ready === true && !row.draft && row.greenSinceMs !== null) {
    const age = minutes(row.greenSinceMs, nowMs);
    if (age >= STALL_MIN.prGreen) {
      return [{ kind: 'pr-green', subject, ageMin: age, certainty: 'guessed', sentence: 'Ready to merge by review-status and not landed, since the app saw it.' }];
    }
  }
  return [];
}

export function computeStalls(input: { lanes: StallLane[]; prs: StallPr[]; nowMs: number }): Stall[] {
  const all = [...input.lanes.flatMap((l) => laneStalls(l, input.nowMs)), ...input.prs.flatMap((p) => prStalls(p, input.nowMs))];
  return all.sort(
    (a, b) =>
      (a.certainty === b.certainty ? 0 : a.certainty === 'sure' ? -1 : 1) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (b.ageMin ?? -1) - (a.ageMin ?? -1) ||
      a.subject.localeCompare(b.subject),
  );
}

/**
 * The first-seen clock of pr-green, in this process. A restart can only delay a stall, never invent one (seat, 2026-11-25).
 * Key `<pr>@<head>`: a push moves the head and restarts the clock. A PR that is not ready, is a draft or left the feed drops.
 */
export function createGreenTracker(): {
  observe: (rows: Pick<StallPr, 'pr' | 'head' | 'ready' | 'draft'>[], nowMs: number) => Map<string, number>;
} {
  const since = new Map<string, number>();
  return {
    observe(rows, nowMs) {
      const live = new Set<string>();
      for (const row of rows) {
        if (row.ready !== true || row.draft || !row.head) continue; // no head: no clock, or two missing heads would share the key "<pr>@"
        const key = `${row.pr}@${row.head}`;
        live.add(key);
        if (!since.has(key)) since.set(key, nowMs);
      }
      for (const key of [...since.keys()]) if (!live.has(key)) since.delete(key);
      return new Map(since);
    },
  };
}
