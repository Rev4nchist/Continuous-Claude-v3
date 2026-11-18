import { describe, expect, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { agentLedger } from '../hooks/agent-ledger/index'
import { SNAPSHOT_THROTTLE_MS, decide, openThrottle, requestSnapshot, trailingDue } from '../hooks/shared/snapshot-port'

// The throttle of the snapshot port on its own (card coord-status-band-2, fix 4; design rev 2: .claudedocs/coordination/2026-11-18-coord-status-band-2-fix4-design-rev2.md).
// `decide` and `trailingDue` are pure, so every branch is reached with the real code and no engine. The mod-level tests (a real spawn, a real
// snapshot file, the engine clock) are in snapshot-on-spawn.test.ts.
//
// Ways it can fail, one test each, with the change that breaks it:
// U3  a burst writes once per request: the `now - t.lastAt` test is removed, or each request arms its own timer (the `t.dueAt !== null` wait is removed)
// U4  the trailing write is lost, early, or twice: `trailingDue` ignores `dueAt`, or the delay `due - now` is wrong
// U4b a write after the arm leaves the old timer alive: `decide` does not clear `dueAt` on a write
// U5 / F5 no listener for snapshotWanted: a spawn through the real agent-ledger hook changes its answer, throws, or writes a file: `requestSnapshot` rethrows, or writes the file itself
// U6 / F6 the bump throws into the caller (a state write that throws, or no state): the try/catch in `requestSnapshot` is removed
// U11 a clock that went back (a new engine) keeps the throttle shut: the `now < t.lastAt` test is removed
// U12 a timer the engine dropped blocks every later request: the `t.dueAt !== null` wait is moved above the window test in `decide`
// U13 a new throttle is not open: `openThrottle` starts with a time in it

describe('snapshot port: the throttle', () => {
  test('U3 a burst of 50 requests at one instant writes 2 times: the first, and one trailing', () => {
    const t = openThrottle()
    const steps = Array.from({ length: 50 }, () => decide(t, 1_000_000))
    expect(steps.filter(step => step.kind === 'write')).toHaveLength(1)
    expect(steps.filter(step => step.kind === 'arm')).toHaveLength(1)
    expect(steps.filter(step => step.kind === 'wait')).toHaveLength(48)
    const arm = steps.find(step => step.kind === 'arm')
    expect(trailingDue(t, arm?.kind === 'arm' ? arm.due : -1, 1_000_000 + SNAPSHOT_THROTTLE_MS)).toBe(true)
  })

  test('U4 the trailing write is due at the end of the window, once, and only for the timer that was armed', () => {
    const t = openThrottle()
    expect(decide(t, 5_000)).toEqual({ kind: 'write' })
    expect(decide(t, 5_700)).toEqual({ kind: 'arm', ms: SNAPSHOT_THROTTLE_MS - 700, due: 5_000 + SNAPSHOT_THROTTLE_MS })
    expect(trailingDue(t, 5_000 + SNAPSHOT_THROTTLE_MS + 1, 7_000)).toBe(false)
    expect(trailingDue(t, 5_000 + SNAPSHOT_THROTTLE_MS, 7_000)).toBe(true)
    expect(trailingDue(t, 5_000 + SNAPSHOT_THROTTLE_MS, 7_000)).toBe(false)
  })

  test('U4 a lone request arms nothing; one at the exact end of the window writes at once', () => {
    const t = openThrottle()
    expect(decide(t, 5_000).kind).toBe('write')
    expect(decide(t, 5_000 + SNAPSHOT_THROTTLE_MS - 1).kind).toBe('arm')
    const u = openThrottle()
    decide(u, 5_000)
    expect(decide(u, 5_000 + SNAPSHOT_THROTTLE_MS).kind).toBe('write')
  })

  test('U4b a write after an arm kills the old timer: it must not write a third time', () => {
    const t = openThrottle()
    decide(t, 5_000)
    const arm = decide(t, 5_100)
    expect(decide(t, 7_100).kind).toBe('write')
    expect(trailingDue(t, arm.kind === 'arm' ? arm.due : -1, 7_200)).toBe(false)
  })

  test('U11 a clock that went back (a new engine, the same module) does not hold the throttle shut', () => {
    const t = openThrottle()
    decide(t, 5_000_000)
    expect(decide(t, 1_000).kind).toBe('write')
  })

  test('U12 a trailing timer the engine dropped does not block later requests', () => {
    const t = openThrottle()
    decide(t, 5_000)
    expect(decide(t, 5_100).kind).toBe('arm')
    // The timer never fired. A request after the due time writes, and a later one inside its window arms again.
    expect(decide(t, 20_000).kind).toBe('write')
    expect(decide(t, 20_100).kind).toBe('arm')
  })

  test('U13 a new throttle has no time in it', () => {
    expect(openThrottle()).toEqual({ lastAt: null, dueAt: null })
  })
})

describe('snapshot port: no listener', () => {
  // The real agentLedger(on) is given an `on` that only collects its hooks; the agent.spawn hook is then run with a `$` of an engine that has
  // only agent-ledger: state in a map, no state.set hook, no agentic-os. The kit cannot load one module of the plugin, so the module is loaded here.
  test('U5 / F5 with no listener for snapshotWanted (agent-ledger alone), a spawn returns the unchanged answer, no call fails and no snapshot file is written', async () => {
    const hooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    const collect = ((event: string, ...rest: unknown[]) => {
      hooks[event] = rest.at(-1) as (...args: unknown[]) => Promise<unknown>
      const registered: { catch: () => unknown } = { catch: () => registered }
      return registered
    }) as unknown as On
    agentLedger(collect)

    const store = new Map<string, { value: unknown; version: number }>()
    const calls = { write: [] as string[], set: [] as string[] }
    const key = (ref: { plugin: string; key: string }) => `${ref.plugin}/${ref.key}`
    const $ = {
      env: { get: async () => undefined },
      clock: { now: async () => 1_000 },
      session: { root: async () => '/repo' },
      fs: {
        exists: async () => false,
        read: async () => '',
        write: async (path: string) => {
          calls.write.push(path)
        },
      },
      state: {
        get: async (ref: { plugin: string; key: string }) => store.get(key(ref)) ?? { value: undefined, version: 0 },
        set: async (ref: { plugin: string; key: string }, value: unknown) => {
          calls.set.push(ref.key)
          store.set(key(ref), { value, version: (store.get(key(ref))?.version ?? 0) + 1 })
          return { isSet: true, version: 1 }
        },
      },
    } as unknown as EngineInterface

    const answer = { model: 'claude-sonnet-5-5', agentId: 'a1' }
    const event = { tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false }
    const result = await hooks['agent.spawn']?.($, event, async () => answer)
    // Let the bump that the spawn does not wait for finish.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(JSON.stringify(result)).toBe(JSON.stringify(answer))
    // The run was recorded and the bump ran (so the test did reach requestSnapshot), and nothing wrote a file.
    expect(calls.set).toContain('agentRuns')
    expect(calls.set).toContain('snapshotWanted')
    expect(calls.write).toEqual([])
  })
})

describe('snapshot port: it never throws', () => {
  test('U6 / F6 a bump whose state write throws, or a $ with no state, does not break the caller (this is the throw case, not item 5)', async () => {
    const broken = { state: { get: async () => { throw new Error('no state') }, set: async () => { throw new Error('no state') } } } as unknown as EngineInterface
    await expect(requestSnapshot(broken)).resolves.toBeUndefined()
    await expect(requestSnapshot({} as EngineInterface)).resolves.toBeUndefined()
  })
})
