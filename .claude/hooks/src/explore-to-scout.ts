#!/usr/bin/env node
/**
 * Explore to Scout Hook - PreToolUse (Agent|Task)
 *
 * Blocks subagent_type="Explore" with permissionDecision: "deny" (backstop).
 * Note: PreToolUse hooks CAN return updatedInput (tldr-context-inject rewrites `prompt`
 * on this same Task matcher), but rewriting `subagent_type` Explore->scout is UNVERIFIED
 * (2026-07-07) — so we hard-deny rather than silently auto-rewrite an Explore onto Haiku.
 * The root-cause fixes are the smart-search-router self-contradiction patch (it used to
 * recommend Explore) + the use-scout-not-explore rule.
 */

export interface HookInput {
  tool?: string;
  tool_name?: string;
  tool_input?: {
    subagent_type?: string;
    [key: string]: unknown;
  };
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

const DENY_REASON = `BLOCKED: subagent_type='Explore' is not allowed.

Per ~/.claude/CLAUDE.md ("Agents and delegation"):
- Explore uses Haiku -- fast but inaccurate
- Scout uses Sonnet with a detailed prompt -- accurate results

REMOVE subagent_type="Explore" and use subagent_type="scout" instead.`;

/** Pure decision: deny output for an Explore spawn, else null (passthrough). */
export function decide(input: HookInput): HookOutput | null {
  const tool = input.tool || input.tool_name;
  const subagentType = input.tool_input?.subagent_type;

  // Only intercept Agent/Task with subagent_type="Explore" (case-insensitive)
  if ((tool !== 'Agent' && tool !== 'Task') || subagentType?.toLowerCase() !== 'explore') {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let input: HookInput = {};
  try {
    const rawInput = Buffer.concat(chunks).toString('utf-8').trim();
    if (rawInput) input = JSON.parse(rawInput);
  } catch {
    console.log('{}');
    return;
  }

  const output = decide(input);
  console.log(output ? JSON.stringify(output) : '{}');
}

main().catch(() => {
  console.log('{}');
});
