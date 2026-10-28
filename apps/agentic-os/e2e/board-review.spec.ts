import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  clearStateDir,
  pr,
  SESSION_ID_FORMAT,
  secondsAgo,
  writeState,
  type FixturePr,
} from './state-fixture';

/**
 * Review findings on P1b B2 (PR panel data). Design contract:
 * .claudedocs/2026-10-28-p1b-b2-design.md ("PR panel", "Clarifications").
 *
 * READ-ONLY toward the app: GET only. The only writes are fixture state files in the private
 * E2E state dir, emptied before and after every test. Cross-session cases need two live
 * sessions; with one live session they add a visible "note" annotation (as pr-panel.spec.ts does).
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

const LIVE_UNDER_SECONDS = 900;

type LiveSession = { id: string; liveSecondsAgo: number };
type PrRow = {
  key: string;
  repo: string | null;
  pr: number;
  state: string | null;
  sessions: { id: string; shortId: string; name: string }[];
};
type Snapshot = {
  active: { sessions: LiveSession[] };
  cards: { id: string; repo: string | null }[];
  tiles: { openPrs: number };
  prs: PrRow[];
};

async function loadSnapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

async function liveSessions(request: APIRequestContext): Promise<LiveSession[]> {
  const live = (await loadSnapshot(request)).active.sessions.filter(
    (s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id),
  );
  expect(
    live.length,
    `Precondition: the database needs a live session (liveSecondsAgo < ${LIVE_UNDER_SECONDS}) ` +
      `whose id matches ${SESSION_ID_FORMAT}. Found ${live.length}. Open a Claude Code session and run again.`,
  ).toBeGreaterThanOrEqual(1);
  return live;
}

async function twoLiveSessions(
  request: APIRequestContext,
  what: string,
): Promise<[LiveSession, LiveSession] | null> {
  const live = await liveSessions(request);
  if (live.length >= 2) return [live[0], live[1]];
  test.info().annotations.push({
    type: 'note',
    description: `Only ${live.length} live session: the cross-session part of "${what}" was NOT run.`,
  });
  return null;
}

function watch(id: string, prs: FixturePr[], repo: string | null, at?: number): void {
  writeState(id, { repo, branch: `e2e/review-${id.slice(0, 4)}`, prs, at });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('PrRow.repo is the last path segment, scrubbed', () => {
  test('a home-relative or relative repo shows only its last segment', async ({ request }) => {
    const [live] = await liveSessions(request);
    const middle = ['acme', 'client', 'x'].join('-');
    const cases: [string, string][] = [
      [`~/clients/${middle}/app`, 'app'],
      [`$HOME/clients/${middle}/app`, 'app'],
      [`clients\\${middle}\\app`, 'app'],
      ['Rev4nchist/continuous-claude', 'continuous-claude'],
    ];
    for (const [input, leaf] of cases) {
      watch(live.id, [pr(321, 'PENDING')], input);
      const body = await (await request.get('/api/mission-control')).text();
      const snapshot = JSON.parse(body) as Snapshot;
      expect(snapshot.prs.map((r) => [r.key, r.repo]), `repo ${input}`).toEqual([
        [`${leaf}#321`, leaf],
      ]);
      expect(body, `repo ${input}: the middle segment must not reach the response`).not.toContain(middle);
    }
  });

  test('the same repo written as "owner/name" and "name" is one row', async ({ request }) => {
    const pair = await twoLiveSessions(request, 'repo grouping');
    if (pair === null) return;
    const [a, b] = pair;
    watch(a.id, [pr(200, 'PENDING')], 'Rev4nchist/continuous-claude');
    watch(b.id, [pr(200, 'PENDING')], 'continuous-claude');
    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs.map((r) => r.key)).toEqual(['continuous-claude#200']);
    expect(snapshot.prs[0].sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(snapshot.tiles.openPrs).toBe(1);
  });
});

test.describe('the newest state wins before READY and CLOSED are filtered', () => {
  test('a newer READY or CLOSED hides the PR even when an older session says PENDING', async ({
    request,
  }) => {
    const pair = await twoLiveSessions(request, 'newest state READY');
    if (pair === null) return;
    const [a, b] = pair;
    for (const hidden of ['READY', 'CLOSED'] as const) {
      watch(a.id, [pr(88, hidden)], 'e2e-repo', secondsAgo(1));
      await pause(60);
      watch(b.id, [pr(88, 'PENDING')], 'e2e-repo', secondsAgo(60));
      const snapshot = await loadSnapshot(request);
      expect(snapshot.prs, `newest says ${hidden}, older says PENDING`).toEqual([]);
      expect(snapshot.tiles.openPrs).toBe(0);
      clearStateDir();
    }
  });

  test('a newer PENDING still shows the PR when an older session says READY', async ({ request }) => {
    const pair = await twoLiveSessions(request, 'newest state PENDING');
    if (pair === null) return;
    const [a, b] = pair;
    watch(a.id, [pr(88, 'READY')], 'e2e-repo', secondsAgo(60));
    await pause(60);
    watch(b.id, [pr(88, 'PENDING')], 'e2e-repo', secondsAgo(1));
    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs.map((r) => [r.key, r.state])).toEqual([['e2e-repo#88', 'PENDING']]);
    expect(snapshot.prs[0].sessions.map((s) => s.id)).toContain(b.id);
    expect(snapshot.tiles.openPrs).toBe(1);
  });
});
