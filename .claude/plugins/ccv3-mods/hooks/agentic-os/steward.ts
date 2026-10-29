import type { OsBrief } from '../../types'

// The steward (PR 4), watch-only: it counts what the session did and says whether the brief fell behind. It tells the model
// nothing (Dave, 2026-10-28: the prompt cache hit rate comes first), so no string here reaches a prompt. The pane draws the result.
// Pure: no engine, no clock, no state. index.tsx holds the counts and calls these. Observer only: nothing here
// denies or rewrites a call. The reasons are counts and fixed words, never text from the session.

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

export const STALE_CALLS = 15

// --- Drift ---

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "12 tool calls and 1 commit": what happened since the last brief change. */
const happened = (a: Activity): string => {
  const parts = [plural(a.toolCalls, 'tool call')]
  if (a.commits > 0) parts.push(plural(a.commits, 'commit'))
  if (a.prs > 0) parts.push(plural(a.prs, 'PR'))
  if (a.runs > 0) parts.push(plural(a.runs, 'run'))
  return parts.length === 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * Compares the brief with what the session did since the brief last changed. `finished` wins over `stale`.
 * `version` is the brief version the counts belong to: the caller passes the time of the last brief_set. The default,
 * `brief.updatedAt`, also moves when the turn-end parser merges a goal or an ask, which is not a brief change here.
 */
export const drift = (brief: Brief | null, activity: Activity, version: number = brief?.updatedAt ?? 0): Drift => {
  const make = (level: DriftLevel, reason: string): Drift => ({ level, reason, key: `${level}@${version}` })
  if (activity.toolCalls === 0) return make('ok', '')
  if (!brief?.goal) return make('unset', 'no goal set yet while work started')
  if (brief.plan.length > 0 && brief.plan.every(one => one.status === 'done')) return make('finished', 'every plan step is done but work continues')
  const isStale = activity.toolCalls >= STALE_CALLS || activity.commits + activity.prs + activity.runs > 0
  return isStale ? make('stale', `${happened(activity)} since the brief changed`) : make('ok', '')
}

// --- Signals ---

const SHELLS = new Set(['Bash', 'PowerShell'])
const COMMIT = /(?:\bgit\b|git-safe\.ps1)\s+(?:-{1,2}\S+\s+(?:(?!commit\b)[^-\s]\S*\s+)?)*commit\b/
const PR_CREATE = /\bgh\s+pr\s+create\b/
const PR_API = /\bgh\s+api\s+\S*\/pulls(?:\?\S*)?(?=\s|$)/
const API_WRITES = /(?:-X\s*POST\b|\s(?:-f|-F|--field|--raw-field)\b)/i
const LANE_CLAIM = /\blane\.mjs\s+claim\b/
const E2E_DIR = '.claude/cache/e2e/'
/** A writer straight before an e2e path: a redirect, tee, Out-File, Set-Content. A read of the file is not one. */
const E2E_WRITE = /(?:>>?|\btee\b|Out-File|Set-Content|Add-Content)\s*(?:-\S+\s+)*["']?[^\s"']*\.claude\/cache\/e2e\//

const slashed = (value: unknown): string => (typeof value === 'string' ? value.replace(/\\/g, '/') : '')

const shellSignal = (command: string, headMoved: boolean): Signal | null => {
  if (COMMIT.test(command)) return headMoved ? 'commits' : null
  if (PR_CREATE.test(command) || (PR_API.test(command) && API_WRITES.test(command))) return 'prs'
  if (LANE_CLAIM.test(command)) return 'laneClaims'
  return E2E_WRITE.test(slashed(command)) ? 'artifacts' : null
}

/** What one tool call says about the work, or null. A commit counts only when HEAD moved (a refused commit is not one). */
export const signalOf = (tool: string, input: Record<string, unknown>, headMoved: boolean): Signal | null => {
  if (SHELLS.has(tool)) return shellSignal(typeof input.command === 'string' ? input.command : '', headMoved)
  if (tool === 'Workflow' || tool === 'Agent') return 'runs'
  if (tool === 'Skill') return input.skill === 'resume_handoff' ? 'resumes' : null
  if (tool === 'Write') return slashed(input.file_path).includes(E2E_DIR) ? 'artifacts' : null
  return null
}

/** The counts after one more call. The counts passed in are kept. */
export const observe = (activity: Activity, tool: string, input: Record<string, unknown>, headMoved: boolean): Activity => {
  const signal = signalOf(tool, input, headMoved)
  const next = { ...activity, toolCalls: activity.toolCalls + 1 }
  if (signal !== null) next[signal] += 1
  return next
}
