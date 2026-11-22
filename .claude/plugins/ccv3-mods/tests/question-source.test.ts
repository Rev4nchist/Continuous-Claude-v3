import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import * as briefModel from '../hooks/agentic-os/brief'
import * as bandModel from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow, Span } from '../hooks/agentic-os/pane-model'
import type { OsAskItem, OsBrief } from '../types'

// Status band PR D: the question source (card coord-status-band-2, design 2026-11-18, section 6 and failures 17 to 26).
// The band counts ONLY real asks: an open AskUserQuestion step (by its questions) and a fresh brief_set ask. A stored `source: parsed` ask counts nowhere.
// Namespace imports on purpose: a missing export (openAsksOf before the change) fails the one test that calls it, not the whole file at load.
//
// Ways it can fail, one test each:
// Q17 the (Recommended) mark of a mod question is read on the first option only, so a mod dialog with the mark on a later option is stored as a tap
// Q18 a closing line "Nothing needed from you now. When the critic finishes I bring you the verdict" becomes an ask at a turn end
// Q19 a stored parsed ask still counts, at one of: deriveChip, mergeParsed, learnFromAnswer (the turn end), briefSummary, os-tabs, band-model
// Q20 a stale brief_set ask draws a sign, or an open dialog is zeroed by staleness
// Q21 a real question in plain text only (no dialog, no brief_set) shows
// Q24 a mod $.ui.ask dialog does not arrive as one AskUserQuestion step that counts exactly 1
// Q25 OsStep.questions is written for another tool, is not clamped to 1..4, or a step with no field does not read 1
// Q26 some state with openAsks above 0 gives a chip other than waiting-on-dave or blocked

type Step = { id: string; tool: string; questions?: number }
type OpenAsksArgs = { steps: Step[]; brief: OsBrief | null; now: number; activeAt?: number | null; except?: string }
const { openAsksOf, deriveChip, briefSummary, mergeParsed, tapDecisions, emptyBrief } = briefModel as unknown as {
  openAsksOf: (args: OpenAsksArgs) => number
  deriveChip: (state: Record<string, unknown>) => string
  briefSummary: (brief: OsBrief, tasks: never[]) => string
  mergeParsed: (brief: OsBrief | null, parsed: Record<string, unknown>, now: number) => OsBrief
  tapDecisions: (result: unknown) => string[]
  emptyBrief: (now: number) => OsBrief
}
const { bandRows } = bandModel as unknown as {
  bandRows: (s: BandState, maxRows: number, width: number, quiet: boolean) => { rows: Partial<Record<'line' | 'compact' | 'row1' | 'goal', Span[]>> }
}
// The rows that carry the sign: the compact line (HUD on, two rows), row 1 (HUD off) and the one-row line. The sign reads `2 questions`, `? 2` or `?2`.
const compactOf = (s: BandState, width: number): Span[] => bandRows({ ...s, hud: true }, 2, width, false).rows.compact ?? []
const rowOneOf = (s: BandState, width: number): Span[] => bandRows({ ...s, hud: false }, 2, width, false).rows.row1 ?? []
const SIGN = /(\d+ questions?)|(\? ?[\d+])/

const NOW = 1_700_000_000_000
const DAY = 24 * 3600_000
const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')
const ask = (source: OsAskItem['source'], over: Partial<OsAskItem> = {}): OsAskItem => ({ kind: 'question', text: 'Which branch?', source, ...over })
const briefOf = (...items: OsAskItem[]): OsBrief => ({ ...emptyBrief(NOW), ask: items })
const dialog = (id = 'd1', questions?: number): Step => ({ id, tool: 'AskUserQuestion', ...(questions === undefined ? {} : { questions }) })
const open = (over: Partial<OpenAsksArgs>): number => openAsksOf({ steps: [], brief: null, now: NOW, activeAt: NOW, ...over })

// ---------- Q17 ----------

