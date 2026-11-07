import { gitInfo } from '../agentic-os/gitinfo'
import { redact } from '../shared/redact'
import type { KeeperFacts } from './model'

// The facts a manual compaction can know cheaply: the git branch of the session folder, the session name, and this
// session's newest handoff file. Every part is optional: a part that cannot be read is null, and nothing here throws.

/** One directory entry, as `$.fs.list` gives it (the fields used here). */
export type ListEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }
export type Lister = (path: string) => Promise<ListEntry[]>

/** Handoff folders live under `thoughts/shared/handoffs/<folder>/`. */
const HANDOFF_PATH = 'thoughts/shared/handoffs'
/** The walk up from the session folder, and the folders read in one handoffs folder, stop here. */
const MAX_LEVELS = 8
const MAX_FOLDERS = 60

const slashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** The folder and its parents, nearest first, at most `MAX_LEVELS`. A drive (`C:`) is the last one. */
const withParents = (folder: string): string[] => {
  const out: string[] = []
  for (let here = slashes(folder); here !== '' && out.length < MAX_LEVELS; ) {
    out.push(here)
    const cut = here.lastIndexOf('/')
    if (cut <= 0) break
    here = here.slice(0, cut)
  }
  return out
}

/** A handoff of this session is a yaml file with `_<sid8>_` in its name (the A2 naming: `*_<sid8>_*.yaml`). */
const isHandoffOf = (name: string, sid8: string): boolean => name.toLowerCase().includes(`_${sid8.toLowerCase()}_`) && /\.ya?ml$/i.test(name)

/**
 * The newest handoff file of the session `sid8`, as a path, or null. It looks in `thoughts/shared/handoffs` of each of
 * `folders` (the session folder, its parents and the root), in the folder itself and one level down. A folder
 * that cannot be listed is skipped. A file of another session, or with no session id in its name, never matches.
 */
export const newestHandoff = async (sid8: string, folders: readonly string[], list: Lister): Promise<string | null> => {
  if (!/^[0-9a-f]{8}$/i.test(sid8)) return null
  let best: { path: string; at: number } | null = null
  const consider = (dir: string, entries: readonly ListEntry[]) => {
    for (const entry of entries) {
      if (entry.kind !== 'file' || !isHandoffOf(entry.name, sid8)) continue
      if (best === null || entry.mtimeMs >= best.at) best = { path: `${dir}/${entry.name}`, at: entry.mtimeMs }
    }
  }
  for (const folder of folders) {
    const root = `${slashes(folder)}/${HANDOFF_PATH}`
    const top = await list(root).catch(() => null)
    if (top === null) continue
    consider(root, top)
    for (const sub of top.filter(entry => entry.kind === 'dir').slice(0, MAX_FOLDERS)) {
      const inside = await list(`${root}/${sub.name}`).catch(() => null)
      if (inside !== null) consider(`${root}/${sub.name}`, inside)
    }
    // The nearest folder that holds a handoff of this session wins.
    if (best !== null) break
  }
  return (best as { path: string } | null)?.path ?? null
}

/** What the facts need from the engine. The caller spells each as `$.noun.event(...)`: the engine follows `$` only inside the hook's own file. */
export type FactSources = {
  cwd: () => Promise<string>
  root: () => Promise<string>
  read: (path: string) => Promise<string>
  list: Lister
}

const orNull = async <T>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work()
  } catch {
    return null
  }
}

/**
 * The facts for session `sessionId`. `name` is the session name from the sessionName atom (null: unnamed). Never throws.
 * Reads: the .git files above the session folder, and the handoff folders (see `newestHandoff`).
 */
export const keeperFacts = async (src: FactSources, sessionId: string, name: string | null): Promise<KeeperFacts> => {
  const where = await orNull(() => src.cwd().catch(() => src.root()))
  const folder = typeof where === 'string' && where !== '' ? where : null
  const branch =
    folder === null ? null : (await orNull(() => gitInfo(folder, path => src.read(path).then(text => (typeof text === 'string' ? text : null), () => null))))?.branch ?? null
  const root = await orNull(() => src.root())
  const handoff =
    folder === null ? null : await orNull(() => newestHandoff(sessionId.slice(0, 8), [...withParents(folder), ...(typeof root === 'string' && root !== '' ? [root] : [])], src.list))
  return { branch, name: name === null || name.trim() === '' ? null : redact(name.trim()).text, handoff }
}
