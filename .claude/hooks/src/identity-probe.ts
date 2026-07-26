/**
 * identity-probe.ts — a read-only instrument, not a control.
 *
 * Settles three questions that the coordination repair depends on and that no
 * amount of code reading can answer, because they are all about what the RUNTIME
 * actually hands a hook process:
 *
 *   Q1  ANSWERED 2026-07-26, and the answer inverts the plan's assumption.
 *       `payload.session_id` is stable per process tree but NOT distinct per
 *       subagent: a scout subagent's PostToolUse hook reported the SAME
 *       session_id as the main session (509d86fd-...), with CLAUDE_AGENT_ID
 *       unset and an identical ppid. So the platform does NOT hand us a
 *       ready-made agent_id, and payload-first identity will NOT cause subagent
 *       fan-out to block against its parent -- they share one identity.
 *
 *   Q2  Partially answered. CLAUDE_OPC_DIR and DATABASE_URL -- exported by the
 *       user profile, not by Claude Code -- ARE visible in hook processes, so
 *       parent-shell env inheritance reaches hooks. CC_TERMINAL_ID itself is
 *       still unset on this machine, so the sibling rule remains untested end
 *       to end; set it in a launcher and this probe will capture it.
 *
 *   Q3  ANSWERED 2026-07-26, yes. --git-common-dir is byte-identical from the
 *       main tree and from a linked worktree (ordinal compare), and git
 *       normalizes 8.3 short paths. Recorded per-event as project_canonical
 *       alongside the broken project_legacy for contrast.
 *
 *   Also established: SessionStart does NOT fire for subagents. session-register
 *   is registered on SessionStart with no matcher and has no early-exit guard,
 *   yet a subagent run produced no sessions row and did not rewrite
 *   ~/.claude/.coordination-session-id. Mid-session hook registration WAS live
 *   at the time (proven separately), so this is a real negative, not a
 *   not-yet-loaded artifact.
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
    // Process tree. NOTE (verified 2026-07-26): ppid is IDENTICAL for a
    // subagent's hook and the main session's -- both are spawned by the same
    // Claude Code process -- so ppid does NOT discriminate. Kept for the record.
    pid: process.pid,
    ppid: process.ppid,
    tool: payload.tool_name ?? null,
    // The last untested discriminator. session_id is shared with the parent and
    // CLAUDE_AGENT_ID is unset, so if anything distinguishes a subagent's tool
    // call from its parent's, transcript_path is the remaining candidate.
    transcript_path: payload.transcript_path ?? null,
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
