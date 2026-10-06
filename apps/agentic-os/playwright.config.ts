import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

/**
 * READ-ONLY smoke check for Agentic OS. See e2e/smoke.spec.ts.
 *
 * It starts its OWN dev server on 127.0.0.1:3011 and never reuses one. A server a
 * stranger left on that port could be another build, another database or another
 * branch, and a green run against it would prove nothing. If the port is busy,
 * Playwright refuses to start and says so. Free the port and run again.
 *
 * The dashboard itself runs on 3010. This check uses 3011 and its own build
 * directory (.next-e2e), so it runs while the dashboard is open.
 *
 * @playwright/test comes from the repo root package.json, not from this app. Run
 * `npm ci` at the repo root before `npm run e2e`.
 *
 * The app needs AGENTIC_OS_DATABASE_URL (the SELECT-only agentic_os_app role). Next
 * reads it from apps/agentic-os/.env.local, or from the environment. Fail here with a
 * clear message instead of page failures that all say "500".
 */
const appDir = dirname(fileURLToPath(import.meta.url));

if (!process.env.AGENTIC_OS_DATABASE_URL && !existsSync(join(appDir, '.env.local'))) {
  throw new Error(
    'AGENTIC_OS_DATABASE_URL is not set and apps/agentic-os/.env.local does not exist.\n' +
      'Create .env.local (see scripts/seed-projects.mjs and drizzle.config.ts for the roles) ' +
      'or export the variable. The e2e check needs the SELECT-only agentic_os_app URL.',
  );
}

const PORT = 3011;
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  // One worker: one dashboard, one shared database, and a dev server that compiles
  // each route on first hit.
  workers: 1,
  fullyParallel: false,
  // A stray test.only would turn this gate into "1 passed". Always forbid it.
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-report.json' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx next dev --port ${PORT} --hostname 127.0.0.1`,
    env: { AGENTIC_OS_DIST_DIR: '.next-e2e' },
    url: `${ORIGIN}/icon.svg`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
