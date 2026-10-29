import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { MAX_ITEMS, MIN_ITEMS, digest } from '../hooks/agentic-os/digest'
import type { DigestAsk, DigestBlock, DigestCommit, DigestCompaction, DigestDecision, DigestLane, DigestOptions, DigestPr, DigestProof } from '../hooks/agentic-os/digest'
import { drift as driftOf } from '../hooks/agentic-os/steward'
import type { Drift } from '../hooks/agentic-os/steward'
import { keeperMarker } from '../hooks/compact-keeper/model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import type { AgentRun, OsTask } from '../types'

// PR 5, the /os session briefing (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to
// stay on top of"). digest() is pure and draws nothing itself: it returns three blocks of rows, NEEDS YOU, HIGHLIGHTS, WATCH.
//
// Contract these tests pin (the task text left these holes; the choices are mine and are listed in the report):
//   digest(brief, tasks, drift, prs, agents, lanes, asks, decisions, proofs, { now, columns, limit?, commits?, compactions? })
//   returns { needs, highlights, watch }, each { id, title, total, shown, more, head, rows }.
//   rows = the `shown` item rows, then one `+N more` row when more > 0; an empty block has exactly one dim row instead.
//   An item row is `  <text> [<source>] <age>` in `left` (never `right`, so a narrow pane cannot drop it).
//   Age is `now`, `Nm`, `Nh`, `Nd`, or `-` when the fact has no time. A fact marked `derived: true` carries `derived` in its tag.
//   NEEDS YOU order is Dave's listed order: open ask, READY PR, pending approval, blocked step, failed check, rate limit;
//   newest first inside one kind. HIGHLIGHTS and the rest are newest first. An agent run is long after 10 minutes.
//
// Ways the briefing can fail, one test each:
// D1  the blocks are missing, renamed or out of order
// D2  NEEDS YOU lists its kinds in the wrong order
// D3  an item list is not newest first (HIGHLIGHTS across kinds, asks inside one kind)
// D4  more than the cap is drawn, the "+N more" count is wrong, or the cap does not follow the caller's limit
// D5  an empty block is not one dim line, or collapses when the other blocks are full
// D6  an item has no source tag or no age; the age steps are off; a time in the future reads negative
// D7  an open ask loses its recommendation, an answered ask is listed, an ask without one invents it
// D8  a READY PR does not read as waiting for the merge yes, a rate limit, a blocked step or a failed check is missing
// D9  HIGHLIGHTS loses a milestone (commit, merged PR, finished run), a Dave decision, a proof with its numbers; or lists a failed proof or a decision by the model
// D10 WATCH loses an unproven step, the steward drift (reused, not reworded), a PR with open threads, a long agent, a peer lane, a deferred item
// D11 the compact-keeper check: yes / no / mismatch / other session / no compaction, and the kill rule (3 of the last 5 lost the plan)
// D12 a derived fact is not marked derived, or a plain fact is
// D13 a secret in any input reaches a row, whole or cut by the width
// D14 the same input gives a different answer, a frozen input throws, or a clock is read
// D15 a multi-line or control-character input draws more than one line
// D16 5,000 character texts and 2,000 items overflow a row, the cap, or take long
// D17 a row is wider than the pane from 20 to 200 columns, or the tag and age are cut off the end
// D18 a raw code (LIMITED, REVIEWED, null, undefined) leaks into plain words

const NOW = 100 * 3600_000
const MIN = 60_000
const HOUR = 3600_000
const SESSION = '364266d5-0000-4000-8000-000000000000'
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
const items = (block: DigestBlock): string[] => block.rows.slice(0, block.shown).map(rowText)
const everyRow = (found: ReturnType<typeof go>): PaneRow[] => [found.needs, found.highlights, found.watch].flatMap(block => [block.head, ...block.rows])
const dump = (found: ReturnType<typeof go>): string => everyRow(found).map(rowText).join('\n')
const at = (list: string[], word: string): number => list.findIndex(one => one.includes(word))

const ITEM_END = /\[[a-z][a-z -]*\] (?:now|\d+[mhd]|-)$/

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

// The READY alert of a PR #7-style watch: the pr-loop drops a READY PR from the live list, so the caller feeds it here.
const READY7 = pr(7, 'READY', 4 * MIN, { title: 'feat(pr-loop): quiet alerts so READY stops waking the model' })

