// Tests for the paid guard in the free-slot queue (card prflow-paid-run-guard, PR 2, steps d and e).
// Run: node --test scripts/github/slot-queue-paid-cap.test.mjs
// GitHub is the fake in fixtures/slot-queue/fake-gh.mjs, the clock is a stub, the state, ledger, lock and decision store are temp files.
//
// How the unit can fail, and the test that catches it:
//   decide --kind pay runs with no cap, or a cap that is not a price (0, 3 decimals, text); --cap is accepted by another verb      -> SC1
//   a pay decision posts when the cost is over the cap, or reads the filtered count                                                 -> SC2, SC3
//   a pay decision posts while another paid post holds the paid lock                                                                -> SC4
//   `cr-paid.mjs post` (postPaidForRow) leaves the queue item unmarked, or does not use the row up                                  -> SC5
//   the queue holding a pay decision for the head does not stop `post`                                                              -> SC6
//   the queue file lock does not stop `post` first (lock order: queue, then paid)                                                   -> SC7
//   a paid CodeRabbit comment on the head with no ledger row raises no toast, raises it twice, or a ledgered, plain or older one raises it -> SC8
//   a pay decision (source cap) or `post` (source row) pays for a draft PR                                                           -> SC9
//   F6: decide --kind pay runs with no --head, a bad one, or --head on another kind                                                  -> SH1
//   F6: the PR head moved after Dave saw the price and the pay decision still posts (queue file, ledger or posts change)            -> SH2
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { main, parseArgs, postPaidForRow } from './slot-queue.mjs';
import { emptyState } from './slot-queue-model.mjs';
import { makeGh } from './fixtures/slot-queue/fake-gh.mjs';
import * as D from './lib/decisions.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 18, 0, 0);
const at = (m) => T0 + m * MIN;
const iso = (ms) => new Date(ms).toISOString();
const headOf = (pr) => String(pr).padStart(40, '0');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function setup(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `slot-paid-cap-${label}-`));
  made.push(dir);
  const e = { dir, statePath: path.join(dir, 'state', 'coderabbit-slot.json'), worldPath: path.join(dir, 'world.json'), logPath: path.join(dir, 'posts.log'), ledgerPath: path.join(dir, 'paid.jsonl') };
  mkdirSync(path.dirname(e.statePath), { recursive: true });
  process.env.CCV3_DECISIONS_FILE = path.join(dir, 'decisions.json');
  return e;
}
const prOf = (pr, over = {}) => ({ state: 'open', merged: false, head: headOf(pr), committedAt: iso(at(-300)), statuses: [], reviews: [], comments: [], files: [], ...over });
const setWorld = (e, prs) => writeFileSync(e.worldPath, JSON.stringify({ repo: REPO, prs }));
const itemOf = (pr, over = {}) => ({ pr, head: headOf(pr), band: 'HIGH', escalated: false, round: 1, state: 'queued', queuedAt: at(-5), addedAt: at(-5), posts: 0, pin: false, asked: { paid30: false, timeout60: false }, session: 's1', ...over });
const setState = (e, items, over = {}) => writeFileSync(e.statePath, JSON.stringify({ ...emptyState(), items, ...over }));
const stateOf = (e) => JSON.parse(readFileSync(e.statePath, 'utf8'));
const BUSY = () => ({ slot: { nextAt: at(600), source: 'notice', lastPostAt: 0, lastPostPr: null } });
const posts = (e) => (existsSync(e.logPath) ? readFileSync(e.logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ledgerRows = (e) => (existsSync(e.ledgerPath) ? readFileSync(e.ledgerPath, 'utf8').trim().split('\n').filter(Boolean) : []);
const ALLOW = (pr, over = {}) => ({ exitCode: 0, verdict: 'ALLOW', pr, head: headOf(pr), round: 1, files: 11, total: 11, cost: 2.75, reasons: [], comment: '@coderabbitai review --use-credits', ...over });
const human = (id, body, ms) => ({ id, user: { login: 'dave', type: 'User' }, body, created_at: iso(ms), updated_at: iso(ms) });

function run(e, argv, o = {}) {
  const lines = { out: [], err: [] };
  const code = main(argv, {
    gh: makeGh(e.worldPath, e.logPath, o.gh), now: () => o.now ?? T0, statePath: e.statePath, ledgerPath: e.ledgerPath, repo: REPO, cfg: {}, env: {},
    checkPr: o.checkPr, lockWaitMs: 300, out: (l) => lines.out.push(l), err: (l) => lines.err.push(l),
  });
  return { code, json: lines.out.length > 0 ? JSON.parse(lines.out.join('\n')) : null, err: lines.err };
}
const WAIT = () => ({ state: 'wait', nextSlotAt: iso(at(30)), checkedAt: iso(T0), minutesToSlot: 30, source: 'notice' });
const rowRun = (e, over = {}) => postPaidForRow({ pr: 5, repo: REPO }, {
  gh: makeGh(e.worldPath, e.logPath), now: () => T0, statePath: e.statePath, ledgerPath: e.ledgerPath, repo: REPO, cfg: {}, env: {}, lockWaitMs: 300,
  checkPr: () => ALLOW(5), capacity: WAIT, ...over,
});
const yes = (over = {}) => assert.deepEqual(D.paidRoundWrite({ key: D.decisionKey({ pr: 5 }), head: headOf(5), label: 'Yes, pay up to $3.00', tapAt: iso(at(-5)), entry: 'cli', ...over }), { ok: true });
const rowOf = () => D.decisionRowRead({ step: 'paid-round', key: D.decisionKey({ pr: 5 }), head: headOf(5) });

test('SC1: decide --kind pay needs --cap, a price of at most 2 decimals above 0; no other verb takes --cap', () => {
  const ok = parseArgs(['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '2.50']);
  assert.equal(ok.cap, 250);
  assert.equal(parseArgs(['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5']).cap, 500);
  for (const bad of [[], ['--cap', '0'], ['--cap', '0.00'], ['--cap', '5.123'], ['--cap', 'abc'], ['--cap', '-1'], ['--cap', '1e2'], ['--cap', '']]) {
    assert.throws(() => parseArgs(['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), ...bad]), /--cap|needs --cap/, bad.join(' '));
  }
  assert.throws(() => parseArgs(['decide', '--pr', '5', '--kind', 'wait', '--cap', '5']), /--cap is a decide --kind pay flag/);
  assert.throws(() => parseArgs(['tick', '--cap', '5']), /--cap is a decide --kind pay flag/);
});

test('SC2: a cost over the cap refuses (exit 2), posts nothing, writes no ledger row and leaves the state bytes alone; a cap of exactly the cost pays', () => {
  const e = setup('over');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const before = readFileSync(e.statePath, 'utf8');
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '2.50', '--json'], { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /The cost is \$2\.75, over the \$2\.50 Dave tapped\. Ask again\./);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [0, 0]);
  assert.equal(readFileSync(e.statePath, 'utf8'), before);
  const ok = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '2.75', '--json'], { checkPr: () => ALLOW(5) });
  assert.equal(ok.code, 0);
  assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review --use-credits' }]);
});

test('SC3: the cost is the UNFILTERED file count: 4 billable of 11 files, a cap of $1.00 refuses; the ledger row counts the 11', () => {
  const e = setup('total');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  const over = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '1.00', '--json'], { checkPr: () => ALLOW(5, { files: 4, total: 11, cost: 1 }) });
  assert.equal(over.code, 2);
  assert.match(over.json.reason, /The cost is \$2\.75, over the \$1\.00/);
  const ok = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '2.75', '--json'], { checkPr: () => ALLOW(5, { files: 4, total: 11, cost: 1 }) });
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ledgerRows(e)[0]).files, 11);
});

