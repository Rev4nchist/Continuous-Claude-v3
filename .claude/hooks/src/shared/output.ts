/**
 * Shared output helpers for Claude Code hooks.
 *
 * WHAT WAS WRONG (verified 2026-07-28, controlled experiment)
 * -----------------------------------------------------------
 * Two of the three helpers in this file emitted a shape Claude Code IGNORES:
 *
 *     outputWithMessage -> {"result":"continue","message":"..."}
 *     outputBlock       -> {"result":"block","message":"..."}
 *
 * The harness reads `hookSpecificOutput`. It does not read `result`/`message`.
 * So every hook that used these to speak to the model was emitting into a void,
 * exiting 0, and looking healthy. The file's own docstring said "All hooks MUST
 * output valid JSON" -- which was true, and beside the point. Valid JSON in a
 * shape nobody reads is still silence.
 *
 * HOW WE KNOW, rather than infer
 * ------------------------------
 * `guardrail-enforcer` is registered on UserPromptSubmit. A session prompt
 * containing "bugs"/"fix" tripped its systematic-debugging trigger and it FIRED
 * at 19:18:35 -- proven by $TEMP/claude-guardrails-45972.json, written that
 * second with acknowledgedGuardrails:["systematic-debugging"]. Its guardrail
 * text appeared NOWHERE in the transcript. On the SAME prompt, in the SAME
 * event, `memory-awareness` -- which emits hookSpecificOutput.additionalContext
 * -- injected fine. Two hooks, one event, one prompt, different output shape,
 * one reaches the model and one does not.
 *
 * It survived ~186 days because six test files assert the broken shape, so a
 * green suite could never detect it.
 *
 * THE TWO SHAPES THE HARNESS ACTUALLY READS
 * -----------------------------------------
 * Both copied from hooks demonstrably working in production, not from docs:
 *
 *   inject   {hookSpecificOutput:{hookEventName, additionalContext}}
 *              -- memory-awareness.ts, observed injecting this session
 *   gate     {hookSpecificOutput:{hookEventName:'PreToolUse',
 *                                 permissionDecision, permissionDecisionReason}}
 *              -- destructive-command-guard.ts:404
 *
 * WHY hookEventName IS REQUIRED AND NOT DEFAULTED
 * ----------------------------------------------
 * A default would let a PostToolUse hook keep silently emitting a
 * UserPromptSubmit envelope -- the same class of bug, one layer down, and
 * invisible again. Requiring it makes the compiler walk every call site. That is
 * deliberate: the type error IS the ratchet.
 */

/** Events whose hooks may inject text into the model's context. */
export type InjectEvent = 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart';

/**
 * "Nothing to say." The one helper that was always correct -- it is a no-op
 * signal the harness is happy to receive, and carries no message to lose.
 */
export function outputContinue(): void {
  console.log(JSON.stringify({ result: 'continue' }));
}

/**
 * Inject text into the model's context.
 *
 * An empty message degrades to outputContinue rather than emitting an empty
 * additionalContext -- injecting "" is indistinguishable from a bug at the
 * receiving end.
 */
export function outputWithMessage(message: string, hookEventName: InjectEvent): void {
  if (!message || !message.trim()) {
    outputContinue();
    return;
  }
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: message },
  }));
}

/**
 * Strongly-worded context injection for UserPromptSubmit / PostToolUse /
 * SessionStart.
 *
 * NOT a real block, and named to stop implying otherwise. Only PreToolUse can
 * refuse a tool call -- use `outputDeny` for that. `guardrail-enforcer` already
 * carried a comment admitting "UserPromptSubmit hooks can't truly block - they
 * inject context" three lines above the emission that then failed to inject.
 */
export function outputBlock(message: string, hookEventName: InjectEvent): void {
  outputWithMessage(message, hookEventName);
}

/**
 * Refuse (or prompt for) a tool call. PreToolUse only -- it is the sole event
 * whose return value can stop a tool from running.
 *
 * 'ask' prompts the human and is the right choice interactively; 'deny' is
 * fail-closed and the right choice unattended, where an 'ask' would hang.
 */
export function outputDeny(reason: string, decision: 'deny' | 'ask' = 'deny'): void {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}
