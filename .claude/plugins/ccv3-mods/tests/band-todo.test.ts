import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { applyBrief, deriveChip, emptyBrief, isAskStale, isTodoStale, markAsksAnswered, parseTurnEnd, briefSummary } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { askSentence } from '../hooks/agentic-os/plain'
import { hudParts } from '../hooks/hud/model'
import type { HudState } from '../types'
import type { Span } from '../hooks/agentic-os/pane-model'
import { CORPUS } from './fixtures/next-steps-corpus'

// Card coord-status-band-2, PR A (design note .claudedocs/coordination/2026-11-16-coord-status-band-2-design.md, seat GO).
// A "To do for you" item is an action for Dave that needs no answer. It is declared through brief_set (kind `todo`);
// the turn-end parser never makes one (free text carries no intent, V7.6).
//
// Ways it can fail, one test each:
// T1 brief_set refuses kind todo, or accepts an unknown kind
// T2 a todo alone makes the chip waiting, or a todo hides a real question
// T3 Dave's prompt answers a todo, or leaves a question open
// T4 a todo counts as a stale question, or never goes stale itself
// T5 the turn-end parser yields a todo for any known closing line
// T6 the brief summary hides the to-do count
// B1 the band keeps ASK, or draws TO DO at 0, or counts a todo as a question
// B2 PLAN and UNPROVEN draw with no steps, or disappear with steps
// B3 the TO DO count draws amber or red
// B4 line 1 draws ctx or cost again when the HUD row draws (fix 6 stays green)
// P1 a todo reads as a question in plain words
// H1 the HUD row keeps the old labels (cost, cache, advisor) or draws a red effort chip with no reason
// D1 the brief_set tool misses the todo kind, the todo text, or the plain-goal rule

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const briefWith = (raw: Record<string, unknown>, prev: Brief | null = null, now = 1_000): Brief => {
  const made = applyBrief(prev, raw, [], now)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const chipOf = (brief: Brief, over: Record<string, unknown> = {}) =>
  deriveChip({ brief, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: 1_000, activeAt: 1_000, ...over })

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

const TODO = { kind: 'todo', text: 'Run /compact here' }
const QUESTION = { kind: 'question', text: 'Open the PR?' }

describe('brief: the todo kind', () => {
  test('T1 brief_set takes kind todo and still refuses an unknown kind', () => {
    const brief = briefWith({ ask: [TODO] })
    expect(brief.ask[0]?.kind).toBe('todo')
    const refused = applyBrief(null, { ask: [{ kind: 'chore', text: 'x' }] }, [], 1_000)
    expect('error' in refused).toBe(true)
  })

  test('T2 a todo alone never makes the chip waiting; a todo beside a question does', () => {
    expect(chipOf(briefWith({ ask: [TODO] }))).toBe('idle')
    expect(chipOf(briefWith({ ask: [TODO] }), { turnActive: true })).toBe('working')
    expect(chipOf(briefWith({ ask: [TODO, QUESTION] }))).toBe('waiting-on-dave')
  })

  test("T3 Dave's prompt answers the question and leaves the todo open", () => {
    const after = markAsksAnswered(briefWith({ ask: [TODO, QUESTION] }), 2_000)
    expect(after.ask.find(one => one.kind === 'question')?.answered).toBe(true)
    expect(after.ask.find(one => one.kind === 'todo')?.answered).toBeUndefined()
    const only = briefWith({ ask: [TODO] })
    expect(markAsksAnswered(only, 2_000)).toBe(only)
  })

  test('T4 staleness counts questions only; a todo has its own 24 hour clock', () => {
    const day = 24 * 3600_000
    const onlyTodo = briefWith({ ask: [TODO] })
    expect(isAskStale(onlyTodo, 1_000 + day + 1, 1_000)).toBe(false)
    expect(isTodoStale(onlyTodo, 1_000 + day + 1, 1_000)).toBe(true)
    expect(isTodoStale(onlyTodo, 1_000 + day - 1, 1_000)).toBe(false)
    expect(isTodoStale(briefWith({ ask: [QUESTION] }), 1_000 + day + 1, 1_000)).toBe(false)
    const withQuestion = briefWith({ ask: [TODO, QUESTION] })
    expect(isAskStale(withQuestion, 1_000 + day + 1, 1_000)).toBe(true)
    expect(isAskStale(withQuestion, 1_000 + day - 1, 1_000)).toBe(false)
  })

  test('T5 the turn-end parser never yields a todo for any row of the closing-line corpus', () => {
    for (const row of CORPUS) {
      const parsed = parseTurnEnd(row.text)
      for (const ask of parsed.ask ?? []) expect(ask.kind).not.toBe('todo')
    }
    expect(parseTurnEnd('## Next steps\n1. Run /compact in this session.').ask?.every(one => one.kind !== 'todo')).toBe(true)
  })

  test('T6 the brief summary names the open to-dos apart from the open asks', () => {
    const said = briefSummary(briefWith({ ask: [TODO, TODO, QUESTION] }), [])
    expect(said).toContain('1 open ask')
    expect(said).toContain('2 to-dos')
  })
})

describe('band: questions, to do, labels', () => {
  const lineTwo = (over: Partial<BandState>, width = 160): string => text(bandLines(state(over), width)[1])

  test('B1 line 2 says QUESTIONS and TO DO, never ASK, and draws TO DO only above 0', () => {
    const both = lineTwo({ brief: briefWith({ ask: [QUESTION, TODO, { kind: 'todo', text: 'Paste the log' }] }) })
    expect(both).toContain('QUESTIONS 1')
    expect(both).toContain('TO DO 2')
    expect(both).not.toContain('ASK')
    const none = lineTwo({ brief: briefWith({ ask: [QUESTION] }) })
    expect(none).toContain('QUESTIONS 1')
    expect(none).not.toContain('TO DO')
    expect(lineTwo({ brief: briefWith({ ask: [TODO] }) })).toContain('QUESTIONS 0')
  })

  test('B2 PLAN and UNPROVEN hide with no steps and draw with steps', () => {
    const empty = lineTwo({ brief: briefWith({ goal: 'g' }) })
    expect(empty).not.toContain('PLAN')
    expect(empty).not.toContain('UNPROVEN')
    const steps = lineTwo({ brief: briefWith({ goal: 'g', plan: [{ id: 'a', text: 'one', status: 'done' }] }) })
    expect(steps).toContain('PLAN')
    expect(steps).toContain('UNPROVEN 1')
  })

  test('B3 the TO DO count is never amber or red', () => {
    const spans = bandLines(state({ chip: 'waiting-on-dave', brief: briefWith({ ask: [QUESTION, TODO] }) }), 160)[1] ?? []
    const todo = spans.find(span => span.text.startsWith('TO DO'))
    expect(todo).toBeDefined()
    expect(['warn', 'bad']).not.toContain(todo?.tone)
  })

  test('B4 line 1 leaves out ctx and cost when the HUD row draws, and keeps them when it does not', () => {
    const withHud = text(bandLines(state({ hud: true }), 160)[0])
    expect(withHud).not.toContain('ctx 41%')
    expect(withHud).not.toContain('$1.84')
    const noHud = text(bandLines(state({ hud: false }), 160)[0])
    expect(noHud).toContain('ctx 41%')
    expect(noHud).toContain('$1.84')
  })

  test('P1 a todo reads as a to-do in plain words, not as a question', () => {
    const said = askSentence({ kind: 'todo', text: 'Run /compact here' }, false)
    expect(said.text).toBe('To do: Run /compact here')
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

describe('brief_set tool texts', () => {
  test('D1 the schema takes kind todo and the two texts carry the todo kind and the plain-goal rule', async ($, on: On) => {
    mock.clock(on, { now: 1_000 })
    mock.env(on, { USERPROFILE: 'C:/home' })
    on('ui.render', ($$, e) => ($$.ui.resolve(e).Box as unknown as (p: object) => RenderElement)({}) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('fs.write', () => ({ value: undefined }))
    on('fs.read', (_$, e) => {
      throw new Error(`ENOENT ${e.path}`)
    })
    on('session.cwd', () => ({ value: 'C:/wt/w1' }))
    on('session.root', () => ({ value: 'C:/wt/w1' }))
    on('session.id', () => ({ value: 'test-session' }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    let seen: { description?: string; inputSchema?: any } | undefined
    on('tool.register', (_$, e) => {
      if (e.name === 'brief_set') seen = e as never
      return { value: { tool: `mcp__ccv3-mods__${e.name}` } }
    })
    await $.session.start({ cwd: 'C:/wt/w1', surface: 'terminal', isInteractive: false })
    const schema = seen?.inputSchema
    expect(schema?.properties.ask.items.properties.kind.enum).toContain('todo')
    expect(String(schema?.properties.ask.description)).toContain('todo')
    expect(String(schema?.properties.goal.description)).toContain('plain')
    expect(String(schema?.properties.goal.description)).toContain('80')
    expect(String(seen?.description)).toContain('todo')
  })
})

void emptyBrief
