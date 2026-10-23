/**
 * QW-12 regression tests for prd-roadmap-sync guards (closes D2d-09, D2d-13).
 *
 * D2d-09: a fully-checked tasks-*.md must NOT mark the CURRENT ROADMAP goal
 *         complete unless the tasks file actually relates to that goal. The old
 *         code did `titleToComplete = roadmap.current?.title || featureName` with
 *         no relatedness check, so ANY 100% tasks file falsely completed the
 *         current goal.
 * D2d-13: path containment must use path.relative, not startsWith — a sibling
 *         dir sharing the prefix (continuous-claude-x) must NOT be treated as
 *         inside continuous-claude.
 *
 * The guards live in shared/roadmap-sync-guards.ts so they can be unit-tested
 * deterministically WITHOUT triggering the hook's top-level main().
 */
import { describe, it, expect } from 'vitest';
import { isTasksRelatedToGoal, isPathInsideProject } from '../shared/roadmap-sync-guards.js';

const PROJECT = '~/continuous-claude';

describe('D2d-09: isTasksRelatedToGoal (false-completion guard)', () => {
  it('UNRELATED tasks file does NOT relate to the current goal (no false completion)', () => {
    // current goal is auth; the completed tasks file is about payments
    expect(isTasksRelatedToGoal('payment gateway', 'User Authentication System')).toBe(false);
  });

  it('RELATED tasks file relates to the current goal', () => {
    expect(isTasksRelatedToGoal('user authentication', 'User Authentication System')).toBe(true);
  });

  it('shared DISTINCTIVE token counts as related (not just first-word substring)', () => {
    // first word differs ("oauth" vs "user") but "authentication" overlaps
    expect(isTasksRelatedToGoal('oauth authentication', 'User Authentication System')).toBe(true);
  });

  it('a shared GENERIC/stopword token alone does NOT make them related', () => {
    // both end in "service" (a stopword) but the distinctive words differ
    expect(isTasksRelatedToGoal('billing service', 'Auth Service')).toBe(false);
  });

  it('empty / missing titles are never related (fail-safe: no completion)', () => {
    expect(isTasksRelatedToGoal('', 'User Authentication System')).toBe(false);
    expect(isTasksRelatedToGoal('user authentication', '')).toBe(false);
  });
});

describe('D2d-13: isPathInsideProject (path.relative containment)', () => {
  it('a file inside the project is contained', () => {
    expect(isPathInsideProject(`${PROJECT}/docs/prd-feature.md`, PROJECT)).toBe(true);
  });

  it('the project dir itself is contained', () => {
    expect(isPathInsideProject(PROJECT, PROJECT)).toBe(true);
  });

  it('a sibling dir sharing the prefix is NOT contained (the startsWith bug)', () => {
    expect(
      isPathInsideProject('~/continuous-claude-x/tasks-x.md', PROJECT),
    ).toBe(false);
  });

  it('an unrelated outside path is NOT contained', () => {
    expect(isPathInsideProject('~/.claude/tasks-x.md', PROJECT)).toBe(false);
  });
});
