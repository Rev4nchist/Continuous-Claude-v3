// Failure modes (P0 F4, F5, F7).
//  F4 finding has no comment_id            -> remove the round-rank fallback in resolveFindings
//  F5 comment has line:null                -> resolveFindings reads `line` (covered through originalPlace)
//  F7 bake-off PR in the holdout           -> ignore holdoutExclude in splitSets
//  an unreachable comment falls back to its round, then to `unresolved` instead of throwing
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realMajors, resolveFindings, splitSets, zeroMajorPrs } from './dataset.mjs';

const sha = (c) => c.repeat(40);
const CR = { login: 'coderabbitai[bot]', type: 'Bot' };
const ds = {
  prs: [{ pr: 200, real_major: 1 }, { pr: 217, real_major: 1 }, { pr: 201, real_major: 0 }, { pr: 222, real_major: 1 }],
  findings: [
    { pr: 200, comment_id: '11', severity: 'Major', path: 'a.mjs', verdict: 'real', round: 1, source: 'inline' },
    { pr: 200, severity: 'Major', path: 'b.mjs', verdict: 'real', round: 2, source: 'body' },
    { pr: 217, comment_id: '12', severity: 'Major', path: 'c.mjs', verdict: 'real', round: 1, source: 'inline' },
    { pr: 222, severity: 'Major', path: 'd.mjs', verdict: 'real', round: 1, source: 'inline' },
    { pr: 200, comment_id: '13', severity: 'Minor', path: 'e.mjs', verdict: 'real', round: 1, source: 'inline' },
    { pr: 200, severity: 'Major', path: 'f.mjs', verdict: 'noise', round: 1, source: 'inline' },
  ],
};
const cfg = { holdoutExclude: [217, 222, 225, 238] };
const gh = async (args) => {
  const route = args.find((a) => /^repos\//.test(a));
  if (/pulls\/comments\/11$/.test(route)) return { path: 'a.mjs', line: null, original_start_line: 5, original_line: 9, original_commit_id: sha('1') };
  if (/pulls\/comments\/12$/.test(route)) return { path: 'c.mjs', line: 3, original_line: 3, original_commit_id: sha('2') };
  if (/pulls\/comments\/13$/.test(route)) throw new Error('HTTP 404');
  if (/pulls\/\d+\/reviews/.test(route)) return [{ id: 1, user: CR, commit_id: sha('a'), body: 'Actionable comments posted: 1', submitted_at: '2026-01-01T00:00:00Z' }, { id: 2, user: CR, commit_id: sha('b'), body: 'Actionable comments posted: 1', submitted_at: '2026-01-02T00:00:00Z' }];
  if (/issues\/\d+\/comments/.test(route)) return [];
  if (/pulls\/\d+\/commits/.test(route)) return [{ sha: sha('a') }, { sha: sha('b') }];
  throw new Error(`no route ${route}`);
};

test('F4 a finding with no comment_id resolves by round rank', async () => {
  // Breaks when: the round-rank fallback is removed from resolveFindings (the finding would be unresolved).
  const out = await resolveFindings(ds, { gh });
  const f = out.find((x) => x.path === 'b.mjs');
  assert.equal(f.resolvedBy, 'round');
  assert.equal(f.sha40, sha('b'));
  assert.equal(f.startLine, null);
});

test('F5 a finding with a comment id resolves to the original place', async () => {
  // Breaks when: resolveFindings reads `line` (null here) instead of original_start_line..original_line.
  const out = await resolveFindings(ds, { gh });
  const f = out.find((x) => x.path === 'a.mjs');
  assert.equal(f.resolvedBy, 'comment');
  assert.deepEqual([f.startLine, f.endLine, f.sha40], [5, 9, sha('1')]);
});

test('a comment that gh cannot read falls back to its round and does not throw', async () => {
  // Breaks when: resolveFindings lets the gh error escape.
  const out = await resolveFindings(ds, { gh });
  const f = out.find((x) => x.path === 'e.mjs');
  assert.equal(f.resolvedBy, 'round');
  assert.equal(f.sha40, sha('a'));
});

test('a round beyond the CR rounds is unresolved', async () => {
  // Breaks when: a missing round gives a sha of undefined that the replay then uses.
  const out = await resolveFindings({ prs: [], findings: [{ pr: 200, severity: 'Major', path: 'z.mjs', verdict: 'real', round: 9, source: 'inline' }] }, { gh });
  assert.equal(out[0].resolvedBy, 'unresolved');
  assert.equal(out[0].sha40, null);
});

test('F7 bake-off PRs 217/222/225/238 land in dev, the rest in holdout; replay holds every real Major', async () => {
  // Breaks when: splitSets ignores holdoutExclude.
  const out = await resolveFindings(ds, { gh });
  const sets = splitSets(out, cfg);
  assert.deepEqual([...new Set(sets.dev.map((f) => f.pr))].sort(), [217, 222]);
  assert.deepEqual([...new Set(sets.holdout.map((f) => f.pr))], [200]);
  assert.equal(sets.replay.length, sets.dev.length + sets.holdout.length);
  assert.equal(sets.replay.length, 4); // the noise-verdict Major and the Minors are out
  assert.equal(sets.holdout.some((f) => f.verdict !== 'real' || f.severity !== 'Major'), false);
});

// ---------- reserve list, gold merge, counts (re-eval-contract) ----------
// Failure modes:
//  R1 a reserve PR lands in holdout or dev (or in replay)      -> splitSets ignores cfg.reserve
//  R2 a reserve PR is also in holdoutExclude and lands in dev  -> dev wins over reserve
//  G1 a gold A/CR row keeps its own split against config.json  -> mergeGold ignores config for A/CR
//  G2 a gold B/C row is re-split by config.json                -> mergeGold applies config to every source
//  G3 an external row matches one of our PRs by number only    -> key without repo
//  E02 reserve rows with no answer-key source are not counted  -> reserveSources reads only the list length
import { mergeGold, prCounts, reserveSources, setOf } from './dataset.mjs';

const cfgR = { holdoutExclude: [217, 222], reserve: [{ pr: 200, answerKeySource: 'pr-bot' }, { pr: 222, answerKeySource: null }] };

test('R1 R2 a reserve PR is in neither dev nor holdout nor replay, even when holdoutExclude names it', async () => {
  // Breaks when: splitSets ignores cfg.reserve, or dev is tested before reserve.
  const out = await resolveFindings(ds, { gh });
  const sets = splitSets(out, cfgR);
  const prs = (xs) => [...new Set(xs.map((f) => f.pr))].sort();
  assert.deepEqual(prs(sets.reserve), [200, 222]);
  assert.deepEqual(prs(sets.dev), [217]);
  assert.deepEqual(prs(sets.holdout), []);
  assert.equal(sets.replay.some((f) => [200, 222].includes(f.pr)), false);
  assert.equal(sets.replay.length, sets.dev.length + sets.holdout.length);
  assert.deepEqual([200, 217, 222, 999].map((p) => setOf(p, cfgR)), ['reserve', 'dev', 'reserve', 'holdout']);
});

test('E02 reserveSources counts the reserve PRs and those with no answer-key source; an empty list is 0 of 0', () => {
  // Breaks when: a null or missing source is counted as a source.
  assert.deepEqual(reserveSources(cfgR), { total: 2, noSource: 1, bySource: { 'pr-bot': 1 } });
  assert.deepEqual(reserveSources({}), { total: 0, noSource: 0, bySource: {} });
});

const gold = [
  { id: 'a1', source: 'A', split: 'holdout', target: { pr: 217, round: 1, sha40: sha('1') } },
  { id: 'a2', source: 'A', split: 'holdout', target: { pr: 300, round: 1, sha40: sha('2') } },
  { id: 'cr1', source: 'CR', split: 'dev', target: { pr: 200, round: 1, sha40: sha('3') } },
  { id: 'b1', source: 'B', split: 'dev', target: { range: 'aaa..bbb' } },
  { id: 'c1', source: 'C', split: 'holdout', target: { repo: 'other/repo', pr: 217, round: 1, sha40: sha('4') } },
  { id: 'c2', source: 'C', split: 'holdout', target: { repo: 'other/repo', pr: 217, round: 1, sha40: sha('4') } },
];

test('G1 G2 G3 mergeGold: config wins for A and CR and the differing count is reported; B and C keep their own split', () => {
  // Breaks when: config is ignored for A/CR, applied to B/C, or an external row is keyed by PR number alone.
  const m = mergeGold(gold, cfgR);
  const split = Object.fromEntries(m.rows.map((r) => [r.id, r.split]));
  assert.deepEqual(split, { a1: 'dev', a2: 'holdout', cr1: 'reserve', b1: 'dev', c1: 'holdout', c2: 'holdout' });
  assert.equal(m.splitDiffers, 2); // a1 holdout -> dev, cr1 dev -> reserve
  assert.equal(m.rows.find((r) => r.id === 'c1').key, 'other/repo#217');
  assert.equal(m.rows.find((r) => r.id === 'a1').key, '#217');
  assert.equal(m.rows.find((r) => r.id === 'b1').key, 'range:aaa..bbb');
});

test('prCounts: holdout and dev PRs with a real Major, reserve PRs apart, gold targets by distinct key outside reserve', () => {
  // Breaks when: reserve PRs count as holdout, or one target with two rows counts twice.
  const c = prCounts({ ds, cfg: cfgR, goldRows: mergeGold(gold, cfgR).rows });
  assert.deepEqual([c.holdout, c.dev, c.reserve], [0, 1, 2]);
  // #300, range, other/repo#217 (c1 and c2 share one target); cr1 is reserve; a1 (#217) is already a dev PR of the dataset
  assert.equal(c.gold, 3);
  assert.equal(c.goldOverlap, 1);
  assert.deepEqual(c.goldBySource, { A: 1, B: 1, C: 1 });
});

test('a reserve entry that is not { pr: integer } throws BAD_INPUT instead of reserving nothing', () => {
  // Breaks when: a string pr or a bare number is ignored and the PR stays in holdout.
  for (const reserve of [[{ pr: '200' }], [200], [{ pr: 2.5 }], [null], { pr: 200 }]) {
    assert.throws(() => setOf(200, { reserve }), (e) => e.code === 'BAD_INPUT', JSON.stringify(reserve));
  }
});

test('realMajors and zeroMajorPrs read the dataset', () => {
  // Breaks when: realMajors accepts a noise Major or a Minor, or zeroMajorPrs reads findings instead of the prs table.
  assert.equal(realMajors(ds.findings).length, 4);
  assert.deepEqual(zeroMajorPrs(ds), [201]);
});
