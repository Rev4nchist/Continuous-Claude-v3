#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/maestro-cleanup.ts
import { readFileSync, existsSync as existsSync3, unlinkSync as unlinkSync2, mkdirSync as mkdirSync2, writeFileSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";

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
function cleanupOldStateFiles(baseName, maxAgeMs = 24 * 60 * 60 * 1e3) {
  const tmpDir = tmpdir();
  const pattern = new RegExp(`^claude-${baseName}-.*\\.json$`);
  let cleaned = 0;
  try {
    const files = readdirSync(tmpDir);
    const now = Date.now();
    for (const file of files) {
      if (!pattern.test(file)) continue;
      const fullPath = join(tmpDir, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch {
      }
    }
  } catch {
  }
  return cleaned;
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync as statSync2, renameSync } from "fs";
import { join as join2 } from "path";
import { homedir } from "os";
var LOG_DIR = join2(homedir(), ".claude", "logs");
var LOG_FILE = join2(LOG_DIR, "hooks.log");
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
  function log2(level, msg, data) {
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
    debug: (msg, data) => log2("debug", msg, data),
    info: (msg, data) => log2("info", msg, data),
    warn: (msg, data) => log2("warn", msg, data),
    error: (msg, data) => log2("error", msg, data)
  };
}

// src/maestro-cleanup.ts
var log = createLogger("maestro-cleanup");
var STATE_FILES = ["maestro-state", "ralph-state"];
var RECOVERY_DIR = join3(homedir2(), ".claude", "recovery");
function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
}
function ensureRecoveryDir() {
  if (!existsSync3(RECOVERY_DIR)) {
    mkdirSync2(RECOVERY_DIR, { recursive: true });
  }
}
function isIncompleteWorkflow(content, baseName) {
  try {
    const state = JSON.parse(content);
    if (!state.active) return false;
    if (baseName === "ralph-state") {
      return true;
    }
    if (baseName === "maestro-state") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
function archiveState(baseName, content, sessionId) {
  try {
    ensureRecoveryDir();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const filename = `${baseName}-${timestamp}.json`;
    const archivePath = join3(RECOVERY_DIR, filename);
    const archive = {
      baseName,
      sessionId,
      archivedAt: Date.now(),
      archivedAtISO: (/* @__PURE__ */ new Date()).toISOString(),
      state: JSON.parse(content)
    };
    writeFileSync(archivePath, JSON.stringify(archive, null, 2));
    log.info(`Archived incomplete ${baseName} for recovery`, { archivePath, sessionId });
  } catch (err) {
    log.error(`Failed to archive ${baseName}`, { error: String(err), sessionId });
  }
}
function cleanupStateFile(baseName, sessionId) {
  try {
    const stateFile = getStatePathWithMigration(baseName, sessionId);
    if (existsSync3(stateFile)) {
      try {
        const content = readFileSync(stateFile, "utf-8");
        if (isIncompleteWorkflow(content, baseName)) {
          archiveState(baseName, content, sessionId);
        }
      } catch {
      }
      unlinkSync2(stateFile);
      return true;
    }
  } catch {
  }
  return false;
}
async function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
  }
  const sessionId = input.session_id;
  const cleaned = [];
  for (const baseName of STATE_FILES) {
    if (cleanupStateFile(baseName, sessionId)) {
      cleaned.push(baseName);
    }
  }
  for (const baseName of STATE_FILES) {
    cleanupOldStateFiles(baseName, 24 * 60 * 60 * 1e3);
  }
  if (cleaned.length > 0) {
    log.info(`Session cleanup: ${cleaned.join(", ")}`, { sessionId });
    console.log(JSON.stringify({
      result: "continue",
      message: `Cleaned up state: ${cleaned.join(", ")}`
    }));
  } else {
    console.log(JSON.stringify({ result: "continue" }));
  }
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
