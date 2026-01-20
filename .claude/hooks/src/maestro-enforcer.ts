#!/usr/bin/env node
/**
 * Maestro Enforcer Hook
 *
 * Enforces the Maestro workflow by blocking Task tool until discovery interview is complete.
 *
 * Workflow:
 * 1. User activates Maestro (tracked via temp file)
 * 2. This hook BLOCKS Task tool until interview is marked complete
 * 3. Interview is marked complete when user provides discovery answers
 *
 * Runs on PreToolUse:Task
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface HookInput {
  tool_name: string;
  tool_input: {
    prompt?: string;
    description?: string;
    subagent_type?: string;
  };
}

interface MaestroState {
  active: boolean;
  taskType: 'implementation' | 'research' | 'unknown';
  reconComplete: boolean;
  interviewComplete: boolean;
  planApproved: boolean;
  activatedAt: number;
}

const STATE_FILE = join(tmpdir(), 'claude-maestro-state.json');
const STATE_TTL = 60 * 60 * 1000; // 1 hour

function readState(): MaestroState | null {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as MaestroState;
    // Expire old state
    if (Date.now() - state.activatedAt > STATE_TTL) {
      unlinkSync(STATE_FILE);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function writeState(state: MaestroState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch {
    // Ignore write errors
  }
}

function clearState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
  } catch {
    // Ignore
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function makeBlockOutput(reason: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}

function makeAllowOutput(): void {
  console.log(JSON.stringify({}));
}

async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      makeAllowOutput();
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(rawInput);
    } catch {
      makeAllowOutput();
      return;
    }

    // Only process Task tool calls
    if (input.tool_name !== 'Task') {
      makeAllowOutput();
      return;
    }

    const state = readState();

    // If Maestro not active, allow all Task calls
    if (!state || !state.active) {
      makeAllowOutput();
      return;
    }

    // Maestro is active - check workflow phase and agent type
    const agentType = input.tool_input.subagent_type?.toLowerCase() || 'general-purpose';
    const isScoutAgent = agentType === 'scout' || agentType === 'explore';

    // PHASE 1: Recon (implementation tasks only)
    // Allow scout agents, block everything else
    if (!state.reconComplete) {
      if (isScoutAgent) {
        // Allow scout during recon phase
        makeAllowOutput();
        return;
      } else {
        makeBlockOutput(`
🛑 MAESTRO WORKFLOW: Recon Phase

Currently in **Codebase Recon** phase.

**ALLOWED:** scout agents only (to explore codebase)
**BLOCKED:** ${agentType} agent

**WHY:** Need to understand the codebase before asking informed questions.

**TO PROCEED:**
1. Use scout agents to explore relevant code
2. Say "recon complete" when done
3. Then conduct discovery interview

Current agent "${agentType}" is blocked until recon complete.
`);
        return;
      }
    }

    // PHASE 2: Interview
    // Block all Task tools - must use AskUserQuestion
    if (!state.interviewComplete) {
      makeBlockOutput(`
🛑 MAESTRO WORKFLOW: Interview Phase

Recon complete. Now in **Discovery Interview** phase.

**REQUIRED:** Use AskUserQuestion to ask informed questions:
- Based on recon findings
- About scope, approach, constraints
- To clarify requirements

**BLOCKED:** All agents until interview complete.

**TO PROCEED:**
1. Ask discovery questions using AskUserQuestion
2. Say "interview complete" when done
3. Then propose orchestration plan
`);
      return;
    }

    // PHASE 3: Plan Approval
    // Block all Task tools - must wait for user approval
    if (!state.planApproved) {
      makeBlockOutput(`
🛑 MAESTRO WORKFLOW: Awaiting Approval

Interview complete. Plan presented.

**WAITING FOR:** User to approve the plan.

**BLOCKED:** All agents until user says "yes" or "approve".

**DO NOT spawn agents until explicit approval.**
`);
      return;
    }

    // PHASE 4: Execution - all agents allowed
    makeAllowOutput();

  } catch (err) {
    // Fail open - don't block on errors
    makeAllowOutput();
  }
}

main();
