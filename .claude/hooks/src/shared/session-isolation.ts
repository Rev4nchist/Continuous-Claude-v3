/**
 * Session Isolation Utilities
 *
 * Provides session-specific state file paths to prevent cross-terminal
 * collisions when multiple Claude sessions are active.
 *
 * Session ID detection priority:
 * 1. Passed explicitly to functions
 * 2. CLAUDE_SESSION_ID environment variable
 * 3. Process PID as fallback (stable within a session)
 */

import { tmpdir, hostname } from 'os';
import { join, basename } from 'path';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';

/**
 * Get a unique session identifier.
 *
 * Uses CLAUDE_SESSION_ID if available, otherwise generates one from
 * hostname + PID for stability within a single Claude process.
 */
export function getSessionId(): string {
  // Check environment variable first (set by Claude Code)
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  // Fallback: hostname + PID
  // This ensures different terminals get different IDs
  const host = hostname().replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);
  return `${host}-${process.pid}`;
}

/**
 * Get session-specific state file path.
 *
 * @param baseName - The base name of the state file (e.g., "ralph-state")
 * @param sessionId - Optional session ID override
 * @returns Full path to the session-specific state file
 */
export function getSessionStatePath(baseName: string, sessionId?: string): string {
  const sid = sessionId || getSessionId();
  // Sanitize session ID for filename safety
  const safeSid = sid.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 32);
  return join(tmpdir(), `claude-${baseName}-${safeSid}.json`);
}

/**
 * Legacy state file path (without session isolation).
 * Used for backwards compatibility and migration.
 */
export function getLegacyStatePath(baseName: string): string {
  return join(tmpdir(), `claude-${baseName}.json`);
}

/**
 * Get state file path with automatic migration from legacy.
 *
 * If a legacy state file exists and no session-specific file exists,
 * returns the legacy path so existing sessions can continue.
 * New sessions will create session-specific files.
 */
export function getStatePathWithMigration(baseName: string, sessionId?: string): string {
  const sessionPath = getSessionStatePath(baseName, sessionId);
  const legacyPath = getLegacyStatePath(baseName);

  // If session-specific file exists, use it
  if (existsSync(sessionPath)) {
    return sessionPath;
  }

  // If legacy file exists and was modified recently (< 1 hour),
  // use legacy to maintain continuity for running sessions
  if (existsSync(legacyPath)) {
    try {
      const stat = statSync(legacyPath);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (stat.mtimeMs > oneHourAgo) {
        return legacyPath;
      }
    } catch {
      // Fall through to session path
    }
  }

  // Use session-specific path for new sessions
  return sessionPath;
}

/**
 * Get project-scoped state file path.
 *
 * Phase 4 (cross-project isolation): some hook state must NOT bleed across
 * projects even when the sessionId is shared. Filename layout:
 *
 *   $TEMP/claude-<baseName>-<projectId>-<sessionId>.json
 *
 * @param baseName  - State family name (e.g. "plan-approved")
 * @param projectId - 16-char sha256(absPath) (use shared/project-id.ts)
 * @param sessionId - Optional session ID (default: getSessionId())
 */
export function getProjectScopedStatePath(
  baseName: string,
  projectId: string,
  sessionId?: string,
): string {
  const sid = sessionId || getSessionId();
  const safeSid = sid.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 32);
  const safePid = projectId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
  return join(tmpdir(), `claude-${baseName}-${safePid}-${safeSid}.json`);
}

/**
 * Project-aware variant of getStatePathWithMigration.
 *
 * Falls back through:
 *   1. project-scoped path (if it exists)
 *   2. legacy session-only path within 1 hour (continuity)
 *   3. project-scoped path (new sessions)
 */
export function getProjectScopedStatePathWithMigration(
  baseName: string,
  projectId: string,
  sessionId?: string,
): string {
  const scoped = getProjectScopedStatePath(baseName, projectId, sessionId);
  const legacySession = getSessionStatePath(baseName, sessionId);

  if (existsSync(scoped)) return scoped;

  // Continuity: a session-only state file written by an older build of the
  // hook within the last hour is still honored, but only for the SAME
  // session. This avoids stale state surviving across project switches.
  if (existsSync(legacySession)) {
    try {
      const stat = statSync(legacySession);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      if (stat.mtimeMs > oneHourAgo) return legacySession;
    } catch {
      // fall through
    }
  }

  return scoped;
}

/**
 * Clean up old state files.
 *
 * Removes state files older than maxAge (default 24 hours).
 * Call this periodically to prevent temp directory bloat.
 */
export function cleanupOldStateFiles(baseName: string, maxAgeMs = 24 * 60 * 60 * 1000): number {
  const tmpDir = tmpdir();
  const pattern = new RegExp(`^claude-${baseName}-.*\\.json$`);
  let cleaned = 0;

  try {
    const files = readdirSync(tmpDir);
    const now = Date.now();

    for (const file of files) {
      if (!pattern.test(file)) continue;

      const fullPath = join(tmpDir, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
  } catch {
    // Ignore errors reading temp dir
  }

  return cleaned;
}

/**
 * List all active sessions based on state files.
 *
 * Returns session IDs that have state files modified within the TTL.
 */
export function listActiveSessions(baseName: string, ttlMs = 4 * 60 * 60 * 1000): string[] {
  const tmpDir = tmpdir();
  const pattern = new RegExp(`^claude-${baseName}-(.*)\\.json$`);
  const sessions: string[] = [];

  try {
    const files = readdirSync(tmpDir);
    const now = Date.now();

    for (const file of files) {
      const match = file.match(pattern);
      if (!match) continue;

      const fullPath = join(tmpDir, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs < ttlMs) {
          sessions.push(match[1]);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Ignore errors reading temp dir
  }

  return sessions;
}

/**
 * Check if another session is active (for conflict detection).
 */
export function hasOtherActiveSessions(baseName: string, currentSessionId?: string): boolean {
  const current = currentSessionId || getSessionId();
  const active = listActiveSessions(baseName);
  return active.some(sid => sid !== current);
}
