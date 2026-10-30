import type { KeeperRecord, OsLane, OsPlan, OsTask, PrWatch } from '../../types'
import { clip } from '../agentic-os/model'

/** What the keeper reads: the Agentic OS state of this session. */
export type KeeperView = { plan: OsPlan | null; tasks: OsTask[]; lanes: OsLane[] | null; prs: PrWatch[] }

/** The block stays under this many characters, so it never crowds the summary. */
export const KEEPER_LIMIT = 1500

const INTRO = "Keep this session's working state in the summary, under Pending Tasks and Current Work."
const MAX_LANES = 3
const MAX_PRS = 6

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
 * The text added to a manual compaction's `instructions`: plan, open tasks, lane and watched PRs, then the marker.
 * Null when there is nothing to keep (no plan, no open task, no lane, no watched PR): the compaction is left alone.
 * Finished tasks are not listed; they only count in the marker.
 */
export const compactBlock = (view: KeeperView, sessionId: string, limit: number = KEEPER_LIMIT): string | null => {
  const open = view.tasks.filter(task => task.status !== 'completed')
  // What the person is doing now comes first, so a cut never drops it for work not yet started.
  const ordered = [...open.filter(task => task.status === 'in_progress'), ...open.filter(task => task.status !== 'in_progress')]
  const lanes = (view.lanes ?? []).slice(0, MAX_LANES)
  const prs = view.prs.slice(0, MAX_PRS)
  if (view.plan === null && open.length === 0 && lanes.length === 0 && prs.length === 0) return null

  const counts = openCounts(view.tasks)
  const marker = `Copy this line into the summary word for word: ${keeperMarker(sessionId, counts.open, counts.total)}`
  const head = [
    INTRO,
    ...(view.plan === null ? [] : [`Plan: ${clip(view.plan.title, 120)}${view.plan.file ? ` (${clip(view.plan.file, 120)})` : ''}`]),
  ]
  const tail = [
    ...lanes.map(laneLine),
    ...(prs.length === 0 ? [] : [`Watched PRs: ${prs.map(pr => `#${pr.pr} ${pr.state ?? 'unchecked'}`).join(', ')}`]),
    marker,
  ]
  const tasks: string[] = []
  if (open.length > 0) {
    const title = `Open tasks (${open.length} of ${view.tasks.length}):`
    let used = [...head, title, ...tail].join('\n').length
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
  const block = [...head, ...tasks, ...tail].join('\n')
  // Lanes and PRs alone cannot pass the cap (3 lanes, 6 PRs); a tiny test limit can. The marker always survives.
  return block.length <= limit ? block : [INTRO, marker].join('\n')
}
