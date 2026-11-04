// Tests for the pure parts of adversarial.mjs: fixture loading and checks, the verdict input wiring, the expectation match.
// The container run itself is the gate: `node scripts/trex/verify/adversarial.mjs` (needs Docker; artifact 2026-11-03-trex-verify-p0-adversarial.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES_DIR, countFixtureDirs, gateResult, loadFixtures, matchesExpected, uniqueTampered, validateFixture, verdictInputFor } from './adversarial.mjs';
import { buildFireMatch, verdict } from './verdict.mjs';

const fixtures = loadFixtures();
const byPrefix = (p) => fixtures.find((f) => f.id.startsWith(p));
const fire = { exitClass: 'assert-fail', failLine: 'not ok 1 - notice counts 2 outside-diff finding(s), want 0', normalizedOutput: 'x' };
const pass = { exitClass: 'pass', failLine: null, normalizedOutput: '' };
const ev = (o = {}) => ({ headRuns: [fire, fire], baseRun: null, baseReachable: true, cited: true, g9: null, tamper: false, citedPathExists: true, dockerOk: true, ...o });
const run = (prefix, evidence) => verdict(verdictInputFor(byPrefix(prefix), evidence));

test('there are 9 fixtures, each with a probe, a declare and a known expected verdict', () => {
  assert.equal(fixtures.length, 9);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, 9);
  for (const f of fixtures) assert.deepEqual(validateFixture(f), [], f.id);
});

// Breaks if: a fixture that claims to test a bad declare has a declare G2 accepts, or a good fixture has one G2 rejects.
test('only the .* fixture has a declare that G2 rejects', () => {
  for (const f of fixtures) {
    const m = buildFireMatch(f.declare);
    if (f.id.startsWith('03-')) assert.equal(m.ok, false, f.id);
    else assert.equal(m.ok, true, `${f.id}: ${m.detail}`);
  }
  assert.equal(buildFireMatch(byPrefix('03-').declare).reason, 'matches-empty');
});

