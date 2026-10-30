import type { AgentRun, BoardLane, FileTouch, HudLimit, KeeperRecord, OsBrief, OsProof } from '../../types'
import { CHIP } from './band-model'
import { isAskStale, proofOf } from './brief'
import type { Chip } from './brief'
import { MAX_ITEMS, MIN_ITEMS, digest, fold } from './digest'
import type { Digest, DigestBlock, DigestCommit, DigestLane, DigestPr } from './digest'
import { ago, clipSpans, line, more, scrubFit, takeGroups, width } from './fit-rows'
import { laneOverlap } from './lanes-model'
import type { OsView } from './model'
import { gap } from './pane-model'
import { chipWord } from './plain'
import { sessionTab } from './session-tab'
import type { Drift } from './steward'
import type { PaneRow, Span, Tone } from './pane-model'
import { oneLine, wrapRows } from './text'
import { workTab } from './work-tab'

// The /os pane tabs (PRD 5.3, redesigned 2026-10-29), as plain rows. Pure: no engine, no clock (the caller passes `now`).
//   Overview   the three questions at a glance: chip word, repo and branch; GOAL; NOW; NEEDS YOU, DONE, WATCH (digest.ts); one dim health row.
//              Each briefing item is at most 3 rows and ends `...more -> <tab>` when its home tab holds more.
//   Session    state, now, helpers (the ledger), a timeline of milestones, and the room left (session-tab.ts)
//   Plan       the steps: tasks when there are any, else the brief plan (PRD 5.1), each done step proven or UNPROVEN
//   Work       lanes, other sessions, changes, files, where (work-tab.ts)
//   Proof      done-but-unproven steps first, then each proof with its artifact
//   Decisions  the decision log newest first, then the open asks
// Comms, Swarm and Resources are one dim `later:` footer row, drawn only when the body keeps 3 rows or more.
// Text gauges only. Observer only. Every drawn string is redacted again at the end (idempotent) and only then cut to the
// width, so a secret in any source cannot reach a row whole or in half.

export type TabId = 'overview' | 'session' | 'plan' | 'work' | 'proof' | 'decisions'

export type TabSpec = { id: string; label: string; enabled: boolean }

/** The strip, in order. Every entry has a TabId and a Button. */
export const TABS: readonly TabSpec[] = [
  { id: 'overview', label: 'Overview', enabled: true },
  { id: 'session', label: 'Session', enabled: true },
  { id: 'plan', label: 'Plan', enabled: true },
  { id: 'work', label: 'Work', enabled: true },
  { id: 'proof', label: 'Proof', enabled: true },
  { id: 'decisions', label: 'Decisions', enabled: true },
]

/** The tabs that are not built yet. They show as one dim footer row, never as a strip item. */
export const LATER: readonly string[] = ['Comms', 'Swarm', 'Resources']

const LIVE: readonly string[] = TABS.filter(one => one.enabled).map(one => one.id)

/** The digit that presses a tab: 1 for Overview, 6 for Decisions. */
const hotkeyOf = (id: string): string | undefined => (LIVE.includes(id) ? String(LIVE.indexOf(id) + 1) : undefined)

/** True for the six tabs only: a later tab, or anything else, is not a tab id. */
export const isTabId = (value: unknown): value is TabId => typeof value === 'string' && LIVE.includes(value)

/**
 * One tab in the strip: `spans` are what is drawn; a Button wraps an `enabled` one. The terminal paints that Button as
 * "<hotkey>: <spans>", so `hotkey` (the digit that presses it) is 3 cells the spans do not show.
 */
export type TabItem = { id: string; enabled: boolean; selected: boolean; spans: Span[]; hotkey?: string }

