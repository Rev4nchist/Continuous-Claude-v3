/**
 * Resolve a directory's git branch and HEAD sha by READING FILES. No `git` spawn.
 *
 * Why: commit-preflight runs on every Bash and PowerShell call, and process spawns on this machine
 * are slow and sometimes crash (MSYS fork storm). Reading `.git/HEAD` and one ref file costs
 * microseconds. (The settings.json `timeout` is in SECONDS: the registered `5000` is a generous
 * ceiling copied from destructive-command-guard, not a 5 s budget. Change both together.)
 *
 * Handles: a `.git` directory, a `.git` FILE (`gitdir: <path>`, a linked worktree), a loose ref,
 * `packed-refs`, a detached HEAD and an unborn branch. Every read error gives `null` (fail open).
 * A loose ref beats a packed ref for the same branch, as in git itself.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export interface HeadInfo {
  /** The directory that holds `.git`. For a worktree: the worktree, not the main repo. */
  repoRoot: string;
  /** The main repo root (parent of the common `.git`). Equals repoRoot outside a worktree. */
  mainRoot: string;
  /** `main`, `feat/x`; null for a detached HEAD. */
  branch: string | null;
  /** Full 40-char sha; null for an unborn branch or an unreadable ref. */
  sha: string | null;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function findDotGit(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The git dir for `<root>/.git`: the directory itself, or the target of a `gitdir:` file. */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const m = (read(dotGit) ?? '').match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
  return statSync(target).isDirectory() ? target : null;
}

/** The shared git dir: `<gitDir>/commondir` for a worktree (relative), else the git dir itself. */
function commonDirOf(gitDir: string): string {
  const rel = read(join(gitDir, 'commondir'))?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve(gitDir, rel);
}

function shaOfBranch(branch: string, gitDir: string, commonDir: string): string | null {
  for (const dir of new Set([gitDir, commonDir])) {
    const loose = read(join(dir, 'refs', 'heads', ...branch.split('/')))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = read(join(commonDir, 'packed-refs')) ?? '';
  for (const line of packed.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+?)\s*$/i);
    if (m && m[2] === branch) return m[1];
  }
  return null;
}

export function resolveHead(dir: string): HeadInfo | null {
  try {
    if (!dir || !existsSync(dir)) return null;
    const repoRoot = findDotGit(dir);
    if (!repoRoot) return null;
    const gitDir = gitDirOf(repoRoot);
    if (!gitDir) return null;
    const commonDir = commonDirOf(gitDir);
    const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : repoRoot;
    const head = read(join(gitDir, 'HEAD'))?.trim();
    if (!head) return null;
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { repoRoot, mainRoot, branch: ref[1], sha: shaOfBranch(ref[1], gitDir, commonDir) };
    if (SHA_RE.test(head)) return { repoRoot, mainRoot, branch: null, sha: head };
    return null;
  } catch {
    return null;
  }
}
