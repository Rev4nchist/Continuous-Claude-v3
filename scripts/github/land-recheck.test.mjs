// Tests for land-recheck.mjs (Gate C, the re-check land-pr.ps1 runs right before the merge call).
// Run: node --test scripts/github/land-recheck.test.mjs
// No network: gh is an injected fake.
//
// How the re-check can fail, and the test that catches it (written before the code):
//   the head moved after the READY check but the merge goes on                              -> RC1
//   a CodeRabbit review landed after the READY check and is missed                          -> RC2
//   a CodeRabbit summary comment was edited after the READY check and is missed             -> RC3
//   an "@coderabbitai review" request has no review after it (in flight) and is missed      -> RC4
//   the CodeRabbit commit status on the head is pending and is missed                       -> RC5
//   a quiet PR is refused (old review, old edit, answered request, success status)          -> RC6
//   a person, another bot or another status trips a gate it must not                        -> RC7
//   several gates fire and only one reason is shown                                         -> RC8
//   a read error, a bad READY time or a bad payload gives a go instead of a refusal         -> RC9 to RC12
//   the command line reports a refusal or an error with exit 0                              -> RC13
//   a clean summary-only round (live PR 211) answers a request, but the request stays "in flight" -> RC4d to RC4g
//   a review just before the READY time slips through (decision side of the 120 s clock margin)  -> RC2c
//   a summary a person (or another app) edited, or one with no edit history, answers a request  -> RC14 to RC14d
//   the comments are read without the edit history, or a read error there goes through          -> RC14e to RC14g, RC10e
//   the newest round is picked by submitted_at, not by the PR's commit order, and hides a request   -> RC15, RC15e
//   the commit list is unreadable and rounds on two commits cannot be ordered                       -> RC15b to RC15e
//   the automatic "Review skipped" notice on a review:none PR refuses the land for 120 s (live PR 338) -> RC16
//   that exception hides a notice on a CodeRabbit-labelled PR, a real summary edit, an edited or unlabelled-unknown notice -> RC16b to RC16f
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRecheck, recheckPr, parseArgs } from './land-recheck.mjs';

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const READY_AT = '2026-10-30T12:00:00Z';
const BEFORE = '2026-10-30T11:00:00Z';
const AFTER = '2026-10-30T12:05:00Z';
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const PERSON = { login: 'Rev4nchist', type: 'User' };
const MARKER = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';

const review = (id, submitted_at, over = {}) => ({ id, user: CR_BOT, commit_id: HEAD, submitted_at, body: 'Actionable comments posted: 1', ...over });
const summary = (updated_at, over = {}) => ({ id: 900, user: CR_BOT, body: `${MARKER}\nsummary`, created_at: BEFORE, updated_at, ...over });
const request = (created_at, over = {}) => ({ id: 901, user: PERSON, body: '@coderabbitai review', created_at, updated_at: created_at, ...over });
const status = (state, context = 'CodeRabbit') => ({ context, state });
// Edit history (GraphQL userContentEdits, newest first) of the summary: CodeRabbit edited it, or a person did.
const CR_EDIT = { editor: { __typename: 'Bot', login: 'coderabbitai' }, editedAt: '2026-10-30T13:48:07Z' };
const PERSON_EDIT = { editor: { __typename: 'User', login: 'Rev4nchist' }, editedAt: '2026-10-30T13:49:00Z' };

/** A quiet PR: same head, everything CodeRabbit did is older than the READY check. */
const quiet = (over = {}) => ({
  readyHead: HEAD,
  readyAt: READY_AT,
  pull: { head: { sha: HEAD } },
  reviews: [review(1, BEFORE)],
  comments: [summary(BEFORE), request('2026-10-30T10:00:00Z')],
  commentEdits: { 900: [] },
  statuses: [status('success')],
  ...over,
});

const refusalsOf = (input) => decideRecheck(input).refusals.join(' | ');

