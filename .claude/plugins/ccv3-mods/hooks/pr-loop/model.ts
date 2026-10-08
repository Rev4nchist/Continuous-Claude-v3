import type { PrState, PrWatch } from '../../types'

/** What `coderabbit-status.mjs <N> --json` prints. Only the fields the mod reads. */
export type PrStatus = {
  pr: number
  head: string
  headShort: string
  branch: string
  ready: boolean
  reasons: string[]
  mergeable_state: string | null
  reviewedHead: boolean
  unresolved: number
  rateLimited: boolean
  prState: string
  merged: boolean
}

export type Probe = { kind: 'ok'; status: PrStatus } | { kind: 'error'; text: string }

/** What the watcher tells Dave and the model about one PR. */
export type Alert = { pr: number; state: PrState; headShort: string; merged: boolean; whenReady: boolean; reasons: string[] }

export type WatchDoc = { prs: PrWatch[]; backoffUntil: number; touched: number }

export const TICK_MS = 300_000
export const BACKOFF_MS = 900_000
/** Timers drift; a tick a little early still counts as past the backoff. */
export const BACKOFF_SLACK_MS = 30_000
export const STATUS_TIMEOUT_MS = 60_000
/** A watch list nobody touched for a week belongs to a session that is gone. */
export const STALE_MS = 7 * 24 * 3_600_000

export const emptyDoc = (now: number): WatchDoc => ({ prs: [], backoffUntil: 0, touched: now })

/** The stored value if it has the shape of a watch list, else an empty one. */
export const readDoc = (value: unknown, now: number): WatchDoc => {
  const doc = value as Partial<WatchDoc> | null | undefined
  if (!doc || !Array.isArray(doc.prs)) return emptyDoc(now)
  const prs = doc.prs.filter(one => Number.isInteger(one?.pr) && one.pr > 0).map(one => ({
    pr: one.pr,
    state: (one.state ?? null) as PrState | null,
    whenReady: one.whenReady === true,
  }))
  return { prs, backoffUntil: typeof doc.backoffUntil === 'number' ? doc.backoffUntil : 0, touched: now }
}

export const isStale = (value: unknown, now: number): boolean => {
  const touched = (value as Partial<WatchDoc> | null | undefined)?.touched
  return typeof touched === 'number' && now - touched > STALE_MS
}

export const isPrNumber = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

/** Adds a PR; one already watched stays one entry, and a `whenReady` flag once set stays set. */
export const addWatch = (prs: PrWatch[], pr: number, whenReady: boolean): PrWatch[] =>
  prs.some(one => one.pr === pr)
    ? prs.map(one => (one.pr === pr ? { ...one, whenReady: one.whenReady || whenReady } : one))
    : [...prs, { pr, state: null, whenReady }]

/**
 * The status script's answer. Exit 0 is READY and exit 1 is NOT READY: both print the JSON.
 * Exit 2, no output, or output that is not a status is an error, never a verdict.
 */
export const parseProbe = (run: { exitCode: number; stdout: string; stderr: string }): Probe => {
  if (run.exitCode === 0 || run.exitCode === 1) {
    try {
      const parsed = JSON.parse(run.stdout) as Partial<PrStatus>
      if (isPrNumber(parsed.pr) && typeof parsed.ready === 'boolean' && Array.isArray(parsed.reasons)) {
        return { kind: 'ok', status: parsed as PrStatus }
      }
    } catch {
      // Falls through to the error below.
    }
  }
  const said = (run.stderr || run.stdout).trim().split(/\r?\n/)[0] ?? ''
  return { kind: 'error', text: said || `status script exited ${run.exitCode} with no output` }
}

export const isClosed = (status: PrStatus): boolean => status.merged || status.prState !== 'open'

export const stateOf = (status: PrStatus): PrState => {
  if (isClosed(status)) return 'CLOSED'
  if (status.ready) return 'READY'
  return status.rateLimited ? 'LIMITED' : 'PENDING'
}

/**
 * Folds one check into a watch. READY and CLOSED end the watch (`watch` null) and alert.
 * LIMITED alerts once and stays. PENDING never alerts: waiting is the normal state.
 */
export const settle = (watch: PrWatch, status: PrStatus): { watch: PrWatch | null; alert: Alert | null } => {
  const state = stateOf(status)
  const alert: Alert = { pr: watch.pr, state, headShort: status.headShort, merged: status.merged, whenReady: watch.whenReady, reasons: status.reasons }
  if (state === 'READY' || state === 'CLOSED') return { watch: null, alert }
  if (state === 'LIMITED' && watch.state !== 'LIMITED') return { watch: { ...watch, state }, alert }
  return { watch: { ...watch, state }, alert: null }
}

const word = (alert: Alert): string => (alert.state === 'CLOSED' ? (alert.merged ? 'merged' : 'closed') : alert.state === 'LIMITED' ? 'CodeRabbit rate limited' : 'READY')

export const toastText = (alert: Alert): string => `PR #${alert.pr}: ${word(alert)}`

/** The one report-only line the model gets. It never asks for a merge. */
export const reportLine = (alert: Alert): string =>
  alert.state === 'LIMITED'
    ? `PR watcher: #${alert.pr} head ${alert.headShort} was not reviewed because CodeRabbit is rate limited. Report this to Dave. Do not merge it and do not post @coderabbitai review.`
    : `PR watcher: #${alert.pr} head ${alert.headShort} is READY (CodeRabbit reviewed it, 0 threads unresolved, checks green). Report this to Dave. Do not merge it: only Dave's yes lands a PR.`

export const statusText = (status: PrStatus): string => {
  const state = stateOf(status)
  const head = `PR #${status.pr} head ${status.headShort} (${status.branch}): ${state === 'CLOSED' ? (status.merged ? 'MERGED' : 'CLOSED') : state === 'READY' ? 'READY' : 'NOT READY'}`
  const rows = [
    `  CodeRabbit reviewed the head: ${status.reviewedHead ? 'yes' : 'NO'}`,
    `  Threads unresolved: ${status.unresolved}`,
    `  Mergeable state: ${status.mergeable_state ?? 'unknown'}`,
  ]
  return [head, ...rows, ...status.reasons.map(reason => `  - ${reason}`)].join('\n')
}

export const watchLine = (watch: PrWatch): string =>
  `#${watch.pr} ${watch.state ?? 'not checked yet'}${watch.whenReady ? ' (asks Land/No at READY)' : ''}`

export type WatchArgs = { pr: number | null; once: boolean; whenReady: boolean }

/** `12`, `12 --once`, `12 --when-ready`, or nothing. Flags in any order. */
export const parseArgs = (args: string): WatchArgs => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const number = words.find(word => /^#?\d+$/.test(word))
  const pr = number ? Number(number.replace('#', '')) : null
  return { pr: pr !== null && pr > 0 ? pr : null, once: words.includes('--once'), whenReady: words.includes('--when-ready') }
}

export const landCommand = (root: string, pr: number): string => `pwsh -File "${root}/scripts/github/land-pr.ps1" -Pr ${pr}`

export const clipTail = (text: string, max: number): string => (text.length <= max ? text : `...${text.slice(text.length - max)}`)
