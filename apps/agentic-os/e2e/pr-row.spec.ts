import { expect, test, type Page } from '@playwright/test';

import { clearLaneDashDir, writeLaneDash, writeLaneDashRaw } from './state-fixture';

/**
 * End-to-end check of the Open pull requests table on the Overview (card prflow-pr-row, contract note
 * .claudedocs/e2e-prflow-pr-row/2026-11-13-contract-note.md sections 3, 6 and 7).
 *
 * The app reads open-prs.json and pr-spend.json from AGENTIC_OS_LANE_DASH_DIR (a temp dir, never the real
 * ~/.claude/state/lane-dash) and joins each PR to a lane with one SELECT. It makes no GitHub call and writes nothing.
 * The parse rules have their own cases in pr-feed-parse.spec.ts (pure config).
 *
 * Run ONLY through the scratch harness (.claudedocs/e2e-prflow-pr-row/harness/run-scratch.mjs). It seeds the lanes
 * e2e-pr-branch-lane (branch feat/e2e-canary-branch-ref-7f3a), e2e-pr-leaf-lane, e2e-pr-dup-a and -b (one branch),
 * and e2e-pr-otherboard (another board), and sets E2E_PR_LANES=1. The lane tests skip without it.
 * Runs in chromium and phone width (390x844).
 */

const NOW_ISO = new Date().toISOString();
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const BRANCH_CANARY = 'feat/e2e-canary-branch-ref-7f3a';
const DUP_CANARY = 'feat/e2e-canary-dup-ref-7f3a';
const OTHER_CANARY = 'feat/e2e-canary-other-ref-7f3a';
const SHA_CANARY = 'cafe'.repeat(10);
const TITLE_CANARY = 'TITLE-CANARY-pr-row-5b1e';
const LABEL_CANARY = 'LABEL-CANARY free text';
const lanesSeeded = process.env.E2E_PR_LANES === '1';

type Row = Record<string, unknown>;

function openRow(pr: number, headRef: string, patch: Row = {}): Row {
  return {
    pr,
    headRef,
    head: SHA_CANARY,
    draft: false,
    labels: ['risk:normal', 'review:coderabbit', LABEL_CANARY],
    band: 'ELEVATED',
    ready: true,
    ci: ['check-failure', 'required-missing'],
    lastTap: { step: 'land', label: 'Land now (Recommended)', at: NOW_ISO, headMatches: true },
    status: 'ok',
    title: TITLE_CANARY,
    ...patch,
  };
}

function writeOpen(rows: Row[], exportedAt = NOW_ISO): void {
  writeLaneDash('open-prs', { schema: 1, exportedAt, repo: REPO, listed: rows.length, kept: rows.length, capped: false, deadlineHit: false, rows });
}

function writeSpend(rows: Row[]): void {
  writeLaneDash('pr-spend', { schema: 1, exportedAt: NOW_ISO, rows });
}

const spendRow = (pr: number, mergeSha: string | null = null): Row => ({
  key: `${REPO}#${pr}`,
  repo: REPO,
  pr,
  heads: 1,
  coderabbit: { usd: 2.5, rounds: 2, files: 10 },
  engine: { runs: 3, timedOut: 0, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } },
  landed: mergeSha === null ? null : { mergeSha, mergeCall: 'ok', reviewers: [], crRounds: 0 },
  headless: 'not shown',
  sessionTokens: 'not shown',
});

test.beforeEach(() => clearLaneDashDir());
test.afterEach(() => clearLaneDashDir());

async function openOverview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('open-pr-table')).toBeVisible();
}

const rowOf = (page: Page, pr: number) => page.locator(`[data-testid="open-pr-row"][data-pr="${pr}"]`);