/** What the tabs read. The caller composes it from atoms; nothing here reads state. */
export type TabState = {
  view: OsView
  chip: Chip
  brief: OsBrief | null
  repo: string | null
  branch: string | null
  worktree: string | null
  costUsd: number | null
  /** When the session last did anything: an ask stays fresh 24 hours from it. */
  activeAt: number | null
  /** The steward's verdict on the brief (steward.ts `drift`). Null, or `ok`, or not given: no row. */
  drift?: Drift | null
  /** The subagent runs of this session (agent-ledger): start and end times for the long-running and finished-run rows of the briefing. */
  agentRuns?: AgentRun[]
  /** The manual compactions the compact keeper watched, oldest first (compact-keeper). Not given: no keeper line. */
  compactions?: KeeperRecord[]
  /** Every lane of the lane board at the last good read (`lane.mjs board --json`); null or not given: the board was not read. */
  board?: BoardLane[] | null
  /** When that read happened (epoch ms); the Work tab says "as of <age>". Unknown reads "as of last read". */
  boardAt?: number | null
  /** The files this session touched (touched-files). A peer lane whose scope matches an edited or committed file may overlap. */
  files?: FileTouch[]
  /** Share of input tokens the prompt cache served, 0 to 100; null or not given: unknown. */
  cachePct?: number | null
  /** The 5-hour and weekly allowance (the HUD's limits). */
  limits?: HudLimit[]
  /** Facts the pane state does not hold yet. Each is optional and may be empty: the briefing then has fewer rows, never invented ones. */
  feed?: { commits?: DigestCommit[]; prs?: DigestPr[] }
}

const sp = (text: string, tone: Tone): Span => ({ text, tone })

// --- Strip ---

const itemSpans = (spec: TabSpec, selected: boolean): Span[] => [sp(` ${spec.label} `, selected ? 'chip' : 'todo')]

/**
 * The strip as lines of items, one space between items. A strip wider than `columns` wraps to more lines; an item wider
 * than a line is cut. A live tab counts the "1: " its Button is drawn with. Every tab is in it once. A selection that is
 * not a live tab selects Overview.
 */
export const tabStrip = (selected: TabId, columns: number): TabItem[][] => {
  const cap = Math.max(1, Math.floor(columns))
  const live = isTabId(selected) ? selected : 'overview'
  const lines: TabItem[][] = [[]]
  let used = 0
  for (const spec of TABS) {
    const isSelected = spec.enabled && spec.id === live
    const hotkey = hotkeyOf(spec.id)
    const prefix = hotkey === undefined ? 0 : hotkey.length + 2
    const spans = clipSpans(itemSpans(spec, isSelected), Math.max(1, cap - prefix))
    const item: TabItem = { id: spec.id, enabled: spec.enabled, selected: isSelected, spans, ...(hotkey === undefined ? {} : { hotkey }) }
    const line = lines[lines.length - 1]!
    const own = prefix + width(spans)
    const need = own + (line.length > 0 ? 1 : 0)
    if (line.length > 0 && used + need > cap) {
      lines.push([item])
      used = own
    } else {
      line.push(item)
      used += need
    }
  }
  return lines
}

// --- Steps (Plan, Proof, Overview) ---

type Step = { key: string; id: string; subject: string; text: string; state: 'todo' | 'doing' | 'done' | 'blocked'; proof: OsProof | null }

/** PRD 5.1: the task list when it holds a task, else the brief plan. A step is unproven when it is done and has no proof. */
const stepsOf = (s: TabState): Step[] => {
  const { brief } = s
  const proofs = brief !== null && brief.proofs.length > 0
  if (s.view.tasks.length > 0) {
    return s.view.tasks.map(one => {
      const state = one.status === 'completed' ? 'done' : one.status === 'in_progress' ? 'doing' : 'todo'
      const proof = state === 'done' && proofs ? proofOf(brief, { id: one.id, subject: one.subject, kind: 'task' }) : null
      return { key: `t-${one.id}`, id: one.id, subject: one.subject, text: state === 'doing' ? one.activeForm ?? one.subject : one.subject, state, proof }
    })
  }
  return (brief?.plan ?? []).map(one => {
    const proof = one.status === 'done' && proofs ? proofOf(brief, { id: one.id, subject: one.text, kind: 'plan' }) : null
    return { key: `p-${one.id}`, id: one.id, subject: one.text, text: one.text, state: one.status, proof }
  })
}

const isUnproven = (step: Step): boolean => step.state === 'done' && step.proof === null

const MARK: Record<Step['state'], Span> = {
  todo: sp('○ ', 'dim'),
  doing: sp('▶ ', 'active'),
  done: sp('✓ ', 'done'),
  blocked: sp('■ ', 'bad'),
}

/** The rows an item may take on its home tab: the Overview shows up to the same 3, so the `...more -> <tab>` hint never promises text this tab hides. */
const LINES = 3

