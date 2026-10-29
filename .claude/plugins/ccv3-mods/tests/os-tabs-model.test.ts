import { describe, expect, test } from 'claude-code/testing'

import { applyBrief, markAsksAnswered } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { drift } from '../hooks/agentic-os/steward'
import type { Drift } from '../hooks/agentic-os/steward'
import { TABS, isTabId, osPane, tabRows, tabStrip } from '../hooks/agentic-os/os-tabs-model'
import type { TabId, TabItem, TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import type { OsBrief, OsTask } from '../types'

// Ways the /os tabs (PRD 5.3) can fail, one test each. Every check reads the rows the model returns.
// O1 a tab is missing, out of order, or a not-yet-built tab (Comms, Swarm, Resources) is selectable or loses its tag
// O2 Overview drops a field of today's pane or the new goal, stop-at, repo, branch, worktree, counts and cost
// O3 Plan takes the wrong source (tasks first, else the brief plan), a wrong mark, or a done step without proven or UNPROVEN
// O4 Proof lists proofs before the done-but-unproven steps, or loses an artifact
// O5 Decisions are not newest first, lose by or age, or an ask loses its kind, recommend, answered? or stale mark
// O6 a row is wider than the pane at 20 or 200 columns, or a tab strip line is
// O7 0 steps, 500 steps, 200 proofs or 50 decisions: no empty state, no "+N more", more rows than the budget, or slow
// O8 a secret in any brief string, task, agent, lane or step reaches a row, whole or cut by the width
// O9 an empty tab draws a blank body
// O10 the strip and the body together draw more rows than the budget
// O11 a short Overview (10, 12 or 13 rows) drops AGENTS, PRS or any section with no "+N more" marker, or draws past the budget
// O12 the strip ignores the "1: " a live tab Button is drawn with, so a line is wider than the pane or the budgeted row count is wrong
// O13 two sibling rows share a key (the "+N more" row of Decisions and of Open asks)
// O14 Overview counts an answered ask in "ASK n", or loses "n answered?"
// O15 Overview loses the stale mark on ASK, or draws it in the amber of a fresh ask
// O16 Overview loses "[parsed]" on GOAL or STOP AT, or draws it on a goal that brief_set wrote
// O19 O20 NOW and the chip row of Overview read idle while a subagent or workflow run is live (no turn, no step)
// O17 Proof lists several proofs oldest first
// O18 PR 3 (Dave: no ctx, cost or limits outside the status line): Overview draws a ctx gauge, a dollar cost, a limit or a percent,
//     at any width or height; its rows change when ctx or cost change; the old ctx and cost row key is still there

const NOW = 100 * 3600_000
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const TABS_LIVE: TabId[] = ['overview', 'plan', 'proof', 'decisions']

// costUsd is still fed by the caller; the tests prove Overview does not draw it. Typed loose so the helpers compile
// whether or not TabState keeps the field.
type Fed = Partial<TabState> & { costUsd?: number | null }

const empty = (over: Fed = {}): TabState =>
  ({
    view: { tasks: [], plan: null, turn: null, step: null, ctx: null, agents: [], lanes: null, prs: [] },
    chip: 'idle',
    brief: null,
    repo: null,
    branch: null,
    worktree: null,
    costUsd: null,
    activeAt: null,
    ...over,
  }) as TabState

const task = (id: string, subject: string, status: OsTask['status']): OsTask => ({ id, subject, status })

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

const TASKS = [task('1', 'first step', 'completed'), task('2', 'second step', 'completed'), task('3', 'third step', 'in_progress'), task('4', 'fourth step', 'pending')]

/** Task 1 proven, task 2 done with no proof, task 3 running, task 4 waiting. */
const proven = (): Brief => briefWith({ proof: { taskId: '1', artifact: 'cache/e2e/one.txt' } }, TASKS)

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
  test('O1 four live tabs then Comms NEXT, Swarm LATER, Resources LATER; only a live tab is selectable', () => {
    const strip = tabStrip('plan', 200)
    expect(strip).toHaveLength(1)
    const items = strip[0] ?? []
    expect(items.map(one => one.id)).toEqual(['overview', 'plan', 'proof', 'decisions', 'comms', 'swarm', 'resources'])
    expect(items.map(one => one.enabled)).toEqual([true, true, true, true, false, false, false])
    expect(items.filter(one => one.selected).map(one => one.id)).toEqual(['plan'])
    expect(itemText(items[4]!)).toMatch(/Comms\s+NEXT/)
    expect(itemText(items[5]!)).toMatch(/Swarm\s+LATER/)
    expect(itemText(items[6]!)).toMatch(/Resources\s+LATER/)
    expect(TABS.filter(one => one.enabled).map(one => one.id)).toEqual(TABS_LIVE)
    expect(isTabId('plan')).toBe(true)
    for (const id of ['comms', 'swarm', 'resources', '', 'x', 3, null]) expect(isTabId(id)).toBe(false)
  })

  test('O1 a disabled tab passed as the selection draws Overview and selects nothing', () => {
    expect(tabStrip('comms' as TabId, 200)[0]?.some(one => one.selected && !one.enabled)).toBe(false)
    expect(all(tabRows('comms' as TabId, empty(), NOW, 80, 20))).toBe(all(tabRows('overview', empty(), NOW, 80, 20)))
  })

  test('O1 O6 a narrow strip wraps to more lines and keeps all seven tabs once, each line inside the width', () => {
    for (const columns of [20, 40, 58, 120]) {
      const strip = tabStrip('overview', columns)
      expect(strip.flat().map(one => one.id)).toEqual(['overview', 'plan', 'proof', 'decisions', 'comms', 'swarm', 'resources'])
      for (const line of strip) expect(line.reduce((n, one) => n + itemText(one).length, 0) + Math.max(0, line.length - 1)).toBeLessThanOrEqual(columns)
    }
    expect(tabStrip('overview', 20).length).toBeGreaterThan(tabStrip('overview', 200).length)
  })
})

