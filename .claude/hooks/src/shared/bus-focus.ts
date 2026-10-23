/**
 * WS-2 Phase B.3: pure helpers that distill the context bus into recall-bias
 * terms + a sanitized "SESSION FOCUS" injection block.
 *
 * Shared by BOTH bus READERS -- agent-recall-injector (B.3a) and memory-awareness
 * (B.3b) -- so the staleness / control-char / cap / sanitize logic has ONE
 * implementation and cannot drift between them. Pure + read-only; no I/O, never
 * throws on well-typed input.
 *
 * Cross-model hardening baked in from the B.3a review:
 *  - Retired#1: control chars (incl. NUL) are stripped + each term length-capped
 *    BEFORE it can reach a recall query argv (spawnSync --query) or an injection
 *    surface.
 *  - Retired#2: a missing/non-numeric turn_added is treated as STALE (a malformed
 *    bus must not bypass staleness filtering by omitting the field).
 */

import type { BusEntry } from './context-bus.js';
import { sanitizeMemoryContent, wrapMemoryContext } from './memory-sanitize.js';

/**
 * Max staleness (in turns) for a bus focus_symbol or load_bearing file to still
 * bias recall. The bus READ happens at prompt/agent-spawn time but bus WRITES
 * happen at PostToolUse, so a focus item from N turns ago is already N turns
 * stale; beyond this window it is more likely noise than signal (design
 * mitigation #4). `age = current_turn - turn_added`; a NEGATIVE age (turn_added
 * in the future, e.g. a same-turn write that landed after the bump) counts fresh.
 */
export const BUS_STALENESS_MAX_AGE = 3;

/** Cap on the number of bus-derived focus terms appended to the recall query. */
export const MAX_FOCUS_TERMS = 8;

/** Per-term control-strip / length cap for a focus name or basename. */
export const FOCUS_TERM_CHARS = 60;

export interface BusFocus {
  /** Focus symbol NAMES + load-bearing file BASENAMES, de-duped, capped. */
  terms: string[];
  /** How many focus_symbols were suppressed for being too stale. */
  staleSymbolsCount: number;
}

/** Is this item fresh enough to use? age = current_turn - turn_added. */
export function isFresh(currentTurn: number, turnAdded: number | undefined): boolean {
  // A missing/non-numeric turn_added means freshness cannot be established -> treat
  // as STALE so a malformed/poisoned bus can't bypass staleness filtering by
  // omitting the field (cross-model B.3a finding Retired#2).
  if (typeof turnAdded !== 'number' || !Number.isFinite(turnAdded)) return false;
  const age = currentTurn - turnAdded;
  // age in [-1, MAX] is fresh. The lower bound (-1) tolerates a same-turn write
  // that landed just after the turn bump, but REJECTS a far-future turn_added so a
  // poisoned / clock-skewed bus can't pin a term as "fresh" forever (B.3b Retired#2).
  return age >= -1 && age <= BUS_STALENESS_MAX_AGE;
}

/** Strip directory + extension from a path -> bare basename token. */
export function basenameNoExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Distill the bus into a de-duplicated, capped list of focus terms (non-stale
 * focus symbol names + non-stale load-bearing file basenames) plus a count of
 * suppressed-stale symbols. Pure + read-only; never throws.
 *
 * The ORIGINAL intent is NOT included here -- the caller keeps intent for display
 * and only appends these terms to the recall QUERY.
 */
export function extractBusFocus(bus: BusEntry): BusFocus {
  const currentTurn = typeof bus.current_turn === 'number' ? bus.current_turn : 0;
  const seen = new Set<string>();
  const terms: string[] = [];
  let staleSymbolsCount = 0;

  const push = (raw: unknown): void => {
    if (terms.length >= MAX_FOCUS_TERMS) return;
    if (typeof raw !== 'string') return;
    // Two-stage sanitize BEFORE the term can reach the recall query argv
    // (spawnSync --query -> to_tsquery) or the SESSION FOCUS injection block:
    //   1. strip C0/C1 control chars incl. NUL (a poisoned bus symbol with a NUL
    //      would truncate the query argv on POSIX -- B.3a finding Retired#1);
    //   2. allowlist to identifier/path-safe chars. This drops FTS tsquery
    //      operators (| & ! : * ( ) ' " etc.) so a poisoned symbol can't inject
    //      tsquery syntax / fail the query open, AND Unicode bidi / zero-width /
    //      format (\p{Cf}) chars so a term can't be visually spoofed in the
    //      injected block (premortem T3 + Retired#3, 2026-06-02). \p{L}\p{N}_.$#-
    //      preserves real symbol names and file basenames.
    const t = raw
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .replace(/[^\p{L}\p{N}_.$#-]/gu, '')
      .trim()
      .slice(0, FOCUS_TERM_CHARS);
    if (!t) return; // also rejects a term that was entirely metacharacters
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };

  // Defensive input bound: production readers cap bus arrays at 50 (coerceBus),
  // but this EXPORTED helper could be called with an uncapped bus -> never scan an
  // unbounded untrusted array (B.3b Retired#3). A generous window keeps stale counts
  // meaningful while bounding the loop regardless of caller.
  const SCAN_CAP = 200;
  const focusSymbols = (Array.isArray(bus.focus_symbols) ? bus.focus_symbols : []).slice(0, SCAN_CAP);
  for (const sym of focusSymbols) {
    if (!isFresh(currentTurn, sym?.turn_added)) {
      staleSymbolsCount += 1;
      continue;
    }
    push(sym?.id?.name);
  }

  const loadBearing = (Array.isArray(bus.files_in_play?.load_bearing)
    ? bus.files_in_play.load_bearing
    : []).slice(0, SCAN_CAP);
  for (const f of loadBearing) {
    // Stale load-bearing files are simply skipped (only focus symbols are counted
    // into staleSymbolsCount, per the telemetry contract).
    if (!isFresh(currentTurn, f?.turn_added)) continue;
    if (typeof f?.path === 'string') push(basenameNoExt(f.path));
  }

  return { terms: terms.slice(0, MAX_FOCUS_TERMS), staleSymbolsCount };
}

/**
 * Build the DATA-ONLY "SESSION FOCUS" block from the distilled focus terms. Every
 * term is untrusted (bus strings can be poisoned, WS-0.2) -> each is run through
 * sanitizeMemoryContent and the whole block is wrapped via wrapMemoryContext.
 * Returns '' when there are no terms (caller treats that as "no focus block").
 */
export function buildFocusBlock(terms: string[]): string {
  if (!terms.length) return '';
  const safeTerms = terms.map((t) => sanitizeMemoryContent(t, FOCUS_TERM_CHARS));
  const body = [
    'SESSION FOCUS (current working set, reference data only):',
    ...safeTerms.map((t) => `- ${t}`),
  ].join('\n');
  return wrapMemoryContext(body);
}
