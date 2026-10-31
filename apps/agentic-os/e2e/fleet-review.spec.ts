import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  clearStateDir,
  findQuietSessionId,
  makeBrief,
  makeSnapshot,
  ask,
  secondsAgo,
  writeState,
  STATE_DIR,
} from './state-fixture';

/**
 * Review findings for P1b PR A. Kept apart from fleet.spec.ts (the committed RED specs).
 *
 * Finding P1: the state-files detail leaked the absolute state dir (and with it the OS user
 * name and home layout) into /api/mission-control and into the Data sources row.
 *
 * Second round: symbolic links, an unreadable state dir, a card for a session that has a task
 * list but no brief, and the footer copy the PRD asks for.
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

type Source = { id: string; status: string; detail: string };

type LiveCard = {
  id: string;
  hasBrief: boolean;
  planDone: number;
  planTotal: number;
  unproven: number;
};

type Snapshot = {
  active: { sessions: { id: string; liveSecondsAgo: number }[] };
  cards: LiveCard[];
  ready: { sessionId: string; text: string; openAsks: number; live: boolean; name: string }[];
  tiles: { needsDave: number; liveSessions: number };
  sources: Source[];
};

async function loadSnapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  return (await response.json()) as Snapshot;
}

/** The id of a live session (a sign of life under 15 minutes ago). Fails if none. */
async function liveId(request: APIRequestContext): Promise<string> {
  const live = (await loadSnapshot(request)).active.sessions.find((s) => s.liveSecondsAgo < 900);
  expect(live, 'Precondition: the database needs a live session (liveSecondsAgo < 900).').toBeDefined();
  return (live as { id: string }).id;
}

const stateSource = (snapshot: Snapshot): Source => {
  const found = snapshot.sources.find((s) => s.id === 'state-files');
  expect(found, 'sources must contain state-files').toBeDefined();
  return found as Source;
};

/** Fragments of an absolute path that must never reach the client. */
function pathFragments(): string[] {
  const fragments = [STATE_DIR, homedir(), tmpdir()];
  const user = process.env.USERNAME ?? process.env.USER;
  if (user) fragments.push(user);
  return fragments.filter((f) => f.length > 3);
}

test.describe('state-files detail does not leak local paths', () => {
  test('API: sources[] holds no absolute path or user name', async ({
    request,
  }) => {
    // A file in the dir makes the reader run, so the check is not vacuous.
    writeState('00000000-0000-4000-8000-000000000001', {
      brief: makeBrief({ ask: [ask('E2E path leak control')] }),
    });

    const response = await request.get('/api/mission-control');
    expect(response.status()).toBe(200);
    const snapshot = (await response.json()) as { sources: Source[] };
    // Scope: the data-source rows. active.sessions[].rawProject is a separate, older field.
    const text = JSON.stringify(snapshot.sources);

    const state = snapshot.sources.find((s) => s.id === 'state-files');
    expect(state, 'sources must contain state-files').toBeDefined();
    expect(state?.detail).toMatch(/\bfiles \d+\b/);
    expect(state?.detail, 'detail must not carry a "dir <path>" part').not.toMatch(/\bdir\b/);

    for (const fragment of pathFragments()) {
      expect(text, `sources[] leaks "${fragment}"`).not.toContain(fragment);
      expect(text, `sources[] leaks "${fragment}" (escaped)`).not.toContain(
        fragment.replace(/\\/g, '\\\\'),
      );
    }
  });

  test('page: the Data sources row shows no absolute path', async ({ page }) => {
    writeState('00000000-0000-4000-8000-000000000002', {
      brief: makeBrief({ ask: [ask('E2E path leak control')] }),
    });
    await page.goto('/');
    const row = page.getByTestId('source-state-files');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\bfiles \d+\b/);
    const rowText = await row.innerText();
    for (const fragment of pathFragments()) {
      expect(rowText, `Data sources row leaks "${fragment}"`).not.toContain(fragment);
    }
    expect(rowText).not.toMatch(/\bdir\b/);
  });
});

