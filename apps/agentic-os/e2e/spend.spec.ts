import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { agentRun, cacheState, clearStateDir, SESSION_ID_FORMAT, writeState } from './state-fixture';

/**
 * End-to-end check for PR E2 of the Fleet cost dashboard: the Overview stat tiles.
 * Desktop order: Live, Needs Dave, Quota and spend (T3), Rule breaks (T4), Active lanes, Open PRs.
 * Phone shows the first four. The DOM holds six nodes in both projects; only the visible count differs.
 * Plan: .claudedocs/2026-11-09-pr-e-fleet-cost-plan.md sections 2 and 6 (E2).
 *
 * state-files.ts imports `server-only`, so only this spec reaches the parser (effort, drift, spec,
 * cache.lastUsedAt, cache.resumed). The money math and pick rules have their own cases in
 * .claude/hooks/src/__tests__/spend-fold.test.ts.
 *
 * READ-ONLY toward the app. The only writes are fixture state files in the private E2E state dir.
 * The app role cannot insert sessions, so each test borrows a REAL live session id and writes a
 * fixture file for it (same approach as cost-labels.spec.ts). Runs in chromium and phone width.
 */

const LIVE_UNDER_SECONDS = 900;
const PHONE_VISIBLE = 4;
const DESKTOP_VISIBLE = 6;

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

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

type Tiles = { tiles: { quota: { sevenDayPct: number | null }; breaks: { distinct: number; runs: number } } };

async function tilesOf(request: APIRequestContext): Promise<Tiles['tiles']> {
  const response = await request.get('/api/mission-control');
  expect(response.status()).toBe(200);
  return ((await response.json()) as Tiles).tiles;
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('stat-tiles')).toBeVisible();
}

/** The Nth tile in the DOM order (0 Live, 1 Needs Dave, 2 Quota and spend, 3 Rule breaks, 4 Active lanes, 5 Open PRs). */
const tileAt = (page: Page, index: number): Locator => page.getByTestId('stat-tile').nth(index);
const T3 = 2;
const T4 = 3;

