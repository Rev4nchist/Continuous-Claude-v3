// Tests for evaluate() in coderabbit-status.mjs. Run: node --test scripts/github/coderabbit-status.test.mjs
// Each case names the failure it guards against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './coderabbit-status.mjs';

const HEAD = '4342fb403723f904fb6f3205a5a2019422f68c8c';
const BASE = 'fdb03edb040ff49a77ad759508ae7b9c401ae549';
const OLD = '7e8b0058c204b4f453eaf0009f16908b9405a924';
const BOT = { login: 'coderabbitai[bot]', type: 'Bot' };

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

test('a lookalike account whose login contains "coderabbit" is not trusted (CodeRabbit #65)', () => {
  const body = summary(BASE, HEAD) + '\n' + marker(HEAD);
  for (const user of [{ login: 'coderabbit-helper', type: 'User' }, { login: 'coderabbitai', type: 'User' }, { login: 'coderabbitai[bot]', type: 'User' }]) {
    assert.equal(evaluate(input({ comments: [{ user, body }] })).reviewedHead, false, user.login + '/' + user.type);
    assert.equal(evaluate(input({ reviews: [{ user, commit_id: HEAD, body: '**Actionable comments posted: 1**' }] })).reviewedHead, false, 'review by ' + user.login);
  }
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
  const r = evaluate(input({ reviews: [{ user: BOT, commit_id: HEAD, body: '**Actionable comments posted: 1**\n\n---' }] }));
  assert.equal(r.reviewedHead, true);
});

// PR #65, head a328101 (2026-09-25): the limit was reached, so the head was NOT reviewed. Yet the
// summary kept a range ending at the head inside the limit warning, and CodeRabbit's reply to a
// thread created an empty-bodied "review" on the head. Neither may count.
const limitWarning = (from, to) => `> [!WARNING]
> ## Review limit reached
> - [ ]  **Run on-demand review**
> Reviewing files that changed from the base of the PR and between ${from} and ${to}.`;

test('PR #65 shape: a range to the head inside a "Review limit reached" warning does not count', () => {
  const r = evaluate(input({ comments: [{ user: BOT, body: limitWarning(OLD, HEAD) + '\n' + marker(OLD) }] }));
  assert.equal(r.reviewedHead, false);
  assert.equal(r.ready, false);
});

test('PR #65 shape: an empty-bodied CodeRabbit "review" on the head (a thread reply) does not count', () => {
  const r = evaluate(input({ reviews: [{ user: BOT, commit_id: HEAD, body: '' }] }));
  assert.equal(r.reviewedHead, false);
});

test('the coverage marker still counts when a later limit notice sits in the same comment', () => {
  const r = evaluate(input({ comments: [{ user: BOT, body: limitWarning(BASE, HEAD) + '\n' + marker(HEAD) }] }));
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

// Rate limit cause (proposal A6.5). PR #67 head 4eaac1b and PR #68 head a8d94bf: the commit status
// was success with description "Review rate limited", and the script only said "pending, or skipped".
const withStatus = (state, description) => {
  const i = input();
  i.combined.statuses = [{ context: 'CodeRabbit', state, ...(description === undefined ? {} : { description }) }];
  return i;
};
const RATE = /CodeRabbit rate limited: head not reviewed\. Do not post @coderabbitai review.*-IgnoreReview/;

test('PR #67/#68 shape: status success + "Review rate limited" names the rate limit and sets rateLimited', () => {
  const r = evaluate(withStatus('success', 'Review rate limited'));
  assert.equal(r.rateLimited, true);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => RATE.test(x)), r.reasons.join('; '));
  assert.equal(r.coderabbitDescription, 'Review rate limited');
});

test('the other wording "Review limit reached" is also named as a rate limit', () => {
  const r = evaluate(withStatus('success', 'Review limit reached'));
  assert.equal(r.rateLimited, true);
  assert.ok(r.reasons.some((x) => RATE.test(x)));
});

test('a pending status carrying the limit text still names the rate limit and keeps the pending reason', () => {
  const r = evaluate(withStatus('pending', 'Review rate limited'));
  assert.equal(r.rateLimited, true);
  assert.ok(r.reasons.some((x) => RATE.test(x)));
  assert.ok(r.reasons.some((x) => /is "pending"/.test(x)));
});

test('a missing description keeps the generic reason and rateLimited false', () => {
  const r = evaluate(withStatus('success'));
  assert.equal(r.rateLimited, false);
  assert.equal(r.coderabbitDescription, null);
  assert.ok(r.reasons.some((x) => /no CodeRabbit review of the head commit/.test(x)));
  assert.ok(!r.reasons.some((x) => RATE.test(x)));
});

test('a normal review in progress is not called a rate limit', () => {
  const r = evaluate(withStatus('pending', 'Review in progress'));
  assert.equal(r.rateLimited, false);
  assert.ok(!r.reasons.some((x) => RATE.test(x)));
  assert.ok(r.reasons.some((x) => /no CodeRabbit review of the head commit/.test(x)));
});

test('a reviewed head is never flagged rate limited, even if the status text is stale', () => {
  const i = withStatus('success', 'Review rate limited');
  i.comments = [{ user: BOT, body: summary(BASE, HEAD) }];
  const r = evaluate(i);
  assert.equal(r.rateLimited, false);
  assert.equal(r.reviewedHead, true);
});

// The pr-loop mod reads --json to tell "still waiting" from "nothing left to watch". It must not
// parse the reason text for that: the result carries the PR's own state and merged flag.
test('the result names the PR state and merged flag, so a watcher can stop on closed or merged', () => {
  const open = evaluate(input());
  assert.equal(open.prState, 'open');
  assert.equal(open.merged, false);
  const closed = input();
  closed.pull.state = 'closed';
  const c = evaluate(closed);
  assert.equal(c.prState, 'closed');
  assert.equal(c.merged, false);
  const merged = input();
  merged.pull.state = 'closed';
  merged.pull.merged = true;
  const m = evaluate(merged);
  assert.equal(m.merged, true);
  assert.equal(m.ready, false);
});
