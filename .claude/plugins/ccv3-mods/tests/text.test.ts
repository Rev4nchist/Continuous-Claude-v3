import { describe, expect, test } from 'claude-code/testing'

import type { PaneRow, Span } from '../hooks/agentic-os/pane-model'
import { cellWidth, cutCells, splitCells } from '../hooks/agentic-os/cells'
import { goalOfNote } from '../hooks/agentic-os/goal-extractor'
import { oneLine, wrap, wrapRows } from '../hooks/agentic-os/text'

// /os redesign, round 1: hooks/agentic-os/text.ts, the pure text step every pane row passes through.
//   oneLine(value, max = 400)                       redact the whole string, collapse control chars and spaces, cap
//   wrap(text, columns, maxLines, hint?, homeHoldsMore?) -> { lines, cut }
//
// Contract these tests pin (the plan left these holes; the choices are mine and the implementer must follow them or change the test):
//   - `hint` is the tab name ('Work'). A cut text ends its last line with "...more -> Work". The ellipsis may be the three
//     characters or the single glyph, so the tests match /(\.\.\.|…)more/ (digest.ts uses the glyph, the plan text uses three dots).
//   - The fifth argument `homeHoldsMore` is the hint rule of the plan ("an item whose home tab holds more always shows the hint"):
//     with it true and a hint given, the hint shows even when the text fits. Without it, a text that fits gets no hint (X3).
//   - At 20 columns the hint falls back to "...more" with no tab name (plan decision). The test pins the observable rule at 20 and at
//     60 columns, not the arithmetic in between.
//   - `lines` is [] (or one empty string) for empty input; the tests accept both and pin `cut === false`.
//
// Ways the text step can fail, one test each:
// X1  a row is wider than `columns` (a long word is not hard-broken, or the hint pushes the last line over), at 20 to 200 columns
// X2  more than `maxLines` rows come back, or a cut text is cut silently (no ellipsis, no hint, `cut` false)
// X3  a text that fits gets a hint anyway (the hint must mean "there is more")
// X4  a secret split by a wrap boundary escapes the redaction: redaction must run on the whole string before the wrap
// X5  control characters or newlines in the input draw a multi-line or control-char row
// X6  oneLine of a non-string throws or prints 'undefined'/'null'
// X7  oneLine cuts first and redacts after, so a cut secret leaks its first characters
// X8  oneLine keeps control characters or runs of spaces
// X9  oneLine does not cap at 400, ignores a custom cap, or cuts a text that fits
// X10 a 5,000-character word, or empty input, breaks the rows or the cut flag
// X11 at 20 columns the hint still names the tab (it cannot fit), or at 60 columns it is missing
// X12 the greedy wrap breaks a word that fits, or reorders words
// X13 the "home tab holds more" flag is ignored, or adds a hint with no hint given
// X14 a NaN or infinite column or line count loops forever or returns an unbounded row
// X15 wrapRows draws a row wider than the pane (lead, right group, indent or hint), from 20 to 200 columns
// X16 wrapRows loses the right group on a pane wide enough for it, or keeps it on one too narrow

const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const PROSE = 'The quick brown fox jumps over the lazy dog and keeps running through the long grass until night falls again. '.repeat(8)
const HINT_END = (tab: string) => new RegExp(`(?:\\.\\.\\.|…)more -> ${tab}$`)
const BARE_MORE_END = /(?:\.\.\.|…)more$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const widest = (lines: string[]): number => lines.reduce((n, line) => Math.max(n, line.length), 0)
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean)

describe('oneLine', () => {
  test('X6 a value that is not a string gives an empty string', () => {
    for (const value of [undefined, null, 5, {}, ['a'], true]) expect(oneLine(value)).toBe('')
  })

  test('X7 a secret that the cap would cut in half is redacted first, so no part of it is left', () => {
    const text = `${'x'.repeat(380)} ${SECRET} tail`
    const out = oneLine(text)
    expect(out.length).toBeLessThanOrEqual(400)
    expect(out).not.toContain('sk-ant')
    expect(out).not.toMatch(/a{8}/)
    expect(out).toContain('xxxx')
  })

  test('X8 control characters, newlines and runs of spaces become single spaces', () => {
    expect(oneLine('a\n\n b\t\tc\u0001d\u2028e   f')).toBe('a b c d e f')
    expect(oneLine('  padded  ')).toBe('padded')
    expect(oneLine('x\u0000\u007fy')).not.toMatch(CONTROL)
  })

  test('X9 the cap is 400 by default and the given max otherwise; a text that fits is not cut', () => {
    const long = oneLine('y'.repeat(1000))
    expect(long).toHaveLength(400)
    expect(long.endsWith('…')).toBe(true)
    const short = oneLine('y'.repeat(1000), 10)
    expect(short).toHaveLength(10)
    expect(short.endsWith('…')).toBe(true)
    expect(oneLine('y'.repeat(400))).toBe('y'.repeat(400))
    expect(oneLine('short')).toBe('short')
  })
})

