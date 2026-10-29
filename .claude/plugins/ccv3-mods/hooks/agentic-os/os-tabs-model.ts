import type { AgentRun, OsBrief, OsProof } from '../../types'
import { redact } from '../shared/redact'
import { CHIP } from './band-model'
import { isAskStale, proofOf } from './brief'
import type { Chip } from './brief'
import { MAX_ITEMS, MIN_ITEMS, digest, fold } from './digest'
import type { Digest, DigestBlock, DigestCommit, DigestCompaction, DigestLane, DigestPr } from './digest'
import { clip, elapsed } from './model'
import type { OsView } from './model'
import { agentRows, bar, gap, head, laneRows, prRows } from './pane-model'
import type { Drift } from './steward'
import type { PaneRow, Span, Tone } from './pane-model'

// The /os pane tabs (PRD 5.3), as plain rows. Pure: no engine, no clock (the caller passes `now`).
//   Overview   chip, goal, the session briefing (NEEDS YOU, HIGHLIGHTS, WATCH; digest.ts, PRD 5.3), stop-at, where, plan bar, counts, now, lane, agents, PRs
//              (no ctx, cost or limits: the status line has them). The steward's `brief stale` reason is one WATCH row, shown once.
//   Plan       the steps: tasks when there are any, else the brief plan (PRD 5.1), each done step proven or UNPROVEN
//   Proof      done-but-unproven steps first, then each proof with its artifact
//   Decisions  the decision log newest first, then the open asks
// Comms, Swarm and Resources are tabs in the strip only: disabled, with a NEXT or LATER tag, never selectable.
// Text gauges only. Observer only. Every drawn string is redacted again at the end (idempotent) and only then cut to the
// width, so a secret in any source cannot reach a row whole or in half.

export type TabId = 'overview' | 'plan' | 'proof' | 'decisions'

export type TabSpec = { id: string; label: string; tag?: 'NEXT' | 'LATER'; enabled: boolean }

/** The strip, in order. Only an `enabled` entry has a TabId and a Button. */
export const TABS: readonly TabSpec[] = [
  { id: 'overview', label: 'Overview', enabled: true },
  { id: 'plan', label: 'Plan', enabled: true },
  { id: 'proof', label: 'Proof', enabled: true },
  { id: 'decisions', label: 'Decisions', enabled: true },
  { id: 'comms', label: 'Comms', tag: 'NEXT', enabled: false },
  { id: 'swarm', label: 'Swarm', tag: 'LATER', enabled: false },
  { id: 'resources', label: 'Resources', tag: 'LATER', enabled: false },
]

const LIVE: readonly string[] = TABS.filter(one => one.enabled).map(one => one.id)

/** The digit that presses a live tab: 1 for Overview. A tab that is not live has none. */
const hotkeyOf = (id: string): string | undefined => (LIVE.includes(id) ? String(LIVE.indexOf(id) + 1) : undefined)

/** True for the four live tabs only: a disabled tab, or anything else, is not a tab id. */
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
  /** When the session last did anything: an ask stays fresh 24 hours from it. */
  activeAt: number | null
  /** The steward's verdict on the brief (steward.ts `drift`). Null, or `ok`, or not given: no row. */
  drift?: Drift | null
  /** The subagent runs of this session (agent-ledger): start and end times for the long-running and finished-run rows of the briefing. */
  agentRuns?: AgentRun[]
  /** Facts the pane state does not hold yet. Each is optional and may be empty: the briefing then has fewer rows, never invented ones. */
  feed?: { commits?: DigestCommit[]; compactions?: DigestCompaction[]; lanes?: DigestLane[]; prs?: DigestPr[] }
}

const sp = (text: string, tone: Tone): Span => ({ text, tone })
const width = (spans: Span[] = []): number => spans.reduce((n, one) => n + one.text.length, 0)

