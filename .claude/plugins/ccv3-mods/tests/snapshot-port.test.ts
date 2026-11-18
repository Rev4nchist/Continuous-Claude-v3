import { describe, expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { SNAPSHOT_THROTTLE_MS, decide, openThrottle, requestSnapshot, trailingDue } from '../hooks/shared/snapshot-port'

// The throttle of the snapshot port on its own (card coord-status-band-2, fix 4; design 2026-11-16-coord-status-band-2-fix4-design.md, section 4).
// `decide` and `trailingDue` are pure, so every branch is reached with the real code and no engine. The mod-level tests (a real spawn, a real
// snapshot file, the engine clock) are in snapshot-on-spawn.test.ts.
//
// Ways it can fail, one test each, with the change that breaks it:
// U3  a burst writes once per request: the `now - t.lastAt` test is removed, or each request arms its own timer (the `t.dueAt` wait is removed)
// U4  the trailing write is lost, early, or twice: `trailingDue` ignores `dueAt`, or the delay `due - now` is wrong
// U4b a write after the arm leaves the old timer alive: `decide` does not clear `dueAt` on a write
// U6  a broken clock or a failing atom write reaches the caller: the try/catch in `requestSnapshot` or `bump` is removed
// U11 a clock that went back (a new engine) keeps the throttle shut: the `now < t.lastAt` test is removed
// U12 a timer the engine dropped blocks every later trailing write: `dueAt` is held as a bare flag (the `now < t.dueAt` test is removed)
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

describe('snapshot port: it never throws', () => {
  test('U6 an atom write that throws does not break the caller', async () => {
    const broken = { state: { get: async () => { throw new Error('no state') }, set: async () => { throw new Error('no state') } } } as unknown as EngineInterface
    await expect(requestSnapshot(broken)).resolves.toBeUndefined()
    await expect(requestSnapshot({} as EngineInterface)).resolves.toBeUndefined()
  })
})
