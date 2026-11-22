import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import * as briefModel from '../hooks/agentic-os/brief'
import { deriveChip, emptyBrief, openAsksOf } from '../hooks/agentic-os/brief'
import type { ChipState } from '../hooks/agentic-os/brief'
import * as bandModel from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import type { Span } from '../hooks/agentic-os/pane-model'
import type { OsAskItem, OsBrief } from '../types'

// Fix 5 of the status band: the band knows a system wait (card coord-status-band-2). The session ends its turn while a background
// shell or workflow still runs. The closing line can then read as an ask ("Waiting on CI ... then you get the Land question").
// The chip says WAITING ON n TASKS (grey) instead of WAITING FOR YOU, and a fresh open ask still leaves a sign at every width.
// Design: .claudedocs/coordination/2026-11-17-coord-status-band-2-fix5-design.md, section 10 wins. Critic: ...-fix5-critic.md.
//
// Ways it can fail, one test each (S = through the whole mod, P = pure function):
// P1  a shell task and a parsed ask leave the chip at waiting-on-dave
// P2  a brief_set ask, a dialog, or an ask with no source is hidden by the wait chip
// P3  a stale or answered ask counts as a fresh one in rule 2 (a parsed ask must not turn into a hider of the wait)
// P4  monitor, subagent and unknown task types count (a standing monitor hides asks all day)
// P5  the age limit is wrong: a task older than BG_WAIT_MAX_MS still counts, or one at the limit does not
// P6  a running turn or a running tool call still reads as waiting on tasks
// P7  blocked does not outrank the wait
// P8  an old engine (no tasks) changes the chip
// B1  the chip word, its count, its singular or its grey tone is wrong
// B2  QUESTIONS under the wait chip is not amber, or a stale ask is amber
// B3  the compact line draws no amber Q n for a fresh ask at some width and chip, or draws one for none / a stale / an answered ask
// B4  the narrow line (under 40 columns) does the same
// S1  Stop with a shell and a parsed ask: the band does not read WAITING ON 1 TASK, or QUESTIONS 1 / Q 1 is gone at full, compact and narrow width
// S2  Stop with a shell and a brief_set ask, or an open dialog: the chip leaves WAITING FOR YOU
// S3  Stop with no task, a cron only, or a missing or non-array list: the band changes
// S4  turn.start (main), UserPromptSubmit and both SessionStart handlers do not clear the wait; a subagent turn.start clears it
// S5  a clear that lands while the Stop hook waits for next(e) is overwritten by the late write
// S6  a blocking Stop (block, preventContinuation) or a Stop from a subagent (agent_id) sets the wait
// S7  a secret-shaped description, command, prompt or server reaches an atom, the band or the state file
// S8  the state file holds waiting-on-work or a wait field, or the chip in it is not one of the five old values
// S9  the Stop result is not the one next(e) gave, or the off switch does not stop the write
// S10 a standing shell with a Stop every 20 minutes (a turn start between) never ages out
// S11 a task passes the age limit while the session is idle and the band does not redraw
// S12 a running turn or tool call at the Stop shows waiting on tasks

const T0 = 1_700_000_000_000
const MIN = 60_000
// A namespace read keeps a missing export from failing the whole file at load.
const BG_WAIT_MAX_MS = (briefModel as unknown as { BG_WAIT_MAX_MS: number }).BG_WAIT_MAX_MS
const { waitLapsed } = briefModel as unknown as {
  waitLapsed: (tasks: { id: string; type: string }[], seen: Record<string, number>, from: number, to: number) => boolean
}
const { bandLines, compactLine, CHIP } = bandModel as unknown as {
  bandLines: (s: BandState, width: number) => Span[][]
  compactLine: (s: BandState, width: number) => Span[]
  CHIP: Record<string, { word: string; tone: string }>
}
const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')
// Secret-shaped values are built at run time, so no scanner sees a literal one in this file.
const SECRET_A = ['sk', 'live', 'ABCDEF123456abcdef123456'].join('-')
const SECRET_B = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_')
const SECRET_C = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const SECRET_D = ['xoxb', '1234567890', 'ABCDEFGHIJKLMNOP'].join('-')

// ---------- pure: deriveChip ----------

// PR D: `ask()` is a real ask (brief_set). `guess()` is a stored parsed ask: the parser's reading of a closing line. It counts nowhere.
const ask = (over: Partial<OsAskItem> = {}): OsAskItem => ({ kind: 'approval', text: 'Approve PR 12?', source: 'brief_set', ...over })
const guess = (over: Partial<OsAskItem> = {}): OsAskItem => ask({ source: 'parsed', ...over })
const briefOf = (...items: OsAskItem[]): OsBrief => ({ ...emptyBrief(T0), ask: items })
const shellTask = (id = 'b1', type = 'shell') => ({ id, type })
// deriveChip reads the number `openAsksOf` counted (it never recounts the brief): the helper counts it as the mod does. `dialogOpen` is a helper-only switch for one open dialog.
const chipOf = (over: Partial<ChipState> & { bgTasks?: { id: string; type: string }[]; bgSeen?: Record<string, number>; dialogOpen?: boolean; activeAt?: number } = {}) => {
  const { dialogOpen, activeAt, ...given } = over
  const base = { brief: null, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: T0, ...given }
  const steps = dialogOpen === true ? [{ id: 'dialog', tool: 'AskUserQuestion' }] : []
  return deriveChip({ ...base, openAsks: given.openAsks ?? openAsksOf({ steps, brief: base.brief as OsBrief | null, now: T0, activeAt: activeAt ?? T0 }) } as ChipState)
}
const seenNow = (...ids: string[]): Record<string, number> => Object.fromEntries(ids.map(id => [id, T0]))

