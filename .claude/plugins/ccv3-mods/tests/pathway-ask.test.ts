import { describe, expect, test } from 'claude-code/testing'

import type { CheckpointOption, CheckpointResult } from '../types'
import {
  NEED_PR,
  STORE_DENY,
  askOrder,
  askSpec,
  buildPathwayAsk,
  chicagoTime,
  changeKeptText,
  changeStopText,
  ignoredText,
  ledgerAskText,
  ledgerOf,
  ledgerCommandNote,
  ledgerCommandText,
  keptDraftText,
  movedText,
  isPaidPathway,
  parseCheckpointArgs,
  pathwayOfAnswer,
  notDraftText,
  stopText,
  undoFailedText,
  whyTextOnly,
  type PathwayAsk,
} from '../hooks/pr-checkpoint/model'
import { DRAFT_REASON, reportLine, statusForModel, toastText } from '../hooks/pr-loop/model'
import { slotLine } from '../hooks/pr-loop/slot-model'

// The 3-line review question, the slot-state labels, the loose typed answer and the Keep-as-draft text. Pure functions: model.ts takes no `$`.
// How it can fail, and the test that catches it:
// P1  a typed PR:word form (328:none, none:328) is a usage error; a drive colon in --body is split by mistake
// P2  a dialog answer that is not an exact label (option number, word, prefix, case, trailing space, comma pair) records; an exact label does not
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

