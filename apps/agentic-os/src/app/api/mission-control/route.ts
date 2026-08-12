import { NextResponse } from 'next/server';

import { getMissionControlSnapshot } from '@/server/queries/mission-control';

/**
 * The one endpoint `useLiveData()` polls.
 *
 * This is NOT the "separate API service" ADR-0002 rejected. It is a transport for
 * the same in-process query function the page already calls — the boundary is
 * still `src/server/queries/`, and this file contains no logic that could drift
 * from the server render. When Slice 3 swaps polling for SSE, this route is what
 * gets replaced; nothing in `src/components/` changes.
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

export async function GET() {
  try {
    const snapshot = await getMissionControlSnapshot();
    return NextResponse.json(snapshot, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    // A failed poll must not look like an empty fleet. Return the failure with a
    // 503 so the hook keeps its last good data and the header goes amber, rather
    // than rendering zero projects as though the database said so.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
