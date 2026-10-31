import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, CommandRunInput, On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the /os pane can fail, one test each. Every check reads the drawn pane.
// F7  a long task list scrolls the active task out of view
// F8  /os does not open the pane under the id the render hook draws, or the Work tab ignores the held lane
// F9  the Work tab ignores the lane board's answer (held, none, unreadable, or an answer in the old `mine` array shape)
// F10 the pane does not draw on terminal or desktop
// F11 finished agents still show as working (on the Session tab)
// F16 the Swarm tab does not list the runs a spawn put in the ledger
// F17 the journal does not give the Swarm tab its labels and phase, or the run file its name and phase total
// F18 the journal is read at any time but /os open and a Swarm press (a pulse, a press of another tab), or a press reads it more than once
// F19 a missing, unreadable, oversize or bad journal throws, blocks the pane, or leaves the tab without its counts
// F20 the journal feed leaks a prompt or result preview, or a secret in a label, a phase or the run name
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

const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', rows = 24, tab?: 'session' | 'plan' | 'work' | 'proof' | 'decisions' | 'swarm'): Promise<string[]> => {
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

  test('F16 /os, then a press of tab-swarm: the rows come from the runs a spawn put in the ledger', async ($, on) => {
    const { settle } = world(on)
    on('session.root', () => ({ value: 'C:/r' }))
    on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: e.workflow ? 'a-wf' : 'a-plain' }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    const spawn = (description: string, extra: Record<string, unknown> = {}) =>
      $.agent.spawn({ tool_use_id: 't', prompt: 'p', description, subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra } as never)
    await spawn('map the hooks', { workflow: { runId: 'wf_1', agentIndex: 1 } })
    await spawn('review the plan')
    await $.command.run(OS)
    await settle()
    const text = (await paneText($, 'terminal', 30, 'swarm')).join('\n')
    expect(text).toMatch(/SWARM\s*2 running · 0 done/)
    expect(text).toContain('1 running · a workflow')
    expect(text).toMatch(/map the hooks[\s\S]*HELPERS[\s\S]*review the plan/)
  })
})

// The journal behind the Swarm tab. The mod reads it with $.fs, at /os open and at a press of Swarm, and nowhere else.
const SID = 'test-session'
const JOURNAL = `C:/home/.claude/projects/C--r/${SID}/subagents/workflows/wf_1/journal.jsonl`
const RUNFILE = `C:/home/.claude/projects/C--r/${SID}/workflows/wf_1.json`
const WIDE = { ...PANE_PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } }
// Built at run time: gitleaks scans the source.
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

const jl = (...lines: Record<string, unknown>[]): string => lines.map(one => JSON.stringify(one)).join('\n') + '\n'
const started = (agentId: string, label: string, phase: string, extra: Record<string, unknown> = {}) => ({ type: 'started', key: 'k'.repeat(67), agentId, label, phase, ...extra })
const finished = (agentId: string) => ({ type: 'result', key: 'k'.repeat(67), agentId, result: { summary: 'RESULT-LEAK' }, toolsUsed: ['Read'] })

const journalWorld = (on: On, files: Record<string, string>, opts: { sizeOf?: (path: string) => number; readFails?: boolean } = {}) => {
  const reads: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  const runs = [
    { id: 'a-0', type: 'scout', description: 'task', status: 'done', startedAt: 1_000_000 - 600_000, endedAt: 1_000_000 - 300_000, workflowRunId: 'wf_1' },
    { id: 'a-1', type: 'scout', description: 'task', status: 'running', startedAt: 1_000_000 - 60_000, endedAt: null, workflowRunId: 'wf_1' },
  ].map(one => ({ model: 'claude-sonnet-5-5', effort: 'high', spec: {}, tokens: 0, costUsd: 0, drift: null, ...one }))
  on('state.get', { plugin: 'ccv3-mods', key: 'agentRuns' } as never, (() => ({ value: { value: runs, version: 1 } })) as never)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: 'C:/r' }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('agent.list', () => ({ value: [] as AgentInfo[] }))
  on('fs.stat', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    const text = files[path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: opts.sizeOf?.(path) ?? text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    reads.push(path)
    const text = files[path]
    if (text === undefined || opts.readFails) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  return { reads, journalReads: () => reads.filter(one => one === JOURNAL).length, settle: () => clock.advance(1), advance: (ms: number) => clock.advance(ms) }
}

const mountWide = ($: Engine) => $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'Pane', requestId: 'agentic-os', props: WIDE, viewport: { columns: 100, rows: 30 } })

