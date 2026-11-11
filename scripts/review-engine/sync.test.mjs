// Tests for lib/sync.mjs (design B.4 with amendment A1: the seed mark is the EARLIEST object-form 'seeded' event).
// Failure modes (Z1-Z5, A1): a wave 0 lane opens before GO; a held lane opens; a lane with no stored edges opens; an owned or
// non-blocked lane is touched; a hand block after the seed is undone; a later seed (array form or program re-seed) moves the mark.
// Z6-Z10 (dry run, child failure, stale plan, --note, live run before the seed) belong to the CLI tests.
// Run: node --test scripts/review-engine/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSync, renderSync, programSeedIdOf } from './lib/sync.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row, edge, ev, life } from './fixtures/rows.fixture.mjs';

const MAP = (go = false) => buildMap({
  go,
  lanes: [
    { id: 're-w0' }, { id: 're-dep', wave: 1, deps: ['re-w0'] }, { id: 're-dep2', wave: 1, deps: ['re-w0'] },
    { id: 're-held', held: 'DP2.4' }, { id: 're-seat', held: 'seat-hold' }, { id: 're-tok', held: 're-w0' },
  ],
  externals: [{ id: 'hf-x' }],
});
const EDGES = [edge('re-dep', 're-w0'), edge('re-dep2', 're-w0')];
const ROWS = () => [
  row('re-w0'), row('re-dep', { open_dep: true, waits_on: ['re-w0'] }), row('re-dep2', { open_dep: true, waits_on: ['re-w0'] }),
  row('re-held'), row('re-seat'), row('re-tok'), row('hf-x'),
];
const SEEDED = [ev(50, null, 'seeded', { lanes: 3 }), ev(100, null, 'seeded', { lanes: 6, edges: 2 })];
const plan = ({ go = false, rows = ROWS(), edges = EDGES, seedId = 100 } = {}) => {
  const map = MAP(go);
  return planSync({ model: map.model, facts: map.facts, rows, edges, programSeedId: seedId, board: 'continuous-claude' });
};
const moves = (p) => p.moves.map((m) => m.id);
const stay = (p, id) => p.stays.find((s) => s.id === id)?.reason;
const withRow = (id, over) => ROWS().map((r) => (r.id === id ? row(id, { ...r, ...over }) : r));

test('Z1 before GO only the open-dependency lanes move; wave 0 and the external wait for GO', () => {
  const p = plan({ go: false });
  assert.deepEqual(moves(p), ['re-dep', 're-dep2']);
  assert.deepEqual(p.moves.map((m) => m.reason), ['open-dependency', 'open-dependency']);
  assert.equal(stay(p, 're-w0'), 'waits for GO');
  assert.equal(stay(p, 'hf-x'), 'waits for GO');
});

test('Z1b after GO the lanes with no open dependency move too', () => {
  const p = plan({ go: true });
  assert.deepEqual(moves(p), ['hf-x', 're-dep', 're-dep2', 're-w0']);
  assert.equal(p.moves.find((m) => m.id === 're-w0').reason, 'no-dependency, GO');
});

test('Z2 a decision, a conditional, a keyword hold and an unmet lane token each keep the lane blocked, also after GO', () => {
  const map = buildMap({
    go: true,
    lanes: [
      { id: 're-a', held: 'DP2.4' }, { id: 're-b', held: 're-q if DP2.4 = yes' }, { id: 're-c', held: 'first-flip' },
      { id: 're-d', held: 'dave-yes' }, { id: 're-e', held: 'item-trigger' }, { id: 're-f', held: 'seat-hold' }, { id: 're-g', held: 're-q' },
    ],
  });
  const rows = ['re-a', 're-b', 're-c', 're-d', 're-e', 're-f', 're-g'].map((id) => row(id)).concat(row('re-q', { state: 'done', met: false }));
  const p = planSync({ model: map.model, facts: map.facts, rows, edges: [edge('x', 'y')], programSeedId: 100, board: 'b' });
  assert.deepEqual(p.moves, []);
  assert.equal(stay(p, 're-a'), 'held DP2.4');
  assert.equal(stay(p, 're-f'), 'held seat-hold');
  assert.equal(stay(p, 're-g'), 'held re-q');
  assert.equal(p.stays.length, 7);
});

