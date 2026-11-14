// Failure modes (P0 section 4 scorecard, F18).
//  p0-F18 unverified finding counted as real  -> count judge.verdict (or an unlabelled finding) as a label
//  strict recall vs lenient                   -> compare any severity for the strict bar
//  holdout and dev never mix                  -> count dev rows in holdout recall
//  a run with another promptSha256 leaves the holdout -> drop the prompt filter
//  PR false alarm: 0-Major PR with an engine major   -> count all PRs
//  judge agreement gate needs 30+ pairs and 80%      -> pass at n<30
//  every section-4 field is present
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { wilson } from './bootstrap.mjs';
import { pairId } from './labels.mjs';
import { armKeyOf, evaluateRuns, joinReplicates, MIN_CELL, scorecard } from './score.mjs';

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

test('a holdout run with another promptSha256 leaves the holdout recall too', () => {
  // Breaks when: recall reads every match row and ignores the run's prompt hash (only precision filtered).
  const sha40 = 'd'.repeat(40);
  const dataset = [{ key: '5:1', pr: 5, sha40, path: 'a.mjs', startLine: 10, endLine: 10, severity: 'Major', verdict: 'real', source: 'inline' }];
  const runs = [
    { status: 'ok', set: 'holdout', pr: 5, round: 1, sha40, promptSha256: 'P0', findingsPath: 'none', ts: '2026-11-03T01:00:00Z' },
    { status: 'ok', set: 'holdout', pr: 5, round: 2, sha40, promptSha256: 'P1', findingsPath: 'hit', ts: '2026-11-03T02:00:00Z' },
  ];
  const read = (p) => ({ findings: p === 'hit' ? [{ file: 'a.mjs', line: 10, severity: 'major', title: 't' }] : [] });
  const ev = evaluateRuns({ runs, dataset, readFindings: read });
  const s = scorecard({ ...base, runs: ev.runs, matches: ev.matches, labels: [] });
  assert.deepEqual([s.perMajorRecall.strict.found, s.perMajorRecall.strict.total], [0, 1]);
  assert.deepEqual([s.perPrRecall.found, s.perPrRecall.total], [0, 1]);
});

test('evaluateRuns keeps only the newest row per (pr, round, sha40): a later ok replaces an earlier failure', () => {
  // Breaks when: repeat rows are not removed (two ok rows double the Major total) or the oldest row wins.
  const sha40 = 'e'.repeat(40);
  const dataset = [{ key: '6:1', pr: 6, sha40, path: 'a.mjs', startLine: 3, endLine: 3, severity: 'Major', verdict: 'real', source: 'inline' }];
  const row = (status, ts, findingsPath) => ({ status, set: 'holdout', pr: 6, round: 1, sha40, promptSha256: 'P0', findingsPath, ts });
  const read = (p) => ({ findings: p === 'hit' ? [{ file: 'a.mjs', line: 3, severity: 'major', title: 't' }] : [] });
  const twoOk = evaluateRuns({ runs: [row('ok', '2026-11-03T01:00:00Z', 'miss'), row('ok', '2026-11-03T02:00:00Z', 'hit')], dataset, readFindings: read });
  assert.equal(twoOk.runs.length, 1);
  assert.deepEqual(twoOk.matches.map((x) => x.engSev), ['major']);
  const failedThenOk = evaluateRuns({ runs: [row('failed', '2026-11-03T01:00:00Z', null), row('ok', '2026-11-03T02:00:00Z', 'hit')], dataset, readFindings: read });
  assert.deepEqual(failedThenOk.matches.map((x) => x.engSev), ['major']);
});

test('evaluateRuns: a failed newest row makes the round count as failed, even after an earlier ok', () => {
  // Breaks when: the ok filter runs before the newest-row pick, so a stale ok row survives a later failure.
  const sha40 = 'f'.repeat(40);
  const dataset = [{ key: '4:1', pr: 4, sha40, path: 'a.mjs', startLine: 3, endLine: 3, severity: 'Major', verdict: 'real', source: 'inline' }];
  const row = (status, ts) => ({ status, set: 'holdout', pr: 4, round: 1, sha40, promptSha256: 'P0', findingsPath: 'hit', ts });
  const read = () => ({ findings: [{ file: 'a.mjs', line: 3, severity: 'major', title: 't' }] });
  const ev = evaluateRuns({ runs: [row('ok', '2026-11-03T01:00:00Z'), row('failed', '2026-11-03T02:00:00Z')], dataset, readFindings: read });
  assert.equal(ev.runs.length, 0);
  assert.equal(ev.matches.length, 0);
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
    // A varying judge: a constant one has kappa 0 and cannot pass the gate (kappa test at the end).
    const judge = (i) => (i % 2 ? 'real' : 'noise');
    const sent = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: judge(i) } }));
    const labels = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, findingId: `p${i}`, verdict: i < agreeCount ? judge(i) : (judge(i) === 'real' ? 'noise' : 'real'), by: 'dave' }));
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

test('a claude label counts toward precision; precision.labelers says who decided each finding', () => {
  // Breaks when: precision reads only by:'dave' (claude-labelled findings stay unverified) or labelers is dropped.
  const runs = [run(1, 'holdout', [{ id: 'a', sev: 'minor' }, { id: 'b', sev: 'minor' }, { id: 'c', sev: 'minor' }, { id: 'e', sev: 'minor' }])];
  const labels = [{ findingId: 'a', verdict: 'real', by: 'claude' }, { findingId: 'b', verdict: 'noise', by: 'claude' }, { findingId: 'c', verdict: 'real', by: 'dave' }, { findingId: 'z', verdict: 'real', by: 'claude' }];
  const s = scorecard({ ...base, runs, labels, matches: [] });
  assert.deepEqual([s.precision.real, s.precision.noise, s.precision.unverified], [2, 1, 1]);
  assert.deepEqual(s.precision.labelers, { dave: 1, claude: 2 });
});

test('a dave label wins over a claude label on the same finding', () => {
  // Breaks when: the merged label map lets a model label overwrite Dave.
  const runs = [run(1, 'holdout', [{ id: 'a', sev: 'minor' }])];
  const s1 = scorecard({ ...base, runs, matches: [], labels: [{ findingId: 'a', verdict: 'noise', by: 'dave' }, { findingId: 'a', verdict: 'real', by: 'claude' }] });
  const s2 = scorecard({ ...base, runs, matches: [], labels: [{ findingId: 'a', verdict: 'real', by: 'claude' }, { findingId: 'a', verdict: 'noise', by: 'dave' }] });
  for (const s of [s1, s2]) {
    assert.equal(s.precision.noise, 1);
    assert.deepEqual(s.precision.labelers, { dave: 1, claude: 0 });
  }
});

test('judge agreement counts only Dave labels; claude labels never grade the judge', () => {
  // Breaks when: the agreement join accepts by:'claude' rows.
  const sent = [{ pairId: 'p1', judge: { verdict: 'real' } }, { pairId: 'p2', judge: { verdict: 'real' } }];
  const labels = [{ pairId: 'p1', findingId: 'p1', verdict: 'real', by: 'claude' }, { pairId: 'p2', findingId: 'p2', verdict: 'noise', by: 'dave' }];
  const s = scorecard({ ...base, runs: [], matches: [], labels, pairsSent: sent });
  assert.deepEqual([s.judgeAgreement.n, s.judgeAgreement.agree], [1, 0]);
});

test('strictSameIssue drops a strict line match whose pair is labelled sameIssue false; strict keeps it', () => {
  // Breaks when: strictSameIssue ignores the label, treats sameIssue null as false, or strict changes.
  const matches = [
    m('k1', 1, 'holdout', 'major', 'major', { engPairId: 'pa' }),
    m('k2', 2, 'holdout', 'major', 'major', { engPairId: 'pb' }),
    m('k3', 2, 'holdout', 'major', 'major', { engPairId: 'pc' }),
    m('k4', 2, 'holdout', 'major', null, { engPairId: null }),
  ];
  const labels = [{ pairId: 'pa', findingId: 'pa', verdict: 'real', sameIssue: false, by: 'claude' }, { pairId: 'pb', findingId: 'pb', verdict: 'real', sameIssue: null, by: 'claude' }];
  const s = scorecard({ ...base, runs: [], labels, matches });
  assert.deepEqual([s.perMajorRecall.strict.found, s.perMajorRecall.strict.total], [3, 4]);
  assert.deepEqual([s.perMajorRecall.strictSameIssue.found, s.perMajorRecall.strictSameIssue.total], [2, 4]);
  assert.equal(s.perMajorRecall.strictSameIssue.value, 0.5);
});

test('evaluateRuns puts the matched engine finding pairId on each match row', () => {
  // Breaks when: match rows lose engPairId, so no sameIssue label can reach strictSameIssue.
  const sha40 = 'a'.repeat(40);
  const dataset = [{ key: '7:1', pr: 7, sha40, path: 'a.mjs', startLine: 10, endLine: 12, severity: 'Major', verdict: 'real', source: 'inline' }, { key: '7:2', pr: 7, sha40, path: 'b.mjs', startLine: 1, endLine: 1, severity: 'Major', verdict: 'real', source: 'inline' }];
  const runs = [{ status: 'ok', set: 'holdout', pr: 7, round: 1, sha40, findingsPath: 'x' }];
  const ev = evaluateRuns({ runs, dataset, readFindings: () => ({ findings: [{ file: 'a.mjs', line: 11, severity: 'major', title: 't' }] }) });
  assert.deepEqual(ev.matches.map((x) => x.engPairId), [pairId({ pr: 7, sha: sha40, file: 'a.mjs', line: 11, engineTitle: 't' }), null]);
});

test('every section-4 field is present', () => {
  // Breaks when: a field is dropped from the scorecard object.
  const s = scorecard({ ...base, runs: [], labels: [], matches: [] });
  for (const k of ['perMajorRecall', 'perPrRecall', 'prFalseAlarm', 'precision', 'recall', 'escapeBaseline', 'bakeoffCrosswalk', 'cost', 'judgeAgreement']) assert.ok(k in s, k);
  assert.ok('strict' in s.perMajorRecall && 'lenient' in s.perMajorRecall && 'strictSameIssue' in s.perMajorRecall);
  assert.ok('labelers' in s.precision);
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

test('a Dave label ingested by pairId reaches the precision of the engine finding it names', () => {
  // Breaks when: scorecard looks labels up only by the engine id (pr-round-i), which ingestLabels never writes.
  const sha40 = 'c'.repeat(40);
  const runs = [{ status: 'ok', set: 'holdout', pr: 8, round: 1, sha40, promptSha256: 'P0', findingsPath: 'x' }];
  const found = [{ file: 'q.mjs', line: 5, severity: 'major', title: 'real one' }, { file: 'q.mjs', line: 90, severity: 'minor', title: 'noise one' }];
  const ev = evaluateRuns({ runs, dataset: [], readFindings: () => ({ findings: found }) });
  const idOf = (f) => pairId({ pr: 8, sha: sha40, file: f.file, line: f.line, engineTitle: f.title });
  const labels = [{ pairId: idOf(found[0]), findingId: idOf(found[0]), verdict: 'real', by: 'dave' }, { pairId: idOf(found[1]), findingId: idOf(found[1]), verdict: 'noise', by: 'dave' }];
  const s = scorecard({ ...base, runs: ev.runs, matches: ev.matches, labels });
  assert.deepEqual([s.precision.real, s.precision.noise, s.precision.unverified], [1, 1, 0]);
});

// ---------- phase 1: kappa note and per-class recall ----------

test('judge agreement prints n, raw agreement and kappa, and is a NOTE (never FAIL) below 30 labelled pairs, even at n=0 (breaks if a small n fails the run)', () => {
  const none = scorecard({ ...base, runs: [], matches: [], labels: [], pairsSent: [] }).judgeAgreement;
  assert.deepEqual([none.n, none.value, none.kappa, none.status, none.pass], [0, null, null, 'NOTE', false]);
  const sent = (n, judge) => Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: judge(i) } }));
  const lab = (n, verdict) => Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, verdict: verdict(i), by: 'dave' }));
  const verdicts = (i) => (i % 2 ? 'real' : 'noise');
  const small = scorecard({ ...base, runs: [], matches: [], labels: lab(10, verdicts), pairsSent: sent(10, verdicts) }).judgeAgreement;
  assert.deepEqual([small.n, small.value, small.kappa, small.status], [10, 1, 1, 'NOTE']);
});

test('judge agreement at 30 or more pairs is PASS at 80% raw agreement and FAIL below it (breaks if the gate stops deciding at n=30)', () => {
  // A judge that varies (kappa 0.6 at 24 of 30): a constant judge has kappa 0 and no longer passes (see the kappa test at the end).
  const judge = (i) => (i % 2 ? 'real' : 'noise');
  const sent = Array.from({ length: 30 }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: judge(i) } }));
  const labels = (agree) => Array.from({ length: 30 }, (_, i) => ({ pairId: `p${i}`, verdict: i < agree ? judge(i) : (judge(i) === 'real' ? 'noise' : 'real'), by: 'dave' }));
  assert.equal(scorecard({ ...base, runs: [], matches: [], labels: labels(24), pairsSent: sent }).judgeAgreement.status, 'PASS');
  assert.equal(scorecard({ ...base, runs: [], matches: [], labels: labels(23), pairsSent: sent }).judgeAgreement.status, 'FAIL');
});

test('perClassRecall gives same-issue recall for each link class from linkTypes, and counts a key with no class as unlabelled (breaks if the class lookup or the same-issue rule is skipped)', () => {
  const matches = [
    m('k1', 1, 'holdout', 'major', 'major', { engPairId: 'pa' }), m('k2', 1, 'holdout', 'major', null),
    m('k3', 2, 'holdout', 'major', 'major', { engPairId: 'pb' }), m('k4', 2, 'holdout', 'major', 'major', { engPairId: 'pc' }),
    m('d1', 9, 'dev', 'major', null), m('d2', 9, 'dev', 'minor', 'minor'),
  ];
  const labels = [{ findingId: 'pb', pairId: 'pb', verdict: 'real', sameIssue: false, by: 'claude' }];
  const linkTypes = { k1: 'within-hunk', k2: 'within-hunk', k3: 'same-file', d1: 'cross-file-dynamic' };
  const s = scorecard({ ...base, runs: [], matches, labels, linkTypes });
  const h = s.perClassRecall.holdout;
  assert.deepEqual([h['within-hunk'].found, h['within-hunk'].total], [1, 2]);
  assert.deepEqual([h['same-file'].found, h['same-file'].total], [0, 1], 'k3 is a line match the label calls a different issue');
  assert.deepEqual([h.unlabelled.found, h.unlabelled.total], [1, 1]);
  assert.deepEqual([s.perClassRecall.dev['cross-file-dynamic'].found, s.perClassRecall.dev['cross-file-dynamic'].total], [0, 1]);
  assert.deepEqual(Object.keys(h).sort(), ['same-file', 'unlabelled', 'within-hunk']);
  assert.deepEqual(Object.keys(s.perClassRecall.dev), ['cross-file-dynamic'], 'a minor CodeRabbit finding with no class is not a Major: it adds no row');
});

// ---------- phase 1 bridge: funnel totals and the withdrawn list ----------

test('evaluateRuns marks a missed Major as inWithdrawn when the reviewer withdrew a finding near it in the same file; a run with no withdrawn data gives null (breaks if the file or the line slack is ignored)', () => {
  const sha40 = 'a'.repeat(40);
  const ds = (key, file, start, end) => ({ key, pr: 7, sha40, path: file, startLine: start, endLine: end, severity: 'Major', verdict: 'real', source: 'inline' });
  const dataset = [ds('7:1', 'a.mjs', 10, 12), ds('7:2', 'b.mjs', 50, 50), ds('7:3', 'c.mjs', null, null), ds('7:4', 'd.mjs', 5, 5)];
  const runs = [{ status: 'ok', set: 'holdout', pr: 7, round: 1, sha40, findingsPath: 'x' }];
  const withdrawn = [{ id: 'w1', path: 'a.mjs', line: 14, severity: 'major' }, { id: 'w2', path: 'b.mjs', line: 90, severity: 'major' }, { id: 'w3', path: 'c.mjs', line: 7, severity: 'minor' }];
  const ev = evaluateRuns({ runs, dataset, readFindings: () => ({ findings: [], withdrawn }) });
  const by = Object.fromEntries(ev.matches.map((m) => [m.key, m.inWithdrawn]));
  assert.deepEqual(by, { '7:1': true, '7:2': false, '7:3': true, '7:4': false });
  const old = evaluateRuns({ runs, dataset, readFindings: () => ({ findings: [] }) });
  assert.ok(old.matches.every((x) => x.inWithdrawn === null));
});

