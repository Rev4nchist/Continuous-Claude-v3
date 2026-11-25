#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, ".claude", "logs", "guard-decisions.jsonl");
}
function maskSecrets(text) {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
function commandHead(command) {
  return maskSecrets(command).replace(/\s+/g, " ").trim().slice(0, COMMAND_HEAD_CHARS);
}
function shouldWrite(env) {
  return !!env.CCV3_GUARD_DECISIONS_LOG || !Object.hasOwn(env, "VITEST");
}
function guardSource(env) {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === "test" || named === "probe") return named;
  if (Object.hasOwn(env, "VITEST")) return "test";
  return env.CCV3_GUARD_DECISIONS_LOG ? "probe" : "live";
}
function pathText(value, max = PATH_CHARS) {
  return typeof value === "string" && value ? value.slice(0, max) : void 0;
}
function maskedPath(value, max = PATH_CHARS) {
  if (typeof value !== "string" || !value) return void 0;
  const kept = [];
  const shielded = value.replace(UUID_SEGMENT, (_m, sep2, uuid) => {
    kept.push(uuid);
    return `${sep2}${MARK_OPEN}${kept.length - 1}${MARK_CLOSE}`;
  });
  const masked = PATH_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), shielded);
  return masked.replace(UUID_MARK, (m, i) => kept[Number(i)] ?? m).slice(0, max);
}
function targetOf(input, tool) {
  const explicit = maskedPath(input?.target);
  if (explicit) return explicit;
  const field = Object.hasOwn(TARGET_FIELD, tool) ? TARGET_FIELD[tool] : void 0;
  const toolInput = input?.tool_input;
  if (!field || typeof toolInput !== "object" || toolInput === null) return void 0;
  const raw = toolInput[field];
  return field === "file_path" ? maskedPath(raw) : pathText(raw);
}
function logGuardDecision(hook, input, decision, reason, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || void 0;
    const tool = input?.tool_name || input?.tool || "";
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      hook,
      tool,
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || "",
      agent: !!agent,
      source: guardSource(env)
    };
    if (agent) entry.agent_id = agent;
    const cwd = maskedPath(input?.cwd);
    if (cwd) entry.cwd = cwd;
    const mode = pathText(input?.permission_mode, 40);
    if (mode) entry.permission_mode = mode;
    const target = targetOf(input, tool);
    if (target) entry.target = target;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path4 = guardLogPath(env);
    mkdirSync(dirname(path4), { recursive: true, mode: 448 });
    appendFileSync(path4, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}
function oneLine(text) {
  return maskSecrets(text).replace(/\s+/g, " ").trim().slice(0, ERROR_FIELD_CHARS);
}
function errorMessage(err) {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : safeJson(err);
  return oneLine(String(raw).split(/\r?\n/)[0]);
}
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function firstFrame(err) {
  const stack = err instanceof Error ? err.stack : void 0;
  const frame = typeof stack === "string" ? stack.split(/\r?\n/).find((l) => /^\s*at\s/.test(l)) : void 0;
  return frame ? oneLine(frame) : "";
}
function logGuardError(hook, err, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    if (!shouldWrite(env)) return;
    const entry = { ts: (/* @__PURE__ */ new Date()).toISOString(), hook, kind: "error", message: errorMessage(err), stack: firstFrame(err), source: guardSource(env) };
    const path4 = guardLogPath(env);
    mkdirSync(dirname(path4), { recursive: true, mode: 448 });
    appendFileSync(path4, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}
var COMMAND_HEAD_CHARS, REASON_CHARS, PATH_CHARS, TARGET_FIELD, SECRET_NAME, MASKS, UUID_SEGMENT, MARK_OPEN, MARK_CLOSE, UUID_MARK, PATH_MASKS, ERROR_FIELD_CHARS;
var init_guard_log = __esm({
  "src/shared/guard-log.ts"() {
    "use strict";
    init_trace_boot();
    COMMAND_HEAD_CHARS = 80;
    REASON_CHARS = 200;
    PATH_CHARS = 300;
    TARGET_FIELD = {
      Read: "file_path",
      Edit: "file_path",
      Write: "file_path",
      Agent: "subagent_type",
      Task: "subagent_type",
      Skill: "skill"
    };
    SECRET_NAME = "[\\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*";
    MASKS = [
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
    UUID_SEGMENT = /(^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/.])/gi;
    MARK_OPEN = String.fromCharCode(57344);
    MARK_CLOSE = String.fromCharCode(57345);
    UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
    PATH_MASKS = [
      ...MASKS.slice(0, -1),
      [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
    ];
    ERROR_FIELD_CHARS = 200;
  }
});

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir as homedir2 } from "os";
import { basename, join as join2, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";
function traceModeFrom(env, modeText) {
  if (env.CCV3_HOOK_TRACE === "0") return "off";
  const t = (modeText ?? "").trim().toLowerCase();
  return t === "off" || t === "all" ? t : "hot";
}
function readTraceMode(env, read = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join2(homedir2(), ".claude", "state", "hook-trace-mode"));
  } catch {
  }
  return traceModeFrom(env, text);
}
function shouldTrace(name, mode) {
  return mode === "all" || mode === "hot" && HOT_PROGRAMS.includes(name);
}
function underLiveDist(script, home) {
  if (!script) return false;
  try {
    return caseKey(realPath(script)).startsWith(caseKey(realPath(join2(home, ".claude", "hooks", "dist"))) + sep);
  } catch {
    return false;
  }
}
function traceSource(env, script = process.argv[1], home = homedir2()) {
  const g = guardSource(env);
  if (g !== "live") return g;
  if (env.CCV3_HOOK_TRACE_DIR) return "probe";
  return underLiveDist(script, home) ? "live" : "probe";
}
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
function pruneOld(dir, day, days) {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(f);
    if (m && m[1] < cutoff) {
      try {
        fs.unlinkSync(join2(dir, f));
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
    const file = join2(dir, `hook-trace-${day}.jsonl`);
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
      bumpDropped(join2(dir, `hook-trace-${day}.dropped`));
      return "dropped";
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}
`);
    return "written";
  } catch {
    return "error";
  }
}
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
var TRACE_MARKER, HOT_PROGRAMS, DAY_CAP_BYTES, PRUNE_DAYS, STDIN_KEEP, STDOUT_KEEP, ERROR_MAX, realPath, caseKey, traceDir, SESSION_ID, EVENT_NAME, TOOL_NAME, pick, ERROR_WORD, ERROR_CODE, round1, DAY_FILE, keep;
var init_trace_boot = __esm({
  "src/lib/trace-boot.ts"() {
    "use strict";
    init_guard_log();
    TRACE_MARKER = "__CCV3_HOOK_TRACE_V1__";
    HOT_PROGRAMS = [
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
    DAY_CAP_BYTES = 32 * 1024 * 1024;
    PRUNE_DAYS = 10;
    STDIN_KEEP = 64 * 1024;
    STDOUT_KEEP = 8 * 1024;
    ERROR_MAX = 120;
    realPath = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return resolve(p);
      }
    };
    caseKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join2(homedir2(), ".claude", "cache");
    SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
    EVENT_NAME = /^[A-Za-z]{1,40}$/;
    TOOL_NAME = /^[\w.:-]{1,100}$/;
    pick = (v, re) => typeof v === "string" && re.test(v) ? v : null;
    ERROR_WORD = /^[A-Za-z0-9_.]{1,40}$/;
    ERROR_CODE = /^[A-Za-z0-9_]{1,40}$/;
    round1 = (n) => Math.round(n * 10) / 10;
    DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.(?:jsonl|dropped)$/;
    keep = (cur, chunk, max) => {
      if (cur.length >= max) return cur;
      const s = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
      return cur + s.slice(0, max - cur.length);
    };
    if (!Object.hasOwn(process.env, "VITEST")) bootTrace(process.env, "__CCV3_HOOK_TRACE_BOOT_V1__");
  }
});

// src/decision-gate.ts
init_trace_boot();
import { spawnSync } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync6 } from "fs";
import { homedir as homedir5 } from "os";
import { isAbsolute as isAbsolute2, join as join7, posix as posix2, resolve as resolve3 } from "path";

// src/pr-opened-review-loop.ts
init_trace_boot();
import { existsSync, mkdirSync as mkdirSync2, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join as join4 } from "path";
import { homedir as homedir3, tmpdir } from "os";

// src/shared/router-config.ts
init_trace_boot();
import { dirname as dirname2, join as join3 } from "path";
var CONFIG_REL = "review-router.config.json";
function routerConfigText(cwd, readFile, home) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const text = readFile(join3(dir, CONFIG_REL));
    if (text !== null) return text;
    const up = dirname2(dir);
    if (up === dir) break;
    dir = up;
  }
  return readFile(join3(home, "continuous-claude", CONFIG_REL));
}
function routerFlag(cwd, readFile, home, section, key) {
  const text = routerConfigText(cwd, readFile, home);
  if (text === null) return false;
  try {
    const cfg = JSON.parse(text);
    return cfg?.[section]?.[key] === true;
  } catch {
    return false;
  }
}

// src/shared/gh-open-prefix.ts
init_trace_boot();
var GH_OPT_PREFIX = String.raw`(?:[^\S\r\n]+[\w.\/:=@-]+){1,6}?`;

// src/pr-opened-review-loop.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PR_CREATE_RE = new RegExp(String.raw`\bgh(?:\s+|${GH_OPT_PREFIX}[^\S\r\n]+)pr\s+(?:create|new)\b`, "i");
var GH_API_RE = /\bgh\s+api\b/i;
var PULLS_PATH_RE = /\/pulls\/?(?=[\s"'?]|$)/i;
var POST_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))POST\b/i;
var ANY_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))\w/i;
var FIELD_FLAG_RE = /(?:^|\s)(?:-[fF]\s*["']?[\w.[\]-]+=|--(?:raw-field|field|input)[\s=])/;
var GH_API_SEGMENT_RE = /\bgh\s+api\b[^|;&\n]*/i;
var DATA_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)+`;
var DATA_FLAG_RE = new RegExp(String.raw`(^|\s)(-[fFHqt]\s*|--(?:raw-field|field|header|jq|template|input)(?:\s+|=))${DATA_VALUE}`, "g");
var PR_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;
function joinContinuations(command, shell) {
  const text = command || "";
  return shell === "bash" ? text.replace(/\\\r?\n/g, "") : text.replace(/[ \t]*`\r?\n[ \t]*/g, " ");
}
function normalizeGh(command) {
  return (command || "").replace(/(["'])gh(?:\.exe)?\1(?=\s)|\bgh\.exe(?=\s)/gi, "gh");
}
var squashQuotes = (text) => text.replace(/["'\\]/g, "");
function isPrOpenCommand(command) {
  const text = normalizeGh(command);
  return isPrOpenText(joinContinuations(text, "bash")) || isPrOpenText(joinContinuations(text, "pwsh"));
}
function isPrOpenText(cmd) {
  if (PR_CREATE_RE.test(cmd) || PR_CREATE_RE.test(squashQuotes(cmd))) return true;
  if (!GH_API_RE.test(cmd)) return false;
  const api = cmd.match(GH_API_SEGMENT_RE)?.[0] ?? "";
  const bare = api.replace(DATA_FLAG_RE, "$1$2");
  if (!PULLS_PATH_RE.test(bare)) return false;
  if (POST_METHOD_RE.test(bare)) return true;
  return FIELD_FLAG_RE.test(api) && !ANY_METHOD_RE.test(bare);
}
function responseText(resp) {
  if (resp === null || resp === void 0) return "";
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const o = resp;
    const parts = [o.output, o.stdout, o.stderr, o.content].filter(
      (v) => typeof v === "string"
    );
    if (parts.length) return parts.join("\n");
  }
  try {
    return JSON.stringify(resp ?? "");
  } catch {
    return "";
  }
}
function extractPrInfo(responseTxt) {
  const urlMatch = responseTxt.match(PR_URL_RE);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3], url: urlMatch[0] };
  }
  return null;
}
function safeSession(sessionId) {
  return (sessionId || "no-session").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function statePath(sessionId) {
  return join4(tmpdir(), `pr-opened-review-loop-${safeSession(sessionId)}.json`);
}
function legacyStatePath(sessionId) {
  return join4(tmpdir(), `pr-opened-coderabbit-loop-${safeSession(sessionId)}.json`);
}
function readSeen(p) {
  try {
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function alreadyFired(sessionId, url) {
  return readSeen(statePath(sessionId)).includes(url) || readSeen(legacyStatePath(sessionId)).includes(url);
}
function markFired(sessionId, url) {
  try {
    const legacy = legacyStatePath(sessionId);
    const seen = [.../* @__PURE__ */ new Set([...readSeen(statePath(sessionId)), ...readSeen(legacy), url])];
    mkdirSync2(tmpdir(), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(seen), "utf8");
    if (existsSync(legacy)) unlinkSync(legacy);
  } catch {
  }
}
var WATCH_REPO = "rev4nchist/continuous-claude-v3";
var loopText = (info) => `/loop 5m Check the PR review bots that must review the head (in CCv3, the bots \`node scripts/github/review-status.mjs ${info.number}\` requires; elsewhere, the repo's configured bots) on ${info.owner}/${info.repo} PR #${info.number} (stop when reviews of the head land or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;
function checkpointText(info, ledger) {
  const call = `the pr_checkpoint tool with pr: ${info.number} and body: the path of the PR body file that pre-pr.mjs --body checked (mcp__ccv3-mods__pr_checkpoint)`;
  const never = "Never mark it ready or add a review: label yourself; the checkpoint does both. ";
  if (ledger) {
    return `Either way, also call ${call}. If it returns a question, ask Dave that question with AskUserQuestion, word for word, then call pr_checkpoint again with the same pr and body. Only his tap records a pick. An answer that matches no option records nothing, and the PR stays a draft. ` + never;
  }
  return `Either way, also call ${call}. Without that call /pathway has no checkpoint to record, and the PR stays a draft. ` + never;
}
function buildContext(info, ledger = false) {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. ` + checkpointText(info, ledger) + `This applies to every PR in every session.`;
  }
  return head + `START THE REVIEW LOOP NOW, in this same turn: ${loopText(info)}. This applies to every PR in every session.`;
}
function ledgerOn(cwd) {
  const readFile = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return routerFlag(cwd || process.cwd(), readFile, homedir3(), "checkpoint", "ledger");
}
function main() {
  const raw = readFileSync(0, "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool_name || "";
  if (!COMMAND_TOOLS.has(tool)) {
    console.log("{}");
    return;
  }
  const command = input.tool_input?.command || "";
  if (!isPrOpenCommand(command)) {
    console.log("{}");
    return;
  }
  const text = responseText(input.tool_response);
  const info = extractPrInfo(text);
  if (!info) {
    console.log("{}");
    return;
  }
  const sessionId = input.session_id || "";
  if (alreadyFired(sessionId, info.url)) {
    console.log("{}");
    return;
  }
  markFired(sessionId, info.url);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: buildContext(info, ledgerOn(input.cwd || ""))
      }
    })
  );
}
if ((process.argv[1] || "").includes("pr-opened-review-loop")) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}

