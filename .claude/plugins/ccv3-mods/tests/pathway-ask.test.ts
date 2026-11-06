import { describe, expect, test } from 'claude-code/testing'

import type { CheckpointOption, CheckpointResult } from '../types'
import { buildPathwayAsk, chicagoTime, keptDraftText, parseCheckpointArgs, pathwayOfAnswer, type PathwayAsk } from '../hooks/pr-checkpoint/model'

// The 3-line review question, the slot-state labels, the loose typed answer and the Keep-as-draft text. Pure functions: model.ts takes no `$`.
// How it can fail, and the test that catches it:
// P1  a typed PR:word form (328:none, none:328) is a usage error; a drive colon in --body is split by mistake
// P2  a typed answer under Other (option number, word, unique prefix, case) records nothing, or a near miss, a wrong PR or a comma pair records
// P3  the question is not 3 lines, or a line holds the wrong fact (PR, band, files, trigger, slot)
// P4  the slot text is wrong for free, wait, unknown or an older checkpoint with no slot fact; the time is not Chicago time
// P5  the CodeRabbit label does not follow the slot state
// P6  Keep as draft text still tells Dave to type /pathway

const opt = (pathway: string, over: Partial<CheckpointOption> = {}): CheckpointOption => ({
  pathway,
  label: pathway === 'wait' ? null : `review:${pathway}`,
  available: true,
  cost: pathway === 'none' || pathway === 'wait' ? [0, 0] : [1, 2],
  reason: `${pathway} reason`,
  ...over,
})

const NOW = Date.parse('2026-11-06T19:42:00Z')

const result = (slot: Record<string, unknown> | null, over: Partial<CheckpointResult> = {}): CheckpointResult => ({
  head: 'a'.repeat(40),
  class: 'infra',
  matched: 3,
  size: { files: 7, lines: 212 },
  checks: [],
  cli: null,
  credits: { used: null, monthly: null },
  capacity: { count: null, band: null, warning: null, source: null, date: null, ...(slot ?? {}) } as CheckpointResult['capacity'],
  recommended: 'coderabbit',
  options: [opt('none'), opt('coderabbit'), opt('wait')],
  why: ['a critical file changed.'],
  budget: [1, 2],
  config_drift: false,
  auto: { eligible: false, band: 'MID', reason: '' },
  ...over,
})

const FREE = { state: 'free', nextSlotAt: null, minutesToSlot: null, lastNoticeAt: null, cliRemaining: 8, checkedAt: '2026-11-06T19:40:00Z', source: 'probe' }
const WAIT = { state: 'wait', nextSlotAt: '2026-11-06T20:20:00Z', minutesToSlot: 40, lastNoticeAt: '2026-11-06T19:10:00Z', cliRemaining: null, checkedAt: '2026-11-06T19:40:00Z', source: 'cache' }
const UNKNOWN = { state: 'unknown', nextSlotAt: null, minutesToSlot: null, lastNoticeAt: '2026-11-06T17:02:00Z', cliRemaining: null, checkedAt: '2026-11-06T19:40:00Z', source: 'none' }

const ask = (slot: Record<string, unknown> | null, over: Partial<CheckpointResult> = {}): PathwayAsk => buildPathwayAsk(328, result(slot, over), NOW)!

describe('parseCheckpointArgs: typed forms', () => {
  test('P1 PR and word in every order and spelling', () => {
    for (const text of ['328:none', '#328:none', 'none:328', '328 none', 'none 328', '328:NONE']) {
      expect(parseCheckpointArgs(text), text).toEqual({ pr: 328, word: 'none', body: null })
    }
    expect(parseCheckpointArgs('none')).toEqual({ pr: null, word: 'none', body: null })
    expect(parseCheckpointArgs('NONE')).toEqual({ pr: null, word: 'none', body: null })
  })

  test('P1b a drive colon in --body stays whole, and a stray colon is a usage error', () => {
    expect(parseCheckpointArgs('328:none --body C:/x/pr-body.md')).toEqual({ pr: 328, word: 'none', body: 'C:/x/pr-body.md' })
    expect(parseCheckpointArgs('328:')).toBeNull()
    expect(parseCheckpointArgs('328:7')).toBeNull()
    expect(parseCheckpointArgs('none:both')).toBeNull()
    expect(parseCheckpointArgs('x:y')).toBeNull()
  })
})

