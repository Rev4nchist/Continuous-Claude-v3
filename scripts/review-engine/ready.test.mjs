// Tests for lib/ready.mjs (design B.3; amendments A6 pack from the map, A7 one spend source, A8 seat-hold).
// Failure modes (Y1-Y11): an open dependency offered; an Owns overlap with a review lane ignored; a dead lane counted in the
// cap; the seat counted; a pack counted as 2 units; NULL-branch externals merged into 1 unit; a spender read from the wrong
// source; the caller holding a lane still gets a list; a pack holder refused; a non-map lane offered; a missing slot fact
// that reads as "no spender". Run: node --test scripts/review-engine/ready.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReady, renderReady, computeCap, computeSlot } from './lib/ready.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row } from './fixtures/rows.fixture.mjs';

const CALLER = 'cccccccc-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const lane = (id, over = {}) => ({ id, ...over });
const free = (id, over = {}) => row(id, { state: 'backlog', reclaimable: true, ...over });
const live = (id, state, owner = OTHER, over = {}) => row(id, { state, owner_session_id: owner, reclaimable: false, ...over });
const dead = (id, state, owner = OTHER, over = {}) => row(id, { state, owner_session_id: owner, reclaimable: true, ...over });
const run = (map, rows, caller = CALLER) => selectReady({ model: map.model, facts: map.facts, rows, caller, board: 'continuous-claude' });
const readyIds = (res) => res.ready.map((r) => r.id);
const held = (res, id) => res.heldBack.find((h) => h.id === id);
const PACK = [{ lanes: ['re-v', 're-f'], branch: 're/re-v' }];

test('Y1 a lane with an open dependency is not offered and is not listed as held back', () => {
  const map = buildMap({ lanes: [lane('re-a'), lane('re-b', { deps: ['re-a'] })] });
  const res = run(map, [free('re-a'), free('re-b', { open_dep: true, waits_on: ['re-a'] })]);
  assert.deepEqual(readyIds(res), ['re-a']);
  assert.equal(held(res, 're-b'), undefined);
});

test('Y1b only a backlog or ready lane with no live owner is a candidate', () => {
  const map = buildMap({ lanes: [lane('re-a'), lane('re-b'), lane('re-c'), lane('re-d'), lane('re-e')] });
  const rows = [
    free('re-a', { state: 'ready' }), live('re-b', 'active'), row('re-c', { state: 'blocked' }), row('re-d', { state: 'done' }),
    live('re-e', 'backlog', OTHER),
  ];
  assert.deepEqual(readyIds(run(map, rows)), ['re-a']);
});

test('Y2 an Owns overlap with a lane in review holds the candidate back; a dead lane still holds its files', () => {
  const map = buildMap({ lanes: [lane('re-a', { owns: ['shared.mjs'] }), lane('re-b', { owns: ['shared.mjs'] }), lane('re-c', { owns: ['own.mjs'] })] });
  for (const w of [live('re-a', 'review'), dead('re-a', 'active')]) {
    const res = run(map, [w, free('re-b'), free('re-c')]);
    assert.equal(held(res, 're-b').reason, 'owns-held');
    assert.equal(held(res, 're-b').other, 're-a');
    assert.deepEqual(readyIds(res), ['re-c']);
  }
});

test('Y2b two entries that name keys only do not hold each other back', () => {
  const owns = (key) => [['cfg.json', `the ${key} key only`]];
  const map = buildMap({ lanes: [lane('re-a', { owns: owns('a') }), lane('re-b', { owns: owns('b') })] });
  assert.deepEqual(readyIds(run(map, [live('re-a', 'active'), free('re-b')])), ['re-b']);
});

test('Y3 a reclaimable lane in work is not counted in the cap', () => {
  const map = buildMap({ lanes: [lane('re-w1'), lane('re-w2'), lane('re-w3'), lane('re-c')] });
  const rows = [live('re-w1', 'active'), live('re-w2', 'active'), dead('re-w3', 'active'), free('re-c')];
  const res = run(map, rows);
  assert.equal(res.cap.used, 2);
  assert.deepEqual(readyIds(res), ['re-c']);
});