test.describe('open pull requests table', () => {
  test('R1 no feed: the table says so and the old PR panel still shows', async ({ page }) => {
    await openOverview(page);
    await expect(page.getByTestId('open-pr-absent')).toHaveText('No open-PR feed yet.');
    await expect(page.getByTestId('pr-panel')).toBeVisible();
  });

  test('R2 a feed that is not JSON, or over 1 MB, reads as no feed', async ({ page }) => {
    writeLaneDashRaw('open-prs.json', '{ not json');
    await openOverview(page);
    await expect(page.getByTestId('open-pr-absent')).toBeVisible();
    writeLaneDashRaw('open-prs.json', JSON.stringify({ schema: 1, exportedAt: NOW_ISO, repo: REPO, rows: [], pad: 'x'.repeat(1024 * 1024 + 10) }));
    await page.reload();
    await expect(page.getByTestId('open-pr-absent')).toBeVisible();
  });

  test('R3 every column shows for a row: band, last tap, review path, spend, CI, READY, land commit', async ({ page }) => {
    writeOpen([openRow(545, 'feat/no-lane-here')]);
    writeSpend([spendRow(545, 'abcdef1234567890abcdef1234567890abcdef12')]);
    await openOverview(page);
    const row = rowOf(page, 545);
    await expect(row.getByTestId('open-pr-number')).toHaveText('#545');
    await expect(row.getByTestId('open-pr-lane')).toHaveText('-');
    await expect(row.getByTestId('open-pr-band')).toHaveText('ELEVATED');
    await expect(row.getByTestId('open-pr-tap')).toContainText('Land now (Recommended)');
    await expect(row.getByTestId('open-pr-review')).toHaveText('coderabbit');
    await expect(row.getByTestId('open-pr-spend')).toHaveText('$2.50 CodeRabbit, 3 engine runs');
    await expect(row.getByTestId('open-pr-ci')).toHaveText('check-failure, required-missing');
    await expect(row.getByTestId('open-pr-ready')).toHaveText('READY');
    await expect(row.getByTestId('open-pr-land')).toHaveText('abcdef1');
  });

  test('R3b the last 3 landed PRs show with a 7-character commit', async ({ page }) => {
    writeOpen([openRow(600, 'feat/a')]);
    writeSpend([
      spendRow(599, '1111111aaaaaaabbbbbbbcccccccdddddddeeeee'),
      spendRow(598, '2222222aaaaaaabbbbbbbcccccccdddddddeeeee'),
      spendRow(597, '3333333aaaaaaabbbbbbbcccccccdddddddeeeee'),
      spendRow(596, '4444444aaaaaaabbbbbbbcccccccdddddddeeeee'),
    ]);
    await openOverview(page);
    const landed = page.getByTestId('open-pr-landed-row');
    await expect(landed).toHaveCount(3);
    await expect(landed.first()).toHaveText('#599 1111111');
    await expect(page.locator('body')).not.toContainText('#596 4444444');
  });

  test('R4 a stale feed shows its age beside READY', async ({ page }) => {
    writeOpen([openRow(546, 'feat/b')], TWO_DAYS_AGO);
    await openOverview(page);
    await expect(page.getByTestId('open-pr-stale')).toHaveText('stale: 48 h old');
    await expect(rowOf(page, 546).getByTestId('open-pr-ready')).toHaveText('READY (48 h old)');
  });

  test('R5 a row that is not ok shows READY as unknown; no spend file shows "no data"', async ({ page }) => {
    writeOpen([openRow(547, 'feat/c', { status: 'review-status-timeout', ready: null, ci: [] })]);
    await openOverview(page);
    const row = rowOf(page, 547);
    await expect(row.getByTestId('open-pr-ready')).toHaveText('unknown');
    await expect(row.getByTestId('open-pr-status')).toHaveText('review-status-timeout');
    await expect(row.getByTestId('open-pr-spend')).toHaveText('no data');
  });

  test('R6 head ref, head sha, labels and title never reach the page or the API', async ({ page, request }) => {
    writeOpen([openRow(548, BRANCH_CANARY), openRow(549, DUP_CANARY), openRow(550, OTHER_CANARY)]);
    writeSpend([spendRow(548)]);
    await openOverview(page);
    await expect(rowOf(page, 548)).toBeVisible();
    const html = await page.content();
    const api = await (await request.get('/api/mission-control')).text();
    for (const canary of [BRANCH_CANARY, DUP_CANARY, OTHER_CANARY, SHA_CANARY, TITLE_CANARY, LABEL_CANARY, 'e2e-canary']) {
      expect(html, `page holds ${canary}`).not.toContain(canary);
      expect(api, `api holds ${canary}`).not.toContain(canary);
    }
    // The feed rides only on the Overview poll.
    for (const view of ['board', 'spend', 'flow']) {
      const body = JSON.parse(await (await request.get(`/api/mission-control?view=${view}`)).text()) as { prFeed: unknown };
      expect(body.prFeed, view).toBeNull();
    }
  });

  test('R7 lane link: branch, head ref leaf, 2 lanes, another board', async ({ page }) => {
    test.skip(!lanesSeeded, 'needs the lanes that run-scratch.mjs seeds');
    writeOpen([
      openRow(551, BRANCH_CANARY),
      openRow(552, 'feat/e2e-pr-leaf-lane'),
      openRow(553, DUP_CANARY),
      openRow(554, OTHER_CANARY),
    ]);
    await openOverview(page);
    await expect(rowOf(page, 551).getByTestId('open-pr-lane')).toHaveText('e2e-pr-branch-lane');
    await expect(rowOf(page, 552).getByTestId('open-pr-lane')).toHaveText('e2e-pr-leaf-lane');
    await expect(rowOf(page, 553).getByTestId('open-pr-lane')).toHaveText('2 lanes');
    await expect(rowOf(page, 554).getByTestId('open-pr-lane')).toHaveText('-');
  });

  test('R8 another repo shows no rows', async ({ page }) => {
    writeLaneDash('open-prs', { schema: 1, exportedAt: NOW_ISO, repo: 'someone/else', rows: [openRow(555, 'feat/x')] });
    await openOverview(page);
    await expect(page.getByTestId('open-pr-row')).toHaveCount(0);
    await expect(page.getByTestId('open-pr-absent')).toHaveText('The open-PR feed names another repo.');
  });

  test('R9 phone width: no horizontal scroll with 20 rows and long codes', async ({ page }) => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      openRow(700 + i, `feat/${'w'.repeat(90)}${i}`, {
        ci: ['check-' + 'x'.repeat(20), 'mergeable-' + 'y'.repeat(20), 'status-' + 'z'.repeat(20)],
        lastTap: { step: 'review', label: 'W'.repeat(60), at: NOW_ISO, headMatches: false },
      }),
    );
    writeOpen(rows);
    await openOverview(page);
    await expect(page.getByTestId('open-pr-row')).toHaveCount(20);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'document is wider than the viewport').toBeLessThanOrEqual(0);
  });
});
