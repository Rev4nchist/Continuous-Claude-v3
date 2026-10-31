import { describe, expect, test } from 'claude-code/testing'

import { MAX_FINISHED, capRuns } from '../hooks/agent-ledger/model'
import { workflowSentence } from '../hooks/agentic-os/plain'
import { workflowProgress } from '../hooks/agentic-os/workflow-model'
// swarmGroups is new: through the namespace, so a missing export fails its own tests and not the whole file.
import * as model from '../hooks/agentic-os/workflow-model'
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
// F10 swarmGroups groups by workflowRunId with other counts than workflowProgress, or its flows are not in the same key rule
// F11 a run with an id lands in the helpers list, or a run with no id (or an empty one) does not
// F12 a finished workflow is listed above a running one, or the rest are not newest first
// F13 the agents of a group are not running (oldest start first), then failed, then done (newest end first), or an unknown status leads
// F14 a group with no run exists (no runs, no groups: a feed alone never makes one: swarm-tab.test.ts F14 reads the tab)
// F15 is in swarm-tab.test.ts: a feed label replaces the purpose only for the matching agent id

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

describe('swarmGroups', () => {
  const mixed = [
    run('p1', 'running', 90, null),
    run('e1', 'done', 95, 99, ''),
    run('a', 'done', 100, 200, 'wf_1'),
    run('b', 'running', 110, null, 'wf_1'),
    run('c', 'failed', 120, 300, 'wf_2'),
  ]

  test('F10 each flow carries the workflowProgress entry of its key and the runs of that key, nothing else', () => {
    const { flows } = model.swarmGroups(mixed)
    const progress = workflowProgress(mixed)
    expect(flows.map(one => one.progress.key).sort()).toEqual(progress.map(one => one.key).sort())
    for (const flow of flows) {
      expect(flow.progress).toEqual(progress.find(one => one.key === flow.progress.key))
      expect(flow.runs.every(one => one.workflowRunId === flow.progress.key)).toBe(true)
    }
    expect(flows.find(one => one.progress.key === 'wf_1')?.runs.map(one => one.id).sort()).toEqual(['a', 'b'])
    expect(flows.reduce((n, one) => n + one.runs.length, 0)).toBe(3)
  })

  test('F10 the same two workflowRunIds on one toolUseId stay two flows (no toolUseId fallback)', () => {
    const runs = [run('a', 'done', 100, 200, 'wf_1', { toolUseId: 'toolu_1' }), run('b', 'done', 120, 300, 'wf_2', { toolUseId: 'toolu_1' })]
    expect(model.swarmGroups(runs).flows.map(one => one.progress.key).sort()).toEqual(['wf_1', 'wf_2'])
  })

  test('F11 the helpers list holds only the runs with no id or an empty one', () => {
    const { helpers } = model.swarmGroups(mixed)
    expect(helpers.map(one => one.id).sort()).toEqual(['e1', 'p1'])
  })

  test('F12 a workflow with a running agent comes first, even when an older one finished later; the rest are newest first', () => {
    const runs = [
      run('o1', 'done', 10, 900, 'wf_finished_late'),
      run('n1', 'done', 500, 700, 'wf_finished_early'),
      run('r1', 'running', 20, null, 'wf_running_old'),
    ]
    expect(workflowProgress(runs).map(one => one.key)[0]).toBe('wf_finished_late')
    const keys = model.swarmGroups(runs).flows.map(one => one.progress.key)
    expect(keys).toEqual(['wf_running_old', 'wf_finished_late', 'wf_finished_early'])
    expect(model.swarmGroups([...runs].reverse()).flows.map(one => one.progress.key)).toEqual(keys)
  })

  test('F13 inside a group: running (oldest start first), failed, then done (newest end first); an unknown status is last', () => {
    const runs = [
      run('d-old', 'done', 100, 200, 'wf_1'),
      run('d-new', 'done', 110, 400, 'wf_1'),
      run('f1', 'failed', 120, 300, 'wf_1'),
      run('r-late', 'running', 150, null, 'wf_1'),
      run('r-early', 'running', 105, null, 'wf_1'),
      run('odd', 'weird' as never, 90, null, 'wf_1'),
    ]
    const order = ['r-early', 'r-late', 'f1', 'd-new', 'd-old', 'odd']
    expect(model.swarmGroups(runs).flows[0]?.runs.map(one => one.id)).toEqual(order)
    expect(model.swarmGroups([...runs].reverse()).flows[0]?.runs.map(one => one.id)).toEqual(order)
    const plain = runs.map(one => ({ ...one, workflowRunId: undefined }))
    expect(model.swarmGroups(plain as never).helpers.map(one => one.id)).toEqual(order)
  })

  test('F14 no runs give no flows and no helpers; the order of a tie does not depend on the input order', () => {
    expect(model.swarmGroups([])).toEqual({ flows: [], helpers: [] })
    const tie = [run('b', 'done', 100, 200, 'wf_b'), run('a', 'done', 100, 200, 'wf_a')]
    expect(model.swarmGroups(tie).flows.map(one => one.progress.key)).toEqual(model.swarmGroups([...tie].reverse()).flows.map(one => one.progress.key))
  })

  test('F9 F10 the input list and its runs are not changed, and a frozen input does not throw', () => {
    const runs = Object.freeze(mixed.map(one => Object.freeze({ ...one })))
    const before = JSON.stringify(runs)
    expect(() => model.swarmGroups(runs)).not.toThrow()
    expect(JSON.stringify(runs)).toBe(before)
  })
})
