#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-compact-extract.ts
import * as fs from "fs";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
var RELAY_ERROR_LOG = join(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/pre-compact-extract.ts
import * as path from "path";

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync,
  statSync as statSync2,
  constants
} from "fs";
import { dirname as dirname2, basename, join as join3 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
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

// src/shared/atomic-write.ts
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join3(dir, `.${basename(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync(tmpFile);
    } catch {
    }
    throw err;
  }
}
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
          const stat = statSync2(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync(lockFile);
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
    if (existsSync2(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function mutateStateWithLock(filePath, transformFn, opts = {}) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const lockStart = Date.now();
  const locked = acquireLockSync(filePath, lockTimeoutMs);
  const waitMs = Date.now() - lockStart;
  if (opts.onLockOutcome) {
    try {
      opts.onLockOutcome({ acquired: locked, wait_ms: waitMs });
    } catch {
    }
  }
  if (!locked) {
    log.warn("mutateStateWithLock: lock not acquired, skipping write", { filePath });
    return false;
  }
  try {
    let current;
    if (!existsSync2(filePath)) {
      current = null;
    } else {
      try {
        current = readFileSync(filePath, "utf-8");
      } catch (err) {
        log.warn("mutateStateWithLock: existing file unreadable, aborting write", {
          filePath,
          error: String(err)
        });
        return false;
      }
    }
    let next;
    try {
      next = transformFn(current);
    } catch (err) {
      log.error("mutateStateWithLock: transform threw, leaving file untouched", {
        filePath,
        error: String(err)
      });
      return false;
    }
    if (next == null) {
      return false;
    }
    const writeStart = Date.now();
    atomicWriteSync(filePath, next);
    if (opts.onWriteTiming) {
      try {
        opts.onWriteTiming({ write_ms: Date.now() - writeStart });
      } catch {
      }
    }
    return true;
  } catch (err) {
    log.error("mutateStateWithLock: write failed", { filePath, error: String(err) });
    return false;
  } finally {
    releaseLockSync(filePath);
  }
}

// src/shared/extraction-state.ts
var STATE_VERSION = 2;
var MAX_SESSIONS = 50;
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var finiteNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
function cleanEntry(raw) {
  const o = isObject(raw) ? raw : {};
  const entry = {};
  const line = finiteNumber(o.last_extracted_line);
  const launched = finiteNumber(o.last_launched);
  if (line !== void 0) entry.last_extracted_line = line;
  if (launched !== void 0) entry.last_launched = launched;
  if (typeof o.last_extraction_time === "string") entry.last_extraction_time = o.last_extraction_time;
  return entry;
}
function parseState(text) {
  const sessions = /* @__PURE__ */ Object.create(null);
  const state = { version: STATE_VERSION, recent_hashes: [], sessions };
  if (!text || !text.trim()) return state;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return state;
  }
  if (!isObject(data)) return state;
  if (Array.isArray(data.recent_hashes)) {
    state.recent_hashes = data.recent_hashes.filter((h) => typeof h === "string");
  }
  if (isObject(data.sessions)) {
    for (const [sid, entry] of Object.entries(data.sessions)) sessions[sid] = cleanEntry(entry);
  } else if (typeof data.session_id === "string" && data.session_id) {
    sessions[data.session_id] = cleanEntry(data);
  }
  return state;
}
function sessionStartLine(state, sessionId) {
  return state.sessions[sessionId]?.last_extracted_line ?? 0;
}
function inCooldown(state, sessionId, now, cooldownMs) {
  const launched = state.sessions[sessionId]?.last_launched;
  return launched !== void 0 && now - launched < cooldownMs;
}
function withLaunchStamp(state, sessionId, now) {
  const sessions = /* @__PURE__ */ Object.create(null);
  for (const [sid, entry] of Object.entries(state.sessions)) sessions[sid] = { ...entry };
  sessions[sessionId] = { ...sessions[sessionId], last_launched: now };
  const recency = (e) => Math.max(e.last_launched ?? 0, Date.parse(e.last_extraction_time ?? "") || 0);
  const ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => recency(sessions[b]) - recency(sessions[a]));
    for (const sid of ids.slice(MAX_SESSIONS)) {
      if (sid !== sessionId) delete sessions[sid];
    }
  }
  return { version: STATE_VERSION, recent_hashes: state.recent_hashes, sessions };
}

// src/pre-compact-extract.ts
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || path.join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function getStateFilePath(projectDir) {
  return path.join(projectDir, ".claude", "extraction-state.json");
}
function readStateOrNull(stateFile) {
  try {
    return fs.readFileSync(stateFile, "utf-8");
  } catch {
    return null;
  }
}
function runBackgroundExtraction(transcriptPath, sessionId, startLine, stateFile, projectDir) {
  const opcDir = getOpcDir();
  const extractScript = path.join(opcDir, "scripts", "core", "incremental_extract.py");
  if (!fs.existsSync(extractScript)) {
    console.error(`incremental_extract.py not found at ${extractScript}`);
    return false;
  }
  try {
    const child = spawnDetachedHidden("uv", [
      "run",
      "python",
      "scripts/core/incremental_extract.py",
      "--transcript",
      transcriptPath,
      "--session-id",
      sessionId,
      "--start-line",
      startLine.toString(),
      "--state-file",
      stateFile,
      "--project-dir",
      projectDir,
      "--max-learnings",
      "5",
      "--json"
    ], {
      cwd: opcDir,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: opcDir }
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
var COOLDOWN_MS = 5 * 60 * 1e3;
function runPreCompactExtract(data, projectDir, deps = {}) {
  const launcher = deps.launcher ?? ((a) => runBackgroundExtraction(a.transcriptPath, a.sessionId, a.startLine, a.stateFile, a.projectDir));
  const now = deps.now ?? Date.now;
  const sessionId = data.session_id;
  const transcriptPath = data.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { continue: true, systemMessage: "[PreCompact] No transcript available for extraction" };
  }
  const stateFile = getStateFilePath(projectDir);
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  } catch {
  }
  const launchFor = (state) => launcher({
    transcriptPath,
    sessionId,
    startLine: sessionStartLine(state, sessionId),
    stateFile,
    projectDir
  });
  let ran = false;
  let cooling = false;
  let launched = false;
  mutateStateWithLock(stateFile, (current) => {
    ran = true;
    const state = parseState(current);
    if (inCooldown(state, sessionId, now(), COOLDOWN_MS)) {
      cooling = true;
      return null;
    }
    launched = launchFor(state);
    return launched ? JSON.stringify(withLaunchStamp(state, sessionId, now()), null, 2) : null;
  });
  if (!ran) {
    const state = parseState(readStateOrNull(stateFile));
    if (inCooldown(state, sessionId, now(), COOLDOWN_MS)) cooling = true;
    else launched = launchFor(state);
  }
  if (cooling) {
    return { continue: true, systemMessage: "[PreCompact:L0] Cooldown active, skipping extraction" };
  }
  const message = launched ? "[PreCompact:L0] Memory extraction launched (background)" : "[PreCompact:L0] Memory extraction unavailable";
  return { continue: true, systemMessage: message };
}
async function main() {
  if (process.env.CCV3_DISTILL_CHILD) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  console.log(JSON.stringify(runPreCompactExtract(data, projectDir)));
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
if ((process.argv[1] || "").includes("pre-compact-extract")) {
  main().catch((err) => {
    console.error("pre-compact-extract error:", err);
    console.log(JSON.stringify({ continue: true }));
  });
}
export {
  runPreCompactExtract
};
