import type { AgentRun, OsTask, PrState } from '../../types'
import { keeperMarker } from '../compact-keeper/model'
import { redact } from '../shared/redact'
import { proofOf } from './brief'
import type { Brief, AskKind } from './brief'
import { clip } from './model'
import type { PaneRow, Span, Tone } from './pane-model'
import type { Drift } from './steward'

// The /os session briefing (PR 5). Pure: no engine, no clock (the caller passes `now`), no state. Three blocks of rows, written
// for Dave in plain words (Dave, 2026-10-28: "communicate in a clear manner all the high points and what I need to stay on top of"):
//   NEEDS YOU   open ask (with the recommendation), READY PR (waits for the merge yes), pending approval, blocked step, failed check, rate limit
//   HIGHLIGHTS  commit, merged PR, passed proof (with its numbers), decision by Dave, finished agent run; newest first
//   WATCH       stale brief (the steward's reason, word for word), done step with no proof, PR with open threads, agent running long,
//               lane held by a peer, anything deferred, the compact-keeper check
// An item row is `  <text> [<source>] <age>`, all in `left`, so a narrow pane cannot drop the tag. Age is now, Nm, Nh, Nd, or `-`
// when the fact has no time. A derived fact (read from a handoff or a log, not stated by the session) says `derived` in its tag.
// Every string is redacted, made one line and bounded before it is cut to the width. Observer only: it injects nothing.

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
/** `mine` is false for a lane another session holds; only those are watched. */
export type DigestLane = { id: string; title: string; state: string; mine: boolean; holder?: string | undefined; note?: string | undefined; at?: number | undefined }
export type DigestCommit = { sha: string; subject: string; at: number }
/** One compaction: the summary text and the counts the keeper asked the summarizer to copy (null when the keeper had nothing to add). */
export type DigestCompaction = { at: number; sessionId: string; open: number | null; total: number | null; summary: string }
export type DigestOptions = {
  now: number
  columns: number
  /** Items per block. Default MAX_ITEMS. */
  limit?: number | undefined
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
  /** The `shown` item rows, then one `+N more` row when more > 0; an empty block has one dim row instead. */
  rows: PaneRow[]
}
export type Digest = { needs: DigestBlock; highlights: DigestBlock; watch: DigestBlock }

/** The least a roomy pane asks of a block, and the most a block shows by default (Dave: 3 to 5 items). */
export const MIN_ITEMS = 3
export const MAX_ITEMS = 5

const LONG_RUN_MS = 10 * 60_000
const KILL_WINDOW = 5
const KILL_LOST = 3
const TEXT_MAX = 400
const DEFERRED = /\b(?:follow[- ]?ups?|deferred?)\b/i

const sp = (text: string, tone: Tone): Span => ({ text, tone })

// --- Text ---

