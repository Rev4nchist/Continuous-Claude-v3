import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, CacheState, HudState, OsAgent, OsBrief, OsLane, OsPlan, OsStep, OsTask, OsTurn, PrWatch } from '../../types'
import { EMPTY_CACHE, cacheView } from '../hud/cache'
import { hudParts, hudSpans } from '../hud/model'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { ledgerBandSpans, settle } from '../agent-ledger/model'
import type { AgentStatus } from 'claude-code'
import type { HudPart } from '../hud/model'
import { barSvg, ringSvg } from '../shared/glyphs'
import { applyBrief, briefSummary, deriveChip, isModSubmission, markAsksAnswered, mergeParsed, parseTurnEnd } from './brief'
import { SVG_TRACK, TONE, svgHex } from '../shared/tones'
import { addTask, isQuiet, patchTask, planTitle, stepLabel, tasksFromTodos } from './model'
import type { OsView } from './model'
import { bandSpans, paneRows, parseLanes } from './pane-model'
import type { Span, Tone } from './pane-model'

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const turn = atom({ plugin: 'ccv3-mods', key: 'turn' } as const, null as OsTurn | null)
const steps = atom({ plugin: 'ccv3-mods', key: 'steps' } as const, [] as OsStep[])
const ctx = atom({ plugin: 'ccv3-mods', key: 'ctx' } as const, null as number | null)
const agents = atom({ plugin: 'ccv3-mods', key: 'agents' } as const, [] as OsAgent[])
const lanes = atom({ plugin: 'ccv3-mods', key: 'lanes' } as const, null as OsLane[] | null)
/** The PRs the pr-loop module watches. Read only here: the same atom pr-loop declares and writes. */
const prs = atom({ plugin: 'ccv3-mods', key: 'prs' } as const, [] as PrWatch[])
/** Bumped every few seconds while a turn runs, so elapsed times redraw. */
const tick = atom({ plugin: 'ccv3-mods', key: 'tick' } as const, 0)
/**
 * Set at every session.start from `isInteractive`. Headless (a `-p` run or the
 * SDK) keeps capture and snapshots but spawns nothing and arms no timer.
 * An atom, not a module variable, so a reload that skips session.start keeps it.
 */
/** The HUD row, written by hooks/hud (same key); null keeps the band as it was before the HUD. */
const hud = atom({ plugin: 'ccv3-mods', key: 'hud' } as const, null as HudState | null)

/** Prompt-cache use of the main loop, written by hooks/hud (same key): the HUD's cache element. */
const cache = atom({ plugin: 'ccv3-mods', key: 'cache' } as const, EMPTY_CACHE as CacheState)

/** Agent Ledger runs (hooks/agent-ledger); turn.complete below settles them. */
const agentRuns = atom({ plugin: 'ccv3-mods', key: 'agentRuns' } as const, [] as AgentRun[])

/** What the session says about itself (the brief_set tool, plus the turn-end parser). Written here only; cleared at /clear and resume. */
const brief = atom({ plugin: 'ccv3-mods', key: 'brief' } as const, null as OsBrief | null)
/** True once a main-loop tool call was refused in this turn: the chip reads blocked until the next turn starts. */
const refused = atom({ plugin: 'ccv3-mods', key: 'refused' } as const, false)
/** When the session last did anything: a prompt, a turn start or end, a main-loop tool call. An open ask stays fresh 24 hours from it. */
const activeAt = atom({ plugin: 'ccv3-mods', key: 'activeAt' } as const, null as number | null)

const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')
/** True once this environment's pulse is armed; a start resets it, so a reload arms a fresh one. */
const uiArmed = atom({ plugin: 'ccv3-mods', key: 'uiArmed' } as const, false)

const PANE = 'agentic-os'
/** The only fields the handler reads off the brief_set call: the rest of the event is the engine's. */
const BRIEF_KEYS = ['title', 'goal', 'stopAt', 'plan', 'ask', 'decision', 'proof'] as const
const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const PULSE_MS = 5000
/** Idle, the band still redraws this often: the cache countdown is in minutes. */
const IDLE_PULSE_MS = 60_000
const LIVE_AGENT = new Set(['pending', 'running', 'waiting', 'idle'])

