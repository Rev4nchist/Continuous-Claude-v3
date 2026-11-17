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

/**
 * `answered` is set when Dave's next prompt arrives: the ask stays, dim, and is not counted. The prompt may not address this ask.
 * `answeredAt` is that prompt's time. A parsed ask with the same kind and text in a later Next steps block keeps both: a repeated
 * block does not re-open it. Only a brief_set re-ask or a change of kind or text re-opens it (design 2026-11-09, F2).
 */
export type OsAskItem = {
  kind: 'question' | 'approval' | 'decision' | 'block'
  text: string
  recommend?: string
  source: OsBriefSource
  answered?: true
  /** Epoch ms of the prompt that set `answered`. Absent on an ask answered before this field shipped. */
  answeredAt?: number
}

/**
 * An ask that left the open list. `how`: `prompted` when it had `answered: true` as it left (a prompt from Dave arrived
 * while it was open; that prompt may not address this ask), `replaced` when it was still open (a new list or `ask: []`
 * took its place with no prompt from Dave in between).
 * `text` is the stored ask text, already redacted. `recommend` and `source` are not kept.
 * No kind and text is in both `ask` and `cleared`: an ask that is open again leaves `cleared`.
 */
export type OsClearedAsk = {
  kind: OsAskItem['kind']
  text: string
  answeredAt?: number
  clearedAt: number
  how: 'prompted' | 'replaced'
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
/** An action for Dave that needs no answer ("To do for you"). A list of its own in the brief: no ask path reads it. */
export type OsTodo = { text: string; at: number }

export type OsBrief = {
  title?: string
  goal?: string
  stopAt?: string
  sources: { title?: OsBriefSource; goal?: OsBriefSource; stopAt?: OsBriefSource; ask?: OsBriefSource }
  plan: OsPlanStep[]
  ask: OsAskItem[]
  /** A decision from brief_set (`by` as given) or from a tap in a model AskUserQuestion dialog (`by: "Dave (tap)"`). */
  decisions: { text: string; by: string; at: number }[]
  /** The last 5 asks that left the open list, oldest first. Absent until the first ask leaves. */
  cleared?: OsClearedAsk[]
  /** The to-dos for Dave (brief_set `todo`). Absent until the first call that sends it; a brief without it reads as []. */
  todos?: OsTodo[]
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
/** `resetsAt`: when the window resets, an ISO 8601 time from the engine (optional: a seed or an old reading has none). */
export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

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

/** One miss. `rewritten` is tokens; `usd` prices that rewrite as a cache write at the exact model id's rate (hooks/shared/price.ts, from prices.json), null when the id has no price. */
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
  /** Set (never cleared until the state resets) when a request ran on a model id with no price: `savedUsd` and `CacheMiss.usd` leave it out. Absent in a state saved before this. */
  hasUnknownModelCost?: boolean
}

/**
 * One subagent run as the Agent Ledger shows it. Tokens and cost add up per model request
 * (turn.step); `costUsd` is an estimate from hooks/shared/price.ts (exact model id, 5m/1h writes, web search), never the bill.
 * It prices each step's whole usage (price.ts `stepCost`): top-level tokens, the 5m/1h split, web searches, and each advisor iteration
 * (`usage.iterations`) at its own model. Runs saved before this table keep the `costUsd` they had: tier rates, every write at 1.25x. Old and new dollars add up in one run.
 * `tokens` add the advisor iterations to the four top-level counts, so tokens and dollars share one basis.
 * Live limit, proven (PR #436): the engine's `turn.step` usage names four token fields and no `iterations`, so a live run leaves the advisor's own tokens out (a probe priced $0.0082 against $0.1862). A live run prices an advisor or a 5m/1h split only when the engine sends `iterations` or `cache_creation` there (README, agent-ledger row).
 * `advised` counts the advisor calls seen; above 0 the run's dollars are a floor and every ledger display says "at least" (`≥`). The engine's own cost state stays the truth.
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
  /** True when a step used a model id with no price: `costUsd` leaves it out ($0, not a real $0). Absent otherwise, and in a run saved before this. */
  hasUnknownModelCost?: boolean
  /** How many advisor calls the live feed showed for this run (`result.serverToolUses`, name `advisor`, counted at turn.step). Absent means 0 and in a run saved before this. Above 0, `costUsd` is a floor: the advisor's own tokens are not in the live usage, so the displays say "at least". The Fleet app reads this name. */
  advised?: number
  drift: string | null
}

/**
 * What the Swarm tab may know about one workflow run beyond the ledger: its name, its phase and a label per helper (hooks/agentic-os/journal-model.ts reads it
 * from the run's journal). Absent: the tab draws counts only.
 */
