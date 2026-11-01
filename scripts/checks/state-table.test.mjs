// Tests for state-table.mjs. Run: node --test scripts/checks/state-table.test.mjs
// A state x event table test calls tableProblems and asserts []. A table with a hole must name the hole.
// Each test names the source change that breaks it.
//
// Ways the helper can fail, one test each:
//   ST0 a complete table returns no problems. Without it, a helper that always reports a problem passes ST1-ST4.
//       breaks it: report a problem for every table
//   ST1 a table with one missing (state, event) cell does not name that cell.
//       breaks it: remove the states x events loop in tableProblems()
//   ST2 a table with no event for a required kind, and no `na`, does not name the kind.
//       breaks it: drop the kinds check in tableProblems()
//   ST3 an `na` with an empty reason is accepted, on a cell and on a kind.
//       breaks it: accept any `na` (check only that the key exists)
//   ST5 a cell that is not `na` and has no non-empty `expect` fills the grid but asserts nothing.
//       breaks it: treat any non-na cell as runnable without looking at expect
//   ST4 a kind that names an event whose cells are all `na` passes, though nothing runs for it. A kind that names
//       an event the table does not have passes, though nothing can cover it.
//       breaks it: do not look at the cells of the event a kind names
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableProblems, KINDS } from './state-table.mjs';

const states = ['s1', 's2'];
const events = ['e1', 'e2'];
const run = () => {};
const full = () => [
  { state: 's1', event: 'e1', expect: 'x', run },
  { state: 's1', event: 'e2', expect: 'x', run },
  { state: 's2', event: 'e1', expect: 'x', run },
  { state: 's2', event: 'e2', na: 'e2 cannot happen in s2: the state has no timer' },
];
const kinds = () => ({
  'stale-read': ['e1'],
  duplicate: ['e1'],
  'second-entry': ['e2'],
  'timer-overlap': { na: 'the unit has no timer' },
  'retained-flag': ['e1'],
});

test('KINDS lists the five kinds a table must cover', () => {
  assert.deepEqual([...KINDS].sort(), ['duplicate', 'retained-flag', 'second-entry', 'stale-read', 'timer-overlap']);
});

test('ST0 a complete table has no problems', () => {
  assert.deepEqual(tableProblems({ states, events, cells: full(), kinds: kinds() }), []);
});

test('ST1 a missing cell is named by its state and event', () => {
  const cells = full().filter((c) => !(c.state === 's2' && c.event === 'e1'));
  const problems = tableProblems({ states, events, cells, kinds: kinds() });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /missing cell s2 \+ e1/);
});

test('ST1 a cell that names an unknown state or event, and a repeated cell, are problems', () => {
  const cells = [...full(), { state: 's9', event: 'e1', na: 'no such state' }, { state: 's1', event: 'e1', expect: 'x', run }];
  const text = tableProblems({ states, events, cells, kinds: kinds() }).join('\n');
  assert.match(text, /unknown state s9/);
  assert.match(text, /repeated cell s1 \+ e1/);
});

test('ST2 a required kind with no events and no na is named', () => {
  const k = kinds();
  delete k['stale-read'];
  const problems = tableProblems({ states, events, cells: full(), kinds: k });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /kind stale-read/);
});

test('ST2 a kind with an empty event list is a problem, not a cover', () => {
  const k = { ...kinds(), duplicate: [] };
  assert.match(tableProblems({ states, events, cells: full(), kinds: k }).join('\n'), /kind duplicate/);
});

test('ST3 an na cell with an empty or blank reason is a problem', () => {
  for (const reason of ['', '   ', undefined]) {
    const cells = full().map((c) => (c.na ? { ...c, na: reason } : c));
    const problems = tableProblems({ states, events, cells, kinds: kinds() });
    assert.match(problems.join('\n'), /cell s2 \+ e2: na needs a reason/, `reason ${JSON.stringify(reason)}`);
  }
});

test('ST3 an na kind with an empty reason is a problem', () => {
  const k = { ...kinds(), 'timer-overlap': { na: '' } };
  assert.match(tableProblems({ states, events, cells: full(), kinds: k }).join('\n'), /kind timer-overlap: na needs a reason/);
});

test('ST5 a runnable cell with no expect, or a blank one, is a problem and does not fill the grid', () => {
  // breaks it: drop the expect check in cellProblems()
  for (const bare of [{ state: 's2', event: 'e1', run }, { state: 's2', event: 'e1', expect: '', run }, { state: 's2', event: 'e1', expect: '  ', run }]) {
    const cells = full().map((c) => (c.state === 's2' && c.event === 'e1' ? bare : c));
    const problems = tableProblems({ states, events, cells, kinds: kinds() });
    assert.deepEqual(problems, ['cell s2 + e1: a cell that runs needs an expect']);
  }
});

test('ST4 a kind whose event has only na cells is a problem', () => {
  const cells = full().map((c) => (c.event === 'e2' ? { state: c.state, event: c.event, na: 'never runs' } : c));
  const problems = tableProblems({ states, events, cells, kinds: kinds() });
  assert.match(problems.join('\n'), /kind second-entry: event e2 has no cell that runs/);
});

test('ST4 a kind that names an event the table does not have is a problem', () => {
  const k = { ...kinds(), duplicate: ['e1', 'e7'] };
  assert.match(tableProblems({ states, events, cells: full(), kinds: k }).join('\n'), /kind duplicate: unknown event e7/);
});
