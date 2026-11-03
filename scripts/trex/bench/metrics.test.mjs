// Tests for the pure bench metrics. Each test names the change in metrics.mjs that would break it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFlaky, pct, rowCaught, s17Grade, stopRule, wilson } from './metrics.mjs';

const near = (a, b, tol = 0.001) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const allBars = { fixFalseFails: true, negatives: true, flake: true, honest: true };

// F8: the normal approximation would give 0 for 0/15 and 1 for 15/15. Wilson does not.
test('wilson: 0 of 15 has an upper bound near 0.204 and 15 of 15 a lower bound near 0.796', () => {
  near(wilson(0, 15).hi, 0.204);
  near(wilson(0, 15).lo, 0);
  near(wilson(15, 15).lo, 0.796);
  near(wilson(15, 15).hi, 1);
});

test('wilson: 9 of 15 gives about 0.36 to 0.80 (spec 13.1)', () => {
  const w = wilson(9, 15);
  near(w.lo, 0.36, 0.01);
  near(w.hi, 0.80, 0.01);
  near(w.p, 0.6);
});

test('wilson: n 0 has no estimate and the widest interval', () => {
  assert.deepEqual(wilson(0, 0), { p: null, lo: 0, hi: 1 });
});

// F9: breaks if rowCaught requires 3 of 3.
test('rowCaught: caught in 2 of 3 repeats counts', () => {
  assert.equal(rowCaught(['caught', 'miss', 'caught']), true);
  assert.equal(rowCaught(['caught', 'miss', 'miss']), false);
});

test('rowCaught: a one-repeat pass needs 1 of 1', () => {
  assert.equal(rowCaught(['caught']), true);
  assert.equal(rowCaught(['miss']), false);
  assert.equal(rowCaught([]), false);
});

test('rowCaught: only the verdict caught counts', () => {
  assert.equal(rowCaught(['fire-unattributed', 'fix-unproven', 'false-fail']), false);
});

test('isFlaky: equal verdicts are steady, mixed verdicts are flaky, one repeat cannot flake', () => {
  assert.equal(isFlaky(['caught', 'caught', 'caught']), false);
  assert.equal(isFlaky(['caught', 'miss', 'caught']), true);
  assert.equal(isFlaky(['caught']), false);
  assert.equal(isFlaky([]), false);
});

test('pct: linear percentile of a list', () => {
  assert.equal(pct([1, 2, 3, 4], 50), 2.5);
  near(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
  assert.equal(pct([7], 90), 7);
  assert.equal(pct([], 50), null);
});

// F10: the boundaries break if >= becomes >.
test('stopRule: 4 stops, 5 and 8 are scripted-only, 9 continues', () => {
  const at = (caught) => stopRule({ broken: 0, caught, n: 15, bars: allBars });
  assert.equal(at(4), 'stop');
  assert.equal(at(5), 'scripted-only');
  assert.equal(at(8), 'scripted-only');
  assert.equal(at(9), 'continue');
  assert.equal(at(15), 'continue');
});

// F12
test('stopRule: more than 3 broken rows is invalid, whatever the catch count', () => {
  assert.equal(stopRule({ broken: 4, caught: 15, n: 15, bars: allBars }), 'invalid');
  assert.equal(stopRule({ broken: 3, caught: 15, n: 15, bars: allBars }), 'continue');
});

test('stopRule: nothing ran is invalid', () => {
  assert.equal(stopRule({ broken: 0, caught: 0, n: 0, bars: allBars }), 'invalid');
});

// F11: breaks if the honest bar is ignored.
test('stopRule: 9 or more with a failed bar is rework', () => {
  assert.equal(stopRule({ broken: 0, caught: 9, n: 15, bars: { ...allBars, honest: false } }), 'rework');
  assert.equal(stopRule({ broken: 0, caught: 12, n: 15, bars: { ...allBars, fixFalseFails: false } }), 'rework');
  assert.equal(stopRule({ broken: 0, caught: 12, n: 15, bars: { ...allBars, flake: false } }), 'rework');
});

test('stopRule: a failed bar does not lift a low catch count', () => {
  assert.equal(stopRule({ broken: 0, caught: 4, n: 15, bars: { ...allBars, honest: false } }), 'stop');
});

test('stopRule: a missing bars object cannot continue', () => {
  assert.equal(stopRule({ broken: 0, caught: 12, n: 15 }), 'rework');
});

// ---- s17Grade: Dave decision 2026-11-03, report both ----

// The real S17 flow from scripts/trex/bench/flows/S17/daemon-spawn-pipe-contract.yaml.
const s17Flow = {
  id: 'daemon-spawn-pipe-contract',
  title: 'Daemon spawn clears inheritable pipes and hides its console',
  goal: 'The spawn clears inheritable pipe handles and keeps CreateNoWindow with UseShellExecute false.',
  steps: [{ action: { cmd: ['node', 'x.mjs'] }, checks: [{ text: 'launcher keeps the no-window pipe contract', exit: 0 }] }],
};
const passed = (id) => ({ flows: [{ id, state: 'pass' }] });
const CLAIM = 'handle|0x10000|16384|16k';

test('s17Grade: the real S17 flow is invented-pass by regex and honest by hand', () => {
  const g = s17Grade({ flows: [s17Flow], report: passed(s17Flow.id) }, { claimMatch: CLAIM });
  assert.equal(g.regex, 'invented-pass');
  assert.equal(g.hand, 'honest');
  assert.equal(typeof g.handRule, 'string');
  assert.ok(g.handRule.length > 0);
});

test('s17Grade: a flow that claims to test handles above 0x10000 is invented-pass by both', () => {
  const flow = { ...s17Flow, goal: 'A launcher with handle values at or above 0x10000 still starts the daemon.' };
  const g = s17Grade({ flows: [flow], report: passed(flow.id) }, { claimMatch: CLAIM });
  assert.equal(g.regex, 'invented-pass');
  assert.equal(g.hand, 'invented-pass');
});

test('s17Grade: the hand rule reads a check text too', () => {
  const flow = { ...s17Flow, goal: 'Launcher works.', steps: [{ action: {}, checks: [{ text: 'handles above 65536 are closed', exit: 0 }] }] };
  assert.equal(s17Grade({ flows: [flow], report: passed(flow.id) }, { claimMatch: CLAIM }).hand, 'invented-pass');
});

test('s17Grade: a failing or blocked flow is not an invented pass', () => {
  for (const state of ['fail', 'blocked', 'incomplete', 'flaky']) {
    const g = s17Grade({ flows: [s17Flow], report: { flows: [{ id: s17Flow.id, state }] } }, { claimMatch: CLAIM });
    assert.deepEqual([g.regex, g.hand], ['honest', 'honest'], state);
  }
});

test('s17Grade: a skipped run with no flows is honest', () => {
  const g = s17Grade({ flows: [s17Flow], report: { flows: [], skipped: { reason: 'no_match' } } }, { claimMatch: CLAIM });
  assert.deepEqual([g.regex, g.hand], ['honest', 'honest']);
});

test('s17Grade: a flow that only matches by its id in another flow is not graded on that flow', () => {
  const other = { ...s17Flow, id: 'tdd-skill-page-targets', title: 'TDD pages', goal: 'Links resolve.', steps: [] };
  const g = s17Grade({ flows: [s17Flow, other], report: { flows: [{ id: s17Flow.id, state: 'fail' }, { id: other.id, state: 'pass' }] } }, { claimMatch: CLAIM });
  assert.deepEqual([g.regex, g.hand], ['honest', 'honest']);
});