test.describe('second review round', () => {
  test('B: a symbolic link in the state dir is not followed and counts as unreadable', async ({
    request,
  }) => {
    const id = await liveId(request);
    const targetDir = mkdtempSync(join(tmpdir(), 'agentic-os-e2e-link-'));
    try {
      const target = join(targetDir, 'target.json');
      writeFileSync(
        target,
        JSON.stringify(
          makeSnapshot(id, { brief: makeBrief({ title: 'E2E link title', ask: [ask('E2E link ask')] }) }),
        ),
      );
      let linked = true;
      try {
        symlinkSync(target, join(STATE_DIR, `${id}.json`), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        linked = false;
      }
      test.skip(!linked, 'Creating a symbolic link needs a privilege this account lacks (EPERM).');

      const snapshot = await loadSnapshot(request);
      const detail = stateSource(snapshot).detail;
      expect(detail).toMatch(/\bfiles 1\b/);
      expect(detail, 'the link must count as unreadable').toMatch(/\bunreadable 1\b/);
      expect(snapshot.ready.map((r) => r.sessionId)).not.toContain(id);
      expect(snapshot.cards.find((c) => c.id === id)?.hasBrief).toBe(false);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('I: only a missing state dir is zero files; an unreadable one degrades the source', async ({
    request,
  }) => {
    try {
      // Missing: ENOENT. Nothing wrong, the writer has not run yet.
      rmSync(STATE_DIR, { recursive: true, force: true });
      const missing = stateSource(await loadSnapshot(request));
      expect(missing.status).toBe('ok');
      expect(missing.detail).toMatch(/\bfiles 0\b/);

      // A file where the directory should be: readdir fails with ENOTDIR, not ENOENT.
      writeFileSync(STATE_DIR, 'not a directory');
      const broken = stateSource(await loadSnapshot(request));
      expect(broken.status).toBe('degraded');
      expect(broken.detail).toBe('directory unreadable');
      expect(JSON.stringify(broken)).not.toContain(STATE_DIR);
    } finally {
      rmSync(STATE_DIR, { recursive: true, force: true });
      mkdirSync(STATE_DIR, { recursive: true });
    }
  });

  test('H: a live session with tasks and no brief still shows its plan bar and counts', async ({
    page,
    request,
  }) => {
    const id = await liveId(request);
    writeState(id, {
      brief: null,
      tasks: [
        { id: 't1', subject: 'E2E task one', status: 'completed' },
        { id: 't2', subject: 'E2E task two', status: 'pending' },
      ],
    });

    const card = (await loadSnapshot(request)).cards.find((c) => c.id === id);
    expect(card).toMatchObject({ hasBrief: false, planDone: 1, planTotal: 2, unproven: 1 });

    await page.goto('/');
    const item = page.locator(`[data-testid="session-card"][data-session-id="${id}"]`);
    await expect(item).toContainText('No brief yet');
    await expect(item).toContainText('1 of 2');
    await expect(item).toContainText('UNPROVEN 1');
    await expect(item).toContainText(/\bASK 0\b/);
  });

  test('J: the footer states SELECT-only, localhost, no login', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('footer');
    await expect(footer).toContainText(/Connected as agentic_os_app \(SELECT-only, \d+ms\)\./);
    await expect(footer).toContainText('localhost, no login');
  });
});

/**
 * Dave decided on 2026-10-28 ("24hr strip"): Ready for Dave uses a 24 h window, session cards
 * keep the 15 minute window. A session that waits on Dave sends no prompt, so after 15 minutes
 * it leaves the live window; its ask must stay in the strip (PRD 5.2: until 24 h after the last
 * session activity). Such a QUIET session (15 min to 24 h since its last sign of life, not
 * ended) gets no card and is counted as `quiet N` in the state-files detail.
 */
test.describe('quiet sessions (15 minutes to 24 hours) still feed Ready for Dave', () => {
  const QUIET_ASK = 'E2E quiet ask';
  const QUIET_RECOMMEND = 'E2E quiet recommend';

  /** Read "<label> <n>" from the state-files detail. A label at the start or after ", ". */
  function count(detail: string, label: string): number {
    const match = new RegExp(`(?:^|, )${label} (\\d+)`).exec(detail);
    expect(match, `state-files detail "${detail}" must contain "${label} <n>"`).not.toBeNull();
    return Number((match as RegExpExecArray)[1]);
  }

  test('API and page: the ask is in the strip and the tiles, with no card', async ({
    page,
    request,
  }) => {
    const id = await findQuietSessionId();
    const before = await loadSnapshot(request);
    const staleBefore = count(stateSource(before).detail, 'stale');

    writeState(id, {
      brief: makeBrief({ title: 'E2E quiet title', ask: [ask(QUIET_ASK, QUIET_RECOMMEND)] }),
    });

    const snapshot = await loadSnapshot(request);
    const item = snapshot.ready.find((r) => r.sessionId === id);
    expect(item, `ready must hold the ask of the quiet session ${id}`).toBeDefined();
    // A quiet session is one ready row marked live:false; the row carries no recommendation.
    expect(item).toMatchObject({ text: QUIET_ASK, openAsks: 1, live: false });
    expect(Object.keys(item as object)).not.toContain('recommend');
    expect(item?.name, 'the item needs a name: <project>/<branch>/<id4>').toMatch(
      new RegExp(`/-/${id.slice(0, 4)}$`),
    );
    expect(snapshot.cards.map((c) => c.id), 'a quiet session gets no card').not.toContain(id);
    expect(snapshot.tiles.needsDave).toBe(before.tiles.needsDave + 1);
    expect(snapshot.tiles.liveSessions, 'liveSessions stays live-only').toBe(
      before.tiles.liveSessions,
    );

    const detail = stateSource(snapshot).detail;
    expect(count(detail, 'quiet')).toBe(1);
    expect(count(detail, 'stale'), 'a quiet snapshot is not a stale one').toBe(staleBefore);
    expect(stateSource(snapshot).status, 'a quiet snapshot does not degrade the source').toBe('ok');

    await page.goto('/');
    const stripItem = page.locator(`[data-testid="ready-item"][data-session-id="${id}"]`);
    await expect(stripItem).toBeVisible();
    await expect(stripItem).toContainText(QUIET_ASK);
    await expect(stripItem).not.toContainText(QUIET_RECOMMEND);
    await expect(stripItem).toContainText('· quiet');
    // The header counts the quiet rows: "N waiting · 1 from quiet sessions".
    await expect(page.getByTestId('ready-for-dave').locator('header')).toContainText(
      /\d+ waiting · 1 from quiet sessions/,
    );
    await expect(
      page.locator(`[data-testid="session-card"][data-session-id="${id}"]`),
      'no session card for a quiet session',
    ).toHaveCount(0);
    await expect(page.getByTestId('source-state-files')).toContainText(/\bquiet 1\b/);
  });

  test('an ask older than 24 h stays out of the strip, also for a quiet session', async ({
    page,
    request,
  }) => {
    const id = await findQuietSessionId();
    const before = await loadSnapshot(request);

    writeState(id, {
      at: secondsAgo(25 * 3600),
      brief: makeBrief({
        title: 'E2E quiet stale title',
        ask: [ask('E2E quiet stale ask', 'E2E quiet stale recommend')],
        updatedAt: secondsAgo(25 * 3600),
      }),
    });

    const snapshot = await loadSnapshot(request);
    expect(snapshot.ready.map((r) => r.sessionId)).not.toContain(id);
    expect(snapshot.tiles.needsDave).toBe(before.tiles.needsDave);
    // The session is still quiet: the ask rule and the session rule are separate.
    expect(count(stateSource(snapshot).detail, 'quiet')).toBe(1);

    await page.goto('/');
    await expect(page.getByTestId('source-state-files')).toContainText(/\bquiet 1\b/);
    await expect(
      page.locator(`[data-testid="ready-item"][data-session-id="${id}"]`),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('E2E quiet stale ask');
  });
});
