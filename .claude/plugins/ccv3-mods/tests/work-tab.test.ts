import { describe, expect, test } from 'claude-code/testing'

import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import { workTab } from '../hooks/agentic-os/work-tab'
import type { BoardLane, FileTouch, PrWatch } from '../types'

// /os redesign, round 2 (tests first): hooks/agentic-os/work-tab.ts, the Work tab (key 4).
//   workTab(s: TabState, now: number, columns: number, rows: number): PaneRow[]
//
// Contract these tests pin (the plan and the task left these holes; the choices are mine and the implementer must follow them or change the test):
//   - Sections, each started by a head row (left[0].tone === 'head', text starts with the name), in this order: YOUR LANES, OTHER SESSIONS,
//     CHANGES, WHERE. (The plan's optional FILES section may sit between CHANGES and WHERE; it is not tested.)
//   - The lane source is `s.board` (BoardLane[], parsed by parseBoard) and only it: YOUR LANES are the `mine` lanes, OTHER SESSIONS the
//     rest. `s.view.lanes` is not read here. `s.board === null` (or undefined) reads `lane board not read` in YOUR LANES; an empty board
//     reads `no lane held` in YOUR LANES and `no other session holds a lane` in OTHER SESSIONS.
//   - YOUR LANES: one row per lane, laneSentence (`You hold lane <id>: <title>`); its note follows on rows indented 4, dim, wrapped to at most
//     3 rows with an ellipsis when cut.
//   - OTHER SESSIONS: only lanes somebody owns (an unowned ready or backlog lane is not here). Lanes whose owner session is alive
//     (`live`) come first, one row each with laneSentence (`Another session holds lane <id>`), then the lanes of a stopped session
//     (`live: false`), worded `held by a stopped session`. A live lane whose lease lapsed reads `lease lapsed, session alive`.
//     A lane whose scope overlaps my edited or committed files (laneOverlap of `scope` and `s.files`) reads `may touch the same files`
//     (a guess, never a fact). A lane group is its sentence row and the rows indented 4 after it.
//   - "as of <age>" is REQUIRED beside a board that was read: TabState.boardAt (epoch ms of the last good read) gives `as of 2m ago` (the
//     Decisions tab's ago form: `just now`, `Nm ago`, `Nh ago`). With boardAt unknown the text still says `as of` (e.g. `as of last read`),
//     never nothing. It is left text (the right group is dropped under 24 columns, and the mark must survive). It is its own dim row:
//     "OTHER SESSIONS as of 2m ago" is 27 cells, too wide for a head row at 20 columns.
//   - CHANGES: prSentence of each watched change (`s.view.prs`), e.g. `Change #194 is approved and checks pass. Say "merge" to land it.`;
//     none reads `no changes watched`.
//   - WHERE: dim rows `repo <name>`, `branch <name>`, `worktree <name>`; a null reads `-`.
//   - Budget: never more than `rows` rows; a cut ends with `+N more`; peer text passes scrub like every row; keys are unique; pure.
//
// Ways the Work tab can fail, one test each:
// K1  board null does not read "lane board not read", or an empty board has no line of its own
// K2  a peer lane whose scope matches an edited file is not marked "may touch the same files", or one that does not match is
// K3  a secret in a peer lane note, scope, title or id reaches a row
// K4  my lanes and peers are mixed up: a peer under YOUR LANES, my lane under OTHER SESSIONS, or an unowned lane listed as a peer
// K5  a lapsed lease on a live peer reads as a dead session (or hides), or a dead session's lane reads as alive
// K6  "as of <age>" is missing beside a board read, wrong, or lost on a narrow pane
// K7  a lane note is not wrapped to 3 rows with an ellipsis, or runs past 3
// K8  CHANGES loses a watched change or its plain sentence, or has no empty line
// K9  WHERE loses repo, branch or worktree, draws them bright, or prints null for an unknown
// K10 a row is wider than the pane (20 to 200 columns), with 5,000-character texts
// K11 the tab draws past its budget, or cuts without a "+N more" row
// K12 two rows share a key
// K13 the live peers do not come before the stopped ones
// K14 a read file counts as overlap

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

