import type { HudLimit, OsBrief, OsTask } from '../../types'
import { redact } from '../shared/redact'
import type { Chip } from './brief'
import { cellWidth, cutCells } from './cells'
import type { Span, Tone } from './pane-model'

// The band above the prompt (PRD 5.3; design 2026-11-18, `.claudedocs/coordination/2026-11-18-coord-status-band-2-redesign-design.md`), as plain data.
// Pure: no engine, no clock. The caller passes `now`. Observer only: every string is redacted again here (idempotent).
//   rowPlan    runs first: which rows draw (by maxRows, HUD, quiet), who owns each of ctx, 5h, 7d and cost, which sign form and fields each row keeps
//   bandRows   the plan plus the spans of the rows this module draws: `line` (maxRows 1), `compact` (maxRows 2 with the HUD), `row1`, `goal`
//   The HUD row and the widget row are drawn by the caller (index.tsx); `hudSkipKeys` names the HUD parts another row already draws.
// Row 1 is the chip, the question sign (amber), `name #sid8`, lane and, when it owns it, ctx. Row 2 is the Goal: one sentence, no label.
// Every width is a terminal cell count (cells.ts), never a UTF-16 length.

export type BandState = {
  chip: Chip
  brief: OsBrief | null
  tasks: OsTask[]
  repo: string | null
  /**
   * Who this session is. `name` is the Claude Code session name (null: unnamed, drawn dim); `short` is the first 8 characters of
   * the session id, drawn dim as `#sid8` (null: not drawn). Absent: row 1 has no session item.
   */
  who?: { name: string | null; short: string | null }
  /** The first lane this session holds. */
  lane: string | null
  /** The title of that lane (the title only, never its scope). The Goal row reads it when no lane note goal and no brief_set goal exist. */
  laneTitle?: string | null
  /** The goal sentence of the note of `lanes[0]` (`goalOfNote`, goal-extractor.ts); null when that note has none. The Goal row reads it first. */
  laneGoal?: string | null
  /** How many lanes this session holds; more than 1 draws `+N` after the lane (N = count - 1). */
  laneCount?: number
  /** Context used, 0-100. */
  ctx: number | null
  costUsd: number | null
  now: number
  /** When the session last did anything: an ask stays fresh 24 hours from it. */
  activeAt: number | null
  /** Helpers running now. Absent or 0 draws no helper text on the compact line. Row 1 does not draw it. */
  helpers?: number
  /** The HUD row draws (a HUD state exists). It owns ctx, 5h, 7d and cost whenever it is a row of the plan; with no HUD, no limit field and no cost draw. */
  hud?: boolean
  /** The HUD's limits. null or absent: not known yet (a line that draws the windows reads a dash). A list without a window draws nothing for it. */
  limits?: HudLimit[] | null
  /** How many background tasks count (`countWaitTasks`). The waiting-on-work chip reads it: WAITING ON 1 TASK / WAITING ON n TASKS. Absent: the plain word. */
  waitTasks?: number
  /**
   * The questions Dave has open: the number `openAsksOf` (brief.ts) gave, the same one the chip was derived from. The question sign reads it and nothing else, so a stored
   * parsed ask in `brief` draws no sign. Above 0 the chip is WAITING FOR YOU or STUCK. Absent: 0.
   */
  openAsks?: number
}

export const CHIP: Record<Chip, { word: string; tone: Tone }> = {
  working: { word: 'WORKING', tone: 'chipDoing' },
  'waiting-on-dave': { word: 'WAITING FOR YOU', tone: 'chipWarn' },
  // Grey fill: the session waits on its own background work, not on a person. The count joins the word in chipSpan.
  'waiting-on-work': { word: 'WAITING ON TASKS', tone: 'chipDim' },
  blocked: { word: 'STUCK', tone: 'chipBad' },
  done: { word: 'DONE', tone: 'chipOk' },
  // Dim text, no fill: resting is not a state Dave must read.
  idle: { word: 'RESTING', tone: 'dim' },
}

