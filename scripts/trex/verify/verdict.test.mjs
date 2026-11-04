// Tests for verdict.mjs: one test per verdict rule (design section 3) and one per failure class.
// They import the real functions. No I/O, no model, no docker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isMajorOpen } from '../../github/local-review/record.mjs';
import { SEVERITY_RANK } from '../../github/review-filter.mjs';
import { normalizeOutput } from './evidence.mjs';
import { BLOCK_REASONS, REFUTED_SEVERITY, VERDICTS, applyVerdict, buildFireMatch, verdict } from './verdict.mjs';

// ---- fixtures -------------------------------------------------------------------------------------------------

const DECLARE = { fireMatch: 'expected 5 got 3', correct: 'The total counts every item.' };
const FIRE_LINE = 'not ok 1 - total: expected 5 got 3';
const fire = (out = 'out-A') => ({ exitClass: 'assert-fail', failLine: FIRE_LINE, normalizedOutput: out });
const pass = (out = 'out-P') => ({ exitClass: 'pass', failLine: null, normalizedOutput: out });
const broken = (kind) => ({ exitClass: `broken:${kind}`, failLine: null, normalizedOutput: `boom ${kind}` });

/** A clean differential input: head fires twice, base passes, docker up, declare in place. */
const input = (over = {}) => ({
  declare: DECLARE,
  declaredBeforeFirstRun: true,
  head: [fire(), fire()],
  baseReachable: true,
  base: pass(),
  coverage: { citedLinesExecuted: true },
  g9: null,
  tamper: false,
  classifyBlock: null,
  dockerOk: true,
  ...over,
});

const V = (over) => verdict(input(over));

// ---- buildFireMatch (G2) --------------------------------------------------------------------------------------

test('G2: a good pattern builds a regex that matches the failing line', () => {
  const m = buildFireMatch(DECLARE);
  assert.equal(m.ok, true);
  assert.equal(m.re.test(FIRE_LINE), true);
  assert.equal(m.re.test('not ok 1 - total: expected 5 got 4'), false);
});

test('G2: the empty pattern is rejected (matches the empty string)', () => {
  const m = buildFireMatch({ fireMatch: '', correct: 'x' });
  assert.deepEqual([m.ok, m.reason], [false, 'matches-empty']);
});

test('G2: ".*" and other match-anything patterns are rejected', () => {
  for (const p of ['.*', '.+', '^.*$', '[\\s\\S]+', '\\w+', '(?:.*)', '.*?']) {
    const m = buildFireMatch({ fireMatch: p, correct: 'x' });
    assert.equal(m.ok, false, `pattern ${p} must be rejected`);
  }
});

test('G2: a pattern that can match the empty string is rejected even when it holds literals', () => {
  assert.equal(buildFireMatch({ fireMatch: 'abcdef|', correct: 'x' }).reason, 'matches-empty');
  assert.equal(buildFireMatch({ fireMatch: '(?!abcdef)', correct: 'x' }).reason, 'matches-empty');
});

test('G2: fewer than 4 literal characters is rejected, exactly 4 is accepted', () => {
  assert.equal(buildFireMatch({ fireMatch: 'abc', correct: 'x' }).reason, 'too-few-literals');
  assert.equal(buildFireMatch({ fireMatch: 'abc.*', correct: 'x' }).reason, 'too-few-literals');
  assert.equal(buildFireMatch({ fireMatch: 'abcd', correct: 'x' }).ok, true);
});

test('G2: literals count only on the shortest alternative', () => {
  assert.equal(buildFireMatch({ fireMatch: 'a|bcdefgh', correct: 'x' }).reason, 'too-few-literals');
  assert.equal(buildFireMatch({ fireMatch: '(?:ab|cdefg)h', correct: 'x' }).reason, 'too-few-literals', 'ab + h = 3');
  assert.equal(buildFireMatch({ fireMatch: '(?:ab|cdefg)hij', correct: 'x' }).ok, true, 'ab + hij = 5');
});

test('G2: class escapes and quantified literals do not count; escaped punctuation does', () => {
  assert.equal(buildFireMatch({ fireMatch: '\\d+\\s\\w+x*y?', correct: 'x' }).reason, 'too-few-literals');
  assert.equal(buildFireMatch({ fireMatch: 'a\\.b\\.c', correct: 'x' }).ok, true);
});

