// The .catch gate must never pass because the report lost its gatingHooks list.
// One test per way the gate can pass for the wrong reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatingProblems } from './validate-mods.mjs';

const hook = (extra = {}) => ({ module: 'hooks/x', hook: 'tool.call', hasCatch: true, ...extra });

test('a report with no gatingHooks key fails, it does not count as zero hooks', () => {
  const problems = gatingProblems({ success: true, manifest: {}, contents: [] }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no gatingHooks/);
});

test('an empty gatingHooks list fails below the minimum and prints the count', () => {
  const problems = gatingProblems({ manifest: { gatingHooks: [] } }, 1);
  assert.match(problems.join('\n'), /found 0 gating hooks, expected at least 1/);
});

test('a list under the minimum fails', () => {
  assert.equal(gatingProblems({ manifest: { gatingHooks: [hook()] } }, 2).length, 1);
});

test('hooks found in contents count toward the minimum', () => {
  assert.deepEqual(gatingProblems({ manifest: {}, contents: [{ gatingHooks: [hook()] }] }, 1), []);
});

test('a gating hook without .catch fails', () => {
  const problems = gatingProblems({ manifest: { gatingHooks: [hook({ hasCatch: false })] } }, 1);
  assert.match(problems.join('\n'), /without \.catch: hooks\/x tool\.call/);
});

test('one covered gating hook passes', () => {
  assert.deepEqual(gatingProblems({ manifest: { gatingHooks: [hook()] } }, 1), []);
});
