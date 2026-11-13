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
    const path3 = guardLogPath(env);
    mkdirSync(dirname(path3), { recursive: true, mode: 448 });
    appendFileSync(path3, JSON.stringify(entry) + "\n", { mode: 384 });
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
    const path3 = guardLogPath(env);
    mkdirSync(dirname(path3), { recursive: true, mode: 448 });
    appendFileSync(path3, JSON.stringify(entry) + "\n", { mode: 384 });
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

// src/decision-gate.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync2, readFileSync as readFileSync5 } from "fs";
import { homedir as homedir5 } from "os";
import { isAbsolute as isAbsolute2, join as join6, posix as posix2, resolve as resolve2 } from "path";

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
var PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;
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
  const values = [...flagValues(REPO_FLAG, seg, mseg, gh.index), ...flagValues(GH_REPO_ASSIGN, seg, mseg, 0)];
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

// src/shared/decisions-store.ts
import { readFileSync as readFileSync3 } from "fs";

// ../../scripts/github/lib/decisions.mjs
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, renameSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import os from "node:os";
import path from "node:path";
var DECISIONS_ENV = "CCV3_DECISIONS_FILE";
var STEPS = Object.freeze(["ship", "open-pr", "review", "land", "paid-round"]);
var REPO = "Rev4nchist/Continuous-Claude-v3";
var MAX_AGE_MS = 7 * 24 * 3600 * 1e3;
var MISS_TTL_MS = 60 * 60 * 1e3;
var decisionsPath = (env = process.env) => env[DECISIONS_ENV] || path.join(os.homedir(), ".claude", "state", "ccv3-mods", "decisions.json");
var decisionKey = ({ repo = REPO, pr, branch }) => pr !== void 0 && pr !== null ? `${repo}#${pr}` : `${repo}@${branch}`;
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

// src/shared/git-call.ts
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

// src/shared/tap-scope.ts
import * as fs2 from "fs";
import * as os2 from "os";
import * as path2 from "path";

