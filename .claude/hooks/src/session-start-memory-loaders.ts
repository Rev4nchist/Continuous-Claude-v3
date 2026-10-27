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
 * additionalContext, and a systemMessage for the warning states so Dave sees it.
 * Starts a background backup (shared/memory-backup.ts) when the newest one is stale.
 */

import { readFileSync } from 'fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProject } from './shared/session-id.js';
import type { SessionStartInput, ContextInjectionHookOutput } from './shared/types.js';
import { runCommand } from './lib/run-command.js';
import { getOpcDir } from './shared/opc-path.js';
import { runSessionHealth } from './shared/memory-health.js';

export async function main(): Promise<void> {
  const project = getProject();
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const claudeDir = homeDir ? `${homeDir}/.claude`.replace(/\\/g, '/') : '';
  const normalizedProject = project.replace(/\\/g, '/');

  if (claudeDir && (normalizedProject === claudeDir || normalizedProject.includes('/.claude'))) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let stdinContent = '{}';
  try {
    stdinContent = readFileSync(0, 'utf-8');
    JSON.parse(stdinContent) as SessionStartInput;
  } catch {
    // Empty/invalid stdin is fine for SessionStart
  }

  const hooksDir = join(homedir(), '.claude', 'hooks').replace(/\\/g, '/');

  const [result, health] = await Promise.all([
    runCommand(
      'memory-daemon',
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', `${hooksDir}/session-start-memory-daemon.ps1`],
      stdinContent,
      10000
    ),
    runSessionHealth({ opcDir: getOpcDir() }),
  ]);

  const message = [result.output ?? '', health.line].filter(Boolean).join('\n');
  const output: ContextInjectionHookOutput = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } };
  if (health.warn) output.systemMessage = health.line;
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('memory-loaders failed:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
