import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, CommandRunInput, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the /os pane can fail, one test each. Every check reads the drawn pane.
// F7  a long task list scrolls the active task out of view
// F8  /os does not open the pane under the id the render hook draws
// F9  the lane row ignores the lane board's answer (held, none, or unreadable)
// F10 the pane does not draw on terminal or desktop
// F11 finished agents still show as working

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

type World = { lanes?: string; scriptExists?: boolean; agents?: { id: string; description: string; type: string; status: string }[] }

const world = (on: On, opts: World = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('fs.exists', () => ({ value: opts.scriptExists ?? true }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: opts.lanes ?? '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: (opts.agents ?? []) as AgentInfo[] }))
  // /os returns at once; its lane and agent reads land when the event loop settles.
  return { settle: () => clock.advance(1) }
}

const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', rows = 24): Promise<string[]> => {
  const pane = await $.ui.mount({
    plugin: 'ccv3-mods',
    surface,
    component: 'Pane',
    requestId: 'agentic-os',
    props: PANE_PROPS,
    viewport: { columns: 60, rows },
  })
  const texts = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text)
  await pane.unmount()
  return texts
}

describe('agentic-os pane', () => {
  test('F8 F9 /os opens the pane by its id and shows the held lane', async ($, on) => {
    const { settle } = world(on, { lanes: JSON.stringify([{ id: 'mods-agentic-os', title: 'Mods', state: 'active', note: 'n' }]) })
    const opened: string[] = []
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })

    const ran = await $.command.run(OS)
    await settle()
    expect(opened).toEqual(['agentic-os'])
    expect(ran.text).toBe('Agentic OS pane opened.')
    expect((await paneText($)).join('\n')).toMatch(/mods-agentic-os\s+● active/)
  })

  test('F9 an empty lane list reads as no lane held', async ($, on) => {
    const { settle } = world(on, { lanes: '[]' })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    expect((await paneText($)).join('\n')).toContain('no lane held')
  })

  test('F9 a missing lane board reads as not read, not as no lane', async ($, on) => {
    const { settle } = world(on, { scriptExists: false })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    expect((await paneText($)).join('\n')).toContain('lane board not read')
  })

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
      const text = (await paneText($, surface, 16)).join('\n')
      expect(text).toContain('15/20 done')
      expect(text).toContain('✓ 15 done')
      expect(text).toContain('▶ Doing step 16')
      expect(text).not.toContain('✓ step 1\n')
    }
  })

  test('F11 only live agents are listed', async ($, on) => {
    const { settle } = world(on, {
      agents: [
        { id: 'a1', description: 'map hooks', type: 'scout', status: 'running' },
        { id: 'a2', description: 'old review', type: 'critic', status: 'completed' },
      ],
    })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run(OS)
    await settle()
    const text = (await paneText($)).join('\n')
    expect(text).toMatch(/▶ scout\s+map hooks/)
    expect(text).not.toContain('old review')
  })
})
