import type { CheckpointAsk, CheckpointOption, CheckpointResult } from '../../types'

/** Pure helpers of the PR checkpoint mod. Nothing here takes `$`: a `$` and an atom cannot cross an import (README). */

export const TOOL_NAME = 'pr_checkpoint'
/**
 * The command Dave types. One constant: the registration, the matcher, the usage text and every "type /..." line read it.
 * Not "checkpoint": `claude plugin validate` (2.1.312) reports that as a name Claude Code ships, so `$.command.register` refuses it live.
 * validate-mods fails on such a name (refusedCommandProblems).
 */
export const COMMAND = 'pathway'
export const SLASH = `/${COMMAND}`
export const REPO = 'Rev4nchist/Continuous-Claude-v3'
export const ENGINE_REL = 'scripts/github/pr-checkpoint.mjs'
export const ENGINE_TIMEOUT_MS = 120_000
export const APPLY_TIMEOUT_MS = 180_000
export const GIT_TIMEOUT_MS = 20_000
export const PENDING_STALE_MS = 7 * 24 * 3_600_000

export const USAGE = `Usage: ${SLASH} [pr] [accept|coderabbit|both|none|wait] [--body <file>]   or   ${SLASH} grant <pr> <round>`
export const NEED_PR = 'No checkpoint waits in this session. The session asks the question: it calls pr_checkpoint with the PR number. Nothing was recorded.'
const PATHWAY_WORDS = ['accept', 'coderabbit', 'both', 'none', 'wait']

export type CheckpointArgs = { pr: number | null; word: string | null; body: string | null }

/** `328:none` or `none:328`: a PR number and a word joined by one colon. A drive path (`C:/x`) and any other colon text do not match. */
const PR_WORD_PAIR = /^(?:#?\d+:[a-z]+|[a-z]+:#?\d+)$/i

/**
 * `7`, `#7`, `7:none`, a pathway word (any case) and `--body <file>`, in any order. Anything else is a usage error (null).
 * Only the FIRST line is read (M6: a long typed answer put prose in the args and the whole command failed). `ignoredText` names the rest.
 */
export const parseCheckpointArgs = (args: string): CheckpointArgs | null => {
  const words = firstLine(args).split(/\s+/).filter(Boolean)
  let pr: number | null = null
  let word: string | null = null
  let body: string | null = null
  for (let i = 0; i < words.length; i += 1) {
    const one = words[i]!
    if (PR_WORD_PAIR.test(one)) {
      // The two halves go back into the list. The value after --body is read in the branch below, so it never gets here.
      words.splice(i, 1, ...one.split(':'))
      i -= 1
    } else if (one === '--body') {
      const value = words[i + 1]
      if (value === undefined || body !== null) return null
      body = value.replace(/^["']|["']$/g, '')
      i += 1
    } else if (/^#?\d+$/.test(one)) {
      if (pr !== null) return null
      pr = Number(one.replace('#', ''))
      if (pr < 1) return null
    } else if (PATHWAY_WORDS.includes(one.toLowerCase())) {
      if (word !== null) return null
      word = one.toLowerCase()
    } else {
      return null
    }
  }
  return { pr, word, body }
}

/**
 * `grant <pr> <round>`: Dave's typed Yes for a review round. Null when the text is not a grant command, 'usage' when it starts
 * with `grant` and is not exactly `grant <pr> <round>` with both numbers at least 1.
 */
export const parseGrantArgs = (args: string): { pr: number; round: number } | 'usage' | null => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words[0]?.toLowerCase() !== 'grant') return null
  const match = words.length === 3 ? [/^#?(\d+)$/.exec(words[1]!), /^(\d+)$/.exec(words[2]!)] : null
  if (!match || !match[0] || !match[1]) return 'usage'
  const pr = Number(match[0][1])
  const round = Number(match[1][1])
  return Number.isSafeInteger(pr) && Number.isSafeInteger(round) && pr >= 1 && round >= 1 ? { pr, round } : 'usage'
}

const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/

/** The body file as the engine reads it: a relative path is relative to the given root. */
export const resolveBody = (root: string, body: string): string => (ABSOLUTE.test(body) ? body : `${root.replace(/[\\/]+$/, '')}/${body}`)

export const engineArgv = (root: string, ...flags: string[]): string[] => ['node', `${root}/${ENGINE_REL}`, ...flags]

/**
 * The facts call of `prepare`: --no-ledger, so the engine writes no offer and counts no miss before the head check has passed.
 * `ledgerArgv` is the second call (after the head check and after a return to draft): it adds the ledger block. `askAnyway` asks the question for
 * an auto-eligible PR whose auto-confirm did not record (the ledger would otherwise say no question is needed).
 */
export const factsFlags = (pr: number, dependabot: boolean): string[] => ['--json', '--pr', String(pr), '--probe', '--no-ledger', ...(dependabot ? ['--dependabot'] : [])]
/** The ledger call sees the same facts as the facts call: a Dependabot PR (the author, read by prepare) changes the options, so the flag goes again. */
export const ledgerFlags = (pr: number, askAnyway: boolean, dependabot: boolean, repickSince: string | null = null): string[] => [
  '--json', '--pr', String(pr), ...(dependabot ? ['--dependabot'] : []), ...(askAnyway ? ['--ask-anyway'] : []), ...repickFlags(repickSince),
]

/** `--repick-since <ISO>`: a tap made before it is stale (the PR went back to draft). Null: no marker, no flag. */
export const repickFlags = (repickSince: string | null): string[] => (repickSince === null ? [] : ['--repick-since', repickSince])

/** The text the engine gets when a marker holds no readable time. It does not parse, so the engine reads every tap as stale (fail closed). */
export const REPICK_UNREADABLE = 'unreadable'

/** The marker's `at` (ms, from `$.clock.now()`) as an ISO time for `--repick-since`. A time that is not a finite date gives REPICK_UNREADABLE, never no flag. */
export const repickSinceOf = (marker: unknown): string | null => {
  if (marker === null || marker === undefined) return null
  const at = (marker as { at?: unknown }).at
  if (typeof at !== 'number' || !Number.isFinite(at)) return REPICK_UNREADABLE
  try {
    return new Date(at).toISOString()
  } catch {
    return REPICK_UNREADABLE
  }
}

/** The drop of the taps of a PR returned to draft (the engine deletes the review and paid-round taps, offers and misses of the PR). */
export const dropTapsFlags = (pr: number): string[] => ['--drop-taps', '--pr', String(pr)]
export const dropFailedText = (pr: number, why: string): string => `The taps of PR #${pr} could not be cleared (${why}). Nothing was recorded. The PR stays a draft. Tell Dave.`
/** The re-pick marker had no readable time and its repair could not be saved: the engine keeps rejecting old taps, so nothing is asked. A new call retries. */
export const markerFailedText = (pr: number): string =>
  `The re-pick marker of PR #${pr} could not be saved. Nothing was asked. Nothing was recorded. The PR stays a draft. Call pr_checkpoint again.`
/** The drop worked but its proof could not be saved: a question now would lose the tap on it at the next call. Nothing was asked; a new call retries. */
export const flagFailedText = (pr: number): string =>
  `The taps of PR #${pr} were cleared, but the proof of it could not be saved. Nothing was asked. Nothing was recorded. The PR stays a draft. Call pr_checkpoint again.`

/** A step of the cleanup of a PR that went back to draft failed (the round grant, the queued asks, the queue entry): the cleanup stays open and a new call runs every step again. */
export const cleanupOpenText = (pr: number, what: string[]): string =>
  `The cleanup of PR #${pr} is not finished: ${what.join(' and ')} could not be cleared. Nothing was asked. Nothing was recorded. The PR stays a draft. Call pr_checkpoint again.`
/** The fresh read before a cleanup did not show a draft at the head: nothing is cleaned, asked or recorded. */
export const cleanupUncheckedText = (pr: number, why: string): string =>
  `PR #${pr} could not be checked before the cleanup (${why}). Nothing was cleaned, asked or recorded. Call pr_checkpoint again.`

export const viewArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'isDraft,headRefOid,headRefName,author,labels,number', '-R', REPO]

/** Whether the `labels` of a gh pr view carry risk:high (the one label the band reads), or null when the list is absent or malformed. */
export const riskHighOf = (labels: unknown): boolean | null =>
  Array.isArray(labels) ? labels.some(one => typeof one === 'object' && one !== null && (one as { name?: unknown }).name === 'risk:high') : null

export const WORKTREE_ARGV = ['git', 'worktree', 'list', '--porcelain']

/** One path in two spellings (git prints C:/x, the session root may be C:\x or c:\x\) compares equal. */
export const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  return norm(a) === norm(b)
}

