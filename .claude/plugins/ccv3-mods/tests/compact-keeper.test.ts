import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { KeeperRecord, OsTask } from '../types'
import { KEEPER_LIMIT, compactBlock, keeperMarker } from '../hooks/compact-keeper/model'
// The new exports (markerKept, addRecord, openCounts, MAX_RECORDS) come through the namespace, so a missing one fails its own test and not the whole file.
import * as keeper from '../hooks/compact-keeper/model'

// Ways the compact keeper can fail, one test each.
// K1 a long task list pushes the block over the limit, loses the marker, or counts the cut tasks wrong
// K2 a session with nothing to keep gets no keep-list, or a long state crowds the keep-list out (changed for A1: the keep-list is fixed text, always present, with the marker at 0 of 0)
// F1-F6 the fixed keep-list: six items and the drop line, always whole; the cap holds; the facts (branch, session label, handoff) show when known
// F7-F12 the facts in a manual compaction: branch from the session folder, label from the sessionName atom, newest handoff of this session id, no throw when any is unreadable
// K3 a manual /compact reaches the summarizer without the open tasks or the marker
// K4 the person's own text after /compact is replaced, or is not first
// K5 an auto or plugin compaction is changed (only the person's /compact is)
// K6 either off switch still changes the compaction
// K7 a finished task is listed as open, or the counts are wrong
// K8 a subagent's own compaction gets this session's plan
// K10 a long list of tasks not yet started crowds out the task in progress
// K11 after /clear or a resume in the same process, the old conversation's tasks and plan reach the new summary
// /os redesign, round 1: after a manual compaction the keeper records { at, sessionId, open, total, kept } to the `compactions` atom.
// A test cannot read an atom (`$.state.get` is refused in a test hook), so these tests hook `state.set` for the key and read what was written.
// Contract these tests pin (the plan left these holes; the choices are mine and the implementer must follow them or change the test):
//   - `at` is the clock at the record ($.clock.now(): 1000 in these tests); `sessionId` is the full session id; open and total are the
//     counts the marker carried (openCounts of the task list).
//   - The summary is messages[0] of the compaction result ("its summary and the messages it kept", oldest first). Only that message is
//     scanned: a marker in a later (kept) message is an OLD summary's, and records kept=false (K13b).
//   - Nothing is recorded for: a trigger other than manual, a subagent, either off switch, a skip result, or a skip result.
//   - The record step runs after next() in its own try/catch, so a throw in it never reaches the hook's .catch (which calls next again).
//   - K16 forces the throw with a poisoned read: a test hook answers `state.get` of `compactions` with 42, which is not a list. A throwing
//     test hook is skipped by the engine, and the engine rejects a malformed message before the plugin sees it, so these are the only levers.
// K12  a manual compaction whose summary holds the exact marker records kept=true, with the full record shape; the result is returned as is
// K13  a summary without the marker, with the marker followed by a digit ("of 20"), or with another session's or other counts' marker records kept=false
// K13b the marker only in an old kept message (not the summary) records kept=false
// K14  an auto or plugin compaction, a subagent, either off switch and a skip result record nothing; a session with nothing to keep records open 0 of 0 (A1: the block is never null)
// K15  the record list caps at 10, newest last
// K16  a throw in the record step leaves next() called once, returns its result, and the next compaction still records
// Not tested here: a hook that throws. The engine skips it with or without `.catch`, so a test cannot tell;
// `node scripts/mods/validate-mods.mjs` fails a gating hook without `.catch` (shown 2026-10-13: "session.compact{trigger=manual}").
// Not tested here: the matcher. Without it the plugin does not load (two unmatched session.compact hooks), and every test fails.

const task = (id: number, status: OsTask['status'] = 'pending', subject = `task ${id}`): OsTask => ({ id: String(id), subject, status })

