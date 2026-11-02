import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planKanban, WAITING_NOTE } from './kanban-apply.mjs';

const lane = (id, state = 'backlog', priority = 50, note = null) => ({ id, state, priority, note });
const cols = (c) => ({ now: [], next: [], later: [], waiting: [], ...c });
const board = (c, extra = {}) => ({ columns: cols(c), updatedAt: '2026-11-02T10:00:00Z', ...extra });
const card = (id, f = {}) => ({ id, updatedAt: '2026-11-02T11:00:00Z', ...f });
const plan = (input, lanes) => planKanban(input, lanes);
const kinds = (p) => p.actions.map((a) => `${a.laneId}:${a.kind}:${a.from}->${a.to}`);
const result = (p, id) => p.results.find((r) => r.laneId === id);

/** Apply a plan to plain lane rows, the way lane.mjs applies it to the table. */
function applyTo(lanes, p) {
  const byId = new Map(lanes.map((l) => [l.id, { ...l }]));
  for (const a of p.actions) {
    const l = byId.get(a.laneId);
    if (a.kind === 'priority') l.priority = a.to;
    if (a.kind === 'state') l.state = a.to;
    if (a.kind === 'note') l.note = a.to;
  }
  return [...byId.values()];
}

// ---- priority bands

test('column order maps to one rank per card, 1..n across now, next, later, waiting', () => {
  const lanes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => lane(id, 'backlog', 99));
  const p = plan({ board: board({ now: ['a', 'b'], next: ['c'], later: ['d', 'e'], waiting: ['f', 'g'] }), cards: [] }, lanes);
  const pri = Object.fromEntries(p.actions.filter((a) => a.kind === 'priority').map((a) => [a.laneId, a.to]));
  assert.deepEqual(pri, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 });
});

test('a lane in no column keeps its priority and state', () => {
  const p = plan({ board: board({ now: ['a'] }), cards: [] }, [lane('a'), lane('z', 'ready', 7)]);
  assert.ok(!p.actions.some((a) => a.laneId === 'z'));
});

test('a lane already at its target priority gets no priority action', () => {
  const p = plan({ board: board({ now: ['a'], next: ['b'] }), cards: [] }, [lane('a', 'ready', 1), lane('b', 'ready', 2)]);
  assert.deepEqual(p.actions, []);
});

test('an id listed twice: the first column position wins', () => {
  const p = plan({ board: board({ now: ['a'], later: ['a'] }), cards: [] }, [lane('a', 'backlog', 99)]);
  assert.deepEqual(kinds(p), ['a:priority:99->1']);
});

test('an active lane in a column still gets its priority but never a state change', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'active', 50)]);
  assert.deepEqual(kinds(p), ['a:priority:50->1']);
});

test('a column id with no lane is reported as skipped and causes no action', () => {
  const p = plan({ board: board({ now: ['ghost'] }), cards: [] }, []);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.skipped, [{ laneId: 'ghost', reason: 'no such lane' }]);
});

// ---- waiting

test('moving into waiting blocks the lane and adds the waiting note once', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'backlog', 50)]);
  assert.deepEqual(kinds(p), ['a:priority:50->1', 'a:state:backlog->blocked', `a:note:null->${WAITING_NOTE}`]);
});

test('a ready lane moved into waiting becomes blocked', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'ready', 1)]);
  assert.deepEqual(kinds(p), ['a:state:ready->blocked', `a:note:null->${WAITING_NOTE}`]);
});

test('a lane already blocked in waiting gets no state action and no second waiting note', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'blocked', 1, WAITING_NOTE)]);
  assert.deepEqual(p.actions, []);
});

test('a lane blocked by a session and then put in waiting gets no new note', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'blocked', 1, 'needs the vendor key')]);
  assert.deepEqual(p.actions, []);
});

test('a done lane in waiting is not reopened', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [] }, [lane('a', 'done', 1)]);
  assert.deepEqual(p.actions, []);
});

test('leaving waiting: a blocked lane carrying the waiting note goes back to backlog', () => {
  const p = plan({ board: board({ now: ['a'] }), cards: [] }, [lane('a', 'blocked', 70, WAITING_NOTE)]);
  assert.deepEqual(kinds(p), ['a:priority:70->1', 'a:state:blocked->backlog']);
});

