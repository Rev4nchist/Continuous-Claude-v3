/**
 * QW-12 regression tests for git-commit-roadmap cwd verification (closes D2d-10).
 *
 * D2d-10: a `cd <other-repo> && git commit` (routine for ~/.claude quick fixes)
 *         must NOT record a foreign repo's commit into THIS project's ROADMAP.
 *         commitRanInProject verifies the effective working directory of the
 *         commit command is inside the session project before the hook writes.
 *
 * Guards live in shared/roadmap-sync-guards.ts so they can be unit-tested
 * deterministically WITHOUT triggering the hook's top-level main().
 */
import { describe, it, expect } from 'vitest';
import { commitRanInProject, extractCdTarget } from '../shared/roadmap-sync-guards.js';

const PROJECT = '~/continuous-claude';

describe('D2d-10: extractCdTarget', () => {
  it('extracts an absolute cd target that precedes git commit', () => {
    expect(extractCdTarget('cd ~/.claude && git commit -m "x"')).toBe(
      '~/.claude',
    );
  });

  it('extracts a quoted (spaced) cd target', () => {
    expect(extractCdTarget('cd "~/My Repo" && git commit -m "x"')).toBe(
      '~/My Repo',
    );
  });

  it('returns null when there is no cd', () => {
    expect(extractCdTarget('git commit -m "fix: thing"')).toBe(null);
  });

  it('does NOT treat "cd" inside the commit message as a directory change', () => {
    expect(extractCdTarget('git commit -m "cd into the new module"')).toBe(null);
  });
});

describe('D2d-10: commitRanInProject', () => {
  it('BLOCKS a commit that cd-ed into another repo (~/.claude quick fix)', () => {
    expect(
      commitRanInProject('cd ~/.claude && git commit -m "x"', PROJECT),
    ).toBe(false);
  });

  it('BLOCKS a commit cd-ed into a sibling dir sharing the prefix', () => {
    expect(
      commitRanInProject(
        'cd ~/continuous-claude-x && git commit -m "x"',
        PROJECT,
      ),
    ).toBe(false);
  });

  it('ALLOWS a plain git commit with no cd (runs in the project cwd)', () => {
    expect(commitRanInProject('git commit -m "feat: thing"', PROJECT)).toBe(true);
  });

  it('ALLOWS a commit cd-ed into a subdirectory of the project', () => {
    expect(
      commitRanInProject(
        'cd ~/continuous-claude/opc && git commit -m "x"',
        PROJECT,
      ),
    ).toBe(true);
  });
});
