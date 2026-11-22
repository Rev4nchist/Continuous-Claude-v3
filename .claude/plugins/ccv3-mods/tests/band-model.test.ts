import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, emptyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import * as bandModel from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import type { Span } from '../hooks/agentic-os/pane-model'
import { chipWord } from '../hooks/agentic-os/plain'
import { TONE } from '../hooks/shared/tones'

// compactLine and bandRows are read from the namespace: a missing export fails the one test, not the whole file.
const compactLine = (bandModel as unknown as { compactLine: (state: BandState, width: number) => Span[] }).compactLine
const bandRows = (bandModel as unknown as { bandRows: (s: BandState, maxRows: number, width: number, quiet: boolean) => { rows: Partial<Record<'line' | 'compact' | 'row1' | 'goal', Span[]>> } }).bandRows

// Ways the band rows (PRD 5.3, design 2026-11-18) can fail, one test each. Every check reads the drawn text and tones.
// The plan itself (rows by maxRows, owners, sign forms, cut order) is pinned in band-plan.test.ts; the Goal row source and clip in band-goal-source.test.ts.
// L1 a chip word is wrong, shortened, or two states share a tone
// L2 row 1 loses a field, or shows a field the state does not have as if it were set
// L4 a blank goal reads as set
// L8 a row overruns the width, or the chip is cut
// L10 a secret in the state reaches the drawn text
// Removed with the old two-line band (design 2026-11-18, section 2): L3 (GOAL not set label and tone), L5 to L7 (QUESTIONS, answered?, stale, UNPROVEN, PLAN bar),
// L9 (under 40 columns one chip-and-goal line); their words left the band. The Goal row is covered by band-goal-source.test.ts, the sign by band-plan.test.ts.
//
// compactLine(state, width) is the ONE line the band draws at maxRows 2 with the HUD row (the plan's `compact` row). Contract: chip, repo, ctx, cost, helpers running, in that order;
// BandState gains an optional `helpers` (the number of running helpers; absent or 0 draws no helper text); helper text reads "N helpers running"
// ("1 helper running" for one). Pure. Ways it can fail, one test each:
// CL1 a field is missing or out of order, or the line carries a core-row field (lane, goal, PLAN, ASK, UNPROVEN)
// CL2 the line is wider than the width at some width from 20 to 200
// CL3 the chip is cut, shortened or loses its tone at some width
// CL4 below 40 columns more than the chip and ctx is drawn; from 40 columns the repo shows
// CL5 ctx is dropped while the line is wide enough for it (the chip plus ctx fit at 20 columns)
// CL6 a field the state lacks reads as null, undefined or a gap, or a zero helper count draws a helper text
// CL7 a secret in the repo reaches the drawn text
// CL8 helpers show the wrong count, or the singular reads wrong
//
// Band must-haves (Dave, 2026-10-29; build plan "Band must-haves"). The band always carries the context window (ctx %), the 5-hour
// limit (5h %) and the 7-day usage (7d %) when known, plus cost. Contract added to the compact line:
// BandState gains an optional `limits`: the HUD's HudLimit list ({ kind, percentUsed }), or null/absent when the limits are not
// known yet. Order: chip, repo, ctx, 5h, 7d, cost, helpers. Text: "5h 38%", "7d 61%" (rounded like the HUD row). Cut order when
// narrow: helpers, cost, repo text, then 7d, then 5h; ctx and the chip are never cut. Unknown reads "-": limits null/absent draws
// "5h -" and "7d -". Known limits with no such window (a gateway account: [] or only a spend limit) draw nothing for that figure.
// A non-finite percent is unknown ("-"), never a made-up number. Row 1 and the Goal row never carry 5h or 7d.
// CL9  the limits are missing, in the wrong place, or rounded differently from the HUD row
// CL10 the line is wider than the width with limits in it, or the chip or ctx is cut at some width
// CL11 the cut order is wrong: at some width a field stays while a field that must outlive it is gone
// CL12 5h and 7d are cut at 40 columns or more, where chip, ctx, 5h and 7d fit; under 40 the repo, cost or helpers sneak back
// CL13 an unknown limit reads as a value, null, NaN or a gap; a missing window draws a made-up figure or a dash
// CL14 row 1 or the Goal row grows 5h or 7d

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'working',
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

// Row 1 with no HUD state (it owns ctx): two rows, row 1 and the Goal row.
const rowOne = (over: Partial<BandState> = {}, width = 120): Span[] => bandRows(state({ hud: false, ...over }), 2, width, false).rows.row1 ?? []

