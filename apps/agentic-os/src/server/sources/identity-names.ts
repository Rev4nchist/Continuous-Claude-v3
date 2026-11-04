import 'server-only';

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redact } from './redact';
import { scrubPathsInText, stripControl } from './safe-message';

/**
 * Reader for the session names the hooks write: `<id>.json` in ~/.claude/state/identity
 * ({uuid, short, name, previous, cwd, endedAt, endReason, updatedAt}). Writer:
 * .claude/hooks/src/shared/session-identity.ts. The app reads ONE field, `name`.
 *
 * Rules:
 *   - By id only. The folder is never listed or globbed: the work is bounded by the ids asked for.
 *   - The file NAME is the identity. The `uuid` inside the file is ignored.
 *   - A missing, corrupt, oversize, linked or non-file entry means "no name". Nothing here throws.
 *   - `name` must be a string. It is stripped of invisible characters FIRST, redacted SECOND, scrubbed
 *     of absolute paths THIRD, then whitespace is collapsed and the text is clipped LAST (see
 *     state-files.ts for why that order). `cwd`, `previous` and every other key stay in the file.
 *   - The folder is AGENTIC_OS_IDENTITY_DIR, else <USERPROFILE or HOME>/.claude/state/identity. It
 *     ignores CCV3_IDENTITY_DIR, which is a hook-test variable and must not steer this server.
 */

/**
 * Same format as SESSION_ID_FORMAT in queries/session-detail.ts. This module lives below the queries
 * and does not import them: change BOTH when one changes.
 */
const SAFE_ID = /^[0-9a-fA-F-]{8,64}$/;

const MAX_IDS = 300;
const MAX_BYTES = 16 * 1024;
/** A string longer than this is cut BEFORE redaction, only to bound regex work. */
const PRE_REDACT_CAP = 512;
/** Code points. The same rule as clipName() in .claude/hooks/src/shared/session-identity.ts: no ellipsis. */
const NAME_CLIP = 16;

function identityDir(): string {
  const fromEnv = process.env.AGENTIC_OS_IDENTITY_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.claude', 'state', 'identity');
}

/** Null when the value is not a string or is empty after cleaning. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stripped = stripControl(value.slice(0, PRE_REDACT_CAP));
  const flat = scrubPathsInText(redact(stripped).text).replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return Array.from(flat).slice(0, NAME_CLIP).join('');
}

async function readOne(dir: string, id: string): Promise<string | null> {
  try {
    const path = join(dir, `${id}.json`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return cleanName((parsed as Record<string, unknown>).name);
  } catch {
    return null;
  }
}

/**
 * The cleaned name of each session id that has one. An id with no usable name is absent from the map.
 * An id of the wrong format is never read. At most MAX_IDS distinct ids are read.
 */
export async function readSessionNames(ids: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => typeof id === 'string' && SAFE_ID.test(id)).slice(0, MAX_IDS);
  const dir = identityDir();
  const found = await Promise.all(wanted.map(async (id) => [id, await readOne(dir, id)] as const));
  const names = new Map<string, string>();
  for (const [id, name] of found) if (name !== null) names.set(id, name);
  return names;
}
