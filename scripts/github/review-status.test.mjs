// Tests for review-status.mjs. Run: node --test scripts/github/review-status.test.mjs
// READY and NOT READY outcomes, plus the fields the pr-loop mod reads.
import { test } from 'node:test';
import { readFileSync, symlinkSync, unlinkSync, rmdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  evaluate,
  parseSummary,
  codeRabbitHeadReview,
  needsCodeRabbitReview,
  summaryCoversHead,
  mergeGraphqlComments,
  requiredBots,
  FAILED_UNREQUIRED_REASON,
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

// Round 3 tightened this: once edited, EVERY editor must be the Greptile app. Before, another app's
// edit, or Greptile editing after a person, stayed READY.
test('Greptile comment: only Greptile edits stay READY; another app, or a person anywhere in the history, does not', () => {
  const c = greptileComment(HEAD, 5);
  const other = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
  assert.equal(evaluate(withComments([c], { commentEdits: { [c.id]: [BOT_EDIT, BOT_EDIT] } })).ready, true);
  assert.equal(evaluate(withComments([c], { commentEdits: { [c.id]: [other, BOT_EDIT] } })).ready, false);
  assert.equal(evaluate(withComments([c], { commentEdits: { [c.id]: [BOT_EDIT, USER_EDIT] } })).ready, false, 'a person edited it earlier');
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
// One fixture, trimmed from the live coderabbitai[bot] comment 6406282914 on PR #155 (head af41b70):
// the picture markup and the autofix footer are cut; the notice text, Run configuration and both
// commit links are verbatim. Only id and updated_at are set here so the timestamp tests stay relative to HEAD_DATE.
const HEAD155 = 'af41b70318f8d7591a27bd16a66e1d65697c2e3d';
const CR_SKIPPED_155 = {
  id: 11,
  updated_at: '2026-10-26T01:00:00Z',
  user: CR_BOT,
  body: [
    '<!-- coderabbit-ai-generated:v1 -->',
    '',
    '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
    '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->',
    '',
    '> [!IMPORTANT]',
    '> ## Review skipped',
    '> ',
    '> Auto reviews are limited based on label configuration.',
    '> ',
    '> <details>',
    '> <summary><strong>:label: Required labels (at least one): 2</strong></summary>',
    '> <dl>',
    '> <dd>',
    '> ',
    '> * review:coderabbit',
    '> * review:deep',
    '> ',
    '> </dd>',
    '> </dl>',
    '> </details>',
    '> ',
    '> Please check the settings in the CodeRabbit UI or the `.coderabbit.yaml` file in this repository. To trigger a single review, invoke the `@coderabbitai review` command.',
    '> ',
    '> <details>',
    '> <summary><strong>Run configuration</strong></summary>',
    '> <dl>',
    '> <dd>',
    '> ',
    '> - **Source mode**: Auto',
    '> - **Repository**: [Rev4nchist/Continuous-Claude-v3](<https://github.com/Rev4nchist/Continuous-Claude-v3>)',
    '> - **Branch**: [feat/ccv3-cr-install](<https://github.com/Rev4nchist/Continuous-Claude-v3/tree/feat%2Fccv3-cr-install>)',
    `> - **File**: [.coderabbit.yaml](<https://github.com/Rev4nchist/Continuous-Claude-v3/blob/${HEAD155}/.coderabbit.yaml>)`,
    `> - **Commit**: [${HEAD155.slice(0, 7)}](<https://github.com/Rev4nchist/Continuous-Claude-v3/commit/${HEAD155}>)`,
    '> - **Layers**: Repository YAML',
    '> - **Review profile**: CHILL',
    '> - **Plan**: Essentials',
    '> ',
    '> </dd>',
    '> </dl>',
    '> </details>',
    '> ',
    '> You can disable this status message by setting the `reviews.review_status` to `false` in the CodeRabbit configuration file.',
    '',
    '<!-- end of auto-generated comment: skip review by coderabbit.ai -->',
    '',
  ].join('\n'),
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
// A notice with its commit line removed: only the date can tie it to the head.
const NO_SHA_SKIPPED = { ...CR_SKIPPED_155, body: CR_SKIPPED_155.body.replace(/\n> - \*\*(?:File|Commit)\*\*:.*(?=\n)/g, '') };

test('CodeRabbit: a notice with no commit, from before the head commit, is stale and does not report LIMITED', () => {
  const stale = { ...NO_SHA_SKIPPED, updated_at: '2026-10-26T00:10:00Z' };
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

test('CodeRabbit: with no head commit date a notice with no commit cannot be tied to the head, so it does not count', () => {
  const r = evaluate(crInput(HEAD155, [NO_SHA_SKIPPED], [], { headCommittedAt: undefined }));
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
  const earlier = evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: { 10: [cr, person] } }));
  assert.equal(earlier.coderabbitReviewedHead, false, 'a person edited it earlier: the history is no longer app-only');
  const unknown = evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: {} }));
  assert.equal(unknown.coderabbitReviewedHead, false);
});

