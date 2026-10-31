import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the /os tabs can fail once the real mod draws them. Every check mounts the pane and reads or presses what is drawn.
//
// /os redesign, round 2 (tests first). Contract these tests pin (the plan left these holes; the choices are mine and the implementer
// must follow them or change the test):
//   - Seven Buttons, keys tab-overview, tab-session, tab-plan, tab-work, tab-proof, tab-decisions, tab-swarm, hotkeys '1' to '7', drawn plain.
//   - The footer is a Text (never a Button) that reads 'later: Comms · Resources', drawn after the body. No NEXT or LATER words.
//   - A press of tab-work starts one board read: `node <home>/continuous-claude/scripts/coordination/lane.mjs board --json --as <session id>`.
//     A press of another tab starts none. The Work tab then shows the board (`You hold lane`, `Another session holds lane`) and `as of just now`.
//
// T1 the pane does not open on Overview, or a live tab has no Button, or a later tab (Comms, Resources) has one or still wears NEXT / LATER
// T2 a press on a tab does not show that tab's rows
// T3 a press on the footer (or on a later tab's old key) changes the pane
// T4 the selection is not kept between draws, or is not reset at /clear and at resume (also for Session and Work)
// T5 the tabs draw on the terminal but not on the desktop
// T6 a live tab Button has the wrong hotkey (the digit that selects it), or none
// T7 the footer is a Button, or is missing from the terminal or the desktop
// T8 a press of tab-work does not ask for a board refresh (or a press of another tab does), or the refresh argv is wrong
// T9 the Work tab does not draw what the board read returned
// T10 a press of tab-swarm does not show the Swarm tab (header, then the empty line or the ledger's runs)
// T11 a press of tab-swarm does not start one agent.list read (so a run the list holds as ended stays `running`), or a press of another tab starts one
// T12 /clear or a resume leaves the Swarm tab on a stale selection, or the tab lies about the ledger after it (the pinned behaviour: the mod keeps agentRuns)
//
// Edits to the pre-redesign tests (each listed with the reason; none weakened):
//   T1/T5 four Buttons -> six; the Comms NEXT / Swarm LATER / Resources LATER text -> the footer Text. T6 four hotkeys -> six.
//   T3 "a press on a disabled tab changes nothing" -> "the footer cannot be pressed": the disabled tabs are no longer strip items.
//   T4 keeps plan and adds work (the new atom values).
//   Swarm became the seventh live tab (Dave, 2026-10-30): SIX -> seven Buttons, hotkey 7, the footer drops Swarm; T3 no longer presses tab-swarm as a dead key.

const PANE_PROPS = {
  title: 'Agentic OS',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

const SEVEN = ['tab-overview', 'tab-session', 'tab-plan', 'tab-work', 'tab-proof', 'tab-decisions', 'tab-swarm']
const FOOTER = /later:\s*Comms\s*·\s*Resources/

const world = (on: On, onList?: () => void) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.list', () => {
    onList?.()
    return { value: [] as AgentInfo[] }
  })
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

/** Every Text and Box the pane drew, as text: the footer may be a bare Text under the rows. */
const everything = async (pane: Pane): Promise<string[]> => [
  ...(await pane.findAll({ type: 'Text' })).map(found => found.text),
  ...(await pane.findAll({ type: 'Box' })).map(found => found.text),
]

