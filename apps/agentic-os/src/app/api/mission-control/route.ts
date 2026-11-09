import { NextResponse, type NextRequest } from 'next/server';

import { getMissionControlSnapshot, parseProjectKey, parseViewName } from '@/server/queries/mission-control';
import { parseSessionId } from '@/server/queries/session-detail';
import { safeMessage } from '@/server/sources/safe-message';

/**
 * The one endpoint `useLiveData()` polls.
 *
 * This is NOT the "separate API service" ADR-0002 rejected. It is a transport for
 * the same in-process query function the page already calls — the boundary is
 * still `src/server/queries/`, and this file contains no logic that could drift
 * from the server render. When Slice 3 swaps polling for SSE, this route is what
 * gets replaced; nothing in `src/components/` changes.
 *
 * `?session=<id>` adds the detail of that session to the snapshot. An id of the wrong
 * format is ignored (never a 400): both detail fields stay null.
 *
 * `?view=board` adds the lane Board, `?view=spend` adds the Spend tab and `?view=flow` adds the Flow tab. Any other
 * `view` value is ignored (board, spend and flow stay null), never an error. Without them the 5 second poll stays small.
 *
 * `?project=<key>` picks the board for `view=board` (default continuous-claude). A key that does not
 * match ^[a-z0-9][a-z0-9-]*$ is a 400, unlike `session` and `view`: an unknown board must not read as the default.
 *
 * NOTE ON LOCATION: the `aos-fleet-grid` lane scope declared
 * `src/app/(mission-control)/**`, and a route group would have kept this file
 * inside it while still serving `/api/mission-control`. It is deliberately at the
 * conventional path instead — hiding an API route inside a UI route group to
 * satisfy a scope string would make the tree lie to the next reader. The scope
 * extension is recorded on the lane instead.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const sessionId = parseSessionId(request.nextUrl.searchParams.get('session'));
    const view = parseViewName(request.nextUrl.searchParams.get('view'));
    const project = parseProjectKey(request.nextUrl.searchParams.get('project'));
    if (!project.ok) {
      return NextResponse.json(
        { error: 'project must match ^[a-z0-9][a-z0-9-]*$' },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      );
    }
    const snapshot = await getMissionControlSnapshot(
      sessionId,
      view === 'board',
      project.key ?? undefined,
      view === 'spend',
      view === 'flow',
    );
    return NextResponse.json(snapshot, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    // A failed poll must not look like an empty fleet. Return the failure with a
    // 503 so the hook keeps its last good data and the header goes amber, rather
    // than rendering zero projects as though the database said so.
    // safeMessage: redacted, path-free and clipped. A raw driver message can hold a path or the query text.
    return NextResponse.json(
      { error: safeMessage(error) },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