// XR-b7e03c4-2: once the summary comment has edits, every editor must be the CodeRabbit app
// (GraphQL login coderabbitai, type Bot), the same rule as the Greptile comment.
const CR_EDIT = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
const crEdits = (edits) => evaluate(crInput(HEAD154, [CR_REVIEWED_154], [], { commentEdits: { 10: edits } }));

test('CodeRabbit comment editors: a human anywhere in the edit history of an edited summary is not counted', () => {
  const person = { editor: { __typename: 'User', login: 'Rev4nchist' } };
  for (const edits of [[person], [person, CR_EDIT], [CR_EDIT, person], [CR_EDIT, person, CR_EDIT]]) {
    assert.equal(crEdits(edits).coderabbitReviewedHead, false, JSON.stringify(edits));
  }
});

test('CodeRabbit comment editors: another app in the edit history is not counted', () => {
  const other = { editor: { __typename: 'Bot', login: 'greptile-apps' } };
  for (const edits of [[other], [other, CR_EDIT], [CR_EDIT, other]]) {
    assert.equal(crEdits(edits).coderabbitReviewedHead, false, JSON.stringify(edits));
  }
});

test('CodeRabbit comment editors: a coderabbitai editor that is a User, not a Bot, and a deleted editor are not counted', () => {
  const lookalike = { editor: { __typename: 'User', login: 'coderabbitai' } };
  const deleted = { editor: null };
  assert.equal(crEdits([lookalike]).coderabbitReviewedHead, false);
  assert.equal(crEdits([CR_EDIT, deleted]).coderabbitReviewedHead, false);
});

test('CodeRabbit comment editors: coderabbitai Bot-only edits are counted', () => {
  assert.equal(crEdits([CR_EDIT, CR_EDIT]).coderabbitReviewedHead, true);
  assert.equal(crEdits([CR_EDIT]).coderabbitReviewedHead, true);
});

test('CodeRabbit comment editors: a summary with no edits is counted', () => {
  assert.equal(crEdits([]).coderabbitReviewedHead, true);
});

