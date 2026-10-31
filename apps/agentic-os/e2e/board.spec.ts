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
  makeBrief,
  secondsAgo,
  SESSION_ID_FORMAT,
  writeState,
} from './state-fixture';

/**
 * End-to-end check for P1b part B2, the read-only lane Board. Design contract:
 * .claudedocs/2026-10-28-p1b-b2-design.md (sections "URL and endpoint", "LaneBoard DTO",
 * "Board UI").
 *
 * READ-ONLY toward the app: the specs only GET and click. The app role cannot insert lane rows,
 * so the specs read the REAL lanes through GET /api/mission-control?view=board and compare the
 * page to that response. A missing precondition FAILS with a message that says so. Nothing in
 * this file is skipped. The only writes are fixture state files in the private E2E state dir,
 * emptied before and after every test. Nothing is ever written to agentic_os.lane.
 *
 * UI contract (testids) the implementation must meet:
 *   work-board            the panel (a <section>, not an <article>)
 *   board-header          the panel header: "Work board" and "lane states" left,
 *                         "read-only in P1" and "drag to move in P2" right
 *   board-column          one per state, attribute data-state="<state>", six in API order
 *   board-column-heading  the state name, lowercase, exactly (an h3)
 *   board-column-count    "N", or "10 of 37" when shown < count
 *   board-column-empty    text "empty"; present only when the column has no lane
 *   board-lane            one card per lane, attribute data-lane-id (a <div>, not an <article>)
 *   board-lane-id         the lane id
 *   board-lane-title      the title
 *   board-lane-owner      only with an owner: short id + state word; data-owner-state="<word>"
 *   board-lane-lease      only when the lease lapsed: text "lease lapsed"
 *   board-lane-branch     only when the branch is non-empty: the branch text
 *   board-loading         "Loading board" while data.board is null
 *   board-error           the error line when board.status is "error"
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

const LIVE_UNDER_SECONDS = 900;
const STATES = ['backlog', 'ready', 'active', 'blocked', 'review', 'done'] as const;
const OWNER_WORDS = ['live', 'quiet', 'ended', 'unknown'] as const;

// --- Shapes read from /api/mission-control -------------------------------------------------

type BoardLane = {
  id: string;
  title: string;
  branch: string | null;
  ownerShortId: string | null;
  owner: (typeof OWNER_WORDS)[number] | null;
  leaseLapsed: boolean;
  track: string | null;
};

type BoardColumn = {
  state: (typeof STATES)[number];
  count: number;
  shown: number;
  lanes: BoardLane[];
};

type LaneBoard = {
  status: 'ok' | 'error';
  error: string | null;
  columns: BoardColumn[];
  total: number;
};

type Snapshot = {
  active: { sessions: { id: string; liveSecondsAgo: number }[] };
  board: LaneBoard | null;
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

async function loadSnapshot(request: APIRequestContext, query = ''): Promise<Snapshot> {
  const response = await request.get(`/api/mission-control${query}`);
  expect(response.status(), `GET /api/mission-control${query} must return 200`).toBe(200);
  return (await response.json()) as Snapshot;
}

/** The board from the API. Fails with a clear message when the precondition is not met. */
async function loadBoard(request: APIRequestContext): Promise<LaneBoard> {
  const snapshot = await loadSnapshot(request, '?view=board');
  const board = snapshot.board;
  expect(board, 'GET /api/mission-control?view=board must return a non-null "board"').not.toBeNull();
  expect(
    board?.status,
    `board.status must be "ok" (error was: ${String(board?.error)})`,
  ).toBe('ok');
  expect(
    board?.total,
    'Precondition: agentic_os.lane needs at least one row (the app role cannot insert one). ' +
      `Found ${String(board?.total)}. Claim a lane with scripts/coordination/lane.mjs and run again.`,
  ).toBeGreaterThanOrEqual(1);
  return board as LaneBoard;
}

