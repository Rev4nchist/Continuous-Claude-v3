/**
 * Git Memory Check Hook (PreToolUse:Bash)
 *
 * Intercepts git push/commit/checkout commands and checks memory
 * for relevant user preferences before allowing the action.
 *
 * Use cases:
 * - "NEVER push to origin (parcadei)" - warn before git push origin
 * - "Always use conventional commits" - remind before git commit
 * - "Never force push to main" - block git push --force
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { getOpcDir } from './shared/opc-path.js';

interface PreToolUseInput {
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
}

interface MemoryResult {
  results: Array<{
    score: number;
    session_id: string;
    content: string;
    created_at: string;
  }>;
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/**
 * Check if command is a git operation we care about.
 */
function extractGitOperation(command: string): { op: string; args: string } | null {
  // Match git commands - handle multiline, &&-chained, and quoted commands
  const gitPatterns = [
    /\bgit\s+push\b(.*)$/im,
    /\bgit\s+commit\b(.*)$/im,
    /\bgit\s+checkout\b(.*)$/im,
    /\bgit\s+reset\b(.*)$/im,
    /\bgit\s+rebase\b(.*)$/im,
    /\bgit\s+merge\b(.*)$/im,
  ];

  for (const pattern of gitPatterns) {
    const match = command.match(pattern);
    if (match) {
      const fullMatch = match[0];
      const op = fullMatch.split(/\s+/)[1]; // "push", "commit", etc.
      const args = match[1]?.trim() || '';
      return { op, args };
    }
  }

  return null;
}

/**
 * Build search query based on git operation.
 */
function buildSearchQuery(op: string, args: string): string {
  const queries: Record<string, string> = {
    push: `git push ${args.includes('origin') ? 'origin' : ''} remote`,
    commit: 'git commit convention message',
    checkout: 'git checkout branch',
    reset: 'git reset dangerous',
    rebase: 'git rebase workflow',
    merge: 'git merge branch',
  };

  return queries[op] || `git ${op}`;
}

/**
 * Query memory for relevant git preferences.
 */
function checkGitMemory(query: string): MemoryResult | null {
  const opcDir = getOpcDir();
  if (!opcDir) return null;

  try {
    const result = spawnSync('uv', [
      'run', 'python', 'scripts/core/recall_learnings.py',
      '--query', query,
      '--k', '3',
      '--json',
      '--text-only'
    ], {
      encoding: 'utf-8',
      cwd: opcDir,
      env: {
        ...process.env,
        PYTHONPATH: opcDir,
      },
      timeout: 3000,
      killSignal: 'SIGKILL',
    });

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    return JSON.parse(result.stdout) as MemoryResult;
  } catch {
    return null;
  }
}

/**
 * Check if memory content indicates a blocking preference.
 */
function isBlockingMemory(content: string, op: string, args: string): boolean {
  const lowerContent = content.toLowerCase();
  const lowerArgs = args.toLowerCase();

  // Check for "NEVER" patterns
  if (lowerContent.includes('never')) {
    // "NEVER push to origin" + args contains "origin"
    if (op === 'push' && lowerContent.includes('origin') && lowerArgs.includes('origin')) {
      return true;
    }
    // "NEVER force push" + args contains "--force" or "-f"
    if (op === 'push' && lowerContent.includes('force') &&
        (lowerArgs.includes('--force') || lowerArgs.includes('-f'))) {
      return true;
    }
    // "NEVER push to main/master"
    if (op === 'push' && (lowerContent.includes('main') || lowerContent.includes('master')) &&
        (lowerArgs.includes('main') || lowerArgs.includes('master'))) {
      return true;
    }
  }

  return false;
}

async function main() {
  const input: PreToolUseInput = JSON.parse(readStdin());

  // Only process Bash tool
  if (input.tool_name !== 'Bash') {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const command = input.tool_input.command;
  if (!command || typeof command !== 'string') {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Extract git operation
  const gitOp = extractGitOperation(command);
  if (!gitOp) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Query memory for relevant preferences
  const query = buildSearchQuery(gitOp.op, gitOp.args);
  const memory = checkGitMemory(query);

  if (!memory || memory.results.length === 0) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Check if any memory indicates blocking
  const blockingMemories = memory.results.filter(r =>
    isBlockingMemory(r.content, gitOp.op, gitOp.args)
  );

  if (blockingMemories.length > 0) {
    // Block with warning
    const topMemory = blockingMemories[0];
    const preview = topMemory.content.slice(0, 200);

    console.log(JSON.stringify({
      decision: 'block',
      reason: `⚠️ GIT MEMORY WARNING:\n\nA stored preference may conflict with this command:\n\n"${preview}"\n\nPlease confirm this is intentional or modify the command.`
    }));
    return;
  }

  // For non-blocking matches, add context but allow
  const topResult = memory.results[0];
  if (topResult.score > 0.05) {
    const preview = topResult.content.slice(0, 150);
    console.log(JSON.stringify({
      continue: true,
      additionalContext: `GIT MEMORY HINT: "${preview}..." - Consider if this applies to your command.`
    }));
    return;
  }

  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  // Silent fail - don't block on errors
  console.log(JSON.stringify({ continue: true }));
});
