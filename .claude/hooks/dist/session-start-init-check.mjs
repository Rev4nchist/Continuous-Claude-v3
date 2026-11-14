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

// src/session-start-init-check.ts
import * as fs3 from "fs";
import * as path2 from "path";
import { execSync } from "child_process";

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

// src/shared/dist-freshness.ts
import { createHash } from "crypto";
import * as fs2 from "fs";
import * as path from "path";
var BUILD_INPUTS_NAME = ".build-inputs.json";
var MANIFEST_MISSING_INFO = "[i] Hook dist freshness manifest missing (.build-inputs.json); not using mtime, so no stale warning. Run: cd ~/continuous-claude/.claude/hooks && npm run build";
function sha256(content) {
  const text = (typeof content === "string" ? content : content.toString("utf8")).replace(/\r/g, "");
  return createHash("sha256").update(text).digest("hex");
}
function srcKey(srcRoot, filePath) {
  return path.relative(srcRoot, filePath).split(path.sep).join("/");
}
function listSrcFiles(srcRoot) {
  const out = [];
  const walk = (dir) => {
    if (!fs2.existsSync(dir)) return;
    for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(srcRoot);
  return out;
}
function loadBuildInputs(distDir) {
  const manifestPath = path.join(distDir, BUILD_INPUTS_NAME);
  if (!fs2.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs2.readFileSync(manifestPath, "utf8"));
    if (parsed.version !== 1 || parsed.algorithm !== "sha256" || !parsed.inputs || typeof parsed.inputs !== "object") {
      return null;
    }
    return { version: 1, algorithm: "sha256", inputs: parsed.inputs };
  } catch {
    return null;
  }
}
function assessFileFreshness(srcPath, srcRoot, manifest) {
  if (!manifest) return { state: "unknown", info: MANIFEST_MISSING_INFO };
  let current;
  try {
    current = sha256(fs2.readFileSync(srcPath));
  } catch {
    return { state: "stale" };
  }
  const recorded = manifest.inputs[srcKey(srcRoot, srcPath)];
  if (!recorded || recorded !== current) return { state: "stale" };
  return { state: "fresh" };
}
function assessTreeFreshness(srcRoot, distDir) {
  const srcFiles = listSrcFiles(srcRoot);
  const manifest = loadBuildInputs(distDir);
  if (!manifest) {
    return { state: "unknown", staleFiles: [], srcCount: srcFiles.length, info: MANIFEST_MISSING_INFO };
  }
  const staleFiles = srcFiles.filter((file) => assessFileFreshness(file, srcRoot, manifest).state === "stale");
  return {
    state: staleFiles.length > 0 ? "stale" : "fresh",
    staleFiles,
    srcCount: srcFiles.length
  };
}
function formatStaleDistWarning(srcRoot, result) {
  if (result.state === "unknown") return result.info ?? MANIFEST_MISSING_INFO;
  if (result.state !== "stale") return null;
  const names = result.staleFiles.slice(0, 3).map((file) => srcKey(srcRoot, file)).join(", ");
  const more = result.staleFiles.length > 3 ? `, +${result.staleFiles.length - 3} more` : "";
  return `[!] Hook dist/ is stale -- ${result.staleFiles.length} of ${result.srcCount} sources differ from the build manifest (${names}${more}). Run: cd ~/continuous-claude/.claude/hooks && npm run build`;
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

// src/session-start-init-check.ts
var TREE_MAX_AGE_SECONDS = 300;
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || path2.join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function warmTldrDaemon(projectDir) {
  if (process.env.CCV3_TLDR_WARM_OFF) return false;
  try {
    const cmd = process.platform === "win32" ? "tldr.exe" : "tldr";
    const child = spawnDetachedHidden(cmd, ["daemon", "start", "--project", projectDir], {
      stdio: "ignore"
    });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function isTreeStale(projectDir) {
  const treePath = path2.join(projectDir, ".claude", "knowledge-tree.json");
  if (!fs3.existsSync(treePath)) {
    return true;
  }
  try {
    const content = JSON.parse(fs3.readFileSync(treePath, "utf-8"));
    if (content._stale) return true;
    const stats = fs3.statSync(treePath);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1e3;
    return ageSeconds >= TREE_MAX_AGE_SECONDS;
  } catch {
    return true;
  }
}
function generateTree(projectDir) {
  const opcDir = getOpcDir();
  const lazyTreePath = path2.join(opcDir, "scripts", "core", "lazy_tree.py");
  if (!fs3.existsSync(lazyTreePath)) {
    const knowledgeTreePath = path2.join(opcDir, "scripts", "core", "knowledge_tree.py");
    if (!fs3.existsSync(knowledgeTreePath)) {
      return false;
    }
    try {
      execSync(
        `cd "${opcDir}" && uv run python scripts/core/knowledge_tree.py --project "${projectDir}"`,
        { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    execSync(
      `cd "${opcDir}" && uv run python scripts/core/lazy_tree.py regenerate --project "${projectDir}"`,
      { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
    );
    return true;
  } catch {
    return false;
  }
}
function isInitialized(projectDir) {
  const treePath = path2.join(projectDir, ".claude", "knowledge-tree.json");
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  return {
    tree: fs3.existsSync(treePath),
    roadmap: fs3.existsSync(roadmapPath)
  };
}
function hasCodeFiles(projectDir) {
  const codeIndicators = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "README.md",
    "readme.md",
    ".git"
  ];
  for (const indicator of codeIndicators) {
    if (fs3.existsSync(path2.join(projectDir, indicator))) {
      return true;
    }
  }
  const codeExtensions = /* @__PURE__ */ new Set([
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".cs",
    ".kt",
    ".swift"
  ]);
  try {
    const entries = fs3.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path2.extname(entry.name).toLowerCase();
        if (codeExtensions.has(ext)) {
          return true;
        }
      }
    }
  } catch {
  }
  return false;
}
function checkExternalSkillStaleness() {
  const result = { needsRevetting: [], stale: [] };
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const rulesPath = path2.join(homeDir, ".claude", "skills", "skill-rules.json");
  const lockPath = path2.join(homeDir, ".agents", ".skill-lock.json");
  if (!fs3.existsSync(rulesPath)) return result;
  try {
    const rules = JSON.parse(fs3.readFileSync(rulesPath, "utf-8"));
    const skills = rules.skills || {};
    let lockData = {};
    if (fs3.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs3.readFileSync(lockPath, "utf-8"));
        lockData = lock.skills || {};
      } catch {
      }
    }
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
    for (const [name, skill] of Object.entries(skills)) {
      if (!skill.source || skill.source.registry !== "skills.sh") continue;
      const dateStr = skill.source.updatedAt || skill.source.installedAt;
      if (dateStr) {
        const timestamp = new Date(dateStr).getTime();
        if (now - timestamp > THIRTY_DAYS_MS) {
          result.stale.push(name);
        }
      }
      if (lockData[name] && skill.source.folderHash) {
        if (lockData[name].skillFolderHash !== skill.source.folderHash) {
          result.needsRevetting.push(name);
        }
      }
    }
  } catch {
  }
  return result;
}
function detectProjectStack(projectDir) {
  const stack = [];
  const pkgPath = path2.join(projectDir, "package.json");
  if (fs3.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs3.readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      stack.push(...Object.keys(allDeps));
    } catch {
    }
  }
  const pyprojectPath = path2.join(projectDir, "pyproject.toml");
  if (fs3.existsSync(pyprojectPath)) {
    try {
      const content = fs3.readFileSync(pyprojectPath, "utf-8");
      const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
      if (depMatches) {
        stack.push(...depMatches.map((m) => m.trim().replace(/[">=<~^ ]/g, "")));
      }
    } catch {
    }
  }
  try {
    const topLevelFiles = fs3.readdirSync(projectDir);
    if (topLevelFiles.some((f) => f.endsWith(".bicep") || f.endsWith(".bicepparam"))) {
      stack.push("@azure/bicep-indicator");
    }
    if (topLevelFiles.includes("Cargo.toml")) {
      stack.push("rust-indicator");
    }
    if (topLevelFiles.includes("go.mod")) {
      stack.push("go-indicator");
    }
    for (const entry of topLevelFiles) {
      try {
        const subPath = path2.join(projectDir, entry);
        const stat = fs3.statSync(subPath);
        if (!stat.isDirectory() || entry.startsWith(".") || entry === "node_modules") continue;
        const subFiles = fs3.readdirSync(subPath);
        if (subFiles.includes("package.json")) {
          try {
            const pkg = JSON.parse(fs3.readFileSync(path2.join(subPath, "package.json"), "utf-8"));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            stack.push(...Object.keys(allDeps));
          } catch {
          }
        }
        if (subFiles.includes("pyproject.toml")) {
          try {
            const content = fs3.readFileSync(path2.join(subPath, "pyproject.toml"), "utf-8");
            const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
            if (depMatches) {
              stack.push(...depMatches.map((m) => m.trim().replace(/[">=<~^ ]/g, "")));
            }
          } catch {
          }
        }
        if (subFiles.some((f) => f.endsWith(".bicep") || f.endsWith(".bicepparam"))) {
          if (!stack.includes("@azure/bicep-indicator")) {
            stack.push("@azure/bicep-indicator");
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return stack;
}
function findRecommendedSkills(projectStack, installedSkills) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const catalogPath = path2.join(homeDir, ".claude", "skills", "skill-catalog.json");
  if (!fs3.existsSync(catalogPath)) return [];
  let catalog;
  try {
    catalog = JSON.parse(fs3.readFileSync(catalogPath, "utf-8"));
  } catch {
    return [];
  }
  const recommendations = [];
  for (const [stackName, stackDef] of Object.entries(catalog.stacks)) {
    const matched = stackDef.indicators.some(
      (ind) => projectStack.some((dep) => dep.toLowerCase() === ind.toLowerCase())
    );
    const fileMatched = (stackDef.fileIndicators || []).some((pattern) => {
      const ext = pattern.replace("*", "");
      return projectStack.some((dep) => dep.includes(ext + "-indicator") || dep.toLowerCase().includes(ext));
    });
    if (matched || fileMatched) {
      for (const skill of stackDef.skills) {
        if (!installedSkills.has(skill.name)) {
          recommendations.push({ ...skill, stackName });
        }
      }
    }
  }
  return recommendations;
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
    console.log(JSON.stringify({}));
    return;
  }
  const sessionType = data.source || data.type || "startup";
  if (sessionType !== "startup") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (projectDir.includes(".claude") && !projectDir.includes("continuous-claude")) {
    console.error(
      `[init-check] Skipping bootstrap: project path contains '.claude' (cwd=${projectDir}). Set CLAUDE_PROJECT_DIR explicitly to override.`
    );
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (hasCodeFiles(projectDir) && warmTldrDaemon(projectDir)) {
    console.error("[init-check] warming tldr daemon (background)");
  }
  const status = isInitialized(projectDir);
  let treeGenFailed = false;
  if (!status.tree || isTreeStale(projectDir)) {
    if (hasCodeFiles(projectDir)) {
      console.error("[*] Generating knowledge tree...");
      const generated = generateTree(projectDir);
      if (generated) {
        console.error("[ok] Knowledge tree generated");
        status.tree = true;
      } else {
        console.error("[!] Failed to generate knowledge tree");
        treeGenFailed = true;
      }
    }
  }
  const skillStaleness = checkExternalSkillStaleness();
  const hasSkillIssues = skillStaleness.needsRevetting.length > 0 || skillStaleness.stale.length > 0;
  let skillRecommendations = [];
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const rulesPath = path2.join(homeDir, ".claude", "skills", "skill-rules.json");
    const installedSkills = /* @__PURE__ */ new Set();
    if (fs3.existsSync(rulesPath)) {
      try {
        const rules = JSON.parse(fs3.readFileSync(rulesPath, "utf-8"));
        for (const name of Object.keys(rules.skills || {})) {
          installedSkills.add(name);
        }
      } catch {
      }
    }
    const projectStack = detectProjectStack(projectDir);
    if (projectStack.length > 0) {
      skillRecommendations = findRecommendedSkills(projectStack, installedSkills);
    }
  } catch {
  }
  const hasRecommendations = skillRecommendations.length > 0;
  let hookDistLine = null;
  if (projectDir.includes("continuous-claude")) {
    const hookSrcDir = path2.join(projectDir, ".claude", "hooks", "src");
    const hookDistDir = path2.join(projectDir, ".claude", "hooks", "dist");
    if (fs3.existsSync(hookSrcDir) && fs3.existsSync(hookDistDir)) {
      try {
        hookDistLine = formatStaleDistWarning(hookSrcDir, assessTreeFreshness(hookSrcDir, hookDistDir));
      } catch {
      }
    }
  }
  if (status.tree && status.roadmap && !treeGenFailed && !hasSkillIssues && !hasRecommendations && !hookDistLine) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (!hasCodeFiles(projectDir) && !hasSkillIssues && !hasRecommendations) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const missing = [];
  if (!status.roadmap) missing.push("ROADMAP.md");
  if (treeGenFailed) missing.push("knowledge-tree.json (generation failed - agents will lack project context)");
  const skillWarnings = [];
  if (skillStaleness.needsRevetting.length > 0) {
    skillWarnings.push(`[!] ${skillStaleness.needsRevetting.length} skill(s) updated externally, need re-vetting: ${skillStaleness.needsRevetting.join(", ")}. Run /vet-skill --all-unvetted`);
  }
  if (skillStaleness.stale.length > 0) {
    skillWarnings.push(`[i] ${skillStaleness.stale.length} skill(s) installed 30+ days ago without update check: ${skillStaleness.stale.join(", ")}. Run npx skills check`);
  }
  const skillRecommendationMessages = [];
  if (skillRecommendations.length > 0) {
    const lines = skillRecommendations.map(
      (r) => `  - ${r.name} (${r.publisher}): npx skills add ${r.source} -g -y`
    );
    skillRecommendationMessages.push(
      `[i] Skills available for this project stack:
${lines.join("\n")}
Install relevant skills to enhance your work on this project.`
    );
  }
  const maintenanceWarnings = [];
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  if (fs3.existsSync(roadmapPath)) {
    try {
      const roadmapContent = fs3.readFileSync(roadmapPath, "utf-8");
      const completedCount = (roadmapContent.match(/^- \[x\]/gm) || []).length;
      if (completedCount > 50) {
        maintenanceWarnings.push(`[i] ROADMAP has ${completedCount} completed items (threshold: 50). Consider archiving old entries.`);
      }
    } catch {
    }
  }
  if (hookDistLine) maintenanceWarnings.push(hookDistLine);
  if (missing.length === 0 && skillWarnings.length === 0 && skillRecommendationMessages.length === 0 && maintenanceWarnings.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let message = "";
  if (missing.length > 0) {
    message += `[!] Project partially initialized. Missing: ${missing.join(", ")}. Run /init-project for full Continuous Claude setup.`;
  }
  if (skillWarnings.length > 0) {
    if (message) message += " | ";
    message += skillWarnings.join(" | ");
  }
  if (skillRecommendationMessages.length > 0) {
    if (message) message += "\n";
    message += skillRecommendationMessages.join("\n");
  }
  if (maintenanceWarnings.length > 0) {
    if (message) message += "\n";
    message += maintenanceWarnings.join("\n");
  }
  console.error(message);
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message
    }
  };
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
  });
}
if ((process.argv[1] || "").includes("session-start-init-check")) {
  main().catch((err) => {
    console.error("session-start-init-check error:", err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  warmTldrDaemon
};
