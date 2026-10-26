#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/coderabbit-guard.ts
import { execSync } from "child_process";
import { existsSync, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname as dirname2, join as join2 } from "path";

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

// src/coderabbit-guard.ts
var BASH_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var DELEGATE_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent", "Skill"]);
var STATE_BASENAME = "coderabbit-guard-runs.json";
var MAX_RUNS = 2;
var OVERRIDE = "SKIP_CODERABBIT_GUARD=1";
function statePath(env = process.env) {
  const base = env.CCV3_CODERABBIT_GUARD_STATE || join2(tmpdir(), STATE_BASENAME);
  return base;
}
function readState(path) {
  try {
    if (!existsSync(path)) return { counts: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { counts: parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : {} };
  } catch {
    return { counts: {} };
  }
}
function writeState(path, state) {
  try {
    mkdirSync2(dirname2(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
  }
}
function segmentize(command) {
  return command.split(/\|\||&&|[;|&\n(]|\$\(|`/).map((p) => p.trim()).filter(Boolean);
}
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
  return base.replace(/\.(exe|cmd|bat|ps1)$/, "");
}
function isCrExecutable(exe) {
  return exe === "cr" || exe === "coderabbit";
}
function hasForbiddenFlags(segment) {
  if (/(?:^|\s)--use-credits\b/i.test(segment)) return "--use-credits";
  if (/(?:^|\s)--api-key\b/i.test(segment)) return "--api-key";
  return null;
}
function isCodeWorkspace(segment) {
  return /\b(?:cr|coderabbit)\b[^&|;]*\bcode\s+(?:new|push)\b/i.test(segment);
}
function isAllowedReviewAgent(segment) {
  if (!/\breview\b/i.test(segment)) return false;
  if (!/--agent\b/i.test(segment)) return false;
  if (hasForbiddenFlags(segment)) return false;
  if (isCodeWorkspace(segment)) return false;
  const exe = leadingExe(segment);
  if (!isCrExecutable(exe)) return false;
  return true;
}
function isSkillInstall(segment) {
  if (/\bnpx\s+skills\s+add\b/i.test(segment) && /coderabbit/i.test(segment)) return true;
  if (/\bcoderabbit\s+skills\b/i.test(segment)) return true;
  return false;
}
function classifyShellSegment(segment) {
  const exe = leadingExe(segment);
  const touchesCr = isCrExecutable(exe) || /\b(?:cr|coderabbit)\b/i.test(segment) || isSkillInstall(segment);
  if (!touchesCr) return { verdict: "ignore" };
  const forbidden = hasForbiddenFlags(segment);
  if (forbidden) return { verdict: "block", reason: `CodeRabbit guard: ${forbidden} is forbidden` };
  if (isCodeWorkspace(segment)) {
    return { verdict: "block", reason: "CodeRabbit guard: code new/push is forbidden" };
  }
  if (isSkillInstall(segment)) {
    return { verdict: "block", reason: "CodeRabbit guard: CodeRabbit skill installs are forbidden" };
  }
  if (isAllowedReviewAgent(segment)) return { verdict: "allow" };
  if (isCrExecutable(exe) || /\b(?:cr|coderabbit)\b/i.test(segment)) {
    return { verdict: "block", reason: "CodeRabbit guard: only plain `cr review --agent` is allowed (\u22642 runs/PR)" };
  }
  return { verdict: "ignore" };
}
function repoBranchKey(cwd = process.cwd(), env = process.env) {
  const fromEnv = env.CCV3_CODERABBIT_GUARD_KEY;
  if (fromEnv) return fromEnv;
  try {
    const root = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    let remote = "local";
    try {
      remote = execSync("git remote get-url origin", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
    }
    const slug = remote.replace(/\.git$/, "").replace(/^.*[/:]/, "");
    return `${slug || "local"}#${branch}`;
  } catch {
    return `cwd#${cwd}`;
  }
}
function checkRunCap(state, key) {
  const count = state.counts[key] ?? 0;
  return { ok: count < MAX_RUNS, count };
}
function recordRun(state, key) {
  const count = (state.counts[key] ?? 0) + 1;
  return { counts: { ...state.counts, [key]: count } };
}
function isReadOnlyAutofixDelegate(input) {
  const text = [input.tool_input?.prompt, input.tool_input?.description].filter(Boolean).join("\n");
  if (!/autofix/i.test(text)) return false;
  if (!/read[- ]only/i.test(text)) return false;
  return true;
}
function classifySkill(input) {
  const skill = String(input.tool_input?.skill ?? "");
  if (!skill) return { verdict: "ignore" };
  if (/^coderabbit:autofix$/i.test(skill) || skill.toLowerCase().includes("coderabbit:autofix")) {
    return { verdict: "block", reason: "CodeRabbit guard: coderabbit:autofix skill is forbidden" };
  }
  return { verdict: "ignore" };
}
function classifyDelegate(input) {
  const skill = classifySkill(input);
  if (skill.verdict === "block") return skill;
  if (isReadOnlyAutofixDelegate(input)) return { verdict: "allow" };
  const cmd = input.tool_input?.command;
  if (cmd) {
    for (const seg of segmentize(cmd)) {
      const c = classifyShellSegment(seg);
      if (c.verdict !== "ignore") return c;
    }
  }
  return { verdict: "ignore" };
}
function decide(input, env = process.env) {
  const tool = input.tool_name || "";
  const command = input.tool_input?.command || "";
  if (command.includes(OVERRIDE)) return { allow: true };
  if (tool === "Skill") {
    const s = classifySkill(input);
    if (s.verdict === "block") return { allow: false, reason: s.reason };
    return { allow: true };
  }
  if (DELEGATE_TOOLS.has(tool)) {
    const d = classifyDelegate(input);
    if (d.verdict === "block") return { allow: false, reason: d.reason };
    if (d.verdict === "allow") return { allow: true };
    return { allow: true };
  }
  if (!BASH_TOOLS.has(tool)) return { allow: true };
  let needsIncrement = false;
  for (const seg of segmentize(command)) {
    const c = classifyShellSegment(seg);
    if (c.verdict === "block") return { allow: false, reason: c.reason };
    if (c.verdict === "allow") needsIncrement = true;
  }
  if (!needsIncrement) return { allow: true };
  const path = statePath(env);
  const state = readState(path);
  const key = repoBranchKey(process.cwd(), env);
  const cap = checkRunCap(state, key);
  if (!cap.ok) {
    return {
      allow: false,
      reason: `CodeRabbit guard: run cap reached (${MAX_RUNS} cr review --agent runs for ${key})`
    };
  }
  writeState(path, recordRun(state, key));
  return { allow: true, increment: true };
}
function readStdin() {
  return readFileSync(0, "utf-8");
}
function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }
  const result = decide(input);
  if (!result.allow) {
    logGuardDecision("coderabbit-guard", input, "deny", result.reason || "blocked", {
      command: input.tool_input?.command
    });
    outputDeny(result.reason || "CodeRabbit guard: blocked");
    return;
  }
  outputContinue();
}
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
export {
  checkRunCap,
  classifyDelegate,
  classifyShellSegment,
  classifySkill,
  decide,
  hasForbiddenFlags,
  isAllowedReviewAgent,
  isCodeWorkspace,
  isCrExecutable,
  isReadOnlyAutofixDelegate,
  isSkillInstall,
  readState,
  recordRun,
  repoBranchKey,
  segmentize,
  statePath,
  writeState
};
