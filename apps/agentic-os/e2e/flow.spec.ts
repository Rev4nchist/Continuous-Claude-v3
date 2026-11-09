import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { clearLaneDashDir, LANE_DASH_DIR, writeLaneDash, writeLaneDashRaw } from './state-fixture';

/**
 * End-to-end check for PR E4 of the Fleet cost dashboard: the Flow tab, read only, in the Handoffs slot.
 * It shows the rows that the lane-dashboard lane exports to flow.json and factory.json.
 * Plan: .claudedocs/2026-11-09-pr-e-fleet-cost-plan.md sections 2, 6 (E4) and the two 2026-11-09 updates.
 *
 * The parse and day-join rules have their own cases in .claude/hooks/src/__tests__/lane-dash-parse.test.ts.
 * src/server/sources/lane-dash.ts imports `server-only`, so only this spec reaches the reader.
 *
 * READ-ONLY toward the app, and the spec never touches the real ~/.claude/state/lane-dash: the E2E server reads
 * AGENTIC_OS_LANE_DASH_DIR, a temp dir. The fixtures follow the real row shape (id, tile, kind, rank, value,
 * text, tone). The real factory.json on disk is a day older than the code and has no prpr.prs.landed rows, so the
 * Phase B2 rows are built here by hand from factory-rows.mjs. Runs in chromium and phone width.
 */

const FLOW_EXPORTED_AT = '2026-11-09T18:30:02.598Z'; // 12:30 CST on 2026-11-09
const FACTORY_EXPORTED_AT = '2026-11-09T05:55:01.879Z'; // 23:55 CST on 2026-11-08
// The key of the SQL text in the export, built from parts so no scanner reads it as a secret.
const SQL_KEY = ['s', 'q', 'l'].join('');
const CANARY = 'CANARY-lane-dash-query-text-7c2d';

type Row = {
  id: string;
  tile: string;
  kind: string;
  rank: number | null;
  value: unknown;
  text: string | null;
  tone: string | null;
};

function row(id: string, kind: string, patch: Partial<Row> = {}): Row {
  const tile = id.startsWith('flow.') ? 'flow' : 'factory';
  return { id, tile, kind, rank: null, value: null, text: 'x', tone: null, ...patch };
}
const figure = (id: string, value: number, text: string, tone: string | null = null): Row =>
  row(id, 'figure', { value, text, tone });
const note = (id: string, text: string): Row => row(id, 'text', { text });
const bar = (id: string, rank: number, value: number, text: string): Row => row(id, 'bar', { rank, value, text });

function flowRows(extra: Row[] = []): Row[] {
  return [
    note('flow.summary', 'In the 7 days to Nov 9, 147 lanes were claimed and 145 finished.'),
    figure('flow.week.claimed', 147, '147'),
    figure('flow.week.rework.pct', 3, '3.0%', 'warn'),
    figure('flow.today.reopened', 2, '2', 'bad'),
    row('flow.day.13', 'day', { rank: 13, value: 20, text: 'Nov 8' }),
    row('flow.day.14', 'day', { rank: 14, value: 7, text: 'today' }),
    bar('flow.bar.13.done', 13, 18, 'Done'),
    bar('flow.bar.14.done', 14, 6, 'Done'),
    ...extra,
  ];
}

/** The factory export with the real Phase B2 prpr.prs.* ids (scripts/coordination/factory-rows.mjs:41-42, 325-332). */
function factoryRows(extra: Row[] = []): Row[] {
  return [
    note('factory.today', '2026-11-08'),
    row('factory.day.13', 'day', { rank: 13, text: '2026-11-07' }),
    row('factory.day.14', 'day', { rank: 14, text: '2026-11-08' }),
    note('prpr.summary', 'PR checks: 12 runs in the 7 days to Nov 8.'),
    figure('prpr.week.runs', 12, '12'),
    bar('prpr.prs.landed.bar.13', 13, 1, 'Landed'),
    bar('prpr.prs.landed.bar.14', 14, 3, 'Landed'),
    bar('prpr.prs.opened.bar.14', 14, 4, 'Opened'),
    figure('prpr.prs.landed.week', 9, '9 landed'),
    figure('prpr.prs.landed.today', 3, '3 landed'),
    note('prpr.prs.landed.as_of', 'as of Nov 8'),
    figure('prpr.prs.landed.rows', 9, '9'),
    figure('prpr.prs.landed.bad_lines', 0, '0'),
    note('prpr.prs.opened.note', 'no data since Nov 5'),
    note('prpr.prs.landed.check', 'GitHub agrees'),
    note('rev.note', 'no data since Nov 4'),
    note('rev.coderabbit.note', 'no data since Nov 4'),
    note('rev.summary', '150 review runs in the 7 days to Nov 8.'),
    note('hand.summary', '59 handoffs in the 7 days to Nov 8, 48 succeeded (81.4%).'),
    figure('hand.week.success_pct', 81.4, '81.4%'),
    ...extra,
  ];
}

