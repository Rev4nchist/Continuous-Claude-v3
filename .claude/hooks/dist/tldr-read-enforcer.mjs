import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/tldr-read-enforcer.ts
import { readFileSync as readFileSync2, existsSync as existsSync2, statSync, unlinkSync as unlinkSync2, appendFileSync, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "fs";
import { basename, extname, join as join3 } from "path";

// src/daemon-client.ts
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
  return ncPing(connInfo.path, 1e3);
}
function ncPing(socketPath, timeoutMs) {
  try {
    const r = spawnSync("nc", ["-U", socketPath], {
      input: '{"cmd":"ping"}\n',
      encoding: "utf-8",
      timeout: timeoutMs,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return !r.error && !r.signal && r.status === 0;
  } catch {
    return false;
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
      ncPing(connInfo.path, 1e3);
      return true;
    }
    if (ncPing(connInfo.path, 500)) {
      return true;
    }
    try {
      unlinkSync(connInfo.path);
    } catch {
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
async function extractDaemon(filePath, projectDir, sessionId) {
  const response = await queryDaemon({ cmd: "extract", file: filePath, session: sessionId }, projectDir);
  return response.result || null;
}
async function cfgDaemon(filePath, funcName, projectDir, language = "python") {
  const response = await queryDaemon(
    { cmd: "cfg", file: filePath, function: funcName, language },
    projectDir
  );
  return response.result || response;
}
async function dfgDaemon(filePath, funcName, projectDir, language = "python") {
  const response = await queryDaemon(
    { cmd: "dfg", file: filePath, function: funcName, language },
    projectDir
  );
  return response.result || response;
}
async function sliceDaemon(filePath, funcName, line, projectDir, direction = "backward", variable) {
  const response = await queryDaemon(
    { cmd: "slice", file: filePath, function: funcName, line, direction, variable },
    projectDir
  );
  return response;
}
async function contextDaemon(projectDir, entry, language = "python", depth = 2) {
  const response = await queryDaemon(
    { cmd: "context", entry, language, depth },
    projectDir
  );
  return response.result || response;
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

// src/shared/search-context-path.ts
import * as os from "os";
import * as path from "path";
var CONTEXT_DIR = path.join(os.tmpdir(), "claude-search-context");

// src/tldr-read-enforcer.ts
process.env.CCV3_DAEMON_NO_AUTOSTART = "1";
var CONTEXT_MAX_AGE_MS = 3e4;
function getSearchContext(sessionId, filePath) {
  try {
    const contextPath = `${CONTEXT_DIR}/${sessionId}.json`;
    if (!existsSync2(contextPath)) return null;
    const context = JSON.parse(readFileSync2(contextPath, "utf-8"));
    if (Date.now() - context.timestamp > CONTEXT_MAX_AGE_MS) {
      return null;
    }
    if (!contextMatchesFile(context.definitionLocation, filePath)) {
      return null;
    }
    try {
      unlinkSync2(contextPath);
    } catch {
    }
    return context;
  } catch {
    return null;
  }
}
function contextMatchesFile(defLoc, filePath) {
  if (!defLoc) return false;
  const defPath = defLoc.replace(/:\d+$/, "");
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const a = norm(defPath);
  const b = norm(filePath);
  if (!a || !b) return false;
  return a === b || b.endsWith("/" + a) || a.endsWith("/" + b);
}
var CODE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs"
]);
var ALLOWED_PATTERNS = [
  /\.json$/,
  /\.yaml$/,
  /\.yml$/,
  /\.toml$/,
  /\.md$/,
  /\.txt$/,
  /\.env/,
  /\.gitignore$/,
  /Makefile$/,
  /Dockerfile$/,
  /requirements\.txt$/,
  /package\.json$/,
  /tsconfig\.json$/,
  /pyproject\.toml$/,
  // Allow test files (need full context for implementation)
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*\.test\.(ts|js)$/,
  /.*\.spec\.(ts|js)$/,
  // Allow hooks/skills (we edit these) - cross-platform path separators
  /\.claude[/\\]hooks[/\\]/,
  /\.claude[/\\]skills[/\\]/,
  /init-db\.sql$/,
  /migrations[/\\]/
];
var ALLOWED_DIRS = ["/tmp/", "node_modules/", ".venv/", "__pycache__/", "\\tmp\\"];
var MIN_INTERCEPT_BYTES = 8e3;
var MIN_INJECTED_CHARS = 200;
function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(extname(filePath));
}
function isAllowedFile(filePath) {
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  for (const dir of ALLOWED_DIRS) {
    if (filePath.includes(dir)) return true;
  }
  return false;
}
function detectLanguage(filePath) {
  const ext = extname(filePath);
  const langMap = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust"
  };
  return langMap[ext] || "python";
}
function chooseTldrMode(target, layers, contextSource) {
  const fromSearchRouter = contextSource.startsWith("function:") || contextSource.startsWith("class:");
  if (target && fromSearchRouter) {
    return { mode: "context", reason: `search: ${target}` };
  }
  if (layers.some((l) => ["cfg", "dfg", "pdg"].includes(l))) {
    return { mode: "extract", reason: "flow analysis" };
  }
  return { mode: "structure", reason: "navigation" };
}
function daemonOk(res) {
  return !!res && !(typeof res === "object" && typeof res.status === "string" && res.status !== "ok");
}
async function getTldrContext(filePath, language, layers = ["ast", "call_graph"], target = null, sessionId = null, contextSource = "default") {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const fileName = basename(filePath);
  const results = [];
  const { mode, reason } = chooseTldrMode(target, layers, contextSource);
  try {
    results.push(`# ${fileName}`);
    results.push(`Language: ${language}`);
    results.push(`Mode: ${mode} (${reason})`);
    results.push("");
    if (mode === "context" && target) {
      const contextResp = await contextDaemon(projectDir, target, language, 2);
      if (daemonOk(contextResp)) {
        results.push("## Focused Context");
        results.push(typeof contextResp === "string" ? contextResp : JSON.stringify(contextResp, null, 2));
        results.push("");
        results.push("---");
        results.push("To see more: Read with offset/limit, or ask about specific functions");
        return results.join("\n");
      }
    }
    if (mode === "structure") {
      const info = await extractDaemon(filePath, projectDir, sessionId || void 0);
      if (info) {
        results.push("## Structure (names only)");
        if (info.functions?.length > 0) {
          results.push("### Functions");
          for (const fn of info.functions.slice(0, 30)) {
            const params = fn.params ? `(${fn.params.slice(0, 3).join(", ")}${fn.params.length > 3 ? "..." : ""})` : "()";
            results.push(`  ${fn.name}${params}  [line ${fn.line_number || fn.line || "?"}]`);
            if (fn.docstring) {
              const firstLine = fn.docstring.split("\n")[0].trim().slice(0, 80);
              results.push(`    # ${firstLine}`);
            }
          }
        }
        if (info.classes?.length > 0) {
          results.push("### Classes");
          for (const cls of info.classes.slice(0, 20)) {
            const methods = cls.methods?.slice(0, 5).map((m) => m.name).join(", ") || "";
            results.push(`  ${cls.name}  [line ${cls.line_number || cls.line || "?"}]`);
            if (cls.docstring) {
              const firstLine = cls.docstring.split("\n")[0].trim().slice(0, 80);
              results.push(`    # ${firstLine}`);
            }
            if (methods) results.push(`    methods: ${methods}${cls.methods?.length > 5 ? "..." : ""}`);
          }
        }
        results.push("");
        results.push("---");
        results.push("To see full code: Read with limit=100 (or offset=N limit=M for specific lines)");
        return results.join("\n");
      }
    }
    if (layers.includes("ast") || layers.includes("call_graph") || mode === "extract") {
      const info = await extractDaemon(filePath, projectDir, sessionId || void 0);
      if (info) {
        if (info.functions && info.functions.length > 0) {
          results.push("## Functions");
          for (const fn of info.functions) {
            const params = fn.params ? fn.params.join(", ") : "";
            const ret = fn.return_type ? ` -> ${fn.return_type}` : "";
            results.push(`  ${fn.name}(${params})${ret}  [line ${fn.line_number || fn.line}]`);
            if (fn.docstring) {
              const doc = fn.docstring.substring(0, 100).replace(/\n/g, " ");
              results.push(`    # ${doc}`);
            }
          }
        }
        if (info.classes && info.classes.length > 0) {
          results.push("");
          results.push("## Classes");
          for (const cls of info.classes) {
            results.push(`  class ${cls.name}  [line ${cls.line_number || cls.line}]`);
            if (cls.methods) {
              for (const m of cls.methods.slice(0, 10)) {
                results.push(`    .${m.name}()`);
              }
            }
          }
        }
        if (layers.includes("call_graph") && info.call_graph && info.call_graph.calls) {
          results.push("");
          results.push("## Call Graph");
          const entries = Object.entries(info.call_graph.calls).slice(0, 15);
          for (const [caller, callees] of entries) {
            results.push(`  ${caller} -> ${callees}`);
          }
        }
      }
    }
    if (layers.includes("cfg")) {
      const funcName = target || "main";
      const cfg = await cfgDaemon(filePath, funcName, projectDir, language);
      if (daemonOk(cfg)) {
        results.push("");
        results.push(`## CFG: ${funcName}`);
        results.push(`  Blocks: ${cfg.num_blocks || "N/A"}, Cyclomatic: ${cfg.cyclomatic_complexity || "N/A"}`);
        if (cfg.blocks && Array.isArray(cfg.blocks)) {
          for (const b of cfg.blocks.slice(0, 8)) {
            results.push(`    Block ${b.id}: lines ${b.start_line}-${b.end_line} (${b.block_type})`);
          }
        }
      }
    }
    if (layers.includes("dfg")) {
      const funcName = target || "main";
      const dfg = await dfgDaemon(filePath, funcName, projectDir, language);
      if (daemonOk(dfg)) {
        results.push("");
        results.push(`## DFG: ${funcName}`);
        if (dfg.definitions && dfg.definitions.length > 0) {
          results.push("  Definitions:");
          for (const d of dfg.definitions.slice(0, 10)) {
            results.push(`    ${d.var_name} @ line ${d.line}`);
          }
        }
        if (dfg.uses && dfg.uses.length > 0) {
          results.push("  Uses:");
          for (const u of dfg.uses.slice(0, 8)) {
            results.push(`    ${u.var_name} @ line ${u.line}`);
          }
        }
      }
    }
    if (layers.includes("pdg")) {
      const funcName = target || "main";
      const sliceResp = await sliceDaemon(filePath, funcName, 10, projectDir, "backward");
      if (sliceResp && sliceResp.status === "ok" && sliceResp.result) {
        const slice = sliceResp.result;
        results.push("");
        results.push(`## PDG: ${funcName}`);
        if (slice.lines && slice.lines.length > 0) {
          results.push(`  Slice lines: ${slice.lines.length}`);
        }
        if (slice.variables && slice.variables.length > 0) {
          results.push(`  Variables: ${slice.variables.join(", ")}`);
        }
      }
    }
    return results.length > 3 ? results.join("\n") : null;
  } catch {
    return null;
  }
}
var BATCH_FLUSH_AT = 25;
var HOOK_NAME = "tldr-read-enforcer";
var COUNTER_FILE = "tldr-read-enforcer.counts.json";
var cleanMs = (ms) => Number.isFinite(ms) && ms > 0 ? Math.round(ms * 10) / 10 : 0;
function buildLogRow(ev, count = 1, now = /* @__PURE__ */ new Date()) {
  const ms = cleanMs(ev.duration_ms);
  const isError = ev.outcome === "fail_open" && ev.reason === "error";
  const metrics = {
    reads_seen: count,
    [`outcome_${ev.outcome}`]: count,
    duration_ms: ms
  };
  if (ev.outcome === "deny") {
    metrics.reads_intercepted = 1;
    metrics.layers_returned = ev.layers_returned ?? 0;
    metrics.bytes_raw = ev.bytes_raw ?? 0;
    metrics.bytes_injected = ev.bytes_injected ?? 0;
  }
  return {
    hook_name: HOOK_NAME,
    invocations: count,
    successes: isError ? 0 : count,
    failures: isError ? count : 0,
    metrics,
    outcome: ev.outcome,
    reason: ev.reason,
    duration_ms: ms,
    count,
    timestamp: now.toISOString()
  };
}
function bumpCounter(state, key, ms, flushAt = BATCH_FLUSH_AT) {
  const next = {};
  if (state && typeof state === "object" && !Array.isArray(state)) {
    for (const [k, v] of Object.entries(state)) {
      if (v && typeof v.n === "number" && typeof v.ms === "number") next[k] = { n: v.n, ms: v.ms };
    }
  }
  const cur = next[key] || { n: 0, ms: 0 };
  const n = cur.n + 1;
  const total = Math.round((cur.ms + cleanMs(ms)) * 10) / 10;
  if (n >= flushAt) {
    delete next[key];
    return { state: next, flush: { key, n, ms: total } };
  }
  next[key] = { n, ms: total };
  return { state: next, flush: null };
}
function recordRead(projectDir, ev) {
  try {
    const tldrDir = join3(projectDir, ".tldr");
    if (!existsSync2(tldrDir)) return;
    const statsDir = join3(tldrDir, "stats");
    mkdirSync2(statsDir, { recursive: true });
    const logFile = join3(statsDir, "hook_activity.jsonl");
    if (ev.outcome === "deny" || ev.outcome === "fail_open") {
      appendFileSync(logFile, JSON.stringify(buildLogRow(ev)) + "\n");
      return;
    }
    const counterFile = join3(statsDir, COUNTER_FILE);
    let state = {};
    try {
      state = JSON.parse(readFileSync2(counterFile, "utf-8"));
    } catch {
    }
    const key = `${ev.outcome}|${ev.reason}`;
    const { state: next, flush } = bumpCounter(state, key, ev.duration_ms);
    writeFileSync2(counterFile, JSON.stringify(next));
    if (flush) {
      const [outcome, reason] = flush.key.split("|");
      const row = buildLogRow({ outcome, reason, duration_ms: flush.ms }, flush.n);
      appendFileSync(logFile, JSON.stringify(row) + "\n");
    }
  } catch {
  }
}
function readStdin() {
  return readFileSync2(0, "utf-8");
}
var START = performance.now();
async function main() {
  const input = JSON.parse(readStdin());
  if (input.tool_name !== "Read") {
    console.log("{}");
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const finish = (stdout, ev) => {
    recordRead(projectDir, { ...ev, duration_ms: performance.now() - START });
    console.log(stdout);
  };
  const allow = (outcome, reason) => finish("{}", { outcome, reason });
  const filePath = input.tool_input.file_path || "";
  if (!isCodeFile(filePath)) return allow("allow", "prefilter");
  if (isAllowedFile(filePath)) return allow("allow", "prefilter");
  if (input.tool_input.offset || input.tool_input.limit && input.tool_input.limit < 100) {
    return allow("allow", "prefilter");
  }
  let rawBytes = 0;
  try {
    const stats = statSync(filePath);
    rawBytes = stats.size;
    if (stats.size < MIN_INTERCEPT_BYTES) return allow("below_threshold", "below_threshold");
  } catch {
    return allow("allow", "stat_error");
  }
  if (isDaemonUnreachableCached(projectDir)) return allow("fail_open", "daemon_unreachable_cached");
  const reachable = await probeDaemonFast(projectDir);
  if (!reachable) {
    cacheDaemonUnreachable(projectDir);
    return allow("fail_open", "daemon_unreachable");
  }
  const language = detectLanguage(filePath);
  let layers = ["ast", "call_graph"];
  let target = null;
  let contextSource = "default";
  const searchContext = getSearchContext(input.session_id, filePath);
  if (searchContext) {
    layers = searchContext.suggestedLayers;
    target = searchContext.target;
    contextSource = `${searchContext.targetType}: ${searchContext.target}`;
  }
  const tldrContext = await getTldrContext(filePath, language, layers, target, input.session_id, contextSource);
  if (!tldrContext || tldrContext.length < MIN_INJECTED_CHARS) return allow("fail_open", "summary_insufficient");
  if (target && !tldrContext.includes(target)) return allow("fail_open", "target_not_in_summary");
  const layerNames = layers.map((l) => {
    switch (l) {
      case "ast":
        return "L1:AST";
      case "call_graph":
        return "L2:CallGraph";
      case "cfg":
        return "L3:CFG";
      case "dfg":
        return "L4:DFG";
      case "pdg":
        return "L5:PDG";
      default:
        return l;
    }
  }).join(" + ");
  let crossFileSection = "";
  if (searchContext?.callers && searchContext.callers.length > 0) {
    const callerLines = searchContext.callers.slice(0, 10).map((c) => {
      const parts = c.split("/");
      const fileAndLine = parts[parts.length - 1];
      const dir = parts.length > 2 ? parts[parts.length - 2] : "";
      return `  ${dir ? dir + "/" : ""}${fileAndLine}`;
    });
    crossFileSection = `
## Cross-File Usage (${searchContext.callers.length} refs)
${callerLines.join("\n")}${searchContext.callers.length > 10 ? `
  ... and ${searchContext.callers.length - 10} more` : ""}
`;
  }
  let definitionSection = "";
  if (searchContext?.definitionLocation && !searchContext.definitionLocation.includes(basename(filePath))) {
    definitionSection = `
\u{1F4CD} Defined at: ${searchContext.definitionLocation}
`;
  }
  const reasonText = `\u{1F4CA} TLDR Context (${layerNames}):
${searchContext ? `\u{1F517} Context: ${contextSource}` : ""}${definitionSection}

${tldrContext}${crossFileSection}
---
To read the code itself, re-issue the Read with offset/limit (e.g. offset=1 limit=200).
Test files and .claude/hooks|skills paths bypass this hook entirely.`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasonText
    }
  };
  finish(JSON.stringify(output), {
    outcome: "deny",
    reason: "summary_injected",
    layers_returned: layers.length,
    bytes_raw: rawBytes,
    bytes_injected: reasonText.length
  });
}
if (process.argv[1] && process.argv[1].includes("tldr-read-enforcer")) {
  main().catch((err) => {
    console.error(`TLDR enforcer error: ${err.message}`);
    recordRead(process.env.CLAUDE_PROJECT_DIR || process.cwd(), {
      outcome: "fail_open",
      reason: "error",
      duration_ms: performance.now() - START
    });
    console.log("{}");
  });
}
export {
  BATCH_FLUSH_AT,
  buildLogRow,
  bumpCounter,
  contextMatchesFile,
  recordRead
};
