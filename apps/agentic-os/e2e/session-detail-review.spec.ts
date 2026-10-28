import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  agent,
  ask,
  clearStateDir,
  makeBrief,
  secondsAgo,
  SESSION_ID_FORMAT,
  step,
  writeState,
  type FixturePr,
  type StateOptions,
} from './state-fixture';

/**
 * Review findings for P1b B1 (design: .claudedocs/2026-10-28-p1b-b1-design.md, rule 18):
 * no absolute path or home dir may reach any DTO or page, and the new source is ASCII only.
 *
 * session-detail.spec.ts covers a path in a proof artifact only. These specs cover the other
 * strings the detail shows: the running step label, an agent description, a decision text and
 * a PR state. READ-ONLY toward the app: GET and page loads. The only writes are fixture state
 * files in the private E2E state dir, emptied before and after every test.
 */

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

const LIVE_UNDER_SECONDS = 900;

type LiveSession = { id: string; liveSecondsAgo: number };

async function liveSession(request: APIRequestContext): Promise<LiveSession> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control must return 200').toBe(200);
  const snapshot = (await response.json()) as { active: { sessions: LiveSession[] } };
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

/** Write the fixture, then return the detail JSON text and the rendered page text. */
async function detailBodies(
  page: Page,
  request: APIRequestContext,
  options: StateOptions,
): Promise<{ json: string; text: string; html: string }> {
  const live = await liveSession(request);
  writeState(live.id, options);
  const json = await (await request.get(`/api/mission-control?session=${live.id}`)).text();
  await page.goto(`/?view=sessions&session=${live.id}`);
  await expect(page.getByTestId('session-detail')).toBeVisible();
  const text = await page.locator('body').innerText();
  const html = await page.content();
  return { json, text, html };
}

function expectNoPath(
  bodies: { json: string; text: string; html: string },
  leaks: string[],
): void {
  for (const [where, body] of Object.entries(bodies)) {
    for (const leak of leaks) {
      expect(body, `${where} leaks "${leak}"`).not.toContain(leak);
    }
    expect(body, `${where} leaks a Windows home path`).not.toMatch(/C:\\+Users/i);
  }
}