// TONE, SVG_TRACK and svgHex live in ../shared/tones.ts: the ledger, files and skin modules draw with them too.

type Result = { result?: unknown; isError?: boolean; deny?: string }

/** The tool's own record when the call ran clean, else undefined. */
const okResult = (ran: Result): Record<string, unknown> | undefined =>
  ran.deny === undefined && ran.isError !== true && typeof ran.result === 'object' && ran.result !== null
    ? (ran.result as Record<string, unknown>)
    : undefined

/** Records that the session did something now. Called before the snapshot the same event writes. */
const touch = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  await update($, activeAt, () => at)
}

/** CCV3_MODS_OFF=1 keeps the whole module inert: every hook passes the event on. */
const isOff = async ($: EngineInterface): Promise<boolean> => (await $.env.get('CCV3_MODS_OFF')) === '1'

const homeDir = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

/** Leaves ~/.claude/state/ccv3-mods/errors/<time>-<where>.json, so a failure no one sees still says what broke. */
const noteError = async ($: EngineInterface, where: string, err: unknown) => {
  const home = await homeDir($)
  if (home) await $.fs.write(`${home}/${DIAG_DIR}/${errorFile(where)}`, errorText(where, err)).catch(() => undefined)
}

const view = async ($: EngineInterface): Promise<OsView> => ({
  tasks: await read($, tasks),
  plan: await read($, plan),
  turn: await read($, turn),
  step: (await read($, steps)).at(-1) ?? null,
  ctx: await read($, ctx),
  agents: await read($, agents),
  lanes: await read($, lanes),
  prs: await read($, prs),
})

/**
 * One JSON file per session under ~/.claude/state/agentic-os/: the read side
 * for the web dashboard (Slice 2) and the evidence for headless probes.
 * A failed write never touches the session.
 */
const writeSnapshot = async ($: EngineInterface, opts: { working?: boolean; except?: string } = {}): Promise<void> => {
  try {
    const home = await homeDir($)
    if (!home) return
    const sessionId = await $.session.id()
    const at = await $.clock.now()
    const now = await view($)
    const current = await read($, brief)
    // `working`: Dave's prompt just arrived, so a turn is about to start and the chip leaves waiting-on-dave at once.
    // `except`: the call that is writing (brief_set is itself a running step while its handler answers).
    const chip = deriveChip({
      brief: current,
      tasks: now.tasks,
      toolRunning: (await read($, steps)).some(one => one.id !== opts.except),
      turnActive: now.turn !== null || opts.working === true,
      blocked: await read($, refused),
      now: at,
      activeAt: await read($, activeAt),
    })
    const snapshot = { sessionId, at, ...now, agentRuns: await read($, agentRuns), cache: await read($, cache), brief: current, chip }
    await $.fs.write(`${home}/.claude/state/agentic-os/${sessionId}.json`, JSON.stringify(snapshot, null, 2))
  } catch {
    // Observer only: a snapshot is best effort.
  }
}

/**
 * A turn-end snapshot is kept for interactive sessions and for headless runs that hold a task or a plan.
 * Other headless runs (reports, probes, workflow agents) would add a file each and nothing prunes the folder.
 */
const worthSnapshot = async ($: EngineInterface): Promise<boolean> =>
  (await read($, mode)) === 'interactive' ||
  (await read($, tasks)).length > 0 ||
  (await read($, plan)) !== null ||
  (await read($, brief)) !== null

