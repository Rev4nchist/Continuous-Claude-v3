#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/scan-scope-guard.ts
import { readFileSync } from "fs";

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}
function outputDeny(reason, decision = "deny") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
}

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

// src/scan-scope-guard.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var BLOCKED = /* @__PURE__ */ new Set([
  "nuclei",
  "sqlmap",
  "nikto",
  "masscan",
  "wpscan",
  "dalfox",
  "zap-baseline",
  "zap-baseline.py"
]);
function leadingExe(segment) {
  let s = segment.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, "");
  } while (s !== prev);
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return "";
  let tok = m[1] || m[2] || m[3] || "";
  tok = tok.replace(/\\/g, "/");
  const base = tok.slice(tok.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/, "");
}
function segmentize(command) {
  return command.split(/\|\||&&|[;|&\n(]|\$\(|`/).map((p) => p.trim()).filter(Boolean);
}
function blockedTool(command) {
  for (const seg of segmentize(command)) {
    const exe = leadingExe(seg);
    if (BLOCKED.has(exe)) return exe;
  }
  return null;
}
function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    outputContinue();
    return;
  }
  if (!COMMAND_TOOLS.has(input.tool_name)) {
    outputContinue();
    return;
  }
  const command = input.tool_input?.command;
  if (!command) {
    outputContinue();
    return;
  }
  const tool = blockedTool(command);
  if (!tool) {
    outputContinue();
    return;
  }
  logGuardDecision("scan-scope-guard", input, "deny", tool, { command });
  outputDeny(
    `SCAN SCOPE: direct "${tool}" is blocked. Active scanners run through the scope gate: node "$HOME/.claude/scripts/security/scoped-scan.mjs" web <url> (deny by default, owned targets only). See the security-scan skill. Scanning a host you do not own may be illegal.`
  );
}
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
export {
  BLOCKED,
  blockedTool,
  leadingExe,
  segmentize
};
