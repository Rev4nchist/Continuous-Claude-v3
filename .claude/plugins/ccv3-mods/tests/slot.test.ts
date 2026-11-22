import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { TICKS } from './fixtures/slot-queue-ticks'
import { askFor, reportLine, statusText, watchLine } from '../hooks/pr-loop/model'
import type { Alert, PrStatus } from '../hooks/pr-loop/model'
import { alertSlot, parseList, parseSlotArgs, parseTick, rowsText, slotAskOf, slotAskSpec, slotLine, slotOf, toastText } from '../hooks/pr-loop/slot-model'
import type { CheckpointRecord, SlotRow } from '../types'

// The free-slot queue, the pure part (W3). The model lines, the ask and the tick parser run on real inputs; no engine world is needed
// because the alert's `slot` field and `askFor`'s `inQueue` argument are set by the W4 wiring.
// F12 a queued PR's model line tells the model to post (the queue posts, the model must not)
// F20 an ask or a time-out that names no /slot text (Dave sees a toast he cannot answer)
// M6  the opening ask fires for a PR the queue holds
// M7  the time-out line loses the reader text
// P1  parseTick differs from what the CLI prints (the shared fixtures scripts/github/fixtures/slot-queue/tick-*.json)
// P2  a /slot argument is read wrong: a typo posts or pays for the wrong PR
// P3  the queue row text is wrong or hides the state
// P4  the list parser reads what `list --json` prints
// W4 (the wiring, one engine world per test):
// M1  an idle session starts a slot-queue process every 5 minutes
// M2  the tick's toasts are not delivered, or the mod rows are lost
// M3  a /slot write from another origin, or a headless session
// M4  a /slot verb is not wired to its CLI call
// M5  a failing tick spams a toast every 5 minutes
// F17 the tick keeps its clock in memory, so a late session misses the time-out
// A1  the alert loses the queue after the re-probe, so the line tells the model to post
// A2  the opening ask fires for a PR the queue holds
// A3  a timed-out STALLED line is lost because the plain STALLED line went out first

const fixture = (name: keyof typeof TICKS): string => TICKS[name]

const HEAD = 'a'.repeat(40)
const alert = (extra: Partial<Alert>): Alert => ({
  pr: 31,
  state: 'LIMITED',
  head: HEAD,
  headShort: HEAD.slice(0, 7),
  merged: false,
  whenReady: false,
  reasons: ['CodeRabbit rate limited: next included review in 12 minutes'],
  bots: ['coderabbit'],
  reviewedBy: [],
  checkpoint: { budget: [1, 1], rounds: 0, granted: null, declined: null, band: null },
  ...extra,
})

const QUEUED = { position: 1, total: 2, state: 'queued' }
const FORBIDDEN = /post one @coderabbitai review|Post @coderabbitai review once/i
const NO_POST = /Do not post @coderabbitai review/i

const LIMITED_RATE = alert({ rateLimit: { minutes: 12 } })
const LIMITED_OTHER = alert({ reasons: ['CodeRabbit review skipped'] })
const STALLED = alert({ state: 'STALLED', reasons: ['no CodeRabbit review on the head'] })
const REVIEWED = alert({ state: 'REVIEWED', reviewedBy: ['coderabbit'], reasons: ['2 unresolved threads'] })

describe('slot: the model lines for a queued PR (F12)', () => {
  for (const [name, base] of [['LIMITED rate limited', LIMITED_RATE], ['LIMITED other', LIMITED_OTHER], ['STALLED', STALLED], ['REVIEWED', REVIEWED]] as const) {
    test(`F12 ${name}: without the queue the line tells the model to post (control)`, () => {
      expect(reportLine(base)).toMatch(FORBIDDEN)
    })
    test(`F12 ${name}: a queued PR gets "Do not post" and no sentence that allows a post`, () => {
      const line = reportLine({ ...base, slot: QUEUED })
      expect(line).toMatch(NO_POST)
      expect(line).not.toMatch(FORBIDDEN)
      expect(line).toMatch(/free-slot queue/i)
    })
  }

  test('F12 the queued LIMITED line keeps the cr-paid check (Q2) and drops the capacity post', () => {
    const line = reportLine({ ...LIMITED_RATE, slot: QUEUED })
    expect(line).toContain('cr-paid.mjs check --pr 31')
    expect(line).toContain('--use-credits')
    expect(line).not.toMatch(/post one @coderabbitai review when capacity is back/i)
  })

  test('F12 every queue state keeps the no-post rule', () => {
    for (const state of ['queued', 'posted', 'timed-out', 'stuck', 'awaiting-fix']) {
      const line = reportLine({ ...STALLED, slot: { position: null, total: 2, state } })
      expect(line, state).toMatch(NO_POST)
      expect(line, state).not.toMatch(FORBIDDEN)
    }
  })

  test('F12 a carry that holds still says run cr-fix and do not post, queued or not', () => {
    const carry = alert({ rateLimit: { minutes: 12 }, reasons: ['no CodeRabbit PR-bot review of the head commit; the earlier review carries once cr-fix is pasted'], checkpoint: { budget: [1, 1], rounds: 1, granted: null, declined: null, band: null }, slot: QUEUED })
    const line = reportLine(carry)
    expect(line).toContain('cr-fix.mjs --pr 31')
    expect(line).toMatch(NO_POST)
  })
})

describe('slot: the time-out line (M7)', () => {
  test('M7 the STALLED line of a timed-out queued PR names the reader, the head, fast mode and the READY rule', () => {
    const line = reportLine({ ...STALLED, slot: { position: 1, total: 1, state: 'timed-out' } })
    expect(line).toContain('principal-reviewer')
    expect(line).toContain(`head ${HEAD.slice(0, 7)}`)
    expect(line).toContain('not in fast mode')
    expect(line).toMatch(/READY still needs a CodeRabbit review/)
    expect(line).toMatch(NO_POST)
  })

  test('M7 a queued PR that has not timed out is not sent to the reader', () => {
    expect(reportLine({ ...STALLED, slot: QUEUED })).not.toContain('principal-reviewer')
  })
})

