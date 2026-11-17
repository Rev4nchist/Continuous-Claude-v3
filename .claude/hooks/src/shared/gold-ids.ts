/**
 * The gold ids for the guards that only WARN (card coord-content-scan-followups, item gold ids; design note
 * .claudedocs/coordination/2026-11-16-coord-gold-ids-design.md, option 2, Dave's choice through the seat 2026-11-16).
 * Kept in its own file on purpose: the push gate (decision-gate.ts) and commit-preflight.ts import shared/holdout-ids.ts and never this file, so
 * their built bundles do not change with it (a test pins that, and the dist diff shows it). Pure part: scripts/github/lib/holdout-ids.mjs.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
// @ts-ignore TS7016: holdout-ids.mjs has no declaration file.
import * as lib from '../../../../scripts/github/lib/holdout-ids.mjs';
import { loadHoldoutIds } from './holdout-ids.js';

/** The tracked gold answer keys, under the primary checkout (scripts/coordination/board-mask.mjs repeats these two names; a test ties them). */
export const GOLD_DIR_REL = 'scripts/eval/review-eval/gold';
/** The one json file of that folder that holds no rows with ids. */
export const GOLD_NON_ROW_FILES = ['escape-baseline.json'];
const GOLD_UNREADABLE = 'the gold id list could not be read';

/**
 * The gold ids (shas, and PR numbers of 4 digits or more) read from the gold folder of the primary checkout at `mainRoot`. A folder that does
 * not exist holds no id: it gives []. A folder that exists and cannot be read, a file that is not JSON or of the wrong shape throws a fixed text
 * with no file content, never a short list (a partial scan would pass ids unseen).
 */
export function loadGoldIds(mainRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(mainRoot, GOLD_DIR_REL));
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ENOENT') return [];
    throw new Error(GOLD_UNREADABLE);
  }
  try {
    const files = names.filter((n) => n.endsWith('.json') && !GOLD_NON_ROW_FILES.includes(n)).sort()
      .map((n) => JSON.parse(readFileSync(join(mainRoot, GOLD_DIR_REL, n), 'utf8')));
    lib.checkGoldShape(files);
    return lib.goldIdsOf(files) as string[];
  } catch {
    throw new Error(GOLD_UNREADABLE);
  }
}

/**
 * The list of the guards that only WARN or mask: the holdout ids and the gold ids, each once. The push gate and commit-preflight keep
 * loadHoldoutIds (no new deny).
 */
export function loadListedIds(mainRoot: string): string[] {
  return [...new Set([...loadHoldoutIds(mainRoot), ...loadGoldIds(mainRoot)])];
}
