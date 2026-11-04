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
import { pairId } from './labels.mjs';
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
  const sent = Array.from({ length: 30 }, (_, i) => ({ pairId: `p${i}`, judge: { verdict: 'real' } }));
  const labels = (agree) => Array.from({ length: 30 }, (_, i) => ({ pairId: `p${i}`, verdict: i < agree ? 'real' : 'noise', by: 'dave' }));
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
