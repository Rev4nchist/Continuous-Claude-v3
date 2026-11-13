// answer-paths.mjs is bundled into a hook, where process.argv[1] is the bundle. A top-level main() or an isDirectRun check in the
// module would then run inside the hook. These tests load the module in a child process whose argv[1] is the module itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANSWER_KEY_GLOBS, answerKeyCheck, globToRegExp, matchGlob } from './answer-paths.mjs';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'answer-paths.mjs');
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });

test('running the module as the entry script prints nothing and exits 0 (no main, no side effect)', () => {
  const r = node([MODULE]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('an import with argv[1] set to the module path has no output and exposes the six names', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'answer-paths-'));
  try {
    const probe = path.join(dir, 'probe.mjs');
    writeFileSync(probe, [
      `process.argv[1] = ${JSON.stringify(MODULE)};`,
      `const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});`,
      'process.stdout.write(JSON.stringify(Object.keys(m).sort()));',
    ].join('\n'));
    const r = node([probe]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), ['ANSWER_KEY_GLOBS', 'answerKeyCheck', 'answerKeyGlobs', 'globToRegExp', 'matchGlob', 'slashLower']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the frozen list is the four answer-key globs', () => {
  assert.ok(Object.isFrozen(ANSWER_KEY_GLOBS));
  assert.deepEqual([...ANSWER_KEY_GLOBS], [
    'scripts/eval/review-eval/gold/**',
    'scripts/eval/review-eval/seeds/**',
    'scripts/eval/review-eval/rubrics/**',
    'scripts/eval/review-eval/linktype-labels.json',
  ]);
});

test('the old importers get the same functions through their re-exports', async () => {
  const router = await import('../review-router.mjs');
  const prePr = await import('../pre-pr.mjs');
  assert.equal(router.globToRegExp, globToRegExp);
  assert.equal(router.matchGlob, matchGlob);
  assert.equal(prePr.ANSWER_KEY_GLOBS, ANSWER_KEY_GLOBS);
  assert.equal(prePr.answerKeyCheck, answerKeyCheck);
});
