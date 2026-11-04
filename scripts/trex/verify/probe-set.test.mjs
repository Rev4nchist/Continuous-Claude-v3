// Tests for probe-set.mjs. buildProbeSet is pure, so the unit cases use a small fixture, not the real 25 records.
// The last cases read the real trex-baseline files when they exist, and check the gate numbers of the P0 design.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProbeSet, defaultBaselineDir, gitReadSource, loadBaseline, serializeProbeSet } from './probe-set.mjs';

const H = (c) => c.repeat(40);
const finding = (o) => ({ file: 'scripts/a.mjs', startLine: 10, endLine: 12, severity: 'major', confidence: 5, status: 'open', title: 'T', body: 'B', id: `id-${o.title ?? 'T'}-${o.startLine ?? 10}`, ...o });
const record = (id, findings, over = {}) => ({ id, record: { head: H('a'), mergeBase: H('b'), findings, ...over } });
const plan = (rows) => ({ rows });
const prow = (id, over = {}) => ({ id, kind: 'positive', head40: H('a'), pre40: H('a'), base40: H('b'), fix40: H('f'), ...over });
const results = (hits) => ({ positives: hits.map(([id, fnd]) => ({ id, hit: fnd !== null, finding: fnd })) });

function fixture() {
  return {
    records: [
      record('S4', [
        finding({ file: '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx', startLine: 528, title: 'Resumed subagent turn leaves the state file idle', id: 'x528' }),
        finding({ file: '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx', startLine: 241, title: 'Idle pulse never settles a dead subagent', id: 'x241' }),
        finding({ title: 'minor one', severity: 'minor', id: 'm1' }),
        finding({ title: 'low confidence', confidence: 2, id: 'lc' }),
        finding({ title: 'closed', status: 'resolved', id: 'cl' }),
      ]),
      record('S9', [finding({ file: 'scripts/github/review-status.mjs', startLine: 798, title: 'Notice reviews inflate', id: 's9a' })]),
      record('N3', [finding({ file: '.claude/hooks/src/shared/scoped-cleanup.ts', startLine: 230, title: 'Rewritten gitdir', id: 'n3a' })]),
      record('N8', [finding({ title: 'a minor', severity: 'minor', id: 'n8m' })]),
    ],
    results: results([
      ['S4', '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx:241 Idle pulse never settles a dead subagent'],
      ['S9', null],
    ]),
    plan: plan([prow('S4', { fix40: H('4') }), prow('S9', { fix40: H('9') })]),
  };
}

const build = (fx = fixture(), deps) => buildProbeSet(fx, deps);

test('the hit finding is A and the other open Major on the same row is C (break: tag a whole row)', () => {
  const rows = build().rows;
  const s4 = rows.filter((r) => r.row === 'S4');
  assert.deepEqual(s4.map((r) => [r.pid, r.group]).sort(), [['x241', 'A'], ['x528', 'C']]);
});

test('the hit is matched on file, line and title: a different line in the same file is not A', () => {
  const fx = fixture();
  fx.results.positives[0].finding = '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx:528 Idle pulse never settles a dead subagent';
  assert.throws(() => build(fx), /S4.*no open Major/);
});

test('a hit whose title differs does not match (break: match on file and line only)', () => {
  const fx = fixture();
  fx.results.positives[0].finding = '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx:241 Some other title';
  assert.throws(() => build(fx), /S4.*no open Major/);
});

test('a hit that matches two open Majors is an error, not a guess', () => {
  const fx = fixture();
  fx.records[0].record.findings.push(finding({ file: '.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx', startLine: 241, title: 'Idle pulse never settles a dead subagent', id: 'dup' }));
  assert.throws(() => build(fx), /S4.*more than one/);
});

test('a non-hit S row has only C findings', () => {
  assert.deepEqual(build().rows.filter((r) => r.row === 'S9').map((r) => r.group), ['C']);
});

test('an N row Major is B (break: tag N rows by the hit list)', () => {
  const n3 = build().rows.find((r) => r.row === 'N3');
  assert.equal(n3.group, 'B');
  assert.equal(n3.fix, null);
});

