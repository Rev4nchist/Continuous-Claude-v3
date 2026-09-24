/**
 * Tests for plan-mode-approval-gate PreToolUse hook.
 *
 * The gate forces approval before ExitPlanMode runs. In normal mode it
 * emits `permissionDecision: "ask"` to surface the interactive dialog.
 * In `--dangerously-skip-permissions` (bypass) mode, Claude Code v2.1.144
 * silently swallows the `ask` and auto-approves via PermissionRequest, so
 * the gate emits `permissionDecision: "deny"` instead.
 *
 * Decision matrix:
 *   - Non-ExitPlanMode tool                              -> allow
 *   - ExitPlanMode + BYPASS_PLAN_GATE=1                  -> allow
 *   - ExitPlanMode + /goal active                        -> allow
 *   - ExitPlanMode + permissionMode = bypassPermissions  -> deny
 *   - ExitPlanMode + permissionMode = plan/acceptEdits   -> ask
 *   - ExitPlanMode + no bypass + no goal                 -> ask
 */

import { describe, it, expect } from 'vitest';
import {
  decideGate,
  detectGoalActiveFromTranscript,
  detectUnderlyingPermissionMode,
  mangleProjectDir,
} from '../plan-mode-approval-gate.js';

describe('decideGate', () => {
  const base = {
    toolName: 'ExitPlanMode',
    bypassEnv: false,
    goalActive: false,
  };

  it('allows non-ExitPlanMode tools', () => {
    expect(decideGate({ ...base, toolName: 'Bash' }).action).toBe('allow');
  });

  it('allows when toolName is undefined', () => {
    expect(decideGate({ ...base, toolName: undefined }).action).toBe('allow');
  });

  it('allows ExitPlanMode when BYPASS_PLAN_GATE=1', () => {
    expect(decideGate({ ...base, bypassEnv: true }).action).toBe('allow');
  });

  it('allows ExitPlanMode when /goal is active', () => {
    expect(decideGate({ ...base, goalActive: true }).action).toBe('allow');
  });

  it('asks for confirmation when no bypass signal is set', () => {
    const result = decideGate(base);
    expect(result.action).toBe('ask');
    if (result.action === 'ask') {
      expect(result.reason).toContain('Plan-mode approval gate');
      expect(result.reason).toContain('BYPASS_PLAN_GATE=1');
      expect(result.reason).toContain('/goal');
    }
  });

  it('bypass env takes priority over ask', () => {
    expect(decideGate({ ...base, bypassEnv: true, goalActive: false }).action).toBe('allow');
  });

  // ---------------------------------------------------------------------------
  // Bypass-mode (`--dangerously-skip-permissions`) handling.
  //
  // In bypass mode, Claude Code v2.1.144 silently swallows
  // `permissionDecision: "ask"` and auto-approves ExitPlanMode via the
  // PermissionRequest layer ~187 ms later. To make the gate effective, we
  // emit `deny` when permissionMode === 'bypassPermissions'. Every existing
  // allow path (env override, /goal) must still win over deny so
  // autonomous flows are unaffected.
  // ---------------------------------------------------------------------------

  it('denies ExitPlanMode when permissionMode is bypassPermissions', () => {
    const result = decideGate({ ...base, permissionMode: 'bypassPermissions' });
    expect(result.action).toBe('deny');
  });

  it('bypass env wins over bypass-mode deny', () => {
    const result = decideGate({
      ...base,
      bypassEnv: true,
      permissionMode: 'bypassPermissions',
    });
    expect(result.action).toBe('allow');
  });

  it('goalActive wins over bypass-mode deny', () => {
    const result = decideGate({
      ...base,
      goalActive: true,
      permissionMode: 'bypassPermissions',
    });
    expect(result.action).toBe('allow');
  });

  it('permissionMode default produces ask', () => {
    const result = decideGate({ ...base, permissionMode: 'default' });
    expect(result.action).toBe('ask');
  });

  it('permissionMode plan produces ask', () => {
    // Plan mode layered on top of a non-bypass underlying mode: still ask.
    const result = decideGate({ ...base, permissionMode: 'plan' });
    expect(result.action).toBe('ask');
  });

  it('permissionMode acceptEdits produces ask (NOT treated as bypass)', () => {
    // acceptEdits suppresses Edit/Write dialogs only, not ExitPlanMode.
    // Guard against future scope creep that conflates the two.
    const result = decideGate({ ...base, permissionMode: 'acceptEdits' });
    expect(result.action).toBe('ask');
  });

  it('deny reason contains override + bypass-mode keywords', () => {
    const result = decideGate({ ...base, permissionMode: 'bypassPermissions' });
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.reason).toContain('BYPASS_PLAN_GATE');
      expect(result.reason).toContain('AskUserQuestion');
      expect(result.reason).toContain('--dangerously-skip-permissions');
      expect(result.reason).toContain('/goal');
    }
  });
});

describe('mangleProjectDir', () => {
  it('replaces non-alphanumeric characters with dashes', () => {
    expect(mangleProjectDir('C:/Users/david.hayes/continuous-claude')).toBe(
      'C--Users-david-hayes-continuous-claude',
    );
  });

  it('handles backslash paths', () => {
    expect(mangleProjectDir('C:\\Users\\david.hayes\\project')).toBe(
      'C--Users-david-hayes-project',
    );
  });

  it('handles unix paths', () => {
    expect(mangleProjectDir('/home/user/proj')).toBe('-home-user-proj');
  });
});

