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
  findQuietSessionId,
  makeBrief,
  makeSnapshot,
  secondsAgo,
  step,
  writeRaw,
  writeState,
} from './state-fixture';

/**
 * Fleet page, step A (data and privacy). Design: .claudedocs/2026-10-30-fleet-page-build-map.md,
 * section 2, with Dave's decisions of 2026-10-30:
 *   - Ready for Dave is one row per session: its FIRST open ask, on one line, with no
 *     `recommend` and a "+N more" mark. The detail panel keeps every ask.
 *   - `working_on` (a prompt) is gone from the API and the page.
 *   - The Active sessions strip is two panels: Unmatched sessions and Closed.
 *   - A state file may carry `endedAt` (the final snapshot). It counts as ended only when the
 *     database has no row for the session, and only when it is not older than the file's activity.
 *
 * Like fleet.spec.ts: the specs borrow REAL live sessions from GET /api/mission-control and
 * write fixture files in the private state dir, which is emptied before and after every test.
 */

const LIVE_UNDER_SECONDS = 900;

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

type Session = { id: string; shortId: string; projectKey: string | null; liveSecondsAgo: number };

type ReadyItem = {
  sessionId: string;
  name: string;
  kind: string;
  text: string;
  openAsks: number;
  live: boolean;
  ageSeconds: number;
};

type Source = { id: string; detail: string };

type Snapshot = {
  active: { sessions: Session[]; recentlyEnded: Session[] };
  ready: ReadyItem[];
  cards: { id: string; title: string | null; askOpen: number; askStale: number }[];
  tiles: { needsDave: number };
  sources: Source[];
};

async function loadSnapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
    timeout: 15_000,
  });
}

function liveSessions(snapshot: Snapshot): Session[] {
  const live = snapshot.active.sessions.filter((s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS);
  expect(
    live.length,
    'Precondition: the database needs a live session (liveSecondsAgo < 900). Open a Claude Code session and run again.',
  ).toBeGreaterThanOrEqual(1);
  return live;
}

/** Read "<label> <n>" out of the state-files detail text, e.g. "no session row 1". */
function detailCount(snapshot: Snapshot, label: string): number {
  const detail = snapshot.sources.find((s) => s.id === 'state-files')?.detail ?? '';
  const match = new RegExp(`${label} (\\d+)`).exec(detail);
  expect(match, `state-files detail "${detail}" must contain "${label} <n>"`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

const readyItem = (page: Page, sessionId: string): Locator =>
  page.locator(`[data-testid="ready-item"][data-session-id="${sessionId}"]`);

const FIRST = 'E2E first open ask';
const SECOND = 'E2E second open ask';
const RECOMMEND = 'E2E recommendation text';

// --- Ready for Dave: one row per session -------------------------------------------------------

test.describe('Ready for Dave rows', () => {
  test('R1 a session with an answered ask and two open asks gives one row: the first open ask, +1 more, no recommend', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    writeState(live.id, {
      brief: makeBrief({
        ask: [
          ask('E2E answered ask', undefined, { answered: true }),
          ask(FIRST, RECOMMEND),
          ask(SECOND),
        ],
      }),
    });

    const rows = (await loadSnapshot(request)).ready.filter((r) => r.sessionId === live.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: FIRST, kind: 'question', openAsks: 2, live: true });
    expect(rows[0]).not.toHaveProperty('recommend');

    await page.goto('/');
    await expect(page.getByTestId('ready-item')).toHaveCount(1);
    const item = readyItem(page, live.id);
    await expect(item).toContainText(FIRST);
    await expect(item).toContainText('+1 more');
    await expect(item).not.toContainText(RECOMMEND);
    await expect(item).not.toContainText(SECOND);
    await expect(page.getByTestId('ready-for-dave')).not.toContainText('Recommend');
    await waitForHydration(page);
  });

  test('R2 an ask with line breaks and a URL is one line, and the URL is intact', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    const url = 'https://example.com/review?id=7&tab=files#top';
    writeState(live.id, {
      brief: makeBrief({ ask: [ask(`Check the page\n\n  at ${url}   then reply`)] }),
    });

    const row = (await loadSnapshot(request)).ready.find((r) => r.sessionId === live.id);
    expect(row?.text).toBe(`Check the page at ${url} then reply`);

    await page.goto('/');
    const line = readyItem(page, live.id).getByTestId('ready-text');
    await expect(line).toContainText(url);
    await expect(line).toHaveCSS('white-space', 'nowrap');
    await expect(line).toHaveAttribute('title', `Check the page at ${url} then reply`);
  });

  test('R3 the Needs Dave tile equals the number of rows', async ({ page, request }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    writeState(live.id, { brief: makeBrief({ ask: [ask(FIRST), ask(SECOND)] }) });

    const snapshot = await loadSnapshot(request);
    expect(snapshot.tiles.needsDave).toBe(snapshot.ready.length);

    await page.goto('/');
    const rows = await page.getByTestId('ready-item').count();
    const tile = page.getByTestId('stat-tile').filter({ hasText: 'Needs Dave' });
    // The value node only: line 2 of the tile ("blocked N, quiet N") holds digits too.
    await expect(tile.getByTestId('stat-tile-value')).toHaveText(String(rows));
    expect(rows).toBe(snapshot.ready.length);
  });

  test('Q1 a quiet session is marked, counted in the header, and a live session is not', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    const quietId = await findQuietSessionId();
    expect(quietId).not.toBe(live.id);
    writeState(live.id, { brief: makeBrief({ ask: [ask(FIRST)] }) });
    writeState(quietId, { brief: makeBrief({ ask: [ask(SECOND)] }) });

    const ready = (await loadSnapshot(request)).ready;
    expect(ready.find((r) => r.sessionId === live.id)?.live).toBe(true);
    expect(ready.find((r) => r.sessionId === quietId)?.live).toBe(false);

    await page.goto('/');
    await expect(page.getByTestId('ready-for-dave')).toContainText('2 waiting');
    await expect(page.getByTestId('ready-for-dave')).toContainText('1 from quiet sessions');
    await expect(readyItem(page, quietId)).toContainText('quiet');
    await expect(readyItem(page, live.id)).not.toContainText('quiet');
  });

  test('Q2 with only live sessions the header has no quiet count', async ({ page, request }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    writeState(live.id, { brief: makeBrief({ ask: [ask(FIRST)] }) });

    await page.goto('/');
    await expect(page.getByTestId('ready-for-dave')).toContainText('1 waiting');
    await expect(page.getByTestId('ready-for-dave')).not.toContainText('from quiet');
  });
});