test('CodeRabbit comment editors: the rule also holds through mergeGraphqlComments (one GraphQL node)', () => {
  const node = (edits) => ({
    databaseId: 10, body: CR_REVIEWED_154.body, author: { login: 'coderabbitai', __typename: 'Bot' },
    lastEditedAt: edits.length ? '2026-10-26T01:10:00Z' : null, updatedAt: CR_REVIEWED_154.updated_at,
    userContentEdits: { nodes: edits },
  });
  const reviewed = (edits) => {
    const { comments, commentEdits } = mergeGraphqlComments([CR_REVIEWED_154], [node(edits)]);
    return evaluate({ ...crInput(HEAD154, comments), commentEdits }).coderabbitReviewedHead;
  };
  assert.equal(reviewed([]), true);
  assert.equal(reviewed([CR_EDIT]), true);
  assert.equal(reviewed([{ editor: { __typename: 'User', login: 'Rev4nchist' } }, CR_EDIT]), false);
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

// ---------------------------------------------------------------------------------------------
// Greptile finding 4376918068: a commit can exist locally before CodeRabbit posts a notice for the
// PREVIOUS head, then be pushed. The commit date alone would tie that old notice to the new head.
// When the notice names a commit (link or SHA), that commit decides; the date is only a fallback.
// ---------------------------------------------------------------------------------------------
test('CodeRabbit: a notice naming the previous head, posted after the new head was committed, does not count for the new head', () => {
  const NEW_HEAD = 'c'.repeat(40);
  const OLD_HEAD = HEAD155; // the notice names this commit
  // Notice posted 01:00, new head committed 00:30 (earlier), pushed after the notice.
  const r = evaluate(crInput(NEW_HEAD, [CR_SKIPPED_155]));
  assert.equal(r.coderabbitLimited, false, r.reasons.join('; '));
  assert.equal(r.coderabbitReviewedHead, false);
  assert.ok(r.reasons.some((x) => /no CodeRabbit PR-bot review of the head/.test(x) && /@coderabbitai review/.test(x)), r.reasons.join('; '));
  assert.ok(OLD_HEAD !== NEW_HEAD);
});

test('CodeRabbit: a notice naming the head by a 7 character prefix counts; a different 7 character prefix does not', () => {
  const bare = (sha) => ({ ...CR_SKIPPED_155, body: CR_SKIPPED_155.body.replaceAll(HEAD155, sha) });
  assert.equal(evaluate(crInput(HEAD155, [bare(HEAD155.slice(0, 7))])).coderabbitLimited, true);
  assert.equal(evaluate(crInput(HEAD155, [bare('af41b7f')])).coderabbitLimited, false);
});

test('CodeRabbit: the real #155 notice names its head in the Commit line and File link; it is for that head only', () => {
  assert.equal((CR_SKIPPED_155.body.match(/- \*\*Commit\*\*:/g) ?? []).length, 1, 'one Commit line');
  const other = HEAD155.replace(/^af41b70/, '0000000');
  assert.equal(evaluate(crInput(HEAD155, [CR_SKIPPED_155])).coderabbitLimited, true);
  assert.equal(evaluate(crInput(other, [CR_SKIPPED_155])).coderabbitLimited, false);
});

test('CodeRabbit: a notice that names no commit still falls back to the timestamp', () => {
  const noSha = NO_SHA_SKIPPED;
  assert.ok(!/\/(?:commit|blob)\//.test(noSha.body), 'fixture names no commit in a Commit line or File link');
  const after = evaluate(crInput(HEAD, [noSha]));
  assert.equal(after.coderabbitLimited, true, 'newer than the head commit: counts');
  const before = evaluate(crInput(HEAD, [{ ...noSha, updated_at: '2026-10-26T00:10:00Z' }]));
  assert.equal(before.coderabbitLimited, false, 'older than the head commit: stale');
});

// ---------------------------------------------------------------------------------------------
// Greptile round 3 (thread 4377276379): the REST body and the GraphQL edit history come from two
// requests. An edit between them pairs a new body with a stale history. The body that is parsed
// must be the body GraphQL returned in the same response as the edit history.
// ---------------------------------------------------------------------------------------------
const gqlNode = (c, { body = c.body, edits = [], lastEditedAt = null, author = { login: 'greptile-apps', __typename: 'Bot' } } = {}) => ({
  databaseId: c.id,
  body,
  author,
  lastEditedAt,
  updatedAt: c.updated_at,
  userContentEdits: { nodes: edits },
});
const fromGraphql = (rest, node) => ({ ...input({ prBody: 'A plain body.' }), ...mergeGraphqlComments([rest], [node]) });
const EDITED_AT = '2026-10-26T01:10:00Z';

test('Greptile GraphQL: the GraphQL body wins over a stale REST body that names the head', () => {
  const rest = greptileComment(HEAD, 5);
  const edited = greptileComment(OLD, 5).body;
  const r = evaluate(fromGraphql(rest, gqlNode(rest, { body: edited, edits: [BOT_EDIT], lastEditedAt: EDITED_AT })));
  assert.equal(r.ready, false, 'the newer GraphQL text names an older commit');
  assert.ok(r.reasons.some((x) => /names commit bbbbbbb, not the head/.test(x)), r.reasons.join('; '));
});

test('Greptile GraphQL: the GraphQL body is used when it is the one that names the head', () => {
  const rest = greptileComment(OLD, 3);
  const r = evaluate(fromGraphql(rest, gqlNode(rest, { body: greptileComment(HEAD, 5).body, edits: [BOT_EDIT], lastEditedAt: EDITED_AT })));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.summarySource, 'comment');
  assert.equal(r.confidence, 5);
});

test('Greptile GraphQL: a score raised in the GraphQL body is read from GraphQL, not REST', () => {
  const rest = greptileComment(HEAD, 5);
  const r = evaluate(fromGraphql(rest, gqlNode(rest, { body: greptileComment(HEAD, 2).body, edits: [BOT_EDIT], lastEditedAt: EDITED_AT })));
  assert.equal(r.confidence, 2, 'the score comes from the GraphQL body');
  assert.equal(r.lowConfidence, true);
  assert.equal(r.ready, false);
});

test('Greptile GraphQL: a person in the edit history of an edited comment is not trusted', () => {
  const rest = greptileComment(HEAD, 5);
  for (const edits of [[USER_EDIT], [USER_EDIT, BOT_EDIT], [BOT_EDIT, USER_EDIT]]) {
    const r = evaluate(fromGraphql(rest, gqlNode(rest, { edits, lastEditedAt: EDITED_AT })));
    assert.equal(r.ready, false, JSON.stringify(edits));
    assert.equal(r.unavailable, true);
    assert.ok(r.reasons.some((x) => /edited by Rev4nchist/.test(x)), r.reasons.join('; '));
  }
});

test('Greptile GraphQL: another app in the edit history of an edited comment is not trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const other = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
  assert.equal(evaluate(fromGraphql(rest, gqlNode(rest, { edits: [other, BOT_EDIT], lastEditedAt: EDITED_AT }))).ready, false);
});

test('Greptile GraphQL: a greptile-apps editor that is a User, not a Bot, is not trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const lookalike = { editor: { __typename: 'User', login: 'greptile-apps' } };
  assert.equal(evaluate(fromGraphql(rest, gqlNode(rest, { edits: [lookalike], lastEditedAt: EDITED_AT }))).ready, false);
});

