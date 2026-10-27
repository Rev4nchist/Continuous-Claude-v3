#!/usr/bin/env node
/**
 * Agent Error Capture Hook
 *
 * Captures agent (Task tool) failures as FAILED_APPROACH learnings.
 * When a Task returns with an error or indicates failure, extract context
 * and store as a learning for future sessions.
 *
 * Hook: PostToolUse:Task
 *
 * Error detection patterns:
 * - tool_response contains "error", "failed", "exception"
 * - tool_response contains stack traces
 * - agent returned with explicit failure indicators
 *
 * Stores:
 * - Agent type that failed
 * - Task prompt that was given
 * - Error message/output
 * - Context for future avoidance
 */

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { scoreExtraction } from './shared/memory-quality-scorer.js';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';

interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
  tool_response: unknown;
}

// Structured / strong error signals — a genuine agent failure almost always
// emits one of these (named exceptions, stack traces, OS errno, panic, crash).
// These are the ONLY patterns that TRIGGER a capture (see hasStructuredError),
// which keeps low-signal "error"/"failed" prose out of recall (review S2).
const STRUCTURED_ERROR_PATTERNS = [
  /\bTraceback\s+\(most recent/i,  // Python stack trace
  /\bat\s+\S+\s+\(\S+:\d+:\d+\)/,   // JS stack trace frame
  /\bpanic:/i,                       // Go panic
  /\bRuntimeError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bImportError\b/i,
  /\bModuleNotFoundError\b/i,
  /\bConnectionRefused\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOENT\b/i,
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /\bcrash(?:ed|es)?\b/i,   // crash / crashed / crashes (was /crashed?/ which required the 'e')
];

// Generic / weak words — too noisy to trigger a store on their own ("0 errors",
// "the test that failed now passes", "timeout increased and it worked"). Kept
// ONLY to widen the context window in extractErrorContext, never as a trigger.
const GENERIC_ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bfailure\b/i,
  /\btimeout\b/i,
];

// Union — used by extractErrorContext to locate the relevant region of output.
const ERROR_PATTERNS = [...STRUCTURED_ERROR_PATTERNS, ...GENERIC_ERROR_PATTERNS];

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function outputContinue(): void {
  console.log(JSON.stringify({}));
}

function getOpcDir(): string {
  return process.env.CLAUDE_OPC_DIR || join(process.env.HOME || process.env.USERPROFILE || '', 'continuous-claude', 'opc');
}

function responseToString(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response === null || response === undefined) return '';
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}

/**
 * The TRIGGER predicate: only structured/strong signals warrant a capture.
 * Generic words alone ("error", "failed") are intentionally NOT enough — they
 * are the dominant false-positive / recall-pollution source (review S2).
 */
export function hasStructuredError(text: string): boolean {
  return STRUCTURED_ERROR_PATTERNS.some(p => p.test(text));
}

function extractErrorContext(response: string, maxLen = 500): string {
  // Try to extract the most relevant error portion
  const lines = response.split('\n');

  // Look for lines with error patterns
  const errorLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      // Include context: 2 lines before and 3 lines after
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 4);
      errorLines.push(...lines.slice(start, end));
      break;
    }
  }

  if (errorLines.length > 0) {
    return errorLines.join('\n').substring(0, maxLen);
  }

  // If no specific error found, return beginning and end
  if (response.length <= maxLen) return response;
  return response.substring(0, maxLen / 2) + '\n...\n' + response.substring(response.length - maxLen / 2);
}

export interface StoreInvocation {
  cmd: string;
  args: string[];
  options: {
    cwd: string;
    shell: false;
    detached: true;
    stdio: 'ignore';
    windowsHide: true;
  };
}

/**
 * Pure builder for the store_learning.py invocation (mirrors F1's
 * buildDaemonInvocation pattern). shell:false + per-arg argv = no shell, so the
 * content is handed to Python verbatim with zero injection surface. detached +
 * stdio:'ignore' make it FIRE-AND-FORGET so the store can outlive this
 * short-lived hook process.
 */
