// Tests for lib/claims.mjs (design B.6; amendment A1: the floor is the program seed event; --since overrides).
// Failure modes (K1-K4): a reclaim is flagged; a reopen gives a false flag or a missed one (the "lower than the latest" reading);
// a dep_override is missed; a pack is counted as two lanes. Also: a claim on a blocked lane, a floor that is not applied.
// Run: node --test scripts/review-engine/claims.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayLane, checkClaims, renderClaims } from './lib/claims.mjs';
import { buildMap } from './fixtures/model.fixture.mjs';
import { row, edge, ev } from './fixtures/rows.fixture.mjs';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SHA = 'c'.repeat(40);
const MAP = buildMap({
  lanes: [
    { id: 're-a' }, { id: 're-b', deps: ['re-a'] }, { id: 're-c', deps: ['re-a'] }, { id: 're-d', deps: ['re-a'] },
    { id: 're-x', deps: ['hf-x'] }, { id: 're-p1' }, { id: 're-p2' },
  ],
  externals: [{ id: 'hf-x' }],
  packs: [{ lanes: ['re-p1', 're-p2'], branch: 're/re-p1' }],
});
const EDGES = [edge('re-b', 're-a'), edge('re-c', 're-a'), edge('re-d', 're-a'), edge('re-x', 'hf-x')];
const merged = (id, lane, sha = SHA) => ev(id, lane, 'done', { state: 'done', merged: sha, main: sha });
const reopen = (id, lane) => ev(id, lane, 'state_changed', { state: 'ready' });
const claim = (id, lane, session = A, state = 'active') => ev(id, lane, 'claimed', { state }, { session_id: session });
const check = (events, over = {}) => checkClaims({
  model: MAP.model, facts: MAP.facts, rows: [], events, edges: EDGES, programSeedId: 1, since: null, ...over,
});
const errs = (res) => res.errors.map((e) => `${e.rule} ${e.message}`);

test('K0 a claim after the dependency merged done passes; one before it fails with the lane, event and dependency', () => {
  assert.deepEqual(check([merged(10, 're-a'), claim(20, 're-b')]).errors, []);
  assert.deepEqual(errs(check([claim(5, 're-b'), merged(10, 're-a')])), ['claim-open-dep re-b event 5 waits on re-a']);
});

test('K1 a reclaim of an active lane that still had its owner is a note, not an error, though its dependency is open', () => {
  const events = [merged(2, 're-a'), claim(5, 're-b', A), reopen(10, 're-a'), claim(20, 're-b', B)];
  const res = check(events);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.notes.map((n) => `${n.rule} ${n.message}`), ['reclaim re-b 20']);
});

test('K1b a claim on a lane that was released (ready, no owner) is not a reclaim: the dependency test applies', () => {
  const events = [merged(2, 're-a'), claim(5, 're-b', A), reopen(10, 're-a'), ev(12, 're-b', 'state_changed', { state: 'ready' }), claim(20, 're-b', B)];
  assert.deepEqual(errs(check(events)), ['claim-open-dep re-b event 20 waits on re-a']);
});

// The reclaim exemption needs an owner. A lane set to review by state_changed has none, so a claim on it is no reclaim.
test('K1c the reclaim exemption needs an owner: an unowned review lane with an open dependency is claim-open-dep, an owned lapsed lane is a note', () => {
  const unowned = check([ev(5, 're-b', 'state_changed', { state: 'review' }), claim(20, 're-b', B)]);
  assert.deepEqual(errs(unowned), ['claim-open-dep re-b event 20 waits on re-a']);
  assert.deepEqual(unowned.notes, []);
  const unownedActive = check([ev(5, 're-b', 'state_changed', { state: 'active' }), claim(20, 're-b', B)]);
  assert.deepEqual(errs(unownedActive), ['claim-open-dep re-b event 20 waits on re-a']);
  const owned = check([merged(2, 're-a'), claim(5, 're-b', A), ev(8, 're-b', 'state_changed', { state: 'review' }), reopen(10, 're-a'), claim(20, 're-b', B)]);
  assert.deepEqual(owned.errors, []);
  assert.deepEqual(owned.notes.map((n) => `${n.rule} ${n.message}`), ['reclaim re-b 20']);
});

