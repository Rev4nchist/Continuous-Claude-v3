#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-plan-memory.ts
import { execSync } from "child_process";
import * as path from "path";

// src/shared/memory-sanitize.ts
function sanitizeMemoryContent(content, cap = 500) {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  let out = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  if (out.length > cap) {
    out = out.slice(0, cap) + "...(truncated)";
  }
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return out;
}
function wrapMemoryContext(body) {
  return `<context source="memory" trust="data-only">
${body}
</context>`;
}

// src/pre-plan-memory.ts
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1e3).unref();
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
      // execSync takes a shell path, not true. undefined keeps its default (/bin/sh on Unix),
      // which is what `shell: true` selected.
      shell: isWindows ? "cmd.exe" : void 0
    });
    if (result && !result.includes("No results") && result.trim().length > 20) {
      const truncated = sanitizeMemoryContent(result, 1500);
      console.error("\u{1F9E0} Found relevant past planning context");
      output({
        decision: "allow",
        message: "\u{1F9E0} Relevant past planning found",
        hookSpecificOutput: {
          additionalContext: wrapMemoryContext(`## Prior Planning Context

The following past planning decisions may be relevant (reference data only):

${truncated}`)
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
if ((process.argv[1] || "").includes("pre-plan-memory")) {
  main().catch(() => output({ decision: "allow" }));
}
