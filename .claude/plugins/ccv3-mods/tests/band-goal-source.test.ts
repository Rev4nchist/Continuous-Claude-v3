import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, mergeParsed, parseTurnEnd } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { goalSource, goalSpans } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { cellWidth } from '../hooks/agentic-os/cells'
import { goalOfNote } from '../hooks/agentic-os/goal-extractor'
import { parseBoard } from '../hooks/agentic-os/lanes-model'
import type { Span } from '../hooks/agentic-os/pane-model'

// Card coord-status-band-2, PR A wave 1 (design note .claudedocs/coordination/2026-11-18-coord-status-band-2-redesign-design.md, sections 2, 4, 7).
// The Goal row: one line, no GOAL label, no stop-at, clipped at a word by terminal cells.
//
// Ways it can fail, one test each:
// F1 the goal row shows the lane title, not the sentence of the lane note
// F2 the order is wrong, or a goal of a lane other than lanes[0] leaks in, or the empty state is not `goal not set`
// F3 the GOAL label or the stop-at text is drawn, or the lane note's NEXT part leaks into the goal
// F4 the clip counts UTF-16 units, not cells: a CJK or emoji goal passes the width
// F5 the clip cuts inside a word, a no-space goal is not hard-cut, or a [REDACTED:kind] marker is cut inside or passes the width
// X1-X4 goalOfNote: a stop is missed, the PARKED lead stays, the 200 cap fails, a redacted 400-unit line breaks

const text = (spans: Span[]): string => spans.map(span => span.text).join('')

const briefWith = (raw: Record<string, unknown>): Brief => {
  const made = applyBrief(null, raw, [], 1_000)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const parsedBrief = (): Brief => mergeParsed(null, parseTurnEnd('Restating the ask: ship the status band labels.\n\n## Next steps\n1. None - waiting on CI.'), 1_000)

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'working',
  brief: null,
  tasks: [],
  repo: 'continuous-claude',
  lane: 'dash-header',
  ctx: 41,
  costUsd: 1.84,
  now: 1_000,
  activeAt: 1_000,
  ...over,
})

describe('goal row: source', () => {
  test('F1 the lane note sentence beats the lane title and the brief_set goal', () => {
    const s = state({ laneGoal: 'Dave sees the true state of a session', laneTitle: 'Status band, second card', brief: briefWith({ goal: 'Ship the labels' }) })
    expect(goalSource(s)).toEqual({ text: 'Dave sees the true state of a session', guessed: false })
    expect(text(goalSpans(s, 80))).toBe('Dave sees the true state of a session')
  })

  test('F2 the order falls to brief_set, title, [guessed], then goal not set', () => {
    const set = briefWith({ goal: 'Ship the labels' })
    expect(goalSource(state({ brief: set, laneTitle: 'Status band, second card' }))).toEqual({ text: 'Ship the labels', guessed: false })
    expect(goalSource(state({ brief: parsedBrief(), laneTitle: 'Status band, second card' }))).toEqual({ text: 'Status band, second card', guessed: false })
    const guess = state({ brief: parsedBrief() })
    expect(goalSource(guess)?.guessed).toBe(true)
    const spans = goalSpans(guess, 80)
    expect(spans[spans.length - 1]).toEqual({ text: ' [guessed]', tone: 'dim' })
    expect(goalSource(state())).toBeNull()
    expect(goalSource(state({ laneTitle: '   ', laneGoal: '  ' }))).toBeNull()
    expect(goalSpans(state(), 80)).toEqual([{ text: 'goal not set', tone: 'dim' }])
  })

  test('F2 only lanes[0] counts: no GOAL note on lanes[0] falls to brief_set, then the title, even when another lane has a GOAL note', () => {
    const board = JSON.stringify({
      me: 'aaaaaaaa-0000-0000-0000-000000000001',
      peers: [],
      lanes: [
        { id: 'lane-one', title: 'Lane one title', state: 'active', owner_session_id: 'aaaaaaaa-0000-0000-0000-000000000001', note: 'WAITS ON lane-two | NEXT: wait' },
        { id: 'lane-two', title: 'Lane two title', state: 'active', owner_session_id: 'aaaaaaaa-0000-0000-0000-000000000001', note: 'GOAL: The second lane goal' },
      ],
    })
    const mine = parseBoard(board, 'aaaaaaaa-0000-0000-0000-000000000001', 1_000)?.mine ?? []
    expect(mine.length).toBe(2)
    const first = mine[0]
    const laneGoal = goalOfNote(first?.note)
    expect(laneGoal).toBeNull()
    expect(goalSource(state({ laneGoal, laneTitle: first?.title }))?.text).toBe('Lane one title')
    expect(goalSource(state({ laneGoal, laneTitle: first?.title, brief: briefWith({ goal: 'Ship the labels' }) }))?.text).toBe('Ship the labels')
  })

  test('F3 the row has no GOAL label and no stop-at: the text is the goal sentence only', () => {
    const s = state({ laneGoal: 'Ship the labels', brief: briefWith({ goal: 'Other goal', stopAt: 'the seat says GO' }) })
    expect(text(goalSpans(s, 80))).toBe('Ship the labels')
    const set = state({ brief: briefWith({ goal: 'Other goal', stopAt: 'the seat says GO' }) })
    expect(text(goalSpans(set, 80))).toBe('Other goal')
    expect(goalSpans(set, 80).map(span => span.tone)).toEqual(['todo'])
  })
})

