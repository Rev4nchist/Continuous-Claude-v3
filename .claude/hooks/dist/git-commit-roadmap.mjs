#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/git-commit-roadmap.ts
import * as fs from "fs";
import * as path2 from "path";

// src/shared/roadmap-sync-guards.ts
import * as path from "path";
import { homedir } from "node:os";
function isPathInsideProject(targetPath, projectDir) {
  if (!targetPath || !projectDir) return false;
  const rel = path.relative(path.resolve(projectDir), path.resolve(targetPath));
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
function extractCdTarget(command) {
  if (!command) return null;
  const commitIdx = command.search(/git\s+(?:-[^\s]+\s+)*commit/i);
  const scope = commitIdx >= 0 ? command.slice(0, commitIdx) : command;
  const m = scope.match(/(?:^|[;&|]\s*|&&\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}
function commitRanInProject(command, projectDir) {
  const target = extractCdTarget(command);
  if (!target) return true;
  let resolved = target;
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    resolved = path.join(homedir(), resolved.slice(1));
  }
  const abs = path.isAbsolute(resolved) ? path.resolve(resolved) : path.resolve(projectDir, resolved);
  return isPathInsideProject(abs, projectDir);
}

// src/git-commit-roadmap.ts
var COMMIT_PATTERNS = {
  conventional: /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i,
  commitOutput: /^\[([^\s]+)\s+([a-f0-9]{7,})\]\s+(.+)$/m,
  amendIndicator: /\[.*\s+[a-f0-9]+\].*\(amend\)/i,
  mergeIndicator: /^Merge\s+(branch|pull request|remote-tracking)/i,
  revertIndicator: /^Revert\s+"/i
};
var SKIP_TYPES = /* @__PURE__ */ new Set(["chore", "style", "ci"]);
function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 1e3);
  });
}
function isGitCommitCommand(command) {
  const normalized = command.toLowerCase().trim();
  return normalized.includes("git commit") && !normalized.includes("--amend");
}
function isSuccessfulCommit(response) {
  return COMMIT_PATTERNS.commitOutput.test(response) && !COMMIT_PATTERNS.amendIndicator.test(response);
}
function parseCommitFromOutput(output) {
  const commitMatch = output.match(COMMIT_PATTERNS.commitOutput);
  if (!commitMatch) {
    return null;
  }
  const [, branch, hash, message] = commitMatch;
  const trimmedMsg = message.trim();
  const isAmend = COMMIT_PATTERNS.amendIndicator.test(output);
  const isMerge = COMMIT_PATTERNS.mergeIndicator.test(trimmedMsg);
  const isRevert = COMMIT_PATTERNS.revertIndicator.test(trimmedMsg);
  const conventionalMatch = trimmedMsg.match(COMMIT_PATTERNS.conventional);
  if (conventionalMatch) {
    const [, type, scope, desc] = conventionalMatch;
    return {
      type: type.toLowerCase(),
      scope: scope || null,
      description: desc.trim(),
      hash,
      isAmend,
      isMerge,
      isRevert
    };
  }
  return {
    type: "other",
    scope: null,
    description: trimmedMsg,
    hash,
    isAmend,
    isMerge,
    isRevert
  };
}
function findRoadmapPath(projectDir) {
  const candidates = [
    path2.join(projectDir, "ROADMAP.md"),
    path2.join(projectDir, ".claude", "ROADMAP.md"),
    path2.join(projectDir, "roadmap.md")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
function formatCommitEntry(commit, date) {
  const typeLabel = commit.type !== "other" ? commit.type : "";
  const scopeLabel = commit.scope ? `(${commit.scope})` : "";
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` : typeLabel ? `${typeLabel}: ` : scopeLabel ? `${scopeLabel} ` : "";
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : "";
  return `- [x] ${prefix}${commit.description} (${date})${hashLabel}`;
}
function isDuplicateEntry(content, commit) {
  if (commit.hash) {
    if (content.includes(commit.hash.slice(0, 7))) {
      return true;
    }
  }
  const descLower = commit.description.toLowerCase();
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.trim().startsWith("- [x]")) {
      const lineLower = line.toLowerCase();
      if (lineLower.includes(descLower.slice(0, 30))) {
        return true;
      }
    }
  }
  return false;
}
function appendToCompleted(content, entry) {
  const lines = content.split("\n");
  const result = [];
  let insertedEntry = false;
  let inCompleted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().toLowerCase();
    if (stripped.startsWith("## completed")) {
      inCompleted = true;
      result.push(line);
      result.push(entry);
      insertedEntry = true;
      continue;
    }
    if (stripped.startsWith("## ") && inCompleted) {
      inCompleted = false;
    }
    result.push(line);
  }
  if (!insertedEntry) {
    const completedIndex = result.findIndex(
      (l) => l.trim().toLowerCase().startsWith("## planned") || l.trim().toLowerCase().startsWith("## recent")
    );
    if (completedIndex > 0) {
      result.splice(completedIndex, 0, "", "## Completed", entry, "");
    } else {
      result.push("", "## Completed", entry);
    }
  }
  return result.join("\n");
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
  if (data.tool_name !== "Bash") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const command = data.tool_input?.command || "";
  if (!isGitCommitCommand(command)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let response;
  if (typeof data.tool_response === "string") {
    response = data.tool_response;
  } else if (data.tool_response && typeof data.tool_response.output === "string") {
    response = data.tool_response.output;
  } else if (data.tool_response && typeof data.tool_response.stdout === "string") {
    response = data.tool_response.stdout;
  } else {
    response = JSON.stringify(data.tool_response || "");
  }
  if (!isSuccessfulCommit(response)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const commit = parseCommitFromOutput(response);
  if (!commit) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (commit.isAmend) {
    console.error("\u2139 Skipping amend commit (no duplicate entries)");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (commit.isMerge) {
    console.error("\u2139 Skipping merge commit");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (SKIP_TYPES.has(commit.type)) {
    console.error(`\u2139 Skipping ${commit.type} commit`);
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!commitRanInProject(command, projectDir)) {
    console.error("\u2139 Skipping commit that ran outside this project directory");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const roadmapPath = findRoadmapPath(projectDir);
  if (!roadmapPath) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const content = fs.readFileSync(roadmapPath, "utf-8");
  if (isDuplicateEntry(content, commit)) {
    console.error("\u2139 Skipping duplicate entry");
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const entry = formatCommitEntry(commit, today);
  const updated = appendToCompleted(content, entry);
  fs.writeFileSync(roadmapPath, updated);
  const typeDesc = commit.type !== "other" ? `${commit.type}: ` : "";
  const scopeDesc = commit.scope ? `(${commit.scope}) ` : "";
  console.error(`\u2713 ROADMAP.md: ${typeDesc}${scopeDesc}${commit.description}`);
  const output = {
    result: "continue",
    message: `\u{1F4CB} ROADMAP updated: ${commit.description}`
  };
  console.log(JSON.stringify(output));
}
main().catch((err) => {
  console.error("[git-commit-roadmap] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  formatCommitEntry
};