test('scorecard sums the funnel of the valid runs and counts the holdout misses that the reviewer withdrew (breaks if a count reads the wrong field or a run with another prompt hash is summed)', () => {
  const f = (raw, withdrawn, byReason, posted) => ({ raw, withdrawn, dropped: { byReason }, posted });
  const runs = [
    run(1, 'holdout', [], { funnel: f(3, 2, { 'no-file': 1 }, 2) }), run(2, 'holdout', [], { funnel: f(1, 4, { duplicate: 1, 'no-file': 2 }, 0) }),
    run(2, 'holdout', [], { promptSha256: 'OTHER', funnel: f(99, 99, {}, 99) }), run(9, 'dev', []),
  ];
  const matches = [
    m('k1', 1, 'holdout', 'major', 'major', { inWithdrawn: null }), m('k2', 1, 'holdout', 'major', null, { inWithdrawn: true }),
    m('k3', 2, 'holdout', 'major', null, { inWithdrawn: false }), m('k4', 2, 'holdout', 'major', null, { inWithdrawn: true }), m('k5', 2, 'holdout', 'major', null, { inWithdrawn: null }),
  ];
  const s = scorecard({ ...base, runs, matches, labels: [] });
  assert.deepEqual(s.funnel, { runs: 2, raw: 4, withdrawn: 6, dropped: { total: 4, byReason: { 'no-file': 3, duplicate: 1 } }, posted: 2 });
  assert.deepEqual(s.withdrawnMisses, { misses: 4, inWithdrawn: 2, noData: 1 });
});

// ---------- review-engine p1 fixes ----------

const SHA = 'a'.repeat(40);
const majorAt = (key, file = 'a.mjs', line = 10) => ({ key, pr: 7, sha40: SHA, path: file, startLine: line, endLine: line, severity: 'Major', verdict: 'real', source: 'inline' });
const okRun = (over = {}) => ({ status: 'ok', set: 'holdout', pr: 7, round: 1, sha40: SHA, promptSha256: 'P0', findingsPath: 'x', ...over });

test('a run with coverageComplete false is excluded from recall and counted in excludedRuns; coverageComplete true or absent still scores (breaks if an incomplete run turns its Majors into misses)', () => {
  const dataset = [majorAt('7:1')];
  const hit = () => ({ findings: [{ file: 'a.mjs', line: 10, severity: 'major', title: 't' }] });
  const score = (over) => {
    const ev = evaluateRuns({ runs: [okRun(over)], dataset, readFindings: hit });
    return scorecard({ ...base, runs: ev.runs, matches: ev.matches, labels: [] });
  };
  const incomplete = score({ coverageComplete: false });
  assert.equal(incomplete.perMajorRecall.strict.total, 0);
  assert.equal(incomplete.excludedRuns, 1);
  // A new row from engine-run says status incomplete, and replay writes coverageComplete null when the record has no coverage object.
  const fresh = score({ status: 'incomplete', coverageComplete: null });
  assert.deepEqual([fresh.perMajorRecall.strict.total, fresh.excludedRuns], [0, 1]);
  for (const coverageComplete of [true, null, undefined]) {
    const card = score({ coverageComplete });
    assert.deepEqual([card.perMajorRecall.strict.found, card.perMajorRecall.strict.total, card.excludedRuns], [1, 1, 0], String(coverageComplete));
  }
});

test('nearWithdrawn compares normalised paths: ./a.mjs and a\\b.mjs match a.mjs and a/b.mjs (breaks if the withdrawn path is compared raw)', () => {
  const dataset = [majorAt('7:1', 'a.mjs', 10), majorAt('7:2', 'a/b.mjs', 20)];
  const withdrawn = [{ id: 'w1', path: './a.mjs', line: 10 }, { id: 'w2', path: 'a\\b.mjs', line: 20 }];
  const ev = evaluateRuns({ runs: [okRun()], dataset, readFindings: () => ({ findings: [], withdrawn }) });
  assert.deepEqual(ev.matches.map((x) => [x.key, x.inWithdrawn]), [['7:1', true], ['7:2', true]]);
});

test('a holdout run with bodyMode full leaves the holdout score and counts as excluded; dev, withheld and no-bodyMode rows keep scoring; bodyModes counts every run (breaks if the PR-body leak scores as recall)', () => {
  const dataset = [majorAt('7:1')];
  const hit = () => ({ findings: [{ file: 'a.mjs', line: 10, severity: 'major', title: 't' }] });
  const score = (runs) => {
    const ev = evaluateRuns({ runs, dataset, readFindings: hit });
    return scorecard({ ...base, runs: ev.runs, matches: ev.matches, labels: [] });
  };
  const full = score([okRun({ bodyMode: 'full' })]);
  assert.equal(full.perMajorRecall.strict.total, 0);
  assert.equal(full.excludedRuns, 1);
  assert.deepEqual(full.bodyModes, { withheld: 0, full: 1, unknown: 0 });
  assert.equal(score([okRun({ bodyMode: 'withheld' })]).perMajorRecall.strict.found, 1);
  const old = score([okRun()]);
  assert.equal(old.perMajorRecall.strict.found, 1);
  assert.deepEqual(old.bodyModes, { withheld: 0, full: 0, unknown: 1 });
  const dev = score([okRun({ set: 'dev', bodyMode: 'full' })]);
  assert.equal(dev.devRecall.strict.found, 1);
});

test('the judge gate needs kappa of 0.6 or more as well as 80% raw agreement; null kappa never passes; below 30 pairs it stays a NOTE (breaks if raw agreement alone passes)', () => {
  const gate = (n, judgeOf, labelOf) => {
    const sent = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: judgeOf(i) } }));
    const labels = Array.from({ length: n }, (_, i) => ({ pairId: `p${i}`, verdict: labelOf(i), by: 'dave' }));
    return scorecard({ ...base, runs: [], matches: [], labels, pairsSent: sent }).judgeAgreement;
  };
  const constant = gate(30, () => 'real', (i) => (i < 24 ? 'real' : 'noise'));
  assert.deepEqual([constant.value, constant.kappa, constant.status, constant.pass], [0.8, 0, 'FAIL', false], 'a judge that always says real has 80% raw agreement and kappa 0');
  const nullKappa = gate(30, () => 'real', () => 'real');
  assert.deepEqual([nullKappa.value, nullKappa.kappa, nullKappa.status], [1, null, 'FAIL'], 'both raters use one class: kappa is undefined, no PASS');
  const good = gate(30, (i) => (i % 2 ? 'real' : 'noise'), (i) => (i < 27 ? (i % 2 ? 'real' : 'noise') : (i % 2 ? 'noise' : 'real')));
  assert.equal(good.status, 'PASS');
  assert.equal(gate(10, () => 'real', () => 'real').status, 'NOTE');
});


// ---------- re-score-paired step 1: arm key and dedupe (the two-arm dedupe fault) ----------

const sha9 = '9'.repeat(40);
const dsMajor = (key, pr, over = {}) => ({ key, pr, sha40: sha9, path: 'a.mjs', startLine: 10, endLine: 10, severity: 'Major', verdict: 'real', source: 'inline', ...over });
const armRow = (pr, over = {}) => ({ status: 'ok', set: 'holdout', pr, round: 1, sha40: sha9, promptSha256: 'P0', findingsPath: 'hit', ts: '2026-11-03T01:00:00Z', ...over });
const hitRead = (p) => ({ findings: p === 'hit' ? [{ file: 'a.mjs', line: 10, severity: 'major', title: 't' }] : [] });

test('an engine row and a cursor-review row on one round both survive evaluateRuns, with a match row for each arm (breaks if newestPerRound drops the arm from its key)', () => {
  const rows = [armRow(9001, { reviewer: 'engine', ts: '2026-11-03T01:00:00Z' }), armRow(9001, { reviewer: 'cursor-review', ts: '2026-11-03T02:00:00Z' })];
  const ev = evaluateRuns({ runs: rows, dataset: [dsMajor('9001:1', 9001)], readFindings: hitRead });
  assert.equal(ev.runs.length, 2);
  assert.deepEqual(ev.matches.map((x) => x.reviewer).sort(), ['cursor-review', 'engine']);
});

test('armKeyOf: armId wins; a blank armId falls back; old rows group like the spend ledger (breaks if the fallback fields or their defaults change)', () => {
  assert.equal(armKeyOf({ armId: 'A1', reviewer: 'engine' }), 'A1');
  assert.equal(armKeyOf({ armId: '', reviewer: 'engine' }), 'engine|v1|-|-');
  assert.equal(armKeyOf({ reviewer: 'engine', promptVersion: 'v3', model: 'm', backend: 'b' }), 'engine|v3|m|b');
  assert.equal(armKeyOf({ reviewer: 'cursor-review', promptVersion: 'v3' }), 'cursor-review|-|-|-', 'only the engine reads promptVersion');
  assert.equal(armKeyOf({}), 'none|-|-|-');
});

test('two replicates of one arm on one round both survive; a re-run of the same replicate still replaces the older row (breaks if replicate is left out of the key, or a re-run is kept)', () => {
  const rows = [armRow(9002, { reviewer: 'engine', replicate: 1, ts: '2026-11-03T01:00:00Z', findingsPath: 'miss' }), armRow(9002, { reviewer: 'engine', replicate: 2, ts: '2026-11-03T01:30:00Z' }), armRow(9002, { reviewer: 'engine', replicate: 1, ts: '2026-11-03T02:00:00Z' })];
  const ev = evaluateRuns({ runs: rows, dataset: [dsMajor('9002:1', 9002)], readFindings: hitRead });
  assert.deepEqual(ev.runs.map((r) => r.replicate).sort(), [1, 2]);
  assert.deepEqual(ev.matches.map((x) => x.engSev), ['major', 'major'], 'the older miss of replicate 1 is gone');
  assert.equal(evaluateRuns({ runs: [armRow(9002, { replicate: undefined })], dataset: [], readFindings: hitRead }).runs[0].replicate, 1, 'only an undefined replicate becomes 1');
});

test('evaluateRuns puts arm and replicate on each output run and each match row, incomplete runs too (breaks if either row type loses the field)', () => {
  const rows = [armRow(9003, { reviewer: 'engine', promptVersion: 'v2', replicate: 2 }), armRow(9004, { reviewer: 'engine', promptVersion: 'v2', status: 'incomplete' })];
  const ev = evaluateRuns({ runs: rows, dataset: [dsMajor('9003:1', 9003)], readFindings: hitRead });
  assert.deepEqual(ev.runs.map((r) => [r.arm, r.replicate]), [['engine|v2|-|-', 2], ['engine|v2|-|-', 1]]);
  assert.deepEqual(ev.matches.map((x) => [x.arm, x.replicate]), [['engine|v2|-|-', 2]]);
});

test('evaluateRuns returns attempts per arm: every row, the newest rows, failed newest rows, and failed-then-ok groups (breaks if a count reads the wrong rows)', () => {
  const t = (n) => `2026-11-03T0${n}:00:00Z`;
  const rows = [
    armRow(9005, { reviewer: 'engine', status: 'failed', ts: t(1) }), armRow(9005, { reviewer: 'engine', status: 'ok', ts: t(2) }), // failed then ok
    armRow(9006, { reviewer: 'engine', status: 'ok', ts: t(1) }), armRow(9006, { reviewer: 'engine', status: 'failed', ts: t(2) }), // ok then failed: a failure
    armRow(9007, { reviewer: 'engine', status: 'incomplete', ts: t(1) }), // incomplete is not a failure
    armRow(9005, { reviewer: 'cursor-review', status: 'ok', ts: t(1) }),
  ];
  const { attempts } = evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead });
  assert.deepEqual(attempts['engine|v1|-|-'], { attempts: 5, newest: 3, failed: 1, failedThenOk: 1, invalidReplicate: 0 });
  assert.deepEqual(attempts['cursor-review|-|-|-'], { attempts: 1, newest: 1, failed: 0, failedThenOk: 0, invalidReplicate: 0 });
});

test('joinReplicates joins folders and gives a row with an undefined replicate the folder number; a set replicate stays, valid or not (breaks if the folder index is off by one or overwrites a set replicate)', () => {
  const joined = joinReplicates([[{ pr: 9008 }, { pr: 9009, replicate: 5 }], [{ pr: 9008, replicate: 0 }, { pr: 9010 }]]);
  assert.deepEqual(joined.map((r) => [r.pr, r.replicate]), [[9008, 1], [9009, 5], [9008, 0], [9010, 2]], 'a replicate 0 is not undefined: it stays and is invalid');
  assert.deepEqual(joinReplicates([]), []);
});

test('attempts: an older failed row that sits on a later line still counts as a failure before the newest ok row, and a newer failed row is not a failedThenOk (breaks if failedThenOk reads line order instead of ts order)', () => {
  const rows = [armRow(9011, { reviewer: 'engine', status: 'ok', ts: '2026-11-03T02:00:00Z' }), armRow(9011, { reviewer: 'engine', status: 'failed', ts: '2026-11-03T01:00:00Z' })];
  const ev = evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead });
  assert.equal(ev.runs.length, 1);
  assert.deepEqual(ev.attempts['engine|v1|-|-'], { attempts: 2, newest: 1, failed: 0, failedThenOk: 1, invalidReplicate: 0 });
});

// ---------- re-score-paired step 2: multi-arm card ----------

// One arm (reviewer engine, promptVersion v1) with every kind of row the card handles: a stale hash, a body leak, an incomplete run, dev, labels, funnel, judge pairs.
const fx = (key, pr, set, crSev, engSev, over = {}) => ({ key, pr, set, reviewer: 'engine', promptSha256: 'PE', crSev, crVerdict: 'real', crSource: 'inline', engSev, engPairId: null, inWithdrawn: null, ...over });
const fr = (pr, set, findings, over = {}) => ({ set, pr, round: 1, status: 'ok', reviewer: 'engine', promptSha256: 'PE', durationMs: 1000, usage: { inputTokens: 10, outputTokens: 5 }, findings, ...over });
const ONE_ARM_INPUT = {
  sets: { zeroMajorPrs: [9106] },
  frozenPromptSha256: 'P0',
  frozenByReviewer: { engine: 'PE' },
  runs: [
    fr(9101, 'holdout', [{ id: 'f1', pairId: 'pa', sev: 'major', matchedKey: 'k1' }, { id: 'f1b', sev: 'minor', matchedKey: null }], { funnel: { raw: 4, withdrawn: 1, dropped: { byReason: { 'no-file': 2 } }, posted: 2 }, bodyMode: 'withheld' }),
    fr(9102, 'holdout', [{ id: 'f2', pairId: 'pb', sev: 'major', matchedKey: 'k2' }], { durationMs: 2500 }),
    fr(9102, 'holdout', [{ id: 'f2x', sev: 'major', matchedKey: null }], { promptSha256: 'OLD', round: 2 }),
    fr(9103, 'holdout', [{ id: 'f3', sev: 'major', matchedKey: null }], { bodyMode: 'full' }),
    fr(9104, 'holdout', [], { coverageComplete: false }),
    fr(9105, 'dev', [{ id: 'f5', sev: 'minor', matchedKey: 'd2' }]),
    fr(9106, 'holdout', [{ id: 'f6', sev: 'critical', matchedKey: null }, { id: 'f6b', sev: 'minor', matchedKey: null }]),
  ],
  matches: [
    fx('k1', 9101, 'holdout', 'major', 'major', { engPairId: 'pa' }),
    fx('k2', 9102, 'holdout', 'major', 'major', { engPairId: 'pb' }),
    fx('k3', 9102, 'holdout', 'critical', null, { inWithdrawn: true }),
    fx('k4', 9101, 'holdout', 'major', 'minor', { inWithdrawn: false }),
    fx('k5', 9101, 'holdout', 'major', null, { crSource: 'body' }),
    fx('k6', 9101, 'holdout', 'minor', 'minor'),
    fx('k7', 9101, 'holdout', 'major', 'major', { crVerdict: 'noise' }),
    fx('k8', 9102, 'holdout', 'major', 'major', { promptSha256: 'OLD' }),
    fx('k9', 9103, 'holdout', 'major', 'major', { bodyMode: 'full' }),
    fx('d1', 9105, 'dev', 'major', 'major'),
    fx('d2', 9105, 'dev', 'major', null),
  ],
  labels: [
    { findingId: 'pb', pairId: 'pb', verdict: 'real', sameIssue: false, by: 'claude' },
    { findingId: 'f1', verdict: 'real', by: 'dave' },
    { findingId: 'f1b', verdict: 'noise', by: 'claude' },
    { findingId: 'p1', pairId: 'p1', verdict: 'real', by: 'dave' },
    { findingId: 'p2', pairId: 'p2', verdict: 'noise', by: 'dave' },
  ],
  linkTypes: { k1: 'within-hunk', k2: 'same-file', k3: 'same-file', d1: 'cross-file-dynamic' },
  escapes: { laterRound: 2, postMerge: 1 },
  bakeoff: { k1: 'a', k2: 'b' },
  headless: { runs: 3, costUsd: 1.25, usage: { inputTokens: 100 } },
  pairsSent: [{ pairId: 'p1', judge: { verdict: 'real' } }, { pairId: 'p2', judge: { verdict: 'real' } }],
};