async function liveSession(request: APIRequestContext): Promise<{ id: string }> {
  const snapshot = await loadSnapshot(request);
  const live = snapshot.active.sessions.filter(
    (s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS && SESSION_ID_FORMAT.test(s.id),
  );
  expect(
    live.length,
    `Precondition: the database needs a live session (liveSecondsAgo < ${LIVE_UNDER_SECONDS}) ` +
      `whose id matches ${SESSION_ID_FORMAT}. Found ${live.length}. Open a Claude Code session and run again.`,
  ).toBeGreaterThanOrEqual(1);
  return live[0];
}

const navTab = (page: Page, tab: string): Locator =>
  page.getByTestId('nav-tabs').locator(`[data-testid="nav-tab"][data-tab="${tab}"]`);
const boardPanel = (page: Page): Locator => page.getByTestId('work-board');
const detailPanel = (page: Page): Locator => page.getByTestId('session-detail');

const urlParam = (page: Page, key: string): string | null =>
  new URL(page.url()).searchParams.get(key);

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

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

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Open the Board by URL and wait for the panel. */
async function openBoard(page: Page): Promise<void> {
  await page.goto('/?view=board');
  await waitForHydration(page);
  await expect(boardPanel(page)).toBeVisible();
  await expect(page.getByTestId('board-loading')).toHaveCount(0);
}

// --- The page, read back as data -------------------------------------------------------------

type DomLane = {
  id: string;
  title: string;
  branch: string | null;
  ownerText: string | null;
  ownerState: string | null;
  lapsed: boolean;
};

type DomColumn = {
  state: string | null;
  heading: string;
  count: string;
  empty: string | null;
  lanes: DomLane[];
};

/** Every column and card on the page, in DOM order. One round trip, so a poll cannot tear. */
async function readBoard(page: Page): Promise<DomColumn[]> {
  return boardPanel(page).evaluate((root) => {
    const clean = (text: string | null | undefined): string =>
      (text ?? '').replace(/\s+/g, ' ').trim();
    const one = (parent: Element, id: string): Element | null =>
      parent.querySelector(`[data-testid="${id}"]`);
    const text = (parent: Element, id: string): string | null => {
      const found = one(parent, id);
      return found === null ? null : clean(found.textContent);
    };
    return Array.from(root.querySelectorAll('[data-testid="board-column"]')).map((column) => ({
      state: column.getAttribute('data-state'),
      heading: text(column, 'board-column-heading') ?? '',
      count: text(column, 'board-column-count') ?? '',
      empty: text(column, 'board-column-empty'),
      lanes: Array.from(column.querySelectorAll('[data-testid="board-lane"]')).map((lane) => ({
        id: lane.getAttribute('data-lane-id') ?? '',
        title: text(lane, 'board-lane-title') ?? '',
        branch: text(lane, 'board-lane-branch'),
        ownerText: text(lane, 'board-lane-owner'),
        ownerState: one(lane, 'board-lane-owner')?.getAttribute('data-owner-state') ?? null,
        lapsed: one(lane, 'board-lane-lease') !== null,
      })),
    }));
  });
}

function countText(column: BoardColumn): string {
  return column.shown < column.count ? `${column.shown} of ${column.count}` : String(column.count);
}

/**
 * Poll until `compare(dom, api)` is empty. The API is fetched again on every try, so a lane
 * another session changes between two reads cannot fail the spec; a real mismatch still does.
 */
async function expectPageMatchesApi(
  page: Page,
  request: APIRequestContext,
  compare: (dom: DomColumn[], api: LaneBoard) => string[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const problems = compare(await readBoard(page), await loadBoard(request));
        return problems.length === 0 ? 'match' : problems.slice(0, 8).join(' | ');
      },
      { timeout: 20_000, message: 'the Board on the page must match GET ?view=board' },
    )
    .toBe('match');
}

// --- Spec 1: tab, URL, server render -------------------------------------------------------------

