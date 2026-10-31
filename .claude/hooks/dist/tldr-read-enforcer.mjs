import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/tldr-read-enforcer.ts
import { readFileSync as readFileSync2, existsSync as existsSync2, statSync, unlinkSync as unlinkSync2, appendFileSync as appendFileSync2, mkdirSync as mkdirSync3, renameSync } from "fs";
import { basename, extname, join as join4 } from "path";

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

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { homedir } from "os";
import { dirname, join as join3 } from "path";
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
  return env.CCV3_GUARD_DECISIONS_LOG || join3(home, ".claude", "logs", "guard-decisions.jsonl");
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
  return !!env.CCV3_GUARD_DECISIONS_LOG || !env.VITEST;
}
function pathText(value, max = PATH_CHARS) {
  return typeof value === "string" && value ? value.slice(0, max) : void 0;
}
function targetOf(input, tool) {
  const explicit = pathText(input?.target);
  if (explicit) return explicit;
  const field = Object.hasOwn(TARGET_FIELD, tool) ? TARGET_FIELD[tool] : void 0;
  const toolInput = input?.tool_input;
  if (!field || typeof toolInput !== "object" || toolInput === null) return void 0;
  return pathText(toolInput[field]);
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
      agent: !!agent
    };
    if (agent) entry.agent_id = agent;
    const cwd = pathText(input?.cwd);
    if (cwd) entry.cwd = cwd;
    const mode = pathText(input?.permission_mode, 40);
    if (mode) entry.permission_mode = mode;
    const target = targetOf(input, tool);
    if (target) entry.target = target;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path2 = guardLogPath(env);
    mkdirSync2(dirname(path2), { recursive: true, mode: 448 });
    appendFileSync(path2, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

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
var JOURNAL_ROLLUP_BYTES = 1024;
var LOG_MAX_BYTES = 5 * 1024 * 1024;
var HOOK_NAME = "tldr-read-enforcer";
var JOURNAL_FILE = "tldr-read-enforcer.events.jnl";
var OUTCOMES = /* @__PURE__ */ new Set(["allow", "deny", "fail_open", "below_threshold"]);
var BATCHED_FAIL_OPEN = /* @__PURE__ */ new Set(["daemon_unreachable", "daemon_unreachable_cached"]);
var cleanMs = (ms) => Number.isFinite(ms) && ms > 0 ? Math.round(ms * 10) / 10 : 0;
var isBatched = (ev) => ev.outcome === "allow" || ev.outcome === "below_threshold" || ev.outcome === "fail_open" && BATCHED_FAIL_OPEN.has(ev.reason);
function buildLogRow(ev, count = 1, now = /* @__PURE__ */ new Date()) {
  const ms = cleanMs(ev.duration_ms);
  const isFailOpen = ev.outcome === "fail_open";
  const isError = isFailOpen && ev.reason === "error";
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
    // A fail_open is never a success; its count lives in `count` / `invocations`.
    successes: isFailOpen ? 0 : count,
    failures: isError ? count : 0,
    metrics,
    outcome: ev.outcome,
    reason: ev.reason,
    duration_ms: ms,
    count,
    timestamp: now.toISOString()
  };
}
function aggregateJournal(text) {
  const sums = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    const parts = line.split("|");
    if (parts.length !== 3) continue;
    const [outcome, reason, msText] = parts;
    const ms = Number(msText);
    if (!OUTCOMES.has(outcome) || !/^[a-z_]+$/.test(reason) || msText === "" || !Number.isFinite(ms)) continue;
    const key = `${outcome}|${reason}`;
    const cur = sums.get(key) || { n: 0, ms: 0 };
    sums.set(key, { n: cur.n + 1, ms: cur.ms + cleanMs(ms) });
  }
  return [...sums].map(([key, v]) => ({ key, n: v.n, ms: Math.round(v.ms * 10) / 10 }));
}
function appendLogRows(logFile, rowObjs, maxBytes = LOG_MAX_BYTES) {
  try {
    if (statSync(logFile).size >= maxBytes) renameSync(logFile, logFile + ".1");
  } catch {
  }
  appendFileSync2(logFile, rowObjs.map((r) => JSON.stringify(r) + "\n").join(""));
}
function rollupJournal(statsDir, logFile) {
  const journal = join4(statsDir, JOURNAL_FILE);
  const rolling = `${journal}.${process.pid}.rolling`;
  try {
    renameSync(journal, rolling);
  } catch {
    return;
  }
  const text = readFileSync2(rolling, "utf-8");
  const rowObjs = aggregateJournal(text).map(({ key, n, ms }) => {
    const [outcome, reason] = key.split("|");
    return buildLogRow({ outcome, reason, duration_ms: ms }, n);
  });
  if (rowObjs.length) appendLogRows(logFile, rowObjs);
  unlinkSync2(rolling);
}
function recordRead(projectDir, ev) {
  try {
    const tldrDir = join4(projectDir, ".tldr");
    if (!existsSync2(tldrDir)) return;
    const statsDir = join4(tldrDir, "stats");
    mkdirSync3(statsDir, { recursive: true });
    const logFile = join4(statsDir, "hook_activity.jsonl");
    if (!isBatched(ev)) {
      appendLogRows(logFile, [buildLogRow(ev)]);
      return;
    }
    const journal = join4(statsDir, JOURNAL_FILE);
    appendFileSync2(journal, `${ev.outcome}|${ev.reason}|${cleanMs(ev.duration_ms)}
`);
    if (statSync(journal).size >= JOURNAL_ROLLUP_BYTES) rollupJournal(statsDir, logFile);
  } catch {
  }
}
function logSummaryInjected(input, env) {
  logGuardDecision("tldr-read-enforcer", input, "inject", "tldr-summary-injected", { env });
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
  logSummaryInjected(input);
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
  JOURNAL_ROLLUP_BYTES,
  LOG_MAX_BYTES,
  aggregateJournal,
  appendLogRows,
  buildLogRow,
  contextMatchesFile,
  logSummaryInjected,
  recordRead,
  rollupJournal
};
