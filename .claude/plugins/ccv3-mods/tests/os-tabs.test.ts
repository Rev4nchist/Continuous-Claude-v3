import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the /os tabs can fail once the real mod draws them. Every check mounts the pane and reads or presses what is drawn.
// T1 the pane does not open on Overview, or a live tab has no Button, or a not-yet-built tab has one
// T2 a press on a tab does not show that tab's rows
// T3 a press on a disabled tab changes the pane
// T4 the selection is not kept between draws, or is not reset at /clear and at resume
// T5 the tabs draw on the terminal but not on the desktop
// T6 a live tab Button has the wrong hotkey (the digit that selects it), or none

const PANE_PROPS = {
  title: 'Agentic OS',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

const world = (on: On) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.list', () => ({ value: [] as AgentInfo[] }))
  on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
}

const todos = async ($: Engine) => {
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'write the model', status: 'completed', activeForm: 'Writing the model' },
      { content: 'wire the pane', status: 'in_progress', activeForm: 'Wiring the pane' },
      { content: 'prove it', status: 'pending', activeForm: 'Proving it' },
    ],
  })
}

const mountPane = (surface: 'terminal' | 'desktop', $: Engine) =>
  $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'Pane', requestId: 'agentic-os', props: PANE_PROPS, viewport: { columns: 60, rows: 30 } })

type Pane = Awaited<ReturnType<typeof mountPane>>

const drawn = async (pane: Pane): Promise<string> =>
  (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')

const buttons = async (pane: Pane): Promise<string[]> => (await pane.findAll({ type: 'Button' })).map(found => found.key ?? '')

const END_CLEAR = { reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never
const END_RESUME = { reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never

describe('agentic-os /os tabs', () => {
  test('T1 the pane opens on Overview with a Button for each live tab and none for the others', async ($, on) => {
    world(on)
    const pane = await mountPane('terminal', $)
    expect(await buttons(pane)).toEqual(['tab-overview', 'tab-plan', 'tab-proof', 'tab-decisions'])
    const text = await drawn(pane)
    expect(text).toMatch(/Overview/)
    expect(text).toMatch(/Comms\s+NEXT/)
    expect(text).toMatch(/Swarm\s+LATER/)
    expect(text).toMatch(/Resources\s+LATER/)
    expect(text).toContain('GOAL not set')
    expect(text).not.toContain('no steps yet')
    await pane.unmount()
  })

  test('T2 a press on a tab shows that tab, and a press on Overview brings Overview back', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-plan' })
    let text = await drawn(pane)
    expect(text).toMatch(/1 of 3/)
    expect(text).toMatch(/!.*write the model.*UNPROVEN/)
    expect(text).not.toContain('GOAL')
    await pane.press({ key: 'tab-proof' })
    text = await drawn(pane)
    expect(text).toMatch(/PROOF[\s\S]*UNPROVEN/)
    expect(text).not.toContain('1 of 3')
    await pane.press({ key: 'tab-overview' })
    expect(await drawn(pane)).toContain('GOAL not set')
    await pane.unmount()
  })

  test('T3 a press on a disabled tab changes nothing', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-plan' })
    const before = await drawn(pane)
    for (const key of ['tab-comms', 'tab-swarm', 'tab-resources']) await pane.press({ key }).catch(() => undefined)
    expect(await drawn(pane)).toBe(before)
    await pane.unmount()
  })

  test('T5 the desktop draws the same tabs and switches on a press', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('desktop', $)
    expect(await buttons(pane)).toEqual(['tab-overview', 'tab-plan', 'tab-proof', 'tab-decisions'])
    expect(await drawn(pane)).toMatch(/Comms\s+NEXT/)
    await pane.press({ key: 'tab-plan' })
    expect(await drawn(pane)).toMatch(/1 of 3/)
    await pane.unmount()
  })

  // The kit presses a Button by its key and has no keystroke, so it cannot press a digit. What it can read is the Button's props:
  // the engine turns a bare digit into a press of the Button whose `hotkey` it is, so a right `hotkey` on each Button is the wiring.
  test('T6 each live tab Button carries its digit as the hotkey, 1 to 4 in strip order, drawn plain', async ($, on) => {
    world(on)
    const pane = await mountPane('terminal', $)
    const found = await pane.findAll({ type: 'Button' })
    expect(found.map(one => [one.key, one.props.hotkey, one.props.plain])).toEqual([
      ['tab-overview', '1', true],
      ['tab-plan', '2', true],
      ['tab-proof', '3', true],
      ['tab-decisions', '4', true],
    ])
    await pane.unmount()
  })

  // The atom outlives a draw, so a fresh mount after a press still shows the pressed tab; only the reset at /clear or resume brings Overview back.
  for (const [name, end] of [['/clear', END_CLEAR], ['resume', END_RESUME]] as const) {
    test(`T4 the selection stays across draws and ${name} resets it to Overview`, async ($, on) => {
      world(on)
      const first = await mountPane('terminal', $)
      await first.press({ key: 'tab-plan' })
      await first.unmount()
      const again = await mountPane('terminal', $)
      expect(await drawn(again)).toMatch(/no steps yet/)
      await again.unmount()

      await $.session.end(end)
      const after = await mountPane('terminal', $)
      const text = await drawn(after)
      expect(text).toContain('GOAL not set')
      expect(text).not.toContain('no steps yet')
      await after.unmount()
    })
  }
})
