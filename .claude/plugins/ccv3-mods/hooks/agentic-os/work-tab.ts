import type { BoardLane } from '../../types'
import { ago, groupSections, line, scrubFit, takeGroups } from './fit-rows'
import type { Section } from './fit-rows'
import { laneOverlap } from './lanes-model'
import type { TabState } from './os-tabs-model'
import { head } from './pane-model'
import type { PaneRow, Span, Tone } from './pane-model'
import { filesSentences, laneSentence, prSentence } from './plain'
import { oneLine, wrapRows } from './text'

// The Work tab (key 4): lanes, other sessions, changes, files and where the session runs. Pure: no engine, no clock (the caller passes `now`), no state.
//   YOUR LANES      the lanes of `board` this session holds (laneSentence), each note dim, at most 3 rows
//   OTHER SESSIONS  every lane another session owns: live sessions first, then stopped ones. "as of <age>" is its own dim row
//                   (the board is read at start, at /os and at a press of this tab, so it can be old). A scope that matches my edited files
//                   reads "may touch the same files": a guess, never a fact. An owner_name on the board adds `held by <name> #sid8`
//                   (`held by #sid8` when the owner has no name); a board with no such field draws today's rows.
//   CHANGES         the watched changes (prSentence)
//   FILES           looked at, changed and saved counts, then the edited paths, dim (only when a file was touched)
//   WHERE           repo, branch and worktree, dim: the technical rows that left the Overview
// A section head stays with the first item under it; what does not fit becomes one `+N more` row. Every row is redacted and cut to the width. Observer only.

const sp = (text: string, tone: Tone): Span => ({ text, tone })

const LINES = 3
const FILES_MAX = 5

type Group = PaneRow[]

const none = (key: string, text: string): Group => [line(key, sp(`  ${text}`, 'dim'))]

/** Sub-rows of a lane, indented 4, dim. */
const note = (key: string, text: string | undefined, columns: number): PaneRow[] =>
  oneLine(text) === '' ? [] : wrapRows(key, [sp('    ', 'dim')], text ?? '', 'dim', columns, LINES, { indent: 4 })

const mineSection = (board: BoardLane[] | null | undefined, columns: number): Section => {
  const yours = (board ?? []).filter(one => one.mine)
  const groups: Group[] = yours.map((one, i) => [
    ...wrapRows(`wk-mine-${i}`, [sp('  ', 'dim')], laneSentence(one), 'todo', columns, LINES),
    ...note(`wk-mine-${i}-note`, one.note, columns),
  ])
  const empty = board == null ? 'lane board not read' : 'no lane held'
  return { head: head('wk-h-mine', 'YOUR LANES'), groups: groups.length > 0 ? groups : [none('wk-mine-none', empty)] }
}

const asOf = (s: TabState, now: number): string => `  as of ${typeof s.boardAt === 'number' && Number.isFinite(s.boardAt) ? ago(now, s.boardAt) : 'last read'}`

const peerGroup = (one: BoardLane, i: number, s: TabState, columns: number): Group => {
  const live = one.live !== false
  const overlap = live ? laneOverlap(one.scope, s.files ?? []) : []
  const details = [
    ...(one.ownerName === undefined || one.owner === null ? [] : [`held by ${one.ownerName === null ? '' : `${one.ownerName} `}#${one.owner}`]),
    ...(live ? [] : ['held by a stopped session']),
    ...(live && one.leaseLapsed === true ? ['lease lapsed, session alive'] : []),
    ...(overlap.length > 0 ? ['may touch the same files'] : []),
  ]
  return [
    ...wrapRows(`wk-peer-${i}`, [sp('  ', 'dim')], laneSentence(one), 'todo', columns, LINES),
    ...details.flatMap((text, j) => note(`wk-peer-${i}-d${j}`, text, columns)),
    ...note(`wk-peer-${i}-note`, one.note, columns),
  ]
}

const othersSection = (s: TabState, now: number, columns: number): Section => {
  const board = s.board
  // A lane nobody owns is not another session. Live sessions first; the order inside each stays the board's.
  const owned = (board ?? []).filter(one => !one.mine && one.owner !== null)
  const peers = [...owned.filter(one => one.live !== false), ...owned.filter(one => one.live === false)]
  const groups = peers.map((one, i) => peerGroup(one, i, s, columns))
  const first: Group[] = board == null ? [] : [[line('wk-asof', sp(asOf(s, now), 'dim'))]]
  const body = groups.length > 0 ? groups : [none('wk-peer-none', board == null ? 'lane board not read' : 'no other session holds a lane')]
  // The as-of row is the first row under the head. groupSections keeps it with the head and the lane rows are a group of their own, so a cut
  // can leave the age with no lane under it: the age still dates the read, and the `+N more` row counts the lanes left out.
  const [lead = [], ...rest] = body
  return { head: head('wk-h-others', 'OTHER SESSIONS'), groups: [[...(first[0] ?? []), ...lead], ...rest] }
}

const changesSection = (s: TabState, columns: number): Section => {
  const groups = s.view.prs.flatMap((one, i) => {
    const said = prSentence({ pr: one.pr, state: one.state })
    return said === null ? [] : [wrapRows(`wk-pr-${i}`, [sp('  ', 'dim')], said.text, said.needsDave ? 'warn' : 'todo', columns, LINES)]
  })
  return { head: head('wk-h-changes', 'CHANGES'), groups: groups.length > 0 ? groups : [none('wk-pr-none', 'no changes watched')] }
}

const filesSection = (s: TabState, columns: number): Section | null => {
  const files = s.files ?? []
  if (files.length === 0) return null
  const edited = files.filter(one => one.state === 'edited')
  const groups: Group[] = [
    ...filesSentences(files).map((one, i) => wrapRows(`wk-files-${i}`, [sp('  ', 'dim')], one, 'todo', columns, 1)),
    ...edited.slice(0, FILES_MAX).map((one, i) => wrapRows(`wk-path-${i}`, [sp('    ', 'dim')], one.path, 'dim', columns, 1)),
  ]
  return groups.length === 0 ? null : { head: head('wk-h-files', 'FILES'), groups }
}

const whereSection = (s: TabState, columns: number): Section => {
  const row = (key: string, label: string, value: string | null): Group =>
    wrapRows(key, [sp(`  ${label.padEnd(9)}`, 'dim')], oneLine(value) === '' ? '-' : (value ?? '-'), 'dim', columns, 1)
  return {
    head: head('wk-h-where', 'WHERE'),
    groups: [row('wk-repo', 'repo', s.repo), row('wk-branch', 'branch', s.branch), row('wk-worktree', 'worktree', s.worktree)],
  }
}

/** The Work tab: `rows` at most, each inside `columns`. A cut ends with one `+N more` row that counts items. */
export const workTab = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const cap = Math.max(1, Math.floor(columns))
  const files = filesSection(s, cap)
  const sections = [mineSection(s.board, cap), othersSection(s, now, cap), changesSection(s, cap), ...(files === null ? [] : [files]), whereSection(s, cap)]
  return takeGroups(groupSections(sections), Math.floor(rows), 'more-work').map(row => scrubFit(row, cap))
}
