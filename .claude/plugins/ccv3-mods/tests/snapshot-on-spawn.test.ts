import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Fix 4 of the status band (card coord-status-band-2): the state file holds a helper the moment it starts.
// Design: .claudedocs/coordination/2026-11-16-coord-status-band-2-fix4-design.md, section 4 (items 1 to 10) and 6 (item 11).
// Every test runs the whole mod: a real agent.spawn or turn.start through the engine, and the snapshot file the mod writes.
// The port alone (a stub clock, every branch of the throttle) is in snapshot-port.test.ts.
//
// Ways it can fail, one test each, with the change that breaks it. RED = fails on the code before the port; GUARD = passes before it
// (nothing writes at a spawn yet) and fails when the named change is made:
// F1  RED   a spawn writes no snapshot: the requestSnapshot call in agent-ledger agent.spawn is removed, or the writer is not registered
// F2  RED   a resumed subagent turn writes no snapshot: the requestSnapshot call in the turn.start branch for a subagent is removed
// F3  RED   a burst of 50 spawns writes 50 files, or none: the throttle in snapshot-port.ts is removed, or the writer is never called
// F4  RED   the trailing write is lost: the last spawn of a burst is not in the last file
// F5  (in snapshot-port.test.ts, U6) no listener or no state: the bump throws nothing. The mod always loads its listener, so "no listener" is shown as a bump on a `$` with no state
// F6  GUARD a failing snapshot write reaches the spawn: the try/catch in the state.set hook or in the port is removed (here: the writes throw)
// F7  GUARD a spawn after the session end rewrites the final file: the writer skips the endedIds check (it is writeSnapshot's own)
// F8  GUARD a headless run with no brief writes a file at a spawn: the registered writer skips worthSnapshot
// F8b RED   the same headless run WITH a brief writes none: the writer is not registered at all (the control of F8)
// F9  GUARD the spawn answer changes: agent-ledger returns what requestSnapshot returns, or awaits a throw
// F10 RED   the throttle runs on the wall clock: Date.now replaces $.clock.now in snapshot-port.ts
// F11 GUARD a trailing write that was due before the session end lands after it

const T0 = 1_000
const SESSION = 's1'
const DIR = '/agentic-os/'

type Seen = { clock: ReturnType<typeof mock.clock>; writes: { path: string; text: string }[]; spawned: number; failWrites: boolean }

