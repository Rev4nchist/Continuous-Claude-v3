// Tests for lib/status.mjs (design B.8). Failure modes (T1): a wrong next decision point (decided items counted as open, a numbered
// line under another heading counted); counts that lose a lane with no card; a cap or slot copy that drifts from `ready`;
// a throw on a missing slot fact or no decisions file. Run: node --test scripts/review-engine/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, renderStatus } from './lib/status.mjs';
import { computeCap, computeSlot } from './lib/ready.mjs';
import { parseDecisions } from './lib/holds.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row } from './fixtures/rows.fixture.mjs';

const OWNER = 'eeeeeeee-0000-4000-8000-00000000000e';
const spec = (over = {}) => ({
  lanes: [{ id: 're-a', phase: 'P3' }, { id: 're-b', wave: 1, deps: ['re-a'] }, { id: 're-s', wave: 1, held: 'DP2.4' }],
  externals: [{ id: 'hf-x' }], slot: ['re-s'], ...over,
});
const rows = () => [
  row('re-a', { state: 'done', met: true }), row('re-b', { state: 'active', owner_session_id: OWNER, open_dep: false, waits_on: ['x'] }),
  row('re-s', { state: 'blocked' }), row('re-old', { state: 'active', owner_session_id: OWNER }),
];
const dp = (open, decided = 0) => Array.from({ length: open + decided }, (_, i) => `${i + 1}. ${i < decided ? 'DECIDED (Dave): yes.' : 'Open item.'}`).join('\n');
const DECISIONS = `# Decisions\n\n### DP1 (answered)\n\n${dp(0, 3)}\n\n### DP2 (after the A/B)\n\n${dp(9)}\n\n#### Sub\n\n1. Not an item.\n\n### DP3 (before flip)\n\n${dp(8)}\n`;
const status = (map = buildMap(spec()), over = {}) => buildStatus({
  model: map.model, facts: map.facts, rows: rows(), decisions: parseDecisions(DECISIONS), board: 'continuous-claude', ...over,
});

test('T1 the next decision point is the first section with an open item and lists its open ids', () => {
  const next = status().nextDecisionPoint;
  assert.equal(next.id, 'DP2');
  assert.equal(next.open.length, 9);
  assert.deepEqual(next.open.slice(0, 2), ['DP2.1', 'DP2.2']);
  assert.equal(next.heading, 'DP2 (after the A/B)');
});

test('T1b no decisions file gives a null next decision point and no throw; all decided gives null', () => {
  assert.equal(status(undefined, { decisions: null }).nextDecisionPoint, null);
  assert.equal(status(undefined, { decisions: parseDecisions('### DP1 (x)\n\n1. DECIDED.\n') }).nextDecisionPoint, null);
});

test('T2 counts: every map lane and external counts once; a lane with no card counts as "no card"', () => {
  const st = status();
  assert.equal(st.counts.lanes, 4);
  assert.deepEqual(st.counts.byState, { blocked: 1, backlog: 0, ready: 0, active: 1, review: 0, done: 1, 'no card': 1 });
});

test('T3 waves: lanes, done, in work and blocked per wave; the external is wave 0', () => {
  assert.deepEqual(status().waves, [
    { wave: 0, lanes: 2, done: 1, inWork: 0, blocked: 0 },
    { wave: 1, lanes: 2, done: 0, inWork: 1, blocked: 1 },
  ]);
});

test('T4 each lane carries its state, owner, live flag, branch, held tokens, waits_on, met and spends', () => {
  const byId = Object.fromEntries(status().lanes.map((l) => [l.id, l]));
  assert.deepEqual(byId['re-s'], {
    id: 're-s', wave: 1, phase: 'P1', state: 'blocked', owner: null, live: false, branch: 're/re-s', held: ['DP2.4'], waitsOn: [], met: false, spends: true,
  });
  assert.equal(byId['re-b'].owner, OWNER);
  assert.equal(byId['re-b'].live, true);
  assert.deepEqual(byId['re-b'].waitsOn, ['x']);
  assert.equal(byId['re-a'].met, true);
  assert.equal(byId['re-a'].phase, 'P3');
  assert.deepEqual([byId['hf-x'].state, byId['hf-x'].phase, byId['hf-x'].wave, byId['hf-x'].branch], ['no card', null, 0, null]);
});

test('T5 live is true for a lane with an owner that is not reclaimable', () => {
  const live = rows().map((r) => (r.id === 're-b' ? row('re-b', { ...r, reclaimable: false }) : row(r.id, { ...r, reclaimable: true })));
  const map = buildMap(spec());
  const st = buildStatus({ model: map.model, facts: map.facts, rows: live, decisions: null, board: 'b' });
  assert.equal(st.lanes.find((l) => l.id === 're-b').live, true);
  assert.equal(st.lanes.find((l) => l.id === 're-a').live, false);
});

test('T6 cap and slot are the values of ready: the same functions, the same rows', () => {
  const map = buildMap(spec());
  const st = status(map);
  assert.deepEqual(st.cap, computeCap(rows(), map.model, map.facts));
  assert.deepEqual(st.slot, computeSlot(rows(), map.model, map.facts));
  assert.equal(st.cap.used, 2);
});

test('T7 a map with no slot bullet and a GO line do not throw; go is copied from the facts', () => {
  const noSlot = buildMap(spec({ slot: null, go: true }));
  const st = status(noSlot);
  assert.equal(st.go, true);
  assert.equal(st.slot.held, false);
  assert.equal(st.lanes.every((l) => l.spends === false), true);
  assert.equal(status().go, false);
});

test('T8 renderStatus is five lines: header, states, cap and slot, waves, next decision point', () => {
  const out = renderStatus(status()).split('\n');
  assert.equal(out.length, 5);
  assert.equal(out[0], 'status: board continuous-claude, 4 lanes, program state HOLD');
  assert.equal(out[1], 'states: blocked 1, backlog 0, ready 0, active 1, review 0, done 1, no card 1');
  assert.equal(out[2], 'cap: 2/3 units, slot free');
  assert.equal(out[3], 'waves: 0: 1/2 done, 0 in work, 0 blocked; 1: 0/2 done, 1 in work, 1 blocked');
  assert.equal(out[4], 'next decision point: DP2 (9 open)');
  assert.equal(renderStatus(status(undefined, { decisions: null })).split('\n')[4], 'next decision point: none');
});
