import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  clearStateDir,
  findEndedSessionId,
  findQuietSessionId,
  pr,
  SESSION_ID_FORMAT,
  secondsAgo,
  writeState,
  type FixturePr,
} from './state-fixture';

/**
 * End-to-end check for P1b part B2, the PR panel on Overview. Design contract:
 * .claudedocs/2026-10-28-p1b-b2-design.md (section "PR panel").
 *
 * READ-ONLY toward the app: the specs only GET and click. Their only writes are fixture state
 * files in the private E2E state dir, emptied before and after every test. Because the dir is
 * private, only the fixtures decide which PRs exist: the exact rows and counts below are safe.
 *
 * The app role cannot insert public.sessions rows, so the specs borrow REAL live sessions from
 * GET /api/mission-control and write fixture state files for their ids. Cases that need two live
 * sessions run their single-session part and then add a "note" annotation when only one is live.
 * A missing precondition FAILS with a message that says so. Nothing in this file is skipped.
 *
 * UI contract (testids) the implementation must meet:
 *   pr-panel          the panel (a <section>, not an <article>)
 *   pr-header         "Pull requests" left, "watched by live sessions" right
 *   pr-row            one per PR row, attribute data-pr-key="<repo>#<pr>" (a <div> or <li>, not an <article>)
 *   pr-row-number     "#1234"
 *   pr-row-repo       the repo name (text equals the repo from the state file)
 *   pr-row-state      the state chip: the state word, or "unchecked" for null
 *   pr-row-session    one <button> per watching session, text = session name, data-session-id
 *   pr-panel-empty    "No PR is watched by a live session." (only when there is no row)
 *   pr-panel-note     "Only PRs a live session watches. Merged or ready PRs leave the watch."
 *   stat-tile (5th)   "Open PRs" tile, value = number of pr-row (exists already)
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

const LIVE_UNDER_SECONDS = 900;
const NOTE = 'Only PRs a live session watches. Merged or ready PRs leave the watch.';
const EMPTY = 'No PR is watched by a live session.';

// --- Shapes read from /api/mission-control -------------------------------------------------

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
  cards: { id: string; name: string }[];
  tiles: { openPrs: number };
  prs: PrRow[];
  detail: { id: string } | null;
};

// --- Helpers (copied from session-detail.spec.ts, which keeps them file-local) -------------

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/** SSR buttons have no handlers. Always wait for this before a click. */
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
    timeout: 15_000,
  });
}

async function loadSnapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

/** Every live session whose id the app accepts. Fails if there is none. */
async function liveSessions(request: APIRequestContext): Promise<LiveSession[]> {
  const snapshot = await loadSnapshot(request);
  const live = snapshot.active.sessions.filter(
    (s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id),
  );
  expect(
    live.length,
    `Precondition: the database needs a live session (liveSecondsAgo < ${LIVE_UNDER_SECONDS}) ` +
      `whose id matches ${SESSION_ID_FORMAT}. Found ${live.length}. Open a Claude Code session and run again.`,
  ).toBeGreaterThanOrEqual(1);
  return live;
}

/** Two live sessions, or `null` and a visible "note" annotation when only one is live. */
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

