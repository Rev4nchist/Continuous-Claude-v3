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
import { existsSync as existsSync2, readFileSync as readFileSync4 } from "fs";
import { homedir as homedir4 } from "os";
import { isAbsolute, resolve as resolve2 } from "path";

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
function inertSpans(command, tool) {
  const none = /* @__PURE__ */ new Set();
  const plain = plainSegments(command, tool);
  if (!plain) return none;
  const out2 = /* @__PURE__ */ new Set();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches(PLAIN_HEAD, masked, raw)) continue;
    if (!headMatches(INERT_HEAD, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out2.add(`${s}:${e}`);
  }
  return out2;
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
  const bash = inertSpans(command, "Bash");
  const pwsh = inertSpans(command, "PowerShell");
  let out2 = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(":").map(Number);
    out2 = out2.slice(0, s + 1) + " ".repeat(e - s - 2) + out2.slice(e - 1);
  }
  return out2;
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
  const out2 = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out2.push({ kind: "land", pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  if (cli) out2.push({ kind: "merge", pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), sha });
  const api = MERGE_API_RE.exec(seg);
  if (api && !GET_RE.test(api[0])) out2.push({ kind: "merge", pr: api[1], sha });
  return out2;
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
function pushCallsOf(masked, raw, atStart, before = { cds: [], unknown: false, loose: false }, cutView = masked) {
  const calls = [];
  const kinds = [[PUSH_GIT, isGitToken], [PUSH_SAFE, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
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
        unknown: before.unknown || own.unknown
      });
    }
  }
  return calls;
}
var quotesToBreaks = (view) => view.replace(/["']/g, ";");
function pushCallsIn(raw, cmdExe = false) {
  const bash = joinContinuations(raw, "bash");
  const pwsh = joinContinuations(raw, "pwsh");
  const maskedBash = maskQuoted(bash, "Bash");
  const maskedPwshOnBash = maskQuoted(bash, "PowerShell");
  const maskedPwsh = maskQuoted(pwsh, "PowerShell");
  const calls = [...pushCallsOf(maskedBash, bash, false), ...pushCallsOf(maskedPwsh, pwsh, false)];
  if (cmdExe) {
    if (maskedBash !== bash) calls.push(...pushCallsOf(quotesToBreaks(bash), bash, false, void 0, bash));
    if (maskedPwsh !== pwsh) calls.push(...pushCallsOf(quotesToBreaks(pwsh), pwsh, false, void 0, pwsh));
  }
  let from = 0;
  const breaks = [...maskedBash.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index, m.index + m[0].length]);
  for (const [start, next] of [...breaks, [bash.length, bash.length]]) {
    const seg = bash.slice(from, start);
    const lists = [cdsBefore(maskedBash.slice(0, from), bash.slice(0, from)), cdsBefore(maskedPwshOnBash.slice(0, from), bash.slice(0, from))];
    from = next;
    const squashed = squashQuotes(seg);
    if (squashed === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed, squashed, true, before));
  }
  return calls;
}
var REF_HEADS = /^refs\/heads\//;
function pushShapesFrom(call) {
  const tokens = call.args.replace(REDIRECT_RE, " ").split(/\s+/).map(squashQuotes).filter(Boolean);
  const dirs = [...call.opts.matchAll(DIR_OPT_RE), ...call.opts.matchAll(PATH_OPT_RE)].sort((a, b) => a.index - b.index);
  const dir = dirs.map((m) => squashQuotes(m[1])).pop() ?? null;
  const positional = [];
  let force = false;
  let quiet = false;
  let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (literal || !t.startsWith("-") || t === "-") {
      positional.push(t);
      continue;
    }
    if (t === "--") {
      literal = true;
      continue;
    }
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
  const base = { remote, dir, cds: call.cds, loose: call.loose, unknown: call.unknown, moved: MOVE_OPT_RE.test(` ${call.opts}`) };
  if (specs.length === 0) return [{ kind: "push", pr: null, push: { ...base, branch: null, src: null, force } }];
  const out2 = [];
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
    out2.push({ kind: "push", pr: null, push: { ...base, branch: name === "" || name === "HEAD" ? null : name, src: src === "" || src === "HEAD" ? null : src, force: rewrite } });
  }
  return out2;
}
function pushShapesOf(raw, tool) {
  const out2 = [];
  const seen = /* @__PURE__ */ new Set();
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const shape of pushShapesFrom(call)) {
      const p = shape.push;
      const id = [p.remote, p.branch, p.src, p.dir, p.force, p.moved, p.loose, p.unknown, p.cds.join("\0")].join("|");
      if (!seen.has(id)) {
        seen.add(id);
        out2.push(shape);
      }
    }
  }
  return out2;
}
function cmdSegments(view) {
  const out2 = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE.source, "g"))) {
    out2.push({ seg: view.slice(from, m.index), from });
    from = m.index + m[0].length;
  }
  out2.push({ seg: view.slice(from), from });
  return out2;
}
var whereId = (at) => `${at.unknown ? "?" : ""}${at.loose ? "~" : ""}${at.cds.join("\0")}`;
var distinctWheres = (wheres) => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);
function shapesOf(raw, tool) {
  const text = normalizeGh(blankInertQuotes(raw, tool));
  const views = [.../* @__PURE__ */ new Set([joinContinuations(text, "bash"), joinContinuations(text, "pwsh")])];
  const textOnly = (tool === "Bash" || tool === "PowerShell") && !PR_NUMBER_IN_TEXT_RE.test(raw) && [raw, joinContinuations(raw, "bash"), joinContinuations(raw, "pwsh")].every(isTextOnlyCommand);
  const out2 = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (shape, id) => {
    if (!seen.has(id)) {
      seen.add(id);
      out2.push(shape);
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
      for (const s of /* @__PURE__ */ new Set([seg, squashQuotes(seg)])) {
        for (const shape of landShapesOf(s, textOnly)) {
          for (const at of wheres) add({ ...shape, at }, `${shape.kind}|${shape.pr}|${shape.sha}|${whereId(at)}`);
        }
      }
      if (!isPrOpenText(seg)) continue;
      created = true;
      for (const { masked } of reads) {
        const cut = masked.slice(from).search(SEGMENT_RE);
        const to = cut < 0 ? view.length : from + cut;
        const own = view.slice(from, to);
        for (const at of wheres) add({ kind: "create", pr: null, at, text: own, mtext: masked.slice(from, to) }, `create|${whereId(at)}|${own}`);
      }
    }
  }
  if (!created && isPrOpenCommand(text)) {
    const view = views[0];
    const masked = maskQuoted(view, "Bash");
    for (const at of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: "create", pr: null, at, text: view, mtext: masked }, `create|${whereId(at)}|${view}`);
    }
  }
  out2.push(...pushShapesOf(raw, tool));
  return out2;
}
var enforcing = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforce");
var enforcingPush = (deps, cwd) => routerFlag(cwd, deps.readFile, deps.home, "decisions", "enforcePush");
var enforcingScope = (scope, deps, cwd) => scope === "push" ? enforcingPush(deps, cwd) : enforcing(deps, cwd);
var FLAG_OF = { push: "decisions.enforcePush", other: "decisions.enforce" };
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
var absoluteText = (t) => isAbsolute(t) || /^[A-Za-z]:/.test(t);
function moveTo(base, target, shell) {
  const raw = shell === "pwsh" ? target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, s) => d ?? s ?? "").trimEnd() : target.replace(/\\([ "'])|["']/g, (_m, esc) => esc ?? "");
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
var HEAD_FIELD_RE = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/g;
var HEAD_FLAG_RE = /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/g;
var PR_CREATE_CMD_RE = /\bgh\s+pr\s+create\b/i;
function unquotedFlagValue(re, text, mtext) {
  for (const m of text.matchAll(re)) {
    const at = m.index + m[0].search(/\S/);
    if (mtext[at] === text[at]) return m[1];
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
function segmentsOf(raw, shell) {
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
      seq.push(segmentKind(ms, view.slice(from, start)));
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
function judgeCreate(text, mtext, deps, dir, named) {
  if (named !== CCV3_REPO && !isCcv3Checkout(deps, dir)) return ALLOW;
  const branch = headBranch(text, mtext, deps, dir);
  if (branch === "") return deny("head-unresolved", `the head branch of this create cannot be named in ${dir} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo on a branch.`);
  if (branch === "main") return ALLOW;
  const r = deps.git(dir, ["rev-parse", `${branch}^{commit}`]);
  if (r.status !== 0) return deny("head-unresolved", `cannot read the head of ${branch} in ${dir}, so its open-pr decision cannot be found. Run the command again from the repo.`);
  const head = r.stdout.trim();
  const d = decisionRead2({ step: "open-pr", key: decisionKey2({ branch }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny("open-pr", openPrWhy(branch, head));
}
function judgeLand(shape, deps, dir, named) {
  if (shape.kind === "merge" && named !== CCV3_REPO && !isCcv3Checkout(deps, dir)) return ALLOW;
  if (shape.pr === null) return deny("no-pr", NO_PR_WHY);
  const sha = shape.sha ?? void 0;
  if (shape.kind === "merge" && !sha) return deny("merge-no-head", `${shape.pr ? `PR #${shape.pr}` : "this PR"}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? "<n>"} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? "<n>"}).`);
  const key = decisionKey2({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === "land" && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW : deny("land", landWhy(shape.pr));
}
function resolveDir(base, raw, shell) {
  if (hasUnexpandedPart(raw)) return UNEXPANDED + raw;
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
  const at = s.at;
  const dirs = dirsAfter(cwd, at.cds, shell, at.loose);
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0 && s.kind !== "land") return [deny("cd-unexpanded", unexpandedWhy(lost))];
  if (at.unknown && s.kind !== "land") {
    const ccv3 = named === CCV3_REPO || [.../* @__PURE__ */ new Set([cwd, ...dirs])].some((d) => isCcv3Checkout(deps, d));
    return ccv3 ? [deny("position-unknown", POSITION_WHY)] : [];
  }
  return dirs.map((d) => s.kind === "create" ? judgeCreate(s.text, s.mtext, deps, d, named) : judgeLand(s, deps, d, named));
}
function judgePushAt(s, deps, cwd, shell, subagent, chained, alone) {
  const p = s.push;
  const dirs = pushDirsOf(p, cwd, shell);
  const lost = dirs.find(isUnexpanded);
  if (lost !== void 0) return [deny("cd-unexpanded", unexpandedWhy(lost), "push")];
  const fixedByDir = p.dir !== null && resolveDir("/a", p.dir, shell) === resolveDir("/b", p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const ccv3 = [.../* @__PURE__ */ new Set([cwd, ...dirs])].some((d) => isCcv3Checkout(deps, d));
    if (ccv3) return [deny("position-unknown", POSITION_WHY, "push")];
  }
  return dirs.map((d) => judgePush(s, deps, d, subagent, chained, alone));
}
function remoteKind(remote) {
  const r = remote.toLowerCase();
  if (r === "origin" || r.includes("parcadei")) return "origin";
  return r === "fork" || r.includes(CCV3_REPO) ? "fork" : null;
}
function judgePush(shape, deps, dir, subagent, chained, alone) {
  const p = shape.push;
  const d = (pattern, why) => deny(pattern, why, "push");
  if (p.moved) return d("push-target-unresolved", pushUnresolvedWhy("--git-dir or --work-tree moves the repo, so the checkout is unknown"));
  if (!isCcv3Checkout(deps, dir)) return ALLOW;
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
  let branch = p.branch;
  if (branch === null) {
    const r2 = deps.git(dir, ["branch", "--show-current"]);
    if (r2.status !== 0) throw new Error("git branch --show-current failed");
    branch = r2.stdout.trim();
  }
  if (branch === "") return d("push-target-unresolved", pushUnresolvedWhy("the branch of this push cannot be named (detached HEAD?)"));
  if (branch === "main") return ALLOW;
  const ref = p.src ?? "HEAD";
  if (ref.startsWith("-")) return d("push-target-unresolved", pushUnresolvedWhy(`${ref} is not a ref`));
  const viaIndex = chained && p.dir === null && (p.src === null || deps.git(dir, ["branch", "--show-current"]).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ["write-tree"]) : deps.git(dir, ["rev-parse", `${ref}^{tree}`]);
  if (r.status !== 0) return d("push-tree-unresolved", `cannot read the tree of ${viaIndex ? "the index (git write-tree)" : ref} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`);
  const tree = r.stdout.trim();
  const key = decisionKey2({ branch });
  const ok = decisionRows(deps.env).some((row) => row.step === "ship" && row.key === key && (isShipLabel(row.label) || !viaIndex && alone && isPushOnlyLabel(row.label)) && row.tree !== null && row.tree === tree);
  return ok ? ALLOW : d("ship", pushWhy(branch));
}
var MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
var MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
var CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
var MOVED_WHY = "GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.";
function movesRepo(text) {
  return MOVE_ENV_RAW.test(text) || ["Bash", "PowerShell"].some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes(text));
}
function judgeCommand(input, deps) {
  const cmd = readShellCommand(input);
  if (cmd.kind !== "command" || cmd.text === "") return [];
  const cwd = input.cwd || process.cwd();
  if (writesStoreText(cmd.text, deps)) return [deny("store-write", STORE_WHY)];
  const shapes = shapesOf(cmd.text, cmd.tool);
  const denies = [];
  if (input.agent_id && shapes.some((s) => s.kind !== "push")) denies.push(deny("subagent", SUBAGENT_WHY));
  const pushes = shapes.filter((s) => s.kind === "push");
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== "push");
  if (pushes.length === 0 && rest.length === 0) return denies;
  const shell = shellOf(input);
  const named = namedRepo(cmd.text, deps.env);
  const chained = pushes.length > 0 && commitPrecedesPush(cmd.text, shell);
  const alone = pushes.length > 0 && pushesAlone(cmd.text, shell);
  const moved = movesRepo(cmd.text);
  for (const s of [...rest, ...pushes]) {
    if (moved && s.kind !== "land") {
      denies.push(s.kind === "push" ? deny("push-target-unresolved", pushUnresolvedWhy(MOVED_WHY), "push") : deny("repo-moved", MOVED_WHY));
      continue;
    }
    const found = s.kind === "push" ? judgePushAt(s, deps, cwd, shell, Boolean(input.agent_id), chained, alone) : judgeAt(s, deps, cwd, shell, named);
    for (const d of found) {
      if (d.action === "deny" && !denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope)) denies.push(d);
    }
  }
  return denies;
}
function judgeWrite(input, deps) {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === "string" && isStorePath(args[f], deps, cwd));
  return hit ? [deny("store-write", STORE_WHY)] : [];
}
function judge(input, deps) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS.has(tool)) return judgeWrite(input, deps);
  return COMMAND_TOOLS2.has(tool) ? judgeCommand(input, deps) : [];
}
function decide(input, deps) {
  const denies = judge(input, deps);
  if (denies.length === 0) return ALLOW;
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => enforcingScope(d.scope, deps, cwd));
  if (live) return live;
  return { action: "allow", warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope };
}
var out = (extra) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...extra } });
var denyOut = (reason) => out({ permissionDecision: "deny", permissionDecisionReason: reason });
var warnOut = (text, scope = "other") => out({ additionalContext: `WARNING (decision-gate, warn mode): this command would be blocked when ${FLAG_OF[scope]} is true. ${text.replace(/^BLOCKED \(decision-gate\): /, "")}` });
function gatedScopes(input) {
  const tool = input.tool_name || input.tool || "";
  if (WRITE_TOOLS.has(tool)) return /* @__PURE__ */ new Set(["other"]);
  const cmd = readShellCommand(input);
  return new Set(cmd.kind === "command" ? shapesOf(cmd.text, cmd.tool).map(scopeOf) : []);
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
    if (d.action === "allow" && d.warn) {
      logGuardDecision(HOOK, input, "warn", d.warn.split(":")[0]);
      return warnOut(d.warn.slice(d.warn.indexOf(":") + 2), d.scope);
    }
    if (d.action === "deny") {
      logGuardDecision(HOOK, input, "deny", d.pattern);
      return denyOut(d.reason);
    }
    return "{}";
  } catch (err) {
    return unjudgeable(input, deps, err);
  }
}
function unjudgeable(input, deps, err) {
  const gone = err instanceof MissingCwdError;
  if (!gone) {
    try {
      logGuardError(HOOK, err);
    } catch {
    }
  }
  const scopes = gatedScopesSafe(input);
  if (scopes.size === 0) return "{}";
  const detail = gone ? err.message : String(err?.message ?? err).slice(0, 160);
  const hint = gone ? "Run the command from a folder that exists." : "Run the command again. If it keeps failing, ask Dave.";
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  const cwd = input.cwd || process.cwd();
  const live = [...scopes].some((s) => enforcingScope(s, deps, cwd));
  if (gone) logGuardDecision(HOOK, input, live ? "deny" : "warn", "cwd-missing");
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has("other") ? "other" : "push");
}
var gatedScopesSafe = (input) => {
  try {
    return gatedScopes(input);
  } catch {
    return /* @__PURE__ */ new Set();
  }
};
var MissingCwdError = class extends Error {
  constructor(cwd) {
    super(`the working folder does not exist: ${cwd}`);
    this.cwd = cwd;
    this.name = "MissingCwdError";
  }
  cwd;
};
function makeGit() {
  return (cwd, args) => {
    if (!existsSync2(cwd)) throw new MissingCwdError(cwd);
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function realDeps() {
  return {
    git: makeGit(),
    readFile: (p) => {
      try {
        return existsSync2(p) ? readFileSync4(p, "utf8") : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir4()
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
    console.error("decision-gate: stdin could not be read; the call is allowed.");
    console.log("{}");
  });
}
export {
  COMMAND_TOOLS2 as COMMAND_TOOLS,
  MissingCwdError,
  WRITE_TOOLS,
  decide,
  handle,
  isLandLabel,
  isOpenPrLabel,
  isPushOnlyLabel,
  isShipLabel,
  makeGit
};
