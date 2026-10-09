// Touched Files, pure: fold tool calls into a file list, and lay the list out as a tree.

import type { FileTouch } from '../../types'
import { fit } from '../agentic-os/pane-model'
import type { PaneRow, Span, Tone } from '../agentic-os/pane-model'

/** `path` relative to `root` with forward slashes; a path outside the root stays absolute. */
export const relative = (path: string, root: string): string => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const r = norm(root)
  const same = (a: string, b: string) => (/^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (r !== '' && p.length > r.length && same(p.slice(0, r.length), r) && p[r.length] === '/') return p.slice(r.length + 1)
  return p
}

const lines = (text: string): number => (text === '' ? 0 : text.split('\n').length)

/** Lines added and removed by one Edit-shaped change. */
export const editCounts = (oldText: string, newText: string): { added: number; removed: number } => ({
  added: lines(newText),
  removed: lines(oldText),
})

/** A read never lowers an edit; an edit lifts a read; a commit keeps its counts. */
export const touch = (
  files: readonly FileTouch[],
  path: string,
  kind: 'read' | 'edited',
  counts: { added: number; removed: number } = { added: 0, removed: 0 },
): FileTouch[] => {
  const known = files.find(file => file.path === path)
  if (known === undefined) return [...files, { path, state: kind, ...counts }]
  return files.map(file =>
    file.path !== path
      ? file
      : {
          ...file,
          state: kind === 'edited' ? 'edited' : file.state,
          added: file.added + counts.added,
          removed: file.removed + counts.removed,
        },
  )
}

/** The commit's file list (git show --name-only): edited files it names turn committed. */
export const commit = (files: readonly FileTouch[], committed: readonly string[]): FileTouch[] => {
  const names = new Set(committed.map(name => name.trim()).filter(Boolean))
  return files.map(file => (file.state === 'edited' && names.has(file.path) ? { ...file, state: 'committed' } : file))
}

/** A Bash/PowerShell command that makes a git commit (not `git commit --dry-run`, not a commit message in an echo). */
export const isGitCommit = (command: string): boolean =>
  /(^|[;&|]\s*|\s)git(\s+-C\s+\S+)?\s+commit\b/.test(command) && !/--dry-run/.test(command)

export type TreeRow = { key: string; depth: number; name: string; isDir: boolean; file?: FileTouch }

/** Directories, then files, each sorted; one row per directory on the way to a touched file. */
export const treeRows = (files: readonly FileTouch[]): TreeRow[] => {
  const rows: TreeRow[] = []
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  for (const file of sorted) {
    const parts = file.path.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/')
      if (seen.has(dir)) continue
      seen.add(dir)
      rows.push({ key: `d:${dir}`, depth: i, name: parts[i] ?? '', isDir: true })
    }
    rows.push({ key: `f:${file.path}`, depth: parts.length - 1, name: parts.at(-1) ?? file.path, isDir: false, file })
  }
  return rows
}

export const STATE_TONE: Record<FileTouch['state'], Tone> = { read: 'dim', edited: 'active', committed: 'ok' }

/** The /files pane as text rows (the desktop adds Svg icons beside the same rows). */
export const fileRows = (files: readonly FileTouch[], columns: number, rows: number, offset = 0): PaneRow[] => {
  const count = (state: FileTouch['state']) => files.filter(file => file.state === state).length
  const head: PaneRow[] = [
    { key: 'title', left: [{ text: 'Touched files', tone: 'title' }] },
    {
      key: 'legend',
      left: [
        { text: `read ${count('read')}`, tone: 'dim' },
        { text: '  ·  ', tone: 'track' },
        { text: `edited ${count('edited')}`, tone: 'active' },
        { text: '  ·  ', tone: 'track' },
        { text: `committed ${count('committed')}`, tone: 'ok' },
      ],
    },
  ]
  if (files.length === 0) head.push({ key: 'empty', left: [{ text: 'No files touched yet this session.', tone: 'dim' }] })
  const body: PaneRow[] = treeRows(files).map(row => {
    const indent: Span = { text: '  '.repeat(row.depth), tone: 'track' }
    if (row.isDir || row.file === undefined) return { key: row.key, left: [indent, { text: `▸ ${row.name}/`, tone: 'head' }] }
    const f = row.file
    const right: Span[] = f.added || f.removed ? [{ text: `+${f.added}`, tone: 'ok' }, { text: ` −${f.removed}`, tone: 'bad' }] : []
    return { key: row.key, left: [indent, { text: `  ${row.name}`, tone: STATE_TONE[f.state] }], ...(right.length ? { right } : {}) }
  })
  const room = Math.max(0, rows - head.length)
  const start = Math.min(Math.max(0, offset), Math.max(0, body.length - room))
  return [...head, ...body.slice(start, start + room)].map(row => fit(row, Math.max(10, columns)))
}
