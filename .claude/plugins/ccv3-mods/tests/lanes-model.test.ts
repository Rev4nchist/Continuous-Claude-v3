import { describe, expect, test } from 'claude-code/testing'

import { laneOverlap, parseBoard } from '../hooks/agentic-os/lanes-model'
import type { BoardLane, FileTouch } from '../types'

// /os redesign, round 1: hooks/agentic-os/lanes-model.ts, the read of `lane.mjs board --json`.
// The real shape (scripts/coordination/lane.mjs, board command, JSON_OUT): { lanes: row[], peers: { id, working_on }[], me }.
// A row is `select l.*` from agentic_os.lane, never a done lane (unless --all), and holds the laneLine columns:
// id, title, state, owner_session_id, lease_expires_at, note, scope.
//
// Contract these tests pin (the plan left these holes; the choices are mine and the implementer must follow them or change the test):
//   - parseBoard(stdout, sessionId, now): three arguments (the plan's amendment beats its interface line). `now` is epoch ms.
//   - BoardLane (types/index.d.ts) gets a boolean `live`: true only for an owned lane whose owner is in `peers[].id` and whose lease
//     has not lapsed. `leaseLapsed` is true when lease_expires_at is at or before `now`. A lane nobody owns is never live.
//     "Live peer lanes" are therefore `lanes.filter(l => !l.mine && l.live)`; the Work tab words the others as 'held by a stopped session'.
//   - `owner` is the first 8 characters of owner_session_id (lane.mjs short()), or null. The full id never leaves parseBoard.
//   - `mine` is owner_session_id === (me ?? sessionId). `mine` OsLane rows are { id, title, state, note? } with the first line of the note.
//   - laneOverlap(scope, files): scope is free text; tokens come from splitting on commas, spaces and semicolons; backslashes become
//     slashes; a token under 3 characters is ignored; a token matches a file by path prefix or by path segment (a segment equals the
//     token, or the path starts with the token). Only edited and committed files count. It returns the matched paths, each once, in file order.
//     The wording 'may touch the same files' belongs to the caller (round 2): this module returns paths.
//
// Ways the board read can fail, one test each:
// L1  a valid board is not accepted, or `mine` is wrong
// L2  an array (the old `mine` output), garbage, an empty string, null JSON or a missing or non-array `lanes` is accepted
// L3  `me` absent does not fall back to the session id; `me` present does not win over it
// L4  an unowned backlog lane, a lane whose owner session is dead, or one whose lease lapsed counts as a live peer lane
// L5  the full owner session id leaks into the result
// L6  a note keeps its later lines, or a row with no `id` crashes the read or appears
// L7  an empty board is rejected
// L8  laneOverlap: empty scope, short tokens, slash style, read files, repeated paths
// L9  laneOverlap: the pinned false positive (a broad word) and false negative (prose that names no path)

const ME = 'aaaaaaaa-1111-4000-8000-000000000001'
const PEER = 'bbbbbbbb-2222-4000-8000-000000000002'
const DEAD = 'cccccccc-3333-4000-8000-000000000003'
const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const FUTURE = new Date(NOW + 20 * 60_000).toISOString()
const LAPSED = new Date(NOW - 5 * 60_000).toISOString()

type Row = Record<string, unknown>
const row = (id: string, over: Row = {}): Row => ({
  id,
  title: `title of ${id}`,
  state: 'active',
  owner_session_id: null,
  lease_expires_at: null,
  note: null,
  scope: null,
  track: 'core',
  priority: 1,
  ...over,
})
const PEERS = [
  { id: ME, working_on: 'this session' },
  { id: PEER, working_on: 'another session' },
]
const board = (lanes: Row[], over: Row = {}) => JSON.stringify({ lanes, peers: PEERS, me: ME, ...over })

const FIVE = [
  row('mine-active', { owner_session_id: ME, lease_expires_at: FUTURE, note: 'first line\nsecond line' }),
  row('peer-live', { owner_session_id: PEER, lease_expires_at: FUTURE, scope: 'hooks/agentic-os' }),
  row('peer-dead', { owner_session_id: DEAD, lease_expires_at: FUTURE }),
  row('peer-lapsed', { owner_session_id: PEER, lease_expires_at: LAPSED }),
  row('backlog-open', { state: 'backlog', owner_session_id: null }),
]

