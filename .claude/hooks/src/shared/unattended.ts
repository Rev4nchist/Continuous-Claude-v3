/**
 * Unattended = no human is available to answer an interactive prompt.
 *
 * Shared by destructive-command-guard (an 'ask' would hang forever, so it denies) and
 * commit-preflight (it downgrades its 'ask' to advisory context). Kept in its own module so
 * one hook never imports another hook's source: a hook file runs `main()` at load, and the
 * esbuild bundle would carry that call into the importer (two stdin reads, two JSON outputs).
 *
 * bypassPermissions counts as unattended: even there, the guards act as a circuit breaker.
 * Headless `claude -p` is NOT detected: a hook's stdio is always a pipe, and the payload has no
 * headless flag.
 */
export function isUnattended(
  input: { permission_mode?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.permission_mode === 'bypassPermissions') return true;
  if (env.CLAUDE_AGENT_ID) return true;          // subagent context
  if (env.CI === 'true' || env.CI === '1') return true;
  return false;
}

/**
 * A typed SKIP_ override (SKIP_DESTRUCTIVE_GUARD, SKIP_PACKAGE_GUARD, SKIP_PRE_PR_GATE) works only where a person can
 * answer for it. It is ignored when the run is unattended (isUnattended) or when Claude Code says no one is attending
 * the session: a headless `claude -p` sets CLAUDE_CODE_SESSION_ATTENDED=0 in the env that its hooks inherit (read from a real
 * run, card guard-skip-prefix-unattended, capture 02). A missing variable counts as attended. isUnattended stays as it is:
 * commit-preflight and the ask-to-deny choices of every guard use it, and this card changes only the override.
 * The hook reads its own env here. A typed `CLAUDE_CODE_SESSION_ATTENDED=1 cmd` reaches only the command's subshell.
 */
export function overrideLocked(
  input: { permission_mode?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isUnattended(input, env) || env.CLAUDE_CODE_SESSION_ATTENDED === '0';
}

/** The sentence a guard adds to its deny or ask text when a typed override was ignored (or none works in this run). */
export const OVERRIDE_IGNORED_NOTE = 'A typed SKIP_ override is ignored in an unattended or bypass run. Ask Dave to run it, or leave bypass mode.';
