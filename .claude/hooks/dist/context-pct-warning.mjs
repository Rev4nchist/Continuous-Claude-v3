#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/context-pct-warning.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}
function outputWithMessage(message, hookEventName) {
  if (!message || !message.trim()) {
    outputContinue();
    return;
  }
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: message }
  }));
}

// src/context-pct-warning.ts
function main() {
  try {
    const input = readFileSync(0, "utf-8");
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      outputContinue();
      return;
    }
    const rawSessionId = data.session_id || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_PPID || "default";
    const sessionId = rawSessionId.slice(0, 8);
    const contextFile = join(tmpdir(), `claude-context-pct-${sessionId}.txt`);
    if (existsSync(contextFile)) {
      const pct = parseInt(readFileSync(contextFile, "utf-8").trim(), 10);
      if (!Number.isNaN(pct)) {
        if (pct >= 90) {
          outputWithMessage("CONTEXT CRITICAL: " + pct + "%\nRun /create_handoff NOW before auto-compact!", "UserPromptSubmit");
          return;
        }
        if (pct >= 80) {
          outputWithMessage("CONTEXT WARNING: " + pct + "%\nRecommend: /create_handoff then /clear soon", "UserPromptSubmit");
          return;
        }
        if (pct >= 70) {
          outputWithMessage("Context at " + pct + "%. Consider handoff when you reach a stopping point.", "UserPromptSubmit");
          return;
        }
      }
    }
    outputContinue();
  } catch {
    outputContinue();
  }
}
main();
