import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  clearLaneDashDir,
  clearStateDir,
  SESSION_ID_FORMAT,
  writeLaneDash,
  writeState,
} from './state-fixture';

/**
 * Page and API check for lane agentic-os-tiles-truth (report .claudedocs/agentic-os-redesign/09-dataflow-review-2026-11-23.md).
 * The numbers behind items C4 and C16 have pure cases in tiles-truth-fold.spec.ts.
 *
 * Run ONLY through the scratch harness (database specs). READ-ONLY toward the app: the writes are fixture files in the
 * private E2E state and lane-dash directories. Runs in chromium and at phone width.
 *
 *   C1  the Open PRs tile counts the open-PR feed, not the PRs that live sessions watch
 *   C6  the cost tile says "live sessions"; the Spend tab says whole running cost of each session
 *   C11 the snapshot names its core reads as sources, so a failed one has a reason on screen
 *   C14 the PR card says what its spend field holds
 *   C16 the Spend tab splits the day total into ended (final) and live (estimate)
 *   C4  the board counts are the true counts (the invariants; the cut itself is in the pure spec)
 */

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const NOW_ISO = new Date().toISOString();

type Row = Record<string, unknown>;

const openRow = (pr: number): Row => ({
  pr,
  headRef: `feat/tiles-truth-${pr}`,
  head: 'cafe'.repeat(10),
  draft: false,
  labels: [],
  band: 'MID',
  ready: false,
  ci: [],
  lastTap: null,
  status: 'ok',
  title: 'x',
});

function writeOpen(rows: Row[], exportedAt = NOW_ISO, capped = false): void {
  writeLaneDash('open-prs', {
    schema: 1,
    exportedAt,
    repo: REPO,
    listed: rows.length,
    kept: rows.length,
    capped,
    deadlineHit: false,
    rows,
  });
}

test.beforeEach(() => {
  clearLaneDashDir();
  clearStateDir();
});
test.afterEach(() => {
  clearLaneDashDir();
  clearStateDir();
});

const tileOf = (page: Page, label: string) => page.getByTestId('stat-tile').filter({ hasText: label });

type Snapshot = {
  tiles: { openPrs: number | null; openPrsCapped: boolean; openPrsStale: boolean };
  prs: unknown[];
  prFeed: unknown;
  sources: { id: string; status: string; detail: string }[];
};

async function snapshotOf(request: APIRequestContext, query = ''): Promise<Snapshot> {
  const response = await request.get(`/api/mission-control${query}`);
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

async function liveSessionId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/mission-control');
  const body = (await response.json()) as { active: { sessions: { id: string; liveSecondsAgo: number }[] } };
  const live = body.active.sessions.filter((s) => s.liveSecondsAgo < 900 && SESSION_ID_FORMAT.test(s.id));
  expect(live.length, 'Precondition: the database needs a live session with a UUID-shaped id.').toBeGreaterThanOrEqual(1);
  return live[0].id;
}