test.describe('paths in the strings the detail shows (B1 rule 18)', () => {
  test('a path in the running step label is replaced with <path>', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      step: step('Bash', `git -C C:\\Users\\win${tag}\\repo status`, 30),
    });
    expect(bodies.json).toContain('<path>');
    await expect(page.getByTestId('now-step')).toContainText('<path>');
    expectNoPath(bodies, [`win${tag}`]);
  });

  test('a POSIX home path in the running step label is replaced with <path>', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      step: step('Bash', `cd /c/Users/posix${tag}/proj && npm test`, 30),
    });
    expect(bodies.json).toContain('<path>');
    await expect(page.getByTestId('now-step')).toContainText('<path>');
    expectNoPath(bodies, [`posix${tag}`]);
  });

  test('a path in a running agent description is replaced with <path>', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      step: step('Task', 'E2E agent path step', 30),
      agents: [agent(`scan C:\\Users\\agent${tag}\\src for TODOs`, 'scout', 'running')],
    });
    expect(bodies.json).toContain('<path>');
    await expect(page.getByTestId('now-agent').first()).toContainText('<path>');
    expectNoPath(bodies, [`agent${tag}`]);
  });

  test('the words around a path in a goal, an ask and a recommendation stay visible', async ({
    page,
    request,
  }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E words around a path',
        goal: `Move logs from /var/log/app${tag} to S3 and add tests`,
        ask: [
          ask(
            `Should I delete C:\\Users\\free${tag}\\cache or keep it?`,
            `Keep C:\\tmp\\rec${tag}.txt, then stop.`,
          ),
        ],
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText(
      'Move logs from <path> to S3 and add tests',
    );
    await expect(page.getByTestId('detail-ask')).toContainText('Should I delete <path> or keep it?');
    await expect(page.getByTestId('detail-ask')).toContainText('Keep <path>, then stop.');
    expectNoPath(bodies, [`app${tag}`, `free${tag}`, `rec${tag}`]);
  });

  test('a path with spaces in it does not leave its tail visible', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E paths with spaces',
        goal: `Archive /home/alice${tag}/Acme Corp/layoffs${tag}.csv before Friday`,
        ask: [
          ask(
            `Open "C:\\Users\\First Last${tag}\\My Docs\\plan.txt" now?`,
            `Use C:\\Users\\Jo Smith${tag}\\Program Files\\x.exe today.`,
          ),
        ],
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText('Archive <path> before Friday');
    await expect(page.getByTestId('detail-ask')).toContainText('Open <path> now?');
    await expect(page.getByTestId('detail-ask')).toContainText('Use <path> today.');
    expectNoPath(bodies, [
      'Acme Corp',
      `layoffs${tag}`,
      `Last${tag}`,
      'My Docs',
      `Smith${tag}`,
      'Program Files',
    ]);
  });

  test('a quoted path with an apostrophe is scrubbed whole', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E quoted path with an apostrophe',
        goal: `Archive "/home/alice${tag}/O'Brien/finance${tag}.txt" before Friday`,
        ask: [ask(`Open "C:\\Users\\Pat${tag}\\O'Neil Docs\\plan.txt" now?`)],
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText('Archive <path> before Friday');
    await expect(page.getByTestId('detail-ask')).toContainText('Open <path> now?');
    expectNoPath(bodies, ["O'Brien", `finance${tag}`, `Pat${tag}`, "O'Neil", 'plan.txt']);
  });

  test('a link after a path is kept, not absorbed into the path', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const link = `https://example.com/ticket/${tag}`;
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E link after a path',
        goal: `Fix the report in /tmp/report${tag} ${link} then stop`,
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText(`Fix the report in <path> ${link} then stop`);
    expectNoPath(bodies, [`report${tag}`]);
  });

  test('a Markdown link after a path is kept', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const link = `[proof](https://example.com/ticket/${tag})`;
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E markdown link after a path',
        goal: `Fix /tmp/report${tag} ${link} then stop`,
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText(`Fix <path> ${link} then stop`);
    expectNoPath(bodies, [`report${tag}`]);
  });

  test('home-relative paths are scrubbed like absolute ones', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E home-relative paths',
        goal: `Open ~/Documents/Acme${tag} Corp/plan.txt now`,
        ask: [ask(`Then %USERPROFILE%\\tmp${tag}\\f.txt and $HOME/h${tag}/g.txt end`)],
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-goal')).toContainText('Open <path> now');
    await expect(page.getByTestId('detail-ask')).toContainText('Then <path> and <path> end');
    expectNoPath(bodies, [`Acme${tag}`, 'plan.txt', `tmp${tag}`, `h${tag}`]);
  });

  test('a path in the author of a decision is scrubbed', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E decision author path',
        decisions: [{ text: 'kept the plan', by: `C:\\Users\\by${tag}\\dave`, at: secondsAgo(300) }],
        updatedAt: secondsAgo(60),
      }),
    });
    await expect(page.getByTestId('detail-decisions')).toContainText('kept the plan');
    expect(bodies.json).toContain('<path>');
    expectNoPath(bodies, [`by${tag}`]);
  });

  test('a path in a decision text is replaced with <path>', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    const bodies = await detailBodies(page, request, {
      brief: makeBrief({
        title: 'E2E decision path title',
        decisions: [
          { text: `kept the file at C:\\Users\\dec${tag}\\notes.txt`, by: 'dave', at: secondsAgo(300) },
        ],
        updatedAt: secondsAgo(60),
      }),
    });
    expect(bodies.json).toContain('<path>');
    await expect(page.getByTestId('detail-decisions')).toContainText('<path>');
    expectNoPath(bodies, [`dec${tag}`, 'notes.txt']);
  });

  test('a path and a token in a PR state never reach the page', async ({ page, request }) => {
    const tag = randomUUID().slice(0, 8);
    // Built at run time: a literal ghp_ token in this file is a NEW secret finding for the Trivy ratchet.
    const token = ['ghp', '_'].join('') + 'A'.repeat(36);
    const hostile = {
      pr: 4321,
      state: `C:\\Users\\prs${tag}\\x ${token}`,
      whenReady: false,
    } as unknown as FixturePr;
    const bodies = await detailBodies(page, request, { prs: [hostile] });
    await expect(page.getByTestId('health-pr').first()).toContainText('4321');
    expectNoPath(bodies, [`prs${tag}`, token.slice(0, 8), 'AAAAAAAAAAAA']);
  });
});

test.describe('ASCII only in the new B1 source files', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [
    'components/fleet/NavTabs.tsx',
    'components/fleet/SessionDetail.tsx',
    'components/fleet/SessionsTable.tsx',
    'server/queries/session-detail.ts',
  ];

  for (const file of files) {
    test(`${file} holds no non-ASCII character`, () => {
      const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
      const bad = lines
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /[^\x00-\x7F]/.test(line))
        .map(({ number }) => number);
      expect(bad, `non-ASCII character on line(s) ${bad.join(', ')}`).toEqual([]);
    });
  }
});
