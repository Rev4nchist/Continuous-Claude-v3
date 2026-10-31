export type OsTaskStatus = 'pending' | 'in_progress' | 'completed'

export type OsTask = {
  id: string
  subject: string
  status: OsTaskStatus
  activeForm?: string
}

/** Where a brief value came from. A `parsed` value (read from the model's own output) never replaces a `brief_set` one. */
export type OsBriefSource = 'brief_set' | 'parsed'

export type OsPlanStep = { id: string; text: string; status: 'todo' | 'doing' | 'done' | 'blocked' }

/** `answered` is set when Dave's next prompt arrives: the ask stays, dim, and is not counted. */
export type OsAskItem = {
  kind: 'question' | 'approval' | 'decision' | 'block'
  text: string
  recommend?: string
  source: OsBriefSource
  answered?: true
}

/**
 * A proof is tied to the id, the kind (task or plan step) and the subject (or plan step text) it was given for, so a
 * TodoWrite reorder cannot move it to another task and two tasks with one subject do not share it. Id and subject are redacted.
 */
export type OsProof = { id: string; artifact: string; at: number; subject: string; kind: 'task' | 'plan' }

/** The steward's record (hooks/agentic-os/steward.ts), watch-only. `briefAt` is the time of the last brief_set that `activity` counts since (the turn-end parser does not move it). Nothing of it goes to the model. */
export type OsSteward = {
  briefAt: number | null
  activity: { toolCalls: number; commits: number; prs: number; runs: number; resumes: number; laneClaims: number; artifacts: number }
}

/** What the session says about itself, set by the brief_set tool (hooks/agentic-os/brief.ts). Every string is redacted. */
export type OsBrief = {
  title?: string
  goal?: string
  stopAt?: string
  sources: { title?: OsBriefSource; goal?: OsBriefSource; stopAt?: OsBriefSource; ask?: OsBriefSource }
  plan: OsPlanStep[]
  ask: OsAskItem[]
  decisions: { text: string; by: string; at: number }[]
  proofs: OsProof[]
  updatedAt: number
}

/**
 * Where the session runs, read from the .git files (hooks/agentic-os/gitinfo.ts) at the session start and at each turn start.
 * `repo` is the top-level folder name (of the main checkout, for a linked worktree); `branch` is the short sha when HEAD is
 * detached; `worktree` is null for the primary checkout. A field is null when it is not known. The snapshot carries all three as top-level keys.
 */
export type OsGit = { repo: string | null; branch: string | null; worktree: string | null }

export type OsPlan = { title: string; file?: string }

export type OsTurn = { id: string; startedAt: number }

export type OsStep = { id: string; tool: string; label: string; startedAt: number }

export type OsAgent = { id: string; description: string; type: string; status: string }

export type OsLane = { id: string; title: string; state: string; note?: string }

/**
 * READY, merged or closed ends a watch. LIMITED means the reviewer did not finish a review of the head (a person decides).
 * REVIEWED means the head was reviewed but is not READY (open threads or a failed check): the model acts.
 * STALLED means no review 60 minutes after the head appeared.
 * PROOF means the PR body proof is missing or wrong: the author fixes the Evidence block now.
 * DRAFT means the PR waits for Dave's /pathway: no bot reviews a draft, and the watcher says so once per head.
 */
export type PrState = 'READY' | 'PENDING' | 'LIMITED' | 'CLOSED' | 'REVIEWED' | 'STALLED' | 'PROOF' | 'DRAFT'

/**
 * One watched PR. `state` is null until the first check. `whenReady` asks Land/No at READY.
 * `head` and `since` give the 60 minute clock of the current head. `alerted` is "STATE:head" of the
 * last REVIEWED or STALLED alert, so each head alerts once. `fails` counts checks that failed for this PR alone.
 */
export type PrWatch = {
  pr: number
  state: PrState | null
  whenReady: boolean
  head?: string
  since?: number
  alerted?: string
  fails?: number
}

/** One rate-limit window as the HUD shows it (`five_hour`, `seven_day`, a spend limit). */
export type HudLimit = { kind: string; percentUsed: number }

/**
 * The advisor as the HUD shows it. `blocked` names the env var that keeps it off even though
 * `advisorModel` is set; `calls` counts advisor server-tool uses on the main loop this session.
 */
export type HudAdvisor = { state: 'on' | 'off' | 'blocked'; model?: string; reason?: string; calls: number }

/** The HUD row: main-loop model and effort (from turn.step), advisor, and the engine's own cost and limits. */
export type HudState = {
  model: string | null
  effort: string | null
  advisor: HudAdvisor
  costUsd: number | null
  limits: HudLimit[]
}

