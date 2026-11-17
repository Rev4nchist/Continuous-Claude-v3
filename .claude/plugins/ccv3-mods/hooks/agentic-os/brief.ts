import { redact } from '../shared/redact'
import type { OsAskItem, OsBrief, OsBriefSource, OsClearedAsk, OsPlanStep, OsProof, OsTask } from '../../types'

// The brief: what the session says about itself (PRD 5.1, 5.2, 5.5). Pure functions, no engine imports,
// so the tool handler and the hooks in index.tsx stay thin. Every string passes `redact` before it is stored.
//
// The chip reads `blocked` from two sources only: a tool call answered with `deny` (index.tsx sets `refused`),
// and a plan step with status `blocked`. PRD 5.2 lists two more, and README.md names a third path. None is wired, on purpose:
//   - a red gate: the mod has no gate signal to read yet.
//   - a peer holding the lane: the lane read (`lanes`) does not say who holds a lane for this session.
//   - a tool call answered with `isError: true`: README.md says a settings-hook block reaches the mod that way, but
//     `isError` also marks a tool that threw, a failed command and a dismissed dialog. The result cannot tell a
//     hook block from an ordinary failure, so wiring it would flip the chip to blocked on every failed command.
// Deferred until the engine marks a hook block apart from a tool error.
//
// Parser limits: the turn-end parser reads the last 16 KB of an answer, skips any line over 2,000 characters, and
// redacts the tail before it cuts anything. A skipped line is never clipped, so no half of a secret can be left.

export { redact }

export type Source = OsBriefSource
export type PlanStatus = OsPlanStep['status']
export type AskKind = OsAskItem['kind']
export type Chip = 'working' | 'waiting-on-dave' | 'blocked' | 'done' | 'idle'

// The shapes live in types/index.d.ts (PluginState needs them); they are named here for the pure functions.
export type PlanStep = OsPlanStep
export type AskItem = OsAskItem
export type Decision = OsBrief['decisions'][number]
export type ClearedAsk = OsClearedAsk
export type Proof = OsProof
/** `sources` says who set each value. A `parsed` value never replaces a `brief_set` one. `updatedAt` is the clock for a stale ask. */
export type Brief = OsBrief

/** The tool input after validation and redaction. */
export type BriefInput = {
  title?: string
  goal?: string
  stopAt?: string
  plan?: PlanStep[]
  ask?: { kind: AskKind; text: string; recommend?: string }[]
  decision?: { text: string; by: string }
  proof?: { taskId: string; artifact: string }
}

export const LIMITS = {
  title: 80,
  goal: 240,
  stopAt: 240,
  askItems: 8,
  askText: 300,
  planSteps: 30,
  planText: 200,
  recommend: 300,
  id: 100,
  by: 80,
  decisionText: 300,
  artifact: 300,
  decisionsKept: 50,
  clearedKept: 5,
  proofsKept: 200,
} as const

export const STALE_ASK_MS = 24 * 3600_000

const KINDS: readonly string[] = ['question', 'approval', 'decision', 'block']
const STATUSES: readonly string[] = ['todo', 'doing', 'done', 'blocked']
const TOP_KEYS = ['title', 'goal', 'stopAt', 'plan', 'ask', 'decision', 'proof']

export const emptyBrief = (now: number): Brief => ({ sources: {}, plan: [], ask: [], decisions: [], proofs: [], updatedAt: now })

// --- Validation ---

class BriefError extends Error {}

const bad = (message: string): never => {
  throw new BriefError(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown, where: string, allowed: string[]): Record<string, unknown> => {
  if (!isRecord(value)) return bad(`${where} must be an object`)
  const stray = Object.keys(value).filter(key => !allowed.includes(key))
  if (stray.length > 0) bad(`unknown key ${stray.map(key => `"${key}"`).join(', ')} in ${where}; allowed: ${allowed.join(', ')}`)
  return value
}

/** A string within `max` characters, redacted. The length is checked on the raw text: a cut could leave half a secret. */
const text = (value: unknown, where: string, max: number, required = false): string => {
  if (typeof value !== 'string') return bad(`${where} must be a string`)
  if (value.length > max) bad(`${where} is ${value.length} characters; the limit is ${max}`)
  if (required && value.trim() === '') bad(`${where} must not be empty`)
  return redact(value).text
}

const list = (value: unknown, where: string, max: number): unknown[] => {
  if (!Array.isArray(value)) return bad(`${where} must be a list`)
  if (value.length > max) bad(`${where} has ${value.length} items; the limit is ${max}`)
  return value
}

const planStep = (value: unknown, i: number): PlanStep => {
  const one = record(value, `plan[${i}]`, ['id', 'text', 'status'])
  const status = one.status
  if (typeof status !== 'string' || !STATUSES.includes(status)) bad(`plan[${i}].status must be one of ${STATUSES.join(', ')}`)
  return { id: text(one.id, `plan[${i}].id`, LIMITS.id, true), text: text(one.text, `plan[${i}].text`, LIMITS.planText, true), status: status as PlanStatus }
}

const askItem = (value: unknown, i: number): NonNullable<BriefInput['ask']>[number] => {
  const one = record(value, `ask[${i}]`, ['kind', 'text', 'recommend'])
  const kind = one.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind)) bad(`ask[${i}].kind must be one of ${KINDS.join(', ')}`)
  return {
    kind: kind as AskKind,
    text: text(one.text, `ask[${i}].text`, LIMITS.askText, true),
    ...(one.recommend === undefined ? {} : { recommend: text(one.recommend, `ask[${i}].recommend`, LIMITS.recommend) }),
  }
}