const STATUS: PrStatus = {
  pr: 31, head: HEAD, headShort: HEAD.slice(0, 7), branch: 'feat/x', ready: false, reasons: [], mergeable_state: 'clean', reviewedHead: false,
  unresolved: 0, rateLimited: false, prState: 'open', merged: false, isDraft: false, coderabbitLimited: null, coderabbitReviewedHead: false,
  coderabbitRounds: 0, coderabbitReviews: 0, coderabbitRequests: 0, routing: { required: ['coderabbit'], held: null, source: 'label' },
}
const APPLIED_AT = 1_000_000
const RECORD: CheckpointRecord = { pr: 31, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 1], decided_by: 'dave', session: 's', appliedAt: APPLIED_AT }
const MIN = 60_000

describe('slot: the opening ask beside the queue (M6)', () => {
  test('M6 with no queue the opening ask fires 31 minutes after the apply (control)', () => {
    expect(askFor(RECORD, STATUS, APPLIED_AT + 31 * MIN, null)?.kind).toBe('opening')
    expect(askFor(RECORD, STATUS, APPLIED_AT + 31 * MIN, null, false)?.kind).toBe('opening')
  })
  test('M6 a PR the queue holds gets no opening ask', () => {
    expect(askFor(RECORD, STATUS, APPLIED_AT + 31 * MIN, null, true)).toBeNull()
  })
})

const row = (extra: Partial<SlotRow> = {}): SlotRow => ({
  pr: 900, band: 'HIGH', state: 'queued', position: 1, total: 2, head7: 'aaaaaaa', queuedMin: 5, timeoutInMin: 55, nextSlotInMin: 12, posts: 0,
  asked: { paid30: false, timeout60: false }, ...extra,
})

describe('slot: the tick parser reads the CLI contract (P1, F20)', () => {
  for (const name of ['queued', 'posted', 'ask', 'timeout'] as const) {
    test(`P1 tick-${name}.json parses to the same rows and actions`, () => {
      const raw = JSON.parse(fixture(name))
      const tick = parseTick(fixture(name))
      expect(tick).not.toBeNull()
      if (!tick || !tick.ok) throw new Error('not ok')
      expect(tick.effective).toBe(raw.effective)
      expect(tick.actions).toEqual(raw.actions)
      expect(tick.rows.map((r: SlotRow) => r.pr)).toEqual(raw.rows.map((r: SlotRow) => r.pr))
    })
  }

  test('F20 every toast that asks Dave for a paid round or reports a time-out says Dave answers the question the session asks, and names no typed /slot command', () => {
    const asks = (['ask', 'timeout'] as const).flatMap(name => {
      const tick = parseTick(fixture(name))
      return tick && tick.ok ? tick.actions : []
    })
    expect(asks.length).toBe(2)
    for (const action of asks) {
      expect(action.text).toContain('Dave answers the question the session asks')
      expect(action.text).not.toContain('/slot')
    }
  })

  test('T1 toastText drops every "Type /slot ..." sentence and says Dave answers the question; a text with none is unchanged', () => {
    const note = 'Dave answers the question the session asks.'
    expect(toastText('PR #5: stuck. Type /slot drop 5 to remove it, or /slot wait 5 to try again.')).toBe(`PR #5: stuck. ${note}`)
    expect(toastText('PR #7: x. Paid round $2.75 (cr-paid ALLOW). Type /slot pay 7, or wait.')).toBe(`PR #7: x. Paid round $2.75 (cr-paid ALLOW). ${note}`)
    expect(toastText('PR #900: queued, 1 of 1. Next slot in about 12 minutes.')).toBe('PR #900: queued, 1 of 1. Next slot in about 12 minutes.')
  })

  test('P1 a failed tick ({ok:false, reason}) parses as a failure with its reason', () => {
    expect(parseTick('{"ok":false,"reason":"slot-queue: bad state file"}')).toEqual({ ok: false, reason: 'slot-queue: bad state file' })
  })

  test('P1 anything else is null, never a throw: empty, bad JSON, a non-object, no rows, a bad row, a bad action', () => {
    const good = JSON.parse(fixture('queued'))
    for (const text of ['', 'not json', '[]', 'null', '{"ok":true}', JSON.stringify({ ...good, rows: [{ pr: 'x' }] }), JSON.stringify({ ...good, actions: [{ kind: 'toast', pr: 1 }] }), JSON.stringify({ ...good, rows: 'x' })]) {
      expect(parseTick(text), text).toBeNull()
    }
  })

  test('P1 finished rows (done, dropped) are left out of the mod rows', () => {
    const good = JSON.parse(fixture('queued'))
    const rows = [row({ pr: 1, state: 'done' }), row({ pr: 2, state: 'dropped' }), row({ pr: 3 })]
    const tick = parseTick(JSON.stringify({ ...good, rows }))
    expect(tick && tick.ok ? tick.rows.map(r => r.pr) : null).toEqual([3])
  })
})