test('SC4: a pay decision cannot post while another paid post holds the paid lock', () => {
  const e = setup('lock');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  writeFileSync(`${e.ledgerPath}.lock`, `${process.pid} the-first-session`);
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /Another paid post is running/);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [0, 0]);
  rmSync(`${e.ledgerPath}.lock`);
});

test('SC5: postPaidForRow posts on the stored yes, marks the queue item posted with a pay decision and the holder, and uses the row up', () => {
  const e = setup('row');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  yes();
  const r = rowRun(e);
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(posts(e), [{ pr: 5, body: '@coderabbitai review --use-credits' }]);
  assert.equal(ledgerRows(e).length, 1);
  const s = stateOf(e);
  assert.deepEqual([s.items[0].state, s.items[0].decision.kind, s.holder.pr], ['posted', 'pay', 5]);
  assert.equal(rowOf(), null);
  assert.equal(rowRun(e).ok, false, 'a second post needs a second yes');
  assert.equal(posts(e).length, 1);
});

test('SC5b: a PR with no queue item still posts on the stored yes, and the queue file is not written', () => {
  const e = setup('noitem');
  setWorld(e, { 5: prOf(5) });
  setState(e, []);
  yes();
  const before = readFileSync(e.statePath, 'utf8');
  assert.equal(rowRun(e).ok, true);
  assert.equal(posts(e).length, 1);
  assert.equal(readFileSync(e.statePath, 'utf8'), before);
});

