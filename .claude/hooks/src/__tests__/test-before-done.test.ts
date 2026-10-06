/**
 * Tests for test-before-done PreToolUse hook.
 *
 * This hook fires on TaskUpdate. When status is being set to 'completed',
 * it checks for recent test executions via a state file:
 *
 *   State file: $TEMP/claude-recent-test-runs-<sessionId>.json
 *   Content:    { "lastTestRun": <epoch ms>, "command": "<cmd>" }
 *
 * Behavior:
 * - If no recent test run (>5 min or no state file), returns advisory warning
 * - If recent test run found (<5 min), returns empty {}
 * - Non-completion TaskUpdate calls pass through silently
 * - Advisory only (hookSpecificOutput.additionalContext), NOT blocking (no permissionDecision: deny)
 * - Fails open: any error -> output {}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

import {
  shouldWarn,
  hasRecentTestRun,
  buildWarningOutput,
  handleTaskUpdate,
} from '../test-before-done.js';
import { getStateFile } from '../shared/test-run-state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SESSION = 'test-before-done-session';
const TEST_SESSION_B = 'test-before-done-session-b';

/** getStateFile is null only without a session id; every id in this file is real. */
const stateFile = (id: string): string => getStateFile(id)!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTestState(sessionId: string, lastTestRun: number, command = 'uv run pytest'): void {
  const statePath = stateFile(sessionId);
  fs.writeFileSync(statePath, JSON.stringify({ lastTestRun, command }), 'utf-8');
}

function cleanupStateFiles(): void {
  for (const sid of [TEST_SESSION, TEST_SESSION_B]) {
    const statePath = stateFile(sid);
    try {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(statePath + '.lock')) fs.unlinkSync(statePath + '.lock');
    } catch { /* ignore */ }
  }
}

beforeEach(() => {
  cleanupStateFiles();
});

afterEach(() => {
  cleanupStateFiles();
});

// =============================================================================
// Test 1: shouldWarn -- only TaskUpdate with status=completed should trigger
// =============================================================================

describe('shouldWarn', () => {
  it('returns true for TaskUpdate with status completed', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'completed' },
    };
    expect(shouldWarn(input)).toBe(true);
  });

  it('returns false for TaskUpdate with status in_progress', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'in_progress' },
    };
    expect(shouldWarn(input)).toBe(false);
  });

  it('returns false for TaskUpdate with status pending', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'pending' },
    };
    expect(shouldWarn(input)).toBe(false);
  });

  it('returns false for non-TaskUpdate tools', () => {
    const tools = ['Bash', 'Read', 'Write', 'Task', 'TaskCreate', 'TaskList'];
    for (const tool of tools) {
      const input = {
        session_id: TEST_SESSION,
        tool_name: tool,
        tool_input: { status: 'completed' },
      };
      expect(shouldWarn(input)).toBe(false);
    }
  });

  it('returns false when tool_input is missing', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
    };
    expect(shouldWarn(input as any)).toBe(false);
  });

  it('returns false when tool_input.status is missing', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { task_id: '123' },
    };
    expect(shouldWarn(input)).toBe(false);
  });

  it('returns false for null input', () => {
    expect(shouldWarn(null as any)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(shouldWarn(undefined as any)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(shouldWarn({} as any)).toBe(false);
  });
});

// =============================================================================
// Test 2: hasRecentTestRun -- check state file for recent test execution
// =============================================================================