export type RowKind = 'line' | 'compact' | 'row1' | 'goal' | 'hud' | 'widget'
/** Who draws one of the four numbers (ctx, 5h, 7d, cost). null: no row draws it. */
export type Owner = 'line' | 'compact' | 'row1' | 'hud' | null
/** How the question sign reads: `2 questions`, `? 2`, `?2` (`?+` from 10), or no sign. `tiny` is reserved: the design gives it no text, so no row picks it. */
export type SignForm = 'none' | 'words' | 'short' | 'tight' | 'tiny'
export type CompactKey = 'ask' | 'name' | 'repo' | 'ctx' | 'five' | 'seven' | 'cost' | 'helpers'
export type RowPlan = {
  rows: RowKind[]
  owners: { ctx: Owner; five: Owner; seven: Owner; cost: Owner }
  signForm: SignForm
  /** The fields the first row keeps (row 1, or the maxRows 1 line), in order: chip, sign, name, sid, lane, ctx; the line adds five, seven, goal. */
  row1Shape: string[]
  /** What the compact line really drew, in order. Empty when the plan has no compact line. */
  compactKeys: CompactKey[]
}
export type DrawnRows = Partial<Record<'line' | 'compact' | 'row1' | 'goal', Span[]>>

/** Under this many columns the compact line has no repo, cost or helpers. */
const ROOMY = 40
/** Less than this and the chip cannot sit whole with anything else; the line is drawn as wide as the chip needs. */
const MIN_WIDTH = 20
/** The session name is cut to this on row 1, and to MIN_NAME when the row is too wide; the compact line cuts it to COMPACT_NAME. */
const NAME_MAX = 16
const MIN_NAME = 8
/** The name is drawn beside ctx only with this many cells. */
const MIN_ROOM = 3
const COMPACT_NAME = 8
/** The maxRows 1 line draws the goal only when this many cells are left. */
const MIN_GOAL = 12
const MIN_REPO = 4
const SEP = '  '
const DOT = ' · '

const sp = (text: string, tone: Tone): Span => ({ text, tone })
const cells = (spans: Span[]): number => spans.reduce((n, one) => n + cellWidth(one.text), 0)
const clean = (value: string | null | undefined): string => redact((value ?? '').trim()).text
/** A name for display: redacted, whitespace collapsed to single spaces, trimmed. The caller clips it by cells. */
const nameOf = (value: string | null | undefined): string => clean(value).replace(/\s+/g, ' ').trim()
/** At most `max` cells, ending in an ellipsis when it cuts. */
const clip = (value: string, max: number): string => (cellWidth(value) <= max ? value : max < 1 ? '' : max === 1 ? '…' : `${cutCells(value, max - 1)}…`)

const join = (parts: Span[][], between: Span): Span[] => parts.flatMap((part, i) => (i === 0 ? part : [between, ...part]))

/** The gauge tone of row 1, the maxRows 1 line and the compact line: dim until 75, red from 75. The HUD row keeps `gaugeTone` (pane-model.ts), where amber means heat. */
export const rowGaugeTone = (percent: number): Tone => (percent < 75 ? 'dim' : 'bad')

const ctxOf = (s: BandState): number | null => (typeof s.ctx === 'number' && Number.isFinite(s.ctx) ? s.ctx : null)
const ctxSpans = (s: BandState): Span[] => {
  const ctx = ctxOf(s)
  return [sp(ctx === null ? 'ctx -' : `ctx ${ctx}%`, ctx === null ? 'dim' : rowGaugeTone(ctx))]
}

// --- The question sign ---

/** The open questions: `BandState.openAsks`, the value the chip was derived from. */
const openAsks = (s: BandState): number => (typeof s.openAsks === 'number' && Number.isFinite(s.openAsks) && s.openAsks > 0 ? Math.floor(s.openAsks) : 0)

/** The sign text of one form. No form shows a wrong number: `?+` stands for 10 or more. */
const signText = (count: number, form: SignForm): string =>
  form === 'words' ? `${count} ${count === 1 ? 'question' : 'questions'}` : form === 'short' ? `? ${count}` : form === 'tight' ? (count <= 9 ? `?${count}` : '?+') : ''

/** The sign, amber under every chip, with the space before it; empty for no question or no form. */
const signSpans = (s: BandState, form: SignForm): Span[] => {
  const text = openAsks(s) > 0 ? signText(openAsks(s), form) : ''
  return text === '' ? [] : [sp(' ', 'dim'), sp(text, 'warn')]
}

const startSign = (s: BandState): SignForm => (openAsks(s) > 0 ? 'words' : 'none')

// --- The chip and row 1 ---

