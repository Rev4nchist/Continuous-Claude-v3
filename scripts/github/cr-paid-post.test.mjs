// Tests for `cr-paid.mjs post --pr N` and postPaid (card prflow-paid-run-guard, PR 2, step c; MUST HOLD G2, G3, G3b, G3c, G4, G5, G7).
// Run: node --test scripts/github/cr-paid-post.test.mjs
// No network: gh is an injected fake. The paid ledger, the decision store and the lock are real files in a temp folder.
// Every call passes explicit deps (stub gh, temp ledger, injected clock), so no test reaches GitHub or the real state of this machine.
//
// How postPaid can fail, and the test that catches it:
//   a paid yes posts when it should not: tap too old, future, unreadable, no time; row for another head                -> PP2, PP2b
//   a headless or non-terminal tap pays: sdk, desktop, vscode, empty, missing entry; a row written by hand             -> PP3, PP3b
//   a label with no price pays; a failed GitHub read in step 1 uses the row up or exits with another code               -> PP4
//   a call that hangs past 120 s posts, or leaves the lock behind                                                      -> PP5
//   a cost over the cap posts; the cost is read from the filtered count; the row is kept after a refusal                -> PP6
//   a free slot pays                                                                                                   -> PP7
//   the post goes out before the round is recorded, or a failed post leaves the row usable (a second post)             -> PP8
//   an unanswered paid request, or a queue pay decision, does not stop a second post; a plain request wrongly stops it  -> PP9, PP10
//   ESCALATE posts                                                                                                     -> PP11
//   a second session posts while the first holds the lock                                                              -> PP12
//   `post` accepts --cap or --repo, or runs with no --pr                                                               -> PP13
//   the mod path (cap from --cap, no store row) posts without a cap or over it                                         -> PP14
//   the verb maps its results to the wrong exit code                                                                   -> PP15
//   a draft, closed or merged PR is paid for; the refusal comes after the free-slot step (a GitHub call is spent first) -> PP16, PP16b
//   a pull answer with no state, merged or draft field is read as an open PR instead of a failed read (exit 5)          -> PP16c
// Aegis pass (F1, F4, F3 part a, F9):
//   CCV3_DECISIONS_FILE moves the decision store, so a forged row in a scratch file pays; ANY non-empty override refuses (seat rule 11-22) -> PP17, PP17b
//   USERPROFILE or HOME moves the home, so the default store and the default ledger move with it (the limits read 0, a forged row reads) -> PP17c, PP17d, PP17e (cap run)
//   the cap path posts with no head, a bad head or a moved head (F6); a total below 1 or not a whole number prices a round at the filtered count (F4) -> PP14b, PP18c
//   path_filters (an uncommitted edit of .coderabbit.yaml) zero the filtered cost, so the round and day limits never bite       -> PP18, PP18b
//   a row written by `post` does not say so, so the detection cannot tell it from a hand-written `record` row                   -> PP19
//   a refusal ignores a failed use-up: exit 4 "used up" while the row stays and can pay later                                   -> PP20, PP20b
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PAID from './cr-paid.mjs';
import * as D from './lib/decisions.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const H2 = 'c'.repeat(40);
const NOW = new Date('2026-11-18T15:00:00Z');
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const MIN = 60_000;
const prFile = (n) => ({ filename: `src/f${n}.ts`, additions: 5, deletions: 0, status: 'modified' });
const files = (count) => Array.from({ length: count }, (_, i) => prFile(i));
const gqlNode = (c) => ({ databaseId: c.id, body: c.body, author: { login: 'coderabbitai', __typename: 'Bot' }, lastEditedAt: null, updatedAt: c.updated_at, userContentEdits: { nodes: [] } });
const human = (id, body, created_at) => ({ id, user: { login: 'dave', type: 'User' }, body, created_at, updated_at: created_at });
const WAIT = { state: 'wait', nextSlotAt: new Date(NOW.getTime() + 20 * MIN).toISOString(), checkedAt: NOW.toISOString(), minutesToSlot: 20, source: 'notice' };
const FREE = { state: 'free', checkedAt: NOW.toISOString(), source: 'probe' };

