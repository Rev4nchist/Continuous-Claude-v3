#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/agent-error-capture.ts
import { readFileSync, existsSync } from "fs";
import { spawn as spawn2 } from "child_process";
import { join } from "path";

// src/shared/memory-quality-scorer.ts
var SIGNAL_INDICATORS = [
  {
    test: (c) => /error|exception|failure|bug|crash/i.test(c) && /fix|fixed|solved|solution|resolved|workaround/i.test(c),
    points: 3,
    label: "contains error + fix/solution"
  },
  {
    test: (c) => /decided to|chose|because|rationale|trade-?off/i.test(c) && c.length > 60,
    points: 2,
    label: "contains decision with reasoning"
  },
  {
    test: (c) => /[.\/\\][\w-]+\.(ts|js|py|mjs|json|yaml|yml|toml|md|sh|go|rs)\b/.test(c) && c.length > 60,
    points: 2,
    label: "contains file path + explanation"
  },
  {
    test: (c) => /doesn'?t work|does not work|fixed by|root cause|broke because/i.test(c),
    points: 2,
    label: "contains diagnostic language"
  },
  {
    test: (c) => c.length > 100,
    points: 1,
    label: "content length > 100 chars"
  },
  {
    test: (c) => /`[^`]+`/.test(c) || /\$\s*\w+/.test(c) || /--[\w-]+/.test(c),
    points: 1,
    label: "contains code snippet or command"
  },
  {
    // Mentions specific technical tools/systems (rescues short factual statements)
    test: (c) => /\b(esbuild|webpack|vite|vitest|jest|pytest|docker|postgres|redis|nginx|caddy|drizzle|prisma|typescript|eslint|prettier|rollup|turbopack|bun|deno|node)\b/i.test(c),
    points: 1,
    label: "mentions specific technology/tool"
  }
];
var NOISE_INDICATORS = [
  {
    test: (c) => /periodic extraction|session checkpoint/i.test(c),
    points: -3,
    label: "matches periodic/checkpoint pattern"
  },
  {
    test: (c) => /\bheartbeat\b|\bstatus update\b/i.test(c),
    points: -3,
    label: "matches heartbeat/status update"
  },
  {
    test: (c) => c.length < 50,
    points: -2,
    label: "content too short (< 50 chars)"
  },
  {
    test: (c) => {
      const hasPath = /[.\/\\][\w-]+\.(ts|js|py|mjs|json|yaml|yml|toml|md|sh|go|rs)\b/.test(c);
      const hasError = /error|exception|failure|bug|crash/i.test(c);
      const hasDecision = /decided|chose|because|rationale/i.test(c);
      const hasDiagnostic = /fix|root cause|doesn'?t work|broke/i.test(c);
      const hasCommand = /`[^`]+`/.test(c) || /--[\w-]+/.test(c);
      const hasTechTerm = /\b(esbuild|webpack|vite|vitest|jest|pytest|docker|postgres|redis|nginx|caddy|drizzle|prisma|typescript|eslint|prettier|rollup|turbopack|bun|deno|node)\b/i.test(c);
      return !hasPath && !hasError && !hasDecision && !hasDiagnostic && !hasCommand && !hasTechTerm;
    },
    points: -2,
    label: "generic/vague content"
  },
  {
    test: (c) => {
      const stripped = c.trim().toLowerCase();
      return /^(task\s+)?(completed|in progress|started|done|pending|finished)\b/i.test(stripped) || /^\s*(completed|in progress|started)\s*$/i.test(stripped);
    },
    points: -2,
    label: "only contains task status"
  },
  {
    // Repetitive/padded content: long text but low unique sentence ratio
    test: (c) => {
      if (c.length < 100) return false;
      const sentences = c.split(/[.!?]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 5);
      if (sentences.length < 2) return false;
      const uniqueSentences = new Set(sentences);
      return uniqueSentences.size / sentences.length < 0.5;
    },
    points: -3,
    label: "repetitive/padded content"
  }
];
var BASE_SCORE = 5;
var MIN_SCORE = 0;
var MAX_SCORE = 10;
var SIGNAL_THRESHOLD = 5;
var BORDERLINE_LOW = 3;
function scoreExtraction(content, context) {
  const reasons = [];
  let score = BASE_SCORE;
  if (!content || content.trim().length === 0) {
    return {
      score: 0,
      confidence: "low",
      classification: "NOISE",
      reasons: ["empty content"]
    };
  }
  for (const indicator of SIGNAL_INDICATORS) {
    if (indicator.test(content, context)) {
      score += indicator.points;
      reasons.push(`+${indicator.points}: ${indicator.label}`);
    }
  }
  for (const indicator of NOISE_INDICATORS) {
    if (indicator.test(content, context)) {
      score += indicator.points;
      reasons.push(`${indicator.points}: ${indicator.label}`);
    }
  }
  if (context && context.trim().length > 0) {
    score += 0.5;
    reasons.push("+0.5: context provided");
  }
  score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
  let classification;
  let confidence;
  if (score >= SIGNAL_THRESHOLD) {
    classification = "SIGNAL";
    confidence = "high";
  } else if (score >= BORDERLINE_LOW) {
    classification = "BORDERLINE";
    confidence = "medium";
  } else {
    classification = "NOISE";
    confidence = "low";
  }
  return { score, confidence, classification, reasons };
}

