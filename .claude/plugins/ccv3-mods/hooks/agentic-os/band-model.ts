import type { HudLimit, OsBrief, OsTask } from '../../types'
import { redact } from '../shared/redact'
import { isAskStale, isProven } from './brief'
import type { Chip } from './brief'
import { gaugeTone } from './pane-model'
import type { Span, Tone } from './pane-model'

// The two core lines of the band (PRD 5.3), as plain data. Pure: no engine, no clock. The caller passes `now`.
//   line 1  chip, project dot and repo, branch, lane, ctx, cost
//   line 2  goal, plan bar, ASK count, UNPROVEN count
// Observer only. Every string is redacted again here (idempotent), so a caller that forgets cannot leak one.
// Below 40 columns the band is one line: the chip and the goal.
// compactLine (below) is the one-row form: chip, repo, ctx, 5h, 7d, cost, helpers.

export type BandState = {
  chip: Chip
  brief: OsBrief | null
  tasks: OsTask[]
  repo: string | null
  branch: string | null
  /** The first lane this session holds. */
  lane: string | null
  /** Context used, 0-100. */
  ctx: number | null
  costUsd: number | null
  /** `public.sessions.working_on`, shown dim after GOAL not set. Nothing feeds it yet. */
  fallback: string | null
  now: number
  /** When the session last did anything: an ask stays fresh 24 hours from it. */
  activeAt: number | null
  /** Helpers running now. Absent or 0 draws no helper text on the compact line. */
  helpers?: number
  /** The HUD's limits. null or absent: not known yet (the compact line reads a dash). A list without a window draws nothing for it. */
  limits?: HudLimit[] | null
}

export const CHIP: Record<Chip, { word: string; tone: Tone }> = {
  working: { word: 'WORKING', tone: 'chipDoing' },
  'waiting-on-dave': { word: 'WAITING ON DAVE', tone: 'chipWarn' },
  blocked: { word: 'BLOCKED', tone: 'chipBad' },
  done: { word: 'DONE', tone: 'chipOk' },
  idle: { word: 'IDLE', tone: 'chipDim' },
}

/** Below this many columns the band is the chip and the goal. */
const NARROW = 40
/** Less than this and the chip cannot sit whole with anything else; the line is drawn as wide as the chip needs. */
const MIN_WIDTH = 20
const MIN_BRANCH = 12
const MIN_GOAL = 12
const BAR_CELLS = 10
const SEP = '  '
const DOT = ' · '

const sp = (text: string, tone: Tone): Span => ({ text, tone })
const len = (spans: Span[]): number => spans.reduce((n, one) => n + one.text.length, 0)
const clean = (value: string | null | undefined): string => redact((value ?? '').trim()).text
const clip = (value: string, max: number): string => (value.length <= max ? value : max <= 1 ? '…'.slice(0, Math.max(0, max)) : `${value.slice(0, max - 1)}…`)

/** Cuts a run of spans to `max` characters, with an ellipsis on the span it cuts. */
const clipSpans = (spans: Span[], max: number): Span[] => {
  const out: Span[] = []
  let room = Math.max(0, max)
  for (const one of spans) {
    if (room <= 0) break
    out.push({ ...one, text: clip(one.text, room) })
    room -= Math.min(room, one.text.length)
  }
  return out
}

const join = (parts: Span[][], between: Span): Span[] => parts.flatMap((part, i) => (i === 0 ? part : [between, ...part]))

// --- Counts ---

type Step = { done: boolean; unproven: boolean; state: 'done' | 'doing' | 'blocked' | 'todo' }

/** PRD 5.1: the task list when it holds a task, else the brief plan. The same items `deriveChip` weighs. */
const stepsOf = (tasks: OsTask[], brief: OsBrief | null): Step[] =>
  tasks.length > 0 ? taskSteps(tasks, brief) : planSteps(brief)

const taskSteps = (tasks: OsTask[], brief: OsBrief | null): Step[] =>
  tasks.map((one): Step => {
    const done = one.status === 'completed'
    return { done, unproven: done && !isProven(brief, { id: one.id, subject: one.subject, kind: 'task' }), state: done ? 'done' : one.status === 'in_progress' ? 'doing' : 'todo' }
  })

const planSteps = (brief: OsBrief | null): Step[] =>
  (brief?.plan ?? []).map((one): Step => {
    const done = one.status === 'done'
    return { done, unproven: done && !isProven(brief, { id: one.id, subject: one.text, kind: 'plan' }), state: done ? 'done' : one.status === 'doing' ? 'doing' : one.status === 'blocked' ? 'blocked' : 'todo' }
  })