describe('pathwayOfAnswer: an exact option label only', () => {
  const a = ask(FREE)
  // Labels: 1 Keep as draft ($0), 2 CodeRabbit now (free slot, $0) (Recommended), 3 No review, land on CI ($0)
  const pathway = (text: unknown, from: PathwayAsk = a) => pathwayOfAnswer(text, from)?.pathway ?? null

  test('P2 each exact label picks its row', () => {
    expect(a.choices.map(one => pathway(one.label))).toEqual(['wait', 'coderabbit', 'none'])
  })

  test('P2 a row number, a pathway word, a label prefix, a changed label, a trailing space and more lines are misses (Dave 2026-11-06)', () => {
    const first = a.choices[0]!.label
    const misses = ['1', ' 3 ', '4', 'none', 'NONE', '328:none', 'none 328', 'wait', 'accept', 'coderabbit', 'no review', 'KEEP', 'code', first.toLowerCase(), `${first} `, `${first}
please`, `${first}, ${a.choices[2]!.label}`, 'please wait for the weekend', '', '   ', 42, null]
    for (const text of misses) expect(pathway(text), String(text)).toBeNull()
  })

  test('P2 an exact label of another question is a miss', () => {
    const other = ask(WAIT, { recommended: 'none' })
    expect(pathway(other.choices[0]!.label, a)).toBeNull()
  })

  test('P2 a pick is by dave on every row (M9: no tap records by default)', () => {
    expect(a.choices.map(one => pathwayOfAnswer(one.label, a)?.by)).toEqual(['dave', 'dave', 'dave'])
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
    expect(stale.choices.find(one => one.pathway === 'coderabbit')!.label).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
  })

  test('P4c a wait fact whose next slot is in the past reads unknown: line 3 and the label', () => {
    const past = buildPathwayAsk(328, result(WAIT), Date.parse('2026-11-06T20:30:00Z'))!
    expect(past.question.split('\n')[2]).toBe('CodeRabbit slot: unknown (last notice 13:10 CST).')
    expect(past.choices.find(one => one.pathway === 'coderabbit')!.label).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
  })

  test('P4d a wait fact with no slot time reads unknown once it is older than 5 minutes', () => {
    const noTime = { ...WAIT, nextSlotAt: null, minutesToSlot: null, checkedAt: '2026-11-06T19:40:00Z' }
    const fresh = buildPathwayAsk(328, result(noTime), NOW)!
    const old = buildPathwayAsk(328, result(noTime), NOW + 6 * 60_000)!
    expect(fresh.question.split('\n')[2]).toMatch(/^CodeRabbit slot: no free slot/)
    expect(old.question.split('\n')[2]).toMatch(/^CodeRabbit slot: unknown \(/)
    expect(old.choices.find(one => one.pathway === 'coderabbit')!.label).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
  })

  // A checkedAt after the clock is skew up to 1 minute; beyond that the fact fails closed. The engine reads it the same way (checkpoint-two-copy.test.mjs).
  test('P4e a free fact checked more than 1 minute after the clock reads unknown; within 1 minute it stays free', () => {
    const at = (ahead: number) => buildPathwayAsk(328, result({ ...FREE, checkedAt: new Date(NOW + ahead).toISOString() }), NOW)!
    const row = (a: PathwayAsk) => a.choices.find(one => one.pathway === 'coderabbit')!.label
    expect(row(at(60_000))).toBe('CodeRabbit now (free slot, $0) (Recommended)')
    expect(at(60_000).question.split('\n')[2]).toBe('CodeRabbit slot: free now.')
    expect(row(at(60_001))).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(at(120_000).question.split('\n')[2]).toMatch(/^CodeRabbit slot: unknown/)
  })

  test('P5 with 0 files and no cost the paid labels still print the engine form "may cost up to $0.00"', () => {
    const free0 = result(WAIT, { size: { files: 0, lines: 0 }, options: [opt('none'), opt('coderabbit', { cost: [0, 0] }), opt('both', { cost: [0, 0] }), opt('wait')] })
    const rows = buildPathwayAsk(328, free0, NOW)!.choices
    expect(rows.find(one => one.pathway === 'coderabbit')!.label).toBe('CodeRabbit review (may cost up to $0.00) (Recommended)')
    expect(rows.find(one => one.pathway === 'both')!.label).toBe('CodeRabbit + Greptile (may cost up to $0.00 + 3 credits)')
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
    // Row 0 is always Keep as draft (or none when none is the recommendation): the free-slot row is row 1. Rows are read by pathway.
    const row = (a: PathwayAsk) => a.choices.find(one => one.pathway === 'coderabbit')!.label
    expect(ask(FREE).choices[0]!.label).toBe('Keep as draft ($0)')
    expect(row(ask(FREE))).toBe('CodeRabbit now (free slot, $0) (Recommended)')
    expect(row(ask(WAIT))).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(row(ask(UNKNOWN))).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
    expect(row(ask(null))).toBe('CodeRabbit review (may cost up to $1.75) (Recommended)')
  })

  test('P5 the Greptile row names its price and its credits, the same words as the engine', () => {
    const rows = ask(WAIT, { options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] }).choices
    expect(rows.find(one => one.pathway === 'both')!.label).toBe('CodeRabbit + Greptile (may cost up to $1.75 + 3 credits)')
  })

  test('P5 no wait-for-slot row is added at any state: Keep as draft is the only waiting label', () => {
    for (const slot of [FREE, WAIT, UNKNOWN]) expect(ask(slot).choices.map(one => one.pathway)).toEqual(['wait', 'coderabbit', 'none'])
  })

  test('P5b row 0 is Keep as draft, or the none row when none is the recommendation; the free-slot row never leads; paid rows follow the $0 rows', () => {
    const all = [opt('none'), opt('coderabbit'), opt('both'), opt('wait')]
    for (const slot of [FREE, WAIT, UNKNOWN]) {
      expect(ask(slot, { recommended: 'coderabbit', options: all }).choices.map(one => one.pathway), 'rec coderabbit').toEqual(['wait', 'coderabbit', 'both', 'none'])
      expect(ask(slot, { recommended: 'none', options: all }).choices.map(one => one.pathway), 'rec none').toEqual(['none', 'wait', 'coderabbit', 'both'])
    }
    expect(ask(FREE, { recommended: 'none', options: all }).choices[0]!.label).toBe('No review, land on CI ($0) (Recommended)')
  })

  test('P5c the free-slot row sits after Keep as draft and before every paid row', () => {
    const rows = ask(FREE, { recommended: 'both', options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] }).choices
    expect(rows.map(one => one.pathway)).toEqual(['wait', 'coderabbit', 'both', 'none'])
    expect(rows[1]!.label).toBe('CodeRabbit now (free slot, $0)')
  })
})

