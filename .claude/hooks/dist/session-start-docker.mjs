import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-docker.ts
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var CONTAINER_NAME = "continuous-claude-postgres";
var DOCKER_DIR = join(homedir(), ".claude", "docker");
var MAX_WAIT_SECONDS = 10;
var MAX_RETRIES = 2;
function isDockerAvailable() {
  try {
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function isContainerRunning() {
  try {
    const result = execSync(`docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}
function containerExists() {
  try {
    const result = execSync(`docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}
function startContainer() {
  try {
    if (containerExists()) {
      execSync(`docker start ${CONTAINER_NAME}`, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 1e4
      });
      return { success: true, message: "Container started" };
    } else {
      execSync("docker compose up -d", {
        cwd: DOCKER_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 6e4
      });
      return { success: true, message: "Container created and started" };
    }
  } catch (err) {
    const error = err;
    return { success: false, message: error.message };
  }
}
async function waitForHealthy() {
  const startTime = Date.now();
  const maxWaitMs = MAX_WAIT_SECONDS * 1e3;
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = execSync(
        `docker inspect --format="{{.State.Health.Status}}" ${CONTAINER_NAME}`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 3e3 }
      );
      if (result.trim() === "healthy") {
        return true;
      }
    } catch {
      if (isContainerRunning()) {
        await sleep(1e3);
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}
async function startContainerWithRetry() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startResult = startContainer();
    if (!startResult.success) {
      if (attempt < MAX_RETRIES) {
        await sleep(1e3);
        continue;
      }
      return startResult;
    }
    const healthy = await waitForHealthy();
    if (healthy) {
      return { success: true, message: startResult.message };
    }
    if (isContainerRunning()) {
      return { success: true, message: "Container running (health check pending)" };
    }
    if (attempt < MAX_RETRIES) {
      await sleep(1e3);
    }
  }
  return { success: false, message: `Failed after ${MAX_RETRIES} attempts` };
}
async function main() {
  let input;
  try {
    const stdinContent = readFileSync(0, "utf-8");
    input = JSON.parse(stdinContent);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = input.cwd || process.cwd();
  if (homeDir) {
    const claudeDir = homeDir.replace(/\\/g, "/") + "/.claude";
    const normalizedCwd = cwd.replace(/\\/g, "/");
    if (normalizedCwd === claudeDir || normalizedCwd.endsWith("/.claude")) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
  }
  if (!isDockerAvailable()) {
    const output2 = {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Docker not available - memory system will use SQLite fallback" }
    };
    console.log(JSON.stringify(output2));
    return;
  }
  if (isContainerRunning()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const startResult = await startContainerWithRetry();
  if (!startResult.success) {
    const output2 = {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `Failed to start PostgreSQL container: ${startResult.message}. Memory system will use SQLite fallback.` }
    };
    console.log(JSON.stringify(output2));
    return;
  }
  const output = {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: startResult.message || "PostgreSQL memory container started" }
  };
  console.log(JSON.stringify(output));
}
main().catch(() => {
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  main
};
