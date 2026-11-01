// The twin of scripts/checks/state-table.mjs for the mod tests. A plugin test cannot import a file outside the
// plugin folder (spike S4: "the file did not load"), so the two checks live here as well. Change both together.
// state-table.test.ts runs the same failure cases against this copy, so a drift shows as a red test.

export const KINDS = ['stale-read', 'duplicate', 'second-entry', 'timer-overlap', 'retained-flag'] as const

export type Cell = { state: string; event: string; expect?: string; run?: unknown; na?: string }
export type Table = { states: string[]; events: string[]; cells: Cell[]; kinds: Record<string, string[] | { na: string }>; required?: readonly string[] }

const hasReason = (na: unknown): boolean => typeof na === 'string' && na.trim() !== ''

const cellProblems = (states: string[], events: string[], cells: Cell[]): string[] => {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const c of cells) {
    if (!states.includes(c.state)) problems.push(`unknown state ${c.state} in cell ${c.state} + ${c.event}`)
    if (!events.includes(c.event)) problems.push(`unknown event ${c.event} in cell ${c.state} + ${c.event}`)
    const key = `${c.state} + ${c.event}`
    if (seen.has(key)) problems.push(`repeated cell ${key}`)
    seen.add(key)
    if ('na' in c && !hasReason(c.na)) problems.push(`cell ${key}: na needs a reason`)
  }
  for (const s of states) for (const e of events) if (!seen.has(`${s} + ${e}`)) problems.push(`missing cell ${s} + ${e}`)
  return problems
}

const kindProblems = (events: string[], cells: Cell[], kinds: Table['kinds'], required: readonly string[]): string[] => {
  const problems: string[] = []
  for (const kind of required) {
    const cover = kinds[kind]
    if (Array.isArray(cover) && cover.length > 0) {
      for (const e of cover) {
        if (!events.includes(e)) problems.push(`kind ${kind}: unknown event ${e}`)
        else if (!cells.some(c => c.event === e && !('na' in c))) problems.push(`kind ${kind}: event ${e} has no cell that runs`)
      }
    } else if (cover && !Array.isArray(cover) && 'na' in cover) {
      if (!hasReason(cover.na)) problems.push(`kind ${kind}: na needs a reason`)
    } else {
      problems.push(`kind ${kind} has no event that covers it and no na reason`)
    }
  }
  return problems
}

/** One line per problem; [] means the table is complete. */
export const tableProblems = ({ states, events, cells, kinds, required = KINDS }: Table): string[] => [
  ...cellProblems(states, events, cells),
  ...kindProblems(events, cells, kinds, required),
]