test('SC6: the queue holding a pay decision for the head refuses and uses the row up', () => {
  const e = setup('qpay');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5, { decision: { kind: 'pay', head: headOf(5), at: at(-30), by: 'dave' } })]);
  yes();
  const r = rowRun(e);
  assert.equal(r.code, 4);
  assert.match(r.text, /free-slot queue already holds a paid decision for PR #5/);
  assert.equal(posts(e).length, 0);
  assert.equal(rowOf(), null);
});

test('SC7: a held queue file lock stops `post` first: exit 5, nothing posted, the row kept (lock order: queue, then paid)', () => {
  const e = setup('qlock');
  setWorld(e, { 5: prOf(5) });
  setState(e, [itemOf(5)]);
  yes();
  writeFileSync(`${e.statePath}.lock`, `${process.pid} another-session`);
  const r = rowRun(e);
  assert.equal(r.code, 5);
  assert.match(r.text, /free-slot queue file is locked/);
  assert.equal(posts(e).length, 0);
  assert.ok(rowOf(), 'the row is kept');
  rmSync(`${e.statePath}.lock`);
});

test('SC9: a draft PR is refused on the queue pay path (decide --kind pay, source cap) and on `post` (source row): nothing posted, no ledger row, queue file unchanged', () => {
  const e = setup('draft');
  setWorld(e, { 5: prOf(5, { draft: true }) });
  setState(e, [itemOf(5)]);
  const before = readFileSync(e.statePath, 'utf8');
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: () => ALLOW(5) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /PR #5 is a draft\. A paid review goes only to an open PR that is not a draft\. Nothing was posted\./);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [0, 0]);
  assert.equal(readFileSync(e.statePath, 'utf8'), before);
  yes();
  const row = rowRun(e);
  assert.equal(row.code, 4);
  assert.match(row.text, /PR #5 is a draft\./);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [0, 0]);
  assert.equal(rowOf(), null, 'the yes is used up');
});

test('SH1: decide --kind pay needs --head, a 40-character lowercase sha; no other decide kind takes it', () => {
  const ok = parseArgs(['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '2.50']);
  assert.equal(ok.head, headOf(5));
  for (const bad of [[], ['--head', ''], ['--head', 'abc1234'], ['--head', headOf(5).toUpperCase().replace(/0/g, 'A')], ['--head', 'not-a-sha']]) {
    assert.throws(() => parseArgs(['decide', '--pr', '5', '--kind', 'pay', ...bad, '--cap', '2.50']), /--head/, bad.join(' '));
  }
  assert.throws(() => parseArgs(['decide', '--pr', '5', '--kind', 'wait', '--head', headOf(5)]), /--head is a decide --kind pay flag/);
  assert.throws(() => parseArgs(['decide', '--pr', '5', '--kind', 'drop', '--head', headOf(5)]), /--head is a decide --kind pay flag/);
});

test('SH2: the PR head moved after Dave saw the price: the pay decision refuses, posts nothing, writes no ledger row and leaves the state bytes alone', () => {
  const e = setup('moved');
  setWorld(e, { 5: prOf(5, { head: headOf(55) }) });
  setState(e, [itemOf(5)]);
  const before = readFileSync(e.statePath, 'utf8');
  const r = run(e, ['decide', '--pr', '5', '--kind', 'pay', '--head', headOf(5), '--cap', '5', '--json'], { checkPr: () => ALLOW(5, { head: headOf(55) }) });
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /head of PR #5 moved .*Ask Dave again/s);
  assert.deepEqual([posts(e).length, ledgerRows(e).length], [0, 0]);
  assert.equal(readFileSync(e.statePath, 'utf8'), before);
});

const flagToasts =(json) => json.actions.filter((a) => a.kind === 'toast' && /paid CodeRabbit request/.test(a.text));

test('SC8: a paid CodeRabbit comment on the head with no ledger row raises ONE toast; a ledgered, plain or pre-head one raises none', () => {
  const e = setup('flag');
  setWorld(e, { 5: prOf(5, { comments: [human(41, '@coderabbitai review --use-credits', at(-10))] }) });
  setState(e, [itemOf(5)], BUSY());
  const first = run(e, ['tick', '--json']);
  assert.equal(first.code, 0);
  const found = flagToasts(first.json);
  assert.equal(found.length, 1);
  assert.match(found[0].text, /PR #5: a paid CodeRabbit request is on head 0000000, and the paid ledger has no round for it/);
  assert.deepEqual(stateOf(e).items[0].flaggedPaid, [41]);
  const again = run(e, ['tick', '--json'], { now: at(30) });
  assert.equal(flagToasts(again.json).length, 0, 'once per comment');
  // A via:'post' ledger row for this PR: no flag (the flag counts per PR, F3 of the paid guard aegis pass).
  const ledgered = setup('flag-ledger');
  setWorld(ledgered, { 5: prOf(5, { comments: [human(42, '@coderabbitai review --use-credits', at(-10))] }) });
  setState(ledgered, [itemOf(5)], BUSY());
  writeFileSync(ledgered.ledgerPath, `${JSON.stringify({ ts: iso(at(-9)), date: '2026-11-02', pr: 5, head: headOf(5), files: 4, cost: 1, session: 's', via: 'post' })}\n`);
  assert.equal(flagToasts(run(ledgered, ['tick', '--json']).json).length, 0);
  // A row with no via (written by the record verb or an older script) is manual: it never counts, so the comment is flagged.
  const manual = setup('flag-manual');
  setWorld(manual, { 5: prOf(5, { comments: [human(45, '@coderabbitai review --use-credits', at(-10))] }) });
  setState(manual, [itemOf(5)], BUSY());
  writeFileSync(manual.ledgerPath, `${JSON.stringify({ ts: iso(at(-9)), date: '2026-11-02', pr: 5, head: headOf(5), files: 0, cost: 0, session: 's' })}\n`);
  assert.equal(flagToasts(run(manual, ['tick', '--json']).json).length, 1);
  // A plain request raises none. A paid one from before the head commit is counted too: no date filter any more.
  const quiet = setup('flag-quiet');
  setWorld(quiet, { 5: prOf(5, { comments: [human(43, '@coderabbitai review', at(-10))] }) });
  setState(quiet, [itemOf(5)], BUSY());
  assert.equal(flagToasts(run(quiet, ['tick', '--json']).json).length, 0);
  const early = setup('flag-early');
  setWorld(early, { 5: prOf(5, { comments: [human(44, '@coderabbitai review --use-credits', at(-400))] }) });
  setState(early, [itemOf(5)], BUSY());
  assert.equal(flagToasts(run(early, ['tick', '--json']).json).length, 1);
});
