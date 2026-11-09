#!/usr/bin/env node
/**
 * Test Run Tracker Hook
 *
 * Companion to test-before-done: detects test commands in Bash tool use
 * and records the timestamp. test-before-done reads this to verify tests
 * were actually run before marking tasks complete.
 *
 * Hook: PostToolUse and PostToolUseFailure (Bash|PowerShell). A failing command arrives only as
 * PostToolUseFailure, so both events must be registered or a failed run is never recorded.
 * State: $TEMP/claude-recent-test-runs-{sessionId}.json = {lastTestRun, command, ok}
 * `command` is stored with secrets masked (maskSecrets). done-proof reads it for isRatchet and for the failure message.
 */

import * as fs from 'fs';
import { isRatchet } from './shared/done-proof.js';
import { maskSecrets } from './shared/guard-log.js';
import { maskQuoted } from './shared/mask-quotes.js';
import { getStateFile } from './shared/test-run-state.js';
import { exitCodeOf } from './shared/tool-error.js';

interface PostToolUseInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
  tool_response?: unknown;
  /** PostToolUseFailure only: "Exit code N" for a command that exited non-zero. */
  error?: string;
  is_interrupt?: boolean;
}

/** Shell tools that carry a command. Must match the settings.json matcher. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * A run of `<name>.mjs` under node: `node` or `node.exe`, optional flags, optional quoted path
 * with `/` or `\`, then the file. The flag group never takes `--check` or `-c` (a syntax check is
 * not a run). `--dry-run` and `--help` on the same line are not runs. `git add x.mjs` and
 * `cat x.mjs` never match. `node` must start a command: at the start of the string or after
 * `;`, `&`, `|`, `(` or a newline, with an optional PowerShell `&` call operator. So
 * `echo node x.mjs` is not a run. Known limits: a flag with a separate value (`--require tsx`),
 * a quoted path that holds a space, and a `node` after a keyword (`then node x.mjs`) or a
 * wrapper (`time node x.mjs`, `cd x; if (1) { node x.mjs }`) do not match.
 */
function nodeScript(name: string): RegExp {
  const flag = String.raw`\s+(?!--check\b|-c\b)--?[\w-]+(?:=\S+)?`;
  const dir = String.raw`["']?(?:[^\s"']*[\\/])?`;
  const notPlan = String.raw`(?![^\n]*--(?:dry-run|help)\b)`;
  const start = String.raw`(?:^|[;&|(]\s*|\n\s*)(?:&\s+)?`;
  return new RegExp(String.raw`${start}node(?:\.exe)?(?:${flag})*\s+${dir}${name}\.mjs\b${notPlan}`);
}

/**
 * A test tool counts as a run only where the shell runs it: at a command position, behind the
 * launchers people use (an env prefix, `npx`, `pnpm exec`, `uv run`, `python -m`, `cross-env`) and
 * an optional path (`./node_modules/.bin/`). A command that only NAMES the tool (a commit message,
 * `grep -r pytest`, `cat jest.config.js`) is not a run: a run is proof for the next 5 minutes.
 * Run on the quote-masked command (see isTestCommand), so text inside quotes never counts.
 */
const CMD_START = String.raw`(?:^\s*|[;&|(]\s*|\n\s*)(?:&\s+)?(?:\w+=\S*\s+)*`;
const LAUNCHERS = String.raw`(?:(?:npx|pnpx|bunx)(?:\.cmd)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+|(?:pnpm|yarn|npm)(?:\.cmd)?\s+(?:exec\s+|dlx\s+)?|(?:uv|poetry|pipenv|pdm)\s+run\s+|python3?(?:\.exe)?\s+-m\s+|py\s+-m\s+|cross-env\s+(?:\w+=\S*\s+)*)*`;
const TOOL_PATH = String.raw`(?:[^\s"';&|()]*[\\/])?`;
const atCommand = (body: string): RegExp => new RegExp(CMD_START + body);

const TOOL_PATTERNS = [
  atCommand(`${LAUNCHERS}${TOOL_PATH}(?:vitest|jest|pytest|mocha)(?:\\.cmd|\\.exe)?\\b`),
  atCommand(String.raw`(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?test\b`),
  atCommand(String.raw`cargo\s+test\b`),
  atCommand(String.raw`go\s+test\b`),
  atCommand(String.raw`make\s+test\b`),
];

// Probes, ratchets and the verify entry point are test runs (PR1a, 2026-10-06). Run on the raw
// command: the path may be quoted (`node "C:\x\verify.mjs"`).
const NODE_PATTERNS = [
  nodeScript('[\\w.-]+-probe'),
  nodeScript('audit-skills'),
  nodeScript('context-budget-guard'),
  nodeScript('verify'),
];

const TEST_PATTERNS = [...TOOL_PATTERNS, ...NODE_PATTERNS];

/** Is `command` a test run? Tools are matched on the quote-masked view, scripts on the raw one. */
export function isTestCommand(command: string, tool: string = 'Bash'): boolean {
  if (NODE_PATTERNS.some((p) => p.test(command))) return true;
  const masked = maskQuoted(command, tool);
  return TOOL_PATTERNS.some((p) => p.test(masked));
}

/**
 * Did the run pass? true / false, or null when it cannot be told.
 *
 * Evidence (step 0 of PR2, 2026-10-06, real payloads in
 * .claude/cache/e2e/2026-10-06-correct-posttooluse-bash.json): a passing Bash call fires
 * PostToolUse with a tool_response that has NO exit-code field; a failing call fires
 * PostToolUseFailure with `error: "Exit code N"` and no tool_response. So the event name is the
 * signal. An exit code in tool_response, if a future payload carries one, wins. An interrupt
 * (the user pressed Escape) is `false`: the run did not finish, so it is not proof, and null
 * counts as a pass in done-proof.
 */
export function okOf(data: PostToolUseInput): boolean | null {
  if (data.hook_event_name === 'PostToolUseFailure') return false;
  const code = exitCodeOf(data.tool_response);
  if (code !== null) return code === 0;
  return data.hook_event_name === 'PostToolUse' ? true : null;
}

/**
 * The state file holds ONE run. A ratchet (context-budget-guard, audit-skills) is never proof, so
 * it must not overwrite a test run: AGENTS.md says to run vitest and then the ratchet, and the
 * second must not erase the first.
 */
function keepsEarlierRun(stateFile: string, command: string): boolean {
  if (!isRatchet(command)) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return typeof prev?.lastTestRun === 'number' && typeof prev?.command === 'string' && !isRatchet(prev.command);
  } catch {
    return false;
  }
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

  // A background start fires PostToolUse before any test finishes: its result is unknown, so it
  // records nothing (a recorded pass here would be proof for a run that has not happened).
  if (isTestCommand(command, data.tool_name) && data.tool_input?.run_in_background !== true) {
    const stateFile = getStateFile(data.session_id);
    if (!stateFile) {
      console.log(JSON.stringify({}));
      return;
    }
    if (keepsEarlierRun(stateFile, command)) {
      console.log(JSON.stringify({}));
      return;
    }
    try {
      // The state file is a plain temp file. Store the command with secrets masked.
      // Every check above ran on the raw command, so the masked text changes no decision.
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ lastTestRun: Date.now(), command: maskSecrets(command), ok: okOf(data) })
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
