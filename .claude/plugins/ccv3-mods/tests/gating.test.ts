import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Where the Agentic OS mod runs, one test each. Every check reads what the
// engine was asked to do (a timer's work, a spawned process, a file write).
// G1 headless: the 5 s pulse is armed, so a `-p` job pays for agent reads it never draws
// G2 headless: lane.mjs is spawned at session start
// G3 headless: a lane.mjs Bash call spawns a lane read later
// G4 headless: capture or the snapshot stops, so the dashboard loses `-p` jobs
// G5 interactive: gating by accident turns the pulse or the lane read off
// G6 CCV3_MODS_OFF=1: any hook still acts (command, timer, spawn, snapshot, band, answer)
// G7 CCV3_MODS_OFF set to anything but 1 switches the mod off
// G8 the pulse is armed by session.start itself, so a reload (which re-runs it) re-arms it
// G9 headless: a turn that made no task or plan change writes a snapshot, so every -p job fills the folder
// G10 headless: a turn after a task change stops writing its snapshot
// G11 interactive: a turn with no task still writes its snapshot, so the dashboard sees the live session

type Calls = { run: string[][]; agentList: number; writes: { path: string; text: string }[]; commands: string[] }

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  const calls: Calls = { run: [], agentList: 0, writes: [], commands: [] }
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    calls.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    calls.run.push([...e.argv])
    return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => {
    calls.agentList += 1
    return { value: [] }
  })
  on('command.register', (_$, e) => {
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: '1', subject: e.subject } } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  // A Glob call that stays open until the test lets it go, so a turn is running when the pulse fires.
  let release = () => {}
  on('tool.call', { tool: 'Glob' }, () =>
    new Promise(resolve => {
      release = () => resolve({ result: { durationMs: 1, numFiles: 0, filenames: [], truncated: false } })
    }),
  )
  return { clock, calls, release: () => release() }
}

const start = ($: Engine, isInteractive: boolean) =>
  $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })

/** Starts the held Glob call; the returned function lets it finish. */
const holdOneCall = ($: Engine, release: () => void) => {
  const call = $.tool.call({ tool: 'Glob', pattern: 'x/**' })
  return async () => {
    release()
    await call
  }
}

const bandText = async ($: Engine): Promise<string | undefined> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const text = (await band.find({ key: 'row-band' }))?.text
  await band.unmount()
  return text
}

// The engine hands the write over with the platform's separators.
const snapshotWrites = (calls: Calls) => calls.writes.filter(write => /[\\/]test-session\.json$/.test(write.path))

describe('agentic-os headless gate', () => {
  test('G1 G2 headless arms no timer and spawns nothing at session start', async ($, on) => {
    const { clock, calls, release } = world(on)
    await start($, false)
    const finish = holdOneCall($, release)
    await clock.advance(20_000)
    await finish()
    expect(calls.agentList).toBe(0)
    expect(calls.run).toEqual([])
  })

  test('G3 headless: a lane.mjs Bash call spawns no lane read', async ($, on) => {
    const { clock, calls } = world(on)
    await start($, false)
    await $.tool.call({ tool: 'Bash', command: 'node scripts/coordination/lane.mjs next' })
    await clock.advance(1)
    expect(calls.run).toEqual([])
  })

  test('G4 headless still captures tasks and writes the snapshot', async ($, on) => {
    const { calls } = world(on)
    await start($, false)
    await $.tool.call({ tool: 'TaskCreate', subject: 'probe the gate', description: 'd' })
    const [snapshot] = snapshotWrites(calls)
    expect(snapshot?.text).toContain('probe the gate')
  })

  test('G9 headless: a turn that changed no task or plan writes no snapshot', async ($, on) => {
    const { calls } = world(on)
    await start($, false)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    expect(snapshotWrites(calls)).toEqual([])
  })

  test('G10 headless: a turn after a task change still writes its snapshot', async ($, on) => {
    const { calls } = world(on)
    await start($, false)
    await $.tool.call({ tool: 'TaskCreate', subject: 'kept', description: 'd' })
    const before = snapshotWrites(calls).length
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    expect(snapshotWrites(calls).length).toBe(before + 1)
  })

  test('G11 interactive: a turn with no task still writes its snapshot', async ($, on) => {
    const { calls } = world(on)
    await start($, true)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    expect(snapshotWrites(calls).length).toBe(1)
  })

  test('G5 G8 interactive arms the pulse and reads the lane board at session start', async ($, on) => {
    const { clock, calls, release } = world(on)
    await start($, true)
    await clock.advance(1)
    expect(calls.run.some(argv => argv.some(part => part.endsWith('lane.mjs')))).toBe(true)
    const finish = holdOneCall($, release)
    await clock.advance(5_000)
    await finish()
    expect(calls.agentList).toBeGreaterThan(0)
  })

  test('G5 interactive: a lane.mjs Bash call still refreshes the lane read', async ($, on) => {
    const { clock, calls } = world(on)
    await start($, true)
    await clock.advance(1)
    const before = calls.run.length
    await $.tool.call({ tool: 'Bash', command: 'node scripts/coordination/lane.mjs next' })
    await clock.advance(1)
    expect(calls.run.length).toBeGreaterThan(before)
  })
})

describe('agentic-os opt-out', () => {
  test('G6 CCV3_MODS_OFF=1 leaves every hook passing through', async ($, on) => {
    const { clock, calls, release } = world(on, { CCV3_MODS_OFF: '1' })
    await start($, true)
    const finish = holdOneCall($, release)
    await clock.advance(20_000)
    const ran = await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' })
    await finish()
    expect(ran.result).toEqual({ task: { id: '1', subject: 'x' } })
    expect(calls.commands).toEqual([])
    expect(calls.run).toEqual([])
    expect(calls.agentList).toBe(0)
    expect(calls.writes).toEqual([])
    expect(await bandText($)).toBeUndefined()
  })

  test('G7 CCV3_MODS_OFF=0 keeps the mod on', async ($, on) => {
    const { calls } = world(on, { CCV3_MODS_OFF: '0' })
    await start($, true)
    await $.tool.call({ tool: 'TaskCreate', subject: 'still on', description: 'd' })
    expect(calls.commands).toEqual(['os'])
    expect(snapshotWrites(calls).length).toBe(1)
    expect(await bandText($)).toContain('0/1 done')
  })
})