// src/lib/spawn-hidden.ts
import { spawn } from "child_process";
var RELAY_SCRIPT = "const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',()=>process.exit(1));p.on('exit',(code)=>process.exit(code??1));";
function spawnDetachedHidden(cmd, args, options = {}, spawnFn = spawn, platform = process.platform) {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== "win32") return spawnFn(cmd, [...args], opts);
  return spawnFn(process.execPath, ["-e", RELAY_SCRIPT, "--", cmd, ...args], opts);
}

// src/agent-error-capture.ts
var STRUCTURED_ERROR_PATTERNS = [
  /\bTraceback\s+\(most recent/i,
  // Python stack trace
  /\bat\s+\S+\s+\(\S+:\d+:\d+\)/,
  // JS stack trace frame
  /\bpanic:/i,
  // Go panic
  /\bRuntimeError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bImportError\b/i,
  /\bModuleNotFoundError\b/i,
  /\bConnectionRefused\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOENT\b/i,
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /\bcrash(?:ed|es)?\b/i
  // crash / crashed / crashes (was /crashed?/ which required the 'e')
];
var GENERIC_ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bfailure\b/i,
  /\btimeout\b/i
];
var ERROR_PATTERNS = [...STRUCTURED_ERROR_PATTERNS, ...GENERIC_ERROR_PATTERNS];
function readStdin() {
  return readFileSync(0, "utf-8");
}
function outputContinue() {
  console.log(JSON.stringify({}));
}
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function responseToString(response) {
  if (typeof response === "string") return response;
  if (response === null || response === void 0) return "";
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}
function hasStructuredError(text) {
  return STRUCTURED_ERROR_PATTERNS.some((p) => p.test(text));
}
function extractErrorContext(response, maxLen = 500) {
  const lines = response.split("\n");
  const errorLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ERROR_PATTERNS.some((p) => p.test(line))) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 4);
      errorLines.push(...lines.slice(start, end));
      break;
    }
  }
  if (errorLines.length > 0) {
    return errorLines.join("\n").substring(0, maxLen);
  }
  if (response.length <= maxLen) return response;
  return response.substring(0, maxLen / 2) + "\n...\n" + response.substring(response.length - maxLen / 2);
}
function buildStoreInvocation(opcDir, sessionId, content, contextStr, tagsStr) {
  return {
    cmd: "uv",
    args: [
      "run",
      "python",
      "scripts/core/store_learning.py",
      "--session-id",
      sessionId,
      "--type",
      "FAILED_APPROACH",
      "--content",
      content,
      "--context",
      contextStr,
      "--tags",
      tagsStr,
      "--confidence",
      "medium"
    ],
    options: { cwd: opcDir, shell: false, detached: true, stdio: "ignore", windowsHide: true }
  };
}
function releaseWhenRunning(child) {
  const release = () => {
    try {
      child.unref?.();
    } catch {
    }
  };
  if (typeof child.once !== "function") {
    release();
    return;
  }
  child.once("spawn", release);
  child.once("error", release);
}
function storeLearning(sessionId, agentType, prompt, errorContext, deps = {}) {
  const spawnFn = deps.spawnFn ?? spawn2;
  const scoreFn = deps.scoreFn ?? scoreExtraction;
  const existsFn = deps.existsFn ?? existsSync;
  const opcDir = getOpcDir();
  const storeScript = join(opcDir, "scripts", "core", "store_learning.py");
  if (!existsFn(storeScript)) {
    console.error("[AgentErrorCapture] store_learning.py not found");
    return;
  }
  const content = `${errorContext} -- task failure in the ${agentType} agent, which did not complete.`;
  void prompt;
  const score = scoreFn(content, `Failed agent invocation: ${agentType}`);
  if (score.classification === "NOISE") {
    console.error(
      `[AgentErrorCapture] Skipped NOISE (score=${score.score}) for agent '${agentType}': ` + score.reasons.join("; ")
    );
    return;
  }
  const tags = [
    "auto_captured",
    "agent_failure",
    `agent:${agentType}`,
    "scope:global",
    `quality:${score.classification.toLowerCase()}`,
    `score:${score.score}`
  ];
  try {
    const { cmd, args, options } = buildStoreInvocation(
      opcDir,
      sessionId,
      content,
      `Failed agent invocation: ${agentType}`,
      tags.join(",")
    );
    const child = spawnDetachedHidden(cmd, args, options, spawnFn);
    releaseWhenRunning(child);
    console.error(`[AgentErrorCapture] Dispatched (detached) failure learning for agent '${agentType}'`);
  } catch (err) {
    console.error(`[AgentErrorCapture] Failed to dispatch learning: ${err}`);
  }
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
    if (input.tool_name !== "Agent" && input.tool_name !== "Task") {
      outputContinue();
      return;
    }
    const agentType = input.tool_input.subagent_type || "unknown";
    const prompt = input.tool_input.prompt || input.tool_input.description || "";
    const responseStr = responseToString(input.tool_response);
    if (hasStructuredError(responseStr)) {
      const errorContext = extractErrorContext(responseStr);
      console.error(`[AgentErrorCapture] Detected structured error in ${agentType} agent response`);
      storeLearning(
        input.session_id,
        agentType,
        prompt,
        errorContext
      );
    }
    outputContinue();
  } catch (err) {
    console.error(`[AgentErrorCapture] Hook error: ${err}`);
    outputContinue();
  }
}
if (process.argv[1] && process.argv[1].includes("agent-error-capture")) {
  main();
}
export {
  buildStoreInvocation,
  hasStructuredError,
  releaseWhenRunning,
  storeLearning
};
