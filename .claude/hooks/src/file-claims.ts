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
import { checkFileClaim, claimFile, isSessionActive } from './shared/db-utils-pg.js';
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

  // Check if file is claimed by another session
  const claimCheck = await checkFileClaim(filePath, project, sessionId);

  let output: any;

  if (claimCheck.degraded) {
    // We did not learn that the file is free -- we failed to ask. The edit is
    // still permitted (a stopped container must not brick editing) but this
    // path used to be indistinguishable from "no conflict", which is how a
    // broken lock looked healthy for the whole life of this arc.
    console.error('[file-claims] coordination degraded, permitting edit unchecked');
    console.log(JSON.stringify({
      result: 'continue',
      message: '[WARN] Coordination DB unreachable - file conflict NOT checked for this edit',
    }));
    return;
  }

  if (claimCheck.claimed && claimCheck.claimedBy) {
    // Check if the claiming session is still active
    const otherSessionActive = await isSessionActive(claimCheck.claimedBy, STALE_THRESHOLD_MS);

    if (otherSessionActive) {
      // Active session has the file - BLOCK the edit with proper PreToolUse format
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const blockMessage = `⚠️ FILE CONFLICT BLOCKED

"${fileName}" is locked by Session ${claimCheck.claimedBy}

This file is being edited by another active Claude session.
Wait for the other session to finish or coordinate directly.

The lock auto-releases when that session's heartbeat goes stale (5 min).`;

      output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: blockMessage
        }
      };
    } else {
      // Other session is stale - take over the claim
      await claimFile(filePath, project, sessionId);
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      output = {
        result: 'continue',
        message: `[INFO] Took over stale file lock for "${fileName}" from inactive session`,
      };
    }
  } else {
    // No conflict - claim the file for this session
    await claimFile(filePath, project, sessionId);
    output = { result: 'continue' };
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
