// Tests for review-status.mjs. Run: node --test scripts/github/review-status.test.mjs
// READY and NOT READY outcomes, plus the fields the pr-loop mod reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  parseSummary,
  codeRabbitHeadReview,
  needsCodeRabbitReview,
  summaryCoversHead,
} from './review-status.mjs';

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

test('Greptile-only input unchanged when no CodeRabbit labels', () => {
  const r = evaluate(input());
  assert.equal(r.coderabbit, null);
  assert.equal(r.ready, true);
});

test('CodeRabbit: head review object counts when label review:coderabbit', () => {
  const reviews = [{
    user: { login: 'coderabbitai[bot]', type: 'Bot' },
    commit_id: HEAD,
    body: 'Actionable comments posted: 2',
  }];
  const i = input();
  i.pull.labels = [{ name: 'review:coderabbit' }];
  const r = evaluate({ ...i, reviews, comments: [] });
  assert.equal(r.coderabbitReviewedHead, true);
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('CodeRabbit: stale commit review does not count', () => {
  const reviews = [{
    user: { login: 'coderabbitai[bot]', type: 'Bot' },
    commit_id: OLD,
    body: 'Actionable comments posted: 1',
  }];
  const i = input();
  i.pull.labels = [{ name: 'review:coderabbit' }];
  const r = evaluate({ ...i, reviews, comments: [] });
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.ready, false);
});

test('CodeRabbit: rate limit on status does not count as reviewed', () => {
  const i = input({
    statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
  });
  i.pull.labels = [{ name: 'review:deep' }];
  const r = evaluate({ ...i, reviews: [], comments: [] });
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /rate limited/i.test(x)));
});

test('CodeRabbit: CLI-shaped user review never counts', () => {
  const reviews = [{
    user: { login: 'Rev4nchist', type: 'User' },
    commit_id: HEAD,
    body: 'Actionable comments posted: 9',
  }];
  const i = input();
  i.pull.labels = [{ name: 'review:coderabbit' }];
  const r = evaluate({ ...i, reviews, comments: [] });
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.ready, false);
});

test('summaryCoversHead respects limit warning', () => {
  const limited = `Review limit reached\nbetween ${OLD} and ${HEAD}`;
  assert.equal(summaryCoversHead(limited, HEAD), false);
  assert.equal(needsCodeRabbitReview(['review:coderabbit']), true);
  assert.equal(codeRabbitHeadReview({ head: HEAD, reviews: [], comments: [], statuses: [] }).reviewedHead, false);
});

// ---------------------------------------------------------------------------------------------
// Greptile summary posted as an ISSUE COMMENT (live PRs #152 and #154, 2026-10-25/26).
// Failure modes: the comment is ignored; a stale or foreign comment is trusted; a body-edit check
// voids a comment summary; a reply with the marker from a person or another bot counts.
// ---------------------------------------------------------------------------------------------
const GREPTILE_BOT = { login: 'greptile-apps[bot]', type: 'Bot' };

// Real shape of the #154 comment (badge markup shortened). It has an open marker and NO closing one.
const greptileComment = (sha, score, { user = GREPTILE_BOT, id = 1, updated = '2026-10-26T00:59:46Z', marker = true, scoreMarker = true } = {}) => ({
  id,
  user,
  updated_at: updated,
  body:
    `${marker ? '<!-- greptile_summary -->\n\n' : ''}Greptile review (advisory). Dev Reviewer's gate decides merge readiness; a human merges.\n\n` +
    `<h2><a href="https://app.greptile.com/api/retrigger?id=87727944"></a>Confidence Score: ${score}/5</h2>\n\n` +
    `**[Medium impact]** The reviewed head appears safe to merge.\n\n<details><summary><h3>Summary</h3></summary>\n\nRenames the hook.\n</details>\n\n` +
    `${scoreMarker ? `<!-- greptile_confidence_score:${score} -->\n\n` : ''}` +
    `<sub>Reviews (5) · Last reviewed commit: ["fix(review): keep hook dedup across the ..."](https://github.com/rev4nchist/continuous-claude-v3/commit/${sha}) · [Reviewed by Greptile](https://www.greptile.com/?utm_source=greptile_review&utm_medium=github&utm_campaign=review_private)</sub>`,
});