/** One run's world: a fake gh, a temp ledger, a temp decision store and an injected clock. */
function world({ prFiles = files(4), comments = [], reviews = [], filters = [], head = HEAD, ghDown = false, onCall = null, capacity = WAIT, queue = null, pull = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-post-'));
  const ledgerPath = path.join(dir, 'state', 'coderabbit-paid.jsonl');
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  process.env.CCV3_DECISIONS_FILE = path.join(dir, 'decisions.json');
  const clock = { ms: NOW.getTime() };
  const posts = [];
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (onCall) onCall(args, clock);
    if (args.includes('POST')) { posts.push(args); if (world.onPost) world.onPost(ledgerPath); return { id: 1 }; }
    if (ghDown) throw new Error('network down');
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: comments.filter((c) => c.user.type === 'Bot').map(gqlNode) } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return comments;
    if (args.some((a) => /pulls\/\d+\/files/.test(a))) return [prFiles];
    if (args.some((a) => /pulls\/\d+\/commits/.test(a))) return [[{ sha: head }]];
    if (args.some((a) => /pulls\/\d+\/reviews/.test(a))) return [reviews];
    // The pull answer. `pull` overrides a field; a value of undefined is a field the answer does not carry.
    return { head: { sha: head }, state: 'open', merged: false, draft: false, ...pull };
  };
  const deps = { gh, now: () => new Date(clock.ms), ledgerPath, pathFilters: () => filters, env: {}, capacity: () => capacity, queue, lockWaitMs: 100 };
  return { dir, deps, ledgerPath, posts, calls, clock, ledger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []), done: () => rmSync(dir, { recursive: true, force: true }) };
}
world.onPost = null;

const key = (pr = 225) => D.decisionKey({ pr });
const YES = (usd = '1.00') => `Yes, pay up to $${usd}`;
const ago = (min) => new Date(NOW.getTime() - min * MIN).toISOString();
/** Dave's paid yes as the confirm script or the paid-round tap leaves it. */
const yes = ({ head = HEAD, label = YES(), tapAt = ago(5), entry = 'cli', pr = 225 } = {}) => assert.deepEqual(D.paidRoundWrite({ key: key(pr), head, label, tapAt, entry }), { ok: true });
const row = (head = HEAD, pr = 225) => D.decisionRowRead({ step: 'paid-round', key: key(pr), head });
const post = (w, over = {}) => PAID.postPaid({ pr: 225, repo: REPO, ...over }, w.deps);

test('PP1 (G4): one paid yes is enough: post posts the paid comment, records the round, uses the row up, and asks nothing', () => {
  const w = world();
  yes();
  const r = post(w);
  assert.equal(r.ok, true, r.text);
  assert.equal(r.code, 0);
  assert.equal(w.posts.length, 1);
  assert.ok(w.posts[0].includes(`repos/${REPO}/issues/225/comments`));
  assert.ok(w.posts[0].includes('body=@coderabbitai review --use-credits'));
  assert.deepEqual(w.ledger().map((l) => [l.pr, l.head, l.files, l.cost]), [[225, HEAD, 4, 1]]);
  assert.equal(row(), null, 'the row is used up');
  assert.equal(post(w).ok, false, 'a second post needs a second yes');
  assert.equal(w.posts.length, 1);
  w.done();
});

test('PP2 (G2): a row for another head, and a tap over 60 minutes old (confirmed just now), post nothing', () => {
  const stale = world();
  yes({ head: H2 });
  const a = post(stale);
  assert.equal(a.ok, false);
  assert.equal(a.code, 4);
  assert.equal(a.text, `No paid yes of Dave's for PR #225 at ${HEAD.slice(0, 7)}.`);
  assert.equal(stale.posts.length, 0);
  const old = world();
  yes({ tapAt: ago(61) });
  const b = post(old);
  assert.equal(b.code, 4);
  assert.match(b.text, /Dave's tap for PR #225 is 61 minutes old; a paid yes lasts 60 minutes\. Ask again\./);
  assert.equal(old.posts.length, 0);
  assert.equal(row(), null, 'a refusal from step 2 on uses the row up');
  const edge = world();
  yes({ tapAt: ago(59) });
  assert.equal(post(edge).ok, true, 'a tap 59 minutes old still pays');
  [stale, old, edge].forEach((x) => x.done());
});

test('PP2b: a tapAt that is missing, does not parse, or is in the future is refused (the parsed time is compared)', () => {
  for (const [name, tapAt, want] of [
    ['unparsable', 'yesterday', /no readable tap time/],
    ['empty', '', /no readable tap time/],
    ['future', new Date(NOW.getTime() + 5 * MIN).toISOString(), /tap time in the future/],
  ]) {
    const w = world();
    // paidRoundWrite refuses a non-text tapAt, so these rows are written the way a bad writer would: straight into the store file.
    D.offerWrite({ step: 'paid-round', key: key(), head: HEAD, spec: { header: 'Paid round', question: 'q', options: [{ label: 'No', description: 'n' }, { label: YES(), description: 'y' }] } });
    D.decisionRecord({ step: 'paid-round', key: key(), head: HEAD, label: YES(), entry: 'cli' });
    const store = JSON.parse(readFileSync(process.env.CCV3_DECISIONS_FILE, 'utf8'));
    for (const r of Object.values(store.decisions)) r.tapAt = tapAt === '' ? undefined : tapAt;
    writeFileSync(process.env.CCV3_DECISIONS_FILE, JSON.stringify(store));
    const r = post(w);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 4, name);
    assert.match(r.text, want, name);
    assert.equal(w.posts.length, 0, name);
    w.done();
  }
  const none = world();
  D.offerWrite({ step: 'paid-round', key: key(), head: HEAD, spec: { header: 'Paid round', question: 'q', options: [{ label: 'No', description: 'n' }, { label: YES(), description: 'y' }] } });
  D.decisionRecord({ step: 'paid-round', key: key(), head: HEAD, label: YES(), entry: 'cli' });
  const store = JSON.parse(readFileSync(process.env.CCV3_DECISIONS_FILE, 'utf8'));
  for (const r of Object.values(store.decisions)) delete r.tapAt;
  writeFileSync(process.env.CCV3_DECISIONS_FILE, JSON.stringify(store));
  const r = post(none);
  assert.equal(r.code, 4);
  assert.match(r.text, /no readable tap time/, 'a row with no tapAt is refused');
  none.done();
});

