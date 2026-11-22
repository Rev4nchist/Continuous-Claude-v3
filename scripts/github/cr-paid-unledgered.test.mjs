// Tests for `cr-paid.mjs unledgered --pr N --json` and unledgeredPaidOf (paid guard PR 2: the 5-minute watch flags a paid comment with no ledger row).
// Run: node --test scripts/github/cr-paid-unledgered.test.mjs
// No network: gh is an injected fake. The paid ledger is a real file in a temp folder.
//
// The rule (aegis pass, F3): the paid comments of the PR (a person's "@coderabbitai review" with the paid word, deduped by comment id, sorted by id) beyond the
// number of ledger rows of that PR that `post` wrote (via: "post", all heads). The first N comments match the N rows; the rest are unledgered.
// A row of the `record` verb (via "manual") and an old row with no via never count. No date filter and no head commit date.
//
// How the flag can be wrong, and the test that catches it:
//   a paid comment with no ledger row is missed                                                                      -> UL1
//   a paid comment WITH a post row for this PR is flagged; a row for another PR hides it                              -> UL2, UL2b
//   a plain "@coderabbitai review" (no paid word) is flagged                                                         -> UL3
//   a second paid comment behind one post row is missed; the same comment twice is counted twice                      -> UL4
//   `record --files 0` (a manual row), or an old row with no via, silences the detection                              -> UL4b
//   the head commit date, which a model can move, still drops a comment                                               -> UL4c
//   a failed GitHub read, a bad head or a bad ledger throws, or exits non-zero, or flags                              -> UL5
//   the verb accepts a flag other than --pr and --json, or runs with no --pr                                         -> UL6
//   the queue and the verb use two copies of the rule                                                                -> UL7
//   the `record` verb writes a row that counts as a post                                                             -> UL8
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PAID from './cr-paid.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const NOW = new Date('2026-11-18T15:00:00Z');
const COMMITTED = '2026-11-18T12:00:00Z';
const PAID_WORD = '@coderabbitai review --use-credits';
const human = (id, body, created_at) => ({ id, user: { login: 'dave', type: 'User' }, body, created_at, updated_at: created_at });
const LATE = '2026-11-18T13:00:00Z';
const EARLY = '2026-11-18T11:00:00Z';

/** A fake gh: the pull, the head commit and the issue comments (no bot comments, so the GraphQL page is empty). */
function world({ comments = [], head = HEAD, down = false, headBody } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-unledgered-'));
  const ledgerPath = path.join(dir, 'coderabbit-paid.jsonl');
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (down) throw new Error('network down');
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return [comments];
    if (args.some((a) => /\/commits\/[0-9a-f]{40}$/.test(a))) return { commit: { committer: { date: COMMITTED } } };
    return headBody ?? { head: { sha: head }, state: 'open' };
  };
  const deps = { gh, now: () => NOW, ledgerPath, env: {} };
  return { dir, deps, ledgerPath, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const verb = (w, pr = 7) => PAID.unledgeredOf({ pr, repo: REPO }, w.deps);
/** A row the way `post` writes it. */
const postRow = (w, pr, head, files = 3) => PAID.recordPaid({ pr, head, files, via: 'post' }, w.deps);

test('UL1: a paid comment on the PR with no ledger row gives its id', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [41] });
  w.done();
});

test('UL2: one post row of this PR and one paid comment: nothing', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  postRow(w, 7, HEAD);
  assert.deepEqual(verb(w), { head: HEAD, ids: [] });
  w.done();
});

test('UL2b: a post row for another PR does not hide the comment; a post row of this PR on another head does (the count is per PR)', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  postRow(w, 8, HEAD);
  assert.deepEqual(verb(w), { head: HEAD, ids: [41] });
  postRow(w, 7, OLD);
  assert.deepEqual(verb(w), { head: HEAD, ids: [] });
  w.done();
});

