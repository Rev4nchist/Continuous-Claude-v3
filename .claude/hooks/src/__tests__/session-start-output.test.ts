/**
 * Memory phase 2, item E: the SessionStart memory hook shows its health line every
 * session, and no longer skips a project that only has `/.claude` somewhere in its path.
 *
 * Failure list (one test each):
 *   S1  the healthy line is hidden (no systemMessage)
 *   S2  a warning line loses its wording
 *   S3  additionalContext loses the daemon output or the health line
 *   S4  a worktree under `.claude/worktrees` is skipped as if it were the claude home
 */
import { describe, it, expect } from 'vitest';
import { buildSessionStartOutput, isClaudeHomeProject } from '../shared/session-start-output.js';

const HEALTHY = 'Memory: 130 lessons, newest 2026-10-27, schema 2026-10-27.1';
const WARN = 'Memory: UNKNOWN (ECONNREFUSED). Recall may be down. Run: docker compose up -d';

describe('buildSessionStartOutput', () => {
  it('S1: a healthy line is shown to the user as systemMessage', () => {
    const out = buildSessionStartOutput('daemon ok', { line: HEALTHY, warn: false });
    expect(out.systemMessage).toBe(HEALTHY);
  });

  it('S2: a warning line passes through verbatim', () => {
    const out = buildSessionStartOutput('', { line: WARN, warn: true });
    expect(out.systemMessage).toBe(WARN);
    expect(out.hookSpecificOutput.additionalContext).toBe(WARN);
  });

  it('S3: additionalContext holds the daemon output and the health line', () => {
    const out = buildSessionStartOutput('daemon started', { line: HEALTHY, warn: false });
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe(`daemon started\n${HEALTHY}`);
  });

  it('S3: an empty daemon output leaves only the health line, with no blank line', () => {
    const out = buildSessionStartOutput('', { line: HEALTHY, warn: false });
    expect(out.hookSpecificOutput.additionalContext).toBe(HEALTHY);
  });
});

describe('isClaudeHomeProject', () => {
  it('S4: a worktree inside a repo .claude dir is not the claude home', () => {
    expect(
      isClaudeHomeProject('C:/Users/x/continuous-claude/.claude/worktrees/a', 'C:/Users/x'),
    ).toBe(false);
  });

  it('S4: backslashes and case are normalised', () => {
    expect(isClaudeHomeProject('C:\\Users\\X\\.claude', 'c:\\users\\x')).toBe(true);
  });

  it('S4: a sub directory of the claude home is the claude home', () => {
    expect(isClaudeHomeProject('C:/Users/x/.claude/sub', 'C:/Users/x')).toBe(true);
  });

  it('S4: a sibling that only shares the prefix is not the claude home', () => {
    expect(isClaudeHomeProject('C:/Users/x/.claude-other', 'C:/Users/x')).toBe(false);
  });

  it('an empty home never matches', () => {
    expect(isClaudeHomeProject('C:/Users/x/.claude', '')).toBe(false);
  });
});
