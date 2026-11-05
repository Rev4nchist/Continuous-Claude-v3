import { MissionControl } from '@/components/fleet/MissionControl';
import { getMissionControlSnapshot, parseProjectKey, parseViewName } from '@/server/queries/mission-control';
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
 * `?view=sessions&session=<id>` selects the view and the session (`overview`, `board`, `sessions`). `searchParams` is a
 * Promise in Next 16. A `view` that is not a known value and a `session` of the wrong
 * format are ignored. `?project=<key>` picks the Board's lane board; a malformed key shows the default board
 * (the API answers 400 for it, the page never errors).
 */
export const dynamic = 'force-dynamic';

export default async function MissionControlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialSession = parseSessionId(params.session);
  const initialView = parseViewName(params.view) ?? 'overview';
  const parsed = parseProjectKey(params.project);
  const initialProject = parsed.ok ? parsed.key : null;
  // The Board is in the first snapshot only when the page opens on it.
  const snapshot = await getMissionControlSnapshot(
    initialSession,
    initialView === 'board',
    initialProject ?? undefined,
  );

  return (
    <MissionControl
      initial={snapshot}
      initialView={initialView}
      initialSession={initialSession}
      initialProject={initialProject}
    />
  );
}
