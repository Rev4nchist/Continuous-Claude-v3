// Tests for scripts/github/slot-queue.mjs (free-slot queue CLI). Every test names the source change that breaks it.
// Run: node --test scripts/github/slot-queue.test.mjs
// GitHub is the fake in fixtures/slot-queue/fake-gh.mjs and the clock is a stub: nothing reaches the network or posts to GitHub.
// In-process tests call the real main(argv, deps). F1, F10b and E2E-1 run main in child processes on one temp state file.
// Plan sec 5 ids (F1...) are in the titles. SLOT_QUEUE_E2E_OUT (test only) names a file that E2E-1 writes its steps to.
// SLOT_QUEUE_UPDATE_FIXTURES=1 (test only) rewrites fixtures/slot-queue/tick-*.json; the O1 test then compares nothing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from './slot-queue.mjs';
import * as CRPAID from './cr-paid.mjs';
import { emptyState } from './slot-queue-model.mjs';
import { makeGh } from './fixtures/slot-queue/fake-gh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'slot-queue');
const MAIN_URL = pathToFileURL(path.join(HERE, 'slot-queue.mjs')).href;
const GH_URL = pathToFileURL(path.join(FIX, 'fake-gh.mjs')).href;
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 18, 0, 0);
const at = (m) => T0 + m * MIN;
const iso = (ms) => new Date(ms).toISOString();
const headOf = (pr) => String(pr).padStart(40, '0');

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function setup(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `slot-queue-test-${label}-`));
  made.push(dir);
  const e = {
    dir, statePath: path.join(dir, 'state', 'coderabbit-slot.json'), worldPath: path.join(dir, 'world.json'),
    logPath: path.join(dir, 'posts.log'), callsPath: path.join(dir, 'calls.log'), ledgerPath: path.join(dir, 'paid.jsonl'),
  };
  mkdirSync(path.dirname(e.statePath), { recursive: true });
  return e;
}

// --- worlds, state, comments --------------------------------------------------------------------------------------

const prOf = (pr, over = {}) => ({
  state: 'open', merged: false, head: headOf(pr), committedAt: iso(at(-300)), statuses: [], reviews: [], comments: [], files: [], ...over,
});
const setWorld = (e, prs) => writeFileSync(e.worldPath, JSON.stringify({ repo: REPO, prs }));
const crUser = { login: 'coderabbitai[bot]', type: 'Bot' };
let commentId = 100;
const limitNotice = (pr, wait, ms) => ({
  id: (commentId += 1), user: crUser, created_at: iso(ms), updated_at: iso(ms),
  body: `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n> ## Review limit reached\n> Please wait ${wait} minutes.\nhttps://github.com/${REPO}/commit/${headOf(pr)}`,
});
const review = (pr, ms) => ({ user: crUser, commit_id: headOf(pr), body: 'Actionable comments posted: 0', submitted_at: iso(ms) });
const humanRequest = (ms) => ({ id: (commentId += 1), user: { login: 'dave', type: 'User' }, body: '@coderabbitai review', created_at: iso(ms), updated_at: iso(ms) });

const itemOf = (pr, over = {}) => ({
  pr, head: headOf(pr), band: 'HIGH', escalated: false, round: 1, state: 'queued', queuedAt: at(-5), addedAt: at(-5), posts: 0, pin: false,
  asked: { paid30: false, timeout60: false }, session: 's1', ...over,
});
const setState = (e, items, over = {}) => writeFileSync(e.statePath, JSON.stringify({ ...emptyState(), items, ...over }));
const stateOf = (e) => JSON.parse(readFileSync(e.statePath, 'utf8'));
const itemIn = (e, pr) => stateOf(e).items.find((i) => i.pr === pr);
const digest = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent');
const posts = (e) => (existsSync(e.logPath) ? readFileSync(e.logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const BUSY = (extra = {}) => ({ slot: { nextAt: at(600), source: 'notice', lastPostAt: 0, lastPostPr: null }, ...extra });

// --- runners ------------------------------------------------------------------------------------------------------

function run(e, argv, o = {}) {
  const lines = { out: [], err: [] };
  const calls = [];
  const base = makeGh(e.worldPath, e.logPath, o.gh);
  const code = main(argv, {
    gh: (a) => { calls.push(a); return base(a); }, now: () => o.now ?? T0, statePath: e.statePath, ledgerPath: e.ledgerPath,
    repo: REPO, cfg: o.cfg ?? {}, env: {}, checkPr: o.checkPr, lockWaitMs: o.lockWaitMs ?? 300, configPath: o.configPath,
    out: (l) => lines.out.push(l), err: (l) => lines.err.push(l),
  });
  const json = lines.out.length > 0 ? JSON.parse(lines.out.join('\n')) : null;
  return { code, json, calls, err: lines.err };
}

const CHILD = `
const ctx = JSON.parse(process.argv[1]);
const { main } = await import(ctx.mainUrl);
const { makeGh } = await import(ctx.ghUrl);
process.exitCode = main(ctx.argv, {
  gh: makeGh(ctx.worldPath, ctx.logPath, ctx.gh), now: () => ctx.now, statePath: ctx.statePath, ledgerPath: ctx.ledgerPath,
  repo: ctx.repo, cfg: ctx.cfg, env: {}, checkPr: ctx.verdict ? () => ctx.verdict : undefined,
});`;

function child(e, argv, o = {}) {
  const ctx = {
    argv, mainUrl: MAIN_URL, ghUrl: GH_URL, now: o.now ?? T0, statePath: e.statePath, worldPath: e.worldPath, logPath: e.logPath,
    ledgerPath: e.ledgerPath, repo: REPO, cfg: o.cfg ?? {}, gh: { callsPath: e.callsPath, ...o.gh }, verdict: o.verdict,
  };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify(ctx)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => { stdout += b; });
    p.stderr.on('data', (b) => { stderr += b; });
    p.on('close', (code) => resolve({ code, stdout, stderr, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null }));
  });
}

const ALLOW = (pr, over = {}) => ({ exitCode: 0, verdict: 'ALLOW', pr, head: headOf(pr), round: 1, files: 11, total: 11, cost: 2.75, reasons: [], comment: '@coderabbitai review --use-credits', ...over });
const ESCALATE = (pr) => ({ exitCode: 3, verdict: 'ESCALATE', pr, head: headOf(pr), reasons: ['today $14.00 + round $2.00 is over $15.00'], comment: null });
const toasts = (json) => json.actions.filter((a) => a.kind === 'toast');

// --- tick: the post, the holder, the lock -------------------------------------------------------------------------

// Breaks if the tick does not post for a free slot, or posts the wrong text, or leaves the item queued after the post.
test('tick posts one @coderabbitai review for the first queued item, marks it posted and takes the holder', () => {
  const e = setup('post');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['tick', '--json', '--session', 'sess-a']);
  assert.equal(r.code, 0);
  assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review' }]);
  const s = stateOf(e);
  assert.equal(s.items[0].state, 'posted');
  assert.deepEqual([s.holder.pr, s.holder.head, s.holder.session], [5, headOf(5), 'sess-a']);
  assert.equal(s.slot.lastPostAt, T0);
  assert.equal(s.lastTickAt, T0);
  assert.match(toasts(r.json)[0].text, /PR #5: free slot taken, @coderabbitai review posted\./);
});

// --- card coord-slot-queue-full-form: a head that only merges main gets the FREE full-review request -------------------
// How it can fail: a merge-only head gets the plain request ("already reviewed"); the post holds a paid word; a failed or null verdict blocks the post
// or posts the full form; the verdict is read inside the lock (m6); the free texts drift from cr-paid.mjs.
const MERGE_ONLY = (pr, over = {}) => ALLOW(pr, { mergeOnly: true, ...over });
const FULL_FREE = '@coderabbitai full review';
const bodiesOf = (e) => posts(e).map((p) => p.body);

