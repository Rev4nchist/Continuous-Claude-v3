import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, BoardLane, CacheState, FileTouch, HudLimit, HudState, KeeperRecord, OsAgent, OsBrief, OsGit, OsLane, OsPlan, OsStep, OsSteward, OsTask, OsTurn, PrWatch, WorkflowFeed } from '../../types'
import { EMPTY_CACHE, cacheView, hitRate } from '../hud/cache'
import { hudParts, hudSpans } from '../hud/model'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { ledgerBandSpans, settle } from '../agent-ledger/model'
import type { AgentStatus } from 'claude-code'
import type { HudPart } from '../hud/model'
import { barSvg, ringSvg } from '../shared/glyphs'
import { answersAsks, applyBrief, briefSummary, countWaitTasks, deriveChip, isModSubmission, markAsksAnswered, mergeParsed, parseTurnEnd, redact, tapDecisions, waitLapsed, withTaps } from './brief'
import type { WaitTask } from './brief'
import { hudOrSeed, seedHud } from '../hud/seed'
import { bandLines, compactLine } from './band-model'
import type { BandState } from './band-model'
import { gitInfo } from './gitinfo'
import { SVG_TRACK, TONE, svgHex } from '../shared/tones'
import { addTask, isQuiet, patchTask, planTitle, stepLabel, tasksFromTodos } from './model'
import type { OsView } from './model'
import { parseBoard } from './lanes-model'
import { swarmGroups } from './workflow-model'
import { JOURNAL_MAX_BYTES, journalPath, projectSlug, runFilePath, workflowFeed } from './journal-model'
import { osPane, isTabId } from './os-tabs-model'
import type { TabId, TabState } from './os-tabs-model'
import { bandSpans } from './pane-model'
import type { Span, Tone } from './pane-model'
import { drift, observe } from './steward'
import type { Activity, Drift } from './steward'

const tasks = atom({ plugin: 'ccv3-mods', key: 'tasks' } as const, [] as OsTask[])
const plan = atom({ plugin: 'ccv3-mods', key: 'plan' } as const, null as OsPlan | null)
const turn = atom({ plugin: 'ccv3-mods', key: 'turn' } as const, null as OsTurn | null)
const steps = atom({ plugin: 'ccv3-mods', key: 'steps' } as const, [] as OsStep[])
const ctx = atom({ plugin: 'ccv3-mods', key: 'ctx' } as const, null as number | null)
const agents = atom({ plugin: 'ccv3-mods', key: 'agents' } as const, [] as OsAgent[])
/** This session's lanes, from the lane board's `mine` subset (band and compact keeper read them). */
const lanes = atom({ plugin: 'ccv3-mods', key: 'lanes' } as const, null as OsLane[] | null)
/** Every lane the lane board listed at the last good read (the Work tab), and when that read happened. Written by refreshLanes only. */
const board = atom({ plugin: 'ccv3-mods', key: 'board' } as const, null as BoardLane[] | null)
const boardAt = atom({ plugin: 'ccv3-mods', key: 'boardAt' } as const, null as number | null)
/** 'no-board' when the last read said the session folder has no lane board (it is not registered); null after a good read or before any. Written by refreshLanes only. */
const boardState = atom({ plugin: 'ccv3-mods', key: 'boardState' } as const, null as 'no-board' | null)
/** What lane.mjs prints (stderr, exit 1) when the folder it runs in has no lane board (projectOf in scripts/coordination/lane.mjs). */
const NO_BOARD_STDERR = 'no lane board for'
/** Touched Files (hooks/touched-files) and the keeper's compaction records (hooks/compact-keeper). Read only here: the same atoms those hooks declare and write. */
const files = atom({ plugin: 'ccv3-mods', key: 'files' } as const, [] as FileTouch[])
const compactions = atom({ plugin: 'ccv3-mods', key: 'compactions' } as const, [] as KeeperRecord[])
/** The PRs the pr-loop module watches. Read only here: the same atom pr-loop declares and writes. */
const prs = atom({ plugin: 'ccv3-mods', key: 'prs' } as const, [] as PrWatch[])
/** The journal feed of this session's workflow runs (the Swarm tab): a label and a phase per helper, and the run name. Written by refreshWorkflows only. */
const workflows = atom({ plugin: 'ccv3-mods', key: 'workflows' } as const, [] as WorkflowFeed[])
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

/**
 * Fix 5, the system wait: the background tasks (id and type only) the last main-agent Stop listed, and when each id was FIRST seen.
 * The age of a task runs from its first sight and a later Stop never renews it. A turn start, a prompt and a SessionStart empty the list;
 * only a SessionStart also empties the first-seen map (a turn start comes before every Stop, so clearing it there would renew every shell's age).
 * Never the description, command, prompt or server text of a task: free text, and the mod puts nothing of it on screen or in a file.
 */
const bgTasks = atom({ plugin: 'ccv3-mods', key: 'bgTasks' } as const, [] as WaitTask[])
const bgSeen = atom({ plugin: 'ccv3-mods', key: 'bgSeen' } as const, {} as Record<string, number>)
/**
 * Bumped by every clear, before the clear's first await. A Stop reads it before `await next(e)` and writes only if it did not move: a clear that lands
 * while the settings hooks run is never overwritten by the late write. A module variable, not an atom: the engine resets atoms after session.end.
 */
let bgGen = 0

