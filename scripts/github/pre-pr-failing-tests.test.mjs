// Tests for the failing-test names on a pre-pr FAIL line (card coord-prepr-failing-test-name).
// Run: node --test scripts/github/pre-pr-failing-tests.test.mjs
//
// Ways it can fail: the FAIL notes keep only the TAP counts, so no test is named (FT1); the log keeps the start of a long output and loses
// the failing line at its end (FT2); a vitest failure is not named (FT3); a SKIP, a TODO or a parent suite is named as a failure (FT4);
// a time-out or a crash with no failing line reads as silence (FT5); two failures in two files lose one or their order (FT6); a run with
// many failures floods the line (FT7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PRE from './pre-pr.mjs';

const { ALWAYS_GATES, SURFACES, runGate } = PRE;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const gateById = (id) => [...ALWAYS_GATES, ...SURFACES.flatMap((s) => s.gates ?? [])].find((g) => g.id === id);
const git0 = () => ({ status: 0, stdout: '', stderr: '' });
const execOut = (status, stdout) => () => ({ status, stdout, stderr: '', timedOut: false });
const gate = (id, exec) => runGate(gateById(id), { root: REPO_ROOT, exec, git: git0 });

// The TAP the node runner prints: a location line holds the absolute path, with each backslash doubled.
const tapLoc = (rel, line) => `  location: '${path.join(REPO_ROOT, rel).replace(/\\/g, '\\\\')}:${line}:3'`;
const tapPass = (n) => Array.from({ length: n }, (_, i) => `# Subtest: pass ${i}\nok ${i + 1} - pass ${i}\n  ---\n  duration_ms: 1.5\n  ...`).join('\n');
const tapFail = (name, rel, line, n = 1) => `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  duration_ms: 3.1\n  type: 'test'\n${tapLoc(rel, line)}\n  failureType: 'testCodeFailure'\n  error: 'Expected values to be strictly equal'\n  ...`;
const tapCounts = (fail) => `1..2028\n# tests 2028\n# suites 16\n# pass ${2028 - fail}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 353152.4`;
const failingNotes = (r) => r.notes.filter((n) => n.startsWith('failing: ') || n.startsWith('... ') || n === 'no failing test line found');

test('FT1: a 300 KB TAP output with one failure in the middle: the FAIL notes name the test and its file', () => {
  const out = `${tapPass(2000)}\n${tapFail('decisions: a stale tap is refused', 'scripts/github/decisions.test.mjs', 41)}\n${tapPass(2000)}\n${tapCounts(1)}\n`;
  assert.ok(out.length > 250_000, `output is ${out.length} characters`);
  const r = gate('github-tests', execOut(1, out));
  assert.equal(r.status, 'FAIL');
  assert.equal(r.detail, 'exit 1: # fail 1', 'the detail line is unchanged');
  assert.deepEqual(failingNotes(r), ['failing: decisions: a stale tap is refused (scripts/github/decisions.test.mjs:41)']);
  assert.ok(r.notes.includes('# fail 1'), 'the tail is kept after the names');
});

test('FT2: the log keeps the end of a gate output over the cap, with a marker that says how much was cut', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prepr-ft2-'));
  try {
    const out = `${'x'.repeat(300_000)}\nnot ok 9 - the line at the very end\n# fail 1\n`;
    const results = [{ step: 'gate:github-tests', status: 'FAIL', detail: 'exit 1: # fail 1', notes: [], output: out, command: 'node --test x' }];
    const file = PRE.writeLog({ root, now: new Date('2026-11-15T13:00:00Z'), head: 'a'.repeat(40), branch: 'b', base: 'main', bodySha: 'none', results, lines: ['FAIL gate:github-tests - exit 1: # fail 1'] });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /not ok 9 - the line at the very end/);
    assert.match(text, /\.\.\. 100\d{3} characters cut \.\.\./);
    assert.ok(text.length < 210_000, `log is ${text.length} characters`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FT3: a vitest failure line is named once, and a file-only FAIL line is not', () => {
  const out = [
    ' FAIL  src/__tests__/decision-gate.test.ts > R5 > F7b stays under the limit',
    'AssertionError: expected 1021 to be less than 1000',
    ' FAIL  src/__tests__/decision-gate.test.ts > R5 > F7b stays under the limit',
    ' FAIL  src/__tests__/broken-import.test.ts',
    ' Test Files  2 failed | 211 passed (213)',
    '      Tests  1 failed | 12313 passed (12314)',
  ].join('\n');
  assert.deepEqual(failingNotes(gate('hooks-vitest', execOut(1, out))), ['failing: R5 > F7b stays under the limit (src/__tests__/decision-gate.test.ts)']);
});