const parseInput = (raw: unknown): BriefInput => {
  const one = record(raw, 'brief_set input', TOP_KEYS)
  if (TOP_KEYS.every(key => one[key] === undefined)) bad(`brief_set needs at least one of: ${TOP_KEYS.join(', ')}`)
  const out: BriefInput = {}
  if (one.title !== undefined) out.title = text(one.title, 'title', LIMITS.title)
  if (one.goal !== undefined) out.goal = text(one.goal, 'goal', LIMITS.goal)
  if (one.stopAt !== undefined) out.stopAt = text(one.stopAt, 'stopAt', LIMITS.stopAt)
  if (one.plan !== undefined) {
    out.plan = list(one.plan, 'plan', LIMITS.planSteps).map(planStep)
    const ids = out.plan.map(step => step.id)
    const twice = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twice !== undefined) bad(`plan has the id "${twice}" twice`)
  }
  if (one.ask !== undefined) out.ask = list(one.ask, 'ask', LIMITS.askItems).map(askItem)
  if (one.decision !== undefined) {
    const d = record(one.decision, 'decision', ['text', 'by'])
    out.decision = { text: text(d.text, 'decision.text', LIMITS.decisionText, true), by: text(d.by, 'decision.by', LIMITS.by, true) }
  }
  if (one.proof !== undefined) {
    const p = record(one.proof, 'proof', ['taskId', 'artifact'])
    out.proof = { taskId: text(p.taskId, 'proof.taskId', LIMITS.id, true), artifact: text(p.artifact, 'proof.artifact', LIMITS.artifact, true) }
  }
  return out
}

/** Checks the limits and keys of PRD 5.5, redacts every string, and says what is wrong in one sentence. */
export const validateBrief = (input: unknown): { input: BriefInput } | { error: string } => {
  try {
    return { input: parseInput(input) }
  } catch (err) {
    return { error: err instanceof BriefError ? err.message : 'the input could not be read' }
  }
}

// --- Proof ---

/** `kind` is left out by a caller that holds a bare task: the kind is then not compared. */
type Item = { id: string; subject: string; kind?: OsProof['kind'] }

/**
 * True when a proof was given for this task or step as it reads now: the same id AND the same subject (and kind, when
 * the caller names one). The id alone would follow a TodoWrite reorder; the subject alone would prove every task
 * that shares its words. Proofs hold redacted text, so the item is compared in its redacted form.
 * `proofOf` returns the proof (its artifact), `isProven` only whether there is one.
 */
export const proofOf = (brief: Brief | null, item: Item): OsProof | null => {
  if (brief === null) return null
  const id = redact(item.id).text
  const subject = redact(item.subject).text
  return brief.proofs.find(one => one.id === id && one.subject === subject && (item.kind === undefined || one.kind === item.kind)) ?? null
}

export const isProven = (brief: Brief | null, item: Item): boolean => proofOf(brief, item) !== null

type Weighed = Required<Item> & { done: boolean }

/** Every task and every plan step: what a proof may name. Id and subject are redacted here, so everything built on an item is safe to store. */
const itemsOf = (tasks: OsTask[], plan: PlanStep[]): Weighed[] => [
  ...tasks.map(one => ({ id: redact(one.id).text, subject: redact(one.subject).text, kind: 'task' as const, done: one.status === 'completed' })),
  ...plan.map(one => ({ id: redact(one.id).text, subject: redact(one.text).text, kind: 'plan' as const, done: one.status === 'done' })),
]

