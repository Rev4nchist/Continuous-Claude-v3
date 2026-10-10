// Diagnostics, pure: what a module writes when a hook fails, so a failure on a surface we can't watch
// (the desktop app) leaves a file instead of a blank band. The writes sit in each hooked file ($ can't cross
// an import); these build the text. Files live in ~/.claude/state/ccv3-mods/.

export const DIAG_DIR = '.claude/state/ccv3-mods'

/** One error file's text: when, where, which surface, the message and the top of the stack. */
export const errorText = (where: string, err: unknown, surface: string | null = null): string => {
  const e = err instanceof Error ? err : new Error(String(err))
  return JSON.stringify({ at: new Date().toISOString(), where, surface, message: e.message, stack: e.stack?.split('\n').slice(0, 6) }, null, 2)
}

/** A file name that sorts by time and says which module failed. */
export const errorFile = (where: string, now = Date.now()): string => `errors/${now}-${where.replace(/[^\w-]/g, '_')}.json`

/** True when the session draws in the desktop app. `CCV3_FORCE_SURFACE=desktop` forces it, to try the desktop path in a terminal. */
export const isDesktop = (surface: string | null | undefined, forced: string | undefined): boolean =>
  (forced === 'desktop' ? 'desktop' : surface) === 'desktop'
