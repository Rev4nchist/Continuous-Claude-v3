import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  agentRun,
  ask,
  cacheState,
  clearStateDir,
  findQuietSessionId,
  makeBrief,
  SESSION_ID_FORMAT,
  writeState,
  type FixturePlanStep,
} from './state-fixture';

/**
 * End-to-end check for the Fleet page LAYOUT (build map 5.2: L1-L5, P1 and the tile order).
 * The mockup is .claudedocs/fleet-mockup/Fleet.dc.html, board 3 "Fleet Browser".
 *
 * It runs in both Playwright projects. Desktop cases pin a 1440 x 1000 viewport and skip on the
 * `phone` project. Phone cases use the project's 390 x 844 viewport and skip on `chromium`.
 * Cases that hold at every width run in both.
 *
 * READ-ONLY toward the app: the specs only GET and load pages. Their only writes are fixture
 * state files in the private E2E state dir (see fleet.spec.ts). Like fleet.spec.ts, they borrow
 * a REAL live session from GET /api/mission-control, because the app role cannot insert
 * public.sessions rows. With no live session the cases FAIL with a message that says so.
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

const DESKTOP = { width: 1440, height: 1000 };
const LIVE_UNDER_SECONDS = 900;

type Snapshot = { active: { sessions: { id: string; liveSecondsAgo: number }[] } };

const PLAN: FixturePlanStep[] = [
  { id: 'p1', text: 'E2E layout step one', status: 'done' },
  { id: 'p2', text: 'E2E layout step two', status: 'doing' },
  { id: 'p3', text: 'E2E layout step three', status: 'todo' },
];

/** The id of a live session (a sign of life under 15 minutes ago). Fails if none. */
async function liveId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  const snapshot = (await response.json()) as Snapshot;
  const live = snapshot.active.sessions.find((s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS);
  expect(
    live,
    `Precondition: the database needs a live session (liveSecondsAgo < ${LIVE_UNDER_SECONDS}). ` +
      'Open a Claude Code session and run again.',
  ).toBeDefined();
  return (live as { id: string }).id;
}

/** Give the borrowed live session a brief with a title, a plan and asks (long enough to fill a card). */
function writeFixture(id: string): void {
  writeState(id, {
    chip: 'waiting-on-dave',
    repo: 'e2e-layout-repo',
    branch: 'e2e/layout-fixture-branch',
    ctx: 42,
    brief: makeBrief({
      title: 'E2E layout fixture title',
      goal: 'E2E layout fixture goal',
      plan: PLAN,
      ask: [
        ask('E2E layout first ask https://example.com/a/very/long/path/that/must/stay/intact/in/the/row'),
        ask('E2E layout second ask'),
      ],
    }),
  });
}

/**
 * The longest T3 and T4 text: engine cost, a resumed session, a second live session with no hud
 * ("no data"), subagent runs with an advised floor and an unpriced run, quota 100, a haiku break.
 * Returns whether a second live UUID-shaped session was there to carry the "no data" line.
 */
async function writeCostFixture(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  const snapshot = (await response.json()) as Snapshot;
  const ids = snapshot.active.sessions
    .filter((s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id))
    .map((s) => s.id);
  expect(ids.length, 'Precondition: the database needs a live session with a UUID-shaped id.').toBeGreaterThanOrEqual(1);
  writeState(ids[0], {
    chip: 'waiting-on-dave',
    hud: { costUsd: 1234.5678, limits: [{ kind: 'seven_day', percentUsed: 100 }] },
    cache: cacheState({ resumed: true }),
    agentRuns: [
      agentRun('r1', { costUsd: 987.65, advised: 3, effort: 'medium' }),
      agentRun('r2', { hasUnknownModelCost: true, model: 'claude-haiku-4-5', drift: 'Haiku is banned' }),
    ],
  });
  if (ids.length >= 2) writeState(ids[1], {});
  return ids.length >= 2;
}

/** The three T3 lines are all on screen: the fixture is the worst case, so a missing line proves nothing. */
async function expectLongestTiles(page: Page, withNoData: boolean): Promise<void> {
  const t3 = page.getByTestId('stat-tile').nth(2);
  await expect(t3).toContainText('at least est $1234.57 all sessions');
  await expect(t3).toContainText('since resume');
  await expect(t3).toContainText('of which subagents at least est $987.65 + 1 unpriced');
  if (withNoData) await expect(t3).toContainText('1 no data');
  else test.info().annotations.push({ type: 'note', description: 'only one live session: the "no data" line was not drawn' });
}

