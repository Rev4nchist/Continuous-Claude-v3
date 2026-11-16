import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, emptyBrief, markAsksAnswered, mergeParsed } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import * as bandModel from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import type { Span } from '../hooks/agentic-os/pane-model'
import { chipWord } from '../hooks/agentic-os/plain'
import { TONE } from '../hooks/shared/tones'
import type { OsTask } from '../types'

// compactLine is new in /os redesign round 2. A namespace read keeps a missing export from failing the whole file.
const { bandLines } = bandModel
const compactLine = (bandModel as unknown as { compactLine: (state: BandState, width: number) => Span[] }).compactLine

// Ways the two core band lines (PRD 5.3) can fail, one test each. Every check reads the drawn text and tones.
// L1 a chip word is wrong, shortened, or two states share a tone
// L2 line 1 loses a field, or shows a field the state does not have as if it were set
// L3 GOAL not set is hidden, or loses the warning tone
// L4 a parsed goal looks like a brief_set goal, or a blank goal reads as set
// L5 an answered ask is counted, or a stale ask looks fresh
// L6 UNPROVEN misses a done step with no proof, counts a proven one, or lets a proof for another subject count
// L7 the plan bar is not block characters, shows the wrong N/M, or grows past its room
// L8 a line overruns the width, the chip is cut, or the goal is not the first thing cut
// L9 below 40 columns more than the chip and the goal is drawn
// L10 a secret in the state reaches the drawn text
// L11 ASK and UNPROVEN keep the wrong tone
//
// compactLine(state, width) is the ONE line the band draws when maxRows leaves no room for two core lines plus the HUD row
// (/os redesign, Band reliability item 2). Contract: chip, repo, ctx, cost, helpers running, in that order; BandState gains
// an optional `helpers` (the number of running helpers; absent or 0 draws no helper text); helper text reads "N helpers running"
// ("1 helper running" for one). Pure. Ways it can fail, one test each:
// CL1 a field is missing or out of order, or the line carries a core-line field (lane, GOAL, PLAN, ASK, UNPROVEN)
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
// A non-finite percent is unknown ("-"), never a made-up number. The two core lines (bandLines) keep their PRD 5.3 shape: no 5h or 7d.
// CL9  the limits are missing, in the wrong place, or rounded differently from the HUD row
// CL10 the line is wider than the width with limits in it, or the chip or ctx is cut at some width
// CL11 the cut order is wrong: at some width a field stays while a field that must outlive it is gone
// CL12 5h and 7d are cut at 40 columns or more, where chip, ctx, 5h and 7d fit; under 40 the repo, cost or helpers sneak back
// CL13 an unknown limit reads as a value, null, NaN or a gap; a missing window draws a made-up figure or a dash
// CL14 the core lines grow 5h or 7d (they must stay as PRD 5.3 draws them)

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')
const all = (lines: Span[][]): string => lines.map(text).join('\n')

const task = (id: string, subject: string, status: OsTask['status']): OsTask => ({ id, subject, status })

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

