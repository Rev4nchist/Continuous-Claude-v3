import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the Agentic OS capture can fail, one test each. Every check reads the
// band the person sees, not the state behind it.
// F1 a TaskCreate result is not folded in (wrong field path), so the count is wrong
// F2 a TaskUpdate status is not applied, or a deleted task stays counted
// F3 a failed TaskUpdate (success false) still changes the band
// F4 a TodoWrite list does not replace the task list
// F5 the band draws on an idle session
// F6 the observer changes the tool's answer

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

// The engine beneath the plugin: a clock, no home folder (so no snapshot
// file), and an empty band when the plugin passes on.
const world = (on: On) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
}

const bandOn = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string | undefined> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const text = (await band.find({ key: 'row-band' }))?.text
  await band.unmount()
  return text
}

describe('agentic-os capture', () => {
  test('F1 F2 a created task counts, shows as active, then drops out on delete', async ($, on) => {
    world(on)
    let next = 0
    on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }))
    on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
      result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
    }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'scaffold', description: 'd', activeForm: 'Scaffolding' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'probe', description: 'd' })
    expect(await bandOn($)).toContain('0/2 done')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    expect(await bandOn($)).toContain('▶ Scaffolding')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
    expect(await bandOn($)).toContain('1/1 done')
  })

  test('F3 a failed TaskUpdate leaves the band as it was', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
      result: { success: false, taskId: e.taskId, updatedFields: [], error: 'no such task' },
    }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    expect(await bandOn($)).toContain('0/1 done')
  })

  test('F4 TodoWrite replaces the list with its new todos', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'old' } } }))
    on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'old', description: 'd' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'one', status: 'completed', activeForm: 'Doing one' },
        { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
        { content: 'three', status: 'pending', activeForm: 'Doing three' },
      ],
    })
    const text = await bandOn($)
    expect(text).toContain('1/3 done')
    expect(text).toContain('▶ Doing two')
  })

  test('F6 the observer hands the tool answer on unchanged', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'x' } } }))

    const ran = await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' })
    expect(ran.result).toEqual({ task: { id: '7', subject: 'x' } })
  })
})

describe('agentic-os band', () => {
  test('F5 quiet while idle, drawn on terminal and desktop once tasks exist', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandOn($, surface)).toBeUndefined()
    }

    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })

    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandOn($, surface)).toContain('0/1 done')
    }
  })
})

// The two core lines of the band (PRD 5.3), through the whole mod. Every check reads what the person sees.
// C1 a session with no brief draws no GOAL not set, or draws nothing at all while idle
// C2 a brief_set goal does not replace GOAL not set, or the ASK and UNPROVEN counts stay at zero
// C3 a seeded secret in a goal or an ask (brief_set or the turn-end parser) reaches a drawn Text
// C4 repo, branch and worktree are not read at the session start, or not re-read at a turn start, or not in the snapshot
// C5 a git read that fails reaches the session, or leaves something other than null in the snapshot
// C6 the existing widget line (row-band) is dropped or moved above the core lines, or the rows do not give way
// C7 repo and branch stay `-` in the band after an in-session /resume (classic.SessionStart, no session.start) until the first prompt
// C8 the same after /clear
// C9 a compaction (classic.SessionStart source compact) triggers an extra .git read
// C10 the off switch (CCV3_MODS_OFF) does not stop the .git read at classic.SessionStart for resume and clear

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

const core = async ($: Engine, columns = 120, maxRows = BAND_PROPS.maxRows) => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: columns, maxRows } })
  const rows = (await band.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-'))
  const texts = (await band.findAll({ type: 'Text' })).map(found => found.text)
  await band.unmount()
  const text = (key: string) => rows.find(found => found.key === key)?.text
  return { keys: rows.map(found => found.key), line1: text('row-core-1'), line2: text('row-core-2'), widget: text('row-band'), texts, all: rows.map(found => found.text).join('\n') }
}

describe('agentic-os core band', () => {
  test('C1 a session with no brief draws both core lines with GOAL not set, idle, and no widget line', async ($, on) => {
    world(on)
    const got = await core($)
    expect(got.line1).toContain('IDLE')
    expect(got.line2).toContain('GOAL not set')
    expect(got.line2).toMatch(/PLAN [▱]+ 0\/0/)
    expect(got.widget).toBeUndefined()
    expect(got.keys.indexOf('row-core-1')).toBeLessThan(got.keys.indexOf('row-core-2'))
  })

  test('C2 a brief_set goal shows, and open asks and a done task with no proof are counted', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'build' } } }))
    on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true } }))
    await $.tool.call({ tool: 'TaskCreate', subject: 'build', description: 'd' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove P1a', ask: [{ kind: 'question', text: 'Which branch?' }] })
    const got = await core($)
    expect(got.line2).toContain('GOAL prove P1a')
    expect(got.line2).not.toContain('not set')
    expect(got.line2).toContain('ASK 1')
    expect(got.line2).toContain('UNPROVEN 1')
    expect(got.line2).toMatch(/PLAN ▰ 1\/1/)
    expect(got.line1).toContain('WAITING ON DAVE')
    // The widget line still carries the task progress (the existing band), below the core lines.
    expect(got.widget).toContain('1/1 done')
    expect(got.keys).toEqual(['row-core-1', 'row-core-2', 'row-band'])
  })

  test('C3 a secret in a goal or an ask never reaches a drawn Text, from brief_set or from the turn-end parser', async ($, on) => {
    world(on)
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await $.tool.call({ tool: BRIEF_TOOL, goal: `ship ${SECRET}`, ask: [{ kind: 'question', text: `use ${SECRET}?`, recommend: SECRET }] })
    let got = await core($)
    expect(got.line2).toContain('GOAL ship')
    expect(got.line2).toContain('ASK 1')
    expect(got.all).not.toContain(SECRET)
    expect(got.texts.join('\n')).not.toContain(SECRET)
    expect(got.texts.join('\n')).not.toContain('a'.repeat(40))

  })

  test('C3 a secret in the turn-end parser input (goal line and Next steps block) never reaches a drawn Text', async ($, on) => {
    world(on)
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await $.turn.complete({
      answer: `Goal: ship ${SECRET}\n\nDone.\n\n## Next steps\n1. Rotate ${SECRET} before the merge?\n`,
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'end_turn',
    } as never)
    const got = await core($)
    expect(got.line1).toContain('WAITING ON DAVE')
    expect(got.line2).toMatch(/GOAL ship\S* .*\[parsed\]/)
    expect(got.line2).toContain('ASK 1')
    expect(got.all).not.toContain(SECRET)
    expect(got.texts.join('\n')).not.toContain('a'.repeat(40))
  })

  test('C6 with one row of room only the first core line draws, and survey time draws nothing', async ($, on) => {
    world(on)
    const one = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 1 } })
    expect((await one.findAll({ type: 'Box' })).map(found => found.key).filter(key => key?.startsWith('row-'))).toEqual(['row-core-1'])
    await one.unmount()
    const survey = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })
    expect(await survey.find({ key: 'row-core-1' })).toBeUndefined()
    await survey.unmount()
  })
})

