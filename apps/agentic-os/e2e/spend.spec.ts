import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  agentRun,
  cacheState,
  clearIdentityDir,
  clearSpendDir,
  clearStateDir,
  SESSION_ID_FORMAT,
  writeIdentity,
  writeRollup,
  writeSpendRaw,
  writeState,
} from './state-fixture';

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

test.beforeEach(() => {
  clearStateDir();
  clearSpendDir();
  clearIdentityDir();
});
test.afterEach(() => {
  clearStateDir();
  clearSpendDir();
  clearIdentityDir();
});

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

// --- E3: the Spend tab -------------------------------------------------------------------------------
// Plan sections 2 and 6 (E3). The headline folds the state files with `at` today (CDT), live or not, so these
// tests need no live database session. The money math has its own cases in
// .claude/hooks/src/__tests__/spend-fold-view.test.ts. Fixtures use whole cents: the screen rounds to the cent.

const SAMPLE_PATH = fileURLToPath(new URL('./fixtures/spend-rollup.sample.json', import.meta.url));
const SAMPLE = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as Record<string, unknown>;

/** The CDT date, the same Intl rule as the app (never a fixed UTC offset). */
const cdtToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(Date.now());

function writeSampleRollup(patch: Record<string, unknown> = {}): void {
  const day = cdtToday();
  writeRollup(day, { ...SAMPLE, day, ...patch });
}

async function openSpend(page: Page): Promise<void> {
  await page.goto('/?view=spend');
  await expect(page.getByTestId('spend-view')).toBeVisible();
}

const usd = async (locator: Locator, attr = 'data-usd'): Promise<number> => {
  const value = await locator.getAttribute(attr);
  expect(value, `${attr} on ${await locator.evaluate((el) => el.outerHTML.slice(0, 120))}`).not.toBeNull();
  return Number(value);
};
const cents = (value: number): number => Math.round(value * 100);

/** Two files today: engine 12.00 + 8.00 = 20.00; runs 3.00 + 2.50 = 5.50 (est); residual 14.50. */
function writeTodayState(): { a: string; b: string } {
  const a = randomUUID();
  const b = randomUUID();
  writeState(a, {
    hud: { costUsd: 12, limits: [] },
    cache: cacheState(),
    agentRuns: [
      agentRun('a1', { model: 'claude-opus-4-7', effort: 'high', type: 'scout', costUsd: 2 }),
      agentRun('a2', { model: 'claude-sonnet-5-5', effort: 'medium', type: 'kraken', costUsd: 1 }),
    ],
  });
  writeState(b, {
    hud: { costUsd: 8, limits: [] },
    cache: cacheState(),
    agentRuns: [agentRun('b1', { model: 'claude-opus-4-7', effort: null, type: 'scout', costUsd: 2.5 })],
  });
  return { a, b };
}

