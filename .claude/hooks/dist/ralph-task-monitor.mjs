#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/ralph-task-monitor.ts
import { readFileSync as readFileSync4, existsSync as existsSync4 } from "fs";
import { join as join5 } from "path";
import { spawnSync } from "child_process";

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
  function log3(level, msg, data) {
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
    debug: (msg, data) => log3("debug", msg, data),
    info: (msg, data) => log3("info", msg, data),
    warn: (msg, data) => log3("warn", msg, data),
    error: (msg, data) => log3("error", msg, data)
  };
}

// src/shared/state-schema.ts
import { existsSync as existsSync2, readFileSync } from "fs";
import { join as join2 } from "path";
var log = createLogger("state-schema");
function readRalphUnifiedState(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const statePath = join2(dir, ".ralph", "state.json");
  if (!existsSync2(statePath)) return null;
  try {
    const content = readFileSync(statePath, "utf-8");
    const state = JSON.parse(content);
    if (!state.version || !state.version.startsWith("2.")) {
      log.warn("Ralph unified state version mismatch (expected 2.x) \u2014 returning null", {
        version: state.version,
        statePath: join2(dir, ".ralph", "state.json")
      });
      return null;
    }
    return state;
  } catch (err) {
    log.warn("Failed to read Ralph unified state", { error: String(err) });
    return null;
  }
}

// src/shared/braintrust-score.ts
import { readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
var BRAINTRUST_FEEDBACK_TIMEOUT_MS = 2e3;
var DEFAULT_API_URL = "https://api.braintrust.dev";
var DEFAULT_PROJECT_NAME = "claude-code";
var projectIdCache = {};
var dotenvLoaded = false;
var envTraceOverride;
function loadClaudeDotEnv() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  envTraceOverride = process.env.TRACE_TO_BRAINTRUST;
  try {
    const envPath = process.env.BRAINTRUST_DOTENV_PATH || join3(homedir2(), ".claude", ".env");
    for (const line of readFileSync2(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) process.env[key] = value;
    }
  } catch {
  }
}
function getApiUrl() {
  loadClaudeDotEnv();
  return process.env.BRAINTRUST_API_URL || DEFAULT_API_URL;
}
function getApiKey() {
  loadClaudeDotEnv();
  const key = process.env.BRAINTRUST_API_KEY;
  return key && key.length > 0 ? key : null;
}
function isTraceEnabled() {
  loadClaudeDotEnv();
  const effective = envTraceOverride !== void 0 ? envTraceOverride : process.env.TRACE_TO_BRAINTRUST || "";
  return effective.toLowerCase() === "true";
}
async function consumeBody(resp) {
  try {
    await resp.arrayBuffer();
  } catch {
  }
}
function logErr(msg) {
  try {
    process.stderr.write(`[braintrust-score] ${msg}
`);
  } catch {
  }
}
async function resolveProjectId(apiKey) {
  loadClaudeDotEnv();
  const directId = process.env.BRAINTRUST_CC_PROJECT_ID;
  if (directId && directId.length > 0) {
    return directId;
  }
  const projectName = process.env.BRAINTRUST_CC_PROJECT || DEFAULT_PROJECT_NAME;
  const cached = projectIdCache[projectName];
  if (cached) return cached;
  try {
    const url = getApiUrl() + "/v1/project?project_name=" + encodeURIComponent(projectName);
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(BRAINTRUST_FEEDBACK_TIMEOUT_MS)
    });
    if (!resp.ok) {
      logErr(`project lookup ${projectName}: HTTP ${resp.status}`);
      await consumeBody(resp);
      return null;
    }
    const data = await resp.json();
    const objects = data?.objects;
    if (!objects || objects.length === 0) {
      logErr(`project lookup ${projectName}: no objects`);
      return null;
    }
    const id = objects[0]?.id;
    if (!id) {
      logErr(`project lookup ${projectName}: object missing id`);
      return null;
    }
    projectIdCache[projectName] = id;
    return id;
  } catch (e) {
    logErr(`project lookup ${projectName} failed: ${e.message}`);
    return null;
  }
}
async function emitBraintrustScore(opts) {
  try {
    if (!isTraceEnabled()) return;
    const apiKey = getApiKey();
    if (!apiKey) return;
    if (!opts.spanId || opts.spanId.length === 0) return;
    if (!opts.scores || Object.keys(opts.scores).length === 0) return;
    const projectId = await resolveProjectId(apiKey);
    if (!projectId) return;
    const entry = {
      id: opts.spanId,
      scores: opts.scores
    };
    if (opts.metadata !== void 0) {
      entry.metadata = opts.metadata;
    }
    if (opts.comment !== void 0) {
      entry.comment = opts.comment;
    }
    const url = `${getApiUrl()}/v1/project_logs/${projectId}/feedback`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ feedback: [entry] }),
        signal: AbortSignal.timeout(BRAINTRUST_FEEDBACK_TIMEOUT_MS)
      });
      if (!resp.ok) {
        logErr(`feedback POST ${opts.spanId}: HTTP ${resp.status}`);
      }
      await consumeBody(resp);
    } catch (e) {
      logErr(`feedback POST ${opts.spanId} failed: ${e.message}`);
    }
  } catch (e) {
    logErr(`unexpected error: ${e.message}`);
  }
}

