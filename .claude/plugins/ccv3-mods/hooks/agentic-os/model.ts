import type { OsAgent, OsLane, OsPlan, OsStep, OsTask, OsTaskStatus, OsTurn } from '../../types'

export type OsView = {
  tasks: OsTask[]
  plan: OsPlan | null
  turn: OsTurn | null
  step: OsStep | null
  ctx: number | null
  agents: OsAgent[]
  lanes: OsLane[] | null
}

type TaskPatch = {
  taskId: string
  subject?: string
  activeForm?: string
  status?: OsTaskStatus | 'deleted'
}

type Todo = { content: string; status: OsTaskStatus; activeForm: string }

export const addTask = (tasks: OsTask[], id: string, subject: string, activeForm?: string): OsTask[] => [
  ...tasks.filter(task => task.id !== id),
  { id, subject, status: 'pending', ...(activeForm ? { activeForm } : {}) },
]

const STATUSES: readonly unknown[] = ['pending', 'in_progress', 'completed']

const isStatus = (value: unknown): value is OsTaskStatus => STATUSES.includes(value)

export const patchTask = (tasks: OsTask[], patch: TaskPatch): OsTask[] => {
  if (patch.status === 'deleted') return tasks.filter(task => task.id !== patch.taskId)
  // A status outside the known set is ignored, so the band never counts it.
  const status = isStatus(patch.status) ? patch.status : undefined
  return tasks.map(task =>
    task.id !== patch.taskId
      ? task
      : {
          ...task,
          ...(patch.subject ? { subject: patch.subject } : {}),
          ...(patch.activeForm ? { activeForm: patch.activeForm } : {}),
          ...(status ? { status } : {}),
        },
  )
}

/** Valid todos only: a non-list or an entry without text or a known status is skipped. */
export const tasksFromTodos = (todos: unknown): OsTask[] =>
  (Array.isArray(todos) ? (todos as Partial<Todo>[]) : [])
    .filter(todo => typeof todo?.content === 'string' && isStatus(todo.status))
    .map((todo, i) => ({
      id: `todo-${i + 1}`,
      subject: todo.content as string,
      status: todo.status as OsTaskStatus,
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    }))

export const planTitle = (plan: string): string => {
  const lines = plan.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const heading = lines.find(line => line.startsWith('#')) ?? lines[0] ?? 'plan'
  return clip(heading.replace(/^#+\s*/, ''), 60)
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** A short human label for the tool call that is running. */
export const stepLabel = (tool: string, input: Record<string, unknown>): string => {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (text('description')) return clip(text('description'), 50)
  if (text('file_path')) return `${tool} ${basename(text('file_path'))}`
  if (text('command')) return clip(text('command').split(/\r?\n/)[0] ?? '', 50)
  if (text('pattern')) return `${tool} ${clip(text('pattern'), 40)}`
  return tool
}

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

export const elapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** True when the band has nothing worth a row: no plan, no tasks, no step. */
export const isQuiet = (view: OsView): boolean =>
  view.plan === null && view.tasks.length === 0 && view.step === null

/** The band's one line, clipped to `columns`. */
export const bandText = (view: OsView, nowMs: number, columns: number): string => {
  const parts: string[] = []
  if (view.plan) parts.push(`◆ ${view.plan.title}`)
  if (view.tasks.length) {
    const done = view.tasks.filter(task => task.status === 'completed').length
    parts.push(`${done}/${view.tasks.length} done`)
    const active = view.tasks.find(task => task.status === 'in_progress')
    if (active) parts.push(`▶ ${active.activeForm ?? active.subject}`)
  }
  if (view.step) parts.push(`now: ${view.step.label} ${elapsed(nowMs - view.step.startedAt)}`)
  else if (view.turn) parts.push(`turn ${elapsed(nowMs - view.turn.startedAt)}`)
  if (view.ctx !== null) parts.push(`ctx ${view.ctx}%`)
  return clip(parts.join(' · '), Math.max(10, columns))
}
