/**
 * A holder frees ONE file claim early (card coord-file-claim-release-one).
 *
 * Before this, the only release of a row in `file_claims` was `releaseSessionClaims` at session end. A
 * session that finished a file kept it claimed until it ended, and other sessions could not write it.
 *
 * Rules:
 *  - Holder only. The holder test is `session_id = $3` in the DELETE. A non-holder frees 0 rows.
 *  - The caller's OWN rows are read first and the typed path is matched against them in JS, so nobody has
 *    to rebuild the stored key by hand (a tracked file is repo-relative, a `.claude/cache` file keeps the
 *    raw path the tool sent: see claim-target.ts).
 *  - SEAT RULE: an exact key match deletes. A raw-string or loose match deletes only when it fits exactly
 *    ONE own row. A path that fits more than one frees nothing and returns those rows (own rows only).
 *  - The delete and the `claim_released` event are ONE transaction. A dropped event rolls the delete back.
 *  - A path no own row fits gets one more read for THAT key only: who holds it. No other row of another
 *    session is ever read or shown.
 */
import { posix, win32 } from 'path';
import { withPgClientOrFallback } from './pg-client.js';
import { recordEventInTransaction } from './coordination-events.js';
import { resolveClaimKey } from './claim-target.js';
import { canonicalProject } from './session-id.js';

export interface ClaimRow {
  file_path: string;
  project: string;
}

