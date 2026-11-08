/**
 * Pure logic for the SessionStart memory hook (session-start-memory-loaders.ts).
 *
 * It lives here, not in the hook, because the hook calls main() at module scope and a
 * test cannot import it. esbuild builds only `src/*.ts` as entries, so this file is
 * bundled into the hook and never built on its own.
 */
import type { ContextInjectionHookOutput } from './types.js';
import type { HealthLine } from './memory-health.js';
import { isCompactSource } from './session-source.js';

/**
 * True when `project` is the claude home dir or a path inside it. The hook skips
 * these sessions. A project that only has `/.claude` somewhere in its path (a repo
 * worktree under `.claude/worktrees`) is a normal project and returns false.
 */
export function isClaudeHomeProject(project: string, home: string): boolean {
  if (!home) return false;
  const p = project.replace(/\\/g, '/').toLowerCase();
  const h = home.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return p === `${h}/.claude` || p.startsWith(`${h}/.claude/`);
}

/**
 * Build the hook output. At startup the health line goes to the model (additionalContext)
 * and to Dave's terminal (systemMessage) in every state, so a healthy store is visible too.
 * `harnessLine` (shared/health-alert.ts) goes after it in both places, only when there is one.
 *
 * After /compact (`source` = 'compact') the session is the same one, so only problems print:
 * a degraded memory line (`health.warn`) and the harness line. Nothing to say gives `{}`.
 */
export function buildSessionStartOutput(
  daemonOutput: string,
  health: HealthLine,
  harnessLine?: string | null,
  source?: string,
): ContextInjectionHookOutput | Record<string, never> {
  const compact = isCompactSource(source);
  const healthLine = compact && !health.warn ? '' : health.line;
  const daemon = compact ? '' : daemonOutput;
  const additionalContext = [daemon, healthLine, harnessLine].filter(Boolean).join('\n');
  if (compact && additionalContext === '') return {};
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    systemMessage: [healthLine, harnessLine].filter(Boolean).join('\n'),
  };
}
