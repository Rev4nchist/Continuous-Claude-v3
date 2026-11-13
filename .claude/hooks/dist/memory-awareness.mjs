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

// src/memory-awareness.ts
import { readFileSync as readFileSync5, mkdirSync as mkdirSync6, appendFileSync as appendFileSync3 } from "fs";
import * as path from "path";
import { spawn as spawn2 } from "child_process";

// src/shared/opc-path.ts
import { existsSync } from "fs";
import { join as join2 } from "path";
function getOpcDir() {
  const envOpcDir = process.env.CLAUDE_OPC_DIR;
  if (envOpcDir && existsSync(envOpcDir)) {
    return envOpcDir;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const localOpc = join2(projectDir, "opc");
  if (existsSync(localOpc)) {
    return localOpc;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalClaude = join2(homeDir, ".claude");
    const globalScripts = join2(globalClaude, "scripts", "core");
    if (existsSync(globalScripts) && globalClaude !== projectDir) {
      return globalClaude;
    }
  }
  return null;
}

// src/shared/session-activity.ts
import { existsSync as existsSync2, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join as join3 } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join3(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
  }
  return join3(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync2(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadOrCreate(sessionId) {
  const existing = readActivity(sessionId);
  if (existing) {
    if (!existing.agents) existing.agents = [];
    if (!existing.mcp_servers) existing.mcp_servers = [];
    return existing;
  }
  return {
    session_id: sessionId,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    skills: [],
    hooks: [],
    agents: [],
    mcp_servers: []
  };
}
function upsertEntry(entries, name) {
  const existing = entries.find((e) => e.name === name);
  if (existing) {
    existing.count++;
  } else {
    entries.push({
      name,
      first_seen: (/* @__PURE__ */ new Date()).toISOString(),
      count: 1
    });
  }
}
function logHook(sessionId, hookName) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.hooks, hookName);
  const filePath = getActivityPath(sessionId);
  writeFileSync(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/shared/intent-extractor.ts
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "s",
  "t",
  "just",
  "don",
  "now",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "help",
  "with",
  "our",
  "they",
  "them",
  "their",
  "it",
  "its",
  "this",
  "that",
  "these",
  "what",
  "which",
  "who",
  "whom",
  "and",
  "but",
  "if",
  "or",
  "because",
  "until",
  "while",
  "about",
  "against",
  "also",
  "get",
  "got",
  "make",
  "want",
  "need",
  "look",
  "see",
  "use",
  "like",
  "know",
  "think",
  "take",
  "come",
  "go",
  "say",
  "said",
  "tell",
  "please",
  "help",
  "let",
  "sure",
  "recall",
  "remember",
  "similar",
  "problems",
  "issues"
]);
var META_PATTERNS = [
  /^(can you|could you|would you|please|help me|i want to|i need to|let's|lets)\s+/gi,
  /^(show me|tell me|find|search for|look for|recall|remember)\s+/gi,
  /^(how do i|how can i|how to|what is|what are|where is|where are)\s+/gi,
  /\s+(for me|please|thanks|thank you)$/gi,
  /\?$/g
];
function extractKeywords(prompt) {
  if (typeof prompt !== "string") return "";
  const words = prompt.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 5).join(" ");
}
function extractIntent(prompt) {
  if (typeof prompt !== "string") return "";
  let intent = prompt.trim();
  for (const pattern of META_PATTERNS) {
    intent = intent.replace(pattern, "");
  }
  intent = intent.trim();
  if (intent.length < 5) {
    return extractKeywords(prompt);
  }
  return intent;
}
var SYNTHETIC_TAG = /^<\/?(?:task-notification|system-reminder|local-command-(?:stdout|stderr)|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|agent-message|teammate-message|user-prompt-submit-hook|[a-z][a-z0-9-]*-hook)\b/i;
var MAX_HUMAN_PROMPT_LEN = 8e3;
function isMachineGeneratedPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  const t = prompt.trim();
  if (t.length === 0) return false;
  if (SYNTHETIC_TAG.test(t)) return true;
  if (t.includes("<task-notification")) return true;
  if (t.length > MAX_HUMAN_PROMPT_LEN) return true;
  const names = /* @__PURE__ */ new Set();
  for (const m of t.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    names.add(m[1].toLowerCase());
    if (names.size >= 3) return true;
  }
  return false;
}
function expandGitQuery(prompt) {
  const lower = prompt.toLowerCase().trim();
  const gitExpansions = {
    "push": "git push remote fork origin upstream",
    "git push": "git push remote fork origin upstream",
    "commit": "git commit message workflow",
    "git commit": "git commit message workflow",
    "pr": "pull request pr create review",
    "create pr": "pull request pr create github",
    "pull request": "pull request pr create github",
    "merge": "git merge branch main",
    "rebase": "git rebase branch workflow",
    "checkout": "git checkout branch switch",
    "branch": "git branch create switch",
    "stash": "git stash save pop",
    "reset": "git reset hard soft",
    "force push": "git push force dangerous"
  };
  for (const [pattern, expansion] of Object.entries(gitExpansions)) {
    if (lower === pattern || lower.startsWith(pattern + " ") || lower.endsWith(" " + pattern)) {
      return expansion;
    }
  }
  const gitKeywords = ["git", "push", "commit", "pr", "merge", "rebase", "branch", "pull"];
  const words = new Set(lower.split(/[^a-z]+/).filter(Boolean));
  const hasGitContext = gitKeywords.some((kw) => words.has(kw));
  if (hasGitContext) {
    return prompt + " git remote workflow";
  }
  return null;
}
function deriveRecallIntent(prompt) {
  return expandGitQuery(prompt) || extractIntent(prompt);
}
function cleanSearchTerm(intent) {
  return intent.replace(/[_\/]/g, " ").replace(/\b\w{1,2}\b/g, "").replace(/\s+/g, " ").trim();
}