describe('compactBlock (pure)', () => {
  test('K1 many tasks: under the limit, marker kept, the "+N more" count is exact', () => {
    const tasks = Array.from({ length: 80 }, (_, i) => task(i + 1, 'pending', `a fairly long task subject number ${i + 1} that takes space`))
    const block = compactBlock({ plan: { title: 'P' }, tasks, lanes: null, prs: [] }, 'abcdef123456') ?? ''
    expect(block.length).toBeLessThanOrEqual(KEEPER_LIMIT)
    expect(block).toContain(keeperMarker('abcdef123456', 80, 80))
    const listed = block.split('\n').filter(line => line.startsWith('- task') || line.startsWith('- a fairly')).length
    expect(block).toContain(`- (+${80 - listed} more)`)
  })

  test('K10 the task in progress is listed first, even when it came last and the list is cut', () => {
    const tasks = [
      ...Array.from({ length: 80 }, (_, i) => task(i + 1, 'pending', `a fairly long task subject number ${i + 1} that takes space`)),
      task(81, 'in_progress', 'the one being done now'),
    ]
    const block = compactBlock({ plan: null, tasks, lanes: null, prs: [] }, 'abcdef123456') ?? ''
    const lines = block.split('\n')
    expect(lines[lines.indexOf('Open tasks (81 of 81):') + 1]).toBe('- [doing] the one being done now')
    expect(block.length).toBeLessThanOrEqual(KEEPER_LIMIT)
  })

  test('K1 a tiny limit still returns the marker', () => {
    const block = compactBlock({ plan: { title: 'P' }, tasks: [task(1), task(2)], lanes: null, prs: [] }, 'abcdef123456', 10) ?? ''
    expect(block).toContain(keeperMarker('abcdef123456', 2, 2))
  })

  test('K2 nothing to keep still gives the keep-list and the marker: empty, or only finished tasks', () => {
    const empty = compactBlock({ plan: null, tasks: [], lanes: null, prs: [] }, 's1')
    expect(empty).toContain(keeper.KEEP_LIST)
    expect(empty).toContain(keeperMarker('s1', 0, 0))
    expect(empty).not.toContain('Open tasks')
    const done = compactBlock({ plan: null, tasks: [task(1, 'completed')], lanes: [], prs: [] }, 's1')
    expect(done).toContain(keeper.KEEP_LIST)
    expect(done).toContain(keeperMarker('s1', 0, 1))
    expect(done).not.toContain('Open tasks')
  })

  test('F1 the keep-list holds the six items and the drop line, in plain words, 700 to 900 characters', () => {
    const list = keeper.KEEP_LIST
    expect(list.length).toBeGreaterThanOrEqual(700)
    expect(list.length).toBeLessThanOrEqual(900)
    for (const phrase of ['Lane id and board key', 'session label', 'open plan path', 'next step', 'every decision', 'preference', 'Absolute paths', 'branch', 'PR numbers', 'commit hashes', 'last failing test or probe', 'first error line', 'artifact path', 'handoff path or Notion row', 'open tasks', 'active one marked', 'run and passed', 'only read', "never turn 'not run' into 'passed'"]) {
      expect(list.toLowerCase()).toContain(phrase.toLowerCase())
    }
    expect(list).toContain('Drop: tool output already saved to a file, rule and skill text, dead ends, repeated MEMORY MATCH results.')
  })

  test('F2 the keep-list comes with every block: a plan, a long task list, or nothing', () => {
    for (const view of [
      { plan: { title: 'P' }, tasks: [task(1)], lanes: null, prs: [] },
      { plan: null, tasks: [], lanes: null, prs: [] },
    ]) {
      expect(compactBlock(view, 's1')).toContain(keeper.KEEP_LIST)
    }
  })

  test('F3 a huge plan, task list, lane list and PR list: under the limit, keep-list and marker whole, the "+N more" count exact', () => {
    const tasks = Array.from({ length: 400 }, (_, i) => task(i + 1, 'pending', `a fairly long task subject number ${i + 1} that takes space`))
    const view = {
      plan: { title: 'P'.repeat(500), file: 'C:/very/long/path/'.repeat(30) },
      tasks,
      lanes: Array.from({ length: 9 }, (_, i) => ({ id: `lane-${i}`, title: 'T'.repeat(300), state: 'active' })),
      prs: Array.from({ length: 20 }, (_, i) => ({ pr: 100 + i, state: 'READY' as const, whenReady: false })),
      facts: { branch: 'b'.repeat(400), name: 'n'.repeat(400), handoff: 'C:/h/'.repeat(200) },
    }
    const block = compactBlock(view, 'abcdef123456') ?? ''
    expect(block.length).toBeLessThanOrEqual(KEEPER_LIMIT)
    expect(block).toContain(keeper.KEEP_LIST)
    expect(block).toContain(keeperMarker('abcdef123456', 400, 400))
    const listed = block.split('\n').filter(line => line.startsWith('- a fairly')).length
    expect(listed).toBeGreaterThan(0)
    expect(block).toContain(`- (+${400 - listed} more)`)
  })

  test('F4 a tiny limit cuts the plan and the tasks, never the keep-list or the marker', () => {
    const block = compactBlock({ plan: { title: 'P' }, tasks: [task(1), task(2)], lanes: null, prs: [] }, 'abcdef123456', 10) ?? ''
    expect(block).toContain(keeper.KEEP_LIST)
    expect(block).toContain(keeperMarker('abcdef123456', 2, 2))
  })

  test('F5 the limit stays small enough for a summary', () => {
    expect(KEEPER_LIMIT).toBeLessThanOrEqual(2500)
    expect(KEEPER_LIMIT).toBeGreaterThan(keeper.KEEP_LIST.length)
  })

  test('F6 facts: branch, session label and handoff show when known; a name is optional and a null fact leaves no line', () => {
    const view = { plan: null, tasks: [], lanes: null, prs: [] }
    const full = compactBlock({ ...view, facts: { branch: 'feat/x', name: 'trex', handoff: 'C:/p/thoughts/shared/handoffs/g/h_a1b2c3d4_x.yaml' } }, 'a1b2c3d4-0000') ?? ''
    expect(full).toContain('Branch: feat/x')
    expect(full).toContain('Session: trex #a1b2c3d4')
    expect(full).toContain('Handoff: C:/p/thoughts/shared/handoffs/g/h_a1b2c3d4_x.yaml')
    const bare = compactBlock({ ...view, facts: { branch: null, name: null, handoff: null } }, 'a1b2c3d4-0000') ?? ''
    expect(bare).not.toContain('Branch:')
    expect(bare).not.toContain('Handoff:')
    expect(bare).toContain('Session: #a1b2c3d4')
    expect(compactBlock(view, 'a1b2c3d4-0000')).not.toContain('Branch:')
  })

  test('K7 finished tasks count in the marker only; the plan, lane and PRs show', () => {
    const block =
      compactBlock(
        { plan: { title: 'Fix the gate', file: 'plan.md' }, tasks: [task(1, 'completed', 'done one'), task(2, 'in_progress', 'doing two'), task(3, 'pending', 'later three')], lanes: [{ id: 'ccv3-mods', title: 'mods', state: 'active' }], prs: [{ pr: 12, state: 'READY', whenReady: false }, { pr: 13, state: null, whenReady: false }] },
        'abcdef123456',
      ) ?? ''
    expect(block).not.toContain('done one')
    expect(block).toContain('- [doing] doing two')
    expect(block).toContain('- later three')
    expect(block).toContain('Open tasks (2 of 3):')
    expect(block).toContain('Plan: Fix the gate (plan.md)')
    expect(block).toContain('Lane: ccv3-mods: mods (active)')
    expect(block).toContain('Watched PRs: #12 READY, #13 unchecked')
    expect(block).toContain(keeperMarker('abcdef123456', 2, 3))
  })
})

