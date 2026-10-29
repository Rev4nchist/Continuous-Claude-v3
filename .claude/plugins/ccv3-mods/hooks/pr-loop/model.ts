import type { CheckpointAsk, CheckpointRecord, PrState, PrWatch } from '../../types'
import { SLASH } from '../pr-checkpoint/model'

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
  /** The PR is a draft. Absent from older scripts: DRAFT_REASON in the reasons says so. */
  isDraft?: boolean
  /** The label names on the PR. Absent from older scripts. */
  labels?: string[]
  /** CodeRabbit review requests Dave or the model posted. Absent from older scripts. */
  coderabbitRequests?: number
  /** CodeRabbit PR reviews bought so far (the automatic opening counts once). Absent from older scripts: the round ask never fires then. */
  coderabbitRounds?: number
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
  /** Set when the PR has a checkpoint record: the budget and what Dave decided. */
  checkpoint?: AlertCheckpoint
}

/** What the lines about a CodeRabbit round need from the checkpoint record. `rounds` is null for an older status script. */
export type AlertCheckpoint = {
  budget: [number, number]
  rounds: number | null
  granted: number | null
  declined: { round: number } | null
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

/**
 * Texts review-status.mjs writes, held here by value so the mod can tell them from other reasons. Not read by any state yet
 * (PR C wires them); scripts/github/pr-loop-sync.test.mjs fails when a text here differs from the .mjs.
 */
export const DRAFT_REASON = 'PR is a draft (no bot review on drafts)'
export const ROUTER_NONE_UNVERIFIED_NOTE = 'the router has not classified this head; re-run the router workflow'
export const NONE_NO_CHECKPOINT_NOTE = 'review:none has no saved checkpoint (pathway=none) on this head; run /pathway or re-run the router workflow'
export const CLASS_RAISED_NOTE = 'class raised after the checkpoint (review:none was chosen at a lower class). Return the PR to draft (gh pr ready --undo), then run /pathway again'

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
  // A draft waits on Dave's checkpoint command (SLASH): no bot reviews it, so it is never PENDING, STALLED, LIMITED or REVIEWED.
  if (isDraftStatus(status)) return 'DRAFT'
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

export const settle = (watch: PrWatch, status: PrStatus, now: number, cp: AlertCheckpoint | null = null): { watch: PrWatch | null; alert: Alert | null } => {
  const found = stateOf(status)
  const onHead = forHead(watch, status.head, now)
  // Leaving DRAFT starts the 60 minute clock: the hours a draft waited are not hours without a review.
  const base = watch.state === 'DRAFT' && found !== 'DRAFT' ? { ...onHead, since: now } : onHead
  const state = found === 'PENDING' && now - (base.since ?? now) >= STALL_MS ? 'STALLED' : found
  const alert: Alert = {
    pr: watch.pr, state, headShort: status.headShort, merged: status.merged, whenReady: watch.whenReady, reasons: status.reasons,
    ...(status.routing ? { bots: status.routing.required, reviewedBy: reviewedBots(status) } : {}),
    ...(state === 'LIMITED' && rateLimitedByCodeRabbit(status) ? { rateLimit: { minutes: status.coderabbitRetryMinutes ?? null } } : {}),
    ...(state === 'PROOF' ? { proofProblems: proofProblemsOf(status) } : {}),
    ...(state === 'REVIEWED' && outsideDiffCount(status) > 0 ? { outsideDiff: outsideDiffCount(status) } : {}),
    ...(cp ? { checkpoint: cp } : {}),
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
  if ((state === 'STALLED' || state === 'PROOF' || state === 'DRAFT') && base.alerted !== marker) return { watch: { ...next, alerted: marker }, alert }
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
  DRAFT: `draft, waiting on ${SLASH}`,
}

const word = (alert: Alert): string =>
  alert.state === 'CLOSED' && alert.merged ? 'merged' : alert.state === 'STALLED' ? stalledWords(alert) : WORDS[alert.state]

export const toastText = (alert: Alert): string => `PR #${alert.pr}: ${word(alert)}`

/** The status script's reason for a Greptile run that a newer push cancelled (review-status.mjs CANCELLED_REASON). */
const CANCELLED_REVIEW = /was cancelled \(superseded by a push\)/

const CLASS_RAISED_LINE = `Return the PR to draft (gh pr ready --undo), then run ${SLASH} again: the class rose after the checkpoint. Do not request a review.`

/**
 * What the model may do about a CodeRabbit review on a PR with a checkpoint record. `when` starts the clause that allows a post.
 * Dave's decline wins, then an unknown count, then the budget: at the budget the decision is Dave's, in the pane.
 */
const budgetSentence = (cp: AlertCheckpoint, pr: number, when: string): string => {
  const [opening, extra] = cp.budget
  if (cp.declined) return `Dave declined round ${cp.declined.round} for #${pr}. Do not request a review. Report to Dave.`
  if (opening + extra === 0) return `No CodeRabbit review is budgeted for #${pr}. Do not request a review.`
  if (cp.rounds === null) return `Budget ${opening}+${extra}, rounds unknown (older status script). Do not post @coderabbitai review. Ask Dave.`
  const next = cp.rounds + 1
  if (cp.granted !== null && cp.granted >= next) return `Dave allowed round ${next}. ${when}, post one @coderabbitai review.`
  if (cp.rounds >= opening + extra) {
    return `Rounds used ${cp.rounds} of ${opening}+${extra}. Do not post @coderabbitai review. Dave decides round ${next} in the checkpoint pane.`
  }
  return `Rounds used ${cp.rounds} of ${opening}+${extra}. ${when}, post one @coderabbitai review.`
}

/** The one line the model gets: LIMITED, PROOF, STALLED or REVIEWED. READY, merged and closed get a toast only. It never asks for a merge. */
export const reportLine = (alert: Alert): string => {
  const lead = `PR watcher: #${alert.pr} head ${alert.headShort}`
  if (alert.state === 'LIMITED' && alert.reasons.some(reason => CANCELLED_REVIEW.test(reason))) {
    return `${lead} had its Greptile review cancelled: a newer push superseded it. Wait for the review of the new head; if none appears, act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED' && alert.rateLimit) {
    const wait = alert.rateLimit.minutes === null ? '' : ` CodeRabbit says the next included review is available in ${alert.rateLimit.minutes} minutes.`
    const act = alert.checkpoint ? `${budgetSentence(alert.checkpoint, alert.pr, 'When capacity is back')} Then` : 'Post @coderabbitai review once when capacity is back, then'
    return `${lead} is rate limited by CodeRabbit: the head has no review. Do NOT post @coderabbitai review now: it is refused and still counts against the limit. Check capacity with the comment @coderabbitai rate limit (it costs no review).${wait} ${act} report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED') {
    const act = alert.checkpoint ? `${budgetSentence(alert.checkpoint, alert.pr, 'When the review can run')} Then` : 'Act per pr-review-loop.md "No review on the head", then'
    return `${lead} has no finished review (Greptile or CodeRabbit: cancelled, failed, skipped or rate limited). ${act} report to Dave. Do not merge it.`
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
    // A review:none PR with no router state, or one classed higher after the checkpoint: a bot review is not the fix.
    if (alert.reasons.some(reason => reason.includes(CLASS_RAISED_NOTE))) return `${lead} (review:none): ${CLASS_RAISED_LINE} Then report to Dave. Do not merge it.`
    if (alert.reasons.some(reason => reason.includes(ROUTER_NONE_UNVERIFIED_NOTE) || reason.includes(NONE_NO_CHECKPOINT_NOTE))) {
      return `${lead} (review:none) has no router state for this head. Re-run the review-router workflow for this head. Do not request a bot review. Then report to Dave. Do not merge it.`
    }
    if (!bots) return `${lead} is not READY after 60 minutes and ${alert.bots?.length ? 'every required bot has reviewed it' : 'needs no bot review'}: check CI, threads and mergeable state, then report to Dave.${why} Do not merge it.`
    const act = alert.checkpoint ? `${budgetSentence(alert.checkpoint, alert.pr, 'When the review can run')} Then` : 'Act per pr-review-loop.md "No review on the head", then'
    return `${lead} has no ${bots} review after 60 minutes. ${act} report to Dave.${why} Do not merge it.`
  }
  const by = alert.reviewedBy?.length ? botWords(alert.reviewedBy) : botWords(alert.bots)
  const body = alert.outsideDiff ? ` CodeRabbit lists ${alert.outsideDiff} finding(s) outside the diff in its review body. They have no thread. Read the review body, then fix each one or list it in the PR body under "Outside-diff: handled", one bullet per finding.` : ''
  const budget = alert.checkpoint ? ` ${budgetSentence(alert.checkpoint, alert.pr, 'After the fix push')}` : ''
  return `${lead} ${by ? `was reviewed by ${by}` : 'needs no bot review'} but is not READY: ${alert.reasons.slice(0, 5).join('; ')}. Act per pr-review-loop.md "When the review lands": read every finding, fix the real ones on the PR branch, dismiss false positives with a one-line reason, then report the finding, fixed and dismissed counts and the CI status to Dave.${body}${budget} Do not merge it. The watch continues.`
}

/** A draft's reasons that name a bot or a review request: the model must not read them as an order. */
const BOT_REASON = /CodeRabbit|Greptile|@coderabbitai|@greptileai/i
const DRAFT_LINE = `Draft: waiting on Dave's ${SLASH}. Do not request a review.`

/** The status the model reads. A draft drops the reasons that send it to a bot and gains the draft line. */
export const statusForModel = (status: PrStatus): PrStatus =>
  isDraftStatus(status) ? { ...status, reasons: [...status.reasons.filter(reason => !BOT_REASON.test(reason)), DRAFT_LINE] } : status

export const statusText = (status: PrStatus): string => {
  const state = stateOf(status)
  if (state === 'DRAFT') {
    const head = `PR #${status.pr} head ${status.headShort} (${status.branch}): NOT READY`
    const rows = [`  ${DRAFT_LINE}`, `  Threads unresolved: ${status.unresolved}`, `  Mergeable state: ${status.mergeable_state ?? 'unknown'}`]
    return [head, ...rows, ...status.reasons.filter(reason => !BOT_REASON.test(reason)).map(reason => `  - ${reason}`)].join('\n')
  }
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

/** The opening review waits this long after the PR left draft before Dave is asked to request it. */
export const OPENING_WAIT_MS = 15 * 60_000

/** The checkpoint record of a PR, or null when the stored value lacks the fields the asks read. */
export const readRecord = (value: unknown): CheckpointRecord | null => {
  const rec = value as Partial<CheckpointRecord> | null | undefined
  if (!rec || typeof rec !== 'object') return null
  const budget = rec.budget
  if (!isPrNumber(rec.pr) || (rec.state !== 'confirmed' && rec.state !== 'applied') || typeof rec.head !== 'string' || typeof rec.pathway !== 'string') return null
  if (!Array.isArray(budget) || budget.length !== 2 || !budget.every(n => typeof n === 'number')) return null
  return rec as CheckpointRecord
}

/** The round Dave allowed (checkpoint:grant:<n>), or null. */
export const grantRound = (value: unknown): number | null => {
  const round = (value as { round?: unknown } | null | undefined)?.round
  return typeof round === 'number' ? round : null
}

/** A draft or an older script's DRAFT_REASON: no bot reviews a draft, so no ask is made. */
const isDraftStatus = (status: PrStatus): boolean => status.isDraft ?? status.reasons.includes(DRAFT_REASON)

const askAt = (status: PrStatus, kind: CheckpointAsk['kind'], text: string, round?: number): CheckpointAsk => ({
  kind,
  pr: status.pr,
  head: status.head,
  text,
  ...(round === undefined ? {} : { round }),
})

/**
 * The one question the checkpoint pane asks Dave about this PR now, or null. Pure; the caller queues it once.
 * - round: CodeRabbit reviewed the head (REVIEWED) or skipped it (LIMITED, not a rate limit) and the rounds bought reach the budget.
 *   A grant for that round, or a No on it, ends the ask.
 * - opening: a coderabbit or both PR with no CodeRabbit round 15 minutes after the mod's --apply (the PR left draft), not rate limited.
 * - greptile: a both PR, CodeRabbit reviewed the head, nothing unresolved, Greptile has not. Once per PR.
 * An older status script has no round count: no round ask, and the opening ask reads the count as 0.
 */
export const askFor = (record: CheckpointRecord | null, status: PrStatus, now: number, granted: number | null): CheckpointAsk | null => {
  if (!record || record.state !== 'applied' || isClosed(status) || status.ready || isDraftStatus(status)) return null
  if (record.pathway !== 'coderabbit' && record.pathway !== 'both') return null
  const rounds = status.coderabbitRounds
  const [opening, extra] = record.budget
  const reviewed = status.coderabbitReviewedHead === true
  const limited = rateLimitedByCodeRabbit(status) || status.rateLimited
  const state = stateOf(status)
  const skipped = state === 'LIMITED' && status.coderabbitLimited === true && !limited
  if (typeof rounds === 'number' && opening + extra > 0 && rounds >= opening + extra && ((state === 'REVIEWED' && reviewed) || skipped)) {
    const round = rounds + 1
    const declined = record.declined?.kind === 'round' && record.declined.round === round
    if (declined || (granted !== null && granted >= round)) return null
    const count = record.capacity?.count
    return askAt(status, 'round', `Round ${round} of ${opening}+${extra} for #${status.pr}. Spend 1 more? 7d ≈${typeof count === 'number' ? count : 'unknown'}`, round)
  }
  // An older status script has no round count: no CodeRabbit review and no request on the PR reads as round 0.
  if ((rounds ?? 0) === 0 && (status.coderabbitRequests ?? 0) === 0 && !reviewed && !limited && status.coderabbitLimited !== true && !record.opened && record.declined?.kind !== 'opening') {
    if (now - (record.appliedAt ?? now) < OPENING_WAIT_MS) return null
    return askAt(
      status,
      'opening',
      `CodeRabbit has not started on #${status.pr} 15 minutes after ready. Post one @coderabbitai review? It counts as the opening review (round 1 of ${opening}+${extra}).`,
      1,
    )
  }
  if (record.pathway === 'both' && reviewed && status.unresolved === 0 && !status.reviewedHead && !record.greptile) {
    return askAt(status, 'greptile', `Ask Greptile to review the final head ${status.headShort} of #${status.pr}? 3 credits (Plus).`)
  }
  return null
}

/** What the report lines need from the record, the status and the grant. Null when the PR has no record. */
export const checkpointOf = (record: CheckpointRecord | null, status: PrStatus, granted: number | null): AlertCheckpoint | null =>
  record
    ? {
        budget: record.budget,
        rounds: typeof status.coderabbitRounds === 'number' ? status.coderabbitRounds : null,
        granted,
        declined: record.declined ? { round: record.declined.round } : null,
      }
    : null
