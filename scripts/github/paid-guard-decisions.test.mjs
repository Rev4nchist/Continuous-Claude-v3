// Tests for the stamp and the paid-round row of lib/decisions.mjs (card prflow-paid-run-guard, PR 2, steps a, b and g).
// Run: node --test scripts/github/paid-guard-decisions.test.mjs
// Every test points CCV3_DECISIONS_FILE at a temp folder, so the live store under ~/.claude/state is never read or written.
//
// How the unit can fail, and the test that catches it:
//   a decision is recorded with no tapAt, or with an entry that is not the one passed (a default)                       -> PD1
//   decisionRead changes its shape (old readers and tests deepEqual { label, at })                                     -> PD2
//   decisionUse drops the stamp of the row it used, or returns a row when nobody asked                                 -> PD3
//   a label with no price, a $0 price, or a price with 3 decimals gives a cap                                          -> PD4
//   a paid-round row is written with no price, no tapAt or no entry; or the row loses the stamp it was given            -> PD5
//   a return to draft leaves a paid-round row of the PR at some head, or drops the row of another PR                    -> PD6
//   a row written by hand (no tapAt, no entry) reads as a stamp with values                                            -> PD7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = () => import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);
const ENGINE = path.join(HERE, 'pr-checkpoint.mjs');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const KEY = 'Rev4nchist/Continuous-Claude-v3#7';
const YES = 'Yes, pay up to $2.50';
const fresh = () => { process.env.CCV3_DECISIONS_FILE = path.join(mkdtempSync(path.join(os.tmpdir(), 'paid-guard-dec-')), 'decisions.json'); return process.env.CCV3_DECISIONS_FILE; };
const spec = { header: 'Paid round', question: 'Pay?', options: [{ label: 'No, keep it free (Recommended)', description: 'n' }, { label: YES, description: 'y' }] };
const triple = (over = {}) => ({ step: 'paid-round', key: KEY, head: HEAD, ...over });
const tapped = (d, entry, over = {}) => {
  assert.equal(d.offerWrite({ ...triple(over), spec }).ok, true);
  assert.deepEqual(d.decisionRecord({ ...triple(over), label: YES, ...(entry === undefined ? {} : { entry }) }), { ok: true });
};

test('PD1: decisionRecord stamps tapAt (the record time) and the entry it was given; no entry stamps null, never a default', async () => {
  const file = fresh();
  const d = await load();
  const before = Date.now();
  tapped(d, 'cli');
  let row = Object.values(JSON.parse(readFileSync(file, 'utf8')).decisions)[0];
  assert.equal(row.entry, 'cli');
  assert.equal(row.tapAt, row.at, 'tapAt is the record time');
  assert.ok(Date.parse(row.tapAt) >= before - 1000);
  tapped(d, undefined, { head: OTHER });
  row = JSON.parse(readFileSync(file, 'utf8')).decisions[`paid-round\n${KEY}\n${OTHER}`];
  assert.equal(row.entry, null);
  tapped(d, '', { head: 'c'.repeat(40) });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).decisions[`paid-round\n${KEY}\n${'c'.repeat(40)}`].entry, null, 'an empty entry is no stamp');
});

test('PD2: decisionRead keeps its { label, at } shape', async () => {
  fresh();
  const d = await load();
  tapped(d, 'cli');
  assert.deepEqual(Object.keys(d.decisionRead(triple())).sort(), ['at', 'label']);
});

test('PD3: decisionUse returns the stamp of the used row only when returnRow is true, taken before the delete', async () => {
  fresh();
  const d = await load();
  tapped(d, 'cli');
  const stamp = d.decisionRowRead(triple());
  assert.deepEqual(d.decisionUse({ ...triple(), label: YES }), { ok: true }, 'old call shape: no row');
  tapped(d, 'cli');
  const used = d.decisionUse({ ...triple(), label: YES, returnRow: true });
  assert.equal(used.ok, true);
  assert.equal(used.row.label, YES);
  assert.equal(used.row.entry, 'cli');
  assert.equal(typeof used.row.tapAt, 'string');
  assert.ok(stamp.tapAt, 'the first stamp was read');
  assert.equal(d.decisionRowRead(triple()), null, 'the row is gone');
  assert.deepEqual(d.decisionUse({ ...triple(), returnRow: true }), { ok: false, reason: 'no-decision' });
});

