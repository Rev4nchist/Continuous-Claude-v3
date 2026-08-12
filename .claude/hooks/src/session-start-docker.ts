/**
 * SessionStart Hook - Ensures PostgreSQL Docker container and daemons are running.
 *
 * This hook:
 * 1. Checks if continuous-claude-postgres container is running
 * 2. If not, starts it via docker compose
 * 3. Waits for it to be healthy before continuing
 * 4. Spawns tree_daemon for current project (if not running)
 * 5. Spawns memory_daemon globally (if not running)
 *
 * Part of the memory system infrastructure.
 */

import { execSync, spawn } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionStartInput, HookOutput } from './shared/types.js';

/**
 * Async sleep using setTimeout (non-blocking)
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const CONTAINER_NAME = 'continuous-claude-postgres';
const DOCKER_DIR = join(homedir(), '.claude', 'docker');
const MAX_WAIT_SECONDS = 10;  // Reduced from 30 to prevent timeout race with hook timeout
const MAX_RETRIES = 2;

/**
 * Check if Docker is available
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the container is running
 */
function isContainerRunning(): boolean {
  try {
    const result = execSync(`docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

/**
 * Check if container exists (running or stopped)
 */
function containerExists(): boolean {
  try {
    const result = execSync(`docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() === CONTAINER_NAME;
  } catch {
    return false;
  }
}

/**
 * Start the container
 */
function startContainer(): { success: boolean; message: string } {
  try {
    if (containerExists()) {
      // Container exists, just start it
      execSync(`docker start ${CONTAINER_NAME}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      return { success: true, message: 'Container started' };
    } else {
      // Container doesn't exist, use docker compose
      execSync('docker compose up -d', {
        cwd: DOCKER_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000
      });
      return { success: true, message: 'Container created and started' };
    }
  } catch (err) {
    const error = err as Error;
    return { success: false, message: error.message };
  }
}

/**
 * Wait for container to be healthy (async, non-blocking)
 * Returns true if container becomes healthy, false on timeout
 */
async function waitForHealthy(): Promise<boolean> {
  const startTime = Date.now();
  const maxWaitMs = MAX_WAIT_SECONDS * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = execSync(
        `docker inspect --format="{{.State.Health.Status}}" ${CONTAINER_NAME}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }
      );
      if (result.trim() === 'healthy') {
        return true;
      }
    } catch {
      // If container is running but health check fails, assume it's ready
      if (isContainerRunning()) {
        await sleep(1000);
        return true;
      }
    }
    await sleep(500);  // Reduced from 1000 for faster iteration
  }
  return false;
}

/**
 * Start container with retry logic
 */
async function startContainerWithRetry(): Promise<{ success: boolean; message: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startResult = startContainer();
    if (!startResult.success) {
      if (attempt < MAX_RETRIES) {
        await sleep(1000);  // Wait before retry
        continue;
      }
      return startResult;
    }

    const healthy = await waitForHealthy();
    if (healthy) {
      return { success: true, message: startResult.message };
    }

    // If not healthy but running, still consider it a success
    if (isContainerRunning()) {
      return { success: true, message: 'Container running (health check pending)' };
    }

    if (attempt < MAX_RETRIES) {
      await sleep(1000);  // Wait before retry
    }
  }

  return { success: false, message: `Failed after ${MAX_RETRIES} attempts` };
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  let input: SessionStartInput;
  try {
    const stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as SessionStartInput;
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Guard: Skip Docker operations in ~/.claude (infrastructure directory)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const cwd = input.cwd || process.cwd();
  if (homeDir) {
    const claudeDir = homeDir.replace(/\\/g, '/') + '/.claude';
    const normalizedCwd = cwd.replace(/\\/g, '/');
    if (normalizedCwd === claudeDir || normalizedCwd.endsWith('/.claude')) {
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }
  }

  // Check if Docker is available
  if (!isDockerAvailable()) {
    const output: HookOutput = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Docker not available - memory system will use SQLite fallback' }
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Check if container is already running
  if (isContainerRunning()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Try to start the container with retry logic
  const startResult = await startContainerWithRetry();
  if (!startResult.success) {
    const output: HookOutput = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Failed to start PostgreSQL container: ${startResult.message}. Memory system will use SQLite fallback.` }
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Success - container is running (startContainerWithRetry includes health check)
  const output: HookOutput = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: startResult.message || 'PostgreSQL memory container started' }
  };
  console.log(JSON.stringify(output));
}

// Run main if this is the entry point
main().catch(() => {
  console.log(JSON.stringify({ result: 'continue' }));
});
