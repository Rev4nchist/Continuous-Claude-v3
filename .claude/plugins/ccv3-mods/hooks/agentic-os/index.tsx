import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, TextProps } from 'claude-code'

import type { OsAgent, OsLane, OsPlan, OsStep, OsTask, OsTurn } from '../../types'
import { addTask, bandText, isQuiet, patchTask, planTitle, stepLabel, tasksFromTodos } from './model'
import type { OsView } from './model'
import { paneRows, parseLanes } from './pane-model'
import type { PaneRow } from './pane-model'

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const turn = atom({ plugin: 'ccv3-mods', key: 'turn' } as const, null as OsTurn | null)
const step = atom({ plugin: 'ccv3-mods', key: 'step' } as const, null as OsStep | null)
const ctx = atom({ plugin: 'ccv3-mods', key: 'ctx' } as const, null as number | null)
const agents = atom({ plugin: 'ccv3-mods', key: 'agents' } as const, [] as OsAgent[])
const lanes = atom({ plugin: 'ccv3-mods', key: 'lanes' } as const, null as OsLane[] | null)
/** Bumped every few seconds while a turn runs, so elapsed times redraw. */
const tick = atom({ plugin: 'ccv3-mods', key: 'tick' } as const, 0)

const PANE = 'agentic-os'
const PULSE_MS = 5000
const LIVE_AGENT = new Set(['pending', 'running', 'waiting', 'idle'])

const TONE: Record<PaneRow['tone'], TextProps> = {
  head: { bold: true },
  active: { color: 'claude', bold: true },
  done: { color: 'success' },
  todo: {},
  dim: { dimColor: true },
}

type Result = { result?: unknown; isError?: boolean; deny?: string }

/** The tool's own record when the call ran clean, else undefined. */
const okResult = (ran: Result): Record<string, unknown> | undefined =>
  ran.deny === undefined && ran.isError !== true && typeof ran.result === 'object' && ran.result !== null
    ? (ran.result as Record<string, unknown>)
    : undefined

const homeDir = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

const view = async ($: EngineInterface): Promise<OsView> => ({
  tasks: await read($, tasks),
  plan: await read($, plan),
  turn: await read($, turn),
  step: await read($, step),
  ctx: await read($, ctx),
  agents: await read($, agents),
  lanes: await read($, lanes),
})

/**
 * One JSON file per session under ~/.claude/state/agentic-os/: the read side
 * for the web dashboard (Slice 2) and the evidence for headless probes.
 * A failed write never touches the session.
 */
const writeSnapshot = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await homeDir($)
    if (!home) return
    const sessionId = await $.session.id()
    const snapshot = { sessionId, at: await $.clock.now(), ...(await view($)) }
    await $.fs.write(`${home}/.claude/state/agentic-os/${sessionId}.json`, JSON.stringify(snapshot, null, 2))
  } catch {
    // Observer only: a snapshot is best effort.
  }
}

const refreshAgents = async ($: EngineInterface): Promise<void> => {
  try {
    const list = await $.agent.list()
    const live = list
      .filter(agent => LIVE_AGENT.has(agent.status))
      .map(({ id, description, type, status }) => ({ id, description, type, status }))
    await update($, agents, () => live)
  } catch {
    // Best effort: the pane keeps the last list.
  }
}

/** Reads this session's lanes from the CCv3 lane board, when the repo is there. */
const refreshLanes = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await homeDir($)
    const script = `${home}/continuous-claude/scripts/coordination/lane.mjs`
    if (!home || !(await $.fs.exists(script))) return
    const sessionId = await $.session.id()
    const run = await $.process.run(['node', script, 'mine', '--json', '--as', sessionId], { timeoutMs: 15000 })
    const parsed = run.exitCode === 0 ? parseLanes(run.stdout) : null
    if (parsed) await update($, lanes, () => parsed)
  } catch {
    // Best effort: no board, no DB, or no node; the pane says "lane board not read".
  }
}

/** While a turn runs: redraw elapsed times and re-read the agents. */
const pulse = async ($: EngineInterface): Promise<void> => {
  if ((await read($, turn)) === null && (await read($, step)) === null) return
  const now = await $.clock.now()
  await update($, tick, () => now)
  await refreshAgents($)
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

/** Side reads a finished call can make stale: the agent list, the lane board. */
const refreshAfter = ($: EngineInterface, tool: string, input: Record<string, unknown>): void => {
  if (tool === 'Agent') void refreshAgents($)
  const command = typeof input.command === 'string' ? input.command : ''
  if ((tool === 'Bash' || tool === 'PowerShell') && command.includes('lane.mjs')) void refreshLanes($)
}

export const agenticOs = (on: On) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'os',
      description: 'Agentic OS pane: plan, tasks, current step, agents and lane of this session',
    })
    $.clock.every(PULSE_MS, () => void pulse($))
    void refreshLanes($)
    return next(e)
  })

  on('command.run', { command: 'os' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Agentic OS' })
    // The pane is already up; these fill its AGENTS and LANE rows as they land.
    await Promise.all([refreshLanes($), refreshAgents($)])
    await writeSnapshot($)
    return { text: opened.isPlaced ? 'Agentic OS pane opened.' : `Agentic OS pane waits: ${opened.reason}` }
  })

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
    const tool = String(e.tool)
    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    await update($, step, () => ({ id, tool, label: stepLabel(tool, input), startedAt }))
    const ran = await next(e)
    await update($, step, current => (current?.id === id ? null : current))
    if (await record($, tool, input, ran)) await writeSnapshot($)
    refreshAfter($, tool, input)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)
    const height = e.viewport?.rows ?? 24
    const room = e.props.placement === 'inline' ? Math.min(18, height - 4) : height - 4
    const rows = paneRows(await view($), await $.clock.now(), e.props.bodyColumns, Math.max(8, room))
    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Text key={row.key} wrap="truncate-end" {...TONE[row.tone]}>
            {row.text}
          </Text>
        ))}
      </Box>
    )
  })
}