test('PP3 (G3): only entry cli pays: sdk, desktop, vscode, an empty or a missing stamp are refused, and the text names the value', () => {
  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py', 'sdk', 'claude-desktop', 'claude-vscode', 'cli-x', 'CLI', 'mcp']) {
    const w = world();
    yes({ entry });
    const r = post(w);
    assert.equal(r.ok, false, entry);
    assert.equal(r.code, 4, entry);
    assert.equal(r.text, `The paid yes for PR #225 was tapped in "${entry}". A paid tap works from the terminal or the phone through Remote Control.`, entry);
    assert.equal(w.posts.length, 0, entry);
    assert.equal(row(), null, `${entry}: the row is used up`);
    w.done();
  }
  const ok = world();
  yes({ entry: 'cli' });
  assert.equal(post(ok).ok, true, 'cli pays');
  ok.done();
});

test('PP3b (G3): a row with no stamp, an empty stamp, or written by hand (no stamp, no tapAt) is refused', () => {
  for (const [name, patch] of [['no entry', { entry: undefined }], ['empty entry', { entry: '' }], ['by hand', { entry: undefined, tapAt: undefined }]]) {
    const w = world();
    yes();
    const store = JSON.parse(readFileSync(process.env.CCV3_DECISIONS_FILE, 'utf8'));
    for (const r of Object.values(store.decisions)) Object.assign(r, patch);
    writeFileSync(process.env.CCV3_DECISIONS_FILE, JSON.stringify(store));
    const r = post(w);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 4, name);
    assert.match(r.text, /(has no entry point stamp|no readable tap time)/, name);
    assert.match(r.text, name === 'by hand' ? /no readable tap time|no entry point stamp/ : /through Remote Control|entry point stamp/, name);
    assert.equal(w.posts.length, 0, name);
    w.done();
  }
  const w = world();
  yes();
  const store = JSON.parse(readFileSync(process.env.CCV3_DECISIONS_FILE, 'utf8'));
  for (const r of Object.values(store.decisions)) delete r.entry;
  writeFileSync(process.env.CCV3_DECISIONS_FILE, JSON.stringify(store));
  assert.equal(post(w).text, 'The paid yes for PR #225 has no entry point stamp. A paid tap works from the terminal or the phone through Remote Control.');
  w.done();
});

test('PP4 (G3b): a tapped label with no price is no yes; a failed GitHub read in step 1 keeps the row and exits 5', () => {
  const w = world();
  // A row can only hold a priced label (paidRoundWrite), so the free label comes from a ship-ask tap on a "No" row.
  D.offerWrite({ step: 'paid-round', key: key(), head: HEAD, spec: { header: 'Paid round', question: 'q', options: [{ label: 'No, keep it free (Recommended)', description: 'n' }, { label: YES(), description: 'y' }] } });
  D.decisionRecord({ step: 'paid-round', key: key(), head: HEAD, label: 'No, keep it free (Recommended)', entry: 'cli' });
  const r = post(w);
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.text, /names no price/);
  assert.equal(w.posts.length, 0);
  assert.equal(row(), null, 'used up');
  const down = world({ ghDown: true });
  yes();
  const d = post(down);
  assert.equal(d.code, 5);
  assert.equal(d.text, 'Could not read PR #225 from GitHub (network down). Nothing was posted. The paid yes is kept; run it again.');
  assert.ok(row(), 'the row is kept');
  assert.equal(down.posts.length, 0);
  assert.deepEqual(down.ledger(), []);
  [w, down].forEach((x) => x.done());
});

