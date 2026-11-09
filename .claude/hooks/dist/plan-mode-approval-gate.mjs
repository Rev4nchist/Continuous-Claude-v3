#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/plan-mode-approval-gate.ts
import { readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { join as join4 } from "path";
import { homedir as homedir3 } from "os";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join(homedir(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname(LOG_FILE);
var MAX_LOG_SIZE = 5 * 1024 * 1024;
var MIN_LEVEL = process.env.CLAUDE_HOOK_LOG_LEVEL || "info";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || void 0;
}
function writeLog(entry) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function createLogger(hookName) {
  function log2(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId()
    };
    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }
    writeLog(entry);
    if (level === "error" || level === "warn") {
      console.error(`[${hookName}] ${level.toUpperCase()}: ${msg}`);
    }
  }
  return {
    debug: (msg, data) => log2("debug", msg, data),
    info: (msg, data) => log2("info", msg, data),
    warn: (msg, data) => log2("warn", msg, data),
    error: (msg, data) => log2("error", msg, data)
  };
}

// src/shared/session-activity.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join2(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync2(dir, { recursive: true });
  } catch {
  }
  return join2(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync2(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadOrCreate(sessionId) {
  const existing = readActivity(sessionId);
  if (existing) {
    if (!existing.agents) existing.agents = [];
    if (!existing.mcp_servers) existing.mcp_servers = [];
    return existing;
  }
  return {
    session_id: sessionId,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    skills: [],
    hooks: [],
    agents: [],
    mcp_servers: []
  };
}
function upsertEntry(entries, name) {
  const existing = entries.find((e) => e.name === name);
  if (existing) {
    existing.count++;
  } else {
    entries.push({
      name,
      first_seen: (/* @__PURE__ */ new Date()).toISOString(),
      count: 1
    });
  }
}
function logHook(sessionId, hookName) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.hooks, hookName);
  const filePath = getActivityPath(sessionId);
  writeFileSync(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/shared/guard-log.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join3 } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
var PATH_CHARS = 300;
var TARGET_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Agent: "subagent_type",
  Task: "subagent_type",
  Skill: "skill"
};
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir2();
  return env.CCV3_GUARD_DECISIONS_LOG || join3(home, ".claude", "logs", "guard-decisions.jsonl");
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
  return !!env.CCV3_GUARD_DECISIONS_LOG || !Object.hasOwn(env, "VITEST");
}
function guardSource(env) {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === "test" || named === "probe") return named;
  if (Object.hasOwn(env, "VITEST")) return "test";
  return env.CCV3_GUARD_DECISIONS_LOG ? "probe" : "live";
}
function pathText(value, max = PATH_CHARS) {
  return typeof value === "string" && value ? value.slice(0, max) : void 0;
}
var UUID_SEGMENT = /(^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/.])/gi;
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];
function maskedPath(value, max = PATH_CHARS) {
  if (typeof value !== "string" || !value) return void 0;
  const kept = [];
  const shielded = value.replace(UUID_SEGMENT, (_m, sep, uuid) => {
    kept.push(uuid);
    return `${sep}${MARK_OPEN}${kept.length - 1}${MARK_CLOSE}`;
  });
  const masked = PATH_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), shielded);
  return masked.replace(UUID_MARK, (m, i) => kept[Number(i)] ?? m).slice(0, max);
}
function targetOf(input, tool) {
  const explicit = maskedPath(input?.target);
  if (explicit) return explicit;
  const field = Object.hasOwn(TARGET_FIELD, tool) ? TARGET_FIELD[tool] : void 0;
  const toolInput = input?.tool_input;
  if (!field || typeof toolInput !== "object" || toolInput === null) return void 0;
  const raw = toolInput[field];
  return field === "file_path" ? maskedPath(raw) : pathText(raw);
}
function logGuardDecision(hook, input, decision, reason, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || void 0;
    const tool = input?.tool_name || input?.tool || "";
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      hook,
      tool,
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || "",
      agent: !!agent,
      source: guardSource(env)
    };
    if (agent) entry.agent_id = agent;
    const cwd = maskedPath(input?.cwd);
    if (cwd) entry.cwd = cwd;
    const mode = pathText(input?.permission_mode, 40);
    if (mode) entry.permission_mode = mode;
    const target = targetOf(input, tool);
    if (target) entry.target = target;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path = guardLogPath(env);
    mkdirSync3(dirname2(path), { recursive: true, mode: 448 });
    appendFileSync2(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/plan-mode-approval-gate.ts
var log = createLogger("plan-mode-approval-gate");
function decideGate(params) {
  if (params.toolName !== "ExitPlanMode") return { action: "allow" };
  if (params.bypassEnv) return { action: "allow" };
  if (params.goalActive) return { action: "allow" };
  if (params.permissionMode === "bypassPermissions") {
    return {
      action: "deny",
      reason: "Plan-mode approval gate: ExitPlanMode is blocked while Claude Code is running with --dangerously-skip-permissions. The plan-approval dialog is suppressed in that mode, so this gate cannot ask. To proceed: (a) use AskUserQuestion to get explicit user approval, then set BYPASS_PLAN_GATE=1 in the environment and retry ExitPlanMode; (b) restart Claude Code without --dangerously-skip-permissions; or (c) run inside /goal for autonomous flows."
    };
  }
  return {
    action: "ask",
    reason: "Plan-mode approval gate: confirm before exiting plan mode and executing the proposed plan. Set BYPASS_PLAN_GATE=1 to skip this gate, or run /goal to auto-bypass for autonomous flows."
  };
}
function mangleProjectDir(projectDir) {
  return projectDir.replace(/[^A-Za-z0-9]/g, "-");
}
var MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
function detectGoalActiveFromTranscript(text) {
  if (!text) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.includes('"goal_status"')) continue;
    try {
      const obj = JSON.parse(line);
      const att = obj?.attachment;
      if (att && att.type === "goal_status") {
        return att.sentinel === true && att.met === false;
      }
    } catch {
    }
  }
  return null;
}
function isGoalModeActive(projectDir, sessionId) {
  if (!sessionId) return false;
  try {
    const mangled = mangleProjectDir(projectDir);
    const transcriptPath = join4(
      homedir3(),
      ".claude",
      "projects",
      mangled,
      `${sessionId}.jsonl`
    );
    let size = 0;
    try {
      size = statSync2(transcriptPath).size;
    } catch {
      return false;
    }
    if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return false;
    const text = readFileSync2(transcriptPath, "utf-8");
    return detectGoalActiveFromTranscript(text) === true;
  } catch {
    return false;
  }
}
function detectUnderlyingPermissionMode(text) {
  if (!text) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.includes('"permissionMode"')) continue;
    try {
      const obj = JSON.parse(line);
      const mode = obj?.permissionMode;
      if (typeof mode !== "string") continue;
      if (mode === "plan") continue;
      return mode;
    } catch {
    }
  }
  return null;
}
function resolveEffectivePermissionMode(projectDir, sessionId) {
  if (!sessionId) return null;
  try {
    const mangled = mangleProjectDir(projectDir);
    const transcriptPath = join4(
      homedir3(),
      ".claude",
      "projects",
      mangled,
      `${sessionId}.jsonl`
    );
    let size = 0;
    try {
      size = statSync2(transcriptPath).size;
    } catch {
      return null;
    }
    if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return null;
    const text = readFileSync2(transcriptPath, "utf-8");
    return detectUnderlyingPermissionMode(text);
  } catch {
    return null;
  }
}
function emitAllow() {
  console.log(JSON.stringify({}));
}
function emitAsk(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}
function emitDeny(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}
function main() {
  try {
    const raw = readFileSync2(0, "utf-8");
    if (!raw.trim()) {
      emitAllow();
      return;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      emitAllow();
      return;
    }
    if (input.tool_name !== "ExitPlanMode") {
      emitAllow();
      return;
    }
    const sessionId = input.session_id || "";
    const bypassEnv = process.env.BYPASS_PLAN_GATE === "1";
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let goalActive = false;
    try {
      goalActive = isGoalModeActive(projectDir, sessionId);
    } catch {
      goalActive = false;
    }
    const rawPermissionMode = input.permission_mode;
    let permissionMode = rawPermissionMode;
    if (rawPermissionMode === "plan") {
      try {
        const resolved = resolveEffectivePermissionMode(projectDir, sessionId);
        if (resolved) permissionMode = resolved;
        else permissionMode = void 0;
      } catch {
        permissionMode = void 0;
      }
    }
    const decision = decideGate({
      toolName: input.tool_name,
      bypassEnv,
      goalActive,
      permissionMode
    });
    try {
      logHook(sessionId, "plan-mode-approval-gate");
    } catch {
    }
    if (decision.action === "ask") {
      log.info("Forcing plan-mode approval dialog", {
        sessionId,
        rawPermissionMode,
        permissionMode
      });
      logGuardDecision("plan-mode-approval-gate", input, "ask", "exit-plan-mode-approval");
      emitAsk(decision.reason);
    } else if (decision.action === "deny") {
      log.info("Denying ExitPlanMode in bypass-permissions mode", {
        sessionId,
        rawPermissionMode,
        permissionMode
      });
      logGuardDecision("plan-mode-approval-gate", input, "deny", "exit-plan-mode-in-bypass");
      emitDeny(decision.reason);
    } else {
      log.info("Allowing ExitPlanMode without prompt", {
        sessionId,
        bypassEnv,
        goalActive,
        rawPermissionMode,
        permissionMode
      });
      emitAllow();
    }
  } catch (err) {
    log.error("Unexpected error, failing open", { error: String(err) });
    emitAllow();
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  decideGate,
  detectGoalActiveFromTranscript,
  detectUnderlyingPermissionMode,
  isGoalModeActive,
  mangleProjectDir,
  resolveEffectivePermissionMode
};