/** Wait until React has hydrated: the poll hook has fetched once and the age button shows. */
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
    timeout: 15_000,
  });
}

/** The project cards: articles that hold an h3 (the session detail is an article too, with an h2). */
const projectCards = (page: Page): Locator => page.locator('article').filter({ has: page.locator('h3') });

/** How many distinct left edges the project cards have: the number of columns of the grid. */
async function projectColumns(page: Page): Promise<{ columns: number; cards: number }> {
  const lefts = await projectCards(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  return { columns: new Set(lefts).size, cards: lefts.length };
}

const refreshButton = (page: Page): Locator =>
  page.getByRole('button', { name: /updated \d+s ago/ });

const h2 = (page: Page, name: RegExp): Locator => page.getByRole('heading', { level: 2, name });

async function box(locator: Locator, what: string) {
  const found = await locator.boundingBox();
  expect(found, `${what} must be rendered`).not.toBeNull();
  return found as NonNullable<typeof found>;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// --- Cases that hold at every width ---------------------------------------------------------------

test.describe('layout at every width', () => {
  test('the h1 "Agentic OS" stays for screen readers but is not drawn (sr-only)', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);

    const h1 = page.getByRole('heading', { level: 1, name: 'Agentic OS' });
    await expect(h1).toHaveCount(1);
    // sr-only: taken out of the flow, 1 x 1 px, clipped. A drawn title would be wider than 1 px.
    const drawn = await h1.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { position: style.position, width: rect.width, height: rect.height };
    });
    expect(drawn.position).toBe('absolute');
    expect(drawn.width).toBeLessThanOrEqual(1);
    expect(drawn.height).toBeLessThanOrEqual(1);
  });

  test('the six stat tiles are in the E2 order, and a phone shows the first four', async ({ page }, testInfo) => {
    await page.goto('/');
    await waitForHydration(page);

    const tiles = page.getByTestId('stat-tile');
    await expect(tiles).toHaveCount(6);
    // The DOM holds six nodes in both projects; Active lanes and Open PRs are `hidden sm:block`.
    await expect(page.locator('[data-testid="stat-tile"]:visible')).toHaveCount(
      testInfo.project.name === 'phone' ? 4 : 6,
    );
    // Each tile is a label line and a value line. Compare the label line only.
    const labels = await tiles.evaluateAll((els) =>
      els.map((el) => el.firstElementChild?.textContent?.trim() ?? ''),
    );
    expect(labels).toEqual(['Live', 'Needs Dave', 'Quota and spend', 'Rule breaks', 'Active lanes', 'Open PRs']);
  });

  test('the left column reads Projects, then Live sessions, then Unmatched sessions', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    const projects = await box(h2(page, /^Projects/), 'the Projects header');
    const live = await box(h2(page, /^Live sessions/), 'the Live sessions header');
    const unmatched = await box(h2(page, /^Unmatched sessions/), 'the Unmatched sessions header');
    expect(projects.y, 'Projects above Live sessions').toBeLessThan(live.y);
    expect(live.y, 'Live sessions above Unmatched sessions').toBeLessThan(unmatched.y);
    // One column: the three panels start at the same left edge.
    expect(Math.abs(projects.x - live.x)).toBeLessThan(2);
    expect(Math.abs(live.x - unmatched.x)).toBeLessThan(2);
  });

  test('pressing the Ready item of the open session moves focus into the detail', async ({
    page,
    request,
  }) => {
    const id = await liveId(request);
    writeFixture(id);
    await page.goto(`/?session=${id}`);
    await waitForHydration(page);

    const detail = page.getByTestId('session-detail');
    await expect(detail).toBeVisible();
    const hasFocus = () => detail.evaluate((el) => el.contains(document.activeElement));
    // A load with ?session= does not move focus. Without this line a focus-on-load change
    // would make the test pass for the wrong reason.
    expect(await hasFocus()).toBe(false);

    // The session is already selected, so the selection state does not change.
    await page
      .locator(`[data-testid="ready-item"][data-session-id="${id}"]`)
      .getByRole('button')
      .click();
    await expect.poll(hasFocus).toBe(true);
  });

  test('the mono face is applied to the page and the JetBrains Mono file is loaded', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);
    await page.evaluate(() => document.fonts.ready);

    // The page text uses the next/font family first (its generated name contains "JetBrains").
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family, 'body font-family must start with the JetBrains Mono face').toMatch(
      /^"?[^,]*JetBrains/i,
    );
    // The real file was fetched and decoded, not only the fallback metrics face.
    const loaded = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    );
    expect(
      loaded.some((name) => /JetBrains/i.test(name) && !/fallback/i.test(name)),
      `a loaded JetBrains Mono face is needed; loaded: ${loaded.join(', ') || 'none'}`,
    ).toBe(true);
  });
});

