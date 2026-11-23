// Tests for the merge-only head case of cr-paid.mjs and ship-ask.mjs (card coord-full-review-merge-head).
// Run: node --test scripts/github/cr-paid-merge-head.test.mjs
// No network: gh is an injected fake. The ledger, the decision store and the lock are real files in a temp folder.
//
// The case: the PR head only merges main over a commit that CodeRabbit reviewed (PR 685: head ee64c356 over 591b9928).
// CodeRabbit answers a plain or a paid review request there with "Already reviewed the last commit. Use @coderabbitai full review".
//
// How the unit can fail, and the test that catches it (written before the code):
//   a head with a real fix commit, a one-parent commit, no parents field, an empty list, a cut list or a head that is not
//   ahead of the reviewed commit is read as a merge-only head                                                       -> MH1, MH5
//   a merge-only round is priced on the compare list (about 0 files) and not on the whole PR                         -> MH2
//   a merge-only head with a big main delta is refused by the 30-line limit, or a cut compare (300 files) is exit 2  -> MH2, MH2b
//   the merge-only case lets a round through past the round, day or paid-round limits, or skips the author fix limits -> MH3, MH4
//   a normal head asks for the full form, or the plain paid text changed                                             -> MH6, MH8b
//   the post goes out with the old constant on a merge-only head, or the ledger row cannot tell a full round          -> MH7, MH8
//   a verdict from a stub with no comment posts nothing, or an old row gets a full key                                -> MH8b
//   a free slot on a merge-only head names no full review, or a normal head loses its old refusal text               -> MH9
//   a full request with the paid word is not seen as a paid request, or is not answered by a review                   -> MH10
//   the ship-ask question hides that the round is a full review, or a normal question changes                        -> MH11
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as PAID from './cr-paid.mjs';
import * as D from './lib/decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ship = await import(pathToFileURL(path.join(HERE, 'ship-ask.mjs')).href);

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const MAIN = 'd'.repeat(40);
const MERGE = 'e'.repeat(40);
const FIX = 'f'.repeat(40);
const NOW = new Date('2026-11-23T15:00:00Z');
const MIN = 60_000;
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const review = (id, commit_id, submitted_at) => ({ id, user: CR_BOT, commit_id, submitted_at, body: 'Actionable comments posted: 1' });
const human = (id, body, created_at) => ({ id, user: { login: 'dave', type: 'User' }, body, created_at, updated_at: created_at });
const prFile = (n, over = {}) => ({ filename: `src/f${n}.ts`, additions: 5, deletions: 0, status: 'modified', ...over });
const files = (count) => Array.from({ length: count }, (_, i) => prFile(i));
const gqlNode = (c) => ({ databaseId: c.id, body: c.body, author: { login: 'coderabbitai', __typename: 'Bot' }, lastEditedAt: null, updatedAt: c.updated_at, userContentEdits: { nodes: [] } });
const mergeCommit = (sha = MERGE) => ({ sha, parents: [{ sha: OLD }, { sha: MAIN }] });
const plainCommit = (sha = FIX) => ({ sha, parents: [{ sha: OLD }] });
/** A compare answer: the reviewed commit is behind the head by `commits`. */
const compareOf = (commits, over = {}) => ({ status: 'ahead', total_commits: commits.length, commits, files: [prFile(0, { additions: 150, deletions: 60 })], ...over });
const WAIT = { state: 'wait', nextSlotAt: new Date(NOW.getTime() + 20 * MIN).toISOString(), checkedAt: NOW.toISOString(), minutesToSlot: 20, source: 'notice' };
const FREE = { state: 'free', checkedAt: NOW.toISOString(), source: 'probe' };

