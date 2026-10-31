import { describe, expect, test } from 'claude-code/testing'

import { capRuns } from '../hooks/agent-ledger/model'
import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import { swarmTab } from '../hooks/agentic-os/swarm-tab'
import { workflowProgress } from '../hooks/agentic-os/workflow-model'
import type { WorkflowFeed } from '../hooks/agentic-os/workflow-model'
import type { AgentRun } from '../types'

// /os Swarm tab (Dave, 2026-10-30; design .claudedocs/2026-10-30-swarm-tab-design.md): hooks/agentic-os/swarm-tab.ts, key 7.
//   swarmTab(s: TabState, now: number, columns: number, rows: number): PaneRow[]
//
// Contract these tests pin (the design left these holes; the choices are mine and the implementer must follow them or change the test):
//   - Rows, in order: the header `sw-h` (SWARM, tone head; right: `N running · M done · K failed`, dim, `failed` only above 0, none when empty);
//     then one section per workflow run (its run row `sw-wf-<i>`, then its agents `sw-wf-<i>-a<j>`), then HELPERS (`sw-h-helpers`) with the
//     runs that have no workflowRunId (`sw-hp-<j>`). No runs: the header and `sw-none` ("no helpers yet this session", dim). Keys come from
//     list positions, never from text, so a secret in a run id cannot reach a key.
//   - Workflows: one with a running agent first, then newest first (swarmGroups). Agents: running (oldest start first), failed, done.
//   - Run row: "  <mark> <swarmRunSentence>" and the elapsed time of the run on the right. Agent row: "    <mark> <purpose>", the tier badge and the
//     elapsed time on the right. Marks: "● " active running, "✓ " done, "✗ " bad failed; an unknown status "· " dim. The run mark is ●, else ✗, else ✓.
//   - A finished workflow without a failure draws its run row only. With a failure it also draws the failed agent rows (not the done ones).
//   - Right group by width: badge and elapsed from 60 columns, elapsed only from 24 to 59, none under 24. A model not known yet draws a dim "…".
//   - Fit, in order: all rows; the done agents of each section fold into one "✓ N done" row (`sw-wf-<i>-done`, `sw-hp-done`); then "+N more"
//     (`more-swarm`). The header is never cut. A cut text ends with a bare ellipsis: Swarm is the home tab, so it names no other tab.
//   - Feed (optional `feed.workflows`, one WorkflowFeed per runId): name and phase of the run row, a label per agent id. Phase = the highest
//     `agentPhases` value of its running agents, else the highest seen, else `feed.phase`; its title and total come from `feed.phase` and the
//     title only when it is the same phase. No feed: no phase, and the name reads "a workflow". A feed alone never makes a row.
//
// Ways the Swarm tab can fail, one test each:
// SW1  no runs draw no header line, no empty line, or draw a count on the header
// SW2  100 or 2,000 runs draw more rows than the budget, no "+N more", or take 500 ms or more
// SW3  a cut hides a running agent before a done one, folds running rows, or the fold row counts wrongly; the header is cut
// SW4  a plain helper is counted in a workflow, or is not under HELPERS; a mark or tone is wrong
// SW5  a 5,000-character input makes a row wrap, run past the pane (20 to 200 columns), or end without an ellipsis
// SW6  a secret in any string source (description, type, run id, workflow id, feed name, label, phase title) reaches a row or a key, whole or cut
// SW7  the header counts or a run row disagree with workflowProgress
// SW8  a 40-minute running agent does not read 40:00
// SW9  61 finished runs show a total, or more than the 50 the ledger keeps
// SW10 two agents with one description share a key or one of them is not drawn
// SW11 two rows share a key at 6, 10, 20 or 200 rows and 20, 40 or 80 columns
// SW12 the right group breaks its width rule (badge from 60, elapsed only from 24 to 59, none under 24)
// SW13 a model not known yet draws no dim "…"
// SW14 tier drift does not turn the badge bad
// SW15 an unknown status, a null field or a NaN time prints undefined, null or NaN, or throws
// SW16 the same state and clock give other rows, or a frozen input throws
// SW17 the run row does not read counts, then phase, then name; a narrow cut loses the counts before the name; the phase rule is wrong
// SW18 a finished workflow without a failure draws agent rows, or one with a failure hides the failed rows
// F14  a feed with no matching run makes a row
// F15  a feed label replaces the purpose of an agent that is not the one it names
// O28  is in os-tabs-model.test.ts: tabRows dispatches 'swarm'

const NOW = 100 * 3600_000
const MIN = 60_000
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const OPUS = 'claude-opus-4-1'
const SONNET = 'claude-sonnet-4-5'
const HAIKU = 'claude-haiku-4-5'

const empty = (over: Partial<TabState> = {}): TabState => ({
  view: { tasks: [], plan: null, turn: null, step: null, ctx: null, agents: [], lanes: null, prs: [] },
  chip: 'idle',
  brief: null,
  repo: null,
  branch: null,
  worktree: null,
  costUsd: null,
  activeAt: null,
  ...over,
})

