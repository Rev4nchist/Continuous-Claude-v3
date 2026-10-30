import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { MAX_ITEMS, MIN_ITEMS, digest, fold } from '../hooks/agentic-os/digest'
import type { DigestAsk, DigestBlock, DigestCommit, DigestCompaction, DigestDecision, DigestLane, DigestOptions, DigestPr, DigestProof } from '../hooks/agentic-os/digest'
import { TABS } from '../hooks/agentic-os/os-tabs-model'
import { drift as driftOf } from '../hooks/agentic-os/steward'
import type { Drift } from '../hooks/agentic-os/steward'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import type { AgentRun, OsTask } from '../types'

// PR 5, the /os session briefing (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to stay on top of").
// digest() is pure and draws nothing itself: it returns three blocks of rows, NEEDS YOU, DONE, WATCH.
//
// /os redesign, round 2 (tests first). Contract these tests pin (the plan left these holes; the choices are mine and the implementer must
// follow them or change the test):
//   digest(brief, tasks, drift, prs, agents, lanes, asks, decisions, proofs, { now, columns, limit?, lineCap?, commits?, compactions? })
//   returns { needs, highlights, watch }, each { id, title, total, shown, more, head, items, rows }.
//   - The key stays `highlights` and the id stays 'highlights'; only the TITLE is now DONE. An empty block keeps its dim sentence.
//   - `items` is one group of PaneRows per shown item (1 to lineCap rows; lineCap is 1 or 3, default 3). rows = [...items.flat(), more?];
//     an empty block has items [] and one dim row. Keys: `brief-<id>-<i>` for row 1, then `-2`, `-3` (text.ts wrapRows).
//   - Row 1 of an item is `  <mark> <text>`, mark `>` in NEEDS YOU, `+` in DONE, `!` in WATCH. Rows 2 and 3 indent 4 and carry no mark.
//   - No `[source]` tag. The age is the right group of row 1 (now, Nm, Nh, Nd) on a pane of 24 columns or more. Under 24 columns the age is
//     dropped (wrapRows drops the right group there): a documented loss, not asserted. An item with no time has no age (or `-`).
//   - `[derived]` stays: a derived item carries the literal `[derived]` in its text; a plain item never says "derived".
//   - Hint rule (plan): an item whose home tab holds more ALWAYS ends with `...more -> <Tab>` (an ask with a recommendation: Choices; a
//     peer lane with overlap: Work); a plain item shows the hint only when its text is cut at lineCap rows. Home tabs pinned here: ask
//     Choices, change (PR) Work, peer lane Work. Tab words (Dave, 2026-10-30): Plan is Steps, Proof is Checks, Decisions is Choices.
//   - Wording comes from plain.ts: askSentence ("Answer: x" and "I suggest: r" on the NEXT row), prSentence ("Change #N ..."; no title,
//     no "PR #"), stepSentence, helperSentence, driftSentence, laneSentence, proofSentence, keeperSentence. A commit shows its subject
//     only (no sha). A passed proof drops the artifact name.
//   - DigestCompaction is the KeeperRecord { at, sessionId, open, total, kept }; kept() and the `summary` text are gone.
//   - DigestLane gains `overlap?: string[]` (paths); an overlapping peer reads "may touch the same files". The `holder` field stays optional
//     and is ignored (laneSentence holds no holder); the tests keep setting it so an old caller still type-checks.
//
// Ways the briefing can fail, one test each:
// D1  the blocks are missing, renamed or out of order, or the third block is still titled HIGHLIGHTS
// D2  NEEDS YOU lists its kinds in the wrong order
// D3  an item list is not newest first (DONE across kinds, asks inside one kind)
// D4  more than the cap is drawn, the "+N more" count is wrong, or the cap does not follow the caller's limit
// D5  an empty block is not one dim line, or collapses when the other blocks are full
// D6  an item has no age or the old [source] tag; the age steps are off; a time in the future reads negative
// D7  an open ask loses its recommendation (on the next row), an answered ask is listed, an ask without one invents it
// D8  a READY PR does not read as the plain "Say merge" sentence, a rate limit, a blocked step or a failed check is missing
// D9  DONE loses a milestone (commit, merged PR, finished run), a Dave decision, a proof with its numbers; or shows a sha or an artifact name
// D10 WATCH loses an unproven step, the steward drift (plain sentence), a PR with open threads, a long helper, a peer lane, a deferred item
// D11 the keeper line: kept / lost / none, newest decides, and the kill rule (3 of the newest 5 lost the plan)
// D12 a derived fact is not marked [derived], or a plain fact is
// D13 a secret in any input reaches a row, whole or cut by the width
// D14 the same input gives a different answer, a frozen input throws, or a clock is read
// D15 a multi-line or control-character input draws a control character
// D16 5,000 character texts and 2,000 items overflow a row, the cap, the line cap, or take long
// D17 a row is wider than the pane from 20 to 200 columns, an item loses its mark, or an age is not a plain age
// D18 a raw code (LIMITED, REVIEWED, null, undefined) leaks into plain words
// N1  a long item is not wrapped to 3 rows ending "...more -> <home tab>" (itemRows caps at 1 or 5, or the hint is missing)
// N2  a short plain item gets a hint anyway
// N3  an ask with a recommendation does not always end with the Choices hint, or the recommendation is not on the next row
// N4  a peer lane with overlap is not marked "may touch the same files" with the Work hint, or one without it is
// N5  lineCap 1 draws more than one row per item
// N6  fold() slices rows instead of item groups, or its "+N more" counts rows
// N7  the marks are wrong: > in NEEDS YOU, + in DONE, ! in WATCH, and none on rows 2 and 3
//
// Edits to the pre-redesign tests (each listed with the reason; none weakened):
//   D1   HIGHLIGHTS -> DONE: Dave's title decision.
//   D2   the words in the list are the same; the sentences are the plain ones (blocked step reads "Stuck on: ...").
//   D6   "[ask] 4m" tails -> age in the right group and no tag: the plan drops the [source] tail. The age steps test reads the right group.
//   D7   "recommend: x" inline -> "I suggest: x" on the next row: the glossary.
//   D8   "ready ... merge yes", "PR #", "hit a review rate limit, wait 14m" -> prSentence: "Change #N ... Say "merge" ..."; the wait minutes
//        are no longer in the sentence (prSentence holds none). The not-finished case is unchanged.
//   D9   "502 pass, 0 fail - artifact" -> "502 tests pass, 0 fail" without the artifact; "sha subject" -> subject; "job x finished" ->
//        "A helper finished: job x".
//   D10  "is done but unproven" -> "Done but not proven yet: x"; "brief stale: <reason>" -> driftSentence; "PR #12 has" -> "Change #12 has";
//        "running 11m" -> "A helper has run 11 min: x"; "held by session 9f2c" -> "Another session holds lane x" (laneSentence has no holder).
//   D11  the summary-text tests (marker, other counts, other session) and the "no counts" case are DROPPED: the parse moved to
//        compact-keeper markerKept (tests K12 to K13b there) and a KeeperRecord always has counts. The kill-rule text is keeperSentence's.
//   D12  "[derived decision]" -> "[derived]": the plan keeps the bare mark only.
//   D17  "every item row ends with [tag] age" -> every item row starts with its mark; an age, when drawn, is a plain age.

