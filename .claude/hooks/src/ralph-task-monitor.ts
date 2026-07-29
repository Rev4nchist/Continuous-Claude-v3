#!/usr/bin/env node
/**
 * Ralph Task Monitor Hook
 *
 * PostToolUse hook for Task tool that monitors agent results.
 * When a Task tool agent completes, checks for success/failure patterns
 * and updates the unified Ralph state accordingly.
 *
 * This creates visibility for agents spawned via Task tool,
 * which ralph-monitor.ts (Bash-only) cannot see.
 *
 * Runs on PostToolUse:Task
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createLogger } from './shared/logger.js';
import { readRalphUnifiedState } from './shared/state-schema.js';
import { emitBraintrustScore } from './shared/braintrust-score.js';
import { resolveBraintrustSpanId } from './shared/braintrust-span.js';

const log = createLogger('ralph-task-monitor');

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    prompt?: string;
    subagent_type?: string;
    description?: string;
  };
  tool_result?: {
    stdout?: string;
    stderr?: string;
    content?: string;
    text?: string;
  };
}

// ─── Structured status detection (Priority 1) ──────────────
// Agents can output structured JSON for unambiguous status reporting.
// Format: {"ralph_status": {"task_id": "X.Y", "status": "complete", "commit": "abc123"}}
// Optional deploy_status: "preview_success" | "preview_failed" | "skipped" | null
interface RalphStructuredStatus {
  task_id: string;
  status: 'complete' | 'failed' | 'blocked';
  commit?: string;
  error?: string;
  deploy_status?: 'preview_success' | 'preview_failed' | 'skipped' | null;
}

const STRUCTURED_JSON_RE = /\{"ralph_status"\s*:\s*\{[^}]+\}\s*\}/;

// ─── XML status detection (Priority 2) ─────────────────────
// Format: <TASK_COMPLETE task="1.1" commit="abc123"/>
const XML_TASK_COMPLETE_RE = /<TASK_COMPLETE\s+task="(\d+(?:\.\d+)?)"\s*(?:commit="([^"]*)")?\s*\/?>/i;
const XML_TASK_FAIL_RE = /<TASK_FAIL\s+task="(\d+(?:\.\d+)?)"\s*(?:error="([^"]*)")?\s*\/?>/i;

// ─── Pattern matching (Priority 3 — fallback) ──────────────
// Patterns indicating agent success
const SUCCESS_PATTERNS = [
  /task\s+(?:is\s+)?complete/i,
  /implementation\s+(?:is\s+)?complete/i,
  /all\s+tests?\s+pass/i,
  /successfully\s+(?:implemented|completed|created|fixed)/i,
  /changes?\s+(?:have been|were)\s+(?:made|applied|committed)/i,
  /<TASK_COMPLETE\s*\/?>/i,
  /<COMPLETE\s*\/?>/i,
];

// Pattern to extract task ID from agent prompt or output
// Matches: "Task ID: 1.2", "Task: 1.2", "task_id: 1.2", "task 1.2"
const TASK_ID_PATTERN = /(?:task_id|Task ID|Task|task)[:\s_-]*(\d+(?:\.\d+)?)/i;

// Patterns indicating agent failure
const FAILURE_PATTERNS = [
  /(?:test|build|compilation)\s+(?:failed|failing|errors?)/i,
  /could\s+not\s+(?:complete|fix|resolve)/i,
  /blocked\s+(?:by|on|due)/i,
  /<BLOCKED(?:\s+reason="([^"]+)")?\s*\/?>/i,
  /<ERROR(?:\s+reason="([^"]+)")?\s*\/?>/i,
  /unable\s+to\s+(?:complete|resolve|implement)/i,
];

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

// ---------------------------------------------------------------------------
// Phase 3a (story braintrust-scoring): agent_task_success score emit.
//
// Emits a 0-1 score per Ralph task transition. Scoring rubric (from the plan):
//   * complete + retries === 0     -> 1.0 (clean completion)
//   * complete + retries > 0       -> 0.5 (partial credit, recovered)
//   * failed                       -> 0.0
//
// spanId resolution: from the Python-written span state file, via
// shared/braintrust-span.ts, keyed on the session id in the hook payload.
//
// It previously read BRAINTRUST_SESSION_ID and the comment here claimed that
// var was "set by the Python hook chain". It is not, and never was -- verified
// 2026-07-28 against the process env, ~/.claude/.env and the settings.json env
// block. So this returned null every time and agent_task_success has never
// reached Braintrust. The helper is fail-open, so a missing span still skips
// silently.
//
// Metadata: { task_id, task_name, agent, retries, duration_s }.
// ---------------------------------------------------------------------------

export type RalphTaskTransition = 'complete' | 'failed';

export interface RalphTaskScoreInput {
  taskId: string;
  taskName?: string;
  agent?: string;
  retries?: number;
  durationS?: number;
  transition: RalphTaskTransition;
  /**
   * Claude Code session id, used to look up the Braintrust span this score
   * attaches to. Threaded in from the hook payload rather than read from the
   * environment -- see the note on the spanId resolution below.
   */
  sessionId?: string;
}