describe('question source: the (Recommended) mark', () => {
  const REC = ' (Recommended)'
  const answered = (header: string, labels: string[], pick: string) => {
    const question = { question: `${header} question?`, header, options: labels.map(label => ({ label, description: 'd' })), multiSelect: false }
    return { questions: [question], answers: { [question.question]: pick } }
  }

  test('Q17 a mod header with (Recommended) on a later option is a mod question and stores nothing (the first option may be a $0 row)', () => {
    // pr_checkpoint puts a $0 row first (Keep as draft ($0)) and marks a later row Recommended.
    expect(tapDecisions(answered('PR #9', ['Keep as draft ($0)', `CodeRabbit now (free slot, $0)${REC}`, 'No review'], 'Keep as draft ($0)'))).toEqual([])
    expect(tapDecisions(answered('Land', ['Keep open', `Land now${REC}`], 'Keep open'))).toEqual([])
    expect(tapDecisions(answered('Paid round', ['Stop', 'Go', `Pay ($1.75)${REC}`], 'my own words'))).toEqual([])
  })

  test('Q17 both markers are still needed: a mod header with no (Recommended) on any option, or a mark under another header, is the model\'s and is stored', () => {
    expect(tapDecisions(answered('Land', ['Keep open', 'Land now'], 'Keep open'))).toEqual(['Land: Keep open'])
    expect(tapDecisions(answered('Auth', ['OAuth', `SAML${REC}`], 'OAuth'))).toEqual(['Auth: OAuth'])
  })
})

// ---------- the real mod, with the engine below it mocked ----------

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'

type Seen = { writes: { path: string; text: string }[]; inRead?: () => Promise<void> }

const world = (on: On): Seen => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  const seen: Seen = { writes: [] }
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'Read' }, async () => {
    await seen.inRead?.()
    return { result: { type: 'text' } } as never
  })
  return seen
}

const startMod = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
const snapshots = (seen: Seen) => seen.writes.filter(write => /[\\/]test-session\.json$/.test(write.path))
const lastSnapshot = (seen: Seen): Record<string, any> => JSON.parse(snapshots(seen).at(-1)?.text ?? '{}')
const turnEnd = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 30, scroll: { offset: 0, bodyRows: 10 }, view: {} }
/** The first band row as a person sees it. At 30 columns it is row 1: chip, then the sign (`1 question`, `? 1` or `?1`). */
const lineOneOf = async ($: Engine, columns = 30): Promise<string> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: columns } })
  const row = (await band.find({ key: 'row-core-1' }))?.text ?? ''
  await band.unmount()
  return row
}
const questions = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ question: `Which ${i}?`, header: `Q${i}`, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }], multiSelect: false }))

// ---------- Q18, Q19 (turn end), Q21 ----------

describe('question source: a turn end asks nothing', () => {
  test('Q18 the closing line "Nothing needed from you now. When the critic finishes I bring you the verdict" makes no ask and no WAITING FOR YOU', async ($, on) => {
    const seen = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    await turnEnd($, 'Review sent.\n\n## Next steps\n1. Nothing needed from you now. When the critic finishes I bring you the verdict')
    const brief = lastSnapshot(seen).brief
    expect(brief.ask.filter((one: OsAskItem) => one.source === 'parsed')).toEqual([])
    expect(lastSnapshot(seen).chip).not.toBe('waiting-on-dave')
    expect(await lineOneOf($)).not.toContain('WAITING FOR YOU')
  })

  test('Q19 learnFromAnswer: a Next steps question at a turn end stores no ask, and the chip and the sign do not move', async ($, on) => {
    const seen = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    await turnEnd($, 'Done.\n\n## Next steps\n1. Approve the merge of PR 12?')
    expect(lastSnapshot(seen).brief.ask).toEqual([])
    expect(lastSnapshot(seen).chip).not.toBe('waiting-on-dave')
    const line = await lineOneOf($)
    expect(line).not.toContain('WAITING FOR YOU')
    expect(line).not.toMatch(SIGN)
  })

  test('Q19 learnFromAnswer: a turn end neither adds an ask nor removes a counted brief_set one', async ($, on) => {
    const seen = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which db?' }] })
    await turnEnd($, '## Next steps\n1. None for now. I am waiting on CI.')
    expect(lastSnapshot(seen).brief.ask.map((one: OsAskItem) => one.text)).toEqual(['Which db?'])
    expect(lastSnapshot(seen).chip).toBe('waiting-on-dave')
    await turnEnd($, '## Next steps\n1. Approve the merge of PR 12?')
    expect(lastSnapshot(seen).brief.ask.map((one: OsAskItem) => one.text)).toEqual(['Which db?'])
    expect(await lineOneOf($)).toMatch(/WAITING FOR YOU\s+(1 question|\? 1)/)
  })

  test('Q21 a real question in plain text only does NOT show: no chip change and no sign (the accepted cost, pinned)', async ($, on) => {
    const seen = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    await turnEnd($, 'I found two ways to do it. Which branch should I use for the fix?')
    expect(lastSnapshot(seen).chip).not.toBe('waiting-on-dave')
    const line = await lineOneOf($)
    expect(line).not.toContain('WAITING FOR YOU')
    expect(line).not.toMatch(SIGN)
  })
})

