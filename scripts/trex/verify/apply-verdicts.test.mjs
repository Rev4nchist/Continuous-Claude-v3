// Tests for apply-verdicts.mjs: copies of the baseline records with one arm's verdicts applied. No Docker, no model.
// Each test names the change that would break it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyArm, main } from './apply-verdicts.mjs';
import { defaultBaselineDir } from './probe-set.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'apply-verdicts-'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const finding = (id, o = {}) => ({ id, file: 'a.mjs', startLine: 1, endLine: 2, severity: 'major', confidence: 4, status: 'open', title: `t ${id}`, ...o });

/** A baseline dir with three records: S1 (two findings), N3 (one Critical), S2 (a Minor only, no C2 rows). */
function makeBaseline() {
  const dir = tmp();
  const put = (row, findings, extra = {}) => {
    mkdirSync(path.join(dir, row), { recursive: true });
    writeFileSync(path.join(dir, row, 'record.json'), `${JSON.stringify({ schema: 1, head: 'h', status: 'ok', majorsOpen: findings.filter((f) => f.severity === 'major' || f.severity === 'critical').length, findings, ...extra })}\n`);
  };
  put('S1', [finding('f1'), finding('f2')]);
  put('N3', [finding('n1', { severity: 'critical', confidence: 5 })]);
  put('S2', [finding('m1', { severity: 'minor' })]);
  writeFileSync(path.join(dir, 'results.json'), '{}');
  mkdirSync(path.join(dir, '_state'));
  return dir;
}

const c2 = (rows, arm = 'verify') => ({ arm, generatedFrom: 'test', rows });
const row = (pid, rowId, verdict, o = {}) => ({ pid, row: rowId, group: 'C', verdict, reason: 'r', originalSeverity: 'major', originalConfidence: 4, newSeverity: 'major', newConfidence: 4, falseConfirm: null, evidencePath: null, ...o });
const read = (out, arm, rowId) => JSON.parse(readFileSync(path.join(out, arm, 'records', rowId, 'record.json'), 'utf8'));

// Breaks if: the copy step writes into the source folder or rewrites a source record.
test('the source record files are byte-identical after an apply', () => {
  const base = makeBaseline();
  const before = ['S1', 'N3', 'S2'].map((r) => sha256(path.join(base, r, 'record.json')));
  applyArm({ c2: c2([row('f1', 'S1', 'not_reproduced'), row('n1', 'N3', 'refuted')]), baselineDir: base, outDir: tmp() });
  assert.deepEqual(['S1', 'N3', 'S2'].map((r) => sha256(path.join(base, r, 'record.json'))), before);
  assert.deepEqual(readdirSync(base).sort(), ['N3', 'S1', 'S2', '_state', 'results.json']);
});

// Breaks if: an output dir inside the baseline is accepted (a later load would read the copies as records).
test('an out dir inside the baseline dir is refused', () => {
  const base = makeBaseline();
  assert.throws(() => applyArm({ c2: c2([]), baselineDir: base, outDir: path.join(base, 'out') }), /inside the baseline/);
});

// Breaks if: a record with no C2 rows is skipped, so a rescore sees 24 of 25 rows.
test('every record is copied, also the ones with no C2 row; non-record folders are not', () => {
  const base = makeBaseline();
  const out = tmp();
  const r = applyArm({ c2: c2([row('f1', 'S1', 'not_reproduced')]), baselineDir: base, outDir: out });
  assert.equal(r.records, 3);
  assert.deepEqual(readdirSync(path.join(out, 'verify', 'records')).sort(), ['N3', 'S1', 'S2']);
  const orig = JSON.parse(readFileSync(path.join(base, 'S2', 'record.json'), 'utf8'));
  assert.deepEqual(read(out, 'verify', 'S2').findings, orig.findings);
});

// Breaks if: not_reproduced stops lowering to minor/2, refuted to trivial/1, or the original values are lost.
test('a matched finding gets the verdict, keeps verify.originalSeverity, and an unmatched finding is unchanged', () => {
  const base = makeBaseline();
  const out = tmp();
  applyArm({ c2: c2([row('f1', 'S1', 'not_reproduced'), row('n1', 'N3', 'refuted', { originalSeverity: 'critical' })]), baselineDir: base, outDir: out });
  const s1 = read(out, 'verify', 'S1');
  const orig = JSON.parse(readFileSync(path.join(base, 'S1', 'record.json'), 'utf8'));
  assert.equal(s1.findings[0].severity, 'minor');
  assert.equal(s1.findings[0].confidence, 2);
  assert.equal(s1.findings[0].verify.verdict, 'not_reproduced');
  assert.equal(s1.findings[0].verify.originalSeverity, 'major');
  assert.equal(s1.findings[0].verify.originalConfidence, 4);
  assert.deepEqual(s1.findings[1], orig.findings[1]);
  const n3 = read(out, 'verify', 'N3');
  assert.equal(n3.findings[0].severity, 'trivial');
  assert.equal(n3.findings[0].verify.originalSeverity, 'critical');
});

// Breaks if: a blocked or not_attempted verdict changes severity, or loses its verify object.
test('blocked and not_attempted leave severity and confidence alone but are recorded', () => {
  const base = makeBaseline();
  const out = tmp();
  applyArm({ c2: c2([row('f1', 'S1', 'blocked:no-coverage'), row('f2', 'S1', 'not_attempted')]), baselineDir: base, outDir: out });
  const s1 = read(out, 'verify', 'S1');
  assert.deepEqual(s1.findings.map((f) => f.severity), ['major', 'major']);
  assert.deepEqual(s1.findings.map((f) => f.confidence), [4, 4]);
  assert.deepEqual(s1.findings.map((f) => f.verify.verdict), ['blocked:no-coverage', 'not_attempted']);
});

