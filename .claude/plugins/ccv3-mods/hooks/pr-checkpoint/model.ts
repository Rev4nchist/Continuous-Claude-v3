import type { CheckpointAsk, CheckpointOption, CheckpointResult } from '../../types'

/** Pure helpers of the PR checkpoint mod. Nothing here takes `$`: a `$` and an atom cannot cross an import (README). */

export const PANE = 'pr-checkpoint'
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

/** The engine's `--json` output, or null when it lacks the fields the pane reads. */
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

export const optionLabel = (one: CheckpointOption, isFirst: boolean): string =>
  `${one.pathway}${one.label ? ` ${one.label}` : ''}  ${costText(one.cost)}${isFirst ? '  (Recommended)' : ''}`

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

/** Text rows above the buttons. Each is one line; the pane cuts a long row with an ellipsis. */
export const headerRows = (
  view: { pr: number; result: CheckpointResultWithDrift; covers: string[]; stamp: string | null; prHead: string },
  now: number,
): string[] => {
  const r = view.result
  const age = ageText(view.stamp, now)
  const rows = [
    `#${view.pr}  head ${r.head.slice(0, 7)}  stamp ${age ?? 'unknown'}  class ${r.class} (matched ${r.matched})  ${r.size.files} files  ${r.size.lines} lines`,
    ...view.covers,
  ]
  for (const check of r.checks) rows.push(`Check ${check.step}: ${check.status}${check.detail ? ` (${check.detail})` : ''}`)
  const severities = r.cli ? Object.entries(r.cli.bySeverity).map(([name, count]) => `${name} ${count}`) : []
  rows.push(severities.length ? `CLI: ${severities.join(', ')}` : 'CLI: none')
  const cap = r.capacity
  const crab =
    typeof cap.count === 'number'
      ? `CodeRabbit 7d ${cap.count}${cap.source || cap.date ? ` (${[cap.source, cap.date].filter(Boolean).join(' ')})` : ''}${cap.band ? ` ${cap.band}` : ''}`
      : 'CodeRabbit 7d unknown'
  const grep = typeof r.credits.used === 'number' && typeof r.credits.monthly === 'number' ? `Greptile ${r.credits.used} of ${r.credits.monthly}` : 'Greptile credits unknown'
  rows.push(`${crab}  ${grep}`)
  if (r.config_drift) rows.push(`Warning: ${r.config_drift_why ?? 'branch config differs from main'}`)
  if (cap.warning) rows.push(`Warning: ${cap.warning}`)
  return rows
}

export const recommendRows = (result: CheckpointResult): string[] => {
  if (result.recommended === null) return [result.why[0] ?? 'Run pre-pr.mjs: no stamp for this head.']
  return [`Recommended: ${result.recommended}`, ...result.why.slice(0, 4).map(line => `  ${line}`)]
}

/** The order of an ask's two buttons. The first is the recommendation. Rounds and Greptile spend, so No is first; the opening is inside the budget, so Yes is first. */
export const askOrder = (kind: CheckpointAsk['kind']): ['yes' | 'no', 'yes' | 'no'] => (kind === 'opening' ? ['yes', 'no'] : ['no', 'yes'])

export const askButtonLabel = (kind: CheckpointAsk['kind'], answer: 'yes' | 'no'): string => {
  if (answer === 'yes') return kind === 'opening' ? 'Yes: post @coderabbitai review' : kind === 'round' ? 'Yes: spend 1 more' : 'Yes: ask Greptile (3 credits)'
  return kind === 'opening' ? 'No: do not post' : kind === 'round' ? 'No: stay in budget' : 'No: skip Greptile'
}

/** What the model reads after Dave presses an option of the checkpoint. */
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
export const PATHWAY_DENY = "pathway.json is written by Dave's press in the checkpoint pane only. A tool or a shell command may not name it. Read it with the Read tool."
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

/** Shell text that names the file, in any form and any case: denied with no lexer, so a doubt reads as a deny. */
export const namesPathway = (command: string): boolean => /pre-pr[\\/]+(?:\.[\\/]+)*pathway\.json/i.test(command)

/**
 * Text that could be the queue state file or one of its siblings (.lock, .tmp-*), in the literal or in a glob form: `coderabbit-slot.json`,
 * `coderabbit-slot.*`, `coderabbit-sl*`, `coderabbit-s?ot.json`, `coderabbit-*`, `coderabbit-slot.{json,lock}`, `[c]oderabbit-slot.json`,
 * `?oderabbit-slot.json`, `*slot.json`. Tested on text with quotes and escapes stripped. Not a `g` regex: `.test()` keeps no state.
 * A glob must sit right after `coderabbit-` or after `coderabbit-s`, so the other `coderabbit-*` files (the paid ledger, the guard runs) stay open.
 */
const SLOT_STATE_LIKE = /coderabbit-slot\.json|coderabbit[-_]{0,2}(?:s[\w.-]{0,30})?[*?[{]|[*?[{][\w.*?[\]{},-]{0,30}(?:rabbit[-_]{1,2}s|slot[.*?[{])/i
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
const SEARCH_OR_READ = /^(?:grep|egrep|fgrep|rg|Select-String|sls|Get-Content|gc|cat|type)(?:\.exe)?\s/i
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
export const MARKER_DENY = 'The pathway-confirmed comment is posted by /pathway when Dave presses a pathway. A shell command may not post it.'

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
  'self-confirm': "pr-checkpoint --confirm and --apply run only from Dave's press in the checkpoint pane.",
  ready: "Only the checkpoint's --apply marks a PR ready. Call pr_checkpoint and wait for Dave's press.",
  'review-label': "A review: label is added only by the checkpoint's --apply after Dave's press. Call pr_checkpoint and wait.",
}

export const lockDeny = (patterns: LockPattern[]): string => `Denied by the PR checkpoint lock (${patterns.join(', ')}). ${patterns.map(one => LOCK_WHY[one]).join(' ')}`

export const lockWarn = (pattern: LockPattern): string => `PR checkpoint lock (warn mode): pattern "${pattern}" would be denied once checkpoint.enforce is true.`