// --- Ask age and invisible characters ----------------------------------------------------------

/** Built from code points: the source file holds no bidi or zero-width character. */
const INVISIBLE = String.fromCharCode(0x202e, 0x200b, 0x0000, 0x2066);

test.describe('ask age and text', () => {
  test('A1 an ask whose brief is 25 h old stays open while the state file is fresh', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    // `at` is now (the session is still working); only the brief is old. The terminal pane
    // measures from the later of the two, so the page must too.
    writeState(live.id, {
      brief: makeBrief({ ask: [ask(FIRST)], updatedAt: secondsAgo(25 * 3600) }),
    });

    const snapshot = await loadSnapshot(request);
    expect(snapshot.ready.find((r) => r.sessionId === live.id)?.text).toBe(FIRST);
    expect(snapshot.cards.find((c) => c.id === live.id)).toMatchObject({ askOpen: 1, askStale: 0 });

    await page.goto('/');
    await expect(readyItem(page, live.id)).toContainText(FIRST);
  });

  test('A2 bidi, zero-width and control characters are stripped from an ask and a title', async ({
    page,
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    writeState(live.id, {
      brief: makeBrief({
        title: `E2E${INVISIBLE} title`,
        ask: [ask(`Open${INVISIBLE} the file`)],
      }),
    });

    const snapshot = await loadSnapshot(request);
    expect(snapshot.ready.find((r) => r.sessionId === live.id)?.text).toBe('Open the file');
    expect(snapshot.cards.find((c) => c.id === live.id)?.title).toBe('E2E title');

    await page.goto('/');
    const shown = (await readyItem(page, live.id).getByTestId('ready-text').textContent()) ?? '';
    for (const code of [0x202e, 0x200b, 0x0000, 0x2066]) {
      expect(shown.includes(String.fromCharCode(code)), `U+${code.toString(16)} must not reach the page`).toBe(false);
    }
  });

  test('A3 a secret split by an invisible character is redacted, not revealed by the strip', async ({
    request,
  }) => {
    const [live] = liveSessions(await loadSnapshot(request));
    // Built at run time: gitleaks scans this file. The zero-width space sits inside the key prefix,
    // so a redact pass that runs before the strip does not see a key.
    const tail = 'a'.repeat(40);
    const split = `sk-${String.fromCharCode(0x200b)}ant-${tail}`;
    writeState(live.id, { brief: makeBrief({ ask: [ask(`Use ${split} for the call?`)] }) });

    const snapshot = await loadSnapshot(request);
    const text = snapshot.ready.find((r) => r.sessionId === live.id)?.text ?? '';
    expect(text).not.toContain(tail);
    expect(JSON.stringify(snapshot)).not.toContain(tail);
  });
});

