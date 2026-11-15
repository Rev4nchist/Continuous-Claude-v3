/**
 * Does a session hold an open lane? Card coord-file-guard-named-file (seat ruling 2026-11-15, Q1).
 *
 * file-claims asks this only when it DENIES, to say "the holder's card is done" when the holder owns no open lane (a lane
 * that finishes clears its owner). It is a hint, never a gate. null = the query did not run (database down): the caller
 * says nothing about the card. One indexed read (lane_owner_idx), see .claudedocs/e2e-coord-file-guard-named-file/02-query-plan.txt.
 *
 * Its own module on purpose: db-utils-pg.ts is bundled into many hooks, and a new export there would change the dist of each.
 */
import { withPgClientOrFallback } from './pg-client.js';

/** A deny is rare, so one query is cheap. Connect plus query, in total. */
const HOLDER_LANE_BUDGET_MS = 500;

export async function holderHoldsOpenLane(sessionId: string): Promise<boolean | null> {
  const { value, degraded } = await withPgClientOrFallback<boolean>(
    async (client) => {
      const res = await client.query(
        `SELECT 1 FROM agentic_os.lane WHERE owner_session_id = $1 AND state <> 'done' LIMIT 1`,
        [sessionId],
      );
      return res.rows.length > 0;
    },
    true,
    'holderHoldsOpenLane',
    { quiet: true, totalMs: HOLDER_LANE_BUDGET_MS },
  );
  return degraded ? null : value;
}
