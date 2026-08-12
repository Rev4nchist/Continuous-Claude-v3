/**
 * Notification hook — records that a session is waiting on a human.
 *
 * WHY THIS EXISTS
 * ---------------
 * The failure mode this captures: a session hits a permission prompt in a
 * terminal you are not watching and sits there indefinitely, holding a worktree
 * and a lane, while you believe it is working. Nothing on this machine records
 * that today -- verified 2026-07-26: `Notification` appears in zero hook
 * registrations in settings.json, so the event Claude Code already fires is
 * dropped on the floor.
 *
 * It is the cheapest high-value instrument missing from the coordination layer,
 * and it is retrofit-hostile: the waiting happens, nobody writes it down, and
 * afterwards there is no way to reconstruct how long anything sat idle.
 *
 * WHAT IT IS NOT
 * --------------
 * This is an event log, not a state machine. Claude Code fires Notification
 * when it starts waiting; there is no corresponding "resumed" event, so
 * duration must be inferred downstream (next event from the same session, or a
 * heartbeat). Do not read a `blocked_on` row as "still blocked right now".
 *
 * POSTURE
 * -------
 * Pure instrumentation: no decision, no gate, nothing to deny. Every failure
 * path exits 0 with an empty JSON object. A notification we failed to record is
 * a lost measurement, never a blocked user.
 */

import { readFileSync } from 'fs';
import { recordEvent } from './shared/coordination-events.js';
import { resolveSessionId, canonicalProject } from './shared/session-id.js';

interface NotificationInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Human-readable text, e.g. "Claude needs your permission to use Bash". */
  message?: string;
  title?: string;
}

/**
 * Classify the notification without over-claiming.
 *
 * Claude Code does not tag these structurally, so this is a text heuristic and
 * is recorded as such: `reason` is a guess, `message` is the ground truth, and
 * both are kept so a wrong guess can be corrected later from stored data rather
 * than needing the event to happen again.
 */
function classify(message: string): 'permission' | 'idle' | 'other' {
  const m = message.toLowerCase();
  if (m.includes('permission') || m.includes('approve') || m.includes('allow')) return 'permission';
  if (m.includes('waiting') || m.includes('idle')) return 'idle';
  return 'other';
}

export async function main(): Promise<void> {
  let input: NotificationInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8')) as NotificationInput;
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const message = (input.message || input.title || '').slice(0, 2000);
  const sessionId = resolveSessionId(input.session_id);
  const project = canonicalProject(input.cwd);

  await recordEvent({
    kind: 'blocked_on',
    sessionId,
    project,
    detail: {
      reason: classify(message),
      message,
      // Kept so a later reader can tell a real payload field from our guess.
      source: input.hook_event_name || 'Notification',
    },
  });

  console.log(JSON.stringify({}));
}

// Fire-and-forget by design: a Notification hook has no decision to make, so
// any unexpected rejection still exits cleanly rather than surfacing an error
// to a user who is already sitting at a prompt.
main().catch((err) => {
  console.error('[coordination-notification] unexpected error:', err);
  console.log(JSON.stringify({}));
});
