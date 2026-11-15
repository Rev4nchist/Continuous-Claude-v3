/**
 * Shared test helpers for the commit-time done-check (PR2): fake git repos built by file writes
 * (no git spawn, so the tests exercise the same file-reading path as the hook), verify sidecars,
 * registries and the real hook payload fixtures in fixtures/correct/.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Every folder this module made in this test file. Only these are removed, never a prefix match. */
const made: string[] = [];

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ccv3-correct-${label}-`));
  made.push(dir);
  return dir;
}

/** Remove the folders `tempDir` made. A locked file must not fail a test, so errors are dropped. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leave it for the next run: a leak is better than a failed test */
    }
  }
}

// Each test file imports this module at the top level, so this hook runs once per file.
afterAll(removeTempDirs);

/** A repo whose HEAD is `branch` at SHA. `.git` is a directory. */
export function mkRepo(dir: string, branch: string, sha: string | null = SHA): string {
  const git = join(dir, '.git');
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, 'HEAD'), `ref: refs/heads/${branch}\n`);
  if (sha) {
    mkdirSync(join(git, 'refs', 'heads', ...branch.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(git, 'refs', 'heads', ...branch.split('/')), `${sha}\n`);
  }
  return dir;
}

/** A linked worktree of `mainRepo`: `.git` is a FILE pointing into mainRepo/.git/worktrees/<name>. */
export function mkWorktree(mainRepo: string, worktreeDir: string, branch: string, sha: string = SHA): string {
  const common = join(mainRepo, '.git');
  const gitDir = join(common, 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  mkdirSync(join(common, 'refs', 'heads', ...branch.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(common, 'refs', 'heads', ...branch.split('/')), `${sha}\n`);
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`);
  return worktreeDir;
}

export interface SidecarFields {
  exit: number | null;
  started: string;
  finished: string | null;
  head: string | null;
  artifact?: string;
}

/** A verify.mjs sidecar (field names from .claude/scripts/verify.mjs writeSidecar). */
export function writeSidecar(repo: string, name: string, f: SidecarFields): string {
  const dir = join(repo, '.claude', 'cache', 'e2e');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.log.json`);
  const artifact = f.artifact ?? join(dir, `${name}.log`).replace(/\\/g, '/');
  writeFileSync(file, JSON.stringify({ project: 'p', command: 'c', ...f, artifact }, null, 2));
  return file;
}

export function writeRegistry(file: string, entries: Array<{ name: string; path: string; e2e?: unknown }>): string {
  writeFileSync(file, JSON.stringify({ projects: entries }));
  return file;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A fixture payload with its placeholders filled in. The commit fixtures carry no cwd, so they
 * pipe straight into the built hook (it falls back to its own cwd); `REPO` sets one for a test.
 */
export function loadFixture(name: string, subs: Record<string, string>): Record<string, any> {
  const path = join(__dirname, 'fixtures', 'correct', `${name}.json`);
  let text = readFileSync(path, 'utf8');
  for (const [k, v] of Object.entries(subs)) text = text.split(`<${k}>`).join(JSON.stringify(v).slice(1, -1));
  const payload = JSON.parse(text);
  if (subs.REPO) payload.cwd = subs.REPO;
  return payload;
}
