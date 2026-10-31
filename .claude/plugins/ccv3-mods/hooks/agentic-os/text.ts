import { redact } from '../shared/redact'
import { cellWidth, cutCells, splitCells } from './cells'
import type { PaneRow, Span, Tone } from './pane-model'

// The /os text step. Pure: no engine, no clock, no state. Every row of the pane passes through it.
//   oneLine  redact the whole string first, make it one line, cap it
//   wrap     redact first, then wrap: a secret cannot hide across a line break
//   wrapRows wrap text into PaneRows: line 1 carries the lead and an optional right group, later lines indent
// Observer only: it injects nothing into the session.

/** Control characters, line breaks, and the zero-width and bidi characters that hide text or turn a row round (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g
const TEXT_MAX = 400
/** The wrap works on at most this many characters: more is cut by oneLine and always shows as cut at pane widths. */
const WRAP_MAX = 2000
/** The tab name shows only when this many cells stay free for the text beside it. */
const HINT_ROOM = 12
const ELLIPSIS = '…'

/** One line, redacted, at most `max` characters. The redaction runs on the whole text before any cut. A value that is not a string gives ''. */
export const oneLine = (value: unknown, max: number = TEXT_MAX): string => {
  if (typeof value !== 'string') return ''
  const one = redact(value).text.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim()
  if (one.length <= max) return one
  // The cut is in UTF-16 units; it never leaves half of a surrogate pair.
  const cut = Math.max(0, max - 1)
  const half = cut > 0 && (one.charCodeAt(cut - 1) & 0xfc00) === 0xd800
  return `${one.slice(0, half ? cut - 1 : cut)}${ELLIPSIS}`
}

/** Greedy layout. `width(i)` is the room of line i; a width of 0 or less leaves that line empty. A word longer than its line is hard-broken. */
const layout = (text: string, width: (line: number) => number): string[] => {
  const lines: string[] = []
  let current = ''
  let used = 0
  for (let word of text.split(' ')) {
    if (word === '') continue
    for (;;) {
      const room = width(lines.length)
      if (room <= 0) {
        lines.push('')
        continue
      }
      if (current === '') {
        const [piece, rest] = splitCells(word, room)
        if (rest === '') {
          current = piece
          used = cellWidth(piece)
          break
        }
        lines.push(piece)
        word = rest
        continue
      }
      const wordCells = cellWidth(word)
      if (used + 1 + wordCells <= room) {
        current += ` ${word}`
        used += 1 + wordCells
        break
      }
      lines.push(current)
      current = ''
      used = 0
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/** `line` plus `tail` inside `room` cells: trailing words of the line go first, then characters. */
const attach = (line: string, room: number, tail: string, joiner: string): string => {
  const space = room - cellWidth(tail) - joiner.length
  if (space <= 0) return cutCells(tail, room)
  let kept = line
  while (cellWidth(kept) > space) {
    const at = kept.lastIndexOf(' ')
    if (at < 0) {
      kept = cutCells(kept, space)
      break
    }
    kept = kept.slice(0, at)
  }
  kept = kept.trimEnd()
  return kept === '' ? tail : `${kept}${joiner}${tail}`
}

type Wrapped = { lines: string[]; cut: boolean }

/** A whole count of at least 1. NaN and infinity give 1: a count that is not finite must not stop the layout. */
const cells = (count: number): number => (Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1)

const wrapWith = (value: string, width: (line: number) => number, maxLines: number, hint?: string, homeHoldsMore?: boolean): Wrapped => {
  const limit = cells(maxLines)
  const text = oneLine(value, WRAP_MAX)
  if (text === '') return { lines: [], cut: false }
  const all = layout(text, width)
  const cut = all.length > limit
  const lines = all.slice(0, limit)
  const named = oneLine(hint, 40)
  const last = limit - 1
  const form = named !== '' && width(last) - cellWidth(`${ELLIPSIS}more -> ${named}`) >= HINT_ROOM ? `${ELLIPSIS}more -> ${named}` : `${ELLIPSIS}more`
  const tail = named === '' ? ELLIPSIS : form
  const joiner = named === '' ? '' : ' '
  if (cut) {
    lines[last] = attach(lines[last] ?? '', width(last), tail, joiner)
    return { lines, cut }
  }
  // The home tab holds more than the row shows: say so even when the text fits.
  if (named !== '' && homeHoldsMore === true) {
    const end = lines.length - 1
    const room = width(end)
    if (cellWidth(lines[end] ?? '') + 1 + cellWidth(tail) <= room) lines[end] = `${lines[end]} ${tail}`
    else if (lines.length < limit) lines.push(cutCells(tail, width(lines.length)))
    else lines[end] = attach(lines[end] ?? '', room, tail, joiner)
  }
  return { lines, cut }
}

/**
 * `text` as lines of at most `columns` cells, at most `maxLines` of them. The text is redacted before the wrap. A cut text ends its
 * last line with an ellipsis; with a `hint` (a tab name) that is `…more -> <hint>`, or a bare `…more` when the line is too narrow
 * for the name. `homeHoldsMore` shows the hint even when the text fits (the home tab holds more than the row).
 */
export const wrap = (text: string, columns: number, maxLines: number, hint?: string, homeHoldsMore?: boolean): Wrapped => {
  const room = cells(columns)
  return wrapWith(text, () => room, maxLines, hint, homeHoldsMore)
}

const widthOf = (spans: readonly Span[] = []): number => spans.reduce((n, one) => n + cellWidth(one.text), 0)

/** Text smaller than this cannot sit beside a lead and a right group on line 1. */
const MIN_FIRST = 8
const RIGHT_MIN_COLUMNS = 24

export type WrapRowsOptions = { right?: Span[]; hint?: string; indent?: number; homeHoldsMore?: boolean }

/**
 * The rows of one item. Line 1 holds `lead` and the text, and leaves room for the right group (an age) when the pane is
 * wide enough to keep it. Later lines indent (default 4). Keys are `key`, `key-2`, `key-3`. No row is wider than `columns`.
 */
export const wrapRows = (key: string, lead: Span[], text: string, tone: Tone, columns: number, maxLines: number, opts: WrapRowsOptions = {}): PaneRow[] => {
  const cols = cells(columns)
  const indent = Math.min(Math.max(0, Math.floor(opts.indent ?? 4)), Math.max(0, cols - 1))
  // A lead wider than the pane is cut: nothing may pass the width.
  let used = 0
  const head: Span[] = []
  for (const one of lead) {
    const room = cols - used
    if (room <= 0) break
    const part = cellWidth(one.text) > room ? cutCells(one.text, room) : one.text
    head.push({ ...one, text: part })
    used += cellWidth(part)
  }
  const right = opts.right !== undefined && opts.right.length > 0 && cols >= RIGHT_MIN_COLUMNS && cols - used - widthOf(opts.right) - 1 >= MIN_FIRST ? opts.right : undefined
  const first = cols - used - (right === undefined ? 0 : widthOf(right) + 1)
  const wrapped = wrapWith(text, line => (line === 0 ? first : cols - indent), maxLines, opts.hint, opts.homeHoldsMore)
  const rows: PaneRow[] = [{ key, left: [...head, ...(wrapped.lines[0] === undefined || wrapped.lines[0] === '' ? [] : [{ text: wrapped.lines[0], tone }])], ...(right === undefined ? {} : { right }) }]
  wrapped.lines.slice(1).forEach((line, i) => {
    rows.push({ key: `${key}-${i + 2}`, left: [{ text: `${' '.repeat(indent)}${line}`, tone }] })
  })
  return rows
}
