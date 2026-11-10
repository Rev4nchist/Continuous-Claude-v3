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

// src/git-commit-roadmap.ts
import * as fs2 from "fs";
import * as path2 from "path";
import { execFileSync } from "node:child_process";

// src/shared/roadmap-sync-guards.ts
import * as path from "path";
import { homedir as homedir2 } from "node:os";
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
function normalizeShellPath(p) {
  if (!p || process.platform !== "win32") return p;
  let m = p.match(/^\/cygdrive\/([A-Za-z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${m[2] || "/"}`;
  m = p.match(/^\/([A-Za-z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${m[2] || "/"}`;
  return p;
}
var GIT_VALUE_OPTS = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix"
]);
var SHELL_SEPARATORS = /* @__PURE__ */ new Set(["&&", "||", ";", "|", "&"]);
function tokenizeCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}
function parseGitCommitInvocations(command) {
  if (!command) return [];
  const tokens = tokenizeCommand(command);
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== "git" && !/[\\/]git(\.exe)?$/i.test(tokens[i])) continue;
    let cTarget = null;
    let j = i + 1;
    let subcommand = null;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok.startsWith("-")) {
        const eq = tok.indexOf("=");
        if (eq > 0) {
          const name = tok.slice(0, eq);
          if (name === "--work-tree" || name === "--git-dir") cTarget = tok.slice(eq + 1);
          j += 1;
          continue;
        }
        if (GIT_VALUE_OPTS.has(tok)) {
          if (tok === "-C") cTarget = tokens[j + 1] ?? null;
          j += 2;
          continue;
        }
        j += 1;
        continue;
      }
      subcommand = tok;
      break;
    }
    if (subcommand?.toLowerCase() !== "commit") continue;
    let hasAmend = false;
    for (let k = j + 1; k < tokens.length; k++) {
      if (SHELL_SEPARATORS.has(tokens[k])) break;
      if (tokens[k] === "--amend") {
        hasAmend = true;
        break;
      }
    }
    found.push({ cTarget, hasAmend });
    i = j;
  }
  return found;
}
function extractCdTarget(command) {
  if (!command) return null;
  const commitIdx = command.search(/git\s+(?:-[^\s]+(?:\s+[^\s-]\S*)?\s+)*commit\b/i);
  const scope = commitIdx >= 0 ? command.slice(0, commitIdx) : command;
  const m = scope.match(/(?:^|[;&|]\s*|&&\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}
function resolveShellTarget(target, base) {
  let resolved = normalizeShellPath(target);
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    resolved = path.join(homedir2(), resolved.slice(1));
  }
  return path.isAbsolute(resolved) ? path.resolve(resolved) : path.resolve(base, resolved);
}
function commitRanInProject(command, projectDir) {
  const cdTarget = extractCdTarget(command);
  const cwd = cdTarget ? resolveShellTarget(cdTarget, projectDir) : path.resolve(projectDir);
  if (cdTarget && !isPathInsideProject(cwd, projectDir)) return false;
  for (const invocation of parseGitCommitInvocations(command)) {
    if (!invocation.cTarget) continue;
    const effective = resolveShellTarget(invocation.cTarget, cwd);
    if (!isPathInsideProject(effective, projectDir)) return false;
  }
  return true;
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

// src/shared/roadmap-audit.ts
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, readdirSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
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
import { homedir as homedir3 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join3(homedir3(), ".claude", "logs", "hooks.log");
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
  return join5(homedir4(), ".claude", "state", "roadmap-bak", `${slug}-${hash}`, `${stamp}-${nonce}.md`);
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
function appendRoadmapAuditRecord(projectDir, record) {
  appendAudit(projectDir, record);
}

// src/git-commit-roadmap.ts
var COMMIT_PATTERNS = {
  conventional: /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i,
  commitOutput: /^\[([^\s]+)\s+([a-f0-9]{7,})\]\s+(.+)$/m,
  amendIndicator: /\[.*\s+[a-f0-9]+\].*\(amend\)/i,
  mergeIndicator: /^Merge\s+(branch|pull request|remote-tracking)/i,
  revertIndicator: /^Revert\s+"/i
};
var SKIP_TYPES = /* @__PURE__ */ new Set(["chore", "style", "ci"]);
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
function readStdin() {
  return new Promise((resolve4) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve4(data));
    setTimeout(() => resolve4(data), 1e3).unref();
  });
}
function isGitCommitCommand(command) {
  const invocations = parseGitCommitInvocations(command);
  return invocations.length > 0 && invocations.some((inv) => !inv.hasAmend);
}
function isSuccessfulCommit(response) {
  return COMMIT_PATTERNS.commitOutput.test(response) && !COMMIT_PATTERNS.amendIndicator.test(response);
}
function parseCommitFromOutput(output) {
  const commitMatch = output.match(COMMIT_PATTERNS.commitOutput);
  if (!commitMatch) {
    return null;
  }
  const [, branch, hash, message] = commitMatch;
  const trimmedMsg = message.trim();
  const isAmend = COMMIT_PATTERNS.amendIndicator.test(output);
  const isMerge = COMMIT_PATTERNS.mergeIndicator.test(trimmedMsg);
  const isRevert = COMMIT_PATTERNS.revertIndicator.test(trimmedMsg);
  const conventionalMatch = trimmedMsg.match(COMMIT_PATTERNS.conventional);
  if (conventionalMatch) {
    const [, type, scope, desc] = conventionalMatch;
    return {
      type: type.toLowerCase(),
      scope: scope || null,
      description: desc.trim(),
      hash,
      isAmend,
      isMerge,
      isRevert
    };
  }
  return {
    type: "other",
    scope: null,
    description: trimmedMsg,
    hash,
    isAmend,
    isMerge,
    isRevert
  };
}
function findRoadmapPath(projectDir) {
  const candidates = [
    path2.join(projectDir, "ROADMAP.md"),
    path2.join(projectDir, ".claude", "ROADMAP.md"),
    path2.join(projectDir, "roadmap.md")
  ];
  for (const candidate of candidates) {
    if (fs2.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
function formatCommitEntry(commit, date) {
  const typeLabel = commit.type !== "other" ? commit.type : "";
  const scopeLabel = commit.scope ? `(${commit.scope})` : "";
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` : typeLabel ? `${typeLabel}: ` : scopeLabel ? `${scopeLabel} ` : "";
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : "";
  return `- [x] ${prefix}${commit.description} (${date})${hashLabel}`;
}
function isDuplicateEntry(content, commit) {
  if (commit.hash) {
    if (content.includes(commit.hash.slice(0, 7))) {
      return true;
    }
  }
  const descLower = commit.description.toLowerCase();
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.trim().startsWith("- [x]")) {
      const lineLower = line.toLowerCase();
      if (lineLower.includes(descLower.slice(0, 30))) {
        return true;
      }
    }
  }
  return false;
}
function appendToCompleted(content, entry) {
  return insertUnderSection(content, "## completed", entry);
}
function shouldAutoCommitRoadmap(opts) {
  const env = opts.env ?? process.env;
  if (env.CCV3_ROADMAP_AUTOCOMMIT === "0") {
    return { ok: false, reason: "autocommit_disabled" };
  }
  const expectedPath = path2.join(opts.projectDir, "ROADMAP.md");
  if (opts.roadmapPath !== expectedPath) {
    return { ok: false, reason: "path_mismatch" };
  }
  if (!isPathInsideProject(opts.roadmapPath, opts.projectDir)) {
    return { ok: false, reason: "path_outside_project" };
  }
  if (!opts.isGitWorkTree) {
    return { ok: false, reason: "not_git_worktree" };
  }
  if (opts.operationInProgress) {
    return { ok: false, reason: "git_operation_in_progress" };
  }
  if (!opts.isTracked) {
    return { ok: false, reason: "not_tracked" };
  }
  if (opts.preDirty) {
    return { ok: false, reason: "pre_dirty" };
  }
  return { ok: true };
}
function isInsideGitWorkTree(projectDir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", projectDir, "rev-parse", "--is-inside-work-tree"],
      { timeout: 5e3, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf-8" }
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}
function resolveGitDir(projectDir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", projectDir, "rev-parse", "--git-dir"],
      { timeout: 5e3, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf-8" }
    ).trim();
    if (!out) return null;
    return path2.isAbsolute(out) ? out : path2.resolve(projectDir, out);
  } catch {
    return null;
  }
}
function isGitOperationInProgress(gitDir) {
  if (!gitDir) return true;
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];
  for (const marker of markers) {
    if (fs2.existsSync(path2.join(gitDir, marker))) return true;
  }
  return fs2.existsSync(path2.join(gitDir, "rebase-merge")) || fs2.existsSync(path2.join(gitDir, "rebase-apply"));
}
function isRoadmapTracked(projectDir, relPath) {
  try {
    execFileSync(
      "git",
      ["-C", projectDir, "ls-files", "--error-unmatch", "--", relPath],
      { timeout: 5e3, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf-8" }
    );
    return true;
  } catch {
    return false;
  }
}
function isRoadmapPreDirty(projectDir, relPath) {
  try {
    const out = execFileSync(
      "git",
      ["-C", projectDir, "status", "--porcelain", "--", relPath],
      { timeout: 5e3, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf-8" }
    );
    return out.trim().length > 0;
  } catch {
    return true;
  }
}
function collectAutoCommitGitFacts(projectDir, relRoadmapPath, preDirty) {
  const isGitWorkTree = isInsideGitWorkTree(projectDir);
  const gitDir = isGitWorkTree ? resolveGitDir(projectDir) : null;
  return {
    isGitWorkTree,
    operationInProgress: isGitWorkTree ? isGitOperationInProgress(gitDir) : true,
    isTracked: isGitWorkTree ? isRoadmapTracked(projectDir, relRoadmapPath) : false,
    preDirty
  };
}
function buildAutoCommitMessage(commit) {
  const typeLabel = commit.type !== "other" ? commit.type : "";
  const scopeLabel = commit.scope ? `(${commit.scope})` : "";
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` : typeLabel ? `${typeLabel}: ` : scopeLabel ? `${scopeLabel} ` : "";
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : "";
  return `chore(roadmap): record ${prefix}${commit.description}${hashLabel}`;
}
function attemptRoadmapAutoCommit(projectDir, commit) {
  const message = buildAutoCommitMessage(commit);
  try {
    const stdout = execFileSync(
      "git",
      ["-C", projectDir, "commit", "--only", "-m", message, "--", "ROADMAP.md"],
      { cwd: projectDir, timeout: 2e4, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf-8" }
    );
    const match = stdout.match(COMMIT_PATTERNS.commitOutput);
    return { committed: true, commitHash: match ? match[2] : null };
  } catch (err) {
    const anyErr = err;
    const stderrText = anyErr.stderr ? Buffer.isBuffer(anyErr.stderr) ? anyErr.stderr.toString("utf-8") : String(anyErr.stderr) : anyErr.message ?? String(err);
    const isTimeout = Boolean(anyErr.killed);
    const reasonTag = isTimeout ? "commit_timeout" : "commit_failed";
    const clipped = stderrText.slice(0, 500).replace(/\s+/g, " ").trim();
    return { committed: false, commitHash: null, failureReason: `${reasonTag}: ${clipped}` };
  }
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
  if (!COMMAND_TOOLS.has(data.tool_name)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const command = data.tool_input?.command || "";
  if (!isGitCommitCommand(command)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let response;
  if (typeof data.tool_response === "string") {
    response = data.tool_response;
  } else if (data.tool_response && typeof data.tool_response.output === "string") {
    response = data.tool_response.output;
  } else if (data.tool_response && typeof data.tool_response.stdout === "string") {
    response = data.tool_response.stdout;
  } else {
    response = JSON.stringify(data.tool_response || "");
  }
  if (!isSuccessfulCommit(response)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const commit = parseCommitFromOutput(response);
  if (!commit) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (commit.isAmend) {
    console.error("\u2139 Skipping amend commit (no duplicate entries)");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (commit.isMerge) {
    console.error("\u2139 Skipping merge commit");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (SKIP_TYPES.has(commit.type)) {
    console.error(`\u2139 Skipping ${commit.type} commit`);
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!commitRanInProject(command, projectDir)) {
    console.error("\u2139 Skipping commit that ran outside this project directory");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const content = fs2.readFileSync(roadmapPath, "utf-8");
  if (isDuplicateEntry(content, commit)) {
    console.error("\u2139 Skipping duplicate entry");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const relRoadmapPath = path2.relative(projectDir, roadmapPath) || "ROADMAP.md";
  const preDirty = isRoadmapPreDirty(projectDir, relRoadmapPath);
  const today = localDateStamp();
  const entry = formatCommitEntry(commit, today);
  const updated = appendToCompleted(content, entry);
  const beforeLineCount = content.split("\n").length;
  const afterLineCount = updated.split("\n").length;
  const guardResult = writeRoadmapGuarded({
    hook: "git-commit-roadmap",
    tool: data.tool_name,
    roadmapPath,
    projectDir,
    before: content,
    after: updated,
    ops: [
      {
        label: "completed-append",
        lines_removed: 0,
        lines_added: Math.max(0, afterLineCount - beforeLineCount)
      }
    ],
    sessionId: data.session_id
  });
  if (guardResult.outcome !== "written") {
    const reasonSuffix = guardResult.record.reason ? `: ${guardResult.record.reason}` : "";
    console.error(`\u2139 ROADMAP.md write skipped (${guardResult.outcome}${reasonSuffix})`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `\u26A0\uFE0F ROADMAP.md entry NOT recorded (${guardResult.outcome}${reasonSuffix}). Commit was left untouched.`
      }
    }));
    return;
  }
  const typeDesc = commit.type !== "other" ? `${commit.type}: ` : "";
  const scopeDesc = commit.scope ? `(${commit.scope}) ` : "";
  console.error(`\u2713 ROADMAP.md: ${typeDesc}${scopeDesc}${commit.description}`);
  const gitFacts = collectAutoCommitGitFacts(projectDir, relRoadmapPath, preDirty);
  const decision = shouldAutoCommitRoadmap({
    roadmapPath,
    projectDir,
    isGitWorkTree: gitFacts.isGitWorkTree,
    operationInProgress: gitFacts.operationInProgress,
    isTracked: gitFacts.isTracked,
    preDirty: gitFacts.preDirty
  });
  if (!decision.ok) {
    appendRoadmapAuditRecord(projectDir, {
      ...guardResult.record,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      committed: false,
      reason: decision.reason
    });
  } else {
    const autoCommit = attemptRoadmapAutoCommit(projectDir, commit);
    appendRoadmapAuditRecord(projectDir, {
      ...guardResult.record,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      committed: autoCommit.committed,
      commit_hash: autoCommit.commitHash,
      reason: autoCommit.failureReason
    });
    if (!autoCommit.committed) {
      console.error(`\u2139 ROADMAP.md auto-commit skipped: ${autoCommit.failureReason}`);
    }
  }
  const output = {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `\u{1F4CB} ROADMAP updated: ${commit.description}` }
  };
  console.log(JSON.stringify(output));
}
main().catch((err) => {
  console.error("[git-commit-roadmap] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  formatCommitEntry,
  shouldAutoCommitRoadmap
};