// ---------- Q19 (the other callers) ----------

describe('question source: a stored parsed ask counts nowhere', () => {
  test('Q19 deriveChip: a fresh parsed ask in the brief does not make the chip waiting; openAsks above 0 does, and no dialog flag is read', () => {
    const base = { brief: briefOf(ask('parsed')), tasks: [], toolRunning: false, turnActive: false, blocked: false, now: NOW, openAsks: 0 }
    expect(deriveChip(base)).toBe('idle')
    expect(deriveChip({ ...base, brief: null, openAsks: 1 })).toBe('waiting-on-dave')
    expect(deriveChip({ ...base, openAsks: 0, dialogOpen: true })).toBe('idle')
  })

  test('Q19 mergeParsed: a turn-end value that carries a parsed ask leaves openAsksOf at 0', () => {
    const merged = mergeParsed(null, { ask: [ask('parsed', { text: 'Approve PR 12?' })] }, NOW)
    expect(open({ brief: merged })).toBe(0)
    const kept = mergeParsed(briefOf(ask('brief_set', { text: 'Which db?' })), { ask: [ask('parsed', { text: 'Approve PR 12?' })] }, NOW)
    expect(open({ brief: kept })).toBe(1)
  })

  test('Q19 briefSummary: the reply text counts brief_set asks and no parsed ask', () => {
    expect(briefSummary(briefOf(ask('parsed'), ask('parsed', { text: 'Second?' })), [])).toContain('0 open asks')
    expect(briefSummary(briefOf(ask('parsed'), ask('brief_set', { text: 'Which db?' })), [])).toContain('1 open ask ')
  })

  const state = (brief: OsBrief): TabState =>
    ({ view: { tasks: [], plan: null, turn: null, step: null, ctx: null, agents: [], lanes: null, prs: [] }, chip: 'idle', brief, repo: null, branch: null, worktree: null, costUsd: null, activeAt: NOW }) as TabState
  const rows = (id: 'overview' | 'decisions', brief: OsBrief): string =>
    tabRows(id, state(brief), NOW, 100, 40)
      .map((row: PaneRow) => [...row.left, ...(row.right ?? [])].map(span => span.text).join(''))
      .join('\n')

  test('Q19 os-tabs: Choices and the Overview digest list no parsed ask; a brief_set ask shows in both', () => {
    const parsed = { ...briefOf(ask('parsed', { text: 'Approve PR 12?' })), updatedAt: NOW - 1000 }
    expect(rows('decisions', parsed)).not.toContain('Approve PR 12?')
    expect(rows('decisions', parsed)).toContain('nothing open')
    expect(rows('overview', parsed)).not.toContain('Approve PR 12?')
    const real = { ...briefOf(ask('brief_set', { text: 'Which db?' })), updatedAt: NOW - 1000 }
    expect(rows('decisions', real)).toContain('Which db?')
    expect(rows('overview', real)).toContain('Which db?')
  })

  const bandState = (over: Partial<BandState> & { openAsks?: number }): BandState =>
    ({ chip: 'idle', brief: null, tasks: [], repo: 'r', who: { name: 'trex', short: '0d40499c' }, lane: null, ctx: 41, costUsd: null, now: NOW, activeAt: NOW, ...over }) as BandState

  test('Q19 band-model: a parsed ask in the brief draws no sign; the sign is BandState.openAsks and nothing else', () => {
    const parsed = bandState({ brief: briefOf(ask('parsed')), openAsks: 0 })
    for (const width of [20, 30, 39, 40, 80, 120]) {
      expect(text(compactOf(parsed, width)), `compact ${width}`).not.toMatch(SIGN)
      expect(text(rowOneOf(parsed, width)), `row 1 ${width}`).not.toMatch(SIGN)
    }
    // A dialog alone (no brief) draws the sign: the number is the one the chip read.
    const dialogOnly = bandState({ chip: 'waiting-on-dave', openAsks: 3 })
    expect(text(compactOf(dialogOnly, 80))).toContain('3 questions')
    expect(text(rowOneOf(dialogOnly, 30))).toMatch(/3 questions|\? 3/)
  })
})

// ---------- Q20 ----------

