/**
 * SessionStart Hook - Registers session in coordination layer.
 *
 * This hook:
 * 1. Registers the session in PostgreSQL for cross-session awareness
 * 2. Injects a system reminder about coordination layer features
 * 3. Shows other active sessions working on the same project
 *
 * Part of the coordination layer architecture (Phase 1).
 */

import { readFileSync } from 'fs';
import { registerSession } from './shared/db-utils-pg.js';
import { resolveSessionId, writeSessionId, canonicalProject } from './shared/session-id.js';
import { initActivity } from './shared/session-activity.js';
import { label, resolveName, resolvePrevious, runAdopt, writeIdentity } from './shared/session-identity.js';
import type { SessionStartInput, HookOutput } from './shared/types.js';

/** SessionStart and SessionEnd payload fields this hook reads beyond the shared type. */
type RegisterInput = SessionStartInput & {
  hook_event_name?: string;
  session_title?: string;
  reason?: string;
};

/**
 * SessionEnd: stamp the identity file so a later /clear can find the old session.
 * No DB work here: coordination-release owns the session row on SessionEnd.
 */
function recordEnd(input: RegisterInput): void {
  if (!input.session_id) return;
  writeIdentity(input.session_id, {
    endedAt: new Date().toISOString(),
    endReason: input.reason || 'other',
    cwd: input.cwd,
  });
}

/**
 * SessionStart: write the identity file, link `previous`, and adopt the old
 * session's lanes. Returns the label for the greeting. Never throws.
 */
function recordStart(input: RegisterInput): string {
  const uuid = input.session_id;
  if (!uuid) return '#--------';
  const name = resolveName(input.session_title, input.transcript_path);
  const previous = resolvePrevious(input.source, uuid, input.transcript_path, input.cwd, Date.now(), name);
  const id = writeIdentity(uuid, {
    ...(name ? { name } : {}),
    ...(previous ? { previous } : {}),
    cwd: input.cwd,
    endedAt: null,
    endReason: null,
  });
  if (previous) runAdopt(uuid, previous);
  return label(uuid, id?.name ?? name);
}

/**
 * Main entry point for the SessionStart hook.
 * Registers the session, persists the ID to file, and injects awareness message.
 */
export async function main(): Promise<void> {
  // Read hook input from stdin
  let input: RegisterInput;
  try {
    const stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as RegisterInput;
  } catch {
    // If we can't read input, just continue silently
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (input.hook_event_name === 'SessionEnd') {
    try { recordEnd(input); } catch { /* display only */ }
    console.log(JSON.stringify({}));
    return;
  }

  let me = '#--------';
  try { me = recordStart(input); } catch { /* display only */ }

  // Coordinate under the id Claude Code gave us, NOT a freshly generated one.
  // This line is the bug. It called generateSessionId() and produced an `s-*`
  // identity that only this hook ever used, while heartbeat registered the
  // payload id -- two rows per session, and every file claim filed under the
  // `s-*` row whose heartbeat froze here at session start. Measured before the
  // fix: 0 of 8,179 claims owned by a session that looked alive.
  const sessionId = resolveSessionId(input.session_id);
  const project = canonicalProject(input.cwd);
  const projectName = project.split('/').pop() || 'unknown';

  // Store session ID in environment and file for other hooks
  process.env.COORDINATION_SESSION_ID = sessionId;
  if (!writeSessionId(sessionId)) {
    console.error(`[session-register] WARNING: Failed to persist session ID ${sessionId} to file`);
  }

  // Initialize session activity tracking (uses Claude Code UUID if available)
  try {
    const activitySessionId = input.session_id || sessionId;
    initActivity(activitySessionId);
  } catch {
    // Activity tracking is non-critical -- don't block session start
  }

  // Register session in PostgreSQL
  const registerResult = await registerSession(sessionId, project, '');
  if (!registerResult.success) {
    console.error(`[session-register] registration failed: ${registerResult.error}`);
  }

  // Build awareness message. Peers are listed by lane-context, in the same label.
  const awarenessMessage = `
<system-reminder>
MULTI-SESSION COORDINATION ACTIVE

You are ${me}.
Project: ${projectName}

Coordination features:
- File edits are tracked to prevent conflicts
- Research findings are shared automatically
- Use Task tool normally - coordination happens via hooks
</system-reminder>`;

  // Output hook result with awareness injection
  const output: HookOutput = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: awarenessMessage },
  };

  console.log(JSON.stringify(output));
}

// Run if executed directly
main().catch((err) => {
  console.error('[session-register] unexpected error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
