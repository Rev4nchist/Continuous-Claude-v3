import type { OsAgent, OsLane, OsTask, PrWatch } from '../../types'
import { clip, elapsed } from './model'
import type { OsView } from './model'

/** A colour role; the render maps each to theme props, so light and dark both work. */
export type Tone =
  | 'title' | 'head' | 'active' | 'done' | 'todo' | 'dim' | 'ok' | 'warn' | 'bad' | 'chip' | 'track'
  /** HUD: the model chip when effort is below the high pin, and the advisor. */
  | 'chipBad' | 'advisor'
  /** Band (band-model.ts), after the mockup: working is a blue chip (`chipDoing`) and a doing plan cell is blue (`doing`); waiting-on-dave amber, done green, idle grey, blocked `chipBad`. */
  | 'chipDoing' | 'doing' | 'chipWarn' | 'chipOk' | 'chipDim'
  /** Agent Ledger: a Sonnet tier badge. */
  | 'sonnetTier'
  /** Skin diff lines. */
  | 'diffAdd' | 'diffDel'

/** A run of text in one tone. */
export type Span = { text: string; tone: Tone }

/** One drawn line: spans on the left, an optional right-aligned group. */
export type PaneRow = { key: string; left: Span[]; right?: Span[] }

const sp = (text: string, tone: Tone): Span => ({ text, tone })

const width = (spans: Span[] = []) => spans.reduce((n, s) => n + s.text.length, 0)

/** Clips the left spans so left, a one-cell gap and right fit `columns`. */
export const fit = (row: PaneRow, columns: number): PaneRow => {
  let room = Math.max(4, columns - (row.right ? width(row.right) + 1 : 0))
  const left: Span[] = []
  for (const span of row.left) {
    if (room <= 0) break
    const text = clip(span.text, room)
    left.push({ ...span, text })
    room -= text.length
  }
  return { ...row, left }
}

/** A text gauge: `filled` cells in `tone`, the rest as an empty track. */
export const bar = (fraction: number, cells: number, tone: Tone, glyphs = ['█', '░']): Span[] => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
  return [sp((glyphs[0] ?? '█').repeat(filled), tone), sp((glyphs[1] ?? '░').repeat(cells - filled), 'track')]
}

/** Green under half full, amber to three quarters, red past that. */
export const gaugeTone = (percent: number): Tone => (percent < 50 ? 'ok' : percent < 75 ? 'warn' : 'bad')

const LANE_TONE: Record<string, Tone> = { active: 'ok', ready: 'ok', review: 'warn', blocked: 'bad', done: 'dim', backlog: 'dim' }

const MARK: Record<OsTask['status'], Span> = {
  completed: sp('✓ ', 'done'),
  in_progress: sp('▶ ', 'active'),
  pending: sp('○ ', 'dim'),
}

const taskRow = (task: OsTask): PaneRow => ({
  key: `task-${task.id}`,
  left: [
    sp('  ', 'dim'),
    MARK[task.status],
    task.status === 'in_progress'
      ? sp(task.activeForm ?? task.subject, 'active')
      : sp(task.subject, task.status === 'completed' ? 'dim' : 'todo'),
  ],
})

/**
 * The task rows that fit in `room`, never more. A list that fits shows in
 * order. A longer one folds: finished tasks become one "✓ N done" row, the
 * active task leads the open ones, and a "… N more" row takes the last row.
 */
export const taskRows = (tasks: OsTask[], room: number): PaneRow[] => {
  if (tasks.length <= room) return tasks.map(taskRow)
  const done = tasks.filter(task => task.status === 'completed').length
  const open = [
    ...tasks.filter(task => task.status === 'in_progress'),
    ...tasks.filter(task => task.status === 'pending'),
  ]
  const head: PaneRow[] =
    done > 0 && room > 1 ? [{ key: 'task-done', left: [sp('  ', 'dim'), sp(`✓ ${done} done`, 'done')] }] : []
  const space = room - head.length
  if (open.length <= space) return [...head, ...open.map(taskRow)]
  const shown = open.slice(0, Math.max(1, space - 1))
  const hidden = open.length - shown.length
  const more: PaneRow[] = space > shown.length ? [{ key: 'task-more', left: [sp(`    … ${hidden} more`, 'dim')] }] : []
  return [...head, ...shown.map(taskRow), ...more]
}