/**
 * The worktree that has `branch` checked out, from `git worktree list --porcelain`. Git lets one branch live in one worktree only,
 * so the first match is the only one. No match, an empty branch or unreadable text: null.
 */
export const worktreeFor = (porcelain: string, branch: string): string | null => {
  if (!branch) return null
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length).trim()
    if (path && lines.some(line => line.trim() === `branch refs/heads/${branch}`)) return path
  }
  return null
}

/** The PR's state, head and draft flag, read before a late Yes posts a review request or stores a grant: only an open PR that is not a draft, at the asked head, may act. */
export const stateArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'state,headRefOid,isDraft', '-R', REPO]

export const commentArgv = (pr: number, body: string): string[] => ['gh', 'pr', 'comment', String(pr), '-R', REPO, '--body', body]

/** The last non-empty line of a stream: the engine's refusal is one line. */
export const lastLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? ''

export const firstLine = (text: string): string => text.trim().split(/\r?\n/).find(Boolean) ?? ''

/** The text after the first line, on one line and clipped: what a typed answer carried that no parser read. Empty for a one-line answer. */
export const ignoredText = (text: string): string => clip(text.trim().split(/\r?\n/).slice(1).join(' ').replace(/\s+/g, ' ').trim(), 200)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The engine's auto-confirm answer. Only a boolean true is eligible: an old engine (no block), a string or any other shape is not. */
const autoOf = (value: unknown): CheckpointResult['auto'] => {
  if (!isObject(value) || value.eligible !== true) {
    return { eligible: false, band: isObject(value) && typeof value.band === 'string' ? value.band : null, reason: isObject(value) && typeof value.reason === 'string' ? value.reason : 'The engine gave no auto-confirm answer.' }
  }
  return { eligible: true, band: typeof value.band === 'string' ? value.band : null, reason: typeof value.reason === 'string' ? value.reason : '' }
}

/** The file count a paid label prices: the UNFILTERED `total` (cr-paid.mjs `total`), or `files` when the result has none. The engine has the same rule (paidCountOf in checkpoint-ledger.mjs). */
export const paidCountOf = (size: { files: number; total?: number }): number => {
  const total = size.total
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : size.files
}

/** The result plus the engine's drift text (`config_drift_why`: null or absent without drift, or from an old engine). */
export type CheckpointResultWithDrift = CheckpointResult & { config_drift_why?: string | null; ledger?: LedgerBlock | null }

/** The engine's `--json` output, or null when it lacks the fields the mod reads. */
export const parseResult = (stdout: string): CheckpointResultWithDrift | null => {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isObject(parsed) || typeof parsed.head !== 'string' || !Array.isArray(parsed.options)) return null
    const size = isObject(parsed.size) ? parsed.size : {}
    return {
      head: parsed.head,
      class: typeof parsed.class === 'string' ? parsed.class : 'unknown',
      matched: typeof parsed.matched === 'number' ? parsed.matched : 0,
      size: {
        files: typeof size.files === 'number' ? size.files : 0,
        lines: typeof size.lines === 'number' ? size.lines : 0,
        // The unfiltered count prices the paid rows. A value that is no whole, non-negative number is dropped (the price then follows files).
        ...(typeof size.total === 'number' && Number.isInteger(size.total) && size.total >= 0 ? { total: size.total } : {}),
      },
      checks: Array.isArray(parsed.checks) ? (parsed.checks as CheckpointResult['checks']) : [],
      cli: isObject(parsed.cli) && isObject(parsed.cli.bySeverity) ? (parsed.cli as CheckpointResult['cli']) : null,
      credits: isObject(parsed.credits) ? (parsed.credits as CheckpointResult['credits']) : { used: null, monthly: null },
      capacity: isObject(parsed.capacity) ? (parsed.capacity as CheckpointResult['capacity']) : { count: null, band: null, warning: null, source: null, date: null },
      recommended: typeof parsed.recommended === 'string' ? parsed.recommended : null,
      options: parsed.options as CheckpointOption[],
      why: Array.isArray(parsed.why) ? parsed.why.map(String) : [],
      budget: Array.isArray(parsed.budget) && parsed.budget.length === 2 ? [Number(parsed.budget[0]), Number(parsed.budget[1])] : [0, 0],
      config_drift: parsed.config_drift === true,
      config_drift_why: typeof parsed.config_drift_why === 'string' ? parsed.config_drift_why : null,
      auto: autoOf(parsed.auto),
      ledger: ledgerOf(parsed.ledger),
    }
  } catch {
    return null
  }
}

/**
 * The options Dave can press, the recommended pathway first whatever order the engine lists; and the held ones, which are text.
 * A pathway not in the list is never invented: with no recommendation (R0) nothing is pressable.
 * `recommendedFirst` is true only when the first Button IS the recommendation. When the engine recommends a pathway that is held, the
 * open options keep the engine order and none is marked Recommended, focused or pressed `--by default` (the engine refuses that).
 */
export const optionsInOrder = (result: CheckpointResult): { buttons: CheckpointOption[]; held: CheckpointOption[]; recommendedFirst: boolean } => {
  const open = result.options.filter(one => one.available)
  const held = result.options.filter(one => !one.available)
  const first = open.find(one => one.pathway === result.recommended)
  const buttons = first ? [first, ...open.filter(one => one !== first)] : open
  return { buttons: result.recommended === null ? [] : buttons, held, recommendedFirst: first !== undefined && result.recommended !== null }
}

export const costText = (cost: [number, number]): string => (cost[0] + cost[1] === 0 ? 'no review' : `budget ${cost[0]}+${cost[1]}`)

