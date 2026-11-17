import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, mergeParsed, parseTurnEnd } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { hudForState } from '../hooks/agentic-os/index'
import type { Span } from '../hooks/agentic-os/pane-model'
import type { HudState } from '../types'

// Card coord-status-band-2, PR B (design note .claudedocs/coordination/2026-11-16-coord-status-band-2-design.md, sections 3 and 5).
// Fix 7: the band goal reads brief_set goal, then the lane title, then the parsed goal (tagged "guessed"); the stop-at is drawn.
// Fix 9: the state file carries the model, the effort, the advisor count and the reset time of each limit.
//
// Ways it can fail, one test each:
// G1 the order is wrong: a parsed goal beats the lane title, or a brief_set goal loses to the lane title
// G2 the parsed tag still says "parsed", or a guessed goal has no tag, or a lane title carries a tag
// G3 the stop-at is not drawn, is drawn with no goal, or does not give way first at a narrow width
// G4 the lane title reaches the band unredacted or as note or scope text
// S1 the state file hud lacks the model, the effort, the advisor count or resetsAt, or keeps a bad resetsAt
// S2 the state file hud copies a secret in the model or the effort

// A fake token built at run time: the staged text never holds a secret-shaped string (the gitleaks hook).
const FAKE_TOKEN = ['sk', 'live', 'ABCDEF123456'].join('-')
const FAKE_BEARER = ['abcdefghijklmnop', '1234567890'].join('')

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const briefWith = (raw: Record<string, unknown>, now = 1_000): Brief => {
  const made = applyBrief(null, raw, [], now)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const parsedBrief = (): Brief => mergeParsed(null, parseTurnEnd('Restating the ask: ship the status band labels.\n\n## Next steps\n1. None - waiting on CI.'), 1_000)

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

const lineTwo = (over: Partial<BandState>, width = 200): string => text(bandLines(state(over), width)[1])

describe('band goal: order and tag', () => {
  test('G1 the brief_set goal beats the lane title; the lane title beats the parsed goal; the parsed goal is the last resort', () => {
    const set = briefWith({ goal: 'Ship the labels' })
    expect(lineTwo({ brief: set, laneTitle: 'Status band, second card' })).toContain('GOAL Ship the labels')
    expect(lineTwo({ brief: set, laneTitle: 'Status band, second card' })).not.toContain('Status band, second card')
    const parsed = parsedBrief()
    expect(parsed.sources.goal).toBe('parsed')
    const withTitle = lineTwo({ brief: parsed, laneTitle: 'Status band, second card' })
    expect(withTitle).toContain('GOAL Status band, second card')
    expect(withTitle).not.toContain('ship the status band labels')
    expect(lineTwo({ brief: parsed })).toContain('ship the status band labels')
    expect(lineTwo({ brief: null, laneTitle: 'Status band, second card' })).toContain('GOAL Status band, second card')
    expect(lineTwo({ brief: null })).toContain('GOAL not set')
    expect(lineTwo({ brief: null, laneTitle: '   ' })).toContain('GOAL not set')
  })

  test('G2 a parsed goal is tagged guessed (never parsed); a brief_set goal and a lane title carry no tag', () => {
    expect(lineTwo({ brief: parsedBrief() })).toContain('[guessed]')
    expect(lineTwo({ brief: parsedBrief() })).not.toContain('[parsed]')
    expect(lineTwo({ brief: briefWith({ goal: 'Ship it' }) })).not.toContain('guessed')
    expect(lineTwo({ brief: parsedBrief(), laneTitle: 'A lane title' })).not.toContain('guessed')
    expect(lineTwo({ brief: null, laneTitle: 'A lane title' })).not.toContain('guessed')
  })

  test('G4 a secret in the lane title never reaches the band', () => {
    const line = lineTwo({ brief: null, laneTitle: `rotate API_KEY=${FAKE_TOKEN} today` })
    expect(line).not.toContain(FAKE_TOKEN)
    expect(line).toContain('GOAL')
  })
})

describe('band goal: stop at', () => {
  test('G3 the stop-at is drawn after the goal, gives way first at a narrow width, and never stands alone', () => {
    const both = briefWith({ goal: 'Ship the labels', stopAt: 'the proposal, no build before your yes' })
    const wide = lineTwo({ brief: both })
    expect(wide).toContain('GOAL Ship the labels')
    expect(wide).toContain('stop at: the proposal, no build before your yes')
    expect(wide.indexOf('stop at:')).toBeGreaterThan(wide.indexOf('Ship the labels'))
    const narrow = lineTwo({ brief: both }, 60)
    expect(narrow).toContain('QUESTIONS 0')
    expect(narrow).toContain('…')
    expect(lineTwo({ brief: briefWith({ goal: 'Ship the labels' }) })).not.toContain('stop at')
    expect(lineTwo({ brief: briefWith({ stopAt: 'the proposal' }) })).not.toContain('stop at')
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
