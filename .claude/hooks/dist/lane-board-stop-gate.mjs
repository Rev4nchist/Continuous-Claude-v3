#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lane-board-stop-gate.ts
import * as fs4 from "fs";

// src/shared/lane-board.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function normalizeRoot(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/^\/\/[?.]\//, "");
  s = s.toLowerCase();
  s = s.replace(/^\/([a-z])(?=\/|$)/, "$1:");
  s = s.replace(/(?<=.)\/{2,}/g, "/");
  return s.replace(/\/+$/, "");
}
var isAbsoluteNorm = (s) => /^[a-z]:(\/|$)/.test(s) || s.startsWith("/");
var slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
var registryFile = (opts, env) => opts.registryPath || env.LANE_REGISTRY_PATH || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".claude", "project-registry.json");
function loadRegistry(opts = {}) {
  const env = opts.env ?? process.env;
  let projects;
  try {
    const text = fs.readFileSync(registryFile(opts, env), "utf8").replace(/^\uFEFF/, "");
    projects = JSON.parse(text).projects;
  } catch {
    return [];
  }
  if (!Array.isArray(projects)) return [];
  const out = [];
  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    const e = p;
    const name = typeof e.name === "string" ? e.name : "";
    const key = typeof e.key === "string" && e.key ? e.key : slugify(name);
    if (!key) continue;
    const root = typeof e.path === "string" ? normalizeRoot(e.path) : "";
    out.push({
      key,
      name,
      board: typeof e.laneBoard === "string" && e.laneBoard ? e.laneBoard : key,
      status: typeof e.status === "string" ? e.status : "active",
      path: typeof e.path === "string" ? e.path : "",
      root: root && isAbsoluteNorm(root) ? root : "",
      artifact: typeof e.laneArtifact === "string" && e.laneArtifact ? e.laneArtifact : null
    });
  }
  return out;
}
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
var LANE_ARTIFACT_RE = /^https:\/\/claude\.ai\/artifact\/([A-Za-z0-9_-]+)$/;
var BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
function artifactIdOf(raw) {
  return (typeof raw === "string" ? LANE_ARTIFACT_RE.exec(raw)?.[1] : void 0) ?? null;
}
function registryBoardArtifact(board, opts, env) {
  if (!BOARD_KEY_RE.test(board)) return null;
  const owners = loadRegistry({ ...opts, env }).filter(
    (e) => e.status.toLowerCase() !== "inactive" && e.key !== DEFAULT_BOARD && e.board === e.key && e.artifact !== null
  );
  const mine = owners.filter((e) => e.key === board);
  const id = mine.length === 1 ? artifactIdOf(mine[0].artifact) : null;
  if (!id) return null;
  if (owners.some((e) => e !== mine[0] && artifactIdOf(e.artifact) === id)) return null;
  if (boardArtifact(DEFAULT_BOARD, { ...opts, env })?.id === id) return null;
  return { id, url: `https://claude.ai/artifact/${id}`, publishFrom: `lane-board-${board}.html` };
}
function boardArtifact(board, opts = {}) {
  const env = opts.env ?? process.env;
  if (board !== DEFAULT_BOARD) return registryBoardArtifact(board, opts, env);
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

// src/shared/lane-dash-refresh.ts
import * as fs2 from "fs";
import * as path2 from "path";
var STALE_AFTER_HOURS = 36;
var SHOW_EVERY_MS = 60 * 60 * 1e3;
var REFRESH_FILE = "refresh.json";
var MARKER_FILE = ".refresh-shown.json";
var MAX_BYTES = 65536;
var CHICAGO = "America/Chicago";
var isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function laneDashDir(env = process.env) {
  if (env.LANE_DASH_STATE_DIR) return env.LANE_DASH_STATE_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path2.join(home, ".claude", "state", "lane-dash");
}
function parseRefresh(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(d)) return null;
  const at = typeof d.exported_at === "string" && !Number.isNaN(Date.parse(d.exported_at)) ? d.exported_at : null;
  const key = typeof d.key === "string" ? d.key : "";
  return { pending: d.pending === true, key, exportedAt: at };
}
function staleKind(r, now) {
  if (r.pending) return "pending";
  if (r.exportedAt === null) return null;
  return now - Date.parse(r.exportedAt) > STALE_AFTER_HOURS * 36e5 ? "age" : null;
}
function formatChicago(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).formatToParts(new Date(iso));
  const p = (t) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("month")} ${p("day")}, ${p("hour")}:${p("minute")} ${p("dayPeriod")} ${p("timeZoneName")}`;
}
function staleLine(r, now) {
  const kind = staleKind(r, now);
  if (!kind) return "";
  const why = kind === "pending" ? "not uploaded" : `older than ${STALE_AFTER_HOURS} hours`;
  const when = r.exportedAt ? `exported ${formatChicago(r.exportedAt)}, ${why}` : why;
  return `FleetOps data is stale (${when}). Tell Dave in one line. Run the fleetops-refresh skill only if he asks.`;
}
function shouldShow(marker, key, now) {
  if (!marker || marker.key !== key) return true;
  const shown = Date.parse(marker.shown_at);
  if (Number.isNaN(shown)) return true;
  const age = now - shown;
  return age < 0 || age > SHOW_EVERY_MS;
}
function readSmall(file) {
  if (fs2.statSync(file).size > MAX_BYTES) return null;
  return fs2.readFileSync(file, "utf8");
}
function readMarker(file) {
  try {
    const text = readSmall(file);
    if (text === null) return null;
    const m = JSON.parse(text);
    return isObj(m) && typeof m.key === "string" && typeof m.shown_at === "string" ? { key: m.key, shown_at: m.shown_at } : null;
  } catch {
    return null;
  }
}
function writeMarker(file, marker) {
  try {
    if (fs2.lstatSync(file).isSymbolicLink()) throw new Error("is a symlink");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs2.writeFileSync(tmp, JSON.stringify(marker));
    fs2.renameSync(tmp, file);
  } catch (e) {
    try {
      fs2.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function fleetopsLine(env = process.env, now = Date.now()) {
  try {
    const dir = laneDashDir(env);
    const text = readSmall(path2.join(dir, REFRESH_FILE));
    const r = text === null ? null : parseRefresh(text);
    if (!r) return "";
    const line = staleLine(r, now);
    if (!line) return "";
    const markerFile = path2.join(dir, MARKER_FILE);
    if (!shouldShow(readMarker(markerFile), r.key, now)) return "";
    try {
      writeMarker(markerFile, { key: r.key, shown_at: new Date(now).toISOString() });
    } catch (e) {
      console.error(`lane-board-stop-gate: cannot write ${MARKER_FILE}, so the FleetOps line is dropped: ${e.message}`);
      return "";
    }
    return line;
  } catch {
    return "";
  }
}

// src/shared/lane-board-pending.ts
import * as fs3 from "fs";
import * as path3 from "path";
var PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var isObj2 = (v) => v !== null && typeof v === "object";
function pendingDir(env = process.env) {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || "";
  return path3.join(home, ".claude", "state", "lane-board-pending");
}
function pendingFile(sessionId, board = DEFAULT_BOARD, env = process.env) {
  return path3.join(pendingDir(env), `${pendingKey(sessionId, board)}.json`);
}
function readPending(file) {
  try {
    const s = JSON.parse(fs3.readFileSync(file, "utf8"));
    return isObj2(s) ? s : null;
  } catch {
    return null;
  }
}
function listPending(sessionId, env = process.env) {
  const dir = pendingDir(env);
  const stem = pendingKey(sessionId, DEFAULT_BOARD);
  let names;
  try {
    names = fs3.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const base = name.slice(0, -5);
    if (base !== stem && !base.startsWith(`${stem}@`)) continue;
    const file = path3.join(dir, name);
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
    for (const name of fs3.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path3.join(dir, name);
      try {
        if (now - fs3.statSync(file).mtimeMs > PENDING_MAX_AGE_MS) {
          fs3.rmSync(file, { force: true });
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
var isObj3 = (v) => v !== null && typeof v === "object";
function blockReason(board, env = process.env) {
  const a = boardArtifact(board, { env });
  if (!a) return "";
  return `The lane board page for board ${board} is out of date: this session changed the lane DB and has not republished it. Other sessions update this page all day, so your held copy is old. In this order: 1. Read the live page with the Artifact tool, action read, url ${a.url}, without path (a read with path does not count). Do not open or paste the saved file.2. Run ${renderBoardCmd(board, env)}. 3. At once publish ${primaryRepo(env)}/${a.publishFrom} with the Artifact tool to url ${a.url} (omit capabilities). If the publish is refused, publish the same file again: the refusal counts as the read. Then finish your turn.`;
}
function isHeadless(env) {
  if (env.LANE_CONTEXT_HEADLESS === "1") return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
}
function decideStop(payload, env, entries) {
  const approve = { action: "approve" };
  if (!isObj3(payload)) return approve;
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
  const sid = isObj3(payload) && typeof payload.session_id === "string" ? payload.session_id : "";
  const entries = sid ? listPending(sid, env) : [];
  const d = decideStop(payload, env, entries.map(({ board, pending }) => ({ board, pending })));
  if (d.action !== "block") return { output: null };
  const hit = entries.find((e) => e.board === d.board);
  try {
    fs4.writeFileSync(hit.file, JSON.stringify({ ...hit?.pending, stopBlocked: true }));
  } catch {
    return { output: null };
  }
  const headless = (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
  const line = headless ? "" : fleetopsLine(env, now);
  return { output: { decision: "block", reason: line ? `${d.reason}
${line}` : d.reason } };
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
