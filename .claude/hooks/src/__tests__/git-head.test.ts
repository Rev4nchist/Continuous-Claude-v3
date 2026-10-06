/**
 * shared/git-head: resolve the branch and HEAD sha by reading files only (zero git spawns).
 * One test per way the reader can be wrong: a worktree `.git` file, packed refs, a detached
 * HEAD, a loose ref that must beat a packed one, a start dir below the repo root, and every
 * read failure (which must give null so the hook fails open).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveHead } from '../shared/git-head.js';
import { SHA, mkRepo, mkWorktree, tempDir } from './correct-helpers.js';

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

describe('resolveHead', () => {
  it('reads branch and sha from a normal repo', () => {
    const repo = mkRepo(tempDir('plain'), 'main');
    const h = resolveHead(repo)!;
    expect(h.branch).toBe('main');
    expect(h.sha).toBe(SHA);
    expect(norm(h.repoRoot)).toBe(norm(repo));
  });

  it('walks up from a subdirectory to the first .git', () => {
    const repo = mkRepo(tempDir('walk'), 'main');
    const sub = join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(norm(resolveHead(sub)!.repoRoot)).toBe(norm(repo));
  });

  it('keeps the slash in a branch name', () => {
    const repo = mkRepo(tempDir('slash'), 'feat/correct-ladder');
    expect(resolveHead(repo)!.branch).toBe('feat/correct-ladder');
  });

  // worktree-head: breaks when resolveHead reads only a `.git` directory.
  it('follows a worktree .git file to the shared refs and reports the main root', () => {
    const main = mkRepo(tempDir('wtmain'), 'main');
    const wt = mkWorktree(main, tempDir('wtdir'), 'feat/x');
    const h = resolveHead(wt)!;
    expect(h.branch).toBe('feat/x');
    expect(h.sha).toBe(SHA);
    expect(norm(h.repoRoot)).toBe(norm(wt));
    expect(norm(h.mainRoot)).toBe(norm(main));
  });

  it('falls back to packed-refs when no loose ref exists', () => {
    const repo = tempDir('packed');
    mkRepo(repo, 'main', null);
    const other = 'fedcba9876543210fedcba9876543210fedcba98';
    writeFileSync(
      join(repo, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${other} refs/heads/dev\n${SHA} refs/heads/main\n`,
    );
    expect(resolveHead(repo)!.sha).toBe(SHA);
  });

  it('a loose ref wins over a packed ref for the same branch', () => {
    const repo = mkRepo(tempDir('loose'), 'main');
    writeFileSync(join(repo, '.git', 'packed-refs'), `${'f'.repeat(40)} refs/heads/main\n`);
    expect(resolveHead(repo)!.sha).toBe(SHA);
  });

  it('a detached HEAD has a sha and no branch', () => {
    const repo = tempDir('detached');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    const h = resolveHead(repo)!;
    expect(h.branch).toBeNull();
    expect(h.sha).toBe(SHA);
  });

  it('an unborn branch has a name and no sha', () => {
    const repo = mkRepo(tempDir('unborn'), 'main', null);
    const h = resolveHead(repo)!;
    expect(h.branch).toBe('main');
    expect(h.sha).toBeNull();
  });

  // fail-open: every one of these must return null, never throw.
  it('returns null outside any repo', () => {
    expect(resolveHead(tempDir('nogit'))).toBeNull();
  });

  it('returns null for a directory that does not exist', () => {
    expect(resolveHead(join(tempDir('gone'), 'missing', 'dir'))).toBeNull();
  });

  it('returns null for a garbage HEAD file', () => {
    const repo = tempDir('garbage');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'not a head\n');
    expect(resolveHead(repo)).toBeNull();
  });

  it('returns null for a .git file that points nowhere', () => {
    const repo = tempDir('dangling');
    writeFileSync(join(repo, '.git'), `gitdir: ${join(repo, 'nope')}\n`);
    expect(resolveHead(repo)).toBeNull();
  });
});
