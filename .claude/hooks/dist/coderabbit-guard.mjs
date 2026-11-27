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
    const path3 = guardLogPath(env);
    mkdirSync(dirname(path3), { recursive: true, mode: 448 });
    appendFileSync(path3, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}
var COMMAND_HEAD_CHARS, REASON_CHARS, PATH_CHARS, TARGET_FIELD, SECRET_NAME, MASKS, UUID_SEGMENT, MARK_OPEN, MARK_CLOSE, UUID_MARK, PATH_MASKS;
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

// src/coderabbit-guard.ts
init_trace_boot();
import { spawnSync } from "child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir as homedir3, tmpdir } from "os";
import { dirname as dirname2, join as join3, resolve as resolve3 } from "path";

// src/shared/output.ts
init_trace_boot();
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

// src/coderabbit-guard.ts
init_guard_log();

// src/shared/shell-ast.ts
init_trace_boot();
import fs3 from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// node_modules/sh-syntax/lib/index.js
init_trace_boot();
import fs2 from "node:fs/promises";
import path from "node:path";
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
var moduleDir = importMetaUrl ? path.dirname(fileURLToPath(importMetaUrl)) : __dirname;
var processor = getProcessor(() => fs2.readFile(path.resolve(moduleDir, "../main.wasm")));

