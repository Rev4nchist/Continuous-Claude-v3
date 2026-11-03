// Tests for rows.mjs. Each test imports the real functions. Git is a fake for the unit cases.
// The cases on the committed proofs-trex.json and negatives.json read real git history (read only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS } from './author.mjs';
import { loadNegatives, loadRows, validateNegatives, validateRows } from './rows.mjs';
import { makeTrexGit } from '../lib/git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const ROWS_FILE = path.join(HERE, 'proofs-trex.json');
const NEG_FILE = path.join(HERE, 'negatives.json');
const realGit = makeTrexGit(ROOT);
const hasFork = realGit(['rev-parse', '--verify', 'fork/main^{commit}']).status === 0;
const IDS = [...Array.from({ length: 15 }, (_, i) => `S${i + 1}`), 'S18'];
const PLACEHOLDER = '<frozen sha>';

const tmpFile = (t, name, text) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trex-rows-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
};

// A fake git: every sha exists and is an ancestor, unless listed.
const fakeGit = ({ missing = [], notAncestor = [] } = {}) => (args) => {
  const sha = String(args[2] ?? '').replace(/\^\{commit\}$/, '');
  if (args[0] === 'cat-file') return { status: missing.includes(sha) ? 1 : 0, stdout: '', stderr: '' };
  if (args[0] === 'merge-base') return { status: notAncestor.includes(args[2]) ? 1 : 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: 'unexpected' };
};

function goodRow(major = 'S1') {
  const group = major === 'S7' ? 'S6' : major;
  const g = GROUPS[group];
  return {
    major, check: 'trex', pre: g.pre, fix: g.fix, paths: ['.'],
    cmd: ['{node}', '{repo}/scripts/trex/run.mjs', '--simulate', 'tree', '--tree', '{tree}', '--config', PLACEHOLDER,
      '--flows-dir', `scripts/trex/bench/flows/${group}`, '--evidence', '{tree}/.trex-out'],
    fireMatch: '^not ok ', timeoutMs: 900000,
    bench: { kind: 'catch', group, authorRange: g.range, defectFiles: ['a/b.ts'], phase: 'P0' },
  };
}
const opts = { root: ROOT, ref: 'fork/main', only: null };
const withRow = (major, patch) => ({ ...goodRow(major), ...patch });
const check = (rows, git = fakeGit(), o = {}) => validateRows(git, rows, { ...opts, expect: rows.map((r) => r.major), ...o });
const has = (problems, re) => problems.some((p) => re.test(p));

// ---------- validateRows, fake git ----------

test('a well-formed row passes', () => {
  assert.deepEqual(check([goodRow('S1')]), []);
});

test('a frozen row with a 40-hex --config still passes', () => {
  const row = goodRow('S1');
  row.cmd[row.cmd.indexOf(PLACEHOLDER)] = 'a'.repeat(40);
  assert.deepEqual(check([row]), []);
});

test('--config that is neither the placeholder nor a sha is flagged', () => {
  const row = goodRow('S1');
  row.cmd[row.cmd.indexOf(PLACEHOLDER)] = 'main';
  assert.ok(has(check([row]), /--config/));
});

test('a row with no --config at all is flagged', () => {
  const row = goodRow('S1');
  row.cmd.splice(row.cmd.indexOf('--config'), 2);
  assert.ok(has(check([row]), /--config/));
});

test('an S16 row is refused', () => {
  const rows = [goodRow('S1'), withRow('S1', { major: 'S16' })];
  assert.ok(has(validateRows(fakeGit(), rows, { ...opts, expect: ['S1'] }), /S16/));
});

test('S7 on group S7 is refused, S7 on group S6 is accepted', () => {
  assert.deepEqual(check([goodRow('S7')]), []);
  const bad = goodRow('S7');
  bad.bench.group = 'S7';
  bad.cmd[bad.cmd.indexOf('--flows-dir') + 1] = 'scripts/trex/bench/flows/S7';
  assert.ok(has(check([bad]), /S7.*group|group.*S6/));
});

test('a flows-dir that does not match the group is flagged', () => {
  const row = goodRow('S1');
  row.cmd[row.cmd.indexOf('--flows-dir') + 1] = 'scripts/trex/bench/flows/S2';
  assert.ok(has(check([row]), /--flows-dir/));
});