test('leaving waiting: the waiting marker kept after a later kanban note still counts; a priority number alone never does', () => {
  const kept = plan({ board: board({ next: ['a'] }), cards: [] }, [lane('a', 'blocked', 9, `Dave (kanban): see PR || before: ${WAITING_NOTE}`)]);
  assert.deepEqual(kinds(kept), ['a:priority:9->1', 'a:state:blocked->backlog']);
  const numberOnly = plan({ board: board({ next: ['a'] }), cards: [] }, [lane('a', 'blocked', 71, 'needs the vendor key')]);
  assert.deepEqual(kinds(numberOnly), ['a:priority:71->1'], 'no marker: stays blocked whatever its priority');
});

test('leaving waiting: a ready lane stays ready', () => {
  const p = plan({ board: board({ now: ['a'] }), cards: [] }, [lane('a', 'ready', 70, WAITING_NOTE)]);
  assert.deepEqual(kinds(p), ['a:priority:70->1']);
});

test('a lane a session blocked for its own reason is not unblocked by sitting in a non-waiting column', () => {
  const p = plan({ board: board({ later: ['a'] }), cards: [] }, [lane('a', 'blocked', 1, 'needs the vendor key')]);
  assert.deepEqual(p.actions, []);
});

// ---- card status

test('pending card status maps to lane state for backlog, ready, blocked and done', () => {
  for (const [from, to] of [['ready', 'backlog'], ['backlog', 'ready'], ['ready', 'blocked'], ['review', 'done']]) {
    const p = plan({ board: board({}), cards: [card('a', { status: to })] }, [lane('a', from)]);
    assert.deepEqual(kinds(p), [`a:state:${from}->${to}`], `${from} -> ${to}`);
    assert.equal(result(p, 'a').syncResult, 'applied: state');
    assert.equal(result(p, 'a').applied, true);
  }
});

test('card status equal to the lane state is a no-op, still marked applied', () => {
  const p = plan({ board: board({}), cards: [card('a', { status: 'ready' })] }, [lane('a', 'ready')]);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(result(p, 'a'), { laneId: 'a', syncResult: 'no change', applied: true, appliedNote: null, appliedQuestion: null });
});

test('an unknown card status is skipped, not applied', () => {
  const p = plan({ board: board({}), cards: [card('a', { status: 'active' })] }, [lane('a', 'ready')]);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(result(p, 'a'), { laneId: 'a', syncResult: 'skipped: invalid status', applied: false });
});

test('an active lane is never touched by a card: status, note and question are all skipped', () => {
  const p = plan({
    board: board({}),
    cards: [card('a', { status: 'done', note: 'hi', question: 'why?' })],
  }, [lane('a', 'active')]);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(result(p, 'a'), { laneId: 'a', syncResult: 'skipped: active', applied: false });
});

test('a card for a lane that does not exist is skipped with "no such lane"', () => {
  const p = plan({ board: board({}), cards: [card('ghost', { status: 'ready' })] }, [lane('a')]);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(result(p, 'ghost'), { laneId: 'ghost', syncResult: 'skipped: no such lane', applied: false });
  assert.deepEqual(p.skipped, [{ laneId: 'ghost', reason: 'no such lane' }]);
});

// ---- card note and question

test('a pending note and question become two lane notes, note first', () => {
  const p = plan({ board: board({}), cards: [card('a', { note: 'ship it', question: 'which repo?' })] }, [lane('a', 'ready', 50, 'old')]);
  assert.deepEqual(p.actions.map((a) => [a.kind, a.from, a.to]), [
    ['note', 'old', 'Dave (kanban): ship it || before: old'],
    ['note', 'Dave (kanban): ship it || before: old', 'Dave asks (kanban): which repo? || before: Dave (kanban): ship it || before: old'],
  ]);
  assert.equal(result(p, 'a').syncResult, 'applied: note, note');
});

test('a note equal to the current lane note is not written twice', () => {
  const p = plan({ board: board({}), cards: [card('a', { note: 'ship it' })] }, [lane('a', 'ready', 50, 'Dave (kanban): ship it')]);
  assert.deepEqual(p.actions, []);
});

test('a note and a question already applied, with the write-back lost, are not applied again', () => {
  const c = card('a', { note: 'ship it', question: 'which repo?' });
  const first = plan({ board: board({}), cards: [c] }, [lane('a', 'ready', 50, 'old')]);
  const after = applyTo([lane('a', 'ready', 50, 'old')], first);
  assert.deepEqual(plan({ board: board({}), cards: [c] }, after).actions, []);
});