test('Greptile GraphQL: Greptile-only edits are trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const r = evaluate(fromGraphql(rest, gqlNode(rest, { edits: [BOT_EDIT, BOT_EDIT], lastEditedAt: EDITED_AT })));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.summarySource, 'comment');
});

test('Greptile GraphQL: a fresh comment with no edits is trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const r = evaluate(fromGraphql(rest, gqlNode(rest)));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.confidence, 5);
});

test('Greptile GraphQL: a comment missing from the GraphQL page is not trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const r = evaluate({ ...input({ prBody: 'A plain body.' }), ...mergeGraphqlComments([rest], []) });
  assert.equal(r.ready, false);
  assert.equal(r.unavailable, true);
});

test('Greptile GraphQL: a GraphQL author that is not the REST author is not trusted', () => {
  const rest = greptileComment(HEAD, 5);
  const r = evaluate(fromGraphql(rest, gqlNode(rest, { author: { login: 'Rev4nchist', __typename: 'User' } })));
  assert.equal(r.ready, false);
});

test('mergeGraphqlComments keeps the REST fields and takes the body, stamp and edits from GraphQL', () => {
  const rest = greptileComment(HEAD, 5);
  const node = { ...gqlNode(rest, { body: 'new text', edits: [BOT_EDIT], lastEditedAt: EDITED_AT }), updatedAt: EDITED_AT };
  const { comments, commentEdits } = mergeGraphqlComments([rest], [node]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'new text');
  assert.equal(comments[0].updated_at, EDITED_AT);
  assert.equal(comments[0].lastEditedAt, EDITED_AT);
  assert.deepEqual(comments[0].user, rest.user);
  assert.deepEqual(commentEdits[rest.id], [BOT_EDIT]);
});

// ---------------------------------------------------------------------------------------------
// P3b READY v2: the labels decide which bots must have reviewed the head. A PR with no review: and
// no risk: label keeps today's rule exactly (Greptile required, CodeRabbit not).
// ---------------------------------------------------------------------------------------------
const HELD_NOTE = 'deep review held (Apex billing, D3)';
// The review router's own comment for a head (P3c). `routed` adds one for HEAD unless `router: false`
// or `router: <sha>`, so the routing tests describe a PR the router has classified.
const routerComment = (sha, { id = 900, user = { login: 'github-actions[bot]', type: 'Bot' } } = {}) => ({
  id, user, body: `<!-- review-router -->\n<!-- review-router-state class=infra head=${sha} -->\nNo open router notes.`,
});
const routed = (labels, over = {}) => {
  const i = input(over.input);
  i.pull.labels = labels.map((name) => ({ name }));
  if (over.draft !== undefined) i.pull.draft = over.draft;
  const router = over.router === false ? [] : [routerComment(over.router ?? HEAD)];
  const { comments = [], ...rest } = over.eval ?? {};
  return { ...i, reviews: [], ...rest, comments: [...router, ...comments] };
};

test('router check: relaxing labels count only when the router classified the current head', () => {
  const crOnly = (o) => evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] }, ...o }));
  assert.equal(crOnly({}).ready, true, crOnly({}).reasons.join('; '));
  for (const [name, o] of [['no router comment', { router: false }], ['router saw an older head', { router: OLD }]]) {
    const r = crOnly(o);
    assert.equal(r.ready, false, `${name}: a stale or unrouted label must not drop Greptile`);
    assert.deepEqual(r.routing.required, ['greptile', 'coderabbit'], name);
    assert.match(r.routing.unverified, /has not classified this head/, name);
  }
  const docs = evaluate(routed(['risk:docs'], { input: NO_GREPTILE, router: false }));
  assert.equal(docs.ready, false, 'a code push after a docs routing that failed to re-route keeps Greptile');
});

