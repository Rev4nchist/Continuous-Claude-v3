#!/usr/bin/env node
/**
 * Agent Existence Validation Hook (PreToolUse:Task)
 *
 * Validates that agent definition files exist before spawning.
 * Prevents runtime errors from missing agent types.
 *
 * Lookup order: <cwd>/.claude/agents, $CLAUDE_PROJECT_DIR/.claude/agents, ~/.claude/agents.
 * Plugin agents (name contains ':') and built-in agents always pass: this hook cannot see them.
 * Any fs error other than "not found" fails open.
 *
 * NOTE: the filename `agent-model-guard` is a historical MISNOMER — this hook
 * guards agent EXISTENCE (hard-deny on a missing agent definition), NOT model
 * selection. Kept under the old name to avoid churning settings.json + the dist
 * + the sync; this docstring is the source of truth for what it actually does.
 */

import { readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

interface TaskInput {
  tool_name?: string;
  cwd?: string;
  tool_input?: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
}

interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export type Decision = { allow: true } | { allow: false; reason: string };

export interface DecideEnv {
  home: string;
  projectDir?: string;
}

export const BUILTIN_AGENTS = new Set([
  'Bash',
  'general-purpose',
  'Explore',
  'Plan',
  'statusline-setup',
  'claude-code-guide',
  'claude',
]);

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function outputContinue(): void {
  const output: PreToolUseOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
  console.log(JSON.stringify(output));
}

function outputBlock(reason: string): void {
  const output: PreToolUseOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  console.log(JSON.stringify(output));
}

/** Agent directories in lookup order, deduplicated. Only absolute paths are used. */
export function agentDirs(cwd: unknown, env: DecideEnv): string[] {
  const roots = [typeof cwd === 'string' ? cwd : undefined, env.projectDir];
  const dirs: string[] = [];
  for (const root of roots) {
    if (root && isAbsolute(root)) dirs.push(join(root, '.claude', 'agents'));
  }
  dirs.push(join(env.home, '.claude', 'agents'));
  const seen = new Set<string>();
  return dirs.filter(d => {
    const key = d.toLowerCase().replace(/\\/g, '/');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** true/false for found/not found. Throws on any other fs error (caller fails open). */
function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

function listAgents(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
  } catch {
    return [];
  }
}


function findSimilarAgents(agentType: string, available: string[]): string[] {
  const lower = agentType.toLowerCase();
  return available
    .filter(a => {
      const aLower = a.toLowerCase();
      return aLower.includes(lower) || lower.includes(aLower) ||
             levenshteinDistance(lower, aLower) <= 3;
    })
    .slice(0, 3);
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Pure decision. Allows on any fs error other than "not found".
 * Claude Code rejects unknown agent types itself ("Agent type '...' not found"); this hook
 * only adds a "did you mean" hint and must never deny an agent Claude Code can see.
 */
export function decide(input: TaskInput, env: DecideEnv): Decision {
  if (input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') return { allow: true };
  const agentType = input.tool_input?.subagent_type;
  if (typeof agentType !== 'string' || !agentType) return { allow: true };
  if (BUILTIN_AGENTS.has(agentType) || agentType.includes(':')) return { allow: true };

  try {
    const dirs = agentDirs(input.cwd, env);
    // A name with a path separator or ".." never names a file in an agents dir.
    const safeName = !/[\\/]|\.\./.test(agentType);
    if (safeName) {
      for (const dir of dirs) {
        if (fileExists(join(dir, `${agentType}.md`))) return { allow: true };
      }
    }
    const available = [...new Set(dirs.flatMap(listAgents))];
    const similar = findSimilarAgents(agentType, available);
    let message = `Agent "${agentType}" not found in ${dirs.join(' or ')}`;
    if (similar.length > 0) message += `\n\nDid you mean: ${similar.join(', ')}?`;
    message += `\n\nAvailable custom agents: ${available.slice(0, 10).join(', ')}${available.length > 10 ? '...' : ''}`;
    return { allow: false, reason: message };
  } catch {
    return { allow: true };
  }
}

function main(): void {
  let input: TaskInput;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }
  const decision = decide(input, { home: homedir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (decision.allow) outputContinue();
  else outputBlock(decision.reason);
}

// Entry only when this file is the process entrypoint, so a test can import decide() safely.
function isDirectRun(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
