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
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not mark the session ended. `sessions` still has no `ended_at`, so
 * "finished" and "abandoned" and "crashed" remain indistinguishable downstream;
 * that column arrives with agentic_os.session at step 8. This hook deliberately
 * does not invent it in the legacy table.
 *
 * It also cannot run when the process is killed outright — a SessionEnd hook
 * needs the session to end, not to be destroyed. The lease expiry remains the
 * backstop for that case, which is exactly why the backstop still exists.
 *
 * POSTURE
 * -------
 * Pure cleanup. Nothing to deny, nothing to gate, no output that matters. Every
 * failure path exits 0. A claim we failed to release is reclaimed by its lease
 * later; an exception thrown here would be a broken session exit.
 */

import { readFileSync } from 'fs';
import { releaseSessionClaims } from './shared/db-utils-pg.js';
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
  const { released, degraded } = await releaseSessionClaims(
    sessionId,
    input.reason || 'session_end',
  );

  // stderr only, and only when something actually happened. stdout is the hook
  // protocol channel; a SessionEnd hook that chatters on every exit is noise in
  // the one place a user is not looking.
  if (degraded) {
    console.error('[coordination-release] DB unreachable; claims will expire with their leases');
  } else if (released > 0) {
    console.error(`[coordination-release] released ${released} claim(s) for ${sessionId}`);
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  console.error('[coordination-release] unexpected error:', err);
  console.log(JSON.stringify({}));
});
