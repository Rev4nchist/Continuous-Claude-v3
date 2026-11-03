// Tests for lib/findings-repair.mjs. Run: node --test scripts/github/lib/findings-repair.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterFindingPaths, repairJsonText } from './findings-repair.mjs';

const fixed = (s) => JSON.parse(repairJsonText(s));

test('a closer that does not match the open object closes that object first (the PR 211 case)', () => {
  // Breaks when: the scan only balances at the end of the text.
  assert.deepEqual(fixed('{"findings":[{"a":1},{"a":"x"]}'), { findings: [{ a: 1 }, { a: 'x' }] });
});

test('unclosed objects and arrays at the end are closed', () => {
  // Breaks when: end-of-text balancing is missing.
  assert.deepEqual(fixed('{"findings":[{"a":1}'), { findings: [{ a: 1 }] });
});

test('trailing commas are removed, and commas inside strings are kept', () => {
  // Breaks when: the comma strip runs on string content.
  assert.deepEqual(fixed('{"findings":[{"a":"x,]","b":2,},]}'), { findings: [{ a: 'x,]', b: 2 }] });
});

test('brackets and escaped quotes inside strings are not structure', () => {
  // Breaks when: the scanner ignores string state.
  assert.deepEqual(fixed(String.raw`{"a":"q\"]}[","b":[1}`), { a: 'q"]}[', b: [1] });
});

test('valid JSON gives null: there is nothing to repair', () => {
  // Breaks when: the function returns text for input that already parses.
  assert.equal(repairJsonText('{"findings":[]}'), null);
});

test('input it cannot fix without inventing content gives null', () => {
  // Breaks when: an open string is closed, a stray closer is dropped, or a half key is completed.
  for (const bad of ['{"a":"cut off', '{"a":1}]', '{"a":', '{broken', '']) assert.equal(repairJsonText(bad), null, bad);
});

test('filterFindingPaths drops findings on missing files, keeps (unspecified), and names each drop', () => {
  // Breaks when: a missing file is kept, (unspecified) is dropped, or the drop list loses file or title.
  const f = (file, title) => ({ file, line: 1, severity: 'major', title, body: '' });
  const { kept, dropped } = filterFindingPaths([f('a.ts', 'A'), f('ghost.ts', 'G'), f('(unspecified)', 'U')], (p) => p === 'a.ts');
  assert.deepEqual(kept.map((x) => x.title), ['A', 'U']);
  assert.deepEqual(dropped, [{ file: 'ghost.ts', title: 'G' }]);
});

test('filterFindingPaths looks up ./ and backslash paths in the normal form but keeps the finding as it was', () => {
  // Breaks when: a path written ./a/b.ts or c\d.ts is dropped, or the finding file is rewritten.
  const seen = [];
  const { kept } = filterFindingPaths([{ file: './a/b.ts', title: 'x' }, { file: 'c\\d.ts', title: 'y' }], (p) => { seen.push(p); return true; });
  assert.deepEqual(seen, ['a/b.ts', 'c/d.ts']);
  assert.deepEqual(kept.map((x) => x.file), ['./a/b.ts', 'c\\d.ts']);
});
