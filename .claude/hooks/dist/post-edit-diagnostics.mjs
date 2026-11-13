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
      const emit2 = s.emit;
      s.emit = function(ev, chunk) {
        if (ev === "data") {
          try {
            stdinText = keep(stdinText, chunk, STDIN_KEEP);
          } catch {
          }
        }
        return emit2.apply(this, arguments);
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

// src/post-edit-diagnostics.ts
import { readFileSync as readFileSync6, existsSync as existsSync7 } from "fs";
import { spawnSync as spawnSync2 } from "child_process";
import { dirname as dirname6, join as join9, relative as relative2, resolve as resolve5 } from "path";

// src/lib/daemon-client.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { join as join2, resolve as resolve2 } from "path";
import { tmpdir } from "os";
import * as crypto from "crypto";
function getTldrTmpDir() {
  if (process.platform === "win32") {
    const dir = "C:/tmp";
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
      }
    }
    return dir;
  }
  return tmpdir();
}
function resolveProjectDir(projectDir) {
  return resolve2(projectDir);
}
function getLockPath(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  return `${getTldrTmpDir()}/tldr-${hash}.lock`;
}
function getPidPath(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  return `${getTldrTmpDir()}/tldr-${hash}.pid`;
}
function isDaemonProcessRunning(projectDir) {
  const pidPath = getPidPath(projectDir);
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function tryAcquireLock(projectDir) {
  const lockPath = getLockPath(projectDir);
  try {
    if (existsSync(lockPath)) {
      const lockContent = readFileSync(lockPath, "utf-8");
      const lockTime = parseInt(lockContent, 10);
      if (!isNaN(lockTime) && Date.now() - lockTime < 3e4) {
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
    writeFileSync(lockPath, Date.now().toString(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function releaseLock(projectDir) {
  try {
    unlinkSync(getLockPath(projectDir));
  } catch {
  }
}
var QUERY_TIMEOUT = 3e3;
function getConnectionInfo(projectDir) {
  const resolvedPath = resolveProjectDir(projectDir);
  const hash = crypto.createHash("md5").update(resolvedPath).digest("hex").substring(0, 8);
  if (process.platform === "win32") {
    const port = 49152 + parseInt(hash, 16) % 1e4;
    return { type: "tcp", host: "127.0.0.1", port };
  } else {
    return { type: "unix", path: `${getTldrTmpDir()}/tldr-${hash}.sock` };
  }
}
function getStatusFile(projectDir) {
  const statusPath = join2(projectDir, ".tldr", "status");
  if (existsSync(statusPath)) {
    try {
      return readFileSync(statusPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  return null;
}
function isIndexing(projectDir) {
  return getStatusFile(projectDir) === "indexing";
}
function isListenerAlive(projectDir) {
  const connInfo = getConnectionInfo(projectDir);
  if (connInfo.type === "tcp") {
    try {
      const script = `const s=require('net').connect(${connInfo.port},'${connInfo.host}',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(500,()=>{s.destroy();process.exit(1)})`;
      const result = spawnSync(process.execPath, ["-e", script], {
        timeout: 2e3,
        stdio: "pipe"
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }
  if (!existsSync(connInfo.path)) return false;
  return probeUnixSocket(connInfo.path, 1e3) === "live";
}
var PROBE_EXIT_LIVE = 0;
var PROBE_EXIT_STALE = 10;
var UNIX_PROBE_SCRIPT = [
  "const s=require('net').connect(process.argv[1]);",
  "let up=false;",
  `const done=c=>process.exit(c);`,
  `s.setTimeout(Number(process.argv[2]),()=>done(up?${PROBE_EXIT_LIVE}:1));`,
  `s.on('connect',()=>{up=true;s.write('{"cmd":"ping"}\\n');});`,
  `s.on('data',()=>done(${PROBE_EXIT_LIVE}));`,
  `s.on('end',()=>done(${PROBE_EXIT_LIVE}));`,
  `s.on('close',()=>done(up?${PROBE_EXIT_LIVE}:1));`,
  `s.on('error',e=>done(up?${PROBE_EXIT_LIVE}:(e.code==='ECONNREFUSED'||e.code==='ENOENT')?${PROBE_EXIT_STALE}:1));`
].join("");
function probeUnixSocket(socketPath, timeoutMs) {
  try {
    const r = spawnSync(process.execPath, ["-e", UNIX_PROBE_SCRIPT, socketPath, String(timeoutMs)], {
      timeout: timeoutMs + 750,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    if (r.error || r.signal) return "unknown";
    if (r.status === PROBE_EXIT_LIVE) return "live";
    if (r.status === PROBE_EXIT_STALE) return "stale";
    return "unknown";
  } catch {
    return "unknown";
  }
}
function isDaemonReachable(projectDir) {
  const connInfo = getConnectionInfo(projectDir);
  if (connInfo.type === "tcp") {
    return isListenerAlive(projectDir);
  } else {
    if (!existsSync(connInfo.path)) {
      return false;
    }
    if (isDaemonProcessRunning(projectDir)) {
      return true;
    }
    const probe = probeUnixSocket(connInfo.path, 500);
    if (probe === "live") {
      return true;
    }
    if (probe === "stale") {
      try {
        unlinkSync(connInfo.path);
      } catch {
      }
    }
    return false;
  }
}
function tryStartDaemon(projectDir) {
  try {
    if (isDaemonProcessRunning(projectDir)) {
      if (isListenerAlive(projectDir)) {
        return true;
      }
      console.error(
        "[daemon-client] tldr daemon pid is alive but its socket is unreachable (zombie: stale-but-locked). Not restarting; run `tldr daemon stop && tldr daemon start` to recover."
      );
      return false;
    }
    if (isDaemonReachable(projectDir)) {
      return true;
    }
    if (process.env.CCV3_DAEMON_NO_AUTOSTART === "1") {
      return false;
    }
    if (!tryAcquireLock(projectDir)) {
      const start = Date.now();
      while (Date.now() - start < 5e3) {
        if (isDaemonProcessRunning(projectDir) || isDaemonReachable(projectDir)) {
          return true;
        }
        const end = Date.now() + 100;
        while (Date.now() < end) {
        }
      }
      return isDaemonProcessRunning(projectDir) || isDaemonReachable(projectDir);
    }
    try {
      const tldrPath = join2(projectDir, "opc", "packages", "tldr-code");
      let started = false;
      if (existsSync(tldrPath)) {
        const result = spawnSync("uv", ["run", "tldr", "daemon", "start", "--project", projectDir], {
          timeout: 1e4,
          stdio: "ignore",
          cwd: tldrPath
        });
        started = result.status === 0;
      }
      if (!started && !process.env.TLDR_DEV) {
        spawnSync("tldr", ["daemon", "start", "--project", projectDir], {
          timeout: 5e3,
          stdio: "ignore"
        });
      }
      const start = Date.now();
      while (Date.now() - start < 1e4) {
        if (isDaemonReachable(projectDir)) {
          const cooldown = Date.now() + 1e3;
          while (Date.now() < cooldown) {
          }
          return true;
        }
        const end = Date.now() + 100;
        while (Date.now() < end) {
        }
      }
      return isDaemonReachable(projectDir);
    } finally {
      releaseLock(projectDir);
    }
  } catch {
    return false;
  }
}
var UNIX_QUERY_SCRIPT = [
  "const net=require('net');",
  "let inp='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',d=>{inp+=d;});",
  "process.stdin.on('end',()=>{",
  "  let buf='',fin=false;",
  "  const done=()=>{",
  "    if(fin)return;fin=true;",
  "    const nl=buf.indexOf('\\n');",
  "    const out=(nl<0?buf:buf.slice(0,nl)).trim();",
  "    if(!out)process.exit(1);",
  "    process.stdout.write(out+'\\n',()=>process.exit(0));",
  "  };",
  "  const s=net.connect(process.argv[1],()=>{s.write(inp.trim()+'\\n');});",
  "  s.setEncoding('utf8');",
  "  s.on('data',d=>{buf+=d;if(buf.includes('\\n'))done();});",
  "  s.on('end',done);",
  "  s.on('close',done);",
  "  s.on('error',()=>{if(!fin){fin=true;process.exit(1);}});",
  "});"
].join("");
function buildDaemonInvocation(connInfo, input) {
  if (connInfo.type === "tcp") {
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      "$payload = [Console]::In.ReadLine()",
      `$client = New-Object System.Net.Sockets.TcpClient('${connInfo.host}', ${connInfo.port})`,
      "$stream = $client.GetStream()",
      "$writer = New-Object System.IO.StreamWriter($stream)",
      "$reader = New-Object System.IO.StreamReader($stream)",
      "$writer.WriteLine($payload)",
      "$writer.Flush()",
      "$response = $reader.ReadLine()",
      "$client.Close()",
      "Write-Output $response"
    ].join("; ");
    return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", psScript], stdin: input };
  }
  return { file: process.execPath, args: ["-e", UNIX_QUERY_SCRIPT, connInfo.path || ""], stdin: input };
}
function queryDaemonSync(query, projectDir) {
  if (isIndexing(projectDir)) {
    return {
      indexing: true,
      status: "indexing",
      message: "Daemon is still indexing, results may be incomplete"
    };
  }
  const connInfo = getConnectionInfo(projectDir);
  if (!isDaemonReachable(projectDir)) {
    if (!tryStartDaemon(projectDir)) {
      return { status: "unavailable", error: "Daemon not running and could not start" };
    }
  }
  try {
    const input = JSON.stringify(query);
    const inv = buildDaemonInvocation(connInfo, input);
    const r = spawnSync(inv.file, inv.args, {
      input: inv.stdin,
      encoding: "utf-8",
      timeout: QUERY_TIMEOUT,
      shell: false
    });
    if (r.error) {
      const code = r.error.code;
      if (code === "ETIMEDOUT") return { status: "error", error: "timeout" };
      if (code === "ENOENT") return { status: "unavailable", error: "Daemon transport not available" };
      return { status: "error", error: r.error.message };
    }
    if (r.signal) return { status: "error", error: "timeout" };
    const out = (r.stdout || "").trim();
    if (r.status !== 0 || !out) {
      return { status: "unavailable", error: "Daemon not running" };
    }
    return JSON.parse(out);
  } catch (err) {
    if (err.killed) {
      return { status: "error", error: "timeout" };
    }
    if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ENOENT")) {
      return { status: "unavailable", error: "Daemon not running" };
    }
    return { status: "error", error: err.message || "Unknown error" };
  }
}
function trackHookActivitySync(hookName, projectDir, success = true, metrics = {}) {
  try {
    queryDaemonSync(
      { cmd: "track", hook: hookName, success, metrics },
      projectDir
    );
  } catch {
  }
}

// src/shared/context-bus.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname4, join as join7, resolve as resolve3, sep as sep2 } from "node:path";
import { mkdirSync as mkdirSync5, existsSync as existsSync5 } from "node:fs";

// src/shared/session-bus-id.ts
import { createHash as createHash2 } from "node:crypto";
import { realpathSync } from "node:fs";

// src/shared/session-id.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
var SESSION_ID_FILENAME = ".coordination-session-id";
function getSessionIdFile(options = {}) {
  const claudeDir = join3(process.env.HOME || process.env.USERPROFILE || homedir2(), ".claude");
  if (options.createDir) {
    try {
      mkdirSync2(claudeDir, { recursive: true, mode: 448 });
    } catch {
    }
  }
  return join3(claudeDir, SESSION_ID_FILENAME);
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
    const id = readFileSync2(sessionFile, "utf-8").trim();
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
  return createHash2("sha256").update(normalized).digest("hex").slice(0, PROJECT_HASH_LEN);
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

// src/shared/atomic-write.ts
import {
  writeFileSync as writeFileSync3,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  existsSync as existsSync3,
  openSync,
  closeSync,
  readFileSync as readFileSync3,
  statSync as statSync2,
  constants
} from "fs";
import { dirname as dirname2, basename as basename2, join as join5 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync3, statSync, renameSync } from "fs";
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
  if (!existsSync2(LOG_DIR)) {
    mkdirSync3(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync2(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
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
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join5(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync3(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync3(tmpFile)) unlinkSync2(tmpFile);
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
      writeFileSync3(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync2(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync2(lockFile);
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
    if (existsSync3(lockFile)) {
      unlinkSync2(lockFile);
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
    if (!existsSync3(filePath)) {
      current = null;
    } else {
      try {
        current = readFileSync3(filePath, "utf-8");
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

// src/shared/intel-bus.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, renameSync as renameSync3, statSync as statSync3, unlinkSync as unlinkSync3 } from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
var MAX_LINE_BYTES = 4096;
var MAX_INTEL_BUS_BYTES = 2e6;
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join6(root, ".claude", "logs", "intel-bus.jsonl");
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
    const path = intelBusPath(opts.projectDir);
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
    maybeRotate(path, opts.size, opts.rename);
    append(path, line);
  } catch {
  }
}
function defaultAppend(path, line) {
  const dir = dirname3(path);
  if (!existsSync4(dir)) {
    mkdirSync4(dir, { recursive: true });
  }
  appendFileSync2(path, line, "utf-8");
}
function defaultSize(path) {
  if (!existsSync4(path)) return 0;
  return statSync3(path).size;
}
function resolveMaxBytes() {
  const raw = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  if (raw !== void 0) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MAX_INTEL_BUS_BYTES;
}
function maybeRotate(path, sizeFn, renameFn) {
  try {
    const size = sizeFn ?? defaultSize;
    const rename = renameFn ?? renameSync3;
    const cap = resolveMaxBytes();
    let live = 0;
    try {
      live = size(path);
    } catch {
      return;
    }
    if (live >= cap) {
      rename(path, `${path}.1`);
    }
  } catch {
  }
}

// src/shared/context-bus.ts
var LATENCY_BUDGET_MS = 50;
var AMBIENT_CAP_RATIO = 0.3;
var AMBIENT_MIN_SLOTS = 3;
var MAX_CAS_RETRIES = 5;
var BUS_LOCK_TIMEOUT_MS = 200;
var BUS_WRITE_SLOW_MS = LATENCY_BUDGET_MS;
var LOAD_BEARING_ROLES = /* @__PURE__ */ new Set([
  "user_mentioned",
  "edited",
  "test_failed",
  "dependency_traced",
  "read_for_context"
]);
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
  return join7(root, ".claude", "cache", "session");
}
function busPath(busId, projectDir) {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join7(sessionRoot, busId, "context.json");
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
function defaultRead(path) {
  try {
    return readFileSync4(path, "utf-8");
  } catch {
    return null;
  }
}
function loadState(id, read, path) {
  let raw;
  try {
    raw = read(path);
  } catch {
    return { kind: "failed" };
  }
  if (raw == null) return { kind: "absent" };
  if (raw.trim().length === 0) return { kind: "absent" };
  try {
    return { kind: "present", bus: coerceBus(id, JSON.parse(raw)) };
  } catch {
    return { kind: "failed" };
  }
}
function mutateBus(busId, fn, opts = {}) {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);
  let path;
  try {
    path = busPath(id, opts.projectDir);
  } catch {
    return emptyBus(id);
  }
  if (opts.write) {
    return mutateViaSeam(id, path, fn, opts);
  }
  return mutateViaLock(id, path, fn, opts);
}
function mutateViaLock(id, path, fn, opts) {
  const read = opts.read;
  const lockTimeoutMs = opts.lockTimeoutMs ?? BUS_LOCK_TIMEOUT_MS;
  let result = emptyBus(id);
  let outcomeKnown = false;
  let acquired = false;
  let waitMs = 0;
  let writeMs;
  let wrote = false;
  try {
    ensureDir(path, opts);
    wrote = mutateStateWithLock(
      path,
      (current) => {
        let loaded;
        if (read) {
          loaded = loadState(id, read, path);
        } else if (current == null) {
          loaded = { kind: "absent" };
        } else if (current.trim().length === 0) {
          loaded = { kind: "absent" };
        } else {
          try {
            loaded = { kind: "present", bus: coerceBus(id, JSON.parse(current)) };
          } catch {
            loaded = { kind: "failed" };
          }
        }
        if (loaded.kind === "failed") {
          return null;
        }
        const base = loaded.kind === "present" ? loaded.bus : emptyBus(id);
        const baseRevision = base.revision;
        fn(base);
        base.revision = baseRevision + 1;
        result = base;
        return JSON.stringify(base, null, 2);
      },
      {
        lockTimeoutMs,
        onLockOutcome: (o) => {
          outcomeKnown = true;
          acquired = o.acquired;
          waitMs = o.wait_ms;
        },
        onWriteTiming: (o) => {
          writeMs = o.write_ms;
        }
      }
    );
  } catch {
  }
  if (!acquired) {
    emitDropEvent(id, waitMs, opts, outcomeKnown ? "lock_timeout" : "write_error");
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else if (!wrote) {
    emitDropEvent(id, waitMs, opts, "write_error");
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else {
    fireOutcome(opts, { dropped: false, wait_ms: waitMs, write_ms: writeMs });
    if (waitMs > BUS_WRITE_SLOW_MS || (writeMs ?? 0) > BUS_WRITE_SLOW_MS) {
      emitWriteTiming(id, waitMs, writeMs, opts);
    }
  }
  return result;
}
function emitDropEvent(id, waitMs, opts, reason) {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: "bus_write_dropped",
        reason,
        wait_ms: waitMs,
        duration_ms: waitMs
      },
      { projectDir: opts.projectDir }
    );
  } catch {
  }
}
function emitWriteTiming(id, waitMs, writeMs, opts) {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: "bus_write",
        wait_ms: waitMs,
        // Explicit null (not undefined): keep the field present so a consumer can
        // tell "write not measured" from "sub-ms write" (review finding).
        write_ms: writeMs ?? null,
        duration_ms: waitMs + (writeMs ?? 0)
      },
      { projectDir: opts.projectDir }
    );
  } catch {
  }
}
function fireOutcome(opts, o) {
  if (!opts.onOutcome) return;
  try {
    opts.onOutcome(o);
  } catch {
  }
}
function mutateViaSeam(id, path, fn, opts) {
  const read = opts.read ?? defaultRead;
  const write = opts.write;
  let working = emptyBus(id);
  try {
    const initial = loadState(id, read, path);
    if (initial.kind === "failed") return working;
    let base = initial.kind === "present" ? initial.bus : emptyBus(id);
    let baseRevision = base.revision;
    fn(base);
    working = base;
    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      if (opts.beforeWrite) opts.beforeWrite();
      const reload = loadState(id, read, path);
      if (reload.kind === "failed") {
        return working;
      }
      const currentRevision = reload.kind === "present" ? reload.bus.revision : 0;
      if (currentRevision === baseRevision) {
        working.revision = baseRevision + 1;
        write(path, JSON.stringify(working, null, 2));
        return working;
      }
      base = reload.kind === "present" ? reload.bus : emptyBus(id);
      baseRevision = base.revision;
      fn(base);
      working = base;
    }
    const tail = loadState(id, read, path);
    if (tail.kind === "failed") return working;
    const tailRevision = tail.kind === "present" ? tail.bus.revision : 0;
    working.revision = tailRevision + 1;
    try {
      write(path, JSON.stringify(working, null, 2));
    } catch {
    }
    return working;
  } catch {
    return working;
  }
}
function ensureDir(path, opts) {
  if (opts.write) return;
  try {
    const dir = dirname4(path);
    if (!existsSync5(dir)) mkdirSync5(dir, { recursive: true });
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
function addFileInPlay(bus, file) {
  if (LOAD_BEARING_ROLES.has(file.role)) {
    const lbArr = bus.files_in_play.load_bearing;
    const existing = lbArr.find((f) => f.path === file.path && f.role === file.role);
    if (existing) {
      existing.turn_added = file.turn_added;
      existing.stale = file.stale;
      existing.stale_check = file.stale_check;
      return;
    }
    lbArr.push(file);
    if (lbArr.length > LOAD_BEARING_CAP) {
      lbArr.sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0));
      lbArr.splice(0, lbArr.length - LOAD_BEARING_CAP);
    }
    return;
  }
  const lb = bus.files_in_play.load_bearing.length;
  const amb = bus.files_in_play.ambient.length;
  const totalAfter = lb + amb + 1;
  const ambAfter = amb + 1;
  const withinFloor = ambAfter <= AMBIENT_MIN_SLOTS;
  const withinRatio = ambAfter / totalAfter <= AMBIENT_CAP_RATIO + 1e-9;
  if (withinFloor || withinRatio) {
    bus.files_in_play.ambient.push(file);
  }
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

// src/shared/ts-diagnostics.ts
import { existsSync as existsSync6, readFileSync as readFileSync5 } from "fs";
import { dirname as dirname5, join as join8, resolve as resolve4, relative, isAbsolute } from "path";
var TSC_LINE_REGEX = /^(.+)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/;
var MAX_EDITED = 10;
var MAX_OTHER_FILES = 5;
var MAX_CHARS = 9e3;
function classifyExtension(filePath) {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "ts";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "js";
  if ([".py", ".pyx", ".pyi"].includes(ext)) return "python";
  return null;
}
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function findNearestTsconfig(filePath, stopDir) {
  const stop = resolve4(stopDir);
  const bounded = isInside(resolve4(filePath), stop);
  let dir = dirname5(resolve4(filePath));
  for (; ; ) {
    const candidate = join8(dir, "tsconfig.json");
    try {
      if (existsSync6(candidate)) return candidate;
    } catch {
      return null;
    }
    if (bounded && dir === stop) return null;
    const parent = dirname5(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function isSolutionStyleTsconfig(tsconfigPath) {
  try {
    const text = readFileSync5(tsconfigPath, "utf-8");
    return /"files"\s*:\s*\[\s*\]/.test(text) && /"references"\s*:/.test(text);
  } catch {
    return false;
  }
}
function parseTscOutput(stdout) {
  const out = [];
  for (const raw of stdout.split("\n")) {
    const m = raw.replace(/\r$/, "").match(TSC_LINE_REGEX);
    if (!m) continue;
    out.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4],
      code: parseInt(m[5], 10),
      message: m[6]
    });
  }
  return out;
}
function samePath(a, b) {
  const n = (p) => resolve4(p).replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
}
function formatTsDiagnostics(diags, editedFile, cwd, tsconfigLabel) {
  const edited = diags.filter((d) => samePath(resolve4(cwd, d.file), editedFile));
  const others = diags.filter((d) => !samePath(resolve4(cwd, d.file), editedFile));
  const perFile = /* @__PURE__ */ new Map();
  for (const d of others) perFile.set(d.file, (perFile.get(d.file) ?? 0) + 1);
  const lines = [
    `TypeScript (${tsconfigLabel}): ${edited.length} in the edited file, ${others.length} in ${perFile.size} other files.`
  ];
  for (const d of edited.slice(0, MAX_EDITED)) {
    lines.push(`   - ${d.file}:${d.line}:${d.column}: TS${d.code} ${d.message}`);
  }
  if (edited.length > MAX_EDITED) lines.push(`   ... ${edited.length - MAX_EDITED} more in the edited file`);
  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_OTHER_FILES);
  if (top.length) {
    lines.push("   Other files:");
    for (const [file, n] of top) lines.push(`   - ${file}: ${n} error${n === 1 ? "" : "s"}`);
    if (perFile.size > top.length) lines.push(`   ... ${perFile.size - top.length} more files`);
  }
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n   ... (truncated)";
  return text;
}

// src/post-edit-diagnostics.ts
var TSC_TIMEOUT_MS = 45e3;
var TSC_MAX_BUFFER = 64 * 1024 * 1024;
function recordBusFilesInPlay(filePath) {
  try {
    mutateBus(void 0, (b) => {
      addFileInPlay(b, { path: filePath, role: "edited", turn_added: b.current_turn ?? 0 });
    });
  } catch {
  }
}
function resolveTscCommand(startDir, stopDir = startDir) {
  const candidates = [];
  if (process.env.CCV3_TSC) candidates.push(process.env.CCV3_TSC);
  const stop = resolve5(stopDir);
  let dir = resolve5(startDir);
  for (; ; ) {
    candidates.push(join9(dir, "node_modules", "typescript", "bin", "tsc"));
    const parent = dirname6(dir);
    if (dir === stop || parent === dir || relative2(stop, dir).startsWith("..")) break;
    dir = parent;
  }
  candidates.push(join9(stop, ".claude", "hooks", "node_modules", "typescript", "bin", "tsc"));
  if (process.env.CCV3_TSC) {
    candidates.length = 1;
  }
  for (const tscPath of candidates) {
    try {
      if (existsSync7(tscPath)) {
        return {
          command: process.execPath,
          args: [tscPath, "--noEmit", "--pretty", "false"]
        };
      }
    } catch {
    }
  }
  return null;
}
async function main() {
  const input = JSON.parse(readFileSync6(0, "utf-8"));
  if (isEngineHost(input)) {
    console.log("{}");
    return;
  }
  if (input.tool_name !== "Edit" && input.tool_name !== "Write") {
    console.log("{}");
    return;
  }
  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    console.log("{}");
    return;
  }
  const kind = classifyExtension(filePath);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (kind === "python") {
    runPythonDiagnostics(filePath, projectDir);
  } else if (kind === "ts" || kind === "js") {
    runTscDiagnostics(filePath, projectDir, kind);
  } else {
    console.log("{}");
  }
}
function runPythonDiagnostics(filePath, projectDir) {
  recordBusFilesInPlay(filePath);
  try {
    const response = queryDaemonSync(
      { cmd: "diagnostics", file: filePath },
      projectDir
    );
    if (response.status === "unavailable" || response.error) {
      console.log("{}");
      return;
    }
    const summary = response.summary || response;
    const typeErrors = summary.type_errors || 0;
    const lintIssues = summary.lint_errors || summary.lint_issues || 0;
    const errors = response.errors || [];
    trackHookActivitySync("post-edit-diagnostics", projectDir, true, {
      edits_analyzed: 1,
      type_errors: typeErrors,
      lint_issues: lintIssues
    });
    if (typeErrors === 0 && lintIssues === 0) {
      console.log("{}");
      return;
    }
    const lines = [];
    lines.push(`Diagnostics: ${typeErrors} type errors, ${lintIssues} lint issues`);
    const maxPreviews = 5;
    const previews = errors.slice(0, maxPreviews);
    for (const err of previews) {
      const location = err.column ? `${err.file}:${err.line}:${err.column}` : `${err.file}:${err.line}`;
      lines.push(`   - ${location}: ${err.message}`);
    }
    if (errors.length > maxPreviews) {
      const remaining = errors.length - maxPreviews;
      lines.push(`   ... and ${remaining} more`);
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: lines.join("\n")
      }
    };
    console.log(JSON.stringify(output));
  } catch {
    console.log("{}");
  }
}
function emit(note) {
  if (!note) {
    console.log("{}");
    return;
  }
  const output = {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note }
  };
  console.log(JSON.stringify(output));
}
function trackTs(projectDir, ok, metrics) {
  process.env.CCV3_DAEMON_NO_AUTOSTART = "1";
  trackHookActivitySync("post-edit-diagnostics", projectDir, ok, { edits_analyzed: 1, ...metrics });
}
function runTscDiagnostics(filePath, projectDir, kind) {
  recordBusFilesInPlay(filePath);
  const started = Date.now();
  const ms = () => Date.now() - started;
  try {
    const tsconfig = findNearestTsconfig(filePath, projectDir);
    if (!tsconfig) {
      trackTs(projectDir, false, { skipped_no_tsconfig: 1, duration_ms: ms() });
      emit(kind === "ts" ? `TypeScript check skipped: no tsconfig.json found above ${filePath}.` : null);
      return;
    }
    if (isSolutionStyleTsconfig(tsconfig)) {
      trackTs(projectDir, false, { skipped_solution_style: 1, duration_ms: ms() });
      emit(`TypeScript check skipped: ${tsconfig} only lists project references. Run tsc -b for that project.`);
      return;
    }
    const tsconfigDir = dirname6(tsconfig);
    const tsc = resolveTscCommand(tsconfigDir, projectDir);
    if (!tsc) {
      trackTs(projectDir, false, { no_compiler: 1, duration_ms: ms() });
      emit(`TypeScript check did not run: no typescript compiler found for ${tsconfig}.`);
      return;
    }
    const result = spawnSync2(tsc.command, [...tsc.args, "-p", tsconfig], {
      cwd: tsconfigDir,
      timeout: TSC_TIMEOUT_MS,
      // A broken core type can print tens of thousands of errors; the 1 MiB default kills tsc.
      maxBuffer: TSC_MAX_BUFFER,
      encoding: "utf-8",
      windowsHide: true
    });
    if (result.error || result.status === null) {
      const timedOut = result.error?.code === "ETIMEDOUT";
      trackTs(projectDir, false, { tsc_failed: 1, timed_out: timedOut ? 1 : 0, duration_ms: ms() });
      emit(`TypeScript check did not run: ${timedOut ? `timed out after ${TSC_TIMEOUT_MS / 1e3} s` : "tsc failed to start"} (${tsconfig}).`);
      return;
    }
    const stdout = result.stdout || "";
    const diagnostics = parseTscOutput(stdout);
    if (diagnostics.length === 0 && result.status !== 0) {
      const head = (stdout + (result.stderr || "")).trim().split(/\r?\n/).slice(0, 3).join(" | ");
      trackTs(projectDir, false, { tsc_failed: 1, duration_ms: ms() });
      emit(`TypeScript check did not run cleanly (exit ${result.status}, ${tsconfig}): ${head.slice(0, 500)}`);
      return;
    }
    const errorCount = diagnostics.filter((d) => d.severity === "error").length;
    trackTs(projectDir, true, {
      type_errors: errorCount,
      lint_issues: diagnostics.length - errorCount,
      duration_ms: ms()
    });
    if (diagnostics.length === 0) {
      emit(null);
      return;
    }
    const label = relative2(projectDir, tsconfig).replace(/\\/g, "/") || "tsconfig.json";
    emit(formatTsDiagnostics(diagnostics, filePath, tsconfigDir, label));
  } catch (e) {
    emit(`TypeScript check did not run: ${e?.message ?? "internal error"}.`);
  }
}
var isDirectInvocation = (() => {
  try {
    const arg1 = process.argv[1] || "";
    return arg1.endsWith("post-edit-diagnostics.mjs") || arg1.endsWith("post-edit-diagnostics.js") || arg1.endsWith("post-edit-diagnostics.ts");
  } catch {
    return false;
  }
})();
if (isDirectInvocation) {
  main().catch(() => console.log("{}"));
}
var __isDirectInvocation = isDirectInvocation;
export {
  __isDirectInvocation,
  recordBusFilesInPlay,
  resolveTscCommand
};