export type WorkflowFeed = {
  runId: string
  name: string | null
  /** The phase as drawn: `index` counts from 1; `total` is null when the plan is not known. */
  phase: { index: number; total: number | null; title: string | null } | null
  /** Helper label by AgentRun.id. */
  labels: Record<string, string>
  /** Helper phase (same numbering as `phase.index`) by AgentRun.id, so the tab can apply the phase rule against the ledger status. */
  agentPhases: Record<string, number>
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
  /** The owner's session name (`owner_name` of `board --json`): a string, null when the owner has no name, absent when the board has no such field. */
  ownerName?: string | null
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

/** What `pr-checkpoint.mjs --json` prints (the T21 key set of scripts/github/pr-checkpoint.test.mjs). Only the fields the mod reads. */
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
  /** The engine's answer to "may the mod record `none` without Dave's press?" (autoOf in pr-checkpoint.mjs). Absent or malformed reads as not eligible. */
  auto: { eligible: boolean; band: string | null; reason: string }
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
  /** How the pick arrived: Dave's dialog or composer, a bridge /pathway word (Remote Control), or auto-confirm. Absent from older records. land-none-check.mjs reads it. */
  via?: 'dialog' | 'composer' | 'bridge' | 'auto'
  session: string
  capacity?: CheckpointResult['capacity']
  appliedAt?: number
  /** The checkout the record's head came from (the PR branch worktree or the session root). Lock B reads HEAD there. */
  root?: string
  /** The router band the engine printed at --confirm (result.auto.band), kept so the free-slot queue can enqueue the PR. Absent from older records. */
  band?: string | null
  /** Set when Dave said No to an ask. A grant or a new checkpoint clears it. */
  declined?: { kind: 'opening' | 'round' | 'greptile'; round: number; head: string }
  /** The changed-file count of the checkpoint the record came from. It prices the "up to $X" of a later question. Absent from older records. */
  files?: number
  /** Set when the mod posted the opening review request on Dave's Yes. */
  opened?: { head: string; at: number }
  /** Set when Dave answered the Greptile ask: no later ask for this PR. */
  greptile?: { head?: string; at?: number; declined?: true }
  [key: string]: unknown
}

/** One PR in the free-slot queue, as `slot-queue.mjs tick --json` and `list --json` print it (scripts/github/slot-queue-model.mjs rowOf). */
export type SlotRow = {
  pr: number
  band: 'CRITICAL' | 'HIGH' | 'SAMPLE' | string
  /** opening, awaiting-fix, queued, posted, timed-out, done, dropped or stuck. */
  state: string
  /** 1-based place in line; null for an item that is not in line (posted, finished). */
  position: number | null
  /** How many items are in line. */
  total: number
  head7: string
  queuedMin: number | null
  /** Minutes until the 60 minute time-out; null when no time-out applies. */
  timeoutInMin: number | null
  nextSlotInMin: number
  posts: number
  asked: { paid30: boolean; timeout60: boolean }
  dropReason?: string
}

/** A line the tick wants shown to Dave. Only toasts today. Each one that asks for an answer names a `/slot <verb> <pr>` command. */
export type SlotAction = { kind: 'toast'; pr: number; text: string }

/** What `slot-queue.mjs tick --json` prints: a good tick, or `{ ok: false, reason }` (exit 2). */
export type SlotTick =
  | { ok: true; effective: boolean; locked: boolean; actions: SlotAction[]; rows: SlotRow[]; nextSlotInMin: number | null }
  | { ok: false; reason: string }

/**
 * A question for Dave, raised as a dialog ($.ui.ask) by the watcher. `round` is the round it asks about (the opening is round 1).
 * `dismissed` counts the times he closed it; `deferredUntil` (epoch ms) is when it may come back. After the second close only a bare /pathway raises it.
 */
export type CheckpointAsk = { kind: 'opening' | 'round' | 'greptile'; pr: number; head: string; text: string; round?: number; deferredUntil?: number; dismissed?: number }

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
      /** 'no-board' when the last lane read said the session folder has no lane board (unregistered); null after a good read or before any (agentic-os). The Work tab says "no lane board (unregistered dir)". */
      boardState: 'no-board' | null
      /** True once this environment's 5 s pulse is armed (agentic-os); a start resets it. */
      uiArmed: boolean
      /** True once this session's first turn left its beacon file (agentic-os). */
      turnBeaconed: boolean
      /** The id of the session whose final snapshot (with `endedAt`) was written at session.end; no later write for that id lands (agentic-os). */
      endedId: string | null
      /** The brief_set tool's record (agentic-os): goal, stop-at, plan, asks, decisions, proofs. Cleared at /clear and resume. */
      brief: OsBrief | null
      /** True once a main-loop tool call was refused in the current turn: the chip reads blocked. Cleared at the next turn. */
      refused: boolean
      /** When the session last did anything (a prompt, a turn start or end, a main-loop tool call): an open ask stays fresh 24 hours from it. */
      activeAt: number | null
      /** The Claude Code session name (agentic-os): from `session_title` of classic.SessionStart and classic.UserPromptSubmit, else the identity file. Null: unnamed. */
      sessionName: string | null
      /** Repo, branch and worktree of the session folder (agentic-os): the band's line 1 and the snapshot's `repo`, `branch`, `worktree`. */
      git: OsGit | null
      /** The tab the /os pane shows (agentic-os): reset to overview at /clear and resume. A tab that is not live (Comms, Swarm, Resources) is never stored. */
      osTab: 'overview' | 'session' | 'plan' | 'work' | 'proof' | 'decisions' | 'swarm'
      /** What the workflow journals say about this session's workflow runs: a label and a phase per helper, and the run name (agentic-os, journal-model.ts). Read at /os open and at a press of Swarm only; each read replaces the whole list. */
      workflows: WorkflowFeed[]
      /** The steward's counts since the last brief_set (agentic-os, steward.ts). Reset at session.start, /clear and resume. */
      steward: OsSteward
      /** Lock patterns already shown in a warn toast this session. */
      lockWarned: string[]
      /** The free-slot queue rows at the last tick (hooks/pr-loop/slot.ts); mirrors what the tick printed, so the band and /watch can show the queue. */
      slotRows: SlotRow[]
      /** True from /clear or a resume until the new conversation's first reply: the HUD cost reads as a dash (hooks/hud/seed.ts). */
      costForgotten: boolean
    }
  }
}
