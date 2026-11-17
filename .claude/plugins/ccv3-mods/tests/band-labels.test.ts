import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { hudParts } from '../hooks/hud/model'
import type { HudState } from '../types'
import type { Span } from '../hooks/agentic-os/pane-model'

// Card coord-status-band-2, PR A: labels only (design note .claudedocs/coordination/2026-11-16-coord-status-band-2-design.md,
// section 4, and the seat ruling that took the todo kind out of this PR). No ask path changes here.
//
// Ways it can fail, one test each:
// B1 the band keeps the word ASK on line 2
// B2 PLAN and UNPROVEN draw with no steps, or disappear with steps
// B4 line 1 draws ctx or cost again when the HUD row draws (fix 6 stays green after the label work)
// H1 the HUD row keeps the old labels (cost, cache, advisor) or draws a red effort chip with no reason

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const briefWith = (raw: Record<string, unknown>, prev: Brief | null = null, now = 1_000): Brief => {
  const made = applyBrief(prev, raw, [], now)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

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

describe('band line 2 labels', () => {
  const lineTwo = (over: Partial<BandState>, width = 160): string => text(bandLines(state(over), width)[1])

  test('B1 line 2 says QUESTIONS and never ASK', () => {
    const line = lineTwo({ brief: briefWith({ ask: [{ kind: 'question', text: 'Open the PR?' }] }) })
    expect(line).toContain('QUESTIONS 1')
    expect(line).not.toContain('ASK')
    expect(lineTwo({})).toContain('QUESTIONS 0')
  })

  test('B2 PLAN and UNPROVEN hide with no steps and draw with steps', () => {
    const empty = lineTwo({ brief: briefWith({ goal: 'g' }) })
    expect(empty).not.toContain('PLAN')
    expect(empty).not.toContain('UNPROVEN')
    const steps = lineTwo({ brief: briefWith({ goal: 'g', plan: [{ id: 'a', text: 'one', status: 'done' }] }) })
    expect(steps).toContain('PLAN')
    expect(steps).toContain('UNPROVEN 1')
  })

  test('B4 line 1 leaves out ctx and cost when the HUD row draws, and keeps them when it does not', () => {
    const withHud = text(bandLines(state({ hud: true }), 160)[0])
    expect(withHud).not.toContain('ctx 41%')
    expect(withHud).not.toContain('$1.84')
    const noHud = text(bandLines(state({ hud: false }), 160)[0])
    expect(noHud).toContain('ctx 41%')
    expect(noHud).toContain('$1.84')
  })
})

describe('HUD row labels', () => {
  const hud = (over: Partial<HudState> = {}): HudState =>
    ({
      model: 'claude-fable-5-2',
      effort: 'high',
      costUsd: 667.8,
      limits: [],
      advisor: { state: 'on', model: 'claude-fable-5-2', calls: 15 },
      ...over,
    }) as HudState
  const parts = (over: Partial<HudState> = {}, cache: unknown = null) => hudParts(hud(over), 26, cache as never)
  const byKey = (list: ReturnType<typeof parts>, key: string) => list.find(part => part.key === key)

  test('H1 cost reads est, advisor reads calls, cache reads cold in, a red effort chip gives its reason', () => {
    const warm = parts({}, { status: 'warm', hitPct: 99, minutesLeft: 58, isLow: false })
    expect((byKey(warm, 'hud-cost') as { text: string }).text).toBe('est $667.80')
    expect((byKey(warm, 'hud-advisor') as { text: string }).text).toBe('Fable advisor calls 15')
    expect((byKey(warm, 'hud-cache') as { text: string }).text).toBe('cache 99% · cold in 58m')
    const drift = byKey(parts({ effort: 'medium' }), 'hud-model') as { text: string; tone: string }
    expect(drift.tone).toBe('chipBad')
    expect(drift.text).toContain('medium')
    expect(drift.text).toContain('not high')
    const fine = byKey(parts({ effort: 'high' }), 'hud-model') as { text: string }
    expect(fine.text).not.toContain('not high')
  })
})