// The body carries no Greptile block, as on #154 after Greptile moved to comments.
// commentEdits maps a comment id to its GraphQL userContentEdits (newest first). [] = never edited.
const neverEdited = (comments) => Object.fromEntries(comments.map((c) => [c.id, []]));
const withComments = (comments, over = {}) => {
  const { commentEdits = neverEdited(comments), ...rest } = over;
  return { ...input({ prBody: 'A plain body.', ...rest }), comments, commentEdits };
};

test('Greptile comment: a summary comment on the head counts, with its confidence', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 5)]));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.reviewedHead, true);
  assert.equal(r.confidence, 5);
  assert.equal(r.summarySource, 'comment');
});

test('Greptile comment: a low score from the comment is flagged lowConfidence', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 3)]));
  assert.equal(r.ready, false);
  assert.equal(r.lowConfidence, true);
  assert.equal(r.confidence, 3);
});

test('Greptile comment: a comment naming an older commit does not count', () => {
  const r = evaluate(withComments([greptileComment(OLD, 5)]));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
  assert.ok(r.reasons.some((x) => /comment names commit bbbbbbb, not the head/.test(x) && /@greptileai/.test(x)), r.reasons.join('; '));
});

test('Greptile comment: a person posting the same marker never counts', () => {
  const human = greptileComment(HEAD, 5, { user: { login: 'Rev4nchist', type: 'User' } });
  const r = evaluate(withComments([human]));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
});

test('Greptile comment: a Bot from another login never counts', () => {
  const other = greptileComment(HEAD, 5, { user: { login: 'coderabbitai[bot]', type: 'Bot' } });
  assert.equal(evaluate(withComments([other])).reviewedHead, false);
  const lookalike = greptileComment(HEAD, 5, { user: { login: 'greptile-apps-evil[bot]', type: 'Bot' } });
  assert.equal(evaluate(withComments([lookalike])).reviewedHead, false);
});

test('Greptile comment: the right login with type User never counts', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 5, { user: { login: 'greptile-apps[bot]', type: 'User' } })]));
  assert.equal(r.reviewedHead, false);
});

test('Greptile comment: a Greptile bot comment without the summary marker never counts', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 5, { marker: false })]));
  assert.equal(r.reviewedHead, false);
});

test('Greptile comment: a summary without the confidence marker is UNAVAILABLE', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 5, { scoreMarker: false })]));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
});

test('Greptile comment: a 7 character SHA prefix of the head counts; 6 characters do not', () => {
  assert.equal(evaluate(withComments([greptileComment(HEAD.slice(0, 7), 5)])).ready, true);
  assert.equal(evaluate(withComments([greptileComment(HEAD.slice(0, 6), 5)])).ready, false);
});

test('Greptile comment: a human body edit and a missing body block do not void a comment summary', () => {
  const edits = [{ editor: { __typename: 'User', login: 'someone' } }];
  const r = evaluate(withComments([greptileComment(HEAD, 4)], { bodyEdits: edits }));
  assert.equal(r.ready, true, r.reasons.join('; '));
  const noHistory = withComments([greptileComment(HEAD, 4)]);
  delete noHistory.bodyEdits;
  assert.equal(evaluate(noHistory).ready, true);
});

test('Greptile comment: the newest trusted comment decides', () => {
  const stale = greptileComment(OLD, 5, { id: 2, updated: '2026-10-26T02:00:00Z' });
  const fresh = greptileComment(HEAD, 5, { id: 1, updated: '2026-10-26T01:00:00Z' });
  assert.equal(evaluate(withComments([fresh, stale])).ready, false, 'newer comment names an older commit');
  const newer = greptileComment(HEAD, 5, { id: 3, updated: '2026-10-26T03:00:00Z' });
  assert.equal(evaluate(withComments([stale, newer])).ready, true);
});

test('Greptile comment: the check run is still required', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 5)], { runs: [] }));
  assert.equal(r.ready, false);
  assert.equal(r.greptile, 'absent');
});