const NOW = 100 * 3600_000
const MIN = 60_000
const HOUR = 3600_000
const SESSION = '364266d5-0000-4000-8000-000000000000'
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const leftText = (row: PaneRow): string => row.left.map(one => one.text).join('')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
/** One string per item: its rows joined. */
const items = (block: DigestBlock): string[] => block.items.map(group => group.map(rowText).join(' | '))
const everyRow = (found: ReturnType<typeof go>): PaneRow[] => [found.needs, found.highlights, found.watch].flatMap(block => [block.head, ...block.rows])
const dump = (found: ReturnType<typeof go>): string => everyRow(found).map(rowText).join('\n')
const at = (list: string[], word: string): number => list.findIndex(one => one.includes(word))
/** The age of an item: the text of the right group of its first row, or undefined. */
const ageOf = (group: PaneRow[]): string | undefined => group[0]?.right?.map(one => one.text).join('')
const HINT = (tab: string) => new RegExp(`(?:\\.\\.\\.|…)more -> ${tab}$`)
const OLD_TAG = /\[(?:ask|pr|decision|proof|git|steward|task|plan|agent|lane|keeper)\]/

// --- Fixtures from the wave 1 session ---

type In = {
  brief: Brief | null
  tasks: OsTask[]
  drift: Drift | null
  prs: DigestPr[]
  agents: AgentRun[]
  lanes: DigestLane[]
  asks: DigestAsk[]
  decisions: DigestDecision[]
  proofs: DigestProof[]
}

const BASE: In = { brief: null, tasks: [], drift: null, prs: [], agents: [], lanes: [], asks: [], decisions: [], proofs: [] }

const go = (over: Partial<In> = {}, opts: Partial<DigestOptions> = {}) => {
  const i = { ...BASE, ...over }
  return digest(i.brief, i.tasks, i.drift, i.prs, i.agents, i.lanes, i.asks, i.decisions, i.proofs, { now: NOW, columns: 100, ...opts })
}

const made = (raw: Record<string, unknown>, tasks: OsTask[] = [], at = NOW - 3 * HOUR): Brief => {
  const result = applyBrief(null, raw, tasks, at)
  if ('error' in result) throw new Error(result.error)
  return result.brief
}

const ask = (text: string, ago: number, over: Partial<DigestAsk> = {}): DigestAsk => ({ kind: 'question', text, source: 'brief_set', at: NOW - ago, ...over })
const pr = (n: number, state: DigestPr['state'], ago: number, over: Partial<DigestPr> = {}): DigestPr => ({ pr: n, state, whenReady: false, at: NOW - ago, ...over })
const decision = (text: string, by: string, ago: number, over: Partial<DigestDecision> = {}): DigestDecision => ({ text, by, at: NOW - ago, ...over })
const proofOk = (subject: string, ago: number, over: Partial<DigestProof> = {}): DigestProof => ({
  id: 'p1',
  kind: 'task',
  subject,
  artifact: '.claude/cache/e2e/2026-10-28-os-pane-steward-green.txt',
  at: NOW - ago,
  result: { passed: 502, failed: 0 },
  ...over,
})
const run = (id: string, status: AgentRun['status'], startedAgo: number, over: Partial<AgentRun> = {}): AgentRun => ({
  id,
  type: 'kraken',
  description: `job ${id}`,
  model: null,
  effort: null,
  spec: {},
  startedAt: NOW - startedAgo,
  endedAt: status === 'running' ? null : NOW - startedAgo + 5 * MIN,
  status,
  tokens: 0,
  costUsd: 0,
  drift: null,
  ...over,
})
const commit = (subject: string, ago: number): DigestCommit => ({ sha: 'b8448c3e1f2a', subject, at: NOW - ago })
const peer = (id: string, over: Partial<DigestLane> = {}): DigestLane => ({ id, title: `title of ${id}`, state: 'active', mine: false, holder: 'session 9f2c', at: NOW - 2 * HOUR, ...over })

// The READY alert of a PR #7-style watch: the pr-loop drops a READY PR from the live list, so the caller feeds it here.
const READY7 = pr(7, 'READY', 4 * MIN, { title: 'feat(pr-loop): quiet alerts so READY stops waking the model' })
const READY_SENTENCE = 'Change #7 is approved and checks pass. Say "merge" to land it.'
/** A question of about 300 characters in short words, so it wraps to more than 3 rows at 40 columns. */
const LONG_ASK = Array.from({ length: 60 }, (_, i) => `word${i % 10}`).join(' ')