/**
 * Why a main-loop request rewrote prompt the cache held before. `start` and `resume` are the first
 * request of a conversation (`resume`: it carried a history); `expired` is idle time past the cache lifetime; `changed` is
 * a prefix that differs for a reason the mod cannot name (tools, system prompt, an edited history).
 */
export type CacheMissCause = 'start' | 'resume' | 'expired' | 'compaction' | 'model' | 'changed'

/** One miss. `rewritten` is tokens; `usd` prices that rewrite as a cache write (hooks/shared/price.ts), null with no price. */
export type CacheMiss = {
  at: number
  idleMs: number
  rewritten: number
  cause: CacheMissCause
  model: string
  turnId: string
  usd: number | null
}

/**
 * Prompt-cache use of the main loop, summed per model request (turn.step). Subagents are the Agent
 * Ledger's. `contextTokens` is the last request's prompt size; `ttlMin` the cache lifetime assumed
 * (the API reports none per request). `savedUsd` is an estimate against the same requests uncached.
 */
export type CacheState = {
  requests: number
  input: number
  read: number
  write: number
  savedUsd: number
  contextTokens: number | null
  /** Tokens the cache holds after the last request that used it: what a later request can read, and what a cold send rewrites. */
  cachedTokens: number | null
  /** When the last request that read or wrote the cache was sent: the entry's lifetime runs from here. */
  lastUsedAt: number | null
  lastModel: string | null
  lastTurnId: string | null
  /** True from a compaction until the next request, which names it as the cause of its miss. */
  compacted: boolean
  /** The engine started this conversation as a resume or a fork (classic SessionStart `source`): its first request carries a history. */
  resumed: boolean
  ttlMin: number
  /** Writes are 1-hour entries (a subscription): the rate a rewrite is priced at. */
  oneHour: boolean
  /** Newest last, capped; `missCount` counts every one. */
  misses: CacheMiss[]
  missCount: number
}

/**
 * One subagent run as the Agent Ledger shows it. Tokens and cost add up per model request
 * (turn.step); `costUsd` is an estimate from hooks/shared/price.ts, never the bill.
 * `drift` says how the run broke its agent's .md (`model:`, `effort:`), or that it ran on Haiku.
 */
export type AgentRun = {
  id: string
  /** The Agent tool call that started it, so the skin can badge that row. */
  toolUseId?: string
  /** The workflow run that started it (spawn.workflow.runId). Absent outside a real workflow run; the pane groups a workflow's helpers by it. */
  workflowRunId?: string
  type: string
  description: string
  model: string | null
  effort: string | null
  spec: { model?: string; effort?: string }
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  tokens: number
  costUsd: number
  drift: string | null
}

/** A file this session touched: read, edited, or edited and then committed. Path is relative to the session root. */
export type FileTouch = { path: string; state: 'read' | 'edited' | 'committed'; added: number; removed: number }

/**
 * One lane from `lane.mjs board --json` (hooks/agentic-os/lanes-model.ts). `owner` is the 8-character short session id, never the full id.
 * `live` (set by parseBoard, absent in a hand-built lane) is true for an owned lane whose owner session is in the board's peers, whatever its lease says; `leaseLapsed` is a separate tag.
 */
export type BoardLane = {
  id: string
  title: string
  state: string
  mine: boolean
  owner: string | null
  live?: boolean
  note?: string
  scope?: string
  leaseLapsed?: boolean
}

/** One manual compaction the keeper watched: did the summary keep the plan (the marker line for these counts)? */
export type KeeperRecord = { at: number; sessionId: string; open: number; total: number; kept: boolean }

/** One way to review a draft PR, as `pr-checkpoint.mjs --json` lists it. A held option (`available` false) carries its reason and cannot be pressed. */
export type CheckpointOption = {
  pathway: string
  label: string | null
  available: boolean
  /** [opening reviews, extra rounds after fix pushes] */
  cost: [number, number]
  reason: string
}

/** What `pr-checkpoint.mjs --json` prints (the T21 key set of scripts/github/pr-checkpoint.test.mjs). Only the fields the pane reads. */
export type CheckpointResult = {
  head: string
  class: string
  matched: number
  size: { files: number; lines: number }
  checks: { step: string; status: string; detail?: string }[]
  cli: { bySeverity: Record<string, number> } | null
  credits: { used: number | null; monthly: number | null }
  capacity: { count: number | null; band: string | null; warning: string | null; source: string | null; date: string | null }
  recommended: string | null
  options: CheckpointOption[]
  why: string[]
  budget: [number, number]
  config_drift: boolean
}

