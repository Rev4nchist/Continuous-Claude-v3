// The goal sentence of a lane note, for the Goal row of the status band. NO imports: plain functions and erasable TypeScript only,
// so Node can load this file with type stripping (scripts/mods/goal-extractor-drift.test.mjs does).
//
// A COPY of goalOf in scripts/coordination/lane-dash-metrics.mjs (constants at lines 60-69, MARKER_RUN at 76-77, cutWords at 79-92, goalOf at 99-117).
// Why a copy: `claude plugin test` cannot import outside the plugin folder (README.md). The drift test feeds both copies the same
// notes and fails when the results differ. Change a rule in both files or in neither.
//
// The plugin sees the first line of the note after the `oneLine` redact and the 400-unit cut (lanes-model.ts); the repo copy sees the raw note.

/** Longest GOAL sentence, ellipsis included. */
const GOAL_MAX = 200

const PARK_PREFIX = 'PARKED until '
const GOAL_TAG = 'GOAL:'
const GOAL_STOPS = [' || ', ' | ', 'WAITS ON', 'NEXT', 'MS:']
// A session uuid, with or without a leading '#'. Masked first, so no part of it is left for the rules after it.
const UUID_RUN = /#?(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi
// A SHA: 7 to 40 hex characters with at least one digit and one letter, so "faded" and "2026111" stay.
const SHA_RUN = /(?<![0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9a-z])/gi

// A redaction marker, as the redactor writes it (hooks/shared/redact.ts: [REDACTED:<kind>], no space inside).
const MARKER_RUN = /\[REDACTED:[^\]]*\]/g

/** Cuts text at a word boundary and ends it with "…". Text that fits is returned as it is. A marker that the cut would split is dropped whole. */
function cutWords(s: string, max: number): string {
  if (s.length <= max) return s
  const room = s.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  let keep = s[max - 1] === ' ' ? room : (space > 0 ? room.slice(0, space) : room)
  for (const found of s.matchAll(MARKER_RUN)) {
    const start = found.index ?? 0
    if (start < keep.length && start + found[0].length > keep.length) {
      keep = keep.slice(0, start)
      break
    }
  }
  return `${keep.trimEnd()}…`
}

/**
 * The plain-English GOAL sentence that starts a lane note, or null. A park note is cut through its first " || ".
 * The sentence ends at the first " | ", " || ", "WAITS ON", "NEXT" or "MS:". Handles and SHAs are masked.
 * Never returns any other part of the note.
 */
export function goalOfNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string') return null
  let s = note.trim()
  if (s.startsWith(PARK_PREFIX)) {
    const at = s.indexOf(' || ')
    if (at < 0) return null
    s = s.slice(at + 4).trim()
  }
  if (!s.startsWith(GOAL_TAG)) return null
  s = s.slice(GOAL_TAG.length)
  const end = Math.min(...GOAL_STOPS.map((t) => s.indexOf(t)).filter((i) => i >= 0), s.length)
  const text = s.slice(0, end)
    .replace(UUID_RUN, '[id]')
    .replace(/#[0-9a-f]{8}(?![0-9a-f])/gi, '#[handle]')
    .replace(SHA_RUN, '[sha]')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? cutWords(text, GOAL_MAX) : null
}
