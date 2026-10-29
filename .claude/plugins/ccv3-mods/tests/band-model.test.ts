import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, emptyBrief, markAsksAnswered, mergeParsed } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import type { Span } from '../hooks/agentic-os/pane-model'
import { TONE } from '../hooks/shared/tones'
import type { OsTask } from '../types'

// Ways the two core band lines (PRD 5.3) can fail, one test each. Every check reads the drawn text and tones.
// L1 a chip word is wrong, shortened, or two states share a tone
// L2 line 1 loses a field, or shows a field the state does not have as if it were set
// L3 GOAL not set is hidden, or the dim fallback shows when the state has none (or replaces the warning)
// L4 a parsed goal looks like a brief_set goal, or a blank goal reads as set
// L5 an answered ask is counted, or a stale ask looks fresh
// L6 UNPROVEN misses a done step with no proof, counts a proven one, or lets a proof for another subject count
// L7 the plan bar is not block characters, shows the wrong N/M, or grows past its room
// L8 a line overruns the width, the chip is cut, or the goal is not the first thing cut
// L9 below 40 columns more than the chip and the goal is drawn
// L10 a secret in the state reaches the drawn text
// L11 ASK and UNPROVEN keep the wrong tone

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')
const all = (lines: Span[][]): string => lines.map(text).join('\n')

const task = (id: string, subject: string, status: OsTask['status']): OsTask => ({ id, subject, status })

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'working',
  brief: null,
  tasks: [],
  repo: 'continuous-claude',
  branch: 'feat/dash-header',
  lane: 'dash-header',
  ctx: 41,
  costUsd: 1.84,
  fallback: null,
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
      'waiting-on-dave': ['WAITING ON DAVE', 'chipWarn'],
      blocked: ['BLOCKED', 'chipBad'],
      done: ['DONE', 'chipOk'],
      idle: ['IDLE', 'chipDim'],
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

  test('L2 line 1 holds chip, project dot, repo, branch, lane, ctx and cost, in that order', () => {
    const line = text(bandLines(state(), 120)[0])
    const at = ['WORKING', '● continuous-claude', 'feat/dash-header', 'lane dash-header', 'ctx 41%', '$1.84'].map(part => line.indexOf(part))
    expect(at.every(n => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('L2 a field the state does not have reads as a dash, not as a value and not as a gap', () => {
    const line = text(bandLines(state({ repo: null, branch: null, lane: null, ctx: null, costUsd: null }), 120)[0])
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

  test('L3 a fallback (working_on) shows dim after GOAL not set, only when the state has one', () => {
    const line = bandLines(state({ fallback: 'fix the login redirect' }), 120)[1] ?? []
    expect(text(line)).toMatch(/GOAL not set\s+fix the login redirect/)
    expect(line.find(span => span.text.includes('fix the login'))?.tone).toBe('dim')
    expect(text(bandLines(state({ fallback: '   ' }), 120)[1])).toMatch(/GOAL not set\s+PLAN/)
  })

  test('L3 a fallback never hides a set goal', () => {
    const brief = briefWith({ goal: 'Add session header' })
    const got = lineOf({ brief, fallback: 'old working_on' })
    expect(got).toContain('GOAL Add session header')
    expect(got).not.toContain('old working_on')
    expect(got).not.toContain('not set')
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
    const answered = markAsksAnswered(briefWith({ ask: asks }))
    const line = bandLines(state({ brief: answered }), 120)[1] ?? []
    expect(text(line)).toContain('ASK 0')
    expect(text(line)).not.toContain('ASK 2')
    expect(line.find(span => span.text.includes('answered?'))?.tone).toBe('dim')
    expect(text(line)).toContain('2 answered?')
  })

  test('L5 one answered and one fresh ask: counts the fresh one only', () => {
    const first = markAsksAnswered(briefWith({ ask: [asks[0]] }))
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
      branch: 'feature/' + 'b'.repeat(60),
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
      expect(text(bandLines(state({ chip: 'waiting-on-dave', brief: full().brief }), width)[0])).toContain('WAITING ON DAVE')
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
    const small = text(bandLines(full(), 45)[0])
    expect(small).toContain('WORKING')
    expect(small).toContain('continuous-claude')
  })

  test('L8 the drop order: the branch is cut first, then lane, cost, ctx, branch, repo', () => {
    // full(): width 58 holds chip + repo + a cut branch + ctx, but not the lane or the cost.
    const at58 = text(bandLines(full(), 58)[0])
    expect(at58).toContain('ctx 41%')
    expect(at58).not.toContain('$1.84')
    expect(at58).not.toContain('lane ')
    expect(at58).toMatch(/feature\/b+…/)
    expect(at58.length).toBeLessThanOrEqual(58)
    // At 120 the branch is cut (to make room) and nothing else drops: the cut comes before any drop.
    const cut = text(bandLines(full(), 120)[0])
    expect(cut).toMatch(/feature\/b+…/)
    expect(cut).toContain('lane ')
    expect(cut).toContain('$1.84')
    // Narrower: ctx goes only after cost, and the branch only after ctx.
    const at46 = text(bandLines(full(), 46)[0])
    expect(at46).not.toContain('ctx')
    expect(at46).toMatch(/feature\/b+/)
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
  test('L10 a secret in the goal, fallback, repo, branch or lane never reaches the drawn text', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    const unredacted: Brief = { ...emptyBrief(1_000), goal: `ship ${secret}` }
    const lines = bandLines(
      state({ brief: unredacted, fallback: `fix ${secret}`, repo: `r-${secret}`, branch: `b-${secret}`, lane: `l-${secret}` }),
      200,
    )
    expect(all(lines)).not.toContain(secret)
    expect(all(lines)).not.toContain('a'.repeat(40))
    const noGoal = bandLines(state({ fallback: `fix ${secret}` }), 200)
    expect(all(noGoal)).not.toContain(secret)
  })
})
