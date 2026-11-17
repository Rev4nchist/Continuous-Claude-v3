import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, markAsksAnswered } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { drift } from '../hooks/agentic-os/steward'
import type { Drift } from '../hooks/agentic-os/steward'
import { TABS, isTabId, osPane, tabRows, tabStrip } from '../hooks/agentic-os/os-tabs-model'
// New exports (LATER) come through the namespace, so a missing one fails its own test and not the whole file.
import * as model from '../hooks/agentic-os/os-tabs-model'
import type { TabId, TabItem, TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import type { AgentRun, BoardLane, FileTouch, OsBrief, OsTask } from '../types'

// Ways the /os tabs (PRD 5.3) can fail, one test each. Every check reads the rows the model returns.
//
// /os redesign, round 2 (tests first). Contract these tests pin (the plan left these holes; the choices are mine and the implementer
// must follow them or change the test):
//   - TabId is overview | session | plan | work | proof | decisions, hotkeys 1 to 6, every TABS spec live (no `tag`, no disabled spec).
//     `LATER` is ['Comms', 'Swarm', 'Resources']. osPane returns { strip, body, footer }; footer is ONE dim row that reads
//     'later: Comms · Swarm · Resources', drawn only when the body keeps at least 3 rows. strip + body + footer never pass `rows`.
//   - TabState gains optional fields: board (BoardLane[] | null, the lane board), boardAt (epoch ms of the last good board read, for
//     "as of <age>" on the Work tab), files (FileTouch[]), compactions (KeeperRecord[]), cachePct, limits. `feed.lanes` and
//     `feed.compactions` are GONE (one input path per fact); `feed.commits` and `feed.prs` stay.
//   - Overview rows, in order: 'ov-chip' (chipWord, then repo and branch: line 1), 'ov-goal' (GOAL, a must row, `not set` in warn),
//     'now' (NOW line: an in-progress task's activeForm else subject; else 'Thinking' while a turn runs; else 'N helpers running'; never
//     the tool name or its label), then NEEDS YOU, DONE and WATCH (digest.ts), then the dim 'ov-health' row (ctx p%, $x, cache p%).
//     Gone from Overview: STOP AT, the repo / branch / worktree label rows, the plan bar, ASK and UNPROVEN counts, LANE, AGENTS, PRS.
//   - Short pane: the Overview first retries the briefing with lineCap 1 (one row per item) and only then folds the blocks to heads.
//   - digestOf feeds the peer lanes of `board` (not mine, live) with their overlap (laneOverlap of the scope and `files`) to the digest.
//     A lane of a stopped session is not "held by another session", so it stays out of WATCH.
//   - tabRows dispatches 'session' to sessionTab and 'work' to workTab (their own files: session-tab.test.ts, work-tab.test.ts).
//
// O1  a tab is missing, out of order, a later tab (Comms, Resources) is a strip item or has a tag, or the hotkeys are not 1 to 7 (Swarm is the seventh live tab, 2026-10-30)
// O2  Overview drops the chip word, repo, branch, GOAL, NOW, health, or still draws a removed row (STOP AT, label rows, counts, LANE, AGENTS, PRS)
// O3  Plan takes the wrong source (tasks first, else the brief plan), a wrong mark, or a done step without proven or UNPROVEN
// O4  Proof lists proofs before the done-but-unproven steps, or loses an artifact
// O5  Decisions are not newest first, lose by or age, or an ask loses its kind, recommend, answered? or stale mark
// O6  a row (or the footer) is wider than the pane at 20 or 200 columns, or a tab strip line is, on any of the six tabs
// O7  0 steps, 500 steps, 200 proofs or 50 decisions: no empty state, no "+N more", more rows than the budget, or slow
// O8  a secret in any brief string, task, agent, lane, board lane, file or step reaches a row or the footer, whole or cut by the width
// O9  an empty tab draws a blank body
// O10 the strip, the body and the footer together draw more rows than the budget
// O11 a short Overview (10 to 30 rows) drops the chip, GOAL or a briefing head, leaves no "+N more" for what it cut, or draws past the budget
// O12 the strip ignores the "1: " a live tab Button is drawn with, so a line is wider than the pane or the budgeted row count is wrong
// O13 two sibling rows share a key, on any tab
// O14 the open-ask count of Decisions counts an answered ask, or loses "answered?" (moved from Overview: the ASK count left it)
// O15 Decisions loses the stale mark on its open count, or draws it in the amber of a fresh ask (moved from Overview)
// O16 Overview loses "[parsed]" on GOAL, or draws it on a goal that brief_set wrote (STOP AT left Overview; its mark is tested on Session)
// O17 Proof lists several proofs oldest first
// O19 O20 NOW and the chip row of Overview read idle while a helper or workflow run is live (no turn, no step)
// O21 NOW names the tool or its label, or ignores a task's activeForm, or says Thinking while a task is in progress
// O22 the strip has the wrong number of lines at 20, 40, 58 and 72 columns (the 3-cell hotkey prefix is not counted)
// O23 the footer is missing, is not dim, steals a body row, or draws on a body of fewer than 3 rows
// O24 the same state and clock give different rows on any of the six tabs, or tabRows does not dispatch Session and Work
// O25 the Overview health row loses ctx, cost or cache, or draws NaN
// O27 a tab header keeps the old word (PLAN, PROOF, DECISIONS), or a tab id changes with its label
// O28 tabRows does not dispatch 'swarm' to the Swarm tab (swarm-tab.ts), or draws Overview, or a Swarm tab that the runs never reach
// O26 a peer lane that overlaps my files is not in WATCH as "may touch the same files"; my own lane or a stopped session's lane is
// B1-B12 the briefing (see the second block)
//
// Edits to the pre-redesign tests (each listed with the reason; none weakened):
//   O1/O6/O12 seven tabs -> six, no NEXT or LATER item, hotkeys 1 to 6: Dave's six-tab decision. O12 keeps its arithmetic.
//   O2   rewritten for the new Overview. The old "Bash npm test", "scout map hooks", "#194 READY", repo/branch/worktree label, PLAN bar,
//        ASK 2 and UNPROVEN 1 assertions flip to absence or move to the tab that holds them (Work, Session, Plan, Decisions).
//   O6/O8/O9/O10/O13 the tab list is six, the footer is counted, and Session and Work are added to every sweep.
//   O11  the Overview no longer lists AGENTS, PRS, LANE, STOP AT or worktree: the sweep keeps chip, GOAL, the heads, and the "+N more" rule.
//   O14  ASK n and "n answered?" left Overview: the same assertions read the open count of the Decisions tab.
//   O15  the same, for the stale mark and its tone.
//   O16  STOP AT left Overview: only GOAL [parsed] is tested here; STOP AT [parsed] moved to session-tab.test.ts.
//   O18  "brief stale: <reason>" -> driftSentence; the row has no [steward] tag, its age moved to the right group (so the "no right
//        group" assertion is dropped), and the text spans (not the mark) stay dim.
//   O19/O20 'WORKING'/'IDLE' -> 'Working'/'Idle' (chipWord); NOW reads "N helpers running".
//   B1-B12 HIGHLIGHTS -> DONE; "[source] age" item rows -> rows that start with their mark; B2 ask "recommend:" -> "I suggest:" row;
//        B3 proof artifact -> not drawn; B8 reason -> driftSentence; B11 feed.lanes -> board; the B1 "10 rows ends with more-overview"
//        rule now also accepts a briefing that fills the pane (the Overview's row arithmetic changed).

const NOW = 100 * 3600_000
const MIN = 60_000
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const TABS_LIVE: TabId[] = ['overview', 'session', 'plan', 'work', 'proof', 'decisions', 'swarm']
const LATER_FOOTER = 'later: Comms · Resources'

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

const task = (id: string, subject: string, status: OsTask['status'], activeForm?: string): OsTask => ({ id, subject, status, ...(activeForm ? { activeForm } : {}) })

const briefWith = (raw: Record<string, unknown>, tasks: OsTask[] = [], prev: Brief | null = null, at = NOW - 1000): Brief => {
  const made = applyBrief(prev, raw, tasks, at)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
const lines = (rows: PaneRow[]): string[] => rows.map(rowText)
const all = (rows: PaneRow[]): string => lines(rows).join('\n')
const itemText = (item: TabItem): string => item.spans.map(one => one.text).join('')
const keyed = (rows: PaneRow[], key: string): string => {
  const found = rows.find(one => one.key === key)
  return found === undefined ? '' : rowText(found)
}

const TASKS = [task('1', 'first step', 'completed'), task('2', 'second step', 'completed'), task('3', 'third step', 'in_progress'), task('4', 'fourth step', 'pending')]

/** Task 1 proven, task 2 done with no proof, task 3 running, task 4 waiting. */
const proven = (): Brief => briefWith({ proof: { taskId: '1', artifact: 'cache/e2e/one.txt' } }, TASKS)

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

const lane = (id: string, over: Partial<BoardLane> = {}): BoardLane => ({ id, title: `title of ${id}`, state: 'active', mine: false, owner: '9f2c0001', live: true, ...over })
const edited = (path: string): FileTouch => ({ path, state: 'edited', added: 3, removed: 1 })

const rich = (): TabState => {
  const brief = briefWith(
    {
      goal: 'prove the pane tabs',
      stopAt: 'tests green, no commit',
      ask: [
        { kind: 'approval', text: 'Create the roles?', recommend: 'yes, after review' },
        { kind: 'question', text: 'Which branch?' },
      ],
      decision: { text: 'Observer only, no deny.', by: 'Dave' },
    },
    TASKS,
    proven(),
  )
  return empty({
    chip: 'working',
    brief,
    repo: 'continuous-claude',
    branch: 'feat/sdlc-os-p1a3',
    worktree: 'wt-sdlc',
    costUsd: 1.84,
    activeAt: NOW - 1000,
    cachePct: 73,
    limits: [{ kind: 'five_hour', percentUsed: 62 }],
    files: [edited('hooks/agentic-os/digest.ts')],
    board: [lane('lane-os', { mine: true, owner: 'aaaaaaaa', note: 'tabs' }), lane('api-core', { scope: 'hooks/agentic-os' })],
    boardAt: NOW - 2 * MIN,
    compactions: [{ at: NOW - 10 * MIN, sessionId: 's1', open: 3, total: 7, kept: true }],
    agentRuns: [run('r1', 'running', 12 * MIN, { description: 'map hooks' }), run('r2', 'done', 40 * MIN, { description: 'old review' })],
    view: {
      tasks: TASKS,
      plan: { title: 'Pane tabs plan' },
      turn: { id: 't1', startedAt: NOW - 70_000 },
      step: { id: 's1', tool: 'Bash', label: 'npm test', startedAt: NOW - 65_000 },
      ctx: 41,
      agents: [{ id: 'a1', description: 'map hooks', type: 'scout', status: 'running' }],
      lanes: [{ id: 'lane-os', title: 'OS', state: 'active', note: 'tabs' }],
      prs: [{ pr: 194, state: 'READY', whenReady: false }],
    },
  })
}

describe('os tab strip', () => {
  test('O1 seven live tabs in order with hotkeys 1 to 7; no Comms or Resources item; LATER names them', () => {
    const strip = tabStrip('plan', 200)
    expect(strip).toHaveLength(1)
    const items = strip[0] ?? []
    expect(items.map(one => one.id)).toEqual(TABS_LIVE)
    expect(items.every(one => one.enabled)).toBe(true)
    expect(items.map(one => one.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(items.filter(one => one.selected).map(one => one.id)).toEqual(['plan'])
    expect(items.map(itemText).join('')).not.toMatch(/Comms|Resources|NEXT|LATER/)
    expect(items.map(itemText).map(one => one.trim())).toEqual(['Overview', 'Session', 'Steps', 'Work', 'Checks', 'Choices', 'Swarm'])
    expect(TABS.map(one => one.id)).toEqual(TABS_LIVE)
    expect(TABS.every(one => one.enabled && !('tag' in one))).toBe(true)
    expect(model.LATER).toEqual(['Comms', 'Resources'])
  })

  test('O1 isTabId takes the seven ids and nothing else', () => {
    for (const id of TABS_LIVE) expect(isTabId(id)).toBe(true)
    expect(isTabId('swarm')).toBe(true)
    for (const id of ['comms', 'resources', 'Swarm', '', 'x', 3, null, undefined]) expect(isTabId(id)).toBe(false)
  })

  test('O1 a tab that is not live passed as the selection draws Overview and selects nothing else', () => {
    expect(tabStrip('comms' as TabId, 200)[0]?.filter(one => one.selected).map(one => one.id)).toEqual(['overview'])
    expect(all(tabRows('comms' as TabId, empty(), NOW, 80, 20))).toBe(all(tabRows('overview', empty(), NOW, 80, 20)))
  })

  test('O1 O6 a narrow strip wraps to more lines and keeps all seven tabs once, each line inside the width', () => {
    for (const columns of [20, 40, 58, 120]) {
      const strip = tabStrip('overview', columns)
      expect(strip.flat().map(one => one.id)).toEqual(TABS_LIVE)
      for (const line of strip) expect(line.reduce((n, one) => n + itemText(one).length, 0) + Math.max(0, line.length - 1)).toBeLessThanOrEqual(columns)
    }
    expect(tabStrip('overview', 20).length).toBeGreaterThan(tabStrip('overview', 200).length)
  })

  test('O22 the strip is 6, 3, 2 and 2 lines at 20, 40, 58 and 72 columns, 2 at 82 and 1 at 83 (the 3-cell prefix counts: 77 + 6 gaps = 83)', () => {
    expect([20, 40, 58, 72].map(columns => tabStrip('overview', columns).length)).toEqual([6, 3, 2, 2])
    expect(tabStrip('overview', 82)).toHaveLength(2)
    expect(tabStrip('overview', 83)).toHaveLength(1)
  })
})

describe('os overview', () => {
  test('O2 line 1 holds the chip word, repo and branch; then GOAL, NOW, the three blocks, and the health row last', () => {
    const rows = tabRows('overview', rich(), NOW, 100, 60)
    expect(keyed(rows, 'ov-chip')).toContain('Working')
    expect(keyed(rows, 'ov-chip')).toContain('continuous-claude')
    expect(keyed(rows, 'ov-chip')).toContain('feat/sdlc-os-p1a3')
    expect(keyed(rows, 'ov-goal')).toContain('GOAL prove the pane tabs')
    const at = (key: string): number => rows.findIndex(one => one.key === key)
    const head = (title: string): number => rows.findIndex(one => new RegExp(`^${title}\\b`).test(rowText(one)))
    const order = [at('ov-chip'), at('ov-goal'), at('now'), head('NEEDS YOU'), head('DONE'), head('WATCH'), at('ov-health')]
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(rows[0]!.key).toBe('ov-chip')
  })

  test('O2 the rows that moved to other tabs are gone from Overview', () => {
    const rows = tabRows('overview', rich(), NOW, 100, 60)
    const text = all(rows)
    expect(text).not.toContain('STOP AT')
    expect(text).not.toContain('wt-sdlc')
    expect(text).not.toMatch(/^\s*(?:repo|branch|worktree)\s/m)
    expect(text).not.toMatch(/PLAN [▰▱█░]/)
    expect(text).not.toMatch(/ASK \d|UNPROVEN \d/)
    expect(text).not.toMatch(/^(?:LANE|AGENTS|PRS)\b/m)
    expect(text).not.toMatch(/scout\s+map hooks|#194\s+● READY|lane-os\s+● active/)
    for (const key of ['ov-stop', 'ov-repo', 'ov-branch', 'ov-worktree', 'ov-plan', 'ov-plan-title', 'ov-counts', 'h-lane', 'h-agents', 'h-prs']) {
      expect(rows.map(one => one.key), key).not.toContain(key)
    }
  })

  test('O2 the READY change and the questions are in NEEDS YOU, in plain words', () => {
    const text = all(tabRows('overview', rich(), NOW, 100, 60))
    expect(text).toContain('Change #194 is approved and checks pass. Say "merge" to land it.')
    expect(text).toContain('Answer: Which branch?')
    expect(text).toContain('Approve: Create the roles?')
  })

  test('O2 GOAL not set stays visible in amber, and unknown repo, branch, cost and ctx never read as a value', () => {
    const rows = tabRows('overview', empty(), NOW, 100, 60)
    const text = all(rows)
    expect(text).toContain('GOAL not set')
    expect(rows.find(one => one.key === 'ov-goal')?.left.find(one => one.text.includes('not set'))?.tone).toBe('warn')
    expect(keyed(rows, 'ov-chip')).toContain('Resting')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
  })

  test('O21 NOW is the in-progress task: its activeForm first, else its subject; never the tool name or its label', () => {
    const rows = tabRows('overview', rich(), NOW, 100, 60)
    expect(keyed(rows, 'now')).toContain('third step')
    expect(all(rows)).not.toMatch(/Bash|npm test/)
    const form = { ...rich(), view: { ...rich().view, tasks: [task('3', 'third step', 'in_progress', 'Wiring the pane')] } }
    expect(keyed(tabRows('overview', form, NOW, 100, 60), 'now')).toContain('Wiring the pane')
    expect(keyed(tabRows('overview', form, NOW, 100, 60), 'now')).not.toContain('Thinking')
  })

  test('O21 with no task in progress a running turn reads Thinking; with neither, no turn reads Thinking', () => {
    const thinking = empty({ chip: 'working', view: { ...empty().view, turn: { id: 't', startedAt: NOW - 5000 }, step: { id: 's', tool: 'Bash', label: 'npm test', startedAt: NOW - 4000 } } })
    expect(keyed(tabRows('overview', thinking, NOW, 100, 60), 'now')).toContain('Thinking')
    expect(all(tabRows('overview', thinking, NOW, 100, 60))).not.toMatch(/Bash|npm test/)
    expect(keyed(tabRows('overview', empty(), NOW, 100, 60), 'now')).not.toContain('Thinking')
  })

  test('O25 the health row reads ctx, cost and cache; a cache that is not known is left out; nothing reads NaN', () => {
    const rows = tabRows('overview', rich(), NOW, 100, 60)
    expect(keyed(rows, 'ov-health')).toMatch(/ctx[^$]*41%/)
    expect(keyed(rows, 'ov-health')).toContain('$1.84')
    expect(keyed(rows, 'ov-health')).toMatch(/cache\s+73%/)
    expect(rows.filter(one => one.key === 'ov-health')).toHaveLength(1)
    const bare = tabRows('overview', { ...rich(), cachePct: null, costUsd: null, view: { ...rich().view, ctx: null } }, NOW, 100, 60)
    expect(keyed(bare, 'ov-health')).not.toMatch(/cache/)
    expect(keyed(bare, 'ov-health')).not.toMatch(/NaN|undefined|null/)
  })
})

describe('os tab words: Steps, Checks, Choices (labels only; ids and Button keys stay)', () => {
  test('O27 the three tab headers use the plain words, and the tab ids stay plan, proof and decisions', () => {
    const heads: Array<[TabId, string, string, string]> = [
      ['plan', 'h-plan', 'STEPS', 'PLAN'],
      ['proof', 'h-proof', 'CHECKS', 'PROOF'],
      ['decisions', 'h-decisions', 'CHOICES', 'DECISIONS'],
    ]
    for (const [tab, key, word, old] of heads) {
      const head = tabRows(tab, empty(), NOW, 60, 30).find(one => one.key === key)
      expect(head, key).toBeDefined()
      const left = head!.left.map(one => one.text).join('')
      expect(left.startsWith(word), key).toBe(true)
      expect(left, key).not.toContain(old)
    }
    expect(TABS.filter(one => ['plan', 'proof', 'decisions'].includes(one.id)).map(one => one.label)).toEqual(['Steps', 'Checks', 'Choices'])
  })
})

describe('os plan', () => {
  test('O3 tasks win over the brief plan; a done step shows proven with its artifact or UNPROVEN; N of M', () => {
    const brief = briefWith({ plan: [{ id: 'p1', text: 'brief plan only', status: 'todo' }] }, TASKS, proven())
    const rows = tabRows('plan', empty({ brief, view: { ...empty().view, tasks: TASKS } }), NOW, 100, 30)
    const text = all(rows)
    expect(text).not.toContain('brief plan only')
    expect(text).toMatch(/2 of 4/)
    const byStep = (word: string) => rows.find(one => rowText(one).includes(word))!
    expect(rowText(byStep('first step'))).toMatch(/✓.*first step.*proven: cache\/e2e\/one\.txt/)
    expect(rowText(byStep('second step'))).toMatch(/!.*second step.*UNPROVEN/)
    expect(rowText(byStep('third step'))).toMatch(/▶.*third step/)
    expect(rowText(byStep('fourth step'))).toMatch(/○.*fourth step/)
    expect(byStep('second step').right?.[0]?.tone).toBe('warn')
    expect(byStep('first step').right?.[0]?.tone).toBe('done')
  })

  test('O3 with no task the brief plan is the source, with todo, doing, done and blocked marks', () => {
    const plan = [
      { id: 'a', text: 'wait step', status: 'todo' },
      { id: 'b', text: 'run step', status: 'doing' },
      { id: 'c', text: 'done step', status: 'done' },
      { id: 'd', text: 'stuck step', status: 'blocked' },
    ]
    const base = briefWith({ plan })
    const rows = tabRows('plan', empty({ brief: base }), NOW, 100, 30)
    const get = (word: string) => rowText(rows.find(one => rowText(one).includes(word))!)
    expect(get('wait step')).toMatch(/○/)
    expect(get('run step')).toMatch(/▶/)
    expect(get('done step')).toMatch(/!.*UNPROVEN/)
    expect(get('stuck step')).toMatch(/■/)
    expect(all(rows)).toMatch(/1 of 4/)
    const proved = briefWith({ proof: { taskId: 'c', artifact: 'out.txt' } }, [], base)
    expect(rowText(tabRows('plan', empty({ brief: proved }), NOW, 100, 30).find(one => rowText(one).includes('done step'))!)).toMatch(/✓.*proven: out\.txt/)
  })
})

describe('os proof', () => {
  test('O4 done-but-unproven steps come first, then each proof with its artifact', () => {
    const rows = tabRows('proof', empty({ brief: proven(), view: { ...empty().view, tasks: TASKS } }), NOW, 100, 30)
    const text = lines(rows)
    const unproven = text.findIndex(one => one.includes('second step') && one.includes('UNPROVEN'))
    const proof = text.findIndex(one => one.includes('first step') && one.includes('cache/e2e/one.txt'))
    expect(unproven).toBeGreaterThan(-1)
    expect(proof).toBeGreaterThan(unproven)
    expect(all(rows)).toMatch(/1 proven/)
    expect(all(rows)).toMatch(/1 unproven/)
  })
})

describe('os decisions', () => {
  const decided = (): Brief => {
    let brief = briefWith({ decision: { text: 'oldest call', by: 'agent' } }, [], null, NOW - 5 * 3600_000)
    brief = briefWith({ decision: { text: 'middle call', by: 'Dave' } }, [], brief, NOW - 2 * 3600_000)
    return briefWith({ decision: { text: 'newest call', by: 'Dave' } }, [], brief, NOW - 30_000)
  }

  test('O5 decisions come newest first with who decided and how long ago', () => {
    const text = lines(tabRows('decisions', empty({ brief: decided() }), NOW, 100, 30))
    const at = (word: string) => text.findIndex(one => one.includes(word))
    expect(at('newest call')).toBeGreaterThan(-1)
    expect(at('newest call')).toBeLessThan(at('middle call'))
    expect(at('middle call')).toBeLessThan(at('oldest call'))
    expect(text.join('\n')).toMatch(/Dave · just now/)
    expect(text.join('\n')).toMatch(/Dave · 2h ago/)
    expect(text.join('\n')).toMatch(/agent · 5h ago/)
  })

  test('O5 an open ask shows kind, text and recommend; an answered ask is dim and marked answered?', () => {
    const asked = briefWith({ ask: [{ kind: 'approval', text: 'Create the roles?', recommend: 'yes, after review' }] })
    const open = tabRows('decisions', empty({ brief: asked, activeAt: NOW }), NOW, 100, 30)
    expect(all(open)).toMatch(/approval.*Create the roles\?/)
    expect(all(open)).toContain('recommend: yes, after review')
    expect(all(open)).not.toContain('answered?')
    const kind = open.flatMap(one => one.left).find(one => one.text.includes('approval'))
    expect(kind?.tone).toBe('warn')

    const done = tabRows('decisions', empty({ brief: markAsksAnswered(asked, NOW), activeAt: NOW }), NOW, 100, 30)
    expect(all(done)).toContain('answered?')
    const row = done.find(one => rowText(one).includes('Create the roles?'))!
    expect([...row.left, ...(row.right ?? [])].every(one => one.tone === 'dim' || one.text.trim() === '')).toBe(true)
  })

  test('O5 an ask is stale 24 hours after the last activity, and not before', () => {
    const asked = briefWith({ ask: [{ kind: 'question', text: 'Which branch?' }] }, [], null, NOW)
    const later = NOW + 25 * 3600_000
    expect(all(tabRows('decisions', empty({ brief: asked, activeAt: NOW }), later, 100, 30))).toMatch(/stale/)
    expect(all(tabRows('decisions', empty({ brief: asked, activeAt: later - 3600_000 }), later, 100, 30))).not.toMatch(/stale/)
    expect(all(tabRows('decisions', empty({ brief: asked, activeAt: NOW }), NOW + 23 * 3600_000, 100, 30))).not.toMatch(/stale/)
  })
})

/** A state whose strings are far wider than any pane, on every source the six tabs read. */
const longState = (): TabState => {
  const long = 'long text that will not fit a narrow pane '.repeat(4).trim()
  const huge = 'y'.repeat(5000)
  const state = rich()
  // Built by hand: brief_set caps a goal at 240 characters, but a snapshot, a handoff or a parsed answer can hold more.
  state.brief = {
    goal: huge,
    stopAt: long,
    sources: {},
    plan: [{ id: 'p', text: long, status: 'done' }],
    ask: [{ kind: 'question', text: huge, recommend: long, source: 'brief_set' }],
    decisions: [{ text: long, by: 'Dave', at: NOW - MIN }],
    proofs: [{ id: 'p', artifact: long, at: NOW - MIN, subject: long, kind: 'plan' }],
    updatedAt: NOW - MIN,
  }
  state.view.tasks = []
  state.repo = long
  state.branch = long
  state.worktree = long
  state.view.agents = [{ id: 'a', description: long, type: 'scout', status: 'running' }]
  state.view.lanes = [{ id: 'lane-os', title: 'OS', state: 'active', note: long }]
  state.agentRuns = [run('r1', 'running', 20 * MIN, { description: huge }), run('r2', 'done', 40 * MIN, { description: long })]
  state.board = [lane('lane-os', { mine: true, note: huge, scope: long }), lane('api-core', { title: huge, note: huge, scope: 'hooks/agentic-os' }), lane('stopped', { live: false })]
  state.files = [edited(`hooks/agentic-os/${huge}.ts`)]
  return state
}

describe('os tabs: width, size and safety', () => {
  test('O6 no row, no footer and no strip line is wider than the pane at 20 or 200 columns, on every tab', () => {
    for (const columns of [20, 200]) {
      for (const tab of TABS_LIVE) {
        const { strip, body, footer } = osPane(tab, longState(), NOW, columns, 40)
        for (const row of body) expect(rowWidth(row), `${tab} ${columns}`).toBeLessThanOrEqual(columns)
        expect(footer ?? null, `${tab} ${columns} has a footer`).not.toBeNull()
        if (footer != null) expect(rowWidth(footer), `${tab} ${columns} footer`).toBeLessThanOrEqual(columns)
        expect(body.length).toBeGreaterThan(0)
        for (const line of strip) expect(line.reduce((n, one) => n + itemText(one).length, 0)).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('O7 500 steps show the first rows that fit and a +N more row, inside the budget and fast', () => {
    const tasks = Array.from({ length: 500 }, (_, i) => task(`todo-${i + 1}`, `step number ${i + 1}`, 'pending'))
    const started = Date.now()
    const rows = tabRows('plan', empty({ view: { ...empty().view, tasks } }), NOW, 80, 14)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(rows.length).toBeLessThanOrEqual(14)
    const shown = lines(rows).filter(one => /^\s*[○▶✓!■] /.test(one)).length
    const more = /^\s*\+(\d+) more$/.exec(rowText(rows[rows.length - 1]!))
    expect(more).not.toBeNull()
    expect(shown + Number(more?.[1])).toBe(500)
    expect(all(rows)).toContain('0 of 500')
  })

  test('O7 a long plan keeps the running step in view: finished steps fold into one row', () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task(`todo-${i + 1}`, `step number ${i + 1}`, i < 30 ? 'completed' : i === 30 ? 'in_progress' : 'pending'))
    const text = all(tabRows('plan', empty({ view: { ...empty().view, tasks } }), NOW, 80, 12))
    expect(text).toContain('✓ 30 done')
    expect(text).toContain('step number 31')
    expect(text).not.toContain('step number 1\n')
  })

  test('O7 200 proofs and 50 decisions fold to +N more inside the budget', () => {
    const brief: OsBrief = {
      sources: {},
      plan: [],
      ask: [],
      updatedAt: NOW,
      proofs: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, artifact: `out-${i}.txt`, at: NOW, subject: `task ${i}`, kind: 'task' as const })),
      decisions: Array.from({ length: 50 }, (_, i) => ({ text: `decision ${i}`, by: 'Dave', at: NOW - i * 1000 })),
    }
    for (const tab of ['proof', 'decisions'] as const) {
      const rows = tabRows(tab, empty({ brief }), NOW, 80, 10)
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(lines(rows).some(one => /^\s*\+\d+ more$/.test(one))).toBe(true)
    }
  })

  test('O8 a secret in any string is in no row or footer, whole or cut, at any width, on any of the six tabs', () => {
    const brief: OsBrief = {
      title: SECRET,
      goal: `ship ${SECRET}`,
      stopAt: `stop ${SECRET}`,
      sources: {},
      plan: [{ id: SECRET, text: `step ${SECRET}`, status: 'done' }],
      ask: [{ kind: 'question', text: `use ${SECRET}?`, recommend: SECRET, source: 'brief_set' }],
      decisions: [{ text: `chose ${SECRET}`, by: SECRET, at: NOW }],
      proofs: [{ id: SECRET, artifact: `saw ${SECRET}`, at: NOW, subject: `step ${SECRET}`, kind: 'plan' }],
      updatedAt: NOW,
    }
    const state = empty({
      brief,
      repo: SECRET,
      branch: SECRET,
      worktree: SECRET,
      files: [edited(`hooks/${SECRET}.ts`)],
      board: [lane(`mine-${SECRET}`, { mine: true, note: SECRET, scope: SECRET, title: SECRET }), lane(`peer-${SECRET}`, { note: SECRET, scope: `hooks/${SECRET}.ts`, title: SECRET })],
      boardAt: NOW - MIN,
      agentRuns: [run('r1', 'running', 20 * MIN, { description: SECRET, type: SECRET }), run('r2', 'done', 30 * MIN, { description: SECRET })],
      view: {
        ...empty().view,
        tasks: [task('1', `build ${SECRET}`, 'completed')],
        step: { id: 's', tool: 'Bash', label: SECRET, startedAt: NOW },
        agents: [{ id: 'a', description: SECRET, type: 'scout', status: 'running' }],
        lanes: [{ id: 'lane', title: 'x', state: 'active', note: SECRET }],
      },
    })
    for (const columns of [20, 33, 60, 200]) {
      for (const tab of TABS_LIVE) {
        const { strip, body, footer } = osPane(tab, state, NOW, columns, 60)
        const text = [...strip.map(line => line.map(itemText).join(' ')), ...lines(body), ...(footer ? [rowText(footer)] : [])].join('\n')
        expect(text, `${tab} ${columns}`).not.toContain('sk-ant')
        expect(text, `${tab} ${columns}`).not.toContain('a'.repeat(12))
      }
    }
    // The planted task also lands in Plan with the task as source.
    expect(all(tabRows('plan', state, NOW, 120, 30))).toContain('build')
  })

  test('O9 an empty tab draws a clear line, not a blank body', () => {
    const want: Record<TabId, RegExp> = {
      overview: /GOAL not set/,
      session: /no helpers yet/,
      plan: /no steps yet/,
      work: /lane board not read/,
      proof: /no checks yet/,
      decisions: /no choices yet[\s\S]*nothing open/,
      swarm: /no helpers yet this session/,
    }
    for (const tab of TABS_LIVE) {
      const rows = tabRows(tab, empty(), NOW, 60, 30)
      expect(rows.length).toBeGreaterThan(0)
      expect(all(rows), tab).toMatch(want[tab])
      expect(lines(rows).some(one => one.trim() !== '')).toBe(true)
    }
  })

  test('O10 the strip, the body and the footer never draw more rows than the budget, on any tab', () => {
    for (const tab of TABS_LIVE) {
      for (const rows of [1, 2, 3, 5, 6, 7, 12, 40, 60]) {
        for (const columns of [20, 58, 200]) {
          const { strip, body, footer } = osPane(tab, rich(), NOW, columns, rows)
          expect(strip.length + body.length + (footer == null ? 0 : 1), `${tab} ${rows}x${columns}`).toBeLessThanOrEqual(rows)
          expect(strip.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('os footer', () => {
  const longPlan = (): TabState => empty({ view: { ...empty().view, tasks: Array.from({ length: 40 }, (_, i) => task(`t${i}`, `step ${i}`, 'pending')) } })

  test('O23 the footer is one dim row "later: Comms · Resources", drawn once, in no body row, and never names Swarm', () => {
    const pane = osPane('plan', longPlan(), NOW, 58, 40)
    expect(pane.footer ?? null).not.toBeNull()
    expect(rowText(pane.footer!)).toContain(LATER_FOOTER)
    expect(pane.footer!.left.every(one => one.tone === 'dim')).toBe(true)
    expect(all(pane.body)).not.toContain('later:')
    expect(new Set([...pane.body.map(one => one.key), pane.footer!.key]).size).toBe(pane.body.length + 1)
    expect(rowText(pane.footer!)).not.toContain('Swarm')
    for (const text of ['Comms', 'Resources']) expect(model.LATER).toContain(text)
    expect(model.LATER).not.toContain('Swarm')
  })

  test('O23 the footer goes first: with 5 rows (2 strip lines) the body keeps 3 rows and no footer; with 6 rows the footer is back', () => {
    const five = osPane('plan', longPlan(), NOW, 58, 5)
    expect(five.strip).toHaveLength(2)
    expect(five.footer).toBeNull()
    expect(five.body).toHaveLength(3)
    const six = osPane('plan', longPlan(), NOW, 58, 6)
    expect(six.footer ?? null).not.toBeNull()
    expect(six.body).toHaveLength(3)
  })

  test('O23 whatever the tab, rows and width: a footer means a body of 3 or more rows and a total inside the budget; at 60 rows every tab has one', () => {
    for (const tab of TABS_LIVE) {
      for (let rows = 1; rows <= 30; rows++) {
        for (const columns of [20, 58, 200]) {
          const { strip, body, footer } = osPane(tab, rich(), NOW, columns, rows)
          if (footer == null) continue
          expect(body.length, `${tab} ${rows}x${columns}`).toBeGreaterThanOrEqual(3)
          expect(strip.length + body.length + 1, `${tab} ${rows}x${columns}`).toBeLessThanOrEqual(rows)
        }
      }
      expect(osPane(tab, rich(), NOW, 120, 60).footer ?? null, tab).not.toBeNull()
    }
  })
})

describe('os overview in a short pane', () => {
  const crowded = (): TabState => {
    const state = rich()
    state.view.agents = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, description: `job ${i}`, type: 'scout', status: 'running' }))
    state.view.lanes = null
    return state
  }

  test('O11 a 10 to 30 row Overview keeps the chip, GOAL and the three heads; whatever is cut leaves a "+N more" row unless the briefing fills the pane; never over the budget', () => {
    for (const state of [rich(), crowded()]) {
      for (const rows of [10, 12, 13, 24, 30]) {
        const built = tabRows('overview', state, NOW, 58, rows)
        const text = all(built)
        expect(built.length).toBeLessThanOrEqual(rows)
        expect(built.map(one => one.key)).toContain('ov-chip')
        expect(built.map(one => one.key)).toContain('ov-goal')
        for (const title of ['NEEDS YOU', 'DONE', 'WATCH']) expect(text, `${rows} ${title}`).toContain(title)
        const complete = built.some(one => one.key === 'ov-health')
        if (!complete && !built.at(-1)!.key.startsWith('brief-')) expect(rowText(built.at(-1)!)).toMatch(/^\s*\+\d+ more$/)
      }
    }
  })

  test('O11 an Overview that fits has no "+N more" row', () => {
    expect(all(tabRows('overview', rich(), NOW, 100, 60))).not.toMatch(/\+\d+ more/)
  })
})

describe('os tab strip with the hotkey prefix', () => {
  // The terminal draws a live tab Button as "1: label": 3 cells more than its spans.
  const PREFIX = 3
  const lineWidth = (line: TabItem[]): number => line.reduce((n, one) => n + itemText(one).length + (one.enabled ? PREFIX : 0), 0) + Math.max(0, line.length - 1)

  test('O12 every strip line, prefix included, fits the width at 58, 38 and 28 columns', () => {
    for (const columns of [58, 38, 28]) {
      const strip = tabStrip('overview', columns)
      expect(strip.flat().map(one => one.id)).toEqual(TABS_LIVE)
      for (const line of strip) expect(lineWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('O12 the strip rows the pane budgets are the strip rows it draws', () => {
    for (const columns of [58, 38, 28]) {
      const { strip } = osPane('plan', rich(), NOW, columns, 40)
      expect(strip).toEqual(tabStrip('plan', columns))
      expect(strip.length).toBeGreaterThan(1)
    }
  })
})

describe('os tabs keep unique row keys', () => {
  test('O13 30 decisions and 30 asks at 6, 10 and 20 rows give no two rows the same key', () => {
    const brief: OsBrief = {
      sources: {},
      plan: [],
      ask: Array.from({ length: 30 }, (_, i) => ({ kind: 'question' as const, text: `ask ${i}`, source: 'brief_set' as const })),
      updatedAt: NOW,
      proofs: [],
      decisions: Array.from({ length: 30 }, (_, i) => ({ text: `decision ${i}`, by: 'Dave', at: NOW - i * 1000 })),
    }
    for (const rows of [6, 10, 20]) {
      const keys = tabRows('decisions', empty({ brief, activeAt: NOW }), NOW, 80, rows).map(one => one.key)
      expect(keys.length).toBeGreaterThan(2)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  test('O13 no tab draws two rows with one key, in a pane too short for its lists, with long wrapped items', () => {
    for (const state of [rich(), longState()]) {
      for (const tab of TABS_LIVE) {
        for (const rows of [3, 6, 10, 20]) {
          for (const columns of [20, 40, 80]) {
            const keys = tabRows(tab, state, NOW, columns, rows).map(one => one.key)
            expect(new Set(keys).size, `${tab} ${rows}x${columns}`).toBe(keys.length)
          }
        }
      }
    }
  })
})

describe('os decisions: the open ask count (moved from Overview)', () => {
  const asked = (): Brief => briefWith({ ask: [{ kind: 'question', text: 'Which branch?' }] }, [], null, NOW)
  const right = (rows: PaneRow[]) => rows.find(one => one.key === 'h-asks')?.right?.[0]

  test('O14 an answered ask is not counted as open, and shows "answered?"', () => {
    const answered = tabRows('decisions', empty({ brief: markAsksAnswered(asked(), NOW), activeAt: NOW }), NOW, 100, 30)
    expect(right(answered)?.text).toContain('0 open')
    expect(all(answered)).toContain('answered?')
    const fresh = tabRows('decisions', empty({ brief: asked(), activeAt: NOW }), NOW, 100, 30)
    expect(right(fresh)?.text).toContain('1 open')
    expect(all(fresh)).not.toContain('answered?')
  })

  test('O15 an open ask 24 hours quiet reads "1 open · stale" in dim, a fresh one "1 open" in amber, and no open ask is never stale', () => {
    const later = NOW + 25 * 3600_000
    const stale = tabRows('decisions', empty({ brief: asked(), activeAt: NOW }), later, 100, 30)
    expect(right(stale)?.text).toBe('1 open · stale')
    expect(right(stale)?.tone).toBe('dim')
    const fresh = tabRows('decisions', empty({ brief: asked(), activeAt: later - 3600_000 }), later, 100, 30)
    expect(right(fresh)?.text).toBe('1 open')
    expect(right(fresh)?.tone).toBe('warn')
    const none = tabRows('decisions', empty({ brief: markAsksAnswered(asked(), NOW), activeAt: NOW }), later, 100, 30)
    expect(right(none)?.text ?? '').not.toContain('stale')
  })
})

describe('os overview marks', () => {
  test('O16 a parsed goal carries [parsed]; a brief_set one does not; an unset one does not', () => {
    const base: OsBrief = { sources: {}, plan: [], ask: [], decisions: [], proofs: [], updatedAt: NOW, goal: 'ship tabs', stopAt: 'tests green' }
    const parsed = all(tabRows('overview', empty({ brief: { ...base, sources: { goal: 'parsed', stopAt: 'parsed' } } }), NOW, 100, 60))
    expect(parsed).toContain('GOAL ship tabs [parsed]')
    const set = all(tabRows('overview', empty({ brief: { ...base, sources: { goal: 'brief_set', stopAt: 'brief_set' } } }), NOW, 100, 60))
    expect(set).toContain('GOAL ship tabs')
    expect(set).not.toContain('[parsed]')
    const unset = all(tabRows('overview', empty({ brief: { ...base, goal: undefined, stopAt: undefined, sources: { goal: 'parsed', stopAt: 'parsed' } } }), NOW, 100, 60))
    expect(unset).not.toContain('[parsed]')
  })
})

describe('os proof order', () => {
  test('O17 several proofs are listed newest first', () => {
    const brief: OsBrief = {
      sources: {},
      plan: [],
      ask: [],
      decisions: [],
      updatedAt: NOW,
      // Oldest first on purpose: only the sort puts the newest on top.
      proofs: [
        { id: 't1', artifact: 'out-old.txt', at: NOW - 3000, subject: 'old task', kind: 'task' },
        { id: 't2', artifact: 'out-mid.txt', at: NOW - 2000, subject: 'mid task', kind: 'task' },
        { id: 't3', artifact: 'out-new.txt', at: NOW - 1000, subject: 'new task', kind: 'task' },
      ],
    }
    const text = lines(tabRows('proof', empty({ brief }), NOW, 100, 30))
    const at = (word: string) => text.findIndex(one => one.includes(word))
    expect(at('new task')).toBeGreaterThan(-1)
    expect(at('new task')).toBeLessThan(at('mid task'))
    expect(at('mid task')).toBeLessThan(at('old task'))
  })
})

describe('os overview with only a helper running', () => {
  // No turn and no main-loop step: the only live work is a helper or workflow run (view.agents holds the running runs).
  const agent = (status: string) => ({ id: 'a1', description: 'map hooks', type: 'scout', status })
  const rowsWith = (status: string) => tabRows('overview', empty({ chip: status === 'running' ? 'working' : 'idle', view: { ...empty().view, agents: [agent(status)] } }), NOW, 100, 60)

  test('O19 NOW reads "1 helpers running" style text while a helper runs; with none running it does not', () => {
    expect(keyed(rowsWith('running'), 'now')).toMatch(/1 helpers? running/)
    expect(keyed(tabRows('overview', empty(), NOW, 100, 60), 'now')).not.toMatch(/running/)
  })

  test('O20 the chip row beside a working chip does not say Resting while a helper runs', () => {
    const rows = rowsWith('running')
    expect(keyed(rows, 'ov-chip')).toContain('Working')
    expect(keyed(rows, 'ov-chip')).not.toMatch(/Resting/)
  })

  test('O20b a helper that waits is not running: NOW does not count it and the chip row reads Resting', () => {
    const rows = rowsWith('waiting')
    expect(keyed(rows, 'now')).not.toMatch(/running/)
    expect(keyed(rows, 'ov-chip')).toContain('Resting')
    expect(keyed(rows, 'ov-chip')).not.toContain('Working')
  })

  test('O19 two helpers running read "2 helpers running"', () => {
    const state = empty({ chip: 'working', view: { ...empty().view, agents: [agent('running'), { ...agent('running'), id: 'a2' }] } })
    expect(keyed(tabRows('overview', state, NOW, 100, 60), 'now')).toContain('2 helpers running')
  })
})

// O18 the steward's drift (watch-only): missing for unset, stale or finished, not plain English, not dim, drawn when the drift is ok, null
//     or unset, not in WATCH, wider than the pane at 20 to 200 columns, or a secret in the reason reaches a row
describe('os overview: the steward drift row', () => {
  const NO_GOAL = drift(null, { toolCalls: 1, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const planned = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
  const done = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'done' }] })
  const STALE = drift(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const FINISHED = drift(done, { toolCalls: 3, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const withDrift = (brief: Brief | null, found: Drift | null): TabState => ({ ...empty({ brief }), drift: found }) as TabState
  const hasDrift = (one: PaneRow): boolean => /goal is not set yet|12 tool calls|Every plan step is done/.test(rowText(one))

  test('O18 unset, stale and finished each draw one WATCH row with the plain sentence, its text dim, no [steward] tag', () => {
    const cases: [Drift, Brief | null, string][] = [
      [NO_GOAL, null, 'The session goal is not set yet, and work has started.'],
      [STALE, planned, '12 tool calls and 1 commit since the plan last changed.'],
      [FINISHED, done, 'Every plan step is done, but work goes on.'],
    ]
    for (const [found, brief, sentence] of cases) {
      const rows = tabRows('overview', withDrift(brief, found), NOW, 100, 60).filter(hasDrift)
      expect(rows).toHaveLength(1)
      expect(rowText(rows[0]!)).toContain(sentence)
      expect(rowText(rows[0]!)).not.toMatch(/brief stale|\[steward\]/)
      expect(rows[0]!.left.filter(one => one.text.trim().length > 1).every(one => one.tone === 'dim')).toBe(true)
    }
  })

  test('O18 the row is in the WATCH block, not under GOAL', () => {
    const rows = tabRows('overview', withDrift(planned, STALE), NOW, 100, 60)
    const keys = rows.map(one => one.key)
    expect(keys).not.toContain('ov-stale')
    expect(keys[keys.indexOf('ov-goal') + 1]).not.toMatch(/stale/)
    const watchAt = rows.findIndex(one => rowText(one).startsWith('WATCH'))
    expect(watchAt).toBeGreaterThan(-1)
    expect(rows.findIndex(hasDrift)).toBeGreaterThan(watchAt)
  })

  test('O18 no row when the drift is ok, null or not given', () => {
    const ok: Drift = { level: 'ok', reason: '', key: 'ok@0' }
    expect(all(tabRows('overview', withDrift(planned, ok), NOW, 100, 60))).not.toMatch(/since the plan last changed|goal is not set yet|work goes on/)
    expect(all(tabRows('overview', withDrift(planned, null), NOW, 100, 60))).not.toMatch(/since the plan last changed|goal is not set yet|work goes on/)
    expect(all(tabRows('overview', empty({ brief: planned }), NOW, 100, 60))).not.toMatch(/since the plan last changed|goal is not set yet|work goes on/)
  })

  test('O18 the row stays inside the pane from 20 to 200 columns and starts with its mark and "12 tool"', () => {
    for (const columns of [20, 24, 40, 80, 200]) {
      const rows = tabRows('overview', withDrift(planned, STALE), NOW, columns, 40)
      for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(columns)
      expect(rowText(rows.find(one => rowText(one).includes('12 tool'))!), String(columns)).toMatch(/^\s*! 12 tool/)
    }
  })

  test('O18 a secret in the reason is in no row, whole or cut, at any width', () => {
    const leaked: Drift = { level: 'stale', reason: `after ${SECRET} was used`, key: 'stale@1' }
    for (const columns of [20, 40, 60, 200]) {
      const text = all(tabRows('overview', withDrift(planned, leaked), NOW, columns, 40))
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('aaaaaaaa')
    }
  })
})

// The briefing (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to stay on top of").
// Overview draws three blocks, NEEDS YOU, DONE and WATCH, from the state the tabs already read. The row model is in digest.ts and has its
// own tests (digest.test.ts). Item row shape: `  <mark> <text>` with the age in the right group; mark > + !.
// B1 a block head is missing, renamed or out of order, or sits far from the top
// B2 NEEDS YOU drops an ask, its recommendation row, or a READY PR as the merge sentence, or lists them in the wrong order
// B3 DONE drops a decision by Dave or a proof, or shows the artifact name
// B4 WATCH drops a done step with no proof
// B5 an item row has no mark, or a row is wider than the pane, at 20 to 200 columns
// B6 an empty block is not one dim line
// B7 a short pane draws past the budget, or its "+N more" does not count what was left out (items, not rows)
// B8 the stale brief shows twice, or not in WATCH
// B9 a secret in an ask, its recommendation or a decision reaches a row
// B10 two briefing rows share a key
// B11 a run list or feed that is fed never reaches WATCH or DONE, or a missing one throws
// B12 a failed status read of a watched PR is drawn as failed checks
// B13 a long item is not 3 rows ending "...more -> <tab>" in a roomy pane
// B14 a short pane (10 rows) does not retry the briefing at one row per item before it folds the blocks to heads
// B15 grow() prices a multi-row item as one row: the briefing passes the budget or its "+N more" counts rows
describe('os overview: the session briefing', () => {
  const HEADS = ['NEEDS YOU', 'DONE', 'WATCH']
  const MARK = /^\s*[>+!] /
  const headAt = (rows: PaneRow[], title: string): number => rows.findIndex(one => new RegExp(`^${title}\\b`).test(rowText(one)))

  /** The rows of one block: after its head, up to the next block head, or (last block) the first gap or old section row. */
  const blockOf = (rows: PaneRow[], title: string): PaneRow[] => {
    const from = headAt(rows, title)
    if (from < 0) return []
    const later = rows.slice(from + 1)
    const nextHead = later.findIndex((_, i) => HEADS.some(one => headAt([later[i]!], one) === 0))
    const section = later.findIndex(one => /^(?:gap-|ov-|h-|now$|more-overview$)/.test(one.key) && !HEADS.some(name => headAt([one], name) === 0))
    const ends = [nextHead, section].filter(i => i >= 0)
    const stop = ends.length > 0 ? Math.min(...ends) : later.length
    return later.slice(0, stop).filter(one => rowText(one).trim() !== '')
  }
  const itemRows = (block: PaneRow[]): PaneRow[] => block.filter(one => MARK.test(rowText(one)))
  const moreOf = (block: PaneRow[]): number => Number(/^\s*\+(\d+) more$/.exec(rowText(block.at(-1) ?? { key: '', left: [] }))?.[1] ?? 0)

  /** rich() with a brief that holds two asks, a decision by Dave and one proof, all set 3 hours ago. */
  const briefed = (): TabState => {
    const brief = briefWith(
      {
        goal: 'prove the pane tabs',
        ask: [
          { kind: 'question', text: 'Which branch should PR 5 start from?', recommend: 'main at 0ae5f64a' },
          { kind: 'approval', text: 'Create the roles?', recommend: 'yes, after review' },
        ],
        decision: { text: 'Observer only, no deny.', by: 'Dave' },
        proof: { taskId: '1', artifact: 'cache/e2e/one.txt' },
      },
      TASKS,
      null,
      NOW - 3 * 3600_000,
    )
    return { ...rich(), brief }
  }

  test('B1 the three heads are drawn in order, after the chip, GOAL and NOW rows and near the top', () => {
    const rows = tabRows('overview', briefed(), NOW, 100, 60)
    const [a, b, c] = HEADS.map(one => headAt(rows, one))
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a!)
    expect(c).toBeGreaterThan(b!)
    expect(rows.findIndex(one => one.key === 'ov-chip')).toBeLessThan(a!)
    expect(rows.findIndex(one => one.key === 'ov-goal')).toBeLessThan(a!)
    expect(rows.findIndex(one => one.key === 'now')).toBeLessThan(a!)
    expect(a!).toBeLessThanOrEqual(4)
  })

  test('B1 a 10 row pane keeps all three heads, and NEEDS YOU is still near the top', () => {
    const rows = tabRows('overview', briefed(), NOW, 58, 10)
    for (const title of HEADS) expect(headAt(rows, title), title).toBeGreaterThan(-1)
    expect(headAt(rows, 'NEEDS YOU')).toBeLessThanOrEqual(4)
  })

  test('B1 a 10 row pane keeps all three heads when every block holds 3 or more items', () => {
    const asks = Array.from({ length: 3 }, (_, i) => ({ kind: 'question' as const, text: `open question ${i}`, source: 'brief_set' as const }))
    const decisions = Array.from({ length: 3 }, (_, i) => ({ text: `decided ${i}`, by: 'Dave', at: NOW - (i + 1) * 60_000 }))
    const board = Array.from({ length: 3 }, (_, i) => lane(`peer-${i}`, { title: 'peer', owner: `9f2c000${i}` }))
    const brief: OsBrief = { sources: {}, plan: [], ask: asks, decisions, proofs: [], updatedAt: NOW - 60_000 }
    const state = empty({ brief, activeAt: NOW, board, boardAt: NOW })
    const full = tabRows('overview', state, NOW, 80, 60)
    for (const title of HEADS) expect(itemRows(blockOf(full, title)).length, title).toBeGreaterThanOrEqual(3)
    for (const rows of [8, 9, 10]) {
      const built = tabRows('overview', state, NOW, 80, rows)
      expect(built.length).toBeLessThanOrEqual(rows)
      for (const title of HEADS) expect(headAt(built, title), `${rows} ${title}`).toBeGreaterThan(-1)
      // What the briefing cut leaves a marker, unless the briefing fills the pane to its last row.
      if (rows === 10) expect(built.at(-1)!.key === 'more-overview' || built.at(-1)!.key.startsWith('brief-')).toBe(true)
    }
  })

  test('B12 a failed status read of a watched PR (fails) is not drawn as failed checks', () => {
    const state = empty({ view: { ...empty().view, prs: [{ pr: 9, state: 'PENDING', whenReady: false, fails: 2 }] } })
    expect(all(tabRows('overview', state, NOW, 100, 60))).not.toMatch(/checks? failed/i)
  })

  test('B2 NEEDS YOU lists the open ask with "I suggest:" on its next row, the READY change as the merge sentence, then the approval', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'NEEDS YOU').map(rowText)
    const at = (word: string) => list.findIndex(one => one.includes(word))
    expect(at('Answer: Which branch should PR 5 start from?')).toBeGreaterThan(-1)
    expect(list[at('Answer: Which branch') + 1]!.trim().startsWith('I suggest: main at 0ae5f64a')).toBe(true)
    expect(list.find(one => one.includes('Approve: Create the roles?'))).toBeDefined()
    expect(list.join('\n')).toContain('Change #194 is approved and checks pass. Say "merge" to land it.')
    expect(at('Which branch')).toBeLessThan(at('#194'))
    expect(at('#194')).toBeLessThan(at('Create the roles?'))
    expect(list[at('Answer: Which branch')]).toMatch(/ 3h$/)
  })

  test('B3 DONE lists the decision by Dave and the proof, each with its age and no artifact name', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'DONE').map(rowText)
    const decided = list.find(one => one.includes('Observer only, no deny.'))
    expect(decided).toContain('Dave')
    expect(decided).toMatch(/ 3h$/)
    expect(list.find(one => one.includes('first step'))).toMatch(/^\s*\+ /)
    expect(list.join('\n')).not.toContain('one.txt')
  })

  test('B4 WATCH lists the done step that has no proof, and not the proven one', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'WATCH').map(rowText)
    expect(list.find(one => one.includes('second step'))).toContain('Done but not proven yet: second step')
    expect(list.some(one => one.includes('first step'))).toBe(false)
  })

  test('B5 every block has an item that starts with its mark, from 20 to 200 columns, and no row is wider than the pane', () => {
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 1 : 9) {
      const rows = tabRows('overview', briefed(), NOW, columns, 60)
      for (const title of HEADS) {
        const block = blockOf(rows, title)
        expect(itemRows(block).length, `${columns} ${title}`).toBeGreaterThan(0)
        for (const row of block) expect(rowWidth(row), `${columns}: ${rowText(row)}`).toBeLessThanOrEqual(columns)
      }
      for (const row of rows) expect(rowWidth(row), `${columns}: ${rowText(row)}`).toBeLessThanOrEqual(columns)
    }
  })

  test('B6 with nothing to say each block is one dim line: nothing needs you, no highlights yet, nothing to watch', () => {
    const rows = tabRows('overview', empty(), NOW, 100, 60)
    const trimmed = (title: string): string[] => blockOf(rows, title).map(one => rowText(one).trim())
    expect(trimmed('NEEDS YOU')).toEqual(['nothing needs you'])
    expect(trimmed('DONE')).toEqual(['no highlights yet'])
    expect(trimmed('WATCH')).toEqual(['nothing to watch'])
    for (const title of HEADS) expect(blockOf(rows, title)[0]!.left.every(one => one.tone === 'dim')).toBe(true)
  })

  test('B7 a crowded session in a 10, 13, 20 or 60 row pane stays in the budget, and shown + "+N more" is always the total', () => {
    const asks = Array.from({ length: 8 }, (_, i) => ({ kind: 'question' as const, text: `open question ${i}`, source: 'brief_set' as const }))
    const brief: OsBrief = { sources: {}, plan: [], ask: asks, decisions: [], proofs: [], updatedAt: NOW - 60_000 }
    const state = empty({ brief, activeAt: NOW, view: { ...empty().view, prs: [{ pr: 7, state: 'READY', whenReady: false }] } })
    for (const rows of [10, 13, 20, 60]) {
      const built = tabRows('overview', state, NOW, 80, rows)
      expect(built.length).toBeLessThanOrEqual(rows)
      const block = blockOf(built, 'NEEDS YOU')
      const shown = itemRows(block).length
      expect(shown, `${rows} rows`).toBeGreaterThan(0)
      expect(shown + moreOf(block), `${rows} rows`).toBe(9)
    }
  })

  test('B8 a stale brief shows once, and in WATCH, in the plain sentence', () => {
    const planned = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
    const stale = drift(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
    const rows = tabRows('overview', { ...empty({ brief: planned }), drift: stale } as TabState, NOW, 100, 60)
    expect(rows.filter(one => rowText(one).includes('12 tool calls'))).toHaveLength(1)
    const watch = blockOf(rows, 'WATCH').map(rowText)
    expect(watch.find(one => one.includes('12 tool calls'))).toContain('12 tool calls and 1 commit since the plan last changed.')
  })

  test('B9 a secret in an ask, its recommendation or a decision is in no row, whole or cut, at any width', () => {
    const brief = briefWith({ goal: 'g', ask: [{ kind: 'question', text: `ask ${SECRET}`, recommend: `rec ${SECRET}` }], decision: { text: `decided ${SECRET}`, by: 'Dave' } })
    for (const columns of [20, 33, 60, 200]) {
      const text = all(tabRows('overview', empty({ brief, activeAt: NOW }), NOW, columns, 40))
      expect(text).toContain('decided')
      expect(text).not.toContain(SECRET)
      expect(text).not.toMatch(/sk-ant|aaaaaaaa/)
    }
  })

  test('B10 no two rows of the briefing share a key, in a roomy and in a short pane', () => {
    for (const rows of [6, 10, 13, 20, 60]) {
      const keys = tabRows('overview', briefed(), NOW, 80, rows).map(one => one.key)
      expect(new Set(keys).size).toBe(keys.length)
      if (rows >= 10) expect(headAt(tabRows('overview', briefed(), NOW, 80, rows), 'NEEDS YOU')).toBeGreaterThan(-1)
    }
  })

  test('B13 a roomy pane draws a long ask as 3 rows ending "...more -> Choices"; the keys are brief-needs-0, -2, -3', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i % 10}`).join(' ')
    const brief = briefWith({ goal: 'g', ask: [{ kind: 'question', text }] }, [], null, NOW - 5 * MIN)
    const rows = tabRows('overview', empty({ brief, activeAt: NOW }), NOW, 40, 60)
    const keys = rows.map(one => one.key)
    expect(keys).toEqual(expect.arrayContaining(['brief-needs-0', 'brief-needs-0-2', 'brief-needs-0-3']))
    const last = rows.find(one => one.key === 'brief-needs-0-3')!
    expect(last.left.map(one => one.text).join('')).toMatch(/(?:\.\.\.|…)more -> Choices$/)
    expect(keys).not.toContain('brief-needs-0-4')
  })

  test('B14 a 10 row pane with one 3-row item per block retries at one row per item: each block keeps its item, cut with an ellipsis', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i % 10}`).join(' ')
    const brief = briefWith({ goal: 'g', ask: [{ kind: 'question', text }], decision: { text, by: 'Dave' } }, [], null, NOW - 5 * MIN)
    const state = empty({ brief, activeAt: NOW, agentRuns: [run('slow', 'running', 25 * MIN, { description: text })] })
    const roomy = tabRows('overview', state, NOW, 58, 60)
    for (const title of HEADS) expect(blockOf(roomy, title).length, `roomy ${title}`).toBeGreaterThanOrEqual(3)
    const built = tabRows('overview', state, NOW, 58, 10)
    expect(built.length).toBeLessThanOrEqual(10)
    for (const title of HEADS) {
      const block = blockOf(built, title)
      expect(headAt(built, title), title).toBeGreaterThan(-1)
      expect(itemRows(block), `${title} keeps its item`).toHaveLength(1)
      expect(moreOf(block), `${title} cuts nothing it can keep`).toBe(0)
      expect(rowText(itemRows(block)[0]!)).toMatch(/(?:…|\.\.\.)/)
    }
  })

  test('B15 eight 3-row asks in a 13, 20 or 60 row pane stay in the budget, and shown + "+N more" counts items (8), not rows', () => {
    const asks = Array.from({ length: 8 }, (_, i) => ({ kind: 'question' as const, text: `${Array.from({ length: 40 }, (_, j) => `w${j % 10}`).join(' ')} ${i}`, source: 'brief_set' as const }))
    const brief: OsBrief = { sources: {}, plan: [], ask: asks, decisions: [], proofs: [], updatedAt: NOW - 60_000 }
    const state = empty({ brief, activeAt: NOW })
    for (const rows of [13, 20, 60]) {
      const built = tabRows('overview', state, NOW, 40, rows)
      expect(built.length, `${rows}`).toBeLessThanOrEqual(rows)
      const block = blockOf(built, 'NEEDS YOU')
      expect(itemRows(block).length, `${rows}`).toBeGreaterThan(0)
      expect(itemRows(block).length + moreOf(block), `${rows}`).toBe(8)
    }
    const roomy = blockOf(tabRows('overview', state, NOW, 40, 60), 'NEEDS YOU')
    expect(itemRows(roomy)).toHaveLength(5)
    expect(roomy.filter(one => !MARK.test(rowText(one)) && !/^\s*\+\d+ more$/.test(rowText(one)))).toHaveLength(10)
  })
})

// PR 5 wiring: the pane feeds the run list, the board and the optional feed to the digest.
describe('os overview: the briefing reads agentRuns, the board and the feed', () => {
  const runs = [run('r1', 'running', 25 * MIN, { description: 'slow build' }), run('r2', 'done', 50 * MIN, { description: 'map hooks' })]
  const block = (rows: PaneRow[], title: string): string[] => {
    const from = rows.findIndex(one => rowText(one).startsWith(title))
    return rows.slice(from + 1).map(rowText).slice(0, 8)
  }

  test('B11 a run that is live for 25 minutes is in WATCH, a finished one in DONE, a live peer lane and a commit show, none fed is fine', () => {
    const state = {
      ...empty(),
      agentRuns: runs,
      board: [lane('sdlc-os', { title: 'SDLC' })],
      boardAt: NOW,
      feed: { commits: [{ sha: 'b8448c3e1f2a', subject: 'fix: scrub', at: NOW - 5 * MIN }] },
    } as TabState
    const rows = tabRows('overview', state, NOW, 100, 60)
    expect(block(rows, 'WATCH').join('\n')).toContain('A helper has run 25 min: slow build')
    expect(block(rows, 'WATCH').join('\n')).toContain('Another session holds lane sdlc-os')
    expect(block(rows, 'DONE').join('\n')).toMatch(/\+ fix: scrub/)
    expect(block(rows, 'DONE').join('\n')).not.toContain('b8448c3')
    expect(block(rows, 'DONE').join('\n')).toContain('A helper finished: map hooks')
    expect(() => tabRows('overview', empty(), NOW, 100, 60)).not.toThrow()
  })

  test('B11 a missing board, missing files and missing compactions are fine on every tab', () => {
    for (const tab of TABS_LIVE) expect(() => tabRows(tab, empty({ board: null }), NOW, 60, 20), tab).not.toThrow()
    for (const tab of TABS_LIVE) expect(() => tabRows(tab, { ...empty(), board: undefined, files: undefined, compactions: undefined, agentRuns: undefined } as TabState, NOW, 60, 20), tab).not.toThrow()
  })
})

describe('os overview: peer lanes that may touch my files (K4)', () => {
  const state = (): TabState =>
    empty({
      files: [edited('hooks/agentic-os/digest.ts')],
      board: [
        lane('api-core', { scope: 'hooks/agentic-os' }),
        lane('docs-lane', { scope: 'docs/' }),
        lane('mine-lane', { mine: true, owner: 'aaaaaaaa', scope: 'hooks/agentic-os' }),
        lane('gone-lane', { live: false, scope: 'hooks/agentic-os' }),
      ],
      boardAt: NOW,
    })
  const watch = (rows: PaneRow[]): string[] => {
    const from = rows.findIndex(one => /^WATCH\b/.test(rowText(one)))
    return rows.slice(from + 1).map(rowText)
  }
  const groupOf = (rows: string[], id: string): string => {
    const at = rows.findIndex(one => one.includes(id))
    if (at < 0) return ''
    const next = rows.slice(at + 1).findIndex(one => !one.startsWith('    '))
    return rows.slice(at, next < 0 ? undefined : at + 1 + next).join('\n')
  }

  test('O26 K4 the peer whose scope overlaps my edited files reads "may touch the same files" with the Work hint; the other peer does not', () => {
    const rows = watch(tabRows('overview', state(), NOW, 100, 60))
    expect(groupOf(rows, 'api-core')).toContain('Another session holds lane api-core')
    expect(groupOf(rows, 'api-core')).toContain('may touch the same files')
    expect(groupOf(rows, 'api-core')).toMatch(/(?:\.\.\.|…)more -> Work/)
    expect(groupOf(rows, 'docs-lane')).toContain('Another session holds lane docs-lane')
    expect(groupOf(rows, 'docs-lane')).not.toContain('may touch')
  })

  test('O26 K4 my own lane and the lane of a stopped session never show in WATCH', () => {
    const text = watch(tabRows('overview', state(), NOW, 100, 60)).join('\n')
    expect(text).not.toContain('mine-lane')
    expect(text).not.toContain('gone-lane')
  })

  test('O26 K4 with no edited file nothing overlaps, and a read file does not count', () => {
    const none = { ...state(), files: [{ path: 'hooks/agentic-os/digest.ts', state: 'read' as const, added: 0, removed: 0 }] }
    expect(all(tabRows('overview', none, NOW, 100, 60))).not.toContain('may touch')
  })
})

describe('os tabs: dispatch and determinism', () => {
  test('O24 tabRows draws the Session and Work tabs', () => {
    expect(all(tabRows('session', rich(), NOW, 100, 40))).toMatch(/STATE[\s\S]*HELPERS/)
    expect(all(tabRows('work', rich(), NOW, 100, 40))).toContain('YOUR LANES')
    expect(all(tabRows('session', rich(), NOW, 100, 40))).not.toBe(all(tabRows('overview', rich(), NOW, 100, 40)))
  })

  test('O28 tabRows draws the Swarm tab: its header, the plain helpers under HELPERS, and the workflow run before its helpers', () => {
    const state = rich()
    state.agentRuns = [
      ...(state.agentRuns ?? []),
      run('w1', 'running', 4 * MIN, { description: 'judge the maps', workflowRunId: 'wf_a' }),
      run('w2', 'done', 9 * MIN, { description: 'map the hooks', workflowRunId: 'wf_a' }),
    ]
    const text = all(tabRows('swarm', state, NOW, 100, 40))
    expect(text).toMatch(/^SWARM/)
    expect(text).toMatch(/1 running, 1 done · a workflow[\s\S]*judge the maps[\s\S]*map the hooks[\s\S]*HELPERS[\s\S]*map hooks[\s\S]*old review/)
    expect(text).not.toBe(all(tabRows('overview', state, NOW, 100, 40)))
    expect(text).not.toBe(all(tabRows('session', state, NOW, 100, 40)))
    expect(all(tabRows('swarm', empty(), NOW, 100, 40))).toContain('no helpers yet this session')
  })

  test('O24 the same state and clock give the same rows on all seven tabs, at two widths', () => {
    for (const tab of TABS_LIVE) {
      for (const columns of [30, 100]) {
        expect(osPane(tab, rich(), NOW, columns, 30), tab).toEqual(osPane(tab, rich(), NOW, columns, 30))
        expect(all(osPane(tab, rich(), NOW + 5 * 3600_000, columns, 30).body), tab).not.toBe('')
      }
    }
  })

  test('O24 a deeply frozen state does not throw on any tab', () => {
    const freeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) freeze(inner)
      return Object.freeze(value)
    }
    const frozen = freeze(rich())
    for (const tab of TABS_LIVE) expect(() => osPane(tab, frozen, NOW, 60, 30), tab).not.toThrow()
  })
})

const askHead = (rows: PaneRow[]): string => (rows.find(one => one.key === 'h-asks')?.right ?? []).map(one => one.text).join('')

describe('decisions tab: to-dos (card coord-status-band-2)', () => {
  test('O20 a todo is not in the open count and its kind label is dim; a question beside it is counted and amber', () => {
    const brief = briefWith({ ask: [{ kind: 'todo', text: 'Run /compact here' }, { kind: 'question', text: 'Open the PR?' }] })
    const rows = tabRows('decisions', empty({ brief, activeAt: NOW }), NOW, 100, 30)
    expect(askHead(rows)).toContain('1 open')
    const kind = (word: string) => rows.flatMap(one => one.left).find(one => one.text.trim() === word)
    expect(kind('todo')?.tone).toBe('dim')
    expect(kind('question')?.tone).toBe('warn')
    const onlyTodo = tabRows('decisions', empty({ brief: briefWith({ ask: [{ kind: 'todo', text: 'Run /compact here' }] }), activeAt: NOW }), NOW, 100, 30)
    expect(askHead(onlyTodo)).toContain('0 open')
  })
})