test('a flows-dir that is not on disk is flagged', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trex-rows-empty-'));
  try {
    assert.ok(has(check([goodRow('S1')], fakeGit(), { root: dir }), /does not exist/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a copy field is refused', () => {
  assert.ok(has(check([withRow('S1', { copy: [] })]), /copy/));
});

test('pre or fix that differs from the author GROUPS is flagged', () => {
  assert.ok(has(check([withRow('S1', { pre: 'deadbeef' })]), /pre/));
  assert.ok(has(check([withRow('S1', { fix: 'deadbeef' })]), /fix/));
  const row = goodRow('S1');
  row.bench.authorRange = 'aaaa..bbbb';
  assert.ok(has(check([row]), /authorRange/));
});

test('a sha that git cannot find is flagged', () => {
  const g = GROUPS.S1;
  assert.ok(has(check([goodRow('S1')], fakeGit({ missing: [g.pre] })), /not found|does not exist in git/));
});

test('a pre or fix that is not an ancestor of the ref is flagged', () => {
  const g = GROUPS.S1;
  const problems = check([goodRow('S1')], fakeGit({ notAncestor: [g.fix] }));
  assert.ok(has(problems, /ancestor/));
});

test('empty defectFiles, a loose fireMatch and a short timeout are flagged', () => {
  const a = goodRow('S1'); a.bench.defectFiles = [];
  assert.ok(has(check([a]), /defectFiles/));
  assert.ok(has(check([withRow('S1', { fireMatch: 'not ok' })]), /fireMatch/));
  assert.ok(has(check([withRow('S1', { timeoutMs: 280000 })]), /timeoutMs/));
});

test('a missing expected row and a duplicate row are flagged', () => {
  const rows = [goodRow('S1'), goodRow('S1')];
  const problems = validateRows(fakeGit(), rows, { ...opts, expect: ['S1', 'S2'] });
  assert.ok(has(problems, /S2.*missing|missing.*S2/));
  assert.ok(has(problems, /duplicate/));
});

// ---------- loadRows, loadNegatives ----------

test('loadRows needs a rows array', (t) => {
  assert.throws(() => loadRows(tmpFile(t, 'r.json', '{"x":1}')), /rows/);
  assert.deepEqual(loadRows(tmpFile(t, 'r2.json', '{"rows":[{"major":"S1"}]}')), [{ major: 'S1' }]);
});

test('loadNegatives accepts a bare list and {negatives}, and rejects bad entries', (t) => {
  const one = '{"id":"N2","head":"b928c1f1"}';
  assert.equal(loadNegatives(tmpFile(t, 'a.json', `[${one}]`)).length, 1);
  assert.equal(loadNegatives(tmpFile(t, 'b.json', `{"negatives":[${one}]}`)).length, 1);
  assert.throws(() => loadNegatives(tmpFile(t, 'c.json', '{"negatives":[{"id":"N2"}]}')), /head/);
  assert.throws(() => loadNegatives(tmpFile(t, 'd.json', `[${one},${one}]`)), /duplicate/);
  assert.throws(() => loadNegatives(tmpFile(t, 'e.json', '[{"id":"N2","head":"b928c1f1","kind":"weird"}]')), /kind/);
});

// ---------- validateNegatives, fake flows and git ----------

const FLOWS = { S1: [{ id: 'f1', paths: ['src/a.ts'] }], S2: [{ id: 'f2', paths: ['src/b.ts'] }] };
const negGit = ({ changed = {}, ancestors = {}, unknown = [] } = {}) => (args) => {
  if (args[0] === 'diff') return { status: 0, stdout: (changed[args.at(-1)] ?? []).join('\n'), stderr: '' };
  if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
    return { status: (ancestors[args[3]] ?? []).includes(args[2]) ? 0 : 1, stdout: '', stderr: '' };
  }
  if (args[0] === 'cat-file') return { status: unknown.includes(args[2].replace(/\^\{commit\}$/, '')) ? 1 : 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: 'unexpected' };
};
const nopts = { flows: FLOWS, fixes: { S1: 'fix1', S2: 'fix2' }, minTested: 1, ref: 'fork/main' };

test('a negative with no clean group (fix not an ancestor) is flagged not_clean', () => {
  const git = negGit({ changed: { h1: ['src/a.ts'] }, ancestors: { h1: [] } });
  const problems = validateNegatives(git, [{ id: 'N20', head: 'h1' }], nopts);
  assert.ok(has(problems, /N20.*not_clean|N20.*clean/));
});

test('a negative whose fix is an ancestor is graded and passes', () => {
  const git = negGit({ changed: { h1: ['src/a.ts'] }, ancestors: { h1: ['fix1'], 'fork/main': ['h1'] } });
  assert.deepEqual(validateNegatives(git, [{ id: 'N20', head: 'h1' }], nopts), []);
});

test('fewer graded negatives than minTested is flagged', () => {
  const git = negGit({ changed: { h1: ['src/a.ts'] }, ancestors: { h1: ['fix1'], 'fork/main': ['h1'] } });
  const problems = validateNegatives(git, [{ id: 'N20', head: 'h1' }], { ...nopts, minTested: 2 });
  assert.ok(has(problems, /tested|graded/));
});

test('a skip negative that matches a flow is flagged; one with no match passes', () => {
  const git = negGit({ changed: { k1: ['src/a.ts'], k2: ['docs/x.md'] }, ancestors: { k1: ['fix1'], k2: [], 'fork/main': ['k1', 'k2', 'h1'] } });
  const hit = validateNegatives(git, [{ id: 'K1', head: 'k1', kind: 'skip' }], { ...nopts, minTested: 0 });
  assert.ok(has(hit, /K1/));
  const none = validateNegatives(git, [{ id: 'K2', head: 'k2', kind: 'skip' }], { ...nopts, minTested: 0 });
  assert.deepEqual(none, []);
});

test('a dropped id (N1, N4, N5) and a head that is not on the ref are flagged', () => {
  const git = negGit({ changed: { h1: ['src/a.ts'] }, ancestors: { h1: ['fix1'] } });
  assert.ok(has(validateNegatives(git, [{ id: 'N1', head: 'h1' }], { ...nopts, minTested: 0 }), /N1.*dropped/));
  assert.ok(has(validateNegatives(git, [{ id: 'N20', head: 'h1' }], nopts), /ancestor/));
});

// ---------- the committed files ----------

test('proofs-trex.json holds S1-S15 and S18 with the literal placeholder, and no S16', () => {
  assert.ok(existsSync(ROWS_FILE), 'proofs-trex.json is missing');
  const rows = loadRows(ROWS_FILE);
  assert.deepEqual(rows.map((r) => r.major), IDS);
  assert.ok(!rows.some((r) => r.major === 'S16'));
  for (const r of rows) {
    assert.equal(r.cmd.filter((x) => x === PLACEHOLDER).length, 1, `${r.major} placeholder`);
    assert.equal(r.cmd[r.cmd.indexOf('--config') + 1], PLACEHOLDER, `${r.major} --config`);
    assert.equal(r.copy, undefined, `${r.major} has copy`);
    assert.equal(r.fireMatch, '^not ok ');
    assert.equal(r.timeoutMs, 900000);
    assert.equal(r.bench.phase, 'P0');
    assert.ok(r.bench.defectFiles.length > 0, `${r.major} defectFiles`);
  }
});

test('S7 runs the S6 flows and shares the S6 pre, fix and range', () => {
  const byId = Object.fromEntries(loadRows(ROWS_FILE).map((r) => [r.major, r]));
  assert.equal(byId.S7.bench.group, 'S6');
  assert.equal(byId.S7.cmd[byId.S7.cmd.indexOf('--flows-dir') + 1], 'scripts/trex/bench/flows/S6');
  for (const k of ['pre', 'fix']) assert.equal(byId.S7[k], byId.S6[k]);
  assert.equal(byId.S7.bench.authorRange, byId.S6.bench.authorRange);
});

test('every row flows-dir exists and holds a flow', () => {
  for (const r of loadRows(ROWS_FILE)) {
    const dir = r.cmd[r.cmd.indexOf('--flows-dir') + 1];
    assert.ok(existsSync(path.join(ROOT, dir)), `${r.major}: ${dir}`);
  }
});

test('the committed rows pass validateRows against real git', { skip: !hasFork && 'fork/main is not fetched' }, () => {
  assert.deepEqual(validateRows(realGit, loadRows(ROWS_FILE), { root: ROOT, ref: 'fork/main' }), []);
});

test('negatives.json drops N1/N4/N5, keeps K1/K2 as skip and explains every entry', () => {
  const negs = loadNegatives(NEG_FILE);
  const ids = negs.map((n) => n.id);
  for (const gone of ['N1', 'N4', 'N5']) assert.ok(!ids.includes(gone), gone);
  for (const keep of ['N2', 'N3', 'N6', 'N7', 'N8', 'N9']) assert.ok(ids.includes(keep), keep);
  for (const k of ['K1', 'K2']) assert.equal(negs.find((n) => n.id === k)?.kind, 'skip');
  assert.ok(negs.filter((n) => n.kind !== 'skip').length >= 10);
  assert.ok(negs.every((n) => typeof n.why === 'string' && n.why.length > 20), 'a why is missing');
});

test('the committed negatives are clean and at least 10 are graded (real git, real flows)', { skip: !hasFork && 'fork/main is not fetched' }, () => {
  assert.deepEqual(validateNegatives(realGit, loadNegatives(NEG_FILE), { sha: 'HEAD', ref: 'fork/main', minTested: 10 }), []);
});
