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

// src/hook-health-monitor.ts
import * as fs3 from "fs";
import * as path2 from "path";
import * as os from "os";

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

// src/hook-health-monitor.ts
function parseHookCommands(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group.hooks || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook.type !== "command" || !hook.command) continue;
        const commandLine = [hook.command, ...hook.args || []].join(" ");
        const distPath = extractDistPath(commandLine);
        if (!distPath) continue;
        if (seen.has(distPath)) continue;
        seen.add(distPath);
        const hookName = path2.basename(distPath, ".mjs");
        const srcPath = deriveSrcPath(distPath);
        results.push({
          distPath,
          srcPath,
          hookEvent: eventName,
          hookName,
          matcher: group.matcher
        });
      }
    }
  }
  return results;
}
function extractDistPath(command) {
  const match = command.match(/^node\s+(.+\.mjs)\s*$/);
  if (!match) return null;
  let filePath = match[1].trim();
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("hooks/dist/")) return null;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    filePath = path2.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
function deriveSrcPath(distPath) {
  const normalized = distPath.replace(/\\/g, "/");
  const srcPath = normalized.replace("/hooks/dist/", "/hooks/src/").replace(/\.mjs$/, ".ts");
  return srcPath;
}
function activeClaudeRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path2.join(home, ".claude");
}
function isUnder(child, root) {
  const norm = (p) => {
    const s = path2.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r + "/");
}
function checkHookHealth(hookInfo) {
  const { distPath, srcPath, hookEvent, hookName } = hookInfo;
  if (!fs3.existsSync(distPath)) {
    return { hookName, status: "missing", hookEvent };
  }
  if (!fs3.existsSync(srcPath)) {
    return { hookName, status: "healthy", hookEvent };
  }
  const distDir = path2.dirname(distPath);
  const srcRoot = path2.resolve(distDir, "..", "src");
  if (isUnder(srcRoot, activeClaudeRoot())) {
    return { hookName, status: "healthy", hookEvent };
  }
  const freshness = assessFileFreshness(srcPath, srcRoot, loadBuildInputs(distDir));
  if (freshness.state === "stale") {
    return { hookName, status: "stale", hookEvent };
  }
  if (freshness.state === "unknown") {
    return { hookName, status: "healthy", hookEvent, info: freshness.info };
  }
  return { hookName, status: "healthy", hookEvent };
}
function formatHealthReport(results) {
  if (results.length === 0) {
    return "Hook Health: No hooks registered";
  }
  const healthy = results.filter((r) => r.status === "healthy");
  const issues = results.filter((r) => r.status !== "healthy");
  if (issues.length === 0) {
    return `Hook Health: All ${results.length} hooks healthy`;
  }
  const lines = [];
  const issueWord = issues.length === 1 ? "issue" : "issues";
  lines.push(`Hook Health: ${healthy.length}/${results.length} healthy, ${issues.length} ${issueWord} found`);
  for (const issue of issues) {
    if (issue.status === "missing") {
      lines.push(`- MISSING: ${issue.hookName}.mjs (fix: npm run build)`);
    } else if (issue.status === "stale") {
      lines.push(`- STALE: ${issue.hookName}.mjs (content differs from the build manifest, fix: npm run build)`);
    }
  }
  return lines.join("\n");
}
async function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve3(data));
  });
}
async function main() {
  let input;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: "unknown" };
  } catch {
    input = { session_id: "unknown" };
  }
  if (isEngineHost(input)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME || "";
    const settingsPath = path2.join(userProfile, ".claude", "settings.json");
    if (!fs3.existsSync(settingsPath)) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    let settings;
    try {
      const content = fs3.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      console.error("hook-health-monitor: Could not parse settings.json");
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const hookFiles = parseHookCommands(settings);
    if (hookFiles.length === 0) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const results = hookFiles.map((hf) => checkHookHealth(hf));
    const report = formatHealthReport(results);
    const hasIssues = results.some((r) => r.status !== "healthy");
    const output = { result: "continue" };
    if (hasIssues) {
      output.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: report
      };
      console.error(report);
    } else {
      const info = results.find((r) => r.info)?.info;
      console.error(info ?? `Hook Health: All ${results.length} hooks healthy`);
    }
    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(`hook-health-monitor error: ${err}`);
    console.log(JSON.stringify({ result: "continue" }));
  }
}
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  checkHookHealth,
  formatHealthReport,
  parseHookCommands
};
