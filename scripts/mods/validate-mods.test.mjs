// The .catch gate must never pass because the report lost its gatingHooks list.
// One test per way the gate can pass for the wrong reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatingProblems, parseArgs, refusedCommandProblems, TEST_LIMIT_MS, testShort } from './validate-mods.mjs';

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

// A command name Claude Code ships is refused live and its hook is skipped, yet the test kit accepts any name (PR C review, /checkpoint).
// validate reports it as a warning, which the gate used to ignore.
const shipped = name => ({ path: 'modules../register.tsx', message: `"/${name}" is a name Claude Code ships: $.command.register refuses it and the hook that calls it is skipped`, code: null });

test('a refused command name in the hooks warnings fails the gate and names the command', () => {
  const problems = refusedCommandProblems({ contents: [{ file: 'hooks.json', warnings: [shipped('checkpoint')] }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"\/checkpoint" is a name Claude Code ships/);
});

test('a refused name in the manifest warnings fails too; unrelated warnings and a clean report pass', () => {
  assert.equal(refusedCommandProblems({ manifest: { warnings: [shipped('plan')] }, contents: [] }).length, 1);
  assert.deepEqual(refusedCommandProblems({ manifest: { warnings: [] }, contents: [{ warnings: [{ message: 'some other warning' }] }, {}] }), []);
  assert.deepEqual(refusedCommandProblems({}), []);
});

test('a test step the limit stopped says "stopped at N s", not NaN counts; the limit sits under the 10 minutes of pre-pr', () => {
  assert.equal(testShort({ status: null, error: { code: 'ETIMEDOUT' } }, TEST_LIMIT_MS, NaN, NaN), 'test stopped at 540 s');
  assert.equal(testShort({ status: 0 }, TEST_LIMIT_MS, 2299, 0), 'test 2299 pass 0 fail');
  assert.ok(TEST_LIMIT_MS < 10 * 60_000 && TEST_LIMIT_MS > 280_000);
});
