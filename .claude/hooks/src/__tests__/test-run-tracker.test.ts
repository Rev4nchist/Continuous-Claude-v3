/**
 * Tests for test-run-tracker PostToolUse hook.
 *
 * This hook fires on PostToolUse for Bash. It detects test commands
 * (vitest, jest, pytest, npm test, etc.) and records the timestamp
 * to a state file that test-before-done reads.
 *
 * State file: $TEMP/claude-recent-test-runs-<sessionId>.json
 * Content:    { "lastTestRun": <epoch ms>, "command": "<cmd>" }
 *
 * Behavior:
 * - Detects test commands via regex patterns
 * - Writes state file with timestamp and command
 * - Ignores non-Bash tool calls
 * - Ignores non-test Bash commands
 * - Fails open: any error -> output {}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { TEST_PATTERNS, getStateFile, main } from '../test-run-tracker.js';
import { hasRecentTestRun, handleTaskUpdate } from '../test-before-done.js';
import { PassThrough } from 'stream';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SESSION = 'test-run-tracker-session';
const TEST_SESSION_B = 'test-run-tracker-session-b';

/** getStateFile is null only without a session id; the tests that use this helper pass real ids. */
const stateFile = (id: string): string => getStateFile(id)!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTestState(sessionId: string, lastTestRun: number, command = 'npm test'): void {
  const statePath = stateFile(sessionId);
  fs.writeFileSync(statePath, JSON.stringify({ lastTestRun, command }), 'utf-8');
}

