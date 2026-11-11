// Tests for lib/board-check.mjs (design B.5, contract point 3 open point 3: requests (a) and (b)).
// Failure modes (B1-B4): a plain done passes; an edge difference is missed one-sided; a pack SHA is flagged or a shared SHA
// passes; a SHA that touches none of the lane's files passes. Each other rule of the design table gets one test too.
// Run: node --test scripts/review-engine/board-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBoard, renderBoardCheck } from './lib/board-check.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row, edge, life } from './fixtures/rows.fixture.mjs';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const MAP = buildMap({
  lanes: [{ id: 're-a' }, { id: 're-b', wave: 1, deps: ['re-a'] }, { id: 're-p1' }, { id: 're-p2' }, { id: 're-nodocs', owns: [] }],
  externals: [{ id: 'hf-x' }],
  packs: [{ lanes: ['re-p1', 're-p2'], branch: 're/re-p1' }],
});
const base = () => [
  row('re-a'), row('re-b'), row('re-p1'), row('re-p2', { branch: 're/re-p1' }), row('re-nodocs'), row('hf-x'),
];
const EDGES = [edge('re-b', 're-a')];
const swap = (rows, id, over) => rows.map((r) => (r.id === id ? row(id, { ...r, ...over }) : r));
const merged = (id, sha, over = {}) => ({
  state: 'done', met: true, landed_sha: sha, last_life: life(10, 'done', { state: 'done', merged: sha, main: sha }), ...over, id,
});
const done = (rows, id, sha = SHA, over = {}) => swap(rows, id, merged(id, sha, over));
const check = (over = {}) => checkBoard({
  model: MAP.model, facts: MAP.facts, rows: base(), foreign: [], edges: EDGES, shaFiles: {}, board: 'continuous-claude', ...over,
});
const rules = (res) => res.errors.map((e) => e.rule);
const noteRules = (res) => res.notes.map((n) => n.rule);

test('B0 a board that matches the map has no error and no note', () => {
  const res = check();
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.notes, []);
});

test('B1 a done lane that is not met is an error; a met one is not', () => {
  const plain = check({ rows: swap(base(), 're-a', { state: 'done', met: false }) });
  assert.deepEqual(plain.errors.map((e) => [e.rule, e.id]), [['done-not-met', 're-a']]);
  const ok = check({ rows: done(base(), 're-a'), shaFiles: { [SHA]: ['re-a.mjs'] } });
  assert.deepEqual(ok.errors, []);
});

test('B2 a missing edge and an extra edge are both errors', () => {
  const missing = check({ edges: [] });
  assert.deepEqual(missing.errors.map((e) => [e.rule, e.id]), [['edge-missing', 're-b']]);
  assert.match(missing.errors[0].message, /re-b -> re-a/);
  const extra = check({ edges: [...EDGES, edge('re-a', 'hf-x')] });
  assert.deepEqual(extra.errors.map((e) => [e.rule, e.id]), [['edge-extra', 're-a']]);
  assert.match(extra.errors[0].message, /re-a -> hf-x/);
});

test('B2b an edge of a lane that is not in the map is not judged', () => {
  assert.deepEqual(check({ edges: [...EDGES, edge('re-old', 're-a')] }).errors, []);
});

test('B3 one SHA on the two lanes of a pack passes; on two other lanes it is an error', () => {
  const pack = done(done(base(), 're-p1'), 're-p2');
  assert.deepEqual(check({ rows: pack, shaFiles: { [SHA]: ['re-p1.mjs', 're-p2.mjs'] } }).errors, []);
  const two = done(done(base(), 're-a'), 're-b');
  const res = check({ rows: two, shaFiles: { [SHA]: ['re-a.mjs', 're-b.mjs'] } });
  assert.deepEqual(rules(res), ['shared-sha']);
  assert.match(res.errors[0].message, /re-a, re-b/);
});

test('B3b a pack lane and a lane outside the pack that share a SHA is an error; two different SHAs pass', () => {
  const mixed = done(done(base(), 're-p1'), 're-a');
  assert.deepEqual(rules(check({ rows: mixed, shaFiles: { [SHA]: ['re-p1.mjs', 're-a.mjs'] } })), ['shared-sha']);
  const apart = done(done(base(), 're-a'), 're-b', SHA2);
  assert.deepEqual(check({ rows: apart, shaFiles: { [SHA]: ['re-a.mjs'], [SHA2]: ['re-b.mjs'] } }).errors, []);
});

test('B4 a SHA whose files touch none of the lane Owns entries is an error; the pack uses the union of its Owns', () => {
  const rows = done(base(), 're-a');
  const res = check({ rows, shaFiles: { [SHA]: ['docs/other.md'] } });
  assert.deepEqual(res.errors.map((e) => [e.rule, e.id]), [['sha-no-owns', 're-a']]);
  const pack = done(base(), 're-p1');
  assert.deepEqual(check({ rows: pack, shaFiles: { [SHA]: ['re-p2.mjs'] } }).errors, []);
  assert.deepEqual(rules(check({ rows: pack, shaFiles: { [SHA]: ['re-a.mjs'] } })), ['sha-no-owns']);
  assert.deepEqual(rules(check({ rows, shaFiles: { [SHA]: [] } })), ['sha-no-owns']);
});

