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

// src/holdout-scan.ts
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync as readFileSync2, readSync } from "fs";
import { homedir as homedir3 } from "os";
import { dirname as dirname2, join as join4 } from "path";

// src/shared/holdout-ids.ts
import { readFileSync } from "fs";
import { join as join2 } from "path";

// ../../scripts/github/lib/holdout-ids.mjs
function holdoutIdsOf(ds, cfg) {
  const reserved = new Set((cfg?.reserve ?? []).map((r) => r?.pr));
  const excluded = new Set(cfg?.holdoutExclude ?? []);
  const inHoldout = (pr) => !reserved.has(pr) && !excluded.has(pr);
  const out = /* @__PURE__ */ new Set();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out.add(String(f.pr));
    if (f.comment_id !== void 0 && f.comment_id !== null) {
      out.add(String(f.comment_id));
      out.add(`${f.pr}:${f.comment_id}`);
    }
    if (typeof f.round === "string" && /^[0-9a-f]{7,40}$/i.test(f.round)) out.add(f.round.toLowerCase());
  }
  out.delete("undefined");
  out.delete("null");
  return [...out];
}
var CONTEXT = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;
function countIdsIn(text, ids) {
  const s = String(text ?? "");
  let n = 0;
  for (const id of ids) {
    if (typeof id !== "string" || id === "") continue;
    if (/^\d+$/.test(id)) {
      if (digitHit(s, id)) n += 1;
    } else if (tokenHit(s, id)) n += 1;
  }
  return n;
}
function digitHit(s, id) {
  const long = id.length >= 7;
  let from = 0;
  for (; ; ) {
    const at = s.indexOf(id, from);
    if (at < 0) return false;
    from = at + 1;
    const before = s[at - 1];
    const after = s[at + id.length];
    if (before !== void 0 && /\d/.test(before) || after !== void 0 && /\d/.test(after)) continue;
    if (long || CONTEXT.test(s.slice(Math.max(0, at - 8), at))) return true;
  }
}
function tokenHit(s, id) {
  const low = s.toLowerCase();
  const want = id.toLowerCase();
  const word = /[0-9a-f:]/;
  let from = 0;
  for (; ; ) {
    const at = low.indexOf(want, from);
    if (at < 0) return false;
    from = at + 1;
    const before = low[at - 1];
    const after = low[at + want.length];
    if (before !== void 0 && word.test(before) || after !== void 0 && word.test(after)) continue;
    return true;
  }
}

// src/shared/holdout-ids.ts
var DATASET_REL = ".claudedocs/2026-11-01-pr-review-dataset.json";
var EVAL_CONFIG_REL = "scripts/eval/review-eval/config.json";
var countIdsIn2 = countIdsIn;
function loadHoldoutIds(mainRoot) {
  let ids;
  try {
    const ds = JSON.parse(readFileSync(join2(mainRoot, DATASET_REL), "utf8"));
    const cfg = JSON.parse(readFileSync(join2(mainRoot, EVAL_CONFIG_REL), "utf8"));
    ids = holdoutIdsOf(ds, cfg);
  } catch {
    throw new Error("the holdout id list could not be read");
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("the holdout id list is empty");
  return ids;
}

// src/shared/lane-board.ts
import * as os from "node:os";
var fwd = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
var userHome = (env) => fwd(env.CCV3_USER_HOME || os.homedir());
function primaryRepo(env = process.env) {
  return `${userHome(env)}/continuous-claude`;
}

// src/shared/router-config.ts
import { dirname, join as join3 } from "path";
var CONFIG_REL = "review-router.config.json";
function routerConfigText(cwd, readFile, home) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const text = readFile(join3(dir, CONFIG_REL));
    if (text !== null) return text;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return readFile(join3(home, "continuous-claude", CONFIG_REL));
}
function routerFlag(cwd, readFile, home, section, key) {
  const text = routerConfigText(cwd, readFile, home);
  if (text === null) return false;
  try {
    const cfg = JSON.parse(text);
    return cfg?.[section]?.[key] === true;
  } catch {
    return false;
  }
}

