#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/test-before-done.ts
import { readFileSync as readFileSync3 } from "fs";

// src/shared/done-proof.ts
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join as join2, resolve } from "path";

// src/shared/test-run-state.ts
import * as os from "os";
import * as path from "path";
function getStateFile(sessionId) {
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(os.tmpdir(), `claude-recent-test-runs-${safe}.json`);
}

// src/shared/done-proof.ts
var MIN = 6e4;
var PROOF_WINDOW_MS = 5 * MIN;
var FAILURE_WINDOW_MS = 30 * MIN;
var VERIFY = "node ~/.claude/scripts/verify.mjs";
var RATCHETS = [/\bcontext-budget-guard\b/, /\baudit-skills\b/];
function isRatchet(command) {
  return !!command && RATCHETS.some((re) => re.test(command));
}
function readTestRun(sessionId) {
  try {
    const file = getStateFile(sessionId);
    if (!file || !existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const s = JSON.parse(raw);
    if (typeof s?.lastTestRun !== "number" || !s.lastTestRun) return null;
    return {
      lastTestRun: s.lastTestRun,
      command: typeof s.command === "string" ? s.command : void 0,
      ok: typeof s.ok === "boolean" ? s.ok : null
    };
  } catch {
    return null;
  }
}
var MAX_SIDECARS = 50;
function latestSidecar(repoRoot) {
  const dir = join2(repoRoot, ".claude", "cache", "e2e");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".log.json"));
  } catch {
    return null;
  }
  const newest = names.map((n) => {
    try {
      return { n, t: statSync(join2(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => b.t - a.t).slice(0, MAX_SIDECARS);
  let best = null;
  let bestAt = -Infinity;
  for (const { n } of newest) {
    try {
      const j = JSON.parse(readFileSync(join2(dir, n), "utf8"));
      const at = Date.parse(j.started);
      if (Number.isNaN(at) || at <= bestAt) continue;
      bestAt = at;
      best = {
        exit: typeof j.exit === "number" ? j.exit : null,
        started: typeof j.started === "string" ? j.started : null,
        finished: typeof j.finished === "string" ? j.finished : null,
        head: typeof j.head === "string" ? j.head : null,
        artifact: typeof j.artifact === "string" ? j.artifact : void 0
      };
    } catch {
    }
  }
  return best;
}
var sidecarAt = (s) => Date.parse(s.finished ?? s.started ?? "");
var SKEW_MS = MIN;
var fresh = (at, now, window) => now - at > -SKEW_MS && now - at < window;
function runProves(run, now) {
  return !!run && fresh(run.lastTestRun, now, PROOF_WINDOW_MS) && !isRatchet(run.command) && run.ok !== false;
}
var HEX_HEAD = /^[0-9a-f]{7,40}$/i;
function headMatches(sidecar, head) {
  return !!sidecar.head && !!head && HEX_HEAD.test(sidecar.head) && head.toLowerCase().startsWith(sidecar.head.toLowerCase());
}
function sidecarProves(s, head, now) {
  if (s.exit !== 0 || !s.finished) return false;
  return fresh(Date.parse(s.finished), now, PROOF_WINDOW_MS) && headMatches(s, head);
}
var shortCmd = (c) => (c ?? "unknown command").replace(/\s+/g, " ").slice(0, 120);
function failure(run, s, now) {
  const counted = run && !isRatchet(run.command) ? run : null;
  const sAt = s ? sidecarAt(s) : NaN;
  const sRecent = !!s && fresh(sAt, now, FAILURE_WINDOW_MS);
  const sidecarIsNewest = !counted || sAt >= counted.lastTestRun;
  if (s && sRecent && sidecarIsNewest && typeof s.exit === "number" && s.exit !== 0) {
    const message = `last verify exited ${s.exit} (${s.artifact ?? "no artifact"}): fix and re-run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: sAt };
  }
  const passedSince = !!s && s.exit === 0 && sAt > (counted?.lastTestRun ?? Infinity);
  if (counted && counted.ok === false && fresh(counted.lastTestRun, now, FAILURE_WINDOW_MS) && !passedSince) {
    const message = `last test run failed (${shortCmd(counted.command)}): fix it and re-run it, or run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: counted.lastTestRun };
  }
  if (s && sRecent && sidecarIsNewest && s.exit === null) {
    const message = `last verify (${s.artifact ?? "no artifact"}) is still running or was killed: let it finish or re-run ${VERIFY}`;
    return { verdict: { kind: "killed", message }, at: sAt };
  }
  return null;
}
function judge(i) {
  const { run, sidecar, head, now } = i;
  const proofAt = Math.max(
    runProves(run, now) ? run.lastTestRun : -Infinity,
    sidecar && sidecarProves(sidecar, head, now) ? sidecarAt(sidecar) : -Infinity
  );
  const bad = failure(run, sidecar, now);
  if (bad && bad.at > proofAt) return bad.verdict;
  if (proofAt > -Infinity) return { kind: "proven", message: "" };
  if (sidecar && sidecar.exit === 0 && sidecar.head && head && !headMatches(sidecar, head) && fresh(sidecarAt(sidecar), now, FAILURE_WINDOW_MS)) {
    return { kind: "stale", message: `verify ran on ${sidecar.head}, HEAD is ${head.slice(0, 7)}: re-run ${VERIFY}` };
  }
  if (!i.hasE2e) return { kind: "proven", message: "" };
  return {
    kind: "none",
    message: `no test run or verify sidecar in the last 5 minutes: run ${VERIFY} and cite its output`
  };
}

// src/shared/git-head.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { basename, dirname, isAbsolute, join as join3, resolve as resolve2 } from "path";
var SHA_RE = /^[0-9a-f]{40}$/i;
function read(path2) {
  try {
    return readFileSync2(path2, "utf8");
  } catch {
    return null;
  }
}
function findDotGit(start) {
  let dir = resolve2(start);
  for (; ; ) {
    if (existsSync2(join3(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function gitDirOf(root) {
  const dotGit = join3(root, ".git");
  if (statSync2(dotGit).isDirectory()) return dotGit;
  const m = (read(dotGit) ?? "").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = isAbsolute(m[1]) ? m[1] : resolve2(root, m[1]);
  return statSync2(target).isDirectory() ? target : null;
}
function commonDirOf(gitDir) {
  const rel = read(join3(gitDir, "commondir"))?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve2(gitDir, rel);
}
function shaOfBranch(branch, gitDir, commonDir) {
  for (const dir of /* @__PURE__ */ new Set([gitDir, commonDir])) {
    const loose = read(join3(dir, "refs", "heads", ...branch.split("/")))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = read(join3(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+?)\s*$/i);
    if (m && m[2] === branch) return m[1];
  }
  return null;
}
function resolveHead(dir) {
  try {
    if (!dir || !existsSync2(dir)) return null;
    const repoRoot = findDotGit(dir);
    if (!repoRoot) return null;
    const gitDir = gitDirOf(repoRoot);
    if (!gitDir) return null;
    const commonDir = commonDirOf(gitDir);
    const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : repoRoot;
    const head = read(join3(gitDir, "HEAD"))?.trim();
    if (!head) return null;
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { repoRoot, mainRoot, branch: ref[1], sha: shaOfBranch(ref[1], gitDir, commonDir) };
    if (SHA_RE.test(head)) return { repoRoot, mainRoot, branch: null, sha: head };
    return null;
  } catch {
    return null;
  }
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync, statSync as statSync3, renameSync } from "fs";
import { dirname as dirname2, join as join4 } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join4(homedir(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname2(LOG_FILE);
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
  if (!existsSync3(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync3(LOG_FILE)) {
      const stat = statSync3(LOG_FILE);
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

// src/test-before-done.ts
var log = createLogger("test-before-done");
function shouldWarn(input) {
  if (!input || typeof input !== "object") return false;
  if (input.tool_name !== "TaskUpdate") return false;
  if (!input.tool_input || typeof input.tool_input !== "object") return false;
  return input.tool_input.status === "completed";
}
function hasRecentTestRun(sessionId) {
  return runProves(readTestRun(sessionId), Date.now());
}
function buildWarningOutput(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message ?? "WARNING: no test run detected in the last 5 minutes before this task was marked complete. Run the project check (node ~/.claude/scripts/verify.mjs, or the AGENTS.md Testing row) and cite its output."
    }
  };
}
function handleTaskUpdate(input) {
  try {
    if (!shouldWarn(input)) return null;
    const sessionId = input.session_id;
    const head = resolveHead(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
    const verdict = judge({
      run: readTestRun(sessionId),
      sidecar: head ? latestSidecar(head.repoRoot) : null,
      head: head?.sha ?? null,
      hasE2e: true,
      now: Date.now()
    });
    if (verdict.kind === "proven") return null;
    log.info("No proof of a working change on task completion", { sessionId, verdict: verdict.kind });
    return verdict.kind === "none" ? buildWarningOutput() : buildWarningOutput(`WARNING: ${verdict.message}`);
  } catch (err) {
    log.error("handleTaskUpdate failed", { error: String(err) });
    return null;
  }
}
function main() {
  try {
    const raw = readFileSync3(0, "utf-8");
    if (!raw.trim()) {
      console.log(JSON.stringify({}));
      return;
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({}));
      return;
    }
    const result = handleTaskUpdate(input);
    if (result) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    console.log(JSON.stringify({}));
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  buildWarningOutput,
  handleTaskUpdate,
  hasRecentTestRun,
  shouldWarn
};
