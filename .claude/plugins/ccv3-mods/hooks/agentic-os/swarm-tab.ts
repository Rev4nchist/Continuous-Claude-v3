import type { AgentRun } from '../../types'
import { tierTone } from '../agent-ledger/model'
import { tierBadge } from '../shared/tiers'
import { groupSections, line, scrubFit, takeGroups } from './fit-rows'
import type { Section } from './fit-rows'
import { elapsed } from './model'
import type { TabState } from './os-tabs-model'
import { head } from './pane-model'
import type { PaneRow, Span, Tone } from './pane-model'
import { purposeOf, swarmRunSentence } from './plain'
import { WORDS } from './tab-words'
import { oneLine, wrapRows } from './text'
import { swarmGroups } from './workflow-model'
import type { SwarmFlow, WorkflowFeed } from './workflow-model'

// The Swarm tab (key 7): every helper of this session, one line each. Pure: no engine, no clock (the caller passes `now`), no state.
//   SWARM     the header: running, done and failed helpers of the whole ledger, dim
//   <run>     one row per workflow run (counts, then the phase and the name when a feed gives them) and the elapsed time of the run;
//             under it one row per helper: running first, then failed, then done. A finished run with no failure draws its run row only
//   HELPERS   the runs with no workflow run id, in the same order
// A helper row ends with its tier badge and elapsed time. The badge needs 60 columns, the time 24; under 24 neither is drawn. When the rows
// do not fit, the done helpers of each section fold into one `✓ N done` row; what still does not fit becomes one `+N more` row. The header
// is never cut. A cut text ends with a bare ellipsis: this tab is the home of every helper, so there is no other tab to name. The feed
// (`feed.workflows`) is optional: with none, no phase and no name are drawn, never a guess. Every row is redacted and cut to the width.
// Observer only.

const sp = (text: string, tone: Tone): Span => ({ text, tone })

const BADGE_MIN = 60
const TIME_MIN = 24

type Group = PaneRow[]

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** An own property of a record, or undefined. A key such as `constructor` or `toString` is never taken from the prototype. */
const own = (record: unknown, key: string): unknown =>
  typeof record === 'object' && record !== null && Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined

const markOf = (status: unknown): Span =>
  status === 'running' ? sp('● ', 'active') : status === 'failed' ? sp('✗ ', 'bad') : status === 'done' ? sp('✓ ', 'done') : sp('· ', 'dim')

/** m:ss between two times; null when one is not a number. */
const between = (from: unknown, to: unknown): string | null => (known(from) && known(to) ? elapsed(to - from) : null)

const timeOf = (run: AgentRun, now: number): string | null => between(run.startedAt, run.status === 'running' ? now : run.endedAt ?? now)

/** The tier badge, drift and Haiku in the bad tone; a model not known yet is a dim ellipsis. Redacted before the cut. */
const badgeOf = (run: AgentRun): Span => {
  if (typeof run.model !== 'string') return sp('…', 'dim')
  return sp(oneLine(tierBadge(run.model, typeof run.effort === 'string' ? run.effort : undefined)), run.drift ? 'bad' : tierTone(run.model))
}

/** The right group: badge and time from 60 columns, the time alone from 24, nothing under 24. */
const rightGroup = (columns: number, time: string | null, badge?: Span): Span[] | undefined => {
  if (columns < TIME_MIN) return undefined
  const lead = badge !== undefined && columns >= BADGE_MIN ? [badge] : []
  const spans = [...lead, ...(time === null ? [] : [sp(lead.length > 0 ? `  ${time}` : time, 'dim')])]
  return spans.length > 0 ? spans : undefined
}

/** One line: the lead, the text cut to the room the right group leaves, and the right group when the pane keeps it. */
const oneRow = (key: string, lead: Span[], text: string, tone: Tone, columns: number, right: Span[] | undefined): PaneRow =>
  wrapRows(key, lead, text, tone, columns, 1, right === undefined ? {} : { right })[0] ?? line(key, ...lead)

const agentRow = (key: string, run: AgentRun, label: string, now: number, columns: number): PaneRow =>
  oneRow(key, [sp('    ', 'dim'), markOf(run.status)], label === '' ? purposeOf(run) : label, run.status === 'running' || run.status === 'failed' ? 'todo' : 'dim', columns, rightGroup(columns, timeOf(run, now), badgeOf(run)))

const foldRow = (key: string, done: number): PaneRow => line(key, sp('    ', 'dim'), sp(`✓ ${done} done`, 'done'))

/** What one section draws of its helpers: the rows, and how many done helpers a fold row stands for. */
type Slice = { agents: AgentRun[]; folded: number }

const sliceOf = (visible: AgentRun[], fold: boolean): Slice =>
  fold ? { agents: visible.filter(run => run.status !== 'done'), folded: visible.filter(run => run.status === 'done').length } : { agents: visible, folded: 0 }

const sizeOf = (slice: Slice): number => slice.agents.length + (slice.folded > 0 ? 1 : 0)

/** A running workflow draws every helper; a finished one only the failed ones, so a clean run is one row. */
const flowSlice = (flow: SwarmFlow, fold: boolean): Slice =>
  flow.progress.running > 0 ? sliceOf(flow.runs, fold) : { agents: flow.runs.filter(run => run.status === 'failed'), folded: 0 }

const labelOf = (feed: WorkflowFeed | undefined, run: AgentRun): string => {
  const label = feed === undefined ? undefined : own(feed.labels, run.id)
  return typeof label === 'string' ? oneLine(label) : ''
}