test('UL3: a plain "@coderabbitai review" gives nothing', () => {
  const w = world({ comments: [human(41, '@coderabbitai review', LATE), human(42, 'please use credits for this', LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [] });
  w.done();
});

test('UL4: one post row and two paid comments give the second id (sorted by id); a comment listed twice counts once', () => {
  const w = world({ comments: [human(42, PAID_WORD, LATE), human(41, PAID_WORD, EARLY)] });
  postRow(w, 7, HEAD);
  assert.deepEqual(verb(w), { head: HEAD, ids: [42] });
  const twice = world({ comments: [human(41, PAID_WORD, LATE), human(41, PAID_WORD, LATE)] });
  postRow(twice, 7, HEAD);
  assert.deepEqual(verb(twice), { head: HEAD, ids: [] }, 'the same id twice is one comment');
  const two = world({ comments: [human(41, PAID_WORD, LATE), human(42, PAID_WORD, LATE)] });
  postRow(two, 7, HEAD);
  postRow(two, 7, OLD);
  assert.deepEqual(verb(two), { head: HEAD, ids: [] }, 'two post rows cover two comments');
  [w, twice, two].forEach((x) => x.done());
});

test('UL4b: a manual row (the record verb, even --files 0) and an old row with no via do not hide a paid comment', () => {
  const manual = world({ comments: [human(41, PAID_WORD, LATE)] });
  PAID.recordPaid({ pr: 7, head: HEAD, files: 0 }, manual.deps);
  assert.deepEqual(verb(manual), { head: HEAD, ids: [41] }, 'record --files 0 is no silence');
  const old = world({ comments: [human(41, PAID_WORD, LATE)] });
  // A row written before the via field existed: treated as manual, so it is flagged (this changes the reading of every row already in the ledger).
  appendFileSync(old.ledgerPath, `${JSON.stringify({ ts: NOW.toISOString(), date: '2026-11-18', pr: 7, head: HEAD, files: 3, cost: 0.75, session: 's' })}\n`);
  assert.deepEqual(verb(old), { head: HEAD, ids: [41] });
  const mixed = world({ comments: [human(41, PAID_WORD, LATE), human(42, PAID_WORD, LATE)] });
  PAID.recordPaid({ pr: 7, head: HEAD, files: 0 }, mixed.deps);
  postRow(mixed, 7, HEAD);
  assert.deepEqual(verb(mixed), { head: HEAD, ids: [42] }, 'only the post row counts');
  [manual, old, mixed].forEach((x) => x.done());
});

test('UL4c: the head commit date is not used: a paid comment made before it is still counted, and the commit is not read', () => {
  const w = world({ comments: [human(41, PAID_WORD, EARLY), human(42, PAID_WORD, LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [41, 42] });
  assert.ok(!w.calls.some((a) => a.some((x) => /\/commits\//.test(x))), 'no commits/<sha> read');
  w.done();
});

test('UL5: a failed read, a bad head and a bad ledger give { head: "", ids: [] } or no flag, and never throw', () => {
  const down = world({ comments: [human(41, PAID_WORD, LATE)], down: true });
  assert.deepEqual(verb(down), { head: '', ids: [] });
  const noHead = world({ comments: [human(41, PAID_WORD, LATE)], headBody: { head: { sha: 'zzz' } } });
  assert.deepEqual(verb(noHead), { head: '', ids: [] });
  const badLedger = world({ comments: [human(41, PAID_WORD, LATE)] });
  writeFileSync(badLedger.ledgerPath, 'not json\n');
  assert.deepEqual(verb(badLedger), { head: HEAD, ids: [] }, 'an unreadable ledger says nothing');
  [down, noHead, badLedger].forEach((x) => x.done());
});

test('UL6: the verb takes --pr N and --json only', () => {
  assert.deepEqual(PAID.parseArgs(['unledgered', '--pr', '7', '--json']).pr, 7);
  assert.equal(PAID.parseArgs(['unledgered', '--pr', '7']).cmd, 'unledgered');
  for (const argv of [
    ['unledgered'], ['unledgered', '--json'], ['unledgered', '--pr', '7', '--repo', 'a/b'], ['unledgered', '--pr', '7', '--head', HEAD],
    ['unledgered', '--pr', '7', '--files', '3'], ['unledgered', '--pr', '7', '--cap', '5'], ['unledgered', '--pr', '0'], ['unledgered', '--pr', '7', 'extra'],
  ]) assert.throws(() => PAID.parseArgs(argv), Error, argv.join(' '));
});

test('UL7: unledgeredPaidOf is the one rule the queue and the verb share: the fourth argument (the old head commit date) changes nothing', () => {
  const w = world();
  const comments = [human(41, PAID_WORD, EARLY), human(42, '@coderabbitai review', LATE)];
  assert.deepEqual(PAID.unledgeredPaidOf(7, HEAD, comments, undefined, w.deps), [41]);
  assert.deepEqual(PAID.unledgeredPaidOf(7, HEAD, comments, COMMITTED, w.deps), [41], 'a head commit date no longer drops a comment');
  postRow(w, 7, HEAD);
  assert.deepEqual(PAID.unledgeredPaidOf(7, HEAD, comments, COMMITTED, w.deps), []);
  w.done();
});

test('UL8: the `record` verb path writes via "manual"; recordPaid called by postPaid writes "post" (only code can ask for it)', () => {
  const w = world();
  assert.equal(PAID.recordPaid({ pr: 7, head: HEAD, files: 2 }, w.deps).via, 'manual');
  assert.equal(PAID.recordPaid({ pr: 7, head: HEAD, files: 2, via: 'post' }, w.deps).via, 'post');
  assert.throws(() => PAID.parseArgs(['record', '--pr', '7', '--head', HEAD, '--files', '2', '--via', 'post']), /unknown argument: --via/, 'the verb has no way to ask for via post');
  w.done();
});
