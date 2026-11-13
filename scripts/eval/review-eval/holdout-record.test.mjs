// Failure modes (re-score-paired step 6: the holdout.json writer).
//  a write with no spend-ledger line for the arm -> the holdout number would not be backed by a spend record
//  a ledger line of another prompt hash          -> the same, for a different prompt
//  a missing hash on both sides matches          -> undefined === undefined authorises a write
//  a repeat write for one engineVersion          -> a rescore hides the first number
//  a half-written file after a crash             -> the write goes through a temp file and a rename
//  a damaged file read as empty                  -> the next write would drop every row
//  an engineVersion or a count that is not valid -> a bad row in the file
//  a dev cell, a bare cell or a whole card as pairedBar -> a dev number or a PR id lands in the holdout file
//  a recall under 20 Majors                      -> a percent that the card itself would not print
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { HOLDOUT_PATH, readHoldout, writeHoldout } from './holdout-record.mjs';
import { scorecard } from './score.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-record-')), 'eval', 'holdout.json');
const ledger = [{ reviewer: 'engine', promptVersion: 'v2', promptSha256: 'SHA-A' }, { reviewer: 'cursor-review', promptVersion: null, promptSha256: 'SHA-B' }];
const suiteCell = (over = {}) => ({ delta: -3, lo: -6, hi: 0, n: 25, unpaired: 1, d: 0.1, nNeeded: 154, wouldBe: 'FAIL', B: 2000, used: 2000, clusters: 12, ...over });
const barCell = (tag, over = {}) => ({ status: 'NOTE', baseline: `${tag}-base`, candidate: `${tag}-cand`, regression: suiteCell(), capability: suiteCell({ delta: 4, wouldBe: 'PASS' }), unassigned: suiteCell({ wouldBe: null }), ...over });
/** The per-set pairedBar of a card: { holdout, dev }. */
const perSetBar = () => ({ holdout: barCell('hold'), dev: barCell('dev') });
/** What the file keeps of the holdout cell: no clusters. */
const keptHoldout = () => {
  const { clusters, ...kept } = suiteCell();
  const { clusters: c2, ...cap } = suiteCell({ delta: 4, wouldBe: 'PASS' });
  const { clusters: c3, ...una } = suiteCell({ wouldBe: null });
  return { status: 'NOTE', baseline: 'hold-base', candidate: 'hold-cand', regression: kept, capability: cap, unassigned: una };
};
const call = (over = {}) => ({ path: tmpFile(), engineVersion: 'ev-1', promptVersion: 'v2', promptSha256: 'SHA-A', majors: 20, found: 12, pairedBar: perSetBar(), ledgerLines: ledger, ...over });

test('HOLDOUT_PATH is the state file under the home folder (breaks if the constant points elsewhere)', () => {
  assert.ok(HOLDOUT_PATH.startsWith(os.homedir()));
  assert.deepEqual(HOLDOUT_PATH.split(path.sep).slice(-5), ['.claude', 'state', 'local-review', 'eval', 'holdout.json']);
});

test('no ledger line for the arm writes no file and says why; a line with another hash, another version or another reviewer does not count (breaks if the ledger check is skipped or loosened)', () => {
  const none = call({ ledgerLines: [] });
  assert.deepEqual(writeHoldout(none), { written: false, reason: 'no-ledger-line' });
  assert.equal(fs.existsSync(none.path), false);
  assert.equal(fs.existsSync(path.dirname(none.path)), false, 'not even the folder');
  for (const other of [{ promptSha256: 'SHA-OTHER' }, { promptVersion: 'v9' }, { reviewer: 'cursor-review' }]) {
    const c = call({ ledgerLines: [{ ...ledger[0], ...other }] });
    assert.equal(writeHoldout(c).reason, 'no-ledger-line', JSON.stringify(other));
    assert.equal(fs.existsSync(c.path), false);
  }
});

test('a repeat call with no ledger line says no-ledger-line, not exists (breaks if the exists check runs before the ledger check)', () => {
  const c = call();
  assert.deepEqual(writeHoldout(c), { written: true });
  assert.deepEqual(writeHoldout({ ...c, ledgerLines: [] }), { written: false, reason: 'no-ledger-line' });
});

