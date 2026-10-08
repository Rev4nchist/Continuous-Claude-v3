#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/agent-model-guard.ts
import { readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join as join2, isAbsolute } from "path";
import { homedir as homedir2 } from "os";
import { fileURLToPath } from "url";

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, ".claude", "logs", "guard-decisions.jsonl");
}
var SECRET_NAME = "[\\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*";
var MASKS = [
  // A URL inside quotes may hold a password with a space: the closing quote ends it, not the space.
  [/(["'])([a-z][\w+.-]*:\/\/)[^\s/@:"']+:(?:(?!\1)[^/@])+@/gi, "$1$2***@"],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@"],
  // `curl -u user:pass`, `curl --user user:pass`. A numeric user (`docker run -u 1000:1000`) is a uid:gid.
  // Quoting decides where the credential ends: `-u "user:two words"`, `-u user:"two words"`.
  [/(\s(?:-u[\s=]*|--user[\s=]+)")(?!\d+:)([^":]+):[^"]*"/g, '$1$2:***"'],
  [/(\s(?:-u[\s=]*|--user[\s=]+)')(?!\d+:)([^':]+):[^']*'/g, "$1$2:***'"],
  [/(\s(?:-u[\s=]*|--user[\s=]+))(?!\d+:)([^\s:"']+):(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1$2:***"],
  // `mysql -uroot -pS3cret`: the password is glued to -p. Case matters: -P is the port.
  [/(\b(?:mysql|mariadb)\w*\b[^|;&\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1***"],
  // `sshpass -p pw ssh host`
  [/(\bsshpass\s+-p\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, "$1***"],
  [/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, "$1 ***"],
  [new RegExp(`(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`, "gi"), "$1$2***"],
  [new RegExp(`(--?${SECRET_NAME})(\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`, "gi"), "$1$2***"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "***"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***"],
  [/\bgithub_pat_\w+/g, "***"],
  [/\bxox[abprs]-[\w-]+/g, "***"],
  [/\bnpm_[A-Za-z0-9]{20,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\bAIza[\w-]{30,}/g, "***"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***"],
  // Any other long opaque run that mixes letters and digits (hex, base64url keys).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, "***"]
];
function maskSecrets(text) {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
function commandHead(command) {
  return maskSecrets(command).replace(/\s+/g, " ").trim().slice(0, COMMAND_HEAD_CHARS);
}
function shouldWrite(env) {
  return !!env.CCV3_GUARD_DECISIONS_LOG || !env.VITEST;
}
function logGuardDecision(hook, input, decision, reason, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || void 0;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      hook,
      tool: input?.tool_name || input?.tool || "",
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || ""
    };
    if (agent) entry.agent_id = agent;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path = guardLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/agent-model-guard.ts
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
    if (root && isAbsolute(root)) dirs.push(join2(root, ".claude", "agents"));
  }
  dirs.push(join2(env.home, ".claude", "agents"));
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
        if (fileExists(join2(dir, `${agentType}.md`))) return { allow: true };
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
  const decision = decide(input, { home: homedir2(), projectDir: process.env.CLAUDE_PROJECT_DIR });
  if (decision.allow) outputContinue();
  else {
    logGuardDecision("agent-model-guard", input, "deny", `agent-not-found: ${String(input.tool_input?.subagent_type).slice(0, 60)}`);
    outputBlock(decision.reason);
  }
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