const briefWith = (raw: Record<string, unknown>, tasks: OsTask[] = [], prev: Brief | null = null): Brief => {
  const made = applyBrief(prev, raw, tasks, 1_000)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const lineOf = (over: Partial<BandState>, width = 120, index = 1): string => text(bandLines(state(over), width)[index])

describe('band line 1', () => {
  test('L1 each chip state draws its own word and its own tone', () => {
    // Mockup: WORKING is a blue chip. Amber is only for a person being needed (waiting-on-dave).
    const chips = {
      working: ['WORKING', 'chipDoing'],
      'waiting-on-dave': ['WAITING FOR YOU', 'chipWarn'],
      blocked: ['STUCK', 'chipBad'],
      done: ['DONE', 'chipOk'],
      idle: ['RESTING', 'chipDim'],
    } as const
    for (const [chip, [word, tone]] of Object.entries(chips)) {
      const [one] = bandLines(state({ chip: chip as BandState['chip'] }), 120)
      const span = one?.[0]
      expect(span?.text.trim()).toBe(word)
      expect(span?.tone).toBe(tone)
    }
  })

  test('L1 the working chip and the plan bar draw blue, never the orange of the claude accent', () => {
    expect(TONE.chipDoing).toEqual({ color: 'inverseText', backgroundColor: 'suggestion', bold: true })
    expect(TONE.doing).toEqual({ color: 'suggestion', bold: true })
    expect(TONE.chipWarn.backgroundColor).toBe('warning')
  })

  test('L2 line 1 holds chip, lane, ctx and cost, in that order, and no repo or branch (the statusline shows them)', () => {
    const line = text(bandLines(state(), 120)[0])
    const at = ['WORKING', 'lane dash-header', 'ctx 41%', '$1.84'].map(part => line.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(line).not.toContain('continuous-claude')
  })

  test('L2 a field the state does not have reads as a dash, not as a value and not as a gap', () => {
    const line = text(bandLines(state({ repo: null, lane: null, ctx: null, costUsd: null }), 120)[0])
    expect(line).toContain('lane -')
    expect(line).toContain('ctx -')
    expect(line).toContain('$-')
    expect(line).not.toContain('null')
    expect(line).not.toContain('undefined')
  })
})

describe('band line 2: goal', () => {
  test('L3 no brief: GOAL not set shows, in the warning tone, and no fallback text', () => {
    const line = bandLines(state(), 120)[1] ?? []
    expect(text(line)).toContain('GOAL not set')
    expect(line.find(span => span.text.includes('not set'))?.tone).toBe('warn')
    expect(text(line)).toMatch(/GOAL not set\s+PLAN/)
  })

  test('L4 a brief_set goal has no marker; a parsed goal is marked parsed', () => {
    const set = briefWith({ goal: 'Add session header' })
    expect(lineOf({ brief: set })).not.toContain('parsed')
    const parsed = mergeParsed(null, { goal: { text: 'Add session header', source: 'parsed' } }, 1_000)
    expect(lineOf({ brief: parsed })).toMatch(/GOAL Add session header\s+\[parsed\]/)
  })

  test('L4 a blank goal reads as not set', () => {
    const blank: Brief = { ...emptyBrief(1_000), goal: '   ' }
    expect(lineOf({ brief: blank })).toContain('GOAL not set')
  })
})

describe('band line 2: ASK and UNPROVEN', () => {
  const asks = [
    { kind: 'question', text: 'Which branch?' },
    { kind: 'approval', text: 'Merge it?' },
  ]

  test('L5 open asks are counted', () => {
    expect(lineOf({ brief: briefWith({ ask: asks }) })).toContain('ASK 2')
  })

  test('L5 answered asks are not counted, and show dim as answered?', () => {
    const answered = markAsksAnswered(briefWith({ ask: asks }), 1_000)
    const line = bandLines(state({ brief: answered }), 120)[1] ?? []
    expect(text(line)).toContain('ASK 0')
    expect(text(line)).not.toContain('ASK 2')
    expect(line.find(span => span.text.includes('answered?'))?.tone).toBe('dim')
    expect(text(line)).toContain('2 answered?')
  })

  test('L5 one answered and one fresh ask: counts the fresh one only', () => {
    const first = markAsksAnswered(briefWith({ ask: [asks[0]] }), 1_000)
    const next: Brief = { ...first, ask: [...first.ask, { kind: 'question', text: 'New?', source: 'brief_set' }] }
    const got = lineOf({ brief: next })
    expect(got).toContain('ASK 1')
    expect(got).toContain('1 answered?')
  })

  test('L5 an ask 24 hours old reads stale and dim, not as a fresh ask', () => {
    const brief = briefWith({ ask: asks })
    const day = 24 * 3600_000
    const line = bandLines(state({ brief, now: 1_000 + day, activeAt: 1_000 }), 120)[1] ?? []
    expect(text(line)).toContain('ASK 2 stale')
    expect(line.find(span => span.text.includes('ASK'))?.tone).toBe('dim')
  })

  test('L6 a done task with no proof is unproven; a proven one is not', () => {
    const tasks = [task('1', 'build it', 'completed'), task('2', 'test it', 'completed'), task('3', 'ship it', 'pending')]
    expect(lineOf({ tasks })).toContain('UNPROVEN 2')
    const proven = briefWith({ proof: { taskId: '1', artifact: 'out.log' } }, tasks)
    expect(lineOf({ tasks, brief: proven })).toContain('UNPROVEN 1')
  })

  test('L6 a plan step that is done and has no proof is unproven too', () => {
    const plan = [
      { id: 'a', text: 'one', status: 'done' },
      { id: 'b', text: 'two', status: 'done' },
      { id: 'c', text: 'three', status: 'doing' },
    ]
    const brief = briefWith({ plan })
    expect(lineOf({ brief })).toContain('UNPROVEN 2')
    const proven = briefWith({ proof: { taskId: 'a', artifact: 'x' } }, [], brief)
    expect(lineOf({ brief: proven })).toContain('UNPROVEN 1')
  })

  test('L6 a proof for a task that was reworded does not count for the new subject', () => {
    const before = [task('1', 'build it', 'completed')]
    const proven = briefWith({ proof: { taskId: '1', artifact: 'x' } }, before)
    expect(lineOf({ tasks: before, brief: proven })).toContain('UNPROVEN 0')
    expect(lineOf({ tasks: [task('1', 'something else', 'completed')], brief: proven })).toContain('UNPROVEN 1')
  })

  test('L6 PRD 5.1: with a task the plan field is ignored; done/total, the bar and UNPROVEN count the tasks only', () => {
    const tasks = [task('1', 'build it', 'completed'), task('2', 'test it', 'pending')]
    const plan = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, text: `step ${i}`, status: 'done' }))
    const brief = briefWith({ plan })
    const got = lineOf({ tasks, brief })
    expect(got).toMatch(/PLAN ▰▱ 1\/2/)
    expect(got).toContain('UNPROVEN 1')
    // The same plan with no task is the source.
    const alone = lineOf({ tasks: [], brief })
    expect(alone).toMatch(/PLAN ▰{5} 5\/5/)
    expect(alone).toContain('UNPROVEN 5')
  })

  test('L6 PRD 5.1: a proven task stays proven and a plan proof does not count while a task exists', () => {
    const tasks = [task('1', 'build it', 'completed')]
    const plan = [{ id: 'a', text: 'one', status: 'done' }]
    const proven = briefWith({ plan, proof: { taskId: '1', artifact: 'x' } }, tasks)
    expect(lineOf({ tasks, brief: proven })).toContain('UNPROVEN 0')
    expect(lineOf({ tasks, brief: proven })).toMatch(/PLAN ▰ 1\/1/)
  })

  test('L6 an unfinished step is never unproven', () => {
    expect(lineOf({ tasks: [task('1', 'a', 'pending'), task('2', 'b', 'in_progress')] })).toContain('UNPROVEN 0')
  })

  test('L11 ASK and UNPROVEN: dim at zero, UNPROVEN warning above, ASK amber only on WAITING ON DAVE, red ASK on a blocked chip, green at zero on DONE', () => {
    const tone = (line: Span[] | undefined, label: string) => line?.find(span => span.text.startsWith(label))?.tone
    const zero = bandLines(state(), 120)[1]
    expect(tone(zero, 'ASK')).toBe('dim')
    expect(tone(zero, 'UNPROVEN')).toBe('dim')
    // Mockup: while WORKING an open ask is dim. Only the waiting-on-dave state draws ASK amber.
    const ask = briefWith({ ask: [{ kind: 'question', text: 'q?' }] })
    const busy = bandLines(state({ brief: ask, tasks: [task('1', 'a', 'completed')] }), 120)[1]
    expect(tone(busy, 'ASK')).toBe('dim')
    expect(tone(busy, 'UNPROVEN')).toBe('warn')
    for (const chip of ['idle', 'done'] as const) expect(tone(bandLines(state({ chip, brief: ask }), 120)[1], 'ASK')).toBe('dim')
    const waiting = bandLines(state({ chip: 'waiting-on-dave', brief: ask }), 120)[1]
    expect(tone(waiting, 'ASK')).toBe('warn')
    const blocked = bandLines(state({ chip: 'blocked', brief: briefWith({ ask: [{ kind: 'block', text: 'q?' }] }) }), 120)[1]
    expect(tone(blocked, 'ASK')).toBe('bad')
    const done = bandLines(state({ chip: 'done' }), 120)[1]
    expect(tone(done, 'ASK')).toBe('done')
    expect(tone(done, 'UNPROVEN')).toBe('done')
  })
})

