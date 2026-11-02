import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  ask,
  clearStateDir,
  findEndedSessionId,
  makeBrief,
  secondsAgo,
  writeRaw,
  writeState,
  type FixturePlanStep,
} from './state-fixture';

/**
 * End-to-end check for P1b PR A: Ready for Dave, session cards, stat tiles, data-source
 * health, and the project-card filter. Design contract: .claudedocs/2026-10-28-p1b-a-design.md.
 *
 * READ-ONLY toward the app: the specs only GET and click. Their only writes are fixture
 * state files in the private E2E state dir (playwright.config.ts E2E_STATE_DIR, the same
 * path the E2E server gets as AGENTIC_OS_STATE_DIR). The dir is emptied before and after
 * every test, also on failure, so exact counts like "no session row 1" hold.
 *
 * The app role cannot insert public.sessions rows, so the specs borrow REAL live sessions
 * from GET /api/mission-control and write fixture state files for their ids. If the
 * database has no live session (under 15 minutes of sign of life) these tests FAIL with a
 * message that says so. That is a missing precondition, not a pass.
 */

const LIVE_UNDER_SECONDS = 900;
const HOUR = 3600;

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

// --- Shapes read from /api/mission-control (the contract in the design file) ---------------

type LiveSession = {
  id: string;
  shortId: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  liveSecondsAgo: number;
};

type Card = {
  id: string;
  shortId: string;
  name: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  chip: string | null;
  title: string | null;
  branch: string | null;
  repo: string | null;
  hasBrief: boolean;
  planDone: number;
  planTotal: number;
  askOpen: number;
  askStale: number;
  unproven: number;
  ctxPct: number | null;
  liveColour: 'green' | 'amber';
};

type ReadyItem = {
  sessionId: string;
  shortId: string;
  name: string;
  kind: string;
  text: string;
  openAsks: number;
  live: boolean;
  ageSeconds: number;
};

type Source = { id: string; label: string; status: 'ok' | 'degraded' | 'error'; detail: string };

type Snapshot = {
  active: { sessions: LiveSession[]; recentlyEnded: LiveSession[] };
  fleet: { projects: { key: string; displayName: string }[] };
  ready: ReadyItem[];
  cards: Card[];
  tiles: Record<'liveSessions' | 'needsDave' | 'blocked' | 'activeLanes' | 'openPrs', number>;
  sources: Source[];
};

// --- Helpers -------------------------------------------------------------------------------

/** Collect uncaught page errors and console errors. Assert the list is empty at the end. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/** Wait until React has hydrated: the poll hook has fetched once and the age button shows. */
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

/** The new snapshot keys must exist. A clear message beats "cannot read properties of undefined". */
function expectFleetKeys(snapshot: Snapshot): void {
  expect(Array.isArray(snapshot.ready), 'snapshot.ready must be an array (ReadyItem[])').toBe(true);
  expect(Array.isArray(snapshot.cards), 'snapshot.cards must be an array (SessionCard[])').toBe(true);
  expect(Array.isArray(snapshot.sources), 'snapshot.sources must be an array').toBe(true);
  expect(typeof snapshot.tiles, 'snapshot.tiles must be an object').toBe('object');
}

