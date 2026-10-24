#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/architecture-stats-sync.ts
import { spawnSync } from "node:child_process";

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
var RELAY_SCRIPT = "const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',()=>process.exit(1));p.on('exit',(code)=>process.exit(code??1));";
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/architecture-stats-sync.ts
import { openSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
var WATCHED_PATTERN = /^(?:\.claude\/(?:hooks|agents|skills)|scripts)\//m;
var GIT_COMMIT_PATTERN = /\bgit\s+commit\b/;
function isGitCommitCommand(command) {
  if (!command) return false;
  return GIT_COMMIT_PATTERN.test(command);
}
function touchesWatchedPaths(filesOutput) {
  if (!filesOutput) return false;
  return WATCHED_PATTERN.test(filesOutput);
}
function shouldFireSync(input, commitFiles) {
  if (input.tool_name !== "Bash") return false;
  const command = input.tool_input?.command;
  if (!command) return false;
  if (!isGitCommitCommand(command)) return false;
  if (!touchesWatchedPaths(commitFiles)) return false;
  return true;
}
function resolveRepoRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function getHeadCommitFiles(cwd) {
  try {
    const result = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 5e3
    });
    if (result.status !== 0) return "";
    return result.stdout || "";
  } catch {
    return "";
  }
}
function fireBackgroundSync(repoRoot) {
  try {
    const logsDir = path.join(repoRoot, ".claude", "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, "architecture-stats-sync.log");
    const out = openSync(logFile, "a");
    const err = openSync(logFile, "a");
    const scriptPath = path.join(repoRoot, "scripts", "sync-architecture-stats.mjs");
    const child = spawnDetachedHidden("node", [scriptPath, "--apply"], {
      cwd: repoRoot,
      stdio: ["ignore", out, err]
    });
    child.unref();
  } catch {
  }
}
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 1e3).unref();
  });
}
function passthrough() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ""
    }
  });
}
async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    console.log(passthrough());
    return;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log(passthrough());
    return;
  }
  if (input.tool_name !== "Bash") {
    console.log(passthrough());
    return;
  }
  const command = input.tool_input?.command || "";
  if (!isGitCommitCommand(command)) {
    console.log(passthrough());
    return;
  }
  const repoRoot = resolveRepoRoot();
  const files = getHeadCommitFiles(repoRoot);
  if (!shouldFireSync(input, files)) {
    console.log(passthrough());
    return;
  }
  fireBackgroundSync(repoRoot);
  console.log(passthrough());
}
var invokedAsCli = (() => {
  try {
    const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
    const modulePath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    return argvPath === modulePath;
  } catch {
    return false;
  }
})();
if (invokedAsCli) {
  main().catch((err) => {
    console.error("[architecture-stats-sync] Error:", err?.message ?? err);
    console.log(passthrough());
  });
}
export {
  WATCHED_PATTERN,
  isGitCommitCommand,
  shouldFireSync,
  touchesWatchedPaths
};