describe('question source: staleness zeroes only the brief_set part', () => {
  test('Q20 a brief_set ask with 24 hours of quiet counts 0; one minute short of 24 hours counts 1', () => {
    const brief = { ...briefOf(ask('brief_set')), updatedAt: NOW - DAY }
    expect(open({ brief, activeAt: NOW - DAY })).toBe(0)
    expect(open({ brief, activeAt: NOW - DAY + 60_000 })).toBe(1)
  })

  test('Q20 a stale brief_set ask plus an open dialog still counts the dialog; a fresh ask and a 2-question dialog add up', () => {
    const stale = { ...briefOf(ask('brief_set')), updatedAt: NOW - 2 * DAY }
    expect(open({ brief: stale, activeAt: NOW - 2 * DAY, steps: [dialog()] })).toBe(1)
    expect(open({ brief: stale, activeAt: NOW - 2 * DAY, steps: [dialog('d1', 2)] })).toBe(2)
    expect(open({ brief: briefOf(ask('brief_set'), ask('brief_set', { text: 'Second?' })), steps: [dialog('d1', 2)] })).toBe(4)
  })

  test('Q20 a stale brief ask draws no sign through the band; with a dialog open the sign draws', () => {
    const stale = { ...briefOf(ask('brief_set')), updatedAt: NOW - 2 * DAY }
    const view = (openAsks: number) => ({ chip: 'idle', brief: stale, tasks: [], repo: 'r', who: { name: 'trex', short: '0d40499c' }, lane: null, ctx: 41, costUsd: null, now: NOW, activeAt: NOW - 2 * DAY, openAsks }) as unknown as BandState
    expect(open({ brief: stale, activeAt: NOW - 2 * DAY })).toBe(0)
    expect(text(compactOf(view(0), 80))).not.toMatch(SIGN)
    expect(text(compactOf(view(1), 80))).toContain('1 question')
  })

  test('Q20 an answered brief_set ask and an excepted step count 0', () => {
    expect(open({ brief: briefOf(ask('brief_set', { answered: true })) })).toBe(0)
    expect(open({ steps: [dialog('mine')], except: 'mine' })).toBe(0)
    expect(open({ steps: [dialog('mine'), dialog('other')], except: 'mine' })).toBe(1)
  })

  test('Q20 a parsed ask counts in neither part, and an ask with no source (an old state file) is never hidden', () => {
    expect(open({ brief: briefOf(ask('parsed')) })).toBe(0)
    const old = { kind: 'question', text: 'Which branch?' } as unknown as OsAskItem
    expect(open({ brief: briefOf(old) })).toBe(1)
  })
})

// ---------- Q24, Q25 ----------