/** The right group of a wrapped row: never more than half the pane, so wrapRows keeps it beside the text. Redacted before the cut, so a secret is never left in half. */
const rightOf = (spans: Span[] | undefined, columns: number): { right?: Span[] } =>
  spans === undefined ? {} : { right: clipSpans(spans.map(one => ({ ...one, text: oneLine(one.text) })), Math.floor(columns / 2)) }

const stepRows = (step: Step, columns: number): PaneRow[] => {
  const unproven = isUnproven(step)
  const mark = unproven ? sp('! ', 'warn') : MARK[step.state]
  const tone: Tone = step.state === 'done' ? 'dim' : step.state === 'doing' ? 'active' : step.state === 'blocked' ? 'bad' : 'todo'
  const right = unproven ? [sp('UNPROVEN', 'warn')] : step.proof ? [sp(`proven: ${step.proof.artifact}`, 'done')] : undefined
  return wrapRows(step.key, [sp('  ', 'dim'), mark], step.text, tone, columns, LINES, rightOf(right, columns))
}

// --- Overview ---

// --- Briefing (PR 5) ---

const BRIEF_BLOCKS = ['needs', 'highlights', 'watch'] as const

/**
 * Maps what the pane reads onto the digest inputs. Pure. An ask has no time of its own: it carries the brief's. The peer lanes are the board's
 * lanes that another live session owns, each with the edited or committed files its scope may touch; my own lane, an unowned lane and the
 * lane of a stopped session stay out of WATCH.
 */
const digestOf = (s: TabState, now: number, columns: number, lineCap: 1 | 3): Digest => {
  const { brief, view } = s
  const at = brief?.updatedAt
  const prs: DigestPr[] = [
    ...view.prs.map(one => ({ pr: one.pr, state: one.state, whenReady: one.whenReady, ...(one.since === undefined ? {} : { at: one.since }) })),
    ...(s.feed?.prs ?? []),
  ]
  const peers: DigestLane[] = (s.board ?? [])
    .filter(one => !one.mine && one.owner !== null && one.live !== false)
    .map(one => ({ id: one.id, title: one.title, state: one.state, mine: false, ...(one.note === undefined ? {} : { note: one.note }), overlap: laneOverlap(one.scope, s.files ?? []) }))
  return digest(
    brief,
    view.tasks,
    s.drift ?? null,
    prs,
    s.agentRuns ?? [],
    peers,
    (brief?.ask ?? []).map(one => ({ kind: one.kind, text: one.text, recommend: one.recommend, source: one.source, at, answered: one.answered })),
    (brief?.decisions ?? []).map(one => ({ text: one.text, by: one.by, at: one.at })),
    (brief?.proofs ?? []).map(one => ({ id: one.id, kind: one.kind, subject: one.subject, artifact: one.artifact, at: one.at })),
    { now, columns, limit: MAX_ITEMS, lineCap, commits: s.feed?.commits, compactions: s.compactions },
  )
}

const sizeOf = (one: DigestBlock): number => 1 + one.rows.length

/**
 * Grows each block toward `to` items while `spare` rows last, one item at a time, needs first. A step that costs no row
 * (two items in the room of one item and "+1 more") is always taken. Returns the rows left.
 */
const grow = (full: DigestBlock[], limits: number[], spare: number, to: number): number => {
  let left = spare
  for (let target = 2; target <= to; target++) {
    full.forEach((one, i) => {
      let at = limits[i] ?? 1
      while (at < target && at < one.shown) {
        const cost = sizeOf(fold(one, at + 1)) - sizeOf(fold(one, at))
        if (cost > Math.max(0, left)) break
        at += 1
        left -= cost
      }
      limits[i] = at
    })
  }
  return left
}

/** NOW, in plain words: the in-progress task (its activeForm, else its subject), else Thinking, else the running helpers. Never the tool or its label. */
const nowText = (s: TabState): string => {
  const running = s.view.agents.filter(one => one.status === 'running').length
  const helpers = `${running} ${running === 1 ? 'helper' : 'helpers'} running`
  const doing = s.view.tasks.find(one => one.status === 'in_progress')
  if (doing !== undefined) return `${oneLine(doing.activeForm ?? doing.subject)}${running > 0 ? ` (${helpers})` : ''}`
  if (s.view.turn !== null) return 'Thinking'
  return running > 0 ? helpers : 'nothing in progress'
}

