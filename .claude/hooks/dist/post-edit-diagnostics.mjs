import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/post-edit-diagnostics.ts
import { readFileSync as readFileSync5, existsSync as existsSync6 } from "fs";
import { spawnSync as spawnSync2 } from "child_process";
import { join as join7 } from "path";

// src/daemon-client.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { join, resolve } from "path";
import { tmpdir } from "os";
import * as crypto from "crypto";
function getTldrTmpDir() {
  if (process.platform === "win32") {
    const dir = "C:/tmp";
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
      }
    }
    return dir;
  }
  return tmpdir();
}
function resolveProjectDir(projectDir) {
  return resolve(projectDir);
}
function getLockPath(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  return `${getTldrTmpDir()}/tldr-${hash}.lock`;
}
function getPidPath(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  return `${getTldrTmpDir()}/tldr-${hash}.pid`;
}
function isDaemonProcessRunning(projectDir) {
  const pidPath = getPidPath(projectDir);
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function tryAcquireLock(projectDir) {
  const lockPath = getLockPath(projectDir);
  try {
    if (existsSync(lockPath)) {
      const lockContent = readFileSync(lockPath, "utf-8");
      const lockTime = parseInt(lockContent, 10);
      if (!isNaN(lockTime) && Date.now() - lockTime < 3e4) {
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
    writeFileSync(lockPath, Date.now().toString(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseLock(projectDir) {
  try {
    unlinkSync(getLockPath(projectDir));
  } catch {
  }
}
var QUERY_TIMEOUT = 3e3;
function getConnectionInfo(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  if (process.platform === "win32") {
    const port = 49152 + parseInt(hash, 16) % 1e4;
    return { type: "tcp", host: "127.0.0.1", port };
  } else {
    return { type: "unix", path: `${getTldrTmpDir()}/tldr-${hash}.sock` };
  }
}
function getStatusFile(projectDir) {
  const statusPath = join(projectDir, ".tldr", "status");
  if (existsSync(statusPath)) {
    try {
      return readFileSync(statusPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  return null;
}
function isIndexing(projectDir) {
  return getStatusFile(projectDir) === "indexing";
}
function isDaemonReachable(projectDir) {
  const connInfo = getConnectionInfo(projectDir);
  if (connInfo.type === "tcp") {
    try {
      const script = `const s=require('net').connect(${connInfo.port},'${connInfo.host}',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(500,()=>{s.destroy();process.exit(1)})`;
      const result = spawnSync(process.execPath, ["-e", script], {
        timeout: 2e3,
        stdio: "pipe"
      });
      return result.status === 0;
    } catch {
      return false;
    }
  } else {
    if (!existsSync(connInfo.path)) {
      return false;
    }
    if (isDaemonProcessRunning(projectDir)) {
      try {
        execSync(`echo '{"cmd":"ping"}' | nc -U "${connInfo.path}"`, {
          encoding: "utf-8",
          timeout: 1e3,
          // Increased from 500ms
          stdio: ["pipe", "pipe", "pipe"]
        });
        return true;
      } catch {
        return true;
      }
    }
    try {
      execSync(`echo '{"cmd":"ping"}' | nc -U "${connInfo.path}"`, {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return true;
    } catch {
      try {
        unlinkSync(connInfo.path);
      } catch {
      }
      return false;
    }
  }
}
function tryStartDaemon(projectDir) {
  try {
    if (isDaemonProcessRunning(projectDir)) {
      return true;
    }
    if (isDaemonReachable(projectDir)) {
      return true;
    }
    if (process.env.CCV3_DAEMON_NO_AUTOSTART === "1") {
      return false;
    }
    if (!tryAcquireLock(projectDir)) {
      const start = Date.now();
      while (Date.now() - start < 5e3) {
        if (isDaemonProcessRunning(projectDir) || isDaemonReachable(projectDir)) {
          return true;
        }
        const end = Date.now() + 100;
        while (Date.now() < end) {
        }
      }
      return isDaemonProcessRunning(projectDir) || isDaemonReachable(projectDir);
    }
    try {
      const tldrPath = join(projectDir, "opc", "packages", "tldr-code");
      let started = false;
      if (existsSync(tldrPath)) {
        const result = spawnSync("uv", ["run", "tldr", "daemon", "start", "--project", projectDir], {
          timeout: 1e4,
          stdio: "ignore",
          cwd: tldrPath
        });
        started = result.status === 0;
      }
      if (!started && !process.env.TLDR_DEV) {
        spawnSync("tldr", ["daemon", "start", "--project", projectDir], {
          timeout: 5e3,
          stdio: "ignore"
        });
      }
      const start = Date.now();
      while (Date.now() - start < 1e4) {
        if (isDaemonReachable(projectDir)) {
          const cooldown = Date.now() + 1e3;
          while (Date.now() < cooldown) {
          }
          return true;
        }
        const end = Date.now() + 100;
        while (Date.now() < end) {
        }
      }
      return isDaemonReachable(projectDir);
    } finally {
      releaseLock(projectDir);
    }
  } catch {
    return false;
  }
}
function buildDaemonInvocation(connInfo, input) {
  if (connInfo.type === "tcp") {
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      "$payload = [Console]::In.ReadLine()",
      `$client = New-Object System.Net.Sockets.TcpClient('${connInfo.host}', ${connInfo.port})`,
      "$stream = $client.GetStream()",
      "$writer = New-Object System.IO.StreamWriter($stream)",
      "$reader = New-Object System.IO.StreamReader($stream)",
      "$writer.WriteLine($payload)",
      "$writer.Flush()",
      "$response = $reader.ReadLine()",
      "$client.Close()",
      "Write-Output $response"
    ].join("; ");
    return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", psScript], stdin: input };
  }
  return { file: "nc", args: ["-U", connInfo.path || ""], stdin: input };
}
function queryDaemonSync(query, projectDir) {
  if (isIndexing(projectDir)) {
    return {
      indexing: true,
      status: "indexing",
      message: "Daemon is still indexing, results may be incomplete"
    };
  }
  const connInfo = getConnectionInfo(projectDir);
  if (!isDaemonReachable(projectDir)) {
    if (!tryStartDaemon(projectDir)) {
      return { status: "unavailable", error: "Daemon not running and could not start" };
    }
  }
  try {
    const input = JSON.stringify(query);
    const inv = buildDaemonInvocation(connInfo, input);
    const r = spawnSync(inv.file, inv.args, {
      input: inv.stdin,
      encoding: "utf-8",
      timeout: QUERY_TIMEOUT,
      shell: false
    });
    if (r.error) {
      const code = r.error.code;
      if (code === "ETIMEDOUT") return { status: "error", error: "timeout" };
      if (code === "ENOENT") return { status: "unavailable", error: "Daemon transport not available" };
      return { status: "error", error: r.error.message };
    }
    if (r.signal) return { status: "error", error: "timeout" };
    const out = (r.stdout || "").trim();
    if (r.status !== 0 || !out) {
      return { status: "unavailable", error: "Daemon not running" };
    }
    return JSON.parse(out);
  } catch (err) {
    if (err.killed) {
      return { status: "error", error: "timeout" };
    }
    if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ENOENT")) {
      return { status: "unavailable", error: "Daemon not running" };
    }
    return { status: "error", error: err.message || "Unknown error" };
  }
}
function trackHookActivitySync(hookName, projectDir, success = true, metrics = {}) {
  try {
    queryDaemonSync(
      { cmd: "track", hook: hookName, success, metrics },
      projectDir
    );
  } catch {
  }
}

// src/shared/context-bus.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, join as join6, resolve as resolve2, sep } from "node:path";
import { mkdirSync as mkdirSync5, existsSync as existsSync5 } from "node:fs";

// src/shared/session-bus-id.ts
import { createHash as createHash2 } from "node:crypto";
import { realpathSync } from "node:fs";

// src/shared/session-id.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";
var SESSION_ID_FILENAME = ".coordination-session-id";
function getSessionIdFile(options = {}) {
  const claudeDir = join2(process.env.HOME || process.env.USERPROFILE || homedir(), ".claude");
  if (options.createDir) {
    try {
      mkdirSync2(claudeDir, { recursive: true, mode: 448 });
    } catch {
    }
  }
  return join2(claudeDir, SESSION_ID_FILENAME);
}
function generateSessionId() {
  const spanId = process.env.BRAINTRUST_SPAN_ID;
  if (spanId) {
    return spanId.slice(0, 8);
  }
  return `s-${Date.now().toString(36)}`;
}
function readSessionId() {
  try {
    const sessionFile = getSessionIdFile();
    const id = readFileSync2(sessionFile, "utf-8").trim();
    return id || null;
  } catch {
    return null;
  }
}
function getSessionId(options = {}) {
  if (process.env.COORDINATION_SESSION_ID) {
    return process.env.COORDINATION_SESSION_ID;
  }
  const fileId = readSessionId();
  if (fileId) {
    return fileId;
  }
  if (options.debug) {
    console.error("[session-id] WARNING: No persisted session ID found, generating new one");
  }
  return generateSessionId();
}

// src/shared/session-bus-id.ts
var PROJECT_HASH_LEN = 12;
function defaultCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function hashProjectPath(cwd, realpath = realpathSync) {
  let resolved;
  try {
    resolved = realpath(cwd);
  } catch {
    resolved = cwd;
  }
  const normalized = resolved.toLowerCase();
  return createHash2("sha256").update(normalized).digest("hex").slice(0, PROJECT_HASH_LEN);
}
function sanitizeBusPart(part) {
  return part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, ".").slice(0, 40);
}
function getBusId(opts = {}) {
  try {
    const sessionId = sanitizeBusPart(getSessionId());
    const projectHash = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `${sessionId}-${projectHash}`;
  } catch {
    const fallback = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `s-unknown-${fallback}`;
  }
}

// src/shared/atomic-write.ts
import {
  writeFileSync as writeFileSync3,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  existsSync as existsSync3,
  openSync,
  closeSync,
  readFileSync as readFileSync3,
  statSync as statSync2,
  constants
} from "fs";
import { dirname, basename, join as join4 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync3, statSync, renameSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";
var LOG_DIR = join3(homedir2(), ".claude", "logs");
var LOG_FILE = join3(LOG_DIR, "hooks.log");
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
    mkdirSync3(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync2(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
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

// src/shared/atomic-write.ts
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname(filePath);
  const tmpFile = join4(dir, `.${basename(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync3(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync3(tmpFile)) unlinkSync2(tmpFile);
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
      writeFileSync3(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync2(lockFile);
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
    if (!existsSync3(filePath)) {
      current = null;
    } else {
      try {
        current = readFileSync3(filePath, "utf-8");
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

// src/shared/intel-bus.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, renameSync as renameSync3, statSync as statSync3, unlinkSync as unlinkSync3 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
var MAX_LINE_BYTES = 4096;
var MAX_INTEL_BUS_BYTES = 2e6;
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join5(root, ".claude", "logs", "intel-bus.jsonl");
}
function stripNewlinesDeep(value) {
  if (typeof value === "string") {
    return value.replace(/[\r\n]+/g, " ");
  }
  if (Array.isArray(value)) {
    return value.map(stripNewlinesDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripNewlinesDeep(v);
    }
    return out;
  }
  return value;
}
var SECRET_KEY_RE = /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|CONNECTION_?STRING|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL/i;
var SECRET_FIELD_NAME_RE = /^(.*[_-])?(password|passwd|secret|token|api_?key|access_?key|private_?key|authorization|credential|database_url|connection_?string)s?$/i;
var ASSIGNMENT_RE = /([A-Za-z0-9_]{1,128})(\s*[:=]\s*)("?)([^\s]{1,2048})/g;
function redactSecretString(s, keyHint) {
  if (keyHint && s.length > 0 && SECRET_FIELD_NAME_RE.test(keyHint)) {
    return "[REDACTED]";
  }
  let out = s;
  out = out.replace(/sk-[A-Za-z0-9_-]{16,512}/g, "sk-[REDACTED]").replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED-AWS-KEY]").replace(/gh[posru]_[A-Za-z0-9]{30,255}/g, "[REDACTED-GH-TOKEN]").replace(/xox[abprs]-[A-Za-z0-9-]{10,512}/gi, "[REDACTED-SLACK-TOKEN]").replace(
    /eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{6,2048}/g,
    "[REDACTED-JWT]"
  ).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,2048}/gi, "Bearer [REDACTED]").replace(/postgres(ql)?:\/\/[^:@\s/]+:[^@\s/]+@/gi, "postgresql://[REDACTED]@");
  out = out.replace(
    ASSIGNMENT_RE,
    (m, key, sep2, quote) => SECRET_KEY_RE.test(key) ? `${key}${sep2}${quote}[REDACTED]` : m
  );
  return out;
}
function redactSecretsDeep(value, keyHint) {
  if (typeof value === "string") {
    return redactSecretString(value, keyHint);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretsDeep(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, k);
    }
    return out;
  }
  return value;
}
function longestStringKey(obj) {
  let key = null;
  let len = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > len) {
      len = v.length;
      key = k;
    }
  }
  return key;
}
function appendIntelBus(event, opts = {}) {
  if (process.env.CCV3_BUS_OFF === "1") return;
  try {
    const now = opts.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const append = opts.append ?? defaultAppend;
    const path = intelBusPath(opts.projectDir);
    const stamped = {
      ...event,
      ts: event.ts ?? now(),
      schema_version: 1
    };
    const normalized = stripNewlinesDeep(redactSecretsDeep(stamped));
    let line = JSON.stringify(normalized) + "\n";
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
      const key = longestStringKey(normalized);
      if (key) {
        const marker = "...(truncated)";
        const withoutField = { ...normalized, [key]: "" };
        const overhead = Buffer.byteLength(JSON.stringify(withoutField) + "\n", "utf-8");
        const budget = MAX_LINE_BYTES - overhead - marker.length;
        if (budget > 0) {
          const original = String(normalized[key]);
          normalized[key] = original.slice(0, budget) + marker;
          line = JSON.stringify(normalized) + "\n";
        }
      }
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
        return;
      }
    }
    maybeRotate(path, opts.size, opts.rename);
    append(path, line);
  } catch {
  }
}
function defaultAppend(path, line) {
  const dir = dirname2(path);
  if (!existsSync4(dir)) {
    mkdirSync4(dir, { recursive: true });
  }
  appendFileSync2(path, line, "utf-8");
}
function defaultSize(path) {
  if (!existsSync4(path)) return 0;
  return statSync3(path).size;
}
function resolveMaxBytes() {
  const raw = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  if (raw !== void 0) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MAX_INTEL_BUS_BYTES;
}
function maybeRotate(path, sizeFn, renameFn) {
  try {
    const size = sizeFn ?? defaultSize;
    const rename = renameFn ?? renameSync3;
    const cap = resolveMaxBytes();
    let live = 0;
    try {
      live = size(path);
    } catch {
      return;
    }
    if (live >= cap) {
      rename(path, `${path}.1`);
    }
  } catch {
  }
}

// src/shared/context-bus.ts
var LATENCY_BUDGET_MS = 50;
var AMBIENT_CAP_RATIO = 0.3;
var AMBIENT_MIN_SLOTS = 3;
var MAX_CAS_RETRIES = 5;
var BUS_LOCK_TIMEOUT_MS = 200;
var BUS_WRITE_SLOW_MS = LATENCY_BUDGET_MS;
var LOAD_BEARING_ROLES = /* @__PURE__ */ new Set([
  "user_mentioned",
  "edited",
  "test_failed",
  "dependency_traced",
  "read_for_context"
]);
function emptyBus(busId) {
  return {
    bus_id: busId,
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0
  };
}
var VALID_BUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
function assertSafeBusId(busId) {
  if (typeof busId !== "string" || busId.length === 0 || busId === "." || busId === ".." || busId.includes("/") || busId.includes("\\") || busId.includes("..") || !VALID_BUS_ID.test(busId)) {
    throw new Error("unsafe bus id");
  }
}
function sessionCacheRoot(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join6(root, ".claude", "cache", "session");
}
function busPath(busId, projectDir) {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join6(sessionRoot, busId, "context.json");
  const resolvedRoot = resolve2(sessionRoot);
  const resolvedFull = resolve2(full);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedFull.startsWith(rootWithSep)) {
    throw new Error("bus path escapes session root");
  }
  return full;
}
function busOff() {
  return process.env.CCV3_BUS_OFF === "1";
}
function capTail(arr, cap) {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}
function capByTurn(arr, cap) {
  if (arr.length <= cap) return arr;
  return [...arr].sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0)).slice(arr.length - cap);
}
function coerceBus(busId, parsed) {
  const base = emptyBus(busId);
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed;
  return {
    bus_id: typeof p.bus_id === "string" ? p.bus_id : busId,
    current_intent: typeof p.current_intent === "string" ? p.current_intent : null,
    focus_symbols: capTail(
      Array.isArray(p.focus_symbols) ? p.focus_symbols : [],
      FOCUS_SYMBOLS_CAP
    ),
    files_in_play: coerceFilesInPlay(p.files_in_play),
    recent_findings: capTail(
      Array.isArray(p.recent_findings) ? p.recent_findings : [],
      RECENT_FINDINGS_CAP
    ),
    open_threads: capTail(
      Array.isArray(p.open_threads) ? p.open_threads : [],
      OPEN_THREADS_CAP
    ),
    schema_version: 3,
    compact_generation: typeof p.compact_generation === "number" ? p.compact_generation : 0,
    revision: typeof p.revision === "number" && Number.isFinite(p.revision) ? p.revision : 0,
    current_turn: typeof p.current_turn === "number" && Number.isFinite(p.current_turn) ? p.current_turn : 0
  };
}
function coerceFilesInPlay(value) {
  if (!value || typeof value !== "object") return { load_bearing: [], ambient: [] };
  const v = value;
  const lb = Array.isArray(v.load_bearing) ? v.load_bearing : [];
  const amb = Array.isArray(v.ambient) ? v.ambient : [];
  return {
    load_bearing: capByTurn(lb, LOAD_BEARING_CAP),
    ambient: capTail(amb, LOAD_BEARING_CAP)
  };
}
function defaultRead(path) {
  try {
    return readFileSync4(path, "utf-8");
  } catch {
    return null;
  }
}
function loadState(id, read, path) {
  let raw;
  try {
    raw = read(path);
  } catch {
    return { kind: "failed" };
  }
  if (raw == null) return { kind: "absent" };
  if (raw.trim().length === 0) return { kind: "absent" };
  try {
    return { kind: "present", bus: coerceBus(id, JSON.parse(raw)) };
  } catch {
    return { kind: "failed" };
  }
}
function mutateBus(busId, fn, opts = {}) {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);
  let path;
  try {
    path = busPath(id, opts.projectDir);
  } catch {
    return emptyBus(id);
  }
  if (opts.write) {
    return mutateViaSeam(id, path, fn, opts);
  }
  return mutateViaLock(id, path, fn, opts);
}
function mutateViaLock(id, path, fn, opts) {
  const read = opts.read;
  const lockTimeoutMs = opts.lockTimeoutMs ?? BUS_LOCK_TIMEOUT_MS;
  let result = emptyBus(id);
  let outcomeKnown = false;
  let acquired = false;
  let waitMs = 0;
  let writeMs;
  let wrote = false;
  try {
    ensureDir(path, opts);
    wrote = mutateStateWithLock(
      path,
      (current) => {
        let loaded;
        if (read) {
          loaded = loadState(id, read, path);
        } else if (current == null) {
          loaded = { kind: "absent" };
        } else if (current.trim().length === 0) {
          loaded = { kind: "absent" };
        } else {
          try {
            loaded = { kind: "present", bus: coerceBus(id, JSON.parse(current)) };
          } catch {
            loaded = { kind: "failed" };
          }
        }
        if (loaded.kind === "failed") {
          return null;
        }
        const base = loaded.kind === "present" ? loaded.bus : emptyBus(id);
        const baseRevision = base.revision;
        fn(base);
        base.revision = baseRevision + 1;
        result = base;
        return JSON.stringify(base, null, 2);
      },
      {
        lockTimeoutMs,
        onLockOutcome: (o) => {
          outcomeKnown = true;
          acquired = o.acquired;
          waitMs = o.wait_ms;
        },
        onWriteTiming: (o) => {
          writeMs = o.write_ms;
        }
      }
    );
  } catch {
  }
  if (!acquired) {
    emitDropEvent(id, waitMs, opts, outcomeKnown ? "lock_timeout" : "write_error");
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else if (!wrote) {
    emitDropEvent(id, waitMs, opts, "write_error");
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else {
    fireOutcome(opts, { dropped: false, wait_ms: waitMs, write_ms: writeMs });
    if (waitMs > BUS_WRITE_SLOW_MS || (writeMs ?? 0) > BUS_WRITE_SLOW_MS) {
      emitWriteTiming(id, waitMs, writeMs, opts);
    }
  }
  return result;
}
function emitDropEvent(id, waitMs, opts, reason) {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: "bus_write_dropped",
        reason,
        wait_ms: waitMs,
        duration_ms: waitMs
      },
      { projectDir: opts.projectDir }
    );
  } catch {
  }
}
function emitWriteTiming(id, waitMs, writeMs, opts) {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: "bus_write",
        wait_ms: waitMs,
        // Explicit null (not undefined): keep the field present so a consumer can
        // tell "write not measured" from "sub-ms write" (review finding).
        write_ms: writeMs ?? null,
        duration_ms: waitMs + (writeMs ?? 0)
      },
      { projectDir: opts.projectDir }
    );
  } catch {
  }
}
function fireOutcome(opts, o) {
  if (!opts.onOutcome) return;
  try {
    opts.onOutcome(o);
  } catch {
  }
}
function mutateViaSeam(id, path, fn, opts) {
  const read = opts.read ?? defaultRead;
  const write = opts.write;
  let working = emptyBus(id);
  try {
    const initial = loadState(id, read, path);
    if (initial.kind === "failed") return working;
    let base = initial.kind === "present" ? initial.bus : emptyBus(id);
    let baseRevision = base.revision;
    fn(base);
    working = base;
    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      if (opts.beforeWrite) opts.beforeWrite();
      const reload = loadState(id, read, path);
      if (reload.kind === "failed") {
        return working;
      }
      const currentRevision = reload.kind === "present" ? reload.bus.revision : 0;
      if (currentRevision === baseRevision) {
        working.revision = baseRevision + 1;
        write(path, JSON.stringify(working, null, 2));
        return working;
      }
      base = reload.kind === "present" ? reload.bus : emptyBus(id);
      baseRevision = base.revision;
      fn(base);
      working = base;
    }
    const tail = loadState(id, read, path);
    if (tail.kind === "failed") return working;
    const tailRevision = tail.kind === "present" ? tail.bus.revision : 0;
    working.revision = tailRevision + 1;
    try {
      write(path, JSON.stringify(working, null, 2));
    } catch {
    }
    return working;
  } catch {
    return working;
  }
}
function ensureDir(path, opts) {
  if (opts.write) return;
  try {
    const dir = dirname3(path);
    if (!existsSync5(dir)) mkdirSync5(dir, { recursive: true });
  } catch {
  }
}
function safeBusId() {
  try {
    return getBusId();
  } catch {
    return "s-unknown";
  }
}
var LOAD_BEARING_CAP = 50;
var FOCUS_SYMBOLS_CAP = 50;
var RECENT_FINDINGS_CAP = 50;
var OPEN_THREADS_CAP = 50;
function addFileInPlay(bus, file) {
  if (LOAD_BEARING_ROLES.has(file.role)) {
    const lbArr = bus.files_in_play.load_bearing;
    const existing = lbArr.find((f) => f.path === file.path && f.role === file.role);
    if (existing) {
      existing.turn_added = file.turn_added;
      existing.stale = file.stale;
      existing.stale_check = file.stale_check;
      return;
    }
    lbArr.push(file);
    if (lbArr.length > LOAD_BEARING_CAP) {
      lbArr.sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0));
      lbArr.splice(0, lbArr.length - LOAD_BEARING_CAP);
    }
    return;
  }
  const lb = bus.files_in_play.load_bearing.length;
  const amb = bus.files_in_play.ambient.length;
  const totalAfter = lb + amb + 1;
  const ambAfter = amb + 1;
  const withinFloor = ambAfter <= AMBIENT_MIN_SLOTS;
  const withinRatio = ambAfter / totalAfter <= AMBIENT_CAP_RATIO + 1e-9;
  if (withinFloor || withinRatio) {
    bus.files_in_play.ambient.push(file);
  }
}

// src/post-edit-diagnostics.ts
function recordBusFilesInPlay(filePath) {
  try {
    mutateBus(void 0, (b) => {
      addFileInPlay(b, { path: filePath, role: "edited", turn_added: b.current_turn ?? 0 });
    });
  } catch {
  }
}
function resolveTscCommand(projectDir) {
  const candidates = [
    join7(projectDir, "node_modules", "typescript", "bin", "tsc"),
    join7(projectDir, ".claude", "hooks", "node_modules", "typescript", "bin", "tsc")
  ];
  for (const tscPath of candidates) {
    try {
      if (existsSync6(tscPath)) {
        return {
          command: process.execPath,
          args: [tscPath, "--noEmit", "--pretty", "false"]
        };
      }
    } catch {
    }
  }
  return null;
}
async function main() {
  const input = JSON.parse(readFileSync5(0, "utf-8"));
  if (input.tool_name !== "Edit" && input.tool_name !== "Write") {
    console.log("{}");
    return;
  }
  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    console.log("{}");
    return;
  }
  const codeExtensions = [
    // Python (has linters: pyright + ruff)
    ".py",
    ".pyx",
    ".pyi",
    // TypeScript/JavaScript (has linter: tsc --noEmit)
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    // Go (TODO: add go vet)
    ".go",
    // Rust (TODO: add clippy)
    ".rs",
    // Java
    ".java",
    // C/C++
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cc",
    ".cxx",
    ".hh",
    // Ruby
    ".rb",
    // C#
    ".cs"
  ];
  const ext = filePath.substring(filePath.lastIndexOf("."));
  if (!codeExtensions.includes(ext)) {
    console.log("{}");
    return;
  }
  const pythonExtensions = [".py", ".pyx", ".pyi"];
  const tsJsExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (pythonExtensions.includes(ext)) {
    runPythonDiagnostics(filePath, projectDir);
  } else if (tsJsExtensions.includes(ext)) {
    runTscDiagnostics(filePath, projectDir);
  } else {
    console.log("{}");
  }
}
function runPythonDiagnostics(filePath, projectDir) {
  recordBusFilesInPlay(filePath);
  try {
    const response = queryDaemonSync(
      { cmd: "diagnostics", file: filePath },
      projectDir
    );
    if (response.status === "unavailable" || response.error) {
      console.log("{}");
      return;
    }
    const summary = response.summary || response;
    const typeErrors = summary.type_errors || 0;
    const lintIssues = summary.lint_errors || summary.lint_issues || 0;
    const errors = response.errors || [];
    trackHookActivitySync("post-edit-diagnostics", projectDir, true, {
      edits_analyzed: 1,
      type_errors: typeErrors,
      lint_issues: lintIssues
    });
    if (typeErrors === 0 && lintIssues === 0) {
      console.log("{}");
      return;
    }
    const lines = [];
    lines.push(`Diagnostics: ${typeErrors} type errors, ${lintIssues} lint issues`);
    const maxPreviews = 5;
    const previews = errors.slice(0, maxPreviews);
    for (const err of previews) {
      const location = err.column ? `${err.file}:${err.line}:${err.column}` : `${err.file}:${err.line}`;
      lines.push(`   - ${location}: ${err.message}`);
    }
    if (errors.length > maxPreviews) {
      const remaining = errors.length - maxPreviews;
      lines.push(`   ... and ${remaining} more`);
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: lines.join("\n")
      }
    };
    console.log(JSON.stringify(output));
  } catch {
    console.log("{}");
  }
}
var TSC_LINE_REGEX = /^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/;
function parseTscOutput(stdout) {
  const diagnostics = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(TSC_LINE_REGEX);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4],
        code: parseInt(match[5], 10),
        message: match[6]
      });
    }
  }
  return diagnostics;
}
function runTscDiagnostics(filePath, projectDir) {
  recordBusFilesInPlay(filePath);
  try {
    const tsc = resolveTscCommand(projectDir);
    if (!tsc) {
      console.log("{}");
      return;
    }
    const result = spawnSync2(tsc.command, tsc.args, {
      cwd: projectDir,
      timeout: 3e4,
      encoding: "utf-8",
      windowsHide: true
    });
    if (result.error || result.status === null) {
      console.log("{}");
      return;
    }
    const diagnostics = parseTscOutput(result.stdout || "");
    const errorCount = diagnostics.filter((d) => d.severity === "error").length;
    const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
    trackHookActivitySync("post-edit-diagnostics", projectDir, true, {
      edits_analyzed: 1,
      type_errors: errorCount,
      lint_issues: warningCount
    });
    if (diagnostics.length === 0) {
      console.log("{}");
      return;
    }
    const lines = [];
    lines.push(`Diagnostics: ${errorCount} type errors, ${warningCount} warnings`);
    const maxPreviews = 5;
    const previews = diagnostics.slice(0, maxPreviews);
    for (const d of previews) {
      lines.push(`   - ${d.file}:${d.line}:${d.column}: ${d.message}`);
    }
    if (diagnostics.length > maxPreviews) {
      const remaining = diagnostics.length - maxPreviews;
      lines.push(`   ... and ${remaining} more`);
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: lines.join("\n")
      }
    };
    console.log(JSON.stringify(output));
  } catch {
    console.log("{}");
  }
}
var isDirectInvocation = (() => {
  try {
    const arg1 = process.argv[1] || "";
    return arg1.endsWith("post-edit-diagnostics.mjs") || arg1.endsWith("post-edit-diagnostics.js") || arg1.endsWith("post-edit-diagnostics.ts");
  } catch {
    return false;
  }
})();
if (isDirectInvocation) {
  main().catch(() => console.log("{}"));
}
var __isDirectInvocation = isDirectInvocation;
export {
  __isDirectInvocation,
  recordBusFilesInPlay,
  resolveTscCommand
};
