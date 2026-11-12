import type { CheckpointAsk, CheckpointRecord, PrState, PrWatch, SlotRow } from '../../types'
import { slotLine } from './slot-model'
import type { AlertSlot } from './slot-model'

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
  /** The CodeRabbit commit status on the head: pending, success, failure, error or absent. Null when the labels do not require CodeRabbit. Absent from older scripts. */
  coderabbit?: string | null
  /** READY took a Minor-only CodeRabbit review of the earlier head `from` plus a push of `deltaLines` lines or fewer. Null otherwise. Absent from older scripts. */
  coderabbitCarried?: { from: string; deltaLines: number } | null
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
  /** CodeRabbit PR reviews that finished (distinct commits with a review body). A request that was rate limited or skipped is not in it. Absent from older scripts. */
  coderabbitReviews?: number
}

/** `perPr` marks an error that belongs to this PR alone (a 404, a list too long); any other error is shared by all PRs. */
export type Probe = { kind: 'ok'; status: PrStatus } | { kind: 'error'; text: string; perPr: boolean }

/** What the watcher tells Dave and the model about one PR. */
export type Alert = {
  pr: number
  state: PrState
  /** The full head the alert was built for: the re-probe before delivery compares it with the PR's head then. */
  head: string
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
  /** Set when the free-slot queue holds the PR: the queue posts the CodeRabbit review, so the model lines say not to. */
  slot?: AlertSlot
}

/** What the lines about a CodeRabbit round need from the checkpoint record. `rounds` is null for an older status script. */
export type AlertCheckpoint = {
  budget: [number, number]
  rounds: number | null
  granted: number | null
  declined: { round: number } | null
  /** The router band from the record (HIGH, CRITICAL, ...). Null for an older record. */
  band: string | null
}

/** `sent` is the ledger of model lines delivered (alertKey): each head and reason pair goes out once. */
export type WatchDoc = { prs: PrWatch[]; backoffUntil: number; touched: number; sent?: string[] }

/** The ledger keeps this many keys; older ones fall off. */
export const SENT_MAX = 40

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
  const sent = Array.isArray(doc.sent) ? doc.sent.filter((key): key is string => typeof key === 'string').slice(-SENT_MAX) : []
  return { prs, backoffUntil: typeof doc.backoffUntil === 'number' ? doc.backoffUntil : 0, touched: now, ...(sent.length ? { sent } : {}) }
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
export const NONE_NO_CHECKPOINT_NOTE = 'review:none has no saved checkpoint (pathway=none) on this head; call pr_checkpoint {pr} or re-run the router workflow'
export const CLASS_RAISED_NOTE = 'class raised after the checkpoint (review:none was chosen at a lower class). Call pr_checkpoint {pr}: it asks Dave whether to return the PR to draft and pick again'

/** CodeRabbit findings outside the diff that nobody handled yet. Whatever the labels: they make no thread. */
const outsideDiffCount = (status: PrStatus): number =>
  status.reasons.some(reason => OUTSIDE_DIFF_REASON.test(reason)) ? status.coderabbitOutsideDiff ?? 0 : 0

/**
 * The phrase that starts a waiver comment: "Review waived by Dave". Post it only after Dave's explicit yes to waive the bot review
 * (pr-review-loop.md "Review waiver"; scripts/github/waiver-phrase.test.mjs pins the phrase in both files).
 * A waiver stops ONE thing: the opening-review question the watcher queues for Dave (`asking` in index.ts). It is not proof that
 * Dave said yes: the agents post as the PR author too (same GitHub account). So it never hides an alert, never changes a status
 * text and never reaches the model. A signal only Dave can send must wait for a UserPromptSubmit marker (PR flow review, Phase 3).
 */
export const WAIVER_PREFIX = 'Review waived by Dave'

/**
 * Whether `gh pr view N --json author,comments` shows a waiver comment: one from the PR author whose body starts with WAIVER_PREFIX.
 * A comment from another account does not count (a bot or a reviewer can quote the words). Any other shape is "not waived", never a throw.
 */
