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

// src/post-plan-roadmap.ts
import * as fs3 from "fs";
import * as path2 from "path";

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

// src/shared/engine-host.ts
var ENGINE_EVENT_NAMES = /* @__PURE__ */ new Set(["sessionStart", "postToolUse", "sessionEnd", "preToolUse", "userPromptSubmit"]);
function isEngineHost(input) {
  try {
    if (input === null || typeof input !== "object") return false;
    const event = input.hook_event_name;
    return typeof event === "string" && ENGINE_EVENT_NAMES.has(event);
  } catch {
    return false;
  }
}

// src/shared/project-relevance.ts
import * as fs2 from "fs";
import * as path from "path";
import { homedir as homedir2 } from "node:os";
var IDENTITY_STOPWORDS = /* @__PURE__ */ new Set([
  "claude",
  "continuous",
  "code",
  "anthropic",
  "project",
  "the",
  "app",
  "platform",
  "engine",
  "server",
  "service",
  "system"
]);
var FOREIGN_PROJECT_MARKERS = ["salesforce", "fastmcp"];
function getProjectIdentity(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const dirName = path.basename(resolvedDir);
  const identity = {
    dirName,
    registryName: null,
    packageName: null,
    projectPath: resolvedDir,
    keywords: [],
    distinctiveKeywords: [],
    otherProjects: [],
    otherProjectTokens: []
  };
  const dirKeywords = tokenize(dirName);
  const keywordSet = new Set(dirKeywords);
  keywordSet.add(dirName.toLowerCase());
  const otherTokenSet = /* @__PURE__ */ new Set();
  const registry = readRegistry(resolvedDir);
  if (registry) {
    for (const project of registry.projects) {
      const projectPath = path.resolve(project.path);
      if (projectPath === resolvedDir) {
        identity.registryName = project.name;
        for (const w of tokenize(project.name)) keywordSet.add(w);
      } else {
        identity.otherProjects.push(project.name);
        for (const w of tokenize(project.name)) {
          if (!IDENTITY_STOPWORDS.has(w)) otherTokenSet.add(w);
        }
      }
    }
  }
  try {
    const pkgPath = path.join(resolvedDir, "package.json");
    const pkgContent = fs2.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    if (pkg.name && typeof pkg.name === "string") {
      identity.packageName = pkg.name;
      const cleanName = pkg.name.replace(/^@[^/]+\//, "");
      for (const w of tokenize(cleanName)) keywordSet.add(w);
      keywordSet.add(cleanName.toLowerCase());
    }
  } catch {
  }
  if (identity.registryName) {
    keywordSet.add(identity.registryName.toLowerCase());
  }
  identity.keywords = [...keywordSet];
  identity.distinctiveKeywords = identity.keywords.filter((kw) => !IDENTITY_STOPWORDS.has(kw));
  identity.otherProjectTokens = [...otherTokenSet];
  return identity;
}
function tokenize(name) {
  return name.toLowerCase().split(/[-_\s]+/).filter((w) => w.length > 1);
}
function matchesAsWord(content, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_\s/]+/g, "[-_\\s/]+");
  try {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(content);
  } catch {
    return content.toLowerCase().includes(term.toLowerCase());
  }
}
function isContentRelevantToProject(content, identity) {
  if (!content || content.length < 50) {
    return { relevant: true, confidence: "low", reason: "content too short" };
  }
  const distinctiveNames = [identity.registryName, identity.dirName, identity.packageName].filter((n) => !!n);
  for (const name of distinctiveNames) {
    if (matchesAsWord(content, name)) {
      return { relevant: true, confidence: "high", reason: `matches project identity "${name}"` };
    }
  }
  for (const kw of identity.distinctiveKeywords) {
    if (kw.length < 3) continue;
    if (matchesAsWord(content, kw)) {
      return { relevant: true, confidence: "high", reason: `matches distinctive keyword "${kw}"` };
    }
  }
  if (identity.projectPath && content.toLowerCase().includes(identity.projectPath.toLowerCase())) {
    return { relevant: true, confidence: "high", reason: "mentions this project path" };
  }
  for (const otherName of identity.otherProjects) {
    if (matchesAsWord(content, otherName)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions "${otherName}" but not "${thisName}"`
      };
    }
  }
  for (const token of identity.otherProjectTokens) {
    if (token.length < 3) continue;
    if (matchesAsWord(content, token)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project token "${token}" but no "${thisName}" identity`
      };
    }
  }
  for (const marker of FOREIGN_PROJECT_MARKERS) {
    if (matchesAsWord(content, marker)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project "${marker}" but no "${thisName}" identity`
      };
    }
  }
  return { relevant: true, confidence: "low", reason: "no cross-project signals" };
}
function readRegistry(projectDir) {
  const ccv3Dir = process.env.CLAUDE_CCV3_DIR || path.join(homedir2(), "continuous-claude");
  const candidates = [
    path.join(projectDir, ".claude", "project-registry.json"),
    path.join(ccv3Dir, ".claude", "project-registry.json")
  ];
  for (const candidate of candidates) {
    try {
      const content = fs2.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.projects)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}

// src/shared/roadmap-parser.ts
var SECTION_PREFIXES = [
  // Order matters: more specific first.
  { key: "sessions", prefix: "## recent planning" },
  { key: "current", prefix: "## current" },
  { key: "completed", prefix: "## completed" },
  { key: "planned", prefix: "## planned" }
];
function detectSection(strippedLower) {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith("## ")) {
    return null;
  }
  return void 0;
}
function bucketize(rawPriority) {
  const p = rawPriority.toLowerCase();
  if (p.includes("high")) return "high";
  if (p.includes("low")) return "low";
  return "medium";
}
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: /* @__PURE__ */ new Map()
  };
  if (!content) return result;
  const lines = content.split("\n");
  let section = null;
  let sectionStart = -1;
  const closeSection = (endLine) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();
    const detected = detectSection(lower);
    const isAnyH2 = stripped.startsWith("## ");
    const isKnownH2 = typeof detected === "string";
    const isUnrelatedH2 = detected === null;
    if (isKnownH2) {
      closeSection(i);
      section = detected;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**") && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, "").trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, "").trim();
        } else {
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }
    if (section === "completed") {
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || ""
        });
      }
      continue;
    }
    if (section === "planned") {
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || "normal";
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority)
        });
      }
      continue;
    }
    if (section === "sessions") {
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: []
        });
        continue;
      }
      if (result.sessions.length > 0 && stripped.startsWith("-")) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }
    void isAnyH2;
  }
  closeSection(lines.length);
  return result;
}

// src/shared/roadmap-splice.ts
function applySplices(lines, ops) {
  const byStart = [...ops].sort((a, b) => a.range.start - b.range.start);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const cur = byStart[i];
    if (cur.range.start < prev.range.end) {
      throw new Error(
        `applySplices: overlapping ranges -- "${prev.label}" [${prev.range.start}, ${prev.range.end}) and "${cur.label}" [${cur.range.start}, ${cur.range.end})`
      );
    }
  }
  const result = lines.slice();
  const descending = [...ops].sort((a, b) => b.range.start - a.range.start);
  for (const op of descending) {
    result.splice(op.range.start, op.range.end - op.range.start, ...op.lines);
  }
  return result;
}
function insertAfterHeader(section, block, label) {
  return {
    range: { start: section.start + 1, end: section.start + 1 },
    lines: block,
    label
  };
}
function insertAtEof(lines, block, label) {
  return {
    range: { start: lines.length, end: lines.length },
    lines: block,
    label
  };
}
function findSubBlocks(lines, section, headerRe = /^###\s/) {
  const blocks = [];
  let open = null;
  for (let i = section.start; i < section.end; i++) {
    if (headerRe.test(lines[i])) {
      if (open) {
        blocks.push({ header: open.header, range: { start: open.start, end: i } });
      }
      open = { header: lines[i], start: i };
    }
  }
  if (open) {
    blocks.push({ header: open.header, range: { start: open.start, end: section.end } });
  }
  return blocks;
}
function findSessionBlock(lines, section, date) {
  const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dateRe = new RegExp(`^###\\s*${escapedDate}:`);
  const blocks = findSubBlocks(lines, section);
  return blocks.find((b) => dateRe.test(b.header)) ?? null;
}
function replaceLine(index, line, label) {
  return { range: { start: index, end: index + 1 }, lines: [line], label };
}

// src/shared/roadmap-audit.ts
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, readdirSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename4, dirname as dirname3, join as join6 } from "node:path";

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync as readFileSync2,
  statSync as statSync2,
  constants
} from "fs";
import { dirname as dirname2, basename as basename3, join as join5 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join as join4 } from "path";
import { homedir as homedir3 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join4(homedir3(), ".claude", "logs", "hooks.log");
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
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId() {
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
      sessionId: getSessionId()
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
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join5(dir, `.${basename3(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync(tmpFile);
    } catch {
    }
    throw err;
  }
}
var missingLockDirsLogged = /* @__PURE__ */ new Set();
function warnLockDirMissing(lockFile) {
  const dir = dirname2(lockFile);
  if (missingLockDirsLogged.has(dir)) return;
  missingLockDirsLogged.add(dir);
  log.warn("Lock dir missing, lock not acquired", { lockFile, dir });
}
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync2(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startTime > timeoutMs) {
          log.error("Lock acquisition timed out", { lockFile, timeoutMs });
          return false;
        }
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
        }
      } else if (err.code === "ENOENT") {
        warnLockDirMissing(lockFile);
        return false;
      } else {
        log.error("Lock acquisition failed", { lockFile, error: String(err) });
        return false;
      }
    }
  }
}
function releaseLockSync(filePath) {
  const lockFile = filePath + ".lock";
  try {
    if (existsSync2(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function mutateStateWithLock(filePath, transformFn, opts = {}) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const lockStart = Date.now();
  const locked = acquireLockSync(filePath, lockTimeoutMs);
  const waitMs = Date.now() - lockStart;
  if (opts.onLockOutcome) {
    try {
      opts.onLockOutcome({ acquired: locked, wait_ms: waitMs });
    } catch {
    }
  }
  if (!locked) {
    log.warn("mutateStateWithLock: lock not acquired, skipping write", { filePath });
    return false;
  }
  try {
    let current;
    if (!existsSync2(filePath)) {
      current = null;
    } else {
      try {
        current = readFileSync2(filePath, "utf-8");
      } catch (err) {
        log.warn("mutateStateWithLock: existing file unreadable, aborting write", {
          filePath,
          error: String(err)
        });
        return false;
      }
    }
    let next;
    try {
      next = transformFn(current);
    } catch (err) {
      log.error("mutateStateWithLock: transform threw, leaving file untouched", {
        filePath,
        error: String(err)
      });
      return false;
    }
    if (next == null) {
      return false;
    }
    const writeStart = Date.now();
    atomicWriteSync(filePath, next);
    if (opts.onWriteTiming) {
      try {
        opts.onWriteTiming({ write_ms: Date.now() - writeStart });
      } catch {
      }
    }
    return true;
  } catch (err) {
    log.error("mutateStateWithLock: write failed", { filePath, error: String(err) });
    return false;
  } finally {
    releaseLockSync(filePath);
  }
}

// src/shared/roadmap-audit.ts
var MAX_REFUSED_DELETIONS = 20;
var CATASTROPHIC_MIN_RATIO = 0.25;
function sha256Prefix16(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}
function multisetCounts(lines) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}
function computeRemovedLines(beforeLines, afterLines) {
  const beforeCounts = multisetCounts(beforeLines);
  const afterCounts = multisetCounts(afterLines);
  const removed = [];
  for (const [line, count] of beforeCounts) {
    const remaining = count - (afterCounts.get(line) ?? 0);
    for (let i = 0; i < remaining; i++) {
      removed.push(line);
    }
  }
  return removed;
}
function defaultWrite(roadmapPath, before, after) {
  const captured = { transformDeclined: false, lockOutcome: null, writeMs: void 0 };
  const wrote = mutateStateWithLock(
    roadmapPath,
    (current) => {
      const observed = current ?? "";
      if (observed === before) return after;
      captured.transformDeclined = true;
      return null;
    },
    {
      onLockOutcome: (o) => {
        captured.lockOutcome = o;
      },
      onWriteTiming: (o) => {
        captured.writeMs = o.write_ms;
      }
    }
  );
  if (wrote) {
    return { wrote: true, wait_ms: captured.lockOutcome?.wait_ms, write_ms: captured.writeMs };
  }
  if (captured.lockOutcome && !captured.lockOutcome.acquired) {
    return { wrote: false, reason: "lock_timeout", wait_ms: captured.lockOutcome.wait_ms };
  }
  if (captured.transformDeclined) {
    return {
      wrote: false,
      reason: "concurrent_modification",
      wait_ms: captured.lockOutcome?.wait_ms
    };
  }
  return { wrote: false, reason: "write_failed", wait_ms: captured.lockOutcome?.wait_ms };
}
var ROADMAP_MANUAL_MARKER = /<!--\s*roadmap-sync\s*:\s*manual\s*-->/i;
var BAK_KEEP = 10;
function roadmapBakPath(projectDir, when = /* @__PURE__ */ new Date()) {
  const slug = basename4(projectDir).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = sha256Prefix16(projectDir).slice(0, 8);
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const nonce = randomBytes(3).toString("hex");
  return join6(homedir4(), ".claude", "state", "roadmap-bak", `${slug}-${hash}`, `${stamp}-${nonce}.md`);
}
function rotateBaks(dir) {
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - BAK_KEEP))) {
      try {
        unlinkSync2(join6(dir, stale));
      } catch {
      }
    }
  } catch {
  }
}
function defaultBackup(bakPath, content) {
  const dir = dirname3(bakPath);
  mkdirSync2(dir, { recursive: true });
  writeFileSync2(bakPath, content, "utf-8");
  rotateBaks(dir);
}
function defaultAppendLog(logPath, line) {
  mkdirSync2(dirname3(logPath), { recursive: true });
  appendFileSync2(logPath, line, "utf-8");
}
function appendAudit(projectDir, record, appendLogDep) {
  try {
    const logPath = join6(projectDir, ".claude", "logs", "roadmap-sync.jsonl");
    const line = JSON.stringify(record) + "\n";
    (appendLogDep ?? defaultAppendLog)(logPath, line);
  } catch {
  }
}
function writeRoadmapGuarded(args) {
  const {
    hook,
    tool,
    roadmapPath,
    projectDir,
    before,
    after,
    ops,
    allowedDeletions,
    allowFullRewrite,
    sessionId,
    deps
  } = args;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeBytes = Buffer.byteLength(before, "utf-8");
  const afterBytes = Buffer.byteLength(after, "utf-8");
  const base = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    hook,
    tool: tool ?? "unknown",
    project_dir: projectDir,
    roadmap_path: roadmapPath,
    before_sha256: sha256Prefix16(before),
    after_sha256: sha256Prefix16(after),
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    line_delta: afterLines.length - beforeLines.length,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    bytes_delta: afterBytes - beforeBytes,
    ops,
    session_id: sessionId ?? null
  };
  const finish = (outcome, extra = {}) => {
    const record = {
      ...base,
      outcome,
      bak_path: null,
      bak_error: null,
      ...extra
    };
    appendAudit(projectDir, record, deps?.appendLog);
    return { outcome, record };
  };
  if (after === before) {
    return finish("noop");
  }
  if (ROADMAP_MANUAL_MARKER.test(before)) {
    return finish("skipped", { reason: "opt_out_manual" });
  }
  if (!allowFullRewrite) {
    const allowedSet = new Set(allowedDeletions ?? []);
    const removed = computeRemovedLines(beforeLines, afterLines);
    const refused = removed.filter((line) => !allowedSet.has(line));
    if (refused.length > 0) {
      return finish("skipped", {
        reason: "deletion_guard",
        refused_deletions: refused.slice(0, MAX_REFUSED_DELETIONS)
      });
    }
  } else {
    const beforeTrim = before.trim();
    const afterTrim = after.trim();
    const tooSmall = beforeLines.length > 0 && afterLines.length < beforeLines.length * CATASTROPHIC_MIN_RATIO;
    if (beforeTrim !== "" && (afterTrim === "" || tooSmall)) {
      return finish("skipped", { reason: "catastrophic_rewrite" });
    }
  }
  const bakPath = roadmapBakPath(projectDir);
  let bakError = null;
  try {
    (deps?.backup ?? defaultBackup)(bakPath, before);
  } catch (err) {
    bakError = err instanceof Error ? err.message : String(err);
  }
  let writeResult;
  try {
    writeResult = (deps?.write ?? defaultWrite)(roadmapPath, before, after);
  } catch {
    writeResult = { wrote: false, reason: "write_failed" };
  }
  if (!writeResult.wrote) {
    return finish("skipped", {
      reason: writeResult.reason ?? "write_failed",
      bak_path: bakPath,
      bak_error: bakError,
      wait_ms: writeResult.wait_ms,
      write_ms: writeResult.write_ms
    });
  }
  return finish("written", {
    bak_path: bakPath,
    bak_error: bakError,
    wait_ms: writeResult.wait_ms,
    write_ms: writeResult.write_ms
  });
}

// src/shared/roadmap-sync-guards.ts
function localDateStamp(now = /* @__PURE__ */ new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// src/post-plan-roadmap.ts
function renderSectionBody(key, sections) {
  const lines = [];
  if (key === "current") {
    lines.push("## Current Focus");
    if (sections.current) {
      lines.push(`**${sections.current.title}**`);
      if (sections.current.description) {
        lines.push(`- ${sections.current.description}`);
      }
      if (sections.current.started) {
        lines.push(`- Started: ${sections.current.started}`);
      }
    } else {
      lines.push("No current focus set.");
    }
  } else if (key === "completed") {
    lines.push("## Completed");
    if (sections.completed.length > 0) {
      for (const item of sections.completed) {
        const dateStr = item.completed ? ` (${item.completed})` : "";
        lines.push(`- [x] ${item.title}${dateStr}`);
      }
    } else {
      lines.push("_No completed items yet._");
    }
  } else if (key === "planned") {
    lines.push("## Planned");
    if (sections.planned.length > 0) {
      for (const item of sections.planned) {
        const bucket = item.priorityBucket || "medium";
        lines.push(`- [ ] ${item.title} (${bucket} priority)`);
      }
    } else {
      lines.push("_No planned items yet._");
    }
  } else {
    lines.push("## Recent Planning Sessions");
    if (sections.sessions.length > 0) {
      for (const session of sections.sessions.slice(0, 5)) {
        lines.push(...renderSessionBlockCompact(session), "");
      }
    } else {
      lines.push("_No planning sessions recorded._");
    }
  }
  return lines;
}
function renderSessionBlock(session) {
  const lines = [];
  lines.push(`### ${session.date}: ${session.title}`);
  if (session.summary) {
    lines.push(`**Summary:** ${session.summary}`);
    lines.push("");
  }
  if (session.decisions.length > 0) {
    lines.push("**Key Decisions:**");
    for (const decision of session.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }
  if (session.steps && session.steps.length > 0) {
    lines.push("**Implementation:**");
    for (const step of session.steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  if (session.files && session.files.length > 0) {
    lines.push(`**Files:** ${session.files.join(", ")}`);
    lines.push("");
  }
  if (session.verification && session.verification.length > 0) {
    lines.push(`**Verification:** ${session.verification[0]}`);
    lines.push("");
  }
  return lines;
}
function planPathForRoadmap(projectDir, planPath) {
  if (!planPath) return void 0;
  const root = path2.resolve(projectDir);
  const full = path2.resolve(planPath);
  const rel = path2.relative(root, full);
  if (!rel || rel.startsWith("..") || path2.isAbsolute(rel)) return full;
  return rel.split(path2.sep).join("/");
}
function renderSessionBlockCompact(session) {
  const lines = [`### ${session.date}: ${session.title}`];
  if (session.planPath) {
    lines.push(`**Plan:** ${session.planPath}`);
  }
  return lines;
}
function generateRoadmap(sections) {
  const lines = ["# Project Roadmap", ""];
  lines.push(...renderSectionBody("current", sections), "");
  lines.push(...renderSectionBody("completed", sections), "");
  lines.push(...renderSectionBody("planned", sections), "");
  lines.push(...renderSectionBody("sessions", sections));
  return lines.join("\n");
}
var FOCUS_FUNCTION_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "but",
  "for",
  "nor",
  "so",
  "yet",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "via",
  "is",
  "are",
  "as"
]);
function looksFilenameDerived(title) {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/[.,;:!?()[\]{}"'`]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some((w) => FOCUS_FUNCTION_WORDS.has(w.toLowerCase()) && w === w.toLowerCase())) return false;
  return words.every((w) => /^[A-Z]/.test(w));
}
function isSeedableFocusTitle(title) {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed || trimmed === "Planning Session") return false;
  if (looksFilenameDerived(trimmed)) return false;
  return true;
}
var CURRENT_FOCUS_PLACEHOLDER = "No current focus set.";
function findPlaceholderLine(lines, range) {
  for (let i = range.start; i < range.end; i++) {
    if (lines[i].trim() === CURRENT_FOCUS_PLACEHOLDER) return i;
  }
  return null;
}
function applyRoadmapUpdate(doc, update) {
  const original = doc.rawContent;
  if (!original.trim()) {
    const seededCurrent = doc.current === null && isSeedableFocusTitle(update.focusTitle) ? { title: update.focusTitle, started: update.today } : doc.current;
    const seeded = {
      ...doc,
      current: seededCurrent,
      sessions: [update.session, ...doc.sessions]
    };
    const content2 = generateRoadmap(seeded);
    return {
      content: content2,
      ops: [{ label: "fresh-file", lines_removed: 0, lines_added: content2.split("\n").length }]
    };
  }
  const lines = original.split("\n");
  const ops = [];
  const opSummaries = [];
  const addOp = (op) => {
    ops.push(op);
    opSummaries.push({
      label: op.label,
      lines_removed: op.range.end - op.range.start,
      lines_added: op.lines.length
    });
  };
  if (doc.current === null && isSeedableFocusTitle(update.focusTitle)) {
    const currentRange = doc.rawSections.get("current");
    if (currentRange) {
      const placeholderIdx = findPlaceholderLine(lines, currentRange);
      if (placeholderIdx !== null) {
        addOp(replaceLine(placeholderIdx, `**${update.focusTitle}**`, "focus-seed"));
      } else {
        addOp(insertAfterHeader(currentRange, [`**${update.focusTitle}**`], "focus-seed-insert"));
      }
    } else {
      addOp(
        insertAtEof(
          lines,
          ["", "## Current Focus", `**${update.focusTitle}**`, ""],
          "focus-seed-new-section"
        )
      );
    }
  }
  const sessionsRange = doc.rawSections.get("sessions");
  const sessionBlockLines = [...renderSessionBlockCompact(update.session), ""];
  if (sessionsRange) {
    const existing = findSessionBlock(lines, sessionsRange, update.today);
    if (!existing) {
      addOp(insertAfterHeader(sessionsRange, sessionBlockLines, "session-insert"));
    } else {
      const titleMatch = existing.header.match(/^###\s*\d{4}-\d{2}-\d{2}:\s*(.+)$/);
      const existingTitle = titleMatch ? titleMatch[1].trim() : "";
      if (existingTitle !== update.session.title) {
        addOp(insertAfterHeader(sessionsRange, sessionBlockLines, "session-insert-same-day"));
      }
    }
  } else {
    addOp(
      insertAtEof(lines, ["## Recent Planning Sessions", ...sessionBlockLines], "session-insert-new-section")
    );
  }
  const content = applySplices(lines, ops).join("\n");
  return { content, ops: opSummaries };
}
function parseSections(content) {
  const sections = {};
  const lines = content.split("\n");
  let currentSection = "_intro";
  let sectionContent = [];
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (sectionContent.length > 0) {
        sections[currentSection] = sectionContent.join("\n");
      }
      currentSection = h2Match[1].trim().toLowerCase();
      sectionContent = [];
    } else {
      sectionContent.push(line);
    }
  }
  if (sectionContent.length > 0) {
    sections[currentSection] = sectionContent.join("\n");
  }
  return sections;
}
function isFenceLine(trimmed) {
  return /^(```|~~~)/.test(trimmed);
}
function isListMarker(trimmed) {
  return /^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);
}
function cleanBulletText(bulletText) {
  if (!bulletText) return null;
  let cleanText = bulletText.replace(/^\[[ x]\]\s*/i, "");
  cleanText = cleanText.replace(/^\*\*([^*]+?)[\s:.;,]*\*\*[\s:]*/, "$1: ").replace(/^`([^`]+)`\s*[-–]\s*/, "").replace(/^\*([^*]+)\*:?\s*/g, "$1 ").replace(/::\s*\*/g, ": ").replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim();
  if (cleanText.length < 15) return null;
  if (cleanText.startsWith("|") || cleanText.startsWith("```")) return null;
  if (cleanText.match(/^`[^`]+`$/) || cleanText.match(/^[A-Za-z_]+\.[a-z]+$/)) return null;
  if (cleanText.match(/\{[^}]+\}/) && cleanText.length < 50) return null;
  return cleanText;
}
function extractBullets(content, keywords) {
  const bullets = [];
  const lines = content.split("\n");
  let inFence = false;
  let current = null;
  const flush = () => {
    if (current === null) return;
    const raw = current.join(" ").trim();
    current = null;
    const cleanText = cleanBulletText(raw);
    if (cleanText === null) return;
    if (keywords) {
      const lower = cleanText.toLowerCase();
      if (!keywords.some((kw) => lower.includes(kw))) return;
    }
    bullets.push(cleanText);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isListMarker(trimmed)) {
      flush();
      current = [trimmed.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim()];
      continue;
    }
    if (current === null) continue;
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith("|")) {
      flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();
  return bullets;
}
function extractFirstParagraph(content) {
  const lines = content.split("\n");
  const paragraphLines = [];
  let foundStart = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundStart) {
      if (trimmed.startsWith("#") || !trimmed) continue;
      foundStart = true;
    }
    if (foundStart && (!trimmed || trimmed.startsWith("#"))) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(trimmed);
  }
  const summary = paragraphLines.join(" ").slice(0, 300);
  return summary.length === 300 ? summary + "..." : summary;
}
function extractFilesFromContent(content) {
  const files = [];
  const backtickMatches = content.match(/`([^`]+\.[a-z]{2,4})`/gi) || [];
  for (const match of backtickMatches) {
    const file = match.replace(/`/g, "");
    if (file.includes("/") || file.includes("\\") || file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  const tableMatches = content.match(/\|\s*`?([^|`]+\.[a-z]{2,4})`?\s*\|/gi) || [];
  for (const match of tableMatches) {
    const file = match.replace(/[|`\s]/g, "");
    if (file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  return [...new Set(files)];
}
function extractPlanInfo(rawPlanContent, filePath) {
  const planContent = rawPlanContent.replace(/\r\n?/g, "\n");
  const sections = parseSections(planContent);
  let title = "Planning Session";
  const titleMatch = planContent.match(/^#\s+(?:Plan:\s*)?(.+)/m);
  if (titleMatch && titleMatch[1].trim() !== "Planning Session") {
    title = titleMatch[1].trim();
  } else if (filePath) {
    const basename5 = filePath.replace(/\\/g, "/").split("/").pop()?.replace(".md", "") || "";
    if (basename5 && !basename5.match(/^plan[-_]?\d*$/i)) {
      title = basename5.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    }
  }
  let summary = "";
  const summarySection = sections["summary"] || sections["problem summary"] || sections["purpose"] || sections["overview"];
  if (summarySection) {
    summary = extractFirstParagraph(summarySection);
  } else if (sections["_intro"]) {
    summary = extractFirstParagraph(sections["_intro"]);
  }
  const decisionSection = sections["decisions"] || sections["key decisions"] || sections["approach"] || "";
  const decisions = extractBullets(decisionSection);
  const implSection = sections["implementation plan"] || sections["implementation"] || sections["steps"] || sections["plan"] || "";
  let steps = extractBullets(implSection);
  if (steps.length === 0 && sections["step 1"]) {
    steps = Object.keys(sections).filter((k) => k.match(/^step \d/)).map((k) => sections[k].split("\n")[0]?.trim() || k).filter(Boolean);
  }
  const verifySection = sections["verification"] || sections["verification plan"] || sections["testing"] || sections["test plan"] || "";
  const verification = extractBullets(verifySection);
  const filesSection = sections["files to modify"] || sections["files"] || sections["affected files"] || "";
  let affectedFiles = extractFilesFromContent(filesSection);
  if (affectedFiles.length === 0) {
    affectedFiles = extractFilesFromContent(planContent);
  }
  return {
    title,
    summary: summary.slice(0, 500),
    decisions: decisions.slice(0, 10),
    steps: steps.slice(0, 8),
    verification: verification.slice(0, 5),
    affectedFiles: affectedFiles.slice(0, 10)
  };
}
function storePlanningLearnings(planInfo, projectDir, hookSessionId) {
  const decisions = planInfo.decisions.slice(0, 5);
  if (decisions.length === 0) {
    console.error("No decisions to store in memory");
    return;
  }
  const contentLines = [
    `Planning: ${planInfo.title}`,
    "",
    "Decisions:",
    ...decisions.map((d) => `- ${d}`)
  ];
  if (planInfo.steps.length > 0) {
    contentLines.push("", "Key Steps:", ...planInfo.steps.slice(0, 3).map((s) => `- ${s}`));
  }
  const content = contentLines.join("\n");
  const opcDir = process.env.CLAUDE_OPC_DIR || path2.join(process.env.USERPROFILE || process.env.HOME || "", "continuous-claude", "opc");
  const sessionId = hookSessionId || `plan-${Date.now()}`;
  try {
    const child = spawnDetachedHidden("uv", [
      "run",
      "python",
      "scripts/core/store_learning.py",
      "--session-id",
      sessionId,
      "--type",
      "ARCHITECTURAL_DECISION",
      "--content",
      content,
      "--context",
      `planning: ${planInfo.title}`,
      "--tags",
      "planning,decisions,architecture",
      "--confidence",
      "high",
      "--source",
      "hook"
    ], {
      cwd: opcDir,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: "." }
    });
    child.unref();
  } catch {
  }
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (isEngineHost(data)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (data.tool_name !== "ExitPlanMode") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  const planDirNested = path2.join(projectDir, ".claude", "plans");
  const planDirDirect = path2.join(projectDir, "plans");
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const userPlanDir = path2.join(userHome, ".claude", "plans");
  const hasPlanFiles = (dir) => {
    try {
      return fs3.existsSync(dir) && fs3.readdirSync(dir).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  };
  const planDir = hasPlanFiles(planDirNested) ? planDirNested : hasPlanFiles(planDirDirect) ? planDirDirect : hasPlanFiles(userPlanDir) ? userPlanDir : planDirNested;
  const isGlobalPlanDir = planDir === userPlanDir;
  const STALENESS_THRESHOLD_MS = 6e5;
  let planContent = "";
  let latestPlanPath;
  if (fs3.existsSync(planDir)) {
    const now = Date.now();
    const planFiles = fs3.readdirSync(planDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => ({
      name: f,
      mtime: fs3.statSync(path2.join(planDir, f)).mtime.getTime()
    })).filter((f) => {
      if (isGlobalPlanDir) return now - f.mtime < STALENESS_THRESHOLD_MS;
      return true;
    }).sort((a, b) => b.mtime - a.mtime);
    if (planFiles.length > 0) {
      planContent = fs3.readFileSync(path2.join(planDir, planFiles[0].name), "utf-8");
      latestPlanPath = path2.join(planDir, planFiles[0].name);
    }
  }
  const toolOutput = data.tool_output || data.tool_result || "";
  if (!planContent && toolOutput) {
    planContent = toolOutput;
  }
  let sections;
  if (fs3.existsSync(roadmapPath)) {
    const existingContent = fs3.readFileSync(roadmapPath, "utf-8");
    sections = parseRoadmap(existingContent);
  } else {
    sections = {
      current: null,
      completed: [],
      planned: [],
      sessions: [],
      rawContent: "",
      rawSections: /* @__PURE__ */ new Map()
    };
  }
  const planInfo = extractPlanInfo(planContent, latestPlanPath);
  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(planContent, identity);
  if (!relevance.relevant) {
    console.error(`[post-plan-roadmap] BLOCKED: Plan is about a different project. ${relevance.reason}`);
    console.log(JSON.stringify({
      result: "continue",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `ROADMAP update skipped: cross-project guard triggered. "${planInfo.title}" does not match project "${identity.dirName}". ${relevance.reason}`
      }
    }));
    return;
  }
  const today = localDateStamp();
  const planPathForEntry = planPathForRoadmap(projectDir, latestPlanPath);
  const newSession = {
    date: today,
    planPath: planPathForEntry,
    title: planInfo.title,
    summary: planInfo.summary || void 0,
    decisions: planInfo.decisions.slice(0, 5),
    steps: planInfo.steps.length > 0 ? planInfo.steps.slice(0, 5) : void 0,
    verification: planInfo.verification.length > 0 ? planInfo.verification.slice(0, 3) : void 0,
    files: planInfo.affectedFiles.length > 0 ? planInfo.affectedFiles.slice(0, 8) : void 0
  };
  const { content: newContent, ops } = applyRoadmapUpdate(sections, {
    session: newSession,
    today,
    focusTitle: planInfo.title
  });
  const wasFreshFile = !sections.rawContent.trim();
  const focusSeeded = ops.some((o) => o.label === "focus-seed");
  const allowedDeletions = focusSeeded ? [CURRENT_FOCUS_PLACEHOLDER] : [];
  const { outcome, record } = writeRoadmapGuarded({
    hook: "post-plan-roadmap",
    tool: data.tool_name,
    roadmapPath,
    projectDir,
    before: sections.rawContent,
    after: newContent,
    ops,
    allowedDeletions,
    allowFullRewrite: wasFreshFile,
    sessionId: data.session_id ?? null
  });
  storePlanningLearnings(planInfo, projectDir, data.session_id);
  console.error(`[post-plan-roadmap] ROADMAP.md ${outcome}: ${planInfo.title}`);
  const stats = [
    `Goal: ${planInfo.title}`,
    `Decisions: ${planInfo.decisions.length}`,
    `Steps: ${planInfo.steps.length}`,
    `Files: ${planInfo.affectedFiles.length}`
  ].join(" | ");
  const advisories = [];
  const focusOpLabels = new Set(ops.map((o) => o.label));
  const focusWasSeeded = focusOpLabels.has("focus-seed") || focusOpLabels.has("focus-seed-insert") || focusOpLabels.has("focus-seed-new-section");
  if (sections.current !== null) {
    advisories.push(
      `Current Focus unchanged ("${sections.current.title}" is still active) -- new goal "${planInfo.title}" was NOT recorded there. Run /roadmap focus to switch.`
    );
  } else if (!focusWasSeeded) {
    advisories.push(
      `Current Focus left vacant -- "${planInfo.title}" did not pass the seed quality gate (looks like a placeholder or filename-derived title). Run /roadmap focus to set it manually.`
    );
  }
  const sessionAdded = ops.some((o) => o.label.startsWith("session-insert"));
  const totalSessionBlocks = sections.sessions.length + (sessionAdded ? 1 : 0);
  if (totalSessionBlocks > 8) {
    advisories.push(
      `Recent Planning Sessions now has ${totalSessionBlocks} entries -- consider an archive sweep into ROADMAP.archive.md.`
    );
  }
  const contextLines = outcome === "written" ? ["Planning session recorded:", stats, `ROADMAP: ${roadmapPath}`] : [
    `ROADMAP entry NOT recorded (outcome: ${outcome}${record.reason ? `, reason: ${record.reason}` : ""}).`,
    stats,
    `ROADMAP: ${roadmapPath}`
  ];
  contextLines.push(...advisories);
  const output = {
    result: "continue",
    message: outcome === "written" ? `\u{1F4CB} ROADMAP.md updated: ${planInfo.title}` : `\u26A0\uFE0F ROADMAP.md NOT updated (${outcome}): ${planInfo.title}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: contextLines.join("\n")
    }
  };
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve4) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve4(data));
    setTimeout(() => resolve4(data), 1e3).unref();
  });
}
main().catch((err) => {
  console.error("[post-plan-roadmap] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  applyRoadmapUpdate,
  extractBullets,
  extractPlanInfo,
  planPathForRoadmap,
  renderSessionBlock,
  renderSessionBlockCompact
};