describe('keptDraftText', () => {
  test('P6b a re-ask after a slot change carries the engine note in the text for the model; a normal ask has no such line', () => {
    const ask = { header: 'PR #7', question: 'Q', options: [{ label: 'A ($0)' }, { label: 'B' }] }
    const note = 'The CodeRabbit slot changed. Your tap was not recorded.'
    const block = ledgerOf({ state: 'ask', ask, reasked: 0, text: 't', note })!
    expect(block.note).toBe(note)
    expect(ledgerAskText({ ...block, ask: block.ask! })).toContain(note)
    const plain = ledgerOf({ state: 'ask', ask, reasked: 0, text: 't' })!
    expect(plain.note ?? null).toBeNull()
    expect(ledgerAskText({ ...plain, ask: plain.ask! })).not.toContain('slot changed')
  })

  test('P6 says nothing is recorded and the question is not repeated, and does not tell Dave to type the command', () => {
    const text = keptDraftText(328)
    expect(text).toMatch(/kept #328 as a draft/i)
    expect(text).toMatch(/Nothing recorded/)
    expect(text).toMatch(/Do not ask him again/)
    expect(text).toMatch(/pending/i)
    expect(text).not.toContain('/pathway')
  })
})

// ---- pathway flow v2 (Dave 2026-11-06): every decision is a tap ----------------------------------------------------------------------
// How it can fail, and the test that catches it:
// V1  a tap records `--by default` (the recommended row), so one dialog return can mark a paid PR ready        (M9)
// V2  a paid row shows no price (PR C: one question, the tap on the paid row is the yes)                           (M9)
// V3  a paid row is row 0, so one dialog return with no tap records a paid pick                                  (M9, PR C)
// V4  a typed answer is read past its first line, or the ignored text is not named                              (M6)
// V5  an ask that can spend lists the spending row first                                                         (item 5)
// V6  a text for the model or Dave tells him to type or paste a command                                          (M10)

describe('v2: a tap is always Dave\'s and a paid row shows its price', () => {
  const NONE_FIRST = ask(FREE, { recommended: 'none', auto: { eligible: false, band: 'MID', reason: '' } })

  test('V1 every row of the question is by dave: the recommended row, none and Keep as draft', () => {
    for (const one of [ask(FREE), ask(WAIT), ask(UNKNOWN), NONE_FIRST]) expect(one.choices.map(choice => choice.by)).toEqual(one.choices.map(() => 'dave'))
  })

  test('V1 the exact label of the recommended row is by dave as well', () => {
    const first = ask(FREE).choices[0]!.label
    expect(pathwayOfAnswer(first, ask(FREE))?.by).toBe('dave')
  })

  test('V2 every paid row (coderabbit, both) shows its price in the label; none and Keep as draft are $0', () => {
    const rows = ask(WAIT, { options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] }).choices
    expect(rows.filter(choice => isPaidPathway(choice.pathway)).map(choice => choice.pathway)).toEqual(['coderabbit', 'both'])
    for (const choice of rows) expect(choice.label, choice.pathway).toMatch(isPaidPathway(choice.pathway) ? /\(may cost up to \$1\.75/ : /\(\$0\)/)
  })

  test('V3 a paid row is never row 0: the first row is a $0 row whatever the recommendation and the slot', () => {
    for (const recommended of ['coderabbit', 'both', 'none']) {
      for (const slot of [FREE, WAIT, UNKNOWN]) {
        const first = ask(slot, { recommended, options: [opt('none'), opt('coderabbit'), opt('both'), opt('wait')] }).choices[0]!
        expect(first.label, recommended).toMatch(/\$0\)/)
        expect(first.label, recommended).not.toMatch(/up to/)
      }
    }
  })
})

describe('v2: a typed answer reads its first line only', () => {
  test('V4 the first line parses, the rest is ignored and named', () => {
    const text = '349 none\n\nThis is exactly what I wanted, thanks.'
    expect(parseCheckpointArgs(text)).toEqual({ pr: 349, word: 'none', body: null })
    expect(ignoredText(text)).toBe('This is exactly what I wanted, thanks.')
  })

  test('V4 a second PR or word in the ignored lines changes nothing; one line has no ignored text', () => {
    expect(parseCheckpointArgs('349 none\n350 both')).toEqual({ pr: 349, word: 'none', body: null })
    expect(ignoredText('349 none')).toBe('')
  })

  test('V4 an unknown word in the FIRST line is still a usage error, whatever follows', () => {
    expect(parseCheckpointArgs('This is great\n349 none')).toBeNull()
    expect(parseCheckpointArgs('349 none and more')).toBeNull()
  })

  test('V4 a dialog answer is not read line by line: a label with a line after it is a miss', () => {
    const a = ask(FREE)
    expect(pathwayOfAnswer('none\nplease do not wait', a)).toBeNull()
    expect(pathwayOfAnswer(`${a.choices[2]!.label}\nplease do not wait`, a)).toBeNull()
  })
})

describe('v2: asks that can spend list the free row first', () => {
  const spec = (kind: 'opening' | 'round' | 'greptile') => askSpec({ kind, pr: 7, head: 'a'.repeat(40), text: 'Question text.' }, 7)

  test('V5 the opening ask, the round ask and the Greptile ask all put No first, marked Recommended', () => {
    for (const kind of ['opening', 'round', 'greptile'] as const) {
      expect(askOrder(kind), kind).toEqual(['no', 'yes'])
      expect(spec(kind).choices.map(one => one.answer), kind).toEqual(['no', 'yes'])
      expect(spec(kind).choices[0]!.label, kind).toMatch(/\(Recommended\)$/)
      expect(spec(kind).choices[1]!.label, kind).not.toMatch(/Recommended/)
    }
  })
})