// Repo, branch and worktree: the mod reads the .git files of the session folder. The files here are a Map.
type Git = { files: Record<string, string>; reads: string[]; writes: { path: string; text: string }[] }

const gitWorld = (on: On, files: Record<string, string>, opts: { env?: Record<string, string>; noCwd?: boolean } = {}): Git => {
  const cwd = 'C:/wt/w1/src'
  const seen: Git = { files, reads: [], writes: [] }
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...opts.env })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    // The engine hands the path over with the platform's separators.
    const path = e.path.replace(/\\/g, '/')
    seen.reads.push(path)
    const hit = seen.files[path]
    if (hit === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: hit }
  })
  const where = () => {
    if (opts.noCwd) throw new Error('no cwd')
    return { value: cwd }
  }
  on('session.cwd', where)
  on('session.root', where)
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  return seen
}

const LINKED = {
  'C:/wt/w1/.git': 'gitdir: C:/main/repo-x/.git/worktrees/w1\r\n',
  'C:/main/repo-x/.git/worktrees/w1/HEAD': 'ref: refs/heads/feat/one\r\n',
  'C:/main/repo-x/.git/worktrees/w1/commondir': '../..\r\n',
}

const lastSnapshot = (seen: Git): Record<string, any> =>
  JSON.parse(seen.writes.filter(write => /[\\/]test-session\.json$/.test(write.path)).at(-1)?.text ?? '{}')

describe('agentic-os git info', () => {
  test('C4 the start reads the .git files, a turn start reads them again, and the snapshot and the band carry the result', async ($, on) => {
    const seen = gitWorld(on, { ...LINKED })
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen)).toMatchObject({ repo: 'repo-x', branch: 'feat/one', worktree: 'w1' })

    seen.files['C:/main/repo-x/.git/worktrees/w1/HEAD'] = 'ref: refs/heads/feat/two\n'
    await $.turn.start({ turnId: 't1' } as never)
    expect(lastSnapshot(seen).branch).toBe('feat/two')
    // Line 1 of the two-line band no longer carries repo or branch (the statusline does); the one-line compact band keeps the repo.
    expect((await core($, 120, 1)).line1).toContain('repo-x')
    expect((await core($)).line1).not.toContain('repo-x')
  })

  test('C4 a primary checkout has worktree null', async ($, on) => {
    const seen = gitWorld(on, { 'C:/wt/w1/.git/HEAD': 'ref: refs/heads/main\n' })
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen)).toMatchObject({ repo: 'w1', branch: 'main', worktree: null })
  })

  test('C5 no .git at all: the start succeeds and the snapshot fields are null', async ($, on) => {
    const seen = gitWorld(on, {})
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    const snapshot = lastSnapshot(seen)
    expect(snapshot.brief.goal).toBe('g')
    expect(snapshot).toMatchObject({ repo: null, branch: null, worktree: null })
    expect(snapshot).toHaveProperty('hud', null)
    expect((await core($, 120, 1)).line1).toContain('unnamed - ctx')
  })

  test('C5 a cwd that cannot be read leaves the fields null and the session alone', async ($, on) => {
    const seen = gitWorld(on, { ...LINKED }, { noCwd: true })
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen)).toMatchObject({ repo: null, branch: null, worktree: null })
  })

  test('C4 the off switch reads nothing', async ($, on) => {
    const seen = gitWorld(on, { ...LINKED }, { env: { CCV3_MODS_OFF: '1' } })
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    await $.turn.start({ turnId: 't1' } as never)
    expect(seen.reads).toEqual([])
  })

  /**
   * The git atom as a store a test controls (idea of heldHud in hud.test.ts, copied here). In the real engine the atom is already
   * null when classic.SessionStart fires after /clear or an in-session /resume; the fake engine keeps atoms across session.end.
   * state.get and state.set for key 'git' answer from `held`; a test nulls it with `held.value = null`.
   */
  const heldGit = (on: On) => {
    const held = { value: null as unknown, version: 0 }
    const ref = { plugin: 'ccv3-mods', key: 'git' } as never
    on('state.get', ref, (() => ({ value: { value: held.value, version: held.version } })) as never)
    on('state.set', ref, ((_$: unknown, e: { value: unknown; ifVersion?: number }) => {
      if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
      held.value = e.value
      held.version += 1
      return { value: { isSet: true, version: held.version } }
    }) as never)
    return held
  }

  // C7 C8 after an in-session /resume or /clear the engine wipes the atoms and fires classic.SessionStart, not session.start:
  // the band keeps `- · -` for repo and branch until the first prompt
  for (const reason of ['resume', 'clear']) {
    test(`C7 C8 after ${reason}, classic.SessionStart with source ${reason} fills repo and branch in the band again`, async ($, on) => {
      const seen = gitWorld(on, { ...LINKED })
      on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
      on('classic.SessionStart', () => ({}))
      const held = heldGit(on)
      await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
      const before = (await core($, 120, 1)).line1
      expect(before).toContain('repo-x')

      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      held.value = null // the engine's reset
      const gap = (await core($, 120, 1)).line1
      expect(gap).toContain('unnamed - ctx')
      expect(gap).not.toContain('repo-x')

      await $.classic.SessionStart({ source: reason } as never)
      const after = (await core($, 120, 1)).line1
      expect(after).toContain('repo-x')
      expect(seen.reads.length).toBeGreaterThan(0)
    })
  }

  // C9 a compaction keeps the atoms, so classic.SessionStart with source compact needs no extra .git read
  test('C9 classic.SessionStart with source compact reads no .git file', async ($, on) => {
    const seen = gitWorld(on, { ...LINKED })
    on('classic.SessionStart', () => ({}))
    heldGit(on)
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
    const reads = seen.reads.filter(path => path.includes('.git')).length
    expect(reads).toBeGreaterThan(0)
    await $.classic.SessionStart({ source: 'compact' } as never)
    // The session name may read the identity file; no .git file is read again.
    expect(seen.reads.filter(path => path.includes('.git')).length).toBe(reads)
  })

  // C10 the off switch (CCV3_MODS_OFF) also covers the refill: classic.SessionStart for resume and clear reads nothing
  for (const reason of ['resume', 'clear']) {
    test(`C10 the off switch reads nothing at classic.SessionStart with source ${reason}`, async ($, on) => {
      const seen = gitWorld(on, { ...LINKED }, { env: { CCV3_MODS_OFF: '1' } })
      on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
      on('classic.SessionStart', () => ({}))
      heldGit(on)
      await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      await $.classic.SessionStart({ source: reason } as never)
      expect(seen.reads).toEqual([])
    })
  }
})