test('G2: spaces are not evidence', () => {
  assert.equal(buildFireMatch({ fireMatch: '     ', correct: 'x' }).reason, 'too-few-literals');
});

test('G2: an invalid regex, a missing declare and a non-string pattern never throw', () => {
  assert.equal(buildFireMatch({ fireMatch: '(', correct: 'x' }).reason, 'invalid-regex');
  assert.equal(buildFireMatch(null).reason, 'no-declare');
  assert.equal(buildFireMatch(undefined).reason, 'no-declare');
  assert.equal(buildFireMatch({ fireMatch: 42, correct: 'x' }).reason, 'no-pattern');
});

// ---- verdict: pre-run states ----------------------------------------------------------------------------------

test('G1: zero head runs gives not_attempted', () => {
  const r = V({ head: [] });
  assert.equal(r.verdict, 'not_attempted');
  assert.match(r.reason, /no head run/);
});

test('G1: no declare gives not_attempted, even with runs', () => {
  assert.equal(V({ declare: null }).verdict, 'not_attempted');
  assert.equal(V({ declare: undefined }).verdict, 'not_attempted');
});

test('G1: a declare with no correct-behaviour sentence gives not_attempted', () => {
  assert.equal(V({ declare: { fireMatch: 'expected 5 got 3', correct: '  ' } }).verdict, 'not_attempted');
});

test('G1: fewer head runs than minHeadRuns gives not_attempted; minHeadRuns:1 allows one run', () => {
  assert.equal(V({ head: [fire()] }).verdict, 'not_attempted');
  assert.equal(V({ head: [fire()], minHeadRuns: 1 }).verdict, 'reproduced');
});

test('G2: a declare written after the first run gives blocked:lint', () => {
  const r = V({ declaredBeforeFirstRun: false });
  assert.equal(r.verdict, 'blocked:lint');
  assert.match(r.reason, /after the first run/);
});

test('G2: a ".*" fireMatch gives blocked:lint, whatever the runs show', () => {
  const r = V({ declare: { fireMatch: '.*', correct: 'x' } });
  assert.equal(r.verdict, 'blocked:lint');
  assert.match(r.reason, /matches-empty/);
});

test('env-down: dockerOk false gives env-down, ahead of not_attempted', () => {
  assert.equal(V({ dockerOk: false, head: [] }).verdict, 'env-down');
  assert.equal(V({ dockerOk: false }).verdict, 'env-down');
});

test('env-down needs an explicit false: a missing dockerOk is not an outage', () => {
  const x = input();
  delete x.dockerOk;
  assert.equal(verdict(x).verdict, 'reproduced');
});

test('classifyBlock: a pre-run block wins and needs no run, no declare, no docker', () => {
  const r = V({ classifyBlock: 'windows-only', head: [], declare: null, dockerOk: false });
  assert.equal(r.verdict, 'blocked:windows-only');
});

test('classifyBlock: every reason in the fixed enum is accepted, with or without the "blocked:" prefix', () => {
  for (const reason of BLOCK_REASONS) {
    assert.equal(V({ classifyBlock: reason }).verdict, `blocked:${reason}`);
    assert.equal(V({ classifyBlock: `blocked:${reason}` }).verdict, `blocked:${reason}`);
  }
});

test('classifyBlock: the enum is the 15 reasons of design section 3', () => {
  assert.equal(BLOCK_REASONS.length, 15);
  assert.ok(VERDICTS.includes('env-down') && VERDICTS.includes('not_attempted'));
});

test('classifyBlock: a reason outside the enum throws', () => {
  assert.throws(() => V({ classifyBlock: 'because' }), /not in the blocked enum/);
});

test('refuted: a cited path that does not exist at head is refuted without a run', () => {
  const r = V({ citedPathExists: false, head: [], declare: null });
  assert.equal(r.verdict, 'refuted');
  assert.match(r.reason, /does not exist at head/);
});

// ---- verdict: G5, G3, G6 --------------------------------------------------------------------------------------

test('G5: tamper gives blocked:tamper even when head fires and base passes', () => {
  assert.equal(V({ tamper: true }).verdict, 'blocked:tamper');
});

