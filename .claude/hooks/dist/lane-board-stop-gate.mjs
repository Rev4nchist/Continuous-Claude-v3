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

// src/lane-board-stop-gate.ts
import * as fs5 from "fs";

// src/shared/lane-board.ts
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function normalizeRoot(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/^\/\/[?.]\//, "");
  s = s.toLowerCase();
  s = s.replace(/^\/([a-z])(?=\/|$)/, "$1:");
  s = s.replace(/(?<=.)\/{2,}/g, "/");
  return s.replace(/\/+$/, "");
}
var isAbsoluteNorm = (s) => /^[a-z]:(\/|$)/.test(s) || s.startsWith("/");
var slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
var registryFile = (opts, env) => opts.registryPath || env.LANE_REGISTRY_PATH || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".claude", "project-registry.json");
function loadRegistry(opts = {}) {
  const env = opts.env ?? process.env;
  let projects;
  try {
    const text = fs2.readFileSync(registryFile(opts, env), "utf8").replace(/^\uFEFF/, "");
    projects = JSON.parse(text).projects;
  } catch {
    return [];
  }
  if (!Array.isArray(projects)) return [];
  const out = [];
  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    const e = p;
    const name = typeof e.name === "string" ? e.name : "";
    const key = typeof e.key === "string" && e.key ? e.key : slugify(name);
    if (!key) continue;
    const root = typeof e.path === "string" ? normalizeRoot(e.path) : "";
    out.push({
      key,
      name,
      board: typeof e.laneBoard === "string" && e.laneBoard ? e.laneBoard : key,
      status: typeof e.status === "string" ? e.status : "active",
      path: typeof e.path === "string" ? e.path : "",
      root: root && isAbsoluteNorm(root) ? root : "",
      artifact: typeof e.laneArtifact === "string" && e.laneArtifact ? e.laneArtifact : null
    });
  }
  return out;
}
var DEFAULT_BOARD = "continuous-claude";
function wmKey(sid, board) {
  return board === DEFAULT_BOARD ? sid : `${sid}@${board}`;
}
var fwd = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
var userHome = (env) => fwd(env.CCV3_USER_HOME || os.homedir());
function primaryRepo(env = process.env) {
  return `${userHome(env)}/continuous-claude`;
}
function renderBoardCmd(board, env = process.env) {
  return `node ${primaryRepo(env)}/scripts/coordination/render-board.mjs --project ${board}`;
}
var ARTIFACT_ID = "agentic-os-lane-board";
var FALLBACK_ARTIFACT = {
  id: "RtrTNVfAq9uowmb2tfbzid",
  url: "https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid",
  publishFrom: "lane-board.html"
};
var LANE_ARTIFACT_RE = /^https:\/\/claude\.ai\/artifact\/([A-Za-z0-9_-]+)$/;
var BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
function artifactIdOf(raw) {
  return (typeof raw === "string" ? LANE_ARTIFACT_RE.exec(raw)?.[1] : void 0) ?? null;
}
function registryBoardArtifact(board, opts, env) {
  if (!BOARD_KEY_RE.test(board)) return null;
  const owners = loadRegistry({ ...opts, env }).filter(
    (e) => e.status.toLowerCase() !== "inactive" && e.key !== DEFAULT_BOARD && e.board === e.key && e.artifact !== null
  );
  const mine = owners.filter((e) => e.key === board);
  const id = mine.length === 1 ? artifactIdOf(mine[0].artifact) : null;
  if (!id) return null;
  if (owners.some((e) => e !== mine[0] && artifactIdOf(e.artifact) === id)) return null;
  if (boardArtifact(DEFAULT_BOARD, { ...opts, env })?.id === id) return null;
  return { id, url: `https://claude.ai/artifact/${id}`, publishFrom: `lane-board-${board}.html` };
}
function boardArtifact(board, opts = {}) {
  const env = opts.env ?? process.env;
  if (board !== DEFAULT_BOARD) return registryBoardArtifact(board, opts, env);
  const file = opts.artifactsPath || `${primaryRepo(env)}/.claude/artifacts.json`;
  try {
    const text = fs2.readFileSync(file, "utf8").replace(/^﻿/, "");
    const list = JSON.parse(text).artifacts;
    if (Array.isArray(list)) {
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const e = a;
        if (e.id !== ARTIFACT_ID || typeof e.url !== "string") continue;
        const id = /\/artifact\/([A-Za-z0-9_-]+)/.exec(e.url)?.[1];
        if (!id) continue;
        return { id, url: e.url, publishFrom: typeof e.publish_from === "string" && e.publish_from ? e.publish_from : "lane-board.html" };
      }
    }
  } catch {
  }
  return { ...FALLBACK_ARTIFACT };
}
function pendingKey(sid, board) {
  return wmKey(sid, board).replace(/[^A-Za-z0-9@_-]/g, "_");
}

