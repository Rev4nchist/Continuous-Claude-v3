import type { AgentRun, BoardLane, FileTouch, HudLimit, KeeperRecord, PrState } from '../../types'
import type { AskKind, Chip } from './brief'
import type { Drift } from './steward'
import { oneLine } from './text'
import type { WorkflowFeed, WorkflowProgress } from './workflow-model'

// The /os glossary (.claudedocs/2026-10-29-os-pane-glossary.md) as functions: an event in, one plain English sentence out. Pure: no engine,
// no clock, no state. Every returned string is redacted as a whole, made one line and bounded (oneLine). An unknown state or kind reads as a
// plain label, never as JSON, null or undefined. Observer only: nothing here reaches the session.

const MIN = 60_000
const LONG_RUN_MS = 10 * MIN
const KILL_WINDOW = 5
const KILL_LOST = 3
const NO_TEXT = '(no text)'

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
/** A piece of input text: redacted, one line, or the label when it is empty. */
const piece = (value: unknown, fallback = NO_TEXT): string => oneLine(value) || fallback

// --- Session state ---

const CHIP_WORDS: Record<Chip, string> = {
  working: 'Working',
  'waiting-on-dave': 'Waiting for you',
  blocked: 'Stuck: a step cannot go on',
  done: 'Done: every step is proven',
  idle: 'Idle',
}

export const chipWord = (chip: Chip): string => (typeof chip === 'string' && Object.hasOwn(CHIP_WORDS, chip) ? CHIP_WORDS[chip] : 'Idle')

// --- Changes (pull requests) ---

export type PrFact = { pr: number; state: PrState | null; merged?: boolean | undefined; rateLimit?: { minutes: number } | undefined }

/** The sentence for a watched change and whether it waits for Dave, or null when there is no change number. */
export const prSentence = (pr: PrFact): { text: string; needsDave: boolean } | null => {
  if (pr === null || typeof pr !== 'object' || !known(pr.pr)) return null
  const n = pr.pr
  const say = (text: string, needsDave = false) => ({ text: oneLine(text), needsDave })
  if (pr.merged === true) return say(`Change #${n} is merged.`)
  // A string, not PrState: another branch adds states (DRAFT), and an unknown one must still draw a plain sentence.
  const state: string | null = pr.state
  switch (state) {
    case 'READY':
      return say(`Change #${n} is approved and checks pass. Say "merge" to land it.`, true)
    case 'REVIEWED':
      return say(`Review found issues on change #${n}. I am fixing them.`)
    case 'PROOF':
      return say(`Change #${n} needs its test evidence fixed in the description.`)
    case 'STALLED':
      return say(`No review of change #${n} after 60 minutes.`)
    case 'LIMITED':
      // LIMITED also means a review that did not finish: only a known wait is a rate limit.
      return say(known(pr.rateLimit?.minutes) ? `The review of change #${n} did not finish: reviewer rate limit.` : `The review of change #${n} did not finish.`)
    case 'PENDING':
      return say(`Waiting for the review of change #${n}.`)
    case 'CLOSED':
      return say(`Change #${n} is closed.`)
    case 'DRAFT':
      return say(`Change #${n} is a draft, not ready for review yet.`)
    case null:
      return say(`Change #${n} is not checked yet.`)
    default:
      return say(`Change #${n} is open.`)
  }
}

// --- Asks and decisions ---

export type AskFact = { kind: AskKind; text: string; recommend?: string | undefined; answered?: true | undefined }

/** One ask in plain words; a question carries its recommendation as the next line. A stale answered ask reads as an old question. */
export const askSentence = (ask: AskFact, stale: boolean): { text: string; next?: string } => {
  if (ask.answered === true && stale) return { text: 'Old question, still open?' }
  const text = piece(ask.text)
  const rec = oneLine(ask.recommend)
  switch (ask.kind) {
    case 'question':
      return { text: oneLine(`Answer: ${text}`), ...(rec === '' ? {} : { next: oneLine(`I suggest: ${rec}`) }) }
    case 'approval':
      return { text: oneLine(`Approve: ${text}`) }
    case 'decision':
      return { text: oneLine(rec === '' ? `Decide: ${text}` : `Decide: ${text.replace(/[.!?]$/, '')}. I suggest ${rec.replace(/[.!?]$/, '')}.`) }
    case 'block':
      return { text: oneLine(`Stuck: ${text}`) }
    default:
      return { text }
  }
}

// --- Plan steps ---

export type StepFact = { state: 'todo' | 'doing' | 'done' | 'blocked'; subject: string; proven: boolean }

