// The .catch gate must never pass because the report lost its gatingHooks list.
// One test per way the gate can pass for the wrong reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatingProblems, parseArgs } from './validate-mods.mjs';

const DEFAULT = '/repo/default-plugin';

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

// The argument bug: with no --min-gating, argument 0 (the folder) was skipped and the gate checked the default folder.
test('a folder named with no --min-gating is the folder checked, not the default', () => {
  const { pluginDir, minGating } = parseArgs(['/tmp/other-plugin'], DEFAULT);
  assert.match(pluginDir.replace(/\\/g, '/'), /\/tmp\/other-plugin$/);
  assert.equal(minGating, 1);
});

test('a folder named after --min-gating, or before it, is still found; the number is not taken for the folder', () => {
  for (const args of [['--min-gating', '5', '/tmp/other-plugin'], ['/tmp/other-plugin', '--min-gating', '5']]) {
    const { pluginDir, minGating } = parseArgs(args, DEFAULT);
    assert.match(pluginDir.replace(/\\/g, '/'), /\/tmp\/other-plugin$/);
    assert.equal(minGating, 5);
  }
});

test('no folder named gives the default; a lone --min-gating value is not a folder', () => {
  assert.match(parseArgs([], DEFAULT).pluginDir.replace(/\\/g, '/'), /\/repo\/default-plugin$/);
  const { pluginDir, minGating } = parseArgs(['--min-gating', '3'], DEFAULT);
  assert.match(pluginDir.replace(/\\/g, '/'), /\/repo\/default-plugin$/);
  assert.equal(minGating, 3);
});
