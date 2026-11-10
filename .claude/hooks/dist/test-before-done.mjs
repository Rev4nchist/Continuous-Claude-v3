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
function readTraceMode(env, read2 = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read2(env.CCV3_HOOK_TRACE_MODE_FILE || join(homedir(), ".claude", "state", "hook-trace-mode"));
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

// src/test-before-done.ts
import { readFileSync as readFileSync3 } from "fs";

// src/shared/done-proof.ts
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join as join3, resolve as resolve2 } from "path";

// src/shared/test-run-state.ts
import * as os from "os";
import * as path from "path";
function getStateFile(sessionId) {
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(os.tmpdir(), `claude-recent-test-runs-${safe}.json`);
}

// src/shared/done-proof.ts
var MIN = 6e4;
var PROOF_WINDOW_MS = 5 * MIN;
var FAILURE_WINDOW_MS = 30 * MIN;
var VERIFY = "node ~/.claude/scripts/verify.mjs";
var RATCHETS = [/\bcontext-budget-guard\b/, /\baudit-skills\b/];
function isRatchet(command) {
  return !!command && RATCHETS.some((re) => re.test(command));
}
function readTestRun(sessionId) {
  try {
    const file = getStateFile(sessionId);
    if (!file || !existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const s = JSON.parse(raw);
    if (typeof s?.lastTestRun !== "number" || !s.lastTestRun) return null;
    return {
      lastTestRun: s.lastTestRun,
      command: typeof s.command === "string" ? s.command : void 0,
      ok: typeof s.ok === "boolean" ? s.ok : null
    };
  } catch {
    return null;
  }
}
var MAX_SIDECARS = 50;
function latestSidecar(repoRoot) {
  const dir = join3(repoRoot, ".claude", "cache", "e2e");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".log.json"));
  } catch {
    return null;
  }
  const newest = names.map((n) => {
    try {
      return { n, t: statSync(join3(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => b.t - a.t).slice(0, MAX_SIDECARS);
  let best = null;
  let bestAt = -Infinity;
  for (const { n } of newest) {
    try {
      const j = JSON.parse(readFileSync(join3(dir, n), "utf8"));
      const at = Date.parse(j.started);
      if (Number.isNaN(at) || at <= bestAt) continue;
      bestAt = at;
      best = {
        exit: typeof j.exit === "number" ? j.exit : null,
        started: typeof j.started === "string" ? j.started : null,
        finished: typeof j.finished === "string" ? j.finished : null,
        head: typeof j.head === "string" ? j.head : null,
        artifact: typeof j.artifact === "string" ? j.artifact : void 0
      };
    } catch {
    }
  }
  return best;
}
var sidecarAt = (s) => Date.parse(s.finished ?? s.started ?? "");
var SKEW_MS = MIN;
var fresh = (at, now, window) => now - at > -SKEW_MS && now - at < window;
function runProves(run, now) {
  return !!run && fresh(run.lastTestRun, now, PROOF_WINDOW_MS) && !isRatchet(run.command) && run.ok !== false;
}
var HEX_HEAD = /^[0-9a-f]{7,40}$/i;
function headMatches(sidecar, head) {
  return !!sidecar.head && !!head && HEX_HEAD.test(sidecar.head) && head.toLowerCase().startsWith(sidecar.head.toLowerCase());
}
function sidecarProves(s, head, now) {
  if (s.exit !== 0 || !s.finished) return false;
  return fresh(Date.parse(s.finished), now, PROOF_WINDOW_MS) && headMatches(s, head);
}
var shortCmd = (c) => (c ?? "unknown command").replace(/\s+/g, " ").slice(0, 120);
function failure(run, s, now) {
  const counted = run && !isRatchet(run.command) ? run : null;
  const sAt = s ? sidecarAt(s) : NaN;
  const sRecent = !!s && fresh(sAt, now, FAILURE_WINDOW_MS);
  const sidecarIsNewest = !counted || sAt >= counted.lastTestRun;
  if (s && sRecent && sidecarIsNewest && typeof s.exit === "number" && s.exit !== 0) {
    const message = `last verify exited ${s.exit} (${s.artifact ?? "no artifact"}): fix and re-run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: sAt };
  }
  const passedSince = !!s && s.exit === 0 && sAt > (counted?.lastTestRun ?? Infinity);
  if (counted && counted.ok === false && fresh(counted.lastTestRun, now, FAILURE_WINDOW_MS) && !passedSince) {
    const message = `last test run failed (${shortCmd(counted.command)}): fix it and re-run it, or run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: counted.lastTestRun };
  }
  if (s && sRecent && sidecarIsNewest && s.exit === null) {
    const message = `last verify (${s.artifact ?? "no artifact"}) is still running or was killed: let it finish or re-run ${VERIFY}`;
    return { verdict: { kind: "killed", message }, at: sAt };
  }
  return null;
}
function judge(i) {
  const { run, sidecar, head, now } = i;
  const proofAt = Math.max(
    runProves(run, now) ? run.lastTestRun : -Infinity,
    sidecar && sidecarProves(sidecar, head, now) ? sidecarAt(sidecar) : -Infinity
  );
  const bad = failure(run, sidecar, now);
  if (bad && bad.at > proofAt) return bad.verdict;
  if (proofAt > -Infinity) return { kind: "proven", message: "" };
  if (sidecar && sidecar.exit === 0 && sidecar.head && head && !headMatches(sidecar, head) && fresh(sidecarAt(sidecar), now, FAILURE_WINDOW_MS)) {
    return { kind: "stale", message: `verify ran on ${sidecar.head}, HEAD is ${head.slice(0, 7)}: re-run ${VERIFY}` };
  }
  if (!i.hasE2e) return { kind: "proven", message: "" };
  return {
    kind: "none",
    message: `no test run or verify sidecar in the last 5 minutes: run ${VERIFY} and cite its output`
  };
}

// src/shared/git-head.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { basename as basename2, dirname, isAbsolute, join as join4, resolve as resolve3 } from "path";
var SHA_RE = /^[0-9a-f]{40}$/i;
function read(path2) {
  try {
    return readFileSync2(path2, "utf8");
  } catch {
    return null;
  }
}
function findDotGit(start) {
  let dir = resolve3(start);
  for (; ; ) {
    if (existsSync2(join4(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function gitDirOf(root) {
  const dotGit = join4(root, ".git");
  if (statSync2(dotGit).isDirectory()) return dotGit;
  const m = (read(dotGit) ?? "").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = isAbsolute(m[1]) ? m[1] : resolve3(root, m[1]);
  return statSync2(target).isDirectory() ? target : null;
}
function commonDirOf(gitDir) {
  const rel = read(join4(gitDir, "commondir"))?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve3(gitDir, rel);
}
function shaOfBranch(branch, gitDir, commonDir) {
  for (const dir of /* @__PURE__ */ new Set([gitDir, commonDir])) {
    const loose = read(join4(dir, "refs", "heads", ...branch.split("/")))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = read(join4(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+?)\s*$/i);
    if (m && m[2] === branch) return m[1];
  }
  return null;
}
function resolveHead(dir) {
  try {
    if (!dir || !existsSync2(dir)) return null;
    const repoRoot = findDotGit(dir);
    if (!repoRoot) return null;
    const gitDir = gitDirOf(repoRoot);
    if (!gitDir) return null;
    const commonDir = commonDirOf(gitDir);
    const mainRoot = basename2(commonDir) === ".git" ? dirname(commonDir) : repoRoot;
    const head = read(join4(gitDir, "HEAD"))?.trim();
    if (!head) return null;
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { repoRoot, mainRoot, branch: ref[1], sha: shaOfBranch(ref[1], gitDir, commonDir) };
    if (SHA_RE.test(head)) return { repoRoot, mainRoot, branch: null, sha: head };
    return null;
  } catch {
    return null;
  }
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync, statSync as statSync3, renameSync } from "fs";
import { dirname as dirname2, join as join5 } from "path";
import { homedir as homedir2 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join5(homedir2(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname2(LOG_FILE);
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
  if (!existsSync3(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync3(LOG_FILE)) {
      const stat = statSync3(LOG_FILE);
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

// src/test-before-done.ts
var log = createLogger("test-before-done");
function shouldWarn(input) {
  if (!input || typeof input !== "object") return false;
  if (input.tool_name !== "TaskUpdate") return false;
  if (!input.tool_input || typeof input.tool_input !== "object") return false;
  return input.tool_input.status === "completed";
}
function hasRecentTestRun(sessionId) {
  return runProves(readTestRun(sessionId), Date.now());
}
function buildWarningOutput(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message ?? "WARNING: no test run detected in the last 5 minutes before this task was marked complete. Run the project check (node ~/.claude/scripts/verify.mjs, or the AGENTS.md Testing row) and cite its output."
    }
  };
}
function handleTaskUpdate(input) {
  try {
    if (!shouldWarn(input)) return null;
    const sessionId = input.session_id;
    const head = resolveHead(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
    const verdict = judge({
      run: readTestRun(sessionId),
      sidecar: head ? latestSidecar(head.repoRoot) : null,
      head: head?.sha ?? null,
      hasE2e: true,
      now: Date.now()
    });
    if (verdict.kind === "proven") return null;
    log.info("No proof of a working change on task completion", { sessionId, verdict: verdict.kind });
    return verdict.kind === "none" ? buildWarningOutput() : buildWarningOutput(`WARNING: ${verdict.message}`);
  } catch (err) {
    log.error("handleTaskUpdate failed", { error: String(err) });
    return null;
  }
}
function main() {
  try {
    const raw = readFileSync3(0, "utf-8");
    if (!raw.trim()) {
      console.log(JSON.stringify({}));
      return;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({}));
      return;
    }
    const result = handleTaskUpdate(input);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    console.log(JSON.stringify({}));
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  buildWarningOutput,
  handleTaskUpdate,
  hasRecentTestRun,
  shouldWarn
};