test('Z2b a lane token ends the hold only when that lane is met; the lane then follows the GO rule', () => {
  const rows = withRow('re-tok', {}).concat(row('re-w0', { state: 'done', met: true }));
  const open = rows.filter((r) => !(r.id === 're-w0' && r.state === 'blocked'));
  assert.equal(moves(plan({ go: true, rows: open })).includes('re-tok'), true);
  assert.equal(stay(plan({ go: false, rows: open }), 're-tok'), 'waits for GO');
  const unmet = open.map((r) => (r.id === 're-w0' ? row('re-w0', { state: 'done', met: false }) : r));
  assert.equal(stay(plan({ go: true, rows: unmet }), 're-tok'), 'held re-w0');
});

test('Z3 a lane whose stored edges differ from the map stays and adds an error, also when its dependency is open', () => {
  const missing = plan({ edges: [edge('re-dep2', 're-w0')] });
  assert.equal(stay(missing, 're-dep'), 'edges-differ');
  assert.deepEqual(missing.errors.map((e) => [e.rule, e.id]), [['edges-differ', 're-dep']]);
  assert.deepEqual(moves(missing), ['re-dep2']);
  const extra = plan({ go: true, edges: [...EDGES, edge('re-w0', 'hf-x')] });
  assert.equal(stay(extra, 're-w0'), 'edges-differ');
  assert.equal(moves(extra).includes('re-w0'), false);
});

test('Z4 an owned, backlog, ready, active, review or done lane is never touched and never listed', () => {
  const rows = ROWS().map((r) => {
    if (r.id === 're-w0') return row('re-w0', { owner_session_id: 'dddddddd-0000' });
    if (r.id === 're-dep') return row('re-dep', { state: 'backlog', open_dep: true });
    if (r.id === 're-dep2') return row('re-dep2', { state: 'active', owner_session_id: 'dddddddd-0000' });
    return r;
  });
  const p = plan({ go: true, rows });
  for (const id of ['re-w0', 're-dep', 're-dep2']) {
    assert.equal(moves(p).includes(id) || stay(p, id) !== undefined, false, id);
  }
});

test('Z4b a map lane with no card is skipped, not an error', () => {
  const p = plan({ go: true, rows: ROWS().filter((r) => r.id !== 're-w0') });
  assert.equal(moves(p).includes('re-w0') || stay(p, 're-w0') !== undefined, false);
});

test('Z5 a lane blocked by hand after the seed stays blocked, also with an open dependency, and also after GO', () => {
  for (const last of [life(500, 'state_changed', { state: 'blocked' }), life(500, 'kanban', { kind: 'state', to: 'blocked' })]) {
    const rows = withRow('re-dep', { last_life: last });
    assert.equal(stay(plan({ rows }), 're-dep'), 'hand-blocked');
    assert.equal(stay(plan({ rows, go: true }), 're-dep'), 'hand-blocked');
  }
});

test('Z5b a block made before the seed, a later change that is not a block, and the seed event itself do not protect', () => {
  assert.deepEqual(moves(plan({ rows: withRow('re-dep', { last_life: life(70, 'state_changed', { state: 'blocked' }) }) })), ['re-dep', 're-dep2']);
  assert.equal(moves(plan({ rows: withRow('re-dep', { last_life: life(500, 'state_changed', { state: 'ready' }) }) })).includes('re-dep'), true);
  assert.equal(moves(plan({ rows: withRow('re-dep', { last_life: life(100, 'state_changed', { state: 'blocked' }) }) })).includes('re-dep'), true);
});

