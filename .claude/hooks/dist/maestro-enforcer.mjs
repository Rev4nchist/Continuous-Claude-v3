#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/maestro-enforcer.ts
import { readFileSync as readFileSync3, existsSync as existsSync5, unlinkSync as unlinkSync3 } from "fs";

// src/shared/session-isolation.ts
import { tmpdir, hostname } from "os";
import { join } from "path";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
function getSessionId() {
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }
  const host = hostname().replace(/[^a-zA-Z0-9]/g, "").substring(0, 8);
  return `${host}-${process.pid}`;
}
function getSessionStatePath(baseName, sessionId) {
  const sid = sessionId || getSessionId();
  const safeSid = sid.replace(/[^a-zA-Z0-9-_]/g, "_").substring(0, 32);
  return join(tmpdir(), `claude-${baseName}-${safeSid}.json`);
}
function getLegacyStatePath(baseName) {
  return join(tmpdir(), `claude-${baseName}.json`);
}
function getStatePathWithMigration(baseName, sessionId) {
  const sessionPath = getSessionStatePath(baseName, sessionId);
  const legacyPath = getLegacyStatePath(baseName);
  if (existsSync(sessionPath)) {
    return sessionPath;
  }
  if (existsSync(legacyPath)) {
    try {
      const stat = statSync(legacyPath);
      const oneHourAgo = Date.now() - 60 * 60 * 1e3;
      if (stat.mtimeMs > oneHourAgo) {
        return legacyPath;
      }
    } catch {
    }
  }
  return sessionPath;
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync as statSync2, renameSync } from "fs";
import { dirname, join as join2 } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join2(homedir(), ".claude", "logs", "hooks.log");
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
  if (!existsSync2(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync2(LOG_FILE)) {
      const stat = statSync2(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId2() {
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
  function log4(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId2()
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
    debug: (msg, data) => log4("debug", msg, data),
    info: (msg, data) => log4("info", msg, data),
    warn: (msg, data) => log4("warn", msg, data),
    error: (msg, data) => log4("error", msg, data)
  };
}

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  existsSync as existsSync3,
  openSync,
  closeSync,
  readFileSync,
  statSync as statSync3,
  constants
} from "fs";
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync3(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync2(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startTime > timeoutMs) {
          log.error("Lock acquisition timed out", { lockFile, timeoutMs });
          return false;
        }
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
        }
      } else {
        log.error("Lock acquisition failed", { lockFile, error: String(err) });
        return false;
      }
    }
  }
}
function releaseLockSync(filePath) {
  const lockFile = filePath + ".lock";
  try {
    if (existsSync3(lockFile)) {
      unlinkSync2(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function readStateWithLock(filePath) {
  if (!existsSync3(filePath)) return null;
  const locked = acquireLockSync(filePath, 2e3);
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    log.error("State read failed", { filePath, error: String(err) });
    return null;
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

// src/shared/state-schema.ts
var log2 = createLogger("state-schema");
var VALID_TASK_TYPES = ["implementation", "research", "unknown"];
function validateMaestroState(obj, sessionId) {
  if (!obj || typeof obj !== "object") {
    log2.warn("Maestro state is not an object", { received: typeof obj, sessionId });
    return null;
  }
  const s = obj;
  if (typeof s.active !== "boolean") {
    log2.warn('Maestro state missing or invalid "active" field', { value: s.active, sessionId });
    return null;
  }
  if (typeof s.taskType !== "string" || !VALID_TASK_TYPES.includes(s.taskType)) {
    log2.warn('Maestro state missing or invalid "taskType" field', { value: s.taskType, sessionId });
    return null;
  }
  for (const field of ["reconComplete", "interviewComplete", "planApproved"]) {
    if (typeof s[field] !== "boolean") {
      log2.warn(`Maestro state missing or invalid "${field}" field`, { value: s[field], sessionId });
      return null;
    }
  }
  if (typeof s.activatedAt !== "number" || s.activatedAt <= 0) {
    log2.warn('Maestro state missing or invalid "activatedAt" field', { value: s.activatedAt, sessionId });
    return null;
  }
  if (s.lastActivity !== void 0 && typeof s.lastActivity !== "number") {
    log2.warn('Maestro state invalid "lastActivity" field', { value: s.lastActivity, sessionId });
    return null;
  }
  if (s.sessionId !== void 0 && typeof s.sessionId !== "string") {
    log2.warn('Maestro state invalid "sessionId" field', { value: s.sessionId, sessionId });
    return null;
  }
  return obj;
}

// src/shared/session-activity.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
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
    if (!existsSync4(filePath)) {
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
  writeFileSync2(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/shared/guard-log.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join4 } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir2();
  return env.CCV3_GUARD_DECISIONS_LOG || join4(home, ".claude", "logs", "guard-decisions.jsonl");
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
    mkdirSync3(dirname2(path), { recursive: true, mode: 448 });
    appendFileSync2(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/maestro-enforcer.ts
var log3 = createLogger("maestro-enforcer");
var STATE_BASE_NAME = "maestro-state";
var STATE_TTL = 4 * 60 * 60 * 1e3;
function getStateFile(sessionId) {
  return getStatePathWithMigration(STATE_BASE_NAME, sessionId);
}
function readState(sessionId) {
  const stateFile = getStateFile(sessionId);
  if (!existsSync5(stateFile)) {
    return null;
  }
  try {
    const content = readStateWithLock(stateFile);
    if (!content) return null;
    const state = validateMaestroState(JSON.parse(content), sessionId);
    if (!state) return null;
    const lastTime = state.lastActivity || state.activatedAt;
    if (Date.now() - lastTime > STATE_TTL) {
      unlinkSync3(stateFile);
      return null;
    }
    return state;
  } catch (err) {
    log3.error("Failed to read maestro state", { error: String(err), sessionId });
    return null;
  }
}
function readStdin() {
  return readFileSync3(0, "utf-8");
}
var currentInput;
function makeBlockOutput(reason) {
  const rule = reason.split("\n").map((l) => l.trim()).find(Boolean) ?? "maestro-block";
  logGuardDecision("maestro-enforcer", currentInput, "deny", rule);
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
    if (input.tool_name !== "Agent" && input.tool_name !== "Task") {
      makeAllowOutput();
      return;
    }
    currentInput = input;
    const sessionId = input.session_id;
    const state = readState(sessionId);
    if (!state || !state.active) {
      makeAllowOutput();
      return;
    }
    try {
      logHook(sessionId || "", "maestro-enforcer");
    } catch {
    }
    log3.info(`Checking Task tool: phase recon=${state.reconComplete} interview=${state.interviewComplete} plan=${state.planApproved}`, { sessionId });
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
if ((process.argv[1] || "").includes("maestro-enforcer")) {
  main();
}
