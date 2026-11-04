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
 * Inject text into the model's context. Valid for UserPromptSubmit,
 * PostToolUse and SessionStart.
 *
 * This is the shape the harness actually reads. Verified in production, not
 * from docs: `memory-awareness` emits it and was observed injecting on
 * 2026-07-28, in the same event and the same prompt where a hook emitting
 * `LegacyHookOutput` below was observed reaching the model with nothing.
 */
export interface ContextInjectionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart';
    additionalContext: string;
  };
  /** Shown to the user in the terminal (top-level Claude Code hook field, valid for every event). */
  systemMessage?: string;
}

/**
 * SessionStart only. Same as ContextInjectionHookOutput plus `sessionTitle`, which sets the
 * Claude Code session name (proven for interactive sessions, spike S1 2026-11-03). Keep it a
 * non-empty string or leave the key out: a field of the wrong shape makes the engine skip the
 * whole hook output, greeting included. PostToolUse shares ContextInjectionHookOutput, so the
 * key lives on its own type.
 */
export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: 'SessionStart';
    additionalContext: string;
    sessionTitle?: string;
  };
  systemMessage?: string;
}

/**
 * DISCARDED BY THE HARNESS. Not "legacy" in the sense of older-but-working --
 * `result`/`message`/`reason` are read by nothing, so a hook returning this
 * exits 0, looks healthy, and says nothing at all.
 *
 * The previous doc comment here called it "deprecated but still used by some
 * hooks", which reads as a style preference and is very likely why this
 * survived ~186 days across 19 registered hooks: nobody deprecating something
 * expects it to be inert.
 *
 * `{ result: 'continue' }` with NO message is the one honest use -- it carries
 * nothing, so it loses nothing. It is the correct "I have nothing to say"
 * signal. Anything with a `message` or `reason` belongs in
 * ContextInjectionHookOutput instead.
 */
export interface LegacyHookOutput {
  result: 'continue' | 'block';
  message?: string;
  reason?: string;
}

export type HookOutput =
  | PreToolUseHookOutput
  | ContextInjectionHookOutput
  | SessionStartHookOutput
  | LegacyHookOutput;

// =============================================================================
// Database Query Result Types
// =============================================================================

export interface QueryResult {
  success: boolean;
  stdout: string;
  stderr: string;
}
