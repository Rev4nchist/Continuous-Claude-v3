import type { EngineInterface } from 'claude-code'

import type { CheckpointAsk, CheckpointRecord } from '../../types'
import { readRecord } from '../pr-loop/model'
import { QUEUE_BANDS, slotAdd } from '../pr-loop/slot'
import { askDave, freeDialog, run, takeDialog, tellModel } from './ask'
import {
  ASK_DEFER_MS,
  ASK_LEASE_MS,
  ASK_MAX_DISMISSED,
  ENGINE_REL,
  answerOfLabel,
  askSpec,
  commentArgv,
  firstLine,
  stateArgv,
} from './model'

// The questions of the watcher (a round past the budget, the opening review, Greptile) as dialogs. pr-loop queues an ask per PR, kind and
// head in `checkpoint:asks:<session>`; a dialog cannot live for days, the queue can. Each tick raises one, under the same one-dialog flag
// as the tool. Only an exact match of one of the mod's own labels answers; Esc, free text and an empty answer defer the ask.

export const ASKS_PREFIX = 'checkpoint:asks:'
export const RECORD_PREFIX = 'checkpoint:pr:'
export const GRANT_PREFIX = 'checkpoint:grant:'
const LEASE_PREFIX = 'checkpoint:asking:'
const VIEW_TIMEOUT_MS = 30_000

function sessionOf($: EngineInterface): Promise<string> {
  return $.session.id()
}

/** The session root, and only when it holds the engine: the engine reads the facts of the checkout it runs in. */
export async function rootOf($: EngineInterface): Promise<string | null> {
  try {
    const root = await $.session.root()
    return (await $.fs.exists(`${root}/${ENGINE_REL}`)) ? root : null
  } catch {
    return null
  }
}

// ---- the queue --------------------------------------------------------------------------------------------------------------------

export const isAsk = (value: unknown): value is CheckpointAsk => {
  const ask = value as Partial<CheckpointAsk> | null
  return !!ask && Number.isInteger(ask.pr) && typeof ask.head === 'string' && typeof ask.text === 'string' && (ask.kind === 'opening' || ask.kind === 'round' || ask.kind === 'greptile')
}

export async function loadAsks($: EngineInterface): Promise<CheckpointAsk[]> {
  const value = await $.store.get(`${ASKS_PREFIX}${await sessionOf($)}`)
  return Array.isArray(value) ? value.filter(isAsk) : []
}

/** An empty queue deletes the key. */
export async function saveAsks($: EngineInterface, list: CheckpointAsk[]): Promise<void> {
  const key = `${ASKS_PREFIX}${await sessionOf($)}`
  if (list.length === 0) await $.store.delete(key)
  else await $.store.set(key, list)
}

export const sameAsk = (a: CheckpointAsk, b: CheckpointAsk): boolean => a.pr === b.pr && a.kind === b.kind && a.head === b.head

/** One ask per PR, kind and head. */
export async function queueAsk($: EngineInterface, ask: CheckpointAsk): Promise<void> {
  const list = await loadAsks($)
  if (list.some(one => sameAsk(one, ask))) return
  await saveAsks($, [...list, ask])
}

/** Whether the record already holds Dave's answer to this ask (another session may have answered it): the queued copy is stale. */
export const isAnswered = (ask: CheckpointAsk, record: CheckpointRecord | null, granted: number | null): boolean => {
  if (!record) return false
  if (ask.kind === 'opening') return !!record.opened || record.declined?.kind === 'opening'
  if (ask.kind === 'round') {
    const round = ask.round ?? 1
    return (granted !== null && granted >= round) || (record.declined?.kind === 'round' && record.declined.round === round)
  }
  return !!record.greptile
}

// ---- one asking session per PR ----------------------------------------------------------------------------------------------------

type Lease = { session: string; until: number }

const isLease = (value: unknown): value is Lease => {
  const lease = value as Partial<Lease> | null | undefined
  return !!lease && typeof lease.session === 'string' && typeof lease.until === 'number'
}

