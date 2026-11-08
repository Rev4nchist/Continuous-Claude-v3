/**
 * SessionStart Hook - Context Loaders (knowledge tree daemon warmup)
 *
 * Phase 4 system-coherence split (companion: session-start-memory-loaders).
 *
 * NARROW SCOPE: Only warms the knowledge-tree daemon. Session
 * registration, continuity, and init-check are already covered by
 * standalone live SessionStart hooks (session-register,
 * session-start-continuity, session-start-init-check); duplicating
 * them here would double-write DB rows.
 *
 * This hook closes a real gap: the tree daemon was orphaned because
 * its only caller (session-start-parallel.ts) was never registered.
 */

import { existsSync, readFileSync } from 'fs';
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

  // Skip in ~/.claude infrastructure dir to avoid self-referential loops
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

  // The launcher was deleted (d172936a). Without this check every start and compact ran
  // PowerShell on a missing file. Skip silently when it is absent.
  const treeDaemonScript = `${hooksDir}/session-start-tree-daemon.ps1`;
  if (!existsSync(treeDaemonScript)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const result = await runCommand(
    'tree-daemon',
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', treeDaemonScript],
    stdinContent,
    15000
  );

  const message = result.output ?? '';
  const output: HookOutput = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } };
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('context-loaders failed:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