/** The top paths by changed lines from `git diff --numstat`. */
export const topPaths = (numstat: string, count: number): string[] =>
  numstat
    .split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 3)
    .map(parts => ({ lines: (Number(parts[0]) || 0) + (Number(parts[1]) || 0), path: parts.slice(2).join('\t') }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, count)
    .map(one => `${one.path} (${one.lines})`)

export const coversRows = (subjects: string | null, numstat: string | null): string[] => {
  if (subjects === null && numstat === null) return ['Covers: unknown']
  const rows: string[] = []
  const list = (subjects ?? '').split(/\r?\n/).filter(Boolean).slice(0, 8)
  if (list.length) rows.push(`Covers: ${list.join('; ')}`)
  const paths = topPaths(numstat ?? '', 5)
  if (paths.length) rows.push(`Top files: ${paths.join(', ')}`)
  return rows.length ? rows : ['Covers: unknown']
}

export const clip = (text: string, width: number): string => (width > 3 && text.length > width ? `${text.slice(0, width - 1)}…` : text)

// ---- the questions ----------------------------------------------------------------------------------------------------------------
// Spike S2 (2026-11-04): a mod may only use $.ui.ask, which takes labels and no descriptions. So the cost sits in each label, the
// recommendation carries " (Recommended)" (row 0 is always a $0 row), and a short overview sits in the question. Only an exact match of a label records.

/** The marker the label of the recommended row carries. */
export const RECOMMENDED = ' (Recommended)'
/** A paid CodeRabbit round costs about this much per changed file (pr-review-loop.md "Billing facts"); path_filters are ignored, so it is "up to". */
export const PAID_PER_FILE = 0.25
export const FIGURE = (dollars: number): string => `$${dollars.toFixed(2)}`
/** The cost part of a label for `files` changed files. Unknown files: the per-file price. */
export const upTo = (files: number | null): string => (files === null ? `up to ${FIGURE(PAID_PER_FILE)} per changed file` : `up to ${FIGURE(files * PAID_PER_FILE)}`)

/** A tap is always Dave's own pick: `by` is `dave` for every row, the recommended row included (M9, Dave 2026-11-06). Never `default` for a dialog answer. */
export type PathwayChoice = { label: string; pathway: string; by: 'dave' }

/**
 * At HIGH and CRITICAL a typed `accept` of `none` is Dave's own pick (`--by dave`), even when it is the recommendation (the interim CodeRabbit rule,
 * 2026-11-04: HIGH without the risk:high trigger is recommended none). The engine refuses `--by default` for it, and land-none-check.mjs
 * reads decided_by dave. Same bands as QUEUE_BANDS in pr-loop/slot.ts (not imported: this file takes types only).
 */
export const onlyDaveRecordsNone = (pathway: string, band: unknown): boolean => pathway === 'none' && (band === 'HIGH' || band === 'CRITICAL')
export type PathwayAsk = { pr: number; header: string; question: string; choices: PathwayChoice[] }

const NAMES: Record<string, string> = { none: 'No review, land on CI', coderabbit: 'CodeRabbit review', both: 'CodeRabbit + Greptile', wait: 'Keep as draft' }
const nameOf = (pathway: string): string => NAMES[pathway] ?? pathway

// ---- the CodeRabbit slot fact ----------------------------------------------------------------------------------------------------
// The engine prints `capacity` with the slot fact beside the old count fields: state free, wait or unknown, nextSlotAt, minutesToSlot and
// lastNoticeAt. An older checkpoint has none of them. Anything that is not exactly free or wait reads unknown: the question never fails on it.

export type SlotFact = { state: 'free' | 'wait' | 'unknown'; nextSlotAt: string | null; minutesToSlot: number | null; lastNoticeAt: string | null }

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** A free fact older than this is no longer a fact: the slot may have gone. */
export const FREE_FACT_MAX_AGE_MS = 5 * 60_000
/** A `checkedAt` this far after the clock is clock skew and still fresh. Further ahead it cannot be trusted. The engine has the same figure (FUTURE_SKEW_MS). */
export const FUTURE_SKEW_MS = 60_000

/**
 * The slot fact, read at `now` (ms; null reads the fact as printed). Keep as draft leaves the pending entry, so a bare /pathway can ask
 * again hours later from the stored fact. At `now`, a `free` fact with no readable `checkedAt`, one older than 5 minutes or one more than
 * 1 minute after `now` (it fails closed) is unknown,
 * and so is a `wait` fact whose `nextSlotAt` has passed. A `wait` fact with no readable `nextSlotAt` has no time to pass, so it ages out
 * the same way a `free` fact does.
 */
export const slotOf = (raw: unknown, now: number | null = null): SlotFact => {
  const cap = isObject(raw) ? raw : {}
  const minutes = typeof cap.minutesToSlot === 'number' && Number.isFinite(cap.minutesToSlot) ? Math.max(0, Math.round(cap.minutesToSlot)) : null
  const printed = cap.state === 'free' || cap.state === 'wait' ? cap.state : 'unknown'
  const checked = typeof cap.checkedAt === 'string' ? Date.parse(cap.checkedAt) : Number.NaN
  const next = typeof cap.nextSlotAt === 'string' ? Date.parse(cap.nextSlotAt) : Number.NaN
  const stale = now !== null && !(now - checked <= FREE_FACT_MAX_AGE_MS && checked - now <= FUTURE_SKEW_MS)
  const staleFree = printed === 'free' && stale
  const pastWait = printed === 'wait' && now !== null && (Number.isFinite(next) ? next <= now : stale)
  const state = staleFree || pastWait ? 'unknown' : printed
  return { state, nextSlotAt: textOrNull(cap.nextSlotAt), minutesToSlot: minutes, lastNoticeAt: textOrNull(cap.lastNoticeAt) }
}

/** `14:20 CST`: the clock time in Chicago, with the zone name of that date (CST or CDT). Null for a time that does not parse. */
export const chicagoTime = (iso: string | null | undefined): string | null => {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(at)
    const part = (type: string) => parts.find(one => one.type === type)?.value
    const [hour, minute, zone] = [part('hour'), part('minute'), part('timeZoneName')]
    return hour && minute && zone ? `${hour}:${minute} ${zone}` : null
  } catch {
    return null
  }
}

/** The minutes to the next slot: counted from `now` when the slot time parses (a pending question can be asked again hours later), else the engine's figure. */
const minutesLeft = (slot: SlotFact, now: number | null): number | null => {
  const next = slot.nextSlotAt === null ? Number.NaN : Date.parse(slot.nextSlotAt)
  return now !== null && Number.isFinite(next) ? Math.max(0, Math.ceil((next - now) / 60_000)) : slot.minutesToSlot
}

/** Line 3 of the question: the CodeRabbit slot, from the engine's fact. */
export const slotLine = (slot: SlotFact, now: number | null): string => {
  if (slot.state === 'free') return 'CodeRabbit slot: free now.'
  if (slot.state === 'unknown') return `CodeRabbit slot: unknown (${chicagoTime(slot.lastNoticeAt) ? `last notice ${chicagoTime(slot.lastNoticeAt)}` : 'no notice seen'}).`
  const minutes = minutesLeft(slot, now)
  const at = chicagoTime(slot.nextSlotAt)
  if (at && minutes !== null) return `CodeRabbit slot: next about ${at} (in ${minutes} min).`
  return `CodeRabbit slot: no free slot, ${minutes === null ? 'next time unknown' : `next in about ${minutes} min`}.`
}

/** A Greptile pass costs this many credits (the engine has the same figure: GREPTILE_CREDITS in scripts/github/lib/checkpoint-ledger.mjs). */
export const GREPTILE_CREDITS = 3

/**
 * The label of one open pathway. The CodeRabbit row follows the slot: free is $0, any other state is "may cost up to". The words are the engine's
 * (labelOf in scripts/github/lib/checkpoint-ledger.mjs): both copies of the question must give one text, and a test compares them.
 */
const labelFor = (one: CheckpointOption, files: number, slot: SlotFact): string => {
  if (one.pathway === 'none' || one.pathway === 'wait') return `${nameOf(one.pathway)} ($0)`
  const price = upTo(files)
  if (one.pathway === 'coderabbit' && slot.state === 'free') return 'CodeRabbit now (free slot, $0)'
  if (one.pathway === 'both') return `${nameOf('both')} (may cost ${price} + ${GREPTILE_CREDITS} credits)`
  return `${nameOf(one.pathway)} (may cost ${price})`
}

