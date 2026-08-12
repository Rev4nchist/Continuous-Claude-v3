import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/hook-health-monitor.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// src/shared/braintrust-score.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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
    const envPath = process.env.BRAINTRUST_DOTENV_PATH || join(homedir(), ".claude", ".env");
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
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
import { existsSync, readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
function readBraintrustSessionState(sessionId) {
  if (!sessionId) return null;
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir2();
    if (!homeDir) return null;
    const statePath = join2(homeDir, ".claude", "state", "braintrust_sessions", `${sessionId}.json`);
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync2(statePath, "utf-8"));
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

// src/hook-health-monitor.ts
function parseHookCommands(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group.hooks || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook.type !== "command" || !hook.command) continue;
        const commandLine = [hook.command, ...hook.args || []].join(" ");
        const distPath = extractDistPath(commandLine);
        if (!distPath) continue;
        if (seen.has(distPath)) continue;
        seen.add(distPath);
        const hookName = path.basename(distPath, ".mjs");
        const srcPath = deriveSrcPath(distPath);
        results.push({
          distPath,
          srcPath,
          hookEvent: eventName,
          hookName,
          matcher: group.matcher
        });
      }
    }
  }
  return results;
}
function extractDistPath(command) {
  const match = command.match(/^node\s+(.+\.mjs)\s*$/);
  if (!match) return null;
  let filePath = match[1].trim();
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("hooks/dist/")) return null;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    filePath = path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
function deriveSrcPath(distPath) {
  const normalized = distPath.replace(/\\/g, "/");
  const srcPath = normalized.replace("/hooks/dist/", "/hooks/src/").replace(/\.mjs$/, ".ts");
  return srcPath;
}
function checkHookHealth(hookInfo) {
  const { distPath, srcPath, hookEvent, hookName } = hookInfo;
  if (!fs.existsSync(distPath)) {
    return { hookName, status: "missing", hookEvent };
  }
  if (!fs.existsSync(srcPath)) {
    return { hookName, status: "healthy", hookEvent };
  }
  const distMtime = fs.statSync(distPath).mtime.getTime();
  const srcMtime = fs.statSync(srcPath).mtime.getTime();
  if (srcMtime > distMtime) {
    return { hookName, status: "stale", hookEvent };
  }
  return { hookName, status: "healthy", hookEvent };
}
function buildHookHealthRatioPayload(input) {
  const { results, spanId } = input;
  if (!spanId || spanId.length === 0) return null;
  const total = results.length;
  if (total === 0) return null;
  const missing = results.filter((r) => r.status === "missing");
  const registered = total - missing.length;
  const ratio = registered / total;
  const missingList = missing.slice(0, 10).map((r) => r.hookName);
  return {
    spanId,
    scores: {
      hook_health_ratio: ratio
    },
    metadata: {
      registered,
      total,
      missing_list: missingList,
      hook: "hook-health-monitor"
    }
  };
}
function formatHealthReport(results) {
  if (results.length === 0) {
    return "Hook Health: No hooks registered";
  }
  const healthy = results.filter((r) => r.status === "healthy");
  const issues = results.filter((r) => r.status !== "healthy");
  if (issues.length === 0) {
    return `Hook Health: All ${results.length} hooks healthy`;
  }
  const lines = [];
  const issueWord = issues.length === 1 ? "issue" : "issues";
  lines.push(`Hook Health: ${healthy.length}/${results.length} healthy, ${issues.length} ${issueWord} found`);
  for (const issue of issues) {
    if (issue.status === "missing") {
      lines.push(`- MISSING: ${issue.hookName}.mjs (fix: npm run build)`);
    } else if (issue.status === "stale") {
      lines.push(`- STALE: ${issue.hookName}.mjs (src newer than dist, fix: npm run build)`);
    }
  }
  return lines.join("\n");
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
async function main() {
  let input;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: "unknown" };
  } catch {
    input = { session_id: "unknown" };
  }
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME || "";
    const settingsPath = path.join(userProfile, ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    let settings;
    try {
      const content = fs.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      console.error("hook-health-monitor: Could not parse settings.json");
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const hookFiles = parseHookCommands(settings);
    if (hookFiles.length === 0) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const results = hookFiles.map((hf) => checkHookHealth(hf));
    try {
      const spanId = resolveBraintrustSpanId(input.session_id || "");
      const payload = buildHookHealthRatioPayload({ results, spanId });
      if (payload) {
        await emitBraintrustScore(payload);
      }
    } catch {
    }
    const report = formatHealthReport(results);
    const hasIssues = results.some((r) => r.status !== "healthy");
    const output = { result: "continue" };
    if (hasIssues) {
      output.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: report
      };
      console.error(report);
    } else {
      console.error(`Hook Health: All ${results.length} hooks healthy`);
    }
    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(`hook-health-monitor error: ${err}`);
    console.log(JSON.stringify({ result: "continue" }));
  }
}
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ result: "continue" }));
  });
}
export {
  buildHookHealthRatioPayload,
  checkHookHealth,
  formatHealthReport,
  parseHookCommands
};