// The card of ONE_ARM_INPUT, computed by the code before the multi-arm change (base commit 5a6f0f6e). The proof test pins every base key to it.
const BASE_CARD = {
  "schema": 1,
  "perMajorRecall": {
    "strict": {
      "found": 2,
      "total": 5,
      "value": 0.4
    },
    "lenient": {
      "found": 3,
      "total": 5,
      "value": 0.6
    },
    "strictSameIssue": {
      "found": 1,
      "total": 5,
      "value": 0.2
    }
  },
  "perPrRecall": {
    "found": 2,
    "total": 2,
    "value": 1
  },
  "funnel": {
    "runs": 1,
    "raw": 4,
    "withdrawn": 1,
    "dropped": {
      "total": 2,
      "byReason": {
        "no-file": 2
      }
    },
    "posted": 2
  },
  "withdrawnMisses": {
    "misses": 3,
    "inWithdrawn": 1,
    "noData": 1
  },
  "perClassRecall": {
    "holdout": {
      "within-hunk": {
        "found": 1,
        "total": 1,
        "value": 1
      },
      "same-file": {
        "found": 0,
        "total": 2,
        "value": 0
      },
      "unlabelled": {
        "found": 0,
        "total": 2,
        "value": 0
      }
    },
    "dev": {
      "cross-file-dynamic": {
        "found": 1,
        "total": 1,
        "value": 1
      },
      "unlabelled": {
        "found": 0,
        "total": 1,
        "value": 0
      }
    }
  },
  "prFalseAlarm": {
    "count": 1,
    "total": 1,
    "prs": [
      9106
    ]
  },
  "precision": {
    "real": 3,
    "noise": 1,
    "unverified": 2,
    "posted": 6,
    "value": 0.5,
    "range": [
      0.5,
      0.8333333333333334
    ],
    "labelers": {
      "dave": 1,
      "claude": 2
    }
  },
  "recall": {
    "inDiff": {
      "found": 2,
      "total": 4,
      "value": 0.5
    },
    "overall": {
      "found": 2,
      "total": 5,
      "value": 0.4
    }
  },
  "devRecall": {
    "strict": {
      "found": 1,
      "total": 2,
      "value": 0.5
    },
    "lenient": {
      "found": 1,
      "total": 2,
      "value": 0.5
    }
  },
  "escapeBaseline": {
    "laterRound": 2,
    "postMerge": 1
  },
  "bakeoffCrosswalk": {
    "mapped": 2,
    "letters": [
      "a",
      "b"
    ]
  },
  "cost": {
    "grok": {
      "runs": 4,
      "durationMs": 5500,
      "usage": {
        "inputTokens": 40,
        "outputTokens": 20
      }
    },
    "headless": {
      "runs": 3,
      "costUsd": 1.25,
      "usage": {
        "inputTokens": 100
      }
    }
  },
  "judgeAgreement": {
    "n": 2,
    "agree": 1,
    "value": 0.5,
    "kappa": 0,
    "gate": 0.8,
    "kappaGate": 0.6,
    "status": "NOTE",
    "pass": false
  },
  "excludedRuns": 3,
  "bodyModes": {
    "withheld": 1,
    "full": 1,
    "unknown": 5
  }
};

const ENGINE_ARM = 'engine|v1|-|-';
const OTHER_ARM = 'cursor-review|-|-|-';
/** A second arm made from the one-arm fixture: same rounds, reviewer cursor-review, only some matches kept (so the arms differ). */
function twoArmInput() {
  const asOther = (x) => ({ ...x, reviewer: 'cursor-review', promptSha256: 'PC' });
  return {
    ...ONE_ARM_INPUT,
    frozenByReviewer: { engine: 'PE', 'cursor-review': 'PC' },
    runs: [...ONE_ARM_INPUT.runs, ...ONE_ARM_INPUT.runs.slice(0, 2).map(asOther)],
    matches: [...ONE_ARM_INPUT.matches, ...ONE_ARM_INPUT.matches.slice(0, 3).map((x) => asOther({ ...x, engSev: null, engPairId: null }))],
  };
}
const onlyArm = (input, arm) => ({ ...input, runs: input.runs.filter((r) => armKeyOf(r) === arm), matches: input.matches.filter((x) => armKeyOf(x) === arm) });

test('a one-arm card keeps every base key deep-equal to the card computed before the change, and adds arms and perArm (breaks if the scoreOne split changes one number)', () => {
  const card = scorecard(ONE_ARM_INPUT);
  for (const key of Object.keys(BASE_CARD)) assert.deepEqual(card[key], BASE_CARD[key], key);
  assert.deepEqual(card.arms, [ENGINE_ARM]);
  assert.deepEqual(Object.keys(card.perArm), [ENGINE_ARM]);
  assert.deepEqual(scorecard({ sets: {} }).arms, [], 'no runs: no arm, and the base keys still show');
});

test('a card with two arms sets the pooled recall, precision and cost.grok keys to null and keeps the shared keys (breaks if two arms are blended)', () => {
  const card = scorecard(twoArmInput());
  assert.deepEqual(card.arms, [OTHER_ARM, ENGINE_ARM].sort());
  for (const key of ['perMajorRecall', 'perPrRecall', 'funnel', 'withdrawnMisses', 'perClassRecall', 'prFalseAlarm', 'precision', 'recall', 'devRecall']) assert.equal(card[key], null, key);
  assert.equal(card.cost.grok, null);
  for (const key of ['perSuite', 'perSource', 'goldARecall', 'cleanFalseMajor']) assert.equal(card[key], null, `${key}: the gold rows live in perArm only`);
  assert.ok(card.perArm[ENGINE_ARM].goldARecall && card.perArm[ENGINE_ARM].cleanFalseMajor, 'the arm cards keep them');
  assert.deepEqual(card.cost.headless, BASE_CARD.cost.headless);
  for (const key of ['judgeAgreement', 'escapeBaseline', 'bakeoffCrosswalk']) assert.deepEqual(card[key], BASE_CARD[key], key);
  assert.equal(card.excludedRuns, 3);
  assert.deepEqual(card.bodyModes, { withheld: 2, full: 1, unknown: 6 });
});

/**
 * The perArm card of the second arm of twoArmInput, as a fixed object (R6). It was pasted from one run, then checked by hand against the fixture (the checks follow), so a later change shows as a diff:
 * the arm has the runs of PRs 9101 and 9102 (cursor-review, frozen hash PC) and the first 3 match rows with no engine hit, so recall is 0 of 3 (2 PRs, 0 hit);
 * the 3 misses hold 1 withdrawn and 2 with no list; its 3 posted findings are 2 real (one Dave label, one Claude label) and 1 noise; cost is 2 runs, 1000 + 2500 ms.
 * There is no prFalseAlarm.prs: a perArm card prints no PR id.
 */
const OTHER_CARD = {
  "schema": 1,
  "perMajorRecall": {
    "strict": {
      "found": 0,
      "total": 3,
      "value": 0
    },
    "lenient": {
      "found": 0,
      "total": 3,
      "value": 0
    },
    "strictSameIssue": {
      "found": 0,
      "total": 3,
      "value": 0
    }
  },
  "perPrRecall": {
    "found": 0,
    "total": 2,
    "value": 0
  },
  "funnel": {
    "runs": 1,
    "raw": 4,
    "withdrawn": 1,
    "dropped": {
      "total": 2,
      "byReason": {
        "no-file": 2
      }
    },
    "posted": 2
  },
  "withdrawnMisses": {
    "misses": 3,
    "inWithdrawn": 1,
    "noData": 2
  },
  "perClassRecall": {
    "holdout": {
      "within-hunk": {
        "found": 0,
        "total": 1,
        "value": 0
      },
      "same-file": {
        "found": 0,
        "total": 2,
        "value": 0
      }
    },
    "dev": {}
  },
  "prFalseAlarm": {
    "count": 0,
    "total": 0
  },
  "precision": {
    "real": 2,
    "noise": 1,
    "unverified": 0,
    "posted": 3,
    "value": 0.6666666666666666,
    "range": [
      0.6666666666666666,
      0.6666666666666666
    ],
    "labelers": {
      "dave": 1,
      "claude": 2
    }
  },
  "recall": {
    "inDiff": {
      "found": 0,
      "total": 3,
      "value": 0
    },
    "overall": {
      "found": 0,
      "total": 3,
      "value": 0
    }
  },
  "devRecall": {
    "strict": {
      "found": 0,
      "total": 0,
      "value": null
    },
    "lenient": {
      "found": 0,
      "total": 0,
      "value": null
    }
  },
  "escapeBaseline": {
    "laterRound": 2,
    "postMerge": 1
  },
  "bakeoffCrosswalk": {
    "mapped": 2,
    "letters": [
      "a",
      "b"
    ]
  },
  "cost": {
    "grok": {
      "runs": 2,
      "durationMs": 3500,
      "usage": {
        "inputTokens": 20,
        "outputTokens": 10
      }
    },
    "headless": {
      "runs": 3,
      "costUsd": 1.25,
      "usage": {
        "inputTokens": 100
      }
    }
  },
  "judgeAgreement": {
    "n": 2,
    "agree": 1,
    "value": 0.5,
    "kappa": 0,
    "gate": 0.8,
    "kappaGate": 0.6,
    "status": "NOTE",
    "pass": false
  },
  "excludedRuns": 0,
  "bodyModes": {
    "withheld": 1,
    "full": 0,
    "unknown": 1
  },
  "perSuite": {
    "holdout": {
      "unassigned": {
        "found": 0,
        "total": 3,
        "value": null
      }
    },
    "dev": {}
  },
  "perSource": {
    "holdout": {
      "CR": {
        "found": 0,
        "total": 3,
        "value": null
      }
    },
    "dev": {}
  },
  "goldARecall": {
    "holdout": {
      "found": 0,
      "total": 0,
      "value": null,
      "ci": {
        "lo": null,
        "hi": null
      }
    },
    "dev": {
      "found": 0,
      "total": 0,
      "value": null,
      "ci": {
        "lo": null,
        "hi": null
      }
    }
  },
  "cleanFalseMajor": {
    "holdout": {
      "controls": 0,
      "falseMajors": 0,
      "runs": 0,
      "perPr": null,
      "lo": null,
      "hi": null
    },
    "dev": {
      "controls": 0,
      "falseMajors": 0,
      "runs": 0,
      "perPr": null,
      "lo": null,
      "hi": null
    }
  }
};

test('each perArm[k] holds the same numbers as the card of an input with only arm k; the arms differ; the second arm is pinned to a fixed card (breaks if an arm reads rows of another arm, or a perArm number moves)', () => {
  const input = twoArmInput();
  const card = scorecard(input);
  for (const arm of card.arms) {
    const solo = scorecard(onlyArm(input, arm));
    assert.deepEqual(solo.arms, [arm]);
    for (const key of Object.keys(card.perArm[arm]).filter((k) => k !== 'prFalseAlarm')) assert.deepEqual(card.perArm[arm][key], solo[key], );
    assert.deepEqual(card.perArm[arm].prFalseAlarm, { count: solo.prFalseAlarm.count, total: solo.prFalseAlarm.total }, );
    assert.ok('perMajorRecall' in card.perArm[arm] && 'cost' in card.perArm[arm]);
  }
  assert.deepEqual(card.perArm[OTHER_ARM], OTHER_CARD);
  assert.deepEqual(card.perArm[ENGINE_ARM].perMajorRecall, BASE_CARD.perMajorRecall);
  for (const key of Object.keys(BASE_CARD).filter((k) => k !== 'prFalseAlarm')) assert.deepEqual(card.perArm[ENGINE_ARM][key], BASE_CARD[key], key);
  assert.deepEqual(card.perArm[ENGINE_ARM].prFalseAlarm, { count: 1, total: 1 });
});

// ---------- re-score-paired step 4: the paired bar and the gold rows ----------

const BASE_ARM = 'arm-base';
const CAND_ARM = 'arm-cand';
/** Match rows for one item of one arm: one row per replicate; catches is a list of 0/1. cluster defaults to the PR. */
const itemRows = (arm, key, pr, catches, over = {}) => catches.map((c, i) => ({ key, pr, set: 'holdout', arm, replicate: i + 1, crSev: 'major', crVerdict: 'real', crSource: 'inline', engSev: c ? 'major' : null, engPairId: null, ...over }));
const armRuns = (arm, prs, over = {}) => prs.map((pr) => ({ set: 'holdout', pr, round: 1, status: 'ok', arm, replicate: 1, promptSha256: 'P0', durationMs: 100, findings: [], ...over }));
/** The synthetic two-arm gold: 5 regression items (one unpaired), 3 capability items, 1 item with no suite. */
function pairedInput(extra = {}) {
  const both = (key, pr, base, cand, over) => [...itemRows(BASE_ARM, key, pr, base, over), ...itemRows(CAND_ARM, key, pr, cand, over)];
  const matches = [
    ...both('r1', 9201, [1, 1], [1, 1]), ...both('r2', 9202, [1, 1], [0, 0]), ...both('r3', 9203, [1, 0], [1, 1]), ...both('r4', 9204, [0, 0], [0, 0]),
    ...itemRows(BASE_ARM, 'r5', 9205, [1, 1]),
    ...both('c1', 9206, [0, 0], [1, 1]), ...both('c2', 9207, [0, 0], [1, 0]), ...both('c3', 9208, [0, 0], [0, 0]),
    ...both('u1', 9209, [1, 1], [1, 1]),
  ];
  const suites = { r1: 'regression', r2: 'regression', r3: 'regression', r4: 'regression', r5: 'regression', c1: 'capability', c2: 'capability', c3: 'capability' };
  return { sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9201]), ...armRuns(CAND_ARM, [9201])], matches, suites, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 400, seed: 7, ...extra };
}

/**
 * Each item of the input becomes k items: the key gets a suffix, the PR (so the cluster) stays. The mean, d and the bounds stay as they were; only n grows.
 * It lifts a small fixture over the cut of 20 real Majors (MIN_CELL).
 */
const fan = (input, k) => {
  const copies = (key) => Array.from({ length: k }, (_, i) => `${key}~${i}`);
  const spread = (map) => Object.fromEntries(Object.entries(map ?? {}).flatMap(([key, v]) => copies(key).map((c) => [c, v])));
  return { ...input, matches: input.matches.flatMap((x) => copies(x.key).map((key) => ({ ...x, key }))), suites: spread(input.suites), sources: spread(input.sources) };
};

test('pairedBar: per suite delta in points, paired and unpaired counts, d and nNeeded; status is always NOTE and unassigned never gates (breaks if a mean, a count or a formula changes)', () => {
  const bar = scorecard(fan(pairedInput(), 7)).pairedBar.holdout;
  assert.deepEqual([bar.status, bar.baseline, bar.candidate], ['NOTE', BASE_ARM, CAND_ARM]);
  const reg = bar.regression;
  assert.deepEqual([reg.delta, reg.n, reg.unpaired, reg.d, reg.nNeeded], [-12.5, 28, 7, 0.5, 769]);
  assert.ok(reg.lo <= reg.delta && reg.delta <= reg.hi);
  assert.equal(reg.wouldBe, 'FAIL', 'delta -12.5 with a lower bound far under -5');
  const cap = bar.capability;
  assert.deepEqual([cap.delta, cap.n, cap.unpaired], [50, 21, 0]);
  assert.ok(Math.abs(cap.d - 2 / 3) < 1e-12);
  assert.equal(cap.nNeeded, 7);
  assert.equal(cap.wouldBe, 'FAIL', 'delta 50 on 3 clusters: the lower bound reaches 0');
  assert.deepEqual([bar.unassigned.n, bar.unassigned.delta, bar.unassigned.wouldBe], [7, null, null], '7 items: under the cut, and unassigned never gates');
});

test('R1 pairedBar under 20 Majors prints counts only: delta, lo, hi, d, nNeeded and wouldBe are null; n, unpaired, B and used still print (breaks if a number prints under the cut; nNeeded = ceil(1537 * d) gives d back, seat ruling (b))', () => {
  const bar = scorecard(pairedInput()).pairedBar.holdout;
  const reg = bar.regression;
  assert.deepEqual([reg.delta, reg.lo, reg.hi, reg.d, reg.nNeeded, reg.wouldBe], [null, null, null, null, null, null]);
  assert.deepEqual([reg.n, reg.unpaired, reg.B], [4, 1, 400]);
  assert.ok(Number.isInteger(reg.used) && reg.used > 0, 'used still prints');
  assert.deepEqual([bar.capability.delta, bar.capability.wouldBe, bar.capability.n, bar.capability.nNeeded], [null, null, 3, null]);
  assert.deepEqual([bar.unassigned.delta, bar.unassigned.wouldBe, bar.unassigned.n], [null, null, 1]);
});

