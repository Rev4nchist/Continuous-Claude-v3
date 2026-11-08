#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/bus-tool-populator.ts
import { readFileSync as readFileSync4, statSync as statSync4, realpathSync as realpathSync2 } from "fs";
import { resolve as resolve2, relative, isAbsolute } from "path";

// src/shared/context-bus.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname4, join as join5, resolve, sep } from "node:path";
import { mkdirSync as mkdirSync4, existsSync as existsSync4 } from "node:fs";

// src/shared/session-bus-id.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

// src/shared/session-id.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var SESSION_ID_FILENAME = ".coordination-session-id";
function getSessionIdFile(options = {}) {
  const claudeDir = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".claude");
  if (options.createDir) {
    try {
      mkdirSync(claudeDir, { recursive: true, mode: 448 });
    } catch {
    }
  }
  return join(claudeDir, SESSION_ID_FILENAME);
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
    const id = readFileSync(sessionFile, "utf-8").trim();
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
  return createHash("sha256").update(normalized).digest("hex").slice(0, PROJECT_HASH_LEN);
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
  writeFileSync as writeFileSync2,
  renameSync as renameSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync as readFileSync2,
  statSync as statSync2,
  constants
} from "fs";
import { dirname as dirname2, basename, join as join3 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync as mkdirSync2, statSync, renameSync } from "fs";
import { dirname, join as join2 } from "path";
import { homedir as homedir2 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join2(homedir2(), ".claude", "logs", "hooks.log");
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
    mkdirSync2(LOG_DIR, { recursive: true });
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
  const dir = dirname2(filePath);
  const tmpFile = join3(dir, `.${basename(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync2(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync(tmpFile);
    } catch {
    }
    throw err;
  }
}
var missingLockDirsLogged = /* @__PURE__ */ new Set();
function warnLockDirMissing(lockFile) {
  const dir = dirname2(lockFile);
  if (missingLockDirsLogged.has(dir)) return;
  missingLockDirsLogged.add(dir);
  log.warn("Lock dir missing, lock not acquired", { lockFile, dir });
}
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync2(fd, `${process.pid}
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
      } else if (err.code === "ENOENT") {
        warnLockDirMissing(lockFile);
        return false;
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
        current = readFileSync2(filePath, "utf-8");
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
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, renameSync as renameSync3, statSync as statSync3, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
var MAX_LINE_BYTES = 4096;
var MAX_INTEL_BUS_BYTES = 2e6;
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join4(root, ".claude", "logs", "intel-bus.jsonl");
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
  const dir = dirname3(path);
  if (!existsSync3(dir)) {
    mkdirSync3(dir, { recursive: true });
  }
  appendFileSync2(path, line, "utf-8");
}
function defaultSize(path) {
  if (!existsSync3(path)) return 0;
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
  return join5(root, ".claude", "cache", "session");
}
function busPath(busId, projectDir) {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join5(sessionRoot, busId, "context.json");
  const resolvedRoot = resolve(sessionRoot);
  const resolvedFull = resolve(full);
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
    return readFileSync3(path, "utf-8");
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
    const dir = dirname4(path);
    if (!existsSync4(dir)) mkdirSync4(dir, { recursive: true });
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

// src/bus-tool-populator.ts
var GREP_HIT_CAP = 8;
var GREP_SCAN_LINES = 200;
var NOISE_SEGMENTS = ["node_modules", ".git", "dist", "build", "coverage", ".next", ".claude/cache", ".venv", "__pycache__"];
function isNoise(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return NOISE_SEGMENTS.some((seg) => norm === seg || norm.startsWith(seg + "/") || norm.includes("/" + seg + "/"));
}
function toRecordablePath(candidate, projectDir) {
  if (!candidate || typeof candidate !== "string") return null;
  let real;
  let realRoot;
  try {
    real = realpathSync2(resolve2(projectDir, candidate));
    realRoot = realpathSync2(projectDir);
    if (!statSync4(real).isFile()) return null;
  } catch {
    return null;
  }
  const relRaw = relative(realRoot, real);
  if (!relRaw || relRaw.startsWith("..") || isAbsolute(relRaw)) return null;
  const rel = relRaw.replace(/\\/g, "/");
  if (isNoise(rel)) return null;
  return rel;
}
function extractReadFile(filePath, projectDir) {
  return filePath ? toRecordablePath(filePath, projectDir) : null;
}
function extractGrepHits(toolResponse, projectDir) {
  let text;
  try {
    text = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse ?? "");
  } catch {
    return [];
  }
  if (!text) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const lines = text.split(/\r?\n/).slice(0, GREP_SCAN_LINES);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const candidates = [t];
    const m = t.match(/^(.*?):\d+(?::|$)/);
    if (m && m[1]) candidates.push(m[1]);
    for (const c of candidates) {
      const rel = toRecordablePath(c, projectDir);
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        out.push(rel);
        break;
      }
    }
    if (out.length >= GREP_HIT_CAP) break;
  }
  return out;
}
function recordRead(filePath, projectDir) {
  const rel = extractReadFile(filePath, projectDir);
  if (!rel) return;
  try {
    mutateBus(
      void 0,
      (b) => {
        addFileInPlay(b, { path: rel, role: "read_for_context", turn_added: b.current_turn ?? 0 });
      },
      { projectDir }
    );
  } catch {
  }
}
function recordGrep(toolResponse, projectDir) {
  const hits = extractGrepHits(toolResponse, projectDir);
  if (hits.length === 0) return;
  try {
    mutateBus(
      void 0,
      (b) => {
        for (const h of hits) {
          addFileInPlay(b, { path: h, role: "grep_hit", turn_added: b.current_turn ?? 0 });
        }
      },
      { projectDir }
    );
  } catch {
  }
}
function main() {
  let input = {};
  try {
    const raw = readFileSync4(0, "utf-8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const tool = input.tool_name || input.tool;
    if (tool === "Read") recordRead(input.tool_input?.file_path, projectDir);
    else if (tool === "Grep") recordGrep(input.tool_response, projectDir);
  } catch {
  }
  console.log("{}");
}
if (process.argv[1] && process.argv[1].includes("bus-tool-populator")) {
  main();
}
export {
  extractGrepHits,
  extractReadFile,
  recordGrep,
  recordRead
};