describe('band line 2: plan bar', () => {
  test('L7 3 of 7 draws block characters and 3/7', () => {
    const plan = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, text: `step ${i}`, status: i < 3 ? 'done' : 'todo' }))
    const got = lineOf({ brief: briefWith({ plan }) })
    expect(got).toMatch(/PLAN ▰{3}▱{4} 3\/7/)
  })

  test('L7 a task list counts the same way', () => {
    const tasks = [task('1', 'a', 'completed'), task('2', 'b', 'in_progress'), task('3', 'c', 'pending')]
    expect(lineOf({ tasks })).toMatch(/PLAN ▰▰▱ 1\/3/)
  })

  test('L7 no plan and no tasks reads 0/0, not a missing bar', () => {
    expect(lineOf({})).toMatch(/PLAN ▱+ 0\/0/)
  })

  test('L7 a long plan keeps the bar to 10 cells and the true count', () => {
    const plan = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, text: `step ${i}`, status: i < 20 ? 'done' : 'todo' }))
    const got = lineOf({ brief: briefWith({ plan }) })
    const bar = /PLAN ([▰▱]+) 20\/25/.exec(got)?.[1]
    expect(bar?.length).toBe(10)
    expect(bar).toBe('▰▰▰▰▰▰▰▰▱▱')
  })

  test('L7 a done step with no proof draws in the warning tone, a proven one in the done tone', () => {
    const tasks = [task('1', 'a', 'completed'), task('2', 'b', 'completed')]
    const proven = briefWith({ proof: { taskId: '1', artifact: 'x' } }, tasks)
    const line = bandLines(state({ tasks, brief: proven }), 120)[1] ?? []
    const cells = line.filter(span => /^[▰▱]+$/.test(span.text))
    expect(cells.map(span => [span.text, span.tone])).toEqual([
      ['▰', 'done'],
      ['▰', 'warn'],
    ])
  })

  test('L7 a blocked step draws in the bad tone and a doing step in the doing (blue) tone', () => {
    const plan = [
      { id: 'a', text: 'one', status: 'blocked' },
      { id: 'b', text: 'two', status: 'doing' },
    ]
    const line = bandLines(state({ brief: briefWith({ plan }) }), 120)[1] ?? []
    const cells = line.filter(span => /^[▰▱]+$/.test(span.text)).map(span => span.tone)
    expect(cells).toEqual(['doing', 'bad'])
  })
})