const refreshAgents = async ($: EngineInterface): Promise<void> => {
  try {
    const list = await $.agent.list()
    // A run whose loop ended without a turn.complete here (a remote or killed agent) settles from the list.
    const ended = new Map(list.filter(agent => !LIVE_AGENT.has(agent.status)).map(agent => [agent.id, agent.status] as [string, AgentStatus]))
    if ((await read($, agentRuns)).some(run => run.status === 'running' && ended.has(run.id))) {
      const now = await $.clock.now()
      await update($, agentRuns, runs =>
        runs.map(run => (run.status === 'running' && ended.has(run.id) ? settle(run, now, ended.get(run.id) !== 'completed') : run)),
      )
    }
    const live = list
      .filter(agent => LIVE_AGENT.has(agent.status))
      .map(({ id, description, type, status }) => ({ id, description, type, status }))
    await update($, agents, () => live)
  } catch {
    // Best effort: the pane keeps the last list.
  }
}

/**
 * Reads this session's lanes from the CCv3 lane board, when the repo is there.
 * The one place that spawns lane.mjs, so the headless gate sits here.
 */
const refreshLanes = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await read($, mode)) !== 'interactive') return
    const home = await homeDir($)
    const script = `${home}/continuous-claude/scripts/coordination/lane.mjs`
    if (!home || !(await $.fs.exists(script))) return
    const sessionId = await $.session.id()
    const run = await $.process.run(['node', script, 'mine', '--json', '--as', sessionId], { timeoutMs: 5000 })
    const parsed = run.exitCode === 0 ? parseLanes(run.stdout) : null
    if (parsed) await update($, lanes, () => parsed)
  } catch {
    // Best effort: no board, no DB, or no node; the pane says "lane board not read".
  }
}

/** While a turn runs: redraw elapsed times and re-read the agents. Idle: one redraw a minute, for the cache countdown. */
const pulse = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  if ((await read($, turn)) === null && (await read($, steps)).length === 0) {
    if ((await read($, cache)).lastUsedAt !== null && now - (await read($, tick)) >= IDLE_PULSE_MS) await update($, tick, () => now)
    return
  }
  await update($, tick, () => now)
  await refreshAgents($)
}

/** Folds a finished task or plan call into state; true when state changed. */
const record = async ($: EngineInterface, tool: string, input: Record<string, unknown>, ran: Result) => {
  const out = okResult(ran)
  if (!out) return false
  if (tool === 'TaskCreate') {
    const task = out.task as { id?: unknown; subject?: unknown } | undefined
    const id = task?.id
    const subject = task?.subject
    if (typeof id !== 'string' || typeof subject !== 'string') return false
    await update($, tasks, list => addTask(list, id, subject, input.activeForm as string | undefined))
    return true
  }
  if (tool === 'TaskUpdate') {
    if (out.success !== true) return false
    await update($, tasks, list => patchTask(list, input as Parameters<typeof patchTask>[1]))
    return true
  }
  if (tool === 'TodoWrite') {
    if (!Array.isArray(out.newTodos)) return false
    const fresh = tasksFromTodos(out.newTodos)
    await update($, tasks, () => fresh)
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

const briefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short session title, shown in the Fleet. Max 80 characters.' },
    goal: { type: 'string', description: 'One line: what this session is for. Max 240 characters.' },
    stopAt: { type: 'string', description: "Dave's literal stop point, in his words. Max 240 characters." },
    plan: {
      type: 'array',
      maxItems: 30,
      description: 'Replaces the whole plan. Use it when you keep no task list. Max 30 steps.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          text: { type: 'string', description: 'Max 200 characters.' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
        },
        required: ['id', 'text', 'status'],
      },
    },
    ask: {
      type: 'array',
      maxItems: 8,
      description: 'Replaces the whole list of open questions for Dave. [] clears it. Max 8 items.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['question', 'approval', 'decision', 'block'] },
          text: { type: 'string', description: 'Max 300 characters.' },
          recommend: { type: 'string', description: 'Your recommended answer.' },
        },
        required: ['kind', 'text'],
      },
    },
    decision: {
      type: 'object',
      additionalProperties: false,
      description: 'Appends one decision to the log.',
      properties: { text: { type: 'string' }, by: { type: 'string', description: 'Who decided: Dave or agent.' } },
      required: ['text', 'by'],
    },
    proof: {
      type: 'object',
      additionalProperties: false,
      description: 'Marks one task or plan step proven. taskId is a task id, a plan step id, or the exact task subject.',
      properties: { taskId: { type: 'string' }, artifact: { type: 'string', description: 'The command output or file that proves it.' } },
      required: ['taskId', 'artifact'],
    },
  },
}

