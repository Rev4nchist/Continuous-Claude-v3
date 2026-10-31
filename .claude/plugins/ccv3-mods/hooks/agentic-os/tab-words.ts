// The plain words for four /os tabs (Dave, 2026-10-30): Plan is Steps, Proof is Checks, Decisions is Choices, and Swarm is new. Labels only: the tab ids
// (plan, proof, decisions), the Button keys, the osTab atom and the brief_set fields keep their old names. One list, so the strip label, the
// header, the empty state and the `…more -> <tab>` hint of digest.ts cannot drift apart. It is its own file because os-tabs-model.ts imports
// digest.ts, so digest.ts cannot import os-tabs-model.ts.

export type TabWord = {
  /** The strip label and the digest hint. */
  label: string
  /** The header row of the tab. */
  head: string
  /** The dim row of a tab with nothing to show. */
  none: string
}

const word = (label: string, none: string): TabWord => ({ label, head: label.toUpperCase(), none })

/** Keyed by tab id. */
export const WORDS = {
  plan: word('Steps', 'no steps yet (no task list, no brief_set plan)'),
  proof: word('Checks', 'no checks yet (nothing is done, or nothing is proven)'),
  decisions: word('Choices', 'no choices yet'),
  swarm: word('Swarm', 'no helpers yet this session'),
} as const

/** Where the Steps tab took its steps from: the task list, else the brief's own list. */
export const STEP_SOURCE = { tasks: 'tasks', brief: 'brief steps' } as const