// src/shared/embedding-client.ts
import {
  closeSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  statSync,
  unlinkSync,
  writeSync
} from "fs";
import { execFileSync } from "child_process";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join as join4 } from "path";
var RELAY_ERROR_LOG = join4(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/shared/embedding-client.ts
import { homedir as homedir2 } from "os";
import { join as join5, resolve as resolve2 } from "path";
import * as net from "net";
var RUN_DIR = join5(homedir2(), ".claude", "run");
function _runDir() {
  return process.env.CCV3_EMBEDDING_RUN_DIR || RUN_DIR;
}
function _daemonInfoPath() {
  return join5(_runDir(), "ccv3-embedding.json");
}
var DAEMON_INFO_PATH = _daemonInfoPath();
var SPAWN_LOCK_PATH = join5(RUN_DIR, "ccv3-embedding-spawn.lock");
function _spawnLockPath() {
  return join5(_runDir(), "ccv3-embedding-spawn.lock");
}
var SPAWN_LOCK_TTL_MS = 6e4;
var FRAME_SIZE_CAP_BYTES = 100 * 1024 * 1024;
var DEFAULT_PING_TIMEOUT_MS = 1500;
var DEFAULT_RECALL_TIMEOUT_MS = 7e3;
var EXPECTED_MODEL = "BAAI/bge-large-en-v1.5";
var EXPECTED_DIM = 1024;
function sendFrame(sock, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf-8");
  if (payload.length > FRAME_SIZE_CAP_BYTES) {
    throw new Error(`frame too large: ${payload.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([header, payload]));
}
function recvFrame(sock, timeoutMs) {
  return new Promise((res, rej) => {
    let received = Buffer.alloc(0);
    let expectedLen = null;
    let settled = false;
    const finish = (cb) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      sock.removeAllListeners("close");
      sock.removeAllListeners("timeout");
      sock.setTimeout(0);
      cb();
    };
    sock.setTimeout(timeoutMs, () => {
      finish(() => rej(new Error("frame read timeout")));
    });
    sock.on("error", (err) => {
      finish(() => rej(err));
    });
    sock.on("close", () => {
      finish(
        () => rej(new Error(`socket closed after ${received.length} bytes`))
      );
    });
    sock.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (expectedLen === null && received.length >= 4) {
        expectedLen = received.readUInt32BE(0);
        if (expectedLen > FRAME_SIZE_CAP_BYTES) {
          finish(() => rej(new Error(`frame too large: ${expectedLen} bytes`)));
          return;
        }
      }
      if (expectedLen !== null && received.length >= 4 + expectedLen) {
        const payload = received.subarray(4, 4 + expectedLen);
        try {
          const parsed = JSON.parse(payload.toString("utf-8"));
          finish(() => res(parsed));
        } catch (err) {
          finish(() => rej(err));
        }
      }
    });
  });
}
function readDaemonInfo() {
  if (!existsSync3(DAEMON_INFO_PATH)) return null;
  try {
    const raw = readFileSync2(DAEMON_INFO_PATH, "utf-8");
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || typeof obj.pid !== "number" || typeof obj.port !== "number" || typeof obj.started_at !== "number" || typeof obj.model !== "string" || typeof obj.dim !== "number") {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}
function isDaemonAlive(info) {
  if (info.pid <= 0) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}
async function pingDaemon(info, timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
  return new Promise((res) => {
    const sock = new net.Socket();
    let settled = false;
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      try {
        sock.setTimeout(0);
        sock.destroy();
      } catch {
      }
      res(val);
    };
    const overallTimer = setTimeout(() => cleanup(null), timeoutMs);
    sock.once("error", () => {
      clearTimeout(overallTimer);
      cleanup(null);
    });
    sock.connect(info.port, "127.0.0.1", () => {
      try {
        sock.setNoDelay(true);
      } catch {
      }
      try {
        sendFrame(sock, { cmd: "ping" });
      } catch {
        clearTimeout(overallTimer);
        cleanup(null);
        return;
      }
      recvFrame(sock, 0).then((reply) => {
        clearTimeout(overallTimer);
        if (reply && typeof reply === "object" && typeof reply.ok === "boolean" && typeof reply.ready === "boolean") {
          cleanup(reply);
        } else {
          cleanup(null);
        }
      }).catch(() => {
        clearTimeout(overallTimer);
        cleanup(null);
      });
    });
  });
}
function _cleanupDiscoveryFile() {
  try {
    if (existsSync3(DAEMON_INFO_PATH)) {
      unlinkSync(DAEMON_INFO_PATH);
    }
  } catch {
  }
}
async function probeDaemon() {
  const info = readDaemonInfo();
  if (!info) return null;
  if (!isDaemonAlive(info)) {
    _cleanupDiscoveryFile();
    return null;
  }
  if (info.model !== EXPECTED_MODEL || info.dim !== EXPECTED_DIM) return null;
  const reply = await pingDaemon(info);
  if (!reply || !reply.ok || !reply.ready) return null;
  if (reply.model && reply.model !== EXPECTED_MODEL) return null;
  if (reply.dim && reply.dim !== EXPECTED_DIM) return null;
  const recallReady = reply.recall_ready === true && reply.loop_ok !== false;
  return { info, ready: reply.ready, recallReady };
}
async function recallViaDaemon(info, query, k, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
  const mode = opts.mode ?? "hybrid";
  const fail = (reason) => {
    if (opts.reasonRef) opts.reasonRef.reason = reason;
  };
  if (!query || !query.trim()) {
    fail("empty_query");
    return null;
  }
  return new Promise((res) => {
    const sock = new net.Socket();
    let settled = false;
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      try {
        sock.setTimeout(0);
        sock.destroy();
      } catch {
      }
      res(val);
    };
    const overallTimer = setTimeout(() => {
      fail("timeout");
      cleanup(null);
    }, timeoutMs);
    sock.once("error", () => {
      clearTimeout(overallTimer);
      fail("transport");
      cleanup(null);
    });
    sock.connect(info.port, "127.0.0.1", () => {
      try {
        sock.setNoDelay(true);
      } catch {
      }
      try {
        sendFrame(sock, { cmd: "recall", query, k, mode });
      } catch {
        clearTimeout(overallTimer);
        fail("transport");
        cleanup(null);
        return;
      }
      recvFrame(sock, 0).then((reply) => {
        clearTimeout(overallTimer);
        if (reply && typeof reply === "object" && reply.ok === true && Array.isArray(reply.results)) {
          const meta = reply._meta;
          if (meta && typeof meta === "object" && (meta.model && meta.model !== EXPECTED_MODEL || meta.dim && meta.dim !== EXPECTED_DIM)) {
            fail("model_mismatch");
            cleanup(null);
            return;
          }
          cleanup(reply.results);
        } else {
          fail("ok_false");
          cleanup(null);
        }
      }).catch(() => {
        clearTimeout(overallTimer);
        fail("transport");
        cleanup(null);
      });
    });
  });
}
function resolveRepoRoot() {
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir && existsSync3(join5(envDir, "opc"))) {
    return resolve2(envDir);
  }
  try {
    const entry = process.argv[1];
    if (entry) {
      let dir = resolve2(entry);
      for (let i = 0; i < 10; i++) {
        const parent = resolve2(dir, "..");
        if (parent === dir) break;
        dir = parent;
        if (existsSync3(join5(dir, "opc", "scripts", "core", "embedding_daemon.py"))) {
          return dir;
        }
      }
    }
  } catch {
  }
  return null;
}
var _uvPathCache = void 0;
function resolveUvPath() {
  if (_uvPathCache !== void 0) return _uvPathCache;
  const isWin = process.platform === "win32";
  const resolved = _probeUvPath(isWin);
  _uvPathCache = resolved;
  return resolved;
}
function _probeUvPath(isWin) {
  const envOverride = process.env.CCV3_UV_PATH;
  if (envOverride && existsSync3(envOverride)) {
    return resolve2(envOverride);
  }
  try {
    const finder = isWin ? "where" : "which";
    const out = execFileSync(finder, ["uv"], {
      windowsHide: true,
      timeout: 2e3,
      encoding: "utf-8"
    });
    const parsed = _parseWhereOutput(String(out));
    if (parsed) return parsed;
  } catch {
  }
  const home = homedir2();
  const candidates = isWin ? [
    join5(home, ".local", "bin", "uv.exe"),
    join5(home, ".cargo", "bin", "uv.exe")
  ] : [
    join5(home, ".local", "bin", "uv"),
    join5(home, ".cargo", "bin", "uv")
  ];
  for (const c of candidates) {
    if (existsSync3(c)) return c;
  }
  return null;
}
function _parseWhereOutput(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).filter((l) => existsSync3(l));
  if (lines.length === 0) return null;
  const exe = lines.find((l) => l.toLowerCase().endsWith("uv.exe"));
  return exe ?? lines[0];
}
function _logLauncher(msg) {
  try {
    const logDir = join5(homedir2(), ".claude", "logs");
    mkdirSync2(logDir, { recursive: true });
    const logFile = join5(logDir, "embedding-daemon-launcher.log");
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
    const fd = openSync(logFile, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}
var _spawnAttempted = false;
function ensureDaemonRunning() {
  if (process.env.CCV3_EMBEDDING_NO_SPAWN === "1") return;
  if (_spawnAttempted) return;
  _spawnAttempted = true;
  const info = readDaemonInfo();
  if (info && isDaemonAlive(info)) return;
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    _logLauncher(
      "embedding-client: repo root not resolvable; skipping spawn"
    );
    return;
  }
  const uvPath = resolveUvPath();
  if (!uvPath) {
    _logLauncher(
      "embedding-client: uv not resolvable; skipping spawn (scheduled task will start daemon at next logon)"
    );
    return;
  }
  const lockPath = _spawnLockPath();
  let acquired = false;
  try {
    acquired = _acquireSpawnLock(lockPath);
  } catch {
    return;
  }
  if (!acquired) {
    return;
  }
  try {
    const child = spawnDetachedHidden(
      uvPath,
      ["run", "--project", "opc", "python", "opc/scripts/core/embedding_daemon.py", "--daemon"],
      {
        cwd: repoRoot,
        stdio: "ignore"
      }
    );
    child.on("error", (err) => {
      console.error(
        `[embedding-client] daemon spawn error: ${err.message ?? err}`
      );
    });
    child.unref();
  } catch (err) {
    try {
      unlinkSync(lockPath);
    } catch {
    }
    console.error(
      `[embedding-client] daemon spawn failed: ${err?.message ?? err}`
    );
  }
}
function _acquireSpawnLock(lockPath) {
  mkdirSync2(_runDir(), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1e3)
  });
  const tryCreate = () => {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    return true;
  };
  try {
    return tryCreate();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  let ageMs;
  try {
    const st = statSync(lockPath);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    try {
      return tryCreate();
    } catch (err2) {
      if (err2?.code === "EEXIST") return false;
      throw err2;
    }
  }
  if (ageMs < SPAWN_LOCK_TTL_MS) {
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {
  }
  try {
    return tryCreate();
  } catch (err3) {
    if (err3?.code === "EEXIST") return false;
    throw err3;
  }
}

// src/shared/host-ram.ts
import { spawnSync as defaultSpawnSync } from "child_process";
import { readFileSync as defaultReadFileSync } from "fs";
import { freemem as defaultFreemem } from "os";
var HOST_RAM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
function getHostRamFloorBytes() {
  const raw = process.env.CCV3_HOST_RAM_FLOOR_BYTES;
  if (!raw) return HOST_RAM_FLOOR_BYTES;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return HOST_RAM_FLOOR_BYTES;
  return parsed;
}
var PROBE_TIMEOUT_MS = 1500;
function getFreeRamBytes(spawnFn = defaultSpawnSync, readFileFn = defaultReadFileSync, platform = process.platform) {
  const override = process.env.CCV3_HOST_RAM_OVERRIDE_BYTES;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  try {
    if (platform === "win32") {
      const result = spawnFn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"
        ],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf-8" }
      );
      const out = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf-8") ?? "";
      const kb2 = parseInt(out.trim(), 10);
      if (Number.isNaN(kb2) || kb2 <= 0) {
        return Number.POSITIVE_INFINITY;
      }
      return kb2 * 1024;
    }
    const meminfo = readFileFn("/proc/meminfo", "utf-8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) {
      return Number.POSITIVE_INFINITY;
    }
    const kb = parseInt(match[1], 10);
    if (Number.isNaN(kb) || kb <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return kb * 1024;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function getFreeRamBytesNoSpawn(freememFn = defaultFreemem, readFileFn = defaultReadFileSync, platform = process.platform) {
  if (platform !== "win32") {
    return getFreeRamBytes(defaultSpawnSync, readFileFn, platform);
  }
  const override = process.env.CCV3_HOST_RAM_OVERRIDE_BYTES;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  try {
    const bytes = freememFn();
    return Number.isFinite(bytes) && bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function isHostMemoryPressured(freeRamBytes = getFreeRamBytes(), floor = getHostRamFloorBytes()) {
  return freeRamBytes < floor;
}

// src/shared/memory-sanitize.ts
function sanitizeMemoryContent(content, cap = 500) {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  let out = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  if (out.length > cap) {
    out = out.slice(0, cap) + "...(truncated)";
  }
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return out;
}
function wrapMemoryContext(body) {
  return `<context source="memory" trust="data-only">
${body}
</context>`;
}

// src/shared/context-bus.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, join as join9, resolve as resolve3, sep as sep2 } from "node:path";

// src/shared/session-bus-id.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

// src/shared/session-id.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join6 } from "path";
var SESSION_ID_FILENAME = ".coordination-session-id";
function getSessionIdFile(options = {}) {
  const claudeDir = join6(process.env.HOME || process.env.USERPROFILE || homedir3(), ".claude");
  if (options.createDir) {
    try {
      mkdirSync3(claudeDir, { recursive: true, mode: 448 });
    } catch {
    }
  }
  return join6(claudeDir, SESSION_ID_FILENAME);
}
function generateSessionId() {
  const spanId = process.env.BRAINTRUST_SPAN_ID;
  if (spanId) {
    return spanId.slice(0, 8);
  }
  return `s-${Date.now().toString(36)}`;
}
function readSessionId() {
  try {
    const sessionFile = getSessionIdFile();
    const id = readFileSync3(sessionFile, "utf-8").trim();
    return id || null;
  } catch {
    return null;
  }
}
function getSessionId(options = {}) {
  if (process.env.COORDINATION_SESSION_ID) {
    return process.env.COORDINATION_SESSION_ID;
  }
  const fileId = readSessionId();
  if (fileId) {
    return fileId;
  }
  if (options.debug) {
    console.error("[session-id] WARNING: No persisted session ID found, generating new one");
  }
  return generateSessionId();
}

// src/shared/session-bus-id.ts
var PROJECT_HASH_LEN = 12;
function defaultCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function hashProjectPath(cwd, realpath = realpathSync) {
  let resolved;
  try {
    resolved = realpath(cwd);
  } catch {
    resolved = cwd;
  }
  const normalized = resolved.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, PROJECT_HASH_LEN);
}
function sanitizeBusPart(part) {
  return part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, ".").slice(0, 40);
}
function getBusId(opts = {}) {
  try {
    const sessionId = sanitizeBusPart(getSessionId());
    const projectHash = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `${sessionId}-${projectHash}`;
  } catch {
    const fallback = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `s-unknown-${fallback}`;
  }
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync4, mkdirSync as mkdirSync4, statSync as statSync2, renameSync } from "fs";
import { dirname, join as join7 } from "path";
import { homedir as homedir4 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join7(homedir4(), ".claude", "logs", "hooks.log");
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
  if (!existsSync4(LOG_DIR)) {
    mkdirSync4(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync4(LOG_FILE)) {
      const stat = statSync2(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId2() {
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
      sessionId: getSessionId2()
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

// src/shared/intel-bus.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync5, mkdirSync as mkdirSync5, renameSync as renameSync2, statSync as statSync3, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname2, join as join8 } from "node:path";
var MAX_LINE_BYTES = 4096;
var MAX_INTEL_BUS_BYTES = 2e6;
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join8(root, ".claude", "logs", "intel-bus.jsonl");
}
function stripNewlinesDeep(value) {
  if (typeof value === "string") {
    return value.replace(/[\r\n]+/g, " ");
  }
  if (Array.isArray(value)) {
    return value.map(stripNewlinesDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripNewlinesDeep(v);
    }
    return out;
  }
  return value;
}
var SECRET_KEY_RE = /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|CONNECTION_?STRING|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL/i;
var SECRET_FIELD_NAME_RE = /^(.*[_-])?(password|passwd|secret|token|api_?key|access_?key|private_?key|authorization|credential|database_url|connection_?string)s?$/i;
var ASSIGNMENT_RE = /([A-Za-z0-9_]{1,128})(\s*[:=]\s*)("?)([^\s]{1,2048})/g;
function redactSecretString(s, keyHint) {
  if (keyHint && s.length > 0 && SECRET_FIELD_NAME_RE.test(keyHint)) {
    return "[REDACTED]";
  }
  let out = s;
  out = out.replace(/sk-[A-Za-z0-9_-]{16,512}/g, "sk-[REDACTED]").replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED-AWS-KEY]").replace(/gh[posru]_[A-Za-z0-9]{30,255}/g, "[REDACTED-GH-TOKEN]").replace(/xox[abprs]-[A-Za-z0-9-]{10,512}/gi, "[REDACTED-SLACK-TOKEN]").replace(
    /eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{6,2048}/g,
    "[REDACTED-JWT]"
  ).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,2048}/gi, "Bearer [REDACTED]").replace(/postgres(ql)?:\/\/[^:@\s/]+:[^@\s/]+@/gi, "postgresql://[REDACTED]@");
  out = out.replace(
    ASSIGNMENT_RE,
    (m, key, sep3, quote) => SECRET_KEY_RE.test(key) ? `${key}${sep3}${quote}[REDACTED]` : m
  );
  return out;
}
function redactSecretsDeep(value, keyHint) {
  if (typeof value === "string") {
    return redactSecretString(value, keyHint);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretsDeep(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, k);
    }
    return out;
  }
  return value;
}
function longestStringKey(obj) {
  let key = null;
  let len = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > len) {
      len = v.length;
      key = k;
    }
  }
  return key;
}
function appendIntelBus(event, opts = {}) {
  if (process.env.CCV3_BUS_OFF === "1") return;
  try {
    const now = opts.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const append = opts.append ?? defaultAppend;
    const path2 = intelBusPath(opts.projectDir);
    const stamped = {
      ...event,
      ts: event.ts ?? now(),
      schema_version: 1
    };
    const normalized = stripNewlinesDeep(redactSecretsDeep(stamped));
    let line = JSON.stringify(normalized) + "\n";
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
      const key = longestStringKey(normalized);
      if (key) {
        const marker = "...(truncated)";
        const withoutField = { ...normalized, [key]: "" };
        const overhead = Buffer.byteLength(JSON.stringify(withoutField) + "\n", "utf-8");
        const budget = MAX_LINE_BYTES - overhead - marker.length;
        if (budget > 0) {
          const original = String(normalized[key]);
          normalized[key] = original.slice(0, budget) + marker;
          line = JSON.stringify(normalized) + "\n";
        }
      }
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
        return;
      }
    }
    maybeRotate(path2, opts.size, opts.rename);
    append(path2, line);
  } catch {
  }
}
function defaultAppend(path2, line) {
  const dir = dirname2(path2);
  if (!existsSync5(dir)) {
    mkdirSync5(dir, { recursive: true });
  }
  appendFileSync2(path2, line, "utf-8");
}
function defaultSize(path2) {
  if (!existsSync5(path2)) return 0;
  return statSync3(path2).size;
}
function resolveMaxBytes() {
  const raw = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  if (raw !== void 0) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MAX_INTEL_BUS_BYTES;
}
function maybeRotate(path2, sizeFn, renameFn) {
  try {
    const size = sizeFn ?? defaultSize;
    const rename = renameFn ?? renameSync2;
    const cap = resolveMaxBytes();
    let live = 0;
    try {
      live = size(path2);
    } catch {
      return;
    }
    if (live >= cap) {
      rename(path2, `${path2}.1`);
    }
  } catch {
  }
}

// src/shared/context-bus.ts
var LATENCY_BUDGET_MS = 50;
function emptyBus(busId) {
  return {
    bus_id: busId,
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0
  };
}
var VALID_BUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
function assertSafeBusId(busId) {
  if (typeof busId !== "string" || busId.length === 0 || busId === "." || busId === ".." || busId.includes("/") || busId.includes("\\") || busId.includes("..") || !VALID_BUS_ID.test(busId)) {
    throw new Error("unsafe bus id");
  }
}
function sessionCacheRoot(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join9(root, ".claude", "cache", "session");
}
function busPath(busId, projectDir) {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join9(sessionRoot, busId, "context.json");
  const resolvedRoot = resolve3(sessionRoot);
  const resolvedFull = resolve3(full);
  const rootWithSep = resolvedRoot.endsWith(sep2) ? resolvedRoot : resolvedRoot + sep2;
  if (!resolvedFull.startsWith(rootWithSep)) {
    throw new Error("bus path escapes session root");
  }
  return full;
}
function busOff() {
  return process.env.CCV3_BUS_OFF === "1";
}
function capTail(arr, cap) {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}
function capByTurn(arr, cap) {
  if (arr.length <= cap) return arr;
  return [...arr].sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0)).slice(arr.length - cap);
}
function coerceBus(busId, parsed) {
  const base = emptyBus(busId);
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed;
  return {
    bus_id: typeof p.bus_id === "string" ? p.bus_id : busId,
    current_intent: typeof p.current_intent === "string" ? p.current_intent : null,
    focus_symbols: capTail(
      Array.isArray(p.focus_symbols) ? p.focus_symbols : [],
      FOCUS_SYMBOLS_CAP
    ),
    files_in_play: coerceFilesInPlay(p.files_in_play),
    recent_findings: capTail(
      Array.isArray(p.recent_findings) ? p.recent_findings : [],
      RECENT_FINDINGS_CAP
    ),
    open_threads: capTail(
      Array.isArray(p.open_threads) ? p.open_threads : [],
      OPEN_THREADS_CAP
    ),
    schema_version: 3,
    compact_generation: typeof p.compact_generation === "number" ? p.compact_generation : 0,
    revision: typeof p.revision === "number" && Number.isFinite(p.revision) ? p.revision : 0,
    current_turn: typeof p.current_turn === "number" && Number.isFinite(p.current_turn) ? p.current_turn : 0
  };
}
function coerceFilesInPlay(value) {
  if (!value || typeof value !== "object") return { load_bearing: [], ambient: [] };
  const v = value;
  const lb = Array.isArray(v.load_bearing) ? v.load_bearing : [];
  const amb = Array.isArray(v.ambient) ? v.ambient : [];
  return {
    load_bearing: capByTurn(lb, LOAD_BEARING_CAP),
    ambient: capTail(amb, LOAD_BEARING_CAP)
  };
}
function defaultRead(path2) {
  try {
    return readFileSync4(path2, "utf-8");
  } catch {
    return null;
  }
}
function readBus(busId, opts = {}) {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);
  const read = opts.read ?? defaultRead;
  const now = opts.now ?? Date.now;
  try {
    const path2 = busPath(id, opts.projectDir);
    const start = now();
    const raw = read(path2);
    const elapsed = now() - start;
    if (elapsed >= LATENCY_BUDGET_MS) {
      reportLatency(id, elapsed, opts);
    }
    if (raw == null) return emptyBus(id);
    return coerceBus(id, JSON.parse(raw));
  } catch {
    return emptyBus(id);
  }
}
function reportLatency(busId, durationMs, opts) {
  const event = {
    bus_id: busId,
    query_type: "bus_read_latency",
    duration_ms: durationMs
  };
  try {
    if (opts.onLatency) {
      opts.onLatency(event);
    } else {
      appendIntelBus({ ...event, bus_id: busId }, { projectDir: opts.projectDir });
    }
  } catch {
  }
}
function safeBusId() {
  try {
    return getBusId();
  } catch {
    return "s-unknown";
  }
}
var LOAD_BEARING_CAP = 50;
var FOCUS_SYMBOLS_CAP = 50;
var RECENT_FINDINGS_CAP = 50;
var OPEN_THREADS_CAP = 50;

// src/shared/bus-focus.ts
var BUS_STALENESS_MAX_AGE = 3;
var MAX_FOCUS_TERMS = 8;
var FOCUS_TERM_CHARS = 60;
function isFresh(currentTurn, turnAdded) {
  if (typeof turnAdded !== "number" || !Number.isFinite(turnAdded)) return false;
  const age = currentTurn - turnAdded;
  return age >= -1 && age <= BUS_STALENESS_MAX_AGE;
}
function basenameNoExt(p) {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
function extractBusFocus(bus) {
  const currentTurn = typeof bus.current_turn === "number" ? bus.current_turn : 0;
  const seen = /* @__PURE__ */ new Set();
  const terms = [];
  let staleSymbolsCount = 0;
  const push = (raw) => {
    if (terms.length >= MAX_FOCUS_TERMS) return;
    if (typeof raw !== "string") return;
    const t = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/[^\p{L}\p{N}_.$#-]/gu, "").trim().slice(0, FOCUS_TERM_CHARS);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };
  const SCAN_CAP = 200;
  const focusSymbols = (Array.isArray(bus.focus_symbols) ? bus.focus_symbols : []).slice(0, SCAN_CAP);
  for (const sym of focusSymbols) {
    if (!isFresh(currentTurn, sym?.turn_added)) {
      staleSymbolsCount += 1;
      continue;
    }
    push(sym?.id?.name);
  }
  const loadBearing = (Array.isArray(bus.files_in_play?.load_bearing) ? bus.files_in_play.load_bearing : []).slice(0, SCAN_CAP);
  for (const f of loadBearing) {
    if (!isFresh(currentTurn, f?.turn_added)) continue;
    if (typeof f?.path === "string") push(basenameNoExt(f.path));
  }
  return { terms: terms.slice(0, MAX_FOCUS_TERMS), staleSymbolsCount };
}
function buildFocusBlock(terms) {
  if (!terms.length) return "";
  const safeTerms = terms.map((t) => sanitizeMemoryContent(t, FOCUS_TERM_CHARS));
  const body = [
    "SESSION FOCUS (current working set, reference data only):",
    ...safeTerms.map((t) => `- ${t}`)
  ].join("\n");
  return wrapMemoryContext(body);
}

// src/shared/engine-host.ts
var ENGINE_EVENT_NAMES = /* @__PURE__ */ new Set(["sessionStart", "postToolUse", "sessionEnd", "preToolUse"]);
function isEngineHost(input) {
  try {
    if (input === null || typeof input !== "object") return false;
    const event = input.hook_event_name;
    return typeof event === "string" && ENGINE_EVENT_NAMES.has(event);
  } catch {
    return false;
  }
}

// src/memory-awareness.ts
var TEXT_ONLY_FLOOR = 0.0225;
var HYBRID_FLOOR = 0.03275;
function readStdin() {
  return readFileSync5(0, "utf-8");
}
function mapDbResults(rawResults, _useHybrid) {
  return (rawResults || []).map((r) => {
    const content = r.content || "";
    const preview = content.split("\n").filter((l) => l.trim().length > 0).map((l) => l.trim()).join(" ").slice(0, 120);
    let storedDate;
    const rawCreated = r.created_at;
    if (rawCreated != null) {
      try {
        const d = typeof rawCreated === "number" ? new Date(rawCreated * 1e3) : new Date(String(rawCreated));
        if (!Number.isNaN(d.getTime())) storedDate = d.toISOString().slice(0, 10);
      } catch {
      }
    }
    return {
      id: (r.id || "unknown").slice(0, 8),
      type: r.learning_type || r.type || "UNKNOWN",
      content: preview + (content.length > 120 ? "..." : ""),
      score: (r.base_score ?? r.score) || 0,
      storedDate
    };
  });
}
async function checkDbMemory(intent, _projectDir, useHybrid, deps = {}) {
  const opcDir = getOpcDir();
  if (!opcDir) return [[], false, "opc dir not found"];
  const searchTerm = cleanSearchTerm(intent);
  const args = [
    "run",
    "python",
    "scripts/core/recall_learnings.py",
    "--query",
    searchTerm,
    "--k",
    "3",
    "--json"
  ];
  if (!useHybrid) {
    args.push("--text-only");
  }
  const result = await runRecallProcess(deps.spawnFn ?? spawn2, args, {
    cwd: opcDir,
    env: {
      ...process.env,
      PYTHONPATH: opcDir
    },
    // Daemon fail-fast (Phase 3 tail): text-only recall is a pure Postgres FTS
    // query with no embed-daemon round-trip -- measured ~750ms warm. Cap it at
    // 5000ms so a degraded DB cannot hold session-start near the 12s hybrid
    // ceiling, while staying well above cold `uv` start (~2.2s) + query so we do
    // NOT reintroduce the 2000ms-SIGKILLs-every-recall regression noted above.
    // Hybrid keeps 12000ms (cold BGE daemon embed warmup).
    timeout: useHybrid ? 12e3 : 5e3,
    killSignal: "SIGKILL"
  });
  return interpretRecallProcess(result, useHybrid);
}
var RECALL_DRAIN_GRACE_MS = 500;
function runRecallProcess(spawnFn, args, options) {
  return new Promise((resolve4) => {
    const chunks = [];
    let settled = false;
    let child = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      try {
        child?.stdout?.destroy();
      } catch {
      }
      resolve4(result);
    };
    const collected = () => Buffer.concat(chunks).toString("utf-8");
    try {
      child = spawnFn("uv", args, { ...options, stdio: ["ignore", "pipe", "ignore"], shell: false });
    } catch (err) {
      settle({ status: null, signal: null, stdout: null, error: err });
      return;
    }
    child.stdout?.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    child.on("error", (error) => settle({ status: null, signal: null, stdout: null, error }));
    child.on("exit", (code, signal) => {
      if (signal) {
        settle({ status: code, signal, stdout: null });
        return;
      }
      setTimeout(() => settle({ status: code, signal: null, stdout: collected() }), RECALL_DRAIN_GRACE_MS).unref();
    });
    child.on("close", (code, signal) => {
      settle({ status: code, signal, stdout: collected() });
    });
  });
}
function shortRecallError(raw) {
  return String(raw).replace(/postgres(?:ql)?(?:\+\w+)?:\/\/\S+/gi, "<db-url>").split("\n")[0].slice(0, 200);
}
function interpretRecallProcess(result, useHybrid) {
  if (result.signal === "SIGKILL") return [[], true, null];
  if (result.error) return [[], false, shortRecallError(result.error.message || result.error.code)];
  if (result.status !== 0) return [[], false, `exit ${result.status}`];
  if (!result.stdout) return [[], false, "empty output"];
  try {
    const data = JSON.parse(result.stdout);
    if (data.error) return [[], false, shortRecallError(data.error)];
    if (!data.results || data.results.length === 0) return [[], false, null];
    return [mapDbResults(data.results, useHybrid), false, null];
  } catch {
    return [[], false, "unparseable output"];
  }
}
function classifyRecallOutcome(input) {
  if (input.error) return "no-db";
  if (input.timedOut) return "timeout";
  if (input.resultsCount === 0) return "miss";
  return input.keptCount === 0 ? "below-floor" : "hit";
}
function mergeResults(local, db) {
  if ((!local || local.length === 0) && (!db || db.length === 0)) {
    return null;
  }
  const localTagged = (local || []).map((r) => ({ ...r, __src: "local" }));
  const dbTagged = (db || []).map((r) => ({ ...r, __src: "db" }));
  const combined = [...localTagged, ...dbTagged];
  const byId = /* @__PURE__ */ new Map();
  for (const row of combined) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, { row, crossed: false });
    } else {
      const crossed = existing.crossed || existing.row.__src !== row.__src;
      const winner = row.score > existing.row.score ? row : existing.row;
      byId.set(row.id, { row: winner, crossed });
    }
  }
  const deduped = Array.from(byId.values());
  deduped.sort((a, b) => b.row.score - a.row.score);
  const top = deduped.slice(0, 3);
  if (top.length === 0) return null;
  const sources = /* @__PURE__ */ new Set();
  for (const t of top) {
    sources.add(t.row.__src);
    if (t.crossed) sources.add("merged");
  }
  const source = sources.has("merged") || sources.size > 1 ? "merged" : sources.has("local") ? "local" : "db";
  const cleaned = top.map(({ row }) => ({
    id: row.id,
    type: row.type,
    content: row.content,
    score: row.score
  }));
  return {
    count: deduped.length,
    results: cleaned,
    source
  };
}
function applyFloor(match, floor) {
  if (!match) return null;
  const filtered = match.results.filter((r) => (r.score ?? 0) >= floor);
  if (filtered.length === 0) return null;
  return {
    count: filtered.length,
    results: filtered,
    source: match.source
  };
}
function getRecallLogPath(projectDir) {
  const dir = path.join(projectDir, ".claude", "logs");
  try {
    mkdirSync6(dir, { recursive: true });
  } catch {
  }
  return path.join(dir, "memory-recall.jsonl");
}
function logRecallFire(entry, projectDir) {
  try {
    appendFileSync3(getRecallLogPath(projectDir), JSON.stringify(entry) + "\n");
  } catch {
  }
}
async function runMemoryAwareness(raw) {
  try {
    return await memoryAwarenessJob(raw);
  } catch {
    return { result: "continue" };
  }
}
async function memoryAwarenessJob(raw) {
  const t0 = Date.now();
  const input = JSON.parse(raw);
  if (isEngineHost(input)) {
    return { result: "continue" };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (process.env.CLAUDE_AGENT_ID) {
    return { result: "continue" };
  }
  if (input.prompt.length < 15) {
    return { result: "continue" };
  }
  if (input.prompt.trim().startsWith("/")) {
    return { result: "continue" };
  }
  if (isMachineGeneratedPrompt(input.prompt)) {
    return { result: "continue" };
  }
  const intent = deriveRecallIntent(input.prompt);
  if (intent.length < 3) {
    return { result: "continue" };
  }
  let busFocus;
  let busId = "unknown";
  let busTurn = 0;
  try {
    const bus = readBus();
    busId = typeof bus.bus_id === "string" ? bus.bus_id : "unknown";
    busTurn = typeof bus.current_turn === "number" ? bus.current_turn : 0;
    busFocus = extractBusFocus(bus);
  } catch {
    busFocus = { terms: [], staleSymbolsCount: 0 };
  }
  const focusTerms = busFocus.terms;
  const focusBlock = buildFocusBlock(focusTerms);
  const freeRamBytes = getFreeRamBytesNoSpawn();
  const hostMemoryPressured = isHostMemoryPressured(freeRamBytes, getHostRamFloorBytes());
  if (hostMemoryPressured) {
    process.stderr.write(
      "[memory-awareness] host RAM low: skipping daemon probe + spawn, text-only fallback\n"
    );
  }
  let probe = null;
  if (!hostMemoryPressured) {
    try {
      probe = await probeDaemon();
    } catch {
      probe = null;
    }
  }
  const daemonReady = !hostMemoryPressured && !!probe?.ready;
  const mode = daemonReady ? "hybrid" : "text-only";
  if (!hostMemoryPressured && !daemonReady) {
    try {
      ensureDaemonRunning();
    } catch {
    }
  }
  const queryBiased = focusTerms.length > 0 && daemonReady;
  const recallQuery = queryBiased ? `${intent} ${focusTerms.join(" ")}` : intent;
  const local = [];
  let db;
  let dbTimedOut;
  let recallError = null;
  let recallVia = "uv";
  let daemonRows = null;
  const daemonFail = {};
  const daemonAttempted = !!probe?.recallReady;
  if (daemonAttempted) {
    try {
      daemonRows = await recallViaDaemon(probe.info, cleanSearchTerm(recallQuery), 3, {
        reasonRef: daemonFail
      });
    } catch {
      daemonRows = null;
      if (!daemonFail.reason) daemonFail.reason = "transport";
    }
  }
  let uvUsedHybrid = false;
  if (daemonRows !== null) {
    db = mapDbResults(daemonRows, true);
    dbTimedOut = false;
    recallVia = "daemon";
  } else {
    uvUsedHybrid = daemonAttempted ? false : daemonReady;
    [db, dbTimedOut, recallError] = await checkDbMemory(recallQuery, projectDir, uvUsedHybrid);
  }
  const mergedRaw = mergeResults(local, db);
  const usedHybridScores = recallVia === "daemon" || uvUsedHybrid;
  const floorApplied = usedHybridScores ? HYBRID_FLOOR : TEXT_ONLY_FLOOR;
  const match = applyFloor(mergedRaw, floorApplied);
  const topScoreRaw = mergedRaw && mergedRaw.results.length > 0 ? mergedRaw.results.reduce((m, r) => Math.max(m, r.score ?? 0), 0) : 0;
  const logEntry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    session_id: input.session_id || "unknown",
    subagent: process.env.CLAUDE_AGENT_ID || null,
    intent,
    results_count: mergedRaw ? mergedRaw.count : 0,
    top_score: topScoreRaw,
    kept_after_floor: match ? match.results.length : 0,
    source: match ? match.source : mergedRaw ? mergedRaw.source : "empty",
    mode,
    daemon_ready: daemonReady,
    recall_ready: !!probe?.recallReady,
    total_elapsed_ms: Date.now() - t0,
    floor_applied: floorApplied,
    // MEDIUM-2 (arbiter 2.1): true = subprocess SIGKILLed before returning
    // output; false = completed normally (even if results_count is 0).
    db_subprocess_timed_out: dbTimedOut,
    // ST-05: 'daemon' when the resident recall op served this fire, else 'uv'.
    recall_via: recallVia,
    daemon_fail_reason: recallVia === "uv" && daemonAttempted ? daemonFail.reason ?? null : null,
    uv_mode: recallVia === "uv" ? uvUsedHybrid ? "hybrid" : "text-only" : null,
    // BLOCKER-2: host-memory-pressure telemetry. host_memory_pressure=true means
    // we forced text-only + skipped the daemon to avoid thrashing the model.
    host_memory_pressure: hostMemoryPressured,
    free_ram_bytes: freeRamBytes,
    embed_fallback_reason: hostMemoryPressured ? "host_memory_pressure" : null,
    outcome: classifyRecallOutcome({
      error: recallError,
      timedOut: dbTimedOut,
      resultsCount: mergedRaw ? mergedRaw.count : 0,
      keptCount: match ? match.results.length : 0
    }),
    recall_error: recallError
  };
  logRecallFire(logEntry, projectDir);
  try {
    appendIntelBus({
      bus_id: busId,
      query_type: "memory_awareness_bus_read",
      biased: queryBiased,
      injected: !!match || focusBlock.length > 0,
      focus_injected: focusBlock.length > 0,
      focus_count: focusTerms.length,
      // The sanitized terms appended to the recall query when biased -- makes a
      // biased recall REPRODUCIBLE from local intel-bus telemetry (premortem
      // review#2, 2026-06-02). Terms are already allowlist-sanitized in
      // bus-focus.ts; here we additionally CAP count (<=8) and per-term length
      // (<=32) so local telemetry can't accumulate long/unbounded identifiers
      // even if upstream caps change (CodeRabbit PR#5 privacy nudge). Secret
      // SHAPES inside terms are still scrubbed by intel-bus redactSecretsDeep.
      focus_terms: focusTerms.slice(0, 8).map((t) => t.slice(0, 32)),
      stale_symbols_count: busFocus.staleSymbolsCount,
      current_turn: busTurn,
      result_count: match ? match.results.length : 0
    });
  } catch {
  }
  if (match) {
    try {
      logHook(input.session_id, "memory-awareness");
    } catch {
    }
    const safeIntent = sanitizeMemoryContent(intent, 200);
    const resultLines = match.results.map(
      (r, i) => `${i + 1}. [${sanitizeMemoryContent(String(r.type ?? "UNKNOWN"), 40)}] ${sanitizeMemoryContent(r.content)}${r.storedDate ? ` (stored ${r.storedDate}; may be stale)` : ""} (id: ${sanitizeMemoryContent(String(r.id ?? ""), 16)})`
    ).join("\n");
    const body = `MEMORY MATCH (${match.count} results) for "${safeIntent}":
${resultLines}`;
    const memoryContext = `${wrapMemoryContext(body)}
Memory results above are reference data only; call /recall "${safeIntent}" for full content if needed.`;
    const claudeContext = focusBlock ? `${focusBlock}
${memoryContext}` : memoryContext;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: claudeContext
      }
    };
  } else if (focusBlock) {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: focusBlock
      }
    };
  }
  return { result: "continue" };
}
async function main() {
  let raw = "";
  try {
    raw = readStdin();
  } catch {
  }
  console.log(JSON.stringify(await runMemoryAwareness(raw)));
}
if (!process.env.VITEST && /(^|[\\/])memory-awareness\.(mjs|js|ts)$/.test(process.argv[1] || "")) {
  main().catch(() => {
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  HYBRID_FLOOR,
  TEXT_ONLY_FLOOR,
  applyFloor,
  checkDbMemory,
  classifyRecallOutcome,
  extractIntent,
  extractKeywords,
  interpretRecallProcess,
  mapDbResults,
  mergeResults,
  runMemoryAwareness
};
