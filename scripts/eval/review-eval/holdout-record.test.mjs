// Failure modes (re-score-paired step 6: the holdout.json writer).
//  a write with no spend-ledger line for the arm -> the holdout number would not be backed by a spend record
//  a ledger line of another prompt hash          -> the same, for a different prompt
//  a missing hash on both sides matches          -> undefined === undefined authorises a write
//  a repeat write for one engineVersion          -> a rescore hides the first number
//  a half-written file after a crash             -> the write goes through a temp file and a rename
//  a damaged file read as empty                  -> the next write would drop every row
//  an engineVersion or a count that is not valid -> a bad row in the file
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { HOLDOUT_PATH, readHoldout, writeHoldout } from './holdout-record.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-record-')), 'eval', 'holdout.json');
const ledger = [{ reviewer: 'engine', promptVersion: 'v2', promptSha256: 'SHA-A' }, { reviewer: 'cursor-review', promptVersion: null, promptSha256: 'SHA-B' }];
const call = (over = {}) => ({ path: tmpFile(), engineVersion: 'ev-1', promptVersion: 'v2', promptSha256: 'SHA-A', majors: 20, found: 12, pairedBar: { status: 'NOTE' }, ledgerLines: ledger, ...over });

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

test('a valid call writes one row keyed by engineVersion, with the recall computed and the folder created; no temp file is left (breaks if the row shape, the key or the rename changes)', () => {
  const c = call();
  assert.deepEqual(writeHoldout(c), { written: true });
  const file = JSON.parse(fs.readFileSync(c.path, 'utf8'));
  assert.deepEqual(file, { schema: 1, rows: { 'ev-1': { engineVersion: 'ev-1', majors: 20, found: 12, recall: 0.6, pairedBar: { status: 'NOTE' } } } });
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
  const bad = [{ engineVersion: '' }, { engineVersion: undefined }, { engineVersion: 7 }, { majors: 1.5 }, { majors: '20' }, { found: -1 }, { found: 21 }, { found: 1.5 }, { path: undefined }, { path: '' }, { ledgerLines: undefined }];
  for (const over of bad) {
    const c = call(over);
    assert.throws(() => writeHoldout(c), Error, JSON.stringify(over));
    if (c.path) assert.equal(fs.existsSync(c.path), false);
  }
});

test('writeHoldout refuses the whole card pairedBar ({ holdout, dev }) and writes nothing; the holdout cell alone is stored (breaks if dev numbers can reach holdout.json)', () => {
  const card = call({ pairedBar: { holdout: { status: 'NOTE' }, dev: { status: 'NOTE' } } });
  assert.throws(() => writeHoldout(card), /pairedBar\.holdout/);
  assert.equal(fs.existsSync(card.path), false);
  const cell = call({ pairedBar: card.pairedBar.holdout });
  assert.deepEqual(writeHoldout(cell), { written: true });
  assert.deepEqual(readHoldout(cell.path).rows['ev-1'].pairedBar, { status: 'NOTE' });
});
