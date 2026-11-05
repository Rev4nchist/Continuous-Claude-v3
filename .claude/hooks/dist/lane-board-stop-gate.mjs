#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lane-board-stop-gate.ts
import * as fs3 from "fs";

// src/shared/lane-board.ts
import * as fs from "node:fs";
import * as os from "node:os";
var DEFAULT_BOARD = "continuous-claude";
function wmKey(sid, board) {
  return board === DEFAULT_BOARD ? sid : `${sid}@${board}`;
}
var fwd = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
var userHome = (env) => fwd(env.CCV3_USER_HOME || os.homedir());
function primaryRepo(env = process.env) {
  return `${userHome(env)}/continuous-claude`;
}
function renderBoardCmd(board, env = process.env) {
  return `node ${primaryRepo(env)}/scripts/coordination/render-board.mjs --project ${board}`;
}
var ARTIFACT_ID = "agentic-os-lane-board";
var FALLBACK_ARTIFACT = {
  id: "RtrTNVfAq9uowmb2tfbzid",
  url: "https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid",
  publishFrom: "lane-board.html"
};
function boardArtifact(board, opts = {}) {
  const env = opts.env ?? process.env;
  if (board !== DEFAULT_BOARD) return null;
  const file = opts.artifactsPath || `${primaryRepo(env)}/.claude/artifacts.json`;
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const list = JSON.parse(text).artifacts;
    if (Array.isArray(list)) {
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const e = a;
        if (e.id !== ARTIFACT_ID || typeof e.url !== "string") continue;
        const id = /\/artifact\/([A-Za-z0-9_-]+)/.exec(e.url)?.[1];
        if (!id) continue;
        return { id, url: e.url, publishFrom: typeof e.publish_from === "string" && e.publish_from ? e.publish_from : "lane-board.html" };
      }
    }
  } catch {
  }
  return { ...FALLBACK_ARTIFACT };
}
function pendingKey(sid, board) {
  return wmKey(sid, board).replace(/[^A-Za-z0-9@_-]/g, "_");
}

// src/shared/lane-board-pending.ts
import * as fs2 from "fs";
import * as path from "path";
var PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var isObj = (v) => v !== null && typeof v === "object";
function pendingDir(env = process.env) {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path.join(home, ".claude", "state", "lane-board-pending");
}
function pendingFile(sessionId, board = DEFAULT_BOARD, env = process.env) {
  return path.join(pendingDir(env), `${pendingKey(sessionId, board)}.json`);
}
function readPending(file) {
  try {
    const s = JSON.parse(fs2.readFileSync(file, "utf8"));
    return isObj(s) ? s : null;
  } catch {
    return null;
  }
}
function listPending(sessionId, env = process.env) {
  const dir = pendingDir(env);
  const stem = pendingKey(sessionId, DEFAULT_BOARD);
  let names;
  try {
    names = fs2.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const base = name.slice(0, -5);
    if (base !== stem && !base.startsWith(`${stem}@`)) continue;
    const file = path.join(dir, name);
    const pending = readPending(file);
    if (!pending) continue;
    const board = typeof pending.board === "string" && pending.board ? pending.board : base === stem ? DEFAULT_BOARD : base.slice(stem.length + 1);
    out.push({ file, board, pending });
  }
  return out;
}
function sweepStalePending(env = process.env, now = Date.now()) {
  const dir = pendingDir(env);
  let n = 0;
  try {
    for (const name of fs2.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs2.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) {
          fs2.rmSync(file, { force: true });
          n += 1;
        }
      } catch {
      }
    }
  } catch {
  }
  return n;
}

// src/lane-board-stop-gate.ts
var isObj2 = (v) => v !== null && typeof v === "object";
function blockReason(board, env = process.env) {
  const a = boardArtifact(board, { env });
  if (!a) return "";
  return `The lane board page for board ${board} is out of date: this session changed the lane DB and has not republished it. Run ${renderBoardCmd(board, env)}, then publish ${primaryRepo(env)}/${a.publishFrom} with the Artifact tool to url ${a.url} (omit capabilities). If the publish is refused because a newer version exists, render again and retry once. Then finish your turn.`;
}
function isHeadless(env) {
  if (env.LANE_CONTEXT_HEADLESS === "1") return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
}
function decideStop(payload, env, entries) {
  const approve = { action: "approve" };
  if (!isObj2(payload)) return approve;
  if (payload.stop_hook_active === true) return approve;
  if (isHeadless(env)) return approve;
  if (typeof payload.session_id !== "string" || !payload.session_id) return approve;
  for (const e of entries) {
    if (e.pending.stopBlocked === true) continue;
    if (!boardArtifact(e.board, { env })) continue;
    return { action: "block", reason: blockReason(e.board, env), board: e.board };
  }
  return approve;
}
var stateDir = pendingDir;
var stateFile = pendingFile;
function stopGate(payload, env = process.env, now = Date.now()) {
  sweepStalePending(env, now);
  const sid = isObj2(payload) && typeof payload.session_id === "string" ? payload.session_id : "";
  const entries = sid ? listPending(sid, env) : [];
  const d = decideStop(payload, env, entries.map(({ board, pending }) => ({ board, pending })));
  if (d.action !== "block") return { output: null };
  const hit = entries.find((e) => e.board === d.board);
  try {
    fs3.writeFileSync(hit.file, JSON.stringify({ ...hit?.pending, stopBlocked: true }));
  } catch {
    return { output: null };
  }
  return { output: { decision: "block", reason: d.reason } };
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
  const { output } = stopGate(JSON.parse(input));
  if (output) console.log(JSON.stringify(output));
}
if (!process.env.VITEST) {
  main().catch(() => {
  });
}
export {
  DEFAULT_BOARD,
  blockReason,
  decideStop,
  isHeadless,
  main,
  stateDir,
  stateFile,
  stopGate
};