export const isWaived = (view: unknown): boolean => {
  const pr = view as { author?: { login?: unknown } | null; comments?: unknown } | null | undefined
  const author = pr?.author?.login
  const comments: unknown = pr?.comments
  if (typeof author !== 'string' || !Array.isArray(comments)) return false
  return comments.some((one: { author?: { login?: unknown } | null; body?: unknown } | null) => {
    const login = one?.author?.login
    return typeof login === 'string' && login.toLowerCase() === author.toLowerCase() && typeof one?.body === 'string' && one.body.trimStart().startsWith(WAIVER_PREFIX)
  })
}

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
  // A draft waits on Dave's review pick, asked by a tap (pr_checkpoint): no bot reviews it, so it is never PENDING, STALLED, LIMITED or REVIEWED.
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

const alertOf = (pr: number, whenReady: boolean, state: PrState, status: PrStatus, cp: AlertCheckpoint | null): Alert => ({
  pr, state, head: status.head, headShort: status.headShort, merged: status.merged, whenReady, reasons: status.reasons,
  ...(status.routing ? { bots: status.routing.required, reviewedBy: reviewedBots(status) } : {}),
  ...(state === 'LIMITED' && rateLimitedByCodeRabbit(status) ? { rateLimit: { minutes: status.coderabbitRetryMinutes ?? null } } : {}),
  ...(state === 'PROOF' ? { proofProblems: proofProblemsOf(status) } : {}),
  ...(state === 'REVIEWED' && outsideDiffCount(status) > 0 ? { outsideDiff: outsideDiffCount(status) } : {}),
  ...(cp ? { checkpoint: cp } : {}),
})

/**
 * The alert as the PR reads now, for the re-probe right before a model line goes out. Null when the problem is gone:
 * the PR is merged or closed, its head moved (the new head alerts at the next check), or its state is no longer the alert's.
 * STALLED is PENDING that waited 60 minutes, so a PENDING PR still holds it.
 */
export const refreshAlert = (alert: Alert, fresh: PrStatus, cp: AlertCheckpoint | null): Alert | null => {
  if (isClosed(fresh) || fresh.head !== alert.head) return null
  if (stateOf(fresh) !== (alert.state === 'STALLED' ? 'PENDING' : alert.state)) return null
  return alertOf(alert.pr, alert.whenReady, alert.state, fresh, cp)
}

/**
 * The lines of review-status.mjs that report a CI run or the merge state (`check "x" is in_progress/null`, `status "x" is pending`,
 * `mergeable_state is "blocked"`). They change as CI runs and say nothing about why the review is missing, so they stay out of the key.
 */
