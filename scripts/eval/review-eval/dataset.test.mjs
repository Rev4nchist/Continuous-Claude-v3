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

test('realMajors and zeroMajorPrs read the dataset', () => {
  // Breaks when: realMajors accepts a noise Major or a Minor, or zeroMajorPrs reads findings instead of the prs table.
  assert.equal(realMajors(ds.findings).length, 4);
  assert.deepEqual(zeroMajorPrs(ds), [201]);
});