test('only open Majors with confidence 3 or more are listed: minor, low confidence and resolved are out', () => {
  const pids = build().rows.map((r) => r.pid);
  for (const out of ['m1', 'lc', 'cl', 'n8m']) assert.ok(!pids.includes(out), out);
  assert.equal(pids.length, 4);
});

test('a critical open finding is listed', () => {
  const fx = fixture();
  fx.records[2].record.findings[0].severity = 'critical';
  assert.equal(build(fx).rows.find((r) => r.row === 'N3').severity, 'critical');
});

test('an S row with no fix SHA throws (break: default the fix to null)', () => {
  const fx = fixture();
  delete fx.plan.rows[1].fix40;
  assert.throws(() => build(fx), /S9.*fix/);
});

test('an S row missing from the plan throws', () => {
  const fx = fixture();
  fx.plan.rows.pop();
  assert.throws(() => build(fx), /S9.*plan/);
});

test('a fix SHA that is not 40 hex throws', () => {
  const fx = fixture();
  fx.plan.rows[0].fix40 = 'f0b67364';
  assert.throws(() => build(fx), /S4.*fix/);
});

test('a record head that is not the plan head40 throws', () => {
  const fx = fixture();
  fx.plan.rows[0].head40 = H('c');
  assert.throws(() => build(fx), /S4.*head/);
});

test('a row whose pre SHA is not its head keeps both (S12 and S15: the head is a merge commit)', () => {
  const fx = fixture();
  fx.plan.rows[1].pre40 = H('d');
  const r = build(fx).rows.find((x) => x.pid === 's9a');
  assert.deepEqual([r.head, r.pre, r.fix], [H('a'), H('d'), H('9')]);
});

test('S rows carry head, mergeBase, pre and the fix SHA from the plan; N rows carry head and mergeBase', () => {
  const rows = build().rows;
  const a = rows.find((r) => r.pid === 'x241');
  assert.deepEqual([a.head, a.mergeBase, a.pre, a.fix], [H('a'), H('b'), H('a'), H('4')]);
  const b = rows.find((r) => r.pid === 'n3a');
  assert.deepEqual([b.head, b.mergeBase, b.pre, b.fix], [H('a'), H('b'), null, null]);
});

test('a record with a bad head throws', () => {
  const fx = fixture();
  fx.records[2].record.head = 'abc';
  assert.throws(() => build(fx), /N3.*head/);
});

test('pid is the finding id; with no id it is a stable hash of row, file, line and title', () => {
  const fx = fixture();
  delete fx.records[2].record.findings[0].id;
  const first = build(fx).rows.find((r) => r.row === 'N3').pid;
  const second = build(fx).rows.find((r) => r.row === 'N3').pid;
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, second);
  assert.ok(build().rows.some((r) => r.pid === 'x241'));
});

test('two findings with the same pid throw', () => {
  const fx = fixture();
  fx.records[1].record.findings[0].id = 'x241';
  assert.throws(() => build(fx), /duplicate pid/);
});

test('a record directory that is not an S or N row throws', () => {
  const fx = fixture();
  fx.records.push(record('Q1', [finding({ id: 'q' })]));
  assert.throws(() => build(fx), /Q1/);
});

test('each finding carries its own classify result: a .tsx is mods-host, an .mjs is not blocked', () => {
  const rows = build().rows;
  assert.deepEqual([rows.find((r) => r.pid === 'x241').blocked, rows.find((r) => r.pid === 'x241').surface], ['mods-host', 'mods-entry']);
  assert.equal(rows.find((r) => r.pid === 's9a').blocked, null);
});

test('a .ps1 finding is blocked windows-only while another finding in the same row is not (per finding, not per row)', () => {
  const fx = fixture();
  fx.records[1].record.findings.push(finding({ file: 'scripts/start.ps1', startLine: 118, title: 'Logon task', id: 'ps' }));
  const rows = build(fx).rows.filter((r) => r.row === 'S9');
  assert.deepEqual(rows.map((r) => [r.pid, r.blocked]).sort(), [['ps', 'windows-only'], ['s9a', null]]);
});