function cleanupStateFiles(): void {
  for (const sid of [TEST_SESSION, TEST_SESSION_B]) {
    const statePath = stateFile(sid);
    try {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
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
// Test 1: TEST_PATTERNS -- regex pattern matching
// =============================================================================

describe('TEST_PATTERNS', () => {
  it('detects vitest command', () => {
    const cmd = 'npx vitest run';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects jest command', () => {
    const cmd = 'npx jest --coverage';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects pytest command', () => {
    const cmd = 'uv run pytest tests/';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects npm test command', () => {
    const cmd = 'npm test';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects npm run test command', () => {
    const cmd = 'npm run test';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects cargo test command', () => {
    const cmd = 'cargo test --release';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('detects go test command', () => {
    const cmd = 'go test ./...';
    const match = TEST_PATTERNS.some(p => p.test(cmd));
    expect(match).toBe(true);
  });

  it('ignores non-test Bash commands', () => {
    const cmds = ['git status', 'ls -la', 'echo hello', 'cat file.ts', 'npm install'];
    for (const cmd of cmds) {
      const match = TEST_PATTERNS.some(p => p.test(cmd));
      expect(match).toBe(false);
    }
  });
});

// =============================================================================
// Test 2: getStateFile -- state file path generation
// =============================================================================

describe('getStateFile', () => {
  it('returns path in tmpdir with session ID', () => {
    const result = stateFile(TEST_SESSION);
    expect(result).toContain(os.tmpdir());
    expect(result).toContain(TEST_SESSION);
    expect(result).toContain('claude-recent-test-runs-');
  });

  it('produces different paths for different sessions', () => {
    const pathA = stateFile(TEST_SESSION);
    const pathB = stateFile(TEST_SESSION_B);
    expect(pathA).not.toBe(pathB);
  });

  it('handles default session ID', () => {
    const result = stateFile('default');
    expect(result).toContain('claude-recent-test-runs-default');
  });
});

// =============================================================================
// Test 3: Session isolation
// =============================================================================

describe('session isolation', () => {
  it('session A state does not affect session B', () => {
    // Write state for session A
    writeTestState(TEST_SESSION, Date.now(), 'npm test');

    // Session A state file exists
    expect(fs.existsSync(stateFile(TEST_SESSION))).toBe(true);

    // Session B state file does not exist
    expect(fs.existsSync(stateFile(TEST_SESSION_B))).toBe(false);
  });
});

// =============================================================================
// Test 4: State file content
// =============================================================================

describe('state file content', () => {
  it('writes valid JSON with lastTestRun and command', () => {
    const before = Date.now();
    writeTestState(TEST_SESSION, before, 'vitest run');
    const content = JSON.parse(fs.readFileSync(stateFile(TEST_SESSION), 'utf-8'));
    expect(content).toHaveProperty('lastTestRun', before);
    expect(content).toHaveProperty('command', 'vitest run');
  });

  it('handles empty state file gracefully', () => {
    const statePath = stateFile(TEST_SESSION);
    fs.writeFileSync(statePath, '', 'utf-8');
    expect(() => {
      try { JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* expected */ }
    }).not.toThrow();
  });

  it('handles malformed JSON gracefully', () => {
    const statePath = stateFile(TEST_SESSION);
    fs.writeFileSync(statePath, 'not-json{{{', 'utf-8');
    expect(() => {
      try { JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* expected */ }
    }).not.toThrow();
  });
});

// =============================================================================
// Test 5: Integration -- main() end-to-end
// =============================================================================

describe('main() integration', () => {
  let originalStdin: typeof process.stdin;

  beforeEach(() => {
    originalStdin = process.stdin;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
  });

  it('writes state file when given a test command via stdin', async () => {
    const input = JSON.stringify({
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    const mockStdin = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

    const mainPromise = main();
    mockStdin.end(input);
    await mainPromise;

    const statePath = stateFile(TEST_SESSION);
    expect(fs.existsSync(statePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(content).toHaveProperty('lastTestRun');
    expect(content).toHaveProperty('command', 'npm test');
    expect(typeof content.lastTestRun).toBe('number');
  });

  it('does not write state file for non-test commands', async () => {
    const input = JSON.stringify({
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });

    const mockStdin = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

    const mainPromise = main();
    mockStdin.end(input);
    await mainPromise;

    const statePath = stateFile(TEST_SESSION);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('does not write state file for non-Bash tools', async () => {
    const input = JSON.stringify({
      session_id: TEST_SESSION,
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
    });

    const mockStdin = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

    const mainPromise = main();
    mockStdin.end(input);
    await mainPromise;

    const statePath = stateFile(TEST_SESSION);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

// =============================================================================
// Test 6: probes, ratchets and verify.mjs count as test runs (PR1a)
// =============================================================================

const isRun = (cmd: string) => TEST_PATTERNS.some(p => p.test(cmd));

describe('probe, ratchet and verify patterns', () => {
  it('counts a plain probe run', () => {
    expect(isRun('node scripts/rules/rule-router-probe.mjs')).toBe(true);
  });

  it('counts the exact form the template line gives', () => {
    expect(isRun('node ~/.claude/scripts/verify.mjs --project x')).toBe(true);
  });

  it('counts Windows backslash and quoted paths', () => {
    expect(isRun('node "C:\\Users\\x\\.claude\\scripts\\verify.mjs"')).toBe(true);
    expect(isRun('node .\\scripts\\skills\\audit-skills.mjs')).toBe(true);
  });

  it('counts a node flag before the path', () => {
    expect(isRun('node --no-warnings scripts/rules/rule-router-probe.mjs')).toBe(true);
  });

  it('does not count a file that is named but not run', () => {
    expect(isRun('git add .claude/scripts/verify.mjs')).toBe(false);
    expect(isRun('cat scripts/rules/context-budget-guard.mjs')).toBe(false);
    expect(isRun('node scripts/myverify.mjs')).toBe(false);
  });

  it('does not count a plan or a help call', () => {
    expect(isRun('node ~/.claude/scripts/verify.mjs --dry-run')).toBe(false);
    expect(isRun('node verify.mjs --help')).toBe(false);
  });

  it('does not count --dry-run or --help on the audit and budget scripts', () => {
    expect(isRun('node scripts/skills/audit-skills.mjs --help')).toBe(false);
    expect(isRun('node scripts/rules/context-budget-guard.mjs --dry-run')).toBe(false);
  });

  it('does not count a syntax check', () => {
    expect(isRun('node --check .claude/scripts/verify.mjs')).toBe(false);
    expect(isRun('node -c scripts/rules/rule-router-probe.mjs')).toBe(false);
    expect(isRun('node --no-warnings --check scripts/skills/audit-skills.mjs')).toBe(false);
  });

  it('counts node.exe', () => {
    expect(isRun('node.exe scripts/rules/rule-router-probe.mjs')).toBe(true);
  });

  it('does not count a command that only prints the node line', () => {
    expect(isRun('echo node scripts/verify.mjs')).toBe(false);
    expect(isRun('Write-Output "node scripts/rules/rule-router-probe.mjs"')).toBe(false);
  });

  it('counts node after a command separator, a call operator or at the start', () => {
    expect(isRun('cd x && node scripts/rules/rule-router-probe.mjs')).toBe(true);
    expect(isRun("$env:A='1'; node .claude/scripts/verify.mjs")).toBe(true);
    expect(isRun('& node scripts/skills/audit-skills.mjs')).toBe(true);
    expect(isRun('node ~/.claude/scripts/verify.mjs')).toBe(true);
    expect(isRun('cd x\nnode scripts/rules/rule-router-probe.mjs')).toBe(true);
  });
});

// =============================================================================
// Test 7: the reader finds the file the tracker writes for a 36-char id (bug repro)
// =============================================================================

describe('tracker and reader share one state path', () => {
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  afterEach(() => {
    try { fs.unlinkSync(stateFile(UUID)); } catch { /* ignore */ }
  });

  it('hasRecentTestRun is true after the tracker records a run for a UUID session', async () => {
    const mockStdin = new PassThrough();
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });
    try {
      const mainPromise = main();
      mockStdin.end(JSON.stringify({
        session_id: UUID,
        tool_name: 'PowerShell',
        tool_input: { command: 'node scripts/rules/rule-router-probe.mjs' },
      }));
      await mainPromise;
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, writable: true });
    }
    expect(hasRecentTestRun(UUID)).toBe(true);
  });
});

// =============================================================================
// Test 8: a missing session id has no state file, so no session can silence another
// =============================================================================

describe('a missing session_id records nothing and the advisory still shows', () => {
  // Paths the old shared fallback wrote: `unknown`, and `` (empty id).
  const legacy = ['unknown', ''].map(
    (s) => path.join(os.tmpdir(), `claude-recent-test-runs-${s}.json`),
  );
  const clean = () => {
    for (const p of legacy) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  };
  beforeEach(clean);
  afterEach(clean);

  async function track(payload: Record<string, unknown>): Promise<void> {
    const mockStdin = new PassThrough();
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });
    try {
      const mainPromise = main();
      mockStdin.end(JSON.stringify(payload));
      await mainPromise;
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, writable: true });
    }
  }

  const probe = { command: 'node scripts/rules/rule-router-probe.mjs' };
  const complete = { tool_name: 'TaskUpdate', tool_input: { status: 'completed' } };

  it('getStateFile returns null for a missing or empty id', () => {
    expect(getStateFile(undefined)).toBeNull();
    expect(getStateFile('')).toBeNull();
  });

  it('the tracker writes no file and the reader reports no recent run', async () => {
    await track({ tool_name: 'PowerShell', tool_input: probe });
    for (const p of legacy) expect(fs.existsSync(p)).toBe(false);
    expect(hasRecentTestRun(undefined)).toBe(false);
    // An empty directory, so a verify sidecar written in this checkout cannot decide the result.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trt-norepo-'));
    expect(handleTaskUpdate({ ...complete, cwd })).not.toBeNull();
  });
});