export interface MatchOptions {
  /** Test hook. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export type Match =
  | { kind: 'delete'; row: ClaimRow; tier: 'exact' | 'raw' | 'loose' }
  | { kind: 'ambiguous'; rows: ClaimRow[] }
  | { kind: 'none' };

export type ReleaseResult =
  | { typed: string; outcome: 'freed'; file: string }
  | { typed: string; outcome: 'none' }
  | { typed: string; outcome: 'not-holder'; heldBy: string }
  | { typed: string; outcome: 'ambiguous'; rows: ClaimRow[] }
  | { typed: string; outcome: 'degraded' };

export const OWN_ROWS_SQL = `SELECT file_path, project FROM file_claims WHERE session_id = $1 ORDER BY file_path, project`;
export const DELETE_ONE_SQL = `DELETE FROM file_claims WHERE file_path = $1 AND project = $2 AND session_id = $3 RETURNING file_path`;
export const HOLDER_SQL = `SELECT session_id FROM file_claims WHERE file_path = $1 AND project = $2`;

const FOLDS_CASE: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['win32', 'darwin']);

/** `/c/Users/x` (Git Bash) to `C:/Users/x`. path.resolve would turn it into `C:\c\Users\x` on win32. */
function gitBashToDrive(p: string): string {
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2] ?? ''}` : p;
}

/** One spelling for comparison: drive form, both slash directions as `/`, case fold where the volume folds. */
function looseForm(p: string, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const normal = (win ? win32 : posix).normalize(win ? gitBashToDrive(p) : p);
  const slashed = win ? normal.replace(/\\/g, '/') : normal;
  return FOLDS_CASE.has(platform) ? slashed.toLowerCase() : slashed;
}

function absoluteOf(typed: string, cwd: string, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  return (win ? win32 : posix).resolve(cwd, win ? gitBashToDrive(typed) : typed);
}

/**
 * The keys a typed path can be stored under. `exact` is the pair file-claims stores for it (claimOne:
 * `resolveClaimKey`, else the raw path plus the cwd project). `raw` is the typed string. `loose` holds the
 * comparison spellings: as typed, absolute against `cwd`, and the exact key's path.
 */
export function candidateKeys(
  typedPath: string,
  cwd: string,
  options: MatchOptions = {},
): { exact: ClaimRow; raw: string; loose: string[] } {
  const platform = options.platform ?? process.platform;
  const key = resolveClaimKey(typedPath, { cwd, platform });
  const exact = key
    ? { file_path: key.filePath, project: key.project }
    : { file_path: typedPath, project: canonicalProject(cwd) };
  const loose = [typedPath, absoluteOf(typedPath, cwd, platform), exact.file_path].map((p) => looseForm(p, platform));
  return { exact, raw: typedPath, loose: [...new Set(loose)] };
}

const pick = (rows: ClaimRow[], tier: 'raw' | 'loose'): Match =>
  rows.length === 1 ? { kind: 'delete', row: rows[0], tier } : { kind: 'ambiguous', rows };

/** Match a typed path against the caller's OWN rows. Pure: it reads no database. */
export function matchOwnRows(
  typedPath: string,
  cwd: string,
  ownRows: ClaimRow[],
  options: MatchOptions = {},
): Match {
  const platform = options.platform ?? process.platform;
  const c = candidateKeys(typedPath, cwd, options);
  const exact = ownRows.find((r) => r.file_path === c.exact.file_path && r.project === c.exact.project);
  if (exact) return { kind: 'delete', row: exact, tier: 'exact' };
  const raw = ownRows.filter((r) => r.file_path === c.raw);
  if (raw.length > 0) return pick(raw, 'raw');
  const loose = ownRows.filter((r) => c.loose.includes(looseForm(r.file_path, platform)));
  return loose.length > 0 ? pick(loose, 'loose') : { kind: 'none' };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** Who holds this ONE key: another session's label, or nobody. Reads no other row. */
async function otherHolder(client: Queryable, key: ClaimRow, typed: string): Promise<ReleaseResult> {
  const res = await client.query(HOLDER_SQL, [key.file_path, key.project]);
  const holder = res.rows[0]?.session_id;
  return typeof holder === 'string' ? { typed, outcome: 'not-holder', heldBy: holder } : { typed, outcome: 'none' };
}

interface Ctx {
  client: Queryable;
  sessionId: string;
  cwd: string;
  options: MatchOptions;
  own: ClaimRow[];
  freed: string[];
}

const keyString = (r: ClaimRow): string => JSON.stringify([r.file_path, r.project]);

async function releaseOne(ctx: Ctx, typed: string): Promise<ReleaseResult> {
  const m = matchOwnRows(typed, ctx.cwd, ctx.own, ctx.options);
  if (m.kind === 'ambiguous') return { typed, outcome: 'ambiguous', rows: m.rows };
  if (m.kind === 'none') return otherHolder(ctx.client, candidateKeys(typed, ctx.cwd, ctx.options).exact, typed);
  const done = ctx.freed.includes(keyString(m.row));
  if (done) return { typed, outcome: 'freed', file: m.row.file_path };
  const res = await ctx.client.query(DELETE_ONE_SQL, [m.row.file_path, m.row.project, ctx.sessionId]);
  if (res.rows.length === 0) return otherHolder(ctx.client, m.row, typed);
  ctx.freed.push(keyString(m.row));
  return { typed, outcome: 'freed', file: m.row.file_path };
}

async function releaseInTransaction(
  client: Queryable,
  sessionId: string,
  typedPaths: string[],
  cwd: string,
  reason: string,
  options: MatchOptions,
): Promise<ReleaseResult[]> {
  await client.query('BEGIN');
  try {
    const own = (await client.query(OWN_ROWS_SQL, [sessionId])).rows as unknown as ClaimRow[];
    const ctx: Ctx = { client, sessionId, cwd, options, own, freed: [] };
    const results: ReleaseResult[] = [];
    for (const typed of typedPaths) results.push(await releaseOne(ctx, typed));
    if (ctx.freed.length > 0) await recordRelease(client, sessionId, reason, results);
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
    throw err;
  }
}

/** One event for the call. A dropped event throws, so the delete rolls back with it (one transaction). */
async function recordRelease(client: Queryable, sessionId: string, reason: string, results: ReleaseResult[]): Promise<void> {
  const files = [...new Set(results.flatMap((r) => (r.outcome === 'freed' ? [r.file] : [])))];
  const ok = await recordEventInTransaction(client as never, {
    kind: 'claim_released',
    sessionId,
    detail: { reason, count: files.length, files },
  });
  if (!ok) throw new Error('claim_released event was not recorded');
}

/**
 * Free the caller's own claims that match `typedPaths`. One transaction. One result per typed path.
 * A database that is down, or any error in the transaction, gives `degraded` for every path.
 */
export async function releaseOwnClaim(
  sessionId: string,
  typedPaths: string[],
  cwd: string,
  reason: string,
  options: MatchOptions = {},
): Promise<ReleaseResult[]> {
  const { value, degraded } = await withPgClientOrFallback<ReleaseResult[] | null>(
    (client) => releaseInTransaction(client as unknown as Queryable, sessionId, typedPaths, cwd, reason, options),
    null,
    `releaseOwnClaim(${sessionId})`,
    { quiet: true },
  );
  if (degraded || !value) return typedPaths.map((typed) => ({ typed, outcome: 'degraded' as const }));
  return value;
}

/** The caller's own claims. Never another session's. */
export async function listOwnClaims(sessionId: string): Promise<{ rows: ClaimRow[]; degraded: boolean }> {
  const { value, degraded } = await withPgClientOrFallback<ClaimRow[]>(
    async (client) => (await client.query(OWN_ROWS_SQL, [sessionId])).rows as ClaimRow[],
    [],
    `listOwnClaims(${sessionId})`,
    { quiet: true },
  );
  return { rows: value, degraded };
}