test('FT4: a SKIP, a TODO and a parent suite whose subtest failed are not named; the leaf is', () => {
  const out = [
    'not ok 4 - a todo fails # TODO', tapLoc('scripts/github/a.test.mjs', 5),
    'ok 3 - a skipped # SKIP',
    'not ok 6 - a skipped fail # SKIP', tapLoc('scripts/github/a.test.mjs', 8),
    '    # Subtest: b inner fails', '    not ok 1 - b inner fails', `  ${tapLoc('scripts/github/b.test.mjs', 2)}`,
    'not ok 5 - suite B', tapLoc('scripts/github/b.test.mjs', 2), "  failureType: 'subtestsFailed'", "  error: '1 subtest failed'",
    '# fail 1', '# todo 1',
  ].join('\n');
  assert.deepEqual(failingNotes(gate('github-tests', execOut(1, out))), ['failing: b inner fails (scripts/github/b.test.mjs:2)']);
});

test('FT5: a time-out, a crash and a failure with no failing line say "no failing test line found" and keep the tail', () => {
  const partial = `${tapPass(3)}\nnode:internal/process: worker crashed`;
  const timedOut = gate('github-tests', () => ({ status: null, stdout: partial, stderr: '', timedOut: true }));
  const crashed = gate('github-tests', execOut(1, partial));
  const noStart = gate('github-tests', () => ({ status: null, stdout: '', stderr: '', timedOut: false, error: 'spawn ENOENT' }));
  for (const r of [timedOut, crashed]) {
    assert.equal(r.status, 'FAIL');
    assert.deepEqual(failingNotes(r), ['no failing test line found']);
    assert.ok(r.notes.includes('node:internal/process: worker crashed'), `tail kept: ${r.notes.join(' | ')}`);
  }
  assert.deepEqual(failingNotes(noStart), ['no failing test line found']);
  const named = gate('github-tests', () => ({ status: null, stdout: `${tapFail('slow one', 'scripts/github/s.test.mjs', 7)}\n`, stderr: '', timedOut: true }));
  assert.deepEqual(failingNotes(named), ['failing: slow one (scripts/github/s.test.mjs:7)'], 'a time-out names a failure it saw');
});

test('FT6: two failures in two files are both named, in output order', () => {
  const out = `${tapFail('zeta breaks', 'scripts/github/z.test.mjs', 9, 1)}\n${tapPass(5)}\n${tapFail('alpha breaks', 'scripts/github/a.test.mjs', 3, 2)}\n${tapCounts(2)}`;
  assert.deepEqual(failingNotes(gate('github-tests', execOut(1, out))), [
    'failing: zeta breaks (scripts/github/z.test.mjs:9)',
    'failing: alpha breaks (scripts/github/a.test.mjs:3)',
  ]);
});

test('FT7: more than 10 failures name the first 10 and count the rest', () => {
  const out = Array.from({ length: 13 }, (_, i) => tapFail(`t${i}`, 'scripts/github/m.test.mjs', i + 1, i + 1)).join('\n');
  const names = failingNotes(gate('github-tests', execOut(1, out)));
  assert.equal(names.length, 11);
  assert.equal(names[0], 'failing: t0 (scripts/github/m.test.mjs:1)');
  assert.equal(names[10], '... 3 more failing tests');
});
