import { expect, test } from '@playwright/test';

import { noteFlags } from '../src/lib/note-flags';

/**
 * Pure checks of the lane-note reader (card agentic-os-readers, reader 1). The note text is read on the server
 * only. noteFlags returns booleans and kind names, never text. Each rule is a COPY of one line of
 * .claudedocs/re-execution/stall-watch.mjs (cited per test). Pure Node: no server, no database, no browser.
 * Each test names the source change that breaks it.
 */

test.describe('noteFlags: waits on the seat (stall-watch.mjs:89)', () => {
  test('N1 "the seat", "seat\'s" and "seat" before a seat act count inside the WAITS ON clause', () => {
    // Breaks when the regex alternatives for the actor forms are dropped or reordered out of the clause.
    expect(noteFlags('WAITS ON: seat GO on 0b70aa1e. NEXT: push.').waitsOnSeat).toBe(true);
    expect(noteFlags('WAITS ON: the seat. NEXT: push.').waitsOnSeat).toBe(true);
    expect(noteFlags("WAITS ON: the seat's ruling").waitsOnSeat).toBe(true);
    expect(noteFlags('waits on: seat word on the note').waitsOnSeat).toBe(true); // the regex is case-insensitive
  });

  test('N2 "to the seat", "from the seat", "seat-page", "seat page" and "seat answer slots" do not count', () => {
    // Breaks when a lookbehind or lookahead of the stall-watch regex is dropped: these are work items, not waits.
    expect(noteFlags('WAITS ON: a reply to the seat').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: a word from the seat').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: the seat-page design').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: the seat page design').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: seat answer slots').waitsOnSeat).toBe(false);
  });

  test('N3 a seat mention after NEXT:, MS:, "then" or "|" is outside the WAITS ON clause', () => {
    // Breaks when the clause scan no longer stops at NEXT:, MS:, \bthen\b or a pipe.
    expect(noteFlags('WAITS ON: nothing. NEXT: seat word on the plan').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: a build, then the seat').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: a build | the seat').waitsOnSeat).toBe(false);
    expect(noteFlags('WAITS ON: nothing MS: seat GO').waitsOnSeat).toBe(false);
  });

  test('N4 a note with no WAITS ON clause never counts', () => {
    expect(noteFlags('The seat gave the word.').waitsOnSeat).toBe(false);
  });
});

test.describe('noteFlags: START with no END (stall-watch.mjs:94-96)', () => {
  test('N5 a START before NEXT: with no END anywhere gives the kind', () => {
    // Breaks when the text is not cut at NEXT: first (:94) or when the END test looks at the cut text only.
    expect(noteFlags('PRE-PR START 06:47 head 0b70aa1e. WAITS ON: pre-pr.').startNoEnd).toEqual(['PRE-PR']);
    expect(noteFlags('HOOK BUILD START 07:00. WAITS ON: build.').startNoEnd).toEqual(['HOOK BUILD']);
    expect(noteFlags('PRE-PR START 06:47. HOOK BUILD START 06:50.').startNoEnd).toEqual(['PRE-PR', 'HOOK BUILD']);
  });

  test('N6 an END anywhere in the note, even after NEXT:, clears the kind', () => {
    expect(noteFlags('PRE-PR START 06:47. PRE-PR END 06:55 exit 0.').startNoEnd).toEqual([]);
    expect(noteFlags('PRE-PR START 06:47. NEXT: send the PRE-PR END word.').startNoEnd).toEqual([]);
  });

  test('N7 a START only after NEXT: is a plan, not a run', () => {
    // The false alarm of 2026-11-16 20:42 that stall-watch.mjs:93 names.
    expect(noteFlags('WAITS ON: seat. NEXT: PRE-PR START 2 after the GO.').startNoEnd).toEqual([]);
  });
});

test.describe('noteFlags: parked and bad input', () => {
  test('N8 only a note that starts with PARKED is parked (stall-watch.mjs:81)', () => {
    expect(noteFlags('PARKED until 18:00 -- waits on CI').parked).toBe(true);
    expect(noteFlags('GOAL: x. PARKED until 18:00').parked).toBe(false);
  });

  test('N9 null, undefined and a non-string note give all-false flags', () => {
    for (const bad of [null, undefined, 42, {}, ['WAITS ON: seat']]) {
      expect(noteFlags(bad as never)).toEqual({ parked: false, waitsOnSeat: false, startNoEnd: [] });
    }
  });

  test('N10 the flags hold no note text (a canary in the note never comes back)', () => {
    // Breaks when a field of the result carries a slice of the note.
    const out = JSON.stringify(noteFlags('WAITS ON: seat GO CANARY_NOTE_7f3a PRE-PR START'));
    expect(out).not.toContain('CANARY_NOTE_7f3a');
    expect(Object.keys(noteFlags('x')).sort()).toEqual(['parked', 'startNoEnd', 'waitsOnSeat']);
  });
});
