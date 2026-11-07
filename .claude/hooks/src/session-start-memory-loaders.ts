/**
 * SessionStart Hook - Memory Loaders (memory daemon warmup)
 *
 * Phase 4 system-coherence split (companion: session-start-context-loaders).
 *
 * NARROW SCOPE: Only warms the memory daemon (BGE init + recall
 * index warmup in the background). Continuity loading is already
 * covered by the live `session-start-continuity` hook; duplicating
 * it here would double-emit handoff context.
 *
 * Closes the same gap as its companion: the memory daemon was
 * orphaned because session-start-parallel.ts was never registered.
 *
 * Also reports memory health (shared/memory-health.ts): one line appended to
 * additionalContext, and the same line as systemMessage in every state, so Dave
 * sees it at the start of each session.
 * Also appends one harness-doctor line (shared/health-alert.ts) when the doctor
 * report shows a problem or is more than 36 h old; silent when healthy.
 * After /compact (stdin source = compact) it prints only problems: a degraded memory
 * line, a failing or stale doctor report, or a warning set that changed since the last
 * print. A healthy compact prints `{}`.
 * Starts a background backup (shared/memory-backup.ts) when the newest one is stale.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProject } from './shared/session-id.js';
import { isCompactSource, parseSessionSource } from './shared/session-source.js';
import { runCommand } from './lib/run-command.js';
import { getOpcDir } from './shared/opc-path.js';
import { runSessionHealth } from './shared/memory-health.js';
import { buildSessionStartOutput, isClaudeHomeProject } from './shared/session-start-output.js';
import { healthAlertForSource } from './shared/health-alert.js';

export async function main(): Promise<void> {
  const project = getProject();
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  if (isClaudeHomeProject(project, homeDir)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let stdinContent = '{}';
  try {
    stdinContent = readFileSync(0, 'utf-8');
  } catch {
    // Empty/invalid stdin is fine for SessionStart
  }
  // After /compact only problems print, and the failed-writes marker stays (shared/session-source.ts).
  const source = parseSessionSource(stdinContent);

  const hooksDir = join(homedir(), '.claude', 'hooks').replace(/\\/g, '/');
  const daemonScript = `${hooksDir}/session-start-memory-daemon.ps1`;

  // The daemon launcher was archived (lazy on-demand daemons replaced it). With the
  // file gone, `powershell -File <missing>` prints the "Windows PowerShell Copyright"
  // banner on stdout and that landed in additionalContext. Run it only when it exists,
  // and not after compact (the daemon outlives the compact).
  const [result, health] = await Promise.all([
    existsSync(daemonScript) && !isCompactSource(source)
      ? runCommand(
          'memory-daemon',
          'powershell',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', daemonScript],
          stdinContent,
          10000
        )
      : Promise.resolve({ name: 'memory-daemon', success: true, output: undefined, duration: 0 }),
    runSessionHealth({ opcDir: getOpcDir(), source }),
  ]);

  emitAndExit(buildSessionStartOutput(result.output ?? '', health, healthAlertForSource(source), source));
}

/**
 * Write the hook output, then exit. The health probe gives up after 3 s, but a
 * pg client it started can still be connecting or waiting on a query; exiting
 * here keeps that client from holding the session start open. The backup child
 * is detached, so it survives the exit.
 */
function emitAndExit(output: unknown): void {
  process.stdout.write(JSON.stringify(output) + '\n', () => process.exit(0));
}

main().catch((err) => {
  // Flush the diagnostic before the forced exit, or Node can drop it.
  const text = `memory-loaders failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
  process.stderr.write(text, () => emitAndExit({ result: 'continue' }));
});
