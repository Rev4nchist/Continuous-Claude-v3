// Tests for the pure parts of fixdiff-replay.mjs: unique row counts, the gate label, and the seeded-test check.
// The replay itself is the gate: `node scripts/trex/verify/fixdiff-replay.mjs` (needs Docker and the TREX lock).

import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLineNumbers, seededFires, seededTestNames, summarizeRows } from './fixdiff-replay.mjs';

const row = (id, o = {}) => ({ row: id, attempted: true, proven: true, ...o });
const many = (n, o) => Array.from({ length: n }, (_, i) => row(`R${i}`, typeof o === 'function' ? o(i) : o));

// ---------- unique counts and the gate ----------

// Breaks if: a row that shares another row's run (S7 with S6) is counted twice in attempted or proven.
test('summarizeRows: a shared row is in the raw totals and out of the unique totals', () => {
  const rows = [row('S6'), row('S7', { sharedWith: 'S6' }), row('S8', { attempted: false, proven: false })];
  const s = summarizeRows(rows);
  assert.deepEqual([s.rawAttempted, s.rawProven, s.uniqueAttempted, s.uniqueProven], [2, 2, 1, 1]);
});

// Breaks if: the gate reads the raw counts, or the label is a fixed "9 of 11".
test('summarizeRows: the gate uses unique counts and the label shows the real denominator', () => {
  const s = summarizeRows([...many(9), ...many(2, { sharedWith: 'R0' })]);
  assert.equal(s.uniqueAttempted, 9);
  assert.equal(s.gate, 'PASS');
  assert.match(s.gateLabel, /9 of 9 attempted unique/);
  const t = summarizeRows(many(12, (i) => ({ proven: i < 9 })));
  assert.equal(t.gate, 'FAIL');
  assert.match(t.gateLabel, /9 of 12 attempted unique/);
  assert.doesNotMatch(t.gateLabel, /of 11/);
});

test('summarizeRows: 9 of 11 passes, 8 of 8 fails (too few proven), 9 of 13 fails (ratio under 9/11)', () => {
  assert.equal(summarizeRows(many(11, (i) => ({ proven: i < 9 }))).gate, 'PASS');
  assert.equal(summarizeRows(many(8)).gate, 'FAIL');
  assert.equal(summarizeRows(many(13, (i) => ({ proven: i < 9 }))).gate, 'FAIL');
  assert.equal(summarizeRows([]).gate, 'FAIL');
});

// ---------- seeded test ----------

const FIX_TEXT = [
  "import test from 'node:test';",
  "test('alpha works', () => {",
  '  assert.ok(1);',
  '});',
  '',
  'test(`beta ${name} case`, () => {',
  '  assert.ok(2);',
  '});',
  'it("gamma", () => {',
  '  assert.ok(3);',
  '});',
].join('\n');

test('addedLineNumbers: reads the new-side ranges of a zero-context diff', () => {
  const diff = '@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,2 +30,0 @@\n-gone\n-gone2\n';
  assert.deepEqual(addedLineNumbers(diff), [4, 5, 12]);
});

// Breaks if: only a changed title line is read (a changed body is missed) or a line is attributed to the wrong test.
test('seededTestNames: the test that holds an added or changed line, by its title', () => {
  assert.deepEqual(seededTestNames(FIX_TEXT, [3]), ['alpha works']);
  assert.deepEqual(seededTestNames(FIX_TEXT, [6, 10]), ['beta ${name} case', 'gamma']);
  assert.deepEqual(seededTestNames(FIX_TEXT, [1]), []);
});

// Breaks if: pre failing on an unrelated test counts as the seeded test firing.
test('seededFires: false when pre fails only on tests the fix diff did not touch', () => {
  const preText = 'not ok 7 - some other test\nnot ok 8 - yet another\n';
  assert.equal(seededFires(['alpha works'], preText), false);
});

test('seededFires: true when a seeded title is in a failing line, template titles included', () => {
  assert.equal(seededFires(['alpha works'], 'ok 1 - x\nnot ok 2 - alpha works\n'), true);
  assert.equal(seededFires(['beta ${name} case'], '(fail) suite > beta foo case [3ms]\n'), true);
  assert.equal(seededFires(['alpha works'], 'ok 2 - alpha works\n'), false);
});

test('seededFires: null when no title could be read from the diff', () => {
  assert.equal(seededFires([], 'not ok 1 - anything\n'), null);
});

// Breaks if: the TAP escaping of "#" and "\" in a failing line hides a seeded title that holds them (S9: "#225 round 1").
test('seededFires: a TAP-escaped "#" in the failing line still matches the title', () => {
  const title = 'outside-diff count: a notice that quotes an outside-diff heading adds nothing (#225 round 1)';
  assert.equal(seededFires([title], 'not ok 66 - outside-diff count: a notice that quotes an outside-diff heading adds nothing (\\#225 round 1)\n'), true);
  assert.equal(seededFires(['a \\ b'], 'not ok 1 - a \\\\ b\n'), true);
});
