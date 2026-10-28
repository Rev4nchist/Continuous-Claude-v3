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
  /** CodeRabbit's notice for the head is a rate limit or a review limit (not a skip or a failure). Absent from older scripts: the reason text decides. */
  coderabbitRateLimited?: boolean | null
  /** Minutes until CodeRabbit's next included review ("Next included review available in N minutes"). Null when the notice has no figure. */
  coderabbitRetryMinutes?: number | null
  /** The PR body proof check (P4b). Absent from older scripts: the reasons carry its problems. */
  proof?: { required: boolean; type: string | null; status: string; problems: string[] }
  /** Every bot in `routing.required` reviewed the head. Absent from older scripts: `reviewedHead` decides then. */
  routedReviewed?: boolean
  /** CodeRabbit PR-bot review on the head. Null when the labels do not require CodeRabbit. */
  coderabbitReviewedHead?: boolean | null
  /** N from "Outside diff range comments (N)" in the newest CodeRabbit review of the head. Those findings make no thread. Absent from older scripts. */
  coderabbitOutsideDiff?: number
  /** The bots the PR labels require. Absent from older scripts: Greptile is the reviewer then. */
  routing?: { required: string[]; held: string | null; source: string }
  prState: string
  merged: boolean
}

/** `perPr` marks an error that belongs to this PR alone (a 404, a list too long); any other error is shared by all PRs. */
export type Probe = { kind: 'ok'; status: PrStatus } | { kind: 'error'; text: string; perPr: boolean }

/** What the watcher tells Dave and the model about one PR. */
export type Alert = {
  pr: number
  state: PrState
  headShort: string
  merged: boolean
  whenReady: boolean
  reasons: string[]
  bots?: string[]
  reviewedBy?: string[]
  /** Set when the missing CodeRabbit review is a rate limit. `minutes` is CodeRabbit's own figure, or null. */
  rateLimit?: { minutes: number | null }
  /** Set for a PROOF alert: the PR body proof problems (status.proof.problems, else the reasons that carry the prefix). */
  proofProblems?: string[]
  /** Set for a REVIEWED alert when CodeRabbit lists findings outside the diff in its review body (no thread). */
  outsideDiff?: number
}

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

/** The required bots reviewed the head. An older status has no `routedReviewed`: Greptile's `reviewedHead` is the answer. */
const reviewedByRequired = (status: PrStatus): boolean => status.routedReviewed ?? status.reviewedHead

/**
 * At least one required bot reviewed the head, so its findings can be acted on now: on a
 * review:deep PR, Greptile findings must not wait for CodeRabbit. READY still needs all of them.
 */
const someRequiredReviewed = (status: PrStatus): boolean => {
  const required = status.routing?.required
  if (!required) return status.reviewedHead
  if (required.length === 0) return true
  return (required.includes('greptile') && status.reviewedHead) ||
    (required.includes('coderabbit') && status.coderabbitReviewedHead === true) ||
    reviewedByRequired(status)
}

/** Greptile reviewed the head and the result needs action: a score under the bar, or a check that ended failure. Whatever the labels. */
const GREPTILE_FAILED = /^Greptile check ended failure/
// A failure reason needs action even with no usable summary (reviewedHead false): Greptile ends its
// check failure only when it reviewed and scored under the bar (review-status FAILED_UNREQUIRED_REASON).
const greptileFindings = (status: PrStatus): boolean =>
  (status.reviewedHead && status.lowConfidence === true) || status.reasons.some(reason => GREPTILE_FAILED.test(reason))

/**
 * The reason review-status.mjs writes while N is above the "Outside-diff: handled" count. The mod cannot import the
 * .mjs; scripts/github/pr-loop-sync.test.mjs fails when the two differ.
 */
const OUTSIDE_DIFF_REASON = /^CodeRabbit lists \d+ outside-diff finding\(s\)/

/** CodeRabbit findings outside the diff that nobody handled yet. Whatever the labels: they make no thread. */
const outsideDiffCount = (status: PrStatus): number =>
  status.reasons.some(reason => OUTSIDE_DIFF_REASON.test(reason)) ? status.coderabbitOutsideDiff ?? 0 : 0

