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
    }
  }
}