const run = (id: string, status: AgentRun['status'], startedAgo: number, over: Partial<AgentRun> = {}): AgentRun => ({
  id,
  type: 'scout',
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

/** A run of a workflow. */
const wf = (workflow: string, id: string, status: AgentRun['status'], startedAgo: number, over: Partial<AgentRun> = {}): AgentRun =>
  run(id, status, startedAgo, { workflowRunId: workflow, ...over })

const feedOf = (over: Partial<WorkflowFeed> = {}): WorkflowFeed => ({
  runId: 'wf_a',
  name: 'pane-fleet-assess',
  phase: { index: 2, total: 2, title: 'Judge' },
  labels: {},
  agentPhases: {},
  ...over,
})

const withRuns = (agentRuns: AgentRun[], workflows?: WorkflowFeed[]): TabState =>
  empty({ agentRuns, ...(workflows === undefined ? {} : { feed: { workflows } }) })

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
const lines = (rows: PaneRow[]): string[] => rows.map(rowText)
const all = (rows: PaneRow[]): string => lines(rows).join('\n')
const byKey = (rows: PaneRow[], key: string): PaneRow | undefined => rows.find(one => one.key === key)
const swarm = (s: TabState, columns = 100, rows = 40): PaneRow[] => swarmTab(s, NOW, columns, rows)
const viaTab = (s: TabState, columns: number, rows: number): PaneRow[] => tabRows('swarm', s, NOW, columns, rows)
const rightOf = (row: PaneRow | undefined): string => (row?.right ?? []).map(one => one.text).join('')

/** Two workflows and three plain helpers, as in the design mockup: wf_a runs a Judge after four maps, wf_b is finished. */
const mockup = (): AgentRun[] => [
  wf('wf_a', 'a-judge', 'running', 4 * MIN, { description: 'judge the four maps', model: OPUS, effort: 'high' }),
  wf('wf_a', 'a-1', 'done', 12 * MIN, { description: 'map the hooks folder', model: SONNET, effort: 'high' }),
  wf('wf_a', 'a-2', 'done', 11 * MIN, { description: 'map the tests', model: SONNET, effort: 'high' }),
  wf('wf_a', 'a-3', 'done', 10 * MIN, { description: 'map the web reader', model: SONNET, effort: 'high' }),
  wf('wf_a', 'a-4', 'done', 9 * MIN, { description: 'map the lane board', model: SONNET, effort: 'high' }),
  wf('wf_b', 'b-1', 'done', 30 * MIN),
  wf('wf_b', 'b-2', 'done', 29 * MIN),
  wf('wf_b', 'b-3', 'done', 28 * MIN),
  run('h-run', 'running', 80_000, { description: 'scout the swarm data', model: SONNET, effort: 'high' }),
  run('h-bad', 'failed', 20 * MIN, { description: 'build the tab', model: SONNET, effort: 'high' }),
  run('h-ok', 'done', 15 * MIN, { description: 'review the plan', model: OPUS, effort: 'high' }),
]

describe('swarm tab: the rows', () => {
  test('SW1 no runs draw the header, then one dim line; the header has no counts', () => {
    const rows = swarm(empty())
    expect(rows.map(one => one.key)).toEqual(['sw-h', 'sw-none'])
    expect(rows[0]?.left[0]).toEqual({ text: 'SWARM', tone: 'head' })
    expect(rows[0]?.right).toBeUndefined()
    expect(rowText(rows[1]!)).toBe('  no helpers yet this session')
    expect(rows[1]?.left.every(one => one.tone === 'dim')).toBe(true)
    expect(all(swarm(empty({ agentRuns: [] })))).toBe(all(rows))
  })

  test('SW4 the mockup: header counts, the workflows first with their agents, then HELPERS with the plain helpers', () => {
    const rows = swarm(withRuns(mockup()), 100, 40)
    expect(rows.map(one => one.key)).toEqual([
      'sw-h',
      'sw-wf-0', 'sw-wf-0-a0', 'sw-wf-0-a1', 'sw-wf-0-a2', 'sw-wf-0-a3', 'sw-wf-0-a4',
      'sw-wf-1',
      'sw-h-helpers', 'sw-hp-0', 'sw-hp-1', 'sw-hp-2',
    ])
    expect(rowText(rows[0]!)).toBe('SWARM 2 running · 8 done · 1 failed')
    expect(rows[0]?.right?.every(one => one.tone === 'dim')).toBe(true)
    expect(rowText(byKey(rows, 'sw-wf-0')!)).toMatch(/^ {2}● 1 running, 4 done · a workflow /)
    expect(rowText(byKey(rows, 'sw-wf-1')!)).toMatch(/^ {2}✓ 3 done · a workflow /)
    expect(rowText(byKey(rows, 'sw-wf-0-a0')!)).toMatch(/^ {4}● judge the four maps Opus · high {2}4:00$/)
    expect(rowText(byKey(rows, 'sw-wf-0-a1')!)).toMatch(/^ {4}✓ map the lane board Sonnet · high {2}5:00$/)
    expect(rowText(byKey(rows, 'sw-hp-0')!)).toMatch(/^ {4}● scout the swarm data /)
    expect(rowText(byKey(rows, 'sw-hp-1')!)).toMatch(/^ {4}✗ build the tab /)
    expect(rowText(byKey(rows, 'sw-hp-2')!)).toMatch(/^ {4}✓ review the plan /)
    expect(rowText(byKey(rows, 'sw-h-helpers')!)).toBe('HELPERS')
    expect(byKey(rows, 'sw-h-helpers')?.left[0]?.tone).toBe('head')
  })

  test('SW4 marks and tones: running active, done done, failed bad; the run mark is running, else failed, else done', () => {
    const rows = swarm(withRuns([...mockup(), wf('wf_c', 'c-1', 'failed', 5 * MIN), wf('wf_c', 'c-2', 'done', 6 * MIN)]), 100, 40)
    const mark = (key: string): { text: string; tone: string } | undefined => byKey(rows, key)?.left.find(one => /[●✓✗·] $/.test(one.text))
    expect(mark('sw-wf-0-a0')).toEqual({ text: '● ', tone: 'active' })
    expect(mark('sw-wf-0-a1')).toEqual({ text: '✓ ', tone: 'done' })
    expect(mark('sw-hp-1')).toEqual({ text: '✗ ', tone: 'bad' })
    expect(mark('sw-wf-0')).toEqual({ text: '● ', tone: 'active' })
    const failed = rows.find(one => /1 done, 1 failed/.test(rowText(one)))
    expect(failed?.left.find(one => /[●✓✗] $/.test(one.text))).toEqual({ text: '✗ ', tone: 'bad' })
    expect(rows.filter(one => /^ {2}✓ 3 done/.test(rowText(one)))).toHaveLength(1)
  })

  test('SW4 a plain helper is under HELPERS and is not counted in any workflow; a run with an empty workflow id is plain', () => {
    const rows = swarm(withRuns([wf('wf_a', 'a1', 'done', 9 * MIN), run('plain', 'running', MIN), run('blank', 'done', 3 * MIN, { workflowRunId: '' })]))
    const text = lines(rows)
    const head = text.findIndex(one => one === 'HELPERS')
    expect(head).toBeGreaterThan(0)
    expect(text.slice(0, head).join('\n')).not.toMatch(/job plain|job blank/)
    expect(text.slice(head + 1).join('\n')).toMatch(/job plain[\s\S]*job blank/)
    expect(byKey(rows, 'sw-wf-0')).toBeDefined()
    expect(rowText(byKey(rows, 'sw-wf-0')!)).toMatch(/^ {2}✓ 1 done · a workflow/)
    expect(rows.some(one => one.key === 'sw-wf-1')).toBe(false)
  })

  test('SW4 only plain helpers: no workflow rows, HELPERS follows the header', () => {
    const rows = swarm(withRuns([run('p1', 'running', MIN), run('p2', 'done', 4 * MIN)]))
    expect(rows.map(one => one.key)).toEqual(['sw-h', 'sw-h-helpers', 'sw-hp-0', 'sw-hp-1'])
  })

  test('SW8 a 40-minute running agent and its run read 40:00; elapsed grows with the clock', () => {
    const state = withRuns([wf('wf_a', 'a1', 'running', 40 * MIN), run('p1', 'running', 40 * MIN)])
    const rows = swarm(state, 100, 20)
    expect(rightOf(byKey(rows, 'sw-wf-0-a0'))).toBe('…  40:00')
    expect(rightOf(byKey(rows, 'sw-wf-0'))).toBe('40:00')
    expect(rightOf(byKey(rows, 'sw-hp-0'))).toBe('…  40:00')
    const later = swarmTab(state, NOW + MIN, 100, 20)
    expect(rightOf(byKey(later, 'sw-wf-0-a0'))).toBe('…  41:00')
    expect(rightOf(byKey(swarm(state, 40, 20), 'sw-wf-0-a0'))).toBe('40:00')
  })

  test('SW8 a finished run reads the time it took, not the time since it started', () => {
    const rows = swarm(withRuns([run('p1', 'done', 90 * MIN, { endedAt: NOW - 90 * MIN + 7 * MIN + 5000 })]))
    expect(rightOf(byKey(rows, 'sw-hp-0'))).toBe('…  7:05')
    const flow = swarm(withRuns([wf('wf_a', 'a1', 'failed', 90 * MIN, { endedAt: NOW - 80 * MIN }), wf('wf_a', 'a2', 'done', 85 * MIN, { endedAt: NOW - 82 * MIN })]))
    expect(rightOf(byKey(flow, 'sw-wf-0'))).toBe('10:00')
  })

  test('SW9 61 finished runs of one workflow: the ledger keeps 50, the tab reads 50 done and draws no total', () => {
    const many = Array.from({ length: 61 }, (_, i) => wf('wf_big', `r${i}`, 'done', (100 - i) * MIN))
    const rows = swarm(withRuns(capRuns(many)), 100, 60)
    const text = all(rows)
    expect(rowText(byKey(rows, 'sw-wf-0')!)).toMatch(/^ {2}✓ 50 done · a workflow/)
    expect(rowText(rows[0]!)).toBe('SWARM 0 running · 50 done')
    expect(text).not.toMatch(/\b61\b|\d+ of \d+/)
  })

  test('SW10 two agents with one placeholder description keep two rows and two keys', () => {
    const rows = swarm(withRuns([wf('wf_a', 'x1', 'running', 3 * MIN, { description: 'general-purpose task' }), wf('wf_a', 'x2', 'running', 2 * MIN, { description: 'general-purpose task' })]))
    const agents = rows.filter(one => /general-purpose task/.test(rowText(one)))
    expect(agents).toHaveLength(2)
    expect(new Set(agents.map(one => one.key)).size).toBe(2)
    expect(new Set(rows.map(one => one.key)).size).toBe(rows.length)
  })

  test('SW13 a model that is not known yet draws a dim ellipsis as the badge, from 60 columns', () => {
    const rows = swarm(withRuns([run('p1', 'running', MIN, { model: null })]), 80, 20)
    expect(byKey(rows, 'sw-hp-0')?.right?.[0]).toEqual({ text: '…', tone: 'dim' })
  })

  test('SW14 tier drift turns the badge bad; a Haiku run is bad; a run on spec keeps its tier tone', () => {
    const rows = swarm(
      withRuns([
        run('drift', 'running', 4 * MIN, { model: SONNET, effort: 'high', drift: 'expected Opus · high' }),
        run('haiku', 'running', 3 * MIN, { model: HAIKU, effort: 'high', drift: 'Haiku is banned' }),
        run('fine', 'running', 2 * MIN, { model: OPUS, effort: 'high' }),
        run('sonnet', 'running', MIN, { model: SONNET, effort: 'high' }),
      ]),
      100,
      20,
    )
    const tone = (key: string): string | undefined => byKey(rows, key)?.right?.[0]?.tone
    expect(tone('sw-hp-0')).toBe('bad')
    expect(tone('sw-hp-1')).toBe('bad')
    expect(tone('sw-hp-2')).toBe('active')
    expect(tone('sw-hp-3')).toBe('sonnetTier')
    expect(rightOf(byKey(rows, 'sw-hp-0'))).toMatch(/^Sonnet · high {2}4:00$/)
  })
})

describe('swarm tab: the right group', () => {
  const state = (): TabState => withRuns([wf('wf_a', 'a1', 'running', 4 * MIN, { model: OPUS, effort: 'high' })])

  test('SW12 the badge and the elapsed time from 60 columns, only the elapsed time from 24 to 59, nothing under 24', () => {
    const agent = (columns: number): string => rightOf(byKey(swarm(state(), columns, 20), 'sw-wf-0-a0'))
    expect(agent(200)).toBe('Opus · high  4:00')
    expect(agent(60)).toBe('Opus · high  4:00')
    expect(agent(59)).toBe('4:00')
    expect(agent(24)).toBe('4:00')
    expect(agent(23)).toBe('')
    expect(agent(20)).toBe('')
    const run = (columns: number): string => rightOf(byKey(swarm(state(), columns, 20), 'sw-wf-0'))
    expect(run(200)).toBe('4:00')
    expect(run(60)).toBe('4:00')
    expect(run(24)).toBe('4:00')
    expect(run(23)).toBe('')
  })

  test('SW12 the header counts stay on the right at 40 columns and go under 24, and the right group never passes half the pane', () => {
    const rows = swarm(withRuns(mockup()), 40, 20)
    expect(rows[0]?.right).toBeDefined()
    expect(rowWidth(rows[0]!)).toBeLessThanOrEqual(40)
    expect(swarm(withRuns(mockup()), 23, 20)[0]?.right).toBeUndefined()
    for (const row of rows) expect((row.right ?? []).reduce((n, one) => n + one.text.length, 0)).toBeLessThanOrEqual(20)
  })
})

describe('swarm tab: the run row and the feed', () => {
  test('SW7 the header counts and every run row equal workflowProgress, plus the plain helpers', () => {
    const runs = mockup()
    const rows = swarm(withRuns(runs), 120, 40)
    const sum = workflowProgress(runs).reduce((n, one) => ({ running: n.running + one.running, done: n.done + one.done, failed: n.failed + one.failed }), { running: 0, done: 0, failed: 0 })
    const plain = runs.filter(one => one.workflowRunId === undefined)
    const count = (status: AgentRun['status']): number => sum[status] + plain.filter(one => one.status === status).length
    const want = `${count('running')} running · ${count('done')} done${count('failed') > 0 ? ` · ${count('failed')} failed` : ''}`
    expect(rowText(rows[0]!)).toBe(`SWARM ${want}`)
    const first = workflowProgress(runs).find(one => one.key === 'wf_a')!
    expect(rowText(byKey(rows, 'sw-wf-0')!)).toContain(`${first.running} running, ${first.done} done`)
  })

  test('SW7 the failed part of the header appears only above 0', () => {
    expect(rowText(swarm(withRuns([run('p', 'running', MIN)]))[0]!)).toBe('SWARM 1 running · 0 done')
    expect(rowText(swarm(withRuns([run('p', 'failed', MIN)]))[0]!)).toBe('SWARM 0 running · 0 done · 1 failed')
  })

  test('SW17 with a feed the run row reads counts, then phase, then name; without one it reads a workflow', () => {
    const fed = swarm(withRuns(mockup(), [feedOf()]), 120, 40)
    expect(rowText(byKey(fed, 'sw-wf-0')!)).toMatch(/^ {2}● 1 running, 4 done · phase 2 of 2: Judge · pane-fleet-assess /)
    expect(rowText(byKey(fed, 'sw-wf-1')!)).toMatch(/^ {2}✓ 3 done · a workflow /)
    const bare = swarm(withRuns(mockup()), 120, 40)
    expect(rowText(byKey(bare, 'sw-wf-0')!)).toMatch(/^ {2}● 1 running, 4 done · a workflow /)
    expect(all(bare)).not.toMatch(/phase|pane-fleet-assess/)
  })

  test('SW17 a narrow cut loses the name first: at 40 columns the counts are there and the name is not', () => {
    const row = byKey(swarm(withRuns(mockup(), [feedOf()]), 40, 40), 'sw-wf-0')!
    const text = rowText(row)
    expect(text).toMatch(/^ {2}● 1 running, 4 done · /)
    expect(text).not.toContain('pane-fleet-assess')
    expect(row.left.map(one => one.text).join('')).toMatch(/…$/)
    expect(rowWidth(row)).toBeLessThanOrEqual(40)
  })

  test('SW17 the phase is the highest phase of a running agent (the ledger decides), else the highest seen, else the feed phase', () => {
    const runs = [wf('wf_a', 'r1', 'running', 3 * MIN), wf('wf_a', 'd1', 'done', 9 * MIN), wf('wf_a', 'd2', 'done', 8 * MIN)]
    const row = (feed: WorkflowFeed, list: AgentRun[] = runs): string => rowText(byKey(swarm(withRuns(list, [feed]), 140, 20), 'sw-wf-0')!)
    // The journal still says phase 1 of 3 (Map), but the running agent is in phase 2: the ledger wins, and phase 2 has no title here.
    expect(row(feedOf({ phase: { index: 1, total: 3, title: 'Map' }, agentPhases: { r1: 2, d1: 1, d2: 1 } }))).toContain('phase 2 of 3 · pane-fleet-assess')
    // The feed phase and the running agent agree: the title shows.
    expect(row(feedOf({ phase: { index: 2, total: 3, title: 'Judge' }, agentPhases: { r1: 2, d1: 1 } }))).toContain('phase 2 of 3: Judge · pane-fleet-assess')
    // A done helper is further along than the one still running: the running one decides.
    expect(row(feedOf({ phase: { index: 2, total: 3, title: 'Judge' }, agentPhases: { r1: 1, d1: 2 } }))).toContain('phase 1 of 3 · pane-fleet-assess')
    // Nothing runs: the highest phase seen.
    const done = [wf('wf_a', 'd1', 'done', 9 * MIN), wf('wf_a', 'd2', 'done', 8 * MIN)]
    expect(row(feedOf({ phase: { index: 1, total: 3, title: 'Map' }, agentPhases: { d1: 1, d2: 3 } }), done)).toContain('phase 3 of 3 · pane-fleet-assess')
    // No agent phase at all: the feed phase, title included.
    expect(row(feedOf({ phase: { index: 1, total: 3, title: 'Map' }, agentPhases: {} }))).toContain('phase 1 of 3: Map · pane-fleet-assess')
    // No phase anywhere: no phase words.
    expect(row(feedOf({ phase: null, agentPhases: {} }))).not.toContain('phase')
    // A phase value that is not a number is ignored.
    expect(row(feedOf({ phase: null, agentPhases: { r1: Number.NaN, d1: undefined as never } }))).not.toMatch(/phase|NaN/)
  })

  test('F14 a feed whose runId matches no run makes no row; a feed with no runs at all draws the empty line', () => {
    const one = [run('p1', 'running', MIN)]
    expect(all(swarm(withRuns(one, [feedOf({ runId: 'wf_nobody' })])))).toBe(all(swarm(withRuns(one))))
    expect(swarm(withRuns([], [feedOf()])).map(row => row.key)).toEqual(['sw-h', 'sw-none'])
    expect(swarm(withRuns(mockup(), [feedOf({ runId: 'wf_gone' })])).map(row => row.key)).toEqual(swarm(withRuns(mockup())).map(row => row.key))
  })

  test('F15 a feed label replaces the purpose of the agent it names and of no other, and only inside its own workflow', () => {
    const runs = [
      wf('wf_a', 'r1', 'running', 3 * MIN, { description: 'general-purpose task' }),
      wf('wf_a', 'r2', 'running', 2 * MIN, { description: 'general-purpose task' }),
      wf('wf_b', 'r3', 'running', MIN, { description: 'other workflow task' }),
      run('r4', 'running', MIN, { description: 'plain helper task' }),
    ]
    const rows = swarm(withRuns(runs, [feedOf({ labels: { r1: 'Judge the four maps', r3: 'wrong workflow label', r4: 'plain label' } })]), 140, 30)
    const text = all(rows)
    expect(text).toContain('Judge the four maps')
    expect(text).toMatch(/general-purpose task/)
    expect(text.match(/general-purpose task/g)).toHaveLength(1)
    expect(text).toContain('other workflow task')
    expect(text).not.toContain('wrong workflow label')
    expect(text).toContain('plain helper task')
    expect(text).not.toContain('plain label')
  })

  test('F15 an empty label, or a label that only the prototype holds, falls back to the purpose', () => {
    const rows = swarm(withRuns([wf('wf_a', 'toString', 'running', MIN, { description: 'real purpose' })], [feedOf({ labels: { toString: '   ' } })]), 100, 20)
    expect(all(rows)).toContain('real purpose')
    const inherited: Record<string, string> = Object.create({ r1: 'inherited label' }) as Record<string, string>
    const proto = swarm(withRuns([wf('wf_a', 'r1', 'running', MIN, { description: 'real purpose' })], [feedOf({ labels: inherited })]), 100, 20)
    expect(all(proto)).toContain('real purpose')
    expect(all(proto)).not.toContain('inherited label')
  })

  test('SW10 with a feed, two agents of one placeholder description read their own labels', () => {
    const runs = [wf('wf_a', 'x1', 'running', 3 * MIN, { description: 'general-purpose task' }), wf('wf_a', 'x2', 'running', 2 * MIN, { description: 'general-purpose task' })]
    const text = all(swarm(withRuns(runs, [feedOf({ labels: { x1: 'map the hooks', x2: 'map the tests' } })])))
    expect(text).toContain('map the hooks')
    expect(text).toContain('map the tests')
    expect(text).not.toContain('general-purpose task')
  })
})

describe('swarm tab: finished workflows', () => {
  test('SW18 a finished workflow without a failure draws its run row only', () => {
    const rows = swarm(withRuns([wf('wf_b', 'b1', 'done', 30 * MIN), wf('wf_b', 'b2', 'done', 29 * MIN), run('p1', 'running', MIN)]))
    expect(rows.map(one => one.key)).toEqual(['sw-h', 'sw-wf-0', 'sw-h-helpers', 'sw-hp-0'])
    expect(all(rows)).not.toContain('job b1')
  })

  test('SW18 with a failure it also draws the failed agent rows, and not the done ones', () => {
    const rows = swarm(withRuns([wf('wf_b', 'b1', 'done', 30 * MIN), wf('wf_b', 'b2', 'failed', 29 * MIN), wf('wf_b', 'b3', 'failed', 28 * MIN)]))
    expect(rows.map(one => one.key)).toEqual(['sw-h', 'sw-wf-0', 'sw-wf-0-a0', 'sw-wf-0-a1'])
    expect(rowText(rows[1]!)).toMatch(/^ {2}✗ 1 done, 2 failed · a workflow/)
    expect(all(rows)).toContain('job b2')
    expect(all(rows)).toContain('job b3')
    expect(all(rows)).not.toContain('job b1')
  })

  test('SW18 a workflow that still runs draws all its agents, the done ones too', () => {
    const rows = swarm(withRuns([wf('wf_a', 'a1', 'done', 30 * MIN), wf('wf_a', 'a2', 'running', 29 * MIN)]))
    expect(rows.map(one => one.key)).toEqual(['sw-h', 'sw-wf-0', 'sw-wf-0-a0', 'sw-wf-0-a1'])
    expect(all(rows)).toContain('job a1')
  })

  test('SW3 the agents of a section read running (oldest first), then failed, then done (newest end first)', () => {
    const rows = swarm(
      withRuns([
        wf('wf_a', 'd-old', 'done', 40 * MIN),
        wf('wf_a', 'd-new', 'done', 12 * MIN),
        wf('wf_a', 'f1', 'failed', 20 * MIN),
        wf('wf_a', 'r-late', 'running', 2 * MIN),
        wf('wf_a', 'r-early', 'running', 6 * MIN),
      ]),
    )
    const order = lines(rows).map(one => /job (\S+)/.exec(one)?.[1]).filter(Boolean)
    expect(order).toEqual(['r-early', 'r-late', 'f1', 'd-new', 'd-old'])
  })

  test('SW3 a workflow with a running agent is above a finished one that ended later', () => {
    const rows = swarm(withRuns([wf('wf_done', 'd1', 'done', 10 * MIN), wf('wf_live', 'l1', 'running', 50 * MIN)]))
    expect(rowText(byKey(rows, 'sw-wf-0')!)).toMatch(/^ {2}● 1 running/)
    expect(rowText(byKey(rows, 'sw-wf-1')!)).toMatch(/^ {2}✓ 1 done/)
  })
})

describe('swarm tab: the fit', () => {
  const crowded = (): AgentRun[] => [
    wf('wf_a', 'run-agent', 'running', 5 * MIN, { description: 'the running one' }),
    ...Array.from({ length: 10 }, (_, i) => wf('wf_a', `done-${i}`, 'done', (30 + i) * MIN, { description: `finished ${i}` })),
    wf('wf_b', 'b1', 'done', 60 * MIN),
    run('h-run', 'running', 2 * MIN, { description: 'a plain runner' }),
    ...Array.from({ length: 6 }, (_, i) => run(`h-done-${i}`, 'done', (20 + i) * MIN, { description: `plain finished ${i}` })),
  ]

  test('SW3 when the rows do not fit, the done agents of each section fold into one "✓ N done" row and the running rows stay', () => {
    const rows = swarm(withRuns(crowded()), 80, 12)
    const text = all(rows)
    expect(rows.length).toBeLessThanOrEqual(12)
    expect(text).toContain('the running one')
    expect(text).toContain('a plain runner')
    expect(text).not.toContain('finished 0')
    expect(rowText(byKey(rows, 'sw-wf-0-done')!)).toBe('    ✓ 10 done')
    expect(byKey(rows, 'sw-wf-0-done')?.left.some(one => one.tone === 'done')).toBe(true)
    expect(rowText(byKey(rows, 'sw-hp-done')!)).toBe('    ✓ 6 done')
    expect(byKey(rows, 'sw-wf-0-done')?.right).toBeUndefined()
    expect(rows.some(one => one.key === 'more-swarm')).toBe(false)
  })

  test('SW3 when everything fits there is no fold row; the fold row is not drawn for a section with no done agent', () => {
    const rows = swarm(withRuns(crowded()), 80, 60)
    expect(rows.some(one => /done$/.test(rowText(one)) && one.key.endsWith('done'))).toBe(false)
    expect(all(rows)).toContain('finished 0')
    const folded = swarm(withRuns([wf('wf_a', 'r1', 'running', MIN), wf('wf_a', 'r2', 'running', 2 * MIN), run('h1', 'running', MIN), run('h2', 'running', 2 * MIN)]), 80, 5)
    expect(folded.some(one => one.key.endsWith('-done'))).toBe(false)
  })

  test('SW3 a folded section keeps its failed agents; a cut after the fold ends with one "+N more" row and still shows the running agent', () => {
    const tight = swarm(withRuns([...crowded(), wf('wf_a', 'bad', 'failed', 7 * MIN, { description: 'the failed one' })]), 80, 5)
    expect(tight.length).toBeLessThanOrEqual(5)
    expect(tight[0]?.key).toBe('sw-h')
    expect(all(tight)).toContain('the running one')
    const last = tight[tight.length - 1]!
    expect(last.key).toBe('more-swarm')
    expect(rowText(last)).toMatch(/^ {2}\+\d+ more$/)
    const roomy = swarm(withRuns([...crowded(), wf('wf_a', 'bad', 'failed', 7 * MIN, { description: 'the failed one' })]), 80, 8)
    expect(all(roomy)).toContain('the failed one')
    expect(rowText(byKey(roomy, 'sw-wf-0-done')!)).toBe('    ✓ 10 done')
  })

  test('SW3 the header is never cut, at any budget from 1 up', () => {
    for (let rows = 1; rows <= 14; rows++) {
      const got = swarm(withRuns(crowded()), 60, rows)
      expect(got.length, `rows ${rows}`).toBeLessThanOrEqual(rows)
      expect(got[0]?.key, `rows ${rows}`).toBe('sw-h')
    }
    expect(swarm(withRuns(crowded()), 60, 0)).toEqual([])
    expect(swarm(empty(), 60, 1).map(one => one.key)).toEqual(['sw-h'])
  })

  test('SW3 a pane of 3 rows keeps the header, one item and a "+N more" row; HELPERS is left out so the item shows', () => {
    const helpersOnly = swarm(withRuns([run('p1', 'running', MIN), run('p2', 'running', 2 * MIN), run('p3', 'done', 4 * MIN)]), 80, 3)
    expect(helpersOnly.map(one => one.key)).toEqual(['sw-h', 'sw-hp-0', 'more-swarm'])
    expect(rowText(helpersOnly[2]!)).toBe('  +2 more')
    // The fold row stands for the done helper, so nothing is cut silently and no "+N more" is needed.
    expect(swarm(withRuns([run('p1', 'running', MIN), run('p2', 'done', 4 * MIN)]), 80, 3).map(one => one.key)).toEqual(['sw-h', 'sw-hp-0', 'sw-hp-done'])
    const flows = swarm(withRuns(crowded()), 80, 3)
    expect(flows.map(one => one.key)).toEqual(['sw-h', 'sw-wf-0', 'more-swarm'])
    expect(swarm(withRuns([run('p1', 'running', MIN)]), 80, 3).map(one => one.key)).toEqual(['sw-h', 'sw-h-helpers', 'sw-hp-0'])
  })

  test('SW2 100 runs and 2,000 runs stay inside the budget, end with "+N more" and take under 500 ms', () => {
    for (const total of [100, 2000]) {
      const runs = Array.from({ length: total }, (_, i) =>
        i % 3 === 0 ? run(`p${i}`, i % 7 === 0 ? 'running' : 'done', (i + 1) * 1000) : wf(`wf_${i % 40}`, `a${i}`, i % 11 === 0 ? 'running' : i % 13 === 0 ? 'failed' : 'done', (i + 1) * 1000),
      )
      for (const rows of [6, 20]) {
        const started = Date.now()
        const got = swarm(withRuns(runs), 80, rows)
        expect(Date.now() - started, `${total} runs`).toBeLessThan(500)
        expect(got.length).toBeLessThanOrEqual(rows)
        expect(got[0]?.key).toBe('sw-h')
        const last = got[got.length - 1]!
        expect(last.key).toBe('more-swarm')
        expect(Number(/\+(\d+) more/.exec(rowText(last))?.[1])).toBeGreaterThan(0)
      }
    }
  })
})

describe('swarm tab: width, safety and keys', () => {
  const WIDTHS = [20, 23, 24, 33, 40, 59, 60, 80, 110, 200]
  const huge = 'y'.repeat(5000)

  test('SW5 5,000-character inputs make one row each, never past the pane, and a cut text ends with an ellipsis', () => {
    const runs = [
      wf('wf_a', 'r1', 'running', 4 * MIN, { description: huge, type: huge }),
      wf('wf_a', 'r2', 'done', 9 * MIN, { description: '', type: huge }),
      run('p1', 'failed', 5 * MIN, { description: huge }),
    ]
    const feeds = [feedOf({ name: huge, phase: { index: 1, total: 2, title: huge }, labels: { r2: huge } })]
    for (const columns of WIDTHS) {
      const rows = swarm(withRuns(runs, feeds), columns, 40)
      expect(rows.map(one => one.key), `${columns}`).toEqual(['sw-h', 'sw-wf-0', 'sw-wf-0-a0', 'sw-wf-0-a1', 'sw-h-helpers', 'sw-hp-0'])
      for (const row of rows) expect(rowWidth(row), `${columns} ${row.key}`).toBeLessThanOrEqual(columns)
      for (const key of ['sw-wf-0', 'sw-wf-0-a0', 'sw-wf-0-a1', 'sw-hp-0']) {
        expect(byKey(rows, key)?.left.map(one => one.text).join(''), `${columns} ${key}`).toMatch(/…$/)
      }
      expect(all(rows)).not.toMatch(/y{500}/)
    }
  })

  test('SW5 a cut names no other tab: Swarm is the home, so the ellipsis is bare', () => {
    const rows = swarm(withRuns([run('p1', 'running', MIN, { description: huge })]), 60, 10)
    expect(all(rows)).not.toMatch(/more ->/)
    expect(rowText(byKey(rows, 'sw-hp-0')!)).toMatch(/…/)
  })

  test('SW6 a secret in any string source reaches no row and no key, whole or cut by the width', () => {
    const runs = [
      wf(`wf_${SECRET}`, SECRET, 'running', 4 * MIN, { description: `build ${SECRET}`, type: SECRET }),
      wf(`wf_${SECRET}`, `b-${SECRET}`, 'done', 9 * MIN, { description: '', type: `type ${SECRET}` }),
      wf(`wf_${SECRET}`, `c-${SECRET}`, 'failed', 8 * MIN, { description: SECRET }),
      run(`p-${SECRET}`, 'running', MIN, { description: SECRET, type: SECRET }),
      run(`q-${SECRET}`, 'done', 3 * MIN, { description: `x ${SECRET}`, model: `model ${SECRET}`, effort: SECRET }),
    ]
    const feed: WorkflowFeed = {
      runId: `wf_${SECRET}`,
      name: `flow ${SECRET}`,
      phase: { index: 1, total: 2, title: SECRET },
      labels: { [SECRET]: `label ${SECRET}`, [`b-${SECRET}`]: SECRET },
      agentPhases: { [SECRET]: 1 },
    }
    for (const columns of [...WIDTHS, 33, 47, 71]) {
      for (const rows of [4, 8, 40]) {
        const got = swarm(withRuns(runs, [feed]), columns, rows)
        const text = [...lines(got), ...got.map(one => one.key)].join('\n')
        expect(text, `${columns}x${rows}`).not.toContain('sk-ant')
        expect(text, `${columns}x${rows}`).not.toMatch(/a{12}/)
      }
    }
  })

  test('SW11 no two rows share a key at 6, 10, 20 and 200 rows and 20, 40 and 80 columns', () => {
    const runs = [
      ...mockup(),
      ...Array.from({ length: 30 }, (_, i) => wf(`wf_${i % 5}`, `x${i}`, (['running', 'done', 'failed'] as const)[i % 3]!, (i + 1) * MIN, { description: 'general-purpose task' })),
      ...Array.from({ length: 12 }, (_, i) => run(`h${i}`, (['running', 'done', 'failed'] as const)[i % 3]!, (i + 1) * MIN, { description: 'general-purpose task' })),
    ]
    for (const rows of [6, 10, 20, 200]) {
      for (const columns of [20, 40, 80]) {
        const keys = swarm(withRuns(runs, [feedOf({ labels: { x1: 'same', x2: 'same' } })]), columns, rows).map(one => one.key)
        expect(new Set(keys).size, `${rows}x${columns}`).toBe(keys.length)
      }
    }
  })

  test('SW15 an unknown status, null fields and a NaN time draw a plain row: no undefined, null or NaN, and no throw', () => {
    const odd = [
      run('odd', 'weird' as never, MIN, { description: null as never, type: undefined as never }),
      run('nan', 'running', MIN, { startedAt: Number.NaN, endedAt: Number.NaN, model: undefined as never, effort: Number.NaN as never }),
      wf('wf_a', 'w1', 'done', MIN, { description: undefined as never, startedAt: Number.POSITIVE_INFINITY }),
      wf('wf_a', 'w2', 'running', MIN, { endedAt: Number.NaN, drift: undefined as never }),
    ]
    let rows: PaneRow[] = []
    expect(() => {
      rows = swarm(withRuns(odd, [feedOf({ name: null, phase: { index: Number.NaN, total: Number.NaN, title: null }, labels: { w2: null as never }, agentPhases: { w2: Number.NaN } })]), 100, 40)
    }).not.toThrow()
    const text = [...lines(rows), ...rows.map(one => one.key)].join('\n')
    expect(text).not.toMatch(/undefined|null|NaN|Infinity|\[object/)
    const unknown = rows.find(one => one.left.some(span => span.text === '· '))
    expect(unknown?.left.find(span => span.text === '· ')?.tone).toBe('dim')
    expect(rowText(unknown!)).toContain('a task')
    for (const columns of WIDTHS) expect(() => swarm(withRuns(odd), columns, 10)).not.toThrow()
  })

  test('SW15 runs that are not an array, or a null agentRuns, draw the empty tab', () => {
    expect(swarm(empty({ agentRuns: undefined })).map(one => one.key)).toEqual(['sw-h', 'sw-none'])
    expect(swarm(empty({ agentRuns: null as never })).map(one => one.key)).toEqual(['sw-h', 'sw-none'])
  })

  test('SW16 the same state and clock give the same rows, and a deeply frozen state does not throw', () => {
    const state = withRuns(mockup(), [feedOf({ labels: { 'a-1': 'one' } })])
    for (const columns of [20, 40, 80]) expect(swarm(state, columns, 12)).toEqual(swarm(state, columns, 12))
    const freeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) freeze(inner)
      return Object.freeze(value)
    }
    const frozen = freeze(withRuns(mockup(), [feedOf({ labels: { 'a-1': 'one' } })]))
    for (const columns of [20, 80]) expect(() => swarm(frozen, columns, 12)).not.toThrow()
    expect(viaTab(frozen, 80, 12)).toEqual(swarm(frozen, 80, 12))
    const before = JSON.stringify(state)
    swarm(state, 80, 6)
    expect(JSON.stringify(state)).toBe(before)
  })
})