test('Greptile body fallback: the PR-body block still works with no comments, and keeps its edit check', () => {
  const ok = evaluate({ ...input(), comments: [] });
  assert.equal(ok.ready, true, ok.reasons.join('; '));
  assert.equal(ok.summarySource, 'body');
  const edited = evaluate({ ...input({ bodyEdits: [{ editor: { __typename: 'User', login: 'someone' } }, GREPTILE_EDIT] }), comments: [] });
  assert.equal(edited.ready, false);
  assert.ok(edited.reasons.some((x) => /edited by someone after Greptile/.test(x)));
});

test('Greptile comment: a stale comment does not block a body block that names the head', () => {
  const r = evaluate({ ...input(), comments: [greptileComment(OLD, 5)] });
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.summarySource, 'body');
});

test('Greptile summary missing from body and comments stays UNAVAILABLE with the old reason', () => {
  const r = evaluate(withComments([]));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.summarySource, null);
  assert.ok(r.reasons.some((x) => /summary block is missing.*@greptileai/.test(x)));
});

// ---------------------------------------------------------------------------------------------
// P0: anyone with write access can EDIT the Greptile comment (viewerCanUpdate is true on #154) and
// REST still reports greptile-apps[bot] as the author. The edit history is the only evidence.
// ---------------------------------------------------------------------------------------------
const USER_EDIT = { editor: { __typename: 'User', login: 'Rev4nchist' } };
const BOT_EDIT = { editor: { __typename: 'Bot', login: 'greptile-apps' } };

test('Greptile comment: a person editing the comment after Greptile is never READY, even naming the head at 5/5', () => {
  const forged = greptileComment(HEAD, 5);
  const r = evaluate(withComments([forged], { commentEdits: { [forged.id]: [USER_EDIT, BOT_EDIT] } }));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
  assert.ok(r.reasons.some((x) => /edited by Rev4nchist after Greptile/.test(x) && /@greptileai/.test(x)), r.reasons.join('; '));
});

test('Greptile comment: a person editing a comment Greptile never edited is never READY', () => {
  const forged = greptileComment(HEAD, 5);
  const r = evaluate(withComments([forged], { commentEdits: { [forged.id]: [USER_EDIT] } }));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
});

test('Greptile comment: no edit history for the comment is untrusted', () => {
  const c = greptileComment(HEAD, 5);
  const r = evaluate(withComments([c], { commentEdits: {} }));
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
  const none = withComments([c]);
  delete none.commentEdits;
  assert.equal(evaluate(none).ready, false);
});

test('Greptile comment: app edits only, or Greptile editing after a person, stay READY', () => {
  const c = greptileComment(HEAD, 5);
  const other = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
  assert.equal(evaluate(withComments([c], { commentEdits: { [c.id]: [other, BOT_EDIT] } })).ready, true);
  assert.equal(evaluate(withComments([c], { commentEdits: { [c.id]: [BOT_EDIT, USER_EDIT] } })).ready, true, 'Greptile rewrote it after the person');
});

test('Greptile comment: an edited comment falls back to a body block that names the head', () => {
  const c = greptileComment(HEAD, 5);
  const r = evaluate({ ...input(), comments: [c], commentEdits: { [c.id]: [USER_EDIT, BOT_EDIT] } });
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.summarySource, 'body');
});

