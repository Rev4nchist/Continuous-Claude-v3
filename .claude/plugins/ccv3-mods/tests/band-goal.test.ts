import { describe, expect, test } from 'claude-code/testing'

import { bandRows } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { hudForState } from '../hooks/agentic-os/index'
import type { Span } from '../hooks/agentic-os/pane-model'
import type { HudState } from '../types'

// Card coord-status-band-2. The Goal row order, tag, label and stop-at are pinned in band-goal-source.test.ts (PR A wave 1, F1 to F5).
// Fix 9: the state file carries the model, the effort, the advisor count and the reset time of each limit.
//
// Ways it can fail, one test each:
// G4 the lane title reaches the Goal row unredacted
// S1 the state file hud lacks the model, the effort, the advisor count or resetsAt, or keeps a bad resetsAt
// S2 the state file hud copies a secret in the model or the effort

// A fake token built at run time: the staged text never holds a secret-shaped string (the gitleaks hook).
const FAKE_TOKEN = ['sk', 'live', 'ABCDEF123456'].join('-')
const FAKE_BEARER = ['abcdefghijklmnop', '1234567890'].join('')

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'idle',
  brief: null,
  tasks: [],
  repo: 'continuous-claude',
  lane: 'dash-header',
  ctx: 41,
  costUsd: 1.84,
  now: 1_000,
  activeAt: 1_000,
  ...over,
})

describe('band goal: redaction', () => {
  // G1 to G3 (order, the guessed tag, the stop-at) were repeats of F1 to F3 of band-goal-source.test.ts: deleted.
  // Breaks if the lane title reaches the Goal row unredacted (goalSource stops cleaning it).
  test('G4 a secret in the lane title never reaches the Goal row', () => {
    const row = text(bandRows(state({ brief: null, laneTitle: `rotate API_KEY=${FAKE_TOKEN} today` }), 3, 200, false).rows.goal)
    expect(row).not.toContain(FAKE_TOKEN)
    expect(row).toContain('rotate')
  })
})

describe('state file hud', () => {
  const hud = (over: Partial<HudState> = {}): HudState =>
    ({
      model: 'claude-fable-5-2',
      effort: 'high',
      costUsd: 667.8,
      limits: [
        { kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-11-17T04:00:00.000Z' },
        { kind: 'seven_day', percentUsed: 89 },
      ],
      advisor: { state: 'on', model: 'claude-fable-5-2', calls: 15 },
      ...over,
    }) as HudState

  test('S1 the hud of the state file carries model, effort, advisor calls and resetsAt; a bad resetsAt is dropped', () => {
    const got = hudForState(hud())
    expect(got).toMatchObject({ costUsd: 667.8, model: 'claude-fable-5-2', effort: 'high', advisorCalls: 15 })
    expect(got?.limits[0]).toEqual({ kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-11-17T04:00:00.000Z' })
    expect(got?.limits[1]).toEqual({ kind: 'seven_day', percentUsed: 89 })
    const bad = hudForState(hud({ limits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: 42 as never }] }))
    expect(bad?.limits[0]).toEqual({ kind: 'five_hour', percentUsed: 5 })
    expect(hudForState(null)).toBeNull()
    const none = hudForState(hud({ model: null, effort: null }))
    expect(none?.model).toBeNull()
    expect(none?.effort).toBeNull()
  })

  test('S2 a secret in the model or the effort is not copied into the state file', () => {
    const got = hudForState(hud({ model: `x API_KEY=${FAKE_TOKEN}`, effort: `Bearer ${FAKE_BEARER}` }))
    expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(got)).not.toContain(FAKE_BEARER)
  })
})