// src/shared/shell-ast.ts
var HERE = fileURLToPath2(new URL(".", import.meta.url)).replace(/\\/g, "/");
var SHIPPED_WASM = `${HERE}sh-syntax.wasm`;
var SHIPPED_WASM_EXEC = `${HERE}sh-syntax-wasm_exec.cjs`;
var SHIPPED = existsSync(SHIPPED_WASM) && existsSync(SHIPPED_WASM_EXEC);
var WALKER = existsSync(`${HERE}shell-ast-walk.ps1`) ? `${HERE}shell-ast-walk.ps1` : `${HERE}../shell-ast-walk.ps1`;
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
  let shape = "";
  for (const p of w.parts ?? []) {
    const v = partLit(p);
    if (v === null) return null;
    s += v;
    shape += p.type === "Lit" ? v : "Q";
  }
  if ((w.parts ?? []).length > 1 && GLOB.test(shape)) return null;
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
  const out = [];
  walkAll(n, (x) => {
    if (types.includes(x.type)) out.push(x);
  });
  return out;
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
  const out = { lit, kind, raw: conv.slice(w.start, w.end), start, end, vars };
  if (sv) {
    out.var = sv.name;
    out.quoted = sv.quoted;
  }
  if (lit === null) out.prefix = wordPrefix(w);
  return out;
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
    let out = "";
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
      out += d;
    });
    cp.on("error", (e) => fin({ error: `pwsh spawn: ${e.message}` }));
    cp.on("close", (code) => {
      if (code !== 0) return fin({ error: `pwsh exit ${code}` });
      try {
        fin({ json: JSON.parse(out) });
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
  const out = [];
  words.forEach((w, i) => {
    if (w.kind === "param" && OUTVAR.test(w.lit ?? "") && words[i + 1]) out.push(words[i + 1].lit ?? words[i + 1].raw);
  });
  return out;
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
  const out = [];
  for (const c of calls) {
    out.push(c);
    const x = xargsInner(c);
    if (x) out.push(x);
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
    for (const ic of r.calls) out.push({ ...ic, depth: ic.depth + c.depth + 1, level: level + 1, viaPayload: pay.via, cwdBefore: [...c.cwdBefore ?? [], ...ic.cwdBefore ?? []] });
    r.kinds.forEach((k) => (c.nestedKinds ??= /* @__PURE__ */ new Set()).add(k));
  }
  return out;
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

// ../../scripts/github/lib/answer-paths.mjs
init_trace_boot();
import { readFileSync } from "node:fs";
import path2 from "node:path";

// ../../scripts/ratchets/lib/review-md.mjs
init_trace_boot();
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
    text = readFileSync(path2.join(root, "REVIEW.md"), "utf8");
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
function readState(path3) {
  try {
    if (!existsSync2(path3)) return { counts: {} };
    const parsed = JSON.parse(readFileSync2(path3, "utf8"));
    return { counts: parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : {} };
  } catch {
    return { counts: {} };
  }
}
function writeState(path3, state) {
  const tmp = `${path3}.${process.pid}.tmp`;
  try {
    mkdirSync2(dirname2(path3), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path3);
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
var ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
var RUNNERS = /* @__PURE__ */ new Set(["npx", "bunx", "pnpx", "sudo", "doas", "xargs"]);
var RUNNER_VALUE_FLAGS = {
  sudo: /* @__PURE__ */ new Set(["-u", "-g", "-h", "-p", "-U", "-t", "-T", "-r", "-C", "-D", "-R"]),
  doas: /* @__PURE__ */ new Set(["-u", "-C"]),
  xargs: /* @__PURE__ */ new Set(["-n", "-L", "-P", "-s", "-d", "-E", "-a", "-I"])
};
var SHELLS2 = /* @__PURE__ */ new Set(["pwsh", "powershell", "bash", "sh", "zsh"]);
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
var KNOWN_KINDS = /* @__PURE__ */ new Set([...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS]);
var readMemo = /* @__PURE__ */ new Map();
function resetReadings() {
  readMemo = /* @__PURE__ */ new Map();
}
async function readUncached(text, ps, opts) {
  const t0 = performance.now();
  try {
    const result = await parseCalls(text, ps ? "pwsh" : "bash", { noNested: true, ...opts });
    const ms = Math.round(performance.now() - t0);
    if (result.ok) {
      const unknown = result.kinds.filter((k) => !KNOWN_KINDS.has(k));
      if (unknown.length > 0) return { ok: false, reader: false, msg: `node kinds not on the list: ${unknown.join(", ")}`, ms };
      return { ok: true, reader: false, ms, result };
    }
    const first = result.errors[0];
    return { ok: false, reader: first?.reader === true, msg: first?.msg, ms };
  } catch (e) {
    return { ok: false, reader: true, msg: String(e), ms: Math.round(performance.now() - t0) };
  }
}
var readerSeam = {};
function setReaderSeam(opts) {
  readerSeam = opts;
  resetReadings();
  resetLexCache();
}
function readCommand(text, ps, opts = {}) {
  const eff = { ...readerSeam, ...opts };
  if (Object.keys(eff).length > 0) return readUncached(text, ps, eff);
  const key = `${ps ? "p" : "b"}:${text}`;
  let p = readMemo.get(key);
  if (!p) {
    p = readUncached(text, ps, opts);
    readMemo.set(key, p);
  }
  return p;
}
var wordText = (w) => w.lit ?? w.raw;
var isQuotedWord = (w) => /^(?:\$?["']|@["'])/.test(w.raw);
var POSIX_C_CLUSTER = /^-[a-z]*c[a-z]*$/i;
var PS_C_FLAG = /^-(?:c|command|lc)$/i;
function quotedValue(w) {
  if (w.lit !== null) return w.lit;
  const m = /^\$?"((?:\\.|[^"\\])*)"$|^\$?'([^']*)'$/.exec(w.raw);
  return m ? m[1] !== void 0 ? m[1].replace(/\\(["\\])/g, "$1") : m[2] ?? "" : w.raw;
}
function payloadWords(after) {
  if (after.length === 0) return "";
  const first = after[0];
  if (!isQuotedWord(first)) return after.map(wordText).join(" ");
  return quotedValue(first);
}
function evalPayload(after) {
  return after.map((w) => isQuotedWord(w) ? quotedValue(w) : wordText(w)).join(" ");
}
function skipRunnerWords(exe, rest, moves) {
  const values = RUNNER_VALUE_FLAGS[exe];
  let ws = rest;
  for (; ; ) {
    const tok = ws[0]?.lit;
    if (tok === void 0 || tok === null || !tok.startsWith("-") || tok === "-") return ws;
    if (tok === "--") return ws.slice(1);
    if (exe === "sudo" && /^(?:-[DR]|--chdir|--chroot)/.test(tok)) moves.on = true;
    ws = values?.has(tok) ? ws.slice(2) : ws.slice(1);
  }
}
function starterFromWords(rest) {
  const moves = rest.some((w) => /^-wo\w*$/i.test(w.lit ?? ""));
  const fp = rest.findIndex((w) => /^-filepath$/i.test(w.lit ?? ""));
  const split = (ws) => ws.flatMap((w) => wordText(w).split(/[\s,]+/)).map(cleanToken).filter(Boolean);
  if (fp >= 0 && rest[fp + 1]) return { exe: baseName(wordText(rest[fp + 1])), args: split(rest.filter((_, k) => k !== fp && k !== fp + 1)), moves };
  const toks = split(rest);
  const at = toks.findIndex((t) => !/^(?:-\S+|\/[a-z]+)$/i.test(t));
  if (at < 0 || !toks[at]) return { exe: "start-process", args: toks, moves };
  return { exe: baseName(toks[at]), args: toks.filter((_, k) => k !== at), moves };
}
function invocationOf(call) {
  const moves = { on: false };
  let ws = call.words;
  const done = (inv) => moves.on ? { ...inv, moves: true } : inv;
  for (let depth = 0; depth < 8; depth++) {
    if (ws.length === 0) return null;
    if (ws[0].lit === null) return done({ exe: "", args: ws.slice(1).map(wordText), unreadable: true });
    const exe = baseName(ws[0].lit);
    const rest = ws.slice(1);
    if (RUNNERS.has(exe)) {
      ws = skipRunnerWords(exe, rest, moves);
    } else if (exe === "cmd") {
      let at = 0;
      while (at < rest.length && /^\/[a-z]$/i.test(rest[at].lit ?? "")) at++;
      return done({ exe, args: [], nested: payloadWords(rest.slice(at)) });
    } else if (SHELLS2.has(exe)) {
      const at = rest.findIndex((w) => POSIX_SHELLS.has(exe) ? POSIX_C_CLUSTER.test(w.lit ?? "") || /^-command$/i.test(w.lit ?? "") : PS_C_FLAG.test(w.lit ?? ""));
      if (at >= 0) return done({ exe, args: [], nested: payloadWords(rest.slice(at + 1)) });
      if (call.stdin) return done({ exe, args: [], nested: call.stdin.lit ?? "", ...call.stdin.lit === null ? { stdinUnknown: true } : {} });
      return done({ exe, args: rest.map(wordText) });
    } else if (EVALS.has(exe)) {
      const after = /^-command$/i.test(rest[0]?.lit ?? "") ? rest.slice(1) : rest;
      return done({ exe, args: [], nested: exe === "eval" ? evalPayload(after) : payloadWords(after) });
    } else if (STARTERS.has(exe)) {
      return done(starterFromWords(rest));
    } else if (PREFIXES.has(exe)) {
      ws = rest;
    } else if (exe === "timeout") {
      let at = 0;
      while (at < rest.length && (rest[at].lit ?? "").startsWith("-")) at++;
      ws = rest.slice(at + 1);
    } else {
      return done({ exe, args: rest.map(wordText) });
    }
  }
  return null;
}
function quoteSpans(raw, ps) {
  const esc = ps ? "`" : "\\";
  const out = [];
  const n = raw.length;
  if (/^@['"]/.test(raw)) {
    const q = raw[1];
    const close = raw.lastIndexOf(`${q}@`);
    if (close <= 2) return null;
    out.push({ from: 2, to: close, kind: q === '"' ? "dq" : "fill" });
    return out;
  }
  let i = 0;
  while (i < n) {
    const c = raw[i];
    if (c === esc) {
      if (i + 1 >= n) return null;
      out.push({ from: i + 1, to: i + 2, kind: "esc" });
      i += 2;
    } else if (c === "'") {
      let j = i + 1;
      for (; ; ) {
        j = raw.indexOf("'", j);
        if (j < 0) return null;
        if (ps && raw[j + 1] === "'") j += 2;
        else break;
      }
      out.push({ from: i + 1, to: j, kind: "fill" });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && raw[j] !== '"') j += raw[j] === esc ? 2 : 1;
      if (j >= n) return null;
      out.push({ from: i + 1, to: j, kind: "dq" });
      i = j + 1;
    } else i++;
  }
  return out;
}
function lexedFromReading(text, res, ps) {
  const n = text.length;
  const t = text.split("");
  const m = text.split("");
  const bodies = /* @__PURE__ */ new Set();
  const dqSubs = /* @__PURE__ */ new Set();
  const execs = res.substs.map((s) => [s.from, s.to]);
  const heredocs = res.heredocs ?? [];
  const inExec = (k) => execs.some(([a, b]) => a <= k && k < b);
  const innerExecs = (a, b) => execs.filter(([x, y]) => a <= x && y <= b);
  const fill = (a, b) => {
    const inner = innerExecs(a, b);
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) if (!inner.some(([x, y]) => x <= k && k < y)) m[k] = FILL;
  };
  for (const [a, b] of res.freeRanges) {
    if (heredocs.some((h) => h.start === a && h.end === b)) continue;
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) t[k] = m[k] = " ";
  }
  const inBodySubst = (k) => execs.some(([x, y]) => x <= k && k < y && res.bodies.some(([p, q]) => p <= x && y <= q));
  for (const [a, b] of res.quoted) {
    if (!inBodySubst(a)) fill(a, b);
  }
  for (const [a, b] of res.bodies) {
    if (!ps && a > 0 && text[a - 1] === "\n") m[a - 1] = FILL;
    const inner = innerExecs(a, b);
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) {
      if (inner.some(([x, y]) => x <= k && k < y)) continue;
      m[k] = FILL;
      bodies.add(k);
    }
  }
  for (const s of res.substs) {
    if (!s.dq) continue;
    dqSubs.add(s.from);
    if (text[s.to - 1] === "`") dqSubs.add(s.to - 1);
  }
  for (const c of res.calls) {
    for (const w of c.words) {
      for (const s of quoteSpans(w.raw, ps) ?? []) if (s.kind === "esc") fill(w.start + s.from, w.start + s.to);
    }
    const cont = ps ? "`" : "\\";
    for (let k = c.start; k < Math.min(c.end, n); k++) {
      const crlf = text[k] === "\r" && text[k + 1] === "\n";
      if (!crlf && !(text[k] === "\n" && text[k - 1] !== "\r")) continue;
      if (k === 0 || text[k - 1] !== cont) continue;
      if (res.freeRanges.some(([a, b]) => a <= k - 1 && k - 1 < b)) continue;
      m[k] = FILL;
      if (crlf) m[k + 1] = FILL;
    }
  }
  return { text: t.join(""), masked: m.join(""), dqSubs, bodies, execs, calls: res.calls.filter((c) => !c.viaPayload) };
}
var TRIGGER_TEXT = /(?:^|[^A-Za-z0-9_])cr(?![A-Za-z0-9_])|coderabbit|review/i;
var holdsTrigger = (text) => TRIGGER_TEXT.test(text.replace(/["'`\\]/g, ""));
var lexCache = /* @__PURE__ */ new Map();
function resetLexCache() {
  lexCache.clear();
}
async function prepareLex(joined, ps) {
  const key = `${ps ? "p" : "b"}:${joined}`;
  if (lexCache.has(key)) return;
  if (!holdsTrigger(joined)) {
    lexCache.set(key, plainLexed(joined));
    return;
  }
  const r = await readCommand(joined, ps);
  lexCache.set(key, r.ok ? lexedFromReading(joined, r.result, ps) : plainLexed(joined));
}
var plainLexed = (text) => ({ text, masked: text, dqSubs: /* @__PURE__ */ new Set(), bodies: /* @__PURE__ */ new Set(), execs: [] });
function lexOf(joined, ps) {
  return lexCache.get(`${ps ? "p" : "b"}:${joined}`) ?? plainLexed(joined);
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
  const lexed = lexOf(text, ps);
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
  return SHELLS2.has(program) || EVALS.has(program) || STARTERS.has(program) || RUNNERS.has(program) || program === "cmd";
}
function isExecuted(lexed, fine, at) {
  const seg = fine.find(([a, b]) => a <= at && at < b);
  if (seg !== void 0 && readsText(leadingProgram(lexed.text.slice(seg[0], seg[1])))) return true;
  if (lexed.bodies.has(at)) return false;
  return lexed.execs.some(([a, b]) => a <= at && at < b);
}
async function runsQuotedString(lexed, from, to, ps) {
  if (!lexed.calls) return true;
  const inside = lexed.calls.filter((c) => c.words.length > 0 && c.start >= from && c.end <= to).sort((x, y) => x.start - y.start || y.end - x.end);
  const lead = inside[0];
  if (lead) {
    const head = lead.words[0].lit;
    if (head !== null && STARTERS.has(baseName(head))) return true;
    const inv = invocationOf(lead);
    if (inv?.nested !== void 0) return false;
    if (inv !== null && STRING_RUNNERS.has(inv.exe)) return true;
  }
  for (const call of inside) {
    for (let k = 0; k < call.words.length; k++) {
      const w = call.words[k];
      if (w.lit === null || isQuotedWord(w)) continue;
      const prog = baseName(w.lit);
      if (!(SHELLS2.has(prog) || EVALS.has(prog) || STARTERS.has(prog) || prog === "cmd" || STRING_RUNNERS.has(prog))) continue;
      const sub = invocationOf({ ...call, words: call.words.slice(k) });
      if (sub?.nested !== void 0) {
        if (await holdsReviewCall(sub.nested, ps)) return true;
      } else if (!POSIX_SHELLS.has(prog)) return true;
    }
  }
  return false;
}
function commandEnd(lexed, from) {
  const m = /\|\||&&|[;|&\n]/.exec(lexed.masked.slice(from));
  return m ? from + (m.index ?? 0) : lexed.text.length;
}
async function rawScan(lexed, ps = false) {
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
      if (quoted) quotedRuns ??= await runsQuotedString(lexed, a, b, ps);
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
var reviewLike = (text) => rawReview(text.replace(/["'`\\]/g, ""));
function readerWhy(r, ps) {
  const msg = r.msg ?? "";
  if (!r.reader) return /^node kinds not on the list/.test(msg) ? "the command holds a construct the reader does not know" : "the command did not parse";
  if (ps) {
    if (/timeout/i.test(msg)) return `the PowerShell reader timed out after ${r.ms} ms`;
    if (/bad json/i.test(msg)) return "the PowerShell reader gave bad output";
    return "the PowerShell reader failed";
  }
  if (/no tree/i.test(msg)) return "the shell parser gave no tree";
  if (/ENOENT|wasm|WebAssembly|instantiate|Cannot find module|ERR_MODULE/i.test(msg)) return "the shell parser did not load";
  return "the shell parser failed";
}
async function unitsOf(joined, lexed, ps) {
  const reading = await readCommand(joined, ps);
  if (!reading.ok || !reading.result) throw new Error(`the command cannot be read: ${reading.msg ?? "no reading"}`);
  const rows = [];
  for (const call of reading.result.calls) {
    if (call.viaPayload) continue;
    const inv = invocationOf(call);
    if (inv) rows.push({ start: call.start, end: call.end, text: lexed.text.slice(call.start, call.end).trim(), inv, call });
  }
  const wrappers = rows.filter((r) => r.inv?.nested !== void 0);
  return rows.filter((r) => !wrappers.some((w) => w !== r && w.start <= r.start && r.end <= w.end));
}
async function unitsOfText(command, ps) {
  const joined = command;
  await prepareLex(joined, ps);
  return unitsOf(joined, lexOf(joined, ps), ps);
}
async function classifyCommand(source, ps = false, depth = 0) {
  const joined = source;
  await prepareLex(joined, ps);
  if (rawBilling(source, ps) || rawBilling(joinContinuations(source, ps), ps)) {
    return { verdict: "block", reason: BILLING_REASON };
  }
  const gate = holdsTrigger(joined);
  if (gate) {
    const reading = await readCommand(joined, ps);
    if (!reading.ok) {
      const why = readerWhy(reading, ps);
      if (!reviewLike(joined)) return { verdict: "ignore", readerError: why };
      return { verdict: "block", reason: !reading.reader && why === "the command did not parse" ? wayOut(why) : cannotCheck(why) };
    }
  }
  const lexed = lexOf(joined, ps);
  const text = lexed.text;
  const raw = await rawScan(lexed, ps);
  let runs = 0;
  let allowed = false;
  const plainCall = depth === 0 && isPlainCommand(source, joined, lexed, ps);
  const hidden = raw.reviewSegments.map((r) => ({ ...r, parsed: 0, covered: false, placed: false, invs: [] }));
  const counted = [];
  let unaccounted = false;
  let unplaced = false;
  for (const { start, end, text: seg, inv } of gate ? await unitsOf(joined, lexed, ps) : []) {
    const owner = hidden.find((h) => h.start <= start && end <= h.end);
    if (!inv) continue;
    if (inv.stdinUnknown && reviewLike(joined)) return { verdict: "block", reason: wayOut("the shell reads a script the check cannot see") };
    if (inv.unreadable && (inv.args[0] === "review" || [...lexed.masked.slice(start, end).matchAll(CR_WORD)].length > 0)) {
      return { verdict: "block", reason: wayOut("the program word is not readable") };
    }
    let c;
    if (inv.nested === void 0) c = classifyInvocation(inv, plainCall && leadsWithCr(seg));
    else if (depth < MAX_NESTING) c = await classifyCommand(inv.nested, ps, depth + 1);
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
async function classifyShellSegment(segment, ps = false) {
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
function cdTarget2(dir, target, home, ps) {
  const expanded = home && /^~(?=[\\/]|$)/.test(target) ? join3(home, target.slice(1)) : target;
  return resolve3(dir, ps ? expanded : expanded.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:"));
}
async function effectiveCwd(command, cwd, ps = false, home = "") {
  let dir = cwd;
  for (const unit of await unitsOfText(command, ps)) {
    const { target } = cdTargetOf(unit, ps);
    if (target && target !== "-") dir = cdTarget2(dir, target, home, ps);
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
function namesAnswerKey(path3) {
  const segs = slashLower(path3).split("/");
  for (let i = 0; i < segs.length; i++) {
    const tail = segs.slice(i).join("/");
    if (ANSWER_KEY_GLOBS.some((g) => matchGlob(slashLower(g), tail) || matchGlob(slashLower(g), `${tail}/_`))) return true;
  }
  return false;
}
function configDeny(cwd, files) {
  for (const file of files) {
    const abs = resolve3(cwd, file);
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
  return existsSync2(join3(root, EVAL_TREE)) ? { root } : { skip: true };
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
var CD_NAME_PS = /^(?:cd|chdir|pushd|popd|push-location|pop-location|set-location|sl)$/i;
var CD_NAME_BASH = /^(?:cd|pushd|popd)$/;
var CD_POP_NAME = /^(?:popd|pop-location)$/i;
function cdWordOf(unit, ps, wide = false) {
  if (!unit.call) return (wide || ps ? CD_WORD_PS : CD_WORD_BASH).test(unit.text);
  const name = unit.call.words[0]?.lit;
  return name != null && (wide || ps ? CD_NAME_PS : CD_NAME_BASH).test(name);
}
function cdTargetOf(unit, ps) {
  if (!unit.call) {
    const m = cdSegment(unit.text, ps);
    return { target: m?.[1] ?? m?.[2] ?? m?.[3], bareBackslash: !ps && m?.[3] !== void 0 && m[3].includes("\\") };
  }
  const ws = unit.call.words;
  const name = ws[0]?.lit;
  if (name == null || !(ps ? CD_NAME_PS : CD_NAME_BASH).test(name) || CD_POP_NAME.test(name)) return { bareBackslash: false };
  let i = 1;
  while (i < ws.length - 1 && /^(?:-\w+|\/d)$/.test(ws[i].lit ?? "")) i++;
  const w = ws[i];
  if (!w) return { bareBackslash: false };
  return { target: w.lit ?? w.raw, bareBackslash: !ps && !isQuotedWord(w) && w.raw.includes("\\") };
}
async function nestedHasCd(text, ps, depth) {
  if (depth > MAX_NESTING) return true;
  for (const unit of await unitsOfText(text, ps)) {
    if (cdWordOf(unit, ps, true)) return true;
    const inv = unit.inv;
    if (inv?.nested !== void 0 && await nestedHasCd(inv.nested, ps, depth + 1)) return true;
  }
  return false;
}
async function folderDeny(command, ps, cwd) {
  let seenCr = false;
  for (const unit of await unitsOfText(command, ps)) {
    const text = unit.text;
    if (cdWordOf(unit, ps)) {
      const { target, bareBackslash } = cdTargetOf(unit, ps);
      if (!target || target === "-" || /[$%`]/.test(target) || target.includes("~") && !/^~(?:[\\/][^~]*)?$/.test(target)) {
        return WAY_OUT;
      }
      if (bareBackslash) return wayOut("a backslash in a cd target is an escape in Bash: write the path with /");
      if (seenCr) return WAY_OUT;
    }
    if ([...text.matchAll(CR_WORD)].length > 0) seenCr = true;
    const inv = unit.inv;
    if (inv?.nested !== void 0 && await nestedHasCd(inv.nested, ps, 0)) return WAY_OUT;
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
async function parseShape(command, ps = false, opts = {}) {
  const raw = rawShape(command, ps);
  if (!raw) return null;
  const override = OVERRIDE.exec(command);
  const reading = await readCommand((override ? command.slice(override[0].length) : command).trim(), ps, opts);
  const calls = reading.result?.calls ?? [];
  if (!reading.ok || calls.length !== raw.groups.length) return null;
  const agrees = calls.every((call, k) => call.words.length === raw.groups[k].length && call.words.every((w, j) => w.lit !== null && w.lit === raw.groups[k][j]));
  return agrees ? raw.shape : null;
}
function rawShape(command, ps) {
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
  return shape.remotes.every((r) => REMOTE_LITERAL.test(r)) ? { shape, groups: groups.map((g) => g.map((t) => t.v)) } : null;
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
async function answerKeyDeny(run) {
  try {
    gitDeadline = Date.now() + ANSWER_BUDGET_MS;
    const shape = await parseShape(run.command, run.ps);
    if (!shape && run.unplaced) return wayOut(shapeCause(run.command, run.ps));
    const cwd = shape ? shape.cd === void 0 ? run.startCwd : cdTarget2(run.startCwd, shape.cd, run.home, run.ps) : run.cwd;
    const folder = await folderDeny(run.command, run.ps, cwd);
    if (folder) return folder;
    const opts = shape ?? readReviewOptions(run.invocations);
    const startToo = shape ? shape.semi === true : cwd !== run.startCwd;
    const folders = [cwd, ...startToo ? [run.startCwd] : [], ...opts.dirs.map((d) => resolve3(cwd, d))];
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
async function classifyDelegate(input) {
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
async function holdsReviewCall(source, ps, depth = 0) {
  const joined = source;
  await prepareLex(joined, ps);
  const lexed = lexOf(joined, ps);
  if ((await rawScan(lexed, ps)).reviewSegments.length > 0 || depth > MAX_NESTING) return true;
  for (const { inv } of holdsTrigger(joined) ? await unitsOf(joined, lexed, ps) : []) {
    if (!inv) continue;
    if (inv.nested !== void 0 ? await holdsReviewCall(inv.nested, ps, depth + 1) : isCrExecutable(inv.exe) && inv.args.some((a) => a.toLowerCase() === "review")) return true;
  }
  return false;
}
async function answerKeyResult(input, command, ps, verdict, seam, env) {
  const blockedReview = (verdict.runs ?? 0) === 0 && verdict.verdict === "block" && await holdsReviewCall(command, ps);
  if ((verdict.runs ?? 0) === 0 && !blockedReview) return null;
  const startCwd = input.cwd || process.cwd();
  const home = homeOf(env);
  const cwd = await (seam.cwdOf ?? ((c, d, p) => effectiveCwd(c, d, p, home)))(command, startCwd, ps);
  const unaccounted = verdict.unaccounted === true || blockedReview && rawOptionCount(command) > 0;
  const reason = await answerKeyDeny({ command, ps, startCwd, cwd, home, invocations: verdict.invocations ?? [], unaccounted, unplaced: verdict.unplaced === true });
  return reason ? { allow: false, reason, answerKey: true } : null;
}
async function decideChecked(input, env, seam) {
  const tool = input.tool_name || "";
  const command = input.tool_input?.command || "";
  const ps = tool === "PowerShell";
  const classify = seam.classify ?? classifyCommand;
  const runsCommand = BASH_TOOLS.has(tool) || DELEGATE_TOOLS.has(tool) && tool !== "Skill" && command !== "";
  if (OVERRIDE.test(command)) {
    const denied2 = runsCommand ? await answerKeyResult(input, command, ps, await classify(command, ps), seam, env) : null;
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
    const d = await classifyDelegate(input);
    if (d.verdict === "block") return { allow: false, reason: d.reason };
    return (command ? await answerKeyResult(input, command, false, await classify(command, false), seam, env) : null) ?? { allow: true };
  }
  if (!BASH_TOOLS.has(tool)) return { allow: true };
  const verdict = await classify(command, ps);
  if (verdict.verdict === "block") return { allow: false, reason: verdict.reason };
  if (verdict.readerError) logGuardDecision("coderabbit-guard", input, "warn", `reader-error-allowed: ${verdict.readerError}`, { command, env });
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };
  const denied = await answerKeyResult(input, command, ps, verdict, seam, env);
  if (denied) return denied;
  const home = homeOf(env);
  const cwd = await (seam.cwdOf ?? ((c, d, p) => effectiveCwd(c, d, p, home)))(command, input.cwd || process.cwd(), ps);
  const key = repoBranchKey(cwd, env);
  const path3 = statePath(env);
  const state = readState(path3);
  const cap = checkRunCap(state, key, runs);
  if (!cap.ok) {
    return {
      allow: false,
      reason: `CodeRabbit guard: run cap reached (${cap.count} of ${MAX_RUNS} cr review --agent runs used for ${key}; this command adds ${runs})`
    };
  }
  writeState(path3, recordRun(state, key, runs));
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
async function decide(input, env = process.env, seam = {}) {
  try {
    resetReadings();
    resetLexCache();
    return await decideChecked(input, env, seam);
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
async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }
  const result = await decide(input);
  if (!result.allow) {
    logDeny(input, result);
    outputDeny(result.reason || "CodeRabbit guard: blocked");
    return;
  }
  outputContinue();
}
if (!process.env.VITEST) {
  main().catch(() => outputContinue());
}
export {
  BILLING_REASON,
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
  hasForbiddenFlags,
  holdsTrigger,
  homeOf,
  invocationOf,
  isCodeWorkspace,
  isCrExecutable,
  isQuotedWord,
  isReadOnlyAutofixDelegate,
  isReadOnlySubcommand,
  isReviewAgent,
  isSkillInstall,
  joinContinuations,
  lexedFromReading,
  logDeny,
  normalizeRemote,
  parseShape,
  parsedOptionCount,
  prepareLex,
  quoteSpans,
  rawBilling,
  rawOptionCount,
  rawScan,
  readCommand,
  readReviewOptions,
  readState,
  recordRun,
  repoBranchKey,
  resetLexCache,
  resetReadings,
  reviewLike,
  setReaderSeam,
  statePath,
  writeState
};
/*! Bundled license information:

sh-syntax/lib/processor.js:
  (* istanbul ignore if -- @preserve *)

sh-syntax/lib/index.js:
  (* istanbul ignore next -- @preserve *)
*/