/** Repo, branch and worktree of the session folder: read from the .git files at the session start and at each turn start. */
const git = atom({ plugin: 'ccv3-mods', key: 'git' } as const, null as OsGit | null)

/**
 * The Claude Code session name (`/rename`, `--name`): the band draws it before `#sid8`. Set from `session_title` of classic.SessionStart and
 * classic.UserPromptSubmit, else from the identity file (`~/.claude/state/identity/<uuid>.json`, written by the heartbeat hook). Null: unnamed.
 */
const sessionName = atom({ plugin: 'ccv3-mods', key: 'sessionName' } as const, null as string | null)

/** The tab the /os pane shows. Only a live tab is ever stored (a Comms or Resources tab has no Button); reset at /clear and resume. */
const osTab = atom({ plugin: 'ccv3-mods', key: 'osTab' } as const, 'overview' as TabId)

/**
 * What the steward (steward.ts) keeps: the counts since the last brief_set (`briefAt` is its time; only briefCall moves
 * it, the turn-end parser does not). Watch only: nothing of it goes to the model. Reset at session.start, /clear and resume.
 */
const NO_ACTIVITY: Activity = { toolCalls: 0, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 }
const FRESH_STEWARD: OsSteward = { briefAt: null, activity: NO_ACTIVITY }
const steward = atom({ plugin: 'ccv3-mods', key: 'steward' } as const, FRESH_STEWARD)

/** The id of the session whose final snapshot (with `endedAt`) is written. The atom survives a plugin reload; `endedIds` survives the engine's atom reset. */
const endedId = atom({ plugin: 'ccv3-mods', key: 'endedId' } as const, null as string | null)
/**
 * The ids whose final snapshot this process wrote or began. The engine resets the plugin's atoms after session.end (E2E 2026-10-30),
 * so `endedId` is null again when a write that began before the end reaches its check. This set is not reset (the pattern of
 * `endedHere` in hooks/hud/seed.ts). A plugin reload drops it; the atom still holds the last id then. A resume back to an ended id removes it (classic.SessionStart).
 */
const endedIds = new Set<string>()

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

/** The name in this session's identity file, or null (no file, no name, bad JSON). `CCV3_IDENTITY_DIR` moves the folder (tests). */
const identityName = async ($: EngineInterface, id: string): Promise<string | null> => {
  try {
    const home = await homeDir($)
    const dir = (await $.env.get('CCV3_IDENTITY_DIR')) ?? (home ? `${home}/.claude/state/identity` : null)
    if (dir === null) return null
    const name = (JSON.parse(await $.fs.read(`${dir}/${id}.json`)) as { name?: unknown } | null)?.name
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null
  }
}

/** Keeps the session name from a hook's `session_title`, else from the identity file. Finds none: the last name stays. Never throws. */
const noteName = async ($: EngineInterface, title: unknown): Promise<void> => {
  try {
    const given = typeof title === 'string' && title.trim() !== '' ? title.trim() : null
    const name = given ?? (await identityName($, await $.session.id()))
    if (name !== null) await update($, sessionName, () => name)
  } catch {
    // Observer only: the band reads unnamed.
  }
}

/**
 * classic.SessionStart: run the settings hooks first (next(e)), then read the name. session-register hands an auto-name back as
 * hookSpecificOutput.sessionTitle, which the engine folds into the result's top-level sessionTitle (ClassicResult), and that only exists after next(e). The read sits in try/catch and the result is returned
 * as it came: a throw after next(e) would reach the outer .catch, which runs the settings hooks a second time.
 */
const readNameAfter = async <E extends { session_title?: unknown }, R extends { sessionTitle?: string } | undefined>(
  $: EngineInterface,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> => {
  const result = await next(e)
  try {
    if (!(await isOff($))) await noteName($, e.session_title ?? result?.sessionTitle)
  } catch {
    // Observer only: the band reads the name at the next prompt.
  }
  return result
}

const BAND_LOG = '.claude/state/agentic-os/band-debug.log'
const BAND_LOG_LINES = 200

/**
 * CCV3_MOD_BAND_DEBUG=1: one JSON line per band render, the newest 200 kept. Numbers and booleans only: no goal, path or name.
 * Off by default. A failed write never touches the render, and nothing goes to the session.
 */
const logBand = async ($: EngineInterface, entry: Record<string, number | boolean>): Promise<void> => {
  try {
    if ((await $.env.get('CCV3_MOD_BAND_DEBUG')) !== '1') return
    const home = await homeDir($)
    if (!home) return
    const path = `${home}/${BAND_LOG}`
    const old = await $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '')
    const kept = old.split('\n').filter(line => line.trim() !== '').slice(-(BAND_LOG_LINES - 1))
    await $.fs.write(path, `${[...kept, JSON.stringify(entry)].join('\n')}\n`)
  } catch {
    // Diagnostics only.
  }
}

/** Leaves ~/.claude/state/ccv3-mods/errors/<time>-<where>.json, so a failure no one sees still says what broke. */
const noteError = async ($: EngineInterface, where: string, err: unknown) => {
  const home = await homeDir($)
  if (home) await $.fs.write(`${home}/${DIAG_DIR}/${errorFile(where)}`, errorText(where, err)).catch(() => undefined)
}

/**
 * Live agents for the pane: the one source for the AGENTS rows, NOW and the chip. The `agents` atom (agent.list) is
 * authoritative for an id it holds. The Agent Ledger adds a running run the list lacks, because the list is only re-read
 * while a turn or a step runs. A settled run leaves the atom at turn.complete; turn.start reopens it if the agent resumes.
 */
