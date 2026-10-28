import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  agent,
  agentRun,
  ask,
  cacheState,
  clearStateDir,
  findEndedSessionId,
  findQuietSessionId,
  makeBrief,
  pr,
  secondsAgo,
  SESSION_ID_FORMAT,
  step,
  STATE_DIR,
  writeRaw,
  writeState,
  type FixturePlanStep,
  type FixtureProof,
  type StateOptions,
} from './state-fixture';

/**
 * End-to-end check for P1b part B1: nav shell, Sessions view, session detail panel, the URL,
 * the widened state-file reader and click-through. Design contract:
 * .claudedocs/2026-10-28-p1b-b1-design.md. Part A specs (fleet.spec.ts, fleet-review.spec.ts)
 * keep their own testids; this file adds the ones listed in the "UI contract" of the report.
 *
 * READ-ONLY toward the app: the specs only GET and click. Their only writes are fixture state
 * files in the private E2E state dir. The dir is emptied before and after every test.
 *
 * The app role cannot insert public.sessions rows, so the specs borrow REAL live sessions from
 * GET /api/mission-control and write fixture state files for their ids. A missing precondition
 * FAILS with a message that says so. Nothing in this file is skipped.
 */

const LIVE_UNDER_SECONDS = 900;
const HOUR = 3600;

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

// --- Shapes read from /api/mission-control -------------------------------------------------

type LiveSession = {
  id: string;
  shortId: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  liveSecondsAgo: number;
};

type Card = {
  id: string;
  name: string;
  projectKey: string | null;
  chip: string | null;
  title: string | null;
  laneId?: string | null;
  planDone: number;
  planTotal: number;
  askOpen: number;
  ctxPct: number | null;
};

type ReadyItem = { sessionId: string; name: string; text: string };

type DetailAsk = {
  kind: string;
  text: string;
  recommend: string | null;
  answered: boolean;
  stale: boolean;
  parsed: boolean;
};

type Detail = {
  id: string;
  shortId: string;
  name: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  chip: string | null;
  liveColour: 'green' | 'amber';
  liveSecondsAgo: number;
  availability: 'live' | 'quiet';
  title: string | null;
  goal: string | null;
  stopAt: string | null;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  laneIds: string[];
  planSource: 'tasks' | 'brief' | 'none';
  steps: { id: string; text: string; status: string }[];
  planMore: number;
  planDone: number;
  planTotal: number;
  step: { tool: string; label: string; elapsedSeconds: number } | null;
  agents: { description: string; type: string; status: string }[];
  done: { id: string; text: string; proof: { artifact: string; kind: string } | null }[];
  unproven: number;
  asks: DetailAsk[];
  decisions: { text: string; by: string; ageSeconds: number }[];
  ctxPct: number | null;
  cache: { hitPct: number; savedUsd: number } | null;
  agentRuns: { count: number; running: number; costUsd: number } | null;
  prs: { pr: number; state: string | null }[];
  sessionCost: null;
  limits: null;
  stateAgeSeconds: number | null;
  hasBrief: boolean;
};

type Snapshot = {
  active: { sessions: LiveSession[] };
  fleet: { projects: { key: string; displayName: string }[] };
  ready: ReadyItem[];
  cards: Card[];
  detail: Detail | null;
};

// --- Helpers (copied from fleet.spec.ts, which keeps them file-local) -----------------------

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