// /os redesign, round 2 (tests first): the lane board, compactions and touched-files reads behind the Session and Work tabs.
// An atom cannot be read by a test, so these tests watch `state.set` of `lanes` and `board`, seed `state.get` of `compactions` and `files`
// (the writers of those two are other hooks), and read what the pane draws. Contract (the plan left these holes; the choices are mine):
//   - refreshLanes spawns ['node', <home>/continuous-claude/scripts/coordination/lane.mjs, 'board', '--json', '--as', <session id>] with
//     init.timeoutMs 5000, in an interactive session only (the same gate as `mine` had). Nothing spawns `mine` any more.
//   - It writes the `lanes` atom with the lanes the board lists for THIS session, in the OsLane shape { id, title, state, note? } (the band and
//     the compact keeper read it), and the `board` atom with every lane the board listed, in the BoardLane shape. The full owner session id is
//     in neither: only the 8-character short id.
//   - A failed read (non-zero exit, garbage, or the old array shape) writes neither atom; the pane keeps the last good board and shows its age.
//   - The pane reads `compactions` (keeper records) and `files` (touched files) into TabState: the keeper line shows in WATCH (Overview) and
//     in the Session timeline; a peer lane whose scope matches an edited file reads "may touch the same files" on Overview and on Work.
// B-1 the spawn is still `mine`, drops --as, changes the timeout, or runs in a headless session
// B-2 the lanes atom holds peers or lanes of other sessions, or the board atom holds only mine, or the full owner id leaks into either
// B-3 a failed or malformed read wipes the board (nothing, or "lane board not read") instead of keeping the last good one
// B-4 the compactions atom is not read: a lost-plan record does not show in WATCH or in the timeline
// B-5 the files atom is not read: no overlap mark, whatever the peer scope says
// B-6 a board read that returns the old array shape replaces the board with nothing
// Per-project lane boards (2026-11-04): the board follows the session's folder, not the CCv3 checkout.
//   - refreshLanes passes cwd = `await $.session.cwd()` to $.process.run explicitly (the engine default is the session's cwd; this pins it after a cd).
//     The script stays the absolute primary path <home>/continuous-claude/scripts/coordination/lane.mjs.
//   - Exit 1 with "no lane board for" in stderr (lane.mjs projectOf: the folder is not registered) writes the state 'no-board': the board atom is cleared,
//     the lanes atom is emptied, and the Work tab says "no lane board (unregistered dir)". Any other failure still keeps the last good board (B-3).
//   - A good read after that (a cd back to a registered folder) clears the state and draws the lanes again.
// P-1 the spawn has no cwd, or a cwd other than the session's, or reads the script from the session folder
// P-2 a no-board answer keeps the old board on screen, or reads as "lane board not read" / "no lane held"
// P-3 any other exit 1 (a dead database) is taken for no-board and wipes the board
// P-4 the no-board state sticks after a good read

