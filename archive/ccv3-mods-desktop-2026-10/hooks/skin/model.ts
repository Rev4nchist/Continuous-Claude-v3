// CCv3 Skin, pure: what each tool row says, the collapsed-group summary, and diff-card lines.

import type { Span } from '../agentic-os/pane-model'
import type { IconName } from '../shared/glyphs'

/** Tools the skin draws; any other tool falls through to the engine's own row. */
export const SKIN_TOOLS: Record<string, IconName> = {
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'read',
  Bash: 'shell',
  PowerShell: 'shell',
  Agent: 'agent',
  Task: 'agent',
  advisor: 'advisor',
}

/** The last three segments of a path: enough to place it, short enough for a row. */
export const shortPath = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/')
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The row's main argument for a tool's input. */
export const mainArg = (tool: string, input: Record<string, unknown>): string => {
  if (input.file_path !== undefined || input.notebook_path !== undefined) return shortPath(str(input.file_path) || str(input.notebook_path))
  if (tool === 'Bash' || tool === 'PowerShell') return (str(input.command).split('\n')[0] ?? '').trim()
  if (tool === 'Grep' || tool === 'Glob') return `${str(input.pattern)}${input.path ? ` in ${shortPath(str(input.path))}` : ''}`
  if (tool === 'Agent' || tool === 'Task') return [str(input.subagent_type), str(input.description)].filter(Boolean).join(' · ')
  if (tool === 'WebFetch') return str(input.url)
  if (tool === 'WebSearch') return str(input.query)
  return ''
}

/** "0.2s", "14.8s", "1:58". */
export const fmtMs = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The collapsed group's line: "Explored 6 files · 4 Read · 2 Grep". */
export const groupSummary = (calls: readonly { tool: string; isRunning: boolean }[]): string => {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  const verb = calls.some(call => call.isRunning) ? 'Exploring' : 'Explored'
  const parts = [...counts].map(([tool, n]) => `${n} ${tool}`)
  return `${verb} ${calls.length} ${calls.length === 1 ? 'call' : 'calls'} · ${parts.join(' · ')}`
}

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
