// Tests for lib/pack.mjs and lib/rank.mjs. They import the real functions.
// Failure modes (design D, amendment A6): a pack read from the wrong line, a pack lane that gets its own branch,
// a pack counted as two cap units, a rank that writes a wrong or unknown lane, a packages.json flattened in the wrong order.
// Run: node --test scripts/review-engine/pack-rank.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePacks, scanPacks, branchOf, packOf, unitKey } from './lib/pack.mjs';
import { rankOf } from './lib/rank.mjs';

const MAP_LINE = 'Pack: re-verifier, re-finder-v2 (branch re/re-verifier)';
const PACKS = parsePacks(`## Waves\n\n${MAP_LINE}\n`);

test('PK1 a Pack line gives one pack with its lanes and branch', () => {
  assert.deepEqual(PACKS.map(({ branch, lanes }) => ({ branch, lanes })),
    [{ branch: 're/re-verifier', lanes: ['re-verifier', 're-finder-v2'] }]);
});

test('PK2 no Pack line means no pack', () => {
  assert.deepEqual(parsePacks('## Waves\n\nsome pack of lanes\n'), []);
  assert.deepEqual(parsePacks(''), []);
});

test('PK3 several Pack lines are all read, a bullet marker and backticks are allowed, CRLF too', () => {
  const text = '- Pack: `a-one`, `a-two` (branch re/a-one)\r\nPack: b-one, b-two, b-three (branch re/b-two)\r\n';
  const packs = parsePacks(text);
  assert.deepEqual(packs.map((p) => p.lanes), [['a-one', 'a-two'], ['b-one', 'b-two', 'b-three']]);
  assert.deepEqual(packs.map((p) => p.branch), ['re/a-one', 're/b-two']);
});

test('PK4 a Pack word inside prose is not a pack line', () => {
  const prose = 'The trial Pack: re-verifier, re-finder-v2 (branch re/re-verifier) is one unit.';
  assert.deepEqual(parsePacks(prose), []);
  assert.deepEqual(scanPacks(prose).bad, []);
  assert.deepEqual(parsePacks('pack: a-one, a-two (branch re/a-one)'), []);
});

test('PK5 a line that starts with Pack: but has no readable form is reported, not dropped', () => {
  const { packs, bad } = scanPacks('Pack: re-verifier, re-finder-v2\nPack: (branch re/x)\nPack: Bad Id, x (branch re/x)\n');
  assert.deepEqual(packs, []);
  assert.deepEqual(bad.map((b) => b.line), [1, 2, 3]);
});

test('PK6 each pack carries its 1-based map line', () => {
  assert.equal(scanPacks(`a\nb\n${MAP_LINE}\n`).packs[0].line, 3);
});

test('PK7 branchOf gives a pack lane the pack branch and any other lane re/<id>', () => {
  assert.equal(branchOf('re-verifier', PACKS), 're/re-verifier');
  assert.equal(branchOf('re-finder-v2', PACKS), 're/re-verifier');
  assert.equal(branchOf('re-score-paired', PACKS), 're/re-score-paired');
  assert.equal(branchOf('re-finder-v2', []), 're/re-finder-v2');
});

test('PK8 packOf returns the pack of a lane, or null', () => {
  assert.equal(packOf('re-finder-v2', PACKS).branch, 're/re-verifier');
  assert.equal(packOf('re-score-paired', PACKS), null);
  assert.equal(packOf('re-verifier', []), null);
});

test('PK9 unitKey: two pack lanes are one unit even with a NULL or old branch', () => {
  const a = unitKey({ id: 're-verifier', branch: 're/re-verifier' }, PACKS);
  const b = unitKey({ id: 're-finder-v2', branch: null }, PACKS);
  assert.equal(a, 're/re-verifier');
  assert.equal(b, a);
});

test('PK10 unitKey: a re/ branch is the unit; NULL-branch rows are one unit each by id', () => {
  assert.equal(unitKey({ id: 're-p4-ab', branch: 're/re-p4-ab' }, PACKS), 're/re-p4-ab');
  assert.equal(unitKey({ id: 'hf-judge-precheck', branch: null }, PACKS), 'hf-judge-precheck');
  assert.equal(unitKey({ id: 'force-high-security-tier', branch: null }, PACKS), 'force-high-security-tier');
  assert.equal(unitKey({ id: 'old-card', branch: 'feature/x' }, PACKS), 'old-card');
});

