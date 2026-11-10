// Thin git wrapper. spawnSync with an argv array, never a shell string, so Windows paths with spaces and quotes work.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

// Run git in repo. Returns { status, stdout, stderr }. Does not throw on a non-zero exit.
export function gitRaw(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`git: cannot run git: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Run git in repo. Returns stdout. Throws with stderr on a non-zero exit.
export function git(repo, args) {
  const r = gitRaw(repo, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

export const repoRoot = (dir) => git(dir, ['rev-parse', '--show-toplevel']).trim();

// Git prints --git-dir and --git-common-dir relative to the cwd in a primary checkout. Resolve both, then compare real paths.
export function isLinkedWorktree(repo) {
  const out = git(repo, ['rev-parse', '--git-dir', '--git-common-dir']).split(/\r?\n/);
  const [gitDir, common] = out.slice(0, 2).map((p) => realpathSync.native(resolve(repo, p)));
  return gitDir !== common;
}

// The commit id of a ref, or null when the ref does not name a commit.
export function revParse(repo, ref) {
  const r = gitRaw(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// The text of a file at a commit. Throws when it is absent.
export const showFile = (repo, sha, path) => git(repo, ['show', `${sha}:${path}`]);

// The blob id the working file would have if committed. --path applies the autocrlf clean filter, so CRLF and LF match.
export const blobId = (repo, rel) => git(repo, ['hash-object', `--path=${rel}`, '--', rel]).trim();

// The blob id of a file at a commit, or null when absent there.
export function blobAt(repo, sha, rel) {
  const r = gitRaw(repo, ['rev-parse', '--verify', '--quiet', `${sha}:${rel}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}
