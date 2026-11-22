#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir as homedir2 } from "os";
import { basename, join as join2, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
var PATH_CHARS = 300;
var TARGET_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Agent: "subagent_type",
  Task: "subagent_type",
  Skill: "skill"
};
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, ".claude", "logs", "guard-decisions.jsonl");
}
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
var UUID_SEGMENT = /(^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/.])/gi;
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];
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
    const path2 = guardLogPath(env);
    mkdirSync(dirname(path2), { recursive: true, mode: 448 });
    appendFileSync(path2, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}
var ERROR_FIELD_CHARS = 200;
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
    const path2 = guardLogPath(env);
    mkdirSync(dirname(path2), { recursive: true, mode: 448 });
    appendFileSync(path2, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

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
    text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join2(homedir2(), ".claude", "state", "hook-trace-mode"));
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
var traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join2(homedir2(), ".claude", "cache");
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

// src/pre-pr-gate.ts
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { accessSync, appendFileSync as appendFileSync2, constants, existsSync as existsSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync4, statSync as statSync2 } from "fs";
import { dirname as dirname3, isAbsolute, join as join5, posix, resolve as resolve2, win32 } from "path";

// src/shared/gh-open-prefix.ts
var GH_OPT_PREFIX = String.raw`(?:[^\S\r\n]+[\w.\/:=@-]+){1,6}?`;

// src/pr-opened-review-loop.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join as join4 } from "path";
import { homedir as homedir3, tmpdir } from "os";