// ../../scripts/github/lib/repo-identity.mjs
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
function targetOf2(url) {
  const t = url.trim();
  if (isPathLike(t)) return normPath(t.replace(/^file:\/\//i, ""));
  return t.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1").replace(/^[^@/:\s]+@(?=[^/:\s]+:)/, "").replace(/\/+$/, "");
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
  const listed = out(git, ["remote", "get-url", ...push ? ["--push", "--all"] : [], remote]);
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
var readUtf8 = (file) => fs2.readFileSync(file, "utf8");
var realNative = (p) => fs2.realpathSync.native(p);
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
  return path2.join(home, ".claude", "project-registry.json");
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
  return normPath2(path2.posix.normalize(`${normPath2(base)}/${rel.replace(/\\/g, "/")}`));
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
var PUSH_ORIGIN_WHY = "a push to origin is never allowed: origin is upstream (parcadei), not the fork. Push to the fork remote.";
var pushUnresolvedWhy = (what) => `${what}, so its ship decision cannot be found. Name the remote and branch (git push fork <branch>) and run it from the repo.`;
var STORE_WHY = "only decision-ledger writes the decision store, from Dave's tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.";
var SUBAGENT_WHY = "a subagent cannot open a PR, land, merge or push: Dave's tap belongs to the main session. Ask the main session to do it.";
var NO_PR_WHY = "the PR number cannot be read from this command, so its land decision cannot be found. Name the PR number in the command (land-pr.ps1 -Pr <n>, gh pr merge <n>).";
var goThereWhy = (repo) => `this command names ${repo}, which is not the CCv3 repo, so it cannot be judged with a CCv3 decision: go to that repo folder and run it there.`;
var fwd = (p) => p.replace(/\\/g, "/");
var prose = (v) => oneLine3(v, 200);
var at = (dir) => prose(fwd(dir));
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
    ["pr", offer.pr, /^\d+$/],
    ["remote", offer.remote, SAFE_REMOTE],
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
  return { ok: true, text: `node ${fwd(deps.home)}/continuous-claude/scripts/github/app-ask.mjs ${words.join(" ")} --json${note}` };
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
  if (!SAFE_WORD.test(risk.remote)) return `The default branch of remote ${prose(risk.remote)} is not known in this checkout, so this push needs his tap.`;
  return `The default branch of remote ${prose(risk.remote)} is not known in this checkout; git remote set-head ${risk.remote} --auto records it.`;
}
var appPushWhy = (deps, dir, repo, branch, offer, risk) => `no "ship" decision from Dave for the tree you push to ${prose(branch)}${risk.kind === "default" ? ", a default branch of" : " in"} ${prose(repo)} (folder ${at(dir)}). ${pushNeed(risk)} ${askPart(deps, offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged).`)} The tap is bound to this repo, this branch and one tree. A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
var PUSH_WAY_OUT = "run git push as its own command: git push <remote> <branch>";
var appNotAloneWhy = (deps, dir, offer) => `this push shares its command with another command, a pipe or a redirect (folder ${at(dir)}), so Dave's "Push only" tap does not count for it. To clear it, ${PUSH_WAY_OUT}. ${askPart(deps, offer, dir, (c) => `If the gate still asks for his tap then, ask him first: run ${c}, ${ASK_HOW}.`)}`;
var appPushUrlsWhy = (dir, remote, keys) => `remote ${prose(remote)} of ${at(dir)} pushes to more than one repo (${prose(keys.join(", "))}), and one tap covers one push URL, so this push stays blocked even with Dave's tap. Push to one URL (git push <url> <branch>), or ask Dave to run it himself.`;
var ghRepoArg = (key) => SAFE_WORD.test(key) && !key.startsWith("local:") ? key : "<owner/repo>";
var appFetchPushWhy = (deps, dir, remote, key, pushKeys, offer) => `remote ${prose(remote)} of ${at(dir)} fetches from ${prose(key)} but pushes to ${prose(pushKeys.join(", "))}, so gh may act on another repo than the tap names. Name the repo gh acts on: add -R ${ghRepoArg(key)} to the command. ${askPart(deps, offer, dir, (c) => `The question for it: ${c}.`)}`;
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
var appUnsafeConfigWhy = (dir, remote, key) => `remote ${prose(remote)} is set as a mirror or has a + push refspec (${prose(key)}) in ${at(dir)}, so this push can rewrite or remove remote refs and stays blocked even with Dave's tap; ask Dave to run it himself or to change that config.`;
var WIDER_WHY = "git config makes this push write more than the branch it names; name both sides: git push <remote> <src>:<dst> --no-recurse-submodules, or ask Dave";
var appWiderConfigWhy = (dir, key) => `${WIDER_WHY}. The key: ${prose(key)} (folder ${at(dir)}).${key === "push.followtags" ? " With push.followTags set, add --no-follow-tags too." : ""} A tap cannot cover it: the tap names one branch.`;
var appWiderOptWhy = (dir, opt) => `${prose(opt)} makes this push write more than the branch it names (tags, other branches or submodule repos) in ${at(dir)}, so it stays blocked even with Dave's tap: a tap names one branch. ${opt.startsWith("-c ") ? "Run git push with no -c push setting" : "Push without that option"}, or ask Dave.`;
var appRawUnsafeWhy = (dir) => `this command holds a git push that is not one plain git push call, and a force or delete spelling is in its text (--force, --mirror, --delete, -f or -d in a short option bundle, or a word that starts with +; folder ${at(dir)}), so it stays blocked even with Dave's tap. Run the push as its own command with no such word in it: git push <remote> <branch>. If a force push is really needed, ask Dave to run it himself.`;
var appUnreadWhy = (dir) => `this command holds a git push that this gate cannot read as one plain git push call (folder ${at(dir)}): a global option or an option it does not know, more than one -C, a shell -c, eval, a control word, a substitution or a git alias. To clear it, ${PUSH_WAY_OUT}, with no global option before push (git -C <folder> push is fine).`;
var appBundleWhy = (dir) => `a short option bundle with o (as in -oh or -uo) gives the rest of the word, or the next word, to the push option (folder ${at(dir)}), so the other flags of this push cannot be read: write -o <value> as its own word (git push -o <value> <remote> <branch>).`;
var appSubagentWhy = (dir) => `a subagent cannot push in ${at(dir)}: Dave's tap belongs to the main session. Ask the main session to do it.`;
var appHeadWhy = (dir) => `the head branch of this create cannot be named in ${at(dir)} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo folder on a branch.`;
var appManyBasesWhy = (dir, bases) => `this create names more than one base branch (${prose(bases.join(", "))}) in ${at(dir)}, so the base its open-pr decision is for cannot be known. Name one base (gh pr create --base <branch>, or one -f base=<branch>).`;
var appHeadReadWhy = (dir, branch) => `cannot read the head of ${prose(branch)} in ${at(dir)}, so its open-pr decision cannot be found. Run the command again from the repo folder.`;
var appRepoUnreadableWhy = (dir) => `the repo this command names is a variable (-R $R, GH_REPO=$X), so it cannot be compared with the repo of ${at(dir)}. Name the repo as owner/repo text.`;
var appRepoDiffersWhy = (deps, dir, named, key, offer) => `this command names ${prose(named)}, but no remote of ${at(dir)} fetches from it (the repo of the folder is ${key === null ? "not known: several remotes and no push target" : prose(key)}). Run it from the folder of the repo it names, or name the repo of one of its remotes. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appRepoUnnamedWhy = (deps, dir, offer, key) => `${at(dir)} has more than one remote, so gh may act on another repo than the tap names. Name the repo: -R ${key === null ? "<owner/repo>" : ghRepoArg(key)} for the branch's push target (@{push}), or the repo of another remote. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
var appPositionWhy = (deps, dir, offer) => `popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, and ${at(dir)} is judged for Dave's tap, so the folder this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd. ${askPart(deps, offer, dir, (c) => `The question for that folder: ${c}.`)}`;
var needsFieldLine = (entryKey, remote) => `the registry entry ${prose(entryKey)} needs a github field naming owner/repo (remote ${prose(remote)} is an SSH host alias, so gh has no repo to act on); tell Dave.`;
var inAppFolder = (dir) => ` The command starts in ${at(dir)}, a folder judged for Dave's tap.`;
var corruptLine = (file) => `WARNING (decision-gate): the project registry ${prose(fwd(file))} cannot be read. Tell Dave.`;
var CORRUPT_EFFECT = "folders outside CCv3 were not checked for Dave's tap (nothing is covered while the file cannot be read)";
var norm = (p) => p.replace(/\\/g, "/").toLowerCase();
var STORE_PATH_RE = /ccv3-mods\/decisions\.json(?:\.|$)/;
var STORE_TEXT_RE = /ccv3-mods\/+decisions\.json(?![\w-])/;
function dropAliasSuffix(p) {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1;
  const leaf = p.slice(cut).replace(/:.*$/s, "").replace(/([^. ])[. ]+$/, "$1");
  return p.slice(0, cut) + leaf;
}
function isStorePath(p, deps, cwd) {
  const full = norm(resolve2(cwd, dropAliasSuffix(p)));
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
function landShapesOf(seg, textOnly = false) {
  const out3 = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out3.push({ kind: "land", pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  if (cli) out3.push({ kind: "merge", pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), sha });
  const api = MERGE_API_RE.exec(seg);
  if (api && !GET_RE.test(api[0])) out3.push({ kind: "merge", pr: api[1], sha });
  return out3;
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
var quotesToBreaks = (view) => view.replace(/["']/g, ";");
var quotesToSpaces = (view) => view.replace(/["']/g, " ");
var PLAIN_QUOTED_CD = /(^|[;&|\r\n(]\s*)((?:cd|chdir)\s+)"(?![A-Za-z]:)([^\s"'%$`^()&|;<>\r\n]+)"(?=\s*(?:$|[;&|\r\n)]))/gi;
var plainCdUnquoted = (view) => {
  if (view.includes("^")) return view;
  return view.replace(PLAIN_QUOTED_CD, (match, lead, cd, path3, offset) => {
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path3} ` : match;
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
    const squashed = squashQuotes(seg);
    if (squashed === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed, squashed, true, before, squashed, kinds));
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
var UNSAFE_LONG = ["mirror", "all", "branches", "tags", "delete", "prune", "force", "force-with-lease", "force-if-includes"];
var PUSH_KEY_RE = /^(?:push|remote|submodule)\./;
var C_OPT_RE = /(?:^|\s)-c\s+((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
function readLongFlag(f, t) {
  const eq = t.indexOf("=");
  const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
  const value = eq < 0 ? null : t.slice(eq + 1).toLowerCase();
  if (UNSAFE_LONG.some((n) => n.startsWith(name))) f.unsafeOpt = true;
  if (name === "no-recurse-submodules") f.noRecurse = true;
  else if (name.length >= 4 && "recurse-submodules".startsWith(name)) {
    if (value === "no" || value === "check") f.noRecurse = true;
    else f.widerOpt ??= t;
  }
  if (name === "no-follow-tags") f.noFollowTags = true;
  else if (name.length >= 3 && "follow-tags".startsWith(name)) f.widerOpt ??= t;
}
function appFlagsOf(tokens, opts) {
  const f = { unsafeOpt: false, oBundle: false, widerOpt: null, noRecurse: false, noFollowTags: false };
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
  if (read.pushes === 0 && !read.odd) return null;
  if (strictWhole(raw, tool, shell)) return { kind: "ok", unread: false };
  return { kind: read.segs.some(forceSpelled) ? "unsafe" : "tap", unread: read.odd || read.pushes > shapedCalls(raw, tool, shell) };
}
function chainStep(base, value, shell) {
  const raw = value.includes("\\") ? unquotePath(value, shell) : value;
  if (hasUnexpandedPart(value)) return UNEXPANDED + raw;
  const t = shell === "bash" ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  if (isUnexpanded(base)) return base;
  return base.startsWith("/") ? posix2.resolve(base, t) : resolve2(base, t);
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
    return [home.startsWith("/") ? posix2.join(home, rest) : join6(home, rest)];
  });
}
var firstCovered = (deps, dirs) => dirs.find((d) => coveredAmong(deps, [d]) !== null) ?? null;
var RAW_CD = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;
function rawDirs(raw, tool, cwd, shell, home) {
  const out3 = [cwd];
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const base of dirsAfter(cwd, call.cds, shell, true)) out3.push(base, chainDir(base, callDirsOf(call), shell));
  }
  const words = raw.replace(/["'`^]/g, "").split(/[\s;&|(){}<>]+/);
  let chained = cwd;
  for (let i = 0; i + 1 < words.length; i++) {
    if (!RAW_CD.test(words[i]) && words[i] !== "-C" && !/^-path$/i.test(words[i])) continue;
    out3.push(chainStep(cwd, words[i + 1], shell));
    chained = chainStep(chained, words[i + 1], shell);
    out3.push(chained);
  }
  return [.../* @__PURE__ */ new Set([...knownDirs(out3, home), ...moveTargets(raw, cwd, shell, home)])];
}
function rawPushDenies(raw, tool, deps, cwd, shell) {
  const v = rawVerdict(raw, tool);
  if (v === null || v.kind === "ok" || v.kind === "tap" && !v.unread) return [];
  const dir = firstCovered(deps, rawDirs(raw, tool, cwd, shell, deps.home));
  if (dir === null) return [];
  return [v.kind === "unsafe" ? deny("push-unsafe", appRawUnsafeWhy(dir), "app-push") : { ...deny("push-target-unresolved", appUnreadWhy(dir), "app-push"), tapPath: true }];
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
var landId = (shape, at2, own, prior) => `${shape.kind}|${shape.pr}|${shape.sha}|${whereId(at2)}${shape.kind === "merge" ? `|${own.ftext}${priorId(prior)}` : ""}`;
var distinctWheres = (wheres) => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);
function shapesOf(raw, tool) {
  const text = normalizeGh(blankInertQuotes(raw, tool));
  const views = [.../* @__PURE__ */ new Set([joinContinuations(text, "bash"), joinContinuations(text, "pwsh")])];
  const textOnly = (tool === "Bash" || tool === "PowerShell") && !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations(raw, "bash"), joinContinuations(raw, "pwsh")].every(isTextOnlyCommand);
  const out3 = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (shape, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out3.push(shape);
    }
  };
  let created = false;
  for (const view of views) {
    const reads = ["Bash", "PowerShell"].map((tool2) => {
      const masked = maskQuoted(view, tool2);
      return { masked, pos: cdPositions(masked, view) };
    });
    for (const { seg, from } of cmdSegments(view)) {
      const wheres = distinctWheres(reads.map((r) => whereAt(r.pos, from)));
      const owns = reads.map(({ masked }) => ownCommand(view, masked, from));
      const prior = priorOf(view, reads.map((r) => r.masked), from);
      for (const s of /* @__PURE__ */ new Set([seg, squashQuotes(seg)])) {
        for (const shape of landShapesOf(s, textOnly)) {
          for (const own of owns) for (const at2 of wheres) add({ ...shape, at: at2, ...own, prior }, landId(shape, at2, own, prior));
        }
      }
      if (!isPrOpenText(seg)) continue;
      created = true;
      for (const own of owns) for (const at2 of wheres) add({ kind: "create", pr: null, at: at2, ...own, prior }, `create|${whereId(at2)}|${own.text}${fullId(own)}${priorId(prior)}`);
    }
  }
  if (!created && isPrOpenCommand(text)) {
    const view = views[0];
    const masked = maskQuoted(view, "Bash");
    for (const at2 of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: "create", pr: null, at: at2, text: view, mtext: masked, ftext: view, fmtext: masked }, `create|${whereId(at2)}|${view}`);
    }
  }
  out3.push(...pushShapesOf(raw, tool));
  return out3;
}
var enforcing = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforce");
var enforcingPush = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforcePush");
function homeFlag(deps, key) {
  try {
    const cfg = JSON.parse(deps.readFile(join6(deps.home, "continuous-claude", "review-router.config.json")) ?? "null");
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
var CD_NAMES = `${spell("cd")}|Set-Location|sl|${spell("chdir")}|${spell("pushd")}|Push-Location`;
var CD_SOURCE = CMD_POS + String.raw`(?:${CD_NAMES})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`;
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
  return isUnexpanded(base) ? base : resolve2(base, t);
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
var UNKNOWN_CD_SOURCE = CMD_POS + String.raw`(?:(?:${spell("popd")}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`;
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
  if (reg.state !== "ok") return reg.state === "corrupt" ? { ...NOT_COVERED, corrupt: reg.file } : NOT_COVERED;
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
  const commonDir = common === "" || absoluteText(common) ? common : resolve2(dir, common);
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
var passOf = (place) => place.corrupt ? { action: "allow", notice: place.corrupt } : ALLOW;
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
  return { named, repo, foreign: repo !== null && repo !== CCV3_REPO, nonLiteral: hasNonLiteralRepo(text) || prior.nonLiteral };
}
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
  constructor(inner) {
    super(String(inner?.message ?? inner));
    this.inner = inner;
    this.name = "AppScopeError";
  }
  inner;
};
var HEAD_FIELD_RE = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/g;
var HEAD_FLAG_RE = /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/g;
var PR_CREATE_CMD_RE = /\bgh\s+pr\s+create\b/i;
function unquotedFlagValue(re, text, mtext) {
  for (const m of text.matchAll(re)) {
    const at2 = m.index + m[0].search(/\S/);
    if (mtext[at2] === text[at2]) return m[1];
  }
  return null;
}
function headBranch(text, mtext, deps, dir) {
  const named = unquotedFlagValue(HEAD_FIELD_RE, text, mtext) ?? (PR_CREATE_CMD_RE.test(text) || PR_CREATE_CMD_RE.test(squashQuotes(text)) ? unquotedFlagValue(HEAD_FLAG_RE, text, mtext) : null);
  if (named) return named.replace(/^[^:\s]+:/, "").replace(/["']+$/, "");
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
var BASE_FIELD_RE = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)(?:\s*|=)["']?base=["']?([^\s"']*)/g;
var BASE_FLAG_RE = /(?:^|\s)(?:--base(?:\s+|=)|-B\s*)["']?([^\s"']*)/g;
function unquotedFlagValues(re, text, mtext) {
  return [...text.matchAll(re)].filter((m) => {
    const i = m.index + m[0].search(/\S/);
    return mtext[i] === text[i];
  }).map((m) => m[1]);
}
function baseBranch(text, mtext) {
  const create = PR_CREATE_CMD_RE.test(text) || PR_CREATE_CMD_RE.test(squashQuotes(text));
  const all = [...unquotedFlagValues(BASE_FIELD_RE, text, mtext), ...create ? unquotedFlagValues(BASE_FLAG_RE, text, mtext) : []].filter((b) => b !== "");
  const distinct = [...new Set(all)];
  return { base: distinct[0] ?? null, many: distinct.length > 1 ? distinct : [] };
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
  if (route === "app") return judgeAppCreate(s.ftext ?? s.text, s.fmtext ?? s.mtext, deps, dir, cmd);
  if (route === "foreign") return deny("repo-foreign", goThereWhy(cmd.repo));
  const branch = headBranch(s.text, s.mtext, deps, dir);
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
  const sha = shape.sha ?? void 0;
  if (shape.kind === "merge" && !sha) return deny("merge-no-head", `${shape.pr ? `PR #${shape.pr}` : "this PR"}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? "<n>"} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? "<n>"}).`);
  const key = decisionKey2({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW : deny("land", landWhy(shape.pr));
}
function judgeAppCreate(text, mtext, deps, dir, cmd) {
  return homeRead(inApp(deps, () => appCreate(text, mtext, deps, dir, cmd)));
}
var homeRead = (d) => d.action === "deny" ? { ...d, homeFlags: true } : d;
function appCreate(text, mtext, deps, dir, cmd) {
  const place = appPlace(deps, dir);
  if (!place.covered) return passOf(place);
  const branch = headBranch(text, mtext, deps, dir);
  if (branch === "") return deny("head-unresolved", appHeadWhy(dir));
  const { base, many } = baseBranch(text, mtext);
  if (many.length > 0) return deny("base-unresolved", appManyBasesWhy(dir, many));
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
  const place = appPlace(deps, dir);
  if (!place.covered) return passOf(place);
  if (shape.pr === null) return deny("no-pr", appNoPrWhy(dir));
  const repo = appRepoFor(cmd, deps, dir, place, { sub: "merge", pr: shape.pr });
  if ("action" in repo) return repo;
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
  return isUnexpanded(base) ? base : resolve2(base, t);
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
function unexpandedDeny(deps, dirs, lost, scope, appScope) {
  const dir = firstCovered(deps, knownDirs(dirs, deps.home));
  return dir === null ? deny("cd-unexpanded", unexpandedWhy(lost), scope) : { ...deny("cd-unexpanded", unexpandedWhy(lost) + inAppFolder(dir), appScope), tapPath: true, homeFlags: true };
}
function appPositionAt(deps, dirs, scope, offer) {
  let notice = null;
  for (const dir of dirs) {
    const place = appPlace(deps, dir);
    if (place.covered) return [{ ...deny("position-unknown", inApp(deps, () => appPositionWhy(deps, dir, offer)), scope), homeFlags: true }];
    notice ??= place.corrupt;
  }
  return notice === null ? [] : [{ action: "allow", notice }];
}
var pushOffer = (p) => ({ sub: "push", remote: p.remote });
function judgePushAt(s, deps, cwd, shell, ctx) {
  const { subagent, chained, alone } = ctx;
  const p = s.push;
  const dirs = pushDirsOf(p, cwd, shell);
  const chainOnly = chainDirsOf(p, cwd, shell).filter((d) => !dirs.includes(d) && firstCovered(deps, [d]) !== null);
  const fromChain = chainOnly.map((d) => judgeAppPushAt(s, deps, d, subagent, chained, alone, ctx.flow));
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0) return [unexpandedDeny(deps, [cwd, ...dirs], lost, "push", "app-push")];
  const fixedByDir = p.dir !== null && resolveDir("/a", p.dir, shell) === resolveDir("/b", p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const all = [.../* @__PURE__ */ new Set([cwd, ...dirs])];
    const ccv3 = all.some((d) => isCcv3Checkout(deps, d));
    if (ccv3) return [deny("position-unknown", POSITION_WHY, "push")];
    const app = appPositionAt(deps, all, "app-push", pushOffer(p));
    if (app.some((d) => d.action === "deny")) return app;
  }
  return [...fromChain, ...dirs.map((d) => judgePush(s, deps, d, ctx))];
}
function remoteKind(remote) {
  const r = remote.toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return "origin";
  return r === "fork" || r.includes(CCV3_REPO) ? "fork" : null;
}
function judgePush(shape, deps, dir, ctx) {
  const { subagent, chained, alone } = ctx;
  const p = shape.push;
  const d = (pattern, why) => deny(pattern, why, "push");
  if (p.moved) {
    const what = "--git-dir or --work-tree moves the repo, so the checkout is unknown";
    const app = firstCovered(deps, moveTargets(ctx.text, dir, ctx.shell, deps.home)) ?? coveredAmong(deps, [dir]);
    return app === null ? d("push-target-unresolved", pushUnresolvedWhy(what)) : deny("push-target-unresolved", appPushUnresolvedWhy(app, what), "app-push");
  }
  if (!isCcv3Checkout(deps, dir)) return judgeAppPushAt(shape, deps, dir, subagent, chained, alone, ctx.flow);
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
  if (kind === "origin") return d("push-origin", PUSH_ORIGIN_WHY);
  if (kind === null) return ALLOW;
  if (subagent) return d("subagent", SUBAGENT_WHY);
  if (p.force) return d("push-unsafe", PUSH_UNSAFE_WHY);
  const branch = p.branch ?? currentBranch(deps, dir);
  if (branch === "") return d("push-target-unresolved", pushUnresolvedWhy("the branch of this push cannot be named (detached HEAD?)"));
  if (branch === "main") return ALLOW;
  const texts = {
    notRef: (ref) => pushUnresolvedWhy(`${ref} is not a ref`),
    tree: (what) => `cannot read the tree of ${what} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`,
    ship: () => pushWhy(branch)
  };
  return shipTap({ p, deps, dir, chained, alone, key: decisionKey2({ branch }), scope: "push", texts });
}
function currentBranch(deps, dir) {
  const r = deps.git(dir, ["branch", "--show-current"]);
  if (r.status !== 0) throw new Error("git branch --show-current failed");
  return r.stdout.trim();
}
function shipTap({ p, deps, dir, chained, alone, key, scope, texts }) {
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return deny("push-target-unresolved", texts.notRef(ref), scope);
  const viaIndex = chained && p.dir === null && (p.src === null || deps.git(dir, ["branch", "--show-current"]).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ["write-tree"]) : deps.git(dir, ["rev-parse", `${ref}^{tree}`]);
  if (r.status !== 0) return deny("push-tree-unresolved", texts.tree(viaIndex ? "the index (git write-tree)" : ref), scope);
  const tree = r.stdout.trim();
  const ok = decisionRows(deps.env).some((row) => row.step === "ship" && row.key === key && (isShipLabel(row.label) || !viaIndex && alone && isPushOnlyLabel(row.label)) && row.tree !== null && row.tree === tree);
  return ok ? ALLOW : deny("ship", texts.ship(), scope);
}
function judgeAppPushAt(shape, deps, dir, subagent, chained, alone, flow) {
  const place = appPlace(deps, dir);
  if (!place.covered) return passOf(place);
  try {
    return inApp(deps, () => judgeAppPush(shape, deps, dir, place, subagent, chained, alone, flow));
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
function judgeAppPush(shape, deps, dir, place, subagent, chained, alone, flow) {
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
  const r = shipTap({ p: q, deps, dir, chained, alone, key: decisionKey2({ repo: k.key, branch: k.branch }), scope: "app-push", texts });
  return r.action === "deny" ? { ...r, tapPath: true } : r;
}
var MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function movesRepo(text) {
  return MOVE_ENV_RAW.test(text) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes(text));
}
function judgeCommand(input, deps, notes) {
  const cmd = readShellCommand(input);
  if (cmd.kind !== "command" || cmd.text === "") return [];
  const cwd = input.cwd || process.cwd();
  if (writesStoreText(cmd.text, deps)) return [deny("store-write", STORE_WHY)];
  const shapes = shapesOf(cmd.text, cmd.tool);
  const denies = [];
  if (input.agent_id && shapes.some((s) => s.kind !== "push")) denies.push(deny("subagent", SUBAGENT_WHY));
  const pushes = shapes.filter((s) => s.kind === "push");
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== "push");
  const shell = shellOf(input);
  const add = (d) => {
    if (!denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope && o.tapPath === d.tapPath)) denies.push(d);
  };
  if (pushes.length > 0 || rest.length > 0) {
    const named = namedRepo(cmd.text, deps.env);
    const chained = pushes.length > 0 && commitPrecedesPush(cmd.text, shell);
    const alone = pushes.length > 0 && pushesAlone(cmd.text, shell);
    const moved = movesRepo(cmd.text);
    for (const s of [...rest, ...pushes]) {
      if (moved && s.kind !== "land") {
        denies.push(movedDeny(s, deps, cwd, shell, cmd.text));
        continue;
      }
      const found = s.kind === "push" ? judgePushAt(s, deps, cwd, shell, { subagent: Boolean(input.agent_id), chained, alone, flow: pushes.length > 0 && shipFlow(cmd.text, shell), text: cmd.text, shell }) : judgeAt(s, deps, cwd, shell, named);
      for (const d of found) {
        if (d.action === "deny") add(d);
        else if (d.notice) notes.add(d.notice);
      }
    }
  }
  for (const d of rawPushDenies(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  return denies;
}
function movedDeny(s, deps, cwd, shell, text) {
  const dirs = s.kind === "push" ? pushDirsOf(s.push, cwd, shell) : dirsAfter(cwd, s.at.cds, shell, s.at.loose);
  const targets = s.kind === "push" ? [...new Set([cwd, ...dirs].flatMap((d) => isUnexpanded(d) ? [] : moveTargets(text, d, shell, deps.home)))] : [];
  const dir = firstCovered(deps, targets) ?? coveredAmong(deps, [cwd, ...dirs].filter((d) => !isUnexpanded(d)));
  if (s.kind === "push") {
    return dir === null ? deny("push-target-unresolved", pushUnresolvedWhy(MOVED_WHY), "push") : deny("push-target-unresolved", MOVED_WHY + inAppFolder(dir), "app-push");
  }
  return dir === null ? deny("repo-moved", MOVED_WHY) : { ...deny("repo-moved", MOVED_WHY + inAppFolder(dir)), homeFlags: true };
}
function judgeWrite(input, deps) {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === "string" && isStorePath(args[f], deps, cwd));
  return hit ? [deny("store-write", STORE_WHY)] : [];
}
function judge(input, deps, notes) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS.has(tool)) return judgeWrite(input, deps);
  return COMMAND_TOOLS2.has(tool) ? judgeCommand(input, deps, notes) : [];
}
function decide(input, deps) {
  const notes = /* @__PURE__ */ new Set();
  const call = perCall(deps);
  CWDS.set(call, input.cwd || process.cwd());
  const denies = judge(input, call, notes);
  const notice = notes.size === 0 ? {} : { notice: [...notes][0] };
  if (denies.length === 0) return notes.size === 0 ? ALLOW : { action: "allow", ...notice };
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => hardAppDeny(d) || enforcingScope(d.scope, deps, cwd, d.homeFlags));
  if (live) {
    const { tapPath: _tap, homeFlags: _home, ...shown } = live;
    return { ...shown, ...notice };
  }
  return { action: "allow", warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope, ...notice };
}
var hardAppDeny = (d) => d.scope === "app-push" && d.tapPath !== true;
function perCall(deps) {
  const seen = /* @__PURE__ */ new Map();
  const mode = { app: false };
  const git = (cwd, args) => {
    const run = mode.app && deps.appGit ? deps.appGit : deps.git;
    const key = `${run === deps.git ? "" : "app\0"}${cwd}\0${args.join("\0")}`;
    let hit = seen.get(key);
    if (!hit) {
      try {
        hit = { ok: run(cwd, args) };
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
var out2 = (extra) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...extra } });
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
  try {
    const d = decide(input, deps);
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
    if (d.notice) logGuardDecision(HOOK, input, "warn", `registry-corrupt ${fwd(d.notice)}: ${CORRUPT_EFFECT}`);
    return shown;
  } catch (err) {
    return unjudgeable(input, deps, err);
  }
}
function unjudgeable(input, deps, thrown) {
  const app = thrown instanceof AppScopeError || pushUnderLiveRoot(input, deps);
  const err = thrown instanceof AppScopeError ? thrown.inner : thrown;
  const gone = err instanceof MissingCwdError;
  if (!gone) {
    try {
      logGuardError(HOOK, err);
    } catch {
    }
  }
  const scopes = gatedScopesSafe(input, app);
  if (scopes.size === 0) return "{}";
  const raw = gone ? err.message : String(err?.message ?? err).slice(0, 160);
  const detail = app ? prose(raw) : raw;
  const hint = gone ? "Run the command from a folder that exists." : "Run the command again. If it keeps failing, ask Dave.";
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  const cwd = input.cwd || process.cwd();
  const live = app && hardAppCall(input) || [...scopes].some((s) => enforcingScope(s, deps, cwd, app));
  if (gone) logGuardDecision(HOOK, input, live ? "deny" : "warn", "cwd-missing");
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has("other") ? "other" : scopes.has("app-push") ? "app-push" : "push");
}
var gatedScopesSafe = (input, app = false) => {
  try {
    return gatedScopes(input, app);
  } catch {
    return /* @__PURE__ */ new Set();
  }
};
function hardAppCall(input) {
  try {
    const cmd = readShellCommand(input);
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
  const cmd = readShellCommand(input);
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
    const cmd = readShellCommand(input);
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
  const spawn = opts.spawn ?? ((cmd, args, o) => spawnSync(cmd, args, o));
  const exists = opts.exists ?? existsSync2;
  return (cwd, args) => {
    const left = opts.deadline === void 0 ? GIT_TIMEOUT_MS : opts.deadline - now();
    if (left <= 0) throw new GitDeadlineError(args);
    if (!exists(cwd)) throw new MissingCwdError(cwd);
    const r = spawn("git", args, { cwd, encoding: "utf8", timeout: Math.min(GIT_TIMEOUT_MS, left), windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function realDeps(opts = {}) {
  const { start, ...run } = opts;
  let registry = null;
  return {
    git: makeGit(run),
    appGit: makeGit({ ...run, deadline: (start ?? Date.now()) + HOOK_BUDGET_MS }),
    readFile: (p) => {
      try {
        return existsSync2(p) ? readFileSync5(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir5(),
    tapScope: { registry: () => registry ??= readRegistry({ env: process.env }) }
  };
}
async function main2() {
  const start = Date.now();
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString("utf-8"), realDeps({ start })));
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
  WRITE_TOOLS,
  decide,
  handle,
  isLandLabel,
  isMergeNowLabel,
  isOpenPrLabel,
  isPushOnlyLabel,
  isShipLabel,
  makeGit,
  pushShapesOf,
  realDeps
};