/** One plan step. The artifact is not here: the Steps and Checks tabs add its file name. */
export const stepSentence = (step: StepFact): string => {
  const subject = piece(step.subject, 'a step')
  switch (step.state) {
    case 'todo':
      return oneLine(`Next: ${subject}`)
    case 'doing':
      return oneLine(`Doing: ${subject}`)
    case 'done':
      return oneLine(step.proven === true ? `Done and proven: ${subject}` : `Done but not proven yet: ${subject}`)
    case 'blocked':
      return oneLine(`Stuck on: ${subject}`)
    default:
      return oneLine(`Step: ${subject}`)
  }
}

// --- Helpers ---

/** The purpose of a helper: its spawn description, else its type, else "a task". */
export const purposeOf =(run: Pick<AgentRun, 'description' | 'type'>): string => oneLine(run.description) || oneLine(run.type) || 'a task'

export const helperSentence = (run: Pick<AgentRun, 'description' | 'type' | 'status' | 'startedAt' | 'endedAt'>, now: number): string => {
  const purpose = purposeOf(run)
  switch (run.status) {
    case 'running': {
      const age = known(run.startedAt) && known(now) ? now - run.startedAt : 0
      return oneLine(age > LONG_RUN_MS ? `A helper has run ${Math.floor(age / MIN)} min: ${purpose}` : `A helper is ${purpose}`)
    }
    case 'done':
      return oneLine(`A helper finished: ${purpose}`)
    case 'failed':
      return oneLine(`A helper failed: ${purpose}`)
    default:
      return oneLine(`A helper: ${purpose}`)
  }
}

/** A workflow counts what the ledger holds; it never invents a total. */
export const workflowSentence = (progress: WorkflowProgress): string => {
  const done = known(progress.done) ? progress.done : 0
  const running = known(progress.running) ? progress.running : 0
  const failed = known(progress.failed) && progress.failed > 0 ? `, ${progress.failed} failed` : ''
  return oneLine(`A workflow: ${plural(done, 'helper')} done, ${running} running${failed}`)
}

/**
 * One workflow run on the Swarm tab, counts first so a narrow cut loses the name before the numbers: "1 running, 4 done, 1 failed · phase 2 of 2: Judge ·
 * pane-fleet-assess". A zero count is left out (a run that has nothing else reads "0 done"). The phase and the name come from the feed; with none
 * the line reads "a workflow", and a total that is not known is not drawn.
 */
export const swarmRunSentence = (progress: WorkflowProgress, feed?: Pick<WorkflowFeed, 'name' | 'phase'> | null): string => {
  const count = (value: unknown): number => (known(value) ? value : 0)
  const counts = [
    ...(count(progress.running) > 0 ? [`${count(progress.running)} running`] : []),
    ...(count(progress.done) > 0 ? [`${count(progress.done)} done`] : []),
    ...(count(progress.failed) > 0 ? [`${count(progress.failed)} failed`] : []),
  ]
  const phase = feed?.phase
  const title = oneLine(phase?.title)
  const total = phase?.total
  const of = known(total) && total > 0 ? ` of ${total}` : ''
  const phased = phase != null && known(phase.index) ? [`phase ${phase.index}${of}${title === '' ? '' : `: ${title}`}`] : []
  return oneLine([counts.length > 0 ? counts.join(', ') : '0 done', ...phased, oneLine(feed?.name) || 'a workflow'].join(' · '))
}

// --- Brief health ---

const STEWARD_TAIL = / since the brief changed$/

/** The steward's drift in plain words, or null when nothing drifted. */
export const driftSentence = (drift: Drift | null): string | null => {
  if (drift === null || typeof drift !== 'object') return null
  switch (drift.level) {
    case 'unset':
      return 'The session goal is not set yet, and work has started.'
    case 'finished':
      return 'Every plan step is done, but work goes on.'
    case 'stale': {
      const counts = oneLine(drift.reason).replace(STEWARD_TAIL, '')
      return oneLine(`${counts === '' ? 'Work has moved' : counts} since the plan last changed.`)
    }
    default:
      return null
  }
}

// --- Lanes ---

