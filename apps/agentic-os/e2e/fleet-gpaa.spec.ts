import { expect, test, type Locator, type Page } from '@playwright/test';

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
 * Fleet card, GPAA step F1 + F2. Design: .claudedocs/2026-11-08-gpaa-design.md, sections 5 and 6.
 *
 *   F2  One waiting rule. A card waits on Dave when it has an open, fresh ask, the same rule the
 *       Ready for Dave strip uses. The chip alone (`waiting-on-dave`, no open ask) does not make the
 *       card amber and does not say "Waiting for you" (the chip's own words; the line says "No open ask"
 *       so it never contradicts the chip). For every card: `data-waiting="true"` if and
 *       only if the strip has a row for that session.
 *   F1  The GOAL line says where it came from. Order: brief_set goal, the held lane with the newest
 *       claim (tagged [lane]), a parsed goal, none. `data-goal-source` is brief_set, lane, parsed or none.
 *
 * The session is a REAL live session that holds real lanes (findLaneHolderSession). Only a state file is
 * written, in the private E2E state dir, emptied before and after each test. No database write.
 * Both Playwright projects run it: `chromium` (1280 px) and `phone` (390 px).
 */

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

/** For EVERY card on the page: data-waiting is "true" exactly when the strip has a row for its session. */
async function expectWaitingMatchesStrip(page: Page): Promise<number> {
  const cards = page.getByTestId('session-card');
  const count = await cards.count();
  const rowIds = await page.getByTestId('ready-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-session-id')));
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const id = await card.getAttribute('data-session-id');
    const waiting = await card.getByTestId('session-card-waiting').getAttribute('data-waiting');
    expect(waiting, `card ${id}: data-waiting must be "true" iff a strip row exists`).toBe(
      rowIds.includes(id) ? 'true' : 'false',
    );
  }
  return count;
}

const BORDER_WARN = /(^|\s)border-warn(\s|$)/;

test.describe('F2 one waiting rule', () => {
  test('W1 the chip waiting-on-dave with no open ask gives no amber border, no strip row and a line that does not contradict the chip', async ({
    page,
  }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { chip: 'waiting-on-dave', brief: makeBrief({ title: 'E2E chip only', ask: [] }) });
    const card = await openCard(page, holder);

    await expect(card.locator('[data-chip]'), 'the chip itself is untouched').toHaveAttribute(
      'data-chip',
      'waiting-on-dave',
    );
    await expect(card.getByTestId('session-card-waiting')).toHaveAttribute('data-waiting', 'false');
    await expect(card.getByTestId('session-card-waiting')).toHaveText('No open ask');
    await expect(
      card.getByTestId('session-card-waiting'),
      'the line never says "Not waiting" beside a waiting chip',
    ).not.toContainText(/not waiting/i);
    await expect(card, 'no amber border without an open ask').not.toHaveClass(BORDER_WARN);
    await expect(page.locator(`[data-testid="ready-item"][data-session-id="${holder.sessionId}"]`)).toHaveCount(0);
    expect(await expectWaitingMatchesStrip(page)).toBeGreaterThanOrEqual(1);
  });

  test('W2 an open ask gives an amber border, a strip row and the chip phrase "Waiting for you" on the line', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      chip: 'waiting-on-dave',
      brief: makeBrief({ title: 'E2E open ask', ask: [ask('E2E which option do you pick?')] }),
    });
    const card = await openCard(page, holder);

    await expect(card.getByTestId('session-card-waiting')).toHaveAttribute('data-waiting', 'true');
    await expect(card.getByTestId('session-card-waiting')).toHaveText('Waiting for you');
    await expect(card.locator('[data-chip]'), 'chip and line use one phrase').toHaveText('Waiting for you');
    await expect(card.getByTestId('session-card-waiting'), 'the old phrase is gone').not.toContainText('on Dave');
    await expect(card).toHaveClass(BORDER_WARN);
    await expect(page.locator(`[data-testid="ready-item"][data-session-id="${holder.sessionId}"]`)).toHaveCount(1);
    await expectWaitingMatchesStrip(page);
  });

  test('W3 an open ask with no chip still waits (the ask is the rule, not the chip)', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { chip: 'working', brief: makeBrief({ ask: [ask('E2E ask, chip says working')] }) });
    const card = await openCard(page, holder);

    await expect(card.getByTestId('session-card-waiting')).toHaveAttribute('data-waiting', 'true');
    await expectWaitingMatchesStrip(page);
  });
});

test.describe('F2 the line for a card that does not wait', () => {
  test('W4 a working card with no open ask says "Not waiting for you"', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { chip: 'working', brief: makeBrief({ title: 'E2E not waiting', ask: [] }) });
    const card = await openCard(page, holder);

    await expect(card.getByTestId('session-card-waiting')).toHaveText('Not waiting for you');
    await expect(card.getByTestId('session-card-waiting')).toHaveAttribute('data-waiting', 'false');
  });
});

