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

// src/roadmap-reconcile.ts
import * as fs2 from "fs";
import * as path from "path";
import { execSync } from "child_process";

// src/shared/session-source.ts
var COMPACT_SOURCE = "compact";
function parseSessionSource(stdin) {
  try {
    const doc = JSON.parse(stdin);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
      const source = doc.source;
      if (typeof source === "string" && source !== "") return source;
    }
  } catch {
  }
  return "startup";
}
function isCompactSource(source) {
  return source === COMPACT_SOURCE;
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

// src/roadmap-reconcile.ts
var PACKAGE_ALIASES = {
  "passport": ["passport", "passport.js"],
  "redis": ["redis", "ioredis"],
  "mongoose": ["mongoose"],
  "prisma": ["prisma", "@prisma/client"],
  "apollo-server": ["apollo-server", "@apollo/server"],
  "socket.io": ["socket.io"],
  "helmet": ["helmet"],
  "express": ["express"],
  "fastify": ["fastify"],
  "next": ["next", "next.js", "nextjs"],
  "react": ["react"],
  "vue": ["vue", "vue.js", "vuejs"],
  "angular": ["@angular/core", "angular"],
  "tailwind": ["tailwindcss", "tailwind"],
  "jest": ["jest"],
  "vitest": ["vitest"],
  "mocha": ["mocha"],
  "webpack": ["webpack"],
  "vite": ["vite"],
  "esbuild": ["esbuild"],
  "typeorm": ["typeorm"],
  "sequelize": ["sequelize"],
  "knex": ["knex"],
  "graphql": ["graphql"],
  "axios": ["axios"],
  "lodash": ["lodash"],
  "moment": ["moment"],
  "dayjs": ["dayjs"],
  "zod": ["zod"],
  "joi": ["joi"]
};
function buildPackageLookup() {
  const lookup = /* @__PURE__ */ new Map();
  for (const [pkg, aliases] of Object.entries(PACKAGE_ALIASES)) {
    for (const alias of aliases) {
      lookup.set(alias.toLowerCase(), pkg);
    }
  }
  return lookup;
}
var PACKAGE_LOOKUP = buildPackageLookup();
function extractPaths(text) {
  const matches = text.match(/\b(?:src|lib|app|packages|modules|components)\/[\w/.-]+/g);
  return matches ? matches.map((p) => p.replace(/\/+$/, "")) : [];
}
function extractDecisions(content) {
  const decisions = [];
  const lines = content.split("\n");
  let inDecisionTable = false;
  let headerSeen = false;
  let separatorSeen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && /decision/i.test(trimmed) && !headerSeen) {
      inDecisionTable = true;
      headerSeen = true;
      continue;
    }
    if (inDecisionTable && !separatorSeen && /^\|[\s-|]+\|$/.test(trimmed)) {
      separatorSeen = true;
      continue;
    }
    if (inDecisionTable && separatorSeen && trimmed.startsWith("|")) {
      const cells = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length >= 2) {
        decisions.push({
          decision: cells[0],
          rationale: cells[1]
        });
      }
      continue;
    }
    if (inDecisionTable && !trimmed.startsWith("|")) {
      inDecisionTable = false;
      headerSeen = false;
      separatorSeen = false;
    }
  }
  return decisions;
}
function extractMilestones(content) {
  const milestones = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const completedMatch = trimmed.match(/^-\s*\[x\]\s+(.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?(?:\s*`[^`]*`)?$/i);
    if (completedMatch) {
      milestones.push({
        title: completedMatch[1].trim(),
        completed: true,
        date: completedMatch[2] || null
      });
      continue;
    }
    const plannedMatch = trimmed.match(/^-\s*\[\s*\]\s+(.+)$/);
    if (plannedMatch) {
      milestones.push({
        title: plannedMatch[1].trim(),
        completed: false,
        date: null
      });
    }
  }
  return milestones;
}
function extractCurrentFocus(content) {
  const currentMatch = content.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
  if (!currentMatch) return null;
  const section = currentMatch[1].trim();
  if (/no current goal/i.test(section)) return null;
  const titleMatch = section.match(/\*\*([^*]+)\*\*/);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();
  const details = section.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.trim().replace(/^-\s*/, "")).join(" ");
  return { title, details };
}
function extractMentionedFiles(content) {
  const files = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const filesMatch = trimmed.match(/^\*?\*?Files:\*?\*?\s*(.+)$/i);
    if (filesMatch) {
      const fileList = filesMatch[1].split(",").map((f) => f.trim()).filter((f) => f.length > 0);
      files.push(...fileList);
    }
  }
  return files;
}
function extractMentionedPackages(content) {
  const packages = [];
  const contentLower = content.toLowerCase();
  for (const [alias, pkgName] of PACKAGE_LOOKUP) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(contentLower)) {
      if (!packages.includes(pkgName)) {
        packages.push(pkgName);
      }
    }
  }
  return packages;
}
function validateDecisions(decisions, packageJson) {
  const issues = [];
  const allDeps = {
    ...packageJson.dependencies || {},
    ...packageJson.devDependencies || {}
  };
  const depNames = new Set(Object.keys(allDeps).map((d) => d.toLowerCase()));
  for (const decision of decisions) {
    const text = decision.decision.toLowerCase();
    for (const [alias, pkgName] of PACKAGE_LOOKUP) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(text)) {
        const allAliases = PACKAGE_ALIASES[pkgName] || [pkgName];
        const found = allAliases.some((a) => depNames.has(a.toLowerCase()));
        if (!found) {
          issues.push(`Decision mentions "${pkgName}" but it is not in package.json`);
        }
      }
    }
  }
  return issues;
}
function validateMilestones(milestones, gitLog) {
  const issues = [];
  const logLower = gitLog.toLowerCase();
  const STOP_WORDS = /* @__PURE__ */ new Set(["the", "and", "for", "with", "from", "that", "this", "have", "been", "will", "been", "into", "also", "some", "than", "then", "when", "what", "which", "about", "after", "before"]);
  for (const milestone of milestones) {
    if (!milestone.completed) continue;
    const titleWords = milestone.title.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 5 && !STOP_WORDS.has(w));
    const matchCount = titleWords.filter((w) => logLower.includes(w)).length;
    const threshold = Math.min(2, titleWords.length);
    if (matchCount < threshold) {
      issues.push(`Completed milestone "${milestone.title}" has no matching commit in recent git log`);
    }
  }
  return issues;
}
function validateCurrentFocus(focus, existingPaths) {
  if (!focus) return [];
  const issues = [];
  const allText = `${focus.title} ${focus.details}`;
  const paths = extractPaths(allText);
  for (const normalized of paths) {
    if (!existingPaths.has(normalized)) {
      issues.push(`Current focus mentions "${normalized}" but it does not exist`);
    }
  }
  return issues;
}
function reconcile(projectDir) {
  const roadmapPath = path.join(projectDir, "ROADMAP.md");
  if (!fs2.existsSync(roadmapPath)) {
    return {};
  }
  let content;
  try {
    content = fs2.readFileSync(roadmapPath, "utf-8");
  } catch {
    return {};
  }
  const allIssues = [];
  const decisions = extractDecisions(content);
  const milestones = extractMilestones(content);
  const focus = extractCurrentFocus(content);
  const mentionedFiles = extractMentionedFiles(content);
  const packageJsonPath = path.join(projectDir, "package.json");
  if (fs2.existsSync(packageJsonPath) && decisions.length > 0) {
    try {
      const pkgContent = fs2.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(pkgContent);
      allIssues.push(...validateDecisions(decisions, packageJson));
    } catch {
    }
  } else if (!fs2.existsSync(packageJsonPath) && decisions.length > 0) {
    const mentionedPkgs = extractMentionedPackages(content);
    if (mentionedPkgs.length > 0) {
      allIssues.push(...validateDecisions(decisions, { dependencies: {}, devDependencies: {} }));
    }
  }
  let gitLog = "";
  try {
    gitLog = execSync("git log --oneline -10", {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
  }
  if (gitLog && milestones.length > 0) {
    allIssues.push(...validateMilestones(milestones, gitLog));
  }
  if (focus) {
    const existingPaths = /* @__PURE__ */ new Set();
    const allText = `${focus.title} ${focus.details}`;
    const paths = extractPaths(allText);
    for (const normalized of paths) {
      const fullPath = path.join(projectDir, normalized);
      if (fs2.existsSync(fullPath)) {
        existingPaths.add(normalized);
      }
    }
    allIssues.push(...validateCurrentFocus(focus, existingPaths));
  }
  for (const filePath of mentionedFiles) {
    const fullPath = path.join(projectDir, filePath);
    if (!fs2.existsSync(fullPath)) {
      allIssues.push(`Referenced file "${filePath}" does not exist`);
    }
  }
  if (allIssues.length < 2) {
    return {};
  }
  const deduped = [...new Set(allIssues)];
  const message = `ROADMAP Reconciliation (${deduped.length} issues):
` + deduped.map((i) => `- ${i}`).join("\n");
  return {
    values: {
      system: message
    }
  };
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
  });
}
async function main() {
  const input = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(input);
  } catch {
  }
  if (isEngineHost(payload)) {
    console.log(JSON.stringify({}));
    return;
  }
  if (isCompactSource(parseSessionSource(input))) {
    console.log(JSON.stringify({}));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = reconcile(projectDir);
  console.log(JSON.stringify(result));
}
main().catch((err) => {
  console.error("roadmap-reconcile error:", err.message || err);
  console.log(JSON.stringify({}));
});
export {
  extractCurrentFocus,
  extractDecisions,
  extractMentionedFiles,
  extractMentionedPackages,
  extractMilestones,
  reconcile,
  validateCurrentFocus,
  validateDecisions,
  validateMilestones
};
