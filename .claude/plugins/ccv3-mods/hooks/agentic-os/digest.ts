import type { AgentRun, KeeperRecord, OsTask, PrState } from '../../types'
import { proofOf } from './brief'
import type { Brief, AskKind } from './brief'
import type { PaneRow, Span, Tone } from './pane-model'
import { askSentence, driftSentence, helperSentence, keeperSentence, laneSentence, newestKeeper, prSentence, proofSentence, stepSentence } from './plain'
import type { Drift } from './steward'
import { WORDS } from './tab-words'
import { oneLine, wrapRows } from './text'

// The /os session briefing (PR 5), as plain English (round 2). Pure: no engine, no clock (the caller passes `now`), no state. Three blocks of rows, written
// for Dave in plain words (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to stay on top of"):
//   NEEDS YOU   open ask (with the recommendation on its next row), READY change (waits for the merge yes), pending approval, blocked step, failed check, rate limit
//   DONE        commit, merged change, passed proof (with its numbers), decision by Dave, finished helper run; newest first (the id stays `highlights`)
//   WATCH       stale brief (the steward's sentence), done step with no proof, change with open threads, helper running long,
//               lane held by a peer (and whether it may touch my files), anything deferred, the compact-keeper check
// An item is a group of 1 to `lineCap` rows: `  <mark> <text>` with the age in the right group of row 1 (a pane of 24 columns or more), then
// rows indented 4. The mark is `>` (needs), `+` (done) or `!` (watch). A text cut at `lineCap` rows ends with `...more -> <home tab>`; an item
// whose home tab holds more (an ask with a recommendation, a peer lane that may overlap) always ends with it. A derived fact (read from a
// handoff or a log, not stated by the session) starts with `[derived]`. Wording comes from plain.ts. The home tab is named by its label
// (Steps, Work, Checks, Choices; the three plain words are in tab-words.ts). Every string is redacted, made one line
// and bounded before it is cut to the width (text.ts). Observer only: it injects nothing.

export type DigestAsk = { kind: AskKind; text: string; recommend?: string | undefined; source: 'brief_set' | 'parsed'; at?: number | undefined; answered?: true | undefined }
export type DigestPr = {
  pr: number
  state: PrState | null
  whenReady: boolean
  at?: number | undefined
  title?: string | undefined
  merged?: boolean | undefined
  rateLimit?: { minutes: number } | undefined
  failedChecks?: number | undefined
  threads?: number | undefined
}
export type DigestDecision = { text: string; by: string; at?: number | undefined; derived?: boolean | undefined }
export type DigestProof = {
  id: string
  kind: 'task' | 'plan'
  subject: string
  artifact: string
  at?: number | undefined
  result?: { passed: number; failed: number } | undefined
  derived?: boolean | undefined
}
/** `mine` is false for a lane another session holds; only those are watched. `holder` is ignored (the sentence names no holder). `overlap` holds the edited paths its scope may touch. */
export type DigestLane = {
  id: string
  title: string
  state: string
  mine: boolean
  holder?: string | undefined
  note?: string | undefined
  at?: number | undefined
  overlap?: string[] | undefined
}
export type DigestCommit = { sha: string; subject: string; at: number }
/** One manual compaction the keeper watched: did the summary keep the plan? */
export type DigestCompaction = KeeperRecord
export type DigestOptions = {
  now: number
  columns: number
  /** Items per block. Default MAX_ITEMS. */
  limit?: number | undefined
  /** Rows per item: 3 (default) or 1 (a short pane draws one row per item). */
  lineCap?: 1 | 3 | undefined
  commits?: DigestCommit[] | undefined
  compactions?: DigestCompaction[] | undefined
}

export type DigestBlock = {
  id: 'needs' | 'highlights' | 'watch'
  title: string
  total: number
  shown: number
  more: number
  head: PaneRow
  /** One group of rows per shown item, 1 to `lineCap` rows each. An empty block has none. */
  items: PaneRow[][]
  /** The rows of the `shown` items, then one `+N more` row when more > 0; an empty block has one dim row instead. */
  rows: PaneRow[]
}
export type Digest = { needs: DigestBlock; highlights: DigestBlock; watch: DigestBlock }

/** The least a roomy pane asks of a block, and the most a block shows by default (Dave: 3 to 5 items). */
export const MIN_ITEMS = 3
export const MAX_ITEMS = 5

const LONG_RUN_MS = 10 * 60_000
const DEFERRED = /\b(?:follow[- ]?ups?|deferred?)\b/i
const DEFAULT_LINE_CAP = 3

const sp = (text: string, tone: Tone): Span => ({ text, tone })