/**
 * The lease `checkpoint:asking:<pr>`: the first watching session whose tick finds no live lease claims it and raises the dialog; another
 * watching session sees a live lease and raises nothing. A holder that stops renewing (the session ended) lapses, and the next watcher asks.
 * The read and the write are two store calls, so two sessions that tick in the same moment may both claim: accepted, the dialogs are idempotent.
 */
async function claim($: EngineInterface, pr: number, now: number, until: number = now + ASK_LEASE_MS): Promise<boolean> {
  const session = await sessionOf($)
  const held = await $.store.get(`${LEASE_PREFIX}${pr}`)
  if (isLease(held) && held.session !== session && held.until > now) return false
  await $.store.set(`${LEASE_PREFIX}${pr}`, { session, until })
  return true
}

async function releaseLease($: EngineInterface, pr: number): Promise<void> {
  const held = await $.store.get(`${LEASE_PREFIX}${pr}`)
  if (isLease(held) && held.session === (await sessionOf($))) await $.store.delete(`${LEASE_PREFIX}${pr}`)
}

// ---- the answer's effect ----------------------------------------------------------------------------------------------------------

/** A round allowed up to `allowed` clears only a round decline at or below it. An opening decline or a later round decline stays. */
export const coverDecline = (stored: CheckpointRecord | null, allowed: number): { covered: boolean; retained: string | null } => {
  const covered = stored?.declined?.kind === 'round' && stored.declined.round <= allowed
  const retained = stored?.declined && !covered ? (stored.declined.kind === 'opening' ? 'the opening review' : `round ${stored.declined.round}`) : null
  return { covered, retained }
}

/** A lower grant never lowers a round Dave already allowed, whichever head that grant carries. */
export async function allowedRound($: EngineInterface, pr: number, round: number): Promise<number> {
  const prior = (await $.store.get(`${GRANT_PREFIX}${pr}`)) as { round?: unknown } | null | undefined
  return prior && typeof prior.round === 'number' ? Math.max(prior.round, round) : round
}

export const keptNotice = (pr: number, round: number, retained: string): string =>
  `PR checkpoint: Dave allowed round ${round} for #${pr}, but his decline of ${retained} stays. Do not request that review.`

export const askNotice = (ask: CheckpointAsk, answer: 'yes' | 'no', queued = false): string => {
  const round = ask.round ?? 1
  if (ask.kind === 'round') {
    if (answer === 'yes' && queued) return `PR checkpoint: Dave allowed round ${round} for #${ask.pr}: the free-slot queue posts @coderabbitai review after the fix push. Do not post it.`
    return answer === 'yes'
      ? `PR checkpoint: Dave allowed round ${round} for #${ask.pr}: after the fix push, post one @coderabbitai review.`
      : `PR checkpoint: Dave declined round ${round} for #${ask.pr}. Do not request a review. Report the open findings to Dave.`
  }
  if (ask.kind === 'opening') {
    return answer === 'yes'
      ? `PR checkpoint: Dave asked for the opening CodeRabbit review of #${ask.pr}. The mod posted @coderabbitai review. Do not post another.`
      : `PR checkpoint: Dave declined the opening CodeRabbit review. Do not request a review on #${ask.pr}. Report to Dave.`
  }
  return answer === 'yes'
    ? `PR checkpoint: Dave asked for Greptile on #${ask.pr}. The mod posted @greptileai. Do not post another.`
    : `PR checkpoint: Dave declined Greptile for #${ask.pr}. Do not request a Greptile review.`
}

const isQueueBand = (band: unknown): band is string => typeof band === 'string' && QUEUE_BANDS.includes(band)

/**
 * A round Dave allowed puts the PR back in the queue (awaiting the fix push). True only when the add exited 0: then the notice says the queue
 * posts. A record with no HIGH or CRITICAL band (an older record) is not queued and keeps the old notice. The head is the one the grant stores.
 */
export async function enqueueRound($: EngineInterface, record: CheckpointRecord | null, round: number, head: string): Promise<boolean> {
  if (!record || !isQueueBand(record.band)) return false
  return slotAdd($, { pr: record.pr, band: record.band, head, round }).catch(() => false)
}

type Staleness = { kind: 'open' } | { kind: 'gone'; why: string } | { kind: 'unreadable'; why: string }