const WAIT_OPTION: CheckpointOption = { pathway: 'wait', label: null, available: true, cost: [0, 0], reason: '' }

/** A paid row spends money: Greptile always, CodeRabbit unless the slot is free. Its label carries the price. The tap records the pick: one question; a paid row shows its price. */
const isPaidRow = (one: CheckpointOption, slot: SlotFact): boolean => one.pathway === 'both' || (one.pathway === 'coderabbit' && slot.state !== 'free')

/**
 * The rows of the question. Row 0 is Keep as draft, or "No review" when none is the recommendation: both cost $0. Then the free-slot CodeRabbit row,
 * then the paid rows (the recommendation first), then "No review". A paid row is never row 0: a dialog that returns row 0 with no tap records nothing
 * paid. The free-slot and the paid CodeRabbit row have different labels. The order depends on the result and on the clock (the slot fact ages), so a re-ask at the same time shows the same rows.
 */
const rowsOf = (buttons: CheckpointOption[], slot: SlotFact, recommendedFirst: boolean): CheckpointOption[] => {
  const open = buttons.filter(one => one.pathway !== 'wait')
  const crs = open.filter(one => one.pathway !== 'none')
  const first = buttons[0]
  const lead = recommendedFirst && first?.pathway === 'none' ? [first] : []
  const rows = [...lead, WAIT_OPTION, ...crs.filter(one => !isPaidRow(one, slot)), ...crs.filter(one => isPaidRow(one, slot)), ...open.filter(one => one.pathway === 'none')]
  return rows.filter((one, i) => rows.findIndex(other => other.pathway === one.pathway) === i)
}

/**
 * Which row carries " (Recommended)": the recommendation when it is open; when it is held, Keep as draft (the safe pick). The engine marks the same
 * rows (recommendedOf in scripts/github/lib/checkpoint-ledger.mjs), and a test compares the two copies.
 */
const marked = (pathway: string, result: CheckpointResult, recommendedFirst: boolean): boolean => pathway === (recommendedFirst ? result.recommended : 'wait')

/** Line 1 of the question: PR, band and file count. The band is the one the engine printed at auto-confirm. */
const overview = (pr: number, result: CheckpointResult): string => {
  const files = result.size.files
  return `PR #${pr}, band ${result.auto?.band ?? 'unknown'}, ${files} ${files === 1 ? 'file' : 'files'}.`
}

/** The lines of the question: three fixed ones, then the extra reasons, the held pathways and the warnings. */
const questionLines = (pr: number, result: CheckpointResultWithDrift, held: CheckpointOption[], recommendedFirst: boolean, now: number | null): string[] => {
  // Every reason shows: the RF floor (aegis + critic) is a second reason, and Dave must see it before he picks none.
  const [why, ...also] = result.why.map(one => one.replace(/[.\s]+$/, '')).filter(one => one !== '')
  const second = recommendedFirst
    ? `Recommended: ${nameOf(result.recommended ?? '')}${why ? `, because ${why}` : ''}.`
    : `Recommended: Keep as draft, because ${nameOf(result.recommended ?? '')} is held.`
  const lines = [overview(pr, result), second, slotLine(slotOf(result.capacity, now), now)]
  if (recommendedFirst) lines.push(...also.map(one => `Also: ${one}.`))
  if (held.length > 0) lines.push(`Held: ${held.map(one => `${nameOf(one.pathway)} (${one.reason})`).join('; ')}.`)
  if (result.config_drift) lines.push(`Warning: ${result.config_drift_why ?? 'branch config differs from main'}`)
  const warning = (result.capacity as Partial<CheckpointResult['capacity']> | undefined)?.warning
  if (warning) lines.push(`Warning: ${warning}.`)
  return lines
}

/**
 * The checkpoint question, or null when there is nothing to choose: no recommendation (R0), or no open pathway. The question has 3 lines: the PR,
 * the recommendation with its reason, and the CodeRabbit slot (`now` is the clock in ms, for the minutes left). A second reason, a held pathway
 * and a warning each add a line below them: Dave must see them before he picks. The labels are 2 to 4:
 * the open pathways, one "Keep as draft", and "No review, land on CI" last when the engine offers it (rowsOf gives the order). When the recommendation
 * is open its row carries " (Recommended)". Row 0 is a $0 row (Keep as draft, or none when it is the recommendation). A paid row carries its price and is never row 0: the tap on it records the pick
 * (one question; a paid row shows its price). Every pick is `--by dave`. When the recommendation is held, Keep as draft is marked Recommended.
 */
export const buildPathwayAsk = (pr: number, result: CheckpointResultWithDrift, now: number | null = null): PathwayAsk | null => {
  const { buttons, held, recommendedFirst } = optionsInOrder(result)
  const open = buttons.filter(one => one.pathway !== 'wait')
  if (result.recommended === null || open.length === 0) return null
  const slot = slotOf(result.capacity, now)
  const choices: PathwayChoice[] = rowsOf(buttons, slot, recommendedFirst).map(one => ({
    label: `${labelFor(one, paidCountOf(result.size), slot)}${marked(one.pathway, result, recommendedFirst) ? RECOMMENDED : ''}`,
    pathway: one.pathway,
    by: 'dave',
  }))
  const question = questionLines(pr, result, held, recommendedFirst, now).join('\n')
  return { pr, header: clip(`PR #${pr}`, 12), question, choices }
}

/**
 * What Dave's dialog answer maps to: the choice whose label EXACTLY equals the answer, else null (Dave 2026-11-06). A row number, a pathway word,
 * a label prefix, another case, a trailing space and free text are all misses: they record nothing and the question is asked again.
 * (A typed /pathway word is read by parseCheckpointArgs in the command path; the dialog never reads loose text.)
 */
export const pathwayOfAnswer = (answer: unknown, ask: PathwayAsk): PathwayChoice | null =>
  typeof answer === 'string' ? (ask.choices.find(one => one.label === answer) ?? null) : null

/**
 * The tool text for each outcome that records nothing. The model reads it; Dave's words reach the model through `stopText`.
 * No text here tells Dave to type or paste a command (M10): the way back is a question, which the model asks by calling pr_checkpoint.
 */
export const keptDraftText = (pr: number): string => `Dave kept #${pr} as a draft. Nothing recorded. The checkpoint stays pending. Do not ask him again. He decides when he is ready.`

/** What a typed answer carried past its first line, as a sentence for the end of a reply: ` Ignored: "...".` Empty for a one-line answer. */
export const ignoredNote = (text: string): string => {
  const ignored = ignoredText(text)
  return ignored === '' ? '' : ` Ignored: "${ignored}".`
}

/** The question is asked again at most this many times after a miss (an answer that matches no option, Esc, an empty answer). Dave 2026-11-06. */
export const MAX_REASKS = 2
export type Miss = 'closed' | 'empty' | 'other'
/** The first line of a re-asked question: it says why Dave sees the question again. `n` is 1 or 2. */
export const reaskLine = (n: number): string => `No answer matched an option. Asking again (${n} of ${MAX_REASKS}).`

const saidOf = (pr: number, how: Miss, typed: string): string =>
  how === 'closed' ? `Dave closed the question for #${pr}` : how === 'empty' ? `No valid answer came back for #${pr}` : `Dave wrote: ${clip(typed.replace(/\s+/g, ' '), 400)}`