const lane = (id: string, over: Partial<BoardLane> = {}): BoardLane => ({ id, title: `title of ${id}`, state: 'active', mine: false, owner: '9f2c0001', live: true, ...over })
const mine = (id: string, over: Partial<BoardLane> = {}): BoardLane => lane(id, { mine: true, owner: 'aaaaaaaa', ...over })
const edited = (path: string): FileTouch => ({ path, state: 'edited', added: 3, removed: 1 })
const pr = (n: number, state: PrWatch['state']): PrWatch => ({ pr: n, state, whenReady: false })

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
const rowWidth = (row: PaneRow): number =>
  row.left.reduce((n, one) => n + one.text.length, 0) + (row.right ? row.right.reduce((n, one) => n + one.text.length, 0) + 1 : 0)
const all = (rows: PaneRow[]): string => rows.map(rowText).join('\n')
const isHead = (row: PaneRow): boolean => row.left[0]?.tone === 'head'
const SECTIONS = ['YOUR LANES', 'OTHER SESSIONS', 'CHANGES', 'WHERE']
const section = (rows: PaneRow[], name: string): PaneRow[] => {
  const from = rows.findIndex(one => isHead(one) && rowText(one).trim().startsWith(name))
  if (from < 0) return []
  const rest = rows.slice(from + 1)
  const stop = rest.findIndex(isHead)
  return (stop < 0 ? rest : rest.slice(0, stop)).filter(one => rowText(one).trim() !== '')
}
/** A group: the row that holds `word` and the rows indented 4 after it. */
const group = (rows: PaneRow[], word: string): PaneRow[] => {
  const at = rows.findIndex(one => rowText(one).includes(word))
  if (at < 0) return []
  const next = rows.slice(at + 1).findIndex(one => !rowText(one).startsWith('    '))
  return rows.slice(at, next < 0 ? undefined : at + 1 + next)
}
const viaTab = (s: TabState, columns: number, rows: number): PaneRow[] => tabRows('work', s, NOW, columns, rows)

const peers = (): TabState =>
  empty({
    files: [edited('hooks/agentic-os/digest.ts')],
    boardAt: NOW - 2 * MIN,
    board: [
      mine('lane-os', { note: 'tabs' }),
      lane('api-core', { scope: 'hooks/agentic-os' }),
      lane('docs-lane', { scope: 'docs/' }),
      lane('late-lane', { leaseLapsed: true }),
      lane('gone-lane', { live: false, leaseLapsed: true }),
      lane('backlog-lane', { state: 'ready', owner: null, live: false }),
    ],
  })

describe('work tab: sections and lane source', () => {
  test('K1 board null reads "lane board not read"; an empty board reads "no lane held" and "no other session holds a lane"', () => {
    const none = workTab(empty({ board: null }), NOW, 80, 40)
    expect(all(section(none, 'YOUR LANES'))).toContain('lane board not read')
    expect(all(none)).not.toMatch(/no lane held/)
    const missing = workTab(empty(), NOW, 80, 40)
    expect(all(section(missing, 'YOUR LANES'))).toContain('lane board not read')
    const blank = workTab(empty({ board: [], boardAt: NOW }), NOW, 80, 40)
    expect(all(section(blank, 'YOUR LANES'))).toContain('no lane held')
    expect(all(section(blank, 'OTHER SESSIONS'))).toMatch(/no other session holds a lane/)
    expect(all(blank)).not.toContain('lane board not read')
  })

  test('K1 the four sections are in this order, each a head row', () => {
    const rows = workTab(peers(), NOW, 80, 60)
    const heads = rows.filter(isHead).map(one => SECTIONS.find(name => rowText(one).trim().startsWith(name)))
    const wanted = heads.filter((name): name is string => name !== undefined)
    expect(wanted).toEqual(SECTIONS)
  })

  test('K4 my lane is under YOUR LANES as "You hold lane <id>: <title>"; peers are under OTHER SESSIONS; the two never mix', () => {
    const rows = workTab(peers(), NOW, 80, 60)
    const yours = all(section(rows, 'YOUR LANES'))
    const others = all(section(rows, 'OTHER SESSIONS'))
    expect(yours).toContain('You hold lane lane-os: title of lane-os')
    expect(yours).not.toMatch(/api-core|docs-lane|late-lane|gone-lane/)
    expect(others).toContain('Another session holds lane api-core')
    expect(others).toContain('Another session holds lane docs-lane')
    expect(others).not.toContain('lane-os')
  })

  test('K4 a lane nobody owns is not an other session', () => {
    const rows = workTab(peers(), NOW, 80, 60)
    expect(all(section(rows, 'OTHER SESSIONS'))).not.toContain('backlog-lane')
  })

  test('K13 the lanes of live sessions come before the lanes of stopped ones', () => {
    const others = section(workTab(peers(), NOW, 80, 60), 'OTHER SESSIONS').map(rowText)
    const at = (word: string): number => others.findIndex(one => one.includes(word))
    expect(at('gone-lane')).toBeGreaterThan(-1)
    for (const live of ['api-core', 'docs-lane', 'late-lane']) expect(at(live), live).toBeLessThan(at('gone-lane'))
  })

  test('K5 a stopped session\'s lane reads "held by a stopped session"; a live peer does not', () => {
    const others = section(workTab(peers(), NOW, 80, 60), 'OTHER SESSIONS')
    expect(all(group(others, 'gone-lane'))).toContain('held by a stopped session')
    expect(all(group(others, 'gone-lane'))).not.toContain('session alive')
    expect(all(group(others, 'api-core'))).not.toContain('stopped session')
  })

  test('K5 a lapsed lease on a live peer reads "lease lapsed, session alive"; a lease that holds does not say it', () => {
    const others = section(workTab(peers(), NOW, 80, 60), 'OTHER SESSIONS')
    expect(all(group(others, 'late-lane'))).toContain('lease lapsed, session alive')
    expect(all(group(others, 'api-core'))).not.toContain('lease lapsed')
  })
})