export const laneSentence = (lane: BoardLane): string => {
  const id = piece(lane.id, 'unnamed')
  switch (lane.state) {
    case 'active': {
      if (lane.mine !== true && lane.owner === null) return oneLine(`A lane nobody holds yet: ${id}`)
      if (lane.mine !== true) return oneLine(`Another session holds lane ${id}`)
      const title = oneLine(lane.title)
      return oneLine(title === '' ? `You hold lane ${id}` : `You hold lane ${id}: ${title}`)
    }
    case 'ready':
      return oneLine(`Lane ${id} is ready for the next step`)
    case 'review':
      return oneLine(`Lane ${id} waits for review`)
    case 'blocked':
      return oneLine(`Lane ${id} is blocked`)
    default:
      return oneLine(`Lane ${id}`)
  }
}

// --- Files ---

/** Looked at, Changed (+added -removed) and Saved to git, in that order; a state with no file is left out. */
export const filesSentences = (files: FileTouch[]): string[] => {
  const list = Array.isArray(files) ? files : []
  const read = list.filter(one => one?.state === 'read').length
  const edited = list.filter(one => one?.state === 'edited')
  const committed = list.filter(one => one?.state === 'committed').length
  const sum = (key: 'added' | 'removed'): number => edited.reduce((n, one) => n + (known(one[key]) ? one[key] : 0), 0)
  return [
    ...(read > 0 ? [`Looked at ${plural(read, 'file')}`] : []),
    ...(edited.length > 0 ? [`Changed ${plural(edited.length, 'file')} (+${sum('added')} -${sum('removed')})`] : []),
    ...(committed > 0 ? [`Saved ${plural(committed, 'file')} to git`] : []),
  ]
}

// --- Compaction (keeper) ---

/** The records the keeper line judges, newest first (a tie goes to the later record), at most the kill window. A null or untimed record is skipped. */
const judgedOf = (records: KeeperRecord[]): KeeperRecord[] =>
  (Array.isArray(records) ? records : [])
    .map((one, i) => ({ one, i }))
    .filter(({ one }) => one !== null && typeof one === 'object' && known(one.at))
    .sort((a, b) => b.one.at - a.one.at || b.i - a.i)
    .slice(0, KILL_WINDOW)
    .map(({ one }) => one)

/** The record that sets the keeper line: the same pick keeperSentence makes, so a row's tone and its text read one source. Null with no record. */
export const newestKeeper = (records: KeeperRecord[]): KeeperRecord | null => judgedOf(records)[0] ?? null

/** The newest record sets the line; 3 of the newest 5 that lost the plan add the kill rule. Null with no record. */
export const keeperSentence = (records: KeeperRecord[]): { text: string; kill: boolean } | null => {
  const judged = judgedOf(records)
  const newest = judged[0]
  if (newest === undefined) return null
  const lost = judged.filter(one => one.kept !== true).length
  if (lost >= KILL_LOST) return { text: `The plan keeper failed ${lost} of ${judged.length} times. Consider removing it.`, kill: true }
  return { text: newest.kept === true ? 'The last summary kept the plan.' : 'The last summary lost the plan.', kill: false }
}

// --- Money and room ---

const percent = (value: number): number => Math.round(value)

/** Context, cost, the 5-hour and weekly allowance, and cache, in that order. A field that is not known is left out. */
export const roomSentences = (room: { ctx: number | null; costUsd: number | null; cachePct: number | null; limits: HudLimit[] }): string[] => {
  const limits = Array.isArray(room.limits) ? room.limits : []
  const allowance = (kind: string, name: string): string[] => {
    const found = limits.find(one => one?.kind === kind)
    return found !== undefined && known(found.percentUsed) ? [`${percent(found.percentUsed)}% of the ${name} allowance used`] : []
  }
  return [
    ...(known(room.ctx) ? [`Context ${percent(room.ctx)}% full`] : []),
    ...(known(room.costUsd) ? [`Spent $${room.costUsd.toFixed(2)} this session`] : []),
    ...allowance('five_hour', '5-hour'),
    ...allowance('seven_day', 'weekly'),
    ...(known(room.cachePct) ? [`Cache saving ${percent(room.cachePct)}%`] : []),
  ]
}

// --- Checks and proofs ---

/** A proof in plain words: the numbers when it has them, else that it was saved. */
export const proofSentence = (proof: { subject: string; result?: { passed: number; failed: number } | undefined }): string => {
  const result = proof.result
  if (result !== undefined && known(result.passed) && known(result.failed)) {
    const total = result.passed + result.failed
    if (result.failed > 0) return total === 1 ? '1 of 1 test fails' : `${result.failed} of ${total} tests fail`
    return result.passed === 1 ? '1 test passes' : `${result.passed} tests pass, 0 fail`
  }
  const subject = oneLine(proof.subject)
  return oneLine(subject === '' ? 'Proof saved' : `Proof saved for "${subject}"`)
}