function watch(
  id: string,
  prs: FixturePr[],
  repo: string | null = 'e2e-repo',
  extra: { at?: number; branch?: string } = {},
): void {
  writeState(id, { repo, branch: extra.branch ?? `e2e/pr-${id.slice(0, 4)}`, prs, at: extra.at });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const panel = (page: Page): Locator => page.getByTestId('pr-panel');
const rows = (page: Page): Locator => page.getByTestId('pr-row');
const rowByKey = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="pr-row"][data-pr-key="${key}"]`);
const detailPanel = (page: Page): Locator => page.getByTestId('session-detail');
const openPrsTile = (page: Page): Locator => page.getByTestId('stat-tile').nth(4);

const urlParam = (page: Page, key: string): string | null =>
  new URL(page.url()).searchParams.get(key);

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysDeep(inner, into);
    }
  }
  return into;
}

// --- The page, read back as data -------------------------------------------------------------

type DomRow = {
  key: string | null;
  number: string | null;
  repo: string | null;
  state: string | null;
  sessions: { id: string | null; name: string; tag: string }[];
};

async function readRows(page: Page): Promise<DomRow[]> {
  return panel(page).evaluate((root) => {
    const clean = (text: string | null | undefined): string =>
      (text ?? '').replace(/\s+/g, ' ').trim();
    const text = (parent: Element, id: string): string | null => {
      const found = parent.querySelector(`[data-testid="${id}"]`);
      return found === null ? null : clean(found.textContent);
    };
    return Array.from(root.querySelectorAll('[data-testid="pr-row"]')).map((row) => ({
      key: row.getAttribute('data-pr-key'),
      number: text(row, 'pr-row-number'),
      repo: text(row, 'pr-row-repo'),
      state: text(row, 'pr-row-state'),
      sessions: Array.from(row.querySelectorAll('[data-testid="pr-row-session"]')).map((button) => ({
        id: button.getAttribute('data-session-id'),
        name: clean(button.textContent),
        tag: button.tagName,
      })),
    }));
  });
}

function rowProblems(dom: DomRow[], api: PrRow[]): string[] {
  const problems: string[] = [];
  if (dom.length !== api.length) problems.push(`page has ${dom.length} rows, API has ${api.length}`);
  api.forEach((row, index) => {
    const got = dom[index];
    if (!got) return;
    if (got.key !== row.key) problems.push(`row ${index}: key ${got.key} != ${row.key}`);
    if (got.number !== `#${row.pr}`) problems.push(`row ${index}: number "${got.number}" != "#${row.pr}"`);
    if (row.repo !== null && got.repo !== row.repo) problems.push(`row ${index}: repo "${got.repo}" != "${row.repo}"`);
    const wantState = row.state ?? 'unchecked';
    if (got.state !== wantState) problems.push(`row ${index}: state "${got.state}" != "${wantState}"`);
    const gotSessions = got.sessions.map((s) => `${s.id}:${s.name}`);
    const wantSessions = row.sessions.map((s) => `${s.id}:${norm(s.name)}`);
    if (JSON.stringify(gotSessions) !== JSON.stringify(wantSessions)) {
      problems.push(`row ${index}: sessions [${gotSessions.join(',')}] != [${wantSessions.join(',')}]`);
    }
    for (const s of got.sessions) {
      if (s.tag !== 'BUTTON') problems.push(`row ${index}: a session is a <${s.tag}>, not a <button>`);
    }
  });
  return problems;
}

/** Poll until the rows on the page equal the rows of the API, fetched again on every try. */
async function expectPageMatchesApi(page: Page, request: APIRequestContext): Promise<PrRow[]> {
  await expect(panel(page)).toBeVisible();
  await expect
    .poll(
      async () => {
        const problems = rowProblems(await readRows(page), (await loadSnapshot(request)).prs);
        return problems.length === 0 ? 'match' : problems.slice(0, 8).join(' | ');
      },
      { timeout: 20_000, message: 'the PR rows on the page must match GET /api/mission-control' },
    )
    .toBe('match');
  return (await loadSnapshot(request)).prs;
}

/** The expected `name` of a session: the card name the API already shows. */
async function cardName(request: APIRequestContext, id: string): Promise<string> {
  const card = (await loadSnapshot(request)).cards.find((c) => c.id === id);
  expect(card, `cards must hold the live session ${id}`).toBeDefined();
  return (card as { name: string }).name;
}

// --- Spec 9: rows, state chips, session buttons ------------------------------------------------

