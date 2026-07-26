#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/test-before-done.ts
import { readFileSync, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
import { tmpdir } from "os";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var LOG_DIR = join(homedir(), ".claude", "logs");
var LOG_FILE = join(LOG_DIR, "hooks.log");
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

// src/test-before-done.ts
var log = createLogger("test-before-done");
var RECENT_TEST_THRESHOLD_MS = 3e5;
var STATE_BASE_NAME = "recent-test-runs";
function shouldWarn(input) {
  if (!input || typeof input !== "object") return false;
  if (input.tool_name !== "TaskUpdate") return false;
  if (!input.tool_input || typeof input.tool_input !== "object") return false;
  return input.tool_input.status === "completed";
}
function hasRecentTestRun(sessionId) {
  try {
    const safeSid = (sessionId || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_").substring(0, 32);
    const statePath = join2(tmpdir(), `claude-${STATE_BASE_NAME}-${safeSid}.json`);
    if (!existsSync2(statePath)) return false;
    const raw = readFileSync(statePath, "utf-8");
    if (!raw.trim()) return false;
    const state = JSON.parse(raw);
    if (!state.lastTestRun || typeof state.lastTestRun !== "number") return false;
    const elapsed = Date.now() - state.lastTestRun;
    return elapsed < RECENT_TEST_THRESHOLD_MS;
  } catch {
    return false;
  }
}
function buildWarningOutput() {
  return {
    values: {
      system: "WARNING: No test execution detected before marking task complete. Consider running tests to verify the change works before completing this task."
    }
  };
}
function handleTaskUpdate(input) {
  try {
    if (!shouldWarn(input)) return null;
    const sessionId = input.session_id || "unknown";
    if (hasRecentTestRun(sessionId)) return null;
    log.info("No recent test run detected on task completion", { sessionId });
    return buildWarningOutput();
  } catch (err) {
    log.error("handleTaskUpdate failed", { error: String(err) });
    return null;
  }
}
function main() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) {
      console.log(JSON.stringify({}));
      return;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({}));
      return;
    }
    const result = handleTaskUpdate(input);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    console.log(JSON.stringify({}));
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  buildWarningOutput,
  handleTaskUpdate,
  hasRecentTestRun,
  shouldWarn
};
