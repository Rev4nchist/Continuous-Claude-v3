import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  ask,
  clearIdentityDir,
  clearStateDir,
  findQuietSessionId,
  makeBrief,
  removeIdentityDir,
  writeIdentity,
  writeIdentityDir,
  writeIdentityRaw,
  writeState,
} from './state-fixture';

/**
 * Session name in the Fleet view (session identity Phase 1, item C).
 * Design: .claudedocs/2026-11-03-session-identity-phase1-plan.md, section 5.
 *
 * The server reads `<AGENTIC_OS_IDENTITY_DIR>/<sessionId>.json` BY ID and adds a nullable
 * `sessionName` to cards, Ready for Dave rows and the detail. The label reads `name #sid8`
 * (first 8 characters of the id); a null name reads `unnamed #sid8`, muted.
 *
 * Like the other specs: they borrow REAL live sessions from GET /api/mission-control and write
 * fixture files in the private state and identity dirs, which are emptied before and after
 * every test. Only F2 may skip, and only when no live session has a real name.
 */

const LIVE_UNDER_SECONDS = 900;

test.beforeEach(() => {
  clearStateDir();
  clearIdentityDir();
});
test.afterEach(() => {
  clearStateDir();
  clearIdentityDir();
});

type Session = { id: string; shortId: string; liveSecondsAgo: number };

type Source = { id: string; status: string; detail: string };

type Snapshot = {
  active: { sessions: Session[] };
  cards: { id: string; name: string; sessionName?: string | null }[];
  ready: { sessionId: string; name: string; sessionName?: string | null; live: boolean }[];
  detail: { id: string; name: string; sessionName?: string | null } | null;
  sources: Source[];
};

async function loadSnapshot(request: APIRequestContext, sessionId?: string): Promise<Snapshot> {
  const url = sessionId === undefined ? '/api/mission-control' : `/api/mission-control?session=${sessionId}`;
  const response = await request.get(url);
  expect(response.status(), `GET ${url} must return 200`).toBe(200);
  return (await response.json()) as Snapshot;
}

function liveSessions(snapshot: Snapshot): Session[] {
  const live = snapshot.active.sessions.filter((s) => s.liveSecondsAgo < LIVE_UNDER_SECONDS);
  expect(
    live.length,
    'Precondition: the database needs a live session (liveSecondsAgo < 900). Open a Claude Code session and run again.',
  ).toBeGreaterThanOrEqual(1);
  return live;
}

async function liveSession(request: APIRequestContext): Promise<Session> {
  return liveSessions(await loadSnapshot(request))[0];
}

const cardOf = (snapshot: Snapshot, id: string) => snapshot.cards.find((c) => c.id === id);

const sessionCard = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
const sessionRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
const readyItem = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="ready-item"][data-session-id="${id}"]`);
const label = (scope: Locator): Locator => scope.getByTestId('session-label');

/** The `sessionName` the API gives the card of `id`, polled once. */
async function cardName(request: APIRequestContext, id: string): Promise<string | null | undefined> {
  return cardOf(await loadSnapshot(request), id)?.sessionName;
}

/** Built from code points: the source file holds no bidi or zero-width character. */
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BIDI = String.fromCharCode(0x202e);
const BELL = String.fromCharCode(0x0007);

// --- F1: a named live session --------------------------------------------------------------------

test('F1 a named live session shows "name #sid8" on its card and its table row', async ({ page, request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'E2E-otter' });
  const expected = `E2E-otter #${live.id.slice(0, 8)}`;

  expect(await cardName(request, live.id)).toBe('E2E-otter');

  await page.goto('/');
  await expect(label(sessionCard(page, live.id))).toHaveText(expected);
  await page.goto('/?view=sessions');
  await expect(label(sessionRow(page, live.id))).toHaveText(expected);
});

// --- F2: isolation -------------------------------------------------------------------------------

