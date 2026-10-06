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
