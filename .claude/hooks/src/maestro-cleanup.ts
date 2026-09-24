#!/usr/bin/env node
/**
 * Maestro Cleanup Hook (SessionEnd)
 *
 * Cleans up Maestro state files when a session ends.
 * Before deleting, archives incomplete workflows to ~/.claude/recovery/
 * so the next session can offer to resume.
 */

import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getStatePathWithMigration, cleanupOldStateFiles } from './shared/session-isolation.js';
import { createLogger } from './shared/logger.js';

const log = createLogger('maestro-cleanup');

interface SessionEndInput {
  session_id?: string;
}

const STATE_FILES = ['maestro-state'];
const RECOVERY_DIR = join(homedir(), '.claude', 'recovery');

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

function ensureRecoveryDir(): void {
  if (!existsSync(RECOVERY_DIR)) {
    mkdirSync(RECOVERY_DIR, { recursive: true });
  }
}

/**
 * Check if state represents an incomplete (in-progress) workflow.
 */
function isIncompleteWorkflow(content: string, baseName: string): boolean {
  try {
    const state = JSON.parse(content);
    if (!state.active) return false;

    if (baseName === 'maestro-state') {
      // Maestro is active but not fully completed (plan not approved or still executing)
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Archive state to recovery directory before deletion.
 */
function archiveState(baseName: string, content: string, sessionId?: string): void {
  try {
    ensureRecoveryDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${baseName}-${timestamp}.json`;
    const archivePath = join(RECOVERY_DIR, filename);

    // Wrap with metadata
    const archive = {
      baseName,
      sessionId,
      archivedAt: Date.now(),
      archivedAtISO: new Date().toISOString(),
      state: JSON.parse(content),
    };

    writeFileSync(archivePath, JSON.stringify(archive, null, 2));
    log.info(`Archived incomplete ${baseName} for recovery`, { archivePath, sessionId });
  } catch (err) {
    log.error(`Failed to archive ${baseName}`, { error: String(err), sessionId });
  }
}

function cleanupStateFile(baseName: string, sessionId?: string): boolean {
  try {
    const stateFile = getStatePathWithMigration(baseName, sessionId);
    if (existsSync(stateFile)) {
      // Read before deleting to check if we should archive
      try {
        const content = readFileSync(stateFile, 'utf-8');
        if (isIncompleteWorkflow(content, baseName)) {
          archiveState(baseName, content, sessionId);
        }
      } catch {
        // If we can't read, just delete
      }

      unlinkSync(stateFile);
      return true;
    }
  } catch {
    // Ignore cleanup errors
  }
  return false;
}

async function main() {
  let input: SessionEndInput = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
    // Continue with empty input
  }

  const sessionId = input.session_id;
  const cleaned: string[] = [];

  // Clean up state files for this session (with archival)
  for (const baseName of STATE_FILES) {
    if (cleanupStateFile(baseName, sessionId)) {
      cleaned.push(baseName);
    }
  }

  // Also clean up any stale state files older than 24 hours
  for (const baseName of STATE_FILES) {
    cleanupOldStateFiles(baseName, 24 * 60 * 60 * 1000);
  }

  // Output result
  if (cleaned.length > 0) {
    log.info(`Session cleanup: ${cleaned.join(', ')}`, { sessionId });
    console.log(JSON.stringify({
      result: 'continue',
      message: `Cleaned up state: ${cleaned.join(', ')}`
    }));
  } else {
    console.log(JSON.stringify({ result: 'continue' }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ result: 'continue' }));
});