/** The chip word. waiting-on-work carries the task count when it is known: `WAITING ON 1 TASK`, `WAITING ON 2 TASKS`. */
const chipWordOf = (chip: Chip, waitTasks?: number): string =>
  chip === 'waiting-on-work' && typeof waitTasks === 'number' && Number.isFinite(waitTasks) && waitTasks >= 1
    ? `WAITING ON ${Math.floor(waitTasks)} ${Math.floor(waitTasks) === 1 ? 'TASK' : 'TASKS'}`
    : (CHIP[chip] ?? CHIP.idle).word

const chipSpan = (chip: Chip, waitTasks?: number): Span => sp(` ${chipWordOf(chip, waitTasks)} `, (CHIP[chip] ?? CHIP.idle).tone)

/** `name #sid8`: the name in the accent tone, `#sid8` dim; no name reads `unnamed`, dim. */
const whoSpans = (who: NonNullable<BandState['who']>, nameMax: number, sid: boolean): Span[] => {
  const name = nameOf(who.name)
  const short = clean(who.short)
  return [name === '' ? sp('unnamed', 'dim') : sp(clip(name, nameMax), 'title'), ...(sid && short !== '' ? [sp(` #${short}`, 'dim')] : [])]
}

const laneText = (s: BandState, more: boolean): string => {
  const extra = more && typeof s.laneCount === 'number' && Number.isFinite(s.laneCount) && s.laneCount > 1 ? ` +${Math.floor(s.laneCount) - 1}` : ''
  return `lane ${clean(s.lane) || '-'}${extra}`
}

type Fit<K extends string> = { spans: Span[]; keys: K[]; sign: SignForm }
type Row1Shape = { sign: SignForm; sid: boolean; more: boolean; lane: boolean; nameMax: number; ctx: boolean }

const row1Spans = (s: BandState, shape: Row1Shape): { spans: Span[]; keys: string[] } => {
  const sign = signSpans(s, shape.sign)
  const items: { keys: string[]; spans: Span[] }[] = []
  if (s.who !== undefined && shape.nameMax > 0) {
    const showSid = shape.sid && clean(s.who.short) !== ''
    items.push({ keys: showSid ? ['name', 'sid'] : ['name'], spans: whoSpans(s.who, shape.nameMax, shape.sid) })
  }
  if (shape.lane) items.push({ keys: ['lane'], spans: [sp(laneText(s, shape.more), 'dim')] })
  if (shape.ctx) items.push({ keys: ['ctx'], spans: ctxSpans(s) })
  return {
    spans: [chipSpan(s.chip, s.waitTasks), ...sign, ...(items.length > 0 ? [sp(SEP, 'dim'), ...join(items.map(one => one.spans), sp(DOT, 'track'))] : [])],
    keys: ['chip', ...(sign.length > 0 ? ['sign'] : []), ...items.flatMap(one => one.keys)],
  }
}

/**
 * Row 1 for a drawing `width` wide. Cut order: `#sid8`, `+N more`, the sign word to `? n`, the lane, the name to MIN_NAME and then to the room beside ctx (it goes under MIN_ROOM),
 * ctx (when this row owns it), `? n` to `?n`. Then, when even the chip and the sign are too wide (WAITING ON n TASKS at 20 columns), the name and the sign go. The chip is never cut.
 */
const row1Fit = (s: BandState, width: number, ownsCtx: boolean): Fit<string> => {
  const shape: Row1Shape = { sign: startSign(s), sid: true, more: true, lane: true, nameMax: NAME_MAX, ctx: ownsCtx }
  const cuts: (() => void)[] = [
    () => { shape.sid = false },
    () => { shape.more = false },
    () => { if (shape.sign === 'words') shape.sign = 'short' },
    () => { shape.lane = false },
    () => { shape.nameMax = Math.min(shape.nameMax, MIN_NAME) },
    // The name gives way to ctx: it is cut to the room beside the other items, and goes when under MIN_ROOM cells are left.
    () => {
      const others = shape.lane || shape.ctx
      const base = cells(row1Spans(s, { ...shape, nameMax: 0 }).spans)
      const room = width - base - (others ? DOT.length : SEP.length)
      shape.nameMax = room >= MIN_ROOM ? Math.min(shape.nameMax, room) : 0
      // `unnamed` is never clipped: when the row is still too wide the name goes, so ctx outlasts it.
      if (cells(row1Spans(s, shape).spans) > width) shape.nameMax = 0
    },
    () => { shape.ctx = false },
    () => { if (shape.sign === 'short') shape.sign = 'tight' },
    () => { shape.nameMax = 0 },
    () => { shape.sign = 'none' },
  ]
  let built = row1Spans(s, shape)
  for (const cut of cuts) {
    if (cells(built.spans) <= width) break
    cut()
    built = row1Spans(s, shape)
  }
  return { ...built, sign: shape.sign }
}

