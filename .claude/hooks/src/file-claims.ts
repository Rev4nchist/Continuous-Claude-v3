/**
 * PreToolUse:Edit|Write Hook - Enforce file locking for conflict prevention.
 *
 * This hook:
 * 1. Checks if another ACTIVE session has claimed the file
 * 2. BLOCKS edits if there's an active conflict (session heartbeat < 5 min old)
 * 3. Allows and claims if no conflict or other session is stale
 *
 * Part of the coordination layer architecture (Phase 3).
 */

import { readFileSync } from 'fs';
import { resolveFileClaim } from './shared/db-utils-pg.js';
import { resolveSessionId, canonicalProject } from './shared/session-id.js';
import type { PreToolUseInput, HookOutput } from './shared/types.js';

// Stale session threshold (5 minutes)
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Main entry point for the PreToolUse:Edit|Write hook.
 * Enforces file locking - blocks edits when another active session has the file.
 */
export async function main(): Promise<void> {
  // Read hook input from stdin
  let input: PreToolUseInput;
  try {
    const stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as PreToolUseInput;
  } catch {
    // If we can't read input, continue silently
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Only process Edit and Write tools
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Extract file path from input
  const filePath = input.tool_input?.file_path as string;
  if (!filePath) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Claim under the SAME identity heartbeat registers, so isSessionActive() can
  // actually find the owner alive. Previously this read the machine-global id
  // file and filed claims under an `s-*` row that never heartbeats -- which is
  // why every conflict check fell through to "took over stale lock".
  const sessionId = resolveSessionId(input.session_id);
  const project = canonicalProject(input.cwd);

  // One statement decides and claims, and logs the conflict in the same
  // transaction. This used to be three round trips (check -> is-holder-alive ->
  // claim) with a race in each gap; the worst was that two sessions racing for
  // an UNCLAIMED file were BOTH told to go ahead. See resolveFileClaim.
  const decision = await resolveFileClaim(
    filePath, project, sessionId, STALE_THRESHOLD_MS, input.tool_name,
  );

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  let output: any;

  switch (decision.outcome) {
    case 'blocked': {
      const blockMessage = `⚠️ FILE CONFLICT BLOCKED

"${fileName}" is locked by Session ${decision.holder}

This file is being edited by another active Claude session.
Wait for the other session to finish or coordinate directly.

The lock auto-releases when that session's heartbeat goes stale (5 min).`;

      output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: blockMessage,
        },
      };
      break;
    }

    case 'takeover':
      output = {
        result: 'continue',
        message: `[INFO] Took over stale file lock for "${fileName}" from inactive session`,
      };
      break;

    case 'degraded':
      // We did not learn that the file is free -- we failed to ask. The edit is
      // still permitted (a stopped container must not brick editing) but this
      // path used to be indistinguishable from "no conflict", which is how a
      // broken lock looked healthy for the whole life of this arc.
      console.error('[file-claims] coordination degraded, permitting edit unchecked');
      output = {
        result: 'continue',
        message: '[WARN] Coordination DB unreachable - file conflict NOT checked for this edit',
      };
      break;

    default:
      // granted | renewed -- the ordinary path, deliberately silent and
      // deliberately unlogged. One event row per successful Edit is how
      // file_claims accumulated 8,170 dead rows.
      output = { result: 'continue' };
  }

  // A conflict that could not be written down is worth saying out loud: the
  // decision still stands, but the evidence for it is gone.
  if (decision.eventRecorded === false) {
    console.error('[file-claims] conflict occurred but the event was not recorded');
  }

  console.log(JSON.stringify(output));
}

// Run if executed directly. A PreToolUse hook MUST emit exactly one decision on
// stdout, so an unexpected rejection has to be converted into an explicit
// continue rather than being allowed to reach the default unhandled-rejection
// handler, which would exit non-zero having printed nothing.
main().catch((err) => {
  console.error('[file-claims] unexpected error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