test.describe('PR rows', () => {
  test('a live session watching #1234 PENDING and #77 REVIEWED gives two rows with a session button each', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = await liveSessions(request);
    watch(live.id, [pr(1234, 'PENDING'), pr(77, 'REVIEWED')]);
    const name = await cardName(request, live.id);

    const snapshot = await loadSnapshot(request);
    expect(snapshot, 'the snapshot must carry a "prs" key').toHaveProperty('prs');
    expect(snapshot.prs).toEqual([
      {
        key: 'e2e-repo#77',
        repo: 'e2e-repo',
        pr: 77,
        state: 'REVIEWED',
        sessions: [{ id: live.id, shortId: live.id.slice(0, 8), name }],
      },
      {
        key: 'e2e-repo#1234',
        repo: 'e2e-repo',
        pr: 1234,
        state: 'PENDING',
        sessions: [{ id: live.id, shortId: live.id.slice(0, 8), name }],
      },
    ]);
    for (const row of snapshot.prs) {
      expect(Object.keys(row).sort(), `row ${row.key} keys`).toEqual(['key', 'pr', 'repo', 'sessions', 'state']);
    }

    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(2);
    const reviewed = rowByKey(page, 'e2e-repo#77');
    const pending = rowByKey(page, 'e2e-repo#1234');
    await expect(reviewed.getByTestId('pr-row-number')).toHaveText('#77');
    await expect(reviewed.getByTestId('pr-row-state')).toHaveText('REVIEWED');
    await expect(reviewed.getByTestId('pr-row-repo')).toHaveText('e2e-repo');
    await expect(pending.getByTestId('pr-row-number')).toHaveText('#1234');
    await expect(pending.getByTestId('pr-row-state')).toHaveText('PENDING');
    for (const row of [reviewed, pending]) {
      const button = row.getByTestId('pr-row-session');
      await expect(button).toHaveCount(1);
      expect(await button.evaluate((el) => el.tagName), 'the session name must be a real <button>').toBe('BUTTON');
      await expect(button).toHaveText(name);
      await expect(button).toHaveAttribute('data-session-id', live.id);
    }
    await expect(panel(page).locator('article')).toHaveCount(0);
    await expect(page.getByTestId('pr-panel-empty')).toHaveCount(0);

    // A click on the session name selects it and keeps the view.
    await expect(detailPanel(page)).toHaveCount(0);
    await pending.getByTestId('pr-row-session').click();
    await expect(detailPanel(page)).toBeVisible();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);
    expect([null, 'overview']).toContain(urlParam(page, 'view'));
    await expect(panel(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an unchecked PR (state null) shows the word unchecked', async ({ page, request }) => {
    const [live] = await liveSessions(request);
    watch(live.id, [pr(4242, null)]);

    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs.map((r) => [r.key, r.state])).toEqual([['e2e-repo#4242', null]]);

    await page.goto('/');
    await waitForHydration(page);
    await expect(rowByKey(page, 'e2e-repo#4242').getByTestId('pr-row-state')).toHaveText('unchecked');
  });

  test('the rows on the page match the API row for row', async ({ page, request }) => {
    const [live] = await liveSessions(request);
    watch(live.id, [pr(900, 'PENDING'), pr(800, 'LIMITED'), pr(700, null)]);
    await page.goto('/');
    await waitForHydration(page);
    const api = await expectPageMatchesApi(page, request);
    expect(api.map((r) => r.pr)).toEqual([800, 900, 700]);
  });
});

// --- Spec 10: grouping across repos and sessions -------------------------------------------------

