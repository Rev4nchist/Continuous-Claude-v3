import { describe, expect, test } from 'claude-code/testing'

import { bandLines, compactLine, lineOne } from '../hooks/agentic-os/band-model'
import type { BandState } from '../hooks/agentic-os/band-model'
import { parseBoard } from '../hooks/agentic-os/lanes-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow, Span } from '../hooks/agentic-os/pane-model'
import { workTab } from '../hooks/agentic-os/work-tab'
import type { BoardLane } from '../types'

// Session identity (docs: .claudedocs/2026-11-03-session-identity-proposal.md, section 4). The label is `name #sid8`.
// Ways the band and the Work tab can fail, one test each:
// S1 line 1 loses the full token `name #sid8`, or still shows the repo or the branch (the claude-hud statusline shows them)
// S2 line 1 order is not chip, session, lane, ctx, cost; the name is not accent, `#sid8` not dim
// S3 under width pressure something other than `#sid8` goes first; then the lane; the name, ctx and cost outlast both
// S4 `+N` is missing for 3 lanes, or shows for 1 lane
// S5 an unnamed session reads anything but `unnamed` in the warn (amber) tone
// S6 compactLine loses the name at width 39, or does not clip it to 8, or drops it before 5h and 7d
// S7 at 20 columns the name displaces ctx (ctx stays last of all, README 2026-10-29 band rule)
// S8 a secret in the name reaches the drawn text
// W1 parseBoard drops owner_name. Rule: a string reads as the name, an explicit null as `no name`, an absent key as `no field`
// W2 Work tab OTHER SESSIONS: owner_name present gives `name #sid8`, null gives `#sid8`, an absent field leaves today's rows unchanged
// Decision (name vs ctx under pressure): line 1 clips the name from 16 to 8 before cost goes; ctx goes last of all.

const text = (line: Span[] | undefined): string => (line ?? []).map(span => span.text).join('')

const state = (over: Partial<BandState> = {}): BandState => ({
  chip: 'working',
  brief: null,
  tasks: [],
  repo: 'continuous-claude',
  who: { name: 'trex', short: '0d40499c' },
  lane: 'grok-stall-guards',
  laneCount: 3,
  ctx: 54,
  costUsd: 98.61,
  now: 1_000,
  activeAt: 1_000,
  ...over,
})

const one = (over: Partial<BandState>, width: number): Span[] => bandLines(state(over), width)[0] ?? []