// Breaks if cr-paid.mjs does not own the free request text, or the free text gains the credit flag, or the paid text changes.
test('SQ1: cr-paid.mjs gives the free request text: plain, or full for a merge-only head, never the credit flag', () => {
  assert.equal(CRPAID.freeRequestCommentOf(false), '@coderabbitai review');
  assert.equal(CRPAID.freeRequestCommentOf(undefined), '@coderabbitai review');
  assert.equal(CRPAID.freeRequestCommentOf('true'), '@coderabbitai review', 'only the boolean true counts');
  assert.equal(CRPAID.freeRequestCommentOf(true), FULL_FREE);
  assert.doesNotMatch(`${CRPAID.freeRequestCommentOf(true)}${CRPAID.freeRequestCommentOf(false)}`, /use-credits/);
  assert.equal(CRPAID.requestCommentOf(true), '@coderabbitai full review --use-credits', 'the paid text is unchanged');
});

// Breaks if a merge-only verdict (ALLOW) still posts the plain request.
test('SQ2: a free slot for a merge-only head posts the full-review request, and the toast names it', () => {
  const e = setup('sq2');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['tick', '--json'], { checkPr: (pr) => MERGE_ONLY(pr) });
  assert.equal(r.code, 0);
  assert.deepEqual(posts(e), [{ pr: 5, body: FULL_FREE }]);
  assert.equal(itemIn(e, 5).state, 'posted');
  assert.match(toasts(r.json)[0].text, /PR #5: free slot taken, @coderabbitai full review posted\./);
});

// Breaks if the full form is tied to a paid ALLOW: the verdict is ESCALATE when the paid limits are spent, but a free slot bills nothing.
test('SQ3: an ESCALATE verdict that says mergeOnly still gives the full free request', () => {
  const e = setup('sq3');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json'], { checkPr: (pr) => ({ ...ESCALATE(pr), mergeOnly: true }) });
  assert.deepEqual(bodiesOf(e), [FULL_FREE]);
});

// Breaks if a normal head, a missing flag, a null verdict, a read error or a thrown error changes the request or blocks the post.
for (const [label, checkPr] of [
  ['a normal head (mergeOnly false)', (pr) => ALLOW(pr, { mergeOnly: false })],
  ['a verdict with no mergeOnly key', (pr) => ALLOW(pr)],
  ['mergeOnly as a string', (pr) => ALLOW(pr, { mergeOnly: 'true' })],
  ['a null verdict that says mergeOnly', (pr) => ({ exitCode: 2, verdict: null, mergeOnly: true, reason: 'gh failed' })],
  ['a verdict read that throws', () => { throw new Error('gh down'); }],
]) {
  test(`SQ4: ${label} posts the plain request`, () => {
    const e = setup('sq4');
    setWorld(e, { 5: prOf(5) });
    setState(e, [itemOf(5)]);
    const r = run(e, ['tick', '--json'], { checkPr });
    assert.equal(r.code, 0);
    assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review' }]);
    assert.match(toasts(r.json)[0].text, /PR #5: free slot taken, @coderabbitai review posted\./);
  });
}

// Breaks if any queue post carries the paid word, whatever the verdict says (the queue never buys a review on its own).
test('SQ5: no free post holds the credit flag, for a merge-only head, a normal head or an ESCALATE verdict', () => {
  for (const [i, checkPr] of [(pr) => MERGE_ONLY(pr), (pr) => ALLOW(pr), (pr) => ({ ...ESCALATE(pr), mergeOnly: true }), (pr) => ({ ...MERGE_ONLY(pr), comment: '@coderabbitai full review --use-credits' })].entries()) {
    const e = setup(`sq5-${i}`);
    setWorld(e, { 5: prOf(5) });
    setState(e, [itemOf(5)]);
    run(e, ['tick', '--json'], { checkPr });
    assert.equal(bodiesOf(e).length, 1);
    assert.doesNotMatch(bodiesOf(e)[0], /use-credits|--/, `case ${i}`);
  }
});

// Breaks if the verdict (about 6 gh reads) is read while the queue lock file exists (m6), or for a PR the tick does not post for, or twice.
test('SQ6: the verdict for the post is read once, before the lock, for the PR that is posted', () => {
  const e = setup('sq6');
  setWorld(e, { 5: prOf(5), 6: prOf(6) });
  setState(e, [itemOf(5), itemOf(6, { queuedAt: at(-4) })]);
  const seen = [];
  const checkPr = (pr) => { seen.push([pr, existsSync(`${e.statePath}.lock`)]); return MERGE_ONLY(pr); };
  run(e, ['tick', '--json'], { checkPr });
  assert.deepEqual(seen, [[5, false]]);
  assert.deepEqual(bodiesOf(e), [FULL_FREE]);
});

// The PR 685 case through the REAL cr-paid check (no injected verdict): the head merges main over the reviewed commit. The compare lists 3 commits that main
// already held (one parent each) and the merge; the PR's own list holds the reviewed commit and the merge only. Breaks if the queue post path does not
// reach mergeOnlyOf, or reads the compare commits instead of the PR's own list.
function replayWorld(e, { ownList }) {
  const OLD = 'b'.repeat(40);
  const MAINC = ['1', '2', '3'].map((n) => ({ sha: n.repeat(40), parents: [{ sha: 'd'.repeat(40) }] }));
  const MERGEC = { sha: headOf(5), parents: [{ sha: OLD }, { sha: 'd'.repeat(40) }] };
  const compare = { status: 'ahead', total_commits: 4, commits: [...MAINC, MERGEC], files: [{ filename: 'main-only.ts', additions: 400, deletions: 90, status: 'modified' }] };
  const prFiles = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ filename: `src/${n}.ts`, additions: 5, deletions: 0, status: 'modified' }));
  setWorld(e, { 5: prOf(5, { reviews: [{ user: crUser, commit_id: OLD, body: 'Actionable comments posted: 1', submitted_at: iso(at(-200)) }], files: prFiles }) });
  setState(e, [itemOf(5)]);
  const base = makeGh(e.worldPath, e.logPath);
  return (argv) => {
    const p = argv.find((x) => typeof x === 'string' && x.startsWith('repos/')) ?? '';
    if (/\/compare\//.test(p)) return compare;
    if (/\/pulls\/5\/commits/.test(p)) return [[{ sha: OLD }, ...ownList]];
    return base(argv);
  };
}
function replayTick(e, gh) {
  const out = [];
  const code = main(['tick', '--json'], { gh, now: () => T0, statePath: e.statePath, ledgerPath: e.ledgerPath, repo: REPO, cfg: {}, env: {}, lockWaitMs: 300, out: (l) => out.push(l), err: () => {} });
  return { code, json: JSON.parse(out.join('\n')) };
}
test('SQ8: the PR 685 replay through the real cr-paid check posts the free full-review request; no paid request is posted', () => {
  const e = setup('sq8');
  const gh = replayWorld(e, { ownList: [{ sha: headOf(5) }] });
  const r = replayTick(e, gh);
  assert.equal(r.code, 0);
  assert.deepEqual(bodiesOf(e), [FULL_FREE]);
  assert.doesNotMatch(bodiesOf(e).join(' '), /use-credits/);
  assert.equal(existsSync(e.ledgerPath), false, 'the free post writes no paid ledger row');
});
test('SQ9: the same compare with one real (single-parent) commit in the PR list posts the plain request', () => {
  const e = setup('sq9');
  const gh = replayWorld(e, { ownList: [{ sha: headOf(5) }, { sha: '2'.repeat(40) }] });
  const r = replayTick(e, gh);
  assert.equal(r.code, 0);
  assert.deepEqual(bodiesOf(e), ['@coderabbitai review']);
});

