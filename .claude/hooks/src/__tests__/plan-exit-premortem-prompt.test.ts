/**
 * Tests for plan-exit-premortem-prompt PostToolUse hook.
 *
 * The hook fires on ExitPlanMode. When triggered, it returns a PostToolUse
 * response carrying an AskUserQuestion directive in
 * hookSpecificOutput.additionalContext. It does not block, does not write
 * state, and fails open on any error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  handlePlanExitPrompt,
  extractPlanPath,
  buildDirective,
} from '../plan-exit-premortem-prompt.js';

const TEST_SESSION = 'plan-exit-premortem-test-session';
const TEST_SESSION_B = 'plan-exit-premortem-test-session-b';

// The hook stays silent when CI or CLAUDE_AGENT_ID is set (CI runners, subagents).
// Tests that call the handler with the default env must not inherit either.
beforeEach(() => {
  vi.stubEnv('CI', '');
  vi.stubEnv('CLAUDE_AGENT_ID', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// =============================================================================
// extractPlanPath -- candidate field detection
// =============================================================================

describe('extractPlanPath', () => {
  it('returns null when tool_input is missing', () => {
    expect(extractPlanPath(undefined)).toBeNull();
    expect(extractPlanPath(null)).toBeNull();
  });

  it('returns null for non-object tool_input', () => {
    expect(extractPlanPath('string')).toBeNull();
    expect(extractPlanPath(42)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(extractPlanPath({})).toBeNull();
  });

  it('extracts a value under planPath when it looks like a path', () => {
    const input = { planPath: 'C:/Users/dave/.claude/plans/my-plan.md' };
    expect(extractPlanPath(input)).toBe('C:/Users/dave/.claude/plans/my-plan.md');
  });

  it('extracts a value under plan_path when it looks like a path', () => {
    const input = { plan_path: '/tmp/plans/x.md' };
    expect(extractPlanPath(input)).toBe('/tmp/plans/x.md');
  });

  it('extracts a value under path when it looks like a path', () => {
    const input = { path: 'plans/test.md' };
    expect(extractPlanPath(input)).toBe('plans/test.md');
  });

  it('extracts a value under plan when it looks like a path', () => {
    const input = { plan: '.claude/plans/foo.md' };
    expect(extractPlanPath(input)).toBe('.claude/plans/foo.md');
  });

  it('returns null when plan field carries markdown content (multiline)', () => {
    const input = {
      plan: '# Plan title\n\nSome description here\n- step one\n- step two',
    };
    expect(extractPlanPath(input)).toBeNull();
  });

  it('returns null when plan field is unreasonably long even on one line', () => {
    const input = { plan: 'x'.repeat(600) };
    expect(extractPlanPath(input)).toBeNull();
  });

  it('returns null for plain strings with no path separator and no .md extension', () => {
    const input = { plan: 'just-a-name' };
    expect(extractPlanPath(input)).toBeNull();
  });

  it('prefers planPath when multiple candidate fields are present', () => {
    const input = {
      planPath: 'a/preferred.md',
      plan_path: 'b/second.md',
      path: 'c/third.md',
      plan: 'd/fallback.md',
    };
    expect(extractPlanPath(input)).toBe('a/preferred.md');
  });

  it('skips non-string candidate values and continues searching', () => {
    const input = {
      planPath: 42,
      plan_path: null,
      path: 'plans/found.md',
    };
    expect(extractPlanPath(input)).toBe('plans/found.md');
  });

  it('trims surrounding whitespace from the returned path', () => {
    const input = { planPath: '   plans/spaced.md   ' };
    expect(extractPlanPath(input)).toBe('plans/spaced.md');
  });
});

// =============================================================================
// buildDirective -- directive text construction
// =============================================================================

describe('buildDirective', () => {
  it('includes the AskUserQuestion tool name in the directive', () => {
    const text = buildDirective(null);
    expect(text).toContain('AskUserQuestion');
  });

  it('includes the /premortem skill name in the directive', () => {
    const text = buildDirective(null);
    expect(text).toContain('/premortem');
  });

  it('includes the plan path when provided', () => {
    const text = buildDirective('plans/my-plan.md');
    expect(text).toContain('plans/my-plan.md');
  });

  it('omits any path reference when planPath is null', () => {
    const text = buildDirective(null);
    expect(text).not.toContain('`null`');
    expect(text).not.toContain('undefined');
  });

  it('mentions the Grok and Skip reviewer options', () => {
    const text = buildDirective(null);
    expect(text).toContain('Grok');
    expect(text).toContain('Skip');
  });

  it('routes Grok to the premortem skill flag', () => {
    const text = buildDirective(null);
    expect(text).toContain('/premortem --grok');
  });
});

// =============================================================================
// handlePlanExitPrompt -- core handler
// =============================================================================

describe('handlePlanExitPrompt -- wrong tool name', () => {
  it('returns empty object for Bash tool', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result).toEqual({});
  });

  it('returns empty object for Read tool', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result).toEqual({});
  });

  it('returns empty object for EnterPlanMode (similar name, different tool)', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'EnterPlanMode',
      tool_input: {},
    };
    const result = handlePlanExitPrompt(input);
    expect(result).toEqual({});
  });

  it('returns empty object when tool_name is missing entirely', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_input: {},
    };
    const result = handlePlanExitPrompt(input);
    expect(result).toEqual({});
  });
});

describe('handlePlanExitPrompt -- ExitPlanMode with a plan path', () => {
  it('returns a PostToolUse response with additionalContext', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'ExitPlanMode',
      tool_input: { planPath: 'plans/my-plan.md' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(typeof result.hookSpecificOutput?.additionalContext).toBe('string');
  });

  it('additionalContext mentions AskUserQuestion', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'ExitPlanMode',
      tool_input: { planPath: 'plans/my-plan.md' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
  });

  it('additionalContext includes the plan path verbatim', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'ExitPlanMode',
      tool_input: { planPath: 'C:/Users/dave/.claude/plans/my-plan.md' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      'C:/Users/dave/.claude/plans/my-plan.md',
    );
  });

  it('additionalContext mentions /premortem', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'plans/x.md' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain('/premortem');
  });
});

describe('handlePlanExitPrompt -- ExitPlanMode with no plan path', () => {
  it('returns a PostToolUse response even when tool_input is empty', () => {
    const input = {
      session_id: TEST_SESSION_B,
      tool_name: 'ExitPlanMode',
      tool_input: {},
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
  });

  it('returns a PostToolUse response when plan field carries markdown content', () => {
    const input = {
      session_id: TEST_SESSION_B,
      tool_name: 'ExitPlanMode',
      // The ExitPlanMode tool sometimes passes the full plan markdown here.
      tool_input: { plan: '# Plan\n\nThis is a multi-line plan body.' },
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
    // Markdown body should NOT be embedded as a path inside the directive.
    expect(result.hookSpecificOutput?.additionalContext).not.toContain(
      '# Plan\n\nThis is a multi-line plan body.',
    );
  });

  it('returns a PostToolUse response when tool_input is missing entirely', () => {
    const input = {
      session_id: TEST_SESSION_B,
      tool_name: 'ExitPlanMode',
    };
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
  });
});

describe('handlePlanExitPrompt -- fail-open on malformed input', () => {
  it('stays silent in a subagent or CI run (no human to answer; P22)', () => {
    const input = { tool_name: 'ExitPlanMode', tool_input: { planPath: 'plans/x.md' } };
    expect(handlePlanExitPrompt(input, { CLAUDE_AGENT_ID: 'a1' })).toEqual({});
    expect(handlePlanExitPrompt(input, { CI: 'true' })).toEqual({});
    expect(handlePlanExitPrompt(input, {}).hookSpecificOutput).toBeDefined();
  });

  it('returns empty object for null input', () => {
    expect(handlePlanExitPrompt(null)).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(handlePlanExitPrompt(undefined)).toEqual({});
  });

  it('returns empty object for string input', () => {
    expect(handlePlanExitPrompt('not an object')).toEqual({});
  });

  it('returns empty object for number input', () => {
    expect(handlePlanExitPrompt(42)).toEqual({});
  });

  it('does not throw on input with tool_input of wrong type', () => {
    const input = {
      session_id: TEST_SESSION,
      tool_name: 'ExitPlanMode',
      tool_input: 'not-an-object',
    };
    // Should fall back to generic directive, not throw.
    expect(() => handlePlanExitPrompt(input)).not.toThrow();
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
  });

  it('does not throw when session_id is missing', () => {
    const input = {
      tool_name: 'ExitPlanMode',
      tool_input: { planPath: 'plans/x.md' },
    };
    expect(() => handlePlanExitPrompt(input)).not.toThrow();
    const result = handlePlanExitPrompt(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain('AskUserQuestion');
  });
});