const BRIEF_DESCRIPTION =
  "Records what this session is for, so Dave sees it in the Agentic OS band and the Fleet. Call it when the goal, the stop-at (Dave's literal stop point), the title, the plan or an open question changes, and when a task is proven. " +
  'Every field is optional; send at least one. plan and ask replace their whole list, so ask [] clears the open questions once Dave answered. decision appends to the log. proof marks a task or plan step proven (taskId is a task id, a plan step id or the exact task subject). ' +
  'Secrets in any string are removed before storage. The answer is the saved summary, or "brief_set failed:" with the reason (a proof that matches nothing lists the valid ids).'

/** A mod-served tool answers with a list of content blocks (the engine refuses the MCP object); see hooks/pr-loop. */
const textResult = (value: string) => ({ result: [{ type: 'text', text: value }] })

/** Own try/catch: the session.start hook rethrows, and a failed registration must not fail the start chain. */
const registerBrief = async ($: EngineInterface): Promise<void> => {
  try {
    await $.tool.register({ name: 'brief_set', description: BRIEF_DESCRIPTION, inputSchema: briefSchema })
  } catch (err) {
    await noteError($, 'brief-register', err)
  }
}

/** The handler of brief_set. The pure part is brief.ts. It answers with text, never a deny. */
const briefCall = async ($: EngineInterface, e: unknown) => {
  const given = e as Record<string, unknown>
  // A model that leaves a field out may send null for it. The engine's own fields on the event are not read.
  const raw = Object.fromEntries(BRIEF_KEYS.filter(key => given[key] !== undefined && given[key] !== null).map(key => [key, given[key]]))
  const list = await read($, tasks)
  const result = applyBrief(await read($, brief), raw, list, await $.clock.now())
  if ('error' in result) return textResult(`brief_set failed: ${result.error}`)
  await update($, brief, () => result.brief)
  await writeSnapshot($, typeof given.tool_use_id === 'string' ? { except: given.tool_use_id } : {})
  return textResult(briefSummary(result.brief, list))
}

/** A turn ended: the model's own restate line and Next steps block fill what brief_set did not set. */
const learnFromAnswer = async ($: EngineInterface, answer: unknown): Promise<void> => {
  try {
    const parsed = parseTurnEnd(typeof answer === 'string' ? answer : '')
    if (!parsed.goal && !parsed.stopAt && !parsed.ask) return
    const current = await read($, brief)
    // A headless run with no brief writes no file: nothing prunes the folder.
    if (current === null && (await read($, mode)) !== 'interactive') return
    const at = await $.clock.now()
    await update($, brief, now => mergeParsed(now, parsed, at))
  } catch {
    // Observer only: a parser failure never touches the turn.
  }
}

/** Dave's prompt answers every open ask. The mod's own report lines (the PR watcher) are not Dave. */
const answerAsks = async ($: EngineInterface, text: unknown): Promise<void> => {
  try {
    // The mod's own report lines are not activity of Dave's; any other prompt is.
    if (!(typeof text === 'string' && isModSubmission(text))) await touch($)
    const current = await read($, brief)
    if (current === null || (typeof text === 'string' && isModSubmission(text))) return
    const next = markAsksAnswered(current)
    if (next !== current) await update($, brief, () => next)
    if (await worthSnapshot($)) await writeSnapshot($, { working: true })
  } catch {
    // Observer only.
  }
}

type Proof = { trigger: 'start' | 'attach'; isInteractive: boolean; surface: string | null }

