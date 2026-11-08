/**
 * Fleet level 1 card fields: lease seconds, lease tone, lease text, goal fallback, lane grouping.
 *
 * The code lives in the Agentic OS app, in two pure files with no `server-only` and no database import, so
 * this runner can load them:
 *   apps/agentic-os/src/server/queries/fleet-card-fields.ts   lease seconds, goal fallback, lane grouping
 *   apps/agentic-os/src/components/fleet/format.ts            lease tone and lease text (the card imports it)
 * The app has no vitest of its own. Same load-by-URL pattern as lane-sort-twin.test.ts.
 *
 * Each test names the change that breaks it:
 *   lease seconds   a swapped subtraction, a missing round, no null guard
 *   tone            a `<` for a `<=` at the boundaries, lapsed read as short
 *   goal            a swapped order, an empty brief goal that wins, a lanes[0] pick instead of the newest claim,
 *                   a parsed goal that beats a lane, a goal with no source that is read as brief_set
 *   grouping        keeping the first lane only (the old behaviour), losing the order
 *   answered        the first decision instead of the newest by `at`, an open ask counted as cleared, a constant
 *                   "nothing recorded", an age below zero
 *   waiting line    a phrase that differs from the chip word, a line that contradicts a waiting-on-dave chip
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// The module sits outside this package's rootDir, so its shape is declared here and checked at run time.
type HeldLane = {
  id: string;
  title: string | null;
  leaseSecondsLeft: number | null;
  claimedAtEpoch: number | null;
};
type GoalSource = 'brief_set' | 'lane' | 'parsed' | 'none';
type Fields = {
  leaseSecondsLeft: (expires: number | null | undefined, dbNow: number) => number | null;
  goalOf: (
    briefGoal: string | null | undefined,
    briefGoalSource: 'brief_set' | 'parsed' | null | undefined,
    lanes: { title: string | null; claimedAtEpoch: number | null }[],
  ) => { text: string | null; source: GoalSource };
  answeredOf: (
    decisions: { text: string; by: string; at: number }[],
    asks: { answered: boolean }[],
    nowMs: number,
  ) => { decision: { text: string; by: string; ageSeconds: number } | null; cleared: number };
  groupHeldLanes: (
    rows: {
      id: string;
      title: string | null;
      owner_session_id: string;
      lease_expires_epoch: number | null;
      claimed_at_epoch: number | null;
    }[],
    dbNow: number,
  ) => Map<string, HeldLane[]>;
};
type LeaseFormat = {
  LEASE_SHORT_SECONDS: number;
  leaseTone: (seconds: number | null) => 'ok' | 'short' | 'lapsed' | 'none';
  formatLease: (seconds: number | null) => string;
  chipWord: (code: string) => string;
  waitingLine: (waiting: boolean, chip: string | null) => string;
};

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const f: Fields = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/fleet-card-fields.ts')
);
const g: LeaseFormat = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/components/fleet/format.ts')
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
    expect(g.leaseTone(g.LEASE_SHORT_SECONDS + 1)).toBe('ok');
    expect(g.leaseTone(g.LEASE_SHORT_SECONDS)).toBe('short');
    expect(g.leaseTone(1)).toBe('short');
  });

  it('reads lapsed at zero and below, and none with no lease', () => {
    expect(g.leaseTone(0)).toBe('lapsed');
    expect(g.leaseTone(-1)).toBe('lapsed');
    expect(g.leaseTone(null)).toBe('none');
  });
});

describe('formatLease', () => {
  it('counts down in hours and minutes, rounding the remainder down', () => {
    expect(g.formatLease(5_400)).toBe('lease 1h 30m left');
    expect(g.formatLease(3_599)).toBe('lease 59m left');
    expect(g.formatLease(90)).toBe('lease 1m left');
    expect(g.formatLease(59)).toBe('lease <1m left');
  });

  it('says how long ago a lapsed lease ended, and the no-lease case', () => {
    expect(g.formatLease(0)).toBe('lease lapsed just now');
    expect(g.formatLease(-300)).toBe('lease lapsed 5m ago');
    expect(g.formatLease(-7_200)).toBe('lease lapsed 2h ago');
    expect(g.formatLease(null)).toBe('no lease');
  });
});

describe('goalOf', () => {
  // The 4 live cards of .claudedocs/gpaa-eval/live-api-2026-11-08.json, GOAL as the old code showed it.
  // The API snapshot has no claimed_at, so the epochs below are invented. Only their order matters.
  // llama holds two lanes: lanes[0] (sorted first by band) is the OLDER claim, so a lanes[0] pick is wrong.
  const llama = {
    goal: 'only 11 of 78 have a brief goal. The Fleet showed the right goal on 0 of 4 live cards when I measured',
    lanes: [
      { title: 'Tidy after #401: match lane row by data-lane-id', claimedAtEpoch: 1_000 },
      { title: 'Review and eval how Goal, Plan, Ask, Answered are determined', claimedAtEpoch: 5_000 },
    ],
  };
  const gateSweep = {
    goal: 'I claim lane `gate-cwd-when-cd-fails`, read its notes, then design and build the fix',
    lanes: [{ title: 'pre-pr-gate: a || or | before a cd skips the cwd', claimedAtEpoch: 2_000 }],
  };
  const compactQui = {
    goal: 'I claim `pre-plan-memory-shell-type`, fix the type error with no behavior change',
    lanes: [{ title: 'precommit-build-guard: treat an import path as unchanged', claimedAtEpoch: 3_000 }],
  };
  const lanePhone = {
    goal: null,
    lanes: [{ title: 'Living dashboard: getting projects to done', claimedAtEpoch: 4_000 }],
  };

  it('picks the lane with the NEWEST claim, not lanes[0] (llama)', () => {
    expect(f.goalOf(llama.goal, 'parsed', llama.lanes)).toEqual({
      text: 'Review and eval how Goal, Plan, Ask, Answered are determined',
      source: 'lane',
    });
    expect(f.goalOf(null, null, llama.lanes).text).toBe('Review and eval how Goal, Plan, Ask, Answered are determined');
  });

  it('does not sort or change the lane list it is given', () => {
    const before = llama.lanes.map((l) => l.title);
    f.goalOf(null, null, llama.lanes);
    expect(llama.lanes.map((l) => l.title)).toEqual(before);
  });

  it('a parsed goal does not beat a lane (gate-sweep, compact qui)', () => {
    expect(f.goalOf(gateSweep.goal, 'parsed', gateSweep.lanes)).toEqual({
      text: 'pre-pr-gate: a || or | before a cd skips the cwd',
      source: 'lane',
    });
    expect(f.goalOf(compactQui.goal, 'parsed', compactQui.lanes).source).toBe('lane');
  });

  it('a goal with no recorded source is read as parsed, so a lane beats it', () => {
    expect(f.goalOf(compactQui.goal, null, compactQui.lanes).source).toBe('lane');
    expect(f.goalOf(compactQui.goal, undefined, compactQui.lanes).source).toBe('lane');
  });

  it('a lane title is the goal when the brief has none (lane phone)', () => {
    expect(f.goalOf(lanePhone.goal, null, lanePhone.lanes)).toEqual({
      text: 'Living dashboard: getting projects to done',
      source: 'lane',
    });
  });

  it('a brief_set goal beats the newest lane', () => {
    expect(f.goalOf('Ship the card', 'brief_set', llama.lanes)).toEqual({ text: 'Ship the card', source: 'brief_set' });
    expect(f.goalOf('Ship the card', 'brief_set', [])).toEqual({ text: 'Ship the card', source: 'brief_set' });
  });

  it('a parsed goal is the goal when no lane has a title', () => {
    expect(f.goalOf(gateSweep.goal, 'parsed', [])).toEqual({ text: gateSweep.goal, source: 'parsed' });
    expect(f.goalOf(gateSweep.goal, 'parsed', [{ title: ' ', claimedAtEpoch: 9 }]).source).toBe('parsed');
  });

  it('a lane with no claim time ranks below a dated lane, and a tie keeps list order', () => {
    const undated = { title: 'Undated lane', claimedAtEpoch: null };
    const old = { title: 'Dated old', claimedAtEpoch: 10 };
    expect(f.goalOf(null, null, [undated, old]).text).toBe('Dated old');
    expect(f.goalOf(null, null, [undated, { ...undated, title: 'Second undated' }]).text).toBe('Undated lane');
    expect(
      f.goalOf(null, null, [
        { title: 'Tie A', claimedAtEpoch: 7 },
        { title: 'Tie B', claimedAtEpoch: 7 },
      ]).text,
    ).toBe('Tie A');
  });

  it('skips a lane with a blank title, even when it has the newest claim', () => {
    const lanes = [
      { title: 'Titled', claimedAtEpoch: 1 },
      { title: '  ', claimedAtEpoch: 99 },
      { title: null, claimedAtEpoch: 98 },
    ];
    expect(f.goalOf(null, null, lanes).text).toBe('Titled');
  });

  it('treats an empty or blank brief goal as missing', () => {
    expect(f.goalOf('', 'brief_set', lanePhone.lanes).source).toBe('lane');
    expect(f.goalOf('   \n ', 'brief_set', lanePhone.lanes).source).toBe('lane');
  });

  it('is none when no source has text', () => {
    expect(f.goalOf(null, null, [])).toEqual({ text: null, source: 'none' });
    expect(f.goalOf('', 'parsed', [{ title: null, claimedAtEpoch: 1 }])).toEqual({ text: null, source: 'none' });
  });

  it('collapses whitespace so the card line is one line', () => {
    expect(f.goalOf('Line one\n  line two', 'brief_set', []).text).toBe('Line one line two');
    expect(f.goalOf(null, null, [{ title: 'Lane\n one', claimedAtEpoch: 1 }]).text).toBe('Lane one');
  });
});

describe('groupHeldLanes', () => {
  const now = 2_000_000;
  const rows = [
    { id: 'lane-a', title: 'A', owner_session_id: 's1', lease_expires_epoch: now + 600, claimed_at_epoch: 100 },
    { id: 'lane-b', title: 'B', owner_session_id: 's2', lease_expires_epoch: null, claimed_at_epoch: null },
    { id: 'lane-c', title: 'C', owner_session_id: 's1', lease_expires_epoch: now - 60, claimed_at_epoch: 300 },
    { id: 'lane-d', title: 'D', owner_session_id: 's1', lease_expires_epoch: now + 7_200, claimed_at_epoch: 200 },
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
      [
        {
          id: 'x',
          title: 'X',
          owner_session_id: 's9',
          lease_expires_epoch: String(now + 30) as unknown as number,
          claimed_at_epoch: '1234.5' as unknown as number,
        },
      ],
      now,
    );
    expect(grouped.get('s9')?.[0].leaseSecondsLeft).toBe(30);
    expect(grouped.get('s9')?.[0].claimedAtEpoch).toBe(1234.5);
  });

  it('carries each lane claim time, null when the lane has none', () => {
    const grouped = f.groupHeldLanes(rows, now);
    expect(grouped.get('s1')?.map((l) => l.claimedAtEpoch)).toEqual([100, 300, 200]);
    expect(grouped.get('s2')?.[0].claimedAtEpoch).toBeNull();
  });
});

describe('answeredOf', () => {
  const now = 10_000_000;

  it('is empty (no decision, 0 cleared) when the brief has neither', () => {
    expect(f.answeredOf([], [], now)).toEqual({ decision: null, cleared: 0 });
  });

  it('takes the decision with the largest `at`, wherever it sits in the list', () => {
    const decisions = [
      { text: 'newest', by: 'Dave', at: now - 60_000 },
      { text: 'oldest', by: 'Dave', at: now - 600_000 },
      { text: 'middle', by: 'agent', at: now - 300_000 },
    ];
    expect(f.answeredOf(decisions, [], now).decision?.text).toBe('newest');
  });

  it('carries the text, who decided it and its age in whole seconds', () => {
    const out = f.answeredOf([{ text: 'Use B', by: 'Dave', at: now - 90_400 }], [], now);
    expect(out.decision).toEqual({ text: 'Use B', by: 'Dave', ageSeconds: 90 });
  });

  it('never gives a negative age for a decision stamped in the future', () => {
    expect(f.answeredOf([{ text: 'x', by: 'Dave', at: now + 5_000 }], [], now).decision?.ageSeconds).toBe(0);
  });

  it('counts only asks with answered: true as cleared', () => {
    const asks = [{ answered: true }, { answered: false }, { answered: true }];
    expect(f.answeredOf([], asks, now)).toEqual({ decision: null, cleared: 2 });
  });

  it('gives both parts when the brief has a decision and cleared asks', () => {
    const out = f.answeredOf([{ text: 'Go', by: 'Dave', at: now - 1_000 }], [{ answered: true }], now);
    expect(out.decision?.text).toBe('Go');
    expect(out.cleared).toBe(1);
  });
});

describe('waitingLine', () => {
  it('uses the chip words when the card waits, so one card shows one phrase', () => {
    expect(g.waitingLine(true, 'waiting-on-dave')).toBe(g.chipWord('waiting-on-dave'));
    expect(g.waitingLine(true, 'working')).toBe(g.chipWord('waiting-on-dave'));
    expect(g.waitingLine(true, null)).toBe('Waiting for you');
  });

  it('says "Not waiting for you" when nothing waits and the chip does not say so', () => {
    expect(g.waitingLine(false, null)).toBe('Not waiting for you');
    expect(g.waitingLine(false, 'working')).toBe('Not waiting for you');
    expect(g.waitingLine(false, 'blocked')).toBe('Not waiting for you');
  });

  it('does not contradict a waiting-on-dave chip when no ask is open', () => {
    const line = g.waitingLine(false, 'waiting-on-dave');
    expect(line).toBe('No open ask');
    expect(line).not.toMatch(/^Not waiting/);
  });
});
