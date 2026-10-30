import { redact } from '../shared/redact'
import type { OsAskItem, OsBrief, OsBriefSource, OsPlanStep, OsProof, OsTask } from '../../types'

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
    next.ask = input.ask.map(one => ({ ...one, source: 'brief_set' as const }))
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

/** Dave's prompt arrived: every open ask becomes `answered?` (dim, not counted) until the next brief_set. */
export const markAsksAnswered = (brief: Brief): Brief =>
  brief.ask.some(isOpen) ? { ...brief, ask: brief.ask.map(one => (isOpen(one) ? { ...one, answered: true as const } : one)) } : brief

/**
 * An open ask with 24 hours of quiet behind it (PRD 5.2: 24 hours from the last session activity). The clock starts at
 * the later of the last brief change and `lastActivity` (the mod's own record of the last prompt, turn or tool call).
 * With no `lastActivity` it starts at the brief change.
 */
export const isAskStale = (brief: Brief, now: number, lastActivity?: number | null): boolean =>
  brief.ask.some(isOpen) && now - Math.max(brief.updatedAt, lastActivity ?? 0) >= STALE_ASK_MS

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
}

/**
 * PRD 5.2. Blocked (a refused tool call or a blocked plan step) first, then waiting-on-dave (an open ask and no tool running), then working (a tool, the main turn or a running agent run),
 * then done (every task and plan step done AND proven, and at least one exists), else idle.
 */
export const deriveChip = (state: ChipState): Chip => {
  const { brief } = state
  const plan = brief?.plan ?? []
  // A blocked plan step counts only when the plan is the source (no task).
  if (state.blocked || (state.tasks.length === 0 && plan.some(one => one.status === 'blocked'))) return 'blocked'
  if (brief !== null && !state.toolRunning && brief.ask.some(isOpen) && !isAskStale(brief, state.now, state.activeAt)) return 'waiting-on-dave'
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
 * (a) A lead: "None", "None for now/today/yet/right now", "Nothing (for you/Dave) to do", "Nothing needed/required/yet/for now", "No action/input/reply needed/required".
 *     After the lead come at most a sentence end, " - ", " — " or ":" and ONE waiting clause: "None for now. I'm waiting on X", "None — waiting on your merge yes".
 * (b) A bare waiting clause, "(I'm) Waiting on/for X", where X does not start with you, your or Dave ("Waiting on Dave's approval" asks Dave).
 * X is 1 to 80 characters with no ? ; , ! :, no sentence end (". "), no dash separator and no " then ", " and ", " or ", " but ".
 * Anything else stays an ask: "Waiting on CI, then approve PR 12", "None for now. Paste the build log", "None, but review the diff", "None of the options fit".
 * Every part is bounded or anchored, with no nested quantifier: linear on a long line.
 */
const WAIT_OBJECT = String.raw`(?:(?!\.\s|\s[-–—]+\s|\s(?:then|and|or|but)\s)(?:[^?;,!:\s]|\s)){1,80}`
const WAIT_CLAUSE = String.raw`(?:i(?:['’]m|\s+am)\s+)?waiting\s+(?:on|for)\s+`
const NO_ASK_LEAD = String.raw`(?:none(?:\s+(?:for\s+now|today|yet|right\s+now))?|nothing\s+(?:(?:for\s+(?:you|dave)\s+)?to\s+do|needed|required|yet|for\s+now)|no\s+(?:action|input|reply)\s+(?:needed|required))`
const LEAD_ITEM = new RegExp(`^${NO_ASK_LEAD}(?:$|(?:\\.\\s+|\\s+-\\s+|\\s*[–—]\\s*|:\\s*)${WAIT_CLAUSE}${WAIT_OBJECT}$)`, 'i')
const BARE_WAIT = new RegExp(`^${WAIT_CLAUSE}(?!(?:your?|dave)\\b)${WAIT_OBJECT}$`, 'i')
/** A question mark makes any item an ask, whatever its words. */
const noAsk = (text: string): boolean => {
  const whole = text.replace(/\.$/, '')
  return !whole.includes('?') && (LEAD_ITEM.test(whole) || BARE_WAIT.test(whole))
}

/** The ask items of the `## Next steps` block. undefined: no block, or one with nothing readable. Only no-ask items (None, Nothing to do, Waiting on X): []. A bare line is an ask only with a "?". */
const nextSteps = (lines: string[]): AskItem[] | undefined => {
  const start = lines.findIndex(line => NEXT_STEPS.test(line))
  if (start < 0) return undefined
  const items: AskItem[] = []
  let none = false
  for (const raw of lines.slice(start + 1)) {
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
  if (parsed.ask && base.sources.ask !== 'brief_set' && JSON.stringify(parsed.ask) !== JSON.stringify(base.ask)) {
    next.ask = parsed.ask
    next.sources.ask = 'parsed'
    changed = true
  }
  return changed ? { ...next, updatedAt: now } : base
}