// Breaks if a busy slot (no post) still reads a verdict, or the verdict of an item due its paid ask is read twice.
test('SQ7: no post this tick means no extra verdict read', () => {
  const e = setup('sq7');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)], BUSY());
  let reads = 0;
  run(e, ['tick', '--json'], { checkPr: (pr) => { reads += 1; return MERGE_ONLY(pr); } });
  assert.equal(reads, 0);
  assert.deepEqual(bodiesOf(e), []);
});

// --- card coord-queue-prelock-verdict: the item claimed inside the lock must be the item whose verdict was read before it -------------------
// How it can fail: a peer changes the queue between the pre-lock read and the claim, the claimed item has no verdict, and the plain request goes out
// on a merge-only head ("already reviewed", slot lost); a defer writes the holder or skips the timers; a defer also blocks the normal tick.
// The race is made by the verdict read itself: checkPr(5) is the pre-lock read, and it edits the state file before the tick takes the lock.
const raceTick = (e, items, peer, over = {}) => {
  const reads = [];
  const checkPr = (pr) => { reads.push(pr); if (reads.length === 1) peer(); return MERGE_ONLY(pr); };
  const r = run(e, ['tick', '--json'], { checkPr, ...over });
  return { r, reads };
};

// Breaks if tickLocked posts for a claimed item that has no pre-lock verdict (the plain form on a merge-only head), takes the holder for it, or reads a verdict inside the lock.
test('SQ10: a peer drops the pre-lock pick, so the claimed item has no verdict: no post, no holder, lastTickAt written, no second read', () => {
  const e = setup('sq10');
  setWorld(e, { 5: prOf(5), 6: prOf(6) });
  setState(e, [itemOf(5), itemOf(6, { queuedAt: at(-4) })]);
  const { r, reads } = raceTick(e, null, () => setState(e, [itemOf(5, { state: 'dropped', dropReason: 'closed' }), itemOf(6, { queuedAt: at(-4) })]));
  assert.equal(r.code, 0);
  assert.deepEqual(reads, [5], 'one read, before the lock; none inside it');
  assert.deepEqual(posts(e), [], 'no post for PR 6: its verdict was never read');
  const s = stateOf(e);
  assert.equal(s.holder, null);
  assert.equal(s.lastTickAt, T0);
  assert.equal(itemIn(e, 6).state, 'queued');
  assert.equal(itemIn(e, 6).posts, 0);
});

// Breaks if a peer add (a later item) makes the tick defer: the pick is the same item, so its read verdict applies and the full form goes out.
test('SQ11: a peer adds a later item between the read and the claim: the same item is picked and posts the full form', () => {
  const e = setup('sq11');
  setWorld(e, { 5: prOf(5), 7: prOf(7) });
  setState(e, [itemOf(5)]);
  const { r } = raceTick(e, null, () => setState(e, [itemOf(5), itemOf(7, { queuedAt: at(-1), addedAt: at(-1) })]));
  assert.equal(r.code, 0);
  assert.deepEqual(posts(e), [{ pr: 5, body: FULL_FREE }]);
  assert.equal(stateOf(e).holder.pr, 5);
});