describe('v2: no text tells Dave to type or paste a command', () => {
  const bad = /\/(pathway|slot|land|watch)\b/i
  const slotPay = /\/slot (pay|wait|drop|first)/i
  const answers = /He answers with|Dave answers with|picks again in|He can answer later with|Type the command|Dave types|Dave runs/i

  test('V6 the texts of every outcome that records nothing', () => {
    const texts = [
      keptDraftText(7),
      movedText(7, 'the head moved'),
      stopText(7, 'other', 'free text'),
      stopText(7, 'closed'),
      stopText(7, 'empty'),
      NEED_PR,
      STORE_DENY,
      changeKeptText(7, 'review:coderabbit'),
      changeStopText(7),
      undoFailedText(7, 'gh exited 1'),
      notDraftText(7),
      ledgerCommandText(7),
      ledgerCommandNote(7),
      ledgerAskText({ state: 'ask', pathway: null, text: '', reasked: 1, ask: { header: 'PR #7', question: 'Q', options: [{ label: 'A' }, { label: 'B' }] } }),
      whyTextOnly(null, null),
      whyTextOnly('plugin', null),
      whyTextOnly('bridge', 7),
    ]
    for (const text of texts) {
      expect(text, text).not.toMatch(bad)
      expect(text).not.toMatch(slotPay)
      expect(text).not.toMatch(answers)
    }
  })

  test('V6 the stop text says the PR stays a draft and nothing was recorded', () => {
    expect(stopText(7, 'other', 'free text')).toMatch(/stays a draft/)
    expect(stopText(7, 'other', 'free text')).toMatch(/Nothing was recorded/)
    expect(stopText(7, 'other', 'free text')).toContain('free text')
  })

  test('V6 the pr-loop draft toast and the draft line to the model name no typed command and say the model asks by tap', () => {
    const toast = toastText({ pr: 7, state: 'DRAFT', head: 'a'.repeat(40), headShort: 'aaaaaaa', merged: false, whenReady: false, reasons: [] })
    const lines = statusForModel({ isDraft: true, reasons: [DRAFT_REASON] } as never).reasons.filter(reason => reason !== DRAFT_REASON)
    expect(lines.length).toBe(1)
    for (const text of [toast, ...lines]) {
      expect(text).not.toMatch(/\/(pathway|slot|land|watch)\b/i)
      expect(text).not.toMatch(bad)
      expect(text).not.toMatch(slotPay)
      expect(text).not.toMatch(answers)
      expect(text).toMatch(/Dave's review pick/)
    }
    expect(toast).toMatch(/asks him with a tap/)
    expect(lines[0]).toContain('pr_checkpoint')
    expect(lines[0]).toMatch(/Do not request a review/)
  })

  const ALERT = { pr: 7, head: 'a'.repeat(40), headShort: 'aaaaaaa', merged: false, whenReady: false, reasons: ['not READY after 60 minutes'] }

  test('V6 the watcher lines: the paid review and the timed-out queue ask by tap, never by a typed command, and never post before a Yes', () => {
    const stalled = reportLine({ ...ALERT, state: 'STALLED', slot: { position: 1, total: 2, state: 'timed-out' } })
    const limited = reportLine({ ...ALERT, state: 'LIMITED', rateLimit: { minutes: 40 }, reasons: ['CodeRabbit rate limited: head not reviewed'] })
    for (const line of [stalled, limited]) {
      expect(line).not.toMatch(bad)
      expect(line).not.toMatch(slotPay)
      expect(line).toContain('ship-ask.mjs paid-round --pr 7 --json')
    }
    expect(limited).toMatch(/only after Dave taps a Yes option/)
    expect(limited.indexOf('post nothing yet')).toBeGreaterThan(-1)
    expect(limited.indexOf('post nothing yet')).toBeLessThan(limited.indexOf('--use-credits'))
  })

  test('V6 a stuck queue item and the queue rows send the model to pr_checkpoint or to a question, never to a typed /slot verb', () => {
    const stuck = reportLine({ ...ALERT, state: 'STALLED', slot: { position: 1, total: 2, state: 'stuck' } })
    expect(stuck).not.toMatch(slotPay)
    expect(stuck).toContain('pr_checkpoint with pr 7')
    const row = { pr: 7, band: 'HIGH', position: 1, total: 2, head7: 'aaaaaaa', queuedMin: 70, timeoutInMin: 0, nextSlotInMin: 12, posts: 2, asked: { paid30: true, timeout60: true } }
    for (const state of ['timed-out', 'stuck']) expect(slotLine({ ...row, state }), state).not.toMatch(slotPay)
    expect(slotLine({ ...row, state: 'stuck' })).toContain('pr_checkpoint 7')
  })
})