const file = (state: FileTouch['state'], path: string): FileTouch => ({ path, state, added: 0, removed: 0 })

describe('parseBoard', () => {
  test('L1 a board reads as every lane plus my own lanes as OsLane rows with the first line of the note', () => {
    const out = parseBoard(board(FIVE), 'ignored-session', NOW)
    expect(out).not.toBeNull()
    expect(out?.lanes.map(one => one.id)).toEqual(['mine-active', 'peer-live', 'peer-dead', 'peer-lapsed', 'backlog-open'])
    expect(out?.lanes.map(one => one.mine)).toEqual([true, false, false, false, false])
    expect(out?.mine).toEqual([{ id: 'mine-active', title: 'title of mine-active', state: 'active', note: 'first line' }])
  })

  test('L2 an array, garbage, an empty string, null JSON or a board with no lanes array is not a board', () => {
    const bad = ['[]', JSON.stringify([row('a', { owner_session_id: ME })]), 'not json at all', '', 'null', '42', '{}', JSON.stringify({ peers: [], me: ME }), JSON.stringify({ lanes: 'x', peers: [], me: ME }), JSON.stringify({ lanes: { a: 1 }, peers: [], me: ME })]
    for (const stdout of bad) expect(parseBoard(stdout, ME, NOW)).toBeNull()
  })

  test('L3 with no `me` the session id decides what is mine; with a `me` it wins over the session id', () => {
    const lanes = [row('one', { owner_session_id: ME }), row('two', { owner_session_id: PEER })]
    const noMe = parseBoard(JSON.stringify({ lanes, peers: PEERS }), PEER, NOW)
    expect(noMe?.mine.map(one => one.id)).toEqual(['two'])
    expect(parseBoard(JSON.stringify({ lanes, peers: PEERS, me: null }), PEER, NOW)?.mine.map(one => one.id)).toEqual(['two'])
    const withMe = parseBoard(board(lanes), PEER, NOW)
    expect(withMe?.mine.map(one => one.id)).toEqual(['one'])
  })

  test('L4 live peer lanes are owned, held by a live session, and not lapsed: the others are not live', () => {
    const out = parseBoard(board(FIVE), ME, NOW)
    const live = (out?.lanes ?? []).filter((one: BoardLane) => !one.mine && one.live)
    expect(live.map(one => one.id)).toEqual(['peer-live'])
    const byId = Object.fromEntries((out?.lanes ?? []).map(one => [one.id, one]))
    expect(byId['peer-dead']?.live).toBe(false)
    expect(byId['peer-dead']?.owner).toBe('cccccccc')
    expect(byId['peer-lapsed']?.live).toBe(false)
    expect(byId['peer-lapsed']?.leaseLapsed).toBe(true)
    expect(byId['peer-live']?.leaseLapsed).toBeFalsy()
    expect(byId['backlog-open']?.live).toBe(false)
    expect(byId['backlog-open']?.owner).toBeNull()
  })

  test('L4 a lease that ends exactly now has lapsed', () => {
    const out = parseBoard(board([row('edge', { owner_session_id: PEER, lease_expires_at: new Date(NOW).toISOString() })]), ME, NOW)
    expect(out?.lanes[0]?.leaseLapsed).toBe(true)
    expect(out?.lanes[0]?.live).toBe(false)
  })

  test('L5 the owner is the 8 character short id and the full session id is nowhere in the result', () => {
    const out = parseBoard(board(FIVE), ME, NOW)
    expect(out?.lanes.map(one => one.owner)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'bbbbbbbb', null])
    const dump = JSON.stringify(out)
    for (const full of [ME, PEER, DEAD]) expect(dump).not.toContain(full)
  })

  test('L6 only the first line of a note is kept; the scope is kept whole; a lane with no note or scope has none', () => {
    const out = parseBoard(board([row('a', { owner_session_id: PEER, note: 'head\nrest of the note', scope: 'hooks/pr-loop, tests' }), row('b')]), ME, NOW)
    expect(out?.lanes[0]?.note).toBe('head')
    expect(out?.lanes[0]?.scope).toBe('hooks/pr-loop, tests')
    expect(out?.lanes[1]?.note).toBeUndefined()
    expect(out?.lanes[1]?.scope).toBeUndefined()
  })

  test('L6 a row with no string id is skipped without a crash', () => {
    const lanes = [{ title: 'no id' }, null, 5, 'text', row('good', { owner_session_id: ME })] as Row[]
    const out = parseBoard(board(lanes), ME, NOW)
    expect(out?.lanes.map(one => one.id)).toEqual(['good'])
  })

  test('L7 an empty board is a board', () => {
    expect(parseBoard(board([]), ME, NOW)).toEqual({ mine: [], lanes: [] })
  })
})

