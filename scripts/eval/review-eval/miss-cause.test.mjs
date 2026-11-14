// Tests for miss-cause.mjs. Paths are made up. Path case is always ignored (the record does not say which OS made it).
// Each test names the change that breaks it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFromFiles, classifyMiss, normPath } from './miss-cause.mjs';

const base = { truthPath: 'src/a.mjs', diffFiles: ['src/a.mjs'], hunkFiles: [], filesRead: [{ path: 'src/a.mjs', ranges: [[1, 9]] }], impactRows: [] };
const PAIR1 = ['in_diff_logic', 'policy_difference', 'insufficient_evidence'];
const PAIR2 = ['opened_dismissed', 'policy_difference', 'insufficient_evidence'];

test('step 1: diff file that was read goes to the judge (breaks if step 1 is dropped)', () => {
  const r = classifyMiss(base);
  assert.deepEqual(r.judge, PAIR1);
  assert.equal(r.cls, undefined);
});

test('the judge pair always allows insufficient_evidence (breaks if it is left out of GOOD_PAIR)', () => {
  assert.ok(classifyMiss(base).judge.includes('insufficient_evidence'));
  assert.ok(classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: [{ path: 'src/a.mjs' }] }).judge.includes('insufficient_evidence'));
});

test('step 1: diff file that was not read is in_impact_not_opened with a computed reason', () => {
  const r = classifyMiss({ ...base, filesRead: [{ path: 'src/other.mjs', ranges: [] }] });
  assert.equal(r.cls, 'in_impact_not_opened');
  assert.match(r.reason, /diffFiles/);
  assert.match(r.reason, /filesRead/);
});

test('step 1: a hunk file counts like a diff file', () => {
  const r = classifyMiss({ ...base, diffFiles: ['other.mjs'], hunkFiles: ['src/a.mjs'], filesRead: [] });
  assert.equal(r.cls, 'in_impact_not_opened');
  assert.match(r.reason, /hunkFiles/);
  const read = classifyMiss({ ...base, diffFiles: ['other.mjs'], hunkFiles: ['src/a.mjs'] });
  assert.deepEqual(read.judge, PAIR1);
});

test('step 2: impact row that was read goes to the judge with the step 2 pair', () => {
  const r = classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: [{ path: 'src/a.mjs' }] });
  assert.deepEqual(r.judge, PAIR2);
});

test('step 2: impact row that was not read is in_impact_not_opened', () => {
  const r = classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: [{ path: 'src/a.mjs' }], filesRead: [] });
  assert.equal(r.cls, 'in_impact_not_opened');
  assert.match(r.reason, /impactRows/);
});

test('step 3: outside every list is not_in_impact', () => {
  const r = classifyMiss({ ...base, diffFiles: ['x.mjs'], hunkFiles: ['y.mjs'], impactRows: [{ path: 'z.mjs' }] });
  assert.equal(r.cls, 'not_in_impact');
  assert.match(r.reason, /none of/);
});

test('a path in both diffFiles and impactRows takes step 1', () => {
  const r = classifyMiss({ ...base, impactRows: [{ path: 'src/a.mjs' }] });
  assert.deepEqual(r.judge, PAIR1);
});

test('no trace: filesRead missing or not an array is insufficient_evidence naming filesRead', () => {
  for (const filesRead of [undefined, null, 'x', {}]) {
    const r = classifyMiss({ ...base, filesRead });
    assert.equal(r.cls, 'insufficient_evidence');
    assert.equal(r.missing, 'filesRead');
  }
});

test('an empty filesRead array is a trace, not a missing one', () => {
  assert.equal(classifyMiss({ ...base, filesRead: [] }).cls, 'in_impact_not_opened');
});

