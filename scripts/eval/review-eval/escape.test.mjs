// Failure modes (P0 section 2 escape.mjs).
//  a Major in round k>=2 outside the round's own diff is a later-round escape -> invert the overlap test
//  round 1 and line-less findings are never judged an escape                  -> treat unknown as escape
//  post-merge: blame traces to an earlier PR merged in the last 30 days       -> drop the 30-day window or count the same PR
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laterRoundEscapes, postMergeEscapes } from './escape.mjs';

const sha = (c) => c.repeat(40);
const diffGit = (hunks) => () => ({ status: 0, stdout: hunks });
const f = (over = {}) => ({ pr: 9, round: 2, sha40: sha('b'), prevSha: sha('a'), path: 'a.mjs', startLine: 20, endLine: 22, severity: 'Major', verdict: 'real', ...over });

test('a round-2 Major whose lines the round diff does not touch is a later-round escape', () => {
  // Breaks when: the overlap test is inverted (a finding inside the new hunk would be called an escape).
  const git = diffGit('@@ -1,0 +5,3 @@\n+a\n+b\n+c\n');
  assert.equal(laterRoundEscapes(f(), { git }).escape, true);
});

test('a round-2 Major inside the lines the round changed is no escape', () => {
  // Breaks when: laterRoundEscapes ignores the hunk ranges.
  const git = diffGit('@@ -18,2 +19,4 @@\n+a\n');
  assert.equal(laterRoundEscapes(f(), { git }).escape, false);
});

test('round 1, a Minor and a finding with no line are never judged an escape', () => {
  // Breaks when: unknown cases return escape:true.
  const git = diffGit('@@ -1,0 +5,3 @@\n');
  assert.equal(laterRoundEscapes(f({ round: 1 }), { git }).escape, false);
  assert.equal(laterRoundEscapes(f({ severity: 'Minor' }), { git }).escape, false);
  const noLine = laterRoundEscapes(f({ startLine: null, endLine: null }), { git });
  assert.equal(noLine.escape, null);
});

const blame = (shas) => () => ({ status: 0, stdout: shas.map((s, i) => `${s} ${i + 1} ${i + 1} 1\nauthor x\nfilename a.mjs\n\tcode`).join('\n') });

test('a post-merge escape: blame traces to an earlier PR merged inside 30 days', async () => {
  // Breaks when: the gh commits/<sha>/pulls lookup is skipped or the 30-day window is dropped.
  const gh = async () => [{ number: 5, merged_at: '2026-10-20T00:00:00Z' }];
  const r = await postMergeEscapes(f({ mergedAt: '2026-11-01T00:00:00Z' }), { git: blame([sha('1')]), gh });
  assert.equal(r.escape, true);
  assert.deepEqual(r.via, [5]);
});

test('a PR merged more than 30 days before, or the same PR, is no post-merge escape', async () => {
  // Breaks when: the window or the same-PR exclusion is dropped.
  const old = async () => [{ number: 5, merged_at: '2026-08-01T00:00:00Z' }];
  assert.equal((await postMergeEscapes(f({ mergedAt: '2026-11-01T00:00:00Z' }), { git: blame([sha('1')]), gh: old })).escape, false);
  const same = async () => [{ number: 9, merged_at: '2026-10-30T00:00:00Z' }];
  assert.equal((await postMergeEscapes(f({ mergedAt: '2026-11-01T00:00:00Z' }), { git: blame([sha('1')]), gh: same })).escape, false);
});

test('a blame or gh failure gives escape:null and no throw', async () => {
  // Breaks when: an error is turned into escape:false or escape:true, or escapes.
  const r = await postMergeEscapes(f({ mergedAt: '2026-11-01T00:00:00Z' }), { git: () => ({ status: 128, stdout: '' }), gh: async () => { throw new Error('x'); } });
  assert.equal(r.escape, null);
});
