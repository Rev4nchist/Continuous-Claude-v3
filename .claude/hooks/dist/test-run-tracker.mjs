#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/test-run-tracker.ts
import * as fs from "fs";

// src/shared/test-run-state.ts
import * as os from "os";
import * as path from "path";
function getStateFile(sessionId) {
  const safe = (sessionId || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(os.tmpdir(), `claude-recent-test-runs-${safe}.json`);
}

// src/test-run-tracker.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
function nodeScript(name) {
  const flag = String.raw`\s+(?!--check\b|-c\b)--?[\w-]+(?:=\S+)?`;
  const dir = String.raw`["']?(?:[^\s"']*[\\/])?`;
  const notPlan = String.raw`(?![^\n]*--(?:dry-run|help)\b)`;
  return new RegExp(String.raw`\bnode(?:\.exe)?(?:${flag})*\s+${dir}${name}\.mjs\b${notPlan}`);
}
var TEST_PATTERNS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bnpm\s+test\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmocha\b/,
  /\bnpm\s+run\s+test\b/,
  /\bpnpm\s+test\b/,
  /\byarn\s+test\b/,
  /\bmake\s+test\b/,
  // Probes, ratchets and the verify entry point are test runs (PR1a, 2026-10-06).
  nodeScript("[\\w.-]+-probe"),
  nodeScript("audit-skills"),
  nodeScript("context-budget-guard"),
  nodeScript("verify")
];
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
  if (!input.trim()) {
    console.log(JSON.stringify({}));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  if (!COMMAND_TOOLS.has(data.tool_name)) {
    console.log(JSON.stringify({}));
    return;
  }
  const command = data.tool_input?.command || "";
  const isTestCommand = TEST_PATTERNS.some((p) => p.test(command));
  if (isTestCommand) {
    const stateFile = getStateFile(data.session_id);
    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ lastTestRun: Date.now(), command })
      );
    } catch {
    }
  }
  console.log(JSON.stringify({}));
}
if (!process.env.VITEST) {
  main().catch(() => {
    console.log(JSON.stringify({}));
  });
}
export {
  TEST_PATTERNS,
  getStateFile,
  main
};
