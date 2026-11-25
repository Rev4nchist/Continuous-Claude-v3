import { expect, test } from '@playwright/test';

import { noteFlags } from '../src/lib/note-flags';
import { computeStalls, createGreenTracker, STALL_MIN, type StallLane, type StallPr } from '../src/lib/stalls';

/**
 * Pure checks of the five stall kinds (card agentic-os-readers, reader 1; seat ruling 2026-11-25 06:51).
 * Rules are copies of .claudedocs/re-execution/stall-watch.mjs (never run it): ci-failed :63-65, pr-green :66-70,
 * waits-on-seat :79-92 (state active only, :88), start-no-end :94-96, plus lease-ran-out (lane.lease_expires_at).
 * Certainty: ci-failed and lease-ran-out are "sure"; pr-green, waits-on-seat and start-no-end are "guessed"
 * (pr-green because open-prs.json `ready` is review-status.mjs:1688 reasons.length === 0, stricter than the
 * stall-watch test at :67). Pure Node. Each test names the source change that breaks it.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const NOTE_CANARY = 'NOTE_CANARY_7f3a';

function lane(patch: Partial<StallLane> = {}): StallLane {
  return {
    id: 'lane-a',
    state: 'active',
    updatedAtMs: NOW - 30 * MIN,
    ownerHeld: true,
    leaseExpiresAtMs: NOW + 30 * MIN,
    flags: noteFlags(null),
    ...patch,
  };
}

function pr(patch: Partial<StallPr> = {}): StallPr {
  return { pr: 259, head: 'a'.repeat(40), draft: false, ready: false, ci: [], greenSinceMs: null, ...patch };
}

const kinds = (stalls: { kind: string }[]): string[] => stalls.map((s) => s.kind);

test.describe('waits-on-seat (stall-watch.mjs:79-92)', () => {
  const waiting = (ageMin: number, patch: Partial<StallLane> = {}): StallLane =>
    lane({ updatedAtMs: NOW - ageMin * MIN, flags: noteFlags('WAITS ON: seat GO'), ...patch });

  test('S1 fires at 10 minutes and not at 9, for state active only', () => {
    // Breaks when STALL_MIN.waitsOnSeat moves, the compare changes from >= to >, or a review lane starts to count (:88).
    expect(STALL_MIN.waitsOnSeat).toBe(10);
    expect(computeStalls({ lanes: [waiting(9)], prs: [], nowMs: NOW })).toEqual([]);
    const at10 = computeStalls({ lanes: [waiting(10)], prs: [], nowMs: NOW });
    expect(kinds(at10)).toEqual(['waits-on-seat']);
    expect(at10[0].ageMin).toBe(10);
    expect(computeStalls({ lanes: [waiting(40, { state: 'review' })], prs: [], nowMs: NOW })).toEqual([]);
    expect(computeStalls({ lanes: [waiting(40, { state: 'blocked' })], prs: [], nowMs: NOW })).toEqual([]);
  });

  test('S2 skips re-program and a parked note', () => {
    // Breaks when the re-program or PARKED skip of :79-81 is dropped.
    expect(computeStalls({ lanes: [waiting(40, { id: 're-program' })], prs: [], nowMs: NOW })).toEqual([]);
    expect(computeStalls({ lanes: [waiting(40, { flags: { ...noteFlags('WAITS ON: seat GO'), parked: true } })], prs: [], nowMs: NOW })).toEqual([]);
  });

  test('S3 an unparseable update time gives no stall and no throw', () => {
    // stall-watch.mjs:83 skips a lane whose age is not finite.
    expect(computeStalls({ lanes: [waiting(40, { updatedAtMs: Number.NaN })], prs: [], nowMs: NOW })).toEqual([]);
  });
});

test.describe('start-no-end (stall-watch.mjs:94-96)', () => {
  const started = (ageMin: number, note: string): StallLane => lane({ updatedAtMs: NOW - ageMin * MIN, flags: noteFlags(note) });

  test('S4 fires at 25 minutes and not at 24, once per kind', () => {
    // Breaks when STALL_MIN.startNoEnd moves or two kinds in one note collapse into one stall.
    expect(STALL_MIN.startNoEnd).toBe(25);
    expect(computeStalls({ lanes: [started(24, 'PRE-PR START 06:47.')], prs: [], nowMs: NOW })).toEqual([]);
    const pre = computeStalls({ lanes: [started(25, 'PRE-PR START 06:47.')], prs: [], nowMs: NOW });
    expect(kinds(pre)).toEqual(['start-no-end']);
    expect(pre[0].sentence).toContain('PRE-PR');
    const both = computeStalls({ lanes: [started(25, 'PRE-PR START 06:47. HOOK BUILD START 06:50.')], prs: [], nowMs: NOW });
    expect(kinds(both)).toEqual(['start-no-end', 'start-no-end']);
  });

  test('S5 a lane in review or blocked state gives no start-no-end stall, as in :79-81 (active and review count here)', () => {
    // :79-81 keeps active AND review for this kind, unlike waits-on-seat. Breaks when the state filter is copied from the wrong rule.
    expect(kinds(computeStalls({ lanes: [{ ...started(30, 'PRE-PR START 06:47.'), state: 'review' }], prs: [], nowMs: NOW }))).toEqual(['start-no-end']);
    expect(computeStalls({ lanes: [{ ...started(30, 'PRE-PR START 06:47.'), state: 'blocked' }], prs: [], nowMs: NOW })).toEqual([]);
  });
});

test.describe('ci-failed (stall-watch.mjs:63-65)', () => {
  test('S6 fires at once on each failing check conclusion and on no other code', () => {
    // Breaks when a code leaves the list failure, timed_out, cancelled, action_required or a pending code joins it.
    for (const code of ['check-failure', 'check-timed_out', 'check-cancelled', 'check-action_required']) {
      const out = computeStalls({ lanes: [], prs: [pr({ ci: [code, 'required-missing'] })], nowMs: NOW });
      expect(kinds(out), code).toEqual(['ci-failed']);
    }
    for (const code of ['check-success', 'check-in_progress', 'mergeable-unknown', 'required-missing', 'status-failure', 'other']) {
      expect(computeStalls({ lanes: [], prs: [pr({ ci: [code] })], nowMs: NOW }), code).toEqual([]);
    }
  });

  test('S6b a draft PR with a failed check still fires (stall-watch has no draft test for ci-failed)', () => {
    expect(kinds(computeStalls({ lanes: [], prs: [pr({ draft: true, ci: ['check-failure'] })], nowMs: NOW }))).toEqual(['ci-failed']);
  });
});

test.describe('pr-green (stall-watch.mjs:66-70, guessed)', () => {
  test('S7 needs ready and not draft; fires at 5 minutes since the app saw it; a new head restarts the clock', () => {
    // Breaks when the 5 minute rule moves, a draft counts, or the tracker keeps the clock across a head change.
    expect(STALL_MIN.prGreen).toBe(5);
    const tracker = createGreenTracker();
    const feed = (head: string, patch: Partial<StallPr> = {}) => [pr({ head, ready: true, ...patch })];
    const seen = (rows: StallPr[], at: number): StallPr[] => {
      const since = tracker.observe(rows, at);
      return rows.map((r) => ({ ...r, greenSinceMs: since.get(`${r.pr}@${r.head}`) ?? null }));
    };
    const t0 = NOW;
    expect(computeStalls({ lanes: [], prs: seen(feed('a'.repeat(40)), t0), nowMs: t0 })).toEqual([]);
    expect(computeStalls({ lanes: [], prs: seen(feed('a'.repeat(40)), t0 + 4 * MIN), nowMs: t0 + 4 * MIN })).toEqual([]);
    const fired = computeStalls({ lanes: [], prs: seen(feed('a'.repeat(40)), t0 + 5 * MIN), nowMs: t0 + 5 * MIN });
    expect(kinds(fired)).toEqual(['pr-green']);
    expect(fired[0].ageMin).toBe(5);
    // A push moves the head: the clock restarts.
    const moved = computeStalls({ lanes: [], prs: seen(feed('b'.repeat(40)), t0 + 6 * MIN), nowMs: t0 + 6 * MIN });
    expect(moved).toEqual([]);
    // A draft never fires, however long it was ready.
    const t1 = t0 + 20 * MIN;
    seen(feed('c'.repeat(40), { draft: true }), t1);
    expect(computeStalls({ lanes: [], prs: seen(feed('c'.repeat(40), { draft: true }), t1 + 9 * MIN), nowMs: t1 + 9 * MIN })).toEqual([]);
  });

  test('S7b ready false (or null) drops the clock; a PR that leaves the feed drops its entry', () => {
    const tracker = createGreenTracker();
    const row = pr({ ready: true });
    tracker.observe([row], NOW);
    expect(tracker.observe([{ ...row, ready: false }], NOW + MIN).has(`${row.pr}@${row.head}`)).toBe(false);
    tracker.observe([row], NOW + 2 * MIN);
    expect(tracker.observe([], NOW + 3 * MIN).size).toBe(0);
    expect(tracker.observe([row], NOW + 4 * MIN).get(`${row.pr}@${row.head}`)).toBe(NOW + 4 * MIN);
  });

  test('S7c the sentence says it is ready by review-status and since the app saw it', () => {
    const out = computeStalls({ lanes: [], prs: [pr({ ready: true, greenSinceMs: NOW - 9 * MIN })], nowMs: NOW });
    expect(out[0].sentence).toMatch(/review-status/);
    expect(out[0].sentence).toMatch(/since the app saw it/i);
  });
});

test.describe('lease-ran-out', () => {
  test('S8 fires for an owned active or review lane with a past lease only', () => {
    // Breaks when an unowned lane, a done lane or a future lease counts.
    const out = computeStalls({ lanes: [lane({ leaseExpiresAtMs: NOW - 12 * MIN })], prs: [], nowMs: NOW });
    expect(kinds(out)).toEqual(['lease-ran-out']);
    expect(out[0].ageMin).toBe(12);
    expect(kinds(computeStalls({ lanes: [lane({ state: 'review', leaseExpiresAtMs: NOW - MIN })], prs: [], nowMs: NOW }))).toEqual(['lease-ran-out']);
    expect(computeStalls({ lanes: [lane({ ownerHeld: false, leaseExpiresAtMs: NOW - 12 * MIN })], prs: [], nowMs: NOW })).toEqual([]);
    expect(computeStalls({ lanes: [lane({ state: 'done', leaseExpiresAtMs: NOW - 12 * MIN })], prs: [], nowMs: NOW })).toEqual([]);
    expect(computeStalls({ lanes: [lane({ leaseExpiresAtMs: NOW + MIN })], prs: [], nowMs: NOW })).toEqual([]);
    expect(computeStalls({ lanes: [lane({ leaseExpiresAtMs: null })], prs: [], nowMs: NOW })).toEqual([]);
  });
});

test.describe('certainty, sentence and leaks', () => {
  test('S9 certainty is fixed per kind; the sentence is a fixed template with no note text', () => {
    const all = computeStalls({
      lanes: [
        lane({ id: 'lane-w', updatedAtMs: NOW - 40 * MIN, flags: noteFlags('WAITS ON: seat GO') }),
        lane({ id: 'lane-s', updatedAtMs: NOW - 40 * MIN, flags: noteFlags('PRE-PR START 06:47') }),
        lane({ id: 'lane-l', leaseExpiresAtMs: NOW - 5 * MIN }),
      ],
      prs: [pr({ pr: 1, ci: ['check-failure'] }), pr({ pr: 2, ready: true, greenSinceMs: NOW - 9 * MIN })],
      nowMs: NOW,
    });
    const certainty = Object.fromEntries(all.map((s) => [s.kind, s.certainty]));
    expect(certainty).toEqual({
      'ci-failed': 'sure',
      'lease-ran-out': 'sure',
      'waits-on-seat': 'guessed',
      'start-no-end': 'guessed',
      'pr-green': 'guessed',
    });
    for (const s of all) expect(s.sentence, s.kind).toMatch(/^[A-Z][^\n]{10,200}\.$/);
  });

  test('S10 a note canary, a url, a uuid and a path in a lane id never leave the function', () => {
    // Breaks when computeStalls serializes the lane, skips cleanText on the subject, or reads a note field.
    const hostile = lane({
      id: 'lane https://example.invalid/x?t=1 0f5ea433-47f0-466d-aaab-5a7406258ff3 C:\\Users\\someone\\secret.txt',
      leaseExpiresAtMs: NOW - 5 * MIN,
      ...({ note: NOTE_CANARY } as object),
    });
    const text = JSON.stringify(computeStalls({ lanes: [hostile], prs: [], nowMs: NOW }));
    expect(text).not.toContain(NOTE_CANARY);
    expect(text).not.toContain('https://');
    expect(text).not.toContain('0f5ea433-47f0-466d-aaab-5a7406258ff3');
    expect(text).not.toContain('C:\\\\Users');
    expect(text).not.toContain('someone');
  });

  test('S11 no input gives an empty list, not an error', () => {
    expect(computeStalls({ lanes: [], prs: [], nowMs: NOW })).toEqual([]);
  });
});
