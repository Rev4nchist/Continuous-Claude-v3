import type { PrState, PrWatch } from '../../types'

/** What `review-status.mjs <N> --json` prints. Only the fields the mod reads. */
export type PrStatus = {
  /** Reviewed, but Greptile's confidence is below the bar. Absent from older scripts. */
  lowConfidence?: boolean
  confidence?: number | null
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
  /** A labelled PR whose CodeRabbit review is missing: rate limited, skipped or failed. Null when unlabelled. Absent from older scripts. */
  coderabbitLimited?: boolean | null
  prState: string
  merged: boolean
}

/** `perPr` marks an error that belongs to this PR alone (a 404, a list too long); any other error is shared by all PRs. */
export type Probe = { kind: 'ok'; status: PrStatus } | { kind: 'error'; text: string; perPr: boolean }

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
/** A head with no finished review after 60 minutes is STALLED. */
export const STALL_MS = 3_600_000
/** A PR whose own check fails this many times in a row leaves the list. */
export const MAX_FAILS = 3

export const emptyDoc = (now: number): WatchDoc => ({ prs: [], backoffUntil: 0, touched: now })

/** The stored value if it has the shape of a watch list, else an empty one. */
export const readDoc = (value: unknown, now: number): WatchDoc => {
  const doc = value as Partial<WatchDoc> | null | undefined
  if (!doc || !Array.isArray(doc.prs)) return emptyDoc(now)
  const prs = doc.prs.filter(one => Number.isInteger(one?.pr) && one.pr > 0).map(one => ({
    pr: one.pr,
    state: (one.state ?? null) as PrState | null,
    whenReady: one.whenReady === true,
    ...(typeof one.head === 'string' ? { head: one.head } : {}),
    ...(typeof one.since === 'number' ? { since: one.since } : {}),
    ...(typeof one.alerted === 'string' ? { alerted: one.alerted } : {}),
    ...(typeof one.fails === 'number' && one.fails > 0 ? { fails: one.fails } : {}),
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

/** What `gh` says when one PR cannot be read: a 404, a foreign number, a list past the script's page. */
const PER_PR_ERROR = /HTTP 404|Not Found \(HTTP|Could not resolve to|more than \d+ /i

const OLD_SCRIPT = 'status script lacks prState or merged: update the checkout'

/**
 * The status script's answer. Exit 0 is READY and exit 1 is NOT READY: both print the JSON.
 * Exit 2, no output, or output that is not a status is an error, never a verdict.
 * A status without prState and merged comes from an older script: an error, or a missing field would read as CLOSED.
 */
export const parseProbe = (run: { exitCode: number; stdout: string; stderr: string }): Probe => {
  if (run.exitCode === 0 || run.exitCode === 1) {
    try {
      const parsed = JSON.parse(run.stdout) as Partial<PrStatus>
      if (isPrNumber(parsed.pr) && typeof parsed.ready === 'boolean' && Array.isArray(parsed.reasons)) {
        if (typeof parsed.prState !== 'string' || typeof parsed.merged !== 'boolean') return { kind: 'error', text: OLD_SCRIPT, perPr: false }
        return { kind: 'ok', status: parsed as PrStatus }
      }
    } catch {
      // Falls through to the error below.
    }
  }
  const said = (run.stderr || run.stdout).trim().split(/\r?\n/)[0] ?? ''
  return { kind: 'error', text: said || `status script exited ${run.exitCode} with no output`, perPr: PER_PR_ERROR.test(said) }
}

export const isClosed = (status: PrStatus): boolean => status.merged || status.prState !== 'open'

/** A check that ended badly: a status in failure or error, or a run that completed without success. A running check is not one. */
const FAILED_CHECK = /^status ".*" is (failure|error)$|^check ".*" is completed\//

/** The head was reviewed and something needs a fix: open threads, a low confidence score or a failed check. */
const needsAction = (status: PrStatus): boolean =>
  status.reviewedHead &&
  (status.unresolved > 0 || status.lowConfidence === true || status.reasons.some(reason => FAILED_CHECK.test(reason)))

/** The reviewer app (Greptile, or CodeRabbit on a labelled PR) will not review this head without a nudge. */
const reviewMissing = (status: PrStatus): boolean => status.rateLimited || status.coderabbitLimited === true

export const stateOf = (status: PrStatus): PrState => {
  if (isClosed(status)) return 'CLOSED'
  if (status.ready) return 'READY'
  // Findings on a reviewed head come first: a skipped CodeRabbit review must not hide an open thread to fix.
  if (status.rateLimited) return 'LIMITED'
  if (needsAction(status)) return 'REVIEWED'
  return reviewMissing(status) ? 'LIMITED' : 'PENDING'
}

/** The 60 minute clock belongs to the head: a push starts it again, and the last alert no longer applies. */
const forHead = (watch: PrWatch, head: string, now: number): PrWatch => {
  if (watch.head === head) return watch
  const { alerted: _alerted, ...rest } = watch
  return { ...rest, head, since: now }
}

/** The watch after a good check: the failure count is cleared. */
const cleared = ({ fails: _fails, ...rest }: PrWatch): PrWatch => rest

/**
 * Folds one check into a watch. READY and CLOSED end the watch (`watch` null) and alert.
 * LIMITED alerts once and stays. REVIEWED and STALLED alert once per head and stay.
 * PENDING never alerts: waiting is the normal state.
 */
export const settle = (watch: PrWatch, status: PrStatus, now: number): { watch: PrWatch | null; alert: Alert | null } => {
  const base = forHead(watch, status.head, now)
  const found = stateOf(status)
  const state = found === 'PENDING' && now - (base.since ?? now) >= STALL_MS ? 'STALLED' : found
  const alert: Alert = { pr: watch.pr, state, headShort: status.headShort, merged: status.merged, whenReady: watch.whenReady, reasons: status.reasons }
  if (state === 'READY' || state === 'CLOSED') return { watch: null, alert }
  const next = { ...cleared(base), state }
  if (state === 'LIMITED' && watch.state !== 'LIMITED') return { watch: next, alert }
  const marker = `${state}:${status.head}`
  if ((state === 'REVIEWED' || state === 'STALLED') && base.alerted !== marker) return { watch: { ...next, alerted: marker }, alert }
  return { watch: next, alert: null }
}

/** A failure of this PR's own check. Null when the count reaches the limit: the PR leaves the list. */
export const noteFailure = (watch: PrWatch): PrWatch | null => {
  const fails = (watch.fails ?? 0) + 1
  return fails >= MAX_FAILS ? null : { ...watch, fails }
}

const WORDS: Record<PrState, string> = {
  READY: 'READY',
  PENDING: 'pending',
  CLOSED: 'closed',
  LIMITED: 'a review did not finish (Greptile or CodeRabbit)',
  REVIEWED: 'reviewed, not READY',
  STALLED: 'no Greptile review after 60 minutes',
}

const word = (alert: Alert): string => (alert.state === 'CLOSED' && alert.merged ? 'merged' : WORDS[alert.state])

export const toastText = (alert: Alert): string => `PR #${alert.pr}: ${word(alert)}`

/** The one line the model gets. It never asks for a merge. */
export const reportLine = (alert: Alert): string => {
  const lead = `PR watcher: #${alert.pr} head ${alert.headShort}`
  if (alert.state === 'LIMITED') {
    return `${lead} has no finished review (Greptile or CodeRabbit: cancelled, failed, skipped or rate limited). Act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'STALLED') {
    return `${lead} has no Greptile review after 60 minutes. Act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'REVIEWED') {
    return `${lead} was reviewed by Greptile but is not READY: ${alert.reasons.slice(0, 5).join('; ')}. Act per pr-review-loop.md "When the review lands": read every finding, fix the real ones on the PR branch, dismiss false positives with a one-line reason, then report the finding, fixed and dismissed counts and the CI status to Dave. Do not merge it. The watch continues.`
  }
  return `${lead} is READY (Greptile reviewed it, confidence at least 4/5, 0 threads unresolved, checks green). Report this to Dave. Do not merge it: only Dave's yes lands a PR.`
}

export const statusText = (status: PrStatus): string => {
  const state = stateOf(status)
  const head = `PR #${status.pr} head ${status.headShort} (${status.branch}): ${state === 'CLOSED' ? (status.merged ? 'MERGED' : 'CLOSED') : state === 'READY' ? 'READY' : 'NOT READY'}`
  const rows = [
    `  Greptile reviewed the head: ${status.reviewedHead ? 'yes' : 'NO'}`,
    `  Confidence: ${typeof status.confidence === 'number' ? `${status.confidence}/5` : 'unknown'}`,
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