// Breaks if a deferred tick skips askTimers or flagPaid: the 60-minute time-out toast of the claimed item must still fire, once.
test('SQ12: a deferred tick still raises the 60-minute time-out toast', () => {
  const e = setup('sq12');
  setWorld(e, { 5: prOf(5), 7: prOf(7) });
  setState(e, [itemOf(5, { state: 'timed-out', queuedAt: at(-70) }), itemOf(7, { state: 'timed-out', queuedAt: at(-65) })]);
  const { r } = raceTick(e, null, () => setState(e, [itemOf(5, { state: 'dropped', dropReason: 'closed' }), itemOf(7, { state: 'timed-out', queuedAt: at(-65) })]));
  assert.equal(r.code, 0);
  assert.deepEqual(posts(e), []);
  assert.equal(stateOf(e).holder, null);
  assert.equal(toasts(r.json).filter((t) => /PR #7: no free slot for 60 minutes/.test(t.text)).length, 1);
  assert.equal(itemIn(e, 7).asked.timeout60, true);
});

// F5 at the CLI. Breaks if the post step runs before the reviewed-head check.
test('F5: a head CodeRabbit already reviewed is done and gets no post', () => {
  const e = setup('f5');
  setWorld(e, { 5: prOf(5, { reviews: [review(5, at(-2))] }) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['tick', '--json']);
  assert.equal(itemIn(e, 5).state, 'done');
  assert.deepEqual(posts(e), []);
  assert.match(toasts(r.json)[0].text, /PR #5: CodeRabbit reviewed head 0000000/);
});

// F6 at the CLI. Breaks if a merged PR is read as open.
test('F6: a merged PR is dropped with the reason merged, and gets no post', () => {
  const e = setup('f6');
  setWorld(e, { 5: prOf(5, { state: 'closed', merged: true }) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json']);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).dropReason], ['dropped', 'merged']);
  assert.deepEqual(posts(e), []);
});

// Breaks if a failed post leaves the holder, marks the item posted, or moves lastPostAt.
// m9: breaks if a failed post sets no nextAt (a persistent POST error then retries and toasts on every effective tick).
test('a failed post clears the holder, keeps the item queued and backs the slot off 10 minutes', () => {
  const e = setup('failpost');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['tick', '--json'], { gh: { failPost: true } });
  assert.equal(r.code, 0);
  const s = stateOf(e);
  assert.equal(s.holder, null);
  assert.equal(s.items[0].state, 'queued');
  assert.equal(s.slot.lastPostAt, 0);
  assert.equal(s.slot.nextAt, at(10));
  assert.match(toasts(r.json)[0].text, /PR #5: the free-slot post failed/);
});

// m9. Breaks if the backoff is lost: with the dedupe off, a tick 6 minutes later must not try the post (it would toast again), and 11 minutes later must.
test('m9: after a failed post no post is tried before the backoff ends, then it is tried again', () => {
  const e = setup('backoff');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const cfg = { dedupe_min: 0 };
  run(e, ['tick', '--json'], { gh: { failPost: true }, cfg });
  const early = run(e, ['tick', '--json'], { gh: { failPost: true }, cfg, now: at(6) });
  assert.deepEqual(toasts(early.json), []);
  assert.deepEqual(posts(e), []);
  const later = run(e, ['tick', '--json'], { cfg, now: at(11) });
  assert.equal(posts(e).length, 1);
  assert.match(toasts(later.json)[0].text, /free slot taken/);
});

// F1. Breaks if the holder is written after the post, or the apply runs outside withLock: two processes then both post.
// The second run turns the 4-minute dedupe off (dedupe_min 0), so only the lock and the holder stop the second post.
for (const cfg of [{}, { dedupe_min: 0 }]) {
  test(`F1: two processes tick together on a free slot and one post is made (cfg ${JSON.stringify(cfg)})`, async () => {
    const e = setup('f1');
    setWorld(e, { 5: prOf(5), 6: prOf(6) });
    setState(e, [itemOf(5), itemOf(6, { queuedAt: at(-4) })]);
    const opts = { cfg, gh: { postDelayMs: 400 } };
    const both = await Promise.all([child(e, ['tick', '--json'], opts), child(e, ['tick', '--json'], opts)]);
    assert.deepEqual(both.map((c) => c.code), [0, 0], both.map((c) => c.stderr).join());
    assert.equal(posts(e).length, 1);
  });
}

// F1 (guards one at a time). Breaks if the holder is written after the post, or the post runs outside withLock:
// at the moment of the post the state file must already name the holder, and the lock file must exist.
test('F1: at post time the holder is already in the file and the lock is held', () => {
  const e = setup('f1peek');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json'], { gh: { peekState: e.statePath } });
  const seen = readFileSync(`${e.logPath}.peek`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(seen, [{ holderPr: 5, locked: true }]);
});

// F2. Breaks if tick stops using withLock, or passes a huge lockStaleMs: a dead owner's old lock must not stop the tick.
test('F2: a lock left by a dead process is taken over and the tick runs', () => {
  const e = setup('f2');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const lock = `${e.statePath}.lock`;
  writeFileSync(lock, `${dead} old-token`);
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const r = run(e, ['tick', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.effective, true);
  assert.equal(posts(e).length, 1);
  assert.equal(existsSync(lock), false);
});

// Breaks if a tick takes a live holder's lock, or waits past lockWaitMs, or posts without the lock.
test('a live process holding the lock gives a read-only tick: locked true, no post, file unchanged', () => {
  const e = setup('locked');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  writeFileSync(`${e.statePath}.lock`, `${process.pid} live-token`);
  const before = digest(e.statePath);
  const r = run(e, ['tick', '--json'], { lockWaitMs: 150 });
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.effective, r.json.locked], [false, true]);
  assert.equal(r.json.rows.length, 1);
  assert.equal(digest(e.statePath), before);
  assert.deepEqual(posts(e), []);
});

// F15. Breaks if the parse error is swallowed and the file rewritten: a bad file gives exit 2, no post, same bytes.
test('F15: a corrupt state file gives exit 2 for every verb, no post and no change', () => {
  const e = setup('f15');
  setWorld(e, { 5: prOf(5) });
  writeFileSync(e.statePath, '{ this is not json');
  const before = digest(e.statePath);
  const argvs = [['tick', '--json'], ['list', '--json'], ['add', '--pr', '5', '--band', 'HIGH', '--head', headOf(5), '--json'],
    ['drop', '--pr', '5', '--reason', 'x', '--json'], ['decide', '--pr', '5', '--kind', 'first', '--json']];
  for (const argv of argvs) {
    const r = run(e, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /slot-queue/);
  }
  assert.equal(digest(e.statePath), before);
  assert.deepEqual(posts(e), []);
});

// F16. Breaks if lastTickAt moves, or the file is written, when a GitHub read fails.
test('F16: a GitHub outage during a tick gives exit 2 and leaves the file bytes unchanged', () => {
  const e = setup('f16');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const before = digest(e.statePath);
  const r = run(e, ['tick', '--json'], { gh: { failAll: true } });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.reason, /GitHub is down/);
  assert.equal(digest(e.statePath), before);
});

// F18. Breaks if the dedupe is removed: a second tick 2 minutes later must make no gh call and say effective false.
test('F18: a tick within 4 minutes of the last one reads the file only', () => {
  const e = setup('f18');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)], BUSY({ lastTickAt: at(-2) }));
  const r = run(e, ['tick', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.effective, false);
  assert.equal(r.calls.length, 0);
  assert.equal(r.json.rows[0].pr, 5);
});

// Breaks if a tick on a missing or all-done queue reads GitHub or creates the file.
test('a tick with no active item makes no gh call and creates no file', () => {
  const e = setup('idle');
  setWorld(e, { 5: prOf(5) });
  const r = run(e, ['tick', '--json']);
  assert.deepEqual([r.code, r.json.effective, r.json.rows, r.calls.length], [0, false, [], 0]);
  assert.equal(existsSync(e.statePath), false);
  setState(e, [itemOf(5, { state: 'done' })]);
  assert.equal(run(e, ['tick', '--json']).calls.length, 0);
});

// F24. Breaks if noteSeenPosts is not applied: a person's request 5 minutes ago blocks the post and moves lastPostAt.
test('F24: a request comment on the head 5 minutes ago blocks the post and moves lastPostAt', () => {
  const e = setup('f24');
  setWorld(e, { 5: prOf(5, { comments: [humanRequest(at(-5))] }) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json']);
  assert.deepEqual(posts(e), []);
  assert.equal(stateOf(e).slot.lastPostAt, at(-5));
});

// Breaks if a pending CodeRabbit status on the head no longer holds the post (F4 at the CLI).
test('F4: a pending CodeRabbit status on the head skips the post', () => {
  const e = setup('f4');
  setWorld(e, { 5: prOf(5, { statuses: [{ context: 'CodeRabbit', state: 'pending', description: 'Review in progress' }] }) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json']);
  assert.deepEqual(posts(e), []);
});

// Breaks if the commit-status read takes only page one: a pending CodeRabbit status on page 2 then reads as no review in progress and the queue posts.
test('F4: a pending CodeRabbit status on page 2 of the commit statuses skips the post', () => {
  const e = setup('f4-page2');
  const filler = Array.from({ length: 3 }, (_, i) => ({ context: `ci/job-${i}`, state: 'success' }));
  const pending = { context: 'CodeRabbit', state: 'pending', description: 'Review in progress' };
  setWorld(e, { 5: prOf(5, { statusPages: [filler, [pending]] }) });
  setState(e, [itemOf(5)]);
  run(e, ['tick', '--json']);
  assert.deepEqual(posts(e), []);
});

// --- tick: notices, asks, time-out ------------------------------------------------------------------------------

// Breaks if the facts map a limit notice wrongly: the opening item must queue, take nextAt from the figure, and toast with the position.
test('a limit notice on the head queues an opening item, sets nextAt and toasts the position', () => {
  const e = setup('notice');
  setWorld(e, { 900: prOf(900, { comments: [limitNotice(900, 12, T0)] }) });
  setState(e, [itemOf(900, { state: 'opening', queuedAt: 0, addedAt: at(-5) })]);
  const r = run(e, ['tick', '--json']);
  const s = stateOf(e);
  assert.equal(s.items[0].state, 'queued');
  assert.equal(s.slot.nextAt, at(12));
  assert.deepEqual(posts(e), []);
  assert.equal(toasts(r.json)[0].text, 'PR #900: queued for the free CodeRabbit slot, 1 of 1. Next slot in about 12 minutes.');
});

// F27. Breaks if askTimers drops the band check or asked.paid30: HIGH must get no ask and CRITICAL only one.
test('F27: the 30-minute paid ask fires once, for CRITICAL only', () => {
  const e = setup('f27');
  setWorld(e, { 7: prOf(7), 8: prOf(8) });
  setState(e, [itemOf(7, { band: 'CRITICAL', queuedAt: at(-31) }), itemOf(8, { queuedAt: at(-31) })], BUSY());
  let asked = 0;
  const checkPr = (pr) => { asked += 1; return ALLOW(pr); };
  const first = run(e, ['tick', '--json'], { checkPr });
  assert.equal(toasts(first.json).length, 1);
  assert.match(toasts(first.json)[0].text, /^PR #7: no free slot for 30 minutes\. Paid round \$2\.75 \(cr-paid ALLOW\)\. Dave answers the question the session asks, or the item keeps waiting\.$/);
  assert.deepEqual([itemIn(e, 7).asked.paid30, itemIn(e, 8).asked.paid30], [true, false]);
  const second = run(e, ['tick', '--json'], { checkPr, now: at(5) });
  assert.equal(toasts(second.json).length, 0);
  assert.equal(asked, 1);
});

// Breaks if an ESCALATE verdict is shown as an offer to pay, or a read error sets asked.paid30 (the ask would never repeat).
test('F27: an ESCALATE verdict toasts the reason with no typed command, and a verdict error asks nothing and retries', () => {
  const e = setup('f27b');
  setWorld(e, { 7: prOf(7) });
  setState(e, [itemOf(7, { band: 'CRITICAL', queuedAt: at(-31) })], BUSY());
  const err = run(e, ['tick', '--json'], { checkPr: () => ({ exitCode: 2, verdict: null, reason: 'gh failed' }) });
  assert.equal(toasts(err.json).length, 0);
  assert.equal(itemIn(e, 7).asked.paid30, false);
  const esc = run(e, ['tick', '--json'], { checkPr: ESCALATE, now: at(5) });
  assert.match(toasts(esc.json)[0].text, /^PR #7: .*not allowed.*over \$15\.00.*The item keeps waiting\.$/);
  assert.doesNotMatch(toasts(esc.json)[0].text, /\/slot/);
});

// F10b. Breaks if the timers live in memory: a fresh process on a file with queuedAt 61 minutes ago must time the item out and toast.
test('F10b: a new process on a file with queuedAt 61 minutes ago gives timed-out and one toast, then no repeat', async () => {
  const e = setup('f10b');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5, { queuedAt: at(-61) })], BUSY());
  const first = await child(e, ['tick', '--json']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(itemIn(e, 5).state, 'timed-out');
  assert.equal(toasts(first.json).length, 1);
  assert.match(toasts(first.json)[0].text, /^PR #5: no free slot for 60 minutes; still queued; READY still needs a CodeRabbit review\. Dave answers the question the session asks: pay or keep waiting\.$/);
  assert.equal(itemIn(e, 5).asked.timeout60, true);
  const second = await child(e, ['tick', '--json'], { now: at(5) });
  assert.equal(toasts(second.json).length, 0);
});

// Breaks if a SAMPLE item gets the time-out toast (F26 at the CLI).
test('a SAMPLE item queued 70 minutes stays queued with no toast', () => {
  const e = setup('sample70');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5, { band: 'SAMPLE', queuedAt: at(-70) })], BUSY());
  const r = run(e, ['tick', '--json']);
  assert.equal(itemIn(e, 5).state, 'queued');
  assert.equal(r.json.actions.length, 0);
});

// Breaks if the stuck transition is silent: the second empty post must tell Dave how to clear the item.
test('an item whose second post made no review becomes stuck and toasts the question to answer, not a typed command', () => {
  const e = setup('stuck');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5, { state: 'posted', posts: 1 })], { holder: { pr: 5, head: headOf(5), at: at(-25), session: 's1' }, slot: { nextAt: null, source: 'post', lastPostAt: at(-25), lastPostPr: 5 } });
  const r = run(e, ['tick', '--json']);
  assert.equal(itemIn(e, 5).state, 'stuck');
  assert.match(toasts(r.json)[0].text, /PR #5: .*no review.*Dave answers the question the session asks: remove it or try again\.$/);
  assert.doesNotMatch(toasts(r.json)[0].text, /\/slot/);
});

// m6. Breaks if the cr-paid verdict is read inside tickLocked: about 6 gh reads would then run while the lock file exists,
// and an add from another session could time out on lockWaitMs.
test('m6: the cr-paid verdict is read before the lock is taken, and only for an item that is due its ask', () => {
  const e = setup('m6');
  setWorld(e, { 7: prOf(7), 8: prOf(8) });
  setState(e, [itemOf(7, { band: 'CRITICAL', queuedAt: at(-31) }), itemOf(8, { band: 'CRITICAL', queuedAt: at(-5) })], BUSY());
  const seen = [];
  const checkPr = (pr) => { seen.push([pr, existsSync(`${e.statePath}.lock`)]); return ALLOW(pr); };
  const r = run(e, ['tick', '--json'], { checkPr });
  assert.deepEqual(seen, [[7, false]]);
  assert.equal(toasts(r.json).length, 1);
  assert.equal(itemIn(e, 7).asked.paid30, true);
});

// m7. Breaks if a verdict read error is retried without a limit: the third failed read must give one toast and set asked.paid30; a fourth tick reads nothing.
test('m7: three failed cr-paid reads give one toast and stop reading', () => {
  const e = setup('m7');
  setWorld(e, { 7: prOf(7) });
  setState(e, [itemOf(7, { band: 'CRITICAL', queuedAt: at(-31) })], BUSY());
  let reads = 0;
  const checkPr = () => { reads += 1; return { exitCode: 2, verdict: null, reason: 'gh failed' }; };
  const ticks = [0, 5, 10, 15].map((m) => run(e, ['tick', '--json'], { checkPr, now: at(m) }));
  assert.deepEqual(ticks.map((t) => toasts(t.json).length), [0, 0, 1, 0]);
  assert.equal(reads, 3);
  assert.equal(itemIn(e, 7).asked.paid30, true);
  assert.match(toasts(ticks[2].json)[0].text, /PR #7: .*30 minutes.*could not be read.*gh failed.*Dave answers the question the session asks: try it again or keep waiting\.$/);
  assert.doesNotMatch(toasts(ticks[2].json)[0].text, /\/slot/);
  assert.deepEqual(Object.keys(ticks[2].json.rows[0].asked).sort(), ['paid30', 'timeout60']);
});

// m8. Breaks if one PR whose read fails stops every tick: item 7 has no PR in the world (a 404), item 5 must still be posted.
test('m8: one item whose GitHub read fails is skipped; the others are still processed', () => {
  const e = setup('m8');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5), itemOf(7, { queuedAt: at(-4) })]);
  const gone = itemIn(e, 7);
  const r = run(e, ['tick', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review' }]);
  assert.deepEqual(itemIn(e, 7), gone);
});

// --- probe and list --------------------------------------------------------------------------------------------

// F28. Breaks if probe takes the lock, writes, or posts: bytes, lock file and post log must stay as they were.
test('F28: probe prints the facts and writes, locks and posts nothing', () => {
  const e = setup('f28');
  setWorld(e, { 5: prOf(5, { comments: [limitNotice(5, 12, T0)], reviews: [review(9, at(-1))] }) });
  setState(e, [itemOf(5)]);
  const before = digest(e.statePath);
  const r = run(e, ['probe', '--pr', '5', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json.facts).sort(), ['carryHolds', 'head', 'limited', 'merged', 'open', 'pending', 'pr', 'requestAts', 'retryMinutes', 'reviewAts', 'reviewedHead', 'unledgeredPaid']);
  assert.equal(r.json.facts.limited, true);
  assert.equal(r.json.facts.retryMinutes, 12);
  assert.equal(digest(e.statePath), before);
  assert.equal(existsSync(`${e.statePath}.lock`), false);
  assert.deepEqual(posts(e), []);
});

// Breaks if probe needs a queue item: it must work on a PR that is not in the file (the live check on #246).
test('probe works with no state file and for a PR that is not queued', () => {
  const e = setup('probe-new');
  setWorld(e, { 246: prOf(246) });
  const r = run(e, ['probe', '--pr', '246', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.facts.head, headOf(246));
  assert.equal(existsSync(e.statePath), false);
});

// Breaks if list takes the lock, writes, or reads GitHub.
test('list prints rows and next slot from the file, with no lock, no write and no gh call', () => {
  const e = setup('list');
  setState(e, [itemOf(5), itemOf(6, { band: 'CRITICAL' })], { slot: { nextAt: at(30), source: 'notice', lastPostAt: 0, lastPostPr: null } });
  const before = digest(e.statePath);
  const r = run(e, ['list', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.rows.map((x) => [x.pr, x.position, x.total]), [[6, 1, 2], [5, 2, 2]]);
  assert.equal(r.json.nextSlotInMin, 30);
  assert.equal(r.calls.length, 0);
  assert.equal(digest(e.statePath), before);
  assert.equal(existsSync(`${e.statePath}.lock`), false);
});

// B1. Breaks if the script stops reading matrix.slot from the router config (or the configPath dep), or lets a missing file, bad JSON, a
// string value or a missing block break the tick instead of falling back to the built-in defaults (spacing 60: 10 minutes after a post, 50 left).
test('B1: matrix.slot in the router config sets the spacing; a missing, broken or mistyped config falls back to the defaults', () => {
  const e = setup('config');
  setState(e, [itemOf(5)], { slot: { nextAt: null, source: 'post', lastPostAt: at(-10), lastPostPr: 9 } });
  const left = (configText) => {
    const configPath = path.join(e.dir, 'router.json');
    if (configText === null) rmSync(configPath, { force: true }); else writeFileSync(configPath, configText);
    return run(e, ['list', '--json'], { configPath }).json.nextSlotInMin;
  };
  assert.equal(left(JSON.stringify({ matrix: { slot: { spacing_min: 30 } } })), 20);
  assert.equal(left(null), 50);
  assert.equal(left('{ not json'), 50);
  assert.equal(left(JSON.stringify({ matrix: { slot: { spacing_min: '30' } } })), 50);
  assert.equal(left(JSON.stringify({ matrix: {} })), 50);
});

// B1. Breaks if a key in the repo's review-router.config.json matrix.slot is renamed or mistyped: configOf would then ignore it without a word.
test('B1: the repo router config carries every matrix.slot key the script reads, as a positive number', () => {
  const slot = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'review-router.config.json'), 'utf8')).matrix.slot;
  for (const key of ['spacing_min', 'paid_after_min', 'timeout_min', 'holder_max_min', 'sample_ttl_hours']) {
    assert.ok(Number.isFinite(slot?.[key]) && slot[key] > 0, key);
  }
});

// --- add, decide, drop ----------------------------------------------------------------------------------------

const addArgv = (pr, band, extra = []) => ['add', '--pr', String(pr), '--band', band, '--head', headOf(pr), '--json', ...extra];

// Breaks if add makes a HIGH item queued at once (it must wait for the label review), or loses the shape the mod reads.
test('add queues a SAMPLE at once and opens a HIGH, creating the state folder', () => {
  const e = setup('add');
  rmSync(path.dirname(e.statePath), { recursive: true, force: true });
  const high = run(e, addArgv(5, 'HIGH', ['--session', 'sess-x']));
  assert.equal(high.code, 0);
  assert.deepEqual([high.json.item.state, high.json.item.session, high.json.position, high.json.total], ['opening', 'sess-x', null, 0]);
  const sample = run(e, addArgv(6, 'SAMPLE'));
  assert.deepEqual([sample.json.item.state, sample.json.item.queuedAt, sample.json.position, sample.json.total], ['queued', T0, 1, 1]);
  assert.equal(typeof sample.json.nextSlotInMin, 'number');
});

// Breaks if a round-2 grant adds a queued item: it must wait for the fix push (F21).
test('F21: add with --round 2 --escalated opens the item as awaiting-fix and escalated', () => {
  const e = setup('add2');
  const r = run(e, addArgv(5, 'HIGH', ['--round', '2', '--escalated']));
  assert.deepEqual([r.json.item.state, r.json.item.round, r.json.item.escalated], ['awaiting-fix', 2, true]);
});

// Breaks if a second add for the same round resets addedAt or state (the apply may run twice), or a later round does not replace.
test('add is idempotent for the same round and a later round replaces a finished item', () => {
  const e = setup('add-idem');
  run(e, addArgv(5, 'HIGH'), { now: at(0) });
  const again = run(e, addArgv(5, 'HIGH'), { now: at(9) });
  assert.equal(again.code, 0);
  assert.equal(itemIn(e, 5).addedAt, at(0));
  assert.equal(stateOf(e).items.length, 1);
  const round2 = run(e, addArgv(5, 'HIGH', ['--round', '2', '--escalated']), { now: at(9) });
  assert.deepEqual([round2.json.item.round, round2.json.item.state, stateOf(e).items.length], [2, 'awaiting-fix', 1]);
});

// Breaks if input is not validated: a short head, an unknown band or verb, an unknown flag, a verb that is not at argv[0].
test('bad input gives exit 2 and writes no file', () => {
  const e = setup('bad');
  const bad = [
    ['add', '--pr', '5', '--band', 'HIGH', '--head', 'abc123', '--json'], ['add', '--pr', '5', '--band', 'LOW', '--head', headOf(5)],
    ['add', '--pr', '0', '--band', 'HIGH', '--head', headOf(5)], ['frobnicate'], ['tick', '--bogus'], ['--json', 'tick'],
    ['decide', '--pr', '5', '--kind', 'fallback'], ['drop', '--pr', '5'], [],
  ];
  for (const argv of bad) assert.equal(run(e, argv).code, 2, argv.join(' '));
  assert.equal(existsSync(e.statePath), false);
});

// Breaks if first does not pin, or the pin does not reach the order.
test('decide --kind first pins the item to the front and logs the decision', () => {
  const e = setup('first');
  setState(e, [itemOf(6, { band: 'CRITICAL' }), itemOf(5, { queuedAt: at(-1) })]);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'first', '--json']);
  assert.equal(r.code, 0);
  assert.equal(itemIn(e, 5).pin, true);
  assert.deepEqual([itemIn(e, 5).decision.kind, itemIn(e, 5).decision.by, itemIn(e, 5).decision.head], ['first', 'dave', headOf(5)]);
  assert.deepEqual(run(e, ['list', '--json']).json.rows.map((x) => x.pr), [5, 6]);
});

