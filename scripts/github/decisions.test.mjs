// Tests for lib/decisions.mjs: the store of offers and decisions behind the pathway-flow-v2 questions.
// Run: node --test scripts/github/decisions.test.mjs
// Every test points CCV3_DECISIONS_FILE at a temp folder, so the live store under ~/.claude/state is never read or written.
//
// How the unit can fail, and the test that catches it:
//   a label that is not an exact label of the open offer records a decision (case, prefix, space, free text)  -> D1
//   a record with no offer, or for another step, key or head, is accepted                                      -> D2
//   a decision is read for another head, key or step than the one it was recorded for                           -> D3
//   decisionUse leaves the decision, so one tap pays twice                                                     -> D4
//   the offer stays open after a record, so a second answer overwrites the first tap                           -> D5
//   a new offer keeps an old decision (no fresh tap), or resets the miss counter (the 2 re-asks never end)     -> D6
//   the miss counter stops at the wrong count, or survives a record                                            -> D7
//   two processes write at once and one update is lost                                                         -> D8
//   a corrupt store file crashes a read, or blocks every later write                                           -> D9
//   a malformed offer is stored                                                                                -> D10
//   an offer older than a week still counts                                                                    -> D11
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, 'lib', 'decisions.mjs');
const load = () => import(pathToFileURL(MODULE).href);

const HEAD = 'a'.repeat(40);
const KEY = 'Rev4nchist/Continuous-Claude-v3#349';
const OPTIONS = [{ label: 'Land now (Recommended)', description: 'Runs land-pr.ps1.' }, { label: 'Keep open', description: 'Nothing runs.' }];
const spec = (options = OPTIONS) => ({ header: 'Land', question: 'Land it?', options });
const fresh = () => { process.env.CCV3_DECISIONS_FILE = path.join(mkdtempSync(path.join(os.tmpdir(), 'decisions-')), 'decisions.json'); return process.env.CCV3_DECISIONS_FILE; };
const triple = (over = {}) => ({ step: 'land', key: KEY, head: HEAD, ...over });
const offer = (d, over = {}) => d.offerWrite({ ...triple(), spec: spec(), tree: 't'.repeat(40), cwd: '/x', ...over });

test('D1: only an exact label of the open offer records', async () => {
  fresh();
  const d = await load();
  assert.equal(offer(d).ok, true);
  for (const bad of ['land now (Recommended)', 'Land now', 'Land now (Recommended) ', ' Land now (Recommended)', 'yes', '', 'Keep', 7, null, undefined]) {
    const r = d.decisionRecord({ ...triple(), label: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.reason, 'string');
  }
  assert.equal(d.decisionRead(triple()), null, 'nothing was recorded');
  assert.deepEqual(d.decisionRecord({ ...triple(), label: 'Keep open' }), { ok: true });
  assert.equal(d.decisionRead(triple()).label, 'Keep open');
});

test('D2: no offer, or an offer for another step, key or head, records nothing', async () => {
  fresh();
  const d = await load();
  assert.equal(d.decisionRecord({ ...triple(), label: 'Keep open' }).ok, false, 'no offer at all');
  offer(d);
  for (const over of [{ step: 'open-pr' }, { key: `${KEY}0` }, { head: 'b'.repeat(40) }]) {
    assert.equal(d.decisionRecord({ ...triple(over), label: 'Keep open' }).ok, false, JSON.stringify(over));
  }
  assert.equal(d.decisionRecord({ ...triple({ head: HEAD.toUpperCase() }), label: 'Keep open' }).ok, true, 'a head is compared without case');
});

test('D3: a decision is bound to its step, key and head', async () => {
  fresh();
  const d = await load();
  offer(d);
  d.decisionRecord({ ...triple(), label: 'Land now (Recommended)' });
  assert.equal(d.decisionRead(triple({ head: 'b'.repeat(40) })), null);
  assert.equal(d.decisionRead(triple({ key: 'x#1' })), null);
  assert.equal(d.decisionRead(triple({ step: 'review' })), null);
  const got = d.decisionRead(triple());
  assert.equal(got.label, 'Land now (Recommended)');
  assert.ok(!Number.isNaN(Date.parse(got.at)), 'at is an ISO time');
});

test('D4: decisionUse uses the decision up', async () => {
  fresh();
  const d = await load();
  offer(d);
  d.decisionRecord({ ...triple(), label: 'Land now (Recommended)' });
  assert.deepEqual(d.decisionUse(triple()), { ok: true });
  assert.equal(d.decisionRead(triple()), null);
  assert.equal(d.decisionUse(triple()).ok, false, 'nothing left to use');
});

test('D5: a record closes the offer, so a second answer cannot replace the first tap', async () => {
  fresh();
  const d = await load();
  offer(d);
  assert.equal(d.decisionRecord({ ...triple(), label: 'Land now (Recommended)' }).ok, true);
  assert.equal(d.decisionRecord({ ...triple(), label: 'Keep open' }).ok, false);
  assert.equal(d.decisionRead(triple()).label, 'Land now (Recommended)');
});

test('D6: a new offer clears an old decision and keeps the miss count', async () => {
  fresh();
  const d = await load();
  offer(d);
  d.decisionRecord({ ...triple(), label: 'Land now (Recommended)' });
  offer(d);
  assert.equal(d.decisionRead(triple()), null, 'a new question needs a new tap');
  d.missBump(triple());
  offer(d);
  assert.equal(d.missCount(triple()), 1, 'a re-ask of the same question does not reset the count');
});

test('D7: the miss counter runs 1, 2, 3 and a record or a use resets it', async () => {
  fresh();
  const d = await load();
  assert.equal(d.MAX_REASKS, 2);
  assert.equal(d.missCount(triple()), 0);
  assert.deepEqual([d.missBump(triple()), d.missBump(triple()), d.missBump(triple())], [1, 2, 3]);
  assert.equal(d.missCount(triple()), 3);
  assert.equal(d.missCount(triple({ head: 'b'.repeat(40) })), 0, 'another head has its own count');
  offer(d);
  d.decisionRecord({ ...triple(), label: 'Keep open' });
  assert.equal(d.missCount(triple()), 0, 'a record resets it');
  d.missBump(triple());
  d.decisionUse(triple());
  assert.equal(d.missCount(triple()), 0, 'a use resets it');
});

test('D7b: a miss count older than an hour is dropped, so a stop does not block the PR for good', async () => {
  const file = fresh();
  const d = await load();
  d.missBump(triple());
  d.missBump(triple());
  d.missBump(triple());
  const store = JSON.parse(readFileSync(file, 'utf8'));
  for (const m of Object.values(store.misses)) m.at = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  writeFileSync(file, JSON.stringify(store));
  assert.equal(d.missCount(triple()), 0);
  assert.equal(d.missBump(triple()), 1, 'the next miss starts a new count');
});

test('D8: parallel writers lose no update', async () => {
  const file = fresh();
  const code = `import(${JSON.stringify(pathToFileURL(MODULE).href)}).then((d) => { const r = d.offerWrite({ step: 'land', key: 'k#' + process.argv[1], head: ${JSON.stringify(HEAD)}, spec: ${JSON.stringify(spec())}, tree: 't', cwd: '/x' }); process.exit(r.ok ? 0 : 1); });`;
  const run = (n) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', code, String(n)], { env: { ...process.env, CCV3_DECISIONS_FILE: file }, stdio: 'ignore', windowsHide: true });
    p.on('exit', (c) => resolve(c));
  });
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
  assert.deepEqual(codes, Array(8).fill(0));
  const d = await load();
  assert.equal(d.offerList().length, 8, 'all eight offers are in the store');
});

