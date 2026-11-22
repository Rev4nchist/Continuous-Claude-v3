#!/usr/bin/env node
/**
 * Test Before Done Hook
 *
 * PreToolUse hook on TaskUpdate. When a task is being marked 'completed',
 * asks shared/done-proof.ts `judge` whether the change has proof (the same judge as
 * commit-preflight). No proof: injects an advisory warning as
 * hookSpecificOutput.additionalContext (NOT blocking).
 *
 * State file: $TEMP/claude-recent-test-runs-<sessionId>.json
 * Content:    { "lastTestRun": <epoch ms>, "command": "<cmd>", "ok": true|false|null }
 *
 * The state file is written by companion PostToolUse hooks that track
 * Bash commands containing test-related patterns (pytest, vitest, jest, etc).
 *
 * Advisory only -- hookSpecificOutput.additionalContext, no permissionDecision.
 * Fails open: any error -> output {}.
 */

import { readFileSync } from 'fs';
import { judge, latestSidecar, readTestRun, runProves } from './shared/done-proof.js';
import { resolveHead } from './shared/git-head.js';
import { createLogger } from './shared/logger.js';

const log = createLogger('test-before-done');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
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
 * True when the session's last test run counts as proof: within 5 minutes, not a ratchet, not
 * failed (shared/done-proof.ts runProves). Reads the state file; fails open to false.
 *
 * Not used by the hook itself any more (handleTaskUpdate asks `judge`). Kept as the public
 * reader that test-before-done.test.ts and test-run-tracker.test.ts pin: the tracker/reader
 * state-path contract.
 */
export function hasRecentTestRun(sessionId: string | undefined): boolean {
  return runProves(readTestRun(sessionId), Date.now());
}

/**
 * Build the advisory warning output (additionalContext injection).
 * Does NOT use permissionDecision -- purely advisory.
 */
export function buildWarningOutput(message?: string): WarningOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        message ??
        'WARNING: no test run detected in the last 5 minutes before this task was marked complete. ' +
        'Run the project check (node ~/.claude/scripts/verify.mjs, or the row of the project testing rules: AGENTS.md "Testing" or docs/testing-standard.md) and cite its output.',
    },
  };
}

/**
 * Main handler: checks if we should warn, then asks the same judge as commit-preflight.
 * Returns the warning output if needed, or null if no warning.
 *
 * A TaskUpdate has no repo of its own, so the repo is the payload cwd (else the process cwd) and
 * hasE2e is true: this hook has always warned when no test ran, and keeps doing so.
 */
export function handleTaskUpdate(input: any): WarningOutput | null {
  try {
    if (!shouldWarn(input)) return null;

    const sessionId = input.session_id;
    const head = resolveHead(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
    const verdict = judge({
      run: readTestRun(sessionId),
      sidecar: head ? latestSidecar(head.repoRoot) : null,
      head: head?.sha ?? null,
      hasE2e: true,
      now: Date.now(),
    });
    if (verdict.kind === 'proven') return null;

    log.info('No proof of a working change on task completion', { sessionId, verdict: verdict.kind });
    return verdict.kind === 'none' ? buildWarningOutput() : buildWarningOutput(`WARNING: ${verdict.message}`);
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