// src/shared/checkpoint-shapes.ts
init_trace_boot();
var WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
var ADD_LABEL = new RegExp(String.raw`(?:^|\s)--add-label(?:=|\s+)(${WORD})`, "g");
var CREATE_LABEL = new RegExp(String.raw`(?:^|\s)(?:--label(?:=|\s+)|-l\s*)(${WORD})`, "g");
var ISSUE_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/[^\s/"'?]+/gi;
function hasCcv3Endpoint(raw) {
  if (!/\bgh\s+api\b/i.test(raw)) return false;
  return [...raw.matchAll(ISSUE_ENDPOINT)].some((m) => m[1].toLowerCase() === "rev4nchist/continuous-claude-v3");
}
var NONLITERAL_REPO = new RegExp(
  String.raw`(?:^|\s)(?:-R\s*=?|--repo(?:\s+|=))["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)` + String.raw`|(?:^|[\s;])(?:\$env:)?GH_REPO\s*=\s*["']?[^\s"';]*(?:\$|\x60|%[A-Za-z_]\w*%)`,
  "i"
);
var hasNonLiteralRepo = (raw) => NONLITERAL_REPO.test(raw);
var CCV3_REPO = "rev4nchist/continuous-claude-v3";
var REPO_VALUE = "((?:https?:\\/\\/)?[\\w.-]+(?:\\/[\\w.-]+){1,2})";
var REPO_FLAG = new RegExp(`(?:^|\\s)(?:-R\\s*=?|--repo(?:\\s+|=))["']?${REPO_VALUE}`, "g");
var GH_REPO_ASSIGN = new RegExp(`(?:^|[\\s;])(?:\\$env:)?GH_REPO\\s*=\\s*["']?${REPO_VALUE}`, "gi");
var PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+/gi;
var ownerRepo = (value) => value.replace(/^https?:\/\//i, "").split("/").slice(-2).join("/").replace(/\.git$/i, "").toLowerCase();
var API_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/gi;
function namedRepo(command, env = {}) {
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE}$`).exec(env.GH_REPO.trim())?.[1];
  const values = [...command.matchAll(REPO_FLAG), ...command.matchAll(GH_REPO_ASSIGN)].map((m) => m[1]);
  const explicits = [...values, ...envRepo ? [envRepo] : []].map(ownerRepo);
  const endpoints = [...command.matchAll(API_ENDPOINT)].map((m) => m[1].toLowerCase());
  const urls = [...command.matchAll(PR_URL)].map((m) => m[1].toLowerCase());
  const ccv3 = explicits.includes(CCV3_REPO) || endpoints.includes(CCV3_REPO) || urls.includes(CCV3_REPO) || hasCcv3Endpoint(command);
  return ccv3 ? CCV3_REPO : null;
}
var ANY_REPOS_PATH = /(?:^|[\s"'=]|api\.github\.com)\/?repos\/([\w.-]+\/[\w.-]+)(?=[/\s"'?#]|$)/gi;
var GH_SUB = /\bgh\s+(\S+)(?:\s+(\S+))?/i;
var QUOTED_WORD = /^(["'])[^\s"']+\1$/;
function argAt(seg, mseg, at2) {
  if (mseg[at2] === seg[at2]) return true;
  const from = seg.slice(0, at2).search(/\S*$/);
  const end = seg.slice(at2).search(/\s|$/);
  return QUOTED_WORD.test(seg.slice(from, at2 + end));
}
function flagValues(re, seg, mseg, after) {
  return [...seg.matchAll(re)].filter((m) => {
    const at2 = m.index + m[0].search(/\S/);
    return at2 >= after && mseg[at2] === seg[at2];
  }).map((m) => m[1]);
}
function pathRepos(seg, mseg) {
  const sub = GH_SUB.exec(squashQuotes(seg));
  const verb = sub?.[1].toLowerCase();
  const re = verb === "api" ? ANY_REPOS_PATH : verb === "pr" && /^(?:merge|view|ready)$/i.test(sub?.[2] ?? "") ? PR_URL : null;
  if (re === null) return [];
  return [...seg.matchAll(re)].filter((m) => argAt(seg, mseg, m.index + m[0].length - m[1].length)).map((m) => ownerRepo(m[1]));
}
function commandRepo(text, mtext, env = {}, prior = []) {
  const cut = mtext.replace(/>&|&>/g, "  ").search(/[;&|\r\n]/);
  const seg = cut < 0 ? text : text.slice(0, cut);
  const mseg = cut < 0 ? mtext : mtext.slice(0, cut);
  const gh = /\bgh\s/i.exec(mseg);
  if (gh === null) return null;
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE}$`).exec(env.GH_REPO.trim())?.[1];
  const cluster = new RegExp(`(?:^|\\s)-[A-Za-z]+R\\s*=?["']?${REPO_VALUE}`, "g");
  const values = [...flagValues(REPO_FLAG, seg, mseg, gh.index), ...flagValues(cluster, seg, mseg, gh.index), ...flagValues(GH_REPO_ASSIGN, seg, mseg, 0)];
  const explicits = [...values, ...envRepo ? [envRepo] : []].map(ownerRepo);
  const slugs = [.../* @__PURE__ */ new Set([...explicits, ...prior, ...pathRepos(seg, mseg)])].sort();
  return slugs.length === 0 ? null : slugs.join(" ");
}
var GH_REPO_ANY = /(?:^|[\s;&|(])(?:\$env:)?GH_REPO\s*=\s*["']?([^\s"';&|)]*)/gi;
function priorGhRepo(text, mtext) {
  const REPO_ONLY = new RegExp(`^${REPO_VALUE}$`);
  const repos = [];
  let nonLiteral = false;
  for (const m of text.matchAll(GH_REPO_ANY)) {
    const at2 = m.index + m[0].search(/\S/);
    if (mtext[at2] !== text[at2]) continue;
    if (REPO_ONLY.test(m[1])) repos.push(ownerRepo(m[1]));
    else if (/[$`%]/.test(m[1])) nonLiteral = true;
  }
  return { repos: [...new Set(repos)], nonLiteral };
}

// src/shared/answer-paths-door.ts
init_trace_boot();

// ../../scripts/github/lib/answer-key.mjs
init_trace_boot();
var ANSWER_KEY_GLOBS = Object.freeze([
  "scripts/eval/review-eval/gold/**",
  "scripts/eval/review-eval/seeds/**",
  "scripts/eval/review-eval/rubrics/**",
  "scripts/eval/review-eval/linktype-labels.json"
]);
var slashLower = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
function matches(glob, p) {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -2);
    return p.length > prefix.length && p.startsWith(prefix);
  }
  return glob === p;
}
function answerKeyHitsOf(paths, globs = ANSWER_KEY_GLOBS) {
  const list = globs.map(slashLower);
  return paths.filter((p) => {
    const n = slashLower(p);
    return list.some((g) => matches(g, n));
  });
}

// src/shared/answer-paths-door.ts
var answerKeyHitsOf2 = answerKeyHitsOf;

// src/shared/decisions-store.ts
init_trace_boot();
import { readFileSync as readFileSync3 } from "fs";

// ../../scripts/github/lib/decisions.mjs
init_trace_boot();
import { appendFileSync as appendFileSync2, closeSync, existsSync as existsSync2, mkdirSync as mkdirSync3, openSync, readFileSync as readFileSync2, readSync, readdirSync, renameSync, statSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import os from "node:os";
import path from "node:path";

// ../../scripts/github/lib/file-lock.mjs
init_trace_boot();

// ../../scripts/github/lib/decisions.mjs
var DECISIONS_ENV = "CCV3_DECISIONS_FILE";
var STEPS = Object.freeze(["ship", "open-pr", "review", "land", "paid-round", "cli-skip"]);
var REPO = "Rev4nchist/Continuous-Claude-v3";
var MAX_AGE_MS = 7 * 24 * 3600 * 1e3;
var MISS_TTL_MS = 60 * 60 * 1e3;
var accountHome = () => {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
};
var decisionsPath = (env = process.env) => env[DECISIONS_ENV] || path.join(accountHome(), ".claude", "state", "ccv3-mods", "decisions.json");
var decisionKey = ({ repo = REPO, pr, branch }) => pr !== void 0 && pr !== null ? `${repo}#${pr}` : `${repo}@${branch}`;
var LOG_MAX_BYTES = 5 * 1024 * 1024;
var empty = () => ({ version: 1, offers: {}, decisions: {}, misses: {} });
var idOf = ({ step, key, head }) => `${step}
${key}
${String(head).toLowerCase()}`;
var isText = (v) => typeof v === "string" && v !== "";
var isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function readStore(file) {
  try {
    const s = JSON.parse(readFileSync2(file, "utf8"));
    if (!isPlain(s)) return empty();
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? store : empty();
  } catch {
    return empty();
  }
}
function decisionRead({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return null;
  const d = readStore(decisionsPath()).decisions[idOf({ step, key, head })];
  return d && typeof d.label === "string" ? { label: d.label, at: d.at } : null;
}

// src/shared/decisions-store.ts
var decisionRead2 = decisionRead;
var decisionKey2 = decisionKey;
var decisionsPath2 = decisionsPath;
function decisionRows(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync3(decisionsPath2(env), "utf8"));
    const plain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!plain(parsed) || ["offers", "decisions", "misses"].some((k) => !plain(parsed[k]))) return [];
    return Object.entries(parsed?.decisions ?? {}).flatMap(([id, d]) => {
      const [step, key, head] = id.split("\n");
      const tree = typeof d?.tree === "string" && d.tree !== "" ? d.tree : null;
      return head !== void 0 && typeof d?.label === "string" ? [{ step, key, head, label: d.label, tree }] : [];
    });
  } catch {
    return [];
  }
}

// src/shared/holdout-ids.ts
init_trace_boot();
import { readFileSync as readFileSync4 } from "fs";
import { join as join5 } from "path";

// ../../scripts/github/lib/holdout-ids.mjs
init_trace_boot();
function holdoutIdsOf(ds, cfg) {
  const reserved = new Set((cfg?.reserve ?? []).map((r) => r?.pr));
  const excluded = new Set(cfg?.holdoutExclude ?? []);
  const inHoldout = (pr) => !reserved.has(pr) && !excluded.has(pr);
  const out3 = /* @__PURE__ */ new Set();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out3.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out3.add(String(f.pr));
    if (f.comment_id !== void 0 && f.comment_id !== null) {
      out3.add(String(f.comment_id));
      out3.add(`${f.pr}:${f.comment_id}`);
    }
    if (typeof f.round === "string" && /^[0-9a-f]{7,40}$/i.test(f.round)) out3.add(f.round.toLowerCase());
  }
  out3.delete("undefined");
  out3.delete("null");
  return [...out3];
}
var CONTEXT = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;
function countIdsIn(text, ids) {
  const s = String(text ?? "");
  let runs = null;
  let low = null;
  let n = 0;
  for (const id of ids) {
    if (typeof id !== "string" || id === "") continue;
    if (isSha(id)) {
      runs ??= hexRuns(s);
      const want = id.toLowerCase();
      if (runs.some((r) => r.length > 40 ? r.includes(want) : want.startsWith(r) || r.startsWith(want))) n += 1;
    } else if (/^\d+$/.test(id)) {
      if (digitHit(s, id)) n += 1;
    } else if (tokenHit(low ??= s.toLowerCase(), id)) n += 1;
  }
  return n;
}
var isSha = (id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id);
function hexRuns(s) {
  return [...s.matchAll(/(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi)].map((m) => m[0].toLowerCase());
}
function checkHoldoutShape(ds, cfg) {
  const bad = () => {
    throw new Error("the holdout dataset or its config has the wrong shape");
  };
  const posInt = (v) => Number.isInteger(v) && v > 0;
  if (ds === null || typeof ds !== "object" || Array.isArray(ds)) bad();
  if (!Array.isArray(ds.prs) || ds.prs.length === 0 || !Array.isArray(ds.findings) || ds.findings.length === 0) bad();
  if (!ds.prs.every((p) => p !== null && typeof p === "object" && posInt(p.pr))) bad();
  if (!ds.findings.every((f) => f !== null && typeof f === "object" && posInt(f.pr))) bad();
  const absent = (v) => v === void 0 || v === null;
  if (!ds.findings.every((f) => absent(f.comment_id) || posInt(f.comment_id) || typeof f.comment_id === "string" && f.comment_id !== "")) bad();
  if (!ds.findings.every((f) => absent(f.round) || typeof f.round === "string" || Number.isInteger(f.round))) bad();
  if (!ds.findings.some((f) => posInt(f.comment_id) || typeof f.comment_id === "string" && /^\d+$/.test(f.comment_id))) bad();
  if (cfg !== null && cfg !== void 0 && (typeof cfg !== "object" || Array.isArray(cfg))) bad();
  for (const k of ["reserve", "holdoutExclude"]) if (cfg?.[k] !== void 0 && !Array.isArray(cfg[k])) bad();
}
function digitHit(s, id) {
  const long = id.length >= 7;
  let from = 0;
  for (; ; ) {
    const at2 = s.indexOf(id, from);
    if (at2 < 0) return false;
    from = at2 + 1;
    const before = s[at2 - 1];
    const after = s[at2 + id.length];
    if (before !== void 0 && /\d/.test(before) || after !== void 0 && /\d/.test(after)) continue;
    if (long || CONTEXT.test(s.slice(Math.max(0, at2 - 8), at2))) return true;
  }
}
function tokenHit(low, id) {
  const want = id.toLowerCase();
  const word = /[0-9a-f:]/;
  let from = 0;
  for (; ; ) {
    const at2 = low.indexOf(want, from);
    if (at2 < 0) return false;
    from = at2 + 1;
    const before = low[at2 - 1];
    const after = low[at2 + want.length];
    if (before !== void 0 && word.test(before) || after !== void 0 && word.test(after)) continue;
    return true;
  }
}

// src/shared/holdout-ids.ts
var DATASET_REL = ".claudedocs/2026-11-01-pr-review-dataset.json";
var EVAL_CONFIG_REL = "scripts/eval/review-eval/config.json";
var countIdsIn2 = countIdsIn;
function loadHoldoutIds(mainRoot) {
  let ids;
  try {
    const ds = JSON.parse(readFileSync4(join5(mainRoot, DATASET_REL), "utf8"));
    const cfg = JSON.parse(readFileSync4(join5(mainRoot, EVAL_CONFIG_REL), "utf8"));
    checkHoldoutShape(ds, cfg);
    ids = holdoutIdsOf(ds, cfg);
  } catch {
    throw new Error("the holdout id list could not be read");
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("the holdout id list is empty");
  return ids;
}

// src/shared/git-call.ts
init_trace_boot();
var VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
var globalOpt = (extra = "") => String.raw`(?:\s+(?:${extra}-C\s+${VAL}|-c\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VAL}|--no-pager|--no-replace-objects|--bare|-P))*`;
var GLOBAL_OPT = globalOpt();
var CALL_START = String.raw`(?:^\s*|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:&\s+)?(?:\w+=\S*\s+)*(?:(?:time|sudo|command|exec|nohup)\s+)*`;
var PATH_PREFIX = String.raw`(?:[^\s;&|()]*[\\/])?`;
var PWSH_PREFIX = String.raw`(?:(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*?\s+-File\s+)?`;
function gitCallRe(verb) {
  return new RegExp(String.raw`(${CALL_START})(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+${verb})(?=\s|$)`, "g");
}
function safeCallRe(verb, wrappers = "git-safe", extraOpts = "", flags = "g") {
  return new RegExp(String.raw`(${CALL_START})(${PWSH_PREFIX}(?:${PATH_PREFIX}(?:${wrappers})\.ps1|"\s*"|'\s*'))(${globalOpt(extraOpts)})(\s+${verb})(?=\s|$)`, flags);
}
var isGitToken = (raw) => /(?:^|[\\/"'])git(?:\.exe)?["']?$/i.test(raw);
var isSafeToken = (raw, wrappers = "git-safe") => new RegExp(`(?:${wrappers})\\.ps1`, "i").test(raw);

// src/decision-gate.ts
init_guard_log();

// src/shared/inert-quotes.ts
init_trace_boot();

// src/shared/mask-quotes.ts
init_trace_boot();
var BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING : BASH_STRING, blank);
}
function quotedSpans(command, tool = "Bash") {
  return [...command.matchAll(tool === "PowerShell" ? PWSH_STRING : BASH_STRING)].map((m) => [m.index, m.index + m[0].length]);
}

// src/shared/doc-heredoc.ts
init_trace_boot();
var PATH = String.raw`(?<path>[\w./\\:~-]+\.(?:md|txt))`;
var DELIM = String.raw`(?<dash>-?)(?<q>['"])(?<d>[A-Za-z_]\w*)\k<q>`;
var HEAD_FILE_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]+>>?[ \t]*${PATH}[ \t]*<<${DELIM}[ \t]*$`);
var HEAD_MARKER_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]*<<${DELIM}[ \t]*>>?[ \t]*${PATH}[ \t]*$`);
var ODD_BREAK = /[\r\0\v\f\x85\u2028\u2029]/;
function blankDocHeredocBody(command) {
  if (!command.includes("<<") || ODD_BREAK.test(command)) return command;
  const lines2 = command.split("\n");
  const head = HEAD_FILE_FIRST.exec(lines2[0]) ?? HEAD_MARKER_FIRST.exec(lines2[0]);
  if (!head || !head.groups) return command;
  const { dash, d } = head.groups;
  let close = -1;
  for (let i = 1; i < lines2.length; i++) {
    const line = dash ? lines2[i].replace(/^\t+/, "") : lines2[i];
    if (line === d) {
      close = i;
      break;
    }
  }
  if (close < 1) return command;
  if (lines2.slice(close + 1).some((l) => l.trim() !== "")) return command;
  return lines2.map((l, i) => i >= 1 && i < close ? " ".repeat(l.length) : l).join("\n");
}

// src/shared/inert-quotes.ts
var INERT_HEAD = new RegExp(
  String.raw`^\s*(?:echo|printf|Write-(?:Host|Output|Warning|Information)|git\s+commit|claude|ntn|curl|gh\s+(?:pr|issue)\s+comment` + String.raw`|node(?:\.exe)?\s+(?:\S*[\\/])?lane\.mjs\s+(?:add|note|say))(?=\s|$)`,
  "i"
);
var PLAIN_HEAD = /^\s*(?:cd|Set-Location|git\s+(?:add|status))(?=\s|$)/i;
var SEGMENT_BREAK = /[;&|\r\n]+/g;
var HARMLESS_REDIRECT = /\d*>&\d+|&>\s*\/dev\/null(?=[\s;&|]|$)|\d*>>?\s*(?:\/dev\/null|\$null|nul)(?=[\s;&|]|$)/gi;
var RUNS_TEXT = /\$\(|`|<<|@['"]/;
var SPECIAL_STRING = /\$['"]|[\u{2018}-\u{201F}\0\v\f\x85\u{2028}\u{2029}]/u;
var OUTSIDE_RISK = /[#(){}'"]/;
function headMatches(head, masked, raw) {
  return head.test(masked) && head.test(raw);
}
function plainSegments(command, tool) {
  if (RUNS_TEXT.test(command) || SPECIAL_STRING.test(command)) return null;
  const spans = quotedSpans(command, tool);
  if (spans.some(([s]) => s > 0 && command[s - 1] === "\\")) return null;
  const chars = command.split("");
  for (const [s, e] of spans) chars.fill(" ", s, e);
  const masked = chars.join("");
  if (OUTSIDE_RISK.test(masked)) return null;
  const cut = masked.replace(HARMLESS_REDIRECT, (r) => " ".repeat(r.length));
  const segs = [];
  let from = 0;
  const breaks = [...cut.matchAll(SEGMENT_BREAK)].map((m) => ({ at: m.index, len: m[0].length }));
  for (const end of [...breaks, { at: cut.length, len: 0 }]) {
    const seg = cut.slice(from, end.at);
    if (seg.trim() !== "") {
      if (seg.includes(">")) return null;
      segs.push({ from, end: end.at, masked: seg });
    }
    from = end.at + end.len;
  }
  return { spans, segs };
}
function inertSpans(command, tool, openHead) {
  const none = /* @__PURE__ */ new Set();
  const plain = plainSegments(command, tool);
  if (!plain) return none;
  const out3 = /* @__PURE__ */ new Set();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches(PLAIN_HEAD, masked, raw)) continue;
    if (openHead !== void 0 && headMatches(openHead, masked, raw)) continue;
    if (!headMatches(INERT_HEAD, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out3.add(`${s}:${e}`);
  }
  return out3;
}
var TEXT_HEAD = /^\s*(?:echo|printf|Write-(?:Host|Output))(?=\s|$)/i;
var READ_HEAD = /^\s*(?:grep|cat|head|tail|Select-String|sls|Get-Content|gc|git\s+log)(?=\s|$)/i;
var OPTION_TRAP = /(?:^|\s)--ou/i;
var DASH_LOOKALIKE = /[–—―]/;
function isTextOnlyCommand(command) {
  if (DASH_LOOKALIKE.test(command)) return false;
  for (const tool of ["Bash", "PowerShell"]) {
    const plain = plainSegments(command, tool);
    if (!plain) return false;
    for (const { from, end, masked } of plain.segs) {
      const raw = command.slice(from, end);
      if (!(headMatches(PLAIN_HEAD, masked, raw) || headMatches(TEXT_HEAD, masked, raw) || headMatches(READ_HEAD, masked, raw))) return false;
      if (OPTION_TRAP.test(raw.replace(/["'\\]/g, ""))) return false;
    }
  }
  return true;
}
var DOC_APPEND = /^\s*(?:Add-Content|Set-Content)\s+-(?:LiteralPath|Path)\s+(?:'([A-Za-z0-9_.\-/\\: ]+)'|([A-Za-z0-9_.\-/\\:]+))(?:\s+-Value)?\s+'([^']*)'\s*$/i;
var DOC_EXT = /\.(?:md|txt|log)$/i;
var DOC_RISK = /[`\u{2018}-\u{201F}\0\v\f\x85\u{2028}\u{2029}]|\$\(|@['"]/u;
function isDocAppend(segment) {
  if (DASH_LOOKALIKE.test(segment) || DOC_RISK.test(segment)) return false;
  const m = DOC_APPEND.exec(segment);
  if (m === null) return false;
  const target = m[1] ?? m[2];
  if (target !== target.trim() || !DOC_EXT.test(target)) return false;
  if (target.replace(/^[A-Za-z]:(?=[\\/])/, "").includes(":")) return false;
  return !target.split(/[\\/]/).includes("..");
}
function docAppendReadable(command, tool) {
  if (tool !== "PowerShell" || DASH_LOOKALIKE.test(command)) return false;
  return plainSegments(command, "Bash") !== null && plainSegments(command, "PowerShell") !== null;
}
function blankInertQuotes(command, tool) {
  if (tool !== void 0 && tool !== "Bash" && tool !== "PowerShell") return command;
  if (tool === "Bash") {
    const doc = blankDocHeredocBody(command);
    if (doc !== command) return doc;
  }
  return blankSpans(command, inertSpans(command, "Bash"), inertSpans(command, "PowerShell"));
}
function blankSpans(command, bash, pwsh) {
  let out3 = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(":").map(Number);
    out3 = out3.slice(0, s + 1) + " ".repeat(e - s - 2) + out3.slice(e - 1);
  }
  return out3;
}

// src/shared/shell-tools.ts
init_trace_boot();
var BOTH = ["Bash", "PowerShell"];
var SHELL_TOOLS = /* @__PURE__ */ new Map([
  ["Bash", { field: "command", dialects: ["Bash"], failClosed: false }],
  ["PowerShell", { field: "command", dialects: ["PowerShell"], failClosed: false }],
  ["mcp__plugin_desktop-commander_desktop-commander__start_process", { field: "command", dialects: BOTH, failClosed: true }],
  ["mcp__plugin_desktop-commander_desktop-commander__interact_with_process", { field: "input", dialects: BOTH, failClosed: true }]
]);
function readShellCommand(input) {
  const tool = input.tool_name || input.tool;
  const spec = tool ? SHELL_TOOLS.get(tool) : void 0;
  if (!tool || !spec) return { kind: "not-shell" };
  const toolInput = input.tool_input;
  const text = toolInput && typeof toolInput === "object" ? toolInput[spec.field] : void 0;
  if (typeof text !== "string") {
    return spec.failClosed ? { kind: "unreadable", tool, field: spec.field } : { kind: "command", tool, text: "", dialects: spec.dialects };
  }
  return { kind: "command", tool, text, dialects: spec.dialects };
}
function mayRunUnderCmd(tool) {
  return !!tool && tool.startsWith("mcp__plugin_desktop-commander_");
}

// src/shared/shell-ast.ts
init_trace_boot();
import fs3 from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// node_modules/sh-syntax/lib/index.js
init_trace_boot();
import fs2 from "node:fs/promises";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// node_modules/sh-syntax/lib/shim.js
init_trace_boot();
import { randomFillSync } from "node:crypto";
import _fs from "node:fs";
import { performance as performance2 } from "node:perf_hooks";
globalThis.fs ??= _fs;
globalThis.crypto ??= {
  // @ts-expect-error -- incompatible types
  getRandomValues: randomFillSync
};
globalThis.performance ??= performance2;

// node_modules/sh-syntax/lib/processor.js
init_trace_boot();

// node_modules/sh-syntax/lib/types.js
init_trace_boot();
var LangVariant = {
  /**
   * LangBash corresponds to the GNU Bash language, as described in its manual at
   * https://www.gnu.org/software/bash/manual/bash.html.
   *
   * We currently follow Bash version 5.2.
   *
   * Its string representation is "bash".
   *
   * Note: as of mvdan/sh v3.13, {@link LangVariant} values are bit flags (`1 << iota`) rather than
   * a sequential enum, so every value changed from the previous release.
   */
  LangBash: 1,
  /**
   * LangPOSIX corresponds to the POSIX Shell language, as described at
   * https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html.
   *
   * Its string representation is "posix" or "sh".
   */
  LangPOSIX: 1 << 1,
  /**
   * LangMirBSDKorn corresponds to the MirBSD Korn Shell, also known as mksh, as described at
   * https://www.mirbsd.org/htman/i386/man1/mksh.htm. Note that it shares some features with Bash,
   * due to the shared ancestry that is ksh.
   *
   * We currently follow mksh version 59.
   *
   * Its string representation is "mksh".
   */
  LangMirBSDKorn: 1 << 2,
  /**
   * LangBats corresponds to the Bash Automated Testing System language, as described at
   * https://github.com/bats-core/bats-core. Note that it's just a small extension of the Bash
   * language.
   *
   * Its string representation is "bats".
   */
  LangBats: 1 << 3,
  /**
   * LangZsh corresponds to the Z shell, as described at https://www.zsh.org/.
   *
   * Note that its support in mvdan/sh is experimental and incomplete for now; see
   * https://github.com/mvdan/sh/issues/120. We currently follow Zsh version 5.9. Added in mvdan/sh
   * v3.13.0.
   *
   * Its string representation is "zsh".
   */
  LangZsh: 1 << 4,
  /**
   * LangAuto corresponds to automatic language detection, commonly used by end-user applications
   * like shfmt, which can guess a file's language variant given its filename or shebang.
   *
   * At this time, [Variant] does not support LangAuto.
   */
  LangAuto: 1 << 5
};

// node_modules/sh-syntax/lib/processor.js
var ParseError = class extends Error {
  constructor({ filename, incomplete, text, pos }) {
    super(text);
    this.filename = filename;
    this.incomplete = incomplete;
    this.text = text;
    this.pos = pos;
  }
};
var supportedVariants = /* @__PURE__ */ new Set([
  LangVariant.LangBash,
  LangVariant.LangPOSIX,
  LangVariant.LangMirBSDKorn,
  LangVariant.LangBats,
  LangVariant.LangZsh
]);
var encoder;
var decoder;
var invoke = ({ memory, wasmAlloc, wasmFree, process: process2 }, textOrAst, { filepath = "", print = false, originalText, keepComments = true, variant = LangVariant.LangBash, stopAt = "", recoverErrors = 0, useTabs = false, tabWidth = 2, simplify = false, indent = useTabs ? 0 : tabWidth, binaryNextLine = true, switchCaseIndent = true, spaceRedirects = true, keepPadding = false, minify = false, singleLine = false, functionNextLine = false } = {}) => {
  encoder ??= new TextEncoder();
  decoder ??= new TextDecoder();
  if (!supportedVariants.has(variant)) {
    throw new TypeError(`Unsupported shell variant: ${variant}`);
  }
  let text;
  let printOutput;
  if (typeof textOrAst === "string") {
    text = textOrAst;
    printOutput = print;
  } else {
    if (originalText == null) {
      throw new TypeError("processor(ast) is not supported; pass { originalText } to format the source text");
    }
    text = originalText;
    printOutput = true;
  }
  const filePath = encoder.encode(filepath);
  const textBytes = encoder.encode(text);
  const stopAtBytes = encoder.encode(stopAt);
  const filePathPointer = wasmAlloc(filePath.byteLength);
  new Uint8Array(memory.buffer).set(filePath, filePathPointer);
  const textPointer = wasmAlloc(textBytes.byteLength);
  new Uint8Array(memory.buffer).set(textBytes, textPointer);
  const stopAtPointer = wasmAlloc(stopAtBytes.byteLength);
  new Uint8Array(memory.buffer).set(stopAtBytes, stopAtPointer);
  const resultPointer = process2(filePathPointer, filePath.byteLength, filePath.byteLength, textPointer, textBytes.byteLength, textBytes.byteLength, printOutput, keepComments, variant, stopAtPointer, stopAtBytes.byteLength, stopAtBytes.byteLength, recoverErrors, simplify, indent, binaryNextLine, switchCaseIndent, spaceRedirects, keepPadding, minify, singleLine, functionNextLine);
  wasmFree(filePathPointer);
  wasmFree(textPointer);
  wasmFree(stopAtPointer);
  const result = new Uint8Array(memory.buffer).subarray(resultPointer);
  const end = result.indexOf(0);
  const string = decoder.decode(result.subarray(0, end));
  if (!string.startsWith('{"') || !string.endsWith("}")) {
    throw new ParseError({
      filename: filepath,
      incomplete: true,
      text: string
    });
  }
  const { file, text: processedText, parseError, message } = JSON.parse(string);
  if (parseError) {
    throw new ParseError(parseError);
  }
  if (message) {
    throw new SyntaxError(message);
  }
  return printOutput ? processedText : file;
};
var getProcessor = (getWasm) => {
  let wasmModule;
  let wasmModulePromise;
  const loadModule = async () => {
    const source = await getWasm();
    if ("arrayBuffer" in source) {
      if (typeof WebAssembly.compileStreaming === "function" && source instanceof Response && source.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/wasm") {
        return WebAssembly.compileStreaming(source);
      }
      return WebAssembly.compile(await source.arrayBuffer());
    }
    return WebAssembly.compile(source);
  };
  async function processor3(textOrAst, options = {}) {
    if (!wasmModule && !wasmModulePromise && getWasm.length === 0) {
      wasmModulePromise = loadModule();
    }
    if (wasmModulePromise) {
      try {
        wasmModule = await wasmModulePromise;
      } finally {
        wasmModulePromise = void 0;
      }
    }
    const go = new Go();
    const instance = getWasm.length === 0 ? await WebAssembly.instantiate(wasmModule, go.importObject) : await getWasm(go.importObject);
    void go.run(instance);
    return invoke(instance.exports, textOrAst, options);
  }
  return processor3;
};

// node_modules/sh-syntax/lib/index.js
var importMetaUrl = import.meta.url;
var moduleDir = importMetaUrl ? path2.dirname(fileURLToPath(importMetaUrl)) : __dirname;
var processor = getProcessor(() => fs2.readFile(path2.resolve(moduleDir, "../main.wasm")));

// src/shared/shell-ast.ts
var HERE = fileURLToPath2(new URL(".", import.meta.url)).replace(/\\/g, "/");
var SHIPPED_WASM = `${HERE}sh-syntax.wasm`;
var SHIPPED_WASM_EXEC = `${HERE}sh-syntax-wasm_exec.cjs`;
var SHIPPED = existsSync3(SHIPPED_WASM) && existsSync3(SHIPPED_WASM_EXEC);
var WALKER = existsSync3(`${HERE}shell-ast-walk.ps1`) ? `${HERE}shell-ast-walk.ps1` : `${HERE}../shell-ast-walk.ps1`;
function packageDir() {
  if (process.env.SH_SYNTAX_DIR) return process.env.SH_SYNTAX_DIR.replace(/\\/g, "/");
  try {
    const pkg = createRequire(import.meta.url).resolve("sh-syntax/package.json");
    return pkg.replace(/\\/g, "/").replace(/\/package\.json$/, "");
  } catch {
    return "";
  }
}
var SH_SYNTAX_DIR = packageDir();
var WASM_PATH = SHIPPED ? SHIPPED_WASM : `${SH_SYNTAX_DIR}/main.wasm`;
var WASM_EXEC_PATH = SHIPPED ? SHIPPED_WASM_EXEC : `${SH_SYNTAX_DIR}/vendors/wasm_exec.cjs`;
var BinCmdOperator = { AndStmt: 11, OrStmt: 12, Pipe: 13, PipeAll: 14 };
var RedirOperator = { RdrIn: 65, RdrInOut: 66, DplIn: 67, Hdoc: 71, DashHdoc: 72, WordHdoc: 73 };
var ParExpOperator = { AssignUnset: 87, AssignUnsetOrNull: 88 };
var NO_SPANS = { quoted: [], substs: [], bodies: [] };
var BASH_KINDS_NOTE = ["File", "Stmt", "CallExpr", "BinaryCmd", "Word", "Lit", "SglQuoted", "DblQuoted", "ParamExp", "CmdSubst", "ProcSubst", "Assign", "Redirect", "Subshell", "Block", "IfClause", "WhileClause", "ForClause", "WordIter", "CaseClause", "CaseItem", "FuncDecl", "DeclClause", "TimeClause", "ArithmExp", "BinaryArithm", "ParenArithm", "ArrayExpr", "ArrayElem", "Comment", "CoprocClause", "CStyleLoop", "UnaryArithm", "TestClause"];
var BASH_KINDS_EXTRA = ["BinaryTest", "UnaryTest", "ArithmCmd", "LetClause"];
var PWSH_KINDS = ["ScriptBlockAst", "NamedBlockAst", "StatementBlockAst", "PipelineAst", "PipelineChainAst", "CommandAst", "CommandExpressionAst", "CommandParameterAst", "StringConstantExpressionAst", "ExpandableStringExpressionAst", "ConstantExpressionAst", "VariableExpressionAst", "MemberExpressionAst", "InvokeMemberExpressionAst", "ArrayExpressionAst", "ArrayLiteralAst", "HashtableAst", "ParenExpressionAst", "SubExpressionAst", "ScriptBlockExpressionAst", "BinaryExpressionAst", "UnaryExpressionAst", "ConvertExpressionAst", "TypeExpressionAst", "TypeConstraintAst", "IndexExpressionAst", "AssignmentStatementAst", "IfStatementAst", "ForStatementAst", "ForEachStatementAst", "WhileStatementAst", "DoWhileStatementAst", "DoUntilStatementAst", "SwitchStatementAst", "TryStatementAst", "CatchClauseAst", "TrapStatementAst", "FunctionDefinitionAst", "ParamBlockAst", "ParameterAst", "AttributeAst", "NamedAttributeArgumentAst", "FileRedirectionAst", "MergingRedirectionAst", "ReturnStatementAst", "BreakStatementAst", "ContinueStatementAst", "ThrowStatementAst", "ExitStatementAst", "UsingExpressionAst", "TernaryExpressionAst", "AttributedExpressionAst", "DataStatementAst"];
var CD_NAMES = /* @__PURE__ */ new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
var POP_NAMES = /* @__PURE__ */ new Set(["popd", "pop-location"]);
var SHELLS = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "ksh"]);
var PWSHS = /* @__PURE__ */ new Set(["pwsh", "powershell"]);
var READ_WRITERS = /* @__PURE__ */ new Set(["read", "mapfile", "readarray", "getopts"]);
var MAX_NEST = 4;
var processor2;
function bashProcessor() {
  if (!processor2) {
    createRequire(import.meta.url)(WASM_EXEC_PATH);
    processor2 = getProcessor(() => fs3.readFile(WASM_PATH));
  }
  return processor2;
}
async function parseBashRaw(text) {
  return bashProcessor()(text);
}
function progName(lit) {
  if (lit == null) return null;
  return lit.replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
}
var GLOB = /[*?]|\[[^\]]*\]|\{[^{}]*(,|\.\.)[^{}]*\}/;
var DQ_ESC = /\\[$`"\\\n]/;
function partLit(p) {
  if (p.type === "Lit") return /\\/.test(p.value) || GLOB.test(p.value) ? null : p.value;
  if (p.type === "SglQuoted") return p.dollar && p.value.includes("\\") ? null : p.value;
  if (p.type === "DblQuoted") {
    if (p.dollar || !(p.parts ?? []).every((q) => q.type === "Lit")) return null;
    const v = p.parts.map((q) => q.value).join("");
    return DQ_ESC.test(v) ? null : v;
  }
  return null;
}
function wordLit(w) {
  let s = "";
  for (const p of w.parts ?? []) {
    const v = partLit(p);
    if (v === null) return null;
    s += v;
  }
  return s;
}
function partPrefix(p) {
  if (p.type !== "DblQuoted") {
    const v = partLit(p);
    return v === null ? { s: "", end: true } : { s: v, end: false };
  }
  let s = "";
  for (const q of p.parts ?? []) {
    const r = partPrefix(q);
    s += r.s;
    if (r.end) return { s, end: true };
  }
  return { s, end: false };
}
function wordPrefix(w) {
  let s = "";
  for (const p of w.parts ?? []) {
    const r = partPrefix(p);
    s += r.s;
    if (r.end) break;
  }
  return s;
}
var walkAll = (n, fn) => {
  if (Array.isArray(n)) {
    n.forEach((x) => walkAll(x, fn));
    return;
  }
  if (!n || typeof n !== "object") return;
  if (n.type) fn(n);
  for (const v of Object.values(n)) if (v && typeof v === "object") walkAll(v, fn);
};
var nodesOf = (n, types) => {
  const out3 = [];
  walkAll(n, (x) => {
    if (types.includes(x.type)) out3.push(x);
  });
  return out3;
};
var plainParam = (p) => !p.exp && !p.index && !p.repl && !p.slice && !p.names && !p.length && !p.excl && !p.width && !p.isSet && !p.flags;
function singleVar(w) {
  const parts = w.parts ?? [];
  const p = parts.length === 1 ? parts[0] : null;
  const quoted = p?.type === "DblQuoted";
  const q = quoted && p.parts.length === 1 ? p.parts[0] : p;
  return q?.type === "ParamExp" && plainParam(q) ? { name: q.param.value, quoted } : null;
}
function makeConv(text) {
  const buf = Buffer.from(text, "utf8");
  const ascii = buf.length === text.length;
  return { c: (o) => ascii ? o : buf.subarray(0, o).toString().length, slice: (s, e) => ascii ? text.slice(s, e) : buf.subarray(s, e).toString() };
}
function makeBashWord(w, conv) {
  const lit = wordLit(w);
  const cs = nodesOf(w, ["CmdSubst", "ProcSubst"]).length > 0;
  const sv = lit === null ? singleVar(w) : null;
  const kind = lit !== null ? "lit" : cs ? "cmdsubst" : sv ? "var" : "dyn";
  const vars = nodesOf(w, ["ParamExp"]).map((p) => p.param?.value).filter(Boolean);
  const [start, end] = [conv.c(w.start), conv.c(w.end)];
  const out3 = { lit, kind, raw: conv.slice(w.start, w.end), start, end, vars };
  if (sv) {
    out3.var = sv.name;
    out3.quoted = sv.quoted;
  }
  if (lit === null) out3.prefix = wordPrefix(w);
  return out3;
}
function walkBash(file, text) {
  const conv = makeConv(text);
  const ev = [];
  const kinds = /* @__PURE__ */ new Set();
  const free = [];
  const quoted = [];
  const dqRanges = [];
  const substRaw = [];
  walkAll(file, (n) => {
    kinds.add(n.type);
    if (n.type === "Comment") free.push([conv.c(n.start), conv.c(n.end)]);
    else if (n.type === "SglQuoted") quoted.push([conv.c(n.start) + (n.dollar ? 2 : 1), conv.c(n.end) - 1]);
    else if (n.type === "DblQuoted") {
      const r = [conv.c(n.start) + (n.dollar ? 2 : 1), conv.c(n.end) - 1];
      quoted.push(r);
      dqRanges.push(r);
    } else if (n.type === "CmdSubst" || n.type === "ProcSubst" || n.type === "ArithmExp") substRaw.push([conv.c(n.start), conv.c(n.end)]);
  });
  const delims = [];
  const substs = substRaw.map(([from, to]) => ({ from, to, dq: dqRanges.some(([a, b]) => a <= from && to <= b + 1) }));
  const base = { pipe: false, chain: null, background: false };
  const root = { place: base, depth: 0, func: null, top: true };
  const subst = (node, ctx) => {
    const outer = [];
    const find = (n) => {
      if (Array.isArray(n)) return n.forEach(find);
      if (!n || typeof n !== "object") return;
      if (n.type === "CmdSubst" || n.type === "ProcSubst") {
        outer.push(n);
        return;
      }
      Object.values(n).forEach((v) => v && typeof v === "object" && find(v));
    };
    find(node);
    for (const n of outer) scoped(() => stmts(n.stmts, { ...ctx, depth: ctx.depth + 1, top: false }));
  };
  const scoped = (run) => {
    ev.push({ t: "scope", open: true });
    run();
    ev.push({ t: "scope", open: false });
  };
  const stmts = (list, ctx) => list.forEach((s, i) => stmt(s, i ? { ...ctx, place: { ...ctx.place, chain: ";" } } : ctx));
  const stmt = (s, ctx) => {
    const bg = ctx.place.background || s.background;
    const c = { ...ctx, place: { ...ctx.place, background: bg }, top: ctx.top && !s.background };
    const prog = s.cmd?.type === "CallExpr" && s.cmd.args.length ? progName(wordLit(s.cmd.args[0])) : null;
    for (const r of s.redirs ?? []) redirect(r, c, prog, s);
    cmd(s.cmd, c, s);
  };
  const heredocs = [];
  const redirect = (r, ctx, prog, s) => {
    for (const w of [r.word, r.hdoc]) if (w) subst(w, ctx);
    if (r.word && (r.op === RedirOperator.Hdoc || r.op === RedirOperator.DashHdoc)) delims.push([conv.c(r.word.start), conv.c(r.word.end)]);
    if (r.hdoc) heredocs.push({ start: conv.c(r.hdoc.start), end: conv.c(r.hdoc.end), pipe: ctx.place.pipe, callStart: s.cmd?.type === "CallExpr" && s.cmd.args.length ? conv.c(s.cmd.start) : null });
    if (r.hdoc && !ctx.place.pipe && !SHELLS.has(prog ?? "") && !PWSHS.has(prog ?? "")) free.push([conv.c(r.hdoc.start), conv.c(r.hdoc.end)]);
  };
  const cmd = (c, ctx, s) => {
    const inner = { ...ctx, top: false };
    switch (c?.type) {
      case "CallExpr":
        return call(c, ctx, s);
      case "BinaryCmd":
        return binary(c, ctx);
      case "FuncDecl":
        return stmt(c.body, { ...inner, depth: ctx.depth + 1, func: c.name.value });
      case "ForClause":
        return loop(c, { ...inner, depth: ctx.depth + 1 });
      case "WhileClause":
        stmts(c.cond ?? [], { ...inner, depth: ctx.depth + 1 });
        return stmts(c.do ?? [], { ...inner, depth: ctx.depth + 1 });
      case "IfClause":
        return ifc(c, inner);
      case "CaseClause":
        subst(c.word, inner);
        return c.items.forEach((i) => stmts(i.stmts ?? [], inner));
      case "Subshell":
        return scoped(() => stmts(c.stmts, inner));
      case "Block":
        return stmts(c.stmts, ctx);
      case "TimeClause":
      case "CoprocClause":
        if (c.stmt) stmt(c.stmt, inner);
        return;
      case "DeclClause":
        return decl(c, inner);
      default:
        return subst(c, inner);
    }
  };
  const ifc = (c, ctx) => {
    stmts(c.cond ?? [], ctx);
    stmts(c.then ?? [], ctx);
    if (c.else) ifc(c.else, ctx);
  };
  const loop = (c, ctx) => {
    if (c.loop?.type === "WordIter") {
      subst(c.loop.items ?? [], ctx);
      const raw = (c.loop.items ?? []).map((w) => conv.slice(w.start, w.end)).join(" ");
      ev.push({ t: "assign", name: c.loop.name.value, lit: null, raw, top: false });
    } else subst(c.loop, ctx);
    stmts(c.do ?? [], ctx);
  };
  const binary = (c, ctx) => {
    const pipe = c.op === BinCmdOperator.Pipe || c.op === BinCmdOperator.PipeAll;
    const chain = c.op === BinCmdOperator.AndStmt ? "&&" : c.op === BinCmdOperator.OrStmt ? "||" : null;
    if (pipe) {
      const p = { ...ctx, place: { ...ctx.place, pipe: true }, top: false };
      stmt(c.x, p);
      stmt(c.y, p);
      return;
    }
    stmt(c.x, ctx);
    stmt(c.y, { ...ctx, place: { ...ctx.place, chain }, top: false });
  };
  const decl = (c, ctx) => {
    if (c.variant?.value === "export") ev.push({ t: "barrier" });
    for (const a of c.args ?? []) {
      if (a.value) subst(a.value, ctx);
      if (a.type === "Assign" && a.name) ev.push({ t: "assign", name: a.name.value, lit: null, top: false });
    }
  };
  const call = (c, ctx, s) => {
    for (const a of c.assigns) if (a.value) subst(a.value, ctx);
    for (const w of c.args) {
      subst(w, ctx);
      paramWrites(w);
    }
    if (!c.args.length) {
      for (const a of c.assigns) ev.push({ t: "assign", name: a.name.value, lit: a.value && !a.array ? wordLit(a.value) : null, raw: a.value ? conv.slice(a.value.start, a.value.end) : "", top: ctx.top });
      return;
    }
    const words = c.args.map((w) => makeBashWord(w, conv));
    const assigns = c.assigns.map((a) => ({ name: a.name.value, lit: a.value ? wordLit(a.value) : null }));
    const call2 = { t: "call", dialect: "bash", words, assigns, place: ctx.place, depth: ctx.depth, func: ctx.func, inFunctionBody: ctx.func !== null, op: null, stdin: stdinOf(s), level: 0, start: conv.c(c.start), end: conv.c(c.end) };
    writersOf(words);
    ev.push(call2);
  };
  const writersOf = (words) => {
    const p = progName(words[0].lit);
    if (READ_WRITERS.has(p ?? "")) for (const w of words.slice(1)) ev.push({ t: "assign", name: w.lit ?? w.raw, lit: null, top: false });
    if (p === "printf") words.forEach((w, i) => w.lit === "-v" && words[i + 1] && ev.push({ t: "assign", name: words[i + 1].lit ?? words[i + 1].raw, lit: null, top: false }));
    if (["eval", "source", "."].includes(words[0].lit ?? "")) ev.push({ t: "unsafe" });
  };
  const paramWrites = (w) => {
    for (const p of nodesOf(w, ["ParamExp"])) if (p.exp && (p.exp.op === ParExpOperator.AssignUnset || p.exp.op === ParExpOperator.AssignUnsetOrNull) && p.param) ev.push({ t: "assign", name: p.param.value, lit: null, top: false });
  };
  stmts(file.stmts, root);
  if (kinds.has("LetClause") || kinds.has("ArithmCmd") || kinds.has("ArithmExp") || kinds.has("CStyleLoop")) ev.push({ t: "unsafe" });
  return { events: ev, kinds, free, heredocs, spans: { quoted: quoted.filter(([a, b]) => !delims.some(([x, y]) => x <= a && b <= y)), substs, bodies: heredocs.map((h) => [h.start, h.end]) } };
}
var STDIN_OPS = [RedirOperator.RdrIn, RedirOperator.RdrInOut, RedirOperator.DplIn, RedirOperator.Hdoc, RedirOperator.DashHdoc, RedirOperator.WordHdoc];
function stdinOf(s) {
  let last = null;
  for (const r of s?.redirs ?? []) {
    const fd = r.n?.value;
    if ((fd === void 0 || fd === "0") && STDIN_OPS.includes(r.op)) last = r;
  }
  if (!last) return null;
  if (last.op === RedirOperator.Hdoc || last.op === RedirOperator.DashHdoc) return { lit: last.hdoc ? wordLit(last.hdoc) : null };
  if (last.op === RedirOperator.WordHdoc) return { lit: last.word ? wordLit(last.word) : null };
  return { lit: null };
}
function runWalker(text, timeoutMs) {
  return new Promise((resolve4) => {
    const cp = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", WALKER], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out3 = "";
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve4(v);
      }
    };
    const timer = setTimeout(() => {
      cp.kill();
      fin({ error: "pwsh timeout" });
    }, timeoutMs);
    cp.stdout.setEncoding("utf8");
    cp.stdout.on("data", (d) => {
      out3 += d;
    });
    cp.on("error", (e) => fin({ error: `pwsh spawn: ${e.message}` }));
    cp.on("close", (code) => {
      if (code !== 0) return fin({ error: `pwsh exit ${code}` });
      try {
        fin({ json: JSON.parse(out3) });
      } catch {
        fin({ error: "pwsh bad json" });
      }
    });
    cp.stdin.on("error", () => {
    });
    cp.stdin.end(text, "utf8");
  });
}
function psWord(el, text) {
  const w = { lit: null, kind: el.k, raw: text.slice(el.s, el.e), start: el.s, end: el.e, vars: [] };
  if (el.k === "lit") {
    w.lit = el.v;
    w.st = el.st;
  } else if (el.k === "param") {
    w.lit = el.v;
    w.kind = "param";
  } else if (el.k === "subexpr") w.kind = "cmdsubst";
  else if (el.k === "var") {
    w.var = el.var;
    w.vars = [el.var];
  } else if (el.k === "expandable") w.prefix = el.prefix;
  if (el.colon) w.colon = true;
  return w;
}
function walkPwsh(j, text) {
  const evs = [];
  for (const c of j.cmds) {
    const words = c.els.map((e) => psWord(e, text));
    evs.push({ key: c.s, ev: { t: "call", dialect: "pwsh", words, assigns: [], place: { pipe: c.pipe, chain: c.chain, background: c.bg }, depth: c.depth, func: c.func, inFunctionBody: c.func !== null, op: c.op, stdin: null, level: 0, start: c.s, end: c.e } });
    for (const w of outVarWrites(words)) evs.push({ key: c.s, ev: { t: "assign", name: w, lit: null, top: false } });
  }
  for (const a of j.assigns) evs.push({ key: a.end - 0.5, ev: { t: "assign", name: a.name, lit: a.lit, raw: text.slice(a.s, a.end), top: a.top } });
  evs.sort((x, y) => x.key - y.key);
  const rng = (l) => (Array.isArray(l) ? l : []).map((x) => [x.s, x.e]);
  const substs = (Array.isArray(j.substs) ? j.substs : []).map((x) => ({ from: x.s, to: x.e, dq: x.dq === true }));
  return { events: evs.map((x) => x.ev), kinds: new Set(j.kinds), free: j.comments.map((c) => [c.s, c.e]), heredocs: [], spans: { quoted: rng(j.quoted), substs, bodies: rng(j.bodies) } };
}
var OUTVAR = /^-(ov|outvariable|ev|errorvariable|iv|informationvariable|wv|warningvariable|pv|pipelinevariable)$/i;
function outVarWrites(words) {
  const out3 = [];
  words.forEach((w, i) => {
    if (w.kind === "param" && OUTVAR.test(w.lit ?? "") && words[i + 1]) out3.push(words[i + 1].lit ?? words[i + 1].raw);
  });
  return out3;
}
function cdTarget(call) {
  const p = progName(call.words[0].lit);
  if (POP_NAMES.has(p ?? "")) return null;
  if (!CD_NAMES.has(p ?? "")) return void 0;
  const arg = call.words.slice(1).find((w) => w.kind !== "param" && !(w.lit !== null && /^-./.test(w.lit)));
  return arg ? arg.lit : "~";
}
var BARRIER_PROGS = /* @__PURE__ */ new Set(["read", "mapfile", "readarray", "unset", "set-variable", "sv", "new-variable", "nv", "remove-variable", "rv", "clear-variable", "clv", "read-host"]);
var isBarrier = (e) => e.t === "barrier" || e.t === "call" && (BARRIER_PROGS.has(progName(e.words[0].lit) ?? "") || progName(e.words[0].lit) === "set" && e.words.some((w) => w.lit === "--"));
function resolve2(events, dialect) {
  const key = (n) => dialect === "pwsh" ? n.toLowerCase() : n;
  const unsafe = events.some((e) => e.t === "unsafe");
  const writes = /* @__PURE__ */ new Map();
  events.forEach((e, i) => {
    if (e.t === "assign") {
      const k = key(e.name);
      writes.set(k, [...writes.get(k) ?? [], { ...e, i }]);
    }
  });
  const barriers = [];
  events.forEach((e, i) => {
    if (isBarrier(e)) barriers.push(i);
  });
  const cwd = [];
  const scopes = [];
  events.forEach((e, i) => {
    if (e.t === "scope") {
      if (e.open) scopes.push(cwd.length);
      else {
        const n = scopes.pop();
        if (n !== void 0) cwd.length = n;
      }
      return;
    }
    if (e.t !== "call") return;
    for (const w of e.words) resolveWord(w, i, writes, key, unsafe, barriers);
    e.cwdBefore = [...cwd];
    const t = cdTarget(e);
    if (t !== void 0) cwd.push(t);
  });
  const assigns = events.filter((e) => e.t === "assign").map((e) => ({ name: key(e.name), lit: e.lit, raw: e.raw ?? "", top: e.top }));
  return { calls: events.filter((e) => e.t === "call"), assigns };
}
var SPLITS = /[\s*?[\]{]|^$/;
function resolveWord(w, i, writes, key, unsafe, barriers) {
  if (w.kind !== "var" || w.lit !== null || unsafe) return;
  const ws = writes.get(key(w.var));
  if (ws?.length !== 1 || ws[0].lit == null || !ws[0].top || !(ws[0].i < i)) return;
  if (barriers.some((b) => b > ws[0].i && b < i)) return;
  if (w.quoted === false && SPLITS.test(ws[0].lit)) return;
  w.lit = ws[0].lit;
  w.kind = "lit";
  w.viaVar = w.var;
}
var isFlagC = (l) => /^-[A-Za-z]*c[A-Za-z]*$/.test(l);
var prefixOf = (long, l) => l.length >= 2 && long.startsWith(l.toLowerCase());
function joinLits(words) {
  return words.some((w) => w.lit === null) ? null : words.map((w) => w.lit).join(" ");
}
function pwshPayloadIndex(ws) {
  for (let k = 1; k < ws.length; k++) {
    const l = ws[k].lit;
    if (l === null || !/^-/.test(l)) continue;
    if (prefixOf("-file", l)) return -1;
    if (prefixOf("-command", l) || prefixOf("-encodedcommand", l)) return k;
  }
  return -1;
}
function payloadOf(call) {
  const ws = call.words;
  const p = progName(ws[0].lit) ?? "";
  const lit = (i) => ws[i]?.lit ?? "";
  if (SHELLS.has(p)) {
    const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && isFlagC(w.lit));
    if (i > 0) return { dialect: "bash", via: "bash-c", text: ws[i + 1] ? ws[i + 1].lit : null };
    if (call.stdin) return { dialect: "bash", via: "stdin", text: call.stdin.lit };
  }
  if (PWSHS.has(p)) {
    const i = pwshPayloadIndex(ws);
    if (i > 0 && prefixOf("-encodedcommand", lit(i))) return { dialect: "pwsh", via: "encoded", text: ws[i + 1]?.lit == null ? null : Buffer.from(ws[i + 1].lit, "base64").toString("utf16le") };
    if (i > 0) return { dialect: "pwsh", via: "pwsh-c", text: joinLits(ws.slice(i + 1)) };
    if (call.stdin) return { dialect: "pwsh", via: "stdin", text: call.stdin.lit };
  }
  if (p === "eval") return { dialect: "bash", via: "eval", text: joinLits(ws.slice(1)) };
  if (p === "iex" || p === "invoke-expression") return { dialect: "pwsh", via: "iex", text: ws[1] ? ws[1].lit : null };
  if (p === "cmd") return cmdPayload(ws);
  return null;
}
function cmdPayload(ws) {
  const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && /^\/[ck]$/i.test(w.lit));
  if (i < 0) return null;
  return { dialect: "cmd", via: "cmd-c", payload: ws.slice(i + 1).map((w) => w.lit ?? w.raw).join(" ") };
}
var XARGS_VALUE = /* @__PURE__ */ new Set(["-a", "-i", "-n", "-p", "-d", "-e", "-s", "-l", "-I", "-P", "-E", "-L", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--eof", "--replace"]);
function xargsInner(call) {
  if (progName(call.words[0].lit) !== "xargs") return null;
  let i = 1;
  while (i < call.words.length && call.words[i].lit !== null && /^-/.test(call.words[i].lit)) i += XARGS_VALUE.has(call.words[i].lit) ? 2 : 1;
  const words = call.words.slice(i);
  return words.length ? { ...call, words, argsUnknown: true, viaPayload: "xargs", depth: call.depth + 1, level: call.level + 1, nested: void 0 } : null;
}
async function expandNested(calls, opts, level) {
  if (opts.noNested) return calls;
  const out3 = [];
  for (const c of calls) {
    out3.push(c);
    const x = xargsInner(c);
    if (x) out3.push(x);
    const pay = payloadOf(c);
    if (!pay) continue;
    if (pay.dialect === "cmd") {
      c.nested = { status: "unparsed", dialect: "cmd", payload: pay.payload };
      continue;
    }
    if (pay.text === null || pay.text === void 0 || level >= MAX_NEST) {
      c.nested = { status: "dynamic", via: pay.via };
      continue;
    }
    const r = await parseLevel(pay.text, pay.dialect, opts, level + 1);
    if (!r.ok) {
      c.nested = { status: "error", via: pay.via, dialect: pay.dialect, text: pay.text };
      continue;
    }
    c.nested = { status: "parsed", via: pay.via, dialect: pay.dialect };
    for (const ic of r.calls) out3.push({ ...ic, depth: ic.depth + c.depth + 1, level: level + 1, viaPayload: pay.via, cwdBefore: [...c.cwdBefore ?? [], ...ic.cwdBefore ?? []] });
    r.kinds.forEach((k) => (c.nestedKinds ??= /* @__PURE__ */ new Set()).add(k));
  }
  return out3;
}
function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}
async function parseLevel(text, dialect, opts, level) {
  const r = dialect === "pwsh" ? await levelPwsh(text, opts) : await levelBash(text, opts);
  if (!r.ok) return { ok: false, calls: [], errors: r.errors, kinds: r.kinds, freeRanges: [], heredocs: [], assigns: [], dialect, ...NO_SPANS };
  const { calls, assigns } = resolve2(r.events, dialect);
  const expanded = await expandNested(calls, opts, level);
  const kinds = new Set(r.kinds);
  for (const c of expanded) c.nestedKinds?.forEach((k) => kinds.add(k));
  return { ok: true, calls: expanded, errors: [], kinds, freeRanges: r.free, heredocs: r.heredocs, assigns, dialect, ...r.spans ?? NO_SPANS };
}
async function levelBash(text, opts = {}) {
  let file;
  try {
    file = await (opts.bashProvider ?? parseBashRaw)(text);
  } catch (e) {
    const conv = makeConv(text);
    const pos = e?.pos ?? { offset: 0, line: 1, column: 1 };
    return { ok: false, errors: [{ msg: String(e?.message ?? e), offset: conv.c(pos.offset), line: pos.line, column: pos.column, reader: e?.pos === void 0 }], kinds: /* @__PURE__ */ new Set() };
  }
  if (file === null || typeof file !== "object") return { ok: false, errors: [{ msg: "sh-syntax returned no tree", offset: 0, line: 1, reader: true }], kinds: /* @__PURE__ */ new Set() };
  const w = walkBash(file, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}
async function levelPwsh(text, opts) {
  const { json, error } = opts.pwshProvider ? opts.pwshProvider(text) : await runWalker(text, opts.timeoutMs ?? 3e3);
  if (error || !json) return { ok: false, errors: [{ msg: error ?? "pwsh no result", offset: 0, line: 1, reader: true }], kinds: /* @__PURE__ */ new Set() };
  if (json.errors.length) return { ok: false, errors: json.errors.map((e) => ({ msg: e.msg, offset: e.offset, line: lineOf(text, e.offset) })), kinds: new Set(json.kinds) };
  const w = walkPwsh(json, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}
async function parseCalls(text, dialect, opts = {}) {
  const r = await parseLevel(text, dialect, opts, 0);
  return { ...r, kinds: [...r.kinds] };
}

// src/shared/shell-judge.ts
init_trace_boot();
var DEFAULT_KINDS = [...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS];
var PROGRAM_WORDS = /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr)\b/i;
var VERB_WORDS = /\b(push|review|pulls)\b|\bpr\s+(create|merge)\b/i;
var DYNAMIC_SIGNS = /(^|\s)&\s|\b(iex|Invoke-Expression|Invoke-Command|Start-Process|cmd|bash|sh|pwsh|powershell)\b|-EncodedCommand/i;
var defaultEntry = (t) => PROGRAM_WORDS.test(t) || VERB_WORDS.test(t) || DYNAMIC_SIGNS.test(t);
var GIT_BUILTIN = new Set("add am apply archive bisect blame branch bundle cat-file checkout cherry-pick clean clone commit config describe diff difftool fetch format-patch gc grep help init log ls-files ls-remote ls-tree merge mergetool mv notes pull push range-diff rebase reflog remote reset restore rev-list rev-parse revert rm shortlog show sparse-checkout stash status submodule switch tag version worktree".split(" "));

// src/shared/tap-scope.ts
init_trace_boot();
import * as fs4 from "fs";
import * as os2 from "os";
import * as path3 from "path";

// ../../scripts/github/lib/repo-identity.mjs
init_trace_boot();
var NAME = "([\\w.-]+)";
var TAIL = `${NAME}\\/([\\w.-]+?)(?:\\.git)?\\/?$`;
var URL_FORM = new RegExp(`^(?:https?|git|ssh):\\/\\/(?:[^@/\\s]+@)?github\\.com(?::\\d+)?\\/${TAIL}`, "i");
var SCP_FORM = new RegExp(`^(?:[\\w.-]+@)?github\\.com:${TAIL}`, "i");
var HOST_TAIL = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/;
var SSH_FORM = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/|(?:[^@/\s:]+@)?[^@/\s:]{2,}:(?!\/\/))/i;
var SSH_HOST = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/(?:[^@/\s]+@)?([^/\s:]+)|(?:[^@/\s:]+@)?([^@/\s:]{2,}):)/i;
var githubHost = (host) => host === "github.com" || host === "ssh.github.com" || /^[a-z0-9_-]+$/.test(host);
var OWNER_REPO = /^([\w.-]+)\/([\w.-]+)$/;
var DOTS = /^\.+$/;
function repoSlug(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  const m = URL_FORM.exec(text) ?? SCP_FORM.exec(text);
  if (!m || DOTS.test(m[1]) || DOTS.test(m[2])) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}
function normPath(p) {
  let s = String(p ?? "").replace(/\\/g, "/").replace(/^\/\/[?.]\//, "");
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase();
  return s.replace(/(?<=.)\/{2,}/g, "/").replace(/(?<=.)\/+$/, "");
}
var isPathLike = (t) => /^[\\/.~]/.test(t) || /^[a-zA-Z]:(?:[\\/]|$)/.test(t) || /^file:/i.test(t);
function isUrlLike(text) {
  const t = String(text ?? "").trim();
  return t !== "" && (isPathLike(t) || t.includes(":"));
}
function githubField(v) {
  if (typeof v !== "string") return null;
  const slug = repoSlug(v);
  if (slug) return slug;
  const m = OWNER_REPO.exec(v.trim());
  return m && !DOTS.test(m[1]) && !DOTS.test(m[2]) ? v.trim().toLowerCase() : null;
}
function stripCredentials(text) {
  return String(text ?? "").trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1").replace(/^[^@/\s]+@(?=[^@/:\s]+:)/, "");
}
function targetOf2(url) {
  const t = url.trim();
  if (isPathLike(t)) return normPath(t.replace(/^file:\/\//i, ""));
  return stripCredentials(t).replace(/\/+$/, "");
}
function sshTail(url) {
  if (typeof url !== "string") return null;
  const t = url.trim();
  if (t === "" || isPathLike(t) || !SSH_FORM.test(t)) return null;
  const h = SSH_HOST.exec(t);
  if (!h || !githubHost((h[1] ?? h[2]).toLowerCase())) return null;
  const m = HOST_TAIL.exec(t);
  return m && !DOTS.test(m[1]) && !DOTS.test(m[2]) ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
function keyRepo({ url, entryKey, github } = {}) {
  const key = typeof entryKey === "string" ? entryKey.trim() : "";
  if (url === void 0 || url === null || String(url).trim() === "") return key ? `local:${key}` : null;
  const slug = repoSlug(url);
  if (slug) return slug;
  const field = githubField(github);
  if (field && sshTail(String(url)) === field) return field;
  return key ? `local:${key}:${targetOf2(String(url))}` : null;
}
var needsGithubField = (url, github) => repoSlug(url) === null && sshTail(url) !== null && githubField(github) === null;
var out = (git, args) => {
  const r = git(args);
  return r && r.status === 0 ? String(r.stdout ?? "").trim() : null;
};
var lines = (text) => (text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
var uniq = (list) => [...new Set(list)];
var remoteNames = (git) => lines(out(git, ["remote"]));
function pushRefOf(git, names) {
  const m = /^refs\/remotes\/(.+)$/.exec(out(git, ["rev-parse", "--symbolic-full-name", "@{push}"]) ?? "");
  if (!m) return null;
  const remote = names.filter((n) => m[1].startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: m[1].slice(remote.length + 1) } : null;
}
function remoteUrls(git, remote, push) {
  return targetsOf(git, remote, push)?.urls ?? null;
}
function targetsOf(git, remote, push) {
  const listed = out(git, ["remote", "get-url", ...push ? ["--push", "--all"] : [], "--end-of-options", remote]);
  if (listed !== null) return { urls: lines(listed), configured: true };
  return isUrlLike(remote) ? { urls: [remote.trim()], configured: false } : null;
}
var idFor = (t, { entryKey, github }) => ({ entryKey, github: t.configured ? github : null });
function pushKey(git, { remote = null, branch = null, entryKey = null, github = null } = {}) {
  let d;
  const defaults = () => d ??= pushDefaults(git, remote);
  const via = remote ?? defaults().remote;
  if (via === null) return { ok: false, why: "name-remote" };
  const t = targetsOf(git, via, true);
  if (t === null || t.urls.length === 0) return { ok: false, why: "unknown-remote", remote: via };
  const id = idFor(t, { entryKey, github });
  const keys = uniq(t.urls.map((url) => keyRepo({ url, ...id })));
  if (keys.includes(null)) return { ok: false, why: "no-key", remote: via };
  if (keys.length > 1) return { ok: false, why: "multi-pushurl", remote: via, keys };
  const dest = branch ?? defaults().branch;
  if (!dest) return { ok: false, why: "no-branch", remote: via, key: keys[0] };
  return { ok: true, key: keys[0], remote: via, branch: dest, configured: t.configured };
}
function pushDefaults(git, remote = null) {
  const up = pushRefOf(git, remoteNames(git));
  const via = remote ?? up?.remote ?? null;
  const branch = up !== null && up.remote === via ? up.branch : out(git, ["branch", "--show-current"]) ?? "";
  return { remote: via, branch };
}
function fetchKey(git, remote, { entryKey = null, github = null } = {}) {
  const t = targetsOf(git, remote, false);
  return t && t.urls.length > 0 ? keyRepo({ url: t.urls[0], ...idFor(t, { entryKey, github }) }) : null;
}
function ghRemote(git, names = remoteNames(git)) {
  return pushRefOf(git, names)?.remote ?? (names.length === 1 ? names[0] : null);
}
function ghKey(git, { named = null, entryKey = null, github = null } = {}) {
  const names = remoteNames(git);
  const id = { entryKey, github };
  if (named !== null) {
    const hit = names.find((r) => fetchKey(git, r, id) === named);
    if (hit !== void 0) return { ok: true, key: named, remote: hit };
    const via2 = ghRemote(git, names);
    const key2 = via2 !== null ? fetchKey(git, via2, id) : names.length === 0 ? keyRepo({ entryKey }) : null;
    return { ok: false, why: "repo-differs", key: key2, remote: via2, remotes: names };
  }
  if (names.length === 0) return keyRepo({ entryKey }) ? { ok: true, key: keyRepo({ entryKey }), remote: null } : { ok: false, why: "no-key", remotes: names };
  const via = ghRemote(git, names);
  if (via === null) return { ok: false, why: "two-remotes", remotes: names };
  const key = fetchKey(git, via, id);
  if (key === null) return { ok: false, why: "no-key", remote: via, remotes: names };
  if (names.length > 1) return { ok: false, why: "unnamed", key, remote: via, remotes: names };
  const pushKeys = uniq((remoteUrls(git, via, true) ?? []).map((url) => keyRepo({ url, entryKey, github })));
  if (pushKeys.some((k) => k !== key)) return { ok: false, why: "fetch-push-differ", key, remote: via, pushKeys };
  return { ok: true, key, remote: via };
}
function openPrKey({ repo, branch, base = null } = {}) {
  const key = `${repo}@${branch}`;
  return typeof base === "string" && base !== "" ? `${key}:${base}` : key;
}
var UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
function oneLine2(text, max) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`oneLine: max must be a whole number above 0, got ${max}`);
  const plain = String(text ?? "").normalize("NFKC").replace(UNSAFE_CHARS, " ").replace(/\s+/gu, " ").trim();
  const points = [...plain];
  if (points.length <= max) return plain;
  return `${points.slice(0, max - 1).join("").trimEnd()}\u2026`;
}

// src/shared/tap-scope.ts
var CCV3_ENTRY = "continuous-claude";
var readUtf8 = (file) => fs4.readFileSync(file, "utf8");
var realNative = (p) => fs4.realpathSync.native(p);
var isNetwork = (p) => /^\/\//.test(normPath2(p));
var normPath2 = normPath;
var isAbsolute = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
function realNorm(p, realpath) {
  if (!p || !isAbsolute(p)) return "";
  if (isNetwork(p)) return normPath2(p);
  try {
    return normPath2(realpath(p));
  } catch {
    return normPath2(p);
  }
}
function registryFile(opts) {
  const env = opts.env ?? process.env;
  if (opts.path) return opts.path;
  if (env.LANE_REGISTRY_PATH) return env.LANE_REGISTRY_PATH;
  const home = env.USERPROFILE || env.HOME || (opts.deps?.homedir ?? os2.homedir)();
  return path3.join(home, ".claude", "project-registry.json");
}
var slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function entryOf(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const e = item;
  const key = typeof e.key === "string" && e.key ? e.key : slugify(typeof e.name === "string" ? e.name : "");
  const raw = typeof e.path === "string" ? e.path : "";
  const root = raw && isAbsolute(raw) ? normPath2(raw) : "";
  if (!key || !root) return null;
  const status = typeof e.status === "string" ? e.status : "active";
  return { key, root, status, tapGate: typeof e.tapGate === "string" ? e.tapGate : null, github: typeof e.github === "string" ? e.github : null };
}
function readRegistry(opts = {}) {
  const file = registryFile(opts);
  const named = !opts.path && Boolean((opts.env ?? process.env).LANE_REGISTRY_PATH);
  const first = readOnce(file, opts);
  const r = first.state === "corrupt" ? readOnce(file, opts) : first;
  return named ? { ...r, envPath: true } : r;
}
function readOnce(file, opts) {
  let text;
  try {
    text = (opts.deps?.readFile ?? readUtf8)(file);
  } catch (err) {
    return { state: err?.code === "ENOENT" ? "missing" : "corrupt", entries: [], file };
  }
  let projects;
  try {
    projects = JSON.parse(text.replace(/^\uFEFF/, "")).projects;
  } catch {
    return { state: "corrupt", entries: [], file };
  }
  if (!Array.isArray(projects)) return { state: "corrupt", entries: [], file };
  const entries = projects.map(entryOf).filter((e) => e !== null);
  return { state: "ok", entries, file };
}
var notCovered = (reason, entryKey = null) => ({ covered: false, entryKey, reason });
var entryReal = (e, realpath) => realNorm(e.root, realpath);
function firstEntry(dir, entries, realpath, test) {
  if (!dir || !isAbsolute(dir)) return null;
  const raw = normPath2(dir);
  const byRaw = entries.find((e) => test(raw, e.root));
  if (byRaw) return byRaw;
  const real = realNorm(dir, realpath);
  const byReal = entries.find((e) => test(real, e.root));
  if (byReal) return byReal;
  return entries.find((e) => [raw, real].some((folder) => test(folder, entryReal(e, realpath)))) ?? null;
}
var sameDir = (folder, root) => folder === root;
var isUnder = (folder, root) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);
function nearestEntry(input, entries, realpath) {
  return firstEntry(input.toplevel, entries, realpath, sameDir) ?? firstEntry(input.worktreeMainRoot ?? "", entries, realpath, sameDir);
}
function coverageOf(input, registry, deps = {}) {
  if (input.isCcv3) return notCovered("ccv3");
  if (registry.state === "missing") return notCovered("registry-missing");
  if (registry.state === "corrupt") return notCovered("registry-corrupt");
  const entry = nearestEntry(input, registry.entries, deps.realpath ?? realNative);
  if (!entry) return notCovered("no-entry");
  if (entry.key === CCV3_ENTRY) return notCovered("ccv3-root", entry.key);
  if (entry.status.toLowerCase() === "inactive") return notCovered("inactive", entry.key);
  if (entry.tapGate?.trim().toLowerCase() === "off") return notCovered("off", entry.key);
  return { covered: true, entryKey: entry.key, reason: "covered", github: entry.github };
}
var isLive = (e) => e.key !== CCV3_ENTRY && e.status.toLowerCase() !== "inactive" && e.tapGate?.trim().toLowerCase() !== "off";
var parentOf = (p) => {
  const up = p.replace(/\/[^/]*$/, "");
  return up === "" ? "/" : up;
};
var dotGitOf = (dir) => dir.endsWith("/") ? `${dir}.git` : `${dir}/.git`;
function rootOfGitFile(top, text, readFile) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = joinPath(top, m[1]);
  let common = gitdir;
  try {
    common = joinPath(gitdir, readFile(`${gitdir}/commondir`).trim());
  } catch {
  }
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}
function joinPath(base, rel) {
  if (isAbsolute(rel)) return normPath2(rel);
  return normPath2(path3.posix.normalize(`${normPath2(base)}/${rel.replace(/\\/g, "/")}`));
}
function worktreeRootOf(dir, readFile) {
  let cur = normPath2(dir);
  for (let i = 0; i < 64; i++) {
    let text = null;
    try {
      text = readFile(dotGitOf(cur));
    } catch (err) {
      const code = err?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    if (text !== null) return rootOfGitFile(cur, text, readFile);
    const up = parentOf(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}
function underLiveRoot(dir, registry, deps = {}, opts = {}) {
  if (registry.state !== "ok" || !dir || !isAbsolute(dir)) return false;
  const realpath = deps.realpath ?? realNative;
  if (opts.outsideCcv3 && firstEntry(dir, registry.entries.filter((e) => e.key === CCV3_ENTRY), realpath, isUnder)) return false;
  const live = registry.entries.filter(isLive);
  if (firstEntry(dir, live, realpath, isUnder)) return true;
  if (isNetwork(dir)) return false;
  const main3 = worktreeRootOf(dir, deps.readFile ?? readUtf8);
  return main3 !== null && firstEntry(main3, live, realpath, isUnder) !== null;
}
var keyRepo2 = keyRepo;
var oneLine3 = oneLine2;
var pushKey2 = pushKey;
var ghKey2 = ghKey;
var pushDefaults2 = pushDefaults;
var ghRemote2 = (git) => ghRemote(git);
var openPrKey2 = openPrKey;
var needsGithubField2 = needsGithubField;

// src/decision-gate.ts
var HOOK = "decision-gate";
var noCreds = stripCredentials;
var DC = "mcp__plugin_desktop-commander_desktop-commander__";
var COMMAND_TOOLS2 = /* @__PURE__ */ new Set(["Bash", "PowerShell", `${DC}start_process`, `${DC}interact_with_process`]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "NotebookEdit", `${DC}write_file`, `${DC}edit_block`, `${DC}move_file`, `${DC}write_pdf`]);
var PATH_FIELDS = ["file_path", "notebook_path", "path", "destination", "source", "outputPath"];
var GIT_TIMEOUT_MS = 2e3;
var isOpenPrLabel = (label) => /^Open draft PR\b/.test(label);
var isLandLabel = (label) => /^Land (?:now|when READY)\b/.test(label);
var isShipLabel = (label) => /^Commit and push\b/.test(label);
var isPushOnlyLabel = (label) => /^Push only(?: \(Recommended\))?$/.test(label);
var isMergeNowLabel = (label) => /^Merge now \(no READY check\)(?: \(Recommended\))?$/.test(label);
var deny = (pattern, why, scope = "other") => ({ action: "deny", pattern, scope, reason: `BLOCKED (decision-gate): ${why}` });
var openPrWhy = (branch, head) => `no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
var landWhy = (pr) => `no "land" decision from Dave for PR #${pr}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json, pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets a land run. If the PR already merged, run land-pr.ps1 -Pr ${pr} -CleanupOnly.`;
var pushWhy = (branch) => `no "ship" decision from Dave for the tree you push to ${branch}. Ask him first: run node scripts/github/ship-ask.mjs commit-and-push --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged). The tap is bound to one tree: the staged tree, or HEAD's tree for "Push only". A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
var PUSH_UNSAFE_WHY = "a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs, so it stays blocked even with Dave's tap. Push without that option. If it is really needed, ask Dave to run it himself.";
var PUSH_REFSPEC_WHY = "a refspec that names a ref outside refs/heads and refs/tags, or holds a wildcard, can send refs that must stay local (refs/eval/*). Push one branch by name: git push fork <branch>.";
var PUSH_REPO_OPT_WHY = "a --repo option names the push target, so the remote this gate reads is not where the push goes. Name the fork remote and push from the repo.";
var PUSH_ORIGIN_WHY = "a push to origin is never allowed: origin is upstream (parcadei), not the fork. Push to the fork remote.";
var pushUnresolvedWhy = (what) => `${what}, so its ship decision cannot be found. Name the remote and branch (git push fork <branch>) and run it from the repo.`;
var STORE_WHY = "only decision-ledger writes the decision store, from Dave's tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.";
var PAID_MENTION_RE = /@coderabbitai/i;
var PAID_FLAG_RE = /use[-_\s]*credits/i;
var PAID_WHY = "a paid CodeRabbit request runs only through node scripts/github/cr-paid.mjs post --pr N, which reads Dave's priced yes.";
var CAP_FLAG_RE = /--cli-(?:cap-usd|extra-run)/i;
var CAP_LIFT_RE = /^Lift the cap for this one run(?: \(Recommended\))?$/;
var CAP_KEY_MARK = "!cap:";
var CAP_WHY = `the CLI cap override flags (the USD flag and the extra-run flag of pre-pr.mjs and cr-fix.mjs) run only with Dave's tap for this branch, this head and exactly these flags. Ask him first: run node scripts/github/ship-ask.mjs cap-override --branch <branch> [--usd N] [--extra-run] --json, pass its JSON to AskUserQuestion word for word, then run the command once with exactly the flags he tapped. The tap is single use. This gate reads git at the session folder (the folder this session runs in, not a folder the command moves to), so run the flag from the checkout of the tapped branch with no cd in the command. Text that only names a flag (a message, an echo, a search) is denied too: say "the USD flag" or "the extra-run flag" instead.`;
var SUBAGENT_WHY = "a subagent cannot open a PR, land, merge or push: Dave's tap belongs to the main session. Ask the main session to do it.";
var NO_PR_WHY = "the PR number cannot be read from this command, so its land decision cannot be found. Name the PR number in the command (land-pr.ps1 -Pr <n>, gh pr merge <n>).";
var goThereWhy = (repo) => `this command names ${repo}, which is not the CCv3 repo, so it cannot be judged with a CCv3 decision: go to that repo folder and run it there.`;
var fwd = (p) => p.replace(/\\/g, "/");
var CREDS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/'"\\]*@/gi;
var prose = (v) => oneLine3(v.replace(CREDS_RE, "$1"), 200);
var at = (dir) => prose(fwd(dir));
var remoteProse = (remote) => prose(noCreds(remote));
var SAFE_WORD = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+-]*$/;
var SAFE_REMOTE = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+:-]*$/;
var SAFE_DIR = /^[A-Za-z0-9._/@+:\\ -]+$/;
var CWDS = /* @__PURE__ */ new WeakMap();
var stopLine = (name, value) => `the ${name} ${prose(value)} cannot be passed safely in a command; tell Dave.`;
function currentIn(deps, dir) {
  const r = deps.git(dir, ["branch", "--show-current"]);
  return r.status === 0 ? r.stdout.trim() : null;
}
function appAskReads(deps, dir, offer, name) {
  const git = gitIn(deps, dir);
  try {
    if (name === "remote") return offer.sub === "push" ? pushDefaults2(git, null).remote : ghRemote2(git);
    if (name === "branch") return offer.sub === "push" ? pushDefaults2(git, offer.remote ?? null).branch : currentIn(deps, dir);
    return currentIn(deps, dir);
  } catch {
    return null;
  }
}
function flagWord(deps, dir, offer, flag, value, safe) {
  if (value === `<${flag}>` || safe.test(value)) return `--${flag} ${value}`;
  if (flag === "pr" || flag === "base") return null;
  const read = appAskReads(deps, dir, offer, flag === "src" ? "current" : flag);
  if (read !== value) return null;
  return flag === "src" ? "--src HEAD" : "";
}
function askCmd(deps, offer, dir) {
  if (offer.stop) return { ok: false, text: offer.stop };
  const flags = [
    // Seat 3d: the remote with no user:token part. app-ask keys a URL by its owner/repo (repoSlug) or its stripped text, so the key is the same.
    ["pr", offer.pr, /^\d+$/],
    ["remote", offer.remote ? noCreds(offer.remote) : offer.remote, SAFE_REMOTE],
    ["branch", offer.branch, SAFE_WORD],
    ["src", offer.src, SAFE_WORD],
    ["base", offer.base, SAFE_WORD]
  ];
  const words = [offer.sub];
  const read = [];
  for (const [flag, value, safe] of flags) {
    if (value === void 0 || value === null) continue;
    const word = flagWord(deps, dir, offer, flag, value, safe);
    if (word === null) return { ok: false, text: stopLine(flag, value) };
    if (word === "") read.push(flag);
    else words.push(word);
  }
  const folder = fwd(dir);
  if (SAFE_DIR.test(folder)) words.push(`--dir '${folder}'`);
  else if (fwd(CWDS.get(deps) ?? "") === folder) read.push("folder");
  else return { ok: false, text: stopLine("folder", folder) };
  const note = read.length === 0 ? "" : ` (app-ask reads the ${read.join(" and the ")} itself: run it in that folder, on that branch)`;
  const script = `${fwd(deps.home)}/continuous-claude/scripts/github/app-ask.mjs`;
  if (!SAFE_DIR.test(script)) return { ok: false, text: stopLine("script path", script) };
  return { ok: true, text: `node '${script}' ${words.join(" ")} --json${note}` };
}
var askPart = (deps, offer, dir, ok) => {
  const a = askCmd(deps, offer, dir);
  return a.ok ? ok(a.text) : `Dave's question cannot be built as a command here: ${a.text}`;
};
var ASK_HOW = "pass its JSON to AskUserQuestion word for word";
var appOpenPrWhy = (deps, dir, repo, branch, head, base) => `no "open-pr" decision from Dave for ${prose(branch)}${base === null ? "" : ` into ${prose(base)}`} at ${prose(head.slice(0, 7))} in ${prose(repo.key)} (folder ${at(dir)}). ${askPart(deps, { ...repo.offer, branch, ...base === null ? {} : { base } }, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}, then open the PR only if he taps "Open draft PR".`)}`;
var appMergeWhy = (deps, dir, repo, pr) => `no "land" decision from Dave for PR #${prose(pr)} of ${prose(repo.key)} at the head this command names (folder ${at(dir)}). ${askPart(deps, repo.offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}.`)} Only "Merge now (no READY check)" lets the merge run, with sha= or --match-head-commit equal to the head he tapped.`;
var appMergeNoHeadWhy = (deps, dir, pr, offer) => `PR #${prose(pr)} (folder ${at(dir)}): a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Pass the tapped head: gh api .../merge -f sha=<head>, or gh pr merge ${/^\d+$/.test(pr) ? pr : "<n>"} --match-head-commit <head>. ${askPart(deps, offer, dir, (c) => `Ask the merge question first: ${c}.`)}`;
var appNoPrWhy = (dir) => `the PR number cannot be read from this command (folder ${at(dir)}), so its land decision cannot be found. Name the PR number in the command (gh pr merge <n>).`;
function pushNeed(risk) {
  if (risk.kind === "default") return "A push to main, master or the branch the remote HEAD names needs his tap; a push to another branch does not.";
  if (risk.kind === "unsure") return "This push can update a default branch of the repo, so it needs his tap.";
  if (!SAFE_WORD.test(risk.remote)) return `The default branch of remote ${remoteProse(risk.remote)} is not known in this checkout, so this push needs his tap.`;
  return `The default branch of remote ${remoteProse(risk.remote)} is not known in this checkout; git remote set-head ${risk.remote} --auto records it.`;
}
var appPushWhy = (deps, dir, repo, branch, offer, risk) => `no "ship" decision from Dave for the tree you push to ${prose(branch)}${risk.kind === "default" ? ", a default branch of" : " in"} ${prose(repo)} (folder ${at(dir)}). ${pushNeed(risk)} ${askPart(deps, offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged).`)} The tap is bound to this repo, this branch and one tree. A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
var PUSH_WAY_OUT = "run git push as its own command: git push <remote> <branch>";
var appNotAloneWhy = (deps, dir, offer) => `this push shares its command with another command, a pipe or a redirect (folder ${at(dir)}), so Dave's "Push only" tap does not count for it. To clear it, ${PUSH_WAY_OUT}. ${askPart(deps, offer, dir, (c) => `If the gate still asks for his tap then, ask him first: run ${c}, ${ASK_HOW}.`)}`;
var appPushUrlsWhy = (dir, remote, keys) => `remote ${remoteProse(remote)} of ${at(dir)} pushes to more than one repo (${prose(keys.join(", "))}), and one tap covers one push URL, so this push stays blocked even with Dave's tap. Push to one URL (git push <url> <branch>), or ask Dave to run it himself.`;
var ghRepoArg = (key) => SAFE_WORD.test(key) && !key.startsWith("local:") ? key : "<owner/repo>";
var appFetchPushWhy = (deps, dir, remote, key, pushKeys, offer) => `remote ${remoteProse(remote)} of ${at(dir)} fetches from ${prose(key)} but pushes to ${prose(pushKeys.join(", "))}, so gh may act on another repo than the tap names. Name the repo gh acts on: add -R ${ghRepoArg(key)} to the command. ${askPart(deps, offer, dir, (c) => `The question for it: ${c}.`)}`;
var appNoTargetWhy = (deps, dir, remotes, offer) => `${at(dir)} has more than one remote (${prose(remotes.join(", "))}) and its branch has no push target (@{push}), so the repo gh acts on is not known. Name the repo: add -R <owner/repo> (the repo of one remote). ${askPart(deps, offer, dir, (c) => `Then ask the question for that remote: ${c}.`)} Or set the push target first: git branch --set-upstream-to=<remote>/<branch>.`;
var appNameRemoteWhy = (deps, dir) => `this push names no remote and its branch has no push target (@{push}) in ${at(dir)}, so the repo of its ship decision cannot be known: name the remote and the branch (git push <remote> <branch>). ${askPart(deps, { sub: "push", remote: "<remote>" }, dir, (c) => `Ask the ship question for that remote: ${c}.`)}`;
var appRepoOptWhy = (dir) => `--repo names the target of this push in ${at(dir)}, so the repo of its ship decision cannot be known, and it stays blocked even with Dave's tap: name the repo as the remote argument (git push <remote> <branch>).`;
var appPushUnresolvedWhy = (dir, what) => `${prose(what)} (folder ${at(dir)}), so its ship decision cannot be found. Name the remote and the branch (git push <remote> <branch>) and run it from the repo folder.`;
var INDEX_TREE = "the index (git write-tree)";
var appTreeWhy = (dir, what) => {
  const plain = what === INDEX_TREE || what === "HEAD" || strictBranch(what);
  return `cannot read the tree of ${prose(what)} in ${at(dir)}, so its ship decision cannot be found. ${plain ? "Run the command again from the repo folder." : "To clear it, name the branch as plain text: git push <remote> <branch>."}`;
};
var appUnsafeWhy = (dir) => `a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs (folder ${at(dir)}), so it stays blocked even with Dave's tap. Push without that option. If it is really needed, ask Dave to run it himself.`;
var appUnsafeConfigWhy = (dir, remote, key) => `remote ${remoteProse(remote)} is set as a mirror or has a + push refspec (${prose(key)}) in ${at(dir)}, so this push can rewrite or remove remote refs and stays blocked even with Dave's tap; ask Dave to run it himself or to change that config.`;
var WIDER_WHY = "git config makes this push write more than the branch it names; name both sides: git push <remote> <src>:<dst> --no-recurse-submodules, or ask Dave";
var appWiderConfigWhy = (dir, key) => `${WIDER_WHY}. The key: ${prose(key)} (folder ${at(dir)}).${key === "push.followtags" ? " With push.followTags set, add --no-follow-tags too." : ""} A tap cannot cover it: the tap names one branch.`;
var appWiderOptWhy = (dir, opt) => `${prose(opt)} makes this push write more than the branch it names (tags, other branches or submodule repos) in ${at(dir)}, so it stays blocked even with Dave's tap: a tap names one branch. ${opt.startsWith("-c ") ? "Run git push with no -c push setting" : "Push without that option"}, or ask Dave.`;
var appRawUnsafeWhy = (dir) => `this command holds a git push that is not one plain git push call, and a force or delete spelling is in its text (--force, --mirror, --delete, -f or -d in a short option bundle, a word that starts with +, a :branch delete, --all, --tags, --prune or --branches; folder ${at(dir)}), so it stays blocked even with Dave's tap. Run the push as its own command with no such word in it: git push <remote> <branch>. If a force push is really needed, ask Dave to run it himself.`;
var appUnreadWhy = (dir) => `this command holds a git push that this gate cannot read as one plain git push call (folder ${at(dir)}): a global option or an option it does not know, more than one -C, a shell -c, eval, a control word, a substitution or a git alias. To clear it, ${PUSH_WAY_OUT}, with no global option before push (git -C <folder> push is fine).`;
var unpairedWhy = (dir) => `a quote mark in this command has no pair (a message the gate cannot read as one string), so where its PR create or merge runs and the repo it names cannot be read (folder ${at(dir)}). Put the message in a file (git commit -F <file>, --body-file <file>) and run the gh call as its own command.`;
var appBundleWhy = (dir) => `a short option bundle with o (as in -oh or -uo) gives the rest of the word, or the next word, to the push option (folder ${at(dir)}), so the other flags of this push cannot be read: write -o <value> as its own word (git push -o <value> <remote> <branch>).`;
var appSubagentWhy = (dir) => `a subagent cannot push in ${at(dir)}: Dave's tap belongs to the main session. Ask the main session to do it.`;
var appManyHeadsWhy = (dir, heads) => `this create names more than one head (${prose(heads.join(", "))}) in ${at(dir)}; gh opens the PR from the last one, so the head its open-pr decision is for cannot be known. Name one head (gh pr create --head <branch>, or one -f head=<branch>).`;
var appHeadOwnerWhy = (dir, owner) => `this create names its head with the owner ${prose(owner)}: (in ${at(dir)}), so the PR would open from that owner's fork, and a tap from Dave covers only a branch of this checkout. Name the head with no owner: prefix (gh pr create --head <branch>), or ask Dave to open it.`;
var appHeadWhy = (dir) => `the head branch of this create cannot be named in ${at(dir)} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo folder on a branch.`;
var appManyBasesWhy = (dir, bases) => `this create names more than one base branch (${prose(bases.join(", "))}) in ${at(dir)}, so the base its open-pr decision is for cannot be known. Name one base (gh pr create --base <branch>, or one -f base=<branch>).`;
var appHeadReadWhy = (dir, branch) => `cannot read the head of ${prose(branch)} in ${at(dir)}, so its open-pr decision cannot be found. Run the command again from the repo folder.`;
var appRepoUnreadableWhy = (dir) => `the repo this command names is a variable (-R $R, GH_REPO=$X), so it cannot be compared with the repo of ${at(dir)}. Name the repo as owner/repo text.`;
var appRepoDiffersWhy = (deps, dir, named, key, offer) => `this command names ${prose(named)}, but no remote of ${at(dir)} fetches from it (the repo of the folder is ${key === null ? "not known: several remotes and no push target" : prose(key)}). Run it from the folder of the repo it names, or name the repo of one of its remotes. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appRepoUnnamedWhy = (deps, dir, offer, key) => `${at(dir)} has more than one remote, so gh may act on another repo than the tap names. Name the repo: -R ${key === null ? "<owner/repo>" : ghRepoArg(key)} for the branch's push target (@{push}), or the repo of another remote. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appPositionWhy = (deps, dir, offer) => `popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, and ${at(dir)} is judged for Dave's tap, so the folder this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd. ${askPart(deps, offer, dir, (c) => `The question for that folder: ${c}.`)}`;
var needsFieldLine = (entryKey, remote) => `the registry entry ${prose(entryKey)} needs a github field naming owner/repo (remote ${remoteProse(remote)} is an SSH host alias, so gh has no repo to act on); tell Dave.`;
var inAppFolder = (dir) => ` The command starts in ${at(dir)}, a folder judged for Dave's tap.`;
var corruptLine = (file) => `WARNING (decision-gate): the project registry ${prose(fwd(file))} cannot be read. Tell Dave.`;
var CORRUPT_EFFECT = "folders outside CCv3 were not checked for Dave's tap (nothing is covered while the file is missing)";
var registryCorruptWhy = (file, dir) => `the project registry ${prose(fwd(file))} exists but cannot be parsed (read twice), so this folder (${at(dir)}) cannot be checked for Dave's tap, and a push, PR create or merge outside CCv3 stays blocked. Fix the file (valid JSON with a projects list), or ask Dave.`;
var norm = (p) => p.replace(/\\/g, "/").toLowerCase();
var STORE_PATH_RE = /ccv3-mods\/decisions\.json(?:\.|$)/;
var STORE_TEXT_RE = /ccv3-mods\/+decisions\.json(?![\w-])/;
function dropAliasSuffix(p) {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1;
  const leaf = p.slice(cut).replace(/:.*$/s, "").replace(/([^. ])[. ]+$/, "$1");
  return p.slice(0, cut) + leaf;
}
function isStorePath(p, deps, cwd) {
  const full = norm(resolve3(cwd, dropAliasSuffix(p)));
  const store = norm(decisionsPath2(deps.env));
  return STORE_PATH_RE.test(full) || full === store || full.startsWith(`${store}.`);
}
var escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function readCopyRe(deps) {
  const store = escRe(norm(decisionsPath2(deps.env)));
  return new RegExp(`\\b(?:cp|copy|copy-item)\\s+(?:-(?:[frpavinu]{1,4}|-?(?:force|recurse|recursive|verbose|confirm|whatif))\\s+)*["']?(?:(?:[^\\s"';|&]*\\/)?ccv3-mods\\/+decisions\\.json|${store})["']?(?=\\s+[^\\s;|&])`, "gi");
}
var STORE_CODE_RE = /[\\/]lib[\\/]decisions\.mjs/i;
var STORE_FN_RE = /\b(?:decisionRecord|offerWrite|decisionUse|missBump)\b/;
var WRITE_SIGNAL_RE = /(?<![\d&])>|\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|tee|sed|mv|cp|rm|del|truncate|dd|ln)\b|\b(?:writeFile|appendFile|writeFileSync|rename)/i;
var CODE_SIGNAL_RE = /\bnode(?:\.exe)?\b[^|;&\n]*?(?:\s-e\b|\s--eval\b|\s-p\b|\s--print\b|--input-type)|\bimport\s*\(|\brequire\s*\(/i;
var READ_ONLY_CODE_RE = /\b(?:readFileSync|readFile)\s*\(|\brequire\s*\(\s*["'][^"']*decisions\.json["']\s*\)/;
var CODE_CAN_WRITE_RE = new RegExp([
  "write|append|copy|rename|unlink|\\brm|truncate|open|link|mkdir|chmod|chown|utimes|stream|child_process|spawn|exec|eval|\\bFunction\\b|import\\s*\\(|\\bflags?\\b|O_[A-Z]",
  "process\\.binding|decisions\\.mjs|decisionRecord|offerWrite|decisionUse|missBump|fetch|https?:",
  `\\brequire\\s*\\(\\s*(?!["'](?:(?:node:)?fs|[^"']*decisions\\.json)["']\\s*\\))`,
  "[\"'`]\\s*\\+|\\+\\s*[\"'`]|\\$\\{|\\[\\s*[\"'`]"
].join("|"), "i");
var USE_TAP_RE = /land-decision\.mjs["']?\s+["']?use\b/i;
var CHECKPOINT_RUN_RE = /pr-checkpoint\.mjs\b(?=[^\n]*--json)(?=[^\n]*--pr\b)/i;
var LOOP_RE = /\b(?:for|foreach|while|until|xargs|seq)\b|ForEach-Object|\d+\.\.\d+|%\s*\{/i;
function writesStoreText(text, deps) {
  if (USE_TAP_RE.test(text) || CHECKPOINT_RUN_RE.test(text) && LOOP_RE.test(text)) return true;
  const flat = text.replace(/\\/g, "/");
  const lower = norm(flat.replace(readCopyRe(deps), " "));
  const names = [lower, squashQuotes(lower)].some((t) => STORE_TEXT_RE.test(t)) || lower.includes(norm(decisionsPath2(deps.env)));
  const code = CODE_SIGNAL_RE.test(text);
  if (names || STORE_CODE_RE.test(text)) {
    if (WRITE_SIGNAL_RE.test(flat)) return true;
    if (!code) return false;
    return !(names && !STORE_CODE_RE.test(text) && READ_ONLY_CODE_RE.test(text) && !CODE_CAN_WRITE_RE.test(text));
  }
  return STORE_FN_RE.test(text) && code;
}
var NO_PRIOR = { repos: [], nonLiteral: false };
var scopeOf = (s) => s.kind === "push" ? "push" : "other";
var LAND_SCRIPT_RE = /\bland-pr\.ps1\b/i;
var LAND_PR_RE = /(?:^|\s)-P(?:r)?(?:\s+|:|=)["']?(\d+)\b/i;
var PR_NUMBER_IN_TEXT_RE = /-Pr?[\s:="']*\d/i;
var CLEANUP_RE = /(?:^|\s)-CleanupOnly\b/i;
var MERGE_CLI_RE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/i;
var MERGE_API_RE = /\bgh\s+api\b[^|;&\n]*\/pulls\/(\d+)\/merge\b[^|;&\n]*/i;
var GET_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))GET\b/i;
var SHA_RE = /(?:\bsha=|--match-head-commit(?:\s+|=))["']?([0-9a-f]{40})\b/i;
var SEGMENT_RE = /[;&|\r\n]+/;
var lastArg = (args, re) => re.exec(args)?.[1] ?? null;
function landShapesOf(seg, textOnly = false, rawSeg = seg, tail = rawSeg, pwsh = false) {
  const out3 = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out3.push({ kind: "land", pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  const opens = (m) => m !== null && GH_PREFIX_OK.test(tail.slice(0, m.index)) ? m : null;
  const rawCli = MERGE_CLI_RE.exec(rawSeg) ? opens(TAIL_CLI_RE.exec(tail)) : null;
  if (cli) out3.push({ kind: "merge", pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), ...rawCli ? cliMergeHead(rawCli[1], pwsh) : UNREAD_HEAD });
  const api = MERGE_API_RE.exec(seg);
  const rawApi = MERGE_API_RE.exec(rawSeg) ? opens(TAIL_API_RE.exec(tail)) : null;
  if (api && !GET_RE.test(api[0])) out3.push({ kind: "merge", pr: api[1], ...rawApi ? apiMergeHead(rawApi[0], pwsh) : UNREAD_HEAD });
  return out3;
}
var TAIL_CLI_RE = /\bgh\s+pr\s+merge\b([\s\S]*)$/i;
function quoteOpenAt(text, pos, pwsh) {
  const esc = pwsh ? "`" : "\\";
  let q = "";
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text[i];
    if (q === "'") {
      if (ch === "'") q = "";
      continue;
    }
    if (ch === esc) {
      i++;
      continue;
    }
    if (q === '"') {
      if (ch === '"') q = "";
      continue;
    }
    if (ch === "'" || ch === '"') q = ch;
  }
  return q !== "";
}
var GH_PREFIX_OK = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_\-./:]*\s+)*$/;
var TAIL_API_RE = /\bgh\s+api\b[\s\S]*$/i;
function rawTail(text) {
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&" && text[i + 1] === "&") return text.slice(0, i);
  }
  return text;
}
function pairedWords(text, pwsh = false) {
  const words = [];
  let cur = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (open) {
        words.push(cur);
        cur = "";
        open = false;
      }
      continue;
    }
    open = true;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += text.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (!pwsh && text[j] === "\\" && j + 1 < text.length) j++;
        cur += text[j];
      }
      if (j >= text.length) return null;
      i = j;
      continue;
    }
    if (!pwsh && ch === "\\" && i + 1 < text.length) {
      cur += text[++i];
      continue;
    }
    cur += ch;
  }
  if (open) words.push(cur);
  return words;
}
function unmodelled(text, pwsh = false) {
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && (QUOTE_CH.has(text[i - 1] ?? "") || QUOTE_CH.has(text[i + 1] ?? ""))) return true;
    if (q === "'") {
      if (ch === "'") q = "";
      else if (!QUOTED_OK.test(ch)) return true;
      continue;
    }
    if (q === '"') {
      if (ch === '"') q = "";
      else if (!QUOTED_OK.test(ch) || "$`".includes(ch) || ch === "\\" && !pwsh) return true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      continue;
    }
    if (ch === "@" && i > 0 && !/[ \t]/.test(text[i - 1])) continue;
    if (ch === "\\" && pwsh) continue;
    if (!BARE_OK.test(ch)) return true;
  }
  return false;
}
var QUOTE_CH = /* @__PURE__ */ new Set(["'", '"']);
var BARE_OK = /^[A-Za-z0-9 \t\-_./=:]$/;
var QUOTED_OK = /^[\x20-\x7E\n]$/;
var UNREAD_HEAD = { sha: null, shaBad: true };
var HEAD_UNREAD_WHY = (pr) => `the merge head cannot be read as gh reads it: two head values, a value that is not a literal 40-hex sha, a flag this gate does not know, an unpaired quote, or a character this gate cannot read the same way in bash and PowerShell. Name the head once: gh pr merge ${pr && /^\d+$/.test(pr) ? pr : "<n>"} --match-head-commit <sha>, or gh api .../merge -f sha=<sha>. ${PLAIN_WAY_OUT}`;
var PLAIN_WAY_OUT = "For a redirect: run the call with no redirect. For a $ variable or $(...): put the value in the command as plain text or use a body file.";
var HEX40 = /^[0-9a-f]{40}$/i;
function oneHead(values) {
  if (values.some((v) => !HEX40.test(v))) return { sha: null, shaBad: true };
  const set = new Set(values.map((v) => v.toLowerCase()));
  if (set.size > 1) return { sha: null, shaBad: true };
  return { sha: [...set][0] ?? null };
}
var MERGE_BOOL = /* @__PURE__ */ new Set(["--merge", "-m", "--squash", "-s", "--rebase", "-r", "--auto", "--disable-auto", "--admin", "--delete-branch", "-d"]);
var MERGE_VALUE = /* @__PURE__ */ new Set(["--body", "-b", "--body-file", "-F", "--subject", "-t", "--author-email", "-A", "--match-head-commit", "--repo", "-R"]);
var SHORT_BOOL = "msrd";
var SHORT_VALUE = "bFtAR";
function shortCluster(w, next) {
  return clusterOf(w, next, SHORT_BOOL, SHORT_VALUE)?.used ?? null;
}
function clusterOf(w, next, bools, values) {
  const letters = w.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const ch = letters[k];
    if (bools.includes(ch)) continue;
    if (!values.includes(ch)) return null;
    if (k < letters.length - 1) return { used: 0, letter: ch, value: letters.slice(k + 1) };
    return next === void 0 ? null : { used: 1, letter: ch, value: next };
  }
  return { used: 0, letter: null, value: null };
}
function cliMergeHead(args, pwsh = false) {
  if (unmodelled(args, pwsh)) return UNREAD_HEAD;
  const words = pairedWords(args, pwsh);
  if (words === null) return UNREAD_HEAD;
  return cliHeadOfWords(words);
}
function cliHeadOfWords(words) {
  const heads = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-") || w === "-") continue;
    if (/^-[A-Za-z]{2,}/.test(w)) {
      const used = shortCluster(w, words[i + 1]);
      if (used === null) return UNREAD_HEAD;
      i += used;
      continue;
    }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (MERGE_BOOL.has(name) && eq < 0) continue;
    if (!MERGE_VALUE.has(name)) return { sha: null, shaBad: true };
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === void 0) return { sha: null, shaBad: true };
    if (name === "--match-head-commit") heads.push(value);
  }
  return oneHead(heads);
}
var API_FIELD = /^(?:-f|-F|--raw-field|--field)$/;
var API_FIELD_EQ = /^(?:--raw-field|--field)=(.*)$/s;
var API_VALUE = /* @__PURE__ */ new Set(["-X", "--method", "-H", "--header", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);
function apiWord(w, next, endpointSeen) {
  if (w === "--input" || w.startsWith("--input=")) return { bad: "--input (the body comes from a file)" };
  if (API_FIELD.test(w)) return next === void 0 ? { bad: "a field flag with no value" } : { field: next, used: 1 };
  if (API_FIELD_EQ.test(w)) return { field: API_FIELD_EQ.exec(w)[1], used: 0 };
  if (/^-[fF][^=]/.test(w)) return { field: w.slice(2), used: 0 };
  if (API_VALUE.has(w)) return next === void 0 ? { bad: `${w} with no value` } : { field: null, used: 1 };
  if (/^--(?:method|hostname|header|jq|template|cache|preview)=/.test(w) || /^-X./.test(w) || API_BOOL.has(w)) return { field: null, used: 0 };
  if (!w.startsWith("-") && !endpointSeen) return { field: null, used: -1 };
  return { bad: `a word this gate does not know on the api call (${w})` };
}
function apiMergeHead(text, pwsh = false) {
  const rest = text.replace(/^[\s\S]*?\bapi\b/, "");
  if (unmodelled(rest.replace(/\{(?:owner|repo|branch)\}/g, "x"), pwsh)) return UNREAD_HEAD;
  const words = pairedWords(rest, pwsh);
  if (words === null) return UNREAD_HEAD;
  return apiHeadOfWords(words);
}
function apiHeadOfWords(words) {
  const heads = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord(words[i], words[i + 1], endpoint);
    if ("bad" in r) return UNREAD_HEAD;
    if (r.used === -1) {
      endpoint = true;
      continue;
    }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf("=");
    if (eq > 0 && r.field.slice(0, eq) === "sha") heads.push(r.field.slice(eq + 1));
  }
  return oneHead(heads);
}
var API_MERGE_PATH = /\/pulls\/(\d+)\/merge\b/i;
function mergeCallOf(call) {
  const w = call.words;
  if (w.length < 3 || progName(w[0].lit) !== "gh") return null;
  const sub = (i) => (w[i]?.lit ?? "").toLowerCase();
  const at2 = call.cwdBefore ?? [];
  const text = w.map((x) => x.raw).join(" ");
  if (sub(1) === "pr" && sub(2) === "merge") {
    const args = w.slice(3);
    if (args.some((a) => a.lit === null)) return { pr: prOfWords(args), ...UNREAD_HEAD, cwdBefore: at2, text };
    return { pr: prOfWords(args), ...cliHeadOfWords(args.map((a) => a.lit)), cwdBefore: at2, text };
  }
  if (sub(1) === "api") {
    const args = w.slice(2);
    const endpoint = args.find((a) => API_MERGE_PATH.test(a.lit ?? a.raw));
    if (!endpoint) return null;
    const lits = args.map((a) => a.lit);
    if (lits.some((l, i) => (l === "-X" || l === "--method") && /^GET$/i.test(lits[i + 1] ?? "")) || lits.some((l) => /^(?:-XGET|--method=GET)$/i.test(l ?? ""))) return null;
    const pr = API_MERGE_PATH.exec(endpoint.lit ?? endpoint.raw)[1];
    if (endpoint.lit === null || args.some((a) => a.lit === null && a !== endpoint)) return { pr, ...UNREAD_HEAD, cwdBefore: at2, text };
    return { pr, ...apiHeadOfWords(lits.map((l) => l)), cwdBefore: at2, text };
  }
  return null;
}
function prOfWords(args) {
  for (let i = 0; i < args.length; i++) {
    const l = args[i].lit ?? "";
    if (/^\d+$/.test(l) && !MERGE_VALUE.has(args[i - 1]?.lit ?? "")) return l;
  }
  for (const a of args) {
    const m = /\/pull\/(\d+)/.exec(a.lit ?? "");
    if (m) return m[1];
  }
  return null;
}
function astMerges(parsed) {
  if (!parsed) return [];
  return Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : []).flatMap((c) => {
    const m = mergeCallOf(c);
    return m ? [m] : [];
  });
}
function namesOtherRepo(m, pwsh) {
  const r = commandRepo(m.text, maskQuoted(m.text, pwsh ? "PowerShell" : "Bash"), {}, []);
  return r !== null && r !== CCV3_REPO;
}
function withAstMerges(shapes, parsed, pwsh) {
  if (!parsed || Object.values(parsed.byDialect).some((r) => r === void 0 || r.errors.length > 0)) return shapes;
  const found = astMerges(parsed);
  if (found.length === 0) return shapes;
  const heads = (pr) => {
    const hs = found.filter((m) => m.pr === pr);
    if (hs.length === 0) return null;
    const first = hs[0];
    return hs.every((m) => m.sha === first.sha && !m.shaBad === !first.shaBad) ? { sha: first.sha, ...first.shaBad ? { shaBad: true } : {} } : UNREAD_HEAD;
  };
  const out3 = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (s) => {
    const id = `${s.kind}|${s.pr}|${s.sha}${s.shaBad ? "!" : ""}|${s.at ? whereId(s.at) : ""}|${s.ftext ?? s.text ?? ""}${s.prior ? priorId(s.prior) : ""}`;
    if (!seen.has(id)) {
      seen.add(id);
      out3.push(s);
    }
  };
  const own = (s) => {
    const cands = found.filter((m) => m.pr === s.pr && namesOtherRepo(m, pwsh));
    const shapeText = squashed(s.ftext ?? s.text ?? "");
    return cands.find((m) => shapeText.includes(squashed(m.text))) ?? cands[0];
  };
  for (const s of shapes) {
    if (s.kind !== "merge") {
      out3.push(s);
      continue;
    }
    const h = heads(s.pr);
    if (!h) {
      push(s);
      continue;
    }
    const { shaBad: _drop, ...rest } = s;
    const o = own(s);
    push({ ...rest, sha: h.sha, ...h.shaBad ? { shaBad: true } : {}, ...o ? { ftext: o.text, fmtext: maskQuoted(o.text, pwsh ? "PowerShell" : "Bash") } : {} });
  }
  for (const m of found) {
    if (shapes.some((s) => s.kind === "merge" && s.pr === m.pr)) continue;
    const cds = m.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted(m.text, pwsh ? "PowerShell" : "Bash");
    push({ kind: "merge", pr: m.pr, sha: m.sha, ...m.shaBad ? { shaBad: true } : {}, at: { cds, unknown: m.cwdBefore.includes(null), loose: cds.length > 0 || m.cwdBefore.includes(null) }, text: m.text, mtext: masked, ftext: m.text, fmtext: masked, prior: NO_PRIOR, pwsh });
  }
  return out3;
}
var SAFE_CREATE_VALUE = /* @__PURE__ */ new Set(["--title", "-t", "--body", "-b", "--body-file", "-F", "--label", "-l", "--assignee", "-a", "--reviewer", "-r", "--milestone", "-m", "--project", "-p", "--template", "-T", "--recover"]);
var SAFE_API_KEY = /* @__PURE__ */ new Set(["title", "body", "draft", "maintainer_can_modify"]);
var API_PULLS_PATH = /\/pulls\/?(?:\?.*)?$/i;
var NOT_LITERAL_WORD = "a word that is not a literal (a variable or a substitution outside a title or body value)";
function createCallOf(call) {
  const w = call.words;
  if (w.length < 3 || progName(w[0].lit) !== "gh") return null;
  const sub = (i) => (w[i]?.lit ?? "").toLowerCase();
  const cwdBefore = call.cwdBefore ?? [];
  const text = w.map((x) => x.raw).join(" ");
  if (sub(1) === "pr" && (sub(2) === "create" || sub(2) === "new")) {
    if (w.some((x) => x.raw.includes("<<"))) return { read: BAD("a heredoc in a title or body makes the head and base unreadable"), cwdBefore, text };
    const lits2 = [];
    for (const a of w.slice(3)) {
      if (a.lit !== null) {
        lits2.push(a.lit);
        continue;
      }
      const eq = /^(--[a-z-]+)="/.exec(a.raw)?.[1];
      if (eq && SAFE_CREATE_VALUE.has(eq)) {
        lits2.push(`${eq}=x`);
        continue;
      }
      if (a.raw.startsWith('"') && SAFE_CREATE_VALUE.has(lits2[lits2.length - 1] ?? "")) {
        lits2.push("x");
        continue;
      }
      return { read: BAD(NOT_LITERAL_WORD), cwdBefore, text };
    }
    return { read: cliCreateOfWords(lits2), cwdBefore, text };
  }
  if (sub(1) !== "api") return null;
  const args = w.slice(2);
  const valueFlag = (l) => l != null && (API_FIELD.test(l) || API_VALUE.has(l));
  const endpoint = args.find((a, i) => a.lit !== null && !a.lit.startsWith("-") && !valueFlag(args[i - 1]?.lit));
  if (!endpoint || !API_PULLS_PATH.test(endpoint.lit)) return null;
  const flags = args.map((a) => a.lit ?? "");
  const post = flags.some((l, i) => /^(?:-X|--method)$/i.test(l) && /^POST$/i.test(flags[i + 1] ?? "") || /^(?:-XPOST|--method=POST)$/i.test(l));
  const anyMethod = flags.some((l) => /^(?:-X|--method)/i.test(l));
  const field = flags.some((l) => /^(?:-[fF]|--(?:raw-field|field|input))/.test(l));
  if (!post && !(field && !anyMethod)) return null;
  const lits = [];
  for (const a of args) {
    if (a.lit !== null) {
      lits.push(a.lit);
      continue;
    }
    const key = /^((?:-[fF]|--(?:raw-field|field)=)?([A-Za-z_]+))="/.exec(a.raw);
    if (key && SAFE_API_KEY.has(key[2])) {
      lits.push(`${key[1]}=x`);
      continue;
    }
    return { read: BAD(NOT_LITERAL_WORD), cwdBefore, text };
  }
  return { read: apiCreateOfWords(lits), cwdBefore, text };
}
function astCreates(parsed) {
  if (!parsed) return [];
  return Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : []).flatMap((c) => {
    const m = createCallOf(c);
    return m ? [m] : [];
  });
}
var squashed = (t) => t.replace(/[\s"'\\`]/g, "");
function withAstCreates(shapes, parsed, pwsh) {
  if (!parsed || Object.values(parsed.byDialect).some((r) => r === void 0 || r.errors.length > 0)) return shapes;
  const found = astCreates(parsed);
  if (found.length === 0) return shapes;
  const tails = [...new Set(shapes.filter((s) => s.kind === "create").map((s) => squashed(s.tail ?? s.text ?? "")))];
  const pairs = tails.map((t) => found.filter((f) => t.includes(squashed(f.text))));
  const paired = tails.length === found.length && pairs.every((p) => p.length === 1) && new Set(pairs.map((p) => p[0])).size === found.length;
  if (paired) {
    const byTail = new Map(tails.map((t, i) => [t, pairs[i][0].read]));
    return shapes.map((s) => s.kind === "create" ? { ...s, read: byTail.get(squashed(s.tail ?? s.text ?? "")) } : s);
  }
  const extra = found.map((f) => {
    const cds = f.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted(f.text, pwsh ? "PowerShell" : "Bash");
    return { kind: "create", pr: null, at: { cds, unknown: f.cwdBefore.includes(null), loose: cds.length > 0 || f.cwdBefore.includes(null) }, text: f.text, mtext: masked, ftext: f.text, fmtext: masked, prior: NO_PRIOR, tail: f.text, pwsh, read: f.read };
  });
  return [...shapes, ...extra];
}
function astLandCalls(parsed, raw, exempt, gate) {
  if (!parsed || exempt || !LAND_SCRIPT_RE.test(raw) || !LAND_SCRIPT_RE.test(gate)) return [];
  const out3 = [];
  for (const c of Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : [])) {
    const text = [...c.words.map((w) => w.raw), ...c.stdin?.lit ? [c.stdin.lit] : []].join(" ");
    if (!LAND_SCRIPT_RE.test(text) || CLEANUP_RE.test(text)) continue;
    out3.push({ text, pr: lastArg(text, LAND_PR_RE), sha: SHA_RE.exec(text)?.[1]?.toLowerCase() ?? null, cwdBefore: c.cwdBefore ?? [] });
  }
  if (out3.length === 0 && !CLEANUP_RE.test(raw)) out3.push({ text: raw, pr: lastArg(raw, LAND_PR_RE), sha: SHA_RE.exec(raw)?.[1]?.toLowerCase() ?? null, cwdBefore: [] });
  return out3;
}
function astLandShapes(parsed, raw, exempt, gate, pwsh) {
  return astLandCalls(parsed, raw, exempt, gate).map((l) => {
    const cds = l.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted(l.text, pwsh ? "PowerShell" : "Bash");
    return { kind: "land", pr: l.pr, sha: l.sha, at: { cds, unknown: l.cwdBefore.includes(null), loose: cds.length > 0 || l.cwdBefore.includes(null) }, text: l.text, mtext: masked, ftext: l.text, fmtext: masked, prior: NO_PRIOR, pwsh };
  });
}
var DATA_READERS = /* @__PURE__ */ new Set(["echo", "printf", "write-host", "write-output", "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "select-string", "sls", "get-content", "gc"]);
function onlyDataReaders(parsed) {
  const rs = Object.values(parsed.byDialect).filter((r) => r !== void 0);
  return rs.length > 0 && rs.every((r) => r.ok && r.errors.length === 0 && r.calls.length > 0 && !hasBareRedirect(parsed.text, r) && r.calls.every((c) => c.assigns.length === 0 && c.words[0]?.lit != null && c.words[0].lit === c.words[0].raw && DATA_READERS.has(c.words[0].lit.toLowerCase())));
}
function astItemsOf(parsed, raw, exempt, text) {
  if (!parsed) return [];
  const foundMerges = astMerges(parsed);
  const foundCreates = astCreates(parsed);
  const merges = foundMerges.map((m) => ({ sq: squashed(m.text), shape: { kind: "merge", pr: m.pr, sha: m.sha, ...m.shaBad ? { shaBad: true } : {} } }));
  const creates = foundCreates.map((c) => ({ sq: squashed(c.text), create: true, read: c.read }));
  const lands = astLandCalls(parsed, raw, exempt, text).map((l) => ({ sq: squashed(l.text), shape: { kind: "land", pr: l.pr, sha: l.sha } }));
  const extra = [];
  const mergeWords = [...text.matchAll(/\bgh\s+pr\s+merge\b[^|;&\n]*/gi)];
  if (mergeWords.length > foundMerges.length && !onlyDataReaders(parsed)) {
    for (const m of mergeWords.slice(foundMerges.length)) extra.push({ sq: squashed(m[0]), shape: { kind: "merge", pr: lastArg(m[0], /(?:^|\s)["']?(\d+)(?=\s|["']|$)/), ...UNREAD_HEAD } });
  }
  const api = MERGE_API_RE.exec(text);
  if (api && !GET_RE.test(api[0]) && !foundMerges.some((m) => m.pr === api[1])) extra.push({ sq: squashed(api[0]), shape: { kind: "merge", pr: api[1], ...UNREAD_HEAD } });
  const createWords = [...text.matchAll(/\bgh\s+pr\s+(?:create|new)\b[^|;&\n]*/gi)];
  for (const c of createWords.slice(foundCreates.length)) extra.push({ sq: squashed(c[0]), create: true, read: BAD("a wrapper program, a split word or a payload runs gh, so its head and base cannot be read") });
  return [...merges, ...creates, ...lands, ...extra].filter((i) => i.sq !== "");
}
var DOC_APPEND_CMDS = /* @__PURE__ */ new Set(["add-content", "set-content", "ac", "sc"]);
var DOC_TARGET_EXT = /\.(?:md|txt|log)$/i;
var DOC_ODD_CHAR = /[\u2013-\u2015\u2018-\u201F\0\v\f\x85\u2028\u2029]/u;
function hasBareRedirect(text, r) {
  const inside = (i) => [...r.quoted, ...r.bodies].some(([from, to]) => i >= from && i < to);
  for (let i = 0; i < text.length; i++) if ((text[i] === ">" || text[i] === "<") && !inside(i)) return true;
  return false;
}
function docTargetOk(w) {
  const t = w?.lit;
  if (t == null || t !== t.trim() || !DOC_TARGET_EXT.test(t) || /[*?[\],]/.test(t)) return false;
  if (t.replace(/^[A-Za-z]:(?=[\\/])/, "").includes(":")) return false;
  return !t.split(/[\\/]/).includes("..");
}
function docAppendCall(c) {
  if (c.depth !== 0 || c.level !== 0 || c.nested || c.func || c.place.pipe || c.place.background) return false;
  if (!DOC_APPEND_CMDS.has((c.words[0]?.lit ?? "").toLowerCase())) return false;
  let target;
  let value;
  const args = c.words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const l = args[i].lit;
    if (l === null) {
      if (target === void 0) target = args[i];
      else if (value === void 0) value = args[i];
      else return false;
      continue;
    }
    if (/^-(?:literalpath|path)$/i.test(l)) {
      if (target !== void 0 || i + 1 >= args.length) return false;
      target = args[++i];
      continue;
    }
    if (/^-value$/i.test(l)) {
      if (value !== void 0 || i + 1 >= args.length) return false;
      value = args[++i];
      continue;
    }
    if (l.startsWith("-")) return false;
    if (target === void 0) target = args[i];
    else if (value === void 0) value = args[i];
    else return false;
  }
  return docTargetOk(target) && value !== void 0 && value.lit !== null && value.viaVar === void 0;
}
function docAppendByAst(parsed, tool, raw) {
  if (tool !== "PowerShell" || !parsed || DOC_ODD_CHAR.test(raw)) return false;
  const dialects = Object.keys(parsed.byDialect);
  const r = parsed.byDialect.pwsh;
  if (dialects.length !== 1 || !r || r.errors.length > 0 || r.calls.length === 0) return false;
  return !hasBareRedirect(parsed.text, r) && r.calls.every(docAppendCall);
}
var SCRIPT_RUNNERS = /* @__PURE__ */ new Set(["node", "nodejs", "python", "python3", "py", "deno", "bun", "ruby", "perl", "tsx", "ts-node", "php"]);
var GUARDED_TEXT = /\bgit\s+(?:-\S+\s+\S+\s+)*push\b|\bgit\s+(?:[^;&|\n]*\s)?push\b|\bgit\b[^\n]*\bpush\b|\bgh\s+pr\s+(?:create|new|merge)\b|\bgh\s+api\b[^\n]*\/(?:pulls|merge)\b|\bland-pr\.ps1\b/i;
var SCRIPT_RUNNER_WHY = "this runs code inline (node -e, python -c or a heredoc) whose text names a guarded call (a push, a create or a merge). This gate does not read JavaScript or Python, so it cannot tell whether the code runs the call or only holds the text (Dave R1). Put the code in a script file and run the file (node scripts/<name>.mjs), or take the guarded text out of the code.";
var SCRIPT_RUNNER_WORD = new RegExp(`\\b(?:${[...SCRIPT_RUNNERS].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
var blankQuotes = (t) => t.replace(/['"`,[\]()]/g, " ");
function scriptRunnerDenies(parsed) {
  if (!parsed) return [];
  for (const r of Object.values(parsed.byDialect)) {
    if (r && (!r.ok || r.errors.length > 0)) {
      const t = blankQuotes(parsed.text);
      if (SCRIPT_RUNNER_WORD.test(t) && GUARDED_TEXT.test(t)) return [deny("script-runner", SCRIPT_RUNNER_WHY)];
    }
    for (const c of r ? r.calls : []) {
      if (!SCRIPT_RUNNERS.has(progName(c.words[0]?.lit) ?? "")) continue;
      const code = blankQuotes([...c.words.slice(1).map((a) => a.lit ?? a.raw), c.stdin?.lit ?? ""].join(" "));
      if (GUARDED_TEXT.test(code)) return [deny("script-runner", SCRIPT_RUNNER_WHY)];
    }
  }
  return [];
}
function scriptRunnerLateDenies(text) {
  if (text === void 0) return [];
  const t = blankQuotes(text);
  return SCRIPT_RUNNER_WORD.test(t) && GUARDED_TEXT.test(t) ? [deny("script-runner", SCRIPT_RUNNER_WHY)] : [];
}
var PARSE_ERROR_WHY = "this text does not parse as shell (an unclosed quote, brace or parenthesis, or a stray ;; or &&), and it holds a guarded call (a push, a create or a merge), so this gate cannot tell which call runs or where. Fix the syntax and run it again.";
var SHELL_PROGRAMS = { bash: "bash", sh: "bash", dash: "bash", zsh: "bash", pwsh: "pwsh", powershell: "pwsh" };
function parseErrorDenies(parsed) {
  if (!parsed) return [];
  const results = Object.values(parsed.byDialect).filter((r) => r !== void 0);
  if (results.length === 0) return [];
  const failed = results.every((r) => !r.ok || r.errors.length > 0);
  if (!failed && parsed.innerBad !== true) return [];
  return GUARDED_TEXT.test(blankQuotes(parsed.text)) ? [deny("parse-error", PARSE_ERROR_WHY)] : [];
}
async function innerTextBad(byDialect, opts) {
  for (const r of Object.values(byDialect)) {
    for (const c of r ? r.calls : []) {
      const dialect = SHELL_PROGRAMS[progName(c.words[0]?.lit) ?? ""];
      if (!dialect) continue;
      for (const a of c.words.slice(1)) {
        if (!a.lit || !GUARDED_TEXT.test(blankQuotes(a.lit))) continue;
        const inner = await parseCalls(a.lit, dialect, opts);
        if (!inner.ok || inner.errors.length > 0) return true;
      }
    }
  }
  return false;
}
var WRAPPERS = String.raw`(?:env(?:\s+(?:-[uCS]\s+\S+|-\S+|\w+=\S*))*|nice(?:\s+-\S+(?:\s+\d+)?)*|timeout(?:\s+-\S+(?:\s+[A-Z0-9]+)?)*\s+[\d.]+[smhd]?|xargs(?:\s+-\S+(?:\s+(?:\d+|\{\}))?)*|setsid(?:\s+-\S+)*|sudo(?:\s+-\S+(?:\s+\w+)?)*)\s+`;
var PUSH_GIT = new RegExp(String.raw`(${CALL_START}(?:${WRAPPERS})*)(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+push)(?=\s|$)`, "g");
var PUSH_WRAPPERS = "git-(?:safe|for)";
var abbr = (name, min) => name.slice(0, min) + [...name.slice(min)].reduceRight((acc, ch) => `(?:${ch}${acc})?`, "");
var GIT_FOR_OPTS = String.raw`-(?:${abbr("Path", 2)}|${abbr("Remote", 1)})(?::|\s+)${VAL}|-(?:${abbr("WhichAccount", 2)}|${abbr("UseGitSafe", 1)})(?=\s)|`;
var PUSH_SAFE = safeCallRe("push", PUSH_WRAPPERS, GIT_FOR_OPTS, "gi");
var ARGS_END_RE = /[;&|\r\n)}]/;
var DIR_OPT_RE = new RegExp(String.raw`(?:^|\s)-C\s+(${VAL})`, "g");
var PATH_OPT_RE = new RegExp(String.raw`(?:^|\s)-${abbr("Path", 2)}(?::|\s+)(${VAL})`, "gi");
var MOVE_OPT_RE = /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/;
var REDIRECT_RE = /(?:^|\s)\d*[<>]+\S*/g;
var VALUE_OPTS = /* @__PURE__ */ new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
var FORCE_LONG = /^--(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|tags|delete|prune)(?:=.*)?$/;
var PUSH_KINDS = [[PUSH_GIT, isGitToken], [PUSH_SAFE, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
function pushCallsOf(masked, raw, atStart, before = { cds: [], unknown: false, loose: false }, cutView = masked, kinds = PUSH_KINDS) {
  const calls = [];
  for (const [re, valid] of kinds) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index + m[1].length;
      if (!valid(raw.slice(tokenStart, tokenStart + m[2].length))) continue;
      if (atStart && masked.slice(0, m.index).trim() !== "") continue;
      const optsStart = tokenStart + m[2].length;
      const end = m.index + m[0].length;
      const cut = cutView.slice(end).search(ARGS_END_RE);
      const own = cdsBefore(masked.slice(0, tokenStart), raw.slice(0, tokenStart));
      calls.push({
        opts: raw.slice(optsStart, optsStart + m[3].length),
        args: raw.slice(end, cut < 0 ? raw.length : end + cut),
        cds: [...before.cds, ...own.cds],
        loose: before.loose || own.loose,
        unknown: before.unknown || own.unknown,
        lead: raw.slice(m.index, tokenStart),
        token: raw.slice(tokenStart, optsStart),
        squashed: atStart
      });
    }
  }
  return calls;
}
var HEREDOC_OPEN = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/g;
var HERESTRING_OPEN = /@(['"])[ \t]*\r?\n/g;
var DATA_CMD = /^(?:[^\s;&|()`'"]*[\\/])?(?:git|gh)(?:\.exe)?$/i;
var INNER_CAT = /^cat$/;
var RUNS_IN_BODY = /\$\(|`/;
var blankChars = (s) => s.replace(/[^\r\n]/g, " ");
var firstWord = (t) => t.trim().split(/\s+/)[0] ?? "";
function outsideQuotes(t, tool) {
  let rest = t;
  for (const [s, e] of quotedSpans(t, tool)) rest = rest.slice(0, s) + " ".repeat(e - s) + rest.slice(e);
  return rest.replace(tool === "PowerShell" ? /`[\s\S]/g : /\\[\s\S]/g, "  ");
}
var quoteLeft = (t, tool) => /["']/.test(outsideQuotes(t, tool));
function opensData(text, at2, tool) {
  const lead = text.slice(0, at2);
  const bare = outsideQuotes(lead, tool);
  const segStart = Math.max(...["\n", ";", "&", "|"].map((c) => bare.lastIndexOf(c))) + 1;
  const seg = bare.slice(segStart);
  if (!DATA_CMD.test(firstWord(seg))) return false;
  const sub = seg.lastIndexOf("$(");
  if (sub < 0 || seg.includes(")", sub)) return !quoteLeft(lead, tool);
  const inner = seg.slice(sub + 2);
  return INNER_CAT.test(firstWord(inner)) && !quoteLeft(lead.slice(0, segStart + sub).replace(/"$/, ""), tool) && !quoteLeft(inner, tool);
}
function closingLine(text, from, ends) {
  for (let pos = from; pos <= text.length; ) {
    const eol = text.indexOf("\n", pos);
    if (ends(text.slice(pos, eol < 0 ? text.length : eol).replace(/\r$/, ""))) return pos;
    if (eol < 0) return -1;
    pos = eol + 1;
  }
  return -1;
}
function blankHeredocs(text) {
  let out3 = text;
  let next = 0;
  for (const m of text.matchAll(HEREDOC_OPEN)) {
    if (m.index < next) continue;
    const nl = text.indexOf("\n", m.index + m[0].length);
    if (nl < 0) break;
    const start = Math.max(nl + 1, next);
    const delim = m[2] ?? m[3] ?? m[5];
    const end = closingLine(text, start, (line) => (m[1] === "-" ? line.replace(/^\t+/, "") : line) === delim);
    if (end < 0) break;
    const quoted = m[5] === void 0 || m[4] === "\\";
    const rest = text.slice(m.index + m[0].length, nl).replace(/\r$/, "");
    const plainLine = !rest.includes("|") && !rest.endsWith("\\") && !quoteLeft(rest, "Bash");
    if (plainLine && opensData(out3, m.index, "Bash") && (quoted || !RUNS_IN_BODY.test(text.slice(start, end)))) out3 = out3.slice(0, start) + blankChars(text.slice(start, end)) + out3.slice(end);
    const eol = text.indexOf("\n", end);
    next = eol < 0 ? text.length : eol + 1;
  }
  return out3;
}
function blankHereStrings(text) {
  let out3 = text;
  let next = 0;
  for (const m of text.matchAll(HERESTRING_OPEN)) {
    if (m.index < next) continue;
    const start = m.index + m[0].length;
    const end = closingLine(text, start, (line) => line.trimStart().startsWith(`${m[1]}@`));
    if (end < 0) break;
    const closedAtStart = text.startsWith(`${m[1]}@`, end);
    const body = text.slice(start, end);
    if (closedAtStart && opensData(out3, m.index, "PowerShell") && (m[1] === "'" || !RUNS_IN_BODY.test(body))) out3 = out3.slice(0, start) + blankChars(body) + out3.slice(end);
    next = end + 2;
  }
  return out3;
}
function blankBodies(text, tool) {
  if (tool === "Bash") return text.includes("<<") ? blankHeredocs(text) : text;
  if (tool === "PowerShell") return text.includes("@") ? blankHereStrings(text) : text;
  return text;
}
function readCommand(input) {
  const cmd = readShellCommand(input);
  return cmd.kind === "command" ? { ...cmd, text: blankBodies(cmd.text, cmd.tool) } : cmd;
}
function dropComments(view, tool) {
  let out3 = view;
  for (let from = 0; ; ) {
    const spans = quotedSpans(out3, tool);
    const re = /(^|[\s;&|(])#[^\n]*/g;
    re.lastIndex = from;
    let hit = null;
    for (let m = re.exec(out3); m !== null && hit === null; m = re.exec(out3)) {
      const at2 = m.index + m[1].length;
      const end = m.index + m[0].length;
      if (!spans.some(([s, e]) => at2 > s && at2 < e) && !/["']/.test(out3.slice(end))) hit = { at: at2, end };
    }
    if (hit === null) return out3;
    out3 = out3.slice(0, hit.at) + " ".repeat(hit.end - hit.at) + out3.slice(hit.end);
    from = hit.end;
  }
}
function hiddenPieces(raw, tool) {
  const tools = tool === "Bash" || tool === "PowerShell" ? [tool] : ["Bash", "PowerShell"];
  return tools.flatMap((t) => {
    const view = dropComments(joinContinuations(raw, t === "PowerShell" ? "pwsh" : "bash"), t);
    if (!quoteLeft(view, t)) return [];
    return quotedSpans(view, t).flatMap(([s, e]) => view.slice(s + 1, e - 1).split(/[;&|\r\n(]+/).slice(1));
  });
}
var RUNNER_WORD = /^(?:[^\s'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1)$/i;
var LEAD_WORD = /^(?:then|do|else|\{|!|sudo|env|nice|nohup|time|timeout|xargs|setsid|-\S*|\d+[smhd]?|[A-Za-z_]\w*=\S*)$/;
var programOf = (p) => p.trim().split(/\s+/).find((w) => !LEAD_WORD.test(w)) ?? "";
var hiddenPush = (p) => RUNNER_WORD.test(programOf(p)) && holdsGitPush(p);
var hiddenGh = (p) => {
  const t = squashMarks(p);
  return /^(?:[^\s]*[\\/])?gh(?:\.exe)?$/i.test(programOf(t)) && (/\bpr\s+(?:create|new|merge)\b/i.test(t) || /\bapi\b[\s\S]*\b(?:pulls|merge)\b/i.test(t));
};
var wideSpelled = (s) => squashMarks(s).split(/[\s;&|(){}<>]+/).some((w) => /^--(?:all|tags|prune|branches)$/i.test(w) || /^:[^:\s]/.test(w));
var hardSpelled = (s) => forceSpelled(s) || wideSpelled(s);
var quotesToBreaks = (view) => view.replace(/["']/g, ";");
var quotesToSpaces = (view) => view.replace(/["']/g, " ");
var PLAIN_QUOTED_CD = /(^|[;&|\r\n(]\s*)((?:cd|chdir)\s+)"(?![A-Za-z]:)([^\s"'%$`^()&|;<>\r\n]+)"(?=\s*(?:$|[;&|\r\n)]))/gi;
var plainCdUnquoted = (view) => {
  if (view.includes("^")) return view;
  return view.replace(PLAIN_QUOTED_CD, (match, lead, cd, path4, offset) => {
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path4} ` : match;
  });
};
function pushCallsIn(raw, cmdExe = false, kinds = PUSH_KINDS) {
  const bash = joinContinuations(raw, "bash");
  const pwsh = joinContinuations(raw, "pwsh");
  const maskedBash = maskQuoted(bash, "Bash");
  const maskedPwshOnBash = maskQuoted(bash, "PowerShell");
  const maskedPwsh = maskQuoted(pwsh, "PowerShell");
  const calls = [...pushCallsOf(maskedBash, bash, false, void 0, maskedBash, kinds), ...pushCallsOf(maskedPwsh, pwsh, false, void 0, maskedPwsh, kinds)];
  if (cmdExe) {
    const cmdBash = plainCdUnquoted(bash);
    const cmdPwsh = plainCdUnquoted(pwsh);
    for (const view of [quotesToBreaks, quotesToSpaces]) {
      if (maskedBash !== bash) calls.push(...pushCallsOf(view(cmdBash), cmdBash, false, void 0, cmdBash, kinds));
      if (maskedPwsh !== pwsh) calls.push(...pushCallsOf(view(cmdPwsh), cmdPwsh, false, void 0, cmdPwsh, kinds));
    }
  }
  let from = 0;
  const breaks = [...maskedBash.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const [start, next] of [...breaks, [bash.length, bash.length]]) {
    const seg = bash.slice(from, start);
    const lists = [cdsBefore(maskedBash.slice(0, from), bash.slice(0, from)), cdsBefore(maskedPwshOnBash.slice(0, from), bash.slice(0, from))];
    from = next;
    const squashed2 = squashQuotes(seg);
    if (squashed2 === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed2, squashed2, true, before, squashed2, kinds));
  }
  return calls;
}
var REF_HEADS = /^refs\/heads\//;
var REPO_OPT = /^--repo?(?:=|$)/;
var STRICT_OPTS = /* @__PURE__ */ new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--porcelain", "--progress", "--no-progress"]);
var STRICT_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var STRICT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
var NOT_A_BRANCH = /\.\.|\/\/|\/$|\.lock$|^(?:refs|heads|tags|remotes)\/|^HEAD$/;
var strictBranch = (b) => STRICT_BRANCH.test(b) && !NOT_A_BRANCH.test(b);
var STRICT_TOKEN = /^(?:(?:[A-Za-z0-9._:/\\-]*[\\/])?git(?:\.exe)?|(?:(?:pwsh|powershell)(?:\.exe)?\s+(?:-NoProfile\s+)?-File\s+)?(?:[A-Za-z0-9._:/\\-]*[\\/])?git-safe\.ps1)$/i;
function strictCall(call) {
  const lead = call.lead.replace(/\b(?:then|do|else)\b/g, "").replace(/[\s;&|(){}]/g, "");
  const opts = call.opts.replace(DIR_OPT_RE, " ").trim();
  return !call.squashed && lead === "" && opts === "" && [...call.opts.matchAll(DIR_OPT_RE)].length <= 1 && STRICT_TOKEN.test(call.token);
}
var strictPositionals = (raw) => raw.length === 0 || raw.length === 2 && STRICT_REMOTE.test(raw[0]) && strictBranch(raw[1]);
function argWordsOf(call) {
  const raws = call.args.replace(REDIRECT_RE, " ").split(/\s+/).filter((r) => squashQuotes(r) !== "");
  return { raws, tokens: raws.map(squashQuotes) };
}
function callDirsOf(call) {
  const dirs = [...call.opts.matchAll(DIR_OPT_RE), ...call.opts.matchAll(PATH_OPT_RE)].sort((a, b) => a.index - b.index);
  return dirs.map((m) => m[1].includes("\\") ? m[1] : squashQuotes(m[1]));
}
var WIDE_LONG = ["mirror", "all"];
var UNSAFE_LONG = ["mirror", "all", "branches", "tags", "delete", "prune", "force", "force-with-lease", "force-if-includes"];
var PUSH_KEY_RE = /^(?:push|remote|submodule)\./;
var C_OPT_RE = /(?:^|\s)-c\s+((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
function readLongFlag(f, t) {
  const eq = t.indexOf("=");
  const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
  const value = eq < 0 ? null : t.slice(eq + 1).toLowerCase();
  if (UNSAFE_LONG.some((n) => n.startsWith(name))) f.unsafeOpt = true;
  if (name.length >= 2 && WIDE_LONG.some((n) => n.startsWith(name))) f.wideOpt = true;
  if (name === "no-recurse-submodules") f.noRecurse = true;
  else if (name.length >= 4 && "recurse-submodules".startsWith(name)) {
    if (value === "no" || value === "check") f.noRecurse = true;
    else f.widerOpt ??= t;
  }
  if (name === "no-follow-tags") f.noFollowTags = true;
  else if (name.length >= 3 && "follow-tags".startsWith(name)) f.widerOpt ??= t;
}
function appFlagsOf(tokens, opts) {
  const f = { unsafeOpt: false, wideOpt: false, oBundle: false, widerOpt: null, noRecurse: false, noFollowTags: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") break;
    if (!t.startsWith("-") || t === "-") continue;
    if (VALUE_OPTS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("--")) readLongFlag(f, t);
    else if (/^-[A-Za-z0-9]+$/.test(t)) {
      const body = t.slice(1);
      const o = body.indexOf("o");
      if (o >= 0) f.oBundle = true;
      if (/[fd]/.test(o < 0 ? body : body.slice(0, o))) f.unsafeOpt = true;
    }
  }
  for (const m of opts.matchAll(C_OPT_RE)) {
    const key = squashQuotes(m[1]).split("=")[0].toLowerCase();
    if (PUSH_KEY_RE.test(key)) {
      f.widerOpt ??= `-c ${key}`;
      break;
    }
  }
  return f;
}
function pushShapesFrom(call) {
  const { raws, tokens } = argWordsOf(call);
  const cdirs = callDirsOf(call);
  const dir = cdirs[cdirs.length - 1] ?? null;
  const positional = [];
  const rawPositional = [];
  let force = false;
  let quiet = false;
  let literal = false;
  let repoOpt = false;
  let plainOpts = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (literal || !t.startsWith("-") || t === "-") {
      positional.push(t);
      rawPositional.push(raws[i]);
      continue;
    }
    if (!STRICT_OPTS.has(raws[i])) plainOpts = false;
    if (t === "--") {
      literal = true;
      continue;
    }
    if (REPO_OPT.test(t)) repoOpt = true;
    if (VALUE_OPTS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("--")) {
      if (FORCE_LONG.test(t)) force = true;
      if (t === "--dry-run" || t === "--help") quiet = true;
    } else if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (/[fd]/.test(t)) force = true;
      if (/[nh]/.test(t)) quiet = true;
    }
  }
  if (quiet) return [];
  const [remote = null, ...specs] = positional;
  const plain = plainOpts && strictCall(call) && strictPositionals(rawPositional);
  const base = { remote, dir, cdirs, cds: call.cds, loose: call.loose, unknown: call.unknown, moved: MOVE_OPT_RE.test(` ${call.opts}`), plain, repoOpt, ...appFlagsOf(tokens, call.opts) };
  if (specs.length === 0) return [{ kind: "push", pr: null, push: { ...base, branch: null, src: null, force, bare: true, oneSide: true } }];
  const out3 = [];
  for (let i = 0; i < specs.length; i++) {
    let spec = specs[i];
    let rewrite = force;
    if (spec === "tag") {
      rewrite = true;
      i++;
      spec = specs[i] ?? "tag";
    }
    if (spec.startsWith("+")) {
      rewrite = true;
      spec = spec.slice(1);
    }
    const colon = spec.indexOf(":");
    const rawSrc = colon < 0 ? spec : spec.slice(0, colon);
    const rawDst = colon < 0 ? "" : spec.slice(colon + 1);
    if (colon >= 0 && rawSrc === "") rewrite = true;
    if (/^refs\/tags\//.test(rawDst || rawSrc)) rewrite = true;
    const src = rawSrc.replace(REF_HEADS, "");
    const name = (rawDst || rawSrc).replace(REF_HEADS, "");
    const oneSide = colon < 0 || rawSrc === "" || rawDst === "";
    out3.push({ kind: "push", pr: null, push: { ...base, branch: name === "" || name === "HEAD" ? null : name, src: src === "" || src === "HEAD" ? null : src, force: rewrite, bare: false, oneSide } });
  }
  return out3;
}
function pushShapesOf(raw, tool) {
  const out3 = [];
  const seen = /* @__PURE__ */ new Map();
  const verdict = rawVerdict(raw, tool);
  const offList = verdict === null ? !steadyCommand(raw, tool === "PowerShell" ? "pwsh" : "bash") : verdict.kind !== "ok";
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const shape of pushShapesFrom(call)) {
      const p = shape.push;
      if (offList) p.plain = false;
      const chain = p.cdirs.length > 1 ? p.cdirs.map(squashQuotes).join("\0") : "";
      const id = [p.remote, p.branch, p.src, p.dir === null ? null : squashQuotes(p.dir), p.force, p.moved, p.loose, p.unknown, p.bare, p.cds.join("\0")].join("|") + (chain === "" ? "" : `|-C:${chain}`);
      const kept = seen.get(id);
      if (kept) {
        if (!call.squashed) kept.plain &&= p.plain;
        kept.repoOpt ||= p.repoOpt;
        kept.unsafeOpt ||= p.unsafeOpt;
        kept.wideOpt ||= p.wideOpt;
        kept.oBundle ||= p.oBundle;
        kept.widerOpt ??= p.widerOpt;
        kept.oneSide ||= p.oneSide;
        kept.noRecurse &&= p.noRecurse;
        kept.noFollowTags &&= p.noFollowTags;
      } else {
        seen.set(id, p);
        out3.push(shape);
      }
    }
  }
  return out3;
}
var squashMarks = (t) => t.replace(/["'\\^`]/g, "");
var WORD_SPLIT = /[\s;&|(){}<>=,]+/;
var isPushWord = (w) => /^push$/i.test(w) || /(?:^|[\\/])git-push(?:\.exe)?$/i.test(w);
var GIT_WORD = /(?<![^\s;&|(){}`!])(?:(?:[^\s;&|(){}`'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1|(git-push(?:\.exe)?))|"[^"]*"|'[^']*')(?=\s|$)/gi;
var isRunner = (rs, g) => {
  const raw = rs.slice(g.index, g.index + g[0].length);
  return !/^["']/.test(g[0]) || isGitToken(raw) || isSafeToken(raw, PUSH_WRAPPERS);
};
var VALUE_GLOBAL = /^(?:-C|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|-Pa(?:th?)?|-R(?:e(?:m(?:o(?:te?)?)?)?)?)$/i;
var ODD_VERB = /[$`{}()%"'\\*?[\]]/;
var WORDS = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;
var PAYLOAD = /\b(?:(?:ba|z|da|k)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c\b|eval\b|cmd(?:\.exe)?\s+(?:\/\w+\s+)*\/[ck]\b|(?:pwsh|powershell)(?:\.exe)?\s.*?-c(?:ommand)?\b|Invoke-Expression\b|iex\b)|(?:\$\(|`)\s*(?:[^\s;&|()`'"]*[\\/])?git(?:\.exe)?\s/i;
var holdsGitPush = (s) => {
  const w = squashMarks(s).split(WORD_SPLIT);
  return w.some((x) => /(?:^|[\\/])git(?:\.exe)?$/i.test(x)) && w.some(isPushWord);
};
var aliasPushes = (w) => {
  const t = squashMarks(w);
  return t.slice(t.indexOf("=") + 1).split(WORD_SPLIT).some(isPushWord);
};
function verbAt(ms, rs, g) {
  if (g[1]) return "push";
  const from = g.index + g[0].length;
  const cut = ms.slice(from).search(ARGS_END_RE);
  const words = [...ms.slice(from, cut < 0 ? ms.length : from + cut).matchAll(WORDS)].map((w) => rs.slice(from + w.index, from + w.index + w[0].length));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) return ODD_VERB.test(w) ? "odd" : /^push$/i.test(w) ? "push" : "other";
    if (w === "-c" && /^alias\./i.test(squashMarks(words[i + 1] ?? ""))) return aliasPushes(words[i + 1]) ? "odd-push" : "odd";
    if (w === "-c" || VALUE_GLOBAL.test(w)) i++;
  }
  return null;
}
function verbsOf(raw, shell) {
  const { view, masked } = viewOf(raw, shell);
  const read = { pushes: 0, odd: false, segs: [] };
  let from = 0;
  for (const m of [...masked.matchAll(/[;&|\r\n]+/g), null]) {
    const to = m === null ? masked.length : m.index;
    const ms = masked.slice(from, to);
    const rs = view.slice(from, to);
    from = m === null ? to : to + m[0].length;
    const verbs = [...ms.matchAll(GIT_WORD)].filter((g) => isRunner(rs, g)).map((g) => verbAt(ms, rs, g));
    const pushes = verbs.filter((v) => v === "push").length;
    const payload = PAYLOAD.test(rs) && holdsGitPush(rs);
    const aliasPush = verbs.includes("odd-push");
    read.pushes += pushes;
    read.odd ||= payload || aliasPush || verbs.includes("odd");
    if (pushes > 0 || payload || aliasPush) read.segs.push(rs);
  }
  return read;
}
var FORCE_LONG_NAMES = ["force", "force-with-lease", "force-if-includes", "mirror", "delete"];
var isForceBundle = (w) => /^-[vqnfduoh46]+$/.test(w) && /[fd]/.test(w);
function forceSpelled(raw) {
  return squashMarks(raw).split(WORD_SPLIT).some((w) => {
    if (/^\+[^+\s]/.test(w) || isForceBundle(w)) return true;
    const long = /^--([A-Za-z][A-Za-z-]*)$/.exec(w);
    return long !== null && FORCE_LONG_NAMES.some((n) => n.startsWith(long[1].toLowerCase()));
  });
}
var STRICT_QUIET = /* @__PURE__ */ new Set(["-n", "--dry-run", "-h", "--help"]);
function strictAccounted(call) {
  if (!strictCall(call)) return false;
  const { raws } = argWordsOf(call);
  const positional = raws.filter((r) => !r.startsWith("-"));
  return raws.every((r) => !r.startsWith("-") || STRICT_OPTS.has(r) || STRICT_QUIET.has(r)) && strictPositionals(positional);
}
var viewOf = (raw, shell) => {
  const view = joinContinuations(raw, shell);
  return { view, masked: maskQuoted(view, shell === "pwsh" ? "PowerShell" : "Bash") };
};
function strictWhole(raw, tool, shell) {
  if (!steadyCommand(raw, shell) || mayRunUnderCmd(tool) && /['^]/.test(raw)) return false;
  const { view, masked } = viewOf(raw, shell);
  const calls = pushCallsOf(masked, view, false);
  const pushSegs = segmentsOf(fdBlank(raw), shell)?.seq.filter((k) => k === "push").length ?? -1;
  return calls.length === pushSegs && calls.every(strictAccounted);
}
function shapedCalls(raw, tool, shell) {
  const { view, masked } = viewOf(raw, shell);
  const shaped = (calls) => calls.filter((c) => pushShapesFrom(c).length > 0).length;
  return Math.max(shaped(pushCallsOf(masked, view, false)), shaped(pushCallsIn(raw, mayRunUnderCmd(tool)).filter((c) => c.squashed)));
}
function rawVerdict(raw, tool) {
  const shell = tool === "PowerShell" ? "pwsh" : "bash";
  const read = verbsOf(raw, shell);
  const hidden = hiddenPieces(raw, tool).filter(hiddenPush);
  if (read.pushes === 0 && !read.odd && hidden.length === 0) return null;
  if (hidden.length === 0 && strictWhole(raw, tool, shell)) return { kind: "ok", unread: false };
  const unsafe = read.segs.some(hardSpelled) || hidden.some(hardSpelled);
  return { kind: unsafe ? "unsafe" : "tap", unread: read.odd || hidden.length > 0 || read.pushes > shapedCalls(raw, tool, shell) };
}
function chainStep(base, value, shell) {
  const raw = value.includes("\\") ? unquotePath(value, shell) : value;
  if (hasUnexpandedPart(value)) return UNEXPANDED + raw;
  const t = shell === "bash" ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  if (isUnexpanded(base)) return base;
  return base.startsWith("/") ? posix2.resolve(base, t) : resolve3(base, t);
}
var chainDir = (base, values, shell) => values.reduce((dir, v) => chainStep(dir, v, shell), base);
function chainDirsOf(p, cwd, shell) {
  if (p.cdirs.length < 2) return [];
  return [...new Set(dirsAfter(cwd, p.cds, shell, p.loose).map((b) => chainDir(b, p.cdirs, shell)))].filter((d) => !isUnexpanded(d));
}
var MOVE_VALUE_RE = /(?:\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)[ \t]*=[ \t]*|--(?:git-dir|work-tree)(?:=|\s+))(\S+)/gi;
function moveTargets(raw, cwd, shell, home) {
  const out3 = [];
  for (const m of raw.replace(/["']/g, "").matchAll(MOVE_VALUE_RE)) {
    for (const dir of knownDirs([chainStep(cwd, m[1].replace(/[;&|)]+$/, ""), shell)], home)) out3.push(dir.replace(/[\\/]\.git(?:[\\/]worktrees[\\/][^\\/]+)?[\\/]*$/i, ""));
  }
  return [...new Set(out3)];
}
var HOME_LEAD = /^(?:~|\$HOME\b|\$\{HOME\}|\$env:USERPROFILE\b|%USERPROFILE%)(?=$|[\\/])/i;
function knownDirs(dirs, home) {
  return dirs.flatMap((d) => {
    if (!isUnexpanded(d)) return [d];
    const raw = d.slice(UNEXPANDED.length);
    const lead = HOME_LEAD.exec(raw);
    const rest = lead === null ? "" : raw.slice(lead[0].length);
    if (lead === null || hasUnexpandedPart(rest.replace(/^[\\/]+/, ""))) return [];
    return [home.startsWith("/") ? posix2.join(home, rest) : join7(home, rest)];
  });
}
var firstCovered = (deps, dirs) => dirs.find((d) => coveredAmong(deps, [d]) !== null) ?? null;
var RAW_CD = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;
function rawDirs(raw, tool, cwd, shell, home) {
  const out3 = [cwd];
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const base of dirsAfter(cwd, call.cds, shell, true)) out3.push(base, chainDir(base, callDirsOf(call), shell));
  }
  const lists = [raw.replace(/["'`^]/g, "").split(/[\s;&|(){}<>]+/), ...payloadWords(raw, shell) ?? []];
  for (const words of lists) {
    let chained = cwd;
    for (let i = 0; i + 1 < words.length; i++) {
      if (!RAW_CD.test(words[i]) && words[i] !== "-C" && !/^-path$/i.test(words[i])) continue;
      out3.push(chainStep(cwd, words[i + 1], shell));
      chained = chainStep(chained, words[i + 1], shell);
      out3.push(chained);
    }
  }
  return [.../* @__PURE__ */ new Set([...knownDirs(out3, home), ...moveTargets(raw, cwd, shell, home)])];
}
function payloadWords(raw, shell) {
  const top = pairedWords(raw, shell === "pwsh");
  if (top === null) return null;
  const lists = [top];
  for (const w of top.filter((t) => /\s/.test(t))) {
    const inner = [pairedWords(w, false), pairedWords(w, true)];
    if (inner.some((l) => l === null)) return null;
    lists.push(...inner);
  }
  return lists;
}
var RAW_PUSH_WHY = "this push sits inside the text of another program (sh -c, bash -c, pwsh -c) or in a quote this gate cannot pair, so its folder, remote and branch cannot be read. Run git push as its own command: git push <remote> <branch>.";
function rawPushDenies(raw, tool, deps, cwd, shell, subagent) {
  const v = rawVerdict(raw, tool);
  if (v === null || v.kind === "ok" || v.kind === "tap" && !v.unread) return [];
  const dirs = rawDirs(raw, tool, cwd, shell, deps.home);
  const dir = firstCovered(deps, dirs);
  if (dir === null) {
    if (!v.unread) return [];
    const hit = payloadWords(raw, shell) === null || dirs.some((d) => !isUnexpanded(d) && ccv3OrUnplaced(deps, d));
    return hit ? [hardOf(deny("push-target-unresolved", RAW_PUSH_WHY, "push"))] : [];
  }
  if (v.kind === "unsafe") return [deny("push-unsafe", appRawUnsafeWhy(dir), "app-push")];
  const unread = deny("push-target-unresolved", appUnreadWhy(dir), "app-push");
  return [subagent ? unread : { ...unread, tapPath: true }];
}
function hiddenGhDenies(raw, tool, deps, cwd, shell) {
  if (!hiddenPieces(raw, tool).some(hiddenGh)) return [];
  const dir = firstCovered(deps, rawDirs(raw, tool, cwd, shell, deps.home));
  return dir === null ? [] : [{ ...deny("position-unknown", unpairedWhy(dir)), homeFlags: true }];
}
var GH_FLAG_FIRST = /(?:^|[\s;&|(){}"'])(?:[^\s;&|(){}"']*[\\/])?gh(?:\.exe)?["']?\s+-/i;
var GH_MERGE_TEXT = /\bpr\s+merge\b|\bapi\b[^\n]*\/merge\b/i;
var GH_CREATE_TEXT = /\bpr\s+(?:create|new)\b|\bapi\b[^\n]*\/pulls\b/i;
var GH_FLAG_FIRST_WHY = "a gh flag stands before the subcommand (gh -R <repo> pr ...), so this gate cannot read the call. Put the flag after the subcommand: gh pr create -R <repo> --head <branch> --base <base> ..., or gh pr merge <n> -R <repo> --match-head-commit <sha> ...";
function ghFlagFirstDenies(raw, tool, deps, cwd, shell) {
  const text = squashMarks(raw);
  if (!GH_FLAG_FIRST.test(text) && !GH_FLAG_FIRST.test(raw)) return [];
  const pattern = GH_MERGE_TEXT.test(text) ? "merge-no-head" : GH_CREATE_TEXT.test(text) ? "head-unresolved" : null;
  if (pattern === null) return [];
  const dirs = rawDirs(raw, tool, cwd, shell, deps.home).filter((d) => !isUnexpanded(d));
  const app = firstCovered(deps, dirs);
  if (app !== null) return [{ ...deny(pattern, `${GH_FLAG_FIRST_WHY}${inAppFolder(app)}`), homeFlags: true }];
  if (dirs.some((d) => ccv3OrUnplaced(deps, d))) return [deny(pattern, GH_FLAG_FIRST_WHY)];
  for (const d of dirs) {
    const place = appPlace(deps, d);
    if (place.corrupt) return [registryCorruptDeny(place.corrupt, d, "other")];
  }
  return [];
}
function cmdSegments(view) {
  const out3 = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE.source, "g"))) {
    out3.push({ seg: view.slice(from, m.index), from });
    from = m.index + m[0].length;
  }
  out3.push({ seg: view.slice(from), from });
  return out3;
}
var whereId = (at2) => `${at2.unknown ? "?" : ""}${at2.loose ? "~" : ""}${at2.cds.join("\0")}`;
function ownCommand(view, masked, from) {
  const end = (cut) => cut < 0 ? view.length : from + cut;
  const to = end(masked.slice(from).search(SEGMENT_RE));
  const fto = end(masked.slice(from).replace(/>&|&>/g, "  ").search(SEGMENT_RE));
  return { text: view.slice(from, to), mtext: masked.slice(from, to), ftext: view.slice(from, fto), fmtext: masked.slice(from, fto) };
}
function priorOf(view, masks, from) {
  const all = masks.map((m) => priorGhRepo(view.slice(0, from), m.slice(0, from)));
  return { repos: [...new Set(all.flatMap((a) => a.repos))].sort(), nonLiteral: all.some((a) => a.nonLiteral) };
}
var priorId = (p) => p.repos.length === 0 && !p.nonLiteral ? "" : `|GH_REPO=${p.repos.join(",")}${p.nonLiteral ? "$" : ""}`;
var fullId = (own) => own.ftext === own.text ? "" : `|${own.ftext}`;
var landId = (shape, at2, own, prior) => `${shape.kind}|${shape.pr}|${shape.sha}${shape.shaBad ? "!" : ""}|${whereId(at2)}${shape.kind === "merge" ? `|${own.ftext}${priorId(prior)}` : ""}`;
var distinctWheres = (wheres) => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);
function shapesOf(raw, tool, parsed, astOnly = false) {
  const text = normalizeGh(blankInertQuotes(raw, tool));
  const views = [.../* @__PURE__ */ new Set([joinContinuations(text, "bash"), joinContinuations(text, "pwsh")])];
  const textOnly = (tool === "Bash" || tool === "PowerShell") && !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations(raw, "bash"), joinContinuations(raw, "pwsh")].every(isTextOnlyCommand);
  const docReadable = !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations(raw, "bash"), joinContinuations(raw, "pwsh")].every((c) => docAppendReadable(c, tool));
  const docAst = !PR_NUMBER_IN_TEXT_RE.test(raw) && docAppendByAst(parsed, tool, raw);
  const out3 = [];
  const pwshTool = tool === "PowerShell";
  const seen = /* @__PURE__ */ new Set();
  const add = (shape, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out3.push(shape);
    }
  };
  let created = false;
  const exempt = textOnly || docAst;
  const astItems = astOnly ? astItemsOf(parsed, raw, exempt, text) : [];
  const heldItems = /* @__PURE__ */ new Set();
  const astHolds = (s, create) => {
    const sq = squashed(s);
    const hit = astItems.filter((i) => i.create === true === create && sq.includes(i.sq));
    hit.forEach((i) => heldItems.add(i));
    return hit;
  };
  for (const view of views) {
    const reads = ["Bash", "PowerShell"].map((tool2) => {
      const masked = maskQuoted(view, tool2);
      return { masked, pos: cdPositions(masked, view) };
    });
    for (const { seg, from } of cmdSegments(view)) {
      const wheres = distinctWheres(reads.map((r) => whereAt(r.pos, from)));
      const owns = reads.map(({ masked }) => ownCommand(view, masked, from));
      const prior = priorOf(view, reads.map((r) => r.masked), from);
      const tail = quoteOpenAt(view, from, pwshTool) ? "" : rawTail(view.slice(from));
      for (const s of /* @__PURE__ */ new Set([seg, squashQuotes(seg)])) {
        const found = astOnly ? astHolds(s, false).flatMap((i) => i.shape ? [i.shape] : []) : landShapesOf(s, textOnly || docAst || docReadable && isDocAppend(seg), seg, tail, pwshTool);
        for (const shape of found) {
          for (const own of owns) for (const at2 of wheres) add({ ...shape, at: at2, ...own, prior }, landId(shape, at2, own, prior));
        }
      }
      const heldCreates = astOnly ? astHolds(seg, true) : [];
      if (astOnly ? heldCreates.length === 0 : !isPrOpenText(seg)) continue;
      created = true;
      const held = heldCreates.find((h) => h.read?.bad) ?? heldCreates[0];
      for (const own of owns) for (const at2 of wheres) add({ kind: "create", pr: null, at: at2, ...own, prior, tail, pwsh: pwshTool, ...held?.read ? { read: held.read } : {} }, `create|${whereId(at2)}|${own.text}${fullId(own)}${priorId(prior)}|${tail}`);
    }
  }
  if (astOnly) {
    const loose = astItems.filter((i) => i.create !== true && i.shape && !heldItems.has(i));
    if (loose.length > 0) {
      const view = views[0];
      const masked = maskQuoted(view, "Bash");
      for (const i of loose) for (const at2 of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
        add({ ...i.shape, at: at2, text: view, mtext: masked, ftext: view, fmtext: masked, prior: NO_PRIOR, pwsh: pwshTool }, `loose|${i.shape?.kind}|${i.shape?.pr}|${whereId(at2)}|${i.sq}`);
      }
    }
  }
  const looseCreate = astOnly ? astItems.filter((i) => i.create === true) : [];
  if (!created && (astOnly ? looseCreate.length > 0 : isPrOpenCommand(text))) {
    const view = views[0];
    const masked = maskQuoted(view, "Bash");
    const read = looseCreate.find((i) => i.read?.bad)?.read ?? looseCreate[0]?.read;
    for (const at2 of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: "create", pr: null, at: at2, text: view, mtext: masked, ftext: view, fmtext: masked, tail: view, pwsh: pwshTool, ...read ? { read } : {} }, `create|${whereId(at2)}|${view}`);
    }
  }
  const withMergesAndCreates = withAstCreates(withAstMerges(out3, parsed, pwshTool), parsed, pwshTool);
  const seenLand = new Set(withMergesAndCreates.filter((s) => s.kind === "land").map((s) => `${s.pr}|${s.sha}`));
  const lands = (astOnly ? astLandShapes(parsed, raw, exempt, text, pwshTool) : []).filter((s) => {
    const k = `${s.pr}|${s.sha}`;
    if (seenLand.has(k)) return false;
    seenLand.add(k);
    return true;
  });
  return [...withMergesAndCreates, ...lands, ...pushShapesOf(raw, tool)];
}
var enforcing = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforce");
var enforcingPush = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforcePush");
function homeFlag(deps, key) {
  try {
    const cfg = JSON.parse(deps.readFile(join7(deps.home, "continuous-claude", "review-router.config.json")) ?? "null");
    return cfg?.decisions?.[key];
  } catch {
    return null;
  }
}
function enforcingScope(scope, deps, cwd, homeOnly = false) {
  if (scope === "app-push") return homeFlag(deps, "enforceAppPush") !== false;
  if (homeOnly && scope === "other") return homeFlag(deps, "enforce") === true;
  return scope === "push" ? enforcingPush(deps, cwd) : enforcing(deps, cwd);
}
var FLAG_OF = { push: "decisions.enforcePush", other: "decisions.enforce", "app-push": "decisions.enforceAppPush" };
var OPENER = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
var CMD_POS = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER}*))` + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
var NOISE = String.raw`(?:\\|''|"")*`;
var spell = (word) => NOISE + [...word].join(NOISE) + NOISE;
var CD_NAMES2 = `${spell("cd")}|Set-Location|sl|${spell("chdir")}|${spell("pushd")}|Push-Location`;
var CD_SOURCE = CMD_POS + String.raw`(?:${CD_NAMES2})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`;
var JOB_BLOCK = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;
function withoutClosed(text, group) {
  let t = text;
  for (; ; ) {
    const next = t.replace(group, "");
    if (next === t) return t;
    t = next;
  }
}
var CLOSED_BRACES = /\{[^{}]*\}/g;
var CLOSED_PARENS = /\([^()]*\)|`[^`]*`/g;
var COMMENT = /(?:^|(?<!\\)\s)#[^\r\n]*/g;
var insideSubshell = (before) => /[(`]/.test(withoutClosed(before.replace(COMMENT, ""), CLOSED_PARENS));
var gitBashPath = (p) => process.platform === "win32" ? p.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : p;
function hasUnexpandedPart(target) {
  const t = target.replace(/^["']|["']$/g, "");
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith("~") || /^[(@]/.test(t);
}
var UNEXPANDED = "<cannot-expand>";
var isUnexpanded = (dir) => dir.startsWith(UNEXPANDED);
var unexpandedWhy = (dir) => `a cd target or -C value (${dir.slice(UNEXPANDED.length, UNEXPANDED.length + 120)}) holds a variable, a command substitution, a ~ or a glob, so the checkout this command runs in cannot be known. Use a literal path in the cd (cd <full path> && ...).`;
var absoluteText = (t) => isAbsolute2(t) || /^[A-Za-z]:/.test(t);
function unquotePath(target, shell) {
  return shell === "pwsh" ? target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, s) => d ?? s ?? "").trimEnd() : target.replace(/\\([ "'])|["']/g, (_m, esc) => esc ?? "");
}
function moveTo(base, target, shell) {
  const raw = unquotePath(target, shell);
  if (hasUnexpandedPart(target)) return UNEXPANDED + raw;
  const t = shell === "bash" ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve3(base, t);
}
var cdsBefore = (masked, raw) => whereAt(cdPositions(masked, raw), masked.length);
function looseJoin(between) {
  const joiners = between.replace(FD_REDIRECT, " ").match(/&&|\|\||[;&|\r\n]/g) ?? [];
  return !(joiners.length > 0 && joiners.every((j) => j === "&&"));
}
var FD_REDIRECT = /\d*[<>]&\d*-?|&>>?/g;
function endsInPipe(before) {
  let t = before.trimEnd();
  for (; ; ) {
    const c = t.replace(/(?:^|\s)#[^\r\n]*$/, "").trimEnd();
    if (c === t) break;
    t = c;
  }
  return t.endsWith("|") || t.endsWith("|&");
}
var UNKNOWN_CD_SOURCE = CMD_POS + String.raw`(?:(?:${spell("popd")}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES2})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`;
var NO_FOLDER = /^(?:[-+]|-[PLe@]+|--)$/i;
var REMOTE_AFTER_BLOCK = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;
function cdPositions(masked, raw) {
  const cds = [];
  const unknown = [...masked.matchAll(new RegExp(UNKNOWN_CD_SOURCE, "gi"))].map((m) => m.index + m[0].length);
  for (const m of masked.matchAll(new RegExp(CD_SOURCE, "gi"))) {
    const end = m.index + m[0].length;
    const target = raw.slice(end - m.groups.t.length, end);
    if (NO_FOLDER.test(target)) {
      unknown.push(end);
      continue;
    }
    const before = masked.slice(0, m.index);
    const piped = m.groups.soft !== void 0 || /^\||[(`]/.test(m.groups.hard ?? "") || endsInPipe(before) || insideSubshell(before) || JOB_BLOCK.test(withoutClosed(before, CLOSED_BRACES)) || REMOTE_AFTER_BLOCK.test(masked.slice(end));
    cds.push({ end, target, piped });
  }
  return { cds, unknown, masked };
}
function whereAt(pos, from) {
  const before = pos.cds.filter((c) => c.end <= from);
  return {
    cds: before.map((c) => c.target),
    unknown: pos.unknown.some((end) => end <= from),
    loose: before.some((c) => c.piped || looseJoin(pos.masked.slice(c.end, from)))
  };
}
function pushDir(cwd, cds, shell) {
  return cds.reduce((dir, target) => moveTo(dir, target, shell), cwd);
}
function isCcv3Checkout(deps, dir) {
  const r = deps.git(dir, ["remote", "-v"]);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1] ?? "";
    const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return m !== null && m[1].toLowerCase() === CCV3_REPO;
  });
}
var NOT_COVERED = { covered: false, entryKey: "", github: null, corrupt: null };
var TOP_ARGS = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
var COMMON_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
var PLACES = /* @__PURE__ */ new WeakMap();
function appPlace(deps, dir) {
  if (!deps.tapScope) return NOT_COVERED;
  let memo = PLACES.get(deps);
  if (!memo) PLACES.set(deps, memo = /* @__PURE__ */ new Map());
  const known = memo.get(dir);
  if (known) return known;
  const scope = deps.tapScope;
  const place = inApp(deps, () => readPlace(deps, scope, dir));
  memo.set(dir, place);
  return place;
}
function readPlace(deps, scope, dir) {
  const reg = scope.registry();
  if (reg.state === "corrupt") return { ...NOT_COVERED, corrupt: reg.file };
  if (reg.state === "missing") return reg.envPath ? { ...NOT_COVERED, notice: reg.file } : NOT_COVERED;
  if (!underLiveRoot(dir, reg, scope)) return NOT_COVERED;
  try {
    const { top, main: main3 } = repoRoots(deps, dir);
    const cov = coverageOf({ toplevel: top, worktreeMainRoot: main3, isCcv3: false }, reg, { realpath: scope.realpath });
    return cov.covered ? { covered: true, entryKey: cov.entryKey ?? "", github: cov.github ?? null, corrupt: null } : NOT_COVERED;
  } catch (err) {
    throw err instanceof AppScopeError ? err : new AppScopeError(err);
  }
}
function rootOfCommon(dir, common) {
  const commonDir = common === "" || absoluteText(common) ? common : resolve3(dir, common);
  return /[\\/]\.git$/.test(commonDir) ? commonDir.replace(/[\\/]\.git$/, "") : null;
}
function repoRoots(deps, dir) {
  const r = deps.git(dir, TOP_ARGS);
  const [top = "", common = ""] = r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()) : [];
  if (top !== "") return { top, main: rootOfCommon(dir, common) };
  const c = deps.git(dir, COMMON_ARGS);
  const root = c.status === 0 ? rootOfCommon(dir, c.stdout.trim()) : null;
  if (root === null) throw new AppScopeError(new Error(`the repo root of ${at(dir)} cannot be read (no work tree, and no <root>/.git common dir)`));
  return { top: root, main: root };
}
function passOf(place, dir, scope) {
  if (place.corrupt) return registryCorruptDeny(place.corrupt, dir, scope);
  return place.notice ? { action: "allow", notice: place.notice } : ALLOW;
}
var registryCorruptDeny = (file, dir, scope) => ({ ...deny("registry-corrupt", registryCorruptWhy(file, dir), scope), homeFlags: true });
function coveredAmong(deps, dirs) {
  const scope = deps.tapScope;
  if (!scope) return null;
  for (const dir of dirs) {
    try {
      if (isCcv3Checkout(deps, dir)) return null;
      if (appPlace(deps, dir).covered) return dir;
    } catch {
      if (underLiveRoot(dir, scope.registry(), scope, { outsideCcv3: true })) return dir;
    }
  }
  return null;
}
var gitIn = (deps, dir) => (args) => deps.git(dir, args);
function cmdRepoOf(s, named, env) {
  const text = s.ftext ?? s.text ?? "";
  const prior = s.prior ?? NO_PRIOR;
  const repo = commandRepo(text, s.fmtext ?? s.mtext ?? text, env, prior.repos);
  return { named, repo, foreign: repo !== null && repo !== CCV3_REPO, nonLiteral: hasNonLiteralRepo(text) || CLUSTER_VAR_REPO.test(text) || prior.nonLiteral };
}
var CLUSTER_VAR_REPO = /(?:^|\s)-[A-Za-z]+R\s*=?["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)/;
var namesCcv3 = (repo) => repo !== null && repo.split(" ").includes(CCV3_REPO);
function routeOf(deps, dir, cmd) {
  const named = cmd.named === CCV3_REPO;
  let ccv3;
  try {
    ccv3 = isCcv3Checkout(deps, dir);
  } catch (err) {
    if (named) return "ccv3";
    throw err;
  }
  if (ccv3) return cmd.foreign ? "foreign" : "ccv3";
  if (!named) return "app";
  return namesCcv3(cmd.repo) || !appPlace(deps, dir).covered ? "ccv3" : "app";
}
function appRepoFor(cmd, deps, dir, place, base) {
  if (cmd.nonLiteral) return deny("repo-unreadable", appRepoUnreadableWhy(dir));
  const k = ghKey2(gitIn(deps, dir), { named: cmd.repo, entryKey: place.entryKey, github: place.github });
  if (k.ok) return { key: k.key, offer: { ...base, remote: k.remote, ...aliasStop(deps, dir, place, k.key, k.remote) } };
  const offer = { ...base, remote: k.remote ?? "<remote>", ...aliasStop(deps, dir, place, k.key ?? "", k.remote ?? null) };
  if (k.why === "repo-differs") return deny("repo-differs", appRepoDiffersWhy(deps, dir, cmd.repo ?? "", k.key ?? null, offer));
  if (k.why === "fetch-push-differ") return deny("fetch-push-differ", appFetchPushWhy(deps, dir, k.remote ?? "", k.key ?? "", (k.pushKeys ?? []).map(String), offer));
  if (k.why === "unnamed") return deny("repo-unnamed", appRepoUnnamedWhy(deps, dir, offer, k.key ?? null));
  return deny("repo-unnamed", appNoTargetWhy(deps, dir, k.remotes ?? [], offer));
}
function aliasStop(deps, dir, place, key, remote) {
  if (!key.startsWith("local:") || remote === null) return {};
  const url = fetchUrlOf(deps, dir, remote);
  return url !== null && needsGithubField2(url, place.github) ? { stop: needsFieldLine(place.entryKey, remote) } : {};
}
var AppScopeError = class extends Error {
  constructor(inner, push = true) {
    super(String(inner?.message ?? inner));
    this.inner = inner;
    this.push = push;
    this.name = "AppScopeError";
  }
  inner;
  push;
};
var CREATE_BOOL = /* @__PURE__ */ new Set(["--draft", "-d", "--fill", "-f", "--fill-first", "--fill-verbose", "--web", "-w", "--no-maintainer-edit", "--dry-run", "--editor", "-e"]);
var CREATE_VALUE = /* @__PURE__ */ new Set([
  "--title",
  "-t",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--label",
  "-l",
  "--assignee",
  "-a",
  "--reviewer",
  "-r",
  "--milestone",
  "-m",
  "--project",
  "-p",
  "--head",
  "-H",
  "--base",
  "-B",
  "--repo",
  "-R",
  "--template",
  "-T",
  "--recover"
]);
var CREATE_SHORT_BOOL = "dwef";
var CREATE_SHORT_VALUE = "tbFlarmpHBRT";
var API_CREATE_KEYS = /* @__PURE__ */ new Set(["head", "base", "title", "body", "draft", "maintainer_can_modify", "issue"]);
var API_BOOL = /* @__PURE__ */ new Set(["--paginate", "--slurp", "--silent", "--verbose", "-i", "--include"]);
var CLI_CREATE_RE = /\bgh\s+pr\s+(?:create|new)\b/i;
var API_CMD_RE = /\bgh\s+api\b/i;
var NOT_LITERAL_RE = /%[^%\s]+%/;
var BAD = (why) => ({ bad: why, heads: [], bases: [] });
function cliCreateRead(args, pwsh) {
  const words = pairedWords(args, pwsh);
  if (words === null) return BAD("an unpaired quote");
  return cliCreateOfWords(words);
}
function cliCreateOfWords(words) {
  const heads = [];
  const bases = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-") || w === "-") return BAD(`a word gh pr create does not take (${w})`);
    if (/^-[A-Za-z]{2,}/.test(w)) {
      const c = clusterOf(w, words[i + 1], CREATE_SHORT_BOOL, CREATE_SHORT_VALUE);
      if (c === null) return BAD(`a flag this gate does not know (${w})`);
      if (c.letter === "H") heads.push(c.value);
      if (c.letter === "B") bases.push(c.value);
      i += c.used;
      continue;
    }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (CREATE_BOOL.has(name) && eq < 0) continue;
    if (!CREATE_VALUE.has(name)) return BAD(`a flag this gate does not know (${name})`);
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === void 0) return BAD(`${name} with no value`);
    if (name === "--head" || name === "-H") heads.push(value);
    if (name === "--base" || name === "-B") bases.push(value);
  }
  return headAndBase(heads, bases);
}
function headAndBase(heads, bases) {
  if (heads.some((v) => v === "" || NOT_LITERAL_RE.test(v))) return BAD("a head value that is empty or not a literal");
  const named = bases.filter((b) => b !== "");
  if (named.some((v) => NOT_LITERAL_RE.test(v))) return BAD("a base value that is not a literal");
  return { bad: null, heads: [...new Set(heads)], bases: [...new Set(named)] };
}
function apiCreateRead(rest, pwsh) {
  const words = pairedWords(rest, pwsh);
  if (words === null) return BAD("an unpaired quote");
  return apiCreateOfWords(words);
}
function apiCreateOfWords(words) {
  const heads = [];
  const bases = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord(words[i], words[i + 1], endpoint);
    if ("bad" in r) return BAD(r.bad);
    if (r.used === -1) {
      endpoint = true;
      continue;
    }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf("=");
    const key = eq > 0 ? r.field.slice(0, eq) : r.field;
    if (!API_CREATE_KEYS.has(key)) return BAD(`a field this gate does not know (${key})`);
    const value = eq > 0 ? r.field.slice(eq + 1) : "";
    if ((key === "head" || key === "base") && value.startsWith("@")) return BAD(`a ${key} read from a file (${key}=@...)`);
    if (key === "head") heads.push(value);
    if (key === "base") bases.push(value);
  }
  return headAndBase(heads, bases);
}
function createRead(text, pwsh = false) {
  const cli = CLI_CREATE_RE.exec(text);
  const api = API_CMD_RE.exec(text);
  const isCli = cli !== null && (api === null || cli.index < api.index);
  const m = isCli ? cli : api;
  if (m === null) return BAD("the create can only be read with its quotes deleted");
  if (!GH_PREFIX_OK.test(text.slice(0, m.index))) return BAD("the gh call is run by another program (a wrapper such as bash -c, pwsh -Command or cmd /c), which reads the words again");
  const rest = text.slice(m.index + m[0].length);
  if (unmodelled(rest.replace(/\{(?:owner|repo|branch)\}/g, "x"), pwsh)) return BAD(CREATE_CHAR_WHY);
  return isCli ? cliCreateRead(rest, pwsh) : apiCreateRead(rest, pwsh);
}
var CREATE_CHAR_WHY = "a character whose effect this gate cannot read the same way in bash and PowerShell (outside quotes only letters, digits, - _ . / = : and spaces; no $, backtick or backslash in double quotes; no redirect, &, non-ASCII or CR)";
var createBadWhy = (dir, why) => `the head or base of this create cannot be read as gh reads it in ${dir}: ${why}. Name the head and base once, in the plain form: gh pr create --head <branch> --base <base> ..., or gh api .../pulls -X POST -f head=<branch> -f base=<base> .... A body made by $(...) or a heredoc is refused: pass it as a file with --body-file <path> or -F body=@<path>, with forward slashes in the path. ${PLAIN_WAY_OUT}`;
function readBranch(named, deps, dir) {
  if (named) return named.replace(/^[^:\s]+:/, "");
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
var COMMIT_GIT = gitCallRe("commit");
var COMMIT_SAFE = safeCallRe("commit", PUSH_WRAPPERS, "", "gi");
var READ_VERB = "(?:status|diff|log|show|rev-parse)";
var READ_GIT = gitCallRe(READ_VERB);
var READ_SAFE = safeCallRe(READ_VERB, PUSH_WRAPPERS, "", "gi");
var COMMIT_MSG = String.raw`(?:-[Fm]\s+${VAL}|--(?:file|message)(?:=|\s+)${VAL})`;
var COMMIT_ARGS_RE = new RegExp(String.raw`^(?:\s+(?:-q|--quiet))*\s+${COMMIT_MSG}(?:\s+(?:-q|--quiet|${COMMIT_MSG}))*\s*$`);
var CD_SEG_RE = /^\s*(?:cd|Set-Location|sl|chdir|pushd|Push-Location)\s+\S/i;
function openCall(ms, rs, git, safe) {
  const kinds = [[git, isGitToken], [safe, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
  for (const [re, valid] of kinds) {
    for (const m of ms.matchAll(re)) {
      if (m[1].trim() !== "") continue;
      const tokenStart = m.index + m[1].length;
      if (!valid(rs.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      return { opts: rs.slice(optsStart, optsStart + m[3].length), end: m.index + m[0].length };
    }
  }
  return null;
}
function segmentKind(ms, rs) {
  if (/[(){}<>]/.test(ms) || /[$`]/.test(rs)) return "other";
  if (CD_SEG_RE.test(ms)) return "cd";
  const commit = openCall(ms, rs, COMMIT_GIT, COMMIT_SAFE);
  if (commit) return commit.opts.trim() === "" && COMMIT_ARGS_RE.test(rs.slice(commit.end)) ? "commit" : "other";
  if (openCall(ms, rs, PUSH_GIT, PUSH_SAFE)) return "push";
  const read = openCall(ms, rs, READ_GIT, READ_SAFE);
  return read && read.opts.trim() === "" ? "read" : "other";
}
function commitPrecedesPush(raw, shell) {
  const segs = segmentsOf(raw, shell);
  if (segs === null) return false;
  const { seq, before } = segs;
  const firstCommit = seq.indexOf("commit");
  const lastPush = seq.lastIndexOf("push");
  const firstPush = seq.indexOf("push");
  if (seq.includes("other") || firstCommit < 0 || firstPush < 0 || seq.lastIndexOf("commit") > firstPush) return false;
  if (before.slice(firstCommit + 1, lastPush + 1).some((op) => op !== "&&")) return false;
  const cds = seq.flatMap((k, i) => k === "cd" ? [i] : []);
  return cds.length === 0 || cds.length === 1 && cds[0] < firstCommit;
}
function pushesAlone(raw, shell) {
  const segs = segmentsOf(raw, shell);
  return segs !== null && segs.seq.includes("push") && segs.seq.every((k) => k === "cd" || k === "push" || k === "read");
}
var FD_DUP = /(^|\s)[12]?>&[12](?=\s|$)/g;
var fdBlank = (raw) => raw.replace(FD_DUP, (m, lead) => lead + " ".repeat(m.length - lead.length));
function steadyCommand(raw, shell) {
  const view = fdBlank(raw);
  return pushesAlone(view, shell) || commitPrecedesPush(view, shell);
}
function stateModelled(raw, shell, ctx = {}) {
  const r = pushPrefix(raw, shell, ctx.remoteIsLocal);
  return r !== null && !r.localPush && r.pipeOk && !consumerSubstitutes(ctx.parsed) && (r.plain || commitPrecedesPush(r.prefix, shell));
}
function consumerSubstitutes(parsed) {
  if (!parsed) return false;
  return Object.values(parsed.byDialect).some((r) => {
    if (!r || r.errors.length > 0) return false;
    const lastPush = Math.max(-1, ...r.calls.filter((c) => progName(c.words[0]?.lit) !== null && c.words.some((w) => (w.lit ?? "").toLowerCase() === "push")).map((c) => c.start));
    return lastPush >= 0 && r.calls.some((c) => c.start > lastPush && c.place.pipe && r.substs.some((s) => s.from >= c.start && s.to <= c.end));
  });
}
var MAX_REMOTE_LOOKUPS = 4;
var MAX_LOOKUP_CALLS = 16;
var REMOTE_LOOKUP_RESERVE_MS = 1500;
var REMOTE_LOOKUP_MIN_MS = 200;
var URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
var SCP_LIKE = /^(?:[^\s/\\:@]+@)?[^\s/\\:]{2,}:/;
var clearlyNetwork = (url) => {
  const m = URL_SCHEME.exec(url);
  return m ? m[1].toLowerCase() !== "file" : SCP_LIKE.test(url);
};
function answerIsLocal(stdout) {
  const lines2 = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines2.length === 0 || lines2.some((l) => LOCAL_REMOTE.test(l) || !clearlyNetwork(l));
}
function remoteNameIsLocal(deps, cwd, extraDirs, name, budget) {
  for (const dir of [cwd, ...extraDirs.filter((d) => d !== cwd)]) {
    const own = dir === cwd;
    for (const args of [["remote", "get-url", name], ["remote", "get-url", "--push", "--all", name]]) {
      if (budget.left <= 0) return true;
      let opts;
      if (deps.scanLeft) {
        const left = deps.scanLeft();
        const timeout = Math.min(GIT_TIMEOUT_MS, left - 1e3);
        if (left < REMOTE_LOOKUP_RESERVE_MS || timeout < REMOTE_LOOKUP_MIN_MS) return true;
        opts = { timeout };
      }
      budget.left -= 1;
      try {
        const g = deps.git(dir, args, opts);
        if (g.status !== 0) {
          if (args.length === 3) break;
          return true;
        }
        if (answerIsLocal(g.stdout)) return true;
      } catch (e) {
        if (own || !(e instanceof MissingCwdError || errCode(e) === "ENOENT")) return true;
        break;
      }
    }
  }
  return false;
}
function pushPrefix(raw, shell, remoteIsLocal) {
  const view = fdBlank(joinContinuations(raw, shell));
  const masked = maskQuoted(view, shell === "pwsh" ? "PowerShell" : "Bash");
  const steps = [];
  let from = 0;
  let pending = "";
  for (const [start, next] of [...[...masked.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]), [view.length, view.length]]) {
    const ms = masked.slice(from, start);
    const rs = view.slice(from, start);
    if (ms.trim() !== "") {
      steps.push({ kind: /^\s*(?:popd|Pop-Location)\s*$/i.test(ms) ? "popd" : segmentKind(ms, rs), named: /\bpush\b/i.test(squashQuotes(rs)), op: pending, end: start, raw: rs });
      pending = "";
    } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  const last = steps.map((s) => s.named).lastIndexOf(true);
  if (last < 0) return null;
  const plain = steps.slice(0, last).every((s) => s.kind === "cd" || s.kind === "read" || s.kind === "push" || s.kind === "popd") && steps.slice(1, last + 1).every((s) => !s.op.includes("|") && !/(?<!&)&(?!&)/.test(s.op));
  const tool = shell === "pwsh" ? "PowerShell" : "Bash";
  const earlier = steps.slice(0, last).filter((s) => s.kind === "push").flatMap((s) => pushShapesOf(s.raw, tool).map((p) => p.push?.remote ?? ""));
  const names = [...new Set(earlier.filter((rm) => rm !== "" && !LOCAL_REMOTE.test(rm) && !/[:/]/.test(rm)))];
  const localPush = earlier.some((rm) => LOCAL_REMOTE.test(rm)) || remoteIsLocal !== void 0 && (names.length > MAX_REMOTE_LOOKUPS || names.some(remoteIsLocal));
  let pipeOk = true;
  if (backgroundAfter([...steps.slice(last + 1).map((s) => s.op), pending])) pipeOk = false;
  for (let i = last + 1; i < steps.length && /(?<!\|)\|(?!\|)/.test(steps[i].op); i++) {
    const ms = masked.slice(steps[i].end - steps[i].raw.length, steps[i].end);
    if (!PIPE_CONSUMER.test(ms.trim().split(/\s+/)[0] ?? "") || /[$`@({<]/.test(ms.replace(/\$null\b/gi, "")) || fileRedirect(ms)) pipeOk = false;
  }
  return { prefix: view.slice(0, steps[last].end), plain, localPush, pipeOk };
}
var PIPE_CONSUMER = /^(?:Select-Object|Select-String|Out-String|Out-Null|tail|head|cut|grep|findstr|wc|more)$/i;
function backgroundAfter(ops) {
  for (const op of ops) {
    const m = /(?<!&)&(?!&)|[;\r\n]/.exec(op);
    if (m !== null) return m[0] === "&";
  }
  return false;
}
var fileRedirect = (ms) => [...ms.matchAll(/[0-9*]?>{1,2}\s*(\S*)/g)].some((m) => !/^(?:\$null|\/dev\/null|nul)$/i.test(m[1]));
var LOCAL_REMOTE = /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:|file:)|\\/i;
var PUSH_STATE_WHY = "a step before this push, or a step that runs at the same time (a pipe, a background &), can change the branch, HEAD or the tree it sends (a checkout, a reset, a merge, a commit joined by ; or ||, a group, a pipe or another program), and this gate reads them before the command runs. Run the branch change and the push as two commands; run git push as its own command: git push <remote> <branch>. For a commit: commit first, push in a separate command: commit in one command (git add <files> then git commit -F <file>), and push in the next command (git push <remote> <branch>), after the Commit and push question.";
var PUSH_CHECKOUT_WHY = "the commit before this push runs in one checkout and the push in another (or the checkout of the push folder cannot be read), so the tree it sends cannot be judged. Commit and push in two commands, or push from the same folder: git commit ...; git push <remote> <branch>.";
function sameCheckout(deps, commitDirs, dir) {
  const top = (d) => {
    const r = deps.git(d, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
  };
  if (commitDirs.length === 0 || commitDirs.length > 2) return false;
  const push = top(dir);
  return push !== null && commitDirs.every((c) => top(c) === push);
}
var ADD_GIT = gitCallRe("add");
var ADD_SAFE = safeCallRe("add", PUSH_WRAPPERS, "", "gi");
function stageKind(ms, rs) {
  const k = segmentKind(ms, rs);
  if (k !== "other" || /[(){}<>]/.test(ms) || /[$`]/.test(rs)) return k;
  if (openCall(ms, rs, COMMIT_GIT, COMMIT_SAFE)) return "commit";
  return openCall(ms, rs, ADD_GIT, ADD_SAFE) ? "stage" : "other";
}
function shipFlow(raw, shell) {
  const segs = segmentsOf(fdBlank(raw), shell, stageKind);
  if (segs === null || segs.seq.includes("other")) return false;
  const firstPush = segs.seq.indexOf("push");
  const lastCommit = segs.seq.lastIndexOf("commit");
  return firstPush >= 0 && lastCommit >= 0 && Math.max(lastCommit, segs.seq.lastIndexOf("stage")) < firstPush;
}
function segmentsOf(raw, shell, kindOf = segmentKind) {
  const view = joinContinuations(raw, shell);
  const masked = maskQuoted(view, shell === "pwsh" ? "PowerShell" : "Bash");
  if (masked.includes("|") || /(?<!&)&(?!&)/.test(masked)) return null;
  const seq = [];
  const before = [];
  let from = 0;
  let pending = "";
  const breaks = [...masked.matchAll(/[;&\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const [start, next] of [...breaks, [view.length, view.length]]) {
    const ms = masked.slice(from, start);
    if (ms.trim() !== "") {
      seq.push(kindOf(ms, view.slice(from, start)));
      before.push(pending.trim());
      pending = "";
    } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  return { seq, before };
}
var shellOf = (input) => (input.tool_name || input.tool) === "PowerShell" ? "pwsh" : "bash";
var ALLOW = { action: "allow" };
function judgeCreate(s, deps, dir, cmd) {
  const route = routeOf(deps, dir, cmd);
  if (route === "app") return judgeAppCreate(s.tail ?? s.ftext ?? s.text, s.pwsh === true, deps, dir, cmd, s.read);
  if (route === "foreign") return deny("repo-foreign", goThereWhy(cmd.repo));
  const cr = s.read ?? createRead(s.tail ?? s.text, s.pwsh === true);
  if (cr.bad !== null) return deny("head-unresolved", createBadWhy(dir, cr.bad));
  if (cr.heads.length > 1) return deny("head-unresolved", createBadWhy(dir, `two head values (${cr.heads.join(", ")}); gh takes the last`));
  const branch = readBranch(cr.heads[0] ?? null, deps, dir);
  if (branch === "") return deny("head-unresolved", `the head branch of this create cannot be named in ${dir} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo on a branch.`);
  if (branch === "main") return ALLOW;
  const r = deps.git(dir, ["rev-parse", `${branch}^{commit}`]);
  if (r.status !== 0) return deny("head-unresolved", `cannot read the head of ${branch} in ${dir}, so its open-pr decision cannot be found. Run the command again from the repo.`);
  const head = r.stdout.trim();
  const d = decisionRead2({ step: "open-pr", key: decisionKey2({ branch }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny("open-pr", openPrWhy(branch, head));
}
function judgeLand(shape, deps, dir, cmd) {
  const route = shape.kind === "merge" ? routeOf(deps, dir, cmd) : "ccv3";
  if (route === "app") return judgeAppMerge(shape, deps, dir, cmd);
  if (route === "foreign") return deny("repo-foreign", goThereWhy(cmd.repo));
  if (shape.pr === null) return deny("no-pr", NO_PR_WHY);
  if (shape.kind === "merge" && shape.shaBad) return deny("merge-no-head", `PR #${shape.pr}: ${HEAD_UNREAD_WHY(shape.pr)} The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr}).`);
  const sha = shape.sha ?? void 0;
  if (shape.kind === "merge" && !sha) return deny("merge-no-head", `${shape.pr ? `PR #${shape.pr}` : "this PR"}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? "<n>"} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? "<n>"}).`);
  const key = decisionKey2({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW : deny("land", landWhy(shape.pr));
}
function judgeAppCreate(text, pwsh, deps, dir, cmd, read) {
  return homeRead(inApp(deps, () => appCreate(text, pwsh, deps, dir, cmd, read)));
}
var homeRead = (d) => d.action === "deny" ? { ...d, homeFlags: true } : d;
function coveredCall(deps, dir, body) {
  let place;
  try {
    place = appPlace(deps, dir);
  } catch (err) {
    throw err instanceof AppScopeError ? new AppScopeError(err.inner, false) : err;
  }
  if (!place.covered) return passOf(place, dir, "other");
  try {
    return body(place);
  } catch (err) {
    throw new AppScopeError(err instanceof AppScopeError ? err.inner : err, false);
  }
}
function appCreate(text, pwsh, deps, dir, cmd, read) {
  return coveredCall(deps, dir, (place) => appCreateIn(text, pwsh, deps, dir, cmd, place, read));
}
function appCreateIn(text, pwsh, deps, dir, cmd, place, read) {
  const cr = read ?? createRead(text, pwsh);
  if (cr.bad !== null) return deny("head-unresolved", createBadWhy(dir, cr.bad));
  const heads = cr.heads;
  if (heads.length > 1) return deny("head-unresolved", appManyHeadsWhy(dir, heads));
  const owner = /^([^:\s]+):/.exec(heads[0] ?? "")?.[1] ?? null;
  if (owner !== null) return deny("head-foreign", appHeadOwnerWhy(dir, owner));
  const branch = readBranch(heads[0] ?? null, deps, dir);
  if (branch === "") return deny("head-unresolved", appHeadWhy(dir));
  if (cr.bases.length > 1) return deny("base-unresolved", appManyBasesWhy(dir, cr.bases));
  const base = cr.bases[0] ?? null;
  const repo = appRepoFor(cmd, deps, dir, place, { sub: "open-pr", branch, ...base === null ? {} : { base } });
  if ("action" in repo) return repo;
  const r = deps.git(dir, ["rev-parse", `${branch}^{commit}`]);
  if (r.status !== 0) return deny("head-unresolved", appHeadReadWhy(dir, branch));
  const head = r.stdout.trim();
  const d = decisionRead2({ step: "open-pr", key: openPrKey2({ repo: repo.key, branch, base }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny("open-pr", appOpenPrWhy(deps, dir, repo, branch, head, base));
}
function judgeAppMerge(shape, deps, dir, cmd) {
  return homeRead(inApp(deps, () => appMerge(shape, deps, dir, cmd)));
}
function appMerge(shape, deps, dir, cmd) {
  return coveredCall(deps, dir, (place) => appMergeIn(shape, deps, dir, cmd, place));
}
function appMergeIn(shape, deps, dir, cmd, place) {
  if (shape.pr === null) return deny("no-pr", appNoPrWhy(dir));
  const repo = appRepoFor(cmd, deps, dir, place, { sub: "merge", pr: shape.pr });
  if ("action" in repo) return repo;
  if (shape.shaBad) return deny("merge-no-head", `PR #${prose(shape.pr)} (folder ${at(dir)}): ${HEAD_UNREAD_WHY(shape.pr)}`);
  const sha = shape.sha ?? null;
  if (!sha) return deny("merge-no-head", appMergeNoHeadWhy(deps, dir, shape.pr, repo.offer));
  const key = decisionKey2({ repo: repo.key, pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isMergeNowLabel(r.label) && r.head.toLowerCase() === sha);
  return ok ? ALLOW : deny("land", appMergeWhy(deps, dir, repo, shape.pr));
}
function resolveDir(base, value, shell) {
  const raw = value.includes("\\") ? unquotePath(value, shell) : value;
  if (hasUnexpandedPart(value)) return UNEXPANDED + raw;
  const t = shell === "bash" ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve3(base, t);
}
function dirsAfter(cwd, cds, shell, loose, dir = null) {
  const dirs = cds.length === 0 ? [cwd] : [...loose ? [cwd] : [], ...cds.map((_, i) => pushDir(cwd, cds.slice(0, i + 1), shell))];
  return [...new Set(dirs.map((d) => dir === null ? d : resolveDir(d, dir, shell)))];
}
var pushDirsOf = (p, cwd, shell) => dirsAfter(cwd, p.cds, shell, p.loose, p.dir);
var POSITION_WHY = "popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.";
function judgeAt(s, deps, cwd, shell, named) {
  const at2 = s.at;
  const cmd = cmdRepoOf(s, named, deps.env);
  const dirs = dirsAfter(cwd, at2.cds, shell, at2.loose);
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0 && s.kind !== "land") return [unexpandedDeny(deps, [cwd, ...dirs], lost, "other", "other")];
  if (at2.unknown && s.kind !== "land") {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = cmd.named === CCV3_REPO || all.some((d) => isCcv3Checkout(deps, d));
    return ccv3 ? [deny("position-unknown", POSITION_WHY)] : appPositionAt(deps, all, "other", s.kind === "create" ? { sub: "open-pr" } : { sub: "merge", pr: s.pr ?? "<pr>" });
  }
  return dirs.map((d) => s.kind === "create" ? judgeCreate(s, deps, d, cmd) : judgeLand(s, deps, d, cmd));
}
function unexpandedDeny(deps, dirs, lost, scope, appScope, soft = true) {
  const dir = firstCovered(deps, knownDirs(dirs, deps.home));
  if (dir === null) return deny("cd-unexpanded", unexpandedWhy(lost), scope);
  const d = { ...deny("cd-unexpanded", unexpandedWhy(lost) + inAppFolder(dir), appScope), homeFlags: true };
  return soft ? { ...d, tapPath: true } : d;
}
var softPush = (p, subagent) => !subagent && !p.force && !p.unsafeOpt && !p.repoOpt && !p.oBundle && p.widerOpt === null;
function appPositionAt(deps, dirs, scope, offer) {
  let notice = null;
  for (const dir of dirs) {
    const place = appPlace(deps, dir);
    if (place.covered) return [{ ...deny("position-unknown", inApp(deps, () => appPositionWhy(deps, dir, offer)), scope), homeFlags: true }];
    if (place.corrupt) return [registryCorruptDeny(place.corrupt, dir, scope)];
    notice ??= place.notice ?? null;
  }
  return notice === null ? [] : [{ action: "allow", notice }];
}
var pushOffer = (p) => ({ sub: "push", remote: p.remote });
var hardUnlessUnregistered = (d, unregistered) => unregistered ? d : hardOf(d);
function judgePushAt(s, deps, cwd, shell, ctx, sink) {
  const { subagent, chained, alone } = ctx;
  const emit = (d) => {
    if (d.action === "deny") sink?.(d);
    return d;
  };
  const p = s.push;
  const dirs = pushDirsOf(p, cwd, shell);
  const chainOnly = chainDirsOf(p, cwd, shell).filter((d) => !dirs.includes(d) && firstCovered(deps, [d]) !== null);
  const c4 = { ...ctx, commitDirs: dirsAfter(cwd, p.cds, shell, p.loose, null) };
  const fromChain = [];
  for (const d of chainOnly) fromChain.push(emit(judgeAppPushAt(s, deps, d, subagent, chained, alone, ctx.flow, c4)));
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0) return [unexpandedDeny(deps, [cwd, ...dirs], lost, "push", "app-push", softPush(p, subagent))];
  const fixedByDir = p.dir !== null && resolveDir("/a", p.dir, shell) === resolveDir("/b", p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = all.some((d) => isCcv3Checkout(deps, d));
    if (ccv3) return [intentDeny(p, subagent, deny("position-unknown", POSITION_WHY, "push"))];
    const app = appPositionAt(deps, all, "app-push", pushOffer(p));
    if (app.some((d) => d.action === "deny")) return app;
  }
  const result = [...fromChain];
  for (const d of dirs) result.push(emit(judgePush(s, deps, d, c4)));
  return result;
}
function remoteKind(remote) {
  const r = remote.toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return "origin";
  return r === "fork" || r.includes(CCV3_REPO) ? "fork" : null;
}
var outsideHeads = (p) => [p.src, p.branch].some((r) => typeof r === "string" && (r.startsWith("refs/") && !r.startsWith("refs/tags/") || r.includes("*")));
var hardOf = (d) => ({ ...d, hard: true });
function intentDeny(p, subagent, fallback) {
  if (subagent) return hardOf(deny("subagent", SUBAGENT_WHY, "push"));
  const r = (p.remote ?? "").toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return hardOf(deny("push-origin", PUSH_ORIGIN_WHY, "push"));
  if (p.force || p.unsafeOpt || p.wideOpt) return hardOf(deny("push-unsafe", PUSH_UNSAFE_WHY, "push"));
  if (outsideHeads(p)) return hardOf(deny("push-target-unresolved", PUSH_REFSPEC_WHY, "push"));
  if (p.repoOpt) return hardOf(deny("push-target-unresolved", PUSH_REPO_OPT_WHY, "push"));
  return fallback;
}
var SCAN_MAX_FILES = 2e3;
var SCAN_MAX_COMMITS = 200;
var SCAN_MAX_BYTES = 8e6;
var SCAN_READ_MS = 6e3;
var SCAN_RESERVE_MS = 1500;
var SCAN_MIN_READ_MS = 300;
var COMMIT_MARK = "c5";
var FORK_MAIN = "refs/remotes/fork/main";
var SPLIT_WAY_OUT = "Every later push of this branch reads the same commits (the range is fork/main..head). Ways out: a new branch from fork/main that does not carry those commits, or a history rewrite with Dave's yes.";
var ScanClockError = class extends Error {
};
function budgetedDeps(deps) {
  if (!deps.scanLeft) return deps;
  const left = () => deps.scanLeft() - SCAN_RESERVE_MS;
  return {
    ...deps,
    git: (cwd, args, opts) => {
      const ms = left();
      if (ms < SCAN_MIN_READ_MS) throw new ScanClockError("budget");
      return deps.git(cwd, args, { ...opts, timeout: Math.min(opts?.timeout ?? GIT_TIMEOUT_MS, ms) });
    }
  };
}
function scanHoldout(p, deps, dir, branch, chained, alone) {
  if (!deps.holdoutIds || !deps.answerKeyHits) return null;
  try {
    return scanHoldoutRead(p, budgetedDeps(deps), dir, branch, chained, alone);
  } catch (e) {
    if (e instanceof ScanClockError || errCode(e) === "ETIMEDOUT") return clockDeny(branch);
    return hardOf(deny("holdout-scan-unavailable", `this push of ${branch} cannot be checked for holdout ids: a git read failed. Run the push again from the repo.`, "push"));
  }
}
function chainedAnswerKeyPaths(deps, dir) {
  const reads = [
    ["diff", "--name-only", "--no-renames", "-z", `${FORK_MAIN}...HEAD`],
    ["diff", "--name-only", "--no-renames", "-z", "--cached"],
    ["diff", "--name-only", "--no-renames", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ];
  const all = /* @__PURE__ */ new Set();
  for (const args of reads) {
    const r = deps.git(dir, args);
    if (r.status !== 0) return "unreadable";
    for (const f of r.stdout.split("\0")) if (f) all.add(f);
    if (all.size > SCAN_MAX_FILES) return "too-large";
  }
  return deps.answerKeyHits([...all]).length > 0 ? "hit" : "none";
}
var headName = (ref) => ref.replace(/^(?:refs\/)?heads\//, "");
function sendsRe(p, deps, dir, branch) {
  if (headName(branch).startsWith("re/")) return true;
  if (p.src === null && p.branch === null) return false;
  const src = headName(p.src ?? "HEAD");
  if (src.startsWith("re/")) return true;
  return /^(?:HEAD|@)(?:$|[~^@])/.test(src) && currentBranch(deps, dir).startsWith("re/");
}
var RE_NOT_ALONE_WHY = "the push output goes to a pipe or a redirect, or another step runs in the same command, so this gate does not scan this form. Run the push with no pipe and no redirect, as its own command: git push <remote> <branch>.";
function namedTags(p, deps, dir) {
  const out3 = /* @__PURE__ */ new Set();
  for (const r of [p.src, p.branch]) {
    if (typeof r !== "string" || r === "") continue;
    if (r.startsWith("refs/tags/")) {
      out3.add(r);
      continue;
    }
    if (r.startsWith("refs/") || /^(?:HEAD|@)(?:$|[~^@])/.test(r)) continue;
    if (r.startsWith("tags/")) {
      out3.add(`refs/${r}`);
      continue;
    }
    if (deps.git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${r}`]).status === 0) out3.add(`refs/tags/${r}`);
  }
  return [...out3];
}
function tagText(wide, sha, deps, dir, stop) {
  const fmt = "--format=%(refname)%00%(objecttype)%00%(contents)%00";
  const reads = [wide ? ["for-each-ref", fmt, "refs/tags"] : ["for-each-ref", fmt, "--merged", sha, "refs/tags"]];
  let text = "";
  for (const args of reads) {
    let t;
    try {
      t = deps.git(dir, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
    } catch (e) {
      if (errCode(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its local tags are over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
      throw e;
    }
    if (t.status !== 0) return stop("holdout-scan-unavailable", "the local tags could not be read. Run the push again from the repo.");
    const f = t.stdout.split("\0");
    for (let i = 0; i + 2 < f.length; i += 3) text += `${f[i].replace(/^\n+/, "")}
${f[i + 1] === "tag" ? `${f[i + 2]}
` : ""}`;
  }
  return text;
}
var clockDeny = (branch) => hardOf(deny("holdout-scan-unavailable", `this push of ${branch} cannot be checked: the time of the hook ran out before its reads could run. Run the push again when the machine is less busy.`, "push"));
var SHIP_RESERVE_MS = 1500;
var errCode = (e) => String(e?.code ?? "");
function addedText(log) {
  const out3 = [];
  let inDiff = false;
  let binary = false;
  let width = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      inDiff = false;
      width = 0;
      out3.push(line);
      continue;
    }
    if (line.startsWith("diff --")) {
      inDiff = true;
      width = 0;
      out3.push(line);
      continue;
    }
    const at2 = inDiff ? /^(@{2,}) /.exec(line) : null;
    if (at2) {
      width = at2[1].length - 1;
      continue;
    }
    if (inDiff && width === 0 && /^Binary files (?:.* )?differ$/.test(line)) binary = true;
    if (width === 0) {
      out3.push(line);
      continue;
    }
    if (line.slice(0, width) === "+".repeat(width)) out3.push(line);
  }
  return { text: out3.join("\n"), binary };
}
function scanHoldoutRead(p, deps, dir, branch, chainedCommit, alone) {
  const isRe = sendsRe(p, deps, dir, branch);
  const chained = chainedCommit || !alone;
  const stop = (pattern, why) => hardOf(deny(pattern, `this push of ${branch} cannot be checked for holdout ids: ${why}`, "push"));
  if (isRe && chainedCommit) return stop("holdout-scan-unavailable", "the same command also commits or changes the branch, so the new content cannot be read yet. Commit first, then push in a separate command.");
  if (isRe && chained) return stop("holdout-scan-unavailable", RE_NOT_ALONE_WHY);
  if (!isRe && chained) {
    const hit = chainedAnswerKeyPaths(deps, dir);
    if (hit === "unreadable") return stop("holdout-scan-unavailable", "the same command also changes files, and the paths it can change could not be read. Commit first, push in a separate command.");
    if (hit === "too-large") return stop("holdout-scan-too-large", `the same command also changes more than ${SCAN_MAX_FILES} files. Commit first, push in a separate command.`);
    if (hit === "hit") return stop("holdout-chained-answer-key", "the same command also changes an answer-key path, so the new content cannot be read yet. Commit first, push in a separate command.");
  }
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return stop("holdout-scan-unavailable", "its source ref starts with a dash. Name the branch: git push <remote> <branch>.");
  const sha = deps.git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const named = namedTags(p, deps, dir);
  const scanned = isRe || named.length > 0 || p.force;
  const allTags = scanned && p.force ? ["--tags"] : [];
  if (sha.status !== 0 || sha.stdout.trim() === "") return scanned ? stop("holdout-scan-unavailable", "its head could not be read. Run the push again from the repo.") : null;
  const head = sha.stdout.trim();
  const range = `${FORK_MAIN}..${head}`;
  let names;
  try {
    names = deps.git(dir, ["log", "--cc", "--root", "--name-only", "--no-renames", "-z", "--format=%x01c5%x00%H", ...allTags, range], { timeout: GIT_TIMEOUT_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
  } catch (e) {
    if (errCode(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its commit list is over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
    throw e;
  }
  if (names.status !== 0) return stop("holdout-scan-unavailable", "the commits against fork/main could not be read. Run git fetch fork main in the repo, then push again.");
  const tokens = names.stdout.split("\0").map((t) => t.replace(/^\n+/, ""));
  const commits = tokens.filter((t) => t === COMMIT_MARK).length;
  const files = tokens.filter((t, i) => t !== "" && t !== COMMIT_MARK && tokens[i - 1] !== COMMIT_MARK);
  if (!scanned && deps.answerKeyHits(files).length === 0) return null;
  if (commits > SCAN_MAX_COMMITS) return stop("holdout-scan-too-large", `it sends ${commits} commits, over the bound of ${SCAN_MAX_COMMITS}. ${SPLIT_WAY_OUT}`);
  if (new Set(files).size > SCAN_MAX_FILES) return stop("holdout-scan-too-large", `it changes ${new Set(files).size} files, over the bound of ${SCAN_MAX_FILES}. ${SPLIT_WAY_OUT}`);
  let ids;
  try {
    ids = deps.holdoutIds(dir);
  } catch {
    return stop("holdout-scan-unavailable", "the holdout id list could not be read, so the scan cannot run.");
  }
  if (!Array.isArray(ids) || ids.length === 0) return stop("holdout-scan-unavailable", "the holdout id list is empty, so the scan cannot run.");
  let log;
  try {
    log = deps.git(dir, ["log", "-p", "--cc", "--root", "--encoding=UTF-8", "--text", "--no-textconv", "--no-ext-diff", "--unified=0", "--no-color", "--no-renames", "--format=%x01c5 %H%n%w(0,1,1)%B", ...allTags, range], { timeout: SCAN_READ_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
  } catch (e) {
    if (errCode(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its commit content is over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
    throw e;
  }
  if (log.status !== 0) return stop("holdout-scan-unavailable", "the commit content could not be read. Run the push again from the repo.");
  const tags = tagText(p.force, head, deps, dir, stop);
  if (typeof tags !== "string") return tags;
  const added = addedText(log.stdout);
  if (added.binary) return stop("holdout-scan-unavailable", `it sends a binary file that git prints only as "Binary files differ" (a merge resolution), so its content cannot be read. ${SPLIT_WAY_OUT}`);
  const all = `${added.text}
${files.join("\n")}
${tags}
${named.join("\n")}
${p.branch ?? ""}`;
  const count = countIdsIn2(`${all}
${all.replace(/\0/g, "")}`, ids);
  if (count === 0) return null;
  return hardOf(deny("holdout-id", `this push of ${branch} carries ${count} holdout id${count === 1 ? "" : "s"} in the added lines, commit messages, file names or tag messages of what it sends (an older commit of the branch counts too). Remove them from every commit and local tag. ${SPLIT_WAY_OUT} Which ones stays with the seat: this text names a count only.`, "push"));
}
function judgePush(shape, deps, dir, ctx) {
  const { subagent, chained, alone } = ctx;
  const p = shape.push;
  const d = (pattern, why) => deny(pattern, why, "push");
  if (p.moved) {
    const what = "--git-dir or --work-tree moves the repo, so the checkout is unknown";
    const app = firstCovered(deps, moveTargets(ctx.text, dir, ctx.shell, deps.home)) ?? coveredAmong(deps, [dir]);
    if (app !== null) return deny("push-target-unresolved", appPushUnresolvedWhy(app, what), "app-push");
    return intentDeny(p, subagent, hardUnlessUnregistered(d("push-target-unresolved", pushUnresolvedWhy(what)), ctx.unregistered));
  }
  if (!isCcv3Checkout(deps, dir)) return judgeAppPushAt(shape, deps, dir, subagent, chained, alone, ctx.flow, ctx);
  if (p.repoOpt) return hardOf(subagent ? d("subagent", SUBAGENT_WHY) : d("push-target-unresolved", PUSH_REPO_OPT_WHY));
  let remote = p.remote;
  if (remote === null) {
    const up = deps.git(dir, ["rev-parse", "--abbrev-ref", "@{push}"]);
    remote = up.status === 0 && up.stdout.trim() !== "" ? up.stdout.trim().split("/")[0] : "fork";
  }
  let kind = remoteKind(remote);
  if (kind === null) {
    const u = deps.git(dir, ["remote", "get-url", remote]);
    if (u.status === 0) kind = remoteKind(u.stdout.trim());
  }
  if (kind === "origin") return hardOf(d("push-origin", PUSH_ORIGIN_WHY));
  if (kind === null) return ALLOW;
  if (subagent) return hardOf(d("subagent", SUBAGENT_WHY));
  if (p.wideOpt || p.unsafeOpt && !p.force) return hardOf(d("push-unsafe", PUSH_UNSAFE_WHY));
  if (outsideHeads(p)) return hardOf(d("push-target-unresolved", PUSH_REFSPEC_WHY));
  if (!ctx.modelled) return hardOf(d("push-state-unknown", PUSH_STATE_WHY));
  const branch = p.branch ?? currentBranch(deps, dir);
  if (p.force && (branch === "main" || branch === "")) return hardOf(d("push-unsafe", PUSH_UNSAFE_WHY));
  if (branch !== "") {
    const scanned = scanHoldout(p, deps, dir, branch, chained, alone);
    if (scanned !== null) return scanned;
  }
  if (p.force) return d("push-unsafe", PUSH_UNSAFE_WHY);
  if (branch === "") return d("push-target-unresolved", pushUnresolvedWhy("the branch of this push cannot be named (detached HEAD?)"));
  if (branch === "main") return ALLOW;
  if (deps.scanLeft && deps.scanLeft() < SHIP_RESERVE_MS) return clockDeny(branch);
  const texts = {
    notRef: (ref) => pushUnresolvedWhy(`${ref} is not a ref`),
    tree: (what) => `cannot read the tree of ${what} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`,
    ship: () => pushWhy(branch)
  };
  return shipTap({ p, deps, dir, chained, alone, key: decisionKey2({ branch }), scope: "push", texts, commitDirs: ctx.commitDirs });
}
function currentBranch(deps, dir) {
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
function shipTap({ p, deps, dir, chained, alone, key, scope, texts, pushOnlyHead, commitDirs }) {
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return deny("push-target-unresolved", texts.notRef(ref), scope);
  if (chained && p.dir !== null && !sameCheckout(deps, commitDirs ?? [], dir)) return deny("push-tree-unresolved", PUSH_CHECKOUT_WHY, scope);
  const viaIndex = chained && (p.src === null || deps.git(dir, ["branch", "--show-current"]).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ["write-tree"]) : deps.git(dir, ["rev-parse", `${ref}^{tree}`]);
  if (r.status !== 0) return deny("push-tree-unresolved", texts.tree(viaIndex ? "the index (git write-tree)" : ref), scope);
  const tree = r.stdout.trim();
  let refHead;
  const headOf = () => {
    if (refHead === void 0) {
      const h = deps.git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
      refHead = h.status === 0 && h.stdout.trim() !== "" ? h.stdout.trim().toLowerCase() : null;
    }
    return refHead;
  };
  const pushOnly = (head) => !pushOnlyHead || headOf() !== null && head.toLowerCase() === headOf();
  const ok = decisionRows(deps.env).some((row) => row.step === "ship" && row.key === key && row.tree !== null && row.tree === tree && (isShipLabel(row.label) || !viaIndex && alone && isPushOnlyLabel(row.label) && pushOnly(row.head)));
  return ok ? ALLOW : deny("ship", texts.ship(), scope);
}
function judgeAppPushAt(shape, deps, dir, subagent, chained, alone, flow, ctx) {
  const place = appPlace(deps, dir);
  if (!place.covered) return passOf(place, dir, "app-push");
  try {
    return inApp(deps, () => judgeAppPush(shape, deps, dir, place, subagent, chained, alone, flow, ctx));
  } catch (err) {
    throw new AppScopeError(err);
  }
}
var FIXED_DEFAULTS = /* @__PURE__ */ new Set(["main", "master"]);
var destBranch = (dest) => dest.replace(/^refs\//, "").replace(/^heads\//, "");
function remoteHeadOf(deps, dir, remote) {
  const r = deps.git(dir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  const text = r.status === 0 ? r.stdout.trim() : "";
  if (text === "") return void 0;
  const prefix = `${remote}/`;
  const hit = [text, text.replace(/^remotes\//, ""), text.replace(/^refs\/remotes\//, "")].find((s) => s.startsWith(prefix));
  return hit === void 0 ? null : hit.slice(prefix.length);
}
var DEFAULT_RISK = { kind: "default" };
var UNSURE_RISK = { kind: "unsure" };
function pushRisk(deps, dir, p, k, id, config) {
  const dest = destBranch(k.branch);
  if (FIXED_DEFAULTS.has(dest.toLowerCase())) return DEFAULT_RISK;
  if (!p.plain || config.kind !== "none" || !k.configured || !strictBranch(dest) || !remoteNamesOf(deps, dir).includes(k.remote)) return UNSURE_RISK;
  if (deps.git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${dest}`]).status !== 1) return UNSURE_RISK;
  return headRisk(deps, dir, k, dest, id);
}
var remoteNamesOf = (deps, dir) => deps.git(dir, ["remote"]).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function headRisk(deps, dir, k, dest, id) {
  const url = fetchUrlOf(deps, dir, k.remote);
  if (url === null || keyRepo2({ url, ...id }) !== k.key) return UNSURE_RISK;
  const head = remoteHeadOf(deps, dir, k.remote);
  if (head === void 0 || head === null) return { kind: "no-head", remote: k.remote };
  return head.toLowerCase() === dest.toLowerCase() ? DEFAULT_RISK : null;
}
function fetchUrlOf(deps, dir, remote) {
  const r = deps.git(dir, ["remote", "get-url", remote]);
  const url = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
  return url === "" ? null : url;
}
var PUSH_CONFIG_RE = "^(push\\.(default|followtags|recursesubmodules)|submodule\\.recurse|remote\\..*\\.(push|mirror))$";
var FALSE_WORDS = /* @__PURE__ */ new Set(["false", "no", "off", "0"]);
var RANK = { none: 0, widens: 1, wider: 2, unsafe: 3 };
function pushConfigOf(deps, dir, remote, p) {
  const r = deps.git(dir, ["config", "--get-regexp", PUSH_CONFIG_RE]);
  if (r.status === 1 && r.stdout.trim() === "") return { kind: "none", key: "" };
  if (r.status !== 0) return { kind: "widens", key: "" };
  let found = { kind: "none", key: "" };
  for (const line of r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line.trim() : line.slice(0, sp);
    const raw = sp < 0 ? "" : line.slice(sp + 1).trim();
    const kind = configKind(key, raw, remote, p);
    if (RANK[kind] > RANK[found.kind]) found = { kind, key };
  }
  return found;
}
function configKind(key, raw, remote, p) {
  const value = raw.toLowerCase();
  const on = !FALSE_WORDS.has(value);
  if (key === `remote.${remote}.mirror`) return on ? "unsafe" : "none";
  if (key === `remote.${remote}.push`) return raw.startsWith("+") ? "unsafe" : p.oneSide ? "wider" : "widens";
  if (key === "push.default") return value === "matching" && p.bare ? "wider" : "none";
  if (key === "push.recursesubmodules") return on && value !== "check" && !p.noRecurse ? "wider" : "none";
  if (key === "submodule.recurse") return on && !p.noRecurse ? "wider" : "none";
  if (key === "push.followtags") return on && !p.noFollowTags ? "wider" : "none";
  return "none";
}
function judgeAppPush(shape, deps, dir, place, subagent, chained, alone, flow, ctx) {
  const p = shape.push;
  const d = (pattern, why) => deny(pattern, why, "app-push");
  if (subagent) return d("subagent", appSubagentWhy(dir));
  if (p.force || p.unsafeOpt) return d("push-unsafe", appUnsafeWhy(dir));
  if (p.repoOpt) return d("push-target-unresolved", appRepoOptWhy(dir));
  if (p.oBundle) return d("push-target-unresolved", appBundleWhy(dir));
  if (p.widerOpt !== null) return d("push-target-unresolved", appWiderOptWhy(dir, p.widerOpt));
  const named = p.branch === "@" ? null : p.branch;
  const branch = named ?? (p.bare ? null : currentBranch(deps, dir));
  const k = pushKey2(gitIn(deps, dir), { remote: p.remote, branch, entryKey: place.entryKey, github: place.github });
  if (!k.ok && k.why === "multi-pushurl") return d("push-urls", appPushUrlsWhy(dir, k.remote ?? "", k.keys ?? []));
  if (!k.ok && k.why === "no-branch") return d("push-target-unresolved", appPushUnresolvedWhy(dir, "the branch of this push cannot be named (detached HEAD?)"));
  if (!k.ok) return d("push-remote-unresolved", appNameRemoteWhy(deps, dir));
  if (p.src?.startsWith("-")) return d("push-target-unresolved", appPushUnresolvedWhy(dir, `${p.src} is not a ref`));
  const config = pushConfigOf(deps, dir, k.remote, p);
  if (config.kind === "unsafe") return d("push-unsafe", appUnsafeConfigWhy(dir, k.remote, config.key));
  if (config.kind === "wider") return d("push-target-unresolved", appWiderConfigWhy(dir, config.key));
  const risk = pushRisk(deps, dir, p, k, { entryKey: place.entryKey, github: place.github }, config);
  if (risk === null) return ALLOW;
  const offer = { sub: "push", remote: k.remote, branch: k.branch, src: p.src === null || p.src === "@" ? "HEAD" : p.src };
  const texts = {
    notRef: (ref) => appPushUnresolvedWhy(dir, `${ref} is not a ref`),
    tree: (what) => appTreeWhy(dir, what),
    // Seat ruling a: no Push only tap counts for a push that is not alone and has no commit before it, so the text names the way out.
    // The Commit and push flow (git add, git commit, then the push: flow) keeps the ship text: its tap is the way out.
    ship: () => alone || chained || flow ? appPushWhy(deps, dir, k.key, k.branch, offer, risk) : appNotAloneWhy(deps, dir, offer)
  };
  const q = p.src === "@" ? { ...p, src: null } : p;
  if (ctx !== void 0 && !ctx.modelled) return { ...d("push-state-unknown", `${PUSH_STATE_WHY} (folder ${at(dir)})`), tapPath: true };
  const r = shipTap({ p: q, deps, dir, chained, alone, key: decisionKey2({ repo: k.key, branch: k.branch }), scope: "app-push", texts, pushOnlyHead: true, commitDirs: ctx?.commitDirs });
  return r.action === "deny" ? { ...r, tapPath: true } : r;
}
var MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function movesRepo(text) {
  return MOVE_ENV_RAW.test(text) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes(text));
}
function judgeCommand(input, deps, notes, denies = []) {
  const cmd = readCommand(input);
  if (cmd.kind !== "command" || cmd.text === "") return denies;
  const cwd = input.cwd || process.cwd();
  if (storeWriteCall(input, deps)) denies.push(deny("store-write", STORE_WHY));
  if (paidTripwire(input)) denies.push(deny("paid-coderabbit", PAID_WHY));
  if (capOverrideDeny(input, deps)) denies.push(deny("cap-override", CAP_WHY));
  for (const d of [...scriptRunnerDenies(deps.parsed), ...scriptRunnerLateDenies(deps.parseLate)]) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  for (const d of parseErrorDenies(deps.parsed)) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  const shapes = shapesOf(cmd.text, cmd.tool, deps.parsed, deps.astOnly === true);
  const shell = shellOf(input);
  if (input.agent_id && shapes.some((s) => s.kind !== "push")) denies.push(subagentDeny(shapes, deps, cwd, shell));
  const pushes = shapes.filter((s) => s.kind === "push");
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== "push");
  const add = (d) => {
    if (!denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope && o.tapPath === d.tapPath)) denies.push(d);
  };
  if (pushes.length > 0 || rest.length > 0) {
    const named = namedRepo(cmd.text, deps.env);
    const prefix = pushes.length > 0 ? pushPrefix(cmd.text, shell) : null;
    const chained = pushes.length > 0 && (commitPrecedesPush(cmd.text, shell) || prefix !== null && commitPrecedesPush(prefix.prefix, shell));
    const alone = pushes.length > 0 && pushesAlone(cmd.text, shell);
    let lookupDirs;
    const lookupBudget = { left: MAX_LOOKUP_CALLS };
    const remoteIsLocal = (name) => remoteNameIsLocal(deps, cwd, lookupDirs ??= rawDirs(cmd.text, cmd.tool, cwd, shell, deps.home), name, lookupBudget);
    const modelled = pushes.length === 0 || stateModelled(cmd.text, shell, { parsed: deps.parsed, remoteIsLocal });
    const moved = movesRepo(cmd.text);
    const unregistered = (moved || pushes.some((s) => s.push.moved)) && pushFoldersUnregistered(input, deps);
    for (const s of [...rest, ...pushes]) {
      if (moved && s.kind !== "land") {
        denies.push(movedDeny(s, deps, cwd, shell, cmd.text, Boolean(input.agent_id), unregistered));
        continue;
      }
      const found = s.kind === "push" ? judgePushAt(s, deps, cwd, shell, { subagent: Boolean(input.agent_id), chained, alone, flow: pushes.length > 0 && shipFlow(cmd.text, shell), text: cmd.text, shell, modelled, unregistered }, add) : judgeAt(s, deps, cwd, shell, named);
      for (const d of found) {
        if (d.action === "deny") add(d);
        else if (d.notice) notes.add(d.notice);
      }
    }
  }
  for (const d of rawPushDenies(cmd.text, cmd.tool, deps, cwd, shell, Boolean(input.agent_id))) add(d);
  for (const d of hiddenGhDenies(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  for (const d of ghFlagFirstDenies(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  return denies;
}
function subagentDeny(shapes, deps, cwd, shell) {
  const base = deny("subagent", SUBAGENT_WHY);
  const covered = shapes.some((s) => s.kind !== "push" && coveredAmong(deps, (s.at ? dirsAfter(cwd, s.at.cds, shell, s.at.loose) : [cwd]).filter((d) => !isUnexpanded(d))) !== null);
  return covered ? { ...base, homeFlags: true } : base;
}
function paidTripwire(input) {
  const cmd = readShellCommand(input);
  return cmd.kind === "command" && PAID_MENTION_RE.test(cmd.text) && PAID_FLAG_RE.test(cmd.text);
}
function capSpelling(part) {
  if (part === "extra") return "--cli-extra-run";
  const usd = /^usd=([0-9]+(?:\.[0-9]{1,2})?)$/.exec(part)?.[1];
  return usd === void 0 ? null : `--cli-cap-usd ${usd}`;
}
function withoutApproved(text, flagSet) {
  let rest = text;
  for (const part of flagSet.split(",")) {
    const spelling = capSpelling(part);
    if (spelling === null) return null;
    const re = new RegExp(`(?<=^|[\\s"';()|&])${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"';)|&])`, "g");
    if (!re.test(rest)) return null;
    rest = rest.replace(re, " ");
  }
  return rest;
}
function capOverrideDeny(input, deps) {
  try {
    const cmd = readShellCommand(input);
    if (cmd.kind !== "command" || !CAP_FLAG_RE.test(cmd.text)) return false;
    if (input.agent_id) return true;
    const cwd = input.cwd || process.cwd();
    const branch = deps.git(cwd, ["branch", "--show-current"]);
    const head = deps.git(cwd, ["rev-parse", "HEAD"]);
    const name = branch.status === 0 ? branch.stdout.trim() : "";
    const sha = head.status === 0 ? head.stdout.trim().toLowerCase() : "";
    if (name === "" || !/^[0-9a-f]{40}$/.test(sha)) return true;
    const prefix = `${decisionKey2({ branch: name })}${CAP_KEY_MARK}`;
    return !decisionRows(deps.env).some((r) => {
      if (r.step !== "cli-skip" || r.head.toLowerCase() !== sha || !r.key.startsWith(prefix) || !CAP_LIFT_RE.test(r.label)) return false;
      const rest = withoutApproved(cmd.text, r.key.slice(prefix.length));
      return rest !== null && !CAP_FLAG_RE.test(rest);
    });
  } catch {
    return true;
  }
}
function storeWriteCall(input, deps) {
  try {
    const cmd = readShellCommand(input);
    return cmd.kind === "command" && cmd.text !== "" && writesStoreText(cmd.text, deps);
  } catch {
    return false;
  }
}
function movedDeny(s, deps, cwd, shell, text, subagent = false, unregistered = false) {
  const dirs = s.kind === "push" ? pushDirsOf(s.push, cwd, shell) : dirsAfter(cwd, s.at.cds, shell, s.at.loose);
  const targets = s.kind === "push" ? [...new Set([cwd, ...dirs].flatMap((d) => isUnexpanded(d) ? [] : moveTargets(text, d, shell, deps.home)))] : [];
  const dir = firstCovered(deps, targets) ?? coveredAmong(deps, [cwd, ...dirs].filter((d) => !isUnexpanded(d)));
  if (s.kind === "push") {
    return dir === null ? intentDeny(s.push, subagent, hardUnlessUnregistered(deny("push-target-unresolved", pushUnresolvedWhy(MOVED_WHY), "push"), unregistered)) : deny("push-target-unresolved", MOVED_WHY + inAppFolder(dir), "app-push");
  }
  return dir === null ? deny("repo-moved", MOVED_WHY) : { ...deny("repo-moved", MOVED_WHY + inAppFolder(dir)), homeFlags: true };
}
function judgeWrite(input, deps) {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === "string" && isStorePath(args[f], deps, cwd));
  return hit ? [deny("store-write", STORE_WHY)] : [];
}
function judge(input, deps, notes, sink) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS.has(tool)) {
    sink.push(...judgeWrite(input, deps));
    return sink;
  }
  return COMMAND_TOOLS2.has(tool) ? judgeCommand(input, deps, notes, sink) : sink;
}
function decide(input, deps, found = []) {
  const notes = /* @__PURE__ */ new Set();
  const call = perCall(deps);
  CWDS.set(call, input.cwd || process.cwd());
  const denies = judge(input, call, notes, found);
  const notice = notes.size === 0 ? {} : { notice: [...notes][0] };
  if (denies.length === 0) return notes.size === 0 ? ALLOW : { action: "allow", ...notice };
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => hardAppDeny(d) || enforcingScope(d.scope, deps, cwd, d.homeFlags));
  if (live) {
    const { tapPath: _tap, homeFlags: _home, hard: _hard, ...shown } = live;
    return { ...shown, ...notice };
  }
  return { action: "allow", warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope, ...notice };
}
var hardAppDeny = (d) => d.hard === true || d.scope === "app-push" && d.tapPath !== true;
function perCall(deps) {
  const seen = /* @__PURE__ */ new Map();
  const mode = { app: false };
  const git = (cwd, args, opts) => {
    const run = mode.app && deps.appGit ? deps.appGit : deps.git;
    const key = `${run === deps.git ? "" : "app\0"}${cwd}\0${args.join("\0")}${opts ? `\0${JSON.stringify(opts)}` : ""}`;
    let hit = seen.get(key);
    if (!hit) {
      try {
        hit = { ok: opts ? run(cwd, args, opts) : run(cwd, args) };
      } catch (err) {
        hit = { err };
      }
      seen.set(key, hit);
    }
    if ("err" in hit) throw hit.err;
    return hit.ok;
  };
  const call = { ...deps, git };
  APP_MODE.set(call, mode);
  return call;
}
var APP_MODE = /* @__PURE__ */ new WeakMap();
function inApp(deps, run) {
  const mode = APP_MODE.get(deps);
  if (!mode || mode.app) return run();
  mode.app = true;
  try {
    return run();
  } finally {
    mode.app = false;
  }
}
var out2 = (extra) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...extra } }).replace(CREDS_RE, "$1");
var denyOut = (reason) => out2({ permissionDecision: "deny", permissionDecisionReason: reason });
var warnLead = (scope) => scope === "app-push" ? "this push in an app folder has no tap from Dave; it would be blocked in block mode." : `this command would be blocked when ${FLAG_OF[scope]} is true.`;
var warnOut = (text, scope = "other", tail = "") => out2({ additionalContext: `WARNING (decision-gate, warn mode): ${warnLead(scope)} ${text.replace(/^BLOCKED \(decision-gate\): /, "")}${tail}` });
function gatedScopes(input, app = false) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS.has(tool)) return /* @__PURE__ */ new Set(["other"]);
  const shapes = catchShapes(input);
  const scopes = new Set((shapes ?? []).map(scopeOf));
  if (app && (scopes.size > 0 || shapes === null)) scopes.add("app-push");
  return scopes;
}
function unreadableInput() {
  const note = "decision-gate: the hook input is not readable JSON, so no command shape can be judged; the call is allowed.";
  try {
    logGuardError(HOOK, new Error("unreadable hook input"));
  } catch {
  }
  try {
    process.stderr.write(`${note}
`);
  } catch {
  }
  return "{}";
}
function handle(raw, deps) {
  let input = {};
  try {
    const parsed = JSON.parse(raw.trim() || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unreadableInput();
    input = parsed;
  } catch {
    return unreadableInput();
  }
  const found = [];
  try {
    const d = decide(input, deps, found);
    const tail = d.notice ? `
${corruptLine(d.notice)}` : "";
    let shown = "{}";
    if (d.action === "allow" && d.warn) {
      logGuardDecision(HOOK, input, "warn", d.warn.split(":")[0]);
      shown = warnOut(d.warn.slice(d.warn.indexOf(":") + 2), d.scope, tail);
    } else if (d.action === "deny") {
      logGuardDecision(HOOK, input, "deny", d.pattern);
      shown = denyOut(d.reason + tail);
    } else if (d.notice) {
      shown = out2({ additionalContext: corruptLine(d.notice) });
    }
    if (d.notice) logGuardDecision(HOOK, input, "warn", `registry-missing ${fwd(d.notice)}: ${CORRUPT_EFFECT}`);
    return shown;
  } catch (err) {
    return unjudgeable(input, deps, err, found);
  }
}
function unjudgeable(input, deps, thrown, found = []) {
  const cwd = input.cwd || process.cwd();
  const underRoot = pushUnderLiveRoot(input, deps);
  const app = thrown instanceof AppScopeError || underRoot;
  const appPush = thrown instanceof AppScopeError && thrown.push || underRoot;
  const err = thrown instanceof AppScopeError ? thrown.inner : thrown;
  const gone = err instanceof MissingCwdError;
  if (!gone) {
    try {
      logGuardError(HOOK, err);
    } catch {
    }
  }
  const prior = found.find((d) => {
    try {
      return hardAppDeny(d) || enforcingScope(d.scope, deps, cwd, d.homeFlags);
    } catch {
      return d.hard === true;
    }
  }) ?? catchIntentDeny(input);
  if (prior) {
    try {
      logGuardDecision(HOOK, input, "deny", prior.pattern);
    } catch {
    }
    return denyOut(prior.reason);
  }
  const scopes = gatedScopesSafe(input, appPush);
  if (storeWriteCall(input, deps)) scopes.add("other");
  if (scopes.size === 0) return "{}";
  const raw = gone ? err.message : String(err?.message ?? err).slice(0, 160);
  const detail = app ? prose(raw) : raw;
  const hint = gone ? "Run the command from a folder that exists." : "Run the command again. If it keeps failing, ask Dave.";
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  const holdsPush = !app && scopes.has("push") && (gone || !pushFoldersUnregistered(input, deps));
  const live = holdsPush || app && hardAppCall(input) || [...scopes].some((s) => enforcingScope(s, deps, cwd, app));
  if (gone) logGuardDecision(HOOK, input, live ? "deny" : "warn", "cwd-missing");
  if (holdsPush && !(app && hardAppCall(input)) && ![...scopes].some((s) => enforcingScope(s, deps, cwd, app))) {
    const again = gone ? "Run the push again from a folder that exists." : "Run the push again. If it fails again, ask Dave.";
    return denyOut(`BLOCKED (decision-gate): the push check could not run (${detail}), so this push was not judged. This is not a policy block. ${again}`);
  }
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has("other") ? "other" : scopes.has("app-push") ? "app-push" : "push");
}
var gatedScopesSafe = (input, app = false) => {
  try {
    return gatedScopes(input, app);
  } catch {
    return /* @__PURE__ */ new Set();
  }
};
function catchIntentDeny(input) {
  const shapes = catchShapes(input);
  if (shapes === null) return null;
  const none = deny("none", "", "push");
  for (const s of shapes) {
    if (s.kind !== "push" || s.push === void 0) continue;
    const d = intentDeny(s.push, Boolean(input.agent_id), none);
    if (d.hard === true) return d;
  }
  return null;
}
function hardAppCall(input) {
  try {
    const cmd = readCommand(input);
    if (cmd.kind !== "command") return false;
    const pushes = shapesOf(cmd.text, cmd.tool).filter((s) => s.kind === "push");
    if (input.agent_id && pushes.length > 0) return true;
    if (rawVerdict(cmd.text, cmd.tool)?.kind === "unsafe") return true;
    return pushes.some(({ push: p }) => p !== void 0 && (p.force || p.unsafeOpt || p.repoOpt || p.oBundle || p.widerOpt !== null));
  } catch {
    return Boolean(input.agent_id);
  }
}
function catchShapes(input) {
  const cmd = readCommand(input);
  if (cmd.kind !== "command") return [];
  try {
    return shapesOf(cmd.text, cmd.tool);
  } catch {
    return null;
  }
}
function pushUnderLiveRoot(input, deps) {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand(input);
    if (!scope || cmd.kind !== "command") return false;
    const pushes = catchShapes(input)?.filter((s) => s.kind === "push") ?? null;
    if (pushes?.length === 0) return false;
    const reg = scope.registry();
    const cwd = input.cwd || process.cwd();
    const shell = shellOf(input);
    const paths = knownDirs((pushes ?? []).flatMap((s) => [cwd, ...pushDirsOf(s.push, cwd, shell), ...chainDirsOf(s.push, cwd, shell)]).concat(cwd), deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets(cmd.text, d, shell, deps.home))];
    return dirs.some((d) => underLiveRoot(d, reg, scope, { outsideCcv3: true }));
  } catch {
    return false;
  }
}
var CCV3_ENTRY_KEY = "continuous-claude";
function pushFoldersUnregistered(input, deps) {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand(input);
    if (!scope || cmd.kind !== "command") return false;
    const pushes = catchShapes(input)?.filter((s) => s.kind === "push");
    if (!pushes || pushes.length === 0) return false;
    const reg = scope.registry();
    if (reg.state !== "ok") return false;
    const cwd = input.cwd || process.cwd();
    const shell = shellOf(input);
    const raw = pushes.flatMap((s) => [cwd, ...pushDirsOf(s.push, cwd, shell), ...chainDirsOf(s.push, cwd, shell)]).concat(cwd);
    if (raw.some((d) => isUnexpanded(d))) return false;
    const paths = knownDirs(raw, deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets(cmd.text, d, shell, deps.home))];
    if (dirs.length === 0 || dirs.some((d) => !isAbsolute2(d) || isUnexpanded(d))) return false;
    return !dirs.some((d) => underRegistryRoot(d, reg, scope));
  } catch {
    return false;
  }
}
function underRegistryRoot(d, reg, scope) {
  const ccv3 = { ...reg, entries: reg.entries.filter((e) => e.key === CCV3_ENTRY_KEY).map((e) => ({ ...e, key: `${CCV3_ENTRY_KEY}#root`, status: "active", tapGate: null })) };
  return underLiveRoot(d, reg, scope) || underLiveRoot(d, ccv3, scope);
}
function folderUnregistered(deps, d) {
  try {
    const scope = deps.tapScope;
    if (!scope || !isAbsolute2(d) || isUnexpanded(d)) return false;
    const reg = scope.registry();
    return reg.state === "ok" && !underRegistryRoot(d, reg, scope);
  } catch {
    return false;
  }
}
function ccv3OrUnplaced(deps, d) {
  try {
    return isCcv3Checkout(deps, d);
  } catch {
    return !folderUnregistered(deps, d);
  }
}
var MissingCwdError = class extends Error {
  constructor(cwd) {
    super(`the working folder does not exist: ${cwd}`);
    this.cwd = cwd;
    this.name = "MissingCwdError";
  }
  cwd;
};
var GitDeadlineError = class extends Error {
  constructor(args) {
    super(`the time limit of the hook (${HOOK_BUDGET_MS / 1e3} s) passed before git ${args[0] ?? ""} could run`);
    this.args = args;
    this.name = "GitDeadlineError";
  }
  args;
};
var HOOK_BUDGET_MS = 7e3;
function makeGit(opts = {}) {
  const now = opts.now ?? Date.now;
  const spawn2 = opts.spawn ?? ((_cmd, args, o) => spawnSync("git", args, o));
  const exists = opts.exists ?? existsSync4;
  return (cwd, args, read = {}) => {
    const own = read.timeout ?? GIT_TIMEOUT_MS;
    const left = opts.deadline === void 0 ? own : opts.deadline - now();
    if (left <= 0) throw new GitDeadlineError(args);
    if (!exists(cwd)) throw new MissingCwdError(cwd);
    const r = spawn2("git", args, { cwd, encoding: "utf8", timeout: Math.min(own, left), windowsHide: true, ...read.maxBuffer ? { maxBuffer: read.maxBuffer } : {} });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function realDeps(opts = {}) {
  const { start, ...run } = opts;
  const t0 = start ?? Date.now();
  const clock = run.now ?? Date.now;
  let registry = null;
  return {
    git: makeGit(run),
    scanLeft: () => t0 + HOOK_BUDGET_MS - clock(),
    appGit: makeGit({ ...run, deadline: t0 + HOOK_BUDGET_MS }),
    readFile: (p) => {
      try {
        return existsSync4(p) ? readFileSync6(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir5(),
    tapScope: { registry: () => registry ??= readRegistry({ env: process.env }) },
    // The push scan: the ids come from the primary checkout of the folder being pushed (the dataset is git-ignored, so a worktree has none).
    holdoutIds: (dir) => loadHoldoutIds(primaryRootOf(makeGit(run), dir)),
    answerKeyHits: answerKeyHitsOf2
  };
}
function primaryRootOf(git, dir) {
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.status !== 0 || r.stdout.trim() === "") throw new Error("no common dir");
  return resolve3(r.stdout.trim(), "..");
}
var PARSE_BUDGET_MS = 7e3;
async function withParsed(raw, deps) {
  let lateText;
  try {
    const input = JSON.parse(raw.trim() || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) return deps;
    const cmd = readShellCommand(input);
    if (cmd.kind !== "command" || cmd.text === "" || !defaultEntry(cmd.text)) return deps;
    lateText = cmd.text;
    const tool = cmd.tool;
    const dialects = tool === "Bash" ? ["bash"] : tool === "PowerShell" ? ["pwsh"] : ["bash", "pwsh"];
    const byDialect = {};
    let innerBad = false;
    let timer;
    const late = new Promise((res) => {
      timer = setTimeout(() => res("late"), deps.parseBudgetMs ?? PARSE_BUDGET_MS);
      timer.unref?.();
    });
    const parse = (async () => {
      for (const d of dialects) byDialect[d] = await parseCalls(cmd.text, d, deps.parseOpts);
      innerBad = await innerTextBad(byDialect, deps.parseOpts);
      return "done";
    })();
    parse.catch(() => void 0);
    try {
      if (await Promise.race([parse, late]) === "late") {
        try {
          logGuardError(HOOK, new Error(`the shell parse was late: no answer in ${deps.parseBudgetMs ?? PARSE_BUDGET_MS} ms`), { env: deps.env });
        } catch {
        }
        return { ...deps, parseLate: cmd.text };
      }
    } finally {
      clearTimeout(timer);
    }
    return { ...deps, parsed: { text: cmd.text, byDialect, ...innerBad ? { innerBad } : {} } };
  } catch (err) {
    try {
      logGuardError(HOOK, err);
    } catch {
    }
    return lateText === void 0 ? deps : { ...deps, parseLate: lateText };
  }
}
async function main2() {
  const start = Date.now();
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  console.log(handle(raw, await withParsed(raw, realDeps({ start }))));
}
if (!process.env.VITEST) {
  main2().catch((err) => {
    logGuardError(HOOK, err);
    console.error("decision-gate: stdin could not be read; the call is allowed.");
    console.log("{}");
  });
}
export {
  COMMAND_TOOLS2 as COMMAND_TOOLS,
  GitDeadlineError,
  MissingCwdError,
  SCRIPT_RUNNERS,
  WRITE_TOOLS,
  astCreates,
  astMerges,
  decide,
  docAppendByAst,
  handle,
  isLandLabel,
  isMergeNowLabel,
  isOpenPrLabel,
  isPushOnlyLabel,
  isShipLabel,
  makeGit,
  parseErrorDenies,
  pushShapesOf,
  realDeps,
  scriptRunnerDenies,
  scriptRunnerLateDenies,
  withParsed
};
/*! Bundled license information:

sh-syntax/lib/processor.js:
  (* istanbul ignore if -- @preserve *)

sh-syntax/lib/index.js:
  (* istanbul ignore next -- @preserve *)
*/
