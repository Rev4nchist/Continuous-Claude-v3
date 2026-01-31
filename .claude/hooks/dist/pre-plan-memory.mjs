#!/usr/bin/env node

// src/pre-plan-memory.ts
import { execSync } from "child_process";
import * as path from "path";
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1e3);
  });
}
function output(obj) {
  console.log(JSON.stringify(obj));
}
async function main() {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    output({ decision: "allow" });
    return;
  }
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    output({ decision: "allow" });
    return;
  }
  if (input.tool_name !== "EnterPlanMode") {
    output({ decision: "allow" });
    return;
  }
  const opcDir = process.env.CLAUDE_OPC_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
  try {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? `cd /d "${opcDir}" && set PYTHONPATH=. && uv run python scripts/core/recall_learnings.py --query "planning architecture decisions approach design" --k 5 --text-only` : `cd "${opcDir}" && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "planning architecture decisions approach design" --k 5 --text-only`;
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindows ? "cmd.exe" : true
    });
    if (result && !result.includes("No results") && result.trim().length > 20) {
      const truncated = result.substring(0, 1500);
      console.error("\u{1F9E0} Found relevant past planning context");
      output({
        decision: "allow",
        message: "\u{1F9E0} Relevant past planning found",
        hookSpecificOutput: {
          additionalContext: `## Prior Planning Context

The following past planning decisions may be relevant:

${truncated}`
        }
      });
      return;
    }
  } catch (e) {
    const err = e;
    console.error(`Pre-plan memory recall failed: ${err.message}`);
  }
  output({ decision: "allow" });
}
main().catch(() => output({ decision: "allow" }));