describe('laneOverlap', () => {
  test('L8 an empty, blank or missing scope overlaps nothing', () => {
    const files = [file('edited', 'hooks/agentic-os/digest.ts')]
    for (const scope of [undefined, '', '   ', ' , ; ']) expect(laneOverlap(scope, files)).toEqual([])
  })

  test('L8 a token matches an edited file by path prefix, and a commas, spaces or semicolons list is split', () => {
    const files = [file('edited', 'hooks/agentic-os/digest.ts'), file('edited', 'scripts/other.mjs')]
    expect(laneOverlap('hooks/agentic-os', files)).toEqual(['hooks/agentic-os/digest.ts'])
    expect(laneOverlap('zzz/none; hooks/agentic-os', files)).toEqual(['hooks/agentic-os/digest.ts'])
    expect(laneOverlap('zzz/none,hooks/agentic-os', files)).toEqual(['hooks/agentic-os/digest.ts'])
    expect(laneOverlap('zzz/none   hooks/agentic-os', files)).toEqual(['hooks/agentic-os/digest.ts'])
  })

  test('L8 a token matches a path segment that is not at the start of the path', () => {
    const files = [file('edited', '.claude/plugins/ccv3-mods/hooks/agentic-os/digest.ts')]
    expect(laneOverlap('agentic-os', files)).toEqual(['.claude/plugins/ccv3-mods/hooks/agentic-os/digest.ts'])
  })

  test('L8 tokens under 3 characters are ignored', () => {
    const files = [file('edited', 'src/ui/x.ts'), file('edited', 'a.ts'), file('committed', 'ts/b.ts')]
    expect(laneOverlap('ui, a, ts, x', files)).toEqual([])
  })

  test('L8 backslash and slash paths match each other, in the scope and in the files', () => {
    const slash = [file('edited', 'hooks/agentic-os/digest.ts')]
    const back = [file('edited', 'hooks\\agentic-os\\digest.ts')]
    expect(laneOverlap('hooks\\agentic-os', slash)).toHaveLength(1)
    expect(laneOverlap('hooks/agentic-os', back).map(one => one.replace(/\\/g, '/'))).toEqual(['hooks/agentic-os/digest.ts'])
  })

  test('L8 edited and committed files count; a file only read does not', () => {
    const files = [file('read', 'hooks/agentic-os/a.ts'), file('edited', 'hooks/agentic-os/b.ts'), file('committed', 'hooks/agentic-os/c.ts')]
    expect(laneOverlap('hooks/agentic-os', files)).toEqual(['hooks/agentic-os/b.ts', 'hooks/agentic-os/c.ts'])
  })

  test('L8 a path that two tokens match is listed once', () => {
    const files = [file('edited', 'hooks/agentic-os/digest.ts')]
    expect(laneOverlap('hooks/agentic-os, agentic-os, digest.ts', files)).toEqual(['hooks/agentic-os/digest.ts'])
  })

  test('L9 false positive, pinned: a broad word matches every path that starts with it', () => {
    expect(laneOverlap('test', [file('edited', 'tests/foo.ts')])).toEqual(['tests/foo.ts'])
    expect(laneOverlap('hooks', [file('edited', 'hooks/pr-loop/model.ts')])).toEqual(['hooks/pr-loop/model.ts'])
  })

  test('L9 false negative, pinned: prose that names no path overlaps nothing', () => {
    expect(laneOverlap('the briefing code', [file('edited', 'hooks/agentic-os/digest.ts')])).toEqual([])
  })
})
