import type { AgentRun } from '../../types'

// Workflow progress, derived from the agent ledger. Pure: no engine, no clock, no state. The engine gives every workflow agent one
// run id (spawn.workflow.runId, empty outside a real run), so helpers group by `workflowRunId` and by nothing else: a shared
// toolUseId could merge unrelated resumes. The pane counts what the ledger holds and never invents a total. Observer only.

export type WorkflowProgress = { key: string; done: number; failed: number; running: number; startedAt: number; latestAt: number }

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