test.describe('C1 the Open PRs tile counts the feed', () => {
  test('X1 no feed: the tile reads "-" and "no feed", never 0', async ({ page, request }) => {
    const snapshot = await snapshotOf(request);
    expect(snapshot.tiles.openPrs).toBeNull();
    await page.goto('/');
    await expect(tileOf(page, 'Open PRs')).toContainText('no feed');
    await expect(tileOf(page, 'Open PRs').getByTestId('stat-tile-value')).toHaveText('-');
  });

  test('X2 a feed of 3 PRs: the tile reads 3 while a live session watches none', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { prs: [] });
    writeOpen([openRow(701), openRow(702), openRow(703)]);
    expect((await snapshotOf(request)).tiles.openPrs).toBe(3);
    await page.goto('/');
    await expect(tileOf(page, 'Open PRs').getByTestId('stat-tile-value')).toHaveText('3');
    await expect(page.locator('[data-testid="open-pr-row"]')).toHaveCount(3);
  });

  test('X3 the board and spend polls carry the same tile number and no table feed', async ({ request }) => {
    writeOpen([openRow(701), openRow(702)]);
    for (const view of ['board', 'spend', 'flow']) {
      const snapshot = await snapshotOf(request, `?view=${view}`);
      expect(snapshot.tiles.openPrs, `view=${view}`).toBe(2);
      expect(snapshot.prFeed, `view=${view} carries no table feed`).toBeNull();
    }
  });

  test('X4 a feed that lists more than the table shows reads "20+"', async ({ page, request }) => {
    writeOpen(Array.from({ length: 25 }, (_, index) => openRow(800 + index)), NOW_ISO, true);
    const snapshot = await snapshotOf(request);
    expect(snapshot.tiles.openPrs).toBe(20);
    expect(snapshot.tiles.openPrsCapped).toBe(true);
    await page.goto('/');
    await expect(tileOf(page, 'Open PRs').getByTestId('stat-tile-value')).toHaveText('20+');
  });

  test('X5 a stale feed keeps its number and says it is stale', async ({ page, request }) => {
    writeOpen([openRow(701)], new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    const snapshot = await snapshotOf(request);
    expect(snapshot.tiles.openPrs).toBe(1);
    expect(snapshot.tiles.openPrsStale).toBe(true);
    await page.goto('/');
    await expect(tileOf(page, 'Open PRs')).toContainText('feed is stale');
  });
});

test.describe('C6 and C16 spend words', () => {
  test('X6 the cost tile says "live sessions", never "all sessions"', async ({ page, request }) => {
    const id = await liveSessionId(request);
    writeState(id, { hud: { costUsd: 5, limits: [] } });
    await page.goto('/');
    const tile = tileOf(page, 'Quota and spend');
    await expect(tile).toContainText('live sessions');
    await expect(tile).not.toContainText('all sessions');
  });

  test('X7 the Spend tab splits ended (final) from live (estimate)', async ({ page, request }) => {
    const live = await liveSessionId(request);
    writeState(live, { hud: { costUsd: 10, limits: [] } });
    writeState(randomUUID(), { hud: { costUsd: 5, limits: [] } });
    await page.goto('/?view=spend');
    const split = page.getByTestId('spend-split');
    await expect(split).toContainText('ended sessions engine $5.00 (1)');
    await expect(split).toContainText('live sessions est $10.00 (1)');
    await expect(split).toContainText('whole running cost');
  });
});

test.describe('C14 the PR card names what its spend holds', () => {
  test('X8 the field label is "CodeRabbit + engine", not "spend"', async ({ page }) => {
    writeOpen([openRow(701)]);
    await page.goto('/');
    const row = page.locator('[data-testid="open-pr-row"][data-pr="701"]');
    await expect(row.getByText('CodeRabbit + engine', { exact: true })).toBeVisible();
    await expect(row.getByText('spend', { exact: true })).toHaveCount(0);
  });
});

test.describe('C11 core reads are sources; C4 board counts', () => {
  test('X9 the snapshot lists the two core reads as sources', async ({ request }) => {
    const snapshot = await snapshotOf(request);
    const byId = new Map(snapshot.sources.map((s) => [s.id, s]));
    expect(byId.get('fleet-overview')?.status).toBe('ok');
    expect(byId.get('active-sessions')?.status).toBe('ok');
  });

  test('X10 board counts: a column count is never below its rows, the total is their sum, done shows at most 10', async ({
    request,
  }) => {
    const board = (await (await request.get('/api/mission-control?view=board')).json()) as {
      board: { status: string; total: number; truncated: boolean; columns: { state: string; count: number; shown: number }[] };
    };
    expect(board.board.status).toBe('ok');
    for (const column of board.board.columns) expect(column.count).toBeGreaterThanOrEqual(column.shown);
    expect(board.board.total).toBe(board.board.columns.reduce((sum, c) => sum + c.count, 0));
    expect(board.board.columns.find((c) => c.state === 'done')?.shown ?? 0).toBeLessThanOrEqual(10);
    expect(typeof board.board.truncated).toBe('boolean');
  });
});