describe('band row 1', () => {
  test('L1 each chip state draws its own word and its own tone', () => {
    // Mockup: WORKING is a blue chip. Amber is only for a person being needed (waiting-on-dave). RESTING is dim text with no fill (design 2026-11-18, section 5).
    const chips = {
      working: ['WORKING', 'chipDoing'],
      'waiting-on-dave': ['WAITING FOR YOU', 'chipWarn'],
      blocked: ['STUCK', 'chipBad'],
      done: ['DONE', 'chipOk'],
      idle: ['RESTING', 'dim'],
    } as const
    for (const [chip, [word, tone]] of Object.entries(chips)) {
      const span = rowOne({ chip: chip as BandState['chip'] })[0]
      expect(span?.text.trim()).toBe(word)
      expect(span?.tone).toBe(tone)
    }
  })

  test('L1 the working chip and the plan bar draw blue, never the orange of the claude accent', () => {
    expect(TONE.chipDoing).toEqual({ color: 'inverseText', backgroundColor: 'suggestion', bold: true })
    expect(TONE.doing).toEqual({ color: 'suggestion', bold: true })
    expect(TONE.chipWarn.backgroundColor).toBe('warning')
  })

  test('L2 row 1 holds chip, lane and ctx, in that order, and no repo, branch or cost (the statusline and the HUD show them)', () => {
    const line = text(rowOne())
    const at = ['WORKING', 'lane dash-header', 'ctx 41%'].map(part => line.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(line).not.toContain('continuous-claude')
    expect(line).not.toContain('$')
  })

  test('L2 a field the state does not have reads as a dash, not as a value and not as a gap', () => {
    const line = text(rowOne({ repo: null, lane: null, ctx: null, costUsd: null }))
    expect(line).toContain('lane -')
    expect(line).toContain('ctx -')
    expect(line).not.toContain('null')
    expect(line).not.toContain('undefined')
  })

  test('L4 a blank goal reads as not set', () => {
    const blank: Brief = { ...emptyBrief(1_000), goal: '   ' }
    expect(text(bandRows(state({ brief: blank }), 3, 120, false).rows.goal)).toBe('goal not set')
  })
})

describe('band width', () => {
  const long = 'g'.repeat(300)
  const briefWith = (raw: Record<string, unknown>): Brief => {
    const made = applyBrief(null, raw, [], 1_000)
    if ('error' in made) throw new Error(made.error)
    return made.brief
  }
  const full = (): BandState =>
    state({
      brief: briefWith({ goal: long.slice(0, 240), ask: [{ kind: 'question', text: 'q?' }] }),
      lane: 'lane-' + 'l'.repeat(40),
      openAsks: 1,
    })

  // Every row of every plan: the width is cells and the chip is the one thing allowed past it (WAITING ON 10 TASKS is 21 cells).
  test('L8 no row is wider than the width, for every width from 20 to 200, at every row budget, with the HUD on and off', () => {
    for (const given of [state(), full()]) {
      for (const hud of [true, false]) {
        for (let width = 20; width <= 200; width++) {
          for (const maxRows of [1, 2, 3]) {
            const { rows } = bandRows({ ...given, hud }, maxRows, width, false)
            for (const row of Object.values(rows)) expect(text(row).length).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test('L8 the chip word is whole at every width, on every row that carries it', () => {
    for (let width = 20; width <= 120; width += 5) {
      for (const [maxRows, hud, key] of [[1, false, 'line'], [2, true, 'compact'], [2, false, 'row1']] as const) {
        const rows = bandRows({ ...full(), chip: 'waiting-on-dave', hud }, maxRows, width, false).rows
        expect(text(rows[key])).toContain('WAITING FOR YOU')
      }
    }
  })
})

describe('band redaction', () => {
  test('L10 a secret in the goal, repo or lane never reaches the drawn text', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    const unredacted: Brief = { ...emptyBrief(1_000), goal: `ship ${secret}` }
    const given = state({ brief: unredacted, repo: `r-${secret}`, lane: `l-${secret}`, hud: true })
    const drawn = [bandRows(given, 3, 200, false), bandRows(given, 2, 200, false), bandRows({ ...given, hud: false }, 2, 200, false)]
      .flatMap(one => Object.values(one.rows))
      .map(text)
      .join('\n')
    expect(drawn).not.toContain(secret)
    expect(drawn).not.toContain('a'.repeat(40))
  })
})

describe('band compact line', () => {
  type CompactOver = Partial<BandState> & { helpers?: number }
  const compact = (over: CompactOver = {}, width = 120): Span[] => compactLine(state(over as Partial<BandState>), width)
  const compactText = (over: CompactOver = {}, width = 120): string => text(compact(over, width))

  test('CL1 chip, repo, ctx, cost and helpers draw in that order, and no core-line field does', () => {
    const line = compactText({ helpers: 2 })
    const at = ['WORKING', 'continuous-claude', 'ctx 41%', '$1.84', '2 helpers running'].map(part => line.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const word of ['feat/dash-header', 'lane', 'GOAL', 'PLAN', 'ASK', 'UNPROVEN']) expect(line).not.toContain(word)
  })

  test('CL2 no compact line is wider than the width, for every width from 20 to 200', () => {
    const long = state({ repo: 'r'.repeat(80), lane: 'l'.repeat(80) }) as BandState
    for (const given of [{ helpers: 2 }, { helpers: 12, repo: 'r'.repeat(80), costUsd: 1234.5 }, { chip: 'waiting-on-dave' as const, helpers: 3 }]) {
      for (let width = 20; width <= 200; width++) {
        expect(text(compactLine({ ...long, ...given } as BandState, width)).length).toBeLessThanOrEqual(width)
      }
    }
  })

  test('CL3 the chip is whole, first and in its own tone at every width, for every state', () => {
    const words = { working: 'WORKING', 'waiting-on-dave': 'WAITING FOR YOU', blocked: 'STUCK', done: 'DONE', idle: 'RESTING' } as const
    const tones = { working: 'chipDoing', 'waiting-on-dave': 'chipWarn', blocked: 'chipBad', done: 'chipOk', idle: 'dim' } as const
    for (const chip of Object.keys(words) as (keyof typeof words)[]) {
      for (let width = 20; width <= 120; width += 5) {
        const first = compact({ chip, helpers: 2 }, width)[0]
        expect(first?.text.trim()).toBe(words[chip])
        expect(first?.tone).toBe(tones[chip])
      }
    }
  })

  test('CL4 under 40 columns only the chip and ctx are drawn; at 40 the repo shows', () => {
    for (const width of [20, 30, 39]) {
      const got = compactText({ helpers: 2 }, width)
      expect(got).toContain('WORKING')
      expect(got).toContain('ctx 41%')
      for (const word of ['continuous-claude', '$', 'helper', 'GOAL']) expect(got).not.toContain(word)
    }
    expect(compactText({ helpers: 2 }, 40)).toContain('continuous')
  })

  test('CL5 ctx stays while the chip and ctx fit: WORKING and ctx 41% at 20 columns and up', () => {
    for (let width = 20; width <= 200; width++) expect(compactText({ helpers: 2 }, width)).toContain('ctx 41%')
  })

  test('CL6 a missing field reads as a dash; zero or no helpers draw no helper text', () => {
    const got = compactText({ repo: null, ctx: null, costUsd: null, helpers: 0 })
    expect(got).toContain('ctx -')
    expect(got).toContain('$-')
    for (const word of ['null', 'undefined', 'helper']) expect(got).not.toContain(word)
    expect(compactText({})).not.toContain('helper')
  })

  test('CL7 a secret in the repo never reaches the drawn text', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    for (const width of [40, 120, 200]) {
      const got = compactText({ repo: `r-${secret}`, helpers: 1 }, width)
      expect(got).not.toContain(secret)
      expect(got).not.toContain('a'.repeat(40))
    }
  })

  test('CL8 the helper count is the state count, and one helper reads in the singular', () => {
    expect(compactText({ helpers: 7 })).toContain('7 helpers running')
    expect(compactText({ helpers: 1 })).toMatch(/1 helper running/)
    expect(compactText({ helpers: 1 })).not.toContain('1 helpers')
  })
})

describe('band compact line: ctx, 5h and 7d', () => {
  type Limit = { kind: string; percentUsed: number }
  type Over = Partial<BandState> & { helpers?: number; limits?: Limit[] | null }
  const BOTH: Limit[] = [
    { kind: 'five_hour', percentUsed: 38 },
    { kind: 'seven_day', percentUsed: 61 },
  ]
  const compactText = (over: Over = {}, width = 120): string => text(compactLine(state(over as Partial<BandState>), width))

  test('CL9 chip, repo, ctx, 5h, 7d, cost and helpers draw in that order', () => {
    const line = compactText({ helpers: 2, limits: BOTH })
    const at = ['WORKING', 'continuous-claude', 'ctx 41%', '5h 38%', '7d 61%', '$1.84', '2 helpers running'].map(part => line.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('CL9 a percent rounds like the HUD row: 37.6 reads 38%, 60.4 reads 60%', () => {
    const line = compactText({
      limits: [
        { kind: 'five_hour', percentUsed: 37.6 },
        { kind: 'seven_day', percentUsed: 60.4 },
      ],
    })
    expect(line).toContain('5h 38%')
    expect(line).toContain('7d 60%')
  })

  test('CL9 the order of the limits list does not move 5h before 7d', () => {
    const line = compactText({ limits: [...BOTH].reverse() })
    expect(line.indexOf('5h 38%')).toBeGreaterThanOrEqual(0)
    expect(line.indexOf('5h 38%')).toBeLessThan(line.indexOf('7d 61%'))
  })

  test('CL10 no line is wider than the width with limits in it, for every width from 20 to 200', () => {
    const long = { repo: 'r'.repeat(80), helpers: 12, costUsd: 1234.5, limits: BOTH }
    for (const given of [{ helpers: 2, limits: BOTH }, long, { ...long, chip: 'waiting-on-dave' as const, limits: null }]) {
      for (let width = 20; width <= 200; width++) expect(compactText(given, width).length).toBeLessThanOrEqual(width)
    }
  })

  test('CL10 the chip and ctx stay at every width from 20 to 200, with limits, with long fields', () => {
    const words = { working: 'WORKING', 'waiting-on-dave': 'WAITING FOR YOU', blocked: 'STUCK', done: 'DONE', idle: 'RESTING' } as const
    for (const chip of Object.keys(words) as (keyof typeof words)[]) {
      for (let width = 20; width <= 200; width++) {
        const line = text(compactLine(state({ chip, repo: 'r'.repeat(80), ...({ helpers: 12, limits: BOTH } as object) }), width))
        expect(line.startsWith(` ${words[chip]} `)).toBe(true)
        // ctx needs the whole chip plus its own 8 cells (' ctx 41%'); below that the chip alone stays, whole.
        if (width >= ` ${words[chip]} `.length + 8) expect(line).toContain('ctx 41%')
      }
    }
  })

  test('CL11 cut order: helpers go first, then cost, then repo text, then 7d, then 5h', () => {
    // A field present at a width needs every field that must outlive it present too: helpers => cost => repo => 7d => 5h.
    const rank = ['helpers', 'cost', 'repo', 'seven', 'five'] as const
    const seenCut = new Set<string>()
    for (let width = 20; width <= 200; width++) {
      const line = compactText({ helpers: 12, limits: BOTH }, width)
      const has = { helpers: line.includes('helpers running'), cost: line.includes('$1.84'), repo: line.includes('continuous-claude'), seven: line.includes('7d 61%'), five: line.includes('5h 38%') }
      for (let i = 0; i < rank.length - 1; i++) {
        if (has[rank[i] as keyof typeof has]) expect({ width, field: rank[i], next: has[rank[i + 1] as keyof typeof has] }).toEqual({ width, field: rank[i], next: true })
      }
      for (const key of rank) if (!has[key]) seenCut.add(key)
    }
    // The property above is vacuous if nothing is ever cut: every field must be cut at some width, and all are present at 200.
    expect([...seenCut].sort()).toEqual([...rank].sort())
    const wide = compactText({ helpers: 12, limits: BOTH }, 200)
    for (const part of ['continuous-claude', '5h 38%', '7d 61%', '$1.84', '12 helpers running']) expect(wide).toContain(part)
  })

  test('CL12 from 40 columns the chip, ctx, 5h and 7d show, whatever else is long', () => {
    for (let width = 40; width <= 200; width++) {
      const line = compactText({ helpers: 12, repo: 'r'.repeat(80), limits: BOTH }, width)
      for (const part of ['WORKING', 'ctx 41%', '5h 38%', '7d 61%']) expect({ width, part, shown: line.includes(part) }).toEqual({ width, part, shown: true })
    }
  })

  test('CL12 under 40 columns the repo, cost and helpers stay out, and the chip and ctx stay in', () => {
    for (const width of [20, 30, 39]) {
      const line = compactText({ helpers: 2, limits: BOTH }, width)
      expect(line).toContain('WORKING')
      expect(line).toContain('ctx 41%')
      for (const word of ['continuous-claude', '$', 'helper']) expect(line).not.toContain(word)
    }
  })

  test('CL13 limits not known yet read as a dash for 5h and 7d, never as a value', () => {
    for (const limits of [null, undefined]) {
      const line = compactText({ limits })
      expect(line).toContain('5h -')
      expect(line).toContain('7d -')
      for (const word of ['null', 'undefined', 'NaN']) expect(line).not.toContain(word)
    }
  })

  test('CL13 a non-finite percent is unknown: a dash, not NaN or a number', () => {
    const line = compactText({
      limits: [
        { kind: 'five_hour', percentUsed: Number.NaN },
        { kind: 'seven_day', percentUsed: 61 },
      ],
    })
    expect(line).toContain('5h -')
    expect(line).toContain('7d 61%')
    expect(line).not.toContain('NaN')
  })

  test('CL13 an account with no 5h or 7d window shows nothing for that figure, not a dash and not a value', () => {
    for (const limits of [[], [{ kind: 'spend_limit', percentUsed: 50 }]]) {
      const line = compactText({ limits })
      expect(line).toContain('ctx 41%')
      for (const word of ['5h', '7d', '50%', 'null', 'undefined']) expect(line).not.toContain(word)
    }
  })

  test('CL13 an account with only a 5-hour window shows 5h and nothing for 7d', () => {
    const line = compactText({ limits: [{ kind: 'five_hour', percentUsed: 38 }] })
    expect(line).toContain('5h 38%')
    expect(line).not.toContain('7d')
  })

  test('CL14 row 1 and the Goal row keep their shape: no 5h or 7d on them, whatever the state holds', () => {
    const given = state({ ...({ limits: BOTH } as object) })
    for (let width = 20; width <= 200; width += 10) {
      for (const hud of [true, false]) {
        for (const maxRows of [2, 3, 4]) {
          const { rows } = bandRows({ ...given, hud }, maxRows, width, false)
          const drawn = [rows.row1, rows.goal].map(text).join('\n')
          expect(drawn).not.toContain('5h')
          expect(drawn).not.toContain('7d')
        }
      }
    }
  })
})

describe('status band fixes (coord-status-band-fixes)', () => {
  const hudOn = (over: Partial<BandState> = {}) => state({ ...({ hud: true } as object), ...over })
  const rowOneAt = (given: BandState, maxRows: number, width = 120): string => text(bandRows(given, maxRows, width, false).rows.row1)

  test('SB1 when the HUD row draws, row 1 holds no ctx and no cost: the HUD row holds them (one source, drawn once)', () => {
    const line = rowOneAt(hudOn(), 3)
    expect(line).toContain('WORKING')
    expect(line).not.toContain('ctx')
    expect(line).not.toContain('$')
  })

  test('SB1b the compact line keeps ctx and cost even with the HUD flag, and row 1 keeps ctx when the HUD flag is absent', () => {
    expect(rowOneAt(state(), 2)).toContain('ctx 41%')
    expect(rowOneAt(state(), 2)).not.toContain('$')
    expect(text(compactLine(hudOn() as BandState, 120))).toContain('ctx 41%')
    expect(text(compactLine(hudOn() as BandState, 120))).toContain('$1.84')
  })

  // Old SB1c: with the HUD flag an unknown ctx and an unknown cost read as a dash on line 1. Now the HUD row owns ctx at maxRows 3 and draws `ctx -` itself (band-reliability HS9).
  test('SB1c with the HUD flag, an unknown ctx and cost draw nothing on row 1; with no HUD flag the unknown ctx reads ctx - and no cost draws', () => {
    const unknown = { ctx: null, costUsd: null }
    const hud = rowOneAt(hudOn(unknown), 3)
    expect(hud).not.toContain('ctx')
    expect(hud).not.toContain('$')
    const noHud = rowOneAt(state({ ...unknown, hud: false }), 2)
    expect(noHud).toContain('ctx -')
    expect(noHud).not.toContain('$')
  })

  // Old SB2: a waiting chip with helpers running showed "N helpers running" beside it on line 1. Row 1 has no helper text (design 2026-11-18, section 3); the compact line keeps it.
  test('SB2 row 1 draws no helper text under any chip; the compact line draws it', () => {
    for (const chip of ['waiting-on-dave', 'working'] as const) expect(rowOneAt(hudOn({ chip, helpers: 2 } as Partial<BandState>), 3)).not.toContain('helper')
    expect(text(compactLine(hudOn({ chip: 'waiting-on-dave', helpers: 2 } as Partial<BandState>), 120))).toContain('2 helpers running')
  })

  test('SB3 the band and the pane use the same five words, whatever the case', () => {
    const chips = ['working', 'waiting-on-dave', 'blocked', 'done', 'idle'] as const
    const first = (chip: (typeof chips)[number]) => (chipWord(chip).split(':')[0] ?? '').trim().toUpperCase()
    for (const chip of chips) expect(bandModel.CHIP[chip].word, chip).toBe(first(chip))
    expect(chips.map(chip => bandModel.CHIP[chip].word)).toEqual(['WORKING', 'WAITING FOR YOU', 'STUCK', 'DONE', 'RESTING'])
  })
})