test('B4b a SHA that git could not read is a note, not an error; so is a lane with no Owns entry in git', () => {
  const rows = done(base(), 're-a');
  for (const shaFiles of [{}, { [SHA]: null }]) {
    const res = check({ rows, shaFiles });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(noteRules(res), ['sha-unchecked']);
  }
  const bare = check({ rows: done(base(), 're-nodocs'), shaFiles: { [SHA]: ['x.md'] } });
  assert.deepEqual(bare.errors, []);
  assert.deepEqual(noteRules(bare), ['sha-no-owns-skipped']);
});

test('B5 a no-PR done is a note with its evidence; it skips the SHA checks because it records the main tip', () => {
  const noPr = { last_life: life(10, 'done', { state: 'done', merged: SHA, main: SHA, noPr: true, evidence: 'C:/x/.claudedocs/e2e-re-a/p.txt' }) };
  const rows = done(done(base(), 're-a', SHA, noPr), 're-b', SHA, noPr);
  const res = check({ rows, shaFiles: { [SHA]: ['docs/other.md'] } });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.notes.map((n) => [n.rule, n.id]), [['nopr', 're-a'], ['nopr', 're-b']]);
  assert.match(res.notes[0].message, /evidence C:\/x\/\.claudedocs\/e2e-re-a\/p\.txt/);
});

test('B6 a map lane or external with no card is an error; one that sits on another board is reported once', () => {
  const none = check({ rows: base().filter((r) => !['re-a', 'hf-x'].includes(r.id)) });
  assert.deepEqual(none.errors.map((e) => [e.rule, e.id]), [['no-card', 're-a'], ['no-card', 'hf-x']]);
  const other = check({ rows: base().filter((r) => r.id !== 're-a'), foreign: [{ id: 're-a', project_key: 'other-board' }] });
  assert.deepEqual(other.errors.map((e) => [e.rule, e.id]), [['card-other-board', 're-a']]);
  assert.match(other.errors[0].message, /other-board/);
});

test('B7 an edge to a lane on another board, and an edge to an id with no lane row, are errors', () => {
  const cross = check({ edges: [edge('re-b', 're-a', { dep_board: 'other' })] });
  assert.deepEqual(rules(cross), ['edge-cross-board']);
  const gone = check({ edges: [edge('re-b', 're-a', { dep_board: null })] });
  assert.deepEqual(rules(gone), ['edge-no-lane']);
});

test('B8 a Waves lane whose branch is not the seed branch is an error; the pack needs its shared branch', () => {
  assert.deepEqual(rules(check({ rows: swap(base(), 're-a', { branch: 'main' }) })), ['branch-differs']);
  assert.deepEqual(rules(check({ rows: swap(base(), 're-p2', { branch: 're/re-p2' }) })), ['branch-differs']);
  assert.deepEqual(rules(check({ rows: swap(base(), 're-a', { branch: null }) })), ['branch-differs']);
});

test('B9 a lane with an unmet hold in any state but blocked or done is an error', () => {
  const map = buildMap({ lanes: [{ id: 're-h', held: 'DP2.4' }, { id: 're-t', held: 're-h' }] });
  const run = (hState, tState = 'blocked', hMet = false) => checkBoard({
    model: map.model, facts: map.facts, foreign: [], edges: [], shaFiles: {}, board: 'continuous-claude',
    rows: [row('re-h', { state: hState, met: hMet }), row('re-t', { state: tState })],
  });
  assert.deepEqual(run('backlog').errors.map((e) => [e.rule, e.id]), [['held-open', 're-h']]);
  assert.deepEqual(run('active').errors.map((e) => e.rule), ['held-open']);
  assert.deepEqual(run('blocked').errors, []);
  assert.deepEqual(run('done', 'blocked', true).errors, []);
  const heldOpen = run('done', 'backlog', false).errors.filter((e) => e.rule === 'held-open');
  assert.deepEqual(heldOpen.map((e) => e.id), ['re-t']);
  assert.deepEqual(run('done', 'backlog', true).errors, []);
});

test('B10 a track other than review-engine is a note; an open re- card outside the map is a note; the seat and done cards are not', () => {
  const rows = [
    ...swap(base(), 're-a', { track: 'coord' }), row('re-old', { state: 'active' }), row('re-fin', { state: 'done' }),
    row('re-program', { state: 'active' }),
  ];
  const res = check({ rows });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.notes.map((n) => [n.rule, n.id]), [['track-differs', 're-a'], ['not-in-map', 're-old']]);
  assert.match(res.notes[1].message, /re-old active/);
});

test('B11 renderBoardCheck prints FAIL and NOTE lines and the result', () => {
  const res = check({ edges: [], rows: [...swap(base(), 're-a', { track: 'coord' }), row('re-old', { state: 'active' })] });
  const lines = renderBoardCheck(res).split('\n');
  assert.ok(lines.some((l) => l.startsWith('FAIL edge-missing re-b -> re-a')));
  assert.ok(lines.some((l) => l.startsWith('NOTE track-differs re-a')));
  assert.equal(lines.at(-1), 'RESULT fail (1 errors)');
  assert.equal(renderBoardCheck(check()).split('\n').at(-1), 'RESULT pass (0 errors)');
});