// coord-oneline-marker-split: the cut never leaves part of a [REDACTED:kind] marker. The drop works on the length the cut keeps.
//   M1  a marker that the cut lands inside is dropped whole, at the default cap
//   M2  a marker that ends exactly at the cut stays
//   M3  a marker wholly before the cut stays
//   M4  two markers: the one before the cut stays, the one across it drops
//   M5  text that starts like a marker but holds a space is not a marker: the plain cut stays, byte for byte
//   M6  a surrogate pair just before a marker that crosses the cut stays whole, the marker drops
//   M7  the surrogate guard still shortens the cut by one, and a marker after the cut is not touched
//   M8  a small cap (30, as wrap, digest and journal use) drops the marker that crosses it
//   M9  marker-free text keeps the plain cut byte for byte, and goalOfNote reads it unchanged
//   M10 a long PARKED line whose cut splits a marker gives a goal with no marker fragment (the PR 670 Known limit)
describe('oneLine marker cut', () => {
  const MARK = '[REDACTED:api_key]'
  const X = (count: number): string => 'x'.repeat(count)

  test('M1 a marker that the cut lands inside is dropped whole', () => {
    const out = oneLine(X(390) + MARK)
    expect(out).toBe(`${X(390)}…`)
    expect(out).not.toContain('[REDACTED')
  })

  test('M2 a marker that ends exactly at the cut stays', () => {
    expect(oneLine(X(381) + MARK + 'yyyyy')).toBe(`${X(381)}${MARK}…`)
  })

  test('M3 a marker wholly before the cut stays', () => {
    const out = oneLine(X(100) + MARK + 'z'.repeat(400))
    expect(out).toBe(`${(X(100) + MARK + 'z'.repeat(400)).slice(0, 399)}…`)
    expect(out).toContain(MARK)
  })

  test('M4 two markers: the one before the cut stays and the one across it drops', () => {
    expect(oneLine(X(300) + MARK + 'y'.repeat(70) + MARK)).toBe(`${X(300)}${MARK}${'y'.repeat(70)}…`)
  })

  test('M5 text that starts like a marker but holds a space keeps the plain cut', () => {
    const text = X(390) + '[REDACTED: x]'
    expect(oneLine(text)).toBe(`${text.slice(0, 399)}…`)
  })

  test('M6 a surrogate pair just before a marker that crosses the cut stays whole', () => {
    expect(oneLine(X(396) + '😀' + MARK)).toBe(`${X(396)}😀…`)
  })

  test('M7 the surrogate guard still cuts one earlier, and a marker after the cut is left alone', () => {
    expect(oneLine(X(398) + '😀' + MARK)).toBe(`${X(398)}…`)
  })

  test('M8 a small cap drops the marker that crosses it: the text before it, then the ellipsis', () => {
    expect(oneLine(X(20) + MARK, 30)).toBe(`${X(20)}…`)
    expect(oneLine(X(5) + MARK + MARK, 30)).toBe(`${X(5)}${MARK}…`)
  })

  test('M9 marker-free text keeps the plain cut byte for byte, and goalOfNote reads it unchanged', () => {
    const note = `GOAL: ${'alpha beta '.repeat(60)}NEXT: go`
    const plain = `${note.slice(0, 399)}…`
    expect(oneLine(note)).toBe(plain)
    expect(goalOfNote(oneLine(note))).toBe(goalOfNote(plain))
    const goal = goalOfNote(oneLine(note))
    expect(goal).not.toBeNull()
    expect((goal as string).length).toBeLessThanOrEqual(200)
    expect((goal as string).endsWith('…')).toBe(true)
  })

  test('M10 a long PARKED line whose cut splits a marker gives a goal with no marker fragment', () => {
    const head = `PARKED until Mon 11-23 09:00 -- ${'r'.repeat(300)} || GOAL: ship the fix `
    const pad = 395 - head.length
    const goal = goalOfNote(oneLine(head + 'g'.repeat(pad) + MARK))
    expect(pad).toBeGreaterThan(0)
    expect(goal).not.toBeNull()
    expect(goal).not.toContain('[REDACTED')
    expect(goal).toBe(`ship the fix ${'g'.repeat(pad)}…`)
  })
})

