#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lane-board-stop-gate.ts
import * as fs from "fs";
import * as path from "path";
var BOARD_ARTIFACT_ID = "RtrTNVfAq9uowmb2tfbzid";
var BOARD_ARTIFACT_URL = `https://claude.ai/artifact/${BOARD_ARTIFACT_ID}`;
var RENDER_COMMAND = "node scripts/coordination/render-board.mjs";
var BOARD_FILE = "lane-board.html";
var isObj = (v) => v !== null && typeof v === "object";
function blockReason() {
  return `The lane board page is out of date: this session changed the lane DB and has not republished it. Run ${RENDER_COMMAND}, then publish ${BOARD_FILE} with the Artifact tool to url ${BOARD_ARTIFACT_URL} (omit capabilities). If the publish is refused because a newer version exists, render again and retry once. Then finish your turn.`;
}
function isHeadless(env) {
  if (env.LANE_CONTEXT_HEADLESS === "1") return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
}
function decideStop(payload, env, pending) {
  const approve = { action: "approve" };
  if (!isObj(payload)) return approve;
  if (payload.stop_hook_active === true) return approve;
  if (isHeadless(env)) return approve;
  if (typeof payload.session_id !== "string" || !payload.session_id) return approve;
  if (pending === null) return approve;
  if (pending.stopBlocked === true) return approve;
  return { action: "block", reason: blockReason() };
}
function stateDir(env = process.env) {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path.join(home, ".claude", "state", "lane-board-pending");
}
function stateFile(sessionId, env = process.env) {
  return path.join(stateDir(env), `${sessionId.replace(/[^a-zA-Z0-9-_]/g, "_")}.json`);
}
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(s) ? s : null;
  } catch {
    return null;
  }
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
  const file = sessionId ? stateFile(sessionId) : "";
  const pending = file ? readState(file) : null;
  const d = decideStop(payload, process.env, pending);
  if (d.action !== "block") return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...pending ?? {}, stopBlocked: true }));
  } catch {
    return;
  }
  console.log(JSON.stringify({ decision: "block", reason: d.reason }));
}
if (!process.env.VITEST) {
  main().catch(() => {
  });
}
export {
  BOARD_ARTIFACT_ID,
  BOARD_ARTIFACT_URL,
  BOARD_FILE,
  RENDER_COMMAND,
  blockReason,
  decideStop,
  isHeadless,
  main,
  stateDir,
  stateFile
};