/** `total` cells at most BAR_CELLS; each kind of step takes cells in proportion, in the order proven, unproven, doing, blocked, to do. */
const barSpans = (steps: Step[], cells: number): Span[] => {
  if (cells <= 0) return []
  const total = steps.length
  const kinds: [Tone, string, number][] = [
    ['done', '▰', steps.filter(one => one.done && !one.unproven).length],
    ['warn', '▰', steps.filter(one => one.unproven).length],
    ['doing', '▰', steps.filter(one => one.state === 'doing').length],
    ['bad', '▰', steps.filter(one => one.state === 'blocked').length],
    ['track', '▱', steps.filter(one => !one.done && one.state === 'todo').length],
  ]
  if (total === 0) return [sp('▱'.repeat(cells), 'track')]
  const out: Span[] = []
  let seen = 0
  let drawn = 0
  for (const [tone, glyph, count] of kinds) {
    seen += count
    const upTo = Math.round((seen / total) * cells)
    if (upTo > drawn) out.push(sp(glyph.repeat(upTo - drawn), tone))
    drawn = Math.max(drawn, upTo)
  }
  return out
}

// --- Line 1 ---

type Item = { key: 'repo' | 'branch' | 'lane' | 'ctx' | 'cost'; spans: Span[] }

const items = (s: BandState): Item[] => {
  const ctx = typeof s.ctx === 'number' && Number.isFinite(s.ctx) ? s.ctx : null
  const cost = typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : null
  return [
    { key: 'repo', spans: [sp('● ', 'title'), sp(clean(s.repo) || '-', 'todo')] },
    { key: 'branch', spans: [sp(clean(s.branch) || '-', 'todo')] },
    { key: 'lane', spans: [sp(`lane ${clean(s.lane) || '-'}`, 'dim')] },
    { key: 'ctx', spans: [sp(ctx === null ? 'ctx -' : `ctx ${ctx}%`, ctx === null ? 'dim' : gaugeTone(ctx))] },
    { key: 'cost', spans: [sp(cost === null ? '$-' : `$${cost.toFixed(2)}`, 'dim')] },
  ]
}

const chipSpan = (chip: Chip): Span => sp(` ${(CHIP[chip] ?? CHIP.idle).word} `, (CHIP[chip] ?? CHIP.idle).tone)

const lineOne = (s: BandState, width: number): Span[] => {
  const chip = chipSpan(s.chip)
  let rest = items(s)
  const total = () => chip.text.length + (rest.length > 0 ? SEP.length + len(join(rest.map(one => one.spans), sp(DOT, 'track'))) : 0)
  const shrink = (key: Item['key'], to: (current: string) => string) => {
    rest = rest.map(one => (one.key === key ? { ...one, spans: one.spans.map(span => ({ ...span, text: to(span.text) })) } : one))
  }
  const textOf = (key: Item['key']) => len(rest.find(one => one.key === key)?.spans ?? [])
  const drop = (key: Item['key']) => {
    rest = rest.filter(one => one.key !== key)
  }
  // Cut in this order: the branch down to its minimum, then lane, cost, ctx, then the branch, then the repo.
  for (const key of ['lane', 'cost', 'ctx', 'branch'] as const) {
    const excess = total() - width
    if (excess <= 0) break
    if (key === 'lane' && textOf('branch') > MIN_BRANCH) shrink('branch', text => clip(text, Math.max(MIN_BRANCH, text.length - excess)))
    if (total() > width) drop(key)
  }
  if (total() > width && rest.length > 0) {
    const room = width - chip.text.length - SEP.length - 2
    if (room >= 4) shrink('repo', text => clip(text, room))
    else drop('repo')
  }
  // A field dropped after the branch was cut leaves room: give it back to the branch.
  const spare = width - total()
  const branch = items(s).find(one => one.key === 'branch')?.spans[0]?.text ?? ''
  if (spare > 0 && textOf('branch') > 0 && textOf('branch') < branch.length) shrink('branch', () => clip(branch, textOf('branch') + spare))
  return rest.length === 0 ? [chip] : [chip, sp(SEP, 'dim'), ...join(rest.map(one => one.spans), sp(DOT, 'track'))]
}

// --- Line 2 ---