/** Live sessions: in active.sessions with a sign of life under 15 minutes ago. Fails if none. */
function liveSessions(snapshot: Snapshot, atLeast = 1): LiveSession[] {
  const live = snapshot.active.sessions.filter((s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS);
  expect(
    live.length,
    `Precondition: the database needs at least ${atLeast} live session(s) ` +
      `(active.sessions with liveSecondsAgo < ${LIVE_UNDER_SECONDS}). ` +
      `Found ${live.length}. Open a Claude Code session and run again.`,
  ).toBeGreaterThanOrEqual(atLeast);
  return live;
}

function sourceOf(snapshot: Snapshot, id: string): Source {
  const found = snapshot.sources?.find((s) => s.id === id);
  expect(found, `snapshot.sources must contain an entry with id "${id}"`).toBeDefined();
  return found as Source;
}

/** Read "<label> <n>" out of the state-files detail text, e.g. "no session row 1". */
function detailCount(detail: string, label: string): number {
  const match = new RegExp(`${label} (\\d+)`).exec(detail);
  expect(match, `state-files detail "${detail}" must contain "${label} <n>"`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

const readyItem = (page: Page, sessionId: string): Locator =>
  page.locator(`[data-testid="ready-item"][data-session-id="${sessionId}"]`);

const sessionCard = (page: Page, sessionId: string): Locator =>
  page.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`);

/** A project card in the fleet grid (an article with an h3). Session cards are not articles. */
const projectCard = (page: Page, displayName: string): Locator =>
  page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { level: 3, name: displayName, exact: true }) })
    .first();

const projectButton = (page: Page, displayName: string): Locator =>
  projectCard(page, displayName).getByRole('button', { name: displayName, exact: true });

/** A 3-step plan: step 1 done, step 2 doing, step 3 todo. No proofs. */
const PLAN: FixturePlanStep[] = [
  { id: 'p1', text: 'E2E step one', status: 'done' },
  { id: 'p2', text: 'E2E step two', status: 'doing' },
  { id: 'p3', text: 'E2E step three', status: 'todo' },
];

const FIXTURE_ASK = 'E2E fixture ask';
const FIXTURE_RECOMMEND = 'E2E fixture recommendation';

/** A secret-looking token: "sk-" plus 30 letters and digits. Matches hooks/shared/redact.ts. */
function fakeSecret(tag: string): string {
  return `sk-${`${tag}Zq8Lm2Xv9Kp4Rt6Wy1Bn3Hc5Jd7Fg0Ss4`.slice(0, 30)}`;
}

// --- Strip, header, footer -----------------------------------------------------------------

test.describe('Ready for Dave strip and page copy', () => {
  test('with no state files the strip is empty and says so', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 2, name: /^Ready for Dave/ })).toBeVisible();
    await expect(page.getByTestId('ready-for-dave')).toContainText('Nothing waiting on Dave.');
    await expect(page.getByTestId('ready-item')).toHaveCount(0);

    await waitForHydration(page);
    expect(errors).toEqual([]);
  });

  test('the old header and footer copy is replaced, the SELECT-only footer stays', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHydration(page);

    await expect(page.getByText(/local-first, read-only, no auth/)).toHaveCount(0);
    await expect(page.getByText(/Slice 1: fleet grid only/)).toHaveCount(0);
    await expect(
      page.getByText(/Connected as agentic_os_app \(SELECT-only, \d+ms\)\./),
    ).toBeVisible();
  });

  test('a live session with no state file still gets a card marked "No brief yet"', async ({
    page,
    request,
  }) => {
    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    const [live] = liveSessions(snapshot);

    const card = snapshot.cards.find((c) => c.id === live.id);
    expect(card, `cards must contain the live session ${live.id}`).toBeDefined();
    expect(card?.hasBrief).toBe(false);
    expect(card?.chip).toBeNull();
    // No state file in the E2E dir, so no branch: the name is <projectKey>/-/<first 4 chars>.
    expect(card?.branch).toBeNull();
    expect(card?.name).toMatch(new RegExp(`/-/${live.id.slice(0, 4)}$`));

    await page.goto('/');
    await expect(sessionCard(page, live.id)).toBeVisible();
    await expect(sessionCard(page, live.id)).toContainText('No brief yet');
    await expect(sessionCard(page, live.id).getByTestId('session-card-name')).toHaveText(
      card?.name ?? '',
    );
  });
});

// --- Spec 2: a fixture brief shows up -------------------------------------------------------

test.describe('fixture brief for a live session', () => {
  test('API: the ask is ready, the card counts 1 of 3 and 1 unproven, the tiles count it', async ({
    request,
  }) => {
    const before = await loadSnapshot(request);
    expectFleetKeys(before);
    const [live] = liveSessions(before);

    writeState(live.id, {
      chip: 'waiting-on-dave',
      repo: 'e2e-repo',
      branch: 'e2e/fixture-branch',
      ctx: 42,
      // The ask age is measured from the later of the brief update and the file write.
      at: secondsAgo(600),
      brief: makeBrief({
        title: 'E2E fixture title',
        goal: 'E2E fixture goal',
        plan: PLAN,
        ask: [ask(FIXTURE_ASK, FIXTURE_RECOMMEND)],
        updatedAt: secondsAgo(600),
      }),
    });

    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);

    const item = snapshot.ready.find((r) => r.sessionId === live.id);
    expect(item, `ready must hold the fixture ask of ${live.id}`).toBeDefined();
    expect(item).toMatchObject({
      sessionId: live.id,
      shortId: live.id.slice(0, 8),
      kind: 'question',
      text: FIXTURE_ASK,
      openAsks: 1,
      live: true,
    });
    // The strip never carries a recommendation: the DTO has no such key at all.
    expect(Object.keys(item as object)).not.toContain('recommend');
    // updatedAt is 600 s ago: the age is seconds, not milliseconds.
    expect(item?.ageSeconds).toBeGreaterThanOrEqual(590);
    expect(item?.ageSeconds).toBeLessThan(700);

    const card = snapshot.cards.find((c) => c.id === live.id);
    expect(card, `cards must hold the live session ${live.id}`).toBeDefined();
    expect(card).toMatchObject({
      hasBrief: true,
      chip: 'waiting-on-dave',
      title: 'E2E fixture title',
      branch: 'e2e/fixture-branch',
      repo: 'e2e-repo',
      planDone: 1,
      planTotal: 3,
      askOpen: 1,
      askStale: 0,
      unproven: 1,
      ctxPct: 42,
    });
    // Name is <projectKey>/<branch>/<first 4 chars of id>. The branch itself holds a slash.
    expect(card?.name.endsWith(`/e2e/fixture-branch/${live.id.slice(0, 4)}`)).toBe(true);
    if (live.projectKey) expect(card?.name.startsWith(`${live.projectKey}/`)).toBe(true);
    expect(['green', 'amber']).toContain(card?.liveColour);

    expect(snapshot.tiles.needsDave).toBeGreaterThanOrEqual(1);
    expect(snapshot.tiles.liveSessions).toBeGreaterThanOrEqual(1);
    for (const key of ['blocked', 'activeLanes', 'openPrs'] as const) {
      expect(typeof snapshot.tiles[key], `tiles.${key} must be a number`).toBe('number');
    }
  });

  test('page: the ask, the 1 of 3 plan and UNPROVEN 1 show within 10 s of the file landing', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = liveSessions(await loadSnapshot(request));

    await page.goto('/');
    await waitForHydration(page);
    await expect(readyItem(page, live.id)).toHaveCount(0);

    // The file lands AFTER hydration, so only the 5 s poll can bring it in.
    writeState(live.id, {
      chip: 'waiting-on-dave',
      repo: 'e2e-repo',
      branch: 'e2e/fixture-branch',
      ctx: 42,
      brief: makeBrief({
        title: 'E2E fixture title',
        plan: PLAN,
        ask: [ask(FIXTURE_ASK, FIXTURE_RECOMMEND)],
        updatedAt: secondsAgo(600),
      }),
    });

    const item = readyItem(page, live.id);
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item).toContainText(FIXTURE_ASK);
    // The strip holds the first ask only, never the recommendation (the detail panel keeps it).
    await expect(item).not.toContainText(FIXTURE_RECOMMEND);
    await expect(page.getByTestId('ready-for-dave')).not.toContainText(FIXTURE_RECOMMEND);
    await expect(item).toContainText('question');

    const card = sessionCard(page, live.id);
    await expect(card).toBeVisible();
    await expect(card).toContainText('E2E fixture title');
    // The card shows the glossary word; the raw code stays in data-chip.
    await expect(card).toContainText('Waiting for you');
    await expect(card).not.toContainText('waiting-on-dave');
    await expect(card.locator('[data-chip]')).toHaveAttribute('data-chip', 'waiting-on-dave');
    await expect(card).toContainText('1 of 3');
    await expect(card).toContainText('UNPROVEN 1');
    await expect(card).toContainText(/\bASK 1\b/);
    await expect(card).toContainText('42%');
    await expect(card).not.toContainText('No brief yet');

    expect(errors).toEqual([]);
  });

  test('unproven counts only done steps that have no proof', async ({ request }) => {
    const [live] = liveSessions(await loadSnapshot(request));

    // Two done steps. A proof ties to id AND subject AND kind (types/index.d.ts OsProof).
    writeState(live.id, {
      brief: makeBrief({
        plan: [
          { id: 'p1', text: 'E2E proven step', status: 'done' },
          { id: 'p2', text: 'E2E unproven step', status: 'done' },
          { id: 'p3', text: 'E2E open step', status: 'todo' },
        ],
        proofs: [
          {
            id: 'p1',
            artifact: 'e2e/artifact.txt',
            at: Date.now(),
            subject: 'E2E proven step',
            kind: 'plan',
          },
        ],
        updatedAt: secondsAgo(60),
      }),
    });

    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    const card = snapshot.cards.find((c) => c.id === live.id);
    expect(card, `cards must hold the live session ${live.id}`).toBeDefined();
    expect(card).toMatchObject({ planDone: 2, planTotal: 3, unproven: 1 });
  });

  test('stat tiles, source health and the strip order render on the page', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = liveSessions(await loadSnapshot(request));
    writeState(live.id, {
      chip: 'waiting-on-dave',
      brief: makeBrief({ plan: PLAN, ask: [ask(FIXTURE_ASK, FIXTURE_RECOMMEND)] }),
    });

    await page.goto('/');
    await waitForHydration(page);
    await expect(readyItem(page, live.id)).toBeVisible();

    const tiles = page.getByTestId('stat-tile');
    await expect(tiles).toHaveCount(5);
    // The mockup's order: Live sessions, Active lanes, Blocked, Open PRs, Needs Dave.
    const labels = ['Live sessions', 'Active lanes', 'Blocked', 'Open PRs', 'Needs Dave'];
    for (const [index, label] of labels.entries()) {
      await expect(tiles.nth(index)).toContainText(label);
    }
    const tile = (label: string): Locator => tiles.filter({ hasText: label });

    // Values come from the same snapshot the page polls. Needs Dave counts the ready rows:
    // one row per session.
    const snapshot = await loadSnapshot(request);
    await expect(tile('Live sessions')).toContainText(String(snapshot.tiles.liveSessions));
    await expect(tile('Needs Dave')).toContainText(String(snapshot.tiles.needsDave));
    expect(snapshot.tiles.needsDave).toBe(snapshot.ready.length);
    await expect(page.getByTestId('ready-item')).toHaveCount(snapshot.ready.length);

    // The strip is at the very top: above the tiles, the tiles are above Projects, and
    // Projects is above the session cards (the mockup order).
    const strip = await page.getByTestId('ready-for-dave').boundingBox();
    const tileBox = await page.getByTestId('stat-tiles').boundingBox();
    const projectsBox = await page
      .getByRole('heading', { level: 2, name: /^Projects/ })
      .boundingBox();
    const cardsBox = await sessionCard(page, live.id).boundingBox();
    expect(
      strip && tileBox && projectsBox && cardsBox,
      'strip, tiles, Projects and card must all be rendered',
    ).toBeTruthy();
    expect(strip!.y).toBeLessThan(tileBox!.y);
    expect(tileBox!.y).toBeLessThan(projectsBox!.y);
    expect(projectsBox!.y).toBeLessThan(cardsBox!.y);

    // Source health: one row per source, status in the row, state-files counts in the detail.
    const health = page.getByRole('heading', { level: 2, name: /^Data sources/ });
    await expect(health).toBeVisible();
    for (const id of ['database', 'state-files', 'lane-registry']) {
      await expect(page.getByTestId(`source-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('source-database')).toContainText('ok');
    await expect(page.getByTestId('source-lane-registry')).toContainText('ok');
    await expect(page.getByTestId('source-state-files')).toContainText(/\bfiles 1\b/);
    expect(sourceOf(snapshot, 'database').status).toBe('ok');
    expect(
      sourceOf(snapshot, 'lane-registry').status,
      'lane-registry must be ok: agentic_os.lane is readable by the app role',
    ).toBe('ok');

    expect(errors).toEqual([]);
  });
});

