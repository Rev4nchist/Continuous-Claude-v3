import { describe, expect, test } from 'claude-code/testing'

import { emptyBrief } from '../hooks/agentic-os/brief'
import * as bandModel from '../hooks/agentic-os/band-model'
import type { BandState, RowPlan } from '../hooks/agentic-os/band-model'
import { cellWidth } from '../hooks/agentic-os/cells'
import { bandSpans, gaugeTone } from '../hooks/agentic-os/pane-model'
import type { Span } from '../hooks/agentic-os/pane-model'
import { fitHudParts, hudParts, hudSpans } from '../hooks/hud/model'
import { TONE } from '../hooks/shared/tones'
import type { HudState } from '../types'

// Card coord-status-band-2, PR A wave 2 (design note .claudedocs/coordination/2026-11-18-coord-status-band-2-redesign-design.md, sections 3, 5, 7).
// One pure plan (`rowPlan`) picks the rows, the owner of each of ctx, 5h, 7d and cost, the sign form and the kept fields of row 1.
// The band-model namespace is read by name, so a missing export fails one test and not the whole file.
//
// Ways it can fail, one test each (the number is the failure of the design note, section 7):
// 6  a row budget draws the wrong rows at some width, HUD state or quiet state (rowKinds in band-model.ts)
// 7  a number draws twice, a HUD-off band draws a limit or a cost, or the HUD row is not told what another row owns (planOf owners, hudSkipKeys)
// 8  at 20 columns the sign or the chip is cut, ctx beats the sign, or WAITING ON n TASKS gets a sign (row1Fit cut order)
// 9  the maxRows 1 line breaks the order chip, sign, ctx, 5h, 7d, goal, or draws the goal under MIN_GOAL cells (lineFit)
// 10 the sign form is wrong for the room, shows a wrong number, or is not amber under some chip (signText, signSpans)
// 11 RESTING keeps a fill or WAITING ON n TASKS loses its fill, `unnamed` or `goal not set` is amber (CHIP, whoSpans)
// 12 `#sid8` does not return when the room is there (row1Fit cut order)
// 15 the widget row draws the plan title, the plan bar or ctx (pane-model bandSpans)
// 16 a row-1 gauge keeps the HUD tones, or the HUD gauge tone changes (rowGaugeTone, gaugeTone)
// 23 compactKeys differs from what the compact line drew, or the HUD row draws a number the compact line owns (compactFit, hudSkipKeys)
// 4  a name or a lane is counted in UTF-16 units: a wide name passes the width

const text = (spans: Span[] | undefined): string => (spans ?? []).map(span => span.text).join('')
const cells = (spans: Span[] | undefined): number => cellWidth(text(spans))

type Planner = {
  rowPlan: (s: BandState, maxRows: number, width: number, quiet: boolean) => RowPlan
  bandRows: (s: BandState, maxRows: number, width: number, quiet: boolean) => { plan: RowPlan; rows: Partial<Record<'line' | 'compact' | 'row1' | 'goal', Span[]>> }
  rowGaugeTone: (percent: number) => string
  hudSkipKeys: (plan: RowPlan) => string[]
}
const band = bandModel as unknown as Planner
const CHIP = bandModel.CHIP

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'working',
  brief: null,
  tasks: [],
  repo: 'continuous-claude',
  lane: 'dash-header',
  laneGoal: 'Dave sees the true state of a session',
  ctx: 41,
  costUsd: 1.84,
  now: 1_000,
  activeAt: 1_000,
  who: { name: 'trex', short: '0d40499c' },
  hud: true,
  limits: [
    { kind: 'five_hour', percentUsed: 38 },
    { kind: 'seven_day', percentUsed: 61 },
  ],
  ...over,
})