test('pairedBar: no compare gives null; a capability delta of 0 or less has no nNeeded (breaks if the bar runs without a compare or divides by a zero delta)', () => {
  const input = pairedInput();
  assert.equal(scorecard({ ...input, compare: undefined }).pairedBar, null);
  assert.equal(scorecard({ ...input, compare: undefined }).lostCaughtMajors, null);
  const swapped = scorecard({ ...fan(input, 7), compare: { baseline: CAND_ARM, candidate: BASE_ARM } }).pairedBar.holdout;
  assert.deepEqual([swapped.capability.delta, swapped.capability.nNeeded, swapped.regression.delta], [-50, null, 12.5]);
});

/** One suite on identical clusters (one per name in clusters, 2 by default), so the bounds equal the delta. items: [[baseCatches, candCatches]], one item per entry in each cluster. */
function oneClusterBar(suite, items, clusters = ['x', 'y']) {
  const itemKeys = clusters.flatMap((cl, k) => items.map((it, i) => [`s${i}${cl}`, 9250 + i + 40 * k, cl, it]));
  const matches = itemKeys.flatMap(([key, pr, cl, [b, c]]) => [...itemRows(BASE_ARM, key, pr, b, { cluster: cl }), ...itemRows(CAND_ARM, key, pr, c, { cluster: cl })]);
  const suites = Object.fromEntries(itemKeys.map(([key]) => [key, suite]));
  return scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9250]), ...armRuns(CAND_ARM, [9250])], matches, suites, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50 }).pairedBar.holdout[suite];
}

test('pairedBar wouldBe gives the literal PASS or FAIL at each gate edge: regression passes above -5 and fails at -5 exactly; capability passes above 0 and fails at 0 (breaks if the gate moves, reads delta instead of lo, says a fixed word, or uses >= )', () => {
  // Two clusters of 10 items each: 20 items, the cut of MIN_CELL. A repeated list keeps the mean.
  const times = (k, items) => Array.from({ length: k }, () => items).flat();
  const idle = [[[0, 0, 0, 0], [0, 0, 0, 0]]];
  const regPass = oneClusterBar('regression', times(5, [[[1, 1], [1, 1]], [[0, 0], [0, 0]]]));
  assert.deepEqual([regPass.delta, regPass.lo, regPass.wouldBe], [0, 0, 'PASS'], 'no change at all: the lower bound 0 is above -5');
  const capPass = oneClusterBar('capability', times(5, [[[0, 0], [1, 1]], [[0, 0], [1, 1]]]));
  assert.deepEqual([capPass.delta, capPass.lo, capPass.wouldBe], [100, 100, 'PASS']);
  const regEdge = oneClusterBar('regression', times(2, [[[1, 0, 0, 0], [0, 0, 0, 0]], ...idle, ...idle, ...idle, ...idle]));
  assert.deepEqual([regEdge.delta, regEdge.lo, regEdge.wouldBe], [-5, -5, 'FAIL'], 'the lower bound is exactly -5: not above it');
  const capEdge = oneClusterBar('capability', times(5, [[[1, 0], [1, 0]], [[0, 0], [0, 0]]]));
  assert.deepEqual([capEdge.delta, capEdge.lo, capEdge.wouldBe, capEdge.nNeeded], [0, 0, 'FAIL', null], 'delta 0: lo is exactly 0, not above it; no nNeeded at a delta of 0');
});

test('pairedBar wouldBe reads the lower bound, not delta: a regression suite with delta above -5 and lo below -5 fails (breaks if the gate reads delta)', () => {
  // 10 items where only the baseline catches and 10 where only the candidate catches, each on its own PR: delta 0, wide bounds.
  const items = Array.from({ length: 20 }, (_, i) => (i < 10 ? [[1, 1], [0, 0]] : [[0, 0], [1, 1]]));
  const matches = items.flatMap(([b, c], i) => [...itemRows(BASE_ARM, `w${i}`, 9260 + i, b), ...itemRows(CAND_ARM, `w${i}`, 9260 + i, c)]);
  const suites = Object.fromEntries(items.map((_, i) => [`w${i}`, 'regression']));
  const bar = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9260]), ...armRuns(CAND_ARM, [9260])], matches, suites, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 500, seed: 5 }).pairedBar.holdout.regression;
  assert.equal(bar.delta, 0);
  assert.ok(bar.lo < -5 && bar.hi > 5, `${bar.lo} ${bar.hi}`);
  assert.equal(bar.wouldBe, 'FAIL');
});

test('pairedBar passes B and seed to the bootstrap: B 1 gives one resample so lo === hi; one seed repeats and other seeds differ (breaks if B or seed is ignored)', () => {
  const input = fan(pairedInput(), 7);
  const bounds = (extra) => { const r = scorecard({ ...input, ...extra }).pairedBar.holdout.regression; return [r.lo, r.hi]; };
  const one = bounds({ B: 1, seed: 1 });
  assert.equal(one[0], one[1], 'B 1: a single resample');
  const [lo2000, hi2000] = bounds({ B: 2000, seed: 1 });
  assert.ok(lo2000 < hi2000);
  assert.deepEqual(bounds({ B: 3, seed: 4 }), bounds({ B: 3, seed: 4 }));
  assert.ok(one[0] !== null, 'the cell has 28 items: it prints bounds');
  const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => bounds({ B: 3, seed }).join()));
  assert.ok(seen.size > 1, 'some seed changes the bounds');
});

test('pairedBar: a catch whose pair a label calls a different issue is a miss (breaks if the sameIssue rule is dropped)', () => {
  const rows = [...itemRows(BASE_ARM, 'r1', 9201, [1, 1]), ...itemRows(CAND_ARM, 'r1', 9201, [1, 1], { engPairId: 'px' })];
  const labels = [{ findingId: 'px', pairId: 'px', verdict: 'real', sameIssue: false, by: 'claude' }];
  const input = fan({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9201]), ...armRuns(CAND_ARM, [9201])], matches: rows, suites: { r1: 'regression' }, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50 }, 20);
  assert.equal(scorecard({ ...input, labels }).pairedBar.holdout.regression.delta, -100);
  assert.equal(scorecard({ ...input, labels: [] }).pairedBar.holdout.regression.delta, 0);
});

test('pairedBar resamples by cluster: rows that share a cluster field give lo === hi even on different PRs (breaks if the cluster field is ignored)', () => {
  const same = fan(pairedInput({ B: 200 }), 7);
  const asOne = { ...same, matches: same.matches.map((x) => ({ ...x, cluster: 'one' })) };
  const bar = scorecard(asOne).pairedBar.holdout.regression;
  assert.deepEqual([bar.lo, bar.hi], [bar.delta, bar.delta]);
  const byPr = scorecard(same).pairedBar.holdout.regression;
  assert.ok(byPr.hi > byPr.lo);
});

test('pairedBar leaves a stale-hash holdout row out of both arms (breaks if the paired items skip the frozen-prompt rule)', () => {
  const input = fan(pairedInput(), 7);
  const stale = { ...input, frozenByReviewer: { engine: 'PE' }, matches: input.matches.map((x) => (x.key.startsWith('r2~') ? { ...x, reviewer: 'engine', promptSha256: 'OLD' } : x)) };
  const reg = scorecard(stale).pairedBar.holdout.regression;
  assert.equal(reg.n, 21);
  assert.ok(Math.abs(reg.delta - 100 * (2 / 3 - 0.5)) < 1e-9, String(reg.delta));
});

test('lostCaughtMajors counts items the baseline catches in every replicate and the candidate misses in every replicate, needing 2 replicates each side (breaks if a one-replicate item or a partial catch counts)', () => {
  const lost = scorecard(pairedInput()).lostCaughtMajors.holdout;
  assert.deepEqual(lost, { count: 1, assessable: 8, flagged: true }, 'every paired item has 2 replicates on both arms');
  const full = pairedInput();
  const oneReplicate = { ...full, matches: full.matches.filter((x) => x.replicate === 1) };
  assert.deepEqual(scorecard(oneReplicate).lostCaughtMajors.holdout, { count: 0, assessable: 0, flagged: null });
  const partial = { ...full, matches: full.matches.map((x) => (x.key === 'r2' && x.arm === CAND_ARM && x.replicate === 2 ? { ...x, engSev: 'major' } : x)) };
  assert.equal(scorecard(partial).lostCaughtMajors.holdout.count, 0);
});

test('perSuite and perSource give same-issue recall per arm as counts; value stays null below 20 real Majors; Gold A and B stay apart; CR never takes a source A row (breaks if the 20 cut, the source split or the CR default changes)', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => itemRows(BASE_ARM, `a${i}`, 9400 + i, [i < 15 ? 1 : 0])).flat(),
    ...Array.from({ length: 3 }, (_, i) => itemRows(BASE_ARM, `b${i}`, 9450 + i, [1])).flat(),
    ...itemRows(BASE_ARM, 'x0', 9460, [0]),
  ];
  const sources = Object.fromEntries([...Array.from({ length: 20 }, (_, i) => [`a${i}`, 'A']), ['b0', 'B'], ['b1', 'B'], ['b2', 'B']]);
  const suites = { b0: 'regression', b1: 'regression', b2: 'capability', a0: 'capability' };
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: armRuns(BASE_ARM, [9400]), matches: rows, sources, suites });
  assert.deepEqual(card.perSource.holdout.A, { found: 15, total: 20, value: 0.75 });
  assert.deepEqual(card.perSource.holdout.B, { found: 3, total: 3, value: null });
  assert.deepEqual(card.perSource.holdout.CR, { found: 0, total: 1, value: null }, 'only the row with no source; no A row');
  assert.deepEqual([card.perSuite.holdout.regression.found, card.perSuite.holdout.regression.total, card.perSuite.holdout.capability.total, card.perSuite.holdout.unassigned.total], [2, 2, 2, 20]);
  assert.equal(card.perSuite.holdout.regression.value, null);
});

test('goldARecall is the same-issue recall on source A real Majors with counts; the Wilson interval appears only from 20 items (breaks if source B or CR rows enter it, the interval is dropped at 20, or an interval prints below the cut)', () => {
  const rows = [...itemRows(BASE_ARM, 'a0', 9500, [1]), ...itemRows(BASE_ARM, 'a1', 9501, [0]), ...itemRows(BASE_ARM, 'a2', 9502, [1]), ...itemRows(BASE_ARM, 'a3', 9503, [0]), ...itemRows(BASE_ARM, 'b0', 9504, [1])];
  const sources = { a0: 'A', a1: 'A', a2: 'A', a3: 'A', b0: 'B' };
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: armRuns(BASE_ARM, [9500]), matches: rows, sources });
  assert.deepEqual([card.goldARecall.holdout.found, card.goldARecall.holdout.total, card.goldARecall.holdout.value], [2, 4, null]);
  assert.deepEqual(card.goldARecall.holdout.ci, { lo: null, hi: null }, '4 items is under the cut: counts only, no interval');
  assert.deepEqual(scorecard({ sets: {}, runs: [], matches: [] }).goldARecall.holdout, { found: 0, total: 0, value: null, ci: { lo: null, hi: null } });
});

test('cleanFalseMajor counts major and critical engine findings per clean control; cleanRise is true only when the candidate rate is higher; a control is a PR, so replicates do not change the rate (breaks if a minor counts, the rate uses the wrong runs or the rise reads the wrong arm)', () => {
  const fnd = (...sev) => sev.map((s, i) => ({ id: `f${i}`, sev: s }));
  const clean = (arm, pr, findings, replicate = 1) => ({ set: 'holdout', pr, round: 1, status: 'ok', arm, replicate, promptSha256: 'P0', findings });
  const runs = [clean(BASE_ARM, 9601, fnd('major', 'minor')), clean(BASE_ARM, 9602, fnd('critical', 'major')), clean(BASE_ARM, 9603, fnd('major')), clean(CAND_ARM, 9601, []), clean(CAND_ARM, 9602, fnd('major')), clean(CAND_ARM, 9602, fnd('major'), 2), clean(CAND_ARM, 9601, [], 2)];
  const input = { sets: {}, frozenPromptSha256: 'P0', runs, matches: [], cleanPrs: [9601, 9602], B: 200, seed: 3 };
  const card = scorecard({ ...input, compare: { baseline: BASE_ARM, candidate: CAND_ARM } });
  const b = card.perArm[BASE_ARM].cleanFalseMajor.holdout;
  const c = card.perArm[CAND_ARM].cleanFalseMajor.holdout;
  assert.deepEqual([b.controls, b.falseMajors, b.perPr], [2, 3, 1.5], 'PR 9603 is not a clean control; the minor does not count');
  assert.deepEqual([c.controls, c.runs, c.falseMajors, c.perPr], [2, 4, 2, 0.5], 'four runs on two PRs: two controls');
  assert.ok(b.lo <= b.perPr && b.perPr <= b.hi);
  assert.deepEqual(card.cleanRise, { holdout: false, dev: null });
  assert.equal(scorecard({ ...input, compare: { baseline: CAND_ARM, candidate: BASE_ARM } }).cleanRise.holdout, true);
  assert.equal(scorecard(input).cleanRise, null);
  const none = { controls: 0, falseMajors: 0, runs: 0, perPr: null, lo: null, hi: null };
  assert.deepEqual(scorecard({ sets: {}, runs: [], matches: [] }).cleanFalseMajor, { holdout: none, dev: none });
});


// ---------- re-score-paired step 5: reliability ----------

/** n valid runs of one arm; run i is on its own PR (9700 + i). over(i) gives the fields of run i. */
const relRuns = (arm, n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({ set: 'holdout', pr: 9700 + i, round: 1, sha40: sha9, status: 'ok', arm, replicate: 1, promptSha256: 'P0', durationMs: 100, findings: [], ...over(i) }));
const relInput = (runs, attempts, extra = {}) => ({ sets: {}, frozenPromptSha256: 'P0', runs, matches: [], attempts, ...extra });

test('reliability gives runFailure from attempts, an arm with only failed rows, and null for an arm with no newest row (breaks if the failed arm vanishes or 0 newest divides)', () => {
  const rows = [{ ...armRow(9701, { reviewer: 'engine' }), status: 'ok' }, { ...armRow(9702, { reviewer: 'engine' }), status: 'failed' }, { ...armRow(9703, { reviewer: 'cursor-review' }), status: 'failed' }];
  const ev = evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead });
  const card = scorecard({ sets: {}, runs: ev.runs, matches: ev.matches, attempts: ev.attempts });
  assert.deepEqual(card.arms, ['engine|v1|-|-'], 'the failed-only arm has no output run');
  assert.deepEqual(Object.keys(card.reliability).sort(), ['cursor-review|-|-|-', 'engine|v1|-|-']);
  assert.deepEqual([card.reliability['engine|v1|-|-'].runFailure, card.reliability['engine|v1|-|-'].attempts, card.reliability['cursor-review|-|-|-'].runFailure], [0.5, 2, 1]);
  assert.equal(scorecard({ sets: {}, runs: [], matches: [], attempts: { x: { attempts: 0, newest: 0, failed: 0, failedThenOk: 0 } } }).reliability.x.runFailure, null);
  assert.deepEqual(scorecard({ sets: {}, runs: [], matches: [] }).reliability, {});
  assert.equal(scorecard(relInput(relRuns('a', 2), undefined)).reliability.a.runFailure, null, 'no attempts input: unknown, not 0');
});

test('reliability: failedThenOk comes through; repairedJson is the share of ok rows flagged true, and null when no row has the flag (breaks if a missing flag counts as false)', () => {
  const att = { a: { attempts: 6, newest: 4, failed: 1, failedThenOk: 2 }, b: { attempts: 2, newest: 2, failed: 0, failedThenOk: 0 } };
  const runs = [...relRuns('a', 4, (i) => ({ repairedJson: i === 0 })), ...relRuns('b', 2)];
  const rel = scorecard(relInput(runs, att)).reliability;
  assert.deepEqual([rel.a.repairedJson, rel.a.failedThenOk, rel.a.attempts], [0.25, 2, 6]);
  assert.equal(rel.b.repairedJson, null);
});

test('reliability: p95WallMs is the nearest-rank 95th percentile of the valid runs; a stale-hash run does not count (breaks if the rank is off by one or a stale run is timed)', () => {
  const runs = relRuns('a', 20, (i) => ({ durationMs: i + 1 }));
  assert.equal(scorecard(relInput(runs, {})).reliability.a.p95WallMs, 19);
  const withStale = [...runs, ...relRuns('a', 1, () => ({ pr: 9799, durationMs: 99999, promptSha256: 'OLD' }))];
  assert.equal(scorecard(relInput(withStale, {})).reliability.a.p95WallMs, 19);
  assert.equal(scorecard(relInput(relRuns('a', 1, () => ({ durationMs: undefined })), {})).reliability.a.p95WallMs, null);
});

