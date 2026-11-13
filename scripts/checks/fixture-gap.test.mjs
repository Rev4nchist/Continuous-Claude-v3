// Tests for scripts/checks/fixture-gap.mjs. A fact for the reviewer, never a gate.
// Run: node --test scripts/checks/fixture-gap.test.mjs
//
// Failure modes and the change that would break each test:
//   G1 a parser or guard source with no registry entry is not listed   -> skip the registry lookup, or drop a word from GAP_PATTERNS
//   G2 a file with a registry entry is listed anyway                   -> compare against the wrong field of the entry
//   G3 test files, dist/ and __tests__/ files are listed               -> drop the test-file, dist or __tests__ exclusion
//   G4 a file with a plain name is listed (the folder name matched)    -> test the whole path instead of the basename
//   G5 a Windows path never matches its registry entry                 -> drop the backslash normalisation
//   G6 a non-source file (.md, .json) is listed                        -> drop the extension filter
//   G7 the fixture runner itself (parser-fixtures.mjs) is listed       -> drop the GAP_EXCLUDE entry
//   G9 a .spec file, a .test-helpers file or a test-utils file is listed -> narrow TEST_FILE
//   G8 the pattern list is not exported or has no parser, guard or lexer word -> change GAP_PATTERNS
import assert from 'node:assert/strict';
import test from 'node:test';
import { GAP_PATTERNS, fixtureGap } from './fixture-gap.mjs';
import { REGISTRY } from './parser-fixtures/registry.mjs';

const REG = [{ id: 'x.parse', file: 'scripts/x/known-parser.mjs' }];
const gap = (files, registry = REG) => fixtureGap(files, registry).files;

test('G1: an unregistered parser or guard source is listed (breaks if the registry lookup is skipped or a word is dropped from GAP_PATTERNS)', () => {
  const files = ['scripts/x/foo-guard.mjs', 'a/b/lexer.ts', 'a/scrub-text.js', 'a/Sanitize.mjs', 'a/tokenizer.mjs', 'a/my-parse.mjs'];
  assert.deepEqual(gap(files), files);
});

test('G2: a file with a registry entry is not listed (breaks if the entry is compared on the wrong field)', () => {
  assert.deepEqual(gap(['scripts/x/known-parser.mjs', 'scripts/x/other-parser.mjs']), ['scripts/x/other-parser.mjs']);
});

test('G3: test files, dist/ and __tests__/ are not listed (breaks if an exclusion is dropped)', () => {
  const files = ['scripts/x/foo-guard.test.mjs', 'a/dist/foo-guard.js', 'a/__tests__/foo-guard.ts', 'a/foo-parser.test.ts'];
  assert.deepEqual(gap(files), []);
});

test('G9: spec files and test helper or util files are not listed (breaks if TEST_FILE drops .spec or the helper and util names)', () => {
  const files = ['a/foo-guard.spec.ts', 'a/foo-guard.test-helpers.mjs', 'a/guard-test-utils.mjs', 'a/parser-test-utils.ts'];
  assert.deepEqual(gap(files), []);
  assert.deepEqual(gap(['a/foo-guard.mjs']), ['a/foo-guard.mjs'], 'a real guard file is still listed');
});

test('G4: only the basename counts (breaks if the whole path is tested)', () => {
  assert.deepEqual(gap(['scripts/guard/plain.mjs', 'scripts/parser/run.mjs']), []);
});

test('G5: a backslash path matches its registry entry and is not listed (breaks if backslashes are not normalised)', () => {
  assert.deepEqual(gap(['scripts\\x\\known-parser.mjs']), []);
  assert.deepEqual(gap(['scripts\\x\\new-guard.mjs']), ['scripts/x/new-guard.mjs']);
});

test('G6: a document or JSON file with a matching name is not listed (breaks if the extension filter is dropped)', () => {
  assert.deepEqual(gap(['docs/parser-notes.md', 'a/guard-table.json']), []);
});

test('G7: the fixture runner is not listed as a parser (breaks if GAP_EXCLUDE drops it)', () => {
  assert.deepEqual(gap(['scripts/checks/parser-fixtures.mjs', 'scripts/checks/parser-fixtures/inputs.mjs']), []);
});

test('G8: GAP_PATTERNS is an exported list of regular expressions that names parser, guard and lexer (breaks if the export or a word goes)', () => {
  assert.ok(Array.isArray(GAP_PATTERNS) && GAP_PATTERNS.length > 0);
  const hit = (name) => GAP_PATTERNS.some((re) => re.test(name));
  for (const word of ['parser', 'guard', 'lexer', 'sanitize', 'scrub', 'tokenize']) assert.ok(hit(`x-${word}.mjs`), word);
});

test('the default registry is the real REGISTRY: its entries are not listed, and an entry added to it is honoured (breaks if the default is an empty list or a copy)', () => {
  assert.ok(REGISTRY.length > 0, 'the real registry is not empty');
  for (const entry of REGISTRY) assert.ok(!fixtureGap([entry.file]).files.includes(entry.file), entry.file);
  // No real entry has a parser or guard name, so a name that is on the list is added to the real array for this test only.
  const file = 'scripts/x/zz-registered-parser.mjs';
  assert.deepEqual(fixtureGap([file]).files, [file], 'unregistered: listed');
  REGISTRY.push({ id: 'zz.test', file });
  try { assert.deepEqual(fixtureGap([file]).files, [], 'registered in the real array: not listed'); } finally { REGISTRY.pop(); }
  assert.deepEqual(fixtureGap(['scripts/x/brand-new-guard.mjs']).files, ['scripts/x/brand-new-guard.mjs']);
});