test('a missing hash on both sides is not a match (breaks if undefined equals undefined)', () => {
  const c = call({ promptSha256: undefined, ledgerLines: [{ reviewer: 'engine', promptVersion: 'v2' }] });
  assert.equal(writeHoldout(c).reason, 'no-ledger-line');
  assert.equal(writeHoldout(call({ promptVersion: '', promptSha256: '', ledgerLines: [{ reviewer: 'engine', promptVersion: '', promptSha256: '' }] })).reason, 'no-ledger-line');
});

test('a valid call writes one row keyed by engineVersion, with the recall computed, the holdout cell of the per-set pairedBar and the folder created; no temp file is left (breaks if the row shape, the key or the rename changes)', () => {
  const c = call();
  assert.deepEqual(writeHoldout(c), { written: true });
  const file = JSON.parse(fs.readFileSync(c.path, 'utf8'));
  assert.deepEqual(file, { schema: 1, rows: { 'ev-1': { engineVersion: 'ev-1', majors: 20, found: 12, recall: 0.6, pairedBar: keptHoldout() } } });
  assert.deepEqual(fs.readdirSync(path.dirname(c.path)), ['holdout.json']);
  assert.deepEqual(readHoldout(c.path), file);
});

test('the file goes through a temp file in its own folder and one rename onto the target; a failed rename keeps the old file and leaves no temp file (breaks if the write goes straight to the target)', () => {
  const c = call();
  writeHoldout(c);
  const before = fs.readFileSync(c.path, 'utf8');
  const real = fs.renameSync;
  const seen = [];
  const spy = mock.method(fs, 'renameSync', (from, to) => { seen.push([from, to]); return real(from, to); });
  try {
    writeHoldout({ ...c, engineVersion: 'ev-2' });
    assert.equal(seen.length, 1);
    assert.equal(path.dirname(seen[0][0]), path.dirname(c.path));
    assert.notEqual(seen[0][0], c.path);
    assert.equal(seen[0][1], c.path);
    const afterOk = fs.readFileSync(c.path, 'utf8');
    spy.mock.mockImplementation(() => { throw new Error('rename failed'); });
    assert.throws(() => writeHoldout({ ...c, engineVersion: 'ev-3' }), /rename failed/);
    assert.equal(fs.readFileSync(c.path, 'utf8'), afterOk, 'the old file stays whole');
    assert.notEqual(afterOk, before);
    assert.deepEqual(fs.readdirSync(path.dirname(c.path)), ['holdout.json'], 'no temp file stays');
  } finally {
    spy.mock.restore();
  }
});

test('zero majors gives a null recall (breaks if it divides by zero)', () => {
  const c = call({ majors: 0, found: 0 });
  writeHoldout(c);
  assert.equal(readHoldout(c.path).rows['ev-1'].recall, null);
});

test('R1 the recall is null under 20 Majors and a number from 20: 19 of 19 gives null, 20 of 20 gives 1 (breaks if the cut of the scorecard (MIN_CELL) is not used here)', () => {
  const small = call({ majors: 19, found: 19 });
  writeHoldout(small);
  assert.deepEqual([readHoldout(small.path).rows['ev-1'].recall, readHoldout(small.path).rows['ev-1'].found, readHoldout(small.path).rows['ev-1'].majors], [null, 19, 19]);
  const edge = call({ majors: 20, found: 20 });
  writeHoldout(edge);
  assert.equal(readHoldout(edge.path).rows['ev-1'].recall, 1);
});

test('a repeat write for the same engineVersion is refused; replace: true replaces it; another engineVersion keeps the old row (breaks if a repeat overwrites or a new row drops the old one)', () => {
  const c = call();
  writeHoldout(c);
  assert.deepEqual(writeHoldout({ ...c, found: 5 }), { written: false, reason: 'exists' });
  assert.equal(readHoldout(c.path).rows['ev-1'].found, 12);
  assert.deepEqual(writeHoldout({ ...c, found: 5, replace: true }), { written: true });
  assert.equal(readHoldout(c.path).rows['ev-1'].found, 5);
  writeHoldout({ ...c, engineVersion: 'ev-2' });
  assert.deepEqual(Object.keys(readHoldout(c.path).rows), ['ev-1', 'ev-2']);
});