const OS_RUN = { command: 'os', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const PEER_ID = 'bbbbbbbb-2222-4000-8000-000000000002'
const BOARD_JSON = JSON.stringify({
  lanes: [
    { id: 'os-redesign', title: 'The pane', state: 'active', owner_session_id: 'test-session', lease_expires_at: null, note: 'tabs first\nsecond line', scope: 'hooks' },
    { id: 'api-core', title: 'The API', state: 'active', owner_session_id: PEER_ID, lease_expires_at: null, note: null, scope: 'hooks/agentic-os' },
    { id: 'idea-lane', title: 'An idea', state: 'ready', owner_session_id: null, lease_expires_at: null, note: null, scope: null },
  ],
  peers: [
    { id: 'test-session', working_on: 'this session' },
    { id: PEER_ID, working_on: 'another session' },
  ],
  me: 'test-session',
})

type Board = {
  argv: string[][]
  timeouts: (number | undefined)[]
  cwds: (string | undefined)[]
  stdout: string
  stderr: string
  cwd: string
  exitCode: number
  lanes: unknown[][]
  board: unknown[][]
  boardState: unknown[]
}

const boardWorld = (on: On, over: { seed?: Record<string, unknown> } = {}) => {
  const seen: Board = { argv: [], timeouts: [], cwds: [], stdout: BOARD_JSON, stderr: '', cwd: 'C:/work/repo', exitCode: 0, lanes: [], board: [], boardState: [] }
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: seen.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    seen.argv.push([...e.argv])
    seen.timeouts.push(e.init?.timeoutMs)
    seen.cwds.push(e.init?.cwd)
    return { value: { exitCode: seen.exitCode, stdout: seen.exitCode === 0 ? seen.stdout : '', stderr: seen.exitCode === 0 ? '' : seen.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('state.set', { plugin: 'ccv3-mods', key: 'boardState' } as never, ((_$: unknown, e: { value: unknown }, next: (e: unknown) => unknown) => {
    seen.boardState.push(e.value)
    return next(e)
  }) as never)
  on('state.set', { plugin: 'ccv3-mods', key: 'lanes' } as never, ((_$: unknown, e: { value: unknown[] }, next: (e: unknown) => unknown) => {
    seen.lanes.push(e.value)
    return next(e)
  }) as never)
  on('state.set', { plugin: 'ccv3-mods', key: 'board' } as never, ((_$: unknown, e: { value: unknown[] }, next: (e: unknown) => unknown) => {
    seen.board.push(e.value)
    return next(e)
  }) as never)
  for (const [key, value] of Object.entries(over.seed ?? {})) on('state.get', { plugin: 'ccv3-mods', key } as never, (() => ({ value: { value, version: 1 } })) as never)
  const boards = () => seen.argv.filter(one => one.includes('board') || one.includes('mine'))
  return { seen, boards, settle: () => clock.advance(1), advance: (ms: number) => clock.advance(ms) }
}

const tabText = async ($: Engine, tab: 'overview' | 'session' | 'work', columns = 80): Promise<string> => {
  const pane = await $.ui.mount({
    plugin: 'ccv3-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agentic-os',
    props: { title: 'Agentic OS', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns, rows: 40 },
  })
  // The selection outlives a mount, so every read presses its own tab.
  await pane.press({ key: `tab-${tab}` })
  const text = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
  await pane.unmount()
  return text
}

describe('agentic-os lane board read', () => {
  test('B-1 /os spawns "node lane.mjs board --json --as <sid>" with a 5 s cap, and never "mine"', async ($, on) => {
    const { seen, boards, settle } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    expect(boards().length).toBeGreaterThanOrEqual(1)
    for (const argv of boards()) {
      expect(argv[0]).toBe('node')
      expect(argv[1]).toMatch(/continuous-claude[\\/]scripts[\\/]coordination[\\/]lane\.mjs$/)
      expect(argv.slice(2)).toEqual(['board', '--json', '--as', 'test-session'])
    }
    expect(seen.argv.some(argv => argv.includes('mine'))).toBe(false)
    expect(seen.timeouts[seen.argv.findIndex(argv => argv.includes('board'))]).toBe(5000)
  })

  test('B-1 a headless session does not read the board, not at the start and not at /os', async ($, on) => {
    const { boards, settle } = boardWorld(on)
    await $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: false })
    await $.command.run(OS_RUN)
    await settle()
    expect(boards()).toHaveLength(0)
  })

  test('B-1 an interactive session start reads the board once', async ($, on) => {
    const { boards, settle } = boardWorld(on)
    await $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
    await settle()
    expect(boards().length).toBeGreaterThanOrEqual(1)
    expect(boards().every(argv => argv.includes('board'))).toBe(true)
  })

  test('B-2 the lanes atom holds only this session\'s lanes (OsLane shape, first line of the note); the board atom holds every lane (BoardLane shape), short owner ids only', async ($, on) => {
    const { seen, settle } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    expect(seen.lanes.at(-1)).toEqual([{ id: 'os-redesign', title: 'The pane', state: 'active', note: 'tabs first' }])
    const board = seen.board.at(-1) as { id: string; mine: boolean; owner: string | null; live?: boolean }[]
    expect(board.map(one => one.id).sort()).toEqual(['api-core', 'idea-lane', 'os-redesign'])
    expect(board.filter(one => one.mine).map(one => one.id)).toEqual(['os-redesign'])
    expect(board.find(one => one.id === 'api-core')).toMatchObject({ mine: false, owner: 'bbbbbbbb', live: true })
    expect(board.find(one => one.id === 'idea-lane')).toMatchObject({ mine: false, owner: null })
    expect(JSON.stringify([seen.lanes, seen.board])).not.toContain(PEER_ID)
  })

  test('B-3 a failed spawn keeps the last good board: the Work tab still lists the lanes and says how old the read is', async ($, on) => {
    const { seen, settle, advance } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    const writes = seen.board.length
    const lanesWrites = seen.lanes.length
    expect(writes).toBeGreaterThanOrEqual(1)
    seen.exitCode = 1
    await advance(10 * 60_000)
    await $.command.run(OS_RUN)
    await settle()
    expect(seen.board).toHaveLength(writes)
    expect(seen.lanes).toHaveLength(lanesWrites)
    const text = await tabText($, 'work')
    expect(text).toContain('You hold lane os-redesign: The pane')
    expect(text).toContain('Another session holds lane api-core')
    expect(text).toContain('as of 10m ago')
    expect(text).not.toContain('lane board not read')
  })

  test('P-1 the spawn carries the session folder as cwd, and the script is still the absolute primary path', async ($, on) => {
    const { seen, boards, settle } = boardWorld(on)
    seen.cwd = 'D:/GreyMatter.Design/app'
    await $.command.run(OS_RUN)
    await settle()
    expect(boards().length).toBeGreaterThanOrEqual(1)
    const reads = seen.argv.flatMap((argv, i) => (argv.includes('board') ? [i] : []))
    for (const i of reads) {
      expect(seen.cwds[i]).toBe('D:/GreyMatter.Design/app')
      expect(seen.argv[i]?.[1]).toMatch(/^C:\/home\/continuous-claude\/scripts\/coordination\/lane\.mjs$/)
    }
  })

  test('P-1 after a cd the next read carries the new folder', async ($, on) => {
    const { seen, settle, advance } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    seen.cwd = 'C:/elsewhere'
    await advance(60_000)
    await $.command.run(OS_RUN)
    await settle()
    const last = seen.argv.map((argv, i) => (argv.includes('board') ? i : -1)).filter(i => i >= 0).at(-1) as number
    expect(seen.cwds[last]).toBe('C:/elsewhere')
  })

  test('P-2 exit 1 with "no lane board for" clears the old board and the Work tab says "no lane board (unregistered dir)"', async ($, on) => {
    const { seen, settle, advance } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    expect(await tabText($, 'work')).toContain('You hold lane os-redesign: The pane')
    seen.exitCode = 1
    seen.stderr = 'no lane board for C:/Users/dkhay/scratch; register it: node C:/Users/dkhay/.claude/scripts/lane.mjs project register C:/Users/dkhay/scratch\n'
    await advance(60_000)
    await $.command.run(OS_RUN)
    await settle()
    expect(seen.board.at(-1)).toBeNull()
    expect(seen.lanes.at(-1)).toEqual([])
    expect(seen.boardState.at(-1)).toBe('no-board')
    const text = await tabText($, 'work')
    expect(text).toContain('no lane board (unregistered dir)')
    expect(text).not.toContain('os-redesign')
    expect(text).not.toContain('api-core')
    expect(text).not.toContain('lane board not read')
    expect(text).not.toContain('no lane held')
  })

  test('P-3 any other exit 1 (no "no lane board for" in stderr) keeps the last good board', async ($, on) => {
    const { seen, settle, advance } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    const writes = seen.board.length
    const stateWrites = seen.boardState.length
    for (const stderr of ['connect ECONNREFUSED 127.0.0.1:5432\n', 'lane.mjs needs a live hook: lane.client_version\n', '']) {
      seen.exitCode = 1
      seen.stderr = stderr
      await advance(60_000)
      await $.command.run(OS_RUN)
      await settle()
    }
    expect(seen.board).toHaveLength(writes)
    expect(seen.boardState).toHaveLength(stateWrites)
    const text = await tabText($, 'work')
    expect(text).toContain('You hold lane os-redesign: The pane')
    expect(text).not.toContain('unregistered dir')
  })

  test('P-4 a good read after no-board draws the lanes again and clears the state', async ($, on) => {
    const { seen, settle, advance } = boardWorld(on)
    seen.exitCode = 1
    seen.stderr = 'no lane board for C:/scratch; register it: node x project register C:/scratch\n'
    await $.command.run(OS_RUN)
    await settle()
    expect(await tabText($, 'work')).toContain('no lane board (unregistered dir)')
    seen.exitCode = 0
    await advance(60_000)
    await $.command.run(OS_RUN)
    await settle()
    expect(seen.boardState.at(-1)).toBeNull()
    const text = await tabText($, 'work')
    expect(text).toContain('You hold lane os-redesign: The pane')
    expect(text).not.toContain('unregistered dir')
  })

  test('B-6 a board read in the old array shape, or garbage, keeps the last good board too', async ($, on) => {
    const { seen, settle } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    const writes = seen.board.length
    for (const stdout of ['[]', 'not json', '', '{"peers":[]}', 'null']) {
      seen.stdout = stdout
      await $.command.run(OS_RUN)
      await settle()
    }
    expect(seen.board).toHaveLength(writes)
    expect(await tabText($, 'work')).toContain('Another session holds lane api-core')
  })

  test('B-3 with no good read yet the Work tab says "lane board not read"', async ($, on) => {
    const { seen, settle } = boardWorld(on)
    seen.exitCode = 1
    await $.command.run(OS_RUN)
    await settle()
    expect(seen.board).toHaveLength(0)
    expect(await tabText($, 'work')).toContain('lane board not read')
  })
})

describe('agentic-os compactions and touched files reach the tabs', () => {
  test('B-4 a lost-plan keeper record shows in WATCH on Overview and in the Session timeline', async ($, on) => {
    const record = { at: 1_000 - 60_000, sessionId: 'test-session', open: 3, total: 7, kept: false }
    boardWorld(on, { seed: { compactions: [record] } })
    expect(await tabText($, 'overview')).toContain('The last summary lost the plan.')
    expect(await tabText($, 'session')).toContain('The last summary lost the plan.')
  })

  test('B-4 a kept record reads kept, and no record draws no keeper line', async ($, on) => {
    boardWorld(on, { seed: { compactions: [{ at: 1_000 - 60_000, sessionId: 'test-session', open: 3, total: 7, kept: true }] } })
    const text = await tabText($, 'session')
    expect(text).toContain('The last summary kept the plan.')
    expect(text).not.toContain('lost the plan')
  })

  test('B-4 without a record the pane draws no keeper line', async ($, on) => {
    boardWorld(on)
    expect(await tabText($, 'overview')).not.toMatch(/The last summary|plan keeper/)
    expect(await tabText($, 'session')).not.toMatch(/The last summary|plan keeper/)
  })

  test('B-5 an edited file under a peer lane\'s scope reads "may touch the same files" on Overview and on Work', async ($, on) => {
    const { settle } = boardWorld(on, { seed: { files: [{ path: 'hooks/agentic-os/digest.ts', state: 'edited', added: 3, removed: 1 }] } })
    await $.command.run(OS_RUN)
    await settle()
    expect(await tabText($, 'overview')).toContain('may touch the same files')
    expect(await tabText($, 'work')).toContain('may touch the same files')
  })

  test('B-5 with no touched file nothing overlaps', async ($, on) => {
    const { settle } = boardWorld(on)
    await $.command.run(OS_RUN)
    await settle()
    expect(await tabText($, 'overview')).not.toContain('may touch')
    expect(await tabText($, 'work')).not.toContain('may touch')
  })
})

// The HUD's cost and limits in the state file (`hud`): the web Fleet reads them. Interactive starts only: a headless run has no HUD.
type Usage = { cost?: { usd: unknown }; rateLimits: { kind: string; percentUsed: unknown }[] }

const hudWorld = (on: On, usage: Usage): Git => {
  const seen = gitWorld(on, {})
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, ...usage } as never }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return seen
}

