import type { CheckpointAsk, CheckpointOption, CheckpointResult } from '../../types'

/** Pure helpers of the PR checkpoint mod. Nothing here takes `$`: a `$` and an atom cannot cross an import (README). */

export const PANE = 'pr-checkpoint'
export const TOOL_NAME = 'pr_checkpoint'
export const REPO = 'Rev4nchist/Continuous-Claude-v3'
export const ENGINE_REL = 'scripts/github/pr-checkpoint.mjs'
export const ENGINE_TIMEOUT_MS = 120_000
export const APPLY_TIMEOUT_MS = 180_000
export const GIT_TIMEOUT_MS = 20_000
export const PENDING_STALE_MS = 7 * 24 * 3_600_000

export const USAGE = 'Usage: /checkpoint [pr] [accept|coderabbit|both|none|wait] [--body <file>]'
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

const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/

/** The body file as the engine reads it: a relative path is the session root's. */
export const resolveBody = (root: string, body: string): string => (ABSOLUTE.test(body) ? body : `${root.replace(/[\\/]+$/, '')}/${body}`)

export const engineArgv = (root: string, ...flags: string[]): string[] => ['node', `${root}/${ENGINE_REL}`, ...flags]

export const viewArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'isDraft,headRefOid,author,number', '-R', REPO]

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

/** The engine's `--json` output, or null when it lacks the fields the pane reads. */
export const parseResult = (stdout: string): CheckpointResult | null => {
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
    }
  } catch {
    return null
  }
}

/**
 * The options Dave can press, the recommended pathway first whatever order the engine lists; and the held ones, which are text.
 * A pathway not in the list is never invented: with no recommendation (R0) nothing is pressable.
 */
export const optionsInOrder = (result: CheckpointResult): { buttons: CheckpointOption[]; held: CheckpointOption[] } => {
  const open = result.options.filter(one => one.available)
  const held = result.options.filter(one => !one.available)
  const first = open.find(one => one.pathway === result.recommended)
  const buttons = first ? [first, ...open.filter(one => one !== first)] : open
  return { buttons: result.recommended === null ? [] : buttons, held }
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
  view: { pr: number; result: CheckpointResult; covers: string[]; stamp: string | null; prHead: string },
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
  if (r.config_drift) rows.push('Warning: branch config differs from main')
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

export const isStalePending = (value: unknown, now: number): boolean => {
  const at = (value as { at?: unknown } | null | undefined)?.at
  return typeof at === 'number' && now - at > PENDING_STALE_MS
}