// --- Text ---

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** now, Nm, Nh, Nd; undefined when the fact has no time. A time ahead of the clock reads now. */
const ageOf = (now: number, at: number | undefined): string | undefined => {
  if (!known(at)) return undefined
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// --- Items ---

/** `next` is a second row (an ask's recommendation); `more` says the home tab holds more than the rows show. */
type Body = { text: string; next?: string; more?: boolean }

/** An item before it is drawn. `make` runs only for the items that are shown, so a long list costs a sort, not a redaction each. `home` names the tab that holds the full text. */
type Item = { rank: number; at: number | undefined; home: string; derived: boolean; tone: Tone; make: () => Body }

const item = (rank: number, at: number | undefined, home: string, tone: Tone, make: () => Body, derived = false): Item => ({ rank, at, home, derived, tone, make })

const newestFirst = (a: Item, b: Item): number => a.rank - b.rank || (known(b.at) ? b.at : -Infinity) - (known(a.at) ? a.at : -Infinity)

const MARKS: Record<DigestBlock['id'], { mark: string; tone: Tone }> = {
  needs: { mark: '>', tone: 'warn' },
  highlights: { mark: '+', tone: 'done' },
  watch: { mark: '!', tone: 'warn' },
}

/**
 * The rows of one item. Row 1 holds the mark, the text and the age; later rows indent 4. An item with a `next` row (an ask with a
 * recommendation) wraps its text to `lineCap - 1` rows and puts the next row last, with the hint of its home tab; at lineCap 1 the next row is
 * left out and the hint rides on the one row.
 */
const itemRows = (key: string, it: Item, id: DigestBlock['id'], now: number, columns: number, lineCap: number): PaneRow[] => {
  const body = it.make()
  const age = ageOf(now, it.at)
  const { mark, tone } = MARKS[id]
  const lead = [sp('  ', 'dim'), sp(`${mark} `, tone)]
  const text = `${it.derived ? '[derived] ' : ''}${body.text === '' ? '(no text)' : body.text}`
  const right = age === undefined ? {} : { right: [sp(age, 'dim')] }
  if (body.next === undefined || lineCap < 2) {
    return wrapRows(key, lead, text, it.tone, columns, lineCap, { ...right, hint: it.home, homeHoldsMore: body.more === true || body.next !== undefined })
  }
  const top = wrapRows(key, lead, text, it.tone, columns, lineCap - 1, right)
  const last = wrapRows(`${key}-${top.length + 1}`, [sp('    ', 'dim')], body.next, 'dim', columns, 1, { hint: it.home, homeHoldsMore: true })
  return [...top, ...last]
}

const block = (id: DigestBlock['id'], title: string, empty: string, items: Item[], now: number, columns: number, limit: number, lineCap: number): DigestBlock => {
  const sorted = [...items].sort(newestFirst)
  const shown = Math.min(sorted.length, limit)
  const more = sorted.length - shown
  const groups = sorted.slice(0, shown).map((one, i) => itemRows(`brief-${id}-${i}`, one, id, now, columns, lineCap))
  const rows: PaneRow[] = groups.flat()
  if (more > 0) rows.push({ key: `brief-${id}-more`, left: [sp(`  +${more} more`, 'dim')] })
  if (sorted.length === 0) rows.push({ key: `brief-${id}-none`, left: [sp(empty.slice(0, columns), 'dim')] })
  const count = sorted.length > 0 && columns >= 24 ? [sp(String(sorted.length), 'dim')] : undefined
  const head: PaneRow = { key: `brief-${id}-head`, left: [sp(title.slice(0, columns), 'head')], ...(count ? { right: count } : {}) }
  return { id, title, total: sorted.length, shown, more, head, items: groups, rows }
}

/**
 * The same block cut to `limit` items (a smaller limit than it was built with). Whole item groups are kept: only the
 * `+N more` row changes, and it counts items. A limit above `shown` changes nothing.
 */
export const fold = (found: DigestBlock, limit: number): DigestBlock => {
  const shown = Math.max(0, Math.min(found.shown, Math.floor(limit)))
  if (shown === found.shown) return found
  const more = found.total - shown
  const items = found.items.slice(0, shown)
  return { ...found, shown, more, items, rows: [...items.flat(), { key: `brief-${found.id}-more`, left: [sp(`  +${more} more`, 'dim')] }] }
}

// --- Steps (the unproven check and the deferred check) ---

type Step = { id: string; text: string; state: 'todo' | 'doing' | 'done' | 'blocked'; kind: 'task' | 'plan' }

/** PRD 5.1: the task list when it holds a task, else the brief plan. */
const stepsOf = (brief: Brief | null, tasks: OsTask[]): Step[] =>
  tasks.length > 0
    ? tasks.map(one => ({ id: one.id, text: one.subject, state: one.status === 'completed' ? 'done' : one.status === 'in_progress' ? 'doing' : 'todo', kind: 'task' as const }))
    : (brief?.plan ?? []).map(one => ({ id: one.id, text: one.text, state: one.status, kind: 'plan' as const }))

const blockedItems = (brief: Brief | null): Item[] =>
  (brief?.plan ?? [])
    .filter(one => one.status === 'blocked')
    .map(one => item(3, undefined, WORDS.plan.label, 'bad', () => ({ text: stepSentence({ state: 'blocked', subject: one.text, proven: false }) })))

const stepItems = (brief: Brief | null, tasks: OsTask[]): Item[] => {
  const out: Item[] = []
  for (const step of stepsOf(brief, tasks)) {
    if (step.state === 'done') {
      // A finished follow-up is closed work, not an unproven claim (D10).
      if (!DEFERRED.test(step.text) && proofOf(brief, { id: step.id, subject: step.text, kind: step.kind }) === null) {
        out.push(item(0, undefined, WORDS.plan.label, 'warn', () => ({ text: stepSentence({ state: 'done', subject: step.text, proven: false }) })))
      }
    } else if (step.state !== 'blocked' && DEFERRED.test(step.text)) {
      out.push(item(0, undefined, WORDS.plan.label, 'todo', () => ({ text: stepSentence({ state: 'todo', subject: step.text, proven: false }) })))
    }
  }
  return out
}

// --- NEEDS YOU ---

const RANK = { ask: 0, ready: 1, approval: 2, blocked: 3, failed: 4, limited: 5 } as const

const askItems = (asks: DigestAsk[]): Item[] =>
  asks
    .filter(one => one.answered !== true)
    .map(one =>
      item(one.kind === 'approval' ? RANK.approval : RANK.ask, one.at, WORDS.decisions.label, 'warn', () => {
        const said = askSentence({ kind: one.kind, text: one.text, recommend: one.recommend }, false)
        return { text: said.text, ...(said.next === undefined ? {} : { next: said.next }), more: oneLine(one.recommend) !== '' }
      }),
    )

const needsPrItems = (prs: DigestPr[]): Item[] => {
  const out: Item[] = []
  for (const one of prs) {
    if (one.merged === true || !known(one.pr)) continue
    if (one.state === 'READY') {
      out.push(item(RANK.ready, one.at, 'Work', 'warn', () => ({ text: prSentence({ pr: one.pr, state: 'READY' })?.text ?? '' })))
      continue
    }
    if (known(one.failedChecks) && one.failedChecks > 0) {
      const n = one.failedChecks
      out.push(item(RANK.failed, one.at, 'Work', 'bad', () => ({ text: oneLine(`Change #${one.pr}: ${plural(n, 'check')} failed`) })))
    }
    if (one.state === 'LIMITED' || known(one.rateLimit?.minutes)) {
      // LIMITED also means a review that did not finish: only a known wait time is a rate limit (prSentence words it).
      out.push(item(RANK.limited, one.at, 'Work', 'warn', () => ({ text: prSentence({ pr: one.pr, state: 'LIMITED', rateLimit: one.rateLimit })?.text ?? '' })))
    }
  }
  return out
}

const failedProofItems = (proofs: DigestProof[]): Item[] =>
  proofs
    .filter(one => known(one.result?.failed) && one.result.failed > 0)
    .map(one => item(RANK.failed, one.at, WORDS.proof.label, 'bad', () => ({ text: oneLine(`Check failed: ${oneLine(one.subject)} (${proofSentence(one)})`) })))

// --- DONE ---

const passedProofItems = (proofs: DigestProof[]): Item[] =>
  proofs
    .filter(one => !(known(one.result?.failed) && one.result.failed > 0))
    .map(one =>
      item(
        0,
        one.at,
        WORDS.proof.label,
        'todo',
        () => ({ text: oneLine(one.result ? `${oneLine(one.subject)}: ${proofSentence(one)}` : proofSentence(one)) }),
        one.derived === true,
      ),
    )

const decisionItems = (decisions: DigestDecision[]): Item[] =>
  decisions
    .filter(one => one.derived === true || (typeof one.by === 'string' && one.by.trim().toLowerCase() === 'dave'))
    .map(one => item(0, one.at, WORDS.decisions.label, 'todo', () => ({ text: one.derived === true ? oneLine(one.text) : oneLine(`${oneLine(one.text)} - by ${oneLine(one.by)}`) }), one.derived === true))

const milestoneItems = (prs: DigestPr[], agents: AgentRun[], commits: DigestCommit[], now: number): Item[] => [
  ...commits.map(one => item(0, one.at, 'Work', 'todo', () => ({ text: oneLine(one.subject) }))),
  ...prs.filter(one => one.merged === true).map(one => item(0, one.at, 'Work', 'todo', () => ({ text: prSentence({ pr: one.pr, state: one.state, merged: true })?.text ?? '' }))),
  ...agents.filter(one => one.status === 'done').map(one => item(0, one.endedAt ?? one.startedAt, 'Session', 'todo', () => ({ text: helperSentence(one, now) }))),
]

// --- WATCH ---

const driftItems = (brief: Brief | null, found: Drift | null): Item[] => {
  const said = driftSentence(found)
  return said === null ? [] : [item(0, brief?.updatedAt, WORDS.plan.label, 'dim', () => ({ text: said }))]
}

const threadItems = (prs: DigestPr[]): Item[] =>
  prs
    .filter(one => one.merged !== true && one.state !== 'CLOSED' && one.state !== 'READY' && known(one.threads) && one.threads > 0)
    .map(one => item(0, one.at, 'Work', 'todo', () => ({ text: oneLine(`Change #${one.pr} has ${plural(one.threads ?? 0, 'unresolved thread')}`) })))

const longRunItems = (agents: AgentRun[], now: number): Item[] =>
  agents.filter(one => one.status === 'running' && now - one.startedAt > LONG_RUN_MS).map(one => item(0, one.startedAt, 'Session', 'todo', () => ({ text: helperSentence(one, now) })))

const peerItems = (lanes: DigestLane[]): Item[] =>
  lanes
    .filter(one => !one.mine && one.state !== 'done' && one.state !== 'backlog')
    .map(one =>
      item(0, one.at, 'Work', 'todo', () => {
        // Always an owned lane here: the caller feeds only lanes another live session holds.
        const said = laneSentence({ id: one.id, title: one.title, state: one.state, mine: false, owner: one.holder ?? 'peer' })
        const may = (one.overlap ?? []).length > 0
        return { text: may ? oneLine(`${said} and may touch the same files.`) : said, more: may }
      }),
    )

const deferredDecisionItems = (decisions: DigestDecision[]): Item[] =>
  decisions.filter(one => DEFERRED.test(one.text)).map(one => item(0, one.at, WORDS.decisions.label, 'todo', () => ({ text: oneLine(one.text) }), one.derived === true))

/** The newest record sets the line; 3 of the newest 5 that lost the plan make it the kill rule (keeperSentence). */
const keeperItems = (compactions: DigestCompaction[]): Item[] => {
  const said = keeperSentence(compactions)
  if (said === null) return []
  const newest = newestKeeper(compactions)
  if (newest === null) return []
  return [item(0, newest.at, 'Session', said.kill ? 'bad' : newest.kept === true ? 'dim' : 'warn', () => ({ text: said.text }))]
}

// --- Entry point ---

/**
 * The briefing. `limit` is the items per block (the caller's pane height decides; default MAX_ITEMS). `lineCap` is the rows per item (3, or 1
 * for a short pane). Facts the session cannot know stay out: pass an empty list and the block has fewer items, never an invented one.
 */
export const digest = (
  brief: Brief | null,
  tasks: OsTask[],
  drift: Drift | null,
  prs: DigestPr[],
  agents: AgentRun[],
  lanes: DigestLane[],
  asks: DigestAsk[],
  decisions: DigestDecision[],
  proofs: DigestProof[],
  options: DigestOptions,
): Digest => {
  const { now } = options
  const columns = Math.max(1, Math.floor(options.columns))
  const limit = known(options.limit) ? Math.max(1, Math.floor(options.limit)) : MAX_ITEMS
  const lineCap = options.lineCap === 1 ? 1 : DEFAULT_LINE_CAP
  const commits = options.commits ?? []
  const needs = [...askItems(asks), ...needsPrItems(prs), ...blockedItems(brief), ...failedProofItems(proofs)]
  const highlights = [...milestoneItems(prs, agents, commits, now), ...passedProofItems(proofs), ...decisionItems(decisions)]
  const watch = [
    ...driftItems(brief, drift),
    ...stepItems(brief, tasks),
    ...threadItems(prs),
    ...longRunItems(agents, now),
    ...peerItems(lanes),
    ...deferredDecisionItems(decisions),
    ...keeperItems(options.compactions ?? []),
  ]
  return {
    needs: block('needs', 'NEEDS YOU', 'nothing needs you', needs, now, columns, limit, lineCap),
    highlights: block('highlights', 'DONE', 'no highlights yet', highlights, now, columns, limit, lineCap),
    watch: block('watch', 'WATCH', 'nothing to watch', watch, now, columns, limit, lineCap),
  }
}
