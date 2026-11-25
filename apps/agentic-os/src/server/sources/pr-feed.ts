import 'server-only';

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  buildPrFeedView,
  laneLookupKeys,
  parseOpenPrs,
  parsePrSpend,
  type LaneRef,
  type OpenPrFeed,
  type PrFeedView,
} from '@/server/queries/pr-feed-parse';

import { CLIP, str } from './state-files';

/**
 * Reader for the Open pull requests table (card prflow-pr-row): open-prs.json and pr-spend.json in the lane-dash dir,
 * and nothing else there. Writers: scripts/github/open-prs.mjs (every 15 minutes) and scripts/github/pr-spend.mjs
 * (nightly). This reader never writes and makes no GitHub call. The rules are in the pure pr-feed-parse.ts.
 *
 * Same guards as lane-dash.ts: a symbolic link is never opened, a file over MAX_BYTES is not read, nothing throws,
 * and each file fails alone. The dir is `AGENTIC_OS_LANE_DASH_DIR`, else `~/.claude/state/lane-dash`.
 *
 * The lane join is one SELECT (role agentic_os_app), board continuous-claude, keyed on the head refs and their last
 * segments. It returns lane id and branch only, and the branch never leaves this file: the view holds the lane id.
 * The table has about 200 rows and `id` is its primary key, so the plan is a small scan; the query runs only on the
 * Overview poll (mission-control.ts).
 */

const MAX_BYTES = 1024 * 1024;
const LANE_LOOKUP_LIMIT = 100;
const BOARD = 'continuous-claude';

export type PrFeedSnapshot = PrFeedView & { laneLookup: 'ok' | 'failed' | 'skipped' };

function laneDashDir(): string {
  const fromEnv = process.env.AGENTIC_OS_LANE_DASH_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'state', 'lane-dash');
}

/** The parsed JSON of one file, or null when it is missing, a link, too big, unreadable or not JSON. */
async function readJson(name: 'open-prs' | 'pr-spend'): Promise<unknown> {
  try {
    const path = join(laneDashDir(), `${name}.json`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Strip, redact and clip, the same as every other text the app shows. */
const cleanLabel = (text: string): string | null => str(text, CLIP.label);

async function lanesFor(feed: OpenPrFeed): Promise<{ lanes: LaneRef[]; status: PrFeedSnapshot['laneLookup'] }> {
  const { refs, leaves } = laneLookupKeys(feed);
  if (refs.length === 0) return { lanes: [], status: 'skipped' };
  const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const leafPart = leaves.length > 0 ? sql` OR l.id IN (${list(leaves)})` : sql``;
  try {
    const { rows } = await db.execute<{ id: string; branch: string | null }>(sql`
      SELECT l.id, l.branch
      FROM agentic_os.lane l
      WHERE l.project_key = ${BOARD}
        AND (l.branch IN (${list(refs)})${leafPart})
      LIMIT ${LANE_LOOKUP_LIMIT}
    `);
    return { lanes: rows.map((r) => ({ id: r.id, branch: r.branch })), status: 'ok' };
  } catch {
    return { lanes: [], status: 'failed' };
  }
}

/**
 * The open rows with their head sha, for the stall reader only (card agentic-os-readers). The same file, the same parse and the
 * same limits as readPrFeed; no lane lookup. The head never reaches a view. Never throws: a missing file is `absent`.
 */
export async function readOpenPrRows(): Promise<OpenPrFeed> {
  return parseOpenPrs(await readJson('open-prs'), cleanLabel);
}

/** The table's data. Never throws: a failed lane lookup shows every lane as a dash. */
export async function readPrFeed(nowMs: number = Date.now()): Promise<PrFeedSnapshot> {
  const [openRaw, spendRaw] = await Promise.all([readJson('open-prs'), readJson('pr-spend')]);
  const open = parseOpenPrs(openRaw, cleanLabel);
  const { lanes, status } = await lanesFor(open);
  return { ...buildPrFeedView(open, parsePrSpend(spendRaw), lanes, nowMs), laneLookup: status };
}
