#!/usr/bin/env node
/**
 * Destructive Command Guard — PreToolUse:Bash and PreToolUse:PowerShell
 *
 * Phase 1a (SAFE floor, D2g-02 / GAP3-01). Restores the human gate on
 * destructive shell operations that the permission layer otherwise auto-runs.
 *
 * Why a PreToolUse:Bash hook and NOT the permission-auto-allow PermissionRequest
 * hook (mechanism corrected via claude-code-guide research 2026-06-28):
 *   - `permissions.allow` contains "Bash", so Bash is granted BEFORE the
 *     PermissionRequest hook is ever reached — scoping that hook cannot gate Bash.
 *   - PermissionRequest is silenced entirely in bypass + headless modes.
 *   - A PreToolUse hook fires in ALL modes (default, bypass, headless) and can
 *     return permissionDecision to override an allow rule. This is the ONLY
 *     mechanism that gates destructive Bash everywhere.
 *
 * Posture (review T1 + #3 — fail-CLOSED, never hang):
 *   - destructive + interactive (default/acceptEdits/plan) → 'ask'  (prompt the human)
 *   - destructive + unattended (bypassPermissions / CLAUDE_AGENT_ID / CI) → 'deny'
 *     (structured denial; an interactive prompt in a headless loop would hang forever)
 *   - everything else → allow (empty output)
 *
 * Curated to HIGH blast radius + LOW false-positive so it does not gate routine
 * dev. Scans the whole command (catches compound `cd x && rm -rf y`) AFTER
 * stripping quoted-string contents, so destructive keywords inside a commit
 * message / echo / diagnostic do NOT false-trigger. Scope = UNQUOTED shell ops
 * (DB DROP/PowerShell Remove-Item are deliberately out — see note by the pattern list).
 * Fail-OPEN on any parse/logic error — a guard bug must never brick all Bash.
 * Override: prefix the command with SKIP_DESTRUCTIVE_GUARD=1 (detected in the
 * command string, since a PreToolUse hook does not inherit the command's env). Dave uses it;
 * the deny text does NOT mention it, because agents followed that advice 59 of 59 times.
 * Every override is logged to guard-decisions.jsonl (shared/guard-log.ts).
 *
 * Scoped cleanup (2026-10-31, replay item 9.1): a command that is exactly ONE bare `rm -rf <path>`
 * or `Remove-Item -Recurse [-Force] <path>` with one literal absolute path under the session
 * scratchpad or <repo>/.claude/worktrees/<name> is allowed in every mode and logged as an 'allow'
 * row (not 'override') with reason `scoped-cleanup:scratchpad` or `scoped-cleanup:worktree`. Rules and fail-closed checks: shared/scoped-cleanup.ts. Anything else is unchanged.
 *
 * ACCEPTED LIMITATIONS (white-box verify sweep 2026-06-29 — this is a BACKSTOP,
 * NOT a sandbox; human confirm-first + settings deny + per-tool rules also apply):
 *   - Lexical command-name evasion: "rm" / 'rm' / r\m / $'rm' / rm${IFS}-rf
 *     (quoting, escaping, or IFS-splitting the binary name) is not normalized away.
 *   - Dynamic payload to a shell: `printf '…' | sh`, `base64 -d | sh`, `bash <<<`,
 *     `bash <(…)`, `$(echo rm) -rf` — the destructive string is built at runtime
 *     and never appears intact in any scanned text.
 *   - PowerShell (tool gated since 2026-09-23): Remove-Item -Recurse and
 *     [IO.Directory]::Delete(x, $true) are caught on the PowerShell tool; still out:
 *     -EncodedCommand/-e,
 *     iex/Invoke-Expression, Start-Process, the `& 'bash'` call operator.
 *   - Too-common-to-gate: `chmod -R` / `chown -R` (chmod -R 755 is routine),
 *     `>` / `: >` / `cp /dev/null` / `tee </dev/null` truncation, trash utilities.
 *   Closing these chases an infinite tail and risks false-positives; the real
 *   threat model (a DIRECT destructive command) IS covered. The test file's
 *   "ACCEPTED limitations" block tracks them so a future close forces a doc update.
 */

import {
  classifyDestructive,
  stripQuotedStrings,
  parseExecutable,
  extractShellWrapperPayloads,
  normalizeGitGlobalOptions,
} from './shared/destructive-classifier.js';
import { isUnattended } from './shared/unattended.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { scopedCleanupKind, type ScopedCleanupDeps, type ScopedKind } from './shared/scoped-cleanup.js';
import { readShellCommand, dialectsFor } from './shared/shell-tools.js';

// Re-exported so existing imports (and the test file) keep working.
export { classifyDestructive, stripQuotedStrings, parseExecutable, extractShellWrapperPayloads, normalizeGitGlobalOptions };

interface HookInput {
  tool?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
  permission_mode?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
}

const HOOK = 'destructive-command-guard';
/** Pattern name for a shell-running MCP tool whose command field is missing or not a string. */
export const UNREADABLE_PATTERN = 'unreadable command text';

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny' | 'ask';
    permissionDecisionReason: string;
  };
}

// Unattended contexts (bypassPermissions, subagent, CI): an 'ask' would hang forever, so
// destructive ops fail CLOSED (deny). Moved to shared/unattended.ts, re-exported for the tests.
export { isUnattended };