test('RC1: a head that moved since the READY check refuses', () => {
  const r = decideRecheck(quiet({ pull: { head: { sha: MOVED } } }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /head changed/i);
});

test('RC2: a CodeRabbit review newer than the READY check refuses', () => {
  const r = decideRecheck(quiet({ reviews: [review(1, BEFORE), review(2, AFTER)] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /review.*after the ready check/i);
});

test('RC2b: a CodeRabbit thread reply (empty body) newer than the READY check also refuses', () => {
  assert.equal(decideRecheck(quiet({ reviews: [review(1, BEFORE), review(2, AFTER, { body: '' })] })).ok, false);
});

test('RC3: a CodeRabbit summary comment edited after the READY check refuses', () => {
  const r = decideRecheck(quiet({ comments: [summary(AFTER)] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /summary.*after the ready check/i);
});

test('RC4: a review request newer than the newest CodeRabbit review refuses (review in flight)', () => {
  const r = decideRecheck(quiet({ comments: [summary(BEFORE), request('2026-10-30T11:30:00Z')] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC4b: a review request with no CodeRabbit review at all refuses', () => {
  assert.equal(decideRecheck(quiet({ reviews: [], comments: [request(BEFORE)] })).ok, false);
});

test('RC4c: "@coderabbitai full review" counts as a request', () => {
  assert.equal(decideRecheck(quiet({ comments: [request('2026-10-30T11:30:00Z', { body: '@coderabbitai full review' })] })).ok, false);
});

// Live PR 211 (2026-10-30): request 13:42:03Z, a "Review finished" reply 13:43:00Z, the summary edited 13:48:07Z to say no
// actionable comments, with final_review_risk_coverage kind=reviewed for the head. No review object with a body was added.
const COVERING = (head, kind = 'reviewed') => `${MARKER}
No actionable comments were generated.
<!-- final_review_risk_coverage:{"coveredCommitId":"${head}","kind":"${kind}"} -->`;
const T211 = { request: '2026-10-30T13:42:03Z', summary: '2026-10-30T13:48:07Z', ready: '2026-10-30T13:50:00Z', old: '2026-10-30T11:00:00Z' };
const pr211 = (over = {}) => quiet({
  readyAt: T211.ready,
  reviews: [review(1, T211.old)],
  comments: [summary(T211.summary, { body: COVERING(HEAD), created_at: T211.old }), request(T211.request)],
  commentEdits: { 900: [CR_EDIT] },
  ...over,
});

test('RC4d: a clean summary-only round that covers the head answers the request (live PR 211)', () => {
  assert.deepEqual(decideRecheck(pr211()), { ok: true, refusals: [] });
});

test('RC4e: a summary that covers an OLDER head does not answer the request', () => {
  const r = decideRecheck(pr211({ comments: [summary(T211.summary, { body: COVERING(MOVED) }), request(T211.request)] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC4f: a notice summary (skipped, rate limited) does not answer the request', () => {
  const body = `${MARKER}
> ## Review skipped
${COVERING(HEAD)}`;
  const r = decideRecheck(pr211({ comments: [summary(T211.summary, { body }), request(T211.request)] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC4g: a covering summary OLDER than the request does not answer it; a summary edit after the READY time still refuses', () => {
  const stale = decideRecheck(pr211({ comments: [summary(T211.old, { body: COVERING(HEAD) }), request(T211.request)] }));
  assert.match(stale.refusals.join(' '), /in flight/i);
  const late = decideRecheck(pr211({ readyAt: '2026-10-30T13:45:00Z' }));
  assert.equal(late.ok, false);
  assert.match(late.refusals.join(' '), /summary.*after the ready check/i);
  assert.doesNotMatch(late.refusals.join(' '), /in flight/i);
});

test('RC14: a summary a person edited does not answer the request (refuse)', () => {
  const r = decideRecheck(pr211({ commentEdits: { 900: [PERSON_EDIT, CR_EDIT] } }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC14b: a summary another app edited does not answer the request (refuse)', () => {
  const other = { editor: { __typename: 'Bot', login: 'greptile-apps' }, editedAt: '2026-10-30T13:49:00Z' };
  assert.match(refusalsOf(pr211({ commentEdits: { 900: [other, CR_EDIT] } })), /in flight/i);
});

test('RC14c: a summary with no edit history read does not answer the request (refuse)', () => {
  assert.match(refusalsOf(pr211({ commentEdits: undefined })), /in flight/i);
  assert.match(refusalsOf(pr211({ commentEdits: {} })), /in flight/i);
});

test('RC14d: a summary only CodeRabbit edited still answers the request (live PR 211 shape)', () => {
  assert.deepEqual(decideRecheck(pr211({ commentEdits: { 900: [CR_EDIT, CR_EDIT] } })), { ok: true, refusals: [] });
});

// Live PR 338 (2026-11-05): a review:none PR. CodeRabbit posted its summary comment as a skip notice 23:49:44Z, 30 s before the
// READY time. Two land runs STOPPED on that comment. The body below is the real text (the Run configuration block is cut).
const SKIP_BODY = `<!-- coderabbit-ai-generated:v1 -->

${MARKER}
<!-- This is an auto-generated comment: skip review by coderabbit.ai -->

> [!IMPORTANT]
> ## Review skipped
>
> Auto reviews are limited based on label configuration.
>
> * review:coderabbit
> * review:deep
> * review:deep-held

<!-- end of auto-generated comment: skip review by coderabbit.ai -->`;
const SKIP_AT = '2026-10-30T11:59:30Z';
const labelled = (...names) => ({ head: { sha: HEAD }, labels: names.map((name) => ({ name })) });
const skipped = (over = {}) => quiet({
  pull: labelled('risk:steering', 'review:none'),
  comments: [summary(SKIP_AT, { body: SKIP_BODY, created_at: SKIP_AT })],
  commentEdits: { 900: [CR_EDIT] },
  ...over,
});

test('RC16: a CodeRabbit "Review skipped" summary after the READY check does not refuse a review:none PR (live PR 338)', () => {
  assert.deepEqual(decideRecheck(skipped({ comments: [summary(AFTER, { body: SKIP_BODY })] })), { ok: true, refusals: [] });
});

test('RC16b: the same skip notice on a PR labelled review:coderabbit, review:deep or review:deep-held still refuses', () => {
  for (const label of ['review:coderabbit', 'review:deep', 'review:deep-held']) {
    const r = decideRecheck(skipped({ pull: labelled('review:none', label), comments: [summary(AFTER, { body: SKIP_BODY })] }));
    assert.equal(r.ok, false, label);
    assert.match(r.refusals.join(' '), /summary.*after the ready check/i);
  }
});

test('RC16c: a real review summary edited after the READY check still refuses on a review:none PR', () => {
  const r = decideRecheck(skipped({ comments: [summary(AFTER, { body: `${MARKER}\nsummary` })] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /summary.*after the ready check/i);
});

test('RC16d: a skip notice a person edited, or one with no edit history, is not ignored (fail closed)', () => {
  const comments = [summary(AFTER, { body: SKIP_BODY })];
  assert.equal(decideRecheck(skipped({ comments, commentEdits: { 900: [PERSON_EDIT, CR_EDIT] } })).ok, false);
  assert.equal(decideRecheck(skipped({ comments, commentEdits: undefined })).ok, false);
});

test('RC16e: a PR whose labels are unreadable is not ignored (fail closed); an unlabelled PR is', () => {
  const comments = [summary(AFTER, { body: SKIP_BODY })];
  assert.equal(decideRecheck(skipped({ comments, pull: { head: { sha: HEAD } } })).ok, false);
  assert.equal(decideRecheck(skipped({ comments, pull: labelled() })).ok, true);
});

test('RC16f: a skip notice does not hide a review object or a request that landed after the READY check', () => {
  const comments = [summary(AFTER, { body: SKIP_BODY }), request(AFTER)];
  assert.match(refusalsOf(skipped({ comments })), /in flight/i);
  assert.match(refusalsOf(skipped({ comments, reviews: [review(2, AFTER)] })), /review landed after the ready check/i);
});

test('RC2c: with the READY time already backed off by the clock margin, a review 60 s after it refuses', () => {
  const r = decideRecheck(quiet({ reviews: [review(1, '2026-10-30T12:01:00Z')] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /review.*after the ready check/i);
});

test('RC5: a pending CodeRabbit commit status on the head refuses', () => {
  const r = decideRecheck(quiet({ statuses: [status('pending')] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /pending/i);
});

test('RC6: a quiet PR proceeds', () => {
  const r = decideRecheck(quiet());
  assert.deepEqual(r, { ok: true, refusals: [] });
});

test('RC6b: a review stamped exactly at the READY time is not newer and proceeds', () => {
  assert.equal(decideRecheck(quiet({ reviews: [review(1, READY_AT)], comments: [summary(READY_AT)] })).ok, true);
});

test('RC6c: a request older than the newest review is answered and proceeds', () => {
  const r = decideRecheck(quiet({ reviews: [review(1, '2026-10-30T10:30:00Z'), review(2, BEFORE)], comments: [request('2026-10-30T10:00:00Z')] }));
  assert.equal(r.ok, true);
});

test('RC7: a person review, a person summary lookalike, another bot and a non-CodeRabbit pending status are ignored', () => {
  const r = decideRecheck(quiet({
    reviews: [review(1, BEFORE), review(2, AFTER, { user: PERSON })],
    comments: [
      summary(BEFORE),
      summary(AFTER, { id: 902, user: PERSON }),
      summary(AFTER, { id: 903, user: { login: 'greptile-apps[bot]', type: 'Bot' } }),
      request(AFTER, { id: 904, user: CR_BOT }),
    ],
    statuses: [status('success'), status('pending', 'Greptile Review')],
  }));
  assert.deepEqual(r, { ok: true, refusals: [] });
});

test('RC8: every gate that fires is listed', () => {
  const text = refusalsOf(quiet({
    pull: { head: { sha: MOVED } },
    reviews: [review(2, AFTER)],
    comments: [summary(AFTER), request('2026-10-30T12:10:00Z')],
    statuses: [status('pending')],
  }));
  for (const word of [/head changed/i, /review.*after the ready check/i, /summary/i, /in flight/i, /pending/i]) assert.match(text, word);
});

// RC15 shape: the review of the NEWER commit (HEAD) landed first; a review of the OLDER commit was re-posted later.
const OLDER = 'c'.repeat(40);
const lateRounds = () => [review(1, BEFORE), review(2, '2026-10-30T11:40:00Z', { commit_id: OLDER })];
const request1120 = () => [summary(BEFORE), request('2026-10-30T11:20:00Z')];

test('RC15: a re-posted review of an OLDER commit, newer by time, does not answer a request after the newest round', () => {
  const commits = [{ sha: OLDER }, { sha: HEAD }];
  const r = decideRecheck(quiet({ reviews: lateRounds(), comments: request1120(), commits }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
  assert.doesNotMatch(r.refusals.join(' '), /commit list/i);
});

test('RC15b: with no commit list and rounds on two commits, the order is unknown and it refuses', () => {
  const r = decideRecheck(quiet({ reviews: lateRounds(), commits: [] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /commit list/i);
});

test('RC15c: with no commit list and rounds on one commit, the order does not matter and it proceeds', () => {
  const reviews = [review(1, '2026-10-30T10:30:00Z'), review(2, BEFORE)];
  assert.deepEqual(decideRecheck(quiet({ reviews, commits: [] })), { ok: true, refusals: [] });
  assert.deepEqual(decideRecheck(quiet({ reviews, commits: undefined })), { ok: true, refusals: [] });
});

test('RC15d: an empty-body reply or a person review on another commit is no second round', () => {
  const reviews = [review(1, BEFORE), review(2, BEFORE, { commit_id: OLDER, body: '' }), review(3, BEFORE, { commit_id: MOVED, user: PERSON })];
  assert.deepEqual(decideRecheck(quiet({ reviews, commits: [] })), { ok: true, refusals: [] });
});

test('RC15f: after an amend, a round on a commit no longer in the PR answers nothing, and a quiet PR still lands', () => {
  // OLDER was rewritten away (only HEAD is listed). Its late round must not answer the 11:20 request; the HEAD round (11:00) is newest.
  const asked = decideRecheck(quiet({ reviews: lateRounds(), comments: request1120(), commits: [{ sha: HEAD }] }));
  assert.equal(asked.ok, false);
  assert.match(asked.refusals.join(' '), /in flight/i);
  assert.doesNotMatch(asked.refusals.join(' '), /commit list/i);
  // No request: the dropped round blocks nothing, so the land goes on.
  assert.deepEqual(decideRecheck(quiet({ reviews: lateRounds(), comments: [summary(BEFORE)], commits: [{ sha: HEAD }] })), { ok: true, refusals: [] });
});

test('RC15h: a complete commit list with rounds on two commits and an answered request lets the PR land', () => {
  const comments = [summary(BEFORE), request('2026-10-30T10:30:00Z')];
  assert.deepEqual(decideRecheck(quiet({ reviews: lateRounds(), comments, commits: [{ sha: OLDER }, { sha: HEAD }] })), { ok: true, refusals: [] });
});

test('RC15i: sha case does not matter when matching rounds to the commit list', () => {
  const reviews = [review(1, BEFORE, { commit_id: HEAD.toUpperCase() }), review(2, '2026-10-30T11:40:00Z', { commit_id: OLDER })];
  const r = decideRecheck(quiet({ reviews, comments: request1120(), commits: [{ sha: OLDER.toUpperCase() }, { sha: HEAD }] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
  assert.doesNotMatch(r.refusals.join(' '), /commit list/i);
});

// ---- recheckPr: the reads ----

/** A fake gh keyed on the endpoint. `fail` makes the matching call throw. */
function fakeGh({ pull = { head: { sha: HEAD } }, reviews = [review(1, BEFORE)], commits = [HEAD], comments = [summary(BEFORE)], edits = { 900: [] }, combined = { statuses: [status('success')] }, combinedPages = null, fail = null } = {}) {
  const calls = [];
  // The GraphQL node of a REST comment (what readIssueComments pairs it with): same body, author and the edit history.
  const node = (c) => ({
    databaseId: c.id,
    body: c.body,
    author: { __typename: c.user.type, login: c.user.login.replace(/\[bot\]$/, '') },
    lastEditedAt: null,
    updatedAt: c.updated_at,
    userContentEdits: { pageInfo: { hasNextPage: false }, nodes: edits[c.id] ?? [] },
  });
  const gh = (args) => {
    const url = args[0] === 'graphql' ? 'graphql' : args.find((a) => a.startsWith('repos/'));
    calls.push(url);
    if (fail && fail.test(url)) throw new Error(`gh: boom on ${url}`);
    if (url === 'graphql') return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: comments.map(node) } } } } };
    if (/\/pulls\/7$/.test(url)) return pull;
    if (/\/pulls\/7\/reviews/.test(url)) return [reviews];
    if (/\/pulls\/7\/commits/.test(url)) return [commits.map((sha) => ({ sha }))];
    if (/\/issues\/7\/comments/.test(url)) return [comments];
    // A paginated read (--paginate --slurp) gets every page as an array; a plain read gets page 1 only, as the real API does.
    if (/\/commits\/[^/]+\/status/.test(url)) return combinedPages ? (args.includes('--paginate') ? combinedPages : combinedPages[0]) : combined;
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { gh, calls };
}
const asked = { pr: 7, repo: 'o/n', head: HEAD, readyAt: READY_AT };

test('RC9: recheckPr reads the PR and lets a quiet PR through, asking for the status of the CURRENT head', async () => {
  const { gh, calls } = fakeGh();
  const r = await recheckPr(asked, gh);
  assert.deepEqual(r, { ok: true, refusals: [] });
  assert.ok(calls.some((u) => u.includes(`/commits/${HEAD}/status`)));
});

test('RC9b: recheckPr refuses when the head read now differs, and reads the status of that new head', async () => {
  const { gh, calls } = fakeGh({ pull: { head: { sha: MOVED } } });
  const r = await recheckPr(asked, gh);
  assert.equal(r.ok, false);
  assert.ok(calls.some((u) => u.includes(`/commits/${MOVED}/status`)));
});

for (const [n, fail] of [['10a', /\/pulls\/7$/], ['10b', /\/reviews/], ['10c', /\/issues\/7\/comments/], ['10d', /\/status/], ['10e', /^graphql$/]]) {
  test(`RC${n}: a read error on ${fail.source} refuses with the error (fail closed)`, async () => {
    const r = await recheckPr(asked, fakeGh({ fail }).gh);
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(' '), /could not re-read.*boom/i);
  });
}

test('RC10f: a pending CodeRabbit status on page 2 of the commit statuses refuses (the read must page)', async () => {
  const page1 = { total_count: 31, statuses: Array.from({ length: 30 }, (_, i) => status('success', `ci/${i}`)) };
  const page2 = { total_count: 31, statuses: [status('pending')] };
  const r = await recheckPr(asked, fakeGh({ combinedPages: [page1, page2] }).gh);
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /commit status.*pending/i);
});

test('RC10g: two pages of passing statuses still let a quiet PR through', async () => {
  const pages = [{ statuses: [status('success', 'ci/a')] }, { statuses: [status('success')] }];
  assert.deepEqual(await recheckPr(asked, fakeGh({ combinedPages: pages }).gh), { ok: true, refusals: [] });
});

// PR 211 as recheckPr reads it: request 13:42:03Z, summary edited by CodeRabbit only at 13:48:07Z, covers the head.
const asked211 = { ...asked, readyAt: T211.ready };
const sumBody211 = { body: COVERING(HEAD), created_at: T211.old };
const gh211 = (edits, gql) => {
  const { gh } = fakeGh({ reviews: [review(1, T211.old)], comments: [summary(T211.summary, sumBody211), request(T211.request)], edits });
  return gql ? (args) => gql(gh(args), args) : gh;
};

test('RC14e: recheckPr reads the comments with their edit history; the PR 211 trusted shape answers the request', async () => {
  assert.deepEqual(await recheckPr(asked211, gh211({ 900: [CR_EDIT] })), { ok: true, refusals: [] });
});

test('RC14f: recheckPr refuses when a person edited the summary (edit history from the GraphQL read)', async () => {
  const r = await recheckPr(asked211, gh211({ 900: [PERSON_EDIT, CR_EDIT] }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC14g: recheckPr refuses when the edit history cannot be paired (summary missing from the GraphQL read)', async () => {
  const dropNodes = (doc, args) => {
    if (args[0] === 'graphql') doc.data.repository.pullRequest.comments.nodes = [];
    return doc;
  };
  const r = await recheckPr(asked211, gh211({ 900: [CR_EDIT] }, dropNodes));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
});

test('RC15e: recheckPr reads the PR commit list and orders the rounds by it; an unreadable list refuses', async () => {
  const fake = fakeGh({ reviews: lateRounds(), comments: request1120(), commits: [OLDER, HEAD] });
  const r = await recheckPr(asked, fake.gh);
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(' '), /in flight/i);
  assert.ok(fake.calls.some((u) => /\/pulls\/7\/commits/.test(u)));
  const unreadable = await recheckPr(asked, fakeGh({ reviews: lateRounds(), comments: request1120(), fail: /\/pulls\/7\/commits/ }).gh);
  assert.match(unreadable.refusals.join(' '), /commit list/i);
});

test('RC15g: a failed or empty commit-list read refuses even with rounds on one commit (fail closed)', async () => {
  const failed = await recheckPr(asked, fakeGh({ fail: /\/pulls\/7\/commits/ }).gh);
  assert.equal(failed.ok, false);
  assert.match(failed.refusals.join(' '), /commit list is unreadable/);
  const empty = await recheckPr(asked, fakeGh({ commits: [] }).gh);
  assert.equal(empty.ok, false);
  assert.match(empty.refusals.join(' '), /commit list is empty/);
});

test('RC11: an unreadable READY time refuses', async () => {
  for (const readyAt of ['', 'yesterday', undefined]) {
    const r = await recheckPr({ ...asked, readyAt }, fakeGh().gh);
    assert.equal(r.ok, false, `readyAt=${readyAt}`);
  }
});

test('RC12: a payload with no head sha refuses instead of throwing', async () => {
  const r = await recheckPr(asked, fakeGh({ pull: {} }).gh);
  assert.equal(r.ok, false);
});

// ---- the command line ----

test('parseArgs reads the PR, head, READY time and repo', () => {
  const o = parseArgs(['7', '--head', HEAD, '--ready-at', READY_AT, '--repo', 'o/n']);
  assert.deepEqual(o, { pr: 7, head: HEAD, readyAt: READY_AT, repo: 'o/n' });
});

test('parseArgs rejects a missing PR, head or READY time and a bad repo', () => {
  assert.throws(() => parseArgs(['--head', HEAD, '--ready-at', READY_AT]));
  assert.throws(() => parseArgs(['7', '--ready-at', READY_AT]));
  assert.throws(() => parseArgs(['7', '--head', HEAD]));
  assert.throws(() => parseArgs(['7', '--head', HEAD, '--ready-at', READY_AT, '--repo', 'no-slash']));
});

test('RC13: bad arguments exit 2, never 0', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'land-recheck.mjs');
  const run = spawnSync(process.execPath, [script, '--head', HEAD], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /land-recheck/);
});