function writeBoth(flowExtra: Row[] = [], factoryExtra: Row[] = []): void {
  writeLaneDash('flow', { [SQL_KEY]: CANARY, exportedAt: FLOW_EXPORTED_AT, rows: flowRows(flowExtra) });
  writeLaneDash('factory', { [SQL_KEY]: CANARY, exportedAt: FACTORY_EXPORTED_AT, rows: factoryRows(factoryExtra) });
}

test.beforeEach(() => clearLaneDashDir());
test.afterEach(() => clearLaneDashDir());

async function openFlow(page: Page): Promise<void> {
  await page.goto('/?view=flow');
  await expect(page.getByTestId('flow-view')).toBeVisible();
}

const file = (page: Page, name: string) => page.locator(`[data-testid="flow-file"][data-file="${name}"]`);

test.describe('flow tab', () => {
  test('E4.1 the Flow tab is enabled, and ?view=flow survives a reload', async ({ page }) => {
    writeBoth();
    await page.goto('/');
    const tab = page.locator('[data-testid="nav-tab"][data-tab="flow"]');
    await expect(tab).toBeEnabled();
    await expect(tab.getByTestId('nav-tab-tag')).toHaveCount(0);
    await expect(page.getByTestId('nav-tab').filter({ hasText: 'Handoffs' })).toHaveCount(0);
    await tab.click();
    await expect(page.getByTestId('flow-view')).toBeVisible();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).searchParams.get('view')).toBe('flow');
    await page.reload();
    await expect(page.getByTestId('flow-view')).toBeVisible();
    await expect(page.getByTestId('flow-loading')).toHaveCount(0);
    await expect(page.locator('[data-testid="nav-tab"][data-tab="flow"]')).toHaveAttribute('aria-current', 'page');
    // The tiles stay above every view.
    await expect(page.getByTestId('stat-tiles')).toBeVisible();
  });

  test('E4.2 real prpr.prs rows show as given; no placeholder text; the day join is right', async ({ page }) => {
    writeBoth();
    await openFlow(page);
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/placeholder/i);
    expect(body).not.toContain('Phase B2');
    expect(body).not.toContain('no writer yet');

    const factory = file(page, 'factory');
    const rowOf = (id: string) => factory.locator(`[data-testid="flow-row"][data-id="${id}"]`);
    await expect(rowOf('prpr.prs.landed.check')).toContainText('GitHub agrees');
    await expect(rowOf('prpr.prs.opened.note')).toContainText('no data since Nov 5');
    await expect(rowOf('prpr.prs.landed.week')).toContainText('9 landed');
    await expect(rowOf('rev.note')).toContainText('no data since Nov 4');
    await expect(rowOf('rev.coderabbit.note')).toContainText('no data since Nov 4');

    // Cards by id prefix, each with its summary on top.
    await expect(factory.locator('[data-testid="flow-card"]')).toHaveCount(3);
    await expect(factory.locator('[data-testid="flow-card"][data-prefix="factory"]')).toHaveCount(0);
    await expect(factory.locator('[data-testid="flow-card"][data-prefix="prpr"] [data-testid="flow-summary"]')).toContainText(
      'PR checks: 12 runs',
    );
    await expect(file(page, 'flow').locator('[data-testid="flow-card"][data-prefix="flow"] [data-testid="flow-summary"]')).toContainText(
      '147 lanes were claimed',
    );

    // Day join: rank 14 is the export's own Chicago day; rank r is that day minus (14 - r).
    const landed = factory.locator('[data-testid="flow-series"][data-key="prpr.prs.landed.bar"]');
    await expect(landed.locator('[data-testid="flow-bar"][data-rank="14"]')).toHaveAttribute('data-label', 'Nov 8');
    await expect(landed.locator('[data-testid="flow-bar"][data-rank="14"]')).toHaveAttribute('data-value', '3');
    await expect(landed.locator('[data-testid="flow-bar"][data-rank="13"]')).toHaveAttribute('data-label', 'Nov 7');
    const done = file(page, 'flow').locator('[data-testid="flow-series"][data-key="flow.bar.done"]');
    await expect(done.locator('[data-testid="flow-bar"][data-rank="14"]')).toHaveAttribute('data-label', 'Nov 9');
    // Rank order.
    expect(await landed.locator('[data-testid="flow-bar"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rank')))).toEqual([
      '13',
      '14',
    ]);
  });

  test('E4.3 the header shows each file time in the Chicago zone', async ({ page }) => {
    writeBoth();
    await openFlow(page);
    await expect(file(page, 'flow').getByTestId('flow-exported')).toHaveText('flow exported 12:30 CST');
    await expect(file(page, 'factory').getByTestId('flow-exported')).toHaveText('factory exported 23:55 CST');
  });

  test('E4.4 tone maps to the warn and bad colours; a figure with no tone has none', async ({ page }) => {
    writeBoth();
    await openFlow(page);
    const flow = file(page, 'flow');
    const rowOf = (id: string) => flow.locator(`[data-testid="flow-row"][data-id="${id}"]`);
    await expect(rowOf('flow.week.rework.pct')).toHaveAttribute('data-tone', 'warn');
    await expect(rowOf('flow.week.rework.pct').getByTestId('flow-row-value')).toHaveClass(/text-warn/);
    await expect(rowOf('flow.today.reopened')).toHaveAttribute('data-tone', 'bad');
    await expect(rowOf('flow.today.reopened').getByTestId('flow-row-value')).toHaveClass(/text-bad/);
    await expect(rowOf('flow.week.claimed')).not.toHaveAttribute('data-tone', /.+/);
  });

  test('E4.5 no flow.json: "Flow export not found." for it, and the factory cards still show', async ({ page }) => {
    writeLaneDash('factory', { exportedAt: FACTORY_EXPORTED_AT, rows: factoryRows() });
    await openFlow(page);
    await expect(file(page, 'flow')).toContainText('Flow export not found.');
    await expect(file(page, 'factory')).not.toContainText('Flow export not found.');
    await expect(file(page, 'factory').locator('[data-testid="flow-card"]')).toHaveCount(3);
  });

  test('E4.6 a file that is not valid JSON, or has no rows array, reads as not found', async ({ page }) => {
    writeLaneDashRaw('flow.json', '{ this is not json');
    writeLaneDash('factory', { exportedAt: FACTORY_EXPORTED_AT, rows: 'nope' });
    await openFlow(page);
    await expect(file(page, 'flow')).toContainText('Flow export not found.');
    await expect(file(page, 'factory')).toContainText('Flow export not found.');
  });

  test('E4.7 a row with value "3" (a string) is skipped and counted; a good row beside it shows', async ({ page }) => {
    writeBoth([row('flow.bad.value', 'figure', { value: '3', text: 'three' })]);
    await openFlow(page);
    const flow = file(page, 'flow');
    await expect(flow.getByTestId('flow-skipped')).toHaveText('1 row skipped');
    await expect(flow.locator('[data-testid="flow-row"][data-id="flow.bad.value"]')).toHaveCount(0);
    await expect(flow.locator('[data-testid="flow-row"][data-id="flow.week.claimed"]')).toBeVisible();
    // No skipped rows: no grey line.
    await expect(file(page, 'factory').getByTestId('flow-skipped')).toHaveCount(0);
  });

  test('E4.7b a duplicate row id shows both rows and gives no React duplicate-key warning', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (/same key|unique "key"/i.test(m.text())) warnings.push(m.text());
    });
    writeBoth([
      row('flow.dup.row', 'figure', { value: 1, text: 'one' }),
      row('flow.dup.row', 'figure', { value: 2, text: 'two' }),
      row('flow.bar.3.dupe', 'bar', { rank: 3, value: 1, text: 'a' }),
      row('flow.bar.3.dupe', 'bar', { rank: 3, value: 2, text: 'b' }),
    ]);
    await openFlow(page);
    await expect(file(page, 'flow').locator('[data-testid="flow-row"][data-id="flow.dup.row"]')).toHaveCount(2);
    await expect(file(page, 'flow').locator('[data-testid="flow-bar"][data-rank="3"]')).toHaveCount(2);
    expect(warnings).toEqual([]);
  });

  test('E4.8 the app never writes to the lane-dash dir: names and mtimes are unchanged after loads', async ({ page }) => {
    writeBoth();
    const snapshot = () =>
      readdirSync(LANE_DASH_DIR)
        .sort()
        .map((name) => `${name}:${statSync(join(LANE_DASH_DIR, name)).mtimeMs}`);
    const before = snapshot();
    expect(before.length).toBe(2);
    await openFlow(page);
    await page.reload();
    await expect(page.getByTestId('flow-view')).toBeVisible();
    await page.request.get('/api/mission-control?view=flow');
    expect(snapshot()).toEqual(before);
  });

  test('E4.9 the SQL text of the export never reaches the API or the page', async ({ page, request }) => {
    writeBoth();
    const flowBody = await (await request.get('/api/mission-control?view=flow')).text();
    expect(flowBody).not.toContain(CANARY);
    expect(flowBody).not.toContain(`"${SQL_KEY}"`);
    const flowJson = JSON.parse(flowBody) as { flow: { files: { name: string; status: string }[] } | null };
    expect(flowJson.flow?.files.map((f) => `${f.name}:${f.status}`)).toEqual(['flow:ok', 'factory:ok']);
    // The poll stays small: every other view carries no flow data.
    const plain = JSON.parse(await (await request.get('/api/mission-control')).text()) as { flow: unknown };
    expect(plain.flow).toBeNull();
    const spend = JSON.parse(await (await request.get('/api/mission-control?view=spend')).text()) as { flow: unknown };
    expect(spend.flow).toBeNull();
    await openFlow(page);
    expect(await page.content()).not.toContain(CANARY);
  });

  test('E4.10 text with a secret is redacted before it shows', async ({ page }) => {
    const key = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
    writeBoth([note('flow.leak', `token ${key} end`)]);
    await openFlow(page);
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(key);
    await expect(file(page, 'flow').locator('[data-testid="flow-row"][data-id="flow.leak"]')).toBeVisible();
  });

  test('E4.12 a 220-character summary and a 220-character row text show in full', async ({ page }) => {
    const summary = `Summary start ${'word '.repeat(40)}SUMMARY-END`;
    const rowText = `Row start ${'part '.repeat(40)}ROW-END`;
    expect(summary.length).toBeGreaterThan(200);
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(rowText.length).toBeGreaterThan(200);
    expect(rowText.length).toBeLessThanOrEqual(240);
    writeLaneDash('flow', {
      exportedAt: FLOW_EXPORTED_AT,
      rows: [note('flow.summary', summary), note('flow.long', rowText)],
    });
    await openFlow(page);
    const card = file(page, 'flow').locator('[data-testid="flow-card"][data-prefix="flow"]');
    await expect(card.getByTestId('flow-summary')).toContainText('SUMMARY-END');
    await expect(card.locator('[data-testid="flow-row"][data-id="flow.long"]')).toContainText('ROW-END');
  });

  test('E4.11 phone: no horizontal scroll, even with long ids and long text', async ({ page }) => {
    const long = 'w'.repeat(150);
    writeBoth(
      [note(`flow.${'seg'.repeat(30)}.long`, long), figure(`flow.week.${'q'.repeat(90)}`, 1, long)],
      [bar(`prpr.${'p'.repeat(60)}.bar.14.${'r'.repeat(40)}`, 14, 123456789, long)],
    );
    await openFlow(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document is wider than the viewport').toBeLessThanOrEqual(0);
  });
});
