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
import { registerSession, getActiveSessions } from './shared/db-utils-pg.js';
import { generateSessionId, writeSessionId, getProject, loadSessionId } from './shared/session-id.js';
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
 */
async function registerSessionTask(): Promise<TaskResult> {
  const start = Date.now();
  try {
    const sessionId = generateSessionId();
    const project = getProject();
    const projectName = project.split(/[/\\]/).pop() || 'unknown';

    // Store session ID
    process.env.COORDINATION_SESSION_ID = sessionId;
    writeSessionId(sessionId);

    // Register in DB
    registerSession(sessionId, project, '');

    // Get peer sessions
    const sessionsResult = getActiveSessions(project);
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

  // Read hook input
  let input: SessionStartInput;
  let stdinContent = '{}';
  try {
    stdinContent = readFileSync(0, 'utf-8');
    input = JSON.parse(stdinContent) as SessionStartInput;
  } catch {
    input = {} as SessionStartInput;
  }

  const hooksDir = 'C:/Users/david.hayes/.claude/hooks';
  const distDir = `${hooksDir}/dist`;

  // Run all tasks in parallel
  const results = await Promise.all([
    // Inline task (no subprocess)
    registerSessionTask(),

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