test('diffFiles missing, not an array or empty is insufficient_evidence naming diffFiles (a reviewed diff always has a file)', () => {
  for (const diffFiles of [undefined, null, 'x', {}, []]) {
    const r = classifyMiss({ ...base, diffFiles });
    assert.equal(r.cls, 'insufficient_evidence', JSON.stringify(diffFiles));
    assert.equal(r.missing, 'diffFiles');
  }
  // Even with a hunk file and an impact row, no diff files means no trustworthy list.
  assert.equal(classifyMiss({ ...base, diffFiles: [], hunkFiles: ['src/a.mjs'] }).missing, 'diffFiles');
});

test('no truth path: insufficient_evidence naming truthPath', () => {
  for (const truthPath of [undefined, null, '']) {
    const r = classifyMiss({ ...base, truthPath });
    assert.equal(r.cls, 'insufficient_evidence');
    assert.equal(r.missing, 'truthPath');
  }
});

test('impactRowsEmpty is true for [] and for a missing list, false when rows exist', () => {
  assert.equal(classifyMiss(base).impactRowsEmpty, true);
  assert.equal(classifyMiss({ ...base, impactRows: undefined }).impactRowsEmpty, true);
  assert.equal(classifyMiss({ ...base, impactRows: [{ path: 'q.mjs' }] }).impactRowsEmpty, false);
  assert.equal(classifyMiss({ ...base, filesRead: undefined }).impactRowsEmpty, true);
  assert.equal(classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: ['src/a.mjs'] }).impactRowsEmpty, false);
});

test('impact rows as plain strings and as { path } objects both match', () => {
  const asString = classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: ['src/a.mjs'], filesRead: [] });
  const asObject = classifyMiss({ ...base, diffFiles: ['other.mjs'], impactRows: [{ path: 'src/a.mjs' }], filesRead: [] });
  assert.equal(asString.cls, 'in_impact_not_opened');
  assert.equal(asObject.cls, 'in_impact_not_opened');
});

test('filesRead entries as plain strings also match', () => {
  assert.deepEqual(classifyMiss({ ...base, filesRead: ['src/a.mjs'] }).judge, PAIR1);
});

test('backslashes and a leading ./ are the same path', () => {
  const r = classifyMiss({ ...base, truthPath: '.\\src\\a.mjs', diffFiles: ['./src/a.mjs'], filesRead: [{ path: 'src\\a.mjs' }] });
  assert.deepEqual(r.judge, PAIR1);
});

test('case is always ignored (breaks if case folding is limited to one platform)', () => {
  assert.deepEqual(classifyMiss({ ...base, truthPath: 'SRC/A.mjs' }).judge, PAIR1);
  assert.deepEqual(classifyMiss({ ...base, filesRead: [{ path: 'Src/a.MJS' }] }).judge, PAIR1);
});

test('normPath: slashes, leading ./ and case', () => {
  assert.equal(normPath('.\\A\\b.js'), 'a/b.js');
});

test('delta mode: deltaMode true is added to every kind of result, and is absent otherwise', () => {
  assert.equal(classifyMiss({ ...base, deltaMode: true }).deltaMode, true);
  assert.equal(classifyMiss({ ...base, filesRead: [], deltaMode: true }).deltaMode, true);
  assert.equal(classifyMiss({ ...base, truthPath: 'nope.mjs', deltaMode: true }).deltaMode, true);
  assert.equal(classifyMiss({ ...base, filesRead: undefined, deltaMode: true }).deltaMode, true);
  assert.equal(classifyMiss(base).deltaMode, undefined);
});

test('classifyFromFiles reads truth.file, trace.filesRead, trace.diffFiles and record.impactRows', () => {
  const trace = { filesRead: [{ path: 'src/a.mjs', ranges: [] }], diffFiles: ['src/a.mjs'] };
  assert.deepEqual(classifyFromFiles({ truth: { file: 'src/a.mjs' }, trace, record: { impactRows: [] } }).judge, PAIR1);
  const viaRow = classifyFromFiles({ truth: { file: 'lib/b.mjs' }, trace: { filesRead: [], diffFiles: ['x.mjs'] }, record: { impactRows: [{ path: 'lib/b.mjs' }] } });
  assert.equal(viaRow.cls, 'in_impact_not_opened');
  assert.equal(viaRow.impactRowsEmpty, false);
});

