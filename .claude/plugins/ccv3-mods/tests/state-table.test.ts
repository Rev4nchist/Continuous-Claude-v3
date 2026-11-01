import { describe, expect, test } from 'claude-code/testing'

import { tableProblems } from './state-table'
import type { Cell, Table } from './state-table'

// The twin of scripts/checks/state-table.test.mjs, run against tests/state-table.ts (the copy a mod table imports).
// If the twin and the .mjs helper drift, the .mjs tests stay green and these go red.
//   TW1 a missing cell is not named. Break it: remove the states x events loop in tests/state-table.ts.
//   TW2 a required kind with no events and no na is not named. Break it: drop the kinds check.
//   TW3 an na with a blank reason is accepted, on a cell or on a kind. Break it: accept any na.
//   TW4 a kind whose event has only na cells passes. Break it: do not look at the cells of the event a kind names.

const states = ['s1', 's2']
const events = ['e1', 'e2']
const full = (): Cell[] => [
  { state: 's1', event: 'e1', expect: 'x' },
  { state: 's1', event: 'e2', expect: 'x' },
  { state: 's2', event: 'e1', expect: 'x' },
  { state: 's2', event: 'e2', na: 'e2 cannot happen in s2: the state has no timer' },
]
const kinds = (): Table['kinds'] => ({
  'stale-read': ['e1'],
  duplicate: ['e1'],
  'second-entry': ['e2'],
  'timer-overlap': { na: 'the unit has no timer' },
  'retained-flag': ['e1'],
})

describe('state-table twin', () => {
  test('TW0 a complete table has no problems', () => {
    expect(tableProblems({ states, events, cells: full(), kinds: kinds() })).toEqual([])
  })

  test('TW1 a missing cell is named by its state and event', () => {
    const cells = full().filter(c => !(c.state === 's2' && c.event === 'e1'))
    expect(tableProblems({ states, events, cells, kinds: kinds() })).toEqual(['missing cell s2 + e1'])
  })

  test('TW2 a required kind with no events and no na is named', () => {
    const k = kinds()
    delete k['stale-read']
    expect(tableProblems({ states, events, cells: full(), kinds: k })).toEqual(['kind stale-read has no event that covers it and no na reason'])
  })

  test('TW3 an na with a blank reason is a problem, on a cell and on a kind', () => {
    const cells = full().map(c => (c.na ? { ...c, na: '  ' } : c))
    expect(tableProblems({ states, events, cells, kinds: kinds() })).toEqual(['cell s2 + e2: na needs a reason'])
    expect(tableProblems({ states, events, cells: full(), kinds: { ...kinds(), 'timer-overlap': { na: '' } } })).toEqual(['kind timer-overlap: na needs a reason'])
  })

  test('TW4 a kind whose event has only na cells is a problem', () => {
    const cells: Cell[] = full().map(c => (c.event === 'e2' ? { state: c.state, event: c.event, na: 'never runs' } : c))
    expect(tableProblems({ states, events, cells, kinds: kinds() })).toEqual(['kind second-entry: event e2 has no cell that runs'])
  })
})