test('reliability: findingsVariance is the mean population variance of the posted count over rounds that have 2 or more replicates; an incomplete run adds no zero (breaks if a one-replicate round or an empty incomplete run counts)', () => {
  const fnd = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, sev: 'minor' }));
  const rep = (pr, replicate, n, over = {}) => ({ set: 'holdout', pr, round: 1, sha40: sha9, status: 'ok', arm: 'a', replicate, promptSha256: 'P0', findings: fnd(n), ...over });
  const runs = [rep(9801, 1, 2), rep(9801, 2, 4), rep(9802, 1, 5), rep(9802, 2, 5), rep(9803, 1, 7), rep(9804, 1, 3), rep(9804, 2, 3, { status: 'incomplete', coverageComplete: false, findings: [] })];
  assert.equal(scorecard(relInput(runs, {})).reliability.a.findingsVariance, 0.5, 'rounds 9801 (variance 1) and 9802 (0); 9803 has one replicate; 9804 has one complete replicate');
  assert.equal(scorecard(relInput(runs.slice(4, 5), {})).reliability.a.findingsVariance, null);
});

test('reliabilityFlags lists a metric when the candidate is worse than the baseline by more than 2 points; exactly 2 points is not flagged; null without compare (breaks if the limit moves or float noise flags a 2-point gap)', () => {
  const att = (failed) => ({ newest: 100, attempts: 100, failed, failedThenOk: 0 });
  const flags = (baseFailed, candFailed, extra = {}) => scorecard(relInput([...relRuns('b', 1), ...relRuns('c', 1)], { b: att(baseFailed), c: att(candFailed) }, { compare: { baseline: 'b', candidate: 'c' }, ...extra })).reliabilityFlags.flagged;
  assert.deepEqual(flags(3, 5), [], '0.05 - 0.03 is 2 points in math and 2.0000000000000004 in floats');
  assert.deepEqual(flags(3, 6), ['runFailure']);
  assert.deepEqual(flags(6, 1), [], 'better is not a flag');
  const repairs = (arm, n, k) => relRuns(arm, n, (i) => ({ pr: 9900 + (arm === 'b' ? 0 : 100) + i, repairedJson: i < k }));
  const runs = [...repairs('b', 100, 10), ...repairs('c', 100, 13)];
  const card = scorecard(relInput(runs, { b: att(0), c: att(0) }, { compare: { baseline: 'b', candidate: 'c' } }));
  assert.deepEqual(card.reliabilityFlags, { flagged: ['repairedJson'], unmeasured: [] });
  assert.equal(scorecard(relInput(runs, { b: att(0), c: att(0) })).reliabilityFlags, null);
  const unknown = scorecard(relInput([...relRuns('b', 2), ...relRuns('c', 2)], { b: att(0), c: att(0) }, { compare: { baseline: 'b', candidate: 'c' } }));
  assert.deepEqual(unknown.reliabilityFlags, { flagged: [], unmeasured: ['repairedJson'] }, 'a null metric is never flagged');
});

test('reliabilityFlags names a metric that is null on either arm as unmeasured, so an empty flagged list is not read as no regression; a measured metric still flags beside it (breaks if a null metric passes silently, or one unmeasured metric hides a measured regression)', () => {
  const att = (failed) => ({ newest: 100, attempts: 100, failed, failedThenOk: 0 });
  const compare = { baseline: 'b', candidate: 'c' };
  const flagsOf = (attempts, cmp = compare) => scorecard(relInput([...relRuns('b', 2), ...relRuns('c', 2)], attempts, { compare: cmp })).reliabilityFlags;
  assert.deepEqual(flagsOf(undefined), { flagged: [], unmeasured: ['runFailure', 'repairedJson'] }, 'cli.mjs passes no attempts');
  assert.deepEqual(flagsOf({ b: att(0), c: att(9) }), { flagged: ['runFailure'], unmeasured: ['repairedJson'] });
  assert.deepEqual(flagsOf({ b: att(0) }), { flagged: [], unmeasured: ['runFailure', 'repairedJson'] }, 'the candidate has no attempts row');
  assert.deepEqual(flagsOf({ b: att(0), c: att(0) }, { baseline: 'b', candidate: 'nobody' }), { flagged: [], unmeasured: ['runFailure', 'repairedJson'] }, 'a compare arm with no reliability row');
});

test('the new keys print no PR number and no item key: no key or leaf value of them, perArm cards included, is a fixture PR or a gold key (breaks if a key, a cluster or a PR id reaches a new field, or perArm prints prFalseAlarm.prs)', () => {
  // PR 9210 has no real Major and an engine major: it is the PR that prFalseAlarm would name.
  const zero = armRuns(BASE_ARM, [9210], { findings: [{ id: 'zf', sev: 'major' }] });
  const input = pairedInput({ cleanPrs: [9201], sets: { zeroMajorPrs: [9210] }, attempts: { [BASE_ARM]: { attempts: 3, newest: 3, failed: 1, failedThenOk: 0 } } });
  const card = scorecard({ ...input, runs: [...input.runs, ...zero] });
  const solo = card.perArm[BASE_ARM];
  assert.equal(solo.prFalseAlarm.count, 1, 'the fixture has a false alarm to leak');
  const newKeys = [card.pairedBar, card.lostCaughtMajors, card.cleanRise, card.reliability, card.reliabilityFlags, card.perArm];
  const seen = [];
  const walk = (x) => {
    if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) { seen.push(k); walk(v); } else seen.push(x);
  };
  walk(newKeys);
  const secret = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'c1', 'c2', 'c3', 'u1', '9210', ...pairedInput().matches.map((x) => String(x.pr)), ...pairedInput().matches.map((x) => String(x.key))]);
  assert.ok(seen.length > 40, 'the walk reached the new fields');
  assert.deepEqual(seen.filter((x) => [...secret].some((s) => String(x).includes(s))), []);
});

test('pipeline: two folders of raw rows, two arms, joinReplicates, evaluateRuns and scorecard give the paired bar, the lost count and the pooled arm recall (breaks if evaluateRuns, joinReplicates or scorecard loses the arm or the replicate between steps 1 and 5)', () => {
  const CR = 'cursor-review|-|-|-';
  const ENG = 'engine|v1|-|-';
  // 20 regression items on a.mjs and 20 capability items on b.mjs, 10 lines apart: 20 per suite is the cut of MIN_CELL.
  const lines = Array.from({ length: 20 }, (_, i) => 10 * (i + 1));
  const dataset = [...lines.map((line, i) => dsMajor(`9950:r${i}`, 9950, { path: 'a.mjs', startLine: line, endLine: line })), ...lines.map((line, i) => dsMajor(`9950:c${i}`, 9950, { path: 'b.mjs', startLine: line, endLine: line }))];
  const at = (file, line) => ({ file, line, severity: 'major', title: `t${file}${line}` });
  const files = { cr: lines.map((l) => at('a.mjs', l)), eng: lines.map((l) => at('b.mjs', l)), eng2: [...lines.map((l) => at('b.mjs', l)), { file: 'c.mjs', line: 5, severity: 'minor', title: 'u' }] };
  const folder = (engPath) => [armRow(9950, { reviewer: 'cursor-review', findingsPath: 'cr' }), armRow(9950, { reviewer: 'engine', findingsPath: engPath })];
  const ev = evaluateRuns({ runs: joinReplicates([folder('eng'), folder('eng2')]), dataset, readFindings: (p) => ({ findings: files[p] }) });
  assert.deepEqual(ev.runs.map((r) => [r.arm, r.replicate]).sort(), [[CR, 1], [CR, 2], [ENG, 1], [ENG, 2]]);
  const suites = Object.fromEntries(lines.flatMap((_, i) => [[`9950:r${i}`, 'regression'], [`9950:c${i}`, 'capability']]));
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: ev.runs, matches: ev.matches, attempts: ev.attempts, compare: { baseline: CR, candidate: ENG }, suites, B: 100 });
  assert.deepEqual([card.pairedBar.holdout.regression.n, card.pairedBar.holdout.regression.delta, card.pairedBar.holdout.capability.n, card.pairedBar.holdout.capability.delta], [20, -100, 20, 100]);
  assert.deepEqual(card.lostCaughtMajors.holdout, { count: 20, assessable: 40, flagged: true });
  for (const arm of [CR, ENG]) assert.deepEqual([card.perArm[arm].perMajorRecall.strictSameIssue.found, card.perArm[arm].perMajorRecall.strictSameIssue.total], [40, 80], arm);
  assert.deepEqual([card.reliability[ENG].findingsVariance, card.reliability[CR].findingsVariance, card.reliability[ENG].attempts], [0.25, 0, 2]);
});

test('pairedBar: a suite with no paired item has n 0 and no number, and says null for every wouldBe: it is under the cut of 20, so it never says PASS or FAIL (breaks if an empty suite passes or fails)', () => {
  const card = scorecard({ sets: {}, runs: armRuns(BASE_ARM, [9201]), matches: [], compare: { baseline: BASE_ARM, candidate: CAND_ARM } });
  assert.deepEqual([card.pairedBar.holdout.regression.n, card.pairedBar.holdout.regression.delta, card.pairedBar.holdout.regression.wouldBe, card.pairedBar.holdout.capability.wouldBe, card.pairedBar.holdout.unassigned.wouldBe], [0, null, null, null, null]);
});

// ---------- re-score-paired fix round 1: tests that fail on a wrong change ----------

test('a newest-row tie or an unreadable ts: the later line wins (breaks if the earlier line wins a tie or a missing ts)', () => {
  const tie = [armRow(9010, { reviewer: 'engine', findingsPath: 'miss' }), armRow(9010, { reviewer: 'engine', findingsPath: 'hit' })];
  const noTs = [armRow(9011, { reviewer: 'engine', findingsPath: 'miss', ts: undefined }), armRow(9011, { reviewer: 'engine', findingsPath: 'hit', ts: undefined })];
  const unreadable = [armRow(9012, { reviewer: 'engine', findingsPath: 'miss', ts: 'not a date' }), armRow(9012, { reviewer: 'engine', findingsPath: 'hit', ts: 'not a date' })];
  for (const [rows, pr] of [[tie, 9010], [noTs, 9011], [unreadable, 9012]]) {
    const ev = evaluateRuns({ runs: rows, dataset: [dsMajor(`${pr}:1`, pr)], readFindings: hitRead });
    assert.equal(ev.runs.length, 1, String(pr));
    assert.deepEqual(ev.matches.map((x) => x.engSev), ['major'], `${pr}: the second line is the hit`);
  }
});

test('attempts: a group that failed and then ended incomplete counts as failedThenOk (breaks if failedThenOk needs an ok newest row)', () => {
  const rows = [armRow(9013, { reviewer: 'engine', status: 'failed', ts: '2026-11-03T01:00:00Z' }), armRow(9013, { reviewer: 'engine', status: 'incomplete', ts: '2026-11-03T02:00:00Z' })];
  assert.deepEqual(evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).attempts['engine|v1|-|-'], { attempts: 2, newest: 1, failed: 0, failedThenOk: 1, invalidReplicate: 0 });
});

test('armKeyOf groups old rows like the spend ledger: an engine row with no promptVersion joins v1, other reviewers ignore promptVersion, no reviewer is its own arm (breaks if a fallback or the engine-only version rule changes)', () => {
  const rows = [{ reviewer: 'engine' }, { reviewer: 'engine', promptVersion: 'v1' }, { reviewer: 'engine', promptVersion: 'v2' }, { reviewer: 'cursor-review', promptVersion: 'v3' }, { reviewer: 'cursor-review' }, {}];
  assert.deepEqual(rows.map((r) => rows.findIndex((o) => armKeyOf(o) === armKeyOf(r))), [0, 0, 2, 3, 3, 5]);
});

test('a one-arm card counts every match row even when the rows carry no reviewer, and an engine arm with a promptVersion other than v1 keeps its matches in perArm (breaks if the one-arm branch filters matches by arm, or the filter reads the wrong arm key)', () => {
  const oneArm = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: armRuns('engine|v1|-|-', [9301]).map((r) => ({ ...r, arm: undefined, reviewer: undefined })), matches: itemRows(undefined, 'o1', 9301, [1, 0, 1]).map((m) => ({ ...m, arm: undefined, replicate: undefined })) });
  assert.equal(oneArm.perMajorRecall.strict.total, 3, 'runs and rows with no reviewer are one arm that owns every row');
  const dataset = [dsMajor('9302:1', 9302), dsMajor('9303:1', 9303)];
  const rows = [armRow(9302, { reviewer: 'engine', promptVersion: 'v2' }), armRow(9303, { reviewer: 'cursor-review' })];
  const ev = evaluateRuns({ runs: rows, dataset, readFindings: hitRead });
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: ev.runs, matches: ev.matches });
  assert.deepEqual(card.arms, ['cursor-review|-|-|-', 'engine|v2|-|-']);
  for (const arm of card.arms) assert.deepEqual([arm, card.perArm[arm].perMajorRecall.strict.total, card.perArm[arm].perMajorRecall.strict.found], [arm, 1, 1]);
});

test('lostCaughtMajors needs the baseline to catch in every replicate and 2 or more replicates on each side (breaks if every becomes some, or the replicate floor on the baseline side is dropped)', () => {
  const rowsFor = (key, pr, base, cand) => [...itemRows(BASE_ARM, key, pr, base), ...itemRows(CAND_ARM, key, pr, cand)];
  const matches = [
    ...rowsFor('l1', 9311, [1, 1], [0, 0]), // lost
    ...rowsFor('l2', 9312, [1, 0], [0, 0]), // the baseline missed one replicate: not lost
    ...rowsFor('l3', 9313, [1], [0, 0]), // one baseline replicate: not lost
    ...rowsFor('l4', 9314, [1, 1], [0]), // one candidate replicate: not lost
    ...rowsFor('l5', 9315, [1, 1], [0, 1]), // the candidate caught one: not lost
  ];
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9311]), ...armRuns(CAND_ARM, [9311])], matches, compare: { baseline: BASE_ARM, candidate: CAND_ARM } });
  assert.deepEqual(card.lostCaughtMajors.holdout, { count: 1, assessable: 3, flagged: true });
});

test('paired items are real Majors only: critical counts, a noise verdict and a minor severity do not, and an engine minor at the place is a miss (breaks if crVerdict, the critical fold or the strict catch rule changes)', () => {
  const row = (arm, key, pr, over) => ({ key, pr, set: 'holdout', arm, replicate: 1, crSev: 'major', crVerdict: 'real', crSource: 'inline', engSev: null, engPairId: null, ...over });
  const both = (key, pr, base, cand) => [row(BASE_ARM, key, pr, base), row(CAND_ARM, key, pr, cand)];
  const matches = [
    ...both('n1', 9321, { crSev: 'critical', engSev: 'critical' }, { crSev: 'critical', engSev: null }), // counts: base catches, cand misses
    ...both('n2', 9322, { crVerdict: 'noise', engSev: 'major' }, { crVerdict: 'noise', engSev: null }), // noise: no item
    ...both('n3', 9323, { engSev: 'major' }, { engSev: 'minor' }), // a minor engine finding is a miss
    ...both('n4', 9324, { crSev: 'minor', engSev: 'major' }, { crSev: 'minor', engSev: null }), // a minor dataset finding: no item
  ];
  const suites = { n1: 'regression', n2: 'regression', n3: 'regression', n4: 'regression' };
  const input = fan({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9321]), ...armRuns(CAND_ARM, [9321])], matches, suites, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50 }, 10);
  const bar = scorecard(input).pairedBar.holdout.regression;
  assert.deepEqual([bar.n, bar.unpaired, bar.delta, bar.d], [20, 0, -100, 1]);
});

test('the default cluster of a paired item is its PR: two items on one PR move together; the bounds match an explicit PR cluster and differ from one cluster per item (breaks if the default is the item key or one cluster per row)', () => {
  // 10 PRs of 2 items: 20 items, the cut of MIN_CELL. The candidate catches both items of the first 5 PRs.
  const prs = Array.from({ length: 10 }, (_, i) => 9331 + i);
  const keys = prs.flatMap((pr) => [`p${pr}a`, `p${pr}b`]);
  const matchesFor = (clusterOf) => prs.flatMap((pr, i) => ['a', 'b'].flatMap((s) => {
    const over = clusterOf(pr, `p${pr}${s}`);
    return [...itemRows(BASE_ARM, `p${pr}${s}`, pr, [0], over), ...itemRows(CAND_ARM, `p${pr}${s}`, pr, [i < 5 ? 1 : 0], over)];
  }));
  const bar = (clusterOf) => {
    const r = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9331]), ...armRuns(CAND_ARM, [9331])], matches: matchesFor(clusterOf), suites: Object.fromEntries(keys.map((k) => [k, 'regression'])), compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 2000, seed: 9 }).pairedBar.holdout.regression;
    return [r.delta, r.lo, r.hi];
  };
  const byDefault = bar(() => ({}));
  // Fixed values: the delta is 50 points. Over 10 PR clusters the share of candidate-caught clusters is Binomial(10, 0.5) / 10: its 2.5th and 97.5th percentiles are 2 and 8, so 20 and 80.
  assert.deepEqual(byDefault, [50, 20, 80]);
  assert.deepEqual(bar((pr) => ({ cluster: `#${pr}` })), [50, 20, 80], 'an explicit PR cluster gives the same bounds');
  assert.deepEqual(bar((pr, key) => ({ cluster: key })), [50, 30, 70], 'one cluster per item: Binomial(20, 0.5) gives 6 and 14 of 20, so 30 and 70');
});