/** The tool text when the re-asks are used up: nothing was recorded and the PR stays a draft. The model tells Dave. */
export const stopText = (pr: number, how: Miss, typed = ''): string =>
  `Stop. ${saidOf(pr, how, typed)}. The question was asked ${MAX_REASKS + 1} times with no valid answer. Nothing was recorded. PR #${pr} stays a draft. Tell Dave.`
export const movedText = (pr: number, why: string): string =>
  `#${pr} changed while Dave answered (${why}). Nothing recorded. Run pre-pr.mjs at the new head, then call pr_checkpoint again.`

// M2: a ready PR that already has a record. The question is Dave's own dialog; the answer never records a review.
export const changeLabels = (label: string): readonly [string, string] => [`Keep ${label}${RECOMMENDED}`, 'Return to draft and pick again']
export const changeQuestion = (pr: number, label: string, by: string, at: string | null): string =>
  `PR #${pr} is ready with ${label} (by ${by}${at ? `, ${at}` : ''}). Change the review pick?`
export const changeKeptText = (pr: number, label: string): string => `Dave kept ${label} for #${pr}. Nothing was changed. The PR stays ready.`
export const changeStopText = (pr: number): string => `No valid answer came back to "Change the review pick?" for #${pr}. Nothing was changed. The PR stays ready.`
export const undoFailedText = (pr: number, why: string): string => `Could not return #${pr} to draft (${why}). Nothing was changed. Nothing was recorded.`
export const notDraftText = (pr: number): string => `PR #${pr} is not a draft. The checkpoint applies to a draft PR only. Nothing was recorded.`
/** `gh pr ready <n> --undo`, run by the mod itself (not a model tool call, so the locks do not see it). */
export const undoArgv = (pr: number): string[] => ['gh', 'pr', 'ready', String(pr), '--undo', '-R', REPO]
/** The free-slot queue drop of a PR returned to draft: the queue must not post `@coderabbitai review` on it. `script` is the queue script path. */
export const slotDropArgv = (script: string, pr: number): string[] => ['node', script, 'drop', '--pr', String(pr), '--reason', 'returned-to-draft', '--json']

// M1: the engine's ledger block (the two-call protocol behind checkpoint.ledger). The engine writes the offer and reads the tap.
export type LedgerAsk = { header: string; question: string; options: { label: string; description?: string }[] }
export type LedgerBlock = { state: 'none' | 'ask' | 'record' | 'kept-draft' | 'stop'; ask: LedgerAsk | null; pathway: string | null; reasked: number; text: string; note?: string | null }
const LEDGER_STATES = ['none', 'ask', 'record', 'kept-draft', 'stop']

const ledgerAskOf = (value: unknown): LedgerAsk | null => {
  if (!isObject(value) || typeof value.header !== 'string' || typeof value.question !== 'string' || !Array.isArray(value.options)) return null
  const options = value.options.filter((one): one is { label: string; description?: string } => isObject(one) && typeof one.label === 'string')
  return options.length >= 2 && options.length === value.options.length ? { header: value.header, question: value.question, options } : null
}

/** The `ledger` block of the engine's --json output, or null when it is absent or unreadable (the flag is off, or an old engine). */
export const ledgerOf = (value: unknown): LedgerBlock | null => {
  if (!isObject(value) || typeof value.state !== 'string' || !LEDGER_STATES.includes(value.state)) return null
  return {
    state: value.state as LedgerBlock['state'],
    ask: ledgerAskOf(value.ask),
    pathway: typeof value.pathway === 'string' ? value.pathway : null,
    reasked: typeof value.reasked === 'number' ? value.reasked : 0,
    text: typeof value.text === 'string' ? value.text : '',
    note: typeof value.note === 'string' && value.note !== '' ? value.note : null,
  }
}

/** The tool text of call 1: the question for the model to ask, word for word. A re-ask says so. The model never records. */
export const ledgerAskText = (ledger: LedgerBlock & { ask: LedgerAsk }): string =>
  [
    ...(ledger.note ? [`Tell Dave first: ${ledger.note}`] : []),
    'Ask Dave now with AskUserQuestion. Pass this question word for word and change nothing. Keep the options in the order given: the first option never spends money.',
    JSON.stringify(ledger.ask),
    ...(ledger.reasked > 0 ? [`Dave's last answer matched no option. This is re-ask ${ledger.reasked} of ${MAX_REASKS}.`] : []),
    'Then call pr_checkpoint again with the same pr and body. Never record, label or mark the PR ready yourself.',
  ].join('\n')

/** The text of a typed /pathway while the ledger is on: only a tap on the question the model asks records, so the model is told to ask it. */
export const ledgerCommandText = (pr: number): string => `PR #${pr}: the review question is a tap. The session asks it now. Nothing was recorded.`
export const ledgerCommandNote = (pr: number): string =>
  `Dave asked for the review question on #${pr}. Call pr_checkpoint with pr ${pr} and the body file, then pass the question it returns to AskUserQuestion. Do not record anything yourself.`

/** Why a headless run, a plugin or the bridge only shows the plan. No text tells Dave to type. */
export const whyTextOnly = (via: string | null, waiting: number | null): string => {
  if (via === null) return `This session is headless, so a review request only shows the plan. An interactive session calls pr_checkpoint to ask Dave.`
  const where = `This request came from ${via}, not Dave's terminal composer, so it only shows the plan. A pick records from Dave's tap on the question pr_checkpoint asks.`
  if (via !== 'bridge') return where
  return `${where} From the bridge, a request records only the PR whose checkpoint waits in this session (${waiting === null ? 'none waits now' : `#${waiting}`}).`
}
export const BUSY_TEXT = 'A checkpoint question is open. Wait for Dave. Nothing was asked and nothing was recorded.'
export const noQuestionText = (pr: number, why: string | undefined): string =>
  `${(why ?? 'No pathway is open for #' + pr).replace(/[.\s]+$/, '')}. Nothing recorded. The PR stays a draft.`
export const SUBAGENT_WHY = `A subagent may not raise Dave's question. Only the main session calls pr_checkpoint.`

// ---- the questions of the watcher -----------------------------------------------------------------------------------------------

export type AskChoice = { label: string; answer: 'yes' | 'no' }
export type AskSpec = { header: string; question: string; choices: AskChoice[] }

/**
 * The order of an ask's two labels. The first is the recommendation, and it is the free one: every ask here can spend (an opening review, a
 * round, Greptile), so No is first and a Yes is a tap on the second row (Dave 2026-11-06). The opening ask used to put Yes first.
 */
export const askOrder = (_kind: CheckpointAsk['kind']): ['no', 'yes'] => ['no', 'yes']

const askLabel = (kind: CheckpointAsk['kind'], answer: 'yes' | 'no', files: number | null): string => {
  if (kind === 'greptile') return answer === 'yes' ? `Yes, ask Greptile (${GREPTILE_CREDITS} credits)` : 'No, skip Greptile ($0)'
  if (kind === 'opening') return answer === 'yes' ? `Yes, post the review (free slot $0, or ${upTo(files)})` : 'No, do not post ($0)'
  return answer === 'yes' ? `Yes, one more review (free slot $0, or ${upTo(files)})` : 'No, stay in budget ($0)'
}

/** One watcher ask as a dialog. `files` is the changed-file count of the checkpoint record, or null when the record has none. */
export const askSpec = (ask: CheckpointAsk, files: number | null): AskSpec => {
  const choices = askOrder(ask.kind).map((answer, i) => ({ answer, label: `${askLabel(ask.kind, answer, files)}${i === 0 ? RECOMMENDED : ''}` }))
  const cost = ask.kind === 'greptile' ? 'A Greptile pass costs 3 credits.' : `A review in the free slot costs $0. A paid round costs ${upTo(files)}.`
  return { header: clip(`PR #${ask.pr}`, 12), question: `${ask.text}\n${cost}`, choices }
}