describe('digest blocks', () => {
  test('D1 three blocks in this order: NEEDS YOU, DONE, WATCH, each with a head row that starts with its title', () => {
    const found = go()
    expect(Object.keys(found)).toEqual(['needs', 'highlights', 'watch'])
    expect([found.needs.title, found.highlights.title, found.watch.title]).toEqual(['NEEDS YOU', 'DONE', 'WATCH'])
    expect([found.needs.id, found.highlights.id, found.watch.id]).toEqual(['needs', 'highlights', 'watch'])
    for (const block of [found.needs, found.highlights, found.watch]) expect(rowText(block.head)).toMatch(new RegExp(`^${block.title}\\b`))
    expect(dump(found)).not.toContain('HIGHLIGHTS')
  })

  test('D2 NEEDS YOU lists open ask, READY PR, approval, blocked step, failed check, rate limit in that order, whatever order the input has', () => {
    const brief = made({ goal: 'ship PR 5', plan: [{ id: 'p1', text: 'wait for CodeRabbit capacity', status: 'blocked' }] })
    const found = go(
      {
        brief,
        proofs: [proofOk('validate-mods', 8 * MIN, { result: { passed: 500, failed: 2 } })],
        prs: [pr(9, 'LIMITED', 6 * MIN, { rateLimit: { minutes: 14 } }), READY7],
        asks: [ask('Create the roles?', 3 * MIN, { kind: 'approval' }), ask('Which branch should PR 5 start from?', 5 * MIN)],
      },
      { limit: 10 },
    )
    const list = items(found.needs)
    expect(list).toHaveLength(6)
    const order = [at(list, 'Which branch'), at(list, '#7'), at(list, 'Create the roles?'), at(list, 'wait for CodeRabbit'), at(list, 'validate-mods'), at(list, '#9')]
    expect(order).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('D3 DONE is newest first across commits, proofs, merged PRs, decisions and finished runs', () => {
    const found = go(
      {
        decisions: [decision('Pane PRs first, Fleet follow-ups after.', 'Dave', 30 * MIN)],
        proofs: [proofOk('validate-mods', 10 * MIN)],
        prs: [pr(208, 'CLOSED', 20 * MIN, { merged: true })],
        agents: [run('review', 'done', 45 * MIN)],
      },
      { limit: 10, commits: [commit('test(pr-loop): RED for quiet alerts', 1 * MIN)] },
    )
    const list = items(found.highlights)
    expect(list).toHaveLength(5)
    expect([at(list, 'RED for quiet alerts'), at(list, 'validate-mods'), at(list, '#208'), at(list, 'Pane PRs first'), at(list, 'job review')]).toEqual([0, 1, 2, 3, 4])
  })

  test('D3 open asks of one kind are newest first', () => {
    const found = go({ asks: [ask('old question', 50 * MIN), ask('new question', 2 * MIN), ask('mid question', 20 * MIN)] })
    const list = items(found.needs)
    expect([at(list, 'new question'), at(list, 'mid question'), at(list, 'old question')]).toEqual([0, 1, 2])
  })
})

describe('digest caps and empty blocks', () => {
  const TWELVE = Array.from({ length: 12 }, (_, i) => ask(`question ${i}`, (i + 1) * MIN))

  test('D4 more items than the cap: the cap is shown, then one "+N more" row that counts the rest', () => {
    expect(MIN_ITEMS).toBeGreaterThanOrEqual(3)
    expect(MAX_ITEMS).toBeLessThanOrEqual(5)
    expect(MIN_ITEMS).toBeLessThanOrEqual(MAX_ITEMS)
    const found = go({ asks: TWELVE })
    expect(found.needs.total).toBe(12)
    expect(found.needs.shown).toBe(MAX_ITEMS)
    expect(found.needs.more).toBe(12 - MAX_ITEMS)
    expect(found.needs.items).toHaveLength(MAX_ITEMS)
    expect(found.needs.rows).toHaveLength(MAX_ITEMS + 1)
    expect(rowText(found.needs.rows.at(-1)!).trim()).toBe(`+${12 - MAX_ITEMS} more`)
    expect(items(found.needs)[0]).toContain('question 0')
  })

  test('D4 the caller limit wins (a short pane asks for fewer), and an exact fit has no "+N more" row', () => {
    const three = go({ asks: TWELVE }, { limit: 3 })
    expect([three.needs.shown, three.needs.more]).toEqual([3, 9])
    expect(three.needs.rows).toHaveLength(4)
    expect(rowText(three.needs.rows.at(-1)!).trim()).toBe('+9 more')
    const fits = go({ asks: TWELVE.slice(0, 4) }, { limit: 4 })
    expect([fits.needs.shown, fits.needs.more]).toEqual([4, 0])
    expect(fits.needs.rows).toHaveLength(4)
    expect(dump(fits)).not.toMatch(/\+\d+ more/)
  })

  test('D5 an empty block is one dim line; a block with items is not; empty blocks stay when the others are full', () => {
    const empty = go()
    expect(empty.needs.rows.map(rowText)).toEqual(['nothing needs you'])
    expect(empty.highlights.rows.map(rowText)).toEqual(['no highlights yet'])
    expect(empty.watch.rows.map(rowText)).toEqual(['nothing to watch'])
    for (const block of [empty.needs, empty.highlights, empty.watch]) {
      expect([block.total, block.shown, block.more]).toEqual([0, 0, 0])
      expect(block.items).toEqual([])
      expect(block.rows).toHaveLength(1)
      expect(block.rows[0]!.left.every(one => one.tone === 'dim')).toBe(true)
    }
    const mixed = go({ asks: TWELVE })
    expect(mixed.needs.rows.map(rowText)).not.toContain('nothing needs you')
    expect(mixed.highlights.rows.map(rowText)).toEqual(['no highlights yet'])
    expect(mixed.watch.rows.map(rowText)).toEqual(['nothing to watch'])
  })
})

describe('digest marks, ages and no source tag', () => {
  test('D6 every timed item carries its age in the right group of row 1 and no [source] tag, per kind', () => {
    const cases: [string, () => DigestBlock, string][] = [
      ['question', () => go({ asks: [ask('question', 4 * MIN)] }).needs, '4m'],
      ['READY', () => go({ prs: [READY7] }).needs, '4m'],
      ['decision', () => go({ decisions: [decision('split the PR', 'Dave', 3 * HOUR)] }).highlights, '3h'],
      ['proof', () => go({ proofs: [proofOk('validate-mods', 2 * 24 * HOUR)] }).highlights, '2d'],
      ['commit', () => go({}, { commits: [commit('fix: scrub', 20 * MIN)] }).highlights, '20m'],
    ]
    for (const [name, block, age] of cases) {
      const found = block()
      expect(found.items, name).toHaveLength(1)
      expect(ageOf(found.items[0]!), name).toBe(age)
      expect(items(found)[0], name).not.toMatch(OLD_TAG)
    }
  })

  test('D6 an item with no time has no age and no tag: the steward drift of a session with no brief', () => {
    const found = go({ drift: driftOf(null, { toolCalls: 3, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 }) }).watch
    expect(found.items).toHaveLength(1)
    expect([undefined, '-']).toContain(ageOf(found.items[0]!))
    expect(items(found)[0]).not.toMatch(OLD_TAG)
    expect(items(found)[0]).not.toMatch(/undefined|NaN/)
  })

  test('D6 the age steps: under a minute is now, then minutes, hours, days', () => {
    const age = (ms: number): string | undefined => ageOf(go({ asks: [ask('q', ms)] }).needs.items[0]!)
    expect([0, 59_000].map(age)).toEqual(['now', 'now'])
    expect([60_000, 59 * MIN].map(age)).toEqual(['1m', '59m'])
    expect([60 * MIN, 23 * HOUR].map(age)).toEqual(['1h', '23h'])
    expect([24 * HOUR, 49 * HOUR].map(age)).toEqual(['1d', '2d'])
  })

  test('D6 a time ahead of the clock reads now, never a negative age', () => {
    expect(ageOf(go({ asks: [ask('from the future', -5 * MIN)] }).needs.items[0]!)).toBe('now')
  })

  test('N7 the mark is > in NEEDS YOU, + in DONE and ! in WATCH on row 1 only; rows 2 and 3 carry none', () => {
    const found = go(
      {
        asks: [ask('Which branch?', 2 * MIN, { recommend: 'main' })],
        decisions: [decision('split the PR', 'Dave', 3 * HOUR)],
        agents: [run('slow', 'running', 20 * MIN)],
      },
      { limit: 10 },
    )
    expect(rowText(found.needs.items[0]![0]!)).toMatch(/^\s*> /)
    expect(rowText(found.highlights.items[0]![0]!)).toMatch(/^\s*\+ /)
    expect(rowText(found.watch.items[0]![0]!)).toMatch(/^\s*! /)
    expect(found.needs.items[0]!.length).toBeGreaterThanOrEqual(2)
    for (const row of found.needs.items[0]!.slice(1)) expect(rowText(row)).not.toMatch(/^\s*[>+!] /)
    // The "+N more" row is not an item mark: it has no space after the plus.
    expect(rowText(go({ asks: Array.from({ length: 8 }, (_, i) => ask(`q${i}`, i * MIN)) }).needs.rows.at(-1)!)).toMatch(/^\s*\+3 more$/)
  })
})

describe('digest NEEDS YOU', () => {
  test('D7 an open ask shows its text; its recommendation is on the NEXT row as "I suggest: x"; one without a recommendation shows none', () => {
    const found = go({
      asks: [ask('Which branch should PR 5 start from?', 2 * MIN, { recommend: 'main at 0ae5f64a' }), ask('Paste the T2 response here', 9 * MIN)],
    })
    const [first, second] = found.needs.items
    expect(rowText(first![0]!)).toContain('Answer: Which branch should PR 5 start from?')
    expect(first!.length).toBeGreaterThanOrEqual(2)
    expect(rowText(first![1]!).trim().startsWith('I suggest: main at 0ae5f64a')).toBe(true)
    expect(rowText(second![0]!)).toContain('Answer: Paste the T2 response here')
    expect(items(found.needs)[1]).not.toMatch(/suggest|recommend/)
  })

  test('D7 an answered ask is not listed and not counted', () => {
    const found = go({ asks: [ask('already settled', 5 * MIN, { answered: true }), ask('still open', 6 * MIN)] })
    expect(found.needs.total).toBe(1)
    expect(dump(found)).not.toContain('already settled')
  })

  test('D7 the other ask kinds read Approve:, Decide: and Stuck:', () => {
    const found = go({ asks: [ask('Create the roles?', MIN, { kind: 'approval' }), ask('split the PR', 2 * MIN, { kind: 'decision', recommend: 'two PRs' }), ask('no network', 3 * MIN, { kind: 'block' })] })
    const list = items(found.needs)
    expect(list.find(one => one.includes('Create the roles?'))).toContain('Approve: Create the roles?')
    expect(list.find(one => one.includes('split the PR'))).toContain('Decide: split the PR. I suggest two PRs.')
    expect(list.find(one => one.includes('no network'))).toContain('Stuck: no network')
  })

  test('D8 a READY PR reads as the plain sentence with its number and age; the PR title and "PR #" are not drawn', () => {
    const found = go({ prs: [READY7] }).needs
    expect(found.items).toHaveLength(1)
    expect(rowText(found.items[0]![0]!)).toContain(READY_SENTENCE)
    expect(ageOf(found.items[0]!)).toBe('4m')
    expect(items(found)[0]).not.toContain('quiet alerts')
    expect(dump(go({ prs: [READY7] }))).not.toContain('PR #')
  })

  test('D8 a PR still PENDING or only CLOSED unmerged is not something Dave must do', () => {
    const found = go({ prs: [pr(1, 'PENDING', MIN), pr(2, 'CLOSED', MIN)] })
    expect(found.needs.total).toBe(0)
    expect(found.highlights.total).toBe(0)
  })

  test('D8 a rate limited PR reads the plain limited sentence; a PR with failed checks says failed with the count', () => {
    const limited = items(go({ prs: [pr(9, 'LIMITED', 6 * MIN, { rateLimit: { minutes: 14 } })] }).needs)
    expect(limited[0]).toContain('The review of change #9 did not finish: reviewer rate limit.')
    const failed = items(go({ prs: [pr(5, 'PENDING', 6 * MIN, { failedChecks: 2 })] }).needs)
    expect(failed[0]).toMatch(/change #5\b/i)
    expect(failed[0]).toMatch(/2 checks? failed|failed.*2/i)
    expect(failed[0]).not.toContain('PR #')
  })

  test('D8 a LIMITED PR with no wait time says the review did not finish, not rate limit', () => {
    const limited = items(go({ prs: [pr(9, 'LIMITED', 6 * MIN)] }).needs)
    expect(limited[0]).toContain('The review of change #9 did not finish.')
    expect(limited[0]).not.toMatch(/rate limit/i)
  })

  test('D8 a blocked plan step is listed with its text as "Stuck on: x"; a todo or done step is not', () => {
    const brief = made({
      goal: 'ship PR 5',
      plan: [
        { id: 'a', text: 'wait for CodeRabbit capacity', status: 'blocked' },
        { id: 'b', text: 'write the digest', status: 'todo' },
        { id: 'c', text: 'write the tests', status: 'done' },
      ],
    })
    const list = items(go({ brief }).needs)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('Stuck on: wait for CodeRabbit capacity')
  })

  test('D8 a failed proof is a failed check in NEEDS YOU with its subject and "k of n tests fail", and is not in DONE', () => {
    const found = go({ proofs: [proofOk('validate-mods', 8 * MIN, { result: { passed: 500, failed: 2 } })] })
    const list = items(found.needs)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('validate-mods')
    expect(list[0]).toContain('2 of 502 tests fail')
    expect(found.highlights.total).toBe(0)
  })
})

describe('digest DONE', () => {
  test('D9 a passed proof shows its subject and "502 tests pass, 0 fail" and not its artifact name', () => {
    const list = items(go({ proofs: [proofOk('validate-mods', 10 * MIN)] }).highlights)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('validate-mods')
    expect(list[0]).toContain('502 tests pass, 0 fail')
    expect(list[0]).not.toMatch(/steward-green|\.txt|e2e/)
  })

  test('D9 a decision by Dave is in DONE with the word Dave; a decision by the model is not', () => {
    const found = go({ decisions: [decision('PR split: parser first', 'Dave', 60 * MIN), decision('use a pure model', 'Claude', 10 * MIN)] })
    const list = items(found.highlights)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('PR split: parser first')
    expect(list[0]).toContain('Dave')
  })

  test('D9 milestones: a commit with its subject and no sha, a merged PR as "Change #N is merged.", a finished run as "A helper finished: x"', () => {
    const found = go(
      { prs: [pr(206, 'CLOSED', 90 * MIN, { merged: true }), pr(209, 'CLOSED', 80 * MIN, { merged: true })], agents: [run('review', 'done', 40 * MIN), run('live', 'running', 2 * MIN)] },
      { limit: 10, commits: [commit('test(pr-loop): RED for quiet alerts so READY stops waking the model', 5 * MIN)] },
    )
    const list = items(found.highlights)
    expect(list.find(one => one.includes('RED for quiet alerts'))).toBeDefined()
    expect(list.join('\n')).not.toContain('b8448c3')
    expect(list.find(one => one.includes('#206'))).toContain('Change #206 is merged.')
    expect(list.find(one => one.includes('#209'))).toContain('Change #209 is merged.')
    expect(list.find(one => one.includes('job review'))).toContain('A helper finished: job review')
    expect(list.some(one => one.includes('job live'))).toBe(false)
  })
})

describe('digest WATCH', () => {
  const TASKS: OsTask[] = [
    { id: '1', subject: 'first step', status: 'completed' },
    { id: '2', subject: 'second step', status: 'completed' },
    { id: '3', subject: 'third step', status: 'in_progress' },
  ]

  test('D10 a done task with no proof is "Done but not proven yet: x"; a proven, a running and a waiting one are not', () => {
    const brief = made({ proof: { taskId: '1', artifact: 'cache/e2e/one.txt' } }, TASKS)
    const list = items(go({ brief, tasks: TASKS }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('Done but not proven yet: second step')
    expect(list[0]).not.toMatch(OLD_TAG)
  })

  test('D10 with no task list, a done plan step with no proof is unproven too', () => {
    const brief = made({ goal: 'g', plan: [{ id: 'a', text: 'write the tests', status: 'done' }, { id: 'b', text: 'write the digest', status: 'doing' }] })
    const list = items(go({ brief }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('Done but not proven yet: write the tests')
  })

  test('D10 the steward drift is told in the plain sentence (driftSentence); ok draws nothing', () => {
    const planned = made({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
    const found = driftOf(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
    expect(found.level).toBe('stale')
    const watch = go({ brief: planned, drift: found }).watch
    expect(watch.items).toHaveLength(1)
    expect(items(watch)[0]).toContain('12 tool calls and 1 commit since the plan last changed.')
    expect(items(watch)[0]).not.toContain('brief stale')
    expect(ageOf(watch.items[0]!)).toBe('3h')
    const ok: Drift = { level: 'ok', reason: '', key: 'ok@0' }
    expect(go({ brief: planned, drift: ok }).watch.total).toBe(0)
    expect(go({ brief: planned, drift: null }).watch.total).toBe(0)
  })

  test('D10 a PR with open threads says how many in change words; no threads is not a watch item', () => {
    const one = items(go({ prs: [pr(12, 'REVIEWED', 30 * MIN, { threads: 1 })] }).watch)
    expect(one[0]).toMatch(/change #12\b/i)
    expect(one[0]).toMatch(/1 unresolved thread\b/)
    expect(one[0]).not.toContain('PR #')
    const many = items(go({ prs: [pr(12, 'REVIEWED', 30 * MIN, { threads: 3 })] }).watch)
    expect(many[0]).toMatch(/3 unresolved threads/)
    expect(go({ prs: [pr(12, 'PENDING', 30 * MIN, { threads: 0 })] }).watch.total).toBe(0)
  })

  test('D10 a helper running more than 10 minutes reads "A helper has run N min: x"; one under 10 minutes, or finished, is not listed', () => {
    const list = items(go({ agents: [run('slow', 'running', 11 * MIN), run('quick', 'running', 9 * MIN), run('old', 'done', 3 * HOUR)] }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('A helper has run 11 min: job slow')
  })

  test('D10 a lane held by a peer reads "Another session holds lane x"; my own lane is not listed', () => {
    const mine: DigestLane = { id: 'os-pane', title: 'OS pane', state: 'active', mine: true, at: NOW - HOUR }
    const found = go({ lanes: [peer('sdlc-os'), mine] }).watch
    expect(found.items).toHaveLength(1)
    expect(items(found)[0]).toContain('Another session holds lane sdlc-os')
    expect(items(found)[0]).not.toMatch(OLD_TAG)
    expect(ageOf(found.items[0]!)).toBe('2h')
    expect(dump(go({ lanes: [peer('sdlc-os'), mine] }))).not.toContain('os-pane')
  })

  test('D10 an open step or decision that says follow-up or deferred is listed; a finished one is not', () => {
    const brief = made({
      goal: 'g',
      plan: [
        { id: 'a', text: 'left for follow-up: FastAPI parity docs PR', status: 'todo' },
        { id: 'b', text: 'follow-up 1 done already', status: 'done' },
        { id: 'c', text: 'write the digest', status: 'doing' },
      ],
      decision: { text: 'Deferred: the hud key for the Fleet', by: 'Dave' },
    })
    const list = items(go({ brief, decisions: [decision('Deferred: the hud key for the Fleet', 'Dave', HOUR)] }).watch)
    expect(list.some(one => one.includes('FastAPI parity docs PR'))).toBe(true)
    expect(list.some(one => one.includes('the hud key for the Fleet'))).toBe(true)
    expect(list.some(one => one.includes('follow-up 1 done already'))).toBe(false)
    expect(list.some(one => one.includes('write the digest'))).toBe(false)
  })
})

describe('digest keeper line', () => {
  const kept = (over: Partial<DigestCompaction> = {}): DigestCompaction => ({ at: NOW - 10 * MIN, sessionId: SESSION, open: 3, total: 7, kept: true, ...over })
  const lost = (ago: number): DigestCompaction => kept({ at: NOW - ago, kept: false })
  const keeperRows = (compactions: DigestCompaction[]): string[] => items(go({}, { compactions, limit: 10 }).watch)
  const KEPT = 'The last summary kept the plan.'
  const LOST = 'The last summary lost the plan.'

  test('D11 a record with kept=true reads "The last summary kept the plan." with its age', () => {
    const watch = go({}, { compactions: [kept()], limit: 10 }).watch
    expect(watch.items).toHaveLength(1)
    expect(items(watch)[0]).toContain(KEPT)
    expect(ageOf(watch.items[0]!)).toBe('10m')
  })

  test('D11 a record with kept=false reads "The last summary lost the plan."', () => {
    expect(keeperRows([lost(10 * MIN)])[0]).toContain(LOST)
  })

  test('D11 no record draws no keeper line', () => {
    expect(keeperRows([]).join('\n')).not.toMatch(/summary|plan keeper/)
    expect(go({}, { compactions: [], limit: 10 }).watch.total).toBe(0)
  })

  test('D11 the newest record sets the line, whatever the input order', () => {
    const list = keeperRows([lost(3 * HOUR), kept({ at: NOW - 5 * MIN }), lost(2 * HOUR)])
    expect(list.join('\n')).toContain(KEPT)
    expect(list.join('\n')).not.toContain(LOST)
  })

  test('D11 kill rule: 3 of the newest 5 lost the plan reads the keeper line and names removing it; 2 of 5 does not', () => {
    const threeLost = [kept({ at: NOW - 5 * MIN }), lost(HOUR), kept({ at: NOW - 2 * HOUR }), lost(3 * HOUR), lost(4 * HOUR)]
    expect(keeperRows(threeLost).join('\n')).toContain('The plan keeper failed 3 of 5 times. Consider removing it.')
    const twoLost = [kept({ at: NOW - 5 * MIN }), lost(HOUR), kept({ at: NOW - 2 * HOUR }), kept({ at: NOW - 3 * HOUR }), lost(4 * HOUR)]
    expect(keeperRows(twoLost).join('\n')).not.toMatch(/plan keeper failed/)
  })

  test('D11 only the newest 5 records count for the kill rule', () => {
    const recent = [kept({ at: NOW - 1 * MIN }), kept({ at: NOW - 2 * MIN }), kept({ at: NOW - 3 * MIN }), lost(4 * MIN), lost(5 * MIN)]
    const older = [lost(6 * HOUR), lost(7 * HOUR), lost(8 * HOUR)]
    expect(keeperRows([...recent, ...older]).join('\n')).not.toMatch(/plan keeper failed/)
  })
})

describe('digest derived facts', () => {
  test('D12 a derived decision or proof carries "[derived]" in its text; the same fact without the mark does not', () => {
    const handoff = decision('follow_up_order: 1 rawProject, 2 hud + band', 'handoff', 2 * HOUR, { derived: true })
    const seen = proofOk('stop the path leak', 30 * MIN, { result: undefined, derived: true, artifact: 'e2e/2026-10-28-fu1-rawproject-green.txt' })
    const marked = items(go({ decisions: [handoff], proofs: [seen] }, { limit: 10 }).highlights)
    expect(marked).toHaveLength(2)
    for (const one of marked) expect(one).toContain('[derived]')
    const plain = items(go({ decisions: [decision('PR split: parser first', 'Dave', HOUR)], proofs: [proofOk('validate-mods', HOUR)] }, { limit: 10 }).highlights)
    expect(plain).toHaveLength(2)
    for (const one of plain) expect(one).not.toContain('derived')
  })

  test('D12 a decision by the model that is not derived stays out, a derived one by the handoff comes in', () => {
    const found = go({ decisions: [decision('use a pure model', 'Claude', HOUR), decision('band_rule: no ctx or cost', 'handoff', HOUR, { derived: true })] })
    const list = items(found.highlights)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('band_rule')
  })

  test('D12 a derived decision that says follow-up shows in WATCH as [derived], a plain one does not', () => {
    const derived = items(go({ decisions: [decision('follow-up: split the parser', 'handoff', HOUR, { derived: true })] }).watch)
    expect(derived).toHaveLength(1)
    expect(derived[0]).toContain('[derived]')
    const plain = items(go({ decisions: [decision('follow-up: split the parser', 'Claude', HOUR)] }).watch)
    expect(plain[0]).not.toContain('derived')
  })
})

describe('digest safety', () => {
  const dirty = (): Partial<In> => ({
    brief: made({ goal: 'g', plan: [{ id: 'a', text: 'left for follow-up: step', status: 'todo' }] }),
    drift: { level: 'stale', reason: `after ${SECRET} was used`, key: 'stale@1' },
    asks: [ask(`ask ${SECRET}`, MIN, { recommend: `rec ${SECRET}` })],
    decisions: [decision(`decided ${SECRET}`, 'Dave', MIN)],
    proofs: [proofOk(`subject ${SECRET}`, MIN, { artifact: `path/${SECRET}.txt` })],
    prs: [pr(7, 'READY', MIN, { title: `title ${SECRET}` })],
    agents: [run('slow', 'running', 20 * MIN, { description: `desc ${SECRET}` })],
    lanes: [peer('lane-x', { title: `lane ${SECRET}`, holder: `peer ${SECRET}`, note: `note ${SECRET}`, overlap: [`src/${SECRET}.ts`] })],
  })

  test('D13 a secret in any input is in no row, whole or cut by the width, at any width', () => {
    for (const columns of [20, 24, 33, 40, 60, 100, 200]) {
      const found = go(dirty(), { columns, limit: 10, commits: [commit(`fix ${SECRET}`, MIN)], compactions: [] })
      const text = dump(found)
      expect(text, String(columns)).not.toContain(SECRET)
      expect(text, String(columns)).not.toMatch(/sk-ant|aaaaaaaa/)
    }
  })

  test('D14 the same input and clock give the same answer, and a deeply frozen input does not throw', () => {
    const freeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) freeze(inner)
      return Object.freeze(value)
    }
    const input = freeze({
      ...BASE,
      brief: made({ goal: 'g' }),
      asks: [ask('q', MIN, { recommend: 'r' })],
      prs: [READY7],
      agents: [run('slow', 'running', 20 * MIN)],
      proofs: [proofOk('validate-mods', MIN)],
    })
    const first = go(input, { commits: freeze([commit('fix', MIN)]) })
    const second = go(input, { commits: freeze([commit('fix', MIN)]) })
    expect(second).toEqual(first)
    expect(dump(go(input, { now: NOW + HOUR }))).not.toBe(dump(first))
  })

  test('D15 a multi-line or control-character text draws no control character and no new line', () => {
    const found = go({ asks: [ask('first line\nsecond line\r\nthird\u0007 bell\ttab', MIN, { recommend: 'yes\nno' })] })
    expect(found.needs.items).toHaveLength(1)
    for (const row of found.needs.rows) expect(rowText(row)).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f]/)
    expect(rowText(found.needs.items[0]![0]!)).toContain('first line')
  })

  test('D16 5,000 character texts stay inside every row and the line cap; 2,000 items stay inside the cap and finish in 500 ms', () => {
    const long = 'x'.repeat(5000)
    const start = performance.now()
    const found = go(
      {
        asks: Array.from({ length: 2000 }, (_, i) => ask(`${long} ${i}`, i * 1000, { recommend: long })),
        decisions: Array.from({ length: 2000 }, (_, i) => decision(long, 'Dave', i * 1000)),
        prs: Array.from({ length: 500 }, (_, i) => pr(i + 1, 'REVIEWED', i * 1000, { threads: 2, title: long })),
      },
      { columns: 80 },
    )
    expect(performance.now() - start).toBeLessThan(500)
    expect(found.needs.total).toBe(2000)
    expect(found.needs.shown).toBe(MAX_ITEMS)
    expect(found.highlights.total).toBe(2000)
    expect(found.watch.total).toBe(500)
    for (const row of everyRow(found)) expect(rowWidth(row)).toBeLessThanOrEqual(80)
    for (const block of [found.needs, found.highlights, found.watch]) for (const group of block.items) expect(group.length).toBeLessThanOrEqual(3)
  })
})

describe('digest width and plain words', () => {
  const full = (): Partial<In> => ({
    brief: made({ goal: 'g', plan: [{ id: 'a', text: 'wait for capacity', status: 'blocked' }] }),
    asks: [ask('Which branch should PR 5 start from?', 2 * MIN, { recommend: 'main at 0ae5f64a' }), ask('Create the roles?', 3 * MIN, { kind: 'approval' })],
    prs: [READY7, pr(9, 'LIMITED', 6 * MIN, { rateLimit: { minutes: 14 } }), pr(12, 'REVIEWED', 30 * MIN, { threads: 3 })],
    decisions: [decision('PR split: parser first', 'Dave', HOUR)],
    proofs: [proofOk('validate-mods', 10 * MIN)],
    agents: [run('slow', 'running', 20 * MIN)],
    lanes: [peer('sdlc-os', { overlap: ['hooks/agentic-os/digest.ts'] })],
  })
  const MARK_ROW = /^\s*[>+!] /

  test('D17 no row is wider than the pane from 20 to 200 columns, every item starts with its mark, and an age is a plain age', () => {
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 1 : 7) {
      const found = go(full(), { columns, limit: 10, commits: [commit('test(pr-loop): RED for quiet alerts so READY stops waking the model', MIN)] })
      let aged = 0
      for (const block of [found.needs, found.highlights, found.watch]) {
        expect(rowWidth(block.head), `${columns} head`).toBeLessThanOrEqual(columns)
        for (const row of block.rows) expect(rowWidth(row), `${columns}: ${rowText(row)}`).toBeLessThanOrEqual(columns)
        for (const group of block.items) {
          expect(rowText(group[0]!), `${columns}`).toMatch(MARK_ROW)
          const age = ageOf(group)
          if (age !== undefined) {
            aged += 1
            expect(age, `${columns}`).toMatch(/^(?:now|\d+[mhd]|-)$/)
          }
        }
      }
      if (columns >= 24) expect(aged, `${columns} columns keep the age`).toBeGreaterThan(0)
    }
  })

  test('D18 no raw code, null or undefined reaches a row', () => {
    const found = go(full(), { limit: 10, commits: [commit('fix: scrub', MIN)] })
    expect(dump(found)).not.toMatch(/\b(?:LIMITED|REVIEWED|STALLED|PENDING|whenReady)\b|\bnull\b|undefined|\[object/)
  })
})

describe('digest multi-row items', () => {
  test('N1 an ask longer than 3 rows draws exactly 3 rows, inside the width, ending "...more -> Choices"; the keys are -, -2, -3', () => {
    const found = go({ asks: [ask(LONG_ASK, 5 * MIN)] }, { columns: 40 })
    const group = found.needs.items[0]!
    expect(group).toHaveLength(3)
    expect(group.map(one => one.key)).toEqual(['brief-needs-0', 'brief-needs-0-2', 'brief-needs-0-3'])
    for (const row of group) expect(rowWidth(row)).toBeLessThanOrEqual(40)
    expect(leftText(group[2]!)).toMatch(HINT('Choices'))
    expect(leftText(group[0]!)).not.toMatch(/more/)
    expect(rowText(group[0]!)).toMatch(/^\s*> Answer: word0 word1/)
    expect(found.needs.rows).toEqual(group)
  })

  test('N1 a cut blocked step keeps its words in order and ends with a hint that names a tab', () => {
    const brief = made({ goal: 'g', plan: [{ id: 'a', text: LONG_ASK.slice(0, 190), status: 'blocked' }] })
    const group = go({ brief }, { columns: 40 }).needs.items[0]!
    expect(group).toHaveLength(3)
    const text = group.map(leftText).join(' ')
    expect(text).toContain('Stuck on: word0 word1 word2')
    expect(text).toMatch(/(?:\.\.\.|…)more -> [A-Z][a-z]+$/)
  })

  test('N1b a cut blocked step ends with the Steps hint, not Plan', () => {
    const brief = made({ goal: 'g', plan: [{ id: 'a', text: LONG_ASK.slice(0, 190), status: 'blocked' }] })
    const group = go({ brief }, { columns: 40 }).needs.items[0]!
    expect(leftText(group[group.length - 1]!)).toMatch(HINT('Steps'))
  })

  test('N1c a cut failed check ends with the Checks hint, not Proof', () => {
    const failed = proofOk(LONG_ASK, 5 * MIN, { result: { passed: 3, failed: 2 } })
    const group = go({ proofs: [failed] }, { columns: 40 }).needs.items[0]!
    expect(group.map(leftText).join(' ')).toContain('Check failed: word0 word1')
    expect(leftText(group[group.length - 1]!)).toMatch(HINT('Checks'))
  })

  // Guards the shared word list: the strip label of a tab and the digest hint for that tab must be one word. Fails if either
  // side keeps the old word or the two drift apart.
  test('N1d the digest hint for each home tab equals the TABS label of that tab: Steps, Work, Checks, Choices', () => {
    const blocked = made({ goal: 'g', plan: [{ id: 'a', text: LONG_ASK.slice(0, 190), status: 'blocked' }] })
    const hintOf = (found: ReturnType<typeof go>, block: 'needs' | 'watch'): string | undefined =>
      /(?:\.\.\.|…)more -> (\S+)$/.exec(found[block].items[0]!.map(leftText).join(' '))?.[1]
    const hints: Record<string, string | undefined> = {
      plan: hintOf(go({ brief: blocked }, { columns: 40 }), 'needs'),
      proof: hintOf(go({ proofs: [proofOk(LONG_ASK, 5 * MIN, { result: { passed: 3, failed: 2 } })] }, { columns: 40 }), 'needs'),
      decisions: hintOf(go({ asks: [ask(LONG_ASK, 5 * MIN)] }, { columns: 40 }), 'needs'),
      work: hintOf(go({ lanes: [peer('api-core', { overlap: ['hooks/agentic-os/digest.ts'] })] }), 'watch'),
    }
    const want: Record<string, string> = { plan: 'Steps', proof: 'Checks', decisions: 'Choices', work: 'Work' }
    for (const id of Object.keys(want)) {
      const label = TABS.find(one => one.id === id)?.label
      expect(hints[id], `hint of ${id}`).toBe(label)
      expect(label, `label of ${id}`).toBe(want[id])
    }
  })

  test('N2 a short plain item gets no hint and stays one row', () => {
    const group = go({ asks: [ask('Paste the T2 response here', 5 * MIN)] }).needs.items[0]!
    expect(group).toHaveLength(1)
    expect(group.map(leftText).join(' ')).not.toMatch(/more/)
  })

  test('N3 an ask with a recommendation ends with the Choices hint even when it all fits, and the hint is on its last row only', () => {
    const group = go({ asks: [ask('Which branch?', 5 * MIN, { recommend: 'main' })] }).needs.items[0]!
    expect(group).toHaveLength(2)
    expect(rowText(group[0]!)).toContain('Answer: Which branch?')
    expect(leftText(group[0]!)).not.toMatch(/more/)
    expect(rowText(group[1]!).trim().startsWith('I suggest: main')).toBe(true)
    expect(leftText(group[1]!)).toMatch(HINT('Choices'))
  })

  test('N3 an approval with a recommendation also ends with the Choices hint; one without does not', () => {
    const withRec = go({ asks: [ask('Create the roles?', MIN, { kind: 'approval', recommend: 'yes, after review' })] }).needs.items[0]!
    expect(withRec.map(leftText).join(' ')).toMatch(HINT('Choices'))
    const without = go({ asks: [ask('Create the roles?', MIN, { kind: 'approval' })] }).needs.items[0]!
    expect(without.map(leftText).join(' ')).not.toMatch(/more/)
  })

  test('N4 a peer lane with overlap reads "may touch the same files" and ends with the Work hint; one without overlap does neither', () => {
    const marked = go({ lanes: [peer('api-core', { overlap: ['hooks/agentic-os/digest.ts'] })] }).watch.items[0]!
    const text = marked.map(rowText).join(' ')
    expect(text).toContain('Another session holds lane api-core')
    expect(text).toContain('may touch the same files')
    expect(marked.map(leftText).join(' ')).toMatch(HINT('Work'))
    const plain = go({ lanes: [peer('docs-lane', { overlap: [] }), peer('other-lane')] }).watch.items
    expect(plain).toHaveLength(2)
    for (const group of plain) {
      const joined = group.map(rowText).join(' ')
      expect(joined).not.toContain('may touch')
      expect(joined).not.toMatch(/more/)
    }
  })

  test('N5 lineCap 1 draws one row per item, cut with an ellipsis; the default and lineCap 3 draw up to 3', () => {
    const asks = [ask(LONG_ASK, 5 * MIN), ask('short one', 6 * MIN, { recommend: 'yes' })]
    const one = go({ asks }, { columns: 40, lineCap: 1 })
    for (const group of one.needs.items) expect(group).toHaveLength(1)
    expect(leftText(one.needs.items[0]![0]!)).toMatch(/(?:…|\.\.\.)/)
    for (const row of one.needs.rows) expect(rowWidth(row)).toBeLessThanOrEqual(40)
    expect(go({ asks }, { columns: 40 }).needs.items[0]).toHaveLength(3)
    expect(go({ asks }, { columns: 40, lineCap: 3 }).needs.items[0]).toHaveLength(3)
  })
})

describe('digest fold', () => {
  const longAsks = (n: number): DigestAsk[] => Array.from({ length: n }, (_, i) => ask(`${LONG_ASK} ${i}`, (i + 1) * MIN))

  test('N6 fold keeps whole item groups: 2 of 5 long items keep 6 rows plus one "+N more" row that counts items', () => {
    const block = go({ asks: longAsks(12) }, { columns: 40 }).needs
    expect([block.shown, block.total]).toEqual([5, 12])
    expect(block.items.every(group => group.length === 3)).toBe(true)
    const cut = fold(block, 2)
    expect([cut.shown, cut.more, cut.total]).toEqual([2, 10, 12])
    expect(cut.items).toEqual(block.items.slice(0, 2))
    expect(cut.rows).toHaveLength(7)
    expect(cut.rows.slice(0, 6)).toEqual(block.items.slice(0, 2).flat())
    expect(rowText(cut.rows.at(-1)!).trim()).toBe('+10 more')
  })

  test('N6 the row count of a fold grows by one whole group per item: 4, 7, 10, 13 rows for 1 to 4 items of 5', () => {
    const block = go({ asks: longAsks(12) }, { columns: 40 }).needs
    expect([1, 2, 3, 4].map(limit => fold(block, limit).rows.length)).toEqual([4, 7, 10, 13])
  })

  test('N6 a fold at or above what is shown changes nothing; a fold to 0 keeps only the "+N more" row; an exact fit has no "+N more"', () => {
    const block = go({ asks: longAsks(12) }, { columns: 40 }).needs
    expect(fold(block, 5)).toEqual(block)
    expect(fold(block, 9)).toEqual(block)
    const zero = fold(block, 0)
    expect([zero.shown, zero.items, zero.rows.length]).toEqual([0, [], 1])
    expect(rowText(zero.rows[0]!).trim()).toBe('+12 more')
    const three = go({ asks: longAsks(3) }, { columns: 40 }).needs
    expect(three.rows).toHaveLength(9)
    expect(dump(go({ asks: longAsks(3) }, { columns: 40 }))).not.toMatch(/\+\d+ more/)
  })
})
