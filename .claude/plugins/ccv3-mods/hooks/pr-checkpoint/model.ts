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
export const NEED_PR = 'Call pr_checkpoint first, or pass <pr> --body <file>.'
const PATHWAY_WORDS = ['accept', 'coderabbit', 'both', 'none', 'wait']

export type CheckpointArgs = { pr: number | null; word: string | null; body: string | null }

/** `7`, `#7`, a pathway word and `--body <file>`, in any order. Anything else is a usage error (null). */
export const parseCheckpointArgs = (args: string): CheckpointArgs | null => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  let pr: number | null = null
  let word: string | null = null
  let body: string | null = null
  for (let i = 0; i < words.length; i += 1) {
    const one = words[i]!
    if (one === '--body') {
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

export const viewArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'isDraft,headRefOid,headRefName,author,number', '-R', REPO]

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

/** The PR's state and head, read before a late Yes posts a review request. */
export const stateArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'state,headRefOid', '-R', REPO]

export const commentArgv = (pr: number, body: string): string[] => ['gh', 'pr', 'comment', String(pr), '-R', REPO, '--body', body]

/** The last non-empty line of a stream: the engine's refusal is one line. */
export const lastLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? ''

export const firstLine = (text: string): string => text.trim().split(/\r?\n/).find(Boolean) ?? ''

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The engine's auto-confirm answer. Only a boolean true is eligible: an old engine (no block), a string or any other shape is not. */
const autoOf = (value: unknown): CheckpointResult['auto'] => {
  if (!isObject(value) || value.eligible !== true) {
    return { eligible: false, band: isObject(value) && typeof value.band === 'string' ? value.band : null, reason: isObject(value) && typeof value.reason === 'string' ? value.reason : 'The engine gave no auto-confirm answer.' }
  }
  return { eligible: true, band: typeof value.band === 'string' ? value.band : null, reason: typeof value.reason === 'string' ? value.reason : '' }
}

/** The result plus the engine's drift text (`config_drift_why`: null or absent without drift, or from an old engine). */
export type CheckpointResultWithDrift = CheckpointResult & { config_drift_why?: string | null }

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
      size: { files: typeof size.files === 'number' ? size.files : 0, lines: typeof size.lines === 'number' ? size.lines : 0 },
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

