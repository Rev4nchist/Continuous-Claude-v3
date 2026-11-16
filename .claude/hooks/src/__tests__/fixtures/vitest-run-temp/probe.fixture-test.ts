// Fixture test for vitest-run-temp.test.ts. It leaves a folder in tmpdir() on purpose and waits FX_WAIT_MS.
// The name ends in -test.ts, not .test.ts, so the main hooks run never includes it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('leaves a folder in tmpdir() and waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  writeFileSync(join(dir, 'f.txt'), 'x');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FX_WAIT_MS ?? 0)));
  expect(dir.length).toBeGreaterThan(0);
});