test.describe('Board tab and URL', () => {
  test('the Board tab is enabled; a click makes it active and writes ?view=board without a reload', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    await loadBoard(request);
    await page.goto('/');
    await waitForHydration(page);

    const tab = navTab(page, 'board');
    await expect(tab).toBeEnabled();
    expect(await tab.getAttribute('disabled'), 'Board must not carry the disabled attribute').toBeNull();
    await expect(tab.getByTestId('nav-tab-tag')).toHaveCount(0);
    await expect(boardPanel(page)).toHaveCount(0);

    // A marker on window dies with a full reload; history.length grows with pushState.
    const historyBefore = await page.evaluate(() => {
      (window as unknown as { __e2eMarker: number }).__e2eMarker = 1;
      return history.length;
    });

    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(navTab(page, 'overview')).not.toHaveAttribute('aria-current', 'page');
    await expect.poll(() => urlParam(page, 'view')).toBe('board');
    await expect(boardPanel(page)).toBeVisible();
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    await expect(page.getByTestId('board-loading')).toHaveCount(0);

    const after = await page.evaluate(() => ({
      marker: (window as unknown as { __e2eMarker?: number }).__e2eMarker,
      length: history.length,
    }));
    expect(after.marker, 'the page reloaded: the window marker is gone').toBe(1);
    expect(after.length, 'the URL must change with replaceState, not pushState').toBe(historyBefore);
    expect(errors).toEqual([]);
  });

  test('/?view=board renders the Board from the server, with the API blocked', async ({
    page,
    request,
  }) => {
    await loadBoard(request);

    // The raw server HTML already holds the panel and the six columns.
    const raw = await request.get('/?view=board');
    expect(raw.status()).toBeLessThan(400);
    const html = await raw.text();
    expect(html, 'server HTML must hold the Board panel').toContain('data-testid="work-board"');
    expect(html.match(/data-testid="board-column"/g)?.length, 'server HTML must hold six columns').toBe(6);

    // With the poll blocked, the Board can only come from the server render.
    await page.route('**/api/mission-control**', (route) => route.abort());
    await page.goto('/?view=board');
    await expect(navTab(page, 'board')).toHaveAttribute('aria-current', 'page');
    await expect(boardPanel(page)).toBeVisible();
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    await expect(page.getByTestId('board-loading')).toHaveCount(0);
    await expect(page.getByTestId('board-column-heading')).toHaveText([...STATES]);
    await expect(page.getByTestId('board-lane').first()).toBeVisible();
  });
});

// --- Spec 2: the API ---------------------------------------------------------------------------

test.describe('GET /api/mission-control?view=board', () => {
  test('returns the LaneBoard: six columns in order, counts that add up, done capped at 10', async ({
    request,
  }) => {
    const snapshot = await loadSnapshot(request, '?view=board');
    const board = await loadBoard(request);
    expect(snapshot).toHaveProperty('board');

    expect(Object.keys(board).sort()).toEqual(['columns', 'error', 'status', 'total']);
    expect(board.error).toBeNull();
    expect(board.columns.map((c) => c.state)).toEqual([...STATES]);

    let sum = 0;
    for (const column of board.columns) {
      expect(Object.keys(column).sort(), `column ${column.state} keys`).toEqual([
        'count',
        'lanes',
        'shown',
        'state',
      ]);
      expect(column.shown, `${column.state}: shown must equal the lanes returned`).toBe(
        column.lanes.length,
      );
      expect(column.count, `${column.state}: count must not be below shown`).toBeGreaterThanOrEqual(
        column.shown,
      );
      if (column.state === 'done') {
        expect(column.shown, 'done shows at most 10 lanes').toBeLessThanOrEqual(10);
      } else {
        expect(column.shown, `${column.state} is not capped`).toBe(column.count);
      }
      sum += column.count;
    }
    expect(sum, 'column counts must sum to board.total').toBe(board.total);

    const ids = board.columns.flatMap((c) => c.lanes.map((l) => l.id));
    expect(new Set(ids).size, 'a lane must sit in exactly one column').toBe(ids.length);

    for (const lane of board.columns.flatMap((c) => c.lanes)) {
      expect(Object.keys(lane).sort(), `lane ${lane.id} keys`).toEqual([
        'branch',
        'id',
        'leaseLapsed',
        'owner',
        'ownerShortId',
        'title',
        'track',
      ]);
      expect(typeof lane.leaseLapsed).toBe('boolean');
      if (lane.owner === null) {
        expect(lane.ownerShortId, `lane ${lane.id}: no owner means no short id`).toBeNull();
        expect(lane.leaseLapsed, `lane ${lane.id}: no owner means no lapsed lease`).toBe(false);
      } else {
        expect(OWNER_WORDS, `lane ${lane.id} owner state`).toContain(lane.owner);
        expect(lane.ownerShortId?.length ?? 0, `lane ${lane.id}: short id, never a full id`).toBeGreaterThan(0);
        expect(lane.ownerShortId?.length ?? 99).toBeLessThanOrEqual(12);
      }
    }
  });

  test('without ?view=board, or with a wrong value, board is null and the status is 200', async ({
    request,
  }) => {
    // Control: the param works, so a null below is not "the feature is absent".
    await loadBoard(request);

    for (const query of ['', '?view=overview', '?view=sessions', '?view=nope', '?view=']) {
      const snapshot = await loadSnapshot(request, query);
      expect(snapshot, `${query || '(no param)'}: the snapshot must carry a "board" key`).toHaveProperty('board');
      expect(snapshot.board, `${query || '(no param)'}: board must be null`).toBeNull();
    }
  });

  test('?view=board&session=<id> returns both the board and the detail', async ({ request }) => {
    const live = await liveSession(request);
    writeState(live.id, {
      repo: 'e2e-repo',
      branch: 'e2e/board-both',
      brief: makeBrief({ title: 'E2E board and detail', updatedAt: secondsAgo(60) }),
    });

    const snapshot = await loadSnapshot(request, `?view=board&session=${live.id}`);
    expect(snapshot.detail?.id, 'the detail must still come back next to the board').toBe(live.id);
    expect(snapshot.board?.status).toBe('ok');
    expect(snapshot.board?.columns.map((c) => c.state)).toEqual([...STATES]);

    const detailOnly = await loadSnapshot(request, `?session=${live.id}`);
    expect(detailOnly.detail?.id).toBe(live.id);
    expect(detailOnly.board, 'session alone must not compute the board').toBeNull();
  });
});

