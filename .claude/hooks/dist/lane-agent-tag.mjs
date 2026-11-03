#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lane-agent-tag.ts
import { readFileSync } from "fs";
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var LANE_VERB_RE = /(\bnode(?:\.exe)?["']?\s+["']?[^\s"'|;&]*lane\.mjs["']?\s+)(say|note)(?=\s|$)/g;
var AGENT_TYPE_RE = /^[A-Za-z0-9_-]{1,40}$/;
function tagLaneCommand(command, agentType) {
  if (!AGENT_TYPE_RE.test(agentType)) return null;
  let changed = false;
  const out = command.replace(LANE_VERB_RE, (m, head, verb, offset, whole) => {
    if (/^\s+--agent\b/.test(whole.slice(offset + m.length))) return m;
    changed = true;
    return `${head}${verb} --agent ${agentType}`;
  });
  return changed ? out : null;
}
function run(raw) {
  try {
    const input = JSON.parse(raw);
    if (!input.tool_name || !COMMAND_TOOLS.has(input.tool_name)) return {};
    const command = input.tool_input?.command;
    if (typeof command !== "string" || typeof input.agent_type !== "string") return {};
    if (typeof input.agent_id !== "string" || !input.agent_id) return {};
    const tagged = tagLaneCommand(command, input.agent_type);
    if (tagged === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...input.tool_input, command: tagged }
      }
    };
  } catch {
    return {};
  }
}
if (/(^|[\\/])lane-agent-tag\.(mjs|js|ts)$/.test(process.argv[1] || "")) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch {
  }
  console.log(JSON.stringify(run(raw)));
}
export {
  run,
  tagLaneCommand
};
