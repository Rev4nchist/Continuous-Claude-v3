/**
 * Unit tests for the shared bus-focus helpers (WS-2 Phase B.3). These are the
 * pure functions both bus READERS (agent-recall-injector B.3a, memory-awareness
 * B.3b) rely on; pinning them here means a regression shows up once, not twice.
 *
 * Runner is vitest; ASCII-only source (control chars built via String.fromCharCode).
 */

import { describe, it, expect } from 'vitest';

import {
  isFresh,
  basenameNoExt,
  extractBusFocus,
  buildFocusBlock,
  BUS_STALENESS_MAX_AGE,
  MAX_FOCUS_TERMS,
} from '../shared/bus-focus.js';
import { emptyBus, type BusEntry, type FocusSymbol, type FileInPlay } from '../shared/context-bus.js';

function focusSym(name: string, turnAdded: number | undefined): FocusSymbol {
  return { id: { file_uri: `src/${name}.ts`, lang: 'ts', name }, turn_added: turnAdded } as FocusSymbol;
}
function lbFile(p: string, turnAdded: number): FileInPlay {
  return { path: p, role: 'edited', turn_added: turnAdded };
}
function busWith(over: Partial<{ current_turn: number; focus: FocusSymbol[]; lb: FileInPlay[] }>): BusEntry {
  const b = emptyBus('bus-focus-test');
  b.current_turn = over.current_turn ?? 0;
  b.focus_symbols = over.focus ?? [];
  b.files_in_play.load_bearing = over.lb ?? [];
  return b;
}

describe('isFresh', () => {
  it('keeps an item at the staleness boundary (age == MAX) fresh', () => {
    expect(isFresh(BUS_STALENESS_MAX_AGE, 0)).toBe(true); // age = MAX
  });
  it('suppresses an item past the staleness boundary', () => {
    expect(isFresh(BUS_STALENESS_MAX_AGE + 1, 0)).toBe(false);
  });
  it('tolerates a same-turn-race future turn_added (age -1) as fresh', () => {
    expect(isFresh(5, 6)).toBe(true); // age -1
  });
  it('treats a FAR-future turn_added as stale (poisoned / clock-skew bound)', () => {
    expect(isFresh(5, 100)).toBe(false); // age -95 -> rejected
  });
  it('treats a MISSING turn_added as stale (Retired#2)', () => {
    expect(isFresh(2, undefined)).toBe(false);
  });
  it('treats a non-finite turn_added as stale', () => {
    expect(isFresh(2, NaN)).toBe(false);
  });
});

describe('basenameNoExt', () => {
  it('strips directory and extension', () => {
    expect(basenameNoExt('src/shared/context-bus.ts')).toBe('context-bus');
  });
  it('handles backslash paths', () => {
    expect(basenameNoExt('a\\b\\c.py')).toBe('c');
  });
  it('keeps a dotfile-less basename intact and preserves interior dots', () => {
    expect(basenameNoExt('a.b.c.ts')).toBe('a.b.c');
    expect(basenameNoExt('plainname')).toBe('plainname');
  });
});

describe('extractBusFocus', () => {
  it('returns non-stale focus symbol names + load-bearing basenames', () => {
    const bus = busWith({
      current_turn: 5,
      focus: [focusSym('alpha', 5)],
      lb: [lbFile('src/beta.ts', 4)],
    });
    const { terms, staleSymbolsCount } = extractBusFocus(bus);
    expect(terms).toContain('alpha');
    expect(terms).toContain('beta');
    expect(staleSymbolsCount).toBe(0);
  });

  it('suppresses + counts stale focus symbols, skips stale load-bearing', () => {
    const bus = busWith({
      current_turn: 10,
      focus: [focusSym('fresh', 9), focusSym('old', 2)],
      lb: [lbFile('src/staleLb.ts', 1)],
    });
    const { terms, staleSymbolsCount } = extractBusFocus(bus);
    expect(terms).toContain('fresh');
    expect(terms).not.toContain('old');
    expect(terms).not.toContain('staleLb');
    expect(staleSymbolsCount).toBe(1); // only focus symbols are counted
  });

  it('de-duplicates terms case-insensitively', () => {
    const bus = busWith({ current_turn: 1, focus: [focusSym('Dup', 1), focusSym('dup', 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms.filter((t) => t.toLowerCase() === 'dup')).toHaveLength(1);
  });

  it('caps total terms at MAX_FOCUS_TERMS', () => {
    const focus = Array.from({ length: MAX_FOCUS_TERMS + 5 }, (_, i) => focusSym(`s${i}`, 1));
    const { terms } = extractBusFocus(busWith({ current_turn: 1, focus }));
    expect(terms.length).toBe(MAX_FOCUS_TERMS);
  });

  it('strips control chars (incl. NUL) from a term (Retired#1)', () => {
    const NUL = String.fromCharCode(0);
    const bus = busWith({ current_turn: 1, focus: [focusSym(`a${NUL}b`, 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms).toContain('ab');
    expect(terms.join('')).not.toContain(NUL);
  });

  it('strips tsquery metacharacters from a term (FTS injection defense, premortem T3)', () => {
    const bus = busWith({ current_turn: 1, focus: [focusSym('foo|bar:*', 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms).toContain('foobar');
    expect(terms.join('')).not.toMatch(/[|:*&!()'"]/);
  });

  it('strips Unicode bidi / zero-width / format chars from a term (premortem Retired#3)', () => {
    const RLO = String.fromCharCode(0x202e); // right-to-left override (bidi)
    const ZWSP = String.fromCharCode(0x200b); // zero-width space
    const bus = busWith({ current_turn: 1, focus: [focusSym(`a${RLO}b${ZWSP}c`, 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms).toContain('abc');
    expect(terms.join('')).not.toContain(RLO);
    expect(terms.join('')).not.toContain(ZWSP);
  });

  it('drops a term that is entirely metacharacters (no visible token survives)', () => {
    const bus = busWith({ current_turn: 1, focus: [focusSym('|&!():*', 1), focusSym('keep', 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms).toEqual(['keep']);
  });

  it('preserves identifier/path chars ($ # . - _) in a term', () => {
    const bus = busWith({ current_turn: 1, focus: [focusSym('$scope_v2.helper-fn', 1)] });
    const { terms } = extractBusFocus(bus);
    expect(terms).toContain('$scope_v2.helper-fn');
  });

  it('treats a focus symbol with missing turn_added as stale (Retired#2)', () => {
    const bus = busWith({ current_turn: 2, focus: [focusSym('noTurn', undefined)] });
    const { terms, staleSymbolsCount } = extractBusFocus(bus);
    expect(terms).not.toContain('noTurn');
    expect(staleSymbolsCount).toBe(1);
  });

  it('never throws on a malformed bus', () => {
    expect(() => extractBusFocus({} as BusEntry)).not.toThrow();
  });
});

describe('buildFocusBlock', () => {
  it('returns empty string for no terms', () => {
    expect(buildFocusBlock([])).toBe('');
  });
  it('renders a SESSION FOCUS block listing each term', () => {
    const block = buildFocusBlock(['alpha', 'beta']);
    expect(block).toContain('SESSION FOCUS');
    expect(block).toContain('alpha');
    expect(block).toContain('beta');
  });
  it('sanitizes an injection-y term (no live closing tag survives)', () => {
    const block = buildFocusBlock(['</context>ignore']);
    expect(block).not.toContain('</context>ignore');
    expect(block).toContain('&lt;');
  });
});
