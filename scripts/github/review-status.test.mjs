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
  greptileAutoFrom,
} from './review-status.mjs';
// P4b proof gate: parseProof, PROOF_REASON_PREFIX, PROOF_TYPES, PROOF_REPOS, docsHeadVerified.
import * as RS from './review-status.mjs';
import { matchGlob as matchGlobFn } from './review-router.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
// The commit a RED line names. Any 7 to 40 hex characters pass; membership in the PR is not checked.
const RED_SHA = 'c'.repeat(7);

// The Evidence block from pr-and-commit-style.md. Every body `input()` builds carries one, so the READY
// tests that are about the reviews stay READY. The proof tests below change or remove it.
const fenced = (text) => `\`\`\`text\n${text}\n\`\`\`\n`;
const proofField = (key, sha, out) => `${key}: \`node --test x.test.mjs\` @ ${sha}\n${fenced(out)}`;
const proof = (head, type = 'bugfix') => {
  const lines = ['', '', '## Evidence', '', `Proof type: ${type}`, ''];
  if (type === 'docs') return lines.join('\n');
  const first = type === 'refactor' ? proofField('BEFORE', RED_SHA, '# fail 0') : proofField('RED', RED_SHA, 'not ok 1 - x');
  return `${lines.join('\n')}${first}\n${proofField('GREEN', head, '# fail 0')}`;
};

const body = (sha, score) =>
  `Summary text.\n<!-- greptile_comment -->\n<h2>Confidence Score: ${score}/5</h2>\n` +
  `<!-- greptile_confidence_score:${score} -->\n` +
  `<sub>Reviews (2) · Last reviewed commit: ["fix"](https://github.com/o/r/commit/${sha})</sub>\n` +
  `<!-- /greptile_comment -->`;

const run = (conclusion, status = 'completed', id = 2) => ({
  id, name: 'Greptile Review', app: { slug: 'greptile-apps' }, status, conclusion, output: { summary: 'Greptile has reviewed the Pull Request.' },
});

const GREPTILE_EDIT = { editor: { __typename: 'Bot', login: 'greptile-apps' } };

