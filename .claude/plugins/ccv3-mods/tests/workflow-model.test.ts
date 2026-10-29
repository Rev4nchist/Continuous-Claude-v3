import { describe, expect, test } from 'claude-code/testing'

import { MAX_FINISHED, capRuns } from '../hooks/agent-ledger/model'
import { workflowSentence } from '../hooks/agentic-os/plain'
import { workflowProgress } from '../hooks/agentic-os/workflow-model'
import type { AgentRun } from '../types'

// /os redesign, round 1: hooks/agentic-os/workflow-model.ts, workflow progress derived from the agent ledger.
// A workflow's agents all carry one `workflowRunId` (engine: spawn.workflow.runId, empty only outside a real run). The pane never
// invents a total: it counts what the ledger holds.
//
// Contract these tests pin (the plan left these holes; the choices are mine and the implementer must follow them or change the test):
//   - WorkflowProgress = { key, done, failed, running, startedAt, latestAt }. `key` is the workflowRunId.
//   - done counts status 'done', failed counts 'failed' (not in done), running counts 'running'.
//   - startedAt is the earliest run start; latestAt is the latest of endedAt (or startedAt for a run that has not ended).
//   - Groups come back newest first by latestAt. The order does not depend on the input order.
//   - No toolUseId fallback (amendment: the engine gives every workflow agent a runId; a shared toolUseId could merge unrelated resumes).
//   - An empty-string workflowRunId is no workflowRunId.
//
// Ways the grouping can fail, one test each:
// F1  runs of one workflowRunId are not grouped, or the counts or times are wrong
// F2  the sentence built from the progress reads wrong (the real chain: runs, progress, sentence)
// F3  a failed run is counted as done, or dropped
// F4  two runs that share a toolUseId and have no workflowRunId are grouped (the removed fallback)
// F5  a run with no workflowRunId, or an empty one, is counted in a workflow or becomes a workflow
// F6  the order depends on the input order, or is not newest first
// F7  more than 50 finished runs: the ledger cap drops the oldest, so 'done' undercounts (documented, not fixed); no total is invented
// F8  empty input fails
// F9  the input list or a run is changed

const run = (id: string, status: AgentRun['status'], startedAt: number, endedAt: number | null, workflowRunId?: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id,
  type: 'general-purpose',
  description: `step ${id}`,
  model: null,
  effort: null,
  spec: {},
  startedAt,
  endedAt,
  status,
  tokens: 0,
  costUsd: 0,
  drift: null,
  ...(workflowRunId === undefined ? {} : { workflowRunId }),
  ...over,
})

describe('workflowProgress', () => {
  test('F1 runs of one workflowRunId form one group with done, running and the first start and last end', () => {
    const runs = [run('a', 'done', 100, 200, 'wf_1'), run('b', 'done', 120, 300, 'wf_1'), run('c', 'running', 150, null, 'wf_1')]
    expect(workflowProgress(runs)).toEqual([{ key: 'wf_1', done: 2, failed: 0, running: 1, startedAt: 100, latestAt: 300 }])
  })

  test('F2 the progress reads A workflow: 2 helpers done, 1 running', () => {
    const runs = [run('a', 'done', 100, 200, 'wf_1'), run('b', 'done', 120, 300, 'wf_1'), run('c', 'running', 150, null, 'wf_1')]
    const [first] = workflowProgress(runs)
    expect(first).toBeDefined()
    expect(workflowSentence(first as never)).toBe('A workflow: 2 helpers done, 1 running')
  })

  test('F3 a failed run counts as failed, not as done', () => {
    const runs = [run('a', 'done', 100, 200, 'wf_1'), run('b', 'failed', 110, 250, 'wf_1')]
    const [only] = workflowProgress(runs)
    expect(only).toMatchObject({ key: 'wf_1', done: 1, failed: 1, running: 0 })
  })

  test('F4 two runs that share a toolUseId and no workflowRunId are plain helpers: there is no fallback', () => {
    const runs = [run('a', 'done', 100, 200, undefined, { toolUseId: 'toolu_1' }), run('b', 'running', 120, null, undefined, { toolUseId: 'toolu_1' })]
    expect(workflowProgress(runs)).toEqual([])
  })

  test('F4 a shared toolUseId does not merge two different workflowRunIds', () => {
    const runs = [run('a', 'done', 100, 200, 'wf_1', { toolUseId: 'toolu_1' }), run('b', 'done', 120, 300, 'wf_2', { toolUseId: 'toolu_1' })]
    expect(workflowProgress(runs).map(one => one.key).sort()).toEqual(['wf_1', 'wf_2'])
  })

  test('F5 runs with no workflowRunId, or an empty one, are plain helpers and are not counted in any workflow', () => {
    const runs = [run('plain', 'running', 90, null), run('empty', 'done', 95, 99, ''), run('a', 'done', 100, 200, 'wf_1'), run('b', 'running', 110, null, 'wf_1')]
    expect(workflowProgress(runs)).toEqual([{ key: 'wf_1', done: 1, failed: 0, running: 1, startedAt: 100, latestAt: 200 }])
  })

  test('F6 groups come back newest first by their latest time, whatever the input order', () => {
    const old = [run('o1', 'done', 10, 100, 'wf_old'), run('o2', 'done', 20, 120, 'wf_old')]
    const fresh = [run('n1', 'done', 500, 900, 'wf_new'), run('n2', 'running', 600, null, 'wf_new')]
    expect(workflowProgress([...old, ...fresh]).map(one => one.key)).toEqual(['wf_new', 'wf_old'])
    expect(workflowProgress([...fresh, ...old]).map(one => one.key)).toEqual(['wf_new', 'wf_old'])
    expect(workflowProgress([...fresh.slice().reverse(), ...old.slice().reverse()])).toEqual(workflowProgress([...old, ...fresh]))
  })

  test('F7 60 finished runs of one workflow: the ledger cap keeps 50, so done reads 50 (documented undercount), and no total exists', () => {
    const many = Array.from({ length: 60 }, (_, i) => run(`r${i}`, 'done', 1000 + i, 2000 + i, 'wf_big'))
    const [big] = workflowProgress(capRuns(many))
    expect(MAX_FINISHED).toBe(50)
    expect(big?.done).toBe(50)
    expect(big?.done).not.toBe(60)
    expect('total' in (big ?? {})).toBe(false)
  })

  test('F8 no runs give no workflows', () => {
    expect(workflowProgress([])).toEqual([])
  })

  test('F9 the input list and its runs are not changed, and a frozen input does not throw', () => {
    const runs = Object.freeze([Object.freeze(run('a', 'done', 100, 200, 'wf_1')), Object.freeze(run('b', 'running', 110, null, 'wf_1'))])
    const before = JSON.stringify(runs)
    expect(() => workflowProgress(runs)).not.toThrow()
    expect(JSON.stringify(runs)).toBe(before)
  })
})