describe('band width', () => {
  const long = 'g'.repeat(300)
  const full = (): BandState =>
    state({
      brief: briefWith({ goal: long.slice(0, 240), ask: [{ kind: 'question', text: 'q?' }], plan: [{ id: 'a', text: 'x', status: 'done' }] }),
      lane: 'lane-' + 'l'.repeat(40),
    })

  test('L8 no line is wider than the width, for every width from 20 to 200', () => {
    for (const given of [state(), full()]) {
      for (let width = 20; width <= 200; width++) {
        for (const line of bandLines(given, width)) expect(text(line).length).toBeLessThanOrEqual(width)
      }
    }
  })

  test('L8 the chip word is whole at every width', () => {
    for (let width = 20; width <= 120; width += 5) {
      expect(text(bandLines(state({ chip: 'waiting-on-dave', brief: full().brief }), width)[0])).toContain('WAITING FOR YOU')
    }
  })

  test('L8 the goal is cut first, with an ellipsis, and ASK and UNPROVEN stay', () => {
    const line = text(bandLines(full(), 80)[1])
    expect(line).toContain('…')
    expect(line).toContain('ASK 1')
    expect(line).toContain('UNPROVEN 1')
    expect(line).toContain('1/1')
    expect(line.indexOf('…')).toBeLessThan(line.indexOf('PLAN'))
  })

  test('L8 a short goal is not cut and has no ellipsis', () => {
    const line = lineOf({ brief: briefWith({ goal: 'Add session header' }) }, 80)
    expect(line).toContain('GOAL Add session header')
    expect(line).not.toContain('…')
  })

  test('L8 line 1 drops lane, then cost, then ctx before it cuts the chip', () => {
    const wide = text(bandLines(full(), 200)[0])
    expect(wide).toContain('lane ')
    expect(wide).toContain('$1.84')
    const mid = text(bandLines(full(), 70)[0])
    expect(mid).not.toContain('lane ')
    expect(mid).toContain('WORKING')
    expect(mid).toContain('ctx 41%')
    expect(mid).toContain('$1.84')
    const small = text(bandLines(full(), 45)[0])
    expect(small).toContain('WORKING')
    expect(small).toContain('ctx 41%')
  })

  test('L9 below 40 columns only the chip and the goal are drawn, on one line', () => {
    for (const width of [20, 30, 39]) {
      const lines = bandLines(full(), width)
      expect(lines.length).toBe(1)
      const got = text(lines[0])
      expect(got).toContain('WORKING')
      expect(got).toContain('GOAL')
      for (const word of ['ctx', 'PLAN', 'ASK', 'UNPROVEN', 'lane', '$']) expect(got).not.toContain(word)
      expect(got.length).toBeLessThanOrEqual(width)
    }
    expect(bandLines(full(), 40).length).toBe(2)
  })

  test('L9 a narrow band still says GOAL not set when no goal is set', () => {
    expect(all(bandLines(state(), 30))).toContain('GOAL not set')
  })
})