describe('goal row: clip', () => {
  const long = '日本語の目標 🚀 ship the status band labels today'
  const widths = [1, 5, 12, 20]

  test('F4 the clip counts cells (CJK and emoji count 2) and never exceeds the width', () => {
    for (const width of widths) {
      for (const goal of [long, '日本語日本語日本語日本語', '🚀'.repeat(12), 'ascii words that are long enough to clip']) {
        const spans = goalSpans(state({ laneGoal: goal }), width)
        expect(cellWidth(text(spans))).toBeLessThanOrEqual(width)
        expect(text(spans).endsWith('…')).toBe(true)
      }
    }
    expect(text(goalSpans(state({ laneGoal: '日本語日本語' }), 5))).toBe('日本…')
    // A guessed goal: the tag is reserved before the clip.
    for (const width of [12, 20, 30]) {
      const spans = goalSpans(state({ brief: parsedBrief() }), width)
      expect(cellWidth(text(spans))).toBeLessThanOrEqual(width)
      expect(text(spans).endsWith(' [guessed]')).toBe(true)
    }
  })

  test('F5 the clip cuts at a word; a goal with no space is hard-cut with an ellipsis', () => {
    expect(text(goalSpans(state({ laneGoal: 'ship the status band labels' }), 14))).toBe('ship the…')
    expect(text(goalSpans(state({ laneGoal: 'ship the status band labels' }), 28))).toBe('ship the status band labels')
    expect(text(goalSpans(state({ laneGoal: 'supercalifragilistic' }), 8))).toBe('superca…')
  })

  test('F5 a [REDACTED:kind] marker is never cut inside and never passes the width', () => {
    const marker = '[REDACTED:api_key]'
    const goal = `see ${marker} now`
    expect(text(goalSpans(state({ laneGoal: goal }), 40))).toBe(goal)
    for (const width of [1, 4, 5, 8, 12, 17, 18, 21]) {
      for (const sample of [goal, marker, `a${marker}b`, `${marker}${marker}`]) {
        const out = text(goalSpans(state({ laneGoal: sample }), width))
        expect(cellWidth(out)).toBeLessThanOrEqual(width)
        // Whatever is left of the marker is the whole marker or none of it: no '[' stays once whole markers are removed.
        expect(out.replace(/…$/, '').split(marker).join('').includes('[')).toBe(false)
      }
    }
    expect(text(goalSpans(state({ laneGoal: marker }), 5))).toBe('…')
  })
})

