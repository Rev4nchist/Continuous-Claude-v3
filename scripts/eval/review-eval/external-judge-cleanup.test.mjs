// external-judge.test.mjs used to leave every ext-judge-* folder behind: about 15,000 sat in %TEMP%
// (lane temp-folder-leak-hunt). This test runs that file in a child process with its own temp dir
// and checks that no folder is left.
//  C1 a folder of the test file is left after it ends   -> drop the after() cleanup, or make tmp() skip the made list
//  C2 the cleanup removes a folder it did not make      -> a prefix match instead of the made list
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const TARGET = fileURLToPath(new URL('./external-judge.test.mjs', import.meta.url));
const made = [];
after(() => {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a locked folder must not fail a test */
    }
  }
});

// Run the target file with TEMP, TMP and TMPDIR set to a private folder. Return that folder and the child result.
function runTarget(beforeRun) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ext-judge-cleanup-home-'));
  made.push(home);
  if (beforeRun) beforeRun(home);
  const env = { ...process.env, TEMP: home, TMP: home, TMPDIR: home };
  // A child that inherits the runner context would report to this runner instead of printing its own result.
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TARGET], { env, encoding: 'utf8', timeout: 120_000 });
  return { home, child };
}

test('C1 after external-judge.test.mjs ends, no ext-judge-* folder is left in its temp dir', () => {
  // Breaks when: the after() cleanup in external-judge.test.mjs is removed, or tmp() stops recording the folders it makes.
  const { home, child } = runTarget();
  assert.equal(child.status, 0, `child run failed:\n${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /# fail 0/);
  const left = readdirSync(home).filter((n) => n.startsWith('ext-judge-'));
  assert.deepEqual(left, []);
});

test('C2 the cleanup keeps a folder it did not make, even with the same prefix', () => {
  // Breaks when: the cleanup removes by name prefix instead of by the folders the file recorded.
  let foreign;
  const { home, child } = runTarget((h) => {
    foreign = path.join(h, 'ext-judge-foreign');
    mkdirSync(foreign);
  });
  assert.equal(child.status, 0, `child run failed:\n${child.stdout}\n${child.stderr}`);
  assert.equal(existsSync(foreign), true);
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith('ext-judge-') && n !== 'ext-judge-foreign'), []);
});
