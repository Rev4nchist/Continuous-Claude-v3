import { MissionControl, type ViewId } from '@/components/fleet/MissionControl';
import { getMissionControlSnapshot } from '@/server/queries/mission-control';
import { parseSessionId } from '@/server/queries/session-detail';

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
 *
 * `?view=sessions&session=<id>` selects the view and the session. `searchParams` is a
 * Promise in Next 16. A `view` that is not a known value and a `session` of the wrong
 * format are ignored.
 */
export const dynamic = 'force-dynamic';

const VIEWS: readonly ViewId[] = ['overview', 'sessions'];

function parseView(value: string | string[] | undefined): ViewId {
  const first = Array.isArray(value) ? value[0] : value;
  return VIEWS.find((view) => view === first) ?? 'overview';
}

export default async function MissionControlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialSession = parseSessionId(params.session);
  const snapshot = await getMissionControlSnapshot(initialSession);

  return (
    <MissionControl
      initial={snapshot}
      initialView={parseView(params.view)}
      initialSession={initialSession}
    />
  );
}
