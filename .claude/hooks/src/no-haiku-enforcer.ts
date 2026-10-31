#!/usr/bin/env node
/**
 * Model-Policy Enforcer Hook - PreToolUse (Agent|Task)
 *
 * (1) Blocks Task/Agent calls with model="haiku" (~/.claude/CLAUDE.md ("Agents and delegation")).
 * (2) Standing guard: denies all spawns if CLAUDE_CODE_SUBAGENT_MODEL is set — it
 *     overrides every agent's frontmatter and flattens the two-tier map to one model
 *     (~/.claude/rules/agent-model-selection.md).
 *
 * Fix (haiku): use model="sonnet", or omit it for an ad-hoc chat-level call.
 */

import { logGuardDecision, logGuardError } from './shared/guard-log.js';

export interface HookInput {
  tool?: string;
  tool_name?: string;
  tool_input?: {
    model?: string;
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

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Pure decision for the model policy: returns a deny output, else null (passthrough).
 * `subagentModelEnv` is injected for testability (defaults to the live env var).
 */
export function decide(
  input: HookInput,
  subagentModelEnv: string | undefined = process.env.CLAUDE_CODE_SUBAGENT_MODEL,
): HookOutput | null {
  const tool = input.tool || input.tool_name;
  const model = input.tool_input?.model;
  const isSpawn = tool === 'Agent' || tool === 'Task';

  // (2) Standing guard (E4): CLAUDE_CODE_SUBAGENT_MODEL flattens the two-tier map.
  if (isSpawn && subagentModelEnv) {
    return deny(`BLOCKED: CLAUDE_CODE_SUBAGENT_MODEL is set (="${subagentModelEnv}").

It overrides every agent's frontmatter and FLATTENS the two-tier model map to one model.
Unset it (it must never be set) — see ~/.claude/rules/agent-model-selection.md.`);
  }

  // (1) Block model="haiku"
  if (!isSpawn || model?.toLowerCase() !== 'haiku') {
    return null;
  }

  return deny(`BLOCKED: model='haiku' not allowed.

Per ~/.claude/CLAUDE.md ("Agents and delegation"):
- Haiku is unreliable for agent tasks
- Use model='sonnet' (or model='opus' for judgment-dense work)
- Or omit the model parameter for a genuinely ad-hoc chat-level call`);
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
  } catch (err) {
    logGuardError('no-haiku-enforcer', err);
    console.log('{}');
    return;
  }

  const output = decide(input);
  if (output) {
    logGuardDecision('no-haiku-enforcer', input, 'deny', output.hookSpecificOutput.permissionDecisionReason.split('\n')[0]);
  }
  console.log(output ? JSON.stringify(output) : '{}');
}

main().catch((err) => {
  logGuardError('no-haiku-enforcer', err);
  console.log('{}');
});
