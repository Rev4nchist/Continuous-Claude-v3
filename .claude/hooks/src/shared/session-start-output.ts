/**
 * Pure logic for the SessionStart memory hook (session-start-memory-loaders.ts).
 *
 * It lives here, not in the hook, because the hook calls main() at module scope and a
 * test cannot import it. esbuild builds only `src/*.ts` as entries, so this file is
 * bundled into the hook and never built on its own.
 */
import type { ContextInjectionHookOutput } from './types.js';
import type { HealthLine } from './memory-health.js';

/**
 * True when `project` is the claude home dir or a path inside it. The hook skips
 * these sessions. A project that only has `/.claude` somewhere in its path (a repo
 * worktree under `.claude/worktrees`) is a normal project and returns false.
 */
export function isClaudeHomeProject(project: string, home: string): boolean {
  if (!home) return false;
  const p = project.replace(/\\/g, '/').toLowerCase();
  const h = home.replace(/\\/g, '/').toLowerCase();
  return p === `${h}/.claude` || p.startsWith(`${h}/.claude/`);
}

/**
 * Build the hook output. The health line goes to the model (additionalContext) and to
 * Dave's terminal (systemMessage) in every state, so a healthy store is visible too.
 */
export function buildSessionStartOutput(
  daemonOutput: string,
  health: HealthLine,
): ContextInjectionHookOutput {
  const additionalContext = [daemonOutput, health.line].filter(Boolean).join('\n');
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    systemMessage: health.line,
  };
}