describe('system wait: deriveChip', () => {
  test('P1 a shell task and a parsed open ask read waiting-on-work (the guess is inert)', () => {
    expect(chipOf({ brief: briefOf(guess()), bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-work')
  })

  test('P1 a shell task with no ask at all reads waiting-on-work, and a workflow counts too', () => {
    expect(chipOf({ bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-work')
    expect(chipOf({ bgTasks: [shellTask('w1', 'workflow')], bgSeen: seenNow('w1') })).toBe('waiting-on-work')
  })

  // Old: a parsed ask with no task read waiting-on-dave. Broken on purpose by `deriveChip` reading `openAsks` (openAsksOf skips `source: parsed`): a guess is not a question.
  test('P1 with no task a parsed ask is idle, and a brief_set ask is waiting-on-dave', () => {
    expect(chipOf({ brief: briefOf(guess()) })).toBe('idle')
    expect(chipOf({ brief: briefOf(guess()), bgTasks: [], bgSeen: {} })).toBe('idle')
    expect(chipOf({ brief: briefOf(ask()) })).toBe('waiting-on-dave')
    expect(chipOf({ brief: briefOf(ask()), bgTasks: [], bgSeen: {} })).toBe('waiting-on-dave')
  })

  test('P2 a brief_set ask beats the wait, and so does an ask with no source (an old state file)', () => {
    expect(chipOf({ brief: briefOf(ask()), bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-dave')
    const noSource = { kind: 'question', text: 'Which branch?' } as unknown as OsAskItem
    expect(chipOf({ brief: briefOf(noSource), bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-dave')
  })

  test('P2 one brief_set ask among parsed ones still beats the wait', () => {
    const brief = briefOf(guess(), ask({ text: 'Which branch?' }))
    expect(chipOf({ brief, bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-dave')
  })

  test('P2 an open dialog beats the wait', () => {
    expect(chipOf({ dialogOpen: true, bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-dave')
  })

  test('P3 an answered brief_set ask does not beat the wait, nor does a parsed one beside it; a stale brief_set ask is no fresh ask', () => {
    const answered = briefOf(ask({ answered: true }), guess())
    expect(chipOf({ brief: answered, bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-work')
    const old = { ...briefOf(ask()), updatedAt: T0 - 25 * 3600_000 }
    expect(chipOf({ brief: old, activeAt: T0 - 25 * 3600_000, bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('waiting-on-work')
  })

  for (const type of ['monitor', 'subagent', 'mystery', '', 'Shell']) {
    // Old: the uncounted type left a parsed ask on waiting-on-dave. Broken on purpose by `openAsksOf` skipping parsed asks: the chip is idle; the type test is now "not waiting-on-work".
    test(`P4 a task of type "${type}" never counts: the chip stays idle (a parsed ask beside it is inert)`, () => {
      expect(chipOf({ brief: briefOf(guess()), bgTasks: [shellTask('t1', type)], bgSeen: seenNow('t1') })).toBe('idle')
    })
  }

  test('P4 one counted task among uncounted ones is enough; a non-string type does not count', () => {
    const tasks = [shellTask('m1', 'monitor'), shellTask('b1', 'shell')]
    expect(chipOf({ brief: briefOf(guess()), bgTasks: tasks, bgSeen: seenNow('m1', 'b1') })).toBe('waiting-on-work')
    const odd = [{ id: 'x', type: 7 }] as unknown as { id: string; type: string }[]
    expect(chipOf({ brief: briefOf(guess()), bgTasks: odd, bgSeen: seenNow('x') })).toBe('idle')
  })

  test('P5 a task first seen exactly BG_WAIT_MAX_MS ago still counts; one millisecond older does not', () => {
    expect(BG_WAIT_MAX_MS).toBe(30 * 60 * 1000)
    // Old: a task past the limit let a parsed ask read waiting-on-dave. Broken on purpose by `openAsksOf` skipping parsed asks: it reads idle.
    const brief = briefOf(guess())
    expect(chipOf({ brief, bgTasks: [shellTask()], bgSeen: { b1: T0 - BG_WAIT_MAX_MS } })).toBe('waiting-on-work')
    expect(chipOf({ brief, bgTasks: [shellTask()], bgSeen: { b1: T0 - BG_WAIT_MAX_MS - 1 } })).toBe('idle')
  })

  test('P5 the age is per task: an old shell does not count, a new one beside it does', () => {
    const brief = briefOf(guess())
    const tasks = [shellTask('old'), shellTask('new')]
    expect(chipOf({ brief, bgTasks: tasks, bgSeen: { old: T0 - 2 * BG_WAIT_MAX_MS, new: T0 } })).toBe('waiting-on-work')
    expect(chipOf({ brief, bgTasks: tasks, bgSeen: { old: T0 - 2 * BG_WAIT_MAX_MS, new: T0 - 3 * BG_WAIT_MAX_MS } })).toBe('idle')
  })

  test('P5 a task with no first-seen time never counts', () => {
    expect(chipOf({ brief: briefOf(guess()), bgTasks: [shellTask()], bgSeen: {} })).toBe('idle')
    // A real ask is never hidden by a task, counted or not.
    expect(chipOf({ brief: briefOf(ask()), bgTasks: [shellTask()], bgSeen: {} })).toBe('waiting-on-dave')
  })

  // Old: a running turn or tool kept a parsed ask on waiting-on-dave. Broken on purpose by `openAsksOf` skipping parsed asks: the running work shows.
  test('P6 a running turn or a running tool keeps rule 3 off: a parsed ask reads working (inert), a brief_set ask waiting-on-dave', () => {
    const wait = { bgTasks: [shellTask()], bgSeen: seenNow('b1') }
    expect(chipOf({ brief: briefOf(guess()), turnActive: true, ...wait })).toBe('working')
    expect(chipOf({ brief: briefOf(guess()), toolRunning: true, ...wait })).toBe('working')
    expect(chipOf({ brief: briefOf(ask()), turnActive: true, ...wait })).toBe('waiting-on-dave')
    expect(chipOf({ brief: briefOf(ask()), toolRunning: true, ...wait })).toBe('waiting-on-dave')
    expect(chipOf({ turnActive: true, ...wait })).toBe('working')
    expect(chipOf({ toolRunning: true, ...wait })).toBe('working')
  })

  test('P6 a running agent run keeps the chip at working: a shell and a running helper, no ask, read working; with a parsed ask working, with a brief_set ask waiting-on-dave', () => {
    const wait = { bgTasks: [shellTask()], bgSeen: seenNow('b1') }
    const running = { agentRuns: [{ status: 'running' }] }
    expect(chipOf({ ...running, ...wait })).toBe('working')
    expect(chipOf({ ...running, brief: briefOf(guess()), ...wait })).toBe('working')
    expect(chipOf({ ...running, brief: briefOf(ask()), ...wait })).toBe('waiting-on-dave')
    // A helper that is not running (done, failed) changes nothing: the wait shows.
    expect(chipOf({ agentRuns: [{ status: 'completed' }], ...wait })).toBe('waiting-on-work')
    expect(chipOf({ agentRuns: [], ...wait })).toBe('waiting-on-work')
  })

  test('P7 blocked outranks the wait', () => {
    expect(chipOf({ blocked: true, bgTasks: [shellTask()], bgSeen: seenNow('b1') })).toBe('blocked')
  })

  test('P8 the old inputs (no wait fields at all) give the old chips', () => {
    expect(chipOf({})).toBe('idle')
    expect(chipOf({ brief: briefOf(ask()) })).toBe('waiting-on-dave')
    expect(chipOf({ brief: briefOf(guess()) })).toBe('idle')
    expect(chipOf({ turnActive: true })).toBe('working')
  })
})

// ---------- pure: band-model ----------

// PR D: the Q sign reads BandState.openAsks, not the brief. The helper counts it as the mod does (openAsksOf) unless the test names it.
const bandState = (over: Partial<BandState> & { waitTasks?: number } = {}): BandState => {
  const state = { chip: 'idle', brief: null, tasks: [], repo: 'repo-x', who: { name: 'trex', short: '0d40499c' }, lane: 'coord', ctx: 41, costUsd: 1.5, now: T0, activeAt: T0, ...over }
  return { ...state, openAsks: over.openAsks ?? openAsksOf({ steps: [], brief: state.brief as OsBrief | null, now: state.now, activeAt: state.activeAt }) } as BandState
}
const CHIPS = ['working', 'waiting-on-dave', 'waiting-on-work', 'blocked', 'done', 'idle'] as const

describe('system wait: band words and tones', () => {
  test('B1 the chip reads WAITING ON 1 TASK / WAITING ON n TASKS, in the dim chip tone', () => {
    for (const [n, word] of [[1, 'WAITING ON 1 TASK'], [2, 'WAITING ON 2 TASKS'], [10, 'WAITING ON 10 TASKS']] as const) {
      const first = bandLines(bandState({ chip: 'waiting-on-work', waitTasks: n }), 120)[0]?.[0]
      expect(first?.text.trim()).toBe(word)
      expect(first?.tone).toBe('chipDim')
      const compact = compactLine(bandState({ chip: 'waiting-on-work', waitTasks: n }), 120)[0]
      expect(compact?.text.trim()).toBe(word)
      expect(compact?.tone).toBe('chipDim')
    }
  })

  test('B1 the wait chip is grey: the dim tone, not the amber of waiting-on-dave and not the blue of working', () => {
    expect(CHIP['waiting-on-work']?.tone).toBe('chipDim')
    expect(CHIP['waiting-on-work']?.tone).not.toBe(CHIP['waiting-on-dave']?.tone)
    expect(CHIP['waiting-on-work']?.tone).not.toBe(CHIP.working?.tone)
  })

  test('B2 QUESTIONS stays amber under the wait chip for a fresh ask, and dim for none or a stale one', () => {
    const tone = (over: Partial<BandState>) => bandLines(bandState({ chip: 'waiting-on-work', waitTasks: 1, ...over }), 120)[1]?.find(span => span.text.startsWith('QUESTIONS'))?.tone
    expect(tone({ brief: briefOf(ask()) })).toBe('warn')
    expect(tone({})).toBe('dim')
    const stale = { ...briefOf(ask()), updatedAt: T0 - 25 * 3600_000 }
    expect(tone({ brief: stale, activeAt: T0 - 25 * 3600_000 })).toBe('dim')
    expect(tone({ brief: briefOf(ask({ answered: true })) })).toBe('dim')
  })

  test('B2 the full line still says QUESTIONS 1 beside the wait chip', () => {
    const lines = bandLines(bandState({ chip: 'waiting-on-work', waitTasks: 1, brief: briefOf(ask()) }), 120)
    expect(text(lines[0])).toContain('WAITING ON 1 TASK')
    expect(text(lines[1])).toContain('QUESTIONS 1')
  })
})

const qSpan = (line: Span[]): Span | undefined => line.find(span => /^Q \d+$/.test(span.text))
/** What a terminal shows: it cuts a row at its right end. The ask must be in it as Q n or as the WAITING FOR YOU chip. */
const shows = (line: Span[], width: number): boolean => {
  const shown = text(line).slice(0, Math.max(width, 20))
  return shown.includes('Q 1') || shown.includes('WAITING FOR YOU')
}

describe('system wait: a fresh ask leaves a sign at every width', () => {
  for (const chip of CHIPS) {
    // The sign needs the chip, a space and `Q 1`. Narrower than that the terminal would cut it: the line must then read WAITING FOR YOU.
    const needed = text([compactLine(bandState({ chip, waitTasks: 1 }), 200)[0] as Span]).length + ' Q 1'.length

    test(`B3 compact line, chip ${chip}: an amber Q 1 where it fits, and what a terminal shows holds Q 1 or WAITING FOR YOU at every width from 20 to 200`, () => {
      for (let width = 20; width <= 200; width++) {
        const line = compactLine(bandState({ chip, waitTasks: 1, brief: briefOf(ask()), helpers: 2, limits: null }), width)
        expect(shows(line, width), `width ${width}: ${text(line)}`).toBe(true)
        if (width < needed) continue
        expect(qSpan(line)?.text, `width ${width}`).toBe('Q 1')
        expect(qSpan(line)?.tone, `width ${width}`).toBe('warn')
      }
    })

    test(`B4 narrow line, chip ${chip}: an amber Q 1 where it fits, and what a terminal shows holds Q 1 or WAITING FOR YOU at every width from 20 to 39`, () => {
      for (let width = 20; width <= 39; width++) {
        const lines = bandLines(bandState({ chip, waitTasks: 1, brief: briefOf(ask()) }), width)
        expect(lines).toHaveLength(1)
        expect(shows(lines[0] ?? [], width), `width ${width}: ${text(lines[0])}`).toBe(true)
        if (width < needed) continue
        expect(qSpan(lines[0] ?? [])?.text, `width ${width}`).toBe('Q 1')
        expect(qSpan(lines[0] ?? [])?.tone, `width ${width}`).toBe('warn')
      }
    })
  }

  test('B3 the count is the number of fresh open asks', () => {
    const two = briefOf(ask(), ask({ text: 'Second?' }), ask({ text: 'Done one?', answered: true }))
    expect(text(compactLine(bandState({ chip: 'waiting-on-work', waitTasks: 1, brief: two }), 120))).toContain('Q 2')
    expect(text(bandLines(bandState({ chip: 'waiting-on-work', waitTasks: 1, brief: two }), 30)[0])).toContain('Q 2')
  })

  test('B3 B4 no ask, an answered ask or a stale ask draws no Q', () => {
    const stale = { ...briefOf(ask()), updatedAt: T0 - 25 * 3600_000 }
    const none = [{}, { brief: briefOf(ask({ answered: true })) }, { brief: stale, activeAt: T0 - 25 * 3600_000 }]
    for (const over of none) {
      for (const width of [20, 30, 39, 40, 80, 200]) {
        expect(qSpan(compactLine(bandState({ chip: 'waiting-on-work', waitTasks: 1, ...over }), width))).toBeUndefined()
        expect(text(bandLines(bandState({ chip: 'waiting-on-work', waitTasks: 1, ...over }), width)[0])).not.toMatch(/\bQ \d/)
      }
    }
  })

  test('B3 B4 no line is wider than the width, except WAITING FOR YOU with its Q n (21 cells) at 20 columns', () => {
    for (const chip of CHIPS) {
      const given = bandState({ chip, waitTasks: 12, brief: briefOf(ask()), repo: 'r'.repeat(80), helpers: 12, costUsd: 1234.5 })
      for (let width = 20; width <= 200; width++) {
        const line = text(compactLine(given, width))
        expect(line.length, `${chip} compact ${width}`).toBeLessThanOrEqual(Math.max(width, 21))
      }
      for (let width = 20; width <= 39; width++) {
        const line = text(bandLines(given, width)[0])
        expect(line.length, `${chip} narrow ${width}`).toBeLessThanOrEqual(Math.max(width, 21))
      }
    }
  })

  test('B3 B4 where the wait chip and Q n do not both fit, the line reads WAITING FOR YOU; with no fresh ask it keeps the wait chip', () => {
    const wait = (over: Partial<BandState> = {}) => bandState({ chip: 'waiting-on-work', waitTasks: 1, ...over })
    for (const width of [20, 21, 22]) {
      const compact = compactLine(wait({ brief: briefOf(ask()) }), width)
      const narrow = bandLines(wait({ brief: briefOf(ask()) }), width)[0] ?? []
      for (const line of [compact, narrow]) {
        expect(line[0]?.text.trim(), `width ${width}`).toBe('WAITING FOR YOU')
        expect(line[0]?.tone, `width ${width}`).toBe('chipWarn')
      }
      expect(compactLine(wait(), width)[0]?.text.trim(), `no ask, width ${width}`).toBe('WAITING ON 1 TASK')
      expect((bandLines(wait(), width)[0] ?? [])[0]?.text.trim(), `no ask, width ${width}`).toBe('WAITING ON 1 TASK')
    }
    for (const width of [23, 24, 39, 120]) {
      expect(compactLine(wait({ brief: briefOf(ask()) }), width)[0]?.text.trim(), `width ${width}`).toBe('WAITING ON 1 TASK')
    }
    // With no fresh ask the wait chip never turns into WAITING FOR YOU (that would say a person is needed), even when it is wider than the width.
    expect(compactLine(wait({ waitTasks: 10 }), 20)[0]?.text.trim()).toBe('WAITING ON 10 TASKS')
    expect((bandLines(wait({ waitTasks: 10 }), 20)[0] ?? [])[0]?.text.trim()).toBe('WAITING ON 10 TASKS')
    // Ten tasks widen the word to 21 cells: the sign needs 25.
    const ten = (width: number) => compactLine(wait({ waitTasks: 10, brief: briefOf(ask()) }), width)[0]?.text.trim()
    expect(ten(24)).toBe('WAITING FOR YOU')
    expect(ten(25)).toBe('WAITING ON 10 TASKS')
  })

  test('B3 the Q n comes straight after the chip, before every other field', () => {
    const line = compactLine(bandState({ chip: 'waiting-on-work', waitTasks: 1, brief: briefOf(ask()), helpers: 2 }), 200)
    const at = line.findIndex(span => /^Q \d+$/.test(span.text))
    expect(at).toBeGreaterThan(0)
    expect(line.slice(1, at).every(span => span.text.trim() === '')).toBe(true)
  })

  test('B3 the other chip words are whole at every width, with a Q beside them', () => {
    const words = { working: 'WORKING', 'waiting-on-dave': 'WAITING FOR YOU', blocked: 'STUCK', done: 'DONE', idle: 'RESTING' } as const
    for (const chip of Object.keys(words) as (keyof typeof words)[]) {
      for (let width = 20; width <= 120; width += 7) {
        expect(compactLine(bandState({ chip, brief: briefOf(ask()) }), width)[0]?.text.trim()).toBe(words[chip])
      }
    }
  })
})

// ---------- through the whole mod ----------

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PARSED_ANSWER = 'Done.\n\n## Next steps\n1. Rotate the key before the merge?\n'
const FILE = 'C:/home/.claude/state/agentic-os/test-session.json'

type Seen = {
  clock: ReturnType<typeof mock.clock>
  writes: { path: string; text: string }[]
  atoms: string[]
  stop: { result: Record<string, unknown>; hold: Promise<void> | null; calls: number }
  tool: { hold: Promise<void> | null }
}

// The engine beneath the plugin: a clock, a home folder (so the state file is written), and a core answer for each event the mod hooks.
const world = (on: On, env: Record<string, string> = {}): Seen => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  const seen: Seen = { clock, writes: [], atoms: [], stop: { result: {}, hold: null, calls: 0 }, tool: { hold: null } }
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('classic.Stop', async () => {
    seen.stop.calls += 1
    if (seen.stop.hold !== null) await seen.stop.hold
    return seen.stop.result as never
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('tool.call', { tool: 'AskUserQuestion' } as never, (async () => {
    if (seen.tool.hold !== null) await seen.tool.hold
    return { result: { answers: {} } }
  }) as never)
  on('tool.call', { tool: 'Bash' } as never, (async () => {
    if (seen.tool.hold !== null) await seen.tool.hold
    return { result: { stdout: '' } }
  }) as never)
  // Every atom write, as text: a value that must never be stored is searched for here.
  on('state.set', ((_$: unknown, e: { value: unknown }, next: (e: unknown) => unknown) => {
    seen.atoms.push(JSON.stringify(e.value) ?? '')
    return next(e)
  }) as never)
  return seen
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
const shell = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'shell', status: 'running', description: 'sleep 120', command: 'sleep 120', ...extra })
const stop = ($: Engine, over: Record<string, unknown> = {}) => $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, session_id: 'test-session', ...over } as never)
const turnEnd = ($: Engine, answer: string, id = 't1') => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: id, reason: 'end_turn' } as never)
const turnStart = ($: Engine, id = 't1', over: Record<string, unknown> = {}) => $.turn.start({ turnId: id, ...over } as never)
const parsedAsk = async ($: Engine) => {
  await turnStart($)
  await turnEnd($, PARSED_ANSWER)
}

const view = async ($: Engine, columns = 120, maxRows = BAND_PROPS.maxRows) => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: columns, maxRows } })
  const rows = (await band.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-'))
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  await band.unmount()
  const at = (key: string) => rows.find(found => found.key === key)?.text
  return { line1: at('row-core-1') ?? '', line2: at('row-core-2') ?? '', all: rows.map(found => found.text).join('\n'), texts: texts.join('\n') }
}

const snapshot = (seen: Seen): Record<string, any> => JSON.parse(seen.writes.filter(write => write.path === FILE).at(-1)?.text ?? '{}')

/** The mod's own state file after a write that is certain to happen (a brief_set with a goal). */
const writeState = async ($: Engine, seen: Seen) => {
  await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' } as never)
  return snapshot(seen)
}

describe('system wait: the whole mod', () => {
  // Old: the turn-end ask made the chip WAITING FOR YOU and line 2 QUESTIONS 1. Broken on purpose by `learnFromAnswer` dropping the parsed ask (a turn end stores none) and `openAsksOf` skipping parsed asks.
  test('S1 a shell and a turn-end ask guess: the chip reads WAITING ON 1 TASK and line 2 says QUESTIONS 0', async ($, on) => {
    world(on)
    await start($)
    await parsedAsk($)
    expect((await view($)).line1).toContain('RESTING')
    await stop($, { background_tasks: [shell('b1')] })
    const got = await view($)
    expect(got.line1).toContain('WAITING ON 1 TASK')
    expect(got.line1).not.toContain('WAITING FOR YOU')
    expect(got.line2).toContain('QUESTIONS 0')
  })

  test('S1 two tasks read WAITING ON 2 TASKS (a workflow counts)', async ($, on) => {
    world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1'), shell('w1', { type: 'workflow' })] })
    expect((await view($)).line1).toContain('WAITING ON 2 TASKS')
  })

  // Old: Q 1 beside the wait chip for a turn-end guess (fix 5 main guard). Broken on purpose by `learnFromAnswer` dropping the parsed ask: no sign for a guess; a real ask never sits
  // beside the wait chip (openAsks above 0 gives waiting-on-dave, S2), so the model-level sign-beside-wait cases stay in the pure B3 and B4 tests.
  test('S1 the compact line and the narrow width draw no Q beside the wait chip for a turn-end guess', async ($, on) => {
    world(on)
    await start($)
    await parsedAsk($)
    await stop($, { background_tasks: [shell('b1')] })
    const short = await view($, 120, 1)
    expect(short.line1).toContain('WAITING ON 1 TASK')
    expect(short.line1).not.toMatch(/\bQ \d/)
    const narrow = await view($, 30)
    expect(narrow.line1).toContain('WAITING ON 1 TASK')
    expect(narrow.line1).not.toMatch(/\bQ \d/)
  })

  test('S2 a brief_set ask beats the wait', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which branch?' }] } as never)
    await stop($, { background_tasks: [shell('b1')] })
    const got = await view($)
    expect(got.line1).toContain('WAITING FOR YOU')
    expect(got.line1).not.toContain('WAITING ON')
  })

  test('S2 an open AskUserQuestion dialog beats the wait', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    let release = () => {}
    seen.tool.hold = new Promise<void>(resolve => { release = resolve })
    const pending = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await seen.clock.settle()
    const got = await view($)
    expect(got.line1).toContain('WAITING FOR YOU')
    release()
    await pending
  })

  // Old: no task and a turn-end ask read WAITING FOR YOU and QUESTIONS 1. Broken on purpose by `learnFromAnswer` dropping the parsed ask.
  test('S3 no task and a turn-end ask guess: RESTING and QUESTIONS 0; a brief_set ask reads WAITING FOR YOU and QUESTIONS 1', async ($, on) => {
    world(on)
    await start($)
    await parsedAsk($)
    await stop($, { background_tasks: [] })
    const got = await view($)
    expect(got.line1).toContain('RESTING')
    expect(got.line2).toContain('QUESTIONS 0')
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which branch?' }] } as never)
    const real = await view($)
    expect(real.line1).toContain('WAITING FOR YOU')
    expect(real.line2).toContain('QUESTIONS 1')
  })

  test('S3 a cron alone changes nothing: no wait chip, with or without an ask', async ($, on) => {
    world(on)
    await start($)
    const crons = [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'tick' }, { id: 'c2', schedule: '5 4 3 2 *', recurring: false, prompt: 'once' }]
    await stop($, { background_tasks: [], session_crons: crons })
    expect((await view($)).line1).toContain('RESTING')
    // Old: WAITING FOR YOU after the turn-end ask. Broken on purpose by `learnFromAnswer` dropping the parsed ask: a real ask is the one that waits.
    await parsedAsk($)
    await stop($, { background_tasks: [], session_crons: crons })
    expect((await view($)).line1).toContain('RESTING')
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which branch?' }] } as never)
    await stop($, { background_tasks: [], session_crons: crons })
    expect((await view($)).line1).toContain('WAITING FOR YOU')
  })

  test('S3 a missing, null or non-array background_tasks changes nothing and does not throw', async ($, on) => {
    world(on)
    await start($)
    for (const value of [undefined, null, 'x', 7, {}, { 0: shell('b1') }, true]) {
      const r = await stop($, value === undefined ? {} : { background_tasks: value })
      expect(r).toEqual({})
      expect((await view($)).line1).toContain('RESTING')
    }
  })

  test('S3 a non-array background_tasks after a real wait leaves the wait as it was (no wipe)', async ($, on) => {
    world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    for (const value of ['x', 'abc', 7, null, {}, { 0: shell('b1') }, true]) {
      const r = await stop($, { background_tasks: value })
      expect(r).toEqual({})
      expect((await view($)).line1, JSON.stringify(value)).toContain('WAITING ON 1 TASK')
    }
  })

  test('S3 malformed task entries are skipped; the good one beside them counts', async ($, on) => {
    world(on)
    await start($)
    await stop($, { background_tasks: [null, 7, 'x', [], {}, { id: 3, type: 'shell' }, { id: 'n', type: 9 }, { id: '', type: 'shell' }, shell('ok')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('S3 a second Stop with an empty list ends the wait (the task finished)', async ($, on) => {
    world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    await stop($, { background_tasks: [] })
    expect((await view($)).line1).toContain('RESTING')
  })

  for (const type of ['monitor', 'subagent', 'mystery']) {
    // Old: WAITING FOR YOU for the turn-end ask. Broken on purpose by `learnFromAnswer` dropping the parsed ask. The type test stays: a standing task of that type never reads WAITING ON,
    // and a real ask beside it reads WAITING FOR YOU.
    test(`S4 a ${type} task never reads WAITING ON: RESTING with a turn-end guess, WAITING FOR YOU with a brief_set ask`, async ($, on) => {
      world(on)
      await start($)
      await parsedAsk($)
      await stop($, { background_tasks: [shell('x1', { type })] })
      const got = await view($)
      expect(got.line1).toContain('RESTING')
      expect(got.line1).not.toContain('WAITING ON')
      await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which branch?' }] } as never)
      const real = await view($)
      expect(real.line1).toContain('WAITING FOR YOU')
      expect(real.line1).not.toContain('WAITING ON')
    })
  }

  test('S4 a Stop during a running turn reads WORKING; the turn end then shows the wait', async ($, on) => {
    world(on)
    await start($)
    await turnStart($)
    await stop($, { background_tasks: [shell('b1')] })
    expect((await view($)).line1).toContain('WORKING')
    await turnEnd($, 'ok')
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('S12 a running tool call reads WORKING, not waiting on tasks', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    let release = () => {}
    seen.tool.hold = new Promise<void>(resolve => { release = resolve })
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never)
    await seen.clock.settle()
    const got = await view($)
    expect(got.line1).toContain('WORKING')
    expect(got.line1).not.toContain('WAITING ON')
    release()
    await pending
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })
})

describe('system wait: clears', () => {
  const waiting = async ($: Engine, seen: Seen) => {
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    return seen
  }

  test('S4 a main turn start clears the wait', async ($, on) => {
    await waiting($, world(on))
    await turnStart($, 't2')
    await turnEnd($, 'ok', 't2')
    expect((await view($)).line1).toContain('RESTING')
  })

  test('S4 a subagent turn start does not clear the wait', async ($, on) => {
    await waiting($, world(on))
    await turnStart($, 'sub1', { agentId: 'a1' })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('S4 a user prompt clears the wait', async ($, on) => {
    await waiting($, world(on))
    await $.classic.UserPromptSubmit({ prompt: 'go on' } as never)
    expect((await view($)).line1).toContain('RESTING')
  })

  // Two hooks: sources resume and clear run one handler, startup, compact and fork the other.
  for (const source of ['startup', 'compact', 'fork', 'resume', 'clear']) {
    test(`S4 a classic.SessionStart (${source}) clears the wait`, async ($, on) => {
      await waiting($, world(on))
      await $.classic.SessionStart({ source } as never)
      expect((await view($)).line1).toContain('RESTING')
    })
  }

  // The Stop hook waits for next(e); a clear that lands then must not be overwritten by the late write.
  const lateClear: [string, ($: Engine) => Promise<unknown>][] = [
    ['UserPromptSubmit', $ => $.classic.UserPromptSubmit({ prompt: 'go on' } as never)],
    ['turn.start', async $ => { await turnStart($, 't2'); await turnEnd($, 'ok', 't2') }],
    ['SessionStart startup', $ => $.classic.SessionStart({ source: 'startup' } as never)],
    ['SessionStart clear', $ => $.classic.SessionStart({ source: 'clear' } as never)],
  ]
  for (const [name, clear] of lateClear) {
    test(`S5 a ${name} that lands while the Stop waits for next(e) is not overwritten by the late write`, async ($, on) => {
      const seen = world(on)
      await start($)
      let release = () => {}
      seen.stop.hold = new Promise<void>(resolve => { release = resolve })
      const pending = stop($, { background_tasks: [shell('b1')] })
      await seen.clock.settle()
      expect(seen.stop.calls).toBe(1)
      await clear($)
      release()
      await pending
      expect((await view($)).line1).toContain('RESTING')
    })
  }

  // The first-seen time survives a turn start and a prompt, so a late write of the list alone would bring the wait back.
  for (const [name, clear] of lateClear.slice(0, 2)) {
    test(`S5 a standing shell: a ${name} during the second Stop's next(e) still wins, although the first-seen time is kept`, async ($, on) => {
      const seen = world(on)
      await start($)
      await stop($, { background_tasks: [shell('b1')] })
      let release = () => {}
      seen.stop.hold = new Promise<void>(resolve => { release = resolve })
      const pending = stop($, { background_tasks: [shell('b1')] })
      await seen.clock.settle()
      await clear($)
      release()
      await pending
      expect((await view($)).line1).toContain('RESTING')
    })
  }

  test('S5 with no clear in between, the late write lands (the hold itself is harmless)', async ($, on) => {
    const seen = world(on)
    await start($)
    let release = () => {}
    seen.stop.hold = new Promise<void>(resolve => { release = resolve })
    const pending = stop($, { background_tasks: [shell('b1')] })
    await seen.clock.settle()
    release()
    await pending
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })
})

describe('system wait: which Stop counts', () => {
  test('S6 a Stop that carries agent_id (a subagent) sets nothing', async ($, on) => {
    world(on)
    await start($)
    const r = await stop($, { agent_id: 'a1', background_tasks: [shell('b1')] })
    expect(r).toEqual({})
    expect((await view($)).line1).toContain('RESTING')
  })

  test('S6 a subagent Stop does not renew or clear the main wait either', async ($, on) => {
    world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    await stop($, { agent_id: 'a1', background_tasks: [] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('S6 a blocking Stop (block) writes nothing, and its result goes on unchanged', async ($, on) => {
    const seen = world(on)
    await start($)
    seen.stop.result = { block: 'keep going' }
    const r = await stop($, { background_tasks: [shell('b1')] })
    expect(r).toEqual({ block: 'keep going' })
    expect((await view($)).line1).toContain('RESTING')
  })

  test('S6 a Stop that stops the session (preventContinuation) writes nothing', async ($, on) => {
    const seen = world(on)
    await start($)
    seen.stop.result = { preventContinuation: true, stopReason: 'done' }
    const r = await stop($, { background_tasks: [shell('b1')] })
    expect(r).toEqual({ preventContinuation: true, stopReason: 'done' })
    expect((await view($)).line1).toContain('RESTING')
  })

  test('S9 the Stop result is the result of next(e), byte for byte, with tasks and without', async ($, on) => {
    const seen = world(on)
    await start($)
    seen.stop.result = { additionalContext: ['one', 'two'] }
    const withTasks = await stop($, { background_tasks: [shell('b1')] })
    const without = await stop($, {})
    expect(JSON.stringify(withTasks)).toBe(JSON.stringify({ additionalContext: ['one', 'two'] }))
    expect(JSON.stringify(without)).toBe(JSON.stringify({ additionalContext: ['one', 'two'] }))
    expect(seen.stop.calls).toBe(2)
  })

  test('S9 the off switch passes the Stop on and stores nothing', async ($, on) => {
    const seen = world(on, { CCV3_MODS_OFF: '1' })
    await start($)
    const before = seen.atoms.length
    const r = await stop($, { background_tasks: [shell('b1')] })
    expect(r).toEqual({})
    expect(seen.atoms).toHaveLength(before)
    expect(seen.stop.calls).toBe(1)
  })
})

describe('system wait: nothing leaks', () => {
  const FREE = [SECRET_A, SECRET_B, SECRET_C, SECRET_D]

  test('S7 a secret in description, command, prompt, server, tool, name or agent_type reaches no atom, no band text and no state file', async ($, on) => {
    const seen = world(on)
    await start($)
    await parsedAsk($)
    const tasks = [
      shell('b1', { description: `watch ${SECRET_A}`, command: `curl -H "Authorization: ${SECRET_B}" x` }),
      { id: 'w1', type: 'workflow', status: 'running', description: `flow ${SECRET_C}`, name: `wf-${SECRET_D}` },
      { id: 'm1', type: 'monitor', status: 'running', description: `mon ${SECRET_A}`, server: `srv-${SECRET_B}`, tool: `tool-${SECRET_C}` },
      { id: 's1', type: 'subagent', status: 'running', description: `sub ${SECRET_D}`, agent_type: `agent-${SECRET_A}` },
    ]
    const crons = [{ id: 'c1', schedule: '0 9 * * *', recurring: false, prompt: `run ${SECRET_B}` }]
    await stop($, { background_tasks: tasks, session_crons: crons, last_assistant_message: `say ${SECRET_C}` })
    const state = await writeState($, seen)
    const bands = [await view($), await view($, 120, 1), await view($, 30), await view($, 20)]
    const haystack = [...seen.atoms, JSON.stringify(state), ...seen.writes.map(write => write.text), ...bands.map(one => `${one.all}\n${one.texts}`)].join('\n')
    expect(bands[0]?.line1).toContain('WAITING ON')
    for (const secret of FREE) expect(haystack).not.toContain(secret)
    for (const part of ['sleep 120', 'curl', 'Authorization', 'srv-', 'tool-', 'wf-', 'agent-', 'watch ']) expect(haystack).not.toContain(part)
  })

  test('S7 only the id and the type of a task are stored: the atom writes of a Stop name the id, the type and a time, nothing else', async ($, on) => {
    const seen = world(on)
    await start($)
    const before = seen.atoms.length
    await stop($, { background_tasks: [shell('b1', { description: 'DESCRIPTION-TEXT', command: 'COMMAND-TEXT', status: 'STATUS-TEXT' })] })
    const added = seen.atoms.slice(before).join('\n')
    expect(added).toContain('b1')
    expect(added).toContain('shell')
    for (const part of ['DESCRIPTION-TEXT', 'COMMAND-TEXT', 'STATUS-TEXT']) expect(added).not.toContain(part)
  })
})

describe('system wait: the state file', () => {
  // Old: a turn-end ask under a shell read WAITING ON 1 TASK on the band and waiting-on-dave in the file. Broken on purpose by `learnFromAnswer` dropping the parsed ask: with a real ask
  // the chip is waiting-on-dave on the band too (openAsks above 0 beats the wait), and the file agrees.
  test('S8 the state file never holds waiting-on-work: with a fresh brief_set ask it reads waiting-on-dave, the band too', async ($, on) => {
    const seen = world(on)
    await start($)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'Which branch?' }] } as never)
    await stop($, { background_tasks: [shell('b1')] })
    expect((await view($)).line1).toContain('WAITING FOR YOU')
    expect((await view($)).line1).not.toContain('WAITING ON')
    expect((await writeState($, seen)).chip).toBe('waiting-on-dave')
  })

  test('S8 with no ask it reads the chip without the new rule (idle)', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    expect((await writeState($, seen)).chip).toBe('idle')
  })

  test('S8 every chip written along the way is one of the five old values, and no wait field is in the file', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('b1')] })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' } as never)
    await parsedAsk($)
    await stop($, { background_tasks: [shell('b1'), shell('w1', { type: 'workflow' })] })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g2' } as never)
    await turnStart($, 't2')
    await turnEnd($, 'ok', 't2')
    const files = seen.writes.filter(write => write.path === FILE)
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const parsed = JSON.parse(file.text) as Record<string, unknown>
      expect(['working', 'waiting-on-dave', 'blocked', 'done', 'idle']).toContain(parsed.chip)
      expect(Object.keys(parsed).filter(key => /bg|wait|background|cron/i.test(key))).toEqual([])
      expect(file.text).not.toContain('waiting-on-work')
      expect(file.text).not.toContain('"b1"')
    }
  })
})

/**
 * The atoms of this feature as stores a test controls, the way heldHud (hud.test.ts) and heldGit (agentic-os.test.ts) do it: the kit keeps atoms
 * across a SessionStart, the real engine wipes them. state.get and state.set answer from `held`; `wipe()` puts every default back.
 */
const heldAtoms = (on: On) => {
  const defaults: Record<string, unknown> = { bgSeen: {}, bgTasks: [], brief: null }
  const held: Record<string, { value: unknown; version: number }> = {}
  for (const key of Object.keys(defaults)) {
    held[key] = { value: defaults[key], version: 0 }
    const ref = { plugin: 'ccv3-mods', key } as never
    on('state.get', ref, (() => ({ value: { value: held[key]?.value, version: held[key]?.version } })) as never)
    on('state.set', ref, ((_$: unknown, e: { value: unknown; ifVersion?: number }) => {
      const mine = held[key] as { value: unknown; version: number }
      if (e.ifVersion !== undefined && e.ifVersion !== mine.version) return { value: { isSet: false, version: mine.version } }
      mine.value = e.value
      mine.version += 1
      return { value: { isSet: true, version: mine.version } }
    }) as never)
  }
  return {
    wipe: () => {
      for (const key of Object.keys(defaults)) held[key] = { value: defaults[key], version: (held[key]?.version ?? 0) + 1 }
    },
  }
}

// Old: after the age limit the chip read WAITING FOR YOU (the turn-end ask came back). Broken on purpose by `learnFromAnswer` dropping the parsed ask (and `openAsksOf` skipping parsed asks):
// the parsed answer is still fed at every turn end below (it pins that it stays inert), and the chip reads RESTING once the shell stops counting.
describe('system wait: the age limit', () => {
  const standing = async ($: Engine, seen: Seen) => {
    // The real order: a turn starts (it clears the list), the turn ends, the Stop reports the same shell again.
    await start($)
    await parsedAsk($)
    await stop($, { background_tasks: [shell('s1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    return seen
  }
  const again = async ($: Engine, seen: Seen, ms: number) => {
    await seen.clock.advance(ms)
    await turnStart($, `t${seen.clock.now()}`)
    await turnEnd($, PARSED_ANSWER, `t${seen.clock.now()}`)
    await stop($, { background_tasks: [shell('s1')] })
  }

  test('P5 S10 a standing shell with a turn and a Stop every 20 minutes stops counting 30 minutes after its first sight', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await again($, seen, 20 * MIN)
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    await again($, seen, 20 * MIN)
    const got = await view($)
    expect(got.line1).toContain('RESTING')
    expect(got.line1).not.toContain('WAITING ON')
    await again($, seen, 20 * MIN)
    expect((await view($)).line1).toContain('RESTING')
  })

  test('P5 a Stop every 10 minutes does not renew the age either', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    for (let i = 0; i < 3; i++) await again($, seen, 10 * MIN)
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    await again($, seen, 10 * MIN)
    expect((await view($)).line1).toContain('RESTING')
  })

  test('P5 a new shell id after the old one aged out counts again from its own first sight', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await again($, seen, 40 * MIN)
    expect((await view($)).line1).toContain('RESTING')
    await stop($, { background_tasks: [shell('s1'), shell('s2')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('P5 a shell the Stop no longer lists is forgotten: the same id first seen again counts from that Stop', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await seen.clock.advance(40 * MIN)
    await stop($, { background_tasks: [] })
    await stop($, { background_tasks: [shell('s1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  // Both SessionStart handlers empty the list. Only a startup forgets the first-seen times by code: a compact or fork keeps the age of a shell that
  // never ends, or each one would give it another 30 minutes. A resume or a clear starts a new session id and the ENGINE wipes the plugin's atoms first
  // (live probe, engine 2.1.327, 2026-11-18, headless stream-json run: atom n went 3 to 0 at classic.SessionStart source clear while the module counter
  // kept going, so the module did not reload; clear proven, resume unverified: it also starts a new id, so it is treated the same).
  // The kit keeps atoms across a SessionStart, so the resume and clear cases below wipe the three atoms of this feature the way heldGit and heldHud
  // do in agentic-os.test.ts and hud.test.ts.
  for (const source of ['compact', 'fork']) {
    test(`P5 a SessionStart (${source}) keeps the first-seen times: a 40 minute old shell stays aged out`, async ($, on) => {
      const seen = world(on)
      await standing($, seen)
      await seen.clock.advance(40 * MIN)
      await $.classic.SessionStart({ source } as never)
      expect((await view($)).line1).toContain('RESTING')
      await stop($, { background_tasks: [shell('s1')] })
      const got = await view($)
      expect(got.line1).toContain('RESTING')
      expect(got.line1).not.toContain('WAITING ON')
    })
  }

  // Source change that makes a case fail: the first-seen times kept outside the atom (a module-level map in index.tsx), so a wiped atom no longer
  // forgets them (the shell would stay aged out and the band would not read WAITING ON 1 TASK).
  for (const source of ['resume', 'clear']) {
    test(`P5 a ${source} wipes the atoms first (live, 2.1.327): the shell's first-seen time is gone, so it counts again from its next Stop, for up to 30 minutes`, async ($, on) => {
      const seen = world(on)
      const held = heldAtoms(on)
      await standing($, seen)
      await seen.clock.advance(31 * MIN)
      // What the engine does at /clear and a resume: the atoms are empty before classic.SessionStart runs.
      held.wipe()
      await $.classic.SessionStart({ source } as never)
      // The ask went with the brief atom: nothing to wait for, no wait chip.
      expect((await view($)).line1).toContain('RESTING')
      await stop($, { background_tasks: [shell('s1')] })
      expect((await view($)).line1).toContain('WAITING ON 1 TASK')
      // From this first sight it counts for up to 30 minutes again (the age limit itself is pinned by the P5 tests above).
    })
  }

  test('P5 a SessionStart (startup) forgets the first-seen times: the same id counts again from its next Stop', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await seen.clock.advance(40 * MIN)
    await $.classic.SessionStart({ source: 'startup' } as never)
    await stop($, { background_tasks: [shell('s1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
  })

  test('P5 a shell 10 minutes old still counts after a compact (the age is kept, not reset)', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await seen.clock.advance(10 * MIN)
    await $.classic.SessionStart({ source: 'compact' } as never)
    await stop($, { background_tasks: [shell('s1')] })
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    await seen.clock.advance(21 * MIN)
    await stop($, { background_tasks: [shell('s1')] })
    expect((await view($)).line1).toContain('RESTING')
  })

  test('P14 one Stop and no more: the shell stops counting at the limit when the band redraws', async ($, on) => {
    const seen = world(on)
    await standing($, seen)
    await seen.clock.advance(BG_WAIT_MAX_MS - 1_000)
    expect((await view($)).line1).toContain('WAITING ON 1 TASK')
    await seen.clock.advance(2_000)
    expect((await view($)).line1).toContain('RESTING')
  })

  test('S11 an idle band redraws when a counted task passes the age limit, with no other event', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('s1')] })
    const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ key: 'row-core-1' }))?.text).toContain('WAITING ON 1 TASK')
    await seen.clock.advance(BG_WAIT_MAX_MS + 60_000)
    const after = (await band.find({ key: 'row-core-1' }))?.text
    await band.unmount()
    expect(after).toContain('RESTING')
    expect(after).not.toContain('WAITING ON')
  })

  test('E the redraw at the age limit happens once, not on every pulse after it (it is measured from the last redraw)', async ($, on) => {
    const seen = world(on)
    await start($)
    await stop($, { background_tasks: [shell('s1')] })
    await seen.clock.advance(BG_WAIT_MAX_MS - 5 * MIN)
    const before = seen.atoms.length
    await seen.clock.advance(10 * MIN)
    // Only the tick atom moves while the session is idle: one number per redraw.
    const ticks = seen.atoms.slice(before).filter(text => /^\d+$/.test(text))
    expect(ticks).toHaveLength(1)
  })
})

describe('system wait: waitLapsed', () => {
  const tasks = [{ id: 's1', type: 'shell' }]
  const last = T0 + BG_WAIT_MAX_MS // the last instant the shell still counts

  test('E a window that holds the limit finds it, however long the window is (a machine that slept)', () => {
    expect(waitLapsed(tasks, { s1: T0 }, last - 1_000, last + 1_000)).toBe(true)
    expect(waitLapsed(tasks, { s1: T0 }, last - 3 * 3600_000, last + 3 * 3600_000)).toBe(true)
    expect(waitLapsed(tasks, { s1: T0 }, T0, last + 8 * 3600_000)).toBe(true)
  })

  test('E a window the limit is not in finds nothing: before it, after it (a redraw already closed it), or empty', () => {
    expect(waitLapsed(tasks, { s1: T0 }, T0, last - 1)).toBe(false)
    expect(waitLapsed(tasks, { s1: T0 }, last + 1, last + 5_000)).toBe(false)
    expect(waitLapsed(tasks, { s1: T0 }, last + 1, last + 8 * 3600_000)).toBe(false)
  })

  test('E the window edges: the last counting instant is in [from, to), so from = it finds it and to = it does not', () => {
    expect(waitLapsed(tasks, { s1: T0 }, last, last + 1)).toBe(true)
    expect(waitLapsed(tasks, { s1: T0 }, last - 1_000, last)).toBe(false)
  })

  test('E only counted types with a first-seen time can lapse', () => {
    for (const type of ['monitor', 'subagent', 'mystery']) expect(waitLapsed([{ id: 's1', type }], { s1: T0 }, T0, last + 1_000)).toBe(false)
    expect(waitLapsed(tasks, {}, 0, last + 1_000)).toBe(false)
    expect(waitLapsed([{ id: 'w1', type: 'workflow' }], { w1: T0 }, T0, last + 1_000)).toBe(true)
  })
})