describe('band redaction', () => {
  test('L10 a secret in the goal, repo or lane never reaches the drawn text', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    const unredacted: Brief = { ...emptyBrief(1_000), goal: `ship ${secret}` }
    const lines = bandLines(
      state({ brief: unredacted, repo: `r-${secret}`, lane: `l-${secret}` }),
      200,
    )
    expect(all(lines)).not.toContain(secret)
    expect(all(lines)).not.toContain('a'.repeat(40))
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
    const tones = { working: 'chipDoing', 'waiting-on-dave': 'chipWarn', blocked: 'chipBad', done: 'chipOk', idle: 'chipDim' } as const
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

  test('CL14 the two core lines keep their shape: no 5h or 7d on them, whatever the state holds', () => {
    const given = state({ ...({ limits: BOTH } as object) })
    for (let width = 20; width <= 200; width += 10) {
      const got = all(bandLines(given, width))
      expect(got).not.toContain('5h')
      expect(got).not.toContain('7d')
    }
  })
})

describe('status band fixes (coord-status-band-fixes)', () => {
  const hudOn = (over: Partial<BandState> = {}) => state({ ...({ hud: true } as object), ...over })

  test('SB1 when the HUD row draws, line 1 holds no ctx and no cost: the HUD row holds them (one source, drawn once)', () => {
    const line = text(bandLines(hudOn(), 120)[0])
    expect(line).toContain('WORKING')
    expect(line).not.toContain('ctx')
    expect(line).not.toContain('$')
  })

  test('SB1b the compact line keeps ctx and cost even with the HUD flag, and line 1 keeps both when no HUD row draws', () => {
    expect(text(bandLines(state(), 120)[0])).toContain('ctx 41%')
    expect(text(bandLines(state(), 120)[0])).toContain('$1.84')
    expect(text(compactLine(hudOn() as BandState, 120))).toContain('ctx 41%')
    expect(text(compactLine(hudOn() as BandState, 120))).toContain('$1.84')
  })

  test('SB2 a waiting chip with helpers running shows "N helpers running" beside it on line 1; a working chip and a waiting chip with none do not', () => {
    expect(text(bandLines(hudOn({ chip: 'waiting-on-dave', helpers: 2 } as Partial<BandState>), 120)[0])).toContain('2 helpers running')
    expect(text(bandLines(hudOn({ chip: 'waiting-on-dave', helpers: 1 } as Partial<BandState>), 120)[0])).toContain('1 helper running')
    expect(text(bandLines(hudOn({ chip: 'waiting-on-dave', helpers: 0 } as Partial<BandState>), 120)[0])).not.toContain('helper')
    expect(text(bandLines(hudOn({ chip: 'working', helpers: 2 } as Partial<BandState>), 120)[0])).not.toContain('helper')
  })

  test('SB3 the band and the pane use the same five words, whatever the case', () => {
    const chips = ['working', 'waiting-on-dave', 'blocked', 'done', 'idle'] as const
    const first = (chip: (typeof chips)[number]) => (chipWord(chip).split(':')[0] ?? '').trim().toUpperCase()
    for (const chip of chips) expect(bandModel.CHIP[chip].word, chip).toBe(first(chip))
    expect(chips.map(chip => bandModel.CHIP[chip].word)).toEqual(['WORKING', 'WAITING FOR YOU', 'STUCK', 'DONE', 'RESTING'])
  })
})
