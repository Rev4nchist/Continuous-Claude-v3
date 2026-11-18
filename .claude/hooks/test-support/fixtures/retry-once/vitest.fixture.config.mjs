// Config of the flake-ledger fixture project (card coord-flake-ledger). Only src/__tests__/flake-ledger.test.ts runs it, as a child vitest.
// The include names *.fixture.mjs, so neither the hooks suite (src/__tests__/**/*.test.ts) nor gate-coverage (*.test.*) picks the file up.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.fixture.mjs'],
    environment: 'node',
  },
});