const liveAgents = async ($: EngineInterface): Promise<OsAgent[]> => {
  const runs = await read($, agentRuns)
  const listed = await read($, agents)
  const known = new Set(listed.map(agent => agent.id))
  const running = runs.filter(run => run.status === 'running' && !known.has(run.id)).map(({ id, description, type }) => ({ id, description, type, status: 'running' }))
  return [...listed, ...running]
}

const view = async ($: EngineInterface): Promise<OsView> => ({
  tasks: await read($, tasks),
  plan: await read($, plan),
  turn: await read($, turn),
  step: (await read($, steps)).at(-1) ?? null,
  ctx: await read($, ctx),
  agents: await liveAgents($),
  lanes: await read($, lanes),
  prs: await read($, prs),
})

/**
 * The chip, one way for the snapshot and the band, so the two cannot disagree. One difference, on purpose: `forFile` (the state file) leaves the system wait out.
 * `working`: Dave's prompt just arrived, so a turn is about to start and the chip leaves waiting-on-dave at once.
 * `except`: the call that is writing (brief_set is itself a running step while its handler answers).
 */
const chipNow = async ($: EngineInterface, now: OsView, at: number, opts: { working?: boolean; except?: string; forFile?: boolean } = {}) =>
  deriveChip({
    brief: await read($, brief),
    tasks: now.tasks,
    toolRunning: (await read($, steps)).some(one => one.id !== opts.except),
    dialogOpen: (await read($, steps)).some(one => one.id !== opts.except && one.tool === 'AskUserQuestion'),
    turnActive: now.turn !== null || opts.working === true,
    blocked: await read($, refused),
    now: at,
    activeAt: await read($, activeAt),
    agentRuns: now.agents.filter(agent => agent.status === 'running'),
    // The state file never holds waiting-on-work (the app reads five chips): `forFile` leaves the wait out.
    ...(opts.forFile === true ? {} : { bgTasks: await read($, bgTasks), bgSeen: await read($, bgSeen) }),
  })

/** Fix 5: empties the task list (and, at a SessionStart, the first-seen map). The bump comes first, so a Stop that is waiting for next(e) sees it. Never throws. */
const clearWait = async ($: EngineInterface, forget: boolean): Promise<void> => {
  try {
    bgGen += 1
    if (await isOff($)) return
    await update($, bgTasks, () => [])
    if (forget) await update($, bgSeen, () => ({}))
  } catch {
    // Observer only.
  }
}

const MAX_WAIT_TASKS = 50

/** The id and the type of each task a Stop lists; an entry with no id or no type is skipped. Nothing else of the entry is read. */
const taskIds = (list: unknown[]): WaitTask[] => {
  const found = new Map<string, WaitTask>()
  for (const one of list) {
    const id = (one as { id?: unknown } | null)?.id
    const type = (one as { type?: unknown } | null)?.type
    if (typeof id !== 'string' || id === '' || id.length > 100 || typeof type !== 'string') continue
    if (!found.has(id) && found.size < MAX_WAIT_TASKS) found.set(id, { id, type: type.slice(0, 40) })
  }
  return [...found.values()]
}

/**
 * The write of a main-agent Stop: the tasks it lists, each with its first-seen time (an id seen before keeps its time; an id the Stop no longer lists is forgotten).
 * `gen` is the counter read before next(e): a clear that landed since wins. Both updaters check it, so no await sits between the check and the write.
 * A missing or non-array list changes nothing (an old engine). Never throws.
 */
const noteWait = async ($: EngineInterface, list: unknown, gen: number): Promise<void> => {
  try {
    if (!Array.isArray(list) || (await isOff($))) return
    const at = await $.clock.now()
    const tasks = taskIds(list)
    await update($, bgSeen, seen => (gen !== bgGen ? seen : Object.fromEntries(tasks.map(one => [one.id, Object.hasOwn(seen, one.id) ? (seen[one.id] ?? at) : at]))))
    await update($, bgTasks, before => (gen !== bgGen ? before : tasks))
  } catch {
    // Observer only: the band keeps what it had.
  }
}

/**
 * Repo, branch and worktree from the .git files of the session folder: file reads only, no process.
 * Never throws; any failure leaves the three fields null.
 */
const refreshGit = async ($: EngineInterface): Promise<void> => {
  try {
    const cwd = await $.session.cwd().catch(() => $.session.root())
    const found = await gitInfo(cwd, path => $.fs.read(path).then(text => (typeof text === 'string' ? text : null), () => null))
    await update($, git, () => found)
  } catch {
    await update($, git, () => null).catch(() => undefined)
  }
}