export function buildStoreInvocation(
  opcDir: string,
  sessionId: string,
  content: string,
  contextStr: string,
  tagsStr: string,
): StoreInvocation {
  return {
    cmd: 'uv',
    args: [
      'run', 'python', 'scripts/core/store_learning.py',
      '--session-id', sessionId,
      '--type', 'FAILED_APPROACH',
      '--content', content,
      '--context', contextStr,
      '--tags', tagsStr,
      '--confidence', 'medium',
      '--source', 'hook',
    ],
    options: { cwd: opcDir, shell: false, detached: true, stdio: 'ignore', windowsHide: true },
  };
}

/**
 * Release a detached child, but only ONCE THE OS REPORTS IT RUNNING.
 *
 * `unref()` followed by the parent exiting in the SAME synchronous tick KILLS the
 * child. That is not a guess -- measured 2026-07-29 with one variable, four arms,
 * identical spawn:
 *
 *   exit in the same tick as the spawn (what this hook did)  -> NO row
 *   exit one tick later, on the 'spawn' event                -> row lands
 *   exit after a 500 ms grace                                 -> row lands
 *   launched via an OS-level breakaway (cmd start /b)         -> row lands
 *
 * That pattern also RULES OUT Windows job-object teardown, the obvious rival
 * explanation: if job closure at parent exit were killing the child, the two arms
 * that merely exit a tick later would have failed too. Only the breakaway arm
 * would have survived. It is a startup race, so one event-loop turn fixes it.
 *
 * Why this mattered: 09ba655 (QW-04) made this store detached + unref'd to stop a
 * ~10 s `spawnSync` blocking Task completion. It fixed the latency and silently
 * broke the delivery -- combined with the noise-prefix bug from 05abf54, this hook
 * stored NOTHING for 161 days, while logging "Dispatched" and exiting 0.
 *
 * Cost of the fix: one event-loop turn (~1-5 ms), not the 10 s QW-04 removed. Node
 * guarantees exactly one of 'spawn' / 'error' fires, so the loop cannot be held
 * open indefinitely. A stub child without `.once` (unit tests) is released
 * immediately, which is why the tests assert the real path separately.
 */
export function releaseWhenRunning(child: { unref?: () => void; once?: (e: string, f: () => void) => void }): void {
  const release = () => {
    try {
      child.unref?.();
    } catch {
      // Already gone -- nothing to release.
    }
  };
  if (typeof child.once !== 'function') {
    release();
    return;
  }
  child.once('spawn', release);
  child.once('error', release);
}

/** Injectable seams so storeLearning is unit-testable without fs/scorer/child_process. */
interface StoreDeps {
  spawnFn?: typeof spawn;
  scoreFn?: typeof scoreExtraction;
  existsFn?: (p: string) => boolean;
}

