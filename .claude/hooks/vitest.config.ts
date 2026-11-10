import { defineConfig } from 'vitest/config';
import { tmpdir } from 'os';
import { join } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Keep test runs out of the live ~/.claude/logs/hooks.log (see shared/logger.ts).
    // CCV3_HOOK_TRACE=0 keeps a spawned built hook (dist-spawn tests) from writing trace rows
    // to the live ~/.claude/cache (src/lib/trace-boot.ts). A test that wants rows sets it itself.
    env: {
      CLAUDE_HOOK_LOG_FILE: join(tmpdir(), 'ccv3-hooks.test.log'),
      CCV3_HOOK_TRACE: '0',
    },
  },
});