// Breaks if wait does not restart the clock and reset asked, or leaves a timed-out item timed-out.
test('decide --kind wait restarts the clock, resets asked and returns a timed-out item to queued', () => {
  const e = setup('wait');
  setState(e, [itemOf(5, { state: 'timed-out', queuedAt: at(-90), asked: { paid30: true, timeout60: true } })]);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'wait', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).queuedAt, itemIn(e, 5).asked], ['queued', T0, { paid30: false, timeout60: false }]);
  assert.equal(run(e, ['decide', '--pr', '99', '--kind', 'wait', '--json']).code, 2);
});

// m10. Breaks if wait resets queuedAt on an item that is posted, awaiting a fix or opening: the reply would say the clock restarted when it did not.
test('m10: decide --kind wait is refused unless the item is queued, timed-out or stuck, and changes nothing', () => {
  const e = setup('m10');
  const states = ['posted', 'awaiting-fix', 'opening'];
  setState(e, states.map((state, i) => itemOf(5 + i, { state, queuedAt: at(-30) })));
  const before = digest(e.statePath);
  for (let i = 0; i < states.length; i += 1) {
    const r = run(e, ['decide', '--pr', String(5 + i), '--kind', 'wait', '--json']);
    assert.equal(r.code, 2, states[i]);
    assert.match(r.json.reason, /queued, timed-out or stuck/);
  }
  assert.equal(digest(e.statePath), before);
  setState(e, [itemOf(5, { state: 'stuck', posts: 2 })]);
  assert.equal(run(e, ['decide', '--pr', '5', '--kind', 'wait', '--json']).code, 0);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).posts], ['queued', 0]);
});