test('the declared fireMatch of a fire fixture matches the line its probe prints', () => {
  for (const p of ['01-', '04-', '05-']) {
    const f = byPrefix(p);
    const printed = /console\.log\((`[^`]*`|'[^']*')/.exec(f.probe)[1].slice(1, -1).replace('${Math.random()}', '0.5');
    assert.match(printed, new RegExp(f.declare.fireMatch), f.id);
  }
});

test('validateFixture rejects the bad shapes', () => {
  const good = fixtures[0];
  const cases = [
    { ...good, id: 'X' }, { ...good, probe: ' ' }, { ...good, expected: { verdict: 'blocked:nonsense' } }, { ...good, expected: { verdict: 'maybe' } },
    { ...good, cited: { file: 'a', start: 0, end: 1 } }, { ...good, cited: { file: 'a', start: 5, end: 4 } }, { ...good, headRuns: 4 },
    { ...good, runBase: true, base: null }, { ...good, runFix: true, fix: null }, { ...good, g9: true, base: null }, { ...good, head: '' },
  ];
  for (const c of cases) assert.notDeepEqual(validateFixture(c), [], JSON.stringify(c).slice(0, 80));
});

test('matchesExpected needs the verdict and, when given, the rule', () => {
  assert.equal(matchesExpected({ verdict: 'refuted', rule: 'G4' }, { verdict: 'refuted', rule: 'G4' }), true);
  assert.equal(matchesExpected({ verdict: 'refuted', rule: 'path' }, { verdict: 'refuted', rule: 'G4' }), false);
  assert.equal(matchesExpected({ verdict: 'refuted', rule: 'x' }, { verdict: 'refuted' }), true);
  assert.equal(matchesExpected({ verdict: 'reproduced', rule: 'G4' }, { verdict: 'refuted', rule: 'G4' }), false);
  assert.equal(matchesExpected({ verdict: 'reproduced', rule: 'G4', false_confirm: true }, { verdict: 'reproduced', rule: 'G4', false_confirm: false }), false);
  assert.equal(matchesExpected({ verdict: 'reproduced', rule: 'G4', false_confirm: false }, { verdict: 'reproduced', rule: 'G4', false_confirm: false }), true);
});

// ---------- wiring: the evidence shape of each fixture reaches the verdict it expects ----------

test('wiring: tamper wins over a clean fire', () => {
  assert.equal(run('04-', ev({ tamper: true })).verdict, 'blocked:tamper');
});

test('wiring: an import error in both runs is blocked:broken-probe', () => {
  const broken = { exitClass: 'broken:import', failLine: null, normalizedOutput: 'x' };
  assert.equal(run('01-', ev({ headRuns: [broken, broken], cited: null })).verdict, 'blocked:broken-probe');
});

test('wiring: base that fires the same line refutes (cited lines ran, value observed), base that passes reproduces', () => {
  const line = 'not ok 1 - notice kind is null, want skipped';
  const heads = [{ ...fire, failLine: line }, { ...fire, failLine: line }];
  assert.equal(run('02-', ev({ baseRun: { ...fire, failLine: line }, headRuns: heads, observedValue: true })).verdict, 'refuted');
  assert.equal(run('09-', ev({ baseRun: pass })).verdict, 'reproduced');
});

// Fix 4. Breaks if: verdictInputFor drops observedValue, or a base fire refutes without G8 or without an observed value.
test('wiring: a base fire with no observed value or no cited-line coverage is blocked:broken-probe, not refuted', () => {
  const line = 'not ok 1 - notice kind is null, want skipped';
  const base = { baseRun: { ...fire, failLine: line }, headRuns: [{ ...fire, failLine: line }, { ...fire, failLine: line }] };
  assert.equal(verdictInputFor(byPrefix('02-'), ev({ observedValue: true })).observedValue, true);
  assert.equal(run('02-', ev({ ...base })).verdict, 'blocked:broken-probe');
  assert.equal(run('02-', ev({ ...base, observedValue: false })).verdict, 'blocked:broken-probe');
  assert.equal(run('02-', ev({ ...base, observedValue: true, cited: false })).verdict, 'blocked:broken-probe');
  assert.equal(run('02-', ev({ ...base, observedValue: true, cited: null })).verdict, 'blocked:broken-probe');
});

// Breaks if: the fix-side run never reaches verdict(), so a probe that also fires on the fixed code is not flagged.
test('wiring: a probe that fires at the fix SHA sets false_confirm, a clean fix does not', () => {
  assert.equal(run('09-', ev({ baseRun: pass, fixRun: pass })).false_confirm, false);
  assert.equal(run('09-', ev({ baseRun: pass, fixRun: fire })).false_confirm, true);
  assert.equal(run('09-', ev({ baseRun: pass, fixRun: fire })).verdict, 'reproduced');
});

test('wiring: random output that differs between two firing runs is blocked:disagree', () => {
  const a = { ...fire, failLine: 'not ok 1 - notice counts 0.11 outside-diff finding(s), want 0', normalizedOutput: 'a 0.11' };
  const b = { ...a, failLine: 'not ok 1 - notice counts 0.22 outside-diff finding(s), want 0', normalizedOutput: 'a 0.22' };
  assert.equal(run('05-', ev({ headRuns: [a, b] })).verdict, 'blocked:disagree');
});

test('wiring: zero runs is not_attempted', () => {
  assert.equal(run('06-', ev({ headRuns: [], cited: null })).verdict, 'not_attempted');
});

// Breaks if: coverage false and coverage null are read as "the lines ran".
test('wiring: a pass is not_reproduced only when the cited lines ran', () => {
  assert.equal(run('07-', ev({ headRuns: [pass, pass], cited: true })).verdict, 'not_reproduced');
  assert.equal(run('07-', ev({ headRuns: [pass, pass], cited: false })).verdict, 'blocked:no-coverage');
  assert.equal(run('07-', ev({ headRuns: [pass, pass], cited: null })).verdict, 'blocked:no-coverage');
});

test('wiring: base unreachable decides by G9, and an unconditional literal is unverified', () => {
  const lit = { ...fire, failLine: 'not ok 1 - wrong value ZETA-9001' };
  const unverified = ev({ headRuns: [lit, lit], baseReachable: false, g9: { observedValue: false, hunkRevertChanged: false } });
  assert.equal(run('08-', unverified).verdict, 'unverified');
  assert.equal(run('08-', ev({ headRuns: [lit, lit], baseReachable: false, g9: { observedValue: true, hunkRevertChanged: true } })).verdict, 'reproduced_new');
});

test('wiring: the base run is ignored when the base is not reachable', () => {
  const lit = { ...fire, failLine: 'not ok 1 - wrong value ZETA-9001' };
  const r = run('08-', ev({ headRuns: [lit, lit], baseReachable: false, baseRun: pass, g9: null }));
  assert.equal(r.verdict, 'unverified');
});

// ---------- the gate (critic fixes) ----------

const rowsOf = (n, ok = n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, ok: i < ok }));

// Breaks if: a full run with fewer than 9 rows (or a vacuous 0 of 0) passes the gate.
test('gate: a full run passes only with 9 rows, 9 fixture folders and all 9 ok', () => {
  assert.equal(gateResult(rowsOf(9), { folderCount: 9 }).pass, true);
  assert.equal(gateResult(rowsOf(9), { folderCount: 9 }).label, '9 of 9 expected');
  assert.equal(gateResult(rowsOf(0), { folderCount: 0 }).pass, false);
  assert.equal(gateResult(rowsOf(8), { folderCount: 8 }).pass, false);
  assert.equal(gateResult(rowsOf(10), { folderCount: 10 }).pass, false);
  assert.equal(gateResult(rowsOf(9, 8), { folderCount: 9 }).pass, false);
});

// Breaks if: rows and folders are compared to each other but not to 9, or the folder count is ignored (a fixture dropped silently).
test('gate: fewer rows than fixture folders fails and says why', () => {
  const g = gateResult(rowsOf(8), { folderCount: 9 });
  assert.equal(g.pass, false);
  assert.match(g.label, /8 rows for 9 fixture folders/);
});

// Breaks if: a --only run prints or claims the gate.
test('gate: an --only run is labelled non-gate and never passes the gate', () => {
  const g = gateResult(rowsOf(1), { folderCount: 9, only: '09-s9-correct-probe' });
  assert.equal(g.pass, false);
  assert.match(g.label, /^non-gate/);
  assert.doesNotMatch(g.label, /expected$/);
});

test('countFixtureDirs counts the real fixture folders and agrees with loadFixtures', () => {
  assert.equal(countFixtureDirs(FIXTURES_DIR), 9);
  assert.equal(countFixtureDirs(FIXTURES_DIR), loadFixtures().length);
});

// Breaks if: a file the probe touched in every head run is listed once per run.
test('uniqueTampered: a file changed in several runs is listed once, in first-seen order', () => {
  const runs = [{ tampered: ['a.mjs', 'b.mjs'] }, { tampered: ['b.mjs', 'a.mjs', 'c.mjs'] }, { tampered: [] }];
  assert.deepEqual(uniqueTampered(runs), ['a.mjs', 'b.mjs', 'c.mjs']);
});
