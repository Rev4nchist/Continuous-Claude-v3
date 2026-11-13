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

// src/pre-compact-lane-note.ts
import * as fs2 from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

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
import { dirname as dirname2, basename as basename2, join as join3 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
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
  const tmpFile = join3(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
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
function writeStateWithLock(filePath, content) {
  const locked = acquireLockSync(filePath);
  try {
    atomicWriteSync(filePath, content);
  } catch (err) {
    log.error("State write failed", { filePath, error: String(err) });
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

// src/pre-compact-lane-note.ts
var COOLDOWN_MS = 5 * 60 * 1e3;
var CALL_TIMEOUT_MS = 4e3;
var TOTAL_BUDGET_MS = 1e4;
var TODO_MAX = 120;
var NOTE_MAX = 300;
var BRANCH_MAX = 80;
var TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
var SAFE_LANE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
var skipped = (why) => ({ continue: true, systemMessage: `[PreCompact] lane note skipped: ${why}` });
function pickHeldLanes(boardJson, sessionId) {
  const lanes = boardJson?.lanes;
  if (!Array.isArray(lanes)) return [];
  const ids = [];
  for (const l of lanes) {
    const lane = l;
    if (!lane || typeof lane.id !== "string") continue;
    if (lane.owner_session_id !== sessionId || lane.state === "done") continue;
    if (SAFE_LANE_ID.test(lane.id)) ids.push(lane.id);
  }
  return ids;
}
function toOneLine(text) {
  return text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}
function buildCompactText(opts) {
  const trigger = opts.trigger === "manual" || opts.trigger === "auto" ? opts.trigger : "unknown";
  const hh = String(opts.now.getHours()).padStart(2, "0");
  const mm = String(opts.now.getMinutes()).padStart(2, "0");
  const todo = toOneLine(opts.todo ?? "").slice(0, TODO_MAX).trim();
  const branch = toOneLine(opts.branch ?? "").slice(0, BRANCH_MAX).trim();
  const text = `Compacting (${trigger}) at ${hh}:${mm} local${branch ? ` on branch ${branch}` : ""}.` + (todo ? ` Open task: ${todo}.` : "");
  return text.slice(0, NOTE_MAX);
}
function lastTodoWrite(transcriptText) {
  let last = null;
  let at = -1;
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("TodoWrite")) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const part of entry.message.content) {
        if (part?.type === "tool_use" && part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
          last = part.input.todos;
          at = i;
        }
      }
    } catch {
    }
  }
  const hit = last?.find((t) => t && t.status === "in_progress" && typeof t.content === "string");
  return hit ? { text: hit.content, at } : null;
}
function firstInProgressTodo(transcriptText) {
  return lastTodoWrite(transcriptText)?.text ?? null;
}
function firstInProgressTask(transcriptText) {
  const pending = /* @__PURE__ */ new Map();
  const subjects = /* @__PURE__ */ new Map();
  const status = /* @__PURE__ */ new Map();
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes('"task"')) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      if (entry.type === "assistant") {
        for (const part of content) {
          if (part?.type !== "tool_use") continue;
          if (part.name === "TaskCreate" && typeof part.input?.subject === "string" && typeof part.id === "string") {
            pending.set(part.id, part.input.subject);
          } else if (part.name === "TaskUpdate" && typeof part.input?.taskId === "string") {
            if (typeof part.input.subject === "string") subjects.set(part.input.taskId, part.input.subject);
            if (typeof part.input.status === "string") status.set(part.input.taskId, { status: part.input.status, at: i });
          }
        }
      } else if (entry.type === "user" && typeof entry.toolUseResult?.task?.id === "string") {
        for (const part of content) {
          const subject = part?.type === "tool_result" ? pending.get(part.tool_use_id) : void 0;
          if (subject !== void 0) subjects.set(entry.toolUseResult.task.id, subject);
        }
      }
    } catch {
    }
  }
  const open = [...status.entries()].filter(([id, s]) => s.status === "in_progress" && subjects.has(id)).sort((a, b) => Number(a[0]) - Number(b[0]));
  return open.length ? { text: subjects.get(open[0][0]), at: open[0][1].at } : null;
}
function currentWorkText(transcriptText) {
  const todo = lastTodoWrite(transcriptText);
  const task = firstInProgressTask(transcriptText);
  if (todo && task) return todo.at > task.at ? todo.text : task.text;
  return (todo ?? task)?.text ?? null;
}
function branchOf(cwd) {
  try {
    let dir = path.resolve(cwd || ".");
    for (let i = 0; i < 8; i++) {
      const dotGit = path.join(dir, ".git");
      if (fs2.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs2.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs2.readFileSync(dotGit, "utf-8"));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs2.readFileSync(path.join(gitDir, "HEAD"), "utf-8"));
        return ref ? ref[1].trim() : null;
      }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
  }
  return null;
}
function inCooldown(state, sessionId, nowMs) {
  const last = state?.[sessionId];
  return typeof last === "number" && nowMs - last < COOLDOWN_MS;
}
function readState(stateFile) {
  try {
    const data = JSON.parse(fs2.readFileSync(stateFile, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function stampState(stateFile, sessionId, nowMs) {
  try {
    const next = {};
    for (const [k, v] of Object.entries(readState(stateFile))) {
      if (typeof v === "number" && nowMs - v < COOLDOWN_MS) next[k] = v;
    }
    next[sessionId] = nowMs;
    fs2.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeStateWithLock(stateFile, JSON.stringify(next, null, 2));
  } catch {
  }
}
function readTranscriptTail(file) {
  if (!file) return "";
  try {
    const fd = fs2.openSync(file, "r");
    try {
      const size = fs2.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs2.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf-8");
    } finally {
      fs2.closeSync(fd);
    }
  } catch {
    return "";
  }
}
var spawnLaneCli = (laneCli) => (args, opts) => new Promise((resolve3) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve3({ code, stdout, stderr });
  };
  let proc;
  try {
    proc = spawn(process.execPath, [laneCli, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    resolve3({ code: -1, stdout, stderr });
    return;
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
    }
    stderr += "timeout";
    done(-1);
  }, opts.timeoutMs);
  proc.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("error", () => done(-1));
  proc.on("close", (code) => done(code ?? -1));
});
async function runPreCompactLaneNote(input, deps) {
  try {
    const sessionId = input.session_id;
    if (!sessionId) return skipped("no session id");
    const started = deps.now().getTime();
    if (inCooldown(readState(deps.stateFile), sessionId, started)) return skipped("cooldown (noted within 5 minutes)");
    const cwd = input.cwd || process.cwd();
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const left = () => Math.min(CALL_TIMEOUT_MS, TOTAL_BUDGET_MS - (deps.now().getTime() - started));
    const boardRun = await deps.runner(["board", "--json"], { cwd, env, timeoutMs: left() });
    if (boardRun.code !== 0) return skipped(`lane board unavailable (exit ${boardRun.code})`);
    let boardJson;
    try {
      boardJson = JSON.parse(boardRun.stdout);
    } catch {
      return skipped("lane board output is not JSON");
    }
    const held = pickHeldLanes(boardJson, sessionId);
    if (held.length === 0) return skipped("no held lane");
    const text = buildCompactText({
      trigger: input.trigger,
      now: deps.now(),
      todo: currentWorkText(readTranscriptTail(input.transcript_path)),
      branch: branchOf(cwd)
    });
    let written = 0;
    for (const laneId of held) {
      if (left() <= 0) break;
      try {
        const r = await deps.runner(["compact", laneId, text], { cwd, env, timeoutMs: left() });
        if (r.code === 0) written++;
      } catch {
      }
    }
    if (written === 0) return skipped("every compact event write failed");
    stampState(deps.stateFile, sessionId, started);
    return { continue: true, systemMessage: `[PreCompact] compact event logged on ${written} lane(s)` };
  } catch (err) {
    return skipped(`error (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
  }
}
async function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve3(data));
  });
}
async function main() {
  let out;
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const home = process.env.CCV3_USER_HOME || os.homedir();
    const laneCli = path.join(home, ".claude", "scripts", "lane.mjs");
    out = await runPreCompactLaneNote(input, {
      runner: spawnLaneCli(laneCli),
      now: () => /* @__PURE__ */ new Date(),
      // One file under ~/.claude/state, not the project folder: no stray state file in every project you compact in.
      stateFile: path.join(home, ".claude", "state", "pre-compact-lane-note.json"),
      laneCli
    });
  } catch {
    out = skipped("bad hook input");
  }
  console.log(JSON.stringify(out));
}
if ((process.argv[1] || "").includes("pre-compact-lane-note")) {
  main().catch(() => console.log(JSON.stringify(skipped("error"))));
}
export {
  branchOf,
  buildCompactText,
  currentWorkText,
  firstInProgressTask,
  firstInProgressTodo,
  inCooldown,
  pickHeldLanes,
  runPreCompactLaneNote,
  spawnLaneCli
};