/** Cuts a run of spans to `max` cells, with an ellipsis on the span it cuts. */
const clipSpans = (spans: Span[], max: number): Span[] => {
  const out: Span[] = []
  let room = Math.max(0, max)
  for (const one of spans) {
    if (room <= 0) break
    const text = clip(one.text, room)
    out.push({ ...one, text })
    room -= text.length
  }
  return out
}

// --- Strip ---

const itemSpans = (spec: TabSpec, selected: boolean): Span[] =>
  spec.enabled ? [sp(` ${spec.label} `, selected ? 'chip' : 'todo')] : [sp(` ${spec.label}`, 'track'), sp(` ${spec.tag ?? ''} `, 'dim')]

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

// --- Rows ---

const fitRow = (row: PaneRow, columns: number): PaneRow => {
  const cap = Math.max(1, columns)
  // The right group never takes more than half the row; on a narrow pane it goes, and the left carries the meaning.
  const right = row.right && cap >= 24 ? clipSpans(row.right, Math.floor(cap / 2)) : undefined
  const left = clipSpans(row.left, cap - (right ? width(right) + 1 : 0))
  return { key: row.key, left, ...(right && right.length > 0 ? { right } : {}) }
}

const scrub = (row: PaneRow): PaneRow => ({
  ...row,
  left: row.left.map(one => ({ ...one, text: redact(one.text).text })),
  ...(row.right ? { right: row.right.map(one => ({ ...one, text: redact(one.text).text })) } : {}),
})

const line = (key: string, ...left: Span[]): PaneRow => ({ key, left })

/** A "+N more" row. Each list gives its own `key`: two lists in one tab (decisions and asks) must not share one. */
const more = (key: string, hidden: number): PaneRow => line(key, sp(`  +${hidden} more`, 'dim'))

/** Whole groups of rows (a group is one item) that fit `budget`; what does not fit becomes one "+N more" row. */
const takeGroups = (groups: PaneRow[][], budget: number, moreKey: string): PaneRow[] => {
  if (budget <= 0) return []
  const total = groups.reduce((n, group) => n + group.length, 0)
  if (total <= budget) return groups.flat()
  const out: PaneRow[] = []
  let used = 0
  let shown = 0
  for (const group of groups) {
    if (used + group.length > budget - 1) break
    out.push(...group)
    used += group.length
    shown++
  }
  return [...out, more(moreKey, groups.length - shown)]
}