/** The hud atom as a store a test controls (heldHud in hud.test.ts, copied): the kit cannot write an atom, so a test sets `held.value`. */
const heldHud = (on: On) => {
  const held = { value: null as unknown, version: 0 }
  const ref = { plugin: 'ccv3-mods', key: 'hud' } as never
  on('state.get', ref, (() => ({ value: { value: held.value, version: held.version } })) as never)
  on('state.set', ref, ((_$: unknown, e: { value: unknown; ifVersion?: number }) => {
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    held.value = e.value
    held.version += 1
    return { value: { isSet: true, version: held.version } }
  }) as never)
  return held
}

const hudSnapshot = async ($: Engine, seen: Git, isInteractive = true): Promise<Record<string, any>> => {
  await $.session.start({ cwd: 'C:/wt/w1/src', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
  await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
  return lastSnapshot(seen)
}

// H1 the snapshot has no hud key, or the cost or a limit is lost on the way
// H2 a headless run (no HUD) writes anything but hud: null
// H3 a limit kind that holds a secret reaches the file unredacted
// H4 a cost or percent that is not a finite number reaches the file
// H5 a measure after the turn-end snapshot leaves the file with the previous turn's cost and limits
// H6 a limits value that is not a list drops the whole snapshot
// H7 the writer caps (8 limits, 60 characters a kind) are lost
describe('agentic-os hud in the state file', () => {
  test('H1 an interactive session writes hud with the cost and every limit', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 3.84 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }, { kind: 'seven_day', percentUsed: 12 }] })
    const snapshot = await hudSnapshot($, seen)
    expect(snapshot.hud).toEqual({ costUsd: 3.84, limits: [{ kind: 'five_hour', percentUsed: 38 }, { kind: 'seven_day', percentUsed: 12 }] })
  })

  test('H1 a usage with no cost writes costUsd null and keeps the limits', async ($, on) => {
    const seen = hudWorld(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 38 }] })
    expect((await hudSnapshot($, seen)).hud).toEqual({ costUsd: null, limits: [{ kind: 'five_hour', percentUsed: 38 }] })
  })

  test('H2 a headless run writes hud: null', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 3.84 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }] })
    const snapshot = await hudSnapshot($, seen, false)
    expect(snapshot).toHaveProperty('hud', null)
  })

  test('H3 a limit kind with a secret is redacted in the file', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 1 }, rateLimits: [{ kind: `key ${SECRET}`, percentUsed: 5 }] })
    const written = JSON.stringify((await hudSnapshot($, seen)).hud)
    expect(written).not.toContain(SECRET)
    expect(written).toContain('[REDACTED:')
  })

  test('H4 a non-numeric cost becomes null and a non-numeric percent drops the limit', async ($, on) => {
    const seen = hudWorld(on, {
      cost: { usd: '3.84' },
      rateLimits: [{ kind: 'five_hour', percentUsed: '38' }, { kind: 'seven_day', percentUsed: 12 }],
    })
    expect((await hudSnapshot($, seen)).hud).toEqual({ costUsd: null, limits: [{ kind: 'seven_day', percentUsed: 12 }] })
  })

  test('H5 a measure after the turn-end snapshot moves the new cost and limits into the file', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 3.84 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }] })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await hudSnapshot($, seen)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    expect(lastSnapshot(seen).hud.costUsd).toBe(3.84)
    // The engine measures after the turn ends, so the turn-end snapshot above holds the previous turn's figures.
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000 }, cost: { usd: 9.99 }, rateLimits: [{ kind: 'five_hour', percentUsed: 77 }], changed: ['cost', 'rateLimits'] } as never)
    expect(lastSnapshot(seen).hud).toEqual({ costUsd: 9.99, limits: [{ kind: 'five_hour', percentUsed: 77 }] })
  })

  test('H5 a measure that changes nothing in the HUD writes no new snapshot', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 3.84 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }] })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await hudSnapshot($, seen)
    const same = { startedAt: 0, context: { window: 1_000_000 }, cost: { usd: 3.84 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }], changed: ['context'] } as never
    await $.session.measure(same)
    const before = seen.writes.length
    await $.session.measure(same)
    expect(seen.writes.length).toBe(before)
  })

  test('H6 a limits value that is not a list still writes the snapshot, with the cost and the rest intact', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 1 }, rateLimits: [] })
    const held = heldHud(on)
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: true } as never)
    held.value = { model: 'm', effort: null, advisor: null, costUsd: 2.5, limits: 'five_hour 38' }
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    const snapshot = lastSnapshot(seen)
    expect(snapshot.brief.goal).toBe('g')
    expect(snapshot.hud).toEqual({ costUsd: 2.5, limits: [] })
  })

  test('H6 a null entry inside limits is skipped and the snapshot is still written', async ($, on) => {
    const seen = hudWorld(on, { cost: { usd: 1 }, rateLimits: [] })
    const held = heldHud(on)
    await $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: true } as never)
    held.value = { model: 'm', effort: null, advisor: null, costUsd: 2.5, limits: [null, { kind: 'five_hour', percentUsed: 38 }] }
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    const snapshot = lastSnapshot(seen)
    expect(snapshot.brief.goal).toBe('g')
    expect(snapshot.hud).toEqual({ costUsd: 2.5, limits: [{ kind: 'five_hour', percentUsed: 38 }] })
  })

  test('H7 the writer keeps 8 limits and clips a kind to 60 characters', async ($, on) => {
    const long = `k_${'x'.repeat(98)}`
    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: i === 0 ? long : `kind_${i}`, percentUsed: i }))
    const seen = hudWorld(on, { cost: { usd: 1 }, rateLimits: nine })
    const { limits } = (await hudSnapshot($, seen)).hud
    expect(limits).toHaveLength(8)
    expect(limits[0].kind).toBe(long.slice(0, 60))
    expect(limits[0].kind).not.toContain('REDACTED')
  })
})