test('readSource feeds the mods-host import check, and only for a ccv3-mods .ts file', () => {
  const fx = fixture();
  fx.records[0].record.findings.push(finding({ file: '.claude/plugins/ccv3-mods/hooks/pr-loop/slot.ts', startLine: 142, title: 'Slot', id: 'slot' }));
  const seen = [];
  const readSource = (head, file) => { seen.push(file); return "import { atom } from 'claude-code'"; };
  const rows = build(fx, { readSource }).rows;
  assert.equal(rows.find((r) => r.pid === 'slot').blocked, 'mods-host');
  assert.deepEqual(seen, ['.claude/plugins/ccv3-mods/hooks/pr-loop/slot.ts']);
});

test('rows are sorted A then B then C, by row number, then file and line (break: keep input order)', () => {
  const fx = fixture();
  fx.records.reverse();
  const rows = build(fx).rows;
  assert.deepEqual(rows.map((r) => r.group), ['A', 'B', 'C', 'C']);
  assert.deepEqual(rows.map((r) => r.pid), ['x241', 'n3a', 'x528', 's9a']);
});

test('the output is byte-identical for the same input in any record order (break: object key order or a timestamp)', () => {
  const a = fixture();
  const b = fixture();
  b.records.reverse();
  assert.equal(serializeProbeSet(build(a)), serializeProbeSet(build(b)));
  assert.ok(!/"ts"|generatedAt/.test(serializeProbeSet(build(a))));
  assert.ok(serializeProbeSet(build(a)).endsWith('\n'));
});

test('counts are listed by group, and by row inside group B', () => {
  const out = build();
  assert.deepEqual(out.counts.groups, { A: 1, B: 1, C: 2 });
  assert.deepEqual(out.counts.groupB, { N3: 1 });
  assert.equal(out.counts.total, 4);
});

// ---- the real baseline files (skipped when the cache is not on this machine) ----
const baselineDir = defaultBaselineDir();
const haveBaseline = existsSync(path.join(baselineDir, 'results.json'));

test('real baseline: 44 rows, A 6, B 16 with the per-row counts, C 22', { skip: !haveBaseline && 'trex-baseline cache not found' }, () => {
  const out = buildProbeSet(loadBaseline(baselineDir));
  assert.equal(out.rows.length, 44);
  assert.deepEqual(out.counts.groups, { A: 6, B: 16, C: 22 });
  assert.deepEqual(out.rows.filter((r) => r.group === 'A').map((r) => r.row).sort(), ['S1', 'S10', 'S11', 'S4', 'S5', 'S8']);
  assert.deepEqual(out.counts.groupB, { N11: 1, N12: 2, N13: 1, N14: 3, N15: 1, N16: 4, N3: 1, N7: 1, N9: 2 });
  assert.ok(out.rows.filter((r) => r.row.startsWith('S')).every((r) => /^[0-9a-f]{40}$/.test(r.fix)));
});

test('real baseline: the S15 .ps1 finding is windows-only and the other S15 and S12 findings are not blocked by host', { skip: !haveBaseline && 'trex-baseline cache not found' }, () => {
  const rows = buildProbeSet(loadBaseline(baselineDir)).rows;
  const ps = rows.find((r) => r.row === 'S15' && r.file === 'scripts/start-embedding-daemon.ps1');
  assert.equal(ps.startLine, 118);
  assert.equal(ps.blocked, 'windows-only');
  const s15 = rows.filter((r) => r.row === 'S15' && r !== ps);
  assert.equal(s15.length, 10);
  assert.deepEqual(s15.filter((r) => r.blocked), []);
  assert.equal(rows.find((r) => r.row === 'S12' && r.file === 'scripts/github/review-status.mjs' && r.startLine === 914).blocked, null);
});

test('real baseline: the committed probe-set.json equals a fresh build', { skip: !haveBaseline && 'trex-baseline cache not found' }, () => {
  const committed = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'probe-set.json');
  if (!existsSync(committed)) return;
  const data = loadBaseline(baselineDir);
  const readSource = gitReadSource(path.dirname(fileURLToPath(import.meta.url)));
  // The mods-host import check reads each cited .ts file from git. Without the head commits the output cannot match.
  if (readSource(data.records[0].record.head, 'package.json') === null) return;
  const fresh = serializeProbeSet(buildProbeSet(data, { readSource }));
  assert.equal(readFileSync(committed, 'utf8'), fresh);
});