test('PD4: capCentsOfLabel reads "up to $X" only, with a positive price of at most 2 decimals', async () => {
  const d = await load();
  assert.equal(d.capCentsOfLabel('Yes, pay up to $2.50'), 250);
  assert.equal(d.capCentsOfLabel('CodeRabbit review (may cost up to $1.25) (Recommended)'), 125);
  assert.equal(d.capCentsOfLabel('CodeRabbit + Greptile (may cost up to $5 + 3 credits)'), 500);
  assert.equal(d.capCentsOfLabel('Pay up to $0.30'), 30);
  for (const none of ['No, keep it free', 'Stop here', 'CodeRabbit now (free slot, $0)', 'No review, land on CI ($0)', 'Keep as draft ($0)', 'Yes, pay', 'Yes, pay up to $0.00', 'Yes, pay up to $', 'Yes, pay up to 5', 'Pay about $2.50', '', null, undefined, 7]) {
    assert.equal(d.capCentsOfLabel(none), null, String(none));
  }
});

test('PD5: paidRoundWrite refuses a label with no price and a missing tapAt or entry; a good row keeps the stamp it was given and its own at', async () => {
  const file = fresh();
  const d = await load();
  const good = { key: KEY, head: HEAD, label: YES, tapAt: '2026-11-18T10:00:00.000Z', entry: 'cli' };
  for (const bad of [{ label: 'No, keep it free' }, { label: 'CodeRabbit now (free slot, $0)' }, { tapAt: null }, { tapAt: '' }, { entry: null }, { entry: '' }, { key: '' }, { head: '' }]) {
    assert.equal(d.paidRoundWrite({ ...good, ...bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(d.decisionRowRead(triple()), null, 'nothing was written');
  assert.deepEqual(d.paidRoundWrite(good), { ok: true });
  const row = d.decisionRowRead(triple());
  assert.equal(row.label, YES);
  assert.equal(row.tapAt, '2026-11-18T10:00:00.000Z');
  assert.equal(row.entry, 'cli');
  assert.notEqual(row.at, row.tapAt, 'the row keeps its own at (now) for the prune');
  assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(file, 'utf8')).decisions[`paid-round\n${KEY}\n${HEAD}`].at) < 60_000);
});

test('PD6 (G8): a return to draft (--drop-taps) removes the paid-round row of the PR at every head, and keeps another PR (7 never takes 70)', async () => {
  const file = fresh();
  const d = await load();
  const good = { label: YES, tapAt: '2026-11-18T10:00:00.000Z', entry: 'cli' };
  assert.equal(d.paidRoundWrite({ ...good, key: KEY, head: HEAD }).ok, true);
  assert.equal(d.paidRoundWrite({ ...good, key: KEY, head: OTHER }).ok, true);
  assert.equal(d.paidRoundWrite({ ...good, key: `${KEY}0`, head: HEAD }).ok, true);
  const run = spawnSync(process.execPath, [ENGINE, '--drop-taps', '--pr', '7'], { encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: file } });
  assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).dropped, 2);
  assert.equal(d.decisionRowRead(triple()), null);
  assert.equal(d.decisionRowRead(triple({ head: OTHER })), null);
  assert.ok(d.decisionRowRead(triple({ key: `${KEY}0` })), 'PR 70 keeps its row');
});

test('PD7: a row written by hand (no tapAt, no entry) reads with null stamp values', async () => {
  const file = fresh();
  const d = await load();
  writeFileSync(file, JSON.stringify({ version: 1, offers: {}, misses: {}, decisions: { [`paid-round\n${KEY}\n${HEAD}`]: { label: YES, at: new Date().toISOString(), tree: null, nonce: null } } }));
  assert.deepEqual(d.decisionRowRead(triple()).tapAt, null);
  assert.deepEqual(d.decisionRowRead(triple()).entry, null);
});