describe('goalOfNote', () => {
  test('X1 each of the five stops ends the sentence; the GOAL: label is removed', () => {
    expect(goalOfNote('GOAL: Ship it | NEXT: build')).toBe('Ship it')
    expect(goalOfNote('GOAL: Ship it || old note')).toBe('Ship it')
    expect(goalOfNote('GOAL: Ship it WAITS ON lane-x')).toBe('Ship it')
    expect(goalOfNote('GOAL: Ship it NEXT: build')).toBe('Ship it')
    expect(goalOfNote('GOAL: Ship it MS: m1')).toBe('Ship it')
    expect(goalOfNote('Ship it with no label')).toBeNull()
    expect(goalOfNote(null)).toBeNull()
    expect(goalOfNote(undefined)).toBeNull()
    expect(goalOfNote('')).toBeNull()
    expect(goalOfNote('GOAL: | NEXT: x')).toBeNull()
  })

  test('X2 a PARKED lead is cut through its first " || "; a park note with no " || " has no goal', () => {
    expect(goalOfNote('PARKED until 2026-12-01 -- waiting || GOAL: Ship it | NEXT: x')).toBe('Ship it')
    expect(goalOfNote('PARKED until 2026-12-01 -- waiting')).toBeNull()
  })

  test('X3 the sentence is capped at 200 characters of text with an ellipsis, cut at a word', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const out = goalOfNote(`GOAL: ${words}`)
    expect(out?.length).toBeLessThanOrEqual(200)
    expect(out?.endsWith('…')).toBe(true)
    expect(out?.slice(0, -1).endsWith(' ')).toBe(false)
    expect(goalOfNote(`GOAL: ${'x'.repeat(250)}`)).toBe(`${'x'.repeat(199)}…`)
  })

  test('X4 a first line of 400 units that ends in an ellipsis and holds a redacted marker still gives a sentence under the cap', () => {
    const line = `GOAL: Fix [REDACTED:api_key] handling ${'and more words '.repeat(40)}`.slice(0, 399) + '…'
    expect(line.length).toBe(400)
    const out = goalOfNote(line)
    expect(out?.startsWith('Fix [REDACTED:api_key] handling')).toBe(true)
    expect(out?.length).toBeLessThanOrEqual(200)
  })

  test('X5 ids in the sentence are masked', () => {
    expect(goalOfNote('GOAL: Fix #0d40499c and abc1234def')).toBe('Fix #[handle] and [sha]')
  })

  // The cap cuts at 199 characters. A [REDACTED:kind] marker that the cut would split is dropped whole, never returned in part.
  // Breaks if cutWords in goal-extractor.ts goes back to a plain hard cut: 190 x then '[REDACTED' then the ellipsis.
  test('X6 the cap drops a straddling [REDACTED:kind] marker whole, and keeps a marker the cut does not touch', () => {
    expect(goalOfNote(`GOAL: ${'x'.repeat(190)}[REDACTED:api_key]`)).toBe(`${'x'.repeat(190)}…`)
    const first = '[REDACTED:api_key]'
    // First marker wholly before the cut (kept), second marker straddles it (dropped): the loop reads every match, not only the first.
    const two = `${'a'.repeat(100)}${first}${'b'.repeat(72)}[REDACTED:token]`
    expect(two.indexOf('[REDACTED:token]')).toBe(190)
    expect(goalOfNote(`GOAL: ${two}`)).toBe(`${'a'.repeat(100)}${first}${'b'.repeat(72)}…`)
    // A marker wholly after the cut is cut away with the rest, as any text after the cut is.
    expect(goalOfNote(`GOAL: ${'y'.repeat(250)}[REDACTED:api_key]`)).toBe(`${'y'.repeat(199)}…`)
    // A marker that ends exactly at the cut (index 199) is whole, so it stays: the test is "ends after the cut", not "at or after".
    expect(goalOfNote(`GOAL: ${'x'.repeat(181)}[REDACTED:api_key]${'y'.repeat(50)}`)).toBe(`${'x'.repeat(181)}[REDACTED:api_key]…`)
  })

  // A marker has no space inside (redact.ts: snake_case kinds). Text that only starts like one is not a marker and must not move the cut.
  test('X6b text that starts like a marker but holds a space is not a marker: the word cut stays', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const out = goalOfNote(`GOAL: Strip [REDACTED: prefix from ${words} [done]`) ?? ''
    expect(out.startsWith('Strip [REDACTED: prefix from word0 word1')).toBe(true)
    expect(out.length).toBeGreaterThan(150)
    expect(out.endsWith('…')).toBe(true)
  })

  // Ordinary goals keep the word-boundary cut. Passes before and after the fix.
  test('X7 a goal over 200 characters with no straddling marker keeps its word-boundary cut', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const cut = goalOfNote(`GOAL: ${words}`) ?? ''
    const body = cut.slice(0, -1)
    // The cut is the longest whole-word prefix of at most 199 characters: it ends at a word end, and the next word would not fit.
    expect(cut.endsWith('…')).toBe(true)
    expect(words.startsWith(body)).toBe(true)
    expect(body.length).toBeLessThanOrEqual(199)
    expect(words[body.length]).toBe(' ')
    const next = words.indexOf(' ', body.length + 1)
    expect(next === -1 || next > 199).toBe(true)
    // Index 199 of this goal is inside a word, so a plain hard cut would keep 199 characters; the word cut ends at word28 (195 characters).
    expect(goalOfNote(`GOAL: Go ${words}`)).toBe(`Go ${words.slice(0, 192)}…`)
    const early = `Fix [REDACTED:api_key] now ${words}`
    const out = goalOfNote(`GOAL: ${early}`)
    expect(out?.startsWith('Fix [REDACTED:api_key] now word0')).toBe(true)
    expect(out?.endsWith('…')).toBe(true)
    expect(out?.length).toBeLessThanOrEqual(200)
  })
})