// src/shared/router-config.ts
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
var QUOTED = /"[^"]*"|'[^']*'/g;
var stripQuotes = (text) => text.replace(QUOTED, " ");
var segmentsOf = (text) => text.split(/[;&|\r\n]+/);
var countOf = (re, text) => (text.match(re) ?? []).length;
var plainPart = (segment) => segment.split(/#|<|>|\$\(|`/)[0];
var quoteDoubt = (raw) => /\\["']|`["']/.test(raw) || countOf(/["']/g, stripQuotes(raw)) % 2 === 1;
function uncovered(raw, re, ok) {
  const total = countOf(re, squashQuotes(raw));
  if (total === 0) return false;
  if (quoteDoubt(raw)) return true;
  const covered = segmentsOf(stripQuotes(raw)).map(plainPart).filter(ok).reduce((n, s) => n + countOf(re, s), 0);
  return total > covered;
}
var CLI_CREATE = /\bgh\s+pr\s+create\b/gi;
var GH_API = /\bgh\s+api\b/gi;
var CLI_DRAFT = /(?:^|\s)(?:--draft|-d)(?=\s|$)/;
var API_DRAFT = /(?:^|\s)(?:-F|-f|--field|--raw-field)(?:=|\s+)draft=true(?=\s|$)/;
var DRAFT_FALSE = /\bdraft=false\b/i;
var apiCreateUncovered = (raw) => segmentsOf(raw).some((s) => /\bgh\s+api\b/i.test(s) && isPrOpenText(s) && !API_DRAFT.test(plainPart(stripQuotes(s))));
function isNonDraftCreate(raw) {
  if (DRAFT_FALSE.test(raw)) return true;
  if (!/\bgh\s+pr\s+create\b/i.test(squashQuotes(raw))) return uncovered(raw, GH_API, (s) => API_DRAFT.test(s));
  return uncovered(raw, CLI_CREATE, (s) => CLI_DRAFT.test(s)) || apiCreateUncovered(raw);
}
var READY_CLI = /\bgh\s+pr\s+ready\b/gi;
var READY_GRAPHQL = /markPullRequestReadyForReview/i;
var READY_BRACE = /\bgh\s+pr\s+\S*[{}]/i;
var UNDO = /(?:^|\s)--undo(?=\s|$)/;
function isReadyShape(raw) {
  return READY_GRAPHQL.test(raw) || READY_BRACE.test(raw) || uncovered(raw, READY_CLI, (s) => UNDO.test(s));
}
var WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
var ADD_LABEL = new RegExp(String.raw`(?:^|\s)--add-label(?:=|\s+)(${WORD})`, "g");
var CREATE_LABEL = new RegExp(String.raw`(?:^|\s)(?:--label(?:=|\s+)|-l\s*)(${WORD})`, "g");
var REVIEW_TOKEN = /review:[\w-]+/gi;
var ISSUE_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/[^\s/"'?]+/gi;
var LABELS_PATH = /\/labels\b/i;
var LABEL_FIELD = /\blabels(?:\[[^\]]*\])?=/i;
var FILE_LABELS = /\blabels(?:\[[^\]]*\])?=@/i;
var LABEL_MUTATION = /\b(?:labelIds|updatePullRequest|updateIssue)\b/;
var INPUT_FLAG = /(?:^|\s)--input(?:=|\s|$)/;
function hasCcv3Endpoint(raw) {
  if (!/\bgh\s+api\b/i.test(raw)) return false;
  return [...raw.matchAll(ISSUE_ENDPOINT)].some((m) => m[1].toLowerCase() === "rev4nchist/continuous-claude-v3");
}
var valuesOf = (re, raw) => [...raw.matchAll(re)].map((m) => m[1]);
var unquote = (word) => word.replace(/["'\\]/g, "");
var reviewTokens = (text) => (text.match(REVIEW_TOKEN) ?? []).map((t) => t.toLowerCase());
function labelShape(raw, create) {
  if (!/\bgh\b/i.test(raw)) return null;
  const squashed = squashQuotes(raw);
  const read = (re) => [...valuesOf(re, raw).map(unquote), ...valuesOf(re, squashed)];
  const values = [...read(ADD_LABEL), ...create ? read(CREATE_LABEL) : []];
  const api = /\bgh\s+api\b/i.test(squashed);
  const labelsApi = api && (LABELS_PATH.test(squashed) || new RegExp(ISSUE_ENDPOINT.source, "i").test(squashed) && LABEL_FIELD.test(squashed));
  const labels = [...new Set(reviewTokens(values.join(" ") + (labelsApi ? ` ${squashed}` : "")))];
  const blind = /addLabelsToLabelable/i.test(raw) || api && (LABEL_MUTATION.test(squashed) || FILE_LABELS.test(squashed) || labelsApi && INPUT_FLAG.test(squashed)) || values.some((v) => /[$`{}]/.test(v));
  return labels.length > 0 || blind ? { labels, blind } : null;
}
var SELF_FLAG = /(?:^|\s)--(?:confirm|apply)(?:=|\s|$)/;
var NODE_CMD = /\bnode(?:\.exe)?["']?\s/i;
var APPLY_N = /(?:^|\s)--apply(?:=["']?\d+(?!\d)|\s+["']?\d+(?![\d>]))/;
var CONFIRM_PATHWAY = /(?:^|\s)--confirm(?:=|\s+)["']?(?:none|coderabbit|both|wait)\b/;
var BY_FLAG = /(?:^|\s)--by(?:=|\s)/;
var SCRIPT_GLOB = /scripts[\\/]+github[\\/]+[^\s"']*[*?[]/i;
var NONLITERAL_REPO = new RegExp(
  String.raw`(?:^|\s)(?:-R\s*=?|--repo(?:\s+|=))["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)` + String.raw`|(?:^|[\s;])(?:\$env:)?GH_REPO\s*=\s*["']?[^\s"';]*(?:\$|\x60|%[A-Za-z_]\w*%)`,
  "i"
);
function isSelfConfirm(raw) {
  if (/pr-checkpoint/i.test(raw) && SELF_FLAG.test(raw)) return true;
  if (NODE_CMD.test(raw) && (APPLY_N.test(raw) || CONFIRM_PATHWAY.test(raw) && BY_FLAG.test(raw))) return true;
  return SELF_FLAG.test(raw) && SCRIPT_GLOB.test(raw);
}
var hasNonLiteralRepo = (raw) => NONLITERAL_REPO.test(raw);
function shapesOf(command) {
  const text = normalizeGh(command);
  const create = isPrOpenCommand(text);
  const ready = isReadyShape(text);
  const label = labelShape(text, create);
  const nonLiteral = (create || ready || label !== null) && hasNonLiteralRepo(text);
  return { create, nonDraft: create && isNonDraftCreate(text), ready, label, self: isSelfConfirm(text), nonLiteral };
}
var isGated = (s) => s.create || s.ready || s.label !== null || s.self;
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

// src/shared/config-stricter.ts
var CONFIG_FILE = "review-router.config.json";
var isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
var validCap = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
var sub = (o, key) => o && isObj(o[key]) ? o[key] : void 0;
function viewOf(cfg) {
  const c = isObj(cfg) ? cfg : null;
  const cap = sub(c, "coderabbit")?.cli_daily_cap_usd;
  return {
    enforce: sub(c, "checkpoint")?.enforce === true,
    cap: validCap(cap) ? cap : null,
    summaryFail: sub(c, "pre_pr")?.summary_mode === "fail"
  };
}
var UNREADABLE_MAIN = {
  checkpoint: { enforce: "unreadable" },
  coderabbit: { cli_daily_cap_usd: "unreadable" },
  pre_pr: { summary_mode: "unreadable" }
};
function mainKey(m, block, key) {
  if (!Object.hasOwn(m, block)) return { set: false, value: void 0 };
  const b = m[block];
  if (!isObj(b)) return { set: true, value: void 0 };
  return Object.hasOwn(b, key) ? { set: true, value: b[key] } : { set: false, value: void 0 };
}
function stricterConfig(main3, branch) {
  const out = isObj(branch) ? structuredClone(branch) : {};
  const m = isObj(main3) ? main3 : null;
  const block = (name) => sub(out, name) ?? {};
  const mainEnforce = m === null ? { set: false, value: void 0 } : mainKey(m, "checkpoint", "enforce");
  const checkpoint = sub(out, "checkpoint");
  const branchSets = checkpoint !== void 0 && Object.hasOwn(checkpoint, "enforce");
  const enforce = m === null || mainEnforce.set && mainEnforce.value !== false || branchSets && checkpoint?.enforce !== false;
  out.checkpoint = { ...block("checkpoint"), enforce };
  const mainCap = m === null ? { set: false, value: void 0 } : mainKey(m, "coderabbit", "cli_daily_cap_usd");
  const caps = [mainCap.set ? validCap(mainCap.value) ? mainCap.value : 0 : void 0, sub(out, "coderabbit")?.cli_daily_cap_usd].filter(validCap);
  if (caps.length > 0) out.coderabbit = { ...block("coderabbit"), cli_daily_cap_usd: Math.min(...caps) };
  const mainMode = m === null ? { set: false, value: void 0 } : mainKey(m, "pre_pr", "summary_mode");
  if (mainMode.set && mainMode.value !== "note" || sub(out, "pre_pr")?.summary_mode === "fail") out.pre_pr = { ...block("pre_pr"), summary_mode: "fail" };
  return out;
}
function objectOf(text) {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}
var FORK_REF = "refs/remotes/fork/main";
var LOCAL_REF = "refs/heads/main";
function refState(top, git, ref) {
  try {
    const run = git(top, ["rev-parse", "--verify", "--quiet", ref]);
    return run.status === 0 ? "yes" : run.status === 1 ? "no" : "error";
  } catch {
    return "error";
  }
}
function committedConfig(top, git, ref) {
  try {
    const shown = git(top, ["show", `${ref}:${CONFIG_FILE}`]);
    return shown.status === 0 ? objectOf(shown.stdout) : null;
  } catch {
    return null;
  }
}
function mainConfigOf(top, git) {
  const fork = refState(top, git, FORK_REF);
  if (fork === "error") return UNREADABLE_MAIN;
  if (fork === "yes") return committedConfig(top, git, FORK_REF) ?? UNREADABLE_MAIN;
  const local = refState(top, git, LOCAL_REF);
  if (local === "error") return UNREADABLE_MAIN;
  if (local === "yes") return committedConfig(top, git, LOCAL_REF) ?? UNREADABLE_MAIN;
  return null;
}

// src/shared/mask-quotes.ts
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
var PATH = String.raw`(?<path>[\w./\\:~-]+\.(?:md|txt))`;
var DELIM = String.raw`(?<dash>-?)(?<q>['"])(?<d>[A-Za-z_]\w*)\k<q>`;
var HEAD_FILE_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]+>>?[ \t]*${PATH}[ \t]*<<${DELIM}[ \t]*$`);
var HEAD_MARKER_FIRST = new RegExp(String.raw`^[ \t]*cat[ \t]*<<${DELIM}[ \t]*>>?[ \t]*${PATH}[ \t]*$`);
var ODD_BREAK = /[\r\0\v\f\x85\u2028\u2029]/;
function blankDocHeredocBody(command) {
  if (!command.includes("<<") || ODD_BREAK.test(command)) return command;
  const lines = command.split("\n");
  const head = HEAD_FILE_FIRST.exec(lines[0]) ?? HEAD_MARKER_FIRST.exec(lines[0]);
  if (!head || !head.groups) return command;
  const { dash, d } = head.groups;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = dash ? lines[i].replace(/^\t+/, "") : lines[i];
    if (line === d) {
      close = i;
      break;
    }
  }
  if (close < 1) return command;
  if (lines.slice(close + 1).some((l) => l.trim() !== "")) return command;
  return lines.map((l, i) => i >= 1 && i < close ? " ".repeat(l.length) : l).join("\n");
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
  const out = /* @__PURE__ */ new Set();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches(PLAIN_HEAD, masked, raw)) continue;
    if (openHead !== void 0 && headMatches(openHead, masked, raw)) continue;
    if (!headMatches(INERT_HEAD, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out.add(`${s}:${e}`);
  }
  return out;
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
  let out = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(":").map(Number);
    out = out.slice(0, s + 1) + " ".repeat(e - s - 2) + out.slice(e - 1);
  }
  return out;
}
function blankInertQuotesAround(command, tool, openHead) {
  if (tool !== void 0 && tool !== "Bash" && tool !== "PowerShell") return command;
  return blankSpans(command, inertSpans(command, "Bash", openHead), inertSpans(command, "PowerShell", openHead));
}

// ../../scripts/github/lib/decisions.mjs
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync, unlinkSync as unlinkSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import os from "node:os";
import path from "node:path";

// ../../scripts/github/lib/file-lock.mjs
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync as readFileSync2, statSync, unlinkSync as unlinkSync2, writeSync } from "node:fs";
var MUTEX_STALE_MS = 2e3;
var sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
var readLock = (lock) => {
  try {
    return readFileSync2(lock, "utf8");
  } catch {
    return null;
  }
};
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function staleContent(lock, lockStaleMs) {
  const st = statSync(lock);
  if (Date.now() - st.mtimeMs <= lockStaleMs) return null;
  if (!st.isFile()) return null;
  const content = readLock(lock);
  if (content === null) return null;
  const pid = Number.parseInt(content.split(" ")[0], 10);
  return pidAlive(pid) ? null : content;
}
function createExclusive(path2, token) {
  const fd = openSync(path2, "wx");
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
}
function clearDeadMutex(mutex) {
  const dead = staleContent(mutex, MUTEX_STALE_MS);
  if (dead !== null && readLock(mutex) === dead) unlinkSync2(mutex);
}
function takeOver(lock, lockStaleMs) {
  const mutex = `${lock}.takeover`;
  const token = `${process.pid} ${randomUUID()}`;
  try {
    createExclusive(mutex, token);
  } catch (err) {
    if (err.code === "EEXIST") clearDeadMutex(mutex);
    return false;
  }
  try {
    if (staleContent(lock, lockStaleMs) === null) return false;
    unlinkSync2(lock);
    return true;
  } finally {
    try {
      if (readLock(mutex) === token) unlinkSync2(mutex);
    } catch {
    }
  }
}
function withLock(file, { lockWaitMs = 5e3, lockStaleMs = 3e4 } = {}, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  const began = Date.now();
  for (; ; ) {
    try {
      createExclusive(lock, token);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let taken = false;
      try {
        taken = staleContent(lock, lockStaleMs) !== null && takeOver(lock, lockStaleMs);
      } catch {
      }
      if (taken) continue;
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: "lock", detail: `the lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readLock(lock) === token) unlinkSync2(lock);
    } catch {
    }
  }
}

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
var empty = () => ({ version: 1, offers: {}, decisions: {}, misses: {} });
var idOf = ({ step, key, head }) => `${step}
${key}
${String(head).toLowerCase()}`;
var isText = (v) => typeof v === "string" && v !== "";
var isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function readStore(file) {
  try {
    const s = JSON.parse(readFileSync3(file, "utf8"));
    if (!isPlain(s)) return empty();
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? store : empty();
  } catch {
    return empty();
  }
}
function writeStore(file, store) {
  const tmp = `${file}.${process.pid}.${randomUUID2()}.tmp`;
  const text = `${JSON.stringify(store, null, 2)}
`;
  writeFileSync2(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync3(tmp);
    } catch {
    }
    writeFileSync2(file, text);
  }
}
function prune(store, now) {
  for (const group of [store.offers, store.decisions, store.misses]) {
    for (const [id, row] of Object.entries(group)) {
      if (!(now - Date.parse(row?.at) <= MAX_AGE_MS)) delete group[id];
    }
  }
}
function readStoreStrict(file) {
  let text;
  try {
    text = readFileSync3(file, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? { store: empty() } : { unreadable: true };
  }
  try {
    const s = JSON.parse(text);
    if (!isPlain(s)) return { unreadable: true };
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? { store } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}
function update(fn, { strict = false } = {}) {
  const file = decisionsPath();
  mkdirSync3(path.dirname(file), { recursive: true });
  const locked = withLock(file, {}, () => {
    let store;
    if (strict) {
      const read = readStoreStrict(file);
      if (read.unreadable) return { ok: false, reason: "unreadable-store", detail: `the decision store ${file} exists but cannot be read or parsed: repair or delete it` };
      store = read.store;
    } else store = readStore(file);
    prune(store, Date.now());
    const out = fn(store);
    writeStore(file, store);
    return out;
  });
  return locked;
}
function decisionRead({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return null;
  const d = readStore(decisionsPath()).decisions[idOf({ step, key, head })];
  return d && typeof d.label === "string" ? { label: d.label, at: d.at } : null;
}
var stampedRow = (d) => ({ label: d.label, at: d.at, tapAt: isText(d.tapAt) ? d.tapAt : null, entry: isText(d.entry) ? d.entry : null });
function capCentsOfLabel(label) {
  const m = /up to \$(\d+(?:\.\d{1,2})?)/.exec(String(label ?? ""));
  const cents = m ? Math.round(Number(m[1]) * 100) : 0;
  return cents > 0 ? cents : null;
}
function decisionUse({ step, key, head, label, at, check, returnRow = false, paidRound = false }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return { ok: false, reason: "no-decision" };
  return update((store) => {
    const id = idOf({ step, key, head });
    if (typeof label === "string" && store.decisions[id] && store.decisions[id].label !== label) return { ok: false, reason: "label-changed" };
    if (typeof at === "string" && store.decisions[id] && store.decisions[id].at !== at) return { ok: false, reason: "tap-changed" };
    if (typeof check === "function" && store.decisions[id] && check(store.decisions[id]) !== true) return { ok: false, reason: "slot-changed" };
    const row = store.decisions[id];
    delete store.decisions[id];
    delete store.offers[id];
    delete store.misses[id];
    if (!row) return { ok: false, reason: "no-decision" };
    const paid = paidRound === true ? paidRowFrom(store, { key, head, row }) : null;
    return { ok: true, ...returnRow === true ? { row: stampedRow(row) } : {}, ...paid ? { paid } : {} };
  });
}
function paidRowFrom(store, { key, head, row }) {
  const stamp = stampedRow(row);
  if (capCentsOfLabel(stamp.label) === null) return { ok: false, reason: "no-price: the tapped label names no price" };
  if (!isText(stamp.tapAt) || !isText(stamp.entry)) return { ok: false, reason: "no-stamp: the tap has no tap time or entry point" };
  store.decisions[idOf({ step: "paid-round", key, head })] = { label: stamp.label, at: (/* @__PURE__ */ new Date()).toISOString(), tapAt: stamp.tapAt, entry: stamp.entry, tree: null, nonce: null };
  return { ok: true };
}

// src/shared/decisions-store.ts
var decisionRead2 = decisionRead;
var decisionUse2 = decisionUse;
var decisionKey2 = decisionKey;

// src/shared/shell-tools.ts
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

// src/pre-pr-gate.ts
var STAMP_REL = ".claude/cache/pre-pr/stamp.json";
var PATHWAY_REL = ".claude/cache/pre-pr/pathway.json";
var CONFIG_REL2 = "review-router.config.json";
var MAX_STAMP_AGE_MS = 24 * 36e5;
var FUTURE_SLACK_MS = 5 * 6e4;
var GIT_TIMEOUT_MS = 2e3;
var ALLOWED_SKIP_REASONS = /* @__PURE__ */ new Set(["cli-missing", "cli-cap"]);
var DC = "mcp__plugin_desktop-commander_desktop-commander__";
var COMMAND_TOOLS2 = /* @__PURE__ */ new Set(["Bash", "PowerShell", `${DC}start_process`, `${DC}interact_with_process`]);
var HOOK = "pre-pr-gate";
var RUN = "node scripts/github/pre-pr.mjs --body <file>";
var BODY_UNVERIFIABLE = "the PR body is not a file, so it cannot be matched to the body pre-pr.mjs checked. Pass the body as a file: -F body=@<file> (gh api) or --body-file <file> (gh pr create). An inline body, a body from stdin, --fill and --fill-first are denied";
var CLI_SKIP_LABEL = /^Skip the CLI review for this head(?: \(Recommended\))?$/;
var commandOf = (input) => {
  const c = readShellCommand(input);
  return c.kind === "command" ? c.text : "";
};
var isDesktopCommander = (input) => (input.tool_name || input.tool || "").startsWith(DC);
function headBranchOf(command) {
  const m = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"';&|]+)/.exec(command) ?? (/\bgh\s+pr\s+create\b/i.test(command) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"';&|]+)/.exec(command) : null);
  return m ? m[1].replace(/^[^:\s]+:/, "").replace(/["']+$/, "") : null;
}
function isCcv3Remote(url) {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && m[1].toLowerCase() === CCV3_REPO;
}
var OPENER = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
var CMD_POS = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER}*))` + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
var NOISE = String.raw`(?:\\|''|"")*`;
var spell = (word) => NOISE + [...word].join(NOISE) + NOISE;
var CD_NAMES = `${spell("cd")}|Set-Location|sl|${spell("chdir")}|${spell("pushd")}|Push-Location`;
var CD_TARGET = new RegExp(CMD_POS + String.raw`(?:${CD_NAMES})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`, "gi");
var UNKNOWN_CD = new RegExp(CMD_POS + String.raw`(?:(?:${spell("popd")}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`, "gi");
var NO_FOLDER = /^(?:[-+]|-[PLe@]+|--)$/i;
var JOB_BLOCK = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;
var REMOTE_AFTER_BLOCK = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;
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
var fromGitBashPath = (p, platform = process.platform) => platform === "win32" ? p.replace(/^\/([A-Za-z])(?:\/|$)/, "$1:/") : p;
var unquote2 = (target, shell) => {
  if (shell === "pwsh") return target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, s) => d ?? s ?? "").trimEnd();
  return fromGitBashPath(target.replace(/\\([ "'])|["']/g, (_m, esc) => esc ?? ""));
};
var resolveIn = (cwd, target, shell) => {
  const t = unquote2(target, shell);
  return isAbsolute(t) || /^[A-Za-z]:/.test(t) ? t : resolve2(cwd, t);
};
function hasUnexpandedPart(target) {
  const t = target.replace(/^["']|["']$/g, "");
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith("~") || /^[(@]/.test(t);
}
var CD_UNEXPANDED = "CD_UNEXPANDED";
var DIR_NOT_FOUND = "DIR_NOT_FOUND";
function gatedStart(masked, raw) {
  let found = null;
  let from = 0;
  const cut = (to) => {
    const seg = raw.slice(from, to);
    if (seg.trim() !== "" && (isPrOpenText(seg) || isGated(shapesOf(seg)))) found = from;
  };
  for (const m of masked.matchAll(/[;&|\r\n]+/g)) {
    cut(m.index);
    from = m.index + m[0].length;
  }
  cut(masked.length);
  return found;
}
function cdSteps(masked, raw, end, shell) {
  const pre = masked.slice(0, end);
  return [...pre.matchAll(new RegExp(CD_TARGET.source, "gi"))].flatMap((m) => {
    const at = m.index + m[0].length;
    const target = raw.slice(at - m.groups.t.length, at);
    if (NO_FOLDER.test(target)) return [{ target, andOnly: false, unknown: true }];
    const joiners = pre.slice(at).replace(FD_REDIRECT, " ").match(/&&|\|\||[;&|\r\n]/g) ?? [];
    const before = pre.slice(0, m.index);
    const loose = m.groups.soft !== void 0 || /^\||[(`]/.test(m.groups.hard ?? "") || endsInPipe(before) || insideSubshell(before) || JOB_BLOCK.test(withoutClosed(before, CLOSED_BRACES)) || REMOTE_AFTER_BLOCK.test(masked.slice(at));
    const word = shell === "pwsh" && raw[at] === "`" ? raw.slice(at - m.groups.t.length, at + 1) : target;
    return [{ target: word, andOnly: !loose && joiners.length > 0 && joiners.every((j) => j === "&&") }];
  });
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
function planRun(command, cwd, shell, env = {}) {
  const cdpath = shell === "bash" && (/\bCDPATH\b/.test(command) || (env.CDPATH ?? "") !== "");
  const masked = maskQuoted(command, shell === "pwsh" ? "PowerShell" : "Bash");
  const start = gatedStart(masked, command);
  const all = cdSteps(masked, command, start ?? command.length, shell);
  const steps = all.filter((s) => s.unknown !== true);
  const states = [cwd];
  const unexpanded = /* @__PURE__ */ new Map();
  let broken = false;
  for (const s of steps) {
    const t = unquote2(s.target, shell);
    const absolute = isAbsolute(t) || /^[A-Za-z]:/.test(t);
    const viaCdpath = cdpath && !absolute && !/^\.{1,2}(?:[\\/]|$)/.test(t);
    broken = hasUnexpandedPart(s.target) || viaCdpath || broken && !absolute;
    const dir = resolveIn(states[states.length - 1], s.target, shell);
    states.push(dir);
    if (broken) unexpanded.set(dir, t.slice(0, 120));
  }
  const lastLoose = start === null ? steps.length : steps.map((s) => s.andOnly).lastIndexOf(false) + 1;
  const final = states[states.length - 1];
  const unknown = all.some((s) => s.unknown === true) || masked.slice(0, start ?? command.length).match(UNKNOWN_CD) !== null;
  return { dirs: [.../* @__PURE__ */ new Set([...lastLoose > 0 ? states.slice(0, lastLoose + 1) : [], final])], final, states, unexpanded, unknown };
}
function guardUnexpandedCd(deps, plan) {
  if (plan.unexpanded.size === 0) return deps;
  return {
    ...deps,
    git: (d, args) => {
      const target = plan.unexpanded.get(d);
      if (target === void 0) return deps.git(d, args);
      throw Object.assign(new Error(`cannot expand the cd target ${target}`), { code: CD_UNEXPANDED, target });
    }
  };
}
function candidateDirs(command, cwd, shell) {
  const texts = [command, command.replace(/["']/g, "")];
  const targets = texts.flatMap((t) => [...t.matchAll(CD_TARGET)].map((m) => resolveIn(cwd, m.groups.t, shell)));
  return [.../* @__PURE__ */ new Set([cwd, ...targets])];
}
var FIELD_BODY = /(?:^|\s)(?:-F|--field)(?:=|\s*)(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+)))/;
var BODY_FILE = /(?:^|\s)--body-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/;
var SHORT_BODY_FILE = /(?:^|\s)-F\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/;
var INLINE_BODY = /(?:^|\s)(?:--body(?![\w-])|-b)|(?:^|\s)(?:-f|--raw-field)(?:=|\s*)["']?body=|(?:^|\s)(?:-F|--field)(?:=|\s*)["']?body=(?!@)/;
var INPUT_FLAG2 = /(?:^|\s)--input(?![\w-])/;
function bodyFilesOf(command) {
  const sources = [FIELD_BODY, BODY_FILE, .../\bgh\s+pr\s+create\b/i.test(command) ? [SHORT_BODY_FILE] : []];
  return sources.flatMap((re) => [...command.matchAll(new RegExp(re.source, "g"))].map((m) => m.slice(1).find((g) => g !== void 0) ?? ""));
}
function bodyFileOf(command) {
  const path2 = bodyFilesOf(command)[0];
  return path2 !== void 0 && path2 !== "-" ? path2 : null;
}
var OPEN_HEAD = /^\s*gh\s+(?:pr\s+create|api)(?=\s|$)/i;
var bodyViewOf = (command, tool) => blankInertQuotesAround(command, tool, OPEN_HEAD);
var OPEN_SEGMENT = new RegExp(String.raw`(?:^|[;&|\r\n(\x60]\s*)gh(?:\.exe)?(?:\s+pr\s+create(?=\s|$)|${GH_OPT_PREFIX}[^\S\r\n]+pr\s+create(?=\s|$)|\s+api\s+(?:\S+\s+)*?\S*\/pulls(?=\s|$))`, "gi");
function openSegmentOf(text, shell) {
  const view = joinContinuations(joinContinuations(text, "pwsh"), "bash");
  const opens = [...view.matchAll(OPEN_SEGMENT)];
  if (opens.length === 0) return view;
  if (opens.length > 1) return "";
  const start = opens[0].index + opens[0][0].search(/g/i);
  const masked = maskQuoted(view, shell === "pwsh" ? "PowerShell" : "Bash");
  const cut = masked.slice(start).search(/[;&|\r\n]/);
  return view.slice(start, cut < 0 ? view.length : start + cut);
}
function singleBodyFile(command) {
  const files = bodyFilesOf(command);
  if (files.length !== 1 || INLINE_BODY.test(command) || INPUT_FLAG2.test(command)) return null;
  return bodyFileOf(command);
}
function hasOverride(command, env) {
  return env.SKIP_PRE_PR_GATE === "1" || /^\s*SKIP_PRE_PR_GATE=1\s+/.test(command) || /^\s*\$env:SKIP_PRE_PR_GATE\s*=\s*['"]?1['"]?\s*;/i.test(command);
}
function deny(pattern, why) {
  return {
    action: "deny",
    pattern,
    reason: `BLOCKED (pre-pr-gate): ${why}

Run this from the repo root, then open the PR again:
  ${RUN}

<file> is the draft PR body with the Evidence block (pr-and-commit-style.md). The script runs the gates for the files you changed, checks the Evidence against the head, and runs one CodeRabbit CLI review. It writes a stamp for the head. See pr-review-loop.md "Before you open a PR". CodeRabbit allows 8 PR reviews per hour for one identity, so checks run before the PR opens.`
  };
}
function isCcv3Checkout(deps, dir) {
  const r = deps.git(dir, ["remote", "-v"]);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1];
    return url !== void 0 && isCcv3Remote(url);
  });
}
function isCcv3Dir(deps, dir) {
  try {
    return isCcv3Checkout(deps, dir);
  } catch (err) {
    if (err?.code === CD_UNEXPANDED) throw err;
    return false;
  }
}
function stampRoots(deps, dir, root, branch) {
  const roots = [root];
  if (!branch) return roots;
  const r = deps.git(dir, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return roots;
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const path2 = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path2 && ref === branch && !roots.includes(path2.trim())) roots.push(path2.trim());
  }
  return roots;
}
function stampProblem(raw, head, now, body, flagDecided = () => false) {
  if (raw === null) return "no stamp. The pre-PR check has not passed in this checkout";
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return "the stamp is not valid JSON";
  }
  const o = s;
  if (!o || typeof o !== "object" || typeof o.head !== "string" || o.head === "") return "the stamp has no head";
  const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
  if (!Number.isFinite(at)) return "the stamp has no valid time";
  if (o.head.toLowerCase() !== head.toLowerCase()) return `the stamp is for commit ${o.head.slice(0, 7)}, the head being opened is ${head.slice(0, 7)}`;
  if (now - at > MAX_STAMP_AGE_MS) return "the stamp is older than 24 hours";
  if (at - now > FUTURE_SLACK_MS) return "the stamp time is in the future";
  const reason = String(o.cr_skip_reason);
  const waitKnown = reason === "rate-limited" && typeof o.cr_retry_minutes === "number" && o.cr_retry_minutes > 0;
  const capEarned = reason === "cap" && (typeof o.cr_finished_runs === "number" && o.cr_finished_runs >= 1 || Number.isInteger(o.cr_partial_earned) && o.cr_partial_earned >= 1);
  if (o.cr_skipped === true && reason === "cap" && !capEarned) {
    return `the stamp skipped the CodeRabbit CLI review for the run cap, but no CLI run on this branch has finished with a PASS (cr_finished_runs: ${String(o.cr_finished_runs ?? "none")}) and no partial run earned it (cr_partial_earned: ${String(o.cr_partial_earned ?? "none")}). The cap counts runs that finished with a PASS, or partial runs whose findings the branch changed. A finding judged false and not changed does not earn: the way out is Dave's recorded decision, not an edit of the lines. Fix the CLI and run pre-pr.mjs again`;
  }
  const docsOnlyEarned = reason === "docs-only" && o.cr_docs_only === true && o.docs_verified === true;
  if (o.cr_skipped === true && reason === "docs-only" && !docsOnlyEarned) {
    return `the stamp skipped the CodeRabbit CLI review as docs-only, but it lacks cr_docs_only: true or docs_verified: true (cr_docs_only: ${String(o.cr_docs_only ?? "none")}, docs_verified: ${String(o.docs_verified ?? "none")}). A docs-only skip is allowed only when pre-pr.mjs confirmed every changed file is docs. Run pre-pr.mjs again`;
  }
  const answerKeyEarned = reason === "answer-key" && o.cr_answer_key === true && Number.isInteger(o.answer_key_paths) && o.answer_key_paths >= 1;
  if (o.cr_skipped === true && reason === "answer-key" && !answerKeyEarned) {
    return `the stamp skipped the CodeRabbit CLI review as answer-key, but it lacks cr_answer_key: true or answer_key_paths: a whole number of 1 or more (cr_answer_key: ${String(o.cr_answer_key ?? "none")}, answer_key_paths: ${String(o.answer_key_paths ?? "none")}). An answer-key skip is allowed only when pre-pr.mjs found an answer-key path in the diff. Run pre-pr.mjs again`;
  }
  const flagEarned = o.cr_skipped === true && reason === "flag" && flagDecided();
  if (o.cr_skipped === true && !ALLOWED_SKIP_REASONS.has(reason) && !waitKnown && !capEarned && !docsOnlyEarned && !answerKeyEarned && !flagEarned) {
    return `the stamp skipped the CodeRabbit CLI review (reason: ${o.cr_skip_reason || "none"}). Only a finished-run cap, a missing CLI (cli-missing), the daily CLI spend cap (cli-cap), a docs-only branch (docs-only, with cr_docs_only and docs_verified true), a diff with an answer-key path (answer-key, with cr_answer_key true and answer_key_paths 1 or more), or a rate limit with a known retry time allows a skip. A broken CLI (cli-error) costs nothing to retry. Run pre-pr.mjs again without --skip-cr`;
  }
  if (body) {
    if (body.sha === null) return `the body file ${body.path} cannot be read, so it cannot be matched to the body pre-pr.mjs checked. Use an absolute path or a path relative to the working directory. The hook does not expand ~ or $env: paths. A Git Bash /c/ path is turned into C:/ on Windows`;
    if (o.body_sha256 !== body.sha) return `the body file ${body.path} is not the body pre-pr.mjs checked (its hash differs from the stamp). Run pre-pr.mjs on this file`;
  }
  return null;
}
function pushedProblem(deps, root, branch, head) {
  const name = branch ?? deps.git(root, ["branch", "--show-current"]).stdout.trim();
  if (!name) return null;
  const r = deps.git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/fork/${name}^{commit}`]);
  if (r.status !== 0) return null;
  const pushed = r.stdout.trim();
  if (pushed.toLowerCase() === head.toLowerCase()) return null;
  return `the pushed head fork/${name} is ${pushed.slice(0, 7)}, not the stamped head ${head.slice(0, 7)}. Push the stamped commit, or run pre-pr.mjs again`;
}
var shellOf = (input) => (input.tool_name || input.tool) === "PowerShell" ? "pwsh" : "bash";
var once = (f) => {
  let box;
  return () => (box ??= { v: f() }).v;
};
function makeCtx(input, command, deps, shapes, plan, bodyView) {
  const cwd = input.cwd || process.cwd();
  const shell = shellOf(input);
  const named = namedRepo(command, deps.env);
  const tops = /* @__PURE__ */ new Map();
  const top = (d) => {
    if (!tops.has(d)) {
      const r = deps.git(d, ["rev-parse", "--show-toplevel"]);
      tops.set(d, r.status === 0 ? r.stdout.trim() : null);
    }
    return tops.get(d) ?? null;
  };
  const missing = (d) => {
    try {
      top(d);
      return false;
    } catch (err) {
      if (err?.code === DIR_NOT_FOUND) return true;
      throw err;
    }
  };
  const live = plan.dirs.includes(cwd) ? plan.dirs.filter((d) => d === cwd || !missing(d)) : plan.dirs;
  const dirs = live.length > 0 ? live : plan.dirs;
  const final = dirs.includes(plan.final) ? plan.final : cwd;
  const ccv3At = /* @__PURE__ */ new Map();
  const isCcv3At = (d) => {
    if (!ccv3At.has(d)) ccv3At.set(d, d === final ? isCcv3Checkout(deps, d) : isCcv3Dir(deps, d));
    return ccv3At.get(d) ?? false;
  };
  const inCcv3 = once(() => named === CCV3_REPO || isCcv3At(final) || candidateDirs(command, cwd, shell).some((d) => d !== final && isCcv3Dir(deps, d)));
  return {
    dirs,
    final,
    cwd,
    states: plan.states,
    unknown: plan.unknown,
    shell,
    bodyView,
    named,
    top,
    isCcv3At,
    ccv3: inCcv3,
    // No usable config in the cwd checkout: fail closed for a command that names CCv3, a self-confirm (repo-free, pr-checkpoint is CCv3-only)
    // and a command that runs in a CCv3 checkout. Any other command is warn mode. A readable config keeps its own value.
    enforcing: once(() => enforceIn(deps, top(cwd)) ?? (named === CCV3_REPO || shapes.self || inCcv3()))
  };
}
function enforceIn(deps, top) {
  const text = top === null ? null : deps.readFile(join5(top, CONFIG_REL2));
  if (top === null || text === null) return null;
  let branch;
  try {
    branch = JSON.parse(text);
  } catch {
    return null;
  }
  return viewOf(stricterConfig(mainConfigOf(top, deps.git), branch)).enforce;
}
function decide(input, deps) {
  if (!isDesktopCommander(input)) return decideAs(input, deps);
  const text = commandOf(input);
  const realName = input.tool_name || input.tool;
  const runs = [];
  for (const shell of ["Bash", "PowerShell"]) runs.push(decideAs({ ...input, tool_name: shell }, deps, text));
  for (const shell of ["Bash", "PowerShell"]) {
    const base = normalizeGh(joinContinuations(text, shell === "PowerShell" ? "pwsh" : "bash"));
    if (blankInertQuotes(text, shell) !== text || bodyViewOf(base, shell) !== base) runs.push(decideAs({ ...input, tool_name: shell }, deps, text, realName));
  }
  return runs.find((d) => d.action === "deny") ?? runs.find((d) => d.action === "override") ?? runs.find((d) => d.action === "allow" && d.warn) ?? runs[0];
}
function decideAs(input, deps, text, quoteTool = input.tool_name || input.tool) {
  const raw = text ?? commandOf(input);
  const command = normalizeGh(joinContinuations(blankInertQuotes(raw, quoteTool), shellOf(input)));
  const shapes = shapesOf(command);
  if (!isGated(shapes)) return { action: "allow" };
  const plan = planRun(command, input.cwd || process.cwd(), shellOf(input), deps.env);
  deps = guardUnexpandedCd(deps, plan);
  const ctx = makeCtx(input, command, deps, shapes, plan, bodyViewOf(command, quoteTool));
  const d = judge(command, deps, ctx, shapes);
  const used = ctx.cliSkipUsed ? { usedCliSkip: ctx.cliSkipUsed } : {};
  if (d.action !== "deny") return d.action === "allow" ? { ...d, ...used } : d;
  if (hasOverride(command, deps.env)) return { action: "override" };
  return d.soft && !ctx.enforcing() ? { action: "allow", warn: d.pattern, ...used } : d;
}
function judge(command, deps, ctx, shapes) {
  const moved = repoMovedDeny(command, shapes);
  if (moved) return moved;
  const where = positionDeny(ctx, shapes);
  if (shapes.create) return where ?? stampDeny(command, deps, ctx) ?? checkpointDeny(deps, ctx, shapes) ?? { action: "allow" };
  return checkpointDeny(deps, ctx, shapes) ?? where ?? { action: "allow" };
}
var MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function repoMovedDeny(command, shapes) {
  const moved = MOVE_ENV_RAW.test(command) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED.test(maskQuoted(command, tool))) || CD_ALIAS.test(squashQuotes(command));
  if (!moved) return null;
  return shapes.create ? { action: "deny", pattern: "repo-moved", reason: `BLOCKED (pre-pr-gate): ${MOVED_WHY}` } : soft("repo-moved", MOVED_WHY);
}
var POSITION_WHY = "popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.";
function positionDeny(ctx, shapes) {
  if (!ctx.unknown) return null;
  if (ctx.named !== CCV3_REPO && ![.../* @__PURE__ */ new Set([ctx.cwd, ...ctx.states, ...ctx.dirs])].some((d) => ctx.isCcv3At(d))) return null;
  return shapes.create ? { action: "deny", pattern: "position-unknown", reason: `BLOCKED (pre-pr-gate): ${POSITION_WHY}` } : soft("position-unknown", POSITION_WHY);
}
function stampDeny(command, deps, ctx) {
  for (const dir of ctx.dirs) {
    const d = stampDenyIn(command, deps, ctx, dir);
    if (d) return d;
  }
  return null;
}
function cliSkipKey(deps, top, branch) {
  const name = branch ?? deps.git(top, ["branch", "--show-current"]).stdout.trim();
  return name ? decisionKey2({ branch: name }) : null;
}
function cliSkipLabelOf(deps, key, head) {
  try {
    const d = deps.decisionRead?.({ step: "cli-skip", key, head }) ?? null;
    return d !== null && typeof d.label === "string" && CLI_SKIP_LABEL.test(d.label) ? d.label : null;
  } catch {
    return null;
  }
}
function stampDenyIn(command, deps, ctx, dir) {
  const { named, shell } = ctx;
  const rule = (pattern, why) => deny(pattern, ctx.dirs.length > 1 ? `${why}. The command can run in more than one folder. A cd joined by ; or || or a line end can fail. The shell then stays in its folder. This check is for ${dir}. Join the cd to the PR command with && to name one folder` : why);
  if (named !== CCV3_REPO && !ctx.isCcv3At(dir)) return null;
  const top = ctx.top(dir);
  if (top === null) return rule("no-checkout", `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  if (named !== null && !ctx.isCcv3At(dir)) return rule("repo-identity", `this command names ${CCV3_REPO}, but ${dir} is not a CCv3 checkout, so its stamp does not count`);
  const whole = singleBodyFile(ctx.bodyView);
  const bodyPath = whole !== null && whole === singleBodyFile(openSegmentOf(ctx.bodyView, shell)) ? whole : null;
  if (bodyPath === null) return rule("body", BODY_UNVERIFIABLE);
  const branch = headBranchOf(command);
  const headRun = deps.git(top, ["rev-parse", branch ? `${branch}^{commit}` : "HEAD"]);
  if (headRun.status !== 0) return rule("head-unresolved", `cannot resolve the head ${branch ?? "HEAD"} in ${top}`);
  const head = headRun.stdout.trim();
  const body = { path: bodyPath, sha: sha256Of(deps.readFile(resolve2(dir, shell === "bash" ? fromGitBashPath(bodyPath) : bodyPath))) };
  const checks = stampRoots(deps, dir, top, branch).map((r) => {
    let relied = null;
    const decided = () => {
      const key = cliSkipKey(deps, top, branch);
      const label = key === null ? null : cliSkipLabelOf(deps, key, head);
      if (key !== null && label !== null) {
        relied = { key, head, label };
        return true;
      }
      return false;
    };
    return { problem: stampProblem(deps.readFile(join5(r, STAMP_REL)), head, deps.now(), body, decided), relied };
  });
  const passed = checks.find((c) => c.problem === null);
  if (!passed) return rule("stamp", checks[0]?.problem ?? "no stamp");
  if (passed.relied) ctx.cliSkipUsed = passed.relied;
  const pushed = pushedProblem(deps, top, branch, head);
  return pushed ? rule("pushed-head", pushed) : null;
}
function soft(pattern, why) {
  return { action: "deny", pattern, soft: true, reason: `BLOCKED (pre-pr-gate): ${why}` };
}
var SELF_WHY = "pr-checkpoint --confirm and --apply record and spend a review pathway. Only Dave's press in the /pathway mod does that. Do not run them from a shell. The read-only form (node scripts/github/pr-checkpoint.mjs --json) is allowed.";
var LITERAL_WHY = "pass a literal OWNER/REPO to --repo or -R. A value with $, a backtick or %VAR% hides the target repo from this gate.";
var DRAFT_WHY = `open as draft; call pr_checkpoint {pr}. Open the PR with gh pr create --draft (gh api: -F draft=true). Then call pr_checkpoint {pr}: it asks Dave to pick the review pathway, and the PR is marked ready after his tap.`;
var READY_WHY = "gh pr ready is not run from a shell. Call pr_checkpoint {pr}: it asks Dave to pick a pathway, and after his tap the mod adds the review label and marks the PR ready. To return a PR to draft, use gh pr ready --undo.";
var LABEL_WHY = "a review: label is set only by the pathway Dave taps for this head. Do not add one by hand, and do not use a command whose label text is hidden. Call pr_checkpoint {pr}.";
function checkpointDeny(deps, ctx, shapes) {
  if (shapes.self) return soft("self-confirm", SELF_WHY);
  if (shapes.nonLiteral) return soft("nonliteral-repo", LITERAL_WHY);
  if (!ctx.ccv3()) return null;
  if (shapes.nonDraft) return soft("non-draft", DRAFT_WHY);
  if (shapes.ready) return soft("ready", READY_WHY);
  if (shapes.label && !labelAllowed(shapes.label, deps, ctx)) return soft("review-label", LABEL_WHY);
  return null;
}
function labelAllowed(label, deps, ctx) {
  if (label.blind || label.labels.length !== 1) return false;
  return ctx.dirs.every((dir) => pathwayLabel(deps, ctx, dir) === label.labels[0]);
}
function pathwayLabel(deps, ctx, dir) {
  const top = ctx.top(dir);
  const text = top === null ? null : deps.readFile(join5(top, PATHWAY_REL));
  const head = top === null ? null : deps.git(top, ["rev-parse", "HEAD"]);
  if (text === null || head === null || head.status !== 0) return null;
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return null;
  }
  if (!p || typeof p.head !== "string" || typeof p.label !== "string") return null;
  return p.head.toLowerCase() === head.stdout.trim().toLowerCase() ? p.label.toLowerCase() : null;
}
var sha256Of = (text) => text === null ? null : createHash("sha256").update(text).digest("hex");
function errorContext(err, input) {
  const code = err?.code;
  const cwd = input?.cwd;
  return { ...typeof code === "string" && code ? { code } : {}, ...typeof cwd === "string" && cwd ? { cwd } : {} };
}
function handle(raw, deps) {
  let input = {};
  let command = "";
  let gated = false;
  let create = false;
  try {
    try {
      input = JSON.parse(raw.trim() || "{}");
    } catch (parseErr) {
      try {
        deps.logError?.(String(parseErr?.message ?? parseErr), errorContext(parseErr, null));
      } catch {
      }
      if (!isPrOpenCommand(raw)) return "{}";
      logGuardDecision(HOOK, {}, "deny", "unreadable-input", { command: raw.slice(0, 500) });
      const why = `BLOCKED (pre-pr-gate): could not read the hook input, and its text looks like a PR create, so the pre-PR stamp could not be checked. Run the command again. If it keeps failing, ask Dave.

The stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    }
    const tool = input.tool_name || input.tool || "";
    if (!COMMAND_TOOLS2.has(tool)) return "{}";
    command = commandOf(input);
    const seen = blankInertQuotes(command, tool);
    create = isPrOpenCommand(seen);
    gated = create || ["bash", "pwsh"].some((s) => isGated(shapesOf(joinContinuations(seen, isDesktopCommander(input) ? s : shellOf(input)))));
    const d = decide(input, deps);
    if (d.action === "override") logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
    if (d.action === "allow" && d.warn) logGuardDecision(HOOK, input, "warn", d.warn, { command });
    if (d.action === "allow" && d.usedCliSkip) {
      const used = deps.decisionUse?.({ step: "cli-skip", key: d.usedCliSkip.key, head: d.usedCliSkip.head, label: d.usedCliSkip.label });
      if (used?.ok !== true) {
        logGuardDecision(HOOK, input, "deny", "cli-skip-not-used", { command });
        return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "BLOCKED (pre-pr-gate): Dave's cli-skip decision for this branch and head could not be used up (the decision store was busy or the decision is gone). Run the command again. If it keeps failing, ask Dave with node scripts/github/ship-ask.mjs cli-skip --branch <branch>." } });
      }
    }
    if (d.action !== "deny") return "{}";
    logGuardDecision(HOOK, input, "deny", d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
  } catch (err) {
    const message = String(err?.message ?? err);
    const cdUnexpanded = err?.code === CD_UNEXPANDED;
    if (!cdUnexpanded) {
      try {
        deps.logError?.(message, errorContext(err, input));
      } catch {
      }
    }
    if (!gated) return "{}";
    if (hasOverride(joinContinuations(command, shellOf(input)), deps.env)) {
      logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
      return "{}";
    }
    if (cdUnexpanded) {
      logGuardDecision(HOOK, input, "deny", "cd-unexpanded", { command });
      const why = `BLOCKED (pre-pr-gate): the hook cannot expand the cd target in this command (${String(err.target ?? "").slice(0, 120)}). It does not expand $var, %VAR%, $(...), a backtick, ~, a glob (* ? [), a PowerShell expression or a relative target under CDPATH, so it cannot tell which checkout the command runs in.

Use a literal path in the cd (for example C:/Users/x/repo), or run the cd in a separate call, then run the command again.

The stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    }
    if (err?.code === GIT_NOT_FOUND) {
      logGuardDecision(HOOK, input, "deny", "git-not-found", { command });
      const why = `BLOCKED (pre-pr-gate): ${message.slice(0, 400)}

The gate needs git to check ${create ? "the pre-PR stamp" : "the PR checkpoint rules"}.`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    }
    logGuardDecision(HOOK, input, "deny", "verify-error", { command });
    const what = create ? "the pre-PR stamp" : "the PR checkpoint rules";
    const reason = `BLOCKED (pre-pr-gate): could not verify ${what} (${message.slice(0, 200)}). Run the command again. If it keeps failing, ask Dave.

The stamp comes from: ${RUN}`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
}
var GIT_NOT_FOUND = "GIT_NOT_FOUND";
var GIT_FIX = "Fix: install Git for Windows (https://git-scm.com/download/win) or add its cmd folder (for example C:\\Program Files\\Git\\cmd) to PATH, then run the command again.";
function gitNotFound(detail) {
  return Object.assign(new Error(`git not found on PATH: ${detail}. ${GIT_FIX}`), { code: GIT_NOT_FOUND });
}
function runnableFile(path2, platform = process.platform) {
  try {
    if (!statSync2(path2).isFile()) return false;
    if (platform !== "win32") accessSync(path2, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveGit(env = process.env, exists, platform = process.platform) {
  exists ??= (path2) => runnableFile(path2, platform);
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const exe = win ? "git.exe" : "git";
  const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
  const candidates = dirs.map((d) => p.join(d, exe));
  if (win) {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter((r) => !!r);
    for (const root of roots) candidates.push(p.join(root, "Git", "cmd", exe), p.join(root, "Git", "bin", exe));
    if (env.LOCALAPPDATA) candidates.push(p.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", exe));
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
  }
  return candidates.find((c) => {
    try {
      return exists(c);
    } catch {
      return false;
    }
  }) ?? null;
}
function makeGit(spawn = spawnSync, env = process.env, gitPath) {
  const asked = Number(env.PRE_PR_GATE_GIT_TIMEOUT_MS);
  const timeout = Number.isFinite(asked) && asked > GIT_TIMEOUT_MS ? asked : GIT_TIMEOUT_MS;
  let resolved = gitPath;
  return (cwd, args) => {
    if (resolved === void 0) resolved = resolveGit(env);
    if (resolved === null) throw gitNotFound("no git program in PATH or in the standard install folders");
    const r = spawn(resolved, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
    if (r.error) {
      if (r.error.code === "ENOENT") {
        if (!existsSync2(resolved)) throw gitNotFound(r.error.message);
        if (!existsSync2(cwd)) throw Object.assign(new Error(`directory not found: ${cwd}`), { code: DIR_NOT_FOUND });
      }
      throw r.error;
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function makeErrorLogger(env = process.env) {
  return (message, ctx = {}) => {
    if (!shouldWrite(env)) return;
    const file = join5(dirname3(guardLogPath(env)), "pre-pr-gate-errors.jsonl");
    mkdirSync4(dirname3(file), { recursive: true, mode: 448 });
    const cwd = ctx.cwd ?? null;
    let cwdExists = false;
    try {
      cwdExists = existsSync2(cwd ?? process.cwd());
    } catch {
    }
    const row = { ts: (/* @__PURE__ */ new Date()).toISOString(), hook: HOOK, error: maskSecrets(message).slice(0, 300), ...ctx.code ? { code: ctx.code.slice(0, 40) } : {}, cwd: cwd === null ? null : cwd.slice(0, 300), cwd_exists: cwdExists };
    appendFileSync2(file, `${JSON.stringify(row)}
`, { mode: 384 });
  };
}
function realDeps() {
  return {
    git: makeGit(),
    readFile: (p) => {
      try {
        return readFileSync4(p, "utf8");
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    env: process.env,
    logError: makeErrorLogger(process.env),
    decisionRead: decisionRead2,
    decisionUse: decisionUse2
  };
}
async function main2() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString("utf-8"), realDeps()));
}
if (!process.env.VITEST) {
  main2().catch((err) => {
    logGuardError(HOOK, err);
    console.log("{}");
  });
}
export {
  CCV3_REPO,
  CD_UNEXPANDED,
  CLI_SKIP_LABEL,
  COMMAND_TOOLS2 as COMMAND_TOOLS,
  DIR_NOT_FOUND,
  GIT_NOT_FOUND,
  GIT_TIMEOUT_MS,
  MAX_STAMP_AGE_MS,
  PATHWAY_REL,
  STAMP_REL,
  bodyFileOf,
  decide,
  fromGitBashPath,
  handle,
  hasOverride,
  hasUnexpandedPart,
  headBranchOf,
  isCcv3Remote,
  makeErrorLogger,
  makeGit,
  namedRepo,
  resolveGit,
  runnableFile
};
