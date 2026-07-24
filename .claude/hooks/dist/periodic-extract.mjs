// src/periodic-extract.ts
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
var INTERVAL = 50;
function loadState(stateFile) {
  const defaults = { count: 0, lastExtract: 0, tools: [] };
  try {
    const raw = readFileSync(stateFile, "utf-8");
    if (!raw.trim()) return defaults;
    const parsed = JSON.parse(raw);
    return {
      count: typeof parsed.count === "number" ? parsed.count : 0,
      lastExtract: typeof parsed.lastExtract === "number" ? parsed.lastExtract : 0,
      tools: Array.isArray(parsed.tools) ? parsed.tools : []
    };
  } catch {
    return defaults;
  }
}
function saveState(stateFile, state) {
  try {
    writeFileSync(stateFile, JSON.stringify(state));
  } catch {
  }
}
function trackTool(state, toolName, interval) {
  const tools = [...state.tools, toolName];
  return {
    count: state.count + 1,
    lastExtract: state.lastExtract,
    tools: tools.length > interval ? tools.slice(-interval) : tools
  };
}
function shouldExtract(state, interval) {
  return state.count > 0 && state.count % interval === 0;
}
function buildSummary(tools) {
  if (tools.length === 0) return "";
  const counts = {};
  for (const t of tools) {
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => `${name}(${count})`).join(", ");
}
function buildLearningContent(state, sessionId) {
  const summary = buildSummary(state.tools);
  const activity = summary ? ` Recent activity: ${summary}.` : "";
  return `Mid-session checkpoint at ${state.count} tool uses.${activity} Session ${sessionId}.`;
}
function buildOutput(state, extracted) {
  if (!extracted) return {};
  return {
    values: {
      system: `Periodic extraction checkpoint: ${state.count} tool uses this session.`
    }
  };
}
async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  const rawSessionId = data.session_id || "unknown";
  const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const toolName = data.tool_name || "";
  const stateFile = join(tmpdir(), `claude-periodic-extract-${sessionId}.json`);
  let state = loadState(stateFile);
  state = trackTool(state, toolName, INTERVAL);
  if (!shouldExtract(state, INTERVAL)) {
    saveState(stateFile, state);
    console.log(JSON.stringify({}));
    return;
  }
  state.lastExtract = Date.now();
  saveState(stateFile, state);
  console.log(JSON.stringify(buildOutput(state, true)));
}
if (!process.env.VITEST) {
  main().catch(() => {
    console.log(JSON.stringify({}));
  });
}
export {
  INTERVAL,
  buildLearningContent,
  buildOutput,
  buildSummary,
  loadState,
  saveState,
  shouldExtract,
  trackTool
};
