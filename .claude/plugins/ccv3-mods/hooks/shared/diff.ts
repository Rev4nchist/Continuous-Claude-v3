import type { Span } from '../agentic-os/pane-model'

// Pure patch helpers for Edit and Write results. Touched Files counts added and removed lines with them.
// They lived in hooks/skin/model.ts until the desktop-only Skin was archived (archive/ccv3-mods-desktop-2026-10).

type Hunk = { oldStart: number; newStart: number; lines: readonly string[] }

/** The patch hunks of an Edit or Write result, or null when the output carries none. */
export const hunksOf = (output: unknown): Hunk[] | null => {
  if (typeof output !== 'object' || output === null) return null
  const patch = (output as { structuredPatch?: unknown }).structuredPatch
  if (!Array.isArray(patch) || patch.length === 0) return null
  const ok = patch.every(
    h => typeof h === 'object' && h !== null && typeof h.oldStart === 'number' && typeof h.newStart === 'number' && Array.isArray(h.lines),
  )
  return ok ? (patch as Hunk[]) : null
}

export type DiffLine = { key: string; number: string; spans: Span[] }

/** Numbered diff lines, cut at `max` with a "… n more" line; counts of added and removed lines. */
export const diffLines = (hunks: readonly Hunk[], max = 40): { lines: DiffLine[]; added: number; removed: number } => {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let total = 0
  hunks.forEach((hunk, h) => {
    let oldN = hunk.oldStart
    let newN = hunk.newStart
    hunk.lines.forEach((raw, i) => {
      const mark = raw[0]
      // "\ No newline at end of file" belongs to no side: skip it so the numbers stay right.
      if (mark === '\\') return
      const text = raw.slice(1)
      const line: DiffLine =
        mark === '+'
          ? { key: `${h}-${i}`, number: String(newN++), spans: [{ text: `+ ${text}`, tone: 'diffAdd' }] }
          : mark === '-'
            ? { key: `${h}-${i}`, number: String(oldN++), spans: [{ text: `− ${text}`, tone: 'diffDel' }] }
            : { key: `${h}-${i}`, number: String((oldN++, newN++)), spans: [{ text: `  ${text}`, tone: 'dim' }] }
      if (mark === '+') added++
      if (mark === '-') removed++
      total++
      if (lines.length < max) lines.push(line)
    })
  })
  if (total > max) lines.push({ key: 'more', number: '', spans: [{ text: `… ${total - max} more lines`, tone: 'dim' }] })
  return { lines, added, removed }
}
