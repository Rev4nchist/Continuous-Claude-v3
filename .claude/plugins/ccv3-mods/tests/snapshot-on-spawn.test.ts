import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Fix 4 of the status band (card coord-status-band-2): the state file holds a helper the moment it starts.
// Design: .claudedocs/coordination/2026-11-18-coord-status-band-2-fix4-design-rev2.md (rev 2; failure list in its section 3, items 1 to 11).
// Every test runs the whole mod: a real agent.spawn or turn.start through the engine, and the snapshot file the mod writes.
// The throttle alone (pure functions, every branch) is in snapshot-port.test.ts. Where the code lives: agent-ledger agent.spawn and the subagent
// turn.start bump the `snapshotWanted` atom (hooks/shared/snapshot-port.ts); the state.set hook of that atom in hooks/agentic-os/index.tsx reads the
// engine clock, applies the 2 s throttle, writes, and arms the trailing timer.
//
// Ways it can fail, one test each, with the change that breaks it. RED = fails on the code before the port; GUARD = passes before it
// (nothing writes at a spawn yet) and fails when the named change is made:
// F1  RED   a spawn writes no snapshot: the requestSnapshot call in agent-ledger agent.spawn is removed, or the state.set hook does not write
// F2  RED   a resumed subagent turn writes no snapshot: the requestSnapshot call in the subagent turn.start branch is removed
// F3  RED   a burst of 50 spawns writes 50 files, or none: the `decide` throttle in the state.set hook is removed, or the hook never writes
// F4  RED   the trailing write is lost: the `$.clock.after` arm in the state.set hook is removed or its delay is wrong
// F5  (snapshot-port.test.ts, 'U5 / F5') no listener for snapshotWanted: the real agent-ledger hook runs alone on a stub `$`; the answer is unchanged, nothing throws, no file is written
// F6a GUARD (weak) a refused state write reaches the spawn. The engine skips a hook that throws and ignored a `deny` here, so the bump itself cannot be made to fail: only the spawn result, the count and the ledger are checked
// F6b GUARD a timer that cannot be armed reaches the spawn: the try/catch in the state.set hook and the one in requestSnapshot are both removed
// F7  GUARD a spawn after the session end rewrites the final file: writeSnapshot's endedIds check is removed
// F8  GUARD a headless run with no brief writes a file at a spawn: the state.set hook skips worthSnapshot
// F8b RED   the same headless run WITH a brief writes none: the state.set hook does not write (the control of F8)
// F9  GUARD the spawn answer changes: agent-ledger returns what requestSnapshot returns
// F10 RED   the throttle runs on the wall clock: Date.now replaces $.clock.now in the state.set hook
// F11 GUARD a trailing write due before the session end lands after it: session.end does not set wishes.dueAt = null AND endedIds is not set
// F12 RED   a trailing timer armed before a /clear writes into the next session's file: session.end does not set wishes.dueAt = null (fails before the disarm)
// F13 GUARD the bump runs before the spec update: the snapshot of a spawn then misses the agent file's model and effort (agent-ledger order)
// F14 RED   the spawn waits for the snapshot file: `void` is dropped in agent-ledger (the first spawn of a window then waits for the write)
// F15 RED   a second session in the same module starts with the first one's throttle: session.start does not reset `wishes`
// F16 GUARD the off switch writes at a spawn: the ledger's own isOff is removed. The isOff in the state.set hook is not reachable from a test: both callers check it first, and a bump from the test's `$` is refused (an atom of the plugin)

const T0 = 1_000
const SESSION = 's1'
const DIR = '/agentic-os/'
const AGENT_MD = '---\nname: scout\nmodel: sonnet\neffort: high\n---\nbody\n'
const AGENT_PATH = /\/repo\/\.claude\/agents\/scout\.md$/
const norm = (path: string) => path.replace(/\\/g, '/')

type Seen = {
  clock: ReturnType<typeof mock.clock>
  writes: { path: string; text: string }[]
  spawned: number
  sid: string
  /** The snapshotWanted write throws (the engine below the plugin's hook). */
  failState: boolean
  /** The engine refuses a timer. */
  failAfter: boolean
  /** A state file write waits for this promise. */
  hold: Promise<void> | null
  /** The text of the agent file scout.md, or null for no file. */
  agentMd: string | null
}

