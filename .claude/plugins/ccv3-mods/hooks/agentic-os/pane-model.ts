import type { OsAgent, OsLane, OsTask } from '../../types'
import { clip, elapsed } from './model'
import type { OsView } from './model'

/** One drawn row of the pane. `tone` maps to a theme colour at draw time. */
export type PaneRow = { key: string; text: string; tone: 'head' | 'done' | 'active' | 'todo' | 'dim' }

const MARK: Record<OsTask['status'], string> = { completed: '✓', in_progress: '▶', pending: '○' }
const TONE: Record<OsTask['status'], PaneRow['tone']> = { completed: 'done', in_progress: 'active', pending: 'todo' }

/**
 * The task rows that fit in `room`. Open tasks win over finished ones: when the
 * list is too long, the finished tasks fold into one "✓ N done" row first.
 */
export const taskRows = (tasks: OsTask[], room: number): PaneRow[] => {
  const row = (task: OsTask): PaneRow => ({
    key: `task-${task.id}`,
    text: `${MARK[task.status]} ${task.status === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject}`,
    tone: TONE[task.status],
  })
  if (tasks.length <= room) return tasks.map(row)
  const done = tasks.filter(task => task.status === 'completed')
  const open = tasks.filter(task => task.status !== 'completed')
  const shown = open.slice(0, Math.max(1, room - 1))
  const rows: PaneRow[] = [{ key: 'task-done', text: `✓ ${done.length} done`, tone: 'done' }, ...shown.map(row)]
  const hidden = open.length - shown.length
  return hidden > 0 ? [...rows, { key: 'task-more', text: `… ${hidden} more`, tone: 'dim' }] : rows
}

/** Agent rows; the list arrives already cut to live agents (refreshAgents). */
const agentRows = (agents: OsAgent[]): PaneRow[] =>
  agents.map(agent => ({
      key: `agent-${agent.id}`,
      text: `${agent.status === 'running' ? '▶' : '·'} ${agent.type} · ${agent.description}`,
      tone: agent.status === 'running' ? 'active' : 'dim',
    }))

const laneRows = (lanes: OsLane[] | null): PaneRow[] => {
  if (lanes === null) return [{ key: 'lane-none', text: 'lane board not read', tone: 'dim' }]
  if (lanes.length === 0) return [{ key: 'lane-none', text: 'no lane held', tone: 'dim' }]
  return lanes.map(lane => ({ key: `lane-${lane.id}`, text: `${lane.id} · ${lane.state}`, tone: 'todo' }))
}

/** Every row of the pane, each clipped to `columns`, fitted to `rows`. */
export const paneRows = (view: OsView, nowMs: number, columns: number, rows: number): PaneRow[] => {
  const done = view.tasks.filter(task => task.status === 'completed').length
  const head = (key: string, text: string): PaneRow => ({ key, text, tone: 'head' })
  const now: PaneRow = view.step
    ? { key: 'now', text: `${view.step.label} ${elapsed(nowMs - view.step.startedAt)}`, tone: 'active' }
    : { key: 'now', text: view.turn ? `thinking ${elapsed(nowMs - view.turn.startedAt)}` : 'idle', tone: 'dim' }
  const agents = agentRows(view.agents)
  const footer: PaneRow = {
    key: 'footer',
    text: [view.ctx !== null ? `ctx ${view.ctx}%` : '', view.turn ? `turn ${elapsed(nowMs - view.turn.startedAt)}` : '']
      .filter(Boolean)
      .join(' · '),
    tone: 'dim',
  }

  const fixed: PaneRow[] = [
    head('h-plan', `PLAN  ${view.plan?.title ?? '—'}`),
    head('h-tasks', `TASKS ${done}/${view.tasks.length} done`),
  ]
  const tail: PaneRow[] = [
    head('h-now', 'NOW'),
    now,
    ...(agents.length ? [head('h-agents', 'AGENTS'), ...agents] : []),
    head('h-lane', 'LANE'),
    ...laneRows(view.lanes),
    ...(footer.text ? [footer] : []),
  ]
  const room = Math.max(1, rows - fixed.length - tail.length)
  const tasks = view.tasks.length ? taskRows(view.tasks, room) : [{ key: 'task-none', text: 'no tasks yet', tone: 'dim' as const }]
  return [...fixed, ...tasks, ...tail].map(row => ({ ...row, text: clip(row.text, Math.max(10, columns)) }))
}

/** Lane rows from `lane.mjs mine --json` output; null when it is not a lane list. */
export const parseLanes = (stdout: string): OsLane[] | null => {
  try {
    const rows: unknown = JSON.parse(stdout)
    if (!Array.isArray(rows)) return null
    return rows.flatMap(row => {
      const lane = row as Record<string, unknown>
      if (typeof lane.id !== 'string') return []
      const note = typeof lane.note === 'string' ? lane.note.split(/\r?\n/)[0] : undefined
      return [{ id: lane.id, title: String(lane.title ?? ''), state: String(lane.state ?? ''), ...(note ? { note } : {}) }]
    })
  } catch {
    return null
  }
}