// --- Specs 3, 4, 5, 6: files the join drops, files that are broken, redaction --------------

test.describe('files that must not reach the page', () => {
  test('a file for a session with no row is counted and shown nowhere', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = liveSessions(await loadSnapshot(request));
    const stranger = randomUUID();

    // Control: a matched file proves the reader runs. Without it "shown nowhere" is vacuous.
    writeState(live.id, {
      brief: makeBrief({ title: 'E2E matched control', ask: [ask('E2E matched ask')] }),
    });
    writeState(stranger, {
      branch: 'e2e/stranger-branch',
      brief: makeBrief({
        title: 'E2E stranger title',
        ask: [ask('E2E stranger ask', 'E2E stranger recommend')],
      }),
    });

    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    const state = sourceOf(snapshot, 'state-files');
    expect(detailCount(state.detail, 'files')).toBe(2);
    expect(detailCount(state.detail, 'no session row')).toBe(1);
    expect(detailCount(state.detail, 'unreadable')).toBe(0);
    expect(snapshot.cards.map((c) => c.id)).not.toContain(stranger);
    expect(snapshot.ready.map((r) => r.sessionId)).not.toContain(stranger);
    expect(snapshot.ready.map((r) => r.sessionId)).toContain(live.id);

    await page.goto('/');
    await waitForHydration(page);
    await expect(readyItem(page, live.id)).toBeVisible();
    await expect(sessionCard(page, live.id)).toContainText('E2E matched control');
    await expect(page.getByTestId('source-state-files')).toContainText(/\bno session row 1\b/);
    const text = await page.locator('body').innerText();
    for (const needle of ['E2E stranger title', 'E2E stranger ask', 'E2E stranger recommend']) {
      expect(text).not.toContain(needle);
    }
    expect(await page.content()).not.toContain(stranger);
    await expect(page.locator(`[data-session-id="${stranger}"]`)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('a file for an ENDED session is dropped from cards and strip', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    const [live] = liveSessions(snapshot);
    // Read from the database, not from active.recentlyEnded: a session that ended in the last
    // 15 minutes is often absent, and an older ended row is dropped by the same rule.
    const ended = { id: await findEndedSessionId() };
    expect(ended.id).not.toBe(live.id);

    writeState(live.id, {
      brief: makeBrief({ title: 'E2E live control', ask: [ask('E2E live control ask')] }),
    });
    writeState(ended.id, {
      brief: makeBrief({
        title: 'E2E ended title',
        ask: [ask('E2E ended ask', 'E2E ended recommend')],
      }),
    });

    const after = await loadSnapshot(request);
    expectFleetKeys(after);
    expect(after.cards.map((c) => c.id)).not.toContain(ended.id);
    expect(after.ready.map((r) => r.sessionId)).not.toContain(ended.id);
    expect(after.ready.map((r) => r.sessionId)).toContain(live.id);
    expect(detailCount(sourceOf(after, 'state-files').detail, 'ended')).toBe(1);

    await page.goto('/');
    await waitForHydration(page);
    await expect(readyItem(page, live.id)).toBeVisible();
    await expect(readyItem(page, ended.id)).toHaveCount(0);
    await expect(sessionCard(page, ended.id)).toHaveCount(0);
    const text = await page.locator('body').innerText();
    for (const needle of ['E2E ended title', 'E2E ended ask', 'E2E ended recommend']) {
      expect(text).not.toContain(needle);
    }

    expect(errors).toEqual([]);
  });

  test('files that are not valid state are counted unreadable and the API stays 200', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const [live] = liveSessions(await loadSnapshot(request));

    writeState(live.id, {
      brief: makeBrief({ title: 'E2E survivor', ask: [ask('E2E survivor ask')] }),
    });
    writeRaw('not-json.json', '{ this is not json');
    writeRaw('no-session-id.json', JSON.stringify({ at: Date.now(), brief: null }));
    writeRaw('no-at.json', JSON.stringify({ sessionId: randomUUID() }));

    const response = await request.get('/api/mission-control');
    expect(response.status()).toBe(200);
    const snapshot = (await response.json()) as Snapshot;
    expectFleetKeys(snapshot);
    const detail = sourceOf(snapshot, 'state-files').detail;
    expect(detailCount(detail, 'files')).toBe(4);
    expect(detailCount(detail, 'unreadable')).toBe(3);
    expect(snapshot.ready.map((r) => r.sessionId)).toContain(live.id);

    const result = await page.goto('/');
    expect(result?.status()).toBeLessThan(400);
    await waitForHydration(page);
    await expect(page.getByText('Database unreachable.')).toHaveCount(0);
    await expect(readyItem(page, live.id)).toBeVisible();
    await expect(page.getByTestId('source-state-files')).toContainText(/\bunreadable 3\b/);

    expect(errors).toEqual([]);
  });

  test('a secret-looking string is redacted everywhere it could reach the page', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    const secrets = {
      title: fakeSecret('Title'),
      goal: fakeSecret('Goal'),
      ask: fakeSecret('Ask'),
      recommend: fakeSecret('Rec'),
      step: fakeSecret('Step'),
    };
    expect(Object.values(secrets).every((s) => /^sk-[A-Za-z0-9]{30}$/.test(s))).toBe(true);

    writeState(live.id, {
      chip: 'waiting-on-dave',
      brief: makeBrief({
        title: `E2E title ${secrets.title}`,
        goal: `E2E goal ${secrets.goal}`,
        plan: [{ id: 'p1', text: `E2E step ${secrets.step}`, status: 'doing' }],
        ask: [ask(`E2E leak check ${secrets.ask}`, `E2E use ${secrets.recommend}`)],
        updatedAt: secondsAgo(120),
      }),
    });

    // Present first: the check below is vacuous if the ask never renders.
    await page.goto('/');
    await waitForHydration(page);
    const item = readyItem(page, live.id);
    await expect(item).toBeVisible();
    await expect(item).toContainText('E2E leak check');
    await expect(item).toContainText('[REDACTED');
    await expect(sessionCard(page, live.id)).toContainText('E2E title');

    const apiText = await (await request.get('/api/mission-control')).text();
    const pageHtml = await page.content();
    const pageText = await page.locator('body').innerText();
    for (const [field, secret] of Object.entries(secrets)) {
      // The whole token and its tail: a partial redaction would leave the tail behind.
      for (const needle of [secret, secret.slice(3, 15)]) {
        expect(apiText, `API JSON leaks the ${field} secret`).not.toContain(needle);
        expect(pageHtml, `page HTML (incl. RSC payload) leaks the ${field} secret`).not.toContain(
          needle,
        );
        expect(pageText, `page text leaks the ${field} secret`).not.toContain(needle);
      }
    }
  });
});

