import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/git-memory-check.ts
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

// src/shared/opc-path.ts
import { existsSync } from "fs";
import { join } from "path";
function getOpcDir() {
  const envOpcDir = process.env.CLAUDE_OPC_DIR;
  if (envOpcDir && existsSync(envOpcDir)) {
    return envOpcDir;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const localOpc = join(projectDir, "opc");
  if (existsSync(localOpc)) {
    return localOpc;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalClaude = join(homeDir, ".claude");
    const globalScripts = join(globalClaude, "scripts", "core");
    if (existsSync(globalScripts) && globalClaude !== projectDir) {
      return globalClaude;
    }
  }
  return null;
}

// src/git-memory-check.ts
function readStdin() {
  return readFileSync(0, "utf-8");
}
function extractGitOperation(command) {
  const gitPatterns = [
    /\bgit\s+push\b(.*)$/im,
    /\bgit\s+commit\b(.*)$/im,
    /\bgit\s+checkout\b(.*)$/im,
    /\bgit\s+reset\b(.*)$/im,
    /\bgit\s+rebase\b(.*)$/im,
    /\bgit\s+merge\b(.*)$/im
  ];
  for (const pattern of gitPatterns) {
    const match = command.match(pattern);
    if (match) {
      const fullMatch = match[0];
      const op = fullMatch.split(/\s+/)[1];
      const args = match[1]?.trim() || "";
      return { op, args };
    }
  }
  return null;
}
function buildSearchQuery(op, args) {
  const queries = {
    push: `git push ${args.includes("origin") ? "origin" : ""} remote`,
    commit: "git commit convention message",
    checkout: "git checkout branch",
    reset: "git reset dangerous",
    rebase: "git rebase workflow",
    merge: "git merge branch"
  };
  return queries[op] || `git ${op}`;
}
function checkGitMemory(query) {
  const opcDir = getOpcDir();
  if (!opcDir) return null;
  try {
    const result = spawnSync("uv", [
      "run",
      "python",
      "scripts/core/recall_learnings.py",
      "--query",
      query,
      "--k",
      "3",
      "--json",
      "--text-only"
    ], {
      encoding: "utf-8",
      cwd: opcDir,
      env: {
        ...process.env,
        PYTHONPATH: opcDir
      },
      timeout: 3e3,
      killSignal: "SIGKILL"
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}
function isBlockingMemory(content, op, args) {
  const lowerContent = content.toLowerCase();
  const lowerArgs = args.toLowerCase();
  if (lowerContent.includes("never")) {
    if (op === "push" && lowerContent.includes("origin") && lowerArgs.includes("origin")) {
      return true;
    }
    if (op === "push" && lowerContent.includes("force") && (lowerArgs.includes("--force") || lowerArgs.includes("-f"))) {
      return true;
    }
    if (op === "push" && (lowerContent.includes("main") || lowerContent.includes("master")) && (lowerArgs.includes("main") || lowerArgs.includes("master"))) {
      return true;
    }
  }
  return false;
}
async function main() {
  const input = JSON.parse(readStdin());
  if (input.tool_name !== "Bash") {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const command = input.tool_input.command;
  if (!command || typeof command !== "string") {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const gitOp = extractGitOperation(command);
  if (!gitOp) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const query = buildSearchQuery(gitOp.op, gitOp.args);
  const memory = checkGitMemory(query);
  if (!memory || memory.results.length === 0) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  const blockingMemories = memory.results.filter(
    (r) => isBlockingMemory(r.content, gitOp.op, gitOp.args)
  );
  if (blockingMemories.length > 0) {
    const topMemory = blockingMemories[0];
    const preview = topMemory.content.slice(0, 200);
    console.log(JSON.stringify({
      decision: "block",
      reason: `\u26A0\uFE0F GIT MEMORY WARNING:

A stored preference may conflict with this command:

"${preview}"

Please confirm this is intentional or modify the command.`
    }));
    return;
  }
  const topResult = memory.results[0];
  if (topResult.score > 0.05) {
    const preview = topResult.content.slice(0, 150);
    console.log(JSON.stringify({
      continue: true,
      additionalContext: `GIT MEMORY HINT: "${preview}..." - Consider if this applies to your command.`
    }));
    return;
  }
  console.log(JSON.stringify({ continue: true }));
}
main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