const spanWidth = (spans: readonly Span[] = []): number => spans.reduce((n, one) => n + one.text.length, 0)
/** Cells a row draws: the left spans, and the right group with its one-cell gap. */
const rowWidth = (row: PaneRow): number => spanWidth(row.left) + (row.right === undefined ? 0 : spanWidth(row.right) + 1)

describe('wrapRows', () => {
  const LEADS: Record<string, Span[]> = {
    none: [],
    short: [{ text: '> ', tone: 'active' }],
    two: [{ text: '[ok] ', tone: 'ok' }, { text: 'lane-name ', tone: 'head' }],
    wide: [{ text: 'L'.repeat(300), tone: 'head' }],
  }
  const RIGHTS: Record<string, Span[] | undefined> = { none: undefined, age: [{ text: '3m', tone: 'dim' }], group: [{ text: '12 files ', tone: 'dim' }, { text: '2h ago', tone: 'dim' }] }

  test('X15 no row is wider than the columns, from 20 to 200 columns, with every lead, right group, line count and hint', () => {
    const texts = [PROSE, 'z'.repeat(5000), 'short']
    for (const [leadName, lead] of Object.entries(LEADS)) {
      for (const [rightName, right] of Object.entries(RIGHTS)) {
        for (const text of texts) {
          for (let columns = 20; columns <= 200; columns += 9) {
            for (const maxLines of [1, 2, 3, 5]) {
              for (const [hint, homeHoldsMore] of [[undefined, false], ['Decisions', false], ['Decisions', true]] as const) {
                const rows = wrapRows('k', lead, text, 'dim', columns, maxLines, { ...(right === undefined ? {} : { right }), ...(hint === undefined ? {} : { hint }), homeHoldsMore })
                const label = `lead=${leadName} right=${rightName} cols=${columns} lines=${maxLines} hint=${String(hint)} more=${homeHoldsMore}`
                expect(rows.length, label).toBeLessThanOrEqual(maxLines)
                for (const row of rows) expect(rowWidth(row), label).toBeLessThanOrEqual(columns)
              }
            }
          }
        }
      }
    }
  })

  test('X15 later rows indent, keys count up, and the indent never passes the pane', () => {
    const rows = wrapRows('item', [{ text: '> ', tone: 'active' }], PROSE, 'dim', 40, 4)
    expect(rows.map(one => one.key)).toEqual(['item', 'item-2', 'item-3', 'item-4'])
    expect(rows[0]?.left[0]?.text).toBe('> ')
    for (const row of rows.slice(1)) expect(row.left[0]?.text.startsWith('    ')).toBe(true)
    const deep = wrapRows('item', [], PROSE, 'dim', 20, 3, { indent: 500 })
    for (const row of deep) expect(rowWidth(row)).toBeLessThanOrEqual(20)
  })

  test('X16 the right group shows on line 1 of a wide pane only, and a cut text keeps the hint', () => {
    const right: Span[] = [{ text: '3m', tone: 'dim' }]
    const lead: Span[] = [{ text: '> ', tone: 'active' }]
    const wide = wrapRows('k', lead, PROSE, 'dim', 80, 3, { right, hint: 'Work' })
    expect(wide[0]?.right).toEqual(right)
    expect(wide.slice(1).every(one => one.right === undefined)).toBe(true)
    expect(wide.at(-1)?.left.map(one => one.text).join('')).toMatch(HINT_END('Work'))
    expect(wrapRows('k', lead, PROSE, 'dim', 20, 3, { right })[0]?.right).toBeUndefined()
  })

  test('X14 a NaN pane width ends and draws rows of one cell', () => {
    const rows = wrapRows('k', [], PROSE, 'dim', Number.NaN, 3)
    expect(rows.length).toBeLessThanOrEqual(3)
    for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(1)
  })
})

