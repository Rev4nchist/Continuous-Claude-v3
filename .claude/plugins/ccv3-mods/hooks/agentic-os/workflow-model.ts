import type { AgentRun, WorkflowFeed } from '../../types'

// Workflow progress, derived from the agent ledger. Pure: no engine, no clock, no state. The engine gives every workflow agent one
// run id (spawn.workflow.runId, empty outside a real run), so helpers group by `workflowRunId` and by nothing else: a shared
// toolUseId could merge unrelated resumes. The pane counts what the ledger holds and never invents a total. Observer only.
// swarmGroups below is the one grouping the Session and Swarm tabs share, so their counts agree.

export type WorkflowProgress = { key: string; done: number; failed: number; running: number; startedAt: number; latestAt: number }

export type { WorkflowFeed }

const endOf = (run: AgentRun): number => run.endedAt ?? run.startedAt

/** One entry per workflow run id, newest first by the latest end (a running helper counts from its start). Runs with no run id are plain helpers. */
export const workflowProgress = (runs: readonly AgentRun[]): WorkflowProgress[] => {
  const groups = new Map<string, WorkflowProgress>()
  for (const run of runs) {
    const key = run.workflowRunId
    if (typeof key !== 'string' || key === '') continue
    const found = groups.get(key) ?? { key, done: 0, failed: 0, running: 0, startedAt: run.startedAt, latestAt: endOf(run) }
    if (run.status === 'done') found.done += 1
    else if (run.status === 'failed') found.failed += 1
    else if (run.status === 'running') found.running += 1
    found.startedAt = Math.min(found.startedAt, run.startedAt)
    found.latestAt = Math.max(found.latestAt, endOf(run))
    groups.set(key, found)
  }
  return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || b.startedAt - a.startedAt || a.key.localeCompare(b.key))
}

/** One workflow run and the ledger runs behind it, in the order the Swarm tab draws them. */
export type SwarmFlow = { progress: WorkflowProgress; runs: AgentRun[] }

const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Running first, then failed, then done; any other status last. */
const rankOf = (run: AgentRun): number => (run.status === 'running' ? 0 : run.status === 'failed' ? 1 : run.status === 'done' ? 2 : 3)

/** Running (oldest start first), then failed and done (newest end first), then any other status (oldest start first). A tie falls to the id. */
const byAgent = (a: AgentRun, b: AgentRun): number => {
  const rank = rankOf(a) - rankOf(b)
  if (rank !== 0) return rank
  const order = rankOf(a) === 1 || rankOf(a) === 2 ? time(endOf(b)) - time(endOf(a)) : time(a.startedAt) - time(b.startedAt)
  return order || String(a.id).localeCompare(String(b.id))
}

/**
 * The runs per workflow run id (the key rule of workflowProgress) and the runs with no id. A workflow with a running helper comes first,
 * then the rest newest first; inside each list the runs follow byAgent. Only a run makes a flow: there is no input for a workflow
 * the ledger does not hold. The input is not changed.
 */
export const swarmGroups = (runs: readonly AgentRun[]): { flows: SwarmFlow[]; helpers: AgentRun[] } => {
  const perKey = new Map<string, AgentRun[]>()
  const helpers: AgentRun[] = []
  for (const run of runs) {
    const key = run.workflowRunId
    if (typeof key !== 'string' || key === '') helpers.push(run)
    else if (perKey.has(key)) perKey.get(key)?.push(run)
    else perKey.set(key, [run])
  }
  const flows = workflowProgress(runs).map(progress => ({ progress, runs: (perKey.get(progress.key) ?? []).sort(byAgent) }))
  // The sort is stable: the running flows keep the newest-first order of workflowProgress, and so do the finished ones.
  flows.sort((a, b) => Number(b.progress.running > 0) - Number(a.progress.running > 0))
  return { flows, helpers: helpers.sort(byAgent) }
}