/**
 * Proof the plugin loaded, how the session started and where it draws.
 * last-session.json is one slot that any session overwrites, so it can only say what the newest session did.
 * sessions/<id>.<trigger>.json is one file per session and trigger: a start never hides an attach, and no
 * other session touches it. Read that one when you ask "did the desktop attach?".
 */
const writeProof = async ($: EngineInterface, proof: Proof, isSlot = true) => {
  const home = await homeDir($)
  if (!home) return
  const sessionId = await $.session.id().catch(() => null)
  const text = JSON.stringify({ at: new Date().toISOString(), ...proof, sessionId }, null, 2)
  if (isSlot) await $.fs.write(`${home}/${DIAG_DIR}/last-session.json`, text).catch(() => undefined)
  if (sessionId) await $.fs.write(`${home}/${DIAG_DIR}/sessions/${sessionId}.${proof.trigger}.json`, text).catch(() => undefined)
}

/** True once this session's first turn left its beacon. */
const turnBeaconed = atom({ plugin: 'ccv3-mods', key: 'turnBeaconed' } as const, false)

/**
 * A diagnostic that depends on nothing else in this module: written first, before the off check and any atom.
 * Desktop sessions left no proof at all (2026-10-12) and every write here swallows its error, so these files say
 * how far a session got: `enter` the start hook ran, `turn` the first turn began, `error` the start hook threw.
 * With no home directory it falls back to .claude/cache/e2e under the session's working folder, and says why.
 */
const beacon = async ($: EngineInterface, name: 'enter' | 'turn' | 'error', extra: Record<string, unknown> = {}) => {
  try {
    const [userProfile, home, entrypoint, off, sessionId] = await Promise.all([
      $.env.get('USERPROFILE'),
      $.env.get('HOME'),
      $.env.get('CLAUDE_CODE_ENTRYPOINT'),
      $.env.get('CCV3_MODS_OFF'),
      $.session.id().catch(() => null),
    ])
    // The off switch keeps the whole module inert, the beacon too.
    if (off === '1') return
    const base = userProfile ?? home
    const facts = { at: new Date().toISOString(), name, sessionId, entrypoint: entrypoint ?? null, hasUserProfile: userProfile !== undefined, hasHome: home !== undefined, ...extra }
    const id = sessionId ?? 'unknown'
    const primary = base ? `${base}/${DIAG_DIR}/sessions/${id}.${name}.json` : null
    const failure = primary ? await $.fs.write(primary, JSON.stringify({ ...facts, via: 'home' }, null, 2)).then(() => null, (err: unknown) => String(err)) : 'no home directory'
    if (failure === null) return
    await $.fs.write(`.claude/cache/e2e/beacon-${id}.${name}.json`, JSON.stringify({ ...facts, via: 'cwd', primaryFailed: failure }, null, 2))
  } catch {
    // A beacon never breaks the session.
  }
}

/**
 * The UI side of a session: /os, the 5 s pulse and the lane read. Runs at an interactive (REPL) start and when the
 * desktop app attaches: the desktop drives Claude Code through the SDK, so its sessions start headless with no
 * surface and the desktop joins later by `session.attach`. The pulse is armed once per environment.
 */
const startUi = async ($: EngineInterface) => {
  await update($, mode, () => 'interactive')
  await $.command
    .register({ name: 'os', description: 'Agentic OS pane: plan, tasks, current step, agents and lane of this session' })
    .catch(err => noteError($, 'os-register', err))
  if (!(await read($, uiArmed))) {
    await update($, uiArmed, () => true)
    $.clock.every(PULSE_MS, () => void pulse($))
  }
  void refreshLanes($)
}