describe('wrap', () => {
  test('X1 no row is wider than the columns, from 20 to 200 columns, with and without a hint, for prose and a 5,000 character word', () => {
    const inputs = [PROSE, 'z'.repeat(5000), `${PROSE} ${'q'.repeat(300)} ${PROSE}`, 'a b c d e f g h i j k l m n o p q r s t u v w x y z']
    for (const text of inputs) {
      for (let columns = 20; columns <= 200; columns += 7) {
        for (const maxLines of [1, 2, 3, 5]) {
          for (const hint of [undefined, 'Decisions']) {
            const out = wrap(text, columns, maxLines, hint)
            expect(widest(out.lines)).toBeLessThanOrEqual(columns)
            expect(out.lines.length).toBeLessThanOrEqual(maxLines)
          }
        }
      }
    }
  })

  test('X1 a word longer than the line is hard-broken at the column count', () => {
    const out = wrap('x'.repeat(50), 20, 5)
    expect(out.lines).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)])
    expect(out.cut).toBe(false)
  })

  test('X12 the wrap is greedy and keeps every word that fits whole and in order', () => {
    expect(wrap('alpha beta gamma delta', 12, 5).lines).toEqual(['alpha beta', 'gamma delta'])
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    for (let columns = 20; columns <= 40; columns += 3) {
      const out = wrap(text, columns, 20)
      expect(words(out.lines.join(' '))).toEqual(words(text))
      expect(out.cut).toBe(false)
    }
  })

  test('X2 a cut text has exactly maxLines rows, says cut, and ends its last row with the ellipsis and the hint', () => {
    const out = wrap(PROSE, 40, 2, 'Work')
    expect(out.cut).toBe(true)
    expect(out.lines).toHaveLength(2)
    expect(out.lines[1]).toMatch(HINT_END('Work'))
    expect(out.lines[0]).not.toMatch(/more/)
    expect(out.lines[0]?.startsWith('The quick brown fox')).toBe(true)
  })

  test('X2 a cut text with no hint still ends with an ellipsis', () => {
    const out = wrap(PROSE, 40, 2)
    expect(out.cut).toBe(true)
    expect(out.lines).toHaveLength(2)
    expect(out.lines[1]).toMatch(/(?:\.\.\.|…)$/)
  })

  test('X2 the same text is cut at one row and whole at ten rows', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta'
    expect(wrap(text, 14, 1, 'Work').cut).toBe(true)
    const whole = wrap(text, 14, 10, 'Work')
    expect(whole.cut).toBe(false)
    expect(whole.lines.join(' ')).toBe(text)
  })

  test('X3 a text that fits gets no hint and is not cut', () => {
    const out = wrap('short text', 40, 3, 'Work')
    expect(out.lines).toEqual(['short text'])
    expect(out.cut).toBe(false)
    expect(out.lines.join('')).not.toMatch(/more|Work/)
  })

  test('X13 with the home-tab flag a text that fits still shows the hint, within the width', () => {
    const out = wrap('short text', 40, 3, 'Work', true)
    expect(out.lines[0]?.startsWith('short text')).toBe(true)
    expect(out.lines.at(-1)).toMatch(HINT_END('Work'))
    expect(out.lines.length).toBeLessThanOrEqual(3)
    expect(widest(out.lines)).toBeLessThanOrEqual(40)
    expect(wrap('short text', 40, 3, undefined, true).lines.join(' ')).not.toMatch(/more|->/)
  })

  test('X4 a secret split by the wrap boundary is redacted whole: no run of the secret in any join of the rows', () => {
    const out = wrap(`note ${SECRET} end`, 20, 6)
    for (const joined of [out.lines.join(''), out.lines.join(' '), out.lines.join('\n')]) {
      expect(joined).not.toContain('sk-ant')
      expect(joined).not.toMatch(/a{10}/)
    }
    expect(out.lines.join('')).toContain('[REDACTED')
  })

  test('X4 a bearer token whose word falls on the next row, and a key=value that is longer than a row, are redacted', () => {
    const bearer = wrap('Authorization: Bearer abcdEFGH1234ijklMNOP5678', 20, 6)
    expect(bearer.lines.join('')).not.toContain('abcdEFGH')
    expect(bearer.lines.join('')).toContain('[REDACTED')
    const credential = wrap('API_KEY=hunter2hunter2hunter2 done', 20, 6)
    expect(credential.lines.join('')).not.toContain('hunter2hunter2')
    expect(credential.lines.join('')).toContain('[REDACTED')
  })

  test('X5 control characters and newlines in the input give single-line rows', () => {
    const out = wrap('one\ntwo\r\nthree\tfour\u0001five', 12, 5)
    for (const line of out.lines) expect(line).not.toMatch(CONTROL)
    expect(out.lines.join(' ')).toBe('one two three four five')
  })

  test('X10 a 5,000 character word fills maxLines rows, is cut, and carries the hint', () => {
    const out = wrap('w'.repeat(5000), 30, 3, 'Work')
    expect(out.lines).toHaveLength(3)
    expect(widest(out.lines)).toBeLessThanOrEqual(30)
    expect(out.cut).toBe(true)
    expect(out.lines[2]).toMatch(HINT_END('Work'))
  })

  test('X10 empty and blank input give no text, no hint and no cut', () => {
    for (const text of ['', '   ', '\n\t']) {
      const out = wrap(text, 40, 3, 'Work')
      expect(out.lines.join('')).toBe('')
      expect(out.cut).toBe(false)
    }
  })

  test('X11 at 20 columns a cut text ends with a bare "...more" and no tab name; at 60 columns it names the tab', () => {
    const narrow = wrap(PROSE, 20, 2, 'Decisions')
    expect(widest(narrow.lines)).toBeLessThanOrEqual(20)
    expect(narrow.lines).toHaveLength(2)
    expect(narrow.lines[1]).toMatch(BARE_MORE_END)
    expect(narrow.lines.join(' ')).not.toMatch(/Decisions|->/)
    const wide = wrap(PROSE, 60, 2, 'Decisions')
    expect(widest(wide.lines)).toBeLessThanOrEqual(60)
    expect(wide.lines[1]).toMatch(HINT_END('Decisions'))
  })

  test('X14 a column or line count that is not a finite number ends and keeps every row within one cell', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const columnsBad = wrap(PROSE, bad, 3, 'Work')
      expect(widest(columnsBad.lines)).toBeLessThanOrEqual(1)
      expect(columnsBad.lines.length).toBeLessThanOrEqual(3)
      const linesBad = wrap(PROSE, 40, bad, 'Work')
      expect(linesBad.lines).toHaveLength(1)
      expect(linesBad.cut).toBe(true)
      expect(widest(linesBad.lines)).toBeLessThanOrEqual(40)
    }
  })

  test('X11 the hint never overflows from 20 to 200 columns: the last row says more, and names the tab from 40 columns up', () => {
    for (let columns = 20; columns <= 200; columns += 5) {
      const out = wrap(PROSE, columns, 2, 'Decisions')
      const last = out.lines.at(-1) ?? ''
      expect(last.length).toBeLessThanOrEqual(columns)
      expect(last).toMatch(/more/)
      if (columns >= 40) expect(last).toMatch(HINT_END('Decisions'))
    }
  })
})

