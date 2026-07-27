import 'server-only';

import { sql } from 'drizzle-orm';

import { checkDatabaseReady, db } from '@/db';

/**
 * THIS DIRECTORY IS THE API BOUNDARY (ADR-0002).
 *
 * Every read the UI performs goes through a function in `src/server/queries/`.
 * No React component ever imports `db` — that rule is what makes extracting a
 * real API service later a mechanical change instead of a UI rewrite, and it is
 * enforced by the `no-restricted-imports` boundary in `eslint.config.mjs`.
 *
 * Two conventions carried from the ADR, worth following in every file added here:
 *   - Organize by DOMAIN, not by page. A function is named for the question it
 *     answers, never for the screen that happens to call it.
 *   - Return plain typed DTOs. Drizzle builders and raw row shapes do not leave
 *     this directory, so callers never depend on the ORM.
 *
 * `server-only` above turns a violation into a build error rather than a
 * silently-shipped database driver.
 */

export type ScaffoldHealth = {
  database: { ok: true; latencyMs: number } | { ok: false; error: string };
  /** Raw row count. Deliberately NOT presented as a project or session metric —
   *  1,465 of these are `s-*` coordination heartbeats rather than real Claude
   *  Code sessions, and normalizing that is the `aos-project-identity` lane. */
  rawSessionRows: number | null;
};

export async function getScaffoldHealth(): Promise<ScaffoldHealth> {
  const database = await checkDatabaseReady();

  if (!database.ok) {
    return { database, rawSessionRows: null };
  }

  // Every query in this app carries an explicit bound. The dashboard this one
  // replaces fetched all 2,352 sessions and all 8,138 file claims with no LIMIT.
  const [row] = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM public.sessions`,
  ).then((result) => result.rows);

  return { database, rawSessionRows: row ? Number(row.count) : null };
}
