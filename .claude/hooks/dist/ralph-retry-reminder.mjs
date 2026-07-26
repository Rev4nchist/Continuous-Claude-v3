#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/ralph-retry-reminder.ts
import { readFileSync as readFileSync2 } from "fs";

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
import { existsSync as existsSync2, readFileSync } from "fs";
import { join as join2 } from "path";
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

// src/ralph-retry-reminder.ts
var log2 = createLogger("ralph-retry-reminder");
function readStdin() {
  try {
    return readFileSync2(0, "utf-8");
  } catch {
    return "{}";
  }
}
function getEscalationAgent(retries, originalAgent) {
  if (retries === 0) return originalAgent || "spark";
  if (retries === 1) return "spark";
  if (retries === 2) return "debug-agent";
  return "ESCALATE";
}
async function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const unified = readRalphUnifiedState(projectDir);
  if (!unified?.session?.active) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const retryQueue = unified.retry_queue || [];
  if (retryQueue.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  log2.info(`Found ${retryQueue.length} item(s) in retry queue`, {
    storyId: unified.story_id,
    sessionId: input.session_id
  });
  const lines = [
    "",
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    "\u{1F504} RETRY QUEUE \u2014 Action Required",
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    ""
  ];
  for (const entry of retryQueue) {
    const taskId = entry.task_id || "?";
    const taskName = entry.task_name || "";
    const retries = entry.attempt || 0;
    const lastError = entry.last_error || "unknown";
    const escalationAgent = getEscalationAgent(retries, entry.original_agent);
    if (escalationAgent === "ESCALATE") {
      lines.push(`  **Task ${taskId}** (${taskName}) \u2014 ESCALATE TO USER`);
      lines.push(`    3 retries exhausted. Last error: ${lastError}`);
      lines.push(`    Action: Review manually, fix the root cause, then retry`);
      lines.push("");
    } else {
      lines.push(`  **Task ${taskId}** (${taskName}) \u2014 retry #${retries + 1}`);
      lines.push(`    Last error: ${lastError}`);
      lines.push(`    Suggested agent: **${escalationAgent}**`);
      lines.push("");
    }
  }
  lines.push("**Actions:**");
  lines.push("  - Pop and retry: `python ~/.claude/scripts/ralph/ralph-state-v2.py -p . retry-pop`");
  lines.push("  - Skip/discard: manually remove from state");
  lines.push("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
  const message = lines.join("\n");
  console.log(JSON.stringify({ result: "continue", message }));
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