type Goal = { label: Span; fixed: Span[]; clippable: string; clippableTone: Tone; tail: Span[] }

/** What the goal part is made of: `clippable` is the text that gives way first. */
const goalOf = (s: BandState): Goal => {
  const label = sp('GOAL ', 'dim')
  const goal = clean(s.brief?.goal)
  if (goal === '') {
    const fallback = clean(s.fallback)
    return { label, fixed: [sp('not set', 'warn')], clippable: fallback === '' ? '' : `  ${fallback}`, clippableTone: 'dim', tail: [] }
  }
  const parsed = s.brief?.sources.goal === 'parsed'
  return { label, fixed: [], clippable: goal, clippableTone: 'todo', tail: parsed ? [sp(' [parsed]', 'dim')] : [] }
}

type Counts = { asks: number; answered: number; stale: boolean; unproven: number; done: number; total: number }

const countsOf = (s: BandState, steps: Step[]): Counts => {
  const list = s.brief?.ask ?? []
  const asks = list.filter(one => one.answered !== true).length
  return {
    asks,
    answered: list.length - asks,
    stale: s.brief !== null && isAskStale(s.brief, s.now, s.activeAt),
    unproven: steps.filter(one => one.unproven).length,
    done: steps.filter(one => one.done).length,
    total: steps.length,
  }
}

/** Amber only when a person is needed (the waiting-on-dave chip); red on a blocked chip; dim in every other state. */
const askTone = (c: Counts, chip: Chip): Tone =>
  c.asks === 0 ? (chip === 'done' ? 'done' : 'dim') : c.stale ? 'dim' : chip === 'blocked' ? 'bad' : chip === 'waiting-on-dave' ? 'warn' : 'dim'
const unprovenTone = (c: Counts, chip: Chip): Tone => (c.unproven > 0 ? 'warn' : chip === 'done' ? 'done' : 'dim')

const lineTwo = (s: BandState, steps: Step[], width: number): Span[] => {
  const goal = goalOf(s)
  const c = countsOf(s, steps)
  const cells = steps.length === 0 ? 5 : Math.min(steps.length, BAR_CELLS)
  const plan = (cellCount: number, label: boolean): Span[] => [
    ...(label ? [sp('PLAN ', 'dim')] : []),
    ...barSpans(steps, cellCount),
    sp(`${cellCount > 0 ? ' ' : ''}${c.done}/${c.total}`, 'todo'),
  ]
  const counts: Span[][] = [
    [sp(`ASK ${c.asks}${c.stale && c.asks > 0 ? ' stale' : ''}`, askTone(c, s.chip))],
    ...(c.answered > 0 ? [[sp(`${c.answered} answered?`, 'dim')]] : []),
    [sp(`UNPROVEN ${c.unproven}`, unprovenTone(c, s.chip))],
  ]
  const build = (variant: { cells: number; label: boolean }, room: number | null): Span[] => {
    const text = room === null ? goal.clippable : clip(goal.clippable, Math.max(0, room))
    const head: Span[] = [goal.label, ...goal.fixed, ...(text === '' ? [] : [sp(text, goal.clippableTone)]), ...goal.tail]
    return join([head, plan(variant.cells, variant.label), ...counts], sp(SEP, 'dim'))
  }
  const variants = [
    { cells, label: true },
    { cells: Math.min(cells, 4), label: true },
    { cells: 0, label: true },
    { cells: 0, label: false },
  ]
  for (const variant of variants) {
    const fixed = len(build(variant, 0))
    const room = width - fixed
    if (room >= Math.min(goal.clippable.length, MIN_GOAL)) return build(variant, room)
  }
  const last = variants[variants.length - 1] ?? { cells: 0, label: false }
  return clipSpans(build(last, Math.max(0, width - len(build(last, 0)))), width)
}

const narrow = (s: BandState, width: number): Span[] => {
  const chip = chipSpan(s.chip)
  const goal = goalOf(s)
  const room = width - chip.text.length - SEP.length - goal.label.text.length
  if (room < 3) return [chip]
  const body = [...goal.fixed, ...(goal.clippable === '' ? [] : [sp(goal.clippable, goal.clippableTone)]), ...goal.tail]
  return [chip, sp(SEP, 'dim'), goal.label, ...clipSpans(body, room)]
}