/** `checkpoint:pr:<n>` in $.store: the pathway.json record the engine printed at --confirm, plus what the mod adds. `appliedAt` is epoch ms (the clock of the pr-loop store). */
export type CheckpointRecord = {
  pr: number
  state: 'confirmed' | 'applied'
  head: string
  pathway: string
  label: string | null
  budget: [number, number]
  decided_by: string
  session: string
  capacity?: CheckpointResult['capacity']
  appliedAt?: number
  /** Set when Dave said No to an ask. A grant or a new checkpoint clears it. */
  declined?: { kind: 'opening' | 'round' | 'greptile'; round: number; head: string }
  /** Set when the mod posted the opening review request on Dave's Yes. */
  opened?: { head: string; at: number }
  /** Set when Dave answered the Greptile ask: no later ask for this PR. */
  greptile?: { head?: string; at?: number; declined?: true }
  [key: string]: unknown
}

/** A question for Dave, drawn in the checkpoint pane. `round` is the round it asks about (the opening is round 1). */
export type CheckpointAsk = { kind: 'opening' | 'round' | 'greptile'; pr: number; head: string; text: string; round?: number }

/** The checkpoint the pane shows: the engine result of a draft PR, until Dave presses an option. `error` is the last refusal line; `retry` offers --apply again. */
export type CheckpointView = {
  pr: number
  body: string
  root: string
  result: CheckpointResult
  covers: string[]
  stamp: string | null
  prHead: string
  running: string | null
  error: string | null
  retry: { pathway: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'ccv3-mods': {
      tasks: OsTask[]
      plan: OsPlan | null
      turn: OsTurn | null
      /** Running main-loop tool calls, oldest first; NOW shows the newest. */
      steps: OsStep[]
      ctx: number | null
      agents: OsAgent[]
      lanes: OsLane[] | null
      tick: number
      /** Set at session.start from `isInteractive`: a headless run gets capture and snapshots only. */
      mode: 'interactive' | 'headless'
      /** This session's watched PRs, mirrored from $.store so the band and pane redraw. */
      prs: PrWatch[]
      /** The HUD row; null in headless runs and under CCV3_MOD_HUD_OFF, so the band stays as it was. */
      hud: HudState | null
      /** Prompt-cache use of the main loop (hooks/hud): the HUD's cache element and /cache. */
      cache: CacheState
      /** Subagent runs this session, oldest first (Agent Ledger). */
      agentRuns: AgentRun[]
      /** Touched Files (hooks/touched-files): only files this session's tool calls named. */
      files: FileTouch[]
      /** Manual compactions the keeper watched, oldest first, newest last, at most 10 (compact-keeper). Auto compactions are absent. */
      compactions: KeeperRecord[]
      /** Every lane `lane.mjs board --json` listed at the last good read; null before the first read (agentic-os). */
      board: BoardLane[] | null
      /** When that board read happened (epoch ms); null before the first good read (agentic-os). The Work tab says "as of <age>". */
      boardAt: number | null
      /** True once this environment's 5 s pulse is armed (agentic-os); a start resets it. */
      uiArmed: boolean
      /** True once this session's first turn left its beacon file (agentic-os). */
      turnBeaconed: boolean
      /** The brief_set tool's record (agentic-os): goal, stop-at, plan, asks, decisions, proofs. Cleared at /clear and resume. */
      brief: OsBrief | null
      /** True once a main-loop tool call was refused in the current turn: the chip reads blocked. Cleared at the next turn. */
      refused: boolean
      /** When the session last did anything (a prompt, a turn start or end, a main-loop tool call): an open ask stays fresh 24 hours from it. */
      activeAt: number | null
      /** Repo, branch and worktree of the session folder (agentic-os): the band's line 1 and the snapshot's `repo`, `branch`, `worktree`. */
      git: OsGit | null
      /** The tab the /os pane shows (agentic-os): reset to overview at /clear and resume. A tab that is not live (Comms, Swarm, Resources) is never stored. */
      osTab: 'overview' | 'session' | 'plan' | 'work' | 'proof' | 'decisions' | 'swarm'
      /** The steward's counts since the last brief_set (agentic-os, steward.ts). Reset at session.start, /clear and resume. */
      steward: OsSteward
      /** The checkpoint a draft PR waits on (hooks/pr-checkpoint); null when none is open. */
      checkpoint: CheckpointView | null
      /** Questions for Dave in the checkpoint pane, oldest first (written by pr-loop, answered by pr-checkpoint). Mirrors $.store checkpoint:asks:<session>. */
      checkpointAsks: CheckpointAsk[]
      /** Lock patterns already shown in a warn toast this session. */
      lockWarned: string[]
      /** True from /clear or a resume until the new conversation's first reply: the HUD cost reads as a dash (hooks/hud/seed.ts). */
      costForgotten: boolean
    }
  }
}