/** One dim row: context, cost and cache. An unknown figure reads `-`; an unknown cache is left out. */
const healthRow = (s: TabState): PaneRow => {
  const ctx = s.view.ctx
  const cost = s.costUsd
  const cache = s.cachePct
  const parts = [
    `ctx ${typeof ctx === 'number' && Number.isFinite(ctx) ? `${Math.round(ctx)}%` : '-'}`,
    typeof cost === 'number' && Number.isFinite(cost) ? `$${cost.toFixed(2)}` : '$-',
    ...(typeof cache === 'number' && Number.isFinite(cache) ? [`cache ${Math.round(cache)}%`] : []),
  ]
  return line('ov-health', sp(parts.join('   '), 'dim'))
}

const overview = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const { brief } = s
  const chip = CHIP[s.chip] ?? CHIP.idle
  const goal = oneLine(brief?.goal)
  const where = [oneLine(s.repo), oneLine(s.branch)].filter(one => one !== '').join(' . ')

  const chipRow: PaneRow = line('ov-chip', sp(` ${chipWord(s.chip)} `, chip.tone), ...(where === '' ? [] : [sp(` ${where}`, 'dim')]))
  const goalRow = line('ov-goal', sp('GOAL ', 'dim'), goal === '' ? sp('not set', 'warn') : sp(goal, 'todo'), ...(goal !== '' && brief?.sources.goal === 'parsed' ? [sp(' [parsed]', 'dim')] : []))
  const nowRow = line('now', sp('NOW ', 'dim'), sp(nowText(s), 'active'))

  // `rank` is how much a block matters when the pane is short (0 first); `group` is the section a gap goes between.
  // The briefing (NEEDS YOU, DONE, WATCH) comes straight after the chip, GOAL and NOW. `must` blocks are never traded for a "+N more" row.
  const roomy = digestOf(s, now, columns, 3)
  let parts = BRIEF_BLOCKS.map(key => roomy[key])
  const limits = parts.map(() => 1)
  const layout = (): Block[] => [
    { rank: 0, group: 0, must: true, rows: [chipRow] },
    { rank: 1, group: 0, must: true, rows: [goalRow] },
    { rank: 9, group: 0, rows: [nowRow] },
    ...parts.map((one, i) => ({ rank: 2 + i, group: 1 + i, must: true, rows: [one.head, ...fold(one, limits[i] ?? 1).rows] })),
    { rank: 12, group: 4, rows: [healthRow(s)] },
  ]
  const total = (list: Block[]): number => list.reduce((n, block) => n + block.rows.length, 0)
  // Room: the must rows first (every block at one item), then each block up to MIN_ITEMS, then, when the detail rows fit too, up to MAX_ITEMS.
  const mustRowsAt = (): number => total(layout().filter(block => block.must))
  // A pane too short for 3-row items draws one row per item first; only then are the blocks folded to heads.
  if (mustRowsAt() > rows) {
    const short = digestOf(s, now, columns, 1)
    parts = BRIEF_BLOCKS.map(key => short[key])
  }
  // Blocks of 2 or more items cost 3 rows each at limit 1: fold them to head plus "+N more" so the three heads fit a short pane.
  if (mustRowsAt() > rows) limits.fill(0)
  // One row stays for the "+N more" of the detail blocks, so they are never dropped without a marker.
  grow(parts, limits, rows - mustRowsAt() - (layout().some(block => !block.must) ? 1 : 0), MIN_ITEMS)
  const bare = total(layout())
  if (bare <= rows) grow(parts, limits, rows - bare, MAX_ITEMS)
  return fillBlocks(layout(), rows)
}

type Block = { rank: number; group: number; rows: PaneRow[]; must?: boolean }

/**
 * Whole blocks, in display order, that fit `budget` rows. All fit: gaps go between the sections when they fit too. Not all
 * fit: blocks go in by rank until the room is spent, one row stays for "+N more" (N blocks left out), so nothing is cut
 * silently. Rank sets who stays; display order is kept.
 */