function input({ prBody = body(HEAD, 5), proofBody = proof(HEAD), runs = [run('success')], threads = [], statuses = [], bodyEdits = [GREPTILE_EDIT] } = {}) {
  return {
    pull: { number: 111, state: 'open', merged: false, mergeable_state: 'clean', body: `${prBody}${proofBody}`, head: { sha: HEAD, ref: 'feat/x' } },
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
  i.pull.body = body(head, 5) + proof(head);
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
  // PR D: an unrouted head gets "re-run the review-router workflow" instead (RC14); this test is about a routed head.
  const missing = evaluate(crInput(HEAD, [routerComment(HEAD)]));
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
  const r = evaluate(crInput(NEW_HEAD, [CR_SKIPPED_155, routerComment(NEW_HEAD)]));
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

test('router check: a saved hold after the head (held=apex_d3) still verifies the head', () => {
  const heldState = { ...routerComment(HEAD, { id: 3 }), body: `<!-- review-router -->\n<!-- review-router-state class=steering head=${HEAD} held=apex_d3 -->\nHeld.` };
  const r = evaluate(routed(['risk:steering', 'review:coderabbit', 'review:deep-held'], { input: NO_GREPTILE, router: false, eval: { reviews: [CR_REVIEW], comments: [heldState] } }));
  assert.equal(r.routing.unverified, undefined, 'the trailing held attribute must not hide the state');
  assert.deepEqual(r.routing.required, ['coderabbit']);
  assert.equal(r.ready, true, r.reasons.join('; '));
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

test('G-R9: the rate-limit notice gives coderabbitRateLimited and the minutes CodeRabbit names', () => {
  const notice = { id: 20, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.` };
  const r = evaluate({ ...crInput(HEAD, [notice]), nowMs: Date.parse(notice.updated_at) });
  assert.equal(r.coderabbitRateLimited, true);
  assert.equal(r.coderabbitRetryMinutes, 12);
});

test('G-R9: a notice with no figure gives null minutes; a skipped notice is not a rate limit', () => {
  const bare = { id: 21, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> [!WARNING]\n> ## Review limit reached` };
  const a = evaluate(crInput(HEAD, [bare]));
  assert.equal(a.coderabbitRateLimited, true);
  assert.equal(a.coderabbitRetryMinutes, null);
  const skipped = { id: 22, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> ## Review skipped\n> Please wait 12 minutes.` };
  const b = evaluate(crInput(HEAD, [skipped]));
  assert.equal(b.coderabbitLimited, true);
  assert.equal(b.coderabbitRateLimited, false);
  assert.equal(b.coderabbitRetryMinutes, null);
});

test('G-R10: a rate-limited status with no figure takes the minutes from a summary notice that applies to the head', () => {
  const notice = { id: 23, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.` };
  const statuses = { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited' }] } };
  const r = evaluate({ ...crInput(HEAD, [notice], [], statuses), nowMs: Date.parse(notice.updated_at) });
  assert.equal(r.coderabbitRateLimited, true);
  assert.equal(r.coderabbitRetryMinutes, 12);
  // A status that names its own figure keeps it.
  const own = { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited. Next included review available in 7 minutes' }] } };
  assert.equal(evaluate(crInput(HEAD, [notice], [], own)).coderabbitRetryMinutes, 7);
});

test('G-R11: the retry minutes count down from the time the notice or status was written (CodeRabbit #193)', () => {
  const at = Date.parse('2026-10-26T01:00:00Z');
  const notice = { id: 24, updated_at: '2026-10-26T01:00:00Z', user: CR_BOT, body: `${SUMMARY_MARKER}\n> [!WARNING]\n> ## Rate limit exceeded\n> Please wait 12 minutes.` };
  const ev = (statuses, nowMs) => evaluate({ ...crInput(HEAD, [notice], [], statuses), nowMs }).coderabbitRetryMinutes;
  const bare = { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited', updated_at: '2026-10-26T01:00:00Z' }] } };
  // Summary notice written 10 minutes ago: 2 minutes left.
  assert.equal(ev({}, at + 10 * 60_000), 2);
  assert.equal(ev(bare, at + 10 * 60_000), 2);
  // A status with its own figure, written 3 minutes ago: 4 of 7 left.
  const own = { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited. Next included review available in 7 minutes', updated_at: '2026-10-26T01:00:00Z' }] } };
  assert.equal(ev(own, at + 3 * 60_000), 4);
  // The wait has passed: no figure (null), so the alert states no wait; never 0 or a negative number.
  assert.equal(ev({}, at + 60 * 60_000), null);
  assert.equal(ev({}, at + 12 * 60_000), null);
  assert.equal(ev({}, at + 11 * 60_000), 1);
  // No date on the status: its own figure is kept as written.
  const undated = { combined: { statuses: [{ context: 'CodeRabbit', state: 'success', description: 'Review rate limited. Next included review available in 7 minutes' }] } };
  assert.equal(ev(undated, at + 3 * 60_000), 7);
});

test('G-R9: a PR that does not need CodeRabbit reports null for both fields', () => {
  const r = evaluate(input());
  assert.equal(r.coderabbitRateLimited, null);
  assert.equal(r.coderabbitRetryMinutes, null);
});

test('G-R9: codeRabbitRetryMinutes reads the wordings and folds hours and seconds', () => {
  assert.equal(RS.codeRabbitRetryMinutes('Next included review available in 12 minutes'), 12);
  assert.equal(RS.codeRabbitRetryMinutes('> Please wait 12 minutes.'), 12);
  assert.equal(RS.codeRabbitRetryMinutes('Please wait for 1 minute.'), 1);
  assert.equal(RS.codeRabbitRetryMinutes('available in 7 minutes and 30 seconds.'), 8);
  assert.equal(RS.codeRabbitRetryMinutes('available in 1 hour and 5 minutes'), 65);
  assert.equal(RS.codeRabbitRetryMinutes('available in 45 seconds'), 1);
  assert.equal(RS.codeRabbitRetryMinutes('Review limit reached'), null);
  assert.equal(RS.codeRabbitRetryMinutes('please wait a while'), null);
  assert.equal(RS.codeRabbitRetryMinutes(undefined), null);
  assert.equal(RS.codeRabbitRetryMinutes(null), null);
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

// ---------------------------------------------------------------------------------------------
// Greptile off (Dave, 2026-10-26): main's .greptile/config.json has autoReview []. Every path that
// required Greptile requires CodeRabbit instead. CI, threads and a failed manual Greptile run still block.
// Failure modes: an unrouted, stale, review:deep or person-raised PR still waits for Greptile forever;
// a PR with autoReview [] on its own branch lowers its bar; CI stops gating; a config read error is READY.
// ---------------------------------------------------------------------------------------------
const OFF = (labels, over = {}) => ({ ...routed(labels, { input: NO_GREPTILE, ...over }), greptileAuto: false });

test('greptileAutoFrom: only an empty autoReview list turns Greptile off', () => {
  assert.equal(greptileAutoFrom({ autoReview: [] }), false);
  assert.equal(greptileAutoFrom({ autoReview: ['open', 'push'] }), true);
  assert.equal(greptileAutoFrom({ autoReview: ['open'] }), true);
  assert.equal(greptileAutoFrom({}), true, 'no key: the dashboard default reviews');
  assert.equal(greptileAutoFrom(null), true, 'no file: the dashboard default reviews');
  assert.equal(greptileAutoFrom({ autoReview: 'never' }), true, 'junk keeps the stricter rule');
});

test('Greptile off: every path that needed Greptile needs CodeRabbit instead', () => {
  const cases = [
    ['no labels at all', [], { router: false }],
    ['risk label without review label', ['risk:normal'], {}],
    ['review:deep', ['risk:infra', 'review:deep'], {}],
    ['no router comment on a docs PR', ['risk:docs'], { router: false }],
    ['router saw an older head', ['risk:normal', 'review:coderabbit'], { router: OLD }],
    ['person risk label above the saved class', ['risk:r3', 'review:coderabbit'], {}],
  ];
  for (const [name, labels, over] of cases) {
    const waiting = evaluate(OFF(labels, over));
    assert.deepEqual(waiting.routing.required, ['coderabbit'], name);
    assert.equal(waiting.ready, false, `${name}: no CodeRabbit review yet`);
    assert.ok(!waiting.reasons.some((x) => /Greptile/.test(x)), `${name}: no Greptile reason: ${waiting.reasons.join('; ')}`);
    const done = evaluate(OFF(labels, { ...over, eval: { reviews: [CR_REVIEW] } }));
    assert.equal(done.ready, true, `${name}: ${done.reasons.join('; ')}`);
  }
});

test('Greptile off: a docs PR the router classified on this head needs no bot', () => {
  const r = evaluate(OFF(['risk:docs']));
  assert.deepEqual(r.routing.required, []);
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('Greptile off: CI and threads still gate, and a failed manual Greptile run still blocks', () => {
  const semgrep = { name: 'semgrep', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } };
  const ci = evaluate({ ...OFF(['review:coderabbit'], { eval: { reviews: [CR_REVIEW] } }), checkRuns: [semgrep] });
  assert.equal(ci.ready, false);
  assert.ok(ci.reasons.some((x) => /semgrep/.test(x)), ci.reasons.join('; '));
  const failed = evaluate({ ...OFF(['review:coderabbit'], { eval: { reviews: [CR_REVIEW] } }), checkRuns: [run('failure')] });
  assert.equal(failed.ready, false, 'a low or failed manual Greptile review is still a finding');
});

test('Greptile on (default input): the old rule is unchanged', () => {
  assert.deepEqual(evaluate(routed([], { router: false })).routing.required, ['greptile']);
  assert.deepEqual(evaluate(routed(['review:deep'])).routing.required, ['greptile', 'coderabbit']);
});

// ---------------------------------------------------------------------------------------------
// Dependabot (Dave, 2026-10-26): CodeRabbit refuses bot-authored PRs (no seat), so a Dependabot PR
// needs no bot review. CI, threads and mergeable still gate. Failure modes: a person's commit on a
// Dependabot branch rides the exemption; a User account named dependabot[bot] gets it; CI stops
// gating; an unknown commit list (no authors read) counts as all-Dependabot.
// ---------------------------------------------------------------------------------------------
const DEPENDABOT = { login: 'dependabot[bot]', type: 'Bot' };
const DEP = (over = {}) => {
  const base = OFF(['risk:infra', 'review:coderabbit', 'review:deep-held', 'dependencies']);
  return { ...base, pull: { ...base.pull, user: over.user ?? DEPENDABOT }, commits: over.commits ?? [DEP_COMMIT], ...(over.extra ?? {}) };
};
const DEP_COMMIT = { author: 'dependabot[bot]', githubSigned: true };

test('Dependabot: a PR opened and only committed by dependabot[bot] needs no bot review', () => {
  const r = evaluate(DEP());
  assert.deepEqual(r.routing.required, []);
  assert.equal(r.routing.source, 'dependabot');
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('Dependabot: a person commit, an unknown commit list, or a User account named dependabot[bot] gets no exemption', () => {
  for (const [name, over] of [
    ['person commit on the branch', { commits: [DEP_COMMIT, { author: 'Rev4nchist', githubSigned: true }] }],
    ['spoofed author, not signed by GitHub', { commits: [{ author: 'dependabot[bot]', githubSigned: false }] }],
    ['signature missing', { commits: [{ author: 'dependabot[bot]' }] }],
    ['no commits read', { commits: [] }],
    ['commit with no linked account', { commits: [{ author: null, githubSigned: true }] }],
    ['User account named dependabot[bot]', { user: { login: 'dependabot[bot]', type: 'User' } }],
    ['another bot', { user: { login: 'renovate[bot]', type: 'Bot' }, commits: [{ author: 'renovate[bot]', githubSigned: true }] }],
  ]) {
    const r = evaluate(DEP(over));
    assert.deepEqual(r.routing.required, ['coderabbit'], name);
    assert.equal(r.ready, false, name);
  }
});

test('Dependabot: CI and threads still gate', () => {
  const semgrep = { name: 'semgrep', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } };
  const ci = evaluate(DEP({ extra: { checkRuns: [semgrep] } }));
  assert.equal(ci.ready, false);
  assert.ok(ci.reasons.some((x) => /semgrep/.test(x)), ci.reasons.join('; '));
  const thread = evaluate(DEP({ extra: { threads: [{ isResolved: false }] } }));
  assert.equal(thread.ready, false);
});

// ---------------------------------------------------------------------------------------------
// P4b proof gate (DW-102): a PR body names one proof type and shows RED and GREEN evidence. READY
// reads it from the PR body only. Each test names the failure it guards; the mutation check
// (.claude/cache/p4b-tmp/mutate.mjs) breaks the code and confirms the matching test fails.
// ---------------------------------------------------------------------------------------------
const proofReasons = (r) => r.reasons.filter((x) => x.startsWith(RS.PROOF_REASON_PREFIX));
const check = (proofBody, over = {}) => evaluate(input({ proofBody, ...over }));
const GOOD = proof(HEAD);
const CMD = '`node --test x.test.mjs`';
const RED_F = proofField('RED', RED_SHA, 'not ok 1 - x');
const GREEN_F = proofField('GREEN', HEAD, '# fail 0');
const BEFORE_F = proofField('BEFORE', RED_SHA, '# fail 0');
const preamble = (type) => `\n\nProof type: ${type}\n\n`;
const readyOrWhy = (r) => r.reasons.join('; ');

test('proof: a body with no proof is NOT READY; the default fixture is READY only through its Evidence block', () => {
  assert.equal(evaluate(input()).ready, true);
  const r = check('');
  assert.equal(r.ready, false);
  assert.equal(r.proof.status, 'missing');
  assert.ok(proofReasons(r).some((x) => /"Proof type:" line/.test(x)), readyOrWhy(r));
});

test('proof: a block left inside an HTML comment does not count; a comment before a real block does not hide it', () => {
  const hidden = {
    'one-line comment': '\n\n<!-- Proof type: bugfix -->\n',
    'multi-line comment around a whole block': `\n\n<!--\n${GOOD}\n-->\n`,
    'comment opened mid-line': '\n\ntext <!-- start\nProof type: bugfix\n-->\n',
  };
  for (const [name, p] of Object.entries(hidden)) {
    const r = check(p);
    assert.equal(r.proof.status, 'missing', name);
    assert.equal(r.ready, false, name);
  }
  const visible = check(`\n<!-- note -->\n<!-- another\nnote -->${GOOD}`);
  assert.equal(visible.ready, true, readyOrWhy(visible));
});

test('proof: a block inside the Greptile or CodeRabbit body block does not count; one after the block does', () => {
  const greptile = (inner) => `\n<!-- greptile_comment -->\n${inner}\n<!-- /greptile_comment -->\n`;
  const rabbit = (inner) => `\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n${inner}\n<!-- end of auto-generated comment: summarize by coderabbit.ai -->\n`;
  for (const [name, wrap] of [['greptile', greptile], ['coderabbit', rabbit]]) {
    const hidden = check(wrap(GOOD));
    assert.equal(hidden.proof.status, 'missing', name);
    assert.equal(hidden.ready, false, name);
    const after = check(`${wrap('Summary text.')}${GOOD}`);
    assert.equal(after.ready, true, `${name}: ${readyOrWhy(after)}`);
  }
});

test('proof: field lines inside a code fence are not fields (4-backtick and ~~~ fences too)', () => {
  const fencedBlocks = { 'four backticks around three': `\n\n\`\`\`\`markdown\n${GOOD}\n\`\`\`\`\n`, 'tilde fence': `\n\n~~~\n${GOOD}\n~~~\n` };
  for (const [name, p] of Object.entries(fencedBlocks)) {
    assert.equal(check(p).proof.status, 'missing', name);
  }
  const trick = `${preamble('bugfix')}RED: ${CMD} @ ${RED_SHA}\n\`\`\`text\nnot ok 1\nGREEN: ${CMD} @ ${HEAD}\n\`\`\`\n`;
  const r = check(trick);
  assert.equal(r.ready, false);
  assert.ok(proofReasons(r).some((x) => /needs a GREEN line/.test(x)), `a GREEN line inside the RED output is not a GREEN field: ${readyOrWhy(r)}`);
});

test('proof: "<!--" inside fenced output does not hide the GREEN line', () => {
  const p = `${preamble('bugfix')}${proofField('RED', RED_SHA, 'not ok 1\n<div><!-- never closed')}\n${GREEN_F}`;
  const r = check(p);
  assert.equal(r.ready, true, readyOrWhy(r));
});

test('proof: an unknown type is rejected, and the reason lists the six types', () => {
  const r = check(GOOD.replace('Proof type: bugfix', 'Proof type: tests'));
  assert.equal(r.ready, false);
  assert.equal(r.proof.status, 'invalid');
  const why = proofReasons(r).find((x) => /unknown proof type "tests"/.test(x));
  assert.ok(why, readyOrWhy(r));
  for (const t of ['bugfix', 'feature', 'refactor', 'ui', 'harness', 'docs']) assert.ok(why.includes(t), `${t} listed`);
});

test('proof: two Proof type lines are NOT READY', () => {
  const r = check(`${GOOD}\nProof type: feature\n`);
  assert.equal(r.ready, false);
  assert.ok(proofReasons(r).some((x) => /2 "Proof type:" lines/.test(x)), readyOrWhy(r));
});

test('proof: the type line must hold one clean type (no list, no extra words); a parenthetical is fine', () => {
  for (const v of ['bugfix, feature', 'bugfix | feature', 'bugfix feature', 'bugfix and feature']) {
    const r = check(GOOD.replace('Proof type: bugfix', `Proof type: ${v}`));
    assert.equal(r.ready, false, v);
    assert.ok(proofReasons(r).some((x) => /Name one type/.test(x)), `${v}: ${readyOrWhy(r)}`);
  }
  const note = check(GOOD.replace('Proof type: bugfix', 'Proof type: bugfix (fixes #12)'));
  assert.equal(note.ready, true, readyOrWhy(note));
});

test('proof: the template placeholder and an empty type value have no type', () => {
  for (const v of ['<bugfix | feature | refactor | ui | harness | docs>', '']) {
    const r = check(GOOD.replace('Proof type: bugfix', `Proof type: ${v}`));
    assert.equal(r.ready, false, `"${v}"`);
    assert.ok(proofReasons(r).some((x) => /has no type/.test(x)), `"${v}": ${readyOrWhy(r)}`);
  }
});

test('proof: bugfix, feature, ui and harness each need a RED line', () => {
  for (const type of ['bugfix', 'feature', 'ui', 'harness']) {
    const r = check(preamble(type) + GREEN_F);
    assert.equal(r.ready, false, type);
    assert.ok(proofReasons(r).some((x) => /needs a RED line/.test(x)), `${type}: ${readyOrWhy(r)}`);
    assert.equal(check(preamble(type) + RED_F + GREEN_F).ready, true, `${type} with RED and GREEN`);
  }
});

test('proof: a missing GREEN line is NOT READY', () => {
  const r = check(preamble('bugfix') + RED_F);
  assert.equal(r.ready, false);
  assert.ok(proofReasons(r).some((x) => /needs a GREEN line/.test(x)), readyOrWhy(r));
});

test('proof: a refactor needs BEFORE and GREEN; RED does not stand in for BEFORE', () => {
  const noBefore = check(preamble('refactor') + RED_F + GREEN_F);
  assert.equal(noBefore.ready, false);
  assert.ok(proofReasons(noBefore).some((x) => /needs a BEFORE line/.test(x)), readyOrWhy(noBefore));
  const ok = check(preamble('refactor') + BEFORE_F + GREEN_F);
  assert.equal(ok.ready, true, readyOrWhy(ok));
});

test('proof: the Pocock "**Before:**" line is not a BEFORE field (keys are upper case)', () => {
  const r = check(preamble('refactor') + BEFORE_F.replace('BEFORE:', '- **Before:**') + GREEN_F);
  assert.equal(r.ready, false);
  assert.ok(proofReasons(r).some((x) => /needs a BEFORE line/.test(x)), readyOrWhy(r));
});

test('proof: a field needs a command in backticks, and a placeholder command is no command', () => {
  const none = check(preamble('bugfix') + RED_F.replace(CMD, '') + GREEN_F);
  assert.equal(none.ready, false);
  assert.ok(proofReasons(none).some((x) => /RED line has no command in backticks/.test(x)), readyOrWhy(none));
  const holder = check(preamble('bugfix') + RED_F.replace(CMD, '`<command>`') + GREEN_F);
  assert.equal(holder.ready, false);
  assert.ok(proofReasons(holder).some((x) => /RED line has a placeholder command/.test(x)), readyOrWhy(holder));
});

test('proof: a field needs a commit of 7 to 40 hex characters; case does not matter', () => {
  for (const [name, sha] of [['none', ''], ['6 characters', 'cccccc'], ['not hex', 'zzzzzzz'], ['placeholder', '<red-sha>']]) {
    const r = check(preamble('bugfix') + RED_F.replace(`@ ${RED_SHA}`, sha === '' ? '' : `@ ${sha}`) + GREEN_F);
    assert.equal(r.ready, false, name);
    assert.ok(proofReasons(r).some((x) => /RED line names no commit/.test(x)), `${name}: ${readyOrWhy(r)}`);
  }
  const short = check(preamble('bugfix') + RED_F + proofField('GREEN', HEAD.slice(0, 7), '# fail 0'));
  assert.equal(short.ready, true, `a 7-character prefix of the head: ${readyOrWhy(short)}`);
  const upper = check(preamble('bugfix') + RED_F + proofField('GREEN', 'A'.repeat(7), '# fail 0'));
  assert.equal(upper.ready, true, `an upper-case prefix of the head: ${readyOrWhy(upper)}`);
});

test('proof: a field needs a fenced output block that is not empty', () => {
  const none = check(`${preamble('bugfix')}RED: ${CMD} @ ${RED_SHA}\n\nsome prose, no fence\n\n${GREEN_F}`);
  assert.equal(none.ready, false);
  assert.ok(proofReasons(none).some((x) => /RED line has no fenced output block/.test(x)), readyOrWhy(none));
  const empty = check(preamble('bugfix') + proofField('RED', RED_SHA, '  ') + GREEN_F);
  assert.equal(empty.ready, false);
  assert.ok(proofReasons(empty).some((x) => /RED output block is empty/.test(x)), readyOrWhy(empty));
  const gap = check(preamble('bugfix') + RED_F.replace('\n```text', '\n\n\n```text') + GREEN_F);
  assert.equal(gap.ready, true, `blank lines before the fence are fine: ${readyOrWhy(gap)}`);
});

test('proof: GREEN must name the head; a GREEN from an older commit is stale after a push', () => {
  const r = check(preamble('bugfix') + RED_F + proofField('GREEN', OLD, '# fail 0'));
  assert.equal(r.ready, false);
  assert.ok(proofReasons(r).some((x) => /bbbbbbb/.test(x) && /aaaaaaa/.test(x) && /not the head/.test(x)), readyOrWhy(r));
});

test('proof: a duplicate RED or GREEN line is NOT READY, not "first wins" or "last wins"', () => {
  const twoGreen = check(preamble('bugfix') + RED_F + proofField('GREEN', OLD, '# fail 0') + GREEN_F);
  assert.equal(twoGreen.ready, false);
  assert.ok(proofReasons(twoGreen).some((x) => /2 GREEN lines/.test(x)), readyOrWhy(twoGreen));
  const twoRed = check(preamble('bugfix') + RED_F + RED_F + GREEN_F);
  assert.ok(proofReasons(twoRed).some((x) => /2 RED lines/.test(x)), readyOrWhy(twoRed));
});

test('proof: a body with CRLF line endings parses (GitHub web edits save CRLF)', () => {
  const r = check(GOOD.replace(/\n/g, '\r\n'));
  assert.equal(r.ready, true, readyOrWhy(r));
});

test('proof: Markdown forms of the keys parse', () => {
  const forms = {
    'bold key, colon inside': GOOD.replace('Proof type: bugfix', '**Proof type:** `bugfix`').replace('RED:', '**RED:**').replace('GREEN:', '**GREEN:**'),
    'bold key, colon outside': GOOD.replace('Proof type: bugfix', '**Proof type**: bugfix').replace('RED:', '**RED**:').replace('GREEN:', '**GREEN**:'),
    'list items': GOOD.replace('Proof type:', '- Proof type:').replace('RED:', '- RED:').replace('GREEN:', '* GREEN:'),
    'mixed-case Proof type': GOOD.replace('Proof type: bugfix', 'proof TYPE: BugFix'),
    'at in place of @': GOOD.replaceAll(' @ ', ' at '),
  };
  for (const [name, p] of Object.entries(forms)) {
    const r = check(p);
    assert.equal(r.ready, true, `${name}: ${readyOrWhy(r)}`);
  }
});

// docs: the author must still write "Proof type: docs", and the review router must have classed THIS head docs.
const docsRouter = (sha, cls = 'docs') => ({ ...routerComment(sha), body: routerComment(sha).body.replace('class=infra', `class=${cls}`) });
const docsPr = (over = {}) => {
  const { labels = ['risk:docs'], router = docsRouter(HEAD), body: proofBody = proof(HEAD, 'docs') } = over;
  return routed(labels, { input: { ...NO_GREPTILE, proofBody }, router: false, eval: { comments: router ? [router] : [] } });
};

test('proof: "Proof type: docs" needs no RED or GREEN when the router classed this head docs and every risk label is risk:docs', () => {
  const r = evaluate(docsPr());
  assert.equal(r.ready, true, readyOrWhy(r));
  assert.equal(r.proof.status, 'ok');
  assert.equal(r.proof.type, 'docs');
});

test('proof: a docs claim fails when any docs condition is missing', () => {
  const cases = {
    'router class is not docs': { router: docsRouter(HEAD, 'infra') },
    'router saw an older head': { router: docsRouter(OLD) },
    'a higher risk label is on the PR': { labels: ['risk:docs', 'risk:normal'] },
    'no risk label at all': { labels: [] },
    'no router comment': { router: null },
  };
  for (const [name, over] of Object.entries(cases)) {
    const r = evaluate(docsPr(over));
    assert.equal(r.ready, false, name);
    assert.ok(proofReasons(r).some((x) => /docs/.test(x) && /router/.test(x)), `${name}: ${readyOrWhy(r)}`);
  }
  const noLine = evaluate(docsPr({ body: '' }));
  assert.equal(noLine.proof.status, 'missing', 'docs still needs the Proof type line');
});

// Dependabot: DEP() goes through input(), so its body carries the default Evidence block. Strip it.
const depNoProof = (over = {}) => {
  const r = DEP(over);
  r.pull.body = body(HEAD, 5);
  return r;
};

test('proof: a Dependabot PR (signed, all commits by the bot) is exempt', () => {
  const r = evaluate(depNoProof());
  assert.equal(r.ready, true, readyOrWhy(r));
  assert.equal(r.proof.status, 'exempt');
  assert.equal(r.proof.required, false);
});

test('proof: no exemption for a person commit, an unsigned commit, a User account or another bot', () => {
  for (const [name, over] of [
    ['person commit on the branch', { commits: [DEP_COMMIT, { author: 'Rev4nchist', githubSigned: true }] }],
    ['unsigned commit', { commits: [{ author: 'dependabot[bot]', githubSigned: false }] }],
    ['User account named dependabot[bot]', { user: { login: 'dependabot[bot]', type: 'User' } }],
    ['another bot', { user: { login: 'renovate[bot]', type: 'Bot' }, commits: [{ author: 'renovate[bot]', githubSigned: true }] }],
  ]) {
    const r = evaluate(depNoProof(over));
    assert.equal(r.proof.status, 'missing', name);
    assert.ok(proofReasons(r).length > 0, name);
    assert.equal(r.ready, false, name);
  }
});

test('proof: proofGate false (a repo other than CCv3) skips the check', () => {
  const r = evaluate({ ...input({ proofBody: '' }), proofGate: false });
  assert.equal(r.ready, true, readyOrWhy(r));
  assert.equal(r.proof.status, 'off');
  assert.equal(proofReasons(r).length, 0);
});

test('proof: the Evidence template in pr-and-commit-style.md parses once filled, and fails while its placeholders remain', () => {
  const doc = readFileSync(new URL('../../.claude/rules-ondemand/pr-and-commit-style.md', import.meta.url), 'utf8').split(/\r?\n/);
  const start = doc.findIndex((l) => l.trim() === '~~~markdown');
  assert.ok(start >= 0, 'the "~~~markdown" template opener exists');
  const end = doc.indexOf('~~~', start + 1);
  assert.ok(end > start, 'the template closer exists');
  const template = doc.slice(start + 1, end).join('\n');
  const raw = check(`\n\n${template}\n`);
  assert.equal(raw.ready, false, 'a pasted template with its placeholders is not proof');
  const filled = template
    .replace(/Proof type: <[^>]*>/, 'Proof type: bugfix')
    .replaceAll('<command>', 'node --test x.test.mjs')
    .replace('<red-sha>', RED_SHA)
    .replace('<head-sha>', HEAD)
    .replace(/<failing output[^>]*>/, 'not ok 1 - x')
    .replace(/<passing output[^>]*>/, '# fail 0');
  const r = check(`\n\n${filled}\n`);
  assert.equal(r.ready, true, readyOrWhy(r));
  // Type, commands and SHAs filled; both output placeholders left in their fences.
  const keptOutputs = template
    .replace(/Proof type: <[^>]*>/, 'Proof type: bugfix')
    .replaceAll('<command>', 'node --test x.test.mjs')
    .replace('<red-sha>', RED_SHA)
    .replace('<head-sha>', HEAD);
  const kept = check(`\n\n${keptOutputs}\n`);
  assert.equal(kept.ready, false, 'an output placeholder left in its fence is not proof');
  const reasons = proofReasons(kept);
  assert.ok(reasons.some((x) => /RED output block is a placeholder/.test(x)), reasons.join(' | '));
  assert.ok(reasons.some((x) => /GREEN output block is a placeholder/.test(x)), reasons.join(' | '));
});

test('proof: every proof reason starts with the prefix and matches none of the pr-loop mod reason patterns', () => {
  // Copies of the patterns in .claude/plugins/ccv3-mods/hooks/pr-loop/model.ts (PER_PR_ERROR line 82,
  // FAILED_CHECK 110, GREPTILE_FAILED 129, CANCELLED_REVIEW 250). Update them when the mod changes.
  const modPatterns = [
    /HTTP 404|Not Found \(HTTP|Could not resolve to|more than \d+ /i,
    /^status ".*" is (failure|error)$|^check ".*" is completed\//,
    /^Greptile check ended failure/,
    /was cancelled \(superseded by a push\)/,
  ];
  const bad = [
    '', GOOD.replace('Proof type: bugfix', 'Proof type: tests'), `${GOOD}\nProof type: feature\n`, preamble('bugfix') + GREEN_F,
    preamble('bugfix') + RED_F, preamble('bugfix') + RED_F.replace(CMD, '') + GREEN_F, preamble('bugfix') + RED_F + proofField('GREEN', OLD, 'x'),
    preamble('bugfix') + RED_F + GREEN_F + GREEN_F, preamble('docs'), GOOD.replace('Proof type: bugfix', 'Proof type: bugfix, feature'),
  ];
  for (const p of bad) {
    const reasons = proofReasons(check(p));
    assert.ok(reasons.length > 0, 'a bad body gives a proof reason');
    for (const reason of reasons) for (const re of modPatterns) assert.equal(re.test(reason), false, `${re}: ${reason}`);
  }
});

test('proof: a null PR body is "missing", never a throw', () => {
  assert.deepEqual(RS.parseProof(null).types, []);
  assert.deepEqual(RS.parseProof(undefined).types, []);
  const i = input();
  i.pull.body = null;
  const r = evaluate(i);
  assert.equal(r.proof.status, 'missing');
  assert.equal(r.ready, false);
});

// ---------------------------------------------------------------------------------------------
// PR2: CodeRabbit "Outside diff range comments (N)". The findings sit in the REVIEW BODY and make no
// review thread, so `unresolved` stays 0. READY reads only the count N from the newest CodeRabbit
// review of the head. Heading shape copied from the live bodies of PR #193 (reviews on 8491cd23 and 41f3dbe4).
// Failure modes:
//  F1 N > 0 on the head review does not block READY (the #193 miss)
//  F2 a review of an older commit counts against the new head
//  F3 a body with no heading (or only "Outside diff comments:" prompt text, or a number in finding text) reads as N > 0
//  F4 an older head review wins over the newest one (either direction)
//  F5 a review by a person, or by a User account named like the bot, counts
//  F6 the count is read only when the labels require CodeRabbit (an unlabelled PR slips)
//  F7 the "Outside-diff: handled" list is not honoured, or fewer than N entries are honoured
//  F8 the list counts what is not an entry: empty bullets, a fenced or commented example, bullets of another section
//  F9 the count is missing from the JSON the pr_watch mod reads
// ---------------------------------------------------------------------------------------------
const OD_HEADING = (n) => [
  '> [!CAUTION]',
  '> Some comments are outside the diff and can’t be posted inline due to GitHub limitations.',
  '> ',
  `> **⚠️ Outside diff range comments (${n})**`,
  '> ',
  '> <details>',
  '> <summary><strong>Major</strong> · Deny PR creates without a verifiable body · <code>pre-pr-gate.ts:201-204</code></summary><blockquote>',
].join('\n');
const odReview = (commit, n, at, over = {}) => ({
  user: CR_BOT,
  commit_id: commit,
  submitted_at: at,
  body: `<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 1**\n\n${n === null ? '' : OD_HEADING(n)}\n\n---\n\nReview info\n`,
  ...over,
});
const T1 = '2026-10-28T10:00:00Z';
const T2 = '2026-10-28T11:00:00Z';
const odEval = (reviews, proofExtra = '') => evaluate({ ...input({ proofBody: `${proof(HEAD)}${proofExtra}` }), reviews, comments: [] });
const HANDLED = (n, heading = '## Outside-diff: handled') => `\n\n${heading}\n\n${Array.from({ length: n }, (_, i) => `- finding ${i + 1}: fixed in abc123${i}`).join('\n')}\n`;
const odFn = (name) => {
  assert.equal(typeof RS[name], 'function', `review-status.mjs must export ${name}`);
  return RS[name];
};

test('outside-diff F1: N > 0 on the head review is NOT READY, and the reason names N and the head', () => {
  const r = odEval([odReview(HEAD, 3, T1)]);
  assert.equal(r.unresolved, 0, 'no review thread exists for these findings');
  assert.equal(r.ready, false, 'READY must fail closed while the head review lists outside-diff findings');
  const why = r.reasons.find((x) => /outside.diff/i.test(x));
  assert.ok(why, r.reasons.join('; '));
  assert.match(why, /\b3\b/);
  assert.ok(why.includes(HEAD.slice(0, 7)), `reason names the head: ${why}`);
});

test('outside-diff F6: the count blocks an unlabelled (Greptile-only) PR as well', () => {
  const r = odEval([odReview(HEAD, 1, T1)]);
  assert.equal(r.coderabbit, null, 'the fixture PR does not require CodeRabbit');
  assert.equal(r.ready, false);
});

test('outside-diff F6: the count blocks a review:coderabbit PR too', () => {
  const i = routed(['review:coderabbit'], { input: NO_GREPTILE, eval: { reviews: [odReview(HEAD, 2, T2)] } });
  const r = evaluate(i);
  assert.equal(r.coderabbitOutsideDiff, 2);
  assert.equal(r.ready, false, r.reasons.join('; '));
});

test('outside-diff F2: findings on an older commit still count after a push (a push must not clear them)', () => {
  // A review of a new head covers only the new commits, so it never repeats the old outside-diff findings.
  const r = odEval([odReview(OLD, 4, T1)]);
  assert.equal(r.coderabbitOutsideDiff, 4);
  assert.equal(r.ready, false, 'unread findings on an older commit keep READY failing');
  assert.equal(odEval([odReview(OLD, 4, T1)], HANDLED(4)).ready, true, 'a handled list that covers them clears it');
});

test('outside-diff F3: no heading means N = 0 and the field is still present', () => {
  const r = odEval([odReview(HEAD, null, T1)]);
  assert.equal(r.coderabbitOutsideDiff, 0);
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(odEval([]).coderabbitOutsideDiff, 0, 'no review at all');
});

test('outside-diff F3: the details/summary heading shape is read too', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const shapes = [
    '<details>\n<summary>⚠️ Outside diff range comments (2)</summary><blockquote>\n\nfinding\n</blockquote></details>',
    '> <summary>⚠️ Outside diff range comments (2)</summary><blockquote>',
    '<details><summary>Outside diff range comments (2)</summary>',
  ];
  for (const shape of shapes) {
    const review = odReview(HEAD, null, T1, { body: `**Actionable comments posted: 1**\n\n${shape}\n` });
    assert.equal(count({ head: HEAD, reviews: [review] }), 2, shape);
  }
});

test('outside-diff F3: only the heading count is read, not finding text or the prompt block', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const texts = {
    'prompt block, no count': 'Outside diff comments:\nReview comments at @a.ts:\n- Around line 191-206: fix it (5 places).',
    'finding text with a number in brackets': '**Check the checkout (2) before accepting `--repo`.**\nThere are comments (7) outside the diff.',
    'a different heading': '**Nitpick comments (4)**',
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.equal(count({ head: HEAD, reviews: [odReview(HEAD, null, T1, { body: `Actionable comments posted: 1\n${text}` })] }), 0, name);
  }
});

test('outside-diff F3: the heading is read in the live shape and its plain variants', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const bodies = {
    'live blockquote with bold and emoji': [OD_HEADING(1), 1],
    'two digits': [OD_HEADING(12), 12],
    'plain line': ['Outside diff range comments (2)', 2],
    'bold, no emoji, mixed case': ['**Outside Diff Range Comments (5)**', 5],
    'CRLF line endings': [OD_HEADING(3).replace(/\n/g, '\r\n'), 3],
  };
  for (const [name, [text, n]] of Object.entries(bodies)) {
    assert.equal(count({ head: HEAD, reviews: [odReview(HEAD, null, T1, { body: `**Actionable comments posted: 1**\n\n${text}\n` })] }), n, name);
  }
});

test('outside-diff F4: the count is the sum over every CodeRabbit review, whatever the array order', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const newerClean = [odReview(HEAD, 3, T1), odReview(HEAD, null, T2)];
  const newerDirty = [odReview(HEAD, null, T1), odReview(HEAD, 2, T2)];
  const both = [odReview(OLD, 3, T1), odReview(HEAD, 2, T2)];
  for (const [name, reviews, n] of [['a newer clean review does not clear earlier findings', newerClean, 3], ['newer review has findings', newerDirty, 2], ['old and new commits add up', both, 5]]) {
    assert.equal(count({ head: HEAD, reviews }), n, `${name}, API order`);
    assert.equal(count({ head: HEAD, reviews: [...reviews].reverse() }), n, `${name}, reversed order`);
  }
});

test('outside-diff F4: a newer CodeRabbit review of the head with no review sentence (a thread reply) does not reset N', () => {
  // GitHub can record a reply to a review comment as an extra COMMENTED review with an empty body.
  // Only reviews that carry the "Actionable comments posted: N" sentence are real PR-bot reviews (see L282).
  const count = odFn('codeRabbitOutsideDiff');
  const reply = (body) => odReview(HEAD, null, T2, { body });
  for (const [name, body] of [['empty body', ''], ['null body', null], ['short text without the sentence', 'Thanks, noted.']]) {
    const reviews = [odReview(HEAD, 3, T1), reply(body)];
    assert.equal(count({ head: HEAD, reviews }), 3, `${name}, API order`);
    assert.equal(count({ head: HEAD, reviews: [...reviews].reverse() }), 3, `${name}, reversed order`);
  }
  const r = odEval([odReview(HEAD, 3, T1), reply('')]);
  assert.equal(r.ready, false, 'an empty reply review must not make the head READY');
});

test('outside-diff F4: a newer review of an OLDER commit does not hide the findings on the head', () => {
  const r = odEval([odReview(HEAD, 2, T1), odReview(OLD, null, T2)]);
  assert.equal(r.coderabbitOutsideDiff, 2);
  assert.equal(r.ready, false);
});

test('outside-diff F4b: the same review listed twice by the API is counted once', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const review = { ...odReview(OLD, 3, T1), id: 9001 };
  assert.equal(count({ head: HEAD, reviews: [review, { ...review }] }), 3);
});

test('outside-diff F5: only the CodeRabbit app counts', () => {
  const count = odFn('codeRabbitOutsideDiff');
  const person = odReview(HEAD, 3, T1, { user: { login: 'someone', type: 'User' } });
  const lookalike = odReview(HEAD, 3, T1, { user: { login: 'coderabbitai[bot]', type: 'User' } });
  assert.equal(count({ head: HEAD, reviews: [person] }), 0);
  assert.equal(count({ head: HEAD, reviews: [lookalike] }), 0);
});

test('outside-diff F7: an "Outside-diff: handled" list with N entries makes it READY again', () => {
  const r = odEval([odReview(HEAD, 3, T1)], HANDLED(3));
  assert.equal(r.coderabbitOutsideDiff, 3, 'the count stays visible when handled');
  assert.equal(r.ready, true, r.reasons.join('; '));
});

test('outside-diff F7: more entries than N is fine; fewer than N keeps READY failing and the reason shows both numbers', () => {
  assert.equal(odEval([odReview(HEAD, 2, T1)], HANDLED(4)).ready, true);
  const r = odEval([odReview(HEAD, 3, T1)], HANDLED(2));
  assert.equal(r.ready, false);
  const why = r.reasons.find((x) => /outside.diff/i.test(x));
  assert.ok(why, r.reasons.join('; '));
  assert.match(why, /\b3\b/);
  assert.match(why, /\b2\b/);
});

test('outside-diff F7: a list written for an earlier, smaller N does not cover a new head review with more', () => {
  const r = odEval([odReview(OLD, 2, T1), odReview(HEAD, 4, T2)], HANDLED(2));
  assert.equal(r.ready, false);
});

test('outside-diff F7: a handled list with no review findings changes nothing', () => {
  const r = odEval([odReview(HEAD, null, T1)], HANDLED(2));
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.reasons.some((x) => /outside.diff/i.test(x)), false);
});

test('outside-diff F7/F8: outsideDiffHandled counts the bullet entries under the heading', () => {
  const handled = odFn('outsideDiffHandled');
  const entries = '- one: fixed in abc1234\n* two: dismissed, not a bug\n- three';
  const cases = {
    'h2 heading': [`## Outside-diff: handled\n${entries}`, 3],
    'plain heading line': [`Outside-diff: handled\n${entries}`, 3],
    'bold heading': [`**Outside-diff: handled**\n${entries}`, 3],
    'lower case': [`outside-diff: handled\n${entries}`, 3],
    'blank line after the heading': [`## Outside-diff: handled\n\n${entries}`, 3],
    'CRLF': [`## Outside-diff: handled\r\n${entries.replace(/\n/g, '\r\n')}\r\n`, 3],
    'text before and after the section': [`Intro.\n\n## Outside-diff: handled\n${entries}\n\n## Next section\n- not mine\n`, 3],
    'no section': ['## Summary\n- a\n- b\n', 0],
    'null body': [null, 0],
  };
  for (const [name, [text, n]] of Object.entries(cases)) assert.equal(handled(text), n, name);
});

test('outside-diff F8: empty bullets, a fenced or commented example and bullets under another heading are not entries', () => {
  const handled = odFn('outsideDiffHandled');
  const cases = {
    'empty bullets': '## Outside-diff: handled\n-\n- \n*\n',
    'placeholder only': '## Outside-diff: handled\n- <finding and what you did>\n',
    'inside a code fence': '```md\n## Outside-diff: handled\n- one\n- two\n```\n',
    'inside an HTML comment': '<!--\n## Outside-diff: handled\n- one\n- two\n-->\n',
    'bullets above the heading': '- one\n- two\n## Outside-diff: handled\n',
    'bullets under the next heading': '## Outside-diff: handled\n## Evidence\n- one\n- two\n',
    'prose line ends the list': '## Outside-diff: handled\nNone yet.\n- one\n- two\n',
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(handled(text), 0, name);
});

test('outside-diff F8: indented detail lines under one entry are not extra entries', () => {
  const handled = odFn('outsideDiffHandled');
  assert.equal(handled('## Outside-diff: handled\n- one\n  - why\n  - how\n'), 1, 'two-space sub-bullets');
  assert.equal(handled('## Outside-diff: handled\n- one\n\t- why\n    - how\n'), 1, 'tab and four-space sub-bullets');
  assert.equal(handled('## Outside-diff: handled\n- one\n  - why\n- two\n  - why\n'), 2, 'each top-level entry counts once');
  const r = odEval([odReview(HEAD, 3, T1)], '\n\n## Outside-diff: handled\n- one\n  - why\n  - how\n');
  assert.equal(r.ready, false, 'one entry with sub-bullets must not cover N = 3');
});

test('outside-diff F8: blank lines between top-level bullets keep the list going', () => {
  const handled = odFn('outsideDiffHandled');
  assert.equal(handled('## Outside-diff: handled\n\n- one\n\n- two\n\n- three\n'), 3);
});

test('outside-diff F9: the JSON result carries the count as a number, 0 included', () => {
  for (const [reviews, n] of [[[], 0], [[odReview(HEAD, 5, T1)], 5]]) {
    const r = odEval(reviews);
    assert.equal(typeof r.coderabbitOutsideDiff, 'number');
    assert.equal(r.coderabbitOutsideDiff, n);
  }
});

// ---------------------------------------------------------------------------------------------
// PR checkpoint (PR A, spec sections 3.4 and 6): review:none, the raise reason, G1 and the state attributes.
//
// New contract, written before the code:
//   routerState(comments) -> { class, head, pathway, pclass } | null    pathway/pclass null when absent or not on the list
//   requiredBots(['review:none'], auto) -> { greptile: false, coderabbit: false }   after the deep and coderabbit checks
//   evaluate: review:none with no router state on the head -> no bot, NOT READY, reason
//     "the router has not classified this head; re-run the router workflow"
//   evaluate: state pathway=none and class above pclass -> NOT READY, reason "class raised after the checkpoint"
//   evaluate: state pathway=both keeps Greptile required while greptileAuto is false (G1)
//
// How it can fail, and the test that catches it:
//   review:none still asks for Greptile (the old default) or CodeRabbit               -> RN1, RN2
//   a stricter label next to review:none is overridden                                 -> RN1b (passes before the change)
//   review:none with no state on the head is READY (or falls to CodeRabbit)            -> RN3
//   the raise after the checkpoint is READY                                            -> RN4
//   the raise reason fires on a pathway that is not none                              -> RN4
//   G1 drops Greptile on a both PR when auto is off, or forces it when no state says both -> RN5
//   G1 is skipped when the pathway=both state is for an older head (a stale state never relaxes) -> RN5
//   RN2, RN3, RN4 hold only with Greptile auto on: with auto off, keep() asks for CodeRabbit -> loops over greptileAuto
//   a person risk label above the saved class on a review:none PR asks for a bot (keep())   -> RN8
//   a forged pathway= in a person comment steers READY                                 -> RN6
//   routerState does not return the attributes, or accepts junk                        -> RN7
const stateComment = (sha, attrs, { id = 900, user = { login: 'github-actions[bot]', type: 'Bot' } } = {}) => ({
  id, user, body: `<!-- review-router -->\n<!-- review-router-state ${attrs.replace('HEAD', sha)} -->\nNo open router notes.`,
});
const noRouter = (labels, comments, over = {}) => routed(labels, { router: false, input: NO_GREPTILE, ...over, eval: { ...over.eval, comments } });
const NONE_STATE = (sha = HEAD) => stateComment(sha, 'class=normal head=HEAD pathway=none pclass=normal');

test('RN1: review:none needs no bot, with Greptile auto on or off', () => {
  for (const auto of [true, false]) {
    const r = requiredBots(['review:none'], auto);
    assert.equal(r.greptile, false, `auto ${auto}`);
    assert.equal(r.coderabbit, false, `auto ${auto}`);
    assert.equal(r.source, 'labels');
  }
  const risk = requiredBots(['review:none', 'risk:normal'], true);
  assert.deepEqual([risk.greptile, risk.coderabbit], [false, false], 'a risk label next to review:none keeps no bot');
});

test('RN1b: a stricter review label next to review:none wins (passes before the change)', () => {
  const only = (r) => [r.greptile, r.coderabbit];
  assert.deepEqual(only(requiredBots(['review:none', 'review:deep'])), [true, true]);
  assert.deepEqual(only(requiredBots(['review:none', 'review:coderabbit'])), [false, true]);
  assert.deepEqual(only(requiredBots(['review:none', 'review:deep-held'])), [false, true]);
});

const AUTO = (auto) => ({ eval: { greptileAuto: auto } });

test('RN2: a review:none PR with the router state on the head is READY with no bot review, with Greptile auto on or off', () => {
  for (const auto of [true, false]) {
    const r = evaluate(noRouter(['review:none', 'risk:normal'], [NONE_STATE()], AUTO(auto)));
    assert.equal(r.ready, true, `auto ${auto}: ${r.reasons.join('; ')}`);
    assert.deepEqual(r.routing.required, [], `auto ${auto}`);
    assert.equal(r.routing.unverified, undefined, `auto ${auto}`);
    assert.equal(r.coderabbit, null, `auto ${auto}: no CodeRabbit review is asked for`);
  }
});

test('RN3: review:none with no router state on the head needs no bot and is NOT READY with the router reason', () => {
  const reason = 'the router has not classified this head; re-run the router workflow';
  for (const auto of [true, false]) {
    for (const [name, comments] of [['no comment', []], ['state of an older head', [NONE_STATE(OLD)]]]) {
      const r = evaluate(noRouter(['review:none'], comments, AUTO(auto)));
      const at = `${name}, auto ${auto}`;
      assert.equal(r.ready, false, at);
      assert.deepEqual(r.routing.required, [], `${at}: no bot is requested`);
      assert.equal(r.coderabbit, null, at);
      assert.ok(r.reasons.some((x) => x.includes(reason)), `${at}: ${r.reasons.join('; ')}`);
    }
  }
});

test('RN4: pathway none with a class above pclass is NOT READY with the raise reason; other cases are READY', () => {
  const raised = stateComment(HEAD, `class=infra head=${HEAD} pathway=none pclass=normal`);
  for (const auto of [true, false]) {
    const r = evaluate(noRouter(['review:none', 'risk:infra'], [raised], AUTO(auto)));
    assert.equal(r.ready, false, `auto ${auto}`);
    assert.deepEqual(r.routing.required, [], `auto ${auto}`);
    assert.ok(r.reasons.some((x) => /class raised after the checkpoint/.test(x)), `auto ${auto}: ${r.reasons.join('; ')}`);
  }
  const same = stateComment(HEAD, `class=infra head=${HEAD} pathway=none pclass=infra`);
  assert.equal(evaluate(noRouter(['review:none', 'risk:infra'], [same])).ready, true, 'class equal to pclass is fine');
  // A coderabbit pathway can rise freely: the raise reason is for pathway none only.
  const cr = stateComment(HEAD, `class=infra head=${HEAD} pathway=coderabbit pclass=normal`);
  const withCr = evaluate(routed(['review:coderabbit', 'risk:infra'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [cr] } }));
  assert.ok(!withCr.reasons.some((x) => /class raised after the checkpoint/.test(x)), withCr.reasons.join('; '));
  assert.equal(withCr.ready, true, withCr.reasons.join('; '));
});

test('RN5 (G1): pathway=both in the state keeps Greptile required while Greptile auto is off', () => {
  const both = stateComment(HEAD, `class=infra head=${HEAD} pathway=both pclass=infra`);
  const r = evaluate(routed(['review:deep'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [both], greptileAuto: false } }));
  assert.deepEqual(r.routing.required, ['greptile', 'coderabbit']);
  assert.equal(r.ready, false, 'Greptile has not reviewed the head');
  // Control: the same PR with no pathway=both in the state still drops Greptile while auto is off.
  const plain = stateComment(HEAD, `class=infra head=${HEAD}`);
  const c = evaluate(routed(['review:deep'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [plain], greptileAuto: false } }));
  assert.deepEqual(c.routing.required, ['coderabbit']);
  assert.equal(c.ready, true, c.reasons.join('; '));
});

test('RN5b (G1): a pathway=both state for an older head still keeps Greptile required (stricter, never relaxes); READY stays false', () => {
  const stale = stateComment(OLD, `class=infra head=${OLD} pathway=both pclass=infra`);
  const r = evaluate(routed(['review:deep'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [stale], greptileAuto: false } }));
  assert.deepEqual(r.routing.required, ['greptile', 'coderabbit']);
  assert.equal(r.ready, false);
});

test('RN6: a forged pathway= in a person comment is ignored, even with a lower id than the router comment', () => {
  const real = stateComment(HEAD, `class=infra head=${HEAD} pathway=both pclass=infra`, { id: 900 });
  const forged = stateComment(HEAD, `class=infra head=${HEAD} pathway=none pclass=infra`, { id: 1, user: { login: 'someone', type: 'User' } });
  const r = evaluate(routed(['review:deep'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [forged, real], greptileAuto: false } }));
  assert.deepEqual(r.routing.required, ['greptile', 'coderabbit'], 'only the bot comment says both');
  // A forged "none" state cannot make a review:none PR READY either.
  const lone = evaluate(noRouter(['review:none'], [stateComment(HEAD, `class=normal head=${HEAD} pathway=none pclass=normal`, { id: 1, user: { login: 'someone', type: 'User' } })]));
  assert.equal(lone.ready, false);
  assert.ok(lone.reasons.some((x) => /has not classified this head/.test(x)), lone.reasons.join('; '));
});

test('RN8: a person risk label above the saved class on a review:none PR still names no bot, and the PR is NOT READY', () => {
  for (const auto of [true, false]) {
    const r = evaluate(noRouter(['review:none', 'risk:high'], [NONE_STATE()], AUTO(auto)));
    assert.deepEqual(r.routing.required, [], `auto ${auto}: review:none wants no bot, so keep() must not add one`);
    assert.equal(r.coderabbit, null, `auto ${auto}`);
    assert.equal(r.ready, false, `auto ${auto}: the router has not routed the higher label`);
  }
});

test('RN7: routerState returns pathway and pclass from a bot comment, null when absent or not on the list', () => {
  const s = RS.routerState([stateComment(HEAD, `class=infra head=${HEAD} pathway=none pclass=normal`)]);
  assert.deepEqual(s, { class: 'infra', head: HEAD, pathway: 'none', pclass: 'normal' });
  const held = RS.routerState([stateComment(HEAD, `class=steering head=${HEAD} held=apex_d3 pathway=both pclass=steering`)]);
  assert.equal(held.pathway, 'both');
  assert.equal(held.pclass, 'steering');
  const old = RS.routerState([stateComment(HEAD, `class=infra head=${HEAD}`)]);
  assert.deepEqual(old, { class: 'infra', head: HEAD, pathway: null, pclass: null });
  const junk = RS.routerState([stateComment(HEAD, `class=infra head=${HEAD} pathway=evil pclass=nonsense`)]);
  assert.equal(junk.class, 'infra');
  assert.equal(junk.pathway, null);
  assert.equal(junk.pclass, null);
  assert.equal(RS.routerState([stateComment(HEAD, `class=infra head=${HEAD} pathway=none pclass=normal`, { user: { login: 'someone', type: 'User' } })]), null);
});

test('RN5c (G1): pathway=both with no review:* label requires CodeRabbit too, not Greptile alone', () => {
  const both = stateComment(HEAD, `class=infra head=${HEAD} pathway=both pclass=infra`);
  const r = evaluate(routed(['risk:infra'], { router: false, input: NO_GREPTILE, eval: { reviews: [CR_REVIEW], comments: [both], greptileAuto: false } }));
  assert.deepEqual(r.routing.required, ['greptile', 'coderabbit'], 'auto off adds CodeRabbit; G1 must not drop it');
});

test('RN9z: no note review-status.mjs exports tells a person to run /checkpoint, a built-in of Claude Code; the notes name /pathway', () => {
  const notes = Object.entries(RS).filter(([, v]) => typeof v === 'string');
  assert.ok(notes.length >= 3, 'review-status.mjs exports its note texts as strings');
  for (const [name, text] of notes) assert.ok(!text.includes('/checkpoint'), `${name} names /checkpoint: ${text}`);
  assert.match(RS.CLASS_RAISED_NOTE, /Return the PR to draft \(gh pr ready --undo\), then run \/pathway again/);
  assert.ok(RS.CLASS_RAISED_NOTE.includes('gh pr ready --undo'), 'the note names the draft step');
  assert.match(RS.NONE_NO_CHECKPOINT_NOTE, /run \/pathway /);
});

test('RN9: review:none whose router state on the head saved no pathway=none checkpoint is NOT READY and asks no bot', () => {
  const reason = 'review:none has no saved checkpoint (pathway=none) on this head; run /pathway or re-run the router workflow';
  const states = [
    ['no pathway', stateComment(HEAD, 'class=normal head=HEAD')],
    ['pathway none, no pclass', stateComment(HEAD, 'class=normal head=HEAD pathway=none')],
    ['pathway coderabbit', stateComment(HEAD, 'class=normal head=HEAD pathway=coderabbit pclass=normal')],
  ];
  for (const auto of [true, false]) {
    for (const [name, comment] of states) {
      const r = evaluate(noRouter(['review:none', 'risk:normal'], [comment], AUTO(auto)));
      const at = `${name}, auto ${auto}`;
      assert.equal(r.ready, false, at);
      assert.deepEqual(r.routing.required, [], `${at}: no bot is requested`);
      assert.ok(r.reasons.some((x) => x.includes(reason)), `${at}: ${r.reasons.join('; ')}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// PR checkpoint (PR C, spec section 4): additive JSON fields the pr-loop mod reads. No READY logic changes.
//
// New contract, written before the code:
//   evaluate(...).isDraft               boolean, pull.draft === true
//   evaluate(...).labels                the label names on the PR (strings)
//   evaluate(...).coderabbitRequests    number: issue comments by a NON-bot author whose trimmed body starts with
//                                       "@coderabbitai review" or "@coderabbitai full review"
//   evaluate(...).coderabbitRounds      coderabbitRoundsOf({ reviews, comments })
//   export coderabbitRoundsOf({ reviews = [], comments = [] }) -> number: the CodeRabbit PR reviews bought so far
//       no bot review and no request                                        0
//       else max(botReviews, requests + (first bot review older than the first request ? 1 : 0))
//       botReviews = distinct commit_id values among the coderabbitai[bot] review objects
//   export DRAFT_REASON = 'PR is a draft (no bot review on drafts)'   the reason evaluate pushes for a draft
//
// How it can fail, and the test that catches it:
//   isDraft or labels missing, or isDraft true for a non-draft                    -> RS1
//   a request counted from a bot, from a rate-limit comment or from "reviewer"    -> RS2
//   "full review" not counted, or leading whitespace breaks the match             -> RS2
//   coderabbitRoundsOf missing, or the auto opening plus 2 requests is not 3      -> RS3
//   a request before the first review is counted twice                            -> RS3
//   two review objects of one commit count as two rounds (the round ask fires early) -> RS4
//   an empty-body thread-reply review counts as a round                                       -> RS4
//   a non-empty review body without 'Actionable comments posted' is skipped as a round        -> RS4
//   the JSON drops the fields, or they are not numbers/booleans                   -> RS5
//   DRAFT_REASON not exported, or evaluate writes another text                    -> RS6
const REQ_USER = { login: 'Rev4nchist', type: 'User' };
const reqComment = (id, body, createdAt, user = REQ_USER) => ({ id, user, body, created_at: createdAt });
const crBotReview = (commit, at) => ({ user: CR_BOT, commit_id: commit, submitted_at: at, body: 'Actionable comments posted: 0' });
const rsFn = (name) => {
  assert.equal(typeof RS[name], 'function', `review-status.mjs must export ${name}`);
  return RS[name];
};

test('RS1: isDraft and labels are in the result; a non-draft is false', () => {
  const draft = evaluate(routed(['review:coderabbit', 'risk:infra'], { draft: true }));
  assert.equal(draft.isDraft, true);
  assert.deepEqual(draft.labels, ['review:coderabbit', 'risk:infra']);
  const open = evaluate(routed(['review:none'], { draft: false }));
  assert.equal(open.isDraft, false);
  assert.deepEqual(open.labels, ['review:none']);
  assert.equal(evaluate(routed([], {})).isDraft, false, 'no draft key on the pull is not a draft');
});

test('RS2: coderabbitRequests counts only a person asking for a review', () => {
  const comments = [
    reqComment(1, '@coderabbitai review', '2026-10-28T10:00:00Z'),
    reqComment(2, '  @coderabbitai full review\n', '2026-10-28T11:00:00Z'),
    reqComment(3, '@coderabbitai rate limit', '2026-10-28T11:30:00Z'),
    reqComment(4, '@coderabbitai reviewer please', '2026-10-28T11:40:00Z'),
    reqComment(5, '> @coderabbitai review', '2026-10-28T11:50:00Z'),
    reqComment(6, '@coderabbitai review', '2026-10-28T12:00:00Z', { login: 'coderabbitai[bot]', type: 'Bot' }),
    reqComment(7, '@coderabbitai review', '2026-10-28T12:10:00Z', { login: 'github-actions[bot]', type: 'Bot' }),
    reqComment(8, 'looks good, ask @coderabbitai review later', '2026-10-28T12:20:00Z'),
  ];
  const r = evaluate(routed(['review:coderabbit'], { eval: { comments, reviews: [] } }));
  assert.equal(r.coderabbitRequests, 2, 'comments 1 and 2 only');
});

test('RS3: coderabbitRoundsOf counts the opening once and each request after it', () => {
  const rounds = rsFn('coderabbitRoundsOf');
  const A = 'a'.repeat(40);
  assert.equal(rounds({ reviews: [], comments: [] }), 0, 'no review and no request');
  assert.equal(rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z')], comments: [] }), 1, 'the automatic opening review');
  assert.equal(
    rounds({ reviews: [crBotReview(A, '2026-10-28T10:05:00Z')], comments: [reqComment(1, '@coderabbitai review', '2026-10-28T10:00:00Z')] }),
    1,
    'a request posted before the first review is the opening, not a second round',
  );
  assert.equal(
    rounds({
      reviews: [crBotReview(A, '2026-10-28T10:00:00Z')],
      comments: [reqComment(1, '@coderabbitai review', '2026-10-28T11:00:00Z'), reqComment(2, '@coderabbitai full review', '2026-10-28T12:00:00Z')],
    }),
    3,
    'an auto opening and 2 requests (their reviews not in yet)',
  );
  assert.equal(
    rounds({ reviews: [], comments: [reqComment(1, '@coderabbitai review', '2026-10-28T11:00:00Z')] }),
    1,
    'a request with no review yet is one bought round',
  );
  assert.equal(
    rounds({ reviews: [], comments: [reqComment(1, '@coderabbitai rate limit', '2026-10-28T11:00:00Z'), reqComment(2, 'review', '2026-10-28T11:01:00Z', CR_BOT)] }),
    0,
    'a rate-limit query and bot comments are not rounds',
  );
});

test('RS4: two CodeRabbit review objects on one commit are one round', () => {
  const rounds = rsFn('coderabbitRoundsOf');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  assert.equal(rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z'), crBotReview(A, '2026-10-28T10:01:00Z')], comments: [] }), 1);
  assert.equal(rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z'), crBotReview(B, '2026-10-28T11:00:00Z'), crBotReview(B, '2026-10-28T11:02:00Z')], comments: [] }), 2);
  assert.equal(rounds({ reviews: [{ user: { login: 'someone', type: 'User' }, commit_id: A, submitted_at: '2026-10-28T10:00:00Z', body: 'x' }], comments: [] }), 0, 'only the CodeRabbit app counts');
  // A thread reply makes a COMMENTED review with an empty body on the head commit: it buys no round.
  const reply = (commit, at) => ({ user: CR_BOT, commit_id: commit, submitted_at: at, body: '' });
  assert.equal(rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z'), reply(B, '2026-10-28T11:00:00Z')], comments: [] }), 1, 'an empty-body reply on commit B is not a round');
  assert.equal(rounds({ reviews: [reply(A, '2026-10-28T10:00:00Z')], comments: [] }), 0, 'a reply alone is no round');
  assert.equal(
    rounds({ reviews: [reply(A, '2026-10-28T09:00:00Z'), crBotReview(A, '2026-10-28T10:30:00Z')], comments: [reqComment(1, '@coderabbitai review', '2026-10-28T10:00:00Z')] }),
    1,
    'an early reply does not make the first review older than the request',
  );
  // A real round can carry no "Actionable comments posted" line (outside-diff and nitpick findings only): it still counts.
  const C = 'c'.repeat(40);
  const noSentence = (commit, at) => ({ user: CR_BOT, commit_id: commit, submitted_at: at, body: '**Outside diff range comments (2)**\n'.padEnd(8258, 'x') });
  assert.equal(
    rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z'), crBotReview(B, '2026-10-28T11:00:00Z'), noSentence(C, '2026-10-28T12:00:00Z')], comments: [] }),
    3,
    'a long body with no review sentence on commit C is a round',
  );
  const blank = (commit, at) => ({ user: CR_BOT, commit_id: commit, submitted_at: at, body: ' \n\t ' });
  assert.equal(
    rounds({ reviews: [crBotReview(A, '2026-10-28T10:00:00Z'), reply(B, '2026-10-28T11:00:00Z'), blank(C, '2026-10-28T12:00:00Z')], comments: [] }),
    1,
    'an empty and a whitespace-only review on other commits add no round',
  );
});

test('RS5: the JSON result carries isDraft, labels, coderabbitRequests and coderabbitRounds, whatever the labels', () => {
  for (const labels of [[], ['review:none'], ['review:coderabbit'], ['risk:docs']]) {
    const r = evaluate(routed(labels, { eval: { reviews: [crBotReview(HEAD, '2026-10-28T10:00:00Z')], comments: [reqComment(1, '@coderabbitai review', '2026-10-28T11:00:00Z')] } }));
    assert.equal(typeof r.isDraft, 'boolean', labels.join());
    assert.ok(Array.isArray(r.labels), labels.join());
    assert.equal(typeof r.coderabbitRequests, 'number', labels.join());
    assert.equal(typeof r.coderabbitRounds, 'number', labels.join());
    assert.equal(r.coderabbitRounds, 2, `${labels.join()}: an auto opening plus 1 request`);
  }
});

test('RS6: DRAFT_REASON is exported and is the reason a draft carries; a draft is still never READY', () => {
  assert.equal(RS.DRAFT_REASON, 'PR is a draft (no bot review on drafts)');
  const draft = evaluate(routed(['review:none'], { draft: true, eval: { comments: [NONE_STATE()] } }));
  assert.ok(draft.reasons.includes(RS.DRAFT_REASON), draft.reasons.join('; '));
  assert.equal(draft.ready, false);
});

// ---------------------------------------------------------------------------------------------
// PR D: READY accepts a CodeRabbit review of an earlier head (the carry), and the missing-review reason text.
// Ways it can fail, one test each:
//   the severity reader calls a Major finding minor (a Major fix then merges unreviewed)   -> SV1
//   it calls a Minor finding major, or reads the word "Major" in prose as a marker           -> SV2, SV4
//   it reads the REVIEW BODY of a round for a marker (the body has none; only inline ones do) -> SV4
//   an outside-diff or nitpick finding in the body is missed                                  -> SV3, RC3
//   the carry is not built (a Minor-only round plus a small push still asks for a new review) -> RC1
//   a Major, Critical or unmarked finding is carried                                          -> RC2, RC3, RC4
//   the 30-line limit is off by one, or counts only additions                                 -> RC5
//   a force-push (diverged) or a behind compare is carried                                    -> RC6
//   a critical, parser or renamed critical file is carried                                    -> RC7
//   an r3 or risk:high PR is carried                                                          -> RC8
//   a router state of another head, or a pending CodeRabbit status, is carried               -> RC9, RC10
//   the carry hides an unresolved thread, or drops the Greptile need of a both PR             -> RC11, RC13
//   a missing or failed input is read as eligible                                             -> RC12
//   a newer CodeRabbit review without the review sentence is skipped for an older one         -> RC15
//   the draft or unrouted reason tells a person to post "@coderabbitai review"                -> RC14
// ---------------------------------------------------------------------------------------------
const fixtureText = (name) => readFileSync(new URL(`./fixtures/coderabbit-severity/${name}`, import.meta.url), 'utf8');
const MAJOR_206 = fixtureText('pr206-inline-major.md');
const MINOR_205 = fixtureText('pr205-inline-minor.md');
const BODY_204 = fixtureText('pr204-body-outside-minor-nitpick-trivial.md');
const BODY_206 = fixtureText('pr206-review-body-no-marker.md');
// No real Critical sample was available; this one has the shape of the real Major header with the word changed.
const CRITICAL = MAJOR_206.replace('</picture> Major**', '</picture> Critical**');
const UNMARKED = '<!-- coderabbit-ai-generated:v1 -->\n\nA finding with no severity header.';
const REAL_CONFIG = JSON.parse(readFileSync(new URL('../../review-router.config.json', import.meta.url), 'utf8'));

const sevFn = () => {
  assert.equal(typeof RS.codeRabbitSeverity, 'function', 'review-status.mjs must export codeRabbitSeverity');
  return RS.codeRabbitSeverity;
};

test('SV1: the real PR #206 inline comment (Major) reads as major', () => {
  assert.equal(sevFn()(MAJOR_206), 'major');
});

test('SV2: the real PR #205 inline comment (Minor) reads as minor', () => {
  assert.equal(sevFn()(MINOR_205), 'minor');
});

test('SV3: the real PR #204 review body (outside-diff Minor, nitpick Trivial) reads as minor; Trivial and Nitpick are minor', () => {
  assert.equal(sevFn()(BODY_204), 'minor');
  assert.equal(sevFn()('<picture></picture> Trivial** and <picture></picture> Nitpick**'), 'minor');
});

test('SV4: a marker is the severity after the icon; prose, a review body with no marker and an empty text are unknown; the highest wins', () => {
  const sev = sevFn();
  assert.equal(sev(BODY_206), 'unknown', 'the #206 review body has no marker (the Major one is inline)');
  assert.equal(sev('This is a Major problem and a Critical one.'), 'unknown', 'prose is not a marker');
  assert.equal(sev(''), 'unknown');
  assert.equal(sev(null), 'unknown');
  assert.equal(sev(CRITICAL), 'critical');
  assert.equal(sev(`${MINOR_205}\n${MAJOR_206}`), 'major', 'the highest marker in a text wins');
  assert.equal(sev(`${MAJOR_206}\n${CRITICAL}`), 'critical');
  assert.equal(sev('**\u{1F7E0} Major**'), 'major', 'the emoji form of the outside-diff blockquote');
  assert.equal(sev('**\u{1F7E1} Minor**'), 'minor');
});

// The scenario of a Minor-only round plus a small fix push. routed() builds a PR the router classed on HEAD.
const CR_OLD_REVIEW = { id: 701, user: CR_BOT, commit_id: OLD, submitted_at: '2026-10-28T10:00:00Z', body: 'Actionable comments posted: 1' };
const compareOf = (lines, over = {}) => ({ status: 'ahead', ahead_by: 1, files: [{ filename: 'scripts/x.mjs', additions: lines, deletions: 0 }], ...over });
const carryOf = (over = {}) => ({
  reviewComments: [{ id: 1, body: MINOR_205 }], compare: compareOf(12), prFiles: [{ filename: 'scripts/x.mjs' }], config: REAL_CONFIG,
  matchGlob: matchGlobFn, ...over,
});
// PR D (2026-10-30): the carry also needs a "CLI fix review: <from>..<head> clean" line in the PR body (RC16 to RC21). Every
// carry test below runs with that line, so each keeps testing its own blocker. `cli: null` leaves the line out.
const CLI_LINE = (from = OLD, head = HEAD, verdict = 'clean') => `CLI fix review: ${from.slice(0, 7)}..${head.slice(0, 7)} ${verdict}`;
const carryEval = ({ labels = ['review:coderabbit', 'risk:normal'], carry = carryOf(), evalOver = {}, cli = CLI_LINE(), ...over } = {}) => {
  const i = routed(labels, { input: NO_GREPTILE, eval: { reviews: [CR_OLD_REVIEW], carry, ...evalOver }, ...over });
  if (cli !== null) i.pull.body = `${i.pull.body}
${cli}
`;
  return evaluate(i);
};
const CARRY_REASON = /no CodeRabbit PR-bot review of the head commit/;

test('RC1: a Minor-only round on an earlier head plus a 12-line push is READY, with the carry named', () => {
  const r = carryEval();
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.equal(r.coderabbitReviewedHead, false, 'the head itself was not reviewed');
  assert.deepEqual(r.coderabbitCarried, { from: OLD, deltaLines: 12 });
  assert.equal(r.routedReviewed, true);
  assert.equal(r.routing.unverified, undefined);
});

test('RC1b: every other result carries coderabbitCarried: null (a head review, no CodeRabbit need, no carry)', () => {
  const onHead = carryEval({ evalOver: { reviews: [{ ...CR_OLD_REVIEW, commit_id: HEAD }] } });
  assert.equal(onHead.coderabbitCarried, null);
  assert.equal(onHead.ready, true, onHead.reasons.join('; '));
  assert.equal(evaluate(input()).coderabbitCarried, null, 'Greptile-only PR');
  assert.equal(carryEval({ carry: null }).coderabbitCarried, null);
});

test('RC2: an inline Major is not carried: NOT READY with the missing-review reason', () => {
  const r = carryEval({ carry: carryOf({ reviewComments: [{ id: 1, body: MAJOR_206 }] }) });
  assert.equal(r.ready, false);
  assert.equal(r.coderabbitCarried, null);
  assert.ok(r.reasons.some((x) => CARRY_REASON.test(x)), r.reasons.join('; '));
  assert.equal(r.routedReviewed, false);
});

test('RC3: a Critical inline, or a Major in the outside-diff or nitpick part of the body, is not carried', () => {
  assert.equal(carryEval({ carry: carryOf({ reviewComments: [{ id: 1, body: CRITICAL }] }) }).ready, false);
  const outside = 'Actionable comments posted: 1\n> **Outside diff range comments (1)**\n> <summary><strong><picture></picture> Major</strong> x</summary>';
  const r = carryEval({ evalOver: { reviews: [{ ...CR_OLD_REVIEW, body: outside }] } });
  assert.equal(r.ready, false);
  assert.equal(r.coderabbitCarried, null);
  const nit = 'Actionable comments posted: 1\n<summary><picture></picture> Nitpick comments: 1</summary>\n`5-9`: **<picture></picture> Critical** · x';
  assert.equal(carryEval({ evalOver: { reviews: [{ ...CR_OLD_REVIEW, body: nit }] } }).coderabbitCarried, null);
});

test('RC4: a finding with no marker, or fewer markers than "Actionable comments posted", is not carried (unknown counts as Major)', () => {
  assert.equal(carryEval({ carry: carryOf({ reviewComments: [{ id: 1, body: UNMARKED }] }) }).coderabbitCarried, null);
  const two = { evalOver: { reviews: [{ ...CR_OLD_REVIEW, body: 'Actionable comments posted: 2' }] } };
  assert.equal(carryEval({ ...two, carry: carryOf({ reviewComments: [{ id: 1, body: MINOR_205 }] }) }).coderabbitCarried, null, '1 of 2 comments read');
  assert.equal(carryEval({ ...two, carry: carryOf({ reviewComments: [{ id: 1, body: MINOR_205 }, { id: 2, body: MINOR_205 }] }) }).ready, true, 'both read and marked');
  const outside = { evalOver: { reviews: [{ ...CR_OLD_REVIEW, body: 'Actionable comments posted: 1\n> **Outside diff range comments (1)**\n> a finding with no marker' }] } };
  assert.equal(carryEval(outside).coderabbitCarried, null, 'an outside-diff finding without a marker');
  // N counts inline comments only (live PR 204: N 1, one inline comment, one more finding outside the diff): an outside-diff marker is no inline comment.
  const marked = { evalOver: { reviews: [{ ...CR_OLD_REVIEW, body: 'Actionable comments posted: 1\n> **Outside diff range comments (1)**\n> <summary><strong><picture></picture> Minor</strong> x</summary>' }] } };
  assert.equal(carryEval({ ...marked, carry: carryOf({ reviewComments: [] }) }).coderabbitCarried, null, 'N 1 but no inline comment read');
  const both = carryEval({ ...marked, carry: carryOf() });
  assert.deepEqual(both.coderabbitCarried, { from: OLD, deltaLines: 12 }, 'one inline Minor plus one outside-diff Minor is carried');
  assert.ok(both.reasons.some((x) => /outside-diff finding/.test(x)), 'the outside-diff count still needs its handled list');
});

test('RC5: the carry limit is 30 lines of additions plus deletions: 30 is READY, 31 is not', () => {
  assert.equal(carryEval({ carry: carryOf({ compare: compareOf(30) }) }).ready, true);
  const over = carryEval({ carry: carryOf({ compare: compareOf(31) }) });
  assert.equal(over.ready, false);
  assert.equal(over.coderabbitCarried, null);
  // PR D: only PR files count, so the compare files a and b are PR files here.
  const mixed = (a, d) => carryOf({ prFiles: [{ filename: 'a' }, { filename: 'b' }], compare: compareOf(0, { files: [{ filename: 'a', additions: a, deletions: d }, { filename: 'b', additions: 5, deletions: 5 }] }) });
  assert.deepEqual(carryEval({ carry: mixed(10, 10) }).coderabbitCarried, { from: OLD, deltaLines: 30 }, 'deletions and a second file count');
  assert.equal(carryEval({ carry: mixed(10, 11) }).coderabbitCarried, null);
  assert.equal(carryEval({ carry: carryOf({ prFiles: [{ filename: 'a' }], compare: compareOf(0, { files: [{ filename: 'a', additions: 0, deletions: 30 }] }) }) }).ready, true, 'a deletion-only push of 30');
});

test('RC5b: a file that counts no lines (binary, pure rename) counts as one, and a full compare file list is not trusted', () => {
  const binaries = Array.from({ length: 31 }, (_, i) => ({ filename: `img${i}.png`, additions: 0, deletions: 0 }));
  const binaryFiles = binaries.map((b) => ({ filename: b.filename }));
  assert.equal(carryEval({ carry: carryOf({ prFiles: binaryFiles, compare: compareOf(0, { files: binaries }) }) }).coderabbitCarried, null, '31 binary files are 31 lines');
  const capped = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, additions: 0, deletions: 0 }));
  assert.equal(carryEval({ carry: carryOf({ prFiles: capped.map((c) => ({ filename: c.filename })), compare: compareOf(0, { files: capped }) }) }).coderabbitCarried, null);
  assert.equal(carryEval({ carry: carryOf({ prFiles: [{ filename: 'a' }], compare: compareOf(0, { files: [{ filename: 'a', additions: 'x', deletions: 0 }] }) }) }).coderabbitCarried, null, 'a non-number');
});

test('RC6: a force-push (diverged), a behind compare and any status but ahead are not carried', () => {
  for (const status of ['diverged', 'behind', 'identical', undefined]) {
    const r = carryEval({ carry: carryOf({ compare: compareOf(3, { status }) }) });
    assert.equal(r.ready, false, String(status));
    assert.equal(r.coderabbitCarried, null, String(status));
  }
});

test('RC7: a PR file that matches a critical or parser glob, or the old name of a renamed one, is not carried', () => {
  const only = (prFiles) => carryEval({ carry: carryOf({ prFiles }) });
  assert.equal(only([{ filename: 'scripts/x.mjs' }, { filename: 'scripts/github/land-pr.ps1' }]).coderabbitCarried, null, 'critical');
  assert.equal(only([{ filename: '.claude/hooks/src/package-install-guard.ts' }]).coderabbitCarried, null, 'parser');
  assert.equal(only([{ filename: 'scripts/old-name.ps1', previous_filename: 'scripts/github/land-pr.ps1' }]).coderabbitCarried, null, 'renamed away from a critical file');
  assert.equal(only([{ filename: '.claude/hooks/src/other-guard.ts' }]).coderabbitCarried, null, 'a *-guard.ts glob');
  assert.equal(only([{ filename: 'scripts/x.mjs' }]).ready, true);
});

test('RC8: an r3 class or a risk:high label is not carried', () => {
  const r3 = carryEval({ router: false, evalOver: { comments: [stateComment(HEAD, 'class=r3 head=HEAD')] } });
  assert.equal(r3.coderabbitCarried, null);
  const high = carryEval({ labels: ['review:coderabbit', 'risk:high'] });
  assert.equal(high.coderabbitCarried, null);
  assert.equal(high.ready, false);
});

test('RC9: a router state of another head is not carried (Greptile stays required)', () => {
  const r = carryEval({ router: OLD });
  assert.equal(r.ready, false);
  assert.equal(r.coderabbitCarried, null);
});

test('RC10: a pending CodeRabbit status is not carried; a success or absent status is', () => {
  const status = (state) => ({ context: 'CodeRabbit', state, description: 'x' });
  const pending = carryEval({ input: { ...NO_GREPTILE, statuses: [status('pending')] } });
  assert.equal(pending.coderabbitCarried, null);
  assert.equal(pending.coderabbit, 'pending');
  assert.equal(carryEval({ input: { ...NO_GREPTILE, statuses: [status('success')] } }).ready, true);
});

test('RC11: a carry does not clear an unresolved thread or a failing check', () => {
  const r = carryEval({ input: { ...NO_GREPTILE, threads: [{ isResolved: false }] } });
  assert.equal(r.ready, false);
  assert.deepEqual(r.coderabbitCarried, { from: OLD, deltaLines: 12 });
  assert.ok(r.reasons.some((x) => /review thread\(s\) unresolved/.test(x)), r.reasons.join('; '));
  assert.ok(!r.reasons.some((x) => CARRY_REASON.test(x)), 'the carry removes only the missing-review reason');
  const ci = carryEval({ input: { ...NO_GREPTILE, statuses: [{ context: 'ci', state: 'failure' }] } });
  assert.equal(ci.ready, false);
  assert.ok(ci.reasons.some((x) => /status "ci" is failure/.test(x)));
});

test('RC12: any missing input or failed fetch is not eligible, never an error', () => {
  for (const [name, carry] of [
    ['no carry', null],
    ['no inline comments', carryOf({ reviewComments: null })],
    ['no compare', carryOf({ compare: null })],
    ['no PR files', carryOf({ prFiles: null })],
    ['no config', carryOf({ config: null })],
    ['a config with no checkpoint lists', carryOf({ config: {} })],
    ['no matchGlob', carryOf({ matchGlob: undefined })],
    ['a matchGlob that throws', carryOf({ matchGlob: () => { throw new Error('bad glob'); } })],
  ]) {
    const r = carryEval({ carry });
    assert.equal(r.ready, false, name);
    assert.equal(r.coderabbitCarried, null, name);
    assert.ok(r.reasons.some((x) => CARRY_REASON.test(x)), `${name}: ${r.reasons.join('; ')}`);
  }
  assert.equal(typeof RS.carryBlockers, 'function', 'review-status.mjs must export carryBlockers');
  const direct = RS.carryBlockers({});
  assert.ok(Array.isArray(direct) && direct.length > 0, 'carryBlockers({}) returns reasons and does not throw');
});

test('RC13: the carry does not drop the Greptile need of a pathway=both PR', () => {
  const both = stateComment(HEAD, 'class=infra head=HEAD pathway=both');
  const r = carryEval({ router: false, evalOver: { comments: [both] } });
  assert.equal(r.routing.required.includes('greptile'), true);
  assert.equal(r.ready, false, 'Greptile has not reviewed');
  assert.ok(r.reasons.some((x) => /Greptile/.test(x)), r.reasons.join('; '));
});

test('RC15: when a newer CodeRabbit review has no review sentence, an older Minor-only round is not carried', () => {
  const newer = { id: 702, user: CR_BOT, commit_id: 'd'.repeat(40), submitted_at: '2026-10-28T11:00:00Z', body: 'Outside diff range comments (1) only, no sentence' };
  const r = carryEval({ evalOver: { reviews: [CR_OLD_REVIEW, newer] } });
  assert.equal(r.coderabbitCarried, null);
  assert.equal(r.ready, false);
  const empty = { id: 703, user: CR_BOT, commit_id: HEAD, submitted_at: '2026-10-28T12:00:00Z', body: '' };
  assert.equal(carryEval({ evalOver: { reviews: [CR_OLD_REVIEW, empty] } }).ready, true, 'an empty thread-reply review is no round');
  const person = { id: 704, user: { login: 'Rev4nchist', type: 'User' }, commit_id: HEAD, submitted_at: '2026-10-28T12:00:00Z', body: 'x' };
  assert.equal(carryEval({ evalOver: { reviews: [CR_OLD_REVIEW, person] } }).ready, true, 'a person review is not CodeRabbit');
});

test('RC14: the missing-review reason names /pathway for a draft and the router workflow for an unrouted PR; a routed PR keeps the old text', () => {
  assert.equal(RS.NO_REVIEW_DRAFT_REASON, 'no CodeRabbit PR-bot review of the head commit. Draft: run /pathway; do not request a review');
  assert.equal(RS.NO_REVIEW_UNVERIFIED_REASON, 'no CodeRabbit PR-bot review of the head commit; re-run the review-router workflow for this head; do not request a review');
  const noReview = (r) => r.reasons.find((x) => CARRY_REASON.test(x));
  const draft = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, draft: true }));
  assert.equal(noReview(draft), RS.NO_REVIEW_DRAFT_REASON);
  const unrouted = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE, router: false }));
  assert.equal(noReview(unrouted), RS.NO_REVIEW_UNVERIFIED_REASON);
  const routedPr = evaluate(routed(['review:coderabbit'], { input: NO_GREPTILE }));
  assert.equal(noReview(routedPr), 'no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count). After a push, post "@coderabbitai review" once to start one');
  for (const r of [draft, unrouted]) {
    assert.ok(!r.reasons.some((x) => CARRY_REASON.test(x) && /@coderabbitai review/.test(x)), 'no text asks for a review');
    assert.ok(!r.reasons.some((x) => x.includes('/checkpoint')), '/checkpoint is a built-in of Claude Code');
  }
});

// ---------------------------------------------------------------------------------------------
// PR D follow-up (Dave, 2026-10-30): two more carry conditions. One test per way each can fail:
//   a carry without a CLI review of the fix (the body line is missing)                       -> RC16
//   a line for another from-commit or another head (an old line after a new push)             -> RC17
//   a line that is not "clean" (1 major, 2 critical, incomplete, extra text) is accepted       -> RC18
//   a 6-character prefix, or a full 40-character sha, is read wrongly                          -> RC19
//   a line inside a code fence or an HTML comment (a pasted example) counts                    -> RC20
//   two matching lines, one not clean, pass; a stale line next to a good one blocks            -> RC21
//   the parser is not exported, or reads fields wrongly (cr-fix.mjs prints the same line)      -> RC22
//   an old pasted `incomplete` line blocks after a clean line for the same range; a clean line
//     hides a major or critical line                                                            -> RC21b
//   a merge of main counts toward the 30 lines                                                 -> RC23
//   main's changes inside a PR file stop counting (accepted: they do count)                    -> RC24
//   a compare capped at 300 files hides a PR file, so a small delta is read                    -> RC25
//   a rename from a PR path is not matched, or a missing PR list is read as eligible           -> RC26
// ---------------------------------------------------------------------------------------------
const carried = (r) => r.coderabbitCarried !== null;
const MISSING_LINE = /no CodeRabbit PR-bot review of the head commit/;

test('RC16: a carry needs the CLI fix review line in the PR body; without it the PR is NOT READY with the missing-review reason', () => {
  const r = carryEval({ cli: null });
  assert.equal(r.ready, false);
  assert.equal(r.coderabbitCarried, null);
  assert.ok(r.reasons.some((x) => MISSING_LINE.test(x)), r.reasons.join('; '));
  assert.equal(r.routedReviewed, false);
  assert.equal(carryEval({}).ready, true, 'with the line it is READY');
});

test('RC17: the line must name the carried review commit and the current head', () => {
  const OTHER_SHA = 'c'.repeat(40);
  assert.equal(carried(carryEval({ cli: CLI_LINE(OTHER_SHA, HEAD) })), false, 'from names another commit');
  assert.equal(carried(carryEval({ cli: CLI_LINE(OLD, OTHER_SHA) })), false, 'head names another commit (the line is stale after a push)');
  assert.equal(carried(carryEval({ cli: CLI_LINE(HEAD, OLD) })), false, 'from and head swapped');
  assert.equal(carried(carryEval({ cli: CLI_LINE() })), true);
});

test('RC18: only "clean" carries: 1 major, 2 critical, incomplete, a word after clean, and an unknown word are blocked', () => {
  for (const verdict of ['1 major', '2 critical', 'incomplete', 'clean but one nit', 'cleanish', '0 major', 'major', '']) {
    const r = carryEval({ cli: CLI_LINE(OLD, HEAD, verdict) });
    assert.equal(r.coderabbitCarried, null, `"${verdict}"`);
    assert.equal(r.ready, false, `"${verdict}"`);
    assert.ok(r.reasons.some((x) => MISSING_LINE.test(x)), `"${verdict}"`);
  }
});

// PR D: when only the CLI line blocks the carry, the reason sends the author to cr-fix.mjs and never to a paid PR review.
// It fails if: the missing-line, stale-head or not-clean case still says "@coderabbitai review"            -> RC18b
//              the reason drops the "no CodeRabbit PR-bot review of the head commit" prefix (mod, rule)     -> RC18b
//              another blocker (a Major inline, a big push) also switches to the cr-fix text                -> RC18c
test('RC18b: with only the CLI line missing, stale or not clean, the reason names cr-fix.mjs and does not say @coderabbitai review', () => {
  const OTHER_SHA = 'c'.repeat(40);
  for (const [name, cli] of [['missing line', null], ['stale head', CLI_LINE(OLD, OTHER_SHA)], ['1 major', CLI_LINE(OLD, HEAD, '1 major')]]) {
    const r = carryEval({ cli });
    assert.equal(r.ready, false, name);
    const reason = r.reasons.find((x) => MISSING_LINE.test(x));
    assert.ok(reason, `${name}: ${r.reasons.join('; ')}`);
    assert.ok(reason.startsWith('no CodeRabbit PR-bot review of the head commit'), name);
    assert.match(reason, /cr-fix\.mjs --pr 111\b/, name);
    assert.doesNotMatch(reason, /@coderabbitai review/, name);
  }
});

test('RC18c: when another carry condition also fails, the reason keeps asking for a review', () => {
  const r = carryEval({ cli: null, carry: carryOf({ compare: compareOf(31) }) });
  const reason = r.reasons.find((x) => MISSING_LINE.test(x));
  assert.match(reason, /@coderabbitai review/);
  assert.doesNotMatch(reason, /cr-fix/);
});

test('RC19: the shas are a prefix of 7 or more hex characters or the full 40;6 characters, non-hex and a non-prefix do not match', () => {
  const line = (from, head) => `CLI fix review: ${from}..${head} clean`;
  assert.equal(carried(carryEval({ cli: line(OLD.slice(0, 7), HEAD.slice(0, 7)) })), true, '7 and 7');
  assert.equal(carried(carryEval({ cli: line(OLD, HEAD) })), true, '40 and 40');
  assert.equal(carried(carryEval({ cli: line(OLD.slice(0, 12), HEAD.slice(0, 9)) })), true, '12 and 9');
  assert.equal(carried(carryEval({ cli: line(OLD.slice(0, 6), HEAD.slice(0, 7)) })), false, 'from has 6');
  assert.equal(carried(carryEval({ cli: line(OLD.slice(0, 7), HEAD.slice(0, 6)) })), false, 'head has 6');
  assert.equal(carried(carryEval({ cli: line('zzzzzzz', 'zzzzzzz') })), false, 'not hex');
  assert.equal(carried(carryEval({ cli: line('bbbbbbc', HEAD.slice(0, 7)) })), false, 'a 7-character value that is not a prefix of the review commit');
});

test('RC20: a line inside a code fence or an HTML comment is an example, not a result', () => {
  const fencedLine = `\`\`\`text\n${CLI_LINE()}\n\`\`\``;
  const commented = `<!-- ${CLI_LINE()} -->`;
  const multi = `<!--\n${CLI_LINE()}\n-->`;
  for (const [name, cli] of [['fence', fencedLine], ['comment', commented], ['multi-line comment', multi]]) {
    assert.equal(carried(carryEval({ cli })), false, name);
  }
  assert.equal(carried(carryEval({ cli: `${fencedLine}\n${CLI_LINE()}` })), true, 'a real line after a fence counts');
  assert.equal(carried(carryEval({ cli: `- ${CLI_LINE()}` })), true, 'a list bullet is allowed');
});

test('RC21: every line that names this from and head must be clean; lines for other commits are ignored', () => {
  const bad = CLI_LINE(OLD, HEAD, '1 major');
  assert.equal(carried(carryEval({ cli: `${CLI_LINE()}\n${bad}` })), false, 'a clean line and a major line for the same range');
  assert.equal(carried(carryEval({ cli: `${bad}\n${CLI_LINE()}` })), false, 'the order does not matter');
  const stale = CLI_LINE('c'.repeat(40), 'd'.repeat(40), '1 major');
  assert.equal(carried(carryEval({ cli: `${stale}\n${CLI_LINE()}` })), true, 'a line for an older range is ignored');
});

test('RC21b: a clean line overrides incomplete lines for the same range; it never overrides a major or critical line', () => {
  const inc = CLI_LINE(OLD, HEAD, 'incomplete');
  assert.equal(carried(carryEval({ cli: `${inc}
${CLI_LINE()}` })), true, 'incomplete, then clean');
  assert.equal(carried(carryEval({ cli: `${CLI_LINE()}
${inc}` })), true, 'clean, then incomplete');
  assert.equal(carried(carryEval({ cli: inc })), false, 'incomplete alone still blocks');
  for (const bad of ['1 major', '2 critical']) {
    assert.equal(carried(carryEval({ cli: `${inc}
${CLI_LINE()}
${CLI_LINE(OLD, HEAD, bad)}` })), false, bad);
  }
  const stale = CLI_LINE('c'.repeat(40), 'd'.repeat(40), 'incomplete');
  assert.equal(carried(carryEval({ cli: `${stale}
${inc}
${CLI_LINE()}` })), true, 'other ranges are ignored');
});

test('RC22: parseCliFixReviews is exported and reads from, head and verdict; the template text is no result', () => {
  assert.equal(typeof RS.parseCliFixReviews, 'function', 'review-status.mjs must export parseCliFixReviews');
  const got = RS.parseCliFixReviews('intro\nCLI fix review: ABCDEF1..1234567 2 critical\nCLI fix review: bbbbbbb..aaaaaaa clean\n');
  assert.deepEqual(got, [
    { from: 'abcdef1', head: '1234567', verdict: '2 critical' },
    { from: 'bbbbbbb', head: 'aaaaaaa', verdict: 'clean' },
  ]);
  assert.deepEqual(RS.parseCliFixReviews(null), []);
  assert.deepEqual(RS.parseCliFixReviews('CLI fix review: <from7>..<head7> <clean|N major|N critical|incomplete>'), []);
  assert.ok(Array.isArray(RS.carryBlockers({ head: HEAD })) && RS.carryBlockers({ head: HEAD }).length > 0, 'carryBlockers with no body does not throw');
});

// Change 5: the delta counts only the PR's own files.
const BIG_MAIN_MERGE = { status: 'ahead', ahead_by: 3, files: [
  { filename: 'scripts/x.mjs', additions: 12, deletions: 0 },
  { filename: 'other/main-a.mjs', additions: 300, deletions: 100 },
  { filename: 'other/main-b.mjs', additions: 100, deletions: 0 },
] };

test('RC23: a merge of main that touches 500 lines in files outside the PR does not count; the 12-line PR fix carries', () => {
  const r = carryEval({ carry: carryOf({ compare: BIG_MAIN_MERGE }) });
  assert.equal(r.ready, true, r.reasons.join('; '));
  assert.deepEqual(r.coderabbitCarried, { from: OLD, deltaLines: 12 });
});

test('RC24: main changes inside a PR file still count (accepted): a 12-line fix plus 25 lines of main in a PR file is 37 and does not carry', () => {
  // Accepted limit: the compare cannot tell a fix line from a line main changed in the same file, so those lines count.
  const compare = { status: 'ahead', ahead_by: 2, files: [{ filename: 'scripts/x.mjs', additions: 12 + 20, deletions: 5 }] };
  const r = carryEval({ carry: carryOf({ compare }) });
  assert.equal(r.coderabbitCarried, null);
  assert.equal(r.ready, false);
  const edge = { status: 'ahead', ahead_by: 1, files: [{ filename: 'scripts/x.mjs', additions: 30, deletions: 0 }, { filename: 'other/m.mjs', additions: 99, deletions: 99 }] };
  assert.equal(carried(carryEval({ carry: carryOf({ compare: edge }) })), true, '30 in the PR file is the limit; the outside file is ignored');
  const over = { ...edge, files: [{ ...edge.files[0], additions: 31 }, edge.files[1]] };
  assert.equal(carried(carryEval({ carry: carryOf({ compare: over }) })), false, '31 in the PR file is over');
});

test('RC25: a compare that lists 300 files may be cut off, so it never carries, even when none of its files is a PR file', () => {
  const capped = Array.from({ length: 300 }, (_, i) => ({ filename: `other/m${i}.mjs`, additions: 1, deletions: 0 }));
  const r = carryEval({ carry: carryOf({ compare: { status: 'ahead', ahead_by: 9, files: capped } }) });
  assert.equal(r.coderabbitCarried, null);
  assert.equal(r.ready, false);
  const small = Array.from({ length: 299 }, (_, i) => ({ filename: `other/m${i}.mjs`, additions: 1, deletions: 0 }));
  assert.equal(carried(carryEval({ carry: carryOf({ compare: { status: 'ahead', ahead_by: 9, files: small } }) })), true, '299 files is a full list');
});

test('RC26: the PR file list decides, by new or old name; a missing list or a compare file with a bad count never carries', () => {
  const renamed = { status: 'ahead', ahead_by: 1, files: [{ filename: 'scripts/new-x.mjs', previous_filename: 'scripts/x.mjs', additions: 40, deletions: 0 }] };
  assert.equal(carried(carryEval({ carry: carryOf({ compare: renamed }) })), false, 'the PR file scripts/x.mjs was renamed in the push: its 40 lines count');
  assert.equal(carried(carryEval({ carry: carryOf({ prFiles: null, compare: BIG_MAIN_MERGE }) })), false, 'no PR file list');
  const bad = { status: 'ahead', ahead_by: 1, files: [{ filename: 'other/m.mjs', additions: 'x', deletions: 0 }, { filename: 'scripts/x.mjs', additions: 1, deletions: 0 }] };
  assert.equal(carried(carryEval({ carry: carryOf({ compare: bad }) })), false, 'a bad count in a file outside the PR is still unreadable');
  assert.equal(carried(carryEval({ carry: carryOf({ compare: { status: 'ahead', files: [] } }) })), true, 'an empty compare counts 0 lines');
});