/** The part of the HUD the state file carries (cost and limits). The atom only: a seed read here would use up the retries HS7 and M7 count. The atom is null for a headless run, with the HUD off, or on a resume before the seed (an interactive start fills it through hooks/hud session.start); a null atom writes null. A limit kind is redacted, then clipped; a value that is not a finite number is null (cost) or drops the limit. */
export const hudForState = (
  state: HudState | null,
): { costUsd: number | null; model: string | null; effort: string | null; advisorCalls: number | null; limits: HudLimit[] } | null =>
  state === null
    ? null
    : {
        costUsd: typeof state.costUsd === 'number' && Number.isFinite(state.costUsd) ? state.costUsd : null,
        // The model, the effort and the advisor count are what the HUD row draws: the app reads them from the file too (status band review, fix 9).
        model: typeof state.model === 'string' && state.model !== '' ? redact(state.model).text.slice(0, 60) : null,
        effort: typeof state.effort === 'string' && state.effort !== '' ? redact(state.effort).text.slice(0, 60) : null,
        advisorCalls: typeof state.advisor?.calls === 'number' && Number.isFinite(state.advisor.calls) ? state.advisor.calls : null,
        limits: (Array.isArray(state.limits) ? state.limits : [])
          .filter(limit => limit != null && typeof limit.percentUsed === 'number' && Number.isFinite(limit.percentUsed))
          .slice(0, 8)
          .map(limit => ({
            kind: redact(String(limit.kind)).text.slice(0, 60),
            percentUsed: limit.percentUsed,
            ...(typeof limit.resetsAt === 'string' && limit.resetsAt !== '' ? { resetsAt: limit.resetsAt.slice(0, 40) } : {}),
          })),
      }

/**
 * One JSON file per session under ~/.claude/state/agentic-os/: the read side
 * for the web dashboard (Slice 2) and the evidence for headless probes.
 * A failed write never touches the session.
 * `end` is the final snapshot of a session that ends: its id and time, and `endedAt` in the file. Every other write for that id is
 * refused once the end began (the pulse, a turn end, /os). The check runs right before the write because the /os write waits on a
 * lane read. It guarantees: a write that reaches its check after the end began does not land. It does not guarantee: a file write
 * already handed to the filesystem when the end begins is not recalled; that one can still land first and the final write follows.
 */
const writeSnapshot = async ($: EngineInterface, opts: { working?: boolean; except?: string; end?: { sessionId: string; at: number } } = {}): Promise<void> => {
  try {
    const home = await homeDir($)
    if (!home) return
    const sessionId = opts.end?.sessionId ?? (await $.session.id())
    const at = opts.end?.at ?? (await $.clock.now())
    const now = await view($)
    const current = await read($, brief)
    const chip = await chipNow($, now, at, { ...opts, forFile: true })
    const where = await read($, git)
    const snapshot = {
      sessionId,
      at,
      ...now,
      agentRuns: await read($, agentRuns),
      cache: await read($, cache),
      hud: hudForState(await read($, hud)),
      brief: current,
      chip,
      repo: where?.repo ?? null,
      branch: where?.branch ?? null,
      worktree: where?.worktree ?? null,
      ...(opts.end ? { endedAt: opts.end.at } : {}),
    }
    const endedAtom = opts.end === undefined ? await read($, endedId) : null
    if (opts.end === undefined && (endedIds.has(sessionId) || sessionId === endedAtom)) return
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

/** The final write needs this much of the session.end bound (1.5 s, shared with every other hook): less, and the web falls back to the database's ended_at. */
const FINAL_WRITE_MIN_MS = 300

/**
 * One last snapshot of the ending session, with `endedAt` = its time, under the ending id (`e.sessionId`: after a /clear or a resume
 * `$.session.id()` is already the next one). Runs before the /clear and resume resets, so the file keeps that conversation's brief.
 * `endedIds` and `endedId` are set first, so a write that has not reached its check yet cannot land after the final file.
 */
const writeFinalSnapshot = async ($: EngineInterface, sessionId: string, remainingMs: number): Promise<void> => {
  try {
    if (remainingMs <= FINAL_WRITE_MIN_MS || !(await worthSnapshot($))) return
    const at = await $.clock.now()
    endedIds.add(sessionId)
    await update($, endedId, () => sessionId)
    await writeSnapshot($, { end: { sessionId, at } })
  } catch {
    // Observer only: a snapshot is best effort.
  }
}

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
    // A subagent turn.start set `running` before the list says so. A list that still says `waiting` is older than that
    // start: keep `running` until the agent's own turn.complete removes the entry or the list shows it ended.
    await update($, agents, previous =>
      live.map(one => (one.status === 'waiting' && previous.some(before => before.id === one.id && before.status === 'running') ? { ...one, status: 'running' } : one)),
    )
  } catch {
    // Best effort: the pane keeps the last list.
  }
}

/**
 * Reads the lane board of the session's current folder (every open lane on that board, not only this session's), when the CCv3 checkout is there.
 * The board follows the folder: the script is the absolute primary lane.mjs, and `cwd` is passed explicitly (`$.session.cwd()`; the engine default is the
 * same folder, this pins it after a cd), so lane.mjs resolves the board from the registry. The one place that spawns lane.mjs, so the headless gate sits here.
 * A good read writes the `lanes` atom (this session's lanes: the band and the compact keeper read it), the `board` atom (all lanes of that board: the Work tab),
 * the time of the read, and clears `boardState`. Exit 1 with "no lane board for" in stderr (the folder is not registered) is a state, not a failure:
 * it clears `board` and `lanes` and sets `boardState` to 'no-board', so the Work tab says so instead of showing the last board. Any other failed read
 * writes nothing, so the pane keeps the last good board and says how old it is.
 */
