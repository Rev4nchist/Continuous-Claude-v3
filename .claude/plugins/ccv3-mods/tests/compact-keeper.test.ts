import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { OsTask } from '../types'
import { KEEPER_LIMIT, compactBlock, keeperMarker } from '../hooks/compact-keeper/model'

// Ways the compact keeper can fail, one test each.
// K1 a long task list pushes the block over the limit, loses the marker, or counts the cut tasks wrong
// K2 a session with nothing to keep still gets a block (and a marker that claims the keeper ran)
// K3 a manual /compact reaches the summarizer without the open tasks or the marker
// K4 the person's own text after /compact is replaced, or is not first
// K5 an auto or plugin compaction is changed (only the person's /compact is)
// K6 either off switch still changes the compaction
// K7 a finished task is listed as open, or the counts are wrong
// K8 a subagent's own compaction gets this session's plan
// Not tested here: a hook that throws. The engine skips it with or without `.catch`, so a test cannot tell;
// `node scripts/mods/validate-mods.mjs` fails a gating hook without `.catch` (shown 2026-10-13: "session.compact{trigger=manual}").
// Not tested here: the matcher. Without it the plugin does not load (two unmatched session.compact hooks), and every test fails.

const task = (id: number, status: OsTask['status'] = 'pending', subject = `task ${id}`): OsTask => ({ id: String(id), subject, status })

describe('compactBlock (pure)', () => {
  test('K1 many tasks: under the limit, marker kept, the "+N more" count is exact', () => {
    const tasks = Array.from({ length: 80 }, (_, i) => task(i + 1, 'pending', `a fairly long task subject number ${i + 1} that takes space`))
    const block = compactBlock({ plan: { title: 'P' }, tasks, lanes: null, prs: [] }, 'abcdef123456') ?? ''
    expect(block.length).toBeLessThanOrEqual(KEEPER_LIMIT)
    expect(block).toContain(keeperMarker('abcdef123456', 80, 80))
    const listed = block.split('\n').filter(line => line.startsWith('- task') || line.startsWith('- a fairly')).length
    expect(block).toContain(`- (+${80 - listed} more)`)
  })

  test('K1 a tiny limit still returns the marker', () => {
    const block = compactBlock({ plan: { title: 'P' }, tasks: [task(1), task(2)], lanes: null, prs: [] }, 'abcdef123456', 10) ?? ''
    expect(block).toContain(keeperMarker('abcdef123456', 2, 2))
  })

  test('K2 nothing to keep gives no block: empty, or only finished tasks', () => {
    expect(compactBlock({ plan: null, tasks: [], lanes: null, prs: [] }, 's1')).toBeNull()
    expect(compactBlock({ plan: null, tasks: [task(1, 'completed')], lanes: [], prs: [] }, 's1')).toBeNull()
  })

  test('K7 finished tasks count in the marker only; the plan, lane and PRs show', () => {
    const block =
      compactBlock(
        { plan: { title: 'Fix the gate', file: 'plan.md' }, tasks: [task(1, 'completed', 'done one'), task(2, 'in_progress', 'doing two'), task(3, 'pending', 'later three')], lanes: [{ id: 'ccv3-mods', title: 'mods', state: 'active' }], prs: [{ pr: 12, state: 'READY', whenReady: false }, { pr: 13, state: null, whenReady: false }] },
        'abcdef123456',
      ) ?? ''
    expect(block).not.toContain('done one')
    expect(block).toContain('- [doing] doing two')
    expect(block).toContain('- later three')
    expect(block).toContain('Open tasks (2 of 3):')
    expect(block).toContain('Plan: Fix the gate (plan.md)')
    expect(block).toContain('Lane: ccv3-mods: mods (active)')
    expect(block).toContain('Watched PRs: #12 READY, #13 unchecked')
    expect(block).toContain(keeperMarker('abcdef123456', 2, 3))
  })
})

// The engine beneath the plugin: a clock, the session id, and a compaction that records what it was told.
const seen: { instructions: string | undefined | null } = { instructions: null }
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const world = (on: On, env: Record<string, string> = {}) => {
  seen.instructions = null
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: 's1' }))
  on('session.compact', (_$, e) => {
    seen.instructions = e.instructions
    return { messages: [SUMMARY] }
  })
  let next = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
}

const twoTasks = async ($: Engine) => {
  await $.tool.call({ tool: 'TaskCreate', subject: 'alpha', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'beta', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
}

const compact = ($: Engine, trigger: string, extra: Record<string, unknown> = {}) =>
  $.session.compact({ trigger, messages: [SUMMARY], ...extra } as never)

describe('compact keeper (engine)', () => {
  test('K3 K7 a manual compaction carries the open task and the marker', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toContain('- beta')
    expect(seen.instructions).not.toContain('- alpha')
    expect(seen.instructions).toContain(keeperMarker('s1', 1, 2))
  })

  test('K4 the persons own text stays first', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual', { instructions: 'stress the test results' })
    expect(seen.instructions?.startsWith('stress the test results\n\n')).toBe(true)
    expect(seen.instructions).toContain(keeperMarker('s1', 1, 2))
  })

  test('K2 no state: the compaction reaches the engine untouched', async ($, on) => {
    world(on)
    await compact($, 'manual', { instructions: 'only this' })
    expect(seen.instructions).toBe('only this')
  })

  test('K5 an auto or plugin compaction is left alone', async ($, on) => {
    world(on)
    await twoTasks($)
    for (const trigger of ['auto', 'plugin']) {
      await compact($, trigger)
      expect(seen.instructions).toBeUndefined()
    }
  })

  test('K6 CCV3_MODS_OFF leaves the compaction alone', async ($, on) => {
    world(on, { CCV3_MODS_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('K6 CCV3_MOD_KEEPER_OFF leaves the compaction alone', async ($, on) => {
    world(on, { CCV3_MOD_KEEPER_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('K8 a subagent compaction does not get this session plan', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual', { agentId: 'sub-1' })
    expect(seen.instructions).toBeUndefined()
  })
})
