import type { KeeperRecord, OsLane, OsPlan, OsTask, PrWatch } from '../../types'
import { clip } from '../agentic-os/model'

/** What the keeper can read cheaply besides the Agentic OS state. Each fact is null when it is not known. */
export type KeeperFacts = { branch: string | null; name: string | null; handoff: string | null }

/** What the keeper reads: the Agentic OS state of this session, and the facts. A view without `facts` has none. */
export type KeeperView = { plan: OsPlan | null; tasks: OsTask[]; lanes: OsLane[] | null; prs: PrWatch[]; facts?: KeeperFacts }

/**
 * The block stays under this many characters, so it never crowds the summary. The fixed part (intro, facts, keep-list,
 * marker) is about 1200 at most; the rest, about 1300, is for the plan, lanes, PRs and open tasks. Only that rest is cut.
 */
export const KEEPER_LIMIT = 2500

/**
 * What the summarizer must keep, as fixed text. Six items, then what to drop. It is never cut: a long plan or task list
 * gives up its own lines first. Plain words, because the summarizer follows them as written.
 */
export const KEEP_LIST = [
  'Keep these items, one line each. Never shorten a path, a hash or a command:',
  '1. Lane id and board key, session label, open plan path, and the next step.',
  '2. Every decision and stated preference from this session, with the reason when one was given.',
  '3. Absolute paths edited or still to edit, the branch, PR numbers, commit hashes.',
  '4. The last failing test or probe: the command, the first error line, the artifact path.',
  '5. The handoff path or Notion row for THIS session, and open tasks with the active one marked.',
  "6. What was run and passed, versus only read. Never turn 'not run' into 'passed'. Name the checks still open.",
  'Drop: tool output already saved to a file, rule and skill text, dead ends, repeated MEMORY MATCH results.',
].join('\n')

const INTRO = "Keep this session's working state in the summary, under Pending Tasks and Current Work."
const MAX_LANES = 3
const MAX_PRS = 6

const sessionLabel = (name: string | null | undefined, sessionId: string): string => {
  const handle = `#${sessionId.slice(0, 8)}`
  return name ? `${clip(name, 60)} ${handle}` : handle
}

/** The facts that are known, one line each. The session line is always there: the id is known. */
const factLines = (facts: KeeperFacts | undefined, sessionId: string): string[] => [
  ...(facts?.branch ? [`Branch: ${clip(facts.branch, 80)}`] : []),
  `Session: ${sessionLabel(facts?.name, sessionId)}`,
  ...(facts?.handoff ? [`Handoff: ${clip(facts.handoff, 200)}`] : []),
]

const laneLine = (lane: OsLane) => `Lane: ${lane.id}: ${clip(lane.title, 80)} (${lane.state})`
const taskLine = (task: OsTask) => `- ${task.status === 'in_progress' ? '[doing] ' : ''}${clip(task.subject, 100)}`

/**
 * The line the summarizer must copy word for word. It carries counts only, so a cut task list never loses it, and
 * a transcript without it shows the keeper did not run (the end-to-end check and the kill review read it).
 */
export const keeperMarker = (sessionId: string, open: number, total: number): string =>
  `KEEPER ${sessionId.slice(0, 8)} open ${open} of ${total}`

/** The open and total task counts the marker carries. compactBlock and the keeper's record both read them here, so they agree. */
export const openCounts = (tasks: readonly OsTask[]): { open: number; total: number } => ({
  open: tasks.filter(task => task.status !== 'completed').length,
  total: tasks.length,
})

/**
 * True when one of `texts` holds the marker line for exactly these counts. A longer count is no match ("of 20" does not
 * match "of 2"), and a later true marker still counts after such a lookalike.
 */
export const markerKept = (texts: readonly string[], sessionId: string, open: number, total: number): boolean => {
  const marker = keeperMarker(sessionId, open, total)
  for (const text of texts) {
    if (typeof text !== 'string') continue
    for (let from = 0; ; ) {
      const at = text.indexOf(marker, from)
      if (at < 0) break
      if (!/\d/.test(text[at + marker.length] ?? '')) return true
      from = at + 1
    }
  }
  return false
}

/** Compactions kept in the record: the newest ones. */
export const MAX_RECORDS = 10

/** The list with `rec` last, cut to the newest `cap`. The list passed in is kept. */
export const addRecord = (list: readonly KeeperRecord[], rec: KeeperRecord, cap: number = MAX_RECORDS): KeeperRecord[] =>
  [...list, rec].slice(-Math.max(1, Math.floor(cap)))

export type { KeeperRecord }

/**
 * The text added to a manual compaction's `instructions`: the plan, open tasks, lanes and watched PRs, then the facts
 * (branch, session label, handoff), the fixed keep-list and the marker. Never null: with nothing in the session the keep-list
 * and the marker still go. Finished tasks are not listed; they only count in the marker.
 * Only the task list is cut to fit `limit` (with a "+N more" line). The keep-list, the facts and the marker are never cut.
 */
export const compactBlock = (view: KeeperView, sessionId: string, limit: number = KEEPER_LIMIT): string => {
  const open = view.tasks.filter(task => task.status !== 'completed')
  // What the person is doing now comes first, so a cut never drops it for work not yet started.
  const ordered = [...open.filter(task => task.status === 'in_progress'), ...open.filter(task => task.status !== 'in_progress')]
  const lanes = (view.lanes ?? []).slice(0, MAX_LANES)
  const prs = view.prs.slice(0, MAX_PRS)

  const counts = openCounts(view.tasks)
  const marker = `Copy this line into the summary word for word: ${keeperMarker(sessionId, counts.open, counts.total)}`
  const fixed = [...factLines(view.facts, sessionId), KEEP_LIST, marker]
  const head = [
    INTRO,
    ...(view.plan === null ? [] : [`Plan: ${clip(view.plan.title, 120)}${view.plan.file ? ` (${clip(view.plan.file, 120)})` : ''}`]),
  ]
  const mid = [
    ...lanes.map(laneLine),
    ...(prs.length === 0 ? [] : [`Watched PRs: ${prs.map(pr => `#${pr.pr} ${pr.state ?? 'unchecked'}`).join(', ')}`]),
  ]
  const tasks: string[] = []
  if (open.length > 0) {
    const title = `Open tasks (${open.length} of ${view.tasks.length}):`
    let used = [...head, title, ...mid, ...fixed].join('\n').length
    const listed: string[] = []
    for (const [i, task] of ordered.entries()) {
      const line = taskLine(task)
      const more = open.length - i - 1
      // Keep room for the "+N more" line unless this is the last task.
      const reserve = more > 0 ? `\n- (+${more} more)`.length : 0
      if (used + 1 + line.length + reserve > limit) break
      listed.push(line)
      used += 1 + line.length
    }
    if (listed.length < open.length) listed.push(`- (+${open.length - listed.length} more)`)
    tasks.push(title, ...listed)
  }
  const block = [...head, ...tasks, ...mid, ...fixed].join('\n')
  // The plan, lanes and PRs alone cannot pass the cap (3 lanes, 6 PRs); a tiny test limit can. The fixed part always survives.
  return block.length <= limit ? block : [INTRO, ...fixed].join('\n')
}
