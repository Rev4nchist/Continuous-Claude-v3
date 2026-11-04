import type { SlotAction, SlotRow, SlotTick } from '../../types'

// The free-slot queue as the mod sees it (pure). The CLI is scripts/github/slot-queue.mjs; its tick output is pinned by
// scripts/github/fixtures/slot-queue/tick-*.json, and tests/slot.test.ts reads a copy of them.

/** What a model line needs from the queue row of a PR: where it stands and in which state. */
export type AlertSlot = { position: number | null; total: number; state: string }

/** The states in which the queue holds a PR, so the model must not post for it. `opening` and the finished states are not. */
const HELD = new Set(['awaiting-fix', 'queued', 'posted', 'timed-out', 'stuck'])
const FINISHED = new Set(['done', 'dropped'])

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isNumOrNull = (value: unknown): boolean => value === null || isNum(value)

const isRow = (value: unknown): value is SlotRow => {
  if (!isObject(value) || !Number.isInteger(value.pr) || typeof value.band !== 'string' || typeof value.state !== 'string') return false
  if (!isNumOrNull(value.position) || !isNum(value.total) || typeof value.head7 !== 'string') return false
  if (!isNumOrNull(value.queuedMin) || !isNumOrNull(value.timeoutInMin) || !isNum(value.nextSlotInMin) || !isNum(value.posts)) return false
  const asked = value.asked
  return isObject(asked) && typeof asked.paid30 === 'boolean' && typeof asked.timeout60 === 'boolean'
}

const isAction = (value: unknown): value is SlotAction =>
  isObject(value) && value.kind === 'toast' && Number.isInteger(value.pr) && typeof value.text === 'string'

const goodTick = (v: Record<string, unknown>): SlotTick | null => {
  const { actions, rows } = v
  if (typeof v.effective !== 'boolean' || typeof v.locked !== 'boolean' || !Array.isArray(actions) || !Array.isArray(rows)) return null
  if (!actions.every(isAction) || !rows.every(isRow)) return null
  const next = isNum(v.nextSlotInMin) ? v.nextSlotInMin : null
  return { ok: true, effective: v.effective, locked: v.locked, actions, rows: rows.filter(row => !FINISHED.has(row.state)), nextSlotInMin: next }
}

/**
 * The CLI's tick JSON, or null when it has not the shape the mod reads. `{ ok: false, reason }` (the CLI's exit 2) parses as a failure.
 * Finished rows (done, dropped) are left out: the mod shows what is live. Never throws.
 */
export const parseTick = (stdout: string): SlotTick | null => {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isObject(parsed)) return null
    if (parsed.ok === false) return typeof parsed.reason === 'string' ? { ok: false, reason: parsed.reason } : null
    return parsed.ok === true ? goodTick(parsed) : null
  } catch {
    return null
  }
}

export type SlotList = { ok: true; rows: SlotRow[] } | { ok: false; reason: string }

/** The `list --json` output: its live rows, or `{ ok: false, reason }`. Null when the text has not the shape. Never throws. */
export const parseList = (stdout: string): SlotList | null => {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isObject(parsed)) return null
    if (parsed.ok === false) return typeof parsed.reason === 'string' ? { ok: false, reason: parsed.reason } : null
    if (parsed.ok !== true || !Array.isArray(parsed.rows) || !parsed.rows.every(isRow)) return null
    return { ok: true, rows: parsed.rows.filter(row => !FINISHED.has(row.state)) }
  } catch {
    return null
  }
}

export const slotOf = (rows: SlotRow[], pr: number): SlotRow | null => rows.find(row => row.pr === pr) ?? null

/** The position and state a model line needs, or undefined when the queue does not hold the PR. */
export const alertSlot = (row: SlotRow | null | undefined): AlertSlot | undefined =>
  row && HELD.has(row.state) ? { position: row.position, total: row.total, state: row.state } : undefined

const place = (row: SlotRow): string => (row.position === null ? '' : `${row.position} of ${row.total}`)
/** A word, then the place when the row has one: "queued 2 of 3", "queued". */
const at = (word: string, row: SlotRow): string => (place(row) ? `${word} ${place(row)}` : word)
const nextSlot = (row: SlotRow): string => (row.nextSlotInMin > 0 ? `next slot in about ${row.nextSlotInMin} min` : 'the slot is free now')