/** PRD 5.1: what the chip and the summary weigh: the task list when it holds a task, else the plan steps. */
const weighedOf = (tasks: OsTask[], plan: PlanStep[]): Weighed[] => (tasks.length > 0 ? itemsOf(tasks, []) : itemsOf([], plan))

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`)

/** The task or step a proof names: by task id, plan id, then the exact subject. */
const resolveProof = (taskId: string, tasks: OsTask[], plan: PlanStep[]): Required<Item> | null => {
  const items = itemsOf(tasks, plan)
  return items.find(one => one.id === taskId) ?? items.find(one => one.subject === taskId) ?? null
}

const validIds = (tasks: OsTask[], plan: PlanStep[]): string[] => [...new Set(itemsOf(tasks, plan).map(one => one.id))]

// --- Apply ---

const setField = (brief: Brief, key: 'title' | 'goal' | 'stopAt', value: string): void => {
  if (value === '') {
    delete brief[key]
    delete brief.sources[key]
  } else {
    brief[key] = value
    brief.sources[key] = 'brief_set'
  }
}

const withProof = (brief: Brief, proof: NonNullable<BriefInput['proof']>, tasks: OsTask[], now: number): Brief | string => {
  const found = resolveProof(proof.taskId, tasks, brief.plan)
  if (!found) {
    const ids = validIds(tasks, brief.plan)
    const list = ids.length > 0 ? `Valid ids: ${ids.join(', ')}. An exact task subject also works.` : 'There is no task and no plan step yet: send "plan" first.'
    const resend = ids.length > 0 ? 'Resend the whole call without "proof", or with one of those ids.' : 'Resend the whole call without "proof".'
    // All or nothing: the goal, plan, ask and decision of this call are dropped with the proof. Say so.
    return `Nothing was saved: this call set no title, goal, stop-at, plan, ask or decision. proof.taskId "${clip(proof.taskId, 40)}" matches no task and no plan step. ${list} ${resend}`
  }
  const kept = brief.proofs.filter(one => !(one.id === found.id && one.kind === found.kind))
  return { ...brief, proofs: [...kept, { id: found.id, artifact: proof.artifact, at: now, subject: found.subject, kind: found.kind }].slice(-LIMITS.proofsKept) }
}

/**
 * Folds one brief_set call into the brief. Plan and ask replace their lists (`ask: []` clears). A decision appends.
 * A proof joins on a task id, a plan step id or an exact subject; with no match nothing changes and the error lists the valid ids.
 * `prev` is never mutated. `now` is the engine clock: this file reads no clock.
 */
export const applyBrief = (prev: Brief | null, raw: unknown, tasks: OsTask[], now: number): { brief: Brief } | { error: string } => {
  const checked = validateBrief(raw)
  if ('error' in checked) return checked
  const input = checked.input
  const base = prev ?? emptyBrief(now)
  let next: Brief = { ...base, sources: { ...base.sources }, updatedAt: now }
  if (input.title !== undefined) setField(next, 'title', input.title)
  if (input.goal !== undefined) setField(next, 'goal', input.goal)
  if (input.stopAt !== undefined) setField(next, 'stopAt', input.stopAt)
  if (input.plan !== undefined) next.plan = input.plan
  if (input.ask !== undefined) {
    const fresh = input.ask.map(one => ({ ...one, source: 'brief_set' as const }))
    // A re-sent ask (same kind and text) is open again, not a leaver: brief_set is an explicit re-ask.
    const cleared = clearLeavers(base.cleared, base.ask, fresh, now)
    if (cleared !== undefined) next.cleared = cleared
    next.ask = fresh
    next.sources.ask = 'brief_set'
  }
  if (input.decision !== undefined) next.decisions = [...next.decisions, { ...input.decision, at: now }].slice(-LIMITS.decisionsKept)
  if (input.proof !== undefined) {
    const proved = withProof(next, input.proof, tasks, now)
    if (typeof proved === 'string') return { error: proved }
    next = proved
  }
  return { brief: next }
}

// --- Ask lifecycle and chip ---

const isOpen = (one: AskItem): boolean => one.answered !== true

/**
 * Dave's prompt arrived at `now`: every open ask becomes `answered?` (dim, not counted) until the next brief_set, and keeps the time.
 * An ask that is already answered keeps its first time. The prompt may not address the ask.
 */
export const markAsksAnswered = (brief: Brief, now: number): Brief =>
  brief.ask.some(isOpen)
    ? { ...brief, ask: brief.ask.map(one => (isOpen(one) ? { ...one, answered: true as const, answeredAt: now } : one)) }
    : brief

const askKey = (one: { kind: string; text: string }): string => `${one.kind}\u0000${one.text}`

/**
 * Asks in `old` whose kind and text are not in `kept` go to `cleared`, newest last, one entry per kind and text, last 5 kept.
 * An entry whose kind and text is in `kept` (open again) leaves `cleared`: no ask is in both lists.
 * `text` is already redacted (it came from validateBrief or the parser). An absent list with no leaver stays absent.
 */
const clearLeavers = (cleared: readonly ClearedAsk[] | undefined, old: readonly AskItem[], kept: readonly AskItem[], now: number): ClearedAsk[] | undefined => {
  const stay = new Set(kept.map(askKey))
  const byKey = new Map<string, ClearedAsk>()
  for (const one of old) {
    if (stay.has(askKey(one))) continue
    byKey.delete(askKey(one)) // two old asks with one key: the later one wins and goes last
    byKey.set(askKey(one), {
      kind: one.kind,
      text: one.text,
      ...(one.answeredAt === undefined ? {} : { answeredAt: one.answeredAt }),
      clearedAt: now,
      how: one.answered === true ? 'prompted' : 'replaced',
    })
  }
  const leavers = [...byKey.values()]
  const gone = new Set(leavers.map(askKey))
  const before = cleared ?? []
  const rest = before.filter(one => !gone.has(askKey(one)) && !stay.has(askKey(one)))
  if (leavers.length === 0 && rest.length === before.length) return cleared === undefined ? undefined : [...cleared]
  return [...rest, ...leavers].slice(-LIMITS.clearedKept)
}

/**
 * An open ask with 24 hours of quiet behind it (PRD 5.2: 24 hours from the last session activity). The clock starts at
 * the later of the last brief change and `lastActivity` (the mod's own record of the last prompt, turn or tool call).
 * With no `lastActivity` it starts at the brief change.
 */
export const isAskStale = (brief: Brief, now: number, lastActivity?: number | null): boolean =>
  brief.ask.some(isOpen) && now - Math.max(brief.updatedAt, lastActivity ?? 0) >= STALE_ASK_MS

/**
 * Prompt origins that are Dave's own act: typing in the composer, a message through the phone bridge, and `auto-continuation` (the engine
 * defines it as a follow-up to Dave's own UI action). Only these answer an open ask, and a prompt with no origin at all (an old engine)
 * answers too. Every other kind answers nothing: a hidden question is worse than a false one. A new Dave kind leaves an ask open until
 * the next turn end parses the Next steps again; a new machine kind cannot hide a question.
 * Probe on a live session (2026-11-16, .claudedocs/e2e-coord-status-band-fixes/02-origin-probe-output.jsonl): Dave's typing is
 * `composer`; a cron tick is `scheduled-trigger`; a Monitor line is `task-notification`; a SendMessage from another session is `peer`.
 * A not-Dave prompt still counts as activity (the turn it starts renews the 24 hour clock), so a timer can keep an ask fresh. Known limit.
 * Known trade-off: a seat's relay of Dave's decision by SendMessage arrives as `peer` and answers no ask.
 */
export const DAVE_ORIGINS: readonly string[] = ['composer', 'bridge', 'auto-continuation']

export const answersAsks = (origin: { kind?: unknown } | null | undefined): boolean =>
  typeof origin?.kind !== 'string' || DAVE_ORIGINS.includes(origin.kind)

/** The mod's own submissions arrive as prompts too: they are not Dave's answer to a brief ask.
 *  Both come from hooks/pr-loop/index.ts: the PR watcher report line, and the /land fallback
 *  text (`Dave pressed "Land" on ...`). Keep this list in step with its `$.prompt.submit` calls. */
export const isModSubmission = (value: string): boolean => /^\s*(PR watcher:|Dave pressed "Land" on )/.test(value)

export type ChipState = {
  brief: Brief | null
  tasks: OsTask[]
  toolRunning: boolean
  turnActive: boolean
  /** A tool call was answered with `deny`. A red gate, a peer holding the lane and an `isError` result are not wired (see the file header). */
  blocked: boolean
  now: number
  /** When the session last did anything (a prompt, a turn start or end, a main-loop tool call). Keeps an ask fresh. */
  activeAt?: number | null
  /** The agents the pane lists (subagents and workflow agents). One with status running keeps the chip working with no turn and no tool. */
  agentRuns?: { status: string }[]
  /** An AskUserQuestion step is in flight: a dialog waits for Dave, so the chip reads waiting whatever else runs. */
  dialogOpen?: boolean
}

/**
 * PRD 5.2, glossary "Session chip" (2026-11-16). Blocked (a refused tool call or a blocked plan step) first, then waiting-on-dave (an AskUserQuestion open, or a fresh open ask:
 * it wins over running work), then working (a tool, the main turn or a running agent run), then done (every task and plan step done AND proven, and at least one exists), else idle.
 */
export const deriveChip = (state: ChipState): Chip => {
  const { brief } = state
  const plan = brief?.plan ?? []
  // A blocked plan step counts only when the plan is the source (no task).
  if (state.blocked || (state.tasks.length === 0 && plan.some(one => one.status === 'blocked'))) return 'blocked'
  if (state.dialogOpen === true || (brief !== null && brief.ask.some(isOpen) && !isAskStale(brief, state.now, state.activeAt))) return 'waiting-on-dave'
  if (state.toolRunning || state.turnActive || state.agentRuns?.some(one => one.status === 'running')) return 'working'
  const items = weighedOf(state.tasks, plan)
  return items.length > 0 && items.every(one => one.done && isProven(brief, one)) ? 'done' : 'idle'
}

/** One line for the model after a good call: what the brief holds now. */
export const briefSummary = (brief: Brief, tasks: OsTask[]): string => {
  const items = weighedOf(tasks, brief.plan)
  const open = brief.ask.filter(isOpen).length
  const parts = [
    brief.goal ? `goal: ${brief.goal}` : 'goal not set',
    brief.stopAt ? `stop-at: ${brief.stopAt}` : null,
    `plan ${brief.plan.length} step${brief.plan.length === 1 ? '' : 's'}`,
    `${open} open ask${open === 1 ? '' : 's'}`,
    `${items.filter(one => isProven(brief, one)).length} of ${items.length} proven`,
  ]
  return `Brief saved. ${parts.filter(Boolean).join(' · ')}`
}

// --- Turn-end parser (the fallback when brief_set is not called) ---

/** `rank: 'sentence'` marks a hit from unlabelled prose ("I will ... stop at ..."). No rank means a label hit ("Restating the ask:", "Goal:", "Stop at:"). */
export type Parsed = { text: string; source: 'parsed'; rank?: 'sentence' }
export type ParsedTurnEnd = { goal?: Parsed; stopAt?: Parsed; ask?: AskItem[] }

/** The parser reads only the end of an answer, and no line longer than this: the regexes below are quadratic on long runs. */
const TAIL_CHARS = 16_384
const LINE_CHARS = 2_000

/** Lines come from `proseLines` already bounded and redacted. Redact again (it is idempotent), then trim, then clip: never cut before redact. */
const parsedText = (value: string, max: number): string => clip(redact(value).text.trim().replace(/[.\s]+$/, ''), max)

const lineOf = (raw: string): string => raw.replace(/\*\*|__/g, '').replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim()

/** The label of a restate line: "Restate:", "Restating the ask:", "Restated ask:", "Restating both asks -". CLAUDE.md's own "Restate the ask before ..." has no separator after the label, so it does not match. */
const RESTATE_LABEL = /^restat(?:e|es|ed|ing)(?:\s+(?:the|both|your|my))?(?:\s+asks?)?\s*[:\-–—]\s*(.+)$/i
/** An unlabelled "I will ..." sentence is a restate only when it also holds a stop clause. */
const WILL_SENTENCE = /^(?:I\s+will|I'll|I\s+am\s+going\s+to)\s/i
/** "stop at X", "I'll stop before X", "stop there". Group 1 is the word after stop. The match starts at the space before it. */
const STOP_CLAUSE = /(?:^|[\s(])(?:(?:I(?:'ll|\s+will)?|will)\s+)?stop(?:ping)?\s+(at|before|after|there|here)\b/i
/** A sentence of its own: "I stop at an open PR". */
const STOP_SENTENCE = /^I(?:'ll|\s+will)?\s+stop(?:ping)?\s+(?:at|before|after|there|here)\b/i
const LEAD_WILL = /^(?:I\s+will|I'll|I\s+am\s+going\s+to|will)\s+/i
const SENTENCE = { rank: 'sentence' } as const
const GOAL_LABEL = /^(?:goal|objective)\s*[:\-–—]\s*(.+)$/i
const STOP_LABEL = /^(?:stop[\s-]?(?:at|point)|stopping\s+at|stop\s+condition)\s*[:\-–—]\s*(.+)$/i

/**
 * Lines outside fenced code blocks, from the last 16 KB of the answer. The tail is redacted whole, before any line is
 * cut or skipped. A line over 2,000 characters is skipped (never clipped) before a regex sees it. When the tail starts
 * inside a line, that first line is dropped: it could begin in the middle of a secret.
 */
const proseLines = (source: string): string[] => {
  const cut = source.length > TAIL_CHARS
  const all = redact(cut ? source.slice(-TAIL_CHARS) : source).text.split(/\r?\n/)
  let fenced = false
  const out: string[] = []
  for (const line of cut ? all.slice(1) : all) {
    if (line.length > LINE_CHARS) continue
    if (/^\s*```/.test(line)) fenced = !fenced
    else if (!fenced) out.push(line)
  }
  return out
}