const hudState = (): HudState =>
  ({
    model: 'claude-sonnet-5-5',
    effort: 'high',
    costUsd: 1.84,
    limits: [
      { kind: 'five_hour', percentUsed: 38 },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    advisor: { state: 'off', calls: 0 },
  }) as HudState

const WIDTHS = [20, 35, 40, 56, 80, 120]
const NO_HUD = (over: Partial<BandState> = {}): BandState => state({ hud: false, limits: null, ...over })

/** Everything the band draws as text: the rows of this module and the HUD row (as the render builds it: the skip keys, then the terminal fit). */
const drawnText = (s: BandState, maxRows: number, width: number, quiet: boolean): string => {
  const { plan, rows } = band.bandRows(s, maxRows, width, quiet)
  const own = [rows.line, rows.compact, rows.row1, rows.goal].map(text)
  const hud = plan.rows.includes('hud') ? [text(hudSpans(fitHudParts(hudParts(hudState(), s.ctx, null, band.hudSkipKeys(plan)), width)))] : []
  return [...own, ...hud].join('\n')
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('row plan: rows by maxRows (failure 6)', () => {
  const ON: Record<number, string[]> = { 1: ['line'], 2: ['compact', 'hud'], 3: ['row1', 'goal', 'hud'], 4: ['row1', 'goal', 'hud', 'widget'] }
  const OFF: Record<number, string[]> = { 1: ['line'], 2: ['row1', 'goal'], 3: ['row1', 'goal', 'widget'], 4: ['row1', 'goal', 'widget'] }

  // Breaks if rowKinds changes a budget: the HUD pair at 2 rows, the goal row at 3, the widget row at 4 (3 with the HUD off), or the quiet rule.
  test('P6 maxRows 1 to 4 at 20, 35, 40, 56, 80 and 120 columns, HUD on and off, quiet and not, plan the listed rows', () => {
    for (const width of WIDTHS) {
      for (const maxRows of [1, 2, 3, 4]) {
        for (const quiet of [false, true]) {
          const on = band.rowPlan(state(), maxRows, width, quiet).rows
          const off = band.rowPlan(NO_HUD(), maxRows, width, quiet).rows
          const without = (rows: string[]) => (quiet ? rows.filter(one => one !== 'widget') : rows)
          expect({ width, maxRows, quiet, on }).toEqual({ width, maxRows, quiet, on: without(ON[maxRows] ?? []) })
          expect({ width, maxRows, quiet, off }).toEqual({ width, maxRows, quiet, off: without(OFF[maxRows] ?? []) })
        }
      }
    }
  })

  // Breaks if the goal row is dropped by width: it must draw at 20 columns and wider, within the width.
  test('P6 the goal row draws at every width from 20 at maxRows 3 with the HUD, and at maxRows 2 without it', () => {
    for (let width = 20; width <= 120; width++) {
      for (const [given, maxRows] of [[state(), 3], [NO_HUD(), 2]] as const) {
        const goal = band.bandRows(given, maxRows, width, false).rows.goal
        expect({ width, maxRows, drawn: text(goal) !== '' }).toEqual({ width, maxRows, drawn: true })
        expect(cells(goal)).toBeLessThanOrEqual(width)
      }
    }
  })

  // Breaks if a maxRows under 1 draws rows (the render returns before the plan, but the plan must agree).
  test('P6 no rows below one row of room', () => {
    expect(band.rowPlan(state(), 0, 80, false).rows).toEqual([])
  })
})

describe('row plan: no number twice (failure 7)', () => {
  const cases = (): [string, BandState][] => [
    ['plain', state()],
    ['open ask', state({ chip: 'waiting-on-dave', openAsks: 2, laneCount: 3 })],
  ]

  // Breaks if two rows own one number: ctx, 5h, 7d or the cost drawn in the rows of the module and again in the HUD row.
  test('P7 at every width, row budget and quiet state with the HUD on, ctx, 5h, 7d and the cost each draw at most once', () => {
    for (const [name, given] of cases()) {
      for (const width of WIDTHS) {
        for (const maxRows of [1, 2, 3, 4]) {
          for (const quiet of [false, true]) {
            const all = drawnText(given, maxRows, width, quiet)
            const most = Math.max(count(all, 'ctx 41%'), count(all, '5h '), count(all, '7d '), count(all, '$1.84'))
            expect({ name, width, maxRows, quiet, most }).toEqual({ name, width, maxRows, quiet, most: Math.min(most, 1) })
          }
        }
      }
    }
  })

  // Breaks if row 1 draws a number while the HUD row is a row of the plan (maxRows 3 and more): the HUD owns all four.
  test('P7 with the HUD row drawn at maxRows 3 and 4, the HUD owns all four numbers and row 1 and the goal row hold none', () => {
    for (const width of WIDTHS) {
      for (const maxRows of [3, 4]) {
        const { plan, rows } = band.bandRows(state({ ctx: null, costUsd: null }), maxRows, width, false)
        expect(plan.owners).toEqual({ ctx: 'hud', five: 'hud', seven: 'hud', cost: 'hud' })
        expect(band.hudSkipKeys(plan)).toEqual([])
        expect(text(rows.row1)).not.toMatch(/ctx|5h|7d|\$/)
      }
    }
  })

  // Breaks if a HUD-off band draws a limit field or a cost (the HUD atom is null there: no dash for a window nobody reads).
  test('P7 with the HUD off, no row draws 5h, 7d or a cost, at every width and budget; row 1 owns ctx only, and maxRows 1 owns ctx', () => {
    for (const width of WIDTHS) {
      for (const maxRows of [1, 2, 3, 4]) {
        const { plan } = band.bandRows(NO_HUD(), maxRows, width, false)
        const all = drawnText(NO_HUD(), maxRows, width, false)
        expect({ width, maxRows, limit: /5h|7d/.test(all), cost: all.includes('$') }).toEqual({ width, maxRows, limit: false, cost: false })
        expect(plan.owners.five).toBeNull()
        expect(plan.owners.seven).toBeNull()
        expect(plan.owners.cost).toBeNull()
        if (width >= 35) expect(plan.owners.ctx).toBe(maxRows === 1 ? 'line' : 'row1')
      }
    }
  })

  // Breaks if the plan leaves ctx to the HUD while ctx is null and the HUD row has no way to draw it: the owner stays 'hud' so index.tsx draws `ctx -`.
  test('P7 a null ctx is owned by the HUD row at maxRows 3 and by the row that draws `ctx -` otherwise', () => {
    expect(band.rowPlan(state({ ctx: null }), 3, 80, false).owners.ctx).toBe('hud')
    const one = band.bandRows(state({ ctx: null }), 1, 80, false)
    expect(one.plan.owners.ctx).toBe('line')
    expect(text(one.rows.line)).toContain('ctx -')
    const off = band.bandRows(NO_HUD({ ctx: null }), 2, 80, false)
    expect(text(off.rows.row1)).toContain('ctx -')
  })
})

describe('row plan: 20 columns with an open ask (failure 8)', () => {
  const ask = (over: Partial<BandState> = {}) => state({ chip: 'waiting-on-dave', openAsks: 2, ...over })

  // Breaks if ctx stays and the sign goes, or the chip or the sign is cut: ' WAITING FOR YOU ' (17) + ' ?2' (3) = 20 cells.
  test('P8 row 1 at 20 columns keeps WAITING FOR YOU and ?2 whole, in 20 cells, and drops ctx (HUD off)', () => {
    const { plan, rows } = band.bandRows(NO_HUD({ chip: 'waiting-on-dave', openAsks: 2 }), 2, 20, false)
    expect(text(rows.row1)).toBe(' WAITING FOR YOU  ?2')
    expect(cells(rows.row1)).toBe(20)
    expect(plan.signForm).toBe('tight')
    expect(plan.row1Shape).toEqual(['chip', 'sign'])
    expect(plan.owners.ctx).toBeNull()
  })

  // Breaks if a count of 1 to 9 is cut or shows a wrong digit, or 10 and more shows a number that is not the count: ?+ stands for 10 or more.
  test('P8 the tight sign reads ?1 to ?9 and ?+ from 10, at 20 columns', () => {
    for (let n = 1; n <= 12; n++) {
      const row = text(band.bandRows(NO_HUD({ chip: 'waiting-on-dave', openAsks: n }), 2, 20, false).rows.row1)
      expect({ n, row }).toEqual({ n, row: n <= 9 ? ` WAITING FOR YOU  ?${n}` : ' WAITING FOR YOU  ?+' })
    }
  })

  // Breaks if the maxRows 1 line or the compact line keeps ctx over the sign, or a HUD row of maxRows 3 loses ctx (the HUD owns it there).
  test('P8 the one-row line and the compact line at 20 columns keep chip and sign whole and drop ctx; with the HUD row at 3 rows the HUD owns ctx', () => {
    const line = band.bandRows(ask(), 1, 20, false)
    expect(text(line.rows.line)).toBe(' WAITING FOR YOU  ?2')
    expect(line.plan.owners.ctx).toBeNull()
    const compact = band.bandRows(ask(), 2, 20, false)
    expect(text(compact.rows.compact)).toBe(' WAITING FOR YOU  ?2')
    expect(compact.plan.compactKeys).toEqual(['ask'])
    expect(compact.plan.owners.ctx).toBe('hud')
    const three = band.bandRows(ask(), 3, 20, false)
    expect(text(three.rows.row1)).toBe(' WAITING FOR YOU  ?2')
    expect(three.plan.owners.ctx).toBe('hud')
  })

  // Breaks if WAITING ON n TASKS gets a sign it has no room for, or is swapped for WAITING FOR YOU (the old chipFor), or draws ctx past 20 cells.
  test('P8 WAITING ON 3 TASKS at 20 columns keeps its own word, draws no sign and no ctx; with room it draws the sign', () => {
    const wait = (over: Partial<BandState> = {}) => NO_HUD({ chip: 'waiting-on-work', waitTasks: 3, ...over })
    for (const openAsks of [0, 2]) {
      const row = text(band.bandRows(wait({ openAsks }), 2, 20, false).rows.row1)
      expect(row).toBe(' WAITING ON 3 TASKS ')
    }
    expect(text(band.bandRows(wait({ openAsks: 2 }), 2, 80, false).rows.row1)).toContain('2 questions')
  })
})

describe('row plan: the maxRows 1 line (failure 9)', () => {
  const line = (over: Partial<BandState>, width: number) => band.bandRows(state(over), 1, width, false)

  // Breaks if the order of the fields changes, or a name, repo, helper count or cost sneaks in.
  test('P9 the line is chip, sign, ctx, 5h, 7d, goal in that order, and has no name, repo, helpers or cost', () => {
    const { plan, rows } = line({ chip: 'waiting-on-dave', openAsks: 2, helpers: 3 }, 200)
    const got = text(rows.line)
    const at = [' WAITING FOR YOU ', '2 questions', 'ctx 41%', '5h 38%', '7d 61%', 'Dave sees'].map(part => got.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const word of ['trex', 'continuous-claude', 'helper', '$']) expect(got).not.toContain(word)
    expect(plan.row1Shape).toEqual(['chip', 'sign', 'ctx', 'five', 'seven', 'goal'])
  })

  // Breaks if a later field outlives an earlier one as the width shrinks: the fields that stay are always a prefix of ctx, 5h, 7d, goal.
  test('P9 at every width from 20 to 120 the kept fields are a prefix of ctx, 5h, 7d, goal, and the line fits', () => {
    const order = ['ctx', 'five', 'seven', 'goal']
    const seenAt: Record<string, number> = {}
    for (let width = 20; width <= 120; width++) {
      const { plan, rows } = line({}, width)
      const kept = plan.row1Shape.filter(key => order.includes(key))
      expect({ width, kept }).toEqual({ width, kept: order.slice(0, kept.length) })
      expect(cells(rows.line)).toBeLessThanOrEqual(width)
      for (const key of kept) seenAt[key] ??= width
    }
    // Chip 9 + ctx 8 + 5h 7 + 7d 7 = 31 cells; the goal needs a space and MIN_GOAL (12) more cells: it appears at 44 and not at 43.
    expect(seenAt).toEqual({ ctx: 20, five: 24, seven: 31, goal: 44 })
  })

  // Breaks if the goal is drawn with fewer than 12 cells, or hidden with 12: at 44 columns the goal text is clipped to 12 cells.
  test('P9 the goal draws at 12 cells of room and is clipped to them', () => {
    expect(cells(line({}, 44).rows.line)).toBeLessThanOrEqual(44)
    expect(text(line({}, 44).rows.line)).toMatch(/ Dave sees…$/)
    expect(text(line({}, 43).rows.line)).not.toContain('Dave')
    expect(text(line({ laneGoal: null }, 44).rows.line)).toMatch(/ goal not set$/)
  })
})

describe('row plan: the sign (failure 10)', () => {
  const row1 = (over: Partial<BandState>, width: number) => band.bandRows(NO_HUD({ who: undefined, ...over }), 2, width, false)

  // Breaks if a form shows a wrong number, the singular reads wrong, or the room does not pick the form.
  test('P10 forms: 2 questions, 1 question, ? 2, ? 12, ?2, ?+, chosen by the room', () => {
    const forms = (n: number) => {
      const seen = new Map<string, string>()
      for (let width = 20; width <= 120; width++) {
        const { plan, rows } = row1({ chip: 'waiting-on-dave', openAsks: n, lane: 'x' }, width)
        const sign = (rows.row1 ?? []).find(span => span.tone === 'warn')?.text ?? ''
        if (!seen.has(plan.signForm)) seen.set(plan.signForm, sign)
      }
      return Object.fromEntries(seen)
    }
    expect(forms(2)).toEqual({ words: '2 questions', short: '? 2', tight: '?2' })
    expect(forms(1)).toEqual({ words: '1 question', short: '? 1', tight: '?1' })
    expect(forms(12)).toEqual({ words: '12 questions', short: '? 12', tight: '?+' })
  })

  // Breaks if the form grows as the width shrinks (words, then short, then tight is the only order), or the sign is cut.
  test('P10 as the width shrinks the form goes words, short, tight and is never cut', () => {
    const rank: Record<string, number> = { words: 0, short: 1, tight: 2 }
    let last = 0
    for (let width = 120; width >= 20; width--) {
      const { plan, rows } = row1({ chip: 'waiting-on-dave', openAsks: 12, lane: 'x' }, width)
      expect(rank[plan.signForm]).toBeGreaterThanOrEqual(last)
      last = rank[plan.signForm] ?? last
      expect(text(rows.row1)).toMatch(/12 questions|\? 12|\?\+/)
    }
  })

  // Breaks if the sign takes the tone of the chip: it is amber under every chip, STUCK included.
  test('P10 the sign is amber (warn) under every chip', () => {
    for (const chip of ['working', 'waiting-on-dave', 'waiting-on-work', 'blocked', 'done', 'idle'] as const) {
      const { rows } = row1({ chip, openAsks: 2 }, 120)
      expect({ chip, tone: (rows.row1 ?? []).find(span => span.text === '2 questions')?.tone }).toEqual({ chip, tone: 'warn' })
    }
  })

  // Breaks if the sign reads anything but openAsks: a stored parsed ask in the brief draws none.
  test('P10 no open ask draws no sign, and the sign never reads a stored ask', () => {
    const parsedAsk = { kind: 'question', text: 'Open the PR?', source: 'parsed' } as const
    const { rows } = row1({ brief: { ...emptyBrief(1_000), ask: [parsedAsk] } }, 120)
    expect(text(rows.row1)).not.toMatch(/question|\?/)
  })
})

describe('row plan: tones (failure 11)', () => {
  // Breaks if RESTING gets a fill again, or WAITING ON n TASKS loses its grey fill.
  test('P11 RESTING is dim text with no fill; WAITING ON n TASKS keeps the grey fill', () => {
    expect(CHIP.idle.tone).toBe('dim')
    expect(TONE.dim.backgroundColor).toBeUndefined()
    const rest = band.bandRows(NO_HUD({ chip: 'idle' }), 2, 120, false).rows.row1?.[0]
    expect(rest).toEqual({ text: ' RESTING ', tone: 'dim' })
    const wait = band.bandRows(NO_HUD({ chip: 'waiting-on-work', waitTasks: 2 }), 2, 120, false).rows.row1?.[0]
    expect(wait).toEqual({ text: ' WAITING ON 2 TASKS ', tone: 'chipDim' })
    expect(TONE.chipDim.backgroundColor).toBeDefined()
  })

  // Breaks if `unnamed` or `goal not set` is amber again: amber means Dave must act.
  test('P11 `unnamed` and `goal not set` are dim', () => {
    const rows = band.bandRows(NO_HUD({ who: { name: null, short: null }, laneGoal: null }), 2, 120, false).rows
    expect((rows.row1 ?? []).find(span => span.text === 'unnamed')?.tone).toBe('dim')
    expect(rows.goal).toEqual([{ text: 'goal not set', tone: 'dim' }])
  })
})

describe('row plan: #sid8 (failure 12)', () => {
  // Breaks if `#sid8` is cut first at the wrong width: it must be present exactly when the whole row fits, and gone one cell earlier.
  test('P12 #sid8 is on row 1 when the whole row fits, gone one cell narrower, and back at every wider width', () => {
    const given = NO_HUD({ laneCount: 2 })
    const full = cells(band.bandRows(given, 2, 200, false).rows.row1)
    expect(text(band.bandRows(given, 2, 200, false).rows.row1)).toContain('#0d40499c')
    expect(text(band.bandRows(given, 2, full, false).rows.row1)).toContain('#0d40499c')
    const narrower = band.bandRows(given, 2, full - 1, false)
    expect(text(narrower.rows.row1)).not.toContain('#0d40499c')
    expect(text(narrower.rows.row1)).toContain('+1')
    expect(narrower.plan.row1Shape).not.toContain('sid')
    for (let width = full; width <= 200; width++) expect(band.bandRows(given, 2, width, false).plan.row1Shape).toContain('sid')
  })

  // Breaks if the cut order changes: #sid8, +N more, sign word to ? n, lane, name (to 8, then to the room beside ctx, then gone), ctx, ? n to ?n.
  test('P12 the row 1 cut order, widths and shapes from the widest row down', () => {
    const given = NO_HUD({ chip: 'waiting-on-dave', openAsks: 2, laneCount: 2, who: { name: 'long-name-here', short: '0d40499c' } })
    const shapes: string[] = []
    const widths: number[] = []
    for (let width = 120; width >= 20; width--) {
      const got = band.bandRows(given, 2, width, false)
      const row = text(got.rows.row1)
      const name = got.plan.row1Shape.includes('name') ? (row.includes('long-name-here') ? 'long' : 'cut') : 'none'
      const key = `${got.plan.signForm}|${got.plan.row1Shape.join(',')}|${row.includes('+1') ? 'more' : 'nomore'}|${name}`
      if (shapes[shapes.length - 1] !== key) {
        shapes.push(key)
        widths.push(width)
      }
      expect(cells(got.rows.row1)).toBeLessThanOrEqual(width)
    }
    expect(shapes).toEqual([
      'words|chip,sign,name,sid,lane,ctx|more|long',
      'words|chip,sign,name,lane,ctx|more|long',
      'words|chip,sign,name,lane,ctx|nomore|long',
      'short|chip,sign,name,lane,ctx|nomore|long',
      'short|chip,sign,name,ctx|nomore|long',
      'short|chip,sign,name,ctx|nomore|cut',
      'short|chip,sign,ctx|nomore|none',
      'short|chip,sign|nomore|none',
      'tight|chip,sign|nomore|none',
    ])
    expect(widths).toEqual([120, 86, 76, 73, 65, 46, 35, 29, 20])
  })
})

describe('row plan: widths in cells (failure 4)', () => {
  // Breaks if the name or the lane is counted in UTF-16 units: 12 wide letters are 24 cells and 12 units.
  test('P4 a wide name and a wide lane never pass the width, at every width from 20 to 120, on row 1 and the one-row line', () => {
    const given = NO_HUD({ who: { name: '界'.repeat(12), short: '0d40499c' }, lane: '日本語'.repeat(8), laneCount: 3 })
    for (let width = 20; width <= 120; width++) {
      expect({ width, fits: cells(band.bandRows(given, 2, width, false).rows.row1) <= width }).toEqual({ width, fits: true })
      expect({ width, fits: cells(band.bandRows({ ...given, hud: true }, 3, width, false).rows.row1) <= width }).toEqual({ width, fits: true })
    }
    const wide = text(band.bandRows(given, 2, 60, false).rows.row1)
    expect(wide).toContain('界')
    expect(cellWidth(wide)).toBeLessThanOrEqual(60)
  })
})

describe('widget row (failure 15)', () => {
  // Breaks if the plan title, the plan bar (N/M done) or ctx comes back; the active task, the step and the PRs stay.
  test('P15 the widget row has no plan title, no plan bar and no ctx; it keeps the active task, the step and the PRs', () => {
    const view = {
      tasks: [
        { id: '1', subject: 'build it', status: 'completed' },
        { id: '2', subject: 'test it', status: 'in_progress', activeForm: 'Testing it' },
      ],
      plan: { title: 'The big plan' },
      turn: null,
      step: { id: 's', tool: 'Bash', label: 'npm test', startedAt: 0 },
      ctx: 42,
      agents: [],
      lanes: null,
      prs: [{ pr: 7, state: 'REVIEWED' }],
    }
    const got = text(bandSpans(view as never, 5_000, 120))
    expect(got).toContain('Testing it')
    expect(got).toContain('Bash npm test')
    expect(got).toContain('PR #7!')
    for (const word of ['The big plan', 'done', 'ctx', '▰', '▱']) expect(got).not.toContain(word)
  })
})

describe('row gauge tone (failure 16)', () => {
  // Breaks if the row-1 gauge keeps ok or warn: it is dim under 75 and red from 75.
  test('P16 rowGaugeTone is dim under 75 and bad from 75', () => {
    for (const percent of [0, 49, 50, 74]) expect(band.rowGaugeTone(percent)).toBe('dim')
    for (const percent of [75, 90, 100]) expect(band.rowGaugeTone(percent)).toBe('bad')
  })

  // Breaks if the HUD row loses its heat tones: gaugeTone stays green, amber, red.
  test('P16 gaugeTone is unchanged for the HUD row: ok under 50, warn under 75, bad from 75', () => {
    expect([0, 49, 50, 74, 75].map(gaugeTone)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad'])
  })

  // Breaks if a row draws a gauge with the HUD tones: ctx, 5h and 7d on row 1, the line and the compact line.
  test('P16 ctx, 5h and 7d on row 1, the one-row line and the compact line use the row gauge tone', () => {
    const tone = (spans: Span[] | undefined, part: string) => (spans ?? []).find(span => span.text.startsWith(part))?.tone
    const limits = [
      { kind: 'five_hour', percentUsed: 74 },
      { kind: 'seven_day', percentUsed: 75 },
    ]
    for (const [ctx, expected] of [[49, 'dim'], [60, 'dim'], [74, 'dim'], [75, 'bad'], [99, 'bad']] as const) {
      expect(tone(band.bandRows(NO_HUD({ ctx }), 2, 120, false).rows.row1, 'ctx ')).toBe(expected)
      expect(tone(band.bandRows(state({ ctx, limits }), 1, 120, false).rows.line, 'ctx ')).toBe(expected)
      expect(tone(band.bandRows(state({ ctx, limits }), 2, 120, false).rows.compact, 'ctx ')).toBe(expected)
    }
    for (const rows of [band.bandRows(state({ limits }), 1, 120, false).rows.line, band.bandRows(state({ limits }), 2, 120, false).rows.compact]) {
      expect(tone(rows, '5h ')).toBe('dim')
      expect(tone(rows, '7d ')).toBe('bad')
    }
  })
})

describe('row plan: the compact line and the HUD row (failure 23)', () => {
  const owned = (all: string): string[] => [['ctx', 'ctx '], ['five', '5h '], ['seven', '7d '], ['cost', '$']].filter(([, mark]) => all.includes(mark as string)).map(([key]) => key as string)

  // Breaks if compactKeys is a copy that drifts from the drawing: at every width the keys equal the fields found in the drawn text.
  test('P23 at maxRows 2 compactKeys equals the compact line drawn fields, and the compact line owns exactly its own numbers', () => {
    for (let width = 20; width <= 120; width++) {
      const { plan, rows } = band.bandRows(state({ chip: 'waiting-on-dave', openAsks: 2, helpers: 2 }), 2, width, false)
      const drawn = text(rows.compact)
      const keys = plan.compactKeys.filter(key => ['ctx', 'five', 'seven', 'cost'].includes(key))
      expect({ width, keys }).toEqual({ width, keys: owned(drawn) })
      expect(plan.compactKeys.includes('ask')).toBe(/\? ?\d|questions?/.test(drawn))
      expect(plan.compactKeys.includes('helpers')).toBe(drawn.includes('helpers running'))
      expect(cells(rows.compact)).toBeLessThanOrEqual(Math.max(width, 20))
      for (const key of ['ctx', 'five', 'seven', 'cost'] as const) expect(plan.owners[key]).toBe(keys.includes(key) ? 'compact' : 'hud')
    }
  })

  // Breaks if the HUD row draws a number the compact line owns, or does not draw one the compact line dropped.
  test('P23 the HUD row skips what the compact line drew and draws the rest', () => {
    const asHud = (plan: RowPlan) => hudParts(hudState(), 41, null, band.hudSkipKeys(plan)).map(part => part.key)
    const wide = band.bandRows(state(), 2, 120, false).plan
    expect(wide.compactKeys).toEqual(expect.arrayContaining(['ctx', 'five', 'seven', 'cost']))
    expect(asHud(wide)).toEqual(['hud-model', 'hud-advisor'])
    const narrow = band.bandRows(state({ chip: 'waiting-on-dave', openAsks: 2 }), 2, 20, false).plan
    expect(narrow.compactKeys).toEqual(['ask'])
    expect(asHud(narrow)).toEqual(['hud-model', 'hud-ctx', 'hud-advisor', 'hud-cost', 'hud-limit-five_hour', 'hud-limit-seven_day'])
    const mid = band.bandRows(state(), 2, 35, false).plan
    // The name outlives 7d on the compact line (cut order: helpers, cost, repo, sign word, 7d, 5h, name, ctx): 7d moves to the HUD row.
    expect(mid.compactKeys).toEqual(['name', 'ctx', 'five'])
    expect(asHud(mid)).toEqual(['hud-model', 'hud-advisor', 'hud-cost', 'hud-limit-seven_day'])
  })
})