/**
 * The phase of a run: the highest phase of its running helpers (the ledger decides what is running), else the highest seen, else the feed's own.
 * The feed gives the total and the title of its own phase only: another phase has no title here.
 */
const phaseOf = (flow: SwarmFlow, feed: WorkflowFeed): WorkflowFeed['phase'] => {
  const phases = (runs: AgentRun[]): number[] => runs.map(run => own(feed.agentPhases, run.id)).filter(known)
  const live = phases(flow.runs.filter(run => run.status === 'running'))
  const seen = live.length > 0 ? live : phases(flow.runs)
  const base = feed.phase ?? null
  if (seen.length === 0) return base
  const index = seen.reduce((top, one) => Math.max(top, one))
  return { index, total: base?.total ?? null, title: base !== null && base.index === index ? base.title : null }
}

const runRow = (i: number, flow: SwarmFlow, feed: WorkflowFeed | undefined, now: number, columns: number): PaneRow => {
  const p = flow.progress
  const mark = p.running > 0 ? sp('● ', 'active') : p.failed > 0 ? sp('✗ ', 'bad') : sp('✓ ', 'done')
  const said = swarmRunSentence(p, feed === undefined ? null : { name: feed.name, phase: phaseOf(flow, feed) })
  const time = between(p.startedAt, p.running > 0 ? now : p.latestAt)
  return oneRow(`sw-wf-${i}`, [sp('  ', 'dim'), mark], said, 'todo', columns, rightGroup(columns, time))
}

/** A section with no item still draws its head: groupSections keeps a head over an empty first group, and drops a section with no group. */
const sectionOf = (headRow: PaneRow, groups: Group[]): Section => ({ head: headRow, groups: groups.length > 0 ? groups : [[]] })

const flowSection = (i: number, flow: SwarmFlow, feed: WorkflowFeed | undefined, slice: Slice, now: number, columns: number): Section =>
  sectionOf(runRow(i, flow, feed, now, columns), [
    ...slice.agents.map((run, j): Group => [agentRow(`sw-wf-${i}-a${j}`, run, labelOf(feed, run), now, columns)]),
    ...(slice.folded > 0 ? [[foldRow(`sw-wf-${i}-done`, slice.folded)]] : []),
  ])

const helpersSection = (slice: Slice, now: number, columns: number): Section =>
  sectionOf(head('sw-h-helpers', 'HELPERS'), [
    ...slice.agents.map((run, j): Group => [agentRow(`sw-hp-${j}`, run, '', now, columns)]),
    ...(slice.folded > 0 ? [[foldRow('sw-hp-done', slice.folded)]] : []),
  ])

/** The header: SWARM, and the running, done and failed helpers of the whole ledger on the right. Nothing on the right with no helper. */
const headerSection = (runs: AgentRun[]): Section => {
  const count = (status: AgentRun['status']): number => runs.filter(run => run.status === status).length
  const failed = count('failed')
  const counts = `${count('running')} running · ${count('done')} done${failed > 0 ? ` · ${failed} failed` : ''}`
  return sectionOf(
    head('sw-h', WORDS.swarm.head, runs.length > 0 ? [sp(counts, 'dim')] : undefined),
    runs.length === 0 ? [[line('sw-none', sp(`  ${WORDS.swarm.none}`, 'dim'))]] : [],
  )
}

/** A pane this short cannot hold the header, a head, an item and a `+N more` row. The cut then counts single rows and leaves HELPERS out, so an item still shows. */
const LEAN_MAX = 3

const lean = (sections: Section[]): Group[] =>
  sections.flatMap(section => [...(section.head.key === 'sw-h-helpers' ? [] : [section.head]), ...section.groups.flat()].map((row): Group => [row]))

const feedsOf = (s: TabState): Map<string, WorkflowFeed> => {
  const list: unknown = s.feed?.workflows
  const feeds = new Map<string, WorkflowFeed>()
  for (const feed of Array.isArray(list) ? (list as WorkflowFeed[]) : []) {
    if (typeof feed?.runId === 'string' && !feeds.has(feed.runId)) feeds.set(feed.runId, feed)
  }
  return feeds
}

/** The Swarm tab: `rows` at most, each inside `columns`. A cut ends with one `+N more` row that counts items. */
export const swarmTab = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const budget = Math.floor(rows)
  if (!(budget > 0)) return []
  const cap = Math.max(1, Math.floor(columns))
  const runs = Array.isArray(s.agentRuns) ? s.agentRuns : []
  const { flows, helpers } = swarmGroups(runs)
  const feeds = feedsOf(s)
  const header = headerSection(runs)
  // The size of a layout is counted before any row is built: 2,000 runs must not cost 2,000 redactions to learn that they do not fit.
  const size = (fold: boolean): number =>
    1 + (runs.length === 0 ? 1 : 0) + flows.reduce((n, flow) => n + 1 + sizeOf(flowSlice(flow, fold)), 0) + (helpers.length > 0 ? 1 + sizeOf(sliceOf(helpers, fold)) : 0)
  const fold = size(false) > budget
  const sections = [
    header,
    ...flows.map((flow, i) => flowSection(i, flow, feeds.get(flow.progress.key), flowSlice(flow, fold), now, cap)),
    ...(helpers.length > 0 ? [helpersSection(sliceOf(helpers, fold), now, cap)] : []),
  ]
  // One row: the header alone. A longer cut keeps it as the first group.
  const groups = size(fold) > budget && budget <= LEAN_MAX ? lean(sections) : groupSections(sections)
  const cut = budget === 1 ? [header.head] : takeGroups(groups, budget, 'more-swarm')
  return cut.map(row => scrubFit(row, cap))
}
