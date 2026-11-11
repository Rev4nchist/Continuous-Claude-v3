// Tests for lib/diff.mjs: outsideOwnsOf (the union of Owns across a pack) and packGroup.
// Failure modes:
//   F1 the union is dropped: a pack lane's diff is flagged for its sibling's files (design D1)
//   F2 the union is too wide: a file no lane owns passes
//   F3 an empty group or Owns: none passes everything
//   F4 outsideOwns (one lane) changes behaviour
//   F5 packGroup uses the id and not the pack branch (design D2, K4), or leaves out a lane
// Run: node --test scripts/review-engine/diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap, parseOwns } from './lib/map-parse.mjs';
import { outsideOwns, outsideOwnsOf, packGroup } from './lib/diff.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/map.fixture.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const withPack = (line) => parseMap(FIXTURE.replace('## Dropped or merged lanes', `${line}\n\n## Dropped or merged lanes`));
const lane = (id, owns) => ({ id, section: { owns: parseOwns(owns).owns } });

const A = lane('a', '`src/a.mjs`, `src/a.test.mjs`');
const B = lane('b', '`docs/**`');
const NONE = lane('n', 'none');

test('F1 the union of two lanes covers both lanes files', () => {
  assert.deepEqual(outsideOwnsOf([A, B], ['src/a.mjs', 'docs/x/y.md']), []);
  assert.deepEqual(outsideOwns(A, ['src/a.mjs', 'docs/x/y.md']), ['docs/x/y.md']);
});

test('F2 a file that no lane of the group owns is outside', () => {
  assert.deepEqual(outsideOwnsOf([A, B], ['src/a.mjs', 'src/other.mjs', 'docs/ok.md']), ['src/other.mjs']);
});

test('F3 an empty group, or a group with Owns: none, has every file outside', () => {
  assert.deepEqual(outsideOwnsOf([], ['x']), ['x']);
  assert.deepEqual(outsideOwnsOf([NONE], ['x', 'y']), ['x', 'y']);
  assert.deepEqual(outsideOwnsOf([NONE, A], ['x', 'src/a.mjs']), ['x']);
});

test('F4 outsideOwns of one lane equals outsideOwnsOf of [lane]; an outside-git entry is skipped', () => {
  const top = parseMap(FIXTURE).lanes.find((l) => l.id === 'fx-top');
  const files = ['fixture/out/a.json', '.claudedocs/fx-results.md', 'elsewhere.txt'];
  assert.deepEqual(outsideOwns(top, files), outsideOwnsOf([top], files));
  assert.deepEqual(outsideOwnsOf([top], files), ['.claudedocs/fx-results.md', 'elsewhere.txt']);
  assert.deepEqual(outsideOwns({ id: 'z' }, ['q']), ['q']);
});

test('F5 packGroup: the lanes that share the branch of the id, in map order; no pack means the lane alone', () => {
  const model = withPack('Pack: fx-holder, fx-base (branch re/fx-base)');
  assert.deepEqual(packGroup(model, 'fx-holder').map((l) => l.id), ['fx-base', 'fx-holder']);
  assert.deepEqual(packGroup(model, 'fx-base').map((l) => l.id), ['fx-base', 'fx-holder']);
  assert.deepEqual(packGroup(model, 'fx-top').map((l) => l.id), ['fx-top']);
  assert.deepEqual(packGroup(parseMap(FIXTURE), 'fx-holder').map((l) => l.id), ['fx-holder']);
});

test('F5b packGroup of an external is the external; an unknown id is an empty group', () => {
  const model = parseMap(FIXTURE);
  assert.deepEqual(packGroup(model, 'fx-ext').map((l) => l.id), ['fx-ext']);
  assert.deepEqual(packGroup(model, 'nope'), []);
});

test('F1b with the pack, the Owns: none lane is clean for its sibling files, as the union rule says', () => {
  const model = withPack('Pack: fx-holder, fx-base (branch re/fx-base)');
  const group = packGroup(model, 'fx-holder');
  assert.deepEqual(outsideOwnsOf(group, ['fixture/tool.mjs']), []);
  assert.deepEqual(outsideOwns(group.find((l) => l.id === 'fx-holder'), ['fixture/tool.mjs']), ['fixture/tool.mjs']);
});