test('Y3b three live units fill the cap: every candidate is held back as cap-full and the result says so', () => {
  const map = buildMap({ lanes: [lane('re-w1'), lane('re-w2'), lane('re-w3'), lane('re-c')] });
  const res = run(map, [live('re-w1', 'active'), live('re-w2', 'review'), live('re-w3', 'active'), free('re-c')]);
  assert.equal(res.cap.used, 3);
  assert.deepEqual(readyIds(res), []);
  assert.equal(held(res, 're-c').reason, 'cap-full');
  assert.equal(res.result, 'cap-full');
  assert.match(renderReady(res), /RESULT cap-full/);
});

test('Y4 the seat is not counted in the cap, and is never offered', () => {
  const map = buildMap({ lanes: [lane('re-w1'), lane('re-w2'), lane('re-c')] });
  const rows = [live('re-program', 'active'), live('re-w1', 'active'), live('re-w2', 'active'), free('re-c')];
  const res = run(map, rows);
  assert.equal(res.cap.used, 2);
  assert.deepEqual(res.cap.units.map((u) => u.key), ['re/re-w1', 're/re-w2']);
  assert.deepEqual(readyIds(res), ['re-c']);
  assert.deepEqual(res.warnings, []);
});

test('Y5 a pack counts as one unit, whether its rows carry the pack branch or a NULL branch', () => {
  const map = buildMap({ lanes: [lane('re-v'), lane('re-f'), lane('re-w'), lane('re-c')], packs: PACK });
  for (const branch of ['re/re-v', null]) {
    const rows = [live('re-v', 'active', OTHER, { branch }), live('re-f', 'active', OTHER, { branch }), live('re-w', 'active'), free('re-c')];
    const res = run(map, rows);
    assert.equal(res.cap.used, 2, `branch ${branch}`);
    assert.deepEqual(readyIds(res), ['re-c']);
  }
});

test('Y5b a pack branch that is no map pack does not merge two lanes into one unit', () => {
  const map = buildMap({ lanes: [lane('re-v'), lane('re-f')] });
  const rows = [live('re-v', 'active', OTHER, { branch: null }), live('re-f', 'active', OTHER, { branch: null })];
  assert.equal(computeCap(rows, map.model, map.facts).used, 2);
});

test('Y6 two externals in work with a NULL branch count as two units', () => {
  const map = buildMap({ lanes: [lane('re-w'), lane('re-c')], externals: [lane('hf-x'), lane('hf-y')] });
  const rows = [live('hf-x', 'active'), live('hf-y', 'active'), live('re-w', 'active'), free('re-c')];
  const res = run(map, rows);
  assert.equal(res.cap.used, 3);
  assert.equal(held(res, 're-c').reason, 'cap-full');
});

test('Y7 a lane on the Cursor eval slot bullet takes the slot; a second spender is held back, a non-spender is offered', () => {
  const map = buildMap({ lanes: [lane('re-s1'), lane('re-s2'), lane('re-n')], slot: ['re-s1', 're-s2'] });
  const res = run(map, [live('re-s1', 'active'), free('re-s2'), free('re-n')]);
  assert.deepEqual(res.slot, { held: true, by: ['re-s1'] });
  assert.equal(held(res, 're-s2').reason, 'slot-held');
  assert.equal(held(res, 're-s2').other, 're-s1');
  assert.deepEqual(readyIds(res), ['re-n']);
});