const refreshLanes = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await read($, mode)) !== 'interactive') return
    const home = await homeDir($)
    const script = `${home}/continuous-claude/scripts/coordination/lane.mjs`
    if (!home || !(await $.fs.exists(script))) return
    const sessionId = await $.session.id()
    const cwd = await $.session.cwd().catch(() => null)
    const run = await $.process.run(['node', script, 'board', '--json', '--as', sessionId], { timeoutMs: 5000, ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}) })
    const at = await $.clock.now()
    if (run.exitCode === 1 && run.stderr.includes(NO_BOARD_STDERR)) {
      await update($, lanes, () => [])
      await update($, board, () => null)
      await update($, boardAt, () => at)
      await update($, boardState, () => 'no-board')
      return
    }
    const parsed = run.exitCode === 0 ? parseBoard(run.stdout, sessionId, at) : null
    if (parsed === null) return
    await update($, lanes, () => parsed.mine)
    await update($, board, () => parsed.lanes)
    await update($, boardAt, () => at)
    await update($, boardState, () => null)
  } catch {
    // Best effort: no board, no DB, or no node; the pane says "lane board not read".
  }
}

/** The workflow runs whose journals one refresh reads (running first, then the latest activity, as the Swarm tab draws them): each costs two file stats and at most two reads. */
const MAX_FEED_RUNS = 8

/** A file's text, or null when it is missing, not a file, over the size cap or unreadable. The size is checked first, so a huge file is never copied in. */
const readCapped = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file' || stat.size > JOURNAL_MAX_BYTES) return null
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Reads the journal (and, once a run has ended, the run file) of each workflow run the ledger holds, for the Swarm tab: a label and a phase per
 * helper, and the run name. Called at /os open and at a press of Swarm only, never by the pulse. The project folder is the session folder's path
 * as Claude Code names it; the working folder and the session root are both tried. A file that is missing or bad leaves its run with no feed, and
 * the tab then draws counts only. Never throws: the pane does not wait for it.
 */
const refreshWorkflows = async ($: EngineInterface): Promise<void> => {
  try {
    const home = await homeDir($)
    const ids = swarmGroups(await read($, agentRuns)).flows.map(flow => flow.progress.key).slice(0, MAX_FEED_RUNS)
    const before = await read($, workflows)
    if (!home || (ids.length === 0 && before.length === 0)) return
    const sessionId = await $.session.id()
    const folders = [await $.session.cwd().catch(() => null), await $.session.root().catch(() => null)]
    const slugs = [...new Set(folders.filter((one): one is string => typeof one === 'string' && one !== '').map(projectSlug))]
    const found: WorkflowFeed[] = []
    for (const id of ids) {
      for (const slug of slugs) {
        const journalAt = journalPath(home, slug, sessionId, id)
        const runAt = runFilePath(home, slug, sessionId, id)
        const journal = journalAt === null ? null : await readCapped($, journalAt)
        const runFile = runAt === null ? null : await readCapped($, runAt)
        const feed = workflowFeed(id, journal, runFile)
        if (feed === null) continue
        found.push(feed)
        break
      }
    }
    // An unchanged feed writes nothing, so the pane does not redraw for it.
    if (JSON.stringify(found) !== JSON.stringify(before)) await update($, workflows, () => found)
  } catch {
    // Best effort: the tab keeps the last feed, or draws counts only.
  }
}

/**
 * While a turn runs: redraw elapsed times and re-read the agents. Idle: one redraw a minute, for the cache countdown.
 * Idle with a running ledger run or a listed agent that runs: also re-read the agents, so a run the list holds as ended settles. Idle without one: no read.
 */
