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

// src/coderabbit-guard.ts
import { spawnSync } from "child_process";
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir as homedir3, tmpdir } from "os";
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

// ../../scripts/github/lib/answer-key.mjs
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
  const hits = answerKeyHitsOf(paths, globs);
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
function parseUnits(lexed, ps) {
  const fine = segmentSpans(lexed, ps);
  const units = [];
  for (const [a, b] of segmentRanges(lexed, ps, true)) {
    const whole = lexed.text.slice(a, b).trim();
    if (!whole) continue;
    if (parseInvocation(whole)?.nested !== void 0) units.push({ start: a, end: b, text: whole });
    else units.push(...fine.filter((f) => f.start >= a && f.end <= b));
  }
  return units;
}
function segmentUnits(command, ps) {
  return parseUnits(lexShell(joinContinuations(command, ps), ps), ps).map((u) => u.text);
}
var ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
var RUNNERS = /* @__PURE__ */ new Set(["npx", "bunx", "pnpx", "sudo", "doas", "xargs"]);
var RUNNER_VALUE_FLAGS = {
  sudo: /* @__PURE__ */ new Set(["-u", "-g", "-h", "-p", "-U", "-t", "-T", "-r", "-C", "-D", "-R"]),
  doas: /* @__PURE__ */ new Set(["-u", "-C"]),
  xargs: /* @__PURE__ */ new Set(["-n", "-L", "-P", "-s", "-d", "-E", "-a", "-I"])
};
var SHELLS = /* @__PURE__ */ new Set(["pwsh", "powershell", "bash", "sh", "zsh"]);
var POSIX_SHELLS = /* @__PURE__ */ new Set(["bash", "sh", "zsh"]);
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
  return norm.slice(norm.lastIndexOf("/") + 1).toLowerCase().replace(/^["'`]+/, "").replace(/(?<=.)@.*$/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
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
  return m ? m[1] !== void 0 ? m[1].replace(/\\(["\\])/g, "$1") : m[2] ?? "" : stripLeadingQuote(t);
}
function parseStarter(rest) {
  const moves = /(?:^|\s)-wo\w*/i.test(rest);
  const quoted = /(?:^|\s)-filepath\s+(?:"([^"]*)"|'([^']*)')/i.exec(rest);
  if (quoted) {
    const others = (rest.slice(0, quoted.index) + " " + rest.slice(quoted.index + quoted[0].length)).split(/[\s,]+/).map(cleanToken).filter(Boolean);
    return { exe: baseName(quoted[1] ?? quoted[2] ?? ""), args: others, moves };
  }
  const toks = rest.split(/[\s,]+/).map(cleanToken).filter(Boolean);
  const fp = toks.findIndex((t) => /^-filepath$/i.test(t));
  const at = fp >= 0 ? fp + 1 : toks.findIndex((t) => !/^(?:-\S+|\/[a-z]+)$/i.test(t));
  if (at < 0 || !toks[at]) return { exe: "start-process", args: toks, moves };
  return { exe: baseName(toks[at]), args: toks.filter((_, k) => k !== at), moves };
}
function skipRunnerOptions(exe, rest, moves) {
  const values = RUNNER_VALUE_FLAGS[exe];
  let s = rest;
  for (; ; ) {
    const { tok, rest: after } = splitFirst(s);
    if (!tok.startsWith("-") || tok === "-") return s;
    if (tok === "--") return after;
    if (exe === "sudo" && /^(?:-[DR]|--chdir|--chroot)/.test(tok)) moves.on = true;
    s = values?.has(tok) ? splitFirst(after).rest : after;
  }
}
function parseInvocation(segment) {
  const moves = { on: false };
  const found = parseInvocationInner(segment, moves);
  return found && moves.on ? { ...found, moves: true } : found;
}
function parseInvocationInner(segment, moves) {
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
      s = skipRunnerOptions(exe, rest, moves);
    } else if (exe === "cmd") {
      return { exe, args: [], nested: unquoteOuter(rest.replace(/^(?:\/[a-z]\s+)+/i, "")) };
    } else if (SHELLS.has(exe)) {
      const flags = POSIX_SHELLS.has(exe) ? "[a-z]*c[a-z]*|command" : "c|command|lc";
      const m = new RegExp(`(?:^|\\s)-(?:${flags})\\s+([\\s\\S]*)$`, "i").exec(rest);
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
var CR_WORD = /(?:^|[\s"'`(\\/=,{])((?:cr|coderabbit)(?:\.(?:exe|cmd|bat|ps1))?)(?=$|[\s"'`)\\,}@])/gi;
var BILLING_WORD = /(?:^|[\s"'`(=,])--(?:use-credits|api-key)(?=$|[\s"'`)=,])/i;
var REVIEW_WORD = /\breview\b/i;
var STRING_RUNNERS = /* @__PURE__ */ new Set(["wsl", "watch", "ssh", "parallel", "foreach-object", "%", "start-job", "sajb", "start-threadjob", "invoke-command", "icm"]);
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
function runsQuotedString(segment, masked, ps) {
  if (STARTERS.has(leadingProgram(segment))) return true;
  const inv = parseInvocation(segment);
  if (inv?.nested !== void 0) return false;
  if (inv !== null && STRING_RUNNERS.has(inv.exe)) return true;
  for (const m of masked.matchAll(/[^\s;|&(){}`]+/g)) {
    if (m[0].includes(FILL)) continue;
    const prog = baseName(m[0]);
    if (!(SHELLS.has(prog) || EVALS.has(prog) || STARTERS.has(prog) || prog === "cmd" || STRING_RUNNERS.has(prog))) continue;
    const sub = parseInvocation(segment.slice(m.index ?? 0));
    if (sub?.nested !== void 0) {
      if (holdsReviewCall(sub.nested, ps)) return true;
    } else if (!POSIX_SHELLS.has(prog)) return true;
  }
  return false;
}
function commandEnd(lexed, from) {
  const m = /\|\||&&|[;|&\n]/.exec(lexed.masked.slice(from));
  return m ? from + (m.index ?? 0) : lexed.text.length;
}
function rawScan(lexed, ps = false) {
  const found = { reviewSegments: [] };
  const text = lexed.text;
  const blanked = lexed.bodies.size === 0 ? text : text.split("").map((ch, k) => lexed.bodies.has(k) ? " " : ch).join("");
  for (const [a, b] of segmentRanges(lexed, ps, true)) {
    const seg = text.slice(a, b);
    if (!seg.trim()) continue;
    const reads = readsText(leadingProgram(seg));
    const scan = reads ? text : blanked;
    let quotedRuns;
    for (const m of seg.matchAll(CR_WORD)) {
      const at = a + (m.index ?? 0) + m[0].length - m[1].length;
      const quoted = lexed.masked[at] === FILL && !(reads && lexed.bodies.has(at));
      if (quoted) quotedRuns ??= runsQuotedString(seg, lexed.masked.slice(a, b), ps);
      if (quoted && !quotedRuns) continue;
      const end = Math.max(b, commandEnd(lexed, at + m[1].length));
      if (!REVIEW_WORD.test(scan.slice(at + m[1].length, end))) continue;
      found.reviewSegments.push({ start: a, end: b, raw: scan.slice(at, end).trim() });
      break;
    }
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
  const hidden = raw.reviewSegments.map((r) => ({ ...r, parsed: 0, covered: false, placed: false, invs: [] }));
  const counted = [];
  let unaccounted = false;
  let unplaced = false;
  for (const { start, end, text: seg } of parseUnits(lexed, ps)) {
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
    const calls = inv.nested === void 0 ? (c.runs ?? 0) > 0 ? [inv] : [] : c.invocations ?? [];
    counted.push(...calls);
    if (c.unaccounted) unaccounted = true;
    const placed = inv.nested === void 0 ? isCrExecutable(inv.exe) && !inv.moves : (c.runs ?? 0) > 0 && c.unplaced !== true && !inv.moves;
    if (c.unplaced || inv.moves && (inv.nested !== void 0 || isCrExecutable(inv.exe)) && (c.runs ?? 0) > 0) unplaced = true;
    if (!owner) runs += c.runs ?? 0;
    else {
      owner.placed ||= placed;
      owner.invs.push(...calls);
      owner.parsed += c.runs ?? 0;
      owner.covered ||= c.reviewHelp === true && seg.trim() === text.slice(owner.start, owner.end).trim();
    }
  }
  for (const h of hidden) {
    runs += h.parsed > 0 ? h.parsed : h.covered ? 0 : 1;
    if (!h.placed && !h.covered) unplaced = true;
    if (rawOptionCount(h.raw) > parsedOptionCount(h.invs)) unaccounted = true;
  }
  if (runs > 0) return { verdict: "allow", countsRun: true, runs, invocations: counted, unaccounted, unplaced };
  return { verdict: allowed ? "allow" : "ignore", reviewHelp: hidden.some((h) => h.covered) };
}
function classifyShellSegment(segment, ps = false) {
  return classifyCommand(segment, ps);
}
function git(args, cwd) {
  const r = gitRun(cwd, args);
  if (!r.ok) throw new Error(`git ${args[0]} failed`);
  return r.stdout.trim();
}
var KEY_BUDGET_MS = 1e4;
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
  gitDeadline = Date.now() + KEY_BUDGET_MS;
  try {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    return `${repoId(root)}#${branchId(root)}`;
  } catch {
    return `cwd#${cwd}`;
  }
}
var CD_ARGS = String.raw`\s+(?:(?:-\w+|\/d)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))`;
var CD_SEGMENT_PS = new RegExp(`^(?:cd|chdir|pushd|push-location|set-location|sl)${CD_ARGS}`, "i");
var CD_SEGMENT_BASH = new RegExp(`^(?:cd|pushd)${CD_ARGS}`);
var cdSegment = (segment, ps) => (ps ? CD_SEGMENT_PS : CD_SEGMENT_BASH).exec(segment);
function homeOf(env = process.env) {
  return env.USERPROFILE || env.HOME || homedir3();
}
function cdTarget(dir, target, home, ps) {
  const expanded = home && /^~(?=[\\/]|$)/.test(target) ? join3(home, target.slice(1)) : target;
  return resolve2(dir, ps ? expanded : expanded.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:"));
}
function effectiveCwd(command, cwd, ps = false, home = "") {
  let dir = cwd;
  for (const seg of segmentize(command, ps)) {
    const m = cdSegment(seg, ps);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    if (target && target !== "-") dir = cdTarget(dir, target, home, ps);
  }
  return dir;
}
var CCV3_REMOTE = /(?:rev4nchist|parcadei)\/continuous-claude(?:-v3)?/i;
var ANSWER_BASES = ["refs/heads/main", "refs/remotes/fork/main"];
var EVAL_TREE = "scripts/eval/review-eval";
var ANSWER_GIT_TIMEOUT_MS = 1e4;
var ANSWER_BUDGET_MS = 3e4;
var gitDeadline = 0;
var DENY_PREFIX = "CodeRabbit guard:";
var cannotCheck = (why) => `${DENY_PREFIX} ${why}: no CLI review runs on a diff it cannot check for answer-key`;
var WAY_OUT_TEXT = "run the review as its own plain command with --base <ref>";
var WAY_OUT = `${DENY_PREFIX} ${WAY_OUT_TEXT}, so the check can read the diff for answer-key`;
var wayOut = (cause) => cause ? `${DENY_PREFIX} ${WAY_OUT_TEXT} (${cause}), so the check can read the diff for answer-key` : WAY_OUT;
var budgetOut = () => Date.now() >= gitDeadline;
function gitEnv(base = process.env) {
  const env = { ...base, LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}
function gitRun(cwd, args) {
  const left = gitDeadline - Date.now();
  if (left <= 0) return { ok: false, status: null, stdout: "", stderr: "budget" };
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", timeout: Math.min(ANSWER_GIT_TIMEOUT_MS, left), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : ""
  };
}
function diffPaths(root, range) {
  const r = gitRun(root, ["-c", "core.quotepath=false", "diff", "--name-only", "--no-renames", "-z", range, "--"]);
  return r.ok ? r.stdout.split("\0").filter(Boolean) : null;
}
function statusPaths(root) {
  const r = gitRun(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!r.ok) return null;
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.length < 4 || rec[2] !== " ") return null;
    out.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2))) {
      const old = fields[++i];
      if (!old) return null;
      out.push(old);
    }
  }
  return out;
}
var REVIEW_OPTION = /(?:^|[\s"'`(=,{])(?:--base-commit|--base|--dir|--remote|--config|-c[^\s"'`)=,}]*)(?=$|[\s"'`)=,}])/gi;
function optionCount(text) {
  return [...text.matchAll(REVIEW_OPTION)].length;
}
function parsedOptionCount(invs) {
  return invs.reduce((n, inv) => n + optionCount(` ${inv.args.join(" ")}`), 0);
}
function rawOptionCount(raw) {
  const first = [...raw.matchAll(CR_WORD)][0];
  return first ? optionCount(` ${raw.slice((first.index ?? 0) + first[0].length)}`) : 0;
}
var VALUE_OPTIONS = /* @__PURE__ */ new Set(["--base", "--base-commit", "--dir", "--remote"]);
function readReviewOptions(invs) {
  const o = { bases: [], baseCommits: [], dirs: [], configs: [], remotes: [], bad: false };
  const slot = { "--base": o.bases, "--base-commit": o.baseCommits, "--dir": o.dirs, "--remote": o.remotes, "--config": o.configs };
  for (const inv of invs) {
    const a = optionArgs(inv.args);
    for (let i = 0; i < a.length; i++) {
      const tok = a[i].toLowerCase();
      const eq = /^(--base-commit|--base|--dir|--remote|--config)=(.*)$/.exec(tok);
      if (eq) {
        const value = a[i].slice(eq[1].length + 1);
        if (value) slot[eq[1]].push(value);
        else o.bad = true;
      } else if (VALUE_OPTIONS.has(tok)) {
        const value = a[i + 1];
        if (value === void 0 || value.startsWith("-")) o.bad = true;
        else {
          slot[tok].push(value);
          i++;
        }
      } else if (tok === "-c" || tok === "--config") {
        let n = 0;
        while (a[i + 1] !== void 0 && !a[i + 1].startsWith("-")) {
          o.configs.push(a[++i]);
          n++;
        }
        if (n === 0) o.bad = true;
      } else if (/^-c./.test(tok) && !tok.startsWith("--")) {
        o.configs.push(a[i].slice(2));
      }
    }
  }
  return o;
}
function namesAnswerKey(path2) {
  const segs = slashLower(path2).split("/");
  for (let i = 0; i < segs.length; i++) {
    const tail = segs.slice(i).join("/");
    if (ANSWER_KEY_GLOBS.some((g) => matchGlob(slashLower(g), tail) || matchGlob(slashLower(g), `${tail}/_`))) return true;
  }
  return false;
}
function configDeny(cwd, files) {
  for (const file of files) {
    const abs = resolve2(cwd, file);
    let real;
    if (budgetOut()) return cannotCheck("the time budget ended");
    try {
      real = realpathSync(abs);
    } catch {
      return cannotCheck("a --config file cannot be read");
    }
    if (namesAnswerKey(abs) || namesAnswerKey(real)) return `${DENY_PREFIX} a --config file is sent to the service and it is answer-key`;
    if (budgetOut()) return cannotCheck("the time budget ended");
    try {
      if (statSync(real).isDirectory()) return WAY_OUT;
    } catch {
      return cannotCheck("a --config file cannot be read");
    }
  }
  return null;
}
function ccv3Root(dir) {
  const top = gitRun(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return top.status === 128 && /not a git repository/i.test(top.stderr) ? { skip: true } : null;
  const root = top.stdout.trim();
  if (!root) return null;
  const remotes = gitRun(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (remotes.status !== 1 && !remotes.ok) return null;
  const urls = remotes.status === 1 ? [] : remotes.stdout.split("\n").map((l) => l.trim().split(/\s+/).slice(1).join(" ")).filter(Boolean);
  if (urls.some((u) => CCV3_REMOTE.test(u))) return { root };
  const tree = gitRun(root, ["ls-tree", "HEAD", "--", EVAL_TREE]);
  if (tree.ok) return tree.stdout.trim() ? { root } : { skip: true };
  const head = gitRun(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.status !== 1 || budgetOut()) return null;
  return existsSync(join3(root, EVAL_TREE)) ? { root } : { skip: true };
}
function rangesFor(root, opts) {
  const ranges = ANSWER_BASES.map((b) => `${b}...HEAD`);
  for (const value of [...opts.bases, ...opts.baseCommits]) {
    if (value.startsWith("-") || !gitRun(root, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]).ok) return WAY_OUT;
    ranges.push(`${value}...HEAD`, `${value}..HEAD`);
  }
  return ranges;
}
function missingRef(root) {
  if (budgetOut()) return "the time budget ended";
  const missing = ANSWER_BASES.find((b) => !gitRun(root, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`]).ok);
  return missing ? `the ref ${missing} is missing` : void 0;
}
function rootDeny(root, opts) {
  const ranges = rangesFor(root, opts);
  if (typeof ranges === "string") return ranges;
  const union = /* @__PURE__ */ new Set();
  for (const range of ranges) {
    const paths = diffPaths(root, range);
    if (paths === null) return cannotCheck(missingRef(root) ?? "git diff failed");
    for (const p of paths) union.add(p);
  }
  const tree = statusPaths(root);
  if (tree === null) return cannotCheck("git status failed");
  for (const p of tree) union.add(p);
  const check = answerKeyCheck({ root, paths: [...union] });
  if (check === null) return null;
  if ("closed" in check) return cannotCheck("the REVIEW.md skip list is not usable");
  return `${DENY_PREFIX} no CLI review may read the paths in the diff (${check.hits.length}) that are answer-key`;
}
function checkedRoots(dirs) {
  const roots = /* @__PURE__ */ new Set();
  let error;
  for (const dir of dirs) {
    const found = ccv3Root(dir);
    if (found === null) error ??= cannotCheck("the git root or the remotes cannot be read");
    else if (!("skip" in found)) roots.add(found.root);
  }
  return { roots: [...roots], error };
}
var CD_WORD_PS = /^(?:cd|chdir|pushd|popd|push-location|pop-location|set-location|sl)(?=\s|$)/i;
var CD_WORD_BASH = /^(?:cd|pushd|popd)(?=\s|$)/;
function nestedHasCd(text, ps, depth) {
  if (depth > MAX_NESTING) return true;
  for (const seg of segmentUnits(text, ps)) {
    if (CD_WORD_PS.test(seg.trim())) return true;
    const inv = parseInvocation(seg);
    if (inv?.nested !== void 0 && nestedHasCd(inv.nested, ps, depth + 1)) return true;
  }
  return false;
}
function folderDeny(command, ps, cwd) {
  let seenCr = false;
  for (const seg of segmentUnits(command, ps)) {
    const text = seg.trim();
    if ((ps ? CD_WORD_PS : CD_WORD_BASH).test(text)) {
      const m = cdSegment(text, ps);
      const target = m?.[1] ?? m?.[2] ?? m?.[3];
      if (!target || target === "-" || /[$%`]/.test(target) || target.includes("~") && !/^~(?:[\\/][^~]*)?$/.test(target)) {
        return WAY_OUT;
      }
      if (!ps && m?.[3] !== void 0 && m[3].includes("\\")) return wayOut("a backslash in a cd target is an escape in Bash: write the path with /");
      if (seenCr) return WAY_OUT;
    }
    if ([...text.matchAll(CR_WORD)].length > 0) seenCr = true;
    const inv = parseInvocation(seg);
    if (inv?.nested !== void 0 && nestedHasCd(inv.nested, ps, 0)) return WAY_OUT;
  }
  if (budgetOut()) return cannotCheck("the time budget ended");
  try {
    if (!statSync(cwd).isDirectory()) return cannotCheck("the folder the review runs in is not a folder");
  } catch {
    return cannotCheck("the folder the review runs in does not exist");
  }
  return null;
}
var SHAPE_FLAGS = /* @__PURE__ */ new Set(["--agent", "--fresh", "--show-prompts", "--use-credits", "--committed", "--uncommitted", "--include-untracked", "--usage", "--deep", "--help", "-h"]);
var SHAPE_VALUE_OPTIONS = ["--base", "--base-commit", "--dir", "--remote", "--source-branch", "--region"];
var BARE_TOKEN = /^[A-Za-z0-9._/:=~-]+/;
var BARE_TOKEN_PS = /^[A-Za-z0-9._/:=~\\-]+/;
var QUOTED_BODY = /^[A-Za-z0-9._/:= -]*$/;
var QUOTED_BODY_PS = /^[A-Za-z0-9._/:= \\-]*$/;
var REMOTE_LITERAL = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
var FIXED_TARGET = /^(?:\/|[A-Za-z]:[\\/]|\.{1,2}(?:[\\/]|$)|~)/;
function shapeTokens(text, ps) {
  const out = [];
  const n = text.length;
  const bare = ps ? BARE_TOKEN_PS : BARE_TOKEN;
  const quotedBody = ps ? QUOTED_BODY_PS : QUOTED_BODY;
  const ends = (k) => k >= n || text[k] === " " || text[k] === "	" || text[k] === ";" || text.startsWith("&&", k);
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "	") i++;
    else if (c === ";") {
      out.push({ sep: ";" });
      i++;
    } else if (text.startsWith("&&", i)) {
      out.push({ sep: "&&" });
      i += 2;
    } else if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      const body = close < 0 ? "" : text.slice(i + 1, close);
      if (close < 0 || !quotedBody.test(body) || !ends(close + 1)) return null;
      out.push({ v: body, quoted: true });
      i = close + 1;
    } else {
      const m = bare.exec(text.slice(i));
      if (!m || !ends(i + m[0].length)) return null;
      out.push({ v: m[0], quoted: false });
      i += m[0].length;
    }
  }
  return out;
}
var literalValue = (t) => t !== void 0 && t.v !== "" && !t.v.startsWith("-") && !t.v.includes("~");
function parseShape(command, ps = false) {
  const override = OVERRIDE.exec(command);
  const toks = shapeTokens((override ? command.slice(override[0].length) : command).trim(), ps);
  if (!toks || toks.length === 0) return null;
  const groups = [[]];
  let semi = false;
  for (const t of toks) {
    if ("sep" in t) {
      semi = t.sep === ";";
      groups.push([]);
    } else groups[groups.length - 1].push(t);
  }
  if (groups.length > 2) return null;
  const shape = { bases: [], baseCommits: [], dirs: [], configs: [], remotes: [], bad: false };
  if (groups.length === 2) {
    const [word, ...args] = groups[0];
    if (ps && args.length === 2 && !args[0].quoted && /^-(?:literal)?path$/i.test(args[0].v)) args.shift();
    const cdWord = ps ? /^(?:cd|set-location|sl)$/i : /^cd$/;
    if (!word || args.length !== 1 || word.quoted || !cdWord.test(word.v) || !FIXED_TARGET.test(args[0].v)) return null;
    shape.cd = args[0].v;
    shape.semi = semi;
  }
  const last = groups[groups.length - 1];
  if (last.some((t) => t.v.includes("\\"))) return null;
  const [program, sub, ...rest] = last;
  if (!program || !sub || program.quoted || sub.quoted || !isCrExecutable(program.v) || sub.v !== "review") return null;
  const slot = { "--base": shape.bases, "--base-commit": shape.baseCommits, "--dir": shape.dirs, "--remote": shape.remotes, "--config": shape.configs };
  for (const name of SHAPE_VALUE_OPTIONS) slot[name] ??= [];
  let i = 0;
  while (i < rest.length) {
    const t = rest[i++];
    if (t.quoted) return null;
    if (SHAPE_FLAGS.has(t.v)) continue;
    const eq = /^(--[a-z-]+)=(.*)$/.exec(t.v);
    const name = eq ? eq[1] : t.v === "-c" ? "--config" : t.v;
    if (!Object.hasOwn(slot, name)) return null;
    if (eq) {
      if (!literalValue({ v: eq[2] })) return null;
      slot[name].push(eq[2]);
    } else if (name === "--config") {
      let n = 0;
      while (literalValue(rest[i])) {
        shape.configs.push(rest[i++].v);
        n++;
      }
      if (n === 0) return null;
    } else {
      const value = rest[i++];
      if (!literalValue(value)) return null;
      slot[name].push(value.v);
    }
  }
  return shape.remotes.every((r) => REMOTE_LITERAL.test(r)) ? shape : null;
}
function shapeCause(command, ps) {
  const head = command.replace(OVERRIDE, "").trim().split(/&&|;/)[0].trim();
  const word = /^(\S+)\s+(.*)$/.exec(head);
  if (!word) return void 0;
  if (!ps && /^cd$/i.test(word[1]) && word[1] !== "cd") return "Bash has no CD: write cd in lower case";
  if (!/^(?:cd|chdir|pushd|set-location|sl)$/i.test(word[1])) return void 0;
  if (!ps && word[2].includes("\\")) return "a backslash in a cd target is an escape in Bash: write the path with /";
  const target = word[2].replace(/^(?:-\w+\s+)*/, "").replace(/^["']|["']$/g, "");
  if (!FIXED_TARGET.test(target)) return "a cd target must be absolute or start with ./ ../ or ~";
  return void 0;
}
function answerKeyDeny(run) {
  try {
    gitDeadline = Date.now() + ANSWER_BUDGET_MS;
    const shape = parseShape(run.command, run.ps);
    if (!shape && run.unplaced) return wayOut(shapeCause(run.command, run.ps));
    const cwd = shape ? shape.cd === void 0 ? run.startCwd : cdTarget(run.startCwd, shape.cd, run.home, run.ps) : run.cwd;
    const folder = folderDeny(run.command, run.ps, cwd);
    if (folder) return folder;
    const opts = shape ?? readReviewOptions(run.invocations);
    const startToo = shape ? shape.semi === true : cwd !== run.startCwd;
    const folders = [cwd, ...startToo ? [run.startCwd] : [], ...opts.dirs.map((d) => resolve2(cwd, d))];
    const early = shape ? void 0 : checkedRoots(folders);
    if (early && early.roots.length > 0) return wayOut(shapeCause(run.command, run.ps));
    if (opts.bad) return cannotCheck("a CLI option has no value");
    if (opts.remotes.some((r) => CCV3_REMOTE.test(r))) return `${DENY_PREFIX} --remote names the CCv3 repo and the service reads its answer-key`;
    const config = configDeny(cwd, opts.configs);
    if (config) return config;
    const { roots, error } = early ?? checkedRoots(folders);
    if (error) return error;
    if (roots.length === 0) return !shape && run.unaccounted ? wayOut() : null;
    if (opts.bases.length + opts.baseCommits.length === 0) return WAY_OUT;
    for (const root of roots) {
      const reason = rootDeny(root, opts);
      if (reason) return reason;
    }
    return null;
  } catch {
    return cannotCheck("the check failed with an error");
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
function rawReview(command) {
  const first = [...command.matchAll(CR_WORD)][0];
  return !!first && REVIEW_WORD.test(command.slice((first.index ?? 0) + first[0].length));
}
function holdsReviewCall(source, ps, depth = 0) {
  const lexed = lexShell(joinContinuations(source, ps), ps);
  if (rawScan(lexed, ps).reviewSegments.length > 0 || depth > MAX_NESTING) return true;
  for (const { text } of parseUnits(lexed, ps)) {
    const inv = parseInvocation(text);
    if (!inv) continue;
    if (inv.nested !== void 0 ? holdsReviewCall(inv.nested, ps, depth + 1) : isCrExecutable(inv.exe) && inv.args.some((a) => a.toLowerCase() === "review")) return true;
  }
  return false;
}
function answerKeyResult(input, command, ps, verdict, seam, env) {
  const blockedReview = (verdict.runs ?? 0) === 0 && verdict.verdict === "block" && holdsReviewCall(command, ps);
  if ((verdict.runs ?? 0) === 0 && !blockedReview) return null;
  const startCwd = input.cwd || process.cwd();
  const home = homeOf(env);
  const cwd = (seam.cwdOf ?? ((c, d, p) => effectiveCwd(c, d, p, home)))(command, startCwd, ps);
  const unaccounted = verdict.unaccounted === true || blockedReview && rawOptionCount(command) > 0;
  const reason = answerKeyDeny({ command, ps, startCwd, cwd, home, invocations: verdict.invocations ?? [], unaccounted, unplaced: verdict.unplaced === true });
  return reason ? { allow: false, reason, answerKey: true } : null;
}
function decideChecked(input, env, seam) {
  const tool = input.tool_name || "";
  const command = input.tool_input?.command || "";
  const ps = tool === "PowerShell";
  const classify = seam.classify ?? classifyCommand;
  const runsCommand = BASH_TOOLS.has(tool) || DELEGATE_TOOLS.has(tool) && tool !== "Skill" && command !== "";
  if (OVERRIDE.test(command)) {
    const denied2 = runsCommand ? answerKeyResult(input, command, ps, classify(command, ps), seam, env) : null;
    if (denied2) return denied2;
    if (rawReview(command)) logGuardDecision("coderabbit-guard", { ...input, cwd: void 0 }, "override", "SKIP_CODERABBIT_GUARD=1", { env });
    else logGuardDecision("coderabbit-guard", input, "override", "SKIP_CODERABBIT_GUARD=1", { command, env });
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
    return (command ? answerKeyResult(input, command, false, classify(command, false), seam, env) : null) ?? { allow: true };
  }
  if (!BASH_TOOLS.has(tool)) return { allow: true };
  const verdict = classify(command, ps);
  if (verdict.verdict === "block") return { allow: false, reason: verdict.reason };
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };
  const denied = answerKeyResult(input, command, ps, verdict, seam, env);
  if (denied) return denied;
  const home = homeOf(env);
  const cwd = (seam.cwdOf ?? ((c, d, p) => effectiveCwd(c, d, p, home)))(command, input.cwd || process.cwd(), ps);
  const key = repoBranchKey(cwd, env);
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
function failClosed(input) {
  const command = input.tool_input?.command || "";
  const reviewTool = BASH_TOOLS.has(input.tool_name || "") || DELEGATE_TOOLS.has(input.tool_name || "") && input.tool_name !== "Skill";
  if (reviewTool && command && rawReview(command)) {
    return { allow: false, reason: cannotCheck("the command could not be read"), answerKey: true };
  }
  return { allow: true };
}
function decide(input, env = process.env, seam = {}) {
  try {
    return decideChecked(input, env, seam);
  } catch {
    return failClosed(input);
  }
}
function readStdin() {
  return readFileSync2(0, "utf-8");
}
function logDeny(input, result, env = process.env) {
  if (result.answerKey) logGuardDecision("coderabbit-guard", { ...input, cwd: void 0 }, "deny", result.reason || "blocked", { env });
  else logGuardDecision("coderabbit-guard", input, "deny", result.reason || "blocked", { command: input.tool_input?.command, env });
}
var UNREAD_PAYLOAD_REASON = "CodeRabbit guard: the hook payload could not be read, so this call is refused. Retry the call; if it repeats, tell Dave.";
var GUARD_ERROR_REASON = "CodeRabbit guard: an internal error stopped the check, so this call is refused. Retry the call; if it repeats, tell Dave.";
var GUARD_ERROR_CONTINUE = "CodeRabbit guard: internal error on a call with no review word; continued";
var DYNAMIC_SIGN = /(?:^|[\s;|&({])(?:eval|iex|invoke-expression|invoke-command|start-process|bash|sh|pwsh|powershell|cmd|xargs|env|npx|sudo)(?=$|[\s;|)])|(?:^|[\s;|({])[&.]\s|-encodedcommand|\$\(|\$\{|\$[A-Za-z_@*]|`/i;
function mayHoldReview(input) {
  const text = input.tool_input?.command ?? JSON.stringify(input.tool_input ?? {});
  return /\b(?:cr|coderabbit)\b/i.test(text.replace(/["'`\\]/g, "")) || DYNAMIC_SIGN.test(text);
}
function denyUnread(reason) {
  logGuardDecision("coderabbit-guard", null, "deny", reason);
  outputDeny(reason);
}
function onGuardError(input) {
  if (mayHoldReview(input)) return denyUnread(GUARD_ERROR_REASON);
  logGuardDecision("coderabbit-guard", null, "allow", GUARD_ERROR_CONTINUE);
  outputContinue();
}
function runStep(input) {
  const result = decide(input);
  if (!result.allow) {
    logDeny(input, result);
    outputDeny(result.reason || "CodeRabbit guard: blocked");
    return;
  }
  outputContinue();
}
function handle(raw, step = runStep) {
  let input;
  try {
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("payload is not an object");
  } catch {
    denyUnread(UNREAD_PAYLOAD_REASON);
    return;
  }
  try {
    step(input);
  } catch {
    onGuardError(input);
  }
}
function runMain(read = readStdin) {
  let raw;
  try {
    raw = read();
  } catch (e) {
    const code = String(e?.code ?? "unknown").replace(/[^A-Z0-9_]/gi, "").slice(0, 24) || "unknown";
    logGuardDecision("coderabbit-guard", null, "allow", `stdin-read-failed ${code}`);
    outputContinue();
    return;
  }
  handle(raw);
}
if (!process.env.VITEST) {
  try {
    runMain();
  } catch {
  }
}
export {
  BILLING_REASON,
  GUARD_ERROR_REASON,
  UNREAD_PAYLOAD_REASON,
  WAY_OUT_TEXT,
  answerKeyDeny,
  checkRunCap,
  classifyCommand,
  classifyDelegate,
  classifyShellSegment,
  classifySkill,
  decide,
  effectiveCwd,
  gitEnv,
  handle,
  hasForbiddenFlags,
  homeOf,
  isCodeWorkspace,
  isCrExecutable,
  isReadOnlyAutofixDelegate,
  isReadOnlySubcommand,
  isReviewAgent,
  isSkillInstall,
  joinContinuations,
  lexShell,
  logDeny,
  mayHoldReview,
  normalizeRemote,
  onGuardError,
  parseInvocation,
  parseShape,
  parsedOptionCount,
  rawBilling,
  rawOptionCount,
  rawScan,
  readReviewOptions,
  readState,
  recordRun,
  repoBranchKey,
  runMain,
  segmentize,
  statePath,
  writeState
};