/**
 * Compute the agent_task_success score per the rubric above.
 * Pure -- exported for unit testing.
 */
export function computeAgentTaskScore(input: RalphTaskScoreInput): number {
  if (input.transition === 'failed') return 0.0;
  // complete
  const retries = typeof input.retries === 'number' ? input.retries : 0;
  return retries === 0 ? 1.0 : 0.5;
}

/**
 * Build the emit payload for agent_task_success. Returns null when no span
 * id is available (the helper would skip the POST anyway, but returning null
 * lets the caller avoid the unnecessary call and lets us assert on the
 * payload shape in tests).
 *
 * Exported for unit testing -- main() wires this to emitBraintrustScore.
 */
export function buildAgentTaskScorePayload(
  input: RalphTaskScoreInput,
): { spanId: string; scores: Record<string, number>; metadata: Record<string, unknown> } | null {
  // Was `process.env.BRAINTRUST_SESSION_ID`, which is set NOWHERE -- checked on
  // 2026-07-28 against the process env, ~/.claude/.env and the settings.json
  // env block. So this returned null on every single call and
  // `agent_task_success` has never once reached Braintrust. The span state is
  // written by braintrust_hooks.py; read that instead.
  const spanId = resolveBraintrustSpanId(input.sessionId || '');
  if (!spanId) return null;
  const score = computeAgentTaskScore(input);
  return {
    spanId,
    scores: {
      agent_task_success: score,
    },
    metadata: {
      task_id: input.taskId,
      task_name: input.taskName || '',
      agent: input.agent || 'unknown',
      retries: typeof input.retries === 'number' ? input.retries : 0,
      duration_s: typeof input.durationS === 'number' ? input.durationS : 0,
      transition: input.transition,
      hook: 'ralph-task-monitor',
    },
  };
}

/**
 * Read a task from .ralph/state.json by id. Returns null when the state
 * file is missing, the version doesn't match, or the task isn't found.
 *
 * We re-read state AFTER the python task-complete/task-fail spawnSync so
 * the retries/duration_s fields reflect the post-transition state (e.g.
 * task-fail bumps retries).
 */
function readRalphTaskById(
  projectDir: string,
  taskId: string,
): { id: string; status: string; name?: string; agent?: string; retries?: number; duration_s?: number } | null {
  const state = readRalphUnifiedState(projectDir);
  if (!state || !Array.isArray(state.tasks)) return null;
  const task = state.tasks.find((t) => String(t.id) === String(taskId));
  if (!task) return null;
  return {
    id: String(task.id),
    status: String(task.status),
    name: typeof task.name === 'string' ? task.name : undefined,
    agent: typeof task.agent === 'string' ? task.agent : undefined,
    retries: typeof task.retries === 'number' ? task.retries : undefined,
    duration_s: typeof task.duration_s === 'number' ? task.duration_s : undefined,
  };
}

/**
 * Fire-and-forget Braintrust emit for a Ralph task transition. Wraps all
 * state reads and helper calls in try/catch so a score-emit failure can
 * never break the primary task-monitor flow.
 */
