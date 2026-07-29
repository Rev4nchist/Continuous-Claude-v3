#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/roadmap-completion.ts
import * as fs from "fs";
import * as path from "path";

// src/shared/roadmap-parser.ts
var SECTION_PREFIXES = [
  // Order matters: more specific first.
  { key: "sessions", prefix: "## recent planning" },
  { key: "current", prefix: "## current" },
  { key: "completed", prefix: "## completed" },
  { key: "planned", prefix: "## planned" }
];
function detectSection(strippedLower) {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith("## ")) {
    return null;
  }
  return void 0;
}
function bucketize(rawPriority) {
  const p = rawPriority.toLowerCase();
  if (p.includes("high")) return "high";
  if (p.includes("low")) return "low";
  return "medium";
}
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: /* @__PURE__ */ new Map()
  };
  if (!content) return result;
  const lines = content.split("\n");
  let section = null;
  let sectionStart = -1;
  const closeSection = (endLine) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();
    const detected = detectSection(lower);
    const isAnyH2 = stripped.startsWith("## ");
    const isKnownH2 = typeof detected === "string";
    const isUnrelatedH2 = detected === null;
    if (isKnownH2) {
      closeSection(i);
      section = detected;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**") && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, "").trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, "").trim();
        } else {
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }
    if (section === "completed") {
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || ""
        });
      }
      continue;
    }
    if (section === "planned") {
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || "normal";
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority)
        });
      }
      continue;
    }
    if (section === "sessions") {
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: []
        });
        continue;
      }
      if (result.sessions.length > 0 && stripped.startsWith("-")) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }
  }
  closeSection(lines.length);
  return result;
}

// src/roadmap-completion.ts
var COMPLETION_PATTERNS = [
  /\b(done|complete|completed|finished|shipped|deployed|merged)\b/i,
  /\btask\s+(is\s+)?(done|complete|finished)\b/i,
  /\bmark\s+(as\s+)?(done|complete|finished)\b/i,
  /\bclose\s+(this\s+)?(task|issue|item)\b/i
];
var TEST_SUCCESS_PATTERNS = [
  /Tests:\s+\d+\s+passed,\s+0\s+failed/i,
  /✓\s+\d+\s+tests?\s+passed/i,
  /All specs passed/i,
  /\d+\s+passed,\s+0\s+failed/i,
  /PASSED\s+\d+\s+tests?/i,
  /OK\s+\(\d+\s+tests?\)/i
];
var GIT_PUSH_PATTERNS = [
  /\[main\s+[a-f0-9]+\]/i,
  /\[master\s+[a-f0-9]+\]/i,
  /-> main$/im,
  /-> master$/im,
  /Branch .+ set up to track/i
];
var COMPLETION_EXCLUSIONS = [
  /\bnot\s+(done|complete|finished)\b/i,
  /\bisn'?t\s+(done|complete|finished)\b/i,
  /\bwhen\s+(done|complete|finished)\b/i,
  /\bonce\s+(done|complete|finished)\b/i,
  /\bafter\s+(done|complete|finished)\b/i,
  /\buntil\s+(done|complete|finished)\b/i,
  /\?/
  // Questions
];
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 1e3).unref();
  });
}
function detectCompletionSignal(text) {
  for (const pattern of TEST_SUCCESS_PATTERNS) {
    if (pattern.test(text)) {
      return { type: "test_success", matched: true };
    }
  }
  for (const pattern of GIT_PUSH_PATTERNS) {
    if (pattern.test(text)) {
      return { type: "git_push", matched: true };
    }
  }
  return { type: "none", matched: false };
}
function isCompletionSignal(text) {
  for (const exclusion of COMPLETION_EXCLUSIONS) {
    if (exclusion.test(text)) {
      return false;
    }
  }
  for (const pattern of COMPLETION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
function findRoadmapPath(projectDir) {
  const candidates = [
    path.join(projectDir, "ROADMAP.md"),
    path.join(projectDir, ".claude", "ROADMAP.md"),
    path.join(projectDir, "roadmap.md")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
function buildTaskCompletionAdvisory(roadmapContent) {
  const data = parseRoadmap(roadmapContent);
  if (!data.current) return null;
  return `Task marked complete. ROADMAP Current Focus is unchanged: "${data.current.title}". roadmap-completion no longer auto-advances the ROADMAP on task completion \u2014 if the goal itself is finished, run /roadmap complete (and /roadmap focus <next>) to update it.`;
}
async function handleTaskUpdate(data, projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const input = data.tool_input;
  if (input.status !== "completed") return { result: "continue" };
  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) return { result: "continue" };
  const advisory = buildTaskCompletionAdvisory(fs.readFileSync(roadmapPath, "utf-8"));
  if (!advisory) return { result: "continue" };
  return {
    result: "continue",
    message: advisory,
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: advisory }
  };
}
async function handleBashOutput(data) {
  let toolResult;
  const resp = data.tool_response;
  if (typeof resp === "string") {
    toolResult = resp;
  } else if (resp && typeof resp.output === "string") {
    toolResult = resp.output;
  } else {
    toolResult = "";
  }
  const signal = detectCompletionSignal(toolResult);
  if (!signal.matched) {
    return { result: "continue" };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) {
    return { result: "continue" };
  }
  const content = fs.readFileSync(roadmapPath, "utf-8");
  const roadmapData = parseRoadmap(content);
  if (!roadmapData.current) {
    return { result: "continue" };
  }
  const signalDescription = signal.type === "test_success" ? "All tests passed" : "Code pushed to main branch";
  return {
    result: "continue",
    message: `\u{1F3AF} Completion signal: ${signalDescription}. Goal "${roadmapData.current.title}" may be complete.`
  };
}
async function handleUserPrompt(data) {
  if (!isCompletionSignal(data.prompt)) {
    return { result: "continue" };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) {
    return { result: "continue" };
  }
  const content = fs.readFileSync(roadmapPath, "utf-8");
  const roadmapData = parseRoadmap(content);
  if (!roadmapData.current) {
    return { result: "continue" };
  }
  return {
    result: "continue",
    message: `Completion signal detected. Current ROADMAP goal: "${roadmapData.current.title}". If this goal is complete, the ROADMAP will be updated when you mark the task as completed.`
  };
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let result;
  if ("tool_name" in data && data.tool_name === "TaskUpdate") {
    result = await handleTaskUpdate(data);
  } else if ("tool_name" in data && data.tool_name === "Bash") {
    result = await handleBashOutput(data);
  } else if ("prompt" in data) {
    result = await handleUserPrompt(data);
  } else {
    result = { result: "continue" };
  }
  console.log(JSON.stringify(result));
}
main().catch((err) => {
  console.error("[roadmap-completion] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  buildTaskCompletionAdvisory,
  handleTaskUpdate
};