test('blank or non-string note and question are ignored', () => {
  const p = plan({ board: board({}), cards: [card('a', { note: '   ', question: 5 })] }, [lane('a')]);
  assert.deepEqual(p.actions, []);
  assert.equal(result(p, 'a').syncResult, 'no change');
});

test('a note longer than 1000 characters is cut to 1000 before the prefix', () => {
  const p = plan({ board: board({}), cards: [card('a', { note: 'x'.repeat(1500) })] }, [lane('a')]);
  assert.equal(p.actions[0].to, `Dave (kanban): ${'x'.repeat(1000)}`);
});

// ---- pending gate

test('a card is pending when updatedAt is later than syncedAt, or syncedAt is missing', () => {
  const pend = card('a', { note: 'n', syncedAt: '2026-11-02T10:30:00Z' });
  assert.equal(plan({ board: board({}), cards: [pend] }, [lane('a')]).actions.length, 1);
  assert.equal(plan({ board: board({}), cards: [card('a', { note: 'n' })] }, [lane('a')]).actions.length, 1);
});

test('a card that is not pending causes no action at all, even with a different status', () => {
  const done = card('a', { status: 'backlog', note: 'n', question: 'q', syncedAt: '2026-11-02T12:00:00Z' });
  const p = plan({ board: board({}), cards: [done] }, [lane('a', 'done')]);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.results, []);
});

test('card with equal updatedAt and syncedAt is not pending', () => {
  const t = '2026-11-02T11:00:00Z';
  const p = plan({ board: board({}), cards: [card('a', { status: 'ready', updatedAt: t, syncedAt: t })] }, [lane('a', 'backlog')]);
  assert.deepEqual(p.actions, []);
});

test('the board columns apply only while the board is pending', () => {
  const synced = board({ now: ['a'] }, { syncedAt: '2026-11-02T10:05:00Z' });
  assert.deepEqual(plan({ board: synced, cards: [] }, [lane('a', 'backlog', 99)]).actions, []);
  const edited = board({ now: ['a'] }, { updatedAt: '2026-11-02T10:10:00Z', syncedAt: '2026-11-02T10:05:00Z' });
  assert.equal(plan({ board: edited, cards: [] }, [lane('a', 'backlog', 99)]).actions.length, 1);
});

// ---- rule order

test('a pending card status overrides the column rule, in one state action and no waiting note', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [card('a', { status: 'ready' })] }, [lane('a', 'backlog', 1)]);
  assert.deepEqual(kinds(p), ['a:state:backlog->ready']);
});

test('a waiting column and a pending blocked card give one blocked state action', () => {
  const p = plan({ board: board({ waiting: ['a'] }), cards: [card('a', { status: 'blocked' })] }, [lane('a', 'ready', 1)]);
  assert.deepEqual(kinds(p), ['a:state:ready->blocked', `a:note:null->${WAITING_NOTE}`]);
});

// ---- idempotence

test('applying a plan and planning the same input again yields no actions', () => {
  const lanes = [
    lane('a', 'backlog', 99), lane('b', 'ready', 50), lane('c', 'blocked', 70, WAITING_NOTE),
    lane('d', 'review', 50), lane('e', 'ready', 5), lane('f', 'active', 5),
  ];
  const input = {
    board: board({ now: ['a', 'f'], waiting: ['b'], later: ['c'] }),
    cards: [card('d', { status: 'done', note: 'wrap up' }), card('e', { question: 'ok?' })],
  };
  const first = plan(input, lanes);
  assert.ok(first.actions.length >= 6, 'the first run must do real work');
  const after = applyTo(lanes, first);
  // write-back: syncedAt on board and on applied cards
  const synced = {
    board: { ...input.board, syncedAt: '2026-11-02T12:00:00Z' },
    cards: input.cards.map((c) => ({ ...c, syncedAt: '2026-11-02T12:00:00Z' })),
  };
  assert.deepEqual(plan(synced, after).actions, []);
  // even without the write-back, lane-state rules and priority do not repeat
  const again = plan(input, after);
  assert.deepEqual(again.actions, []);
});

// ---- degenerate input

