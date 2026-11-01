import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { tableProblems } from './state-table'
import type { Cell } from './state-table'

// T1: the status of a subagent in the Agentic OS mod, as a state x event table (check C5).
//
// Three sources say what a subagent is doing: the Agent Ledger (a run that spawn recorded), the agent.list read (the `agents`
// atom), and the subagent's own turn.start and turn.complete. The AGENTS rows, NOW and the chip all come from them. CodeRabbit
// found two Majors on PR 206 that were a state and an event nobody had paired: #27 (an idle pulse never re-read the list while a
// ledger run was running, and a turn.start left a waiting list entry in place) and #28 (the next list read put a stale `waiting`
// over the `running` that a turn.start set). This table lists every pair, so the next pair that is missing fails a test.
//
// States (what the mod holds before the event):
//   none                     no run, no listed agent
//   listed-waiting           a ledger run is running; the list holds it as waiting
//   listed-running           a ledger run is running; the list holds it as running
//   running-after-start      listed-waiting, then the agent's own turn.start flipped the entry to running
//   ledger-running-unlisted  a ledger run is running; no list read has happened yet (the list now says completed)
//   ended                    the agent's turn.complete settled the run (done)
// Events: the list says waiting / running / completed (read by a main-turn pulse), the agent's turn.start, the agent's
// turn.complete, and an idle pulse (no main turn, no step: the 5 s tick with nobody working).
// A cell asserts three things in the snapshot the mod writes: the AGENTS rows, the ledger run statuses, and the chip.
//
// Break it (the cell that goes red):
//   #27 the idle pulse does not re-read the list while a run is running:    ledger-running-unlisted + idle-pulse
//   #27 a subagent turn.start leaves a waiting list entry as it is:         listed-waiting + subagent-turn-start
//   #28 a list read replaces a running entry with an older waiting:         running-after-start + list-waiting,
//                                                                           running-after-start + idle-pulse
//   turn.complete does not remove the entry or settle the run:              listed-waiting + subagent-turn-complete
//   turn.start does not reopen a settled run:                               ended + subagent-turn-start
//   the table loses a cell or a kind:                                       T1 table is complete

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'

type Seen = { writes: { path: string; text: string }[]; clock: ReturnType<typeof mock.clock>; agents: unknown[] }

// The engine below the mod, mocked. Each table file builds its own world (see brief.test.ts for the long form).
const world = (on: On) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  const seen: Seen = { writes: [], clock, agents: [] }
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: seen.agents as never }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return seen
}

