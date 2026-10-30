#!/usr/bin/env node
/**
 * Heartbeat Hook - Updates session last_heartbeat on each user prompt
 *
 * Runs on UserPromptSubmit to keep the session marked as active
 * in the cross-terminal coordination database.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { registerSession } from './shared/db-utils-pg.js';
import { resolveSessionId, canonicalProject, normalizeProjectKey } from './shared/session-id.js';

// Cache heartbeat to avoid DB update on every prompt
const CACHE_TTL_MS = 30000;  // 30 seconds
const CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'heartbeat-last.json');

function shouldUpdateHeartbeat(sessionId: string): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return true;
    const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (cache.sessionId !== sessionId) return true;
    const elapsed = Date.now() - cache.timestamp;
    return elapsed >= CACHE_TTL_MS;
  } catch {
    return true;
  }
}

function updateCache(sessionId: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ sessionId, timestamp: Date.now() }));
  } catch {
    // Ignore cache write failures
  }
}

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
}

/**
 * The job. Takes the raw stdin text so prompt-submit can run it in one process with
 * the other prompt hooks. Returns what main() prints. Never writes to stdout.
 */
export async function runHeartbeat(raw: string): Promise<object> {
  try {
    return await heartbeatJob(raw);
  } catch (err) {
    console.error('Heartbeat error:', err);
    return { result: 'continue' };
  }
}

async function heartbeatJob(raw: string): Promise<object> {
  let input: HookInput = {};

  try {
    const rawInput = raw.trim();
    if (rawInput) {
      input = JSON.parse(rawInput);
    }
  } catch {
    // Ignore parse errors
  }

  // heartbeat was already payload-first and therefore already correct; it is the
  // other two hooks that were moved onto its identity. The project key, though,
  // was raw cwd -- the forward-slash half of the two-spelling split.
  const sessionId = resolveSessionId(input.session_id);
  const project = canonicalProject(input.cwd);

  // Guard: Skip in ~/.claude (infrastructure directory)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (homeDir) {
    // Both sides go through normalizeProjectKey: `project` is now lowercased by
    // canonicalProject(), so comparing it against a raw `C:/Users/...` path
    // would never match on Windows. The endsWith check alone would still have
    // caught it, but a silently-dead equality test is how the next bug hides.
    const claudeDir = normalizeProjectKey(homeDir + '/.claude');
    const normalizedProject = normalizeProjectKey(project);
    if (normalizedProject === claudeDir || normalizedProject.endsWith('/.claude')) {
      return { result: 'continue' };
    }
  }

  // Extract first line of prompt as "working on" context (max 100 chars)
  const workingOn = input.prompt
    ? input.prompt.split('\n')[0].substring(0, 100)
    : undefined;

  // Skip DB update if within cache TTL (30s) for same session
  if (!shouldUpdateHeartbeat(sessionId)) {
    return { result: 'continue' };
  }

  // Update session heartbeat via registerSession (upserts)
  const result = await registerSession(sessionId, project, workingOn);

  if (!result.success) {
    console.error(`Heartbeat update failed: ${result.error}`);
  } else {
    updateCache(sessionId);
  }

  return { result: 'continue' };
}

async function main(): Promise<void> {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch {
    // No stdin: the job treats it as an empty payload.
  }
  console.log(JSON.stringify(await runHeartbeat(raw)));
}

// Run only when started as dist/heartbeat.mjs. The old bare `main()` ran on import,
// so the combined prompt-submit bundle would have read stdin a second time. The
// check is the file's basename, not `includes`: a directory named like a hook
// must not start it.
if (/(^|[\\/])heartbeat\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch((err) => {
    console.error('Heartbeat error:', err);
    console.log(JSON.stringify({ result: 'continue' }));
  });
}