/** The bots that reviewed the head: the required ones, plus Greptile or CodeRabbit when its own result needs action. */
const reviewedBots = (status: PrStatus): string[] => {
  const required = status.routing?.required ?? []
  const bots = greptileFindings(status) && !required.includes('greptile') ? ['greptile', ...required] : required
  const all = outsideDiffCount(status) > 0 && !bots.includes('coderabbit') ? [...bots, 'coderabbit'] : bots
  return all.filter(bot => (bot === 'greptile' ? status.reviewedHead || greptileFindings(status) : bot === 'coderabbit' ? status.coderabbitReviewedHead === true || outsideDiffCount(status) > 0 : false))
}

/**
 * A bot reviewed the head and something needs a fix: open threads or a failed check (from a required bot),
 * or a Greptile result that needs action (low score, failed check), which counts even when Greptile is not required.
 */
const needsAction = (status: PrStatus): boolean =>
  greptileFindings(status) ||
  outsideDiffCount(status) > 0 ||
  (someRequiredReviewed(status) && (status.unresolved > 0 || status.reasons.some(reason => FAILED_CHECK.test(reason))))

/** The reviewer app (Greptile, or CodeRabbit on a labelled PR) will not review this head without a nudge. */
const reviewMissing = (status: PrStatus): boolean => status.rateLimited || status.coderabbitLimited === true

/**
 * The prefix review-status.mjs puts on every PR body proof reason (PROOF_REASON_PREFIX). The mod cannot import
 * the .mjs; scripts/github/pr-loop-sync.test.mjs fails when the two differ.
 */
export const PROOF_REASON_PREFIX = 'PR body proof:'

/** The PR body proof problems of this status: the structured field, else the reasons that carry the prefix. */
export const proofProblemsOf = (status: PrStatus): string[] =>
  status.proof?.problems?.length ? status.proof.problems : status.reasons.filter(reason => reason.startsWith(PROOF_REASON_PREFIX))

/** A CodeRabbit rate limit is the cause of the missing review. Older scripts only say so in a reason. */
const CODERABBIT_RATE_LIMITED = /^CodeRabbit rate limited:/
const rateLimitedByCodeRabbit = (status: PrStatus): boolean =>
  status.coderabbitRateLimited === true || (status.coderabbitRateLimited === undefined && status.reasons.some(reason => CODERABBIT_RATE_LIMITED.test(reason)))

