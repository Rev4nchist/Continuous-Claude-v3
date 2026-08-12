/**
 * Table-driven tests for `shouldAutoCommitRoadmap` (H2 auto-commit follow-on,
 * plan `i-was-working-in-composed-manatee.md` section 6).
 *
 * Hermetic by design: every git-derived fact (work-tree membership, an
 * operation in progress, tracked-ness, pre-existing dirtiness) is a plain
 * boolean/string passed straight into the predicate. Nothing here spawns
 * `execFileSync`, touches the filesystem, or reads real `process.env` unless
 * a test deliberately says so (and then restores it).
 */
import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';

// `isPathInsideProject` is a genuine second gate in the plan ("path is exactly
// <projectDir>/ROADMAP.md AND isPathInsideProject"), but any roadmapPath that
// string-equals `path.join(projectDir, 'ROADMAP.md')` is *always* trivially
// inside projectDir by construction -- the exact-match check above it makes
// this second gate unreachable via real path strings alone. Spying on it lets
// this suite still exercise that clause independently, per "covering EVERY
// gate clause", rather than leaving it as untested belt-and-suspenders.
vi.mock('../shared/roadmap-sync-guards.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/roadmap-sync-guards.js')>();
  return {
    ...actual,
    isPathInsideProject: vi.fn(actual.isPathInsideProject),
  };
});

import { isPathInsideProject } from '../shared/roadmap-sync-guards.js';
import { shouldAutoCommitRoadmap, type ShouldAutoCommitRoadmapOptions } from '../git-commit-roadmap.js';

const PROJECT_DIR = 'C:/fake/project';
const VALID_ROADMAP_PATH = path.join(PROJECT_DIR, 'ROADMAP.md');

function opts(overrides: Partial<ShouldAutoCommitRoadmapOptions> = {}): ShouldAutoCommitRoadmapOptions {
  return {
    roadmapPath: VALID_ROADMAP_PATH,
    projectDir: PROJECT_DIR,
    isGitWorkTree: true,
    operationInProgress: false,
    isTracked: true,
    preDirty: false,
    env: {},
    ...overrides,
  };
}

describe('shouldAutoCommitRoadmap', () => {
  // `vi.fn(actual.isPathInsideProject)` (in the vi.mock factory above) sets a
  // PERSISTENT base implementation that delegates to the real function.
  // `mockReturnValueOnce` below only queues a one-shot override for its own
  // test's single call -- every other test's call falls straight through to
  // that persistent real implementation, so no manual reset is needed here.

  it('ok:true when every gate clause passes', () => {
    expect(shouldAutoCommitRoadmap(opts())).toEqual({ ok: true });
  });

  it('env off switch: CCV3_ROADMAP_AUTOCOMMIT="0" refuses', () => {
    expect(shouldAutoCommitRoadmap(opts({ env: { CCV3_ROADMAP_AUTOCOMMIT: '0' } }))).toEqual({
      ok: false,
      reason: 'autocommit_disabled',
    });
  });

  it('env off switch: any other value (or unset) does NOT refuse on its own', () => {
    expect(shouldAutoCommitRoadmap(opts({ env: { CCV3_ROADMAP_AUTOCOMMIT: '1' } })).ok).toBe(true);
    expect(shouldAutoCommitRoadmap(opts({ env: {} })).ok).toBe(true);
  });

  it('falls back to real process.env when `env` is omitted', () => {
    const prior = process.env.CCV3_ROADMAP_AUTOCOMMIT;
    try {
      delete process.env.CCV3_ROADMAP_AUTOCOMMIT;
      const { env: _drop, ...rest } = opts();
      expect(shouldAutoCommitRoadmap(rest)).toEqual({ ok: true });

      process.env.CCV3_ROADMAP_AUTOCOMMIT = '0';
      expect(shouldAutoCommitRoadmap(rest)).toEqual({ ok: false, reason: 'autocommit_disabled' });
    } finally {
      if (prior === undefined) {
        delete process.env.CCV3_ROADMAP_AUTOCOMMIT;
      } else {
        process.env.CCV3_ROADMAP_AUTOCOMMIT = prior;
      }
    }
  });

  it('path_mismatch: roadmapPath is not exactly <projectDir>/ROADMAP.md', () => {
    expect(
      shouldAutoCommitRoadmap(
        opts({ roadmapPath: path.join(PROJECT_DIR, '.claude', 'ROADMAP.md') }),
      ),
    ).toEqual({ ok: false, reason: 'path_mismatch' });
  });

  it('path_mismatch: lowercased roadmap.md variant is not the exact path', () => {
    expect(
      shouldAutoCommitRoadmap(opts({ roadmapPath: path.join(PROJECT_DIR, 'roadmap.md') })),
    ).toEqual({ ok: false, reason: 'path_mismatch' });
  });

  it('path_outside_project: fires only when isPathInsideProject independently disagrees', () => {
    vi.mocked(isPathInsideProject).mockReturnValueOnce(false);
    expect(shouldAutoCommitRoadmap(opts())).toEqual({
      ok: false,
      reason: 'path_outside_project',
    });
  });

  it('not_git_worktree: refuses when not inside a git work tree', () => {
    expect(shouldAutoCommitRoadmap(opts({ isGitWorkTree: false }))).toEqual({
      ok: false,
      reason: 'not_git_worktree',
    });
  });

  it('git_operation_in_progress: refuses mid-merge/cherry-pick/revert/bisect/rebase', () => {
    expect(shouldAutoCommitRoadmap(opts({ operationInProgress: true }))).toEqual({
      ok: false,
      reason: 'git_operation_in_progress',
    });
  });

  it('not_tracked: refuses when ROADMAP.md is not a tracked file', () => {
    expect(shouldAutoCommitRoadmap(opts({ isTracked: false }))).toEqual({
      ok: false,
      reason: 'not_tracked',
    });
  });

  it('pre_dirty: refuses when ROADMAP.md was already modified before our write', () => {
    expect(shouldAutoCommitRoadmap(opts({ preDirty: true }))).toEqual({
      ok: false,
      reason: 'pre_dirty',
    });
  });

  it('gate precedence: env off switch short-circuits before any other gate is evaluated', () => {
    // Every other gate is also failing here; if order were different, a
    // different reason would come back. This pins the documented order.
    expect(
      shouldAutoCommitRoadmap(
        opts({
          env: { CCV3_ROADMAP_AUTOCOMMIT: '0' },
          roadmapPath: path.join(PROJECT_DIR, 'roadmap.md'),
          isGitWorkTree: false,
          operationInProgress: true,
          isTracked: false,
          preDirty: true,
        }),
      ),
    ).toEqual({ ok: false, reason: 'autocommit_disabled' });
  });

  it('gate precedence: path_mismatch is checked before work-tree/operation/tracked/dirty gates', () => {
    expect(
      shouldAutoCommitRoadmap(
        opts({
          roadmapPath: path.join(PROJECT_DIR, 'roadmap.md'),
          isGitWorkTree: false,
          operationInProgress: true,
          isTracked: false,
          preDirty: true,
        }),
      ),
    ).toEqual({ ok: false, reason: 'path_mismatch' });
  });
});
