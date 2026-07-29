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
 */

import { readFileSync } from 'fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProject } from './shared/session-id.js';
import type { SessionStartInput, HookOutput } from './shared/types.js';
import { runCommand } from './lib/run-command.js';

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

  const result = await runCommand(
    'memory-daemon',
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', `${hooksDir}/session-start-memory-daemon.ps1`],
    stdinContent,
    10000
  );

  const message = result.output ?? '';
  const output: HookOutput = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } };
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('memory-loaders failed:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
