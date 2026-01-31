#!/usr/bin/env node

// src/roadmap-completion.ts
import * as fs from "fs";
import * as path from "path";
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
    setTimeout(() => resolve(data), 1e3);
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
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    rawContent: content
  };
  const lines = content.split("\n");
  let section = null;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.toLowerCase().startsWith("## current")) {
      section = "current";
      continue;
    } else if (stripped.toLowerCase().startsWith("## completed")) {
      section = "completed";
      continue;
    } else if (stripped.toLowerCase().startsWith("## planned")) {
      section = "planned";
      continue;
    } else if (stripped.startsWith("## ")) {
      section = null;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**")) {
        const title = stripped.replace(/\*\*/g, "").trim();
        result.current = { title, description: "", started: "" };
      } else if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (text.toLowerCase().startsWith("started:")) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else {
          result.current.description += (result.current.description ? "; " : "") + text;
        }
      } else if (stripped.startsWith("- [ ]")) {
        const title = stripped.replace(/^-\s*\[\s*\]\s*/, "").trim();
        result.current = { title, description: "", started: "" };
      }
    }
    if (section === "completed") {
      const match = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (match) {
        result.completed.push({
          title: match[1].trim(),
          completed: match[2] || ""
        });
      }
    }
    if (section === "planned") {
      const match = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (match) {
        result.planned.push({
          title: match[1].trim(),
          priority: match[2] || "normal"
        });
      }
    }
  }
  return result;
}
function updateRoadmapContent(content, data) {
  if (!data.current) {
    return content;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const completedItem = `- [x] ${data.current.title} (${today})`;
  let lines = content.split("\n");
  let inCurrent = false;
  let inCompleted = false;
  let currentStart = -1;
  let currentEnd = -1;
  let completedInsertIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim().toLowerCase();
    if (stripped.startsWith("## current")) {
      inCurrent = true;
      inCompleted = false;
      currentStart = i + 1;
      continue;
    } else if (stripped.startsWith("## completed")) {
      inCurrent = false;
      inCompleted = true;
      completedInsertIndex = i + 1;
      if (currentEnd === -1) currentEnd = i;
      continue;
    } else if (stripped.startsWith("## ")) {
      if (inCurrent && currentEnd === -1) currentEnd = i;
      inCurrent = false;
      inCompleted = false;
      continue;
    }
  }
  if (currentEnd === -1) currentEnd = lines.length;
  const newLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (i >= currentStart && i < currentEnd) {
      continue;
    }
    newLines.push(lines[i]);
    if (lines[i].trim().toLowerCase().startsWith("## current")) {
      newLines.push("");
      newLines.push("_No current goal. Next planned item will be promoted on next planning session._");
      newLines.push("");
    }
    if (lines[i].trim().toLowerCase().startsWith("## completed")) {
      newLines.push(completedItem);
    }
  }
  return newLines.join("\n");
}
function promoteNextPlanned(content, data) {
  if (data.planned.length === 0) {
    return content;
  }
  const priorities = { high: 3, medium: 2, normal: 1, low: 0 };
  let best = data.planned[0];
  for (const item of data.planned) {
    const priority = item.priority.toLowerCase();
    if ((priorities[priority] || 1) > (priorities[best.priority.toLowerCase()] || 1)) {
      best = item;
    }
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  let lines = content.split("\n");
  let result = [];
  let inCurrent = false;
  let addedCurrent = false;
  let removedPlanned = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const lower = stripped.toLowerCase();
    if (lower.startsWith("## current")) {
      inCurrent = true;
      result.push(lines[i]);
      result.push("");
      result.push(`**${best.title}**`);
      result.push(`- Started: ${today}`);
      result.push("");
      addedCurrent = true;
      continue;
    } else if (lower.startsWith("## ")) {
      inCurrent = false;
    }
    if (inCurrent && stripped.includes("No current goal")) {
      continue;
    }
    if (!removedPlanned && stripped.includes(best.title) && stripped.startsWith("- [ ]")) {
      removedPlanned = true;
      continue;
    }
    result.push(lines[i]);
  }
  return result.join("\n");
}
async function handleTaskUpdate(data) {
  const input = data.tool_input;
  if (input.status !== "completed") {
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
  let updated = updateRoadmapContent(content, roadmapData);
  const updatedData = parseRoadmap(updated);
  if (!updatedData.current && updatedData.planned.length > 0) {
    updated = promoteNextPlanned(updated, updatedData);
  }
  fs.writeFileSync(roadmapPath, updated);
  return {
    result: "continue",
    message: `ROADMAP updated: "${roadmapData.current.title}" marked complete`
  };
}
async function handleBashOutput(data) {
  const toolResult = data.tool_result || "";
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
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
