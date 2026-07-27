import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Extensionless, NOT './schema/index.js'. tsconfig uses moduleResolution
// "bundler", which silently rewrites a .js specifier to the .ts file on disk —
// so `tsc --noEmit` passes — but Turbopack does no such rewrite and hard-fails
// with "Module not found". A .js extension here type-checks clean and breaks
// every page at runtime.
import * as agenticOsSchema from './schema/index';
import * as publicReadonly from './readonly/public';

/**
 * The one database client.
 *
 * WHY THERE IS EXACTLY ONE CONNECTION STRING AND NO FALLBACK
 * ---------------------------------------------------------
 * The old FastAPI dashboard hardcoded a port-5434 default while the container
 * actually maps 5432. The app then "worked" against nothing and reported health
 * on a database it was not connected to. A divergent in-code default is what
 * made that possible, so there is none here: if `AGENTIC_OS_DATABASE_URL` is
 * absent we throw at import time with an actionable message, rather than quietly
 * connecting somewhere plausible and wrong.
 *
 * WHICH ROLE THIS IS
 * ------------------
 * `AGENTIC_OS_DATABASE_URL` is the `agentic_os_app` role: SELECT and nothing
 * else, anywhere. With no auth and no RLS in v1, the database role IS the
 * enforcement boundary — it is not decoration, and it is the reason a bug in
 * this app cannot corrupt the three unrelated applications sharing this
 * database. Migrations and the future indexer use their own elevated URLs and
 * deliberately do NOT come through this module.
 */
const connectionString = process.env.AGENTIC_OS_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'AGENTIC_OS_DATABASE_URL is not set.\n' +
      'Expected it in apps/agentic-os/.env.local (Next loads that automatically).\n' +
      'There is deliberately no fallback: a wrong-but-plausible default is how the ' +
      'previous dashboard ended up reporting health on a database it was not connected to.',
  );
}

/**
 * Being a good neighbour on a shared database.
 *
 * Read-only is not the same as harmless. A missing LIMIT, a sequential scan over
 * `sessions`, or a lock wait taken by this dashboard is felt by Fourth Canvas,
 * the ai-reporting MCP server and vibe-trading, which share these 40 tables. The
 * timeouts below make a runaway read fail fast and locally instead of degrading
 * three other applications, and they are set on the connection rather than left
 * as a note someone has to remember to apply to the role.
 */
const STATEMENT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

function createPool(): Pool {
  return new Pool({
    connectionString,
    // Small: this is one dashboard, for one person, on one machine.
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    application_name: 'agentic-os',
  });
}

/**
 * Next's dev server re-evaluates modules on every hot reload. Without this cache
 * each reload leaks a fresh pool and its connections, and Postgres runs out of
 * slots after a few minutes of editing — a shared-database problem, not just a
 * local annoyance.
 */
const globalForDb = globalThis as unknown as { __agenticOsPool?: Pool };
const pool = globalForDb.__agenticOsPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalForDb.__agenticOsPool = pool;

/**
 * Both schemas are composed HERE rather than in `src/db/schema/index.ts`,
 * because that barrel is inside drizzle-kit's migration glob and these `public`
 * declarations must stay invisible to it. This module is only ever read by the
 * running app.
 */
export const schema = { ...agenticOsSchema, ...publicReadonly };

export const db = drizzle(pool, { schema });

/**
 * Loud readiness check.
 *
 * Called from the app's health surface, not at import time — a dashboard that
 * refuses to boot because Postgres is briefly down is worse than one that boots
 * and says so. It returns the failure instead of throwing so the UI can render a
 * real error state rather than a stack trace.
 */
export async function checkDatabaseReady(): Promise<
  { ok: true; latencyMs: number } | { ok: false; error: string }
> {
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