// --- The Goal row ---

/**
 * Where the Goal row text comes from (design 2026-11-18, section 2): the lane note sentence of lanes[0], then the brief_set goal, then the lane title,
 * then the parsed goal (a guess), else null. Each value is redacted and on one line.
 */
export const goalSource = (s: BandState): { text: string; guessed: boolean } | null => {
  const parsed = s.brief?.sources.goal === 'parsed'
  const note = nameOf(s.laneGoal)
  const said = parsed ? '' : nameOf(s.brief?.goal)
  const title = nameOf(s.laneTitle)
  const guess = parsed ? nameOf(s.brief?.goal) : ''
  if (note !== '') return { text: note, guessed: false }
  if (said !== '') return { text: said, guessed: false }
  if (title !== '') return { text: title, guessed: false }
  return guess !== '' ? { text: guess, guessed: true } : null
}

const GUESSED = ' [guessed]'
const NOT_SET = 'goal not set'
/** A redaction marker: the clip never cuts inside one. */
const MARKER = /\[REDACTED:[^\]\s]*\]/g

/** The text, cut at a word to at most `room` cells, ending in `…`. A text that fits is returned as it is. `room` must be 1 or more. */
const clipGoal = (text: string, room: number): string => {
  if (cellWidth(text) <= room) return text
  let keep = cutCells(text, room - 1)
  if (text[keep.length] !== ' ') {
    const space = keep.lastIndexOf(' ')
    if (space > 0) keep = keep.slice(0, space)
  }
  // Never cut inside a redaction marker: a marker the cut touches goes whole.
  for (const marker of text.matchAll(MARKER)) {
    const from = marker.index ?? 0
    if (from < keep.length && keep.length < from + marker[0].length) keep = keep.slice(0, from)
  }
  return `${keep.trimEnd()}…`
}

/** The Goal row: one line of at most `width` cells. No label, no stop-at. A guessed goal ends in a dim ` [guessed]`, reserved before the clip. */
export const goalSpans = (s: BandState, width: number): Span[] => {
  const room = Math.floor(width)
  if (!(room >= 1)) return []
  const source = goalSource(s)
  if (source === null) return [sp(cutCells(NOT_SET, room), 'dim')]
  // The tag is kept while at least 2 cells stay for the goal; on a narrower row the goal alone is drawn.
  const tag = source.guessed && room - GUESSED.length >= 2
  const goal = clipGoal(source.text, tag ? room - GUESSED.length : room)
  return [sp(goal, 'todo'), ...(tag ? [sp(GUESSED, 'dim')] : [])]
}

// --- The compact line and the maxRows 1 line ---

type CompactField = { key: CompactKey; spans: Span[] }

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
  return { key, spans: [sp(`${label} ${percent}%`, rowGaugeTone(percent))] }
}

type CompactShape = { sign: SignForm; dropped: Set<CompactKey>; repoMax: number | null }

const compactFields = (s: BandState, roomy: boolean, shape: CompactShape): CompactField[] => {
  const cost = typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : null
  const helpers = typeof s.helpers === 'number' && Number.isFinite(s.helpers) ? Math.floor(s.helpers) : 0
  const sign = signText(openAsks(s), shape.sign)
  const repo = clean(s.repo) || '-'
  const fields: (CompactField | null)[] = [
    sign !== '' ? { key: 'ask', spans: [sp(sign, 'warn')] } : null,
    s.who === undefined ? null : { key: 'name', spans: whoSpans(s.who, COMPACT_NAME, false) },
    roomy ? { key: 'repo', spans: [sp(shape.repoMax === null ? repo : clip(repo, shape.repoMax), 'todo')] } : null,
    { key: 'ctx', spans: ctxSpans(s) },
    windowField('five', s.limits),
    windowField('seven', s.limits),
    roomy ? { key: 'cost', spans: [sp(cost === null ? '$-' : `$${cost.toFixed(2)}`, 'dim')] } : null,
    roomy && helpers > 0 ? { key: 'helpers', spans: [sp(`${helpers} ${helpers === 1 ? 'helper' : 'helpers'} running`, 'doing')] } : null,
  ]
  return fields.filter((one): one is CompactField => one !== null && !shape.dropped.has(one.key))
}