/** One run's world: a fake gh with a compare answer, a temp ledger, a temp decision store and an injected clock. */
function world({ prFiles = files(6), comments = [], reviews = [review(1, OLD, '2026-11-23T08:00:00Z')], compare = compareOf([mergeCommit()]), prCommits = null, rows = [], capacity = WAIT, checkPr } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-merge-head-'));
  const ledgerPath = path.join(dir, 'state', 'coderabbit-paid.jsonl');
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  process.env.CCV3_DECISIONS_FILE = path.join(dir, 'decisions.json');
  const posts = [];
  const gh = (args) => {
    if (args.includes('POST')) { posts.push(args); return { id: 1 }; }
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: comments.filter((c) => c.user.type === 'Bot').map(gqlNode) } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return comments;
    if (args.some((a) => /compare\//.test(a))) return compare;
    if (args.some((a) => /pulls\/\d+\/files/.test(a))) return [prFiles];
    if (args.some((a) => /pulls\/\d+\/commits/.test(a))) return [prCommits ?? [{ sha: OLD }, ...ownOf(compare?.commits ?? [])]]; // default: every compare commit is the author's
    if (args.some((a) => /pulls\/\d+\/reviews/.test(a))) return [reviews];
    return { head: { sha: HEAD }, state: 'open', merged: false, draft: false };
  };
  if (rows.length > 0) writeRows(ledgerPath, rows);
  const deps = { gh, now: () => NOW, ledgerPath, pathFilters: () => [], env: {}, capacity: () => capacity, queue: null, lockWaitMs: 100, ...(checkPr ? { checkPr } : {}) };
  return {
    dir, deps, posts, ledgerPath,
    check: () => PAID.checkPr({ pr: 685, repo: REPO }, deps),
    post: () => PAID.postPaid({ pr: 685, repo: REPO }, deps),
    ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function writeRows(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}
const ledgerRow = (cost) => ({ ts: '2026-11-23T10:00:00.000Z', date: '2026-11-23', pr: 685, head: OLD, files: cost * 4, cost, session: 's', via: 'post' });
const yes = (usd) => assert.deepEqual(D.paidRoundWrite({ key: D.decisionKey({ pr: 685 }), head: HEAD, label: `Yes, pay up to $${usd}`, tapAt: new Date(NOW.getTime() - 5 * MIN).toISOString(), entry: 'cli' }), { ok: true });

/** The PR's own commit list (pulls/N/commits) for a list of compare commits: every one of them is the author's, as on a PR that has no main commits in the compare. */
const ownOf = (commits) => commits.map((c) => ({ sha: c.sha }));

test('MH1: mergeOnlyOf is true only for an ahead compare whose own commits since the review all have 2 or more parents', () => {
  const m = (commits, over) => PAID.mergeOnlyOf(compareOf(commits, over), ownOf(commits));
  assert.equal(m([mergeCommit()]), true);
  assert.equal(m([mergeCommit(), mergeCommit(MAIN)]), true, 'two merges');
  assert.equal(m([mergeCommit(), plainCommit()]), false, 'a real fix commit among the merges');
  assert.equal(m([plainCommit()]), false, 'a one-parent commit');
  assert.equal(m([{ sha: MERGE }]), false, 'no parents field: fail closed');
  assert.equal(m([{ sha: MERGE, parents: 2 }]), false, 'parents is not a list: fail closed');
  assert.equal(m([]), false, 'no commit');
  assert.equal(PAID.mergeOnlyOf({ status: 'ahead', files: [] }, ownOf([mergeCommit()])), false, 'no commits key');
  assert.equal(PAID.mergeOnlyOf(null, ownOf([mergeCommit()])), false);
  assert.equal(PAID.mergeOnlyOf(undefined, undefined), false);
});

test('MH1a: the real PR 685 shape: main commits brought in by the merge are not the author\'s; only the commits in the PR list count', () => {
  const mainCommits = ['1', '2', '3'].map((n) => ({ sha: n.repeat(40), parents: [{ sha: MAIN }] })); // single-parent commits that main already holds
  const compare = compareOf([...mainCommits, mergeCommit()]);
  assert.equal(PAID.mergeOnlyOf(compare, [{ sha: OLD }, { sha: MERGE }]), true, 'the only own commit since the review is the merge');
  assert.equal(PAID.mergeOnlyOf(compare, [{ sha: OLD }, { sha: MERGE }, { sha: mainCommits[0].sha }]), false, 'a single-parent commit that IS in the PR list is a real fix');
  assert.equal(PAID.mergeOnlyOf(compare, [{ sha: OLD }]), false, 'no own commit since the review: nothing merges');
  assert.equal(PAID.mergeOnlyOf(compare, []), false, 'an unreadable or too long PR list: fail closed');
  assert.equal(PAID.mergeOnlyOf(compare, undefined), false);
  assert.equal(PAID.mergeOnlyOf(compare, null), false);
});

test('MH1b: a compare that is not "ahead" is never merge-only (a reviewed commit that is not an ancestor of the head)', () => {
  for (const status of ['diverged', 'behind', 'identical', undefined, 'AHEAD', '']) {
    assert.equal(PAID.mergeOnlyOf(compareOf([mergeCommit()], { status }), ownOf([mergeCommit()])), false, `status ${String(status)}`);
  }
});

test('MH1c: a commit list cut by GitHub (total_commits above the list) is not merge-only: the unseen commits may be real fixes', () => {
  const own = ownOf([mergeCommit()]);
  assert.equal(PAID.mergeOnlyOf(compareOf([mergeCommit()], { total_commits: 251 }), own), false);
  assert.equal(PAID.mergeOnlyOf(compareOf([mergeCommit()], { total_commits: 1 }), own), true);
  assert.equal(PAID.mergeOnlyOf(compareOf([mergeCommit()], { total_commits: undefined }), own), true, 'no total: the list is all we have, and it is all merges');
});

test('MH2: a merge-only head is priced on every PR file, shows no author fix, and asks for the full form, whatever main changed', () => {
  const w = world({ prFiles: files(6), compare: compareOf([mergeCommit()], { files: [prFile(0, { additions: 150, deletions: 60 }), prFile(99, { status: 'added' })] }) });
  const r = w.check();
  assert.equal(r.verdict, 'ALLOW', JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.mergeOnly, true);
  assert.equal(r.round, 2);
  assert.equal(r.files, 6, 'billable files: the whole PR, not the compare list');
  assert.equal(r.total, 6);
  assert.equal(r.cost, 1.5);
  assert.deepEqual(r.fix, { lines: 0, added: 0 });
  assert.equal(r.comment, '@coderabbitai full review --use-credits');
  assert.equal(r.comment, PAID.FULL_PAID_COMMENT);
  w.done();
});

test('MH2a: the real PR 685 shape end to end: 9 main commits plus one merge in the compare, only the merge in the PR list -> a full review', () => {
  const mainCommits = Array.from({ length: 9 }, (_, i) => ({ sha: String(i + 1).repeat(40), parents: [{ sha: MAIN }] }));
  const w = world({ compare: compareOf([...mainCommits, mergeCommit()]), prCommits: [{ sha: OLD }, { sha: MERGE }] });
  const r = w.check();
  assert.equal(r.verdict, 'ALLOW', JSON.stringify(r));
  assert.equal(r.mergeOnly, true);
  assert.equal(r.comment, PAID.FULL_PAID_COMMENT);
  assert.equal(r.files, 6);
  const fix = world({ compare: compareOf([...mainCommits, mergeCommit(), plainCommit()], { files: [prFile(0, { additions: 40, deletions: 0 })] }), prCommits: [{ sha: OLD }, { sha: MERGE }, { sha: FIX }] });
  const f = fix.check();
  assert.equal(f.mergeOnly, false, 'the author pushed a real fix after the merge');
  assert.equal(f.exitCode, 3);
  w.done(); fix.done();
});

test('MH2b: a merge-only head whose compare lists 300 files (too long to size) is still a verdict, not exit 2', () => {
  const many = Array.from({ length: 300 }, (_, i) => prFile(1000 + i));
  const w = world({ compare: compareOf([mergeCommit()], { files: many }) });
  const r = w.check();
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.mergeOnly, true);
  w.done();
});

test('MH3: a head with a merge AND a real fix commit is not merge-only: the fix limits and the plain paid text stay', () => {
  const big = world({ compare: compareOf([mergeCommit(), plainCommit()], { files: [prFile(0, { additions: 35, deletions: 5 })] }) });
  const a = big.check();
  assert.equal(a.exitCode, 3);
  assert.equal(a.mergeOnly, false);
  assert.match(a.reasons.join('\n'), /fix is 40 lines, over 30/);
  assert.equal(a.comment, null);
  const small = world({ compare: compareOf([mergeCommit(), plainCommit()], { files: [prFile(0, { additions: 3, deletions: 2 })] }) });
  const b = small.check();
  assert.equal(b.exitCode, 0);
  assert.equal(b.mergeOnly, false);
  assert.equal(b.files, 1, 'a normal round 2 still bills the compare list');
  assert.equal(b.comment, '@coderabbitai review --use-credits');
  big.done(); small.done();
});

test('MH4: a merge-only head keeps the round, day and paid-round limits: $5.25 escalates, $10.25 today escalates, two paid rounds escalate', () => {
  const costly = world({ prFiles: files(21) });
  const a = costly.check();
  assert.equal(a.exitCode, 3);
  assert.equal(a.mergeOnly, true);
  assert.match(a.reasons.join('\n'), /round cost \$5\.25 is over \$5\.00/);
  assert.equal(a.comment, null);
  const day = world({ prFiles: files(20), rows: [ledgerRow(10.25)] });
  assert.match(day.check().reasons.join('\n'), /today \$10\.25 \+ round \$5\.00 is over \$15\.00/);
  const two = world({ rows: [ledgerRow(1), ledgerRow(1)] });
  const c = two.check();
  assert.equal(c.exitCode, 3);
  assert.match(c.reasons.join('\n'), /2 paid rounds on this PR/);
  costly.done(); day.done(); two.done();
});

test('MH5: a diverged compare makes the head a normal round-2 head: the compare list is billed and the plain text is posted', () => {
  const w = world({ compare: compareOf([mergeCommit()], { status: 'diverged', files: [prFile(0, { additions: 4, deletions: 1 })] }) });
  const r = w.check();
  assert.equal(r.mergeOnly, false);
  assert.equal(r.files, 1);
  assert.equal(r.comment, '@coderabbitai review --use-credits');
  w.done();
});

test('MH6: the two paid texts are exact and requestCommentOf picks by the flag; a round 1 head is never merge-only', () => {
  assert.equal(PAID.PAID_COMMENT, '@coderabbitai review --use-credits');
  assert.equal(PAID.FULL_PAID_COMMENT, '@coderabbitai full review --use-credits');
  assert.equal(PAID.requestCommentOf(true), PAID.FULL_PAID_COMMENT);
  assert.equal(PAID.requestCommentOf(false), PAID.PAID_COMMENT);
  assert.equal(PAID.requestCommentOf(undefined), PAID.PAID_COMMENT);
  const w = world({ reviews: [] });
  const r = w.check();
  assert.equal(r.round, 1);
  assert.equal(r.mergeOnly, false);
  assert.equal(r.comment, PAID.PAID_COMMENT);
  w.done();
});

test('MH7: post on a merge-only head sends the full form, records every PR file, and marks the ledger row full', () => {
  const w = world();
  yes('2.00');
  const r = w.post();
  assert.equal(r.ok, true, r.text);
  assert.equal(w.posts.length, 1);
  assert.ok(w.posts[0].includes('body=@coderabbitai full review --use-credits'), w.posts[0].join(' '));
  assert.equal(r.comment, PAID.FULL_PAID_COMMENT);
  const rows = w.ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, 'post');
  assert.equal(rows[0].files, 6);
  assert.equal(rows[0].full, true);
  w.done();
});

test('MH8: post on a normal head still sends the plain paid text and its row has no full key', () => {
  const w = world({ reviews: [] });
  yes('2.00');
  const r = w.post();
  assert.equal(r.ok, true, r.text);
  assert.ok(w.posts[0].includes('body=@coderabbitai review --use-credits'));
  assert.ok(!w.posts[0].includes('full review'));
  assert.equal('full' in w.ledger()[0], false);
  w.done();
});

test('MH8b: a verdict from a stub with no comment (the queue tests) still posts the plain paid text', () => {
  const checkPr = () => ({ verdict: 'ALLOW', head: HEAD, total: 4, files: 4, today: 0, paidRounds: 0, fix: null });
  const w = world({ reviews: [], checkPr });
  yes('1.00');
  const r = w.post();
  assert.equal(r.ok, true, r.text);
  assert.ok(w.posts[0].includes('body=@coderabbitai review --use-credits'));
  w.done();
});

test('MH9: a free slot refuses the paid post; on a merge-only head the refusal names the free full review, on a normal head it is unchanged', () => {
  const oldText = 'The CodeRabbit slot is free for PR #685. A free review costs nothing: use the free slot.';
  const merge = world({ capacity: FREE });
  yes('2.00');
  const a = merge.post();
  assert.equal(a.ok, false);
  assert.equal(a.code, 4);
  assert.ok(a.text.startsWith(oldText), a.text);
  assert.match(a.text, /@coderabbitai full review/);
  assert.doesNotMatch(a.text, /use-credits/, 'the free hint never names the paid word');
  assert.equal(merge.posts.length, 0);
  const normal = world({ capacity: FREE, reviews: [] });
  yes('2.00');
  const b = normal.post();
  assert.equal(b.text, oldText);
  merge.done(); normal.done();
});

test('MH10: a full request with the paid word is an open paid request until a review answers it, and the ledger count sees it', () => {
  const asked = human(11, '@coderabbitai full review --use-credits', '2026-11-23T12:00:00Z');
  const open = PAID.openPaidRequests({ comments: [asked], commentEdits: [], reviews: [], head: HEAD });
  assert.deepEqual(open.map((c) => c.id), [11]);
  const answered = PAID.openPaidRequests({ comments: [asked], commentEdits: [], reviews: [{ ...review(2, HEAD, '2026-11-23T12:10:00Z') }], head: HEAD });
  assert.deepEqual(answered, []);
  const w = world();
  assert.deepEqual(PAID.unledgeredPaidOf(685, HEAD, [asked], null, w.deps), [11]);
  w.done();
});

test('MH11: the paid-round question says the round is a full review of the whole PR; a normal question is unchanged', () => {
  const BASE = { pr: 685, round: 2, today: 0, paidRounds: 0, verdict: 'ALLOW', reasons: [], caps: { round: 5, day: 15, rounds: 2 }, files: 6, total: 6 };
  const merged = ship.paidRoundSpec({ ...BASE, mergeOnly: true, from: OLD, head: HEAD });
  assert.match(merged.question, /full review of 6 files/i);
  assert.ok(merged.question.includes(OLD.slice(0, 7)) && merged.question.includes(HEAD.slice(0, 7)), 'names both commits');
  const yesRow = merged.options.find((o) => /^Yes/.test(o.label));
  assert.equal(yesRow.label, 'Yes, pay up to $1.50');
  assert.ok(yesRow.description.includes(PAID.FULL_PAID_COMMENT), 'the option names the exact full text cr-paid posts');
  assert.match(yesRow.description, /cr-paid\.mjs post --pr 685/);
  const normal = ship.paidRoundSpec({ ...BASE });
  assert.doesNotMatch(normal.question, /full review/i);
  assert.ok(normal.options.find((o) => /^Yes/.test(o.label)).description.includes(PAID.PAID_COMMENT));
  assert.doesNotMatch(normal.options.find((o) => /^Yes/.test(o.label)).description, /full review/i);
});