// --- Spec 3 and 4: the page matches the API ----------------------------------------------------

test.describe('the Board on the page', () => {
  test('every column: heading, count text and lane ids in API order; each lane once; empty columns say empty', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    await loadBoard(request);
    await openBoard(page);

    await expect(page.getByTestId('board-column-heading')).toHaveText([...STATES]);

    await expectPageMatchesApi(page, request, (dom, api) => {
      const problems: string[] = [];
      if (dom.length !== 6) problems.push(`page has ${dom.length} columns, wanted 6`);
      api.columns.forEach((column, index) => {
        const got = dom[index];
        if (!got) return;
        if (got.state !== column.state) problems.push(`column ${index} data-state ${got.state} != ${column.state}`);
        if (got.heading !== column.state) problems.push(`column ${index} heading "${got.heading}" != "${column.state}"`);
        if (got.count !== countText(column)) {
          problems.push(`${column.state} count "${got.count}" != "${countText(column)}"`);
        }
        const gotIds = got.lanes.map((l) => l.id);
        const wantIds = column.lanes.map((l) => norm(l.id));
        if (JSON.stringify(gotIds) !== JSON.stringify(wantIds)) {
          problems.push(`${column.state} lanes [${gotIds.join(',')}] != [${wantIds.join(',')}]`);
        }
        const wantEmpty = column.lanes.length === 0 ? 'empty' : null;
        if (got.empty !== wantEmpty) problems.push(`${column.state} empty marker "${got.empty}" != "${wantEmpty}"`);
      });
      const all = dom.flatMap((c) => c.lanes.map((l) => l.id));
      if (new Set(all).size !== all.length) problems.push('a lane appears in more than one column');
      return problems;
    });

    // The id element carries the same text as the card attribute.
    const shownIds = await page.getByTestId('board-lane-id').allInnerTexts();
    const attrIds = await page
      .getByTestId('board-lane')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-lane-id')));
    expect(shownIds.map(norm)).toEqual(attrIds);
    expect(errors).toEqual([]);
  });

  test('lane cards: id, title, branch, owner short id and state word, "lease lapsed" only when lapsed', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const board = await loadBoard(request);
    const lanes = board.columns.flatMap((c) => c.lanes);
    const withOwner = lanes.filter((l) => l.owner !== null);
    const lapsed = lanes.filter((l) => l.leaseLapsed);
    const withBranch = lanes.filter((l) => l.branch);
    const notes: string[] = [];
    if (withOwner.length === 0) {
      notes.push(
        `No lane has an owner (${lanes.length} lanes shown): only the no-owner case was tested. ` +
          'The owner text, the state word and the lease cases are NOT covered.',
      );
    } else if (lapsed.length === 0) {
      notes.push('No lane has a lapsed lease: "lease lapsed" was only checked as absent on every card.');
    }
    if (withOwner.length === lanes.length) notes.push('Every lane has an owner: the no-owner case was not covered.');
    if (withBranch.length === 0) notes.push('No lane has a branch: the branch line was only checked as absent.');
    for (const description of notes) test.info().annotations.push({ type: 'note', description });

    await openBoard(page);
    await expectPageMatchesApi(page, request, (dom, api) => {
      const problems: string[] = [];
      const byId = new Map(dom.flatMap((c) => c.lanes).map((l) => [l.id, l]));
      for (const lane of api.columns.flatMap((c) => c.lanes)) {
        const card = byId.get(norm(lane.id));
        if (!card) {
          problems.push(`${lane.id}: no card`);
          continue;
        }
        if (card.title !== norm(lane.title)) problems.push(`${lane.id}: title "${card.title}" != "${norm(lane.title)}"`);
        const wantBranch = lane.branch ? norm(lane.branch) : null;
        if (card.branch !== wantBranch) problems.push(`${lane.id}: branch "${card.branch}" != "${wantBranch}"`);
        if (card.lapsed !== lane.leaseLapsed) problems.push(`${lane.id}: lease lapsed ${card.lapsed} != ${lane.leaseLapsed}`);
        if (lane.owner === null) {
          if (card.ownerText !== null) problems.push(`${lane.id}: owner text "${card.ownerText}" shown with no owner`);
        } else if (card.ownerText === null) {
          problems.push(`${lane.id}: owner ${lane.ownerShortId} ${lane.owner} not shown`);
        } else {
          if (!card.ownerText.includes(lane.ownerShortId ?? '\u0000')) {
            problems.push(`${lane.id}: owner text "${card.ownerText}" lacks short id ${lane.ownerShortId}`);
          }
          if (!new RegExp(`\\b${lane.owner}\\b`).test(card.ownerText)) {
            problems.push(`${lane.id}: owner text "${card.ownerText}" lacks the word ${lane.owner}`);
          }
          if (card.ownerState !== lane.owner) {
            problems.push(`${lane.id}: data-owner-state "${card.ownerState}" != ${lane.owner}`);
          }
        }
      }
      return problems;
    });

    // The cards use no <article> (smoke.spec.ts takes the first article as a project card).
    await expect(boardPanel(page).locator('article')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a lane with an owner shows the owner text next to the id; the first one is read in detail', async ({
    page,
    request,
  }) => {
    const board = await loadBoard(request);
    const owned = board.columns.flatMap((c) => c.lanes).find((l) => l.owner !== null);
    if (owned === undefined) {
      test.info().annotations.push({
        type: 'note',
        description: 'No lane has an owner: this spec has nothing to read. The no-owner case is covered above.',
      });
      return;
    }
    await openBoard(page);
    const card = page.locator(`[data-testid="board-lane"][data-lane-id="${owned.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('board-lane-id')).toHaveText(owned.id);
    await expect(card.getByTestId('board-lane-title')).toHaveText(owned.title);
    const owner = card.getByTestId('board-lane-owner');
    await expect(owner).toContainText(owned.ownerShortId as string);
    await expect(owner).toContainText(owned.owner as string);
    await expect(owner).toHaveAttribute('data-owner-state', owned.owner as string);
    if (owned.leaseLapsed) {
      await expect(card.getByTestId('board-lane-lease')).toHaveText('lease lapsed');
    } else {
      await expect(card.getByTestId('board-lane-lease')).toHaveCount(0);
      await expect(card).not.toContainText('lease lapsed');
    }
  });

  test('the panel header reads Work board and read-only in P1', async ({ page, request }) => {
    await loadBoard(request);
    await openBoard(page);
    const header = page.getByTestId('board-header');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Work board');
    await expect(header).toContainText('lane states');
    await expect(header).toContainText('read-only in P1');
    await expect(header).toContainText('drag to move in P2');
  });

  test('no card is draggable and no card holds a button or a link (read-only)', async ({ page, request }) => {
    await loadBoard(request);
    await openBoard(page);
    await expect(boardPanel(page).locator('[draggable="true"]')).toHaveCount(0);
    await expect(boardPanel(page).locator('[data-testid="board-lane"] button, [data-testid="board-lane"] a')).toHaveCount(0);
  });
});

// --- Spec 5: no path, no private key ----------------------------------------------------------

test.describe('nothing private reaches the Board', () => {
  test('no absolute path or home dir in the Board text or JSON; no scope, note or rationale key', async ({
    page,
    request,
  }) => {
    const board = await loadBoard(request);
    const json = JSON.stringify(board);

    await openBoard(page);
    const text = await boardPanel(page).innerText();
    const html = await boardPanel(page).evaluate((el) => el.outerHTML);
    // Control: the Board has real content, so the checks below are not vacuous.
    expect(text).toContain('Work board');
    expect(text.length).toBeGreaterThan(40);

    const forbidden = [/C:\\+Users/i, /\/home\//, /\/Users\//, /\\\\Users\\/i];
    for (const [where, body] of Object.entries({ 'board JSON': json, 'Board text': text, 'Board HTML': html })) {
      for (const pattern of forbidden) {
        expect(body, `${where} matches ${pattern}`).not.toMatch(pattern);
      }
    }

    const keys = keysDeep(board);
    for (const banned of ['scope', 'note', 'rationale', 'holder', 'holderSessionId', 'ownerSessionId', 'owner_session_id']) {
      expect(keys.has(banned), `board JSON must not carry the key "${banned}"`).toBe(false);
    }
  });
});

// --- Spec 7: phone width ----------------------------------------------------------------------

test.describe('layout', () => {
  test('no horizontal page scroll on the Board; every column sits inside the viewport', async ({
    page,
    request,
  }, testInfo) => {
    await loadBoard(request);
    if (testInfo.project.name === 'phone') {
      expect(page.viewportSize()?.width).toBe(390);
    }
    await openBoard(page);
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    expect(await horizontalOverflow(page), 'the Board is wider than the viewport').toBeLessThanOrEqual(0);

    const width = page.viewportSize()?.width ?? 0;
    const boxes = await page
      .getByTestId('board-column')
      .evaluateAll((els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect();
          return { left: box.left, right: box.right };
        }),
      );
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box.left, 'a column starts left of the viewport').toBeGreaterThanOrEqual(-1);
      expect(box.right, 'a column ends right of the viewport').toBeLessThanOrEqual(width + 1);
    }
  });
});

test.describe('column count', () => {
  const lefts = () =>
    [...document.querySelectorAll('[data-testid="board-column"]')].map((el) => {
      const { left, top } = el.getBoundingClientRect();
      return { left: Math.round(left), top: Math.round(top) };
    });

  test('at 1440 px the six columns sit in one row', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'desktop width only');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loadBoard(request);
    await openBoard(page);
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    const boxes = await page.evaluate(lefts);
    expect(new Set(boxes.map((b) => b.left)).size, 'six distinct left edges').toBe(6);
    expect(new Set(boxes.map((b) => b.top)).size, 'one row').toBe(1);
  });

  test('on a phone the columns stack in one column', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    await loadBoard(request);
    await openBoard(page);
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    const boxes = await page.evaluate(lefts);
    expect(new Set(boxes.map((b) => b.left)).size, 'one left edge').toBe(1);
    expect(await horizontalOverflow(page), 'the Board is wider than the viewport').toBeLessThanOrEqual(0);
  });
});

// --- Spec 8: the selection survives the Board ----------------------------------------------------

test.describe('selection and the Board', () => {
  test('a selected session stays in the URL across Board and back; the client asks for view=board and session', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    await loadBoard(request);
    const live = await liveSession(request);
    writeState(live.id, {
      repo: 'e2e-repo',
      branch: 'e2e/board-select',
      brief: makeBrief({
        title: 'E2E board selection',
        ask: [ask('E2E board selection ask')],
        updatedAt: secondsAgo(60),
      }),
    });

    await page.goto('/');
    await waitForHydration(page);
    await page.locator(`[data-testid="session-card"][data-session-id="${live.id}"]`).getByRole('button').click();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    await expect.poll(() => urlParam(page, 'session')).toBe(live.id);

    const boardRequest = page.waitForRequest(
      (req) => {
        const url = new URL(req.url());
        return (
          url.pathname === '/api/mission-control' &&
          url.searchParams.get('view') === 'board' &&
          url.searchParams.get('session') === live.id
        );
      },
      { timeout: 15_000 },
    );
    await navTab(page, 'board').click();
    await boardRequest;
    await expect(boardPanel(page)).toBeVisible();
    await expect(page.getByTestId('board-loading')).toHaveCount(0);
    expect(urlParam(page, 'view')).toBe('board');
    expect(urlParam(page, 'session'), 'Board must keep ?session').toBe(live.id);

    await navTab(page, 'overview').click();
    await expect(navTab(page, 'overview')).toHaveAttribute('aria-current', 'page');
    await expect(boardPanel(page)).toHaveCount(0);
    await expect(detailPanel(page)).toBeVisible();
    await expect(detailPanel(page)).toHaveAttribute('data-session-id', live.id);
    expect(urlParam(page, 'session')).toBe(live.id);
    expect([null, 'overview']).toContain(urlParam(page, 'view'));
    expect(errors).toEqual([]);
  });
});