test('G5: tamper outranks a broken run', () => {
  assert.equal(V({ tamper: true, head: [broken('import'), fire()] }).verdict, 'blocked:tamper');
});

for (const kind of ['import', 'compile', 'spawn', 'fixture', 'docker-125', 'oom', 'timeout']) {
  test(`G3: a ${kind} failure never fires: blocked:broken-probe`, () => {
    const r = V({ head: [broken(kind), broken(kind)] });
    assert.equal(r.verdict, 'blocked:broken-probe');
    assert.match(r.reason, new RegExp(kind));
  });
}

test('G3: one broken run among fires blocks, it does not read as disagree', () => {
  assert.equal(V({ head: [fire(), broken('timeout')] }).verdict, 'blocked:broken-probe');
});

test('G3: an unknown exit class is treated as broken, never as a pass or a fire', () => {
  assert.equal(V({ head: [{ exitClass: 'weird' }, { exitClass: 'weird' }] }).verdict, 'blocked:broken-probe');
});

test('G3: an assertion failure that does not match fireMatch is blocked:broken-probe, never not_reproduced', () => {
  const other = { exitClass: 'assert-fail', failLine: 'not ok 1 - something else', normalizedOutput: 'o' };
  const r = V({ head: [other, other] });
  assert.equal(r.verdict, 'blocked:broken-probe');
  assert.match(r.reason, /does not match/);
});

test('G3: an assert-fail with no failLine is not a fire', () => {
  const noLine = { exitClass: 'assert-fail', failLine: null };
  assert.equal(V({ head: [noLine, noLine] }).verdict, 'blocked:broken-probe');
});

test('G6: head runs that fire once and pass once give blocked:disagree', () => {
  assert.equal(V({ head: [fire(), pass()] }).verdict, 'blocked:disagree');
});

test('G6: runs that all fire but differ after normalisation give blocked:disagree', () => {
  assert.equal(V({ head: [fire('out-1'), fire('out-2')] }).verdict, 'blocked:disagree');
});

test('G6: runs without normalizedOutput are compared by outcome only', () => {
  const bare = { exitClass: 'assert-fail', failLine: FIRE_LINE };
  assert.equal(V({ head: [bare, bare] }).verdict, 'reproduced');
});

test('G6: three agreeing runs (phase 2) still agree', () => {
  assert.equal(V({ head: [fire(), fire(), fire()], minHeadRuns: 3 }).verdict, 'reproduced');
});

// ---- verdict: differential (G4) -------------------------------------------------------------------------------

test('reproduced: head fires on every run and base passes', () => {
  const r = V();
  assert.equal(r.verdict, 'reproduced');
  assert.equal(r.false_confirm, false);
});

test('refuted: base fires the same fireMatch, the cited lines ran and the fail line carries an observed value', () => {
  const r = V({ base: fire(), observedValue: true });
  assert.equal(r.verdict, 'refuted');
  assert.match(r.reason, /base/);
});

// Fix 4 (critic major 4). Breaks if: refuted from a base fire needs no G8 at head, or no G9(a) observed value on the fail line.
// A bad probe (off the cited path, or an unconditional fail line) fires the same line on both sides; it must not read as a refute.
test('Fix 4: base fires the same line but the cited lines are not shown as executed at head: blocked:broken-probe, not refuted', () => {
  for (const coverage of [{ citedLinesExecuted: false }, { citedLinesExecuted: null }, {}, undefined]) {
    const r = V({ base: fire(), observedValue: true, coverage });
    assert.equal(r.verdict, 'blocked:broken-probe', JSON.stringify(coverage));
    assert.equal(r.rule, 'G4');
  }
});

test('Fix 4: base fires the same line but the fail line carries no observed value: blocked:broken-probe, not refuted', () => {
  for (const observedValue of [false, undefined, null]) {
    const r = V({ base: fire(), observedValue });
    assert.equal(r.verdict, 'blocked:broken-probe', String(observedValue));
    assert.equal(r.rule, 'G4');
  }
});

// Breaks if: the new refuted guard is applied to the no-base-fire paths (reproduced needs no observedValue input).
test('Fix 4: reproduced does not need the observedValue input', () => {
  assert.equal(V({ base: pass() }).verdict, 'reproduced');
});