describe('band line 1: the session label', () => {
  test('S1 the full token survives at width 100; repo and branch are not on line 1', () => {
    const line = text(one({}, 100))
    expect(line).toContain('trex #0d40499c')
    expect(line).toContain('lane grok-stall-guards +2')
    expect(line).toContain('ctx 54%')
    expect(line).toContain('$98.61')
    expect(line).not.toContain('continuous-claude')
    expect(line).not.toContain('●')
  })

  test('S2 order is chip, name #sid8, lane, ctx, cost; the name is accent and #sid8 dim', () => {
    const spans = one({}, 100)
    const line = text(spans)
    const at = ['WORKING', 'trex #0d40499c', 'lane ', 'ctx 54%', '$98.61'].map(part => line.indexOf(part))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(at.every(n => n >= 0)).toBe(true)
    expect(spans.find(span => span.text === 'trex')?.tone).toBe('title')
    expect(spans.find(span => span.text === ' #0d40499c')?.tone).toBe('dim')
  })

  test('S3 #sid8 goes first, then the lane; the name, ctx and cost outlast both at every width from 40', () => {
    // The full line is 72 cells: WORKING 9 + 2 + trex #0d40499c 14 + lane 25 + ctx 7 + cost 6 + 3 separators of 3.
    expect(text(one({}, 72))).toContain('#0d40499c')
    const tight = text(one({}, 71))
    expect(tight).not.toContain('#0d40499c')
    expect(tight).toContain('trex')
    expect(tight).toContain('lane grok-stall-guards +2')
    for (let width = 40; width <= 120; width++) {
      const line = text(one({}, width))
      expect(line.length).toBeLessThanOrEqual(width)
      expect(line).toContain('trex')
      expect(line).toContain('ctx 54%')
      if (line.includes('#0d40499c')) expect(line).toContain('lane ')
      if (line.includes('lane ')) expect(line).toContain('$98.61')
    }
  })

  test('S3 a long name is clipped to 16 at first and to 8 before cost goes', () => {
    const name = 'a-very-long-session-name'
    expect(text(one({ who: { name, short: '0d40499c' } }, 120))).toContain('a-very-long-ses… #0d40499c')
    // WAITING ON DAVE 17 + 2 + name 8 + ctx 7 + cost 6 + 2 separators of 3 = 46: the name is cut to 8 at 46 with cost kept, cost goes at 45.
    const waiting = { chip: 'waiting-on-dave' as const, who: { name, short: '0d40499c' } }
    expect(text(one(waiting, 46))).toContain('a-very-…')
    expect(text(one(waiting, 46))).toContain('$98.61')
    expect(text(one(waiting, 45))).toContain('a-very-…')
    expect(text(one(waiting, 45))).not.toContain('$98.61')
  })

  test('S4 +2 shows for 3 lanes, and one lane or no count shows no +N', () => {
    expect(text(one({ laneCount: 3 }, 100))).toContain('+2')
    expect(text(one({ laneCount: 1 }, 100))).not.toContain('+')
    expect(text(one({ laneCount: undefined }, 100))).not.toContain('+')
  })

  test('S5 an unnamed session reads unnamed in amber, with its #sid8', () => {
    const spans = one({ who: { name: null, short: 'd075f779' } }, 100)
    expect(text(spans)).toContain('unnamed #d075f779')
    expect(spans.find(span => span.text === 'unnamed')?.tone).toBe('warn')
  })

  test('S10 whitespace in the name collapses to single spaces on line 1 and on the compact line', () => {
    const who = { name: '  a   b\n\tc  ', short: '0d40499c' }
    expect(text(one({ who }, 100))).toContain('a b c #0d40499c')
    expect(text(compactLine(state({ who }), 100))).toContain('a b c ')
  })

  test('S8 a secret in the name never reaches the drawn text', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(40)
    expect(text(one({ who: { name: `x ${secret}`, short: '0d40499c' } }, 100))).not.toContain(secret)
    expect(text(compactLine(state({ who: { name: secret, short: null } }), 100))).not.toContain(secret)
  })
})

describe('band line 1: ctx goes last of all', () => {
  const waiting = { chip: 'waiting-on-dave' as const, who: { name: 'a-very-long-session-name', short: '0d40499c' }, laneCount: 1 }
  const narrow = (width: number): string => text(lineOne(state(waiting), width))

  test('S9 at the narrowest width where WAITING ON DAVE and ctx fit, ctx stays and the name goes', () => {
    // WAITING ON DAVE 17 + 2 + ctx 54% 7 = 26.
    const line = narrow(26)
    expect(line).toBe(' WAITING ON DAVE   ctx 54%')
    expect(line.length).toBeLessThanOrEqual(26)
  })

  test('S9 one cell narrower, ctx is the last to go: the chip stands alone', () => {
    expect(narrow(25)).toBe(' WAITING ON DAVE ')
  })

  test('S9 the name is clipped to the room beside ctx before it drops, and ctx never goes while the chip and ctx fit', () => {
    // 26 + DOT 3 + a name of 3 = 32.
    expect(narrow(32)).toContain('a-…')
    expect(narrow(32)).toContain('ctx 54%')
    expect(narrow(31)).not.toContain('a-')
    for (let width = 26; width <= 50; width++) {
      const line = narrow(width)
      expect(line).toContain('ctx 54%')
      expect(line.length).toBeLessThanOrEqual(width)
    }
  })

  test('S11 an unnamed session never overflows: "unnamed" drops whole when it does not fit', () => {
    for (let width = 25; width <= 50; width++) {
      const line = text(lineOne(state({ ...waiting, who: { name: null, short: '0d40499c' } }), width))
      expect(line.length).toBeLessThanOrEqual(width)
    }
  })
})

