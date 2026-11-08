import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import {
  clearStateDir,
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
 * The goal comes from the brief, else the title of the first held lane. There is no third source:
 * prompt text is not in the data (fleet-data.spec.ts R4).
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
    const row = lanes.filter({ hasText: lane.id });
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
      brief: makeBrief({ title: 'E2E level 1 title', goal: LONG_GOAL }),
    });
    const card = await openCard(page, holder);

    await expectName(card, holder);
    await expectLanes(card, holder);
    await expectHeartbeat(card);
    const waiting = card.getByTestId('session-card-waiting');
    await check(waiting, 'field 5: the card says it waits on Dave').toHaveAttribute('data-waiting', 'true');
    await check(waiting).toContainText('Waiting on Dave');
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
    await expectGoalOneLine(card, holder.lanes[0].title.replace(/\s+/g, ' ').trim());

    await shoot(card, page, 'L2-no-brief', info);
  });
});
