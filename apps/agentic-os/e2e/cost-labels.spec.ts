import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  agentRun,
  clearStateDir,
  SESSION_ID_FORMAT,
  writeState,
  type FixtureAgentRun,
} from './state-fixture';

/**
 * End-to-end check for PR E1: the "agents" cost line of the session detail says "unpriced" and
 * "at least", read from the state file keys `hasUnknownModelCost` and `advised` of each agentRuns row.
 * Plan: .claudedocs/2026-11-09-pr-e-fleet-cost-plan.md sections 2, 3 and 6 (E1).
 *
 * state-files.ts imports `server-only`, so only this spec reaches the parser. The pure wording rule
 * has its own cases in .claude/hooks/src/__tests__/fleet-cost-label.test.ts.
 *
 * READ-ONLY toward the app. The only writes are fixture state files in the private E2E state dir.
 * The app role cannot insert sessions, so each test borrows a REAL live session id and writes a
 * fixture file for it (same approach as session-detail.spec.ts). Runs in chromium and phone width.
 */

const LIVE_UNDER_SECONDS = 900;

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

type RunsDto = { count: number; running: number; costUsd: number; unpriced: number; advisedRuns: number };

async function liveSessionId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  const snapshot = (await response.json()) as { active: { sessions: { id: string; liveSecondsAgo: number }[] } };
  const live = snapshot.active.sessions.filter(
    (s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id),
  );
  expect(
    live.length,
    'Precondition: the database needs a live session (active in the last 15 minutes) with a UUID-shaped id. ' +
      'Open a Claude Code session and run again.',
  ).toBeGreaterThanOrEqual(1);
  return live[0].id;
}

async function agentRunsOf(request: APIRequestContext, id: string): Promise<RunsDto> {
  const response = await request.get(`/api/mission-control?session=${encodeURIComponent(id)}`);
  expect(response.status()).toBe(200);
  const snapshot = (await response.json()) as { detail: { agentRuns: RunsDto | null } | null };
  expect(snapshot.detail, 'the detail must be present').not.toBeNull();
  expect(snapshot.detail?.agentRuns, 'agentRuns must be present').not.toBeNull();
  return snapshot.detail?.agentRuns as RunsDto;
}

/** Write the fixture, open the detail by URL, return the Health "agents" line. */
async function openAgentCost(page: Page, id: string, runs: FixtureAgentRun[]) {
  writeState(id, { agentRuns: runs });
  await page.goto(`/?session=${id}`);
  const line = page.getByTestId('detail-health').getByTestId('health-agent-cost');
  await expect(line).toBeVisible();
  return line;
}

test.describe('agents cost line labels', () => {
  test('one unpriced run at $0: "agents unpriced", never $0.00', async ({ page, request }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [
      agentRun('r1', { costUsd: 0, hasUnknownModelCost: true, model: 'claude-future-9' }),
    ]);
    await expect(line).toHaveText('agents unpriced (1 run, 0 running)');
    await expect(line).not.toContainText('$0.00');
    await expect(line).toHaveAttribute('data-unpriced', '1');
    await expect(line).toHaveAttribute('data-floor', 'false');
    expect(await agentRunsOf(request, id)).toMatchObject({ count: 1, unpriced: 1, advisedRuns: 0 });
  });

  test('one unpriced and one priced run: "$1.50 + 1 unpriced"', async ({ page, request }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [
      agentRun('r1', { costUsd: 0, hasUnknownModelCost: true }),
      agentRun('r2', { costUsd: 1.5 }),
    ]);
    await expect(line).toHaveText('agents $1.50 + 1 unpriced (2 runs, 0 running)');
    await expect(line).toHaveAttribute('data-unpriced', '1');
    await expect(line).toHaveAttribute('data-floor', 'false');
  });

  test('an advised run: "agents at least $", data-floor true', async ({ page, request }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [agentRun('r1', { costUsd: 1.5, advised: 2 })]);
    await expect(line).toHaveText('agents at least $1.50 (1 run, 0 running)');
    await expect(line).toHaveAttribute('data-floor', 'true');
    await expect(line).toHaveAttribute('data-unpriced', '0');
    expect(await agentRunsOf(request, id)).toMatchObject({ unpriced: 0, advisedRuns: 1 });
  });

  test('an advised run and an unpriced run: floor and suffix together, floor at $0 stays visible', async ({
    page,
    request,
  }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [
      agentRun('r1', { costUsd: 0, advised: 1 }),
      agentRun('r2', { costUsd: 0, hasUnknownModelCost: true }),
    ]);
    await expect(line).toHaveText('agents at least $0.00 + 1 unpriced (2 runs, 0 running)');
    await expect(line).toHaveAttribute('data-floor', 'true');
    await expect(line).toHaveAttribute('data-unpriced', '1');
  });

  for (const [name, advised] of [
    ['a string "2"', '2'],
    ['-1', -1],
    ['0', 0],
  ] as const) {
    test(`advised as ${name} is no floor`, async ({ page, request }) => {
      const id = await liveSessionId(request);
      const line = await openAgentCost(page, id, [agentRun('r1', { costUsd: 1.5, advised })]);
      await expect(line).toHaveText('agents $1.50 (1 run, 0 running)');
      await expect(line).not.toContainText('at least');
      await expect(line).toHaveAttribute('data-floor', 'false');
      expect(await agentRunsOf(request, id)).toMatchObject({ advisedRuns: 0 });
    });
  }

  test('hasUnknownModelCost as the string "true" is not unpriced', async ({ page, request }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [
      agentRun('r1', { costUsd: 1.5, hasUnknownModelCost: 'true' }),
    ]);
    await expect(line).toHaveText('agents $1.50 (1 run, 0 running)');
    await expect(line).toHaveAttribute('data-unpriced', '0');
    expect(await agentRunsOf(request, id)).toMatchObject({ unpriced: 0 });
  });

  test('priced runs with neither key keep the old text', async ({ page, request }) => {
    const id = await liveSessionId(request);
    const line = await openAgentCost(page, id, [
      agentRun('r1', { costUsd: 1.25 }),
      agentRun('r2', { costUsd: 0.5, status: 'running', endedAt: null }),
    ]);
    await expect(line).toHaveText('agents $1.75 (2 runs, 1 running)');
    await expect(line).toHaveAttribute('data-unpriced', '0');
    await expect(line).toHaveAttribute('data-floor', 'false');
  });
});
