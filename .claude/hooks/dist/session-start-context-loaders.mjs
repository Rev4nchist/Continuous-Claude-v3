import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-context-loaders.ts
import { readFileSync } from "fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/shared/session-id.ts
function getProject() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// src/lib/run-command.ts
import { spawn } from "child_process";
function runCommand(name, command, args, stdinData, timeoutMs = 1e4) {
  const start = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      let output;
      try {
        const parsed = JSON.parse(stdout.trim());
        output = parsed.message;
      } catch {
        output = stdout.trim() || void 0;
      }
      resolve({
        name,
        success: code === 0,
        output,
        message: code === 0 ? "OK" : `Exit ${code}`,
        error: stderr.trim() || void 0,
        duration: Date.now() - start
      });
    });
    proc.on("error", (err) => {
      resolve({
        name,
        success: false,
        error: err.message,
        duration: Date.now() - start
      });
    });
    proc.stdin?.write(stdinData);
    proc.stdin?.end();
  });
}

// src/session-start-context-loaders.ts
async function main() {
  const project = getProject();
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const claudeDir = homeDir ? `${homeDir}/.claude`.replace(/\\/g, "/") : "";
  const normalizedProject = project.replace(/\\/g, "/");
  if (claudeDir && (normalizedProject === claudeDir || normalizedProject.includes("/.claude"))) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let stdinContent = "{}";
  try {
    stdinContent = readFileSync(0, "utf-8");
    JSON.parse(stdinContent);
  } catch {
  }
  const hooksDir = join(homedir(), ".claude", "hooks").replace(/\\/g, "/");
  const result = await runCommand(
    "tree-daemon",
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", `${hooksDir}/session-start-tree-daemon.ps1`],
    stdinContent,
    15e3
  );
  const message = result.output ?? "";
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } };
  console.log(JSON.stringify(output));
}
main().catch((err) => {
  console.error("context-loaders failed:", err);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  main
};
