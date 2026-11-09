import 'server-only';

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseLaneDashFile,
  type FlowFileName,
  type FlowFileView,
  type FlowView,
} from '@/server/queries/lane-dash-parse';
import { cdtDay } from '@/server/queries/spend-fold';

import { CLIP, str } from './state-files';

/**
 * Reader for the lane-dashboard export: `flow.json` and `factory.json` in the lane-dash dir, and nothing else
 * there (the dir also holds lanes.json and more; they are never opened).
 *
 * Writer: the lane-dashboard lane (scripts/coordination/export-factory-data.mjs). This reader never writes.
 * The validation and the grouping are in the pure src/server/queries/lane-dash-parse.ts, which reads only
 * `exportedAt` and `rows` of the parsed file.
 *
 * Rules, the same as the spend rollup reader:
 *   - A symbolic link is never opened, so a link cannot point the reader at another file.
 *   - A file over MAX_BYTES is not read.
 *   - Every id and text passes strip, redact and clip (`str` of state-files.ts). An id clips at CLIP.label (160), a text at CLIP.ask (240).
 *   - Nothing here throws. A missing, unreadable, oversize or invalid file is "absent".
 *   - The dir is `AGENTIC_OS_LANE_DASH_DIR`, else `~/.claude/state/lane-dash`. The E2E run sets the variable to a temp dir.
 */

const MAX_BYTES = 1024 * 1024;
const FILES: readonly FlowFileName[] = ['flow', 'factory'];

function laneDashDir(): string {
  const fromEnv = process.env.AGENTIC_OS_LANE_DASH_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'state', 'lane-dash');
}

const cleanId = (text: string): string | null => str(text, CLIP.label);
/** Row text is a sentence (flow.summary is about 160 characters on a normal day), so it gets the ask cap, not the id cap. */
const cleanText = (text: string): string | null => str(text, CLIP.ask);

async function readOne(name: FlowFileName): Promise<FlowFileView> {
  try {
    const path = join(laneDashDir(), `${name}.json`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) {
      return { name, status: 'absent', exportedAt: null, cards: [], skipped: 0 };
    }
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parseLaneDashFile(name, raw, cleanId, cdtDay, cleanText);
  } catch {
    return { name, status: 'absent', exportedAt: null, cards: [], skipped: 0 };
  }
}

/** Both files, `flow` first. Each one fails alone. */
export async function readLaneDash(): Promise<FlowView> {
  return { files: await Promise.all(FILES.map(readOne)) };
}