test('router check: a person-authored or pasted router marker is ignored', () => {
  const forged = routerComment(HEAD, { id: 1, user: { login: 'someone', type: 'User' } });
  const r = evaluate(routed(['risk:docs'], { input: NO_GREPTILE, router: false, eval: { comments: [forged] } }));
  assert.equal(r.ready, false);
  assert.deepEqual(r.routing.required, ['greptile']);
  const bot = { ...routerComment(HEAD, { id: 5 }), body: 'quoted: <!-- review-router -->\n<!-- review-router-state class=docs head=' + HEAD + ' -->' };
  assert.equal(evaluate(routed(['risk:docs'], { input: NO_GREPTILE, router: false, eval: { comments: [bot] } })).ready, false, 'the marker must start the body');
});

test('router check: the lowest-id bot comment is the state; a later bot comment cannot override it', () => {
  const first = routerComment(OLD, { id: 10 });
  const later = routerComment(HEAD, { id: 20 });
  const r = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, router: false, eval: { reviews: [CR_REVIEW], comments: [later, first] } }));
  assert.equal(r.ready, false, 'the router\'s own (first) comment names an older head');
  assert.match(r.routing.unverified, /has not classified this head/);
});

test('router check: a comment from a User account named github-actions[bot] is not the router', () => {
  const fake = routerComment(HEAD, { id: 1, user: { login: 'github-actions[bot]', type: 'User' } });
  const r = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, router: false, eval: { reviews: [CR_REVIEW], comments: [fake] } }));
  assert.equal(r.ready, false);
});