/** Real Major rows of the base arm, one replicate each. specs: [[key, pr, catches, over]]. */
const goldRows = (specs) => specs.flatMap(([key, pr, catches, over]) => itemRows(BASE_ARM, key, pr, catches, over));
const goldCard = (matches, extra = {}) => scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: armRuns(BASE_ARM, [9400]), matches, ...extra });

test('perSuite, perSource and goldARecall use same-issue recall on eligible rows: a label with sameIssue false is not a find; a stale-hash row and a full-body row add nothing to any total (breaks if recall reads the raw strict find or the unfiltered rows)', () => {
  const matches = goldRows([
    ['g1', 9401, [1]], ['g2', 9402, [1], { engPairId: 'pz' }], ['g3', 9403, [0]],
    ['g4', 9404, [1], { promptSha256: 'OLD' }], ['g5', 9405, [1], { bodyMode: 'full' }],
  ]);
  const sources = { g1: 'A', g2: 'A', g3: 'A', g4: 'A', g5: 'A' };
  const suites = { g1: 'capability', g2: 'capability', g3: 'capability', g4: 'capability', g5: 'capability' };
  const labels = [{ findingId: 'pz', pairId: 'pz', verdict: 'real', sameIssue: false, by: 'dave' }];
  const card = goldCard(matches, { sources, suites, labels });
  assert.deepEqual([card.perSource.holdout.A.found, card.perSource.holdout.A.total], [1, 3], 'g2 is a different issue; g4 and g5 are out');
  assert.deepEqual([card.perSuite.holdout.capability.found, card.perSuite.holdout.capability.total], [1, 3]);
  assert.deepEqual([card.goldARecall.holdout.found, card.goldARecall.holdout.total], [1, 3]);
  const noLabel = goldCard(matches, { sources, suites });
  assert.deepEqual([noLabel.perSource.holdout.A.found, noLabel.goldARecall.holdout.found, noLabel.perSuite.holdout.capability.found], [2, 2, 2], 'without the label the same row is a find');
});

test('a cell prints no value below 20 real Majors, not even at 19, and prints it at 20 (breaks if the cut moves in either direction)', () => {
  const cellAt = (n) => goldCard(goldRows(Array.from({ length: n }, (_, i) => [`m${i}`, 9500 + i, [i % 2]])), { sources: Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, 'A'])) }).perSource.holdout.A;
  assert.deepEqual(cellAt(19), { found: 9, total: 19, value: null });
  assert.deepEqual(cellAt(20), { found: 10, total: 20, value: 0.5 });
});

test('cleanFalseMajor ignores a stale-hash run and a run with incomplete coverage, and keeps one control per PR: runs of 0 and 2 false Majors on one PR give perPr 1 and null bounds, and two identical controls give bounds 1 and 1 (breaks if the filters are skipped or the CI resamples runs)', () => {
  const clean = (pr, replicate, sevs, over = {}) => ({ set: 'holdout', pr, round: 1, status: 'ok', arm: BASE_ARM, replicate, promptSha256: 'P0', findings: sevs.map((s, i) => ({ id: `f${i}`, sev: s })), ...over });
  const runs = [clean(9601, 1, []), clean(9601, 2, ['major', 'critical']), clean(9601, 3, ['major', 'major', 'major'], { promptSha256: 'OLD' }), clean(9601, 4, ['major'], { coverageComplete: false })];
  const c = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs, matches: [], cleanPrs: [9601], B: 400, seed: 3 }).cleanFalseMajor.holdout;
  assert.deepEqual([c.controls, c.runs, c.falseMajors, c.perPr, c.lo, c.hi], [1, 2, 2, 1, null, null], 'one control is no interval');
  const two = [...runs, clean(9602, 1, []), clean(9602, 2, ['major', 'critical'])];
  const c2 = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: two, matches: [], cleanPrs: [9601, 9602], B: 400, seed: 3 }).cleanFalseMajor.holdout;
  assert.deepEqual([c2.controls, c2.runs, c2.falseMajors, c2.perPr, c2.lo, c2.hi], [2, 4, 4, 1, 1, 1], 'two identical controls: the stale and incomplete runs still leave');
});

test('reliability: repairedJson counts ok rows only, so an incomplete row with the flag leaves the share at 0.25; p95WallMs skips a run with incomplete coverage (breaks if the denominator or the valid filter changes)', () => {
  const incomplete = { set: 'holdout', pr: 9790, round: 1, sha40: sha9, status: 'incomplete', arm: 'a', replicate: 1, promptSha256: 'P0', repairedJson: true, durationMs: 99999, coverageComplete: false, findings: [] };
  const runs = [...relRuns('a', 4, (i) => ({ repairedJson: i === 0, durationMs: 100 })), incomplete];
  const rel = scorecard(relInput(runs, {})).reliability.a;
  assert.equal(rel.repairedJson, 0.25);
  assert.equal(rel.p95WallMs, 100);
});

// ---------- re-score-paired fix round 2: tests that fail on a wrong change ----------

test('perSuite, perSource and goldARecall count distinct real Majors, not replicate rows: 10 keys x 2 replicates stay under the cut; a half-caught key adds half a find; goldARecall gives value and ci at 20 (breaks if a cell counts match rows, or goldARecall.value is always null)', () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => `q${i}`);
  const rowsOf = (n, catches) => keys(n).flatMap((k, i) => itemRows(BASE_ARM, k, 9800 + i, catches(i)));
  const asA = (n) => Object.fromEntries(keys(n).map((k) => [k, 'A']));
  const asSuite = (n) => Object.fromEntries(keys(n).map((k) => [k, 'capability']));
  const ten = goldCard(rowsOf(10, () => [1, 1]), { sources: asA(10), suites: asSuite(10) });
  assert.deepEqual(ten.perSource.holdout.A, { found: 10, total: 10, value: null }, '20 rows, 10 items');
  assert.deepEqual([ten.perSuite.holdout.capability.total, ten.perSuite.holdout.capability.value], [10, null]);
  assert.deepEqual(ten.goldARecall.holdout, { found: 10, total: 10, value: null, ci: { lo: null, hi: null } });
  const twenty = goldCard(rowsOf(20, (i) => (i < 10 ? [1, 1] : (i < 12 ? [1, 0] : [0, 0]))), { sources: asA(20), suites: asSuite(20) });
  assert.deepEqual(twenty.perSource.holdout.A, { found: 11, total: 20, value: 0.55 });
  assert.deepEqual(twenty.perSuite.holdout.capability, { found: 11, total: 20, value: 0.55 });
  assert.deepEqual(twenty.goldARecall.holdout, { found: 11, total: 20, value: 0.55, ci: wilson(11, 20) });
});

test('a source C row is its own source and CR does not take it (breaks if C is dropped from the source list)', () => {
  const card = goldCard(goldRows([['c0', 9810, [1]], ['x0', 9811, [0]]]), { sources: { c0: 'C' } });
  assert.deepEqual(card.perSource.holdout.C, { found: 1, total: 1, value: null });
  assert.deepEqual(card.perSource.holdout.CR, { found: 0, total: 1, value: null });
});

test('attempts: every status except ok and incomplete is a failure (cap, tree_unbuildable, frozen, refused, failed) (breaks if the failure test narrows to one status)', () => {
  const rows = ['cap', 'tree_unbuildable', 'frozen', 'refused', 'failed'].map((status, i) => armRow(9820 + i, { reviewer: 'engine', status }));
  assert.deepEqual(evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).attempts['engine|v1|-|-'], { attempts: 5, newest: 5, failed: 5, failedThenOk: 0, invalidReplicate: 0 });
});

test('attempts: a failure keeps counting across two newer ok rows of one group (breaks if the earlier failure is dropped when a third row arrives)', () => {
  const t = (n) => `2026-11-03T0${n}:00:00Z`;
  const rows = [armRow(9825, { reviewer: 'engine', status: 'failed', ts: t(1) }), armRow(9825, { reviewer: 'engine', status: 'ok', ts: t(2) }), armRow(9825, { reviewer: 'engine', status: 'ok', ts: t(3) })];
  assert.deepEqual(evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).attempts['engine|v1|-|-'], { attempts: 3, newest: 1, failed: 0, failedThenOk: 1, invalidReplicate: 0 });
});

test('attempts: an incomplete row before an ok row is not a failure, so failedThenOk stays 0 (breaks if the earlier-row test reads status !== ok)', () => {
  const rows = [armRow(9826, { reviewer: 'engine', status: 'incomplete', ts: '2026-11-03T01:00:00Z' }), armRow(9826, { reviewer: 'engine', status: 'ok', ts: '2026-11-03T02:00:00Z' })];
  assert.deepEqual(evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).attempts['engine|v1|-|-'], { attempts: 2, newest: 1, failed: 0, failedThenOk: 0, invalidReplicate: 0 });
});

test('joinReplicates: only an undefined replicate takes the folder number, and that number is 1-based; 1.5, a string and null stay as they are (breaks if an invalid replicate is replaced by the folder number)', () => {
  const joined = joinReplicates([[{ pr: 9830 }], [{ pr: 9831, replicate: 1.5 }, { pr: 9832, replicate: '3' }, { pr: 9833, replicate: null }, { pr: 9834 }]]);
  assert.deepEqual(joined.map((r) => r.replicate), [1, 1.5, '3', null, 2]);
});

test('armKeyOf ignores an armId that is not a string (breaks if a truthy armId passes as the key)', () => {
  assert.equal(armKeyOf({ armId: 5, reviewer: 'engine' }), 'engine|v1|-|-');
});

test('two ok rows that differ only in sha40 are two runs (breaks if sha40 leaves the newest-row key)', () => {
  const rows = [armRow(9835, { reviewer: 'engine' }), armRow(9835, { reviewer: 'engine', sha40: '8'.repeat(40) })];
  assert.equal(evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).runs.length, 2);
});

test('engine finding ids stay unique across arms and replicates of one round (breaks if the id drops the arm or the replicate)', () => {
  const rows = [armRow(9840, { reviewer: 'engine' }), armRow(9840, { reviewer: 'cursor-review' }), armRow(9840, { reviewer: 'engine', replicate: 2 }), armRow(9840, { reviewer: 'cursor-review', replicate: 2 })];
  const ids = evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead }).runs.flatMap((r) => r.findings.map((f) => f.id));
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});

test('pairedBar nNeeded for regression rounds up: d 0.25 gives 385, not 384 (breaks if ceil becomes round)', () => {
  const four = [[[1], [0]], [[1], [1]], [[0], [0]], [[0], [0]]];
  const reg = oneClusterBar('regression', [...four, ...four, ...four]);
  assert.deepEqual([reg.n, reg.d, reg.nNeeded], [24, 0.25, 385], '12 items in each of 2 identical clusters');
});

test('pairedBar counts an item that only the candidate has as unpaired too (breaks if the item keys come from the baseline alone)', () => {
  const input = pairedInput();
  const withCandOnly = { ...input, matches: [...input.matches, ...itemRows(CAND_ARM, 'r6', 9210, [1, 1])], suites: { ...input.suites, r6: 'regression' } };
  const reg = scorecard(withCandOnly).pairedBar.holdout.regression;
  assert.deepEqual([reg.n, reg.unpaired], [4, 2]);
});

test('pairedBar leaves a full-body holdout item out of both arms (breaks if the paired items skip the leak rule)', () => {
  const input = pairedInput();
  const leaked = { ...input, matches: input.matches.map((x) => (x.key === 'r2' ? { ...x, bodyMode: 'full' } : x)) };
  assert.equal(scorecard(leaked).pairedBar.holdout.regression.n, 3);
  assert.equal(scorecard(input).pairedBar.holdout.regression.n, 4);
});

test('reliability: p95WallMs of 10 runs is the 10th value, not the 9th (breaks if the rank uses an interpolation index)', () => {
  const runs = relRuns('a', 10, (i) => ({ durationMs: i + 1 }));
  assert.equal(scorecard(relInput(runs, {})).reliability.a.p95WallMs, 10);
});

test('reliability: runFailure divides by the newest rows, not by every attempt (breaks if the denominator is attempts)', () => {
  const att = { a: { attempts: 6, newest: 4, failed: 1, failedThenOk: 2 } };
  assert.equal(scorecard(relInput(relRuns('a', 4), att)).reliability.a.runFailure, 0.25);
});

test('reliability: findingsVariance does not merge two rounds of one PR: one replicate per round gives null (breaks if round leaves the group key)', () => {
  const fnd = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, sev: 'minor' }));
  const rep = (round, n) => ({ set: 'holdout', pr: 9845, round, sha40: sha9, status: 'ok', arm: 'a', replicate: 1, promptSha256: 'P0', findings: fnd(n) });
  assert.equal(scorecard(relInput([rep(1, 2), rep(2, 4)], {})).reliability.a.findingsVariance, null);
});

test('cleanRise is false when both arms have the same false-Major rate (breaks if the rise test becomes >=)', () => {
  const clean = (arm) => ({ set: 'holdout', pr: 9850, round: 1, status: 'ok', arm, replicate: 1, promptSha256: 'P0', findings: [{ id: 'f0', sev: 'major' }] });
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [clean(BASE_ARM), clean(CAND_ARM)], matches: [], cleanPrs: [9850], B: 50, compare: { baseline: BASE_ARM, candidate: CAND_ARM } });
  assert.equal(card.cleanRise.holdout, false);
});

// ---------- re-score-paired fix round 3: dev and holdout apart, frozen hash per arm, assessable, clean controls by PR ----------

const asDev = { set: 'dev' };
const keepDev = (card) => ({ perSuite: card.perArm[BASE_ARM].perSuite.dev, perSource: card.perArm[BASE_ARM].perSource.dev, goldARecall: card.perArm[BASE_ARM].goldARecall.dev, pairedBar: card.pairedBar.dev, lostCaughtMajors: card.lostCaughtMajors.dev });

test('D3 perSuite, perSource and goldARecall keep one cell per set: the same item key in dev and holdout never shares a cell (breaks if a cell pools dev rows with holdout rows)', () => {
  const rows = [...itemRows(BASE_ARM, 'k1', 9901, [1, 1]), ...itemRows(BASE_ARM, 'k1', 9901, [0, 0], asDev)];
  const card = goldCard(rows, { sources: { k1: 'A' }, suites: { k1: 'capability' } });
  assert.deepEqual(card.perSource.holdout.A, { found: 1, total: 1, value: null });
  assert.deepEqual(card.perSource.dev.A, { found: 0, total: 1, value: null });
  assert.deepEqual([card.perSuite.holdout.capability.found, card.perSuite.dev.capability.found], [1, 0]);
  assert.deepEqual([card.goldARecall.holdout.found, card.goldARecall.holdout.total, card.goldARecall.dev.found, card.goldARecall.dev.total], [1, 1, 0, 1]);
  assert.deepEqual(goldCard([], {}).goldARecall.dev, { found: 0, total: 0, value: null, ci: { lo: null, hi: null } });
});

test('D3 pairedBar and lostCaughtMajors are one cell per set, and a holdout-only change leaves every dev cell as it was (breaks if the paired items pool both sets, or a holdout row moves a dev number)', () => {
  // 20 copies of the item in each set: the cells reach the cut of 20 and print numbers.
  const withCand = (holdoutCand) => scorecard(fan({
    sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9911]), ...armRuns(CAND_ARM, [9911])], compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50,
    suites: { k1: 'regression' }, sources: { k1: 'A' },
    matches: [...itemRows(BASE_ARM, 'k1', 9911, [1, 1]), ...itemRows(CAND_ARM, 'k1', 9911, holdoutCand), ...itemRows(BASE_ARM, 'k1', 9911, [0, 0], asDev), ...itemRows(CAND_ARM, 'k1', 9911, [1, 1], asDev)],
  }, 20));
  const lost = withCand([0, 0]);
  assert.deepEqual([lost.pairedBar.holdout.regression.delta, lost.pairedBar.dev.regression.delta], [-100, 100]);
  assert.deepEqual([lost.pairedBar.holdout.regression.n, lost.pairedBar.dev.regression.n], [20, 20]);
  assert.deepEqual([lost.lostCaughtMajors.holdout.count, lost.lostCaughtMajors.dev.count], [20, 0]);
  const kept = withCand([1, 1]);
  assert.equal(kept.pairedBar.holdout.regression.delta, 0);
  assert.notDeepEqual(kept.perArm[CAND_ARM].perSuite.holdout, lost.perArm[CAND_ARM].perSuite.holdout);
  assert.deepEqual(keepDev(kept), keepDev(lost));
});

const cleanRun = (pr, replicate, sevs, over = {}) => ({ set: 'holdout', pr, round: 1, status: 'ok', arm: BASE_ARM, replicate, promptSha256: 'P0', findings: sevs.map((s, i) => ({ id: `f${i}`, sev: s })), ...over });
const cleanCard = (runs, cleanPrs, extra = {}) => scorecard({ sets: {}, frozenPromptSha256: 'P0', runs, matches: [], cleanPrs, B: 400, seed: 3, ...extra }).cleanFalseMajor.holdout;

