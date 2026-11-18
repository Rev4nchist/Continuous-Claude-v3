import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

// The snapshot port (card coord-status-band-2, fix 4). The snapshot writer lives in hooks/agentic-os/index.tsx. agent-ledger holds the plugin's one
// unmatched agent.spawn hook (the engine refuses a second: probed 2026-11-18 on 2.1.327), so agentic-os cannot hook the spawn itself.
// Two engine facts shaped this module (both seen 2026-11-18 in `claude plugin test`):
// - A writer handed to a slot here and called with `$` is refused at load: "$ itself is passed as an argument" (the engine follows `$` only into
//   a function declaration). So the port does not call the writer. It bumps the `snapshotWanted` atom, and agentic-os hooks the state.set of
//   that atom and writes there, with its own `$`.
// - A state write from a `clock.after` callback of another hook does not reach the plugin's state.set hooks. So the throttle and its trailing
//   timer run in that agentic-os hook, not here. This file holds the pure throttle (`decide`, `trailingDue`) and the bump.
// The writer keeps its guards (worthSnapshot, the session-end check): a bump is only a wish.
// Function declarations, not arrows: the engine follows $ past an import only into a declaration (see hooks/hud/seed.ts).

/** At most one write per this many milliseconds of the engine clock; a request inside it leaves one trailing write. */
export const SNAPSHOT_THROTTLE_MS = 2000

/** Bumped for each wish. agentic-os hooks its state.set by the same plugin and key. */
const snapshotWanted = atom({ plugin: 'ccv3-mods', key: 'snapshotWanted' } as const, 0)

/** The throttle's memory, in engine-clock milliseconds. */
export type Throttle = {
  /** When the last write was let through. */
  lastAt: number | null
  /** When a trailing write is due. A timer the engine dropped cannot block later requests: a request past this time arms again. */
  dueAt: number | null
}

export type Step = { kind: 'write' } | { kind: 'wait' } | { kind: 'arm'; ms: number; due: number }

export const openThrottle = (): Throttle => ({ lastAt: null, dueAt: null })

/**
 * What a wish at `now` does, and the memory after it. Pure: the caller does the write or arms the timer.
 * A clock that went back (a new engine, the same module) is not a reason to wait.
 */
export const decide = (t: Throttle, now: number): Step => {
  if (t.lastAt === null || now < t.lastAt || now - t.lastAt >= SNAPSHOT_THROTTLE_MS) {
    t.lastAt = now
    t.dueAt = null
    return { kind: 'write' }
  }
  if (t.dueAt !== null && now < t.dueAt) return { kind: 'wait' }
  const due = t.lastAt + SNAPSHOT_THROTTLE_MS
  t.dueAt = due
  return { kind: 'arm', ms: due - now, due }
}

/** The timer fired for `due`: true when it is still the trailing write that is wanted (a write since then, or a newer arm, kills it). */
export const trailingDue = (t: Throttle, due: number, now: number): boolean => {
  if (t.dueAt !== due) return false
  t.lastAt = now
  t.dueAt = null
  return true
}

/** Asks for a snapshot: one bump of the wish atom. Never throws; with nothing hooked to the atom it does nothing else. */
export async function requestSnapshot($: EngineInterface): Promise<void> {
  try {
    await update($, snapshotWanted, n => n + 1)
  } catch {
    // Observer only: a snapshot is best effort, and a failed one must not touch the caller.
  }
}