describe('work tab: overlap and board age', () => {
  test('K2 the peer whose scope matches my edited file reads "may touch the same files"; a peer that does not match does not', () => {
    const others = section(workTab(peers(), NOW, 80, 60), 'OTHER SESSIONS')
    expect(all(group(others, 'api-core'))).toContain('may touch the same files')
    expect(all(group(others, 'docs-lane'))).not.toContain('may touch')
    expect(all(others).match(/may touch the same files/g)).toHaveLength(1)
  })

  test('K14 a file that was only read is not an overlap; a committed one is', () => {
    const read: FileTouch = { path: 'hooks/agentic-os/digest.ts', state: 'read', added: 0, removed: 0 }
    expect(all(workTab({ ...peers(), files: [read] }, NOW, 80, 60))).not.toContain('may touch')
    const committed: FileTouch = { path: 'hooks/agentic-os/digest.ts', state: 'committed', added: 0, removed: 0 }
    expect(all(workTab({ ...peers(), files: [committed] }, NOW, 80, 60))).toContain('may touch the same files')
    expect(all(workTab({ ...peers(), files: [] }, NOW, 80, 60))).not.toContain('may touch')
    expect(all(workTab({ ...peers(), files: undefined }, NOW, 80, 60))).not.toContain('may touch')
  })

  test('K6 the board read time shows as "as of 2m ago", and as "as of just now" at the same moment', () => {
    expect(all(workTab(peers(), NOW, 80, 60))).toContain('as of 2m ago')
    expect(all(workTab({ ...peers(), boardAt: NOW }, NOW, 80, 60))).toContain('as of just now')
    expect(all(workTab({ ...peers(), boardAt: NOW - 3 * 3600_000 }, NOW, 80, 60))).toContain('as of 3h ago')
  })

  test('K6 with an unknown read time the tab still says "as of", never nothing; the age is left text and survives 20 columns', () => {
    expect(all(workTab({ ...peers(), boardAt: null }, NOW, 80, 60))).toMatch(/as of /)
    expect(all(workTab({ ...peers(), boardAt: undefined }, NOW, 80, 60))).toMatch(/as of /)
    for (const columns of [20, 24, 40, 200]) {
      const rows = workTab(peers(), NOW, columns, 60)
      expect(all(rows), String(columns)).toContain('as of 2m ago')
      expect(rows.some(one => rowText(one).includes('as of') && !(one.right ?? []).some(span => span.text.includes('as of'))), String(columns)).toBe(true)
    }
  })

  test('K6 the age moves with the clock: the same board 10 minutes later reads "as of 12m ago"', () => {
    expect(all(workTab(peers(), NOW + 10 * MIN, 80, 60))).toContain('as of 12m ago')
  })
})