test('G4: a base that fails on a different line is not "base passes": blocked:broken-probe', () => {
  const r = V({ base: { exitClass: 'assert-fail', failLine: 'not ok 9 - elsewhere' } });
  assert.equal(r.verdict, 'blocked:broken-probe');
});

test('G4: a broken base run blocks, it never reads as reproduced', () => {
  assert.equal(V({ base: broken('import') }).verdict, 'blocked:broken-probe');
});

test('G4: base reachable but no base run is unverified, never reproduced', () => {
  assert.equal(V({ base: null }).verdict, 'unverified');
});

test('G4: baseReachable defaults to true', () => {
  const x = input({ base: null });
  delete x.baseReachable;
  assert.equal(verdict(x).verdict, 'unverified');
});

// ---- verdict: new code (G9) -----------------------------------------------------------------------------------

test('G9: base unreachable, observed value and hunk revert both pass: reproduced_new', () => {
  const r = V({ baseReachable: false, base: null, g9: { observedValue: true, hunkRevertChanged: true } });
  assert.equal(r.verdict, 'reproduced_new');
});

test('G9: observed value fails (declared literal in the probe): unverified', () => {
  const r = V({ baseReachable: false, base: null, g9: { observedValue: false, hunkRevertChanged: true } });
  assert.equal(r.verdict, 'unverified');
  assert.match(r.reason, /G9/);
});

test('G9: hunk revert does not change the outcome (unconditional fail): unverified', () => {
  const r = V({ baseReachable: false, base: null, g9: { observedValue: true, hunkRevertChanged: false } });
  assert.equal(r.verdict, 'unverified');
});

test('G9: no g9 result at all is unverified, never reproduced_new', () => {
  assert.equal(V({ baseReachable: false, base: null, g9: null }).verdict, 'unverified');
});

test('G9: g9 values must be exactly true, a truthy string does not pass', () => {
  const r = V({ baseReachable: false, base: null, g9: { observedValue: 'yes', hunkRevertChanged: 1 } });
  assert.equal(r.verdict, 'unverified');
});

// ---- verdict: head passes (G8) --------------------------------------------------------------------------------

test('not_reproduced: head passes on every run and the cited lines ran', () => {
  const r = V({ head: [pass(), pass()], base: pass() });
  assert.equal(r.verdict, 'not_reproduced');
});

test('G8: head passes but the cited lines did not run: blocked:no-coverage, never not_reproduced', () => {
  const r = V({ head: [pass(), pass()], coverage: { citedLinesExecuted: false } });
  assert.equal(r.verdict, 'blocked:no-coverage');
});

test('G8: head passes with no coverage data (null) is blocked:no-coverage', () => {
  assert.equal(V({ head: [pass(), pass()], coverage: { citedLinesExecuted: null } }).verdict, 'blocked:no-coverage');
  assert.equal(V({ head: [pass(), pass()], coverage: undefined }).verdict, 'blocked:no-coverage');
});

test('G8: not_reproduced does not need a base run', () => {
  assert.equal(V({ head: [pass(), pass()], base: null, baseReachable: false }).verdict, 'not_reproduced');
});

// ---- verdict: control arm and flags ---------------------------------------------------------------------------

test('control: a fix run that fires the same fireMatch sets false_confirm, the verdict stays', () => {
  const r = V({ fix: fire() });
  assert.equal(r.verdict, 'reproduced');
  assert.equal(r.false_confirm, true);
});

test('control: a fix run that passes leaves false_confirm false', () => {
  assert.equal(V({ fix: pass() }).false_confirm, false);
});

test('control: a fix run that fails on another line is not a false_confirm', () => {
  assert.equal(V({ fix: { exitClass: 'assert-fail', failLine: 'not ok 4 - other' } }).false_confirm, false);
});

test('result carries the rule and priorOpen', () => {
  assert.equal(V().rule, 'G4');
  assert.equal(V({ priorOpen: true }).priorOpen, true);
  assert.equal(V().priorOpen, false);
});

test('verdict never throws on empty or odd input', () => {
  for (const x of [undefined, null, {}, { head: 'no' }, { declare: 'no' }]) {
    const r = verdict(x);
    assert.ok(typeof r.verdict === 'string');
  }
});

