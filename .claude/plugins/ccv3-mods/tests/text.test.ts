import { describe, expect, test } from 'claude-code/testing'

import { oneLine, wrap } from '../hooks/agentic-os/text'

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
