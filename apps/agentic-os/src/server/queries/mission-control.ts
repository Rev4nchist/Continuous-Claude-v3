import 'server-only';

import { checkDatabaseReady } from '@/db';

import { getFleetOverview, type FleetOverview } from '@/server/queries/projects';
import { getActiveSessions, type ActiveSessions } from '@/server/queries/sessions';

/**
 * ONE snapshot, assembled in ONE place.
 *
 * The server-rendered page and the polling endpoint both call this, deliberately.
 * If the initial render and the 5-second refresh assembled their own shapes, the
 * screen would change composition on first poll — the classic dashboard bug where
 * a value is right for five seconds and then wrong forever, or vice versa. One
 * function means the first paint and the hundredth are the same contract.
 *
 * The three reads run concurrently but are NOT a transaction. They can therefore
 * disagree by a row or two if a session is inserted mid-flight, which is exactly
 * why `getFleetOverview()` computes its own buckets inside a single query and
 * nothing here re-derives a total by adding numbers across these three results.
 */
export type MissionControlSnapshot = {
  fleet: FleetOverview;
  active: ActiveSessions;
  database: { ok: true; latencyMs: number } | { ok: false; error: string };
  /** When the server produced this, ISO-8601 UTC. The UI shows staleness relative
   *  to receipt rather than to this value — a clock difference between server and
   *  browser is not the user's problem to reason about. */
  generatedAt: string;
};

export async function getMissionControlSnapshot(): Promise<MissionControlSnapshot> {
  const [database, fleet, active] = await Promise.all([
    checkDatabaseReady(),
    getFleetOverview(),
    getActiveSessions(),
  ]);

  return { fleet, active, database, generatedAt: new Date().toISOString() };
}