// The engine beneath the plugin: a clock, the session id, and a compaction that records what it was told.
const seen: { instructions: string | undefined | null } = { instructions: null }
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const world = (on: On, env: Record<string, string> = {}) => {
  seen.instructions = null
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: 's1' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_$, e) => {
    seen.instructions = e.instructions
    return { messages: [SUMMARY] }
  })
  let next = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
}

const twoTasks = async ($: Engine) => {
  await $.tool.call({ tool: 'TaskCreate', subject: 'alpha', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'beta', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
}

const compact = ($: Engine, trigger: string, extra: Record<string, unknown> = {}) =>
  $.session.compact({ trigger, messages: [SUMMARY], ...extra } as never)

describe('compact keeper (engine)', () => {
  test('K3 K7 a manual compaction carries the open task and the marker', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toContain('- beta')
    expect(seen.instructions).not.toContain('- alpha')
    expect(seen.instructions).toContain(keeperMarker('s1', 1, 2))
  })

  test('K4 the persons own text stays first', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual', { instructions: 'stress the test results' })
    expect(seen.instructions?.startsWith('stress the test results\n\n')).toBe(true)
    expect(seen.instructions).toContain(keeperMarker('s1', 1, 2))
  })

  test('K2 no state: the keep-list alone follows the persons text, with no task or plan line', async ($, on) => {
    world(on)
    await compact($, 'manual', { instructions: 'only this' })
    expect(seen.instructions?.startsWith('only this\n\n')).toBe(true)
    expect(seen.instructions).toContain(keeper.KEEP_LIST)
    expect(seen.instructions).toContain(keeperMarker('s1', 0, 0))
    expect(seen.instructions).not.toContain('Open tasks')
  })

  test('K5 an auto or plugin compaction is left alone', async ($, on) => {
    world(on)
    await twoTasks($)
    for (const trigger of ['auto', 'plugin']) {
      await compact($, trigger)
      expect(seen.instructions).toBeUndefined()
    }
  })

  test('K6 CCV3_MODS_OFF leaves the compaction alone', async ($, on) => {
    world(on, { CCV3_MODS_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('K6 CCV3_MOD_KEEPER_OFF leaves the compaction alone', async ($, on) => {
    world(on, { CCV3_MOD_KEEPER_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('K11 after /clear the old tasks do not reach the new summary; tasks made afterwards do', async ($, on) => {
    world(on)
    await twoTasks($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await compact($, 'manual')
    expect(seen.instructions).not.toContain('beta')
    expect(seen.instructions).not.toContain('Open tasks')
    await $.tool.call({ tool: 'TaskCreate', subject: 'gamma', description: 'd' })
    await compact($, 'manual')
    expect(seen.instructions).toContain('- gamma')
    expect(seen.instructions).not.toContain('- beta')
  })

  test('K11 a resume in the same process clears the old tasks too', async ($, on) => {
    world(on)
    await twoTasks($)
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never)
    await compact($, 'manual')
    expect(seen.instructions).not.toContain('beta')
    expect(seen.instructions).not.toContain('Open tasks')
  })

  test('K8 a subagent compaction does not get this session plan', async ($, on) => {
    world(on)
    await twoTasks($)
    await compact($, 'manual', { agentId: 'sub-1' })
    expect(seen.instructions).toBeUndefined()
  })
})

// The facts the keeper reads when a manual compaction starts: git branch of the session folder, the session name atom, and this session's newest handoff.
// A test cannot read an atom, so a state.get hook answers for `sessionName`. The files here are a Map; a path missing from it rejects.
const SID = 'a1b2c3d4-0000-4000-8000-000000000000'
const CWD = 'C:/wt/w1/src'
const HANDOFFS = 'C:/wt/w1/thoughts/shared/handoffs'
type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }
const file = (name: string, mtimeMs: number): Entry => ({ name, kind: 'file', size: 10, mtimeMs, isLink: false })
const folder = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const GIT = {
  'C:/wt/w1/.git': 'gitdir: C:/main/repo-x/.git/worktrees/w1\r\n',
  'C:/main/repo-x/.git/worktrees/w1/HEAD': 'ref: refs/heads/feat/one\r\n',
  'C:/main/repo-x/.git/worktrees/w1/commondir': '../..\r\n',
}

type Facts = { files: Record<string, string>; dirs: Record<string, Entry[]>; name: string | null; cwdFails: boolean }
const factsWorld = (on: On, facts: Partial<Facts> = {}, env: Record<string, string> = {}) => {
  const w: Facts = { files: {}, dirs: {}, name: null, cwdFails: false, ...facts }
  const slash = (path: string) => path.replace(/\\/g, '/')
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: SID }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_$, e) => {
    seen.instructions = e.instructions
    return { messages: [SUMMARY] }
  })
  const where = () => {
    if (w.cwdFails) throw new Error('no cwd')
    return { value: CWD }
  }
  on('session.cwd', where)
  on('session.root', where)
  on('fs.read', (_$, e) => {
    const hit = w.files[slash(e.path)]
    if (hit === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: hit }
  })
  on('fs.list', (_$, e) => {
    const hit = w.dirs[slash(e.path ?? '')]
    if (hit === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: hit }
  })
  on('state.get', { plugin: 'ccv3-mods', key: 'sessionName' } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) =>
    w.name === null ? next(e) : { value: { value: w.name, version: 1 } }) as never)
  seen.instructions = null
}

const HANDOFF_DIRS = {
  [HANDOFFS]: [folder('general'), folder('other')],
  [`${HANDOFFS}/general`]: [file('2026-11-07_10-00_a1b2c3d4_old.yaml', 100), file('2026-11-07_12-00_ffffffff_theirs.yaml', 300), file('2026-10-01_legacy.yaml', 400)],
  [`${HANDOFFS}/other`]: [file('2026-11-07_11-00_a1b2c3d4_new.yaml', 200)],
}

describe('compact keeper facts (engine)', () => {
  test('F7 the branch of a linked worktree, read from the session folder, shows in the block', async ($, on) => {
    factsWorld(on, { files: GIT })
    await compact($, 'manual')
    expect(seen.instructions).toContain('Branch: feat/one')
    expect(seen.instructions).toContain(keeper.KEEP_LIST)
  })

  test('F8 the session label is the sessionName atom and #sid8', async ($, on) => {
    factsWorld(on, { name: 'trex' })
    await compact($, 'manual')
    expect(seen.instructions).toContain('Session: trex #a1b2c3d4')
  })

  test('F8 an unnamed session is #sid8 alone', async ($, on) => {
    factsWorld(on)
    await compact($, 'manual')
    expect(seen.instructions).toContain('Session: #a1b2c3d4')
  })

  test('F9 the newest handoff of this session id is named; other sessions and unmarked files are not; a folder above the session folder is searched', async ($, on) => {
    factsWorld(on, { dirs: HANDOFF_DIRS })
    await compact($, 'manual')
    expect(seen.instructions).toContain(`Handoff: ${HANDOFFS}/other/2026-11-07_11-00_a1b2c3d4_new.yaml`)
    expect(seen.instructions).not.toContain('ffffffff')
    expect(seen.instructions).not.toContain('legacy')
  })

  test('F10 no handoff of this session: no Handoff line', async ($, on) => {
    factsWorld(on, { dirs: { [HANDOFFS]: [folder('general')], [`${HANDOFFS}/general`]: [file('2026-11-07_12-00_ffffffff_theirs.yaml', 300)] } })
    await compact($, 'manual')
    expect(seen.instructions).not.toContain('Handoff:')
    expect(seen.instructions).toContain(keeper.KEEP_LIST)
  })

  test('F11 a session folder, git files and handoff folder that cannot be read: no throw, the keep-list and marker still arrive', async ($, on) => {
    factsWorld(on, { cwdFails: true })
    await compact($, 'manual', { instructions: 'mine' })
    expect(seen.instructions?.startsWith('mine\n\n')).toBe(true)
    expect(seen.instructions).toContain(keeper.KEEP_LIST)
    expect(seen.instructions).toContain(keeperMarker(SID, 0, 0))
    expect(seen.instructions).not.toContain('Branch:')
    expect(seen.instructions).not.toContain('Handoff:')
  })

  test('F12 CCV3_MOD_KEEPER_OFF skips the facts and the keep-list', async ($, on) => {
    factsWorld(on, { files: GIT, dirs: HANDOFF_DIRS }, { CCV3_MOD_KEEPER_OFF: '1' })
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('F12 CCV3_MODS_OFF skips the facts and the keep-list', async ($, on) => {
    factsWorld(on, { files: GIT, dirs: HANDOFF_DIRS }, { CCV3_MODS_OFF: '1' })
    await compact($, 'manual')
    expect(seen.instructions).toBeUndefined()
  })

  test('F12 a subagent compaction gets no facts and no keep-list', async ($, on) => {
    factsWorld(on, { files: GIT, dirs: HANDOFF_DIRS })
    await compact($, 'manual', { agentId: 'sub-1' })
    expect(seen.instructions).toBeUndefined()
  })
})

describe('keeper record (pure)', () => {
  test('K12 markerKept: the exact marker is kept, in any one of the texts', () => {
    const marker = keeperMarker('s1', 1, 2)
    expect(keeper.markerKept([`Summary.\n${marker}\nMore.`], 's1', 1, 2)).toBe(true)
    expect(keeper.markerKept(['nothing here', `${marker}.`], 's1', 1, 2)).toBe(true)
    expect(keeper.markerKept([marker], 's1', 1, 2)).toBe(true)
  })

  test('K13 markerKept: no marker, another session, other counts, or a longer count is not kept', () => {
    expect(keeper.markerKept([], 's1', 1, 2)).toBe(false)
    expect(keeper.markerKept(['a summary with no marker'], 's1', 1, 2)).toBe(false)
    expect(keeper.markerKept([keeperMarker('s2', 1, 2)], 's1', 1, 2)).toBe(false)
    expect(keeper.markerKept([keeperMarker('s1', 1, 3)], 's1', 1, 2)).toBe(false)
    expect(keeper.markerKept([`${keeperMarker('s1', 1, 2)}0`], 's1', 1, 2)).toBe(false)
    expect(keeper.markerKept([keeperMarker('s1', 1, 20)], 's1', 1, 2)).toBe(false)
  })

  test('K13 markerKept: a longer-count lookalike does not hide a true marker later in the text', () => {
    const text = `${keeperMarker('s1', 1, 20)} and later ${keeperMarker('s1', 1, 2)}.`
    expect(keeper.markerKept([text], 's1', 1, 2)).toBe(true)
  })

  test('K13 markerKept: a session id is matched on its first 8 characters, as the marker writes it', () => {
    const long = '364266d5-0000-4000-8000-000000000000'
    expect(keeper.markerKept([keeperMarker(long, 3, 9)], long, 3, 9)).toBe(true)
    expect(keeper.markerKept([keeperMarker('364266d5-ffff', 3, 9)], long, 3, 9)).toBe(true)
    expect(keeper.markerKept([keeperMarker('364266d6-0000', 3, 9)], long, 3, 9)).toBe(false)
  })

  test('K15 addRecord: newest last, capped at MAX_RECORDS (10), the input list not changed', () => {
    const rec = (n: number): KeeperRecord => ({ at: n, sessionId: 's1', open: 1, total: 2, kept: true })
    expect(keeper.MAX_RECORDS).toBe(10)
    const list = Array.from({ length: 10 }, (_, i) => rec(i + 1))
    const frozen = Object.freeze([...list])
    const out = keeper.addRecord(frozen, rec(11))
    expect(out).toHaveLength(10)
    expect(out.map(one => one.at)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(frozen).toHaveLength(10)
    expect(keeper.addRecord([], rec(1))).toEqual([rec(1)])
    expect(keeper.addRecord(list, rec(11), 3).map(one => one.at)).toEqual([9, 10, 11])
  })

  test('K7 openCounts agrees with the marker compactBlock writes', () => {
    const tasks = [task(1, 'completed'), task(2, 'pending'), task(3, 'in_progress')]
    expect(keeper.openCounts(tasks)).toEqual({ open: 2, total: 3 })
    const block = compactBlock({ plan: null, tasks, lanes: null, prs: [] }, 's1') ?? ''
    expect(block).toContain(keeperMarker('s1', keeper.openCounts(tasks).open, keeper.openCounts(tasks).total))
  })
})

// The engine beneath the plugin for the record tests: one session.compact hook driven by `rec`, and a view of every write to `compactions`.
type Rec = {
  messages: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  skip: string | undefined
  calls: number
  writes: KeeperRecord[][]
  poisoned: boolean
  gets: number
}
const rec: Rec = { messages: [], skip: undefined, calls: 0, writes: [], poisoned: false, gets: 0 }
const summaryWith = (text: string) => ({ role: 'user' as const, text, toolUses: [] as never[] })
const MARKER = keeperMarker('s1', 1, 2)

const recordWorld = (on: On, env: Record<string, string> = {}) => {
  Object.assign(rec, { messages: [summaryWith(`Summary of the work.\n${MARKER}\nEnd.`)], skip: undefined, calls: 0, writes: [], poisoned: false, gets: 0 })
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('session.id', () => ({ value: 's1' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', () => {
    rec.calls += 1
    return rec.skip === undefined ? { messages: rec.messages } : { skip: rec.skip }
  })
  let next = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  on('state.set', { plugin: 'ccv3-mods', key: 'compactions' } as never, ((_$: unknown, e: { value: KeeperRecord[] }, next: (e: unknown) => unknown) => {
    rec.writes.push(e.value)
    return next(e)
  }) as never)
  on('state.get', { plugin: 'ccv3-mods', key: 'compactions' } as never, ((_$: unknown, e: unknown, next: (e: unknown) => unknown) => {
    rec.gets += 1
    return rec.poisoned ? { value: 42, version: 1 } : next(e)
  }) as never)
}

const lastWrite = (): KeeperRecord[] => rec.writes.at(-1) ?? []
const RECORD_KEPT: KeeperRecord = { at: 1_000, sessionId: 's1', open: 1, total: 2, kept: true }

describe('compact keeper record (engine)', () => {
  test('K12 a manual compaction whose summary holds the marker records kept=true and returns the compaction as it was', async ($, on) => {
    recordWorld(on)
    await twoTasks($)
    const result = (await compact($, 'manual')) as { messages?: unknown }
    expect(lastWrite()).toEqual([RECORD_KEPT])
    expect(result.messages).toEqual(rec.messages)
    expect(rec.calls).toBe(1)
  })

  test('K13 a summary without the marker records kept=false', async ($, on) => {
    recordWorld(on)
    rec.messages = [summaryWith('Summary of the work. The tasks are gone.')]
    await twoTasks($)
    await compact($, 'manual')
    expect(lastWrite()).toEqual([{ ...RECORD_KEPT, kept: false }])
  })

  test('K13 a marker followed by a digit ("of 20") records kept=false', async ($, on) => {
    recordWorld(on)
    rec.messages = [summaryWith(`Summary.\n${MARKER}0\nEnd.`)]
    await twoTasks($)
    await compact($, 'manual')
    expect(lastWrite()).toEqual([{ ...RECORD_KEPT, kept: false }])
  })

  test('K13 the marker of another session, or for other counts, records kept=false', async ($, on) => {
    recordWorld(on)
    rec.messages = [summaryWith(`Summary.\n${keeperMarker('s2', 1, 2)}\n${keeperMarker('s1', 2, 2)}\nEnd.`)]
    await twoTasks($)
    await compact($, 'manual')
    expect(lastWrite()).toEqual([{ ...RECORD_KEPT, kept: false }])
  })

  test('K13b a marker only in an old kept message, not in the summary, records kept=false', async ($, on) => {
    recordWorld(on)
    rec.messages = [summaryWith('A new summary that lost the plan.'), summaryWith(`An earlier summary kept in the transcript.\n${MARKER}`)]
    await twoTasks($)
    await compact($, 'manual')
    expect(lastWrite()).toEqual([{ ...RECORD_KEPT, kept: false }])
  })

  test('K14 an auto or plugin compaction records nothing', async ($, on) => {
    recordWorld(on)
    await twoTasks($)
    for (const trigger of ['auto', 'plugin']) await compact($, trigger)
    expect(rec.calls).toBe(2)
    expect(rec.writes).toEqual([])
  })

  test('K14 a subagent compaction records nothing', async ($, on) => {
    recordWorld(on)
    await twoTasks($)
    await compact($, 'manual', { agentId: 'sub-1' })
    expect(rec.calls).toBe(1)
    expect(rec.writes).toEqual([])
  })

  test('K14 CCV3_MODS_OFF records nothing', async ($, on) => {
    recordWorld(on, { CCV3_MODS_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(rec.writes).toEqual([])
  })

  test('K14 CCV3_MOD_KEEPER_OFF records nothing', async ($, on) => {
    recordWorld(on, { CCV3_MOD_KEEPER_OFF: '1' })
    await twoTasks($)
    await compact($, 'manual')
    expect(rec.writes).toEqual([])
  })

  test('K14 a skip result records nothing and is returned', async ($, on) => {
    recordWorld(on)
    rec.skip = 'a classic PreCompact hook said no'
    await twoTasks($)
    const result = (await compact($, 'manual')) as { skip?: string }
    expect(result.skip).toBe('a classic PreCompact hook said no')
    expect(rec.writes).toEqual([])
  })

  test('K14 a session with nothing to keep still gets the keep-list; the record says open 0 of 0, marker not kept', async ($, on) => {
    recordWorld(on)
    await compact($, 'manual')
    expect(rec.calls).toBe(1)
    expect(lastWrite()).toEqual([{ ...RECORD_KEPT, open: 0, total: 0, kept: false }])
  })

  test('K15 after 11 manual compactions the list holds the newest 10, newest last', async ($, on) => {
    recordWorld(on)
    for (let i = 1; i <= 11; i++) {
      await $.tool.call({ tool: 'TaskCreate', subject: `task ${i}`, description: 'd' })
      await compact($, 'manual')
    }
    expect(lastWrite()).toHaveLength(10)
    expect(lastWrite().map(one => one.total)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  test('K16 an error in the record step calls next once, returns its result, and the next compaction still records', async ($, on) => {
    recordWorld(on)
    await twoTasks($)
    rec.poisoned = true
    const first = (await compact($, 'manual')) as { messages?: unknown }
    expect(rec.gets).toBeGreaterThan(0)
    expect(rec.calls).toBe(1)
    expect(first.messages).toEqual(rec.messages)
    rec.poisoned = false
    await compact($, 'manual')
    expect(rec.calls).toBe(2)
    expect(lastWrite().at(-1)).toEqual(RECORD_KEPT)
  })
})