/**
 * Whether a Yes may post: the PR must be open at the asked head. A post spends a review, so a state that cannot be read fails closed
 * (the question stays queued), as the post failure below does.
 */
async function staleness($: EngineInterface, root: string, ask: CheckpointAsk): Promise<Staleness> {
  const ran = await run($, stateArgv(ask.pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok) return { kind: 'unreadable', why: ran.text }
  if (ran.code !== 0) return { kind: 'unreadable', why: firstLine(ran.err || ran.out) || `gh exited ${ran.code}` }
  let info: { state?: unknown; headRefOid?: unknown }
  try {
    info = JSON.parse(ran.out)
  } catch {
    return { kind: 'unreadable', why: 'gh printed no JSON' }
  }
  if (typeof info.state !== 'string' || typeof info.headRefOid !== 'string') return { kind: 'unreadable', why: 'gh printed no state or head' }
  if (info.state.toUpperCase() !== 'OPEN') return { kind: 'gone', why: `the PR is ${info.state.toLowerCase()}` }
  if (info.headRefOid !== ask.head) return { kind: 'gone', why: `the head moved to ${info.headRefOid.slice(0, 7)}` }
  return { kind: 'open' }
}

/** The PR's head now, or null when it cannot be read (no checkout, gh failed, no JSON). */
export async function currentHead($: EngineInterface, pr: number): Promise<string | null> {
  const root = await rootOf($)
  if (!root) return null
  const ran = await run($, stateArgv(pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok || ran.code !== 0) return null
  try {
    const head = (JSON.parse(ran.out) as { headRefOid?: unknown }).headRefOid
    return typeof head === 'string' && head !== '' ? head : null
  } catch {
    return null
  }
}

/** Takes the answered ask out of the queue, and frees the lease when no ask of that PR is left. */
async function dropAsk($: EngineInterface, queue: CheckpointAsk[], ask: CheckpointAsk): Promise<void> {
  const rest = queue.filter(one => !sameAsk(one, ask))
  await saveAsks($, rest)
  if (!rest.some(one => one.pr === ask.pr)) await releaseLease($, ask.pr)
}

/**
 * Applies Dave's Yes or No to the ask the dialog showed (not to whatever heads the queue now). The ask must still be queued at the same head,
 * or the answer is dropped with a toast. A Yes that posts a comment and fails leaves the question queued. Returns the text for Dave and the model.
 */
async function applyAnswer($: EngineInterface, ask: CheckpointAsk, answer: 'yes' | 'no'): Promise<string> {
  const queue = await loadAsks($)
  if (!queue.some(one => sameAsk(one, ask))) {
    const text = `PR #${ask.pr} changed; nothing posted`
    $.ui.toast(text, { timeoutMs: 10_000 })
    return `${text}. The question left the queue while Dave answered.`
  }
  const now = await $.clock.now()
  const key = `${RECORD_PREFIX}${ask.pr}`
  const stored = readRecord(await $.store.get(key))
  let next: CheckpointRecord | null = stored
  if (ask.kind !== 'round' && answer === 'yes') {
    const root = await rootOf($)
    // A question can wait for days (restore keeps it): a late Yes spends a review only on a PR that is still open at the asked head.
    const seen = root ? await staleness($, root, ask) : null
    if (seen && seen.kind === 'unreadable') {
      const text = `PR #${ask.pr}: could not read the PR state (${seen.why}); nothing posted, the question stays queued`
      $.ui.toast(text, { timeoutMs: 10_000 })
      return text
    }
    if (seen && seen.kind === 'gone') {
      await dropAsk($, queue, ask)
      const text = `PR #${ask.pr}: question dropped, nothing posted (${seen.why})`
      $.ui.toast(text, { timeoutMs: 10_000 })
      return text
    }
    const ran = root ? await run($, commentArgv(ask.pr, ask.kind === 'opening' ? '@coderabbitai review' : '@greptileai'), root, VIEW_TIMEOUT_MS) : null
    if (!ran || !ran.ok || ran.code !== 0) {
      const text = `PR #${ask.pr}: could not post the request (${ran ? (ran.ok ? firstLine(ran.err) : ran.text) : 'no checkout'}); it stays queued`
      $.ui.toast(text, { timeoutMs: 10_000 })
      return text
    }
  }
  let retained: string | null = null
  let queued = false
  if (ask.kind === 'round' && answer === 'yes') {
    // The same rule as the typed grant (D-a, Dave 11-01): only a round decline this Yes covers goes.
    const allowed = await allowedRound($, ask.pr, ask.round ?? 1)
    await $.store.set(`${GRANT_PREFIX}${ask.pr}`, { round: allowed, head: ask.head, at: now })
    const cover = coverDecline(next, allowed)
    retained = cover.retained
    if (next && cover.covered) {
      const { declined: _declined, ...rest } = next
      next = rest as CheckpointRecord
    }
    queued = retained === null && (await enqueueRound($, stored, allowed, ask.head))
  } else if (next) {
    if (ask.kind === 'opening') next = answer === 'yes' ? { ...next, opened: { head: ask.head, at: now } } : { ...next, declined: { kind: 'opening', round: 1, head: ask.head } }
    else if (ask.kind === 'round') next = { ...next, declined: { kind: 'round', round: ask.round ?? 1, head: ask.head } }
    else next = { ...next, greptile: answer === 'yes' ? { head: ask.head, at: now } : { declined: true } }
  }
  if (next && next !== stored) await $.store.set(key, next)
  await dropAsk($, queue, ask)
  const notice = retained ? keptNotice(ask.pr, ask.round ?? 1, retained) : askNotice(ask, answer, queued)
  await tellModel($, notice)
  return notice
}

/** Esc, free text, an unknown label or an empty answer: nothing is recorded; the ask comes back once after 30 minutes. */
async function deferAsk($: EngineInterface, ask: CheckpointAsk, why: string): Promise<string> {
  const now = await $.clock.now()
  const queue = await loadAsks($)
  if (!queue.some(one => sameAsk(one, ask))) return `PR #${ask.pr}: the question left the queue. Nothing recorded.`
  const until = now + ASK_DEFER_MS
  await saveAsks($, queue.map(one => (sameAsk(one, ask) ? { ...one, dismissed: (one.dismissed ?? 0) + 1, deferredUntil: until } : one)))
  await claim($, ask.pr, now, until)
  return `PR #${ask.pr}: ${why}. Nothing recorded. The question comes back once in 30 minutes, then only when Dave types /pathway.`
}

/** The caller holds the dialog flag. Raises the dialog for one ask and applies the answer. Never throws on a closed or odd answer. */
export async function raiseAsk($: EngineInterface, ask: CheckpointAsk): Promise<string> {
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${ask.pr}`))
  const spec = askSpec(ask, typeof record?.files === 'number' ? record.files : null)
  const got = await askDave($, spec.question, spec.choices.map(one => one.label), spec.header)
  const answer = got.kind === 'text' ? answerOfLabel(spec, got.text) : null
  if (answer === null) return deferAsk($, ask, got.kind === 'closed' ? 'Dave closed the question' : 'no valid answer came back')
  return applyAnswer($, ask, answer)
}

/**
 * The tick's dialog: the first queued ask that is not deferred, not closed twice and whose PR lease this session holds or can claim.
 * One dialog at a time, under the same flag as the tool; a busy flag means a question is open, so the next tick tries again.
 */
export async function drainAsks($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const due = (await loadAsks($)).filter(one => (one.dismissed ?? 0) < ASK_MAX_DISMISSED && (one.deferredUntil ?? 0) <= now)
  if (due.length === 0 || !takeDialog()) return
  try {
    for (const ask of due) {
      if (!(await claim($, ask.pr, now))) continue
      await raiseAsk($, ask)
      return
    }
  } finally {
    freeDialog()
  }
}

/** `/pathway` with no pending checkpoint: the first queued ask, deferred or not, closed twice or not. The caller holds the dialog flag. */
export async function raiseQueued($: EngineInterface): Promise<string | null> {
  const ask = (await loadAsks($))[0]
  return ask ? raiseAsk($, ask) : null
}