describe('detectGoalActiveFromTranscript', () => {
  function attachmentLine(att: Record<string, unknown>): string {
    return JSON.stringify({ type: 'attachment', attachment: att, otherField: 1 });
  }

  it('returns null for empty input', () => {
    expect(detectGoalActiveFromTranscript('')).toBe(null);
  });

  it('returns null when no goal_status attachments exist', () => {
    const text = ['{"type":"user","content":"hi"}', '{"type":"assistant","content":"hello"}'].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(null);
  });

  it('returns true when latest goal_status is sentinel=true, met=false', () => {
    const text = [
      attachmentLine({ type: 'goal_status', sentinel: true, met: false, condition: 'do X' }),
      '{"type":"assistant","content":"working"}',
    ].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(true);
  });

  it('returns false when latest goal_status is met=true (goal complete)', () => {
    const text = [
      attachmentLine({ type: 'goal_status', sentinel: true, met: false }),
      attachmentLine({ type: 'goal_status', sentinel: true, met: true }),
    ].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(false);
  });

  it('returns false when latest goal_status is sentinel=false (goal cleared)', () => {
    const text = [
      attachmentLine({ type: 'goal_status', sentinel: true, met: false }),
      attachmentLine({ type: 'goal_status', sentinel: false, met: false }),
    ].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(false);
  });

  it('returns true when a single goal_status (sentinel/active) is the only entry', () => {
    // Real-world case: harness emits one goal_status when /goal fires.
    const text = attachmentLine({ type: 'goal_status', sentinel: true, met: false });
    expect(detectGoalActiveFromTranscript(text)).toBe(true);
  });

  it('skips lines that mention goal_status but are not valid attachments', () => {
    // E.g., a bash command that grepped for "goal_status" leaves traces.
    const text = [
      '{"type":"tool_use","input":{"command":"grep goal_status"}}',
      attachmentLine({ type: 'goal_status', sentinel: true, met: false }),
    ].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(true);
  });

  it('returns null when the only match is a bash command mentioning goal_status', () => {
    const text = '{"type":"tool_use","input":{"command":"grep goal_status"}}';
    expect(detectGoalActiveFromTranscript(text)).toBe(null);
  });

  it('ignores malformed JSON lines', () => {
    const text = [
      '{this is not json but mentions "goal_status"}',
      attachmentLine({ type: 'goal_status', sentinel: true, met: false }),
    ].join('\n');
    expect(detectGoalActiveFromTranscript(text)).toBe(true);
  });
});

describe('detectUnderlyingPermissionMode', () => {
  // Synthetic transcript lines that mirror the shape Claude Code writes
  // for permission-mode changes. Real lines carry many more fields; we
  // only assert on the `permissionMode` value the scanner cares about.
  function modeLine(mode: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'system', permissionMode: mode, ...extra });
  }

  it('returns null when text is empty', () => {
    expect(detectUnderlyingPermissionMode('')).toBe(null);
  });

  it('returns null when no permissionMode entries exist', () => {
    const text = [
      '{"type":"user","content":"hi"}',
      '{"type":"assistant","content":"hello"}',
    ].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe(null);
  });

  it('returns null when only "plan" entries exist (no underlying mode resolvable)', () => {
    const text = [modeLine('plan'), modeLine('plan'), modeLine('plan')].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe(null);
  });

  it('returns bypassPermissions when it is the most recent non-plan entry', () => {
    const text = [
      modeLine('default'),
      modeLine('bypassPermissions'),
      modeLine('plan'),
      modeLine('plan'),
    ].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe('bypassPermissions');
  });

  it('returns default when default is more recent than bypassPermissions', () => {
    const text = [
      modeLine('bypassPermissions'),
      modeLine('default'),
      modeLine('plan'),
    ].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe('default');
  });

  it('returns acceptEdits when it is the most recent non-plan entry', () => {
    const text = [modeLine('default'), modeLine('acceptEdits'), modeLine('plan')].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe('acceptEdits');
  });

  it('skips malformed JSON lines but still resolves the next valid one', () => {
    const text = [
      modeLine('bypassPermissions'),
      '{this is not json}',
      modeLine('plan'),
    ].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe('bypassPermissions');
  });

  it('skips lines that mention permissionMode but are not valid entries', () => {
    // A bash command that greps for permissionMode leaves a trace; the
    // pre-filter matches it, but JSON.parse + field check should reject it.
    const text = [
      '{"type":"tool_use","input":{"command":"grep permissionMode foo.jsonl"}}',
      modeLine('bypassPermissions'),
    ].join('\n');
    expect(detectUnderlyingPermissionMode(text)).toBe('bypassPermissions');
  });

  it('returns null when only matches are bash commands mentioning permissionMode', () => {
    const text = '{"type":"tool_use","input":{"command":"grep permissionMode"}}';
    expect(detectUnderlyingPermissionMode(text)).toBe(null);
  });

  it('handles a single non-plan entry as the resolved mode', () => {
    expect(detectUnderlyingPermissionMode(modeLine('bypassPermissions'))).toBe(
      'bypassPermissions',
    );
  });
});