async function loadSnapshot(request: APIRequestContext, sessionId?: string): Promise<Snapshot> {
  const response = await request.get(
    sessionId === undefined
      ? '/api/mission-control'
      : `/api/mission-control?session=${encodeURIComponent(sessionId)}`,
  );
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

/**
 * A live session: in active.sessions with a sign of life under 15 minutes ago AND an id the app
 * accepts in ?session= (the design ignores any other id). Fails if none.
 */
async function liveSession(request: APIRequestContext): Promise<LiveSession> {
  const snapshot = await loadSnapshot(request);
  const live = snapshot.active.sessions.filter(
    (s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id),
  );
  expect(
    live.length,
    `Precondition: the database needs a live session (liveSecondsAgo < ${LIVE_UNDER_SECONDS}) ` +
      `whose id matches ${SESSION_ID_FORMAT}. Found ${live.length}. ` +
      'Open a Claude Code session and run again.',
  ).toBeGreaterThanOrEqual(1);
  return live[0];
}

/** The detail of `sessionId`. Fails with a clear message when the DTO is missing. */
async function loadDetail(request: APIRequestContext, sessionId: string): Promise<Detail> {
  const snapshot = await loadSnapshot(request, sessionId);
  expect(
    snapshot.detail,
    `GET /api/mission-control?session=${sessionId} must return a non-null "detail"`,
  ).not.toBeNull();
  return snapshot.detail as Detail;
}

/** A secret-looking token: "sk-" plus 30 letters and digits. Matches hooks/shared/redact.ts. */
function fakeSecret(tag: string): string {
  return `sk-${`${tag}Zq8Lm2Xv9Kp4Rt6Wy1Bn3Hc5Jd7Fg0Ss4`.slice(0, 30)}`;
}

/** Fragments of an absolute path that must never reach the client. */
function pathFragments(): string[] {
  const fragments = [STATE_DIR, homedir(), tmpdir()];
  const user = process.env.USERNAME ?? process.env.USER;
  if (user) fragments.push(user);
  return fragments.filter((f) => f.length > 3);
}

const sessionCard = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
const readyItem = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="ready-item"][data-session-id="${id}"]`);
const sessionRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);

const detailPanel = (page: Page): Locator => page.getByTestId('session-detail');
const section = (page: Page, name: string): Locator => page.getByTestId(`detail-${name}`);
const navTab = (page: Page, tab: string): Locator =>
  page.getByTestId('nav-tabs').locator(`[data-testid="nav-tab"][data-tab="${tab}"]`);

const projectCard = (page: Page, displayName: string): Locator =>
  page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { level: 3, name: displayName, exact: true }) })
    .first();
const projectButton = (page: Page, displayName: string): Locator =>
  projectCard(page, displayName).getByRole('button', { name: displayName, exact: true });

const urlParam = (page: Page, key: string): string | null =>
  new URL(page.url()).searchParams.get(key);

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// --- The detail fixture (spec 3) -------------------------------------------------------------

const D = {
  repo: 'e2e-repo',
  branch: 'e2e/detail-branch',
  title: 'E2E detail title',
  goal: 'E2E detail goal',
  stopAt: 'E2E detail stop point',
  stepOne: 'E2E detail step one',
  stepTwo: 'E2E detail step two',
  stepThree: 'E2E detail step three',
  proof: 'e2e/artifacts/proof-one.txt',
  openAsk: 'E2E detail open ask',
  recommend: 'E2E detail recommend',
  answeredAsk: 'E2E detail answered ask',
  toolLabel: 'E2E detail running label',
  agentDesc: 'E2E detail agent',
  decOld: 'E2E decision older',
  decNew: 'E2E decision newer',
} as const;

/** Step 1 done WITH a proof, step 2 done WITHOUT one, step 3 doing: planDone 2, unproven 1. */
const DETAIL_PLAN: FixturePlanStep[] = [
  { id: 'p1', text: D.stepOne, status: 'done' },
  { id: 'p2', text: D.stepTwo, status: 'done' },
  { id: 'p3', text: D.stepThree, status: 'doing' },
];

const DETAIL_PROOFS: FixtureProof[] = [
  { id: 'p1', artifact: D.proof, at: Date.now(), subject: D.stepOne, kind: 'plan' },
];

/** The full fixture of spec 3. `overrides` replaces whole top-level options. */
function writeDetailFixture(id: string, overrides: StateOptions = {}): void {
  writeState(id, {
    chip: 'waiting-on-dave',
    repo: D.repo,
    branch: D.branch,
    ctx: 42,
    step: step('Bash', D.toolLabel, 30),
    agents: [agent(D.agentDesc, 'scout', 'running')],
    // 1.25 + 0.5 = 1.75, exact in floating point. The cache saving (3.2) differs on purpose.
    agentRuns: [
      agentRun('run-1', { costUsd: 1.25, status: 'done' }),
      agentRun('run-2', { costUsd: 0.5, status: 'running', endedAt: null }),
    ],
    cache: cacheState({ savedUsd: 3.2 }),
    prs: [pr(1234, 'PENDING')],
    brief: makeBrief({
      title: D.title,
      goal: D.goal,
      stopAt: D.stopAt,
      plan: DETAIL_PLAN,
      proofs: DETAIL_PROOFS,
      ask: [ask(D.openAsk, D.recommend), ask(D.answeredAsk, undefined, { answered: true })],
      decisions: [
        { text: D.decOld, by: 'dave', at: secondsAgo(2 * HOUR) },
        { text: D.decNew, by: 'claude', at: secondsAgo(600) },
      ],
      updatedAt: secondsAgo(120),
    }),
    ...overrides,
  });
}

/** Open the detail of `id` by URL and wait for the panel. */
async function openByUrl(page: Page, id: string, view: 'overview' | 'sessions' = 'overview') {
  await page.goto(view === 'sessions' ? `/?view=sessions&session=${id}` : `/?session=${id}`);
  await expect(detailPanel(page)).toBeVisible();
}

// --- Spec 1: navigation ----------------------------------------------------------------------

const TABS: { tab: string; label: string; tag: 'NEXT' | 'LATER' | null }[] = [
  { tab: 'overview', label: 'Overview', tag: null },
  { tab: 'board', label: 'Board', tag: 'NEXT' },
  { tab: 'sessions', label: 'Sessions', tag: null },
  { tab: 'workflows', label: 'Workflows', tag: 'NEXT' },
  { tab: 'handoffs', label: 'Handoffs', tag: 'NEXT' },
  { tab: 'notes', label: 'Notes', tag: 'NEXT' },
  { tab: 'evidence', label: 'Evidence', tag: 'NEXT' },
  { tab: 'swarm', label: 'Swarm', tag: 'LATER' },
];

test.describe('nav shell', () => {
  test('eight tabs in order; Overview and Sessions live; the rest disabled with NEXT or LATER', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await waitForHydration(page);

    const tabs = page.getByTestId('nav-tabs').getByTestId('nav-tab');
    await expect(tabs).toHaveCount(8);
    expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-tab')))).toEqual(
      TABS.map((t) => t.tab),
    );
    await expect(page.getByTestId('nav-tabs')).toContainText('agentic-os');

    for (const { tab, label, tag } of TABS) {
      const button = navTab(page, tab);
      await expect(button, `tab ${label}`).toContainText(label);
      expect(await button.evaluate((el) => el.tagName), `${label} must be a real <button>`).toBe(
        'BUTTON',
      );
      if (tag === null) {
        await expect(button).toBeEnabled();
        await expect(button.getByTestId('nav-tab-tag')).toHaveCount(0);
      } else {
        await expect(button).toBeDisabled();
        expect(await button.getAttribute('disabled'), `${label} needs the disabled attribute`).not.toBeNull();
        await expect(button.getByTestId('nav-tab-tag')).toHaveText(tag);
      }
    }
    expect(errors).toEqual([]);
  });

  test('the active tab carries aria-current=page and follows a click; a disabled tab does nothing', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await waitForHydration(page);

    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect(navTab(page, 'sessions')).not.toHaveAttribute('aria-current', 'page');

    await navTab(page, 'sessions').click();
    await expect(navTab(page, 'sessions')).toHaveAttribute('aria-current', 'page');
    await expect(navTab(page, 'overview')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sessions-table')).toBeVisible();

    // Ready for Dave, the tiles and the footer stay around every view (PRD 5.4).
    await expect(page.getByTestId('ready-for-dave')).toBeVisible();
    await expect(page.getByTestId('stat-tiles')).toBeVisible();
    await expect(page.locator('footer')).toContainText(/Connected as agentic_os_app \(SELECT-only, \d+ms\)\./);
    await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible();

    // A forced click on a disabled button fires no click event: nothing changes.
    await navTab(page, 'board').click({ force: true });
    await expect(navTab(page, 'sessions')).toHaveAttribute('aria-current', 'page');
    await expect(navTab(page, 'board')).not.toHaveAttribute('aria-current', 'page');
    expect(urlParam(page, 'view')).toBe('sessions');

    await navTab(page, 'overview').click();
    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sessions-table')).toHaveCount(0);
    await expect(page.getByTestId('session-cards')).toBeVisible();
    expect([null, 'overview']).toContain(urlParam(page, 'view'));
    expect(errors).toEqual([]);
  });

  test('no horizontal page scroll in either view, with a long detail open', async ({
    page,
    request,
  }, testInfo) => {
    const live = await liveSession(request);
    const long = 'W'.repeat(120);
    writeDetailFixture(live.id, {
      branch: `feature/${'x'.repeat(80)}`,
      step: step('Bash', long, 30),
      agents: [agent(long, 'scout', 'running')],
      brief: makeBrief({
        title: long,
        goal: long,
        stopAt: long,
        plan: [
          { id: 'p1', text: long, status: 'done' },
          { id: 'p2', text: long, status: 'doing' },
        ],
        proofs: [{ id: 'p1', artifact: long, at: Date.now(), subject: long, kind: 'plan' }],
        ask: [ask(long, long)],
        decisions: [{ text: long, by: 'dave', at: secondsAgo(60) }],
        updatedAt: secondsAgo(60),
      }),
    });

    if (testInfo.project.name === 'phone') {
      expect(page.viewportSize()?.width).toBe(390);
    }
    await page.goto(`/?session=${live.id}`);
    await waitForHydration(page);
    await expect(detailPanel(page)).toBeVisible();
    await expect(section(page, 'goal')).toContainText(long.slice(0, 40));
    expect(await horizontalOverflow(page), 'overview is wider than the viewport').toBeLessThanOrEqual(0);

    await navTab(page, 'sessions').click();
    await expect(page.getByTestId('sessions-table')).toBeVisible();
    await expect(sessionRow(page, live.id)).toBeVisible();
    await expect(detailPanel(page)).toBeVisible();
    expect(await horizontalOverflow(page), 'sessions view is wider than the viewport').toBeLessThanOrEqual(0);
  });
});

// --- Spec 2: Sessions view ---------------------------------------------------------------------

test.describe('Sessions view', () => {
  test('the table has the eight columns in order and a row for a fixture-backed live session', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id, {
      brief: makeBrief({
        title: 'E2E row title',
        plan: [
          { id: 'p1', text: 'E2E row one', status: 'done' },
          { id: 'p2', text: 'E2E row two', status: 'doing' },
          { id: 'p3', text: 'E2E row three', status: 'todo' },
        ],
        ask: [ask('E2E row ask', 'E2E row recommend')],
        updatedAt: secondsAgo(60),
      }),
    });
    const card = (await loadSnapshot(request)).cards.find((c) => c.id === live.id);
    expect(card, `cards must hold the live session ${live.id}`).toBeDefined();
    expect(card?.name.endsWith(`/e2e/detail-branch/${live.id.slice(0, 4)}`)).toBe(true);
    expect(card, 'cards[] must carry laneId (string or null) for the Lane column').toHaveProperty('laneId');

    await page.goto('/');
    await waitForHydration(page);
    await navTab(page, 'sessions').click();

    const table = page.getByTestId('sessions-table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText([
      'State',
      'Name',
      'Title',
      'Lane',
      'Plan',
      'Ask',
      'Ctx',
      'Last seen',
    ]);

    const row = sessionRow(page, live.id);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('session-row-state')).toContainText('waiting-on-dave');
    await expect(row.getByTestId('session-row-select')).toHaveText(card?.name ?? '');
    await expect(row.getByTestId('session-row-title')).toHaveText('E2E row title');
    await expect(row.getByTestId('session-row-lane')).toHaveText(card?.laneId ?? '-');
    await expect(row.getByTestId('session-row-plan')).toHaveText('1/3');
    await expect(row.getByTestId('session-row-ask')).toHaveText('1');
    await expect(row.getByTestId('session-row-ctx')).toHaveText('42%');
    await expect(row.getByTestId('session-row-seen')).toContainText(/just now|\d+[mhd] ago/);
    await expect(table.getByTestId('session-row')).toHaveCount((await loadSnapshot(request)).cards.length);

    // With nothing selected the panel is not drawn.
    await expect(detailPanel(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the project filter set on Overview applies to the table', async ({ page, request }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    expect(
      live.projectKey && live.projectDisplayName,
      `Precondition: live session ${live.id} must map to a project`,
    ).toBeTruthy();
    writeDetailFixture(live.id);

    const snapshot = await loadSnapshot(request);
    const total = snapshot.cards.length;
    const inProject = snapshot.cards.filter((c) => c.projectKey === live.projectKey);
    expect(inProject.length).toBeGreaterThanOrEqual(1);

    await page.goto('/');
    await waitForHydration(page);
    await projectButton(page, live.projectDisplayName as string).click();
    await navTab(page, 'sessions').click();
    await expect(page.getByTestId('session-row')).toHaveCount(inProject.length);
    await expect(sessionRow(page, live.id)).toBeVisible();

    // Back on Overview, Clear restores every row in the table.
    await navTab(page, 'overview').click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await navTab(page, 'sessions').click();
    await expect(page.getByTestId('session-row')).toHaveCount(total);

    // A project with no live card empties the table. This proves the filter when every live
    // session sits in one project.
    const liveKeys = new Set(snapshot.cards.map((c) => c.projectKey));
    const idle = snapshot.fleet.projects.find((p) => !liveKeys.has(p.key));
    if (idle) {
      await navTab(page, 'overview').click();
      await projectButton(page, idle.displayName).click();
      await navTab(page, 'sessions').click();
      await expect(page.getByTestId('session-row')).toHaveCount(0);
      await expect(page.getByTestId('sessions-table')).toContainText('No live sessions');
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'Every registered project has a live card, so the empty-filter case was not run.',
      });
    }
    expect(errors).toEqual([]);
  });
});

// --- Spec 3: the detail panel, six sections ---------------------------------------------------

test.describe('session detail panel', () => {
  test('a card click shows Goal, Plan, Now, Done, Ask, Health and Decisions with the fixture text', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByText(/^Select a session/)).toBeVisible();
    await expect(detailPanel(page)).toHaveCount(0);

    const cardButton = sessionCard(page, live.id).getByRole('button');
    await expect(cardButton).toHaveCount(1);
    await cardButton.click();
    const panel = detailPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-session-id', live.id);
    await expect(panel).toHaveAttribute('data-availability', 'live');

    // Header: "Session . <project> / <id4>" plus the chip.
    const header = panel.getByTestId('detail-header');
    await expect(header).toContainText('Session');
    await expect(header).toContainText(live.id.slice(0, 4));
    await expect(header).toContainText('waiting-on-dave');

    // The h3 titles, exactly, in order. Decisions only because the fixture has some.
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText([
      'Goal',
      'Plan',
      'Now',
      'Done',
      'Ask',
      'Health',
      'Decisions',
    ]);

    // Goal
    const goal = section(page, 'goal');
    for (const text of [D.title, D.goal, D.stopAt, D.repo, D.branch]) {
      await expect(goal).toContainText(text);
    }

    // Plan: 2 of 3, three steps with their status.
    const plan = section(page, 'plan');
    await expect(plan).toContainText('2 of 3');
    const steps = plan.getByTestId('plan-step');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText(D.stepOne);
    await expect(steps.nth(1)).toContainText(D.stepTwo);
    await expect(steps.nth(2)).toContainText(D.stepThree);
    expect(await steps.evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))).toEqual([
      'done',
      'done',
      'doing',
    ]);

    // Now: the running tool call and the running agent.
    const now = section(page, 'now');
    await expect(now).toContainText('Bash');
    await expect(now).toContainText(D.toolLabel);
    await expect(now).toContainText(D.agentDesc);
    await expect(now).toContainText('scout');
    await expect(now).toContainText('running');
    await expect(now.getByTestId('now-agent')).toHaveCount(1);

    // Done: the proven step shows its artifact, the other shows UNPROVEN.
    const done = section(page, 'done');
    const doneItems = done.getByTestId('done-item');
    await expect(doneItems).toHaveCount(2);
    await expect(doneItems.nth(0)).toContainText(D.stepOne);
    await expect(doneItems.nth(0)).toContainText(D.proof);
    await expect(doneItems.nth(0)).not.toContainText('UNPROVEN');
    await expect(doneItems.nth(1)).toContainText(D.stepTwo);
    await expect(doneItems.nth(1)).toContainText('UNPROVEN');

    // Ask: the open ask with its recommendation, the answered one dimmed with "answered?".
    const asks = section(page, 'ask').getByTestId('ask-item');
    await expect(asks).toHaveCount(2);
    await expect(asks.nth(0)).toContainText(D.openAsk);
    await expect(asks.nth(0)).toContainText(D.recommend);
    await expect(asks.nth(0)).not.toContainText('answered?');
    await expect(asks.nth(0)).not.toContainText('stale');
    await expect(asks.nth(0)).not.toContainText('[parsed]');
    await expect(asks.nth(1)).toContainText(D.answeredAsk);
    await expect(asks.nth(1)).toContainText('answered?');
    await expect(asks.nth(1)).toHaveAttribute('data-answered', 'true');
    await expect(asks.nth(0)).not.toHaveAttribute('data-answered', 'true');
    const opacity = (el: Locator) => el.evaluate((node) => Number(getComputedStyle(node).opacity));
    expect(await opacity(asks.nth(1)), 'the answered ask must be dimmed (opacity below 1)').toBeLessThan(1);
    expect(await opacity(asks.nth(0))).toBe(1);

    // Decisions: newest first.
    const decisions = section(page, 'decisions').getByTestId('decision-item');
    await expect(decisions).toHaveCount(2);
    await expect(decisions.nth(0)).toContainText(D.decNew);
    await expect(decisions.nth(1)).toContainText(D.decOld);

    // Health: ctx, cache saving, PR, agent cost (sum), session cost shown as a dash.
    const health = section(page, 'health');
    await expect(health.getByTestId('health-ctx')).toContainText('42%');
    await expect(health.getByTestId('health-cache')).toContainText('3.2');
    await expect(health.getByTestId('health-pr')).toHaveCount(1);
    await expect(health.getByTestId('health-pr')).toContainText('#1234 PENDING');
    const agentCost = health.getByTestId('health-agent-cost');
    await expect(agentCost).toContainText('1.75');
    await expect(agentCost).toContainText(/agents?/i);
    const sessionCost = health.getByTestId('health-session-cost');
    await expect(sessionCost).toContainText('not recorded');
    await expect(sessionCost).toContainText(/[-\u2013\u2014]/);
    await expect(sessionCost, 'agent cost is not the session cost').not.toContainText('1.75');
    await expect(health.getByTestId('health-limits')).toContainText('not recorded');

    // Footer: the full session id.
    const footer = panel.getByTestId('detail-footer');
    await expect(footer).toContainText('Same six sections as the terminal Pane.');
    await expect(footer).toContainText(`claude --resume ${live.id}`);

    // The selected card is marked.
    await expect(cardButton).toHaveAttribute('aria-pressed', 'true');

    await expect(page.getByText('Loading session')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// --- Spec 4: the URL ---------------------------------------------------------------------------

test.describe('URL state', () => {
  test('a tab and a selection write ?view and ?session without a reload or a history entry', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    await page.goto('/');
    await waitForHydration(page);
    expect(urlParam(page, 'view')).toBeNull();
    expect(urlParam(page, 'session')).toBeNull();
    // A marker on window dies with a full reload; history.length grows with pushState.
    const historyBefore = await page.evaluate(() => {
      (window as unknown as { __e2eMarker: number }).__e2eMarker = 1;
      return history.length;
    });

    await navTab(page, 'sessions').click();
    await expect.poll(() => urlParam(page, 'view')).toBe('sessions');
    expect(urlParam(page, 'session')).toBeNull();

    await sessionRow(page, live.id).getByTestId('session-row-select').click();
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);
    expect(urlParam(page, 'view')).toBe('sessions');
    await expect(detailPanel(page)).toBeVisible();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);

    const after = await page.evaluate(() => ({
      marker: (window as unknown as { __e2eMarker?: number }).__e2eMarker,
      length: history.length,
    }));
    expect(after.marker, 'the page reloaded: the window marker is gone').toBe(1);
    expect(after.length, 'the URL must change with replaceState, not pushState').toBe(historyBefore);
    expect(errors).toEqual([]);
  });

  test('a card click on Overview writes ?session only', async ({ page, request }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    await page.goto('/');
    await waitForHydration(page);
    await sessionCard(page, live.id).getByRole('button').click();
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);
    expect([null, 'overview']).toContain(urlParam(page, 'view'));
    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
  });

  test('/?view=sessions&session=<id> renders the Sessions view with the detail from the server', async ({
    page,
    request,
  }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    // The raw server HTML already holds the table header and the panel.
    const raw = await request.get(`/?view=sessions&session=${live.id}`);
    expect(raw.status()).toBeLessThan(400);
    const html = await raw.text();
    expect(html, 'server HTML must hold the Sessions table').toContain('Last seen');
    expect(html, 'server HTML must hold the detail panel').toContain('data-testid="session-detail"');

    // With the poll blocked, the detail can only come from the server render.
    await page.route('**/api/mission-control**', (route) => route.abort());
    await page.goto(`/?view=sessions&session=${live.id}`);
    await expect(navTab(page, 'sessions')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sessions-table')).toBeVisible();
    await expect(detailPanel(page)).toBeVisible();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    await expect(section(page, 'goal')).toContainText(D.title);
    await expect(sessionRow(page, live.id).getByTestId('session-row-select')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a view or session value of the wrong format is ignored', async ({ page, request }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    await page.goto('/?view=board&session=%3Cscript%3E');
    await waitForHydration(page);
    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect(detailPanel(page)).toHaveCount(0);
    await expect(page.getByTestId('detail-unavailable')).toHaveCount(0);
    await expect(page.getByText(/^Select a session/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

// --- Spec 5: the API ---------------------------------------------------------------------------

test.describe('GET /api/mission-control?session=<id>', () => {
  test('returns the SessionDetail DTO for a live session with a state file', async ({ request }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    const snapshot = await loadSnapshot(request, live.id);
    expect(snapshot.detail?.id).toBe(live.id);
    const detail = snapshot.detail as Detail;

    expect(detail).toMatchObject({
      id: live.id,
      shortId: live.id.slice(0, 8),
      chip: 'waiting-on-dave',
      availability: 'live',
      title: D.title,
      goal: D.goal,
      stopAt: D.stopAt,
      repo: D.repo,
      branch: D.branch,
      worktree: null,
      planSource: 'brief',
      planMore: 0,
      planDone: 2,
      planTotal: 3,
      unproven: 1,
      ctxPct: 42,
      sessionCost: null,
      limits: null,
      hasBrief: true,
    });
    expect(detail.name.endsWith(`/e2e/detail-branch/${live.id.slice(0, 4)}`)).toBe(true);
    expect(['green', 'amber']).toContain(detail.liveColour);
    expect(typeof detail.liveSecondsAgo).toBe('number');
    expect(Array.isArray(detail.laneIds)).toBe(true);
    expect(detail.stateAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(detail.stateAgeSeconds).toBeLessThan(120);

    expect(detail.steps).toEqual([
      { id: 'p1', text: D.stepOne, status: 'done' },
      { id: 'p2', text: D.stepTwo, status: 'done' },
      { id: 'p3', text: D.stepThree, status: 'doing' },
    ]);
    expect(detail.step).toMatchObject({ tool: 'Bash', label: D.toolLabel });
    expect(detail.step?.elapsedSeconds).toBeGreaterThanOrEqual(25);
    expect(detail.step?.elapsedSeconds).toBeLessThan(150);
    expect(detail.agents).toEqual([{ description: D.agentDesc, type: 'scout', status: 'running' }]);
    expect(detail.done).toEqual([
      { id: 'p1', text: D.stepOne, proof: { artifact: D.proof, kind: 'plan' } },
      { id: 'p2', text: D.stepTwo, proof: null },
    ]);
    expect(detail.asks).toEqual([
      {
        kind: 'question',
        text: D.openAsk,
        recommend: D.recommend,
        answered: false,
        stale: false,
        parsed: false,
      },
      {
        kind: 'question',
        text: D.answeredAsk,
        recommend: null,
        answered: true,
        stale: false,
        parsed: false,
      },
    ]);
    expect(detail.decisions.map((d) => d.text)).toEqual([D.decNew, D.decOld]);
    expect(detail.decisions[0]).toMatchObject({ by: 'claude' });
    expect(detail.decisions[0].ageSeconds).toBeGreaterThanOrEqual(590);
    expect(detail.decisions[0].ageSeconds).toBeLessThan(700);
    expect(detail.decisions[1].ageSeconds).toBeGreaterThanOrEqual(2 * HOUR - 10);
    expect(detail.cache).toMatchObject({ savedUsd: 3.2 });
    expect(typeof detail.cache?.hitPct).toBe('number');
    expect(detail.agentRuns).toEqual({ count: 2, running: 1, costUsd: 1.75 });
    expect(detail.prs).toEqual([{ pr: 1234, state: 'PENDING' }]);
  });

  test('without ?session the detail is null', async ({ request }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id);
    const snapshot = await loadSnapshot(request);
    expect(snapshot, 'the snapshot must carry a "detail" key').toHaveProperty('detail');
    expect(snapshot.detail).toBeNull();
  });

  const BAD_IDS = [
    'short',
    'not a valid id!!',
    'g'.repeat(20),
    'a'.repeat(65),
    '../../etc/passwd',
    "x'; DROP TABLE sessions;--",
  ];
  for (const bad of BAD_IDS) {
    test(`an id of the wrong format (${JSON.stringify(bad)}) gives 200 and a null detail`, async ({
      request,
    }) => {
      const response = await request.get('/api/mission-control', { params: { session: bad } });
      expect(response.status()).toBe(200);
      const snapshot = (await response.json()) as Snapshot;
      expect(snapshot, 'the snapshot must carry a "detail" key').toHaveProperty('detail');
      expect(snapshot.detail).toBeNull();
      expect(Array.isArray(snapshot.cards)).toBe(true);
    });
  }

  test('an unknown id, an ended id and a live id with no state file each give 200 and a null detail', async ({
    request,
  }) => {
    const live = await liveSession(request);
    const ended = await findEndedSessionId({ validFormat: true });
    expect(ended).not.toBe(live.id);
    const stranger = randomUUID();
    // Control: the live session has a state file, so a non-null detail proves the DTO runs.
    writeDetailFixture(live.id);
    // The others HAVE a state file, so only the session row decides.
    writeDetailFixture(stranger);
    writeDetailFixture(ended);
    expect((await loadDetail(request, live.id)).id).toBe(live.id);

    for (const id of [stranger, ended]) {
      const snapshot = await loadSnapshot(request, id);
      expect(snapshot, 'the snapshot must carry a "detail" key').toHaveProperty('detail');
      expect(snapshot.detail, `detail for ${id} must be null`).toBeNull();
    }

    clearStateDir();
    const noFile = await loadSnapshot(request, live.id);
    expect(noFile, 'the snapshot must carry a "detail" key').toHaveProperty('detail');
    expect(noFile.detail, 'a live session with no state file has no detail').toBeNull();
  });
});

// --- Spec 6: redaction in the detail -----------------------------------------------------------

test.describe('redaction in the detail', () => {
  test('secrets and absolute paths never reach the page, the HTML or the JSON', async ({
    page,
    request,
  }) => {
    const live = await liveSession(request);
    const secrets = {
      proof: fakeSecret('Proof'),
      decision: fakeSecret('Dec'),
      step: fakeSecret('Step'),
      agent: fakeSecret('Agent'),
      recommend: fakeSecret('Rec'),
    };
    expect(Object.values(secrets).every((s) => /^sk-[A-Za-z0-9]{30}$/.test(s))).toBe(true);
    const windowsPath = 'C:\\Users\\someone\\secret\\file.txt';

    writeDetailFixture(live.id, {
      step: step('Bash', `E2E label ${secrets.step}`, 30),
      agents: [agent(`E2E agent ${secrets.agent}`, 'scout', 'running')],
      brief: makeBrief({
        title: 'E2E redaction title',
        plan: [
          { id: 'p1', text: 'E2E redact step A', status: 'done' },
          { id: 'p2', text: 'E2E redact step B', status: 'done' },
          { id: 'p3', text: 'E2E redact step C', status: 'doing' },
        ],
        proofs: [
          { id: 'p1', artifact: `E2E log ${secrets.proof}`, at: Date.now(), subject: 'E2E redact step A', kind: 'plan' },
          { id: 'p2', artifact: `E2E saved at ${windowsPath}`, at: Date.now(), subject: 'E2E redact step B', kind: 'plan' },
        ],
        ask: [ask('E2E redact ask', `E2E use ${secrets.recommend}`)],
        decisions: [{ text: `E2E decided ${secrets.decision}`, by: 'dave', at: secondsAgo(300) }],
        updatedAt: secondsAgo(60),
      }),
    });

    // Present first: every check below is vacuous if the section never renders.
    await openByUrl(page, live.id, 'sessions');
    await waitForHydration(page);
    await expect(section(page, 'done')).toContainText('E2E redact step A');
    for (const name of ['done', 'decisions', 'now', 'ask']) {
      await expect(section(page, name), `${name} must show [REDACTED`).toContainText('[REDACTED');
    }
    await expect(section(page, 'done')).toContainText('<path>');
    await expect(section(page, 'done')).toContainText('E2E saved at');

    const pageText = await page.locator('body').innerText();
    const pageHtml = await page.content();
    const rawHtml = await (await request.get(`/?view=sessions&session=${live.id}`)).text();
    const apiDetail = await (
      await request.get(`/api/mission-control?session=${live.id}`)
    ).text();
    const apiList = await (await request.get('/api/mission-control')).text();
    expect(apiDetail, 'the detail JSON must hold the redacted marker').toContain('[REDACTED');
    expect(apiDetail).toContain('<path>');

    const bodies = { 'page text': pageText, 'page HTML': pageHtml, 'server HTML': rawHtml, 'detail JSON': apiDetail, 'list JSON': apiList };
    for (const [where, text] of Object.entries(bodies)) {
      for (const [field, secret] of Object.entries(secrets)) {
        for (const needle of [secret, secret.slice(3, 15)]) {
          expect(text, `${where} leaks the ${field} secret`).not.toContain(needle);
        }
      }
      expect(text, `${where} leaks the user name from the path`).not.toContain('someone');
      expect(text, `${where} leaks the file name from the path`).not.toContain('file.txt');
    }
    expect(pageText).not.toMatch(/C:\\Users/i);
  });
});

// --- Spec 7: the list payload stays small ------------------------------------------------------

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

test.describe('list payload size', () => {
  const DETAIL_ONLY_KEYS = ['agentRuns', 'decisions', 'proofs', 'steps', 'agents'];

  test('cards and ready carry no detail-only keys, with or without ?session', async ({ request }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    const plainResponse = await request.get('/api/mission-control');
    const plainText = await plainResponse.text();
    const plain = JSON.parse(plainText) as Snapshot;
    const withSession = await loadSnapshot(request, live.id);

    // Control: the fixture reached the list (a card and a ready item) and the detail.
    expect(plain.cards.some((c) => c.id === live.id)).toBe(true);
    expect(plain.ready.some((r) => r.sessionId === live.id)).toBe(true);
    expect(withSession.detail?.id).toBe(live.id);

    for (const [label, snap] of [['without', plain], ['with', withSession]] as const) {
      for (const part of ['cards', 'ready'] as const) {
        const keys = keysDeep(snap[part]);
        for (const banned of DETAIL_ONLY_KEYS) {
          expect(keys.has(banned), `${label} ?session: ${part} must not carry the key "${banned}"`).toBe(false);
        }
      }
    }

    // The detail-only strings are nowhere in the plain payload.
    for (const needle of [D.toolLabel, D.agentDesc, D.proof, D.decNew, D.decOld]) {
      expect(plainText, `plain payload leaks detail text "${needle}"`).not.toContain(needle);
    }

    // Only `detail` grows with ?session.
    expect(plain.detail).toBeNull();
    const detailKeys = keysDeep(withSession.detail);
    for (const wanted of ['steps', 'agents', 'agentRuns', 'decisions']) {
      expect(detailKeys.has(wanted), `detail must carry "${wanted}"`).toBe(true);
    }

    // The list part does not change shape: same keys per card and per ready item.
    const shape = (rows: object[]) => rows.map((r) => Object.keys(r).sort().join(','));
    expect(shape(withSession.cards)).toEqual(shape(plain.cards));
    expect(shape(withSession.ready)).toEqual(shape(plain.ready));
  });
});

// --- Spec 8: Session not available ----------------------------------------------------------

test.describe('Session not available', () => {
  const CASES: { reason: string; id: (request: APIRequestContext) => Promise<string>; file: boolean }[] = [
    { reason: 'unknown id', id: async () => randomUUID(), file: true },
    { reason: 'no state file', id: async (request) => (await liveSession(request)).id, file: false },
    { reason: 'ended', id: async () => findEndedSessionId({ validFormat: true }), file: true },
  ];

  for (const { reason, id, file } of CASES) {
    test(`a selection that is ${reason} shows the reason and no path`, async ({ page, request }) => {
      const errors = watchErrors(page);
      const target = await id(request);
      if (file) writeDetailFixture(target);

      await page.goto(`/?session=${target}`);
      const box = page.getByTestId('detail-unavailable');
      await expect(box).toBeVisible();
      await expect(box).toContainText('Session not available');
      await expect(box).toHaveAttribute('data-reason', reason);
      await expect(box).toContainText(reason);
      await expect(detailPanel(page)).toHaveCount(0);
      await expect(page.getByText('Loading session')).toHaveCount(0);

      // After the first client fetch the reason is still there, and a Close clears it.
      await waitForHydration(page);
      await expect(box).toHaveAttribute('data-reason', reason);
      const text = await page.locator('body').innerText();
      for (const fragment of pathFragments()) {
        expect(text, `page leaks "${fragment}"`).not.toContain(fragment);
      }
      expect(text).not.toContain(D.title);
      expect(text).not.toContain(D.goal);
      await box.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(box).toHaveCount(0);
      await expect.poll(() => urlParam(page, 'session')).toBeNull();
      expect(errors).toEqual([]);
    });
  }
});

// --- Spec 9: a state file of the old schema ---------------------------------------------------

test.describe('old-schema state file', () => {
  test('only sessionId and at: the card says No brief yet, every section shows its empty state', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeRaw(`${live.id}.json`, JSON.stringify({ sessionId: live.id, at: Date.now() }));

    const detail = await loadDetail(request, live.id);
    expect(detail).toMatchObject({
      hasBrief: false,
      chip: null,
      planSource: 'none',
      steps: [],
      step: null,
      agents: [],
      done: [],
      unproven: 0,
      asks: [],
      decisions: [],
      prs: [],
      ctxPct: null,
      cache: null,
      agentRuns: null,
    });

    await page.goto(`/?session=${live.id}`);
    await waitForHydration(page);
    await expect(sessionCard(page, live.id)).toContainText('No brief yet');

    const panel = detailPanel(page);
    await expect(panel).toBeVisible();
    await expect(section(page, 'goal')).toContainText('No brief yet');
    for (const name of ['plan', 'now', 'done', 'ask']) {
      await expect(
        section(page, name).getByTestId('section-empty'),
        `${name} must show its empty state`,
      ).toBeVisible();
    }
    await expect(section(page, 'health').getByTestId('health-ctx')).toContainText(/[-\u2013\u2014]/);
    await expect(section(page, 'health').getByTestId('health-session-cost')).toContainText('not recorded');
    await expect(section(page, 'health').getByTestId('health-pr')).toHaveCount(0);
    // Decisions has no content, so its heading is not drawn.
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText([
      'Goal',
      'Plan',
      'Now',
      'Done',
      'Ask',
      'Health',
    ]);
    await expect(section(page, 'decisions')).toHaveCount(0);
    await expect(panel.getByTestId('detail-footer')).toContainText(`claude --resume ${live.id}`);
    expect(errors).toEqual([]);
  });
});

// --- Spec 10: a quiet session ------------------------------------------------------------------

test.describe('quiet session', () => {
  test('its ask is in Ready for Dave with no card; clicking its name opens the detail', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const id = await findQuietSessionId({ validFormat: true });
    const QUIET_ASK = 'E2E quiet detail ask';
    writeState(id, {
      branch: 'e2e/quiet-branch',
      brief: makeBrief({
        title: 'E2E quiet detail title',
        ask: [ask(QUIET_ASK, 'E2E quiet detail recommend')],
        updatedAt: secondsAgo(300),
      }),
    });

    const snapshot = await loadSnapshot(request, id);
    expect(snapshot.cards.map((c) => c.id), 'a quiet session gets no card').not.toContain(id);
    expect(snapshot.detail?.id, 'a quiet session has a detail').toBe(id);
    expect(snapshot.detail?.availability).toBe('quiet');

    await page.goto('/');
    await waitForHydration(page);
    const item = readyItem(page, id);
    await expect(item).toBeVisible();
    await expect(sessionCard(page, id)).toHaveCount(0);
    await expect(detailPanel(page)).toHaveCount(0);

    const button = item.getByRole('button');
    await expect(button).toHaveCount(1);
    await button.click();

    const panel = detailPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-session-id', id);
    await expect(panel).toHaveAttribute('data-availability', 'quiet');
    await expect(section(page, 'goal')).toContainText('E2E quiet detail title');
    await expect(section(page, 'ask')).toContainText(QUIET_ASK);
    await expect(panel.getByTestId('detail-footer')).toContainText(`claude --resume ${id}`);
    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => urlParam(page, 'session')).toBe(id);
    expect(errors).toEqual([]);
  });
});

// --- Spec 11: click-through and Close ----------------------------------------------------------

test.describe('click-through', () => {
  test('a Ready for Dave name opens the detail on Overview; Close clears panel and URL', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id);
    const name = (await loadSnapshot(request)).ready.find((r) => r.sessionId === live.id)?.name;
    expect(name, 'ready must hold the fixture ask').toBeDefined();

    // Start in Sessions: the click must switch the view to Overview (design).
    await page.goto('/?view=sessions');
    await waitForHydration(page);
    await expect(navTab(page, 'sessions')).toHaveAttribute('aria-current', 'page');
    await expect(detailPanel(page)).toHaveCount(0);

    const button = readyItem(page, live.id).getByRole('button');
    await expect(button, 'a ready item holds exactly one button: the session name').toHaveCount(1);
    await expect(button).toHaveAccessibleName(name as string);
    await button.click();

    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sessions-table')).toHaveCount(0);
    await expect(detailPanel(page)).toBeVisible();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    await expect(section(page, 'goal')).toContainText(D.title);
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);
    expect([null, 'overview']).toContain(urlParam(page, 'view'));

    await detailPanel(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(detailPanel(page)).toHaveCount(0);
    await expect(page.getByText(/^Select a session/)).toBeVisible();
    await expect.poll(() => urlParam(page, 'session')).toBeNull();
    // Ready for Dave still lists the ask: Close clears the selection only.
    await expect(readyItem(page, live.id)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a session card is one button: aria-pressed follows the selection, Close clears it', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const live = await liveSession(request);
    writeDetailFixture(live.id);

    await page.goto('/');
    await waitForHydration(page);
    const button = sessionCard(page, live.id).getByRole('button');
    await expect(button, 'a card holds exactly one button: no nested interactive').toHaveCount(1);
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);

    await detailPanel(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(detailPanel(page)).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => urlParam(page, 'session')).toBeNull();
    expect(errors).toEqual([]);
  });
});

// --- Spec 12: stale and parsed asks in the detail ---------------------------------------------

test.describe('ask flags in the detail', () => {
  test('an ask older than 24 h shows as stale in the Ask section', async ({ page, request }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id, {
      brief: makeBrief({
        title: 'E2E stale detail',
        ask: [ask('E2E stale detail ask', 'E2E stale detail recommend')],
        updatedAt: secondsAgo(25 * HOUR),
      }),
    });

    const detail = await loadDetail(request, live.id);
    expect(detail.availability, 'a stale brief does not make the session unavailable').toBe('live');
    expect(detail.asks).toHaveLength(1);
    expect(detail.asks[0]).toMatchObject({ text: 'E2E stale detail ask', stale: true, answered: false });

    await openByUrl(page, live.id);
    const asks = section(page, 'ask').getByTestId('ask-item');
    await expect(asks).toHaveCount(1);
    await expect(asks.first()).toContainText('E2E stale detail ask');
    await expect(asks.first()).toContainText('stale');
    await expect(asks.first()).not.toContainText('[parsed]');
    await expect(readyItem(page, live.id), 'a stale ask stays out of the strip').toHaveCount(0);
  });

  test('an ask read from the turn text (source parsed) shows [parsed], and is not stale', async ({
    page,
    request,
  }) => {
    const live = await liveSession(request);
    writeDetailFixture(live.id, {
      brief: makeBrief({
        title: 'E2E parsed detail',
        ask: [
          ask('E2E parsed detail ask', undefined, { source: 'parsed' }),
          ask('E2E set detail ask'),
        ],
        updatedAt: secondsAgo(60),
      }),
    });

    const detail = await loadDetail(request, live.id);
    expect(detail.asks.map((a) => [a.text, a.parsed, a.stale])).toEqual([
      ['E2E parsed detail ask', true, false],
      ['E2E set detail ask', false, false],
    ]);

    await openByUrl(page, live.id);
    const asks = section(page, 'ask').getByTestId('ask-item');
    await expect(asks).toHaveCount(2);
    await expect(asks.nth(0)).toContainText('E2E parsed detail ask');
    await expect(asks.nth(0)).toContainText('[parsed]');
    await expect(asks.nth(0)).not.toContainText('stale');
    await expect(asks.nth(1)).toContainText('E2E set detail ask');
    await expect(asks.nth(1)).not.toContainText('[parsed]');
  });
});
