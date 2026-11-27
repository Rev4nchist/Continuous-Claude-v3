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
    const path6 = guardLogPath(env);
    mkdirSync(dirname(path6), { recursive: true, mode: 448 });
    appendFileSync(path6, JSON.stringify(entry) + "\n", { mode: 384 });
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
    const path6 = guardLogPath(env);
    mkdirSync(dirname(path6), { recursive: true, mode: 448 });
    appendFileSync(path6, JSON.stringify(entry) + "\n", { mode: 384 });
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
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync8, readFileSync as readFileSync12 } from "fs";
import { homedir as homedir8 } from "os";
import { isAbsolute as isAbsolute4, join as join12, posix as posix4, resolve as resolve5 } from "path";

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
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave at READY (a toast), not you; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. ` + checkpointText(info, ledger) + `Then, in that same turn, start node scripts/github/wait-ci.mjs ${info.number} with run_in_background. It ends at READY, a failed check or its time limit, and that starts a turn in you. Then send READY or the failure to the seat by SendMessage. The seat reads GitHub before any land word. This applies to every PR in every session.`;
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
function argAt(seg, mseg, at3) {
  if (mseg[at3] === seg[at3]) return true;
  const from = seg.slice(0, at3).search(/\S*$/);
  const end = seg.slice(at3).search(/\s|$/);
  return QUOTED_WORD.test(seg.slice(from, at3 + end));
}
function flagValues(re, seg, mseg, after) {
  return [...seg.matchAll(re)].filter((m) => {
    const at3 = m.index + m[0].search(/\S/);
    return at3 >= after && mseg[at3] === seg[at3];
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
    const at3 = m.index + m[0].search(/\S/);
    if (mtext[at3] !== text[at3]) continue;
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
  const out4 = /* @__PURE__ */ new Set();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out4.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out4.add(String(f.pr));
    if (f.comment_id !== void 0 && f.comment_id !== null) {
      out4.add(String(f.comment_id));
      out4.add(`${f.pr}:${f.comment_id}`);
    }
    if (typeof f.round === "string" && /^[0-9a-f]{7,40}$/i.test(f.round)) out4.add(f.round.toLowerCase());
  }
  out4.delete("undefined");
  out4.delete("null");
  return [...out4];
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
    const at3 = s.indexOf(id, from);
    if (at3 < 0) return false;
    from = at3 + 1;
    const before = s[at3 - 1];
    const after = s[at3 + id.length];
    if (before !== void 0 && /\d/.test(before) || after !== void 0 && /\d/.test(after)) continue;
    if (long || CONTEXT.test(s.slice(Math.max(0, at3 - 8), at3))) return true;
  }
}
function tokenHit(low, id) {
  const want = id.toLowerCase();
  const word = /[0-9a-f:]/;
  let from = 0;
  for (; ; ) {
    const at3 = low.indexOf(want, from);
    if (at3 < 0) return false;
    from = at3 + 1;
    const before = low[at3 - 1];
    const after = low[at3 + want.length];
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

// src/main-floor/decision-gate.ts
init_trace_boot();
import { spawnSync } from "child_process";
import { existsSync as existsSync6, readFileSync as readFileSync10 } from "fs";
import { homedir as homedir6 } from "os";
import { isAbsolute as isAbsolute2, join as join10, posix as posix2, resolve as resolve3 } from "path";

// src/main-floor/pr-opened-review-loop.ts
init_trace_boot();
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync5, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "fs";
import { join as join7 } from "path";
import { homedir as homedir4, tmpdir as tmpdir2 } from "os";

// src/main-floor/shared/router-config.ts
init_trace_boot();
import { dirname as dirname3, join as join6 } from "path";
var CONFIG_REL2 = "review-router.config.json";
function routerConfigText2(cwd, readFile, home) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const text = readFile(join6(dir, CONFIG_REL2));
    if (text !== null) return text;
    const up = dirname3(dir);
    if (up === dir) break;
    dir = up;
  }
  return readFile(join6(home, "continuous-claude", CONFIG_REL2));
}
function routerFlag2(cwd, readFile, home, section, key) {
  const text = routerConfigText2(cwd, readFile, home);
  if (text === null) return false;
  try {
    const cfg = JSON.parse(text);
    return cfg?.[section]?.[key] === true;
  } catch {
    return false;
  }
}

// src/main-floor/shared/gh-open-prefix.ts
init_trace_boot();
var GH_OPT_PREFIX2 = String.raw`(?:[^\S\r\n]+[\w.\/:=@-]+){1,6}?`;

// src/main-floor/pr-opened-review-loop.ts
var COMMAND_TOOLS2 = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PR_CREATE_RE2 = new RegExp(String.raw`\bgh(?:\s+|${GH_OPT_PREFIX2}[^\S\r\n]+)pr\s+(?:create|new)\b`, "i");
var GH_API_RE2 = /\bgh\s+api\b/i;
var PULLS_PATH_RE2 = /\/pulls\/?(?=[\s"'?]|$)/i;
var POST_METHOD_RE2 = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))POST\b/i;
var ANY_METHOD_RE2 = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))\w/i;
var FIELD_FLAG_RE2 = /(?:^|\s)(?:-[fF]\s*["']?[\w.[\]-]+=|--(?:raw-field|field|input)[\s=])/;
var GH_API_SEGMENT_RE2 = /\bgh\s+api\b[^|;&\n]*/i;
var DATA_VALUE2 = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)+`;
var DATA_FLAG_RE2 = new RegExp(String.raw`(^|\s)(-[fFHqt]\s*|--(?:raw-field|field|header|jq|template|input)(?:\s+|=))${DATA_VALUE2}`, "g");
var PR_URL_RE2 = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;
function joinContinuations2(command, shell) {
  const text = command || "";
  return shell === "bash" ? text.replace(/\\\r?\n/g, "") : text.replace(/[ \t]*`\r?\n[ \t]*/g, " ");
}
function normalizeGh2(command) {
  return (command || "").replace(/(["'])gh(?:\.exe)?\1(?=\s)|\bgh\.exe(?=\s)/gi, "gh");
}
var squashQuotes2 = (text) => text.replace(/["'\\]/g, "");
function isPrOpenCommand2(command) {
  const text = normalizeGh2(command);
  return isPrOpenText2(joinContinuations2(text, "bash")) || isPrOpenText2(joinContinuations2(text, "pwsh"));
}
function isPrOpenText2(cmd) {
  if (PR_CREATE_RE2.test(cmd) || PR_CREATE_RE2.test(squashQuotes2(cmd))) return true;
  if (!GH_API_RE2.test(cmd)) return false;
  const api = cmd.match(GH_API_SEGMENT_RE2)?.[0] ?? "";
  const bare = api.replace(DATA_FLAG_RE2, "$1$2");
  if (!PULLS_PATH_RE2.test(bare)) return false;
  if (POST_METHOD_RE2.test(bare)) return true;
  return FIELD_FLAG_RE2.test(api) && !ANY_METHOD_RE2.test(bare);
}
function responseText2(resp) {
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
function extractPrInfo2(responseTxt) {
  const urlMatch = responseTxt.match(PR_URL_RE2);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3], url: urlMatch[0] };
  }
  return null;
}
function safeSession2(sessionId) {
  return (sessionId || "no-session").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function statePath2(sessionId) {
  return join7(tmpdir2(), `pr-opened-review-loop-${safeSession2(sessionId)}.json`);
}
function legacyStatePath2(sessionId) {
  return join7(tmpdir2(), `pr-opened-coderabbit-loop-${safeSession2(sessionId)}.json`);
}
function readSeen2(p) {
  try {
    if (!existsSync3(p)) return [];
    const parsed = JSON.parse(readFileSync5(p, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function alreadyFired2(sessionId, url) {
  return readSeen2(statePath2(sessionId)).includes(url) || readSeen2(legacyStatePath2(sessionId)).includes(url);
}
function markFired2(sessionId, url) {
  try {
    const legacy = legacyStatePath2(sessionId);
    const seen = [.../* @__PURE__ */ new Set([...readSeen2(statePath2(sessionId)), ...readSeen2(legacy), url])];
    mkdirSync4(tmpdir2(), { recursive: true });
    writeFileSync3(statePath2(sessionId), JSON.stringify(seen), "utf8");
    if (existsSync3(legacy)) unlinkSync3(legacy);
  } catch {
  }
}
var WATCH_REPO2 = "rev4nchist/continuous-claude-v3";
var loopText2 = (info) => `/loop 5m Check the PR review bots that must review the head (in CCv3, the bots \`node scripts/github/review-status.mjs ${info.number}\` requires; elsewhere, the repo's configured bots) on ${info.owner}/${info.repo} PR #${info.number} (stop when reviews of the head land or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;
function checkpointText2(info, ledger) {
  const call = `the pr_checkpoint tool with pr: ${info.number} and body: the path of the PR body file that pre-pr.mjs --body checked (mcp__ccv3-mods__pr_checkpoint)`;
  const never = "Never mark it ready or add a review: label yourself; the checkpoint does both. ";
  if (ledger) {
    return `Either way, also call ${call}. If it returns a question, ask Dave that question with AskUserQuestion, word for word, then call pr_checkpoint again with the same pr and body. Only his tap records a pick. An answer that matches no option records nothing, and the PR stays a draft. ` + never;
  }
  return `Either way, also call ${call}. Without that call /pathway has no checkpoint to record, and the PR stays a draft. ` + never;
}
function buildContext2(info, ledger = false) {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO2) {
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText2(info)}. ` + checkpointText2(info, ledger) + `This applies to every PR in every session.`;
  }
  return head + `START THE REVIEW LOOP NOW, in this same turn: ${loopText2(info)}. This applies to every PR in every session.`;
}
function ledgerOn2(cwd) {
  const readFile = (p) => {
    try {
      return readFileSync5(p, "utf8");
    } catch {
      return null;
    }
  };
  return routerFlag2(cwd || process.cwd(), readFile, homedir4(), "checkpoint", "ledger");
}
function main2() {
  const raw = readFileSync5(0, "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool_name || "";
  if (!COMMAND_TOOLS2.has(tool)) {
    console.log("{}");
    return;
  }
  const command = input.tool_input?.command || "";
  if (!isPrOpenCommand2(command)) {
    console.log("{}");
    return;
  }
  const text = responseText2(input.tool_response);
  const info = extractPrInfo2(text);
  if (!info) {
    console.log("{}");
    return;
  }
  const sessionId = input.session_id || "";
  if (alreadyFired2(sessionId, info.url)) {
    console.log("{}");
    return;
  }
  markFired2(sessionId, info.url);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: buildContext2(info, ledgerOn2(input.cwd || ""))
      }
    })
  );
}
if ((process.argv[1] || "").includes("pr-opened-review-loop")) {
  try {
    main2();
  } catch {
    console.log("{}");
  }
}