test('D4 cleanFalseMajor counts a control as one distinct clean PR, not a run: 8 clean PRs with 2 runs each give controls 8 (breaks if controls counts runs)', () => {
  const prs = Array.from({ length: 8 }, (_, i) => 9950 + i);
  const runs = prs.flatMap((pr) => [cleanRun(pr, 1, ['major']), cleanRun(pr, 2, ['major'])]);
  const c = cleanCard(runs, prs);
  assert.deepEqual([c.controls, c.falseMajors, c.perPr], [8, 16, 1]);
});

test('D4 cleanFalseMajor perPr is the mean over clean PRs of the false Majors of each PR averaged over its runs: a PR with 1 run of 4 Majors and a PR with 3 runs of 0 give 2, not 1 (breaks if perPr pools runs)', () => {
  const runs = [cleanRun(9960, 1, ['major', 'major', 'critical', 'major']), cleanRun(9961, 1, []), cleanRun(9961, 2, []), cleanRun(9961, 3, [])];
  const c = cleanCard(runs, [9960, 9961, 9962]);
  assert.deepEqual([c.controls, c.perPr], [2, 2], 'PR 9962 has no valid run: not a control');
  assert.ok(c.lo >= 0 && c.hi <= 4 && c.lo <= 2 && c.hi >= 2, `${c.lo} ${c.hi}`);
});

test('D4 cleanFalseMajor resamples PRs, each with all its runs: two PRs whose runs have 0 and 2 false Majors give lo === hi === perPr === 1 (breaks if the CI resamples runs)', () => {
  const twoRuns = (pr) => [cleanRun(pr, 1, []), cleanRun(pr, 2, ['major', 'critical'])];
  const c = cleanCard([...twoRuns(9965), ...twoRuns(9966)], [9965, 9966]);
  assert.deepEqual([c.controls, c.perPr, c.lo, c.hi], [2, 1, 1, 1]);
});

test('pairedBar counts clusters; under 2 clusters wouldBe is FAIL even at no change, and a regression suite with no discordant item has no nNeeded (breaks if one cluster can PASS, clusters is missing, or nNeeded is 0 at d 0)', () => {
  const same = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? [[1, 1], [1, 1]] : [[0, 0], [0, 0]]));
  const one = oneClusterBar('regression', same(20), ['x']);
  assert.deepEqual([one.clusters, one.n, one.delta, one.lo, one.wouldBe, one.d, one.nNeeded], [1, 20, 0, 0, 'FAIL', 0, null]);
  const two = oneClusterBar('regression', same(10));
  assert.deepEqual([two.clusters, two.n, two.wouldBe], [2, 20, 'PASS']);
  assert.equal(oneClusterBar('capability', Array.from({ length: 20 }, () => [[0, 0], [1, 1]]), ['x']).wouldBe, 'FAIL');
  assert.equal(oneClusterBar('regression', same(2), ['x']).wouldBe, null, 'one cluster of 2 items is under the cut: no word at all');
  const underCut = oneClusterBar('regression', same(2));
  assert.deepEqual([underCut.clusters, underCut.n, underCut.delta, underCut.wouldBe], [2, 4, null, null], 'two clusters and 4 items said PASS before the cut; now no word');
  assert.equal(scorecard(pairedInput()).pairedBar.holdout.regression.clusters, 4, 'default cluster is the PR');
});

const V1 = 'engine|v1|-|-';
const V2 = 'engine|v2|-|-';
/** Two engine prompt versions on the holdout, 2 replicates each. v1 finds the Major in both replicates; v2 misses it in both. Each version has its own prompt hash. */
function twoVersionCard(extra = {}, v2Hash = 'H2') {
  const row = (version, replicate) => armRow(9970, { reviewer: 'engine', promptVersion: version, promptSha256: version === 'v1' ? 'H1' : v2Hash, replicate, findingsPath: version === 'v1' ? 'hit' : 'miss' });
  const raw = [1, 2].flatMap((rep) => [row('v1', rep), row('v2', rep)]);
  const ev = evaluateRuns({ runs: raw, dataset: [dsMajor('9970:1', 9970)], readFindings: hitRead });
  return scorecard({ sets: {}, frozenPromptSha256: 'H1', frozenByReviewer: { engine: 'H1' }, runs: ev.runs, matches: ev.matches, attempts: ev.attempts, compare: { baseline: V1, candidate: V2 }, suites: { '9970:1': 'regression' }, B: 50, ...extra });
}

test('D1 frozenByArm gives each engine prompt version its own frozen hash: v2 losing a Major that v1 catches in 2 of 2 replicates counts 1, and no arm card reads stale (breaks if the frozen hash is picked per reviewer, or scoreOne drops frozenByArm)', () => {
  const card = twoVersionCard({ frozenByArm: { [V1]: 'H1', [V2]: 'H2' } });
  assert.equal(card.lostCaughtMajors.holdout.count, 1);
  assert.deepEqual([card.excludedRuns, card.perArm[V1].excludedRuns, card.perArm[V2].excludedRuns], [0, 0, 0]);
  assert.deepEqual([card.perArm[V1].perMajorRecall.strict.total, card.perArm[V2].perMajorRecall.strict.total, card.pairedBar.holdout.regression.n], [2, 2, 1]);
});

test('D1 an arm with no frozenByArm entry keeps the reviewer rule: v2 reads stale and the pair is not assessed (breaks if frozenByArm replaces the whole reviewer rule)', () => {
  const card = twoVersionCard({ frozenByArm: { [V1]: 'H1' } });
  assert.equal(card.perArm[V2].excludedRuns, 2);
  assert.equal(card.lostCaughtMajors.holdout.count, 0);
});

const lostOf = (matches) => scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9980]), ...armRuns(CAND_ARM, [9980])], matches, compare: { baseline: BASE_ARM, candidate: CAND_ARM } }).lostCaughtMajors.holdout;
const both = (key, pr, base, cand) => [...itemRows(BASE_ARM, key, pr, base), ...itemRows(CAND_ARM, key, pr, cand)];

test('D2 lostCaughtMajors.assessable counts the items with 2 or more replicates on both arms; a 1-replicate screen has assessable 0 and flagged null, not a silent count 0 (breaks if assessable is missing or flagged is false at 0 assessable)', () => {
  assert.deepEqual(lostOf([...both('a1', 9981, [1], [0]), ...both('a2', 9982, [1], [0])]), { count: 0, assessable: 0, flagged: null });
  assert.deepEqual(lostOf([]), { count: 0, assessable: 0, flagged: null }, 'no item at all');
  const mixed = lostOf([...both('b1', 9983, [1, 1], [0, 0]), ...both('b2', 9984, [1, 1], [1, 1]), ...both('b3', 9985, [1, 1], [0]), ...both('b4', 9986, [1], [0, 0])]);
  assert.deepEqual(mixed, { count: 1, assessable: 2, flagged: true }, 'b3 and b4 have 1 replicate on one side: not assessable');
  assert.deepEqual(lostOf(both('c1', 9987, [1, 1], [1, 0])), { count: 0, assessable: 1, flagged: false });
});

test('D1 frozenByArm beats the reviewer hash: a v2 row that carries the reviewer and v1 hash H1 is stale for v2, and the paired bar skips it (breaks if a row passes on the arm hash OR the reviewer hash, or on any value in frozenByArm)', () => {
  const card = twoVersionCard({ frozenByArm: { [V1]: 'H1', [V2]: 'H2' } }, 'H1');
  assert.equal(card.perArm[V2].excludedRuns, 2);
  assert.equal(card.perArm[V1].excludedRuns, 0);
  assert.deepEqual([card.pairedBar.holdout.regression.n, card.pairedBar.holdout.regression.unpaired], [0, 1]);
  assert.equal(card.lostCaughtMajors.holdout.assessable, 0);
});

test('D1 an empty-string frozenByArm entry is no hash: the arm falls back to the reviewer hash, so a stale v2 row is excluded (breaks if an empty entry turns the stale check off for its arm)', () => {
  const card = twoVersionCard({ frozenByArm: { [V1]: 'H1', [V2]: '' } });
  assert.equal(card.perArm[V2].excludedRuns, 2, 'v2 rows carry H2; the reviewer hash is H1');
  assert.equal(card.lostCaughtMajors.holdout.count, 0);
});

// ---------- re-score-paired fix round 4: clean controls per set, unmeasured reliability, pinned weights ----------

test('D5 cleanFalseMajor is one cell per set: a holdout clean run and a dev clean run never share a cell, and a run with no set is in neither (breaks if the clean runs of both sets are pooled, or an unset run counts)', () => {
  const noSet = cleanRun(9971, 1, ['major', 'major'], {});
  delete noSet.set;
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', cleanPrs: [9970, 9971, 9972], B: 50, matches: [], runs: [cleanRun(9970, 1, ['major']), cleanRun(9972, 1, ['major', 'major', 'critical'], { set: 'dev' }), noSet, cleanRun(9971, 2, ['major'], { set: null })] });
  const [h, d] = [card.cleanFalseMajor.holdout, card.cleanFalseMajor.dev];
  assert.deepEqual([h.controls, h.falseMajors, h.perPr], [1, 1, 1]);
  assert.deepEqual([d.controls, d.falseMajors, d.perPr], [1, 3, 3]);
  assert.deepEqual([h.lo, h.hi, d.lo, d.hi], [null, null, null, null], 'cleanPrs names 3 PRs but each set has 1 control with a valid run: no interval');
});

const riseRuns = (spec) => spec.map(([arm, pr, sevs, over]) => cleanRun(pr, 1, sevs, { arm, ...over }));
const riseOf = (spec, cleanPrs) => scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: riseRuns(spec), matches: [], cleanPrs, B: 50, compare: { baseline: BASE_ARM, candidate: CAND_ARM } }).cleanRise;

test('D5 cleanRise compares the arms on the clean PRs both have a valid run on: a candidate that lost a PR is not scored on the easier rest; no shared PR gives null (breaks if each arm keeps its own PR set, or an empty overlap gives false)', () => {
  const lostHard = riseOf([[BASE_ARM, 9973, []], [BASE_ARM, 9974, ['major', 'major', 'major', 'major']], [CAND_ARM, 9973, ['major']]], [9973, 9974]);
  assert.equal(lostHard.holdout, true, 'shared PR 9973 only: baseline 0, candidate 1');
  const apart = riseOf([[BASE_ARM, 9975, []], [CAND_ARM, 9976, ['major']]], [9975, 9976]);
  assert.deepEqual(apart, { holdout: null, dev: null });
  const stale = riseOf([[BASE_ARM, 9977, []], [CAND_ARM, 9977, ['major']], [BASE_ARM, 9978, [], {}], [CAND_ARM, 9978, [], { coverageComplete: false }]], [9977, 9978]);
  assert.equal(stale.holdout, true, 'a run with incomplete coverage is not a valid run, so 9978 is not shared');
});

test('D5 cleanRise is one value per set: a dev-only rise leaves the holdout value as it was (breaks if dev and holdout clean runs are pooled in the rise)', () => {
  const holdout = [[BASE_ARM, 9979, ['major']], [CAND_ARM, 9979, []]];
  const dev = [[BASE_ARM, 9980, [], { set: 'dev' }], [CAND_ARM, 9980, ['major', 'major', 'major'], { set: 'dev' }]];
  assert.deepEqual(riseOf([...holdout, ...dev], [9979, 9980]), { holdout: false, dev: true });
  assert.deepEqual(riseOf(holdout, [9979, 9980]), { holdout: false, dev: null });
});

test('D4 cleanFalseMajor CI weights each PR by 1 / its runs: one draw that holds a 1-run PR of 4 Majors and a 3-run PR of 0 gives 2 on both bounds, not the pooled 1 (breaks if the CI statistic pools runs)', () => {
  const runs = [cleanRun(9985, 1, ['major', 'major', 'critical', 'major']), cleanRun(9986, 1, []), cleanRun(9986, 2, []), cleanRun(9986, 3, [])];
  const c = cleanCard(runs, [9985, 9986], { B: 1, seed: 1 });
  assert.deepEqual([c.perPr, c.lo, c.hi], [2, 2, 2]);
});

test('D3 a match row with no set is in neither the holdout cell nor the dev cell of perSuite, perSource, goldARecall, pairedBar or lostCaughtMajors (breaks if an unset row is read as holdout or dev)', () => {
  const noSet = (rows) => rows.map(({ set, ...rest }) => rest);
  const inSets = [...itemRows(BASE_ARM, 'k1', 9990, [1, 1]), ...itemRows(CAND_ARM, 'k1', 9990, [0, 0]), ...itemRows(BASE_ARM, 'k1', 9990, [0, 0], asDev), ...itemRows(CAND_ARM, 'k1', 9990, [1, 1], asDev)];
  const stray = [...noSet(itemRows(BASE_ARM, 'k1', 9990, [0, 0])), ...noSet(itemRows(CAND_ARM, 'k1', 9990, [1, 1])), ...itemRows(BASE_ARM, 'k2', 9991, [1, 1], { set: null }), ...itemRows(CAND_ARM, 'k2', 9991, [0, 0], { set: null }), ...noSet(itemRows(BASE_ARM, 'k3', 9992, [1, 1])), ...noSet(itemRows(CAND_ARM, 'k3', 9992, [1, 1]))];
  const cardOf = (matches) => scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9990]), ...armRuns(CAND_ARM, [9990])], compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50, matches, suites: { k1: 'regression', k2: 'regression', k3: 'capability' }, sources: { k1: 'A', k2: 'A', k3: 'A' } });
  const cellsOf = (card) => ({ arms: Object.fromEntries([BASE_ARM, CAND_ARM].map((a) => [a, { perSuite: card.perArm[a].perSuite, perSource: card.perArm[a].perSource, goldARecall: card.perArm[a].goldARecall }])), pairedBar: card.pairedBar, lostCaughtMajors: card.lostCaughtMajors });
  const plain = cardOf(inSets);
  assert.deepEqual([plain.pairedBar.holdout.regression.n, plain.pairedBar.dev.regression.n, plain.lostCaughtMajors.holdout.count, plain.lostCaughtMajors.dev.count], [1, 1, 1, 0], 'the fixture holds real cells');
  assert.deepEqual(cellsOf(cardOf([...inSets, ...stray])), cellsOf(plain));
});

// ---------- re-score-paired test round 5: stale clean runs, one rate per PR, several rows per key in one replicate ----------

const riseCard = (runs, cleanPrs, extra = {}) => scorecard({ sets: {}, frozenPromptSha256: 'P0', frozenByArm: { [BASE_ARM]: 'HB', [CAND_ARM]: 'HC' }, runs, matches: [], cleanPrs, B: 50, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, ...extra }).cleanRise;
const hashed = (arm, pr, sevs, promptSha256, over = {}) => cleanRun(pr, 1, sevs, { arm, promptSha256, ...over });

test('D6 cleanRise leaves out a holdout clean run with a stale prompt hash, and reads the frozen hash of each arm: a stale candidate run with 4 Majors does not make a rise, and a candidate run on its own arm hash still counts (breaks if the cleanRise run filter drops the stale rule, or is built without frozenByArm)', () => {
  const staleCand = [hashed(BASE_ARM, 9911, [], 'HB'), hashed(BASE_ARM, 9912, [], 'HB'), hashed(CAND_ARM, 9911, [], 'HC'), hashed(CAND_ARM, 9912, ['major', 'major', 'major', 'critical'], 'OLD')];
  assert.deepEqual(riseCard(staleCand, [9911, 9912]), { holdout: false, dev: null }, 'the stale run leaves: only PR 9911 is shared, 0 against 0');
  const ownHash = [hashed(BASE_ARM, 9913, [], 'HB'), hashed(CAND_ARM, 9913, ['major'], 'HC')];
  assert.equal(riseCard(ownHash, [9913]).holdout, true, 'HC is the frozen hash of the candidate arm: the run is valid');
  const folderHash = [hashed(BASE_ARM, 9914, [], 'HB'), hashed(CAND_ARM, 9914, ['major'], 'P0')];
  assert.equal(riseCard(folderHash, [9914]).holdout, null, 'the arm hash HC beats the folder hash P0: a P0 run of the candidate is stale, so no PR is shared');
});

test('D6 cleanRise uses one rate per PR, the mean over that PR runs: a candidate with 2 runs of 1 Major is level with a baseline with 1 run of 1 Major, and a 2-Major run beats two 1-Major runs (breaks if cleanPrMeans sums the false Majors of a PR runs)', () => {
  const level = [hashed(BASE_ARM, 9921, ['major'], 'HB'), { ...hashed(CAND_ARM, 9921, ['major'], 'HC') }, { ...hashed(CAND_ARM, 9921, ['critical'], 'HC'), replicate: 2 }];
  assert.equal(riseCard(level, [9921]).holdout, false, 'candidate mean 1, baseline mean 1: not a rise (a sum reads 2 against 1)');
  const higher = [hashed(BASE_ARM, 9922, ['major'], 'HB'), { ...hashed(BASE_ARM, 9922, ['major'], 'HB'), replicate: 2 }, hashed(CAND_ARM, 9922, ['major', 'major'], 'HC')];
  assert.equal(riseCard(higher, [9922]).holdout, true, 'candidate mean 2, baseline mean 1: a rise (a sum reads 2 against 2)');
});

