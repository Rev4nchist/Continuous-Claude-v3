/**
 * identity-probe.ts — a read-only instrument, not a control.
 *
 * Settles three questions that the coordination repair depends on and that no
 * amount of code reading can answer, because they are all about what the RUNTIME
 * actually hands a hook process:
 *
 *   Q1  Is `payload.session_id` distinct per subagent and stable per process
 *       tree? The plan assumes yes, and that assumption is what lets us delete
 *       generateSessionId() instead of building a new agent_id scheme.
 *
 *   Q2  Does an env var exported by the launching terminal (CC_TERMINAL_ID)
 *       actually reach a SUBAGENT's hook process? The sibling rule -- "same
 *       terminal is a warn, a stranger is a block" -- is unimplementable if it
 *       does not. ENV_INHERITED_MARKERS below double as a proxy: if vars the
 *       parent shell exported are visible here, CC_TERMINAL_ID will be too.
 *
 *   Q3  Do the main tree and a worktree agree on a canonical project key?
 *       Verified 2026-07-26 for --git-common-dir; this records it per-event so
 *       the answer is captured under real hook conditions rather than in a
 *       one-off shell.
 *
 * Writes one JSONL line per hook event to .claude/logs/identity-probe.jsonl.
 * Never blocks, never denies, never mutates coordination state. Fail-open on
 * every path: a probe that can break a session is worse than no probe.
 *
 * REMOVE ME once steps 2-3 land. This is scaffolding with an expiry date.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';

/** Env vars whose presence here proves parent-shell inheritance reaches hooks. */
const ENV_INHERITED_MARKERS = [
  'CC_TERMINAL_ID',        // the one we actually care about (may be unset)
  'CLAUDE_AGENT_ID',       // set by Claude Code for subagents
  'CLAUDE_PROJECT_DIR',
  'COORDINATION_SESSION_ID',
  'CLAUDE_OPC_DIR',        // exported by the user profile -> proxy for Q2
  'DATABASE_URL',          // exported by the user profile -> proxy for Q2
  'BRAINTRUST_SPAN_ID',
];

function readStdin(): string {
  try {
    // fd 0, sync — hooks get a complete payload up front, no streaming needed.
    // Top-level import only: these bundle to ESM, where require() is undefined.
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * The canonical project key the repair should adopt: identical from the main
 * tree and from any linked worktree, and normalized by git itself (verified:
 * an 8.3 short path in, long canonical path out). Slash direction is forced so
 * `C:/x` and `C:\x` cannot become two identities — the exact split that today
 * fragments 70% of file_claims rows across duplicate spellings.
 */
function gitCommonRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // --git-common-dir is the MAIN repo's .git even when called from a linked
    // worktree (verified 2026-07-26: byte-identical from both, ordinal compare).
    // That is precisely why it is the right anchor -- worktrees of one repo
    // must share one identity, which --show-toplevel would not give us.
    return out ? out.replace(/\\/g, '/').replace(/\/\.git$/, '') : null;
  } catch {
    return null;
  }
}

function canonicalProjectKey(cwd: string): string | null {
  const root = gitCommonRoot(cwd);
  return root ? root.toLowerCase() : null;
}

function main(): void {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    payload = {};
  }

  const cwd = (payload.cwd as string) || process.cwd();

  const env: Record<string, string | null> = {};
  for (const k of ENV_INHERITED_MARKERS) {
    env[k] = process.env[k] ?? null;
  }

  const row = {
    ts: new Date().toISOString(),
    event: payload.hook_event_name ?? null,
    // Q1 — the id the platform hands us. Compare across main session vs subagents.
    payload_session_id: payload.session_id ?? null,
    // What the CURRENT (broken) code would use instead, for side-by-side contrast.
    legacy_env_session_id: process.env.COORDINATION_SESSION_ID ?? null,
    // Q2 — env inheritance reaching this process.
    env,
    // Q3 — project identity, old vs proposed.
    project_legacy: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    project_canonical: canonicalProjectKey(cwd),
    cwd,
    // Process tree — lets us tell a subagent's hook from the main session's.
    pid: process.pid,
    ppid: process.ppid,
    tool: payload.tool_name ?? null,
  };

  try {
    // Anchor the log to the MAIN repo root, never process.cwd(). A hook invoked
    // from .claude/hooks would otherwise write to .claude/hooks/.claude/logs/ --
    // observed on the first smoke test, and the same cwd-sensitivity that split
    // file_claims.project into two spellings for one repo.
    const logRoot =
      gitCommonRoot(cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const logPath = join(logRoot, '.claude', 'logs', 'identity-probe.jsonl');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf-8');
  } catch {
    // Swallow. A probe must never be the reason a session fails.
  }
}

try {
  main();
} catch {
  /* fail-open */
}

process.exit(0);
