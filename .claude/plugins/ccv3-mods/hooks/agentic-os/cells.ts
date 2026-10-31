// Terminal cell width for the /os pane. Pure: no engine, no clock, no state. No dependency: a small range table.
//   cellWidth   how many terminal cells a text takes: East Asian Wide and Fullwidth letters and emoji 2, combining and zero-width marks 0, the rest 1
//   cutCells    the longest prefix that fits `max` cells; it cuts between code points and never splits a surrogate pair or parts a mark from its base
//   splitCells  `cutCells` plus the rest; a first letter that cannot fit becomes one ellipsis, so a loop that cuts always moves on
// The table is a safe estimate, not the whole of Unicode: an unlisted letter counts 1, a letter that is wide in some terminals only counts 2.
// A U+FE0F after a narrow letter counts it as 2 (the emoji form). The pane draws `✓ ✗ ● ○ ▶ ■ … ·`: all 1 cell. Observer only.

type Ranges = readonly (readonly [number, number])[]

const ZERO: Ranges = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
]

const WIDE: Ranges = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

const inside = (ranges: Ranges, code: number): boolean => ranges.some(([from, to]) => code >= from && code <= to)

const ELLIPSIS = '…'

/** Most pane text is this: every letter is one cell, so the length is the width and no step is built. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** The cells of one code point. Plain ASCII and Latin skip the tables. */
const cellsOf = (code: number): number => (code < 0x300 ? 1 : inside(ZERO, code) ? 0 : inside(WIDE, code) ? 2 : 1)

/** One step: the code point at `at`, the zero-width marks that follow it, and where they end. */
const stepAt = (text: string, at: number): { end: number; cells: number } => {
  const first = text.codePointAt(at) ?? 0
  let end = at + (first > 0xffff ? 2 : 1)
  let cells = cellsOf(first)
  while (end < text.length) {
    const next = text.codePointAt(end) ?? 0
    if (cellsOf(next) !== 0) break
    if (next === 0xfe0f && cells === 1) cells = 2
    end += next > 0xffff ? 2 : 1
  }
  return { end, cells }
}

/** How many terminal cells `text` takes. */
export const cellWidth = (text: string): number => {
  if (PRINTABLE_ASCII.test(text)) return text.length
  let total = 0
  for (let at = 0; at < text.length; ) {
    const step = stepAt(text, at)
    total += step.cells
    at = step.end
  }
  return total
}

/** Where the longest prefix that fits `max` cells ends (a UTF-16 offset). */
const fitEnd = (text: string, max: number): number => {
  // Plain ASCII up to one letter past the cut: every letter is a cell and no mark follows the cut.
  if (PRINTABLE_ASCII.test(text.slice(0, max + 1))) return Math.min(max, text.length)
  let used = 0
  let at = 0
  while (at < text.length) {
    const step = stepAt(text, at)
    if (used + step.cells > max) break
    used += step.cells
    at = step.end
  }
  return at
}

/** The longest prefix of `text` that takes at most `max` cells. */
export const cutCells = (text: string, max: number): string => text.slice(0, fitEnd(text, Math.max(0, max)))

/**
 * The prefix that fits `room` cells and the rest. When the first letter alone is wider than `room`, it is dropped and the prefix is one
 * ellipsis (1 cell): the rest is always shorter than `text`, so a loop that splits always ends. `room` must be 1 or more.
 */
export const splitCells = (text: string, room: number): [string, string] => {
  const end = fitEnd(text, room)
  return end > 0 || text === '' ? [text.slice(0, end), text.slice(end)] : [ELLIPSIS, text.slice(stepAt(text, 0).end)]
}
