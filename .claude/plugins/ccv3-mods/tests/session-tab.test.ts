import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import { sessionTab } from '../hooks/agentic-os/session-tab'
import type { AgentRun, FileTouch, OsTask } from '../types'

// /os redesign, round 2 (tests first): hooks/agentic-os/session-tab.ts, the Session tab (key 2).
//   sessionTab(s: TabState, now: number, columns: number, rows: number): PaneRow[]
//
// Contract these tests pin (the plan and the task left these holes; the choices are mine and the implementer must follow them or change the test):
//   - Sections in this order, each started by a head row (left[0].tone === 'head', text starts with the name): STATE, NOW, HELPERS, TIMELINE,
//     ROOM. A section with nothing to say keeps its head and one dim empty-state line.
//   - STATE: a chip row with chipWord (Working, Waiting for you, ...), then `GOAL <goal>` and `STOP AT <stop-at>`, each wrapped to at most 3
//     rows (row 1 carries the label; rows 2 and 3 indent 4; a cut ends with an ellipsis). Unset reads `GOAL not set` and `STOP AT not set`.
//     STOP AT carries ` [parsed]` when brief.sources.stopAt is 'parsed' (it left Overview; the mark moved here).
//   - NOW counts running helpers from either source (both fixtures agree on the count): view.agents and the ledger hold the same number here.
//   - NOW: the in-progress task as `Doing: <activeForm, else subject>` (stepSentence); else `Thinking` while a turn runs; else
//     `N helpers running`; else an idle line (Idle or "nothing running"). The tool name and its label are not NOW.
//   - HELPERS source is `s.agentRuns` (the ledger), not `view.agents`: only the ledger holds start times (the long-run form) and the
//     workflow run ids, and agent.list omits workflow agents. Running runs read helperSentence: `A helper is <description>`, the type when
//     the description is empty, `A helper has run N min: <description>` over 10 minutes. Each workflowRunId group with a running member
//     adds one `A workflow: N helpers done, M running` row (workflowSentence). Finished runs are not here (TIMELINE).
//     Empty: `no helpers yet`.
//   - TIMELINE, newest first, plain words: a finished helper (`A helper finished: x`), a proof (proofSentence: the brief holds no pass count, so `Proof saved for "<subject>"`), a decision by
//     Dave (its text), the keeper line (keeperSentence of s.compactions), and `Saved N files to git` when s.files holds committed files.
//     Empty: `no milestones yet`.
//   - ROOM: roomSentences (Context p% full, Spent $x this session, allowance p%, Cache saving p%), every span dim.
//   - Budget: never more than `rows` rows; when it cuts, the last row is `+N more`; a pane of 4 rows or more keeps the STATE head first.
//   - Every row is redacted, one line, inside `columns` (20 to 200); row keys are unique. Pure: the same state and clock give the same rows.
//
// Ways the Session tab can fail, one test each:
// S1  a running helper shows no purpose, shows the type when it has a description, or ignores the type when the description is empty
// S2  a workflow's helpers are not grouped by workflowRunId (a sentence per helper, or none), or a plain helper reads as a workflow
// S3  the keeper's lost-plan record and the kill rule (3 of 5) are not told in the timeline
// S4  the timeline is not newest first, or a plain-English line is missing (helper, proof, decision, keeper, files saved)
// S5  STATE loses the chip word, the goal, the stop-at or their "not set" lines, or a goal / stop-at longer than 3 rows is not cut to 3 with an ellipsis
// S6  [parsed] is missing on a parsed stop-at, or drawn on a brief_set one or an unset one
// S7  NOW is not the in-progress task, Thinking, or N helpers running, in that order of precedence
// S8  the empty state of a section is blank, or a fully empty session draws no sections
// S9  a row is wider than the pane (20 to 200 columns), a 5,000-character text is not bounded, or a secret reaches a row
// S10 the tab draws more rows than its budget, loses the STATE head, or cuts without a "+N more" row
// S11 two rows share a key
// S12 ROOM loses a field or draws it bright
// S13 long runs, finished runs and runs of a stopped list are mixed up in HELPERS (a finished helper listed as running)

const NOW = 100 * 3600_000
const MIN = 60_000
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const WORDS = Array.from({ length: 40 }, (_, i) => `word${i % 10}`).join(' ')

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