test('Y7b A7: Cost text and a CURSOR-EVAL note are not spend sources; a dead spender does not hold the slot', () => {
  const map = buildMap({
    lanes: [lane('re-c', { cost: 'holds the Cursor eval slot' }), lane('re-n'), lane('re-s1'), lane('re-s2')], slot: ['re-s1', 're-s2'],
  });
  const byCost = run(map, [live('re-c', 'active'), free('re-s1')]);
  assert.equal(byCost.slot.held, false);
  assert.deepEqual(readyIds(byCost), ['re-s1']);
  const byNote = run(map, [live('re-n', 'active', OTHER, { note: 'CURSOR-EVAL run in progress' }), free('re-s1')]);
  assert.equal(byNote.slot.held, false);
  const byDead = run(map, [dead('re-s1', 'active'), free('re-s2')]);
  assert.equal(byDead.slot.held, false);
  assert.deepEqual(readyIds(byDead), ['re-s2']);
});

test('Y8 a caller who holds a re- lane is refused with exit 3 and gets no list', () => {
  const map = buildMap({ lanes: [lane('re-a'), lane('re-b')] });
  const res = run(map, [live('re-a', 'active', CALLER), free('re-b')]);
  assert.equal(res.refusal.exit, 3);
  assert.equal(res.refusal.message, 'REFUSED ready -- you hold re-a; one re- lane per session (finish it with done --merged, or release it)');
  assert.deepEqual(readyIds(res), []);
});

test('Y8b a done lane or an external lane does not refuse the caller', () => {
  const map = buildMap({ lanes: [lane('re-a'), lane('re-b')], externals: [lane('hf-x')] });
  const res = run(map, [live('hf-x', 'active', CALLER), row('re-a', { state: 'done', owner_session_id: CALLER }), free('re-b')]);
  assert.equal(res.refusal, null);
  assert.equal(res.mode, 'worker');
  assert.deepEqual(readyIds(res), ['re-b']);
});

test('Y9 a caller who holds a pack lane is in pack mode: only the sibling is offered, also when the cap is full', () => {
  const map = buildMap({ lanes: [lane('re-v'), lane('re-f'), lane('re-w1'), lane('re-w2'), lane('re-n')], packs: PACK });
  const rows = [
    live('re-v', 'active', CALLER, { branch: 're/re-v' }), free('re-f', { branch: 're/re-v' }),
    live('re-w1', 'active'), live('re-w2', 'active'), free('re-n'),
  ];
  const res = run(map, rows);
  assert.equal(res.mode, 'pack');
  assert.equal(res.cap.used, 3);
  assert.deepEqual(readyIds(res), ['re-f']);
});

test('Y9b a lane on another live session pack is held back with pack-held and the owner', () => {
  const map = buildMap({ lanes: [lane('re-v'), lane('re-f')], packs: PACK });
  const rows = [live('re-v', 'active', OTHER, { branch: 're/re-v' }), free('re-f', { branch: 're/re-v' })];
  const res = run(map, rows);
  assert.equal(held(res, 're-f').reason, 'pack-held');
  assert.equal(held(res, 're-f').other, `re-v ${OTHER.slice(0, 8)}`);
  const dead2 = run(map, [dead('re-v', 'active', OTHER, { branch: 're/re-v' }), free('re-f', { branch: 're/re-v' })]);
  assert.deepEqual(readyIds(dead2), ['re-f']);
});

test('Y10 a re- lane that is not in the map is listed as not in map and never offered; one in work adds a warning', () => {
  const map = buildMap({ lanes: [lane('re-a')] });
  const rows = [free('re-a'), free('re-x'), live('re-y', 'active'), row('re-z', { state: 'done' }), live('re-program', 'active')];
  const res = run(map, rows);
  assert.deepEqual(readyIds(res), ['re-a']);
  assert.deepEqual(res.notInMap, [{ id: 're-x', state: 'backlog' }, { id: 're-y', state: 'active' }]);
  assert.deepEqual(res.warnings, ['in work, not in map: re-y (its Owns are unknown)']);
});

test('Y11 a map with no Cursor eval slot bullet fails closed with exit 1 and no list', () => {
  const map = buildMap({ lanes: [lane('re-a')], slot: null });
  const res = run(map, [free('re-a')]);
  assert.deepEqual(res.refusal, { exit: 1, message: 'map fact missing: Cursor eval slot bullet' });
  assert.deepEqual(readyIds(res), []);
});