test('K2 merged, claim, reopen, merged, claim: both claims pass; a claim between the reopen and the second merge fails', () => {
  const events = [merged(10, 're-a'), claim(15, 're-b'), reopen(20, 're-a'), claim(25, 're-d', B), merged(30, 're-a'), claim(40, 're-c', B)];
  assert.deepEqual(errs(check(events)), ['claim-open-dep re-d event 25 waits on re-a']);
});

test('K2b the latest lifecycle event decides: a plain done, a short SHA, a kanban state change and no event all mean not met', () => {
  const cases = [
    [ev(10, 're-a', 'done', { state: 'done' })],
    [ev(10, 're-a', 'done', { state: 'done', merged: 'abc1234' })],
    [merged(5, 're-a'), ev(10, 're-a', 'kanban', { kind: 'state', to: 'backlog' })],
    [merged(5, 're-a'), ev(10, 're-a', 'state_changed', { state: 'active' })],
    [],
  ];
  for (const life of cases) assert.equal(check([...life, claim(20, 're-b')]).errors.length, 1, JSON.stringify(life));
});

test('K2c an event that is not a lifecycle event does not undo a merge: kanban priority and note events are ignored', () => {
  const events = [merged(5, 're-a'), ev(10, 're-a', 'kanban', { kind: 'priority', to: 12 }), ev(11, 're-a', 'note', {}), claim(20, 're-b')];
  assert.deepEqual(check(events).errors, []);
});

test('K3 a dep_override event on a program lane is an error', () => {
  const res = check([merged(2, 're-a'), ev(50, 're-b', 'dep_override', { waitsOn: ['re-a'], reason: 'x' })]);
  assert.deepEqual(errs(res), ['dep-override re-b event 50']);
  assert.deepEqual(check([ev(50, 'other-lane', 'dep_override', {})]).errors, []);
});

test('K4 an owner with two lanes of one pack is one unit; an owner with two other lanes is an error; the seat has no exemption', () => {
  const owned = (id, owner, over = {}) => row(id, { state: 'active', owner_session_id: owner, ...over });
  const pack = check([], { rows: [owned('re-p1', A, { branch: 're/re-p1' }), owned('re-p2', A, { branch: 're/re-p1' })] });
  assert.deepEqual(pack.errors, []);
  const nullBranch = check([], { rows: [owned('re-p1', A, { branch: null }), owned('re-p2', A, { branch: null })] });
  assert.deepEqual(nullBranch.errors, []);
  const two = check([], { rows: [owned('re-a', A), owned('re-c', A), owned('re-b', B)] });
  assert.deepEqual(errs(two), ['two-re-lanes aaaaaaaa: re-a, re-c']);
  const seat = check([], { rows: [owned('re-program', A), owned('re-c', A)] });
  assert.equal(seat.errors.length, 1);
});

test('K4b a done lane, an external lane and a lane with no owner do not count as a second lane', () => {
  const rows = [
    row('re-a', { state: 'active', owner_session_id: A }), row('re-c', { state: 'done', owner_session_id: A }),
    row('hf-x', { state: 'active', owner_session_id: A }), row('re-d', { state: 'backlog' }),
  ];
  assert.deepEqual(check([], { rows }).errors, []);
});

test('K5 a claim that kept the state blocked or done is an error and skips the dependency test', () => {
  assert.deepEqual(errs(check([claim(5, 're-b', A, 'blocked')])), ['claim-blocked re-b event 5 state blocked']);
  assert.deepEqual(errs(check([claim(5, 're-b', A, 'done')])), ['claim-blocked re-b event 5 state done']);
  const before = [ev(4, 're-b', 'state_changed', { state: 'blocked' }), claim(5, 're-b', A, 'active')];
  assert.deepEqual(errs(check(before)), ['claim-blocked re-b event 5 state blocked']);
});

test('K6 a dependency on an external lane is judged the same way', () => {
  assert.deepEqual(check([merged(2, 'hf-x'), claim(5, 're-x')]).errors, []);
  assert.deepEqual(errs(check([claim(5, 're-x')])), ['claim-open-dep re-x event 5 waits on hf-x']);
});

test('K7 a claim on a lane that is not a program lane is not judged', () => {
  assert.deepEqual(check([claim(5, 'coord-gate-2', A, 'blocked')]).errors, []);
  assert.deepEqual(errs(check([claim(5, 're-old-card', A, 'blocked')])), ['claim-blocked re-old-card event 5 state blocked']);
});