// Breaks if: a copy that is applied twice forgets the first original (the rescore would read the downgrade as the original).
test('applying again on an earlier copy keeps the first originalSeverity', () => {
  const base = makeBaseline();
  const out1 = tmp();
  const out2 = tmp();
  applyArm({ c2: c2([row('f1', 'S1', 'not_reproduced')]), baselineDir: base, outDir: out1 });
  applyArm({ c2: c2([row('f1', 'S1', 'refuted')], 'oracle0'), baselineDir: path.join(out1, 'verify', 'records'), outDir: out2 });
  const f = read(out2, 'oracle0', 'S1').findings[0];
  assert.equal(f.severity, 'trivial');
  assert.equal(f.verify.originalSeverity, 'major');
  assert.equal(f.verify.originalConfidence, 4);
});

// Breaks if: the rerate arm (verdict rerate_down, severity in newSeverity) lowers nothing, or a newSeverity above the original raises a finding.
test('an arm that carries newSeverity and newConfidence is honoured, and never raises', () => {
  const base = makeBaseline();
  const out = tmp();
  const rows = [
    row('f1', 'S1', 'rerate_down', { newSeverity: 'minor', newConfidence: 2 }),
    row('f2', 'S1', 'rerate_keep', { newSeverity: 'critical', newConfidence: 5 }),
  ];
  applyArm({ c2: c2(rows, 'rerate'), baselineDir: base, outDir: out });
  const [f1, f2] = read(out, 'rerate', 'S1').findings;
  assert.deepEqual([f1.severity, f1.confidence, f1.verify.originalSeverity], ['minor', 2, 'major']);
  assert.deepEqual([f2.severity, f2.confidence], ['major', 4]);
});

// Breaks if: a copy keeps the stored majorsOpen of the source, so a scorer that reads it sees no change.
test('majorsOpen in the copy is recomputed; the source count is kept in verifyApplied', () => {
  const base = makeBaseline();
  const out = tmp();
  applyArm({ c2: c2([row('f1', 'S1', 'not_reproduced')]), baselineDir: base, outDir: out });
  const s1 = read(out, 'verify', 'S1');
  assert.equal(s1.majorsOpen, 1);
  assert.equal(s1.verifyApplied.originalMajorsOpen, 2);
  assert.equal(s1.verifyApplied.arm, 'verify');
});

// Breaks if: a bad C2 file is accepted: unknown arm, duplicate pid, missing rows.
test('bad C2 input is rejected', () => {
  const base = makeBaseline();
  const go = (v) => () => applyArm({ c2: v, baselineDir: base, outDir: tmp() });
  assert.throws(go(c2([], 'grok')), /arm/);
  assert.throws(go({ arm: 'verify' }), /rows/);
  assert.throws(go(c2([row('f1', 'S1', 'refuted'), row('f1', 'S1', 'refuted')])), /duplicate pid/);
  assert.throws(go(c2([{ pid: 'f1', row: 'S1' }])), /verdict/);
});

// Breaks if: a typo in a pid, or a pid under the wrong row, is skipped without a trace.
test('a C2 pid that matches no finding of its row is returned as unmatched, and main exits 1', async () => {
  const base = makeBaseline();
  const out = tmp();
  const r = applyArm({ c2: c2([row('nope', 'S1', 'refuted'), row('f1', 'N3', 'refuted')]), baselineDir: base, outDir: out });
  assert.deepEqual(r.unmatched.sort(), ['f1', 'nope']);
  assert.equal(r.applied, 0);
  const file = path.join(tmp(), 'verify', 'verdicts.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c2([row('nope', 'S1', 'refuted')])));
  const lines = [];
  assert.equal(await main(['--verdicts', file, '--baseline', base, '--out', tmp()], { out: (l) => lines.push(l) }), 1);
  assert.ok(lines.some((l) => /unmatched/.test(l)));
});

// Breaks if: main writes beside the verdicts file in the wrong layout: <out>/<arm>/records/<row>/record.json.
test('main defaults the out dir to the folder above <arm>/verdicts.json', async () => {
  const base = makeBaseline();
  const root = tmp();
  const file = path.join(root, 'verify', 'verdicts.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c2([row('f1', 'S1', 'not_reproduced')])));
  assert.equal(await main(['--verdicts', file, '--baseline', base], { out: () => {} }), 0);
  assert.ok(existsSync(path.join(root, 'verify', 'records', 'S1', 'record.json')));
});

// Breaks if: the 44 probe-set pids no longer match findings of the real baseline records (the id formula or the probe set drifted).
test('every probe-set pid matches one finding of its row in the real baseline (read-only)', { skip: !existsSync(path.join(defaultBaselineDir(), 'results.json')) }, () => {
  const set = JSON.parse(readFileSync(new URL('./probe-set.json', import.meta.url), 'utf8')).rows;
  const base = defaultBaselineDir();
  const before = readdirSync(base).filter((n) => /^[SN]\d+$/.test(n)).map((n) => sha256(path.join(base, n, 'record.json')));
  const out = tmp();
  const r = applyArm({ c2: c2(set.map((s) => row(s.pid, s.row, 'not_attempted'))), baselineDir: base, outDir: out });
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.applied, 44);
  assert.equal(r.records, 25);
  assert.deepEqual(readdirSync(base).filter((n) => /^[SN]\d+$/.test(n)).map((n) => sha256(path.join(base, n, 'record.json'))), before);
});
