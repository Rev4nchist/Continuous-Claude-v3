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

// src/pre-compact-continuity.ts
import * as fs3 from "fs";
import * as path from "path";

// src/lib/transcript-parser.ts
import * as fs2 from "fs";
function parseTranscript(transcriptPath) {
  const summary = {
    lastTodos: [],
    recentToolCalls: [],
    lastAssistantMessage: "",
    filesModified: [],
    errorsEncountered: []
  };
  if (!fs2.existsSync(transcriptPath)) {
    return summary;
  }
  let content;
  try {
    content = fs2.readFileSync(transcriptPath, "utf-8");
  } catch {
    return summary;
  }
  const lines = content.split("\n").filter((line) => line.trim());
  const allToolCalls = [];
  const modifiedFiles = /* @__PURE__ */ new Set();
  const errors = [];
  let lastTodoState = [];
  let lastAssistant = "";
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.role === "assistant" && typeof entry.content === "string") {
        lastAssistant = entry.content;
      } else if (entry.type === "assistant" && typeof entry.content === "string") {
        lastAssistant = entry.content;
      }
      if (entry.tool_name || entry.type === "tool_use") {
        const toolName = entry.tool_name || entry.name;
        if (toolName) {
          const toolCall = {
            name: toolName,
            timestamp: entry.timestamp,
            input: entry.tool_input,
            success: true
            // Will be updated by result
          };
          if (toolName === "TodoWrite" || toolName.toLowerCase().includes("todowrite")) {
            const input = entry.tool_input;
            if (input?.todos) {
              lastTodoState = input.todos.map((t, idx) => {
                const rawStatus = t.status;
                const status = rawStatus === "pending" || rawStatus === "in_progress" || rawStatus === "completed" ? rawStatus : "pending";
                return {
                  id: t.id || `todo-${idx}`,
                  content: t.content || "",
                  status
                };
              });
            }
          }
          if (toolName === "Edit" || toolName === "Write" || toolName.toLowerCase().includes("edit") || toolName.toLowerCase().includes("write")) {
            const input = entry.tool_input;
            const filePath = input?.file_path || input?.path;
            if (filePath && typeof filePath === "string") {
              modifiedFiles.add(filePath);
            }
          }
          if (toolName === "Bash" || toolName.toLowerCase().includes("bash")) {
            const input = entry.tool_input;
            if (input?.command) {
              toolCall.input = { command: input.command };
            }
          }
          allToolCalls.push(toolCall);
        }
      }
      if (entry.type === "tool_result" || entry.tool_result !== void 0) {
        const result = entry.tool_result;
        if (result) {
          const exitCode = result.exit_code ?? result.exitCode;
          if (exitCode !== void 0 && exitCode !== 0) {
            if (allToolCalls.length > 0) {
              allToolCalls[allToolCalls.length - 1].success = false;
            }
            const errorMsg = result.stderr || result.error || "Command failed";
            const lastTool = allToolCalls[allToolCalls.length - 1];
            const command = lastTool?.input?.command || "unknown command";
            errors.push(`${command}: ${errorMsg.substring(0, 200)}`);
          }
        }
        if (entry.error) {
          errors.push(entry.error.substring(0, 200));
          if (allToolCalls.length > 0) {
            allToolCalls[allToolCalls.length - 1].success = false;
          }
        }
      }
    } catch {
      continue;
    }
  }
  summary.lastTodos = lastTodoState;
  summary.recentToolCalls = allToolCalls.slice(-5);
  summary.lastAssistantMessage = lastAssistant.substring(0, 500);
  summary.filesModified = Array.from(modifiedFiles);
  summary.errorsEncountered = errors.slice(-5);
  return summary;
}
function yamlSafe(value) {
  if (value === null || value === void 0) return "";
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 92) {
      out += "\\\\";
      continue;
    }
    if (ch === 34) {
      out += '\\"';
      continue;
    }
    if (ch === 9) {
      out += "\\t";
      continue;
    }
    if (ch === 10) {
      out += "\\n";
      continue;
    }
    if (ch === 13) {
      out += "\\r";
      continue;
    }
    if (ch === 0) {
      out += "\\0";
      continue;
    }
    if (ch === 8) {
      out += "\\b";
      continue;
    }
    if (ch === 12) {
      out += "\\f";
      continue;
    }
    if (ch < 32 || ch >= 127 && ch < 160) {
      out += "\\x" + ch.toString(16).padStart(2, "0");
      continue;
    }
    out += s[i];
  }
  return out;
}
function yamlScalar(value) {
  if (value === null || value === void 0) return '""';
  const s = typeof value === "string" ? value : String(value);
  if (s.length === 0 || /[^A-Za-z0-9 _./\-]/.test(s) || /^\s|\s$/.test(s) || /^[-?@`!&*|>'%,\[\]\{\}#]/.test(s)) {
    return `"${yamlSafe(s)}"`;
  }
  return s;
}
function generateAutoHandoff(summary, sessionName) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const dateOnly = timestamp.split("T")[0];
  const lines = [];
  const inProgress = summary.lastTodos.filter((t) => t.status === "in_progress");
  const pending = summary.lastTodos.filter((t) => t.status === "pending");
  const completed = summary.lastTodos.filter((t) => t.status === "completed");
  const currentTask = inProgress[0]?.content || pending[0]?.content || "Continue from auto-compact";
  const goalSummary = completed.length > 0 ? `Completed ${completed.length} task(s) before auto-compact` : "Session auto-compacted";
  lines.push("---");
  lines.push(`session: ${yamlScalar(sessionName)}`);
  lines.push(`date: ${yamlScalar(dateOnly)}`);
  lines.push("status: partial");
  lines.push("outcome: PARTIAL_PLUS");
  lines.push("---");
  lines.push("");
  lines.push(`goal: ${yamlScalar(goalSummary)}`);
  lines.push(`now: ${yamlScalar(currentTask)}`);
  lines.push("test: # No test command captured");
  lines.push("");
  lines.push("done_this_session:");
  if (completed.length > 0) {
    completed.forEach((t) => {
      lines.push(`  - task: "${yamlSafe(t.content)}"`);
      lines.push("    files: []");
    });
  } else {
    lines.push('  - task: "Session started"');
    lines.push("    files: []");
  }
  lines.push("");
  lines.push("blockers:");
  if (summary.errorsEncountered.length > 0) {
    summary.errorsEncountered.slice(0, 3).forEach((e) => {
      const safeError = yamlSafe(typeof e === "string" ? e.substring(0, 100) : String(e).substring(0, 100));
      lines.push(`  - "${safeError}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("questions:");
  if (pending.length > 0) {
    pending.slice(0, 3).forEach((t) => {
      lines.push(`  - "Resume: ${yamlSafe(t.content)}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("decisions:");
  lines.push('  - auto_compact: "Context limit reached, auto-compacted"');
  lines.push("");
  lines.push("findings:");
  lines.push(`  - tool_calls: "${yamlSafe(summary.recentToolCalls.length + " recent tool calls")}"`);
  lines.push(`  - files_modified: "${yamlSafe(summary.filesModified.length + " files changed")}"`);
  lines.push("");
  lines.push("worked:");
  const successfulTools = summary.recentToolCalls.filter((t) => t.success);
  if (successfulTools.length > 0) {
    lines.push(`  - "${yamlSafe(successfulTools.map((t) => t.name).join(", ") + " completed successfully")}"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("failed:");
  const failedTools = summary.recentToolCalls.filter((t) => !t.success);
  if (failedTools.length > 0) {
    lines.push(`  - "${yamlSafe(failedTools.map((t) => t.name).join(", ") + " encountered errors")}"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("next:");
  if (inProgress.length > 0) {
    lines.push(`  - "Continue: ${yamlSafe(inProgress[0].content)}"`);
  }
  if (pending.length > 0) {
    pending.slice(0, 2).forEach((t) => {
      lines.push(`  - "${yamlSafe(t.content)}"`);
    });
  }
  if (inProgress.length === 0 && pending.length === 0) {
    lines.push('  - "Review session state and continue"');
  }
  lines.push("");
  lines.push("files:");
  lines.push("  created: []");
  lines.push("  modified:");
  if (summary.filesModified.length > 0) {
    summary.filesModified.slice(0, 10).forEach((f) => {
      lines.push(`    - "${yamlSafe(f)}"`);
    });
  } else {
    lines.push("    []");
  }
  return lines.join("\n");
}
var isMainModule = /(^|[\\/])transcript-parser\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: npx tsx transcript-parser.ts <transcript-path> [session-name]");
    process.exit(1);
  }
  const transcriptPath = args[0];
  const sessionName = args[1] || "test-session";
  console.log(`Parsing transcript: ${transcriptPath}`);
  const summary = parseTranscript(transcriptPath);
  console.log("\n--- Summary ---");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n--- Auto-Handoff ---");
  console.log(generateAutoHandoff(summary, sessionName));
}

// src/pre-compact-continuity.ts
async function main() {
  const input = JSON.parse(await readStdin());
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ledgerDir = path.join(projectDir, "thoughts", "ledgers");
  const ledgerFiles = fs3.existsSync(ledgerDir) ? fs3.readdirSync(ledgerDir).filter((f) => f.startsWith("CONTINUITY_CLAUDE-") && f.endsWith(".md")) : [];
  let handoffFile = "";
  let ledgerMessage = "";
  if (ledgerFiles.length > 0) {
    const mostRecent = ledgerFiles.sort((a, b) => {
      const statA = fs3.statSync(path.join(ledgerDir, a));
      const statB = fs3.statSync(path.join(ledgerDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    })[0];
    const ledgerPath = path.join(ledgerDir, mostRecent);
    if (input.trigger === "auto") {
      const sessionName = mostRecent.replace("CONTINUITY_CLAUDE-", "").replace(".md", "");
      if (input.transcript_path && fs3.existsSync(input.transcript_path)) {
        const summary = parseTranscript(input.transcript_path);
        const handoffContent = generateAutoHandoff(summary, sessionName);
        const handoffDir = path.join(projectDir, "thoughts", "shared", "handoffs", sessionName);
        fs3.mkdirSync(handoffDir, { recursive: true });
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        handoffFile = `auto-handoff-${timestamp}.yaml`;
        const handoffPath = path.join(handoffDir, handoffFile);
        fs3.writeFileSync(handoffPath, handoffContent);
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      } else {
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      }
      ledgerMessage = handoffFile ? `[PreCompact:auto] Created YAML handoff: thoughts/shared/handoffs/${mostRecent.replace("CONTINUITY_CLAUDE-", "").replace(".md", "")}/${handoffFile}` : `[PreCompact:auto] Session summary auto-appended to ${mostRecent}`;
    } else {
      ledgerMessage = `[PreCompact] Consider updating ledger before compacting: /continuity_ledger
Ledger: ${mostRecent}`;
    }
  }
  const output = {
    continue: true,
    systemMessage: ledgerMessage || handoffMessage(projectDir, input.session_id)
  };
  console.log(JSON.stringify(output));
}
function formatAge(ms) {
  if (!(ms >= 6e4)) return "just now";
  const mins = Math.floor(ms / 6e4);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function listHandoffYaml(dir, out = []) {
  let entries;
  try {
    entries = fs3.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listHandoffYaml(full, out);
    else if (e.isFile() && /\.ya?ml$/i.test(e.name)) out.push(full);
  }
  return out;
}
function newestByMtime(files) {
  let best = null;
  for (const file of files) {
    try {
      const mtime = fs3.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
    }
  }
  return best;
}
function handoffMessage(projectDir, sessionId, now = Date.now()) {
  const files = listHandoffYaml(path.join(projectDir, "thoughts", "shared", "handoffs"));
  const sid8 = (sessionId || "").slice(0, 8);
  const mine = sid8.length === 8 ? files.filter((f) => path.basename(f).includes(sid8)) : [];
  const best = newestByMtime(mine.length > 0 ? mine : files);
  if (!best) return "[PreCompact] no ledger and no handoff found";
  const rel = path.relative(projectDir, best.file).split(path.sep).join("/");
  return `[PreCompact] newest handoff: ${rel} (${formatAge(now - best.mtime)})`;
}
function generateAutoSummary(projectDir, sessionId) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const lines = [];
  const cacheDir = path.join(projectDir, ".claude", "tsc-cache", sessionId || "default");
  const editedFilesPath = path.join(cacheDir, "edited-files.log");
  let editedFiles = [];
  if (fs3.existsSync(editedFilesPath)) {
    const content = fs3.readFileSync(editedFilesPath, "utf-8");
    editedFiles = [...new Set(
      content.split("\n").filter((line) => line.trim()).map((line) => {
        const parts = line.split(":");
        return parts[1]?.replace(projectDir + "/", "") || "";
      }).filter((f) => f)
    )];
  }
  const gitClaudeDir = path.join(projectDir, ".git", "claude", "branches");
  let buildAttempts = { passed: 0, failed: 0 };
  if (fs3.existsSync(gitClaudeDir)) {
    try {
      const branches = fs3.readdirSync(gitClaudeDir);
      for (const branch of branches) {
        const attemptsFile = path.join(gitClaudeDir, branch, "attempts.jsonl");
        if (fs3.existsSync(attemptsFile)) {
          const content = fs3.readFileSync(attemptsFile, "utf-8");
          content.split("\n").filter((l) => l.trim()).forEach((line) => {
            try {
              const attempt = JSON.parse(line);
              if (attempt.type === "build_pass") buildAttempts.passed++;
              if (attempt.type === "build_fail") buildAttempts.failed++;
            } catch {
            }
          });
        }
      }
    } catch {
    }
  }
  if (editedFiles.length === 0 && buildAttempts.passed === 0 && buildAttempts.failed === 0) {
    return null;
  }
  lines.push(`
## Session Auto-Summary (${timestamp})`);
  if (editedFiles.length > 0) {
    lines.push(`- Files changed: ${editedFiles.slice(0, 10).join(", ")}${editedFiles.length > 10 ? ` (+${editedFiles.length - 10} more)` : ""}`);
  }
  if (buildAttempts.passed > 0 || buildAttempts.failed > 0) {
    lines.push(`- Build/test: ${buildAttempts.passed} passed, ${buildAttempts.failed} failed`);
  }
  return lines.join("\n");
}
function appendToLedger(ledgerPath, summary) {
  try {
    let content = fs3.readFileSync(ledgerPath, "utf-8");
    const stateMatch = content.match(/## State\n/);
    if (stateMatch) {
      const nowMatch = content.match(/(\n-\s*Now:)/);
      if (nowMatch && nowMatch.index) {
        content = content.slice(0, nowMatch.index) + summary + content.slice(nowMatch.index);
      } else {
        const nextSection = content.indexOf("\n## ", content.indexOf("## State") + 1);
        if (nextSection > 0) {
          content = content.slice(0, nextSection) + summary + "\n" + content.slice(nextSection);
        } else {
          content += summary;
        }
      }
    } else {
      content += summary;
    }
    fs3.writeFileSync(ledgerPath, content);
  } catch (err) {
  }
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
  });
}
if ((process.argv[1] || "").includes("pre-compact-continuity")) {
  main().catch(console.error);
}
export {
  formatAge,
  handoffMessage
};
