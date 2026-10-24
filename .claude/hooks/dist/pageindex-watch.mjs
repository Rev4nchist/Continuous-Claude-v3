#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pageindex-watch.ts
import * as fs from "fs";
import * as path from "path";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
var RELAY_SCRIPT = "const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',()=>process.exit(1));p.on('exit',(code)=>process.exit(code??1));";
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/pageindex-watch.ts
var INDEXED_PATTERNS = [
  /ROADMAP\.md$/i,
  /README\.md$/i,
  /docs[\/\\].*\.md$/i,
  /\.claude[\/\\]docs[\/\\].*\.md$/i,
  /\.claude[\/\\]skills[\/\\][^\/\\]+[\/\\]SKILL\.md$/i,
  /\.claude[\/\\]agents[\/\\].*\.md$/i,
  /ARCHITECTURE\.md$/i
];
var STATE_DIR = process.env.CLAUDE_LOCAL_STATE_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "local-state");
var DEBOUNCE_FILE = path.join(STATE_DIR, "pageindex-pending.json");
var DEBOUNCE_MS = 2e3;
function isIndexedFile(filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return INDEXED_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}
function loadPending() {
  try {
    if (fs.existsSync(DEBOUNCE_FILE)) {
      const content = fs.readFileSync(DEBOUNCE_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch {
  }
  return null;
}
function savePending(pending) {
  ensureStateDir();
  fs.writeFileSync(DEBOUNCE_FILE, JSON.stringify(pending, null, 2));
}
function clearPending() {
  try {
    if (fs.existsSync(DEBOUNCE_FILE)) {
      fs.unlinkSync(DEBOUNCE_FILE);
    }
  } catch {
  }
}
function triggerReindex(projectDir, files) {
  const opcDir = process.env.CLAUDE_OPC_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", "continuous-claude", "opc");
  const pythonPath = "uv";
  const args = [
    "run",
    "python",
    "-m",
    "scripts.pageindex.batch_index",
    "--project",
    projectDir,
    "--tier",
    "1",
    "--quiet"
  ];
  try {
    const proc = spawnDetachedHidden(pythonPath, args, {
      cwd: opcDir,
      stdio: "ignore",
      env: {
        ...process.env,
        PYTHONPATH: opcDir
      }
    });
    proc.unref();
    console.error(`[pageindex-watch] PageIndex regeneration triggered for: ${files.map((f) => path.basename(f)).join(", ")}`);
  } catch (err) {
    console.error(`[WARN] PageIndex regeneration failed: ${err}`);
  }
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (!["Write", "Edit"].includes(data.tool_name)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (data.tool_result?.success === false) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const filePath = data.tool_input?.file_path;
  if (!filePath) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (!isIndexedFile(filePath)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const now = Date.now();
  let pending = loadPending();
  if (pending && pending.projectDir === projectDir) {
    if (!pending.files.includes(filePath)) {
      pending.files.push(filePath);
    }
  } else {
    if (pending && pending.files.length > 0) {
      triggerReindex(pending.projectDir, pending.files);
    }
    pending = {
      files: [filePath],
      timestamp: now,
      projectDir
    };
  }
  savePending(pending);
  const elapsed = now - pending.timestamp;
  if (elapsed >= DEBOUNCE_MS) {
    triggerReindex(projectDir, pending.files);
    clearPending();
  } else {
    console.error(`[pending] PageIndex update pending: ${path.basename(filePath)}`);
  }
  console.log(JSON.stringify({ result: "continue" }));
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
main().catch((err) => {
  console.error("pageindex-watch error:", err);
  console.log(JSON.stringify({ result: "continue" }));
});
