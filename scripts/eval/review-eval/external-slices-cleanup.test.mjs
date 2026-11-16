// external-slices.test.mjs used to leave every ext-slices-* folder in the OS temp dir (about 15,000 piled up).
// Failure mode: the test file stops removing the folders it made, or removes a folder it did not make.
// The check runs the real test file in a child process with its own temp dir, then lists that dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TARGET = fileURLToPath(new URL('./external-slices.test.mjs', import.meta.url));

test('external-slices.test.mjs removes every temp folder it made and leaves a foreign one', () => {
  // Breaks when: the after() cleanup in external-slices.test.mjs is removed, or tmp() stops recording its folders,
  // or the cleanup removes by prefix instead of by recorded path.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ext-slices-cleanup-scratch-'));
  try {
    const foreign = path.join(scratch, 'ext-slices-foreign');
    mkdirSync(foreign);
    // NODE_TEST_CONTEXT is set inside a node:test child. Left in, the nested run would not execute the file's tests.
    const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', TARGET], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass [1-9]\d*\r?\n/, 'the target tests ran');
    const left = readdirSync(scratch);
    assert.deepEqual(left, ['ext-slices-foreign'], `left in scratch: ${left.length}`);
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A locked scratch folder must not fail the test.
    }
  }
});