// F14. Breaks if decide pay skips the verdict: an ESCALATE (exit 3) posts nothing and writes no ledger row.
test('F14: decide pay with an ESCALATE verdict exits 3, posts nothing and writes no ledger row', () => {
  const e = setup('f14');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const before = digest(e.statePath);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: ESCALATE });
  assert.equal(r.code, 3);
  assert.deepEqual([r.json.verdict, r.json.posted], ['ESCALATE', false]);
  assert.match(r.json.reasons[0], /over \$15\.00/);
  assert.deepEqual(posts(e), []);
  assert.equal(existsSync(e.ledgerPath), false);
  assert.equal(digest(e.statePath), before);
});

// Breaks if an ALLOW does not post the paid comment, record the round, or stop the free post on the same head.
test('F14: decide pay with an ALLOW posts the paid comment once, records the round and marks the item posted', () => {
  const e = setup('f14b');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.verdict, r.json.posted], ['ALLOW', true]);
  assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review --use-credits' }]);
  const row = JSON.parse(readFileSync(e.ledgerPath, 'utf8').trim());
  assert.deepEqual([row.pr, row.head, row.files, row.cost, row.date], [5, headOf(5), 11, 2.75, '2026-11-02']);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).decision.kind], ['posted', 'pay']);
  assert.equal(run(e, ['tick', '--json'], { now: at(5) }).code, 0);
  assert.equal(posts(e).length, 1);
});

