import { redact } from '../shared/redact'

// Repo, branch and worktree of a session, read from the files git keeps (PRD 5.3, band line 1). Pure: the caller
// hands in a reader, so no disk and no process is touched here and a test needs neither. It never throws.
//
// Layout it reads (no process spawn):
//   primary checkout   <top>/.git/HEAD
//   linked worktree    <top>/.git is a FILE: `gitdir: <main>/.git/worktrees/<name>`; there HEAD and commondir
//   submodule          <top>/.git is a FILE: `gitdir: <super>/.git/modules/<name>`; there HEAD, no commondir

/** A reader answers the text of a file, or null when it is missing, a folder or unreadable. */
export type Reader = (path: string) => Promise<string | null>

/** Each field is null when it is not known. `worktree` is null for the primary checkout. */
export type GitInfo = { repo: string | null; branch: string | null; worktree: string | null }

const NONE: GitInfo = { repo: null, branch: null, worktree: null }

/** A HEAD, .git or commondir file is a line or two. Anything longer, or with a NUL, is not one. */
const MAX_CHARS = 4096
/** The walk up from the cwd stops here. */
const MAX_LEVELS = 32
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/** Slashes only; `.` and `..` resolved; a drive (`C:`) or a leading `/` kept. */
const normalize = (path: string): string => {
  const swapped = path.replace(/\\/g, '/')
  const out: string[] = []
  for (const part of swapped.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1] ?? '')) out.pop()
      continue
    }
    out.push(part)
  }
  return (swapped.startsWith('/') ? '/' : '') + out.join('/')
}

const isAbsolute = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)

const resolve = (base: string, path: string): string => normalize(isAbsolute(path) ? path : `${base}/${path}`)

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? ''

/** The folder above, or null at a root (`/`, `C:`, or a bare name). */
const parent = (path: string): string | null => {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return null
  const up = cut === 0 ? '/' : path.slice(0, cut)
  return up === path ? null : up
}

const clean = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : redact(trimmed).text
}

/** The first line of a small text file; null when it is too big, binary or not text. */
const firstLine = (text: string | null): string | null => {
  if (typeof text !== 'string' || text.length > MAX_CHARS || text.includes('\0')) return null
  return (text.split(/\r?\n/)[0] ?? '').trim()
}

/** `ref: refs/heads/feat/x` is `feat/x`; a bare sha is its first 7 characters; anything else is no branch. */
const branchOf = (head: string | null): string | null => {
  const line = firstLine(head)
  if (line === null) return null
  const ref = /^ref:\s*(.+)$/.exec(line)
  if (ref) return clean((ref[1] ?? '').trim().replace(/^refs\/heads\//, '').replace(/^refs\//, ''))
  return SHA.test(line) ? line.slice(0, 7) : null
}

/** The `gitdir:` target of a .git file, or null when the file is not one. */
const gitdirOf = (text: string | null): string | null => {
  const line = firstLine(text)
  const hit = line === null ? null : /^gitdir:\s*(.+)$/.exec(line)
  return hit ? (hit[1] ?? '').trim() : null
}

/** The main checkout's folder name: from commondir when there is one, else from the `.git/worktrees/<name>` path. */
const mainRepo = (gitdir: string, commondir: string | null): string | null => {
  const rel = firstLine(commondir)
  if (rel) {
    const common = resolve(gitdir, rel)
    return basename(common) === '.git' ? basename(parent(common) ?? '') || null : basename(common).replace(/\.git$/, '') || null
  }
  const hit = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir)
  return hit ? basename(hit[1] ?? '') || null : null
}

const linked = async (top: string, gitdir: string, read: Reader): Promise<GitInfo> => {
  const dir = resolve(top, gitdir)
  const [head, commondir] = [await read(`${dir}/HEAD`), await read(`${dir}/commondir`)]
  const isWorktree = basename(parent(dir) ?? '') === 'worktrees'
  return {
    repo: clean(isWorktree ? mainRepo(dir, commondir) ?? basename(top) : basename(top)),
    branch: branchOf(head),
    worktree: isWorktree ? clean(basename(dir)) : null,
  }
}

/**
 * Repo, branch and worktree for the session folder `cwd`. Walks up to the first folder with a `.git`. Total: any failure
 * of the reader, a missing `.git` or a file that is not git's leaves the fields null. Every name passes `redact`.
 */
export const gitInfo = async (cwd: string, read: Reader): Promise<GitInfo> => {
  try {
    if (typeof cwd !== 'string' || cwd.trim() === '') return NONE
    let top: string | null = normalize(cwd)
    for (let level = 0; top !== null && top !== '' && level < MAX_LEVELS; level++, top = parent(top)) {
      const file = await read(`${top}/.git`)
      // A folder may read as an empty string on some readers: only a `gitdir:` line makes this a linked worktree.
      const gitdir = gitdirOf(file)
      if (gitdir !== null) return await linked(top, gitdir, read)
      const head = await read(`${top}/.git/HEAD`)
      if (typeof head === 'string') return { repo: clean(basename(top)), branch: branchOf(head), worktree: null }
    }
    return NONE
  } catch {
    return NONE
  }
}
