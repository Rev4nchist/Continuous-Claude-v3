import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, CommandRunInput, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the /os pane can fail, one test each. Every check reads the drawn pane.
// F7  a long task list scrolls the active task out of view
// F8  /os does not open the pane under the id the render hook draws, or the Work tab ignores the held lane
// F9  the Work tab ignores the lane board's answer (held, none, unreadable, or an answer in the old `mine` array shape)
// F10 the pane does not draw on terminal or desktop
// F11 finished agents still show as working (on the Session tab)
//
// /os redesign, round 2 (tests first). Edits to the pre-redesign tests (each with the reason; none weakened):
//   F8/F9 read the Work tab (a press of tab-work), not Overview: LANE left Overview. The lane board answers the object
//         { lanes, peers, me } of `lane.mjs board --json` (the spawn is now `board --json --as <sid>`), so the mock stdout changes shape and the
//         sentence is "You hold lane <id>: <title>" (laneSentence) instead of "<id> ● active". A bare array (the old `mine` output) is not a board:
//         it reads "lane board not read" (new test).
//   F11 reads the Session tab: AGENTS left Overview. HELPERS lists the ledger's running runs (`agentRuns`), so the test seeds that atom with a
//         state.get hook (the kit's `$` cannot write an atom) beside the agent.list answer.

const PANE_PROPS = {
  title: 'Agentic OS',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const OS: CommandRunInput = {
  command: 'os',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}

type World = {
  lanes?: string
  scriptExists?: boolean
  agents?: { id: string; description: string; type: string; status: string }[]
  /** Ledger runs the Session tab lists (seeded into the agentRuns atom). */
  runs?: { id: string; type: string; description: string; status: 'running' | 'done'; startedAt: number; endedAt: number | null }[]
}

/** The answer of `lane.mjs board --json`: me is 'test-session'. */
const board = (lanes: Record<string, unknown>[]): string => JSON.stringify({ lanes, peers: [{ id: 'test-session', working_on: 'this session' }], me: 'test-session' })

const world = (on: On, opts: World = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('fs.exists', () => ({ value: opts.scriptExists ?? true }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: opts.lanes ?? board([]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: (opts.agents ?? []) as AgentInfo[] }))
  if (opts.runs) {
    const runs = opts.runs.map(one => ({ model: null, effort: null, spec: {}, tokens: 0, costUsd: 0, drift: null, ...one }))
    on('state.get', { plugin: 'ccv3-mods', key: 'agentRuns' } as never, (() => ({ value: { value: runs, version: 1 } })) as never)
  }
  // /os returns at once; its lane and agent reads land when the event loop settles.
  return { settle: () => clock.advance(1) }
}

const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', rows = 24, tab?: 'session' | 'plan' | 'work' | 'proof' | 'decisions'): Promise<string[]> => {
  const pane = await $.ui.mount({
    plugin: 'ccv3-mods',
    surface,
    component: 'Pane',
    requestId: 'agentic-os',
    props: PANE_PROPS,
    viewport: { columns: 60, rows },
  })
  if (tab) await pane.press({ key: `tab-${tab}` })
  const texts = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text)
  await pane.unmount()
  return texts
}

describe('agentic-os pane', () => {
  test('F8 F9 /os opens the pane by its id and the Work tab shows the held lane', async ($, on) => {
    const { settle } = world(on, { lanes: board([{ id: 'mods-agentic-os', title: 'Mods', state: 'active', owner_session_id: 'test-session', lease_expires_at: null, note: 'n', scope: null }]) })
    const opened: string[] = []
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })

    const ran = await $.command.run(OS)
    await settle()
    expect(opened).toEqual(['agentic-os'])
    expect(ran.text).toBe('Agentic OS pane opened.')
    expect((await paneText($, 'terminal', 24, 'work')).join('\n')).toContain('You hold lane mods-agentic-os: Mods')
  })

  test('F9 an empty lane board reads as no lane held', async ($, on) => {
    const { settle } = world(on, { lanes: board([]) })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    expect((await paneText($, 'terminal', 24, 'work')).join('\n')).toContain('no lane held')
  })

  test('F9 a missing lane board reads as not read, not as no lane', async ($, on) => {
    const { settle } = world(on, { scriptExists: false })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    const text = (await paneText($, 'terminal', 24, 'work')).join('\n')
    expect(text).toContain('lane board not read')
    expect(text).not.toContain('no lane held')
  })

  test('F9 an answer in the old array shape is not a board: the Work tab reads lane board not read', async ($, on) => {
    const { settle } = world(on, { lanes: JSON.stringify([{ id: 'mods-agentic-os', title: 'Mods', state: 'active', note: 'n' }]) })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    const text = (await paneText($, 'terminal', 24, 'work')).join('\n')
    expect(text).toContain('lane board not read')
    expect(text).not.toContain('mods-agentic-os')
  })

  // Changed with the /os tabs: the task list moved from the one-page pane to the Plan tab (os-tabs-model.ts), so F7 presses
  // that tab (now labelled Steps), and its header reads "15 of 20 done" where the old TASKS header read "15/20 done". The fold is unchanged.
  test('F7 F10 a long list folds finished tasks and keeps the active one, on both surfaces', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
    const todos = Array.from({ length: 20 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: (i < 15 ? 'completed' : i === 15 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
      activeForm: `Doing step ${i + 1}`,
    }))
    await $.tool.call({ tool: 'TodoWrite', todos })

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = (await paneText($, surface, 16, 'plan')).join('\n')
      expect(text).toContain('15 of 20 done')
      expect(text).toContain('✓ 15 done')
      expect(text).toContain('▶ Doing step 16')
      expect(text).not.toContain('✓ step 1\n')
    }
  })

  test('F11 only live helpers are listed as running on the Session tab', async ($, on) => {
    const { settle } = world(on, {
      agents: [
        { id: 'a1', description: 'map hooks', type: 'scout', status: 'running' },
        { id: 'a2', description: 'old review', type: 'critic', status: 'completed' },
      ],
      runs: [
        { id: 'a1', type: 'scout', description: 'map hooks', status: 'running', startedAt: 1_000 - 60_000, endedAt: null },
        { id: 'a2', type: 'critic', description: 'old review', status: 'done', startedAt: 1_000 - 600_000, endedAt: 1_000 - 300_000 },
      ],
    })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    const text = (await paneText($, 'terminal', 30, 'session')).join('\n')
    const helpers = text.slice(text.indexOf('HELPERS'), text.includes('TIMELINE') ? text.indexOf('TIMELINE') : undefined)
    expect(text).toContain('HELPERS')
    expect(helpers).toContain('A helper is map hooks')
    expect(helpers).not.toContain('old review')
    expect(text).not.toContain('A helper is old review')
  })
})