test('R5e only replace === true replaces: a truthy value that is not true leaves the old row (breaks if replace is read as truthy)', () => {
  const c = call();
  writeHoldout(c);
  for (const replace of ['yes', 1, 'true', {}, [], false, null, undefined]) {
    assert.deepEqual(writeHoldout({ ...c, found: 5, replace }), { written: false, reason: 'exists' }, String(replace));
  }
  assert.equal(readHoldout(c.path).rows['ev-1'].found, 12);
});

test('readHoldout gives an empty file for a missing path and throws on a damaged file; a write then refuses to touch it (breaks if damage reads as empty)', () => {
  const c = call();
  assert.deepEqual(readHoldout(c.path), { schema: 1, rows: {} });
  fs.mkdirSync(path.dirname(c.path), { recursive: true });
  for (const bad of ['{not json', '[]', '{"schema":1}', '{"schema":2,"rows":{}}', '{"schema":1,"rows":[]}']) {
    fs.writeFileSync(c.path, bad);
    assert.throws(() => readHoldout(c.path), /holdout/i, bad);
    assert.throws(() => writeHoldout(c), /holdout/i, bad);
    assert.equal(fs.readFileSync(c.path, 'utf8'), bad, 'a damaged file stays as it is');
  }
});

test('writeHoldout throws on a bad engineVersion, a bad count, a missing path or a bad ledger list, and writes nothing (breaks if a check is dropped)', () => {
  const bad = [{ engineVersion: '' }, { engineVersion: undefined }, { engineVersion: 7 }, { majors: 1.5 }, { majors: '20' }, { majors: -1, found: 0 }, { majors: NaN, found: 0 }, { found: -1 }, { found: 21 }, { found: NaN }, { found: Infinity }, { found: '5' }, { found: null }, { path: undefined }, { path: '' }, { ledgerLines: undefined }];
  for (const over of bad) {
    const c = call(over);
    assert.throws(() => writeHoldout(c), Error, String(Object.keys(over)) + String(Object.values(over)));
    if (c.path) assert.equal(fs.existsSync(c.path), false);
  }
});

test('R4 majors are distinct gold items (an integer, 0 or more); found may be a mean over replicates: 1.875 of 3 is accepted, 3.5 of 3 and a fraction of majors are refused (breaks if found must be an integer, or the bound found <= majors is lost)', () => {
  const ok = call({ majors: 3, found: 1.875 });
  assert.deepEqual(writeHoldout(ok), { written: true });
  const row = readHoldout(ok.path).rows['ev-1'];
  assert.deepEqual([row.majors, row.found, row.recall], [3, 1.875, null], 'under 20 Majors: no recall');
  assert.deepEqual(writeHoldout(call({ majors: 20, found: 12.5 })), { written: true });
  const full = call({ majors: 20, found: 12.5 });
  writeHoldout(full);
  assert.equal(readHoldout(full.path).rows['ev-1'].recall, 0.625);
  for (const over of [{ majors: 3, found: 3.5 }, { majors: 2.5, found: 1 }, { majors: 3, found: -0.5 }]) {
    const c = call(over);
    assert.throws(() => writeHoldout(c), /majors|found/, JSON.stringify(over));
    assert.equal(fs.existsSync(c.path), false);
  }
});

test('R2 a bare dev cell, a bare holdout cell, a whole card and an object with no holdout are refused and write nothing (breaks if any object without a dev key passes, or a card can pass)', () => {
  const card = scorecard({ sets: {}, runs: [], matches: [], compare: { baseline: 'a-base', candidate: 'a-cand' } });
  assert.ok(card.pairedBar.holdout && card.prFalseAlarm !== undefined, 'the fixture is a real card');
  const refused = [
    ['bare dev cell', perSetBar().dev],
    ['bare holdout cell', perSetBar().holdout],
    ['whole card', { ...card, prFalseAlarm: { count: 1, total: 1, prs: [9001] } }],
    ['no holdout key', { dev: barCell('dev') }],
    ['holdout is not an object', { holdout: 'x', dev: barCell('dev') }],
    ['a key besides holdout and dev', { ...perSetBar(), prFalseAlarm: { prs: [9001] } }],
    ['a string', 'holdout'],
    ['an array', []],
    ['an empty holdout cell', { holdout: {} }],
    ['a whole card as the holdout cell', { holdout: card }],
    ['a wrapped per-set object as the holdout cell', { holdout: perSetBar() }],
    ['an object as baseline', { holdout: barCell('hold', { baseline: { prs: [9001] } }) }],
    ['a number as candidate', { holdout: barCell('hold', { candidate: 9001 }) }],
    ['a wrong status', { holdout: barCell('hold', { status: 'PASS' }) }],
    ['a missing suite cell', { holdout: barCell('hold', { capability: undefined }) }],
  ];
  for (const [name, pairedBar] of refused) {
    const c = call({ pairedBar });
    assert.throws(() => writeHoldout(c), /pairedBar/, name);
    assert.equal(fs.existsSync(c.path), false, name);
  }
});

