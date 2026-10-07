import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { OsPlan, OsStep, OsTask, OsTurn } from '../../types'
import { addTask, bandText, isQuiet, patchTask, planTitle, stepLabel, tasksFromTodos } from './model'
import type { OsView } from './model'

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const turn = atom({ plugin: 'ccv3-mods', key: 'turn' } as const, null as OsTurn | null)
const step = atom({ plugin: 'ccv3-mods', key: 'step' } as const, null as OsStep | null)
const ctx = atom({ plugin: 'ccv3-mods', key: 'ctx' } as const, null as number | null)

type Result = { result?: unknown; isError?: boolean; deny?: string }

/** The tool's own record when the call ran clean, else undefined. */
const okResult = (ran: Result): Record<string, unknown> | undefined =>
  ran.deny === undefined && ran.isError !== true && typeof ran.result === 'object' && ran.result !== null
    ? (ran.result as Record<string, unknown>)
    : undefined

const view = async ($: EngineInterface): Promise<OsView> => ({
  tasks: await read($, tasks),
  plan: await read($, plan),
  turn: await read($, turn),
  step: await read($, step),
  ctx: await read($, ctx),
})

/**
 * One JSON file per session under ~/.claude/state/agentic-os/: the read side
 * for the web dashboard (Slice 2) and the evidence for headless probes.
 * A failed write never touches the session.
 */
const writeSnapshot = async ($: EngineInterface): Promise<void> => {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const sessionId = await $.session.id()
    const snapshot = { sessionId, at: await $.clock.now(), ...(await view($)) }
    await $.fs.write(`${home}/.claude/state/agentic-os/${sessionId}.json`, JSON.stringify(snapshot, null, 2))
  } catch {
    // Observer only: a snapshot is best effort.
  }
}

/** Folds a finished task or plan call into state; true when state changed. */
const record = async ($: EngineInterface, tool: string, input: Record<string, unknown>, ran: Result) => {
  const out = okResult(ran)
  if (!out) return false
  if (tool === 'TaskCreate') {
    const task = out.task as { id: string; subject: string } | undefined
    if (!task) return false
    await update($, tasks, list => addTask(list, task.id, task.subject, input.activeForm as string | undefined))
    return true
  }
  if (tool === 'TaskUpdate') {
    if (out.success !== true) return false
    await update($, tasks, list => patchTask(list, input as Parameters<typeof patchTask>[1]))
    return true
  }
  if (tool === 'TodoWrite') {
    const todos = out.newTodos as Parameters<typeof tasksFromTodos>[0] | undefined
    if (!todos) return false
    await update($, tasks, () => tasksFromTodos(todos))
    return true
  }
  if (tool === 'ExitPlanMode') {
    if (typeof out.plan !== 'string') return false
    const file = typeof out.filePath === 'string' ? out.filePath : undefined
    await update($, plan, () => ({ title: planTitle(out.plan as string), ...(file ? { file } : {}) }))
    return true
  }
  return false
}

export const agenticOs = (on: On) => {
  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    await update($, turn, () => ({ id: e.turnId, startedAt }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, () => null)
      await update($, step, () => null)
      await writeSnapshot($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && e.context.percent !== undefined) {
      await update($, ctx, () => e.context.percent ?? null)
    }
    return next(e)
  })

  // Observer, never a gate: on a failure the call goes on as if unhooked.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    await update($, step, () => ({ id, tool: String(e.tool), label: stepLabel(String(e.tool), input), startedAt }))
    const ran = await next(e)
    await update($, step, current => (current?.id === id ? null : current))
    if (await record($, String(e.tool), input, ran)) await writeSnapshot($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await view($)
    if (e.props.hasSurvey || isQuiet(now)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {bandText(now, await $.clock.now(), e.props.bodyColumns)}
        </Text>
      </Box>
    )
  })
}
