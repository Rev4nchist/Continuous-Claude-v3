#!/usr/bin/env node
/**
 * Test Run Tracker Hook
 *
 * Companion to test-before-done: detects test commands in Bash tool use
 * and records the timestamp. test-before-done reads this to verify tests
 * were actually run before marking tasks complete.
 *
 * Hook: PostToolUse (Bash)
 * State: $TEMP/claude-recent-test-runs-{sessionId}.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
}

/** Shell tools that carry a command. Must match the settings.json matcher. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const TEST_PATTERNS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bnpm\s+test\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmocha\b/,
  /\bnpm\s+run\s+test\b/,
  /\bpnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bmake\s+test\b/,
];

function getStateFile(sessionId: string): string {
  return path.join(os.tmpdir(), `claude-recent-test-runs-${sessionId}.json`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({}));
    return;
  }

  let data: PostToolUseInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  // Registered matcher is `Bash|PowerShell`; a narrower runtime check makes
  // half the registration inert (the 2026-08-05 defect in git-commit-roadmap).
  if (!COMMAND_TOOLS.has(data.tool_name)) {
    console.log(JSON.stringify({}));
    return;
  }

  const command = data.tool_input?.command || '';
  const isTestCommand = TEST_PATTERNS.some((p) => p.test(command));

  if (isTestCommand) {
    const sessionId = data.session_id || 'default';
    const stateFile = getStateFile(sessionId);
    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ lastTestRun: Date.now(), command })
      );
    } catch {
      // Fail open
    }
  }

  console.log(JSON.stringify({}));
}

if (!process.env.VITEST) {
  main().catch(() => {
    console.log(JSON.stringify({}));
  });
}

export { TEST_PATTERNS, getStateFile, main };
