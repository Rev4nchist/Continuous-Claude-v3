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
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

test('D13: a store whose sections are not plain objects is corrupt: it reads as empty and the next write repairs it', async () => {
  const file = fresh();
  const d = await load();
  for (const bad of [[], 'x', null, 7]) {
    for (const section of ['offers', 'decisions', 'misses']) {
      writeFileSync(file, JSON.stringify({ version: 1, offers: {}, decisions: {}, misses: {}, [section]: bad }));
      assert.equal(d.decisionRead(triple()), null, `${section}=${JSON.stringify(bad)}: read`);
      assert.deepEqual(d.offerList(), [], `${section}=${JSON.stringify(bad)}: list`);
      assert.equal(d.missCount(triple()), 0, `${section}=${JSON.stringify(bad)}: misses`);
      assert.equal(offer(d).ok, true, `${section}=${JSON.stringify(bad)}: the next write works`);
      const repaired = JSON.parse(readFileSync(file, 'utf8'));
      for (const s of ['offers', 'decisions', 'misses']) assert.ok(repaired[s] && typeof repaired[s] === 'object' && !Array.isArray(repaired[s]), `${section}=${JSON.stringify(bad)}: ${s} repaired`);
    }
  }
  // A whole-store array or string is corrupt too.
  for (const whole of ['[]', '"x"', 'null']) {
    writeFileSync(file, whole);
    assert.equal(offer(d).ok, true, `whole store ${whole}`);
  }
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

// ---- dropKey (card prflow-paid-run-guard, PR 1 taps) -------------------------------------------------------------------------------------
// How dropKey can fail, and the test that catches it:
//   it leaves a decision, an offer or a miss of a listed step and the key, at any head                              -> DK1
//   it takes the rows of another key (a prefix: PR 7 against PR 70), of another step, or of another head's key      -> DK1
//   a bad call (no step, an unknown step, no key) deletes something                                                  -> DK2
//   it needs more than one store update, so a crash between two leaves half a drop                                   -> DK3
test('DK1: dropKey removes decisions, offers and misses of the listed steps for the key at every head, and nothing else', async () => {
  const file = fresh();
  const d = await load();
  const seed = (over, label) => { assert.equal(offer(d, over).ok, true); if (label) assert.equal(d.decisionRecord({ ...triple(over), label }).ok, true); };
  const PR7 = 'Rev4nchist/Continuous-Claude-v3#7';
  const PR70 = 'Rev4nchist/Continuous-Claude-v3#70';
  for (const step of ['review', 'paid-round']) for (const head of [HEAD, 'b'.repeat(40)]) seed({ step, key: PR7, head }, 'Keep open');
  d.missBump(triple({ step: 'review', key: PR7 }));
  d.missBump(triple({ step: 'paid-round', key: PR7 }));
  seed({ step: 'review', key: PR70 }, 'Keep open');
  seed({ step: 'land', key: PR7 }, 'Keep open');
  seed({ step: 'review', key: PR7, head: 'c'.repeat(40) }); // an open offer with no tap yet
  const r = d.dropKey({ steps: ['review', 'paid-round'], key: PR7 });
  assert.equal(r.ok, true);
  const store = JSON.parse(readFileSync(file, 'utf8'));
  const left = (group) => Object.keys(store[group]).map((id) => id.split('\n').slice(0, 2).join(' '));
  for (const group of ['offers', 'decisions', 'misses']) {
    assert.ok(!left(group).some((id) => id === `review ${PR7}` || id === `paid-round ${PR7}`), `${group}: nothing of the key is left`);
  }
  assert.ok(left('decisions').includes(`review ${PR70}`), 'PR 70 keeps its tap');
  assert.ok(left('decisions').includes(`land ${PR7}`), 'the land step keeps its tap');
  assert.ok(left('offers').includes(`review ${PR70}`) && left('offers').includes(`land ${PR7}`));
  assert.equal(d.dropKey({ steps: ['review', 'paid-round'], key: PR7 }).ok, true, 'a second drop of an empty key is fine');
});

test('DK2: a bad call deletes nothing: no steps, an unknown step, no key', async () => {
  const file = fresh();
  const d = await load();
  assert.equal(offer(d).ok, true);
  assert.equal(d.decisionRecord({ ...triple(), label: 'Keep open' }).ok, true);
  const before = readFileSync(file, 'utf8');
  for (const bad of [{ steps: [], key: KEY }, { steps: ['nope'], key: KEY }, { steps: ['land'], key: '' }, { steps: 'land', key: KEY }, { key: KEY }, {}]) {
    const r = d.dropKey(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.reason, /bad-drop/);
  }
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('DK3: dropKey is one locked update: with the lock held it returns lock and changes nothing', async () => {
  const file = fresh();
  const d = await load();
  assert.equal(offer(d).ok, true);
  assert.equal(d.decisionRecord({ ...triple(), label: 'Keep open' }).ok, true);
  const before = readFileSync(file, 'utf8');
  writeFileSync(`${file}.lock`, `${process.pid} held-by-test`);
  try {
    assert.deepEqual(d.dropKey({ steps: ['land'], key: KEY }), { ok: false, reason: 'lock', detail: `the lock ${file}.lock is held by another session` });
  } finally { unlinkSync(`${file}.lock`); }
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(d.dropKey({ steps: ['land'], key: KEY }), { ok: true, dropped: 2 });
});

// ---- decisionUse: the tap that was read, and the slot at the use (fix round of PR 1 taps, CodeRabbit CLI findings F6 and F10) ------------------
// How it can fail, and the test that catches it:
//   a newer tap with the SAME label is used up by the call that read the older one (the label check cannot tell them apart)      -> DU1
//   a `check` that says no still uses the tap up, or runs outside the lock on a row that is not the stored one                   -> DU2
//   the old call shapes (no label, a label only) change: they must behave as before                                               -> DU3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tapped = async (d, label) => { assert.equal(offer(d).ok, true); assert.equal(d.decisionRecord({ ...triple(), label }).ok, true); return d.decisionRead(triple()); };

test('DU1: decisionUse with `at` refuses a newer tap of the same label (tap-changed) and keeps it; the tap that was read is used up', async () => {
  fresh();
  const d = await load();
  const first = await tapped(d, 'Keep open');
  await sleep(15); // the tap time has millisecond resolution: the second tap must differ
  const second = await tapped(d, 'Keep open');
  assert.notEqual(second.at, first.at, 'the two taps differ in time');
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open', at: first.at }), { ok: false, reason: 'tap-changed' });
  assert.deepEqual(d.decisionRead(triple()), second, 'the newer tap stays');
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open', at: second.at }), { ok: true });
  assert.equal(d.decisionRead(triple()), null);
});

test('DU2: decisionUse with `check` refuses when it says no (slot-changed) and keeps the tap; check gets the stored row', async () => {
  fresh();
  const d = await load();
  const row = await tapped(d, 'Keep open');
  const seen = [];
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open', check: (r) => { seen.push(r); return false; } }), { ok: false, reason: 'slot-changed' });
  assert.deepEqual(d.decisionRead(triple()), row, 'the tap stays');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'Keep open');
  assert.equal(seen[0].at, row.at);
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open', at: row.at, check: () => true }), { ok: true });
  assert.equal(d.decisionRead(triple()), null);
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open', check: () => false }), { ok: false, reason: 'no-decision' }, 'no row: no-decision, and check is not asked');
});

// ---- dropKey on a store that cannot be read (card prflow-paid-run-guard, PR 2 group A, item 3) ---------------------------------------------
// How it can fail, and the test that catches it (C = control: it passes before the change and pins what must stay):
//   a store that exists but cannot be read or parsed is replaced by an empty one: the taps of every other PR are lost       -> DK4
//   a store that is not there is refused (it is a good empty drop)                                                          -> DK4b (C)
//   the refusal leaks to the other writers: a corrupt store must still be repaired by the next offer (documented design D9) -> DK4c (C)
test('DK4: dropKey on a store file that exists but cannot be read, parsed or used refuses and leaves the file as it was', async () => {
  const file = fresh();
  const d = await load();
  const PR70 = 'Rev4nchist/Continuous-Claude-v3#70';
  assert.equal(offer(d, { step: 'review', key: PR70 }).ok, true);
  const good = readFileSync(file, 'utf8');
  for (const [name, text] of [['malformed JSON', '{"version":1,"decisions":'], ['an empty file', ''], ['a JSON array', '[]'], ['a section that is not an object', JSON.stringify({ version: 1, offers: [], decisions: {}, misses: {} })]]) {
    writeFileSync(file, text);
    const r = d.dropKey({ steps: ['review', 'paid-round'], key: 'Rev4nchist/Continuous-Claude-v3#7' });
    assert.equal(r.ok, false, name);
    assert.equal(r.reason, 'unreadable-store', name);
    assert.equal(readFileSync(file, 'utf8'), text, `${name}: nothing was written`);
  }
  writeFileSync(file, good);
  assert.equal(d.dropKey({ steps: ['review'], key: 'Rev4nchist/Continuous-Claude-v3#7' }).ok, true, 'a readable store drops');
  assert.equal(d.offerRead({ step: 'review', key: PR70, head: HEAD })?.open, true, 'the offer of PR 70 stays');
});

// Card coord-decisions-delete-advice: the reason of an unreadable store must not tell the reader to delete it (PR 704 removed the other such texts).
//   the detail advises deleting the store, or does not say who decides              -> DK4d
test('DK4d: the unreadable-store detail names the file, advises no delete, and says the seat or Dave decides', async () => {
  const file = fresh();
  const d = await load();
  writeFileSync(file, '{"version":1,"decisions":');
  const r = d.dropKey({ steps: ['review'], key: KEY });
  assert.equal(r.reason, 'unreadable-store');
  assert.ok(r.detail.includes(file), 'the detail names the file');
  assert.doesNotMatch(r.detail, /delet|remov|rm\b|unlink/i, 'the detail advises no delete');
  assert.match(r.detail, /repair/i, 'the detail says to repair the file');
  assert.match(r.detail, /move it aside/i, 'the detail says to move the file aside');
  assert.match(r.detail, /seat or Dave/, 'the detail says who decides');
});

test('DK4b (control): a store file that is not there is a good empty drop', async () => {
  const file = fresh();
  const d = await load();
  assert.deepEqual(d.dropKey({ steps: ['review'], key: KEY }), { ok: true, dropped: 0 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('DK4c (control): the other writers still repair a corrupt store (an offer opens on it)', async () => {
  const file = fresh();
  const d = await load();
  writeFileSync(file, '{"version":1,"decisions":');
  assert.equal(offer(d).ok, true);
  assert.equal(d.offerRead(triple())?.open, true);
});

test('DU3: the old call shapes work as before: no label, a label only, a changed label', async () => {
  fresh();
  const d = await load();
  await tapped(d, 'Keep open');
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Land now (Recommended)' }), { ok: false, reason: 'label-changed' });
  assert.deepEqual(d.decisionUse({ ...triple(), label: 'Keep open' }), { ok: true });
  await tapped(d, 'Land now (Recommended)');
  assert.deepEqual(d.decisionUse(triple()), { ok: true });
  assert.deepEqual(d.decisionUse(triple()), { ok: false, reason: 'no-decision' });
});
