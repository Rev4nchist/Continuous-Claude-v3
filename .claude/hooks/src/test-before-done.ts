#!/usr/bin/env node
/**
 * Test Before Done Hook
 *
 * PreToolUse hook on TaskUpdate. When a task is being marked 'completed',
 * checks if a test command was run recently. If not, injects an advisory
 * warning as hookSpecificOutput.additionalContext (NOT blocking).
 *
 * State file: $TEMP/claude-recent-test-runs-<sessionId>.json
 * Content:    { "lastTestRun": <epoch ms>, "command": "<cmd>" }
 *
 * The state file is written by companion PostToolUse hooks that track
 * Bash commands containing test-related patterns (pytest, vitest, jest, etc).
 *
 * Advisory only -- hookSpecificOutput.additionalContext, no permissionDecision.
 * Fails open: any error -> output {}.
 */

import { readFileSync, existsSync } from 'fs';
import { createLogger } from './shared/logger.js';
import { getStateFile } from './shared/test-run-state.js';

const log = createLogger('test-before-done');

// 5 minutes threshold for "recent" test run
const RECENT_TEST_THRESHOLD_MS = 300_000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface HookInput {
  session_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface TestRunState {
  lastTestRun: number;
  command?: string;
}

interface WarningOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    additionalContext: string;
  };
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns true when the input is a TaskUpdate setting status to 'completed'.
 */
export function shouldWarn(input: any): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.tool_name !== 'TaskUpdate') return false;
  if (!input.tool_input || typeof input.tool_input !== 'object') return false;
  return input.tool_input.status === 'completed';
}

/**
 * Check if a test command ran recently for the given session.
 * Reads the state file and checks if lastTestRun is within threshold.
 */
export function hasRecentTestRun(sessionId: string | undefined): boolean {
  try {
    const statePath = getStateFile(sessionId);

    // No session id: no state file, so the advisory shows.
    if (!statePath || !existsSync(statePath)) return false;

    const raw = readFileSync(statePath, 'utf-8');
    if (!raw.trim()) return false;

    const state: TestRunState = JSON.parse(raw);
    if (!state.lastTestRun || typeof state.lastTestRun !== 'number') return false;

    const elapsed = Date.now() - state.lastTestRun;
    return elapsed < RECENT_TEST_THRESHOLD_MS;
  } catch {
    // Fail open -- treat as no recent test
    return false;
  }
}

/**
 * Build the advisory warning output (additionalContext injection).
 * Does NOT use permissionDecision -- purely advisory.
 */
export function buildWarningOutput(): WarningOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        'WARNING: no test run detected in the last 5 minutes before this task was marked complete. ' +
        'Run the project check (node ~/.claude/scripts/verify.mjs, or the AGENTS.md Testing row) and cite its output.',
    },
  };
}

/**
 * Main handler: checks if we should warn, then checks for recent tests.
 * Returns the warning output if needed, or null if no warning.
 */
export function handleTaskUpdate(input: any): WarningOutput | null {
  try {
    if (!shouldWarn(input)) return null;

    const sessionId = input.session_id;
    if (hasRecentTestRun(sessionId)) return null;

    log.info('No recent test run detected on task completion', { sessionId });
    return buildWarningOutput();
  } catch (err) {
    log.error('handleTaskUpdate failed', { error: String(err) });
    // Fail open
    return null;
  }
}

// ---------------------------------------------------------------------------
// main() entry point
// ---------------------------------------------------------------------------

function main(): void {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) {
      console.log(JSON.stringify({}));
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({}));
      return;
    }

    const result = handleTaskUpdate(input);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    // Fail open
    console.log(JSON.stringify({}));
  }
}

// Guard: don't run main() when imported by vitest
if (!process.env.VITEST) {
  main();
}