test.describe('spend tab', () => {
  test('E3.1 the Spend tab is enabled, and ?view=spend survives a reload', async ({ page }) => {
    await page.goto('/');
    const tab = page.getByTestId('nav-tab').filter({ hasText: 'Spend' });
    await expect(tab).toBeEnabled();
    await expect(tab.getByTestId('nav-tab-tag')).toHaveCount(0);
    await expect(page.getByTestId('nav-tab').filter({ hasText: 'Evidence' })).toHaveCount(0);
    await tab.click();
    await expect(page.getByTestId('spend-view')).toBeVisible();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).searchParams.get('view')).toBe('spend');
    await page.reload();
    await expect(page.getByTestId('spend-view')).toBeVisible();
    await expect(page.getByTestId('spend-loading')).toHaveCount(0);
    await expect(page.getByTestId('nav-tab').filter({ hasText: 'Spend' })).toHaveAttribute('aria-current', 'page');
    // The tiles stay above every view.
    await expect(page.getByTestId('stat-tiles')).toBeVisible();
  });

  test('the API fills spend only for view=spend', async ({ request }) => {
    const plain = (await (await request.get('/api/mission-control')).json()) as { spend: unknown };
    expect(plain.spend).toBeNull();
    const asked = (await (await request.get('/api/mission-control?view=spend')).json()) as {
      spend: { day: string } | null;
    };
    expect(asked.spend).not.toBeNull();
    expect(asked.spend?.day).toBe(cdtToday());
  });

  test('no state files today: a dashed box, and a file of an older day is not counted', async ({ page }) => {
    writeState(randomUUID(), { at: Date.now() - 36 * 3_600_000, hud: { costUsd: 500, limits: [] }, cache: cacheState() });
    await openSpend(page);
    await expect(page.getByTestId('spend-empty')).toHaveText('No session state files today.');
    await expect(page.getByTestId('spend-engine')).toHaveCount(0);
    await expect(page.getByTestId('spend-view')).not.toContainText('$500');
  });

  test('the header reads "as of hh:mm" with a Chicago zone name', async ({ page }) => {
    await openSpend(page);
    await expect(page.getByTestId('spend-as-of')).toHaveText(/^as of \d\d:\d\d C[DS]T$/);
  });

  test('E3.2 no rollup file: "rollup not built yet", and no table of zeros', async ({ page }) => {
    writeTodayState();
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup-missing')).toHaveText('Engine by model: rollup not built yet.');
    await expect(page.getByTestId('spend-rollup')).toHaveCount(0);
    await expect(page.getByTestId('spend-rollup-row')).toHaveCount(0);
    await expect(page.getByTestId('spend-rollup-schema')).toHaveCount(0);
    // The rest of the tab still shows.
    await expect(page.getByTestId('spend-engine')).toBeVisible();
  });

  test('a rollup that is not JSON, or has a bad row, also reads "not built yet"', async ({ page }) => {
    writeSpendRaw(`${cdtToday()}.json`, '{not json');
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup-missing')).toBeVisible();

    const rows = [{ ...(SAMPLE.rows as Record<string, unknown>[])[0], requests: -1 }];
    writeSampleRollup({ rows });
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup-missing')).toBeVisible();
    await expect(page.getByTestId('spend-rollup-row')).toHaveCount(0);
  });

  test('E3.3 the sample rollup renders engine by model, with the advisor row and the Haiku helper row', async ({
    page,
  }) => {
    writeSampleRollup();
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup')).toBeVisible();
    await expect(page.getByTestId('spend-rollup-missing')).toHaveCount(0);
    const rows = page.getByTestId('spend-rollup-row');
    await expect(rows).toHaveCount(5);
    const advisor = page.locator('[data-testid="spend-rollup-row"][data-kind="advisor"]');
    await expect(advisor).toHaveCount(1);
    await expect(advisor).toHaveAttribute('data-model', 'claude-opus-4-7');
    await expect(advisor).toContainText('advisor');
    const helper = page.locator('[data-testid="spend-rollup-row"][data-kind="helper"]');
    await expect(helper).toHaveCount(1);
    await expect(helper).toHaveAttribute('data-model', 'claude-haiku-4-5');
    await expect(helper).toContainText('helper, no effort');
    // A null estUsd is never $0.00.
    await expect(helper).toHaveAttribute('data-est-usd', '');
    await expect(helper.getByTestId('spend-rollup-est')).toHaveText('no est');
    await expect(page.locator('[data-testid="spend-rollup-model"]')).toHaveCount(3);
    // The model line of the helper-only model reads "no est" too, never "est $0.00".
    const haikuModel = page.locator('[data-testid="spend-rollup-model"][data-model="claude-haiku-4-5"]');
    await expect(haikuModel).toHaveAttribute('data-est-usd', '');
    await expect(haikuModel).toContainText('engine $0.75 · no est · residual $0.75');
    await expect(haikuModel).not.toContainText('$0.00');
    // A model with real est cells keeps its est.
    await expect(
      page.locator('[data-testid="spend-rollup-model"][data-model="claude-opus-4-7"]'),
    ).toContainText('est $9.00');
  });

  test('E3.4b sub-cent rollup values: the shown row ests add to the shown model est, and the shown residual closes', async ({
    page,
  }) => {
    // Three opus rows of est 0.3333 and engine 2.00. Shown: $0.33 x 3, est $0.99, residual $1.01 (not $1.00 / $1.00).
    const base = (SAMPLE.rows as Record<string, unknown>[])[0];
    writeSampleRollup({
      rows: [0, 1, 2].map((i) => ({ ...base, effort: `e${i}`, kind: 'main', estUsd: 0.3333 })),
      engineByModel: [{ model: base.model, engineUsd: 2 }],
    });
    await openSpend(page);
    const cells = page.locator('[data-testid="spend-rollup-row"]');
    await expect(cells).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) await expect(cells.nth(i).getByTestId('spend-rollup-est')).toContainText('est $0.33');
    const model = page.getByTestId('spend-rollup-model');
    await expect(model).toHaveCount(1);
    await expect(model).toContainText('engine $2.00 · est $0.99 · residual $1.01');
    // The same numbers, read from the visible text only: engine - sum of shown cells = shown residual.
    const shown = (text: string): number => Math.round(Number(/\$(-?\d+\.\d\d)/.exec(text)?.[1]) * 100);
    let sum = 0;
    for (let i = 0; i < 3; i += 1) sum += shown((await cells.nth(i).getByTestId('spend-rollup-est').textContent()) ?? '');
    expect(2 * 100 - sum).toBe(101);
  });

  test('E3.4 per model: engine minus the shown est cells equals the shown residual, to the cent', async ({ page }) => {
    writeSampleRollup();
    await openSpend(page);
    const models = page.getByTestId('spend-rollup-model');
    await expect(models).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      const model = models.nth(i);
      const id = (await model.getAttribute('data-model')) as string;
      const engine = await usd(model, 'data-engine-usd');
      const residual = await usd(model, 'data-residual-usd');
      const cells = page.locator(`[data-testid="spend-rollup-row"][data-model="${id}"]`);
      let est = 0;
      for (let j = 0; j < (await cells.count()); j += 1) {
        const value = await cells.nth(j).getAttribute('data-est-usd');
        if (value !== '' && value !== null) est += Number(value);
      }
      expect(cents(engine) - cents(est), `residual of ${id}`).toBe(cents(residual));
    }
    // Numbers of the fixture: opus 10.50 - 9.00 = 1.50; sonnet 4.00 - 3.50 = 0.50; haiku 0.75 - 0 = 0.75.
    await expect(page.locator('[data-testid="spend-rollup-model"][data-model="claude-opus-4-7"]')).toContainText('$1.50');
    await expect(page.locator('[data-testid="spend-rollup-model"][data-model="claude-haiku-4-5"]')).toContainText('$0.75');
  });

  test('E3.5 headline: the residual line equals engine minus est, to the cent', async ({ page }) => {
    writeTodayState();
    await openSpend(page);
    const engine = page.getByTestId('spend-engine');
    const est = page.getByTestId('spend-est');
    const residual = page.getByTestId('spend-residual');
    expect(await usd(engine)).toBe(20);
    expect(await usd(est)).toBe(5.5);
    expect(cents(await usd(engine)) - cents(await usd(est))).toBe(cents(await usd(residual)));
    await expect(engine).toContainText('$20.00');
    await expect(est).toContainText('est $5.50');
    await expect(residual).toHaveText('engine $20.00 minus est $5.50 not in ledger: $14.50');
    // The two files are not live sessions here (no database row), so the sum is an engine sum, not est.
    await expect(engine).toHaveAttribute('data-kind', /^(engine|est)$/);
    await expect(engine).not.toContainText('$0.00');
  });

  test('the residual line keeps the labels of its operands: unpriced, and at least for an advised run', async ({ page }) => {
    // One run with no price and no cost: the est operand reads "unpriced", not "$0.00".
    const id = randomUUID();
    writeState(id, {
      hud: { costUsd: 9, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('u1', { model: 'claude-mystery-1', costUsd: 0, hasUnknownModelCost: true })],
    });
    await openSpend(page);
    await expect(page.getByTestId('spend-residual')).toHaveText('engine $9.00 minus unpriced not in ledger: $9.00');
    await expect(page.getByTestId('spend-residual')).not.toContainText('$0.00');

    // An advised run: the est operand is a floor and keeps "at least".
    writeState(id, {
      hud: { costUsd: 9, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('f1', { costUsd: 1.5, advised: 2 })],
    });
    await openSpend(page);
    await expect(page.getByTestId('spend-residual')).toHaveText('engine $9.00 minus at least est $1.50 not in ledger: $7.50');

    // A resumed session: the engine operand keeps "at least".
    writeState(id, { hud: { costUsd: 9, limits: [] }, cache: cacheState({ resumed: true }), agentRuns: [agentRun('r1', { costUsd: 1.5 })] });
    await openSpend(page);
    await expect(page.getByTestId('spend-residual')).toContainText('at least engine $9.00 minus est $1.50 not in ledger: $7.50');
  });

  test('sub-cent headline: the shown residual is the shown engine minus the shown est', async ({ page }) => {
    // 2.004 - 1.006 = 0.998 would read $1.00, but the screen shows $2.00 and $1.01, so the residual reads $0.99.
    writeState(randomUUID(), {
      hud: { costUsd: 2.004, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('c1', { costUsd: 1.006 })],
    });
    await openSpend(page);
    await expect(page.getByTestId('spend-residual')).toHaveText('engine $2.00 minus est $1.01 not in ledger: $0.99');
    expect(await usd(page.getByTestId('spend-residual'))).toBe(0.99);
  });

  test('a negative residual is shown with its sign, not clamped to $0.00', async ({ page }) => {
    writeState(randomUUID(), {
      hud: { costUsd: 1, limits: [] },
      cache: cacheState(),
      agentRuns: [agentRun('n1', { costUsd: 4 })],
    });
    await openSpend(page);
    expect(await usd(page.getByTestId('spend-residual'))).toBe(-3);
    await expect(page.getByTestId('spend-residual')).toContainText('-$3.00');
  });

  test('a session with no hud reads "no data" and never $0.00', async ({ page }) => {
    writeState(randomUUID(), { agentRuns: [agentRun('x1', { costUsd: 1.5 })] });
    await openSpend(page);
    await expect(page.getByTestId('spend-engine')).toHaveText(/no data/);
    await expect(page.getByTestId('spend-engine')).toHaveAttribute('data-kind', 'no data');
    await expect(page.getByTestId('spend-engine')).not.toHaveAttribute('data-usd', /.*/);
    await expect(page.getByTestId('spend-by-session-row').first()).toContainText('no data');
    await expect(page.getByTestId('spend-view')).not.toContainText('$0.00');
  });

  test('E3.6 the est rows by model, by effort and by agent type each sum to the est headline', async ({ page }) => {
    writeTodayState();
    await openSpend(page);
    const headline = await usd(page.getByTestId('spend-est'));
    for (const table of ['spend-by-model', 'spend-by-effort', 'spend-by-type']) {
      const rows = page.getByTestId(`${table}-row`);
      expect(await rows.count(), `${table} rows`).toBeGreaterThan(0);
      let sum = 0;
      for (let i = 0; i < (await rows.count()); i += 1) sum += await usd(rows.nth(i));
      expect(cents(sum), table).toBe(cents(headline));
    }
    // opus x high, opus x no effort, sonnet x medium: three effort rows, the null effort is its own row.
    await expect(page.getByTestId('spend-by-effort-row')).toHaveCount(3);
    await expect(page.getByTestId('spend-by-effort')).toContainText('no effort');
    await expect(page.getByTestId('spend-by-model-row')).toHaveCount(2);
    await expect(page.getByTestId('spend-by-type-row')).toHaveCount(2);
  });

  test('no subagent runs today: "No subagent runs today." in each est table', async ({ page }) => {
    writeState(randomUUID(), { hud: { costUsd: 3, limits: [] }, cache: cacheState() });
    await openSpend(page);
    await expect(page.getByTestId('spend-by-model')).toContainText('No subagent runs today.');
    await expect(page.getByTestId('spend-by-effort')).toContainText('No subagent runs today.');
    await expect(page.getByTestId('spend-by-type')).toContainText('No subagent runs today.');
    await expect(page.getByTestId('spend-by-model-row')).toHaveCount(0);
  });

  test('est rows carry "at least" for an advised run and "unpriced" for a run with no price', async ({ page }) => {
    writeState(randomUUID(), {
      hud: { costUsd: 9, limits: [] },
      cache: cacheState(),
      agentRuns: [
        agentRun('f1', { model: 'claude-opus-4-7', costUsd: 1.5, advised: 2 }),
        agentRun('u1', { model: 'claude-mystery-1', costUsd: 0, hasUnknownModelCost: true }),
      ],
    });
    await openSpend(page);
    const opus = page.locator('[data-testid="spend-by-model-row"][data-key="claude-opus-4-7"]');
    await expect(opus).toHaveAttribute('data-floor', 'true');
    await expect(opus).toContainText('at least');
    const unknownModel = 'claude-mystery-1';
    const mystery = page.locator(`[data-testid="spend-by-model-row"][data-key="${unknownModel}"]`);
    await expect(mystery).toHaveAttribute('data-unpriced', '1');
    await expect(mystery).toContainText('unpriced');
    await expect(mystery).not.toContainText('$0.00');
    await expect(page.getByTestId('spend-est')).toContainText('at least est $1.50 + 1 unpriced');
  });

  test('the headline says "at least" and "N since resume" for a resumed session', async ({ page }) => {
    writeState(randomUUID(), { hud: { costUsd: 5, limits: [] }, cache: cacheState({ resumed: true }) });
    await openSpend(page);
    await expect(page.getByTestId('spend-engine')).toHaveAttribute('data-kind', 'at least');
    await expect(page.getByTestId('spend-engine')).toContainText('at least');
    await expect(page.getByTestId('spend-engine')).toContainText('1 since resume');
  });

  test('by session: name #sid8, engine and est, engine amber at $150 and plain at $149.99', async ({ page }) => {
    const named = randomUUID();
    const plain = randomUUID();
    writeIdentity(named, { name: 'spendy' });
    writeState(named, { hud: { costUsd: 150, limits: [] }, cache: cacheState(), agentRuns: [agentRun('s1', { costUsd: 2 })] });
    writeState(plain, { hud: { costUsd: 149.99, limits: [] }, cache: cacheState() });
    await openSpend(page);
    const rows = page.getByTestId('spend-by-session-row');
    await expect(rows).toHaveCount(2);
    const first = rows.nth(0);
    await expect(first.getByTestId('session-label')).toContainText(`spendy #${named.slice(0, 8)}`);
    await expect(first).toHaveAttribute('data-tone', 'warn');
    await expect(first).toContainText('$150.00');
    await expect(first).toContainText('est $2.00');
    const second = rows.nth(1);
    await expect(second.getByTestId('session-label')).toContainText(`unnamed #${plain.slice(0, 8)}`);
    await expect(second).not.toHaveAttribute('data-tone', 'warn');
  });

  test('quota: 79 is plain and 80 is warn, from a file that is not live', async ({ page }) => {
    const id = randomUUID();
    writeState(id, { hud: { costUsd: 1, limits: [{ kind: 'seven_day', percentUsed: 79 }] }, cache: cacheState() });
    await openSpend(page);
    await expect(page.getByTestId('spend-quota')).toContainText('79%');
    await expect(page.getByTestId('spend-quota')).not.toHaveAttribute('data-tone', 'warn');
    writeState(id, { hud: { costUsd: 1, limits: [{ kind: 'seven_day', percentUsed: 80 }] }, cache: cacheState() });
    await openSpend(page);
    await expect(page.getByTestId('spend-quota')).toHaveAttribute('data-tone', 'warn');
  });

  test('quota is "not reported" with no seven_day reading', async ({ page }) => {
    writeState(randomUUID(), { hud: { costUsd: 1, limits: [] }, cache: cacheState() });
    await openSpend(page);
    await expect(page.getByTestId('spend-quota')).toContainText('not reported');
  });

  test('E3.7 the quality chip counts one unpriced run and one resumed session', async ({ page }) => {
    writeState(randomUUID(), {
      hud: { costUsd: 5, limits: [] },
      cache: cacheState({ resumed: true }),
      agentRuns: [agentRun('q1', { costUsd: 1 }), agentRun('q2', { model: 'claude-mystery-1', hasUnknownModelCost: true })],
    });
    writeState(randomUUID(), { hud: { costUsd: 2, limits: [] }, cache: cacheState() });
    writeState(randomUUID(), {});
    await openSpend(page);
    const chip = page.getByTestId('spend-quality');
    await expect(chip).toHaveAttribute('data-unpriced-runs', '1');
    await expect(chip).toHaveAttribute('data-resumed', '1');
    await expect(chip).toHaveAttribute('data-no-data', '1');
    await expect(chip).toHaveAttribute('data-at-cap', '0');
    await expect(chip).toContainText('1 unpriced run');
    await expect(chip).toContainText('1 resumed');
    await expect(chip).toContainText('1 with no data');
    await expect(chip).toContainText('subagent $ misses runs past the 50-run cap');
  });

  test('the quality chip shows the rollup counts when a rollup exists', async ({ page }) => {
    writeTodayState();
    writeSampleRollup();
    await openSpend(page);
    const chip = page.getByTestId('spend-quality');
    await expect(chip).toContainText('rollup: 4 of 5 sessions clean');
    await expect(chip).toContainText('residual band 4.5%');
  });

  test('E3.8 a rollup with schema 2 reads "rollup schema not known"', async ({ page }) => {
    writeSampleRollup({ schema: 2 });
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup-schema')).toHaveText('Engine by model: rollup schema not known.');
    await expect(page.getByTestId('spend-rollup-missing')).toHaveCount(0);
    await expect(page.getByTestId('spend-rollup-row')).toHaveCount(0);
  });

  test('a rollup written for another day is not used', async ({ page }) => {
    writeSampleRollup({ day: '2020-01-01' });
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup-missing')).toBeVisible();
  });

  test('a line says that history, anomalies and by-lane are not in this view yet', async ({ page }) => {
    await openSpend(page);
    await expect(page.getByTestId('spend-not-built')).toContainText('hourly against median');
  });

  test('E3.9 no horizontal scroll with the full rollup, long ids and many sessions', async ({ page }) => {
    writeSampleRollup({
      rows: [
        ...(SAMPLE.rows as Record<string, unknown>[]),
        { ...(SAMPLE.rows as Record<string, unknown>[])[0], model: `claude-${'x'.repeat(50)}-1`, effort: 'e'.repeat(50) },
      ],
    });
    for (let i = 0; i < 12; i += 1) {
      writeState(randomUUID(), {
        hud: { costUsd: 1234 + i, limits: [{ kind: 'seven_day', percentUsed: 100 }] },
        cache: cacheState({ resumed: true }),
        agentRuns: [
          agentRun(`w${i}`, { costUsd: 987.65, advised: 3, type: `agent-type-${'y'.repeat(30)}${i}`, model: `claude-${'z'.repeat(40)}` }),
        ],
      });
    }
    await openSpend(page);
    await expect(page.getByTestId('spend-rollup')).toBeVisible();
    await expect(page.getByTestId('spend-by-session-row')).toHaveCount(10);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document is wider than the viewport').toBeLessThanOrEqual(0);
  });
});