/**
 * Session id for THIS hook invocation, captured once in main().
 *
 * Module-level rather than threaded through the four `emitRalphTaskScore` call
 * sites: a hook is a single-shot process handling exactly one payload, so there
 * is no second session to confuse it with, and four extra parameters is four
 * more places to forget one. Empty string simply means no span, and the emit
 * skips -- the same fail-open behaviour as everywhere else here.
 */
let currentSessionId = '';

async function emitRalphTaskScore(
  projectDir: string,
  taskId: string,
  transition: RalphTaskTransition,
  fallbackAgent?: string,
): Promise<void> {
  try {
    const task = readRalphTaskById(projectDir, taskId);
    const payload = buildAgentTaskScorePayload({
      taskId,
      taskName: task?.name,
      agent: task?.agent || fallbackAgent,
      retries: task?.retries,
      durationS: task?.duration_s,
      transition,
      sessionId: currentSessionId,
    });
    if (payload) {
      await emitBraintrustScore(payload); // eslint-disable-line @typescript-eslint/no-floating-promises
    }
  } catch {
    /* fail-open: never let score emission break the hook */
  }
}

/**
 * Priority 1: Try to parse structured JSON status from agent output.
 * Returns null if no structured status found.
 */
function detectStructuredJSON(text: string): { taskId: string; success: boolean; commit?: string; reason?: string; deploy_status?: string } | null {
  const match = text.match(STRUCTURED_JSON_RE);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    const status: RalphStructuredStatus = parsed.ralph_status;
    if (!status || !status.task_id || !status.status) return null;

    const result: { taskId: string; success: boolean; commit?: string; reason?: string; deploy_status?: string } = {
      taskId: status.task_id,
      success: status.status === 'complete',
      commit: status.commit,
      reason: status.error || (status.status === 'failed' ? 'Agent reported failure' : undefined),
    };

    // Include deploy_status if present and non-null
    if (status.deploy_status !== undefined && status.deploy_status !== null) {
      result.deploy_status = status.deploy_status;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Priority 2: Try to parse XML task status tags.
 * Returns null if no XML status found.
 */
function detectXMLStatus(text: string): { taskId: string; success: boolean; commit?: string; reason?: string } | null {
  const completeMatch = text.match(XML_TASK_COMPLETE_RE);
  if (completeMatch) {
    return {
      taskId: completeMatch[1],
      success: true,
      commit: completeMatch[2] || undefined,
    };
  }

  const failMatch = text.match(XML_TASK_FAIL_RE);
  if (failMatch) {
    return {
      taskId: failMatch[1],
      success: false,
      reason: failMatch[2] || 'Agent reported failure',
    };
  }

  return null;
}

/**
 * Priority 3: Fallback pattern matching (original behavior).
 */
function detectOutcome(text: string): { success: boolean; reason?: string } | null {
  // Check failure first (more specific)
  for (const pattern of FAILURE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { success: false, reason: match[1] || match[0] };
    }
  }

  // Check success
  for (const pattern of SUCCESS_PATTERNS) {
    if (pattern.test(text)) {
      return { success: true };
    }
  }

  return null;
}

function getV2ScriptPath(): string | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const v2Script = join(homeDir, '.claude', 'scripts', 'ralph', 'ralph-state-v2.py');
  return existsSync(v2Script) ? v2Script : null;
}