describe('pathwayOfAnswer: loose typed answer', () => {
  const a = ask(FREE)
  // Labels: 1 CodeRabbit now (free slot, $0) (Recommended), 2 Keep as draft ($0), 3 No review, land on CI ($0)
  const pathway = (text: unknown, from: PathwayAsk = a) => pathwayOfAnswer(text, from)?.pathway ?? null

  test('P2 the option number picks that row', () => {
    expect(pathway('1')).toBe('coderabbit')
    expect(pathway(' 3 ')).toBe('none')
    expect(pathway('4')).toBeNull()
    expect(pathway('0')).toBeNull()
  })

  test('P2 a pathway word, with or without the PR, in any case', () => {
    for (const text of ['none', 'NONE', '328:none', '328 none', 'none 328', '#328:none']) expect(pathway(text), text).toBe('none')
    expect(pathway('wait')).toBe('wait')
    expect(pathway('accept')).toBe('coderabbit')
    expect(pathway('coderabbit')).toBe('coderabbit')
  })

  test('P2 another PR number records nothing', () => {
    expect(pathway('999:none')).toBeNull()
    expect(pathway('none 999')).toBeNull()
  })

  test('P2 a unique label prefix, without case; an exact label with a trailing space', () => {
    expect(pathway('no review')).toBe('none')
    expect(pathway('KEEP')).toBe('wait')
    expect(pathway('code')).toBe('coderabbit')
    expect(pathway(`${a.choices[0]!.label.toLowerCase()} `)).toBe('coderabbit')
  })

  test('P2 a near miss records nothing: too short, a comma pair, other words, empty, not a string', () => {
    expect(pathway('co')).toBeNull()
    expect(pathway(`${a.choices[0]!.label}, ${a.choices[2]!.label}`)).toBeNull()
    expect(pathway('please wait for the weekend')).toBeNull()
    expect(pathway('')).toBeNull()
    expect(pathway('   ')).toBeNull()
    expect(pathway(42)).toBeNull()
    expect(pathway('none --body x.md')).toBeNull()
  })

  test('P2 an ambiguous prefix records nothing; a word still picks', () => {
    const both = ask(FREE, { options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] })
    expect(pathway('code', both)).toBeNull()
    expect(pathway('both', both)).toBe('both')
  })

  test('P2 a typed pick keeps the by of the row: only the recommended row is by default', () => {
    const both = ask(FREE, { options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] })
    expect(pathwayOfAnswer('coderabbit', both)?.by).toBe('default')
    expect(pathwayOfAnswer('both', both)?.by).toBe('dave')
  })
})

