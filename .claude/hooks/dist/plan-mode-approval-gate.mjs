#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/plan-mode-approval-gate.ts
import { readFileSync as readFileSync3, statSync as statSync2 } from "fs";
import { join as join4 } from "path";
import { homedir as homedir2 } from "os";

// src/shared/state-schema.ts
import { existsSync as existsSync2, readFileSync } from "fs";
import { join as join2 } from "path";

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
  function log3(level, msg, data) {
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
    debug: (msg, data) => log3("debug", msg, data),
    info: (msg, data) => log3("info", msg, data),
    warn: (msg, data) => log3("warn", msg, data),
    error: (msg, data) => log3("error", msg, data)
  };
}

// src/shared/state-schema.ts
var log = createLogger("state-schema");
function readRalphUnifiedState(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const statePath = join2(dir, ".ralph", "state.json");
  if (!existsSync2(statePath)) return null;
  try {
    const content = readFileSync(statePath, "utf-8");
    const state = JSON.parse(content);
    if (!state.version || !state.version.startsWith("2.")) {
      log.warn("Ralph unified state version mismatch (expected 2.x) \u2014 returning null", {
        version: state.version,
        statePath: join2(dir, ".ralph", "state.json")
      });
      return null;
    }
    return state;
  } catch (err) {
    log.warn("Failed to read Ralph unified state", { error: String(err) });
    return null;
  }
}
function isRalphActive(projectDir) {
  const unified = readRalphUnifiedState(projectDir);
  if (unified?.session?.active) {
    return { active: true, storyId: unified.story_id, source: "unified" };
  }
  return { active: false, storyId: "", source: "none" };
}

// src/shared/session-activity.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync } from "fs";
import { join as join3 } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join3(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync2(dir, { recursive: true });
  } catch {
  }
  return join3(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync3(filePath)) {
      return null;
    }
    const raw = readFileSync2(filePath, "utf-8");
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

// src/plan-mode-approval-gate.ts
var log2 = createLogger("plan-mode-approval-gate");
function decideGate(params) {
  if (params.toolName !== "ExitPlanMode") return { action: "allow" };
  if (params.bypassEnv) return { action: "allow" };
  if (params.goalActive) return { action: "allow" };
  if (params.ralphActive) return { action: "allow" };
  if (params.permissionMode === "bypassPermissions") {
    return {
      action: "deny",
      reason: "Plan-mode approval gate: ExitPlanMode is blocked while Claude Code is running with --dangerously-skip-permissions. The plan-approval dialog is suppressed in that mode, so this gate cannot ask. To proceed: (a) use AskUserQuestion to get explicit user approval, then set BYPASS_PLAN_GATE=1 in the environment and retry ExitPlanMode; (b) restart Claude Code without --dangerously-skip-permissions; or (c) run inside /goal or /ralph for autonomous flows."
    };
  }
  return {
    action: "ask",
    reason: "Plan-mode approval gate: confirm before exiting plan mode and executing the proposed plan. Set BYPASS_PLAN_GATE=1 to skip this gate, or run /goal / /ralph to auto-bypass for autonomous flows."
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
      homedir2(),
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
    const text = readFileSync3(transcriptPath, "utf-8");
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
      homedir2(),
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
    const text = readFileSync3(transcriptPath, "utf-8");
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
    const raw = readFileSync3(0, "utf-8");
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
    let ralphActive = false;
    try {
      ralphActive = isRalphActive(projectDir).active;
    } catch {
      ralphActive = false;
    }
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
      ralphActive,
      goalActive,
      permissionMode
    });
    try {
      logHook(sessionId, "plan-mode-approval-gate");
    } catch {
    }
    if (decision.action === "ask") {
      log2.info("Forcing plan-mode approval dialog", {
        sessionId,
        rawPermissionMode,
        permissionMode
      });
      emitAsk(decision.reason);
    } else if (decision.action === "deny") {
      log2.info("Denying ExitPlanMode in bypass-permissions mode", {
        sessionId,
        rawPermissionMode,
        permissionMode
      });
      emitDeny(decision.reason);
    } else {
      log2.info("Allowing ExitPlanMode without prompt", {
        sessionId,
        bypassEnv,
        goalActive,
        ralphActive,
        rawPermissionMode,
        permissionMode
      });
      emitAllow();
    }
  } catch (err) {
    log2.error("Unexpected error, failing open", { error: String(err) });
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