test('every verdict the function returns is in the fixed list', () => {
  const samples = [
    V(), V({ base: fire() }), V({ head: [] }), V({ dockerOk: false }), V({ tamper: true }),
    V({ head: [pass(), pass()] }), V({ head: [pass(), pass()], coverage: { citedLinesExecuted: false } }),
    V({ baseReachable: false, base: null, g9: { observedValue: true, hunkRevertChanged: true } }),
    V({ baseReachable: false, base: null }),
  ];
  for (const r of samples) {
    const ok = VERDICTS.includes(r.verdict) || (r.verdict.startsWith('blocked:') && BLOCK_REASONS.includes(r.verdict.slice(8)));
    assert.ok(ok, `${r.verdict} is in the fixed list`);
  }
});

test('the input object is not mutated', () => {
  const x = input({ fix: pass() });
  const copy = structuredClone(x);
  verdict(x);
  assert.deepEqual(x, copy);
});

// ---- applyVerdict ---------------------------------------------------------------------------------------------

const finding = (over = {}) => ({
  id: 'f1', file: 'a.mjs', startLine: 10, title: 'wrong total', severity: 'major', confidence: 4, status: 'open', ...over,
});
const vr = (over = {}) => ({ verdict: 'reproduced', reason: 'because', priorOpen: false, ...over });

test('applyVerdict: not_reproduced sets severity minor and confidence 2', () => {
  const out = applyVerdict(finding(), vr({ verdict: 'not_reproduced' }));
  assert.equal(out.severity, 'minor');
  assert.equal(out.confidence, 2);
  assert.equal(out.status, 'open');
});

test('applyVerdict: a Critical at confidence 5 stops being a Major under isMajorOpen', () => {
  const f = finding({ severity: 'critical', confidence: 5 });
  assert.equal(isMajorOpen(f), true);
  assert.equal(isMajorOpen(applyVerdict(f, vr({ verdict: 'not_reproduced' }))), false);
});

test('applyVerdict: refuted sets severity trivial and confidence 1, and the finding is kept', () => {
  const out = applyVerdict(finding(), vr({ verdict: 'refuted' }));
  assert.equal(out.severity, 'trivial');
  assert.equal(out.confidence, 1);
  assert.equal(out.id, 'f1');
  assert.equal(isMajorOpen(out), false);
});

test('applyVerdict: reproduced, reproduced_new, unverified, blocked, env-down, not_attempted change nothing', () => {
  for (const v of ['reproduced', 'reproduced_new', 'unverified', 'blocked:tamper', 'blocked:no-coverage', 'env-down', 'not_attempted']) {
    const out = applyVerdict(finding(), vr({ verdict: v }));
    assert.equal(out.severity, 'major', v);
    assert.equal(out.confidence, 4, v);
  }
});

test('applyVerdict: never raises severity (a minor stays minor under reproduced; a trivial stays trivial)', () => {
  assert.equal(applyVerdict(finding({ severity: 'minor' }), vr({ verdict: 'reproduced' })).severity, 'minor');
  assert.equal(applyVerdict(finding({ severity: 'trivial' }), vr({ verdict: 'not_reproduced' })).severity, 'trivial');
  assert.equal(applyVerdict(finding({ severity: 'info' }), vr({ verdict: 'refuted' })).severity, 'info');
});

test('applyVerdict: never raises confidence (confidence 1 stays 1 under not_reproduced)', () => {
  assert.equal(applyVerdict(finding({ confidence: 1 }), vr({ verdict: 'not_reproduced' })).confidence, 1);
});

test('applyVerdict: a severity outside the schema (nit) is left alone under not_reproduced', () => {
  assert.equal(applyVerdict(finding({ severity: 'nit' }), vr({ verdict: 'not_reproduced' })).severity, 'nit');
});

test('applyVerdict: a missing confidence counts as 3 and is lowered to 2', () => {
  const f = finding();
  delete f.confidence;
  const out = applyVerdict(f, vr({ verdict: 'not_reproduced' }));
  assert.equal(out.confidence, 2);
  assert.equal(out.verify.originalConfidence, null);
});

