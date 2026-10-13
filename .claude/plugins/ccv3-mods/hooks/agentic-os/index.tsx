import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, CacheState, HudState, OsAgent, OsLane, OsPlan, OsStep, OsTask, OsTurn, PrWatch } from '../../types'
import { EMPTY_CACHE, cacheView } from '../hud/cache'
import { hudParts, hudSpans } from '../hud/model'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { ledgerBandSpans, settle } from '../agent-ledger/model'
import type { AgentStatus } from 'claude-code'
import type { HudPart } from '../hud/model'
import { barSvg, ringSvg } from '../shared/glyphs'
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

const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')
/** True once this environment's pulse is armed; a start resets it, so a reload arms a fresh one. */
const uiArmed = atom({ plugin: 'ccv3-mods', key: 'uiArmed' } as const, false)

const PANE = 'agentic-os'
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
const writeSnapshot = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await homeDir($)
    if (!home) return
    const sessionId = await $.session.id()
    const snapshot = { sessionId, at: await $.clock.now(), ...(await view($)), agentRuns: await read($, agentRuns), cache: await read($, cache) }
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
  (await read($, mode)) === 'interactive' || (await read($, tasks)).length > 0 || (await read($, plan)) !== null

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
      if (e.isInteractive) await startUi($)
      return next(e)
    } catch (err) {
      await beacon($, 'error', { where: 'session.start', message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })

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
    await update($, steps, list => [...list, { id, tool, label: stepLabel(input), startedAt }])
    const ran = await next(e)
    await update($, steps, list => list.filter(one => one.id !== id))
    if (await record($, tool, input, ran)) await writeSnapshot($)
    refreshAfter($, tool, input)
    return ran
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
