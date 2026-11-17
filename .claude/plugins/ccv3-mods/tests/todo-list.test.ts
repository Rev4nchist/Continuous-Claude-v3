import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { answersAsks, applyBrief, briefSummary, deriveChip, emptyBrief, markAsksAnswered, mergeParsed, parseTurnEnd } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { bandLines } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import { todoStale, withoutDeclaredTodos } from '../hooks/agentic-os/todo'
import type { Span } from '../hooks/agentic-os/pane-model'
import type { OsTodo } from '../types'

// Card coord-status-band-2, PR C: "To do for you" as a SEPARATE list (design v2, .claudedocs/coordination/2026-11-16-coord-status-band-2-todo-design-v2.md,
// seat GO with the fences). brief_set takes `todo: [{ text }]`; the list is stored in `brief.todos`; no ask path reads it.
// The first try (a `todo` kind inside the ask list) went back to design after three hidden-question findings: .claudedocs/coordination/2026-11-16-coord-status-band-2-todo-findings.md.
//
// Ways it can fail, one test each (numbers are the failure list of the design note):
// 1  a to-do with ? or the full-width or inverted mark stays a to-do (a hidden question)
// 2  the question test runs after redaction, so a redacted trailing ? hides it
// 3  a to-do item takes kind, recommend or any extra key; or a limit is not held
// 4  a to-do alone makes the chip wait, counts as a question, or is answered by a prompt of any origin
// 5  todo [] clears the questions, ask [] clears the to-dos, or a call with neither touches a list
// 6  a to-do-only brief_set locks the closing-line parser out
// 7  the repeated Next steps line stays a question; or the drop is by prefix, by part, with a recommend, or with a question mark
// 8  the 24 hour clock is missing, or it changes the chip
// 9  a secret in a to-do is stored
// 10 an old brief with no todos does not load, or a call without todo changes the list
// 11 the band draws TO DO at 0, in amber, or in red
// 12 the pane group is missing, or it changes the open count or the ask rows
// 14 the summary line does not name the to-dos
// 15 the brief_set text lacks the todo field, the plain-goal rule or the send-every-question hint
// 16 a cleared or replaced to-do still drops the same closing line
// 17 two equal to-dos drop more than the one parsed line, or a different second line is dropped