test('PP5 (G3c): a call that hangs past the 120 s deadline refuses, posts nothing, and leaves no lock behind', () => {
  const w = world({ onCall: (args, clock) => { if (args.some((a) => /pulls\/\d+$/.test(a))) clock.ms += 130_000; } });
  yes({ tapAt: ago(1) });
  const r = post(w);
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.text, /120 s/);
  assert.equal(w.posts.length, 0);
  assert.deepEqual(w.ledger(), [], 'no round was recorded');
  assert.ok(!existsSync(`${w.ledgerPath}.lock`), 'the lock is released');
  w.done();
});

test('PP6 (G5): a cost over the cap refuses and uses the row up; the cost reads the UNFILTERED file count', () => {
  const over = world({ prFiles: files(4) });
  yes({ label: YES('0.75') });
  const r = post(over);
  assert.equal(r.code, 4);
  assert.equal(r.text, 'The cost is $1.00, over the $0.75 Dave tapped. Ask again.');
  assert.equal(over.posts.length, 0);
  assert.equal(row(), null, 'used up');
  assert.deepEqual(over.ledger(), []);
  // path_filters exclude 2 of the 4 files: checkPr bills 2 ($0.50), the unfiltered count is 4 ($1.00).
  const filtered = world({ prFiles: files(4), filters: ['!src/f0.ts', '!src/f1.ts'] });
  yes({ label: YES('0.75') });
  const f = post(filtered);
  assert.equal(f.code, 4, 'the filtered count would have passed');
  assert.match(f.text, /The cost is \$1\.00, over the \$0\.75/);
  const exact = world({ prFiles: files(4), filters: ['!src/f0.ts', '!src/f1.ts'] });
  yes({ label: YES('1.00') });
  assert.equal(post(exact).ok, true, 'a cap of exactly the cost pays');
  [over, filtered, exact].forEach((x) => x.done());
});

test('PP7 (G5): a free CodeRabbit slot refuses (a free review needs no money) and uses the row up', () => {
  const w = world({ capacity: FREE });
  yes();
  const r = post(w);
  assert.equal(r.code, 4);
  assert.match(r.text, /The CodeRabbit slot is free for PR #225/);
  assert.equal(w.posts.length, 0);
  assert.equal(row(), null);
  w.done();
});

test('PP8 (G7): the round is recorded BEFORE the post; a failed post leaves the round counted, the row used and no second post', () => {
  const w = world();
  yes();
  let seen = null;
  world.onPost = (ledgerPath) => { seen = readFileSync(ledgerPath, 'utf8'); };
  const ok = post(w);
  world.onPost = null;
  assert.equal(ok.ok, true);
  assert.ok(seen && seen.includes(`"head":"${HEAD}"`), 'the ledger row was on disk when the post ran');
  const bad = world();
  yes();
  const failing = { ...bad.deps, gh: (args) => { if (args.includes('POST')) throw new Error('502 bad gateway'); return bad.deps.gh(args); } };
  const r = PAID.postPaid({ pr: 225, repo: REPO }, failing);
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.text, /The paid post failed \(502 bad gateway\)\. The round is counted\. Ask Dave again\./);
  assert.equal(bad.ledger().length, 1, 'the round stays counted');
  assert.equal(row(), null);
  assert.equal(PAID.postPaid({ pr: 225, repo: REPO }, failing).ok, false, 'no second post without a second yes');
  [w, bad].forEach((x) => x.done());
});

test('PP9: an unanswered PAID request on the head refuses; a plain request, or a paid one that a review answered, does not', () => {
  const open = world({ comments: [human(1, '@coderabbitai review --use-credits', ago(10))] });
  yes();
  const r = post(open);
  assert.equal(r.code, 4);
  assert.match(r.text, /unanswered paid request/);
  assert.equal(open.posts.length, 0);
  const plain = world({ comments: [human(2, '@coderabbitai review', ago(10))] });
  yes();
  assert.equal(post(plain).ok, true, 'a rate-limited plain request must not block the paid round');
  [open, plain].forEach((x) => x.done());
  // The pure rule (the land-recheck logic, limited to requests with the paid word): a review after the request answers it.
  const paidAsk = human(3, '@coderabbitai review --use-credits', ago(30));
  const review = { id: 9, user: CR_BOT, commit_id: 'd'.repeat(40), submitted_at: ago(20), body: 'Actionable comments posted: 1' };
  assert.equal(PAID.openPaidRequests({ comments: [paidAsk], commentEdits: [], reviews: [review], head: HEAD }).length, 0, 'a later review answers it');
  assert.equal(PAID.openPaidRequests({ comments: [paidAsk], commentEdits: [], reviews: [{ ...review, submitted_at: ago(40) }], head: HEAD }).length, 1, 'an older review does not');
  assert.equal(PAID.openPaidRequests({ comments: [paidAsk], commentEdits: [], reviews: [{ ...review, body: '' }], head: HEAD }).length, 1, 'a thread reply (empty body) answers nothing');
  for (const word of ['--use_credits', '--USE-CREDITS', '--use credits']) {
    assert.equal(PAID.openPaidRequests({ comments: [human(4, `@CodeRabbitAI review ${word}`, ago(5))], commentEdits: [], reviews: [], head: HEAD }).length, 1, word);
  }
});

