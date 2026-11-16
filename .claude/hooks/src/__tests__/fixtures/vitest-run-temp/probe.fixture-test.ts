// Fixture test for vitest-run-temp.test.ts. It leaves a folder in tmpdir() on purpose and waits FX_WAIT_MS.
// The name ends in -test.ts, not .test.ts, so the main hooks run never includes it.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('leaves a folder in tmpdir() and waits', async () => {
  // FX_START_DELAY_MS forces a late boot: the run folder exists, the test folder does not yet.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FX_START_DELAY_MS ?? 0)));
  if (process.env.FX_FAIL) throw new Error('FX deliberate failure');
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  writeFileSync(join(dir, 'f.txt'), 'x');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FX_WAIT_MS ?? 0)));
  // FX_RELEASE_FILE: wait for the parent test to create this file (no fixed sleep), 55 s at most.
  const release = process.env.FX_RELEASE_FILE;
  for (let i = 0; release && !existsSync(release) && i < 550; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(dir.length).toBeGreaterThan(0);
});
