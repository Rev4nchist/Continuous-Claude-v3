#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/guardrail-enforcer.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

// src/shared/intent-extractor.ts
var SYNTHETIC_TAG = /^<\/?(?:task-notification|system-reminder|local-command-(?:stdout|stderr)|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|agent-message|teammate-message|user-prompt-submit-hook|[a-z][a-z0-9-]*-hook)\b/i;
function isHarnessWrappedPrompt(prompt) {
  if (typeof prompt !== "string") return false;
  const t = prompt.trim();
  return SYNTHETIC_TAG.test(t) || t.includes("<task-notification");
}

// src/guardrail-enforcer.ts
var GUARDRAILS = [
  {
    name: "systematic-debugging",
    skill: "systematic-debugging",
    triggers: /\b(bug|error|fix|debug|broken|failing|crash|exception|stack\s*trace)\b/i,
    antiTriggers: /\b(commit\s+to|commit\s+the\s+approach|no\s+bugs?|without\s+errors?)\b/i,
    message: `\u{1F6D1} GUARDRAIL: Debugging methodology required

Before investigating bugs/errors, you MUST load the systematic-debugging skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "systematic-debugging" }
2. THEN respond to the user's debugging request

This ensures proper root cause analysis before fixes.
Do NOT attempt fixes without understanding the root cause first.`
  },
  {
    name: "databases",
    skill: "databases",
    // Bare `table` / `column` / `index` fired on markdown tables, INDEX.md and prose (2026-09-23
    // eval, P22); they now count only in SQL-shaped phrases.
    triggers: /\b(database|sql|postgres|postgresql|mysql|sqlite|psql|migration|schema|(?:create|alter|drop|truncate)\s+(?:table|index|column)|select\s+\S+\s+from)\b/i,
    antiTriggers: /\b(no\s+database|without\s+database|skip\s+database)\b/i,
    message: `\u{1F6D1} GUARDRAIL: Database skill required

Before database operations, you MUST load the databases skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "databases" }
2. THEN proceed with database work

This ensures query optimization and safety checks.
Do NOT write SQL without the database skill loaded.`
  },
  {
    name: "code-review",
    skill: "code-review",
    // Bare `review` / `approve` / `merge` fired on "review this tweet" and "approve deletion"
    // (2026-09-23 eval, P22). Now: code or PR context only. "merge 43 and 44" still counts.
    // A bare "#42" is not enough ("fix issue #42" is not a review); it needs PR/review/merge.
    triggers: /\b(pull\s*requests?|code\s*review|prs?\s*#?\d+|review\s+(?:pr\s*)?#\d+|review\s+(?:the\s+|this\s+|my\s+|a\s+)?(?:pr|diff|code|changes|commit|patch|branch)|merge\s+(?:pr\s*)?#?\d+|merge\s+(?:the\s+|this\s+)?(?:pr|branch|pull))\b/i,
    antiTriggers: /\b(no\s+review|skip\s+review|review\s+later)\b/i,
    message: `\u{1F6D1} GUARDRAIL: Code review methodology required

Before PR/review work, you MUST load the code-review skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "code-review" }
2. THEN proceed with review work

This ensures thorough review methodology.
Do NOT approve PRs without proper verification.`
  }
];
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || String(process.ppid || process.pid);
}
function getSessionFilePath() {
  const sessionId = getSessionId().slice(0, 8);
  return join(tmpdir(), `claude-guardrails-${sessionId}.json`);
}
function readSessionState() {
  const filePath = getSessionFilePath();
  if (!existsSync(filePath)) {
    return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const state = JSON.parse(content);
    const hourAgo = Date.now() - 60 * 60 * 1e3;
    if (state.lastUpdated < hourAgo) {
      return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
    }
    return state;
  } catch {
    return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
  }
}
function writeSessionState(state) {
  const filePath = getSessionFilePath();
  try {
    writeFileSync(filePath, JSON.stringify(state), "utf-8");
  } catch {
  }
}
function acknowledgeGuardrail(guardrailName) {
  const state = readSessionState();
  if (!state.acknowledgedGuardrails.includes(guardrailName)) {
    state.acknowledgedGuardrails.push(guardrailName);
    state.lastUpdated = Date.now();
    writeSessionState(state);
  }
}
function isGuardrailAcknowledged(guardrailName) {
  const state = readSessionState();
  return state.acknowledgedGuardrails.includes(guardrailName);
}
function readStdin() {
  return readFileSync(0, "utf-8");
}
function matchGuardrails(prompt) {
  if (isHarnessWrappedPrompt(prompt)) return [];
  const lowerPrompt = prompt.toLowerCase();
  return GUARDRAILS.filter((g) => g.triggers.test(lowerPrompt) && !(g.antiTriggers && g.antiTriggers.test(lowerPrompt))).map((g) => g.name);
}
function checkGuardrails(prompt) {
  for (const name of matchGuardrails(prompt)) {
    if (isGuardrailAcknowledged(name)) continue;
    return GUARDRAILS.find((g) => g.name === name) ?? null;
  }
  return null;
}
function emitGuardrail(guardrail) {
  acknowledgeGuardrail(guardrail.name);
  outputWithMessage(guardrail.message, "UserPromptSubmit");
}
async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      outputContinue();
      return;
    }
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      outputContinue();
      return;
    }
    if (!input.prompt || typeof input.prompt !== "string") {
      outputContinue();
      return;
    }
    const triggeredGuardrail = checkGuardrails(input.prompt);
    if (triggeredGuardrail) {
      emitGuardrail(triggeredGuardrail);
      return;
    }
    outputContinue();
  } catch (err) {
    console.error("guardrail-enforcer error:", err);
    outputContinue();
  }
}
if ((process.argv[1] || "").includes("guardrail-enforcer")) {
  main();
}
export {
  matchGuardrails
};
