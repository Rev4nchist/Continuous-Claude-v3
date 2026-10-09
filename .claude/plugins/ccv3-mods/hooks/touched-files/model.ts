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

/**
 * The commit's file list: edited files it names turn committed, unless they are still dirty
 * (an amend without staging, a partly staged file).
 */
export const commit = (files: readonly FileTouch[], committed: readonly string[], dirty: readonly string[] = []): FileTouch[] => {
  const names = new Set(committed.map(name => name.trim()).filter(Boolean))
  const still = new Set(dirty.map(name => name.trim()).filter(Boolean))
  return files.map(file => (file.state === 'edited' && names.has(file.path) && !still.has(file.path) ? { ...file, state: 'committed' } : file))
}

/**
 * A shell command with a `git commit` segment: global options (`-C dir`, `-c k=v`, `--no-pager`) and a
 * subshell paren allowed before it; `--dry-run` counts only inside that segment. The caller still
 * checks that HEAD moved, so a false positive here costs a git call, never a wrong flip.
 */
export const isGitCommit = (command: string): boolean =>
  command.split(/&&|\|\||;|\|/).some(segment => {
    const m = /(^|\s|\()git((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+commit\b(.*)$/.exec(segment)
    return m !== null && !/--dry-run/.test(m[3] ?? '')
  })

/** Files the session may keep in the list; read-only entries go first when it fills. */
export const MAX_FILES = 500

export const capFiles = (files: readonly FileTouch[]): FileTouch[] => {
  if (files.length <= MAX_FILES) return [...files]
  const over = files.length - MAX_FILES
  const drop = new Set(files.filter(file => file.state === 'read').slice(0, over).map(file => file.path))
  const kept = files.filter(file => !drop.has(file.path))
  return kept.slice(Math.max(0, kept.length - MAX_FILES))
}

export type TreeRow = { key: string; depth: number; name: string; isDir: boolean; file?: FileTouch }

/** Paths ordered segment by segment, ordinal (no locale folding), so a folder's files stay together. */
const byPath = (a: FileTouch, b: FileTouch): number => {
  const x = a.path.split('/')
  const y = b.path.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xi = x[i] ?? ''
    const yi = y[i] ?? ''
    if (xi === yi) continue
    // At this depth a folder (more segments follow) sorts before a file.
    const xDir = i < x.length - 1
    const yDir = i < y.length - 1
    if (xDir !== yDir) return xDir ? -1 : 1
    return xi < yi ? -1 : 1
  }
  return x.length - y.length
}

/** One row per directory on the way to a touched file, then the file; folders before files at each level. */
export const treeRows = (files: readonly FileTouch[]): TreeRow[] => {
  const rows: TreeRow[] = []
  const sorted = [...files].sort(byPath)
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
