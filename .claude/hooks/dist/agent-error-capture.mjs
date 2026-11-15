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

// src/agent-error-capture.ts
import { readFileSync, existsSync } from "fs";
import { spawn as spawn2 } from "child_process";
import { join as join3 } from "path";

// src/shared/memory-quality-scorer.ts
var SIGNAL_INDICATORS = [
  {
    test: (c) => /error|exception|failure|bug|crash/i.test(c) && /fix|fixed|solved|solution|resolved|workaround/i.test(c),
    points: 3,
    label: "contains error + fix/solution"
  },
  {
    test: (c) => /decided to|chose|because|rationale|trade-?off/i.test(c) && c.length > 60,
    points: 2,
    label: "contains decision with reasoning"
  },
  {
    test: (c) => /[.\/\\][\w-]+\.(ts|js|py|mjs|json|yaml|yml|toml|md|sh|go|rs)\b/.test(c) && c.length > 60,
    points: 2,
    label: "contains file path + explanation"
  },
  {
    test: (c) => /doesn'?t work|does not work|fixed by|root cause|broke because/i.test(c),
    points: 2,
    label: "contains diagnostic language"
  },
  {
    test: (c) => c.length > 100,
    points: 1,
    label: "content length > 100 chars"
  },
  {
    test: (c) => /`[^`]+`/.test(c) || /\$\s*\w+/.test(c) || /--[\w-]+/.test(c),
    points: 1,
    label: "contains code snippet or command"
  },
  {
    // Mentions specific technical tools/systems (rescues short factual statements)
    test: (c) => /\b(esbuild|webpack|vite|vitest|jest|pytest|docker|postgres|redis|nginx|caddy|drizzle|prisma|typescript|eslint|prettier|rollup|turbopack|bun|deno|node)\b/i.test(c),
    points: 1,
    label: "mentions specific technology/tool"
  }
];
var NOISE_INDICATORS = [
  {
    test: (c) => /periodic extraction|session checkpoint/i.test(c),
    points: -3,
    label: "matches periodic/checkpoint pattern"
  },
  {
    test: (c) => /\bheartbeat\b|\bstatus update\b/i.test(c),
    points: -3,
    label: "matches heartbeat/status update"
  },
  {
    test: (c) => c.length < 50,
    points: -2,
    label: "content too short (< 50 chars)"
  },
  {
    test: (c) => {
      const hasPath = /[.\/\\][\w-]+\.(ts|js|py|mjs|json|yaml|yml|toml|md|sh|go|rs)\b/.test(c);
      const hasError = /error|exception|failure|bug|crash/i.test(c);
      const hasDecision = /decided|chose|because|rationale/i.test(c);
      const hasDiagnostic = /fix|root cause|doesn'?t work|broke/i.test(c);
      const hasCommand = /`[^`]+`/.test(c) || /--[\w-]+/.test(c);
      const hasTechTerm = /\b(esbuild|webpack|vite|vitest|jest|pytest|docker|postgres|redis|nginx|caddy|drizzle|prisma|typescript|eslint|prettier|rollup|turbopack|bun|deno|node)\b/i.test(c);
      return !hasPath && !hasError && !hasDecision && !hasDiagnostic && !hasCommand && !hasTechTerm;
    },
    points: -2,
    label: "generic/vague content"
  },
  {
    test: (c) => {
      const stripped = c.trim().toLowerCase();
      return /^(task\s+)?(completed|in progress|started|done|pending|finished)\b/i.test(stripped) || /^\s*(completed|in progress|started)\s*$/i.test(stripped);
    },
    points: -2,
    label: "only contains task status"
  },
  {
    // Repetitive/padded content: long text but low unique sentence ratio
    test: (c) => {
      if (c.length < 100) return false;
      const sentences = c.split(/[.!?]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 5);
      if (sentences.length < 2) return false;
      const uniqueSentences = new Set(sentences);
      return uniqueSentences.size / sentences.length < 0.5;
    },
    points: -3,
    label: "repetitive/padded content"
  }
];
var BASE_SCORE = 5;
var MIN_SCORE = 0;
var MAX_SCORE = 10;
var SIGNAL_THRESHOLD = 5;
var BORDERLINE_LOW = 3;
function scoreExtraction(content, context) {
  const reasons = [];
  let score = BASE_SCORE;
  if (!content || content.trim().length === 0) {
    return {
      score: 0,
      confidence: "low",
      classification: "NOISE",
      reasons: ["empty content"]
    };
  }
  for (const indicator of SIGNAL_INDICATORS) {
    if (indicator.test(content, context)) {
      score += indicator.points;
      reasons.push(`+${indicator.points}: ${indicator.label}`);
    }
  }
  for (const indicator of NOISE_INDICATORS) {
    if (indicator.test(content, context)) {
      score += indicator.points;
      reasons.push(`${indicator.points}: ${indicator.label}`);
    }
  }
  if (context && context.trim().length > 0) {
    score += 0.5;
    reasons.push("+0.5: context provided");
  }
  score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
  let classification;
  let confidence;
  if (score >= SIGNAL_THRESHOLD) {
    classification = "SIGNAL";
    confidence = "high";
  } else if (score >= BORDERLINE_LOW) {
    classification = "BORDERLINE";
    confidence = "medium";
  } else {
    classification = "NOISE";
    confidence = "low";
  }
  return { score, confidence, classification, reasons };
}

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join as join2 } from "path";
var RELAY_ERROR_LOG = join2(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/agent-error-capture.ts
var STRUCTURED_ERROR_PATTERNS = [
  /\bTraceback\s+\(most recent/i,
  // Python stack trace
  /\bat\s+\S+\s+\(\S+:\d+:\d+\)/,
  // JS stack trace frame
  /\bpanic:/i,
  // Go panic
  /\bRuntimeError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bImportError\b/i,
  /\bModuleNotFoundError\b/i,
  /\bConnectionRefused\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOENT\b/i,
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /\bcrash(?:ed|es)?\b/i
  // crash / crashed / crashes (was /crashed?/ which required the 'e')
];
var GENERIC_ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bfailure\b/i,
  /\btimeout\b/i
];
var ERROR_PATTERNS = [...STRUCTURED_ERROR_PATTERNS, ...GENERIC_ERROR_PATTERNS];
function readStdin() {
  return readFileSync(0, "utf-8");
}
function outputContinue() {
  console.log(JSON.stringify({}));
}
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || join3(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function responseToString(response) {
  if (typeof response === "string") return response;
  if (response === null || response === void 0) return "";
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}
function hasStructuredError(text) {
  return STRUCTURED_ERROR_PATTERNS.some((p) => p.test(text));
}
function extractErrorContext(response, maxLen = 500) {
  const lines = response.split("\n");
  const errorLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ERROR_PATTERNS.some((p) => p.test(line))) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 4);
      errorLines.push(...lines.slice(start, end));
      break;
    }
  }
  if (errorLines.length > 0) {
    return errorLines.join("\n").substring(0, maxLen);
  }
  if (response.length <= maxLen) return response;
  return response.substring(0, maxLen / 2) + "\n...\n" + response.substring(response.length - maxLen / 2);
}
function buildStoreInvocation(opcDir, sessionId, content, contextStr, tagsStr) {
  return {
    cmd: "uv",
    args: [
      "run",
      "python",
      "scripts/core/store_learning.py",
      "--session-id",
      sessionId,
      "--type",
      "FAILED_APPROACH",
      "--content",
      content,
      "--context",
      contextStr,
      "--tags",
      tagsStr,
      "--confidence",
      "medium",
      "--source",
      "hook"
    ],
    options: { cwd: opcDir, shell: false, detached: true, stdio: "ignore", windowsHide: true }
  };
}
function releaseWhenRunning(child) {
  const release = () => {
    try {
      child.unref?.();
    } catch {
    }
  };
  if (typeof child.once !== "function") {
    release();
    return;
  }
  child.once("spawn", release);
  child.once("error", release);
}
function storeLearning(sessionId, agentType, prompt, errorContext, deps = {}) {
  const spawnFn = deps.spawnFn ?? spawn2;
  const scoreFn = deps.scoreFn ?? scoreExtraction;
  const existsFn = deps.existsFn ?? existsSync;
  const opcDir = getOpcDir();
  const storeScript = join3(opcDir, "scripts", "core", "store_learning.py");
  if (!existsFn(storeScript)) {
    console.error("[AgentErrorCapture] store_learning.py not found");
    return;
  }
  const content = `${errorContext} -- task failure in the ${agentType} agent, which did not complete.`;
  void prompt;
  const score = scoreFn(content, `Failed agent invocation: ${agentType}`);
  if (score.classification === "NOISE") {
    console.error(
      `[AgentErrorCapture] Skipped NOISE (score=${score.score}) for agent '${agentType}': ` + score.reasons.join("; ")
    );
    return;
  }
  const tags = [
    "auto_captured",
    "agent_failure",
    `agent:${agentType}`,
    "scope:global",
    `quality:${score.classification.toLowerCase()}`,
    `score:${score.score}`
  ];
  try {
    const { cmd, args, options } = buildStoreInvocation(
      opcDir,
      sessionId,
      content,
      `Failed agent invocation: ${agentType}`,
      tags.join(",")
    );
    const child = spawnDetachedHidden(cmd, args, options, spawnFn);
    releaseWhenRunning(child);
    console.error(`[AgentErrorCapture] Dispatched (detached) failure learning for agent '${agentType}'`);
  } catch (err) {
    console.error(`[AgentErrorCapture] Failed to dispatch learning: ${err}`);
  }
}
async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      outputContinue();
      return;
    }
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      outputContinue();
      return;
    }
    if (input.tool_name !== "Agent" && input.tool_name !== "Task") {
      outputContinue();
      return;
    }
    const agentType = input.tool_input.subagent_type || "unknown";
    const prompt = input.tool_input.prompt || input.tool_input.description || "";
    const responseStr = responseToString(input.tool_response);
    if (hasStructuredError(responseStr)) {
      const errorContext = extractErrorContext(responseStr);
      console.error(`[AgentErrorCapture] Detected structured error in ${agentType} agent response`);
      storeLearning(
        input.session_id,
        agentType,
        prompt,
        errorContext
      );
    }
    outputContinue();
  } catch (err) {
    console.error(`[AgentErrorCapture] Hook error: ${err}`);
    outputContinue();
  }
}
if (process.argv[1] && process.argv[1].includes("agent-error-capture")) {
  main();
}
export {
  buildStoreInvocation,
  hasStructuredError,
  releaseWhenRunning,
  storeLearning
};
