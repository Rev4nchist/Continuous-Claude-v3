#!/usr/bin/env node
/**
 * Session Start Recovery Hook
 *
 * Checks ~/.claude/recovery/ for archived workflow state from crashed sessions.
 * If found, injects a recovery prompt so the user can choose to resume.
 *
 * Recovery files older than 24 hours are cleaned up automatically.
 *
 * Runs on SessionStart.
 */

import { readFileSync, readdirSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './shared/logger.js';
import { readRalphUnifiedState } from './shared/state-schema.js';

const log = createLogger('session-start-recovery');

const RECOVERY_DIR = join(homedir(), '.claude', 'recovery');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface RecoveryFile {
  baseName: string;
  sessionId?: string;
  archivedAt: number;
  archivedAtISO: string;
  state: Record<string, unknown>;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

function getRecoveryFiles(): Array<{ path: string; data: RecoveryFile }> {
  if (!existsSync(RECOVERY_DIR)) return [];

  const files: Array<{ path: string; data: RecoveryFile }> = [];

  try {
    const entries = readdirSync(RECOVERY_DIR).filter(f => f.endsWith('.json'));

    for (const entry of entries) {
      const fullPath = join(RECOVERY_DIR, entry);
      try {
        const stat = statSync(fullPath);
        const ageMs = Date.now() - stat.mtimeMs;

        // Clean up old recovery files
        if (ageMs > MAX_AGE_MS) {
          unlinkSync(fullPath);
          log.info('Cleaned up stale recovery file', { file: entry, ageHours: (ageMs / 3600000).toFixed(1) });
          continue;
        }

        const content = readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(content) as RecoveryFile;
        files.push({ path: fullPath, data });
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory read failed
  }

  return files;
}

function formatRecoveryPrompt(files: Array<{ path: string; data: RecoveryFile }>): string {
  const lines: string[] = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔄 WORKFLOW RECOVERY AVAILABLE',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'Found incomplete workflow(s) from a previous session:',
    '',
  ];

  for (const { data } of files) {
    const type = data.baseName === 'ralph-state' ? 'Ralph' : 'Maestro';
    const ago = ((Date.now() - data.archivedAt) / 60000).toFixed(0);
    const storyId = (data.state as any).storyId || 'unknown';
    const taskType = (data.state as any).taskType || '';

    lines.push(`  **${type}** workflow`);
    if (storyId !== 'unknown') lines.push(`  Story: ${storyId}`);
    if (taskType) lines.push(`  Type: ${taskType}`);
    lines.push(`  Archived: ${ago} minutes ago`);
    lines.push('');
  }

  lines.push('**Options:**');
  lines.push('  - Say "resume workflow" to restore and continue');
  lines.push('  - Say "discard recovery" to clear and start fresh');
  lines.push('  - Or just start a new task (recovery files expire after 24h)');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return lines.join('\n');
}

async function main() {
  readStdin(); // Consume stdin

  const recoveryFiles = getRecoveryFiles();

  // Also check unified Ralph state for incomplete work
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const unified = readRalphUnifiedState(projectDir);
  let unifiedRecoveryInfo = '';

  if (unified?.session?.active) {
    const tasks = Array.isArray(unified.tasks) ? unified.tasks : Object.values(unified.tasks || {});
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: any) => t.status === 'complete' || t.status === 'completed').length;
    const checkpoints = unified.checkpoints || [];
    const lastCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

    // Guard is load-bearing: ralph-state-v2.py owns clearing session.active on
    // completion but may lag, so this prevents a completed-but-active state file
    // from surfacing a false "WORKFLOW RECOVERY" banner.
    if (totalTasks > 0 && completedTasks < totalTasks) {
      unifiedRecoveryInfo = [
        `  **Ralph** workflow (unified state)`,
        `  Story: ${unified.story_id}`,
        `  Progress: ${completedTasks}/${totalTasks} tasks`,
        lastCheckpoint ? `  Last checkpoint: ${(lastCheckpoint as any).timestamp || 'unknown'}` : '',
        '',
      ].filter(Boolean).join('\n');
    }
  }

  if (recoveryFiles.length === 0 && !unifiedRecoveryInfo) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  log.info(`Found ${recoveryFiles.length} recovery file(s)`, {
    files: recoveryFiles.map(f => f.data.baseName),
  });

  let message = formatRecoveryPrompt(recoveryFiles);
  if (unifiedRecoveryInfo) {
    // If no legacy recovery but we have unified info, create the prompt
    if (recoveryFiles.length === 0) {
      message = [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '🔄 WORKFLOW RECOVERY AVAILABLE',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        'Found incomplete workflow from a previous session:',
        '',
        unifiedRecoveryInfo,
        '**Options:**',
        '  - Say "resume workflow" to restore and continue',
        '  - Say "discard recovery" to clear and start fresh',
        '  - Or just start a new task (recovery files expire after 24h)',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      ].join('\n');
    } else {
      // Append unified info to existing recovery prompt
      message = message.replace('**Options:**', unifiedRecoveryInfo + '\n**Options:**');
    }
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } }));
}

main().catch(() => {
  console.log(JSON.stringify({ result: 'continue' }));
});
