// Tests for review-status.mjs. Run: node --test scripts/github/review-status.test.mjs
// READY and NOT READY outcomes, plus the fields the pr-loop mod reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseSummary } from './review-status.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const body = (sha, score) =>
  `Summary text.\n<!-- greptile_comment -->\n<h2>Confidence Score: ${score}/5</h2>\n` +
  `<!-- greptile_confidence_score:${score} -->\n` +
  `<sub>Reviews (2) · Last reviewed commit: ["fix"](https://github.com/o/r/commit/${sha})</sub>\n` +
  `<!-- /greptile_comment -->`;

const run = (conclusion, status = 'completed', id = 2) => ({
  id, name: 'Greptile Review', app: { slug: 'greptile-apps' }, status, conclusion, output: { summary: 'Greptile has reviewed the Pull Request.' },
});

const GREPTILE_EDIT = { editor: { __typename: 'Bot', login: 'greptile-apps' } };

function input({ prBody = body(HEAD, 5), runs = [run('success')], threads = [], statuses = [], bodyEdits = [GREPTILE_EDIT] } = {}) {
  return {
    pull: { number: 111, state: 'open', merged: false, mergeable_state: 'clean', body: prBody, head: { sha: HEAD, ref: 'feat/x' } },
    combined: { statuses },
    checkRuns: runs,
    threads,
    bodyEdits,
  };
}

test('READY: Greptile check succeeded on the head, summary names the head, confidence 5', () => {
  const r = evaluate(input());
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.reviewedHead, true);
  assert.equal(r.confidence, 5);
});

test('READY: confidence 4 meets the bar', () => {
  assert.equal(evaluate(input({ prBody: body(HEAD, 4) })).ready, true);
});

test('NOT READY: confidence 3 is below the bar and is flagged lowConfidence', () => {
  const r = evaluate(input({ prBody: body(HEAD, 3) }));
  assert.equal(r.ready, false);
  assert.equal(r.lowConfidence, true);
});

test('NOT READY: no Greptile check on the head yet', () => {
  const r = evaluate(input({ runs: [] }));
  assert.equal(r.ready, false);
  assert.equal(r.greptile, 'absent');
  assert.equal(r.unavailable, false);
});

test('NOT READY: a cancelled review (completed/neutral) is not a review', () => {
  const r = evaluate(input({ runs: [run('neutral')] }));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.rateLimited, true, 'older mod copies read rateLimited');
});

test('READY: the newest Greptile run decides when an older one was cancelled', () => {
  const r = evaluate(input({ runs: [run('neutral', 'completed', 1), run('success', 'completed', 2)] }));
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('NOT READY: a newer Greptile run is still in progress', () => {
  const r = evaluate(input({ runs: [run('success', 'completed', 1), run(null, 'in_progress', 2)] }));
  assert.equal(r.ready, false);
  assert.equal(r.greptile, 'pending');
});

test('NOT READY: a summary naming an older commit is UNAVAILABLE, not pending', () => {
  const r = evaluate(input({ prBody: body(OLD, 5) }));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
});

test('NOT READY: a summary without a score is UNAVAILABLE', () => {
  const noScore = body(HEAD, 5).replace(/<!-- greptile_confidence_score:5 -->/, '');
  const r = evaluate(input({ prBody: noScore }));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
  assert.ok(r.reasons.some((x) => /no confidence score/.test(x)));
});

test('NOT READY: a person editing the PR body after Greptile makes the summary unconfirmed', () => {
  const r = evaluate(input({ bodyEdits: [{ editor: { __typename: 'User', login: 'someone' } }, GREPTILE_EDIT] }));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
  assert.ok(r.reasons.some((x) => /edited by someone after Greptile/.test(x)));
});

test('READY: an app editing the PR body after Greptile keeps the summary', () => {
  const r = evaluate(input({ bodyEdits: [{ editor: { __typename: 'Bot', login: 'coderabbitai' } }, GREPTILE_EDIT] }));
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('NOT READY: no body edit history, or none by Greptile, is untrusted', () => {
  const noHistory = input();
  delete noHistory.bodyEdits;
  assert.equal(evaluate(noHistory).ready, false);
  assert.equal(evaluate(input({ bodyEdits: [{ editor: { __typename: 'User', login: 'Rev4nchist' } }] })).ready, false);
});

test('NOT READY: a missing summary block is UNAVAILABLE, and the check-only state stays visible', () => {
  const r = evaluate(input({ prBody: 'A body without the block.' }));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.greptile, 'reviewed');
  assert.ok(r.reasons.some((x) => /summary block is missing.*@greptileai/.test(x)));
});

test('NOT READY: an unresolved review thread blocks even at 5/5', () => {
  assert.equal(evaluate(input({ threads: [{ isResolved: false }] })).ready, false);
});

test('NOT READY: another failing check, reported in the shape the mod parses', () => {
  const other = { id: 9, name: 'Lint', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure' };
  const r = evaluate(input({ runs: [run('success'), other] }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /^check "Lint" is completed\/failure$/.test(x)), r.reasons.join('; '));
});

test('READY: a CodeRabbit commit status no longer blocks', () => {
  const r = evaluate(input({ statuses: [{ context: 'CodeRabbit', state: 'pending', description: 'Review rate limited' }] }));
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('the result carries prState and merged for the watcher', () => {
  const i = input();
  i.pull.state = 'closed';
  i.pull.merged = true;
  const r = evaluate(i);
  assert.equal(r.prState, 'closed');
  assert.equal(r.merged, true);
  assert.equal(r.ready, false);
});

test('parseSummary reads the head SHA and score, and returns nulls without a block', () => {
  assert.deepEqual(parseSummary(body(HEAD, 5)), { present: true, sha: HEAD, confidence: 5 });
  assert.deepEqual(parseSummary('no block'), { present: false, sha: null, confidence: null });
});
