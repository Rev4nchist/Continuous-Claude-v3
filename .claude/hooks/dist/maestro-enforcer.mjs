#!/usr/bin/env node

// src/maestro-enforcer.ts
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
var STATE_FILE = join(tmpdir(), "claude-maestro-state.json");
var STATE_TTL = 60 * 60 * 1e3;
function readState() {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(content);
    if (Date.now() - state.activatedAt > STATE_TTL) {
      unlinkSync(STATE_FILE);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}
function readStdin() {
  return readFileSync(0, "utf-8");
}
function makeBlockOutput(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}
function makeAllowOutput() {
  console.log(JSON.stringify({}));
}
async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      makeAllowOutput();
      return;
    }
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      makeAllowOutput();
      return;
    }
    if (input.tool_name !== "Task") {
      makeAllowOutput();
      return;
    }
    const state = readState();
    if (!state || !state.active) {
      makeAllowOutput();
      return;
    }
    const agentType = input.tool_input.subagent_type?.toLowerCase() || "general-purpose";
    const isScoutAgent = agentType === "scout" || agentType === "explore";
    if (!state.reconComplete) {
      if (isScoutAgent) {
        makeAllowOutput();
        return;
      } else {
        makeBlockOutput(`
\u{1F6D1} MAESTRO WORKFLOW: Recon Phase

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
    if (!state.interviewComplete) {
      makeBlockOutput(`
\u{1F6D1} MAESTRO WORKFLOW: Interview Phase

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
    if (!state.planApproved) {
      makeBlockOutput(`
\u{1F6D1} MAESTRO WORKFLOW: Awaiting Approval

Interview complete. Plan presented.

**WAITING FOR:** User to approve the plan.

**BLOCKED:** All agents until user says "yes" or "approve".

**DO NOT spawn agents until explicit approval.**
`);
      return;
    }
    makeAllowOutput();
  } catch (err) {
    makeAllowOutput();
  }
}
main();