const startMod = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
const spawnScout = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
const subagentStart = ($: Engine) => $.turn.start({ turnId: 'sub', agentId: 'a1' } as never)
const subagentEnd = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'end_turn' } as never)
const settle = async () => {
  // The pulse runs unawaited (void pulse): let its reads finish.
  for (let turns = 0; turns < 50; turns += 1) await Promise.resolve()
}
const listing = (seen: Seen, status: string) => {
  seen.agents = [{ id: 'a1', status, description: 'map the hooks', type: 'scout' }]
}
/** A main turn runs one 5 s pulse, and a running turn re-reads agent.list on every pulse. */
const mainTurnPulse = async ($: Engine, seen: Seen) => {
  await $.turn.start({ turnId: 't1' } as never)
  await seen.clock.advance(5_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
  await settle()
}
/** The 5 s tick with no main turn and no step. */
const idleTick = async (seen: Seen) => {
  await seen.clock.advance(5_000)
  await settle()
}

const lastSnapshot = (seen: Seen): Record<string, any> => {
  const files = seen.writes.filter(write => /[\\/]test-session\.json$/.test(write.path))
  return JSON.parse(files.at(-1)?.text ?? '{}')
}

type Arrange = ($: Engine, seen: Seen) => Promise<void>
const STATES: Record<string, Arrange> = {
  none: async () => undefined,
  'listed-waiting': async ($, seen) => {
    await spawnScout($)
    listing(seen, 'waiting')
    await mainTurnPulse($, seen)
  },
  'listed-running': async ($, seen) => {
    await spawnScout($)
    listing(seen, 'running')
    await mainTurnPulse($, seen)
  },
  'running-after-start': async ($, seen) => {
    await STATES['listed-waiting']($, seen)
    await subagentStart($)
  },
  'ledger-running-unlisted': async ($, seen) => {
    await spawnScout($)
    listing(seen, 'completed')
  },
  ended: async $ => {
    await spawnScout($)
    await subagentEnd($)
  },
}
type Act = ($: Engine, seen: Seen) => Promise<void>
const EVENTS: Record<string, Act> = {
  'list-waiting': async ($, seen) => {
    listing(seen, 'waiting')
    await mainTurnPulse($, seen)
  },
  'list-running': async ($, seen) => {
    listing(seen, 'running')
    await mainTurnPulse($, seen)
  },
  'list-gone': async ($, seen) => {
    // The list holds the agent as completed: it left the live set.
    listing(seen, 'completed')
    await mainTurnPulse($, seen)
  },
  'subagent-turn-start': async $ => {
    await subagentStart($)
  },
  'subagent-turn-complete': async $ => {
    await subagentEnd($)
  },
  'idle-pulse': async (_$, seen) => {
    await idleTick(seen)
  },
}

type Want = { agents: string[]; runs: string[]; chip: 'working' | 'idle' }
const W = 'a1:waiting'
const R = 'a1:running'
const idle = (agents: string[], runs: string[]): Want => ({ agents, runs, chip: 'idle' })
const working = (agents: string[], runs: string[]): Want => ({ agents, runs, chip: 'working' })
const label = (w: Want) => `AGENTS [${w.agents.join(' ')}] runs [${w.runs.join(' ')}] chip ${w.chip}`
type TableCell = Cell & { want?: Want }
const c = (state: string, event: string, want: Want): TableCell => ({ state, event, expect: label(want), want })

const states = Object.keys(STATES)
const events = Object.keys(EVENTS)
const cells: TableCell[] = [
  // No run and no listed agent: the list alone decides what shows; an agent the mod never saw spawn changes nothing.
  c('none', 'list-waiting', idle([W], [])),
  c('none', 'list-running', working([R], [])),
  c('none', 'list-gone', idle([], [])),
  c('none', 'subagent-turn-start', idle([], [])),
  c('none', 'subagent-turn-complete', idle([], [])),
  c('none', 'idle-pulse', idle([], [])),
  // The list wins for an id it holds, so a waiting entry hides the running ledger run (the chip reads idle) until the agent's turn.start.
  c('listed-waiting', 'list-waiting', idle([W], ['running'])),
  c('listed-waiting', 'list-running', working([R], ['running'])),
  c('listed-waiting', 'list-gone', idle([], ['done'])),
  c('listed-waiting', 'subagent-turn-start', working([R], ['running'])),
  c('listed-waiting', 'subagent-turn-complete', idle([], ['done'])),
  c('listed-waiting', 'idle-pulse', idle([W], ['running'])),
  // A running entry stays running: an older waiting from the list does not undo it. Only the turn.complete or an ended list ends it.
  c('listed-running', 'list-waiting', working([R], ['running'])),
  c('listed-running', 'list-running', working([R], ['running'])),
  c('listed-running', 'list-gone', idle([], ['done'])),
  c('listed-running', 'subagent-turn-start', working([R], ['running'])),
  c('listed-running', 'subagent-turn-complete', idle([], ['done'])),
  c('listed-running', 'idle-pulse', working([R], ['running'])),
  // The turn.start set running; the list still says waiting (older). The turn is the newer fact (#28).
  c('running-after-start', 'list-waiting', working([R], ['running'])),
  c('running-after-start', 'list-running', working([R], ['running'])),
  c('running-after-start', 'list-gone', idle([], ['done'])),
  c('running-after-start', 'subagent-turn-start', working([R], ['running'])),
  c('running-after-start', 'subagent-turn-complete', idle([], ['done'])),
  c('running-after-start', 'idle-pulse', working([R], ['running'])),
  // The ledger knows the run; the list was not read yet. An idle pulse reads it now (#27).
  c('ledger-running-unlisted', 'list-waiting', idle([W], ['running'])),
  c('ledger-running-unlisted', 'list-running', working([R], ['running'])),
  c('ledger-running-unlisted', 'list-gone', idle([], ['done'])),
  c('ledger-running-unlisted', 'subagent-turn-start', working([R], ['running'])),
  c('ledger-running-unlisted', 'subagent-turn-complete', idle([], ['done'])),
  c('ledger-running-unlisted', 'idle-pulse', idle([], ['done'])),
  // A settled run. The list is the engine's own word, so it still shows an agent it holds; the run stays done until a turn.start.
  c('ended', 'list-waiting', idle([W], ['done'])),
  c('ended', 'list-running', working([R], ['done'])),
  c('ended', 'list-gone', idle([], ['done'])),
  c('ended', 'subagent-turn-start', working([R], ['running'])),
  c('ended', 'subagent-turn-complete', idle([], ['done'])),
  c('ended', 'idle-pulse', idle([], ['done'])),
]

const kinds = {
  'stale-read': ['list-waiting'],
  duplicate: ['subagent-turn-start', 'subagent-turn-complete'],
  'second-entry': ['subagent-turn-start'],
  'timer-overlap': ['idle-pulse'],
  'retained-flag': { na: 'no flag outlives a turn: turn.complete removes the entry and settles the run, and turn.start reopens it (the ended + subagent-turn-start cell)' },
}

describe('T1 agent status table', () => {
  test('T1 table is complete', () => {
    expect(tableProblems({ states, events, cells, kinds })).toEqual([])
  })

  for (const cell of cells.filter(one => !('na' in one))) {
    test(`T1 ${cell.state} + ${cell.event} -> ${cell.expect}`, async ($, on) => {
      const seen = world(on)
      await startMod($)
      await STATES[cell.state]($, seen)
      await EVENTS[cell.event]($, seen)
      await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
      const snapshot = lastSnapshot(seen)
      const want = cell.want as Want
      const where = `${cell.state} + ${cell.event}`
      expect(snapshot.agents.map((one: { id: string; status: string }) => `${one.id}:${one.status}`), `${where}: AGENTS rows`).toEqual(want.agents)
      expect(snapshot.agentRuns.map((one: { status: string }) => one.status), `${where}: ledger run statuses`).toEqual(want.runs)
      expect(snapshot.chip, `${where}: chip`).toBe(want.chip)
    })
  }
})