const pulse = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  if ((await read($, turn)) === null && (await read($, steps)).length === 0) {
    if ((await read($, cache)).lastUsedAt !== null && now - (await read($, tick)) >= IDLE_PULSE_MS) await update($, tick, () => now)
    // A counted task that passed its age limit in the last minute: the band redraws (nothing else would, and the chip reads the clock only when it draws).
    if (waitLapsed(await read($, bgTasks), await read($, bgSeen), now - IDLE_PULSE_MS, now)) await update($, tick, () => now)
    if ((await read($, agentRuns)).some(run => run.status === 'running') || (await read($, agents)).some(one => one.status === 'running')) await refreshAgents($)
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
  const prev = await read($, brief)
  // Two saves in one millisecond must differ: updatedAt orders the brief's saves.
  const at = Math.max(await $.clock.now(), (prev?.updatedAt ?? -1) + 1)
  const result = applyBrief(prev, raw, list, at)
  if ('error' in result) return textResult(`brief_set failed: ${result.error}`)
  await update($, brief, () => result.brief)
  // A brief_set is the one thing that restarts the steward's counts. The turn-end parser also moves updatedAt, so it is not the version.
  await update($, steward, state => ({ ...state, briefAt: result.brief.updatedAt, activity: NO_ACTIVITY }))
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
const answerAsks = async ($: EngineInterface, text: unknown, origin?: unknown): Promise<void> => {
  try {
    // The mod's own report lines are not activity of Dave's; any other prompt is.
    if (!(typeof text === 'string' && isModSubmission(text))) await touch($)
    // A cron tick, a peer message or a Monitor notification is not Dave: it answers nothing. It still counts as activity: the turn it starts
    // renews the 24 hour clock through turn.start and tool.call anyway, so withholding the touch here would change nothing.
    if (!answersAsks(origin as { kind?: unknown } | null | undefined)) return
    // The clock is read before the brief: no await sits between that read and the update, so a brief_set or a parsed turn end
    // that lands while the clock answers is not overwritten. The update is a function of the live brief for the same reason.
    const at = await $.clock.now()
    const current = await read($, brief)
    if (current === null || (typeof text === 'string' && isModSubmission(text))) return
    if (markAsksAnswered(current, at) !== current) await update($, brief, now => (now === null ? now : markAsksAnswered(now, at)))
    if (await worthSnapshot($)) await writeSnapshot($, { working: true })
  } catch {
    // Observer only.
  }
}

/**
 * A tap in a model AskUserQuestion dialog: one decision per answered question (GPAA P3). Observer only, with its own try/catch:
 * a throw here must not reach the tool.call `.catch`, which would call `next` a second time.
 * `$.ui.ask` dialogs of this mod (PR checkpoint, Land) pass through every other hook, this one too, with `origin.plugin` set to the
 * caller; they are skipped (their answers go to ask-dialogs.jsonl). Only the result is read: the call input is model-written.
 */
export const captureTaps = async ($: EngineInterface, origin: { plugin: string; tier?: string }, ran: Result): Promise<void> => {
  try {
    if (origin.plugin !== 'engine') return
    const texts = tapDecisions(okResult(ran))
    if (texts.length === 0) return
    // A headless run with no brief writes no file: nothing prunes the folder.
    if ((await read($, brief)) === null && (await read($, mode)) !== 'interactive') return
    const at = await $.clock.now()
    await update($, brief, now => withTaps(now, texts, at))
    await writeSnapshot($)
  } catch {
    // Observer only.
  }
}

/** HEAD before or after a call that may commit: one process, only for a commit-looking shell call in an interactive run. */
const headOf = async ($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<string | null> => {
  const command = typeof input.command === 'string' ? input.command : ''
  if ((tool !== 'Bash' && tool !== 'PowerShell') || !/\bcommit\b/.test(command) || (await read($, mode)) !== 'interactive') return null
  const run = await $.process.run(['git', 'rev-parse', 'HEAD'], { timeoutMs: 5000 }).catch(() => null)
  return run !== null && run.exitCode === 0 ? run.stdout.trim() || null : null
}

/** CCV3_MOD_STEWARD_OFF=1 stops the counting and the pane row. Read live, so it works mid-session. */
const stewardOff = async ($: EngineInterface): Promise<boolean> => (await $.env.get('CCV3_MOD_STEWARD_OFF')) === '1'

/** A main-loop call ran: the steward counts it. brief_set is the brief changing, not work. A refused call did not run. */
const watch = async ($: EngineInterface, tool: string, input: Record<string, unknown>, before: string | null, ran: Result): Promise<void> => {
  try {
    if (tool === BRIEF_TOOL || ran.deny !== undefined || (await stewardOff($))) return
    const after = before === null ? null : await headOf($, tool, input)
    const moved = after !== null && after !== before
    await update($, steward, state => ({ ...state, activity: observe(state.activity, tool, input, moved) }))
  } catch {
    // Observer only.
  }
}

/** The steward's verdict on the brief, for the pane. Null when the steward is switched off. Read-only: nothing is written or sent. */
const driftNow = async ($: EngineInterface): Promise<Drift | null> => {
  if (await stewardOff($)) return null
  const state = await read($, steward)
  return drift(await read($, brief), state.activity, state.briefAt ?? 0)
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
      await update($, steward, () => FRESH_STEWARD)
      await writeProof($, { trigger: 'start', isInteractive: e.isInteractive, surface: e.surface ?? null })
      // Headless (a -p run, or the desktop app before it attaches): no pane, no timer, no process. Capture still runs.
      await registerBrief($)
      await refreshGit($)
      // A /reload-plugins runs this start but no classic SessionStart or prompt: read the name from the identity file now.
      await noteName($, undefined)
      if (e.isInteractive) await startUi($)
      return next(e)
    } catch (err) {
      await beacon($, 'error', { where: 'session.start', message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })

  // Every end writes one last snapshot with `endedAt`, first: the file keeps the brief of the conversation that ends.
  // A /clear or a resume in the same process then starts a new conversation: the old tasks and plan are not its own.
  // The engine keeps the process, so these atoms would outlive the conversation (the HUD resets ctx and the cache the same way).
  on('session.end', async ($, e, next) => {
    if (!(await isOff($))) {
      await writeFinalSnapshot($, e.sessionId, next.budget.remainingMs)
      if (e.reason === 'clear' || e.reason === 'resume') {
        await update($, tasks, () => [])
        await update($, plan, () => null)
        await update($, brief, () => null)
        await update($, steward, () => FRESH_STEWARD)
        await update($, refused, () => false)
        await update($, osTab, () => 'overview')
        // The next conversation reads its own name at its SessionStart; the old one must not show meanwhile.
        await update($, sessionName, () => null)
        // The keeper's records belong to the conversation they watched: the new one has had no compaction.
        await update($, compactions, () => [])
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After an in-session resume or clear the engine wipes the atoms and fires classic.SessionStart, not session.start,
  // so the band lost repo and branch until the first turn. Read the .git files again on those two sources only.
  on('classic.SessionStart', { source: ['resume', 'clear'] }, async ($, e, next) => {
    try {
      // A resume can return to an id that ended earlier in this process: it is live again, so its file takes writes again.
      endedIds.delete(await $.session.id())
      await clearWait($, true)
      if (!(await isOff($))) await refreshGit($)
    } catch {
      // Observer only.
    }
    return readNameAfter($, e, next)
  }).catch(($, e, next) => next(e))

  // The session name, from every SessionStart (the resume and clear handler above reads it too) and every prompt: a /rename shows at the next prompt.
  // The hud module holds the unmatched classic.SessionStart, so these sources are matched.
  on('classic.SessionStart', { source: ['startup', 'compact', 'fork'] }, async ($, e, next) => {
    await clearWait($, true)
    return readNameAfter($, e, next)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    // The session runs again: the system wait is over (the next Stop writes it new). The first-seen times stay.
    await clearWait($, false)
    if (!(await isOff($))) await noteName($, e.session_title)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Fix 5: a MAIN-agent Stop lists the background work still in flight. Observer only: the settings hooks run first (next(e)), the result goes on
  // unchanged, and nothing is written when the result blocks (the turn goes on) or stops the session. A Stop that carries agent_id is a subagent's. The
  // write sits in noteWait, which never throws: a throw after next(e) would reach the .catch and run the settings hooks a second time.
  on('classic.Stop', async ($, e, next) => {
    const gen = bgGen
    const result = await next(e)
    if (e.agent_id === undefined && result?.block === undefined && result?.preventContinuation !== true) await noteWait($, e.background_tasks, gen)
    return result
  }).catch(($, e, next) => next(e))

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
    // The pane is up at once; the AGENTS, LANE and Swarm rows fill in as the reads land.
    void Promise.all([refreshLanes($), refreshAgents($), refreshWorkflows($)]).then(() => writeSnapshot($))
    return { text: opened.isPlaced ? 'Agentic OS pane opened.' : `Agentic OS pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Agentic OS pane failed to open.' }))

  // No off check on command.run: with the mod off, session.start never registers /os, so it never fires.
  on('turn.start', async ($, e, next) => {
    // A subagent's turn is not the main turn: its run shows through `agentRuns`, and it must not reset the refusal or the clock.
    if (await isOff($)) return next(e)
    const resumed = e.agentId
    if (resumed !== undefined) {
      // A settled run whose agent starts a turn again (a message resumes it under the same id) is running again.
      await update($, agentRuns, runs => runs.map(run => (run.id === resumed && run.status !== 'running' ? { ...run, status: 'running', endedAt: null } : run)))
      // The list can still hold it as waiting, and the list wins for an id it holds: the turn is the newer fact.
      await update($, agents, list => list.map(agent => (agent.id === resumed && agent.status !== 'running' ? { ...agent, status: 'running' } : agent)))
      return next(e)
    }
    if (!(await read($, turnBeaconed).catch(() => false))) {
      await beacon($, 'turn')
      await update($, turnBeaconed, () => true).catch(() => undefined)
    }
    await clearWait($, false)
    const startedAt = await $.clock.now()
    await update($, turn, () => ({ id: e.turnId, startedAt }))
    await update($, activeAt, () => startedAt)
    // A new turn is a fresh start: last turn's refusal no longer blocks the chip.
    await update($, refused, () => false)
    // A branch switch or a new worktree shows at the next turn: two small file reads, no process.
    await refreshGit($)
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
      await update($, agents, list => list.filter(agent => agent.id !== agentId))
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
    // A resumed session has no HUD yet: seed it first, so the measured cost and limits go over the seed.
    await seedHud($)
    const before = JSON.stringify(await read($, hud))
    await update($, hud, now =>
      now === null
        ? now
        : { ...now, costUsd: e.cost?.usd ?? now.costUsd, limits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) })) },
    )
    // The engine measures after the turn-end snapshot, so an idle session's file would keep the last turn's cost and limits.
    if (JSON.stringify(await read($, hud)) !== before && (await worthSnapshot($))) await writeSnapshot($)
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
    const headBefore = await headOf($, tool, input).catch(() => null)
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      await update($, steps, list => list.filter(one => one.id !== id)).catch(() => undefined)
    }
    await watch($, tool, input, headBefore, ran)
    // A refusal (not Dave dismissing his own question) blocks the chip until the next turn.
    if (ran.deny !== undefined && tool !== 'AskUserQuestion') await update($, refused, () => true)
    if (await record($, tool, input, ran)) await writeSnapshot($)
    if (tool === 'AskUserQuestion') await captureTaps($, next.origin, ran)
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
    if (!(await isOff($))) await answerAsks($, e.text, (e as { origin?: unknown }).origin)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    await read($, tick)
    const now = await view($)
    // A render cannot write the atom: with none set (no session.start ran) it draws a seed, and a measure or step stores it.
    const hudNow = await hudOrSeed($)
    const runs = await read($, agentRuns)
    // Finished runs alone don't keep the band up; a running one does.
    const quiet = isQuiet(now) && !runs.some(run => run.status === 'running')
    // The core lines draw even when the session is quiet: GOAL not set is visible on purpose (PRD 5.5), from 40 columns up.
    // Under 40 columns the compact line (chip, ctx, 5h, 7d) takes the place of the narrow chip-and-goal line, so ctx never leaves the band; GOAL does.
    if (e.props.hasSurvey || e.props.maxRows < 1) return next(e)
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
    const at = await $.clock.now()
    const bandState: BandState = {
      chip: await chipNow($, now, at),
      brief: await read($, brief),
      tasks: now.tasks,
      repo: (await read($, git))?.repo ?? null,
      who: { name: await read($, sessionName), short: (await $.session.id().catch(() => null))?.slice(0, 8) ?? null },
      lane: now.lanes?.[0]?.id ?? null,
      laneTitle: now.lanes?.[0]?.title ?? null,
      laneCount: now.lanes?.length ?? 0,
      ctx: now.ctx,
      costUsd: hudNow?.costUsd ?? null,
      now: at,
      activeAt: await read($, activeAt),
      helpers: runs.filter(run => run.status === 'running').length,
      limits: hudNow?.limits ?? null,
      waitTasks: countWaitTasks(await read($, bgTasks), await read($, bgSeen), at),
      // The HUD row draws ctx and cost below the core lines: line 1 leaves them out then (one source, drawn once).
      hud: hudNow !== null,
    }
    const cores = bandLines(bandState, e.props.bodyColumns)
    // The core lines (PRD 5.3) draw when they fit with the HUD row: two lines + HUD = 3 rows (HUD off: 2). Under 40 columns there is one
    // narrow core line with no ctx, so the compact line (it carries ctx, 5h and 7d) takes its place at every budget, HUD up or off.
    // Less room: ONE compact line, then the HUD row after it.
    const fullRows = cores.length === 2 ? (hudNow === null ? 2 : 3) : Infinity
    const lines = e.props.maxRows >= fullRows ? cores : [compactLine(bandState, e.props.bodyColumns)]
    // Rows, in this priority: the core lines, then the HUD row, then the widget line, both below them.
    // Rows come from the lines actually drawn: under 40 columns there is one core line, and its spare row goes to the HUD.
    const coreRows = lines.length
    const spare = e.props.maxRows - coreRows
    let hudRow = null
    if (hudNow !== null && spare >= 1) {
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
    // The widget line below keeps the pre-core band (plan title, task progress, the step, PRs, agents) under its old key.
    // With the HUD up, ctx lives in its ring, so the widget line leaves it out (line 1 shows it too). Its row comes after the HUD and the core lines.
    const widgetRoom = spare - (hudRow === null ? 0 : 1)
    const bandRow = quiet || widgetRoom < 1 ? null : spansRow('row-band', bandSpans(hudNow === null ? now : { ...now, ctx: null }, at, e.props.bodyColumns, ledgerBandSpans(runs)))
    await logBand($, { maxRows: e.props.maxRows, bodyColumns: e.props.bodyColumns, hudNow: hudNow !== null, quiet, lines: coreRows + (hudRow === null ? 0 : 1) + (bandRow === null ? 0 : 1) })
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => spansRow(`row-core-${i + 1}`, line))}
        {hudRow}
        {bandRow}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const stored = await read($, osTab)
    const selected: TabId = isTabId(stored) ? stored : 'overview'
    const { Box, Text, Button } = $.ui.resolve(e)
    const spans = (list: Span[], prefix: string) =>
      list.map((span, i) => (
        <Text key={`${prefix}${i}`} {...TONE[span.tone]}>
          {span.text}
        </Text>
      ))
    const line = (list: Span[]) => <Text wrap="truncate-end">{spans(list, 's')}</Text>
    const now = await view($)
    const at = await $.clock.now()
    const where = await read($, git)
    // The same source as the band (the atom, else a seed read once), so the ROOM section and the band agree on cost and limits.
    const hudState = await hudOrSeed($)
    const state: TabState = {
      view: now,
      chip: await chipNow($, now, at),
      brief: await read($, brief),
      repo: where?.repo ?? null,
      branch: where?.branch ?? null,
      worktree: where?.worktree ?? null,
      costUsd: hudState?.costUsd ?? null,
      activeAt: await read($, activeAt),
      drift: await driftNow($),
      // The briefing's long-running and finished-run rows need the run times, which the agents list does not hold.
      agentRuns: await read($, agentRuns),
      // The Session and Work tabs: the keeper's records, the lane board and the age of its last good read, the touched files, cache use and the allowance.
      compactions: await read($, compactions),
      board: await read($, board),
      boardAt: await read($, boardAt),
      boardState: await read($, boardState),
      files: await read($, files),
      cachePct: hitRate(await read($, cache)),
      limits: hudState?.limits ?? [],
      // The Swarm tab: the journal feed of the workflow runs, read at /os open and at a press of Swarm.
      feed: { workflows: await read($, workflows) },
    }
    // bodyRows is the engine's own measure of the body: frame rows less its border, tab and close rows.
    // paddingX takes one column each side.
    const { strip, body, footer } = osPane(selected, state, at, e.props.bodyColumns - 2, e.props.scroll.bodyRows)
    // Every tab is a Button (a press, or its digit while the pane has the focus). The board is read at /os and at a press of Work, the agents and journals at a press of Swarm, so they are not stale when Dave looks.
    const select = (id: TabId) => () => {
      void update($, osTab, () => id)
      if (id === 'work') void refreshLanes($)
      // A workflow helper is not in agent.list, but a plain one is: the list settles a run it holds as ended. The journal is read now, never by the pulse.
      if (id === 'swarm') {
        void refreshAgents($)
        void refreshWorkflows($)
      }
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        {strip.map((items, i) => (
          <Box key={`row-tabs-${i}`} flexDirection="row" gap={1}>
            {items.map(item =>
              isTabId(item.id) ? (
                <Button key={`tab-${item.id}`} plain hotkey={item.hotkey} onPress={select(item.id)}>
                  {spans(item.spans, 't')}
                </Button>
              ) : null,
            )}
          </Box>
        ))}
        {body.map(row => (
          <Box key={`row-${row.key}`} flexDirection="row" justifyContent="space-between">
            {line(row.left)}
            {row.right ? line(row.right) : null}
          </Box>
        ))}
        {footer ? (
          <Box key="row-footer" flexDirection="row">
            {line(footer.left)}
          </Box>
        ) : null}
      </Box>
    )
  })
}
