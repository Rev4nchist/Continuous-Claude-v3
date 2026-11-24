import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { Client } from 'pg';

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
 * PER-BOARD FILTER (describe "one board per view"). The board shown is one project_key (default
 * continuous-claude; `?project=<key>` picks another). Those specs need two boards with a lane each.
 * The harness (never this file) seeds them with lane.mjs on a SCRATCH database and the app must read
 * that database, never the live one:
 *   E2E_BOARD_DEFAULT_LANE   id of a lane on the continuous-claude board
 *   E2E_BOARD_OTHER          key of a second registered board (e.g. zz-pbprobe-a)
 *   E2E_BOARD_OTHER_LANE     id of a lane on that second board (e.g. zz-pbprobe-a1)
 * A missing variable FAILS the spec with a message that names it. Nothing is skipped.
 *
 * UI contract (testids) the implementation must meet:
 *   work-board            the panel (a <section>, not an <article>)
 *   board-header          the panel header: "Work board", the board key and "lane states" left,
 *                         "read-only in P1" and "drag to move in P2" right
 *   board-key             the left header text; attribute data-board="<board key>"
 *   board-scope-note      one line: the board lists one project_key; the active-lanes tile counts all boards
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
 *   board-lane-band       only with a band: P0, P1 or P2; data-band
 *   board-lane-due        only with a due time, and never on a done lane or an acked reminder: "due <Central time text>"
 *   board-lane-parked     only when parked (an owner and a lease over 91.5 minutes): "parked to <time>"
 *   board-lane-waits      only with open dependencies: "waits on: <ids>"; data-waits-on is the ids, comma separated
 *   board-lane-reclaimable only when an owner holds the lane and the lane CLI rule says reclaimable
 *
 * LANE COORDINATION (describe "lane coordination", lane fleet-coord-views): the rules of the lane CLI as the page shows them.
 * Those specs need the SCRATCH database seeded by C:/Users/dkhay/continuous-claude/.claudedocs/e2e-fleet-coord-views/harness/
 * run-scratch.mjs (it passes the scratch url, the E2E_BOARD_* and the E2E_COORD_* variables). A missing variable FAILS the spec.
 * The rules are copied from scripts/coordination; e2e/lane-coord-drift.spec.ts pins the text, these specs pin the behaviour.
 *   ready-coord           the "From the lane board" section, a sibling of ready-for-dave
 *   ready-coord-item      one row; data-kind is unread, park or reminder; no button, no link, no data-session-id
 *   ready-coord-empty     the one line "Nothing from the lane board." when there are no rows
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
  band: 'P0' | 'P1' | 'P2' | null;
  due: string | null;
  parkedUntil: string | null;
  reclaimable: boolean;
  waitsOn: string[];
  waitsOnMore: number;
};

type CoordRow = {
  kind: 'unread' | 'park' | 'reminder';
  text: string;
  shortId?: string;
  count?: number;
  laneId?: string;
  board?: string;
  title?: string;
};

type Coord = { status: 'ok' | 'error'; error: string | null; rows: CoordRow[]; truncated: boolean; nowEpoch: number | null };

type BoardColumn = {
  state: (typeof STATES)[number];
  count: number;
  shown: number;
  lanes: BoardLane[];
};

type LaneBoard = {
  board: string;
  status: 'ok' | 'error';
  error: string | null;
  columns: BoardColumn[];
  total: number;
};

