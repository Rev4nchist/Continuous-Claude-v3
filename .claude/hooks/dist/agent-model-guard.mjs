#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/agent-model-guard.ts
import { readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join, isAbsolute } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
var BUILTIN_AGENTS = /* @__PURE__ */ new Set([
  "Bash",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "claude-code-guide",
  "claude"
]);
function readStdin() {
  return readFileSync(0, "utf-8");
}
function outputContinue() {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow"
    }
  };
  console.log(JSON.stringify(output));
}
function outputBlock(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}
function agentDirs(cwd, env) {
  const roots = [typeof cwd === "string" ? cwd : void 0, env.projectDir];
  const dirs = [];
  for (const root of roots) {
    if (root && isAbsolute(root)) dirs.push(join(root, ".claude", "agents"));
  }
  dirs.push(join(env.home, ".claude", "agents"));
  const seen = /* @__PURE__ */ new Set();
  return dirs.filter((d) => {
    const key = d.replace(/\\/g, "/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}
function listAgents(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}
function findSimilarAgents(agentType, available) {
  const lower = agentType.toLowerCase();
  return available.filter((a) => {
    const aLower = a.toLowerCase();
    return aLower.includes(lower) || lower.includes(aLower) || levenshteinDistance(lower, aLower) <= 3;
  }).slice(0, 3);
}
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
function decide(input, env) {
  if (input?.tool_name !== "Agent" && input?.tool_name !== "Task") return { allow: true };
  const agentType = input.tool_input?.subagent_type;
  if (typeof agentType !== "string" || !agentType) return { allow: true };
  if (BUILTIN_AGENTS.has(agentType) || agentType.includes(":")) return { allow: true };
  try {
    const dirs = agentDirs(input.cwd, env);
    const safeName = !/[\\/]|\.\./.test(agentType);
    if (safeName) {
      for (const dir of dirs) {
        if (fileExists(join(dir, `${agentType}.md`))) return { allow: true };
      }
    }
    const available = [...new Set(dirs.flatMap(listAgents))];
    const similar = findSimilarAgents(agentType, available);
    let message = `Agent "${agentType}" not found in ${dirs.join(" or ")}`;
    if (similar.length > 0) message += `

Did you mean: ${similar.join(", ")}?`;
    message += `

Available custom agents: ${available.slice(0, 10).join(", ")}${available.length > 10 ? "..." : ""}`;
    return { allow: false, reason: message };
  } catch {
    return { allow: true };
  }
}
function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }
  const decision = decide(input, { home: homedir(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (decision.allow) outputContinue();
  else outputBlock(decision.reason);
}
function isDirectRun() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectRun()) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
export {
  BUILTIN_AGENTS,
  agentDirs,
  decide
};
