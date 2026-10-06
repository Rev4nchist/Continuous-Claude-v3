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
import { getStateFile } from './shared/test-run-state.js';

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

/**
 * A run of `<name>.mjs` under node: `node` or `node.exe`, optional flags, optional quoted path
 * with `/` or `\`, then the file. The flag group never takes `--check` or `-c` (a syntax check is
 * not a run). `--dry-run` and `--help` on the same line are not runs. `git add x.mjs` and
 * `cat x.mjs` never match. Known limits: a flag with a separate value (`--require tsx`) and a
 * quoted path that holds a space do not match.
 */
function nodeScript(name: string): RegExp {
  const flag = String.raw`\s+(?!--check\b|-c\b)--?[\w-]+(?:=\S+)?`;
  const dir = String.raw`["']?(?:[^\s"']*[\\/])?`;
  const notPlan = String.raw`(?![^\n]*--(?:dry-run|help)\b)`;
  return new RegExp(String.raw`\bnode(?:\.exe)?(?:${flag})*\s+${dir}${name}\.mjs\b${notPlan}`);
}

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
  // Probes, ratchets and the verify entry point are test runs (PR1a, 2026-10-06).
  nodeScript('[\\w.-]+-probe'),
  nodeScript('audit-skills'),
  nodeScript('context-budget-guard'),
  nodeScript('verify'),
];

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
    const stateFile = getStateFile(data.session_id);
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