// src/shared/braintrust-span.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4 } from "path";
function readBraintrustSessionState(sessionId) {
  if (!sessionId) return null;
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir3();
    if (!homeDir) return null;
    const statePath = join4(homeDir, ".claude", "state", "braintrust_sessions", `${sessionId}.json`);
    if (!existsSync3(statePath)) return null;
    return JSON.parse(readFileSync3(statePath, "utf-8"));
  } catch {
    return null;
  }
}
function resolveBraintrustSpan(sessionId) {
  const state = readBraintrustSessionState(sessionId);
  if (!state) return null;
  if (state.sampled_out) return null;
  if (state.current_turn_span_id && state.current_turn_span_id.length > 0) {
    return { spanId: state.current_turn_span_id, attachedTo: "turn" };
  }
  if (state.root_span_id && state.root_span_id.length > 0) {
    return { spanId: state.root_span_id, attachedTo: "root" };
  }
  return null;
}
function resolveBraintrustSpanId(sessionId) {
  return resolveBraintrustSpan(sessionId)?.spanId ?? "";
}

// src/ralph-task-monitor.ts
var log2 = createLogger("ralph-task-monitor");
var STRUCTURED_JSON_RE = /\{"ralph_status"\s*:\s*\{[^}]+\}\s*\}/;
var XML_TASK_COMPLETE_RE = /<TASK_COMPLETE\s+task="(\d+(?:\.\d+)?)"\s*(?:commit="([^"]*)")?\s*\/?>/i;
var XML_TASK_FAIL_RE = /<TASK_FAIL\s+task="(\d+(?:\.\d+)?)"\s*(?:error="([^"]*)")?\s*\/?>/i;
var SUCCESS_PATTERNS = [
  /task\s+(?:is\s+)?complete/i,
  /implementation\s+(?:is\s+)?complete/i,
  /all\s+tests?\s+pass/i,
  /successfully\s+(?:implemented|completed|created|fixed)/i,
  /changes?\s+(?:have been|were)\s+(?:made|applied|committed)/i,
  /<TASK_COMPLETE\s*\/?>/i,
  /<COMPLETE\s*\/?>/i
];
var TASK_ID_PATTERN = /(?:task_id|Task ID|Task|task)[:\s_-]*(\d+(?:\.\d+)?)/i;
var FAILURE_PATTERNS = [
  /(?:test|build|compilation)\s+(?:failed|failing|errors?)/i,
  /could\s+not\s+(?:complete|fix|resolve)/i,
  /blocked\s+(?:by|on|due)/i,
  /<BLOCKED(?:\s+reason="([^"]+)")?\s*\/?>/i,
  /<ERROR(?:\s+reason="([^"]+)")?\s*\/?>/i,
  /unable\s+to\s+(?:complete|resolve|implement)/i
];
function readStdin() {
  try {
    return readFileSync4(0, "utf-8");
  } catch {
    return "{}";
  }
}
function computeAgentTaskScore(input) {
  if (input.transition === "failed") return 0;
  const retries = typeof input.retries === "number" ? input.retries : 0;
  return retries === 0 ? 1 : 0.5;
}
function buildAgentTaskScorePayload(input) {
  const spanId = resolveBraintrustSpanId(input.sessionId || "");
  if (!spanId) return null;
  const score = computeAgentTaskScore(input);
  return {
    spanId,
    scores: {
      agent_task_success: score
    },
    metadata: {
      task_id: input.taskId,
      task_name: input.taskName || "",
      agent: input.agent || "unknown",
      retries: typeof input.retries === "number" ? input.retries : 0,
      duration_s: typeof input.durationS === "number" ? input.durationS : 0,
      transition: input.transition,
      hook: "ralph-task-monitor"
    }
  };
}
function readRalphTaskById(projectDir, taskId) {
  const state = readRalphUnifiedState(projectDir);
  if (!state || !Array.isArray(state.tasks)) return null;
  const task = state.tasks.find((t) => String(t.id) === String(taskId));
  if (!task) return null;
  return {
    id: String(task.id),
    status: String(task.status),
    name: typeof task.name === "string" ? task.name : void 0,
    agent: typeof task.agent === "string" ? task.agent : void 0,
    retries: typeof task.retries === "number" ? task.retries : void 0,
    duration_s: typeof task.duration_s === "number" ? task.duration_s : void 0
  };
}
var currentSessionId = "";
async function emitRalphTaskScore(projectDir, taskId, transition, fallbackAgent) {
  try {
    const task = readRalphTaskById(projectDir, taskId);
    const payload = buildAgentTaskScorePayload({
      taskId,
      taskName: task?.name,
      agent: task?.agent || fallbackAgent,
      retries: task?.retries,
      durationS: task?.duration_s,
      transition,
      sessionId: currentSessionId
    });
    if (payload) {
      await emitBraintrustScore(payload);
    }
  } catch {
  }
}
function detectStructuredJSON(text) {
  const match = text.match(STRUCTURED_JSON_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const status = parsed.ralph_status;
    if (!status || !status.task_id || !status.status) return null;
    const result = {
      taskId: status.task_id,
      success: status.status === "complete",
      commit: status.commit,
      reason: status.error || (status.status === "failed" ? "Agent reported failure" : void 0)
    };
    if (status.deploy_status !== void 0 && status.deploy_status !== null) {
      result.deploy_status = status.deploy_status;
    }
    return result;
  } catch {
    return null;
  }
}
function detectXMLStatus(text) {
  const completeMatch = text.match(XML_TASK_COMPLETE_RE);
  if (completeMatch) {
    return {
      taskId: completeMatch[1],
      success: true,
      commit: completeMatch[2] || void 0
    };
  }
  const failMatch = text.match(XML_TASK_FAIL_RE);
  if (failMatch) {
    return {
      taskId: failMatch[1],
      success: false,
      reason: failMatch[2] || "Agent reported failure"
    };
  }
  return null;
}
function detectOutcome(text) {
  for (const pattern of FAILURE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { success: false, reason: match[1] || match[0] };
    }
  }
  for (const pattern of SUCCESS_PATTERNS) {
    if (pattern.test(text)) {
      return { success: true };
    }
  }
  return null;
}
function getV2ScriptPath() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const v2Script = join5(homeDir, ".claude", "scripts", "ralph", "ralph-state-v2.py");
  return existsSync4(v2Script) ? v2Script : null;
}
async function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }
  currentSessionId = input.session_id || "";
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const unified = readRalphUnifiedState(projectDir);
  if (!unified?.session?.active) return;
  const v2Script = getV2ScriptPath();
  if (!v2Script) return;
  const resultText = input.tool_result?.stdout || input.tool_result?.content || input.tool_result?.text || "";
  if (!resultText) return;
  const agentType = input.tool_input?.subagent_type || "unknown";
  const description = input.tool_input?.description || "";
  const agentPrompt = String(input.tool_input?.prompt || "");
  const structuredResult = detectStructuredJSON(resultText);
  if (structuredResult) {
    log2.info(`Structured status detected for task ${structuredResult.taskId}`, { agentType, method: "json" });
    const commitArgs = structuredResult.commit ? ["--commit", structuredResult.commit] : [];
    if (structuredResult.success) {
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-complete",
        "--id",
        structuredResult.taskId,
        ...commitArgs
      ], { encoding: "utf-8", timeout: 5e3 });
    } else {
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-fail",
        "--id",
        structuredResult.taskId,
        "--error",
        structuredResult.reason || "Agent reported failure"
      ], { encoding: "utf-8", timeout: 5e3 });
    }
    await emitRalphTaskScore(
      projectDir,
      structuredResult.taskId,
      structuredResult.success ? "complete" : "failed",
      agentType
    );
    const marker = structuredResult.success ? "complete" : `failed: ${structuredResult.reason || "unknown"}`;
    const deployInfo = structuredResult.deploy_status ? ` [deploy: ${structuredResult.deploy_status}]` : "";
    const message2 = `
RALPH TASK MONITOR: ${agentType} -> task ${structuredResult.taskId} ${marker}${deployInfo} (structured JSON)
`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message2 } }));
    return;
  }
  {
    let parsed = null;
    try {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
    }
    if (parsed && (parsed.status === "success" || parsed.status === "complete")) {
      const listResult2 = spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-list"
      ], { encoding: "utf-8", timeout: 5e3 });
      if (listResult2.status === 0) {
        let allTasks2 = [];
        try {
          allTasks2 = JSON.parse(listResult2.stdout).tasks || [];
        } catch {
        }
        const inProgressTasks2 = allTasks2.filter((t) => t.status === "in_progress");
        if (inProgressTasks2.length === 1) {
          const task = inProgressTasks2[0];
          const taskId = String(task.id);
          log2.info(`Generic JSON success detected, auto-completing single in-progress task ${taskId}`, { agentType, method: "json-fallback" });
          spawnSync("python", [
            v2Script,
            "-p",
            projectDir,
            "task-complete",
            "--id",
            taskId
          ], { encoding: "utf-8", timeout: 5e3 });
          await emitRalphTaskScore(projectDir, taskId, "complete", agentType);
          const message2 = `
RALPH TASK MONITOR: ${agentType} -> task ${taskId} complete (generic JSON status)
`;
          console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message2 } }));
          return;
        } else if (inProgressTasks2.length > 1) {
          log2.info(`Generic JSON success found but ${inProgressTasks2.length} in-progress tasks \u2014 skipping (ambiguous)`, { agentType });
        }
      }
    }
  }
  const xmlResult = detectXMLStatus(resultText);
  if (xmlResult) {
    log2.info(`XML status detected for task ${xmlResult.taskId}`, { agentType, method: "xml" });
    const commitArgs = xmlResult.commit ? ["--commit", xmlResult.commit] : [];
    if (xmlResult.success) {
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-complete",
        "--id",
        xmlResult.taskId,
        ...commitArgs
      ], { encoding: "utf-8", timeout: 5e3 });
    } else {
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-fail",
        "--id",
        xmlResult.taskId,
        "--error",
        xmlResult.reason || "Agent reported failure"
      ], { encoding: "utf-8", timeout: 5e3 });
    }
    await emitRalphTaskScore(
      projectDir,
      xmlResult.taskId,
      xmlResult.success ? "complete" : "failed",
      agentType
    );
    const marker = xmlResult.success ? "complete" : `failed: ${xmlResult.reason || "unknown"}`;
    const message2 = `
RALPH TASK MONITOR: ${agentType} -> task ${xmlResult.taskId} ${marker} (XML tag)
`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message2 } }));
    return;
  }
  const outcome = detectOutcome(resultText);
  if (!outcome) {
    log2.info("No clear outcome detected from agent", { agentType, description });
    return;
  }
  const listResult = spawnSync("python", [
    v2Script,
    "-p",
    projectDir,
    "task-list"
  ], { encoding: "utf-8", timeout: 5e3 });
  if (listResult.status !== 0) return;
  let allTasks = [];
  try {
    const parsed = JSON.parse(listResult.stdout);
    allTasks = parsed.tasks || [];
  } catch {
    return;
  }
  const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");
  if (inProgressTasks.length === 0) {
    log2.info("No in-progress tasks to update", { agentType });
    return;
  }
  const taskIdMatch = agentPrompt.match(TASK_ID_PATTERN);
  const extractedTaskId = taskIdMatch ? taskIdMatch[1] : null;
  let tasksToUpdate;
  if (extractedTaskId) {
    const matched = inProgressTasks.filter((t) => String(t.id) === extractedTaskId);
    if (matched.length > 0) {
      tasksToUpdate = matched;
      log2.info(`Matched agent to task ${extractedTaskId} via prompt`, { agentType });
    } else {
      log2.warn(`Task ID ${extractedTaskId} from prompt not found in in_progress tasks`, { agentType });
      return;
    }
  } else if (inProgressTasks.length === 1) {
    tasksToUpdate = inProgressTasks;
  } else {
    const byAgent = inProgressTasks.filter((t) => t.agent === agentType);
    if (byAgent.length === 1) {
      tasksToUpdate = byAgent;
      log2.info(`Matched task ${byAgent[0].id} via agent type fallback`, { agentType });
    } else {
      log2.warn(`Ambiguous: ${inProgressTasks.length} in_progress tasks, no task ID in prompt. Skipping update.`, { agentType });
      return;
    }
  }
  for (const task of tasksToUpdate) {
    const taskId = String(task.id);
    if (outcome.success) {
      log2.info(`Agent completed task ${taskId}`, { agentType, taskName: task.name });
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-complete",
        "--id",
        taskId
      ], { encoding: "utf-8", timeout: 5e3 });
    } else {
      log2.warn(`Agent failed task ${taskId}`, { agentType, reason: outcome.reason, taskName: task.name });
      spawnSync("python", [
        v2Script,
        "-p",
        projectDir,
        "task-fail",
        "--id",
        taskId,
        "--error",
        outcome.reason || "Agent reported failure"
      ], { encoding: "utf-8", timeout: 5e3 });
    }
    await emitRalphTaskScore(
      projectDir,
      taskId,
      outcome.success ? "complete" : "failed",
      agentType
    );
  }
  const statusLines = [
    "",
    "-".repeat(40),
    `RALPH TASK MONITOR: ${agentType} agent ${outcome.success ? "completed" : "failed"} (pattern match)`,
    "-".repeat(40)
  ];
  for (const task of tasksToUpdate) {
    const taskId = String(task.id);
    if (outcome.success) {
      statusLines.push(`  Task ${taskId} marked complete`);
    } else {
      statusLines.push(`  Task ${taskId} marked failed: ${outcome.reason || "unknown"}`);
    }
  }
  statusLines.push("-".repeat(40));
  const message = statusLines.join("\n");
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } }));
}
if (!process.env.VITEST) {
  main().catch(() => {
  });
}
export {
  buildAgentTaskScorePayload,
  computeAgentTaskScore
};