const LINES: Record<string, (row: SlotRow) => string> = {
  opening: () => 'waits for the label review',
  'awaiting-fix': () => 'waits for the fix push, then queues',
  queued: row => `${at('queued', row)}, ${nextSlot(row)}`,
  posted: () => 'review requested, waiting for CodeRabbit',
  'timed-out': row => `no free slot for 60 min, ${at('still queued', row)}; /slot pay ${row.pr} or /slot wait ${row.pr}`,
  stuck: row => `${row.posts} posts made no review; /slot drop ${row.pr}`,
  done: () => 'done',
  dropped: row => `dropped${row.dropReason ? ` (${row.dropReason})` : ''}`,
}

/** One row as words, for `/slot`, `/watch` and the status text. */
export const slotLine = (row: SlotRow): string => (LINES[row.state] ?? (() => row.state))(row)

/** The `/slot` list. The tick orders the rows. */
export const rowsText = (rows: SlotRow[]): string =>
  rows.length === 0 ? 'The free-slot queue is empty.' : ['Free-slot queue:', ...rows.map(row => `  #${row.pr} ${row.band} ${slotLine(row)}`)].join('\n')

export type SlotVerb = 'pay' | 'wait' | 'first' | 'drop'
export type SlotArgs = { kind: 'list' } | { kind: 'usage' } | { kind: SlotVerb; pr: number }

const VERBS: readonly string[] = ['pay', 'wait', 'first', 'drop']

/**
 * `/slot`, `/slot list`, or `/slot <pay|wait|first|drop> <pr>` (`#` allowed, any case). Any other text is a usage error:
 * a typo must not pay for, drop or pin another PR. `add` and `decide` are not verbs here.
 */
export const parseSlotArgs = (args: string): SlotArgs => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0 || (words.length === 1 && words[0] === 'list')) return { kind: 'list' }
  const [verb, num] = words
  if (words.length !== 2 || !verb || !VERBS.includes(verb) || !num || !/^#?\d+$/.test(num)) return { kind: 'usage' }
  const pr = Number(num.replace('#', ''))
  return Number.isSafeInteger(pr) && pr > 0 ? { kind: verb as SlotVerb, pr } : { kind: 'usage' }
}

// ---- the questions of the queue (design 3.3) ---------------------------------------------------------------------------------------
// The tick emits a toast when it asks Dave to pay (30 minutes without a free slot) or reports the time-out (60 minutes). The mod also puts
// the question as a dialog. The CLI stays the decider: Pay runs `decide --kind pay`, which posts only when cr-paid says ALLOW.

export type SlotAsk = { pr: number; kind: 'paid' | 'timeout'; canPay: boolean; cost: string | null }

/** The ask a tick action carries, or null for any other toast (queued, stuck, posted). The text is the CLI's; an unknown text raises no dialog. */
export const slotAskOf = (action: SlotAction): SlotAsk | null => {
  const text = action.text
  const kind = /no free slot for 60 minutes/.test(text) ? 'timeout' : /no free slot for 30 minutes/.test(text) ? 'paid' : null
  if (kind === null) return null
  const cost = /Paid round \$(\d+(?:\.\d+)?)/.exec(text)
  return { pr: action.pr, kind, canPay: new RegExp(`/slot pay ${action.pr}(?!\\d)`).test(text), cost: cost ? `$${cost[1]}` : null }
}

export type SlotChoice = { label: string; verb: 'pay' | 'wait' | 'drop' }
export type SlotAskSpec = { header: string; question: string; choices: SlotChoice[] }

/** The dialog: Keep waiting first (it costs nothing) and marked Recommended, then Pay with its figure, then Drop. No Pay when the CLI did not offer one. */
export const slotAskSpec = (ask: SlotAsk): SlotAskSpec => {
  const pay = ask.cost ? `Pay about ${ask.cost}` : 'Pay (cost unknown, cr-paid checks it)'
  const choices: SlotChoice[] = [
    { label: 'Keep waiting ($0) (Recommended)', verb: 'wait' },
    ...(ask.canPay ? [{ label: pay, verb: 'pay' as const }] : []),
    { label: 'Drop from queue ($0)', verb: 'drop' },
  ]
  const when = ask.kind === 'paid' ? 'no free CodeRabbit slot for 30 minutes' : 'no free CodeRabbit slot for 60 minutes; READY still needs a CodeRabbit review'
  return { header: `PR #${ask.pr}`, question: `PR #${ask.pr}: ${when}. ${ask.canPay ? 'Pay for the round, keep waiting, or drop it?' : 'A paid round is not allowed now. Keep waiting or drop it?'}`, choices }
}