/** `override` is set only when the override let a command through that the guard would have flagged. */
export type Decision = {
  decision: 'allow' | 'ask' | 'deny';
  pattern?: string;
  override?: boolean;
  /** Set when the scoped-cleanup rule allowed a flagged delete: which root it lay in. */
  scoped?: ScopedKind;
};

/** Reason on the decision log row for a scoped-cleanup allow, so Dave can audit these rows. */
export const SCOPED_CLEANUP_REASON = 'scoped-cleanup';

// Only these two patterns are a lone recursive delete. Any other pattern in the same command
// (the classifier returns the first match) is not the shape the scoped rule allows.
const SCOPED_PATTERNS = new Set(['recursive rm', 'PowerShell recursive delete (Remove-Item -Recurse)']);

/**
 * Decide allow/ask/deny for a Bash command. Pure — easy to unit test.
 *
 * Override: a PreToolUse hook runs in its OWN process (Claude Code's env), so an
 * inline `SKIP_DESTRUCTIVE_GUARD=1 <cmd>` prefix does NOT reach env here — it
 * sets the var only for the command's subshell. So the override is detected in
 * the COMMAND STRING (the prefix the user actually types), with the env var kept
 * as a fallback in case the parent process exports it.
 */
export function decide(
  command: string,
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
  scopedDeps?: ScopedCleanupDeps,
): Decision {
  // F2: the override is only honored as a LEADING command prefix (the env-var
  // form the user actually types), NOT as a substring anywhere — otherwise
  // `echo SKIP_DESTRUCTIVE_GUARD=1 && rm -rf x` would disable the guard.
  // PowerShell has no `VAR=1 cmd` prefix form, so its override is a leading
  // `$env:SKIP_DESTRUCTIVE_GUARD='1';` statement (still leading-only, per F2).
  const overridden = env.SKIP_DESTRUCTIVE_GUARD === '1' || /^\s*SKIP_DESTRUCTIVE_GUARD=1\s+/.test(command)
      || /^\s*\$env:SKIP_DESTRUCTIVE_GUARD\s*=\s*['"]?1['"]?\s*;/i.test(command);
  // A desktop-commander shell is chosen at run time, so its text is checked as Bash and PowerShell.
  let pattern: string | null = null;
  for (const dialect of dialectsFor(input.tool_name || input.tool)) {
    pattern = classifyDestructive(command, 0, dialect);
    if (pattern) break;
  }
  if (overridden) return pattern ? { decision: 'allow', pattern, override: true } : { decision: 'allow' };
  if (!pattern) return { decision: 'allow' };
  // Scoped cleanup (replay item 9.1): one literal recursive delete under the session scratchpad
  // or <repo>/.claude/worktrees/<name>. Allowed in every mode. Any doubt falls through to the gate.
  const scoped = SCOPED_PATTERNS.has(pattern) ? scopedCleanupKind(command, input, scopedDeps) : null;
  if (scoped) return { decision: 'allow', pattern, scoped };
  return { decision: isUnattended(input, env) ? 'deny' : 'ask', pattern };
}

export function reasonFor(decision: 'ask' | 'deny', pattern: string, command: string): string {
  const head = decision === 'deny'
    ? `BLOCKED (fail-closed): destructive command in an unattended/bypass context`
    : `CONFIRM: this is a destructive command`;
  return `${head}\n\nMatched: ${pattern}\nCommand: ${command.slice(0, 300)}\n\n${
    decision === 'deny'
      ? `An interactive confirmation would hang a headless/autonomous run, so this is denied. Ask Dave for a yes, or state the reason this command is needed. Do not work around this block.`
      : `Approve only if you intend this irreversible operation. (Gate: destructive-command-guard; see ~/.claude/docs/security/destructive-commands.md.)`
  }`;
}

async function main(): Promise<void> {
  let input: HookInput = {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) input = JSON.parse(raw);
  } catch (err) {
    logGuardError(HOOK, err);
    console.log('{}'); // fail-open on malformed input
    return;
  }

  // Bash, PowerShell (P42, 2026-09-23) and the shell-running MCP tools (F07, 2026-11-03).
  // The list and each tool's command field live in shared/shell-tools.ts.
  const shell = readShellCommand(input);
  if (shell.kind === 'not-shell') { console.log('{}'); return; }
  if (shell.kind === 'unreadable') {
    // Fail closed: a shell tool whose command text we cannot read could run anything.
    emit(input, isUnattended(input) ? 'deny' : 'ask', UNREADABLE_PATTERN, `${shell.tool} with no string field "${shell.field}"`);
    return;
  }

  const command = shell.text;
  if (!command.trim()) { console.log('{}'); return; }

  const { decision, pattern, override, scoped } = decide(command, input);
  if (override && pattern) logGuardDecision(HOOK, input, 'override', pattern, { command });
  // An 'allow' row, not 'override': a scoped delete is no bypass, and the SKIP audit counts 'override' rows.
  if (scoped) logGuardDecision(HOOK, input, 'allow', `${SCOPED_CLEANUP_REASON}:${scoped}`, { command });
  if (decision === 'allow' || !pattern) { console.log('{}'); return; }
  emit(input, decision, pattern, command);
}

/** Log the decision and print the PreToolUse envelope. */
function emit(input: HookInput, decision: 'ask' | 'deny', pattern: string, command: string): void {
  logGuardDecision(HOOK, input, decision, pattern, { command });
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reasonFor(decision, pattern, command),
    },
  };
  console.log(JSON.stringify(output));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  main().catch((err) => {
    logGuardError(HOOK, err);
    console.log('{}'); // fail-open: a guard crash must never brick Bash
  });
}