const ago = (now: number, at: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
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

const stepRow = (step: Step): PaneRow => {
  const unproven = isUnproven(step)
  const mark = unproven ? sp('! ', 'warn') : MARK[step.state]
  const text = sp(step.text, step.state === 'done' ? 'dim' : step.state === 'doing' ? 'active' : step.state === 'blocked' ? 'bad' : 'todo')
  const right = unproven ? [sp('UNPROVEN', 'warn')] : step.proof ? [sp(`proven: ${step.proof.artifact}`, 'done')] : undefined
  return { key: step.key, left: [sp('  ', 'dim'), mark, text], ...(right ? { right } : {}) }
}

// --- Overview ---

const label = (name: string, value: string | null, empty = '-'): PaneRow =>
  line(`ov-${name.trim()}`, sp(`  ${name.padEnd(9)}`, 'dim'), sp(value && value.trim() !== '' ? value : empty, value && value.trim() !== '' ? 'todo' : 'dim'))

// --- Briefing (PR 5) ---

const BRIEF_BLOCKS = ['needs', 'highlights', 'watch'] as const

/** Maps what the pane reads onto the digest inputs. Pure. An ask has no time of its own: it carries the brief's. */
const digestOf = (s: TabState, now: number, columns: number): Digest => {
  const { brief, view } = s
  const at = brief?.updatedAt
  const prs: DigestPr[] = [
    ...view.prs.map(one => ({ pr: one.pr, state: one.state, whenReady: one.whenReady, ...(one.since === undefined ? {} : { at: one.since }) })),
    ...(s.feed?.prs ?? []),
  ]
  return digest(
    brief,
    view.tasks,
    s.drift ?? null,
    prs,
    s.agentRuns ?? [],
    s.feed?.lanes ?? [],
    (brief?.ask ?? []).map(one => ({ kind: one.kind, text: one.text, recommend: one.recommend, source: one.source, at, answered: one.answered })),
    (brief?.decisions ?? []).map(one => ({ text: one.text, by: one.by, at: one.at })),
    (brief?.proofs ?? []).map(one => ({ id: one.id, kind: one.kind, subject: one.subject, artifact: one.artifact, at: one.at })),
    { now, columns, limit: MAX_ITEMS, commits: s.feed?.commits, compactions: s.feed?.compactions },
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

const overview = (s: TabState, now: number, columns: number, rows: number): PaneRow[] => {
  const { view, brief } = s
  const steps = stepsOf(s)
  const done = steps.filter(one => one.state === 'done').length
  const unproven = steps.filter(isUnproven).length
  const asks = brief?.ask ?? []
  const open = asks.filter(one => one.answered !== true).length
  const answered = asks.length - open
  const stale = brief !== null && isAskStale(brief, now, s.activeAt)
  const chip = CHIP[s.chip] ?? CHIP.idle
  const running = view.agents.filter(one => one.status === 'running').length
  const runningText = `${running} agent${running === 1 ? '' : 's'} running`
  const working = view.step || view.turn ? [sp('● ', 'warn'), sp(`working ${elapsed(now - (view.turn ?? view.step)!.startedAt)}`, 'dim')] : running > 0 ? [sp('● ', 'warn'), sp(runningText, 'dim')] : [sp('○ idle', 'dim')]
  const goal = brief?.goal?.trim() ?? ''
  const stop = brief?.stopAt?.trim() ?? ''
  const cap = Math.max(1, Math.floor(rows / 4))

  const chipRow: PaneRow = { key: 'ov-chip', left: [sp(` ${chip.word} `, chip.tone)], right: working }
  const goalRow = line('ov-goal', sp('GOAL ', 'dim'), goal === '' ? sp('not set', 'warn') : sp(goal, 'todo'), ...(goal !== '' && brief?.sources.goal === 'parsed' ? [sp(' [parsed]', 'dim')] : []))
  const stopRow = line('ov-stop', sp('STOP AT ', 'dim'), stop === '' ? sp('not set', 'dim') : sp(stop, 'todo'), ...(stop !== '' && brief?.sources.stopAt === 'parsed' ? [sp(' [parsed]', 'dim')] : []))

  const cells = Math.max(4, Math.min(10, Math.floor(columns / 4)))
  const planRow = line('ov-plan', sp('PLAN ', 'dim'), ...bar(steps.length ? done / steps.length : 0, cells, 'ok'), sp(` ${done}/${steps.length}`, 'todo'))
  const planTitle: PaneRow[] = view.plan
    ? [{ key: 'ov-plan-title', left: [sp('  ◆ ', 'title'), sp(view.plan.title, 'todo')], ...(view.plan.file ? { right: [sp(view.plan.file.split(/[\\/]/).pop() ?? '', 'dim')] } : {}) }]
    : []
  const counts = line(
    'ov-counts',
    sp(`ASK ${open}${stale && open > 0 ? ' stale' : ''}`, open > 0 && !stale ? 'warn' : 'dim'),
    ...(answered > 0 ? [sp(`  ${answered} answered?`, 'dim')] : []),
    sp(`  UNPROVEN ${unproven}`, unproven > 0 ? 'warn' : 'dim'),
  )

  const nowRows: PaneRow[] = [
    head('h-now', 'NOW'),
    view.step
      ? { key: 'now', left: [sp('  ', 'dim'), sp(` ${view.step.tool} `, 'chip'), sp(` ${view.step.label}`, 'active')], right: [sp(elapsed(now - view.step.startedAt), 'dim')] }
      : view.turn
        ? { key: 'now', left: [sp('  ◌ thinking', 'dim')], right: [sp(elapsed(now - view.turn.startedAt), 'dim')] }
        : running > 0
          ? line('now', sp('  ◌ ', 'dim'), sp(runningText, 'active'))
          : line('now', sp('  ○ idle', 'dim')),
  ]

  const lane: PaneRow[] = [head('h-lane', 'LANE'), ...laneRows(view.lanes)]
  const live = view.agents.filter(one => one.status === 'running').length
  const agents: PaneRow[] = view.agents.length ? [head('h-agents', 'AGENTS', [sp(`${live} running`, 'dim')]), ...agentRows(view.agents, cap)] : []
  const prs: PaneRow[] = view.prs.length ? [head('h-prs', 'PRS', [sp(`${view.prs.length} watched`, 'dim')]), ...prRows(view.prs, cap)] : []

  // `rank` is how much a block matters when the pane is short (0 first); `group` is the section a gap goes between.
  // The briefing (NEEDS YOU, HIGHLIGHTS, WATCH) comes straight after the chip and GOAL and outranks the detail rows: it holds the
  // PRs, agents and steps the old sections list. `must` blocks are never traded for a "+N more" row.
  const full = digestOf(s, now, columns)
  const parts = BRIEF_BLOCKS.map(key => full[key])
  const limits = parts.map(() => 1)
  const layout = (): Block[] => [
    { rank: 0, group: 0, must: true, rows: [chipRow] },
    { rank: 1, group: 0, must: true, rows: [goalRow] },
    ...parts.map((one, i) => ({ rank: 2 + i, group: 1 + i, must: true, rows: [one.head, ...fold(one, limits[i] ?? 1).rows] })),
    { rank: 11, group: 4, rows: [stopRow] },
    { rank: 13, group: 4, rows: [label('repo', s.repo)] },
    { rank: 14, group: 4, rows: [label('branch', s.branch)] },
    { rank: 15, group: 4, rows: [label('worktree', s.worktree)] },
    { rank: 5, group: 5, rows: [planRow] },
    { rank: 16, group: 5, rows: planTitle },
    { rank: 6, group: 5, rows: [counts] },
    { rank: 9, group: 6, rows: nowRows },
    { rank: 10, group: 7, rows: lane },
    { rank: 7, group: 8, rows: agents },
    { rank: 8, group: 9, rows: prs },
  ].filter(block => block.rows.length > 0)
  const total = (list: Block[]): number => list.reduce((n, block) => n + block.rows.length, 0)
  // Room: the must rows first (every block at one item), then each block up to MIN_ITEMS, then, when the detail rows fit too, up to MAX_ITEMS.
  const mustRowsAt = (): number => total(layout().filter(block => block.must))
  // Blocks of 2 or more items cost 3 rows each at limit 1: fold them to head plus "+N more" so the three heads fit a short pane.
  if (mustRowsAt() > rows) limits.fill(0)
  // One row stays for the "+N more" of the detail blocks, so they are never dropped without a marker.
  grow(parts, limits, rows - mustRowsAt() - (layout().some(block => !block.must) ? 1 : 0), MIN_ITEMS)
  const bare = total(layout())
  if (bare <= rows) grow(parts, limits, rows - bare, MAX_ITEMS)
  const blocks = layout()
  return fillBlocks(blocks, rows)
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

const plan = (s: TabState, rows: number): PaneRow[] => {
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
  if (steps.length <= room) return [header, ...steps.map(stepRow)]
  // Too long: the finished steps fold into one row, so the running step stays in view; what still does not fit becomes "+N more".
  const finished = steps.filter(one => one.state === 'done')
  const unproven = finished.filter(isUnproven).length
  const fold: PaneRow[] = finished.length > 0 && room > 1
    ? [line('plan-done', sp('  ✓ ', 'done'), sp(`${finished.length} done`, 'done'), ...(unproven > 0 ? [sp(` · ${unproven} UNPROVEN`, 'warn')] : []))]
    : []
  const rest = (fold.length > 0 ? steps.filter(one => one.state !== 'done') : steps).map(one => [stepRow(one)])
  return [header, ...fold, ...takeGroups(rest, room - fold.length, 'more-plan')]
}

// --- Proof ---

const proof = (s: TabState, rows: number): PaneRow[] => {
  const steps = stepsOf(s)
  const unproven = steps.filter(isUnproven)
  const proven = steps.filter(one => one.state === 'done' && one.proof !== null).length
  const proofs = [...(s.brief?.proofs ?? [])].sort((a, b) => b.at - a.at)
  const header: PaneRow = { key: 'h-proof', left: [sp('PROOF', 'head')], right: [sp(`${proven} proven · ${unproven.length} unproven`, 'dim')] }
  if (unproven.length === 0 && proofs.length === 0) return [header, line('proof-none', sp('  no proof yet (nothing is done, or nothing is proven)', 'dim'))]
  const groups: PaneRow[][] = [
    ...unproven.map(one => [{ key: `u-${one.key}`, left: [sp('  ! ', 'warn'), sp(one.text, 'todo')], right: [sp('UNPROVEN', 'warn')] }]),
    ...proofs.map((one, i) => [{ key: `proof-${i}`, left: [sp('  ✓ ', 'done'), sp(one.subject, 'todo')], right: [sp(one.artifact, 'dim')] }]),
  ]
  return [header, ...takeGroups(groups, rows - 1, 'more-proof')]
}

// --- Decisions ---

const decisions = (s: TabState, now: number, rows: number): PaneRow[] => {
  const { brief } = s
  const log = [...(brief?.decisions ?? [])].sort((a, b) => b.at - a.at)
  const asks = brief?.ask ?? []
  const open = asks.filter(one => one.answered !== true).length
  const stale = brief !== null && isAskStale(brief, now, s.activeAt)

  const decisionGroups: PaneRow[][] = log.length
    ? log.map((one, i) => [line(`d-${i}`, sp('  • ', 'dim'), sp(one.text, 'todo')), line(`d-${i}-by`, sp(`    ${one.by} · ${ago(now, one.at)}`, 'dim'))])
    : [[line('d-none', sp('  no decisions yet', 'dim'))]]

  const askGroups: PaneRow[][] = asks.length
    ? asks.map((one, i) => {
        const answeredAsk = one.answered === true
        const fresh = !answeredAsk && !stale
        const mark = answeredAsk ? ' · answered?' : stale ? ' · stale' : ''
        return [
          line(`a-${i}`, sp('  ', 'dim'), sp(one.kind, fresh ? 'warn' : 'dim'), ...(mark ? [sp(mark, 'dim')] : []), sp('  ', 'dim'), sp(one.text, fresh ? 'todo' : 'dim')),
          ...(one.recommend ? [line(`a-${i}-rec`, sp(`    recommend: ${one.recommend}`, 'dim'))] : []),
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
    live === 'plan' ? plan(state, budget) : live === 'proof' ? proof(state, budget) : live === 'decisions' ? decisions(state, now, budget) : overview(state, now, cap, budget)
  return built.slice(0, budget).map(row => fitRow(scrub(row), cap))
}

/** The strip and the body for a pane `columns` wide and `rows` high: together never more than `rows`, the body at least one row when there are two. */
export const osPane = (selected: TabId, state: TabState, now: number, columns: number, rows: number): { strip: TabItem[][]; body: PaneRow[] } => {
  const budget = Math.max(1, Math.floor(rows))
  const strip = tabStrip(selected, columns).slice(0, Math.max(1, budget - 1))
  return { strip, body: tabRows(selected, state, now, columns, budget - strip.length) }
}