describe('os overview', () => {
  test('O2 every field of the old pane and the new fields is drawn', () => {
    const text = all(tabRows('overview', rich(), NOW, 100, 60))
    expect(text).toContain('WORKING')
    expect(text).toContain('GOAL prove the pane tabs')
    expect(text).toContain('STOP AT tests green, no commit')
    expect(text).toMatch(/repo\s+continuous-claude/)
    expect(text).toMatch(/branch\s+feat\/sdlc-os-p1a3/)
    expect(text).toMatch(/worktree\s+wt-sdlc/)
    expect(text).toMatch(/lane-os\s+● active/)
    expect(text).toMatch(/PLAN .*2\/4/)
    expect(text).toContain('ASK 2')
    expect(text).toContain('UNPROVEN 1')
    expect(text).toMatch(/Bash\s+npm test/)
    expect(text).toContain('1:05')
    expect(text).toMatch(/scout\s+map hooks/)
    expect(text).toMatch(/#194\s+● READY/)
  })

  test('O2 GOAL not set stays visible, and unknown repo, branch and worktree read as a dash, not as a value', () => {
    const rows = tabRows('overview', empty(), NOW, 100, 60)
    const text = all(rows)
    expect(text).toContain('GOAL not set')
    expect(rows.flatMap(one => one.left).find(one => one.text.includes('not set'))?.tone).toBe('warn')
    expect(text).toContain('IDLE')
    expect(text).toMatch(/repo\s+-/)
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
  })
})

describe('os overview without ctx, cost or limits (PR 3)', () => {
  // The words and shapes the status line owns. Nothing of them may reach an Overview row.
  const OWNED = /ctx|\$|\bcost\b|limit|\b[57][hd]\b|\d\s*%/i

  const withGauges = (ctx: number | null, costUsd: number | null): TabState => {
    const state = rich()
    return { ...state, costUsd, view: { ...state.view, ctx } } as TabState
  }

  test('O18 no Overview row draws ctx, a dollar cost, a limit or a percent, at every width from 20 to 200 and at 10, 13 and 60 rows', () => {
    for (const state of [rich(), withGauges(97, 120.5), withGauges(0, 0), withGauges(null, null)]) {
      for (const rows of [10, 13, 60]) {
        for (let columns = 20; columns <= 200; columns++) expect(all(tabRows('overview', state, NOW, columns, rows))).not.toMatch(OWNED)
      }
    }
  })

  test('O18 the Overview rows are the same whatever ctx and cost the caller feeds, in a roomy and in a short pane', () => {
    for (const rows of [60, 13, 12, 10]) {
      const calm = lines(tabRows('overview', withGauges(5, 0.01), NOW, 58, rows))
      expect(lines(tabRows('overview', withGauges(99, 250), NOW, 58, rows))).toEqual(calm)
      expect(lines(tabRows('overview', withGauges(null, null), NOW, 58, rows))).toEqual(calm)
    }
  })

  test('O18 the ctx and cost row is gone: no row keyed ov-health', () => {
    expect(tabRows('overview', rich(), NOW, 100, 60).map(row => row.key)).not.toContain('ov-health')
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

    const done = tabRows('decisions', empty({ brief: markAsksAnswered(asked), activeAt: NOW }), NOW, 100, 30)
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

describe('os tabs: width, size and safety', () => {
  const long = 'long text that will not fit a narrow pane '.repeat(4).trim()

  test('O6 no row is wider than the pane at 20 or 200 columns, on every tab', () => {
    const state = rich()
    state.brief = briefWith(
      {
        goal: long,
        stopAt: long,
        ask: [{ kind: 'question', text: long, recommend: long }],
        decision: { text: long, by: 'Dave' },
        plan: [{ id: 'p', text: long, status: 'done' }],
        proof: { taskId: 'p', artifact: long },
      },
      [],
    )
    state.view.tasks = []
    state.repo = long
    state.branch = long
    state.view.agents = [{ id: 'a', description: long, type: 'scout', status: 'running' }]
    state.view.lanes = [{ id: 'lane-os', title: 'OS', state: 'active', note: long }]
    for (const columns of [20, 200]) {
      for (const tab of TABS_LIVE) {
        const { strip, body } = osPane(tab, state, NOW, columns, 40)
        for (const row of body) expect(rowWidth(row)).toBeLessThanOrEqual(columns)
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

  test('O8 a secret in any string is in no row, whole or cut, at any width', () => {
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
        const { strip, body } = osPane(tab, state, NOW, columns, 60)
        const text = [...strip.map(line => line.map(itemText).join(' ')), ...lines(body)].join('\n')
        expect(text).not.toContain('sk-ant')
        expect(text).not.toContain('a'.repeat(12))
      }
    }
    // The planted task also lands in Plan with the task as source.
    expect(all(tabRows('plan', state, NOW, 120, 30))).toContain('build')
  })

  test('O9 an empty tab draws a clear line, not a blank body', () => {
    const want: Record<TabId, RegExp> = {
      overview: /GOAL not set/,
      plan: /no steps yet/,
      proof: /no proof yet/,
      decisions: /no decisions yet[\s\S]*nothing open/,
    }
    for (const tab of TABS_LIVE) {
      const rows = tabRows(tab, empty(), NOW, 60, 20)
      expect(rows.length).toBeGreaterThan(0)
      expect(all(rows)).toMatch(want[tab])
      expect(lines(rows).some(one => one.trim() !== '')).toBe(true)
    }
  })

  test('O10 the strip and the body never draw more rows than the budget', () => {
    for (const tab of TABS_LIVE) {
      for (const rows of [1, 2, 3, 5, 12, 40]) {
        for (const columns of [20, 58, 200]) {
          const { strip, body } = osPane(tab, rich(), NOW, columns, rows)
          expect(strip.length + body.length).toBeLessThanOrEqual(rows)
          expect(strip.length).toBeGreaterThan(0)
        }
      }
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

  // PR 5 edit: the briefing (NEEDS YOU, HIGHLIGHTS, WATCH) outranks AGENTS and PRS, which it already lists (a PR waiting for the
  // merge yes, a long agent, a finished run), so a 10 to 13 row pane keeps the three heads (B1) and no longer AGENTS and PRS.
  // The old rule "whatever is cut leaves a +N more row" still holds unless the briefing fills the pane to its last row.
  test('O11 a 10, 12 or 13 row Overview keeps the briefing heads; whatever is cut leaves a "+N more" row unless the briefing fills the pane; never over the budget', () => {
    for (const state of [rich(), crowded()]) {
      for (const rows of [10, 12, 13]) {
        const built = tabRows('overview', state, NOW, 58, rows)
        const text = all(built)
        expect(built.length).toBeLessThanOrEqual(rows)
        for (const title of ['NEEDS YOU', 'HIGHLIGHTS', 'WATCH']) expect(text).toContain(title)
        const complete = ['LANE', 'NOW', 'STOP AT', 'worktree'].every(word => text.includes(word))
        if (!complete && !built.at(-1)!.key.startsWith('brief-')) expect(rowText(built.at(-1)!)).toMatch(/^\s*\+\d+ more$/)
      }
    }
  })

  test('O11 AGENTS and PRS stay in a 24 or 30 row Overview; whatever is cut leaves a "+N more" row; never over the budget', () => {
    for (const state of [rich(), crowded()]) {
      for (const rows of [24, 30]) {
        const built = tabRows('overview', state, NOW, 58, rows)
        const text = all(built)
        expect(built.length).toBeLessThanOrEqual(rows)
        expect(text).toContain('AGENTS')
        expect(text).toContain('PRS')
        const complete = ['LANE', 'NOW', 'STOP AT', 'worktree'].every(word => text.includes(word))
        if (!complete) expect(rowText(built[built.length - 1]!)).toMatch(/^\s*\+\d+ more$/)
      }
    }
  })

  test('O11 an Overview that fits has no "+N more" row', () => {
    expect(all(tabRows('overview', rich(), NOW, 100, 60))).not.toMatch(/\+\d+ more/)
  })
})

describe('os tab strip with the hotkey prefix', () => {
  // The terminal draws a live tab Button as "1: label": 3 cells more than its spans. A tab that is not a Button has no prefix.
  const PREFIX = 3
  const lineWidth = (line: TabItem[]): number => line.reduce((n, one) => n + itemText(one).length + (one.enabled ? PREFIX : 0), 0) + Math.max(0, line.length - 1)

  test('O12 every strip line, prefix included, fits the width at 58, 38 and 28 columns', () => {
    for (const columns of [58, 38, 28]) {
      const strip = tabStrip('overview', columns)
      expect(strip.flat().map(one => one.id)).toEqual(['overview', 'plan', 'proof', 'decisions', 'comms', 'swarm', 'resources'])
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

describe('os decisions and asks keep unique row keys', () => {
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

  test('O13 no tab draws two rows with one key, in a pane too short for its lists', () => {
    for (const tab of TABS_LIVE) {
      for (const rows of [3, 6, 10, 20]) {
        const keys = tabRows(tab, rich(), NOW, 80, rows).map(one => one.key)
        expect(new Set(keys).size).toBe(keys.length)
      }
    }
  })
})

describe('os overview marks', () => {
  const asked = (): Brief => briefWith({ ask: [{ kind: 'question', text: 'Which branch?' }] }, [], null, NOW)
  const tone = (rows: PaneRow[], word: string) => rows.flatMap(one => one.left).find(one => one.text.includes(word))?.tone

  test('O14 an answered ask is not counted in ASK, and shows as "1 answered?"', () => {
    const text = all(tabRows('overview', empty({ brief: markAsksAnswered(asked()), activeAt: NOW }), NOW, 100, 60))
    expect(text).toContain('ASK 0')
    expect(text).toContain('1 answered?')
    const fresh = all(tabRows('overview', empty({ brief: asked(), activeAt: NOW }), NOW, 100, 60))
    expect(fresh).toContain('ASK 1')
    expect(fresh).not.toContain('answered?')
  })

  test('O15 an open ask 24 hours quiet reads "ASK 1 stale" in dim, a fresh one "ASK 1" in amber, and no open ask is never stale', () => {
    const later = NOW + 25 * 3600_000
    const stale = tabRows('overview', empty({ brief: asked(), activeAt: NOW }), later, 100, 60)
    expect(all(stale)).toContain('ASK 1 stale')
    expect(tone(stale, 'ASK 1')).toBe('dim')
    const fresh = tabRows('overview', empty({ brief: asked(), activeAt: later - 3600_000 }), later, 100, 60)
    expect(all(fresh)).not.toContain('stale')
    expect(tone(fresh, 'ASK 1')).toBe('warn')
    const none = tabRows('overview', empty({ brief: markAsksAnswered(asked()), activeAt: NOW }), later, 100, 60)
    expect(all(none)).not.toContain('stale')
  })

  test('O16 a parsed goal and stop-at carry [parsed]; a brief_set one does not; an unset one does not', () => {
    const base: OsBrief = { sources: {}, plan: [], ask: [], decisions: [], proofs: [], updatedAt: NOW, goal: 'ship tabs', stopAt: 'tests green' }
    const parsed = all(tabRows('overview', empty({ brief: { ...base, sources: { goal: 'parsed', stopAt: 'parsed' } } }), NOW, 100, 60))
    expect(parsed).toContain('GOAL ship tabs [parsed]')
    expect(parsed).toContain('STOP AT tests green [parsed]')
    const set = all(tabRows('overview', empty({ brief: { ...base, sources: { goal: 'brief_set', stopAt: 'brief_set' } } }), NOW, 100, 60))
    expect(set).toContain('GOAL ship tabs')
    expect(set).not.toContain('[parsed]')
    const onlyGoal = all(tabRows('overview', empty({ brief: { ...base, sources: { goal: 'parsed', stopAt: 'brief_set' } } }), NOW, 100, 60))
    expect(onlyGoal).toContain('GOAL ship tabs [parsed]')
    expect(onlyGoal).not.toContain('tests green [parsed]')
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

describe('os overview with only a subagent running', () => {
  // No turn and no main-loop step: the only live work is a subagent or workflow run (view.agents holds the running runs).
  const agent = (status: string) => ({ id: 'a1', description: 'map hooks', type: 'scout', status })
  const rowsWith = (status: string) => tabRows('overview', empty({ chip: status === 'running' ? 'working' : 'idle', view: { ...empty().view, agents: [agent(status)] } }), NOW, 100, 60)
  const keyed = (rows: PaneRow[], key: string) => rowText(rows.find(one => one.key === key)!)

  test('O19 NOW is not idle while a subagent runs; with none running it still reads idle', () => {
    expect(keyed(rowsWith('running'), 'now')).not.toMatch(/idle/)
    expect(keyed(tabRows('overview', empty(), NOW, 100, 60), 'now')).toMatch(/idle/)
  })

  test('O20 the chip row beside a working chip does not say idle while a subagent runs', () => {
    const rows = rowsWith('running')
    expect(keyed(rows, 'ov-chip')).toContain('WORKING')
    expect(keyed(rows, 'ov-chip')).not.toMatch(/idle/)
  })

  test('O20b an agent that waits is not running: NOW and the chip row both read idle beside an idle chip', () => {
    const rows = rowsWith('waiting')
    expect(keyed(rows, 'now')).toMatch(/idle/)
    expect(keyed(rows, 'now')).not.toMatch(/running/)
    expect(keyed(rows, 'ov-chip')).not.toContain('WORKING')
  })
})

// O18 the dim `brief stale` row (the steward, watch-only): missing for unset, stale or finished, not plain English, not dim, drawn when
//     the drift is ok, null or unset, not next to GOAL, wider than the pane at 20 to 200 columns, or a secret in the reason reaches a row
describe('os overview: the brief stale row', () => {
  const NO_GOAL = drift(null, { toolCalls: 1, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const planned = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
  const done = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'done' }] })
  const STALE = drift(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const FINISHED = drift(done, { toolCalls: 3, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
  const withDrift = (brief: Brief | null, found: Drift | null): TabState => ({ ...empty({ brief }), drift: found }) as TabState
  const staleRows = (rows: PaneRow[]) => rows.filter(one => rowText(one).includes('brief stale'))

  test('O18 unset, stale and finished each draw one dim row that says why, in plain words', () => {
    const cases: [Drift, Brief | null, RegExp][] = [
      // PR 5 edit (B8): the row is now one WATCH item, `  <text> [steward] <age>`: an indent in front, the source tag and age behind.
      [NO_GOAL, null, /^\s*brief stale: no goal set yet while work started \[steward\] (?:-|now|\d+[mhd])$/],
      [STALE, planned, /^\s*brief stale: 12 tool calls and 1 commit since the brief changed \[steward\] (?:-|now|\d+[mhd])$/],
      [FINISHED, done, /^\s*brief stale: every plan step is done but work continues \[steward\] (?:-|now|\d+[mhd])$/],
    ]
    for (const [found, brief, expected] of cases) {
      const rows = staleRows(tabRows('overview', withDrift(brief, found), NOW, 100, 60))
      expect(rows).toHaveLength(1)
      expect(rowText(rows[0]!)).toMatch(expected)
      expect(rows[0]!.left.every(one => one.tone === 'dim')).toBe(true)
      expect(rows[0]!.right).toBeUndefined()
    }
  })

  // PR 5 edit (B8): the stale brief shows once, in the WATCH block. It no longer sits directly under GOAL (no `ov-stale` row).
  test('O18 the row is in the WATCH block, not under GOAL', () => {
    const rows = tabRows('overview', withDrift(planned, STALE), NOW, 100, 60)
    const keys = rows.map(one => one.key)
    expect(keys).not.toContain('ov-stale')
    expect(keys[keys.indexOf('ov-goal') + 1]).not.toMatch(/stale/)
    const watchAt = rows.findIndex(one => rowText(one).startsWith('WATCH'))
    expect(watchAt).toBeGreaterThan(-1)
    expect(rows.findIndex(one => rowText(one).includes('brief stale'))).toBeGreaterThan(watchAt)
  })

  test('O18 no row when the drift is ok, null or not given', () => {
    const ok: Drift = { level: 'ok', reason: '', key: 'ok@0' }
    expect(all(tabRows('overview', withDrift(planned, ok), NOW, 100, 60))).not.toContain('brief stale')
    expect(all(tabRows('overview', withDrift(planned, null), NOW, 100, 60))).not.toContain('brief stale')
    expect(all(tabRows('overview', empty({ brief: planned }), NOW, 100, 60))).not.toContain('brief stale')
  })

  test('O18 the row stays inside the pane from 20 to 200 columns and still starts with "brief stale"', () => {
    for (const columns of [20, 24, 40, 80, 200]) {
      const rows = tabRows('overview', withDrift(planned, STALE), NOW, columns, 40)
      for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(columns)
      // PR 5 edit: the row is a WATCH item with an indent and a tag. Below 40 columns the tag and age leave room for 7 to 18 characters
      // of text only, so the row starts with "brief" (cut) instead of the whole "brief stale".
      expect(rowText(rows.find(one => rowText(one).includes('brief'))!)).toMatch(columns >= 40 ? /^\s*brief stale/ : /^\s*brief/)
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

// PR 5, the briefing (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to stay on top of").
// Overview draws three blocks, NEEDS YOU, HIGHLIGHTS and WATCH, from the state the tabs already read (brief asks, decisions and
// proofs, the task list, view.prs, drift). The row model is in digest.ts and has its own tests (digest.test.ts); this file does
// not import it, so these tests fail one by one while digest.ts is missing. They read rows only and do not say the old Overview
// rows are gone. Item row shape: `  <text> [<source>] <age>`, age is now, Nm, Nh, Nd or -.
// B1 a block head is missing, renamed or out of order, or sits below the repo / branch / worktree detail in a short pane
// B2 NEEDS YOU drops an ask, its recommendation, or a READY PR as a merge yes, or lists them in the wrong order
// B3 HIGHLIGHTS drops a decision by Dave or a proof
// B4 WATCH drops a done step with no proof
// B5 an item row has no source tag or no age, or a row is wider than the pane, at 20 to 200 columns
// B6 an empty block is not one dim line
// B7 a short pane draws past the budget, or its "+N more" does not count what was left out
// B8 the stale brief shows twice (under GOAL and in WATCH), or not in WATCH
// B9 a secret in an ask, its recommendation or a decision reaches a row
// B10 two briefing rows share a key
describe('os overview: the session briefing (PR 5)', () => {
  const ITEM_END = /\[[a-z][a-z -]*\] (?:now|\d+[mhd]|-)$/
  const HEADS = ['NEEDS YOU', 'HIGHLIGHTS', 'WATCH']
  const headAt = (rows: PaneRow[], title: string): number => rows.findIndex(one => new RegExp(`^${title}\\b`).test(rowText(one)))

  /** The rows of one block: after its head, up to the next block head, or (last block) the first gap or old section row. */
  const blockOf = (rows: PaneRow[], title: string): PaneRow[] => {
    const from = headAt(rows, title)
    if (from < 0) return []
    const later = rows.slice(from + 1)
    const nextHead = later.findIndex((_, i) => HEADS.some(one => headAt([later[i]!], one) === 0))
    const section = later.findIndex(one => /^(?:gap-|ov-|h-|now$)/.test(one.key) && !HEADS.some(name => headAt([one], name) === 0))
    const ends = [nextHead, section].filter(i => i >= 0)
    const stop = ends.length > 0 ? Math.min(...ends) : later.length
    return later.slice(0, stop).filter(one => rowText(one).trim() !== '')
  }
  const itemRows = (block: PaneRow[]): PaneRow[] => block.filter(one => ITEM_END.test(rowText(one)))
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

  test('B1 the three heads are drawn in order, after the chip and GOAL rows and near the top', () => {
    const rows = tabRows('overview', briefed(), NOW, 100, 60)
    const [a, b, c] = HEADS.map(one => headAt(rows, one))
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a!)
    expect(c).toBeGreaterThan(b!)
    expect(rows.findIndex(one => one.key === 'ov-chip')).toBeLessThan(a!)
    expect(rows.findIndex(one => one.key === 'ov-goal')).toBeLessThan(a!)
    expect(a!).toBeLessThanOrEqual(3)
  })

  test('B1 a 10 row pane keeps all three heads, and NEEDS YOU is still near the top', () => {
    const rows = tabRows('overview', briefed(), NOW, 58, 10)
    for (const title of HEADS) expect(headAt(rows, title), title).toBeGreaterThan(-1)
    expect(headAt(rows, 'NEEDS YOU')).toBeLessThanOrEqual(3)
  })

  test('B1 a 10 row pane keeps all three heads when every block holds 3 or more items', () => {
    const asks = Array.from({ length: 3 }, (_, i) => ({ kind: 'question' as const, text: `open question ${i}`, source: 'brief_set' as const }))
    const decisions = Array.from({ length: 3 }, (_, i) => ({ text: `decided ${i}`, by: 'Dave', at: NOW - (i + 1) * 60_000 }))
    const lanes = Array.from({ length: 3 }, (_, i) => ({ id: `peer-${i}`, title: 'peer', state: 'active', mine: false, holder: `session ${i}` }))
    const brief: OsBrief = { sources: {}, plan: [], ask: asks, decisions, proofs: [], updatedAt: NOW - 60_000 }
    const state = { ...empty({ brief, activeAt: NOW }), feed: { lanes } } as TabState
    const full = tabRows('overview', state, NOW, 80, 60)
    for (const title of HEADS) expect(itemRows(blockOf(full, title)).length, title).toBeGreaterThanOrEqual(3)
    for (const rows of [8, 9, 10]) {
      const built = tabRows('overview', state, NOW, 80, rows)
      expect(built.length).toBeLessThanOrEqual(rows)
      for (const title of HEADS) expect(headAt(built, title), `${rows} ${title}`).toBeGreaterThan(-1)
      // The briefing leaves a row for what it cut below it: the detail rows never vanish without a "+N more".
      if (rows === 10) expect(built.at(-1)!.key).toBe('more-overview')
    }
  })

  test('B12 a failed status read of a watched PR (fails) is not drawn as failed checks', () => {
    const state = empty({ view: { ...empty().view, prs: [{ pr: 9, state: 'PENDING', whenReady: false, fails: 2 }] } })
    expect(all(tabRows('overview', state, NOW, 100, 60))).not.toMatch(/checks? failed/i)
  })

  test('B2 NEEDS YOU lists the open ask with its recommendation, the READY PR as a merge yes, then the approval', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'NEEDS YOU').map(rowText)
    const at = (word: string) => list.findIndex(one => one.includes(word))
    expect(list.find(one => one.includes('Which branch should PR 5 start from?'))).toContain('recommend: main at 0ae5f64a')
    expect(list.find(one => one.includes('Create the roles?'))).toContain('recommend: yes, after review')
    const readyRow = list.find(one => one.includes('#194'))
    expect(readyRow).toMatch(/merge yes/i)
    expect(readyRow).toContain('[pr]')
    expect([at('Which branch'), at('#194'), at('Create the roles?')]).toEqual([0, 1, 2])
    expect(list.find(one => one.includes('Which branch'))).toMatch(/\[ask\] 3h$/)
  })

  test('B3 HIGHLIGHTS lists the decision by Dave and the proof, each with its tag and age', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'HIGHLIGHTS').map(rowText)
    const decided = list.find(one => one.includes('Observer only, no deny.'))
    expect(decided).toContain('Dave')
    expect(decided).toMatch(/\[decision\] 3h$/)
    expect(list.find(one => one.includes('one.txt'))).toMatch(/\[proof\] /)
  })

  test('B4 WATCH lists the done step that has no proof, and not the proven one', () => {
    const list = blockOf(tabRows('overview', briefed(), NOW, 100, 60), 'WATCH').map(rowText)
    expect(list.find(one => one.includes('second step'))).toMatch(/unproven/i)
    expect(list.some(one => one.includes('first step'))).toBe(false)
  })

  test('B5 every item row ends with its source tag and age, from 20 to 200 columns, and no row is wider than the pane', () => {
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 1 : 9) {
      const rows = tabRows('overview', briefed(), NOW, columns, 60)
      for (const title of HEADS) {
        const block = blockOf(rows, title)
        expect(itemRows(block).length, `${columns} ${title}`).toBeGreaterThan(0)
        for (const row of block) expect(rowWidth(row), `${columns}: ${rowText(row)}`).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('B6 with nothing to say each block is one dim line: nothing needs you, no highlights yet, nothing to watch', () => {
    const rows = tabRows('overview', empty(), NOW, 100, 60)
    const trimmed = (title: string): string[] => blockOf(rows, title).map(one => rowText(one).trim())
    expect(trimmed('NEEDS YOU')).toEqual(['nothing needs you'])
    expect(trimmed('HIGHLIGHTS')).toEqual(['no highlights yet'])
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

  test('B8 a stale brief shows once, and in WATCH', () => {
    const planned = briefWith({ goal: 'prove the steward', plan: [{ id: 'a', text: 'one', status: 'doing' }] })
    const stale = drift(planned, { toolCalls: 12, commits: 1, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 })
    const rows = tabRows('overview', { ...empty({ brief: planned }), drift: stale } as TabState, NOW, 100, 60)
    expect(rows.filter(one => rowText(one).includes('brief stale'))).toHaveLength(1)
    const watch = blockOf(rows, 'WATCH').map(rowText)
    expect(watch.find(one => one.includes('brief stale'))).toContain(stale.reason)
    expect(watch.find(one => one.includes('brief stale'))).toMatch(/\[steward\] /)
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
})

// PR 5 wiring: the pane feeds the run list and the optional feed to the digest.
// B11 a run list that is fed (agentRuns, feed) never reaches WATCH or HIGHLIGHTS, or a missing one throws
describe('os overview: the briefing reads agentRuns and the feed', () => {
  const MIN = 60_000
  const runs = [
    { id: 'r1', type: 'kraken', description: 'slow build', model: null, effort: null, spec: {}, startedAt: NOW - 25 * MIN, endedAt: null, status: 'running' as const, tokens: 0, costUsd: 0, drift: null },
    { id: 'r2', type: 'scout', description: 'map hooks', model: null, effort: null, spec: {}, startedAt: NOW - 50 * MIN, endedAt: NOW - 40 * MIN, status: 'done' as const, tokens: 0, costUsd: 0, drift: null },
  ]
  const block = (rows: PaneRow[], title: string): string[] => {
    const from = rows.findIndex(one => rowText(one).startsWith(title))
    return rows.slice(from + 1).map(rowText).slice(0, 3)
  }

  test('B11 a run that is live for 25 minutes is in WATCH, a finished one in HIGHLIGHTS, a peer lane and a commit from the feed show, none fed is fine', () => {
    const state = { ...empty(), agentRuns: runs, feed: { commits: [{ sha: 'b8448c3e1f2a', subject: 'fix: scrub', at: NOW - 5 * MIN }], lanes: [{ id: 'sdlc-os', title: 'SDLC', state: 'active', mine: false, holder: 'session 9f2c' }] } } as TabState
    const rows = tabRows('overview', state, NOW, 100, 60)
    expect(block(rows, 'WATCH').join('\n')).toMatch(/slow build running 25m \[agent\] 25m/)
    expect(block(rows, 'WATCH').join('\n')).toMatch(/sdlc-os held by session 9f2c/)
    expect(block(rows, 'HIGHLIGHTS').join('\n')).toMatch(/b8448c3 fix: scrub \[git\] 5m/)
    expect(block(rows, 'HIGHLIGHTS').join('\n')).toMatch(/map hooks finished \[agent\] 40m/)
    expect(() => tabRows('overview', empty(), NOW, 100, 60)).not.toThrow()
  })
})