describe('work tab: lane notes', () => {
  test('K7 a lane note longer than 3 rows is cut to 3 rows indented 4, dim, the last ending with an ellipsis; a short note is one row', () => {
    const long = empty({ board: [mine('lane-os', { note: WORDS })], boardAt: NOW })
    const rows = workTab(long, NOW, 40, 60)
    const noteRows = group(section(rows, 'YOUR LANES'), 'You hold lane lane-os').slice(1).filter(one => /word\d/.test(rowText(one)))
    expect(noteRows).toHaveLength(3)
    expect(rowText(noteRows[0]!)).toContain('word0 word1')
    expect(rowText(noteRows[2]!)).toMatch(/(?:…|\.\.\.)(?:more.*)?$/)
    for (const row of noteRows) {
      expect(rowText(row)).toMatch(/^ {4}\S/)
      expect(row.left.every(one => one.tone === 'dim')).toBe(true)
      expect(rowWidth(row)).toBeLessThanOrEqual(40)
    }
    const short = group(section(workTab(peers(), NOW, 80, 60), 'YOUR LANES'), 'You hold lane lane-os')
    expect(short.slice(1).filter(one => rowText(one).includes('tabs'))).toHaveLength(1)
  })

  test('K7 a lane with no note has no note row', () => {
    const rows = section(workTab(empty({ board: [mine('lane-os')], boardAt: NOW }), NOW, 80, 60), 'YOUR LANES')
    expect(group(rows, 'You hold lane lane-os')).toHaveLength(1)
  })

  test('K4 my lane in another state reads the glossary sentence, not "You hold"', () => {
    const rows = section(workTab(empty({ board: [mine('lane-a', { state: 'review' }), mine('lane-b', { state: 'blocked' })], boardAt: NOW }), NOW, 80, 60), 'YOUR LANES')
    expect(all(rows)).toContain('Lane lane-a waits for review')
    expect(all(rows)).toContain('Lane lane-b is blocked')
  })
})

describe('work tab: CHANGES and WHERE', () => {
  test('K8 each watched change reads its plain sentence; none reads "no changes watched"', () => {
    const state = empty({ view: { ...empty().view, prs: [pr(194, 'READY'), pr(195, 'PENDING')] } })
    const text = all(section(workTab(state, NOW, 100, 60), 'CHANGES'))
    expect(text).toContain('Change #194 is approved and checks pass. Say "merge" to land it.')
    expect(text).toContain('Waiting for the review of change #195.')
    expect(text).not.toContain('PR #')
    expect(all(section(workTab(empty(), NOW, 100, 60), 'CHANGES'))).toContain('no changes watched')
  })

  test('K8 a long change sentence wraps inside the width', () => {
    const state = empty({ view: { ...empty().view, prs: [pr(194, 'READY')] } })
    for (const row of workTab(state, NOW, 30, 60)) expect(rowWidth(row)).toBeLessThanOrEqual(30)
    expect(all(section(workTab(state, NOW, 30, 60), 'CHANGES')).replace(/\s+/g, ' ')).toContain('Say "merge" to land')
  })

  test('K9 WHERE draws repo, branch and worktree in dim; an unknown value reads "-"', () => {
    const state = empty({ repo: 'continuous-claude', branch: 'feat/x', worktree: 'wt-1' })
    const rows = section(workTab(state, NOW, 100, 60), 'WHERE')
    const text = all(rows)
    expect(text).toMatch(/repo\s+continuous-claude/)
    expect(text).toMatch(/branch\s+feat\/x/)
    expect(text).toMatch(/worktree\s+wt-1/)
    for (const row of rows) expect(row.left.every(one => one.tone === 'dim')).toBe(true)
    const bare = all(section(workTab(empty(), NOW, 100, 60), 'WHERE'))
    expect(bare).toMatch(/repo\s+-/)
    expect(bare).toMatch(/branch\s+-/)
    expect(bare).toMatch(/worktree\s+-/)
    expect(bare).not.toMatch(/null|undefined|NaN/)
  })
})

