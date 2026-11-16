// temp-tracker.mjs lets a test file remove the temp folders it made, and only those (lane temp-folder-leak-hunt, Fix B).
// Ways it can fail, one test each:
//   1. a made folder is not removed (the path is not recorded, or the cleanup never runs)
//   2. a folder it did not make is removed (prefix sweep, or a sweep of the whole temp dir)
//   3. a junction inside a made folder is followed and the target's files are deleted
//   4. one remove error stops the run or throws (a leak is better than a failed test)
//   5. the list is not cleared, so a second call removes a new folder at a recorded path
//   6. registerTempCleanup() registers nothing, so the file ends with the folders still there
//   7. makeTempDir() ignores its prefix or base
// Every test uses its own scratch base folder, never the real temp dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir, removeTempDirs } from './temp-tracker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'temp-tracker.mjs');

// This file's own scratch folders. Only these are removed at the end, never a prefix match.
const scratches = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'temp-tracker-test-'));
  scratches.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratches.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a leak is better than a failed test */ }
  }
});

test('makeTempDir makes a folder under the base with the prefix, and removeTempDirs removes it with its content', () => {
  // Breaks if makeTempDir ignores prefix or base (7), or does not record the path (1).
  const base = scratch();
  const dir = makeTempDir('tt-made-', base);
  assert.equal(dirname(dir), base);
  assert.ok(basename(dir).startsWith('tt-made-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'f.txt'), 'x');
  assert.equal(existsSync(dir), true);
  removeTempDirs();
  assert.equal(existsSync(dir), false);
});

test('removeTempDirs leaves a folder it did not make, even with the same prefix', () => {
  // Breaks if the cleanup becomes a prefix sweep or a sweep of the whole base (2).
  const base = scratch();
  const foreign = join(base, 'tt-same-prefix-not-made-by-us');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'keep');
  const other = mkdtempSync(join(base, 'tt-same-prefix-'));
  const mine = makeTempDir('tt-same-prefix-', base);
  removeTempDirs();
  assert.equal(existsSync(mine), false);
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(other), true);
});

test('a junction inside a made folder is unlinked and its target keeps its files', () => {
  // Breaks if the cleanup follows the link and deletes the target's content (3).
  const base = scratch();
  const target = join(base, 'tt-link-target');
  mkdirSync(join(target, 'deep'), { recursive: true });
  writeFileSync(join(target, 'deep', 'keep.txt'), 'keep');
  const dir = makeTempDir('tt-link-', base);
  mkdirSync(join(dir, 'nested'));
  const link = join(dir, 'nested', 'store');
  symlinkSync(target, link, 'junction');
  // The link must be gone before the recursive remove starts. The spy records it; the assert runs after the call,
  // because the helper drops an error thrown inside the spy.
  let linkGoneBeforeRm;
  const rm = (d, opts) => {
    linkGoneBeforeRm = lstatSync(link, { throwIfNoEntry: false }) === undefined;
    rmSync(d, opts);
  };
  removeTempDirs({ rm });
  assert.equal(linkGoneBeforeRm, true);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(join(target, 'deep', 'keep.txt'), 'utf8'), 'keep');
});

test('a remove error does not throw and does not stop the next folder', () => {
  // Breaks if the try/catch around the remove is dropped, or one error ends the loop (4).
  const base = scratch();
  const first = makeTempDir('tt-err-', base);
  const second = makeTempDir('tt-err-', base);
  const tried = [];
  const rm = (dir, opts) => {
    tried.push(dir);
    if (dir === first) throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' });
    rmSync(dir, opts);
  };
  assert.doesNotThrow(() => removeTempDirs({ rm }));
  assert.deepEqual(tried, [first, second]);
  assert.equal(existsSync(first), true); // the leak is accepted
  assert.equal(existsSync(second), false);
  removeTempDirs(); // the failed folder was dropped from the list: a later call has nothing to do
  assert.equal(existsSync(first), true);
  rmSync(first, { recursive: true, force: true });
});

test('a second removeTempDirs is safe and does not touch a new folder at a recorded path', () => {
  // Breaks if the list is not cleared after a remove (5).
  const base = scratch();
  const dir = makeTempDir('tt-twice-', base);
  removeTempDirs();
  assert.equal(existsSync(dir), false);
  mkdirSync(dir); // not made by makeTempDir: the helper must leave it
  writeFileSync(join(dir, 'keep.txt'), 'keep');
  assert.doesNotThrow(() => removeTempDirs());
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'keep');
});

test('a missing folder does not throw', () => {
  // Breaks if the cleanup stats or reads the folder without a guard (4).
  const base = scratch();
  const dir = makeTempDir('tt-gone-', base);
  rmSync(dir, { recursive: true });
  assert.doesNotThrow(() => removeTempDirs());
});

test('registerTempCleanup removes the folders a test file made when that file ends, and only those', () => {
  // Breaks if registerTempCleanup registers no after() hook (6), or the hook sweeps by prefix (2).
  const temp = scratch();
  const foreign = join(temp, 'tt-reg-foreign-not-made');
  mkdirSync(foreign);
  const fixtureDir = scratch();
  const fixture = join(fixtureDir, 'fixture.test.mjs');
  writeFileSync(fixture, [
    "import { test } from 'node:test';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `import { makeTempDir, registerTempCleanup } from ${JSON.stringify(pathToFileURL(HELPER).href)};`,
    'registerTempCleanup();',
    "test('makes two folders', () => {",
    "  writeFileSync(join(makeTempDir('tt-reg-'), 'f.txt'), 'x');",
    "  makeTempDir('tt-reg-');",
    '});',
    '',
  ].join('\n'));
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.NODE_TEST_CONTEXT; // else the child runs as a subtest of this run and prints no summary
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.match(r.stdout, /^# pass 1/m, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# fail 0/m, r.stdout);
  assert.deepEqual(readdirSync(temp).sort(), [basename(foreign)]);
});
