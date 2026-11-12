/**
 * SessionStart Hook - Registers session in coordination layer.
 *
 * This hook:
 * 1. Registers the session in PostgreSQL for cross-session awareness
 * 2. Injects a system reminder about coordination layer features
 * 3. Shows other active sessions working on the same project
 * 4. Names a session that has no name (an animal word) and returns it as sessionTitle
 *
 * Part of the coordination layer architecture (Phase 1).
 */

import { readFileSync } from 'fs';
import { isEngineHost } from './shared/engine-host.js';
import { registerSession, type LiveSession } from './shared/db-utils-pg.js';
import { resolveSessionId, writeSessionId, canonicalProject } from './shared/session-id.js';
import { initActivity } from './shared/session-activity.js';
import { claudePidFromEnv, label, readIdentity, resolveName, resolvePrevious, runAdopt, writeIdentity } from './shared/session-identity.js';
import { autoNameAllowed, chooseName, heldDegraded, heldFromLive, laneBoardLine, sameNameHint, type HeldMap } from './shared/session-names.js';
import type { SessionStartInput, SessionStartHookOutput } from './shared/types.js';

/** SessionStart and SessionEnd payload fields this hook reads beyond the shared type. */
type RegisterInput = SessionStartInput & {
  hook_event_name?: string;
  session_title?: string;
  reason?: string;
};

/** The DB step (register + live-session SELECT) gets this long. The hook as a whole has 10 s. */
const DB_DEADLINE_MS = 7000;

/** What SessionStart decides before the DB step. */
interface StartPlan {
  /** A name the payload or the transcript already gives (--name, /rename). */
  name: string | null;
  previous: string | null;
  /** Auto-naming applies to this start (not headless, not switched off). */
  autoOn: boolean;
  /** A pick or a fork carry may need the live-session SELECT. */
  needLive: boolean;
}

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

/** Reads identity files and the transcript only: no DB. Never throws. */
function planStart(input: RegisterInput): StartPlan {
  const uuid = input.session_id;
  if (!uuid) return { name: null, previous: null, autoOn: false, needLive: false };
  const name = resolveName(input.session_title, input.transcript_path);
  const previous = resolvePrevious(input.source, uuid, input.transcript_path, input.cwd, Date.now(), name);
  const autoOn = autoNameAllowed();
  const needLive = autoOn && !name && input.source !== 'compact' && !readIdentity(uuid)?.name;
  return { name, previous, autoOn, needLive };
}

/** Register the session and, when asked, read the live sessions. A hung DB cannot hold the hook past the deadline. */
async function registerWithDeadline(
  sessionId: string,
  project: string,
  plan: StartPlan,
): Promise<{ success: boolean; error?: string; live?: LiveSession[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ success: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ success: false, error: `no answer in ${DB_DEADLINE_MS} ms` }), DB_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      registerSession(sessionId, project, '', plan.needLive ? { previousId: plan.previous } : undefined),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The automatic name for this start, or null for none. `live` is the DB snapshot; undefined
 * (no DB, slow DB, SELECT failed) falls back to the identity folder.
 */
function autoName(input: RegisterInput, plan: StartPlan, live: LiveSession[] | undefined): string | null {
  const uuid = input.session_id;
  if (!plan.autoOn || !uuid) return null;
  const ownName = readIdentity(uuid)?.name ?? null;
  let held: HeldMap = new Map();
  if (plan.needLive) held = live ? heldFromLive(live.map((l) => l.id)) : heldDegraded(Date.now(), [uuid]);
  const parentEnded = !!(plan.previous && readIdentity(plan.previous)?.endedAt);
  const parentQuiet = !!plan.previous && (parentEnded || (live !== undefined && !live.some((l) => l.id === plan.previous && l.alive)));
  const picked = chooseName({
    uuid,
    source: input.source,
    named: !!plan.name,
    ownName,
    previousId: plan.previous,
    previousName: plan.previous ? readIdentity(plan.previous)?.name ?? null : null,
    previousQuiet: parentQuiet,
    held,
  });
  return picked && picked.trim() ? picked.trim() : null;
}

/**
 * SessionStart: pick a name, write the identity file, link `previous`, and adopt the old
 * session's lanes. A fork does not adopt: its parent usually keeps running (D5).
 * Returns the label for the greeting, the name to hand back as sessionTitle, and the
 * same-name hint. Never throws.
 */
function recordStart(
  input: RegisterInput,
  plan: StartPlan,
  live: LiveSession[] | undefined,
): { me: string; title: string | null; hint: string | null } {
  const uuid = input.session_id;
  if (!uuid) return { me: '#--------', title: null, hint: null };
  const title = autoName(input, plan, live);
  const name = plan.name ?? title;
  const id = writeIdentity(uuid, {
    ...(name ? { name } : {}),
    ...(plan.previous ? { previous: plan.previous } : {}),
    cwd: input.cwd,
    endedAt: null,
    endReason: null,
    // Every start rewrites the pid: a resumed session has the same uuid and a new process.
    // No usable CLAUDE_PID: clear it. The stored one belongs to an earlier process of this session.
    pid: claudePidFromEnv() ?? null,
  });
  if (plan.previous && input.source !== 'fork') runAdopt(uuid, plan.previous);
  // Report only, never move lanes (D6): a session Dave named, started while an unended twin holds the name.
  const hint = input.source === 'startup' && input.session_title ? sameNameHint(uuid, plan.name, input.cwd) : null;
  return { me: label(uuid, id?.name ?? name), title, hint };
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

  // Under a Cursor host (the review engine) register nothing: no DB row, no identity, global id
  // or activity file, no banner, no sessionTitle. Before the SessionEnd check: cursor sends
  // camelCase 'sessionEnd', which that PascalCase check misses (finding F1).
  if (isEngineHost(input)) {
    console.log(JSON.stringify({}));
    return;
  }

  if (input.hook_event_name === 'SessionEnd') {
    try { recordEnd(input); } catch { /* display only */ }
    console.log(JSON.stringify({}));
    return;
  }

  let plan: StartPlan = { name: null, previous: null, autoOn: false, needLive: false };
  try { plan = planStart(input); } catch { /* display only */ }

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

  // Register session in PostgreSQL. This comes before the identity write: the name pick reads the
  // live sessions on the same client.
  const registerResult = await registerWithDeadline(sessionId, project, plan);
  if (!registerResult.success) {
    console.error(`[session-register] registration failed: ${registerResult.error}`);
  }

  let me = '#--------';
  let title: string | null = null;
  let hint: string | null = null;
  try { ({ me, title, hint } = recordStart(input, plan, registerResult.live)); } catch { /* display only */ }

  // Build awareness message. Peers are listed by lane-context, in the same label.
  const awarenessMessage = `
<system-reminder>
MULTI-SESSION COORDINATION ACTIVE

You are ${me}.
Project: ${projectName}
${laneBoardLine(input.cwd)}
${hint ? `${hint}\n` : ''}
Coordination features:
- File edits are tracked to prevent conflicts
- Use Task tool normally - coordination happens via hooks
</system-reminder>`;

  // Output hook result with awareness injection. sessionTitle only as a non-empty string.
  const output: SessionStartHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: awarenessMessage,
      ...(title ? { sessionTitle: title } : {}),
    },
  };

  // Exit after the write: an open DB socket must not hold the process past the 10 s hook timeout.
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

// Run if executed directly
main().catch((err) => {
  console.error('[session-register] unexpected error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