// src/holdout-scan.ts
var SCAN_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "SendMessage", "Artifact", "Write", "Edit", "NotebookEdit"]);
var FILE_READ_LIMIT = 1024 * 1024;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "NotebookEdit"]);
var EXEMPT = [/\/scripts\/eval\/review-eval\/gold\//i, /\/\.claude\/state\/review-engine\//i, /\/2026-11-01-pr-review-dataset\.json$/i];
var str = (v) => typeof v === "string" ? v : "";
var fwd2 = (p) => p.replace(/\\/g, "/");
function readCapped(path) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, FILE_READ_LIMIT));
    readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString("utf8"), tailBytes: Math.max(0, size - FILE_READ_LIMIT) };
  } catch {
    return { text: "", tailBytes: 0 };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
function outgoingText(tool, input) {
  if (!SCAN_TOOLS.has(tool)) return null;
  if (WRITE_TOOLS.has(tool) && EXEMPT.some((re) => re.test(fwd2(str(input.file_path) || str(input.notebook_path))))) return null;
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return { text: str(input.command), tailBytes: 0 };
    case "SendMessage":
      return { text: str(input.message), tailBytes: 0 };
    case "Write":
      return { text: str(input.content), tailBytes: 0 };
    case "Edit":
      return { text: str(input.new_string), tailBytes: 0 };
    case "NotebookEdit":
      return { text: str(input.new_source), tailBytes: 0 };
    default:
      return artifactText(input);
  }
}
function artifactText(input) {
  const action = str(input.action) || "publish";
  if (action !== "publish" || input.asset === true) return null;
  const page = str(input.file_path) ? readCapped(str(input.file_path)) : { text: "", tailBytes: 0 };
  return { text: [page.text, str(input.title), str(input.description)].join("\n"), tailBytes: page.tailBytes };
}
var HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi;
function countHits(text, ids) {
  const shas = ids.filter((id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id));
  const rest = ids.filter((id) => !shas.includes(id));
  const runs = [...text.matchAll(HEX_RUN)].map((m) => m[0].toLowerCase());
  const shaHits = shas.filter((s) => runs.some((r) => s.toLowerCase().startsWith(r))).length;
  const counted = countIdsIn2(text, rest);
  const bareDigits = rest.filter((id) => /^\d{3,}$/.test(id) && new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text)).length;
  return { count: counted + shaHits, bare: Math.max(0, bareDigits - counted) };
}
function warnText(tool, count, tailBytes) {
  const ids = `${count} holdout id${count === 1 ? "" : "s"}`;
  if (tailBytes > 0) return `holdout-scan: ${ids} in the first 1 MiB of this ${tool} input; the rest (${tailBytes} bytes) was not scanned. Remove any holdout id before it leaves (count only).`;
  if (count === 0) return null;
  return `holdout-scan: ${ids} in this ${tool} input. Remove them before it leaves (count only, warn mode).`;
}
function writeLog(logPath, row) {
  try {
    mkdirSync(dirname2(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(row)}
`);
  } catch {
  }
}
var wrap = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
function scanInput(data, deps = {}) {
  const env = deps.env ?? process.env;
  const home = env.CCV3_USER_HOME || homedir3();
  const logPath = deps.logPath ?? join4(home, ".claude", "logs", "holdout-scan.jsonl");
  const now = deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const tool = str(data.tool_name);
  const out = outgoingText(tool, data.tool_input ?? {});
  if (!out) return { output: null };
  const readFile = (p) => {
    try {
      return readFileSync2(p, "utf8");
    } catch {
      return null;
    }
  };
  if (routerFlag(data.cwd || process.cwd(), readFile, home, "holdoutScan", "off")) return { output: null };
  let ids;
  try {
    ids = loadHoldoutIds(primaryRepo(env));
  } catch {
    writeLog(logPath, { ts: now(), tool, error: "list", mode: "warn" });
    return { output: wrap("holdout-scan off: the holdout id list could not be read; this input was not scanned (warn mode).") };
  }
  const { count, bare } = countHits(out.text, ids);
  if (count > 0 || bare > 0) writeLog(logPath, { ts: now(), tool, count, bare, mode: "warn" });
  const text = warnText(tool, count, out.tailBytes);
  return { output: text ? wrap(text) : null };
}
function main() {
  let data = {};
  try {
    data = JSON.parse(readFileSync2(0, "utf8") || "{}");
  } catch {
    return;
  }
  const { output } = scanInput(data);
  if (output) console.log(JSON.stringify(output));
}
if (process.argv[1] && /holdout-scan\.(mjs|ts|js)$/.test(process.argv[1])) main();
export {
  FILE_READ_LIMIT,
  SCAN_TOOLS,
  countHits,
  outgoingText,
  scanInput
};
