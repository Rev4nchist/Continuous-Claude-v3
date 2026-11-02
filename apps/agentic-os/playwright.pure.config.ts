import { defineConfig } from '@playwright/test';

/**
 * Pure-Node Playwright config for specs that call plain functions: no dev server, no database, no browser.
 *
 * playwright.config.ts starts `next dev` and throws when AGENTIC_OS_DATABASE_URL is missing, so CI and the
 * pre-PR run cannot use it for specs that need neither. This config runs only the safe-message specs:
 *   npx playwright test --config apps/agentic-os/playwright.pure.config.ts
 *
 * A spec that needs a page or the database does not belong here: its name must not start with
 * `safe-message`. @playwright/test comes from the repo root package.json: run `npm ci` at the root first.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['safe-message*.spec.ts'],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  // A stray test.only would turn this gate into "1 passed". Always forbid it.
  forbidOnly: true,
  reporter: [['list']],
});
