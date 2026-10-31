import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { ask, clearStateDir, makeBrief, writeState, type FixturePlanStep } from './state-fixture';

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

/** Wait until React has hydrated: the poll hook has fetched once and the age button shows. */
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
    timeout: 15_000,
  });
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

  test('the five stat tiles are in the mockup order', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    const tiles = page.getByTestId('stat-tile');
    await expect(tiles).toHaveCount(5);
    // Each tile is a label line and a value line. Compare the label line only.
    const labels = await tiles.evaluateAll((els) =>
      els.map((el) => el.firstElementChild?.textContent?.trim() ?? ''),
    );
    expect(labels).toEqual(['Live sessions', 'Active lanes', 'Blocked', 'Open PRs', 'Needs Dave']);
  });

  test('the left column reads Projects, then Live sessions, then Unmatched sessions', async ({
    page,
    request,
  }) => {
    writeFixture(await liveId(request));
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
});