const END_CLEAR = { reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never
const END_RESUME = { reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never

describe('agentic-os /os tabs', () => {
  test('T1 the pane opens on Overview with a Button for each of the seven tabs and none for Comms or Resources', async ($, on) => {
    world(on)
    const pane = await mountPane('terminal', $)
    expect(await buttons(pane)).toEqual(SEVEN)
    const text = await drawn(pane)
    expect(text).toMatch(/Overview/)
    expect(text).toMatch(/Session/)
    expect(text).toMatch(/Work/)
    expect(text).not.toMatch(/\bNEXT\b|\bLATER\b/)
    expect(text).toContain('GOAL not set')
    expect(text).not.toContain('no steps yet')
    await pane.unmount()
  })

  test('T7 T1 the footer is one Text "later: Comms · Resources", not a Button, on the terminal', async ($, on) => {
    world(on)
    const pane = await mountPane('terminal', $)
    expect((await everything(pane)).some(one => FOOTER.test(one))).toBe(true)
    for (const found of await pane.findAll({ type: 'Button' })) expect(found.text).not.toMatch(/later|Comms|Resources/)
    expect(await buttons(pane)).toEqual(SEVEN)
    await pane.unmount()
  })

  test('T2 a press on a tab shows that tab, and a press on Overview brings Overview back', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-plan' })
    let text = await drawn(pane)
    expect(text).toMatch(/STEPS/)
    expect(text).toMatch(/1 of 3/)
    expect(text).toMatch(/!.*write the model.*UNPROVEN/)
    expect(text).not.toContain('GOAL')
    await pane.press({ key: 'tab-proof' })
    text = await drawn(pane)
    expect(text).toMatch(/CHECKS[\s\S]*UNPROVEN/)
    expect(text).not.toContain('1 of 3')
    await pane.press({ key: 'tab-overview' })
    expect(await drawn(pane)).toContain('GOAL not set')
    await pane.unmount()
  })

  test('T2 a press on tab-session shows the Session tab, and a press on tab-work the Work tab', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-session' })
    let text = await drawn(pane)
    expect(text).toMatch(/STATE[\s\S]*GOAL not set[\s\S]*NOW[\s\S]*HELPERS/)
    expect(text).toContain('Doing: ')
    expect(text).not.toContain('YOUR LANES')
    await pane.press({ key: 'tab-work' })
    text = await drawn(pane)
    expect(text).toMatch(/YOUR LANES[\s\S]*OTHER SESSIONS[\s\S]*CHANGES/)
    expect(text).not.toContain('HELPERS')
    await pane.press({ key: 'tab-overview' })
    expect(await drawn(pane)).toContain('GOAL not set')
    await pane.unmount()
  })

  test('T3 the footer cannot be pressed: pressing it, or the old key of a later tab, changes nothing and adds no Button', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-plan' })
    const before = await drawn(pane)
    for (const key of ['tab-comms', 'tab-resources', 'tab-later', 'footer', 'row-footer', 'row-footer-later']) await pane.press({ key }).catch(() => undefined)
    expect(await drawn(pane)).toBe(before)
    expect(await buttons(pane)).toEqual(SEVEN)
    await pane.unmount()
  })

  test('T5 T7 the desktop draws the same seven tabs and the footer, and switches on a press', async ($, on) => {
    world(on)
    await todos($)
    const pane = await mountPane('desktop', $)
    expect(await buttons(pane)).toEqual(SEVEN)
    expect((await everything(pane)).some(one => FOOTER.test(one))).toBe(true)
    expect(await drawn(pane)).not.toMatch(/\bNEXT\b|\bLATER\b/)
    await pane.press({ key: 'tab-plan' })
    expect(await drawn(pane)).toMatch(/1 of 3/)
    await pane.press({ key: 'tab-work' })
    expect(await drawn(pane)).toContain('YOUR LANES')
    await pane.unmount()
  })

  // The kit presses a Button by its key and has no keystroke, so it cannot press a digit. What it can read is the Button's props:
  // the engine turns a bare digit into a press of the Button whose `hotkey` it is, so a right `hotkey` on each Button is the wiring.
  test('T6 each live tab Button carries its digit as the hotkey, 1 to 7 in strip order, drawn plain', async ($, on) => {
    world(on)
    const pane = await mountPane('terminal', $)
    const found = await pane.findAll({ type: 'Button' })
    expect(found.map(one => [one.key, one.props.hotkey, one.props.plain])).toEqual([
      ['tab-overview', '1', true],
      ['tab-session', '2', true],
      ['tab-plan', '3', true],
      ['tab-work', '4', true],
      ['tab-proof', '5', true],
      ['tab-decisions', '6', true],
      ['tab-swarm', '7', true],
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

    test(`T4 the Session, Work and Swarm selections are stored too, and ${name} resets them to Overview`, async ($, on) => {
      world(on)
      for (const [key, head] of [['tab-session', 'HELPERS'], ['tab-work', 'YOUR LANES'], ['tab-swarm', 'SWARM']] as const) {
        const first = await mountPane('terminal', $)
        await first.press({ key })
        await first.unmount()
        const again = await mountPane('terminal', $)
        expect(await drawn(again)).toContain(head)
        await again.unmount()

        await $.session.end(end)
        const after = await mountPane('terminal', $)
        expect(await drawn(after)).toContain('GOAL not set')
        expect(await drawn(after)).not.toContain(head)
        await after.unmount()
      }
    })
  }
})

// The board read behind the Work tab. `lane.mjs board --json` answers { lanes, peers, me }.
const BOARD = JSON.stringify({
  lanes: [
    { id: 'os-redesign', title: 'The pane', state: 'active', owner_session_id: 'test-session', lease_expires_at: null, note: 'tabs first', scope: 'hooks' },
    { id: 'api-core', title: 'The API', state: 'active', owner_session_id: 'bbbbbbbb-2222-4000-8000-000000000002', lease_expires_at: null, note: null, scope: null },
  ],
  peers: [
    { id: 'test-session', working_on: 'this session' },
    { id: 'bbbbbbbb-2222-4000-8000-000000000002', working_on: 'another session' },
  ],
  me: 'test-session',
})

const boardWorld = (on: On) => {
  const argv: string[][] = []
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] as AgentInfo[] }))
  on('process.run', (_$, e) => {
    argv.push([...e.argv])
    return { value: { exitCode: 0, stdout: BOARD, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const boards = () => argv.filter(one => one.includes('board'))
  return { argv, boards, settle: () => clock.advance(1) }
}

describe('agentic-os /os tabs: the board refresh', () => {
  test('T8 a press of tab-work starts one board read with the right argv; a press of another tab starts none', async ($, on) => {
    const { boards, settle } = boardWorld(on)
    const pane = await mountPane('terminal', $)
    await settle()
    const start = boards().length
    for (const key of ['tab-session', 'tab-plan', 'tab-proof', 'tab-decisions', 'tab-overview']) {
      await pane.press({ key })
      await settle()
    }
    expect(boards().length).toBe(start)
    await pane.press({ key: 'tab-work' })
    await settle()
    expect(boards().length).toBe(start + 1)
    const last = boards().at(-1)!
    expect(last[0]).toBe('node')
    expect(last[1]).toMatch(/continuous-claude[\\/]scripts[\\/]coordination[\\/]lane\.mjs$/)
    expect(last.slice(2)).toEqual(['board', '--json', '--as', 'test-session'])
    await pane.unmount()
  })

  test('T9 after a press of tab-work the tab draws my lane, the peer lane and "as of just now"', async ($, on) => {
    const { settle } = boardWorld(on)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-work' })
    await settle()
    const text = await drawn(pane)
    expect(text).toContain('You hold lane os-redesign: The pane')
    expect(text).toContain('tabs first')
    expect(text).toContain('Another session holds lane api-core')
    expect(text).toContain('as of just now')
    expect(text).not.toContain('lane board not read')
    await pane.unmount()
  })
})

// The Swarm tab (key 7). Runs come from a real spawn through the ledger (a workflow agent and a plain helper), not from a seeded atom.
const swarmWorld = (on: On) => {
  let lists = 0
  world(on, () => {
    lists += 1
  })
  on('session.root', () => ({ value: 'C:/r' }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.description === 'map the hooks' ? 'a-wf' : 'a-plain' }))
  return { lists: () => lists }
}

const spawn = ($: Engine, description: string, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description, subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra } as never)

describe('agentic-os /os tabs: the Swarm tab', () => {
  test('T10 a press of tab-swarm shows SWARM and the empty line; with a spawned workflow agent and a plain helper it shows both sections', async ($, on) => {
    swarmWorld(on)
    const pane = await mountPane('terminal', $)
    await pane.press({ key: 'tab-swarm' })
    let text = await drawn(pane)
    expect(text).toContain('SWARM')
    expect(text).toContain('no helpers yet this session')
    expect(text).not.toContain('GOAL')
    await spawn($, 'map the hooks', { workflow: { runId: 'wf_1', agentIndex: 1 } })
    await spawn($, 'review the plan')
    text = await drawn(pane)
    expect(text).toMatch(/SWARM\s*2 running · 0 done/)
    expect(text).toContain('1 running · a workflow')
    expect(text).toContain('map the hooks')
    expect(text).toMatch(/HELPERS[\s\S]*review the plan/)
    expect(text).not.toContain('no helpers yet this session')
    await pane.press({ key: 'tab-overview' })
    expect(await drawn(pane)).toContain('GOAL not set')
    await pane.unmount()
  })

  test('T11 a press of tab-swarm starts one agent.list read; a press of any other tab starts none', async ($, on) => {
    const { lists } = swarmWorld(on)
    const pane = await mountPane('terminal', $)
    const start = lists()
    for (const key of ['tab-session', 'tab-plan', 'tab-work', 'tab-proof', 'tab-decisions', 'tab-overview']) await pane.press({ key })
    expect(lists()).toBe(start)
    await pane.press({ key: 'tab-swarm' })
    expect(lists()).toBe(start + 1)
    await pane.press({ key: 'tab-swarm' })
    expect(lists()).toBe(start + 2)
    await pane.unmount()
  })

  for (const [name, end] of [['/clear', END_CLEAR], ['resume', END_RESUME]] as const) {
    test(`T12 ${name} with runs in the ledger: the pane opens on Overview, and Swarm lists the runs the ledger still holds`, async ($, on) => {
      swarmWorld(on)
      await spawn($, 'review the plan')
      const first = await mountPane('terminal', $)
      await first.press({ key: 'tab-swarm' })
      expect(await drawn(first)).toContain('review the plan')
      await first.unmount()
      await $.session.end(end)
      const after = await mountPane('terminal', $)
      expect(await drawn(after)).toContain('GOAL not set')
      expect(await drawn(after)).not.toContain('SWARM')
      await after.press({ key: 'tab-swarm' })
      const text = await drawn(after)
      expect(text).toContain('SWARM')
      expect(text).toContain('review the plan')
      await after.unmount()
    })
  }
})