test('R2 a per-set pairedBar from a real card writes its holdout cell only, through an allow-list: no dev number, no clusters, no other key at the top or in a suite cell (breaks if a dev key, a free key or a count outside the list reaches holdout.json)', () => {
  const planted = perSetBar();
  planted.holdout.secretTop = { prs: [9001] };
  planted.holdout.regression.cluster = '#9001';
  planted.holdout.capability.perPr = 3;
  planted.holdout.dev = 'x';
  const c = call({ pairedBar: planted });
  assert.deepEqual(writeHoldout(c), { written: true });
  const stored = readHoldout(c.path).rows['ev-1'].pairedBar;
  assert.deepEqual(stored, keptHoldout());
  assert.equal(fs.readFileSync(c.path, 'utf8').includes('dev-base'), false, 'no dev cell');
  const card = scorecard({ sets: {}, runs: [], matches: [], compare: { baseline: 'a-base', candidate: 'a-cand' } });
  const real = call({ pairedBar: card.pairedBar });
  assert.deepEqual(writeHoldout(real), { written: true });
  const keys = (x) => Object.keys(x).sort();
  const realStored = readHoldout(real.path).rows['ev-1'].pairedBar;
  assert.deepEqual(keys(realStored), ['baseline', 'candidate', 'capability', 'regression', 'status', 'unassigned']);
  assert.deepEqual(keys(realStored.regression), ['B', 'd', 'delta', 'hi', 'lo', 'n', 'nNeeded', 'unpaired', 'used', 'wouldBe']);
});

test('R2 an object or an array under an allowed suite key is dropped, and so is a value of the wrong type: no PR id reaches the file (breaks if a key is kept by its name alone, or the type of its value is not checked)', () => {
  const planted = perSetBar();
  planted.holdout.regression.delta = [9001];
  planted.holdout.regression.n = { prs: [9001] };
  planted.holdout.regression.lo = 'owner/x#9001';
  planted.holdout.regression.wouldBe = 'owner/x#9001';
  planted.holdout.capability.hi = Number.NaN;
  planted.holdout.capability.nNeeded = '154';
  planted.holdout.capability.wouldBe = 'MAYBE';
  planted.holdout.unassigned.B = { prs: [9001] };
  planted.holdout.unassigned.used = [9001];
  const c = call({ pairedBar: planted });
  assert.deepEqual(writeHoldout(c), { written: true });
  assert.equal(fs.readFileSync(c.path, 'utf8').includes('9001'), false, 'no PR id in the file text');
  const { regression, capability, unassigned } = readHoldout(c.path).rows['ev-1'].pairedBar;
  for (const k of ['delta', 'n', 'lo', 'wouldBe']) assert.equal(Object.hasOwn(regression, k), false, `regression.${k}`);
  for (const k of ['hi', 'nNeeded', 'wouldBe']) assert.equal(Object.hasOwn(capability, k), false, `capability.${k}`);
  for (const k of ['B', 'used']) assert.equal(Object.hasOwn(unassigned, k), false, `unassigned.${k}`);
  assert.equal(regression.hi, 0, 'a valid key of the same cell stays');
});

test('R2 a card with no compare has pairedBar null: the row keeps null (breaks if a null bar is refused or turned into an object)', () => {
  const c = call({ pairedBar: null });
  assert.deepEqual(writeHoldout(c), { written: true });
  assert.equal(readHoldout(c.path).rows['ev-1'].pairedBar, null);
});
