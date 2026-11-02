// Failure modes (P0 section 4 scorecard, F18).
//  p0-F18 unverified finding counted as real  -> count judge.verdict (or an unlabelled finding) as a label
//  strict recall vs lenient                   -> compare any severity for the strict bar
//  holdout and dev never mix                  -> count dev rows in holdout recall
//  a run with another promptSha256 leaves the holdout -> drop the prompt filter
//  PR false alarm: 0-Major PR with an engine major   -> count all PRs
//  judge agreement gate needs 30+ pairs and 80%      -> pass at n<30
//  every section-4 field is present
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRuns, scorecard } from './score.mjs';

const m = (key, pr, set, crSev, engSev, over = {}) => ({ key, pr, set, crSev, crVerdict: 'real', crSource: 'inline', engSev, ...over });
const run = (pr, set, findings, over = {}) => ({ set, pr, round: 1, status: 'ok', promptSha256: 'P0', durationMs: 1000, usage: { inputTokens: 10, outputTokens: 5 }, findings, ...over });
const sets = { holdoutPrs: [1, 2], devPrs: [9], zeroMajorPrs: [3] };
const base = { sets, frozenPromptSha256: 'P0' };

test('strict recall needs an engine critical/major; lenient accepts any match', () => {
  // Breaks when: the strict count uses "any match" (strict would equal lenient).
  const s = scorecard({ ...base, runs: [], labels: [], matches: [m('k1', 1, 'holdout', 'major', 'major'), m('k2', 2, 'holdout', 'major', 'minor'), m('k3', 2, 'holdout', 'major', null)] });
  assert.deepEqual([s.perMajorRecall.strict.found, s.perMajorRecall.strict.total], [1, 3]);
  assert.deepEqual([s.perMajorRecall.lenient.found, s.perMajorRecall.lenient.total], [2, 3]);
});

test('per-PR recall counts holdout PRs with a real Major and at least one strict match', () => {
  // Breaks when: a PR with only a lenient match counts as recalled.
  const s = scorecard({ ...base, runs: [], labels: [], matches: [m('k1', 1, 'holdout', 'major', 'major'), m('k2', 2, 'holdout', 'major', 'minor')] });
  assert.deepEqual([s.perPrRecall.found, s.perPrRecall.total], [1, 2]);
});

test('holdout and dev never mix', () => {
  // Breaks when: the holdout recall counts rows whose set is dev.
  const s = scorecard({ ...base, runs: [], labels: [], matches: [m('k1', 1, 'holdout', 'major', 'major'), m('d1', 9, 'dev', 'major', 'major'), m('d2', 9, 'dev', 'major', 'major')] });
  assert.equal(s.perMajorRecall.strict.total, 1);
  assert.equal(s.devRecall.strict.total, 2);
});

test('a holdout run with another promptSha256 leaves the holdout score', () => {
  // Breaks when: the frozen-prompt filter on holdout runs is dropped.
  const runs = [run(1, 'holdout', [{ id: 'a', sev: 'major', matchedKey: 'k1' }]), run(2, 'holdout', [{ id: 'b', sev: 'major', matchedKey: null }], { promptSha256: 'P1' })];
  const s = scorecard({ ...base, runs, labels: [], matches: [] });
  assert.equal(s.precision.posted, 1);
  assert.equal(s.excludedRuns, 1);
});

test('p0-F18 the precision numerator excludes unverified findings; the range shows both bounds', () => {
  // Breaks when: an unlabelled finding, or a judge verdict, is counted as real.
  const runs = [run(1, 'holdout', [{ id: 'a', sev: 'major', matchedKey: 'k1' }, { id: 'b', sev: 'minor' }, { id: 'c', sev: 'minor' }, { id: 'd', sev: 'minor', judgeVerdict: 'real' }])];
  const s = scorecard({ ...base, runs, labels: [], matches: [m('k1', 1, 'holdout', 'major', 'major')] });
  assert.deepEqual([s.precision.real, s.precision.unverified, s.precision.posted], [1, 3, 4]);
  assert.equal(s.precision.value, 0.25);
  assert.deepEqual(s.precision.range, [0.25, 1]);
});

test('a Dave label of real counts; a label by the judge does not; a noise label is noise', () => {
  // Breaks when: labels from any `by` are accepted, or noise is read as unverified.
  const runs = [run(1, 'holdout', [{ id: 'a', sev: 'minor' }, { id: 'b', sev: 'minor' }, { id: 'c', sev: 'minor' }])];
  const labels = [{ findingId: 'a', verdict: 'real', by: 'dave' }, { findingId: 'b', verdict: 'real', by: 'judge' }, { findingId: 'c', verdict: 'noise', by: 'dave' }];
  const s = scorecard({ ...base, runs, labels, matches: [] });
  assert.deepEqual([s.precision.real, s.precision.noise, s.precision.unverified], [1, 1, 1]);
});