// src/shared/lane-dash-refresh.ts
import * as fs3 from "fs";
import * as path2 from "path";
var STALE_AFTER_HOURS = 36;
var SHOW_EVERY_MS = 60 * 60 * 1e3;
var REFRESH_FILE = "refresh.json";
var MARKER_FILE = ".refresh-shown.json";
var MAX_BYTES = 65536;
var CHICAGO = "America/Chicago";
var isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function laneDashDir(env = process.env) {
  if (env.LANE_DASH_STATE_DIR) return env.LANE_DASH_STATE_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path2.join(home, ".claude", "state", "lane-dash");
}
function parseRefresh(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(d)) return null;
  const at = typeof d.exported_at === "string" && !Number.isNaN(Date.parse(d.exported_at)) ? d.exported_at : null;
  const key = typeof d.key === "string" ? d.key : "";
  return { pending: d.pending === true, key, exportedAt: at };
}
function staleKind(r, now) {
  if (r.pending) return "pending";
  if (r.exportedAt === null) return null;
  return now - Date.parse(r.exportedAt) > STALE_AFTER_HOURS * 36e5 ? "age" : null;
}
function formatChicago(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).formatToParts(new Date(iso));
  const p = (t) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("month")} ${p("day")}, ${p("hour")}:${p("minute")} ${p("dayPeriod")} ${p("timeZoneName")}`;
}
function staleLine(r, now) {
  const kind = staleKind(r, now);
  if (!kind) return "";
  const why = kind === "pending" ? "not uploaded" : `older than ${STALE_AFTER_HOURS} hours`;
  const when = r.exportedAt ? `exported ${formatChicago(r.exportedAt)}, ${why}` : why;
  return `FleetOps data is stale (${when}). Tell Dave in one line. Run the fleetops-refresh skill only if he asks.`;
}
function shouldShow(marker, key, now) {
  if (!marker || marker.key !== key) return true;
  const shown = Date.parse(marker.shown_at);
  if (Number.isNaN(shown)) return true;
  const age = now - shown;
  return age < 0 || age > SHOW_EVERY_MS;
}
function readSmall(file) {
  if (fs3.statSync(file).size > MAX_BYTES) return null;
  return fs3.readFileSync(file, "utf8");
}
function readMarker(file) {
  try {
    const text = readSmall(file);
    if (text === null) return null;
    const m = JSON.parse(text);
    return isObj(m) && typeof m.key === "string" && typeof m.shown_at === "string" ? { key: m.key, shown_at: m.shown_at } : null;
  } catch {
    return null;
  }
}
function writeMarker(file, marker) {
  try {
    if (fs3.lstatSync(file).isSymbolicLink()) throw new Error("is a symlink");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs3.writeFileSync(tmp, JSON.stringify(marker));
    fs3.renameSync(tmp, file);
  } catch (e) {
    try {
      fs3.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function fleetopsLine(env = process.env, now = Date.now()) {
  try {
    const dir = laneDashDir(env);
    const text = readSmall(path2.join(dir, REFRESH_FILE));
    const r = text === null ? null : parseRefresh(text);
    if (!r) return "";
    const line = staleLine(r, now);
    if (!line) return "";
    const markerFile = path2.join(dir, MARKER_FILE);
    if (!shouldShow(readMarker(markerFile), r.key, now)) return "";
    try {
      writeMarker(markerFile, { key: r.key, shown_at: new Date(now).toISOString() });
    } catch {
      return "";
    }
    return line;
  } catch {
    return "";
  }
}

// src/shared/lane-board-pending.ts
import * as fs4 from "fs";
import * as path3 from "path";
var PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var isObj2 = (v) => v !== null && typeof v === "object";
function pendingDir(env = process.env) {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path3.join(home, ".claude", "state", "lane-board-pending");
}
function pendingFile(sessionId, board = DEFAULT_BOARD, env = process.env) {
  return path3.join(pendingDir(env), `${pendingKey(sessionId, board)}.json`);
}
function readPending(file) {
  try {
    const s = JSON.parse(fs4.readFileSync(file, "utf8"));
    return isObj2(s) ? s : null;
  } catch {
    return null;
  }
}
function listPending(sessionId, env = process.env) {
  const dir = pendingDir(env);
  const stem = pendingKey(sessionId, DEFAULT_BOARD);
  let names;
  try {
    names = fs4.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const base = name.slice(0, -5);
    if (base !== stem && !base.startsWith(`${stem}@`)) continue;
    const file = path3.join(dir, name);
    const pending = readPending(file);
    if (!pending) continue;
    const board = typeof pending.board === "string" && pending.board ? pending.board : base === stem ? DEFAULT_BOARD : base.slice(stem.length + 1);
    out.push({ file, board, pending });
  }
  return out;
}
function sweepStalePending(env = process.env, now = Date.now()) {
  const dir = pendingDir(env);
  let n = 0;
  try {
    for (const name of fs4.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path3.join(dir, name);
      try {
        if (now - fs4.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) {
          fs4.rmSync(file, { force: true });
          n += 1;
        }
      } catch {
      }
    }
  } catch {
  }
  return n;
}

// src/lane-board-stop-gate.ts
var isObj3 = (v) => v !== null && typeof v === "object";
function blockReason(board, env = process.env) {
  const a = boardArtifact(board, { env });
  if (!a) return "";
  return `The lane board page for board ${board} is out of date: this session changed the lane DB and has not republished it. Other sessions update this page all day, so your held copy is old. In this order: 1. Read the live page with the Artifact tool, action read, url ${a.url}, without path (a read with path does not count). Do not open or paste the saved file.2. Run ${renderBoardCmd(board, env)}. 3. At once publish ${primaryRepo(env)}/${a.publishFrom} with the Artifact tool to url ${a.url} (omit capabilities). If the publish is refused, publish the same file again: the refusal counts as the read. Then finish your turn.`;
}
function isHeadless(env) {
  if (env.LANE_CONTEXT_HEADLESS === "1") return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
}
function decideStop(payload, env, entries) {
  const approve = { action: "approve" };
  if (!isObj3(payload)) return approve;
  if (payload.stop_hook_active === true) return approve;
  if (isHeadless(env)) return approve;
  if (typeof payload.session_id !== "string" || !payload.session_id) return approve;
  for (const e of entries) {
    if (e.pending.stopBlocked === true) continue;
    if (!boardArtifact(e.board, { env })) continue;
    return { action: "block", reason: blockReason(e.board, env), board: e.board };
  }
  return approve;
}
var stateDir = pendingDir;
var stateFile = pendingFile;
function stopGate(payload, env = process.env, now = Date.now()) {
  sweepStalePending(env, now);
  const sid = isObj3(payload) && typeof payload.session_id === "string" ? payload.session_id : "";
  const entries = sid ? listPending(sid, env) : [];
  const d = decideStop(payload, env, entries.map(({ board, pending }) => ({ board, pending })));
  if (d.action !== "block") return { output: null };
  const hit = entries.find((e) => e.board === d.board);
  try {
    fs5.writeFileSync(hit.file, JSON.stringify({ ...hit?.pending, stopBlocked: true }));
  } catch {
    return { output: null };
  }
  const headless = (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
  const line = headless ? "" : fleetopsLine(env, now);
  return { output: { decision: "block", reason: line ? `${d.reason}
${line}` : d.reason } };
}
async function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve3(data));
  });
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) return;
  const { output } = stopGate(JSON.parse(input));
  if (output) console.log(JSON.stringify(output));
}
if (!process.env.VITEST) {
  main().catch(() => {
  });
}
export {
  DEFAULT_BOARD,
  blockReason,
  decideStop,
  isHeadless,
  main,
  stateDir,
  stateFile,
  stopGate
};
