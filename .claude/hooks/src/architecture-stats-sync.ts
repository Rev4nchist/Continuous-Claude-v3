#!/usr/bin/env node
/**
 * architecture-stats-sync.ts — PostToolUse:Bash hook
 *
 * Detects successful `git commit` operations and, if the most recent commit
 * touched files under `.claude/(hooks|agents|skills)/` or `scripts/`, or
 * `docs/review-engine/map.md` or the authored system-map file, fires
 * `scripts/sync-architecture-stats.mjs --apply` in the background
 * (fire-and-forget; never blocks the user).
 *
 * Output: stdout is the standard PostToolUse passthrough envelope; stderr/stdout
 * of the spawned sync go to `.claude/logs/architecture-stats-sync.log`.
 *
 * Design rationale:
 *   * Pure decision logic (`isGitCommitCommand`, `touchesWatchedPaths`,
 *     `shouldFireSync`) is exported for unit testing.
 *   * `main()` only runs when invoked as a CLI (stdin has JSON input).
 *   * Per hook-dev-lifecycle.md: PostToolUse output is
 *     `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
 *   * Per Ralph Linter Revert lesson: this hook does NOT emit a Braintrust
 *     score, so it is not part of the audit invariant count.
 */

import { spawnSync } from 'node:child_process';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';
import { openSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { isEngineHost } from './shared/engine-host.js';

// ===========================================================================
// Types
// ===========================================================================

export interface PostToolUseInput {
  session_id?: string;
  tool_name: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
  tool_response?: unknown;
}

// ===========================================================================
// Constants
// ===========================================================================

/**
 * Multiline regex that matches a `git show --name-only` line where the file
 * lives under `.claude/{hooks,agents,skills}/` or `scripts/`.
 *
 *   - `^` + `m` flag: anchor at start of each newline-delimited file path
 *   - `\.claude/(?:hooks|agents|skills)/` matches the three watched .claude
 *     subtrees with a trailing `/` so `.claude/hooks-other/` does NOT match
 *   - `scripts/` matches the scripts dir with trailing `/` so a doc file like
 *     `docs/about-scripts.md` does NOT match
 *   - `docs/review-engine/map.md` and the authored
 *     `docs/architecture/system-visualization/architecture.src.json` (those two
 *     files only) are sources of the generated system map; the generator reads
 *     both. The two files the sync writes (`architecture.json`, `index.html`)
 *     are not watched.
 */
export const WATCHED_PATTERN = /^(?:(?:\.claude\/(?:hooks|agents|skills)|scripts)\/|docs\/(?:review-engine\/map\.md|architecture\/system-visualization\/architecture\.src\.json)\r?$)/m;

/**
 * Regex matching a `git commit` invocation (allows arbitrary whitespace and
 * preceding/trailing flags). Word boundaries prevent matching `git committed`.
 */
const GIT_COMMIT_PATTERN = /\bgit\s+commit\b/;

// ===========================================================================
// Pure decision helpers (exported for tests)
// ===========================================================================

/**
 * Returns true if the Bash command string is a `git commit` invocation.
 *
 * Examples that match:
 *   `git commit -m "feat: x"`
 *   `  git   commit  --amend  `
 *
 * Examples that do NOT match:
 *   `git status`
 *   `git log -1`
 *   `echo "i will commit later"`
 */
export function isGitCommitCommand(command: string): boolean {
  if (!command) return false;
  return GIT_COMMIT_PATTERN.test(command);
}

/**
 * Returns true if any line of the `git show --name-only --format= HEAD`
 * output is a file under one of the watched paths.
 */
export function touchesWatchedPaths(filesOutput: string): boolean {
  if (!filesOutput) return false;
  return WATCHED_PATTERN.test(filesOutput);
}

/**
 * Top-level decision: should the sync script be fired?
 *
 * Requires:
 *   1. tool_name === "Bash"
 *   2. tool_input.command matches `git commit`
 *   3. At least one file in the most-recent commit is under a watched path
 */
export function shouldFireSync(input: PostToolUseInput, commitFiles: string): boolean {
  if (input.tool_name !== 'Bash') return false;
  const command = input.tool_input?.command;
  if (!command) return false;
  if (!isGitCommitCommand(command)) return false;
  if (!touchesWatchedPaths(commitFiles)) return false;
  return true;
}

// ===========================================================================
// Side-effect helpers
// ===========================================================================

/**
 * Resolve repo root for the spawned sync script.
 * Prefers CLAUDE_PROJECT_DIR (Claude Code sets this); falls back to cwd.
 */
function resolveRepoRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Get the file list for HEAD via `git show --name-only --format= HEAD`.
 * Returns empty string on any error so callers degrade to "no fire".
 */
function getHeadCommitFiles(cwd: string): string {
  try {
    const result = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status !== 0) return '';
    return result.stdout || '';
  } catch {
    return '';
  }
}

/**
 * Spawn `node scripts/sync-architecture-stats.mjs --apply` detached so the
 * hook process can exit immediately. Logs go to a per-repo log file.
 */
function fireBackgroundSync(repoRoot: string): void {
  try {
    const logsDir = path.join(repoRoot, '.claude', 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, 'architecture-stats-sync.log');
    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    const scriptPath = path.join(repoRoot, 'scripts', 'sync-architecture-stats.mjs');
    const child = spawnDetachedHidden('node', [scriptPath, '--apply'], {
      cwd: repoRoot,
      stdio: ['ignore', out, err],
    });
    child.unref();
  } catch {
    // Never block the user's commit on sync errors.
  }
}

// ===========================================================================
// CLI entrypoint
// ===========================================================================

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // Safety net — never hang the hook
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function passthrough(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: '',
    },
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    console.log(passthrough());
    return;
  }

  let input: PostToolUseInput;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log(passthrough());
    return;
  }

  // Under cursor-agent (the review engine): no log file and no sync script in the reviewed tree. (card engine-run-hook-files).
  if (isEngineHost(input)) {
    console.log('{}');
    return;
  }

  // Cheap early exit: not Bash or not a git commit
  if (input.tool_name !== 'Bash') {
    console.log(passthrough());
    return;
  }
  const command = input.tool_input?.command || '';
  if (!isGitCommitCommand(command)) {
    console.log(passthrough());
    return;
  }

  // Only NOW do the (slightly more expensive) git show call
  const repoRoot = resolveRepoRoot();
  const files = getHeadCommitFiles(repoRoot);

  if (!shouldFireSync(input, files)) {
    console.log(passthrough());
    return;
  }

  fireBackgroundSync(repoRoot);
  console.log(passthrough());
}

// Only run main() when invoked as a CLI (not when imported by tests).
// import.meta.url uses file:// URLs; process.argv[1] is the script path.
const invokedAsCli = (() => {
  try {
    const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const modulePath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return argvPath === modulePath;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  main().catch((err) => {
    console.error('[architecture-stats-sync] Error:', err?.message ?? err);
    console.log(passthrough());
  });
}