describe('digest blocks', () => {
  test('D1 three blocks in this order: NEEDS YOU, HIGHLIGHTS, WATCH, each with a head row that starts with its title', () => {
    const found = go()
    expect(Object.keys(found)).toEqual(['needs', 'highlights', 'watch'])
    expect([found.needs.title, found.highlights.title, found.watch.title]).toEqual(['NEEDS YOU', 'HIGHLIGHTS', 'WATCH'])
    expect([found.needs.id, found.highlights.id, found.watch.id]).toEqual(['needs', 'highlights', 'watch'])
    for (const block of [found.needs, found.highlights, found.watch]) expect(rowText(block.head)).toMatch(new RegExp(`^${block.title}\\b`))
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

  test('D3 HIGHLIGHTS are newest first across commits, proofs, merged PRs, decisions and finished runs', () => {
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
    expect(found.needs.rows).toHaveLength(MAX_ITEMS + 1)
    expect(rowText(found.needs.rows.at(-1)!).trim()).toBe(`+${12 - MAX_ITEMS} more`)
    expect(items(found.needs)[0]).toContain('question 0')
  })

  test('D4 the caller limit wins (a short pane asks for fewer), and an exact fit has no "+N more" row', () => {
    const three = go({ asks: TWELVE }, { limit: 3 })
    expect([three.needs.shown, three.needs.more, three.needs.rows]).toEqual([3, 9, three.needs.rows])
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
      expect(block.rows).toHaveLength(1)
      expect(block.rows[0]!.left.every(one => one.tone === 'dim')).toBe(true)
    }
    const mixed = go({ asks: TWELVE })
    expect(mixed.needs.rows.map(rowText)).not.toContain('nothing needs you')
    expect(mixed.highlights.rows.map(rowText)).toEqual(['no highlights yet'])
    expect(mixed.watch.rows.map(rowText)).toEqual(['nothing to watch'])
  })
})

describe('digest source tag and age', () => {
  test('D6 every item ends with its source tag and age, per kind', () => {
    const cases: [string, () => DigestBlock, string][] = [
      ['question', () => go({ asks: [ask('question', 4 * MIN)] }).needs, '[ask] 4m'],
      ['READY', () => go({ prs: [READY7] }).needs, '[pr] 4m'],
      ['decision', () => go({ decisions: [decision('split the PR', 'Dave', 3 * HOUR)] }).highlights, '[decision] 3h'],
      ['proof', () => go({ proofs: [proofOk('validate-mods', 2 * 24 * HOUR)] }).highlights, '[proof] 2d'],
      ['commit', () => go({}, { commits: [commit('fix: scrub', 20 * MIN)] }).highlights, '[git] 20m'],
      ['drift without a brief', () => go({ drift: driftOf(null, { toolCalls: 3, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 }) }).watch, '[steward] -'],
    ]
    for (const [name, block, tail] of cases) {
      const list = items(block())
      expect(list, name).toHaveLength(1)
      expect(list[0], name).toMatch(ITEM_END)
      expect(list[0]!.endsWith(tail), `${name}: ${list[0]}`).toBe(true)
    }
  })

  test('D6 the age steps: under a minute is now, then minutes, hours, days', () => {
    const ageOf = (ms: number): string => items(go({ asks: [ask('q', ms)] }).needs)[0]!.split(' ').at(-1)!
    expect([0, 59_000].map(ageOf)).toEqual(['now', 'now'])
    expect([60_000, 59 * MIN].map(ageOf)).toEqual(['1m', '59m'])
    expect([60 * MIN, 23 * HOUR].map(ageOf)).toEqual(['1h', '23h'])
    expect([24 * HOUR, 49 * HOUR].map(ageOf)).toEqual(['1d', '2d'])
  })

  test('D6 a time ahead of the clock reads now, never a negative age', () => {
    const list = items(go({ asks: [ask('from the future', -5 * MIN)] }).needs)
    expect(list[0]).toMatch(/\[ask\] now$/)
  })
})

describe('digest NEEDS YOU', () => {
  test('D7 an open ask shows its text and its recommendation; one without a recommendation shows none', () => {
    const found = go({
      asks: [
        ask('Which branch should PR 5 start from?', 2 * MIN, { recommend: 'main at 0ae5f64a' }),
        ask('Paste the T2 response here', 9 * MIN),
      ],
    })
    const list = items(found.needs)
    expect(list[0]).toContain('Which branch should PR 5 start from?')
    expect(list[0]).toContain('recommend: main at 0ae5f64a')
    expect(list[1]).toContain('Paste the T2 response here')
    expect(list[1]).not.toContain('recommend')
  })

  test('D7 an answered ask is not listed and not counted', () => {
    const found = go({ asks: [ask('already settled', 5 * MIN, { answered: true }), ask('still open', 6 * MIN)] })
    expect(found.needs.total).toBe(1)
    expect(dump(found)).not.toContain('already settled')
  })

  test('D8 a READY PR reads in plain words as waiting for the merge yes, with its number and age', () => {
    const list = items(go({ prs: [READY7] }).needs)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatch(/#7\b/)
    expect(list[0]).toMatch(/ready/i)
    expect(list[0]).toMatch(/merge yes/i)
    expect(list[0]).toContain('[pr] 4m')
  })

  test('D8 a PR still PENDING or only CLOSED unmerged is not something Dave must do', () => {
    const found = go({ prs: [pr(1, 'PENDING', MIN), pr(2, 'CLOSED', MIN)] })
    expect(found.needs.total).toBe(0)
    expect(found.highlights.total).toBe(0)
  })

  test('D8 a rate limited PR reads rate limit with the wait; a PR with failed checks says failed with the count', () => {
    const limited = items(go({ prs: [pr(9, 'LIMITED', 6 * MIN, { rateLimit: { minutes: 14 } })] }).needs)
    expect(limited[0]).toMatch(/#9\b/)
    expect(limited[0]).toMatch(/rate limit/i)
    expect(limited[0]).toContain('14')
    const failed = items(go({ prs: [pr(5, 'PENDING', 6 * MIN, { failedChecks: 2 })] }).needs)
    expect(failed[0]).toMatch(/#5\b/)
    expect(failed[0]).toMatch(/2 checks? failed|failed.*2/i)
  })

  test('D8 a blocked plan step is listed with its text; a todo or done step is not', () => {
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
    expect(list[0]).toContain('wait for CodeRabbit capacity')
    expect(list[0]).toMatch(/blocked/i)
  })

  test('D8 a failed proof is a failed check in NEEDS YOU with its numbers, and is not a highlight', () => {
    const found = go({ proofs: [proofOk('validate-mods', 8 * MIN, { result: { passed: 500, failed: 2 } })] })
    const list = items(found.needs)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('validate-mods')
    expect(list[0]).toMatch(/failed/i)
    expect(list[0]).toContain('2')
    expect(found.highlights.total).toBe(0)
  })
})

describe('digest HIGHLIGHTS', () => {
  test('D9 a passed proof shows its subject and its numbers: 502 pass, 0 fail', () => {
    const list = items(go({ proofs: [proofOk('validate-mods', 10 * MIN)] }).highlights)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('validate-mods')
    expect(list[0]).toContain('502 pass')
    expect(list[0]).toContain('0 fail')
  })

  test('D9 a decision by Dave is a highlight with the word Dave; a decision by the model is not', () => {
    const found = go({ decisions: [decision('PR split: parser first', 'Dave', 60 * MIN), decision('use a pure model', 'Claude', 10 * MIN)] })
    const list = items(found.highlights)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('PR split: parser first')
    expect(list[0]).toContain('Dave')
  })

  test('D9 milestones: a commit with its subject, a merged PR with its number, a finished run with its job', () => {
    const found = go(
      { prs: [pr(206, 'CLOSED', 90 * MIN, { merged: true }), pr(209, 'CLOSED', 80 * MIN, { merged: true })], agents: [run('review', 'done', 40 * MIN), run('live', 'running', 2 * MIN)] },
      { limit: 10, commits: [commit('test(pr-loop): RED for quiet alerts so READY stops waking the model', 5 * MIN)] },
    )
    const list = items(found.highlights)
    expect(list.find(one => one.includes('RED for quiet alerts'))).toMatch(/\[git\]/)
    expect(list.find(one => one.includes('#206'))).toMatch(/merged/i)
    expect(list.find(one => one.includes('#209'))).toMatch(/merged/i)
    expect(list.find(one => one.includes('job review'))).toMatch(/\[agent\]/)
    expect(list.some(one => one.includes('job live'))).toBe(false)
  })
})

describe('digest WATCH', () => {
  const TASKS: OsTask[] = [
    { id: '1', subject: 'first step', status: 'completed' },
    { id: '2', subject: 'second step', status: 'completed' },
    { id: '3', subject: 'third step', status: 'in_progress' },
  ]

  test('D10 a done task with no proof is listed as unproven; a proven, a running and a waiting one are not', () => {
    const brief = made({ proof: { taskId: '1', artifact: 'cache/e2e/one.txt' } }, TASKS)
    const list = items(go({ brief, tasks: TASKS }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('second step')
    expect(list[0]).toMatch(/unproven/i)
    expect(list[0]).toMatch(/\[task\]/)
  })

  test('D10 with no task list, a done plan step with no proof is unproven and tagged plan', () => {
    const brief = made({ goal: 'g', plan: [{ id: 'a', text: 'write the tests', status: 'done' }, { id: 'b', text: 'write the digest', status: 'doing' }] })
    const list = items(go({ brief }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('write the tests')
    expect(list[0]).toMatch(/\[plan\]/)
  })

  test('D10 the steward drift is reused word for word as "brief stale: <reason>", tagged steward; ok draws nothing', () => {
    const planned = made({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
    const found = driftOf(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
    expect(found.level).toBe('stale')
    const list = items(go({ brief: planned, drift: found }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain(`brief stale: ${found.reason}`)
    expect(list[0]).toMatch(/\[steward\] 3h$/)
    const ok: Drift = { level: 'ok', reason: '', key: 'ok@0' }
    expect(go({ brief: planned, drift: ok }).watch.total).toBe(0)
    expect(go({ brief: planned, drift: null }).watch.total).toBe(0)
  })

  test('D10 a PR with open threads says how many; no threads is not a watch item', () => {
    const one = items(go({ prs: [pr(12, 'REVIEWED', 30 * MIN, { threads: 1 })] }).watch)
    expect(one[0]).toMatch(/#12\b/)
    expect(one[0]).toMatch(/1 unresolved thread\b/)
    const many = items(go({ prs: [pr(12, 'REVIEWED', 30 * MIN, { threads: 3 })] }).watch)
    expect(many[0]).toMatch(/3 unresolved threads/)
    expect(go({ prs: [pr(12, 'PENDING', 30 * MIN, { threads: 0 })] }).watch.total).toBe(0)
  })

  test('D10 an agent running more than 10 minutes is listed with how long; one under 10 minutes, or finished, is not', () => {
    const list = items(go({ agents: [run('slow', 'running', 11 * MIN), run('quick', 'running', 9 * MIN), run('old', 'done', 3 * HOUR)] }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('job slow')
    expect(list[0]).toMatch(/running 11m/)
    expect(list[0]).toMatch(/\[agent\]/)
  })

  test('D10 a lane held by a peer is listed with the holder; my own lane is not', () => {
    const peer: DigestLane = { id: 'sdlc-os', title: 'SDLC OS', state: 'active', mine: false, holder: 'session 9f2c', at: NOW - 2 * HOUR }
    const mine: DigestLane = { id: 'os-pane', title: 'OS pane', state: 'active', mine: true, at: NOW - HOUR }
    const list = items(go({ lanes: [peer, mine] }).watch)
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('sdlc-os')
    expect(list[0]).toMatch(/held by session 9f2c/)
    expect(list[0]).toMatch(/\[lane\] 2h$/)
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

describe('digest compact-keeper check', () => {
  const kept = (over: Partial<DigestCompaction> = {}): DigestCompaction => ({
    at: NOW - 10 * MIN,
    sessionId: SESSION,
    open: 3,
    total: 7,
    summary: `Summary of the work.\n${keeperMarker(SESSION, 3, 7)}\nPending: the digest.`,
    ...over,
  })
  const lost = (ago: number): DigestCompaction => kept({ at: NOW - ago, summary: 'Summary of the work. Nothing about the plan.' })
  const keeperRows = (compactions: DigestCompaction[]): string[] => items(go({}, { compactions, limit: 10 }).watch)

  test('D11 the marker KEEPER 364266d5 open 3 of 7 with matching counts reads "last compaction kept the plan: yes", tagged keeper with its age', () => {
    expect(keeperMarker(SESSION, 3, 7)).toBe('KEEPER 364266d5 open 3 of 7')
    const list = keeperRows([kept()])
    expect(list).toHaveLength(1)
    expect(list[0]).toContain('last compaction kept the plan: yes')
    expect(list[0]).toMatch(/\[keeper\] 10m$/)
  })

  test('D11 no marker in the summary reads no: the keeper did not run', () => {
    expect(keeperRows([lost(10 * MIN)])[0]).toContain('last compaction kept the plan: no')
  })

  test('D11 a marker with other counts, or from another session, reads no', () => {
    expect(keeperRows([kept({ summary: keeperMarker(SESSION, 1, 7) })])[0]).toContain('kept the plan: no')
    expect(keeperRows([kept({ summary: keeperMarker('99999999-0000-4000-8000-000000000000', 3, 7) })])[0]).toContain('kept the plan: no')
  })

  test('D11 no compaction, or one where the keeper had nothing to add, draws no keeper line', () => {
    expect(keeperRows([]).join('\n')).not.toMatch(/compaction/)
    expect(keeperRows([lost(10 * MIN)].map(one => ({ ...one, open: null, total: null }) as unknown as DigestCompaction)).join('\n')).not.toMatch(/compaction/)
  })

  test('D11 the newest compaction sets the line, whatever the input order', () => {
    const list = keeperRows([lost(3 * HOUR), kept({ at: NOW - 5 * MIN }), lost(2 * HOUR)])
    expect(list.find(one => one.includes('last compaction kept the plan'))).toContain('plan: yes')
  })

  test('D11 kill rule: 3 of the last 5 compactions lost the plan says so and names removing the keeper; 2 of 5 does not', () => {
    const threeLost = [kept({ at: NOW - 5 * MIN }), lost(HOUR), kept({ at: NOW - 2 * HOUR }), lost(3 * HOUR), lost(4 * HOUR)]
    const list = keeperRows(threeLost)
    expect(list.find(one => /3 of the last 5/.test(one))).toMatch(/remove/i)
    expect(list.find(one => one.includes('last compaction kept the plan'))).toContain('plan: yes')
    const twoLost = [kept({ at: NOW - 5 * MIN }), lost(HOUR), kept({ at: NOW - 2 * HOUR }), kept({ at: NOW - 3 * HOUR }), lost(4 * HOUR)]
    expect(keeperRows(twoLost).join('\n')).not.toMatch(/of the last 5/)
  })

  test('D11 only the newest 5 compactions count for the kill rule', () => {
    const recent = [kept({ at: NOW - 1 * MIN }), kept({ at: NOW - 2 * MIN }), kept({ at: NOW - 3 * MIN }), lost(4 * MIN), lost(5 * MIN)]
    const older = [lost(6 * HOUR), lost(7 * HOUR), lost(8 * HOUR)]
    expect(keeperRows([...recent, ...older]).join('\n')).not.toMatch(/of the last 5/)
  })
})

describe('digest derived facts', () => {
  test('D12 a derived decision or proof carries "derived" in its tag; the same fact without the mark does not', () => {
    const handoff = decision('follow_up_order: 1 rawProject, 2 hud + band', 'handoff', 2 * HOUR, { derived: true })
    const seen = proofOk('stop the path leak', 30 * MIN, { result: undefined, derived: true, artifact: 'e2e/2026-10-28-fu1-rawproject-green.txt' })
    const marked = items(go({ decisions: [handoff], proofs: [seen] }, { limit: 10 }).highlights)
    expect(marked).toHaveLength(2)
    for (const one of marked) expect(one).toMatch(/\[derived [a-z]+\] (?:now|\d+[mhd])$/)
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
    lanes: [{ id: 'lane-x', title: `lane ${SECRET}`, state: 'active', mine: false, holder: `peer ${SECRET}`, note: `note ${SECRET}` }],
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

  test('D15 a multi-line or control-character text draws one line', () => {
    const found = go({ asks: [ask('first line\nsecond line\r\nthird\u0007 bell\ttab', MIN, { recommend: 'yes\nno' })] })
    const row = found.needs.rows[0]!
    expect(rowText(row)).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f]/)
    expect(found.needs.rows).toHaveLength(1)
    expect(rowText(row)).toContain('first line')
  })

  test('D16 5,000 character texts stay inside every row; 2,000 items stay inside the cap and finish in 500 ms', () => {
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
    lanes: [{ id: 'sdlc-os', title: 'SDLC OS', state: 'active', mine: false, holder: 'session 9f2c', at: NOW - HOUR }],
  })

  test('D17 no row is wider than the pane from 20 to 200 columns, and every item row still ends with its tag and age', () => {
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 1 : 7) {
      const found = go(full(), { columns, limit: 10, commits: [commit('test(pr-loop): RED for quiet alerts so READY stops waking the model', MIN)] })
      for (const block of [found.needs, found.highlights, found.watch]) {
        expect(rowWidth(block.head), `${columns} head`).toBeLessThanOrEqual(columns)
        for (const row of block.rows) expect(rowWidth(row), `${columns}: ${rowText(row)}`).toBeLessThanOrEqual(columns)
        for (const text of items(block)) expect(text, `${columns}`).toMatch(ITEM_END)
      }
    }
  })

  test('D18 no raw code, null or undefined reaches a row', () => {
    const found = go(full(), { limit: 10, commits: [commit('fix: scrub', MIN)] })
    expect(dump(found)).not.toMatch(/\b(?:LIMITED|REVIEWED|STALLED|PENDING|whenReady)\b|\bnull\b|undefined|\[object/)
  })
})