test('applyVerdict: priorOpen holds the downgrade and the refute, and still attaches verify', () => {
  for (const v of ['not_reproduced', 'refuted']) {
    const out = applyVerdict(finding(), vr({ verdict: v, priorOpen: true }));
    assert.equal(out.severity, 'major', v);
    assert.equal(out.confidence, 4, v);
    assert.equal(out.verify.verdict, v);
    assert.equal(out.verify.held, true);
  }
});

test('applyVerdict: verify records verdict, reason and the original severity and confidence', () => {
  const out = applyVerdict(finding({ severity: 'critical', confidence: 5 }), vr({ verdict: 'not_reproduced', reason: 'cited lines ran' }));
  assert.deepEqual(out.verify, {
    verdict: 'not_reproduced', reason: 'cited lines ran', originalSeverity: 'critical', originalConfidence: 5, trust: null, held: false,
  });
});

test('applyVerdict: trust is differential for reproduced and new-code for reproduced_new', () => {
  assert.equal(applyVerdict(finding(), vr({ verdict: 'reproduced' })).verify.trust, 'differential');
  assert.equal(applyVerdict(finding(), vr({ verdict: 'reproduced_new' })).verify.trust, 'new-code');
});

test('applyVerdict: returns a new object and leaves the input untouched', () => {
  const f = Object.freeze(finding());
  const out = applyVerdict(f, vr({ verdict: 'refuted' }));
  assert.notEqual(out, f);
  assert.equal(f.severity, 'major');
  assert.equal(f.verify, undefined);
});

test('applyVerdict: applying twice keeps the first original severity and confidence', () => {
  const once = applyVerdict(finding(), vr({ verdict: 'not_reproduced' }));
  const twice = applyVerdict(once, vr({ verdict: 'refuted' }));
  assert.equal(twice.verify.originalSeverity, 'major');
  assert.equal(twice.verify.originalConfidence, 4);
});

test('applyVerdict: it accepts a verdict result straight from verdict()', () => {
  const r = V({ head: [pass(), pass()] });
  assert.equal(applyVerdict(finding(), r).severity, 'minor');
  const held = V({ head: [pass(), pass()], priorOpen: true });
  assert.equal(applyVerdict(finding(), held).severity, 'major');
});

// ---- critic fixes: fire needs coverage, refuted severity is a schema severity ------------------------------------

// Breaks if: stepHeadFires returns reproduced / reproduced_new without checking G8 (design row: reproduced needs G1-G8).
test('G8: head fires, base passes, cited lines not shown as executed: blocked:no-coverage, not reproduced', () => {
  for (const coverage of [{ citedLinesExecuted: false }, { citedLinesExecuted: null }, {}, undefined]) {
    const r = V({ coverage });
    assert.equal(r.verdict, 'blocked:no-coverage', JSON.stringify(coverage));
    assert.equal(r.rule, 'G8');
  }
  assert.equal(V({ coverage: { citedLinesExecuted: true } }).verdict, 'reproduced');
});

test('G8: new code that passes G9 but has no coverage is blocked:no-coverage, not reproduced_new', () => {
  const g9 = { observedValue: true, hunkRevertChanged: true };
  for (const coverage of [{ citedLinesExecuted: false }, { citedLinesExecuted: null }, undefined]) {
    assert.equal(V({ baseReachable: false, base: null, g9, coverage }).verdict, 'blocked:no-coverage', JSON.stringify(coverage));
  }
  assert.equal(V({ baseReachable: false, base: null, g9, coverage: { citedLinesExecuted: true } }).verdict, 'reproduced_new');
});

// Breaks if: the coverage gate is moved ahead of G4/G9 so refuted and unverified lose their verdict.
test('G8: a missing cited path (refuted) and unverified do not need coverage', () => {
  assert.equal(V({ citedPathExists: false, coverage: { citedLinesExecuted: false } }).verdict, 'refuted');
  assert.equal(V({ baseReachable: false, base: null, g9: { observedValue: false, hunkRevertChanged: false }, coverage: { citedLinesExecuted: null } }).verdict, 'unverified');
});

// Breaks if: REFUTED_SEVERITY is a word the review schema does not list (it was "nit").
test('REFUTED_SEVERITY is a severity of the review schema (review-filter SEVERITY_RANK)', () => {
  assert.ok(Object.hasOwn(SEVERITY_RANK, REFUTED_SEVERITY), `${REFUTED_SEVERITY} is not in SEVERITY_RANK`);
  assert.ok(SEVERITY_RANK[REFUTED_SEVERITY] > SEVERITY_RANK.unknown, 'refuted must not rank as unknown');
  assert.equal(applyVerdict(finding(), vr({ verdict: 'refuted' })).severity, REFUTED_SEVERITY);
});