/** Match rows of one arm for one key in ONE replicate: one row per catch value, all with the same replicate number. */
const repRows = (arm, key, pr, replicate, catches, over = {}) => itemRows(arm, key, pr, catches, { replicate, ...over });

test('D6 several match rows of one key in one replicate are one replicate whose catch is their mean: paired item, lostCaughtMajors and gold cells count replicates, not rows (breaks if the rows of one replicate are read as separate replicates, are not averaged, or a partly caught replicate counts as a catch)', () => {
  const matches = [
    // d1: baseline replicate 1 has rows 1,1,1,0 and replicate 2 has row 0 -> replicate means 0.75 and 0, item catch 0.375 (the flat mean of the rows reads 0.6, the last row of a replicate 0, the first 0.5). Candidate catches in both replicates.
    ...repRows(BASE_ARM, 'd1', 9931, 1, [1, 1, 1, 0]), ...repRows(BASE_ARM, 'd1', 9931, 2, [0]), ...repRows(CAND_ARM, 'd1', 9931, 1, [1, 1]), ...repRows(CAND_ARM, 'd1', 9931, 2, [1, 1]),
    // d2: one replicate per arm, 2 rows each. One replicate is not assessable, however many rows it has.
    ...repRows(BASE_ARM, 'd2', 9932, 1, [1, 1]), ...repRows(CAND_ARM, 'd2', 9932, 1, [0, 0]),
    // d3: baseline replicates [1,0] and [0,1] are each caught half: no replicate is a full catch, so the item is not lost. Candidate misses both.
    ...repRows(BASE_ARM, 'd3', 9933, 1, [1, 0]), ...repRows(BASE_ARM, 'd3', 9933, 2, [0, 1]), ...repRows(CAND_ARM, 'd3', 9933, 1, [0, 0]), ...repRows(CAND_ARM, 'd3', 9933, 2, [0, 0]),
  ];
  const input = { sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9931]), ...armRuns(CAND_ARM, [9931])], matches, compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 50, suites: { d1: 'regression', d2: 'capability' }, sources: { d1: 'A', d2: 'A', d3: 'A' } };
  const card = scorecard(input);
  assert.deepEqual(card.lostCaughtMajors.holdout, { count: 0, assessable: 2, flagged: false }, 'd2 is one replicate (not assessable); d3 is half caught in each replicate (not lost)');
  // The paired bar prints numbers from 20 items: 20 copies of d1 (regression) and of d2 (capability) in their own input.
  const wide = scorecard(fan(input, 20)).pairedBar.holdout;
  assert.equal(wide.regression.delta, 62.5, 'd1: candidate 1 against baseline mean of replicate means 0.375, in points');
  assert.deepEqual(wide.capability.delta, -100, 'd2: 0 against 1');
  assert.deepEqual([card.perArm[BASE_ARM].goldARecall.holdout.found, card.perArm[BASE_ARM].goldARecall.holdout.total], [1.875, 3], 'd1 0.375 + d2 1 + d3 0.5');
  assert.deepEqual([card.perArm[CAND_ARM].goldARecall.holdout.found, card.perArm[CAND_ARM].goldARecall.holdout.total], [1, 3], 'd1 only');
});

// ---------- re-score-paired seat fix round (08-seat-review of 2096c5f3) ----------

test('C evaluateRuns puts a cluster on each match row: d.cluster, else range:<range>, else owner/repo#pr in lower case; the run repo is the last fallback (breaks if the cluster is left off the row, the repo drops out of it, or the case is kept)', () => {
  const dataset = [
    dsMajor('own:1', 9060),
    dsMajor('ext:1', 9060, { repo: 'Owner/X', path: 'b.mjs' }),
    dsMajor('tgt:1', 9060, { target: { repo: 'Other/Y' }, path: 'c.mjs' }),
    dsMajor('rng:1', 9060, { target: { range: 'aaa..bbb' }, path: 'd.mjs' }),
    dsMajor('rng:2', 9060, { range: 'ccc..ddd', path: 'e.mjs' }),
    dsMajor('cl:1', 9060, { cluster: 'group-7', repo: 'Owner/X', path: 'f.mjs' }),
    dsMajor('run:1', 9061),
  ];
  const rows = [armRow(9060, { reviewer: 'engine' }), armRow(9061, { reviewer: 'engine', repo: 'Run/Repo' })];
  const ev = evaluateRuns({ runs: rows, dataset, readFindings: hitRead });
  assert.deepEqual(Object.fromEntries(ev.matches.map((x) => [x.key, x.cluster])), { 'own:1': '#9060', 'ext:1': 'owner/x#9060', 'tgt:1': 'other/y#9060', 'rng:1': 'range:aaa..bbb', 'rng:2': 'range:ccc..ddd', 'cl:1': 'group-7', 'run:1': 'run/repo#9061' });
});

test('C an own-repo item #N and an external item owner/x#N with the same PR number are two clusters in the paired bar (breaks if the match row has no cluster, so both fall to #N)', () => {
  const CR = 'cursor-review|-|-|-';
  const ENG = 'engine|v1|-|-';
  const dataset = [dsMajor('own:1', 9062), dsMajor('ext:1', 9062, { repo: 'Owner/X', path: 'b.mjs' })];
  const ev = evaluateRuns({ runs: [armRow(9062, { reviewer: 'engine' }), armRow(9062, { reviewer: 'cursor-review' })], dataset, readFindings: hitRead });
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs: ev.runs, matches: ev.matches, compare: { baseline: CR, candidate: ENG }, suites: { 'own:1': 'regression', 'ext:1': 'regression' }, B: 50 });
  assert.equal(card.pairedBar.holdout.regression.n, 2);
  assert.equal(card.pairedBar.holdout.regression.clusters, 2);
});

/** A regression suite of n paired items, each on its own PR (so its own cluster); 1 item in 5 is lost by the candidate. */
const nItemBar = (n, unpairedN = 0) => {
  const keys = Array.from({ length: n }, (_, i) => `z${i}`);
  const matches = keys.flatMap((k, i) => [...itemRows(BASE_ARM, k, 9500 + i, [1]), ...itemRows(CAND_ARM, k, 9500 + i, [i % 5 === 0 ? 0 : 1])]);
  // Baseline-only items: in the suite, but with no candidate row, so they are unpaired.
  const loose = Array.from({ length: unpairedN }, (_, i) => `u${i}`);
  matches.push(...loose.flatMap((k, i) => itemRows(BASE_ARM, k, 9580 + i, [1])));
  const input = { sets: {}, frozenPromptSha256: 'P0', runs: [...armRuns(BASE_ARM, [9500]), ...armRuns(CAND_ARM, [9500])], matches, suites: Object.fromEntries([...keys, ...loose].map((k) => [k, 'regression'])), compare: { baseline: BASE_ARM, candidate: CAND_ARM }, B: 200, seed: 3 };
  return scorecard(input).pairedBar.holdout.regression;
};

test('R1 MIN_CELL is 20; a paired cell of 19 items prints no number and one of 20 prints them (breaks if the cut moves, is exclusive, or the numbers print under it)', () => {
  assert.equal(MIN_CELL, 20);
  const under = nItemBar(19);
  assert.deepEqual([under.delta, under.lo, under.hi, under.d, under.wouldBe], [null, null, null, null, null]);
  assert.deepEqual([under.n, under.unpaired, under.B, under.nNeeded], [19, 0, 200, null], 'under the cut nNeeded is null: ceil(1537 * d) would give d back');
  const at = nItemBar(20);
  assert.ok(Math.abs(at.delta + 20) < 1e-9, String(at.delta));
  assert.equal(at.d, 0.2);
  assert.ok(at.lo <= at.delta && at.delta <= at.hi);
  assert.deepEqual([at.n, at.nNeeded, at.wouldBe], [20, 308, 'FAIL']);
});

test('R1 the cut reads the paired items alone: 19 paired items plus 1 or 5 unpaired items still print no number, and 20 paired plus 1 unpaired print it (breaks if the cut reads n + unpaired)', () => {
  for (const loose of [1, 5]) {
    const bar = nItemBar(19, loose);
    assert.deepEqual([bar.n, bar.unpaired], [19, loose]);
    assert.deepEqual([bar.delta, bar.lo, bar.hi, bar.d, bar.wouldBe], [null, null, null, null, null], `unpaired ${loose}`);
  }
  const at = nItemBar(20, 1);
  assert.deepEqual([at.n, at.unpaired, at.d, at.wouldBe], [20, 1, 0.2, 'FAIL']);
  assert.ok(at.delta !== null && at.lo !== null && at.hi !== null);
});

test('R3 a one-arm card keeps prFalseAlarm.prs at the top, and no perArm card prints it: count and total only (breaks if a per-arm card prints a PR id, or the top-level prs key is lost)', () => {
  const card = scorecard(ONE_ARM_INPUT);
  assert.deepEqual(card.prFalseAlarm, BASE_CARD.prFalseAlarm);
  assert.deepEqual(card.perArm[ENGINE_ARM].prFalseAlarm, { count: BASE_CARD.prFalseAlarm.count, total: BASE_CARD.prFalseAlarm.total });
  const two = scorecard(twoArmInput());
  for (const arm of two.arms) assert.equal(Object.hasOwn(two.perArm[arm].prFalseAlarm, 'prs'), false, arm);
});

test('R5a repairedJson is the share among the ok rows that carry a boolean repairedJson: 2 flagged ok rows of 4 ok rows, 1 true, gives 0.5 (breaks if a row with no flag stays in the denominator)', () => {
  const runs = relRuns('a', 4, (i) => (i < 2 ? { repairedJson: i === 0 } : {}));
  assert.equal(scorecard(relInput(runs, {})).reliability.a.repairedJson, 0.5);
  const flaggedNotOk = [...relRuns('a', 2, (i) => ({ repairedJson: i === 0 })), ...relRuns('a', 1, () => ({ pr: 9790, status: 'incomplete', coverageComplete: false, repairedJson: true }))];
  assert.equal(scorecard(relInput(flaggedNotOk, {})).reliability.a.repairedJson, 0.5, 'a flagged row that is not ok stays out');
  // Ok rows whose repairedJson is not a boolean (null, 1, 'true') carry no flag: they stay out of the share.
  const odd = relRuns('a', 6, (i) => [{ repairedJson: true }, { repairedJson: false }, { repairedJson: null }, { repairedJson: 1 }, { repairedJson: 'true' }, {}][i]);
  assert.equal(scorecard(relInput(odd, {})).reliability.a.repairedJson, 0.5, 'null, 1 and "true" are not flags');
});

test('R5c engine runs with match rows that carry no arm and no reviewer make a second arm, the "none" arm, so the card has two arms and no pooled number (breaks if an armless match row is given the run arm, or dropped)', () => {
  const NONE = armKeyOf({});
  const runs = armRuns(ENGINE_ARM, [9082]);
  const matches = itemRows(undefined, 'a1', 9082, [1]).map((r) => ({ ...r, arm: undefined, replicate: undefined }));
  const card = scorecard({ sets: {}, frozenPromptSha256: 'P0', runs, matches });
  assert.deepEqual(card.arms, [ENGINE_ARM, NONE].sort());
  assert.equal(card.perMajorRecall, null, 'two arms: no pooled number');
  assert.equal(card.perArm[NONE].perMajorRecall.strict.total, 1, 'the armless rows are one item in their own arm');
  assert.equal(card.perArm[ENGINE_ARM].perMajorRecall.strict.total, 0, 'the engine arm has no rows');
});

test('R5b every paired suite cell prints B and used; B is 2000 by default and the B of the input otherwise; an empty suite has used 0 (breaks if the cell drops them or the default moves)', () => {
  const bar = scorecard(pairedInput({ B: undefined })).pairedBar.holdout;
  for (const name of ['regression', 'capability', 'unassigned']) {
    assert.equal(bar[name].B, 2000, name);
    assert.ok(Number.isInteger(bar[name].used) && bar[name].used > 0 && bar[name].used <= 2000, `${name} used ${bar[name].used}`);
  }
  assert.equal(scorecard(pairedInput({ B: 400 })).pairedBar.holdout.regression.B, 400);
  const empty = scorecard({ sets: {}, runs: armRuns(BASE_ARM, [9201]), matches: [], compare: { baseline: BASE_ARM, candidate: CAND_ARM } }).pairedBar.holdout.regression;
  assert.deepEqual([empty.B, empty.used], [2000, 0]);
});

test('R5c arms are the union of the run arms and the match arms: matches of a second arm that has no run make a two-arm card, with the pooled keys null (breaks if arms come from the runs alone)', () => {
  const input = { sets: {}, frozenPromptSha256: 'P0', runs: armRuns(BASE_ARM, [9080]), matches: [...itemRows(BASE_ARM, 'u1', 9080, [1]), ...itemRows(CAND_ARM, 'u2', 9081, [0])] };
  const card = scorecard(input);
  assert.deepEqual(card.arms, [BASE_ARM, CAND_ARM]);
  assert.deepEqual(Object.keys(card.perArm), [BASE_ARM, CAND_ARM]);
  assert.equal(card.perMajorRecall, null, 'two arms: no pooled number');
  assert.deepEqual([card.perArm[BASE_ARM].perMajorRecall.strict.total, card.perArm[CAND_ARM].perMajorRecall.strict.total], [1, 1]);
});

test('R5d evaluateRuns leaves out a row whose replicate is 0, -1, 1.5, a string or null; it counts each in attempts as invalidReplicate; an undefined replicate is still 1 (breaks if an invalid replicate becomes 1, is scored, or is not counted)', () => {
  const bad = [0, -1, 1.5, '3', null];
  const rows = [armRow(9070, { reviewer: 'engine' }), ...bad.map((replicate, i) => armRow(9070, { reviewer: 'engine', round: 2 + i, replicate, status: i === 0 ? 'failed' : 'ok' }))];
  const ev = evaluateRuns({ runs: rows, dataset: [dsMajor('9070:1', 9070)], readFindings: hitRead });
  assert.deepEqual(ev.runs.map((r) => [r.round, r.replicate]), [[1, 1]]);
  assert.equal(ev.matches.length, 1);
  assert.deepEqual(ev.attempts['engine|v1|-|-'], { attempts: 6, newest: 1, failed: 0, failedThenOk: 0, invalidReplicate: 5 });
  const only = evaluateRuns({ runs: [armRow(9071, { reviewer: 'cursor-review', replicate: 0 })], dataset: [], readFindings: hitRead });
  assert.deepEqual(only.runs, []);
  assert.deepEqual(only.attempts['cursor-review|-|-|-'], { attempts: 1, newest: 0, failed: 0, failedThenOk: 0, invalidReplicate: 1 });
});

test('R5d a joined folder with a replicate of 0 keeps it, so evaluateRuns drops the row and counts it (breaks if joinReplicates repairs an invalid replicate)', () => {
  const rows = joinReplicates([[armRow(9072, { reviewer: 'engine' })], [armRow(9072, { reviewer: 'engine', replicate: 0 })]]);
  const ev = evaluateRuns({ runs: rows, dataset: [], readFindings: hitRead });
  assert.deepEqual(ev.runs.map((r) => r.replicate), [1]);
  assert.equal(ev.attempts['engine|v1|-|-'].invalidReplicate, 1);
});

test('R6 one input and one seed give a byte-identical card on two calls, for a compared card and a one-arm card (breaks if a card reads a clock, an unseeded random number or shared state)', () => {
  const compared = fan(pairedInput({ B: 300, seed: 5, cleanPrs: [9201], attempts: { [BASE_ARM]: { attempts: 2, newest: 2, failed: 0, failedThenOk: 0 } } }), 7);
  assert.equal(JSON.stringify(scorecard(compared)), JSON.stringify(scorecard(compared)));
  assert.notEqual(scorecard(compared).pairedBar.holdout.regression.delta, null, 'the compared card holds numbers');
  assert.equal(JSON.stringify(scorecard(ONE_ARM_INPUT)), JSON.stringify(scorecard(ONE_ARM_INPUT)));
  // A clock moves between the two calls: a card field read from Date would differ, even at a coarse grain such as a second or a day.
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  try {
    for (const input of [compared, ONE_ARM_INPUT]) {
      const first = JSON.stringify(scorecard(input));
      mock.timers.setTime(Date.UTC(2027, 5, 15, 12, 30, 45, 123));
      assert.equal(JSON.stringify(scorecard(input)), first, 'the card does not read the clock');
      mock.timers.setTime(Date.UTC(2026, 0, 1));
    }
  } finally {
    mock.timers.reset();
  }
});