/** The ask's answer for an exact label of the spec, else null. */
export const answerOfLabel = (spec: AskSpec, answer: unknown): 'yes' | 'no' | null =>
  typeof answer === 'string' ? (spec.choices.find(one => one.label === answer)?.answer ?? null) : null

/** The Retry dialog after --apply refused. */
export const RETRY_LABELS = ['Retry', 'Leave as draft'] as const

/**
 * A paid pathway: coderabbit or both. A typed paid word has no label with a price, so it raises the one question (Dave sees the price, his tap
 * on the paid row is the yes). A mis-tap spent money once (PRs 315 and 316), which is why a paid row is never row 0.
 */
export const isPaidPathway = (pathway: string): boolean => pathway === 'coderabbit' || pathway === 'both'

/** A watcher ask Dave closed three ways: the quiet time before it may come back, and how often it comes back at all. */
export const ASK_DEFER_MS = 30 * 60_000
export const ASK_MAX_DISMISSED = 2
/** The lease of one PR's question: one watching session asks. A holder that stops renewing lapses after this long. */
export const ASK_LEASE_MS = 10 * 60_000

/** What the model reads after Dave answers the checkpoint question. */
export const pressNotice = (a: { pr: number; pathway: string; label: string | null; budget: [number, number]; by: string }): string =>
  `PR checkpoint: Dave chose ${a.pathway} for #${a.pr} (${a.label ?? 'no label'}, ${costText(a.budget)}, by ${a.by}). The mod added the label and marked the PR ready. pr_watch continues. Do not merge.`

/** The toast for an auto-confirm: names the band and that nobody pressed. */
export const autoToast = (a: { pr: number; band: string | null }): string =>
  `PR #${a.pr}: band ${a.band ?? 'unknown'}, none auto-confirmed (no bot review). The PR is ready.`

/** What the model reads after an auto-confirm. It was not Dave's press, so it must not say so. */
export const autoNotice = (a: { pr: number; band: string | null; label: string | null; budget: [number, number] }): string =>
  `PR checkpoint: none was auto-confirmed for #${a.pr} (band ${a.band ?? 'unknown'}, ${a.label ?? 'no label'}, ${costText(a.budget)}, by auto). No one pressed. The mod added the label and marked the PR ready. pr_watch continues. Do not merge.`

export const isStalePending = (value: unknown, now: number): boolean => {
  const at = (value as { at?: unknown } | null | undefined)?.at
  return typeof at === 'number' && now - at > PENDING_STALE_MS
}

// ---- the lock ---------------------------------------------------------------------------------------------------------------

export const SHAPES_CLI_REL = '.claude/hooks/dist/checkpoint-shapes-cli.mjs'
export const SHAPES_TIMEOUT_MS = 10_000
export const CONFIG_REL = 'review-router.config.json'
export const PATHWAY_DENY = "pathway.json is written only by the mod, after Dave answers the checkpoint question. A tool or a shell command may not name it. Read it with the Read tool."
export const STORE_DENY = "The plugin store file holds the checkpoint records that the land gate reads. Only the mod writes it. A tool or a shell command may not name it. Call pr_checkpoint to record a pick."
export const LOCK_FAILED = 'pr-checkpoint lock failed; nothing ran'

