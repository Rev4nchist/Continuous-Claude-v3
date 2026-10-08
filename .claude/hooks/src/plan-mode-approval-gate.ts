#!/usr/bin/env node
/**
 * Plan Mode Approval Gate
 *
 * PreToolUse hook on ExitPlanMode. Forces approval before ExitPlanMode
 * runs.
 *
 * In normal sessions the gate emits `permissionDecision: "ask"` so the
 * native plan-approval dialog surfaces. Empirically (Claude Code
 * v2.1.144, repro at `~/.claude/projects/.../<sid>.jsonl` around
 * `toolUseID: toolu_01DxXT1EGgUdZf7mi1buDwiK`), `ask` is silently
 * swallowed when the session was started with
 * `--dangerously-skip-permissions`: 187 ms after the gate's `ask`,
 * Claude Code's built-in PermissionRequest layer auto-allows
 * ExitPlanMode without any human in the loop. The previous header
 * comment claimed `ask` survives bypass mode -- that was wrong. The
 * gate therefore emits `permissionDecision: "deny"` whenever bypass
 * mode is detected, and `ask` in every other mode.
 *
 * Bypass detection: `input.permission_mode` is read directly. When it
 * reports `"plan"` (plan mode layered on top of an underlying session
 * mode), `detectUnderlyingPermissionMode` walks the transcript JSONL
 * backward to find the most recent non-plan `permissionMode` entry and
 * uses that as the effective mode. Both paths are kept so the hook is
 * robust whether Claude Code reports the layered or the underlying mode
 * for ExitPlanMode -- which path actually fires can change between
 * Claude Code releases without us having to redeploy.
 *
 * Behavior:
 *   - BYPASS_PLAN_GATE=1 set                   -> allow (manual override)
 *   - /goal mode is active in this session     -> allow (autonomous goal
 *                                                 mode needs to enter/exit
 *                                                 plan mode without
 *                                                 interruption; detected
 *                                                 via the `goal_status`
 *                                                 attachment that Claude
 *                                                 Code writes to the
 *                                                 transcript JSONL)
 *   - Effective permissionMode = bypassPermissions
 *                                              -> deny (ask is swallowed
 *                                                 in bypass mode, so the
 *                                                 gate must hard-block;
 *                                                 user override is the
 *                                                 BYPASS_PLAN_GATE=1 env
 *                                                 var or AskUserQuestion
 *                                                 followed by the env
 *                                                 override)
 *   - Otherwise                                -> ask (force user dialog)
 *
 * Fails open on ALL errors.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './shared/logger.js';
import { logHook } from './shared/session-activity.js';
import { logGuardDecision } from './shared/guard-log.js';

const log = createLogger('plan-mode-approval-gate');

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // The active permission mode reported by Claude Code. Observed values:
  // 'default', 'plan', 'acceptEdits', 'bypassPermissions'. When the
  // session was started with --dangerously-skip-permissions the field
  // reports 'bypassPermissions' directly OR 'plan' when plan mode is
  // layered on top -- main() resolves the layered case via the
  // transcript scan below.
  permission_mode?: string;
}

export interface GateDecisionInput {
  toolName?: string;
  bypassEnv: boolean;
  goalActive: boolean;
  // The EFFECTIVE underlying permission mode. main() is responsible for
  // resolving the layered 'plan' case via detectUnderlyingPermissionMode
  // before passing this in.
  permissionMode?: string;
}

export type GateDecision =
  | { action: 'allow' }
  | { action: 'ask'; reason: string }
  | { action: 'deny'; reason: string };

export function decideGate(params: GateDecisionInput): GateDecision {
  if (params.toolName !== 'ExitPlanMode') return { action: 'allow' };
  // Explicit overrides take priority over bypass-mode deny so that the
  // operator-set BYPASS_PLAN_GATE env var and the autonomous /goal flow
  // can still exit plan mode in a bypass session.
  if (params.bypassEnv) return { action: 'allow' };
  if (params.goalActive) return { action: 'allow' };
  if (params.permissionMode === 'bypassPermissions') {
    return {
      action: 'deny',
      reason:
        'Plan-mode approval gate: ExitPlanMode is blocked while Claude ' +
        'Code is running with --dangerously-skip-permissions. The plan-' +
        'approval dialog is suppressed in that mode, so this gate cannot ' +
        'ask. To proceed: (a) use AskUserQuestion to get explicit user ' +
        'approval, then set BYPASS_PLAN_GATE=1 in the environment and ' +
        'retry ExitPlanMode; (b) restart Claude Code without ' +
        '--dangerously-skip-permissions; or (c) run inside /goal for ' +
        'autonomous flows.',
    };
  }
  return {
    action: 'ask',
    reason:
      'Plan-mode approval gate: confirm before exiting plan mode and ' +
      'executing the proposed plan. Set BYPASS_PLAN_GATE=1 to skip this ' +
      'gate, or run /goal to auto-bypass for autonomous flows.',
  };
}

// ---------------------------------------------------------------------------
// Goal-mode detection via transcript JSONL
// ---------------------------------------------------------------------------

/**
 * Maps a project directory to the transcript directory name that Claude
 * Code uses under ~/.claude/projects/. Replaces every non-alphanumeric
 * character with a dash (matches the harness convention; e.g.
 * `C:/Users/david.hayes/continuous-claude` -> `C--Users-david-hayes-continuous-claude`).
 */