test.describe('grouping', () => {
  test('the same PR number in two repos is two rows; the same repo and PR in two sessions is one row', async ({
    page,
    request,
  }) => {
    const pair = await twoLiveSessions(request, 'grouping');
    if (pair === null) return;
    const [a, b] = pair;

    // Two repos, same number: two rows, one session each.
    watch(a.id, [pr(77, 'PENDING')], 'e2e-repo-a');
    watch(b.id, [pr(77, 'REVIEWED')], 'e2e-repo-b');
    // The card name holds the branch of the state file, so read it after the fixture is written.
    const nameA = await cardName(request, a.id);
    const nameB = await cardName(request, b.id);
    let api = (await loadSnapshot(request)).prs;
    expect(api.map((r) => [r.key, r.state, r.sessions.map((s) => s.id)])).toEqual([
      ['e2e-repo-b#77', 'REVIEWED', [b.id]],
      ['e2e-repo-a#77', 'PENDING', [a.id]],
    ]);
    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(2);
    await expectPageMatchesApi(page, request);
    await expect(rowByKey(page, 'e2e-repo-a#77').getByTestId('pr-row-session')).toHaveText(nameA);
    await expect(rowByKey(page, 'e2e-repo-b#77').getByTestId('pr-row-session')).toHaveText(nameB);
    await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*2$/);

    // Same repo, same number: one row that lists both sessions.
    watch(a.id, [pr(77, 'PENDING')], 'e2e-repo-a');
    watch(b.id, [pr(77, 'PENDING')], 'e2e-repo-a');
    api = (await loadSnapshot(request)).prs;
    expect(api).toHaveLength(1);
    expect(api[0].key).toBe('e2e-repo-a#77');
    expect(api[0].sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(1);
    const buttons = rowByKey(page, 'e2e-repo-a#77').getByTestId('pr-row-session');
    await expect(buttons).toHaveCount(2);
    const shownIds = await buttons.evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')));
    expect([...shownIds].sort()).toEqual([a.id, b.id].sort());
    await expectPageMatchesApi(page, request);
    await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*1$/);

    // Each button selects its own session.
    await buttons.nth(shownIds.indexOf(b.id)).click();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', b.id);
    await expect.poll(() => urlParam(page, 'session')).toBe(b.id);
  });

  test('when sessions disagree on the state, the most recently written state file wins', async ({
    request,
  }) => {
    const pair = await twoLiveSessions(request, 'state disagreement');
    if (pair === null) return;
    const [a, b] = pair;

    for (const [older, newer] of [[a, b], [b, a]] as const) {
      watch(older.id, [pr(88, 'PENDING')], 'e2e-repo-a', { at: secondsAgo(60) });
      await pause(60);
      watch(newer.id, [pr(88, 'REVIEWED')], 'e2e-repo-a', { at: secondsAgo(1) });
      const api = (await loadSnapshot(request)).prs;
      expect(api, `newer file ${newer.id.slice(0, 4)} says REVIEWED`).toHaveLength(1);
      expect(api[0].state).toBe('REVIEWED');
      expect(api[0].sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

      clearStateDir();
      watch(older.id, [pr(88, 'REVIEWED')], 'e2e-repo-a', { at: secondsAgo(60) });
      await pause(60);
      watch(newer.id, [pr(88, 'PENDING')], 'e2e-repo-a', { at: secondsAgo(1) });
      const flipped = (await loadSnapshot(request)).prs;
      expect(flipped, `newer file ${newer.id.slice(0, 4)} says PENDING`).toHaveLength(1);
      expect(flipped[0].state).toBe('PENDING');
      clearStateDir();
    }
  });
});

// --- Spec 11: order and caps --------------------------------------------------------------------

test.describe('order and caps', () => {
  test('LIMITED, REVIEWED, PROOF, STALLED first, then PENDING, then unchecked; PR number descending in each group', async ({
    page,
    request,
  }) => {
    const [live] = await liveSessions(request);
    watch(live.id, [
      pr(5, 'STALLED'),
      pr(10, 'PENDING'),
      pr(50, null),
      pr(20, 'REVIEWED'),
      pr(40, 'PENDING'),
      pr(30, 'LIMITED'),
      pr(25, 'PROOF'),
    ]);

    const api = (await loadSnapshot(request)).prs;
    expect(api.map((r) => r.pr)).toEqual([30, 25, 20, 5, 40, 10, 50]);
    expect(api.map((r) => r.state)).toEqual([
      'LIMITED',
      'PROOF',
      'REVIEWED',
      'STALLED',
      'PENDING',
      'PENDING',
      null,
    ]);

    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(7);
    expect(await page.getByTestId('pr-row-number').allInnerTexts()).toEqual([
      '#30',
      '#25',
      '#20',
      '#5',
      '#40',
      '#10',
      '#50',
    ]);
    await expect(page.getByTestId('pr-row-state')).toHaveText([
      'LIMITED',
      'PROOF',
      'REVIEWED',
      'STALLED',
      'PENDING',
      'PENDING',
      'unchecked',
    ]);
  });

  test('READY and CLOSED never show as rows and are not counted open', async ({ page, request }) => {
    const [live] = await liveSessions(request);
    watch(live.id, [pr(61, 'READY'), pr(62, 'CLOSED'), pr(63, 'PENDING')]);

    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs.map((r) => r.pr)).toEqual([63]);
    expect(snapshot.tiles.openPrs).toBe(1);

    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rowByKey(page, 'e2e-repo#63')).toBeVisible();
    await expect(rowByKey(page, 'e2e-repo#61')).toHaveCount(0);
    await expect(rowByKey(page, 'e2e-repo#62')).toHaveCount(0);
    await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*1$/);
  });

  test('at most 20 rows, the first 20 in sort order', async ({ page, request }) => {
    const [live] = await liveSessions(request);
    const many = Array.from({ length: 25 }, (_, index) => pr(101 + index, 'PENDING'));
    watch(live.id, many);

    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs).toHaveLength(20);
    expect(snapshot.prs.map((r) => r.pr)).toEqual(Array.from({ length: 20 }, (_, index) => 125 - index));
    expect(snapshot.tiles.openPrs, 'the tile counts the rows').toBe(20);

    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(20);
    await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*20$/);
  });
});

