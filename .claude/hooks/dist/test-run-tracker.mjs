#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/test-run-tracker.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  /\bmake\s+test\b/
];
function getStateFile(sessionId) {
  return path.join(os.tmpdir(), `claude-recent-test-runs-${sessionId}.json`);
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
  if (data.tool_name !== "Bash") {
    console.log(JSON.stringify({}));
    return;
  }
  const command = data.tool_input?.command || "";
  const isTestCommand = TEST_PATTERNS.some((p) => p.test(command));
  if (isTestCommand) {
    const sessionId = data.session_id || "default";
    const stateFile = getStateFile(sessionId);
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
