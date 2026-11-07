/**
 * Read `source` from a SessionStart stdin payload.
 *
 * Claude Code sets source to startup, resume, clear or compact. After /compact the
 * session is the same one, so startup-only work (status lines, daemon launches, marker
 * resets) must not run again. A missing, empty or invalid payload counts as startup:
 * when in doubt, do the full work.
 *
 * Like the other shared/ files, this is bundled into each hook, never built alone.
 */

export const COMPACT_SOURCE = 'compact';

/** The payload's `source` string, or 'startup' when it cannot be read. Never throws. */
export function parseSessionSource(stdin: string): string {
  try {
    const doc: unknown = JSON.parse(stdin);
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
      const source = (doc as Record<string, unknown>).source;
      if (typeof source === 'string' && source !== '') return source;
    }
  } catch {
    /* empty or invalid JSON */
  }
  return 'startup';
}

/** True only for the literal 'compact'. Resume and clear are new session processes. */
export function isCompactSource(source: string | undefined): boolean {
  return source === COMPACT_SOURCE;
}