const CI_REASON = /^(?:(?:status|check) ".*" is |mergeable_state is |required checks (?:not started|missing|ended skipped or neutral) on |base branch ")/

/** One model line per PR, state, head and reason. A REVIEWED line is keyed by the bots that reviewed, a PROOF line by its problems, LIMITED and STALLED by their reasons without the CI lines. */
export const alertKey = (alert: Alert): string => {
  const detail = alert.state === 'REVIEWED' ? [...(alert.reviewedBy ?? [])].sort() : alert.state === 'PROOF' ? alert.proofProblems ?? [] : alert.reasons.filter(reason => !CI_REASON.test(reason))
  return [alert.pr, alert.state, alert.head, detail.join('|')].join(' ')
}

export const wasSent = (doc: WatchDoc, key: string): boolean => (doc.sent ?? []).includes(key)

export const markSent = (doc: WatchDoc, key: string): WatchDoc => ({ ...doc, sent: [...(doc.sent ?? []), key].slice(-SENT_MAX) })

/** Takes a key back out of the ledger: the line it stood for was never delivered. */
export const unmarkSent = (doc: WatchDoc, key: string): WatchDoc => ({ ...doc, sent: (doc.sent ?? []).filter(one => one !== key) })

export const settle = (watch: PrWatch, status: PrStatus, now: number, cp: AlertCheckpoint | null = null): { watch: PrWatch | null; alert: Alert | null } => {
  const found = stateOf(status)
  const onHead = forHead(watch, status.head, now)
  // Leaving DRAFT starts the 60 minute clock: the hours a draft waited are not hours without a review.
  const base = watch.state === 'DRAFT' && found !== 'DRAFT' ? { ...onHead, since: now } : onHead
  const state = found === 'PENDING' && now - (base.since ?? now) >= STALL_MS ? 'STALLED' : found
  const alert = alertOf(watch.pr, watch.whenReady, state, status, cp)
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
  DRAFT: "draft, waiting on Dave's review pick (the model asks him with a tap)",
}

const word = (alert: Alert): string =>
  alert.state === 'CLOSED' && alert.merged ? 'merged' : alert.state === 'STALLED' ? stalledWords(alert) : WORDS[alert.state]

export const toastText = (alert: Alert): string => `PR #${alert.pr}: ${word(alert)}`

/** The status script's reason for a Greptile run that a newer push cancelled (review-status.mjs CANCELLED_REASON). */
const CANCELLED_REVIEW = /was cancelled \(superseded by a push\)/

/**
 * The start of the reason review-status.mjs writes when only the CLI fix review line blocks the carry (noReviewCliReason).
 * Held by value; scripts/github/pr-loop-sync.test.mjs pins it. READY carries the earlier review then, so no review is posted.
 */
export const CARRY_REASON_PREFIX = 'no CodeRabbit PR-bot review of the head commit; the earlier review carries once'

// At round 0 no review exists, so nothing can carry: the carry reason cannot hold then.
const carryHolds = (alert: Alert): boolean => alert.checkpoint?.rounds !== 0 && alert.reasons.some(reason => reason.startsWith(CARRY_REASON_PREFIX))

const carryAction = (pr: number): string =>
  `Run node scripts/github/cr-fix.mjs --pr ${pr} and paste its line in the PR body: READY carries the earlier review. Do not post @coderabbitai review.`

const classRaisedLine = (pr: number): string => `Call pr_checkpoint with pr ${pr}: it asks Dave whether to return the PR to draft and pick again. The class rose after the checkpoint. Do not request a review.`

/**
 * What the model may do about a CodeRabbit review on a PR with a checkpoint record. `when` starts the clause that allows a post.
 * Dave's decline wins, then an unknown count, then the budget: at the budget the decision is Dave's, asked by the mod in the session.
 */
const budgetSentence = (cp: AlertCheckpoint, pr: number, when: string): string => {
  const [opening, extra] = cp.budget
  if (cp.declined) return `Dave declined round ${cp.declined.round} for #${pr}. Do not request a review. Report to Dave.`
  if (opening + extra === 0) return `No CodeRabbit review is budgeted for #${pr}. Do not request a review.`
  if (cp.rounds === null) return `Budget ${opening}+${extra}, rounds unknown (older status script). Do not post @coderabbitai review. Ask Dave.`
  const next = cp.rounds + 1
  if (cp.granted !== null && cp.granted >= next) return `Dave allowed round ${next}. ${when}, post one @coderabbitai review.`
  if (cp.rounds >= opening + extra) {
    return `Rounds used ${cp.rounds} of ${opening}+${extra}. Do not post @coderabbitai review. The mod asks Dave about round ${next} in the session. Do not ask him yourself.`
  }
  // Round 0: no review has run, so the advice is the opening review, not a carry of an earlier one.
  if (cp.rounds === 0) return `Rounds used 0 of ${opening}+${extra}. No CodeRabbit review has run on #${pr} yet. Dave's tap at the checkpoint covers the opening review. ${when}, post one @coderabbitai review, never with --use-credits: it is the opening review.`
  // The carry (review-status.mjs): after a Minor-only round, a fix of 30 lines or fewer with a clean cr-fix line needs no new review.
  return `Rounds used ${cp.rounds} of ${opening}+${extra}. ${when}, post one @coderabbitai review only if the last round had a Major or Critical or the fix is over 30 lines; otherwise run node scripts/github/cr-fix.mjs --pr ${pr} and paste its line in the PR body (READY carries the earlier review).`
}

/**
 * Whether the checkpoint record lets the model post a CodeRabbit review. It mirrors the order of budgetSentence:
 * Dave's decline, then a budget of 0, then an unknown count, then his grant, then the budget. No record: no limit.
 */
const checkpointAllowsPost = (cp: AlertCheckpoint | undefined): boolean => {
  if (!cp) return true
  const [opening, extra] = cp.budget
  if (cp.declined || opening + extra === 0 || cp.rounds === null) return false
  return (cp.granted !== null && cp.granted >= cp.rounds + 1) || cp.rounds < opening + extra
}

/**
 * Review matrix (2026-11-01, Dave 2026-11-04): a round past the opening is bought only for a CRITICAL PR or on Dave's grant of that round.
 * A HIGH PR's extra round comes from the free slot. No record: no limit. An unknown band (older record) fails closed.
 */
const paidAllowedForRound = (cp: AlertCheckpoint | undefined): boolean => {
  if (!cp) return true
  const [opening] = cp.budget
  if (cp.rounds !== null && cp.rounds < opening) return true
  if (cp.granted !== null && cp.rounds !== null && cp.granted >= cp.rounds + 1) return true
  return cp.band?.toUpperCase() === 'CRITICAL'
}

/** A paid review is offered only where a post is allowed: not while the carry holds (run cr-fix, post nothing), not against the budget, not for an unpaid extra round. */
const paidEligible = (alert: Alert): boolean => !carryHolds(alert) && checkpointAllowsPost(alert.checkpoint) && paidAllowedForRound(alert.checkpoint)

/**
 * Dave's paid-review policy (2026-10-30, pr-review-loop.md "Paid PR reviews"). The cap check runs before every review request.
 * cr-paid.mjs check does not read the carry, the budget or the fixed findings, so the line states the round 2 condition.
 */
const paidReview = (pr: number): string =>
  `When the next slot is over 15 minutes away, run node scripts/github/cr-paid.mjs check --pr ${pr}. For round 2 or later, do this only after every finding of the last round is fixed, its threads are resolved and the cr-fix line is clean. On ALLOW, post nothing yet. Run node scripts/github/ship-ask.mjs paid-round --pr ${pr} --json and pass its question to AskUserQuestion word for word: its first option is the free one. Post the paid comment (@coderabbitai review --use-credits) only after Dave taps a Yes option, then run cr-paid.mjs record. On ESCALATE, or when cr-paid.mjs gives no verdict (exit 2), no paid round is offered: post nothing. Run the same ship-ask.mjs command and pass its question word for word. It has no Yes option and says why. If he taps No or Stop here, or the answer matches no option, post nothing and tell him the PR waits for the free slot. If ship-ask.mjs exits with anything but 0, do not ask and do not post.`

/**
 * A paid review replaces the capacity post while it runs. The retry depends on the paid review finishing or still running, not on the
 * request having been posted: a request that produced no review must not leave the watcher LIMITED with no way out.
 */
const PAID_GATE = 'If a paid review was posted for this head: while the CodeRabbit status on the head is pending, wait for it. Otherwise, if no CodeRabbit review appeared within 30 minutes, check @coderabbitai rate limit and post one @coderabbitai review when capacity is back. If none was posted, the post below applies.'

/** The queued variant of PAID_GATE: the free-slot queue posts the free review, so the line never says to post one when capacity is back. */
const PAID_GATE_QUEUED = 'If a paid review was posted for this head: while the CodeRabbit status on the head is pending, wait for it. If none was posted, the free-slot queue posts the free review: do not post it yourself.'

const paidGate = (alert: Alert): string => (alert.slot ? PAID_GATE_QUEUED : PAID_GATE)

const NO_POST = 'Do not post @coderabbitai review.'

/**
 * What the model does about a CodeRabbit review for a PR the free-slot queue holds: nothing. The queue posts it. Null when the queue does not
 * hold the PR. A timed-out PR that is STALLED sends the model to the reader (Dave, U1): READY still needs the CodeRabbit review.
 */
const queuedAct = (alert: Alert): string | null => {
  const slot = alert.slot
  if (!slot) return null
  const where = slot.position === null ? '' : ` (${slot.position} of ${slot.total})`
  if (slot.state === 'posted') return `The free-slot queue posted @coderabbitai review for #${alert.pr}. Wait for the review. ${NO_POST}`
  if (slot.state === 'stuck') return `The free-slot queue posted twice for #${alert.pr} and no review came (stuck). ${NO_POST} Tell Dave, then call pr_checkpoint with pr ${alert.pr}: it asks him whether to keep the review pick or return the PR to draft.`
  if (slot.state === 'timed-out' && alert.state === 'STALLED') {
    return `The free-slot queue has had no free slot for #${alert.pr}${where} for 60 minutes. Run the principal-reviewer agent on head ${alert.headShort} (not in fast mode) and report its findings. READY still needs a CodeRabbit review: the queue posts @coderabbitai review when the slot opens, or Dave pays for one by a tap: run node scripts/github/ship-ask.mjs paid-round --pr ${alert.pr} --json and ask him with AskUserQuestion, word for word. ${NO_POST}`
  }
  const after = slot.state === 'awaiting-fix' ? 'after the fix push' : 'when the slot opens'
  return `The free-slot queue holds #${alert.pr}${where} and posts @coderabbitai review ${after}. ${NO_POST}`
}

/** The advice in a LIMITED or STALLED line, ending in "Then": the carry first, then the queue, then the budget, then `bare`. */
const actOf = (alert: Alert, when: string, bare: string): string => {
  if (carryHolds(alert)) return `${carryAction(alert.pr)} Then`
  const queued = queuedAct(alert)
  if (queued) return `${queued} Then`
  return alert.checkpoint ? `${budgetSentence(alert.checkpoint, alert.pr, when)} Then` : bare
}

/** The one line the model gets: LIMITED, PROOF, STALLED or REVIEWED. READY, merged and closed get a toast only. It never asks for a merge. */
export const reportLine = (alert: Alert): string => {
  const lead = `PR watcher: #${alert.pr} head ${alert.headShort}`
  if (alert.state === 'LIMITED' && alert.reasons.some(reason => CANCELLED_REVIEW.test(reason))) {
    return `${lead} had its Greptile review cancelled: a newer push superseded it. Wait for the review of the new head; if none appears, act per pr-review-loop.md "No review on the head", then report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED' && alert.rateLimit) {
    const wait = alert.rateLimit.minutes === null ? '' : ` CodeRabbit says the next included review is available in ${alert.rateLimit.minutes} minutes.`
    const act = actOf(alert, 'When capacity is back', 'Post @coderabbitai review once when capacity is back, then')
    return `${lead} is rate limited by CodeRabbit: the head has no review. Do NOT post @coderabbitai review now: it is refused and still counts against the limit. Check capacity with the comment @coderabbitai rate limit (it costs no review).${wait} ${paidEligible(alert) ? `${paidReview(alert.pr)} ${paidGate(alert)} ` : ''}${act} report to Dave. Do not merge it.`
  }
  if (alert.state === 'LIMITED') {
    const act = actOf(alert, 'When the review can run', 'Act per pr-review-loop.md "No review on the head", then')
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
    if (alert.reasons.some(reason => reason.includes(CLASS_RAISED_NOTE))) return `${lead} (review:none): ${classRaisedLine(alert.pr)} Then report to Dave. Do not merge it.`
    if (alert.reasons.some(reason => reason.includes(NONE_NO_CHECKPOINT_NOTE))) {
      return `${lead} (review:none) has no saved checkpoint for this head: call pr_checkpoint ${alert.pr} or re-run the router workflow. Do not request a bot review. Then report to Dave. Do not merge it.`
    }
    if (alert.reasons.some(reason => reason.includes(ROUTER_NONE_UNVERIFIED_NOTE))) {
      return `${lead} (review:none) has no router state for this head. Re-run the review-router workflow for this head. Do not request a bot review. Then report to Dave. Do not merge it.`
    }
    if (!bots) return `${lead} is not READY after 60 minutes and ${alert.bots?.length ? 'every required bot has reviewed it' : 'needs no bot review'}: check CI, threads and mergeable state, then report to Dave.${why} Do not merge it.`
    const act = actOf(alert, 'When the review can run', 'Act per pr-review-loop.md "No review on the head", then')
    return `${lead} has no ${bots} review after 60 minutes. ${act} report to Dave.${why} Do not merge it.`
  }
  const by = alert.reviewedBy?.length ? botWords(alert.reviewedBy) : botWords(alert.bots)
  const body = alert.outsideDiff ? ` CodeRabbit lists ${alert.outsideDiff} finding(s) outside the diff in its review body. They have no thread. Read the review body, then fix each one or list it in the PR body under "Outside-diff: handled", one bullet per finding.` : ''
  const advice = queuedAct(alert) ?? (alert.checkpoint ? budgetSentence(alert.checkpoint, alert.pr, 'After the fix push') : '')
  const budget = advice ? ` ${advice}` : ''
  return `${lead} ${by ? `was reviewed by ${by}` : 'needs no bot review'} but is not READY: ${alert.reasons.slice(0, 5).join('; ')}. Act per pr-review-loop.md "When the review lands": read every finding, fix the real ones on the PR branch, dismiss false positives with a one-line reason, then report the finding, fixed and dismissed counts and the CI status to Dave.${body}${budget} Do not merge it. The watch continues.`
}

/** A draft's reasons that name a bot or a review request: the model must not read them as an order. */
const BOT_REASON = /CodeRabbit|Greptile|@coderabbitai|@greptileai/i
const DRAFT_LINE = "Draft: waiting on Dave's review pick. The model asks him with a tap (pr_checkpoint). Do not request a review."

/** The status the model reads. A draft drops the reasons that send it to a bot and gains the draft line. */
export const statusForModel = (status: PrStatus): PrStatus =>
  isDraftStatus(status) ? { ...status, reasons: [...status.reasons.filter(reason => !BOT_REASON.test(reason)), DRAFT_LINE] } : status

/** The status the model reads. `slot` is the PR's free-slot queue row, when the queue holds it: one more row says where it stands. */
export const statusText = (status: PrStatus, slot?: SlotRow | null): string => {
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
    ...(slot ? [`  Free-slot queue: ${slotLine(slot)}`] : []),
  ]
  return [head, ...rows, ...status.reasons.map(reason => `  - ${reason}`)].join('\n')
}

export const watchLine = (watch: PrWatch, slot?: SlotRow | null): string =>
  `#${watch.pr} ${watch.state ?? 'not checked yet'}${watch.whenReady ? ' (asks Land/No at READY)' : ''}${slot ? ` [queue: ${slotLine(slot)}]` : ''}`

export type WatchArgs = { pr: number | null; once: boolean; whenReady: boolean }

/** `12`, `12 --once`, `12 --when-ready`, or nothing. Flags in any order. */
export const parseArgs = (args: string): WatchArgs => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const number = words.find(word => /^#?\d+$/.test(word))
  const pr = number ? Number(number.replace('#', '')) : null
  return { pr: pr !== null && pr > 0 ? pr : null, once: words.includes('--once'), whenReady: words.includes('--when-ready') }
}

/** The most PRs one `/land` press lands. A longer list is a mistake or a runaway, not a plan. */
export const MAX_LAND_BATCH = 10

export type LandArgs = { prs: number[]; ready: boolean; whenReady: boolean; usage: boolean }

/**
 * `/land 12`, `/land 12 13 14`, `/land ready`, each with an optional `--when-ready` (one PR only). A repeated number counts once.
 * Any other word is a usage error: a typo must not land fewer PRs than Dave typed, or more.
 */
export const parseLandArgs = (args: string): LandArgs => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const prs: number[] = []
  let ready = false
  let whenReady = false
  let usage = false
  for (const word of words) {
    if (/^#?\d+$/.test(word)) {
      const pr = Number(word.replace('#', ''))
      if (pr < 1 || !Number.isSafeInteger(pr)) usage = true
      else if (!prs.includes(pr)) prs.push(pr)
    } else if (word.toLowerCase() === 'ready') ready = true
    else if (word === '--when-ready') whenReady = true
    else usage = true
  }
  const several = prs.length > 1 || ready
  if ((prs.length === 0 && !ready) || (ready && prs.length > 0) || (whenReady && several)) usage = true
  return { prs, ready, whenReady, usage }
}

export const landCommand = (root: string, pr: number): string => `pwsh -File "${root}/scripts/github/land-pr.ps1" -Pr ${pr}`

export const clipTail = (text: string, max: number): string => (text.length <= max ? text : `...${text.slice(text.length - max)}`)

/** The opening review waits this long after the PR left draft before Dave is asked to request it. */
export const OPENING_WAIT_MS = 30 * 60_000

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

/**
 * The rounds bought. A request that CodeRabbit rate limited or skipped made no review, so while a limit shows, only finished reviews
 * count (`coderabbitReviews`). With no limit a request in flight still counts. An older script has no `coderabbitReviews`: its total stands.
 */
const roundsOf = (status: PrStatus): number | undefined => {
  const total = status.coderabbitRounds
  const finished = status.coderabbitReviews
  if (typeof total !== 'number' || typeof finished !== 'number') return total
  return rateLimitedByCodeRabbit(status) || status.coderabbitLimited === true ? Math.min(total, finished) : total
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
 * The one question the mod asks Dave about this PR now, or null. Pure; the caller queues it once.
 * - round: CodeRabbit reviewed the head (REVIEWED) or skipped it (LIMITED, not a rate limit) and the rounds bought reach the budget.
 *   A grant for that round, or a No on it, ends the ask.
 * - opening: a coderabbit or both PR with no CodeRabbit round 30 minutes after the mod's --apply (the PR left draft), not rate limited, and
 *   not while the CodeRabbit commit status is pending (a review may be starting; the ask comes at a later check if it is not).
 * - greptile: a both PR, CodeRabbit reviewed the head, nothing unresolved, Greptile has not. Once per PR.
 * An older status script has no round count: no round ask, and the opening ask reads the count as 0.
 * `inQueue`: the free-slot queue holds the PR and posts its review, so there is no opening ask.
 */
export const askFor = (record: CheckpointRecord | null, status: PrStatus, now: number, granted: number | null, inQueue = false): CheckpointAsk | null => {
  if (!record || record.state !== 'applied' || isClosed(status) || status.ready || isDraftStatus(status)) return null
  if (record.pathway !== 'coderabbit' && record.pathway !== 'both') return null
  const rounds = roundsOf(status)
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
  if ((rounds ?? 0) === 0 && (status.coderabbitRequests ?? 0) === 0 && !reviewed && !limited && status.coderabbitLimited !== true && status.coderabbit !== 'pending' && !record.opened && !inQueue && record.declined?.kind !== 'opening') {
    if (now - (record.appliedAt ?? now) < OPENING_WAIT_MS) return null
    return askAt(
      status,
      'opening',
      `CodeRabbit has not started on #${status.pr} 30 minutes after ready. Post one @coderabbitai review? It counts as the opening review (round 1 of ${opening}+${extra}).`,
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
        rounds: roundsOf(status) ?? null,
        granted,
        declined: record.declined ? { round: record.declined.round } : null,
        band: typeof record.band === 'string' ? record.band : null,
      }
    : null
