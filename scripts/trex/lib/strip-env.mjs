// Copy an env without the Anthropic credentials and the Claude Code session variables.
// Every TREX child process gets this env. Bench and agent code import it too.

const BLOCKED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const BLOCKED_PREFIX = 'CLAUDE_CODE_';

/** Windows env names ignore case, so match on the upper-case name. */
function isBlocked(key) {
  const upper = key.toUpperCase();
  return BLOCKED.has(upper) || upper.startsWith(BLOCKED_PREFIX);
}

/** Returns a new object. PATH (any case) and every other key stay. The input is not changed. */
export function stripEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isBlocked(key)) out[key] = value;
  }
  return out;
}
