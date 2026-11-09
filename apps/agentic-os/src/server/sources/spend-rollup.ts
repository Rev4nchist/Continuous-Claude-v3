import 'server-only';

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseRollup, type RollupResult } from '@/server/queries/spend-rollup-parse';

import { CLIP, str } from './state-files';

/**
 * Reader for the spend rollup file: one `<CDT day>.json` in the spend dir.
 *
 * Writer: the later W4 task (scripts/usage/spend-rollup.mjs). Contract: plan section 5 of
 * .claudedocs/2026-11-09-pr-e-fleet-cost-plan.md; the validation is in the pure
 * src/server/queries/spend-rollup-parse.ts.
 *
 * Rules, the same as the state-file reader:
 *   - A symbolic link is never opened, so a link cannot point the reader at another file.
 *   - A file over MAX_BYTES is not read.
 *   - Every model id and effort passes strip, redact and clip (`str` of state-files.ts).
 *   - Nothing here throws. A missing, unreadable, oversize or invalid file is "absent".
 *   - The dir is `AGENTIC_OS_SPEND_DIR`, else `~/.claude/state/spend`. The E2E run sets the variable to a temp dir.
 */

const MAX_BYTES = 1024 * 1024;
const ABSENT: RollupResult = { status: 'absent' };

function spendDir(): string {
  const fromEnv = process.env.AGENTIC_OS_SPEND_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'state', 'spend');
}

/** `day` is the Chicago date, `YYYY-MM-DD`. A value of another format is never turned into a path. */
export async function readSpendRollup(day: string): Promise<RollupResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ABSENT;
  try {
    const path = join(spendDir(), `${day}.json`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) return ABSENT;
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parseRollup(raw, day, (text) => str(text, CLIP.kind));
  } catch {
    return ABSENT;
  }
}
