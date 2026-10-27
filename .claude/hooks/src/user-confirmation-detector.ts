#!/usr/bin/env node
/**
 * User Confirmation Detector Hook
 *
 * L1 Defense Layer: Captures when user explicitly confirms something is resolved
 * or worth remembering. Direct signal - no inference needed.
 *
 * Hook: UserPromptSubmit
 * Trigger: User messages matching confirmation patterns
 *
 * Detects:
 * - Resolution confirmations: "it's working", "fixed", "solved"
 * - Explicit memory requests: "remember this", "note that"
 * - Satisfaction signals: "that worked", "perfect"
 *
 * Integrates with smarter-everyday to confirm victory candidates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { writeStateWithLock } from './shared/atomic-write.js';
import { isHarnessWrappedPrompt } from './shared/intent-extractor.js';

interface UserPromptSubmitInput {
  session_id: string;
  prompt: string;
}

interface HookOutput {
  continue: boolean;
  systemMessage?: string;
}

interface SmarterState {
  session_id: string;
  state: string;
  tracked_file: string | null;
  attempts: number;
  failures: Array<{ turn: number; error: string }>;
  candidate_turn: number | null;
  last_edit_content: string | null;
  test_command: string | null;
  context: string | null;
  current_turn: number;
}

// Resolution confirmation patterns
const RESOLUTION_SIGNALS = [
  // Direct confirmations
  /(?:this|it)(?:'s| is)(?: now)? (?:fixed|working|resolved|done)/i,
  /(?:that|it) (?:worked|works)(?: now)?[.!]?$/i,
  /(?:problem|issue|bug)(?: is)? (?:fixed|solved|resolved)/i,
  /(?:all|everything)(?: is)? (?:good|working|fixed)/i,
  /(?:got it|figured it out)/i,

  // Success acknowledgments
  /^(?:perfect|excellent|great|awesome|nice)[.!]?$/i,
  /^(?:yes|yep|yeah),? (?:that|it)(?:'s| is) (?:it|right|correct)/i,
  /^thanks?,? (?:that|it) (?:worked|fixed)/i,
];

// Explicit memory request patterns
const MEMORY_SIGNALS = [
  /(?:remember|note|record) (?:this|that)/i,
  /(?:make|take) a note/i,
  /(?:for )?future reference/i,
  /(?:keep|save) (?:this|that) (?:in mind|for later)/i,
  /(?:don't forget|important to remember)/i,
  /(?:store|save) (?:this|that) (?:learning|insight)/i,
];

// Patterns that indicate we should NOT capture (questions, requests)
const ANTI_PATTERNS = [
  /\?$/,  // Questions
  /^(?:can you|could you|please|would you)/i,
  /^(?:try|check|look|see|run|test|fix|change)/i,
  /^(?:wait|stop|hold on|actually)/i,
];

function getOpcDir(): string {
  return process.env.CLAUDE_OPC_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'continuous-claude', 'opc');
}

function getSmarterStateFilePath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'smarter-everyday-state.json');
}

function loadSmarterState(stateFile: string): SmarterState | null {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

function saveSmarterState(stateFile: string, state: SmarterState): void {
  writeStateWithLock(stateFile, JSON.stringify(state, null, 2));
}

function isResolutionConfirmation(prompt: string): boolean {
  // Skip if matches anti-patterns
  if (ANTI_PATTERNS.some(p => p.test(prompt))) {
    return false;
  }
  return RESOLUTION_SIGNALS.some(p => p.test(prompt));
}

function isMemoryRequest(prompt: string): boolean {
  return MEMORY_SIGNALS.some(p => p.test(prompt));
}

export async function storeUserConfirmedLearning(
  sessionId: string,
  prompt: string,
  context: string | null,
  projectDir: string
): Promise<boolean> {
  const opcDir = getOpcDir();

  const content = context
    ? `User confirmed: "${prompt}". Context: ${context}`
    : `User confirmed: "${prompt}"`;

  // QW-01: spawn with no shell — pass each argument as a separate argv element.
  // The raw content is handed to Python verbatim (no shell = no injection); the
  // previous sh-style double-quote escaping is removed. The 1000-char cap (a size
  // limit, not escaping) is preserved. cwd stays opcDir so the relative script
  // path resolves exactly as before.
  const script = 'scripts/core/store_learning.py';
  const cappedContent = content.slice(0, 1000);

  try {
    spawnSync(
      'uv',
      [
        'run', 'python', script,
        '--session-id', sessionId,
        '--type', 'USER_PREFERENCE',
        '--content', cappedContent,
        '--context', 'user confirmation',
        '--tags', 'user_confirmed,verified',
        '--confidence', 'high',
        '--source', 'hook',
        '--project-dir', projectDir,
      ],
      {
        encoding: 'utf-8',
        cwd: opcDir,
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }
    );
    return true;
  } catch {
    return false;
  }
}

export async function storeVictoryFromConfirmation(
  state: SmarterState,
  prompt: string,
  projectDir: string
): Promise<boolean> {
  const opcDir = getOpcDir();

  const failedApproaches = state.failures
    .map(f => f.error)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3)
    .join('; ');

  const content = `Problem solved after ${state.attempts} attempts (user confirmed: "${prompt}").
File: ${state.tracked_file}
Solution: ${state.last_edit_content || 'Final edit'}
${failedApproaches ? `Failed approaches: ${failedApproaches}` : ''}`;

  // QW-01: spawn with no shell — pass each argument as a separate argv element.
  // The raw content is handed to Python verbatim (no shell = no injection); the
  // previous sh-style double-quote escaping is removed. The 2000-char cap (a size
  // limit, not escaping) is preserved. cwd stays opcDir so the relative script
  // path resolves exactly as before.
  const script = 'scripts/core/store_learning.py';
  const cappedContent = content.slice(0, 2000);
  const contextStr = `Victory (user confirmed): ${state.context || state.tracked_file}`;
  const tagsStr = `victory,verified,user_confirmed,attempts:${state.attempts}`;

  try {
    spawnSync(
      'uv',
      [
        'run', 'python', script,
        '--session-id', state.session_id,
        '--type', 'WORKING_SOLUTION',
        '--content', cappedContent,
        '--context', contextStr,
        '--tags', tagsStr,
        '--confidence', 'high',
        '--source', 'hook',
        '--project-dir', projectDir,
      ],
      {
        encoding: 'utf-8',
        cwd: opcDir,
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  let data: UserPromptSubmitInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const prompt = data.prompt?.trim() || '';
  const sessionId = data.session_id;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Skip empty or very short prompts
  if (prompt.length < 3) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // UserPromptSubmit also fires for task notifications and subagent hand-backs. Their text
  // ("done", "works") read as Dave confirming, and 5 were stored as verified, high-confidence
  // "User confirmed" memories (2026-09-23 eval, P29). Only a human's prompt can confirm.
  // Explicit wrappers only: a long or XML-heavy HUMAN prompt must still be able to confirm.
  if (isHarnessWrappedPrompt(prompt)) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  let message: string | null = null;

  // Check for resolution confirmation
  if (isResolutionConfirmation(prompt)) {
    // Check if smarter-everyday has a CANDIDATE to confirm
    const smarterStateFile = getSmarterStateFilePath(projectDir);
    const smarterState = loadSmarterState(smarterStateFile);

    if (smarterState && smarterState.state === 'CANDIDATE') {
      // Confirm the victory!
      const stored = await storeVictoryFromConfirmation(smarterState, prompt, projectDir);

      if (stored) {
        message = `[UserConfirm:L1] Victory confirmed by user: ${smarterState.tracked_file} (${smarterState.attempts} attempts)`;

        // Reset smarter-everyday state
        smarterState.state = 'IDLE';
        smarterState.tracked_file = null;
        smarterState.attempts = 0;
        smarterState.failures = [];
        smarterState.candidate_turn = null;
        saveSmarterState(smarterStateFile, smarterState);
      }
    } else {
      // No candidate but user confirmed something - still worth noting
      const stored = await storeUserConfirmedLearning(
        sessionId,
        prompt,
        smarterState?.context || null,
        projectDir
      );

      if (stored) {
        message = '[UserConfirm:L1] User confirmation captured';
      }
    }
  }

  // Check for explicit memory request
  if (isMemoryRequest(prompt)) {
    // The user wants to remember something - the next assistant response
    // will be captured. For now, just acknowledge.
    message = message
      ? message + ' (memory request noted)'
      : '[UserConfirm:L1] Memory request detected - watching for content to remember';
  }

  const output: HookOutput = {
    continue: true,
    systemMessage: message || undefined
  };

  console.log(JSON.stringify(output));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

// Only auto-run when invoked directly as a hook (not when imported by tests).
// process.argv[1] is the bundled dist filename when Claude Code runs the hook.
if (process.argv[1] && process.argv[1].includes('user-confirmation-detector')) {
  main().catch(err => {
    console.error('user-confirmation-detector error:', err);
    console.log(JSON.stringify({ continue: true }));
  });
}