export function mangleProjectDir(projectDir: string): string {
  return projectDir.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Hard cap on transcript size we'll scan. Anything larger we treat as
 * "no goal" (the user can set BYPASS_PLAN_GATE=1 to override).
 */
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/**
 * Pure: scan transcript-tail text for the most recent goal_status entry
 * and return its activeness, or `null` if no goal_status was found.
 *
 * Returns true  -> goal is active (sentinel=true, met=false)
 * Returns false -> goal is cleared/met (any other goal_status shape)
 * Returns null  -> no goal_status found in this text window
 *
 * The harness emits a single goal_status attachment when /goal activates;
 * we walk backwards from the end to find it.
 */
export function detectGoalActiveFromTranscript(text: string): boolean | null {
  if (!text) return null;
  const lines = text.split('\n');
  // Walk backwards through the lines, returning at the most recent
  // valid goal_status attachment.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Cheap pre-filter to avoid parsing every line.
    if (!line.includes('"goal_status"')) continue;
    try {
      const obj = JSON.parse(line);
      const att = obj?.attachment;
      if (att && att.type === 'goal_status') {
        return att.sentinel === true && att.met === false;
      }
    } catch {
      // skip
    }
  }
  return null;
}

/**
 * Resolve the transcript path for (projectDir, sessionId), scan it
 * backwards in 256KB chunks, and detect whether /goal is currently active.
 *
 * The harness emits a single `goal_status` attachment per /goal command;
 * we have to walk backwards through the file to find the most recent
 * activation (or clearance) event. Hard-cap the scan at 8MB so this
 * stays bounded for very long sessions; if the goal event lives further
 * back than that, we conservatively treat goal as inactive (the user
 * can set BYPASS_PLAN_GATE=1 to override).
 *
 * Fails closed (returns false) on any error so a missing/unreadable
 * transcript never silently bypasses the gate.
 */