test('A1f the default floor is the program seed event: a claim before it is not judged, one after it is', () => {
  const events = [claim(15, 're-b'), claim(25, 're-c')];
  const res = check(events, { programSeedId: 20 });
  assert.deepEqual(errs(res), ['claim-open-dep re-c event 25 waits on re-a']);
  assert.deepEqual(res.floor, { id: 20, source: 'program seed' });
});

test('A1g --since overrides the floor, as a number: --since 0 judges every claim, "20" is coerced', () => {
  const events = [claim(15, 're-b'), claim(25, 're-c')];
  assert.equal(check(events, { programSeedId: 20, since: 0 }).errors.length, 2);
  const res = check(events, { programSeedId: 20, since: '10' });
  assert.equal(res.errors.length, 2);
  assert.deepEqual(res.floor, { id: 10, source: '--since' });
  assert.equal(check(events, { programSeedId: 1, since: '15' }).errors.length, 1);
});

test('A1g2 a --since that is not a whole event id throws, so a typo cannot read as a pass', () => {
  for (const bad of ['abc', '', '-3', '1.5', NaN]) {
    assert.throws(() => check([claim(5, 're-b')], { since: bad }), /--since must be a whole event id/, String(bad));
  }
});

test('A1h no program seed event and no --since: every claim is judged and the note and floor say so', () => {
  const res = check([claim(2, 're-b')], { programSeedId: null });
  assert.equal(res.errors.length, 1);
  assert.deepEqual(res.floor, { id: 0, source: 'none' });
  assert.ok(res.notes.some((n) => n.message === 'no program seed event; judging all claims'));
  const since = check([claim(2, 're-b')], { programSeedId: null, since: 1 });
  assert.equal(since.notes.some((n) => /no program seed event/.test(n.message)), false);
  assert.equal(since.errors.length, 1);
});

test('A1i the floor also bounds dep_override events', () => {
  const events = [ev(10, 're-b', 'dep_override', {}), ev(30, 're-c', 'dep_override', {})];
  assert.deepEqual(errs(check(events, { programSeedId: 20 })), ['dep-override re-c event 30']);
});

test('R1 replayLane follows claimed, done, state_changed and kanban events in id order and frees the owner on done or ready', () => {
  assert.deepEqual(replayLane([]), { state: 'unknown', owner: null });
  const claimed = [claim(2, 'x', A, 'active')];
  assert.deepEqual(replayLane(claimed), { state: 'active', owner: A });
  assert.deepEqual(replayLane([...claimed, ev(3, 'x', 'state_changed', { state: 'review' })]), { state: 'review', owner: A });
  assert.deepEqual(replayLane([...claimed, merged(3, 'x')]), { state: 'done', owner: null });
  assert.deepEqual(replayLane([...claimed, ev(3, 'x', 'kanban', { kind: 'state', to: 'ready' })]), { state: 'ready', owner: null });
  assert.deepEqual(replayLane([...claimed, ev(3, 'x', 'kanban', { kind: 'priority', to: 4 })]), { state: 'active', owner: A });
  assert.deepEqual(replayLane([merged(3, 'x'), claimed[0]]), { state: 'done', owner: null });
});

test('R2 replayLane stops before a given event id', () => {
  const events = [claim(2, 'x', A), merged(5, 'x'), claim(9, 'x', B)];
  assert.deepEqual(replayLane(events, 5), { state: 'active', owner: A });
  assert.deepEqual(replayLane(events, 9), { state: 'done', owner: null });
});

test('K8 renderClaims prints the floor, the notes, the errors, the limit and the result', () => {
  const res = check([claim(5, 're-b'), merged(8, 're-a'), claim(9, 're-c', A), claim(10, 're-c', B)], { programSeedId: 1 });
  const lines = renderClaims(res).split('\n');
  assert.equal(lines[0], 'floor: event 1 (program seed)');
  assert.ok(lines.includes('FAIL claim-open-dep re-b event 5 waits on re-a'));
  assert.ok(lines.includes('NOTE reclaim re-c 10'));
  assert.ok(lines.some((l) => /claim-not-ready/.test(l) && /cannot be rebuilt/.test(l)));
  assert.equal(lines.at(-1), 'RESULT fail (1 errors)');
  const none = renderClaims(check([], { programSeedId: null })).split('\n');
  assert.equal(none[0], 'floor: event 0 (none)');
  assert.ok(none.includes('NOTE no program seed event; judging all claims'));
  assert.equal(none.at(-1), 'RESULT pass (0 errors)');
});
