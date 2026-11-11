// Tests for lib/facts.mjs, lib/holds.mjs and fixtures/rows.fixture.mjs. They import the real functions.
// Failure modes (design D, amendments A7, A8): a spender read from the wrong line, a missing bullet that reads as "no spender",
// "review" read as a long lane, a GO read from prose, a hold ended by the wrong token, a decision point counted wrongly.
// Run: node --test scripts/review-engine/facts-holds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap, parseHeld } from './lib/map-parse.mjs';
import { programFacts } from './lib/facts.mjs';
import { judgeHolds, parseDecisions, nextDecisionPoint } from './lib/holds.mjs';
import { row, edge, ev, life } from './fixtures/rows.fixture.mjs';

const LF = readFileSync(new URL('./fixtures/map.fixture.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SLOT = '  - Cursor eval slot: one token. Only one spends: `fx-base`, `fx-mid` (Cursor backend), and `fx-top`.';
const LONG = '- Long lanes (T14): `fx-keys` (sweep weeks), `fx-gate-a` (gates) run for weeks. Set the lane to state `review` between sessions.';

// Insert lines before the "Dropped" heading: outside any lane section, as in the real map.
const withLines = (...lines) => LF.replace('## Dropped or merged lanes', `${lines.join('\n')}\n\n## Dropped or merged lanes`);
const factsOf = (text) => programFacts(text, parseMap(text));

test('F1 slotIds are the backtick ids on the indented bullet, and only that bullet', () => {
  const text = withLines(SLOT, '- Cost: holds the Cursor eval slot (`fx-gate-b`)');
  assert.deepEqual(factsOf(text).slotIds, ['fx-base', 'fx-mid', 'fx-top']);
});

test('F2 no slot bullet gives slotIds null and a note, never an empty list', () => {
  const f = factsOf(LF);
  assert.equal(f.slotIds, null);
  assert.ok(f.notes.includes('map fact missing: Cursor eval slot bullet'));
});

test('F3 a slot bullet with no id gives an empty list and no note', () => {
  const f = factsOf(withLines('- Cursor eval slot: none now.'));
  assert.deepEqual(f.slotIds, []);
  assert.equal(f.notes.some((n) => /Cursor eval slot/.test(n)), false);
});

test('F4 a slot bullet may wrap to deeper-indented lines; a sibling bullet ends it', () => {
  const text = withLines('  - Cursor eval slot: one token. Lanes: `fx-base`,', '    `fx-mid` and more.', '  - Grok slots: `fx-top`.');
  assert.deepEqual(factsOf(text).slotIds, ['fx-base', 'fx-mid']);
});

test('F5 a slot id that is not a map lane stays in slotIds and adds a note', () => {
  const f = factsOf(withLines('- Cursor eval slot: `fx-base`, `re-ghost`.'));
  assert.deepEqual(f.slotIds, ['fx-base', 're-ghost']);
  assert.ok(f.notes.some((n) => /re-ghost/.test(n) && /Cursor eval slot/.test(n)));
});

test('F6 longIds read the list sentence only: `review` in the next sentence is not a lane', () => {
  const f = factsOf(withLines(LONG));
  assert.deepEqual(f.longIds, ['fx-keys', 'fx-gate-a']);
  assert.equal(f.notes.some((n) => /review/.test(n)), false);
});

test('F7 no Long lanes bullet gives an empty list and a note; a non-map id gets a note', () => {
  const none = factsOf(LF);
  assert.deepEqual(none.longIds, []);
  assert.ok(none.notes.includes('map fact missing: Long lanes bullet'));
  const ghost = factsOf(withLines('- Long lanes (T14): `fx-keys`, `re-ghost` run for weeks.'));
  assert.deepEqual(ghost.longIds, ['fx-keys']);
  assert.ok(ghost.notes.some((n) => /re-ghost/.test(n) && /Long lanes/.test(n)));
});

test('F8 go: GO is true, HOLD is false, an absent line reads as HOLD with a note', () => {
  assert.equal(factsOf(withLines('Program state: GO (Dave, 2026-11-12)')).go, true);
  assert.equal(factsOf(withLines('Program state: HOLD')).go, false);
  const absent = factsOf(LF);
  assert.equal(absent.go, false);
  assert.ok(absent.notes.some((n) => /Program state/.test(n) && /HOLD/.test(n)));
});

test('F9 go: prose, a lower-case line, GOLD and an unreadable value are not GO', () => {
  for (const line of ['The program state: GO is a plan.', 'program state: GO', 'Program state: GOLD', 'Program state: maybe']) {
    assert.equal(factsOf(withLines(line)).go, false, line);
  }
  assert.ok(factsOf(withLines('Program state: maybe')).notes.some((n) => /Program state/.test(n) && /maybe/.test(n)));
});

test('F10 go: two Program state lines that disagree read as HOLD', () => {
  assert.equal(factsOf(withLines('Program state: GO', 'Program state: HOLD')).go, false);
});

test('F10b go: GO and HOLD, each with at most one parenthetical, are the only readable values', () => {
  for (const [line, go] of [
    ['Program state: GO', true], ['Program state: GO (Dave, 2026-11-20)', true], ['Program state: GO(Dave)', true],
    ['- Program state: HOLD', false], ['Program state: HOLD (waiting on DP2)', false],
  ]) {
    const f = factsOf(withLines(line));
    assert.equal(f.go, go, line);
    assert.equal(f.notes.some((n) => /unreadable Program state line/.test(n)), false, `${line}: readable, so no note`);
  }
});

test('F10c go: a prefix or a second parenthetical fails closed to HOLD and says "unreadable Program state line"', () => {
  for (const line of [
    'Program state: GO pending DP2', 'Program state: GO-LATER', 'Program state: GO? no, HOLD', 'Program state: GO (a) (b)',
    'Program state: GO (Dave) now', 'Program state: GO (unclosed', 'Program state: GO ((x))',
  ]) {
    const f = factsOf(withLines(line));
    assert.equal(f.go, false, line);
    assert.ok(f.notes.some((n) => n.startsWith('unreadable Program state line') && n.includes(line.replace('Program state: ', ''))), `${line}: ${f.notes.join(' | ')}`);
  }
});

test('F10d go: two Program state lines that disagree read as HOLD and add a note', () => {
  const f = factsOf(withLines('Program state: GO (Dave, 2026-11-20)', 'Program state: HOLD'));
  assert.equal(f.go, false);
  assert.ok(f.notes.some((n) => /Program state lines disagree/.test(n) && /HOLD/.test(n)), f.notes.join(' | '));
  assert.equal(factsOf(withLines('Program state: GO', 'Program state: GO (Dave)')).go, true, 'two GO lines agree');
});

test('F10e go: a HOLD line in another markdown form beside a GO line is not missed', () => {
  const odd = ['**Program state:** HOLD', '## Program state: HOLD', '> Program state: HOLD', '* Program state: HOLD',
    'Program State: HOLD', 'program state: HOLD', '- `Program state: HOLD`', '| Program state: HOLD |', '| Program state | HOLD |',
    '1. Program state: HOLD', '- [ ] Program state: HOLD', '_Program state:_ HOLD', '- Program state : HOLD',
    'The seat writes a line `Program state: HOLD` before GO.'];
  for (const hold of odd) {
    const f = factsOf(withLines('- Program state: GO', hold));
    assert.equal(f.go, false, hold);
    assert.ok(f.notes.some((n) => /unreadable Program state line/.test(n)), `${hold}: ${f.notes.join(' | ')}`);
  }
  assert.equal(factsOf(withLines('- Program state: **GO**')).go, false, 'a decorated value is unreadable');
  assert.equal(factsOf(withLines('- Program state:HOLD', '- Program state: GO')).go, false, 'the one form, no space: read as HOLD, lines disagree');
  assert.equal(factsOf(withLines('- Program state: GO')).go, true, 'the one accepted form alone is GO');
  assert.equal(factsOf(withLines('Why: One place for the program state. The check fixes it.', '- Program state: GO')).go, true, 'plain prose with no colon after the label is not a state line (map.md:1098)');
});

test('F11 ids are Waves ids plus external ids, without duplicates; the seat is re-program', () => {
  const f = factsOf(LF);
  assert.equal(f.seatId, 're-program');
  assert.deepEqual(f.ids, ['fx-base', 'fx-keys', 'fx-mid', 'fx-gate-a', 'fx-gate-b', 'fx-top', 'fx-holder', 'fx-ext']);
  assert.deepEqual(programFacts('', { lanes: [{ id: 'a' }, { id: 'a' }], externals: [{ id: 'a' }, { id: 'b' }] }).ids, ['a', 'b']);
});

// Holds

const lane = (cell) => ({ held: parseHeld(cell) });
const met = (...ids) => new Map(ids.map((id) => [id, true]));

test('H1 a lane token ends only when that lane is met', () => {
  assert.deepEqual(judgeHolds(lane('fx-a'), met('fx-a')), { held: false, unmet: [], met: ['fx-a'] });
  assert.deepEqual(judgeHolds(lane('fx-a'), new Map([['fx-a', false]])).unmet, ['fx-a']);
  assert.deepEqual(judgeHolds(lane('fx-a'), new Map()).unmet, ['fx-a']);
});

test('H2 a met lane never ends a decision, conditional, keyword or unknown token', () => {
  const cell = 'DP2.4; fx-a if DP2.4 = yes; first-flip; dave-yes; item-trigger; seat-hold; DP2.4 maybe';
  const res = judgeHolds(lane(cell), met('fx-a', 'DP2.4', 'first-flip', 'seat-hold', 'dave-yes'));
  assert.equal(res.held, true);
  assert.equal(res.met.length, 0);
  assert.deepEqual(res.unmet, ['DP2.4', 'fx-a if DP2.4 = yes', 'first-flip', 'dave-yes', 'item-trigger', 'seat-hold', 'DP2.4 maybe']);
});

test('H3 a mixed cell: the met lane token is dropped, the rest stay unmet', () => {
  const res = judgeHolds(lane('fx-a; DP2.4'), met('fx-a'));
  assert.deepEqual(res, { held: true, unmet: ['DP2.4'], met: ['fx-a'] });
});

test('H4 no hold is not held; an object works as the met table; seat-hold parses', () => {
  assert.equal(judgeHolds({ held: [] }, new Map()).held, false);
  assert.equal(judgeHolds(lane('fx-a'), { 'fx-a': true }).held, false);
  assert.deepEqual(parseHeld('seat-hold'), [{ kind: 'seat-hold' }]);
});

const DECISIONS = `# Decisions

Some words with 1. a number inside.

## Decision points for Dave

### DP1 (answered 2026-11-09, before any lane spends)

1. DECIDED (Dave, 2026-11-09): yes.
2. NOT ASKED (Dave's answer): no.
3. DECIDED (Dave): done.

### Open after DP1

1. OPEN. This numbered line is in no decision point.

### DP2 (after the phase 4 A/B)

1. Keep or kill prompt v2.
2. DECIDED (Dave, 2026-11-10): yes.
3. OPEN (T14). Verifier refute.

#### Second-model check

1. A numbered line under a deeper heading is no item of DP2.

### DP3 (before the first flip)

Items 1 and 2 must be picked as a pair.

1. Upper bound.
`;

test('T1 parseDecisions reads items by number; DECIDED and NOT ASKED are decided; other headings end a section', () => {
  const dec = parseDecisions(DECISIONS);
  assert.deepEqual(dec.map((d) => d.id), ['DP1', 'DP2', 'DP3']);
  assert.deepEqual(dec[0].items.map((i) => [i.id, i.decided]), [['DP1.1', true], ['DP1.2', true], ['DP1.3', true]]);
  assert.deepEqual(dec[1].items.map((i) => [i.id, i.decided]), [['DP2.1', false], ['DP2.2', true], ['DP2.3', false]]);
  assert.deepEqual(dec[2].items.map((i) => i.id), ['DP3.1']);
});

test('T2 nextDecisionPoint is the first section with an open item', () => {
  assert.deepEqual(nextDecisionPoint(parseDecisions(DECISIONS)), {
    id: 'DP2', heading: 'DP2 (after the phase 4 A/B)', open: ['DP2.1', 'DP2.3'],
  });
});

test('T3 nextDecisionPoint is null when every item is decided, and for no sections', () => {
  const all = DECISIONS.replace('1. Keep or kill prompt v2.', '1. DECIDED yes.').replace('3. OPEN (T14). Verifier refute.', '3. NOT ASKED.')
    .replace('1. Upper bound.', '1. DECIDED (Dave).');
  assert.equal(nextDecisionPoint(parseDecisions(all)), null);
  assert.equal(nextDecisionPoint(parseDecisions('# nothing')), null);
});

// Row builders

test('X1 row() gives exactly the BoardRow keys and rejects a key that is not one', () => {
  const r = row('re-x');
  assert.deepEqual(Object.keys(r).sort(), [
    'band', 'branch', 'id', 'landed_sha', 'last_life', 'lease_expires_at', 'met', 'note', 'open_dep', 'owner_alive_at',
    'owner_session_id', 'priority', 'project_key', 'reclaimable', 'state', 'track', 'updated_at', 'waits_on',
  ]);
  assert.equal(row('re-x', { state: 'active', open_dep: true }).state, 'active');
  assert.throws(() => row('re-x', { sate: 'active' }), /sate/);
});

test('X2 edge() and ev() give exactly the EdgeRow and EventRow keys', () => {
  assert.deepEqual(Object.keys(edge('a', 'b')).sort(), ['dep_board', 'depends_on', 'lane_id', 'project_key']);
  const e = ev(7, 'a', 'claimed', { state: 'active' });
  assert.deepEqual(Object.keys(e).sort(), ['detail', 'id', 'kind', 'lane_id', 'occurred_at', 'session_id']);
  assert.equal(typeof e.id, 'number');
  assert.throws(() => edge('a', 'b', { board: 'x' }), /board/);
  assert.throws(() => ev(1, 'a', 'done', {}, { sid: 'x' }), /sid/);
  assert.deepEqual(Object.keys(life(3, 'done', { merged: 'x' })).sort(), ['detail', 'id', 'kind', 'session_id']);
});
