/**
 * The freshness messages tell the user how to fix a stale or unknown dist.
 * hook-dev-lifecycle.md: build in the repo (~/continuous-claude/.claude/hooks),
 * never in ~/.claude/hooks, because its src is a stale copy. A message that says
 * otherwise sends the user to a build that overwrites the synced dist.
 */
import { describe, it, expect } from 'vitest';
import { MANIFEST_MISSING_INFO, formatStaleDistWarning } from '../shared/dist-freshness.js';
import type { TreeFreshness } from '../shared/dist-freshness.js';

const REPO_BUILD = 'cd ~/continuous-claude/.claude/hooks && npm run build';
const FORBIDDEN = /cd ~\/\.claude\/hooks/;

const stale: TreeFreshness = { state: 'stale', staleFiles: ['/r/src/a.ts', '/r/src/b.ts'], srcCount: 5 };
const unknownNoInfo: TreeFreshness = { state: 'unknown', staleFiles: [], srcCount: 0 };

describe('dist freshness messages name the repo build, not the active folder', () => {
  it('the missing-manifest line builds in the repo', () => {
    expect(MANIFEST_MISSING_INFO).toContain(REPO_BUILD);
    expect(MANIFEST_MISSING_INFO).not.toMatch(FORBIDDEN);
  });

  it('the stale-dist warning builds in the repo', () => {
    const msg = formatStaleDistWarning('/r/src', stale);
    expect(msg).toContain(REPO_BUILD);
    expect(msg).not.toMatch(FORBIDDEN);
  });

  it('the unknown state with no custom info falls back to the repo build text', () => {
    const msg = formatStaleDistWarning('/r/src', unknownNoInfo);
    expect(msg).toContain(REPO_BUILD);
    expect(msg).not.toMatch(FORBIDDEN);
  });

  it('a fresh tree prints nothing', () => {
    expect(formatStaleDistWarning('/r/src', { state: 'fresh', staleFiles: [], srcCount: 5 })).toBeNull();
  });

  it('the stale warning still names the files and counts (only the fix command changed)', () => {
    const msg = formatStaleDistWarning('/r/src', stale) ?? '';
    expect(msg).toContain('2 of 5 sources differ from the build manifest');
    expect(msg).toContain('a.ts, b.ts');
  });
});