type Snapshot = {
  coord: Coord;
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

    expect(Object.keys(board).sort()).toEqual(['board', 'columns', 'error', 'status', 'total', 'truncated']);
    expect(board.board, 'no ?project: the default board').toBe('continuous-claude');
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
        'band',
        'branch',
        'due',
        'id',
        'leaseLapsed',
        'owner',
        'ownerShortId',
        'parkedUntil',
        'reclaimable',
        'title',
        'track',
        'waitsOn',
        'waitsOnMore',
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
    await expect(header).toContainText('continuous-claude');
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

// --- Spec 9: one board per view (?project=<key>) ------------------------------------------------

const DEFAULT_BOARD = 'continuous-claude';

/** A variable of the seeded two-board scratch run. Fails with a message that names it. */
function seeded(name: 'E2E_BOARD_DEFAULT_LANE' | 'E2E_BOARD_OTHER' | 'E2E_BOARD_OTHER_LANE'): string {
  const value = process.env[name];
  expect(
    value,
    `Precondition: ${name} is not set. Seed two boards with lane.mjs on a SCRATCH database, point ` +
      'AGENTIC_OS_DATABASE_URL at it, and set E2E_BOARD_DEFAULT_LANE, E2E_BOARD_OTHER, E2E_BOARD_OTHER_LANE.',
  ).toBeTruthy();
  return value as string;
}

const laneIds = (board: LaneBoard | null): string[] =>
  (board?.columns ?? []).flatMap((c) => c.lanes.map((l) => l.id));

const BAD_KEYS = ['Bad_Key', 'UPPER', '-lead', 'a%20b', 'x;drop', 'a_b', '%2e%2e'];

test.describe('one board per view', () => {
  test('?view=board holds the continuous-claude lanes only, and names its board', async ({ request }) => {
    const defaultLane = seeded('E2E_BOARD_DEFAULT_LANE');
    const otherLane = seeded('E2E_BOARD_OTHER_LANE');
    const snapshot = await loadSnapshot(request, '?view=board');
    expect(snapshot.board?.board).toBe(DEFAULT_BOARD);
    expect(snapshot.board?.status).toBe('ok');
    expect(laneIds(snapshot.board), 'the default board holds its own lane').toContain(defaultLane);
    expect(laneIds(snapshot.board), 'the default board must not hold the other board lane').not.toContain(otherLane);

    const named = await loadSnapshot(request, `?view=board&project=${DEFAULT_BOARD}`);
    expect(laneIds(named.board)).toEqual(laneIds(snapshot.board));
  });

  test('?view=board&project=<other> holds that board only', async ({ request }) => {
    const defaultLane = seeded('E2E_BOARD_DEFAULT_LANE');
    const other = seeded('E2E_BOARD_OTHER');
    const otherLane = seeded('E2E_BOARD_OTHER_LANE');
    const snapshot = await loadSnapshot(request, `?view=board&project=${encodeURIComponent(other)}`);
    expect(snapshot.board?.board).toBe(other);
    expect(snapshot.board?.status).toBe('ok');
    expect(laneIds(snapshot.board)).toContain(otherLane);
    expect(laneIds(snapshot.board), 'the other board must not hold a continuous-claude lane').not.toContain(defaultLane);
  });

  test('a well-formed key with no lanes is an empty board, not an error', async ({ request }) => {
    const snapshot = await loadSnapshot(request, '?view=board&project=zz-no-such-board');
    expect(snapshot.board?.board).toBe('zz-no-such-board');
    expect(snapshot.board?.status).toBe('ok');
    expect(snapshot.board?.total).toBe(0);
  });

  test('a malformed project key is a 400 on the API', async ({ request }) => {
    for (const key of BAD_KEYS) {
      const response = await request.get(`/api/mission-control?view=board&project=${key}`);
      expect(response.status(), `project=${key} must be 400`).toBe(400);
      expect(response.headers()['cache-control']).toBe('no-store');
    }
    // Control: a good key on the same route is 200, so the 400 above is the key and not the route.
    const good = await request.get(`/api/mission-control?view=board&project=${DEFAULT_BOARD}`);
    expect(good.status()).toBe(200);
  });

  test('the page: ?project=<other> shows that board and the poll keeps asking for it', async ({ page }) => {
    const defaultLane = seeded('E2E_BOARD_DEFAULT_LANE');
    const other = seeded('E2E_BOARD_OTHER');
    const otherLane = seeded('E2E_BOARD_OTHER_LANE');
    const errors = watchErrors(page);
    // Arm the wait before the page loads: the first poll comes about 5 s after hydration.
    const poll = page.waitForRequest(
      (req) => {
        const url = new URL(req.url());
        return (
          url.pathname === '/api/mission-control' &&
          url.searchParams.get('view') === 'board' &&
          url.searchParams.get('project') === other
        );
      },
      { timeout: 20_000 },
    );
    await page.goto(`/?view=board&project=${encodeURIComponent(other)}`);
    await waitForHydration(page);
    await expect(boardPanel(page)).toBeVisible();
    await expect(page.getByTestId('board-key')).toHaveAttribute('data-board', other);
    await expect(page.getByTestId('board-header')).toContainText('Work board');
    await expect(page.getByTestId('board-header')).toContainText(other);
    await expect(page.locator(`[data-testid="board-lane"][data-lane-id="${otherLane}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="board-lane"][data-lane-id="${defaultLane}"]`)).toHaveCount(0);
    await expect(page.getByTestId('board-scope-note')).toContainText('all boards');

    await poll;
    // After a poll the board is still the asked-for one (it did not flip back to the default).
    await expect(page.getByTestId('board-key')).toHaveAttribute('data-board', other);
    expect(urlParam(page, 'project')).toBe(other);
    expect(errors).toEqual([]);
  });

  test('the page: a malformed ?project shows the default board, not an error', async ({ page }) => {
    const defaultLane = seeded('E2E_BOARD_DEFAULT_LANE');
    const errors = watchErrors(page);
    const response = await page.goto('/?view=board&project=Bad_Key');
    expect(response?.status()).toBeLessThan(400);
    await waitForHydration(page);
    await expect(page.getByTestId('board-key')).toHaveAttribute('data-board', DEFAULT_BOARD);
    await expect(page.locator(`[data-testid="board-lane"][data-lane-id="${defaultLane}"]`)).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('the other board fits the viewport (the desktop and phone projects both run this)', async ({ page }) => {
    const other = seeded('E2E_BOARD_OTHER');
    await page.goto(`/?view=board&project=${encodeURIComponent(other)}`);
    await waitForHydration(page);
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    expect(await horizontalOverflow(page), 'the Board is wider than the viewport').toBeLessThanOrEqual(0);
  });
});

// --- Spec 10: lane coordination (lane fleet-coord-views) ---------------------------------------------------
//
// Ways each case can fail (the source change that breaks it is named per case):
//   K1 reclaimable: the app uses a 15 minute window, drops the lapsed-lease test (E2E_COORD_RECLAIM_LIVE_LEASE_LANE), or drops
//      the session test. NOT the SQL owner prefix: laneCoordFields applies the owner check again, so drift test D3 guards that text.
//   K2 park: the park branch drops the owner check (E2E_COORD_OWNERLESS_LONG_LANE). The SQL pre-filter text of the park branch is
//      guarded by drift test D3; the Math.round edge by D4 and D8b (a seed cannot hold a lease at 91m31s for a whole run).
//   K3 reminders: 'acked' counts as due, the done filter is dropped, a future reminder shows
//   K4 unread: the cursor is the board cursor or one row only (either half: E2E_COORD_PART_SID and E2E_COORD_PLAIN_CURSOR_SID),
//      the self-exclusion is gone, a non-idle session shows, the 24 h idle window is gone (E2E_COORD_OLD_SID)
//   K5 waits on: laneMet drops the SHA check, a done lane without a done event counts as met
//   K6 privacy: toUnread passes the session id through, a url or a uuid in a title, or message text, reaches the snapshot
//   K7 chips: LaneBoard shows a chip from the wrong field; the "+N more" text of a long waits-on list
//   K8 layout: a coordination row or chip row loses its wrap (a seeded lane has 80 and 57 character tokens with no break point)
//   K9 the section: ready-coord moves into ready-for-dave, reuses ready-item, gets a button, a link or a session id; the section
//      shows more than its row cap, or the header count stops saying how many rows are hidden
//   K11 first screen: with more rows than the cap, the Live sessions header and first card stay inside 1000 px at 1440 px
//   K10 no lane_dep table: the board read fails, or waitsOn is not empty
//   K12 due chip: a done lane or an acked reminder shows a "due" chip again (R11); a future due time loses its chip
//   K13 the section: it disappears with no rows (R13) or loses its error line; K9 also pins the row order (R10) and K7 the reclaimable words (R12)

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type CoordVar =
  | 'E2E_COORD_UNREAD_SID' | 'E2E_COORD_PART_SID' | 'E2E_COORD_READ_SID' | 'E2E_COORD_ALIVE_SID' | 'E2E_COORD_ENDED_SID'
  | 'E2E_COORD_RECLAIM_OWNER_SID' | 'E2E_COORD_PLAIN_CURSOR_SID' | 'E2E_COORD_OLD_SID'
  | 'E2E_COORD_RECLAIM_LIVE_LEASE_LANE' | 'E2E_COORD_PRIVACY_LANE' | 'E2E_COORD_WIDE_LANE'
  | 'E2E_COORD_RECLAIM_LANE' | 'E2E_COORD_ALIVE_LANE' | 'E2E_COORD_UNOWNED_LANE' | 'E2E_COORD_PARK_LANE'
  | 'E2E_COORD_SHORT_LANE' | 'E2E_COORD_OWNERLESS_LONG_LANE' | 'E2E_COORD_DUE_REMINDER' | 'E2E_COORD_ACKED_REMINDER'
  | 'E2E_COORD_DONE_REMINDER' | 'E2E_COORD_FUTURE_REMINDER' | 'E2E_COORD_OTHER_REMINDER' | 'E2E_COORD_WAITS_LANE'
  | 'E2E_COORD_UNMET_DEP' | 'E2E_COORD_MET_WAITS_LANE' | 'E2E_COORD_NOSHA_WAITS_LANE' | 'E2E_COORD_NOEVENT_WAITS_LANE';

/** A variable of the seeded scratch run. Fails with a message that names it. */
function coordVar(name: CoordVar): string {
  const value = process.env[name];
  expect(
    value,
    `Precondition: ${name} is not set. Run this file through harness/run-scratch.mjs: it seeds a SCRATCH database ` +
      'and passes the url and every E2E_COORD_* variable. Never point these specs at the live database.',
  ).toBeTruthy();
  return value as string;
}

const noDepTable = (): boolean => process.env.E2E_COORD_NO_DEP_TABLE === '1';
const needsDepTable = (): void => test.skip(noDepTable(), 'the lane_dep table does not exist on this scratch database (--through 5 run)');

/** A pg client on the SCRATCH url from the process environment. Never reads .env.local. */
async function scratchClient(): Promise<Client> {
  const url = process.env.AGENTIC_OS_DATABASE_URL;
  expect(url, 'Precondition: AGENTIC_OS_DATABASE_URL (the scratch url) must be in the environment').toBeTruthy();
  expect(new URL(url as string).pathname, 'these specs run on a SCRATCH database only').toMatch(/^\/lanes_pr1_/);
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

const allLanes = (board: LaneBoard): BoardLane[] => board.columns.flatMap((c) => c.lanes);
const laneById = (board: LaneBoard, id: string): BoardLane => {
  const found = allLanes(board).find((l) => l.id === id);
  expect(found, `lane ${id} must be on the board (seeded by the harness)`).toBeDefined();
  return found as BoardLane;
};
const coordRowsOf = (coord: Coord, kind: CoordRow['kind']): CoordRow[] => coord.rows.filter((r) => r.kind === kind);
const coordLaneIds = (coord: Coord, kind: CoordRow['kind']): string[] =>
  coordRowsOf(coord, kind).map((r) => r.laneId ?? '');

async function loadCoord(request: APIRequestContext, query = ''): Promise<Coord> {
  const snapshot = await loadSnapshot(request, query);
  expect(snapshot.coord, 'the snapshot must carry "coord"').toBeDefined();
  expect(snapshot.coord.status, `coord.status must be ok (error was: ${String(snapshot.coord.error)})`).toBe('ok');
  return snapshot.coord;
}

/** The UNREAD_SQL text of lane.mjs, run the way the CLI runs it, for one session (a board with no events: no broadcasts). */
async function cliUnreadCount(client: Client, sid: string): Promise<number> {
  const source = readFileSync(join(REPO_ROOT, 'scripts/coordination/lane.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const match = /const UNREAD_SQL = `([\s\S]*?)`;/.exec(source);
  expect(match, 'lane.mjs must hold const UNREAD_SQL = `...`;').not.toBeNull();
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agentic_os.lane_event e WHERE ${(match as RegExpExecArray)[1]}`,
    [sid, 'zz-coord-empty', `${sid}@zz-coord-empty`],
  );
  return rows[0].n;
}

/** The rows the section draws: COORD_SHOWN of ReadyForDave.tsx. The rest is only counted in the header. */
const READY_COORD_SHOWN = 4;
/** R12: the chip says why the lane is reclaimable while the owner chip can still say "live". */
const RECLAIMABLE_TEXT = 'reclaimable: lease ended, holder quiet 5+ min';
const UUID_ANYWHERE =/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CT_TEXT = '[A-Z][a-z]{2} \\d\\d-\\d\\d \\d\\d:\\d\\d C[SD]T';

test.describe('lane coordination: the card tags', () => {
  test('K1 reclaimable: lapsed lease + owner quiet 10 minutes is tagged; an alive owner, no owner, and a live lease with a quiet owner are not', async ({
    request,
  }) => {
    const client = await scratchClient();
    try {
      // The seed is honest at test time: the owner was last seen 5 to 15 minutes ago (the 15 minute rule would fail this case).
      const { rows } = await client.query<{ minutes: number }>(
        `SELECT EXTRACT(EPOCH FROM (now() - GREATEST(last_heartbeat, last_activity_at))) / 60 AS minutes FROM public.sessions WHERE id = $1`,
        [coordVar('E2E_COORD_RECLAIM_OWNER_SID')],
      );
      expect(Number(rows[0].minutes)).toBeGreaterThan(5);
      expect(Number(rows[0].minutes)).toBeLessThan(15);
    } finally {
      await client.end();
    }
    const board = await loadBoard(request);
    expect(laneById(board, coordVar('E2E_COORD_RECLAIM_LANE')).reclaimable, 'owner quiet 10 min, lease lapsed').toBe(true);
    expect(laneById(board, coordVar('E2E_COORD_ALIVE_LANE')).reclaimable, 'owner alive 1 min ago, lease lapsed').toBe(false);
    expect(
      laneById(board, coordVar('E2E_COORD_RECLAIM_LIVE_LEASE_LANE')).reclaimable,
      'the same quiet owner, lease 60 minutes ahead: the lapsed-lease test must hold',
    ).toBe(false);
    expect(laneById(board, coordVar('E2E_COORD_UNOWNED_LANE')).reclaimable, 'no owner: the rule alone is true, the tag is not').toBe(false);
    expect(laneById(board, coordVar('E2E_COORD_OWNERLESS_LONG_LANE')).reclaimable).toBe(false);
    expect(laneById(board, coordVar('E2E_COORD_PARK_LANE')).reclaimable, 'a live lease is not reclaimable').toBe(false);
    expect(laneById(board, coordVar('E2E_COORD_SHORT_LANE')).reclaimable).toBe(false);
  });

  test('K2 park: more than 91.5 minutes ahead with an owner is parked; 60 minutes, and a long lease with no owner, are not', async ({
    request,
  }) => {
    const board = await loadBoard(request);
    const parked = laneById(board, coordVar('E2E_COORD_PARK_LANE'));
    expect(parked.parkedUntil, 'lease 3 hours ahead').toMatch(new RegExp(`^${CT_TEXT}$`));
    expect(laneById(board, coordVar('E2E_COORD_SHORT_LANE')).parkedUntil, 'lease 60 minutes ahead').toBeNull();
    expect(laneById(board, coordVar('E2E_COORD_OWNERLESS_LONG_LANE')).parkedUntil, 'a 3 hour lease with no owner is no park').toBeNull();
    const coord = await loadCoord(request);
    expect(coordLaneIds(coord, 'park').sort()).toEqual([coordVar('E2E_COORD_PARK_LANE'), coordVar('E2E_COORD_WIDE_LANE')].sort());
  });
});

test.describe('lane coordination: the Ready rows', () => {
  test('K3 reminders: a due scheduled reminder shows (any board); acked, done and future ones do not; the row says the lane, the time and the board', async ({
    request,
  }) => {
    const coord = await loadCoord(request);
    const ids = coordLaneIds(coord, 'reminder');
    expect(ids).toContain(coordVar('E2E_COORD_DUE_REMINDER'));
    expect(ids, 'a reminder on another board shows too, tagged with its board').toContain(coordVar('E2E_COORD_OTHER_REMINDER'));
    expect(ids, 'acked is never due').not.toContain(coordVar('E2E_COORD_ACKED_REMINDER'));
    expect(ids, 'a done lane is not listed').not.toContain(coordVar('E2E_COORD_DONE_REMINDER'));
    expect(ids, 'due in the future').not.toContain(coordVar('E2E_COORD_FUTURE_REMINDER'));
    const due = coordRowsOf(coord, 'reminder').find((r) => r.laneId === coordVar('E2E_COORD_DUE_REMINDER'));
    expect(due?.text).toMatch(new RegExp(`^${coordVar('E2E_COORD_DUE_REMINDER')} reminder due ${CT_TEXT} \\(continuous-claude\\)$`));
    const other = coordRowsOf(coord, 'reminder').find((r) => r.laneId === coordVar('E2E_COORD_OTHER_REMINDER'));
    expect(other?.board).toBe('zz-pbprobe-a');
    const park = coordRowsOf(coord, 'park').find((r) => r.laneId === coordVar('E2E_COORD_PARK_LANE'));
    expect(park?.text).toMatch(new RegExp(`^${coordVar('E2E_COORD_PARK_LANE')} parked until ${CT_TEXT} \\(continuous-claude\\)$`));
  });

  test('K4 unread: the count is the lane CLI count; the self message and the broadcast do not count; the higher of the <id> and <id>@board cursors hides read ones; alive, ended and 25 hour old sessions show nothing', async ({
    request,
  }) => {
    const coord = await loadCoord(request);
    const unread = coordRowsOf(coord, 'unread');
    const countOf = (sid: string): number | undefined => unread.find((r) => r.shortId === sid.slice(0, 8))?.count;
    const [u, x, r] = [coordVar('E2E_COORD_UNREAD_SID'), coordVar('E2E_COORD_PART_SID'), coordVar('E2E_COORD_READ_SID')];
    expect(countOf(u), 'two DMs from another session; the DM to itself is not counted').toBe(2);
    expect(countOf(x), 'two DMs at or below the <id>@board cursor are read; one above it is not').toBe(1);
    expect(countOf(r), 'every DM is under the cursor').toBeUndefined();
    const plain = coordVar('E2E_COORD_PLAIN_CURSOR_SID');
    expect(countOf(plain), 'the plain <id> cursor is above the <id>@board cursor: the higher one wins, so both DMs are read').toBeUndefined();
    expect(countOf(coordVar('E2E_COORD_OLD_SID')), 'idle for 25 hours: outside the 24 hour window').toBeUndefined();
    expect(countOf(coordVar('E2E_COORD_ALIVE_SID')), 'an alive session is not idle').toBeUndefined();
    expect(countOf(coordVar('E2E_COORD_ENDED_SID')), 'an ended session is not idle').toBeUndefined();

    const client = await scratchClient();
    try {
      expect(await cliUnreadCount(client, u)).toBe(2);
      expect(await cliUnreadCount(client, x)).toBe(1);
      expect(await cliUnreadCount(client, r)).toBe(0);
      expect(await cliUnreadCount(client, plain), 'control: the CLI reads the same cursor').toBe(0);
      expect(await cliUnreadCount(client, coordVar('E2E_COORD_OLD_SID')), 'control: the old session does hold one unread DM').toBe(1);
    } finally {
      await client.end();
    }
    const row = unread.find((entry) => entry.shortId === u.slice(0, 8));
    expect(row?.text).toMatch(/^unnamed #[0-9a-f]{8}: 2 unread direct messages, idle \d+ min$/);
    expect(unread.find((entry) => entry.shortId === x.slice(0, 8))?.text).toMatch(/: 1 unread direct message, idle \d+ min$/);
  });

  test('K5 waits on: an unmet edge shows; a met edge does not; a done lane without a 40-hex merge SHA, or without a done event, is not met', async ({
    request,
  }) => {
    needsDepTable();
    const board = await loadBoard(request);
    expect(laneById(board, coordVar('E2E_COORD_WAITS_LANE')).waitsOn).toEqual([coordVar('E2E_COORD_UNMET_DEP')]);
    expect(laneById(board, coordVar('E2E_COORD_MET_WAITS_LANE')).waitsOn, 'done + done event + 40-hex SHA').toEqual([]);
    expect(laneById(board, coordVar('E2E_COORD_NOSHA_WAITS_LANE')).waitsOn, 'done + a merged value that is not 40 hex').toHaveLength(1);
    expect(laneById(board, coordVar('E2E_COORD_NOEVENT_WAITS_LANE')).waitsOn, 'done lane with no done event').toHaveLength(1);
  });

  test('K10 without the lane_dep table the board still reads ok and every waitsOn is empty', async ({ request }) => {
    test.skip(!noDepTable(), 'runs on the --through 5 scratch database only (no lane_dep table)');
    const snapshot = await loadSnapshot(request, '?view=board');
    expect(snapshot.board?.status, `board.status (error was: ${String(snapshot.board?.error)})`).toBe('ok');
    const lanes = allLanes(snapshot.board as LaneBoard);
    expect(lanes.length).toBeGreaterThan(5);
    for (const lane of lanes) expect(lane.waitsOn, `lane ${lane.id}`).toEqual([]);
    expect(laneById(snapshot.board as LaneBoard, coordVar('E2E_COORD_RECLAIM_LANE')).reclaimable, 'the rest of the card still works').toBe(true);
  });
});

test.describe('lane coordination: privacy', () => {
  test('K6 the coord and board JSON hold no full session id, no url, no message text and no body or detail key; a url and a uuid in a title are removed; the Ready section has no session id, button or link', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const snapshot = await loadSnapshot(request, '?view=board');
    expect(snapshot.coord.status).toBe('ok');
    // Control: the check is not vacuous. The seed has unread rows whose sessions have real 36-character ids.
    expect(coordRowsOf(snapshot.coord, 'unread').length, 'at least one unread row').toBeGreaterThanOrEqual(1);
    expect(coordVar('E2E_COORD_UNREAD_SID')).toMatch(UUID_ANYWHERE);
    // Control: the privacy lane is a due reminder on the default board, so it is in the coord rows AND on the board.
    const privacyId = coordVar('E2E_COORD_PRIVACY_LANE');
    const privacyRow = coordRowsOf(snapshot.coord, 'reminder').find((r) => r.laneId === privacyId);
    expect(privacyRow, 'the privacy lane is a coord reminder row (seeded with a url and a full uuid in its title)').toBeDefined();
    expect(privacyRow?.title).toMatch(/^see .* and .* end$/);
    expect(laneById(snapshot.board as LaneBoard, privacyId).title).toMatch(/^see .* and .* end$/);
    for (const [where, value] of [['coord', snapshot.coord], ['board', snapshot.board]] as const) {
      const json = JSON.stringify(value);
      expect(json, `${where} JSON must hold no message text`).not.toMatch(/e2e direct message|e2e broadcast/);
      expect(json, `${where} JSON must hold no 36-character session id`).not.toMatch(UUID_ANYWHERE);
      expect(json, `${where} JSON must hold no url`).not.toMatch(/:\/\//);
      const keys = keysDeep(value);
      for (const banned of ['sessionId', 'sid', 'to_session_id', 'body', 'detail', 'note', 'scope', 'rationale', 'ownerSessionId', 'owner_session_id']) {
        expect(keys.has(banned), `${where} JSON must not carry the key "${banned}"`).toBe(false);
      }
    }
    await page.goto('/');
    await waitForHydration(page);
    const section = page.getByTestId('ready-coord');
    await expect(section).toBeVisible();
    await expect(section.locator('[data-session-id]')).toHaveCount(0);
    await expect(section.locator('button, a')).toHaveCount(0);
    expect(await section.innerText()).not.toMatch(UUID_ANYWHERE);
    expect(errors, 'no console error: hydration warnings show here').toEqual([]);
  });
});

test.describe('lane coordination: the page', () => {
  test('K9 From the lane board is a sibling of Ready for Dave, one row per API row, with the API text and kind', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const raw = await request.get('/');
    expect(await raw.text(), 'the server HTML holds the section').toContain('data-testid="ready-coord"');
    const coord = await loadCoord(request);
    expect(coord.rows.length, 'control: the seed holds more rows than the section draws').toBeGreaterThan(READY_COORD_SHOWN);
    await page.goto('/');
    await waitForHydration(page);
    const section = page.getByTestId('ready-coord');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText('From the lane board');
    await expect(page.getByRole('heading', { level: 2, name: /^Ready for Dave/ })).toHaveCount(1);
    await expect(page.getByTestId('ready-for-dave').getByTestId('ready-coord')).toHaveCount(0);
    await expect(page.getByTestId('ready-for-dave').getByTestId('ready-coord-item')).toHaveCount(0);
    await expect(section.getByTestId('ready-item')).toHaveCount(0);
    await expect(page.getByTestId('ready-for-dave')).toContainText('Nothing waiting on Dave.');
    await expect
      .poll(async () => {
        const fresh = await loadCoord(request);
        const dom = await section
          .getByTestId('ready-coord-item')
          .evaluateAll((els) => els.map((el) => ({ kind: el.getAttribute('data-kind'), text: (el.querySelector('[data-testid="ready-coord-text"]')?.textContent ?? '').replace(/\s+/g, ' ').trim() })));
        const want = fresh.rows.slice(0, READY_COORD_SHOWN).map((r) => ({ kind: r.kind, text: r.text }));
        return JSON.stringify(dom) === JSON.stringify(want) ? 'match' : 'differs';
      }, { timeout: 20_000, message: 'the rows on the page must equal the first rows of coord.rows' })
      .toBe('match');
    // R10: no kind is hidden by another. The seed holds all three kinds, and the first four rows show each of them.
    const shownKinds = coord.rows.slice(0, READY_COORD_SHOWN).map((r) => r.kind);
    expect(new Set(shownKinds), 'the first rows hold one of each kind').toEqual(new Set(['unread', 'park', 'reminder']));
    expect(shownKinds.slice(0, 3), 'one row of each kind first, in the order unread, park, reminder').toEqual(['unread', 'park', 'reminder']);
    const total = coord.rows.length;
    const hidden = `${total - READY_COORD_SHOWN}${coord.truncated ? '+' : ''} more not shown`;
    await expect(section.getByTestId('ready-coord-count'), 'the header says how many rows are not drawn').toHaveText(`${total} items, ${hidden}`);
    expect(errors).toEqual([]);
  });

  test('K11 first screen: with more rows than the section draws, the rows fit one grid line and Live sessions start inside 1000 px at 1440 px', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'desktop first-screen pin: runs in the chromium project only');
    const coord = await loadCoord(request);
    expect(coord.rows.length, 'control: more rows than the section draws').toBeGreaterThan(READY_COORD_SHOWN);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await waitForHydration(page);
    const items = page.getByTestId('ready-coord-item');
    await expect(items).toHaveCount(READY_COORD_SHOWN);
    const tops = await items.evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))]);
    expect(tops, 'the section draws one grid line at 1440 px, however many rows the database holds').toHaveLength(1);
    const header = await page.getByRole('heading', { level: 2, name: /^Live sessions/ }).boundingBox();
    const card = await page.getByTestId('session-card').first().boundingBox();
    expect(header, 'the Live sessions header').not.toBeNull();
    expect(card, 'the first session card').not.toBeNull();
    expect(header?.y ?? 9999, 'the Live sessions header is inside the first screen').toBeLessThan(1000);
    expect((card?.y ?? 9999) + 80, 'the first card shows at least 80 px inside 1000').toBeLessThanOrEqual(1000);
  });

  test('K7 chips: each chip shows exactly when its field is set, with the API text; every chip kind is present at least once', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    await loadBoard(request);
    await openBoard(page);
    await expect
      .poll(async () => {
        const board = await loadBoard(request);
        const dom = await page.getByTestId('board-lane').evaluateAll((els) =>
          els.map((el) => {
            const text = (id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
            return {
              id: el.getAttribute('data-lane-id'),
              band: text('board-lane-band'),
              due: text('board-lane-due'),
              parked: text('board-lane-parked'),
              waits: text('board-lane-waits'),
              waitsAttr: el.querySelector('[data-testid="board-lane-waits"]')?.getAttribute('data-waits-on') ?? null,
              reclaimable: text('board-lane-reclaimable'),
              controls: el.querySelectorAll('button, a').length,
            };
          }),
        );
        const problems: string[] = [];
        const byId = new Map(dom.map((d) => [d.id, d]));
        for (const lane of allLanes(board)) {
          const card = byId.get(lane.id);
          if (!card) { problems.push(`${lane.id}: no card`); continue; }
          const want = {
            band: lane.band,
            due: lane.due === null ? null : `due ${lane.due}`,
            parked: lane.parkedUntil === null ? null : `parked to ${lane.parkedUntil}`,
            waits: lane.waitsOn.length === 0 ? null : `waits on: ${lane.waitsOn.join(', ')}${lane.waitsOnMore > 0 ? ` +${lane.waitsOnMore} more` : ''}`,
            waitsAttr: lane.waitsOn.length === 0 ? null : lane.waitsOn.join(','),
            reclaimable: lane.reclaimable ? RECLAIMABLE_TEXT : null,
          };
          for (const key of Object.keys(want) as (keyof typeof want)[]) {
            if (card[key] !== want[key]) problems.push(`${lane.id}: ${key} "${card[key]}" != "${want[key]}"`);
          }
          if (card.controls !== 0) problems.push(`${lane.id}: ${card.controls} button or link`);
        }
        return problems.length === 0 ? 'match' : problems.slice(0, 6).join(' | ');
      }, { timeout: 20_000, message: 'the chips on the page must match GET ?view=board' })
      .toBe('match');

    // Not vacuous: the seed sets every field on at least one lane.
    const lanes = allLanes(await loadBoard(request));
    expect(lanes.some((l) => l.band !== null), 'a lane with a band').toBe(true);
    expect(lanes.some((l) => l.due !== null), 'a lane with a due time').toBe(true);
    expect(lanes.some((l) => l.parkedUntil !== null), 'a parked lane').toBe(true);
    expect(lanes.some((l) => l.reclaimable), 'a reclaimable lane').toBe(true);
    if (!noDepTable()) {
      expect(lanes.some((l) => l.waitsOn.length > 0), 'a lane that waits').toBe(true);
      const wide = lanes.find((l) => l.id === coordVar('E2E_COORD_WIDE_LANE'));
      expect(wide, 'the wide lane is on the board').toBeDefined();
      if (wide === undefined) return;
      expect(wide.waitsOn, 'eleven dependencies: ten are listed').toHaveLength(10);
      expect(wide.waitsOnMore, 'the eleventh is counted').toBe(1);
      await expect(page.locator(`[data-lane-id="${wide.id}"]`).getByTestId('board-lane-waits')).toContainText('+1 more');
    }
    await expect(page.getByTestId('board-lane-band').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('K12 due chip (R11): none on a done lane or an acked reminder; a due reminder and a future due time still show it', async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const acked = coordVar('E2E_COORD_ACKED_REMINDER');
    const done = coordVar('E2E_COORD_DONE_REMINDER');
    const due = coordVar('E2E_COORD_DUE_REMINDER');
    const future = coordVar('E2E_COORD_FUTURE_REMINDER');
    const board = await loadBoard(request);
    expect(laneById(board, acked).due, 'acked: no due text in the API').toBeNull();
    expect(laneById(board, done).due, 'done: no due text in the API').toBeNull();
    expect(laneById(board, due).due, 'a due reminder keeps its time').not.toBeNull();
    expect(laneById(board, future).due, 'a future due time keeps its time').not.toBeNull();
    await openBoard(page);
    const card = (id: string): Locator => page.locator(`[data-testid="board-lane"][data-lane-id="${id}"]`);
    const chip = (id: string): Locator => card(id).getByTestId('board-lane-due');
    for (const id of [acked, done, due, future]) await expect(card(id), `the card of ${id} is on the board`).toHaveCount(1);
    await expect(chip(acked), 'acked reminder').toHaveCount(0);
    await expect(chip(done), 'done lane').toHaveCount(0);
    await expect(chip(due)).toHaveText(/^due [A-Z][a-z]{2} \d\d-\d\d \d\d:\d\d C[SD]T$/);
    await expect(chip(future)).toHaveText(/^due [A-Z][a-z]{2} \d\d-\d\d \d\d:\d\d C[SD]T$/);
    expect(errors).toEqual([]);
  });

  test('K13 From the lane board always renders (R13): no rows gives one line and "0 items"; an error keeps its error line', async ({ page }) => {
    const errors = watchErrors(page);
    let mode: 'real' | 'empty' | 'error' = 'real';
    await page.route('**/api/mission-control**', async (route) => {
      if (mode === 'real') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Snapshot;
      body.coord = mode === 'empty'
        ? { status: 'ok', error: null, rows: [], truncated: false, nowEpoch: null }
        : { status: 'error', error: 'e2e forced', rows: [], truncated: false, nowEpoch: null };
      return route.fulfill({ response, json: body });
    });
    await page.goto('/');
    await waitForHydration(page);
    const section = page.getByTestId('ready-coord');
    await expect(section, 'control: the real snapshot has rows').toBeVisible();
    await expect(section.getByTestId('ready-coord-item').first()).toBeVisible();

    mode = 'empty';
    await page.getByRole('button', { name: /updated \d+s ago/ }).click();
    await expect(section, 'the section stays when there are no rows').toBeVisible();
    await expect(section.getByTestId('ready-coord-count')).toHaveText('0 items');
    await expect(section).toContainText('Nothing from the lane board.');
    await expect(section.getByTestId('ready-coord-item')).toHaveCount(0);
    await expect(section.getByTestId('ready-coord-error')).toHaveCount(0);

    mode = 'error';
    await page.getByRole('button', { name: /updated \d+s ago/ }).click();
    await expect(section).toBeVisible();
    await expect(section.getByTestId('ready-coord-error')).toHaveText('Lane board signals unavailable: e2e forced');
    await expect(section).not.toContainText('Nothing from the lane board.');
    expect(errors.filter((e) => !/Failed to load resource|e2e forced/.test(e))).toEqual([]);
  });

  test('K8 no sideways scroll on the overview and on the Board at the project width', async ({ page, request }) => {
    const errors = watchErrors(page);
    await loadBoard(request);
    for (const url of ['/', '/?view=board']) {
      await page.goto(url);
      await waitForHydration(page);
      await expect(page.getByTestId('ready-coord')).toBeVisible();
      if (url === '/') {
        // Control (R10 changed the row order): the wide lane is the first park row, so it is among the drawn rows.
        await expect(
          page.locator(`[data-testid="ready-coord-item"][data-lane-id="${coordVar('E2E_COORD_WIDE_LANE')}"]`),
          'control: the wide lane is drawn on the overview',
        ).toHaveCount(1);
      }
      const width = page.viewportSize()?.width ?? 0;
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${url}: the page is wider than the viewport`).toBeLessThanOrEqual(width);
      // A clipped box can hide an overflow from the page width: test each card and row on its own.
      const cards = url === '/' ? page.getByTestId('ready-coord-item') : page.getByTestId('board-lane');
      const overflowing = await cards.evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.getAttribute('data-lane-id') ?? el.getAttribute('data-kind') ?? '?'),
      );
      expect(overflowing, `${url}: boxes whose content is wider than the box`).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
});