// ---------------------------------------------------------------------------------------------
// CodeRabbit comment shapes, copied from live PRs #154 (reviewed), #155 (skipped), 2026-10-26.
// ---------------------------------------------------------------------------------------------
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const HEAD154 = '547d9ae24987323a33ebd6357e0a8405d861feff';
const BASE154 = '6a2da911243d4cd550cf01db073faad6c654108e';
const SUMMARY_MARKER = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
// The head commit was committed at 00:30; CodeRabbit's comments land after it unless a test says otherwise.
const HEAD_DATE = '2026-10-26T00:30:00Z';
const CR_REVIEWED_154 = {
  id: 10,
  updated_at: '2026-10-26T01:30:00Z',
  user: CR_BOT,
  body:
    '<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
    '<!-- recent_review_start -->\n\nNo actionable comments were generated in the recent review.\n\n' +
    `Reviewing files that changed from the base of the PR and between ${BASE154} and ${HEAD154}.\n\n` +
    `<!-- final_review_risk_coverage:{"sourceCommitId":"${HEAD154}","coveredCommitId":"${HEAD154}","kind":"reviewed"} -->\n`,
};
const HEAD155 = '1ef385ad5ccb870e880d16173658432da505839b';
const CR_SKIPPED_155 = {
  id: 11,
  updated_at: '2026-10-26T01:00:00Z',
  user: CR_BOT,
  body:
    '<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n' +
    '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n\n> [!IMPORTANT]\n> ## Review skipped\n> \n' +
    '> Auto reviews are limited based on label configuration.\n> \n> * review:coderabbit\n> * review:deep\n> \n' +
    `> - **Commit**: [1ef385a](<https://github.com/Rev4nchist/Continuous-Claude-v3/commit/${HEAD155}>)\n`,
};
const crInput = (head, comments, reviews = [], over = {}) => {
  const i = input();
  i.pull.head.sha = head;
  i.pull.labels = [{ name: 'review:coderabbit' }];
  i.checkRuns = [run('success')];
  i.pull.body = body(head, 5);
  return { ...i, reviews, comments, commentEdits: neverEdited(comments), headCommittedAt: HEAD_DATE, ...over };
};

test('CodeRabbit: the real #154 summary comment covers its head', () => {
  assert.equal(summaryCoversHead(CR_REVIEWED_154.body, HEAD154), true);
  assert.equal(summaryCoversHead(CR_REVIEWED_154.body, HEAD), false);
  const r = evaluate(crInput(HEAD154, [CR_REVIEWED_154]));
  assert.equal(r.coderabbitReviewedHead, true);
  assert.equal(r.coderabbitLimited, false);
});

test('CodeRabbit: the real #155 "Review skipped" notice never counts, even though it names the head', () => {
  assert.equal(summaryCoversHead(CR_SKIPPED_155.body, HEAD155), false);
  const r = evaluate(crInput(HEAD155, [CR_SKIPPED_155]));
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.coderabbitLimited, true);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /CodeRabbit skipped/i.test(x)), r.reasons.join('; '));
});

