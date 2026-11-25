/**
 * The lane-note reader of the stall rules (card agentic-os-readers, reader 1). PURE: no 'server-only', no '@/' import.
 *
 * The note text is read on the server only. This function returns booleans and kind names, never text, so a lane note
 * can never reach a screen. Each rule is a COPY of a line of .claudedocs/re-execution/stall-watch.mjs (never run it;
 * its header, line 4, says a page must not): change a rule there and here in one commit.
 */

export type StartKind = 'PRE-PR' | 'HOOK BUILD';
export type NoteFlags = { parked: boolean; waitsOnSeat: boolean; startNoEnd: StartKind[] };

const NONE: NoteFlags = { parked: false, waitsOnSeat: false, startNoEnd: [] };
/** stall-watch.mjs:96 (the two kinds, in this order). */
const START_KINDS: readonly StartKind[] = ['PRE-PR', 'HOOK BUILD'];

/**
 * COPY of the regex at stall-watch.mjs:89. Only the WAITS ON clause counts: it ends at "|", "NEXT:", "MS:" or "then".
 * "seat" counts only as the actor: "the seat", "seat's", or "seat" before a seat act. "to the seat", "from the seat",
 * "seat-page" and "seat answer slots" are work items. The caller applies the state test (active only, :88).
 */
const WAITS_ON_SEAT =
  /WAITS ON:(?:(?!NEXT:|MS:|\bthen\b)[^|])*(?:(?<!\bto )(?<!\bfrom )\bthe seat\b(?![- ]page)|\bseat's\b|\bseat\s+(?:GO|word|ruling|read|reply|land|line|switch|answer\b(?! slots)))/i;

/** stall-watch.mjs:94: only a START that stands before the NEXT clause counts, "NEXT: ... PRE-PR START" is a plan. */
const BEFORE_NEXT = /\bNEXT:/;

export function noteFlags(note: unknown): NoteFlags {
  if (typeof note !== 'string') return { ...NONE, startNoEnd: [] };
  const done = note.split(BEFORE_NEXT)[0];
  return {
    // stall-watch.mjs:81
    parked: note.startsWith('PARKED'),
    // stall-watch.mjs:89
    waitsOnSeat: WAITS_ON_SEAT.test(note),
    // stall-watch.mjs:94-96
    startNoEnd: START_KINDS.filter((kind) => done.includes(`${kind} START`) && !note.includes(`${kind} END`)),
  };
}
