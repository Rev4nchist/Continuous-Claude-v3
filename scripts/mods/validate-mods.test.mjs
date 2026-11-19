// The .catch gate must never pass because the report lost its gatingHooks list.
// One test per way the gate can pass for the wrong reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gatingProblems, leftMs, makeShard, parseArgs, refusedCommandProblems, shardsOf, shardsVerdict, TEST_LIMIT_MS, testFilesOf } from './validate-mods.mjs';

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

// The test step runs the suite in sequential shards: the engine starts one child for every test file at once, and a full run misses its 5 s test limit
// in a different set of tests each time (29, 51, 2, 1 on 11-18). Ways the step can pass or fail for the wrong reason:
// S1 the file list is not in a fixed order, misses a nested or .tsx test, or lists a helper or a node_modules file
// S2 a cut loses a file, reorders them, or makes a shard over the size
// S3 a shard folder holds a test file of another shard, the node_modules, or lacks a helper or a fixture
// S4 a failing shard hides the next ones, the counts are not summed, a shard with no counts passes, zero tests pass
// S5 the clock is per shard (a 9 minute step could run 45), or a step past its limit does not say "stopped at N s"
const tree = files => {
  const root = mkdtempSync(join(tmpdir(), 'mods-shard-test-'));
  for (const rel of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'x');
  }
  return root;
};

test('S1 the test files under the plugin folder are listed by path in a fixed order, nested and .tsx ones included, helpers and node_modules left out', () => {
  const root = tree(['tests/b.test.ts', 'tests/a.test.tsx', 'tests/sub/c.test.ts', 'tests/helper.ts', 'tests/fixtures/data.json', 'tests/node_modules/x.test.ts', 'hooks/z.test.ts']);
  assert.deepEqual(testFilesOf(root), ['hooks/z.test.ts', 'tests/a.test.tsx', 'tests/b.test.ts', 'tests/sub/c.test.ts']);
  assert.deepEqual(testFilesOf(join(root, 'no-such-folder')), []);
  rmSync(root, { recursive: true, force: true });
});

test('S2 the cut keeps every file in order, shards hold 11 at most: 51 files make 11, 11, 11, 11, 7', () => {
  const files = Array.from({ length: 51 }, (_, i) => `f${String(i).padStart(2, '0')}.test.ts`);
  const shards = shardsOf(files);
  assert.deepEqual(shards.map(s => s.length), [11, 11, 11, 11, 7]);
  assert.deepEqual(shards.flat(), files);
  assert.deepEqual(shardsOf([]), []);
  assert.deepEqual(shardsOf(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
});

test('S3 a shard folder holds its own test files, the helpers, the fixtures and the rest of the plugin, and no node_modules', () => {
  const root = tree(['tests/a.test.ts', 'tests/b.test.ts', 'tests/sub/c.test.ts', 'tests/helper.ts', 'tests/fixtures/data.json', 'tests/node_modules/x.js', 'hooks/h.ts', 'package.json']);
  const shard = makeShard(root, ['tests/b.test.ts', 'tests/sub/c.test.ts']);
  const have = rel => existsSync(join(shard, rel));
  assert.ok(shard.startsWith(tmpdir()) && shard.includes('mods-shard-'));
  assert.deepEqual(['tests/b.test.ts', 'tests/sub/c.test.ts', 'tests/helper.ts', 'tests/fixtures/data.json', 'hooks/h.ts', 'package.json'].filter(have), ['tests/b.test.ts', 'tests/sub/c.test.ts', 'tests/helper.ts', 'tests/fixtures/data.json', 'hooks/h.ts', 'package.json']);
  assert.deepEqual(['tests/a.test.ts', 'tests/node_modules'].filter(have), []);
  rmSync(shard, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('S4 the verdict sums the shards, keeps the failing lines of every shard, and fails on a shard with no counts or on zero tests', () => {
  const one = { status: 1, pass: 10, fail: 1, lines: ['(fail) a > A1 [5001ms]'] };
  const two = { status: 1, pass: 20, fail: 2, lines: ['(fail) b > B1 [5002ms]', '(fail) b > B2 [5003ms]'] };
  const sum = shardsVerdict([one, two], false, TEST_LIMIT_MS);
  assert.deepEqual([sum.ok, sum.short, sum.lines.length], [false, 'test 30 pass 3 fail', 3]);
  assert.equal(shardsVerdict([{ status: 0, pass: 5, fail: 0, lines: [] }, { status: 0, pass: 7, fail: 0, lines: [] }], false, TEST_LIMIT_MS).short, 'test 12 pass 0 fail');
  assert.equal(shardsVerdict([{ status: 0, pass: 5, fail: 0, lines: [] }, { status: 1, pass: NaN, fail: NaN, lines: [] }], false, TEST_LIMIT_MS).ok, false);
  assert.equal(shardsVerdict([], false, TEST_LIMIT_MS).ok, false);
  assert.equal(shardsVerdict([{ status: 0, pass: 5, fail: 0, lines: [] }], false, TEST_LIMIT_MS).ok, true);
});

test('S5 the 9 minute clock runs over all shards; a step past it says "stopped at 540 s", not NaN counts; the limit sits under the 10 minutes of pre-pr', () => {
  assert.equal(leftMs(1_000, 1_000 + 100_000, TEST_LIMIT_MS), TEST_LIMIT_MS - 100_000);
  assert.ok(leftMs(1_000, 1_000 + TEST_LIMIT_MS, TEST_LIMIT_MS) <= 0);
  const stopped = shardsVerdict([{ status: 0, pass: 5, fail: 0, lines: [] }], true, TEST_LIMIT_MS);
  assert.deepEqual([stopped.ok, stopped.short], [false, 'test stopped at 540 s']);
  assert.ok(TEST_LIMIT_MS < 10 * 60_000 && TEST_LIMIT_MS > 280_000);
});