describe('question source: the dialog step', () => {
  test('Q24 a mod $.ui.ask dialog arrives as an AskUserQuestion step and counts exactly 1 (chip and sign)', async ($, on) => {
    world(on)
    let line = ''
    // The engine draws $.ui.ask as a tool.call of AskUserQuestion with one question and a list of labels (tests/pr-checkpoint.test.ts:383-389,
    // 4068 for the shape). This is its bottom, and Dave has not answered yet. The mod's own paths (pr_checkpoint, Land, the paid round) send this shape.
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
      const input = e as unknown as { questions: { question: string }[] }
      line = await lineOneOf($)
      return { result: { questions: input.questions, answers: { [input.questions[0]!.question]: 'No review, land on CI ($0) (Recommended)' } } } as never
    })
    await startMod($)
    const labels = ['No review, land on CI ($0) (Recommended)', 'CodeRabbit review (may cost up to $1.75)']
    const modDialog = { question: 'PR #9: review?', header: 'PR #9', options: labels.map(label => ({ label, description: label })), multiSelect: false }
    await $.tool.call({ tool: 'AskUserQuestion', questions: [modDialog] } as never)
    expect(line).toMatch(/WAITING FOR YOU\s+(1 question|\? 1)/)
    expect(line).not.toMatch(/[2-9] questions|\? ?[2-9]/)
    // The dialog closed: no step is left, so no sign.
    expect(await lineOneOf($)).not.toMatch(SIGN)
  })

  const ASK_NUMBERS: [string, unknown, number][] = [
    ['no questions array', undefined, 1],
    ['a questions value that is not an array', 'Which one?', 1],
    ['an empty array', [], 1],
    ['3 questions', questions(3), 3],
    ['4 questions (the dialog limit)', questions(4), 4],
    ['9 questions', questions(9), 4],
  ]
  for (const [name, input, count] of ASK_NUMBERS) {
    test(`Q25 an AskUserQuestion call with ${name} is one step that counts ${count}`, async ($, on) => {
      world(on)
      let line = ''
      on('tool.call', { tool: 'AskUserQuestion' }, async () => {
        line = await lineOneOf($)
        return { result: { type: 'text' } } as never
      })
      await startMod($)
      await $.tool.call({ tool: 'AskUserQuestion', ...(input === undefined ? {} : { questions: input }) } as never)
      expect(line).toMatch(new RegExp(`WAITING FOR YOU\\s+(${count} questions?|\\? ${count})\\b`))
    })
  }

  test('Q25 the recorded step holds the clamped number: 9 questions give 4, no array gives 1, 2 give 2', async ($, on) => {
    const seen = world(on)
    const recorded: unknown[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, async () => {
      await $.turn.start({ turnId: `t${recorded.length}` } as never)
      recorded.push(lastSnapshot(seen).step?.questions)
      return { result: { type: 'text' } } as never
    })
    await startMod($)
    await $.tool.call({ tool: 'AskUserQuestion', questions: questions(9) } as never)
    await $.tool.call({ tool: 'AskUserQuestion' } as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: questions(2) } as never)
    expect(recorded).toEqual([4, 1, 2])
  })

  test('Q25 the questions field is written for AskUserQuestion only: a step of another tool holds none, whatever its input says', async ($, on) => {
    const seen = world(on)
    await startMod($)
    seen.inRead = async () => {
      await $.turn.start({ turnId: 't9' } as never)
    }
    await $.tool.call({ tool: 'Read', file_path: 'C:/r/a.md', questions: questions(3) } as never)
    seen.inRead = undefined
    const step = lastSnapshot(seen).step
    expect(step?.tool).toBe('Read')
    expect(step).not.toHaveProperty('questions')
  })

  test('Q25 a step with no questions field reads 1; a field is clamped to 1 to 4 and a non-number reads 1', () => {
    expect(open({ steps: [{ id: 'a', tool: 'AskUserQuestion' }] })).toBe(1)
    expect(open({ steps: [dialog('a', 2), dialog('b', 4)] })).toBe(6)
    expect(open({ steps: [dialog('a', 99)] })).toBe(4)
    expect(open({ steps: [dialog('a', 0)] })).toBe(1)
    expect(open({ steps: [{ id: 'a', tool: 'AskUserQuestion', questions: 'x' as unknown as number }] })).toBe(1)
    expect(open({ steps: [{ id: 'a', tool: 'Read', questions: 3 }] })).toBe(0)
  })
})

// ---------- Q26 ----------

describe('question source: chip and count read one value', () => {
  const TASK = { id: 'b1', type: 'shell' }
  const plans = [
    { name: 'no brief', brief: null, tasks: [] },
    { name: 'a blocked plan step', brief: { ...emptyBrief(NOW), plan: [{ id: 'p1', text: 'x', status: 'blocked' }] }, tasks: [] },
    { name: 'a done and proven task', brief: { ...emptyBrief(NOW), proofs: [{ id: '1', artifact: 'a', at: NOW, subject: 'a', kind: 'task' }] }, tasks: [{ id: '1', subject: 'a', status: 'completed' }] },
  ]
  test('Q26 for every state, openAsks above 0 gives waiting-on-dave or blocked, never another chip', () => {
    const seenChips = new Set<string>()
    for (const plan of plans) {
      for (const toolRunning of [false, true]) {
        for (const turnActive of [false, true]) {
          for (const blocked of [false, true]) {
            for (const agentRuns of [[], [{ status: 'running' }]]) {
              for (const wait of [false, true]) {
                for (const openAsks of [0, 1, 2, 4, 8]) {
                  const chip = deriveChip({
                    ...plan, toolRunning, turnActive, blocked, agentRuns, openAsks, now: NOW,
                    ...(wait ? { bgTasks: [TASK], bgSeen: { b1: NOW } } : {}),
                  })
                  if (openAsks > 0) expect(['waiting-on-dave', 'blocked'], `${plan.name} tool ${toolRunning} turn ${turnActive} blocked ${blocked} runs ${agentRuns.length} wait ${wait} asks ${openAsks}: ${chip}`).toContain(chip)
                  else expect(chip, `${plan.name} asks 0`).not.toBe('waiting-on-dave')
                  seenChips.add(chip)
                }
              }
            }
          }
        }
      }
    }
    // The loop is not vacuous: it reached all three chips it is about, and the wait chip.
    expect([...seenChips].sort()).toEqual(['blocked', 'done', 'idle', 'waiting-on-dave', 'waiting-on-work', 'working'])
  })
})