describe('slot: /slot arguments (P2)', () => {
  test('P2 no words and "list" list the queue', () => {
    expect(parseSlotArgs('')).toEqual({ kind: 'list' })
    expect(parseSlotArgs('  list ')).toEqual({ kind: 'list' })
  })
  test('P2 a write verb takes exactly one PR number, # allowed, verb in any case', () => {
    expect(parseSlotArgs('pay 5')).toEqual({ kind: 'pay', pr: 5 })
    expect(parseSlotArgs('WAIT #12')).toEqual({ kind: 'wait', pr: 12 })
    expect(parseSlotArgs('first 7')).toEqual({ kind: 'first', pr: 7 })
    expect(parseSlotArgs('drop 9')).toEqual({ kind: 'drop', pr: 9 })
  })
  test('P2 a typo, a missing or extra number, an unknown verb, a zero and "add" are usage errors, never a write', () => {
    for (const text of ['pay', 'pay x', 'pay 5 6', 'pay 0', 'pay -3', 'pay 5x', 'pya 5', 'add 5', 'decide 5', '5', 'list 5', 'pay 5 --force']) {
      expect(parseSlotArgs(text), text).toEqual({ kind: 'usage' })
    }
  })
})

describe('slot: the row text (P3)', () => {
  test('P3 slotOf finds a PR and answers null for another', () => {
    const rows = [row({ pr: 1 }), row({ pr: 2 })]
    expect(slotOf(rows, 2)?.pr).toBe(2)
    expect(slotOf(rows, 3)).toBeNull()
  })

  test('P3 each state reads differently and names its position, wait or next step', () => {
    const lines = new Map<string, string>()
    for (const state of ['opening', 'awaiting-fix', 'queued', 'posted', 'timed-out', 'stuck']) lines.set(state, slotLine(row({ state, position: state === 'posted' ? null : 2 })))
    expect(new Set(lines.values()).size).toBe(6)
    expect(lines.get('queued')).toMatch(/2 of 2/)
    expect(lines.get('queued')).toMatch(/12 min/)
    expect(lines.get('timed-out')).toMatch(/60 min/)
    expect(lines.get('stuck')).toMatch(/pr_checkpoint 900/)
    expect(lines.get('opening')).toMatch(/label review/)
  })

  test('P3 no row text, and no question of the queue, tells Dave to type a /slot verb (Dave 2026-11-06: every decision is a tap)', () => {
    const typed = /\/slot (pay|wait|drop|first)/i
    for (const state of ['opening', 'awaiting-fix', 'queued', 'posted', 'timed-out', 'stuck', 'done', 'dropped']) expect(slotLine(row({ state })), state).not.toMatch(typed)
    for (const name of ['ask', 'timeout'] as const) {
      const tick = parseTick(TICKS[name])
      const asks = tick && tick.ok ? tick.actions.flatMap(action => slotAskOf(action) ?? []) : []
      expect(asks.length, name).toBe(1)
      const spec = slotAskSpec(asks[0]!)
      expect(spec.question, name).not.toMatch(typed)
      for (const choice of spec.choices) expect(choice.label, name).not.toMatch(typed)
    }
  })

  test('P3 the Pay row follows what the CLI text says: ALLOW, a failed read and the 60 minute time-out offer it; ESCALATE does not', () => {
    const action = (text: string) => ({ kind: 'toast' as const, pr: 5, text })
    const canPay = (text: string) => slotAskOf(action(text))?.canPay
    expect(canPay('PR #5: no free slot for 30 minutes. Paid round $2.75 (cr-paid ALLOW). Type /slot pay 5, or wait.')).toBe(true)
    expect(canPay('PR #5: no free slot for 30 minutes. The paid-round check could not be read (no answer). Type /slot pay 5 to try it again, or /slot wait 5 to keep waiting.')).toBe(true)
    expect(canPay('PR #5: no free slot for 60 minutes; still queued; READY still needs a CodeRabbit review. Type /slot pay 5 or /slot wait 5.')).toBe(true)
    expect(canPay('PR #5: no free slot for 30 minutes. A paid round is not allowed (over the day cap). Type /slot wait 5 to keep waiting.')).toBe(false)
    expect(slotAskOf(action('PR #5: no free slot for 30 minutes. Paid round $2.75 (cr-paid ALLOW). Type /slot pay 5, or wait.'))?.cost).toBe('$2.75')
    expect(slotAskOf(action('PR #5: queued 1 of 2.'))).toBeNull()
  })

  test('P3 a free slot says so instead of "about 0 minutes"', () => {
    expect(slotLine(row({ nextSlotInMin: 0 }))).toMatch(/free now/)
    expect(slotLine(row({ nextSlotInMin: 0 }))).not.toMatch(/0 min/)
  })

  test('P3 rowsText lists every row with its PR, band and state; an empty queue says so', () => {
    const text = rowsText([row({ pr: 901, band: 'CRITICAL', position: 1 }), row({ pr: 900, position: 2 })])
    expect(text).toContain('#901')
    expect(text).toContain('CRITICAL')
    expect(text).toContain('#900')
    expect(text.indexOf('#901')).toBeLessThan(text.indexOf('#900'))
    expect(rowsText([])).toMatch(/empty/i)
  })

  test('P3 alertSlot gives a queue PR its position and none to a PR the queue does not hold', () => {
    expect(alertSlot(row({ state: 'queued', position: 2, total: 3 }))).toEqual({ position: 2, total: 3, state: 'queued' })
    expect(alertSlot(row({ state: 'timed-out' }))?.state).toBe('timed-out')
    expect(alertSlot(row({ state: 'opening' }))).toBeUndefined()
    expect(alertSlot(row({ state: 'done' }))).toBeUndefined()
    expect(alertSlot(null)).toBeUndefined()
  })

  test('P3 the status text and the watch line carry the queue row, and are unchanged without one', () => {
    const plain = statusText(STATUS)
    expect(statusText(STATUS, row({ pr: 31 }))).toContain('Free-slot queue:')
    expect(statusText(STATUS, row({ pr: 31 }))).toContain(slotLine(row({ pr: 31 })))
    expect(plain).not.toContain('Free-slot queue')
    const watch = { pr: 31, state: 'LIMITED' as const, whenReady: false }
    expect(watchLine(watch)).toBe('#31 LIMITED')
    expect(watchLine(watch, row({ pr: 31 }))).toContain(slotLine(row({ pr: 31 })))
  })
})

