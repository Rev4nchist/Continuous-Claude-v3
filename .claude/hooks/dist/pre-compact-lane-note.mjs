#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-compact-lane-note.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync,
  statSync as statSync2,
  constants
} from "fs";
import { dirname as dirname2, basename, join as join2 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join(homedir(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname(LOG_FILE);
var MAX_LOG_SIZE = 5 * 1024 * 1024;
var MIN_LEVEL = process.env.CLAUDE_HOOK_LOG_LEVEL || "info";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || void 0;
}
function writeLog(entry) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function createLogger(hookName) {
  function log2(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId()
    };
    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }
    writeLog(entry);
    if (level === "error" || level === "warn") {
      console.error(`[${hookName}] ${level.toUpperCase()}: ${msg}`);
    }
  }
  return {
    debug: (msg, data) => log2("debug", msg, data),
    info: (msg, data) => log2("info", msg, data),
    warn: (msg, data) => log2("warn", msg, data),
    error: (msg, data) => log2("error", msg, data)
  };
}

// src/shared/atomic-write.ts
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join2(dir, `.${basename(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync(tmpFile);
    } catch {
    }
    throw err;
  }
}
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync2(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startTime > timeoutMs) {
          log.error("Lock acquisition timed out", { lockFile, timeoutMs });
          return false;
        }
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
        }
      } else {
        log.error("Lock acquisition failed", { lockFile, error: String(err) });
        return false;
      }
    }
  }
}
function releaseLockSync(filePath) {
  const lockFile = filePath + ".lock";
  try {
    if (existsSync2(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function writeStateWithLock(filePath, content) {
  const locked = acquireLockSync(filePath);
  try {
    atomicWriteSync(filePath, content);
  } catch (err) {
    log.error("State write failed", { filePath, error: String(err) });
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

// src/pre-compact-lane-note.ts
var COOLDOWN_MS = 5 * 60 * 1e3;
var CALL_TIMEOUT_MS = 4e3;
var TOTAL_BUDGET_MS = 1e4;
var TODO_MAX = 120;
var NOTE_MAX = 300;
var BRANCH_MAX = 80;
var TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
var SAFE_LANE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
var skipped = (why) => ({ continue: true, systemMessage: `[PreCompact] lane note skipped: ${why}` });
function pickHeldLanes(boardJson, sessionId) {
  const lanes = boardJson?.lanes;
  if (!Array.isArray(lanes)) return [];
  const ids = [];
  for (const l of lanes) {
    const lane = l;
    if (!lane || typeof lane.id !== "string") continue;
    if (lane.owner_session_id !== sessionId || lane.state === "done") continue;
    if (SAFE_LANE_ID.test(lane.id)) ids.push(lane.id);
  }
  return ids;
}
function toOneLine(text) {
  return text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}
function buildCompactText(opts) {
  const trigger = opts.trigger === "manual" || opts.trigger === "auto" ? opts.trigger : "unknown";
  const hh = String(opts.now.getHours()).padStart(2, "0");
  const mm = String(opts.now.getMinutes()).padStart(2, "0");
  const todo = toOneLine(opts.todo ?? "").slice(0, TODO_MAX).trim();
  const branch = toOneLine(opts.branch ?? "").slice(0, BRANCH_MAX).trim();
  const text = `Compacting (${trigger}) at ${hh}:${mm} local${branch ? ` on branch ${branch}` : ""}.` + (todo ? ` Open task: ${todo}.` : "");
  return text.slice(0, NOTE_MAX);
}
function lastTodoWrite(transcriptText) {
  let last = null;
  let at = -1;
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("TodoWrite")) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const part of entry.message.content) {
        if (part?.type === "tool_use" && part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
          last = part.input.todos;
          at = i;
        }
      }
    } catch {
    }
  }
  const hit = last?.find((t) => t && t.status === "in_progress" && typeof t.content === "string");
  return hit ? { text: hit.content, at } : null;
}
function firstInProgressTodo(transcriptText) {
  return lastTodoWrite(transcriptText)?.text ?? null;
}
function firstInProgressTask(transcriptText) {
  const pending = /* @__PURE__ */ new Map();
  const subjects = /* @__PURE__ */ new Map();
  const status = /* @__PURE__ */ new Map();
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes('"task"')) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      if (entry.type === "assistant") {
        for (const part of content) {
          if (part?.type !== "tool_use") continue;
          if (part.name === "TaskCreate" && typeof part.input?.subject === "string" && typeof part.id === "string") {
            pending.set(part.id, part.input.subject);
          } else if (part.name === "TaskUpdate" && typeof part.input?.taskId === "string") {
            if (typeof part.input.subject === "string") subjects.set(part.input.taskId, part.input.subject);
            if (typeof part.input.status === "string") status.set(part.input.taskId, { status: part.input.status, at: i });
          }
        }
      } else if (entry.type === "user" && typeof entry.toolUseResult?.task?.id === "string") {
        for (const part of content) {
          const subject = part?.type === "tool_result" ? pending.get(part.tool_use_id) : void 0;
          if (subject !== void 0) subjects.set(entry.toolUseResult.task.id, subject);
        }
      }
    } catch {
    }
  }
  const open = [...status.entries()].filter(([id, s]) => s.status === "in_progress" && subjects.has(id)).sort((a, b) => Number(a[0]) - Number(b[0]));
  return open.length ? { text: subjects.get(open[0][0]), at: open[0][1].at } : null;
}
function currentWorkText(transcriptText) {
  const todo = lastTodoWrite(transcriptText);
  const task = firstInProgressTask(transcriptText);
  if (todo && task) return todo.at > task.at ? todo.text : task.text;
  return (todo ?? task)?.text ?? null;
}
function branchOf(cwd) {
  try {
    let dir = path.resolve(cwd || ".");
    for (let i = 0; i < 8; i++) {
      const dotGit = path.join(dir, ".git");
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf-8"));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8"));
        return ref ? ref[1].trim() : null;
      }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
  }
  return null;
}
function inCooldown(state, sessionId, nowMs) {
  const last = state?.[sessionId];
  return typeof last === "number" && nowMs - last < COOLDOWN_MS;
}
function readState(stateFile) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function stampState(stateFile, sessionId, nowMs) {
  try {
    const next = {};
    for (const [k, v] of Object.entries(readState(stateFile))) {
      if (typeof v === "number" && nowMs - v < COOLDOWN_MS) next[k] = v;
    }
    next[sessionId] = nowMs;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeStateWithLock(stateFile, JSON.stringify(next, null, 2));
  } catch {
  }
}
function readTranscriptTail(file) {
  if (!file) return "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
var spawnLaneCli = (laneCli) => (args, opts) => new Promise((resolve2) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve2({ code, stdout, stderr });
  };
  let proc;
  try {
    proc = spawn(process.execPath, [laneCli, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    resolve2({ code: -1, stdout, stderr });
    return;
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
    }
    stderr += "timeout";
    done(-1);
  }, opts.timeoutMs);
  proc.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("error", () => done(-1));
  proc.on("close", (code) => done(code ?? -1));
});
async function runPreCompactLaneNote(input, deps) {
  try {
    const sessionId = input.session_id;
    if (!sessionId) return skipped("no session id");
    const started = deps.now().getTime();
    if (inCooldown(readState(deps.stateFile), sessionId, started)) return skipped("cooldown (noted within 5 minutes)");
    const cwd = input.cwd || process.cwd();
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const left = () => Math.min(CALL_TIMEOUT_MS, TOTAL_BUDGET_MS - (deps.now().getTime() - started));
    const boardRun = await deps.runner(["board", "--json"], { cwd, env, timeoutMs: left() });
    if (boardRun.code !== 0) return skipped(`lane board unavailable (exit ${boardRun.code})`);
    let boardJson;
    try {
      boardJson = JSON.parse(boardRun.stdout);
    } catch {
      return skipped("lane board output is not JSON");
    }
    const held = pickHeldLanes(boardJson, sessionId);
    if (held.length === 0) return skipped("no held lane");
    const text = buildCompactText({
      trigger: input.trigger,
      now: deps.now(),
      todo: currentWorkText(readTranscriptTail(input.transcript_path)),
      branch: branchOf(cwd)
    });
    let written = 0;
    for (const laneId of held) {
      if (left() <= 0) break;
      try {
        const r = await deps.runner(["compact", laneId, text], { cwd, env, timeoutMs: left() });
        if (r.code === 0) written++;
      } catch {
      }
    }
    if (written === 0) return skipped("every compact event write failed");
    stampState(deps.stateFile, sessionId, started);
    return { continue: true, systemMessage: `[PreCompact] compact event logged on ${written} lane(s)` };
  } catch (err) {
    return skipped(`error (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
  }
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
  let out;
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const home = process.env.CCV3_USER_HOME || os.homedir();
    const laneCli = path.join(home, ".claude", "scripts", "lane.mjs");
    out = await runPreCompactLaneNote(input, {
      runner: spawnLaneCli(laneCli),
      now: () => /* @__PURE__ */ new Date(),
      // One file under ~/.claude/state, not the project folder: no stray state file in every project you compact in.
      stateFile: path.join(home, ".claude", "state", "pre-compact-lane-note.json"),
      laneCli
    });
  } catch {
    out = skipped("bad hook input");
  }
  console.log(JSON.stringify(out));
}
if ((process.argv[1] || "").includes("pre-compact-lane-note")) {
  main().catch(() => console.log(JSON.stringify(skipped("error"))));
}
export {
  branchOf,
  buildCompactText,
  currentWorkText,
  firstInProgressTask,
  firstInProgressTodo,
  inCooldown,
  pickHeldLanes,
  runPreCompactLaneNote,
  spawnLaneCli
};