test('D9: a corrupt store reads as empty and the next write repairs it', async () => {
  const file = fresh();
  const d = await load();
  writeFileSync(file, '{ not json');
  assert.equal(d.decisionRead(triple()), null);
  assert.equal(d.missCount(triple()), 0);
  assert.equal(offer(d).ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('D10: a malformed offer is refused and stored nowhere', async () => {
  fresh();
  const d = await load();
  const one = [OPTIONS[0]];
  const five = Array.from({ length: 5 }, (_, i) => ({ label: `o${i}`, description: '' }));
  for (const over of [{ step: 'push' }, { key: '' }, { head: '' }, { spec: null }, { spec: spec(one) }, { spec: spec(five) }, { spec: spec([{ label: 'a' }, { label: 'a' }]) }, { spec: spec([{ label: 'a' }, { label: 7 }]) }]) {
    assert.equal(offer(d, over).ok, false, JSON.stringify(over));
  }
  assert.deepEqual(d.offerList(), []);
  for (const step of ['ship', 'open-pr', 'review', 'land', 'paid-round']) assert.equal(offer(d, { step }).ok, true, step);
});

test('D11: an offer older than a week is dropped on the next write', async () => {
  const file = fresh();
  const d = await load();
  offer(d);
  const store = JSON.parse(readFileSync(file, 'utf8'));
  for (const o of Object.values(store.offers)) o.at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  writeFileSync(file, JSON.stringify(store));
  offer(d, { step: 'review' });
  assert.deepEqual(d.offerList().map((o) => o.step), ['review']);
});

// A re-ask at a new head (a fix push) must not leave the old head's offer open: a stale tap would record for a head nobody asked about.
//   an older open offer of the same step and key stays open beside the new one      -> D12
//   a tap for the old head records after the new offer is written                   -> D12
//   the new offer closes an offer of another step or key                            -> D12
test('D12: offerWrite at a new head closes the older open offers of the same step and key, and only those', async () => {
  fresh();
  const d = await load();
  const B = 'b'.repeat(40);
  assert.equal(offer(d).ok, true);
  assert.equal(offer(d, { step: 'review' }).ok, true, 'another step, same key');
  assert.equal(offer(d, { key: 'x#1' }).ok, true, 'same step, another key');
  assert.equal(d.offerList().length, 3);
  assert.equal(offer(d, { head: B }).ok, true);
  const open = d.offerList().map((o) => `${o.step}|${o.key}|${o.head}`).sort();
  assert.deepEqual(open, [`land|${KEY}|${B}`, `land|x#1|${HEAD}`, `review|${KEY}|${HEAD}`].sort(), 'the land offer at HEAD is closed; the other two stay open');
  assert.deepEqual(d.decisionRecord({ ...triple(), label: 'Keep open' }), { ok: false, reason: 'no-open-offer' });
  assert.equal(d.decisionRead(triple()), null, 'the old tap records nothing');
  assert.deepEqual(d.decisionRecord({ ...triple({ head: B }), label: 'Keep open' }), { ok: true });
});