// Terminal cells, not UTF-16 units: a wide letter (CJK, fullwidth) or an emoji takes 2 cells, a combining mark 0. Measured here with Unicode
// properties, not with the code under test.
const CELLS_OF = (text: string): number =>
  [...text].reduce((n, ch) => n + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Emoji_Presentation}　-〾＀-｠]/u.test(ch) ? 2 : /[\p{Mn}​-‏]/u.test(ch) ? 0 : 1), 0)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const CJK_TEXT = '日本語のとても長い文章です '.repeat(30)
const EMOJI_TEXT = `ab ${'🚀🎉🔥'.repeat(40)} cd é${'ＡＢ'.repeat(30)}`

describe('cells', () => {
  // X17 wrap or wrapRows measures UTF-16 length: a CJK or emoji row passes the pane in cells (2 per letter), or a cut splits a surrogate pair
  test('X17 wrap keeps CJK and emoji rows inside the pane in cells, with no half surrogate, from 20 to 200 columns', () => {
    for (const text of [CJK_TEXT, EMOJI_TEXT, '日'.repeat(500), '🚀'.repeat(500)]) {
      for (let columns = 20; columns <= 200; columns += 3) {
        for (const hint of [undefined, 'Decisions']) {
          const out = wrap(text, columns, 3, hint)
          for (const line of out.lines) {
            expect(CELLS_OF(line), `${columns} ${line}`).toBeLessThanOrEqual(columns)
            expect(LONE_SURROGATE.test(line), `${columns} ${line}`).toBe(false)
          }
        }
      }
    }
  })

  test('X17 wrapRows with a lead and a right group keeps every row inside the pane in cells', () => {
    const lead: Span[] = [{ text: '  ● ', tone: 'active' }]
    const right: Span[] = [{ text: '日本 4:00', tone: 'dim' }]
    for (const text of [CJK_TEXT, EMOJI_TEXT]) {
      for (let columns = 20; columns <= 200; columns += 3) {
        for (const row of wrapRows('k', lead, text, 'todo', columns, 3, { right })) {
          const cells = row.left.reduce((n, one) => n + CELLS_OF(one.text), 0) + (row.right ? row.right.reduce((n, one) => n + CELLS_OF(one.text), 0) + 1 : 0)
          expect(cells, `${columns} ${row.key}`).toBeLessThanOrEqual(columns)
          for (const one of [...row.left, ...(row.right ?? [])]) expect(LONE_SURROGATE.test(one.text)).toBe(false)
        }
      }
    }
    // A lead of wide letters is cut to the pane in cells too.
    const wide: Span[] = [{ text: '日本語'.repeat(10), tone: 'dim' }]
    for (let columns = 1; columns <= 40; columns++) {
      const row = wrapRows('k', wide, 'x', 'todo', columns, 1)[0]!
      expect(row.left.reduce((n, one) => n + CELLS_OF(one.text), 0), `${columns}`).toBeLessThanOrEqual(columns)
    }
  })

  test('X17 a pane one cell wide cannot hold a wide letter: the wrap ends and no row passes one cell', () => {
    const out = wrap('日本語', 1, 5)
    expect(out.lines.length).toBeGreaterThan(0)
    for (const line of out.lines) expect(CELLS_OF(line)).toBeLessThanOrEqual(1)
  })

  // X17 the width table: a wide letter or an emoji is 2, a mark is 0, the glyphs the pane draws stay 1, and a cut keeps a mark with its base
  test('X17 cellWidth and cutCells: CJK and emoji take 2 cells, marks 0, pane glyphs 1; a cut keeps a mark with its base and a pair whole', () => {
    expect([cellWidth('日本'), cellWidth('🚀'), cellWidth('ＡＢ'), cellWidth('é'), cellWidth('❤️'), cellWidth('✓✗●○▶■…·'), cellWidth('abc')]).toEqual([4, 2, 4, 1, 2, 8, 3])
    expect([cutCells('日本', 3), cutCells('🚀🚀', 3), cutCells('abéd', 3), cutCells('ab​cd', 2), cutCells('日', 1), cutCells('abc', 0)]).toEqual(['日', '🚀', 'abé', 'ab​', '', ''])
    expect(splitCells('日本', 1)).toEqual(['…', '本'])
    expect(splitCells('abcde', 3)).toEqual(['abc', 'de'])
  })

  // X18 oneLine cuts at max UTF-16 units and splits an emoji
  test('X18 oneLine never cuts an emoji in half, at any cap', () => {
    for (let max = 2; max <= 40; max++) {
      const out = oneLine('🚀'.repeat(100), max)
      expect(LONE_SURROGATE.test(out), `${max}`).toBe(false)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(out).toMatch(/…$/)
    }
  })

  // X19 CONTROL misses the bidi and zero-width characters: a label can reorder the row or hide text
  test('X19 oneLine replaces zero-width, bidi and BOM characters with a space', () => {
    for (const mark of ['​', '‌', '‍', '‎', '‏', '‪', '‭', '‮', '⁦', '⁧', '⁩', '﻿']) {
      expect(oneLine(`a${mark}b`), `U+${mark.codePointAt(0)!.toString(16)}`).toBe('a b')
    }
    expect(oneLine('﻿name‮ txet')).toBe('name txet')
  })
})