// ---- same-line rule (S11 live smoke): base and fix count as "the same" only on the head's normalized fail line -------------

// The exact lines of the first live smoke (finding dd440119c9b87d61, row S11). The model added a second assertion; its
// not-ok line shares the declared fireMatch text but is a different assertion from the head's.
const S11_DECLARE = { fireMatch: '"coderabbit":false,"held":null,"source":"labels"', correct: 'Keep CodeRabbit required when the saved pathway is both.' };
const S11_HEAD_LINE = 'not ok 1 - {"greptile":false,"coderabbit":false,"held":null,"source":"labels","blockers":[]}';
const S11_OTHER_LINE = 'not ok 1 - {"greptile":true,"coderabbit":false,"held":null,"source":"labels"}';
const s11 = (line) => ({ exitClass: 'assert-fail', failLine: line, normalizedOutput: normalizeOutput(line) });
const S11 = (over) => verdict(input({ declare: S11_DECLARE, head: [s11(S11_HEAD_LINE), s11(S11_HEAD_LINE)], observedValue: true, ...over }));

// Breaks if: refutedByBase only checks that the base line matches fireMatch (the live S11 bug: major -> trivial on a real hit).
test('same-line: S11 base fails on a different assertion that also matches fireMatch: blocked:broken-probe, not refuted', () => {
  assert.equal(buildFireMatch(S11_DECLARE).re.test(S11_OTHER_LINE), true, 'precondition: the other line matches fireMatch');
  const r = S11({ base: s11(S11_OTHER_LINE) });
  assert.equal(r.verdict, 'blocked:broken-probe');
  assert.match(r.reason, /different line/);
});

// Breaks if: the same-line comparison rejects a base line that differs from head only in volatile tokens.
test('same-line: base fires the head line with only a volatile token different: still refuted', () => {
  const head = 'not ok 1 - took 12 ms {"coderabbit":false,"held":null,"source":"labels"}';
  const base = 'not ok 1 - took 340 ms {"coderabbit":false,"held":null,"source":"labels"}';
  const r = S11({ head: [s11(head), s11(head)], base: s11(base) });
  assert.equal(r.verdict, 'refuted');
});

test('same-line: base fires the identical head line with cited lines and observed value: still refuted', () => {
  assert.equal(S11({ base: s11(S11_HEAD_LINE) }).verdict, 'refuted');
});

test('same-line: a base line that differs and does not match fireMatch keeps the existing blocked:broken-probe', () => {
  assert.equal(S11({ base: s11('not ok 9 - elsewhere') }).verdict, 'blocked:broken-probe');
});

// Breaks if: false_confirm is set from the fireMatch alone (S11 fix run f1 failed on the other assertion).
test('same-line: S11 fix fails on another assertion that matches fireMatch: false_confirm false, fix_other_fail true', () => {
  const r = S11({ base: pass(), fix: s11(S11_OTHER_LINE) });
  assert.equal(r.verdict, 'reproduced');
  assert.equal(r.false_confirm, false);
  assert.equal(r.fix_other_fail, true);
});

test('same-line: fix fails on the head line: false_confirm true, fix_other_fail false', () => {
  const r = S11({ base: pass(), fix: s11(S11_HEAD_LINE) });
  assert.equal(r.false_confirm, true);
  assert.equal(r.fix_other_fail, false);
});

test('same-line: fix passes: neither flag is set', () => {
  const r = S11({ base: pass(), fix: pass() });
  assert.deepEqual([r.false_confirm, r.fix_other_fail], [false, false]);
});

test('same-line: no fix run: fix_other_fail is false', () => {
  assert.equal(S11({ base: pass() }).fix_other_fail, false);
});

// Breaks if: a broken fix run (docker, import) is reported as a probe defect.
test('same-line: a broken fix run is not fix_other_fail', () => {
  assert.equal(S11({ base: pass(), fix: broken('timeout') }).fix_other_fail, false);
});