const swarmText = async ($: Engine): Promise<string> => {
  const pane = await mountWide($)
  await pane.press({ key: 'tab-swarm' })
  const text = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
  await pane.unmount()
  return text
}

const JOURNAL_TEXT = jl({ type: 'launched' }, started('a-0', 'map-hooks', 'Map'), finished('a-0'), started('a-1', 'judge-the-maps', 'Judge'))

describe('agentic-os Swarm tab: the journal feed', () => {
  test('F17 the journal gives the labels and the phase; the run file, when the run has ended, gives the name and the phase total', async ($, on) => {
    const files: Record<string, string> = { [JOURNAL]: JOURNAL_TEXT }
    const { settle } = journalWorld(on, files)
    await $.command.run(OS)
    await settle()
    let text = await swarmText($)
    expect(text).toContain('judge-the-maps')
    expect(text).toContain('1 running, 1 done · phase 2: Judge · a workflow')
    expect(text).not.toMatch(/\btask\b/)
    files[RUNFILE] = JSON.stringify({ runId: 'wf_1', workflowName: 'pane-assess', status: 'completed', phases: [{ title: 'Map', detail: 'd' }, { title: 'Judge', detail: 'd' }] })
    await $.command.run(OS)
    await settle()
    text = await swarmText($)
    expect(text).toContain('1 running, 1 done · phase 2 of 2: Judge · pane-assess')
  })

  test('F18 the journal is read at /os open and at a press of Swarm, once each: not by a pulse, not by a press of another tab', async ($, on) => {
    const { journalReads, settle, advance } = journalWorld(on, { [JOURNAL]: JOURNAL_TEXT })
    await $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true } as never)
    await $.command.run(OS)
    await settle()
    expect(journalReads()).toBe(1)
    // Idle pulses (a run is still running, so they re-read the agents), then the pulses of a running turn.
    await advance(30_000)
    await $.turn.start({ turnId: 't1' } as never)
    await advance(30_000)
    const pane = await mountWide($)
    for (const key of ['tab-session', 'tab-plan', 'tab-work', 'tab-proof', 'tab-decisions', 'tab-overview']) await pane.press({ key })
    await advance(30_000)
    expect(journalReads()).toBe(1)
    await pane.press({ key: 'tab-swarm' })
    await settle()
    expect(journalReads()).toBe(2)
    await advance(30_000)
    expect(journalReads()).toBe(2)
    await pane.unmount()
  })

  const BAD_CASES: [string, Record<string, string>, { sizeOf?: (path: string) => number; readFails?: boolean }][] = [
    ['missing', {}, {}],
    ['oversize', { [JOURNAL]: JOURNAL_TEXT }, { sizeOf: () => 50_000_000 }],
    ['unreadable', { [JOURNAL]: JOURNAL_TEXT }, { readFails: true }],
    ['bad lines', { [JOURNAL]: 'not json\n{"type":\n[1,2]\nnull\n' }, {}],
  ]
  for (const [name, files, opts] of BAD_CASES) {
    test(`F19 a ${name} journal: no throw, and the tab keeps its counts`, async ($, on) => {
      const { settle, reads } = journalWorld(on, files, opts)
      await $.command.run(OS)
      await settle()
      const text = await swarmText($)
      expect(text).toContain('1 running, 1 done · a workflow')
      expect(text).toContain('SWARM')
      if (name === 'oversize') expect(reads).not.toContain(JOURNAL)
    })
  }

  test('F20 a prompt or result preview, and a secret in a label, a phase or the run name, never reach the pane', async ($, on) => {
    const files: Record<string, string> = {
      [JOURNAL]: jl(started('a-1', `label ${SECRET}`, `phase ${SECRET}`, { promptPreview: 'PROMPT-LEAK', prompt: 'PROMPT-LEAK' }), finished('a-1')),
      [RUNFILE]: JSON.stringify({
        runId: 'wf_1',
        workflowName: `name ${SECRET}`,
        phases: [{ title: 'P', detail: 'DETAIL-LEAK' }],
        workflowProgress: [{ type: 'workflow_agent', promptPreview: 'PROMPT-LEAK', resultPreview: 'RESULT-LEAK' }],
      }),
    }
    const { settle } = journalWorld(on, files)
    await $.command.run(OS)
    await settle()
    const text = await swarmText($)
    expect(text).toContain('label')
    expect(text).toContain('name')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('a'.repeat(20))
    for (const leak of ['PROMPT-LEAK', 'RESULT-LEAK', 'DETAIL-LEAK']) expect(text).not.toContain(leak)
  })
})