const world = (on: On, env: Record<string, string> = {}): Seen => {
  const seen: Seen = { clock: mock.clock(on, { now: T0 }), writes: [], spawned: 0, sid: SESSION, failState: false, failAfter: false, hold: null, agentMd: null }
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: seen.sid }))
  on('session.root', () => ({ value: '/repo' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('fs.exists', (_$, e) => ({ value: seen.agentMd !== null && AGENT_PATH.test(norm(e.path)) }))
  on('fs.read', (_$, e) => {
    if (seen.agentMd !== null && AGENT_PATH.test(norm(e.path))) return { value: seen.agentMd }
    throw new Error('ENOENT')
  })
  on('fs.write', async (_$, e) => {
    if (seen.hold !== null && norm(e.path).includes(DIR)) await seen.hold
    seen.writes.push({ path: norm(e.path), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++seen.spawned}` }))
  on('state.set', { plugin: 'ccv3-mods', key: 'snapshotWanted' } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => {
    if (seen.failState) return { deny: 'state refused' }
    return next(e)
  }) as never)
  // mock.clock holds the one unmatched clock.after; the trailing timer of a burst at one instant is exactly 2000 ms (the pulse uses every).
  on('clock.after', { ms: 2000 } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => {
    if (seen.failAfter) return { deny: 'timer refused' }
    return next(e)
  }) as never)
  return seen
}

type Run = { id: string; status: string; spec?: { model?: string; effort?: string } }
const filesOf = (seen: Seen, id: string) => seen.writes.filter(write => write.path.endsWith(`${DIR}${id}.json`))
const files = (seen: Seen) => filesOf(seen, SESSION)
const lastFile = (seen: Seen): { agentRuns?: Run[]; endedAt?: number } => JSON.parse(files(seen).at(-1)?.text ?? '{}')
const runsOf = (seen: Seen): Run[] => lastFile(seen).agentRuns ?? []
/** Every file the mod writes under its state folder, whatever the session id. */
const anyState = (seen: Seen) => seen.writes.filter(write => write.path.includes(DIR))

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
const spawnRaw = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
/** A spawn, then the bump it leaves behind (agent-ledger does not wait for it) is let finish. */
const spawn = async ($: Engine, seen: Seen) => {
  const answer = await spawnRaw($)
  await seen.clock.settle()
  return answer
}
const finish = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId, reason: 'end_turn' } as never)
const resume = ($: Engine, agentId: string) => $.turn.start({ turnId: 'sub2', agentId } as never)
const end = ($: Engine, reason = 'other') => $.session.end({ reason, sessionId: SESSION, resume: { id: SESSION } } as never)
// The pulse writes every 5 seconds: every test keeps the clock under that after `start`, so only the port can explain a file.
const later = async (seen: Seen, ms: number) => {
  await seen.clock.advance(ms)
  await seen.clock.settle()
}
/** The real timer (the mock clock does not move it): the test waits real time to see that a spawn answer does not come. */
const wall = (fn: () => void, ms: number) => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(fn, ms)
const ANSWER = JSON.stringify({ model: 'claude-sonnet-5-5', agentId: 'a1' })
const ledgerText = async ($: Engine) => {
  const pane = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'desktop', component: 'Pane', requestId: 'ledger', props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: { columns: 80, rows: 40 } })
  const text = (await pane.findAll({ type: 'Box' })).map(found => found.text).join('\n')
  await pane.unmount()
  return text
}

describe('snapshot at a helper start', () => {
  test('F1 a spawn writes a snapshot that holds the new run', async ($, on) => {
    const seen = world(on)
    await start($)
    const before = files(seen).length
    await spawn($, seen)
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toEqual(['a1'])
    expect(runsOf(seen)[0]?.status).toBe('running')
  })

  test('F2 a resumed subagent turn writes a snapshot with the run running', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    await finish($, 'a1')
    expect(runsOf(seen)[0]?.status).not.toBe('running')
    await later(seen, 3_000)
    await resume($, 'a1')
    await seen.clock.settle()
    expect(runsOf(seen)[0]?.status).toBe('running')
  })

  test('F3 a burst of 50 spawns writes between 1 and 3 files', async ($, on) => {
    const seen = world(on)
    await start($)
    const before = files(seen).length
    for (let i = 0; i < 50; i++) await spawn($, seen)
    await later(seen, 2_500)
    const added = files(seen).length - before
    expect(added).toBeGreaterThanOrEqual(1)
    expect(added).toBeLessThanOrEqual(3)
  })

  test('F4 the last spawn of a burst is in the last file (the trailing write)', async ($, on) => {
    const seen = world(on)
    await start($)
    for (let i = 0; i < 50; i++) await spawn($, seen)
    await later(seen, 2_500)
    expect(runsOf(seen).map(run => run.id)).toContain('a50')
    expect(runsOf(seen).filter(run => run.status === 'running')).toHaveLength(50)
  })

  test('F10 the window is the engine clock: a spawn 2.5 s later on the mock clock writes at once', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    await later(seen, 2_500)
    const before = files(seen).length
    await spawn($, seen)
    // No further advance: a throttle on Date.now (a few ms apart in real time) would hold this write back.
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toContain('a2')
  })

  test('F13 the spawn snapshot holds the spec of the agent file (the bump comes after the spec update)', async ($, on) => {
    const seen = world(on)
    seen.agentMd = AGENT_MD
    await start($)
    await spawn($, seen)
    expect(runsOf(seen)[0]?.spec).toEqual({ model: 'sonnet', effort: 'high' })
  })

  test('F6a a state write that throws leaves the spawn answer unchanged, the spawn counted and the run recorded', async ($, on) => {
    const seen = world(on)
    seen.failState = true
    await start($)
    const answer = await spawn($, seen)
    await spawn($, seen)
    await later(seen, 2_500)
    expect(JSON.stringify(answer)).toBe(ANSWER)
    expect(seen.spawned).toBe(2)
    // Not asserted: the files. A deny from a hook below did not stop the write in this engine, so the bump may succeed here.
    expect(await ledgerText($)).toContain('RUNNING · 2')
  })

  test('F6b a timer the engine refuses leaves the spawn answer unchanged, the spawn counted and the run recorded', async ($, on) => {
    const seen = world(on)
    seen.failAfter = true
    await start($)
    const answer = await spawn($, seen)
    // The first spawn writes; the second is inside the window and would arm the trailing timer.
    await spawn($, seen)
    await later(seen, 2_500)
    expect(JSON.stringify(answer)).toBe(ANSWER)
    expect(seen.spawned).toBe(2)
    expect(files(seen).length).toBeGreaterThan(0)
    expect(await ledgerText($)).toContain('RUNNING · 2')
  })

  test('F9 the spawn answer is the one the engine gave, byte for byte', async ($, on) => {
    const seen = world(on)
    await start($)
    const answer = await spawn($, seen)
    expect(JSON.stringify(answer)).toBe(ANSWER)
    expect(seen.spawned).toBe(1)
  })

  test('F14 the spawn answer comes back while the snapshot file write is still pending', async ($, on) => {
    const seen = world(on)
    await start($)
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const outcome = await Promise.race([spawnRaw($).then(() => 'answered'), new Promise<string>(resolve => wall(() => resolve('pending'), 500))])
    release()
    await seen.clock.settle()
    expect(outcome).toBe('answered')
    expect(runsOf(seen).map(run => run.id)).toEqual(['a1'])
  })
})

describe('snapshot at a helper start: when the writer must stay quiet', () => {
  test('F8 a headless run with no brief, no task and no plan writes no file at a spawn', async ($, on) => {
    const seen = world(on)
    await start($, false)
    const before = anyState(seen).length
    await spawn($, seen)
    await spawn($, seen)
    await later(seen, 2_500)
    expect(anyState(seen).length).toBe(before)
  })

  test('F8b the same headless run with a brief does write at a spawn (the control of F8)', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.tool.call({ tool: 'mcp__ccv3-mods__brief_set', goal: 'g' } as never)
    const before = files(seen).length
    expect(before).toBeGreaterThan(0)
    await spawn($, seen)
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toEqual(['a1'])
  })

  test('F7 after the session end began, a spawn writes nothing, now or later', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    await end($)
    const ended = files(seen).length
    expect(lastFile(seen).endedAt).toBeDefined()
    await later(seen, 2_500)
    await spawn($, seen)
    await spawn($, seen)
    await later(seen, 2_500)
    expect(files(seen)).toHaveLength(ended)
    expect(lastFile(seen).endedAt).toBeDefined()
  })

  test('F11 a trailing write that was due before the session end does not land after it', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    // The second spawn is inside the window: it leaves a trailing write for 2 s after the first.
    await spawn($, seen)
    await end($)
    const final = files(seen).at(-1)?.text
    const ended = files(seen).length
    expect(JSON.parse(final ?? '{}').endedAt).toBeDefined()
    await later(seen, 2_500)
    expect(files(seen)).toHaveLength(ended)
    expect(files(seen).at(-1)?.text).toBe(final)
  })

  test('F12 a trailing write armed before a /clear does not write the next session (new id) when its timer fires', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    await spawn($, seen)
    await end($, 'clear')
    // After /clear the process goes on under a new id. The old timer must not write that id's file.
    seen.sid = 's2'
    await later(seen, 2_500)
    expect(filesOf(seen, 's2')).toHaveLength(0)
  })

  test('F15 a second session in the same process starts with an open throttle: its first spawn writes at once', async ($, on) => {
    const seen = world(on)
    await start($)
    await spawn($, seen)
    // Same instant, a new session: the first session's write time must not hold this one back.
    await start($)
    const before = files(seen).length
    await spawn($, seen)
    expect(files(seen).length).toBeGreaterThan(before)
    expect(runsOf(seen).map(run => run.id)).toContain('a2')
  })

  test('F16 the off switch: a spawn writes nothing and its answer is unchanged', async ($, on) => {
    const seen = world(on, { CCV3_MODS_OFF: '1' })
    await start($)
    const answer = await spawn($, seen)
    await spawn($, seen)
    await later(seen, 2_500)
    expect(JSON.stringify(answer)).toBe(ANSWER)
    expect(anyState(seen)).toHaveLength(0)
  })
})
