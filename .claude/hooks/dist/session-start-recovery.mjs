#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-recovery.ts
import { readFileSync, readdirSync, existsSync as existsSync2, unlinkSync, statSync as statSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";

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

// src/session-start-recovery.ts
var log = createLogger("session-start-recovery");
var RECOVERY_DIR = join2(homedir2(), ".claude", "recovery");
var MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
}
function getRecoveryFiles() {
  if (!existsSync2(RECOVERY_DIR)) return [];
  const files = [];
  try {
    const entries = readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
    for (const entry of entries) {
      const fullPath = join2(RECOVERY_DIR, entry);
      try {
        const stat = statSync2(fullPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > MAX_AGE_MS) {
          unlinkSync(fullPath);
          log.info("Cleaned up stale recovery file", { file: entry, ageHours: (ageMs / 36e5).toFixed(1) });
          continue;
        }
        const content = readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        files.push({ path: fullPath, data });
      } catch {
      }
    }
  } catch {
  }
  return files;
}
function formatRecoveryPrompt(files) {
  const lines = [
    "",
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    "\u{1F504} WORKFLOW RECOVERY AVAILABLE",
    "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
    "",
    "Found incomplete workflow(s) from a previous session:",
    ""
  ];
  for (const { data } of files) {
    const ago = ((Date.now() - data.archivedAt) / 6e4).toFixed(0);
    const storyId = data.state.storyId || "unknown";
    const taskType = data.state.taskType || "";
    lines.push(`  **Maestro** workflow`);
    if (storyId !== "unknown") lines.push(`  Story: ${storyId}`);
    if (taskType) lines.push(`  Type: ${taskType}`);
    lines.push(`  Archived: ${ago} minutes ago`);
    lines.push("");
  }
  lines.push("**Options:**");
  lines.push('  - Say "resume workflow" to restore and continue');
  lines.push('  - Say "discard recovery" to clear and start fresh');
  lines.push("  - Or just start a new task (recovery files expire after 24h)");
  lines.push("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
  return lines.join("\n");
}
async function main() {
  readStdin();
  const recoveryFiles = getRecoveryFiles();
  if (recoveryFiles.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  log.info(`Found ${recoveryFiles.length} recovery file(s)`, {
    files: recoveryFiles.map((f) => f.data.baseName)
  });
  const message = formatRecoveryPrompt(recoveryFiles);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } }));
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