/** One line, redacted, at most TEXT_MAX characters. The redaction runs on the whole text before any cut. */
const plain = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const one = redact(value).text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return one.length > TEXT_MAX ? `${one.slice(0, TEXT_MAX - 1)}…` : one
}

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** now, Nm, Nh, Nd; `-` when the fact has no time. A time ahead of the clock reads now. */
const ageOf = (now: number, at: number | undefined): string => {
  if (!known(at)) return '-'
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Text plus an optional recommendation, cut to `room`: the recommendation keeps at least half the room when it needs it. */
const withRecommend = (text: string, rec: string, room: number): string => {
  if (rec === '') return clip(text, room)
  const tail = ` - recommend: ${rec}`
  if (text.length + tail.length <= room) return text + tail
  const lead = clip(text, Math.min(text.length, Math.max(Math.ceil(room / 2), room - tail.length)))
  const left = room - lead.length
  return left > 8 ? lead + clip(tail, left) : clip(text, room)
}

// --- Items ---

type Body = { text: string; rec?: string }

/** An item before it is drawn. `make` runs only for the items that are shown, so a long list costs a sort, not a redaction each. */
type Item = { rank: number; at: number | undefined; tag: string; derived: boolean; tone: Tone; make: () => Body }

const item = (rank: number, at: number | undefined, tag: string, tone: Tone, make: () => Body, derived = false): Item => ({ rank, at, tag, derived, tone, make })

const newestFirst = (a: Item, b: Item): number => a.rank - b.rank || (known(b.at) ? b.at : -Infinity) - (known(a.at) ? a.at : -Infinity)

/** A longer tag has a short form for a pane too narrow to show any text beside it. */
const SHORT: Record<string, string> = { decision: 'dec', steward: 'stew', keeper: 'keep', agent: 'agt' }
/** Room that keeps the text readable beside the tag; below it the short tag is used. */
const READABLE = 12

/** The tails to try, most complete first. `derived` is never dropped: a pane too narrow for `[derived decision]` keeps `[derived]`. */
const tailsOf = (it: Item, age: string): string[] => {
  const short = SHORT[it.tag]
  const mark = it.derived ? 'derived ' : ''
  return [
    ` [${mark}${it.tag}] ${age}`,
    ...(short === undefined ? [] : [` [${mark}${short}] ${age}`]),
    ...(it.derived ? [` [derived] ${age}`] : []),
  ]
}

/** The first tail that leaves the text READABLE room; else the tail that leaves the most. */
const pickTail = (tails: string[], columns: number): string => {
  const room = (one: string): number => columns - 2 - one.length
  const good = tails.find(one => room(one) >= READABLE)
  if (good !== undefined) return good
  const fits = tails.filter(one => room(one) >= 1)
  return fits.reduce((best, one) => (room(one) > room(best) ? one : best), fits[0] ?? tails[tails.length - 1] ?? '')
}

const itemRow = (key: string, it: Item, now: number, columns: number): PaneRow => {
  const body = it.make()
  const age = ageOf(now, it.at)
  const tails = tailsOf(it, age)
  const tail = pickTail(tails, columns)
  const room = Math.max(1, columns - 2 - tail.length)
  const text = withRecommend(body.text === '' ? '(no text)' : body.text, body.rec ?? '', room)
  const row: PaneRow = { key, left: [sp('  ', 'dim'), sp(text, it.tone), sp(tail, 'dim')] }
  // A pane narrower than the shortest tail: cut the whole row, it never exceeds the width.
  const wide = 2 + text.length + tail.length
  return wide <= columns ? row : { key, left: [sp(clip(`  ${text}${tail}`, columns), 'dim')] }
}

const block = (id: DigestBlock['id'], title: string, empty: string, items: Item[], now: number, columns: number, limit: number): DigestBlock => {
  const sorted = [...items].sort(newestFirst)
  const shown = Math.min(sorted.length, limit)
  const more = sorted.length - shown
  const rows: PaneRow[] = sorted.slice(0, shown).map((one, i) => itemRow(`brief-${id}-${i}`, one, now, columns))
  if (more > 0) rows.push({ key: `brief-${id}-more`, left: [sp(`  +${more} more`, 'dim')] })
  if (sorted.length === 0) rows.push({ key: `brief-${id}-none`, left: [sp(clip(empty, columns), 'dim')] })
  const count = sorted.length > 0 && columns >= 24 ? [sp(String(sorted.length), 'dim')] : undefined
  const head: PaneRow = { key: `brief-${id}-head`, left: [sp(clip(title, columns), 'head')], ...(count ? { right: count } : {}) }
  return { id, title, total: sorted.length, shown, more, head, rows }
}

/**
 * The same block cut to `limit` items (a smaller limit than it was built with). Rows already drawn are kept: only the
 * `+N more` row changes. A limit above `shown` changes nothing.
 */
export const fold = (found: DigestBlock, limit: number): DigestBlock => {
  const shown = Math.max(0, Math.min(found.shown, Math.floor(limit)))
  if (shown === found.shown) return found
  const more = found.total - shown
  const kept = found.rows.slice(0, shown)
  return { ...found, shown, more, rows: [...kept, { key: `brief-${found.id}-more`, left: [sp(`  +${more} more`, 'dim')] }] }
}

// --- Steps (the unproven check and the deferred check) ---

type Step = { id: string; text: string; state: 'todo' | 'doing' | 'done' | 'blocked'; kind: 'task' | 'plan' }

/** PRD 5.1: the task list when it holds a task, else the brief plan. */
const stepsOf = (brief: Brief | null, tasks: OsTask[]): Step[] =>
  tasks.length > 0
    ? tasks.map(one => ({ id: one.id, text: one.subject, state: one.status === 'completed' ? 'done' : one.status === 'in_progress' ? 'doing' : 'todo', kind: 'task' as const }))
    : (brief?.plan ?? []).map(one => ({ id: one.id, text: one.text, state: one.status, kind: 'plan' as const }))

const blockedItems = (brief: Brief | null): Item[] =>
  (brief?.plan ?? []).filter(one => one.status === 'blocked').map(one => item(3, undefined, 'plan', 'bad', () => ({ text: `Blocked: ${plain(one.text)}` })))

const stepItems = (brief: Brief | null, tasks: OsTask[]): Item[] => {
  const out: Item[] = []
  for (const step of stepsOf(brief, tasks)) {
    if (step.state === 'done') {
      // A finished follow-up is closed work, not an unproven claim (D10).
      if (!DEFERRED.test(step.text) && proofOf(brief, { id: step.id, subject: step.text, kind: step.kind }) === null) out.push(item(0, undefined, step.kind, 'warn', () => ({ text: `${plain(step.text)} is done but unproven` })))
    } else if (step.state !== 'blocked' && DEFERRED.test(step.text)) {
      out.push(item(0, undefined, step.kind, 'todo', () => ({ text: plain(step.text) })))
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
      item(one.kind === 'approval' ? RANK.approval : RANK.ask, one.at, 'ask', 'warn', () => ({
        text: `${one.kind === 'approval' ? 'Approve: ' : ''}${plain(one.text)}`,
        rec: plain(one.recommend),
      })),
    )

const prName = (one: DigestPr): string => `PR #${one.pr}`
const titled = (one: DigestPr): string => (plain(one.title) === '' ? '' : ` - ${plain(one.title)}`)

const needsPrItems = (prs: DigestPr[]): Item[] => {
  const out: Item[] = []
  for (const one of prs) {
    if (one.merged === true || !known(one.pr)) continue
    if (one.state === 'READY') {
      out.push(item(RANK.ready, one.at, 'pr', 'warn', () => ({ text: `${prName(one)} is ready, waiting for your merge yes${titled(one)}` })))
      continue
    }
    if (known(one.failedChecks) && one.failedChecks > 0) {
      const n = one.failedChecks
      out.push(item(RANK.failed, one.at, 'pr', 'bad', () => ({ text: `${prName(one)}: ${plural(n, 'check')} failed${titled(one)}` })))
    }
    if (one.state === 'LIMITED' || known(one.rateLimit?.minutes)) {
      const wait = one.rateLimit?.minutes
      // LIMITED also means a review that did not finish: only a known wait time is a rate limit.
      const what = known(wait) ? `hit a review rate limit, wait ${wait}m` : 'review did not finish'
      out.push(item(RANK.limited, one.at, 'pr', 'warn', () => ({ text: `${prName(one)} ${what}${titled(one)}` })))
    }
  }
  return out
}

const failedProofItems = (proofs: DigestProof[]): Item[] =>
  proofs
    .filter(one => known(one.result?.failed) && one.result.failed > 0)
    .map(one => item(RANK.failed, one.at, 'proof', 'bad', () => ({ text: `Check failed: ${plain(one.subject)} (${one.result?.failed ?? 0} failed, ${one.result?.passed ?? 0} passed)` })))

// --- HIGHLIGHTS ---

const passedProofItems = (proofs: DigestProof[]): Item[] =>
  proofs
    .filter(one => !(known(one.result?.failed) && one.result.failed > 0))
    .map(one =>
      item(
        0,
        one.at,
        'proof',
        'todo',
        () => {
          const numbers = one.result ? `: ${one.result.passed} pass, ${one.result.failed} fail` : ''
          return { text: `${plain(one.subject)}${numbers} - ${basename(plain(one.artifact))}` }
        },
        one.derived === true,
      ),
    )

const decisionItems = (decisions: DigestDecision[]): Item[] =>
  decisions
    .filter(one => one.derived === true || (typeof one.by === 'string' && one.by.trim().toLowerCase() === 'dave'))
    .map(one => item(0, one.at, 'decision', 'todo', () => ({ text: one.derived === true ? plain(one.text) : `${plain(one.text)} - by ${plain(one.by)}` }), one.derived === true))

const milestoneItems = (prs: DigestPr[], agents: AgentRun[], commits: DigestCommit[]): Item[] => [
  ...commits.map(one => item(0, one.at, 'git', 'todo', () => ({ text: `${plain(one.sha).slice(0, 7)} ${plain(one.subject)}`.trim() }))),
  ...prs.filter(one => one.merged === true).map(one => item(0, one.at, 'pr', 'todo', () => ({ text: `${prName(one)} merged${titled(one)}` }))),
  ...agents.filter(one => one.status === 'done').map(one => item(0, one.endedAt ?? one.startedAt, 'agent', 'todo', () => ({ text: `${plain(one.description)} finished` }))),
]

// --- WATCH ---

const driftItems = (brief: Brief | null, found: Drift | null): Item[] =>
  found !== null && found.level !== 'ok' ? [item(0, brief?.updatedAt, 'steward', 'dim', () => ({ text: `brief stale: ${plain(found.reason)}` }))] : []

const threadItems = (prs: DigestPr[]): Item[] =>
  prs
    .filter(one => one.merged !== true && one.state !== 'CLOSED' && one.state !== 'READY' && known(one.threads) && one.threads > 0)
    .map(one => item(0, one.at, 'pr', 'todo', () => ({ text: `${prName(one)} has ${plural(one.threads ?? 0, 'unresolved thread')}${titled(one)}` })))

const longRunItems = (agents: AgentRun[], now: number): Item[] =>
  agents
    .filter(one => one.status === 'running' && now - one.startedAt > LONG_RUN_MS)
    .map(one => item(0, one.startedAt, 'agent', 'todo', () => ({ text: `${plain(one.description)} running ${ageOf(now, one.startedAt)}` })))

const peerItems = (lanes: DigestLane[]): Item[] =>
  lanes
    .filter(one => !one.mine && one.state !== 'done' && one.state !== 'backlog')
    .map(one => item(0, one.at, 'lane', 'todo', () => ({ text: `${plain(one.id)} held by ${plain(one.holder) || 'another session'}` })))

const deferredDecisionItems = (decisions: DigestDecision[]): Item[] =>
  decisions.filter(one => DEFERRED.test(one.text)).map(one => item(0, one.at, 'decision', 'todo', () => ({ text: plain(one.text) }), one.derived === true))

/** True when the summary holds the keeper's marker line for exactly these counts (a longer count such as "of 70" is not a match). */
const kept = (one: DigestCompaction): boolean => {
  if (!known(one.open) || !known(one.total) || typeof one.summary !== 'string') return false
  const marker = keeperMarker(one.sessionId, one.open, one.total)
  for (let from = 0; ; ) {
    const at = one.summary.indexOf(marker, from)
    if (at < 0) return false
    if (!/\d/.test(one.summary[at + marker.length] ?? '')) return true
    from = at + 1
  }
}

/** The newest compaction sets the line; 3 of the newest 5 that lost the plan add the kill rule row. A compaction with no counts is not judged. */
const keeperItems = (compactions: DigestCompaction[]): Item[] => {
  const judged = compactions.filter(one => known(one.open) && known(one.total) && known(one.at)).sort((a, b) => b.at - a.at).slice(0, KILL_WINDOW)
  const newest = judged[0]
  if (newest === undefined) return []
  const lost = judged.filter(one => !kept(one)).length
  const out: Item[] = []
  if (lost >= KILL_LOST) out.push(item(0, newest.at, 'keeper', 'bad', () => ({ text: `the keeper lost the plan in ${lost} of the last ${judged.length} compactions: remove it` })))
  const ok = kept(newest)
  out.push(item(0, newest.at, 'keeper', ok ? 'dim' : 'warn', () => ({ text: `last compaction kept the plan: ${ok ? 'yes' : 'no'}` })))
  return out
}

// --- Entry point ---

/**
 * The briefing. `limit` is the items per block (the caller's pane height decides; default MAX_ITEMS). Facts the session cannot
 * know stay out: pass an empty list and the block has fewer items, never an invented one.
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
  const commits = options.commits ?? []
  const needs = [...askItems(asks), ...needsPrItems(prs), ...blockedItems(brief), ...failedProofItems(proofs)]
  const highlights = [...milestoneItems(prs, agents, commits), ...passedProofItems(proofs), ...decisionItems(decisions)]
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
    needs: block('needs', 'NEEDS YOU', 'nothing needs you', needs, now, columns, limit),
    highlights: block('highlights', 'HIGHLIGHTS', 'no highlights yet', highlights, now, columns, limit),
    watch: block('watch', 'WATCH', 'nothing to watch', watch, now, columns, limit),
  }
}