test.describe('font stack', () => {
  test('the mono stack still applies when the next/font variable is missing', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    // Drop the class that defines --font-jetbrains and keep `dark` (it defines --font-terminal).
    // A var() with no fallback would make the whole declaration invalid and the page would fall back to serif.
    const family = await page.evaluate(() => {
      document.documentElement.className = 'dark';
      return getComputedStyle(document.body).fontFamily;
    });
    expect(family).toMatch(/JetBrains Mono|monospace/i);
  });
});

// --- The clock reads local time after mount -------------------------------------------------------

test.describe('data-as-of clock', () => {
  // America/Chicago is UTC-5 or UTC-6 on every date, never UTC, so a UTC clock cannot pass.
  test.use({ timezoneId: 'America/Chicago' });

  test('shows the local time of the server read after mount, not a UTC time ending in Z', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);

    const clock = page.getByText(/data as of /);
    await expect(clock).toBeVisible();
    // After mount the Z suffix of the server render is gone.
    await expect(clock).toHaveText(/data as of \d{2}:\d{2}:\d{2}$/);
    const shown = /data as of (\d{2}):(\d{2}):(\d{2})$/.exec((await clock.textContent()) ?? '');
    expect(shown, 'the clock must read HH:MM:SS').not.toBeNull();
    const [, hh, mm, ss] = shown as RegExpExecArray;
    const shownSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);

    // The same moment in Chicago, read by Node. The server read is at most a poll old (5 s) plus
    // the test's own delay, so 60 s is generous and still far from the 5 to 6 hour UTC gap.
    const chicago = new Date().toLocaleTimeString('en-GB', {
      timeZone: 'America/Chicago',
      hourCycle: 'h23',
    });
    const [ch, cm, cs] = chicago.split(':').map(Number);
    const diff = Math.abs(shownSeconds - (ch * 3600 + cm * 60 + cs));
    const wrapped = Math.min(diff, 86_400 - diff);
    expect(wrapped, `clock ${hh}:${mm}:${ss} against Chicago ${chicago}`).toBeLessThan(60);
  });
});

// --- 1440: the desktop layout ---------------------------------------------------------------------