/** What follows "stop at" up to the end of its sentence. "stop there" keeps the word: "there; no Phase 3 code". */
const stopText = (body: string, clause: RegExpExecArray): string => {
  const word = (clause[1] ?? '').toLowerCase()
  const rest = body.slice(clause.index + clause[0].length)
  return ((word === 'there' || word === 'here' ? word : '') + rest).split(/\.(?=\s|$)/)[0] ?? ''
}

/** A restate body split at its stop clause: the goal is what comes before it (its lead-in "and" cut), the stop-at what follows it. */
const splitRestate = (body: string): { goal: string; stop: string | null } => {
  const clause = STOP_CLAUSE.exec(body)
  const goal = (clause ? body.slice(0, clause.index) : body).replace(/(?:[,;.\s]|\band\b)+$/i, '')
  return { goal: goal.replace(LEAD_WILL, ''), stop: clause ? stopText(body, clause) : null }
}

const restate = (lines: string[]): Pick<ParsedTurnEnd, 'goal' | 'stopAt'> => {
  const found: Pick<ParsedTurnEnd, 'goal' | 'stopAt'> = {}
  for (const raw of lines) {
    const line = lineOf(raw)
    const labelled = RESTATE_LABEL.exec(line)?.[1]
    const body = labelled ?? (WILL_SENTENCE.test(line) ? line : undefined)
    if (body !== undefined && !found.goal) {
      const { goal, stop } = splitRestate(body)
      if (labelled !== undefined || stop !== null) {
        const rank = labelled === undefined ? SENTENCE : {}
        found.goal = { text: parsedText(goal, LIMITS.goal), source: 'parsed', ...rank }
        if (stop !== null) found.stopAt ??= { text: parsedText(stop, LIMITS.stopAt), source: 'parsed', ...rank }
        continue
      }
    }
    if (STOP_SENTENCE.test(line) && !found.stopAt) {
      const clause = STOP_CLAUSE.exec(line)
      if (clause) found.stopAt = { text: parsedText(stopText(line, clause), LIMITS.stopAt), source: 'parsed', ...SENTENCE }
      continue
    }
    const goal = GOAL_LABEL.exec(line)
    if (goal && !found.goal) found.goal = { text: parsedText(goal[1] ?? '', LIMITS.goal), source: 'parsed' }
    const stop = STOP_LABEL.exec(line)
    if (stop && !found.stopAt) found.stopAt = { text: parsedText(stop[1] ?? '', LIMITS.stopAt), source: 'parsed' }
  }
  if (found.goal?.text === '') delete found.goal
  if (found.stopAt?.text === '') delete found.stopAt
  return found
}