test('empty, missing or malformed board and cards produce no actions and no throw', () => {
  const lanes = [lane('a')];
  for (const input of [undefined, null, {}, { board: null, cards: null }, { board: {}, cards: [] },
    { board: { columns: null }, cards: 'x' }, { board: { columns: { now: 'a' } }, cards: [null, 3, {}] },
    { board: { columns: { now: [null, 7, ''] } }, cards: [{ id: 5 }] }]) {
    const p = plan(input, lanes);
    assert.deepEqual(p.actions, [], JSON.stringify(input));
  }
  assert.deepEqual(plan({ board: board({ now: ['a'] }), cards: [] }, []).actions, []);
  assert.deepEqual(plan({ board: board({ now: ['a'] }), cards: [] }, undefined).actions, []);
});

test('the planner does not mutate its input', () => {
  const lanes = [lane('a', 'backlog', 99)];
  const input = { board: board({ waiting: ['a'] }), cards: [card('a', { note: 'n' })] };
  const copy = JSON.stringify([input, lanes]);
  plan(input, lanes);
  assert.equal(JSON.stringify([input, lanes]), copy);
});

// ---- the session's status line survives (Dave 2026-11-02: kanban notes go first, the old line stays after them)

test('a kanban note keeps the lane\'s previous note after it, and a waiting move keeps it too', () => {
  const old = 'session 11-02: CSV count 107 differs from GitHub estimate';
  const p1 = plan({ board: board({}), cards: [card('a', { note: 'do this first' })] }, [lane('a', 'backlog', 50, old)]);
  const n1 = p1.actions.filter((a) => a.kind === 'note').at(-1).to;
  assert.ok(n1.startsWith('Dave (kanban): do this first'), n1);
  assert.ok(n1.includes(old), 'the previous status line is kept');
  const p2 = plan({ board: board({ waiting: ['b'] }), cards: [] }, [lane('b', 'ready', 50, old)]);
  const n2 = p2.actions.find((a) => a.kind === 'note').to;
  assert.ok(n2.startsWith(WAITING_NOTE), n2);
  assert.ok(n2.includes(old), 'the previous status line is kept on a waiting move');
});

test('a kept note is idempotent: planning again after applying gives no actions, and waiting is still recognised', () => {
  const lanes = [lane('a', 'backlog', 50, 'old line'), lane('b', 'ready', 50, 'other line')];
  const input = { board: board({ waiting: ['b'] }), cards: [card('a', { note: 'n', question: 'q' })] };
  const after = applyTo(lanes, plan(input, lanes));
  assert.deepEqual(kinds(plan(input, after)), []);
  const left = plan({ board: board({ now: ['b'] }), cards: [] }, after.map((l) => (l.id === 'b' ? { ...l, priority: 50 } : l)));
  assert.ok(kinds(left).includes('b:state:blocked->backlog'), 'a lane whose note starts with the waiting note counts as waiting');
});

test('a note and question already applied (appliedNote/appliedQuestion on the card) are not posted again when only the status changes', () => {
  const c = card('a', { status: 'ready', note: 'ship it', question: 'which repo?', appliedNote: 'ship it', appliedQuestion: 'which repo?', syncedAt: '2026-11-02T10:30:00Z' });
  const p = plan({ board: board({}), cards: [c] }, [lane('a', 'backlog', 50, 'session moved on')]);
  assert.deepEqual(kinds(p), ['a:state:backlog->ready']);
});

test('applied results carry appliedNote and appliedQuestion for the write-back', () => {
  const p = plan({ board: board({}), cards: [card('a', { note: 'n1', question: 'q1' })] }, [lane('a')]);
  const r = result(p, 'a');
  assert.equal(r.appliedNote, 'n1');
  assert.equal(r.appliedQuestion, 'q1');
});

test('a long column never overflows into another column: 30 later lanes, then waiting, get unique increasing ranks', () => {
  const later = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const lanes = [...later, 'w'].map((id) => lane(id, 'blocked', 99, 'needs the vendor key'));
  const p = plan({ board: board({ later, waiting: ['w'] }), cards: [] }, lanes);
  const pri = Object.fromEntries(p.actions.filter((a) => a.kind === 'priority').map((a) => [a.laneId, a.to]));
  assert.equal(pri.l29, 30);
  assert.equal(pri.w, 31);
  assert.ok(!p.actions.some((a) => a.kind === 'state'), 'session-blocked later lanes are never unblocked');
});
