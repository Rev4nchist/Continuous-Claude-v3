import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import {
  ask,
  clearStateDir,
  expectedLaneGoal,
  findLaneHolderSession,
  makeBrief,
  writeState,
  type LaneHolder,
} from './state-fixture';

/**
 * Fleet level 1: ONE card per live session with six fields. Design:
 * .claudedocs/2026-11-07-fleet-level1-design.md. The card must show:
 *   1. name #sid8            2. every lane the session holds    3. lease time left (per lane)
 *   4. "heartbeat Nm ago"    5. waiting on Dave: yes or no      6. the goal, clipped to ONE line
 * The goal comes from a brief_set goal, else the title of the lane claimed last, else a parsed goal
 * (fleet-gpaa.spec.ts). Prompt text is not a source: it is not in the data (fleet-data.spec.ts R4).
 *
 * Both Playwright projects run it: `chromium` (1280 px) and `phone` (390 px).
 *
 * The oracle is the database, read with a SELECT of its own (findLaneHolderSession), not the app's
 * query. The session is a REAL live session that holds real lanes: the SELECT-only role cannot make
 * one. Only a state file is written, in the private E2E state dir, emptied before and after each test.
 * Every assertion is soft, so one RED run lists every missing field.
 *
 * Screenshots go to <repo>/.claudedocs/e2e-fleet-level1/ (kept on green too).
 */

type FakeLane = { id: string; title: string; leaseSecondsLeft: number | null };

/**
 * Replace the `lanes` of ONE card in every `/api/mission-control` answer the page polls. The SELECT-only
 * e2e role cannot write a lane, and the state file does not carry lanes, so this is the only way to draw
 * an empty lane list, a lane with no lease or two lane ids where one is a prefix of the other.
 * Call it BEFORE `page.goto`. The first server render still shows the real lanes; the first poll swaps them.
 */
async function withCardLanes(page: Page, sessionId: string, lanes: FakeLane[]): Promise<void> {
  await page.route('**/api/mission-control**', async (route) => {
    const response = await route.fetch();
    const json = (await response.json().catch(() => null)) as { cards?: Array<{ id: string; lanes: unknown }> } | null;
    if (json === null || !Array.isArray(json.cards)) {
      await route.fulfill({ response });
      return;
    }
    for (const card of json.cards) if (card.id === sessionId) card.lanes = lanes;
    await route.fulfill({ response, json });
  });
}

const SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claudedocs', 'e2e-fleet-level1');

// Under the 200 character clip of state-files.ts (CLIP.goal), but wider than a 390 px card at any font size.
const LONG_GOAL =
  'Show one card per live Claude session with every held lane, the lease time left, the heartbeat age and this goal line clipped to one line.';

// Soft checks with a short wait: one RED run lists every missing field instead of stopping at the first.
const check = expect.configure({ soft: true, timeout: 4_000 });
test.setTimeout(90_000);

test.beforeEach(() => clearStateDir());
test.afterEach(() => clearStateDir());

async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({ timeout: 15_000 });
}

async function openCard(page: Page, holder: LaneHolder): Promise<Locator> {
  await page.goto('/');
  await waitForHydration(page);
  const card = page.locator(`[data-testid="session-card"][data-session-id="${holder.sessionId}"]`);
  await expect(card, `a card for live session #${holder.shortId} must be on the page`).toBeVisible();
  return card;
}

async function shoot(card: Locator, page: Page, name: string, info: TestInfo): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await card.screenshot({ path: join(SHOT_DIR, `${name}-${info.project.name}-card.png`) });
  await page.screenshot({ path: join(SHOT_DIR, `${name}-${info.project.name}-page.png`), fullPage: false });
}

function expectName(card: Locator, holder: LaneHolder): Promise<void> {
  return check(card.getByTestId('session-label'), 'field 1: the card shows "name #sid8"')
    .toContainText(`#${holder.shortId}`);
}