const kindOf = (value: string): AskKind => {
  if (/\bblock(?:ed|er)?\b/i.test(value)) return 'block'
  if (/\b(?:approve|approval|confirm|permission)\b/i.test(value)) return 'approval'
  if (/\b(?:decide|choose|pick|select)\b/i.test(value)) return 'decision'
  // An action line ("Paste the response", "Run the validator") is something Dave does or answers, not a choice he makes.
  return 'question'
}

const RECOMMEND = /\s*\(?\brecommend(?:ed|ation)?\s*[:\-]\s*(.+?)\)?\.?$/i

const askOf = (item: string): AskItem => {
  const hit = RECOMMEND.exec(item)
  const body = hit ? item.slice(0, hit.index) : item
  const recommend = hit?.[1] ? parsedText(hit[1], LIMITS.recommend) : ''
  return { kind: kindOf(item), text: parsedText(body, LIMITS.askText), ...(recommend ? { recommend } : {}), source: 'parsed' }
}

const NEXT_STEPS = /^\s*(?:#{1,6}\s*|\*\*)next steps\s*:?\s*(?:\*\*)?\s*$/i
const ITEM = /^\s*(?:\d+[.)]|[-*])\s+(\S.*)$/
/**
 * A Next steps item that asks nothing of Dave. The set is closed: the WHOLE item (one final period allowed) must match, or it is an ask.
 * (a) A lead: "None", "None for now/today/yet/right now", "Nothing (for you/Dave) to do", "Nothing required/yet/for now", "No action/input/reply needed/required".
 *     After the lead come at most a sentence end, " - ", " — ", ":" or ", " and ONE waiting clause: "None for now. I'm waiting on X", "None, waiting on CI". The ", " form never takes you, yours or Dave.
 *     Also "None for the seat". A second sentence after the wait ("None - waiting on CI. I rule on it after") stays an ASK: a false ask is better than a hidden one,
 *     and two review rounds found a new hidden-question hole in each try at a tail grammar. Known limit; the cure is `brief_set` with `ask: []`, not a bigger parser.
 * (b) A bare waiting clause, "(I'm) Waiting on/for X", with NO None lead: nothing states that Dave is free, so it is a no-ask ONLY when X starts with a known
 *     non-human subject (CI, check, build, workflow, run, job, test, pipeline, CodeRabbit, Greptile, semgrep, pre-pr, sync, seat, peer, critic, agent, helper, scout,
 *     session, review bot), with the, a, an or my before it and at most ONE more word after it, from a closed list of output nouns (run, runs, review, reviews, result, results, report, scan, check, checks, status, findings, output, build, job, end, word, go, ruling, reply). "Waiting on a green light", "Waiting on the memory wait" and
 *     "Waiting on the seat's land word" are questions (the last two are false ones: a false question beats a hidden one).
 * The lead form (a) is the author's own statement that Dave has nothing to do: free text cannot carry intent, so its object has NO list of request words. "None - waiting
 * on a green light" is a no-ask by design (a Known limit); the cure for a hidden question is `brief_set` with `ask: []`, never a longer word list.
 * Both forms: white space runs count as one space; the object is 1 to 80 ASCII letters, digits, spaces, an apostrophe, a hash and a hyphen BETWEEN letters or digits, nothing else
 * (no ( ) / | > . ? ; , ! : and no dash or arrow, and no non-ASCII letter); it holds no " then ", " and ", " or ", " but ", and never a word that starts with you or Dave.
 * A wrapped item is joined only while it stays inside the line cap; a longer one is left as separate lines (a line with a ? is still an ask).
 * Anything else stays an ask: "Waiting on CI, then approve PR 12", "None for now. Paste the build log", "None, but review the diff", "None of the options fit".
 * Every part is bounded or anchored, with no nested quantifier: linear on a long line.
 */
