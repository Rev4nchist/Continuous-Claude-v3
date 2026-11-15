#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir as homedir2 } from "os";
import { basename, join as join2, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
var PATH_CHARS = 300;
var TARGET_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Agent: "subagent_type",
  Task: "subagent_type",
  Skill: "skill"
};
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, ".claude", "logs", "guard-decisions.jsonl");
}
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
var UUID_SEGMENT = /(^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/.])/gi;
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];
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
    const path2 = guardLogPath(env);
    mkdirSync(dirname(path2), { recursive: true, mode: 448 });
    appendFileSync(path2, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

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
function readTraceMode(env, read2 = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read2(env.CCV3_HOOK_TRACE_MODE_FILE || join2(homedir2(), ".claude", "state", "hook-trace-mode"));
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
var traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join2(homedir2(), ".claude", "cache");
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

// src/commit-preflight.ts
import { spawnSync } from "child_process";
import { readFileSync as readFileSync4 } from "fs";
import { isAbsolute as isAbsolute2, resolve as resolve4 } from "path";

// src/shared/done-proof.ts
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4, resolve as resolve2 } from "path";

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
  const dir = join4(repoRoot, ".claude", "cache", "e2e");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".log.json"));
  } catch {
    return null;
  }
  const newest = names.map((n) => {
    try {
      return { n, t: statSync(join4(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => b.t - a.t).slice(0, MAX_SIDECARS);
  let best = null;
  let bestAt = -Infinity;
  for (const { n } of newest) {
    try {
      const j = JSON.parse(readFileSync(join4(dir, n), "utf8"));
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
var normPath = (p) => resolve2(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
var defaultRegistryPath = () => join4(homedir3(), ".claude", "project-registry.json");
function hasE2e(repoRoot, mainRoot, registryPath = defaultRegistryPath()) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
    const roots = /* @__PURE__ */ new Set([normPath(repoRoot), ...mainRoot ? [normPath(mainRoot)] : []]);
    return (reg.projects ?? []).some(
      (p) => p && typeof p.path === "string" && roots.has(normPath(p.path)) && p.e2e !== void 0 && p.e2e !== null
    );
  } catch {
    return false;
  }
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

// src/shared/git-call.ts
var VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
var globalOpt = (extra = "") => String.raw`(?:\s+(?:${extra}-C\s+${VAL}|-c\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VAL}|--no-pager|--no-replace-objects|--bare|-P))*`;
var GLOBAL_OPT = globalOpt();
var CALL_START = String.raw`(?:^\s*|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:&\s+)?(?:\w+=\S*\s+)*(?:(?:time|sudo|command|exec|nohup)\s+)*`;
var PATH_PREFIX = String.raw`(?:[^\s;&|()]*[\\/])?`;
var PWSH_PREFIX = String.raw`(?:(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*?\s+-File\s+)?`;
function gitCallRe(verb) {
  return new RegExp(String.raw`(${CALL_START})(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+${verb})(?=\s|$)`, "g");
}
function safeCallRe(verb, wrappers = "git-safe", extraOpts = "", flags = "g") {
  return new RegExp(String.raw`(${CALL_START})(${PWSH_PREFIX}(?:${PATH_PREFIX}(?:${wrappers})\.ps1|"\s*"|'\s*'))(${globalOpt(extraOpts)})(\s+${verb})(?=\s|$)`, flags);
}
var isGitToken = (raw) => /(?:^|[\\/"'])git(?:\.exe)?["']?$/i.test(raw);
var isSafeToken = (raw, wrappers = "git-safe") => new RegExp(`(?:${wrappers})\\.ps1`, "i").test(raw);

// src/shared/git-head.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join5, resolve as resolve3 } from "path";
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
    if (existsSync2(join5(dir, ".git"))) return dir;
    const parent = dirname2(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function gitDirOf(root) {
  const dotGit = join5(root, ".git");
  if (statSync2(dotGit).isDirectory()) return dotGit;
  const m = (read(dotGit) ?? "").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = isAbsolute(m[1]) ? m[1] : resolve3(root, m[1]);
  return statSync2(target).isDirectory() ? target : null;
}
function commonDirOf(gitDir) {
  const rel = read(join5(gitDir, "commondir"))?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve3(gitDir, rel);
}
function shaOfBranch(branch, gitDir, commonDir) {
  for (const dir of /* @__PURE__ */ new Set([gitDir, commonDir])) {
    const loose = read(join5(dir, "refs", "heads", ...branch.split("/")))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = read(join5(commonDir, "packed-refs")) ?? "";
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
    const mainRoot = basename2(commonDir) === ".git" ? dirname2(commonDir) : repoRoot;
    const head = read(join5(gitDir, "HEAD"))?.trim();
    if (!head) return null;
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { repoRoot, mainRoot, branch: ref[1], sha: shaOfBranch(ref[1], gitDir, commonDir) };
    if (SHA_RE.test(head)) return { repoRoot, mainRoot, branch: null, sha: head };
    return null;
  } catch {
    return null;
  }
}

// src/shared/holdout-ids.ts
import { readFileSync as readFileSync3 } from "fs";
import { join as join6 } from "path";

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
    const ds = JSON.parse(readFileSync3(join6(mainRoot, DATASET_REL), "utf8"));
    const cfg = JSON.parse(readFileSync3(join6(mainRoot, EVAL_CONFIG_REL), "utf8"));
    ids = holdoutIdsOf(ds, cfg);
  } catch {
    throw new Error("the holdout id list could not be read");
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("the holdout id list is empty");
  return ids;
}

// src/shared/mask-quotes.ts
var BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING : BASH_STRING, blank);
}

// src/shared/unattended.ts
function isUnattended(input, env = process.env) {
  if (input.permission_mode === "bypassPermissions") return true;
  if (env.CLAUDE_AGENT_ID) return true;
  if (env.CI === "true" || env.CI === "1") return true;
  return false;
}

// src/commit-preflight.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PROTECTED_BRANCHES = /* @__PURE__ */ new Set(["main", "master"]);
var FEAT_OR_FIX = /^(feat|fix)(\(|:|!)/;
var STAGED_MAX_BYTES = 15e5;
function stagedHoldoutCount(dir, mainRoot) {
  try {
    const r = spawnSync("git", ["diff", "--cached", "--unified=0", "--no-color", "--no-renames"], { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: STAGED_MAX_BYTES * 2, timeout: 5e3 });
    if (r.status !== 0 || typeof r.stdout !== "string" || r.stdout.length > STAGED_MAX_BYTES) return null;
    const added = r.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
    return countIdsIn2(added, loadHoldoutIds(mainRoot));
  } catch {
    return null;
  }
}
var GIT_CALL = gitCallRe("commit");
var SAFE_CALL = safeCallRe("commit");
function findCommits(command, masked) {
  const calls = [];
  for (const [re, valid] of [[GIT_CALL, isGitToken], [SAFE_CALL, isSafeToken]]) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index + m[1].length;
      if (!valid(command.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      calls.push({ index: m.index, end: m.index + m[0].length, opts: command.slice(optsStart, optsStart + m[3].length) });
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}
var unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");
var toNative = (p) => process.platform === "win32" ? p.replace(/^\/([A-Za-z])(?=\/|$)/, (_m, d) => `${d.toUpperCase()}:`) : p;
var CD = new RegExp(String.raw`(?:^\s*|[;&|(\n{]\s*)(?:cd|pushd|Set-Location|sl)(?:\s+-(?:Path|LiteralPath))?\s+(${VAL})`, "g");
var UNRESOLVABLE = /[$`%]|^~|^-$/;
function applyDir(dir, target) {
  const p = unquote(target);
  if (!p || UNRESOLVABLE.test(p)) return null;
  const native = toNative(p);
  return isAbsolute2(native) ? native : resolve4(dir, native);
}
function callDir(command, masked, call, cwd) {
  if (/--(?:git-dir|work-tree)\b/.test(call.opts)) return null;
  let dir = cwd;
  for (const m of masked.slice(0, call.index).matchAll(CD)) {
    const at = m.index + m[0].length - m[1].length;
    dir = applyDir(dir, command.slice(at, at + m[1].length));
    if (!dir) return null;
  }
  for (const m of call.opts.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s"']+)/g)) {
    dir = applyDir(dir, m[1]);
    if (!dir) return null;
  }
  return dir;
}
function firstLine(s) {
  return s.split(/\r?\n/)[0].trim();
}
function untilClosingQuote(s, q, escapes) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && escapes) {
      i++;
      continue;
    }
    if (s[i] === q) return s.slice(0, i);
  }
  return s;
}
function messageValueHead(value) {
  const s = value.trimStart();
  const open = s.match(/^(@?)(\$?)(["'])/);
  if (!open) return s.split(/\s/)[0];
  const body = s.slice(open[0].length);
  const heredoc = body.match(/^\$\(\s*cat\s*<<-?\s*['"]?\w+['"]?\s*\r?\n/);
  if (heredoc) return firstLine(body.slice(heredoc[0].length));
  if (open[1]) return firstLine(body.replace(/^\s*\r?\n/, ""));
  return firstLine(untilClosingQuote(body, open[3], open[3] === '"' || open[2] === "$"));
}
function fileHead(rawPath, dirs) {
  const p = unquote(rawPath);
  if (!p || p === "-") return null;
  const native = toNative(p);
  const candidates = isAbsolute2(native) ? [native] : dirs.map((d) => resolve4(d, native));
  for (const file of candidates) {
    try {
      const text = readFileSync4(file, "utf8").replace(/^\uFEFF/, "").trimStart();
      return text ? firstLine(text) : null;
    } catch {
    }
  }
  return null;
}
var MSG_FLAG = /(?:^|\s)(?:(-[A-Za-z]*m|--message)(?:=|\s+|(?=["']))|(-[A-Za-z]*F|--file)(?:=|\s+))/;
function messageHead(command, masked, call, dirs) {
  const maskedRest = masked.slice(call.end);
  const cut = maskedRest.search(/&&|\|\||[;|\n]/);
  const scope = cut < 0 ? maskedRest : maskedRest.slice(0, cut);
  const flag = MSG_FLAG.exec(scope);
  if (!flag) return null;
  const value = command.slice(call.end + flag.index + flag[0].length);
  if (flag[1]) return messageValueHead(value);
  const file = value.match(/^("[^"]*"|'[^']*'|\S+)/);
  return file ? fileHead(file[1], dirs) : null;
}
var isFeatOrFix = (head) => FEAT_OR_FIX.test(head) || head.startsWith("$");
function commitMessageHead(command, dir = process.cwd()) {
  const masked = maskQuoted(command);
  const call = findCommits(command, masked)[0];
  return call ? messageHead(command, masked, call, [dir]) : null;
}
function mainBranchText(branch, dir) {
  return `On branch ${branch} in ${dir}. Rule: no feature work on main. Create a branch first: git switch -c <type>/<name>. Approve only for a sync or release commit.`;
}
function preflight(input, opts = {}) {
  try {
    const tool = input?.tool_name || input?.tool || "";
    if (!COMMAND_TOOLS.has(tool)) return null;
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return null;
    const masked = maskQuoted(command, tool);
    const calls = findCommits(command, masked);
    if (calls.length === 0) return null;
    const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    let warn = null;
    let judged = false;
    let mainText = null;
    let holdoutText = null;
    let holdoutWarn = null;
    for (const call of calls) {
      const dir = callDir(command, masked, call, cwd);
      const head = dir ? resolveHead(dir) : null;
      if (!dir || !head) continue;
      if (!judged) {
        judged = true;
        const verdict = judge({
          run: readTestRun(input?.session_id),
          sidecar: latestSidecar(head.repoRoot),
          head: head.sha,
          hasE2e: hasE2e(head.repoRoot, head.mainRoot, opts.registryPath),
          now: opts.now ?? Date.now()
        });
        warn = verdict.kind === "proven" ? null : `commit-preflight: ${verdict.message}`;
      }
      const isRe = Boolean(head.branch?.startsWith("re/"));
      if (isRe ? !holdoutText : !holdoutWarn) {
        const n = (opts.stagedHoldout ?? stagedHoldoutCount)(dir, head.mainRoot);
        const ids = `${n} holdout id${n === 1 ? "" : "s"}`;
        if (n !== null && n > 0 && isRe) holdoutText = `The staged lines of this commit on ${head.branch} hold ${ids}. The push will be refused. Remove them before you commit.`;
        else if (n !== null && n > 0 && !holdoutWarn) holdoutWarn = `holdout-scan: the staged lines of this commit hold ${ids}. Remove them before the commit leaves this machine (count only, warn mode).`;
      }
      if (mainText || !head.branch || !PROTECTED_BRANCHES.has(head.branch)) continue;
      const msg = messageHead(command, masked, call, [dir, cwd]);
      if (msg !== null && isFeatOrFix(msg)) mainText = mainBranchText(head.branch, head.repoRoot);
    }
    if (!judged) return null;
    const askText = [mainText, holdoutText].filter(Boolean).join("\n");
    if (askText && !isUnattended(input ?? {}, opts.env ?? process.env)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: askText,
          ...warn || holdoutWarn ? { additionalContext: [warn, holdoutWarn].filter(Boolean).join("\n") } : {}
        }
      };
    }
    const context = [warn, askText, holdoutWarn].filter(Boolean).join("\n");
    if (!context) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } };
  } catch {
    return null;
  }
}
function main() {
  let input = {};
  try {
    const raw = readFileSync4(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const out = preflight(input);
  if (out?.hookSpecificOutput.permissionDecision === "ask") {
    if (/holdout id/.test(out.hookSpecificOutput.permissionDecisionReason ?? "")) logGuardDecision("commit-preflight", input, "ask", "holdout-staged", {});
    else logGuardDecision("commit-preflight", input, "ask", "commit-on-protected-branch", { command: String(input.tool_input?.command ?? "") });
  }
  console.log(JSON.stringify(out ?? {}));
}
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}
export {
  commitMessageHead,
  preflight
};