// --- Compact line ---
// The one line the band draws when the row budget leaves no room for two core lines plus the HUD row (and under 40 columns
// with the HUD up). Chip, repo, ctx, 5h, 7d, cost, helpers. Cut order when the width is short: helpers, cost, repo, 7d, 5h.
// The chip and ctx stay; a chip too wide for ctx at 20 columns keeps the line inside the width and drops ctx last of all.

type CompactKey = 'repo' | 'ctx' | 'five' | 'seven' | 'cost' | 'helpers'
type CompactField = { key: CompactKey; spans: Span[] }

const MIN_REPO = 4
const WINDOW: Record<'five' | 'seven', { kind: string; label: string }> = {
  five: { kind: 'five_hour', label: '5h' },
  seven: { kind: 'seven_day', label: '7d' },
}

/** A rate window: unknown (limits not read yet, or a non-finite percent) reads a dash; a list without the window draws nothing. */
const windowField = (key: 'five' | 'seven', limits: HudLimit[] | null | undefined): CompactField | null => {
  const { kind, label } = WINDOW[key]
  if (!Array.isArray(limits)) return { key, spans: [sp(`${label} -`, 'dim')] }
  const found = limits.find(one => one.kind === kind)
  if (found === undefined) return null
  if (typeof found.percentUsed !== 'number' || !Number.isFinite(found.percentUsed)) return { key, spans: [sp(`${label} -`, 'dim')] }
  const percent = Math.round(found.percentUsed)
  return { key, spans: [sp(`${label} ${percent}%`, gaugeTone(percent))] }
}

const compactFields = (s: BandState, roomy: boolean): CompactField[] => {
  const ctx = typeof s.ctx === 'number' && Number.isFinite(s.ctx) ? s.ctx : null
  const cost = typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : null
  const helpers = typeof s.helpers === 'number' && Number.isFinite(s.helpers) ? Math.floor(s.helpers) : 0
  const fields: (CompactField | null)[] = [
    roomy ? { key: 'repo', spans: [sp(clean(s.repo) || '-', 'todo')] } : null,
    { key: 'ctx', spans: [sp(ctx === null ? 'ctx -' : `ctx ${ctx}%`, ctx === null ? 'dim' : gaugeTone(ctx))] },
    windowField('five', s.limits),
    windowField('seven', s.limits),
    roomy ? { key: 'cost', spans: [sp(cost === null ? '$-' : `$${cost.toFixed(2)}`, 'dim')] } : null,
    roomy && helpers > 0 ? { key: 'helpers', spans: [sp(`${helpers} ${helpers === 1 ? 'helper' : 'helpers'} running`, 'doing')] } : null,
  ]
  return fields.filter((one): one is CompactField => one !== null)
}

/** The compact band line for a drawing `width` wide. Never wider than `max(width, 20)`; the chip is never cut. */
export const compactLine = (state: BandState, width: number): Span[] => {
  const wide = Math.max(MIN_WIDTH, Number.isFinite(width) ? Math.floor(width) : MIN_WIDTH)
  const chip = chipSpan(state.chip)
  let fields = compactFields(state, wide >= NARROW)
  // Every field costs its text and one space in front of it.
  const total = () => chip.text.length + fields.reduce((n, one) => n + 1 + len(one.spans), 0)
  const drop = (key: CompactKey) => {
    fields = fields.filter(one => one.key !== key)
  }
  for (const key of ['helpers', 'cost'] as const) if (total() > wide) drop(key)
  if (total() > wide && fields.some(one => one.key === 'repo')) {
    const room = wide - (total() - len(fields.find(one => one.key === 'repo')?.spans ?? []))
    if (room >= MIN_REPO) fields = fields.map(one => (one.key === 'repo' ? { ...one, spans: clipSpans(one.spans, room) } : one))
    else drop('repo')
  }
  for (const key of ['seven', 'five', 'ctx'] as const) if (total() > wide) drop(key)
  return [chip, ...fields.flatMap(one => [sp(' ', 'dim'), ...one.spans])]
}

/**
 * The band's core lines for a drawing `width` wide: two lines, or one (chip and goal) under 40 columns.
 * No line is wider than `max(width, 20)`. The chip is never cut; the goal is the first text to give way.
 */
export const bandLines = (state: BandState, width: number): Span[][] => {
  const wide = Math.max(MIN_WIDTH, Number.isFinite(width) ? Math.floor(width) : MIN_WIDTH)
  if (wide < NARROW) return [narrow(state, wide)]
  return [lineOne(state, wide), lineTwo(state, stepsOf(state.tasks, state.brief), wide)]
}
