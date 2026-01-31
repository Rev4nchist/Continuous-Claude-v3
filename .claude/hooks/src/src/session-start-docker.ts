/**
 * SessionStart Hook - Ensures PostgreSQL Docker container is running.
 *
 * This hook:
 * 1. Checks if continuous-claude-postgres container is running
 * 2. If not, starts it via docker compose
 * 3. Waits for it to be healthy before continuing
 *
 * Part of the memory system infrastructure.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionStartInput, HookOutput } from './shared/types.js';

const CONTAINER_NAME = 'continuous-claude-postgres';
const DOCKER_DIR = join(homedir(), '.claude', 'docker');
const MAX_WAIT_SECONDS = 30;

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
 * Wait for container to be healthy
 */
function waitForHealthy(): boolean {
  const startTime = Date.now();
  const maxWaitMs = MAX_WAIT_SECONDS * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = execSync(
        `docker inspect --format="{{.State.Health.Status}}" ${CONTAINER_NAME}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (result.trim() === 'healthy') {
        return true;
      }
    } catch {
      // Container might not have health check configured, check if running
      if (isContainerRunning()) {
        // Wait a bit for postgres to initialize
        spawnSync('sleep', ['2'], { stdio: 'pipe' });
        return true;
      }
    }
    // Wait 1 second before checking again
    spawnSync('sleep', ['1'], { stdio: 'pipe' });
  }
  return false;
}

/**
 * Main entry point
 */
export function main(): void {
  let input: SessionStartInput;
  try {
    const stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as SessionStartInput;
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Check if Docker is available
  if (!isDockerAvailable()) {
    const output: HookOutput = {
      result: 'continue',
      message: 'Docker not available - memory system will use SQLite fallback'
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Check if container is already running
  if (isContainerRunning()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Try to start the container
  const startResult = startContainer();
  if (!startResult.success) {
    const output: HookOutput = {
      result: 'continue',
      message: `Failed to start PostgreSQL container: ${startResult.message}. Memory system will use SQLite fallback.`
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Wait for container to be healthy
  const healthy = waitForHealthy();
  if (!healthy) {
    const output: HookOutput = {
      result: 'continue',
      message: 'PostgreSQL container started but not healthy yet. Memory operations may fail initially.'
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Success - container is running and healthy
  const output: HookOutput = {
    result: 'continue',
    message: 'PostgreSQL memory container started and healthy'
  };
  console.log(JSON.stringify(output));
}

// Run main if this is the entry point
main();