async function expectLanes(card: Locator, holder: LaneHolder): Promise<void> {
  const lanes = card.getByTestId('session-card-lane');
  await check(lanes, `field 2: the card draws all ${holder.lanes.length} held lanes, not the first only`)
    .toHaveCount(holder.lanes.length);
  for (const lane of holder.lanes) {
    // The exact id, not a substring: lane a1 must not also match a12.
    const row = card.locator(`[data-testid="session-card-lane"][data-lane-id="${lane.id}"]`);
    await check(row, `field 2: lane ${lane.id} is on the card`).toHaveCount(1);
    // Field 3: lease time left, per lane.
    const lease = row.getByTestId('session-card-lease');
    if (lane.leaseSecondsLeft === null) {
      await check(lease, `field 3: lane ${lane.id} has no lease`).toHaveText('no lease');
      continue;
    }
    await check(lease, `field 3: lane ${lane.id} shows its lease time left`)
      .toHaveText(/^lease (lapsed .+|<1m left|(\d+h )?\d+m left)$/);
    const seconds = Number(await lease.getAttribute('data-lease-seconds', { timeout: 2_000 }).catch(() => null));
    check(Math.abs(seconds - lane.leaseSecondsLeft), `field 3: lane ${lane.id} lease seconds match the database`)
      .toBeLessThanOrEqual(180);
    const tone = lane.leaseSecondsLeft <= 0 ? 'lapsed' : lane.leaseSecondsLeft <= 15 * 60 ? 'short' : 'ok';
    // Skip the tone check within 3 minutes of a boundary: the page and the oracle read at different times.
    if (Math.abs(lane.leaseSecondsLeft) > 180 && Math.abs(lane.leaseSecondsLeft - 15 * 60) > 180) {
      await check(lease, `field 3: lane ${lane.id} tone`).toHaveAttribute('data-lease-tone', tone);
    }
  }
}

async function expectHeartbeat(card: Locator): Promise<void> {
  await check(card.getByTestId('session-card-heartbeat'), 'field 4: the card shows "last prompt Nm ago"')
    .toHaveText(/^last prompt (just now|\d+[mhd] ago)$/);
}

type GoalBox = { whiteSpace: string; overflow: string; height: number; lineHeight: number; clipped: boolean };

async function expectGoalOneLine(card: Locator, text: string | RegExp): Promise<GoalBox> {
  const goal = card.getByTestId('session-card-goal');
  await check(goal, 'field 6: the card shows the goal').toHaveText(text);
  // A missing goal element must fail the checks below, not hang the test.
  const box: GoalBox = await goal
    .evaluate(
      (el) => {
        const style = getComputedStyle(el);
        return {
          whiteSpace: style.whiteSpace,
          overflow: style.textOverflow,
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5,
          clipped: el.scrollWidth > el.clientWidth,
        };
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => ({ whiteSpace: 'missing', overflow: 'missing', height: Infinity, lineHeight: 1, clipped: false }));
  check(box.whiteSpace, 'field 6: the goal does not wrap').toBe('nowrap');
  check(box.overflow, 'field 6: a long goal ends in an ellipsis').toBe('ellipsis');
  check(box.height, 'field 6: the goal is one line tall').toBeLessThanOrEqual(box.lineHeight * 1.5);
  return box;
}

test.describe('Fleet level 1 card', () => {
  test('L1 a live session card shows name, all lanes, lease, heartbeat, waiting on Dave and a one-line goal', async ({
    page,
  }, info) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      chip: 'waiting-on-dave',
      branch: 'e2e/level1',
      // An open ask makes the card wait: since GPAA F2 the chip alone does not (fleet-gpaa.spec.ts W1).
      // sources.goal brief_set so the goal outranks the held lanes (fleet-gpaa.spec.ts G1).
      brief: makeBrief({ title: 'E2E level 1 title', goal: LONG_GOAL, ask: [ask('E2E level 1 open ask')] }),
    });
    const card = await openCard(page, holder);

    await expectName(card, holder);
    await expectLanes(card, holder);
    await expectHeartbeat(card);
    const waiting = card.getByTestId('session-card-waiting');
    await check(waiting, 'field 5: the card says it waits on Dave').toHaveAttribute('data-waiting', 'true');
    await check(waiting).toContainText('Waiting for you');
    const goalBox = await expectGoalOneLine(card, LONG_GOAL);
    check(goalBox.clipped, 'field 6: a goal this long is cut off at the card edge').toBe(true);

    await shoot(card, page, 'L1-waiting', info);
  });

  test('L2 with no brief the goal is the first lane title, and the card says it is not waiting', async ({
    page,
  }, info) => {
    const holder = await findLaneHolderSession();
    // No state file: a headless-like session. Name, lanes, lease and heartbeat still show.
    const card = await openCard(page, holder);

    await expectName(card, holder);
    await expectLanes(card, holder);
    await expectHeartbeat(card);
    await check(card.getByTestId('session-card-waiting'), 'field 5: the card says it does not wait on Dave')
      .toHaveAttribute('data-waiting', 'false');
    await check(card.getByTestId('session-card-waiting')).toHaveText('Not waiting for you');
    // The lane claimed last, not lanes[0] (GPAA F1).
    await expectGoalOneLine(card, expectedLaneGoal(holder.lanes) ?? '');

    await shoot(card, page, 'L2-no-brief', info);
  });
});