test('A1a the seed mark is the earliest object-form seeded event: an array-form seed after a hand block leaves the lane blocked', () => {
  const events = [...SEEDED, ev(600, null, 'seeded', { lanes: 1 })];
  assert.equal(programSeedIdOf(events), 100);
  const rows = withRow('re-dep', { last_life: life(500, 'state_changed', { state: 'blocked' }) });
  assert.equal(stay(plan({ rows, seedId: programSeedIdOf(events) }), 're-dep'), 'hand-blocked');
});

test('A1b a program re-seed after a hand block leaves the lane blocked', () => {
  const events = [...SEEDED, ev(700, null, 'seeded', { lanes: 61, edges: 151 })];
  assert.equal(programSeedIdOf(events), 100);
  const rows = withRow('re-dep', { last_life: life(500, 'state_changed', { state: 'blocked' }) });
  assert.equal(stay(plan({ rows, seedId: programSeedIdOf(events) }), 're-dep'), 'hand-blocked');
});

test('A1c an array-form seed before the program seed is not the mark: a block between them does not protect', () => {
  assert.equal(programSeedIdOf(SEEDED), 100);
  const rows = withRow('re-dep', { last_life: life(70, 'state_changed', { state: 'blocked' }) });
  assert.equal(moves(plan({ rows, seedId: programSeedIdOf(SEEDED) })).includes('re-dep'), true);
});

test('A1d programSeedIdOf ignores other kinds and unordered input, and gives null for no object-form seed', () => {
  assert.equal(programSeedIdOf([ev(9, null, 'seeded', { lanes: 61, edges: 151 }), ev(3, null, 'seeded', { lanes: 2, edges: 0 })]), 3);
  assert.equal(programSeedIdOf([ev(1, 'x', 'claimed', { edges: 1 }), ev(2, null, 'seeded', { lanes: 3 })]), null);
  assert.equal(programSeedIdOf([]), null);
});

test('A1e no program seed event refuses the plan with exit 3 and the exact text; nothing is planned', () => {
  const p = plan({ seedId: null });
  assert.deepEqual(p.refusal, { exit: 3, message: 'refused: no program seed event on board continuous-claude; run the seed first' });
  assert.deepEqual([p.moves, p.stays, p.errors], [[], [], []]);
});

test('Z10a no stored edge for any map lane refuses with exit 3 while the map has edges; a map with no edge is not refused', () => {
  const p = plan({ edges: [] });
  assert.deepEqual(p.refusal, { exit: 3, message: 'refused: no stored edges for the map lanes; run the seed first' });
  const none = buildMap({ go: true, lanes: [{ id: 're-a' }] });
  const ok = planSync({ model: none.model, facts: none.facts, rows: [row('re-a')], edges: [], programSeedId: 1, board: 'b' });
  assert.equal(ok.refusal, null);
  assert.deepEqual(ok.moves.map((m) => m.id), ['re-a']);
});

test('Z11 a second plan after the moves is empty (idempotent) and the lists are sorted by id', () => {
  const first = plan({ go: true });
  assert.deepEqual(moves(first), [...moves(first)].sort());
  const moved = ROWS().map((r) => (moves(first).includes(r.id) ? row(r.id, { state: 'backlog' }) : r));
  const second = plan({ go: true, rows: moved });
  assert.deepEqual(second.moves, []);
});

test('Z12 renderSync prints MOVE, STAY and FAIL lines and the dry-run result; with apply it leaves the result to the CLI', () => {
  const p = plan({ edges: [edge('re-dep2', 're-w0')] });
  const lines = renderSync(p).split('\n');
  assert.ok(lines.includes('MOVE re-dep2 blocked -> backlog (open-dependency)'));
  assert.ok(lines.includes('STAY re-w0 waits for GO'));
  assert.ok(lines.some((l) => l.startsWith('FAIL edges-differ re-dep')));
  assert.equal(lines.at(-1), 'RESULT dry-run 1 moves');
  assert.equal(renderSync(p, { apply: true }).includes('RESULT'), false);
});
