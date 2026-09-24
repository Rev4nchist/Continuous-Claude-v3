#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/plan-exit-premortem-prompt.ts
import { readFileSync as readFileSync2 } from "fs";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var LOG_DIR = join(homedir(), ".claude", "logs");
var LOG_FILE = join(LOG_DIR, "hooks.log");
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

// src/shared/session-activity.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
function getActivityPath(sessionId) {
  const dir = join2(getHomeDir(), ".claude", "cache", "session-activity");
  try {
    mkdirSync2(dir, { recursive: true });
  } catch {
  }
  return join2(dir, `${sessionId}.json`);
}
function readActivity(sessionId) {
  const filePath = getActivityPath(sessionId);
  try {
    if (!existsSync2(filePath)) {
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
function logHook(sessionId, hookName) {
  const activity = loadOrCreate(sessionId);
  upsertEntry(activity.hooks, hookName);
  const filePath = getActivityPath(sessionId);
  writeFileSync(filePath, JSON.stringify(activity), { encoding: "utf-8" });
}

// src/plan-exit-premortem-prompt.ts
var log = createLogger("plan-exit-premortem-prompt");
function extractPlanPath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const candidates = [toolInput.planPath, toolInput.plan_path, toolInput.path, toolInput.plan];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (trimmed.length > 500) continue;
    if (trimmed.includes("\n")) continue;
    const looksLikePath = trimmed.endsWith(".md") || trimmed.includes("/") || trimmed.includes("\\");
    if (!looksLikePath) continue;
    return trimmed;
  }
  return null;
}
function buildDirective(planPath) {
  const planClause = planPath ? `A plan was just approved (at \`${planPath}\`).` : "A plan was just approved.";
  return [
    `${planClause} Before proceeding to implementation, use the \`AskUserQuestion\` tool to ask the user:`,
    "",
    '  Question: "Run a cross-model /premortem on this plan before implementation? Pick the adversarial reviewer(s)."',
    '  Header: "Premortem"',
    "  Options:",
    '    - "Codex (Recommended)" (description: "GPT-family adversarial pass on the plan (ChatGPT subscription). The proven default.")',
    '    - "Grok" (description: "Grok adversarial pass on the plan (X Premium+ subscription). A third training family, distinct from Codex AND Claude. PARKED on this machine since 2026-07-13: corp egress stalls completions.")',
    '    - "Both -- Codex + Grok in parallel" (description: "Maximum cross-model coverage; two parallel passes, findings merged with [Codex]/[Grok] source tags. Double quota burn.")',
    '    - "Skip -- proceed to implementation" (description: "Move directly to implementation without an explicit risk pass. Use when the plan is trivial or already heavily vetted.")',
    "",
    "After the user answers: Codex -> invoke the `/premortem` skill on the plan file (default Codex pass); Grok -> invoke `/premortem --grok`; Both -> invoke `/premortem --reviewers both`; Skip -> continue with whatever next step the workflow calls for."
  ].join("\n");
}
function handlePlanExitPrompt(input, env = process.env) {
  try {
    if (!input || typeof input !== "object") return {};
    if (input.tool_name !== "ExitPlanMode") return {};
    if (env.CLAUDE_AGENT_ID || env.CI === "true" || env.CI === "1") return {};
    const planPath = extractPlanPath(input.tool_input);
    const additionalContext = buildDirective(planPath);
    try {
      logHook(input.session_id || "unknown", "plan-exit-premortem-prompt");
    } catch {
    }
    log.info("Premortem prompt injected", {
      sessionId: input.session_id || "unknown",
      hasPlanPath: planPath !== null
    });
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext
      }
    };
  } catch (err) {
    log.error("handlePlanExitPrompt failed", { error: String(err) });
    return {};
  }
}
function main() {
  try {
    const raw = readFileSync2(0, "utf-8");
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
    const response = handlePlanExitPrompt(input);
    console.log(JSON.stringify(response));
  } catch {
    console.log(JSON.stringify({}));
  }
}
if (!process.env.VITEST) {
  main();
}
export {
  buildDirective,
  extractPlanPath,
  handlePlanExitPrompt
};