// --- No prompt text anywhere -------------------------------------------------------------------

test.describe('working_on is gone', () => {
  test('R4 no session in the API carries workingOn', async ({ request }) => {
    const { active } = await loadSnapshot(request);
    for (const session of [...active.sessions, ...active.recentlyEnded]) {
      expect(session).not.toHaveProperty('workingOn');
    }
  });
});

// --- Unmatched sessions and Closed -------------------------------------------------------------

test.describe('Unmatched sessions and Closed panels', () => {
  test('P1 two panels replace the Active sessions strip; mapped live sessions are not listed in them', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 2, name: /^Unmatched sessions/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Closed in the last \d+m/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Active sessions/ })).toHaveCount(0);

    const { active } = await loadSnapshot(request);
    const unmatched = active.sessions.filter((s) => s.projectKey === null);
    await expect(page.getByTestId('unmatched-session')).toHaveCount(unmatched.length);
    for (const session of unmatched) {
      await expect(
        page.locator(`[data-testid="unmatched-session"][data-session-id="${session.id}"]`),
      ).toHaveCount(1);
    }
    for (const session of active.sessions.filter((s) => s.projectKey !== null)) {
      await expect(
        page.locator(`[data-testid="unmatched-session"][data-session-id="${session.id}"]`),
      ).toHaveCount(0);
    }
    await expect(page.getByTestId('closed-session')).toHaveCount(active.recentlyEnded.length);
  });
});

// --- endedAt: the final snapshot as a fallback -------------------------------------------------

/** A state file for an id with no database row, with `endedAt` as the final snapshot writes it. */
function writeEnded(
  id: string,
  parts: { at: number; endedAt: number; briefUpdatedAt?: number; stepSecondsAgo?: number },
): void {
  const snapshot = makeSnapshot(id, {
    at: parts.at,
    brief: parts.briefUpdatedAt === undefined ? null : makeBrief({ updatedAt: parts.briefUpdatedAt }),
    step: parts.stepSecondsAgo === undefined ? null : step('Bash', 'running', parts.stepSecondsAgo),
  });
  writeRaw(`${id}.json`, JSON.stringify({ ...snapshot, endedAt: parts.endedAt }, null, 2));
}

test.describe('endedAt fallback', () => {
  test('E1 a file with no database row and endedAt equal to at counts as ended, not as no session row', async ({
    request,
  }) => {
    const before = await loadSnapshot(request);
    const at = secondsAgo(60);
    writeEnded(randomUUID(), { at, endedAt: at });

    const after = await loadSnapshot(request);
    expect(detailCount(after, 'ended')).toBe(detailCount(before, 'ended') + 1);
    expect(detailCount(after, 'no session row')).toBe(detailCount(before, 'no session row'));
  });

  test('E2 an endedAt older than at is no end: the file counts as no session row', async ({ request }) => {
    const before = await loadSnapshot(request);
    const at = secondsAgo(60);
    writeEnded(randomUUID(), { at, endedAt: at - 1000 });

    const after = await loadSnapshot(request);
    expect(detailCount(after, 'no session row')).toBe(detailCount(before, 'no session row') + 1);
    expect(detailCount(after, 'ended')).toBe(detailCount(before, 'ended'));
  });

  test('E3 a brief or a step newer than endedAt means the session came back: no session row', async ({
    request,
  }) => {
    const before = await loadSnapshot(request);
    const at = secondsAgo(60);
    writeEnded(randomUUID(), { at, endedAt: at, briefUpdatedAt: at + 5000 });
    writeEnded(randomUUID(), { at, endedAt: at, stepSecondsAgo: 30 });

    const after = await loadSnapshot(request);
    expect(detailCount(after, 'no session row')).toBe(detailCount(before, 'no session row') + 2);
    expect(detailCount(after, 'ended')).toBe(detailCount(before, 'ended'));
  });

  test('E4 the database wins: a live session whose file says ended keeps its card', async ({ request }) => {
    const before = await loadSnapshot(request);
    const [live] = liveSessions(before);
    const at = secondsAgo(60);
    writeEnded(live.id, { at, endedAt: at });

    const after = await loadSnapshot(request);
    expect(after.cards.map((c) => c.id)).toContain(live.id);
    expect(detailCount(after, 'ended')).toBe(detailCount(before, 'ended'));
  });
});