async function main() {
  let input: HookInput = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  // Captured before any scoring path runs. See the note on currentSessionId.
  currentSessionId = input.session_id || '';

  // Only process Agent/Task tool results
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Check if Ralph is active with unified state
  const unified = readRalphUnifiedState(projectDir);
  if (!unified?.session?.active) return;

  const v2Script = getV2ScriptPath();
  if (!v2Script) return;

  // Get the agent result text
  const resultText = input.tool_result?.stdout
    || input.tool_result?.content
    || input.tool_result?.text
    || '';

  if (!resultText) return;

  const agentType = input.tool_input?.subagent_type || 'unknown';
  const description = input.tool_input?.description || '';
  const agentPrompt = String(input.tool_input?.prompt || '');

  // ─── Priority 1: Structured JSON status ───────────────────
  const structuredResult = detectStructuredJSON(resultText);
  if (structuredResult) {
    log.info(`Structured status detected for task ${structuredResult.taskId}`, { agentType, method: 'json' });
    const commitArgs = structuredResult.commit ? ['--commit', structuredResult.commit] : [];
    if (structuredResult.success) {
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-complete', '--id', structuredResult.taskId, ...commitArgs
      ], { encoding: 'utf-8', timeout: 5000 });
    } else {
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-fail', '--id', structuredResult.taskId,
        '--error', structuredResult.reason || 'Agent reported failure'
      ], { encoding: 'utf-8', timeout: 5000 });
    }

    // Phase 3a: emit agent_task_success score. State has been mutated by the
    // task-complete/task-fail spawn above, so retries/duration_s reflect the
    // post-transition values.
    await emitRalphTaskScore(
      projectDir,
      structuredResult.taskId,
      structuredResult.success ? 'complete' : 'failed',
      agentType,
    );

    const marker = structuredResult.success ? 'complete' : `failed: ${structuredResult.reason || 'unknown'}`;
    const deployInfo = structuredResult.deploy_status ? ` [deploy: ${structuredResult.deploy_status}]` : '';
    const message = `\nRALPH TASK MONITOR: ${agentType} -> task ${structuredResult.taskId} ${marker}${deployInfo} (structured JSON)\n`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }));
    return;
  }

  // ─── Priority 1.5: Generic agent JSON success format ──────
  // Handles common agent output: {"status": "success", ...} or {"status": "complete", ...}
  // Only fires when there is exactly 1 in-progress task (no ambiguity).
  {
    let parsed: any = null;
    try {
      // Try to find a JSON object in the output (may have surrounding text)
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // not valid JSON, skip
    }

    if (parsed && (parsed.status === 'success' || parsed.status === 'complete')) {
      // Fetch current task list to check for unambiguous single in-progress task
      const listResult = spawnSync('python', [
        v2Script, '-p', projectDir, 'task-list'
      ], { encoding: 'utf-8', timeout: 5000 });

      if (listResult.status === 0) {
        let allTasks: any[] = [];
        try {
          allTasks = JSON.parse(listResult.stdout).tasks || [];
        } catch { /* ignore */ }

        const inProgressTasks = allTasks.filter((t: any) => t.status === 'in_progress');

        if (inProgressTasks.length === 1) {
          const task = inProgressTasks[0];
          const taskId = String(task.id);
          log.info(`Generic JSON success detected, auto-completing single in-progress task ${taskId}`, { agentType, method: 'json-fallback' });
          spawnSync('python', [
            v2Script, '-p', projectDir, 'task-complete', '--id', taskId
          ], { encoding: 'utf-8', timeout: 5000 });
          // Phase 3a: emit agent_task_success score (post-transition state).
          await emitRalphTaskScore(projectDir, taskId, 'complete', agentType);
          const message = `\nRALPH TASK MONITOR: ${agentType} -> task ${taskId} complete (generic JSON status)\n`;
          console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }));
          return;
        } else if (inProgressTasks.length > 1) {
          log.info(`Generic JSON success found but ${inProgressTasks.length} in-progress tasks — skipping (ambiguous)`, { agentType });
        }
      }
    }
  }

  // ─── Priority 2: XML status tags ──────────────────────────
  const xmlResult = detectXMLStatus(resultText);
  if (xmlResult) {
    log.info(`XML status detected for task ${xmlResult.taskId}`, { agentType, method: 'xml' });
    const commitArgs = xmlResult.commit ? ['--commit', xmlResult.commit] : [];
    if (xmlResult.success) {
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-complete', '--id', xmlResult.taskId, ...commitArgs
      ], { encoding: 'utf-8', timeout: 5000 });
    } else {
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-fail', '--id', xmlResult.taskId,
        '--error', xmlResult.reason || 'Agent reported failure'
      ], { encoding: 'utf-8', timeout: 5000 });
    }

    // Phase 3a: emit agent_task_success score (post-transition state).
    await emitRalphTaskScore(
      projectDir,
      xmlResult.taskId,
      xmlResult.success ? 'complete' : 'failed',
      agentType,
    );

    const marker = xmlResult.success ? 'complete' : `failed: ${xmlResult.reason || 'unknown'}`;
    const message = `\nRALPH TASK MONITOR: ${agentType} -> task ${xmlResult.taskId} ${marker} (XML tag)\n`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }));
    return;
  }

  // ─── Priority 3: Pattern matching (original fallback) ─────
  const outcome = detectOutcome(resultText);

  if (!outcome) {
    log.info('No clear outcome detected from agent', { agentType, description });
    return;
  }

  // Find in-progress tasks to update
  const listResult = spawnSync('python', [
    v2Script, '-p', projectDir, 'task-list'
  ], { encoding: 'utf-8', timeout: 5000 });

  if (listResult.status !== 0) return;

  let allTasks: any[] = [];
  try {
    const parsed = JSON.parse(listResult.stdout);
    allTasks = parsed.tasks || [];
  } catch {
    return;
  }

  const inProgressTasks = allTasks.filter((t: any) => t.status === 'in_progress');

  if (inProgressTasks.length === 0) {
    log.info('No in-progress tasks to update', { agentType });
    return;
  }

  // Try to extract task ID from agent prompt for disambiguation
  const taskIdMatch = agentPrompt.match(TASK_ID_PATTERN);
  const extractedTaskId = taskIdMatch ? taskIdMatch[1] : null;

  let tasksToUpdate: any[];

  if (extractedTaskId) {
    const matched = inProgressTasks.filter((t: any) => String(t.id) === extractedTaskId);
    if (matched.length > 0) {
      tasksToUpdate = matched;
      log.info(`Matched agent to task ${extractedTaskId} via prompt`, { agentType });
    } else {
      log.warn(`Task ID ${extractedTaskId} from prompt not found in in_progress tasks`, { agentType });
      return;
    }
  } else if (inProgressTasks.length === 1) {
    tasksToUpdate = inProgressTasks;
  } else {
    const byAgent = inProgressTasks.filter((t: any) => t.agent === agentType);
    if (byAgent.length === 1) {
      tasksToUpdate = byAgent;
      log.info(`Matched task ${byAgent[0].id} via agent type fallback`, { agentType });
    } else {
      log.warn(`Ambiguous: ${inProgressTasks.length} in_progress tasks, no task ID in prompt. Skipping update.`, { agentType });
      return;
    }
  }

  for (const task of tasksToUpdate) {
    const taskId = String(task.id);
    if (outcome.success) {
      log.info(`Agent completed task ${taskId}`, { agentType, taskName: task.name });
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-complete', '--id', taskId
      ], { encoding: 'utf-8', timeout: 5000 });
    } else {
      log.warn(`Agent failed task ${taskId}`, { agentType, reason: outcome.reason, taskName: task.name });
      spawnSync('python', [
        v2Script, '-p', projectDir, 'task-fail', '--id', taskId,
        '--error', outcome.reason || 'Agent reported failure'
      ], { encoding: 'utf-8', timeout: 5000 });
    }
    // Phase 3a: emit agent_task_success score (post-transition state).
    await emitRalphTaskScore(
      projectDir,
      taskId,
      outcome.success ? 'complete' : 'failed',
      agentType,
    );
  }

  const statusLines = [
    '',
    '-'.repeat(40),
    `RALPH TASK MONITOR: ${agentType} agent ${outcome.success ? 'completed' : 'failed'} (pattern match)`,
    '-'.repeat(40),
  ];

  for (const task of tasksToUpdate) {
    const taskId = String(task.id);
    if (outcome.success) {
      statusLines.push(`  Task ${taskId} marked complete`);
    } else {
      statusLines.push(`  Task ${taskId} marked failed: ${outcome.reason || 'unknown'}`);
    }
  }

  statusLines.push('-'.repeat(40));
  const message = statusLines.join('\n');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }));
}

if (!process.env.VITEST) {
  main().catch(() => {
    // Fail silently — monitoring is non-critical
  });
}
