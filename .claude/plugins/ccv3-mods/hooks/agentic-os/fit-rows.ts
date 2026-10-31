import { redact } from '../shared/redact'
import { cellWidth } from './cells'
import { clip } from './model'
import type { PaneRow, Span } from './pane-model'

// Row helpers the /os tabs share (os-tabs-model.ts, session-tab.ts, work-tab.ts). Pure: no engine, no clock, no state.
// Every drawn row is redacted again (idempotent) and only then cut to the width, so a secret in any source cannot reach a row whole or in half.

const sp = (text: string, tone: Span['tone']): Span => ({ text, tone })

export const width = (spans: Span[] = []): number => spans.reduce((n, one) => n + cellWidth(one.text), 0)

/** Cuts a run of spans to `max` terminal cells (a wide letter takes 2), with an ellipsis on the span it cuts. */
export const clipSpans = (spans: Span[], max: number): Span[] => {
  const out: Span[] = []
  let room = Math.max(0, max)
  for (const one of spans) {
    if (room <= 0) break
    const text = clip(one.text, room)
    out.push({ ...one, text })
    room -= cellWidth(text)
  }
  return out
}

export const fitRow = (row: PaneRow, columns: number): PaneRow => {
  const cap = Math.max(1, columns)
  // The right group never takes more than half the row; on a narrow pane it goes, and the left carries the meaning.
  const right = row.right && cap >= 24 ? clipSpans(row.right, Math.floor(cap / 2)) : undefined
  const left = clipSpans(row.left, cap - (right ? width(right) + 1 : 0))
  return { key: row.key, left, ...(right && right.length > 0 ? { right } : {}) }
}

export const scrub = (row: PaneRow): PaneRow => ({
  ...row,
  left: row.left.map(one => ({ ...one, text: redact(one.text).text })),
  ...(row.right ? { right: row.right.map(one => ({ ...one, text: redact(one.text).text })) } : {}),
})

/** The last step of every tab: redact, then cut to the width. */
export const scrubFit = (row: PaneRow, columns: number): PaneRow => fitRow(scrub(row), columns)

export const line = (key: string, ...left: Span[]): PaneRow => ({ key, left })

/** A "+N more" row. Each list gives its own `key`: two lists in one tab must not share one. */
export const more = (key: string, hidden: number): PaneRow => line(key, sp(`  +${hidden} more`, 'dim'))

/** Whole groups of rows (a group is one item) that fit `budget`; what does not fit becomes one "+N more" row that counts groups. */
export const takeGroups = (groups: PaneRow[][], budget: number, moreKey: string): PaneRow[] => {
  if (budget <= 0) return []
  const total = groups.reduce((n, group) => n + group.length, 0)
  if (total <= budget) return groups.flat()
  const out: PaneRow[] = []
  let used = 0
  let shown = 0
  for (const group of groups) {
    if (used + group.length > budget - 1) break
    out.push(...group)
    used += group.length
    shown++
  }
  return [...out, more(moreKey, groups.length - shown)]
}

/** A tab section: its head row and its item groups. */
export type Section = { head: PaneRow; groups: PaneRow[][] }

/**
 * The item groups of every section, in order, for takeGroups. A head stays with the first row under it, so a cut never leaves a bare head. When that
 * first item has more rows (a note, a wrapped line), they are a group of their own: a pane of 3 rows can then still show a head and its first row.
 */
export const groupSections = (sections: Section[]): PaneRow[][] =>
  sections.flatMap(section =>
    section.groups.flatMap((group, i) => {
      if (i > 0) return [group]
      const [first, ...rest] = group
      return first === undefined ? [[section.head]] : rest.length > 0 ? [[section.head, first], rest] : [[section.head, first]]
    }),
  )

/** just now, Nm ago, Nh ago, Nd ago. */
export const ago = (now: number, at: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** now, Nm, Nh, Nd (the age of the right group on a briefing row). A time ahead of the clock reads now. */
export const shortAge = (now: number, at: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
