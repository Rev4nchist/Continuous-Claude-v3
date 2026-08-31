/**
 * SessionStart Hook - Parallel Startup Orchestrator
 *
 * Runs multiple startup operations in parallel to reduce session startup time.
 * Previous sequential chain: ~80s worst case
 * Parallel execution: ~30s worst case (limited by Docker startup)
 *
 * Operations run in parallel:
 * - Session registration (DB)
 * - Continuity loading (handoffs)
 * - Init check (files)
 * - Tree daemon startup
 * - Memory daemon startup
 *
 * Note: Docker hook runs BEFORE this to ensure DB is available.
 */

import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerSession, getActiveSessions } from './shared/db-utils-pg.js';
import {
  writeSessionId,
  getProject,
  resolveSessionId,
  canonicalProject,
} from './shared/session-id.js';
import type { SessionStartInput, HookOutput } from './shared/types.js';

interface TaskResult {
  name: string;
  success: boolean;
  message?: string;
  output?: string;
  error?: string;
  duration: number;
}

/**
 * Run a command asynchronously with timeout
 */
function runCommand(
  name: string,
  command: string,
  args: string[],
  stdinData: string,
  timeoutMs: number = 10000
): Promise<TaskResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      // Try to parse output as JSON hook result
      let output: string | undefined;
      try {
        const parsed = JSON.parse(stdout.trim());
        output = parsed.message;
      } catch {
        output = stdout.trim() || undefined;
      }

      resolve({
        name,
        success: code === 0,
        output,
        message: code === 0 ? 'OK' : `Exit ${code}`,
        error: stderr.trim() || undefined,
        duration: Date.now() - start
      });
    });

    proc.on('error', (err) => {
      resolve({
        name,
        success: false,
        error: err.message,
        duration: Date.now() - start
      });
    });

    // Provide stdin data
    proc.stdin?.write(stdinData);
    proc.stdin?.end();
  });
}

/**
 * Session registration task (inline - no subprocess needed)
 *
 * Takes the hook payload because coordination identity MUST come from it. This
 * hook is not registered in either settings.json today, so it is dead code -- but
 * it registers sessions and therefore seeds the identity that file_claims rows are
 * filed under. It previously called generateSessionId() + getProject(), which are
 * both halves of the bug ca1a16e fixed in session-register.ts: an `s-*` identity no
 * other hook agreed on (heartbeat used the payload id, so every session wrote TWO
 * rows and claims were filed under the one whose heartbeat froze at session start),
 * and an unnormalized project key that split one repo across a backslash and a
 * forward-slash namespace. Together those produced 8,179 claims of which 0 were
 * owned by a session that looked alive. Registering this hook unfixed would have
 * silently reinstated all of it, so it is corrected here rather than left armed.
 */
async function registerSessionTask(input: SessionStartInput): Promise<TaskResult> {
  const start = Date.now();
  try {
    const sessionId = resolveSessionId(input.session_id);
    const project = canonicalProject(input.cwd);
    const projectName = project.split('/').pop() || 'unknown';

    // Store session ID
    process.env.COORDINATION_SESSION_ID = sessionId;
    writeSessionId(sessionId);

    // Register in DB
    await registerSession(sessionId, project, '');

    // Get peer sessions
    const sessionsResult = await getActiveSessions(project);
    const otherSessions = sessionsResult.sessions.filter(s => s.id !== sessionId);

    // Build awareness message
    let output = `Session: ${sessionId}\nProject: ${projectName}\n`;
    if (otherSessions.length > 0) {
      output += `Active peers: ${otherSessions.length}`;
    }

    return {
      name: 'session-register',
      success: true,
      output,
      message: `Registered, ${otherSessions.length} peers`,
      duration: Date.now() - start
    };
  } catch (err) {
    return {
      name: 'session-register',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start
    };
  }
}

/**
 * Main entry point - runs all startup tasks in parallel
 */
export async function main(): Promise<void> {
  const totalStart = Date.now();
  const project = getProject();
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const claudeDir = homeDir ? `${homeDir}/.claude`.replace(/\\/g, '/') : '';
  const normalizedProject = project.replace(/\\/g, '/');

  // Skip heavy startup ops when editing hooks themselves
  // Prevents self-referential loops and freezes in ~/.claude
  if (claudeDir && (normalizedProject === claudeDir || normalizedProject.includes('/.claude'))) {
    console.log(JSON.stringify({
      result: 'continue',
      message: '<system-reminder>\nSessionStart:clear hook success: Success\n</system-reminder>\nStartup hooks skipped in ~/.claude (infrastructure directory)'
    }));
    return;
  }

  // Read hook input
  let input: SessionStartInput;
  let stdinContent = '{}';
  try {
    stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as SessionStartInput;
  } catch {
    input = {} as SessionStartInput;
  }

  const hooksDir = join(homedir(), '.claude', 'hooks').replace(/\\/g, '/');
  const distDir = `${hooksDir}/dist`;

  // Run all tasks in parallel
  const results = await Promise.all([
    // Inline task (no subprocess). Payload passed so coordination identity comes
    // from the id every hook agrees on, not a locally generated one.
    registerSessionTask(input),

    // Node.js hooks
    runCommand(
      'continuity',
      'node',
      [`${distDir}/session-start-continuity.mjs`],
      stdinContent,
      10000
    ),
    runCommand(
      'init-check',
      'node',
      [`${distDir}/session-start-init-check.mjs`],
      stdinContent,
      5000
    ),

    // PowerShell daemon scripts
    runCommand(
      'tree-daemon',
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', `${hooksDir}/session-start-tree-daemon.ps1`],
      stdinContent,
      15000
    ),
    runCommand(
      'memory-daemon',
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', `${hooksDir}/session-start-memory-daemon.ps1`],
      stdinContent,
      10000
    ),
  ]);

  const totalDuration = Date.now() - totalStart;

  // Collect output messages from successful hooks
  const outputs: string[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.output) {
      outputs.push(result.output);
    }
    if (!result.success && result.error) {
      errors.push(`${result.name}: ${result.error}`);
    }
  }

  // Build combined message
  let message = '';

  // Add outputs from hooks (continuity context, init warnings, etc.)
  if (outputs.length > 0) {
    message = outputs.join('\n\n');
  }

  // Add timing summary (useful for debugging)
  const timingSummary = results.map(r => `${r.name}:${r.duration}ms`).join(' ');

  // Add success indicator
  message = `<system-reminder>
SessionStart:compact hook success: Success
</system-reminder>` + (message ? `\n${message}` : '');

  // Output hook result
  const output: HookOutput = {
    result: 'continue',
    message,
  };

  console.log(JSON.stringify(output));
}

// Run if executed directly
main().catch(err => {
  console.error('Parallel startup failed:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