export const agenticOs = (on: On) => {
  on('session.start', async ($, e, next) => {
    await beacon($, 'enter', { isInteractive: e.isInteractive, surface: e.surface ?? null })
    try {
      if (await isOff($)) return next(e)
      // A start (or a reload, which drops the old timers) re-arms the pulse.
      await update($, uiArmed, () => false)
      await update($, mode, () => (e.isInteractive ? 'interactive' : 'headless'))
      await writeProof($, { trigger: 'start', isInteractive: e.isInteractive, surface: e.surface ?? null })
      // Headless (a -p run, or the desktop app before it attaches): no pane, no timer, no process. Capture still runs.
      await registerBrief($)
      if (e.isInteractive) await startUi($)
      return next(e)
    } catch (err) {
      await beacon($, 'error', { where: 'session.start', message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })

  // A /clear or a resume in the same process starts a new conversation: the old tasks and plan are not its own.
  // The engine keeps the process, so these atoms would outlive the conversation (the HUD resets ctx and the cache the same way).
  for (const reason of ['clear', 'resume'] as const) {
    on('session.end', { reason }, async ($, e, next) => {
      if (!(await isOff($))) {
        await update($, tasks, () => [])
        await update($, plan, () => null)
        await update($, brief, () => null)
        await update($, refused, () => false)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    await writeProof($, { trigger: 'attach', isInteractive: false, surface: e.surface })
    await startUi($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Any other surface that attaches is only recorded, never drawn on. If the desktop app attaches under a name
  // the hook above does not match, this file is the one place it shows.
  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'desktop' && !(await isOff($))) await writeProof($, { trigger: 'attach', isInteractive: false, surface: e.surface }, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'os' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Agentic OS' })
    // The pane is up at once; the AGENTS and LANE rows fill in as the reads land.
    void Promise.all([refreshLanes($), refreshAgents($)]).then(() => writeSnapshot($))
    return { text: opened.isPlaced ? 'Agentic OS pane opened.' : `Agentic OS pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Agentic OS pane failed to open.' }))

  // No off check on command.run: with the mod off, session.start never registers /os, so it never fires.
  on('turn.start', async ($, e, next) => {
    if (await isOff($)) return next(e)
    if (!(await read($, turnBeaconed).catch(() => false))) {
      await beacon($, 'turn')
      await update($, turnBeaconed, () => true).catch(() => undefined)
    }
    const startedAt = await $.clock.now()
    await update($, turn, () => ({ id: e.turnId, startedAt }))
    await update($, activeAt, () => startedAt)
    // A new turn is a fresh start: last turn's refusal no longer blocks the chip.
    await update($, refused, () => false)
    if (await worthSnapshot($)) await writeSnapshot($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (await isOff($)) return next(e)
    const agentId = e.agentId
    if (agentId !== undefined) {
      const endedAt = await $.clock.now()
      const failed = e.isAborted || e.reason === 'error' || e.reason === 'aborted' || e.reason === 'refusal'
      await update($, agentRuns, runs => runs.map(run => (run.id === agentId ? settle(run, endedAt, failed) : run)))
      if (await worthSnapshot($)) await writeSnapshot($)
    }
    if (agentId === undefined) {
      await update($, turn, () => null)
      await update($, steps, () => [])
      await touch($)
      await learnFromAnswer($, e.answer)
      if (await worthSnapshot($)) await writeSnapshot($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (await isOff($)) return next(e)
    if (e.changed.includes('context') && e.context.percent !== undefined) {
      await update($, ctx, () => e.context.percent ?? null)
    }
    // The HUD's cost and limits. Here, not in hooks/hud: a plugin holds one unmatched hook per event.
    await update($, hud, now =>
      now === null
        ? now
        : { ...now, costUsd: e.cost?.usd ?? now.costUsd, limits: e.rateLimits.map(({ kind, percentUsed }) => ({ kind, percentUsed })) },
    )
    return next(e)
  })

  // Observer, never a gate: on a failure the call goes on as if unhooked.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || (await isOff($))) return next(e)
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    await update($, activeAt, () => startedAt)
    await update($, steps, list => [...list, { id, tool, label: stepLabel(input), startedAt }])
    const ran = await next(e)
    await update($, steps, list => list.filter(one => one.id !== id))
    // A refusal (not Dave dismissing his own question) blocks the chip until the next turn.
    if (ran.deny !== undefined && tool !== 'AskUserQuestion') await update($, refused, () => true)
    if (await record($, tool, input, ran)) await writeSnapshot($)
    refreshAfter($, tool, input)
    return ran
  }).catch(($, e, next) => next(e))

  // The mod's own tool. Matched, so it sits beside the one unmatched observer above.
  on('tool.call', { tool: BRIEF_TOOL }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    // The brief is the main session's. A subagent's call must not overwrite it.
    if (e.agentId !== undefined) return textResult('brief_set failed: only the main session sets the brief')
    return briefCall($, e)
  }).catch(($, e, next) => next(e))

  // The one unmatched prompt.submit hook of the plugin. Observer: the prompt goes on unchanged.
  on('prompt.submit', async ($, e, next) => {
    if (!(await isOff($))) await answerAsks($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    await read($, tick)
    const now = await view($)
    const hudNow = await read($, hud)
    const runs = await read($, agentRuns)
    // Finished runs alone don't keep the band up; a running one does.
    const quiet = isQuiet(now) && !runs.some(run => run.status === 'running')
    if (e.props.hasSurvey || (quiet && hudNow === null)) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const spansRow = (key: string, spans: Span[]) => (
      <Box key={key}>
        <Text wrap="truncate-end">
          {spans.map((span, i) => (
            <Text key={`s${i}`} {...TONE[span.tone]}>
              {span.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
    let hudRow = null
    if (hudNow !== null) {
      const parts = hudParts(hudNow, now.ctx, cacheView(await read($, cache), await $.clock.now()))
      // The terminal draws no Svg: its HUD is text gauges. Every other surface gets the rings and bars.
      if (e.surface === 'terminal' || !('Svg' in elements)) hudRow = spansRow('row-hud', hudSpans(parts))
      else {
        const { Svg } = elements
        const part = (one: HudPart) => {
          if (one.kind === 'chip') return <Text key={one.key} {...TONE[one.tone]}>{` ${one.text} `}</Text>
          if (one.kind === 'text') return <Text key={one.key} {...TONE[one.tone]}>{one.text}</Text>
          const source = one.kind === 'ring' ? ringSvg(one.percent, svgHex(one.tone), SVG_TRACK) : barSvg(one.percent / 100, svgHex(one.tone), SVG_TRACK)
          return (
            <Box key={one.key} flexDirection="row" alignItems="center" gap={1}>
              <Svg source={source} alt={one.label} width={one.kind === 'ring' ? 18 : 56} height={one.kind === 'ring' ? 18 : 6} />
              <Text {...TONE.dim}>{one.label}</Text>
            </Box>
          )
        }
        hudRow = (
          <Box key="row-hud" flexDirection="row" alignItems="center" gap={2} flexWrap="wrap">
            {parts.map(part)}
          </Box>
        )
      }
    }
    // With the HUD up, ctx lives in its ring, so the task row leaves it out.
    // One row of room: the HUD alone.
    const bandRow = quiet || (hudRow !== null && e.props.maxRows < 2)
      ? null
      : spansRow('row-band', bandSpans(hudNow === null ? now : { ...now, ctx: null }, await $.clock.now(), e.props.bodyColumns, ledgerBandSpans(runs)))
    if (hudRow === null) return bandRow ?? next(e)
    return (
      <Box flexDirection="column">
        {hudRow}
        {bandRow}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)
    const line = (spans: Span[]) => (
      <Text wrap="truncate-end">
        {spans.map((span, i) => (
          <Text key={`s${i}`} {...TONE[span.tone]}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
    // bodyRows is the engine's own measure of the body: frame rows less its border, tab and close rows.
    // paddingX takes one column each side.
    const rows = paneRows(await view($), await $.clock.now(), e.props.bodyColumns - 2, e.props.scroll.bodyRows)
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map(row => (
          <Box key={`row-${row.key}`} flexDirection="row" justifyContent="space-between">
            {line(row.left)}
            {row.right ? line(row.right) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
