import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Where the E2E server reads session state files (AGENTIC_OS_STATE_DIR). A temp dir, never
 * the real ~/.claude/state/agentic-os, so fixture files cannot mix with a live session's
 * snapshot. e2e/state-fixture.ts imports this constant, so the server and the specs
 * share one path. The specs empty the directory before and after every test.
 */
export const E2E_STATE_DIR = join(tmpdir(), 'agentic-os-e2e-state');
mkdirSync(E2E_STATE_DIR, { recursive: true });

/**
 * Where the E2E server reads session identity files (AGENTIC_OS_IDENTITY_DIR), one
 * `<sessionId>.json` per session, written by the hooks to ~/.claude/state/identity. A temp dir for
 * the same reason as E2E_STATE_DIR. e2e/state-fixture.ts imports this constant.
 */
export const E2E_IDENTITY_DIR = join(tmpdir(), 'agentic-os-e2e-identity');
mkdirSync(E2E_IDENTITY_DIR, { recursive: true });

/**
 * Where the E2E server reads the spend rollup (AGENTIC_OS_SPEND_DIR), one `<CDT day>.json` per day, written by
 * the later W4 task to ~/.claude/state/spend. A temp dir for the same reason as E2E_STATE_DIR.
 * e2e/state-fixture.ts imports this constant.
 */
export const E2E_SPEND_DIR = join(tmpdir(), 'agentic-os-e2e-spend');
mkdirSync(E2E_SPEND_DIR, { recursive: true });

/**
 * Where the E2E server reads the lane-dashboard export (AGENTIC_OS_LANE_DASH_DIR): flow.json and factory.json,
 * written by the lane-dashboard lane to ~/.claude/state/lane-dash. A temp dir for the same reason as E2E_STATE_DIR:
 * a test never reads or writes the real export. e2e/state-fixture.ts imports this constant.
 */
export const E2E_LANE_DASH_DIR = join(tmpdir(), 'agentic-os-e2e-lane-dash');
mkdirSync(E2E_LANE_DASH_DIR, { recursive: true });

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
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Phone width on the same engine. The mockup targets a phone-width Pane too.
    {
      name: 'phone',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `npx next dev --port ${PORT} --hostname 127.0.0.1`,
    env: {
      AGENTIC_OS_DIST_DIR: '.next-e2e',
      AGENTIC_OS_STATE_DIR: E2E_STATE_DIR,
      AGENTIC_OS_IDENTITY_DIR: E2E_IDENTITY_DIR,
      AGENTIC_OS_SPEND_DIR: E2E_SPEND_DIR,
      AGENTIC_OS_LANE_DASH_DIR: E2E_LANE_DASH_DIR,
    },
    url: `${ORIGIN}/icon.svg`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
