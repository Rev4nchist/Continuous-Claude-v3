#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-end-handoff-indexer.ts
import * as fs from "fs";
import * as path from "path";
import { spawn as spawn2 } from "child_process";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
var RELAY_ERROR_LOG = join(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/session-end-handoff-indexer.ts
var RECENT_WINDOW_MS = 3e4;
var HANDOFF_EXTS = [".yaml", ".yml", ".md"];
function findRecentHandoff(input) {
  const recentMs = input.recentMs ?? RECENT_WINDOW_MS;
  const fsApi = input.fsApi ?? fs;
  const handoffsDir = path.join(input.projectDir, "thoughts", "shared", "handoffs");
  if (!fsApi.existsSync(handoffsDir)) return null;
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fsApi.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === "archive") continue;
        walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!HANDOFF_EXTS.includes(ext)) continue;
      try {
        const stat = fsApi.statSync(child);
        if (newest === null || stat.mtimeMs > newest.mtimeMs) {
          newest = { abs: child, mtimeMs: stat.mtimeMs };
        }
      } catch {
      }
    }
  };
  walk(handoffsDir, 0);
  if (newest === null) return null;
  if (input.now - newest.mtimeMs > recentMs) return null;
  return newest.abs;
}
function resolveIndexerScript(input) {
  const fsApi = input.fsApi ?? fs;
  const candidates = [
    path.join(input.opcDir, "scripts", "core", "index_handoffs.py"),
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".claude",
      "scripts",
      "core",
      "core",
      "index_handoffs.py"
    )
  ];
  for (const c of candidates) {
    if (c && fsApi.existsSync(c)) return c;
  }
  return null;
}
function getOpcDir() {
  if (process.env.CLAUDE_OPC_DIR) return process.env.CLAUDE_OPC_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, "continuous-claude", "opc");
}
function getLogPath(projectDir) {
  return path.join(projectDir, ".claude", "logs", "handoff-indexer.log");
}
function appendLog(logPath, message) {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`;
    fs.appendFileSync(logPath, line);
  } catch {
  }
}
function spawnIndexer(input) {
  const spawner = input.spawnFn ?? spawn2;
  const child = spawnDetachedHidden(
    "uv",
    [
      "run",
      "python",
      input.scriptPath,
      "--apply",
      "--only-path",
      input.handoffPath
    ],
    {
      cwd: input.opcDir,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: input.opcDir }
    },
    spawner
  );
  child.unref?.();
}
function decideIndex(input) {
  if (!input.projectDir) {
    return { action: "skip", reason: "no_project_dir" };
  }
  const handoffPath = findRecentHandoff({
    projectDir: input.projectDir,
    now: input.now,
    recentMs: input.recentMs,
    fsApi: input.fsApi
  });
  if (!handoffPath) {
    return { action: "skip", reason: "no_recent_handoff" };
  }
  const scriptPath = resolveIndexerScript({
    opcDir: input.opcDir,
    fsApi: input.fsApi
  });
  if (!scriptPath) {
    return { action: "skip", reason: "indexer_script_missing" };
  }
  return { action: "index", handoffPath, scriptPath };
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
  });
}
async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const opcDir = getOpcDir();
  const logPath = getLogPath(projectDir);
  try {
    const decision = decideIndex({
      projectDir,
      opcDir,
      now: Date.now()
    });
    if (decision.action === "skip") {
      appendLog(
        logPath,
        `skip session=${input.session_id ?? "<unknown>"} reason=${decision.reason}`
      );
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    appendLog(
      logPath,
      `index session=${input.session_id ?? "<unknown>"} handoff=${decision.handoffPath}`
    );
    spawnIndexer({
      scriptPath: decision.scriptPath,
      handoffPath: decision.handoffPath,
      opcDir
    });
  } catch (err) {
    appendLog(logPath, `error: ${err.message ?? err}`);
  }
  console.log(JSON.stringify({ result: "continue" }));
}
var invokedDirectly = (() => {
  try {
    const argvFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return argvFile.endsWith("session-end-handoff-indexer.mjs") || argvFile.endsWith("session-end-handoff-indexer.js") || argvFile.endsWith("session-end-handoff-indexer.ts");
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error("session-end-handoff-indexer error:", err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  HANDOFF_EXTS,
  RECENT_WINDOW_MS,
  appendLog,
  decideIndex,
  findRecentHandoff,
  getLogPath,
  getOpcDir,
  resolveIndexerScript,
  spawnIndexer
};
