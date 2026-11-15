// Tests for lib/answer-key.mjs (card prflow-push-blocks). Run: node --test scripts/github/lib/answer-key.test.mjs
//
// How the unit can fail, and the test that catches it:
//   the lib matcher and the matchGlob of review-router.mjs disagree on a path (the guard and the push gate judge differently) -> K1
//   the lib has an import, an entry guard or a file read (esbuild would bundle it into a hook)                               -> K2
//   pre-pr.mjs keeps its own copy of the list                                                                               -> K3
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ANSWER_KEY_GLOBS as PRE_PR_GLOBS } from '../pre-pr.mjs';
import { matchGlob } from '../review-router.mjs';
import { ANSWER_KEY_GLOBS, answerKeyHitsOf, slashLower } from './answer-key.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = [
  'scripts/eval/review-eval/gold/a.json', 'scripts/eval/review-eval/gold/sub/b.json', 'scripts/eval/review-eval/gold',
  'scripts/eval/review-eval/gold/', 'Scripts\\Eval\\Review-Eval\\Gold\\a.json', './scripts/eval/review-eval/seeds/x', 'scripts/eval/review-eval/seeds',
  'scripts/eval/review-eval/rubrics/r1.md', 'scripts/eval/review-eval/rubrics-extra/r1.md', 'scripts/eval/review-eval/linktype-labels.json',
  'scripts/eval/review-eval/linktype-labels.json.bak', 'scripts/eval/review-eval/cli.mjs', 'src/gold/a.json', 'README.md', '',
];

test('K1: the lib matcher equals the review-router matchGlob for sample paths (both sides normalised)', () => {
  // Breaks when: the two matchers disagree on a folder glob, a bare folder name, a case or slash spelling, or a near-name.
  for (const p of SAMPLES) {
    const viaRouter = ANSWER_KEY_GLOBS.some((g) => matchGlob(slashLower(g), slashLower(p)));
    assert.equal(answerKeyHitsOf([p]).length === 1, viaRouter, JSON.stringify(p));
  }
  assert.deepEqual(answerKeyHitsOf(['Scripts\\Eval\\Review-Eval\\Gold\\a.json', 'README.md']), ['Scripts\\Eval\\Review-Eval\\Gold\\a.json'], 'the original spelling is kept');
});

test('K2: the lib has no import, no entry code, no file or process access (it is bundled into a hook)', () => {
  // Breaks when: someone adds an import or a read to the lib.
  const text = readFileSync(path.join(HERE, 'answer-key.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of [/^\s*import\s/m, /process\./, /import\.meta/, /readFileSync|writeFileSync|fs\./, /require\(/]) assert.equal(bad.test(text), false, String(bad));
});

test('K3: pre-pr.mjs exports the same list object as the lib', () => {
  // Breaks when: pre-pr.mjs defines its own list again.
  assert.equal(PRE_PR_GLOBS, ANSWER_KEY_GLOBS);
});
