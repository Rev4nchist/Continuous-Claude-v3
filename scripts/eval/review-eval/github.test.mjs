// Failure modes (P0 F5, shadow F2, F3, F5; round order).
//  F5  comment has line:null                  -> originalPlace reads `line` instead of original_*
//  sF2 a thread reply is counted as a round   -> drop the body trim() filter
//  sF3 a clean summary-only round is lost     -> drop the cleanSummaryCommit branch
//  sF5 a rate-limit notice is a clean round   -> drop the codeRabbitNotice check
//  rank follows commit order, not review time -> sort by submitted_at
//  one round per distinct commit_id           -> one round per review object
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crRounds, fetchPr, originalPlace, roundsFrom } from './github.mjs';

const CR = { login: 'coderabbitai[bot]', type: 'Bot' };
const sha = (c) => c.repeat(40);
const review = (id, commit, body, at, user = CR) => ({ id, user, commit_id: commit, body, submitted_at: at });
const commits = [sha('a'), sha('b'), sha('c')].map((s) => ({ sha: s }));

test('sF2 a review with an empty body (a thread reply container) is no round', () => {
  // Breaks when: the `String(body).trim() !== ''` filter is dropped from roundsFrom.
  const rounds = roundsFrom({ reviews: [review(1, sha('a'), '', '2026-01-01T00:00:00Z'), review(2, sha('a'), '  \n', '2026-01-01T00:01:00Z')], comments: [], commentEdits: {}, commits });
  assert.equal(rounds.length, 0);
});

test('a review by a person is no round', () => {
  // Breaks when: roundsFrom drops the isCodeRabbitUser check.
  const rounds = roundsFrom({ reviews: [review(1, sha('a'), 'looks fine', '2026-01-01T00:00:00Z', { login: 'dave', type: 'User' })], comments: [], commentEdits: {}, commits });
  assert.equal(rounds.length, 0);
});

test('rank follows commit order, and two reviews of one commit are one round', () => {
  // Breaks when: rounds sort by submitted_at (round 2 would come first) or are not merged by commit_id.
  const rounds = roundsFrom({
    reviews: [review(10, sha('b'), 'Actionable comments posted: 1', '2026-01-01T00:00:00Z'), review(11, sha('a'), 'Actionable comments posted: 2', '2026-01-02T00:00:00Z'), review(12, sha('a'), 'Actionable comments posted: 0', '2026-01-02T01:00:00Z')],
    comments: [], commentEdits: {}, commits,
  });
  assert.deepEqual(rounds.map((r) => r.sha40), [sha('a'), sha('b')]);
  assert.deepEqual(rounds.map((r) => r.rank), [1, 2]);
});

test('sF5 a rate-limit notice review is flagged, not a clean round', () => {
  // Breaks when: the codeRabbitNotice check is dropped (the notice would look like a review).
  const rounds = roundsFrom({ reviews: [review(1, sha('a'), '> ## Review skipped\n> too many files', '2026-01-01T00:00:00Z')], comments: [], commentEdits: {}, commits });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].notice, 'skipped');
});

test('sF3 a clean summary-only round is a summary round', () => {
  // Breaks when: the cleanSummaryCommit branch is dropped from roundsFrom.
  const body = `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nNo actionable comments were generated\nbetween ${sha('a')} and ${sha('b')}`;
  const comments = [{ id: 77, user: CR, body, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }];
  const rounds = roundsFrom({ reviews: [], comments, commentEdits: {}, commits });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].kind, 'summary');
  assert.equal(rounds[0].sha40, sha('b'));
});

test('F5 originalPlace uses original_start_line..original_line when line is null', () => {
  // Breaks when: originalPlace reads `line` (null after a force-push) instead of the original_* fields.
  const gh = async () => ({ id: 5, path: 'a/b.mjs', line: null, start_line: null, original_start_line: 130, original_line: 136, original_commit_id: sha('c'), commit_id: sha('d') });
  return originalPlace(5, { gh }).then((p) => {
    assert.deepEqual([p.path, p.startLine, p.endLine, p.sha40], ['a/b.mjs', 130, 136, sha('c')]);
  });
});

test('originalPlace with a single-line comment: start = end = original_line', async () => {
  // Breaks when: a missing original_start_line gives NaN or null for startLine.
  const gh = async () => ({ path: 'x.mjs', line: 9, original_line: 12, original_start_line: null, original_commit_id: sha('c') });
  const p = await originalPlace(1, { gh });
  assert.deepEqual([p.startLine, p.endLine], [12, 12]);
});

function fakeGh(routes) {
  return async (args) => {
    const route = args.find((a) => /^repos\//.test(a));
    for (const [re, value] of routes) if (re.test(route)) return typeof value === 'function' ? value(route) : value;
    throw new Error(`no route for ${route}`);
  };
}

test('crRounds (fetch) leaves notice rounds out and returns commit-ordered rounds', async () => {
  // Breaks when: crRounds returns notice rounds to the P0 caller, or does not page the lists.
  const gh = fakeGh([
    [/pulls\/9\/reviews/, [[review(1, sha('b'), 'Actionable comments posted: 1', '2026-01-02T00:00:00Z'), review(2, sha('c'), '> ## Review skipped', '2026-01-03T00:00:00Z')]]],
    [/issues\/9\/comments/, []],
    [/pulls\/9\/commits/, commits],
  ]);
  const rounds = await crRounds(9, { gh });
  assert.deepEqual(rounds.map((r) => r.sha40), [sha('b')]);
});

test('fetchPr returns the merge sha, the base sha, the commit list and the rounds', async () => {
  // Breaks when: fetchPr drops merge_commit_sha or base.sha (replay needs both).
  const gh = fakeGh([
    [/pulls\/9$/, { number: 9, state: 'closed', merged: true, merge_commit_sha: sha('f'), merged_at: '2026-01-05T00:00:00Z', base: { sha: sha('e'), ref: 'main' }, head: { sha: sha('c') }, created_at: '2026-01-01T00:00:00Z', user: { login: 'x' } }],
    [/pulls\/9\/commits/, commits],
    [/pulls\/9\/reviews/, [review(1, sha('a'), 'Actionable comments posted: 1', '2026-01-02T00:00:00Z')]],
    [/issues\/9\/comments/, []],
  ]);
  const pr = await fetchPr(9, { gh });
  assert.equal(pr.mergeSha, sha('f'));
  assert.equal(pr.baseSha, sha('e'));
  assert.equal(pr.merged, true);
  assert.deepEqual(pr.commits, commits.map((c) => c.sha));
  assert.equal(pr.rounds.length, 1);
});
