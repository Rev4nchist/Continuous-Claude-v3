// The mod tests cannot read scripts/github/fixtures/slot-queue/tick-*.json: the plugin test runner loads only code files from inside the plugin
// folder. The mod keeps each fixture's text as a string in tests/fixtures/slot-queue-ticks.ts. This test fails when a copy differs from its
// fixture, so the CLI (slot-queue.test.mjs O1) and the mod parser (slot.test.ts P1) are still tested against one contract.
// Breaks when: a tick-*.json fixture changes and the string in the mod's copy does not, or a fixture has no copy.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('./fixtures/slot-queue/', import.meta.url));
const COPY = fileURLToPath(new URL('../../.claude/plugins/ccv3-mods/tests/fixtures/slot-queue-ticks.ts', import.meta.url));
const lf = (text) => text.replace(/\r\n/g, '\n').trim();

const fixtureNames = () => readdirSync(FIXTURES).filter((f) => /^tick-.+\.json$/.test(f)).map((f) => f.slice(5, -5));

test('every tick fixture has a copy in the mod test fixtures, byte for byte', () => {
  const copy = lf(readFileSync(COPY, 'utf8'));
  const names = fixtureNames();
  assert.ok(names.length >= 4, `expected at least 4 tick fixtures, found ${names.length}`);
  for (const name of names) {
    const text = lf(readFileSync(`${FIXTURES}tick-${name}.json`, 'utf8'));
    assert.ok(copy.includes(`  ${name}: \`${text}\`,`), `tests/fixtures/slot-queue-ticks.ts has no exact copy of tick-${name}.json`);
  }
});

test('the copy holds no fixture that is gone', () => {
  const copy = readFileSync(COPY, 'utf8');
  const held = [...copy.matchAll(/^ {2}([a-z-]+): `/gm)].map((m) => m[1]);
  assert.deepEqual(held.sort(), fixtureNames().sort());
});
