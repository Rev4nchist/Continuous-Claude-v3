// Tests for lib/zizmor-advisory.mjs. Run: node --test scripts/github/lib/zizmor-advisory.test.mjs
// zizmor never starts: the run call and the file checks are injected. The JSON shape is the real zizmor 1.32.0 output
// (findings have ident, determinations.severity, and locations with a Primary one: symbolic.key.Local.verbatim_path, concrete.location.start_point.row, 0-based).
//
// Failure modes, and the source change that makes each test fail:
//   Z1  no workflow file in the diff                  -> the advisory runs (or prints a line) for every change
//   Z2  the binary is missing                         -> the step fails or throws instead of a skip note
//   Z3  findings: counts by severity, top 3, args     -> counts or order are wrong, the exit code 14 is read as a failure, a non-workflow file is passed
//   Z4  zizmor crashes, times out or prints junk      -> any problem becomes a FAIL step (the advisory must never fail pre-pr)
//   Z5  the binary lookup                             -> env is ignored, or the version folders are sorted as text
//   Z6  a workflow file the branch deleted            -> zizmor is asked to read a file that is not there
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findZizmor, workflowFiles, zizmorAdvisory } from './zizmor-advisory.mjs';

const finding = (ident, severity, file, row) => ({
  ident, determinations: { severity },
  locations: [
    { symbolic: { kind: 'Hidden', key: { Local: { verbatim_path: file } } }, concrete: { location: { start_point: { row: 0, column: 0 } } } },
    { symbolic: { kind: 'Primary', key: { Local: { verbatim_path: file } } }, concrete: { location: { start_point: { row, column: 2 } } } },
  ],
});

function repoWith(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'zizmor-adv-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), 'name: x\n'); }
  return root;
}

test('Z1: no workflow file in the diff gives null and never runs zizmor', () => {
  const root = repoWith(['docs/a.md']);
  let ran = 0;
  assert.equal(zizmorAdvisory({ root, paths: ['docs/a.md', '.github/zizmor.yml', '.github/workflows/sub/x.yml'], bin: 'Z', run: () => { ran += 1; return {}; } }), null);
  assert.equal(ran, 0);
});

test('Z2: a missing binary is a NOTE that says it was skipped, and zizmor is not run', () => {
  const root = repoWith(['.github/workflows/a.yml']);
  let ran = 0;
  const r = zizmorAdvisory({ root, paths: ['.github/workflows/a.yml'], bin: null, run: () => { ran += 1; return {}; } });
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /skipped.*not found/i);
  assert.equal(ran, 0);
});

test('Z3: exit 14 is ignored; the line has counts by severity and the top 3 file:line items, worst first', () => {
  const root = repoWith(['.github/workflows/a.yml', '.github/workflows/b.yaml']);
  const out = JSON.stringify([
    finding('artipacked', 'Medium', '.github/workflows/a.yml', 4),
    finding('unpinned-uses', 'High', '.github/workflows/b.yaml', 9),
    finding('artipacked', 'Low', '.github/workflows/a.yml', 30),
    finding('unpinned-uses', 'High', '.github/workflows/a.yml', 7),
    finding('template-injection', 'Informational', '.github/workflows/a.yml', 1),
  ]);
  const calls = [];
  const r = zizmorAdvisory({ root, paths: ['.github/workflows/a.yml', '.github/workflows/b.yaml', 'README.md'], bin: 'ZBIN', run: (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 14, stdout: out, stderr: 'INFO log' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'ZBIN');
  assert.deepEqual(calls[0].args, ['--offline', '--format', 'json', '.github/workflows/a.yml', '.github/workflows/b.yaml']);
  assert.equal(calls[0].opts.cwd, root);
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /5 finding/);
  assert.match(r.detail, /2 High, 1 Medium, 1 Low, 1 Informational/);
  const top = /top: (.*)$/.exec(r.detail)[1];
  assert.deepEqual(top.split('; ').slice(0, 3).map((s) => s.split(' ')[0]), ['.github/workflows/a.yml:8', '.github/workflows/b.yaml:10', '.github/workflows/a.yml:5']);
  assert.match(r.detail, /advisory/i);
});

test('Z3b: zero findings is a NOTE that says so', () => {
  const root = repoWith(['.github/workflows/a.yml']);
  const r = zizmorAdvisory({ root, paths: ['.github/workflows/a.yml'], bin: 'Z', run: () => ({ status: 0, stdout: '[]', stderr: '' }) });
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /no findings/);
});

test('Z4: a crash, a time-out, a throw or junk output is a NOTE, never a FAIL', () => {
  const root = repoWith(['.github/workflows/a.yml']);
  const runs = [
    () => { throw new Error('boom'); },
    () => ({ status: null, stdout: '', stderr: '', error: 'spawn ENOENT' }),
    () => ({ status: null, stdout: '', stderr: '', timedOut: true }),
    () => ({ status: 1, stdout: 'not json', stderr: 'error: bad config' }),
    () => ({ status: 0, stdout: '{"not":"an array"}', stderr: '' }),
  ];
  for (const run of runs) {
    const r = zizmorAdvisory({ root, paths: ['.github/workflows/a.yml'], bin: 'Z', run });
    assert.equal(r.status, 'NOTE', JSON.stringify(r));
    assert.match(r.detail, /skipped|could not/i);
  }
});

test('Z5: findZizmor prefers CCV3_ZIZMOR, else the newest version folder under the home tools folder', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'zizmor-home-'));
  const base = path.join(home, 'tools', 'review-scanners', 'zizmor');
  for (const v of ['v1.9.0', 'v1.32.0', 'v1.10.1']) {
    mkdirSync(path.join(base, v, 'bin'), { recursive: true });
    writeFileSync(path.join(base, v, 'bin', 'zizmor.exe'), '');
  }
  assert.equal(findZizmor({ env: {}, home }), path.join(base, 'v1.32.0', 'bin', 'zizmor.exe'));
  const own = path.join(home, 'mine.exe');
  writeFileSync(own, '');
  assert.equal(findZizmor({ env: { CCV3_ZIZMOR: own }, home }), own);
  assert.equal(findZizmor({ env: {}, home: mkdtempSync(path.join(tmpdir(), 'zizmor-empty-')) }), null);
});

test('Z6: a workflow the branch deleted is not passed to zizmor; if none is left there is no advisory', () => {
  const root = repoWith(['.github/workflows/keep.yml']);
  assert.deepEqual(workflowFiles(['.github/workflows/keep.yml', '.github/workflows/gone.yml'], root), ['.github/workflows/keep.yml']);
  let ran = 0;
  assert.equal(zizmorAdvisory({ root, paths: ['.github/workflows/gone.yml'], bin: 'Z', run: () => { ran += 1; return {}; } }), null);
  assert.equal(ran, 0);
});