describe('hasRecentTestRun', () => {
  it('returns false when no state file exists', () => {
    expect(hasRecentTestRun(TEST_SESSION)).toBe(false);
  });

  it('returns true when test ran less than 5 minutes ago', () => {
    writeTestState(TEST_SESSION, Date.now() - 60_000); // 1 minute ago
    expect(hasRecentTestRun(TEST_SESSION)).toBe(true);
  });

  it('returns true when test ran exactly now', () => {
    writeTestState(TEST_SESSION, Date.now());
    expect(hasRecentTestRun(TEST_SESSION)).toBe(true);
  });

  it('returns false when test ran more than 5 minutes ago', () => {
    writeTestState(TEST_SESSION, Date.now() - 600_000); // 10 minutes ago
    expect(hasRecentTestRun(TEST_SESSION)).toBe(false);
  });

  it('returns false when state file has lastTestRun of 0', () => {
    writeTestState(TEST_SESSION, 0);
    expect(hasRecentTestRun(TEST_SESSION)).toBe(false);
  });

  it('returns false when state file contains invalid JSON', () => {
    const statePath = stateFile(TEST_SESSION);
    fs.writeFileSync(statePath, 'not-json', 'utf-8');
    expect(hasRecentTestRun(TEST_SESSION)).toBe(false);
  });

  it('returns false when state file is empty', () => {
    const statePath = stateFile(TEST_SESSION);
    fs.writeFileSync(statePath, '', 'utf-8');
    expect(hasRecentTestRun(TEST_SESSION)).toBe(false);
  });

  it('session isolation -- session A state does not affect session B', () => {
    writeTestState(TEST_SESSION, Date.now()); // recent for A
    expect(hasRecentTestRun(TEST_SESSION)).toBe(true);
    expect(hasRecentTestRun(TEST_SESSION_B)).toBe(false);
  });
});

// =============================================================================
// Test 3: buildWarningOutput -- advisory message format
// =============================================================================

describe('buildWarningOutput', () => {
  it('returns hookSpecificOutput.additionalContext and no values key', () => {
    const output = buildWarningOutput() as any;
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(typeof output.hookSpecificOutput.additionalContext).toBe('string');
    expect(output).not.toHaveProperty('values');
  });

  it('warning message mentions test execution', () => {
    const output = buildWarningOutput();
    expect(output.hookSpecificOutput.additionalContext.toLowerCase()).toContain('test');
  });

  it('warning message names the verify entry point', () => {
    const output = buildWarningOutput();
    expect(output.hookSpecificOutput.additionalContext).toContain('verify.mjs');
  });

  it('does NOT contain permissionDecision (advisory only)', () => {
    const output = buildWarningOutput();
    const json = JSON.stringify(output);
    expect(json).not.toContain('permissionDecision');
  });
});

// =============================================================================
// Test 4: handleTaskUpdate -- integration of shouldWarn + hasRecentTestRun
// =============================================================================

describe('handleTaskUpdate', () => {
  it('returns warning when completing without recent test', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'completed' },
    };
    const result = handleTaskUpdate(input);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('hookSpecificOutput');
    expect(result!.hookSpecificOutput).toHaveProperty('additionalContext');
  });

  it('returns null (no warning) when completing WITH recent test', () => {
    writeTestState(TEST_SESSION, Date.now() - 30_000); // 30 seconds ago
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'completed' },
    };
    const result = handleTaskUpdate(input);
    expect(result).toBeNull();
  });

  it('returns null for non-completion updates', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'in_progress' },
    };
    const result = handleTaskUpdate(input);
    expect(result).toBeNull();
  });

  it('returns null for non-TaskUpdate tools', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = handleTaskUpdate(input);
    expect(result).toBeNull();
  });

  it('does not crash on null input', () => {
    expect(() => handleTaskUpdate(null as any)).not.toThrow();
    expect(handleTaskUpdate(null as any)).toBeNull();
  });

  it('does not crash on undefined input', () => {
    expect(() => handleTaskUpdate(undefined as any)).not.toThrow();
    expect(handleTaskUpdate(undefined as any)).toBeNull();
  });

  it('does not crash on empty object', () => {
    expect(() => handleTaskUpdate({} as any)).not.toThrow();
    expect(handleTaskUpdate({} as any)).toBeNull();
  });

  it('uses session_id from input for state file lookup', () => {
    // Write recent test for session A but not B
    writeTestState(TEST_SESSION, Date.now());

    const inputA = {
      session_id: TEST_SESSION,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'completed' },
    };
    const inputB = {
      session_id: TEST_SESSION_B,
      tool_name: 'TaskUpdate',
      tool_input: { status: 'completed' },
    };

    // Session A should pass (has recent test)
    expect(handleTaskUpdate(inputA)).toBeNull();
    // Session B should warn (no recent test)
    expect(handleTaskUpdate(inputB)).not.toBeNull();
  });
});
