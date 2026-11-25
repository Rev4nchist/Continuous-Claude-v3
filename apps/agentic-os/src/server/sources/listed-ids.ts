import 'server-only';

import { readdirSync, readFileSync } from 'node:fs';

import { listedIdRoot, loadListedIds, type ListedIds } from '@/lib/listed-id-mask';

/**
 * The listed ids (the holdout and gold answer-key ids), read at run time from the same files as scripts/coordination/board-mask.mjs readIdList
 * (card agentic-os-listed-id-mask). No id is in any app source, test, message or log. The root is AGENTIC_OS_LISTED_ID_ROOT, else two folders
 * above the app; a root with no list files is a failure ("absent"), never an empty list.
 *
 * A good list is kept 60 seconds. A failure is not kept: the next poll reads again, so a list that comes back is used at once.
 * Accepted trade-off (CodeRabbit CLI run 1, seat word 11:03): an id added to the list files shows in the mask after at most 60 seconds. The
 * list files change by hand and rarely; a read on each 5-second poll costs more than this window is worth.
 */
const KEEP_MS = 60_000;
let kept: { root: string; at: number; value: ListedIds } | null = null;

export function readListedIds(nowMs: number = Date.now()): ListedIds {
  const root = listedIdRoot(process.env, process.cwd());
  if (kept && kept.root === root && nowMs - kept.at < KEEP_MS) return kept.value;
  const value = loadListedIds(
    root,
    (path) => readFileSync(path, 'utf8'),
    (dir) => readdirSync(dir),
  );
  kept = value.ok ? { root, at: nowMs, value } : null;
  return value;
}