test('router check: a person risk label above the saved class keeps Greptile until the router routes it', () => {
  const r = evaluate(routed(['review:coderabbit', 'risk:r3'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(r.ready, false, 'the saved class is infra; risk:r3 was added after the router ran');
  assert.match(r.routing.unverified, /higher than the class the review router saved/);
  assert.ok(r.reasons.some((x) => /^Greptile is required because a risk label is higher/.test(x)), r.reasons.join('; '));
  const same = evaluate(routed(['review:coderabbit', 'risk:infra'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(same.ready, true, `a label at the saved class is fine: ${same.reasons.join('; ')}`);
});

test('router check: labels that already require Greptile are untouched by the router check', () => {
  const r = evaluate(routed(['review:deep'], { router: false, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.routing.unverified, undefined);
  const plain = evaluate(routed([], { router: false }));
  assert.equal(plain.ready, true, 'a no-label PR is evaluated exactly as before');
});
const CR_REVIEW = { user: CR_BOT, commit_id: HEAD, body: 'Actionable comments posted: 1' };
const NO_GREPTILE = { runs: [] };

test('requiredBots: the label table', () => {
  const only = (r) => [r.greptile, r.coderabbit, r.held, r.source];
  assert.deepEqual(only(requiredBots([])), [true, false, null, 'default']);
  assert.deepEqual(only(requiredBots(['unrelated'])), [true, false, null, 'default']);
  assert.deepEqual(only(requiredBots(['risk:normal'])), [true, false, null, 'labels'], 'a risk label alone keeps Greptile');
  assert.deepEqual(only(requiredBots(['risk:docs'])), [false, false, null, 'labels']);
  assert.deepEqual(only(requiredBots(['review:coderabbit'])), [false, true, null, 'labels']);
  assert.deepEqual(only(requiredBots(['review:deep'])), [true, true, null, 'labels']);
  assert.deepEqual(only(requiredBots(['review:deep-held'])), [false, true, HELD_NOTE, 'labels']);
  assert.deepEqual(only(requiredBots(['review:deep-held', 'review:coderabbit'])), [false, true, HELD_NOTE, 'labels']);
  assert.deepEqual(only(requiredBots(['review:deep', 'review:deep-held'])), [true, true, null, 'labels'], 'review:deep wins');
  assert.deepEqual(only(requiredBots(['risk:docs', 'review:coderabbit'])), [false, true, null, 'labels']);
});

test('requiredBots: risk:docs skips review only when no heavier risk label is present', () => {
  for (const heavier of ['risk:normal', 'risk:steering', 'risk:infra', 'risk:high', 'risk:r3']) {
    const r = requiredBots(['risk:docs', heavier]);
    assert.equal(r.greptile, true, heavier);
    assert.equal(r.coderabbit, false, heavier);
  }
});

test('routing: review:deep needs CodeRabbit AND Greptile on the head', () => {
  const both = evaluate(routed(['review:deep'], { eval: { reviews: [CR_REVIEW] } }));
  assert.equal(both.ready, true, both.reasons.join('; '));
  const noCr = evaluate(routed(['review:deep']));
  assert.equal(noCr.ready, false);
  assert.ok(noCr.reasons.some((x) => /no CodeRabbit PR-bot review/.test(x)), noCr.reasons.join('; '));
  const noGr = evaluate(routed(['review:deep'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(noGr.ready, false);
  assert.equal(noGr.greptile, 'absent');
  assert.deepEqual(noGr.routing.required, ['greptile', 'coderabbit']);
});

test('routing: review:deep-held needs CodeRabbit only and carries the held note, not a reason', () => {
  const r = evaluate(routed(['review:deep-held'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.deepEqual(r.routing, { required: ['coderabbit'], held: HELD_NOTE, source: 'labels' });
  assert.equal(r.greptile, 'absent', 'Greptile state is still reported');
  assert.ok(!r.reasons.some((x) => /held|Greptile/.test(x)), r.reasons.join('; '));
  const lowGreptile = evaluate(routed(['review:deep-held'], { input: { prBody: body(HEAD, 2) }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(lowGreptile.ready, false, 'a Greptile review of the head under the bar blocks even when Greptile is not required');
  assert.equal(lowGreptile.confidence, 2);
  const noCr = evaluate(routed(['review:deep-held']));
  assert.equal(noCr.ready, false, 'CodeRabbit is still required');
  const upgraded = evaluate(routed(['review:deep', 'review:deep-held'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(upgraded.ready, false, 'review:deep wins: Greptile is required again');
  assert.equal(upgraded.routing.held, null);
});

test('routing: review:coderabbit alone needs CodeRabbit; a cancelled Greptile does not block or read as LIMITED', () => {
  const r = evaluate(routed(['review:coderabbit'], { input: { runs: [run('neutral')] }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.greptile, 'cancelled', 'raw Greptile state is reported');
  assert.equal(r.rateLimited, false, 'the mod must not alert LIMITED for a bot that does not block');
  assert.deepEqual(r.routing.required, ['coderabbit']);
});

test('routing: risk:docs with no review label needs no bot review', () => {
  const r = evaluate(routed(['risk:docs'], { input: NO_GREPTILE }));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.coderabbit, null);
  assert.deepEqual(r.routing, { required: [], held: null, source: 'labels' });
  const failing = evaluate(routed(['risk:docs'], { input: { runs: [], threads: [{ isResolved: false }] } }));
  assert.equal(failing.ready, false, 'threads still block');
});

test('routing: no review or risk label is the old rule (Greptile required, CodeRabbit not)', () => {
  const none = evaluate(routed([], { input: NO_GREPTILE }));
  assert.equal(none.ready, false);
  assert.equal(none.greptile, 'absent');
  assert.deepEqual(none.routing, { required: ['greptile'], held: null, source: 'default' });
  assert.equal(none.coderabbit, null);
  const withRisk = evaluate(routed(['risk:high'], { input: NO_GREPTILE }));
  assert.equal(withRisk.ready, false, 'risk:high alone still needs Greptile');
});

test('G-R1: a draft PR is never READY, whatever the labels', () => {
  const msg = 'PR is a draft (no bot review on drafts)';
  assert.ok(evaluate(routed([], { draft: true })).reasons.includes(msg));
  assert.equal(evaluate(routed([], { draft: true })).ready, false);
  const docs = evaluate(routed(['risk:docs'], { input: NO_GREPTILE, draft: true }));
  assert.equal(docs.ready, false);
  assert.ok(docs.reasons.includes(msg));
  assert.equal(evaluate(routed([], { draft: false })).ready, true);
});

test('G-R4: Greptile summary names an older SHA than the final head: not READY', () => {
  const r = evaluate(withComments([greptileComment(OLD, 5)]));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, false);
  assert.ok(r.reasons.some((x) => /not the head/.test(x)), r.reasons.join('; '));
});

test('G-R5: confidence 3/5 is not READY, and one unresolved thread at 5/5 is not READY', () => {
  const low = evaluate(input({ prBody: body(HEAD, 3) }));
  assert.equal(low.ready, false);
  assert.ok(low.reasons.some((x) => /confidence 3\/5 is below 4/.test(x)), low.reasons.join('; '));
  const thread = evaluate(input({ threads: [{ isResolved: false }, { isResolved: true }] }));
  assert.equal(thread.ready, false);
  assert.equal(thread.unresolved, 1);
});

test('G-R8: a CodeRabbit rate-limit notice on a review:coderabbit PR is not READY and reports limited', () => {
  const notice = { id: 20, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.` };
  const r = evaluate(crInput(HEAD, [notice]));
  assert.equal(r.ready, false);
  assert.equal(r.coderabbitLimited, true);
  assert.ok(r.reasons.some((x) => /CodeRabbit rate limited/.test(x)), r.reasons.join('; '));
});

// A Greptile check that ends "failure" DID review: the score is under the repo bar (4/5).
test('Greptile failure with a summary on the head: reviewed, low confidence blocks, not "did not finish"', () => {
  const r = evaluate(input({ runs: [run('failure')], prBody: body(HEAD, 3) }));
  assert.equal(r.ready, false);
  assert.equal(r.reviewedHead, true);
  assert.equal(r.lowConfidence, true);
  assert.equal(r.unavailable, false);
  assert.equal(r.rateLimited, false);
  assert.ok(r.reasons.some((x) => /Greptile confidence 3\/5 is below 4/.test(x)), r.reasons.join('; '));
  assert.ok(!r.reasons.some((x) => /did not finish/.test(x)), r.reasons.join('; '));
});

test('Greptile failure reads the comment summary too', () => {
  const r = evaluate(withComments([greptileComment(HEAD, 2)], { runs: [run('failure')] }));
  assert.equal(r.reviewedHead, true);
  assert.equal(r.confidence, 2);
  assert.equal(r.ready, false);
});

test('Greptile failure with no usable summary stays unavailable', () => {
  const r = evaluate(input({ runs: [run('failure')], prBody: body(OLD, 3) }));
  assert.equal(r.reviewedHead, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /did not finish a review of the head \(completed\/failure/.test(x)), r.reasons.join('; '));
});

test('Greptile failure never reads READY, even when the summary scores 5/5', () => {
  const r = evaluate(input({ runs: [run('failure')], prBody: body(HEAD, 5) }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => /ended failure/.test(x)), r.reasons.join('; '));
});

test('Greptile neutral (cancelled by a newer push) gets its own reason, keeps unavailable for older mod copies', () => {
  const r = evaluate(input({ runs: [run('neutral')] }));
  assert.equal(r.ready, false);
  assert.equal(r.greptile, 'cancelled');
  assert.equal(r.unavailable, true);
  assert.equal(r.rateLimited, true);
  assert.ok(r.reasons.includes('Greptile review of the head was cancelled (superseded by a push); wait for the review of the new head'), r.reasons.join('; '));
  assert.ok(!r.reasons.some((x) => /did not finish/.test(x)), r.reasons.join('; '));
});

// ---------------------------------------------------------------------------------------------
// routedReviewed: every bot in routing.required has reviewed the head. The mod keys on it.
// ---------------------------------------------------------------------------------------------
test('routedReviewed: a review:coderabbit PR counts CodeRabbit, not Greptile', () => {
  const reviewed = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(reviewed.routedReviewed, true);
  assert.equal(reviewed.reviewedHead, false, 'the Greptile field keeps its meaning');
  const notYet = evaluate(routed(['review:coderabbit'], { eval: { reviews: [] } }));
  assert.equal(notYet.routedReviewed, false, 'Greptile reviewed the head, CodeRabbit did not');
  assert.equal(notYet.reviewedHead, true);
});

test('routedReviewed: review:deep-held counts CodeRabbit only', () => {
  assert.equal(evaluate(routed(['review:deep-held'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } })).routedReviewed, true);
  assert.equal(evaluate(routed(['review:deep-held'], { input: NO_GREPTILE })).routedReviewed, false);
});

test('routedReviewed: review:deep needs both bots', () => {
  assert.equal(evaluate(routed(['review:deep'], { eval: { reviews: [CR_REVIEW] } })).routedReviewed, true);
  assert.equal(evaluate(routed(['review:deep'], { input: NO_GREPTILE, eval: { reviews: [CR_REVIEW] } })).routedReviewed, false, 'no Greptile review');
  assert.equal(evaluate(routed(['review:deep'])).routedReviewed, false, 'no CodeRabbit review');
});

test('routedReviewed: risk:docs alone requires no bot, so it is true', () => {
  const r = evaluate(routed(['risk:docs'], { input: NO_GREPTILE }));
  assert.equal(r.routedReviewed, true);
  assert.equal(r.reviewedHead, false);
});

test('routedReviewed: a PR with no router label follows Greptile exactly', () => {
  assert.equal(evaluate(routed([])).routedReviewed, true);
  assert.equal(evaluate(routed([], { input: NO_GREPTILE })).routedReviewed, false);
  assert.equal(evaluate(routed([], { input: { prBody: body(HEAD, 2) } })).routedReviewed, true, 'a low score is still a review');
});

// ---------------------------------------------------------------------------------------------
// Critic round: "Greptile not required" means a MISSING Greptile review does not block. A Greptile review
// of the head that scored under the bar, or a check that ended failure, blocks whatever the labels say.
// ---------------------------------------------------------------------------------------------
test('Greptile reviewed the head at 2/5 on a review:coderabbit PR: blocks, lowConfidence stays true', () => {
  const r = evaluate(routed(['review:coderabbit'], { input: { prBody: body(HEAD, 2) }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(r.ready, false);
  assert.equal(r.lowConfidence, true);
  assert.equal(r.confidence, 2);
  assert.ok(r.reasons.some((x) => /Greptile confidence 2\/5 is below 4/.test(x)), r.reasons.join('; '));
  assert.equal(r.rateLimited, false, 'it did review: not a missing review');
});

test('Greptile reviewed at 3/5 on risk:docs and on review:deep-held: blocks too', () => {
  for (const labels of [['risk:docs'], ['review:deep-held']]) {
    const r = evaluate(routed(labels, { input: { prBody: body(HEAD, 3) }, eval: { reviews: [CR_REVIEW] } }));
    assert.equal(r.ready, false, labels.join());
    assert.equal(r.lowConfidence, true, labels.join());
  }
});

test('Greptile check failure with a head summary blocks on a PR that does not require Greptile', () => {
  const low = evaluate(routed(['review:coderabbit'], { input: { runs: [run('failure')], prBody: body(HEAD, 3) }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(low.ready, false);
  assert.equal(low.lowConfidence, true);
  const high = evaluate(routed(['review:coderabbit'], { input: { runs: [run('failure')], prBody: body(HEAD, 5) }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(high.ready, false);
  assert.ok(high.reasons.some((x) => /^Greptile check ended failure/.test(x)), high.reasons.join('; '));
});

test('a MISSING or unusable Greptile review still does not block a PR that does not require it', () => {
  for (const input of [{ runs: [] }, { runs: [run('neutral')] }, { prBody: body(OLD, 5) }]) {
    const r = evaluate(routed(['review:coderabbit'], { input, eval: { reviews: [CR_REVIEW] } }));
    assert.equal(r.ready, true, r.reasons.join('; '));
  }
});

test('run through a junction, the script still runs main (a plain path compare would skip it and exit 0)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-junction-'));
  const link = path.join(dir, 'github-link');
  try {
    symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, 'junction');
    const r = spawnSync(process.execPath, [path.join(link, 'review-status.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: review-status\.mjs/);
  } finally {
    // Remove the link itself first, so the recursive remove never follows it into the repo.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* no link was made */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Greptile check that ended failure on the head blocks even when its summary is unusable or a re-run is pending', () => {
  const cases = {
    'summary names an older SHA': { runs: [run('failure')], prBody: body(OLD, 3) },
    'a re-run is pending after the failure': { runs: [run('failure', 'completed', 2), run(null, 'in_progress', 3)], prBody: body(OLD, 3) },
  };
  for (const [name, input] of Object.entries(cases)) {
    const r = evaluate(routed(['review:coderabbit'], { input, eval: { reviews: [CR_REVIEW] } }));
    assert.equal(r.ready, false, name);
    assert.ok(r.reasons.includes(FAILED_UNREQUIRED_REASON), `${name}: ${r.reasons.join('; ')}`);
  }
  const cleared = evaluate(routed(['review:coderabbit'], { input: { runs: [run('failure', 'completed', 2), run('success', 'completed', 3)] }, eval: { reviews: [CR_REVIEW] } }));
  assert.equal(cleared.ready, true, `a later successful review clears it: ${cleared.reasons.join('; ')}`);
});

test('REVIEW.md labels: .coderabbit.yaml auto_review.labels lists every label that requires CodeRabbit', () => {
  const yamlText = readFileSync(new URL('../../.coderabbit.yaml', import.meta.url), 'utf8');
  const block = /auto_review:[\s\S]*?labels:\s*\r?\n((?:\s+-\s*"[^"]+"\s*\r?\n)+)/.exec(yamlText);
  assert.ok(block, 'auto_review.labels list found');
  const listed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const label of ['review:coderabbit', 'review:deep', 'review:deep-held']) {
    assert.equal(requiredBots([label]).coderabbit, true, label);
    assert.ok(listed.includes(label), `${label} is missing from .coderabbit.yaml auto_review.labels (${listed.join(', ')})`);
  }
});