// --- Staleness, ordering -------------------------------------------------------------------

test.describe('ask rules', () => {
  test('answered asks and asks older than 24 h stay out of the strip', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));

    // updatedAt 25 h ago makes every ask of this brief stale; one is also answered.
    writeState(live.id, {
      chip: 'waiting-on-dave',
      // Both stamps are old: the age is the later of the brief update and the file write.
      at: secondsAgo(25 * HOUR),
      brief: makeBrief({
        title: 'E2E stale brief',
        ask: [
          ask('E2E answered ask', undefined, { answered: true }),
          ask('E2E stale open ask'),
        ],
        updatedAt: secondsAgo(25 * HOUR),
      }),
    });

    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    expect(snapshot.ready.map((r) => r.sessionId)).not.toContain(live.id);
    const card = snapshot.cards.find((c) => c.id === live.id);
    expect(card, `cards must hold ${live.id}`).toBeDefined();
    // The answered ask counts nowhere. The stale open ask counts as stale, not as open.
    expect(card).toMatchObject({ askOpen: 0, askStale: 1 });

    await page.goto('/');
    await waitForHydration(page);
    await expect(sessionCard(page, live.id)).toContainText('E2E stale brief');
    await expect(sessionCard(page, live.id)).toContainText(/\bASK 0\b/);
    await expect(sessionCard(page, live.id)).toContainText(/\bASK STALE 1\b/);
    await expect(readyItem(page, live.id)).toHaveCount(0);
    await expect(page.getByTestId('ready-for-dave')).toContainText('Nothing waiting on Dave.');
    await expect(page.locator('body')).not.toContainText('E2E answered ask');
    await expect(page.locator('body')).not.toContainText('E2E stale open ask');
  });

  test('the oldest ask comes first in the strip', async ({ page, request }) => {
    const live = liveSessions(await loadSnapshot(request), 1);
    test.skip(
      live.length < 2,
      'Needs two live sessions (liveSecondsAgo < 900). Only one is live now; ordering cannot be shown.',
    );
    // The older ask goes on the SECOND session, so "same order as the sessions" cannot pass it.
    const [newerSession, olderSession] = live;

    writeState(newerSession.id, {
      brief: makeBrief({
        ask: [ask('E2E newer ask')],
        updatedAt: secondsAgo(60),
      }),
    });
    writeState(olderSession.id, {
      brief: makeBrief({
        ask: [ask('E2E older ask')],
        updatedAt: secondsAgo(HOUR),
      }),
      // The ask age is max(brief.updatedAt, snapshot.at). Without an old `at` both ages are 0
      // and the order falls to the session id, which is random.
      at: secondsAgo(HOUR),
    });

    const snapshot = await loadSnapshot(request);
    expectFleetKeys(snapshot);
    const order = snapshot.ready
      .filter((r) => r.sessionId === newerSession.id || r.sessionId === olderSession.id)
      .map((r) => r.sessionId);
    expect(order, 'API ready[] must be sorted by age, oldest first').toEqual([
      olderSession.id,
      newerSession.id,
    ]);
    const ages = snapshot.ready.map((r) => r.ageSeconds);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
    expect(ages[0]).toBeGreaterThanOrEqual(HOUR - 10);

    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByTestId('ready-item')).toHaveCount(2);
    await expect
      .poll(() =>
        page
          .getByTestId('ready-item')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id'))),
      )
      .toEqual([olderSession.id, newerSession.id]);
    await expect(page.getByTestId('ready-item').first()).toContainText('E2E older ask');
  });
});