// src/main-floor/shared/checkpoint-shapes.ts
init_trace_boot();
var WORD2 = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
var ADD_LABEL2 = new RegExp(String.raw`(?:^|\s)--add-label(?:=|\s+)(${WORD2})`, "g");
var CREATE_LABEL2 = new RegExp(String.raw`(?:^|\s)(?:--label(?:=|\s+)|-l\s*)(${WORD2})`, "g");
var ISSUE_ENDPOINT2 = /repos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/[^\s/"'?]+/gi;
function hasCcv3Endpoint2(raw) {
  if (!/\bgh\s+api\b/i.test(raw)) return false;
  return [...raw.matchAll(ISSUE_ENDPOINT2)].some((m) => m[1].toLowerCase() === "rev4nchist/continuous-claude-v3");
}
var NONLITERAL_REPO2 = new RegExp(
  String.raw`(?:^|\s)(?:-R\s*=?|--repo(?:\s+|=))["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)` + String.raw`|(?:^|[\s;])(?:\$env:)?GH_REPO\s*=\s*["']?[^\s"';]*(?:\$|\x60|%[A-Za-z_]\w*%)`,
  "i"
);
var hasNonLiteralRepo2 = (raw) => NONLITERAL_REPO2.test(raw);
var CCV3_REPO2 = "rev4nchist/continuous-claude-v3";
var REPO_VALUE2 = "((?:https?:\\/\\/)?[\\w.-]+(?:\\/[\\w.-]+){1,2})";
var REPO_FLAG2 = new RegExp(`(?:^|\\s)(?:-R\\s*=?|--repo(?:\\s+|=))["']?${REPO_VALUE2}`, "g");
var GH_REPO_ASSIGN2 = new RegExp(`(?:^|[\\s;])(?:\\$env:)?GH_REPO\\s*=\\s*["']?${REPO_VALUE2}`, "gi");
var PR_URL2 = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+/gi;
var ownerRepo2 = (value) => value.replace(/^https?:\/\//i, "").split("/").slice(-2).join("/").replace(/\.git$/i, "").toLowerCase();
var API_ENDPOINT2 = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/gi;
function namedRepo2(command, env = {}) {
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE2}$`).exec(env.GH_REPO.trim())?.[1];
  const values = [...command.matchAll(REPO_FLAG2), ...command.matchAll(GH_REPO_ASSIGN2)].map((m) => m[1]);
  const explicits = [...values, ...envRepo ? [envRepo] : []].map(ownerRepo2);
  const endpoints = [...command.matchAll(API_ENDPOINT2)].map((m) => m[1].toLowerCase());
  const urls = [...command.matchAll(PR_URL2)].map((m) => m[1].toLowerCase());
  const ccv3 = explicits.includes(CCV3_REPO2) || endpoints.includes(CCV3_REPO2) || urls.includes(CCV3_REPO2) || hasCcv3Endpoint2(command);
  return ccv3 ? CCV3_REPO2 : null;
}
var ANY_REPOS_PATH2 = /(?:^|[\s"'=]|api\.github\.com)\/?repos\/([\w.-]+\/[\w.-]+)(?=[/\s"'?#]|$)/gi;
var GH_SUB2 = /\bgh\s+(\S+)(?:\s+(\S+))?/i;
var QUOTED_WORD2 = /^(["'])[^\s"']+\1$/;
function argAt2(seg, mseg, at3) {
  if (mseg[at3] === seg[at3]) return true;
  const from = seg.slice(0, at3).search(/\S*$/);
  const end = seg.slice(at3).search(/\s|$/);
  return QUOTED_WORD2.test(seg.slice(from, at3 + end));
}
function flagValues2(re, seg, mseg, after) {
  return [...seg.matchAll(re)].filter((m) => {
    const at3 = m.index + m[0].search(/\S/);
    return at3 >= after && mseg[at3] === seg[at3];
  }).map((m) => m[1]);
}
function pathRepos2(seg, mseg) {
  const sub = GH_SUB2.exec(squashQuotes2(seg));
  const verb = sub?.[1].toLowerCase();
  const re = verb === "api" ? ANY_REPOS_PATH2 : verb === "pr" && /^(?:merge|view|ready)$/i.test(sub?.[2] ?? "") ? PR_URL2 : null;
  if (re === null) return [];
  return [...seg.matchAll(re)].filter((m) => argAt2(seg, mseg, m.index + m[0].length - m[1].length)).map((m) => ownerRepo2(m[1]));
}
function commandRepo2(text, mtext, env = {}, prior = []) {
  const cut = mtext.replace(/>&|&>/g, "  ").search(/[;&|\r\n]/);
  const seg = cut < 0 ? text : text.slice(0, cut);
  const mseg = cut < 0 ? mtext : mtext.slice(0, cut);
  const gh = /\bgh\s/i.exec(mseg);
  if (gh === null) return null;
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE2}$`).exec(env.GH_REPO.trim())?.[1];
  const cluster = new RegExp(`(?:^|\\s)-[A-Za-z]+R\\s*=?["']?${REPO_VALUE2}`, "g");
  const values = [...flagValues2(REPO_FLAG2, seg, mseg, gh.index), ...flagValues2(cluster, seg, mseg, gh.index), ...flagValues2(GH_REPO_ASSIGN2, seg, mseg, 0)];
  const explicits = [...values, ...envRepo ? [envRepo] : []].map(ownerRepo2);
  const slugs = [.../* @__PURE__ */ new Set([...explicits, ...prior, ...pathRepos2(seg, mseg)])].sort();
  return slugs.length === 0 ? null : slugs.join(" ");
}
var GH_REPO_ANY2 = /(?:^|[\s;&|(])(?:\$env:)?GH_REPO\s*=\s*["']?([^\s"';&|)]*)/gi;
function priorGhRepo2(text, mtext) {
  const REPO_ONLY = new RegExp(`^${REPO_VALUE2}$`);
  const repos = [];
  let nonLiteral = false;
  for (const m of text.matchAll(GH_REPO_ANY2)) {
    const at3 = m.index + m[0].search(/\S/);
    if (mtext[at3] !== text[at3]) continue;
    if (REPO_ONLY.test(m[1])) repos.push(ownerRepo2(m[1]));
    else if (/[$`%]/.test(m[1])) nonLiteral = true;
  }
  return { repos: [...new Set(repos)], nonLiteral };
}

// src/main-floor/shared/answer-paths-door.ts
init_trace_boot();

// src/main-floor/lib/answer-key.mjs
init_trace_boot();
var ANSWER_KEY_GLOBS2 = Object.freeze([
  "scripts/eval/review-eval/gold/**",
  "scripts/eval/review-eval/seeds/**",
  "scripts/eval/review-eval/rubrics/**",
  "scripts/eval/review-eval/linktype-labels.json"
]);
var slashLower2 = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
function matches2(glob, p) {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -2);
    return p.length > prefix.length && p.startsWith(prefix);
  }
  return glob === p;
}
function answerKeyHitsOf3(paths, globs = ANSWER_KEY_GLOBS2) {
  const list = globs.map(slashLower2);
  return paths.filter((p) => {
    const n = slashLower2(p);
    return list.some((g) => matches2(g, n));
  });
}

// src/main-floor/shared/answer-paths-door.ts
var answerKeyHitsOf4 = answerKeyHitsOf3;

// src/main-floor/shared/decisions-store.ts
init_trace_boot();
import { readFileSync as readFileSync7 } from "fs";

// src/main-floor/lib/decisions.mjs
init_trace_boot();
import { appendFileSync as appendFileSync3, closeSync as closeSync2, existsSync as existsSync4, mkdirSync as mkdirSync5, openSync as openSync2, readFileSync as readFileSync6, readSync as readSync2, readdirSync as readdirSync2, renameSync as renameSync2, statSync as statSync2, unlinkSync as unlinkSync4, writeFileSync as writeFileSync4 } from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/main-floor/lib/file-lock.mjs
init_trace_boot();

// src/main-floor/lib/decisions.mjs
var DECISIONS_ENV2 = "CCV3_DECISIONS_FILE";
var STEPS2 = Object.freeze(["ship", "open-pr", "review", "land", "paid-round", "cli-skip"]);
var REPO2 = "Rev4nchist/Continuous-Claude-v3";
var MAX_AGE_MS2 = 7 * 24 * 3600 * 1e3;
var MISS_TTL_MS2 = 60 * 60 * 1e3;
var accountHome2 = () => {
  try {
    return os2.userInfo().homedir || os2.homedir();
  } catch {
    return os2.homedir();
  }
};
var decisionsPath3 = (env = process.env) => env[DECISIONS_ENV2] || path2.join(accountHome2(), ".claude", "state", "ccv3-mods", "decisions.json");
var decisionKey3 = ({ repo = REPO2, pr, branch }) => pr !== void 0 && pr !== null ? `${repo}#${pr}` : `${repo}@${branch}`;
var LOG_MAX_BYTES2 = 5 * 1024 * 1024;
var empty2 = () => ({ version: 1, offers: {}, decisions: {}, misses: {} });
var idOf2 = ({ step, key, head }) => `${step}
${key}
${String(head).toLowerCase()}`;
var isText2 = (v) => typeof v === "string" && v !== "";
var isPlain2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function readStore2(file) {
  try {
    const s = JSON.parse(readFileSync6(file, "utf8"));
    if (!isPlain2(s)) return empty2();
    const store = { ...empty2(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain2) ? store : empty2();
  } catch {
    return empty2();
  }
}
function decisionRead3({ step, key, head }) {
  if (!STEPS2.includes(step) || !isText2(key) || !isText2(head)) return null;
  const d = readStore2(decisionsPath3()).decisions[idOf2({ step, key, head })];
  return d && typeof d.label === "string" ? { label: d.label, at: d.at } : null;
}

// src/main-floor/shared/decisions-store.ts
var decisionRead4 = decisionRead3;
var decisionKey4 = decisionKey3;
var decisionsPath4 = decisionsPath3;
function decisionRows2(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync7(decisionsPath4(env), "utf8"));
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

// src/main-floor/shared/holdout-ids.ts
init_trace_boot();
import { readFileSync as readFileSync8 } from "fs";
import { join as join8 } from "path";

// src/main-floor/lib/holdout-ids.mjs
init_trace_boot();
function holdoutIdsOf2(ds, cfg) {
  const reserved = new Set((cfg?.reserve ?? []).map((r) => r?.pr));
  const excluded = new Set(cfg?.holdoutExclude ?? []);
  const inHoldout = (pr) => !reserved.has(pr) && !excluded.has(pr);
  const out4 = /* @__PURE__ */ new Set();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out4.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out4.add(String(f.pr));
    if (f.comment_id !== void 0 && f.comment_id !== null) {
      out4.add(String(f.comment_id));
      out4.add(`${f.pr}:${f.comment_id}`);
    }
    if (typeof f.round === "string" && /^[0-9a-f]{7,40}$/i.test(f.round)) out4.add(f.round.toLowerCase());
  }
  out4.delete("undefined");
  out4.delete("null");
  return [...out4];
}
var CONTEXT2 = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;
function countIdsIn3(text, ids) {
  const s = String(text ?? "");
  let runs = null;
  let low = null;
  let n = 0;
  for (const id of ids) {
    if (typeof id !== "string" || id === "") continue;
    if (isSha2(id)) {
      runs ??= hexRuns2(s);
      const want = id.toLowerCase();
      if (runs.some((r) => r.length > 40 ? r.includes(want) : want.startsWith(r) || r.startsWith(want))) n += 1;
    } else if (/^\d+$/.test(id)) {
      if (digitHit2(s, id)) n += 1;
    } else if (tokenHit2(low ??= s.toLowerCase(), id)) n += 1;
  }
  return n;
}
var isSha2 = (id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id);
function hexRuns2(s) {
  return [...s.matchAll(/(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi)].map((m) => m[0].toLowerCase());
}
function checkHoldoutShape2(ds, cfg) {
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
function digitHit2(s, id) {
  const long = id.length >= 7;
  let from = 0;
  for (; ; ) {
    const at3 = s.indexOf(id, from);
    if (at3 < 0) return false;
    from = at3 + 1;
    const before = s[at3 - 1];
    const after = s[at3 + id.length];
    if (before !== void 0 && /\d/.test(before) || after !== void 0 && /\d/.test(after)) continue;
    if (long || CONTEXT2.test(s.slice(Math.max(0, at3 - 8), at3))) return true;
  }
}
function tokenHit2(low, id) {
  const want = id.toLowerCase();
  const word = /[0-9a-f:]/;
  let from = 0;
  for (; ; ) {
    const at3 = low.indexOf(want, from);
    if (at3 < 0) return false;
    from = at3 + 1;
    const before = low[at3 - 1];
    const after = low[at3 + want.length];
    if (before !== void 0 && word.test(before) || after !== void 0 && word.test(after)) continue;
    return true;
  }
}

// src/main-floor/shared/holdout-ids.ts
var DATASET_REL2 = ".claudedocs/2026-11-01-pr-review-dataset.json";
var EVAL_CONFIG_REL2 = "scripts/eval/review-eval/config.json";
var countIdsIn4 = countIdsIn3;
function loadHoldoutIds2(mainRoot) {
  let ids;
  try {
    const ds = JSON.parse(readFileSync8(join8(mainRoot, DATASET_REL2), "utf8"));
    const cfg = JSON.parse(readFileSync8(join8(mainRoot, EVAL_CONFIG_REL2), "utf8"));
    checkHoldoutShape2(ds, cfg);
    ids = holdoutIdsOf2(ds, cfg);
  } catch {
    throw new Error("the holdout id list could not be read");
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("the holdout id list is empty");
  return ids;
}

// src/main-floor/shared/git-call.ts
init_trace_boot();
var VAL2 = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
var globalOpt2 = (extra = "") => String.raw`(?:\s+(?:${extra}-C\s+${VAL2}|-c\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VAL2}|--no-pager|--no-replace-objects|--bare|-P))*`;
var GLOBAL_OPT2 = globalOpt2();
var CALL_START2 = String.raw`(?:^\s*|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:&\s+)?(?:\w+=\S*\s+)*(?:(?:time|sudo|command|exec|nohup)\s+)*`;
var PATH_PREFIX2 = String.raw`(?:[^\s;&|()]*[\\/])?`;
var PWSH_PREFIX2 = String.raw`(?:(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*?\s+-File\s+)?`;
function gitCallRe2(verb) {
  return new RegExp(String.raw`(${CALL_START2})(${PATH_PREFIX2}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT2})(\s+${verb})(?=\s|$)`, "g");
}
function safeCallRe2(verb, wrappers = "git-safe", extraOpts = "", flags = "g") {
  return new RegExp(String.raw`(${CALL_START2})(${PWSH_PREFIX2}(?:${PATH_PREFIX2}(?:${wrappers})\.ps1|"\s*"|'\s*'))(${globalOpt2(extraOpts)})(\s+${verb})(?=\s|$)`, flags);
}
var isGitToken2 = (raw) => /(?:^|[\\/"'])git(?:\.exe)?["']?$/i.test(raw);
var isSafeToken2 = (raw, wrappers = "git-safe") => new RegExp(`(?:${wrappers})\\.ps1`, "i").test(raw);

// src/main-floor/shared/inert-quotes.ts
init_trace_boot();

// src/main-floor/shared/mask-quotes.ts
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

// src/main-floor/shared/doc-heredoc.ts
init_trace_boot();
var PATH = String.raw`(?<path>[\w./\\:~-]+\.(?:md|txt))`;
var DELIM = String.raw`(?<dash>-?)(?<q>['"])(?<d>[A-Za-z_]\w*)\k<q>`;
var HEAD_FILE_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]+>>?[ \t]*${PATH}[ \t]*<<${DELIM}[ \t]*$`);
var HEAD_MARKER_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]*<<${DELIM}[ \t]*>>?[ \t]*${PATH}[ \t]*$`);
var ODD_BREAK = /[\r\0\v\f\x85\u2028\u2029]/;
function blankDocHeredocBody(command) {
  if (!command.includes("<<") || ODD_BREAK.test(command)) return command;
  const lines3 = command.split("\n");
  const head = HEAD_FILE_FIRST.exec(lines3[0]) ?? HEAD_MARKER_FIRST.exec(lines3[0]);
  if (!head || !head.groups) return command;
  const { dash, d } = head.groups;
  let close = -1;
  for (let i = 1; i < lines3.length; i++) {
    const line = dash ? lines3[i].replace(/^\t+/, "") : lines3[i];
    if (line === d) {
      close = i;
      break;
    }
  }
  if (close < 1) return command;
  if (lines3.slice(close + 1).some((l) => l.trim() !== "")) return command;
  return lines3.map((l, i) => i >= 1 && i < close ? " ".repeat(l.length) : l).join("\n");
}

// src/main-floor/shared/inert-quotes.ts
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
  const out4 = /* @__PURE__ */ new Set();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches(PLAIN_HEAD, masked, raw)) continue;
    if (openHead !== void 0 && headMatches(openHead, masked, raw)) continue;
    if (!headMatches(INERT_HEAD, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out4.add(`${s}:${e}`);
  }
  return out4;
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
  let out4 = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(":").map(Number);
    out4 = out4.slice(0, s + 1) + " ".repeat(e - s - 2) + out4.slice(e - 1);
  }
  return out4;
}

// src/main-floor/shared/shell-tools.ts
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

// src/main-floor/shared/shell-ast.ts
init_trace_boot();
import fs3 from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// node_modules/sh-syntax/lib/index.js
init_trace_boot();
import fs2 from "node:fs/promises";
import path3 from "node:path";
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
  async function processor4(textOrAst, options = {}) {
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
  return processor4;
};

// node_modules/sh-syntax/lib/index.js
var importMetaUrl = import.meta.url;
var moduleDir = importMetaUrl ? path3.dirname(fileURLToPath(importMetaUrl)) : __dirname;
var processor = getProcessor(() => fs2.readFile(path3.resolve(moduleDir, "../main.wasm")));

// src/main-floor/shared/shell-ast.ts
var HERE = fileURLToPath2(new URL(".", import.meta.url)).replace(/\\/g, "/");
var SHIPPED_WASM = `${HERE}sh-syntax.wasm`;
var SHIPPED_WASM_EXEC = `${HERE}sh-syntax-wasm_exec.cjs`;
var SHIPPED = existsSync5(SHIPPED_WASM) && existsSync5(SHIPPED_WASM_EXEC);
var WALKER = existsSync5(`${HERE}shell-ast-walk.ps1`) ? `${HERE}shell-ast-walk.ps1` : `${HERE}../shell-ast-walk.ps1`;
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
  const out4 = [];
  walkAll(n, (x) => {
    if (types.includes(x.type)) out4.push(x);
  });
  return out4;
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
  const out4 = { lit, kind, raw: conv.slice(w.start, w.end), start, end, vars };
  if (sv) {
    out4.var = sv.name;
    out4.quoted = sv.quoted;
  }
  if (lit === null) out4.prefix = wordPrefix(w);
  return out4;
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
  return new Promise((resolve6) => {
    const cp = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", WALKER], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out4 = "";
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve6(v);
      }
    };
    const timer = setTimeout(() => {
      cp.kill();
      fin({ error: "pwsh timeout" });
    }, timeoutMs);
    cp.stdout.setEncoding("utf8");
    cp.stdout.on("data", (d) => {
      out4 += d;
    });
    cp.on("error", (e) => fin({ error: `pwsh spawn: ${e.message}` }));
    cp.on("close", (code) => {
      if (code !== 0) return fin({ error: `pwsh exit ${code}` });
      try {
        fin({ json: JSON.parse(out4) });
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
  const out4 = [];
  words.forEach((w, i) => {
    if (w.kind === "param" && OUTVAR.test(w.lit ?? "") && words[i + 1]) out4.push(words[i + 1].lit ?? words[i + 1].raw);
  });
  return out4;
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
  const out4 = [];
  for (const c of calls) {
    out4.push(c);
    const x = xargsInner(c);
    if (x) out4.push(x);
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
    for (const ic of r.calls) out4.push({ ...ic, depth: ic.depth + c.depth + 1, level: level + 1, viaPayload: pay.via, cwdBefore: [...c.cwdBefore ?? [], ...ic.cwdBefore ?? []] });
    r.kinds.forEach((k) => (c.nestedKinds ??= /* @__PURE__ */ new Set()).add(k));
  }
  return out4;
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

// src/main-floor/shared/shell-judge.ts
init_trace_boot();
var DEFAULT_KINDS = [...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS];
var PROGRAM_WORDS = /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr)\b/i;
var VERB_WORDS = /\b(push|review|pulls)\b|\bpr\s+(create|merge)\b/i;
var DYNAMIC_SIGNS = /(^|\s)&\s|\b(iex|Invoke-Expression|Invoke-Command|Start-Process|cmd|bash|sh|pwsh|powershell)\b|-EncodedCommand/i;
var defaultEntry = (t) => PROGRAM_WORDS.test(t) || VERB_WORDS.test(t) || DYNAMIC_SIGNS.test(t);
var GIT_BUILTIN = new Set("add am apply archive bisect blame branch bundle cat-file checkout cherry-pick clean clone commit config describe diff difftool fetch format-patch gc grep help init log ls-files ls-remote ls-tree merge mergetool mv notes pull push range-diff rebase reflog remote reset restore rev-list rev-parse revert rm shortlog show sparse-checkout stash status submodule switch tag version worktree".split(" "));

// src/main-floor/shared/tap-scope.ts
init_trace_boot();
import * as fs4 from "fs";
import * as os3 from "os";
import * as path4 from "path";

// src/main-floor/lib/repo-identity.mjs
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

// src/main-floor/shared/tap-scope.ts
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
  const home = env.USERPROFILE || env.HOME || (opts.deps?.homedir ?? os3.homedir)();
  return path4.join(home, ".claude", "project-registry.json");
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
  return normPath2(path4.posix.normalize(`${normPath2(base)}/${rel.replace(/\\/g, "/")}`));
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
  const main4 = worktreeRootOf(dir, deps.readFile ?? readUtf8);
  return main4 !== null && firstEntry(main4, live, realpath, isUnder) !== null;
}
var keyRepo2 = keyRepo;
var oneLine3 = oneLine2;
var pushKey2 = pushKey;
var ghKey2 = ghKey;
var pushDefaults2 = pushDefaults;
var ghRemote2 = (git) => ghRemote(git);
var openPrKey2 = openPrKey;
var needsGithubField2 = needsGithubField;

// src/main-floor/decision-gate.ts
var logGuardError2 = (..._args) => void 0;
var HOOK = "decision-gate";
var noCreds = stripCredentials;
var DC = "mcp__plugin_desktop-commander_desktop-commander__";
var COMMAND_TOOLS3 = /* @__PURE__ */ new Set(["Bash", "PowerShell", `${DC}start_process`, `${DC}interact_with_process`]);
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
  const store = norm(decisionsPath4(deps.env));
  return STORE_PATH_RE.test(full) || full === store || full.startsWith(`${store}.`);
}
var escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function readCopyRe(deps) {
  const store = escRe(norm(decisionsPath4(deps.env)));
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
  const names = [lower, squashQuotes2(lower)].some((t) => STORE_TEXT_RE.test(t)) || lower.includes(norm(decisionsPath4(deps.env)));
  const code = CODE_SIGNAL_RE.test(text);
  if (names || STORE_CODE_RE.test(text)) {
    if (WRITE_SIGNAL_RE.test(flat)) return true;
    if (!code) return false;
    return !(names && !STORE_CODE_RE.test(text) && READ_ONLY_CODE_RE.test(text) && !CODE_CAN_WRITE_RE.test(text));
  }
  return STORE_FN_RE.test(text) && code;
}
var NO_PRIOR = { repos: [], nonLiteral: false };
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
  const out4 = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out4.push({ kind: "land", pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  const opens = (m) => m !== null && GH_PREFIX_OK.test(tail.slice(0, m.index)) ? m : null;
  const rawCli = MERGE_CLI_RE.exec(rawSeg) ? opens(TAIL_CLI_RE.exec(tail)) : null;
  if (cli) out4.push({ kind: "merge", pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), ...rawCli ? cliMergeHead(rawCli[1], pwsh) : UNREAD_HEAD });
  const api = MERGE_API_RE.exec(seg);
  const rawApi = MERGE_API_RE.exec(rawSeg) ? opens(TAIL_API_RE.exec(tail)) : null;
  if (api && !GET_RE.test(api[0])) out4.push({ kind: "merge", pr: api[1], ...rawApi ? apiMergeHead(rawApi[0], pwsh) : UNREAD_HEAD });
  return out4;
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
  const at3 = call.cwdBefore ?? [];
  const text = w.map((x) => x.raw).join(" ");
  if (sub(1) === "pr" && sub(2) === "merge") {
    const args = w.slice(3);
    if (args.some((a) => a.lit === null)) return { pr: prOfWords(args), ...UNREAD_HEAD, cwdBefore: at3, text };
    return { pr: prOfWords(args), ...cliHeadOfWords(args.map((a) => a.lit)), cwdBefore: at3, text };
  }
  if (sub(1) === "api") {
    const args = w.slice(2);
    const endpoint = args.find((a) => API_MERGE_PATH.test(a.lit ?? a.raw));
    if (!endpoint) return null;
    const lits = args.map((a) => a.lit);
    if (lits.some((l, i) => (l === "-X" || l === "--method") && /^GET$/i.test(lits[i + 1] ?? "")) || lits.some((l) => /^(?:-XGET|--method=GET)$/i.test(l ?? ""))) return null;
    const pr = API_MERGE_PATH.exec(endpoint.lit ?? endpoint.raw)[1];
    if (endpoint.lit === null || args.some((a) => a.lit === null && a !== endpoint)) return { pr, ...UNREAD_HEAD, cwdBefore: at3, text };
    return { pr, ...apiHeadOfWords(lits.map((l) => l)), cwdBefore: at3, text };
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
  const r = commandRepo2(m.text, maskQuoted(m.text, pwsh ? "PowerShell" : "Bash"), {}, []);
  return r !== null && r !== CCV3_REPO2;
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
  const out4 = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (s) => {
    const id = `${s.kind}|${s.pr}|${s.sha}${s.shaBad ? "!" : ""}|${s.at ? whereId(s.at) : ""}|${s.ftext ?? s.text ?? ""}${s.prior ? priorId(s.prior) : ""}`;
    if (!seen.has(id)) {
      seen.add(id);
      out4.push(s);
    }
  };
  const own = (s) => {
    const cands = found.filter((m) => m.pr === s.pr && namesOtherRepo(m, pwsh));
    const shapeText = squashed(s.ftext ?? s.text ?? "");
    return cands.find((m) => shapeText.includes(squashed(m.text))) ?? cands[0];
  };
  for (const s of shapes) {
    if (s.kind !== "merge") {
      out4.push(s);
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
  return out4;
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
  const out4 = [];
  for (const c of Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : [])) {
    const text = [...c.words.map((w) => w.raw), ...c.stdin?.lit ? [c.stdin.lit] : []].join(" ");
    if (!LAND_SCRIPT_RE.test(text) || CLEANUP_RE.test(text)) continue;
    out4.push({ text, pr: lastArg(text, LAND_PR_RE), sha: SHA_RE.exec(text)?.[1]?.toLowerCase() ?? null, cwdBefore: c.cwdBefore ?? [] });
  }
  if (out4.length === 0 && !CLEANUP_RE.test(raw)) out4.push({ text: raw, pr: lastArg(raw, LAND_PR_RE), sha: SHA_RE.exec(raw)?.[1]?.toLowerCase() ?? null, cwdBefore: [] });
  return out4;
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
var PUSH_GIT = new RegExp(String.raw`(${CALL_START2}(?:${WRAPPERS})*)(${PATH_PREFIX2}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT2})(\s+push)(?=\s|$)`, "g");
var PUSH_WRAPPERS = "git-(?:safe|for)";
var abbr = (name, min) => name.slice(0, min) + [...name.slice(min)].reduceRight((acc, ch) => `(?:${ch}${acc})?`, "");
var GIT_FOR_OPTS = String.raw`-(?:${abbr("Path", 2)}|${abbr("Remote", 1)})(?::|\s+)${VAL2}|-(?:${abbr("WhichAccount", 2)}|${abbr("UseGitSafe", 1)})(?=\s)|`;
var PUSH_SAFE = safeCallRe2("push", PUSH_WRAPPERS, GIT_FOR_OPTS, "gi");
var ARGS_END_RE = /[;&|\r\n)}]/;
var DIR_OPT_RE = new RegExp(String.raw`(?:^|\s)-C\s+(${VAL2})`, "g");
var PATH_OPT_RE = new RegExp(String.raw`(?:^|\s)-${abbr("Path", 2)}(?::|\s+)(${VAL2})`, "gi");
var MOVE_OPT_RE = /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/;
var REDIRECT_RE = /(?:^|\s)\d*[<>]+\S*/g;
var VALUE_OPTS = /* @__PURE__ */ new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
var FORCE_LONG = /^--(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|tags|delete|prune)(?:=.*)?$/;
var PUSH_KINDS = [[PUSH_GIT, isGitToken2], [PUSH_SAFE, (t) => isSafeToken2(t, PUSH_WRAPPERS)]];
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
function opensData(text, at3, tool) {
  const lead = text.slice(0, at3);
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
  let out4 = text;
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
    if (plainLine && opensData(out4, m.index, "Bash") && (quoted || !RUNS_IN_BODY.test(text.slice(start, end)))) out4 = out4.slice(0, start) + blankChars(text.slice(start, end)) + out4.slice(end);
    const eol = text.indexOf("\n", end);
    next = eol < 0 ? text.length : eol + 1;
  }
  return out4;
}
function blankHereStrings(text) {
  let out4 = text;
  let next = 0;
  for (const m of text.matchAll(HERESTRING_OPEN)) {
    if (m.index < next) continue;
    const start = m.index + m[0].length;
    const end = closingLine(text, start, (line) => line.trimStart().startsWith(`${m[1]}@`));
    if (end < 0) break;
    const closedAtStart = text.startsWith(`${m[1]}@`, end);
    const body = text.slice(start, end);
    if (closedAtStart && opensData(out4, m.index, "PowerShell") && (m[1] === "'" || !RUNS_IN_BODY.test(body))) out4 = out4.slice(0, start) + blankChars(body) + out4.slice(end);
    next = end + 2;
  }
  return out4;
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
  let out4 = view;
  for (let from = 0; ; ) {
    const spans = quotedSpans(out4, tool);
    const re = /(^|[\s;&|(])#[^\n]*/g;
    re.lastIndex = from;
    let hit = null;
    for (let m = re.exec(out4); m !== null && hit === null; m = re.exec(out4)) {
      const at3 = m.index + m[1].length;
      const end = m.index + m[0].length;
      if (!spans.some(([s, e]) => at3 > s && at3 < e) && !/["']/.test(out4.slice(end))) hit = { at: at3, end };
    }
    if (hit === null) return out4;
    out4 = out4.slice(0, hit.at) + " ".repeat(hit.end - hit.at) + out4.slice(hit.end);
    from = hit.end;
  }
}
function hiddenPieces(raw, tool) {
  const tools = tool === "Bash" || tool === "PowerShell" ? [tool] : ["Bash", "PowerShell"];
  return tools.flatMap((t) => {
    const view = dropComments(joinContinuations2(raw, t === "PowerShell" ? "pwsh" : "bash"), t);
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
  return view.replace(PLAIN_QUOTED_CD, (match, lead, cd, path6, offset) => {
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path6} ` : match;
  });
};
function pushCallsIn(raw, cmdExe = false, kinds = PUSH_KINDS) {
  const bash = joinContinuations2(raw, "bash");
  const pwsh = joinContinuations2(raw, "pwsh");
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
    const squashed3 = squashQuotes2(seg);
    if (squashed3 === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed3, squashed3, true, before, squashed3, kinds));
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
  const raws = call.args.replace(REDIRECT_RE, " ").split(/\s+/).filter((r) => squashQuotes2(r) !== "");
  return { raws, tokens: raws.map(squashQuotes2) };
}
function callDirsOf(call) {
  const dirs = [...call.opts.matchAll(DIR_OPT_RE), ...call.opts.matchAll(PATH_OPT_RE)].sort((a, b) => a.index - b.index);
  return dirs.map((m) => m[1].includes("\\") ? m[1] : squashQuotes2(m[1]));
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
    const key = squashQuotes2(m[1]).split("=")[0].toLowerCase();
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
  const out4 = [];
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
    out4.push({ kind: "push", pr: null, push: { ...base, branch: name === "" || name === "HEAD" ? null : name, src: src === "" || src === "HEAD" ? null : src, force: rewrite, bare: false, oneSide } });
  }
  return out4;
}
function pushShapesOf(raw, tool) {
  const out4 = [];
  const seen = /* @__PURE__ */ new Map();
  const verdict = rawVerdict(raw, tool);
  const offList = verdict === null ? !steadyCommand(raw, tool === "PowerShell" ? "pwsh" : "bash") : verdict.kind !== "ok";
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const shape of pushShapesFrom(call)) {
      const p = shape.push;
      if (offList) p.plain = false;
      const chain = p.cdirs.length > 1 ? p.cdirs.map(squashQuotes2).join("\0") : "";
      const id = [p.remote, p.branch, p.src, p.dir === null ? null : squashQuotes2(p.dir), p.force, p.moved, p.loose, p.unknown, p.bare, p.cds.join("\0")].join("|") + (chain === "" ? "" : `|-C:${chain}`);
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
        out4.push(shape);
      }
    }
  }
  return out4;
}
var squashMarks = (t) => t.replace(/["'\\^`]/g, "");
var WORD_SPLIT = /[\s;&|(){}<>=,]+/;
var isPushWord = (w) => /^push$/i.test(w) || /(?:^|[\\/])git-push(?:\.exe)?$/i.test(w);
var GIT_WORD = /(?<![^\s;&|(){}`!])(?:(?:[^\s;&|(){}`'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1|(git-push(?:\.exe)?))|"[^"]*"|'[^']*')(?=\s|$)/gi;
var isRunner = (rs, g) => {
  const raw = rs.slice(g.index, g.index + g[0].length);
  return !/^["']/.test(g[0]) || isGitToken2(raw) || isSafeToken2(raw, PUSH_WRAPPERS);
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
  const view = joinContinuations2(raw, shell);
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
  const out4 = [];
  for (const m of raw.replace(/["']/g, "").matchAll(MOVE_VALUE_RE)) {
    for (const dir of knownDirs([chainStep(cwd, m[1].replace(/[;&|)]+$/, ""), shell)], home)) out4.push(dir.replace(/[\\/]\.git(?:[\\/]worktrees[\\/][^\\/]+)?[\\/]*$/i, ""));
  }
  return [...new Set(out4)];
}
var HOME_LEAD = /^(?:~|\$HOME\b|\$\{HOME\}|\$env:USERPROFILE\b|%USERPROFILE%)(?=$|[\\/])/i;
function knownDirs(dirs, home) {
  return dirs.flatMap((d) => {
    if (!isUnexpanded(d)) return [d];
    const raw = d.slice(UNEXPANDED.length);
    const lead = HOME_LEAD.exec(raw);
    const rest = lead === null ? "" : raw.slice(lead[0].length);
    if (lead === null || hasUnexpandedPart(rest.replace(/^[\\/]+/, ""))) return [];
    return [home.startsWith("/") ? posix2.join(home, rest) : join10(home, rest)];
  });
}
var firstCovered = (deps, dirs) => dirs.find((d) => coveredAmong(deps, [d]) !== null) ?? null;
var RAW_CD = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;
function rawDirs(raw, tool, cwd, shell, home) {
  const out4 = [cwd];
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const base of dirsAfter(cwd, call.cds, shell, true)) out4.push(base, chainDir(base, callDirsOf(call), shell));
  }
  const lists = [raw.replace(/["'`^]/g, "").split(/[\s;&|(){}<>]+/), ...payloadWords(raw, shell) ?? []];
  for (const words of lists) {
    let chained = cwd;
    for (let i = 0; i + 1 < words.length; i++) {
      if (!RAW_CD.test(words[i]) && words[i] !== "-C" && !/^-path$/i.test(words[i])) continue;
      out4.push(chainStep(cwd, words[i + 1], shell));
      chained = chainStep(chained, words[i + 1], shell);
      out4.push(chained);
    }
  }
  return [.../* @__PURE__ */ new Set([...knownDirs(out4, home), ...moveTargets(raw, cwd, shell, home)])];
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
  const out4 = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE.source, "g"))) {
    out4.push({ seg: view.slice(from, m.index), from });
    from = m.index + m[0].length;
  }
  out4.push({ seg: view.slice(from), from });
  return out4;
}
var whereId = (at3) => `${at3.unknown ? "?" : ""}${at3.loose ? "~" : ""}${at3.cds.join("\0")}`;
function ownCommand(view, masked, from) {
  const end = (cut) => cut < 0 ? view.length : from + cut;
  const to = end(masked.slice(from).search(SEGMENT_RE));
  const fto = end(masked.slice(from).replace(/>&|&>/g, "  ").search(SEGMENT_RE));
  return { text: view.slice(from, to), mtext: masked.slice(from, to), ftext: view.slice(from, fto), fmtext: masked.slice(from, fto) };
}
function priorOf(view, masks, from) {
  const all = masks.map((m) => priorGhRepo2(view.slice(0, from), m.slice(0, from)));
  return { repos: [...new Set(all.flatMap((a) => a.repos))].sort(), nonLiteral: all.some((a) => a.nonLiteral) };
}
var priorId = (p) => p.repos.length === 0 && !p.nonLiteral ? "" : `|GH_REPO=${p.repos.join(",")}${p.nonLiteral ? "$" : ""}`;
var fullId = (own) => own.ftext === own.text ? "" : `|${own.ftext}`;
var landId = (shape, at3, own, prior) => `${shape.kind}|${shape.pr}|${shape.sha}${shape.shaBad ? "!" : ""}|${whereId(at3)}${shape.kind === "merge" ? `|${own.ftext}${priorId(prior)}` : ""}`;
var distinctWheres = (wheres) => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);
function shapesOf(raw, tool, parsed, astOnly = false) {
  const text = normalizeGh2(blankInertQuotes(raw, tool));
  const views = [.../* @__PURE__ */ new Set([joinContinuations2(text, "bash"), joinContinuations2(text, "pwsh")])];
  const textOnly = (tool === "Bash" || tool === "PowerShell") && !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations2(raw, "bash"), joinContinuations2(raw, "pwsh")].every(isTextOnlyCommand);
  const docReadable = !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations2(raw, "bash"), joinContinuations2(raw, "pwsh")].every((c) => docAppendReadable(c, tool));
  const docAst = !PR_NUMBER_IN_TEXT_RE.test(raw) && docAppendByAst(parsed, tool, raw);
  const out4 = [];
  const pwshTool = tool === "PowerShell";
  const seen = /* @__PURE__ */ new Set();
  const add = (shape, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out4.push(shape);
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
      for (const s of /* @__PURE__ */ new Set([seg, squashQuotes2(seg)])) {
        const found = astOnly ? astHolds(s, false).flatMap((i) => i.shape ? [i.shape] : []) : landShapesOf(s, textOnly || docAst || docReadable && isDocAppend(seg), seg, tail, pwshTool);
        for (const shape of found) {
          for (const own of owns) for (const at3 of wheres) add({ ...shape, at: at3, ...own, prior }, landId(shape, at3, own, prior));
        }
      }
      const heldCreates = astOnly ? astHolds(seg, true) : [];
      if (astOnly ? heldCreates.length === 0 : !isPrOpenText2(seg)) continue;
      created = true;
      const held = heldCreates.find((h) => h.read?.bad) ?? heldCreates[0];
      for (const own of owns) for (const at3 of wheres) add({ kind: "create", pr: null, at: at3, ...own, prior, tail, pwsh: pwshTool, ...held?.read ? { read: held.read } : {} }, `create|${whereId(at3)}|${own.text}${fullId(own)}${priorId(prior)}|${tail}`);
    }
  }
  if (astOnly) {
    const loose = astItems.filter((i) => i.create !== true && i.shape && !heldItems.has(i));
    if (loose.length > 0) {
      const view = views[0];
      const masked = maskQuoted(view, "Bash");
      for (const i of loose) for (const at3 of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
        add({ ...i.shape, at: at3, text: view, mtext: masked, ftext: view, fmtext: masked, prior: NO_PRIOR, pwsh: pwshTool }, `loose|${i.shape?.kind}|${i.shape?.pr}|${whereId(at3)}|${i.sq}`);
      }
    }
  }
  const looseCreate = astOnly ? astItems.filter((i) => i.create === true) : [];
  if (!created && (astOnly ? looseCreate.length > 0 : isPrOpenCommand2(text))) {
    const view = views[0];
    const masked = maskQuoted(view, "Bash");
    const read = looseCreate.find((i) => i.read?.bad)?.read ?? looseCreate[0]?.read;
    for (const at3 of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: "create", pr: null, at: at3, text: view, mtext: masked, ftext: view, fmtext: masked, tail: view, pwsh: pwshTool, ...read ? { read } : {} }, `create|${whereId(at3)}|${view}`);
    }
  }
  const withMergesAndCreates = withAstCreates(withAstMerges(out4, parsed, pwshTool), parsed, pwshTool);
  const seenLand = new Set(withMergesAndCreates.filter((s) => s.kind === "land").map((s) => `${s.pr}|${s.sha}`));
  const lands = (astOnly ? astLandShapes(parsed, raw, exempt, text, pwshTool) : []).filter((s) => {
    const k = `${s.pr}|${s.sha}`;
    if (seenLand.has(k)) return false;
    seenLand.add(k);
    return true;
  });
  return [...withMergesAndCreates, ...lands, ...pushShapesOf(raw, tool)];
}
var enforcing = (deps, cwd) => routerFlag2(cwd, deps.readFile, deps.home, "decisions", "enforce");
var enforcingPush = (deps, cwd) => routerFlag2(cwd, deps.readFile, deps.home, "decisions", "enforcePush");
function homeFlag(deps, key) {
  try {
    const cfg = JSON.parse(deps.readFile(join10(deps.home, "continuous-claude", "review-router.config.json")) ?? "null");
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
    return m !== null && m[1].toLowerCase() === CCV3_REPO2;
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
  const reg2 = scope.registry();
  if (reg2.state === "corrupt") return { ...NOT_COVERED, corrupt: reg2.file };
  if (reg2.state === "missing") return reg2.envPath ? { ...NOT_COVERED, notice: reg2.file } : NOT_COVERED;
  if (!underLiveRoot(dir, reg2, scope)) return NOT_COVERED;
  try {
    const { top, main: main4 } = repoRoots(deps, dir);
    const cov = coverageOf({ toplevel: top, worktreeMainRoot: main4, isCcv3: false }, reg2, { realpath: scope.realpath });
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
  const repo = commandRepo2(text, s.fmtext ?? s.mtext ?? text, env, prior.repos);
  return { named, repo, foreign: repo !== null && repo !== CCV3_REPO2, nonLiteral: hasNonLiteralRepo2(text) || CLUSTER_VAR_REPO.test(text) || prior.nonLiteral };
}
var CLUSTER_VAR_REPO = /(?:^|\s)-[A-Za-z]+R\s*=?["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)/;
var namesCcv3 = (repo) => repo !== null && repo.split(" ").includes(CCV3_REPO2);
function routeOf(deps, dir, cmd) {
  const named = cmd.named === CCV3_REPO2;
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
var COMMIT_GIT = gitCallRe2("commit");
var COMMIT_SAFE = safeCallRe2("commit", PUSH_WRAPPERS, "", "gi");
var READ_VERB = "(?:status|diff|log|show|rev-parse)";
var READ_GIT = gitCallRe2(READ_VERB);
var READ_SAFE = safeCallRe2(READ_VERB, PUSH_WRAPPERS, "", "gi");
var COMMIT_MSG = String.raw`(?:-[Fm]\s+${VAL2}|--(?:file|message)(?:=|\s+)${VAL2})`;
var COMMIT_ARGS_RE = new RegExp(String.raw`^(?:\s+(?:-q|--quiet))*\s+${COMMIT_MSG}(?:\s+(?:-q|--quiet|${COMMIT_MSG}))*\s*$`);
var CD_SEG_RE = /^\s*(?:cd|Set-Location|sl|chdir|pushd|Push-Location)\s+\S/i;
function openCall(ms, rs, git, safe) {
  const kinds = [[git, isGitToken2], [safe, (t) => isSafeToken2(t, PUSH_WRAPPERS)]];
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
  const lines3 = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines3.length === 0 || lines3.some((l) => LOCAL_REMOTE.test(l) || !clearlyNetwork(l));
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
  const view = fdBlank(joinContinuations2(raw, shell));
  const masked = maskQuoted(view, shell === "pwsh" ? "PowerShell" : "Bash");
  const steps = [];
  let from = 0;
  let pending = "";
  for (const [start, next] of [...[...masked.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]), [view.length, view.length]]) {
    const ms = masked.slice(from, start);
    const rs = view.slice(from, start);
    if (ms.trim() !== "") {
      steps.push({ kind: /^\s*(?:popd|Pop-Location)\s*$/i.test(ms) ? "popd" : segmentKind(ms, rs), named: /\bpush\b/i.test(squashQuotes2(rs)), op: pending, end: start, raw: rs });
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
var ADD_GIT = gitCallRe2("add");
var ADD_SAFE = safeCallRe2("add", PUSH_WRAPPERS, "", "gi");
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
  const view = joinContinuations2(raw, shell);
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
  const d = decisionRead4({ step: "open-pr", key: decisionKey4({ branch }), head });
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
  const key = decisionKey4({ pr: shape.pr });
  const ok = decisionRows2(deps.env).some((r) => r.step === "land" && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
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
  const d = decisionRead4({ step: "open-pr", key: openPrKey2({ repo: repo.key, branch, base }), head });
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
  const key = decisionKey4({ repo: repo.key, pr: shape.pr });
  const ok = decisionRows2(deps.env).some((r) => r.step === "land" && r.key === key && isMergeNowLabel(r.label) && r.head.toLowerCase() === sha);
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
  const at3 = s.at;
  const cmd = cmdRepoOf(s, named, deps.env);
  const dirs = dirsAfter(cwd, at3.cds, shell, at3.loose);
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0 && s.kind !== "land") return [unexpandedDeny(deps, [cwd, ...dirs], lost, "other", "other")];
  if (at3.unknown && s.kind !== "land") {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = cmd.named === CCV3_REPO2 || all.some((d) => isCcv3Checkout(deps, d));
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
  return r === "fork" || r.includes(CCV3_REPO2) ? "fork" : null;
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
  const out4 = /* @__PURE__ */ new Set();
  for (const r of [p.src, p.branch]) {
    if (typeof r !== "string" || r === "") continue;
    if (r.startsWith("refs/tags/")) {
      out4.add(r);
      continue;
    }
    if (r.startsWith("refs/") || /^(?:HEAD|@)(?:$|[~^@])/.test(r)) continue;
    if (r.startsWith("tags/")) {
      out4.add(`refs/${r}`);
      continue;
    }
    if (deps.git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${r}`]).status === 0) out4.add(`refs/tags/${r}`);
  }
  return [...out4];
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
  const out4 = [];
  let inDiff = false;
  let binary = false;
  let width = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      inDiff = false;
      width = 0;
      out4.push(line);
      continue;
    }
    if (line.startsWith("diff --")) {
      inDiff = true;
      width = 0;
      out4.push(line);
      continue;
    }
    const at3 = inDiff ? /^(@{2,}) /.exec(line) : null;
    if (at3) {
      width = at3[1].length - 1;
      continue;
    }
    if (inDiff && width === 0 && /^Binary files (?:.* )?differ$/.test(line)) binary = true;
    if (width === 0) {
      out4.push(line);
      continue;
    }
    if (line.slice(0, width) === "+".repeat(width)) out4.push(line);
  }
  return { text: out4.join("\n"), binary };
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
  const count = countIdsIn4(`${all}
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
  return shipTap({ p, deps, dir, chained, alone, key: decisionKey4({ branch }), scope: "push", texts, commitDirs: ctx.commitDirs });
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
  const ok = decisionRows2(deps.env).some((row) => row.step === "ship" && row.key === key && row.tree !== null && row.tree === tree && (isShipLabel(row.label) || !viaIndex && alone && isPushOnlyLabel(row.label) && pushOnly(row.head)));
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
  const r = shipTap({ p: q, deps, dir, chained, alone, key: decisionKey4({ repo: k.key, branch: k.branch }), scope: "app-push", texts, pushOnlyHead: true, commitDirs: ctx?.commitDirs });
  return r.action === "deny" ? { ...r, tapPath: true } : r;
}
var MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function movesRepo(text) {
  return MOVE_ENV_RAW.test(text) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes2(text));
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
    const named = namedRepo2(cmd.text, deps.env);
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
    const prefix = `${decisionKey4({ branch: name })}${CAP_KEY_MARK}`;
    return !decisionRows2(deps.env).some((r) => {
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
  return COMMAND_TOOLS3.has(tool) ? judgeCommand(input, deps, notes, sink) : sink;
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
function catchShapes(input) {
  const cmd = readCommand(input);
  if (cmd.kind !== "command") return [];
  try {
    return shapesOf(cmd.text, cmd.tool);
  } catch {
    return null;
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
    const reg2 = scope.registry();
    if (reg2.state !== "ok") return false;
    const cwd = input.cwd || process.cwd();
    const shell = shellOf(input);
    const raw = pushes.flatMap((s) => [cwd, ...pushDirsOf(s.push, cwd, shell), ...chainDirsOf(s.push, cwd, shell)]).concat(cwd);
    if (raw.some((d) => isUnexpanded(d))) return false;
    const paths = knownDirs(raw, deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets(cmd.text, d, shell, deps.home))];
    if (dirs.length === 0 || dirs.some((d) => !isAbsolute2(d) || isUnexpanded(d))) return false;
    return !dirs.some((d) => underRegistryRoot(d, reg2, scope));
  } catch {
    return false;
  }
}
function underRegistryRoot(d, reg2, scope) {
  const ccv3 = { ...reg2, entries: reg2.entries.filter((e) => e.key === CCV3_ENTRY_KEY).map((e) => ({ ...e, key: `${CCV3_ENTRY_KEY}#root`, status: "active", tapGate: null })) };
  return underLiveRoot(d, reg2, scope) || underLiveRoot(d, ccv3, scope);
}
function folderUnregistered(deps, d) {
  try {
    const scope = deps.tapScope;
    if (!scope || !isAbsolute2(d) || isUnexpanded(d)) return false;
    const reg2 = scope.registry();
    return reg2.state === "ok" && !underRegistryRoot(d, reg2, scope);
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
  const spawn3 = opts.spawn ?? ((_cmd, args, o) => spawnSync("git", args, o));
  const exists = opts.exists ?? existsSync6;
  return (cwd, args, read = {}) => {
    const own = read.timeout ?? GIT_TIMEOUT_MS;
    const left = opts.deadline === void 0 ? own : opts.deadline - now();
    if (left <= 0) throw new GitDeadlineError(args);
    if (!exists(cwd)) throw new MissingCwdError(cwd);
    const r = spawn3("git", args, { cwd, encoding: "utf8", timeout: Math.min(own, left), windowsHide: true, ...read.maxBuffer ? { maxBuffer: read.maxBuffer } : {} });
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
        return existsSync6(p) ? readFileSync10(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir6(),
    tapScope: { registry: () => registry ??= readRegistry({ env: process.env }) },
    // The push scan: the ids come from the primary checkout of the folder being pushed (the dataset is git-ignored, so a worktree has none).
    holdoutIds: (dir) => loadHoldoutIds2(primaryRootOf(makeGit(run), dir)),
    answerKeyHits: answerKeyHitsOf4
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
          logGuardError2(HOOK, new Error(`the shell parse was late: no answer in ${deps.parseBudgetMs ?? PARSE_BUDGET_MS} ms`), { env: deps.env });
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
      logGuardError2(HOOK, err);
    } catch {
    }
    return lateText === void 0 ? deps : { ...deps, parseLate: lateText };
  }
}

// src/shared/inert-quotes.ts
init_trace_boot();

// src/shared/mask-quotes.ts
init_trace_boot();
var BASH_STRING2 = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING2 = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank2 = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted2(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING2 : BASH_STRING2, blank2);
}
function quotedSpans2(command, tool = "Bash") {
  return [...command.matchAll(tool === "PowerShell" ? PWSH_STRING2 : BASH_STRING2)].map((m) => [m.index, m.index + m[0].length]);
}

// src/shared/doc-heredoc.ts
init_trace_boot();
var PATH2 = String.raw`(?<path>[\w./\\:~-]+\.(?:md|txt))`;
var DELIM2 = String.raw`(?<dash>-?)(?<q>['"])(?<d>[A-Za-z_]\w*)\k<q>`;
var HEAD_FILE_FIRST2 = new RegExp(String.raw`^[ \t]*cat[ \t]+>>?[ \t]*${PATH2}[ \t]*<<${DELIM2}[ \t]*$`);
var HEAD_MARKER_FIRST2 = new RegExp(String.raw`^[ \t]*cat[ \t]*<<${DELIM2}[ \t]*>>?[ \t]*${PATH2}[ \t]*$`);
var ODD_BREAK2 = /[\r\0\v\f\x85\u2028\u2029]/;
function blankDocHeredocBody2(command) {
  if (!command.includes("<<") || ODD_BREAK2.test(command)) return command;
  const lines3 = command.split("\n");
  const head = HEAD_FILE_FIRST2.exec(lines3[0]) ?? HEAD_MARKER_FIRST2.exec(lines3[0]);
  if (!head || !head.groups) return command;
  const { dash, d } = head.groups;
  let close = -1;
  for (let i = 1; i < lines3.length; i++) {
    const line = dash ? lines3[i].replace(/^\t+/, "") : lines3[i];
    if (line === d) {
      close = i;
      break;
    }
  }
  if (close < 1) return command;
  if (lines3.slice(close + 1).some((l) => l.trim() !== "")) return command;
  return lines3.map((l, i) => i >= 1 && i < close ? " ".repeat(l.length) : l).join("\n");
}

// src/shared/inert-quotes.ts
var INERT_HEAD2 = new RegExp(
  String.raw`^\s*(?:echo|printf|Write-(?:Host|Output|Warning|Information)|git\s+commit|claude|ntn|curl|gh\s+(?:pr|issue)\s+comment` + String.raw`|node(?:\.exe)?\s+(?:\S*[\\/])?lane\.mjs\s+(?:add|note|say))(?=\s|$)`,
  "i"
);
var PLAIN_HEAD2 = /^\s*(?:cd|Set-Location|git\s+(?:add|status))(?=\s|$)/i;
var SEGMENT_BREAK2 = /[;&|\r\n]+/g;
var HARMLESS_REDIRECT2 = /\d*>&\d+|&>\s*\/dev\/null(?=[\s;&|]|$)|\d*>>?\s*(?:\/dev\/null|\$null|nul)(?=[\s;&|]|$)/gi;
var RUNS_TEXT2 = /\$\(|`|<<|@['"]/;
var SPECIAL_STRING2 = /\$['"]|[\u{2018}-\u{201F}\0\v\f\x85\u{2028}\u{2029}]/u;
var OUTSIDE_RISK2 = /[#(){}'"]/;
function headMatches2(head, masked, raw) {
  return head.test(masked) && head.test(raw);
}
function plainSegments2(command, tool) {
  if (RUNS_TEXT2.test(command) || SPECIAL_STRING2.test(command)) return null;
  const spans = quotedSpans2(command, tool);
  if (spans.some(([s]) => s > 0 && command[s - 1] === "\\")) return null;
  const chars = command.split("");
  for (const [s, e] of spans) chars.fill(" ", s, e);
  const masked = chars.join("");
  if (OUTSIDE_RISK2.test(masked)) return null;
  const cut = masked.replace(HARMLESS_REDIRECT2, (r) => " ".repeat(r.length));
  const segs = [];
  let from = 0;
  const breaks = [...cut.matchAll(SEGMENT_BREAK2)].map((m) => ({ at: m.index, len: m[0].length }));
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
function inertSpans2(command, tool, openHead) {
  const none = /* @__PURE__ */ new Set();
  const plain = plainSegments2(command, tool);
  if (!plain) return none;
  const out4 = /* @__PURE__ */ new Set();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches2(PLAIN_HEAD2, masked, raw)) continue;
    if (openHead !== void 0 && headMatches2(openHead, masked, raw)) continue;
    if (!headMatches2(INERT_HEAD2, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out4.add(`${s}:${e}`);
  }
  return out4;
}
var TEXT_HEAD2 = /^\s*(?:echo|printf|Write-(?:Host|Output))(?=\s|$)/i;
var READ_HEAD2 = /^\s*(?:grep|cat|head|tail|Select-String|sls|Get-Content|gc|git\s+log)(?=\s|$)/i;
var OPTION_TRAP2 = /(?:^|\s)--ou/i;
var DASH_LOOKALIKE2 = /[–—―]/;
function isTextOnlyCommand2(command) {
  if (DASH_LOOKALIKE2.test(command)) return false;
  for (const tool of ["Bash", "PowerShell"]) {
    const plain = plainSegments2(command, tool);
    if (!plain) return false;
    for (const { from, end, masked } of plain.segs) {
      const raw = command.slice(from, end);
      if (!(headMatches2(PLAIN_HEAD2, masked, raw) || headMatches2(TEXT_HEAD2, masked, raw) || headMatches2(READ_HEAD2, masked, raw))) return false;
      if (OPTION_TRAP2.test(raw.replace(/["'\\]/g, ""))) return false;
    }
  }
  return true;
}
function blankInertQuotes2(command, tool) {
  if (tool !== void 0 && tool !== "Bash" && tool !== "PowerShell") return command;
  if (tool === "Bash") {
    const doc = blankDocHeredocBody2(command);
    if (doc !== command) return doc;
  }
  return blankSpans2(command, inertSpans2(command, "Bash"), inertSpans2(command, "PowerShell"));
}
function blankSpans2(command, bash, pwsh) {
  let out4 = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(":").map(Number);
    out4 = out4.slice(0, s + 1) + " ".repeat(e - s - 2) + out4.slice(e - 1);
  }
  return out4;
}

// src/shared/shell-tools.ts
init_trace_boot();
var BOTH2 = ["Bash", "PowerShell"];
var SHELL_TOOLS2 = /* @__PURE__ */ new Map([
  ["Bash", { field: "command", dialects: ["Bash"], failClosed: false }],
  ["PowerShell", { field: "command", dialects: ["PowerShell"], failClosed: false }],
  ["mcp__plugin_desktop-commander_desktop-commander__start_process", { field: "command", dialects: BOTH2, failClosed: true }],
  ["mcp__plugin_desktop-commander_desktop-commander__interact_with_process", { field: "input", dialects: BOTH2, failClosed: true }]
]);
function readShellCommand2(input) {
  const tool = input.tool_name || input.tool;
  const spec = tool ? SHELL_TOOLS2.get(tool) : void 0;
  if (!tool || !spec) return { kind: "not-shell" };
  const toolInput = input.tool_input;
  const text = toolInput && typeof toolInput === "object" ? toolInput[spec.field] : void 0;
  if (typeof text !== "string") {
    return spec.failClosed ? { kind: "unreadable", tool, field: spec.field } : { kind: "command", tool, text: "", dialects: spec.dialects };
  }
  return { kind: "command", tool, text, dialects: spec.dialects };
}
function mayRunUnderCmd2(tool) {
  return !!tool && tool.startsWith("mcp__plugin_desktop-commander_");
}

// src/shared/shell-ast.ts
init_trace_boot();
import fs5 from "node:fs/promises";
import { existsSync as existsSync7 } from "node:fs";
import { spawn as spawn2 } from "node:child_process";
import { createRequire as createRequire2 } from "node:module";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var HERE2 = fileURLToPath3(new URL(".", import.meta.url)).replace(/\\/g, "/");
var SHIPPED_WASM2 = `${HERE2}sh-syntax.wasm`;
var SHIPPED_WASM_EXEC2 = `${HERE2}sh-syntax-wasm_exec.cjs`;
var SHIPPED2 = existsSync7(SHIPPED_WASM2) && existsSync7(SHIPPED_WASM_EXEC2);
var WALKER2 = existsSync7(`${HERE2}shell-ast-walk.ps1`) ? `${HERE2}shell-ast-walk.ps1` : `${HERE2}../shell-ast-walk.ps1`;
function packageDir2() {
  if (process.env.SH_SYNTAX_DIR) return process.env.SH_SYNTAX_DIR.replace(/\\/g, "/");
  try {
    const pkg = createRequire2(import.meta.url).resolve("sh-syntax/package.json");
    return pkg.replace(/\\/g, "/").replace(/\/package\.json$/, "");
  } catch {
    return "";
  }
}
var SH_SYNTAX_DIR2 = packageDir2();
var WASM_PATH2 = SHIPPED2 ? SHIPPED_WASM2 : `${SH_SYNTAX_DIR2}/main.wasm`;
var WASM_EXEC_PATH2 = SHIPPED2 ? SHIPPED_WASM_EXEC2 : `${SH_SYNTAX_DIR2}/vendors/wasm_exec.cjs`;
var BinCmdOperator2 = { AndStmt: 11, OrStmt: 12, Pipe: 13, PipeAll: 14 };
var RedirOperator2 = { RdrIn: 65, RdrInOut: 66, DplIn: 67, Hdoc: 71, DashHdoc: 72, WordHdoc: 73 };
var ParExpOperator2 = { AssignUnset: 87, AssignUnsetOrNull: 88 };
var NO_SPANS2 = { quoted: [], substs: [], bodies: [] };
var BASH_KINDS_NOTE2 = ["File", "Stmt", "CallExpr", "BinaryCmd", "Word", "Lit", "SglQuoted", "DblQuoted", "ParamExp", "CmdSubst", "ProcSubst", "Assign", "Redirect", "Subshell", "Block", "IfClause", "WhileClause", "ForClause", "WordIter", "CaseClause", "CaseItem", "FuncDecl", "DeclClause", "TimeClause", "ArithmExp", "BinaryArithm", "ParenArithm", "ArrayExpr", "ArrayElem", "Comment", "CoprocClause", "CStyleLoop", "UnaryArithm", "TestClause"];
var BASH_KINDS_EXTRA2 = ["BinaryTest", "UnaryTest", "ArithmCmd", "LetClause"];
var PWSH_KINDS2 = ["ScriptBlockAst", "NamedBlockAst", "StatementBlockAst", "PipelineAst", "PipelineChainAst", "CommandAst", "CommandExpressionAst", "CommandParameterAst", "StringConstantExpressionAst", "ExpandableStringExpressionAst", "ConstantExpressionAst", "VariableExpressionAst", "MemberExpressionAst", "InvokeMemberExpressionAst", "ArrayExpressionAst", "ArrayLiteralAst", "HashtableAst", "ParenExpressionAst", "SubExpressionAst", "ScriptBlockExpressionAst", "BinaryExpressionAst", "UnaryExpressionAst", "ConvertExpressionAst", "TypeExpressionAst", "TypeConstraintAst", "IndexExpressionAst", "AssignmentStatementAst", "IfStatementAst", "ForStatementAst", "ForEachStatementAst", "WhileStatementAst", "DoWhileStatementAst", "DoUntilStatementAst", "SwitchStatementAst", "TryStatementAst", "CatchClauseAst", "TrapStatementAst", "FunctionDefinitionAst", "ParamBlockAst", "ParameterAst", "AttributeAst", "NamedAttributeArgumentAst", "FileRedirectionAst", "MergingRedirectionAst", "ReturnStatementAst", "BreakStatementAst", "ContinueStatementAst", "ThrowStatementAst", "ExitStatementAst", "UsingExpressionAst", "TernaryExpressionAst", "AttributedExpressionAst", "DataStatementAst"];
var CD_NAMES3 = /* @__PURE__ */ new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
var POP_NAMES2 = /* @__PURE__ */ new Set(["popd", "pop-location"]);
var SHELLS2 = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "ksh"]);
var PWSHS2 = /* @__PURE__ */ new Set(["pwsh", "powershell"]);
var READ_WRITERS2 = /* @__PURE__ */ new Set(["read", "mapfile", "readarray", "getopts"]);
var MAX_NEST2 = 4;
var processor3;
function bashProcessor2() {
  if (!processor3) {
    createRequire2(import.meta.url)(WASM_EXEC_PATH2);
    processor3 = getProcessor(() => fs5.readFile(WASM_PATH2));
  }
  return processor3;
}
async function parseBashRaw2(text) {
  return bashProcessor2()(text);
}
function progName2(lit) {
  if (lit == null) return null;
  return lit.replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
}
var GLOB2 = /[*?]|\[[^\]]*\]|\{[^{}]*(,|\.\.)[^{}]*\}/;
var DQ_ESC2 = /\\[$`"\\\n]/;
function partLit2(p) {
  if (p.type === "Lit") return /\\/.test(p.value) || GLOB2.test(p.value) ? null : p.value;
  if (p.type === "SglQuoted") return p.dollar && p.value.includes("\\") ? null : p.value;
  if (p.type === "DblQuoted") {
    if (p.dollar || !(p.parts ?? []).every((q) => q.type === "Lit")) return null;
    const v = p.parts.map((q) => q.value).join("");
    return DQ_ESC2.test(v) ? null : v;
  }
  return null;
}
function wordLit2(w) {
  let s = "";
  let shape = "";
  for (const p of w.parts ?? []) {
    const v = partLit2(p);
    if (v === null) return null;
    s += v;
    shape += p.type === "Lit" ? v : "Q";
  }
  if ((w.parts ?? []).length > 1 && GLOB2.test(shape)) return null;
  return s;
}
function partPrefix2(p) {
  if (p.type !== "DblQuoted") {
    const v = partLit2(p);
    return v === null ? { s: "", end: true } : { s: v, end: false };
  }
  let s = "";
  for (const q of p.parts ?? []) {
    const r = partPrefix2(q);
    s += r.s;
    if (r.end) return { s, end: true };
  }
  return { s, end: false };
}
function wordPrefix2(w) {
  let s = "";
  for (const p of w.parts ?? []) {
    const r = partPrefix2(p);
    s += r.s;
    if (r.end) break;
  }
  return s;
}
var walkAll2 = (n, fn) => {
  if (Array.isArray(n)) {
    n.forEach((x) => walkAll2(x, fn));
    return;
  }
  if (!n || typeof n !== "object") return;
  if (n.type) fn(n);
  for (const v of Object.values(n)) if (v && typeof v === "object") walkAll2(v, fn);
};
var nodesOf2 = (n, types) => {
  const out4 = [];
  walkAll2(n, (x) => {
    if (types.includes(x.type)) out4.push(x);
  });
  return out4;
};
var plainParam2 = (p) => !p.exp && !p.index && !p.repl && !p.slice && !p.names && !p.length && !p.excl && !p.width && !p.isSet && !p.flags;
function singleVar2(w) {
  const parts = w.parts ?? [];
  const p = parts.length === 1 ? parts[0] : null;
  const quoted = p?.type === "DblQuoted";
  const q = quoted && p.parts.length === 1 ? p.parts[0] : p;
  return q?.type === "ParamExp" && plainParam2(q) ? { name: q.param.value, quoted } : null;
}
function makeConv2(text) {
  const buf = Buffer.from(text, "utf8");
  const ascii = buf.length === text.length;
  return { c: (o) => ascii ? o : buf.subarray(0, o).toString().length, slice: (s, e) => ascii ? text.slice(s, e) : buf.subarray(s, e).toString() };
}
function makeBashWord2(w, conv) {
  const lit = wordLit2(w);
  const cs = nodesOf2(w, ["CmdSubst", "ProcSubst"]).length > 0;
  const sv = lit === null ? singleVar2(w) : null;
  const kind = lit !== null ? "lit" : cs ? "cmdsubst" : sv ? "var" : "dyn";
  const vars = nodesOf2(w, ["ParamExp"]).map((p) => p.param?.value).filter(Boolean);
  const [start, end] = [conv.c(w.start), conv.c(w.end)];
  const out4 = { lit, kind, raw: conv.slice(w.start, w.end), start, end, vars };
  if (sv) {
    out4.var = sv.name;
    out4.quoted = sv.quoted;
  }
  if (lit === null) out4.prefix = wordPrefix2(w);
  return out4;
}
function walkBash2(file, text) {
  const conv = makeConv2(text);
  const ev = [];
  const kinds = /* @__PURE__ */ new Set();
  const free = [];
  const quoted = [];
  const dqRanges = [];
  const substRaw = [];
  walkAll2(file, (n) => {
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
    const prog = s.cmd?.type === "CallExpr" && s.cmd.args.length ? progName2(wordLit2(s.cmd.args[0])) : null;
    for (const r of s.redirs ?? []) redirect(r, c, prog, s);
    cmd(s.cmd, c, s);
  };
  const heredocs = [];
  const redirect = (r, ctx, prog, s) => {
    for (const w of [r.word, r.hdoc]) if (w) subst(w, ctx);
    if (r.word && (r.op === RedirOperator2.Hdoc || r.op === RedirOperator2.DashHdoc)) delims.push([conv.c(r.word.start), conv.c(r.word.end)]);
    if (r.hdoc) heredocs.push({ start: conv.c(r.hdoc.start), end: conv.c(r.hdoc.end), pipe: ctx.place.pipe, callStart: s.cmd?.type === "CallExpr" && s.cmd.args.length ? conv.c(s.cmd.start) : null });
    if (r.hdoc && !ctx.place.pipe && !SHELLS2.has(prog ?? "") && !PWSHS2.has(prog ?? "")) free.push([conv.c(r.hdoc.start), conv.c(r.hdoc.end)]);
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
    const pipe = c.op === BinCmdOperator2.Pipe || c.op === BinCmdOperator2.PipeAll;
    const chain = c.op === BinCmdOperator2.AndStmt ? "&&" : c.op === BinCmdOperator2.OrStmt ? "||" : null;
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
      for (const a of c.assigns) ev.push({ t: "assign", name: a.name.value, lit: a.value && !a.array ? wordLit2(a.value) : null, raw: a.value ? conv.slice(a.value.start, a.value.end) : "", top: ctx.top });
      return;
    }
    const words = c.args.map((w) => makeBashWord2(w, conv));
    const assigns = c.assigns.map((a) => ({ name: a.name.value, lit: a.value ? wordLit2(a.value) : null }));
    const call2 = { t: "call", dialect: "bash", words, assigns, place: ctx.place, depth: ctx.depth, func: ctx.func, inFunctionBody: ctx.func !== null, op: null, stdin: stdinOf2(s), level: 0, start: conv.c(c.start), end: conv.c(c.end) };
    writersOf(words);
    ev.push(call2);
  };
  const writersOf = (words) => {
    const p = progName2(words[0].lit);
    if (READ_WRITERS2.has(p ?? "")) for (const w of words.slice(1)) ev.push({ t: "assign", name: w.lit ?? w.raw, lit: null, top: false });
    if (p === "printf") words.forEach((w, i) => w.lit === "-v" && words[i + 1] && ev.push({ t: "assign", name: words[i + 1].lit ?? words[i + 1].raw, lit: null, top: false }));
    if (["eval", "source", "."].includes(words[0].lit ?? "")) ev.push({ t: "unsafe" });
  };
  const paramWrites = (w) => {
    for (const p of nodesOf2(w, ["ParamExp"])) if (p.exp && (p.exp.op === ParExpOperator2.AssignUnset || p.exp.op === ParExpOperator2.AssignUnsetOrNull) && p.param) ev.push({ t: "assign", name: p.param.value, lit: null, top: false });
  };
  stmts(file.stmts, root);
  if (kinds.has("LetClause") || kinds.has("ArithmCmd") || kinds.has("ArithmExp") || kinds.has("CStyleLoop")) ev.push({ t: "unsafe" });
  return { events: ev, kinds, free, heredocs, spans: { quoted: quoted.filter(([a, b]) => !delims.some(([x, y]) => x <= a && b <= y)), substs, bodies: heredocs.map((h) => [h.start, h.end]) } };
}
var STDIN_OPS2 = [RedirOperator2.RdrIn, RedirOperator2.RdrInOut, RedirOperator2.DplIn, RedirOperator2.Hdoc, RedirOperator2.DashHdoc, RedirOperator2.WordHdoc];
function stdinOf2(s) {
  let last = null;
  for (const r of s?.redirs ?? []) {
    const fd = r.n?.value;
    if ((fd === void 0 || fd === "0") && STDIN_OPS2.includes(r.op)) last = r;
  }
  if (!last) return null;
  if (last.op === RedirOperator2.Hdoc || last.op === RedirOperator2.DashHdoc) return { lit: last.hdoc ? wordLit2(last.hdoc) : null };
  if (last.op === RedirOperator2.WordHdoc) return { lit: last.word ? wordLit2(last.word) : null };
  return { lit: null };
}
function runWalker2(text, timeoutMs) {
  return new Promise((resolve6) => {
    const cp = spawn2("pwsh", ["-NoProfile", "-NonInteractive", "-File", WALKER2], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out4 = "";
    let done = false;
    const fin = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve6(v);
      }
    };
    const timer = setTimeout(() => {
      cp.kill();
      fin({ error: "pwsh timeout" });
    }, timeoutMs);
    cp.stdout.setEncoding("utf8");
    cp.stdout.on("data", (d) => {
      out4 += d;
    });
    cp.on("error", (e) => fin({ error: `pwsh spawn: ${e.message}` }));
    cp.on("close", (code) => {
      if (code !== 0) return fin({ error: `pwsh exit ${code}` });
      try {
        fin({ json: JSON.parse(out4) });
      } catch {
        fin({ error: "pwsh bad json" });
      }
    });
    cp.stdin.on("error", () => {
    });
    cp.stdin.end(text, "utf8");
  });
}
function psWord2(el, text) {
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
function walkPwsh2(j, text) {
  const evs = [];
  for (const c of j.cmds) {
    const words = c.els.map((e) => psWord2(e, text));
    evs.push({ key: c.s, ev: { t: "call", dialect: "pwsh", words, assigns: [], place: { pipe: c.pipe, chain: c.chain, background: c.bg }, depth: c.depth, func: c.func, inFunctionBody: c.func !== null, op: c.op, stdin: null, level: 0, start: c.s, end: c.e } });
    for (const w of outVarWrites2(words)) evs.push({ key: c.s, ev: { t: "assign", name: w, lit: null, top: false } });
  }
  for (const a of j.assigns) evs.push({ key: a.end - 0.5, ev: { t: "assign", name: a.name, lit: a.lit, raw: text.slice(a.s, a.end), top: a.top } });
  evs.sort((x, y) => x.key - y.key);
  const rng = (l) => (Array.isArray(l) ? l : []).map((x) => [x.s, x.e]);
  const substs = (Array.isArray(j.substs) ? j.substs : []).map((x) => ({ from: x.s, to: x.e, dq: x.dq === true }));
  return { events: evs.map((x) => x.ev), kinds: new Set(j.kinds), free: j.comments.map((c) => [c.s, c.e]), heredocs: [], spans: { quoted: rng(j.quoted), substs, bodies: rng(j.bodies) } };
}
var OUTVAR2 = /^-(ov|outvariable|ev|errorvariable|iv|informationvariable|wv|warningvariable|pv|pipelinevariable)$/i;
function outVarWrites2(words) {
  const out4 = [];
  words.forEach((w, i) => {
    if (w.kind === "param" && OUTVAR2.test(w.lit ?? "") && words[i + 1]) out4.push(words[i + 1].lit ?? words[i + 1].raw);
  });
  return out4;
}
function cdTarget2(call) {
  const p = progName2(call.words[0].lit);
  if (POP_NAMES2.has(p ?? "")) return null;
  if (!CD_NAMES3.has(p ?? "")) return void 0;
  const arg = call.words.slice(1).find((w) => w.kind !== "param" && !(w.lit !== null && /^-./.test(w.lit)));
  return arg ? arg.lit : "~";
}
var BARRIER_PROGS2 = /* @__PURE__ */ new Set(["read", "mapfile", "readarray", "unset", "set-variable", "sv", "new-variable", "nv", "remove-variable", "rv", "clear-variable", "clv", "read-host"]);
var isBarrier2 = (e) => e.t === "barrier" || e.t === "call" && (BARRIER_PROGS2.has(progName2(e.words[0].lit) ?? "") || progName2(e.words[0].lit) === "set" && e.words.some((w) => w.lit === "--"));
function resolve4(events, dialect) {
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
    if (isBarrier2(e)) barriers.push(i);
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
    for (const w of e.words) resolveWord2(w, i, writes, key, unsafe, barriers);
    e.cwdBefore = [...cwd];
    const t = cdTarget2(e);
    if (t !== void 0) cwd.push(t);
  });
  const assigns = events.filter((e) => e.t === "assign").map((e) => ({ name: key(e.name), lit: e.lit, raw: e.raw ?? "", top: e.top }));
  return { calls: events.filter((e) => e.t === "call"), assigns };
}
var SPLITS2 = /[\s*?[\]{]|^$/;
function resolveWord2(w, i, writes, key, unsafe, barriers) {
  if (w.kind !== "var" || w.lit !== null || unsafe) return;
  const ws = writes.get(key(w.var));
  if (ws?.length !== 1 || ws[0].lit == null || !ws[0].top || !(ws[0].i < i)) return;
  if (barriers.some((b) => b > ws[0].i && b < i)) return;
  if (w.quoted === false && SPLITS2.test(ws[0].lit)) return;
  w.lit = ws[0].lit;
  w.kind = "lit";
  w.viaVar = w.var;
}
var isFlagC2 = (l) => /^-[A-Za-z]*c[A-Za-z]*$/.test(l);
var prefixOf2 = (long, l) => l.length >= 2 && long.startsWith(l.toLowerCase());
function joinLits2(words) {
  return words.some((w) => w.lit === null) ? null : words.map((w) => w.lit).join(" ");
}
function pwshPayloadIndex2(ws) {
  for (let k = 1; k < ws.length; k++) {
    const l = ws[k].lit;
    if (l === null || !/^-/.test(l)) continue;
    if (prefixOf2("-file", l)) return -1;
    if (prefixOf2("-command", l) || prefixOf2("-encodedcommand", l)) return k;
  }
  return -1;
}
function payloadOf2(call) {
  const ws = call.words;
  const p = progName2(ws[0].lit) ?? "";
  const lit = (i) => ws[i]?.lit ?? "";
  if (SHELLS2.has(p)) {
    const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && isFlagC2(w.lit));
    if (i > 0) return { dialect: "bash", via: "bash-c", text: ws[i + 1] ? ws[i + 1].lit : null };
    if (call.stdin) return { dialect: "bash", via: "stdin", text: call.stdin.lit };
  }
  if (PWSHS2.has(p)) {
    const i = pwshPayloadIndex2(ws);
    if (i > 0 && prefixOf2("-encodedcommand", lit(i))) return { dialect: "pwsh", via: "encoded", text: ws[i + 1]?.lit == null ? null : Buffer.from(ws[i + 1].lit, "base64").toString("utf16le") };
    if (i > 0) return { dialect: "pwsh", via: "pwsh-c", text: joinLits2(ws.slice(i + 1)) };
    if (call.stdin) return { dialect: "pwsh", via: "stdin", text: call.stdin.lit };
  }
  if (p === "eval") return { dialect: "bash", via: "eval", text: joinLits2(ws.slice(1)) };
  if (p === "iex" || p === "invoke-expression") return { dialect: "pwsh", via: "iex", text: ws[1] ? ws[1].lit : null };
  if (p === "cmd") return cmdPayload2(ws);
  return null;
}
function cmdPayload2(ws) {
  const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && /^\/[ck]$/i.test(w.lit));
  if (i < 0) return null;
  return { dialect: "cmd", via: "cmd-c", payload: ws.slice(i + 1).map((w) => w.lit ?? w.raw).join(" ") };
}
var XARGS_VALUE2 = /* @__PURE__ */ new Set(["-a", "-i", "-n", "-p", "-d", "-e", "-s", "-l", "-I", "-P", "-E", "-L", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--eof", "--replace"]);
function xargsInner2(call) {
  if (progName2(call.words[0].lit) !== "xargs") return null;
  let i = 1;
  while (i < call.words.length && call.words[i].lit !== null && /^-/.test(call.words[i].lit)) i += XARGS_VALUE2.has(call.words[i].lit) ? 2 : 1;
  const words = call.words.slice(i);
  return words.length ? { ...call, words, argsUnknown: true, viaPayload: "xargs", depth: call.depth + 1, level: call.level + 1, nested: void 0 } : null;
}
async function expandNested2(calls, opts, level) {
  if (opts.noNested) return calls;
  const out4 = [];
  for (const c of calls) {
    out4.push(c);
    const x = xargsInner2(c);
    if (x) out4.push(x);
    const pay = payloadOf2(c);
    if (!pay) continue;
    if (pay.dialect === "cmd") {
      c.nested = { status: "unparsed", dialect: "cmd", payload: pay.payload };
      continue;
    }
    if (pay.text === null || pay.text === void 0 || level >= MAX_NEST2) {
      c.nested = { status: "dynamic", via: pay.via };
      continue;
    }
    const r = await parseLevel2(pay.text, pay.dialect, opts, level + 1);
    if (!r.ok) {
      c.nested = { status: "error", via: pay.via, dialect: pay.dialect, text: pay.text };
      continue;
    }
    c.nested = { status: "parsed", via: pay.via, dialect: pay.dialect };
    for (const ic of r.calls) out4.push({ ...ic, depth: ic.depth + c.depth + 1, level: level + 1, viaPayload: pay.via, cwdBefore: [...c.cwdBefore ?? [], ...ic.cwdBefore ?? []] });
    r.kinds.forEach((k) => (c.nestedKinds ??= /* @__PURE__ */ new Set()).add(k));
  }
  return out4;
}
function lineOf2(text, offset) {
  return text.slice(0, offset).split("\n").length;
}
async function parseLevel2(text, dialect, opts, level) {
  const r = dialect === "pwsh" ? await levelPwsh2(text, opts) : await levelBash2(text, opts);
  if (!r.ok) return { ok: false, calls: [], errors: r.errors, kinds: r.kinds, freeRanges: [], heredocs: [], assigns: [], dialect, ...NO_SPANS2 };
  const { calls, assigns } = resolve4(r.events, dialect);
  const expanded = await expandNested2(calls, opts, level);
  const kinds = new Set(r.kinds);
  for (const c of expanded) c.nestedKinds?.forEach((k) => kinds.add(k));
  return { ok: true, calls: expanded, errors: [], kinds, freeRanges: r.free, heredocs: r.heredocs, assigns, dialect, ...r.spans ?? NO_SPANS2 };
}
async function levelBash2(text, opts = {}) {
  let file;
  try {
    file = await (opts.bashProvider ?? parseBashRaw2)(text);
  } catch (e) {
    const conv = makeConv2(text);
    const pos = e?.pos ?? { offset: 0, line: 1, column: 1 };
    return { ok: false, errors: [{ msg: String(e?.message ?? e), offset: conv.c(pos.offset), line: pos.line, column: pos.column, reader: e?.pos === void 0 }], kinds: /* @__PURE__ */ new Set() };
  }
  if (file === null || typeof file !== "object") return { ok: false, errors: [{ msg: "sh-syntax returned no tree", offset: 0, line: 1, reader: true }], kinds: /* @__PURE__ */ new Set() };
  const w = walkBash2(file, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}
async function levelPwsh2(text, opts) {
  const { json, error } = opts.pwshProvider ? opts.pwshProvider(text) : await runWalker2(text, opts.timeoutMs ?? 3e3);
  if (error || !json) return { ok: false, errors: [{ msg: error ?? "pwsh no result", offset: 0, line: 1, reader: true }], kinds: /* @__PURE__ */ new Set() };
  if (json.errors.length) return { ok: false, errors: json.errors.map((e) => ({ msg: e.msg, offset: e.offset, line: lineOf2(text, e.offset) })), kinds: new Set(json.kinds) };
  const w = walkPwsh2(json, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}
async function parseCalls2(text, dialect, opts = {}) {
  const r = await parseLevel2(text, dialect, opts, 0);
  return { ...r, kinds: [...r.kinds] };
}

// src/shared/shell-judge.ts
init_trace_boot();
var DEFAULT_KINDS2 = [...BASH_KINDS_NOTE2, ...BASH_KINDS_EXTRA2, ...PWSH_KINDS2];
var PROGRAM_WORDS2 = /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr)\b/i;
var VERB_WORDS2 = /\b(push|review|pulls)\b|\bpr\s+(create|merge)\b/i;
var DYNAMIC_SIGNS2 = /(^|\s)&\s|\b(iex|Invoke-Expression|Invoke-Command|Start-Process|cmd|bash|sh|pwsh|powershell)\b|-EncodedCommand/i;
var defaultEntry2 = (t) => PROGRAM_WORDS2.test(t) || VERB_WORDS2.test(t) || DYNAMIC_SIGNS2.test(t);
var GIT_BUILTIN2 = new Set("add am apply archive bisect blame branch bundle cat-file checkout cherry-pick clean clone commit config describe diff difftool fetch format-patch gc grep help init log ls-files ls-remote ls-tree merge mergetool mv notes pull push range-diff rebase reflog remote reset restore rev-list rev-parse revert rm shortlog show sparse-checkout stash status submodule switch tag version worktree".split(" "));

// src/shared/tap-scope.ts
init_trace_boot();
import * as fs6 from "fs";
import * as os4 from "os";
import * as path5 from "path";

// ../../scripts/github/lib/repo-identity.mjs
init_trace_boot();
var NAME2 = "([\\w.-]+)";
var TAIL2 = `${NAME2}\\/([\\w.-]+?)(?:\\.git)?\\/?$`;
var URL_FORM2 = new RegExp(`^(?:https?|git|ssh):\\/\\/(?:[^@/\\s]+@)?github\\.com(?::\\d+)?\\/${TAIL2}`, "i");
var SCP_FORM2 = new RegExp(`^(?:[\\w.-]+@)?github\\.com:${TAIL2}`, "i");
var HOST_TAIL2 = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/;
var SSH_FORM2 = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/|(?:[^@/\s:]+@)?[^@/\s:]{2,}:(?!\/\/))/i;
var SSH_HOST2 = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/(?:[^@/\s]+@)?([^/\s:]+)|(?:[^@/\s:]+@)?([^@/\s:]{2,}):)/i;
var githubHost2 = (host) => host === "github.com" || host === "ssh.github.com" || /^[a-z0-9_-]+$/.test(host);
var OWNER_REPO2 = /^([\w.-]+)\/([\w.-]+)$/;
var DOTS2 = /^\.+$/;
function repoSlug2(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  const m = URL_FORM2.exec(text) ?? SCP_FORM2.exec(text);
  if (!m || DOTS2.test(m[1]) || DOTS2.test(m[2])) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}
function normPath3(p) {
  let s = String(p ?? "").replace(/\\/g, "/").replace(/^\/\/[?.]\//, "");
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase();
  return s.replace(/(?<=.)\/{2,}/g, "/").replace(/(?<=.)\/+$/, "");
}
var isPathLike2 = (t) => /^[\\/.~]/.test(t) || /^[a-zA-Z]:(?:[\\/]|$)/.test(t) || /^file:/i.test(t);
function isUrlLike2(text) {
  const t = String(text ?? "").trim();
  return t !== "" && (isPathLike2(t) || t.includes(":"));
}
function githubField2(v) {
  if (typeof v !== "string") return null;
  const slug = repoSlug2(v);
  if (slug) return slug;
  const m = OWNER_REPO2.exec(v.trim());
  return m && !DOTS2.test(m[1]) && !DOTS2.test(m[2]) ? v.trim().toLowerCase() : null;
}
function stripCredentials2(text) {
  return String(text ?? "").trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1").replace(/^[^@/\s]+@(?=[^@/:\s]+:)/, "");
}
function targetOf3(url) {
  const t = url.trim();
  if (isPathLike2(t)) return normPath3(t.replace(/^file:\/\//i, ""));
  return stripCredentials2(t).replace(/\/+$/, "");
}
function sshTail2(url) {
  if (typeof url !== "string") return null;
  const t = url.trim();
  if (t === "" || isPathLike2(t) || !SSH_FORM2.test(t)) return null;
  const h = SSH_HOST2.exec(t);
  if (!h || !githubHost2((h[1] ?? h[2]).toLowerCase())) return null;
  const m = HOST_TAIL2.exec(t);
  return m && !DOTS2.test(m[1]) && !DOTS2.test(m[2]) ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
function keyRepo3({ url, entryKey, github } = {}) {
  const key = typeof entryKey === "string" ? entryKey.trim() : "";
  if (url === void 0 || url === null || String(url).trim() === "") return key ? `local:${key}` : null;
  const slug = repoSlug2(url);
  if (slug) return slug;
  const field = githubField2(github);
  if (field && sshTail2(String(url)) === field) return field;
  return key ? `local:${key}:${targetOf3(String(url))}` : null;
}
var needsGithubField3 = (url, github) => repoSlug2(url) === null && sshTail2(url) !== null && githubField2(github) === null;
var out2 = (git, args) => {
  const r = git(args);
  return r && r.status === 0 ? String(r.stdout ?? "").trim() : null;
};
var lines2 = (text) => (text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
var uniq2 = (list) => [...new Set(list)];
var remoteNames2 = (git) => lines2(out2(git, ["remote"]));
function pushRefOf2(git, names) {
  const m = /^refs\/remotes\/(.+)$/.exec(out2(git, ["rev-parse", "--symbolic-full-name", "@{push}"]) ?? "");
  if (!m) return null;
  const remote = names.filter((n) => m[1].startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: m[1].slice(remote.length + 1) } : null;
}
function remoteUrls2(git, remote, push) {
  return targetsOf2(git, remote, push)?.urls ?? null;
}
function targetsOf2(git, remote, push) {
  const listed = out2(git, ["remote", "get-url", ...push ? ["--push", "--all"] : [], "--end-of-options", remote]);
  if (listed !== null) return { urls: lines2(listed), configured: true };
  return isUrlLike2(remote) ? { urls: [remote.trim()], configured: false } : null;
}
var idFor2 = (t, { entryKey, github }) => ({ entryKey, github: t.configured ? github : null });
function pushKey3(git, { remote = null, branch = null, entryKey = null, github = null } = {}) {
  let d;
  const defaults = () => d ??= pushDefaults3(git, remote);
  const via = remote ?? defaults().remote;
  if (via === null) return { ok: false, why: "name-remote" };
  const t = targetsOf2(git, via, true);
  if (t === null || t.urls.length === 0) return { ok: false, why: "unknown-remote", remote: via };
  const id = idFor2(t, { entryKey, github });
  const keys = uniq2(t.urls.map((url) => keyRepo3({ url, ...id })));
  if (keys.includes(null)) return { ok: false, why: "no-key", remote: via };
  if (keys.length > 1) return { ok: false, why: "multi-pushurl", remote: via, keys };
  const dest = branch ?? defaults().branch;
  if (!dest) return { ok: false, why: "no-branch", remote: via, key: keys[0] };
  return { ok: true, key: keys[0], remote: via, branch: dest, configured: t.configured };
}
function pushDefaults3(git, remote = null) {
  const up = pushRefOf2(git, remoteNames2(git));
  const via = remote ?? up?.remote ?? null;
  const branch = up !== null && up.remote === via ? up.branch : out2(git, ["branch", "--show-current"]) ?? "";
  return { remote: via, branch };
}
function fetchKey2(git, remote, { entryKey = null, github = null } = {}) {
  const t = targetsOf2(git, remote, false);
  return t && t.urls.length > 0 ? keyRepo3({ url: t.urls[0], ...idFor2(t, { entryKey, github }) }) : null;
}
function ghRemote3(git, names = remoteNames2(git)) {
  return pushRefOf2(git, names)?.remote ?? (names.length === 1 ? names[0] : null);
}
function ghKey3(git, { named = null, entryKey = null, github = null } = {}) {
  const names = remoteNames2(git);
  const id = { entryKey, github };
  if (named !== null) {
    const hit = names.find((r) => fetchKey2(git, r, id) === named);
    if (hit !== void 0) return { ok: true, key: named, remote: hit };
    const via2 = ghRemote3(git, names);
    const key2 = via2 !== null ? fetchKey2(git, via2, id) : names.length === 0 ? keyRepo3({ entryKey }) : null;
    return { ok: false, why: "repo-differs", key: key2, remote: via2, remotes: names };
  }
  if (names.length === 0) return keyRepo3({ entryKey }) ? { ok: true, key: keyRepo3({ entryKey }), remote: null } : { ok: false, why: "no-key", remotes: names };
  const via = ghRemote3(git, names);
  if (via === null) return { ok: false, why: "two-remotes", remotes: names };
  const key = fetchKey2(git, via, id);
  if (key === null) return { ok: false, why: "no-key", remote: via, remotes: names };
  if (names.length > 1) return { ok: false, why: "unnamed", key, remote: via, remotes: names };
  const pushKeys = uniq2((remoteUrls2(git, via, true) ?? []).map((url) => keyRepo3({ url, entryKey, github })));
  if (pushKeys.some((k) => k !== key)) return { ok: false, why: "fetch-push-differ", key, remote: via, pushKeys };
  return { ok: true, key, remote: via };
}
function openPrKey3({ repo, branch, base = null } = {}) {
  const key = `${repo}@${branch}`;
  return typeof base === "string" && base !== "" ? `${key}:${base}` : key;
}
var UNSAFE_CHARS2 = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
function oneLine4(text, max) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`oneLine: max must be a whole number above 0, got ${max}`);
  const plain = String(text ?? "").normalize("NFKC").replace(UNSAFE_CHARS2, " ").replace(/\s+/gu, " ").trim();
  const points = [...plain];
  if (points.length <= max) return plain;
  return `${points.slice(0, max - 1).join("").trimEnd()}\u2026`;
}

// src/shared/tap-scope.ts
var CCV3_ENTRY2 = "continuous-claude";
var readUtf82 = (file) => fs6.readFileSync(file, "utf8");
var realNative2 = (p) => fs6.realpathSync.native(p);
var isNetwork2 = (p) => /^\/\//.test(normPath4(p));
var normPath4 = normPath3;
var isAbsolute3 = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
function realNorm2(p, realpath) {
  if (!p || !isAbsolute3(p)) return "";
  if (isNetwork2(p)) return normPath4(p);
  try {
    return normPath4(realpath(p));
  } catch {
    return normPath4(p);
  }
}
function registryFile2(opts) {
  const env = opts.env ?? process.env;
  if (opts.path) return opts.path;
  if (env.LANE_REGISTRY_PATH) return env.LANE_REGISTRY_PATH;
  const home = env.USERPROFILE || env.HOME || (opts.deps?.homedir ?? os4.homedir)();
  return path5.join(home, ".claude", "project-registry.json");
}
var slugify2 = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function entryOf2(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const e = item;
  const key = typeof e.key === "string" && e.key ? e.key : slugify2(typeof e.name === "string" ? e.name : "");
  const raw = typeof e.path === "string" ? e.path : "";
  const root = raw && isAbsolute3(raw) ? normPath4(raw) : "";
  if (!key || !root) return null;
  const status = typeof e.status === "string" ? e.status : "active";
  return { key, root, status, tapGate: typeof e.tapGate === "string" ? e.tapGate : null, github: typeof e.github === "string" ? e.github : null };
}
function readRegistry2(opts = {}) {
  const file = registryFile2(opts);
  const named = !opts.path && Boolean((opts.env ?? process.env).LANE_REGISTRY_PATH);
  const first = readOnce2(file, opts);
  const r = first.state === "corrupt" ? readOnce2(file, opts) : first;
  return named ? { ...r, envPath: true } : r;
}
function readOnce2(file, opts) {
  let text;
  try {
    text = (opts.deps?.readFile ?? readUtf82)(file);
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
  const entries = projects.map(entryOf2).filter((e) => e !== null);
  return { state: "ok", entries, file };
}
var notCovered2 = (reason, entryKey = null) => ({ covered: false, entryKey, reason });
var entryReal2 = (e, realpath) => realNorm2(e.root, realpath);
function firstEntry2(dir, entries, realpath, test) {
  if (!dir || !isAbsolute3(dir)) return null;
  const raw = normPath4(dir);
  const byRaw = entries.find((e) => test(raw, e.root));
  if (byRaw) return byRaw;
  const real = realNorm2(dir, realpath);
  const byReal = entries.find((e) => test(real, e.root));
  if (byReal) return byReal;
  return entries.find((e) => [raw, real].some((folder) => test(folder, entryReal2(e, realpath)))) ?? null;
}
var sameDir2 = (folder, root) => folder === root;
var isUnder2 = (folder, root) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);
function nearestEntry2(input, entries, realpath) {
  return firstEntry2(input.toplevel, entries, realpath, sameDir2) ?? firstEntry2(input.worktreeMainRoot ?? "", entries, realpath, sameDir2);
}
function coverageOf2(input, registry, deps = {}) {
  if (input.isCcv3) return notCovered2("ccv3");
  if (registry.state === "missing") return notCovered2("registry-missing");
  if (registry.state === "corrupt") return notCovered2("registry-corrupt");
  const entry = nearestEntry2(input, registry.entries, deps.realpath ?? realNative2);
  if (!entry) return notCovered2("no-entry");
  if (entry.key === CCV3_ENTRY2) return notCovered2("ccv3-root", entry.key);
  if (entry.status.toLowerCase() === "inactive") return notCovered2("inactive", entry.key);
  if (entry.tapGate?.trim().toLowerCase() === "off") return notCovered2("off", entry.key);
  return { covered: true, entryKey: entry.key, reason: "covered", github: entry.github };
}
var isLive2 = (e) => e.key !== CCV3_ENTRY2 && e.status.toLowerCase() !== "inactive" && e.tapGate?.trim().toLowerCase() !== "off";
var parentOf2 = (p) => {
  const up = p.replace(/\/[^/]*$/, "");
  return up === "" ? "/" : up;
};
var dotGitOf2 = (dir) => dir.endsWith("/") ? `${dir}.git` : `${dir}/.git`;
function rootOfGitFile2(top, text, readFile) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = joinPath2(top, m[1]);
  let common = gitdir;
  try {
    common = joinPath2(gitdir, readFile(`${gitdir}/commondir`).trim());
  } catch {
  }
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}
function joinPath2(base, rel) {
  if (isAbsolute3(rel)) return normPath4(rel);
  return normPath4(path5.posix.normalize(`${normPath4(base)}/${rel.replace(/\\/g, "/")}`));
}
function worktreeRootOf2(dir, readFile) {
  let cur = normPath4(dir);
  for (let i = 0; i < 64; i++) {
    let text = null;
    try {
      text = readFile(dotGitOf2(cur));
    } catch (err) {
      const code = err?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    if (text !== null) return rootOfGitFile2(cur, text, readFile);
    const up = parentOf2(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}
function underLiveRoot2(dir, registry, deps = {}, opts = {}) {
  if (registry.state !== "ok" || !dir || !isAbsolute3(dir)) return false;
  const realpath = deps.realpath ?? realNative2;
  if (opts.outsideCcv3 && firstEntry2(dir, registry.entries.filter((e) => e.key === CCV3_ENTRY2), realpath, isUnder2)) return false;
  const live = registry.entries.filter(isLive2);
  if (firstEntry2(dir, live, realpath, isUnder2)) return true;
  if (isNetwork2(dir)) return false;
  const main4 = worktreeRootOf2(dir, deps.readFile ?? readUtf82);
  return main4 !== null && firstEntry2(main4, live, realpath, isUnder2) !== null;
}
var keyRepo4 = keyRepo3;
var oneLine5 = oneLine4;
var pushKey4 = pushKey3;
var ghKey4 = ghKey3;
var pushDefaults4 = pushDefaults3;
var ghRemote4 = (git) => ghRemote3(git);
var openPrKey4 = openPrKey3;
var needsGithubField4 = needsGithubField3;

// src/decision-gate.ts
var HOOK2 = "decision-gate";
var noCreds2 = stripCredentials2;
var DC2 = "mcp__plugin_desktop-commander_desktop-commander__";
var COMMAND_TOOLS4 = /* @__PURE__ */ new Set(["Bash", "PowerShell", `${DC2}start_process`, `${DC2}interact_with_process`]);
var WRITE_TOOLS2 = /* @__PURE__ */ new Set(["Write", "Edit", "NotebookEdit", `${DC2}write_file`, `${DC2}edit_block`, `${DC2}move_file`, `${DC2}write_pdf`]);
var PATH_FIELDS2 = ["file_path", "notebook_path", "path", "destination", "source", "outputPath"];
var GIT_TIMEOUT_MS2 = 2e3;
var FLOOR_IMPL = { withParsed, decide };
var isOpenPrLabel2 = (label) => /^Open draft PR\b/.test(label);
var isLandLabel2 = (label) => /^Land (?:now|when READY)\b/.test(label);
var isShipLabel2 = (label) => /^Commit and push\b/.test(label);
var isPushOnlyLabel2 = (label) => /^Push only(?: \(Recommended\))?$/.test(label);
var isMergeNowLabel2 = (label) => /^Merge now \(no READY check\)(?: \(Recommended\))?$/.test(label);
var deny2 = (pattern, why, scope = "other") => ({ action: "deny", pattern, scope, reason: `BLOCKED (decision-gate): ${why}` });
var openPrWhy2 = (branch, head) => `no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
var landWhy2 = (pr) => `no "land" decision from Dave for PR #${pr}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json, pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets a land run. If the PR already merged, run land-pr.ps1 -Pr ${pr} -CleanupOnly.`;
var pushWhy2 = (branch) => `no "ship" decision from Dave for the tree you push to ${branch}. Ask him first: run node scripts/github/ship-ask.mjs commit-and-push --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged). The tap is bound to one tree: the staged tree, or HEAD's tree for "Push only". A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
var PUSH_UNSAFE_WHY2 = "a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs, so it stays blocked even with Dave's tap. Push without that option. If it is really needed, ask Dave to run it himself.";
var PUSH_REFSPEC_WHY2 = "a refspec that names a ref outside refs/heads and refs/tags, or holds a wildcard, can send refs that must stay local (refs/eval/*). Push one branch by name: git push fork <branch>.";
var PUSH_REPO_OPT_WHY2 = "a --repo option names the push target, so the remote this gate reads is not where the push goes. Name the fork remote and push from the repo.";
var PUSH_ORIGIN_WHY2 = "a push to origin is never allowed: origin is upstream (parcadei), not the fork. Push to the fork remote.";
var pushUnresolvedWhy2 = (what) => `${what}, so its ship decision cannot be found. Name the remote and branch (git push fork <branch>) and run it from the repo.`;
var STORE_WHY2 = "only decision-ledger writes the decision store, from Dave's tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.";
var PAID_MENTION_RE2 = /@coderabbitai/i;
var PAID_FLAG_RE2 = /use[-_\s]*credits/i;
var PAID_WHY2 = "a paid CodeRabbit request runs only through node scripts/github/cr-paid.mjs post --pr N, which reads Dave's priced yes.";
var CAP_FLAG_RE2 = /--cli-(?:cap-usd|extra-run)/i;
var CAP_LIFT_RE2 = /^Lift the cap for this one run(?: \(Recommended\))?$/;
var CAP_KEY_MARK2 = "!cap:";
var CAP_WHY2 = `the CLI cap override flags (the USD flag and the extra-run flag of pre-pr.mjs and cr-fix.mjs) run only with Dave's tap for this branch, this head and exactly these flags. Ask him first: run node scripts/github/ship-ask.mjs cap-override --branch <branch> [--usd N] [--extra-run] --json, pass its JSON to AskUserQuestion word for word, then run the command once with exactly the flags he tapped. The tap is single use. This gate reads git at the session folder (the folder this session runs in, not a folder the command moves to), so run the flag from the checkout of the tapped branch with no cd in the command. Text that only names a flag (a message, an echo, a search) is denied too: say "the USD flag" or "the extra-run flag" instead.`;
var SUBAGENT_WHY2 = "a subagent cannot open a PR, land, merge or push: Dave's tap belongs to the main session. Ask the main session to do it.";
var NO_PR_WHY2 = "the PR number cannot be read from this command, so its land decision cannot be found. Name the PR number in the command (land-pr.ps1 -Pr <n>, gh pr merge <n>).";
var goThereWhy2 = (repo) => `this command names ${repo}, which is not the CCv3 repo, so it cannot be judged with a CCv3 decision: go to that repo folder and run it there.`;
var fwd2 = (p) => p.replace(/\\/g, "/");
var CREDS_RE2 = /([a-z][a-z0-9+.-]*:\/\/)[^\s/'"\\]*@/gi;
var prose2 = (v) => oneLine5(v.replace(CREDS_RE2, "$1"), 200);
var at2 = (dir) => prose2(fwd2(dir));
var remoteProse2 = (remote) => prose2(noCreds2(remote));
var SAFE_WORD2 = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+-]*$/;
var SAFE_REMOTE2 = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+:-]*$/;
var SAFE_DIR2 = /^[A-Za-z0-9._/@+:\\ -]+$/;
var CWDS2 = /* @__PURE__ */ new WeakMap();
var stopLine2 = (name, value) => `the ${name} ${prose2(value)} cannot be passed safely in a command; tell Dave.`;
function currentIn2(deps, dir) {
  const r = deps.git(dir, ["branch", "--show-current"]);
  return r.status === 0 ? r.stdout.trim() : null;
}
function appAskReads2(deps, dir, offer, name) {
  const git = gitIn2(deps, dir);
  try {
    if (name === "remote") return offer.sub === "push" ? pushDefaults4(git, null).remote : ghRemote4(git);
    if (name === "branch") return offer.sub === "push" ? pushDefaults4(git, offer.remote ?? null).branch : currentIn2(deps, dir);
    return currentIn2(deps, dir);
  } catch {
    return null;
  }
}
function flagWord2(deps, dir, offer, flag, value, safe) {
  if (value === `<${flag}>` || safe.test(value)) return `--${flag} ${value}`;
  if (flag === "pr" || flag === "base") return null;
  const read = appAskReads2(deps, dir, offer, flag === "src" ? "current" : flag);
  if (read !== value) return null;
  return flag === "src" ? "--src HEAD" : "";
}
function askCmd2(deps, offer, dir) {
  if (offer.stop) return { ok: false, text: offer.stop };
  const flags = [
    // Seat 3d: the remote with no user:token part. app-ask keys a URL by its owner/repo (repoSlug) or its stripped text, so the key is the same.
    ["pr", offer.pr, /^\d+$/],
    ["remote", offer.remote ? noCreds2(offer.remote) : offer.remote, SAFE_REMOTE2],
    ["branch", offer.branch, SAFE_WORD2],
    ["src", offer.src, SAFE_WORD2],
    ["base", offer.base, SAFE_WORD2]
  ];
  const words = [offer.sub];
  const read = [];
  for (const [flag, value, safe] of flags) {
    if (value === void 0 || value === null) continue;
    const word = flagWord2(deps, dir, offer, flag, value, safe);
    if (word === null) return { ok: false, text: stopLine2(flag, value) };
    if (word === "") read.push(flag);
    else words.push(word);
  }
  const folder = fwd2(dir);
  if (SAFE_DIR2.test(folder)) words.push(`--dir '${folder}'`);
  else if (fwd2(CWDS2.get(deps) ?? "") === folder) read.push("folder");
  else return { ok: false, text: stopLine2("folder", folder) };
  const note = read.length === 0 ? "" : ` (app-ask reads the ${read.join(" and the ")} itself: run it in that folder, on that branch)`;
  const script = `${fwd2(deps.home)}/continuous-claude/scripts/github/app-ask.mjs`;
  if (!SAFE_DIR2.test(script)) return { ok: false, text: stopLine2("script path", script) };
  return { ok: true, text: `node '${script}' ${words.join(" ")} --json${note}` };
}
var askPart2 = (deps, offer, dir, ok) => {
  const a = askCmd2(deps, offer, dir);
  return a.ok ? ok(a.text) : `Dave's question cannot be built as a command here: ${a.text}`;
};
var ASK_HOW2 = "pass its JSON to AskUserQuestion word for word";
var appOpenPrWhy2 = (deps, dir, repo, branch, head, base) => `no "open-pr" decision from Dave for ${prose2(branch)}${base === null ? "" : ` into ${prose2(base)}`} at ${prose2(head.slice(0, 7))} in ${prose2(repo.key)} (folder ${at2(dir)}). ${askPart2(deps, { ...repo.offer, branch, ...base === null ? {} : { base } }, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW2}, then open the PR only if he taps "Open draft PR".`)}`;
var appMergeWhy2 = (deps, dir, repo, pr) => `no "land" decision from Dave for PR #${prose2(pr)} of ${prose2(repo.key)} at the head this command names (folder ${at2(dir)}). ${askPart2(deps, repo.offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW2}.`)} Only "Merge now (no READY check)" lets the merge run, with sha= or --match-head-commit equal to the head he tapped.`;
var appMergeNoHeadWhy2 = (deps, dir, pr, offer) => `PR #${prose2(pr)} (folder ${at2(dir)}): a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Pass the tapped head: gh api .../merge -f sha=<head>, or gh pr merge ${/^\d+$/.test(pr) ? pr : "<n>"} --match-head-commit <head>. ${askPart2(deps, offer, dir, (c) => `Ask the merge question first: ${c}.`)}`;
var appNoPrWhy2 = (dir) => `the PR number cannot be read from this command (folder ${at2(dir)}), so its land decision cannot be found. Name the PR number in the command (gh pr merge <n>).`;
function pushNeed2(risk) {
  if (risk.kind === "default") return "A push to main, master or the branch the remote HEAD names needs his tap; a push to another branch does not.";
  if (risk.kind === "unsure") return "This push can update a default branch of the repo, so it needs his tap.";
  if (!SAFE_WORD2.test(risk.remote)) return `The default branch of remote ${remoteProse2(risk.remote)} is not known in this checkout, so this push needs his tap.`;
  return `The default branch of remote ${remoteProse2(risk.remote)} is not known in this checkout; git remote set-head ${risk.remote} --auto records it.`;
}
var appPushWhy2 = (deps, dir, repo, branch, offer, risk) => `no "ship" decision from Dave for the tree you push to ${prose2(branch)}${risk.kind === "default" ? ", a default branch of" : " in"} ${prose2(repo)} (folder ${at2(dir)}). ${pushNeed2(risk)} ${askPart2(deps, offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW2}, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged).`)} The tap is bound to this repo, this branch and one tree. A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
var PUSH_WAY_OUT2 = "run git push as its own command: git push <remote> <branch>";
var appNotAloneWhy2 = (deps, dir, offer) => `this push shares its command with another command, a pipe or a redirect (folder ${at2(dir)}), so Dave's "Push only" tap does not count for it. To clear it, ${PUSH_WAY_OUT2}. ${askPart2(deps, offer, dir, (c) => `If the gate still asks for his tap then, ask him first: run ${c}, ${ASK_HOW2}.`)}`;
var appPushUrlsWhy2 = (dir, remote, keys) => `remote ${remoteProse2(remote)} of ${at2(dir)} pushes to more than one repo (${prose2(keys.join(", "))}), and one tap covers one push URL, so this push stays blocked even with Dave's tap. Push to one URL (git push <url> <branch>), or ask Dave to run it himself.`;
var ghRepoArg2 = (key) => SAFE_WORD2.test(key) && !key.startsWith("local:") ? key : "<owner/repo>";
var appFetchPushWhy2 = (deps, dir, remote, key, pushKeys, offer) => `remote ${remoteProse2(remote)} of ${at2(dir)} fetches from ${prose2(key)} but pushes to ${prose2(pushKeys.join(", "))}, so gh may act on another repo than the tap names. Name the repo gh acts on: add -R ${ghRepoArg2(key)} to the command. ${askPart2(deps, offer, dir, (c) => `The question for it: ${c}.`)}`;
var appNoTargetWhy2 = (deps, dir, remotes, offer) => `${at2(dir)} has more than one remote (${prose2(remotes.join(", "))}) and its branch has no push target (@{push}), so the repo gh acts on is not known. Name the repo: add -R <owner/repo> (the repo of one remote). ${askPart2(deps, offer, dir, (c) => `Then ask the question for that remote: ${c}.`)} Or set the push target first: git branch --set-upstream-to=<remote>/<branch>.`;
var appNameRemoteWhy2 = (deps, dir) => `this push names no remote and its branch has no push target (@{push}) in ${at2(dir)}, so the repo of its ship decision cannot be known: name the remote and the branch (git push <remote> <branch>). ${askPart2(deps, { sub: "push", remote: "<remote>" }, dir, (c) => `Ask the ship question for that remote: ${c}.`)}`;
var appRepoOptWhy2 = (dir) => `--repo names the target of this push in ${at2(dir)}, so the repo of its ship decision cannot be known, and it stays blocked even with Dave's tap: name the repo as the remote argument (git push <remote> <branch>).`;
var appPushUnresolvedWhy2 = (dir, what) => `${prose2(what)} (folder ${at2(dir)}), so its ship decision cannot be found. Name the remote and the branch (git push <remote> <branch>) and run it from the repo folder.`;
var INDEX_TREE2 = "the index (git write-tree)";
var appTreeWhy2 = (dir, what) => {
  const plain = what === INDEX_TREE2 || what === "HEAD" || strictBranch2(what);
  return `cannot read the tree of ${prose2(what)} in ${at2(dir)}, so its ship decision cannot be found. ${plain ? "Run the command again from the repo folder." : "To clear it, name the branch as plain text: git push <remote> <branch>."}`;
};
var appUnsafeWhy2 = (dir) => `a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs (folder ${at2(dir)}), so it stays blocked even with Dave's tap. Push without that option. If it is really needed, ask Dave to run it himself.`;
var appUnsafeConfigWhy2 = (dir, remote, key) => `remote ${remoteProse2(remote)} is set as a mirror or has a + push refspec (${prose2(key)}) in ${at2(dir)}, so this push can rewrite or remove remote refs and stays blocked even with Dave's tap; ask Dave to run it himself or to change that config.`;
var WIDER_WHY2 = "git config makes this push write more than the branch it names; name both sides: git push <remote> <src>:<dst> --no-recurse-submodules, or ask Dave";
var appWiderConfigWhy2 = (dir, key) => `${WIDER_WHY2}. The key: ${prose2(key)} (folder ${at2(dir)}).${key === "push.followtags" ? " With push.followTags set, add --no-follow-tags too." : ""} A tap cannot cover it: the tap names one branch.`;
var appWiderOptWhy2 = (dir, opt) => `${prose2(opt)} makes this push write more than the branch it names (tags, other branches or submodule repos) in ${at2(dir)}, so it stays blocked even with Dave's tap: a tap names one branch. ${opt.startsWith("-c ") ? "Run git push with no -c push setting" : "Push without that option"}, or ask Dave.`;
var appRawUnsafeWhy2 = (dir) => `this command holds a git push that is not one plain git push call, and a force or delete spelling is in its text (--force, --mirror, --delete, -f or -d in a short option bundle, a word that starts with +, a :branch delete, --all, --tags, --prune or --branches; folder ${at2(dir)}), so it stays blocked even with Dave's tap. Run the push as its own command with no such word in it: git push <remote> <branch>. If a force push is really needed, ask Dave to run it himself.`;
var appUnreadWhy2 = (dir) => `this command holds a git push that this gate cannot read as one plain git push call (folder ${at2(dir)}): a global option or an option it does not know, more than one -C, a shell -c, eval, a control word, a substitution or a git alias. To clear it, ${PUSH_WAY_OUT2}, with no global option before push (git -C <folder> push is fine).`;
var unpairedWhy2 = (dir) => `a quote mark in this command has no pair (a message the gate cannot read as one string), so where its PR create or merge runs and the repo it names cannot be read (folder ${at2(dir)}). Put the message in a file (git commit -F <file>, --body-file <file>) and run the gh call as its own command.`;
var appBundleWhy2 = (dir) => `a short option bundle with o (as in -oh or -uo) gives the rest of the word, or the next word, to the push option (folder ${at2(dir)}), so the other flags of this push cannot be read: write -o <value> as its own word (git push -o <value> <remote> <branch>).`;
var appSubagentWhy2 = (dir) => `a subagent cannot push in ${at2(dir)}: Dave's tap belongs to the main session. Ask the main session to do it.`;
var appManyHeadsWhy2 = (dir, heads) => `this create names more than one head (${prose2(heads.join(", "))}) in ${at2(dir)}; gh opens the PR from the last one, so the head its open-pr decision is for cannot be known. Name one head (gh pr create --head <branch>, or one -f head=<branch>).`;
var appHeadOwnerWhy2 = (dir, owner) => `this create names its head with the owner ${prose2(owner)}: (in ${at2(dir)}), so the PR would open from that owner's fork, and a tap from Dave covers only a branch of this checkout. Name the head with no owner: prefix (gh pr create --head <branch>), or ask Dave to open it.`;
var appHeadWhy2 = (dir) => `the head branch of this create cannot be named in ${at2(dir)} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo folder on a branch.`;
var appManyBasesWhy2 = (dir, bases) => `this create names more than one base branch (${prose2(bases.join(", "))}) in ${at2(dir)}, so the base its open-pr decision is for cannot be known. Name one base (gh pr create --base <branch>, or one -f base=<branch>).`;
var appHeadReadWhy2 = (dir, branch) => `cannot read the head of ${prose2(branch)} in ${at2(dir)}, so its open-pr decision cannot be found. Run the command again from the repo folder.`;
var appRepoUnreadableWhy2 = (dir) => `the repo this command names is a variable (-R $R, GH_REPO=$X), so it cannot be compared with the repo of ${at2(dir)}. Name the repo as owner/repo text.`;
var appRepoDiffersWhy2 = (deps, dir, named, key, offer) => `this command names ${prose2(named)}, but no remote of ${at2(dir)} fetches from it (the repo of the folder is ${key === null ? "not known: several remotes and no push target" : prose2(key)}). Run it from the folder of the repo it names, or name the repo of one of its remotes. ${askPart2(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appRepoUnnamedWhy2 = (deps, dir, offer, key) => `${at2(dir)} has more than one remote, so gh may act on another repo than the tap names. Name the repo: -R ${key === null ? "<owner/repo>" : ghRepoArg2(key)} for the branch's push target (@{push}), or the repo of another remote. ${askPart2(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appPositionWhy2 = (deps, dir, offer) => `popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, and ${at2(dir)} is judged for Dave's tap, so the folder this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd. ${askPart2(deps, offer, dir, (c) => `The question for that folder: ${c}.`)}`;
var needsFieldLine2 = (entryKey, remote) => `the registry entry ${prose2(entryKey)} needs a github field naming owner/repo (remote ${remoteProse2(remote)} is an SSH host alias, so gh has no repo to act on); tell Dave.`;
var inAppFolder2 = (dir) => ` The command starts in ${at2(dir)}, a folder judged for Dave's tap.`;
var corruptLine = (file) => `WARNING (decision-gate): the project registry ${prose2(fwd2(file))} cannot be read. Tell Dave.`;
var CORRUPT_EFFECT = "folders outside CCv3 were not checked for Dave's tap (nothing is covered while the file is missing)";
var registryCorruptWhy2 = (file, dir) => `the project registry ${prose2(fwd2(file))} exists but cannot be parsed (read twice), so this folder (${at2(dir)}) cannot be checked for Dave's tap, and a push, PR create or merge outside CCv3 stays blocked. Fix the file (valid JSON with a projects list), or ask Dave.`;
var norm2 = (p) => p.replace(/\\/g, "/").toLowerCase();
var STORE_PATH_RE2 = /ccv3-mods\/decisions\.json(?:\.|$)/;
var STORE_TEXT_RE2 = /ccv3-mods\/+decisions\.json(?![\w-])/;
function dropAliasSuffix2(p) {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1;
  const leaf = p.slice(cut).replace(/:.*$/s, "").replace(/([^. ])[. ]+$/, "$1");
  return p.slice(0, cut) + leaf;
}
function isStorePath2(p, deps, cwd) {
  const full = norm2(resolve5(cwd, dropAliasSuffix2(p)));
  const store = norm2(decisionsPath2(deps.env));
  return STORE_PATH_RE2.test(full) || full === store || full.startsWith(`${store}.`);
}
var escRe2 = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function readCopyRe2(deps) {
  const store = escRe2(norm2(decisionsPath2(deps.env)));
  return new RegExp(`\\b(?:cp|copy|copy-item)\\s+(?:-(?:[frpavinu]{1,4}|-?(?:force|recurse|recursive|verbose|confirm|whatif))\\s+)*["']?(?:(?:[^\\s"';|&]*\\/)?ccv3-mods\\/+decisions\\.json|${store})["']?(?=\\s+[^\\s;|&])`, "gi");
}
var STORE_CODE_RE2 = /[\\/]lib[\\/]decisions\.mjs/i;
var STORE_FN_RE2 = /\b(?:decisionRecord|offerWrite|decisionUse|missBump)\b/;
var WRITE_SIGNAL_RE2 = /(?<![\d&])>|\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|tee|sed|mv|cp|rm|del|truncate|dd|ln)\b|\b(?:writeFile|appendFile|writeFileSync|rename)/i;
var CODE_SIGNAL_RE2 = /\bnode(?:\.exe)?\b[^|;&\n]*?(?:\s-e\b|\s--eval\b|\s-p\b|\s--print\b|--input-type)|\bimport\s*\(|\brequire\s*\(/i;
var READ_ONLY_CODE_RE2 = /\b(?:readFileSync|readFile)\s*\(|\brequire\s*\(\s*["'][^"']*decisions\.json["']\s*\)/;
var CODE_CAN_WRITE_RE2 = new RegExp([
  "write|append|copy|rename|unlink|\\brm|truncate|open|link|mkdir|chmod|chown|utimes|stream|child_process|spawn|exec|eval|\\bFunction\\b|import\\s*\\(|\\bflags?\\b|O_[A-Z]",
  "process\\.binding|decisions\\.mjs|decisionRecord|offerWrite|decisionUse|missBump|fetch|https?:",
  `\\brequire\\s*\\(\\s*(?!["'](?:(?:node:)?fs|[^"']*decisions\\.json)["']\\s*\\))`,
  "[\"'`]\\s*\\+|\\+\\s*[\"'`]|\\$\\{|\\[\\s*[\"'`]"
].join("|"), "i");
var USE_TAP_RE2 = /land-decision\.mjs["']?\s+["']?use\b/i;
var CHECKPOINT_RUN_RE2 = /pr-checkpoint\.mjs\b(?=[^\n]*--json)(?=[^\n]*--pr\b)/i;
var LOOP_RE2 = /\b(?:for|foreach|while|until|xargs|seq)\b|ForEach-Object|\d+\.\.\d+|%\s*\{/i;
function writesStoreText2(text, deps) {
  if (USE_TAP_RE2.test(text) || CHECKPOINT_RUN_RE2.test(text) && LOOP_RE2.test(text)) return true;
  const flat = text.replace(/\\/g, "/");
  const lower = norm2(flat.replace(readCopyRe2(deps), " "));
  const names = [lower, squashQuotes(lower)].some((t) => STORE_TEXT_RE2.test(t)) || lower.includes(norm2(decisionsPath2(deps.env)));
  const code = CODE_SIGNAL_RE2.test(text);
  if (names || STORE_CODE_RE2.test(text)) {
    if (WRITE_SIGNAL_RE2.test(flat)) return true;
    if (!code) return false;
    return !(names && !STORE_CODE_RE2.test(text) && READ_ONLY_CODE_RE2.test(text) && !CODE_CAN_WRITE_RE2.test(text));
  }
  return STORE_FN_RE2.test(text) && code;
}
var NO_PRIOR2 = { repos: [], nonLiteral: false };
var scopeOf = (s) => s.kind === "push" ? "push" : "other";
var LAND_SCRIPT_RE2 = /\bland-pr\.ps1\b/i;
var LAND_PR_RE2 = /(?:^|\s)-P(?:r)?(?:\s+|:|=)["']?(\d+)(?![\w`])/i;
var PR_NUMBER_IN_TEXT_RE2 = /-Pr?[\s:="']*\d/i;
var CLEANUP_RE2 = /(?:^|\s)-CleanupOnly(?::["']?\$?true["']?)?(?![\w:$`.\[(-])/i;
var MERGE_API_RE2 = /\bgh\s+api\b[^|;&\n]*\/pulls\/(\d+)\/merge\b[^|;&\n]*/i;
var GET_RE2 = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))GET\b/i;
var SHA_RE2 = /(?:\bsha=|--match-head-commit(?:\s+|=))["']?([0-9a-f]{40})\b/i;
var SEGMENT_RE2 = /[;&|\r\n]+/;
var lastArg2 = (args, re) => re.exec(args)?.[1] ?? null;
function quoteOpenAt2(text, pos, pwsh) {
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
function rawTail2(text) {
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
function pairedWords2(text, pwsh = false) {
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
var UNREAD_HEAD2 = { sha: null, shaBad: true };
var HEAD_UNREAD_WHY2 = (pr) => `the merge head cannot be read as gh reads it: two head values, a value that is not a literal 40-hex sha, a flag this gate does not know, an unpaired quote, or a character this gate cannot read the same way in bash and PowerShell. Name the head once: gh pr merge ${pr && /^\d+$/.test(pr) ? pr : "<n>"} --match-head-commit <sha>, or gh api .../merge -f sha=<sha>. ${PLAIN_WAY_OUT2}`;
var PLAIN_WAY_OUT2 = "For a redirect: run the call with no redirect. For a $ variable or $(...): put the value in the command as plain text or use a body file.";
var HEX402 = /^[0-9a-f]{40}$/i;
function oneHead2(values) {
  if (values.some((v) => !HEX402.test(v))) return { sha: null, shaBad: true };
  const set = new Set(values.map((v) => v.toLowerCase()));
  if (set.size > 1) return { sha: null, shaBad: true };
  return { sha: [...set][0] ?? null };
}
var MERGE_BOOL2 = /* @__PURE__ */ new Set(["--merge", "-m", "--squash", "-s", "--rebase", "-r", "--auto", "--disable-auto", "--admin", "--delete-branch", "-d"]);
var MERGE_VALUE2 = /* @__PURE__ */ new Set(["--body", "-b", "--body-file", "-F", "--subject", "-t", "--author-email", "-A", "--match-head-commit", "--repo", "-R"]);
var SHORT_BOOL2 = "msrd";
var SHORT_VALUE2 = "bFtAR";
function shortCluster2(w, next) {
  return clusterOf2(w, next, SHORT_BOOL2, SHORT_VALUE2)?.used ?? null;
}
function clusterOf2(w, next, bools, values) {
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
function cliHeadOfWords2(words) {
  const heads = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-") || w === "-") continue;
    if (/^-[A-Za-z]{2,}/.test(w)) {
      const used = shortCluster2(w, words[i + 1]);
      if (used === null) return UNREAD_HEAD2;
      i += used;
      continue;
    }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (MERGE_BOOL2.has(name) && eq < 0) continue;
    if (!MERGE_VALUE2.has(name)) return { sha: null, shaBad: true };
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === void 0) return { sha: null, shaBad: true };
    if (name === "--match-head-commit") heads.push(value);
  }
  return oneHead2(heads);
}
var API_FIELD2 = /^(?:-f|-F|--raw-field|--field)$/;
var API_FIELD_EQ2 = /^(?:--raw-field|--field)=(.*)$/s;
var API_VALUE2 = /* @__PURE__ */ new Set(["-X", "--method", "-H", "--header", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);
function apiWord2(w, next, endpointSeen) {
  if (w === "--input" || w.startsWith("--input=")) return { bad: "--input (the body comes from a file)" };
  if (API_FIELD2.test(w)) return next === void 0 ? { bad: "a field flag with no value" } : { field: next, used: 1 };
  if (API_FIELD_EQ2.test(w)) return { field: API_FIELD_EQ2.exec(w)[1], used: 0 };
  if (/^-[fF][^=]/.test(w)) return { field: w.slice(2), used: 0 };
  if (API_VALUE2.has(w)) return next === void 0 ? { bad: `${w} with no value` } : { field: null, used: 1 };
  if (/^--(?:method|hostname|header|jq|template|cache|preview)=/.test(w) || /^-X./.test(w) || API_BOOL2.has(w)) return { field: null, used: 0 };
  if (!w.startsWith("-") && !endpointSeen) return { field: null, used: -1 };
  return { bad: `a word this gate does not know on the api call (${w})` };
}
function apiHeadOfWords2(words) {
  const heads = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord2(words[i], words[i + 1], endpoint);
    if ("bad" in r) return UNREAD_HEAD2;
    if (r.used === -1) {
      endpoint = true;
      continue;
    }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf("=");
    if (eq > 0 && r.field.slice(0, eq) === "sha") heads.push(r.field.slice(eq + 1));
  }
  return oneHead2(heads);
}
var API_MERGE_PATH2 = /\/pulls\/(\d+)\/merge\b/i;
function mergeCallOf2(call) {
  const w = call.words;
  if (w.length < 3 || progName2(w[0].lit) !== "gh") return null;
  const sub = (i) => (w[i]?.lit ?? "").toLowerCase();
  const at3 = call.cwdBefore ?? [];
  const text = w.map((x) => x.raw).join(" ");
  if (sub(1) === "pr" && sub(2) === "merge") {
    const args = w.slice(3);
    if (args.some((a) => a.lit === null)) return { pr: prOfWords2(args), ...UNREAD_HEAD2, cwdBefore: at3, text };
    return { pr: prOfWords2(args), ...cliHeadOfWords2(args.map((a) => a.lit)), cwdBefore: at3, text };
  }
  if (sub(1) === "api") {
    const args = w.slice(2);
    const endpoint = args.find((a) => API_MERGE_PATH2.test(a.lit ?? a.raw));
    if (!endpoint) return null;
    const lits = args.map((a) => a.lit);
    if (lits.some((l, i) => (l === "-X" || l === "--method") && /^GET$/i.test(lits[i + 1] ?? "")) || lits.some((l) => /^(?:-XGET|--method=GET)$/i.test(l ?? ""))) return null;
    const pr = API_MERGE_PATH2.exec(endpoint.lit ?? endpoint.raw)[1];
    if (endpoint.lit === null || args.some((a) => a.lit === null && a !== endpoint)) return { pr, ...UNREAD_HEAD2, cwdBefore: at3, text };
    return { pr, ...apiHeadOfWords2(lits.map((l) => l)), cwdBefore: at3, text };
  }
  return null;
}
function prOfWords2(args) {
  for (let i = 0; i < args.length; i++) {
    const l = args[i].lit ?? "";
    if (/^\d+$/.test(l) && !MERGE_VALUE2.has(args[i - 1]?.lit ?? "")) return l;
  }
  for (const a of args) {
    const m = /\/pull\/(\d+)/.exec(a.lit ?? "");
    if (m) return m[1];
  }
  return null;
}
function astMerges2(parsed) {
  if (!parsed) return [];
  return Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : []).flatMap((c) => {
    const m = mergeCallOf2(c);
    return m ? [m] : [];
  });
}
function namesOtherRepo2(m, pwsh) {
  const r = commandRepo(m.text, maskQuoted2(m.text, pwsh ? "PowerShell" : "Bash"), {}, []);
  return r !== null && r !== CCV3_REPO;
}
function withAstMerges2(shapes, parsed, pwsh) {
  if (!parsed || Object.values(parsed.byDialect).some((r) => r === void 0 || r.errors.length > 0)) return shapes;
  const found = astMerges2(parsed);
  if (found.length === 0) return shapes;
  const heads = (pr) => {
    const hs = found.filter((m) => m.pr === pr);
    if (hs.length === 0) return null;
    const first = hs[0];
    return hs.every((m) => m.sha === first.sha && !m.shaBad === !first.shaBad) ? { sha: first.sha, ...first.shaBad ? { shaBad: true } : {} } : UNREAD_HEAD2;
  };
  const out4 = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (s) => {
    const id = `${s.kind}|${s.pr}|${s.sha}${s.shaBad ? "!" : ""}|${s.at ? whereId2(s.at) : ""}|${s.ftext ?? s.text ?? ""}${s.prior ? priorId2(s.prior) : ""}`;
    if (!seen.has(id)) {
      seen.add(id);
      out4.push(s);
    }
  };
  const own = (s) => {
    const cands = found.filter((m) => m.pr === s.pr && namesOtherRepo2(m, pwsh));
    const shapeText = squashed2(s.ftext ?? s.text ?? "");
    return cands.find((m) => shapeText.includes(squashed2(m.text))) ?? cands[0];
  };
  for (const s of shapes) {
    if (s.kind !== "merge") {
      out4.push(s);
      continue;
    }
    if (s.rawOnly) {
      push(s);
      continue;
    }
    const h = heads(s.pr);
    if (!h) {
      push(s);
      continue;
    }
    const { shaBad: _drop, ...rest } = s;
    const o = own(s);
    push({ ...rest, sha: h.sha, ...h.shaBad ? { shaBad: true } : {}, ...o ? { ftext: o.text, fmtext: maskQuoted2(o.text, pwsh ? "PowerShell" : "Bash") } : {} });
  }
  for (const m of found) {
    if (shapes.some((s) => s.kind === "merge" && s.pr === m.pr)) continue;
    const cds = m.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted2(m.text, pwsh ? "PowerShell" : "Bash");
    push({ kind: "merge", pr: m.pr, sha: m.sha, ...m.shaBad ? { shaBad: true } : {}, at: { cds, unknown: m.cwdBefore.includes(null), loose: cds.length > 0 || m.cwdBefore.includes(null) }, text: m.text, mtext: masked, ftext: m.text, fmtext: masked, prior: NO_PRIOR2, pwsh });
  }
  return out4;
}
var SAFE_CREATE_VALUE2 = /* @__PURE__ */ new Set(["--title", "-t", "--body", "-b", "--body-file", "-F", "--label", "-l", "--assignee", "-a", "--reviewer", "-r", "--milestone", "-m", "--project", "-p", "--template", "-T", "--recover"]);
var SAFE_API_KEY2 = /* @__PURE__ */ new Set(["title", "body", "draft", "maintainer_can_modify"]);
var API_PULLS_PATH2 = /\/pulls\/?(?:\?.*)?$/i;
var NOT_LITERAL_WORD2 = "a word that is not a literal (a variable or a substitution outside a title or body value)";
function callHoldsHeredoc(call, r) {
  if (!r) return false;
  const inCall = (at3) => at3 >= call.start && at3 <= call.end;
  return r.heredocs.some((h) => h.callStart === null || inCall(h.callStart)) || r.bodies.some(([from, to]) => from >= call.start && to <= call.end);
}
var API_PULLS_SEGMENT = /(?:^|[/\s=])pulls(?=$|[/?\s])/i;
var API_WRITE_FLAG = /(?:^|\s)["']?(?:-X|--method|-[fF]|--(?:field|raw-field|input))/;
var unreadWord = (x) => x.lit === null || !x.raw.startsWith("'") && /^["']?[@$]/.test(x.raw);
function apiUnreadHead(w) {
  const text = w.map((x) => x.raw).join(" ");
  if (!API_PULLS_SEGMENT.test(text.replace(/["']/g, " ")) || !w.some(unreadWord)) return false;
  if (API_WRITE_FLAG.test(text)) return true;
  const args = w.slice(2);
  const unread = args.filter(unreadWord);
  if (unread.length !== 1) return true;
  const word = unread[0];
  const prev = args[args.indexOf(word) - 1]?.lit;
  if (word.raw.startsWith("-") || prev != null && (API_FIELD2.test(prev) || API_VALUE2.has(prev))) return true;
  const literalPart = word.raw.replace(/["']/g, "").replace(/\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_]\w*/g, "");
  return !(literalPart.includes("/") && /[A-Za-z]/.test(literalPart));
}
function createCallOf2(call, r) {
  const w = call.words;
  if (w.length < 3 || progName2(w[0].lit) !== "gh") return null;
  const sub = (i) => (w[i]?.lit ?? "").toLowerCase();
  const cwdBefore = call.cwdBefore ?? [];
  const text = w.map((x) => x.raw).join(" ");
  if (sub(1) === "pr" && (sub(2) === "create" || sub(2) === "new")) {
    if (callHoldsHeredoc(call, r)) return { read: BAD2("a heredoc in a title or body makes the head and base unreadable"), cwdBefore, text };
    const lits2 = [];
    for (const a of w.slice(3)) {
      if (a.lit !== null) {
        lits2.push(a.lit);
        continue;
      }
      const eq = /^(--[a-z-]+)="/.exec(a.raw)?.[1];
      if (eq && SAFE_CREATE_VALUE2.has(eq)) {
        lits2.push(`${eq}=x`);
        continue;
      }
      if (a.raw.startsWith('"') && SAFE_CREATE_VALUE2.has(lits2[lits2.length - 1] ?? "")) {
        lits2.push("x");
        continue;
      }
      return { read: BAD2(NOT_LITERAL_WORD2), cwdBefore, text };
    }
    return { read: cliCreateOfWords2(lits2), cwdBefore, text };
  }
  if (sub(1) !== "api") return null;
  if (apiUnreadHead(w)) return { read: BAD2(NOT_LITERAL_WORD2), cwdBefore, text };
  const args = w.slice(2);
  const valueFlag = (l) => l != null && (API_FIELD2.test(l) || API_VALUE2.has(l));
  const endpoint = args.find((a, i) => a.lit !== null && !a.lit.startsWith("-") && !valueFlag(args[i - 1]?.lit));
  const flags = args.map((a) => a.lit ?? "");
  const post = flags.some((l, i) => /^(?:-X|--method)$/i.test(l) && /^POST$/i.test(flags[i + 1] ?? "") || /^(?:-XPOST|--method=POST)$/i.test(l));
  const anyMethod = flags.some((l) => /^(?:-X|--method)/i.test(l));
  const field = flags.some((l) => /^(?:-[fF]|--(?:raw-field|field|input))/.test(l));
  const writes = post || field && !anyMethod;
  if (!endpoint) {
    const tailOf = (raw) => raw.replace(/['"]/g, "").replace(/\?[\s\S]*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
    const mayCreate = (raw) => {
      const t = tailOf(raw);
      return !raw.includes("/") || /^pulls$/i.test(t) || /[$`(]/.test(t);
    };
    const unreadEndpoint = args.some((a, i) => a.lit === null && !a.raw.startsWith("-") && !valueFlag(args[i - 1]?.lit) && mayCreate(a.raw));
    return writes && unreadEndpoint ? { read: BAD2(NOT_LITERAL_WORD2), cwdBefore, text } : null;
  }
  if (!API_PULLS_PATH2.test(endpoint.lit)) return null;
  if (!writes) return null;
  const lits = [];
  for (const a of args) {
    if (a.lit !== null) {
      lits.push(a.lit);
      continue;
    }
    const key = /^((?:-[fF]|--(?:raw-field|field)=)?([A-Za-z_]+))="/.exec(a.raw);
    if (key && SAFE_API_KEY2.has(key[2])) {
      lits.push(`${key[1]}=x`);
      continue;
    }
    return { read: BAD2(NOT_LITERAL_WORD2), cwdBefore, text };
  }
  return { read: apiCreateOfWords2(lits), cwdBefore, text };
}
function astCreates2(parsed) {
  if (!parsed) return [];
  return Object.values(parsed.byDialect).flatMap((r) => r ? r.calls.map((c) => ({ c, r })) : []).flatMap(({ c, r }) => {
    const m = createCallOf2(c, r);
    return m ? [m] : [];
  });
}
var squashed2 = (t) => t.replace(/[\s"'\\`]/g, "");
function withAstCreates2(shapes, parsed, pwsh) {
  if (!parsed || Object.values(parsed.byDialect).some((r) => r === void 0 || r.errors.length > 0)) return shapes;
  const found = astCreates2(parsed);
  if (found.length === 0) return shapes;
  const tails = [...new Set(shapes.filter((s) => s.kind === "create").map((s) => squashed2(s.tail ?? s.text ?? "")))];
  const pairs = tails.map((t) => found.filter((f) => t.includes(squashed2(f.text))));
  const paired = tails.length === found.length && pairs.every((p) => p.length === 1) && new Set(pairs.map((p) => p[0])).size === found.length;
  if (paired) {
    const byTail = new Map(tails.map((t, i) => [t, pairs[i][0].read]));
    return shapes.map((s) => s.kind === "create" ? { ...s, read: byTail.get(squashed2(s.tail ?? s.text ?? "")) } : s);
  }
  const extra = found.map((f) => {
    const cds = f.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted2(f.text, pwsh ? "PowerShell" : "Bash");
    return { kind: "create", pr: null, at: { cds, unknown: f.cwdBefore.includes(null), loose: cds.length > 0 || f.cwdBefore.includes(null) }, text: f.text, mtext: masked, ftext: f.text, fmtext: masked, prior: NO_PRIOR2, tail: f.text, pwsh, read: f.read };
  });
  return [...shapes, ...extra];
}
var CLEANUP_WORD_RE = /^-CleanupOnly(?::["']?\$?true["']?)?$/i;
function callIsCleanup(c) {
  return c.words.some((w) => CLEANUP_WORD_RE.test(w.raw)) || (c.stdin?.lit ? CLEANUP_RE2.test(c.stdin.lit) : false);
}
function astLandCalls2(parsed, raw, exempt, gate) {
  const unq = (t) => t.replace(/['"`]/g, "");
  if (!parsed || exempt || !LAND_SCRIPT_RE2.test(unq(raw)) || !LAND_SCRIPT_RE2.test(unq(gate))) return [];
  const out4 = [];
  for (const c of Object.values(parsed.byDialect).flatMap((r) => r ? r.calls : [])) {
    const text0 = [...c.words.map((w) => w.raw), ...c.stdin?.lit ? [c.stdin.lit] : []].join(" ");
    const dtext = [...c.words.map((w) => w.lit ?? w.raw), ...c.stdin?.lit ? [c.stdin.lit] : []].join(" ");
    const text = LAND_SCRIPT_RE2.test(text0) ? text0 : dtext;
    if (!LAND_SCRIPT_RE2.test(text) || callIsCleanup(c)) continue;
    out4.push({ text, pr: lastArg2(text, LAND_PR_RE2), sha: SHA_RE2.exec(text)?.[1]?.toLowerCase() ?? null, cwdBefore: c.cwdBefore ?? [] });
  }
  if (out4.length === 0 && !CLEANUP_RE2.test(raw)) out4.push({ text: raw, pr: lastArg2(raw, LAND_PR_RE2), sha: SHA_RE2.exec(raw)?.[1]?.toLowerCase() ?? null, cwdBefore: [] });
  return out4;
}
function astLandShapes2(parsed, raw, exempt, gate, pwsh) {
  return astLandCalls2(parsed, raw, exempt, gate).map((l) => {
    const cds = l.cwdBefore.filter((c) => c !== null);
    const masked = maskQuoted2(l.text, pwsh ? "PowerShell" : "Bash");
    return { kind: "land", pr: l.pr, sha: l.sha, at: { cds, unknown: l.cwdBefore.includes(null), loose: cds.length > 0 || l.cwdBefore.includes(null) }, text: l.text, mtext: masked, ftext: l.text, fmtext: masked, prior: NO_PRIOR2, pwsh };
  });
}
var DATA_READERS2 = /* @__PURE__ */ new Set(["echo", "printf", "write-host", "write-output", "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "select-string", "sls", "get-content", "gc"]);
function onlyDataReaders2(parsed) {
  const rs = Object.values(parsed.byDialect).filter((r) => r !== void 0);
  return rs.length > 0 && rs.every((r) => r.ok && r.errors.length === 0 && r.calls.length > 0 && !hasBareRedirect2(parsed.text, r) && r.calls.every((c) => c.assigns.length === 0 && c.words[0]?.lit != null && c.words[0].lit === c.words[0].raw && DATA_READERS2.has(c.words[0].lit.toLowerCase())));
}
function astItemsOf2(parsed, raw, exempt, text) {
  if (!parsed) return [];
  const foundMerges = astMerges2(parsed);
  const foundCreates = astCreates2(parsed);
  const merges = foundMerges.map((m) => ({ sq: squashed2(m.text), shape: { kind: "merge", pr: m.pr, sha: m.sha, ...m.shaBad ? { shaBad: true } : {} } }));
  const creates = foundCreates.map((c) => ({ sq: squashed2(c.text), create: true, read: c.read }));
  const lands = astLandCalls2(parsed, raw, exempt, text).map((l) => ({ sq: squashed2(l.text), shape: { kind: "land", pr: l.pr, sha: l.sha } }));
  const extra = [];
  const mergeWords = [...text.matchAll(/\bgh\s+pr\s+merge\b[^|;&\n]*/gi)];
  if (mergeWords.length > foundMerges.length && !onlyDataReaders2(parsed)) {
    for (const m of mergeWords) extra.push({ sq: squashed2(m[0]), shape: { kind: "merge", pr: lastArg2(m[0], /(?:^|\s)["']?(\d+)(?=\s|["']|$)/), ...UNREAD_HEAD2, rawOnly: true } });
  }
  const api = MERGE_API_RE2.exec(text);
  if (api && !GET_RE2.test(api[0]) && !foundMerges.some((m) => m.pr === api[1])) extra.push({ sq: squashed2(api[0]), shape: { kind: "merge", pr: api[1], ...UNREAD_HEAD2 } });
  const createWords = [...text.matchAll(/\bgh\s+pr\s+(?:create|new)\b[^|;&\n]*/gi)];
  for (const c of createWords.slice(foundCreates.length)) extra.push({ sq: squashed2(c[0]), create: true, read: BAD2("a wrapper program, a split word or a payload runs gh, so its head and base cannot be read") });
  return [...merges, ...creates, ...lands, ...extra].filter((i) => i.sq !== "");
}
var DOC_APPEND_CMDS2 = /* @__PURE__ */ new Set(["add-content", "set-content", "ac", "sc"]);
var DOC_TARGET_EXT2 = /\.(?:md|txt|log)$/i;
var DOC_ODD_CHAR2 = /[\u2013-\u2015\u2018-\u201F\0\v\f\x85\u2028\u2029]/u;
function hasBareRedirect2(text, r) {
  const inside = (i) => [...r.quoted, ...r.bodies].some(([from, to]) => i >= from && i < to);
  for (let i = 0; i < text.length; i++) if ((text[i] === ">" || text[i] === "<") && !inside(i)) return true;
  return false;
}
function docTargetOk2(w) {
  const t = w?.lit;
  if (t == null || t !== t.trim() || !DOC_TARGET_EXT2.test(t) || /[*?[\],]/.test(t)) return false;
  if (t.replace(/^[A-Za-z]:(?=[\\/])/, "").includes(":")) return false;
  return !t.split(/[\\/]/).includes("..");
}
function docAppendCall2(c) {
  if (c.depth !== 0 || c.level !== 0 || c.nested || c.func || c.place.pipe || c.place.background) return false;
  if (!DOC_APPEND_CMDS2.has((c.words[0]?.lit ?? "").toLowerCase())) return false;
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
  return docTargetOk2(target) && value !== void 0 && value.lit !== null && value.viaVar === void 0;
}
function docAppendByAst2(parsed, tool, raw) {
  if (tool !== "PowerShell" || !parsed || DOC_ODD_CHAR2.test(raw)) return false;
  const dialects = Object.keys(parsed.byDialect);
  const r = parsed.byDialect.pwsh;
  if (dialects.length !== 1 || !r || r.errors.length > 0 || r.calls.length === 0) return false;
  return !hasBareRedirect2(parsed.text, r) && r.calls.every((c) => docAppendCall2(c) || docLeaderCall(c)) && r.calls.some(docAppendCall2);
}
var DOC_LEADERS = /* @__PURE__ */ new Set(["set-location", "sl", "cd", "get-date"]);
function docLeaderCall(c) {
  if (c.depth !== 0 || c.level !== 0 || c.nested || c.func || c.place.pipe || c.place.background) return false;
  return DOC_LEADERS.has((c.words[0]?.lit ?? "").toLowerCase()) && c.words.every((w) => w.lit !== null);
}
var SCRIPT_RUNNERS2 = /* @__PURE__ */ new Set(["node", "nodejs", "python", "python3", "py", "deno", "bun", "ruby", "perl", "tsx", "ts-node", "php"]);
var GUARDED_TEXT2 = /\bgit\s+(?:-\S+\s+\S+\s+)*push\b|\bgit\s+(?:[^;&|\n]*\s)?push\b|\bgit\b[^\n]*\bpush\b|\bgh(?:\.exe)?\s+pr\s+(?:create|new|merge)\b|\bgh(?:\.exe)?\s+api\b[^\n]*\/(?:pulls|merge)\b|\bland-pr\.ps1\b/i;
var SCRIPT_RUNNER_WHY2 = "this runs code inline (node -e, python -c or a heredoc) whose text names a guarded call (a push, a create or a merge). This gate does not read JavaScript or Python, so it cannot tell whether the code runs the call or only holds the text (Dave R1). Put the code in a script file and run the file (node scripts/<name>.mjs), or take the guarded text out of the code.";
var SCRIPT_RUNNER_WORD2 = new RegExp(`\\b(?:${[...SCRIPT_RUNNERS2].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
var blankQuotes2 = (t) => t.replace(/['"`,[\]()]/g, " ");
function scriptRunnerDenies2(parsed) {
  if (!parsed) return [];
  for (const r of Object.values(parsed.byDialect)) {
    if (r && (!r.ok || r.errors.length > 0)) {
      const t = blankQuotes2(parsed.text);
      if (SCRIPT_RUNNER_WORD2.test(t) && GUARDED_TEXT2.test(t)) return [deny2("script-runner", SCRIPT_RUNNER_WHY2)];
    }
    for (const c of r ? r.calls : []) {
      if (!SCRIPT_RUNNERS2.has(progName2(c.words[0]?.lit) ?? "")) continue;
      const code = blankQuotes2([...c.words.slice(1).map((a) => a.lit ?? a.raw), c.stdin?.lit ?? ""].join(" "));
      if (GUARDED_TEXT2.test(code)) return [deny2("script-runner", SCRIPT_RUNNER_WHY2)];
    }
  }
  return [];
}
function scriptRunnerLateDenies2(text) {
  if (text === void 0) return [];
  const t = blankQuotes2(text);
  return SCRIPT_RUNNER_WORD2.test(t) && GUARDED_TEXT2.test(t) ? [deny2("script-runner", SCRIPT_RUNNER_WHY2)] : [];
}
var PARSE_ERROR_WHY2 = "this text does not parse as shell (an unclosed quote, brace or parenthesis, or a stray ;; or &&), and it holds a guarded call (a push, a create or a merge), so this gate cannot tell which call runs or where. Fix the syntax and run it again.";
var SHELL_PROGRAMS2 = { bash: "bash", sh: "bash", dash: "bash", zsh: "bash", pwsh: "pwsh", powershell: "pwsh" };
function parseErrorDenies2(parsed) {
  if (!parsed) return [];
  const results = Object.values(parsed.byDialect).filter((r) => r !== void 0);
  if (results.length === 0) return [];
  const failed = results.every((r) => !r.ok || r.errors.length > 0);
  if (!failed && parsed.innerBad !== true) return [];
  return GUARDED_TEXT2.test(blankQuotes2(parsed.text)) ? [deny2("parse-error", PARSE_ERROR_WHY2)] : [];
}
var STANDALONE_CLEANUP = /^[ \t]*(?:&[ \t]*)?(?:(?:pwsh|powershell)(?:\.exe)?[ \t]+(?:-NoProfile[ \t]+)?(?:-File[ \t]+)?)?[^\s;&|<>$`'"()]*land-pr\.ps1(?:[ \t]+(?:-Pr[ \t]+\d+|-CleanupOnly))+[ \t]*$/i;
var PARSER_UNAVAILABLE_WHY = "the parser was late, run it again. The shell parser did not answer in time (or could not run), and this text names a guarded call (a push, a create, a merge or the land script), so this gate cannot read which call runs. Run the same call again, or run the push, create or merge as its own command.";
var isStandaloneCleanup = (text) => STANDALONE_CLEANUP.test(text) && /-Pr[ \t]+\d+/i.test(text) && CLEANUP_RE2.test(text);
function parserUnavailableDenies(parsed, text, covered = false) {
  if (parsed) return [];
  if (isStandaloneCleanup(text)) return [];
  const views = [blankQuotes2(text), text.replace(/['"`]/g, ""), text.replace(/['"`\\]/g, "")];
  if (!views.some((v) => GUARDED_TEXT2.test(v))) return [];
  const scope = views.some((v) => DENY_CLASS_TEXT.test(v)) ? "other" : "push";
  const d = deny2("parser-unavailable", PARSER_UNAVAILABLE_WHY, scope);
  return [covered ? { ...d, homeFlags: true } : d];
}
var DENY_CLASS_TEXT = /\bgh(?:\.exe)?\s+pr\s+(?:create|new|merge)\b|\bgh(?:\.exe)?\s+api\b[^\n]*\/(?:pulls|merge)\b|\bland-pr\.ps1\b/i;
var INERT_PROGRAMS = /* @__PURE__ */ new Set(["echo", "printf", "grep", "rg", "select-string", "set-content", "add-content", "out-file", "write-output", "write-host", "set-location", "get-date", "cat", "head", "tail", "ls", "get-content", "cd", "gc", "sc", "ac", "sls", "sl"]);
var litOf = (w) => w !== void 0 && w.lit !== null && w.viaVar === void 0 ? w.lit : null;
var bareProg = (c) => {
  const l = litOf(c.words[0]);
  return l === null || /[\\/]/.test(l) || /\.(?:ps1|sh|bash|cmd|bat|py|js|mjs|cjs)$/i.test(l) ? null : progName2(l);
};
function onDataList(c) {
  const p = bareProg(c);
  if (p === null) return false;
  if (INERT_PROGRAMS.has(p)) return true;
  const args = c.words.slice(1);
  if (p === "git") return args.some((a) => a.lit === "commit") && args.some((a) => a.lit !== null && (/^-[a-zA-Z]*[mF]$/.test(a.lit) || a.lit === "--message" || a.lit === "--file"));
  if (p === "node") return /(^|[\\/])lane\.mjs$/.test(litOf(args[0]) ?? "") && ["say", "note"].includes(litOf(args[1]) ?? "");
  return false;
}
var DATA_ARG_PROGRAMS = /* @__PURE__ */ new Set(["gh", "git", "claude", "curl", "ntn"]);
var READ_ONLY_PROGRAMS = /* @__PURE__ */ new Set(["grep", "rg", "select-string", "sls", "cat", "head", "tail", "ls", "get-content", "gc", "cd", "set-location", "sl", "get-date", "sort", "uniq", "wc", "cut", "tr", "jq", "select-object", "sort-object", "measure-object", "format-table", "out-string", "convertto-json", "convertfrom-json", "get-childitem", "gci", "dir", "test-path", "join-path", "split-path", "resolve-path", "get-item", "get-location", "pwd", "date", "basename", "dirname", "true", "false", "where-object", "get-ciminstance", "get-process", "foreach-object", "out-null", "start-sleep", "new-item", "copy-item", "get-random", "format-list", "select-xml", "get-service", "get-wmiobject", "chdir", "pushd", "popd", "push-location", "pop-location"]);
var GH_SUBS = /* @__PURE__ */ new Set(["pr", "api", "issue", "repo", "run", "workflow", "release", "search", "status", "auth", "label", "browse", "cache", "gist", "project", "ruleset", "variable", "secret", "org", "attestation", "ssh-key", "gpg-key", "agent-task"]);
var SAFE_ENV_NAMES = "GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GH_SPINNER_DISABLED|NO_COLOR|CLICOLOR|CI|TERM|LANG|LC_[A-Z_]+|TZ";
var SAFE_ENV_NAME = new RegExp(`^(?:${SAFE_ENV_NAMES})$`);
var SAFE_ENV_NAME_CI = new RegExp(SAFE_ENV_NAME.source, "i");
var ENV_NAME_UNSAFE = /^(?:GIT_|GH_|PATH$|PAGER$|EDITOR$|VISUAL$|BROWSER$|BASH_ENV$|ENV$|LD_|DYLD_|NODE_OPTIONS$|IFS$|PS4$|PROMPT_COMMAND$)/i;
var reg = (source, ...runs) => ({ runs, source });
var rows = (names, source) => names.map((n) => [n, reg(source)]);
var GNU_NONE = "GNU coreutils manual (gnu.org/software/coreutils): no option runs a program";
var PS_NONE = "Microsoft.PowerShell.Management and Utility module documentation (learn.microsoft.com): no parameter runs a program";
var PS_WRITE = "Set-Content, Add-Content, Out-File, New-Item, Copy-Item documentation (learn.microsoft.com): they write a file or an item of a provider";
var CARRIER_REGISTER = Object.fromEntries([
  ...rows(["echo", "printf", "cat", "head", "tail", "ls", "cut", "tr", "uniq", "wc", "basename", "dirname", "date", "pwd", "true", "false", "cd", "pushd", "popd", "chdir", "dir"], GNU_NONE),
  ...rows(["grep", "select-string", "sls"], "GNU grep manual and Select-String documentation: no option runs a program"),
  ...rows(["set-location", "sl", "push-location", "pop-location", "get-date", "write-output", "write-host", "get-content", "gc", "get-childitem", "gci", "test-path", "join-path", "split-path", "resolve-path", "get-item", "get-location", "select-object", "sort-object", "measure-object", "format-table", "format-list", "out-string", "out-null", "convertto-json", "convertfrom-json", "start-sleep", "get-random", "select-xml", "get-service", "get-process", "get-wmiobject", "get-ciminstance"], PS_NONE),
  ...["set-content", "sc", "add-content", "ac", "out-file", "new-item", "copy-item"].map((n) => [n, reg(PS_WRITE, "a target on the drive env:, function:, alias: or variable: changes what a later call runs", "a file written here is run by a LATER command (a named limit: the gate sees one command at a time)")]),
  ...["foreach-object", "where-object"].map((n) => [n, reg("ForEach-Object and Where-Object documentation (learn.microsoft.com)", "-Process, -Begin, -End and script block parameters: the commands inside are parsed as calls and judged one by one")]),
  ["rg", reg("ripgrep 14 user guide and rg --help (github.com/BurntSushi/ripgrep)", "--pre COMMAND", "--pre-glob", "--hostname-bin")],
  ["sort", reg("GNU coreutils sort manual (gnu.org/software/coreutils)", "--compress-program=PROG")],
  ["jq", reg("jq 1.7 manual (jqlang.github.io/jq/manual): no builtin runs a program")],
  ["node", reg("Node.js command line documentation (nodejs.org/api/cli.html)", "every script, -e, -p, -r and --import: only lane.mjs say or note is accepted (onDataList)")],
  ["curl", reg("curl manual (curl.se/docs/manpage.html): -K reads a config file, -o and --output write a file, no option runs a program")],
  ["gh", reg("GitHub CLI manual (cli.github.com/manual)", "alias set --shell", "extension exec", "codespace ssh and cp (run ssh with the text after --)", "pr checkout and repo clone (run git with the text after --)", "GH_PAGER, GH_EDITOR and BROWSER (an environment name outside the safe list)")],
  ["git", reg(
    "git(1), git-config(1), git-rebase(1), git-bisect(1), git-submodule(1), git-difftool(1) manual pages (git-scm.com/docs)",
    "-c key=value (alias.x=!cmd, core.pager, core.sshCommand, core.editor, core.fsmonitor, core.hooksPath, diff.external, credential.helper)",
    "--exec-path",
    "rebase -x and --exec",
    "bisect run",
    "submodule foreach",
    "difftool -x and --extcmd",
    "mergetool",
    "filter-branch --*-filter",
    "--upload-pack and --receive-pack",
    "config alias.* (stores a command)",
    "--ext-diff and --textconv",
    "a user-defined alias run as git <alias>",
    "GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EDITOR, GIT_PAGER, GIT_SEQUENCE_EDITOR, GIT_PROXY_COMMAND, GIT_CONFIG_PARAMETERS (an environment name outside the safe list)"
  )],
  ["claude", reg("Claude Code CLI reference (docs.claude.com/claude-code/cli-reference)", "-p starts a child session with tools", "--bare, --settings, --setting-sources, --dangerously-skip-permissions, --allow-dangerously-skip-permissions, --permission-mode, --mcp-config and --plugin-dir skip the user hooks or widen the tools")],
  ["ntn", reg("ntn --help and the help of each subcommand (Notion CLI, beta, read 2026-11-26)", "notion-as-code apply runs the project npm build", "workers deploy, exec and new run or ship project code", "pages create and pages edit with no --content and no redirect open $EDITOR", "update runs an installer")]
]);
var LISTED_PROGRAMS = /* @__PURE__ */ new Set([...INERT_PROGRAMS, ...READ_ONLY_PROGRAMS, ...DATA_ARG_PROGRAMS, "node"]);
var GIT_SUBS_OK = /* @__PURE__ */ new Set(["status", "log", "diff", "show", "branch", "rev-parse", "rev-list", "fetch", "add", "commit", "remote", "ls-files", "ls-remote", "worktree", "merge-base", "cat-file", "describe", "shortlog", "blame", "tag", "show-ref", "for-each-ref", "name-rev", "diff-tree", "checkout", "switch", "restore", "stash", "reset", "clean", "mv", "rm", "init", "clone", "pull", "push", "merge", "cherry-pick", "config"]);
var GIT_EXEC_ARG = /^(?:--exec(?:=|$)|-x$|--extcmd|--ext-diff|--textconv|--upload-pack|--receive-pack|--exec-path|--editor|--template|--run|-c$|--config)/;
var GIT_CONFIG_KEY = /^(?:alias\.|core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass))/i;
var NTN_SUBS_OK = /* @__PURE__ */ new Set(["api", "datasources", "whoami", "doctor", "auth", "help", "--help", "-h", "--version", "-V"]);
var PS_WRITERS = /* @__PURE__ */ new Set(["set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni", "copy-item", "cpi"]);
function carrierFree(c) {
  for (const a of c.assigns ?? []) if (!SAFE_ENV_NAME.test(a.name)) return false;
  const p = bareProg(c);
  if (p === null) return true;
  const lits = c.words.slice(1).map((w) => w.lit);
  const any = (re) => lits.some((l) => l !== null && re.test(l));
  if (p === "git") {
    let i = 0;
    while (i < lits.length && (lits[i] ?? "").startsWith("-")) {
      const o = lits[i];
      if (o === "-C") {
        i += 2;
        continue;
      }
      if (o === "--no-pager" || o === "--paginate" || o === "--no-optional-locks") {
        i++;
        continue;
      }
      return false;
    }
    const sub = lits[i];
    if (sub === void 0 || sub === null || !GIT_SUBS_OK.has(sub)) return false;
    return !lits.slice(i + 1).some((l) => l !== null && (GIT_EXEC_ARG.test(l) || GIT_CONFIG_KEY.test(l)));
  }
  if (p === "gh") return !lits.includes("--");
  if (p === "claude") return !any(/^--(?:bare|settings|setting-sources|dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode|mcp-config|plugin-dir)(?:=|$)/);
  if (p === "rg") return !any(/^--(?:pre|pre-glob|hostname-bin)(?:=|$)/);
  if (p === "sort") return !any(/^--compress-program(?:=|$)/);
  if (p === "ntn") {
    const sub = lits[0];
    if (sub === void 0 || sub === null) return false;
    if (NTN_SUBS_OK.has(sub)) return true;
    const verb = lits[1] ?? null;
    if (sub === "files") return verb === "list" || verb === "ls" || verb === "get";
    if (sub === "pages") return verb === "get" || (verb === "create" || verb === "edit") && (any(/^--content(?:=|$)/) || c.stdin !== null);
    return false;
  }
  if (PS_WRITERS.has(p)) return !any(/(?:^|:)(?:env|function|alias|variable):/i);
  return true;
}
var listOf = (set) => [...set].join(", ");
var notInertWhy = () => "this text names a guarded call (a push, a create, a merge or the land script) and also runs a program that is not on the lists of this gate. Fix: run the guarded call as its own command. Allowed beside a guarded word: data programs (" + listOf(INERT_PROGRAMS) + "; git commit with -m or -F; node lane.mjs say or note), read-only programs (" + listOf(READ_ONLY_PROGRAMS) + "), gh with a subcommand of (" + listOf(GH_SUBS) + "), and " + listOf(DATA_ARG_PROGRAMS) + ". A wrapper (" + Object.keys(WRAPPER_ARITY).join(", ") + ") is read through: the program it runs must be on the lists. A shell, a script file, a path, a script runner such as node, and a program word that is not a plain name are not allowed.";
var LAND_SCRIPT_WORD = /(^|[\\/])land-pr\.ps1$/i;
function runsLandScript(c) {
  const w0 = litOf(c.words[0]);
  if (w0 !== null && LAND_SCRIPT_WORD.test(w0)) return true;
  const p = bareProg(c);
  if (p !== "pwsh" && p !== "powershell") return false;
  const i = c.words.findIndex((w, k) => k > 0 && /^-f(?:i(?:l(?:e)?)?)?$/i.test(litOf(w) ?? ""));
  return i > 0 && LAND_SCRIPT_WORD.test(litOf(c.words[i + 1]) ?? "");
}
function readsNamedCall(c) {
  if (c.nested?.status === "parsed") return true;
  if (runsLandScript(c)) return true;
  const p = bareProg(c);
  if (p === "gh") {
    const sub = (litOf(c.words[1]) ?? "").toLowerCase();
    return GH_SUBS.has(sub) && !(sub === "pr" && c.words.length > 2 && litOf(c.words[2]) === null);
  }
  return p !== null && (DATA_ARG_PROGRAMS.has(p) || READ_ONLY_PROGRAMS.has(p));
}
function isInert(parsed) {
  if (!parsed || parsed.innerBad === true) return false;
  const all = [];
  for (const r of Object.values(parsed.byDialect)) {
    if (!r) continue;
    if (!r.ok || r.errors.length > 0) return false;
    all.push(...r.calls);
  }
  for (const r of Object.values(parsed.byDialect)) {
    for (const a of r ? r.assigns : []) {
      const env = /^env:/i.test(a.name);
      const n = a.name.replace(/^env:/i, "");
      if (/^gh_repo$/i.test(n)) continue;
      if (env ? !SAFE_ENV_NAME_CI.test(n) : !SAFE_ENV_NAME.test(n) && ENV_NAME_UNSAFE.test(n)) return false;
    }
  }
  if (hasMemberCall(parsed)) return false;
  return all.every((c) => carrierFree(c) && (onDataList(c) || readsNamedCall(c)));
}
var MEMBER_CALL_KIND = "InvokeMemberExpressionAst";
function hasMemberCall(parsed) {
  return Object.values(parsed.byDialect).some((r) => r !== void 0 && r !== null && r.kinds.includes(MEMBER_CALL_KIND));
}
var LAND_NAME_WORD = /^[^\s'"`]*land-?pr/i;
function hasUnreadHead(parsed) {
  for (const r of Object.values(parsed.byDialect)) {
    for (const c of r ? r.calls : []) {
      const w = c.words;
      if (progName2(w[0]?.lit) === "gh") {
        if (w[1] !== void 0 && w[1].lit === null) return true;
        if (w[1]?.lit?.toLowerCase() === "pr" && w[2] !== void 0 && w[2].lit === null) return true;
      }
      if (w.some((x) => x.lit === null && LAND_NAME_WORD.test(x.raw))) return true;
    }
  }
  return false;
}
var UNREAD_HEAD_WHY = "a gh call or the land script has a word that no literal gives (a brace, a parameter expansion or a substitution builds the verb, the endpoint or the script path), so this gate cannot read which create, land or merge runs. Fix: write the subcommand, the verb and the script path as plain words.";
function notInertDenies(parsed, resolved) {
  if (!parsed || isStandaloneCleanup(parsed.text)) return [];
  if (hasUnreadHead(parsed)) return [deny2("not-inert", UNREAD_HEAD_WHY, "other")];
  const views = [parsed.text, blankQuotes2(parsed.text), parsed.text.replace(/['"`]/g, ""), parsed.text.replace(/['"`\\]/g, ""), parsed.text.replace(/['"`\\{},]/g, " ")];
  if (!views.some((v) => GUARDED_TEXT2.test(v))) return [];
  const denyClass = views.some((v) => DENY_CLASS_TEXT.test(v));
  if ((denyClass || !resolved) && !GUARDED_TEXT2.test(parsed.text) && !GUARDED_TEXT2.test(views[1]) && !splicedOk(parsed)) return [deny2("not-inert", notInertWhy(), denyClass ? "other" : "push")];
  if (!denyClass && resolved || isInert(parsed)) return [];
  return [deny2("not-inert", notInertWhy(), denyClass || skippedFileHoldsGuarded(parsed) ? "other" : "push")];
}
function splicedOk(parsed) {
  if (hasMemberCall(parsed)) return false;
  for (const r of Object.values(parsed.byDialect)) for (const c of r ? r.calls : []) {
    const p = bareProg(c);
    if (p === null || !(INERT_PROGRAMS.has(p) || p === "gh")) return false;
  }
  return true;
}
function skippedFileHoldsGuarded(parsed) {
  for (const r of Object.values(parsed.byDialect)) {
    for (const c of r ? r.calls : []) {
      if (SHELL_PROGRAMS2[progName2(c.words[0]?.lit) ?? ""] !== "pwsh") continue;
      for (let i = 1; i < c.words.length; i++) {
        const a = c.words[i];
        if (a.lit && /^-f(?:i(?:l(?:e)?)?)?$/i.test(c.words[i - 1]?.lit ?? "") && GUARDED_TEXT2.test(blankQuotes2(a.lit))) return true;
      }
    }
  }
  return false;
}
async function innerTextBad2(byDialect, opts) {
  for (const r of Object.values(byDialect)) {
    for (const c of r ? r.calls : []) {
      const dialect = SHELL_PROGRAMS2[progName2(c.words[0]?.lit) ?? ""];
      if (!dialect) continue;
      const ws = c.words;
      for (let i = 1; i < ws.length; i++) {
        const a = ws[i];
        if (!a.lit || !GUARDED_TEXT2.test(blankQuotes2(a.lit))) continue;
        if (dialect === "pwsh" && /^-f(?:i(?:l(?:e)?)?)?$/i.test(ws[i - 1]?.lit ?? "")) continue;
        const inner = await parseCalls2(a.lit, dialect, opts);
        if (!inner.ok || inner.errors.length > 0) return true;
      }
    }
  }
  return false;
}
var WRAPPERS2 = String.raw`(?:env(?:\s+(?:-[uCS]\s+\S+|-\S+|\w+=\S*))*|nice(?:\s+-\S+(?:\s+\d+)?)*|timeout(?:\s+-\S+(?:\s+[A-Z0-9]+)?)*\s+[\d.]+[smhd]?|xargs(?:\s+-\S+(?:\s+(?:\d+|\{\}))?)*|setsid(?:\s+-\S+)*|sudo(?:\s+-\S+(?:\s+\w+)?)*)\s+`;
var PUSH_GIT2 = new RegExp(String.raw`(${CALL_START}(?:${WRAPPERS2})*)(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+push)(?=\s|$)`, "g");
var PUSH_WRAPPERS2 = "git-(?:safe|for)";
var abbr2 = (name, min) => name.slice(0, min) + [...name.slice(min)].reduceRight((acc, ch) => `(?:${ch}${acc})?`, "");
var GIT_FOR_OPTS2 = String.raw`-(?:${abbr2("Path", 2)}|${abbr2("Remote", 1)})(?::|\s+)${VAL}|-(?:${abbr2("WhichAccount", 2)}|${abbr2("UseGitSafe", 1)})(?=\s)|`;
var PUSH_SAFE2 = safeCallRe("push", PUSH_WRAPPERS2, GIT_FOR_OPTS2, "gi");
var ARGS_END_RE2 = /[;&|\r\n)}]/;
var DIR_OPT_RE2 = new RegExp(String.raw`(?:^|\s)-C\s+(${VAL})`, "g");
var PATH_OPT_RE2 = new RegExp(String.raw`(?:^|\s)-${abbr2("Path", 2)}(?::|\s+)(${VAL})`, "gi");
var MOVE_OPT_RE2 = /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/;
var REDIRECT_RE2 = /(?:^|\s)\d*[<>]+\S*/g;
var VALUE_OPTS2 = /* @__PURE__ */ new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
var FORCE_LONG2 = /^--(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|tags|delete|prune)(?:=.*)?$/;
var PUSH_KINDS2 = [[PUSH_GIT2, isGitToken], [PUSH_SAFE2, (t) => isSafeToken(t, PUSH_WRAPPERS2)]];
function pushCallsOf2(masked, raw, atStart, before = { cds: [], unknown: false, loose: false }, cutView = masked, kinds = PUSH_KINDS2) {
  const calls = [];
  for (const [re, valid] of kinds) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index + m[1].length;
      if (!valid(raw.slice(tokenStart, tokenStart + m[2].length))) continue;
      if (atStart && masked.slice(0, m.index).trim() !== "") continue;
      const optsStart = tokenStart + m[2].length;
      const end = m.index + m[0].length;
      const cut = cutView.slice(end).search(ARGS_END_RE2);
      const own = cdsBefore2(masked.slice(0, tokenStart), raw.slice(0, tokenStart));
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
var HEREDOC_OPEN2 = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/g;
var HERESTRING_OPEN2 = /@(['"])[ \t]*\r?\n/g;
var DATA_CMD2 = /^(?:[^\s;&|()`'"]*[\\/])?(?:git|gh)(?:\.exe)?$/i;
var INNER_CAT2 = /^cat$/;
var RUNS_IN_BODY2 = /\$\(|`/;
var blankChars2 = (s) => s.replace(/[^\r\n]/g, " ");
var firstWord2 = (t) => t.trim().split(/\s+/)[0] ?? "";
function outsideQuotes2(t, tool) {
  let rest = t;
  for (const [s, e] of quotedSpans2(t, tool)) rest = rest.slice(0, s) + " ".repeat(e - s) + rest.slice(e);
  return rest.replace(tool === "PowerShell" ? /`[\s\S]/g : /\\[\s\S]/g, "  ");
}
var quoteLeft2 = (t, tool) => /["']/.test(outsideQuotes2(t, tool));
function opensData2(text, at3, tool) {
  const lead = text.slice(0, at3);
  const bare = outsideQuotes2(lead, tool);
  const segStart = Math.max(...["\n", ";", "&", "|"].map((c) => bare.lastIndexOf(c))) + 1;
  const seg = bare.slice(segStart);
  if (!DATA_CMD2.test(firstWord2(seg))) return false;
  const sub = seg.lastIndexOf("$(");
  if (sub < 0 || seg.includes(")", sub)) return !quoteLeft2(lead, tool);
  const inner = seg.slice(sub + 2);
  return INNER_CAT2.test(firstWord2(inner)) && !quoteLeft2(lead.slice(0, segStart + sub).replace(/"$/, ""), tool) && !quoteLeft2(inner, tool);
}
function closingLine2(text, from, ends) {
  for (let pos = from; pos <= text.length; ) {
    const eol = text.indexOf("\n", pos);
    if (ends(text.slice(pos, eol < 0 ? text.length : eol).replace(/\r$/, ""))) return pos;
    if (eol < 0) return -1;
    pos = eol + 1;
  }
  return -1;
}
function blankHeredocs2(text) {
  let out4 = text;
  let next = 0;
  for (const m of text.matchAll(HEREDOC_OPEN2)) {
    if (m.index < next) continue;
    const nl = text.indexOf("\n", m.index + m[0].length);
    if (nl < 0) break;
    const start = Math.max(nl + 1, next);
    const delim = m[2] ?? m[3] ?? m[5];
    const end = closingLine2(text, start, (line) => (m[1] === "-" ? line.replace(/^\t+/, "") : line) === delim);
    if (end < 0) break;
    const quoted = m[5] === void 0 || m[4] === "\\";
    const rest = text.slice(m.index + m[0].length, nl).replace(/\r$/, "");
    const plainLine = !rest.includes("|") && !rest.endsWith("\\") && !quoteLeft2(rest, "Bash");
    if (plainLine && opensData2(out4, m.index, "Bash") && (quoted || !RUNS_IN_BODY2.test(text.slice(start, end)))) out4 = out4.slice(0, start) + blankChars2(text.slice(start, end)) + out4.slice(end);
    const eol = text.indexOf("\n", end);
    next = eol < 0 ? text.length : eol + 1;
  }
  return out4;
}
function blankHereStrings2(text) {
  let out4 = text;
  let next = 0;
  for (const m of text.matchAll(HERESTRING_OPEN2)) {
    if (m.index < next) continue;
    const start = m.index + m[0].length;
    const end = closingLine2(text, start, (line) => line.trimStart().startsWith(`${m[1]}@`));
    if (end < 0) break;
    const closedAtStart = text.startsWith(`${m[1]}@`, end);
    const body = text.slice(start, end);
    if (closedAtStart && opensData2(out4, m.index, "PowerShell") && (m[1] === "'" || !RUNS_IN_BODY2.test(body))) out4 = out4.slice(0, start) + blankChars2(body) + out4.slice(end);
    next = end + 2;
  }
  return out4;
}
function blankBodies2(text, tool) {
  if (tool === "Bash") return text.includes("<<") ? blankHeredocs2(text) : text;
  if (tool === "PowerShell") return text.includes("@") ? blankHereStrings2(text) : text;
  return text;
}
function readCommand2(input) {
  const cmd = readShellCommand2(input);
  return cmd.kind === "command" ? { ...cmd, text: blankBodies2(cmd.text, cmd.tool) } : cmd;
}
function dropComments2(view, tool) {
  let out4 = view;
  for (let from = 0; ; ) {
    const spans = quotedSpans2(out4, tool);
    const re = /(^|[\s;&|(])#[^\n]*/g;
    re.lastIndex = from;
    let hit = null;
    for (let m = re.exec(out4); m !== null && hit === null; m = re.exec(out4)) {
      const at3 = m.index + m[1].length;
      const end = m.index + m[0].length;
      if (!spans.some(([s, e]) => at3 > s && at3 < e) && !/["']/.test(out4.slice(end))) hit = { at: at3, end };
    }
    if (hit === null) return out4;
    out4 = out4.slice(0, hit.at) + " ".repeat(hit.end - hit.at) + out4.slice(hit.end);
    from = hit.end;
  }
}
function hiddenPieces2(raw, tool) {
  const tools = tool === "Bash" || tool === "PowerShell" ? [tool] : ["Bash", "PowerShell"];
  return tools.flatMap((t) => {
    const view = dropComments2(joinContinuations(raw, t === "PowerShell" ? "pwsh" : "bash"), t);
    if (!quoteLeft2(view, t)) return [];
    return quotedSpans2(view, t).flatMap(([s, e]) => view.slice(s + 1, e - 1).split(/[;&|\r\n(]+/).slice(1));
  });
}
var RUNNER_WORD2 = /^(?:[^\s'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1)$/i;
var LEAD_WORD2 = /^(?:then|do|else|\{|!|sudo|env|nice|nohup|time|timeout|xargs|setsid|-\S*|\d+[smhd]?|[A-Za-z_]\w*=\S*)$/;
var programOf2 = (p) => p.trim().split(/\s+/).find((w) => !LEAD_WORD2.test(w)) ?? "";
var hiddenPush2 = (p) => RUNNER_WORD2.test(programOf2(p)) && holdsGitPush2(p);
var hiddenGh2 = (p) => {
  const t = squashMarks2(p);
  return /^(?:[^\s]*[\\/])?gh(?:\.exe)?$/i.test(programOf2(t)) && (/\bpr\s+(?:create|new|merge)\b/i.test(t) || /\bapi\b[\s\S]*\b(?:pulls|merge)\b/i.test(t));
};
var wideSpelled2 = (s) => squashMarks2(s).split(/[\s;&|(){}<>]+/).some((w) => /^--(?:all|tags|prune|branches)$/i.test(w) || /^:[^:\s]/.test(w));
var hardSpelled2 = (s) => forceSpelled2(s) || wideSpelled2(s);
var quotesToBreaks2 = (view) => view.replace(/["']/g, ";");
var quotesToSpaces2 = (view) => view.replace(/["']/g, " ");
var PLAIN_QUOTED_CD2 = /(^|[;&|\r\n(]\s*)((?:cd|chdir)\s+)"(?![A-Za-z]:)([^\s"'%$`^()&|;<>\r\n]+)"(?=\s*(?:$|[;&|\r\n)]))/gi;
var plainCdUnquoted2 = (view) => {
  if (view.includes("^")) return view;
  return view.replace(PLAIN_QUOTED_CD2, (match, lead, cd, path6, offset) => {
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path6} ` : match;
  });
};
function pushCallsIn2(raw, cmdExe = false, kinds = PUSH_KINDS2) {
  const bash = joinContinuations(raw, "bash");
  const pwsh = joinContinuations(raw, "pwsh");
  const maskedBash = maskQuoted2(bash, "Bash");
  const maskedPwshOnBash = maskQuoted2(bash, "PowerShell");
  const maskedPwsh = maskQuoted2(pwsh, "PowerShell");
  const calls = [...pushCallsOf2(maskedBash, bash, false, void 0, maskedBash, kinds), ...pushCallsOf2(maskedPwsh, pwsh, false, void 0, maskedPwsh, kinds)];
  if (cmdExe) {
    const cmdBash = plainCdUnquoted2(bash);
    const cmdPwsh = plainCdUnquoted2(pwsh);
    for (const view of [quotesToBreaks2, quotesToSpaces2]) {
      if (maskedBash !== bash) calls.push(...pushCallsOf2(view(cmdBash), cmdBash, false, void 0, cmdBash, kinds));
      if (maskedPwsh !== pwsh) calls.push(...pushCallsOf2(view(cmdPwsh), cmdPwsh, false, void 0, cmdPwsh, kinds));
    }
  }
  let from = 0;
  const breaks = [...maskedBash.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const [start, next] of [...breaks, [bash.length, bash.length]]) {
    const seg = bash.slice(from, start);
    const lists = [cdsBefore2(maskedBash.slice(0, from), bash.slice(0, from)), cdsBefore2(maskedPwshOnBash.slice(0, from), bash.slice(0, from))];
    from = next;
    const squashed3 = squashQuotes(seg);
    if (squashed3 === seg) continue;
    for (const before of distinctWheres2(lists)) calls.push(...pushCallsOf2(squashed3, squashed3, true, before, squashed3, kinds));
  }
  return calls;
}
var REF_HEADS2 = /^refs\/heads\//;
var REPO_OPT2 = /^--repo?(?:=|$)/;
var STRICT_OPTS2 = /* @__PURE__ */ new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--porcelain", "--progress", "--no-progress"]);
var STRICT_REMOTE2 = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var STRICT_BRANCH2 = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
var NOT_A_BRANCH2 = /\.\.|\/\/|\/$|\.lock$|^(?:refs|heads|tags|remotes)\/|^HEAD$/;
var strictBranch2 = (b) => STRICT_BRANCH2.test(b) && !NOT_A_BRANCH2.test(b);
var STRICT_TOKEN2 = /^(?:(?:[A-Za-z0-9._:/\\-]*[\\/])?git(?:\.exe)?|(?:(?:pwsh|powershell)(?:\.exe)?\s+(?:-NoProfile\s+)?-File\s+)?(?:[A-Za-z0-9._:/\\-]*[\\/])?git-safe\.ps1)$/i;
function strictCall2(call) {
  const lead = call.lead.replace(/\b(?:then|do|else)\b/g, "").replace(/[\s;&|(){}]/g, "");
  const opts = call.opts.replace(DIR_OPT_RE2, " ").trim();
  return !call.squashed && lead === "" && opts === "" && [...call.opts.matchAll(DIR_OPT_RE2)].length <= 1 && STRICT_TOKEN2.test(call.token);
}
var strictPositionals2 = (raw) => raw.length === 0 || raw.length === 2 && STRICT_REMOTE2.test(raw[0]) && strictBranch2(raw[1]);
function argWordsOf2(call) {
  const raws = call.args.replace(REDIRECT_RE2, " ").split(/\s+/).filter((r) => squashQuotes(r) !== "");
  return { raws, tokens: raws.map(squashQuotes) };
}
function callDirsOf2(call) {
  const dirs = [...call.opts.matchAll(DIR_OPT_RE2), ...call.opts.matchAll(PATH_OPT_RE2)].sort((a, b) => a.index - b.index);
  return dirs.map((m) => m[1].includes("\\") ? m[1] : squashQuotes(m[1]));
}
var WIDE_LONG2 = ["mirror", "all"];
var UNSAFE_LONG2 = ["mirror", "all", "branches", "tags", "delete", "prune", "force", "force-with-lease", "force-if-includes"];
var PUSH_KEY_RE2 = /^(?:push|remote|submodule)\./;
var C_OPT_RE2 = /(?:^|\s)-c\s+((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
function readLongFlag2(f, t) {
  const eq = t.indexOf("=");
  const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
  const value = eq < 0 ? null : t.slice(eq + 1).toLowerCase();
  if (UNSAFE_LONG2.some((n) => n.startsWith(name))) f.unsafeOpt = true;
  if (name.length >= 2 && WIDE_LONG2.some((n) => n.startsWith(name))) f.wideOpt = true;
  if (name === "no-recurse-submodules") f.noRecurse = true;
  else if (name.length >= 4 && "recurse-submodules".startsWith(name)) {
    if (value === "no" || value === "check") f.noRecurse = true;
    else f.widerOpt ??= t;
  }
  if (name === "no-follow-tags") f.noFollowTags = true;
  else if (name.length >= 3 && "follow-tags".startsWith(name)) f.widerOpt ??= t;
}
function appFlagsOf2(tokens, opts) {
  const f = { unsafeOpt: false, wideOpt: false, oBundle: false, widerOpt: null, noRecurse: false, noFollowTags: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") break;
    if (!t.startsWith("-") || t === "-") continue;
    if (VALUE_OPTS2.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("--")) readLongFlag2(f, t);
    else if (/^-[A-Za-z0-9]+$/.test(t)) {
      const body = t.slice(1);
      const o = body.indexOf("o");
      if (o >= 0) f.oBundle = true;
      if (/[fd]/.test(o < 0 ? body : body.slice(0, o))) f.unsafeOpt = true;
    }
  }
  for (const m of opts.matchAll(C_OPT_RE2)) {
    const key = squashQuotes(m[1]).split("=")[0].toLowerCase();
    if (PUSH_KEY_RE2.test(key)) {
      f.widerOpt ??= `-c ${key}`;
      break;
    }
  }
  return f;
}
function pushShapesFrom2(call) {
  const { raws, tokens } = argWordsOf2(call);
  const cdirs = callDirsOf2(call);
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
    if (!STRICT_OPTS2.has(raws[i])) plainOpts = false;
    if (t === "--") {
      literal = true;
      continue;
    }
    if (REPO_OPT2.test(t)) repoOpt = true;
    if (VALUE_OPTS2.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("--")) {
      if (FORCE_LONG2.test(t)) force = true;
      if (t === "--dry-run" || t === "--help") quiet = true;
    } else if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (/[fd]/.test(t)) force = true;
      if (/[nh]/.test(t)) quiet = true;
    }
  }
  if (quiet) return [];
  const [remote = null, ...specs] = positional;
  const plain = plainOpts && strictCall2(call) && strictPositionals2(rawPositional);
  const base = { remote, dir, cdirs, cds: call.cds, loose: call.loose, unknown: call.unknown, moved: MOVE_OPT_RE2.test(` ${call.opts}`), plain, repoOpt, ...appFlagsOf2(tokens, call.opts) };
  if (specs.length === 0) return [{ kind: "push", pr: null, push: { ...base, branch: null, src: null, force, bare: true, oneSide: true } }];
  const out4 = [];
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
    const src = rawSrc.replace(REF_HEADS2, "");
    const name = (rawDst || rawSrc).replace(REF_HEADS2, "");
    const oneSide = colon < 0 || rawSrc === "" || rawDst === "";
    out4.push({ kind: "push", pr: null, push: { ...base, branch: name === "" || name === "HEAD" ? null : name, src: src === "" || src === "HEAD" ? null : src, force: rewrite, bare: false, oneSide } });
  }
  return out4;
}
function pushShapesOf2(raw, tool) {
  const out4 = [];
  const seen = /* @__PURE__ */ new Map();
  const verdict = rawVerdict2(raw, tool);
  const offList = verdict === null ? !steadyCommand2(raw, tool === "PowerShell" ? "pwsh" : "bash") : verdict.kind !== "ok";
  for (const call of pushCallsIn2(raw, mayRunUnderCmd2(tool))) {
    for (const shape of pushShapesFrom2(call)) {
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
        out4.push(shape);
      }
    }
  }
  return out4;
}
var squashMarks2 = (t) => t.replace(/["'\\^`]/g, "");
var WORD_SPLIT2 = /[\s;&|(){}<>=,]+/;
var isPushWord2 = (w) => /^push$/i.test(w) || /(?:^|[\\/])git-push(?:\.exe)?$/i.test(w);
var GIT_WORD2 = /(?<![^\s;&|(){}`!])(?:(?:[^\s;&|(){}`'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1|(git-push(?:\.exe)?))|"[^"]*"|'[^']*')(?=\s|$)/gi;
var isRunner2 = (rs, g) => {
  const raw = rs.slice(g.index, g.index + g[0].length);
  return !/^["']/.test(g[0]) || isGitToken(raw) || isSafeToken(raw, PUSH_WRAPPERS2);
};
var VALUE_GLOBAL2 = /^(?:-C|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|-Pa(?:th?)?|-R(?:e(?:m(?:o(?:te?)?)?)?)?)$/i;
var ODD_VERB2 = /[$`{}()%"'\\*?[\]]/;
var WORDS2 = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;
var PAYLOAD2 = /\b(?:(?:ba|z|da|k)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c\b|eval\b|cmd(?:\.exe)?\s+(?:\/\w+\s+)*\/[ck]\b|(?:pwsh|powershell)(?:\.exe)?\s.*?-c(?:ommand)?\b|Invoke-Expression\b|iex\b)|(?:\$\(|`)\s*(?:[^\s;&|()`'"]*[\\/])?git(?:\.exe)?\s/i;
var holdsGitPush2 = (s) => {
  const w = squashMarks2(s).split(WORD_SPLIT2);
  return w.some((x) => /(?:^|[\\/])git(?:\.exe)?$/i.test(x)) && w.some(isPushWord2);
};
var aliasPushes2 = (w) => {
  const t = squashMarks2(w);
  return t.slice(t.indexOf("=") + 1).split(WORD_SPLIT2).some(isPushWord2);
};
function verbAt2(ms, rs, g) {
  if (g[1]) return "push";
  const from = g.index + g[0].length;
  const cut = ms.slice(from).search(ARGS_END_RE2);
  const words = [...ms.slice(from, cut < 0 ? ms.length : from + cut).matchAll(WORDS2)].map((w) => rs.slice(from + w.index, from + w.index + w[0].length));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) return ODD_VERB2.test(w) ? "odd" : /^push$/i.test(w) ? "push" : "other";
    if (w === "-c" && /^alias\./i.test(squashMarks2(words[i + 1] ?? ""))) return aliasPushes2(words[i + 1]) ? "odd-push" : "odd";
    if (w === "-c" || VALUE_GLOBAL2.test(w)) i++;
  }
  return null;
}
function verbsOf2(raw, shell) {
  const { view, masked } = viewOf2(raw, shell);
  const read = { pushes: 0, odd: false, segs: [] };
  let from = 0;
  for (const m of [...masked.matchAll(/[;&|\r\n]+/g), null]) {
    const to = m === null ? masked.length : m.index;
    const ms = masked.slice(from, to);
    const rs = view.slice(from, to);
    from = m === null ? to : to + m[0].length;
    const verbs = [...ms.matchAll(GIT_WORD2)].filter((g) => isRunner2(rs, g)).map((g) => verbAt2(ms, rs, g));
    const pushes = verbs.filter((v) => v === "push").length;
    const payload = PAYLOAD2.test(rs) && holdsGitPush2(rs);
    const aliasPush = verbs.includes("odd-push");
    read.pushes += pushes;
    read.odd ||= payload || aliasPush || verbs.includes("odd");
    if (pushes > 0 || payload || aliasPush) read.segs.push(rs);
  }
  return read;
}
var FORCE_LONG_NAMES2 = ["force", "force-with-lease", "force-if-includes", "mirror", "delete"];
var isForceBundle2 = (w) => /^-[vqnfduoh46]+$/.test(w) && /[fd]/.test(w);
function forceSpelled2(raw) {
  return squashMarks2(raw).split(WORD_SPLIT2).some((w) => {
    if (/^\+[^+\s]/.test(w) || isForceBundle2(w)) return true;
    const long = /^--([A-Za-z][A-Za-z-]*)$/.exec(w);
    return long !== null && FORCE_LONG_NAMES2.some((n) => n.startsWith(long[1].toLowerCase()));
  });
}
var STRICT_QUIET2 = /* @__PURE__ */ new Set(["-n", "--dry-run", "-h", "--help"]);
function strictAccounted2(call) {
  if (!strictCall2(call)) return false;
  const { raws } = argWordsOf2(call);
  const positional = raws.filter((r) => !r.startsWith("-"));
  return raws.every((r) => !r.startsWith("-") || STRICT_OPTS2.has(r) || STRICT_QUIET2.has(r)) && strictPositionals2(positional);
}
var viewOf2 = (raw, shell) => {
  const view = joinContinuations(raw, shell);
  return { view, masked: maskQuoted2(view, shell === "pwsh" ? "PowerShell" : "Bash") };
};
function strictWhole2(raw, tool, shell) {
  if (!steadyCommand2(raw, shell) || mayRunUnderCmd2(tool) && /['^]/.test(raw)) return false;
  const { view, masked } = viewOf2(raw, shell);
  const calls = pushCallsOf2(masked, view, false);
  const pushSegs = segmentsOf2(fdBlank2(raw), shell)?.seq.filter((k) => k === "push").length ?? -1;
  return calls.length === pushSegs && calls.every(strictAccounted2);
}
function shapedCalls2(raw, tool, shell) {
  const { view, masked } = viewOf2(raw, shell);
  const shaped = (calls) => calls.filter((c) => pushShapesFrom2(c).length > 0).length;
  return Math.max(shaped(pushCallsOf2(masked, view, false)), shaped(pushCallsIn2(raw, mayRunUnderCmd2(tool)).filter((c) => c.squashed)));
}
function rawVerdict2(raw, tool) {
  const shell = tool === "PowerShell" ? "pwsh" : "bash";
  const read = verbsOf2(raw, shell);
  const hidden = hiddenPieces2(raw, tool).filter(hiddenPush2);
  if (read.pushes === 0 && !read.odd && hidden.length === 0) return null;
  if (hidden.length === 0 && strictWhole2(raw, tool, shell)) return { kind: "ok", unread: false };
  const unsafe = read.segs.some(hardSpelled2) || hidden.some(hardSpelled2);
  return { kind: unsafe ? "unsafe" : "tap", unread: read.odd || hidden.length > 0 || read.pushes > shapedCalls2(raw, tool, shell) };
}
function chainStep2(base, value, shell) {
  const raw = value.includes("\\") ? unquotePath2(value, shell) : value;
  if (hasUnexpandedPart2(value)) return UNEXPANDED2 + raw;
  const t = shell === "bash" ? gitBashPath2(raw) : raw;
  if (absoluteText2(t)) return t;
  if (isUnexpanded2(base)) return base;
  return base.startsWith("/") ? posix4.resolve(base, t) : resolve5(base, t);
}
var chainDir2 = (base, values, shell) => values.reduce((dir, v) => chainStep2(dir, v, shell), base);
function chainDirsOf2(p, cwd, shell) {
  if (p.cdirs.length < 2) return [];
  return [...new Set(dirsAfter2(cwd, p.cds, shell, p.loose).map((b) => chainDir2(b, p.cdirs, shell)))].filter((d) => !isUnexpanded2(d));
}
var MOVE_VALUE_RE2 = /(?:\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)[ \t]*=[ \t]*|--(?:git-dir|work-tree)(?:=|\s+))(\S+)/gi;
function moveTargets2(raw, cwd, shell, home) {
  const out4 = [];
  for (const m of raw.replace(/["']/g, "").matchAll(MOVE_VALUE_RE2)) {
    for (const dir of knownDirs2([chainStep2(cwd, m[1].replace(/[;&|)]+$/, ""), shell)], home)) out4.push(dir.replace(/[\\/]\.git(?:[\\/]worktrees[\\/][^\\/]+)?[\\/]*$/i, ""));
  }
  return [...new Set(out4)];
}
var HOME_LEAD2 = /^(?:~|\$HOME\b|\$\{HOME\}|\$env:USERPROFILE\b|%USERPROFILE%)(?=$|[\\/])/i;
function knownDirs2(dirs, home) {
  return dirs.flatMap((d) => {
    if (!isUnexpanded2(d)) return [d];
    const raw = d.slice(UNEXPANDED2.length);
    const lead = HOME_LEAD2.exec(raw);
    const rest = lead === null ? "" : raw.slice(lead[0].length);
    if (lead === null || hasUnexpandedPart2(rest.replace(/^[\\/]+/, ""))) return [];
    return [home.startsWith("/") ? posix4.join(home, rest) : join12(home, rest)];
  });
}
var firstCovered2 = (deps, dirs) => dirs.find((d) => coveredAmong2(deps, [d]) !== null) ?? null;
var RAW_CD2 = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;
function rawDirs2(raw, tool, cwd, shell, home) {
  const out4 = [cwd];
  for (const call of pushCallsIn2(raw, mayRunUnderCmd2(tool))) {
    for (const base of dirsAfter2(cwd, call.cds, shell, true)) out4.push(base, chainDir2(base, callDirsOf2(call), shell));
  }
  const lists = [raw.replace(/["'`^]/g, "").split(/[\s;&|(){}<>]+/), ...payloadWords2(raw, shell) ?? []];
  for (const words of lists) {
    let chained = cwd;
    for (let i = 0; i + 1 < words.length; i++) {
      if (!RAW_CD2.test(words[i]) && words[i] !== "-C" && !/^-path$/i.test(words[i])) continue;
      out4.push(chainStep2(cwd, words[i + 1], shell));
      chained = chainStep2(chained, words[i + 1], shell);
      out4.push(chained);
    }
  }
  return [.../* @__PURE__ */ new Set([...knownDirs2(out4, home), ...moveTargets2(raw, cwd, shell, home)])];
}
function payloadWords2(raw, shell) {
  const top = pairedWords2(raw, shell === "pwsh");
  if (top === null) return null;
  const lists = [top];
  for (const w of top.filter((t) => /\s/.test(t))) {
    const inner = [pairedWords2(w, false), pairedWords2(w, true)];
    if (inner.some((l) => l === null)) return null;
    lists.push(...inner);
  }
  return lists;
}
var RAW_PUSH_WHY2 = "this push sits inside the text of another program (sh -c, bash -c, pwsh -c) or in a quote this gate cannot pair, so its folder, remote and branch cannot be read. Run git push as its own command: git push <remote> <branch>.";
function rawPushDenies2(raw, tool, deps, cwd, shell, subagent) {
  const v = rawVerdict2(raw, tool);
  if (v === null || v.kind === "ok" || v.kind === "tap" && !v.unread) return [];
  const dirs = rawDirs2(raw, tool, cwd, shell, deps.home);
  const dir = firstCovered2(deps, dirs);
  if (dir === null) {
    if (!v.unread) return [];
    const hit = payloadWords2(raw, shell) === null || dirs.some((d) => !isUnexpanded2(d) && ccv3OrUnplaced2(deps, d));
    return hit ? [hardOf2(deny2("push-target-unresolved", RAW_PUSH_WHY2, "push"))] : [];
  }
  if (v.kind === "unsafe") return [deny2("push-unsafe", appRawUnsafeWhy2(dir), "app-push")];
  const unread = deny2("push-target-unresolved", appUnreadWhy2(dir), "app-push");
  return [subagent ? unread : { ...unread, tapPath: true }];
}
function hiddenGhDenies2(raw, tool, deps, cwd, shell) {
  if (!hiddenPieces2(raw, tool).some(hiddenGh2)) return [];
  const dir = firstCovered2(deps, rawDirs2(raw, tool, cwd, shell, deps.home));
  return dir === null ? [] : [{ ...deny2("position-unknown", unpairedWhy2(dir)), homeFlags: true }];
}
var GH_FLAG_FIRST2 = /(?:^|[\s;&|(){}"'])(?:[^\s;&|(){}"']*[\\/])?gh(?:\.exe)?["']?\s+-/i;
var GH_MERGE_TEXT2 = /\bpr\s+merge\b|\bapi\b[^\n]*\/merge\b/i;
var GH_CREATE_TEXT2 = /\bpr\s+(?:create|new)\b|\bapi\b[^\n]*\/pulls\b/i;
var GH_FLAG_FIRST_WHY2 = "a gh flag stands before the subcommand (gh -R <repo> pr ...), so this gate cannot read the call. Put the flag after the subcommand: gh pr create -R <repo> --head <branch> --base <base> ..., or gh pr merge <n> -R <repo> --match-head-commit <sha> ...";
function ghFlagFirstDenies2(raw, tool, deps, cwd, shell) {
  const text = squashMarks2(raw);
  if (!GH_FLAG_FIRST2.test(text) && !GH_FLAG_FIRST2.test(raw)) return [];
  const pattern = GH_MERGE_TEXT2.test(text) ? "merge-no-head" : GH_CREATE_TEXT2.test(text) ? "head-unresolved" : null;
  if (pattern === null) return [];
  const dirs = rawDirs2(raw, tool, cwd, shell, deps.home).filter((d) => !isUnexpanded2(d));
  const app = firstCovered2(deps, dirs);
  if (app !== null) return [{ ...deny2(pattern, `${GH_FLAG_FIRST_WHY2}${inAppFolder2(app)}`), homeFlags: true }];
  if (dirs.some((d) => ccv3OrUnplaced2(deps, d))) return [deny2(pattern, GH_FLAG_FIRST_WHY2)];
  for (const d of dirs) {
    const place = appPlace2(deps, d);
    if (place.corrupt) return [registryCorruptDeny2(place.corrupt, d, "other")];
  }
  return [];
}
function cmdSegments2(view) {
  const out4 = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE2.source, "g"))) {
    out4.push({ seg: view.slice(from, m.index), from });
    from = m.index + m[0].length;
  }
  out4.push({ seg: view.slice(from), from });
  return out4;
}
var whereId2 = (at3) => `${at3.unknown ? "?" : ""}${at3.loose ? "~" : ""}${at3.cds.join("\0")}`;
function ownCommand2(view, masked, from) {
  const end = (cut) => cut < 0 ? view.length : from + cut;
  const to = end(masked.slice(from).search(SEGMENT_RE2));
  const fto = end(masked.slice(from).replace(/>&|&>/g, "  ").search(SEGMENT_RE2));
  return { text: view.slice(from, to), mtext: masked.slice(from, to), ftext: view.slice(from, fto), fmtext: masked.slice(from, fto) };
}
function priorOf2(view, masks, from) {
  const all = masks.map((m) => priorGhRepo(view.slice(0, from), m.slice(0, from)));
  return { repos: [...new Set(all.flatMap((a) => a.repos))].sort(), nonLiteral: all.some((a) => a.nonLiteral) };
}
var priorId2 = (p) => p.repos.length === 0 && !p.nonLiteral ? "" : `|GH_REPO=${p.repos.join(",")}${p.nonLiteral ? "$" : ""}`;
var fullId2 = (own) => own.ftext === own.text ? "" : `|${own.ftext}`;
var landId2 = (shape, at3, own, prior) => `${shape.kind}|${shape.pr}|${shape.sha}${shape.shaBad ? "!" : ""}|${whereId2(at3)}${shape.kind === "merge" ? `|${own.ftext}${priorId2(prior)}` : ""}`;
var distinctWheres2 = (wheres) => wheres.filter((w, i) => wheres.findIndex((o) => whereId2(o) === whereId2(w)) === i);
function shapesOf2(raw, tool, parsed) {
  const text = normalizeGh(blankInertQuotes2(raw, tool));
  const views = [.../* @__PURE__ */ new Set([joinContinuations(text, "bash"), joinContinuations(text, "pwsh")])];
  const textOnly = (tool === "Bash" || tool === "PowerShell") && !PR_NUMBER_IN_TEXT_RE2.test(raw) && [raw, joinContinuations(raw, "bash"), joinContinuations(raw, "pwsh")].every(isTextOnlyCommand2);
  const docAst = !PR_NUMBER_IN_TEXT_RE2.test(raw) && docAppendByAst2(parsed, tool, raw);
  const out4 = [];
  const pwshTool = tool === "PowerShell";
  const seen = /* @__PURE__ */ new Set();
  const add = (shape, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out4.push(shape);
    }
  };
  let created = false;
  const exempt = textOnly || docAst;
  const astItems = astItemsOf2(parsed, raw, exempt, text);
  const heldItems = /* @__PURE__ */ new Set();
  const astHolds = (s, create) => {
    const sq = squashed2(s);
    const hit = astItems.filter((i) => i.create === true === create && sq.includes(i.sq));
    hit.forEach((i) => heldItems.add(i));
    return hit;
  };
  for (const view of views) {
    const reads = ["Bash", "PowerShell"].map((tool2) => {
      const masked = maskQuoted2(view, tool2);
      return { masked, pos: cdPositions2(masked, view) };
    });
    for (const { seg, from } of cmdSegments2(view)) {
      const wheres = distinctWheres2(reads.map((r) => whereAt2(r.pos, from)));
      const owns = reads.map(({ masked }) => ownCommand2(view, masked, from));
      const prior = priorOf2(view, reads.map((r) => r.masked), from);
      const tail = quoteOpenAt2(view, from, pwshTool) ? "" : rawTail2(view.slice(from));
      for (const s of /* @__PURE__ */ new Set([seg, squashQuotes(seg)])) {
        const found = astHolds(s, false).flatMap((i) => i.shape ? [i.shape] : []);
        for (const shape of found) {
          for (const own of owns) for (const at3 of wheres) add({ ...shape, at: at3, ...own, prior }, landId2(shape, at3, own, prior));
        }
      }
      const heldCreates = astHolds(seg, true);
      if (heldCreates.length === 0) continue;
      created = true;
      const held = heldCreates.find((h) => h.read?.bad) ?? heldCreates[0];
      for (const own of owns) for (const at3 of wheres) add({ kind: "create", pr: null, at: at3, ...own, prior, tail, pwsh: pwshTool, ...held?.read ? { read: held.read } : {} }, `create|${whereId2(at3)}|${own.text}${fullId2(own)}${priorId2(prior)}|${tail}`);
    }
  }
  const loose = astItems.filter((i) => i.create !== true && i.shape && !heldItems.has(i));
  if (loose.length > 0) {
    const view = views[0];
    const masked = maskQuoted2(view, "Bash");
    for (const i of loose) for (const at3 of [{ cds: [], unknown: false, loose: false }, whereAt2(cdPositions2(masked, view), view.length)]) {
      add({ ...i.shape, at: at3, text: view, mtext: masked, ftext: view, fmtext: masked, prior: NO_PRIOR2, pwsh: pwshTool }, `loose|${i.shape?.kind}|${i.shape?.pr}|${whereId2(at3)}|${i.sq}`);
    }
  }
  const looseCreate = astItems.filter((i) => i.create === true);
  if (!created && looseCreate.length > 0) {
    const view = views[0];
    const masked = maskQuoted2(view, "Bash");
    const read = looseCreate.find((i) => i.read?.bad)?.read ?? looseCreate[0]?.read;
    for (const at3 of [{ cds: [], unknown: false, loose: false }, whereAt2(cdPositions2(masked, view), view.length)]) {
      add({ kind: "create", pr: null, at: at3, text: view, mtext: masked, ftext: view, fmtext: masked, tail: view, pwsh: pwshTool, ...read ? { read } : {} }, `create|${whereId2(at3)}|${view}`);
    }
  }
  const withMergesAndCreates = withAstCreates2(withAstMerges2(out4, parsed, pwshTool), parsed, pwshTool);
  const seenLand = new Set(withMergesAndCreates.filter((s) => s.kind === "land").map((s) => `${s.pr}|${s.sha}`));
  const lands = astLandShapes2(parsed, raw, exempt, text, pwshTool).filter((s) => {
    const k = `${s.pr}|${s.sha}`;
    if (seenLand.has(k)) return false;
    seenLand.add(k);
    return true;
  });
  return [...withMergesAndCreates, ...lands, ...pushShapesOf2(raw, tool)];
}
var enforcing2 = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforce");
var enforcingPush2 = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforcePush");
function homeFlag2(deps, key) {
  try {
    const cfg = JSON.parse(deps.readFile(join12(deps.home, "continuous-claude", "review-router.config.json")) ?? "null");
    return cfg?.decisions?.[key];
  } catch {
    return null;
  }
}
function enforcingScope2(scope, deps, cwd, homeOnly = false) {
  if (scope === "app-push") return homeFlag2(deps, "enforceAppPush") !== false;
  if (homeOnly && scope === "other") return homeFlag2(deps, "enforce") === true;
  return scope === "push" ? enforcingPush2(deps, cwd) : enforcing2(deps, cwd);
}
var FLAG_OF = { push: "decisions.enforcePush", other: "decisions.enforce", "app-push": "decisions.enforceAppPush" };
var OPENER2 = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
var CMD_POS2 = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER2}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER2}*))` + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
var NOISE2 = String.raw`(?:\\|''|"")*`;
var spell2 = (word) => NOISE2 + [...word].join(NOISE2) + NOISE2;
var CD_NAMES4 = `${spell2("cd")}|Set-Location|sl|${spell2("chdir")}|${spell2("pushd")}|Push-Location`;
var CD_SOURCE2 = CMD_POS2 + String.raw`(?:${CD_NAMES4})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`;
var JOB_BLOCK2 = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;
function withoutClosed2(text, group) {
  let t = text;
  for (; ; ) {
    const next = t.replace(group, "");
    if (next === t) return t;
    t = next;
  }
}
var CLOSED_BRACES2 = /\{[^{}]*\}/g;
var CLOSED_PARENS2 = /\([^()]*\)|`[^`]*`/g;
var COMMENT2 = /(?:^|(?<!\\)\s)#[^\r\n]*/g;
var insideSubshell2 = (before) => /[(`]/.test(withoutClosed2(before.replace(COMMENT2, ""), CLOSED_PARENS2));
var gitBashPath2 = (p) => process.platform === "win32" ? p.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : p;
function hasUnexpandedPart2(target) {
  const t = target.replace(/^["']|["']$/g, "");
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith("~") || /^[(@]/.test(t);
}
var UNEXPANDED2 = "<cannot-expand>";
var isUnexpanded2 = (dir) => dir.startsWith(UNEXPANDED2);
var unexpandedWhy2 = (dir) => `a cd target or -C value (${dir.slice(UNEXPANDED2.length, UNEXPANDED2.length + 120)}) holds a variable, a command substitution, a ~ or a glob, so the checkout this command runs in cannot be known. Use a literal path in the cd (cd <full path> && ...).`;
var absoluteText2 = (t) => isAbsolute4(t) || /^[A-Za-z]:/.test(t);
function unquotePath2(target, shell) {
  return shell === "pwsh" ? target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, s) => d ?? s ?? "").trimEnd() : target.replace(/\\([ "'])|["']/g, (_m, esc) => esc ?? "");
}
function moveTo2(base, target, shell) {
  const raw = unquotePath2(target, shell);
  if (hasUnexpandedPart2(target)) return UNEXPANDED2 + raw;
  const t = shell === "bash" ? gitBashPath2(raw) : raw;
  if (absoluteText2(t)) return t;
  return isUnexpanded2(base) ? base : resolve5(base, t);
}
var cdsBefore2 = (masked, raw) => whereAt2(cdPositions2(masked, raw), masked.length);
function looseJoin2(between) {
  const joiners = between.replace(FD_REDIRECT2, " ").match(/&&|\|\||[;&|\r\n]/g) ?? [];
  return !(joiners.length > 0 && joiners.every((j) => j === "&&"));
}
var FD_REDIRECT2 = /\d*[<>]&\d*-?|&>>?/g;
function endsInPipe2(before) {
  let t = before.trimEnd();
  for (; ; ) {
    const c = t.replace(/(?:^|\s)#[^\r\n]*$/, "").trimEnd();
    if (c === t) break;
    t = c;
  }
  return t.endsWith("|") || t.endsWith("|&");
}
var UNKNOWN_CD_SOURCE2 = CMD_POS2 + String.raw`(?:(?:${spell2("popd")}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES4})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`;
var NO_FOLDER2 = /^(?:[-+]|-[PLe@]+|--)$/i;
var REMOTE_AFTER_BLOCK2 = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;
function cdPositions2(masked, raw) {
  const cds = [];
  const unknown = [...masked.matchAll(new RegExp(UNKNOWN_CD_SOURCE2, "gi"))].map((m) => m.index + m[0].length);
  for (const m of masked.matchAll(new RegExp(CD_SOURCE2, "gi"))) {
    const end = m.index + m[0].length;
    const target = raw.slice(end - m.groups.t.length, end);
    if (NO_FOLDER2.test(target)) {
      unknown.push(end);
      continue;
    }
    const before = masked.slice(0, m.index);
    const piped = m.groups.soft !== void 0 || /^\||[(`]/.test(m.groups.hard ?? "") || endsInPipe2(before) || insideSubshell2(before) || JOB_BLOCK2.test(withoutClosed2(before, CLOSED_BRACES2)) || REMOTE_AFTER_BLOCK2.test(masked.slice(end));
    cds.push({ end, target, piped });
  }
  return { cds, unknown, masked };
}
function whereAt2(pos, from) {
  const before = pos.cds.filter((c) => c.end <= from);
  return {
    cds: before.map((c) => c.target),
    unknown: pos.unknown.some((end) => end <= from),
    loose: before.some((c) => c.piped || looseJoin2(pos.masked.slice(c.end, from)))
  };
}
function pushDir2(cwd, cds, shell) {
  return cds.reduce((dir, target) => moveTo2(dir, target, shell), cwd);
}
function isCcv3Checkout2(deps, dir) {
  const r = deps.git(dir, ["remote", "-v"]);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1] ?? "";
    const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return m !== null && m[1].toLowerCase() === CCV3_REPO;
  });
}
var NOT_COVERED2 = { covered: false, entryKey: "", github: null, corrupt: null };
var TOP_ARGS2 = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
var COMMON_ARGS2 = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
var PLACES2 = /* @__PURE__ */ new WeakMap();
function appPlace2(deps, dir) {
  if (!deps.tapScope) return NOT_COVERED2;
  let memo = PLACES2.get(deps);
  if (!memo) PLACES2.set(deps, memo = /* @__PURE__ */ new Map());
  const known = memo.get(dir);
  if (known) return known;
  const scope = deps.tapScope;
  const place = inApp2(deps, () => readPlace2(deps, scope, dir));
  memo.set(dir, place);
  return place;
}
function readPlace2(deps, scope, dir) {
  const reg2 = scope.registry();
  if (reg2.state === "corrupt") return { ...NOT_COVERED2, corrupt: reg2.file };
  if (reg2.state === "missing") return reg2.envPath ? { ...NOT_COVERED2, notice: reg2.file } : NOT_COVERED2;
  if (!underLiveRoot2(dir, reg2, scope)) return NOT_COVERED2;
  try {
    const { top, main: main4 } = repoRoots2(deps, dir);
    const cov = coverageOf2({ toplevel: top, worktreeMainRoot: main4, isCcv3: false }, reg2, { realpath: scope.realpath });
    return cov.covered ? { covered: true, entryKey: cov.entryKey ?? "", github: cov.github ?? null, corrupt: null } : NOT_COVERED2;
  } catch (err) {
    throw err instanceof AppScopeError2 ? err : new AppScopeError2(err);
  }
}
function rootOfCommon2(dir, common) {
  const commonDir = common === "" || absoluteText2(common) ? common : resolve5(dir, common);
  return /[\\/]\.git$/.test(commonDir) ? commonDir.replace(/[\\/]\.git$/, "") : null;
}
function repoRoots2(deps, dir) {
  const r = deps.git(dir, TOP_ARGS2);
  const [top = "", common = ""] = r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()) : [];
  if (top !== "") return { top, main: rootOfCommon2(dir, common) };
  const c = deps.git(dir, COMMON_ARGS2);
  const root = c.status === 0 ? rootOfCommon2(dir, c.stdout.trim()) : null;
  if (root === null) throw new AppScopeError2(new Error(`the repo root of ${at2(dir)} cannot be read (no work tree, and no <root>/.git common dir)`));
  return { top: root, main: root };
}
function passOf2(place, dir, scope) {
  if (place.corrupt) return registryCorruptDeny2(place.corrupt, dir, scope);
  return place.notice ? { action: "allow", notice: place.notice } : ALLOW2;
}
var registryCorruptDeny2 = (file, dir, scope) => ({ ...deny2("registry-corrupt", registryCorruptWhy2(file, dir), scope), homeFlags: true });
function coveredAmong2(deps, dirs) {
  const scope = deps.tapScope;
  if (!scope) return null;
  for (const dir of dirs) {
    try {
      if (isCcv3Checkout2(deps, dir)) return null;
      if (appPlace2(deps, dir).covered) return dir;
    } catch {
      if (underLiveRoot2(dir, scope.registry(), scope, { outsideCcv3: true })) return dir;
    }
  }
  return null;
}
var gitIn2 = (deps, dir) => (args) => deps.git(dir, args);
function cmdRepoOf2(s, named, env) {
  const text = s.ftext ?? s.text ?? "";
  const prior = s.prior ?? NO_PRIOR2;
  const repo = commandRepo(text, s.fmtext ?? s.mtext ?? text, env, prior.repos);
  return { named, repo, foreign: repo !== null && repo !== CCV3_REPO, nonLiteral: hasNonLiteralRepo(text) || CLUSTER_VAR_REPO2.test(text) || prior.nonLiteral };
}
var CLUSTER_VAR_REPO2 = /(?:^|\s)-[A-Za-z]+R\s*=?["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)/;
var namesCcv32 = (repo) => repo !== null && repo.split(" ").includes(CCV3_REPO);
function routeOf2(deps, dir, cmd) {
  const named = cmd.named === CCV3_REPO;
  let ccv3;
  try {
    ccv3 = isCcv3Checkout2(deps, dir);
  } catch (err) {
    if (named) return "ccv3";
    throw err;
  }
  if (ccv3) return cmd.foreign ? "foreign" : "ccv3";
  if (!named) return "app";
  return namesCcv32(cmd.repo) || !appPlace2(deps, dir).covered ? "ccv3" : "app";
}
function appRepoFor2(cmd, deps, dir, place, base) {
  if (cmd.nonLiteral) return deny2("repo-unreadable", appRepoUnreadableWhy2(dir));
  const k = ghKey4(gitIn2(deps, dir), { named: cmd.repo, entryKey: place.entryKey, github: place.github });
  if (k.ok) return { key: k.key, offer: { ...base, remote: k.remote, ...aliasStop2(deps, dir, place, k.key, k.remote) } };
  const offer = { ...base, remote: k.remote ?? "<remote>", ...aliasStop2(deps, dir, place, k.key ?? "", k.remote ?? null) };
  if (k.why === "repo-differs") return deny2("repo-differs", appRepoDiffersWhy2(deps, dir, cmd.repo ?? "", k.key ?? null, offer));
  if (k.why === "fetch-push-differ") return deny2("fetch-push-differ", appFetchPushWhy2(deps, dir, k.remote ?? "", k.key ?? "", (k.pushKeys ?? []).map(String), offer));
  if (k.why === "unnamed") return deny2("repo-unnamed", appRepoUnnamedWhy2(deps, dir, offer, k.key ?? null));
  return deny2("repo-unnamed", appNoTargetWhy2(deps, dir, k.remotes ?? [], offer));
}
function aliasStop2(deps, dir, place, key, remote) {
  if (!key.startsWith("local:") || remote === null) return {};
  const url = fetchUrlOf2(deps, dir, remote);
  return url !== null && needsGithubField4(url, place.github) ? { stop: needsFieldLine2(place.entryKey, remote) } : {};
}
var AppScopeError2 = class extends Error {
  constructor(inner, push = true) {
    super(String(inner?.message ?? inner));
    this.inner = inner;
    this.push = push;
    this.name = "AppScopeError";
  }
  inner;
  push;
};
var CREATE_BOOL2 = /* @__PURE__ */ new Set(["--draft", "-d", "--fill", "-f", "--fill-first", "--fill-verbose", "--web", "-w", "--no-maintainer-edit", "--dry-run", "--editor", "-e"]);
var CREATE_VALUE2 = /* @__PURE__ */ new Set([
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
var CREATE_SHORT_BOOL2 = "dwef";
var CREATE_SHORT_VALUE2 = "tbFlarmpHBRT";
var API_CREATE_KEYS2 = /* @__PURE__ */ new Set(["head", "base", "title", "body", "draft", "maintainer_can_modify", "issue"]);
var API_BOOL2 = /* @__PURE__ */ new Set(["--paginate", "--slurp", "--silent", "--verbose", "-i", "--include"]);
var NOT_LITERAL_RE2 = /%[^%\s]+%/;
var BAD2 = (why) => ({ bad: why, heads: [], bases: [] });
var NO_READ = BAD2("the parser gave no read for this create");
function cliCreateOfWords2(words) {
  const heads = [];
  const bases = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-") || w === "-") return BAD2(`a word gh pr create does not take (${w})`);
    if (/^-[A-Za-z]{2,}/.test(w)) {
      const c = clusterOf2(w, words[i + 1], CREATE_SHORT_BOOL2, CREATE_SHORT_VALUE2);
      if (c === null) return BAD2(`a flag this gate does not know (${w})`);
      if (c.letter === "H") heads.push(c.value);
      if (c.letter === "B") bases.push(c.value);
      i += c.used;
      continue;
    }
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (CREATE_BOOL2.has(name) && eq < 0) continue;
    if (!CREATE_VALUE2.has(name)) return BAD2(`a flag this gate does not know (${name})`);
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === void 0) return BAD2(`${name} with no value`);
    if (name === "--head" || name === "-H") heads.push(value);
    if (name === "--base" || name === "-B") bases.push(value);
  }
  return headAndBase2(heads, bases);
}
function headAndBase2(heads, bases) {
  if (heads.some((v) => v === "" || NOT_LITERAL_RE2.test(v))) return BAD2("a head value that is empty or not a literal");
  const named = bases.filter((b) => b !== "");
  if (named.some((v) => NOT_LITERAL_RE2.test(v))) return BAD2("a base value that is not a literal");
  return { bad: null, heads: [...new Set(heads)], bases: [...new Set(named)] };
}
function apiCreateOfWords2(words) {
  const heads = [];
  const bases = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord2(words[i], words[i + 1], endpoint);
    if ("bad" in r) return BAD2(r.bad);
    if (r.used === -1) {
      endpoint = true;
      continue;
    }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf("=");
    const key = eq > 0 ? r.field.slice(0, eq) : r.field;
    if (!API_CREATE_KEYS2.has(key)) return BAD2(`a field this gate does not know (${key})`);
    const value = eq > 0 ? r.field.slice(eq + 1) : "";
    if ((key === "head" || key === "base") && value.startsWith("@")) return BAD2(`a ${key} read from a file (${key}=@...)`);
    if (key === "head") heads.push(value);
    if (key === "base") bases.push(value);
  }
  return headAndBase2(heads, bases);
}
var createBadWhy2 = (dir, why) => `the head or base of this create cannot be read as gh reads it in ${dir}: ${why}. Name the head and base once, in the plain form: gh pr create --head <branch> --base <base> ..., or gh api .../pulls -X POST -f head=<branch> -f base=<base> .... A body made by $(...) or a heredoc is refused: pass it as a file with --body-file <path> or -F body=@<path>, with forward slashes in the path. ${PLAIN_WAY_OUT2}`;
function readBranch2(named, deps, dir) {
  if (named) return named.replace(/^[^:\s]+:/, "");
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
var COMMIT_GIT2 = gitCallRe("commit");
var COMMIT_SAFE2 = safeCallRe("commit", PUSH_WRAPPERS2, "", "gi");
var READ_VERB2 = "(?:status|diff|log|show|rev-parse)";
var READ_GIT2 = gitCallRe(READ_VERB2);
var READ_SAFE2 = safeCallRe(READ_VERB2, PUSH_WRAPPERS2, "", "gi");
var COMMIT_MSG2 = String.raw`(?:-[Fm]\s+${VAL}|--(?:file|message)(?:=|\s+)${VAL})`;
var COMMIT_ARGS_RE2 = new RegExp(String.raw`^(?:\s+(?:-q|--quiet))*\s+${COMMIT_MSG2}(?:\s+(?:-q|--quiet|${COMMIT_MSG2}))*\s*$`);
var CD_SEG_RE2 = /^\s*(?:cd|Set-Location|sl|chdir|pushd|Push-Location)\s+\S/i;
function openCall2(ms, rs, git, safe) {
  const kinds = [[git, isGitToken], [safe, (t) => isSafeToken(t, PUSH_WRAPPERS2)]];
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
function segmentKind2(ms, rs) {
  if (/[(){}<>]/.test(ms) || /[$`]/.test(rs)) return "other";
  if (CD_SEG_RE2.test(ms)) return "cd";
  const commit = openCall2(ms, rs, COMMIT_GIT2, COMMIT_SAFE2);
  if (commit) return commit.opts.trim() === "" && COMMIT_ARGS_RE2.test(rs.slice(commit.end)) ? "commit" : "other";
  if (openCall2(ms, rs, PUSH_GIT2, PUSH_SAFE2)) return "push";
  const read = openCall2(ms, rs, READ_GIT2, READ_SAFE2);
  return read && read.opts.trim() === "" ? "read" : "other";
}
function commitPrecedesPush2(raw, shell) {
  const segs = segmentsOf2(raw, shell);
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
function pushesAlone2(raw, shell) {
  const segs = segmentsOf2(raw, shell);
  return segs !== null && segs.seq.includes("push") && segs.seq.every((k) => k === "cd" || k === "push" || k === "read");
}
var FD_DUP2 = /(^|\s)[12]?>&[12](?=\s|$)/g;
var fdBlank2 = (raw) => raw.replace(FD_DUP2, (m, lead) => lead + " ".repeat(m.length - lead.length));
function steadyCommand2(raw, shell) {
  const view = fdBlank2(raw);
  return pushesAlone2(view, shell) || commitPrecedesPush2(view, shell);
}
function stateModelled2(raw, shell, ctx = {}) {
  const r = pushPrefix2(raw, shell, ctx.remoteIsLocal);
  return r !== null && !r.localPush && r.pipeOk && !consumerSubstitutes2(ctx.parsed) && (r.plain || commitPrecedesPush2(r.prefix, shell));
}
function consumerSubstitutes2(parsed) {
  if (!parsed) return false;
  return Object.values(parsed.byDialect).some((r) => {
    if (!r || r.errors.length > 0) return false;
    const lastPush = Math.max(-1, ...r.calls.filter((c) => progName2(c.words[0]?.lit) !== null && c.words.some((w) => (w.lit ?? "").toLowerCase() === "push")).map((c) => c.start));
    return lastPush >= 0 && r.calls.some((c) => c.start > lastPush && c.place.pipe && r.substs.some((s) => s.from >= c.start && s.to <= c.end));
  });
}
var MAX_REMOTE_LOOKUPS2 = 4;
var MAX_LOOKUP_CALLS2 = 16;
var REMOTE_LOOKUP_RESERVE_MS2 = 1500;
var REMOTE_LOOKUP_MIN_MS2 = 200;
var URL_SCHEME2 = /^([a-z][a-z0-9+.-]*):\/\//i;
var SCP_LIKE2 = /^(?:[^\s/\\:@]+@)?[^\s/\\:]{2,}:/;
var clearlyNetwork2 = (url) => {
  const m = URL_SCHEME2.exec(url);
  return m ? m[1].toLowerCase() !== "file" : SCP_LIKE2.test(url);
};
function answerIsLocal2(stdout) {
  const lines3 = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines3.length === 0 || lines3.some((l) => LOCAL_REMOTE2.test(l) || !clearlyNetwork2(l));
}
function remoteNameIsLocal2(deps, cwd, extraDirs, name, budget) {
  for (const dir of [cwd, ...extraDirs.filter((d) => d !== cwd)]) {
    const own = dir === cwd;
    for (const args of [["remote", "get-url", name], ["remote", "get-url", "--push", "--all", name]]) {
      if (budget.left <= 0) return true;
      let opts;
      if (deps.scanLeft) {
        const left = deps.scanLeft();
        const timeout = Math.min(GIT_TIMEOUT_MS2, left - 1e3);
        if (left < REMOTE_LOOKUP_RESERVE_MS2 || timeout < REMOTE_LOOKUP_MIN_MS2) return true;
        opts = { timeout };
      }
      budget.left -= 1;
      try {
        const g = deps.git(dir, args, opts);
        if (g.status !== 0) {
          if (args.length === 3) break;
          return true;
        }
        if (answerIsLocal2(g.stdout)) return true;
      } catch (e) {
        if (own || !(e instanceof MissingCwdError2 || errCode2(e) === "ENOENT")) return true;
        break;
      }
    }
  }
  return false;
}
function pushPrefix2(raw, shell, remoteIsLocal) {
  const view = fdBlank2(joinContinuations(raw, shell));
  const masked = maskQuoted2(view, shell === "pwsh" ? "PowerShell" : "Bash");
  const steps = [];
  let from = 0;
  let pending = "";
  for (const [start, next] of [...[...masked.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]), [view.length, view.length]]) {
    const ms = masked.slice(from, start);
    const rs = view.slice(from, start);
    if (ms.trim() !== "") {
      steps.push({ kind: /^\s*(?:popd|Pop-Location)\s*$/i.test(ms) ? "popd" : segmentKind2(ms, rs), named: /\bpush\b/i.test(squashQuotes(rs)), op: pending, end: start, raw: rs });
      pending = "";
    } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  const last = steps.map((s) => s.named).lastIndexOf(true);
  if (last < 0) return null;
  const plain = steps.slice(0, last).every((s) => s.kind === "cd" || s.kind === "read" || s.kind === "push" || s.kind === "popd") && steps.slice(1, last + 1).every((s) => !s.op.includes("|") && !/(?<!&)&(?!&)/.test(s.op));
  const tool = shell === "pwsh" ? "PowerShell" : "Bash";
  const earlier = steps.slice(0, last).filter((s) => s.kind === "push").flatMap((s) => pushShapesOf2(s.raw, tool).map((p) => p.push?.remote ?? ""));
  const names = [...new Set(earlier.filter((rm) => rm !== "" && !LOCAL_REMOTE2.test(rm) && !/[:/]/.test(rm)))];
  const localPush = earlier.some((rm) => LOCAL_REMOTE2.test(rm)) || remoteIsLocal !== void 0 && (names.length > MAX_REMOTE_LOOKUPS2 || names.some(remoteIsLocal));
  let pipeOk = true;
  if (backgroundAfter2([...steps.slice(last + 1).map((s) => s.op), pending])) pipeOk = false;
  for (let i = last + 1; i < steps.length && /(?<!\|)\|(?!\|)/.test(steps[i].op); i++) {
    const ms = masked.slice(steps[i].end - steps[i].raw.length, steps[i].end);
    if (!PIPE_CONSUMER2.test(ms.trim().split(/\s+/)[0] ?? "") || /[$`@({<]/.test(ms.replace(/\$null\b/gi, "")) || fileRedirect2(ms)) pipeOk = false;
  }
  return { prefix: view.slice(0, steps[last].end), plain, localPush, pipeOk };
}
var PIPE_CONSUMER2 = /^(?:Select-Object|Select-String|Out-String|Out-Null|tail|head|cut|grep|findstr|wc|more)$/i;
function backgroundAfter2(ops) {
  for (const op of ops) {
    const m = /(?<!&)&(?!&)|[;\r\n]/.exec(op);
    if (m !== null) return m[0] === "&";
  }
  return false;
}
var fileRedirect2 = (ms) => [...ms.matchAll(/[0-9*]?>{1,2}\s*(\S*)/g)].some((m) => !/^(?:\$null|\/dev\/null|nul)$/i.test(m[1]));
var LOCAL_REMOTE2 = /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:|file:)|\\/i;
var PUSH_STATE_WHY2 = "a step before this push, or a step that runs at the same time (a pipe, a background &), can change the branch, HEAD or the tree it sends (a checkout, a reset, a merge, a commit joined by ; or ||, a group, a pipe or another program), and this gate reads them before the command runs. Run the branch change and the push as two commands; run git push as its own command: git push <remote> <branch>. For a commit: commit first, push in a separate command: commit in one command (git add <files> then git commit -F <file>), and push in the next command (git push <remote> <branch>), after the Commit and push question.";
var PUSH_CHECKOUT_WHY2 = "the commit before this push runs in one checkout and the push in another (or the checkout of the push folder cannot be read), so the tree it sends cannot be judged. Commit and push in two commands, or push from the same folder: git commit ...; git push <remote> <branch>.";
function sameCheckout2(deps, commitDirs, dir) {
  const top = (d) => {
    const r = deps.git(d, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
  };
  if (commitDirs.length === 0 || commitDirs.length > 2) return false;
  const push = top(dir);
  return push !== null && commitDirs.every((c) => top(c) === push);
}
var ADD_GIT2 = gitCallRe("add");
var ADD_SAFE2 = safeCallRe("add", PUSH_WRAPPERS2, "", "gi");
function stageKind2(ms, rs) {
  const k = segmentKind2(ms, rs);
  if (k !== "other" || /[(){}<>]/.test(ms) || /[$`]/.test(rs)) return k;
  if (openCall2(ms, rs, COMMIT_GIT2, COMMIT_SAFE2)) return "commit";
  return openCall2(ms, rs, ADD_GIT2, ADD_SAFE2) ? "stage" : "other";
}
function shipFlow2(raw, shell) {
  const segs = segmentsOf2(fdBlank2(raw), shell, stageKind2);
  if (segs === null || segs.seq.includes("other")) return false;
  const firstPush = segs.seq.indexOf("push");
  const lastCommit = segs.seq.lastIndexOf("commit");
  return firstPush >= 0 && lastCommit >= 0 && Math.max(lastCommit, segs.seq.lastIndexOf("stage")) < firstPush;
}
function segmentsOf2(raw, shell, kindOf = segmentKind2) {
  const view = joinContinuations(raw, shell);
  const masked = maskQuoted2(view, shell === "pwsh" ? "PowerShell" : "Bash");
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
var shellOf2 = (input) => (input.tool_name || input.tool) === "PowerShell" ? "pwsh" : "bash";
var ALLOW2 = { action: "allow" };
function judgeCreate2(s, deps, dir, cmd) {
  const route = routeOf2(deps, dir, cmd);
  if (route === "app") return judgeAppCreate2(s.tail ?? s.ftext ?? s.text, s.pwsh === true, deps, dir, cmd, s.read);
  if (route === "foreign") return deny2("repo-foreign", goThereWhy2(cmd.repo));
  const cr = s.read ?? NO_READ;
  if (cr.bad !== null) return deny2("head-unresolved", createBadWhy2(dir, cr.bad));
  if (cr.heads.length > 1) return deny2("head-unresolved", createBadWhy2(dir, `two head values (${cr.heads.join(", ")}); gh takes the last`));
  const branch = readBranch2(cr.heads[0] ?? null, deps, dir);
  if (branch === "") return deny2("head-unresolved", `the head branch of this create cannot be named in ${dir} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo on a branch.`);
  if (branch === "main") return ALLOW2;
  const r = deps.git(dir, ["rev-parse", `${branch}^{commit}`]);
  if (r.status !== 0) return deny2("head-unresolved", `cannot read the head of ${branch} in ${dir}, so its open-pr decision cannot be found. Run the command again from the repo.`);
  const head = r.stdout.trim();
  const d = decisionRead2({ step: "open-pr", key: decisionKey2({ branch }), head });
  return d && isOpenPrLabel2(d.label) ? ALLOW2 : deny2("open-pr", openPrWhy2(branch, head));
}
function judgeLand2(shape, deps, dir, cmd) {
  const route = shape.kind === "merge" ? routeOf2(deps, dir, cmd) : "ccv3";
  if (route === "app") return judgeAppMerge2(shape, deps, dir, cmd);
  if (route === "foreign") return deny2("repo-foreign", goThereWhy2(cmd.repo));
  if (shape.pr === null) return deny2("no-pr", NO_PR_WHY2);
  if (shape.kind === "merge" && shape.shaBad) return deny2("merge-no-head", `PR #${shape.pr}: ${HEAD_UNREAD_WHY2(shape.pr)} The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr}).`);
  const sha = shape.sha ?? void 0;
  if (shape.kind === "merge" && !sha) return deny2("merge-no-head", `${shape.pr ? `PR #${shape.pr}` : "this PR"}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? "<n>"} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? "<n>"}).`);
  const key = decisionKey2({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isLandLabel2(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW2 : deny2("land", landWhy2(shape.pr));
}
function judgeAppCreate2(text, pwsh, deps, dir, cmd, read) {
  return homeRead2(inApp2(deps, () => appCreate2(text, pwsh, deps, dir, cmd, read)));
}
var homeRead2 = (d) => d.action === "deny" ? { ...d, homeFlags: true } : d;
function coveredCall2(deps, dir, body) {
  let place;
  try {
    place = appPlace2(deps, dir);
  } catch (err) {
    throw err instanceof AppScopeError2 ? new AppScopeError2(err.inner, false) : err;
  }
  if (!place.covered) return passOf2(place, dir, "other");
  try {
    return body(place);
  } catch (err) {
    throw new AppScopeError2(err instanceof AppScopeError2 ? err.inner : err, false);
  }
}
function appCreate2(text, pwsh, deps, dir, cmd, read) {
  return coveredCall2(deps, dir, (place) => appCreateIn2(text, pwsh, deps, dir, cmd, place, read));
}
function appCreateIn2(text, pwsh, deps, dir, cmd, place, read) {
  const cr = read ?? NO_READ;
  if (cr.bad !== null) return deny2("head-unresolved", createBadWhy2(dir, cr.bad));
  const heads = cr.heads;
  if (heads.length > 1) return deny2("head-unresolved", appManyHeadsWhy2(dir, heads));
  const owner = /^([^:\s]+):/.exec(heads[0] ?? "")?.[1] ?? null;
  if (owner !== null) return deny2("head-foreign", appHeadOwnerWhy2(dir, owner));
  const branch = readBranch2(heads[0] ?? null, deps, dir);
  if (branch === "") return deny2("head-unresolved", appHeadWhy2(dir));
  if (cr.bases.length > 1) return deny2("base-unresolved", appManyBasesWhy2(dir, cr.bases));
  const base = cr.bases[0] ?? null;
  const repo = appRepoFor2(cmd, deps, dir, place, { sub: "open-pr", branch, ...base === null ? {} : { base } });
  if ("action" in repo) return repo;
  const r = deps.git(dir, ["rev-parse", `${branch}^{commit}`]);
  if (r.status !== 0) return deny2("head-unresolved", appHeadReadWhy2(dir, branch));
  const head = r.stdout.trim();
  const d = decisionRead2({ step: "open-pr", key: openPrKey4({ repo: repo.key, branch, base }), head });
  return d && isOpenPrLabel2(d.label) ? ALLOW2 : deny2("open-pr", appOpenPrWhy2(deps, dir, repo, branch, head, base));
}
function judgeAppMerge2(shape, deps, dir, cmd) {
  return homeRead2(inApp2(deps, () => appMerge2(shape, deps, dir, cmd)));
}
function appMerge2(shape, deps, dir, cmd) {
  return coveredCall2(deps, dir, (place) => appMergeIn2(shape, deps, dir, cmd, place));
}
function appMergeIn2(shape, deps, dir, cmd, place) {
  if (shape.pr === null) return deny2("no-pr", appNoPrWhy2(dir));
  const repo = appRepoFor2(cmd, deps, dir, place, { sub: "merge", pr: shape.pr });
  if ("action" in repo) return repo;
  if (shape.shaBad) return deny2("merge-no-head", `PR #${prose2(shape.pr)} (folder ${at2(dir)}): ${HEAD_UNREAD_WHY2(shape.pr)}`);
  const sha = shape.sha ?? null;
  if (!sha) return deny2("merge-no-head", appMergeNoHeadWhy2(deps, dir, shape.pr, repo.offer));
  const key = decisionKey2({ repo: repo.key, pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isMergeNowLabel2(r.label) && r.head.toLowerCase() === sha);
  return ok ? ALLOW2 : deny2("land", appMergeWhy2(deps, dir, repo, shape.pr));
}
function resolveDir2(base, value, shell) {
  const raw = value.includes("\\") ? unquotePath2(value, shell) : value;
  if (hasUnexpandedPart2(value)) return UNEXPANDED2 + raw;
  const t = shell === "bash" ? gitBashPath2(raw) : raw;
  if (absoluteText2(t)) return t;
  return isUnexpanded2(base) ? base : resolve5(base, t);
}
function dirsAfter2(cwd, cds, shell, loose, dir = null) {
  const dirs = cds.length === 0 ? [cwd] : [...loose ? [cwd] : [], ...cds.map((_, i) => pushDir2(cwd, cds.slice(0, i + 1), shell))];
  return [...new Set(dirs.map((d) => dir === null ? d : resolveDir2(d, dir, shell)))];
}
var pushDirsOf2 = (p, cwd, shell) => dirsAfter2(cwd, p.cds, shell, p.loose, p.dir);
var POSITION_WHY2 = "popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.";
function judgeAt2(s, deps, cwd, shell, named) {
  const at3 = s.at;
  const cmd = cmdRepoOf2(s, named, deps.env);
  const dirs = dirsAfter2(cwd, at3.cds, shell, at3.loose);
  const lost = dirs.find(isUnexpanded2);
  if (lost !== void 0 && s.kind !== "land") return [unexpandedDeny2(deps, [cwd, ...dirs], lost, "other", "other")];
  if (at3.unknown && s.kind !== "land") {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = cmd.named === CCV3_REPO || all.some((d) => isCcv3Checkout2(deps, d));
    return ccv3 ? [deny2("position-unknown", POSITION_WHY2)] : appPositionAt2(deps, all, "other", s.kind === "create" ? { sub: "open-pr" } : { sub: "merge", pr: s.pr ?? "<pr>" });
  }
  return dirs.map((d) => s.kind === "create" ? judgeCreate2(s, deps, d, cmd) : judgeLand2(s, deps, d, cmd));
}
function unexpandedDeny2(deps, dirs, lost, scope, appScope, soft = true) {
  const dir = firstCovered2(deps, knownDirs2(dirs, deps.home));
  if (dir === null) return deny2("cd-unexpanded", unexpandedWhy2(lost), scope);
  const d = { ...deny2("cd-unexpanded", unexpandedWhy2(lost) + inAppFolder2(dir), appScope), homeFlags: true };
  return soft ? { ...d, tapPath: true } : d;
}
var softPush2 = (p, subagent) => !subagent && !p.force && !p.unsafeOpt && !p.repoOpt && !p.oBundle && p.widerOpt === null;
function appPositionAt2(deps, dirs, scope, offer) {
  let notice = null;
  for (const dir of dirs) {
    const place = appPlace2(deps, dir);
    if (place.covered) return [{ ...deny2("position-unknown", inApp2(deps, () => appPositionWhy2(deps, dir, offer)), scope), homeFlags: true }];
    if (place.corrupt) return [registryCorruptDeny2(place.corrupt, dir, scope)];
    notice ??= place.notice ?? null;
  }
  return notice === null ? [] : [{ action: "allow", notice }];
}
var pushOffer2 = (p) => ({ sub: "push", remote: p.remote });
var hardUnlessUnregistered2 = (d, unregistered) => unregistered ? d : hardOf2(d);
function judgePushAt2(s, deps, cwd, shell, ctx, sink) {
  const { subagent, chained, alone } = ctx;
  const emit = (d) => {
    if (d.action === "deny") sink?.(d);
    return d;
  };
  const p = s.push;
  const dirs = pushDirsOf2(p, cwd, shell);
  const chainOnly = chainDirsOf2(p, cwd, shell).filter((d) => !dirs.includes(d) && firstCovered2(deps, [d]) !== null);
  const c4 = { ...ctx, commitDirs: dirsAfter2(cwd, p.cds, shell, p.loose, null) };
  const fromChain = [];
  for (const d of chainOnly) fromChain.push(emit(judgeAppPushAt2(s, deps, d, subagent, chained, alone, ctx.flow, c4)));
  const lost = dirs.find(isUnexpanded2);
  if (lost !== void 0) return [unexpandedDeny2(deps, [cwd, ...dirs], lost, "push", "app-push", softPush2(p, subagent))];
  const fixedByDir = p.dir !== null && resolveDir2("/a", p.dir, shell) === resolveDir2("/b", p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = all.some((d) => isCcv3Checkout2(deps, d));
    if (ccv3) return [intentDeny2(p, subagent, deny2("position-unknown", POSITION_WHY2, "push"))];
    const app = appPositionAt2(deps, all, "app-push", pushOffer2(p));
    if (app.some((d) => d.action === "deny")) return app;
  }
  const result = [...fromChain];
  for (const d of dirs) result.push(emit(judgePush2(s, deps, d, c4)));
  return result;
}
function remoteKind2(remote) {
  const r = remote.toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return "origin";
  return r === "fork" || r.includes(CCV3_REPO) ? "fork" : null;
}
var outsideHeads2 = (p) => [p.src, p.branch].some((r) => typeof r === "string" && (r.startsWith("refs/") && !r.startsWith("refs/tags/") || r.includes("*")));
var hardOf2 = (d) => ({ ...d, hard: true });
function intentDeny2(p, subagent, fallback) {
  if (subagent) return hardOf2(deny2("subagent", SUBAGENT_WHY2, "push"));
  const r = (p.remote ?? "").toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return hardOf2(deny2("push-origin", PUSH_ORIGIN_WHY2, "push"));
  if (p.force || p.unsafeOpt || p.wideOpt) return hardOf2(deny2("push-unsafe", PUSH_UNSAFE_WHY2, "push"));
  if (outsideHeads2(p)) return hardOf2(deny2("push-target-unresolved", PUSH_REFSPEC_WHY2, "push"));
  if (p.repoOpt) return hardOf2(deny2("push-target-unresolved", PUSH_REPO_OPT_WHY2, "push"));
  return fallback;
}
var SCAN_MAX_FILES2 = 2e3;
var SCAN_MAX_COMMITS2 = 200;
var SCAN_MAX_BYTES2 = 8e6;
var SCAN_READ_MS2 = 6e3;
var SCAN_RESERVE_MS2 = 1500;
var SCAN_MIN_READ_MS2 = 300;
var COMMIT_MARK2 = "c5";
var FORK_MAIN2 = "refs/remotes/fork/main";
var SPLIT_WAY_OUT2 = "Every later push of this branch reads the same commits (the range is fork/main..head). Ways out: a new branch from fork/main that does not carry those commits, or a history rewrite with Dave's yes.";
var ScanClockError2 = class extends Error {
};
function budgetedDeps2(deps) {
  if (!deps.scanLeft) return deps;
  const left = () => deps.scanLeft() - SCAN_RESERVE_MS2;
  return {
    ...deps,
    git: (cwd, args, opts) => {
      const ms = left();
      if (ms < SCAN_MIN_READ_MS2) throw new ScanClockError2("budget");
      return deps.git(cwd, args, { ...opts, timeout: Math.min(opts?.timeout ?? GIT_TIMEOUT_MS2, ms) });
    }
  };
}
function scanHoldout2(p, deps, dir, branch, chained, alone) {
  if (!deps.holdoutIds || !deps.answerKeyHits) return null;
  try {
    return scanHoldoutRead2(p, budgetedDeps2(deps), dir, branch, chained, alone);
  } catch (e) {
    if (e instanceof ScanClockError2 || errCode2(e) === "ETIMEDOUT") return clockDeny2(branch);
    return hardOf2(deny2("holdout-scan-unavailable", `this push of ${branch} cannot be checked for holdout ids: a git read failed. Run the push again from the repo.`, "push"));
  }
}
function chainedAnswerKeyPaths2(deps, dir) {
  const reads = [
    ["diff", "--name-only", "--no-renames", "-z", `${FORK_MAIN2}...HEAD`],
    ["diff", "--name-only", "--no-renames", "-z", "--cached"],
    ["diff", "--name-only", "--no-renames", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ];
  const all = /* @__PURE__ */ new Set();
  for (const args of reads) {
    const r = deps.git(dir, args);
    if (r.status !== 0) return "unreadable";
    for (const f of r.stdout.split("\0")) if (f) all.add(f);
    if (all.size > SCAN_MAX_FILES2) return "too-large";
  }
  return deps.answerKeyHits([...all]).length > 0 ? "hit" : "none";
}
var headName2 = (ref) => ref.replace(/^(?:refs\/)?heads\//, "");
function sendsRe2(p, deps, dir, branch) {
  if (headName2(branch).startsWith("re/")) return true;
  if (p.src === null && p.branch === null) return false;
  const src = headName2(p.src ?? "HEAD");
  if (src.startsWith("re/")) return true;
  return /^(?:HEAD|@)(?:$|[~^@])/.test(src) && currentBranch2(deps, dir).startsWith("re/");
}
var RE_NOT_ALONE_WHY2 = "the push output goes to a pipe or a redirect, or another step runs in the same command, so this gate does not scan this form. Run the push with no pipe and no redirect, as its own command: git push <remote> <branch>.";
function namedTags2(p, deps, dir) {
  const out4 = /* @__PURE__ */ new Set();
  for (const r of [p.src, p.branch]) {
    if (typeof r !== "string" || r === "") continue;
    if (r.startsWith("refs/tags/")) {
      out4.add(r);
      continue;
    }
    if (r.startsWith("refs/") || /^(?:HEAD|@)(?:$|[~^@])/.test(r)) continue;
    if (r.startsWith("tags/")) {
      out4.add(`refs/${r}`);
      continue;
    }
    if (deps.git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${r}`]).status === 0) out4.add(`refs/tags/${r}`);
  }
  return [...out4];
}
function tagText2(wide, sha, deps, dir, stop) {
  const fmt = "--format=%(refname)%00%(objecttype)%00%(contents)%00";
  const reads = [wide ? ["for-each-ref", fmt, "refs/tags"] : ["for-each-ref", fmt, "--merged", sha, "refs/tags"]];
  let text = "";
  for (const args of reads) {
    let t;
    try {
      t = deps.git(dir, args, { timeout: GIT_TIMEOUT_MS2, maxBuffer: SCAN_MAX_BYTES2 + 1 });
    } catch (e) {
      if (errCode2(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its local tags are over ${SCAN_MAX_BYTES2} bytes. ${SPLIT_WAY_OUT2}`);
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
var clockDeny2 = (branch) => hardOf2(deny2("holdout-scan-unavailable", `this push of ${branch} cannot be checked: the time of the hook ran out before its reads could run. Run the push again when the machine is less busy.`, "push"));
var SHIP_RESERVE_MS2 = 1500;
var errCode2 = (e) => String(e?.code ?? "");
function addedText2(log) {
  const out4 = [];
  let inDiff = false;
  let binary = false;
  let width = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK2)) {
      inDiff = false;
      width = 0;
      out4.push(line);
      continue;
    }
    if (line.startsWith("diff --")) {
      inDiff = true;
      width = 0;
      out4.push(line);
      continue;
    }
    const at3 = inDiff ? /^(@{2,}) /.exec(line) : null;
    if (at3) {
      width = at3[1].length - 1;
      continue;
    }
    if (inDiff && width === 0 && /^Binary files (?:.* )?differ$/.test(line)) binary = true;
    if (width === 0) {
      out4.push(line);
      continue;
    }
    if (line.slice(0, width) === "+".repeat(width)) out4.push(line);
  }
  return { text: out4.join("\n"), binary };
}
function scanHoldoutRead2(p, deps, dir, branch, chainedCommit, alone) {
  const isRe = sendsRe2(p, deps, dir, branch);
  const chained = chainedCommit || !alone;
  const stop = (pattern, why) => hardOf2(deny2(pattern, `this push of ${branch} cannot be checked for holdout ids: ${why}`, "push"));
  if (isRe && chainedCommit) return stop("holdout-scan-unavailable", "the same command also commits or changes the branch, so the new content cannot be read yet. Commit first, then push in a separate command.");
  if (isRe && chained) return stop("holdout-scan-unavailable", RE_NOT_ALONE_WHY2);
  if (!isRe && chained) {
    const hit = chainedAnswerKeyPaths2(deps, dir);
    if (hit === "unreadable") return stop("holdout-scan-unavailable", "the same command also changes files, and the paths it can change could not be read. Commit first, push in a separate command.");
    if (hit === "too-large") return stop("holdout-scan-too-large", `the same command also changes more than ${SCAN_MAX_FILES2} files. Commit first, push in a separate command.`);
    if (hit === "hit") return stop("holdout-chained-answer-key", "the same command also changes an answer-key path, so the new content cannot be read yet. Commit first, push in a separate command.");
  }
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return stop("holdout-scan-unavailable", "its source ref starts with a dash. Name the branch: git push <remote> <branch>.");
  const sha = deps.git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const named = namedTags2(p, deps, dir);
  const scanned = isRe || named.length > 0 || p.force;
  const allTags = scanned && p.force ? ["--tags"] : [];
  if (sha.status !== 0 || sha.stdout.trim() === "") return scanned ? stop("holdout-scan-unavailable", "its head could not be read. Run the push again from the repo.") : null;
  const head = sha.stdout.trim();
  const range = `${FORK_MAIN2}..${head}`;
  let names;
  try {
    names = deps.git(dir, ["log", "--cc", "--root", "--name-only", "--no-renames", "-z", "--format=%x01c5%x00%H", ...allTags, range], { timeout: GIT_TIMEOUT_MS2, maxBuffer: SCAN_MAX_BYTES2 + 1 });
  } catch (e) {
    if (errCode2(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its commit list is over ${SCAN_MAX_BYTES2} bytes. ${SPLIT_WAY_OUT2}`);
    throw e;
  }
  if (names.status !== 0) return stop("holdout-scan-unavailable", "the commits against fork/main could not be read. Run git fetch fork main in the repo, then push again.");
  const tokens = names.stdout.split("\0").map((t) => t.replace(/^\n+/, ""));
  const commits = tokens.filter((t) => t === COMMIT_MARK2).length;
  const files = tokens.filter((t, i) => t !== "" && t !== COMMIT_MARK2 && tokens[i - 1] !== COMMIT_MARK2);
  if (!scanned && deps.answerKeyHits(files).length === 0) return null;
  if (commits > SCAN_MAX_COMMITS2) return stop("holdout-scan-too-large", `it sends ${commits} commits, over the bound of ${SCAN_MAX_COMMITS2}. ${SPLIT_WAY_OUT2}`);
  if (new Set(files).size > SCAN_MAX_FILES2) return stop("holdout-scan-too-large", `it changes ${new Set(files).size} files, over the bound of ${SCAN_MAX_FILES2}. ${SPLIT_WAY_OUT2}`);
  let ids;
  try {
    ids = deps.holdoutIds(dir);
  } catch {
    return stop("holdout-scan-unavailable", "the holdout id list could not be read, so the scan cannot run.");
  }
  if (!Array.isArray(ids) || ids.length === 0) return stop("holdout-scan-unavailable", "the holdout id list is empty, so the scan cannot run.");
  let log;
  try {
    log = deps.git(dir, ["log", "-p", "--cc", "--root", "--encoding=UTF-8", "--text", "--no-textconv", "--no-ext-diff", "--unified=0", "--no-color", "--no-renames", "--format=%x01c5 %H%n%w(0,1,1)%B", ...allTags, range], { timeout: SCAN_READ_MS2, maxBuffer: SCAN_MAX_BYTES2 + 1 });
  } catch (e) {
    if (errCode2(e) === "ENOBUFS") return stop("holdout-scan-too-large", `its commit content is over ${SCAN_MAX_BYTES2} bytes. ${SPLIT_WAY_OUT2}`);
    throw e;
  }
  if (log.status !== 0) return stop("holdout-scan-unavailable", "the commit content could not be read. Run the push again from the repo.");
  const tags = tagText2(p.force, head, deps, dir, stop);
  if (typeof tags !== "string") return tags;
  const added = addedText2(log.stdout);
  if (added.binary) return stop("holdout-scan-unavailable", `it sends a binary file that git prints only as "Binary files differ" (a merge resolution), so its content cannot be read. ${SPLIT_WAY_OUT2}`);
  const all = `${added.text}
${files.join("\n")}
${tags}
${named.join("\n")}
${p.branch ?? ""}`;
  const count = countIdsIn2(`${all}
${all.replace(/\0/g, "")}`, ids);
  if (count === 0) return null;
  return hardOf2(deny2("holdout-id", `this push of ${branch} carries ${count} holdout id${count === 1 ? "" : "s"} in the added lines, commit messages, file names or tag messages of what it sends (an older commit of the branch counts too). Remove them from every commit and local tag. ${SPLIT_WAY_OUT2} Which ones stays with the seat: this text names a count only.`, "push"));
}
function judgePush2(shape, deps, dir, ctx) {
  const { subagent, chained, alone } = ctx;
  const p = shape.push;
  const d = (pattern, why) => deny2(pattern, why, "push");
  if (p.moved) {
    const what = "--git-dir or --work-tree moves the repo, so the checkout is unknown";
    const app = firstCovered2(deps, moveTargets2(ctx.text, dir, ctx.shell, deps.home)) ?? coveredAmong2(deps, [dir]);
    if (app !== null) return deny2("push-target-unresolved", appPushUnresolvedWhy2(app, what), "app-push");
    return intentDeny2(p, subagent, hardUnlessUnregistered2(d("push-target-unresolved", pushUnresolvedWhy2(what)), ctx.unregistered));
  }
  if (!isCcv3Checkout2(deps, dir)) return judgeAppPushAt2(shape, deps, dir, subagent, chained, alone, ctx.flow, ctx);
  if (p.repoOpt) return hardOf2(subagent ? d("subagent", SUBAGENT_WHY2) : d("push-target-unresolved", PUSH_REPO_OPT_WHY2));
  let remote = p.remote;
  if (remote === null) {
    const up = deps.git(dir, ["rev-parse", "--abbrev-ref", "@{push}"]);
    remote = up.status === 0 && up.stdout.trim() !== "" ? up.stdout.trim().split("/")[0] : "fork";
  }
  let kind = remoteKind2(remote);
  if (kind === null) {
    const u = deps.git(dir, ["remote", "get-url", remote]);
    if (u.status === 0) kind = remoteKind2(u.stdout.trim());
  }
  if (kind === "origin") return hardOf2(d("push-origin", PUSH_ORIGIN_WHY2));
  if (kind === null) return ALLOW2;
  if (subagent) return hardOf2(d("subagent", SUBAGENT_WHY2));
  if (p.wideOpt || p.unsafeOpt && !p.force) return hardOf2(d("push-unsafe", PUSH_UNSAFE_WHY2));
  if (outsideHeads2(p)) return hardOf2(d("push-target-unresolved", PUSH_REFSPEC_WHY2));
  if (!ctx.modelled) return hardOf2(d("push-state-unknown", PUSH_STATE_WHY2));
  const branch = p.branch ?? currentBranch2(deps, dir);
  if (p.force && (branch === "main" || branch === "")) return hardOf2(d("push-unsafe", PUSH_UNSAFE_WHY2));
  if (branch !== "") {
    const scanned = scanHoldout2(p, deps, dir, branch, chained, alone);
    if (scanned !== null) return scanned;
  }
  if (p.force) return d("push-unsafe", PUSH_UNSAFE_WHY2);
  if (branch === "") return d("push-target-unresolved", pushUnresolvedWhy2("the branch of this push cannot be named (detached HEAD?)"));
  if (branch === "main") return ALLOW2;
  if (deps.scanLeft && deps.scanLeft() < SHIP_RESERVE_MS2) return clockDeny2(branch);
  const texts = {
    notRef: (ref) => pushUnresolvedWhy2(`${ref} is not a ref`),
    tree: (what) => `cannot read the tree of ${what} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`,
    ship: () => pushWhy2(branch)
  };
  return shipTap2({ p, deps, dir, chained, alone, key: decisionKey2({ branch }), scope: "push", texts, commitDirs: ctx.commitDirs });
}
function currentBranch2(deps, dir) {
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
function shipTap2({ p, deps, dir, chained, alone, key, scope, texts, pushOnlyHead, commitDirs }) {
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return deny2("push-target-unresolved", texts.notRef(ref), scope);
  if (chained && p.dir !== null && !sameCheckout2(deps, commitDirs ?? [], dir)) return deny2("push-tree-unresolved", PUSH_CHECKOUT_WHY2, scope);
  const viaIndex = chained && (p.src === null || deps.git(dir, ["branch", "--show-current"]).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ["write-tree"]) : deps.git(dir, ["rev-parse", `${ref}^{tree}`]);
  if (r.status !== 0) return deny2("push-tree-unresolved", texts.tree(viaIndex ? "the index (git write-tree)" : ref), scope);
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
  const ok = decisionRows(deps.env).some((row) => row.step === "ship" && row.key === key && row.tree !== null && row.tree === tree && (isShipLabel2(row.label) || !viaIndex && alone && isPushOnlyLabel2(row.label) && pushOnly(row.head)));
  return ok ? ALLOW2 : deny2("ship", texts.ship(), scope);
}
function judgeAppPushAt2(shape, deps, dir, subagent, chained, alone, flow, ctx) {
  const place = appPlace2(deps, dir);
  if (!place.covered) return passOf2(place, dir, "app-push");
  try {
    return inApp2(deps, () => judgeAppPush2(shape, deps, dir, place, subagent, chained, alone, flow, ctx));
  } catch (err) {
    throw new AppScopeError2(err);
  }
}
var FIXED_DEFAULTS2 = /* @__PURE__ */ new Set(["main", "master"]);
var destBranch2 = (dest) => dest.replace(/^refs\//, "").replace(/^heads\//, "");
function remoteHeadOf2(deps, dir, remote) {
  const r = deps.git(dir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  const text = r.status === 0 ? r.stdout.trim() : "";
  if (text === "") return void 0;
  const prefix = `${remote}/`;
  const hit = [text, text.replace(/^remotes\//, ""), text.replace(/^refs\/remotes\//, "")].find((s) => s.startsWith(prefix));
  return hit === void 0 ? null : hit.slice(prefix.length);
}
var DEFAULT_RISK2 = { kind: "default" };
var UNSURE_RISK2 = { kind: "unsure" };
function pushRisk2(deps, dir, p, k, id, config) {
  const dest = destBranch2(k.branch);
  if (FIXED_DEFAULTS2.has(dest.toLowerCase())) return DEFAULT_RISK2;
  if (!p.plain || config.kind !== "none" || !k.configured || !strictBranch2(dest) || !remoteNamesOf2(deps, dir).includes(k.remote)) return UNSURE_RISK2;
  if (deps.git(dir, ["show-ref", "--verify", "--quiet", `refs/tags/${dest}`]).status !== 1) return UNSURE_RISK2;
  return headRisk2(deps, dir, k, dest, id);
}
var remoteNamesOf2 = (deps, dir) => deps.git(dir, ["remote"]).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
function headRisk2(deps, dir, k, dest, id) {
  const url = fetchUrlOf2(deps, dir, k.remote);
  if (url === null || keyRepo4({ url, ...id }) !== k.key) return UNSURE_RISK2;
  const head = remoteHeadOf2(deps, dir, k.remote);
  if (head === void 0 || head === null) return { kind: "no-head", remote: k.remote };
  return head.toLowerCase() === dest.toLowerCase() ? DEFAULT_RISK2 : null;
}
function fetchUrlOf2(deps, dir, remote) {
  const r = deps.git(dir, ["remote", "get-url", remote]);
  const url = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
  return url === "" ? null : url;
}
var PUSH_CONFIG_RE2 = "^(push\\.(default|followtags|recursesubmodules)|submodule\\.recurse|remote\\..*\\.(push|mirror))$";
var FALSE_WORDS2 = /* @__PURE__ */ new Set(["false", "no", "off", "0"]);
var RANK2 = { none: 0, widens: 1, wider: 2, unsafe: 3 };
function pushConfigOf2(deps, dir, remote, p) {
  const r = deps.git(dir, ["config", "--get-regexp", PUSH_CONFIG_RE2]);
  if (r.status === 1 && r.stdout.trim() === "") return { kind: "none", key: "" };
  if (r.status !== 0) return { kind: "widens", key: "" };
  let found = { kind: "none", key: "" };
  for (const line of r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line.trim() : line.slice(0, sp);
    const raw = sp < 0 ? "" : line.slice(sp + 1).trim();
    const kind = configKind2(key, raw, remote, p);
    if (RANK2[kind] > RANK2[found.kind]) found = { kind, key };
  }
  return found;
}
function configKind2(key, raw, remote, p) {
  const value = raw.toLowerCase();
  const on = !FALSE_WORDS2.has(value);
  if (key === `remote.${remote}.mirror`) return on ? "unsafe" : "none";
  if (key === `remote.${remote}.push`) return raw.startsWith("+") ? "unsafe" : p.oneSide ? "wider" : "widens";
  if (key === "push.default") return value === "matching" && p.bare ? "wider" : "none";
  if (key === "push.recursesubmodules") return on && value !== "check" && !p.noRecurse ? "wider" : "none";
  if (key === "submodule.recurse") return on && !p.noRecurse ? "wider" : "none";
  if (key === "push.followtags") return on && !p.noFollowTags ? "wider" : "none";
  return "none";
}
function judgeAppPush2(shape, deps, dir, place, subagent, chained, alone, flow, ctx) {
  const p = shape.push;
  const d = (pattern, why) => deny2(pattern, why, "app-push");
  if (subagent) return d("subagent", appSubagentWhy2(dir));
  if (p.force || p.unsafeOpt) return d("push-unsafe", appUnsafeWhy2(dir));
  if (p.repoOpt) return d("push-target-unresolved", appRepoOptWhy2(dir));
  if (p.oBundle) return d("push-target-unresolved", appBundleWhy2(dir));
  if (p.widerOpt !== null) return d("push-target-unresolved", appWiderOptWhy2(dir, p.widerOpt));
  const named = p.branch === "@" ? null : p.branch;
  const branch = named ?? (p.bare ? null : currentBranch2(deps, dir));
  const k = pushKey4(gitIn2(deps, dir), { remote: p.remote, branch, entryKey: place.entryKey, github: place.github });
  if (!k.ok && k.why === "multi-pushurl") return d("push-urls", appPushUrlsWhy2(dir, k.remote ?? "", k.keys ?? []));
  if (!k.ok && k.why === "no-branch") return d("push-target-unresolved", appPushUnresolvedWhy2(dir, "the branch of this push cannot be named (detached HEAD?)"));
  if (!k.ok) return d("push-remote-unresolved", appNameRemoteWhy2(deps, dir));
  if (p.src?.startsWith("-")) return d("push-target-unresolved", appPushUnresolvedWhy2(dir, `${p.src} is not a ref`));
  const config = pushConfigOf2(deps, dir, k.remote, p);
  if (config.kind === "unsafe") return d("push-unsafe", appUnsafeConfigWhy2(dir, k.remote, config.key));
  if (config.kind === "wider") return d("push-target-unresolved", appWiderConfigWhy2(dir, config.key));
  const risk = pushRisk2(deps, dir, p, k, { entryKey: place.entryKey, github: place.github }, config);
  if (risk === null) return ALLOW2;
  const offer = { sub: "push", remote: k.remote, branch: k.branch, src: p.src === null || p.src === "@" ? "HEAD" : p.src };
  const texts = {
    notRef: (ref) => appPushUnresolvedWhy2(dir, `${ref} is not a ref`),
    tree: (what) => appTreeWhy2(dir, what),
    // Seat ruling a: no Push only tap counts for a push that is not alone and has no commit before it, so the text names the way out.
    // The Commit and push flow (git add, git commit, then the push: flow) keeps the ship text: its tap is the way out.
    ship: () => alone || chained || flow ? appPushWhy2(deps, dir, k.key, k.branch, offer, risk) : appNotAloneWhy2(deps, dir, offer)
  };
  const q = p.src === "@" ? { ...p, src: null } : p;
  if (ctx !== void 0 && !ctx.modelled) return { ...d("push-state-unknown", `${PUSH_STATE_WHY2} (folder ${at2(dir)})`), tapPath: true };
  const r = shipTap2({ p: q, deps, dir, chained, alone, key: decisionKey2({ repo: k.key, branch: k.branch }), scope: "app-push", texts, pushOnlyHead: true, commitDirs: ctx?.commitDirs });
  return r.action === "deny" ? { ...r, tapPath: true } : r;
}
var MOVE_ENV_MASKED2 = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW2 = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS2 = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY2 = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function movesRepo2(text) {
  return MOVE_ENV_RAW2.test(text) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED2.test(maskQuoted2(text, tool))) || CD_ALIAS2.test(squashQuotes(text));
}
function judgeCommand2(input, deps, notes, denies = []) {
  const cmd = readCommand2(input);
  if (cmd.kind !== "command" || cmd.text === "") return denies;
  const cwd = input.cwd || process.cwd();
  if (storeWriteCall2(input, deps)) denies.push(deny2("store-write", STORE_WHY2));
  if (paidTripwire2(input)) denies.push(deny2("paid-coderabbit", PAID_WHY2));
  if (capOverrideDeny2(input, deps)) denies.push(deny2("cap-override", CAP_WHY2));
  for (const d of [...scriptRunnerDenies2(deps.parsed), ...scriptRunnerLateDenies2(deps.parseLate)]) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  for (const d of parseErrorDenies2(deps.parsed)) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  for (const d of parserUnavailableDenies(deps.parsed, cmd.text, !deps.parsed && coveredAmong2(deps, [cwd]) !== null)) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  const shapes = shapesOf2(cmd.text, cmd.tool, deps.parsed);
  const shell = shellOf2(input);
  if (input.agent_id && shapes.some((s) => s.kind !== "push")) denies.push(subagentDeny2(shapes, deps, cwd, shell));
  const pushes = shapes.filter((s) => s.kind === "push");
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== "push");
  const add = (d) => {
    if (!denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope && o.tapPath === d.tapPath)) denies.push(d);
  };
  if (pushes.length > 0 || rest.length > 0) {
    const named = namedRepo(cmd.text, deps.env);
    const prefix = pushes.length > 0 ? pushPrefix2(cmd.text, shell) : null;
    const chained = pushes.length > 0 && (commitPrecedesPush2(cmd.text, shell) || prefix !== null && commitPrecedesPush2(prefix.prefix, shell));
    const alone = pushes.length > 0 && pushesAlone2(cmd.text, shell);
    let lookupDirs;
    const lookupBudget = { left: MAX_LOOKUP_CALLS2 };
    const remoteIsLocal = (name) => remoteNameIsLocal2(deps, cwd, lookupDirs ??= rawDirs2(cmd.text, cmd.tool, cwd, shell, deps.home), name, lookupBudget);
    const modelled = pushes.length === 0 || stateModelled2(cmd.text, shell, { parsed: deps.parsed, remoteIsLocal });
    const moved = movesRepo2(cmd.text);
    const unregistered = (moved || pushes.some((s) => s.push.moved)) && pushFoldersUnregistered2(input, deps);
    for (const s of [...rest, ...pushes]) {
      if (moved && s.kind !== "land") {
        denies.push(movedDeny2(s, deps, cwd, shell, cmd.text, Boolean(input.agent_id), unregistered));
        continue;
      }
      const found = s.kind === "push" ? judgePushAt2(s, deps, cwd, shell, { subagent: Boolean(input.agent_id), chained, alone, flow: pushes.length > 0 && shipFlow2(cmd.text, shell), text: cmd.text, shell, modelled, unregistered }, add) : judgeAt2(s, deps, cwd, shell, named);
      for (const d of found) {
        if (d.action === "deny") add(d);
        else if (d.notice) notes.add(d.notice);
      }
    }
  }
  for (const d of rawPushDenies2(cmd.text, cmd.tool, deps, cwd, shell, Boolean(input.agent_id))) add(d);
  for (const d of hiddenGhDenies2(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  for (const d of ghFlagFirstDenies2(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  for (const d of notInertDenies(deps.parsed, shapes.length > 0)) if (!denies.some((o) => o.pattern === d.pattern)) denies.push(d);
  return denies;
}
function subagentDeny2(shapes, deps, cwd, shell) {
  const base = deny2("subagent", SUBAGENT_WHY2);
  const covered = shapes.some((s) => s.kind !== "push" && coveredAmong2(deps, (s.at ? dirsAfter2(cwd, s.at.cds, shell, s.at.loose) : [cwd]).filter((d) => !isUnexpanded2(d))) !== null);
  return covered ? { ...base, homeFlags: true } : base;
}
function paidTripwire2(input) {
  const cmd = readShellCommand2(input);
  return cmd.kind === "command" && PAID_MENTION_RE2.test(cmd.text) && PAID_FLAG_RE2.test(cmd.text);
}
function capSpelling2(part) {
  if (part === "extra") return "--cli-extra-run";
  const usd = /^usd=([0-9]+(?:\.[0-9]{1,2})?)$/.exec(part)?.[1];
  return usd === void 0 ? null : `--cli-cap-usd ${usd}`;
}
function withoutApproved2(text, flagSet) {
  let rest = text;
  for (const part of flagSet.split(",")) {
    const spelling = capSpelling2(part);
    if (spelling === null) return null;
    const re = new RegExp(`(?<=^|[\\s"';()|&])${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"';)|&])`, "g");
    if (!re.test(rest)) return null;
    rest = rest.replace(re, " ");
  }
  return rest;
}
function capOverrideDeny2(input, deps) {
  try {
    const cmd = readShellCommand2(input);
    if (cmd.kind !== "command" || !CAP_FLAG_RE2.test(cmd.text)) return false;
    if (input.agent_id) return true;
    const cwd = input.cwd || process.cwd();
    const branch = deps.git(cwd, ["branch", "--show-current"]);
    const head = deps.git(cwd, ["rev-parse", "HEAD"]);
    const name = branch.status === 0 ? branch.stdout.trim() : "";
    const sha = head.status === 0 ? head.stdout.trim().toLowerCase() : "";
    if (name === "" || !/^[0-9a-f]{40}$/.test(sha)) return true;
    const prefix = `${decisionKey2({ branch: name })}${CAP_KEY_MARK2}`;
    return !decisionRows(deps.env).some((r) => {
      if (r.step !== "cli-skip" || r.head.toLowerCase() !== sha || !r.key.startsWith(prefix) || !CAP_LIFT_RE2.test(r.label)) return false;
      const rest = withoutApproved2(cmd.text, r.key.slice(prefix.length));
      return rest !== null && !CAP_FLAG_RE2.test(rest);
    });
  } catch {
    return true;
  }
}
function storeWriteCall2(input, deps) {
  try {
    const cmd = readShellCommand2(input);
    return cmd.kind === "command" && cmd.text !== "" && writesStoreText2(cmd.text, deps);
  } catch {
    return false;
  }
}
function movedDeny2(s, deps, cwd, shell, text, subagent = false, unregistered = false) {
  const dirs = s.kind === "push" ? pushDirsOf2(s.push, cwd, shell) : dirsAfter2(cwd, s.at.cds, shell, s.at.loose);
  const targets = s.kind === "push" ? [...new Set([cwd, ...dirs].flatMap((d) => isUnexpanded2(d) ? [] : moveTargets2(text, d, shell, deps.home)))] : [];
  const dir = firstCovered2(deps, targets) ?? coveredAmong2(deps, [cwd, ...dirs].filter((d) => !isUnexpanded2(d)));
  if (s.kind === "push") {
    return dir === null ? intentDeny2(s.push, subagent, hardUnlessUnregistered2(deny2("push-target-unresolved", pushUnresolvedWhy2(MOVED_WHY2), "push"), unregistered)) : deny2("push-target-unresolved", MOVED_WHY2 + inAppFolder2(dir), "app-push");
  }
  return dir === null ? deny2("repo-moved", MOVED_WHY2) : { ...deny2("repo-moved", MOVED_WHY2 + inAppFolder2(dir)), homeFlags: true };
}
function judgeWrite2(input, deps) {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS2.some((f) => typeof args[f] === "string" && isStorePath2(args[f], deps, cwd));
  return hit ? [deny2("store-write", STORE_WHY2)] : [];
}
function judge2(input, deps, notes, sink) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS2.has(tool)) {
    sink.push(...judgeWrite2(input, deps));
    return sink;
  }
  return COMMAND_TOOLS4.has(tool) ? judgeCommand2(input, deps, notes, sink) : sink;
}
function decide2(input, deps, found = []) {
  const d = decideHead(input, deps, found);
  return d.action === "deny" || deps.floor === void 0 ? d : withFloor(d, input, deps);
}
function withFloor(d, input, deps) {
  const f = deps.floor;
  let why = f.failed;
  if (why === void 0 && f.deps !== void 0) {
    try {
      const fd = (deps.floorImpl ?? FLOOR_IMPL).decide(input, f.deps);
      if (fd.action === "deny") return fd;
      if (fd.warn !== void 0 && d.action === "allow" && d.warn === void 0) return { ...d, warn: fd.warn, scope: fd.scope };
      return d;
    } catch (err) {
      why = String(err?.message ?? err).slice(0, 160);
    }
  }
  try {
    logGuardError(HOOK2, new Error(`main-floor failed: ${why ?? "no floor deps"}`));
  } catch {
  }
  let gated = true;
  try {
    gated = gatedScopesSafe(input, false, deps.parsed).size > 0 || storeWriteCall2(input, deps);
  } catch {
  }
  if (!gated) return d;
  return { action: "deny", pattern: "main-floor-error", scope: "other", reason: "BLOCKED (decision-gate): the check that holds the rules of main could not run on this call, so it is not allowed. Run the command again. If it keeps failing, ask Dave." };
}
function decideHead(input, deps, found = []) {
  const notes = /* @__PURE__ */ new Set();
  const call = perCall2(deps);
  CWDS2.set(call, input.cwd || process.cwd());
  const denies = judge2(input, call, notes, found);
  const notice = notes.size === 0 ? {} : { notice: [...notes][0] };
  if (denies.length === 0) return notes.size === 0 ? ALLOW2 : { action: "allow", ...notice };
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => hardAppDeny2(d) || enforcingScope2(d.scope, deps, cwd, d.homeFlags));
  if (live) {
    const { tapPath: _tap, homeFlags: _home, hard: _hard, ...shown } = live;
    return { ...shown, ...notice };
  }
  return { action: "allow", warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope, ...notice };
}
var hardAppDeny2 = (d) => d.hard === true || d.scope === "app-push" && d.tapPath !== true;
function perCall2(deps) {
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
  APP_MODE2.set(call, mode);
  return call;
}
var APP_MODE2 = /* @__PURE__ */ new WeakMap();
function inApp2(deps, run) {
  const mode = APP_MODE2.get(deps);
  if (!mode || mode.app) return run();
  mode.app = true;
  try {
    return run();
  } finally {
    mode.app = false;
  }
}
var out3 = (extra) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...extra } }).replace(CREDS_RE2, "$1");
var denyOut = (reason) => out3({ permissionDecision: "deny", permissionDecisionReason: reason });
var warnLead = (scope) => scope === "app-push" ? "this push in an app folder has no tap from Dave; it would be blocked in block mode." : `this command would be blocked when ${FLAG_OF[scope]} is true.`;
var warnOut = (text, scope = "other", tail = "") => out3({ additionalContext: `WARNING (decision-gate, warn mode): ${warnLead(scope)} ${text.replace(/^BLOCKED \(decision-gate\): /, "")}${tail}` });
function gatedScopes(input, app = false, parsed) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS2.has(tool)) return /* @__PURE__ */ new Set(["other"]);
  const shapes = catchShapes2(input, parsed);
  const scopes = new Set((shapes ?? []).map(scopeOf));
  if (app && (scopes.size > 0 || shapes === null)) scopes.add("app-push");
  return scopes;
}
function unreadableInput() {
  const note = "decision-gate: the hook input is not readable JSON, so no command shape can be judged; the call is allowed.";
  try {
    logGuardError(HOOK2, new Error("unreadable hook input"));
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
    const d = decide2(input, deps, found);
    const tail = d.notice ? `
${corruptLine(d.notice)}` : "";
    let shown = "{}";
    if (d.action === "allow" && d.warn) {
      logGuardDecision(HOOK2, input, "warn", d.warn.split(":")[0]);
      shown = warnOut(d.warn.slice(d.warn.indexOf(":") + 2), d.scope, tail);
    } else if (d.action === "deny") {
      logGuardDecision(HOOK2, input, "deny", d.pattern);
      shown = denyOut(d.reason + tail);
    } else if (d.notice) {
      shown = out3({ additionalContext: corruptLine(d.notice) });
    }
    if (d.notice) logGuardDecision(HOOK2, input, "warn", `registry-missing ${fwd2(d.notice)}: ${CORRUPT_EFFECT}`);
    return shown;
  } catch (err) {
    return unjudgeable(input, deps, err, found);
  }
}
function unjudgeable(input, deps, thrown, found = []) {
  const cwd = input.cwd || process.cwd();
  const underRoot = pushUnderLiveRoot(input, deps);
  const app = thrown instanceof AppScopeError2 || underRoot;
  const appPush = thrown instanceof AppScopeError2 && thrown.push || underRoot;
  const err = thrown instanceof AppScopeError2 ? thrown.inner : thrown;
  const gone = err instanceof MissingCwdError2;
  if (!gone) {
    try {
      logGuardError(HOOK2, err);
    } catch {
    }
  }
  const prior = found.find((d) => {
    try {
      return hardAppDeny2(d) || enforcingScope2(d.scope, deps, cwd, d.homeFlags);
    } catch {
      return d.hard === true;
    }
  }) ?? catchIntentDeny(input, deps.parsed);
  if (prior) {
    try {
      logGuardDecision(HOOK2, input, "deny", prior.pattern);
    } catch {
    }
    return denyOut(prior.reason);
  }
  const scopes = gatedScopesSafe(input, appPush, deps.parsed);
  if (storeWriteCall2(input, deps)) scopes.add("other");
  if (scopes.size === 0) return "{}";
  const raw = gone ? err.message : String(err?.message ?? err).slice(0, 160);
  const detail = app ? prose2(raw) : raw;
  const hint = gone ? "Run the command from a folder that exists." : "Run the command again. If it keeps failing, ask Dave.";
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  const holdsPush = !app && scopes.has("push") && (gone || !pushFoldersUnregistered2(input, deps));
  const live = holdsPush || app && hardAppCall(input, deps.parsed) || [...scopes].some((s) => enforcingScope2(s, deps, cwd, app));
  if (gone) logGuardDecision(HOOK2, input, live ? "deny" : "warn", "cwd-missing");
  if (holdsPush && !(app && hardAppCall(input, deps.parsed)) && ![...scopes].some((s) => enforcingScope2(s, deps, cwd, app))) {
    const again = gone ? "Run the push again from a folder that exists." : "Run the push again. If it fails again, ask Dave.";
    return denyOut(`BLOCKED (decision-gate): the push check could not run (${detail}), so this push was not judged. This is not a policy block. ${again}`);
  }
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has("other") ? "other" : scopes.has("app-push") ? "app-push" : "push");
}
var gatedScopesSafe = (input, app = false, parsed) => {
  try {
    return gatedScopes(input, app, parsed);
  } catch {
    return /* @__PURE__ */ new Set();
  }
};
function catchIntentDeny(input, parsed) {
  const shapes = catchShapes2(input, parsed);
  if (shapes === null) return null;
  const none = deny2("none", "", "push");
  for (const s of shapes) {
    if (s.kind !== "push" || s.push === void 0) continue;
    const d = intentDeny2(s.push, Boolean(input.agent_id), none);
    if (d.hard === true) return d;
  }
  return null;
}
function hardAppCall(input, parsed) {
  try {
    const cmd = readCommand2(input);
    if (cmd.kind !== "command") return false;
    const pushes = shapesOf2(cmd.text, cmd.tool, parsed).filter((s) => s.kind === "push");
    if (input.agent_id && pushes.length > 0) return true;
    if (rawVerdict2(cmd.text, cmd.tool)?.kind === "unsafe") return true;
    return pushes.some(({ push: p }) => p !== void 0 && (p.force || p.unsafeOpt || p.repoOpt || p.oBundle || p.widerOpt !== null));
  } catch {
    return Boolean(input.agent_id);
  }
}
function catchShapes2(input, parsed) {
  const cmd = readCommand2(input);
  if (cmd.kind !== "command") return [];
  try {
    return shapesOf2(cmd.text, cmd.tool, parsed);
  } catch {
    return null;
  }
}
function pushUnderLiveRoot(input, deps) {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand2(input);
    if (!scope || cmd.kind !== "command") return false;
    const pushes = catchShapes2(input, deps.parsed)?.filter((s) => s.kind === "push") ?? null;
    if (pushes?.length === 0) return false;
    const reg2 = scope.registry();
    const cwd = input.cwd || process.cwd();
    const shell = shellOf2(input);
    const paths = knownDirs2((pushes ?? []).flatMap((s) => [cwd, ...pushDirsOf2(s.push, cwd, shell), ...chainDirsOf2(s.push, cwd, shell)]).concat(cwd), deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets2(cmd.text, d, shell, deps.home))];
    return dirs.some((d) => underLiveRoot2(d, reg2, scope, { outsideCcv3: true }));
  } catch {
    return false;
  }
}
var CCV3_ENTRY_KEY2 = "continuous-claude";
function pushFoldersUnregistered2(input, deps) {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand2(input);
    if (!scope || cmd.kind !== "command") return false;
    const pushes = catchShapes2(input, deps.parsed)?.filter((s) => s.kind === "push");
    if (!pushes || pushes.length === 0) return false;
    const reg2 = scope.registry();
    if (reg2.state !== "ok") return false;
    const cwd = input.cwd || process.cwd();
    const shell = shellOf2(input);
    const raw = pushes.flatMap((s) => [cwd, ...pushDirsOf2(s.push, cwd, shell), ...chainDirsOf2(s.push, cwd, shell)]).concat(cwd);
    if (raw.some((d) => isUnexpanded2(d))) return false;
    const paths = knownDirs2(raw, deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets2(cmd.text, d, shell, deps.home))];
    if (dirs.length === 0 || dirs.some((d) => !isAbsolute4(d) || isUnexpanded2(d))) return false;
    return !dirs.some((d) => underRegistryRoot2(d, reg2, scope));
  } catch {
    return false;
  }
}
function underRegistryRoot2(d, reg2, scope) {
  const ccv3 = { ...reg2, entries: reg2.entries.filter((e) => e.key === CCV3_ENTRY_KEY2).map((e) => ({ ...e, key: `${CCV3_ENTRY_KEY2}#root`, status: "active", tapGate: null })) };
  return underLiveRoot2(d, reg2, scope) || underLiveRoot2(d, ccv3, scope);
}
function folderUnregistered2(deps, d) {
  try {
    const scope = deps.tapScope;
    if (!scope || !isAbsolute4(d) || isUnexpanded2(d)) return false;
    const reg2 = scope.registry();
    return reg2.state === "ok" && !underRegistryRoot2(d, reg2, scope);
  } catch {
    return false;
  }
}
function ccv3OrUnplaced2(deps, d) {
  try {
    return isCcv3Checkout2(deps, d);
  } catch {
    return !folderUnregistered2(deps, d);
  }
}
var MissingCwdError2 = class extends Error {
  constructor(cwd) {
    super(`the working folder does not exist: ${cwd}`);
    this.cwd = cwd;
    this.name = "MissingCwdError";
  }
  cwd;
};
var GitDeadlineError2 = class extends Error {
  constructor(args) {
    super(`the time limit of the hook (${HOOK_BUDGET_MS2 / 1e3} s) passed before git ${args[0] ?? ""} could run`);
    this.args = args;
    this.name = "GitDeadlineError";
  }
  args;
};
var HOOK_BUDGET_MS2 = 7e3;
function makeGit2(opts = {}) {
  const now = opts.now ?? Date.now;
  const spawn3 = opts.spawn ?? ((_cmd, args, o) => spawnSync2("git", args, o));
  const exists = opts.exists ?? existsSync8;
  return (cwd, args, read = {}) => {
    const own = read.timeout ?? GIT_TIMEOUT_MS2;
    const left = opts.deadline === void 0 ? own : opts.deadline - now();
    if (left <= 0) throw new GitDeadlineError2(args);
    if (!exists(cwd)) throw new MissingCwdError2(cwd);
    const r = spawn3("git", args, { cwd, encoding: "utf8", timeout: Math.min(own, left), windowsHide: true, ...read.maxBuffer ? { maxBuffer: read.maxBuffer } : {} });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function realDeps2(opts = {}) {
  const { start, ...run } = opts;
  const t0 = start ?? Date.now();
  const clock = run.now ?? Date.now;
  let registry = null;
  return {
    git: makeGit2(run),
    scanLeft: () => t0 + HOOK_BUDGET_MS2 - clock(),
    appGit: makeGit2({ ...run, deadline: t0 + HOOK_BUDGET_MS2 }),
    readFile: (p) => {
      try {
        return existsSync8(p) ? readFileSync12(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir8(),
    tapScope: { registry: () => registry ??= readRegistry2({ env: process.env }) },
    // The push scan: the ids come from the primary checkout of the folder being pushed (the dataset is git-ignored, so a worktree has none).
    holdoutIds: (dir) => loadHoldoutIds(primaryRootOf2(makeGit2(run), dir)),
    answerKeyHits: answerKeyHitsOf2,
    // The true floor starts from main's own realDeps (its git runner, its clock, its registry reader), not from this head's.
    floorBase: realDeps({ start: t0, ...run })
  };
}
function primaryRootOf2(git, dir) {
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.status !== 0 || r.stdout.trim() === "") throw new Error("no common dir");
  return resolve5(r.stdout.trim(), "..");
}
var PARSE_BUDGET_MS2 = 7e3;
var PWSH_WALKER_TIMEOUT_MS = 6e3;
var envMs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : void 0;
};
var WRAPPER_ARITY = {
  env: { value: /* @__PURE__ */ new Set(), assigns: true, noOptions: true },
  timeout: { value: /* @__PURE__ */ new Set(["-k", "-s", "--kill-after", "--signal"]), duration: true },
  nice: { value: /* @__PURE__ */ new Set(["-n", "--adjustment"]) },
  stdbuf: { value: /* @__PURE__ */ new Set(["-i", "-o", "-e"]) },
  nohup: { value: /* @__PURE__ */ new Set(), noOptions: true },
  command: { value: /* @__PURE__ */ new Set(), noOptions: true },
  builtin: { value: /* @__PURE__ */ new Set(), noOptions: true },
  exec: { value: /* @__PURE__ */ new Set(), noOptions: true }
};
var SAFE_ENV_ASSIGN = new RegExp(`^(?:${SAFE_ENV_NAMES})=`);
function unwrapCall(c) {
  const l = litOf(c.words[0]);
  const p = l === null || /[\\/]/.test(l) ? null : progName2(l);
  const a = p === null ? void 0 : WRAPPER_ARITY[p];
  if (!a) return null;
  let i = 1;
  let needDuration = a.duration === true;
  for (; i < c.words.length; i++) {
    const w = litOf(c.words[i]);
    if (w === null) return null;
    if (a.noOptions && w.startsWith("-")) return null;
    if (a.value.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    if (a.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      if (!SAFE_ENV_ASSIGN.test(w)) return null;
      continue;
    }
    if (needDuration) {
      needDuration = false;
      continue;
    }
    break;
  }
  const words = c.words.slice(i);
  return words.length === 0 ? null : { ...c, words, argsUnknown: true, viaPayload: "wrapper", depth: c.depth + 1, level: c.level + 1, nested: void 0 };
}
function expandWrappers(r) {
  if (!r) return r;
  const out4 = [];
  for (const c of r.calls) {
    let cur = c;
    let chain = [c];
    for (let guard = 0; guard < 4 && cur; guard++) {
      const inner = unwrapCall(cur);
      if (!inner) break;
      chain.push(inner);
      cur = inner;
    }
    for (let k = 0; k < chain.length; k++) out4.push(k < chain.length - 1 ? { ...chain[k], nested: { status: "parsed", via: "wrapper" } } : chain[k]);
  }
  return { ...r, calls: out4 };
}
async function withParsed2(raw, deps) {
  const [head, floor] = await Promise.all([withHeadParsed(raw, deps), withFloorParsed(raw, deps)]);
  return { ...head, floor: floor.floor };
}
async function withFloorParsed(raw, deps) {
  const { parsed: _parsed, parseLate: _late, parseOpts: _opts, floor: _floor, floorBase: _base, floorImpl: _impl, ...plain } = deps;
  void _parsed;
  void _late;
  void _opts;
  void _floor;
  void _base;
  void _impl;
  try {
    const f = await (deps.floorImpl ?? FLOOR_IMPL).withParsed(raw, deps.floorBase ?? plain);
    return { ...deps, floor: f.parseLate !== void 0 ? { failed: "the main-floor parse was late" } : { deps: f } };
  } catch (err) {
    return { ...deps, floor: { failed: String(err?.message ?? err).slice(0, 160) } };
  }
}
async function withHeadParsed(raw, deps) {
  let lateText;
  try {
    const input = JSON.parse(raw.trim() || "{}");
    if (input === null || typeof input !== "object" || Array.isArray(input)) return deps;
    const cmd = readShellCommand2(input);
    if (cmd.kind !== "command" || cmd.text === "" || !defaultEntry2(cmd.text)) return deps;
    lateText = cmd.text;
    const tool = cmd.tool;
    const dialects = tool === "Bash" ? ["bash"] : tool === "PowerShell" ? ["pwsh"] : ["bash", "pwsh"];
    const byDialect = {};
    let innerBad = false;
    const budgetMs = deps.parseBudgetMs ?? envMs(deps.env?.CCV3_PARSE_BUDGET_MS) ?? PARSE_BUDGET_MS2;
    const opts = { timeoutMs: envMs(deps.env?.CCV3_PARSE_TIMEOUT_MS) ?? PWSH_WALKER_TIMEOUT_MS, ...deps.parseOpts ?? {} };
    let timer;
    const late = new Promise((res) => {
      timer = setTimeout(() => res("late"), budgetMs);
      timer.unref?.();
    });
    const parse = (async () => {
      for (const d of dialects) byDialect[d] = await parseCalls2(cmd.text, d, opts);
      innerBad = await innerTextBad2(byDialect, opts);
      return "done";
    })();
    parse.catch(() => void 0);
    try {
      if (await Promise.race([parse, late]) === "late") {
        try {
          logGuardError(HOOK2, new Error(`the shell parse was late: no answer in ${budgetMs} ms`), { env: deps.env });
        } catch {
        }
        return { ...deps, parseLate: cmd.text };
      }
    } finally {
      clearTimeout(timer);
    }
    const byD2 = {};
    if (byDialect.bash) byD2.bash = expandWrappers(byDialect.bash);
    if (byDialect.pwsh) byD2.pwsh = expandWrappers(byDialect.pwsh);
    return { ...deps, parsed: { text: cmd.text, byDialect: byD2, ...innerBad ? { innerBad } : {} } };
  } catch (err) {
    try {
      logGuardError(HOOK2, err);
    } catch {
    }
    return lateText === void 0 ? deps : { ...deps, parseLate: lateText };
  }
}
async function main3() {
  const start = Date.now();
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  console.log(handle(raw, await withParsed2(raw, realDeps2({ start }))));
}
if (!process.env.VITEST) {
  main3().catch((err) => {
    logGuardError(HOOK2, err);
    console.error("decision-gate: stdin could not be read; the call is allowed.");
    console.log("{}");
  });
}
export {
  CARRIER_REGISTER,
  COMMAND_TOOLS4 as COMMAND_TOOLS,
  FLOOR_IMPL,
  GitDeadlineError2 as GitDeadlineError,
  LISTED_PROGRAMS,
  MissingCwdError2 as MissingCwdError,
  SCRIPT_RUNNERS2 as SCRIPT_RUNNERS,
  WRITE_TOOLS2 as WRITE_TOOLS,
  astCreates2 as astCreates,
  astMerges2 as astMerges,
  decide2 as decide,
  docAppendByAst2 as docAppendByAst,
  handle,
  isInert,
  isLandLabel2 as isLandLabel,
  isMergeNowLabel2 as isMergeNowLabel,
  isOpenPrLabel2 as isOpenPrLabel,
  isPushOnlyLabel2 as isPushOnlyLabel,
  isShipLabel2 as isShipLabel,
  isStandaloneCleanup,
  makeGit2 as makeGit,
  notInertDenies,
  parseErrorDenies2 as parseErrorDenies,
  parserUnavailableDenies,
  pushShapesOf2 as pushShapesOf,
  realDeps2 as realDeps,
  scriptRunnerDenies2 as scriptRunnerDenies,
  scriptRunnerLateDenies2 as scriptRunnerLateDenies,
  withParsed2 as withParsed
};
/*! Bundled license information:

sh-syntax/lib/processor.js:
  (* istanbul ignore if -- @preserve *)

sh-syntax/lib/index.js:
  (* istanbul ignore next -- @preserve *)
*/