export function isGoalModeActive(projectDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    const mangled = mangleProjectDir(projectDir);
    const transcriptPath = join(
      homedir(),
      '.claude',
      'projects',
      mangled,
      `${sessionId}.jsonl`,
    );
    let size = 0;
    try {
      size = statSync(transcriptPath).size;
    } catch {
      return false;
    }
    if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return false;
    const text = readFileSync(transcriptPath, 'utf-8');
    return detectGoalActiveFromTranscript(text) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Underlying-permission-mode detection via transcript JSONL
// ---------------------------------------------------------------------------

/**
 * Pure: scan transcript-tail text backward for the most recent
 * `permissionMode` entry whose value is NOT `"plan"` and return that
 * value. Returns `null` if no resolvable underlying mode was found.
 *
 * Why this exists: when the user toggles plan mode (Shift+Tab) inside a
 * `--dangerously-skip-permissions` session, `input.permission_mode` on
 * the ExitPlanMode call MAY report `"plan"` (the layered mode) instead
 * of `"bypassPermissions"` (the underlying mode). We can't tell from
 * the input alone, so we mirror `isGoalModeActive`'s transcript walk
 * to find the most recent underlying mode. The gate then makes its
 * deny/ask decision off the resolved value.
 *
 * The transcript contains many JSONL line shapes; we only care about
 * entries that JSON-parse and expose a top-level `permissionMode` string.
 * Bash command lines that merely mention "permissionMode" as part of a
 * grep / cat command are filtered out by the parse + field check.
 */
export function detectUnderlyingPermissionMode(text: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Cheap pre-filter to avoid parsing every line.
    if (!line.includes('"permissionMode"')) continue;
    try {
      const obj = JSON.parse(line);
      const mode = obj?.permissionMode;
      if (typeof mode !== 'string') continue;
      if (mode === 'plan') continue;
      return mode;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/**
 * Resolve the effective permission mode by reading the transcript for
 * the given (projectDir, sessionId) and returning the most recent
 * non-plan `permissionMode`. Returns `null` if the transcript can't be
 * read or contains no resolvable entries.
 *
 * Same boundedness/safety policy as `isGoalModeActive`: hard 16MB cap,
 * fail-closed on any error so a missing transcript never bypasses the
 * gate. Caller decides what to do with `null` (treat as undefined, fall
 * back to the raw input field, etc).
 */
export function resolveEffectivePermissionMode(
  projectDir: string,
  sessionId: string,
): string | null {
  if (!sessionId) return null;
  try {
    const mangled = mangleProjectDir(projectDir);
    const transcriptPath = join(
      homedir(),
      '.claude',
      'projects',
      mangled,
      `${sessionId}.jsonl`,
    );
    let size = 0;
    try {
      size = statSync(transcriptPath).size;
    } catch {
      return null;
    }
    if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return null;
    const text = readFileSync(transcriptPath, 'utf-8');
    return detectUnderlyingPermissionMode(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------

function emitAllow(): void {
  console.log(JSON.stringify({}));
}

function emitAsk(reason: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
  console.log(JSON.stringify(output));
}

function emitDeny(reason: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  console.log(JSON.stringify(output));
}

function main(): void {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) {
      emitAllow();
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch {
      emitAllow();
      return;
    }

    if (input.tool_name !== 'ExitPlanMode') {
      emitAllow();
      return;
    }

    const sessionId = input.session_id || '';
    const bypassEnv = process.env.BYPASS_PLAN_GATE === '1';
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

    let goalActive = false;
    try {
      goalActive = isGoalModeActive(projectDir, sessionId);
    } catch {
      goalActive = false;
    }

    // Resolve the EFFECTIVE permission mode.
    //
    // We don't fully trust input.permission_mode because Claude Code may
    // report the layered mode ('plan') rather than the underlying session
    // mode ('bypassPermissions'). We implement defensively for BOTH:
    //   - If the input field reports 'plan', scan the transcript backward
    //     for the most recent non-plan permissionMode and use that.
    //   - Otherwise, the input field IS the effective mode.
    // If the transcript scan yields null we leave permissionMode undefined,
    // which falls through to the existing 'ask' path.
    const rawPermissionMode = input.permission_mode;
    let permissionMode: string | undefined = rawPermissionMode;
    if (rawPermissionMode === 'plan') {
      try {
        const resolved = resolveEffectivePermissionMode(projectDir, sessionId);
        if (resolved) permissionMode = resolved;
        else permissionMode = undefined;
      } catch {
        permissionMode = undefined;
      }
    }

    const decision = decideGate({
      toolName: input.tool_name,
      bypassEnv,
      goalActive,
      permissionMode,
    });

    try {
      logHook(sessionId, 'plan-mode-approval-gate');
    } catch {
      // Never break on activity logging
    }

    if (decision.action === 'ask') {
      log.info('Forcing plan-mode approval dialog', {
        sessionId,
        rawPermissionMode,
        permissionMode,
      });
      logGuardDecision('plan-mode-approval-gate', input, 'ask', 'exit-plan-mode-approval');
      emitAsk(decision.reason);
    } else if (decision.action === 'deny') {
      log.info('Denying ExitPlanMode in bypass-permissions mode', {
        sessionId,
        rawPermissionMode,
        permissionMode,
      });
      logGuardDecision('plan-mode-approval-gate', input, 'deny', 'exit-plan-mode-in-bypass');
      emitDeny(decision.reason);
    } else {
      log.info('Allowing ExitPlanMode without prompt', {
        sessionId,
        bypassEnv,
        goalActive,
        rawPermissionMode,
        permissionMode,
      });
      emitAllow();
    }
  } catch (err) {
    log.error('Unexpected error, failing open', { error: String(err) });
    emitAllow();
  }
}

if (!process.env.VITEST) {
  main();
}
