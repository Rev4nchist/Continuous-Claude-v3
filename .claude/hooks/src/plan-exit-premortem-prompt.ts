#!/usr/bin/env node
/**
 * Plan Exit Premortem Prompt Hook
 *
 * PostToolUse hook on ExitPlanMode. After a plan is approved, injects a
 * directive into the next assistant turn telling Claude to call
 * AskUserQuestion offering to run /premortem on the just-approved plan.
 *
 * This is a context-injection hook: it never blocks, never writes state.
 * It coexists with plan-exit-tracker (which writes the plan-approved
 * state file) -- both fire on the same tool event.
 *
 * Output: PostToolUse JSON with hookSpecificOutput.additionalContext.
 * Fails open: any error -> output {}.
 */

import { readFileSync } from 'fs';
import { createLogger } from './shared/logger.js';
import { logHook } from './shared/session-activity.js';

const log = createLogger('plan-exit-premortem-prompt');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface HookInput {
  tool_name: string;
  tool_input?: any;
  session_id?: string;
}

interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extracts a plan path from ExitPlanMode tool input, if one is present.
 * The ExitPlanMode tool input may carry either a plan path string under
 * `plan` / `planPath` / `path`, or the plan markdown content under `plan`.
 *
 * We treat the value as a usable path only if it looks like one: a single
 * line (no newlines), short enough to be a path, and contains a path
 * separator or ends with .md. Otherwise we return null so the caller
 * falls back to a generic message.
 */
export function extractPlanPath(toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;

  const candidates = [toolInput.planPath, toolInput.plan_path, toolInput.path, toolInput.plan];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    // Reject anything that looks like markdown content rather than a path.
    if (trimmed.length > 500) continue;
    if (trimmed.includes('\n')) continue;
    const looksLikePath =
      trimmed.endsWith('.md') ||
      trimmed.includes('/') ||
      trimmed.includes('\\');
    if (!looksLikePath) continue;
    return trimmed;
  }
  return null;
}

/**
 * Builds the directive text injected into Claude's context. The directive
 * tells Claude to call AskUserQuestion with the premortem offer.
 */
export function buildDirective(planPath: string | null): string {
  const planClause = planPath
    ? `A plan was just approved (at \`${planPath}\`).`
    : 'A plan was just approved.';

  return [
    `${planClause} Before proceeding to implementation, use the \`AskUserQuestion\` tool to ask the user:`,
    '',
    '  Question: "Run a cross-model /premortem on this plan before implementation? Pick the adversarial reviewer(s)."',
    '  Header: "Premortem"',
    '  Options:',
    '    - "Grok" (description: "Grok adversarial pass on the plan (X Premium+ subscription). A third training family, distinct from Claude. PARKED on this machine since 2026-07-13: corp egress stalls completions.")',
    '    - "Skip -- proceed to implementation" (description: "Move directly to implementation without an explicit risk pass. Use when the plan is trivial or already heavily vetted.")',
    '',
    'After the user answers: Grok -> invoke `/premortem --grok`; Skip -> continue with whatever next step the workflow calls for. There is no second-CLI reviewer.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Handles the ExitPlanMode event by returning a PostToolUse response
 * that injects the AskUserQuestion directive. Returns an empty object
 * for any other tool, or on any error (fail-open).
 */
export function handlePlanExitPrompt(input: any, env: NodeJS.ProcessEnv = process.env): HookResponse {
  try {
    if (!input || typeof input !== 'object') return {};
    if (input.tool_name !== 'ExitPlanMode') return {};
    // No human to answer an AskUserQuestion in a subagent or CI run; the directive only
    // stalls it (2026-09-23 eval, P22).
    if (env.CLAUDE_AGENT_ID || env.CI === 'true' || env.CI === '1') return {};

    const planPath = extractPlanPath(input.tool_input);
    const additionalContext = buildDirective(planPath);

    try {
      logHook(input.session_id || 'unknown', 'plan-exit-premortem-prompt');
    } catch {
      // Never break on activity logging.
    }

    log.info('Premortem prompt injected', {
      sessionId: input.session_id || 'unknown',
      hasPlanPath: planPath !== null,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    };
  } catch (err) {
    log.error('handlePlanExitPrompt failed', { error: String(err) });
    // Fail open.
    return {};
  }
}

// ---------------------------------------------------------------------------
// main() entry point
// ---------------------------------------------------------------------------

function main(): void {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) {
      console.log(JSON.stringify({}));
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({}));
      return;
    }

    const response = handlePlanExitPrompt(input);
    console.log(JSON.stringify(response));
  } catch {
    // Fail open
    console.log(JSON.stringify({}));
  }
}

// Guard: don't run main() when imported by vitest
if (!process.env.VITEST) {
  main();
}
