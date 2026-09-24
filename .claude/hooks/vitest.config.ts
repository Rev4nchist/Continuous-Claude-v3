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
    env: {
      CLAUDE_HOOK_LOG_FILE: join(tmpdir(), 'ccv3-hooks.test.log'),
    },
  },
});
