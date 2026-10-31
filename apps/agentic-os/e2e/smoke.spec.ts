import { expect, test, type Page } from '@playwright/test';

/**
 * READ-ONLY smoke check for Agentic OS.
 *
 * The app has ONE page (`/`, src/app/(mission-control)/page.tsx) and ONE API route
 * (`/api/mission-control`, src/app/api/mission-control/route.ts). Both call only
 * getMissionControlSnapshot(), which runs three SELECTs through the SELECT-only
 * `agentic_os_app` role. Nothing here clicks, submits or posts: the only request the
 * page makes on its own is a GET poll of the same route every 5 seconds.
 *
 * Every test loads real data from the shared Postgres. A test that needs rows
 * (projects) fails on an empty registry on purpose: that is a broken seed, not a pass.
 */

/** Collect uncaught page errors and console errors. Assert the list is empty at the end. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/**
 * Wait until React has hydrated. The poll hook fires one client fetch right after
 * hydration, and the age button then reads "updated Ns ago". Asserting on the error
 * list before this point could miss a hydration error that lands late.
 */
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Mission Control page (/)', () => {
  test('loads with its heading and no browser errors', async ({ page }) => {
    const errors = watchErrors(page);

    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);

    await expect(page).toHaveTitle('Agentic OS');
    await expect(page.getByRole('heading', { level: 1, name: 'Agentic OS' })).toBeVisible();
    await expect(page.getByText('Database unreachable.')).toHaveCount(0);

    await waitForHydration(page);
    expect(errors).toEqual([]);
  });

  test('fleet grid renders project cards from agentic_os.project', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');

    const projects = page.getByRole('heading', { level: 2, name: /^Projects/ });
    // The header is now "Projects · fleet home" and no longer prints the registry count. An empty
    // registry still fails here: the first project card must render and "No projects in" must be absent.
    await expect(projects).toContainText(/^Projects\s*·\s*fleet home/);

    const cards = page.getByRole('article');
    await expect(cards.first()).toBeVisible();
    await expect(cards.first().getByRole('heading', { level: 3 })).not.toBeEmpty();
    // Last active sits behind the card's closed disclosure.
    await cards.first().locator('summary').click();
    await expect(cards.first().getByText('Last active')).toBeVisible();
    await expect(page.getByText(/^No projects in/)).toHaveCount(0);

    await waitForHydration(page);
    expect(errors).toEqual([]);
  });

  test('session accounting reconciles against public.sessions', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');

    for (const label of ['Attributed', 'Unaccounted', 'Duplicates', 'No project']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Reconciled.')).toBeVisible();
    await expect(page.getByText('These numbers do not add up')).toHaveCount(0);

    await waitForHydration(page);
    expect(errors).toEqual([]);
  });

  test('unmatched and closed session panels and the SELECT-only footer render', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');

    // The old "Active sessions" strip is now two panels: sessions with no project, and the closed list.
    await expect(page.getByRole('heading', { level: 2, name: /^Unmatched sessions/ })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: /^Closed in the last \d+m/ }),
    ).toBeVisible();
    await expect(page.getByText(/Connected as agentic_os_app \(SELECT-only, \d+ms\)\./)).toBeVisible();

    await waitForHydration(page);
    expect(errors).toEqual([]);
  });

  test('the 5 second poll succeeds in the browser', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');

    // The label is "live" until the first client fetch lands, then "updated Ns ago".
    // A failing poll shows "stale ... failed refresh" instead.
    await expect(page.getByRole('button', { name: /updated \d+s ago/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/failed refreshes?/)).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

test.describe('GET /api/mission-control', () => {
  test('returns the snapshot with live database and real rows', async ({ request }) => {
    const response = await request.get('/api/mission-control');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');

    const snapshot = await response.json();
    expect(snapshot.database.ok).toBe(true);
    expect(snapshot.fleet.projects.length).toBeGreaterThan(0);
    expect(snapshot.fleet.reconciles).toBe(true);
    expect(snapshot.fleet.totalSessionRows).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.active.sessions)).toBe(true);
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
