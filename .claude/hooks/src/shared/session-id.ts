/**
 * Session ID utilities for cross-process coordination.
 *
 * Provides consistent session ID generation and persistence across hooks.
 * Session IDs are persisted to ~/.claude/.coordination-session-id to enable
 * cross-process sharing (each hook runs as a separate Node.js process).
 *
 * Used by:
 * - session-register.ts (writes ID on session start)
 * - file-claims.ts (reads ID for file conflict detection)
 */

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Default filename for session ID persistence */
const SESSION_ID_FILENAME = '.coordination-session-id';

/**
 * Returns the path to the session ID persistence file.
 * Optionally creates the parent directory if it doesn't exist.
 *
 * @param options.createDir - If true, creates ~/.claude/ directory (default: false)
 * @returns Path to ~/.claude/.coordination-session-id
 */
export function getSessionIdFile(options: { createDir?: boolean } = {}): string {
  const claudeDir = join(process.env.HOME || process.env.USERPROFILE || homedir(), '.claude');

  if (options.createDir) {
    try {
      mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    } catch { /* ignore mkdir errors */ }
  }

  return join(claudeDir, SESSION_ID_FILENAME);
}

/**
 * Generates a new short session ID.
 * Priority: BRAINTRUST_SPAN_ID (first 8 chars) > timestamp-based ID.
 *
 * @returns 8-character session identifier (e.g., "s-m1abc23")
 */
export function generateSessionId(): string {
  const spanId = process.env.BRAINTRUST_SPAN_ID;
  if (spanId) {
    return spanId.slice(0, 8);
  }
  return `s-${Date.now().toString(36)}`;
}

/**
 * Writes the session ID to the persistence file.
 * Creates the ~/.claude/ directory if needed.
 *
 * @param sessionId - The session ID to persist
 * @returns true if write succeeded, false otherwise
 */
export function writeSessionId(sessionId: string): boolean {
  try {
    const filePath = getSessionIdFile({ createDir: true });
    writeFileSync(filePath, sessionId, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the session ID from the persistence file.
 *
 * @returns The session ID if found, null otherwise
 */
export function readSessionId(): string | null {
  try {
    const sessionFile = getSessionIdFile();
    const id = readFileSync(sessionFile, 'utf-8').trim();
    return id || null;
  } catch {
    // File doesn't exist or read error - return null
    return null;
  }
}

/**
 * Retrieves the session ID for coordination, checking multiple sources.
 * Priority: env var > file > BRAINTRUST_SPAN_ID > generated.
 *
 * @param options.debug - If true, logs when falling back to generation
 * @returns Session identifier string (e.g., "s-m1abc23")
 */
export function getSessionId(options: { debug?: boolean } = {}): string {
  // First try environment (same process)
  if (process.env.COORDINATION_SESSION_ID) {
    return process.env.COORDINATION_SESSION_ID;
  }

  // Try reading from file (cross-process persistence)
  const fileId = readSessionId();
  if (fileId) {
    return fileId;
  }

  // Fallback - log if debug enabled
  if (options.debug) {
    console.error('[session-id] WARNING: No persisted session ID found, generating new one');
  }

  // Fallback to Braintrust span ID or generate new
  return generateSessionId();
}

/**
 * Returns the current project directory path.
 *
 * @returns CLAUDE_PROJECT_DIR env var or current working directory
 */
export function getProject(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ---------------------------------------------------------------------------
// Coordination identity (2026-07-26). ADDITIVE on purpose.
//
// getSessionId()/getProject() above are deliberately left untouched: getSessionId
// also seeds bus ids (shared/session-bus-id.ts:86) and changing its semantics
// would silently re-key the context bus. New coordination code uses the two
// functions below; the old pair stays for non-coordination callers.
// ---------------------------------------------------------------------------

/**
 * The session id to coordinate under.
 *
 * Prefers the id Claude Code puts in the hook payload, which is the ONLY id all
 * hooks can agree on. Verified 2026-07-26 by probe: the payload id is stable
 * across a session and identical for the main session and its subagents (a scout
 * reported the parent's id, with CLAUDE_AGENT_ID unset and the same ppid).
 *
 * Why this matters: session-register was calling generateSessionId() and writing
 * an `s-*` row, while heartbeat used the payload id and wrote a uuid row. Every
 * session therefore produced TWO rows -- claims filed under the `s-*` identity
 * whose heartbeat froze at session start, so 0 of 8,179 claims were ever owned
 * by a session that looked alive. Passing the payload id here is the fix.
 *
 * Generation stays only as a genuine last resort (a hook invoked with no payload
 * at all, e.g. a manual smoke test).
 */
export function resolveSessionId(payloadSessionId?: string | null): string {
  if (payloadSessionId) return payloadSessionId;
  if (process.env.COORDINATION_SESSION_ID) return process.env.COORDINATION_SESSION_ID;
  const fileId = readSessionId();
  if (fileId) return fileId;
  return generateSessionId();
}

/**
 * A stable project key for coordination rows.
 *
 * Two problems, both measured rather than assumed:
 *
 *  1. SPELLING. CLAUDE_PROJECT_DIR is injected into hook processes in BACKSLASH
 *     form while process.cwd() yields forward slashes, so getProject() returned
 *     whichever happened to be populated. That put one repo under two keys --
 *     `C:/Users/.../continuous-claude` (2,173 claims) and
 *     `C:\Users\...\continuous-claude` (1,341). file_claims' PK is
 *     (file_path, project), so those are two blind namespaces. Seven repos were
 *     split this way, covering 5,737 of 8,179 rows.
 *
 *  2. WORKTREES. A linked worktree has its own cwd, so worktrees of one repo
 *     would never see each other's claims. `git rev-parse --git-common-dir`
 *     returns the MAIN repo's .git from inside any worktree -- verified
 *     byte-identical from both trees under ordinal comparison, and it normalizes
 *     8.3 short paths (fed C:\Users\DAVID~1.HAY\CONTIN~2, got the long form).
 *     --show-toplevel is NOT usable: it returns the worktree path, which is the
 *     distinction we are trying to erase.
 *
 * Cost note: this shells out to git. That is deliberate and cheap in context --
 * every caller here is already about to run a Python subprocess through
 * runPgQuery (3s timeout), next to which a ~50ms git call is noise. No cache, so
 * no cache-invalidation bug.
 *
 * Falls back to a normalized CLAUDE_PROJECT_DIR/cwd when git is unavailable or
 * the directory is not a repo, so a non-git project still gets a consistent key.
 */
export function canonicalProject(cwd?: string): string {
  const base = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: base,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      return normalizeProjectKey(out.replace(/\/?\.git\/?$/, ''));
    }
  } catch {
    // Not a repo, git missing, or timeout -- fall through to the path form.
  }

  return normalizeProjectKey(base);
}

/**
 * Collapse the incidental differences that made one path into several keys:
 * backslashes vs forward slashes, drive-letter case, and a trailing separator.
 * Lowercased because Windows paths are case-insensitive, so `C:\Users` and
 * `c:\users` address the same directory and must not be two rows.
 */
export function normalizeProjectKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