/** Agent rows, at most `cap`; the list arrives already cut to live agents (refreshAgents). */
const agentRows = (agents: OsAgent[], cap: number): PaneRow[] => {
  const shown = agents.length <= cap ? agents : agents.slice(0, Math.max(1, cap - 1))
  const rows: PaneRow[] = shown.map(agent => ({
    key: `agent-${agent.id}`,
    left: [
      sp('  ', 'dim'),
      agent.status === 'running' ? sp('▶ ', 'active') : sp('· ', 'dim'),
      sp(agent.type, 'todo'),
      sp(`  ${agent.description}`, 'dim'),
    ],
  }))
  const hidden = agents.length - shown.length
  return hidden > 0 ? [...rows, { key: 'agent-more', left: [sp(`    … ${hidden} agents more`, 'dim')] }] : rows
}

const laneRows = (lanes: OsLane[] | null): PaneRow[] => {
  if (lanes === null) return [{ key: 'lane-none', left: [sp('  lane board not read', 'dim')] }]
  if (lanes.length === 0) return [{ key: 'lane-none', left: [sp('  no lane held', 'dim')] }]
  const [first, ...rest] = lanes
  const chip = (lane: OsLane): PaneRow => ({
    key: `lane-${lane.id}`,
    left: [sp('  ', 'dim'), sp(` ${lane.id} `, 'chip'), sp(' ', 'dim'), sp(`● ${lane.state}`, LANE_TONE[lane.state] ?? 'dim')],
  })
  const note: PaneRow[] = first?.note ? [{ key: 'lane-note', left: [sp(`    ↳ ${first.note}`, 'dim')] }] : []
  return first ? [chip(first), ...note, ...rest.map(chip)] : []
}

/** A watched PR a person or the model must look at: rate limited, reviewed with findings, or no review. */
const attention = (state: string | null): boolean => state === 'LIMITED' || state === 'REVIEWED' || state === 'STALLED' || state === 'PROOF'

const PR_TONE: Record<string, Tone> = { READY: 'ok', LIMITED: 'warn', REVIEWED: 'warn', STALLED: 'warn', PENDING: 'dim' }

/** Watched PR rows, at most `cap`. A PR not checked yet reads as waiting. */
const prRows = (prs: PrWatch[], cap: number): PaneRow[] => {
  const shown = prs.length <= cap ? prs : prs.slice(0, Math.max(1, cap - 1))
  const rows: PaneRow[] = shown.map(one => ({
    key: `pr-${one.pr}`,
    left: [sp('  ', 'dim'), sp(` #${one.pr} `, 'chip'), sp(' ', 'dim'), sp(`● ${one.state ?? 'PENDING'}`, PR_TONE[one.state ?? 'PENDING'] ?? 'dim')],
  }))
  const hidden = prs.length - shown.length
  return hidden > 0 ? [...rows, { key: 'pr-more', left: [sp(`    … ${hidden} PRs more`, 'dim')] }] : rows
}

const head = (key: string, label: string, right?: Span[]): PaneRow => ({
  key,
  left: [sp(label, 'head')],
  ...(right ? { right } : {}),
})

const gap = (key: string): PaneRow => ({ key, left: [sp(' ', 'dim')] })