test.describe('layout at 1440 px', () => {
  test.use({ viewport: DESKTOP });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'desktop layout: the phone project has its own cases');
  });

  test('the nav tabs and the refresh button share one row (a single top strip)', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);

    const nav = await box(page.getByTestId('nav-tabs'), 'the nav tabs');
    const refresh = await box(refreshButton(page), 'the refresh button');
    expect(Math.abs(nav.y - refresh.y), `nav top ${nav.y}, refresh top ${refresh.y}`).toBeLessThanOrEqual(10);
    // The refresh text is on the right of the tabs, not under them.
    expect(refresh.x).toBeGreaterThan(nav.x + nav.width - 1);
    await expect(page.getByTestId('nav-tab')).toHaveCount(8);
  });

  test('the Pull requests panel sits directly under the session detail (no gap)', async ({
    page,
    request,
  }) => {
    const id = await liveId(request);
    writeFixture(id);
    await page.goto(`/?session=${id}`);
    await waitForHydration(page);

    const detail = await box(page.getByTestId('session-detail'), 'the session detail');
    const prs = await box(page.getByTestId('pr-panel'), 'the Pull requests panel');
    const gap = prs.y - (detail.y + detail.height);
    expect(gap, `PR panel top ${prs.y} minus detail bottom ${detail.y + detail.height}`).toBeGreaterThanOrEqual(0);
    expect(gap, 'the PR panel must follow the detail within one panel gap').toBeLessThan(24);
    // Right column: both panels start right of the left column's Projects panel.
    const projects = await box(h2(page, /^Projects/), 'the Projects header');
    expect(detail.x).toBeGreaterThan(projects.x + projects.width / 2);
    expect(Math.abs(prs.x - detail.x)).toBeLessThan(2);
  });

  test('the Projects grid has four columns (fewer only when the registry has fewer projects)', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const { columns, cards } = await projectColumns(page);
    expect(cards, 'the registry needs at least one project card').toBeGreaterThan(0);
    expect(columns).toBe(Math.min(cards, 4));
  });

  test('Live sessions start in the first screen: the first card begins above the fold', async ({ page, request }) => {
    writeFixture(await liveId(request));
    await page.goto('/');
    await waitForHydration(page);
    const header = await box(h2(page, /^Live sessions/), 'the Live sessions header');
    const card = await box(page.getByTestId('session-card').first(), 'the first session card');
    expect(header.y, 'the Live sessions header is inside the first screen').toBeLessThan(DESKTOP.height);
    expect(card.y + 80, `the first card (top ${card.y}) shows at least 80 px inside ${DESKTOP.height}`).toBeLessThanOrEqual(DESKTOP.height);
  });

  test('the longest cost tiles keep the first Live session card above the fold', async ({ page, request }) => {
    const withNoData = await writeCostFixture(request);
    await page.goto('/');
    await waitForHydration(page);
    await expectLongestTiles(page, withNoData);
    const tiles = await box(page.getByTestId('stat-tiles'), 'the stat tiles');
    const header = await box(h2(page, /^Live sessions/), 'the Live sessions header');
    const card = await box(page.getByTestId('session-card').first(), 'the first session card');
    expect(tiles.y + tiles.height, 'the tile row ends above the Live sessions header').toBeLessThanOrEqual(header.y);
    expect(header.y, 'the Live sessions header is inside the first screen').toBeLessThan(DESKTOP.height);
    expect(card.y + 80, `the first card (top ${card.y}) shows at least 80 px inside ${DESKTOP.height}`).toBeLessThanOrEqual(DESKTOP.height);
    expect(await horizontalOverflow(page), 'overview is wider than the screen').toBeLessThanOrEqual(0);
    // No tile clips its own text.
    const clipped = await page
      .getByTestId('stat-tile')
      .evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).length);
    expect(clipped, 'tiles whose content is cut off').toBe(0);
  });

  test('a project card is name, counts and status, with the rest behind a closed disclosure', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const card = projectCards(page).first();
    const more = card.locator('details');
    await expect(more).toHaveCount(1);
    expect(await more.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(card.getByTestId('project-counts')).toBeVisible();
    await expect(card.getByTestId('project-status')).toBeVisible();
    for (const hidden of ['Last active', 'Path spellings']) {
      await expect(card.getByText(hidden), `"${hidden}" is behind the disclosure`).toBeHidden();
    }
    await more.locator('summary').click();
    await expect(card.getByText('Last active')).toBeVisible();
    await expect(card.getByText('Path spellings')).toBeVisible();
  });

  test('a project key is never cut with an ellipsis', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const overflow = await projectCards(page).evaluateAll((els) =>
      els.flatMap((el) => [...el.querySelectorAll('p')].map((p) => getComputedStyle(p).textOverflow)),
    );
    expect(overflow).not.toContain('ellipsis');
  });

  test('no project name is clipped in the Projects grid', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    const names = page.getByRole('article').getByRole('heading', { level: 3 });
    const count = await names.count();
    expect(count, 'the registry needs at least one project card').toBeGreaterThan(0);
    const clipped = await names.evaluateAll((els) =>
      els
        .map((h3) => {
          const target = h3.querySelector('button') ?? h3;
          return { text: target.textContent ?? '', clipped: target.scrollWidth > target.clientWidth };
        })
        .filter((item) => item.clipped)
        .map((item) => item.text),
    );
    expect(clipped, 'these project names are cut off').toEqual([]);
  });
});

// --- 390: the phone layout ------------------------------------------------------------------------