// A small sample of the packages.json shape: packageOrder.ids names packages; each package has an id and lanes[].
const PACKAGES = {
  packages: [
    { id: 'PG0', name: 'Set-up', lanes: ['docs-pr-483'] },
    { id: 'A1', name: 'one', lanes: ['re-live-advisory'] },
    { id: 'A2', name: 'two', lanes: ['re-critical-model-check', 're-gold-schema'] },
    { id: 'A4', name: 'ext', lanes: ['hf-judge-precheck'] },
    { id: 'A3', name: 'gold', lanes: ['re-seed-gold-b'] },
  ],
  packageOrder: { note: 'x', ids: ['A1', 'A2', 'A4', 'A3'] },
};
const MODEL = {
  lanes: ['re-live-advisory', 're-critical-model-check', 're-gold-schema', 're-seed-gold-b', 're-other'].map((id) => ({ id })),
  externals: [{ id: 'hf-judge-precheck' }],
};

test('R1 a flat object is read as id to priority', () => {
  const res = rankOf({ 're-gold-schema': 5, 're-other': 6 }, MODEL);
  assert.deepEqual(res.rank, { 're-gold-schema': 5, 're-other': 6 });
  assert.deepEqual(res.errors, []);
});

test('R2 packages.json: packageOrder order, lane k gets 10 + k, externals take a position', () => {
  const res = rankOf(PACKAGES, MODEL);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.rank, {
    're-live-advisory': 10, 're-critical-model-check': 11, 're-gold-schema': 12, 're-seed-gold-b': 14,
  });
});

test('R2b packages.json: a package outside packageOrder.ids is not ranked (the PG0 lane is no map lane)', () => {
  assert.equal('docs-pr-483' in rankOf(PACKAGES, MODEL).rank, false);
  assert.deepEqual(rankOf(PACKAGES, MODEL).errors, []);
});

test('R3 an unknown lane id is an error, in both shapes', () => {
  assert.match(rankOf({ 're-nope': 5 }, MODEL).errors[0], /re-nope.*not a map lane/);
  const pk = structuredClone(PACKAGES);
  pk.packages[1].lanes.push('re-nope');
  assert.match(rankOf(pk, MODEL).errors[0], /re-nope.*not a map lane/);
});

test('R3b an external gets a note and no rank entry', () => {
  const res = rankOf({ 'hf-judge-precheck': 5 }, MODEL);
  assert.deepEqual(res.rank, {});
  assert.deepEqual(res.errors, []);
  assert.match(res.notes[0], /rank 5 for hf-judge-precheck is not written: externals are not seed items/);
  assert.match(rankOf(PACKAGES, MODEL).notes.join('\n'), /rank 13 for hf-judge-precheck is not written/);
});

test('R4 a value that is not a whole number from 1 to 999 is an error', () => {
  for (const bad of [0, 1000, 1.5, -2, '7', null, true]) {
    const res = rankOf({ 're-other': bad }, MODEL);
    assert.equal(res.errors.length, 1, `value ${bad}`);
    assert.deepEqual(res.rank, {});
  }
  assert.deepEqual(rankOf({ 're-other': 1, 're-gold-schema': 999 }, MODEL).errors, []);
});

test('R5 equal ranks give a note, not an error', () => {
  const res = rankOf({ 're-other': 5, 're-gold-schema': 5 }, MODEL);
  assert.deepEqual(res.errors, []);
  assert.match(res.notes.join('\n'), /rank 5 is shared by re-other, re-gold-schema/);
});

test('R6 a shape that is neither is an error; a package id missing from packages[] is an error', () => {
  for (const bad of [null, [], 'x', 7]) assert.equal(rankOf(bad, MODEL).errors.length, 1);
  const broken = { ...PACKAGES, packageOrder: { ids: ['A1', 'ZZ'] } };
  assert.match(rankOf(broken, MODEL).errors[0], /ZZ/);
});

test('R7 a lane named in two packages keeps its first rank and adds a note', () => {
  const pk = structuredClone(PACKAGES);
  pk.packages[2].lanes.push('re-live-advisory');
  const res = rankOf(pk, MODEL);
  assert.equal(res.rank['re-live-advisory'], 10);
  assert.match(res.notes.join('\n'), /re-live-advisory.*more than once/);
});