test('CodeRabbit: a notice that keeps the coverage marker but says "Review failed" or "Rate limit exceeded" never counts', () => {
  const marker = `<!-- final_review_risk_coverage:{"coveredCommitId":"${HEAD}","kind":"reviewed"} -->`;
  const failed = `> [!CAUTION]\n> ## Review failed\n> The pull request is closed.\n${marker}`;
  const limited = `> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.\n${marker}`;
  for (const text of [failed, limited, 'Review failed - The pull request is closed.\n' + marker]) {
    assert.equal(summaryCoversHead(text, HEAD), false, text);
  }
  const r = evaluate(crInput(HEAD, [{ id: 12, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}
${limited}` }]));
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.coderabbitLimited, true);
});

test('CodeRabbit: a person posting a skip notice or a coverage marker is not CodeRabbit', () => {
  const human = { user: { login: 'Rev4nchist', type: 'User' }, body: CR_REVIEWED_154.body };
  assert.equal(evaluate(crInput(HEAD154, [human])).coderabbitReviewedHead, false);
  const fakeSkip = { user: { login: 'Rev4nchist', type: 'User' }, body: CR_SKIPPED_155.body };
  assert.equal(evaluate(crInput(HEAD155, [fakeSkip])).coderabbitLimited, false);
});

test('CodeRabbit: a labelled PR with no CodeRabbit output at all is pending, not limited', () => {
  const r = evaluate(crInput(HEAD, []));
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.coderabbitLimited, false);
});

test('CodeRabbit: a real review on the head wins over an older skip notice', () => {
  const review = { user: CR_BOT, commit_id: HEAD, body: 'Actionable comments posted: 1' };
  const r = evaluate(crInput(HEAD, [CR_SKIPPED_155], [review]));
  assert.equal(r.coderabbitReviewedHead, true);
  assert.equal(r.coderabbitLimited, false);
});

test('CodeRabbit: the status rate limit also sets coderabbitLimited', () => {
  const i = crInput(HEAD, []);
  i.combined = { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited' }] };
  assert.equal(evaluate(i).coderabbitLimited, true);
});

test('CodeRabbit: an unlabelled PR reports coderabbitLimited null', () => {
  assert.equal(evaluate(input()).coderabbitLimited, null);
});

// ---------------------------------------------------------------------------------------------
// Review round: the notice and the coverage marker come only from the newest CodeRabbit SUMMARY
// comment (marker "summarize by coderabbit.ai"), the notice only when newer than the head commit,
// and the coverage only when nobody but an app edited the comment.
// ---------------------------------------------------------------------------------------------
test('CodeRabbit: a notice from before the head commit is stale and does not report LIMITED', () => {
  const stale = { ...CR_SKIPPED_155, updated_at: '2026-10-26T00:10:00Z' };
  const r = evaluate(crInput(HEAD155, [stale]));
  assert.equal(r.coderabbitReviewedHead, false);
  assert.equal(r.coderabbitLimited, false);
  assert.ok(r.reasons.some((x) => /no CodeRabbit PR-bot review of the head/.test(x)), r.reasons.join('; '));
});

test('CodeRabbit: a chat reply that says "Review limit reached" is not a notice', () => {
  const reply = { id: 13, updated_at: '2026-10-26T02:00:00Z', user: CR_BOT, body: 'Review limit reached for this plan, as you asked.' };
  const r = evaluate(crInput(HEAD155, [reply]));
  assert.equal(r.coderabbitLimited, false);
});

test('CodeRabbit: only the NEWEST summary comment decides the notice', () => {
  const newer = { ...CR_REVIEWED_154, id: 14, updated_at: '2026-10-26T03:00:00Z' };
  const r = evaluate(crInput(HEAD155, [CR_SKIPPED_155, newer]));
  assert.equal(r.coderabbitLimited, false);
});

test('CodeRabbit: with no head commit date the notice cannot be tied to the head, so it does not count', () => {
  const r = evaluate(crInput(HEAD155, [CR_SKIPPED_155], [], { headCommittedAt: undefined }));
  assert.equal(r.coderabbitLimited, false);
  assert.equal(r.ready, false);
});

test('CodeRabbit: a chat reply echoing the coverage text never counts as a review', () => {
  const echo = { id: 15, updated_at: '2026-10-26T02:00:00Z', user: CR_BOT, body: CR_REVIEWED_154.body.replace(SUMMARY_MARKER, '') };
  assert.equal(evaluate(crInput(HEAD154, [echo])).coderabbitReviewedHead, false);
});

test('CodeRabbit: a person editing the summary comment after CodeRabbit voids its coverage', () => {
  const cr = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
  const person = { editor: { __typename: 'User', login: 'Rev4nchist' } };
  const edited = evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: { 10: [person, cr] } }));
  assert.equal(edited.coderabbitReviewedHead, false);
  const clean = evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: { 10: [cr, person] } }));
  assert.equal(clean.coderabbitReviewedHead, true, 'CodeRabbit rewrote it after the person');
  const unknown = evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: {} }));
  assert.equal(unknown.coderabbitReviewedHead, false);
});

test('CodeRabbit: a missing review tells the agent to post @coderabbitai review after a push; a rate limit does not', () => {
  const missing = evaluate(crInput(HEAD, []));
  assert.ok(missing.reasons.some((x) => /no CodeRabbit PR-bot review of the head/.test(x) && /@coderabbitai review/.test(x)), missing.reasons.join('; '));
  const limited = evaluate(crInput(HEAD, [], [], { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited' }] } }));
  assert.ok(limited.reasons.length > 0);
  assert.ok(!limited.reasons.some((x) => /@coderabbitai review/.test(x)), limited.reasons.join('; '));
  const skipped = evaluate(crInput(HEAD155, [CR_SKIPPED_155]));
  assert.ok(!skipped.reasons.some((x) => /@coderabbitai review/.test(x)), skipped.reasons.join('; '));
});