// --- Spec 12: the tile -------------------------------------------------------------------------

test.describe('Open PRs tile', () => {
  test('tiles.openPrs equals the number of rows, in the API and on the page', async ({ page, request }) => {
    const live = await liveSessions(request);
    watch(live[0].id, [pr(300, 'PENDING'), pr(200, 'REVIEWED'), pr(100, null)], 'e2e-repo-a');
    if (live.length >= 2) {
      // The same number in a second repo counts again: this is the cross-repo count fix.
      watch(live[1].id, [pr(300, 'PENDING')], 'e2e-repo-b');
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'Only 1 live session: the cross-repo count (same PR number, two repos) was NOT run.',
      });
    }
    const expected = live.length >= 2 ? 4 : 3;

    const snapshot = await loadSnapshot(request);
    expect(snapshot.prs).toHaveLength(expected);
    expect(snapshot.tiles.openPrs).toBe(snapshot.prs.length);
    expect(snapshot.tiles.openPrs).toBe(expected);

    await page.goto('/');
    await waitForHydration(page);
    await expect(rows(page)).toHaveCount(expected);
    await expect(openPrsTile(page)).toHaveText(new RegExp(`^Open PRs\\s*${expected}$`));
  });
});

// --- Spec 13: empty state -----------------------------------------------------------------------

test.describe('empty state', () => {
  test('no state file with a PR: the panel says so, there are no rows and the tile is 0', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = await liveSessions(request);
    // A live session with a state file but no PR is still an empty panel.
    watch(live.id, []);

    const snapshot = await loadSnapshot(request);
    expect(snapshot, 'the snapshot must carry a "prs" key').toHaveProperty('prs');
    expect(snapshot.prs).toEqual([]);
    expect(snapshot.tiles.openPrs).toBe(0);

    await page.goto('/');
    await waitForHydration(page);
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId('pr-panel-empty')).toHaveText(EMPTY);
    await expect(rows(page)).toHaveCount(0);
    await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*0$/);
    expect(errors).toEqual([]);
  });
});

// --- Spec 14: only LIVE sessions -------------------------------------------------------------------

test.describe('only live sessions', () => {
  const OTHERS: { kind: string; find: () => Promise<string> }[] = [
    { kind: 'quiet', find: () => findQuietSessionId({ validFormat: true }) },
    { kind: 'ended', find: () => findEndedSessionId({ validFormat: true }) },
  ];

  for (const { kind, find } of OTHERS) {
    test(`the PRs of a ${kind} session never appear; a live session's PR does`, async ({ page, request }) => {
      const [live] = await liveSessions(request);
      const other = await find();
      expect(other).not.toBe(live.id);
      watch(live.id, [pr(1234, 'PENDING')], 'e2e-repo-live');
      watch(other, [pr(999, 'LIMITED'), pr(1234, 'REVIEWED')], 'e2e-repo-other');

      const snapshot = await loadSnapshot(request);
      // Control: the live PR is there, so an empty panel is not what hides the other one.
      expect(snapshot.prs.map((r) => r.key)).toEqual(['e2e-repo-live#1234']);
      expect(snapshot.prs[0].sessions.map((s) => s.id)).toEqual([live.id]);
      expect(snapshot.tiles.openPrs).toBe(1);

      await page.goto('/');
      await waitForHydration(page);
      await expect(rows(page)).toHaveCount(1);
      await expect(rowByKey(page, 'e2e-repo-live#1234')).toBeVisible();
      await expect(rowByKey(page, 'e2e-repo-other#999')).toHaveCount(0);
      await expect(rowByKey(page, 'e2e-repo-other#1234')).toHaveCount(0);
      await expect(panel(page)).not.toContainText('e2e-repo-other');
      await expect(panel(page)).not.toContainText('LIMITED');
      await expect(openPrsTile(page)).toHaveText(/^Open PRs\s*1$/);
    });
  }
});