// Edge cases the live database cannot hold on demand. The SELECT-only role cannot write a lane, so
// withCardLanes() rewrites the `lanes` of one card in the poll answer. The server render still shows the
// real lanes first; each check waits for the rewritten row (polled, so a longer timeout than `check`).
const polled = expect.configure({ soft: true, timeout: 12_000 });

test.describe('Fleet level 1 card, edge lanes', () => {
  test('L3 a session with an empty lane list says "No lane held" and draws no lane row', async ({ page }) => {
    const holder = await findLaneHolderSession();
    await withCardLanes(page, holder.sessionId, []);
    const card = await openCard(page, holder);

    await polled(card.getByTestId('session-card-no-lanes'), 'an empty lane list shows "No lane held"')
      .toHaveText('No lane held');
    await polled(card.getByTestId('session-card-lane'), 'an empty lane list draws no lane row').toHaveCount(0);
  });

  test('L4 a lane with no lease shows "no lease", tone none and no lease seconds', async ({ page }) => {
    const holder = await findLaneHolderSession();
    await withCardLanes(page, holder.sessionId, [{ id: 'e2e-nolease', title: 'No lease lane', leaseSecondsLeft: null }]);
    const card = await openCard(page, holder);

    const row = card.locator('[data-testid="session-card-lane"][data-lane-id="e2e-nolease"]');
    await polled(row, 'the rewritten lane is on the card').toHaveCount(1);
    const lease = row.getByTestId('session-card-lease');
    await polled(lease, 'no lease reads "no lease"').toHaveText('no lease');
    await polled(lease, 'no lease has tone none').toHaveAttribute('data-lease-tone', 'none');
    await polled(lease, 'no lease has no data-lease-seconds').not.toHaveAttribute('data-lease-seconds', /.*/);
  });

  test('L5 lane ids a1 and a12 each match exactly one row (a substring match finds a1 twice)', async ({ page }) => {
    const holder = await findLaneHolderSession();
    const lanes = [
      { id: 'a1', title: 'A one', leaseSecondsLeft: 3600 },
      { id: 'a12', title: 'A twelve', leaseSecondsLeft: 7200 },
    ];
    await withCardLanes(page, holder.sessionId, lanes);
    const card = await openCard(page, holder);

    // Wait for the rewritten rows by their exact ids. A real session may hold two lanes, so a bare row
    // count of 2 can pass on the server render, before the first poll swaps the lanes.
    for (const lane of lanes) {
      await polled(
        card.locator(`[data-testid="session-card-lane"][data-lane-id="${lane.id}"]`),
        `lane ${lane.id} matches exactly one row by its exact id`,
      ).toHaveCount(1);
    }
    await expectLanes(card, { ...holder, lanes: lanes.map((lane) => ({ ...lane, claimedAtEpoch: null })) });
  });
});
