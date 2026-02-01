/**
 * Post-Learning Prompt Hook
 *
 * Injects reminders to store learnings after key events:
 * - After Edit following error discussion (bug fix)
 * - After sequence of 3+ file edits (pattern discovery)
 * - After user correction detected
 *
 * Part of the event-driven learning system.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

interface SessionState {
  editCount: number;
  lastEditTime: number;
  recentTools: string[];
  errorDiscussed: boolean;
  lastPromptTime: number;
}

const STATE_FILE = join(homedir(), '.claude', 'cache', 'learning-state.json');
const PROMPT_COOLDOWN_MS = 300000; // 5 minutes between prompts
const EDIT_SEQUENCE_THRESHOLD = 3;
const EDIT_WINDOW_MS = 120000; // 2 minutes

function loadState(sessionId: string): SessionState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      return data[sessionId] || createDefaultState();
    }
  } catch {
    // Ignore errors, return default
  }
  return createDefaultState();
}

function saveState(sessionId: string, state: SessionState): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let data: Record<string, SessionState> = {};
    if (existsSync(STATE_FILE)) {
      try {
        data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    data[sessionId] = state;

    // Clean up old sessions (keep only last 10)
    const keys = Object.keys(data);
    if (keys.length > 10) {
      const sortedKeys = keys.sort((a, b) => data[b].lastEditTime - data[a].lastEditTime);
      data = Object.fromEntries(sortedKeys.slice(0, 10).map(k => [k, data[k]]));
    }

    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // Silently fail - state is optional
  }
}

function createDefaultState(): SessionState {
  return {
    editCount: 0,
    lastEditTime: 0,
    recentTools: [],
    errorDiscussed: false,
    lastPromptTime: 0
  };
}

function shouldPrompt(state: SessionState, now: number): { shouldPrompt: boolean; reason: string } {
  // Cooldown check
  if (now - state.lastPromptTime < PROMPT_COOLDOWN_MS) {
    return { shouldPrompt: false, reason: 'cooldown' };
  }

  // Pattern 1: Edit sequence (3+ edits in 2 minutes)
  if (state.editCount >= EDIT_SEQUENCE_THRESHOLD && now - state.lastEditTime < EDIT_WINDOW_MS) {
    return { shouldPrompt: true, reason: 'edit_sequence' };
  }

  // Pattern 2: Edit after error discussion
  if (state.errorDiscussed && state.recentTools.slice(-1)[0] === 'Edit') {
    return { shouldPrompt: true, reason: 'error_fix' };
  }

  return { shouldPrompt: false, reason: 'none' };
}

function getPromptMessage(reason: string): string {
  switch (reason) {
    case 'edit_sequence':
      return 'Multiple file edits detected. If you discovered a pattern or made an architectural decision, consider storing it: `/remember` or use store_learning.py';
    case 'error_fix':
      return 'Bug fix completed. If this fix involved non-obvious insights, consider storing the solution: `/remember` or use store_learning.py';
    default:
      return '';
  }
}

async function main() {
  const input: HookInput = JSON.parse(readFileSync(0, 'utf-8'));
  const now = Date.now();

  // Load state
  const state = loadState(input.session_id);

  // Track tool usage
  state.recentTools.push(input.tool_name);
  if (state.recentTools.length > 10) {
    state.recentTools.shift();
  }

  // Track edits
  if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
    // Reset count if window expired
    if (now - state.lastEditTime > EDIT_WINDOW_MS) {
      state.editCount = 0;
    }
    state.editCount++;
    state.lastEditTime = now;
  }

  // Detect error discussion (Grep/Read for error-related content)
  if (input.tool_name === 'Grep' || input.tool_name === 'Read') {
    const toolInput = input.tool_input || {};
    const content = JSON.stringify(toolInput).toLowerCase();
    if (content.includes('error') || content.includes('bug') || content.includes('fix') || content.includes('debug')) {
      state.errorDiscussed = true;
    }
  }

  // Check if we should prompt
  const { shouldPrompt: doPrompt, reason } = shouldPrompt(state, now);

  if (doPrompt) {
    const message = getPromptMessage(reason);
    state.lastPromptTime = now;
    state.editCount = 0; // Reset after prompting
    state.errorDiscussed = false;

    saveState(input.session_id, state);

    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `\n💡 **Learning Prompt**: ${message}\n`
      }
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Save state and continue
  saveState(input.session_id, state);
  console.log('{}');
}

main().catch(() => console.log('{}'));
