// The grading files of a TREX run. They come from the base side (the flows SHA), never from the head under test.
// A PR therefore cannot edit its own flows, specs or image config. Git is injected as (args) => {status, stdout, stderr}.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pipeChildren } from './lib/proc.mjs';

export const DEFAULT_FLOWS_DIR = '.trex/flows';
const TRACKED_E2E = /^trex-[^/]*\.spec\.ts$/;

/** Each set is a git path (`root`) plus an optional test on the part of the path below it. */
export const FLOW_SETS = Object.freeze([
  { root: '.trex' },
  { root: 'apps/agentic-os/.trex' },
  { root: 'apps/agentic-os/e2e', match: TRACKED_E2E },
  { root: 'apps/agentic-os/playwright.trex.config.ts' },
]);
export const IMAGE_SETS = Object.freeze([{ root: 'docker/trex' }]);
/** The full grading set of spec 5.6: flows, specs, config and the image config. */
export const GRADING_SETS = Object.freeze([...FLOW_SETS, ...IMAGE_SETS]);

/** Git args for `git archive` that keep LF line endings. The system gitconfig sets core.autocrlf=true here. */
export function archiveArgs(sha, paths = []) {
  const tail = paths.length > 0 ? ['--', ...paths] : [];
  return ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', sha, ...tail];
}

/** The merge-base of head and the base ref. The default is fork/main, never a local main (spec 13.3). */
export function resolveBase(git, head, ref = 'fork/main') {
  const r = git(['merge-base', head, ref]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !sha) throw new Error(`git merge-base ${head} ${ref} found no common commit: ${r.stderr.trim()}`);
  return sha;
}

function inSet(file, set) {
  if (file === set.root) return true;
  if (!file.startsWith(`${set.root}/`)) return false;
  return set.match ? set.match.test(file.slice(set.root.length + 1)) : true;
}

const trimDir = (dir) => dir.replace(/\/+$/, '');

/**
 * Every grading file at `sha`, sorted. Reads the tree with `ls-tree -r -z`; it never reads file bodies.
 * The flows dir joins the sets unless flowsDir is null (the image config has no flows).
 */
export function listGrading(git, sha, flowsDir = DEFAULT_FLOWS_DIR, sets = GRADING_SETS) {
  const all = flowsDir ? [...sets, { root: trimDir(flowsDir) }] : sets;
  const roots = [...new Set(all.map((s) => s.root))];
  const r = git(['ls-tree', '-r', '-z', '--name-only', sha, '--', ...roots]);
  if (r.status !== 0) throw new Error(`git ls-tree ${sha} failed: ${r.stderr.trim()}`);
  const files = r.stdout.split('\0').filter(Boolean).filter((f) => all.some((s) => inSet(f, s)));
  return [...new Set(files)].sort();
}

function fullSha(git, sha) {
  const r = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (r.status !== 0) throw new Error(`git rev-parse ${sha} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * The tar to run. TAR_BIN first, then the Windows system tar, then `tar` on the PATH.
 * Git's MSYS tar comes first on PATH here: with a backslash -C path it exits 0 and extracts nothing.
 */
export function tarBin(env = process.env, { platform = process.platform, exists = existsSync } = {}) {
  if (env.TAR_BIN) return env.TAR_BIN;
  if (platform !== 'win32') return 'tar';
  const sys = path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe');
  return exists(sys) ? sys : 'tar';
}

/**
 * Unpacks `files` of `sha` (all files when the list is empty) into destDir with `git archive | tar -xf -`.
 * deps: { pipe, cwd, mkdir } for tests. Throws when either side fails.
 */
export async function archiveInto(sha, files, destDir, deps = {}) {
  const { pipe = pipeChildren, cwd = process.cwd(), mkdir = mkdirSync, env = process.env } = deps;
  mkdir(destDir, { recursive: true });
  const a = { cmd: 'git', args: archiveArgs(sha, files), cwd };
  const b = { cmd: deps.tar ?? tarBin(env), args: ['-xf', '-', '-C', destDir], cwd };
  const r = await pipe(a, b, { cwd });
  if (r.codeA !== 0 || r.codeB !== 0) {
    throw new Error(`git archive ${sha} | tar failed (archive ${r.codeA}, tar ${r.codeB}): ${r.stderrA ?? ''}${r.stderrB ?? ''}`.trim());
  }
  assertExtracted(destDir, files, deps);
}

/**
 * Throws unless every listed file is under destDir. An empty list needs at least one entry.
 * A tar can exit 0 and extract nothing, so the exit codes alone prove nothing.
 */
export function assertExtracted(destDir, files, { exists = existsSync, readdir = readdirSync } = {}) {
  if (files.length === 0) {
    if (readdir(destDir).length === 0) throw new Error(`tar extracted nothing into ${destDir}`);
    return;
  }
  const missing = files.filter((f) => !exists(path.join(destDir, f)));
  if (missing.length > 0) throw new Error(`tar extracted nothing for ${missing.length} file(s), first ${missing[0]}`);
}

/**
 * Unpacks the grading files of `sha` into destDir. Returns { files, configSha }.
 * It adds skipped = { reason: 'no_config' } and unpacks nothing when the set is empty.
 * deps: { pipe, cwd, mkdir, sets } for tests.
 */
export async function extractGrading(git, sha, destDir, flowsDir = DEFAULT_FLOWS_DIR, deps = {}) {
  const files = listGrading(git, sha, flowsDir, deps.sets ?? GRADING_SETS);
  const configSha = fullSha(git, sha);
  if (files.length === 0) return { files, configSha, skipped: { reason: 'no_config' } };
  await archiveInto(sha, files, destDir, deps);
  return { files, configSha };
}