// --- Spec 8: project filter ----------------------------------------------------------------

test.describe('project card filter', () => {
  test('clicking a project card filters the session cards, Clear restores them', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const first = await loadSnapshot(request);
    expectFleetKeys(first);
    // A live session that maps to a project; one with no mapping cannot be filtered by a project card.
    const live = liveSessions(first).find((s) => s.projectKey !== null && s.projectDisplayName !== null);
    test.skip(
      live === undefined,
      'Precondition missing: no live session maps to a project (projectKey and projectDisplayName set).',
    );
    if (live === undefined) return;

    writeState(live.id, {
      brief: makeBrief({ title: 'E2E filter control', plan: PLAN }),
    });

    const snapshot = await loadSnapshot(request);
    const total = snapshot.cards.length;
    const inProject = snapshot.cards.filter((c) => c.projectKey === live.projectKey);
    const displayName = live.projectDisplayName as string;
    expect(inProject.length).toBeGreaterThanOrEqual(1);

    await page.goto('/');
    await waitForHydration(page);
    const cards = page.getByTestId('session-card');
    await expect(cards).toHaveCount(total);
    await expect(page.getByTestId('session-filter')).toHaveCount(0);

    // Select the project that holds the live session.
    const button = projectButton(page, displayName);
    await expect(button, `project card "${displayName}" needs a button named after it`).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(cards).toHaveCount(inProject.length);
    await expect(page.getByTestId('session-filter')).toContainText(displayName);
    await expect(sessionCard(page, live.id)).toBeVisible();
    for (const name of await cards.getByTestId('session-card-name').allInnerTexts()) {
      expect(name.startsWith(`${live.projectKey}/`), `card "${name}" is outside the filter`).toBe(
        true,
      );
    }

    // Clear restores every card.
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(cards).toHaveCount(total);
    await expect(page.getByTestId('session-filter')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // A second click on the same project card also clears.
    await button.click();
    await expect(cards).toHaveCount(inProject.length);
    await button.click();
    await expect(cards).toHaveCount(total);
    await expect(page.getByTestId('session-filter')).toHaveCount(0);

    // A project with no live card empties the list. This is what makes the filter provable
    // when every live session sits in one project.
    const liveKeys = new Set(snapshot.cards.map((c) => c.projectKey));
    const idle = snapshot.fleet.projects.find((p) => !liveKeys.has(p.key));
    if (idle) {
      await projectButton(page, idle.displayName).click();
      await expect(cards).toHaveCount(0);
      await expect(page.getByTestId('session-cards')).toContainText(/No live sessions/);
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(cards).toHaveCount(total);
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'Every registered project has a live card, so the empty-filter case was not run.',
      });
    }

    expect(errors).toEqual([]);
  });
});

// --- Spec 9: phone width -------------------------------------------------------------------

test.describe('layout with the new sections', () => {
  test('long content does not make the page scroll sideways', async ({ page, request }, testInfo) => {
    const [live] = liveSessions(await loadSnapshot(request));
    const long = 'W'.repeat(100);

    writeState(live.id, {
      chip: 'waiting-on-dave',
      repo: 'e2e-repo',
      branch: `feature/${'x'.repeat(80)}`,
      ctx: 88,
      brief: makeBrief({
        title: long,
        goal: long,
        plan: PLAN,
        ask: [ask('A'.repeat(200), 'R'.repeat(200))],
        updatedAt: secondsAgo(300),
      }),
    });

    await page.goto('/');
    await waitForHydration(page);
    // The long ask must be on screen, or the overflow check proves nothing.
    await expect(readyItem(page, live.id)).toBeVisible();
    await expect(sessionCard(page, live.id)).toBeVisible();
    await expect(page.getByTestId('stat-tile')).toHaveCount(5);
    await expect(page.getByTestId('source-health')).toBeVisible();

    if (testInfo.project.name === 'phone') {
      expect(page.viewportSize()?.width).toBe(390);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document is wider than the viewport').toBeLessThanOrEqual(0);
  });
});
