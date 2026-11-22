import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { cellWidth } from '../hooks/agentic-os/cells'
import { fitHudParts, hudParts, hudSpans } from '../hooks/hud/model'
import type { HudState } from '../types'
import type { Span } from '../hooks/agentic-os/pane-model'

// Card coord-status-band-2, PR A: labels only (design note .claudedocs/coordination/2026-11-16-coord-status-band-2-design.md,
// section 4, and the seat ruling that took the todo kind out of this PR). No ask path changes here.
//
// Ways it can fail, one test each:
// B1 the band keeps the word ASK on line 2
// B2 PLAN and UNPROVEN draw with no steps, or disappear with steps
// B4 line 1 draws ctx or cost again when the HUD row draws (fix 6 stays green after the label work)
// H1 the HUD row keeps the old labels (cost, cache, advisor) or the effort chip text drifts (the red fill is the only signal)

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

  test('H1 cost reads est, advisor reads calls, cache reads cold in, the effort chip has its text and tone',() => {
    const warm = parts({}, { status: 'warm', hitPct: 99, minutesLeft: 58, isLow: false })
    expect((byKey(warm, 'hud-cost') as { text: string }).text).toBe('est $667.80')
    expect((byKey(warm, 'hud-advisor') as { text: string }).text).toBe('Fable advisor calls 15')
    expect((byKey(warm, 'hud-cache') as { text: string }).text).toBe('cache 99% · cold in 58m')
    const drift = byKey(parts({ effort: 'medium' }), 'hud-model') as { text: string; tone: string }
    expect(drift.tone).toBe('chipBad')
    expect(drift.text).toBe('Fable 5.2 · medium')
    const fine = byKey(parts({ effort: 'high' }), 'hud-model') as { text: string; tone: string }
    expect(fine.text).toBe('Fable 5.2 · high')
    expect(fine.tone).toBe('chip')
  })

  // 14 (design note, failure 14): no "(not high)"; the red fill is the signal. Breaks if the suffix comes back.
  test('P14 a model chip below high effort is red and has no "(not high)" text', () => {
    for (const effort of ['low', 'medium']) {
      const chip = byKey(parts({ effort }), 'hud-model') as { text: string; tone: string }
      expect(chip.tone).toBe('chipBad')
      expect(chip.text).not.toContain('not high')
    }
  })

  // 14: ctx directly after the model chip, then advisor, cost, cache, limits. Breaks if ctx moves back after the advisor.
  test('P14 ctx follows the model chip, then advisor, cost, cache and limits', () => {
    const all = hudParts(
      hud({ limits: [{ kind: 'five_hour', percentUsed: 41 }, { kind: 'seven_day', percentUsed: 41 }] as never }),
      41,
      { status: 'warm', hitPct: 99, minutesLeft: 58, isLow: false } as never,
    )
    expect(all.map(part => part.key)).toEqual(['hud-model', 'hud-ctx', 'hud-advisor', 'hud-cost', 'hud-cache', 'hud-limit-five_hour', 'hud-limit-seven_day'])
  })

  // 2d: skip-keys. The default is empty, so a caller of today gets today's row. Breaks if the default skips anything.
  test('P2d the skip-keys parameter leaves out the named parts and defaults to none', () => {
    const base = hud({ limits: [{ kind: 'five_hour', percentUsed: 41 }] as never })
    const keys = (skip?: readonly string[]) => hudParts(base, 41, null, skip).map(part => part.key)
    expect(keys()).toEqual(['hud-model', 'hud-ctx', 'hud-advisor', 'hud-cost', 'hud-limit-five_hour'])
    expect(keys([])).toEqual(keys())
    expect(keys(['hud-ctx', 'hud-cost'])).toEqual(['hud-model', 'hud-advisor', 'hud-limit-five_hour'])
  })
})

