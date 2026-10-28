import type { OsBrief, OsTask } from '../../types'

// STUB for PR 4 (steward): the failing tests in tests/steward.test.ts import these names.
// Every function throws until the implementation lands. The constants hold the contract values.

export type Brief = OsBrief

/** Counts since the last brief change. A signal is one kind of thing the session did. */
export type Activity = {
  toolCalls: number
  commits: number
  prs: number
  runs: number
  resumes: number
  laneClaims: number
  artifacts: number
}
export type Signal = Exclude<keyof Activity, 'toolCalls'>

export type DriftLevel = 'ok' | 'unset' | 'stale' | 'finished'
/** `key` names the drift reason: the level plus the brief version. It does not change while the counts grow. */
export type Drift = { level: DriftLevel; reason: string; key: string }

export type NudgeState = { lastKey: string | null; callsSinceNudge: number | null }
export type NudgeGate = { headless: boolean; subagent: boolean; off: boolean }
export type SentState = { briefAt: number | null; hadNudge: boolean }

export const BLOCK_MAX = 600
export const NUDGE_EVERY = 20
export const STALE_CALLS = 15

const todo = (): never => {
  throw new Error('not implemented')
}

export const drift = (_brief: Brief | null, _activity: Activity): Drift => todo()
export const signalOf = (_tool: string, _input: Record<string, unknown>, _headMoved: boolean): Signal | null => todo()
export const observe = (_activity: Activity, _tool: string, _input: Record<string, unknown>, _headMoved: boolean): Activity => todo()
export const nudgeLine = (_drift: Drift): string | null => todo()
export const shouldNudge = (_drift: Drift, _state: NudgeState, _gate: NudgeGate): boolean => todo()
export const instructBlock = (_brief: Brief | null, _tasks: OsTask[], _nudge: string | null): string => todo()
export const sentOf = (_brief: Brief | null, _nudge: string | null): SentState => todo()
export const shouldSend = (_prev: SentState | null, _brief: Brief | null, _nudge: string | null): boolean => todo()
