/**
 * SessionEnd hook — hand back the file claims this session was holding.
 *
 * WHY
 * ---
 * Until now nothing on this machine ever released a claim. A claim was created
 * on the first Edit and then sat in the table until somebody manually ran
 * cleanup_sessions.py, which is why file_claims accumulated 8,170 rows that were
 * owned by nobody alive.
 *
 * That was tolerable while a stale heartbeat alone was enough to reclaim a file:
 * five minutes after a session died, its claims stopped mattering. It stopped
 * being tolerable in the same change that made reclamation require an expired
 * LEASE as well — a harness lease is an hour, so an unreleased claim from a
 * crashed session is an hour of blocked edits on a hook file. Release is what
 * pays for the longer leases.
 *
 * IT NOW ALSO MARKS THE SESSION ENDED (changed 2026-07-28)
 * --------------------------------------------------------
 * The previous version of this comment said `sessions` had no `ended_at` and
 * that the column would "arrive with agentic_os.session at step 8", so this hook
 * deliberately did not invent it in the legacy table. That deferral has been
 * reversed, on purpose:
 *
 *   - step 8 has not happened and is not next;
 *   - meanwhile the dashboard reads liveness ENTIRELY from a 15-minute window,
 *     so a terminal you closed reads "active" for a quarter of an hour and a
 *     crash is indistinguishable from a clean exit forever;
 *   - and this hook was already handed the one fact that fixes it — Claude
 *     Code's `reason` string — and dropped it into a `claim_released` event,
 *     which is not queryable as session state and is not even written when the
 *     session held no claims.
 *
 * `sessions.ended_at` / `end_reason` were added by
 * scripts/coordination/migrations/003-sessions-lifecycle.sql. Writing them here
 * costs nothing extra: the hook already runs, and the UPDATE goes out CONCURRENT
 * with the claim release rather than after it, so a degraded database stalls exit
 * by one timeout rather than two. They touch different tables and cannot contend.
 *
 * WHAT IT STILL DOES NOT DO
 * -------------------------
 * It cannot run when the process is killed outright — a SessionEnd hook needs the
 * session to end, not to be destroyed. So a missing `ended_at` means UNKNOWN, not
 * "crashed", and the lease expiry remains the backstop for that case, which is
 * exactly why the backstop still exists.
 *
 * POSTURE
 * -------
 * Pure cleanup. Nothing to deny, nothing to gate, no output that matters. Every
 * failure path exits 0. A claim we failed to release is reclaimed by its lease
 * later; an exception thrown here would be a broken session exit.
 */

import { readFileSync } from 'fs';
import { markSessionEnded, releaseSessionClaims } from './shared/db-utils-pg.js';
import { resolveSessionId } from './shared/session-id.js';

interface SessionEndInput {
  session_id?: string;
  cwd?: string;
  /** Claude Code's own word for why the session ended, when it supplies one. */
  reason?: string;
  hook_event_name?: string;
}

export async function main(): Promise<void> {
  let input: SessionEndInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8')) as SessionEndInput;
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const sessionId = resolveSessionId(input.session_id);
  const reason = input.reason || 'session_end';

  // CONCURRENT, not sequential. Both calls open their own short-lived client with
  // a 2s connect / 3s query bound, and a session exit should pay that ceiling
  // once rather than twice when the container is down. They write different
  // tables (file_claims + coordination_event vs sessions) so they cannot contend.
  // Both fail open by construction, so neither can reject and take the other with
  // it — Promise.all is safe here without an allSettled wrapper.
  const [{ released, degraded }, ended] = await Promise.all([
    releaseSessionClaims(sessionId, reason),
    markSessionEnded(sessionId, reason),
  ]);

  // stderr only, and only when something actually happened. stdout is the hook
  // protocol channel; a SessionEnd hook that chatters on every exit is noise in
  // the one place a user is not looking.
  if (degraded || ended.degraded) {
    console.error(
      '[coordination-release] DB unreachable; claims will expire with their leases ' +
      'and this session will have no recorded end',
    );
  } else if (released > 0) {
    console.error(`[coordination-release] released ${released} claim(s) for ${sessionId}`);
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  console.error('[coordination-release] unexpected error:', err);
  console.log(JSON.stringify({}));
});
