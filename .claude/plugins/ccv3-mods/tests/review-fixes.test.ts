import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { OsTask } from '../types'
import { taskRows } from '../hooks/agentic-os/pane-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'

const textOf = (row: PaneRow) => [...row.left, ...(row.right ?? [])].map(span => span.text).join('').trim()

// Critic review of f1131b6, reproduced before the fix:
// R1 the fold returns room + 1 rows when tasks are hidden
// R2 the active task drops out when it was created after room - 1 open tasks
// R3 the fold shows "✓ 0 done" when nothing is finished
// R4 many live agents push the pane past its body rows
// R5 two parallel calls: the later one finishing first clears NOW while the earlier still runs
//
// /os redesign, round 2 (tests first). R4 moves to the Session tab: AGENTS left Overview, and the Session tab lists the ledger's running runs
// under HELPERS. The test seeds the agentRuns atom with a state.get hook (the kit's `$` cannot write an atom) beside the agent.list answer, then
// presses tab-session. It still expects the body to stay inside its rows and a `+N more` marker for what was cut (the stricter regex replaces
// the bare word "more", which the hint "...more -> Tab" could now satisfy).

const tasks = (n: number, status: (i: number) => OsTask['status']): OsTask[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), subject: `task ${i + 1}`, status: status(i) }))

describe('task fold', () => {
  test('R1 R2 R3 twelve open tasks, the tenth active, fit six rows with the active one shown', () => {
    const rows = taskRows(tasks(12, i => (i === 9 ? 'in_progress' : 'pending')), 6)
    expect(rows.length).toBeLessThanOrEqual(6)
    expect(rows.some(row => textOf(row) === '▶ task 10')).toBe(true)
    expect(rows.some(row => textOf(row).startsWith('✓ 0'))).toBe(false)
  })

  test('R1 finished and open tasks together never pass the room, at any room size', () => {
    const list = tasks(15, i => (i < 5 ? 'completed' : i === 14 ? 'in_progress' : 'pending'))
    for (const room of [1, 2, 3, 6, 10]) {
      const rows = taskRows(list, room)
      expect(rows.length).toBeLessThanOrEqual(room)
      expect(rows.some(row => textOf(row).startsWith('▶'))).toBe(true)
    }
  })
})

const world = (on: On, agents: AgentInfo[] = [], runs: unknown[] = []) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('agent.list', () => ({ value: agents }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  if (runs.length > 0) on('state.get', { plugin: 'ccv3-mods', key: 'agentRuns' } as never, (() => ({ value: { value: runs, version: 1 } })) as never)
  return { settle: () => clock.advance(1) }
}

const paneRowsDrawn = async ($: Engine, bodyRows: number, tab?: 'session'): Promise<string[]> => {
  const pane = await $.ui.mount({
    plugin: 'ccv3-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agentic-os',
    props: { title: 'Agentic OS', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
    viewport: { columns: 60, rows: 40 },
  })
  if (tab) await pane.press({ key: `tab-${tab}` })
  const texts = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text)
  await pane.unmount()
  return texts
}

describe('pane height', () => {
  test('R4 six live helpers still fit a 12-row body on the Session tab, with a "+N more" row for what was cut', async ($, on) => {
    const agents = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, description: `job ${i}`, type: 'scout', status: 'running' }))
    const runs = agents.map((one, i) => ({ ...one, model: null, effort: null, spec: {}, startedAt: 1_000 - (i + 1) * 60_000, endedAt: null, tokens: 0, costUsd: 0, drift: null }))
    const { settle } = world(on, agents as AgentInfo[], runs)
    await $.command.run({ command: 'os', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await settle()
    const rows = await paneRowsDrawn($, 12, 'session')
    expect(rows.length).toBeLessThanOrEqual(12)
    expect(rows.join('\n')).toContain('HELPERS')
    expect(rows.join('\n')).toMatch(/\+\d+ more/)
  })
})

describe('parallel steps', () => {
  test('R5 NOW keeps the call that still runs', async ($, on) => {
    const { settle } = world(on)
    const release: Record<string, () => void> = {}
    on('tool.call', { tool: 'Glob' }, (_$, e) =>
      new Promise(resolve => {
        release[e.pattern] = () => resolve({ result: { durationMs: 1, numFiles: 0, filenames: [], truncated: false } })
      }),
    )
    const first = $.tool.call({ tool: 'Glob', pattern: 'slow/**' })
    const second = $.tool.call({ tool: 'Glob', pattern: 'fast/**' })
    await settle()
    expect(Object.keys(release).sort()).toEqual(['fast/**', 'slow/**'])
    release['fast/**']?.()
    await second

    const band = await $.ui.mount({
      plugin: 'ccv3-mods',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const text = (await band.find({ key: 'row-band' }))?.text ?? ''
    expect(text).toContain('slow/**')
    expect(text).not.toContain('fast/**')
    await band.unmount()
    release['slow/**']?.()
    await first
  })
})
