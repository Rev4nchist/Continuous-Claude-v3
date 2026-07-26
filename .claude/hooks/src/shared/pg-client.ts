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
 * Get the PostgreSQL connection string.
 *
 * Checks environment variables in priority order:
 * 1. CONTINUOUS_CLAUDE_DB_URL (canonical)
 * 2. DATABASE_URL (backwards compat)
 * 3. OPC_POSTGRES_URL (legacy)
 * 4. Default local development connection
 */
export function getPgConnectionString(): string {
  return process.env.CONTINUOUS_CLAUDE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.OPC_POSTGRES_URL ||
    'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

/**
 * Run `fn` against a connected client, closing it on every path.
 *
 * Throws on connection or query failure -- callers decide the failure posture,
 * because "cannot reach the DB" means something different to a claim check
 * (fail open, let the edit through) than to a heartbeat (nothing to do).
 */
export async function withPgClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: getPgConnectionString(),
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
    // Node's happy-eyeballs connect raises an AggregateError whose own .message
    // is EMPTY, so the obvious `err.message` logs "degraded:" and nothing else --
    // a diagnostic that tells you the thing failed but never why. Fall through
    // to the nested causes, then to the error's own name.
    const message = describeError(err);
    // stderr only: stdout is the hook's protocol channel and must stay pure JSON.
    console.error(`[coordination] ${context} degraded: ${message}`);
    return { value: fallback, degraded: true, error: message };
  }
}
