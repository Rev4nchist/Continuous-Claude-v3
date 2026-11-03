#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lane-board-republish-reminder.ts
import * as fs from "fs";
import * as path from "path";

// src/shared/mask-quotes.ts
var BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING : BASH_STRING, blank);
}

// src/shared/tool-error.ts
function detectToolError(toolResponse) {
  if (toolResponse === null || typeof toolResponse !== "object") {
    return false;
  }
  const resp = toolResponse;
  if (resp.is_error === true) {
    return true;
  }
  const err = resp.error;
  if (typeof err === "string" && err.trim().length > 0) {
    return true;
  }
  if (err === true) {
    return true;
  }
  if (resp.success === false) {
    return true;
  }
  if (resp.status === "error") {
    return true;
  }
  return false;
}
function exitCodeOf(resp) {
  if (resp && typeof resp === "object") {
    const o = resp;
    for (const k of ["exit_code", "exitCode", "code", "status"]) {
      if (typeof o[k] === "number") return o[k];
    }
    if (o.is_error === true) return -1;
  }
  return null;
}

// src/lane-board-republish-reminder.ts
var BOARD_ARTIFACT_ID = "RtrTNVfAq9uowmb2tfbzid";
var BOARD_ARTIFACT_URL = `https://claude.ai/artifact/${BOARD_ARTIFACT_ID}`;
var RENDER_COMMAND = "node scripts/coordination/render-board.mjs";
var BOARD_FILE = "lane-board.html";
var CHANGING_VERBS = /* @__PURE__ */ new Set([
  "claim",
  "release",
  "done",
  "note",
  "say",
  "add",
  "apply-kanban",
  "adopt",
  "state",
  "seed"
]);
var HOOK_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "Artifact"]);
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var NONE = { action: "none" };
var isObj = (v) => v !== null && typeof v === "object";
function reminder(verb) {
  return `Lane DB changed (lane.mjs ${verb}). The lane board page is a snapshot. When this batch of lane changes is done: run ${RENDER_COMMAND}, then publish ${BOARD_FILE} with the Artifact tool to url ${BOARD_ARTIFACT_URL} (omit capabilities). Steps: kanban-sync skill step 7.`;
}
function laneChangeVerb(command, tool) {
  const unquoted = command.replace(/(["'])([^"'\n]*lane\.mjs)\1/g, "$2");
  const masked = maskQuoted(unquoted, tool);
  const re = /^[(\s]*(?:&\s+)?(?:\w+=\S+\s+)*node(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:[^\s;&|()]*[\\/])?lane\.mjs\s+([a-z][a-z-]*)/;
  for (const segment of masked.split(/[;&|\n]+/)) {
    if (/--dry-run\b/.test(segment)) continue;
    const m = segment.match(re);
    if (m && CHANGING_VERBS.has(m[1])) return m[1];
  }
  return null;
}
function failed(data) {
  if (data.hook_event_name === "PostToolUseFailure") return true;
  const resp = data.tool_response;
  if (detectToolError(resp)) return true;
  const code = exitCodeOf(resp);
  return code !== null && code !== 0;
}
function isBoardPublish(input) {
  const url = typeof input.url === "string" ? input.url : "";
  const file = typeof input.file_path === "string" ? input.file_path : "";
  return url.includes(BOARD_ARTIFACT_ID) || file.replace(/\\/g, "/").toLowerCase().endsWith(`/${BOARD_FILE}`) || file.toLowerCase() === BOARD_FILE;
}
function decide(payload, pending) {
  if (!isObj(payload)) return NONE;
  const tool = payload.tool_name;
  if (typeof tool !== "string" || !HOOK_TOOLS.has(tool)) return NONE;
  if (typeof payload.session_id !== "string" || !payload.session_id) return NONE;
  const input = payload.tool_input;
  if (!isObj(input) || failed(payload)) return NONE;
  if (tool === "Artifact") return isBoardPublish(input) ? { action: "clear" } : NONE;
  if (!COMMAND_TOOLS.has(tool) || typeof input.command !== "string") return NONE;
  const verb = laneChangeVerb(input.command, tool);
  if (!verb) return NONE;
  return pending ? { action: "mark", verb } : { action: "remind", verb, message: reminder(verb) };
}
function stateDir() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".claude", "state", "lane-board-pending");
}
function stateFile(sessionId) {
  return path.join(stateDir(), `${sessionId.replace(/[^a-zA-Z0-9-_]/g, "_")}.json`);
}
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(s) ? s : null;
  } catch {
    return null;
  }
}
function applyDecision(d, sessionId) {
  const file = stateFile(sessionId);
  if (d.action === "clear") {
    fs.rmSync(file, { force: true });
    return;
  }
  const prev = readState(file);
  const verbs = [...prev?.verbs ?? [], d.verb].slice(-50);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ since: prev?.since ?? (/* @__PURE__ */ new Date()).toISOString(), verbs }));
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) return;
  const payload = JSON.parse(input);
  const sessionId = isObj(payload) && typeof payload.session_id === "string" ? payload.session_id : "";
  const pending = sessionId ? readState(stateFile(sessionId)) !== null : false;
  const d = decide(payload, pending);
  if (d.action === "none") return;
  applyDecision(d, sessionId);
  if (d.action === "remind") {
    console.log(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: d.message } })
    );
  }
}
if (!process.env.VITEST) {
  main().catch(() => {
  });
}
export {
  BOARD_ARTIFACT_ID,
  BOARD_ARTIFACT_URL,
  BOARD_FILE,
  CHANGING_VERBS,
  RENDER_COMMAND,
  decide,
  laneChangeVerb,
  main,
  stateFile
};
