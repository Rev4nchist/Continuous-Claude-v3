import { CHIP } from './band-model'
import { groupSections, line, scrubFit, shortAge, takeGroups } from './fit-rows'
import type { Section } from './fit-rows'
import type { TabState } from './os-tabs-model'
import { head } from './pane-model'
import type { PaneRow, Span, Tone } from './pane-model'
import { chipWord, filesSentences, helperSentence, keeperSentence, newestKeeper, proofSentence, roomSentences, stepSentence, workflowSentence } from './plain'
import { oneLine, wrapRows } from './text'
import { workflowProgress } from './workflow-model'

// The Session tab (key 2): what this session is doing now, in plain words. Pure: no engine, no clock (the caller passes `now`), no state.
//   STATE     the chip word, GOAL and STOP AT (each at most 3 rows)
//   NOW       the in-progress task, else Thinking, else N helpers running, else idle
//   HELPERS   the running helper runs of the ledger (`agentRuns`), then one row per workflow that has a running helper
//   TIMELINE  milestones, newest first: the keeper line, proofs, finished helpers, Dave's decisions, files saved to git
//   ROOM      context, cost, allowance and cache, dim
// A section with nothing to say keeps its head and one dim line. A section head stays with the first row under it, so a cut leaves no bare head;
// what does not fit becomes one `+N more` row. Every row is redacted and cut to the width. Observer only.

const sp = (text: string, tone: Tone): Span => ({ text, tone })

const LINES = 3
const TIMELINE_MAX = 12

type Group = PaneRow[]

const empty = (key: string, text: string): Group => [line(key, sp(`  ${text}`, 'dim'))]

/** A labelled entry (GOAL, STOP AT): row 1 holds the label, the later rows indent 4, a cut ends with an ellipsis. */
const entry = (key: string, label: string, value: string, mark: string, columns: number): Group => {
  const lead: Span[] = [sp(label, 'dim')]
  if (value === '') return [line(key, ...lead, sp('not set', label.trim() === 'GOAL' ? 'warn' : 'dim'))]
  return wrapRows(key, lead, `${value}${mark}`, 'todo', columns, LINES)
}

const stateSection = (s: TabState, columns: number): Section => {
  const chip = CHIP[s.chip] ?? CHIP.idle
  const goal = oneLine(s.brief?.goal)
  const stop = oneLine(s.brief?.stopAt)
  return {
    head: head('ss-h-state', 'STATE'),
    groups: [
      [line('ss-chip', sp(`  ${chipWord(s.chip)}`, chip.tone))],
      entry('ss-goal', '  GOAL ', goal, '', columns),
      entry('ss-stop', '  STOP AT ', stop, stop !== '' && s.brief?.sources.stopAt === 'parsed' ? ' [parsed]' : '', columns),
    ],
  }
}

/** The in-progress task as a "Doing" sentence, else Thinking, else the count of running helpers, else idle. */
const nowText = (s: TabState): string => {
  const doing = s.view.tasks.find(one => one.status === 'in_progress')
  if (doing !== undefined) return stepSentence({ state: 'doing', subject: doing.activeForm ?? doing.subject, proven: false })
  if (s.view.turn !== null) return 'Thinking'
  const running = s.view.agents.filter(one => one.status === 'running').length
  return running > 0 ? `${running} ${running === 1 ? 'helper' : 'helpers'} running` : 'Resting'
}

const nowSection = (s: TabState, columns: number): Section => ({
  head: head('ss-h-now', 'NOW'),
  groups: [wrapRows('ss-now', [sp('  ', 'dim')], nowText(s), 'active', columns, LINES)],
})

const helpersSection = (s: TabState, now: number, columns: number): Section => {
  const runs = s.agentRuns ?? []
  const plain = runs.filter(one => one.status === 'running' && (typeof one.workflowRunId !== 'string' || one.workflowRunId === ''))
  const flows = workflowProgress(runs).filter(one => one.running > 0)
  const groups: Group[] = [
    ...[...plain].sort((a, b) => a.startedAt - b.startedAt).map((one, i) => wrapRows(`ss-helper-${i}`, [sp('  ', 'dim')], helperSentence(one, now), 'todo', columns, LINES)),
    ...flows.map((one, i) => wrapRows(`ss-flow-${i}`, [sp('  ', 'dim')], workflowSentence(one), 'todo', columns, LINES)),
  ]
  return {
    head: head('ss-h-helpers', 'HELPERS'),
    groups: groups.length > 0 ? groups : [empty('ss-helpers-none', runs.length === 0 ? 'no helpers yet' : 'no helper is running')],
  }
}

type Event = { at: number | null; key: string; text: string; tone: Tone }

/** The milestones with a time, newest first, then the ones with none. */
const events = (s: TabState): Event[] => {
  const out: Event[] = []
  const keeper = keeperSentence(s.compactions ?? [])
  const newest = newestKeeper(s.compactions ?? [])
  if (keeper !== null && newest !== null) out.push({ at: newest.at, key: 'keeper', text: keeper.text, tone: keeper.kill ? 'bad' : 'todo' })
  for (const [i, one] of (s.brief?.proofs ?? []).entries()) out.push({ at: one.at, key: `proof-${i}`, text: proofSentence({ subject: one.subject }), tone: 'todo' })
  for (const [i, one] of (s.agentRuns ?? []).entries()) {
    if (one.status !== 'running') out.push({ at: one.endedAt ?? one.startedAt, key: `run-${i}`, text: helperSentence(one, one.endedAt ?? one.startedAt), tone: 'todo' })
  }
  for (const [i, one] of (s.brief?.decisions ?? []).entries()) {
    if (typeof one.by === 'string' && one.by.trim().toLowerCase() === 'dave') out.push({ at: one.at, key: `decision-${i}`, text: `Dave decided: ${oneLine(one.text)}`, tone: 'todo' })
  }
  const saved = filesSentences(s.files ?? []).find(one => one.startsWith('Saved'))
  const timed = out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return saved === undefined ? timed : [...timed, { at: null, key: 'saved', text: saved, tone: 'todo' }]
}

const timelineSection = (s: TabState, now: number, columns: number): Section => {
  const groups = events(s)
    .slice(0, TIMELINE_MAX)
    .map(one => wrapRows(`ss-tl-${one.key}`, [sp('  ', 'dim')], one.text, one.tone, columns, LINES, one.at === null ? {} : { right: [sp(shortAge(now, one.at), 'dim')] }))
  return { head: head('ss-h-timeline', 'TIMELINE'), groups: groups.length > 0 ? groups : [empty('ss-timeline-none', 'no milestones yet')] }
}

const roomSection = (s: TabState, columns: number): Section => {
  const said = roomSentences({ ctx: s.view.ctx, costUsd: s.costUsd, cachePct: s.cachePct ?? null, limits: s.limits ?? [] })
  const groups = said.map((one, i) => wrapRows(`ss-room-${i}`, [sp('  ', 'dim')], one, 'dim', columns, 1))
  return { head: head('ss-h-room', 'ROOM'), groups: groups.length > 0 ? groups : [empty('ss-room-none', 'nothing measured yet')] }
}

/** The Session tab: `rows` at most, each inside `columns`. A cut ends with one `+N more` row that counts items. */
export const sessionTab = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const cap = Math.max(1, Math.floor(columns))
  const sections = [stateSection(s, cap), nowSection(s, cap), helpersSection(s, now, cap), timelineSection(s, now, cap), roomSection(s, cap)]
  return takeGroups(groupSections(sections), Math.floor(rows), 'more-session').map(row => scrubFit(row, cap))
}