const fillBlocks = (blocks: Block[], budget: number): PaneRow[] => {
  const bare = blocks.flatMap(block => block.rows)
  const groups = new Set(blocks.map(block => block.group)).size
  if (bare.length + groups - 1 <= budget) {
    return blocks.flatMap((block, i) => (i > 0 && blocks[i - 1]!.group !== block.group ? [gap(`gap-${block.group}`), ...block.rows] : block.rows))
  }
  if (bare.length <= budget) return bare
  if (budget < 2) return blocks.slice(0, 1).flatMap(block => block.rows) // one row: the chip, no room for a marker
  // The briefing fills the pane exactly: it owns the rows, and the detail below it is on the other tabs.
  const musts = blocks.filter(block => block.must)
  if (musts.reduce((n, block) => n + block.rows.length, 0) === budget) return musts.flatMap(block => block.rows)
  let room = budget - 1
  const kept = new Set<Block>()
  for (const block of [...blocks].sort((a, b) => a.rank - b.rank)) {
    if (block.rows.length > room) continue
    kept.add(block)
    room -= block.rows.length
  }
  const shown = blocks.filter(block => kept.has(block)).flatMap(block => block.rows)
  return [...shown, more('more-overview', blocks.length - kept.size)]
}

// --- Plan ---

const plan = (s: TabState, columns: number, rows: number): PaneRow[] => {
  const steps = stepsOf(s)
  const done = steps.filter(one => one.state === 'done').length
  const source = s.view.tasks.length > 0 ? 'tasks' : 'brief plan'
  const header: PaneRow = {
    key: 'h-plan',
    left: [sp('PLAN', 'head'), ...(steps.length ? [sp(`  from ${source}`, 'dim')] : [])],
    ...(steps.length ? { right: [sp(`${done} of ${steps.length} done`, 'dim')] } : {}),
  }
  const room = rows - 1
  if (steps.length === 0) return [header, line('plan-none', sp('  no steps yet (no task list, no brief_set plan)', 'dim'))]
  const groups = steps.map(one => stepRows(one, columns))
  if (groups.reduce((n, group) => n + group.length, 0) <= room) return [header, ...groups.flat()]
  // Too long: the finished steps fold into one row, so the running step stays in view; what still does not fit becomes "+N more".
  const finished = steps.filter(one => one.state === 'done')
  const unproven = finished.filter(isUnproven).length
  const fold: PaneRow[] = finished.length > 0 && room > 1
    ? [line('plan-done', sp('  ✓ ', 'done'), sp(`${finished.length} done`, 'done'), ...(unproven > 0 ? [sp(` · ${unproven} UNPROVEN`, 'warn')] : []))]
    : []
  const rest = (fold.length > 0 ? steps.filter(one => one.state !== 'done') : steps).map(one => stepRows(one, columns))
  return [header, ...fold, ...takeGroups(rest, room - fold.length, 'more-plan')]
}

// --- Proof ---

const proof = (s: TabState, columns: number, rows: number): PaneRow[] => {
  const steps = stepsOf(s)
  const unproven = steps.filter(isUnproven)
  const proven = steps.filter(one => one.state === 'done' && one.proof !== null).length
  const proofs = [...(s.brief?.proofs ?? [])].sort((a, b) => b.at - a.at)
  const header: PaneRow = { key: 'h-proof', left: [sp('PROOF', 'head')], right: [sp(`${proven} proven · ${unproven.length} unproven`, 'dim')] }
  if (unproven.length === 0 && proofs.length === 0) return [header, line('proof-none', sp('  no proof yet (nothing is done, or nothing is proven)', 'dim'))]
  const groups: PaneRow[][] = [
    ...unproven.map(one => wrapRows(`u-${one.key}`, [sp('  ! ', 'warn')], one.text, 'todo', columns, LINES, rightOf([sp('UNPROVEN', 'warn')], columns))),
    ...proofs.map((one, i) => wrapRows(`proof-${i}`, [sp('  ✓ ', 'done')], one.subject, 'todo', columns, LINES, rightOf([sp(one.artifact, 'dim')], columns))),
  ]
  return [header, ...takeGroups(groups, rows - 1, 'more-proof')]
}

// --- Decisions ---