describe('slot: the list parser (P4)', () => {
  const list = (rows: unknown[]) => JSON.stringify({ ok: true, rows, nextSlotInMin: 12 })
  test('P4 a good list parses; finished rows are left out', () => {
    const parsed = parseList(list([row({ pr: 1, state: 'done' }), row({ pr: 2 })]))
    expect(parsed && parsed.ok ? parsed.rows.map(r => r.pr) : null).toEqual([2])
  })
  test('P4 a failure parses with its reason; any other text is null, never a throw', () => {
    expect(parseList('{"ok":false,"reason":"slot-queue: bad state file"}')).toEqual({ ok: false, reason: 'slot-queue: bad state file' })
    for (const text of ['', 'not json', '[]', '{"ok":true}', list([{ pr: 'x' }])]) expect(parseList(text), text).toBeNull()
  })
})

// ---- the mod wiring: one engine world per test --------------------------------------------------------------------------------

const SESSION = 'test-session'
const KEY = `pr-watch:${SESSION}`
const TICK = 300_000
const NOW = 1_000_000
const HOME = 'C:/home'
const SCRIPT = `${HOME}/continuous-claude/scripts/github/slot-queue.mjs`
const STATE_FILE = `${HOME}/.claude/state/coderabbit-slot.json`
/** The head a fresh `cr-paid.mjs check` reports: the head Dave's price was read at. The Pay verb must carry it (--head). */
const PAYHEAD = '5'.repeat(40)
const ACTIVE = JSON.stringify({ version: 1, items: [{ pr: 900, state: 'queued' }] })
const DONE = JSON.stringify({ version: 1, items: [{ pr: 900, state: 'done' }, { pr: 901, state: 'dropped' }] })

type Reply = { code?: number; out: string }
type LoopOpts = {
  /** The state file text. null: the file is missing. undefined: the world has no fs.read handler at all. */
  file?: string | null
  /** What `tick` prints, in order; the last one repeats. */
  ticks?: Reply[]
  cli?: Partial<Record<'list' | 'decide' | 'drop', Reply>>
  /** What a fresh `cr-paid.mjs check --pr N --json` prints. Unset: an ALLOW of 11 files (total 11, $2.75). */
  check?: Reply
  statuses?: Record<number, Record<string, unknown>>
  store?: Record<string, unknown>
  /** How Dave answers the dialog the mod raises ($.ui.ask). Unset: no one answers, and the engine has no AskUserQuestion bottom (the dialog fails closed). */
  answer?: string | RegExp | 'dismiss'
}

const loopWorld = (on: On, opts: LoopOpts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: HOME })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const seen = { paid: [] as string[][], slot: [] as { argv: string[]; script: string; cwd?: string }[], status: [] as number[], toasts: [] as string[], submits: [] as string[], dialogs: [] as { question: string; labels: string[] }[], comments: [] as string[][] }
  if (opts.answer !== undefined) {
    const answer = opts.answer
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      const q = (e as unknown as { questions: { question: string; options: ({ label: string } | string)[] }[] }).questions[0]!
      const labels = q.options.map(one => (typeof one === 'string' ? one : one.label))
      seen.dialogs.push({ question: q.question, labels })
      if (answer === 'dismiss') return { deny: 'dismissed' }
      const text = answer instanceof RegExp ? labels.find(l => answer.test(l)) : answer
      if (text === undefined) throw new Error(`no label matches in ${JSON.stringify(labels)}`)
      return { result: { questions: [], answers: { [q.question]: text } } } as never
    })
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('tool.list', () => ({ value: [] as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  const file = opts.file
  if (file !== undefined) {
    on('fs.read', (_$, e) => {
      if (file === null || e.path.replace(/\\/g, '/') !== STATE_FILE) throw new Error(`ENOENT ${e.path}`)
      return { value: file }
    })
  }
  const ticks = [...(opts.ticks ?? [{ out: TICKS.queued }])]
  const result = (reply: Reply) => ({ value: { exitCode: reply.code ?? 0, stdout: reply.out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv.some(part => part.includes('slot-queue.mjs'))) {
      seen.slot.push({ argv: argv.slice(2), script: argv[1] ?? '', cwd: (e.init as { cwd?: string } | undefined)?.cwd })
      const verb = argv[2] ?? ''
      if (verb === 'tick') return result((ticks.length > 1 ? ticks.shift() : ticks[0]) ?? { out: '' })
      return result(opts.cli?.[verb as 'list' | 'decide' | 'drop'] ?? { out: '{"ok":true}' })
    }
    if (argv.some(part => part.includes('cr-paid.mjs'))) {
      seen.paid.push(argv.slice(2))
      return result(opts.check ?? { out: `{"exitCode":0,"verdict":"ALLOW","pr":901,"head":"${PAYHEAD}","files":11,"total":11,"cost":2.75}` })
    }
    if (argv.some(part => part.includes('review-status.mjs'))) {
      const pr = Number(argv.find(part => /^\d+$/.test(part)))
      seen.status.push(pr)
      const one = { ...STATUS, pr, ...(opts.statuses?.[pr] ?? {}) }
      return result({ code: 1, out: JSON.stringify(one) })
    }
    if (argv[0] === 'gh') seen.comments.push(argv)
    return result({ out: '[]' })
  })
  return { clock, seen, store }
}

const startLoop = ($: Engine, isInteractive = true) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })
const watched = (...prs: number[]) => ({ [KEY]: { prs: prs.map(pr => ({ pr, state: null, whenReady: false })), backoffUntil: 0, touched: NOW } })
const command = ($: Engine, name: string, args: string, origin: { kind: string } = { kind: 'composer' }) =>
  $.command.run({ command: name, args, origin: (origin.kind === 'plugin' ? { kind: 'plugin', name: 'other-mod' } : origin) as never, presentation: { isFullscreen: false, columns: 100 } })