test.describe('overview stat tiles', () => {
  test('six tiles in the DOM in both projects; four are visible on a phone, six on a desktop', async ({
    page,
  }, testInfo) => {
    await openOverview(page);
    const tiles = page.getByTestId('stat-tile');
    await expect(tiles).toHaveCount(6);
    const labels = await tiles.evaluateAll((els) =>
      els.map((el) => el.firstElementChild?.textContent?.trim() ?? ''),
    );
    expect(labels).toEqual(['Live', 'Needs Dave', 'Quota and spend', 'Rule breaks', 'Active lanes', 'Open PRs']);
    const visible = testInfo.project.name === 'phone' ? PHONE_VISIBLE : DESKTOP_VISIBLE;
    // A visible-only filter, not a DOM count: the DOM holds six nodes in both projects.
    await expect(page.locator('[data-testid="stat-tile"]:visible')).toHaveCount(visible);
    // Every tile has a value node, so a test can read the big number alone.
    await expect(page.getByTestId('stat-tile-value')).toHaveCount(6);
  });

  test('T3 reads "no data" and "quota not reported" for a session with no hud', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, {});
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('quota not reported');
    await expect(tileAt(page, T3)).toContainText('no data');
    await expect(tileAt(page, T3)).not.toContainText('$0.00');
    await expect(tileAt(page, T3)).not.toHaveAttribute('data-tone', 'warn');
  });

  test('T3 shows a real $0 engine cost as est $0.00, not "no data"', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 0, limits: [] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('est $0.00 all sessions');
    await expect(tileAt(page, T3)).not.toContainText('no data');
  });

  test('T3 shows "1 since resume" and "at least" for a resumed session', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 5, limits: [] }, cache: cacheState({ resumed: true }) });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('1 since resume');
    await expect(tileAt(page, T3)).toContainText('at least est $5.00 all sessions');
  });

  test('T3 does not say "since resume" for a session that was not resumed', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 5, limits: [] }, cache: cacheState({ resumed: false }) });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('est $5.00 all sessions');
    await expect(tileAt(page, T3)).not.toContainText('since resume');
    await expect(tileAt(page, T3)).not.toContainText('at least');
  });

  test('T3 quota: 79 is plain, 80 is warn', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 1, limits: [{ kind: 'seven_day', percentUsed: 79 }] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3).getByTestId('stat-tile-value')).toHaveText('79%');
    await expect(tileAt(page, T3)).not.toHaveAttribute('data-tone', 'warn');

    writeState(id, { hud: { costUsd: 1, limits: [{ kind: 'seven_day', percentUsed: 80 }] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3).getByTestId('stat-tile-value')).toHaveText('80%');
    await expect(tileAt(page, T3)).toHaveAttribute('data-tone', 'warn');
  });

  test('T3 shows a fractional quota rounded, and the API keeps the raw value', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 1, limits: [{ kind: 'seven_day', percentUsed: 42.857 }] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3).getByTestId('stat-tile-value')).toHaveText('43%');
    expect((await tilesOf(request)).quota.sevenDayPct).toBe(42.857);
  });

  test('T3 is warn at a session engine cost of $150 and plain at $149.99', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 149.99, limits: [] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3)).not.toHaveAttribute('data-tone', 'warn');
    writeState(id, { hud: { costUsd: 150, limits: [] }, cache: cacheState() });
    await openOverview(page);
    await expect(tileAt(page, T3)).toHaveAttribute('data-tone', 'warn');
  });

  test('T3 line 3: subagent runs read est, at least (advised) and unpriced', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, {
      hud: { costUsd: 9, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('r1', { costUsd: 1.5 })],
    });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('of which subagents est $1.50');

    writeState(id, {
      hud: { costUsd: 9, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('r1', { costUsd: 1.5, advised: 2 }), agentRun('r2', { hasUnknownModelCost: true })],
    });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('of which subagents at least est $1.50 + 1 unpriced');
  });

  test('T4 is bad and counts one run for a sonnet medium run', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { agentRuns: [agentRun('r1', { effort: 'medium' }), agentRun('r2', { effort: 'high' })] });
    await openOverview(page);
    await expect(tileAt(page, T4).getByTestId('stat-tile-value')).toHaveText('1');
    await expect(tileAt(page, T4)).toHaveAttribute('data-tone', 'bad');
    await expect(tileAt(page, T4)).toContainText('sonnet<high 1');
    expect((await tilesOf(request)).breaks).toMatchObject({ distinct: 1, runs: 2 });
  });

  test('T4 counts a haiku run once and not as drift; drift is checked on runs with a spec only', async ({
    page,
    request,
  }) => {
    const id = await liveSessionId(request);
    writeState(id, {
      agentRuns: [
        agentRun('r1', { model: 'claude-haiku-4-5', drift: 'Haiku is banned', spec: { model: 'sonnet' } }),
        agentRun('r2', { spec: { effort: 'high' } }),
        agentRun('r3', { spec: {} }),
      ],
    });
    await openOverview(page);
    const t4 = tileAt(page, T4);
    await expect(t4.getByTestId('stat-tile-value')).toHaveText('1');
    await expect(t4).toContainText('haiku in subagents 1, sonnet<high 0, drift 0');
    await expect(t4).toContainText('drift checked on 2 of 3 runs');
  });

  test('T4 is plain and reads "no runs" with no runs', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, {});
    await openOverview(page);
    await expect(tileAt(page, T4).getByTestId('stat-tile-value')).toHaveText('0');
    await expect(tileAt(page, T4)).toContainText('no runs');
    await expect(tileAt(page, T4)).not.toHaveAttribute('data-tone', 'bad');
  });

  test('T4 ignores a state file of a session that is not live', async ({ page, request }) => {
    const live = await liveSessionId(request);
    writeState(live, { agentRuns: [agentRun('r1', { effort: 'high' })] });
    // A file with no matching live session: it must reach no tile.
    writeState(randomUUID(), {
      hud: { costUsd: 500, limits: [{ kind: 'seven_day', percentUsed: 99 }] },
      cache: cacheState(),
      agentRuns: [agentRun('d1', { model: 'claude-haiku-4-5', costUsd: 40 })],
    });
    await openOverview(page);
    await expect(tileAt(page, T4).getByTestId('stat-tile-value')).toHaveText('0');
    await expect(tileAt(page, T3)).toContainText('quota not reported');
    await expect(tileAt(page, T3)).not.toContainText('$500');
    expect((await tilesOf(request)).quota.sevenDayPct).toBeNull();
  });

  test('T1 shows "-" for the live count when the database is down, with the alert above', async ({ page }) => {
    await openOverview(page);
    const refresh = page.getByRole('button', { name: /updated \d+s ago/ });
    await expect(refresh).toBeVisible({ timeout: 15_000 });
    await expect(tileAt(page, 0).getByTestId('stat-tile-value')).not.toHaveText('-');
    // The next poll answers with the real snapshot, except that the database is down.
    await page.route('**/api/mission-control**', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, database: { ok: false, error: 'E2E database down' } } });
    });
    await refresh.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Database unreachable' })).toBeVisible();
    await expect(tileAt(page, 0).getByTestId('stat-tile-value')).toHaveText('-');
  });

  test('Needs Dave and Live tiles keep their big number in the value node', async ({ page, request }) => {
    const snapshot = (await (await request.get('/api/mission-control')).json()) as {
      tiles: { liveSessions: number; needsDave: number };
    };
    await openOverview(page);
    await expect(tileAt(page, 0).getByTestId('stat-tile-value')).toHaveText(String(snapshot.tiles.liveSessions));
    await expect(tileAt(page, 1).getByTestId('stat-tile-value')).toHaveText(String(snapshot.tiles.needsDave));
  });

  test('no horizontal scroll with the longest tile text', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, {
      hud: { costUsd: 1234.5678, limits: [{ kind: 'seven_day', percentUsed: 100 }] },
      cache: cacheState({ resumed: true }),
      agentRuns: [
        agentRun('r1', { costUsd: 987.65, advised: 3, effort: 'medium' }),
        agentRun('r2', { hasUnknownModelCost: true, model: 'claude-haiku-4-5', drift: 'Haiku is banned' }),
      ],
    });
    await openOverview(page);
    await expect(tileAt(page, T3)).toContainText('since resume');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document is wider than the viewport').toBeLessThanOrEqual(0);
  });
});