const WAIT_BAN = String.raw`\b(?:you|dave)|\b(?:then|and|or|but)\b`
const WAIT_OBJECT = String.raw`(?:(?!${WAIT_BAN})(?:[A-Za-z0-9#'’]|\s|(?<=[A-Za-z0-9])-(?=[A-Za-z0-9]))){1,80}`
const WAIT_CLAUSE = String.raw`(?:i(?:['’]m|\s+am)\s+)?waiting\s+(?:on|for)\s+`
const NO_ASK_LEAD = String.raw`(?:none(?:\s+(?:for\s+(?:now|the\s+seat)|today|yet|right\s+now))?|nothing\s+(?:(?:for\s+(?:you|dave)\s+)?to\s+do|required|yet|for\s+now)|no\s+(?:action|input|reply)\s+(?:needed|required))`
const WAIT_SUBJECT = String.raw`(?:(?:the|a|an|my)\s+)?(?:ci|checks?|build|workflow|runs?|jobs?|tests?|pipeline|coderabbit|greptile|semgrep|pre-pr|sync|seat|peer|critic|agent|helper|scout|session|review\s+bot)(?:['’]s)?(?![A-Za-z0-9-])`
const WAIT_TAIL_WORD = String.raw`(?:\s+(?:run|runs|review|reviews|result|results|report|scan|check|checks|status|findings|output|build|job|end|word|go|ruling|reply)(?![A-Za-z0-9-]))?`
const LEAD_ITEM = new RegExp(`^${NO_ASK_LEAD}(?:$|(?:\\.\\s+|\\s+-\\s+|\\s*[–—]\\s*|:\\s*|,\\s+)${WAIT_CLAUSE}${WAIT_OBJECT}$)`, 'i')
const BARE_WAIT = new RegExp(`^${WAIT_CLAUSE}${WAIT_SUBJECT}${WAIT_TAIL_WORD}$`, 'i')
/** A question mark makes any item an ask, whatever its words. */
const noAsk = (text: string): boolean => {
  const whole = text.replace(/\s+/g, ' ').replace(/\.$/, '')
  return !whole.includes('?') && (LEAD_ITEM.test(whole) || BARE_WAIT.test(whole))
}