// The final snapshot at session end (the Fleet page reads `endedAt` as a fallback when the database has no ended row).
// Ways it can fail, one test each:
// E11 a reason writes no final file, or twice, or `endedAt` and `at` differ, or an ordinary snapshot carries `endedAt`
// E12 /clear writes the final file after the resets, so it loses the brief of the ending conversation, or the new conversation inherits it
// E13 a later write (turn end, brief_set) for the ended id overwrites the final file; or the guard blocks other ids
// E14 a headless run with nothing to say writes a file at exit
// E15 CCV3_MODS_OFF=1 writes at exit
// E13b a write that started before the end and lands after it (the engine has reset the ended-id atom by then) replaces the final file
// E11c /clear or a resume resets the HUD before the final write: the final file loses the ending conversation's cost and context
// Not tested: the 300 ms floor (FINAL_WRITE_MIN_MS). The kit runs a hook under a root budget of Infinity (`next.budget.remainingMs`) and
// SessionEndInput has no field to cut it, so a test cannot give the hook 200 ms. A live `claude -p` run would be the only check.
const endWorld = (on: On, env: Record<string, string> = {}, id = 'test-session') => {
  // `sid.current` is what `$.session.id()` answers: a /clear moves the process to a new id, so a test sets it after the end.
  const sid = { current: id }
  // A test sets `slow.wait` to hold the next `process.run` (the lane read behind /os) until it resolves.
  const slow = { wait: null as Promise<void> | null }
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  const writes: { path: string; text: string }[] = []
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', async () => {
    if (slow.wait !== null) await slow.wait
    return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: sid.current }))
  on('agent.list', () => ({ value: [] as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return { writes, clock, sid, slow }
}

const filesOf = (seen: { writes: { path: string; text: string }[] }, id: string) =>
  seen.writes.filter(write => write.path.replace(/\\/g, '/').endsWith(`/agentic-os/${id}.json`))
const lastOf = (seen: { writes: { path: string; text: string }[] }, id: string): Record<string, any> =>
  JSON.parse(filesOf(seen, id).at(-1)?.text ?? '{}')
const startEnd = ($: Engine, isInteractive: boolean) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })
const endWith = ($: Engine, reason: string, sessionId = 's1') => $.session.end({ reason, sessionId, resume: { id: sessionId } } as never)

