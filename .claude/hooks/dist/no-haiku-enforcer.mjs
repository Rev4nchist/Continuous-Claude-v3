#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/no-haiku-enforcer.ts
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}
function decide(input, subagentModelEnv = process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
  const tool = input.tool || input.tool_name;
  const model = input.tool_input?.model;
  const isSpawn = tool === "Agent" || tool === "Task";
  if (isSpawn && subagentModelEnv) {
    return deny(`BLOCKED: CLAUDE_CODE_SUBAGENT_MODEL is set (="${subagentModelEnv}").

It overrides every agent's frontmatter and FLATTENS the two-tier model map to one model.
Unset it (it must never be set) \u2014 see ~/.claude/rules/agent-model-selection.md.`);
  }
  if (!isSpawn || model?.toLowerCase() !== "haiku") {
    return null;
  }
  return deny(`BLOCKED: model='haiku' not allowed.

Per ~/.claude/CLAUDE.md ("Agents and delegation"):
- Haiku is unreliable for agent tasks
- Use model='sonnet' (or model='opus' for judgment-dense work)
- Or omit the model parameter for a genuinely ad-hoc chat-level call`);
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