const ticksOf = (w: { seen: { slot: { argv: string[] }[] } }) => w.seen.slot.filter(run => run.argv[0] === 'tick')
const FAIL: Reply = { code: 2, out: '{"ok":false,"reason":"slot-queue: bad state file"}' }
const NO_ACTIONS: Reply = { out: JSON.stringify({ ...JSON.parse(TICKS.queued), actions: [] }) }

/** Valid JSON that slot-queue-model.mjs parseState refuses: a root that is not a plain object, a wrong version, no items list. */
const BAD_ROOTS: [string, string][] = [
  ['null', 'null'], ['an array', '[]'], ['a number', '5'], ['a string', '"x"'],
  ['an object with no items list', '{"version":1}'], ['an object whose items is not a list', '{"version":1,"items":{}}'],
  ['an object with no version', '{"items":[]}'], ['an object with a wrong version', '{"version":2,"items":[]}'],
]

describe('slot: the tick runs only for a live queue (M1)', () => {
  for (const [name, file] of [['no state file', null], ['only finished items', DONE], ['an empty item list', '{"version":1,"items":[]}'], ['no fs.read handler at all', undefined]] as const) {
    test(`M1 ${name}: three timer ticks start no slot-queue process, and the watcher still runs`, async ($, on) => {
      const w = loopWorld(on, { file, store: watched(900) })
      await startLoop($)
      for (let i = 0; i < 3; i += 1) await w.clock.advance(TICK)
      expect(w.seen.slot).toEqual([])
      expect(w.seen.status.length).toBe(3)
    })
  }

  // Breaks if hasLiveItem reads a valid-JSON file that parseState would refuse (null, [], a number, a string, no items array, a wrong
  // version) as idle: the tick then never runs and nobody sees the CLI report the bad state file.
  for (const [name, file] of BAD_ROOTS) {
    test(`M1 a state file that is ${name} fails closed: the tick runs so the CLI reports it`, async ($, on) => {
      const w = loopWorld(on, { file, ticks: [FAIL], store: watched(900) })
      await startLoop($)
      await w.clock.advance(TICK)
      expect(ticksOf(w).length).toBe(1)
    })
  }

  test('M1 a live item runs `tick` from the home checkout, each period, even with an empty watch list', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE })
    await startLoop($)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(ticksOf(w).map(run => run.argv)).toEqual([['tick', '--session', SESSION, '--json'], ['tick', '--session', SESSION, '--json']])
    expect(w.seen.slot[0]!.script).toBe(SCRIPT)
    expect(w.seen.slot[0]!.cwd).toBe(`${HOME}/continuous-claude`)
    expect(w.seen.status).toEqual([])
  })

  test('M1 a state file that is not JSON still ticks, so the failure reaches Dave', async ($, on) => {
    const w = loopWorld(on, { file: '{broken', ticks: [FAIL] })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(ticksOf(w).length).toBe(1)
  })
})

describe('slot: the tick delivers (M2, M5, F17)', () => {
  test('M2 each action of the tick is one toast with the CLI text', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }] })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.toasts).toEqual(['PR #901: no free slot for 30 minutes. Paid round $2.75 (cr-paid ALLOW). Dave answers the question the session asks, or the item keeps waiting.'])
    expect(w.seen.toasts[0]).not.toContain('/slot')
  })

  test('M2 a tick with no action gives no toast, and the rows reach /watch', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [NO_ACTIONS], store: watched(900) })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.toasts).toEqual([])
    const listed = await command($, 'watch', '')
    expect(listed.text ?? '').toContain('[queue: queued 1 of 1')
  })

  test('F17 a session that starts after the time-out toasts it at its first tick', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.timeout }] })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.toasts).toEqual(['PR #900: no free slot for 60 minutes; still queued; READY still needs a CodeRabbit review. Dave answers the question the session asks: pay or keep waiting.'])
    expect(w.seen.toasts[0]).not.toContain('/slot')
  })

  test('M5 two failed ticks in a row give one toast; a good tick between them resets the count', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [FAIL, NO_ACTIONS, FAIL, FAIL] })
    await startLoop($)
    for (let i = 0; i < 3; i += 1) await w.clock.advance(TICK)
    expect(w.seen.toasts).toEqual([])
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(w.seen.toasts.length).toBe(1)
    expect(w.seen.toasts[0]).toContain('slot-queue: bad state file')
    expect(w.seen.toasts[0]).toContain('The queue could not be read twice. Dave answers the question the session asks.')
    expect(w.seen.toasts[0]).not.toContain('/slot')
  })

  test('M5 a tick with no output at all is a failure too', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ code: 1, out: '' }] })
    await startLoop($)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(w.seen.toasts.length).toBe(1)
  })
})

const LIST_OUT = JSON.stringify({ ok: true, rows: [row({ pr: 900 })], nextSlotInMin: 12 })