export function storeLearning(
  sessionId: string,
  agentType: string,
  prompt: string,
  errorContext: string,
  deps: StoreDeps = {},
): void {
  const spawnFn = deps.spawnFn ?? spawn;
  const scoreFn = deps.scoreFn ?? scoreExtraction;
  const existsFn = deps.existsFn ?? existsSync;

  const opcDir = getOpcDir();
  const storeScript = join(opcDir, 'scripts', 'core', 'store_learning.py');

  if (!existsFn(storeScript)) {
    console.error('[AgentErrorCapture] store_learning.py not found');
    return;
  }

  // Build content for the learning.
  //
  // The wording is load-bearing, not cosmetic. From 2026-02-18 to 2026-07-29 this
  // read `Agent '${agentType}' error: ...` and EVERY learning was silently
  // discarded at ingestion: store_learning.py's NOISE_PREFIXES blacklists
  // "Agent '" and checks it FIRST, before any other gate. Commit 05abf54 added
  // that blacklist AND rewrote this line to emit the prefix it had just
  // blacklisted, in the same diff -- while deleting 138 rows of this output as
  // garbage. Verified 2026-07-29: 0 of 622 archival_memory rows came from here.
  // The store returns {"success": true, "skipped": true} and exits 0, and the
  // spawn below uses stdio:'ignore', so the drop was invisible from both ends.
  //
  // THREE constraints on any rewording, and the third bites hardest
  // (store_learning.py:167, :152, and store_learning_v2's dedup):
  //   1. must NOT start with any NOISE_PREFIXES entry -- currently "Agent '",
  //      "Now I have", "Let me ", "The user wants", "I need to", "Looking at",
  //      "I notice the", "The user sent".
  //   2. FAILED_APPROACH has a 100-char minimum, so a very terse errorContext
  //      (a bare "EPERM") is dropped as too_short. That is accepted -- see below.
  //   3. **KEEP THE BOILERPLATE SHORT.** The store dedups at 0.85 EMBEDDING
  //      similarity. A first attempt at this fix used a ~95-char fixed lead-in to
  //      guarantee constraint 2, and measured 0.88 similarity between two
  //      unrelated agent failures -- meaning the first failure would store and
  //      every later one would be silently skipped as a duplicate. Trading a
  //      guaranteed floor for boilerplate dominance is the wrong trade: dropping
  //      an ultra-terse error loses one thin learning, while dedup collisions
  //      lose ALL BUT THE FIRST. So the wording below is deliberately minimal and
  //      leads with the distinctive material.
  const content = `${errorContext} -- task failure in the ${agentType} agent, which did not complete.`;

  // G3 / Task #6: gate the store with the TypeScript memory-quality-scorer BEFORE
  // spawning. NOISE (<3) is dropped with a stderr log; SIGNAL (>=5) / BORDERLINE
  // (3-4) proceed. prompt is intentionally not stored (the error context is the
  // signal; the prompt is often large and low-value for recall).
  void prompt;
  const score = scoreFn(content, `Failed agent invocation: ${agentType}`);
  if (score.classification === 'NOISE') {
    console.error(
      `[AgentErrorCapture] Skipped NOISE (score=${score.score}) for agent '${agentType}': ` +
      score.reasons.join('; '),
    );
    return;
  }

  const tags = [
    'auto_captured',
    'agent_failure',
    `agent:${agentType}`,
    'scope:global',
    `quality:${score.classification.toLowerCase()}`,
    `score:${score.score}`,
  ];

  try {
    // QW-04 hot-path fix: FIRE-AND-FORGET. The previous spawnSync blocked Task
    // completion for up to 10s (uv+python+psycopg boot) on EVERY captured failure.
    // Now spawn detached with ignored stdio + unref() so the store runs in the
    // background and never delays the agent's return. QW-01 no-shell safety kept.
    const { cmd, args, options } = buildStoreInvocation(
      opcDir,
      sessionId,
      content,
      `Failed agent invocation: ${agentType}`,
      tags.join(','),
    );
    // Through the relay: a plain detached uv opens a visible console for python.
    const child = spawnDetachedHidden(cmd, args, options, spawnFn);
    releaseWhenRunning(child);
    console.error(`[AgentErrorCapture] Dispatched (detached) failure learning for agent '${agentType}'`);
  } catch (err) {
    console.error(`[AgentErrorCapture] Failed to dispatch learning: ${err}`);
  }
}

async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      outputContinue();
      return;
    }

    let input: PostToolUseInput;
    try {
      input = JSON.parse(rawInput);
    } catch {
      outputContinue();
      return;
    }

    // Only process Agent/Task tool results
    if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') {
      outputContinue();
      return;
    }

    const agentType = input.tool_input.subagent_type || 'unknown';
    const prompt = input.tool_input.prompt || input.tool_input.description || '';
    const responseStr = responseToString(input.tool_response);

    // Trigger ONLY on structured error signals (named exceptions, stack traces,
    // errno, panic, crash). Bare "error"/"failed" prose is intentionally ignored
    // — it is the dominant recall-pollution source (review S2).
    if (hasStructuredError(responseStr)) {
      const errorContext = extractErrorContext(responseStr);

      console.error(`[AgentErrorCapture] Detected structured error in ${agentType} agent response`);

      // Fire-and-forget store (detached) — does not block Task completion.
      storeLearning(
        input.session_id,
        agentType,
        prompt,
        errorContext,
      );
    }

    outputContinue();

  } catch (err) {
    // Fail silently - don't disrupt the session
    console.error(`[AgentErrorCapture] Hook error: ${err}`);
    outputContinue();
  }
}

// Only auto-run when invoked directly as a hook (not when imported by tests).
// process.argv[1] is the bundled dist filename when Claude Code runs the hook.
if (process.argv[1] && process.argv[1].includes('agent-error-capture')) {
  main();
}
