// Fixture config for vitest-run-temp.test.ts: one tiny test file, the real globalSetup of the hooks suite.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ['*.fixture-test.ts'],
    testTimeout: 60_000,
    globalSetup: [join(here, '..', '..', 'vitest-global-temp.ts')],
  },
});