/** `12m`, `3h`, `2d`: the age of the pre-PR stamp. Null when the stamp has no readable time. */
export const ageText = (iso: string | null | undefined, now: number): string | null => {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

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
// recommendation is first with " (Recommended)", and a short overview sits in the question. Only an exact match of a label records.

/** The marker the first label carries when it is the recommendation. */
export const RECOMMENDED = ' (Recommended)'
/** A paid CodeRabbit round costs about this much per changed file (pr-review-loop.md "Billing facts"); path_filters are ignored, so it is "up to". */
export const PAID_PER_FILE = 0.25
export const FIGURE = (dollars: number): string => `$${dollars.toFixed(2)}`
/** The cost part of a label for `files` changed files. Unknown files: the per-file price. */
export const upTo = (files: number | null): string => (files === null ? `up to ${FIGURE(PAID_PER_FILE)} per changed file` : `up to ${FIGURE(files * PAID_PER_FILE)}`)

export type PathwayChoice = { label: string; pathway: string; by: 'default' | 'dave' }
export type PathwayAsk = { header: string; question: string; choices: PathwayChoice[] }

const NAMES: Record<string, string> = { none: 'No review, land on CI', coderabbit: 'CodeRabbit review', both: 'CodeRabbit + Greptile', wait: 'Keep as draft' }
const nameOf = (pathway: string): string => NAMES[pathway] ?? pathway

const labelFor = (one: CheckpointOption, files: number): string => {
  if (one.pathway === 'none' || one.pathway === 'wait') return `${nameOf(one.pathway)} ($0)`
  return `${nameOf(one.pathway)} (${files > 0 || one.cost[0] + one.cost[1] > 0 ? upTo(files) : '$0'})`
}

const WAIT_OPTION: CheckpointOption = { pathway: 'wait', label: null, available: true, cost: [0, 0], reason: '' }

/** The overview line: class, size, CLI findings. */
const overview = (pr: number, result: CheckpointResult): string => {
  const severities = result.cli ? Object.entries(result.cli.bySeverity).map(([name, count]) => `${count} ${name}`) : []
  return `PR #${pr} (${result.class}, ${result.size.files} files, ${result.size.lines} lines, CLI ${severities.length ? severities.join(', ') : 'none'}): which review?`
}

/**
 * The checkpoint question, or null when there is nothing to choose: no recommendation (R0), or no open pathway. The labels are 2 to 4:
 * the open pathways (at most 3), one "Keep as draft", and "No review, land on CI" last when the engine offers it and it is not the recommendation. When the recommendation is open it is first, with " (Recommended)", and is the only
 * one a `--by default` may record. When it is held, no label is marked and every pick is `--by dave`.
 */
export const buildPathwayAsk = (pr: number, result: CheckpointResultWithDrift, stampAge: string | null = null): PathwayAsk | null => {
  const { buttons, held, recommendedFirst } = optionsInOrder(result)
  const open = buttons.filter(one => one.pathway !== 'wait')
  if (result.recommended === null || open.length === 0) return null
  const keepFirst = recommendedFirst && buttons[0]?.pathway === 'wait'
  // "No review, land on CI" is the last label at every band, unless it IS the recommendation (a LOW to ELEVATED PR), and then it is first.
  const noneIsRecommended = recommendedFirst && result.recommended === 'none'
  const noReview = noneIsRecommended ? [] : open.filter(one => one.pathway === 'none')
  const paid = open.filter(one => noneIsRecommended || one.pathway !== 'none').slice(0, 3 - noReview.length)
  const ordered = keepFirst ? [WAIT_OPTION, ...paid, ...noReview] : [...paid, WAIT_OPTION, ...noReview]
  const files = result.size.files
  const choices: PathwayChoice[] = ordered.map((one, i) => ({
    label: `${labelFor(one, files)}${recommendedFirst && i === 0 ? RECOMMENDED : ''}`,
    pathway: one.pathway,
    by: recommendedFirst && i === 0 ? 'default' : 'dave',
  }))
  const lines = [overview(pr, result)]
  const why = result.why[0]
  if (recommendedFirst) lines.push(`Recommended: ${nameOf(result.recommended)}${why ? `, because ${why}` : ''}.`)
  else lines.push(`The engine recommends ${result.recommended}, but it is held. Nothing is marked.`)
  const cap = result.capacity
  const crab = typeof cap.count === 'number' ? `CodeRabbit 7d ${cap.count}${cap.band ? ` ${cap.band}` : ''}` : 'CodeRabbit 7d unknown'
  const grep = typeof result.credits.used === 'number' && typeof result.credits.monthly === 'number' ? `Greptile ${result.credits.used} of ${result.credits.monthly}` : 'Greptile credits unknown'
  lines.push(`${crab}. ${grep}.${stampAge ? ` Stamp ${stampAge} old.` : ''}`)
  if (held.length > 0) lines.push(`Held: ${held.map(one => `${nameOf(one.pathway)} (${one.reason})`).join('; ')}.`)
  if (result.config_drift) lines.push(`Warning: ${result.config_drift_why ?? 'branch config differs from main'}`)
  if (cap.warning) lines.push(`Warning: ${cap.warning}.`)
  return { header: clip(`PR #${pr}`, 12), question: lines.join('\n'), choices }
}

/** What Dave's answer maps to: an exact label of the ask, or null (free text, a comma-joined pair, a near miss, nothing). */
export const pathwayOfAnswer = (answer: unknown, ask: PathwayAsk): PathwayChoice | null =>
  typeof answer === 'string' ? (ask.choices.find(one => one.label === answer) ?? null) : null

/** The tool text for each outcome that records nothing. The model reads it; Dave's words reach the model through `otherText`. */
export const keptDraftText = (pr: number): string => `Dave kept #${pr} as a draft. Nothing recorded. Do not ask him again. He answers with ${SLASH}.`
export const closedText = (pr: number): string => `Dave closed the question for #${pr}. Nothing recorded. The PR stays a draft. He can answer later with ${SLASH}.`
export const otherText = (pr: number, text: string): string =>
  `Dave wrote: ${clip(text.replace(/\s+/g, ' '), 400)}. Nothing recorded. The PR stays a draft. Reply to him. He answers with ${SLASH} ${pr} <word>.`
export const emptyText = (pr: number): string => `No valid answer came back for #${pr}. Nothing recorded. The PR stays a draft. Dave answers with ${SLASH}.`
export const movedText = (pr: number, why: string): string =>
  `#${pr} changed while Dave answered (${why}). Nothing recorded. Run pre-pr.mjs at the new head, then call pr_checkpoint again.`
export const BUSY_TEXT = 'A checkpoint question is open. Wait for Dave. Nothing was asked and nothing was recorded.'
export const noQuestionText = (pr: number, why: string | undefined): string =>
  `${(why ?? 'No pathway is open for #' + pr).replace(/[.\s]+$/, '')}. Nothing recorded. The PR stays a draft.`
export const SUBAGENT_WHY = `A subagent may not raise Dave's question. Only the main session calls pr_checkpoint.`

// ---- the questions of the watcher -----------------------------------------------------------------------------------------------

export type AskChoice = { label: string; answer: 'yes' | 'no' }
export type AskSpec = { header: string; question: string; choices: AskChoice[] }

/** The order of an ask's two labels. The first is the recommendation. Rounds and Greptile spend, so No is first; the opening is inside the budget, so Yes is first. */
export const askOrder = (kind: CheckpointAsk['kind']): ['yes' | 'no', 'yes' | 'no'] => (kind === 'opening' ? ['yes', 'no'] : ['no', 'yes'])

const askLabel = (kind: CheckpointAsk['kind'], answer: 'yes' | 'no', files: number | null): string => {
  if (kind === 'greptile') return answer === 'yes' ? 'Yes, ask Greptile (3 credits)' : 'No, skip Greptile ($0)'
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
export const STORE_DENY = "The plugin store file holds the checkpoint records that the land gate reads. Only the mod writes it. A tool or a shell command may not name it. Ask Dave to run /pathway."
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
  if (!STORE_NAME_LIKE.test(command.replace(/['"`^]/g, ''))) return false
  return command.split(SLOT_SEPARATORS).some(segment => STORE_NAME_LIKE.test(segment.replace(/['"`^]/g, '')) && !readsStore(segment))
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

/** A segment that is only a git, search, read or `node --test|--check` command. It runs no queue verb, whatever text it holds. */
const isInertSegment = (segment: string): boolean => {
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
