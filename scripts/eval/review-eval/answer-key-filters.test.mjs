// The review bots never get an answer-key file: every answer-key entry of TREE_EXCLUDES is a skip path of
// CodeRabbit (.coderabbit.yaml reviews.path_filters), Greptile (.greptile/config.json ignorePatterns) and REVIEW.md.
// Failure modes, one test each:
// F1 breaks when an answer-key path of TREE_EXCLUDES is missing from the CodeRabbit path_filters block
//    (a line in a comment or under another key does not count: the ratchet's own parser reads the block).
// F2 breaks when it is missing from the Greptile ignorePatterns.
// F3 breaks when it is missing from the REVIEW.md "Skip paths" block.
// F4 breaks when TREE_EXCLUDES loses its answer-key entries, so F1 to F3 would pass on an empty list (vacuous gate).
// All paths are the repo's own config; no answer-key file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TREE_EXCLUDES } from '../../github/cursor-review.mjs';
import { parseCodeRabbit, parseGreptile, parseReviewMd } from '../../ratchets/review-skip-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const ANSWER_PREFIX = 'scripts/eval/review-eval/';

/** The answer-key entries of TREE_EXCLUDES as skip globs: a file stays as it is, a folder gets "/**". */
export function answerKeyGlobs(excludes = TREE_EXCLUDES) {
  return excludes.filter((x) => x.startsWith(ANSWER_PREFIX)).map((x) => (/\.[a-z0-9]+$/i.test(x) ? x : `${x}/**`));
}

function assertCovers(globs, where) {
  const missing = answerKeyGlobs().filter((g) => !globs.includes(g));
  assert.deepEqual(missing, [], `${where} misses answer-key skip path(s): ${missing.join(', ')}`);
}

test('F4 TREE_EXCLUDES holds the four answer-key entries', () => {
  assert.deepEqual(answerKeyGlobs(), [
    'scripts/eval/review-eval/gold/**', 'scripts/eval/review-eval/seeds/**',
    'scripts/eval/review-eval/rubrics/**', 'scripts/eval/review-eval/linktype-labels.json',
  ]);
});

test('F1 every answer-key path is a CodeRabbit path_filters skip', () => {
  assertCovers(parseCodeRabbit(read('.coderabbit.yaml')).skip, '.coderabbit.yaml reviews.path_filters');
});

test('F1 a glob only in a comment or under another key does not count', () => {
  const yaml = ['reviews:', '  path_filters:', '    - "!docs/**"', '    # - "!scripts/eval/review-eval/gold/**"',
    '  other:', '    - "!scripts/eval/review-eval/gold/**"', ''].join('\n');
  const { skip } = parseCodeRabbit(yaml);
  assert.deepEqual(skip, ['docs/**']);
});

test('F2 every answer-key path is a Greptile ignorePatterns entry', () => {
  assertCovers(parseGreptile(read('.greptile/config.json')), '.greptile/config.json ignorePatterns');
});

test('F3 every answer-key path is in the REVIEW.md Skip paths block', () => {
  assertCovers(parseReviewMd(read('REVIEW.md')), 'REVIEW.md "Skip paths"');
});