test.describe('F1 goal source', () => {
  test('G1 a parsed goal loses to the held lane: the newest claim, tagged [lane]', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      brief: makeBrief({ goal: 'E2E parsed narration, not the real work', sources: { goal: 'parsed' } }),
    });
    const card = await openCard(page, holder);
    const goal = card.getByTestId('session-card-goal');

    await expect(goal).toHaveAttribute('data-goal-source', 'lane');
    await expect(goal).toHaveText(expectedLaneGoal(holder.lanes) ?? '');
    await expect(card.getByTestId('session-card-goal-tag')).toHaveText('[lane]');
  });

  test('G2 no brief: the goal is the lane title with data-goal-source="lane"', async ({ page }) => {
    const holder = await findLaneHolderSession();
    const card = await openCard(page, holder);
    const goal = card.getByTestId('session-card-goal');

    await expect(goal).toHaveAttribute('data-goal-source', 'lane');
    await expect(goal).toHaveText(expectedLaneGoal(holder.lanes) ?? '');
  });

  test('G3 a brief_set goal beats the lane and has no [lane] tag', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      brief: makeBrief({ goal: 'E2E goal set with brief_set', sources: { goal: 'brief_set' } }),
    });
    const card = await openCard(page, holder);
    const goal = card.getByTestId('session-card-goal');

    await expect(goal).toHaveAttribute('data-goal-source', 'brief_set');
    await expect(goal).toHaveText('E2E goal set with brief_set');
    await expect(card.getByTestId('session-card-goal-tag')).toHaveCount(0);
  });

  test('G4 a goal with no recorded source is read as parsed, so the lane still wins', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { brief: makeBrief({ goal: 'E2E goal without a source', sources: {} }) });
    const card = await openCard(page, holder);

    await expect(card.getByTestId('session-card-goal')).toHaveAttribute('data-goal-source', 'lane');
  });

  test('G5 the card shows the fixed labels GOAL, PLAN and ANSWERED, and the ASK count', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { brief: makeBrief({ title: 'E2E labels' }) });
    const card = await openCard(page, holder);

    await expect(card.getByTestId('session-card-label-goal')).toHaveText('GOAL');
    await expect(card.getByTestId('session-card-label-plan')).toHaveText('PLAN');
    await expect(card.getByTestId('session-card-label-answered')).toHaveText('ANSWERED');
    await expect(card.getByTestId('session-card-answered')).toHaveText('nothing recorded');
    await expect(card).toContainText('ASK 0');
  });
});

/**
 * ANSWERED (design section 6, Dave's Q5 "always show the last one"). Line 1 is the last brief decision by `at`
 * (text, who, age), else "no decision recorded". Line 2 is "N cleared": asks with `answered: true`, no age
 * (`answeredAt` is not in the file yet), "0 cleared" when none. "nothing recorded" only when both are empty.
 */
test.describe('F1 ANSWERED row', () => {
  const MIN = 60_000;

  test('A1 a decision only: the newest decision by `at` with who and age, and "0 cleared"', async ({ page }) => {
    const holder = await findLaneHolderSession();
    const now = Date.now();
    writeState(holder.sessionId, {
      brief: makeBrief({
        decisions: [
          { text: 'E2E newest scope call', by: 'Dave', at: now - 40 * MIN },
          { text: 'E2E older call', by: 'agent', at: now - 300 * MIN },
        ],
      }),
    });
    const answered = (await openCard(page, holder)).getByTestId('session-card-answered');

    await expect(answered.getByTestId('session-card-answered-decision')).toHaveText(
      /^E2E newest scope call · by Dave, (39|40|41)m ago$/,
    );
    await expect(answered.getByTestId('session-card-answered-cleared')).toHaveText('0 cleared');
    await expect(answered).not.toContainText('nothing recorded');
    await expect(answered).not.toContainText('E2E older call');
  });

  test('A2 answered asks only: "N cleared" with no age, and "no decision recorded"', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      brief: makeBrief({
        ask: [
          ask('E2E cleared one', undefined, { answered: true }),
          ask('E2E cleared two', undefined, { answered: true }),
          ask('E2E still open'),
        ],
      }),
    });
    const answered = (await openCard(page, holder)).getByTestId('session-card-answered');

    await expect(answered.getByTestId('session-card-answered-cleared')).toHaveText('2 cleared');
    await expect(answered.getByTestId('session-card-answered-decision')).toHaveText('no decision recorded');
    await expect(answered).not.toContainText('nothing recorded');
    await expect(answered, 'a cleared ask has no age: answeredAt does not exist yet').not.toContainText(/ago|just now/);
  });

  test('A3 both: the decision line, then the cleared line', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, {
      brief: makeBrief({
        decisions: [{ text: 'E2E pick B', by: 'Dave', at: Date.now() - 2 * MIN }],
        ask: [ask('E2E cleared', undefined, { answered: true })],
      }),
    });
    const answered = (await openCard(page, holder)).getByTestId('session-card-answered');

    await expect(answered.getByTestId('session-card-answered-decision')).toHaveText(/^E2E pick B · by Dave, (2|3)m ago$/);
    await expect(answered.getByTestId('session-card-answered-cleared')).toHaveText('1 cleared');
    await expect(answered).not.toContainText('nothing recorded');
  });

  test('A4 neither: "nothing recorded", and an open ask alone does not count as cleared', async ({ page }) => {
    const holder = await findLaneHolderSession();
    writeState(holder.sessionId, { brief: makeBrief({ ask: [ask('E2E only open')] }) });
    const answered = (await openCard(page, holder)).getByTestId('session-card-answered');

    await expect(answered).toHaveText('nothing recorded');
    await expect(answered.getByTestId('session-card-answered-cleared')).toHaveCount(0);
  });
});