const world = (on: On, env: Record<string, string> = {}): Seen => {
  const seen: Seen = { clock: mock.clock(on, { now: T0 }), writes: [], spawned: 0, failWrites: false }
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: '/repo' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_$, e) => {
    if (seen.failWrites && e.path.replace(/\\/g, '/').includes(DIR)) throw new Error('disk full')
    seen.writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++seen.spawned}` }))
  return seen
}

type Run = { id: string; status: string }
const files = (seen: Seen) => seen.writes.filter(write => write.path.endsWith(`${DIR}${SESSION}.json`))
const lastFile = (seen: Seen): { agentRuns?: Run[]; endedAt?: number } => JSON.parse(files(seen).at(-1)?.text ?? '{}')
const runsOf = (seen: Seen): Run[] => lastFile(seen).agentRuns ?? []
/** Every file the mod writes under its state folder, whatever the session id. */
const anyState = (seen: Seen) => seen.writes.filter(write => write.path.includes(DIR))

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
const spawn = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
const finish = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId, reason: 'end_turn' } as never)
const resume = ($: Engine, agentId: string) => $.turn.start({ turnId: 'sub2', agentId } as never)
// The pulse writes every 5 seconds: every test keeps the clock under that after `start`, so only the port can explain a file.
const later = async (seen: Seen, ms: number) => {
  await seen.clock.advance(ms)
  await seen.clock.settle()
}

describe('snapshot at a helper start', () => {
  test('F1 a spawn writes a snapshot that holds the new run', async ($, on) => {
    const seen = world(on)
    await start($)
    const before = files(seen).length
    await spawn($)
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toEqual(['a1'])
    expect(runsOf(seen)[0]?.status).toBe('running')
  })

  test('F2 a resumed subagent turn writes a snapshot with the run running', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($)
    await finish($, 'a1')
    expect(runsOf(seen)[0]?.status).not.toBe('running')
    await later(seen, 3_000)
    await resume($, 'a1')
    expect(runsOf(seen)[0]?.status).toBe('running')
  })

  test('F3 a burst of 50 spawns writes between 1 and 3 files', async ($, on) => {
    const seen = world(on)
    await start($)
    const before = files(seen).length
    for (let i = 0; i < 50; i++) await spawn($)
    await later(seen, 2_500)
    const added = files(seen).length - before
    expect(added).toBeGreaterThanOrEqual(1)
    expect(added).toBeLessThanOrEqual(3)
  })

  test('F4 the last spawn of a burst is in the last file (the trailing write)', async ($, on) => {
    const seen = world(on)
    await start($)
    for (let i = 0; i < 50; i++) await spawn($)
    await later(seen, 2_500)
    expect(runsOf(seen).map(run => run.id)).toContain('a50')
    expect(runsOf(seen).filter(run => run.status === 'running')).toHaveLength(50)
  })

  test('F10 the window is the engine clock: a spawn 2.5 s later on the mock clock writes at once', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($)
    await later(seen, 2_500)
    const before = files(seen).length
    await spawn($)
    // No further advance: a throttle on Date.now (a few ms apart in real time) would hold this write back.
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toContain('a2')
  })

  test('F6 a snapshot write that fails (disk full) leaves the spawn answer unchanged, and the run is still recorded', async ($, on) => {
    const seen = world(on)
    seen.failWrites = true
    await start($)
    const answer = await spawn($)
    await spawn($)
    await later(seen, 2_500)
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    expect(anyState(seen)).toHaveLength(0)
    expect(await $.ui.mount({ plugin: 'ccv3-mods', surface: 'desktop', component: 'Pane', requestId: 'ledger', props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: { columns: 80, rows: 40 } }).then(async pane => {
      const text = (await pane.findAll({ type: 'Box' })).map(found => found.text).join('\n')
      await pane.unmount()
      return text
    })).toContain('RUNNING · 2')
  })

  test('F9 the spawn answer is the one the engine gave, byte for byte', async ($, on) => {
    const seen = world(on)
    await start($)
    const answer = await spawn($)
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    expect(seen.spawned).toBe(1)
  })
})

describe('snapshot at a helper start: when the writer must stay quiet', () => {
  test('F8 a headless run with no brief, no task and no plan writes no file at a spawn', async ($, on) => {
    const seen = world(on)
    await start($, false)
    const before = anyState(seen).length
    await spawn($)
    await spawn($)
    await later(seen, 2_500)
    expect(anyState(seen).length).toBe(before)
  })

  test('F8b the same headless run with a brief does write at a spawn (the control of F8)', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.tool.call({ tool: 'mcp__ccv3-mods__brief_set', goal: 'g' } as never)
    const before = files(seen).length
    expect(before).toBeGreaterThan(0)
    await spawn($)
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toEqual(['a1'])
  })

  test('F7 after the session end began, a spawn writes nothing, now or later', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($)
    await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } } as never)
    const ended = files(seen).length
    expect(lastFile(seen).endedAt).toBeDefined()
    await later(seen, 2_500)
    await spawn($)
    await spawn($)
    await later(seen, 2_500)
    expect(files(seen)).toHaveLength(ended)
    expect(lastFile(seen).endedAt).toBeDefined()
  })

  test('F11 a trailing write that was due before the session end does not land after it', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($)
    // The second spawn is inside the window: it leaves a trailing write for 2 s after the first.
    await spawn($)
    await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } } as never)
    const final = files(seen).at(-1)?.text
    const ended = files(seen).length
    expect(JSON.parse(final ?? '{}').endedAt).toBeDefined()
    await later(seen, 2_500)
    expect(files(seen)).toHaveLength(ended)
    expect(files(seen).at(-1)?.text).toBe(final)
  })
})