describe('slot: /slot (M3, M4)', () => {
  test('M4 list runs `list --json` and prints the rows; a bridge origin may list', async ($, on) => {
    const w = loopWorld(on, { cli: { list: { out: LIST_OUT } } })
    await startLoop($)
    const ran = await command($, 'slot', '', { kind: 'bridge' })
    expect(w.seen.slot.map(run => run.argv)).toEqual([['list', '--json']])
    expect(ran.text ?? '').toContain('#900')
  })

  test('M4 a list the CLI cannot give says so', async ($, on) => {
    loopWorld(on, { cli: { list: { code: 2, out: '' } } })
    await startLoop($)
    expect((await command($, 'slot', 'list')).text ?? '').toMatch(/could not/i)
  })

  // Paid guard: a typed /slot pay opens the priced dialog; Dave's tap on "Pay up to $X" is the cap (--cap X) that the CLI enforces.
  test('M4 pay runs decide --kind pay --cap X after the priced dialog and shows that it posted', async ($, on) => {
    const w = loopWorld(on, { answer: /^Pay up to/, cli: { decide: { out: '{"ok":true,"verdict":"ALLOW","cost":2.75,"files":3,"posted":true}' } } })
    await startLoop($)
    const ran = await command($, 'slot', 'pay 5')
    expect(w.seen.paid).toEqual([['check', '--pr', '5', '--json']])
    expect(w.seen.dialogs[0]!.labels).toContain('Pay up to $2.75')
    expect(w.seen.slot.map(run => run.argv)).toEqual([['decide', '--pr', '5', '--kind', 'pay', '--head', PAYHEAD, '--cap', '2.75', '--json']])
    expect(ran.text ?? '').toMatch(/#5.*posted/i)
  })

  // F6: the price and the head come from ONE fresh check. A check that names no head (or a bad one) offers no price, so no dialog and no decide.
  test('M4c a fresh check that names no head, or a bad one, offers no paid round: no dialog, no decide', async ($, on) => {
    for (const out of [
      '{"exitCode":0,"verdict":"ALLOW","pr":5,"files":11,"total":11,"cost":2.75}',
      `{"exitCode":0,"verdict":"ALLOW","pr":5,"head":"${'A'.repeat(40)}","files":11,"total":11,"cost":2.75}`,
      '{"exitCode":0,"verdict":"ALLOW","pr":5,"head":"abc1234","files":11,"total":11,"cost":2.75}',
    ]) {
      const w = loopWorld(on, { answer: /^Pay up to/, check: { out } })
      await startLoop($)
      expect((await command($, 'slot', 'pay 5')).text ?? '').toMatch(/no paid round is offered/i)
      expect(w.seen.dialogs).toEqual([])
      expect(w.seen.slot).toEqual([])
    }
  })

  test('M4b a typed /slot pay with no answer to the dialog, or with no price, runs no decide', async ($, on) => {
    const quiet = loopWorld(on, { answer: 'dismiss' })
    await startLoop($)
    expect((await command($, 'slot', 'pay 5')).text ?? '').toMatch(/nothing was posted/i)
    expect(quiet.seen.slot).toEqual([])
  })

  test('M4 pay answered ESCALATE shows the reasons and says nothing was posted', async ($, on) => {
    loopWorld(on, { answer: /^Pay up to/, cli: { decide: { code: 3, out: '{"ok":false,"verdict":"ESCALATE","reasons":["over the day cap"],"posted":false}' } } })
    await startLoop($)
    const text = (await command($, 'slot', 'pay 5')).text ?? ''
    expect(text).toContain('ESCALATE')
    expect(text).toContain('over the day cap')
    expect(text).toMatch(/nothing posted/i)
  })

  test('M4 wait, first and drop each run their CLI verb', async ($, on) => {
    const w = loopWorld(on)
    await startLoop($)
    for (const args of ['wait #6', 'FIRST 7', 'drop 9']) await command($, 'slot', args)
    expect(w.seen.slot.map(run => run.argv)).toEqual([
      ['decide', '--pr', '6', '--kind', 'wait', '--json'],
      ['decide', '--pr', '7', '--kind', 'first', '--json'],
      ['drop', '--pr', '9', '--reason', 'dave', '--json'],
    ])
  })

  test('M4 a typo runs nothing and shows the usage', async ($, on) => {
    const w = loopWorld(on)
    await startLoop($)
    expect((await command($, 'slot', 'pya 5')).text ?? '').toMatch(/usage/i)
    expect(w.seen.slot).toEqual([])
  })

  for (const origin of [{ kind: 'bridge' }, { kind: 'plugin' }]) {
    test(`M3 a ${origin.kind} origin writes nothing`, async ($, on) => {
      const w = loopWorld(on)
      await startLoop($)
      for (const args of ['pay 5', 'wait 5', 'first 5', 'drop 5']) expect((await command($, 'slot', args, origin)).text ?? '', args).toMatch(/Dave/)
      expect(w.seen.slot).toEqual([])
    })
  }

  test('M3 a headless session writes nothing even from a composer origin', async ($, on) => {
    const w = loopWorld(on)
    await startLoop($, false)
    expect((await command($, 'slot', 'pay 5')).text ?? '').toMatch(/interactive|Dave/)
    expect(w.seen.slot).toEqual([])
  })
})

describe('slot: the alert and the ask see the queue (A1, A2)', () => {
  const HEAD_A = 'a'.repeat(40)
  const LIMITED = {
    routedReviewed: false, coderabbitLimited: true, coderabbitRateLimited: true, coderabbitRetryMinutes: 40, coderabbitRounds: 1,
    reasons: ['CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)'],
  }
  const seeded = { [KEY]: { prs: [{ pr: 900, state: 'PENDING', whenReady: false, head: HEAD_A, since: NOW - 60_000 }], backoffUntil: 0, touched: NOW } }

  test('A1 without the queue the rate-limit line tells the model to post (control)', async ($, on) => {
    const w = loopWorld(on, { file: null, store: seeded, statuses: { 900: LIMITED } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.submits.length).toBe(1)
    expect(w.seen.submits[0]).toMatch(FORBIDDEN)
  })

  test('A1 a queued PR keeps the queue after the re-probe: the line says do not post', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [NO_ACTIONS], store: seeded, statuses: { 900: LIMITED } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.submits.length).toBe(1)
    expect(w.seen.submits[0]).toMatch(NO_POST)
    expect(w.seen.submits[0]).not.toMatch(FORBIDDEN)
  })

  const record = { pr: 900, state: 'applied', head: HEAD_A, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default', session: SESSION, appliedAt: NOW - 31 * 60_000 }
  const QUIET = { routedReviewed: false, coderabbitRounds: 0, coderabbitRequests: 0, reasons: ['no CodeRabbit PR-bot review of the head commit'] }
  const asksIn = (store: Map<string, unknown>) => ((store.get(`checkpoint:asks:${SESSION}`) ?? []) as { kind: string }[]).map(ask => ask.kind)

  test('A2 without the queue the opening ask is queued 31 minutes after the apply (control)', async ($, on) => {
    const w = loopWorld(on, { file: null, store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(asksIn(w.store)).toEqual(['opening'])
  })

  test('A2 a PR the queue holds gets no opening ask', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [NO_ACTIONS], store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(asksIn(w.store)).toEqual([])
  })

  // M1. Breaks if queueHolds counts only the HELD states: an `opening` row (the item waits in the queue for the label review) then gives
  // askFor inQueue false, the 30-minute opening ask fires, and a Yes posts outside the queue lock beside a tick in another session.
  test('M1 a PR whose queue row is `opening` gets no opening ask (the wiring, not the boolean)', async ($, on) => {
    const opening = JSON.stringify({ ...JSON.parse(TICKS.queued), actions: [], rows: [row({ pr: 900, state: 'opening', position: null, total: 0 })] })
    const file = JSON.stringify({ version: 1, items: [{ pr: 900, state: 'opening' }] })
    const w = loopWorld(on, { file, ticks: [{ out: opening }], store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(asksIn(w.store)).toEqual([])
  })

  // Breaks if queueHolds reads only the row cache: with every tick failed the cache stays empty, the state file still lists the PR,
  // and the 30-minute opening ask then fires and a Yes posts outside the queue lock.
  test('M1 a PR the state file lists gets no opening ask when every tick failed (no cached row)', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [FAIL], store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(asksIn(w.store)).toEqual([])
  })

  // Breaks if fileHolds reads a state file that parseState would refuse as "holds nothing": the opening ask then fires beside a queue
  // that may hold the PR, and a Yes posts outside the queue lock.
  for (const [name, file] of BAD_ROOTS) {
    test(`M1 a state file that is ${name} counts as holding the PR: no opening ask when every tick failed`, async ($, on) => {
      const w = loopWorld(on, { file, ticks: [FAIL], store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
      await startLoop($)
      await w.clock.advance(TICK)
      expect(asksIn(w.store)).toEqual([])
    })
  }

  // Control: breaks if the file fallback counts a finished item as held.
  test('M1 a PR the state file lists only as done still gets the opening ask when every tick failed', async ($, on) => {
    const done = JSON.stringify({ version: 1, items: [{ pr: 900, state: 'done' }, { pr: 901, state: 'queued' }] })
    const w = loopWorld(on, { file: done, ticks: [FAIL], store: { ...seeded, 'checkpoint:pr:900': record }, statuses: { 900: QUIET } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(asksIn(w.store)).toEqual(['opening'])
  })
})

describe('slot: /slot pay failures tell the truth (M3)', () => {
  const PAID_FAIL = '{"ok":false,"reason":"the paid post failed (HTTP 502); the round is counted and the item is marked posted"}'

  // Breaks if the failure text always ends "Nothing was changed.": a failed paid POST leaves a ledger row and a posted item.
  test('M3 a pay that fails after the round was counted does not say nothing was changed', async ($, on) => {
    loopWorld(on, { cli: { decide: { code: 2, out: PAID_FAIL } } })
    await startLoop($)
    const text = (await command($, 'slot', 'pay 5')).text ?? ''
    expect(text).toContain('the round is counted')
    expect(text).not.toMatch(/Nothing was changed/)
  })

  test('M3 a refused wait still says nothing was changed', async ($, on) => {
    loopWorld(on, { cli: { decide: { code: 2, out: '{"ok":false,"reason":"PR 5 is posted"}' } } })
    await startLoop($)
    expect((await command($, 'slot', 'wait 5')).text ?? '').toMatch(/Nothing was changed/)
  })
})

// T17 and the time-out: the free-slot queue asks in the session (design 3.3). The CLI decides: it posts a paid round only on ALLOW.
// S1  a paid ask or a time-out is only a toast Dave cannot answer from the phone
// S2  Pay posts without cr-paid ALLOW (the mod posts itself, or ignores the CLI's ESCALATE)
// S3  Esc, a wrong label or text typed under Other pays, waits or drops
// S4  the answer runs another verb than its label says
describe('slot: the paid ask and the time-out are dialogs (T17)', () => {
  const WAIT_OUT = JSON.stringify({ ...JSON.parse(TICKS.timeout) })

  test('S1 the 30 minute paid ask raises one dialog: the recommendation first, the dollar figure of cr-paid in the Pay label, the toast stays', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: 'dismiss' })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.toasts).toEqual(['PR #901: no free slot for 30 minutes. Paid round $2.75 (cr-paid ALLOW). Dave answers the question the session asks, or the item keeps waiting.'])
    expect(w.seen.dialogs.length).toBe(1)
    const [dialog] = w.seen.dialogs
    expect(dialog!.question).toContain('#901')
    expect(dialog!.labels.length).toBeGreaterThanOrEqual(2)
    expect(dialog!.labels.length).toBeLessThanOrEqual(4)
    expect(dialog!.labels.find(label => /^Pay/.test(label))).toContain('$2.75')
    expect(dialog!.labels.filter(label => /\(Recommended\)$/.test(label)).length).toBe(1)
    expect(dialog!.labels[0]).toMatch(/\(Recommended\)$/)
    expect(dialog!.labels.some(label => /^Keep waiting/.test(label))).toBe(true)
    expect(dialog!.labels.some(label => /^Drop from queue/.test(label))).toBe(true)
  })

  test('S2 Pay runs the same decide verb as /slot pay; an ESCALATE from the CLI posts nothing and says so', async ($, on) => {
    const w = loopWorld(on, {
      file: ACTIVE,
      ticks: [{ out: TICKS.ask }],
      answer: /^Pay/,
      cli: { decide: { code: 3, out: '{"ok":false,"verdict":"ESCALATE","reasons":["over the day cap"],"posted":false}' } },
    })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.slot.filter(run => run.argv[0] === 'decide').map(run => run.argv)).toEqual([['decide', '--pr', '901', '--kind', 'pay', '--head', PAYHEAD, '--cap', '2.75', '--json']])
    expect(w.seen.toasts.some(text => /ESCALATE/.test(text) && /Nothing posted/.test(text))).toBe(true)
    expect(w.seen.comments).toEqual([])
  })

  // Paid guard (card prflow-paid-run-guard): the Pay label carries a FRESH price and that price is the cap.
  test('S7 the Pay label and the --cap come from a fresh cr-paid check (the unfiltered file count), not from the toast text', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: /^Pay/, check: { out: `{"exitCode":0,"verdict":"ALLOW","pr":901,"head":"${PAYHEAD}","files":4,"total":14,"cost":1}` } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.paid).toEqual([['check', '--pr', '901', '--json']])
    expect(w.seen.dialogs[0]!.labels.find(label => /^Pay/.test(label))).toBe('Pay up to $3.50')
    expect(w.seen.slot.filter(run => run.argv[0] === 'decide').map(run => run.argv)).toEqual([['decide', '--pr', '901', '--kind', 'pay', '--head', PAYHEAD, '--cap', '3.50', '--json']])
  })

  for (const [name, check] of [
    ['an ESCALATE', { out: '{"exitCode":3,"verdict":"ESCALATE","pr":901,"files":30,"total":30,"reasons":["x"]}', code: 3 }],
    ['an unreadable answer', { out: 'not json', code: 2 }],
    ['an old script with no file total', { out: '{"exitCode":0,"verdict":"ALLOW","pr":901,"files":4,"cost":1}' }],
    ['0 files', { out: '{"exitCode":0,"verdict":"ALLOW","pr":901,"files":0,"total":0,"cost":0}' }],
  ] as const) {
    test(`S8 no price, no Pay row: ${name} offers Keep waiting and Drop only, and says no price is known`, async ($, on) => {
      const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: 'dismiss', check })
      await startLoop($)
      await w.clock.advance(TICK)
      expect(w.seen.dialogs[0]!.labels.some(label => /^Pay/.test(label))).toBe(false)
      expect(w.seen.dialogs[0]!.question).toMatch(/No price is known|not allowed/)
    })
  }

  test('S9 the Pay row asks for no price when the CLI offered no paid round (ESCALATE toast): no cr-paid check runs', async ($, on) => {
    const escalate = JSON.stringify({ ...JSON.parse(TICKS.ask), actions: [{ kind: 'toast', pr: 901, text: 'PR #901: no free slot for 30 minutes. A paid round is not allowed (over the day cap). The item keeps waiting.' }] })
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: escalate }], answer: 'dismiss' })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.paid).toEqual([])
    expect(w.seen.dialogs[0]!.labels.some(label => /^Pay/.test(label))).toBe(false)
  })

  test('S2b Pay on an ALLOW says the paid review is posted', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: /^Pay/, cli: { decide: { out: '{"ok":true,"verdict":"ALLOW","posted":true}' } } })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.toasts.some(text => /PR #901: the paid review is posted\./.test(text))).toBe(true)
  })

  for (const answer of ['dismiss', 'pay 901', 'Pay']) {
    test(`S3 the answer ${JSON.stringify(answer)} (Esc, or text that is not a label) runs no verb`, async ($, on) => {
      const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer })
      await startLoop($)
      await w.clock.advance(TICK)
      expect(w.seen.slot.filter(run => run.argv[0] !== 'tick')).toEqual([])
    })
  }

  test('S4 Keep waiting runs decide --kind wait and Drop from queue runs drop --reason dave', async ($, on) => {
    const wait = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: /^Keep waiting/ })
    await startLoop($)
    await wait.clock.advance(TICK)
    expect(wait.seen.slot.filter(run => run.argv[0] !== 'tick').map(run => run.argv)).toEqual([['decide', '--pr', '901', '--kind', 'wait', '--json']])
  })

  test('S4b Drop from queue runs drop --reason dave', async ($, on) => {
    const drop = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.ask }], answer: /^Drop from queue/ })
    await startLoop($)
    await drop.clock.advance(TICK)
    expect(drop.seen.slot.filter(run => run.argv[0] !== 'tick').map(run => run.argv)).toEqual([['drop', '--pr', '901', '--reason', 'dave', '--json']])
  })

  test('S5 the 60 minute time-out is a dialog too: Pay and Keep waiting, no figure when the toast names none', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: WAIT_OUT }], answer: 'dismiss' })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs.length).toBe(1)
    expect(w.seen.dialogs[0]!.question).toContain('#900')
    expect(w.seen.dialogs[0]!.question).toMatch(/60 minutes/)
    expect(w.seen.dialogs[0]!.labels.some(label => /^Pay/.test(label))).toBe(true)
    expect(w.seen.dialogs[0]!.labels.some(label => /^Keep waiting/.test(label))).toBe(true)
  })

  test('S6 a tick with no ask raises no dialog', async ($, on) => {
    const w = loopWorld(on, { file: ACTIVE, ticks: [{ out: TICKS.queued }], answer: /^Pay/ })
    await startLoop($)
    await w.clock.advance(TICK)
    expect(w.seen.dialogs).toEqual([])
  })
})
