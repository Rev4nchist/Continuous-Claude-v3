import { MissionControl } from '@/components/fleet/MissionControl';
import { getMissionControlSnapshot } from '@/server/queries/mission-control';

/**
 * Mission Control — the fleet is home (ADR-0004).
 *
 * This replaces the Slice 1 scaffold-proof page that lived at `src/app/page.tsx`.
 * That page's job was to demonstrate the wiring was real; it labelled its one
 * number as the raw row count it actually was, and explicitly deferred the grid
 * to this lane because per-project counts were not yet trustworthy. They are now,
 * and the accounting bar on this page is what keeps them that way.
 *
 * The data is fetched HERE, on the server, and handed to a client component as
 * `initial`. So the first paint is real data with no loading skeleton and no
 * client round-trip, and polling only ever refreshes something already correct.
 */
export const dynamic = 'force-dynamic';

export default async function MissionControlPage() {
  const snapshot = await getMissionControlSnapshot();

  return <MissionControl initial={snapshot} />;
}
