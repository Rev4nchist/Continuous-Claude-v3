// Diagnostics, pure: what a module writes when a hook fails, so a failure on a surface we can't watch
// (the desktop app) leaves a file instead of a blank band. The writes sit in each hooked file ($ can't cross
// an import); these build the text. Files live in ~/.claude/state/ccv3-mods/.

export const DIAG_DIR = '.claude/state/ccv3-mods'

/** One error file's text: when, where, which surface, the message and the top of the stack. */
export const errorText = (where: string, err: unknown, surface: string | null = null): string => {
  const e = err instanceof Error ? err : new Error(String(err))
  return JSON.stringify({ at: new Date().toISOString(), where, surface, message: e.message, stack: e.stack?.split('\n').slice(0, 6) }, null, 2)
}

export type UsageKeysProbe = {
  /** Names the key set (where + keys + iteration types): one file per signature and session. */
  signature: string
  text: string
}

const sortedKeys = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value).sort() : []

/** A short label only: an iteration `type` such as `message` or `advisor_message`. Anything else is dropped. */
const typeLabel = (value: unknown): string | null => (typeof value === 'string' && /^\w{1,32}$/.test(value) ? value : null)

/**
 * The live turn.step usage probe, pure: which fields the engine's usage carries. Keys, a count and the
 * iteration type labels only; never a token value, a model id or content. A malformed field gives an empty list.
 * Null when there is no usage object. `where` is `main` or `subagent`, so both feeds get their own record.
 */
export const usageKeysProbe = (usage: unknown, where: 'main' | 'subagent'): UsageKeysProbe | null => {
  if (typeof usage !== 'object' || usage === null) return null
  const record = usage as Record<string, unknown>
  const entries = Array.isArray(record.iterations) ? (record.iterations as unknown[]) : null
  const iterations =
    entries === null
      ? null
      : {
          count: entries.length,
          keys: [...new Set(entries.flatMap(sortedKeys))].sort(),
          types: [...new Set(entries.map(entry => typeLabel((entry as { type?: unknown } | null)?.type)).filter((t): t is string => t !== null))].sort(),
        }
  const facts = { where, keys: sortedKeys(record), cacheCreationKeys: sortedKeys(record.cache_creation), ...(iterations === null ? {} : { iterations }) }
  const signature = JSON.stringify(facts)
  return { signature, text: JSON.stringify({ at: new Date().toISOString(), ...facts }, null, 2) }
}

/** A short stable name for a signature (djb2): the file name, so the same key set in one session lands on one file. */
export const usageKeysFile = (sessionId: string, signature: string): string => {
  let h = 5381
  for (let i = 0; i < signature.length; i++) h = ((h * 33) ^ signature.charCodeAt(i)) >>> 0
  return `usage-keys/${sessionId.replace(/[^\w-]/g, '_')}.${h.toString(16).padStart(8, '0')}.json`
}

/** A file name that sorts by time and says which module failed. */
export const errorFile = (where: string, now = Date.now()): string => `errors/${now}-${where.replace(/[^\w-]/g, '_')}.json`
