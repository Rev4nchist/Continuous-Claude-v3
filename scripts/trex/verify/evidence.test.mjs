// Tests for evidence.mjs. They import the real functions and the real prove-check classifyRun behind runFromStep.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hunkRevertChanged, normalizeOutput, observedValue, runFromStep, tamperedFiles } from './evidence.mjs';
import { verdict } from './verdict.mjs';

const step = (o) => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

// ---------- runFromStep ----------

test('runFromStep: exit 0 with no failing line is a pass', () => {
  assert.deepEqual(runFromStep(step({ stdout: 'ok 1 - fine\n' })), { exitClass: 'pass', failLine: null, normalizedOutput: '' });
});

// Breaks if: a TAP line is not seen as a failing line, or the first one is not the failLine.
test('runFromStep: a not ok line is an assert-fail and keeps the value in the failLine', () => {
  const r = runFromStep(step({ code: 1, stdout: 'ok 1 - a\nnot ok 2 - count is 2, want 0\nnot ok 3 - other\n' }));
  assert.equal(r.exitClass, 'assert-fail');
  assert.equal(r.failLine, 'not ok 2 - count is 2, want 0');
});

// Breaks if: an import error is read as a fire, which is the exact false confirm G3 exists to stop.
test('runFromStep: a missing module is broken:import, never an assert-fail', () => {
  const r = runFromStep(step({ code: 1, stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/x.mjs'" }));
  assert.equal(r.exitClass, 'broken:import');
  assert.equal(r.failLine, null);
});

test('runFromStep: a syntax error is broken:compile', () => {
  assert.equal(runFromStep(step({ code: 1, stderr: 'SyntaxError: Unexpected token' })).exitClass, 'broken:compile');
});

test('runFromStep: a timeout is broken:timeout even when output holds a failing line', () => {
  assert.equal(runFromStep(step({ code: null, timedOut: true, stdout: 'not ok 1 - x\n' })).exitClass, 'broken:timeout');
});

test('runFromStep: a crash with no failing line is broken, not a fire', () => {
  const r = runFromStep(step({ code: 1, stderr: 'TypeError: x is not a function\n    at foo' }));
  assert.equal(r.exitClass, 'broken:error');
});

test('runFromStep: a null exit code is broken', () => {
  assert.match(runFromStep(step({ code: null })).exitClass, /^broken:/);
});

test('runFromStep: its Run feeds verdict() end to end', () => {
  const fail = runFromStep(step({ code: 1, stdout: 'not ok 1 - count is 2, want 0\n' }));
  const pass = runFromStep(step({ stdout: 'ok 1 - fine\n' }));
  const v = verdict({ declare: { fireMatch: 'count is [1-9]', correct: 'count is 0' }, declaredBeforeFirstRun: true, head: [fail, fail], base: pass, baseReachable: true, coverage: { citedLinesExecuted: true } });
  assert.equal(v.verdict, 'reproduced');
});

// ---------- normalizeOutput ----------

// Breaks if: a timestamp survives, so two identical runs read as disagreeing.
test('normalizeOutput: timestamps, uuids, durations, pids and ANSI codes go', () => {
  const a = normalizeOutput('\u001b[31mnot ok 1 - x at 2026-11-03T12:00:01.123Z in 12.5ms pid 4021 id 123e4567-e89b-12d3-a456-426614174000');
  const b = normalizeOutput('not ok 1 - x at 2026-11-03T12:09:59Z in 3ms pid 77 id 00000000-0000-0000-0000-000000000000');
  assert.equal(a, b);
});

// Breaks if: digits are stripped wholesale: a Math.random value would then read as stable and G6 would never fire.
test('normalizeOutput: a random number stays', () => {
  assert.notEqual(normalizeOutput('not ok 1 - got 0.8123456'), normalizeOutput('not ok 1 - got 0.1987654'));
});

test('normalizeOutput: blank lines and edge spaces go, nothing throws on null', () => {
  assert.equal(normalizeOutput('  a  \n\n  b\n'), 'a\nb');
  assert.equal(normalizeOutput(null), '');
});

// ---------- G9 ----------

test('observedValue: a value the app returned counts', () => {
  assert.equal(observedValue('not ok 1 - notice counts 2 outside-diff', 'counts [1-9]\\d* outside', 'console.log("not ok 1 - notice counts " + n + " outside-diff")'), true);
});

// Breaks if: a literal that sits in the probe source is accepted as an observed value (the unconditional failing assertion).
test('observedValue: text that is a literal of the probe source does not count', () => {
  assert.equal(observedValue('not ok 1 - wrong value ZETA-9001', 'wrong value ZETA-9001', "console.log('not ok 1 - wrong value ZETA-9001')"), false);
});

test('observedValue: no match, an empty match or a bad regex is false', () => {
  assert.equal(observedValue('not ok 1 - x', 'nomatch', ''), false);
  assert.equal(observedValue('x', '^', ''), false);
  assert.equal(observedValue('x', '(', ''), false);
  assert.equal(observedValue(null, 'a', ''), false);
});

test('hunkRevertChanged: only fail then pass counts', () => {
  const fail = { exitClass: 'assert-fail' };
  assert.equal(hunkRevertChanged(fail, { exitClass: 'pass' }), true);
  assert.equal(hunkRevertChanged(fail, { exitClass: 'assert-fail' }), false);
  assert.equal(hunkRevertChanged(fail, { exitClass: 'broken:import' }), false); // a deleted file makes the probe crash: no change of behaviour
  assert.equal(hunkRevertChanged({ exitClass: 'pass' }, { exitClass: 'pass' }), false);
  assert.equal(hunkRevertChanged(null, null), false);
});

// ---------- G5 ----------

test('tamperedFiles: only paths outside .verify/ count', () => {
  const out = ' M scripts/github/review-status.mjs\n?? .verify/\n?? .verify/x/probe.mjs\nR  a.mjs -> b.mjs\n';
  assert.deepEqual(tamperedFiles(out), ['scripts/github/review-status.mjs', 'a.mjs', 'b.mjs']);
  assert.deepEqual(tamperedFiles('?? .verify/\n'), []);
  assert.deepEqual(tamperedFiles(''), []);
  assert.deepEqual(tamperedFiles(null), []);
});

test('tamperedFiles: a path that only starts with the letters .verify is not the verify dir', () => {
  assert.deepEqual(tamperedFiles('?? .verifyx/a\n'), ['.verifyx/a']);
});

// ---------- oom class ----------

// Breaks if: the oom class is a bare /oom|137/ over the reason text, so any "137" or "oom" reads as out of memory.
test('runFromStep: exit 137 and a heap "out of memory" crash are broken:oom', () => {
  assert.equal(runFromStep(step({ code: 137 })).exitClass, 'broken:oom');
  const heap = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';
  assert.equal(runFromStep(step({ code: 134, stderr: heap })).exitClass, 'broken:oom');
});

test('runFromStep: an exit code or text that only contains 137 or "oom" is not broken:oom', () => {
  assert.equal(runFromStep(step({ code: 1137 })).exitClass, 'broken:error');
  assert.equal(runFromStep(step({ code: 1, stderr: 'line 137: the room is empty\n' })).exitClass, 'broken:error');
});