const briefWith = (raw: Record<string, unknown>, tasks: OsTask[] = [], at = NOW - 1000): Brief => {
  const made = applyBrief(null, raw, tasks, at)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

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

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
const all = (rows: PaneRow[]): string => rows.map(rowText).join('\n')
const isHead = (row: PaneRow): boolean => row.left[0]?.tone === 'head'
const SECTIONS = ['STATE', 'NOW', 'HELPERS', 'TIMELINE', 'ROOM']
/** The rows of one section: after its head, up to the next head. */
const section = (rows: PaneRow[], name: string): PaneRow[] => {
  const from = rows.findIndex(one => isHead(one) && rowText(one).trim().startsWith(name))
  if (from < 0) return []
  const rest = rows.slice(from + 1)
  const stop = rest.findIndex(isHead)
  return (stop < 0 ? rest : rest.slice(0, stop)).filter(one => rowText(one).trim() !== '')
}
/** A labelled entry (GOAL, STOP AT): its first row and the indented rows after it. */
const entry = (rows: PaneRow[], label: string): PaneRow[] => {
  const at = rows.findIndex(one => rowText(one).trimStart().startsWith(label))
  if (at < 0) return []
  const next = rows.slice(at + 1).findIndex(one => !rowText(one).startsWith('    '))
  return rows.slice(at, next < 0 ? undefined : at + 1 + next)
}
const viaTab = (s: TabState, columns: number, rows: number): PaneRow[] => tabRows('session', s, NOW, columns, rows)

const rich = (): TabState =>
  empty({
    chip: 'working',
    brief: briefWith({ goal: 'prove the pane tabs', stopAt: 'tests green, no commit', decision: { text: 'Observer only, no deny.', by: 'Dave' } }, [], NOW - 20 * MIN),
    costUsd: 1.84,
    cachePct: 73,
    limits: [{ kind: 'five_hour', percentUsed: 62 }],
    view: { ...empty().view, ctx: 41, turn: { id: 't1', startedAt: NOW - 70_000 } },
    agentRuns: [run('r1', 'running', 12 * MIN, { description: 'map hooks' }), run('r2', 'done', 40 * MIN, { description: 'old review' })],
    compactions: [{ at: NOW - 3 * MIN, sessionId: 's1', open: 3, total: 7, kept: true }],
    files: [{ path: 'hooks/a.ts', state: 'committed', added: 2, removed: 0 }, { path: 'hooks/b.ts', state: 'committed', added: 1, removed: 1 }],
  })

describe('session tab: STATE', () => {
  test('S5 the chip word, GOAL and STOP AT are the first section; every chip reads its glossary word', () => {
    const rows = sessionTab(rich(), NOW, 80, 40)
    expect(isHead(rows[0]!)).toBe(true)
    expect(rowText(rows[0]!).trim()).toMatch(/^STATE\b/)
    const state = section(rows, 'STATE').map(rowText).join('\n')
    expect(state).toContain('Working')
    expect(state).toContain('GOAL prove the pane tabs')
    expect(state).toContain('STOP AT tests green, no commit')
    const words: Record<TabState['chip'], string> = {
      working: 'Working',
      'waiting-on-dave': 'Waiting for you',
      'waiting-on-work': 'Waiting on background tasks',
      blocked: 'Stuck: a step cannot go on',
      done: 'Done: every step is proven',
      idle: 'Resting',
    }
    for (const chip of Object.keys(words) as TabState['chip'][]) expect(all(section(sessionTab({ ...rich(), chip }, NOW, 80, 40), 'STATE')), chip).toContain(words[chip])
  })

  test('S5 an unset goal and stop-at read "not set"; the goal one is amber', () => {
    const rows = sessionTab(empty(), NOW, 80, 40)
    const state = section(rows, 'STATE')
    expect(all(state)).toContain('GOAL not set')
    expect(all(state)).toContain('STOP AT not set')
    expect(rows.flatMap(one => one.left).find(one => one.text.includes('not set'))?.tone).toBe('warn')
  })

  test('S5 a goal and a stop-at longer than 3 rows are cut to 3 rows each, the last ending with an ellipsis; a short one is one row', () => {
    const brief = briefWith({ goal: WORDS, stopAt: WORDS })
    const rows = sessionTab(empty({ brief }), NOW, 40, 60)
    for (const label of ['GOAL', 'STOP AT']) {
      const group = entry(rows, label)
      expect(group, label).toHaveLength(3)
      expect(rowText(group[0]!)).toContain(`${label} word0 word1`)
      expect(rowText(group[2]!), label).toMatch(/(?:…|\.\.\.)(?:more.*)?$/)
      for (const row of group) expect(rowWidth(row)).toBeLessThanOrEqual(40)
    }
    expect(entry(sessionTab(rich(), NOW, 80, 40), 'GOAL')).toHaveLength(1)
  })

  test('S6 [parsed] marks a parsed stop-at only', () => {
    const base = { goal: 'ship tabs', stopAt: 'tests green' }
    const parsed: Brief = { ...briefWith(base), sources: { goal: 'parsed', stopAt: 'parsed' } }
    const set: Brief = { ...briefWith(base), sources: { goal: 'brief_set', stopAt: 'brief_set' } }
    const only: Brief = { ...briefWith(base), sources: { goal: 'parsed', stopAt: 'brief_set' } }
    expect(all(entry(sessionTab(empty({ brief: parsed }), NOW, 80, 40), 'STOP AT'))).toContain('STOP AT tests green [parsed]')
    expect(all(entry(sessionTab(empty({ brief: set }), NOW, 80, 40), 'STOP AT'))).not.toContain('[parsed]')
    expect(all(entry(sessionTab(empty({ brief: only }), NOW, 80, 40), 'STOP AT'))).not.toContain('[parsed]')
    const unset: Brief = { ...parsed, stopAt: undefined }
    expect(all(sessionTab(empty({ brief: unset }), NOW, 80, 40))).not.toContain('[parsed]')
  })
})

describe('session tab: NOW', () => {
  const tasks: OsTask[] = [{ id: '1', subject: 'third step', status: 'in_progress' }, { id: '2', subject: 'fourth step', status: 'pending' }]
  const now = (s: TabState): string => all(section(sessionTab(s, NOW, 80, 40), 'NOW'))

  test('S7 an in-progress task reads "Doing: <activeForm, else subject>" and beats a running turn', () => {
    const turn = { id: 't', startedAt: NOW - 5000 }
    expect(now(empty({ view: { ...empty().view, tasks, turn } }))).toContain('Doing: third step')
    const form: OsTask[] = [{ id: '1', subject: 'third step', status: 'in_progress', activeForm: 'Wiring the pane' }]
    expect(now(empty({ view: { ...empty().view, tasks: form, turn } }))).toContain('Doing: Wiring the pane')
    expect(now(empty({ view: { ...empty().view, tasks, turn } }))).not.toContain('Thinking')
  })

  test('S7 with no task in progress a running turn reads Thinking, then running helpers read "N helpers running", then idle', () => {
    const turn = { id: 't', startedAt: NOW - 5000 }
    expect(now(empty({ view: { ...empty().view, turn }, agentRuns: [run('r1', 'running', MIN)] }))).toContain('Thinking')
    const two = empty({ view: { ...empty().view, agents: [{ id: 'a', description: 'x', type: 'scout', status: 'running' }, { id: 'b', description: 'y', type: 'scout', status: 'running' }] }, agentRuns: [run('r1', 'running', MIN), run('r2', 'running', MIN)] })
    expect(now(two)).toContain('2 helpers running')
    expect(now(empty())).toMatch(/Resting|nothing running/)
    expect(now(empty())).not.toMatch(/Thinking|helpers running/)
  })
})

describe('session tab: HELPERS', () => {
  const helpers = (s: TabState): string => all(section(sessionTab(s, NOW, 80, 60), 'HELPERS'))

  test('S1 a running helper reads "A helper is <description>"; with an empty description it reads the type', () => {
    expect(helpers(empty({ agentRuns: [run('r1', 'running', 3 * MIN, { description: 'map hooks', type: 'scout' })] }))).toContain('A helper is map hooks')
    expect(helpers(empty({ agentRuns: [run('r1', 'running', 3 * MIN, { description: 'map hooks', type: 'scout' })] }))).not.toContain('scout')
    expect(helpers(empty({ agentRuns: [run('r2', 'running', 3 * MIN, { description: '', type: 'kraken' })] }))).toContain('A helper is kraken')
  })

  test('S13 a helper over 10 minutes reads how long it ran; one at 5 minutes does not; a finished one is not listed', () => {
    const text = helpers(empty({ agentRuns: [run('long', 'running', 12 * MIN, { description: 'slow build' }), run('quick', 'running', 5 * MIN, { description: 'fast lint' }), run('gone', 'done', 30 * MIN, { description: 'old review' })] }))
    expect(text).toContain('A helper has run 12 min: slow build')
    expect(text).toContain('A helper is fast lint')
    expect(text).not.toContain('old review')
    expect(text).not.toMatch(/A helper is slow build/)
  })

  test('S2 the helpers of one workflow run read as ONE row "A workflow: 2 helpers done, 1 running"; a plain helper is not a workflow', () => {
    const wf = (id: string, status: AgentRun['status']) => run(id, status, 20 * MIN, { workflowRunId: 'wf_1', description: `step ${id}` })
    const s = empty({ agentRuns: [wf('w1', 'done'), wf('w2', 'done'), wf('w3', 'running'), run('solo', 'running', MIN, { description: 'lone job' })] })
    const rows = section(sessionTab(s, NOW, 80, 60), 'HELPERS')
    expect(rows.filter(one => rowText(one).includes('A workflow: 2 helpers done, 1 running'))).toHaveLength(1)
    expect(rows.filter(one => /A workflow/.test(rowText(one)))).toHaveLength(1)
    expect(all(rows)).toContain('A helper is lone job')
    const two = empty({
      agentRuns: [wf('w1', 'running'), { ...wf('x1', 'done'), workflowRunId: 'wf_2' }, { ...wf('x2', 'running'), workflowRunId: 'wf_2' }],
    })
    const sentences = section(sessionTab(two, NOW, 80, 60), 'HELPERS').map(rowText).filter(one => /A workflow/.test(one))
    expect(sentences).toHaveLength(2)
    expect(sentences.join('\n')).toContain('0 helpers done, 1 running')
    expect(sentences.join('\n')).toContain('1 helper done, 1 running')
  })

  test('S8 no helper reads "no helpers yet"', () => {
    expect(helpers(empty())).toContain('no helpers yet')
    expect(helpers(rich())).not.toContain('no helpers yet')
  })
})

describe('session tab: TIMELINE', () => {
  const timeline = (s: TabState): PaneRow[] => section(sessionTab(s, NOW, 100, 60), 'TIMELINE')

  test('S4 the milestones read newest first: keeper line, proof, finished helper, decision', () => {
    const brief = briefWith(
      { decision: { text: 'Observer only, no deny.', by: 'Dave' }, proof: { taskId: '1', artifact: 'cache/e2e/one.txt' } },
      [{ id: '1', subject: 'validate-mods', status: 'completed' }],
      NOW - 20 * MIN,
    )
    // The proof is stamped 5 minutes ago and the decision 20 minutes ago: set the proof time by a later write.
    const stamped: Brief = { ...brief, proofs: brief.proofs.map(one => ({ ...one, at: NOW - 5 * MIN })), decisions: brief.decisions.map(one => ({ ...one, at: NOW - 20 * MIN })) }
    const s = empty({
      brief: stamped,
      view: { ...empty().view, tasks: [{ id: '1', subject: 'validate-mods', status: 'completed' }] },
      agentRuns: [run('r2', 'done', 15 * MIN, { description: 'map hooks', endedAt: NOW - 10 * MIN })],
      compactions: [{ at: NOW - 1 * MIN, sessionId: 's1', open: 1, total: 2, kept: true }],
    })
    const text = timeline(s).map(rowText)
    const at = (word: string): number => text.findIndex(one => one.includes(word))
    expect([at('The last summary kept the plan.'), at('validate-mods'), at('A helper finished: map hooks'), at('Observer only, no deny.')].every(i => i >= 0)).toBe(true)
    expect(at('The last summary kept the plan.')).toBeLessThan(at('validate-mods'))
    expect(at('validate-mods')).toBeLessThan(at('A helper finished: map hooks'))
    expect(at('A helper finished: map hooks')).toBeLessThan(at('Observer only, no deny.'))
    expect(text.join('\n')).toContain('Proof saved for "validate-mods"')
  })

  test('S4 files saved to git read "Saved 2 files to git"; read and edited files do not', () => {
    expect(all(timeline(rich()))).toContain('Saved 2 files to git')
    const edited: FileTouch[] = [{ path: 'a.ts', state: 'edited', added: 1, removed: 0 }, { path: 'b.ts', state: 'read', added: 0, removed: 0 }]
    expect(all(timeline({ ...rich(), files: edited }))).not.toContain('Saved')
  })

  test('S3 a record that lost the plan reads "The last summary lost the plan."; 3 of the newest 5 lost read the kill line', () => {
    const rec = (ago: number, kept: boolean) => ({ at: NOW - ago * MIN, sessionId: 's1', open: 1, total: 2, kept })
    expect(all(timeline(empty({ compactions: [rec(1, false)] })))).toContain('The last summary lost the plan.')
    const kill = empty({ compactions: [rec(1, true), rec(2, false), rec(3, true), rec(4, false), rec(5, false)] })
    expect(all(timeline(kill))).toContain('The plan keeper failed 3 of 5 times. Consider removing it.')
    const fine = empty({ compactions: [rec(1, true), rec(2, false), rec(3, true), rec(4, true), rec(5, false)] })
    expect(all(timeline(fine))).not.toMatch(/plan keeper failed/)
    expect(all(timeline(fine))).toContain('The last summary kept the plan.')
  })

  test('S8 an empty timeline reads "no milestones yet"', () => {
    expect(all(timeline(empty()))).toContain('no milestones yet')
    expect(all(timeline(rich()))).not.toContain('no milestones yet')
  })
})

describe('session tab: ROOM', () => {
  test('S12 ROOM reads the room sentences in dim', () => {
    const rows = section(sessionTab(rich(), NOW, 100, 60), 'ROOM')
    const text = all(rows)
    expect(text).toContain('Context 41% full')
    expect(text).toContain('Spent $1.84 this session')
    expect(text).toContain('62% of the 5-hour allowance used')
    expect(text).toContain('Cache saving 73%')
    for (const row of rows) expect(row.left.every(one => one.tone === 'dim' || one.text.trim() === '')).toBe(true)
  })

  test('S12 a field that is not known is left out, and nothing reads NaN or null', () => {
    const text = all(section(sessionTab(empty(), NOW, 100, 60), 'ROOM'))
    expect(text).not.toMatch(/Spent|Cache saving|allowance|NaN|null|undefined/)
  })
})

describe('session tab: empty, budget, width, safety', () => {
  test('S8 a fully empty session still draws the five sections in order, each with a line', () => {
    const rows = sessionTab(empty(), NOW, 80, 60)
    const heads = rows.filter(isHead).map(one => rowText(one).trim().split(/\s/)[0])
    expect(heads).toEqual(SECTIONS)
    for (const name of SECTIONS.slice(0, 4)) expect(section(rows, name).length, name).toBeGreaterThan(0)
  })

  test('S10 the tab never draws more rows than its budget, keeps the STATE head first, and ends a cut with "+N more"', () => {
    const crowded = rich()
    crowded.agentRuns = Array.from({ length: 6 }, (_, i) => run(`h${i}`, 'running', (i + 1) * MIN, { description: `job ${i}` }))
    const full = sessionTab(crowded, NOW, 60, 200)
    for (const rows of [1, 2, 3, 4, 5, 6, 8, 10, 12, 20]) {
      const built = sessionTab(crowded, NOW, 60, rows)
      expect(built.length, `${rows}`).toBeLessThanOrEqual(rows)
      if (rows >= 4) {
        expect(isHead(built[0]!)).toBe(true)
        expect(rowText(built[0]!).trim()).toMatch(/^STATE\b/)
      }
      if (rows >= 4 && full.length > rows) expect(rowText(built.at(-1)!), `${rows}`).toMatch(/^\s*\+\d+ more$/)
    }
    expect(sessionTab(crowded, NOW, 60, full.length)).toHaveLength(full.length)
    expect(all(sessionTab(crowded, NOW, 60, full.length))).not.toMatch(/\+\d+ more/)
  })

  test('S9 no row is wider than the pane from 20 to 200 columns, with 5,000-character texts, direct and through tabRows', () => {
    const huge = 'y'.repeat(5000)
    // Built by hand: brief_set caps a goal at 240 characters, but a snapshot or a parsed answer can hold more.
    const brief: Brief = {
      goal: huge,
      stopAt: huge,
      sources: {},
      plan: [],
      ask: [],
      decisions: [{ text: huge, by: 'Dave', at: NOW - MIN }],
      proofs: [{ id: 'p', artifact: huge, at: NOW - MIN, subject: huge, kind: 'plan' }],
      updatedAt: NOW - MIN,
    }
    const s = empty({
      brief,
      repo: huge,
      agentRuns: [run('r1', 'running', 12 * MIN, { description: huge }), run('r2', 'done', 30 * MIN, { description: huge, type: huge })],
      files: [{ path: huge, state: 'committed', added: 1, removed: 0 }],
    })
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 3 : 20) {
      for (const row of sessionTab(s, NOW, columns, 60)) expect(rowWidth(row), `${columns}: ${rowText(row).slice(0, 30)}`).toBeLessThanOrEqual(columns)
      for (const row of viaTab(s, columns, 60)) expect(rowWidth(row), `tab ${columns}`).toBeLessThanOrEqual(columns)
    }
  })

  test('S9 a secret in any source is in no row, whole or cut, at any width', () => {
    const brief = briefWith({ goal: `ship ${SECRET}`, stopAt: `stop ${SECRET}`, decision: { text: `chose ${SECRET}`, by: 'Dave' } })
    const s = empty({
      brief,
      agentRuns: [run('r1', 'running', 12 * MIN, { description: SECRET, type: SECRET }), run('r2', 'done', 30 * MIN, { description: `x ${SECRET}` })],
      files: [{ path: `src/${SECRET}.ts`, state: 'committed', added: 1, removed: 0 }],
      view: { ...empty().view, tasks: [{ id: '1', subject: `do ${SECRET}`, status: 'in_progress' }] },
    })
    for (const columns of [20, 33, 60, 200]) {
      for (const text of [all(sessionTab(s, NOW, columns, 60)), all(viaTab(s, columns, 60))]) {
        expect(text, String(columns)).not.toContain('sk-ant')
        expect(text, String(columns)).not.toContain('a'.repeat(12))
      }
    }
  })

  test('S9 a control character or a new line in a source draws one line', () => {
    const brief = briefWith({ goal: 'first\nsecond\u0007 third', stopAt: 'a\r\nb' })
    const s = empty({ brief, agentRuns: [run('r1', 'running', MIN, { description: 'two\nlines\tand tab' })] })
    for (const row of sessionTab(s, NOW, 80, 60)) expect(rowText(row)).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f]/)
  })

  test('S11 no two rows share a key, at 6, 10, 20 and 200 rows and at 20, 40 and 80 columns', () => {
    const s = rich()
    s.agentRuns = Array.from({ length: 8 }, (_, i) => run(`h${i}`, i < 5 ? 'running' : 'done', (i + 1) * 3 * MIN, { description: WORDS }))
    s.brief = briefWith({ goal: WORDS, stopAt: WORDS, decision: { text: WORDS, by: 'Dave' } })
    for (const rows of [6, 10, 20, 200]) {
      for (const columns of [20, 40, 80]) {
        const keys = sessionTab(s, NOW, columns, rows).map(one => one.key)
        expect(new Set(keys).size, `${rows}x${columns}`).toBe(keys.length)
      }
    }
  })

  test('S11 the same state and clock give the same rows, and a deeply frozen state does not throw', () => {
    const freeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) freeze(inner)
      return Object.freeze(value)
    }
    const s = freeze(rich())
    expect(sessionTab(s, NOW, 60, 30)).toEqual(sessionTab(rich(), NOW, 60, 30))
    expect(all(sessionTab(rich(), NOW + 60 * MIN, 60, 30))).not.toBe(all(sessionTab(rich(), NOW, 60, 30)))
  })
})