test('F2 the E2E server ignores the real identity folder', async ({ page, request }) => {
  // Without this guard the test passes when the server ignores AGENTIC_OS_IDENTITY_DIR and the
  // live session simply has no name. Find a live session whose REAL file has a name.
  const realDir = join(process.env.USERPROFILE || process.env.HOME || homedir(), '.claude', 'state', 'identity');
  let named: Session | undefined;
  for (const session of liveSessions(await loadSnapshot(request))) {
    try {
      const real = JSON.parse(readFileSync(join(realDir, `${session.id}.json`), 'utf8')) as { name?: unknown };
      if (typeof real.name === 'string' && real.name.trim() !== '') {
        named = session;
        break;
      }
    } catch {
      // no readable real file for this session: try the next one
    }
  }
  test.skip(named === undefined, 'No live session has a name in the real identity folder, so isolation cannot be shown.');
  const live = named as Session;

  expect(await cardName(request, live.id)).toBeNull();
  await page.goto('/');
  await expect(label(sessionCard(page, live.id))).toHaveText(`unnamed #${live.id.slice(0, 8)}`);
});

// --- F3: names that are not names -----------------------------------------------------------------

test('F3 a null, empty, blank or numeric name is unnamed, in muted colour', async ({ page, request }) => {
  const live = await liveSession(request);
  for (const bad of [null, '', '   \t ', 42, { a: 1 }, ['x']]) {
    writeIdentity(live.id, { name: bad });
    expect(await cardName(request, live.id), `name ${JSON.stringify(bad)}`).toBeNull();
  }

  await page.goto('/');
  const shown = label(sessionCard(page, live.id));
  await expect(shown).toHaveText(`unnamed #${live.id.slice(0, 8)}`);
  // D7: muted, never the amber of "waiting on Dave".
  await expect(shown).toHaveClass(/text-muted-foreground/);
  await expect(shown).not.toHaveClass(/warn/);
});

// --- F4: unreadable files ------------------------------------------------------------------------

test('F4 a corrupt file, an oversize file and a directory named <id>.json are unnamed, API 200, source ok', async ({
  request,
}) => {
  const live = await liveSession(request);
  const baseline = (await loadSnapshot(request)).sources.find((s) => s.id === 'state-files');

  const cases: [string, () => void][] = [
    ['corrupt JSON', () => writeIdentityRaw(`${live.id}.json`, '{"name": "E2E-corrupt"')],
    [
      'oversize file',
      () =>
        writeIdentityRaw(
          `${live.id}.json`,
          JSON.stringify({ uuid: live.id, name: 'E2E-oversize', pad: 'x'.repeat(20 * 1024) }),
        ),
    ],
    ['directory', () => writeIdentityDir(`${live.id}.json`)],
  ];
  for (const [what, make] of cases) {
    clearIdentityDir();
    make();
    const snapshot = await loadSnapshot(request);
    expect(cardOf(snapshot, live.id)?.sessionName, what).toBeNull();
    const source = snapshot.sources.find((s) => s.id === 'state-files');
    expect(source?.status, `${what}: state-files source`).toBe(baseline?.status);
  }
});

// --- F5, F6, F7: strip, redact, scrub ---------------------------------------------------------------

test('F5 bidi, zero-width and control characters are stripped', async ({ request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: `a${BIDI}b${ZERO_WIDTH}c${BELL}d` });
  expect(await cardName(request, live.id)).toBe('abcd');
});

