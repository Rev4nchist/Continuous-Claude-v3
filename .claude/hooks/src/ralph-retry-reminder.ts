#!/usr/bin/env node
/**
 * Ralph Retry Reminder Hook
 *
 * UserPromptSubmit hook that checks for pending retries in the retry queue.
 * If found, injects a reminder so Ralph knows to process them.
 *
 * Escalation strategy (per task):
 *   Attempt 1: Same agent + error context
 *   Attempt 2: spark (quick fix)
 *   Attempt 3: debug-agent (root cause)
 *   After 3: Mark blocked, escalate to user
 *
 * Runs on UserPromptSubmit
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createLogger } from './shared/logger.js';
import { readRalphUnifiedState } from './shared/state-schema.js';

const log = createLogger('ralph-retry-reminder');

interface HookInput {
  session_id?: string;
  prompt?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

function getEscalationAgent(retries: number, originalAgent: string): string {
  if (retries === 0) return originalAgent || 'spark';
  if (retries === 1) return 'spark';
  if (retries === 2) return 'debug-agent';
  return 'ESCALATE'; // After 3 retries, escalate to user
}

async function main() {
  let input: HookInput = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
    // Continue
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Check if Ralph is active with unified state
  const unified = readRalphUnifiedState(projectDir);
  if (!unified?.session?.active) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Check retry queue
  const retryQueue = unified.retry_queue || [];
  if (retryQueue.length === 0) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  log.info(`Found ${retryQueue.length} item(s) in retry queue`, {
    storyId: unified.story_id,
    sessionId: input.session_id,
  });

  const lines: string[] = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔄 RETRY QUEUE — Action Required',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  for (const entry of retryQueue as any[]) {
    const taskId = entry.task_id || '?';
    const taskName = entry.task_name || '';
    const retries = entry.attempt || 0;
    const lastError = entry.last_error || 'unknown';
    const escalationAgent = getEscalationAgent(retries, entry.original_agent);

    if (escalationAgent === 'ESCALATE') {
      lines.push(`  **Task ${taskId}** (${taskName}) — ESCALATE TO USER`);
      lines.push(`    3 retries exhausted. Last error: ${lastError}`);
      lines.push(`    Action: Review manually, fix the root cause, then retry`);
      lines.push('');
    } else {
      lines.push(`  **Task ${taskId}** (${taskName}) — retry #${retries + 1}`);
      lines.push(`    Last error: ${lastError}`);
      lines.push(`    Suggested agent: **${escalationAgent}**`);
      lines.push('');
    }
  }

  lines.push('**Actions:**');
  lines.push('  - Pop and retry: `python ~/.claude/scripts/ralph/ralph-state-v2.py -p . retry-pop`');
  lines.push('  - Skip/discard: manually remove from state');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const message = lines.join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } }));
}

main().catch(() => {
  console.log(JSON.stringify({ result: 'continue' }));
});