/** Every row of the pane, fitted to `columns` and never more than `rows`. */
export const paneRows = (view: OsView, nowMs: number, columns: number, rows: number): PaneRow[] => {
  const done = view.tasks.filter(task => task.status === 'completed').length
  const total = view.tasks.length
  const rule: PaneRow = { key: 'rule', left: [sp('─'.repeat(Math.max(1, columns)), 'track')] }

  const status: Span[] = view.step || view.turn
    ? [sp('● ', 'warn'), sp(`working ${elapsed(nowMs - (view.turn ?? view.step)!.startedAt)}`, 'dim')]
    : [sp('○ idle', 'dim')]
  const top: PaneRow[] = [{ key: 'title', left: [sp('◆ AGENTIC OS', 'title')], right: status }, rule]

  const plan: PaneRow[] = [
    head('h-plan', 'PLAN'),
    view.plan
      ? { key: 'plan', left: [sp('  ', 'dim'), sp(view.plan.title, 'todo')], ...(view.plan.file ? { right: [sp(view.plan.file.split(/[\\/]/).pop() ?? '', 'dim')] } : {}) }
      : { key: 'plan', left: [sp('  no plan yet', 'dim')] },
  ]

  const taskHead: PaneRow[] = [
    head('h-tasks', 'TASKS', total ? [sp(`${done}/${total} done`, 'dim')] : undefined),
    ...(total
      ? [{ key: 'task-bar', left: [sp('  ', 'dim'), ...bar(done / total, Math.max(6, Math.min(30, columns - 10)), 'ok'), sp(` ${Math.round((done / total) * 100)}%`, 'dim')] }]
      : []),
  ]

  const now: PaneRow[] = [
    head('h-now', 'NOW'),
    view.step
      ? {
          key: 'now',
          left: [sp('  ', 'dim'), sp(` ${view.step.tool} `, 'chip'), sp(` ${view.step.label}`, 'active')],
          right: [sp(elapsed(nowMs - view.step.startedAt), 'dim')],
        }
      : view.turn
        ? { key: 'now', left: [sp('  ◌ thinking', 'dim')], right: [sp(elapsed(nowMs - view.turn.startedAt), 'dim')] }
        : { key: 'now', left: [sp('  ○ idle', 'dim')] },
  ]

  const agentCap = Math.max(1, Math.floor(rows / 4))
  const live = view.agents.filter(agent => agent.status === 'running').length
  const agents: PaneRow[] = view.agents.length
    ? [head('h-agents', 'AGENTS', [sp(`${live} running`, 'dim')]), ...agentRows(view.agents, agentCap)]
    : []

  const lane: PaneRow[] = [head('h-lane', 'LANE'), ...laneRows(view.lanes)]
  const prs: PaneRow[] = view.prs.length
    ? [head('h-prs', 'PRS', [sp(`${view.prs.length} watched`, 'dim')]), ...prRows(view.prs, agentCap)]
    : []

  const footer: PaneRow[] =
    view.ctx !== null
      ? [
          rule,
          {
            key: 'ctx',
            left: [sp('ctx ', 'dim'), ...bar(view.ctx / 100, Math.max(6, Math.min(20, columns - 16)), gaugeTone(view.ctx), ['▰', '▱']), sp(` ${view.ctx}%`, gaugeTone(view.ctx))],
            ...(view.turn ? { right: [sp(`turn ${elapsed(nowMs - view.turn.startedAt)}`, 'dim')] } : {}),
          },
        ]
      : []

  // Sections after TASKS; gaps go between sections and are the first rows to go.
  const after = [now, agents, lane, prs].filter(section => section.length)
  const gaps = 1 + after.length
  const fixed = top.length + plan.length + taskHead.length + after.flat().length + footer.length
  const roomWithGaps = rows - fixed - gaps
  const useGaps = roomWithGaps >= Math.min(3, Math.max(1, total))
  const room = Math.max(1, useGaps ? roomWithGaps : rows - fixed)

  const tasks = total ? taskRows(view.tasks, room) : [{ key: 'task-none', left: [sp('  no tasks yet', 'dim')] }]
  const sep = (i: number) => (useGaps ? [gap(`gap-${i}`)] : [])
  const all: PaneRow[] = [
    ...top,
    ...plan,
    ...sep(0),
    ...taskHead,
    ...tasks,
    ...after.flatMap((section, i) => [...sep(i + 1), ...section]),
    ...footer.map((row, i) => (i === 0 ? { ...row, key: 'rule-foot' } : row)),
  ]
  // A body shorter than the fixed rows cuts from the bottom rather than overflow.
  return all.slice(0, Math.max(1, rows)).map(row => fit(row, Math.max(10, columns)))
}

/** The band's spans: plan, progress, the active task, the running step, context. */
export const bandSpans = (view: OsView, nowMs: number, columns: number, agentsPart: Span[] | null = null): Span[] => {
  const parts: Span[][] = []
  if (view.plan) parts.push([sp('◆ ', 'title'), sp(view.plan.title, 'todo')])
  if (view.tasks.length) {
    const done = view.tasks.filter(task => task.status === 'completed').length
    parts.push([...bar(done / view.tasks.length, 8, 'ok', ['▰', '▱']), sp(` ${done}/${view.tasks.length} done`, 'dim')])
    const active = view.tasks.find(task => task.status === 'in_progress')
    if (active) parts.push([sp('▶ ', 'active'), sp(active.activeForm ?? active.subject, 'active')])
  }
  if (view.step) parts.push([sp(`${view.step.tool} ${view.step.label}`.trim(), 'dim'), sp(` ${elapsed(nowMs - view.step.startedAt)}`, 'dim')])
  else if (view.turn) parts.push([sp(`◌ ${elapsed(nowMs - view.turn.startedAt)}`, 'dim')])
  if (view.prs.length) parts.push([sp(`PR ${view.prs.map(one => `#${one.pr}${attention(one.state) ? '!' : ''}`).join(' ')}`, view.prs.some(one => attention(one.state)) ? 'warn' : 'dim')])
  if (agentsPart) parts.push(agentsPart)
  if (view.ctx !== null) parts.push([sp(`ctx ${view.ctx}%`, gaugeTone(view.ctx))])
  const joined = parts.flatMap((part, i) => (i ? [sp(' · ', 'track'), ...part] : part))
  return fit({ key: 'band', left: joined }, Math.max(10, columns)).left
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