describe('work tab: budget, width, safety', () => {
  test('K11 the tab never draws more rows than its budget, starts with YOUR LANES, and ends a cut with "+N more"', () => {
    const state = peers()
    state.view.prs = [pr(194, 'READY'), pr(195, 'PENDING'), pr(196, 'REVIEWED')]
    state.repo = 'r'
    state.branch = 'b'
    state.worktree = 'w'
    const full = workTab(state, NOW, 60, 200)
    for (const rows of [1, 2, 3, 4, 5, 6, 8, 10, 14, 20]) {
      const built = workTab(state, NOW, 60, rows)
      expect(built.length, `${rows}`).toBeLessThanOrEqual(rows)
      if (rows >= 4) {
        expect(isHead(built[0]!)).toBe(true)
        expect(rowText(built[0]!).trim()).toMatch(/^YOUR LANES\b/)
        if (full.length > rows) expect(rowText(built.at(-1)!), `${rows}`).toMatch(/^\s*\+\d+ more$/)
      }
    }
    expect(all(workTab(state, NOW, 60, full.length))).not.toMatch(/\+\d+ more/)
  })

  test('K10 no row is wider than the pane from 20 to 200 columns, with 5,000-character texts, direct and through tabRows', () => {
    const huge = 'y'.repeat(5000)
    const state = empty({
      repo: huge,
      branch: huge,
      worktree: huge,
      files: [edited(`hooks/${huge}.ts`)],
      boardAt: NOW - MIN,
      board: [mine('lane-os', { note: huge, title: huge }), lane('api-core', { title: huge, note: huge, scope: 'hooks' }), lane(huge, { live: false })],
      view: { ...empty().view, prs: [pr(194, 'READY')] },
    })
    for (let columns = 20; columns <= 200; columns += columns < 60 ? 3 : 20) {
      for (const row of workTab(state, NOW, columns, 60)) expect(rowWidth(row), `${columns}: ${rowText(row).slice(0, 30)}`).toBeLessThanOrEqual(columns)
      for (const row of viaTab(state, columns, 60)) expect(rowWidth(row), `tab ${columns}`).toBeLessThanOrEqual(columns)
    }
  })

  test('K3 a secret in a peer lane note, scope, title or id, or in my lane, is in no row, whole or cut, at any width', () => {
    const state = empty({
      repo: SECRET,
      branch: SECRET,
      worktree: SECRET,
      files: [edited(`hooks/${SECRET}.ts`)],
      boardAt: NOW - MIN,
      board: [
        mine(`mine-${SECRET}`, { note: SECRET, title: SECRET, scope: SECRET }),
        lane(`peer-${SECRET}`, { note: `n ${SECRET}`, title: SECRET, scope: `hooks/${SECRET}.ts` }),
        lane('stopped', { live: false, note: SECRET, scope: SECRET }),
      ],
    })
    for (const columns of [20, 33, 60, 200]) {
      for (const text of [all(workTab(state, NOW, columns, 60)), all(viaTab(state, columns, 60))]) {
        expect(text, String(columns)).not.toContain('sk-ant')
        expect(text, String(columns)).not.toContain('a'.repeat(12))
      }
    }
  })

  test('K3 a control character or a new line in a lane note draws one line', () => {
    const state = empty({ board: [mine('lane-os', { note: 'first\nsecond\u0007 third\tfourth' }), lane('api-core', { title: 'a\r\nb' })], boardAt: NOW })
    for (const row of workTab(state, NOW, 80, 60)) expect(rowText(row)).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f]/)
  })

  test('K12 no two rows share a key, at 6, 10, 20 and 200 rows and at 20, 40 and 80 columns', () => {
    const state = peers()
    state.board = [...(state.board ?? []), ...Array.from({ length: 8 }, (_, i) => lane(`peer-${i}`, { scope: 'hooks', note: WORDS })), mine('lane-b', { note: WORDS })]
    state.view.prs = [pr(1, 'READY'), pr(2, 'PENDING'), pr(3, 'LIMITED')]
    for (const rows of [6, 10, 20, 200]) {
      for (const columns of [20, 40, 80]) {
        const keys = workTab(state, NOW, columns, rows).map(one => one.key)
        expect(new Set(keys).size, `${rows}x${columns}`).toBe(keys.length)
      }
    }
  })

  test('K12 the same state and clock give the same rows, and a deeply frozen state does not throw', () => {
    const freeze = <T,>(value: T): T => {
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) freeze(inner)
      return Object.freeze(value)
    }
    expect(workTab(freeze(peers()), NOW, 60, 30)).toEqual(workTab(peers(), NOW, 60, 30))
    expect(all(workTab(peers(), NOW + 60 * MIN, 60, 30))).not.toBe(all(workTab(peers(), NOW, 60, 30)))
  })
})
