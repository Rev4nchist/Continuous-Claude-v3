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

// src/coderabbit-guard.ts
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "path";

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}
function outputDeny(reason, decision = "deny") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
}

// ../../scripts/github/lib/answer-paths.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

// ../../scripts/ratchets/lib/review-md.mjs
var CannotCompare = class extends Error {
};
var lines = (text) => String(text).split(/\r?\n/);
function parseReviewMd(text) {
  const all = lines(text);
  const at = all.findIndex((l) => /^##\s+Skip paths\s*$/i.test(l));
  if (at < 0) throw new CannotCompare('REVIEW.md has no "## Skip paths" section');
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const section = end < 0 ? rest : rest.slice(0, end);
  const open = section.findIndex((l) => /^```/.test(l));
  const close = open < 0 ? -1 : section.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  if (open < 0 || close < 0) throw new CannotCompare('REVIEW.md "Skip paths" has no fenced block');
  const globs = section.slice(open + 1, close).map((l) => l.trim()).filter(Boolean);
  if (globs.length === 0) throw new CannotCompare('REVIEW.md "Skip paths" block is empty');
  return globs;
}

// ../../scripts/github/lib/answer-paths.mjs
var escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
var segmentToRe = (seg) => escapeRe(seg).replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]");
function globToRegExp(glob) {
  if (typeof glob !== "string" || glob === "") throw new Error("empty glob");
  const segs = glob.split("/");
  let re = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") re += last ? ".+" : "(?:[^/]+/)*";
    else re += segmentToRe(seg) + (last ? "" : "/");
  });
  return new RegExp(`^${re}$`);
}
var matchGlob = (glob, p) => globToRegExp(glob).test(p);
var ANSWER_KEY_GLOBS = Object.freeze([
  "scripts/eval/review-eval/gold/**",
  "scripts/eval/review-eval/seeds/**",
  "scripts/eval/review-eval/rubrics/**",
  "scripts/eval/review-eval/linktype-labels.json"
]);
var slashLower = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
function answerKeyGlobs(root) {
  let text;
  try {
    text = readFileSync(path.join(root, "REVIEW.md"), "utf8");
  } catch (err) {
    return { reason: `REVIEW.md could not be read (${err.code ?? "error"})` };
  }
  let listed;
  try {
    listed = parseReviewMd(text).map(slashLower);
  } catch (err) {
    return { reason: String(err.message) };
  }
  const missing = ANSWER_KEY_GLOBS.filter((g) => !listed.includes(slashLower(g)));
  return missing.length === 0 ? { globs: ANSWER_KEY_GLOBS } : { reason: `REVIEW.md "Skip paths" lacks ${missing.join(", ")}` };
}
function answerKeyCheck({ root, paths }) {
  if (!Array.isArray(paths)) return { closed: "the changed-file list is unknown" };
  const { globs, reason } = answerKeyGlobs(root);
  if (!globs) return { closed: reason };
  const hits = paths.filter((p) => globs.some((g) => matchGlob(slashLower(g), slashLower(p))));
  return hits.length === 0 ? null : { hits };
}

// src/coderabbit-guard.ts
var BASH_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var DELEGATE_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent", "Skill"]);
var STATE_BASENAME = "coderabbit-guard-runs.json";
var MAX_RUNS = 2;
var OVERRIDE = /^\s*(?:SKIP_CODERABBIT_GUARD=1\s|\$env:SKIP_CODERABBIT_GUARD\s*=\s*1\s*[;\n])/;
function statePath(env = process.env) {
  const base = env.CCV3_CODERABBIT_GUARD_STATE || join3(tmpdir(), STATE_BASENAME);
  return base;
}
function readState(path2) {
  try {
    if (!existsSync(path2)) return { counts: {} };
    const parsed = JSON.parse(readFileSync2(path2, "utf8"));
    return { counts: parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : {} };
  } catch {
    return { counts: {} };
  }
}
function writeState(path2, state) {
  const tmp = `${path2}.${process.pid}.tmp`;
  try {
    mkdirSync2(dirname2(path2), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path2);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
    }
  }
}
var FILL = "\0";
function hasClosing(s, from, quote, esc) {
  for (let k = from; k < s.length; k++) {
    if (quote === '"' && s[k] === esc) k++;
    else if (s[k] === quote) return true;
  }
  return false;
}
function closingParen(s, from) {
  let depth = 0;
  for (let k = from; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")" && depth-- === 0) return k;
  }
  return -1;
}
function startsWord(command, i) {
  return i === 0 || /[\s;|&(]/.test(command[i - 1]);
}
function joinContinuations(command, ps = false) {
  const esc = ps ? "`" : "\\";
  if (!command.includes(`${esc}
`) && !command.includes(`${esc}\r
`)) return command;
  const n = command.length;
  let out = "";
  let quote = "";
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      out += c;
      i++;
    } else if (c === esc) {
      const pair = command.startsWith("\n", i + 1) ? 2 : command.startsWith("\r\n", i + 1) ? 3 : 0;
      if (pair) i += pair;
      else {
        out += command.slice(i, i + 2);
        i += 2;
      }
    } else if (quote === '"') {
      if (c === '"') quote = "";
      out += c;
      i++;
    } else if (c === "#" && startsWord(out, out.length)) {
      const eol = command.indexOf("\n", i);
      const stop = eol < 0 ? n : eol;
      out += command.slice(i, stop);
      i = stop;
    } else if (ps && c === "<" && command[i + 1] === "#") {
      const close = command.indexOf("#>", i + 2);
      const stop = close < 0 ? n : close + 2;
      out += command.slice(i, stop);
      i = stop;
    } else {
      if (c === "'" && command.indexOf("'", i + 1) > 0 || c === '"' && hasClosing(command, i + 1, '"', esc)) quote = c;
      out += c;
      i++;
    }
  }
  return out;
}
function lexShell(command, ps = false) {
  const n = command.length;
  const text = command.split("");
  const out = command.split("");
  const dqSubs = /* @__PURE__ */ new Set();
  const bodies = /* @__PURE__ */ new Set();
  const execs = [];
  const starts = [];
  const closeMode = (end) => {
    const from = starts.pop() ?? -1;
    if (from >= 0) execs.push([from, end]);
  };
  const esc = ps ? "`" : "\\";
  const modes = [];
  const depths = [];
  const heredocs = [];
  let escEnd = -1;
  const fill = (from, to) => {
    for (let k = Math.max(from, 0); k < Math.min(to, n); k++) out[k] = FILL;
  };
  const blank = (from, to) => {
    for (let k = from; k < to; k++) text[k] = out[k] = " ";
  };
  const maskBody = (from, to, expand) => {
    let k = from;
    while (k < to) {
      const sub = command.startsWith("$(", k) ? closingParen(command, k + 2) : -1;
      const bt = !ps && command[k] === "`" ? command.indexOf("`", k + 1) : -1;
      const end = sub >= 0 ? sub : bt;
      if (expand && end >= 0 && end < to) {
        execs.push([k, end + 1]);
        k = end + 1;
      } else {
        fill(k, k + 1);
        bodies.add(k);
        k++;
      }
    }
  };
  const consumeHeredocs = (from) => {
    let start = from;
    const pending = heredocs.splice(0);
    for (const [at, h] of pending.entries()) {
      let end = start;
      let eol = start;
      while (end < n) {
        eol = command.indexOf("\n", end);
        if (eol < 0) eol = n;
        const line = command.slice(end, eol).replace(/\r$/, "");
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        end = eol + 1;
      }
      const stop = Math.min(eol, n);
      maskBody(start, stop, h.expand);
      if (at < pending.length - 1) fill(stop, stop + 1);
      start = stop + 1;
    }
    return Math.min(start - 1, n);
  };
  let i = 0;
  while (i < n) {
    const c = command[i];
    const top = modes[modes.length - 1];
    if (top === "dq") {
      if (c === esc) {
        fill(i, i + 2);
        i += 2;
      } else if (c === '"') {
        modes.pop();
        closeMode(i + 1);
        i++;
      } else if (c === "$" && command[i + 1] === "(") {
        dqSubs.add(i);
        modes.push("sub");
        starts.push(i);
        depths.push(0);
        i += 2;
      } else if (c === "`" && !ps) {
        dqSubs.add(i);
        modes.push("dbt");
        starts.push(i);
        i++;
      } else {
        fill(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "#" && escEnd !== i && startsWord(command, i)) {
      let eol = command.indexOf("\n", i);
      if (eol < 0) eol = n;
      else if (command[eol - 1] === "\r") eol--;
      blank(i, eol);
      i = eol;
    } else if (ps && c === "<" && command[i + 1] === "#") {
      const close = command.indexOf("#>", i + 2);
      const stop = close < 0 ? n : close + 2;
      blank(i, stop);
      i = stop;
    } else if (c === esc) {
      fill(i + 1, i + 2);
      escEnd = i + 2;
      i += 2;
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j > 0) {
        fill(i + 1, j);
        i = j + 1;
      } else i++;
    } else if (c === '"') {
      if (hasClosing(command, i + 1, '"', esc)) {
        modes.push("dq");
        starts.push(-1);
      }
      i++;
    } else if (c === "@" && (command[i + 1] === "'" || command[i + 1] === '"') && /^[ \t]*\r?\n/.test(command.slice(i + 2))) {
      const q = command[i + 1];
      const close = command.indexOf(`
${q}@`, i + 2);
      if (close < 0) i++;
      else {
        maskBody(i + 2, close, q === '"');
        i = close + 3;
      }
    } else if (!ps && c === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/.exec(command.slice(i, i + 200));
      if (m) {
        heredocs.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-", expand: m[2] === void 0 && m[3] === void 0 && !m[0].includes("\\") });
        i += m[0].length;
      } else i++;
    } else if (c === "\n" && heredocs.length) {
      fill(i, i + 1);
      i = consumeHeredocs(i + 1);
    } else if (c === "$" && command[i + 1] === "(") {
      modes.push("sub");
      starts.push(i);
      depths.push(0);
      i += 2;
    } else if (c === "`" && !ps) {
      if (top === "dbt") {
        dqSubs.add(i);
        modes.pop();
        closeMode(i + 1);
      } else if (top === "bt") {
        modes.pop();
        closeMode(i + 1);
      } else {
        modes.push("bt");
        starts.push(i);
      }
      i++;
    } else if (top === "sub" && (c === "(" || c === ")")) {
      if (c === "(") depths[depths.length - 1]++;
      else if (depths[depths.length - 1] === 0) {
        modes.pop();
        depths.pop();
        closeMode(i + 1);
      } else depths[depths.length - 1]--;
      i++;
    } else i++;
  }
  while (starts.length) closeMode(n);
  return { text: text.join(""), masked: out.join(""), dqSubs, bodies, execs };
}
function segmentRanges(lexed, ps, wholeQuotes = false) {
  const sep2 = ps ? /\|\||&&|[;|&\n({}]|\$\(/g : /\|\||&&|[;|&\n({}]|\$\(|`/g;
  const ranges = [];
  let last = 0;
  for (const m of lexed.masked.matchAll(sep2)) {
    if (wholeQuotes && lexed.dqSubs.has(m.index ?? -1)) continue;
    ranges.push([last, m.index ?? 0]);
    last = (m.index ?? 0) + m[0].length;
  }
  ranges.push([last, lexed.text.length]);
  return ranges;
}
function segmentSpans(lexed, ps) {
  return segmentRanges(lexed, ps).map(([start, end]) => ({ start, end, text: lexed.text.slice(start, end).trim() })).filter((s) => s.text);
}
function segmentize(command, ps = false) {
  return segmentSpans(lexShell(joinContinuations(command, ps), ps), ps).map((s) => s.text);
}
var ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
var RUNNERS = /* @__PURE__ */ new Set(["npx", "bunx", "pnpx", "sudo", "doas", "xargs"]);
var SHELLS = /* @__PURE__ */ new Set(["pwsh", "powershell", "bash", "sh", "zsh"]);
var EVALS = /* @__PURE__ */ new Set(["eval", "iex", "invoke-expression"]);
var STARTERS = /* @__PURE__ */ new Set(["start-process", "saps", "start"]);
var PREFIXES = /* @__PURE__ */ new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "call",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!"
]);
function splitFirst(s) {
  const m = s.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))\s*([\s\S]*)$/);
  if (!m) return { tok: "", rest: "" };
  return { tok: m[1] ?? m[2] ?? m[3] ?? "", rest: m[4] ?? "" };
}
function baseName(tok) {
  const norm = tok.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}
function cleanToken(t) {
  return t.replace(/^["'`]+|["'`)]+$/g, "");
}
function tokenize(s) {
  return (s.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map(cleanToken).filter(Boolean);
}
function stripLeadingQuote(s) {
  return s.replace(/^\s*["']/, "");
}
function unquoteOuter(s) {
  const t = s.trim();
  const m = t.match(/^"((?:\\.|[^"\\])*)"|^'([^']*)'/);
  return m ? m[1] ?? m[2] ?? "" : stripLeadingQuote(t);
}
function parseStarter(rest) {
  const toks = rest.split(/[\s,]+/).map(cleanToken).filter(Boolean);
  const fp = toks.findIndex((t) => /^-filepath$/i.test(t));
  const at = fp >= 0 ? fp + 1 : toks.findIndex((t) => !/^(?:-\S+|\/[a-z]+)$/i.test(t));
  if (at < 0 || !toks[at]) return { exe: "start-process", args: toks };
  return { exe: baseName(toks[at]), args: toks.filter((_, k) => k !== at) };
}
function parseInvocation(segment) {
  let s = segment.trim();
  for (let depth = 0; depth < 8; depth++) {
    let prev;
    do {
      prev = s;
      s = s.replace(ENV_ASSIGN, "");
    } while (s !== prev);
    s = s.replace(/^&\s*/, "");
    const { tok, rest } = splitFirst(s);
    if (!tok) return null;
    const exe = baseName(tok);
    if (RUNNERS.has(exe)) {
      s = rest.replace(/^(?:-\S+\s+)+/, "");
    } else if (exe === "cmd") {
      return { exe, args: [], nested: unquoteOuter(rest.replace(/^(?:\/[a-z]\s+)+/i, "")) };
    } else if (SHELLS.has(exe)) {
      const m = rest.match(/(?:^|\s)-(?:c|command|lc)\s+([\s\S]*)$/i);
      if (m) return { exe, args: [], nested: unquoteOuter(m[1]) };
      const doc = rest.match(/<<-?[ \t]*(?:'[^'\n]*'|"[^"\n]*"|\\?[\w.-]+)[ \t]*\r?\n([\s\S]*)$/);
      const here = rest.match(/<<<\s*([\s\S]*)$/);
      if (doc || here) return { exe, args: [], nested: doc ? doc[1] : unquoteOuter(here[1]) };
      return { exe, args: tokenize(rest) };
    } else if (EVALS.has(exe)) {
      return { exe, args: [], nested: unquoteOuter(rest.replace(/^-command\s+/i, "")) };
    } else if (STARTERS.has(exe)) {
      return parseStarter(rest);
    } else if (PREFIXES.has(exe)) {
      s = rest;
    } else if (exe === "timeout") {
      s = rest.replace(/^(?:-\S+\s+)*\S+\s+/, "");
    } else {
      return { exe, args: tokenize(rest) };
    }
  }
  return null;
}
function isCrExecutable(exe) {
  return exe === "cr" || exe === "coderabbit";
}
function hasForbiddenFlags(args) {
  for (const a of args) {
    if (/^--use-credits(?:=|$)/i.test(a)) return "--use-credits";
    if (/^--api-key(?:=|$)/i.test(a)) return "--api-key";
  }
  return null;
}
function isCodeWorkspace(args) {
  const i = args.findIndex((a) => a.toLowerCase() === "code");
  return i >= 0 && /^(?:new|push)$/i.test(args[i + 1] ?? "");
}
function isSkillInstall(inv) {
  const first = inv.args[0]?.toLowerCase();
  if (/^skills(?:@\S+)?$/.test(inv.exe) && first === "add") {
    return inv.args.some((a) => /coderabbit/i.test(a));
  }
  return isCrExecutable(inv.exe) && first === "skills";
}
function optionArgs(args) {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
}
function isInfoRequest(args) {
  return optionArgs(args).some((a) => /^(?:--help|-h|--version)$/i.test(a));
}
function isReadOnlySubcommand(args) {
  const pos = args.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
  if (pos[0] === "doctor" || pos[0] === "usage") return true;
  return pos[0] === "auth" && (pos[1] === "login" || pos[1] === "status");
}
function isReviewAgent(args) {
  return args.includes("review") && args.some((a) => a.toLowerCase() === "--agent");
}
var NOT_ALLOWED = "CodeRabbit guard: allowed are `cr review --agent` (<=2 runs per PR), cr doctor, cr usage, cr auth login|status, --help, --version";
function classifyInvocation(inv, plain) {
  if (isSkillInstall(inv)) {
    return { verdict: "block", reason: "CodeRabbit guard: CodeRabbit skill installs are forbidden" };
  }
  if (!isCrExecutable(inv.exe)) return { verdict: "ignore" };
  const forbidden = hasForbiddenFlags(inv.args);
  if (forbidden) return { verdict: "block", reason: `CodeRabbit guard: ${forbidden} is forbidden` };
  if (isCodeWorkspace(inv.args)) {
    return { verdict: "block", reason: "CodeRabbit guard: code new/push is forbidden" };
  }
  if (isInfoRequest(inv.args)) {
    const names = optionArgs(inv.args).some((a) => a.toLowerCase() === "review");
    if (names && !plain) return { verdict: "allow", countsRun: true, runs: 1 };
    return { verdict: "allow", reviewHelp: names };
  }
  if (isReviewAgent(inv.args)) return { verdict: "allow", countsRun: true, runs: 1 };
  if (isReadOnlySubcommand(inv.args)) return { verdict: "allow" };
  return { verdict: "block", reason: NOT_ALLOWED };
}
var CR_WORD = /(?:^|[\s"'`(\\/=,{])((?:cr|coderabbit)(?:\.(?:exe|cmd|bat|ps1))?)(?=$|[\s"'`)\\,}])/gi;
var BILLING_WORD = /(?:^|[\s"'`(=,])--(?:use-credits|api-key)(?=$|[\s"'`)=,])/i;
var REVIEW_WORD = /\breview\b/i;
var EXECUTING_PROGRAMS = /* @__PURE__ */ new Set([
  ...SHELLS,
  ...EVALS,
  ...STARTERS,
  ...RUNNERS,
  ...PREFIXES,
  "cmd",
  "timeout",
  "watch",
  "find",
  "parallel",
  "nice",
  "setsid",
  "wsl",
  "foreach-object",
  "%",
  "start-job",
  "sajb",
  "start-threadjob",
  "invoke-command",
  "icm"
]);
var BILLING_REASON = "CodeRabbit guard: billing flag with a CodeRabbit CLI call";
function leadingProgram(segment) {
  let s = segment.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(ENV_ASSIGN, "").replace(/^&\s*/, "");
  } while (s !== prev);
  return baseName(splitFirst(s).tok);
}
var TEXT_COMMANDS = /* @__PURE__ */ new Set(["git", "gh"]);
function rawBilling(text, ps = false) {
  if (!BILLING_WORD.test(text)) return false;
  const lexed = lexShell(text, ps);
  const ranges = segmentRanges(lexed, ps, true);
  const fine = segmentRanges(lexed, ps);
  for (const m of text.matchAll(CR_WORD)) {
    const at = (m.index ?? 0) + m[0].length - m[1].length;
    const inComment = lexed.text[at] !== text[at];
    const owner = ranges.find(([a, b]) => a <= at && at < b);
    const git2 = owner !== void 0 && TEXT_COMMANDS.has(leadingProgram(lexed.text.slice(owner[0], owner[1])));
    const exempt = !inComment && git2 && !isExecuted(lexed, fine, at);
    if (!exempt) return true;
  }
  return false;
}
function readsText(program) {
  return SHELLS.has(program) || EVALS.has(program) || STARTERS.has(program) || RUNNERS.has(program) || program === "cmd";
}
function isExecuted(lexed, fine, at) {
  const seg = fine.find(([a, b]) => a <= at && at < b);
  if (seg !== void 0 && readsText(leadingProgram(lexed.text.slice(seg[0], seg[1])))) return true;
  if (lexed.bodies.has(at)) return false;
  return lexed.execs.some(([a, b]) => a <= at && at < b);
}
function rawScan(lexed, ps = false) {
  const found = { reviewSegments: [] };
  const text = lexed.text;
  for (const [a, b] of segmentRanges(lexed, ps, true)) {
    const seg = text.slice(a, b).trim();
    if (!seg) continue;
    const program = leadingProgram(seg);
    if (!EXECUTING_PROGRAMS.has(program) && !isCrExecutable(program)) continue;
    const reads = readsText(program);
    const raw = reads ? seg : [...text.slice(a, b)].map((ch, k) => lexed.bodies.has(a + k) ? " " : ch).join("").trim();
    const first = [...raw.matchAll(CR_WORD)][0];
    if (!first) continue;
    if (REVIEW_WORD.test(raw.slice((first.index ?? 0) + first[0].length))) found.reviewSegments.push({ start: a, end: b, raw });
  }
  return found;
}
function leadsWithCr(segment) {
  return isCrExecutable(baseName(splitFirst(segment.trim()).tok)) && !segment.includes("\n");
}
function isPlainCommand(source, joined, lexed, ps) {
  if (lexed.text !== joined) return false;
  if (lexed.bodies.size > 0) return false;
  if (ps ? /`\r?\n|@["']/.test(source) : /\\\r?\n|<</.test(source)) return false;
  return !/[(){}`]/.test(lexed.masked);
}
var MAX_NESTING = 4;
function classifyCommand(source, ps = false, depth = 0) {
  const joined = joinContinuations(source, ps);
  if (rawBilling(joined, ps) || joined !== source && rawBilling(source, ps)) {
    return { verdict: "block", reason: BILLING_REASON };
  }
  const lexed = lexShell(joined, ps);
  const text = lexed.text;
  const raw = rawScan(lexed, ps);
  let runs = 0;
  let allowed = false;
  const plainCall = depth === 0 && isPlainCommand(source, joined, lexed, ps);
  const hidden = raw.reviewSegments.map((r) => ({ ...r, parsed: 0, covered: false }));
  for (const { start, end, text: seg } of segmentSpans(lexed, ps)) {
    const owner = hidden.find((h) => h.start <= start && end <= h.end);
    const inv = parseInvocation(seg);
    if (!inv) continue;
    let c;
    if (inv.nested === void 0) c = classifyInvocation(inv, plainCall && leadsWithCr(seg));
    else if (depth < MAX_NESTING) c = classifyCommand(inv.nested, ps, depth + 1);
    else if (/\b(?:cr|coderabbit)\b/i.test(inv.nested)) c = { verdict: "block", reason: "CodeRabbit guard: wrapper nesting is too deep to check" };
    else c = { verdict: "ignore" };
    if (c.verdict === "block") return c;
    if (c.verdict === "allow") allowed = true;
    if (!owner) runs += c.runs ?? 0;
    else {
      owner.parsed += c.runs ?? 0;
      owner.covered ||= c.reviewHelp === true && seg.trim() === text.slice(owner.start, owner.end).trim();
    }
  }
  for (const h of hidden) runs += h.parsed > 0 ? h.parsed : h.covered ? 0 : 1;
  if (runs > 0) return { verdict: "allow", countsRun: true, runs };
  return { verdict: allowed ? "allow" : "ignore", reviewHelp: hidden.some((h) => h.covered) };
}
function classifyShellSegment(segment, ps = false) {
  return classifyCommand(segment, ps);
}
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1e4 }).trim();
}
function normalizeRemote(url) {
  const u = url.trim().replace(/\\/g, "/");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/:]+)(?::\d*)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^/]*@)?([^/:@]{2,}):(?!\/\/)(.+)$/.exec(u);
  const m = scheme ?? scp;
  const rest = m ? `${m[1]}/${m[2]}` : u;
  return rest.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "").toLowerCase();
}
function repoId(root) {
  try {
    const url = git(["config", "--get-regexp", "^remote\\..*\\.url$"], root).split("\n")[0]?.split(/\s+/)[1] ?? "";
    const id = normalizeRemote(url);
    if (id) return id;
  } catch {
  }
  return root;
}
function branchId(root) {
  try {
    const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], root);
    if (branch) return branch;
  } catch {
  }
  try {
    return `detached@${git(["rev-parse", "--short=12", "HEAD"], root)}`;
  } catch {
    return "detached";
  }
}
function repoBranchKey(cwd = process.cwd(), env = process.env) {
  const fromEnv = env.CCV3_CODERABBIT_GUARD_KEY;
  if (fromEnv) return fromEnv;
  try {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    return `${repoId(root)}#${branchId(root)}`;
  } catch {
    return `cwd#${cwd}`;
  }
}
var CD_SEGMENT = /^(?:cd|chdir|pushd|set-location|sl)\s+(?:(?:-\w+|\/d)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i;
function effectiveCwd(command, cwd, ps = false) {
  let dir = cwd;
  for (const seg of segmentize(command, ps)) {
    const m = CD_SEGMENT.exec(seg);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    if (target && target !== "-") dir = resolve2(dir, target.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:"));
  }
  return dir;
}
var CCV3_KEY = /^[^/#]+\/(?:rev4nchist|parcadei)\/continuous-claude(?:-v3)?#/i;
var ANSWER_BASES = ["main", "refs/remotes/fork/main"];
var ANSWER_GIT_TIMEOUT_MS = 1e4;
var DENY_PREFIX = "CodeRabbit guard:";
function isCcv3Key(key) {
  return CCV3_KEY.test(key);
}
function diffPaths(root, base) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", "diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
    timeout: ANSWER_GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\0").filter(Boolean);
}
function answerKeyDeny(cwd) {
  try {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: ANSWER_GIT_TIMEOUT_MS, windowsHide: true });
    const root = top.status === 0 && typeof top.stdout === "string" ? top.stdout.trim() : "";
    if (!root) return `${DENY_PREFIX} the git root is unknown: no CLI review runs on a diff it cannot check for answer-key`;
    const union = /* @__PURE__ */ new Set();
    for (const base of ANSWER_BASES) {
      const paths = diffPaths(root, base);
      if (paths === null) return `${DENY_PREFIX} git diff failed: no CLI review runs on a diff it cannot check for answer-key`;
      for (const p of paths) union.add(p);
    }
    const check = answerKeyCheck({ root, paths: [...union] });
    if (check === null) return null;
    if ("closed" in check) return `${DENY_PREFIX} the REVIEW.md skip list is not usable: no CLI review runs on a diff it cannot check for answer-key`;
    return `${DENY_PREFIX} no CLI review may read the paths in the diff (${check.hits.length}) that are answer-key`;
  } catch {
    return `${DENY_PREFIX} the check failed with an error: no CLI review runs on a diff it cannot check for answer-key`;
  }
}
function checkRunCap(state, key, runs = 1) {
  const count = state.counts[key] ?? 0;
  return { ok: count + runs <= MAX_RUNS, count };
}
function recordRun(state, key, runs = 1) {
  const count = (state.counts[key] ?? 0) + runs;
  return { counts: { ...state.counts, [key]: count } };
}
function isReadOnlyAutofixDelegate(input) {
  const text = [input.tool_input?.prompt, input.tool_input?.description].filter(Boolean).join("\n");
  if (!/autofix/i.test(text)) return false;
  if (!/read[- ]only/i.test(text)) return false;
  return true;
}
function classifySkill(input) {
  const skill = String(input.tool_input?.skill ?? "");
  if (!skill) return { verdict: "ignore" };
  if (/^coderabbit:autofix$/i.test(skill) || skill.toLowerCase().includes("coderabbit:autofix")) {
    return { verdict: "block", reason: "CodeRabbit guard: coderabbit:autofix skill is forbidden" };
  }
  return { verdict: "ignore" };
}
function classifyDelegate(input) {
  const skill = classifySkill(input);
  if (skill.verdict === "block") return skill;
  if (isReadOnlyAutofixDelegate(input)) return { verdict: "allow" };
  const cmd = input.tool_input?.command;
  if (cmd) return classifyCommand(cmd);
  return { verdict: "ignore" };
}
function decide(input, env = process.env) {
  const tool = input.tool_name || "";
  const command = input.tool_input?.command || "";
  if (OVERRIDE.test(command)) {
    logGuardDecision("coderabbit-guard", input, "override", "SKIP_CODERABBIT_GUARD=1", { command, env });
    return { allow: true };
  }
  if (tool === "Skill") {
    const s = classifySkill(input);
    if (s.verdict === "block") return { allow: false, reason: s.reason };
    return { allow: true };
  }
  if (DELEGATE_TOOLS.has(tool)) {
    const d = classifyDelegate(input);
    if (d.verdict === "block") return { allow: false, reason: d.reason };
    return { allow: true };
  }
  if (!BASH_TOOLS.has(tool)) return { allow: true };
  const ps = tool === "PowerShell";
  const verdict = classifyCommand(command, ps);
  if (verdict.verdict === "block") return { allow: false, reason: verdict.reason };
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };
  const cwd = effectiveCwd(command, input.cwd || process.cwd(), ps);
  const key = repoBranchKey(cwd, env);
  if (isCcv3Key(key)) {
    const reason = answerKeyDeny(cwd);
    if (reason) return { allow: false, reason };
  }
  const path2 = statePath(env);
  const state = readState(path2);
  const cap = checkRunCap(state, key, runs);
  if (!cap.ok) {
    return {
      allow: false,
      reason: `CodeRabbit guard: run cap reached (${cap.count} of ${MAX_RUNS} cr review --agent runs used for ${key}; this command adds ${runs})`
    };
  }
  writeState(path2, recordRun(state, key, runs));
  return { allow: true, increment: true };
}
function readStdin() {
  return readFileSync2(0, "utf-8");
}
function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }
  const result = decide(input);
  if (!result.allow) {
    logGuardDecision("coderabbit-guard", input, "deny", result.reason || "blocked", {
      command: input.tool_input?.command
    });
    outputDeny(result.reason || "CodeRabbit guard: blocked");
    return;
  }
  outputContinue();
}
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
export {
  BILLING_REASON,
  answerKeyDeny,
  checkRunCap,
  classifyCommand,
  classifyDelegate,
  classifyShellSegment,
  classifySkill,
  decide,
  effectiveCwd,
  hasForbiddenFlags,
  isCcv3Key,
  isCodeWorkspace,
  isCrExecutable,
  isReadOnlyAutofixDelegate,
  isReadOnlySubcommand,
  isReviewAgent,
  isSkillInstall,
  joinContinuations,
  lexShell,
  normalizeRemote,
  parseInvocation,
  rawBilling,
  rawScan,
  readState,
  recordRun,
  repoBranchKey,
  segmentize,
  statePath,
  writeState
};