describe('compact line: the name', () => {
  test('S6 the name survives at width 39 and is clipped to 8 after the chip', () => {
    const line = text(compactLine(state({ who: { name: 'a-very-long-session', short: '0d40499c' } }), 39))
    expect(line).toContain('a-very-… ctx 54%')
    expect(line).not.toContain('#0d40499c')
    expect(line.length).toBeLessThanOrEqual(39)
    expect(text(compactLine(state({ chip: 'waiting-on-dave' }), 39))).toContain('trex ctx 54%')
  })

  test('S6 the name goes after 7d and 5h, not before', () => {
    const limits = [
      { kind: 'five_hour', percentUsed: 38 },
      { kind: 'seven_day', percentUsed: 61 },
    ] as never
    const wide = text(compactLine(state({ limits }), 100))
    expect(wide).toContain('trex')
    expect(wide).toContain('7d 61%')
    // WORKING 9 + trex 5 + ctx 8 + 5h 7 = 29 fits 30; 7d does not.
    const mid = text(compactLine(state({ limits }), 30))
    expect(mid).toContain('trex')
    expect(mid).toContain('5h 38%')
    expect(mid).not.toContain('7d')
  })

  test('S7 at 20 columns ctx stays and the name goes', () => {
    const line = text(compactLine(state(), 20))
    expect(line).toContain('ctx 54%')
    expect(line).not.toContain('trex')
  })
})

describe('Work tab: the owner of another session', () => {
  const NOW = Date.parse('2026-11-03T12:00:00.000Z')
  const ME = 'aaaaaaaa-1111-4000-8000-000000000001'
  const PEER = '5cbfb659-2222-4000-8000-000000000002'
  const row = (over: Record<string, unknown>) => ({ id: 'review-eval', title: 'eval', state: 'active', owner_session_id: PEER, lease_expires_at: null, note: null, scope: null, ...over })
  const board = (over: Record<string, unknown>): BoardLane[] =>
    parseBoard(JSON.stringify({ lanes: [row(over)], peers: [{ id: PEER, working_on: 'x' }], me: ME }), ME, NOW)?.lanes ?? []
  const tab = (lanes: BoardLane[]): TabState =>
    ({ view: { tasks: [], plan: null, turn: null, step: null, ctx: null, agents: [], lanes: null, prs: [] }, chip: 'idle', brief: null, repo: null, branch: null, worktree: null, costUsd: null, activeAt: null, board: lanes, boardAt: NOW }) as TabState
  const rows = (lanes: BoardLane[]): string =>
    workTab(tab(lanes), NOW, 80, 20)
      .map((r: PaneRow) => r.left.map(s => s.text).join(''))
      .join('\n')

  test('W1 parseBoard reads owner_name: a string, an explicit null, or no field', () => {
    expect(board({ owner_name: 'review' })[0]?.ownerName).toBe('review')
    expect(board({ owner_name: null })[0]?.ownerName).toBeNull()
    expect(board({})[0]).not.toHaveProperty('ownerName')
  })

  test('W2 OTHER SESSIONS shows name #sid8; null shows #sid8; no field is the display of today', () => {
    expect(rows(board({ owner_name: 'review' }))).toContain('review #5cbfb659')
    const unnamed = rows(board({ owner_name: null }))
    expect(unnamed).toContain('#5cbfb659')
    expect(unnamed).not.toContain('null')
    const today = rows(board({}))
    expect(today).toContain('Another session holds lane review-eval')
    expect(today).not.toContain('#5cbfb659')
  })
})