test('F6 a secret split by a zero-width character is redacted before it is clipped', async ({ page, request }) => {
  const live = await liveSession(request);
  const body = 'Zq8Lm2Xv9Kp4Rt6Wy1Bn3Hc5Jd7Fg0';
  writeIdentity(live.id, { name: `sk-${ZERO_WIDTH}${body}` });

  const snapshot = await loadSnapshot(request);
  // The marker, clipped to 16 code points: redaction ran on the stripped text, then the clip.
  expect(cardOf(snapshot, live.id)?.sessionName).toBe('[REDACTED:provid');
  // The first 12 characters of the body sit inside the 16 character clip. They are visible
  // whenever redaction ran after the clip, or before the strip.
  expect(JSON.stringify(snapshot)).not.toContain(body.slice(0, 12));
  expect(JSON.stringify(snapshot)).not.toContain(body.slice(-12));
  await page.goto('/');
  await expect(sessionCard(page, live.id)).toBeVisible();
  expect(await page.content()).not.toContain(body.slice(0, 12));
});

test('F7 a name that starts with an absolute path shows no path text', async ({ page, request }) => {
  const live = await liveSession(request);
  for (const raw of ['C:\\Users\\e2e-person\\finance\\plan.txt', '/home/e2e-person/finance/plan.txt']) {
    writeIdentity(live.id, { name: raw });
    const snapshot = await loadSnapshot(request);
    expect(cardOf(snapshot, live.id)?.sessionName, raw).toBe('<path>');
    const text = JSON.stringify(snapshot);
    expect(text, raw).not.toContain('e2e-person');
    expect(text, raw).not.toContain('finance');
  }
  await page.goto('/');
  await expect(sessionCard(page, live.id)).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('e2e-person');
  expect(html).not.toContain('finance');
});

// --- F8: clip ------------------------------------------------------------------------------------

test('F8 a 40 character name clips to 16 code points with no ellipsis; an emoji at the cut stays whole', async ({
  request,
}) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'abcdefghij'.repeat(4) });
  expect(await cardName(request, live.id)).toBe('abcdefghijabcdef');

  const emoji = String.fromCodePoint(0x1f600);
  writeIdentity(live.id, { name: `${'a'.repeat(15)}${emoji}zzz` });
  expect(await cardName(request, live.id)).toBe(`${'a'.repeat(15)}${emoji}`);

  // Whitespace collapses first, then trims: the clip rule of the hooks (clipName).
  writeIdentity(live.id, { name: '  two \n\t words  ' });
  expect(await cardName(request, live.id)).toBe('two words');
});

// --- F9: privacy ---------------------------------------------------------------------------------

test('F9 the cwd and previous of an identity file never reach the snapshot or the page', async ({ page, request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, {
    name: 'E2E-private',
    cwd: 'C:\\Users\\e2e-cwd-marker\\repo',
    previous: 'e2e-previous-marker-uuid',
  });
  const text = JSON.stringify(await loadSnapshot(request));
  expect(text).toContain('E2E-private');
  expect(text).not.toContain('e2e-cwd-marker');
  expect(text).not.toContain('e2e-previous-marker');

  const html = await (await request.get('/')).text();
  expect(html).not.toContain('e2e-cwd-marker');
  expect(html).not.toContain('e2e-previous-marker');
  await page.goto('/');
  await expect(label(sessionCard(page, live.id))).toContainText('E2E-private');
});

// --- F10: the file name is the identity ---------------------------------------------------------------

test('F10 the file name wins over the uuid inside the file', async ({ request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'E2E-by-file', uuid: randomUUID() });
  expect(await cardName(request, live.id)).toBe('E2E-by-file');

  clearIdentityDir();
  // Another file carries the live id inside it. It must not name the live session.
  writeIdentity(randomUUID(), { name: 'E2E-wrong', uuid: live.id });
  expect(await cardName(request, live.id)).toBeNull();
});

// --- F11: Ready for Dave, quiet session ----------------------------------------------------------------

test('F11 a quiet session row in Ready for Dave shows the name', async ({ page, request }) => {
  const quietId = await findQuietSessionId({ validFormat: true });
  writeState(quietId, { brief: makeBrief({ ask: [ask('E2E name ask')] }) });
  writeIdentity(quietId, { name: 'E2E-quiet' });

  const row = (await loadSnapshot(request)).ready.find((r) => r.sessionId === quietId);
  expect(row?.live).toBe(false);
  expect(row?.sessionName).toBe('E2E-quiet');

  await page.goto('/');
  await expect(label(readyItem(page, quietId))).toHaveText(`E2E-quiet #${quietId.slice(0, 8)}`);
});