/** Resolves `.` and `..`, turns backslashes into slashes and lower-cases: the spellings of one path compare equal. */
export const normalizePath = (path: string): string => {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** A tool write (file_path or notebook_path) that lands on a pre-pr pathway.json in any checkout. */
export const isPathwayFile = (path: string): boolean => `/${normalizePath(path)}`.endsWith('/.claude/cache/pre-pr/pathway.json')

/** A tool write (file_path or notebook_path) that lands on a ccv3-mods plugin store file, or its temp or lock copy, in any home. */
export const isStoreFile = (path: string): boolean => /\/plugins\/store\/ccv3-mods_[^/]*$/.test(`/${normalizePath(path)}`)

/**
 * Text that names a ccv3-mods store file: its name (`ccv3-mods_x.json`, `ccv3-mods_*`), or the plugin store folder followed by that name or a glob.
 * `rg "plugins/store"`, another plugin's store file and a bare folder listing do not match. Tested on text with quotes and carets stripped.
 */
const STORE_NAME_LIKE = /ccv3-mods[_*?[]|plugins[\\/]+(?:\.[\\/]+)*store[\\/]+(?:\.[\\/]+)*(?:ccv3|c\*|[*?[])/i
const STORE_NAME_ALL = new RegExp(STORE_NAME_LIKE.source, 'gi')
/** land-none-check.mjs only reads the store, so a run of it that names a store file (--store) is open. */
const LAND_CHECK_RUN = /^node(?:\.exe)?\s{1,10}\S{0,300}land-none-check\.mjs(?:\s|$)/i

/** A segment that names a store file is open only as a read: cat, Get-Content, rg, ls and the like, a git commit or log, or a run of land-none-check.mjs. */
const readsStore = (segment: string): boolean => {
  if (readsStateFile(segment)) return true
  const text = segment.trim().replace(ENV_PREFIX, '')
  return LAND_CHECK_RUN.test(text) && !REDIRECT.test(segment) && !SLOT_CODE_LOADER.test(segment)
}

/**
 * Shell text that could write, move, delete or build a ccv3-mods store file. The land gate (land-none-check.mjs) trusts the `via` of the record in
 * that file, so the file is the mod's alone. An allow list on raw text, no lexer: the text splits on `; & | newline`, a backtick and `$(`, and every
 * piece that names a store file must be a pure read (the same test as the queue state file). A write verb, a redirect, `node -e`, `cp`, `mv`, `rm`,
 * `tee` and `Set-Content` deny. A doubt reads as a deny. A commit message that holds `;` or `>` next to the name is denied too.
 * Not covered, accepted: a path built in code or by a glob that never names `ccv3-mods`, and an `ls` of the folder (it is a read).
 */
export const namesStore = (command: string): boolean => {
  const bare = (text: string) => text.replace(/['"`^]/g, '')
  if (!STORE_NAME_LIKE.test(bare(command))) return false
  const count = (text: string) => (bare(text).match(STORE_NAME_ALL) ?? []).length
  const pieces = command.split(SLOT_SEPARATORS)
  // A name split across pieces (a PowerShell backtick escape) is lost from the pieces: fewer piece hits than whole-text hits denies,
  // even when another piece is a permitted read.
  if (pieces.reduce((n, segment) => n + count(segment), 0) < count(command)) return true
  return pieces.some(segment => STORE_NAME_LIKE.test(bare(segment)) && !readsStore(segment))
}

/** Shell text that names the file, in any form and any case: denied with no lexer, so a doubt reads as a deny. */
export const namesPathway = (command: string): boolean => /pre-pr[\\/]+(?:\.[\\/]+)*pathway\.json/i.test(command)

/**
 * Text that could be the queue state file or one of its siblings (.lock, .tmp-*), in the literal or in a glob form: `coderabbit-slot.json`,
 * `coderabbit-slot.*`, `coderabbit-sl*`, `coderabbit-s?ot.json`, `coderabbit-*`, `coderabbit-slot.{json,lock}`, `[c]oderabbit-slot.json`,
 * `?oderabbit-slot.json`, `*slot.json`. Tested on text with quotes and escapes stripped. Not a `g` regex: `.test()` keeps no state.
 * A glob must sit right after `coderabbit-` or after `coderabbit-s`, so the other `coderabbit-*` files (the paid ledger, the guard runs) stay open.
 * A glob anywhere in a `.claude/state` path (`~/.claude/state/*.json`, `.claude\state\*`) and the `.claude/state` folder itself also count:
 * they can delete or replace the file. The text is tested with backslashes stripped, so the separator is optional.
 */
const SLOT_STATE_LIKE = /coderabbit-slot\.json|coderabbit[-_]{0,2}(?:s[\w.-]{0,30})?[*?[{]|[*?[{][\w.*?[\]{},-]{0,30}(?:rabbit[-_]{1,2}s|slot[.*?[{])|\.claude[\\/]{0,2}state(?:[\\/]{0,2}[\w.*?[\]{},-]{0,60}[*?[{]|[\\/]{0,2}(?=\s|$))/i
/** A redirect: a read command with one writes the file it names. */
const REDIRECT = />/
/** git verbs that delete, move or restore a file; the other git commands only read or commit. */
const GIT_WRITES_FILES = /^git(?:\.exe)?\s[^\n]{0,400}?\b(?:mv|rm|restore)\b/i
/** A command longer than this that names the queue module is denied unread: every pattern below is also bounded, and this bounds the number of segments. */
const SLOT_MAX_NAMING_LENGTH = 20_000
/**
 * Text that could be the queue module under a quote, caret, backtick or backslash split, or a glob: `slot-q...`, `slot-*`, `queue.m...`, `*queue`, `sl*-queue`.
 * Quotes and escapes are stripped first. Any split of `slot-queue.mjs` by a separator or a `$()` leaves a piece that still matches (`slot-q` on the left or `queue.m` on the right).
 * Glob cover is partial, accepted: a glob that keeps none of `slot-q`, `slot-*`, `queue.m` or `*queue` (for example `sl*e.mjs`) is not seen. A rule that denied every
 * node run with a glob in the script path would also block `node --test` with a test glob, which this repo uses daily (paid guard design rev 5, Known limits).
 */
const SLOT_NAME_LIKE = /slot[-_]{0,2}[q*?[]|queue(?:-model)?\.m|[*?[][\w.*?[\]-]{0,30}queue/gi
/** The module as a clean token whose next argument is exactly tick, list or probe (quotes may wrap the verb). Raw text, no stripping. */
const SLOT_MODULE_THEN_READ_VERB = /slot-queue(?:-model)?\.mjs(?=["']?\s{1,20}["']?(?:tick|list|probe)["']?(?:\s|$|[;&|]))/gi
/** Code that loads a module: node -e or -p (also -pe), --eval, --print, --input-type, a stdin script, import(), require(), import ... from, main(. Bounded. */
const SLOT_CODE_LOADER = /\bimport\s{0,10}\(|\brequire\s{0,10}\(|\bimport\b[^\n]{0,400}\bfrom\b|\bmain\s{0,10}\(|--input-type|--eval\b|--print\b|\bnode(?:\.exe)?\s{1,10}(?:[^\n;|&]{0,200}\s)?-[a-z]{0,10}[ep]\b|\bnode(?:\.exe)?\s{1,10}-(?:\s|$)/i
/** Forms that run text built apart from the command line: a pipe into xargs, iex, an encoded command, cmd /c. */
const SLOT_OPAQUE = /\bxargs\b|\biex\b|\bInvoke-Expression\b|(?:^|\s)-enc(?:odedcommand)?(?=\s|$)|\bcmd(?:\.exe)?\s{1,10}\/[ck]\b/i
/** A command separator, a backtick or the start of a command substitution: each piece is judged alone. A paren alone is not a separator (a commit title holds one). */
const SLOT_SEPARATORS = /[;&|\n\r`]|\$\(/

const ENV_PREFIX = /^(?:\w{1,60}=\S{0,200}\s{1,10}){0,5}/
const GIT_READ_OR_COMMIT = /^git(?:\.exe)?(?:\s{1,10}-C\s{1,10}(?:"[^"]{1,300}"|'[^']{1,300}'|\S{1,300}))?\s{1,10}(?:add|commit|log|diff|show|status|grep|blame|ls-files|rev-parse|rev-list|cat-file|check-ignore|restore|mv|rm)\b/i
/** git options that run other code: -c (an alias with `!`), --exec, an external diff or textconv, a pager for grep. */
const GIT_RUNS_CODE = /(?:^|\s)-c(?:\s|=)|--config|--exec\b|--ext-diff|--textconv|--open-files-in-pager|\s-O\S/
const SEARCH_OR_READ = /^(?:grep|egrep|fgrep|rg|Select-String|sls|Get-Content|gc|cat|type|ls|dir|Get-ChildItem|gci)(?:\.exe)?\s/i
/** rg runs a command on each file with --pre. */
const SEARCH_RUNS_CODE = /--pre\b|--pre-glob\b|--hostname-bin\b/
const NODE_TEST_OR_CHECK = /^node(?:\.exe)?\s{1,10}(?:--[a-z-]{1,30}(?:=\S{1,100})?\s{1,10}){0,6}--(?:test|check)\b/i
const NODE_LOADS_CODE = /(?:^|\s)(?:-[a-z]{0,10}[ep]|-r|--(?:eval|print|require|import|loader|experimental-loader|input-type))(?=\s|=|$)/

export const SLOT_DENY = "The free-slot queue file and its write verbs (add, decide, drop) belong to Dave's /slot command and the mod. A tool or a shell command may not name them. Read the queue with the Read or Grep tool, or run slot-queue.mjs tick, list or probe. A commit message that names slot-queue.mjs: write it to a file and run `git commit -F <file>`."

/** A tool write (file_path or notebook_path) that lands on the free-slot queue file, or its temp copy, in any checkout or home. */
export const isSlotStateFile = (path: string): boolean => /\/\.claude\/state\/coderabbit-slot\.json(?:\.tmp-[^/]*|\.lock)?$/.test(`/${normalizePath(path)}`)

const count = (re: RegExp, text: string): number => text.match(re)?.length ?? 0

/**
 * A segment that is only a git, search, read or `node --test|--check` command. It runs no queue verb, whatever text it holds.
 * A paren or a brace is never inert: in PowerShell `git commit -m (node <module> drop)` and `Get-Content (...)` run the code inside. Only a segment that names
 * the module or the state file reaches this test, so a commit title with a paren now needs `git commit -F <file>` (the deny text says so).
 */
const isInertSegment = (segment: string): boolean => {
  if (/[({]/.test(segment)) return false
  const text = segment.trim().replace(ENV_PREFIX, '')
  if (GIT_READ_OR_COMMIT.test(text)) return !GIT_RUNS_CODE.test(text)
  if (SEARCH_OR_READ.test(text)) return !SEARCH_RUNS_CODE.test(text)
  if (NODE_TEST_OR_CHECK.test(text)) return !NODE_LOADS_CODE.test(text)
  return false
}

/** The path token in front of a match: a `$` or `%` in it means a variable builds the path; a `=` means an assignment holds it. */
const buildsPath = (segment: string, at: number): boolean => /[$%=]/.test(segment.slice(Math.max(0, at - 200), at).split(/\s/).pop() ?? '')

/** A segment that names the module is open only when every mention is the clean module followed by tick, list or probe. */
const readsOnly = (segment: string, loose: string): boolean => {
  const clean = [...segment.matchAll(SLOT_MODULE_THEN_READ_VERB)]
  return clean.length === count(SLOT_NAME_LIKE, loose) && !SLOT_CODE_LOADER.test(segment) && !clean.some(m => buildsPath(segment, m.index ?? 0))
}

/** A segment that names the state file is open only as a read: an inert command with no redirect, and no git verb that deletes, moves or restores. */
const readsStateFile = (segment: string): boolean => {
  const text = segment.trim().replace(ENV_PREFIX, '')
  return isInertSegment(segment) && !REDIRECT.test(segment) && !GIT_WRITES_FILES.test(text)
}

/**
 * Shell text that names the queue file, or names the queue module in a way that is not a plain read. An allow list on raw text, no lexer.
 * The text splits on `; & | newline`, a backtick and `$(`; every piece that names the module or the state file (quotes and escapes stripped,
 * globs counted, the file in any glob form) must be
 * (a) a git, grep, rg, Select-String, Get-Content or cat command, or `node --test` or `--check`, with no option that runs other code. A piece
 *     that names the state file must also hold no `>` and no git mv, rm or restore, so `cat x > coderabbit-sl*` and `rm coderabbit-slot.*` deny; or
 * (b) a piece where every mention is the module as a clean token followed by exactly tick, list or probe, with no variable in the path.
 *     A piece that names the state file is never (b).
 * Any (b) piece also denies the whole command when it holds xargs, iex, Invoke-Expression, -EncodedCommand or cmd /c.
 * A long command that names the module is denied unread. A doubt reads as a deny.
 * Not covered, accepted: an -EncodedCommand payload that names nothing, a helper script written to disk that imports `main`, and a path built by
 * concatenation with no `$` or `%` and no module name in the text.
 */
export const namesSlotWrite = (command: string): boolean => {
  const wholeLoose = command.replace(/['"`^\\]/g, '')
  if (count(SLOT_NAME_LIKE, wholeLoose) === 0 && !SLOT_STATE_LIKE.test(wholeLoose)) return false
  if (command.length > SLOT_MAX_NAMING_LENGTH) return true
  let opaque = false
  for (const segment of command.split(SLOT_SEPARATORS)) {
    const loose = segment.replace(/['"`^\\]/g, '')
    const state = SLOT_STATE_LIKE.test(loose)
    if (count(SLOT_NAME_LIKE, loose) === 0 && !state) continue
    if (state) {
      if (!readsStateFile(segment)) return true
      continue
    }
    if (isInertSegment(segment)) continue
    if (!readsOnly(segment, loose)) return true
    opaque = true
  }
  return opaque && SLOT_OPAQUE.test(command)
}

/** The gh write shapes: a comment, a pr or issue edit or create with a body, and an api call that is a POST, PATCH or PUT, sets a body field, runs a GraphQL mutation or sends --input. */
const GH = String.raw`\bgh(?:\.exe)?\s+`
const GH_WRITE_SHAPES: RegExp[] = [
  new RegExp(`${GH}(?:pr|issue)\\s+comment\\b`, 'i'),
  new RegExp(`${GH}(?:pr|issue)\\s+(?:edit|create)\\b[\\s\\S]*(?:--body\\b|--body-file\\b|\\s-[bF][\\s=])`, 'i'),
  new RegExp(`${GH}api\\b[\\s\\S]*(?:(?:-X|--method)[\\s=]*['"]?(?:POST|PATCH|PUT)\\b|(?:-[fF]|--field|--raw-field)[\\s=]*['"]?body=)`, 'i'),
  // A GraphQL mutation (addComment) writes with no body= field. --input is an implicit POST: the body comes from a file or stdin.
  new RegExp(`${GH}api\\b[\\s\\S]*\\bmutation\\b`, 'i'),
  new RegExp(`${GH}api\\b[\\s\\S]*--input\\b`, 'i'),
]

/**
 * Shell text that holds the router's pathway-confirmed marker word in a gh write shape (gh pr or issue comment, gh pr edit or create with a body,
 * gh api with -X POST, PATCH or PUT, a body field, a GraphQL mutation or --input). Only /pathway posts that marker, from node (`$.process.run`, not a shell tool call).
 * Raw text, no lexer: a doubt reads as a deny. A gh read (view, list, api GET) that names the word is not a post and is not touched.
 * Not covered, accepted: a node or PowerShell script, or a body file, that builds the marker apart from this text.
 */
export const namesMarker = (command: string): boolean => /pathway-confirmed/i.test(command) && GH_WRITE_SHAPES.some(shape => shape.test(command))
export const MARKER_DENY = 'The pathway-confirmed comment is posted by /pathway after Dave answers the checkpoint question. A shell command may not post it.'

/** A cheap test on the raw text. A miss spawns nothing; a hit asks the shapes CLI. */
export const mayBeGated = (command: string): boolean =>
  (/pr-checkpoint/i.test(command) && /--(confirm|apply)/i.test(command)) || (/\bgh(\.exe)?\b/i.test(command) && /ready|label|review:|graphql/i.test(command))

export type LockShapes = { ready: boolean; self: boolean; label: { labels: string[]; blind: boolean } | null }

/** The CLI's JSON line, or null when it lacks the keys the lock reads. */
export const parseShapes = (stdout: string): LockShapes | null => {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!isObject(parsed) || typeof parsed.ready !== 'boolean' || typeof parsed.self !== 'boolean') return null
    const label = parsed.label
    if (label === null) return { ready: parsed.ready, self: parsed.self, label: null }
    if (!isObject(label) || !Array.isArray(label.labels) || typeof label.blind !== 'boolean') return null
    return { ready: parsed.ready, self: parsed.self, label: { labels: label.labels.map(String), blind: label.blind } }
  } catch {
    return null
  }
}

export type LockPattern = 'self-confirm' | 'ready' | 'review-label'

/** The label shape that needs a record: a blind add, or one or more review: labels. An empty, sighted list (a read of labels) is none. */
export const labelNeedsRecord = (shapes: LockShapes): boolean => shapes.label !== null && (shapes.label.blind || shapes.label.labels.length > 0)

/** The one PR number a `gh pr edit` command names, or null when it names none, two, or an edit without a number. */
export const editedPr = (command: string): number | null => {
  const found = [...command.matchAll(/\bgh(?:\.exe)?\s+pr\s+edit\b(?:\s+#?(\d+)\b)?/gi)]
  if (found.length === 0 || found.some(one => one[1] === undefined)) return null
  const numbers = new Set(found.map(one => Number(one[1])))
  return numbers.size === 1 ? [...numbers][0]! : null
}

/** The store record that lets one label through: this PR, confirmed or applied, this head, this label. */
export const recordAllowsLabel = (value: unknown, pr: number, head: string, label: string): boolean => {
  if (!isObject(value)) return false
  return value.pr === pr && (value.state === 'confirmed' || value.state === 'applied') && value.head === head && value.label === label
}

export const LOCK_WHY: Record<LockPattern, string> = {
  'self-confirm': "pr-checkpoint --confirm and --apply run only after Dave's answer to the checkpoint question.",
  ready: "Only the checkpoint's --apply marks a PR ready. Call pr_checkpoint and wait for Dave's answer.",
  'review-label': "A review: label is added only by the checkpoint's --apply after Dave's answer. Call pr_checkpoint and wait.",
}

export const lockDeny = (patterns: LockPattern[]): string => `Denied by the PR checkpoint lock (${patterns.join(', ')}). ${patterns.map(one => LOCK_WHY[one]).join(' ')}`

export const lockWarn = (pattern: LockPattern): string => `PR checkpoint lock (warn mode): pattern "${pattern}" would be denied once checkpoint.enforce is true.`
