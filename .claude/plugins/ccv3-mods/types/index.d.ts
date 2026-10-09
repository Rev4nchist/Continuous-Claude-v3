export type OsTaskStatus = 'pending' | 'in_progress' | 'completed'

export type OsTask = {
  id: string
  subject: string
  status: OsTaskStatus
  activeForm?: string
}

export type OsPlan = { title: string; file?: string }

export type OsTurn = { id: string; startedAt: number }

export type OsStep = { id: string; tool: string; label: string; startedAt: number }

export type OsAgent = { id: string; description: string; type: string; status: string }

export type OsLane = { id: string; title: string; state: string; note?: string }

/**
 * READY, merged or closed ends a watch. LIMITED means the reviewer did not finish a review of the head (a person decides).
 * REVIEWED means the head was reviewed but is not READY (open threads or a failed check): the model acts.
 * STALLED means no review 60 minutes after the head appeared.
 */
export type PrState = 'READY' | 'PENDING' | 'LIMITED' | 'CLOSED' | 'REVIEWED' | 'STALLED'

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
 * One subagent run as the Agent Ledger shows it. Tokens and cost add up per model request
 * (turn.step); `costUsd` is an estimate from hooks/shared/price.ts, never the bill.
 * `drift` says how the run broke its agent's .md (`model:`, `effort:`), or that it ran on Haiku.
 */
export type AgentRun = {
  id: string
  /** The Agent tool call that started it, so the skin can badge that row. */
  toolUseId?: string
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

/**
 * Cache Guard's clock: when the main loop last answered, and which quiet window was already held once.
 * Both in `$.clock.now()` milliseconds.
 */
export type CacheClock = { lastReplyAt: number | null; heldFor: number | null }

/** A send Cache Guard held: the text to re-send on "Send anyway" and the figures the card shows. */
export type CacheHold = {
  text: string
  idleMs: number
  ttlMin: number
  tokens: number | null
  coldUsd: number | null
  warmUsd: number | null
}

/** A file this session touched: read, edited, or edited and then committed. Path is relative to the session root. */
export type FileTouch = { path: string; state: 'read' | 'edited' | 'committed'; added: number; removed: number }

/** When a tool call started and how long it ran (ms), by tool_use_id; the skin's timing chip. */
export type ToolTime = { startedAt: number; ms: number | null }

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
      /** Subagent runs this session, oldest first (Agent Ledger). */
      agentRuns: AgentRun[]
      /** Cache Guard (hooks/cache-guard). */
      cacheClock: CacheClock
      cacheHold: CacheHold | null
      /** The surface this session draws on (Cache Guard holds only where its card can show). */
      cacheSurface: string | null
      /** Touched Files (hooks/touched-files): only files this session's tool calls named. */
      files: FileTouch[]
      /** CCv3 Skin (hooks/skin): on/off, mirrored from $.store; call timings for its chips. */
      skinOn: boolean
      toolTimes: Record<string, ToolTime>
    }
  }
}