describe('agentic-os final snapshot at session end', () => {
  for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit', 'other']) {
    test(`E11 reason ${reason} writes the ending session's file once, with endedAt equal to at`, async ($, on) => {
      // The session id is the ending id, so the brief_set write and the final write go to the same file.
      const seen = endWorld(on, {}, 's1')
      await startEnd($, true)
      await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
      const before = filesOf(seen, 's1').length
      expect(before).toBeGreaterThan(0)
      expect(lastOf(seen, 's1')).not.toHaveProperty('endedAt')
      await seen.clock.advance(4_000)
      await endWith($, reason)
      expect(filesOf(seen, 's1')).toHaveLength(before + 1)
      const final = lastOf(seen, 's1')
      expect(final.sessionId).toBe('s1')
      expect(final.at).toBe(5_000)
      expect(final.endedAt).toBe(final.at)
    })
  }

  test('E12 /clear writes the old brief into the final file before the resets; the new conversation starts without it', async ($, on) => {
    const seen = endWorld(on, {}, 's1')
    await startEnd($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'old goal' })
    await endWith($, 'clear')
    expect(lastOf(seen, 's1').brief.goal).toBe('old goal')
    // After /clear the process goes on under a new id; its first turn end writes that id's file.
    seen.sid.current = 's2'
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    expect(filesOf(seen, 's2').length).toBeGreaterThan(0)
    expect(lastOf(seen, 's2').brief ?? null).toBeNull()
    expect(lastOf(seen, 's2')).not.toHaveProperty('endedAt')
  })

  test('E13 after the end, a turn end and a brief_set for the ended id leave the final file as it was', async ($, on) => {
    const seen = endWorld(on)
    await startEnd($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    await endWith($, 'other', 'test-session')
    const final = filesOf(seen, 'test-session').at(-1)?.text
    const count = filesOf(seen, 'test-session').length
    expect(JSON.parse(final ?? '{}').endedAt).toBe(1_000)
    await $.turn.complete({ answer: 'late', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'later' })
    await seen.clock.advance(10_000)
    expect(filesOf(seen, 'test-session')).toHaveLength(count)
    expect(filesOf(seen, 'test-session').at(-1)?.text).toBe(final)
  })

  for (const reason of ['clear', 'resume']) {
    test(`E11c reason ${reason}: the final file keeps the cost and the context of the ending conversation, not the reset ones`, async ($, on) => {
      const seen = endWorld(on, {}, 's1')
      on('settings.read', () => ({ value: {} }))
      on('session.model', () => ({ value: 'claude-opus-5-5' }))
      on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 3.1 } } as never }))
      on('session.measure', (_$, e) => ({ changed: e.changed }))
      await startEnd($, true)
      await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
      await $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 41 }, cost: { usd: 7.25 }, rateLimits: [], changed: ['context', 'cost'] } as never)
      const live = lastOf(seen, 's1')
      expect(live.hud.costUsd).toBe(7.25)
      expect(live.ctx).toBe(41)
      const before = filesOf(seen, 's1').length
      await endWith($, reason)
      expect(filesOf(seen, 's1')).toHaveLength(before + 1)
      const final = lastOf(seen, 's1')
      expect(final.endedAt).toBeDefined()
      expect(final.hud.costUsd).toBe(7.25)
      expect(final.ctx).toBe(41)
    })
  }

  // The real engine resets the plugin's atoms after session.end (E2E 2026-10-30); the fake engine keeps them. This store lets a test do the reset.
  test('E13b a write that started before the end and lands after the engine reset the ended-id atom leaves the final file as it was', async ($, on) => {
    const seen = endWorld(on)
    const held = { value: null as unknown, version: 0 }
    const ref = { plugin: 'ccv3-mods', key: 'endedId' } as never
    on('state.get', ref, (() => ({ value: { value: held.value, version: held.version } })) as never)
    on('state.set', ref, ((_$: unknown, e: { value: unknown }) => {
      held.value = e.value
      held.version += 1
      return { value: { isSet: true, version: held.version } }
    }) as never)
    await startEnd($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    // /os opens: its snapshot waits for the lane read (process.run), which is held here.
    let release = () => {}
    seen.slow.wait = new Promise<void>(resolve => { release = resolve })
    await $.command.run({ command: 'os', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })
    await endWith($, 'other', 'test-session')
    const count = filesOf(seen, 'test-session').length
    const final = filesOf(seen, 'test-session').at(-1)?.text
    expect(JSON.parse(final ?? '{}').endedAt).toBe(1_000)
    held.value = null // the engine's reset
    seen.slow.wait = null
    release()
    await seen.clock.advance(10)
    expect(filesOf(seen, 'test-session')).toHaveLength(count)
    expect(filesOf(seen, 'test-session').at(-1)?.text).toBe(final)
  })

  // E13c: /resume s2 ends s1, a later /resume s1 ends s2 and the process is s1 again. The ended-id set must not freeze s1's file.
  test('E13c a session that ended and is resumed again in the same process writes its file again, without endedAt', async ($, on) => {
    const seen = endWorld(on, {}, 's1')
    on('classic.SessionStart', () => ({}))
    await startEnd($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'first' })
    await endWith($, 'resume')
    expect(lastOf(seen, 's1').endedAt).toBeDefined()
    seen.sid.current = 's2'
    await $.classic.SessionStart({ source: 'resume' } as never)
    await endWith($, 'resume', 's2')
    seen.sid.current = 's1'
    await $.classic.SessionStart({ source: 'resume' } as never)
    const before = filesOf(seen, 's1').length
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'again' })
    expect(filesOf(seen, 's1').length).toBeGreaterThan(before)
    expect(lastOf(seen, 's1').brief.goal).toBe('again')
    expect(lastOf(seen, 's1')).not.toHaveProperty('endedAt')
  })

  test('E14 a headless run with no task, plan or brief writes no file at exit; with a brief it does', async ($, on) => {
    const seen = endWorld(on)
    await startEnd($, false)
    await endWith($, 'other')
    expect(seen.writes.filter(write => /state[\\/]agentic-os[\\/]/.test(write.path))).toEqual([])
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    await endWith($, 'other')
    expect(lastOf(seen, 's1').brief.goal).toBe('g')
  })

  test('E15 CCV3_MODS_OFF=1 writes nothing at exit', async ($, on) => {
    const seen = endWorld(on, { CCV3_MODS_OFF: '1' })
    await startEnd($, true)
    await endWith($, 'other')
    expect(seen.writes).toEqual([])
  })
})

