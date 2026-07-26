/**
 * Shared type definitions for Claude Code hooks.
 *
 * Centralizes interface definitions to avoid duplication across:
 * - pattern-router.ts
 * - db-utils.ts
 * - patterns/swarm.ts
 * - subagent-start.ts
 * - pre-tool-use.ts
 *
 * Part of the pattern-aware hooks infrastructure.
 * See: thoughts/shared/plans/2025-12-28-pattern-aware-hooks.md
 */

// =============================================================================
// Hook Input Types
// =============================================================================

export interface SubagentStartInput {
  session_id: string;
  agent_id?: string | null;
  agent_type?: string;
}

export interface SubagentStopInput {
  session_id: string;
  agent_id?: string | null;
  agent_type?: string;
}

/**
 * SessionStart payload.
 *
 * NOTE: session-register.ts has imported this type since it was written, but it
 * was never actually declared here -- esbuild strips type imports without
 * checking them, so the build stayed green while `input` silently had no type.
 * Declared 2026-07-26 while fixing the identity split that lives in that file.
 *
 * `source` distinguishes startup / resume / clear / compact. Not used yet, but
 * it is the field to reach for if duplicate SessionStart rows ever reappear.
 */
export interface SessionStartInput {
  session_id: string;
  source?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Present in the real payload (verified by identity-probe 2026-07-26); it is
   *  the project dir the session was launched in, and the input to
   *  canonicalProject(). Optional so existing test fixtures stay valid. */
  cwd?: string;
}

export interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}

export interface StopInput {
  session_id: string;
  stop_hook_active?: boolean;
}

// =============================================================================
// Hook Output Types (Claude Code v1.0.21+ format)
// =============================================================================

/**
 * PreToolUse hook-specific output format.
 *
 * Per Claude Code docs:
 * - permissionDecision: "allow" | "deny" | "ask"
 * - permissionDecisionReason: shown to Claude when blocked
 * - updatedInput: modify tool input before execution
 */
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

/**
 * Legacy hook output format (deprecated but still used by some hooks).
 * Prefer PreToolUseHookOutput for new hooks.
 */
export interface LegacyHookOutput {
  result: 'continue' | 'block';
  message?: string;
  reason?: string;
}

export type HookOutput = PreToolUseHookOutput | LegacyHookOutput;

// =============================================================================
// Database Query Result Types
// =============================================================================

export interface QueryResult {
  success: boolean;
  stdout: string;
  stderr: string;
}
