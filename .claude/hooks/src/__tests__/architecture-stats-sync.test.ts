/**
 * Tests for architecture-stats-sync hook.
 *
 * The hook is PostToolUse:Bash. It fires `scripts/sync-architecture-stats.mjs --apply`
 * in the background (fire-and-forget) ONLY when:
 *   1. The tool was Bash
 *   2. The command contained `git commit`
 *   3. The most recent commit (HEAD) touched at least one file under
 *      `.claude/(hooks|agents|skills)/` or `scripts/`
 *
 * To keep tests fast and deterministic we test the pure decision logic
 * (`isGitCommitCommand`, `touchesWatchedPaths`, `shouldFireSync`) directly
 * rather than firing real subprocesses.
 */

import { describe, it, expect } from 'vitest';
import {
  isGitCommitCommand,
  touchesWatchedPaths,
  shouldFireSync,
  WATCHED_PATTERN,
} from '../architecture-stats-sync.js';

describe('architecture-stats-sync — isGitCommitCommand', () => {
  it('returns true for plain `git commit -m "..."`', () => {
    expect(isGitCommitCommand('git commit -m "feat: x"')).toBe(true);
  });

  it('returns true for `git commit` with extra whitespace', () => {
    expect(isGitCommitCommand('  git   commit  --amend  ')).toBe(true);
  });

  it('returns false for `git status`', () => {
    expect(isGitCommitCommand('git status')).toBe(false);
  });

  it('returns false for `git log -1`', () => {
    expect(isGitCommitCommand('git log -1')).toBe(false);
  });

  it('returns false for a command that just contains the word "commit" elsewhere', () => {
    expect(isGitCommitCommand('echo "i will commit later"')).toBe(false);
  });
});

describe('architecture-stats-sync — touchesWatchedPaths (multiline git show output)', () => {
  it('matches `.claude/hooks/src/foo.ts`', () => {
    const files = '.claude/hooks/src/foo.ts\n';
    expect(touchesWatchedPaths(files)).toBe(true);
  });

  it('matches `.claude/agents/kraken.md`', () => {
    const files = '.claude/agents/kraken.md\n';
    expect(touchesWatchedPaths(files)).toBe(true);
  });

  it('matches `.claude/skills/memory/SKILL.md`', () => {
    const files = '.claude/skills/memory/SKILL.md\n';
    expect(touchesWatchedPaths(files)).toBe(true);
  });

  it('matches `scripts/sync-architecture-stats.mjs`', () => {
    const files = 'scripts/sync-architecture-stats.mjs\n';
    expect(touchesWatchedPaths(files)).toBe(true);
  });

  it('matches when ANY line in multi-file output is a watched path', () => {
    const files = [
      'README.md',
      'docs/foo.md',
      '.claude/hooks/src/git-commit-roadmap.ts',
      'src/unrelated.ts',
    ].join('\n');
    expect(touchesWatchedPaths(files)).toBe(true);
  });

  it('returns false when only `docs/` files touched', () => {
    const files = 'docs/foo.md\ndocs/bar.md\n';
    expect(touchesWatchedPaths(files)).toBe(false);
  });

  it('returns false when only `README.md` touched', () => {
    expect(touchesWatchedPaths('README.md\n')).toBe(false);
  });

  it('returns false for empty input (no files in commit)', () => {
    expect(touchesWatchedPaths('')).toBe(false);
  });

  it('does NOT match `.claude/hooks-other/foo.ts` (must be exact `hooks` segment)', () => {
    expect(touchesWatchedPaths('.claude/hooks-other/foo.ts\n')).toBe(false);
  });

  it('does NOT match a `scripts` word inside another path (must be path-anchored)', () => {
    expect(touchesWatchedPaths('docs/about-scripts.md\n')).toBe(false);
  });

  // The system map generator reads the Waves table of this file (card ccv3-system-map-followups, item b).
  it('matches `docs/review-engine/map.md` (a source of the generated graph)', () => {
    expect(touchesWatchedPaths('docs/review-engine/map.md\n')).toBe(true);
  });

  it('matches `docs/review-engine/map.md` among other docs files', () => {
    expect(touchesWatchedPaths('README.md\ndocs/review-engine/map.md\ndocs/foo.md\n')).toBe(true);
  });

  it('does NOT match other files of `docs/review-engine/` or a look-alike path', () => {
    expect(touchesWatchedPaths('docs/review-engine/README.md\n')).toBe(false);
    expect(touchesWatchedPaths('docs/review-engine/map.md.bak\n')).toBe(false);
    expect(touchesWatchedPaths('old-docs/review-engine/map.md\n')).toBe(false);
  });
});

describe('architecture-stats-sync — shouldFireSync (full hook decision)', () => {
  it('fires when Bash + git commit + watched path touched', () => {
    const input = {
      session_id: 't1',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
    };
    const files = '.claude/hooks/src/foo.ts\n';
    expect(shouldFireSync(input, files)).toBe(true);
  });

  it('does NOT fire when commit touches only docs/', () => {
    const input = {
      session_id: 't2',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "docs"' },
    };
    const files = 'docs/foo.md\n';
    expect(shouldFireSync(input, files)).toBe(false);
  });

  it('does NOT fire when command is `git status`', () => {
    const input = {
      session_id: 't3',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    };
    // Even if HEAD has watched files, no commit command -> no fire
    const files = '.claude/hooks/src/foo.ts\n';
    expect(shouldFireSync(input, files)).toBe(false);
  });

  it('does NOT fire when tool_name is not Bash', () => {
    const input = {
      session_id: 't4',
      tool_name: 'Edit',
      tool_input: { command: 'git commit -m "x"' },
    };
    const files = '.claude/hooks/src/foo.ts\n';
    expect(shouldFireSync(input, files)).toBe(false);
  });

  it('does NOT fire when tool_input is missing', () => {
    const input = {
      session_id: 't5',
      tool_name: 'Bash',
    } as any;
    const files = '.claude/hooks/src/foo.ts\n';
    expect(shouldFireSync(input, files)).toBe(false);
  });
});

describe('architecture-stats-sync — WATCHED_PATTERN regex exposed for inspection', () => {
  it('is a multiline regex anchored at start of line', () => {
    expect(WATCHED_PATTERN.flags).toContain('m');
  });
});
