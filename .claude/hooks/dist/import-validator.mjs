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

// src/import-validator.ts
import { readFileSync as readFileSync2 } from "fs";
import { basename as basename2 } from "path";

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

// src/import-validator.ts
function tldrSearch(pattern, projectDir = ".") {
  try {
    const response = queryDaemonSync({ cmd: "search", pattern }, projectDir);
    if (response.indexing || response.status === "unavailable" || response.status === "error") {
      return [];
    }
    if (response.results) {
      return response.results;
    }
    return [];
  } catch {
    return [];
  }
}
function extractPythonImports(code) {
  const imports = [];
  const fromImportRe = /from\s+([\w.]+)\s+import\s+([^#\n]+)/g;
  let match;
  while ((match = fromImportRe.exec(code)) !== null) {
    const module = match[1];
    const symbols = match[2].split(",").map((s) => s.trim().split(" as ")[0].trim()).filter((s) => s && s !== "*");
    if (symbols.length > 0) {
      imports.push({ module, symbols });
    }
  }
  return imports;
}
function checkSymbolExists(symbol) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
  const funcResults = tldrSearch(`def ${symbol}`, projectDir);
  if (funcResults.length > 0) {
    return { exists: true, location: `${funcResults[0].file}:${funcResults[0].line}` };
  }
  const classResults = tldrSearch(`class ${symbol}`, projectDir);
  if (classResults.length > 0) {
    return { exists: true, location: `${classResults[0].file}:${classResults[0].line}` };
  }
  return { exists: false };
}
async function main() {
  const input = JSON.parse(readFileSync2(0, "utf-8"));
  if (isEngineHost(input)) {
    console.log("{}");
    return;
  }
  if (input.tool_name !== "Write" && input.tool_name !== "Edit") {
    console.log("{}");
    return;
  }
  const code = input.tool_input.content || input.tool_input.new_string || "";
  if (!code) {
    console.log("{}");
    return;
  }
  const filePath = input.tool_input.file_path || "";
  if (!filePath.endsWith(".py")) {
    console.log("{}");
    return;
  }
  const imports = extractPythonImports(code);
  const warnings = [];
  for (const imp of imports) {
    for (const symbol of imp.symbols) {
      const check = checkSymbolExists(symbol);
      if (check.exists && check.location) {
        const expectedModule = imp.module.replace(/\./g, "/");
        if (!check.location.includes(expectedModule)) {
          const actualFile = basename2(check.location.split(":")[0]);
          warnings.push(`${symbol}: imported from ${imp.module} but defined in ${actualFile}`);
        }
      }
    }
  }
  if (warnings.length === 0) {
    console.log("{}");
    return;
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `[Import check]
${warnings.join("\n")}`
    }
  };
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
  trackHookActivitySync("import-validator", projectDir, true, {
    writes_validated: 1,
    warnings_found: warnings.length
  });
  console.log(JSON.stringify(output));
}
if ((process.argv[1] || "").includes("import-validator")) {
  main().catch(() => console.log("{}"));
}
