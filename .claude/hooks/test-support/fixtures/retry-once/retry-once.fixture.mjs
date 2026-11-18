// Fixture of the flake-ledger E2E (card coord-flake-ledger). Run only by src/__tests__/flake-ledger.test.ts with --retry=2.
// ZEBRAQUOKKA is a marker word: the test checks that no printed FLAKE LEDGER line and no job summary holds a test name.
import { expect, test } from 'vitest';

let tries = 0;

test('ZEBRAQUOKKA passes on try 2', () => {
  tries += 1;
  if (!process.env.FIXTURE_NO_FLAKE) expect(tries).toBeGreaterThan(1);
});

// A test that declares its own retry and fails its first try on purpose (as CHR and RTR of decision-gate-app-repos-*.test.ts do):
// its retry is the author's choice, not the gate's --retry, so the ledger must not record it.
let ownTries = 0;
test('declares its own retry', { retry: 1 }, () => {
  ownTries += 1;
  expect(ownTries).toBeGreaterThan(1);
});

test('passes at once', () => {
  expect(1).toBe(1);
});

test.skip('is skipped', () => {});

test.runIf(process.env.FIXTURE_FAIL)('fails on every try', () => {
  expect(1).toBe(2);
});