const compactWide = (width: number): number => Math.max(MIN_WIDTH, Number.isFinite(width) ? Math.floor(width) : MIN_WIDTH)

/**
 * The compact line: chip, sign, name (cut to 8), repo, ctx, 5h, 7d, cost, helpers. Every field costs its text and one space. Cut order: helpers, cost, repo
 * (clipped to the room, 4 cells at least, else dropped), the sign word to `? n`, 7d, 5h, name, ctx, `? n` to `?n`, then the sign. The chip is never cut.
 */
const compactFit = (s: BandState, width: number): Fit<CompactKey> => {
  const wide = compactWide(width)
  const chip = chipSpan(s.chip, s.waitTasks)
  const shape: CompactShape = { sign: startSign(s), dropped: new Set(), repoMax: null }
  const build = () => compactFields(s, wide >= ROOMY, shape)
  const total = () => cells([chip]) + build().reduce((n, one) => n + 1 + cells(one.spans), 0)
  const drop = (key: CompactKey) => () => { shape.dropped.add(key) }
  const cuts: (() => void)[] = [
    drop('helpers'),
    drop('cost'),
    () => {
      const repo = build().find(one => one.key === 'repo')
      if (repo === undefined) return
      const room = wide - (total() - cells(repo.spans))
      if (room >= MIN_REPO) shape.repoMax = room
      else shape.dropped.add('repo')
    },
    () => { if (shape.sign === 'words') shape.sign = 'short' },
    drop('seven'),
    drop('five'),
    drop('name'),
    drop('ctx'),
    () => { if (shape.sign === 'short') shape.sign = 'tight' },
    () => { shape.sign = 'none' },
  ]
  for (const cut of cuts) {
    if (total() <= wide) break
    cut()
  }
  const fields = build()
  return { spans: [chip, ...fields.flatMap(one => [sp(' ', 'dim'), ...one.spans])], keys: fields.map(one => one.key), sign: fields.some(one => one.key === 'ask') ? shape.sign : 'none' }
}

/** The compact band line for a drawing `width` wide. Never wider than `max(width, 20)`; the chip is never cut. */
export const compactLine = (state: BandState, width: number): Span[] => compactFit(state, width).spans

type LineShape = { sign: SignForm; ctx: boolean; five: boolean; seven: boolean }

/**
 * The one-row line (maxRows 1): chip, sign, ctx, then 5h and 7d (only with a HUD state: with none, no limit field draws), then the goal when MIN_GOAL cells
 * are left. No name, repo, helpers or cost. Cut order: 7d, 5h, the sign word to `? n`, ctx, `? n` to `?n`, the sign.
 */
const lineFit = (s: BandState, width: number): Fit<string> & { ctx: boolean; five: boolean; seven: boolean } => {
  const wide = compactWide(width)
  const chip = chipSpan(s.chip, s.waitTasks)
  const windows = s.hud === true ? { five: windowField('five', s.limits), seven: windowField('seven', s.limits) } : { five: null, seven: null }
  const shape: LineShape = { sign: startSign(s), ctx: true, five: windows.five !== null, seven: windows.seven !== null }
  const body = (): { spans: Span[]; keys: string[] } => {
    const parts: { key: string; spans: Span[] }[] = [
      ...(shape.ctx ? [{ key: 'ctx', spans: ctxSpans(s) }] : []),
      ...(shape.five && windows.five !== null ? [{ key: 'five', spans: windows.five.spans }] : []),
      ...(shape.seven && windows.seven !== null ? [{ key: 'seven', spans: windows.seven.spans }] : []),
    ]
    const sign = signSpans(s, shape.sign)
    return {
      spans: [chip, ...sign, ...parts.flatMap(one => [sp(' ', 'dim'), ...one.spans])],
      keys: ['chip', ...(sign.length > 0 ? ['sign'] : []), ...parts.map(one => one.key)],
    }
  }
  const cuts: (() => void)[] = [
    () => { shape.seven = false },
    () => { shape.five = false },
    () => { if (shape.sign === 'words') shape.sign = 'short' },
    () => { shape.ctx = false },
    () => { if (shape.sign === 'short') shape.sign = 'tight' },
    () => { shape.sign = 'none' },
  ]
  let built = body()
  for (const cut of cuts) {
    if (cells(built.spans) <= wide) break
    cut()
    built = body()
  }
  const room = wide - cells(built.spans) - 1
  const goal = room >= MIN_GOAL ? goalSpans(s, room) : []
  return {
    spans: goal.length > 0 ? [...built.spans, sp(' ', 'dim'), ...goal] : built.spans,
    keys: goal.length > 0 ? [...built.keys, 'goal'] : built.keys,
    sign: built.keys.includes('sign') ? shape.sign : 'none',
    ctx: shape.ctx,
    five: shape.five,
    seven: shape.seven,
  }
}

