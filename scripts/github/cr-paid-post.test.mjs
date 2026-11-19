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
function world({ prFiles = files(4), comments = [], reviews = [], filters = [], head = HEAD, ghDown = false, onCall = null, capacity = WAIT, queue = null } = {}) {
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
    return { head: { sha: head }, state: 'open' };
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
    ['future', new Date(NOW.getTime() + 5 * MIN).toISOString(), /tap time is in the future/],
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
  const r = post(w, { cap: 100, source: 'cap' });
  assert.equal(r.ok, true, r.text);
  assert.equal(w.posts.length, 1);
  const none = world();
  const a = post(none, { cap: null, source: 'cap' });
  assert.equal(a.code, 4);
  assert.equal(a.text, `No paid yes of Dave's for PR #225 at ${HEAD.slice(0, 7)}.`);
  const low = world();
  const b = post(low, { cap: 99, source: 'cap' });
  assert.equal(b.code, 4);
  assert.equal(b.text, 'The cost is $1.00, over the $0.99 Dave tapped. Ask again.');
  [w, none, low].forEach((x) => x.done());
});

test('PP15: the verb maps results to exit codes: 0 posted, 4 a refusal, 5 a failed read or a busy lock; text on stderr for a refusal', () => {
  const run = (result) => PAID.runPostVerb(['post', '--pr', '225'], { post: () => result });
  assert.deepEqual(run({ ok: true, code: 0, text: 'Posted.' }), { code: 0, out: ['Posted.'], err: [] });
  assert.deepEqual(run({ ok: false, code: 4, text: 'No.' }), { code: 4, out: [], err: ['cr-paid: refused: No.'] });
  assert.deepEqual(run({ ok: false, code: 5, text: 'Down.' }), { code: 5, out: [], err: ['cr-paid: Down.'] });
  assert.equal(PAID.runPostVerb(['post', '--pr', '12', '--cap', '5'], { post: () => { throw new Error('must not run'); } }).code, 2);
});