// Session identity: the band draws `name #sid8`. The name is the Claude Code session name. Ways it can fail:
// I1 a session_title on classic.SessionStart (startup, and resume or clear) does not reach line 1
// I2 a /rename shows only at the next SessionStart: session_title on classic.UserPromptSubmit does not update the band
// I3 the identity file is not the fallback, or it beats a session_title, or a bad file crashes the hook
// I4 no name anywhere reads anything but `unnamed`; a prompt with no title wipes a known name
// I5 the off switch still reads the identity file
describe('agentic-os session identity', () => {
  const FILE = 'C:/home/.claude/state/identity/test-session.json'
  const world2 = (on: On, files: Record<string, string> = {}, env: Record<string, string> = {}): Git => {
    const seen = gitWorld(on, { ...files }, { env })
    on('classic.SessionStart', () => ({}))
    on('classic.UserPromptSubmit', () => ({}))
    return seen
  }
  const start = ($: Engine) => $.session.start({ cwd: 'C:/wt/w1/src', surface: 'terminal', isInteractive: false })
  const line1 = async ($: Engine) => (await core($)).line1

  test('I1 session_title on SessionStart (startup) shows as name #sid8 on line 1', async ($, on) => {
    world2(on)
    await start($)
    await $.classic.SessionStart({ source: 'startup', session_title: 'trex' } as never)
    expect(await line1($)).toContain('trex #test-ses')
  })

  for (const source of ['resume', 'clear']) {
    test(`I1 session_title on SessionStart (${source}) shows on line 1`, async ($, on) => {
      world2(on)
      await start($)
      await $.classic.SessionStart({ source, session_title: 'trex' } as never)
      expect(await line1($)).toContain('trex #test-ses')
    })
  }

  // I7 an auto-name comes back from the settings hooks (ClassicResult.sessionTitle, folded from hookSpecificOutput.sessionTitle), which run inside next(e):
  // the handler has to read it after next(e), or the band reads `unnamed` until the first prompt.
  const titled = (on: On, title: string | undefined): void => {
    gitWorld(on, {})
    on('classic.SessionStart', () => (title ? { sessionTitle: title } : {}))
    on('classic.UserPromptSubmit', () => ({}))
  }
  for (const source of ['startup', 'compact', 'fork', 'resume', 'clear']) {
    test(`I7 a sessionTitle from the hooks shows on line 1 at SessionStart (${source})`, async ($, on) => {
      titled(on, 'otter')
      await start($)
      await $.classic.SessionStart({ source } as never)
      expect(await line1($)).toContain('otter #test-ses')
    })
  }

  test('I7 a hook output with no sessionTitle leaves the band unnamed and the result intact', async ($, on) => {
    titled(on, undefined)
    await start($)
    const r = await $.classic.SessionStart({ source: 'startup' } as never)
    expect(await line1($)).toContain('unnamed #test-ses')
    expect(r).toEqual({})
  })

  test('I7 the result of next(e) is returned unchanged', async ($, on) => {
    titled(on, 'otter')
    await start($)
    const r = await $.classic.SessionStart({ source: 'startup' } as never)
    expect(r).toEqual({ sessionTitle: 'otter' })
  })

  test('I7 a given session_title beats a sessionTitle from the hooks', async ($, on) => {
    titled(on, 'otter')
    await start($)
    await $.classic.SessionStart({ source: 'startup', session_title: 'trex' } as never)
    expect(await line1($)).toContain('trex #test-ses')
  })

  test('I2 session_title on UserPromptSubmit updates the name (a /rename)', async ($, on) => {
    world2(on)
    await start($)
    await $.classic.SessionStart({ source: 'startup', session_title: 'trex' } as never)
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'renamed' } as never)
    const got = await line1($)
    expect(got).toContain('renamed #test-ses')
    expect(got).not.toContain('trex')
  })

  test('I3 with no session_title the identity file names the session; a session_title beats the file', async ($, on) => {
    world2(on, { [FILE]: JSON.stringify({ uuid: 'test-session', name: 'fromfile' }) })
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'hi' } as never)
    expect(await line1($)).toContain('fromfile #test-ses')
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'fromhook' } as never)
    expect(await line1($)).toContain('fromhook #test-ses')
  })

  test('I3 a corrupt identity file reads unnamed and does not throw', async ($, on) => {
    world2(on, { [FILE]: '{not json' })
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'hi' } as never)
    expect(await line1($)).toContain('unnamed #test-ses')
  })

  test('I4 no name anywhere reads unnamed; a later prompt with no title keeps a known name', async ($, on) => {
    world2(on)
    await start($)
    expect(await line1($)).toContain('unnamed #test-ses')
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'trex' } as never)
    await $.classic.UserPromptSubmit({ prompt: 'again' } as never)
    expect(await line1($)).toContain('trex #test-ses')
  })

  test('I6 a /clear or resume drops the old name: an unnamed new conversation does not show it', async ($, on) => {
    world2(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await start($)
    await $.classic.SessionStart({ source: 'startup', session_title: 'trex' } as never)
    expect(await line1($)).toContain('trex #test-ses')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await $.classic.SessionStart({ source: 'clear' } as never)
    const got = await line1($)
    expect(got).toContain('unnamed #test-ses')
    expect(got).not.toContain('trex')
  })

  test('I7 a start with no hook event yet (a /reload-plugins) reads the name from the identity file', async ($, on) => {
    world2(on, { [FILE]: JSON.stringify({ uuid: 'test-session', name: 'trex' }) })
    await start($)
    expect(await line1($)).toContain('trex #test-ses')
  })

  test('I5 the off switch reads no identity file', async ($, on) => {
    const seen = world2(on, { [FILE]: JSON.stringify({ name: 'fromfile' }) }, { CCV3_MODS_OFF: '1' })
    await start($)
    await $.classic.UserPromptSubmit({ prompt: 'hi' } as never)
    expect(seen.reads.filter(path => path.includes('identity'))).toEqual([])
  })
})