// --- The plan ---

/** Rows by maxRows (design section 3). The HUD row (HUD on) comes before the widget row. A quiet session has no widget row. */
const rowKinds = (hud: boolean, maxRows: number, quiet: boolean): RowKind[] => {
  if (!(maxRows >= 1)) return []
  const rows = Math.floor(maxRows)
  if (rows === 1) return ['line']
  const widget: RowKind[] = quiet || rows < (hud ? 4 : 3) ? [] : ['widget']
  if (hud) return rows === 2 ? ['compact', 'hud'] : ['row1', 'goal', 'hud', ...widget]
  return ['row1', 'goal', ...widget]
}

const COMPACT_OWNED: Partial<Record<CompactKey, 'ctx' | 'five' | 'seven' | 'cost'>> = { ctx: 'ctx', five: 'five', seven: 'seven', cost: 'cost' }

const planOf = (s: BandState, maxRows: number, width: number, quiet: boolean): { plan: RowPlan; rows: DrawnRows } => {
  const wide = compactWide(width)
  const kinds = rowKinds(s.hud === true, maxRows, quiet)
  const plan: RowPlan = { rows: kinds, owners: { ctx: null, five: null, seven: null, cost: null }, signForm: 'none', row1Shape: [], compactKeys: [] }
  const rows: DrawnRows = {}
  const first = kinds[0]
  if (first === 'line') {
    const fit = lineFit(s, wide)
    rows.line = fit.spans
    plan.signForm = fit.sign
    plan.row1Shape = fit.keys
    plan.owners = { ctx: fit.ctx ? 'line' : null, five: fit.five ? 'line' : null, seven: fit.seven ? 'line' : null, cost: null }
  } else if (first === 'compact') {
    const fit = compactFit(s, wide)
    rows.compact = fit.spans
    plan.signForm = fit.sign
    plan.compactKeys = fit.keys
    // The HUD row draws what the compact line did not.
    plan.owners = { ctx: 'hud', five: 'hud', seven: 'hud', cost: 'hud' }
    for (const key of fit.keys) {
      const owned = COMPACT_OWNED[key]
      if (owned !== undefined) plan.owners[owned] = 'compact'
    }
  } else if (first === 'row1') {
    const hudRow = kinds.includes('hud')
    const fit = row1Fit(s, wide, !hudRow)
    rows.row1 = fit.spans
    plan.signForm = fit.sign
    plan.row1Shape = fit.keys
    // With a HUD row it owns all four. Without one, row 1 owns ctx when it kept it; limits and cost are not drawn.
    plan.owners = hudRow ? { ctx: 'hud', five: 'hud', seven: 'hud', cost: 'hud' } : { ctx: fit.keys.includes('ctx') ? 'row1' : null, five: null, seven: null, cost: null }
  }
  if (kinds.includes('goal')) rows.goal = goalSpans(s, wide)
  return { plan, rows }
}

/** The plan alone: which rows draw, who owns each number, the sign form and the kept fields. */
export const rowPlan = (s: BandState, maxRows: number, width: number, quiet: boolean): RowPlan => planOf(s, maxRows, width, quiet).plan

/** The plan and the spans of its `line`, `compact`, `row1` and `goal` rows, from one fit, so the plan and the drawing cannot disagree. */
export const bandRows = (s: BandState, maxRows: number, width: number, quiet: boolean): { plan: RowPlan; rows: DrawnRows } => planOf(s, maxRows, width, quiet)

/** The HUD part keys (`hudParts` skip list) of every number another row of the plan draws. */
export const hudSkipKeys = (plan: RowPlan): string[] => {
  const keys: [keyof RowPlan['owners'], string][] = [
    ['ctx', 'hud-ctx'],
    ['cost', 'hud-cost'],
    ['five', 'hud-limit-five_hour'],
    ['seven', 'hud-limit-seven_day'],
  ]
  return keys.filter(([number]) => plan.owners[number] !== 'hud').map(([, key]) => key)
}