export const stateOf = (status: PrStatus): PrState => {
  if (isClosed(status)) return 'CLOSED'
  if (status.ready) return 'READY'
  // Findings on a reviewed head come first: a skipped CodeRabbit review, or a cancelled Greptile run on a
  // review:deep PR, must not hide a finding to fix. Nothing to fix and a review that did not finish is LIMITED.
  if (needsAction(status)) return 'REVIEWED'
  // A wrong or missing PR body proof is the author's to fix now. It must not wait as PENDING for 60 minutes.
  if (proofProblemsOf(status).length > 0) return 'PROOF'
  if (status.rateLimited) return 'LIMITED'
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
 * LIMITED alerts once and stays. REVIEWED, PROOF and STALLED alert once per head and stay.
 * PENDING never alerts: waiting is the normal state.
 */
/**
 * The bots a REVIEWED alert already covered for this head, from the stored marker. null: no REVIEWED
 * alert for this head yet. A marker from before routing (`REVIEWED:<head>`) covered Greptile only.
 */
const reviewedSeen = (alerted: string | undefined, head: string): string[] | null => {
  const prefix = `REVIEWED:${head}`
  if (!alerted || !alerted.startsWith(prefix)) return null
  const rest = alerted.slice(prefix.length)
  return rest.startsWith(':') ? rest.slice(1).split('+').filter(Boolean) : ['greptile']
}

export const settle = (watch: PrWatch, status: PrStatus, now: number): { watch: PrWatch | null; alert: Alert | null } => {
  const base = forHead(watch, status.head, now)
  const found = stateOf(status)
  const state = found === 'PENDING' && now - (base.since ?? now) >= STALL_MS ? 'STALLED' : found
  const alert: Alert = {
    pr: watch.pr, state, headShort: status.headShort, merged: status.merged, whenReady: watch.whenReady, reasons: status.reasons,
    ...(status.routing ? { bots: status.routing.required, reviewedBy: reviewedBots(status) } : {}),
    ...(state === 'LIMITED' && rateLimitedByCodeRabbit(status) ? { rateLimit: { minutes: status.coderabbitRetryMinutes ?? null } } : {}),
    ...(state === 'PROOF' ? { proofProblems: proofProblemsOf(status) } : {}),
    ...(state === 'REVIEWED' && outsideDiffCount(status) > 0 ? { outsideDiff: outsideDiffCount(status) } : {}),
  }
  if (state === 'READY' || state === 'CLOSED') return { watch: null, alert }
  const next = { ...cleared(base), state }
  if (state === 'LIMITED' && watch.state !== 'LIMITED') return { watch: next, alert }
  if (state === 'REVIEWED') {
    // A second bot reviewing the same head is news: alert again only when a bot is NEW for this head.
    // A shrink (a same-head re-run in progress) is not news. The stored marker keeps the union.
    const seen = reviewedSeen(base.alerted, status.head)
    const now = alert.reviewedBy ?? []
    if (seen !== null && now.every(bot => seen.includes(bot))) return { watch: next, alert: null }
    const union = [...new Set([...(seen ?? []), ...now])].sort()
    return { watch: { ...next, alerted: `REVIEWED:${status.head}${union.length ? `:${union.join('+')}` : ''}` }, alert }
  }
  const marker = `${state}:${status.head}`
  if ((state === 'STALLED' || state === 'PROOF') && base.alerted !== marker) return { watch: { ...next, alerted: marker }, alert }
  return { watch: next, alert: null }
}

/** A failure of this PR's own check. Null when the count reaches the limit: the PR leaves the list. */
export const noteFailure = (watch: PrWatch): PrWatch | null => {
  const fails = (watch.fails ?? 0) + 1
  return fails >= MAX_FAILS ? null : { ...watch, fails }
}

/** The bots the labels required, as words. No routing (older script): Greptile. A docs-only PR: null. */
const BOT_NAMES: Record<string, string> = { greptile: 'Greptile', coderabbit: 'CodeRabbit' }
const botWords = (bots: string[] | undefined): string | null =>
  bots === undefined ? 'Greptile' : bots.length === 0 ? null : bots.map(bot => BOT_NAMES[bot] ?? bot).join(' and ')

/** The required bots that have not reviewed the head. No routing (older script): Greptile. */
const missingBots = (alert: Alert): string[] | undefined =>
  alert.bots === undefined ? undefined : alert.bots.filter(bot => !(alert.reviewedBy ?? []).includes(bot))

const stalledWords = (alert: Alert): string => {
  const bots = botWords(missingBots(alert))
  return bots ? `no ${bots} review after 60 minutes` : 'not READY after 60 minutes'
}

const WORDS: Record<PrState, string> = {
  READY: 'READY',
  PENDING: 'pending',
  CLOSED: 'closed',
  LIMITED: 'a review did not finish (Greptile or CodeRabbit)',
  REVIEWED: 'reviewed, not READY',
  PROOF: 'PR body proof needs fixing',
  // Not used for text: word() builds STALLED from the bots that have not reviewed (stalledWords).
  STALLED: 'not READY after 60 minutes',
}

const word = (alert: Alert): string =>
  alert.state === 'CLOSED' && alert.merged ? 'merged' : alert.state === 'STALLED' ? stalledWords(alert) : WORDS[alert.state]

export const toastText = (alert: Alert): string => `PR #${alert.pr}: ${word(alert)}`

/** The status script's reason for a Greptile run that a newer push cancelled (review-status.mjs CANCELLED_REASON). */
const CANCELLED_REVIEW = /was cancelled \(superseded by a push\)/

/** What READY rests on. With Greptile in the list (or no list) the old words stay. */
const readyWords = (bots: string[] | undefined): string => {
  const named = botWords(bots)
  const parts = [named ? `${named} reviewed it` : 'no bot review was required']
  if (bots === undefined || bots.includes('greptile')) parts.push('confidence at least 4/5')
  return [...parts, '0 threads unresolved', 'checks green'].join(', ')
}

/** The one line the model gets. It never asks for a merge. */
export const reportLine = (alert: Alert): string => {
  const lead = `PR watcher: #${alert.pr} head ${alert.headShort}`
  if (alert.state === 'LIMITED' && alert.reasons.some(reason => CANCELLED_REVIEW.test(reason))) {
    return `${lead} had its Greptile review cancelled: a newer push superseded it. Wait for the review of the new head; if none appears, act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED' && alert.rateLimit) {
    const wait = alert.rateLimit.minutes === null ? '' : ` CodeRabbit says the next included review is available in ${alert.rateLimit.minutes} minutes.`
    return `${lead} is rate limited by CodeRabbit: the head has no review. Do NOT post @coderabbitai review now: it is refused and still counts against the limit. Check capacity with the comment @coderabbitai rate limit (it costs no review).${wait} Post @coderabbitai review once when capacity is back, then report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED') {
    return `${lead} has no finished review (Greptile or CodeRabbit: cancelled, failed, skipped or rate limited). Act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'PROOF') {
    const problems = alert.proofProblems ?? alert.reasons.filter(reason => reason.startsWith(PROOF_REASON_PREFIX))
    // A docs proof needs no RED or GREEN: it fails only when the review router did not class this head docs.
    const docsOnly = problems.length > 0 && problems.every(p => /proof type docs needs the review router/.test(p))
    const action = docsOnly
      ? 'a docs proof counts only when the review router classes this head docs and risk:docs is the only risk label. Change the PR so only docs paths differ, or name another proof type with RED and GREEN'
      : `add or fix the Evidence block in the PR body (pr-and-commit-style.md "Evidence block"), run the GREEN check on head ${alert.headShort} and update the GREEN line to that head`
    return `${lead} is not READY because its PR body proof is missing or wrong: ${problems.slice(0, 5).join('; ')}. Author action: ${action}. Keep the CodeRabbit and Greptile blocks in the body byte for byte. Do not merge it. The watch continues.`
  }
  if (alert.state === 'STALLED') {
    const bots = botWords(missingBots(alert))
    const why = alert.reasons.length ? ` Reasons: ${alert.reasons.slice(0, 5).join('; ')}.` : ''
    if (!bots) return `${lead} is not READY after 60 minutes and ${alert.bots?.length ? 'every required bot has reviewed it' : 'needs no bot review'}: check CI, threads and mergeable state, then report to Dave.${why} Do not merge it.`
    return `${lead} has no ${bots} review after 60 minutes. Act per pr-review-loop.md "No review on the head", then report to Dave.${why} Do not merge it.`
  }
  if (alert.state === 'REVIEWED') {
    const by = alert.reviewedBy?.length ? botWords(alert.reviewedBy) : botWords(alert.bots)
    const body = alert.outsideDiff ? ` CodeRabbit lists ${alert.outsideDiff} finding(s) outside the diff in its review body. They have no thread. Read the review body, then fix each one or list it in the PR body under "Outside-diff: handled", one bullet per finding.` : ''
    return `${lead} ${by ? `was reviewed by ${by}` : 'needs no bot review'} but is not READY: ${alert.reasons.slice(0, 5).join('; ')}. Act per pr-review-loop.md "When the review lands": read every finding, fix the real ones on the PR branch, dismiss false positives with a one-line reason, then report the finding, fixed and dismissed counts and the CI status to Dave.${body} Do not merge it. The watch continues.`
  }
  return `${lead} is READY (${readyWords(alert.bots)}). Report this to Dave. Do not merge it: only Dave's yes lands a PR.`
}

export const statusText = (status: PrStatus): string => {
  const state = stateOf(status)
  const head = `PR #${status.pr} head ${status.headShort} (${status.branch}): ${state === 'CLOSED' ? (status.merged ? 'MERGED' : 'CLOSED') : state === 'READY' ? 'READY' : 'NOT READY'}`
  const rows = [
    botWords(status.routing?.required) ? `  ${botWords(status.routing?.required)} reviewed the head: ${reviewedByRequired(status) ? 'yes' : 'NO'}` : '  Bot review: not required',
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