test.describe('layout at 390 px', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone layout: runs in the phone project only');
  });

  test('a selected session sits above Projects, and the page does not scroll sideways', async ({
    page,
    request,
  }) => {
    const id = await liveId(request);
    writeFixture(id);
    await page.goto(`/?session=${id}`);
    await waitForHydration(page);
    expect(page.viewportSize()?.width).toBe(390);

    const detail = await box(page.getByTestId('session-detail'), 'the session detail');
    const projects = await box(h2(page, /^Projects/), 'the Projects header');
    expect(detail.y, 'on a phone the selected session comes before Projects').toBeLessThan(projects.y);
    expect(await horizontalOverflow(page), 'overview with a detail open is wider than the screen').toBeLessThanOrEqual(0);

    // The same page without a selection must not scroll sideways either.
    await page.goto('/');
    await waitForHydration(page);
    expect(await horizontalOverflow(page), 'overview is wider than the screen').toBeLessThanOrEqual(0);
  });

  test('the longest cost tiles end inside the first screen and do not push the page sideways', async ({ page, request }) => {
    const withNoData = await writeCostFixture(request);
    await page.goto('/');
    await waitForHydration(page);
    await expectLongestTiles(page, withNoData);
    const tiles = await box(page.getByTestId('stat-tiles'), 'the stat tiles');
    const height = page.viewportSize()?.height ?? 844;
    expect(tiles.y + tiles.height, `the tile row (bottom ${tiles.y + tiles.height}) ends inside ${height}`).toBeLessThanOrEqual(height);
    expect(await horizontalOverflow(page), 'overview is wider than the screen').toBeLessThanOrEqual(0);
    const clipped = await page
      .getByTestId('stat-tile')
      .evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).length);
    expect(clipped, 'tiles whose content is cut off').toBe(0);
  });

  test('the Projects grid is one column', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    const { columns, cards } = await projectColumns(page);
    expect(cards).toBeGreaterThan(0);
    expect(columns).toBe(1);
  });

  test('the Ready for Dave header is at most two lines tall, with the longest count text', async ({ page, request }) => {
    const live = await liveId(request);
    const quiet = await findQuietSessionId();
    writeState(live, { brief: makeBrief({ ask: [ask('E2E header live ask')] }) });
    writeState(quiet, { brief: makeBrief({ ask: [ask('E2E header quiet ask')] }) });
    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByTestId('ready-for-dave')).toContainText('from quiet sessions');
    const lines = await page.getByTestId('ready-for-dave').locator('header').evaluate((el) => {
      const style = getComputedStyle(el);
      const inner =
        el.getBoundingClientRect().height -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom) -
        parseFloat(style.borderBottomWidth);
      // The wrap gap between two rows is not a line of text.
      const gap = parseFloat(style.rowGap) || 0;
      return (inner - gap) / parseFloat(style.lineHeight);
    });
    expect(lines, 'header height in lines').toBeLessThanOrEqual(2.1);
  });

  test('choosing a session moves focus into the detail and brings it into view', async ({ page, request }) => {
    const id = await liveId(request);
    writeFixture(id);
    await page.goto('/');
    await waitForHydration(page);
    const card = page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
    await card.getByRole('button').first().click();
    const detail = page.getByTestId('session-detail');
    await expect(detail).toBeVisible();
    await expect
      .poll(() => detail.evaluate((el) => el.contains(document.activeElement)), { message: 'focus is inside the detail' })
      .toBe(true);
    const rect = await box(detail, 'the session detail');
    expect(rect.y, 'the detail top is inside the screen').toBeGreaterThanOrEqual(0);
    expect(rect.y, 'the detail top is inside the screen').toBeLessThan(844);
  });

  test('a poll that turns an unavailable panel into the detail does not move focus', async ({ page, request }) => {
    const id = await liveId(request);
    // No state file yet: the choice opens the "not available" panel, which has no heading.
    await page.goto('/');
    await waitForHydration(page);
    const card = page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
    await card.getByRole('button').first().click();
    await expect(page.getByTestId('detail-unavailable')).toHaveAttribute('data-reason', 'no state file');
    // The state file appears. The next poll (every 5 s) renders the detail with no user action.
    writeFixture(id);
    const detail = page.getByTestId('session-detail');
    await expect(detail).toBeVisible({ timeout: 20_000 });
    // Let the effects of that render run, then check that nothing moved focus into the detail.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.waitForTimeout(500);
    expect(await detail.evaluate((el) => el.contains(document.activeElement)), 'focus moved into the detail on a poll').toBe(false);
  });

  test('the small controls are at least 24 px tall and wide', async ({ page, request }) => {
    const id = await liveId(request);
    writeFixture(id);
    await page.goto(`/?session=${id}`);
    await waitForHydration(page);
    const targets: [string, Locator][] = [
      ['the refresh button', refreshButton(page)],
      ['the ready item name', page.getByTestId('ready-item').first().getByRole('button')],
      ['the detail Close button', page.getByTestId('session-detail').getByRole('button', { name: 'Close' })],
    ];
    for (const [what, target] of targets) {
      const found = await box(target, what);
      expect(found.height, `${what} height`).toBeGreaterThanOrEqual(24);
      expect(found.width, `${what} width`).toBeGreaterThanOrEqual(24);
    }
  });

  test('at 320 px the ready rows and session cards do not push the page sideways', async ({ page, request }) => {
    writeFixture(await liveId(request));
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByTestId('ready-item').first()).toBeVisible();
    await expect(page.getByTestId('session-card').first()).toBeVisible();
    expect(await horizontalOverflow(page), 'overview at 320 px is wider than the screen').toBeLessThanOrEqual(0);
  });
});