const decisions = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const { brief } = s
  const log = [...(brief?.decisions ?? [])].sort((a, b) => b.at - a.at)
  const asks = brief?.ask ?? []
  const open = asks.filter(one => one.answered !== true).length
  const stale = brief !== null && isAskStale(brief, now, s.activeAt)

  const decisionGroups: PaneRow[][] = log.length
    ? log.map((one, i) => [...wrapRows(`d-${i}`, [sp('  • ', 'dim')], one.text, 'todo', columns, LINES), line(`d-${i}-by`, sp(`    ${one.by} · ${ago(now, one.at)}`, 'dim'))])
    : [[line('d-none', sp('  no decisions yet', 'dim'))]]

  const askGroups: PaneRow[][] = asks.length
    ? asks.map((one, i) => {
        const answeredAsk = one.answered === true
        const fresh = !answeredAsk && !stale
        const mark = answeredAsk ? ' · answered?' : stale ? ' · stale' : ''
        return [
          ...wrapRows(`a-${i}`, [sp('  ', 'dim'), sp(one.kind, fresh ? 'warn' : 'dim'), ...(mark ? [sp(mark, 'dim')] : []), sp('  ', 'dim')], one.text, fresh ? 'todo' : 'dim', columns, LINES),
          ...(one.recommend ? wrapRows(`a-${i}-rec`, [sp('    recommend: ', 'dim')], one.recommend, 'dim', columns, LINES) : []),
        ]
      })
    : [[line('a-none', sp('  nothing open', 'dim'))]]

  const askRight = asks.length ? [sp(`${open} open${stale && open > 0 ? ' · stale' : ''}`, open > 0 && !stale ? 'warn' : 'dim')] : undefined
  const headD: PaneRow = { key: 'h-decisions', left: [sp('DECISIONS', 'head')], ...(log.length ? { right: [sp(`${log.length} recorded`, 'dim')] } : {}) }
  const headA: PaneRow = { key: 'h-asks', left: [sp('OPEN ASKS', 'head')], ...(askRight ? { right: askRight } : {}) }

  const needD = decisionGroups.reduce((n, g) => n + g.length, 0)
  const needA = askGroups.reduce((n, g) => n + g.length, 0)
  const room = rows - 2
  if (needD + needA + 1 <= room) return [headD, ...decisionGroups.flat(), gap('gap-asks'), headA, ...askGroups.flat()]
  // Not everything fits: the asks take what they need up to half the room, the decisions the rest.
  const askShare = Math.min(needA, Math.max(Math.ceil(room / 2), room - needD))
  return [headD, ...takeGroups(decisionGroups, room - askShare, 'more-decisions'), headA, ...takeGroups(askGroups, askShare, 'more-asks')]
}

// --- Entry points ---

/** The rows of one tab, `rows` at most, each inside `columns`. A tab that is not live draws Overview. */
export const tabRows = (tab: TabId, state: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const budget = Math.floor(rows)
  if (!(budget > 0)) return []
  const cap = Math.max(1, Math.floor(columns))
  const live = isTabId(tab) ? tab : 'overview'
  const built =
    live === 'session'
      ? sessionTab(state, now, cap, budget)
      : live === 'work'
        ? workTab(state, now, cap, budget)
        : live === 'plan'
          ? plan(state, cap, budget)
          : live === 'proof'
            ? proof(state, cap, budget)
            : live === 'decisions'
              ? decisions(state, now, cap, budget)
              : overview(state, now, cap, budget)
  return built.slice(0, budget).map(row => scrubFit(row, cap))
}

/** The body keeps at least this many rows or the footer is not drawn: the footer goes first. */
const FOOTER_MIN_BODY = 3

/**
 * The strip, the body and the footer for a pane `columns` wide and `rows` high: together never more than `rows`, the body at least one row when
 * there are two. The footer is one dim row naming the tabs that are not built yet; it is drawn only when the body still keeps 3 rows.
 */
export const osPane = (selected: TabId, state: TabState, now: number, columns: number, rows: number): { strip: TabItem[][]; body: PaneRow[]; footer: PaneRow | null } => {
  const budget = Math.max(1, Math.floor(rows))
  const strip = tabStrip(selected, columns).slice(0, Math.max(1, budget - 1))
  const room = budget - strip.length
  const withFooter = room - 1 >= FOOTER_MIN_BODY
  const footer = withFooter ? scrubFit(line('footer-later', sp(`later: ${LATER.join(' · ')}`, 'dim')), Math.max(1, Math.floor(columns))) : null
  return { strip, body: tabRows(selected, state, now, columns, withFooter ? room - 1 : room), footer }
}
