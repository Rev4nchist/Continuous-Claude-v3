#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-end-extract.ts
import { execSync } from "child_process";
import * as path from "path";

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

// src/session-end-extract.ts
import * as fs from "fs";

// src/shared/extraction-state.ts
var STATE_VERSION = 2;
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var finiteNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
function cleanEntry(raw) {
  const o = isObject(raw) ? raw : {};
  const entry = {};
  const line = finiteNumber(o.last_extracted_line);
  const launched = finiteNumber(o.last_launched);
  if (line !== void 0) entry.last_extracted_line = line;
  if (launched !== void 0) entry.last_launched = launched;
  if (typeof o.last_extraction_time === "string") entry.last_extraction_time = o.last_extraction_time;
  return entry;
}
function parseState(text) {
  const sessions = /* @__PURE__ */ Object.create(null);
  const state = { version: STATE_VERSION, recent_hashes: [], sessions };
  if (!text || !text.trim()) return state;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return state;
  }
  if (!isObject(data)) return state;
  if (Array.isArray(data.recent_hashes)) {
    state.recent_hashes = data.recent_hashes.filter((h) => typeof h === "string");
  }
  if (isObject(data.sessions)) {
    for (const [sid, entry] of Object.entries(data.sessions)) sessions[sid] = cleanEntry(entry);
  } else if (typeof data.session_id === "string" && data.session_id) {
    sessions[data.session_id] = cleanEntry(data);
  }
  return state;
}
function sessionStartLine(state, sessionId) {
  return state.sessions[sessionId]?.last_extracted_line ?? 0;
}

// src/session-end-extract.ts
var MIN_TURNS = 10;
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || path.join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function getStateFilePath(projectDir) {
  return path.join(projectDir, ".claude", "extraction-state.json");
}
function loadExtractionState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return fs.readFileSync(stateFile, "utf-8");
  } catch {
    return null;
  }
}
function shouldExtract(sessionId, projectDir) {
  const opcDir = getOpcDir();
  const lazyMemoryPath = path.join(opcDir, "scripts", "core", "lazy_memory.py");
  if (!fs.existsSync(lazyMemoryPath)) {
    console.error("lazy_memory.py not found");
    return false;
  }
  try {
    const result = execSync(
      `cd "${opcDir}" && uv run python scripts/core/lazy_memory.py check --session-id "${sessionId}" --project "${projectDir}" --min-turns ${MIN_TURNS} --json`,
      { encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
    );
    const data = JSON.parse(result.trim());
    return data.should_extract === true;
  } catch (err) {
    return true;
  }
}
function extractWithDedup(sessionId, projectDir, transcriptPath) {
  const opcDir = getOpcDir();
  const stateFile = getStateFilePath(projectDir);
  const state = loadExtractionState(stateFile);
  const incrementalScript = path.join(opcDir, "scripts", "core", "incremental_extract.py");
  if (transcriptPath && fs.existsSync(transcriptPath) && fs.existsSync(incrementalScript)) {
    const startLine = sessionStartLine(parseState(state), sessionId);
    console.error(`[SessionEnd:L3] Final sweep from line ${startLine} with dedup (fire-and-forget)`);
    const child = spawnDetachedHidden("uv", [
      "run",
      "python",
      "scripts/core/incremental_extract.py",
      "--transcript",
      transcriptPath,
      "--session-id",
      sessionId,
      "--start-line",
      startLine.toString(),
      "--state-file",
      stateFile,
      "--project-dir",
      projectDir,
      "--max-learnings",
      "15",
      "--json"
    ], {
      cwd: opcDir,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: opcDir }
    });
    child.unref();
    return;
  }
  extractLearningsLegacy(sessionId, projectDir);
}
function extractLearningsLegacy(sessionId, projectDir) {
  const opcDir = getOpcDir();
  const lazyMemoryPath = path.join(opcDir, "scripts", "core", "lazy_memory.py");
  if (!fs.existsSync(lazyMemoryPath)) {
    console.error("lazy_memory.py not found, skipping extraction");
    return;
  }
  const child = spawnDetachedHidden(
    "uv",
    [
      "run",
      "python",
      "scripts/core/lazy_memory.py",
      "extract",
      "--session-id",
      sessionId,
      "--project",
      projectDir,
      "--max-learnings",
      "10"
    ],
    {
      cwd: opcDir,
      stdio: "ignore"
    }
  );
  child.unref();
  console.error(`\u2713 Memory extraction started for session ${sessionId.slice(0, 8)}...`);
}
async function main() {
  if (process.env.CCV3_DISTILL_CHILD) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
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
  const sessionId = data.session_id;
  if (!sessionId) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!shouldExtract(sessionId, projectDir)) {
    console.error(`\u2139 Session too short for extraction (< ${MIN_TURNS} turns)`);
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  extractWithDedup(sessionId, projectDir, data.transcript_path);
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
  console.error("session-end-extract error:", err);
  console.log(JSON.stringify({ result: "continue" }));
});
