#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/telemetry-tracker.ts
import { readFileSync as readFileSync4, appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync2 } from "fs";
import { join as join4 } from "path";

// src/shared/session-activity.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
  }
  return join(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function loadOrCreate(sessionId) {
  const existing = readActivity(sessionId);
  if (existing) {
    if (!existing.agents) existing.agents = [];
    if (!existing.mcp_servers) existing.mcp_servers = [];
    return existing;
  }
  return {
    session_id: sessionId,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    skills: [],
    hooks: [],
    agents: [],
    mcp_servers: []
  };
}
function upsertEntry(entries, name) {
  const existing = entries.find((e) => e.name === name);
  if (existing) {
    existing.count++;
  } else {
    entries.push({
      name,
      first_seen: (/* @__PURE__ */ new Date()).toISOString(),
      count: 1
    });
  }
}
function logSkill(sessionId, skillName) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.skills, skillName);
  const filePath = getActivityPath(sessionId);
  writeFileSync(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}
function logAgent(sessionId, agentType) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.agents, agentType);
  const filePath = getActivityPath(sessionId);
  writeFileSync(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/shared/braintrust-score.ts
import { readFileSync as readFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";
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
    const envPath = process.env.BRAINTRUST_DOTENV_PATH || join2(homedir(), ".claude", ".env");
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
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
function readBraintrustSessionState(sessionId) {
  if (!sessionId) return null;
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir2();
    if (!homeDir) return null;
    const statePath = join3(homeDir, ".claude", "state", "braintrust_sessions", `${sessionId}.json`);
    if (!existsSync2(statePath)) return null;
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

// src/telemetry-tracker.ts
function getTelemetryPath() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const telemetryDir = join4(homeDir, ".claude", "cache");
  if (!existsSync3(telemetryDir)) {
    mkdirSync2(telemetryDir, { recursive: true });
  }
  return join4(telemetryDir, "skill-telemetry.jsonl");
}
function logEvent(event) {
  const telemetryPath = getTelemetryPath();
  const line = JSON.stringify(event) + "\n";
  appendFileSync(telemetryPath, line, "utf-8");
}
function determineSource(toolInput) {
  const skill = toolInput.skill || "";
  if (skill.startsWith("/")) {
    return "explicit";
  }
  return "llm";
}
function resolveScoreSpanId(payloadSessionId) {
  return resolveBraintrustSpanId(payloadSessionId || "");
}
function buildToolResponseKeys(toolResponse) {
  if (toolResponse === null || toolResponse === void 0) return [];
  if (typeof toolResponse !== "object") return [];
  return Object.keys(toolResponse);
}
function buildSkillTriggerScorePayload(input) {
  const spanId = resolveScoreSpanId(input.sessionId);
  if (!spanId) return null;
  return {
    spanId,
    scores: {
      skill_trigger_accuracy: input.success ? 1 : 0
    },
    metadata: {
      skill_name: input.skillName,
      trigger_source: input.triggerSource,
      hook: "telemetry-tracker"
    }
  };
}
async function main() {
  try {
    const input = readFileSync4(0, "utf-8");
    const data = JSON.parse(input);
    if (data.tool_name === "Skill") {
      const skillName = data.tool_input?.skill || "unknown";
      const success = !detectToolError(data.tool_response);
      const toolResponseKeys = buildToolResponseKeys(data.tool_response);
      const event = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        session_id: data.session_id,
        type: "skill_used",
        name: skillName,
        trigger_source: determineSource(data.tool_input),
        success,
        tool_response_keys: toolResponseKeys
      };
      logEvent(event);
      try {
        logSkill(data.session_id, skillName);
      } catch {
      }
      try {
        const payload = buildSkillTriggerScorePayload({
          sessionId: data.session_id,
          skillName,
          triggerSource: determineSource(data.tool_input),
          success
        });
        if (payload) {
          await emitBraintrustScore(payload);
        }
      } catch {
      }
    } else if (data.tool_name === "Task") {
      const agentType = data.tool_input?.subagent_type || "unknown";
      const success = !detectToolError(data.tool_response);
      const toolResponseKeys = buildToolResponseKeys(data.tool_response);
      const event = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        session_id: data.session_id,
        type: "agent_spawned",
        name: agentType,
        trigger_source: "llm",
        success,
        tool_response_keys: toolResponseKeys
      };
      logEvent(event);
      try {
        logAgent(data.session_id, agentType);
      } catch {
      }
    }
  } catch {
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  buildSkillTriggerScorePayload,
  buildToolResponseKeys,
  resolveScoreSpanId
};