test('F11b a live session row in Ready for Dave shows the name, or unnamed', async ({ page, request }) => {
  const live = await liveSession(request);
  writeState(live.id, { brief: makeBrief({ ask: [ask('E2E live name ask')] }) });
  await page.goto('/');
  await expect(label(readyItem(page, live.id))).toHaveText(`unnamed #${live.id.slice(0, 8)}`);

  writeIdentity(live.id, { name: 'E2E-live' });
  await expect(async () => {
    await page.goto('/');
    await expect(label(readyItem(page, live.id))).toHaveText(`E2E-live #${live.id.slice(0, 8)}`, { timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
});

// --- F12: detail ---------------------------------------------------------------------------------

test('F12 the detail has sessionName and its header shows the label', async ({ page, request }) => {
  const live = await liveSession(request);
  writeState(live.id, {});
  writeIdentity(live.id, { name: 'E2E-detail' });

  const snapshot = await loadSnapshot(request, live.id);
  expect(snapshot.detail?.sessionName).toBe('E2E-detail');

  await page.goto(`/?session=${live.id}`);
  await expect(label(page.getByTestId('detail-header'))).toHaveText(`E2E-detail #${live.id.slice(0, 8)}`);

  clearIdentityDir();
  expect((await loadSnapshot(request, live.id)).detail?.sessionName).toBeNull();
});

// --- F13: a rename is not cached ----------------------------------------------------------------------

test('F13 rewriting the file shows the new name on the next poll', async ({ request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'E2E-first' });
  await expect.poll(() => cardName(request, live.id)).toBe('E2E-first');
  writeIdentity(live.id, { name: 'E2E-second' });
  await expect.poll(() => cardName(request, live.id)).toBe('E2E-second');
});

// --- F14: card.name is unchanged -----------------------------------------------------------------------

test('F14 card.name stays the composite project/branch/id4', async ({ request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'E2E-composite' });
  const card = cardOf(await loadSnapshot(request), live.id);
  expect(card?.name).toMatch(new RegExp(`^[^/]+/[^/]+/${live.id.slice(0, 4)}$`));
  expect(card?.name).not.toContain('E2E-composite');
});

// --- F15: phone width ---------------------------------------------------------------------------------

test('F15 a wide name wraps inside the card and the page has no horizontal scroll', async ({ page, request }) => {
  const live = await liveSession(request);
  writeIdentity(live.id, { name: 'WWWWWWWWWWWWWWWW' });
  writeState(live.id, {});
  for (const url of ['/', '/?view=sessions', `/?session=${live.id}`]) {
    await page.goto(url);
    await expect(page.getByTestId('nav-tabs')).toBeVisible();
    await expect(label(page.locator(`[data-session-id="${live.id}"]`).first())).toContainText('WWWWWWWWWWWWWWWW');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${url}: horizontal overflow`).toBeLessThanOrEqual(0);
  }
});

// --- F16: no identity folder ---------------------------------------------------------------------------

test('F16 no identity folder: every card is unnamed, API 200, no new source row', async ({ request }) => {
  const before = await loadSnapshot(request);
  removeIdentityDir();
  try {
    const after = await loadSnapshot(request);
    expect(after.cards.length).toBeGreaterThan(0);
    for (const card of after.cards) expect(card.sessionName, card.id).toBeNull();
    expect(after.sources.map((s) => s.id)).toEqual(before.sources.map((s) => s.id));
    expect(after.sources.find((s) => s.id === 'state-files')?.status).toBe(
      before.sources.find((s) => s.id === 'state-files')?.status,
    );
  } finally {
    clearIdentityDir();
  }
});