// A pay decision carries Dave's price: --cap (the mod passes it from the label of its own dialog).
const payArgv = (pr) => ['decide', '--pr', String(pr), '--kind', 'pay', '--head', headOf(pr), '--cap', '5', '--json'];
const ledgerRows = (e) => (existsSync(e.ledgerPath) && !statSync(e.ledgerPath).isDirectory() ? readFileSync(e.ledgerPath, 'utf8').trim().split('\n').filter(Boolean) : []);

// M5. Breaks if payLocked sets no holder and no lastPostAt: the paid post then spends no spacing, and no path ever requeues it.
test('M5: a paid post takes the holder and lastPostAt, and a paid post that made no review is requeued after 20 minutes', () => {
  const e = setup('m5');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  run(e, payArgv(5), { checkPr: () => ALLOW(5) });
  const s = stateOf(e);
  assert.deepEqual([s.holder.pr, s.holder.head, s.holder.at], [5, headOf(5), T0]);
  assert.deepEqual([s.slot.lastPostAt, s.slot.lastPostPr, s.slot.source], [T0, 5, 'post']);
  const late = run(e, ['tick', '--json'], { now: at(25) });
  assert.equal(late.code, 0);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).posts, stateOf(e).holder], ['queued', 1, null]);
  assert.equal(posts(e).length, 1);
});

// M2. Breaks if payLocked checks neither the state, the holder nor an earlier pay decision: cr-paid would ALLOW a second round on the head.
const PAY_REFUSALS = [
  ['an item that is already posted', (e) => setState(e, [itemOf(5, { state: 'posted' })]), /already posted/],
  ['the PR holds the slot', (e) => setState(e, [itemOf(5)], { holder: { pr: 5, head: headOf(5), at: at(-1), session: 's1' } }), /PR 5 holds the free slot/],
  ['a pay decision exists for this head', (e) => setState(e, [itemOf(5, { decision: { kind: 'pay', head: headOf(5), at: at(-30), by: 'dave' } })]), /already paid for this head/],
  ['another PR holds the slot', (e) => setState(e, [itemOf(5), itemOf(6)], { holder: { pr: 6, head: headOf(6), at: at(-1), session: 's1' } }), /PR 6 holds the free slot/],
];
for (const [label, seed, why] of PAY_REFUSALS) {
  test(`M2: decide pay is refused when ${label}: exit 2, no verdict read, no post, no ledger row, same bytes`, () => {
    const e = setup('m2');
    setWorld(e, { 5: prOf(5), 6: prOf(6) });
    seed(e);
    const before = digest(e.statePath);
    let reads = 0;
    const r = run(e, payArgv(5), { checkPr: () => { reads += 1; return ALLOW(5); } });
    assert.equal(r.code, 2);
    assert.match(r.json.reason, why);
    assert.doesNotMatch(r.json.reason, /\/slot/, 'the refusal names no typed command');
    assert.deepEqual([reads, posts(e).length, ledgerRows(e).length], [0, 0, 0]);
    assert.equal(digest(e.statePath), before);
  });
}

// Minor 3. Breaks if payRefusal refuses on any holder: a holder past holder_max_min no longer blocks pay, and its item is settled, not stranded.
test('M2: a holder past holder_max_min no longer blocks pay; its PR is requeued and the pay goes out', () => {
  const e = setup('m2old');
  setWorld(e, { 5: prOf(5), 6: prOf(6) });
  setState(e, [itemOf(5), itemOf(6, { state: 'posted', posts: 0 })], { holder: { pr: 6, head: headOf(6), at: at(-25), session: 's1' } });
  const r = run(e, payArgv(5), { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 0);
  assert.deepEqual([posts(e).length, ledgerRows(e).length, stateOf(e).holder.pr], [1, 1, 5]);
  assert.deepEqual([itemIn(e, 6).state, itemIn(e, 6).posts], ['queued', 1]);
});

// Control for Minor 3. Breaks if the age check is off by the wrong side: a holder inside holder_max_min still refuses.
test('M2: a holder just inside holder_max_min still blocks pay', () => {
  const e = setup('m2new');
  setWorld(e, { 5: prOf(5), 6: prOf(6) });
  setState(e, [itemOf(5), itemOf(6, { state: 'posted' })], { holder: { pr: 6, head: headOf(6), at: at(-19), session: 's1' } });
  const r = run(e, payArgv(5), { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /PR 6 holds the free slot/);
  assert.equal(posts(e).length, 0);
});

// Minor 4. Breaks if expireHolder counts a failed paid POST as a post: nothing went out, so a later free post must not reach stuck at 2.
test('M3: a failed paid POST does not count toward the 2-post limit when its holder expires', () => {
  const e = setup('m3c');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5, { posts: 1 })]);
  const r = run(e, payArgv(5), { checkPr: () => ALLOW(5), gh: { failPost: true } });
  assert.equal(r.code, 2);
  assert.equal(stateOf(e).holder.failed, true);
  const late = run(e, ['tick', '--json'], { now: at(25) });
  assert.equal(late.code, 0);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).posts, stateOf(e).holder], ['queued', 1, null]);
});

// M2. Breaks if the second pay on one head is allowed: only one paid post and one ledger row may exist.
test('M2: a second /slot pay on the same head posts nothing', () => {
  const e = setup('m2b');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  assert.equal(run(e, payArgv(5), { checkPr: () => ALLOW(5) }).code, 0);
  assert.equal(run(e, payArgv(5), { checkPr: () => ALLOW(5), now: at(1) }).code, 2);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [1, 1]);
});

// M3. Breaks if the POST runs before the ledger write: with a ledger that cannot be written, a post must not be made.
test('M3: when the ledger row cannot be written no paid post is made and the item is unchanged', () => {
  const e = setup('m3');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  mkdirSync(e.ledgerPath);
  const before = digest(e.statePath);
  const r = run(e, payArgv(5), { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 2);
  assert.deepEqual(posts(e), []);
  assert.equal(digest(e.statePath), before);
});

// M3. Breaks if the ledger row and the posted state are written after the POST: a failed POST (maybe landed) must leave both, so the count errs high.
test('M3: when the paid POST fails the round stays counted and the item stays posted with the holder', () => {
  const e = setup('m3b');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, payArgv(5), { checkPr: () => ALLOW(5), gh: { failPost: true } });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /paid post failed.*counted.*20 minutes/);
  assert.equal(ledgerRows(e).length, 1);
  assert.deepEqual([itemIn(e, 5).state, stateOf(e).holder.pr], ['posted', 5]);
});

// Breaks if a verdict read error (exit 2 from checkPr) is treated as ALLOW or ESCALATE.
test('decide pay with no verdict gives exit 2 and posts nothing', () => {
  const e = setup('f14c');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: () => ({ exitCode: 2, verdict: null, reason: 'gh failed' }) });
  assert.equal(r.code, 2);
  assert.deepEqual(posts(e), []);
  assert.equal(existsSync(e.ledgerPath), false);
});