// --- Spec 15: nothing private -------------------------------------------------------------------

test.describe('nothing private reaches the PR panel', () => {
  test('a path and a token in a PR state reach neither the page nor the JSON', async ({ page, request }) => {
    const [live] = await liveSessions(request);
    const tag = randomUUID().slice(0, 8);
    // Built at run time: a literal token in this file is a NEW secret finding for the Trivy ratchet.
    const token = ['ghp', '_'].join('') + 'A'.repeat(36);
    const key = ['sk', '-'].join('') + 'Zq8Lm2Xv9Kp4Rt6Wy1Bn3Hc5Jd7Fg0';
    const hostile = {
      pr: 4321,
      state: `C:\\Users\\prs${tag}\\x ${token} ${key}`,
      whenReady: false,
    } as unknown as FixturePr;
    watch(live.id, [hostile, pr(4322, 'PENDING')]);

    const json = await (await request.get('/api/mission-control')).text();
    await page.goto('/');
    await waitForHydration(page);
    // Present first: every check below is vacuous if the row never renders.
    await expect(page.getByTestId('pr-row-number').filter({ hasText: '#4321' })).toHaveCount(1);
    await expect(rows(page)).toHaveCount(2);

    const text = await page.locator('body').innerText();
    const html = await page.content();
    const raw = await (await request.get('/')).text();
    const bodies = { 'page text': text, 'page HTML': html, 'server HTML': raw, JSON: json };
    for (const [where, body] of Object.entries(bodies)) {
      for (const leak of [`prs${tag}`, token.slice(0, 8), 'AAAAAAAAAAAA', key.slice(0, 8), 'Zq8Lm2Xv9Kp4']) {
        expect(body, `${where} leaks "${leak}"`).not.toContain(leak);
      }
      expect(body, `${where} leaks a Windows home path`).not.toMatch(/C:\\+Users/i);
    }
    const apiRow = (JSON.parse(json) as Snapshot).prs.find((r) => r.pr === 4321);
    expect(apiRow, 'the hostile row must still be listed').toBeDefined();
    expect([...keysDeep(apiRow)].sort()).toEqual(
      ['id', 'key', 'name', 'pr', 'repo', 'sessions', 'shortId', 'state'].sort(),
    );
  });
});

// --- Spec 16: header, note, place -------------------------------------------------------------------

test.describe('panel chrome', () => {
  test('header, honest note and place: after the detail panel, before Data sources', async ({
    page,
    request,
  }) => {
    const [live] = await liveSessions(request);
    watch(live.id, [pr(1234, 'PENDING')]);

    await page.goto(`/?session=${live.id}`);
    await waitForHydration(page);
    await expect(detailPanel(page)).toBeVisible();
    await expect(panel(page)).toBeVisible();

    const header = page.getByTestId('pr-header');
    await expect(header).toContainText('Pull requests');
    await expect(header).toContainText('watched by live sessions');
    await expect(page.getByTestId('pr-panel-note')).toHaveText(NOTE);
    await expect(page.getByTestId('pr-panel-note')).toContainText('Only PRs a live session watches.');

    const detailBox = await detailPanel(page).boundingBox();
    const prBox = await panel(page).boundingBox();
    const sourcesBox = await page.getByTestId('source-health').boundingBox();
    expect(detailBox && prBox && sourcesBox, 'detail, PR panel and sources must all be rendered').toBeTruthy();
    expect(detailBox!.y, 'the PR panel sits below the detail panel').toBeLessThan(prBox!.y);
    expect(prBox!.y, 'the PR panel sits above Data sources').toBeLessThan(sourcesBox!.y);
  });

  test('the note is also present when there is no row', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByTestId('pr-panel-empty')).toHaveText(EMPTY);
    await expect(page.getByTestId('pr-panel-note')).toContainText('Only PRs a live session watches.');
  });
});
