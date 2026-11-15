#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir } from "os";
import { basename, join, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";

// src/shared/guard-log.ts
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
function guardSource(env) {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === "test" || named === "probe") return named;
  if (Object.hasOwn(env, "VITEST")) return "test";
  return env.CCV3_GUARD_DECISIONS_LOG ? "probe" : "live";
}
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];

// src/lib/trace-boot.ts
var TRACE_MARKER = "__CCV3_HOOK_TRACE_V1__";
var HOT_PROGRAMS = [
  "architecture-stats-sync",
  "commit-preflight",
  "decision-gate",
  "destructive-command-guard",
  "git-commit-roadmap",
  "file-claims",
  "holdout-scan",
  "hook-health-monitor",
  "identity-probe",
  "lane-agent-tag",
  "lane-board-republish-reminder",
  "lane-context",
  "mcp-activity-tracker",
  "msys-crash-capture",
  "package-install-guard",
  "periodic-extract",
  "pr-opened-review-loop",
  "pre-pr-gate",
  "roadmap-completion",
  "roadmap-reconcile",
  "rule-router",
  "scan-scope-guard",
  "session-register",
  "session-start-context-loaders",
  "session-start-continuity",
  "session-start-docker",
  "session-start-init-check",
  "session-start-intel-prune",
  "session-start-memory-loaders",
  "smarter-everyday",
  "test-run-tracker"
];
var DAY_CAP_BYTES = 32 * 1024 * 1024;
var PRUNE_DAYS = 10;
var STDIN_KEEP = 64 * 1024;
var STDOUT_KEEP = 8 * 1024;
var ERROR_MAX = 120;
function traceModeFrom(env, modeText) {
  if (env.CCV3_HOOK_TRACE === "0") return "off";
  const t = (modeText ?? "").trim().toLowerCase();
  return t === "off" || t === "all" ? t : "hot";
}
function readTraceMode(env, read = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join(homedir(), ".claude", "state", "hook-trace-mode"));
  } catch {
  }
  return traceModeFrom(env, text);
}
function shouldTrace(name, mode) {
  return mode === "all" || mode === "hot" && HOT_PROGRAMS.includes(name);
}
var realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return resolve(p);
  }
};
var caseKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
function underLiveDist(script, home) {
  if (!script) return false;
  try {
    return caseKey(realPath(script)).startsWith(caseKey(realPath(join(home, ".claude", "hooks", "dist"))) + sep);
  } catch {
    return false;
  }
}
function traceSource(env, script = process.argv[1], home = homedir()) {
  const g = guardSource(env);
  if (g !== "live") return g;
  if (env.CCV3_HOOK_TRACE_DIR) return "probe";
  return underLiveDist(script, home) ? "live" : "probe";
}
var traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join(homedir(), ".claude", "cache");
var SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
var EVENT_NAME = /^[A-Za-z]{1,40}$/;
var TOOL_NAME = /^[\w.:-]{1,100}$/;
var pick = (v, re) => typeof v === "string" && re.test(v) ? v : null;
function extractPayloadFields(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      return { sessionId: pick(o.session_id, SESSION_ID), event: pick(o.hook_event_name, EVENT_NAME), tool: pick(o.tool_name, TOOL_NAME) };
    }
  } catch {
  }
  const key = (k, re) => pick(new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,100})"`).exec(text)?.[1], re);
  return { sessionId: key("session_id", SESSION_ID), event: key("hook_event_name", EVENT_NAME), tool: key("tool_name", TOOL_NAME) };
}
function classifyObject(o) {
  const hso = o.hookSpecificOutput ?? {};
  const pd = hso.permissionDecision ?? o.permissionDecision;
  if (pd === "deny" || pd === "ask" || pd === "allow") return pd;
  if (o.decision === "block" || o.result === "block") return "block";
  if (typeof hso.additionalContext === "string") return "inject";
  if (typeof o.systemMessage === "string") return "message";
  return "none";
}
function classifyOut(text) {
  const t = text.trim();
  if (!t) return "none";
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" && !Array.isArray(o) ? classifyObject(o) : "none";
  } catch {
  }
  const pd = /"permissionDecision"\s*:\s*"(deny|ask|allow)"/.exec(t)?.[1];
  if (pd) return pd;
  if (/"decision"\s*:\s*"block"/.test(t)) return "block";
  if (/"additionalContext"\s*:/.test(t)) return "inject";
  if (/"systemMessage"\s*:/.test(t)) return "message";
  return "none";
}
var ERROR_WORD = /^[A-Za-z0-9_.]{1,40}$/;
var ERROR_CODE = /^[A-Za-z0-9_]{1,40}$/;
function maskError(err) {
  if (!(err instanceof Error)) return typeof err;
  try {
    const rawName = err.name;
    const name = typeof rawName === "string" && ERROR_WORD.test(rawName) ? rawName : "Error";
    const code = err.code;
    return (typeof code === "string" && ERROR_CODE.test(code) ? `${name}/${code}` : name).slice(0, ERROR_MAX);
  } catch {
    return "Error";
  }
}
var round1 = (n) => Math.round(n * 10) / 10;
function buildRow(i) {
  return {
    ts: i.ts.toISOString(),
    name: i.name,
    event: i.event,
    tool: i.tool,
    startupMs: round1(i.startupMs),
    durationMs: round1(i.durationMs),
    exitCode: i.code === 0 ? 0 : 1,
    code: i.code,
    sessionId: i.sessionId,
    out: i.out,
    error: i.error,
    source: i.source
  };
}
var DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.(?:jsonl|dropped)$/;
function pruneOld(dir, day, days) {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(f);
    if (m && m[1] < cutoff) {
      try {
        fs.unlinkSync(join(dir, f));
      } catch {
      }
    }
  }
}
function bumpDropped(file) {
  let n = 0;
  try {
    n = Number(JSON.parse(fs.readFileSync(file, "utf8")).dropped) || 0;
  } catch {
  }
  fs.writeFileSync(file, `${JSON.stringify({ dropped: n + 1, ts: (/* @__PURE__ */ new Date()).toISOString() })}
`);
}
function appendTraceRow(row, opts = {}) {
  try {
    const dir = opts.dir ?? traceDir(process.env);
    const day = row.ts.slice(0, 10);
    const file = join(dir, `hook-trace-${day}.jsonl`);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { recursive: true });
      try {
        pruneOld(dir, day, opts.pruneDays ?? PRUNE_DAYS);
      } catch {
      }
    }
    if (size >= (opts.capBytes ?? DAY_CAP_BYTES)) {
      bumpDropped(join(dir, `hook-trace-${day}.dropped`));
      return "dropped";
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}
`);
    return "written";
  } catch {
    return "error";
  }
}
var keep = (cur, chunk, max) => {
  if (cur.length >= max) return cur;
  const s = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
  return cur + s.slice(0, max - cur.length);
};
function lazyTap(name, onStream) {
  const d = Object.getOwnPropertyDescriptor(process, name);
  if (!d || !d.get || !d.configurable) return;
  const orig = d.get;
  let seen;
  Object.defineProperty(process, name, {
    configurable: true,
    enumerable: d.enumerable,
    get() {
      const s = orig.call(this);
      if (s && s !== seen) {
        seen = s;
        try {
          onStream(s);
        } catch {
        }
      }
      return s;
    }
  });
}
function bootTrace(env = process.env, _bootCall) {
  try {
    if (!process.argv[1]) return;
    const name = basename(process.argv[1], ".mjs");
    if (!shouldTrace(name, readTraceMode(env))) return;
    const startupMs = process.uptime() * 1e3;
    const t0 = performance.now();
    const state = { v: 1, stdinTouched: false, stdoutTouched: false };
    globalThis[TRACE_MARKER] = state;
    let stdinText = "";
    let stdoutText = "";
    let errText = null;
    const rawRead = fs.readFileSync;
    fs.readFileSync = function(...args) {
      const r = rawRead.apply(this, args);
      try {
        if (args[0] === 0 || args[0] === "/dev/stdin") stdinText = keep(stdinText, r, STDIN_KEEP);
      } catch {
      }
      return r;
    };
    try {
      Object.defineProperty(fs.readFileSync, "name", { value: "readFileSync", configurable: true });
      Object.defineProperty(fs.readFileSync, "length", { value: 2, configurable: true });
    } catch {
    }
    syncBuiltinESMExports();
    lazyTap("stdin", (s) => {
      state.stdinTouched = true;
      const emit = s.emit;
      s.emit = function(ev, chunk) {
        if (ev === "data") {
          try {
            stdinText = keep(stdinText, chunk, STDIN_KEEP);
          } catch {
          }
        }
        return emit.apply(this, arguments);
      };
    });
    lazyTap("stdout", (s) => {
      state.stdoutTouched = true;
      const write = s.write;
      s.write = function(chunk) {
        try {
          stdoutText = keep(stdoutText, chunk, STDOUT_KEEP);
        } catch {
        }
        return write.apply(this, arguments);
      };
    });
    process.on("uncaughtExceptionMonitor", (err) => {
      try {
        errText = maskError(err);
      } catch {
      }
    });
    process.on("exit", (code) => {
      try {
        const f = extractPayloadFields(stdinText);
        const row = buildRow({
          ts: /* @__PURE__ */ new Date(),
          name,
          event: f.event,
          tool: f.tool,
          startupMs,
          durationMs: performance.now() - t0,
          code: typeof code === "number" ? code : 0,
          sessionId: f.sessionId,
          out: classifyOut(stdoutText),
          error: errText,
          source: traceSource(env, process.argv[1])
        });
        appendTraceRow(row, { dir: traceDir(env) });
      } catch {
      }
    });
  } catch {
  }
}
if (!Object.hasOwn(process.env, "VITEST")) bootTrace(process.env, "__CCV3_HOOK_TRACE_BOOT_V1__");

// src/prd-roadmap-sync.ts
import * as fs2 from "fs";
import * as path2 from "path";

// src/shared/roadmap-parser.ts
var SECTION_PREFIXES = [
  // Order matters: more specific first.
  { key: "sessions", prefix: "## recent planning" },
  { key: "current", prefix: "## current" },
  { key: "completed", prefix: "## completed" },
  { key: "planned", prefix: "## planned" }
];
function detectSection(strippedLower) {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith("## ")) {
    return null;
  }
  return void 0;
}
function bucketize(rawPriority) {
  const p = rawPriority.toLowerCase();
  if (p.includes("high")) return "high";
  if (p.includes("low")) return "low";
  return "medium";
}
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: /* @__PURE__ */ new Map()
  };
  if (!content) return result;
  const lines = content.split("\n");
  let section = null;
  let sectionStart = -1;
  const closeSection = (endLine) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();
    const detected = detectSection(lower);
    const isAnyH2 = stripped.startsWith("## ");
    const isKnownH2 = typeof detected === "string";
    const isUnrelatedH2 = detected === null;
    if (isKnownH2) {
      closeSection(i);
      section = detected;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**") && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, "").trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, "").trim();
        } else {
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }
    if (section === "completed") {
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || ""
        });
      }
      continue;
    }
    if (section === "planned") {
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || "normal";
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority)
        });
      }
      continue;
    }
    if (section === "sessions") {
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: []
        });
        continue;
      }
      if (result.sessions.length > 0 && stripped.startsWith("-")) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }
    void isAnyH2;
  }
  closeSection(lines.length);
  return result;
}

// src/shared/roadmap-sync-guards.ts
import * as path from "path";
var GOAL_STOPWORDS = /* @__PURE__ */ new Set([
  "system",
  "app",
  "platform",
  "engine",
  "server",
  "service",
  "module",
  "project",
  "feature",
  "support",
  "the",
  "and",
  "for",
  "with",
  "new",
  "update",
  "fix",
  "add"
]);
function distinctiveTokens(text) {
  return new Set(
    (text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GOAL_STOPWORDS.has(w))
  );
}
function isTasksRelatedToGoal(featureName, goalTitle) {
  const f = (featureName || "").toLowerCase().trim();
  const g = (goalTitle || "").toLowerCase().trim();
  if (!f || !g) return false;
  if (g.includes(f) || f.includes(g)) return true;
  const featureTokens = distinctiveTokens(featureName);
  const goalTokens = distinctiveTokens(goalTitle);
  if (featureTokens.size === 0 || goalTokens.size === 0) return false;
  for (const t of goalTokens) {
    if (featureTokens.has(t)) return true;
  }
  return false;
}
function isPathInsideProject(targetPath, projectDir) {
  if (!targetPath || !projectDir) return false;
  const rel = path.relative(path.resolve(projectDir), path.resolve(targetPath));
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
function localDateStamp(now = /* @__PURE__ */ new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// src/shared/roadmap-audit.ts
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, readdirSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename3, dirname as dirname3, join as join5 } from "node:path";

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
import { dirname as dirname2, basename as basename2, join as join4 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join as join3 } from "path";
import { homedir as homedir2 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join3(homedir2(), ".claude", "logs", "hooks.log");
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
  const tmpFile = join4(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
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

// src/shared/roadmap-audit.ts
var MAX_REFUSED_DELETIONS = 20;
var CATASTROPHIC_MIN_RATIO = 0.25;
function sha256Prefix16(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}
function multisetCounts(lines) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}
function computeRemovedLines(beforeLines, afterLines) {
  const beforeCounts = multisetCounts(beforeLines);
  const afterCounts = multisetCounts(afterLines);
  const removed = [];
  for (const [line, count] of beforeCounts) {
    const remaining = count - (afterCounts.get(line) ?? 0);
    for (let i = 0; i < remaining; i++) {
      removed.push(line);
    }
  }
  return removed;
}
function defaultWrite(roadmapPath, before, after) {
  const captured = { transformDeclined: false, lockOutcome: null, writeMs: void 0 };
  const wrote = mutateStateWithLock(
    roadmapPath,
    (current) => {
      const observed = current ?? "";
      if (observed === before) return after;
      captured.transformDeclined = true;
      return null;
    },
    {
      onLockOutcome: (o) => {
        captured.lockOutcome = o;
      },
      onWriteTiming: (o) => {
        captured.writeMs = o.write_ms;
      }
    }
  );
  if (wrote) {
    return { wrote: true, wait_ms: captured.lockOutcome?.wait_ms, write_ms: captured.writeMs };
  }
  if (captured.lockOutcome && !captured.lockOutcome.acquired) {
    return { wrote: false, reason: "lock_timeout", wait_ms: captured.lockOutcome.wait_ms };
  }
  if (captured.transformDeclined) {
    return {
      wrote: false,
      reason: "concurrent_modification",
      wait_ms: captured.lockOutcome?.wait_ms
    };
  }
  return { wrote: false, reason: "write_failed", wait_ms: captured.lockOutcome?.wait_ms };
}
var ROADMAP_MANUAL_MARKER = /<!--\s*roadmap-sync\s*:\s*manual\s*-->/i;
var BAK_KEEP = 10;
function roadmapBakPath(projectDir, when = /* @__PURE__ */ new Date()) {
  const slug = basename3(projectDir).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = sha256Prefix16(projectDir).slice(0, 8);
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(3).toString("hex");
  return join5(homedir3(), ".claude", "state", "roadmap-bak", `${slug}-${hash}`, `${stamp}-${nonce}.md`);
}
function rotateBaks(dir) {
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - BAK_KEEP))) {
      try {
        unlinkSync2(join5(dir, stale));
      } catch {
      }
    }
  } catch {
  }
}
function defaultBackup(bakPath, content) {
  const dir = dirname3(bakPath);
  mkdirSync2(dir, { recursive: true });
  writeFileSync2(bakPath, content, "utf-8");
  rotateBaks(dir);
}
function defaultAppendLog(logPath, line) {
  mkdirSync2(dirname3(logPath), { recursive: true });
  appendFileSync2(logPath, line, "utf-8");
}
function appendAudit(projectDir, record, appendLogDep) {
  try {
    const logPath = join5(projectDir, ".claude", "logs", "roadmap-sync.jsonl");
    const line = JSON.stringify(record) + "\n";
    (appendLogDep ?? defaultAppendLog)(logPath, line);
  } catch {
  }
}
function writeRoadmapGuarded(args) {
  const {
    hook,
    tool,
    roadmapPath,
    projectDir,
    before,
    after,
    ops,
    allowedDeletions,
    allowFullRewrite,
    sessionId,
    deps
  } = args;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeBytes = Buffer.byteLength(before, "utf-8");
  const afterBytes = Buffer.byteLength(after, "utf-8");
  const base = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    hook,
    tool: tool ?? "unknown",
    project_dir: projectDir,
    roadmap_path: roadmapPath,
    before_sha256: sha256Prefix16(before),
    after_sha256: sha256Prefix16(after),
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    line_delta: afterLines.length - beforeLines.length,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    bytes_delta: afterBytes - beforeBytes,
    ops,
    session_id: sessionId ?? null
  };
  const finish = (outcome, extra = {}) => {
    const record = {
      ...base,
      outcome,
      bak_path: null,
      bak_error: null,
      ...extra
    };
    appendAudit(projectDir, record, deps?.appendLog);
    return { outcome, record };
  };
  if (after === before) {
    return finish("noop");
  }
  if (ROADMAP_MANUAL_MARKER.test(before)) {
    return finish("skipped", { reason: "opt_out_manual" });
  }
  if (!allowFullRewrite) {
    const allowedSet = new Set(allowedDeletions ?? []);
    const removed = computeRemovedLines(beforeLines, afterLines);
    const refused = removed.filter((line) => !allowedSet.has(line));
    if (refused.length > 0) {
      return finish("skipped", {
        reason: "deletion_guard",
        refused_deletions: refused.slice(0, MAX_REFUSED_DELETIONS)
      });
    }
  } else {
    const beforeTrim = before.trim();
    const afterTrim = after.trim();
    const tooSmall = beforeLines.length > 0 && afterLines.length < beforeLines.length * CATASTROPHIC_MIN_RATIO;
    if (beforeTrim !== "" && (afterTrim === "" || tooSmall)) {
      return finish("skipped", { reason: "catastrophic_rewrite" });
    }
  }
  const bakPath = roadmapBakPath(projectDir);
  let bakError = null;
  try {
    (deps?.backup ?? defaultBackup)(bakPath, before);
  } catch (err) {
    bakError = err instanceof Error ? err.message : String(err);
  }
  let writeResult;
  try {
    writeResult = (deps?.write ?? defaultWrite)(roadmapPath, before, after);
  } catch {
    writeResult = { wrote: false, reason: "write_failed" };
  }
  if (!writeResult.wrote) {
    return finish("skipped", {
      reason: writeResult.reason ?? "write_failed",
      bak_path: bakPath,
      bak_error: bakError,
      wait_ms: writeResult.wait_ms,
      write_ms: writeResult.write_ms
    });
  }
  return finish("written", {
    bak_path: bakPath,
    bak_error: bakError,
    wait_ms: writeResult.wait_ms,
    write_ms: writeResult.write_ms
  });
}

// src/shared/roadmap-splice.ts
function insertUnderSection(content, sectionPrefix, entry) {
  const prefixLower = sectionPrefix.trim().toLowerCase();
  const lines = content.split("\n");
  const result = [];
  let insertedEntry = false;
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().toLowerCase();
    if (stripped.startsWith(prefixLower)) {
      inSection = true;
      result.push(line);
      result.push(entry);
      insertedEntry = true;
      continue;
    }
    if (stripped.startsWith("## ") && inSection) {
      inSection = false;
    }
    result.push(line);
  }
  if (!insertedEntry) {
    const sectionIndex = result.findIndex(
      (l) => l.trim().toLowerCase().startsWith("## planned") || l.trim().toLowerCase().startsWith("## recent")
    );
    if (sectionIndex > 0) {
      result.splice(sectionIndex, 0, "", "## Completed", entry, "");
    } else {
      result.push("", "## Completed", entry);
    }
  }
  return result.join("\n");
}

// src/shared/engine-host.ts
var ENGINE_EVENT_NAMES = /* @__PURE__ */ new Set(["sessionStart", "postToolUse", "sessionEnd", "preToolUse", "userPromptSubmit"]);
function isEngineHost(input) {
  try {
    if (input === null || typeof input !== "object") return false;
    const event = input.hook_event_name;
    return typeof event === "string" && ENGINE_EVENT_NAMES.has(event);
  } catch {
    return false;
  }
}

// src/prd-roadmap-sync.ts
function readStdin() {
  return new Promise((resolve4) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve4(data));
    setTimeout(() => resolve4(data), 100).unref();
  });
}
function isPRDFile(filePath) {
  const basename5 = path2.basename(filePath).toLowerCase();
  return basename5.startsWith("prd-") && basename5.endsWith(".md");
}
function isTasksFile(filePath) {
  const basename5 = path2.basename(filePath).toLowerCase();
  return basename5.startsWith("tasks-") && basename5.endsWith(".md");
}
function extractPRDMetadata(content) {
  const result = {
    title: "Untitled PRD",
    status: "Draft",
    priority: "Normal",
    version: "1.0",
    created: localDateStamp()
  };
  const lines = content.split("\n");
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("# ") && result.title === "Untitled PRD") {
      result.title = stripped.slice(2).trim();
    }
    if (stripped.toLowerCase().startsWith("**status:**")) {
      result.status = stripped.replace(/^\*\*status:\*\*/i, "").trim();
    }
    if (stripped.toLowerCase().startsWith("**priority:**")) {
      result.priority = stripped.replace(/^\*\*priority:\*\*/i, "").trim();
    }
    if (stripped.toLowerCase().startsWith("**version:**")) {
      result.version = stripped.replace(/^\*\*version:\*\*/i, "").trim();
    }
    if (stripped.toLowerCase().startsWith("**created:**")) {
      result.created = stripped.replace(/^\*\*created:\*\*/i, "").trim();
    }
  }
  return result;
}
function extractTaskProgress(content, filePath) {
  const basename5 = path2.basename(filePath);
  const featureMatch = basename5.match(/tasks?-(.+)\.md/i);
  const featureName = featureMatch ? featureMatch[1].replace(/-/g, " ") : "Unknown Feature";
  const dir = path2.dirname(filePath);
  const prdPattern = basename5.replace(/^tasks?-/i, "prd-");
  const prdPath = path2.join(dir, prdPattern.replace("tasks-", "PRD-"));
  const prdFile = fs2.existsSync(prdPath) ? prdPath : null;
  const taskPattern = /^-\s*\[([ x])\]/gm;
  let match;
  let total = 0;
  let completed = 0;
  while ((match = taskPattern.exec(content)) !== null) {
    total++;
    if (match[1].toLowerCase() === "x") {
      completed++;
    }
  }
  const percentage = total > 0 ? Math.round(completed / total * 100) : 0;
  return {
    featureName,
    prdFile,
    total,
    completed,
    percentage,
    isComplete: total > 0 && completed === total
  };
}
function findRoadmapPath(startDir) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const roadmap = path2.join(projectDir, "ROADMAP.md");
    if (fs2.existsSync(roadmap)) return roadmap;
    const claudeRoadmap = path2.join(projectDir, ".claude", "ROADMAP.md");
    if (fs2.existsSync(claudeRoadmap)) return claudeRoadmap;
    return roadmap;
  }
  let current = path2.resolve(startDir);
  const root = path2.parse(current).root;
  let projectRoot = null;
  while (current !== root) {
    if (fs2.existsSync(path2.join(current, ".git")) || fs2.existsSync(path2.join(current, "package.json"))) {
      projectRoot = current;
      break;
    }
    current = path2.dirname(current);
  }
  if (projectRoot) {
    const candidate = path2.join(projectRoot, "ROADMAP.md");
    if (fs2.existsSync(candidate)) return candidate;
    const claudeCandidate = path2.join(projectRoot, ".claude", "ROADMAP.md");
    if (fs2.existsSync(claudeCandidate)) return claudeCandidate;
    return candidate;
  }
  return null;
}
function itemExists(items, title) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]/g, "");
  return items.some((item) => {
    const itemNormalized = item.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    return itemNormalized.includes(normalized) || normalized.includes(itemNormalized);
  });
}
function addToPlanned(content, item) {
  const lines = content.split("\n");
  const result = [];
  let addedToPlanned = false;
  let inPlanned = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim().toLowerCase();
    if (stripped.startsWith("## planned")) {
      inPlanned = true;
      result.push(lines[i]);
      const priority = item.priority || "normal";
      const source = item.source ? ` [${item.source}]` : "";
      result.push(`- [ ] ${item.title}${source} (${priority})`);
      addedToPlanned = true;
      continue;
    } else if (stripped.startsWith("## ") && inPlanned) {
      inPlanned = false;
    }
    result.push(lines[i]);
  }
  if (!addedToPlanned) {
    result.push("");
    result.push("## Planned");
    const priority = item.priority || "normal";
    const source = item.source ? ` [${item.source}]` : "";
    result.push(`- [ ] ${item.title}${source} (${priority})`);
  }
  return result.join("\n");
}
function updateProgress(content, title, progress) {
  const lines = content.split("\n");
  const result = [];
  const removed = [];
  let inCurrent = false;
  let foundTitle = false;
  let progressUpdated = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const lower = stripped.toLowerCase();
    if (lower.startsWith("## current")) {
      inCurrent = true;
      result.push(lines[i]);
      continue;
    } else if (lower.startsWith("## ") && inCurrent) {
      inCurrent = false;
    }
    if (inCurrent) {
      if (stripped.startsWith("**") && stripped.includes(title.split(" ")[0])) {
        foundTitle = true;
        result.push(lines[i]);
        continue;
      }
      if (foundTitle && stripped.toLowerCase().startsWith("- progress:")) {
        removed.push(lines[i]);
        result.push(`- Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)`);
        progressUpdated = true;
        continue;
      }
    }
    result.push(lines[i]);
  }
  if (foundTitle && !progressUpdated) {
    const newResult = [];
    let inserted = false;
    inCurrent = false;
    for (let i = 0; i < result.length; i++) {
      newResult.push(result[i]);
      const stripped = result[i].trim();
      const lower = stripped.toLowerCase();
      if (lower.startsWith("## current")) {
        inCurrent = true;
        continue;
      }
      if (inCurrent && !inserted && stripped.startsWith("**") && stripped.includes(title.split(" ")[0])) {
        newResult.push(`- Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)`);
        inserted = true;
      }
    }
    return { content: newResult.join("\n"), removed: [] };
  }
  return { content: result.join("\n"), removed };
}
function moveToCompleted(content, title) {
  const today = localDateStamp();
  return {
    content: insertUnderSection(content, "## completed", `- [x] ${title} (${today})`),
    removed: []
  };
}
function promoteToCurrent(content, item) {
  const lines = content.split("\n");
  const result = [];
  const removed = [];
  let inCurrent = false;
  let inPlanned = false;
  let removedFromPlanned = false;
  const today = localDateStamp();
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const lower = stripped.toLowerCase();
    if (lower.startsWith("## current")) {
      inCurrent = true;
      result.push(lines[i]);
      result.push("");
      result.push(`**${item.title}**`);
      result.push(`- Started: ${today}`);
      if (item.source) {
        result.push(`- Source: ${item.source}`);
      }
      result.push(`- Progress: 0/? tasks (0%)`);
      result.push("");
      continue;
    } else if (lower.startsWith("## planned")) {
      inCurrent = false;
      inPlanned = true;
      result.push(lines[i]);
      continue;
    } else if (lower.startsWith("## ")) {
      inCurrent = false;
      inPlanned = false;
    }
    if (inCurrent && stripped.includes("No current goal")) {
      removed.push(lines[i]);
      continue;
    }
    if (inPlanned && !removedFromPlanned && stripped.includes(item.title.split(" ")[0])) {
      removed.push(lines[i]);
      removedFromPlanned = true;
      continue;
    }
    result.push(lines[i]);
  }
  return { content: result.join("\n"), removed };
}
async function handlePRDChange(filePath, content, toolName) {
  const metadata = extractPRDMetadata(content);
  const fileDir = path2.dirname(filePath);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!isPathInsideProject(filePath, projectDir)) {
    return {
      result: "continue",
      message: "PRD file is outside current project directory"
    };
  }
  const roadmapPath = findRoadmapPath(fileDir);
  if (!roadmapPath) {
    return {
      result: "continue",
      message: `PRD detected: "${metadata.title}" - No ROADMAP.md found to sync`
    };
  }
  const roadmapContent = fs2.readFileSync(roadmapPath, "utf-8");
  const roadmap = parseRoadmap(roadmapContent);
  const allItems = [
    ...roadmap.current ? [roadmap.current] : [],
    ...roadmap.completed,
    ...roadmap.planned
  ];
  if (itemExists(allItems, metadata.title)) {
    return {
      result: "continue",
      message: `PRD "${metadata.title}" already in ROADMAP`
    };
  }
  const newItem = {
    title: metadata.title,
    priority: metadata.priority.toLowerCase(),
    source: path2.basename(filePath)
  };
  const updated = addToPlanned(roadmapContent, newItem);
  const { outcome } = writeRoadmapGuarded({
    hook: "prd-roadmap-sync",
    tool: toolName,
    roadmapPath,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    before: roadmapContent,
    after: updated,
    ops: [{ label: "prd-add-planned", lines_removed: 0, lines_added: 1 }]
  });
  if (outcome !== "written") {
    return {
      result: "continue",
      message: `ROADMAP NOT updated for PRD "${metadata.title}" (${outcome}) -- see .claude/logs/roadmap-sync.jsonl`
    };
  }
  return {
    result: "continue",
    message: `ROADMAP updated: Added "${metadata.title}" to Planned (from PRD)`
  };
}
async function handleTasksChange(filePath, content, toolName) {
  const progress = extractTaskProgress(content, filePath);
  const fileDir = path2.dirname(filePath);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!isPathInsideProject(filePath, projectDir)) {
    return {
      result: "continue",
      message: "Tasks file is outside current project directory"
    };
  }
  const roadmapPath = findRoadmapPath(fileDir);
  if (!roadmapPath) {
    return {
      result: "continue",
      message: `Tasks progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`
    };
  }
  const roadmapContent = fs2.readFileSync(roadmapPath, "utf-8");
  const roadmap = parseRoadmap(roadmapContent);
  const inPlanned = roadmap.planned.find(
    (item) => item.title.toLowerCase().includes(progress.featureName.toLowerCase().split(" ")[0])
  );
  const isCurrent = roadmap.current && roadmap.current.title.toLowerCase().includes(progress.featureName.toLowerCase().split(" ")[0]);
  let edit = { content: roadmapContent, removed: [] };
  let message = "";
  let clearFocusAdvice = "";
  if (progress.isComplete) {
    if (roadmap.current) {
      if (isTasksRelatedToGoal(progress.featureName, roadmap.current.title)) {
        const titleToComplete = roadmap.current.title;
        edit = moveToCompleted(roadmapContent, titleToComplete);
        message = `ROADMAP updated: "${titleToComplete}" marked complete (100%)`;
        clearFocusAdvice = ` Current Focus still shows "${titleToComplete}" and its detail bullets -- they are hand-written, so this hook leaves them alone. Run \`/roadmap complete\` (or \`/roadmap focus <next goal>\`) to clear it once you have salvaged anything still open.`;
      } else {
        message = `Tasks complete (100%) for "${progress.featureName}" but unrelated to current goal "${roadmap.current.title}" -- ROADMAP completion skipped`;
      }
    } else {
      edit = moveToCompleted(roadmapContent, progress.featureName);
      message = `ROADMAP updated: "${progress.featureName}" marked complete (100%)`;
    }
  } else if (inPlanned && !roadmap.current) {
    edit = promoteToCurrent(roadmapContent, {
      title: inPlanned.title,
      source: path2.basename(filePath)
    });
    message = `ROADMAP updated: Promoted "${inPlanned.title}" to Current`;
  } else if (isCurrent) {
    edit = updateProgress(roadmapContent, roadmap.current.title, progress);
    message = `ROADMAP progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`;
  } else if (inPlanned) {
    message = `Tasks started for planned item "${inPlanned.title}" - will promote when current goal completes`;
  } else {
    message = `Tasks progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`;
  }
  if (edit.content !== roadmapContent) {
    const { outcome, record } = writeRoadmapGuarded({
      hook: "prd-roadmap-sync",
      tool: toolName,
      roadmapPath,
      projectDir,
      before: roadmapContent,
      after: edit.content,
      allowedDeletions: edit.removed,
      ops: [
        {
          label: "prd-tasks-sync",
          lines_removed: edit.removed.length,
          lines_added: edit.content.split("\n").length - roadmapContent.split("\n").length + edit.removed.length
        }
      ]
    });
    if (outcome !== "written") {
      const detail = record.refused_deletions?.length ? ` Would have removed: ${record.refused_deletions.slice(0, 3).join(" | ")}` : "";
      message = `ROADMAP NOT updated (${outcome}${record.reason ? `: ${record.reason}` : ""}).${detail} See .claude/logs/roadmap-sync.jsonl`;
    } else {
      message += clearFocusAdvice;
    }
  }
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } };
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (isEngineHost(data)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (!["Write", "Edit"].includes(data.tool_name)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const filePath = data.tool_input.file_path;
  if (!filePath) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let result;
  if (isPRDFile(filePath)) {
    const content = fs2.existsSync(filePath) ? fs2.readFileSync(filePath, "utf-8") : "";
    result = await handlePRDChange(filePath, content, data.tool_name);
  } else if (isTasksFile(filePath)) {
    const content = fs2.existsSync(filePath) ? fs2.readFileSync(filePath, "utf-8") : "";
    result = await handleTasksChange(filePath, content, data.tool_name);
  } else {
    result = { result: "continue" };
  }
  console.log(JSON.stringify(result));
}
main().catch((err) => {
  console.error("[prd-roadmap-sync] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
