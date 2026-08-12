#!/usr/bin/env node
/**
 * ROADMAP Completion Hook
 *
 * Automatically updates ROADMAP.md when:
 * 1. TaskUpdate marks a task as "completed"
 * 2. User prompt contains completion signals ("done", "complete", "finished")
 *
 * Hook: PostToolUse (TaskUpdate) + UserPromptSubmit
 * Output: Updates {project}/ROADMAP.md - moves current → completed
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRoadmap } from './shared/roadmap-parser.js';

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

interface UserPromptSubmitInput {
  prompt: string;
  session_id?: string;
}

interface HookOutput {
  result: 'continue' | 'block';
  message?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

/**
 * Harness tools that run a shell command, so both can carry the git/test output
 * this hook reads. MUST stay in step with this hook's settings.json `matcher`
 * (`TaskUpdate|Bash|PowerShell`). A runtime check narrower than the matcher is
 * an inert registration -- the 2026-08-05 defect.
 */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const COMPLETION_PATTERNS = [
  /\b(done|complete|completed|finished|shipped|deployed|merged)\b/i,
  /\btask\s+(is\s+)?(done|complete|finished)\b/i,
  /\bmark\s+(as\s+)?(done|complete|finished)\b/i,
  /\bclose\s+(this\s+)?(task|issue|item)\b/i,
];

const TEST_SUCCESS_PATTERNS = [
  /Tests:\s+\d+\s+passed,\s+0\s+failed/i,
  /✓\s+\d+\s+tests?\s+passed/i,
  /All specs passed/i,
  /\d+\s+passed,\s+0\s+failed/i,
  /PASSED\s+\d+\s+tests?/i,
  /OK\s+\(\d+\s+tests?\)/i,
];

const GIT_PUSH_PATTERNS = [
  /\[main\s+[a-f0-9]+\]/i,
  /\[master\s+[a-f0-9]+\]/i,
  /-> main$/im,
  /-> master$/im,
  /Branch .+ set up to track/i,
];

const COMPLETION_EXCLUSIONS = [
  /\bnot\s+(done|complete|finished)\b/i,
  /\bisn'?t\s+(done|complete|finished)\b/i,
  /\bwhen\s+(done|complete|finished)\b/i,
  /\bonce\s+(done|complete|finished)\b/i,
  /\bafter\s+(done|complete|finished)\b/i,
  /\buntil\s+(done|complete|finished)\b/i,
  /\?/, // Questions
];

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function detectCompletionSignal(text: string): { type: string; matched: boolean } {
  for (const pattern of TEST_SUCCESS_PATTERNS) {
    if (pattern.test(text)) {
      return { type: 'test_success', matched: true };
    }
  }
  for (const pattern of GIT_PUSH_PATTERNS) {
    if (pattern.test(text)) {
      return { type: 'git_push', matched: true };
    }
  }
  return { type: 'none', matched: false };
}

function isCompletionSignal(text: string): boolean {
  // Check exclusions first
  for (const exclusion of COMPLETION_EXCLUSIONS) {
    if (exclusion.test(text)) {
      return false;
    }
  }

  // Check for completion patterns
  for (const pattern of COMPLETION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}

function findRoadmapPath(projectDir: string): string | null {
  const candidates = [
    path.join(projectDir, 'ROADMAP.md'),
    path.join(projectDir, '.claude', 'ROADMAP.md'),
    path.join(projectDir, 'roadmap.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// parseRoadmap + types now live in shared/roadmap-parser.ts (Phase 3A).

export function buildTaskCompletionAdvisory(roadmapContent: string): string | null {
  const data = parseRoadmap(roadmapContent);
  if (!data.current) return null;
  return `Task marked complete. ROADMAP Current Focus is unchanged: ` +
    `"${data.current.title}". roadmap-completion no longer auto-advances the ` +
    `ROADMAP on task completion — if the goal itself is finished, run /roadmap ` +
    `complete (and /roadmap focus <next>) to update it.`;
}

export async function handleTaskUpdate(
  data: PostToolUseInput,
  projectDir: string = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
): Promise<HookOutput> {
  const input = data.tool_input as { status?: string; taskId?: string };
  if (input.status !== 'completed') return { result: 'continue' };

  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) return { result: 'continue' };

  const advisory = buildTaskCompletionAdvisory(fs.readFileSync(roadmapPath, 'utf-8'));
  if (!advisory) return { result: 'continue' };

  // ADVISORY ONLY — never writes. (Previously: unconditional updateRoadmapContent +
  // promoteNextPlanned + fs.writeFileSync, which clobbered manual edits and falsely
  // advanced Current Focus on every unrelated task completion.)
  return {
    result: 'continue',
    message: advisory,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: advisory },
  };
}

async function handleBashOutput(data: PostToolUseInput): Promise<HookOutput> {
  let toolResult: string;
  const resp = data.tool_response;
  if (typeof resp === 'string') {
    toolResult = resp;
  } else if (resp && typeof (resp as any).output === 'string') {
    toolResult = (resp as any).output;
  } else {
    toolResult = '';
  }
  const signal = detectCompletionSignal(toolResult);

  if (!signal.matched) {
    return { result: 'continue' };
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = findRoadmapPath(projectDir);

  if (!roadmapPath) {
    return { result: 'continue' };
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmapData = parseRoadmap(content);

  if (!roadmapData.current) {
    return { result: 'continue' };
  }

  const signalDescription = signal.type === 'test_success'
    ? 'All tests passed'
    : 'Code pushed to main branch';

  return {
    result: 'continue',
    message: `🎯 Completion signal: ${signalDescription}. Goal "${roadmapData.current.title}" may be complete.`,
  };
}

async function handleUserPrompt(data: UserPromptSubmitInput): Promise<HookOutput> {
  if (!isCompletionSignal(data.prompt)) {
    return { result: 'continue' };
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = findRoadmapPath(projectDir);

  if (!roadmapPath) {
    return { result: 'continue' };
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmapData = parseRoadmap(content);

  if (!roadmapData.current) {
    return { result: 'continue' };
  }

  // Add a system reminder about potential completion
  return {
    result: 'continue',
    message: `Completion signal detected. Current ROADMAP goal: "${roadmapData.current.title}". If this goal is complete, the ROADMAP will be updated when you mark the task as completed.`,
  };
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let data: PostToolUseInput | UserPromptSubmitInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let result: HookOutput;

  // Determine which hook type based on input shape
  if ('tool_name' in data && (data as PostToolUseInput).tool_name === 'TaskUpdate') {
    result = await handleTaskUpdate(data as PostToolUseInput);
    // Registered matcher is `TaskUpdate|Bash|PowerShell`. Both shell tools put
    // the command in `tool_input.command`, so both reach handleBashOutput. A
    // runtime check narrower than the matcher is an inert registration -- see
    // the same defect in git-commit-roadmap.ts (COMMAND_TOOLS).
  } else if ('tool_name' in data && COMMAND_TOOLS.has((data as PostToolUseInput).tool_name)) {
    result = await handleBashOutput(data as PostToolUseInput);
  } else if ('prompt' in data) {
    result = await handleUserPrompt(data as UserPromptSubmitInput);
  } else {
    result = { result: 'continue' };
  }

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error('[roadmap-completion] Error:', err.message);
  console.log(JSON.stringify({ result: 'continue' }));
});
