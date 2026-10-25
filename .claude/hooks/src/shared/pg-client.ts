/**
 * Direct PostgreSQL transport for the coordination path.
 *
 * WHY THIS EXISTS
 * ---------------
 * The coordination hooks used to reach Postgres by spawning `uv run python -c`
 * with a 3-second timeout (see runPgQuery in db-utils-pg.ts). That interpreter
 * cold-start costs ~700ms when the machine is idle, and the hook makes two of
 * them per Edit. Under concurrency it blows the budget, spawnSync returns
 * status != 0, and every caller reads that failure as "no claim exists" -- so
 * the file lock silently opens.
 *
 * Measured on this machine, 2026-07-26, against a file held by an ACTIVE session
 * (scripts/coordination/load-probe.mjs, 20 concurrent intruders x 3 rounds):
 *
 *   python subprocess transport : 6/60 intruders ALLOWED, p50 5731ms
 *
 * A single unloaded invocation could never see this -- it denies correctly in
 * ~1.5s -- which is exactly why the earlier verification passed while the lock
 * was broken. The load probe is the regression test; run it after any change to
 * the claim path.
 *
 * The connection here is a plain short-lived `pg.Client`, not a pool: each hook
 * is its own process that runs one or two queries and exits, so a pool would
 * never see a second checkout and would only add teardown complexity.
 *
 * FAILURE POSTURE
 * ---------------
 * Callers still fail OPEN when Postgres is genuinely unreachable -- a stopped
 * container must not make the machine unable to edit files. What changes is that
 * failure is now rare (real outage) instead of routine (load), and `degraded` is
 * returned so the caller can say so out loud rather than silently permitting.
 */

import { Client } from 'pg';

/** Enough for a healthy local container; short enough not to stall an Edit. */
const CONNECT_TIMEOUT_MS = 2000;
/** Coordination queries are single-row primary-key lookups; 3s is generous. */
const QUERY_TIMEOUT_MS = 3000;

/**
 * Database URL variables, first match wins.
 * There is no baked-in default: a credential in source is a leak, and a
 * silent fallback hides an install that never exported the variable.
 */
const DB_URL_VARS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'] as const;

let warnedMissingDbUrl = false;

/** Test hook. The WARN is once per process; tests need a fresh process. */
export function resetResolveDbUrlWarningForTests(): void {
  warnedMissingDbUrl = false;
}

/** Thrown when a caller asked for a client and no URL is configured. */
export class MissingDbUrlError extends Error {
  constructor() {
    super('database URL unset');
    this.name = 'MissingDbUrlError';
  }
}

/**
 * Resolve the PostgreSQL URL, or null when every variable is unset.
 *
 * Order: CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL.
 * Empty and whitespace-only values count as unset (SQLite mode writes an
 * empty CONTINUOUS_CLAUDE_DB_URL). On null, one stderr WARN per process
 * names the variables and does not print a value.
 */
export function resolveDbUrl(): string | null {
  for (const name of DB_URL_VARS) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (!warnedMissingDbUrl) {
    warnedMissingDbUrl = true;
    console.error(
      'WARN: CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL and OPC_POSTGRES_URL are unset; skipping database work'
    );
  }
  return null;
}

/** Same as resolveDbUrl. Kept so existing importers do not have to move. */
export function getPgConnectionString(): string | null {
  return resolveDbUrl();
}

/**
 * Run `fn` against a connected client, closing it on every path.
 *
 * Throws on connection or query failure -- callers decide the failure posture,
 * because "cannot reach the DB" means something different to a claim check
 * (fail open, let the edit through) than to a heartbeat (nothing to do).
 */
export async function withPgClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = getPgConnectionString();
  if (!connectionString) {
    // resolveDbUrl already wrote the one WARN. Do not connect, and do not log again.
    throw new MissingDbUrlError();
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: 'claude-hooks-coordination',
  });

  // An idle client with no error listener turns a dropped socket into an
  // unhandled 'error' event, which takes the whole hook process down with it.
  client.on('error', () => { /* surfaced via the awaited query rejection */ });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // Teardown failure cannot change the answer we already computed.
    }
  }
}

/** Best-effort one-line description of anything that can be thrown. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [];
  if (err.message) parts.push(err.message);

  const code = (err as NodeJS.ErrnoException).code;
  if (code) parts.push(`code=${code}`);

  // AggregateError.errors carries the per-address failures (ECONNREFUSED on
  // both ::1 and 127.0.0.1, say) that the outer error drops.
  const nested = (err as AggregateError).errors;
  if (Array.isArray(nested) && nested.length > 0) {
    parts.push(
      nested
        .slice(0, 3)
        .map((e) => (e instanceof Error ? e.message || (e as NodeJS.ErrnoException).code : String(e)))
        .filter(Boolean)
        .join('; ')
    );
  }

  return parts.filter(Boolean).join(' ') || err.constructor.name;
}

/**
 * Same as withPgClient, but converts any failure into `fallback` and reports it.
 *
 * Use where the coordination layer must degrade rather than throw: the hook has
 * to print a decision and exit 0 no matter what the database is doing.
 */
export async function withPgClientOrFallback<T>(
  fn: (client: Client) => Promise<T>,
  fallback: T,
  context: string
): Promise<{ value: T; degraded: boolean; error?: string }> {
  try {
    return { value: await withPgClient(fn), degraded: false };
  } catch (err) {
    if (err instanceof MissingDbUrlError) {
      // The WARN already named the variables. A second "degraded" line would
      // be a second message, and it must not invent a URL.
      return { value: fallback, degraded: true, error: err.message };
    }
    // Node's happy-eyeballs connect raises an AggregateError whose own .message
    // is EMPTY, so the obvious `err.message` logs "degraded:" and nothing else --
    // a diagnostic that tells you the thing failed but never why. Fall through
    // to the nested causes, then to the error's own name.
    const message = describeError(err);

    // A schema fault is not a connectivity fault, and conflating them sends the
    // reader to the wrong place. 42703 = undefined_column, 42P01 = undefined
    // table, 42883 = undefined function/sequence. Those mean the database is
    // answering perfectly well and simply does not have the shape this code
    // needs -- typically because the lease migration has not been applied. The
    // caller still degrades (a hook must never throw), but the operator gets
    // told what is actually wrong instead of going to look at a container that
    // is running fine.
    const code = (err as { code?: string } | undefined)?.code;
    const schemaFault = code === '42703' || code === '42P01' || code === '42883';
    if (schemaFault) {
      console.error(
        `[coordination] ${context} SCHEMA OUT OF DATE (${code}): ${message}\n` +
        `[coordination] the database is reachable -- it is missing objects this ` +
        `code needs. Apply scripts/coordination/migrations/001-file-claims-leases.sql`
      );
    } else {
      // stderr only: stdout is the hook's protocol channel and must stay pure JSON.
      console.error(`[coordination] ${context} degraded: ${message}`);
    }
    return { value: fallback, degraded: true, error: message };
  }
}