test('classifyFromFiles: record.mode delta sets deltaMode', () => {
  const trace = { filesRead: [], diffFiles: ['src/a.mjs'] };
  assert.equal(classifyFromFiles({ truth: { file: 'src/a.mjs' }, trace, record: { mode: 'delta' } }).deltaMode, true);
  assert.equal(classifyFromFiles({ truth: { file: 'src/a.mjs' }, trace, record: { mode: 'full' } }).deltaMode, undefined);
});

test('classifyFromFiles: no trace or no truth file is insufficient_evidence', () => {
  assert.equal(classifyFromFiles({ truth: { file: 'a' }, trace: undefined, record: {} }).missing, 'filesRead');
  assert.equal(classifyFromFiles({ truth: {}, trace: { filesRead: [], diffFiles: ['x'] }, record: {} }).missing, 'truthPath');
});

// ---------- round 3: path collapse and empty lists ----------

const FORMS = [['a//b.mjs', 'a/b.mjs'], ['a/./b.mjs', 'a/b.mjs'], ['a/x/../b.mjs', 'a/b.mjs'], ['/a/b.mjs', 'a/b.mjs'], ['a/b.mjs/', 'a/b.mjs'], ['.\\a\\\\b.mjs', 'a/b.mjs'], ['./A/B.mjs', 'a/b.mjs']];

test('normPath: collapses //, /./ and /../ segments and strips a leading or trailing slash', () => {
  for (const [from, to] of FORMS) assert.equal(normPath(from), to, from);
});

test('normPath: a path that still starts with .. is kept, and a path that is nothing gives an empty string', () => {
  assert.equal(normPath('../x/y.mjs'), '../x/y.mjs');
  assert.equal(normPath('a/../../x.mjs'), '../x.mjs');
  for (const empty of ['', '.', './', '/', undefined]) assert.equal(normPath(empty), '', String(empty));
});

test('odd forms of src/a.mjs match src/a.mjs in all three roles', () => {
  const odd = ['src//a.mjs', 'src/./a.mjs', 'src/x/../a.mjs', '/src/a.mjs', 'src/a.mjs/', '.\\src\\\\a.mjs', 'SRC/A.mjs'];
  for (const o of odd) {
    assert.deepEqual(classifyMiss({ ...base, truthPath: o }).judge, PAIR1, `truth ${o}`);
    assert.deepEqual(classifyMiss({ ...base, diffFiles: [o] }).judge, PAIR1, `diff ${o}`);
    assert.deepEqual(classifyMiss({ ...base, filesRead: [o] }).judge, PAIR1, `read ${o}`);
  }
});

test('diffFiles that normalize to nothing count as empty: [{}], [null], ["./"], ["/"] give missing diffFiles', () => {
  for (const diffFiles of [[{}], [null], ['./'], ['/'], [{ path: '' }], ['', '.']]) {
    const r = classifyMiss({ ...base, diffFiles });
    assert.equal(r.cls, 'insufficient_evidence', JSON.stringify(diffFiles));
    assert.equal(r.missing, 'diffFiles');
  }
});

test('a truth path that normalizes to nothing is insufficient_evidence naming truthPath', () => {
  for (const truthPath of ['.', './', '/']) assert.equal(classifyMiss({ ...base, truthPath }).missing, 'truthPath', truthPath);
});

test('impact rows with no usable path count as empty for impactRowsEmpty', () => {
  for (const impactRows of [[{}], [null], ['./'], [{ path: '/' }]]) assert.equal(classifyMiss({ ...base, impactRows }).impactRowsEmpty, true, JSON.stringify(impactRows));
  assert.equal(classifyMiss({ ...base, impactRows: [{}, { path: 'q.mjs' }] }).impactRowsEmpty, false);
});