test('PR false alarm: a 0-Major PR where the engine rated a finding major', () => {
  // Breaks when: PRs outside the zero-Major list are counted.
  const runs = [run(3, 'holdout', [{ id: 'a', sev: 'major' }]), run(1, 'holdout', [{ id: 'b', sev: 'major' }])];
  const s = scorecard({ ...base, runs, labels: [], matches: [] });
  assert.deepEqual([s.prFalseAlarm.count, s.prFalseAlarm.total], [1, 1]);
});

test('in-diff recall counts inline CR findings only; overall counts all', () => {
  // Breaks when: crSource is ignored.
  const s = scorecard({ ...base, runs: [], labels: [], matches: [m('k1', 1, 'holdout', 'major', 'major', { crSource: 'inline' }), m('k2', 2, 'holdout', 'major', null, { crSource: 'body' })] });
  assert.deepEqual([s.recall.inDiff.found, s.recall.inDiff.total, s.recall.overall.found, s.recall.overall.total], [1, 1, 1, 2]);
});

test('judge agreement gate: 80% on 30 or more pairs; fewer pairs never pass', () => {
  // Breaks when: the n >= 30 check is dropped.
  const mk = (n, agreeCount) => {
    const sent = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: 'real' } }));
    const labels = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, findingId: `p${i}`, verdict: i < agreeCount ? 'real' : 'noise', by: 'dave' }));
    return scorecard({ ...base, runs: [], matches: [], labels, pairsSent: sent });
  };
  assert.deepEqual([mk(30, 24).judgeAgreement.pass, mk(30, 23).judgeAgreement.pass, mk(10, 10).judgeAgreement.pass], [true, false, false]);
  assert.equal(mk(30, 24).judgeAgreement.value, 0.8);
});

test('cost sums grok runs and usage; the escape baseline and bake-off crosswalk carry through', () => {
  // Breaks when: cost ignores failed runs' duration or the escapes/bakeoff inputs are dropped.
  const runs = [run(1, 'holdout', []), run(2, 'holdout', [], { status: 'failed', durationMs: 500 })];
  const s = scorecard({ ...base, runs, labels: [], matches: [], escapes: { laterRound: 3, postMerge: 1 }, bakeoff: { k1: 'a', k2: 'b' }, headless: { runs: 4, costUsd: 0.5 } });
  assert.deepEqual([s.cost.grok.runs, s.cost.grok.durationMs], [2, 1500]);
  assert.deepEqual(s.escapeBaseline, { laterRound: 3, postMerge: 1 });
  assert.deepEqual(s.bakeoffCrosswalk.letters, ['a', 'b']);
  assert.equal(s.cost.headless.runs, 4);
});

test('every section-4 field is present', () => {
  // Breaks when: a field is dropped from the scorecard object.
  const s = scorecard({ ...base, runs: [], labels: [], matches: [] });
  for (const k of ['perMajorRecall', 'perPrRecall', 'prFalseAlarm', 'precision', 'recall', 'escapeBaseline', 'bakeoffCrosswalk', 'cost', 'judgeAgreement']) assert.ok(k in s, k);
  assert.ok('strict' in s.perMajorRecall && 'lenient' in s.perMajorRecall);
  assert.ok('inDiff' in s.recall && 'overall' in s.recall);
});

test('evaluateRuns maps an engine finding to the dataset finding on the same file and lines', () => {
  // Breaks when: the glue matches on the wrong sha, or drops the dataset verdict that precision reads.
  const dataset = [{ key: '7:1', pr: 7, sha40: 'a'.repeat(40), path: 'a.mjs', startLine: 10, endLine: 12, severity: 'Major', verdict: 'real', source: 'inline' }, { key: '7:2', pr: 7, sha40: 'b'.repeat(40), path: 'a.mjs', startLine: 10, endLine: 12, severity: 'Major', verdict: 'real', source: 'inline' }];
  const runs = [{ status: 'ok', set: 'holdout', pr: 7, round: 1, sha40: 'a'.repeat(40), findingsPath: 'x' }, { status: 'failed', set: 'holdout', pr: 7, round: 2, sha40: 'b'.repeat(40), findingsPath: 'y' }];
  const ev = evaluateRuns({ runs, dataset, readFindings: () => ({ findings: [{ file: 'a.mjs', line: 11, lineEnd: 11, severity: 'major', title: 't' }, { file: 'z.mjs', line: 1, severity: 'minor', title: 'u' }] }) });
  assert.equal(ev.runs.length, 1);
  assert.equal(ev.matches.length, 1);
  assert.deepEqual([ev.matches[0].key, ev.matches[0].engSev, ev.matches[0].crVerdict], ['7:1', 'major', 'real']);
  assert.deepEqual(ev.runs[0].findings.map((f) => f.matchedKey), ['7:1', null]);
});
