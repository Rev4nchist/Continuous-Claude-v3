import { defineConfig } from 'vitest/config';
import { tmpdir } from 'os';
import { join } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // C2c: every decision of a PowerShell text now starts a pwsh walker child (0.5 to 1 s alone, several seconds on a loaded 2 CPU runner with the suite in parallel). The default of
    // 5 s per test turned that load into failures on the Linux runner. A hung test still ends at 60 s.
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // One run-owned temp folder for the whole run, removed at the end (src/__tests__/vitest-global-temp.ts).
    globalSetup: ['./src/__tests__/vitest-global-temp.ts'],
    // Keep test runs out of the live ~/.claude/logs/hooks.log (see shared/logger.ts).
    // CCV3_HOOK_TRACE=0 keeps a spawned built hook (dist-spawn tests) from writing trace rows
    // to the live ~/.claude/cache (src/lib/trace-boot.ts). A test that wants rows sets it itself.
    env: {
      CLAUDE_HOOK_LOG_FILE: join(tmpdir(), 'ccv3-hooks.test.log'),
      CCV3_HOOK_TRACE: '0',
      // The pwsh walker is a child process per parse. On a loaded runner (a Linux box with 2 CPUs and the whole suite in parallel) it passes its 6 s timeout, the guard
      // fails closed, and a test that expects an allow fails. Tests wait longer so that a slow child is not a verdict. A test of the fail-closed path uses a provider that errors.
      CCV3_PARSE_TIMEOUT_MS: '30000',
      CCV3_PARSE_BUDGET_MS: '60000',
    },
  },
});
