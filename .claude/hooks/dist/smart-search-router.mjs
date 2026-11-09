import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/smart-search-router.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "fs";
import { spawnSync as spawnSync2 } from "child_process";

// src/lib/daemon-client.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { tmpdir } from "os";
import * as net from "net";
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
  return resolve(projectDir);
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
  const statusPath = join(projectDir, ".tldr", "status");
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
      const tldrPath = join(projectDir, "opc", "packages", "tldr-code");
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
function queryDaemon(query, projectDir) {
  return new Promise((resolve2, reject) => {
    if (isIndexing(projectDir)) {
      resolve2({
        indexing: true,
        status: "indexing",
        message: "Daemon is still indexing, results may be incomplete"
      });
      return;
    }
    const connInfo = getConnectionInfo(projectDir);
    if (!isDaemonReachable(projectDir)) {
      if (!tryStartDaemon(projectDir)) {
        resolve2({ status: "unavailable", error: "Daemon not running and could not start" });
        return;
      }
    }
    const client = new net.Socket();
    let data = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve2({ status: "error", error: "timeout" });
      }
    }, QUERY_TIMEOUT);
    if (connInfo.type === "tcp") {
      client.connect(connInfo.port, connInfo.host, () => {
        client.write(JSON.stringify(query) + "\n");
      });
    } else {
      client.connect(connInfo.path, () => {
        client.write(JSON.stringify(query) + "\n");
      });
    }
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.end();
          try {
            resolve2(JSON.parse(data.trim()));
          } catch {
            resolve2({ status: "error", error: "Invalid JSON response from daemon" });
          }
        }
      }
    });
    client.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOENT")) {
          resolve2({ status: "unavailable", error: "Daemon not running" });
        } else {
          resolve2({ status: "error", error: err.message });
        }
      }
    });
    client.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (data) {
          try {
            resolve2(JSON.parse(data.trim()));
          } catch {
            resolve2({ status: "error", error: "Incomplete response" });
          }
        } else {
          resolve2({ status: "error", error: "Connection closed without response" });
        }
      }
    });
  });
}
var FAST_PROBE_TIMEOUT_MS = 250;
var NEG_CACHE_TTL_MS = 1e4;
function negCachePath(projectDir) {
  const hash = crypto.createHash("md5").update(resolveProjectDir(projectDir)).digest("hex").substring(0, 8);
  return join(tmpdir(), `tldr-daemon-unreachable-${hash}.json`);
}
function isDaemonUnreachableCached(projectDir) {
  try {
    const { ts } = JSON.parse(readFileSync(negCachePath(projectDir), "utf-8"));
    return typeof ts === "number" && Date.now() - ts < NEG_CACHE_TTL_MS;
  } catch {
    return false;
  }
}
function cacheDaemonUnreachable(projectDir) {
  try {
    writeFileSync(negCachePath(projectDir), JSON.stringify({ ts: Date.now() }));
  } catch {
  }
}
function probeDaemonFast(projectDir, timeoutMs = FAST_PROBE_TIMEOUT_MS) {
  return new Promise((resolveProbe) => {
    let connInfo;
    try {
      connInfo = getConnectionInfo(projectDir);
    } catch {
      resolveProbe(false);
      return;
    }
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolveProbe(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    try {
      if (connInfo.type === "tcp") {
        sock.connect(connInfo.port, connInfo.host);
      } else {
        sock.connect(connInfo.path);
      }
    } catch {
      done(false);
    }
  });
}
async function trackHookActivityFast(hookName, projectDir, success = true, metrics = {}) {
  try {
    if (isDaemonUnreachableCached(projectDir)) return;
    if (!await probeDaemonFast(projectDir)) {
      cacheDaemonUnreachable(projectDir);
      return;
    }
    await queryDaemon({ cmd: "track", hook: hookName, success, metrics }, projectDir);
  } catch {
  }
}

// src/shared/session-activity.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join2(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync2(dir, { recursive: true });
  } catch {
  }
  return join2(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync2(filePath)) {
      return null;
    }
    const raw = readFileSync2(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadOrCreate(sessionId) {
  const existing = readActivity(sessionId);
  if (existing) {
    if (!existing.agents) existing.agents = [];
    if (!existing.mcp_servers) existing.mcp_servers = [];
    return existing;
  }
  return {
    session_id: sessionId,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    skills: [],
    hooks: [],
    agents: [],
    mcp_servers: []
  };
}
function upsertEntry(entries, name) {
  const existing = entries.find((e) => e.name === name);
  if (existing) {
    existing.count++;
  } else {
    entries.push({
      name,
      first_seen: (/* @__PURE__ */ new Date()).toISOString(),
      count: 1
    });
  }
}
function logHook(sessionId, hookName) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.hooks, hookName);
  const filePath = getActivityPath(sessionId);
  writeFileSync2(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/shared/search-context-path.ts
import * as os from "os";
import * as path from "path";
var CONTEXT_DIR = path.join(os.tmpdir(), "claude-search-context");

// src/smart-search-router.ts
process.env.CCV3_DAEMON_NO_AUTOSTART = "1";
function storeSearchContext(sessionId, context) {
  try {
    if (!existsSync3(CONTEXT_DIR)) {
      mkdirSync3(CONTEXT_DIR, { recursive: true });
    }
    writeFileSync3(
      `${CONTEXT_DIR}/${sessionId}.json`,
      JSON.stringify(context, null, 2)
    );
  } catch {
  }
}
async function tldrSearch(pattern, projectDir = ".") {
  try {
    const response = await queryDaemon({ cmd: "search", pattern }, projectDir);
    if (response.indexing || response.status === "unavailable") {
      return ripgrepFallback(pattern, projectDir);
    }
    if (response.status === "ok" && response.results) {
      return response.results;
    }
    return [];
  } catch {
    return ripgrepFallback(pattern, projectDir);
  }
}
function buildRipgrepArgs(pattern, projectDir) {
  return [
    "-e",
    pattern,
    "--type",
    "py",
    "--line-number",
    "--max-count",
    "10",
    "--",
    projectDir
  ];
}
function ripgrepFallback(pattern, projectDir) {
  try {
    const result = spawnSync2("rg", buildRipgrepArgs(pattern, projectDir), {
      encoding: "utf-8",
      timeout: 3e3,
      shell: false
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter((l) => l).slice(0, 10).map((line) => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (match) {
        return { file: match[1], line: parseInt(match[2], 10), content: match[3] };
      }
      return { file: line, line: 0, content: "" };
    });
  } catch {
    return [];
  }
}
async function tldrImpact(funcName, projectDir = ".") {
  try {
    const response = await queryDaemon({ cmd: "impact", func: funcName }, projectDir);
    if (response.indexing || response.status === "unavailable") {
      return [];
    }
    if (response.status === "ok" && response.callers) {
      return response.callers.map((c) => `${c.file}:${c.line}`);
    }
    return [];
  } catch {
    return [];
  }
}
async function lookupCallers(pattern) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
  return (await tldrImpact(pattern, projectDir)).slice(0, 20);
}
async function lookupSymbol(pattern) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
  const funcResults = await tldrSearch(`def ${pattern}`, projectDir);
  if (funcResults.length > 0) {
    return {
      type: "function",
      location: `${funcResults[0].file}:${funcResults[0].line}`
    };
  }
  const classResults = await tldrSearch(`class ${pattern}`, projectDir);
  if (classResults.length > 0) {
    return {
      type: "class",
      location: `${classResults[0].file}:${classResults[0].line}`
    };
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(pattern)) {
    const varResults = await tldrSearch(`${pattern} =`, projectDir);
    if (varResults.length > 0) {
      return {
        type: "variable",
        location: `${varResults[0].file}:${varResults[0].line}`
      };
    }
  }
  return null;
}
var FUNCTION_VERB_PREFIXES = /^(get|set|is|has|do|can|create|update|delete|fetch|load|save|read|write|parse|build|make|init|setup|run|start|stop|handle|process|validate|check|find|search|filter|sort|map|reduce|transform|convert|format|render|display|show|hide|enable|disable|add|remove|insert|append|push|pop|clear|reset|close|open|connect|disconnect|send|receive|emit|on_|async_|_get|_set|_is|_has|_do|_create|_update|_delete|_fetch|_load|_save|_read|_write|_parse|_build|_make|_init|_setup|_run|_handle|_process|_validate|_check|_find|poll|call|exec|execute|invoke|apply|bind|dispatch|trigger|fire|notify|broadcast|publish|subscribe|unsubscribe|listen|watch|observe|register|unregister|mount|unmount|attach|detach|flush|dump|log|warn|error|debug|trace|print|throw|raise|assert|test|mock|stub|spy|wait|sleep|delay|retry|abort|cancel|pause|resume|refresh|reload|rerun|revert|rollback|commit|merge|split|join|clone|copy|move|swap|toggle|flip|increment|decrement|next|prev|first|last|peek|drain|consume|produce|yield|spawn|fork|join|kill|terminate|shutdown|cleanup|destroy|dispose|release|acquire|lock|unlock|enter|exit|begin|end|finalize)(_|$)/;
async function extractTarget(pattern, daemonUp) {
  const indexed = daemonUp ? await lookupSymbol(pattern) : null;
  if (indexed) {
    return { target: pattern, targetType: indexed.type };
  }
  const classMatch = pattern.match(/^class\s+(\w+)/);
  if (classMatch) return { target: classMatch[1], targetType: "class" };
  const defMatch = pattern.match(/^(?:async\s+)?def\s+(\w+)/);
  if (defMatch) return { target: defMatch[1], targetType: "function" };
  const functionMatch = pattern.match(/^(?:async\s+)?function\s+(\w+)/);
  if (functionMatch) return { target: functionMatch[1], targetType: "function" };
  const decoratorMatch = pattern.match(/^@(\w+)/);
  if (decoratorMatch) return { target: decoratorMatch[1], targetType: "decorator" };
  const importMatch = pattern.match(/^(?:import|from)\s+(\w+)/);
  if (importMatch) return { target: importMatch[1], targetType: "import" };
  const attrMatch = pattern.match(/(?:self|this)(?:\.|\\\.|\\\.\s*)(\w+)/);
  if (attrMatch) {
    const attr = attrMatch[1];
    if (FUNCTION_VERB_PREFIXES.test(attr)) {
      return { target: attr, targetType: "function" };
    }
    return { target: attr, targetType: "variable" };
  }
  if (/^__[a-z][a-z0-9_]*__$/.test(pattern)) {
    const moduleVars = ["__all__", "__version__", "__author__", "__doc__", "__file__", "__name__", "__package__", "__path__", "__cached__", "__loader__", "__spec__", "__builtins__", "__dict__", "__module__", "__slots__", "__annotations__"];
    if (moduleVars.includes(pattern)) {
      return { target: pattern, targetType: "variable" };
    }
    return { target: pattern, targetType: "function" };
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(pattern)) return { target: pattern, targetType: "variable" };
  if (/^[A-Z][a-zA-Z0-9]+$/.test(pattern)) return { target: pattern, targetType: "class" };
  if (/^_?[a-z][a-z0-9_]*$/.test(pattern) && FUNCTION_VERB_PREFIXES.test(pattern)) {
    return { target: pattern, targetType: "function" };
  }
  if (/^_?[a-z][a-z0-9_]*$/.test(pattern)) {
    return { target: pattern, targetType: "variable" };
  }
  const camelCaseVerbPattern = /^(get|set|is|has|do|can|use|create|update|delete|fetch|load|save|read|write|parse|build|make|init|setup|run|start|stop|handle|process|validate|check|find|search|filter|sort|map|reduce|transform|convert|format|render|display|show|hide|enable|disable|add|remove|insert|append|push|pop|clear|reset|close|open|connect|disconnect|send|receive|emit|on|async|poll|call|exec|execute|invoke|apply|bind|dispatch|trigger|fire|notify|broadcast|publish|subscribe|watch|observe|register|mount|attach|flush|dump|log|warn|error|debug|print|throw|assert|test|mock|wait|sleep|retry|abort|cancel|pause|resume|refresh|reload|revert|commit|merge|clone|copy|move|toggle|spawn|fork|kill|terminate|shutdown|cleanup|destroy|dispose|release|acquire|lock|unlock|enter|exit|begin|end)[A-Z]/;
  if (camelCaseVerbPattern.test(pattern)) {
    return { target: pattern, targetType: "function" };
  }
  if (/^[a-z][a-zA-Z0-9]*$/.test(pattern) && /[A-Z]/.test(pattern)) {
    return { target: pattern, targetType: "variable" };
  }
  const identMatch = pattern.match(/\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/);
  if (identMatch) return { target: identMatch[1], targetType: "unknown" };
  return { target: null, targetType: "unknown" };
}
function suggestLayers(targetType, queryType) {
  switch (targetType) {
    case "function":
      return ["ast", "call_graph", "cfg"];
    case "class":
      return ["ast", "call_graph"];
    case "variable":
      return ["ast", "dfg"];
    case "import":
      return ["ast"];
    case "decorator":
      return ["ast", "call_graph"];
    default:
      return queryType === "semantic" ? ["ast", "call_graph", "cfg"] : ["ast", "call_graph"];
  }
}
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
  });
}
function isScopedCall(toolInput) {
  return Boolean(toolInput.path || toolInput.glob || toolInput.type);
}
function classifyQuery(pattern) {
  if (pattern.includes("\\") || pattern.includes("[") || pattern.includes("|")) {
    return "literal";
  }
  const structuralPatterns = [
    /^(class|function|def|async def|const|let|var|interface|type|export)\s+\w+/,
    /^(import|from|require)\s/,
    /^\w+\s*\([^)]*\)/,
    // function calls
    /^async\s+(function|def)/,
    /\$\w+/,
    // AST-grep metavariables
    /^@\w+/
    // decorators
  ];
  if (structuralPatterns.some((p) => p.test(pattern))) {
    return "structural";
  }
  if (/^[A-Z][a-zA-Z0-9]*$/.test(pattern) || /^[a-z_][a-z0-9_]*$/.test(pattern) || /^[A-Z_][A-Z0-9_]*$/.test(pattern)) {
    return "literal";
  }
  if (pattern.includes("/") || /\.(ts|py|js|go|rs|md)/.test(pattern)) {
    return "literal";
  }
  const words = pattern.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= 2 && !/^(how|what|where|why|when|find|show|list)/i.test(pattern)) {
    return "literal";
  }
  const semanticPatterns = [
    /^(how|what|where|why|when|which)\s/i,
    /\?$/,
    /^(find|show|list|get|explain)\s+(all|the|every|any)/i,
    /works?$/i,
    /^.*\s+(implementation|architecture|flow|pattern|logic|system)$/i
  ];
  if (semanticPatterns.some((p) => p.test(pattern))) {
    return "semantic";
  }
  if (words.length >= 3) {
    return "semantic";
  }
  return "literal";
}
async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    console.log("{}");
    return;
  }
  if (input.tool_name !== "Grep") {
    console.log("{}");
    return;
  }
  if (!input.tool_input || typeof input.tool_input.pattern !== "string") {
    console.log("{}");
    return;
  }
  const pattern = input.tool_input.pattern;
  const sessionId = input.session_id || "default";
  if (isScopedCall(input.tool_input)) {
    try {
      logHook(sessionId, "smart-search-router");
    } catch {
    }
    await trackHookActivityFast("smart-search-router", process.env.CLAUDE_PROJECT_DIR || ".", true, {
      queries_routed: 1,
      scoped_passthrough: 1
    });
    console.log("{}");
    return;
  }
  const queryType = classifyQuery(pattern);
  try {
    logHook(sessionId, "smart-search-router");
  } catch {
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";
  let daemonUp = false;
  if (!isDaemonUnreachableCached(projectDir)) {
    daemonUp = await probeDaemonFast(projectDir);
    if (!daemonUp) cacheDaemonUnreachable(projectDir);
  }
  const { target, targetType } = await extractTarget(pattern, daemonUp);
  const layers = suggestLayers(targetType, queryType);
  const symbolInfo = target && daemonUp ? await lookupSymbol(target) : null;
  const callers = target && daemonUp ? await lookupCallers(target) : [];
  storeSearchContext(sessionId, {
    timestamp: Date.now(),
    queryType,
    pattern,
    target,
    targetType,
    suggestedLayers: layers,
    definitionLocation: symbolInfo?.location,
    callers: callers.slice(0, 20)
    // Limit to 20 callers for token efficiency
  });
  if (queryType === "literal") {
    await trackHookActivityFast("smart-search-router", projectDir, true, {
      queries_routed: 1,
      literal_queries: 1
    });
    console.log("{}");
    return;
  }
  if (queryType === "structural") {
    await trackHookActivityFast("smart-search-router", projectDir, true, {
      queries_routed: 1,
      structural_queries: 1
    });
    console.log("{}");
    return;
  }
  await trackHookActivityFast("smart-search-router", projectDir, true, {
    queries_routed: 1,
    semantic_queries: 1
  });
  console.log("{}");
}
if (!process.env.VITEST) {
  main().catch(console.error);
}
export {
  buildRipgrepArgs,
  classifyQuery,
  isScopedCall
};