// Failure 13 (design note, sections 2 and 3): the terminal HUD row drops whole parts when it does not fit, in Dave's order,
// and never cuts a number. The desktop Svg path keeps every part (hudParts is unchanged by the fit).
describe('HUD row fit', () => {
  const fullHud = (): HudState =>
    ({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      costUsd: 667.8,
      limits: [
        { kind: 'five_hour', percentUsed: 41 },
        { kind: 'seven_day', percentUsed: 41 },
        { kind: 'spend_limit', percentUsed: 40 },
      ],
      advisor: { state: 'on', model: 'claude-fable-5-2', calls: 15 },
    }) as HudState
  const warm = { status: 'warm', hitPct: 99, minutesLeft: 58, isLow: false } as never
  const everything = () => hudParts(fullHud(), 41, warm)
  const keysAt = (width: number) => fitHudParts(everything(), width).map(part => part.key)
  const rowAt = (width: number) => text(hudSpans(fitHudParts(everything(), width)))

  // The drop steps, widest first: each is the set of parts that still draw, and whether the limit bars are in short form.
  const STEPS: { name: string; keep: (key: string) => boolean; short: boolean }[] = [
    { name: 'everything', keep: () => true, short: false },
    { name: 'no cache', keep: key => key !== 'hud-cache', short: false },
    { name: 'no advisor', keep: key => !['hud-cache', 'hud-advisor'].includes(key), short: false },
    { name: 'no cost', keep: key => !['hud-cache', 'hud-advisor', 'hud-cost'].includes(key), short: false },
    { name: 'no other limit kind', keep: key => !['hud-cache', 'hud-advisor', 'hud-cost', 'hud-limit-spend_limit'].includes(key), short: false },
    { name: 'short limit form', keep: key => !['hud-cache', 'hud-advisor', 'hud-cost', 'hud-limit-spend_limit'].includes(key), short: true },
    { name: 'no model chip', keep: key => ['hud-ctx', 'hud-limit-five_hour', 'hud-limit-seven_day'].includes(key), short: true },
    { name: 'no 7d', keep: key => ['hud-ctx', 'hud-limit-five_hour'].includes(key), short: true },
    { name: 'no 5h', keep: key => key === 'hud-ctx', short: true },
  ]
  // The cell width of a step is read from the real spans, so the test pins the order and the widths in the design note, not a copy of the fit.
  const stepParts = (step: (typeof STEPS)[number]) => everything().filter(part => step.keep(part.key)).map(part => (part.kind === 'bar' && step.short ? { ...part, short: true } : part))
  const stepWidth = (step: (typeof STEPS)[number]) => cellWidth(text(hudSpans(stepParts(step) as never)))

  test('P13 the parts drop in Dave\'s order: cache, advisor, cost, other limit kinds, short limit form, model chip, 7d, 5h', () => {
    STEPS.forEach((step, i) => {
      const width = stepWidth(step)
      expect(keysAt(width)).toEqual(stepParts(step).map(part => part.key))
      if (i > 0) expect(stepWidth(STEPS[i - 1])).toBeGreaterThan(width)
      if (i < STEPS.length - 1) expect(keysAt(width - 1)).toEqual(stepParts(STEPS[i + 1]).map(part => part.key))
    })
  })

  test('P13 a number is never cut, ctx always stays, and a dropped part does not return as the room shrinks', () => {
    let before = new Set(keysAt(200))
    for (let width = 200; width >= 1; width--) {
      const keys = keysAt(width)
      expect(keys).toContain('hud-ctx')
      for (const key of keys) expect(before.has(key)).toBe(true)
      before = new Set(keys)
      if (width >= 7) expect(cellWidth(rowAt(width))).toBeLessThanOrEqual(width)
    }
    expect(rowAt(200)).toContain('ctx 41%')
    expect(rowAt(3)).toBe('ctx 41%')
  })

  test('P13 widths of the design note: 26, 35 and 40 show ctx, 5h and 7d; 20 shows ctx and 5h; 46 keeps the chip; 56 draws the bars', () => {
    for (const width of [26, 35, 40]) expect(rowAt(width)).toBe('ctx 41%  5h 41%  7d 41%')
    expect(rowAt(23)).toBe('ctx 41%  5h 41%  7d 41%')
    expect(rowAt(22)).toBe('ctx 41%  5h 41%')
    expect(rowAt(20)).toBe('ctx 41%  5h 41%')
    expect(rowAt(46)).toBe(' Sonnet 5.5 · medium   ctx 41%  5h 41%  7d 41%')
    expect(rowAt(56)).toContain('5h ▰')
    expect(rowAt(56)).toContain('7d ▰')
    expect(rowAt(45)).not.toContain('Sonnet')
  })

  // The short form has no gauge, so the percent carries the heat tone (design note line 18: HUD gauges keep amber for heat).
  test('P13 a short limit keeps its heat tone on the percent', () => {
    const hot = hudParts({ ...fullHud(), limits: [{ kind: 'five_hour', percentUsed: 90 }] } as HudState, 41, null)
    const heat = hot.find(part => part.key === 'hud-limit-five_hour')!.tone
    expect(heat).not.toBe('dim')
    const spans = hudSpans(fitHudParts(hot, 30))
    expect(text(spans)).toBe('ctx 41%  5h 90%')
    expect(spans.find(span => span.text === '90%')?.tone).toBe(heat)
  })

  test('P13 hudParts still returns every part: only the terminal fit drops', () => {
    expect(everything().map(part => part.key)).toEqual([
      'hud-model', 'hud-ctx', 'hud-advisor', 'hud-cost', 'hud-cache', 'hud-limit-five_hour', 'hud-limit-seven_day', 'hud-limit-spend_limit',
    ])
  })

  test('P13 a null ctx leaves no ctx part and the fit still keeps the limits it can', () => {
    const noCtx = hudParts(fullHud(), null, null)
    expect(fitHudParts(noCtx, 20).map(part => part.key)).toEqual(['hud-limit-five_hour', 'hud-limit-seven_day'])
  })
})
