#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-recovery.ts
import { readFileSync as readFileSync2, readdirSync, existsSync as existsSync3, unlinkSync, statSync as statSync2 } from "fs";
import { join as join3 } from "path";
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

// src/session-start-recovery.ts
var log2 = createLogger("session-start-recovery");
var RECOVERY_DIR = join3(homedir2(), ".claude", "recovery");
var MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function readStdin() {
  try {
    return readFileSync2(0, "utf-8");
  } catch {
    return "{}";
  }
}
function getRecoveryFiles() {
  if (!existsSync3(RECOVERY_DIR)) return [];
  const files = [];
  try {
    const entries = readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json"));
    for (const entry of entries) {
      const fullPath = join3(RECOVERY_DIR, entry);
      try {
        const stat = statSync2(fullPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > MAX_AGE_MS) {
          unlinkSync(fullPath);
          log2.info("Cleaned up stale recovery file", { file: entry, ageHours: (ageMs / 36e5).toFixed(1) });
          continue;
        }
        const content = readFileSync2(fullPath, "utf-8");
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
    const type = data.baseName === "ralph-state" ? "Ralph" : "Maestro";
    const ago = ((Date.now() - data.archivedAt) / 6e4).toFixed(0);
    const storyId = data.state.storyId || "unknown";
    const taskType = data.state.taskType || "";
    lines.push(`  **${type}** workflow`);
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
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const unified = readRalphUnifiedState(projectDir);
  let unifiedRecoveryInfo = "";
  if (unified?.session?.active) {
    const tasks = Array.isArray(unified.tasks) ? unified.tasks : Object.values(unified.tasks || {});
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === "complete" || t.status === "completed").length;
    const checkpoints = unified.checkpoints || [];
    const lastCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
    if (totalTasks > 0 && completedTasks < totalTasks) {
      unifiedRecoveryInfo = [
        `  **Ralph** workflow (unified state)`,
        `  Story: ${unified.story_id}`,
        `  Progress: ${completedTasks}/${totalTasks} tasks`,
        lastCheckpoint ? `  Last checkpoint: ${lastCheckpoint.timestamp || "unknown"}` : "",
        ""
      ].filter(Boolean).join("\n");
    }
  }
  if (recoveryFiles.length === 0 && !unifiedRecoveryInfo) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  log2.info(`Found ${recoveryFiles.length} recovery file(s)`, {
    files: recoveryFiles.map((f) => f.data.baseName)
  });
  let message = formatRecoveryPrompt(recoveryFiles);
  if (unifiedRecoveryInfo) {
    if (recoveryFiles.length === 0) {
      message = [
        "",
        "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
        "\u{1F504} WORKFLOW RECOVERY AVAILABLE",
        "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501",
        "",
        "Found incomplete workflow from a previous session:",
        "",
        unifiedRecoveryInfo,
        "**Options:**",
        '  - Say "resume workflow" to restore and continue',
        '  - Say "discard recovery" to clear and start fresh',
        "  - Or just start a new task (recovery files expire after 24h)",
        "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"
      ].join("\n");
    } else {
      message = message.replace("**Options:**", unifiedRecoveryInfo + "\n**Options:**");
    }
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } }));
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
