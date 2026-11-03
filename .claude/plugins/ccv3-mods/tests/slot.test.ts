import { describe, expect, test } from 'claude-code/testing'

import { TICKS } from './fixtures/slot-queue-ticks'
import { askFor, reportLine, statusText, watchLine } from '../hooks/pr-loop/model'
import type { Alert, PrStatus } from '../hooks/pr-loop/model'
import { alertSlot, parseSlotArgs, parseTick, rowsText, slotLine, slotOf } from '../hooks/pr-loop/slot-model'
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
  checkpoint: { budget: [1, 1], rounds: 0, granted: null, declined: null },
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
    const carry = alert({ rateLimit: { minutes: 12 }, reasons: ['no CodeRabbit PR-bot review of the head commit; the earlier review carries once cr-fix is pasted'], checkpoint: { budget: [1, 1], rounds: 1, granted: null, declined: null }, slot: QUEUED })
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

  test('F20 every toast that asks Dave for a paid round or reports a time-out names /slot <verb> <pr>', () => {
    const asks = (['ask', 'timeout'] as const).flatMap(name => {
      const tick = parseTick(fixture(name))
      return tick && tick.ok ? tick.actions : []
    })
    expect(asks.length).toBe(2)
    for (const action of asks) expect(action.text).toMatch(new RegExp(`/slot (pay|wait) ${action.pr}\\b`))
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
    expect(lines.get('stuck')).toMatch(/\/slot drop 900/)
    expect(lines.get('opening')).toMatch(/label review/)
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