/** The ask items of the `## Next steps` block. undefined: no block, or one with nothing readable. Only no-ask items (None, Nothing to do, Waiting on X): []. A bare line is an ask only with a "?". */
const nextSteps = (lines: string[]): AskItem[] | undefined => {
  const start = lines.findIndex(line => NEXT_STEPS.test(line))
  if (start < 0) return undefined
  const items: AskItem[] = []
  let none = false
  // A wrapped item: an indented line right after an item belongs to that item ("1. None - waiting on CI." then "   Then paste the log." is ONE item, an ask).
  const logical: string[] = []
  for (const raw of lines.slice(start + 1)) {
    const before = logical[logical.length - 1]
    if (/^\s+\S/.test(raw) && !ITEM.test(raw) && !/^\s*#{1,6}\s/.test(raw) && before !== undefined && ITEM.test(before) && before.length + raw.trim().length < LINE_CHARS) logical[logical.length - 1] = `${before} ${raw.trim()}`
    else logical.push(raw)
  }
  for (const raw of logical) {
    if (/^\s*#{1,6}\s/.test(raw)) break
    const item = ITEM.exec(raw)
    const text = item ? lineOf(item[1] ?? '') : ''
    if (item && noAsk(text)) none = true
    else if (item) items.push(askOf(text))
    else if (noAsk(lineOf(raw))) none = true
    else if (raw.includes('?')) items.push(askOf(lineOf(raw)))
  }
  const kept = items.filter(one => one.text !== '').slice(0, LIMITS.askItems)
  return kept.length > 0 ? kept : none ? [] : undefined
}

/** Reads the model's own output: the restate line (goal, stop-at) and the Next steps block (ask). Every value is `parsed`. */
export const parseTurnEnd = (answer: string): ParsedTurnEnd => {
  if (typeof answer !== 'string' || answer === '') return {}
  try {
    const lines = proseLines(answer)
    const ask = nextSteps(lines)
    return { ...restate(lines), ...(ask === undefined ? {} : { ask }) }
  } catch {
    return {}
  }
}

/**
 * What one model request of the main loop gives (hooks/hud calls it per turn.step): goal and stop-at only. The restate
 * line comes early in a turn; the Next steps block belongs to the final text, which turn.complete parses.
 */
export const parseStep = (answer: string): Pick<ParsedTurnEnd, 'goal' | 'stopAt'> => {
  const { goal, stopAt } = parseTurnEnd(answer)
  return { ...(goal ? { goal } : {}), ...(stopAt ? { stopAt } : {}) }
}

/**
 * Folds parsed values in. A value from brief_set stays. A label hit fills an empty slot or replaces an older parsed value.
 * A sentence hit (unlabelled prose) fills an empty slot only: narration in a later step must not replace the restate.
 */
export const mergeParsed = (brief: Brief | null, parsed: ParsedTurnEnd, now: number): Brief => {
  const base = brief ?? emptyBrief(now)
  const next: Brief = { ...base, sources: { ...base.sources } }
  let changed = false
  for (const key of ['goal', 'stopAt'] as const) {
    const value = parsed[key]
    const open = value?.rank === 'sentence' ? base.sources[key] === undefined : base.sources[key] !== 'brief_set'
    if (value && open && base[key] !== value.text) {
      next[key] = value.text
      next.sources[key] = 'parsed'
      changed = true
    }
  }
  if (parsed.ask && base.sources.ask !== 'brief_set') {
    // An ask with the same kind and text as an answered one keeps answered and answeredAt: a repeated block does not re-open it.
    const before = new Map(base.ask.map(one => [askKey(one), one]))
    const carried = parsed.ask.map(one => {
      const was = before.get(askKey(one))
      return was?.answered === true ? { ...one, answered: true as const, ...(was.answeredAt === undefined ? {} : { answeredAt: was.answeredAt }) } : one
    })
    if (JSON.stringify(carried) !== JSON.stringify(base.ask)) {
      const cleared = clearLeavers(base.cleared, base.ask, carried, now)
      if (cleared !== undefined) next.cleared = cleared
      next.ask = carried
      next.sources.ask = 'parsed'
      changed = true
    }
  }
  return changed ? { ...next, updatedAt: now } : base
}

// --- Taps in a model AskUserQuestion dialog (GPAA P3, design 2026-11-09) ---

/** The `by` of a decision that came from a tap, not from brief_set. */
export const TAP_BY = 'Dave (tap)'
/** What a decision holds for an answer that is not one of the labels: Dave's typed words are never stored. */
export const FREE_TEXT = 'free-text answer'

const TAP_HEADER_MAX = 256
/** The same bound as the turn-end parser tail: a longer text is not read, it is named. */
const TAP_RAW_MAX = TAIL_CHARS

type TapQuestion = { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown; kind?: unknown }

const labelsOf = (options: unknown): string[] =>
  Array.isArray(options) ? options.flatMap(one => (isRecord(one) && typeof one.label === 'string' ? [one.label] : [])) : []

/** What one answer stores: the label (or the joined labels of a multi-select), else `free-text answer`. A number answer is free text until Dave decides design Q3. */
const pickOf = (q: TapQuestion, answer: string): string => {
  const labels = labelsOf(q.options)
  if (labels.includes(answer)) return answer
  if (q.multiSelect === true && answer.split(', ').every(part => labels.includes(part))) return answer
  return FREE_TEXT
}

/**
 * A question the mod told the model to ask (GPAA P3, design F14). The decision ledger already records its answer, so it is no
 * `Dave (tap)` row. Two scripts write these offers, and the model passes the spec on word for word:
 *   - scripts/github/ship-ask.mjs: header Push, Commit, Open PR, Land or Paid round (the pr-loop paid round, ship steps, Land).
 *   - scripts/github/lib/checkpoint-ledger.mjs (pr_checkpoint ledger mode): header `PR #<n>`.
 * Both markers must hold: the header, and a first option that ends ` (Recommended)` (every spec of both scripts puts the
 * recommended option first). A model question with only one marker is Dave's tap and is stored. The match is on the result's
 * echo of the question, so the model-written call input is never read. A new offer header must be added here.
 */
const MOD_ASK_HEADERS = new Set(['Push', 'Commit', 'Open PR', 'Land', 'Paid round'])
const MOD_ASK_PR_HEADER = /^PR #\d+$/
const MOD_ASK_FIRST_LABEL = / \(Recommended\)$/

const isModAsk = (q: TapQuestion): boolean => {
  const header = typeof q.header === 'string' ? q.header : ''
  const first = labelsOf(q.options)[0] ?? ''
  return (MOD_ASK_HEADERS.has(header) || MOD_ASK_PR_HEADER.test(header)) && MOD_ASK_FIRST_LABEL.test(first)
}

/**
 * One decision text per answered question of a model AskUserQuestion result: "<header>: <pick>". [] when nothing is a Dave tap
 * (a shape the tool does not return, an idle auto-resolve, a follow-up). The header is the model's own word, never cut before
 * redact; the question text and `result.response` are never read. Order: bound, redact, clip.
 */
export const tapDecisions = (result: unknown): string[] => {
  if (!isRecord(result) || result.afkTimeoutMs !== undefined || result.followUp === true) return []
  const { questions, answers } = result
  if (!Array.isArray(questions) || !isRecord(answers)) return []
  const out: string[] = []
  questions.slice(0, 4).forEach((q: unknown, i) => {
    if (!isRecord(q) || isModAsk(q)) return
    const answer = typeof q.question === 'string' ? answers[q.question] : undefined
    if (typeof answer !== 'string' || answer === '') return
    const head = typeof q.header === 'string' && q.header !== '' && q.header.length <= TAP_HEADER_MAX ? q.header : `Question ${i + 1}`
    const raw = `${head}: ${pickOf(q, answer)}`
    out.push(clip(redact(raw.length > TAP_RAW_MAX ? `${head}: long answer` : raw).text, LIMITS.decisionText))
  })
  return out
}

/** Appends tap decisions, keeps the last 50, moves `updatedAt`. `prev` null makes an empty brief. Two saves in one millisecond must differ. */
export const withTaps = (prev: Brief | null, texts: readonly string[], now: number): Brief => {
  const base = prev ?? emptyBrief(now)
  const at = prev === null ? now : Math.max(now, prev.updatedAt + 1)
  return { ...base, decisions: [...base.decisions, ...texts.map(text => ({ text, by: TAP_BY, at }))].slice(-LIMITS.decisionsKept), updatedAt: at }
}