test('Y12 no caller is a usage error, exit 2', () => {
  const map = buildMap({ lanes: [lane('re-a')] });
  assert.equal(run(map, [free('re-a')], '').refusal.exit, 2);
  assert.match(run(map, [free('re-a')], null).refusal.message, /CLAUDE_CODE_SESSION_ID or --as/);
});

test('Y13 the seat holds re-program: mode seat, the list prints with the seat view line', () => {
  const map = buildMap({ lanes: [lane('re-a')] });
  const res = run(map, [live('re-program', 'active', CALLER), free('re-a')]);
  assert.equal(res.mode, 'seat');
  assert.deepEqual(readyIds(res), ['re-a']);
  assert.match(renderReady(res), /seat view: you hold re-program; name lanes with say, never claim them/);
});

test('Y14 a lane with an unmet hold is held back as held, even in backlog; a met lane token ends the hold', () => {
  const map = buildMap({ lanes: [lane('re-a'), lane('re-b', { held: 'DP2.4' }), lane('re-c', { held: 're-a' })] });
  const res = run(map, [free('re-b'), free('re-c'), row('re-a', { state: 'done', met: false })]);
  assert.equal(held(res, 're-b').reason, 'held');
  assert.equal(held(res, 're-b').other, 'DP2.4');
  assert.equal(held(res, 're-c').other, 're-a');
  const met = run(map, [free('re-c'), row('re-a', { state: 'done', met: true })]);
  assert.deepEqual(readyIds(met), ['re-c']);
});

test('Y15 waiting on Dave lists the review lanes with owner and note; the order of the input is kept', () => {
  const map = buildMap({ lanes: [lane('re-z'), lane('re-a'), lane('re-r')] });
  const rows = [free('re-z', { priority: 20 }), free('re-a', { priority: 30 }), live('re-r', 'review', OTHER, { note: 'plan needs a tap' })];
  const res = run(map, rows);
  assert.deepEqual(readyIds(res), ['re-z', 're-a']);
  assert.deepEqual(res.waitingOnDave, [{ id: 're-r', owner: OTHER, note: 'plan needs a tap' }]);
});

test('Y16 renderReady prints the pinned lines', () => {
  const map = buildMap({ lanes: [lane('re-a', { wave: 1 }), lane('re-s1'), lane('re-s2')], slot: ['re-s1', 're-s2'] });
  const rows = [free('re-a', { band: 'P1', priority: 12 }), live('re-s1', 'active'), free('re-s2'), live('re-r', 'review', OTHER, { note: 'tap' })];
  const text = renderReady(run(map, rows));
  const lines = text.split('\n');
  assert.equal(lines[0], 'ready: board continuous-claude, caller cccccccc, mode worker, cap 2/3 units, slot held by re-s1');
  assert.ok(lines.includes('READY re-a  P1 12  wave 1  branch re/re-a'));
  assert.ok(lines.includes('HELD BACK re-s2  slot-held re-s1'));
  assert.ok(lines.includes(`waiting on Dave: re-r (${OTHER.slice(0, 8)}) tap`));
  assert.ok(lines.includes('not in map: re-r review'));
  assert.equal(lines.at(-1), 'RESULT ready 1');
});

test('Y17 renderReady: RESULT none when nothing is ready and the cap is not full; a spender line ends with spends', () => {
  const map = buildMap({ lanes: [lane('re-s1')], slot: ['re-s1'] });
  assert.match(renderReady(run(map, [free('re-s1')])), /READY re-s1 {2}- 50 {2}wave 0 {2}branch re\/re-s1 {2}spends/);
  assert.equal(renderReady(run(map, [])).split('\n').at(-1), 'RESULT none');
});

test('Y18 computeSlot: slotIds null reads as no holder and never throws', () => {
  const map = buildMap({ lanes: [lane('re-a')], slot: null });
  assert.deepEqual(computeSlot([live('re-a', 'active')], map.model, map.facts), { held: false, by: [] });
});
