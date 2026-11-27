/**
 * The holdout ids for the push gate (scripts/github/lib/holdout-ids.mjs, a module with no import and no entry code).
 * Source at run time: <primary checkout>/.claudedocs/2026-11-01-pr-review-dataset.json and
 * <primary checkout>/scripts/eval/review-eval/config.json. The dataset is git-ignored, so a linked worktree has none: the PRIMARY checkout
 * is read (found through git's common dir). Nothing here prints or returns a value to a log: a caller gets ids in memory and a count out.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-ignore TS7016: holdout-ids.mjs has no declaration file.
import * as lib from '../lib/holdout-ids.mjs';

export const DATASET_REL = '.claudedocs/2026-11-01-pr-review-dataset.json';
export const EVAL_CONFIG_REL = 'scripts/eval/review-eval/config.json';

/** How many of the ids stand in the text (a number, never an id). */
export const countIdsIn: (text: string, ids: string[]) => number = lib.countIdsIn;

/**
 * The ids of the holdout PRs read from the primary checkout at `mainRoot`. Throws a fixed text on any problem (missing or malformed file, a
 * dataset or config of the wrong shape, no id): the error never holds file content, so a caller can show it. An empty list is a problem: a scan with no ids would pass everything.
 */
export function loadHoldoutIds(mainRoot: string): string[] {
  let ids: string[];
  try {
    const ds = JSON.parse(readFileSync(join(mainRoot, DATASET_REL), 'utf8'));
    const cfg = JSON.parse(readFileSync(join(mainRoot, EVAL_CONFIG_REL), 'utf8'));
    // Item 14 (card coord-decision-gate-round3-content-scan): the shape is checked first; a partial list would pass ids unseen.
    lib.checkHoldoutShape(ds, cfg);
    ids = lib.holdoutIdsOf(ds, cfg) as string[];
  } catch {
    throw new Error('the holdout id list could not be read');
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('the holdout id list is empty');
  return ids;
}