// F23. Breaks if drop ignores --reason or the SAMPLE check for sample-ttl.
test('F23: drop --reason sample-ttl removes a SAMPLE and the row shows the reason; on a HIGH item it exits 2 and changes nothing', () => {
  const e = setup('f23');
  setState(e, [itemOf(5, { band: 'SAMPLE' }), itemOf(6)], { holder: { pr: 5, head: headOf(5), at: at(-1), session: 's1' } });
  const ok = run(e, ['drop', '--pr', '5', '--reason', 'sample-ttl', '--json']);
  assert.deepEqual([ok.code, ok.json.dropped], [0, true]);
  assert.deepEqual([itemIn(e, 5).state, itemIn(e, 5).dropReason, stateOf(e).holder], ['dropped', 'sample-ttl', null]);
  assert.equal(run(e, ['list', '--json']).json.rows.find((x) => x.pr === 5).dropReason, 'sample-ttl');
  const before = digest(e.statePath);
  const no = run(e, ['drop', '--pr', '6', '--reason', 'sample-ttl', '--json']);
  assert.equal(no.code, 2);
  assert.equal(digest(e.statePath), before);
});

// Breaks if dropping a PR that is not in the queue is an error: the shadow sync calls drop for items that may already be gone.
test('drop on an absent PR is ok with dropped false, and drop with another reason works on any band', () => {
  const e = setup('drop-absent');
  setState(e, [itemOf(6)]);
  const gone = run(e, ['drop', '--pr', '77', '--reason', 'sample-ttl', '--json']);
  assert.deepEqual([gone.code, gone.json.ok, gone.json.dropped], [0, true, false]);
  const hand = run(e, ['drop', '--pr', '6', '--reason', 'dave dropped it', '--json']);
  assert.deepEqual([hand.json.dropped, itemIn(e, 6).dropReason], [true, 'dave dropped it']);
});

// --- O1: the tick output contract the mod parser reads ---------------------------------------------------------

const FIXTURE_SCENARIOS = {
  'tick-queued.json': () => ({ world: { 900: prOf(900, { comments: [limitNotice(900, 12, T0)] }) }, items: [itemOf(900, { state: 'opening', queuedAt: 0, addedAt: at(-5) })], state: {}, o: {} }),
  'tick-posted.json': () => ({ world: { 900: prOf(900), 901: prOf(901) }, items: [itemOf(901, { band: 'CRITICAL', queuedAt: at(-20) }), itemOf(900, { queuedAt: at(-10) })], state: {}, o: {} }),
  'tick-timeout.json': () => ({ world: { 900: prOf(900) }, items: [itemOf(900, { queuedAt: at(-61) })], state: BUSY(), o: {} }),
  'tick-ask.json': () => ({ world: { 901: prOf(901) }, items: [itemOf(901, { band: 'CRITICAL', queuedAt: at(-31) })], state: BUSY(), o: { checkPr: (pr) => ALLOW(pr) } }),
};

// O1. Breaks if the tick JSON drifts from the committed fixtures that the mod parser tests read (add, rename or drop a field).
for (const [file, build] of Object.entries(FIXTURE_SCENARIOS)) {
  test(`O1: ${file} equals the tick output of its scenario`, () => {
    const e = setup('o1');
    const sc = build();
    setWorld(e, sc.world);
    setState(e, sc.items, sc.state);
    const r = run(e, ['tick', '--json'], sc.o);
    assert.equal(r.code, 0);
    const target = path.join(FIX, file);
    if (process.env.SLOT_QUEUE_UPDATE_FIXTURES === '1') writeFileSync(target, `${JSON.stringify(r.json, null, 2)}\n`);
    assert.deepEqual(r.json, JSON.parse(readFileSync(target, 'utf8')));
  });
}

// --- E2E-1: the whole queue, two sessions, one state file, a stub clock ------------------------------------------

// E2E-1. Breaks if any step of the queue story changes: order, ask, post, holder, time-out, done, or the single post.
test('E2E-1: two sessions run the queue from the first add to the review, and one post is made', async () => {
  const e = setup('e2e');
  const out = process.env.SLOT_QUEUE_E2E_OUT;
  const note = (label, r) => { if (out) appendFileSync(out, `## ${label}\n${r.stdout ?? JSON.stringify(r.json)}\n`); };
  if (out) writeFileSync(out, `# free-slot queue E2E-1, stub clock t0 = ${iso(T0)}\n`);
  const step = async (label, argv, o) => { const r = await child(e, argv, o); note(label, r); assert.equal(r.code, 0, `${label}: ${r.stderr}`); return r.json; };
  const world = { 900: prOf(900), 901: prOf(901) };
  setWorld(e, world);
  await step('t+0 A: add #900 HIGH', addArgv(900, 'HIGH'), { now: at(0) });
  world[900].comments = [limitNotice(900, 12, at(5))];
  setWorld(e, world);
  const t5 = await step('t+5 A: tick, limit notice on #900', ['tick', '--json'], { now: at(5) });
  assert.equal(toasts(t5)[0].text, 'PR #900: queued for the free CodeRabbit slot, 1 of 1. Next slot in about 12 minutes.');
  const t7 = await step('t+7 B: tick inside the dedupe', ['tick', '--json'], { now: at(7) });
  assert.equal(t7.effective, false);
  const callsBefore = readFileSync(e.callsPath, 'utf8').split('\n').filter(Boolean).length;
  await step('t+7 B: tick again', ['tick', '--json'], { now: at(8) });
  assert.equal(readFileSync(e.callsPath, 'utf8').split('\n').filter(Boolean).length, callsBefore);
  await step('t+12 A: add #901 CRITICAL', addArgv(901, 'CRITICAL'), { now: at(12) });
  world[901].comments = [limitNotice(901, 54, at(12))];
  setWorld(e, world);
  await step('t+12 A: tick, limit notice on #901', ['tick', '--json'], { now: at(12) });
  const t16 = await step('t+16 B: list', ['list', '--json'], { now: at(16) });
  assert.deepEqual(t16.rows.map((r) => r.pr), [901, 900]);
  const t42 = await step('t+42 A: tick, the 30-minute ask', ['tick', '--json'], { now: at(42), verdict: ALLOW(901) });
  assert.deepEqual(toasts(t42).map((a) => a.pr), [901]);
  assert.match(toasts(t42)[0].text, /Paid round \$2\.75 .*Dave answers the question the session asks/);
  assert.equal(posts(e).length, 0);
  const t66 = await step('t+66 A: tick, the slot is free', ['tick', '--json'], { now: at(66), verdict: ALLOW(901) });
  assert.deepEqual(posts(e), [{ pr: 901, body: '@coderabbitai review' }]);
  assert.deepEqual(toasts(t66).map((a) => a.pr).sort(), [900, 901]);
  const t72 = await step('t+72 new process: the holder is fresh', ['tick', '--json'], { now: at(72) });
  assert.equal(posts(e).length, 1);
  assert.equal(toasts(t72).length, 0);
  world[901].reviews = [review(901, at(79))];
  setWorld(e, world);
  const t80 = await step('t+80 B: tick, #901 is reviewed', ['tick', '--json'], { now: at(80) });
  assert.match(toasts(t80)[0].text, /PR #901: CodeRabbit reviewed head/);
  const final = stateOf(e);
  if (out) appendFileSync(out, `## final state file\n${JSON.stringify(final, null, 2)}\n## post log\n${readFileSync(e.logPath, 'utf8')}`);
  assert.deepEqual(final.items.map((i) => [i.pr, i.state]), [[900, 'timed-out'], [901, 'done']]);
  assert.equal(final.holder, null);
  assert.equal(posts(e).length, 1);
});