const FAKE_TOKEN = ['sk', 'live', 'ABCDEF123456'].join('-') // built at run time: the staged text holds no secret-shaped string
const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const apply = (prev: Brief | null, raw: Record<string, unknown>, now = 1_000) => applyBrief(prev, raw, [], now)
const briefWith = (raw: Record<string, unknown>, prev: Brief | null = null, now = 1_000): Brief => {
  const made = apply(prev, raw, now)
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

const T1 = { text: 'Run /compact here' }
const Q1 = { kind: 'question', text: 'Open the PR?' }
const todosOf = (brief: Brief): string[] => (brief.todos ?? []).map(one => one.text)

describe('todo list: a question never hides in it', () => {
  test('1 a to-do with ?, the full-width mark or the inverted mark is moved into the ask list as a question; the chip waits and the answer names it', () => {
    for (const mark of ['?', '？', '¿']) {
      const made = apply(null, { todo: [{ text: `Land PR 12${mark} Reply yes or no` }, T1] })
      if ('error' in made) throw new Error(made.error)
      expect(todosOf(made.brief)).toEqual([T1.text])
      expect(made.brief.ask.map(one => one.kind)).toEqual(['question'])
      expect(made.brief.ask[0]?.text).toContain('Land PR 12')
      expect(made.note ?? '').toMatch(/todo 1 moved to ask/)
      expect(chipOf(made.brief)).toBe('waiting-on-dave')
    }
  })

  test('1 a moved question joins the questions of the same call, and the whole call fails when the ask list would pass 8', () => {
    const asks = Array.from({ length: 7 }, (_, i) => ({ kind: 'question', text: `q${i}` }))
    const ok = briefWith({ ask: asks, todo: [{ text: 'Is it done?' }] })
    expect(ok.ask.length).toBe(8)
    expect(ok.ask.at(-1)?.text).toBe('Is it done?')
    const over = apply(null, { ask: [...asks, { kind: 'question', text: 'q7' }], todo: [{ text: 'Is it done?' }] })
    expect('error' in over).toBe(true)
  })

  test('1 a question moved into an empty ask list is kept by a later parse (the source is brief_set)', () => {
    const fresh = briefWith({ todo: [{ text: 'Did CI pass?' }] })
    expect(fresh.sources.ask).toBe('brief_set')
    expect(mergeParsed(fresh, parseTurnEnd('## Next steps\n1. Something else?'), 2_000)).toBe(fresh)
  })

  test('1 a question moved with no ask in the call is added to the open asks and survives a later parse (the source is brief_set)', () => {
    const base = briefWith({ ask: [Q1] })
    const next = briefWith({ todo: [{ text: 'Did CI pass?' }] }, base, 2_000)
    expect(next.ask.map(one => one.text)).toEqual(['Open the PR?', 'Did CI pass?'])
    expect(next.sources.ask).toBe('brief_set')
    expect(mergeParsed(next, parseTurnEnd('## Next steps\n1. Something else?'), 3_000)).toBe(next)
  })

  test('2 the question mark is tested on the raw text, before redaction (a redacted trailing ? cannot hide it)', () => {
    const made = briefWith({ todo: [{ text: `Did API_KEY=${FAKE_TOKEN}? work` }] })
    expect(made.todos ?? []).toEqual([])
    expect(made.ask.length).toBe(1)
    expect(JSON.stringify(made)).not.toContain(FAKE_TOKEN)
    expect(chipOf(made)).toBe('waiting-on-dave')
  })

  test('3 a to-do item has only text: kind, recommend and any extra key are refused; the limits hold', () => {
    for (const bad of [{ text: 'x', kind: 'todo' }, { text: 'x', recommend: 'y' }, { text: 'x', extra: 1 }, { text: '' }, { text: 'a'.repeat(301) }, {}]) {
      expect('error' in apply(null, { todo: [bad] })).toBe(true)
    }
    expect('error' in apply(null, { todo: Array.from({ length: 9 }, (_, i) => ({ text: `t${i}` })) })).toBe(true)
    expect(briefWith({ todo: Array.from({ length: 8 }, (_, i) => ({ text: `t${i}` })) }).todos?.length).toBe(8)
    expect(briefWith({ todo: [{ text: 'a'.repeat(300) }] }).todos?.length).toBe(1)
  })

  test('9 a secret in a to-do (no question mark) is redacted before it is stored', () => {
    const made = briefWith({ todo: [{ text: `Rotate API_KEY=${FAKE_TOKEN} today` }] })
    expect(JSON.stringify(made.todos)).not.toContain(FAKE_TOKEN)
    expect(made.todos?.length).toBe(1)
  })
})

describe('todo list: no ask path reads it', () => {
  test('4 a to-do alone: the chip idles, QUESTIONS 0, TO DO 1; no prompt of any origin touches it', () => {
    const brief = briefWith({ todo: [T1] })
    expect(chipOf(brief)).toBe('idle')
    expect(chipOf(brief, { turnActive: true })).toBe('working')
    expect(markAsksAnswered(brief, 2_000)).toBe(brief)
    for (const kind of ['composer', 'bridge', 'auto-continuation', 'peer', 'scheduled-trigger', 'task-notification']) {
      const after = answersAsks({ kind }) ? markAsksAnswered(brief, 2_000) : brief
      expect(todosOf(after)).toEqual([T1.text])
    }
    const line = text(bandLines(state({ brief }), 200)[1])
    expect(line).toContain('QUESTIONS 0')
    expect(line).toContain('TO DO 1')
  })

  test('5 todo [] clears only the to-dos, ask [] clears only the questions, a call with neither touches nothing', () => {
    const both = briefWith({ ask: [Q1], todo: [T1] })
    const noTodo = briefWith({ todo: [] }, both, 2_000)
    expect(noTodo.todos ?? []).toEqual([])
    expect(noTodo.ask).toEqual(both.ask)
    const noAsk = briefWith({ ask: [] }, both, 2_000)
    expect(noAsk.ask).toEqual([])
    expect(todosOf(noAsk)).toEqual([T1.text])
    const neither = briefWith({ goal: 'g' }, both, 2_000)
    expect(neither.ask).toEqual(both.ask)
    expect(todosOf(neither)).toEqual([T1.text])
  })

  test('6 a to-do-only brief_set does not lock the closing-line parser: a later question is read', () => {
    const brief = briefWith({ todo: [T1] })
    expect(brief.sources.ask).toBeUndefined()
    const merged = mergeParsed(brief, parseTurnEnd('## Next steps\n1. Approve the merge of PR 12?'), 2_000)
    expect(merged.ask.length).toBe(1)
    expect(chipOf(merged, { now: 2_000, activeAt: 2_000 })).toBe('waiting-on-dave')
    expect(todosOf(merged)).toEqual([T1.text])
  })

  test('8 the 24 hour clock marks the to-dos stale and never changes the chip', () => {
    const day = 24 * 3600_000
    const brief = briefWith({ todo: [T1] })
    expect(todoStale(brief, 1_000 + day - 1, 1_000)).toBe(false)
    expect(todoStale(brief, 1_000 + day + 1, 1_000)).toBe(true)
    expect(todoStale(emptyBrief(1_000), 1_000 + day + 1, 1_000)).toBe(false)
    expect(chipOf(brief, { now: 1_000 + day + 1 })).toBe('idle')
    expect(text(bandLines(state({ brief, now: 1_000 + day + 1 }), 200)[1])).toContain('TO DO 1 stale')
  })

  test('10 an old brief with no todos loads; a call without todo keeps the list', () => {
    const old = JSON.parse(JSON.stringify(emptyBrief(1_000))) as Brief
    expect(old.todos).toBeUndefined()
    expect(text(bandLines(state({ brief: old }), 200)[1])).not.toContain('TO DO')
    const withList = briefWith({ todo: [T1] }, old, 2_000)
    expect(briefWith({ goal: 'g' }, withList, 3_000).todos).toEqual(withList.todos)
  })

  test('14 the summary names the open to-dos apart from the open asks', () => {
    const said = briefSummary(briefWith({ ask: [Q1], todo: [T1, { text: 'Paste the log' }] }), [])
    expect(said).toContain('1 open ask')
    expect(said).toContain('2 to-dos')
  })
})

describe('todo list: the repeated Next steps line', () => {
  const todos = (...texts: string[]): OsTodo[] => texts.map(one => ({ text: one, at: 1_000 }))
  const parsedOf = (block: string) => parseTurnEnd(`## Next steps\n${block}`)

  test('7 a parsed line equal to an open to-do (final period cut) is dropped; the chip stays idle', () => {
    const brief = briefWith({ todo: [T1] })
    const kept = withoutDeclaredTodos(parsedOf('1. Run /compact here.'), brief.todos)
    expect(kept.ask ?? []).toEqual([])
    const merged = mergeParsed(brief, kept, 2_000)
    expect(chipOf(merged, { now: 2_000, activeAt: 2_000 })).toBe('idle')
  })

  test('7 a line that differs (one word, a prefix, a part), carries a recommend or a question mark is never dropped', () => {
    const list = todos('Run /compact here')
    for (const line of ['Run /compact now', 'Run /compact', 'Run /compact here now', 'Please run /compact here']) {
      expect(withoutDeclaredTodos(parsedOf(`1. ${line}.`), list).ask?.length).toBe(1)
    }
    const withRecommend = { ask: [{ kind: 'question' as const, text: 'Run /compact here', recommend: 'now', source: 'parsed' as const }] }
    expect(withoutDeclaredTodos(withRecommend, list).ask?.length).toBe(1)
    expect(withoutDeclaredTodos(parsedOf('1. Run /compact here?'), list).ask?.length).toBe(1)
  })

  test('7 a to-do written with a final period matches the parsed line without it, and a stored to-do with a question mark never drops that line', () => {
    expect(withoutDeclaredTodos(parsedOf('1. Run /compact here.'), todos('Run /compact here.')).ask ?? []).toEqual([])
    expect(withoutDeclaredTodos(parsedOf('1. Run it?'), todos('Run it?')).ask?.length).toBe(1)
  })

  test('16 a to-do list cleared or replaced by a later brief_set: the same closing line is a question again', () => {
    const first = briefWith({ todo: [T1] })
    const cleared = briefWith({ todo: [] }, first, 2_000)
    expect(withoutDeclaredTodos(parsedOf('1. Run /compact here.'), cleared.todos).ask?.length).toBe(1)
    const replaced = briefWith({ todo: [{ text: 'Paste the log' }] }, first, 2_000)
    expect(withoutDeclaredTodos(parsedOf('1. Run /compact here.'), replaced.todos).ask?.length).toBe(1)
    expect(withoutDeclaredTodos(parsedOf('1. Run /compact here.'), undefined).ask?.length).toBe(1)
  })

  test('17 two equal to-dos and one parsed line: one drop; a different second parsed line is still a question', () => {
    const list = todos('Run /compact here', 'Run /compact here')
    const got = withoutDeclaredTodos(parsedOf('1. Run /compact here.\n2. Approve the merge.'), list)
    expect(got.ask?.map(one => one.text)).toEqual(['Approve the merge'])
  })

  test('7 the parser itself is unchanged: it never yields a to-do and mergeParsed is not asked to know the list', () => {
    const parsed = parsedOf('1. Run /compact here.')
    expect(Object.keys(parsed).sort()).toEqual(['ask'])
  })
})

describe('todo list: pane group and tool text', () => {
  const rows = (brief: Brief, now = 1_000) =>
    tabRows('decisions', { brief, activeAt: 1_000, tasks: [], agents: [], now } as never, now, 100, 40)
      .map(row => [...row.left, ...(row.right ?? [])].map(span => span.text).join(''))

  test('12 the pane draws a TO DO FOR YOU group below the asks; the ask rows and the open count equal those of a brief with no to-dos', () => {
    const plain = rows(briefWith({ ask: [Q1] }))
    const withTodos = rows(briefWith({ ask: [Q1], todo: [T1, { text: 'Paste the log' }] }))
    const at = withTodos.findIndex(row => row.includes('TO DO FOR YOU'))
    expect(at).toBeGreaterThan(-1)
    expect(withTodos.slice(0, at).filter(row => row.trim() !== '')).toEqual(plain.filter(row => row.trim() !== ''))
    expect(withTodos.slice(at).join('\n')).toContain('Run /compact here')
    expect(withTodos.join('\n')).toContain('1 open')
    expect(plain.join('\n')).not.toContain('TO DO FOR YOU')
  })

  test('12 in a tight pane the to-do group is not cut off: the asks give way, the group stays', () => {
    const asks = Array.from({ length: 6 }, (_, i) => ({ kind: 'question', text: `question number ${i}?` }))
    const tight = tabRows('decisions', { brief: briefWith({ ask: asks, todo: [T1] }), activeAt: 1_000, tasks: [], agents: [], now: 1_000 } as never, 1_000, 100, 9)
      .map(row => [...row.left, ...(row.right ?? [])].map(span => span.text).join(''))
    expect(tight.length).toBeLessThanOrEqual(9)
    expect(tight.join('\n')).toContain('TO DO FOR YOU')
    expect(tight.join('\n')).toContain('Run /compact here')
  })

  test('11 the band draws TO DO only above 0, and never in amber or red, whatever the chip', () => {
    const brief = briefWith({ ask: [Q1], todo: [T1] })
    for (const chip of ['working', 'waiting-on-dave', 'blocked', 'idle', 'done'] as const) {
      const spans = bandLines(state({ chip, brief }), 200)[1] ?? []
      const todo = spans.find(span => span.text.startsWith('TO DO'))
      expect(todo).toBeDefined()
      expect(['warn', 'bad']).not.toContain(todo?.tone)
    }
    expect(text(bandLines(state({ brief: briefWith({ ask: [Q1] }) }), 200)[1])).not.toContain('TO DO')
  })

  test('15 the brief_set text carries the todo field, the plain-goal rule and the send-every-question hint', async ($, on: On) => {
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
    expect(schema?.properties.todo.type).toBe('array')
    expect(schema?.properties.todo.maxItems).toBe(8)
    expect(schema?.properties.todo.items.additionalProperties).toBe(false)
    expect(Object.keys(schema?.properties.todo.items.properties)).toEqual(['text'])
    expect(String(schema?.properties.todo.description)).toContain('needs no answer')
    expect(String(schema?.properties.todo.description)).toContain('question mark')
    expect(String(schema?.properties.ask.description)).toContain('send every open question')
    expect(String(schema?.properties.goal.description)).toContain('plain')
    expect(String(schema?.properties.goal.description)).toContain('80')
    expect(String(seen?.description)).toContain('todo')
    expect(schema?.properties.ask.items.properties.kind.enum).toEqual(['question', 'approval', 'decision', 'block'])
  })
})
