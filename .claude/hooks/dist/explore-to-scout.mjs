#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/explore-to-scout.ts
var DENY_REASON = `BLOCKED: subagent_type='Explore' is not allowed.

Per ~/.claude/CLAUDE.md ("Agents and delegation"):
- Explore uses Haiku -- fast but inaccurate
- Scout uses Sonnet with a detailed prompt -- accurate results

REMOVE subagent_type="Explore" and use subagent_type="scout" instead.`;
function decide(input) {
  const tool = input.tool || input.tool_name;
  const subagentType = input.tool_input?.subagent_type;
  if (tool !== "Agent" && tool !== "Task" || subagentType?.toLowerCase() !== "explore") {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON
    }
  };
}
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  let input = {};
  try {
    const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
    if (rawInput) input = JSON.parse(rawInput);
  } catch {
    console.log("{}");
    return;
  }
  const output = decide(input);
  console.log(output ? JSON.stringify(output) : "{}");
}
main().catch(() => {
  console.log("{}");
});
export {
  decide
};
