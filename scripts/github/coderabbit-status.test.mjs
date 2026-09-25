// Tests for evaluate() in coderabbit-status.mjs. Run: node --test scripts/github/coderabbit-status.test.mjs
// Each case names the failure it guards against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './coderabbit-status.mjs';

const HEAD = '4342fb403723f904fb6f3205a5a2019422f68c8c';
const BASE = 'fdb03edb040ff49a77ad759508ae7b9c401ae549';
const OLD = '7e8b0058c204b4f453eaf0009f16908b9405a924';
const BOT = { login: 'coderabbitai[bot]' };

function input({ reviews = [], comments = [] } = {}) {
  return {
    pull: { number: 64, state: 'open', merged: false, mergeable_state: 'clean', head: { sha: HEAD, ref: 'docs/readme-harness' } },
    combined: { statuses: [{ context: 'CodeRabbit', state: 'success' }] },
    checkRuns: [],
    threads: [],
    reviews,
    comments,
  };
}

// The body CodeRabbit posted on PR #64: a clean review, reported only in its edited summary comment.
const summary = (from, to) => `No actionable comments were generated in the recent review. 🎉
Reviewing files that changed from the base of the PR and between ${from} and ${to}.`;
const marker = (id, kind = 'reviewed') => `<!-- final_review_risk_coverage:{"sourceCommitId":"${id}","coveredCommitId":"${id}","kind":"${kind}"} -->`;

test('PR #64 shape: a summary comment whose reviewed range ends at the head counts as a review (was NOT READY)', () => {
  const r = evaluate(input({ comments: [{ user: BOT, body: summary(BASE, HEAD) }] }));
  assert.equal(r.reviewedHead, true);
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('a summary whose range ends at an older commit does not cover a new push', () => {
  const r = evaluate(input({ comments: [{ user: BOT, body: summary(BASE, OLD) }] }));
  assert.equal(r.reviewedHead, false);
  assert.equal(r.ready, false);
});

test('a range to the head written by someone other than CodeRabbit does not count', () => {
  const r = evaluate(input({ comments: [{ user: { login: 'Rev4nchist' }, body: summary(BASE, HEAD) }] }));
  assert.equal(r.reviewedHead, false);
});

test('a "Review limit reached" comment with no reviewed range does not count', () => {
  const r = evaluate(input({ comments: [{ user: BOT, body: 'Review limit reached. The review will resume later.' }] }));
  assert.equal(r.reviewedHead, false);
});

test('the coverage marker counts only when it covers the head and its kind is "reviewed"', () => {
  assert.equal(evaluate(input({ comments: [{ user: BOT, body: marker(HEAD) }] })).reviewedHead, true);
  assert.equal(evaluate(input({ comments: [{ user: BOT, body: marker(OLD) }] })).reviewedHead, false);
  assert.equal(evaluate(input({ comments: [{ user: BOT, body: marker(HEAD, 'skipped') }] })).reviewedHead, false);
});

test('a formal CodeRabbit review on the head still counts', () => {
  const r = evaluate(input({ reviews: [{ user: BOT, commit_id: HEAD }] }));
  assert.equal(r.reviewedHead, true);
});

test('a review proof never overrides open threads or a non-success CodeRabbit status', () => {
  const withThread = input({ comments: [{ user: BOT, body: summary(BASE, HEAD) }] });
  withThread.threads = [{ isResolved: false }];
  assert.equal(evaluate(withThread).ready, false);
  const pending = input({ comments: [{ user: BOT, body: summary(BASE, HEAD) }] });
  pending.combined.statuses = [{ context: 'CodeRabbit', state: 'pending' }];
  assert.equal(evaluate(pending).ready, false);
});