describe('buildPathwayAsk: three lines and the slot state', () => {
  test('P3 free slot: PR, band and files; the recommendation and its trigger; the slot', () => {
    const lines = ask(FREE).question.split('\n')
    expect(lines).toEqual(['PR #328, band MID, 7 files.', 'Recommended: CodeRabbit review, because a critical file changed.', 'CodeRabbit slot: free now.'])
  })

  test('P4 wait: next slot in Chicago time and the minutes left, counted from now', () => {
    expect(ask(WAIT).question.split('\n')[2]).toBe('CodeRabbit slot: next about 14:20 CST (in 38 min).')
  })

  test('P4 wait with no time: says so', () => {
    expect(ask({ ...WAIT, nextSlotAt: null, minutesToSlot: null }).question.split('\n')[2]).toBe('CodeRabbit slot: no free slot, next time unknown.')
    expect(ask({ ...WAIT, nextSlotAt: null, minutesToSlot: 15 }).question.split('\n')[2]).toBe('CodeRabbit slot: no free slot, next in about 15 min.')
  })

  test('P4 unknown: the last notice time', () => {
    expect(ask(UNKNOWN).question.split('\n')[2]).toBe('CodeRabbit slot: unknown (last notice 11:02 CST).')
    expect(ask({ ...UNKNOWN, lastNoticeAt: null }).question.split('\n')[2]).toBe('CodeRabbit slot: unknown (no notice seen).')
  })

  test('P4 an older checkpoint with no slot fact, or a bad one, is unknown', () => {
    expect(ask(null).question.split('\n')[2]).toBe('CodeRabbit slot: unknown (no notice seen).')
    expect(ask({ state: 'maybe' }).question.split('\n')[2]).toBe('CodeRabbit slot: unknown (no notice seen).')
    expect(buildPathwayAsk(328, { ...result(null), capacity: undefined as never }, NOW)!.question.split('\n').length).toBe(3)
  })

  // Keep as draft leaves the pending entry, so a bare /pathway hours later asks again from the stored fact: an old fact must not read as live.
  test('P4b a free fact checked more than 5 minutes ago reads unknown: line 3 and the label', () => {
    const later = (minutes: number) => buildPathwayAsk(328, result({ ...FREE, checkedAt: '2026-11-06T19:40:00Z' }), NOW + minutes * 60_000)!
    expect(later(3).question.split('\n')[2]).toBe('CodeRabbit slot: free now.')
    const stale = later(6)
    expect(stale.question.split('\n')[2]).toBe('CodeRabbit slot: unknown (no notice seen).')
    expect(stale.choices[0]!.label).not.toMatch(/free slot/)
  })

  test('P4c a wait fact whose next slot is in the past reads unknown: line 3 and the label', () => {
    const past = buildPathwayAsk(328, result(WAIT), Date.parse('2026-11-06T20:30:00Z'))!
    expect(past.question.split('\n')[2]).toBe('CodeRabbit slot: unknown (last notice 13:10 CST).')
    expect(past.choices[0]!.label).not.toMatch(/paid/)
  })

  test('P3 a band the engine did not print reads unknown', () => {
    expect(ask(FREE, { auto: { eligible: false, band: null, reason: '' } }).question.split('\n')[0]).toBe('PR #328, band unknown, 7 files.')
  })

  test('P3 a second reason, a held pathway and a warning add lines; nothing else does', () => {
    const more = ask(FREE, { why: ['first.', 'second.'], options: [opt('none'), opt('coderabbit'), opt('both', { available: false, reason: 'Greptile held' }), opt('wait')], config_drift: true })
    expect(more.question.split('\n').slice(3)).toEqual(['Also: second.', 'Held: CodeRabbit + Greptile (Greptile held).', 'Warning: branch config differs from main'])
  })

  test('P4 the time is Chicago time with the zone name of that date', () => {
    expect(chicagoTime('2026-11-06T20:20:00Z')).toBe('14:20 CST')
    expect(chicagoTime('2026-07-01T20:20:00Z')).toBe('15:20 CDT')
    expect(chicagoTime('2026-11-06T06:05:00Z')).toBe('00:05 CST')
    expect(chicagoTime('not a time')).toBeNull()
    expect(chicagoTime(null)).toBeNull()
  })

  test('P5 the CodeRabbit label follows the slot state', () => {
    expect(ask(FREE).choices[0]!.label).toBe('CodeRabbit now (free slot, $0) (Recommended)')
    expect(ask(WAIT).choices[0]!.label).toBe('CodeRabbit now, paid (up to $1.75) (Recommended)')
    expect(ask(UNKNOWN).choices[0]!.label).toBe('CodeRabbit review (up to $1.75) (Recommended)')
    expect(ask(null).choices[0]!.label).toBe('CodeRabbit review (up to $1.75) (Recommended)')
  })

  test('P5 no wait-for-slot row is added at any state: Keep as draft is the only waiting label', () => {
    for (const slot of [FREE, WAIT, UNKNOWN]) expect(ask(slot).choices.map(one => one.pathway)).toEqual(['coderabbit', 'wait', 'none'])
  })
})

describe('keptDraftText', () => {
  test('P6 says nothing is recorded and the question is not repeated, and does not tell Dave to type the command', () => {
    const text = keptDraftText(328)
    expect(text).toMatch(/kept #328 as a draft/i)
    expect(text).toMatch(/Nothing recorded/)
    expect(text).toMatch(/Do not ask him again/)
    expect(text).toMatch(/pending/i)
    expect(text).not.toContain('/pathway')
  })
})