test('PP10: the queue holding a pay decision for the head refuses', () => {
  const w = world({ queue: { holdsPay: (pr, head) => pr === 225 && head === HEAD } });
  yes();
  const r = post(w);
  assert.equal(r.code, 4);
  assert.match(r.text, /free-slot queue already holds a paid decision for PR #225/);
  assert.equal(w.posts.length, 0);
  w.done();
});

test('PP11: ESCALATE (21 files = $5.25) refuses, posts nothing and uses the row up', () => {
  const w = world({ prFiles: files(21) });
  yes({ label: YES('9.00') });
  const r = post(w);
  assert.equal(r.code, 4);
  assert.equal(r.kind, 'escalate');
  assert.match(r.text, /cr-paid says ESCALATE for PR #225: round cost \$5\.25 is over \$5\.00/);
  assert.equal(w.posts.length, 0);
  assert.equal(row(), null);
  w.done();
});

test('PP12 (G7): a second session cannot post while the lock is held: exit 5, nothing posted, the row kept', () => {
  const w = world();
  yes();
  writeFileSync(`${w.ledgerPath}.lock`, `${process.pid} held-by-the-first-session`);
  const r = post(w);
  assert.equal(r.code, 5);
  assert.match(r.text, /another paid post is running/i);
  assert.equal(w.posts.length, 0);
  assert.ok(row(), 'the row is kept');
  rmSync(`${w.ledgerPath}.lock`);
  assert.equal(post(w).ok, true);
  w.done();
});

test('PP13: `post` takes --pr and nothing else: a cap comes from Dave\'s tap, never from a flag', () => {
  assert.deepEqual(PAID.parseArgs(['post', '--pr', '12']).pr, 12);
  for (const bad of [['post', '--pr', '12', '--cap', '5'], ['post', '--pr', '12', '--repo', 'a/b'], ['post', '--pr', '12', '--head', HEAD], ['post', '--pr', '12', '--files', '4'], ['post', '--pr', '12', '--json'], ['post']]) {
    assert.throws(() => PAID.parseArgs(bad), /post takes --pr N only|--pr needs a whole number/, bad.join(' '));
  }
});

test('PP14: the mod path: a cap from --cap (cents) posts with no store row; no cap, or a cap under the cost, refuses', () => {
  const w = world();
  const r = post(w, { cap: 100, source: 'cap', head: HEAD });
  assert.equal(r.ok, true, r.text);
  assert.equal(w.posts.length, 1);
  const none = world();
  const a = post(none, { cap: null, source: 'cap', head: HEAD });
  assert.equal(a.code, 4);
  assert.equal(a.text, `No paid yes of Dave's for PR #225 at ${HEAD.slice(0, 7)}.`);
  const low = world();
  const b = post(low, { cap: 99, source: 'cap', head: HEAD });
  assert.equal(b.code, 4);
  assert.equal(b.text, 'The cost is $1.00, over the $0.99 Dave tapped. Ask again.');
  [w, none, low].forEach((x) => x.done());
});

test('PP14b (F6): the cap path needs the PR head Dave saw: none, a short, an upper-case or a moved head refuses (exit 4), posts nothing, reads nothing for the missing forms', () => {
  for (const head of [undefined, null, '', 'abc1234', 'A'.repeat(40)]) {
    const w = world();
    const r = post(w, { cap: 100, source: 'cap', head });
    assert.equal(r.ok, false, String(head));
    assert.equal(r.code, 4, String(head));
    assert.match(r.text, /needs the PR head Dave saw with the price/, String(head));
    assert.equal(w.posts.length, 0, String(head));
    assert.equal(w.calls.length, 0, `${String(head)}: refused before any GitHub call`);
    assert.deepEqual(w.ledger(), []);
    w.done();
  }
  const moved = world({ head: H2 });
  const m = post(moved, { cap: 100, source: 'cap', head: HEAD });
  assert.equal(m.code, 4);
  assert.match(m.text, /head of PR #225 moved from aaaaaaa to ccccccc after Dave saw the price/);
  assert.equal(moved.posts.length, 0);
  moved.done();
});

test('PP15: the verb maps results to exit codes: 0 posted, 4 a refusal, 5 a failed read or a busy lock; text on stderr for a refusal', () => {
  const run = (result) => PAID.runPostVerb(['post', '--pr', '225'], { post: () => result });
  assert.deepEqual(run({ ok: true, code: 0, text: 'Posted.' }), { code: 0, out: ['Posted.'], err: [] });
  assert.deepEqual(run({ ok: false, code: 4, text: 'No.' }), { code: 4, out: [], err: ['cr-paid: refused: No.'] });
  assert.deepEqual(run({ ok: false, code: 5, text: 'Down.' }), { code: 5, out: [], err: ['cr-paid: Down.'] });
  assert.equal(PAID.runPostVerb(['post', '--pr', '12', '--cap', '5'], { post: () => { throw new Error('must not run'); } }).code, 2);
});

test('PP16: a draft, closed or merged PR refuses (exit 4), posts nothing, records nothing and uses the yes up; the refusal comes before the free-slot step', () => {
  for (const [word, pull] of [
    ['a draft', { draft: true }],
    ['closed', { state: 'closed' }],
    ['merged', { state: 'closed', merged: true }],
    ['merged', { merged: true }],
    ['closed', { state: 'closed', draft: true }],
  ]) {
    // capacity FREE: were the check after the free-slot step, the text would name the free slot instead.
    const w = world({ pull, capacity: FREE });
    yes();
    const r = post(w);
    const name = JSON.stringify(pull);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 4, name);
    assert.equal(r.text, `PR #225 is ${word}. A paid review goes only to an open PR that is not a draft. Nothing was posted.`, name);
    assert.equal(w.posts.length, 0, name);
    assert.deepEqual(w.ledger(), [], name);
    assert.equal(row(), null, `${name}: the yes is used up`);
    assert.equal(w.calls.length, 1, `${name}: only the step 1 read was spent`);
    w.done();
  }
});

test('PP16b: an open PR that is not a draft still posts, and the same PR as a draft does not (the yes is not kept for a retry)', () => {
  const ok = world({ pull: { state: 'open', merged: false, draft: false } });
  yes();
  assert.equal(post(ok).ok, true);
  assert.equal(ok.posts.length, 1);
  const draft = world({ pull: { draft: true } });
  yes();
  assert.equal(post(draft).code, 4);
  assert.equal(post(draft).code, 4, 'a second try has no yes');
  assert.equal(draft.posts.length, 0);
  [ok, draft].forEach((x) => x.done());
});

test('PP16c: a pull answer with no state, merged or draft field, or a value of the wrong type, is a failed read (exit 5, the yes kept), never an open PR', () => {
  for (const pull of [{ state: undefined }, { merged: undefined }, { draft: undefined }, { state: 'OPEN' }, { draft: 'false' }, { merged: null }]) {
    const w = world({ pull });
    yes();
    const r = post(w);
    const name = JSON.stringify(pull);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 5, name);
    assert.match(r.text, /^Could not read PR #225 from GitHub \(.+\)\. Nothing was posted\. The paid yes is kept; run it again\.$/, name);
    assert.equal(w.posts.length, 0, name);
    assert.deepEqual(w.ledger(), [], name);
    assert.ok(row(), `${name}: the yes is kept`);
    w.done();
  }
});

const STORE_MOVED = 'The decision store path is overridden by CCV3_DECISIONS_FILE. A paid post reads Dave\'s tap from the real store only. Nothing was posted. The paid yes is kept.';
const PAID_WORD = '@coderabbitai review --use-credits';

test('PP17 (F1): CCV3_DECISIONS_FILE naming another store refuses with exit 5: nothing posted, nothing read from GitHub, the row stays', () => {
  const w = world();
  yes(); // a valid stamped row in the scratch store (world() put the temp store at CCV3_DECISIONS_FILE)
  const scratch = process.env.CCV3_DECISIONS_FILE;
  // The real run: deps.env is process.env. Here deps.env carries the override the way the model's one command would.
  const r = PAID.postPaid({ pr: 225, repo: REPO }, { ...w.deps, env: { CCV3_DECISIONS_FILE: scratch } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.equal(r.text, STORE_MOVED);
  assert.equal(w.posts.length, 0);
  assert.deepEqual(w.ledger(), []);
  assert.equal(w.calls.length, 0, 'refused before any GitHub call');
  assert.ok(row(), 'the row is untouched');
  // PP1 control: the same row, no override in the run env, posts.
  assert.equal(post(w).ok, true, 'without the override the same row posts');
  assert.equal(w.posts.length, 1);
  w.done();
});

test('PP17b (F1, seat rule 2026-11-22): ANY non-empty CCV3_DECISIONS_FILE in the run env refuses with exit 5, whatever its spelling, even a spelling of the real store; an empty value is no override', () => {
  const real = D.decisionsPath({});
  const up = `${path.dirname(real)}${path.sep}..${path.sep}${path.basename(path.dirname(real))}${path.sep}${path.basename(real)}`;
  const spellings = [up, real, `${real}:x`, 'relative-decisions.json', ...(process.platform === 'win32' ? [real.toUpperCase()] : [])];
  for (const spelling of spellings) {
    const w = world();
    yes();
    const r = PAID.postPaid({ pr: 225, repo: REPO }, { ...w.deps, env: { CCV3_DECISIONS_FILE: spelling } });
    assert.equal(r.ok, false, spelling);
    assert.equal(r.code, 5, spelling);
    assert.equal(r.text, STORE_MOVED, spelling);
    assert.equal(w.posts.length, 0, spelling);
    assert.equal(w.calls.length, 0, `${spelling}: refused before any GitHub call`);
    assert.ok(row(), `${spelling}: the yes is kept`);
    w.done();
  }
  const empty = world();
  yes();
  assert.equal(PAID.postPaid({ pr: 225, repo: REPO }, { ...empty.deps, env: { CCV3_DECISIONS_FILE: '' } }).ok, true, 'an empty override is no override');
  empty.done();
});

/** Runs fn with the home variables of this process pointed at a scratch folder, then restores them. */
function withMovedHome(fn) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-home-'));
  const keep = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = scratch;
  process.env.HOME = scratch;
  try { return fn(scratch); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('PP17c (F1/F3, seat rule): a home moved by USERPROFILE or HOME refuses a row run with exit 5, loud, before any GitHub call; the yes is kept', () => {
  const w = world();
  yes();
  const r = withMovedHome(() => post(w));
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.match(r.text, /home folder .* OS account record/);
  assert.equal(w.posts.length, 0);
  assert.equal(w.calls.length, 0, 'refused before any GitHub call');
  assert.deepEqual(w.ledger(), []);
  assert.ok(row(), 'the yes is kept');
  assert.equal(post(w).ok, true, 'control: with the home in place the same row posts');
  w.done();
});

test('PP17e (F3, seat read 11-22): a home moved by HOME or USERPROFILE also refuses a CAP run (the queue path) with exit 5: nothing read, nothing posted, no ledger row; the same run with the home in place posts', () => {
  const w = world();
  const r = withMovedHome(() => post(w, { cap: 100, source: 'cap', head: HEAD }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.match(r.text, /home folder .* OS account record/);
  assert.equal(w.posts.length, 0);
  assert.equal(w.calls.length, 0, 'refused before any GitHub call');
  assert.deepEqual(w.ledger(), []);
  assert.equal(post(w, { cap: 100, source: 'cap', head: HEAD }).ok, true, 'control: with the home in place the cap run posts');
  w.done();
});

test('PP17d (F1/F3, seat rule): the default decision store and the default paid ledger come from the OS account home, never from an environment variable', () => {
  const account = os.userInfo().homedir;
  const storeAt = path.join(account, '.claude', 'state', 'ccv3-mods', 'decisions.json');
  const ledgerAt = path.join(account, '.claude', 'state', 'coderabbit-paid.jsonl');
  const inPlace = { store: D.decisionsPath({}), ledger: PAID.defaultLedgerPath() };
  assert.deepEqual(inPlace, { store: storeAt, ledger: ledgerAt }, 'with the home in place');
  const moved = withMovedHome(() => ({ store: D.decisionsPath({}), ledger: PAID.defaultLedgerPath() }));
  assert.deepEqual(moved, { store: storeAt, ledger: ledgerAt }, 'a moved home changes neither path');
});

test('PP18 (F4): path_filters that zero the filtered cost cannot lift the round limit: 30 files = $7.50 unfiltered refuses (exit 4, the yes is used up)', () => {
  const all = files(30);
  const w = world({ prFiles: all, filters: all.map((f) => `!${f.filename}`) });
  yes({ label: YES('9.00') });
  const r = post(w);
  assert.equal(r.ok, false, 'filtered cost 0 must not allow a $7.50 round');
  assert.equal(r.code, 4);
  assert.equal(r.kind, 'escalate');
  assert.match(r.text, /cr-paid says ESCALATE for PR #225: round cost \$7\.50 is over \$5\.00\. No paid post\./);
  assert.equal(w.posts.length, 0);
  assert.deepEqual(w.ledger(), []);
  assert.equal(row(), null, 'the yes is used up');
  // Control: exactly the limit ($5.00 = 20 files) still posts with the same filters.
  const edge = files(20);
  const ok = world({ prFiles: edge, filters: edge.map((f) => `!${f.filename}`) });
  yes({ label: YES('9.00') });
  assert.equal(post(ok).ok, true, 'a $5.00 round is within the limit');
  [w, ok].forEach((x) => x.done());
});

test('PP18b (F4): the day limit also reads the unfiltered cost: $14.00 paid today + an $2.00 unfiltered round (filtered to $0) refuses', () => {
  const all = files(8);
  const w = world({ prFiles: all, filters: all.map((f) => `!${f.filename}`) });
  PAID.recordPaid({ pr: 12, head: H2, files: 56 }, w.deps); // $14.00 today (NOW is 2026-11-18 09:00 Chicago)
  yes({ label: YES('9.00') });
  const r = post(w);
  assert.equal(r.ok, false);
  assert.equal(r.code, 4);
  assert.match(r.text, /today \$14\.00 \+ round \$2\.00 is over \$15\.00/);
  assert.equal(w.posts.length, 0);
  assert.equal(w.ledger().length, 1, 'only the earlier $14.00 row');
  assert.equal(row(), null);
  w.done();
});

test('PP18c (F4): a check whose unfiltered total is below 1, not a whole number or missing refuses (exit 4): no fall back to the filtered count, no free round', () => {
  for (const total of [0, -1, 2.5, '4', null, undefined]) {
    const w = world();
    const checkPr = () => ({ verdict: 'ALLOW', pr: 225, head: HEAD, round: 1, files: 4, total, today: 0, paidRounds: 0, reasons: [] });
    const r = PAID.postPaid({ pr: 225, repo: REPO, cap: 9900, source: 'cap', head: HEAD }, { ...w.deps, checkPr });
    assert.equal(r.ok, false, String(total));
    assert.equal(r.code, 4, String(total));
    assert.match(r.text, /no usable file count for PR #225/, String(total));
    assert.equal(w.posts.length, 0, String(total));
    assert.deepEqual(w.ledger(), [], String(total));
    w.done();
  }
});

test('PP19 (F3 part a): the row `post` writes carries via "post"', () => {
  const w = world();
  yes();
  assert.equal(post(w).ok, true);
  assert.deepEqual(w.ledger().map((l) => l.via), ['post']);
  w.done();
});

/** Rewrites the stored paid row while the checks run, the way a newer tap or a second session would. */
const storeEdit = (mutate) => () => {
  const file = process.env.CCV3_DECISIONS_FILE;
  const store = JSON.parse(readFileSync(file, 'utf8'));
  mutate(store);
  writeFileSync(file, JSON.stringify(store));
};
const atReviews = (edit) => (args) => { if (args.some((a) => /pulls\/\d+\/reviews/.test(a))) edit(); };
const newerTap = storeEdit((s) => { for (const r of Object.values(s.decisions)) r.at = new Date(NOW.getTime() + 1000).toISOString(); });
const rowGone = storeEdit((s) => { s.decisions = {}; });

test('PP20 (F9): a refusal whose use-up fails is exit 5 "could not be used up", not exit 4 "used up"; the refusal text is kept in `refusal`', () => {
  for (const [name, edit, reason] of [['newer tap of the same label', newerTap, 'tap-changed'], ['row gone', rowGone, 'no-decision']]) {
    const w = world({ comments: [human(1, PAID_WORD, ago(10))], onCall: atReviews(edit) });
    yes();
    const r = post(w);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 5, name);
    assert.equal(r.text, `The paid yes could not be used up (${reason}). Nothing was posted. Run it again.`, name);
    assert.match(r.refusal, /unanswered paid request/, `${name}: the refusal text is kept`);
    assert.equal(w.posts.length, 0, name);
    assert.deepEqual(w.ledger(), [], name);
    w.done();
  }
  const kept = world({ comments: [human(1, PAID_WORD, ago(10))], onCall: atReviews(newerTap) });
  yes();
  post(kept);
  assert.ok(row(), 'a store that could not be written keeps the row (the code says so: exit 5, run it again)');
  kept.done();
});

test('PP20b (F9): the use-up before the post (step 7) that fails is also exit 5, posts nothing and records nothing', () => {
  const w = world({ onCall: atReviews(newerTap) });
  yes();
  const r = post(w);
  assert.equal(r.code, 5);
  assert.equal(r.text, 'The paid yes could not be used up (tap-changed). Nothing was posted. Run it again.');
  assert.equal(w.posts.length, 0);
  assert.deepEqual(w.ledger(), []);
  w.done();
});

test('PP20c (F9): a decision store that is locked (busy, PP12 style) fails the use-up: exit 5 (reason lock), the row stays, the refusal text is kept (waits about 5 s: the store lock has no injectable wait)', () => {
  const w = world({ pull: { draft: true } });
  yes();
  writeFileSync(`${process.env.CCV3_DECISIONS_FILE}.lock`, `${process.pid} held-by-another-writer`);
  const r = post(w);
  rmSync(`${process.env.CCV3_DECISIONS_FILE}.lock`, { force: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.equal(r.text, 'The paid yes could not be used up (lock). Nothing was posted. Run it again.');
  assert.match(r.refusal, /PR #225 is a draft/);
  assert.equal(w.posts.length, 0);
  assert.ok(row(), 'the row is kept');
  assert.equal(post(w).code, 4, 'run again with the store free: the draft refusal uses the row up (exit 4)');
  assert.equal(row(), null);
  w.done();
});
