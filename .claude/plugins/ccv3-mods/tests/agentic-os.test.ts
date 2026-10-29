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

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

const core = async ($: Engine, columns = 120) => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: columns } })
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
    const line1 = (await core($)).line1
    expect(line1).toContain('feat/two')
    expect(line1).toContain('repo-x')
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
    expect((await core($)).line1).toContain('● -')
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

type Board = { argv: string[][]; timeouts: (number | undefined)[]; stdout: string; exitCode: number; lanes: unknown[][]; board: unknown[][] }

const boardWorld = (on: On, over: { seed?: Record<string, unknown> } = {}) => {
  const seen: Board = { argv: [], timeouts: [], stdout: BOARD_JSON, exitCode: 0, lanes: [], board: [] }
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    seen.argv.push([...e.argv])
    seen.timeouts.push(e.init?.timeoutMs)
    return { value: { exitCode: seen.exitCode, stdout: seen.exitCode === 0 ? seen.stdout : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('state.set', { plugin: 'ccv3-mods', key: 'lanes' } as never, ((_$: unknown, e: { value: unknown[] }, next: (e: unknown) => unknown) => {
    seen.lanes.push(e.value)
    return next(e)
  }) as never)
  on('state.set', { plugin: 'ccv3-mods', key: 'board' } as never, ((_$: unknown, e: { value: unknown[] }, next: (e: unknown) => unknown) => {
    seen.board.push(e.value)
    return next(e)
  }) as never)
  for (const [key, value] of Object.entries(over.seed ?? {})) on('state.get', { plugin: 'ccv3-mods', key } as never, (() => ({ value, version: 1 })) as never)
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
