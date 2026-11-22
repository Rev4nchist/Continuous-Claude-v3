#!/usr/bin/env node
/**
 * land-none-check.mjs - the land gate for a review:none PR at band HIGH or CRITICAL (lane agent-self-approve-hole, Dave 2026-11-03: DETECT).
 *
 * Anyone with write access can add the review:none label (or swap the labels to a lone risk:docs), and the pr-checkpoint engine takes `--by dave`
 * at every band. So the labels and the router state alone do not show that Dave chose "no review". The pr-checkpoint mod stores how he chose
 * (`via`) in its plugin store. This check reads that record before land-pr.ps1 merges. It passes only for Dave's own pick (dialog or composer) on this exact head, at a band that did
 * not rise since. It prints one provenance line, so Dave sees who chose what before he says land.
 *
 * Usage: node scripts/github/land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store <file>] [--fixture <file>] [--remote <name>] [--warn] [--json]
 *   --remote   the git remote of the base branch (default fork). The check fetches <remote>/<base> and refuses when the band code of this checkout differs from it.
 *              A --fixture run does the base-code check only when --remote is given (tests).
 *   --store    one store file instead of ~/.claude/plugins/store/ccv3-mods_*.json (tests).
 *   --fixture  { pull, files, config }: no gh call (tests and the probe).
 *   --warn     print the same text but always exit 0 (land-pr.ps1 -IgnoreReview: Dave's own yes, made informed).
 * Exit: 0 = ok or not needed, 1 = refused, 2 = could not determine.
 * The files and labels come from the live PR; the band config comes from the base ref through the contents API, never the local checkout.
 * The band CODE (bandOf and the files it imports) is the code of the checkout that runs this script. baseCodeProblem() refuses when that code differs
 * from the base branch tip after a fresh fetch (card force-high-land-path, aegis on PR 669): a PR must not lower its own bar by editing bandOf and then
 * being landed from its own worktree. Known limit: this entry file and land-pr.ps1 are themselves the checkout's copy; both are on FORCE_HIGH_FILES, so an
 * edit to either needs Dave's recorded pick.
 * This file is the ENTRY and imports only node: built-ins (card coord-force-high-followups, aegis F2 on PR 673): the band code loads by import() of
 * land-none-core.mjs after the check passed, so the top-level code of a PR's band code cannot run before the check has refused it. land-none-base-code.test.mjs
 * (FH3 of force-high-followups.test.mjs) fails on a static import of anything but a node: module here.
 * Not covered, accepted: an agent that writes a forged record from a script that builds the path in code. Docs: pr-review-loop.md, land section.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The files this check runs: its own import closure (static imports and the literal import() of the core), as repo paths. land-none-base-code.test.mjs walks the imports
 * and fails when this list and the closure differ, so a new import cannot slip past the base-code check.
 */
export const BAND_CODE_FILES = Object.freeze([
  'scripts/github/land-none-check.mjs', 'scripts/github/land-none-core.mjs', 'scripts/github/review-router.mjs', 'scripts/github/review-status.mjs',
  'scripts/github/lib/answer-key.mjs', 'scripts/github/lib/answer-paths.mjs', 'scripts/ratchets/lib/review-md.mjs',
]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The same value as DEFAULT_REPO of review-router.mjs (FH12 in force-high-followups.test.mjs compares them): this entry cannot import the router before the check. */
const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';

/** A path as git reads it: forward slashes. Backslashes change only where the path separator is a backslash (Windows); on Linux a backslash is a legal file name character. */
export const toGitPath = (p, sep = path.sep) => (sep === '\\' ? String(p).replaceAll('\\', '/') : String(p));

/**
 * git for the base-code check runs no hook (aegis F1 on PR 673): the fetch updates a ref, and git then runs the reference-transaction hook of core.hooksPath, which a PR
 * can add (.githooks is a forced file since card coord-force-high-followups, but a PR's own hook still must not run). core.hooksPath is this script's own file: git looks for <value>/<hook>, and a regular file has no children, so no hook
 * can exist there and no account can create a folder at that path. Not /dev/null: only Git Bash maps it to nul; native git started from Node gets the literal value
 * and on Windows resolves it from the drive root to C:\dev\null, a folder any authenticated account can create (aegis, round 3). Not a temp folder: %TEMP% grants
 * Modify to the Codex sandbox accounts on this machine (round 2). Forward slashes: git reads the value as given. One value on every OS.
 */
export const HOOKS_OFF_ARGS = Object.freeze(['-c', `core.hooksPath=${toGitPath(fileURLToPath(import.meta.url))}`]);

/**
 * The absolute path of the executable `name`, from the absolute entries of PATH only, or null (aegis LOW on PR 673). A bare name in a spawn is searched in the current
 * folder first on Windows unless NoDefaultCurrentDirectoryInExePath is set, so a PR's checkout could run a planted git.exe. A relative or empty PATH entry never counts.
 * A plain name only. On Windows only .exe and .com run without a shell. The same function is in review-router.mjs (makeGh): this entry has no import of band code.
 */
export function resolveExe(name, { env = process.env, platform = process.platform } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(name))) return null;
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [String(name)];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const file of names) {
      const full = path.join(dir, file);
      try { if (statSync(full).isFile()) return full; } catch { /* not here */ }
    }
  }
  return null;
}

const defaultGit = (root) => (args) => {
  const exe = resolveExe('git');
  if (!exe) return { status: 127, stdout: '', stderr: 'git was not found on an absolute PATH entry' };
  return spawnSync(exe, ['-C', root, ...HOOKS_OFF_ARGS, ...args], { encoding: 'utf8', windowsHide: true });
};
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'no message';
const SAFE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** The git blob id of `bytes`, computed here from the raw bytes: sha1 of "blob <length>" NUL and the bytes. */
export const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** The bytes with each CRLF pair turned into LF, as git's autocrlf does on a commit. A lone CR (a CR not followed by LF) stays. */
function crlfToLf(bytes) {
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

/**
 * True when the working copy `bytes` is the blob `baseBlob`: the raw bytes hash to it, or the bytes with CRLF pairs turned to LF do (a Windows checkout with autocrlf).
 * No git filter runs: `git hash-object --path` applies the .gitattributes of the checkout, which a PR can edit (ident, working-tree-encoding), and git refuses
 * --path together with --no-filters (seat note 2026-11-22, critic round 2 on PR 673). Known limit: a file that differs from the base only in its line ends counts as equal.
 */
export const matchesBase = (bytes, baseBlob) => blobHash(bytes) === baseBlob || blobHash(crlfToLf(bytes)) === baseBlob;

/**
 * Why the band code of the checkout may not decide the band, or null. Fetches <remote>/<baseRef> fresh (a failed fetch is a problem: the base code cannot be read),
 * then compares each file of `files` as the process runs it (the raw bytes, hashed here: see matchesBase) with the
 * same path at the fetched tip. A file that differs, or that the checkout or the tip lacks, is named. `git` is injectable for tests.
 */
export function baseCodeProblem({ root = REPO_ROOT, baseRef, remote = 'fork', files = BAND_CODE_FILES, git = defaultGit(root) } = {}) {
  const ref = String(baseRef ?? '');
  if (!SAFE_NAME.test(ref) || !SAFE_NAME.test(String(remote))) return `could not fetch ${remote}/${ref || '(no base branch)'}: the name is not a plain git name`;
  const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`]);
  if (fetched.status !== 0) return `could not fetch ${remote}/${ref} (${firstLine(fetched.stderr)}): the base code cannot be read, so the band code of this checkout cannot be checked`;
  const tip = String(git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${ref}^{commit}`]).stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) return `could not fetch ${remote}/${ref}: the fetched branch tip is not readable`;
  // A listed file must be a plain file at root/rel, with no link in its path: Node loads the real path of an import, so a link to an identical copy elsewhere would pass the byte check
  // and load unchecked neighbours (CodeRabbit CLI on pre-pr 1, seat ruling 2026-11-22). Windows paths compare without case.
  const realRoot = (() => { try { return realpathSync(root); } catch { return path.resolve(root); } })();
  const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const differs = files.filter((rel) => {
    const abs = path.join(root, rel);
    const base = String(git(['rev-parse', '--verify', '--quiet', `${tip}:${rel}`]).stdout ?? '').trim();
    if (!/^[0-9a-f]{40}$/.test(base)) return true;
    try { return !lstatSync(abs).isFile() || !samePath(realpathSync(abs), path.resolve(realRoot, rel)) || !matchesBase(readFileSync(abs), base); } catch { return true; }
  });
  if (differs.length === 0) return null;
  return `the band code of this checkout differs from ${remote}/${ref} at ${tip.slice(0, 7)}: ${differs.join(', ')}. The none-pick check would run that code, so a PR could lower its own band. Run the land from a checkout of ${ref} that holds ${remote}/${ref} (git fetch ${remote}, git switch ${ref}, git pull --ff-only).`;
}

// ---------- inputs ----------

const flag = (args, k) => args.includes(k);
const opt = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
/** A live run always checks the band code against the base; a fixture run (tests) checks only when --remote is given. */
export const baseCheckWanted = (args) => !opt(args, '--fixture') || Boolean(opt(args, '--remote'));

/** The base branch of the PR, read here before any band code loads: from the --fixture file, or from the pulls API through the resolved gh. */
function readBaseRef(args, pr) {
  const fixture = opt(args, '--fixture');
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8')).pull?.base?.ref;
  const exe = resolveExe('gh');
  if (!exe) throw new Error('gh was not found on an absolute PATH entry');
  const ghPersonal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(ghPersonal) ? ghPersonal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  const repo = opt(args, '--repo') ?? DEFAULT_REPO;
  const r = spawnSync(exe, ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.base.ref'], { encoding: 'utf8', env, windowsHide: true });
  if (r.status !== 0) throw new Error(`could not read PR #${pr} of ${repo}: ${firstLine(r.stderr)}`);
  return r.stdout.trim();
}

// ---------- main ----------

/** The refusal for a band code that differs from the base: same text and exit codes as before the split. */
function reportBaseCode(problem, { pr, warn, json }) {
  const undetermined = problem.startsWith('could not fetch');
  const lead = 'band code differs from the base branch';
  if (json) console.log(JSON.stringify({ pr, warn, needed: true, ok: false, undetermined, line: null, problem, lead }));
  else console.log(`${warn ? 'WARNING' : 'REFUSED'}: PR #${pr} ${lead}: ${problem}`);
  if (warn) return 0;
  return undetermined ? 2 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  const warn = flag(args, '--warn');
  const json = flag(args, '--json');
  try {
    const head = opt(args, '--head');
    if (!pr || !head) throw new Error('usage: land-none-check.mjs <pr> --repo <o/r> --head <sha> [--store f] [--fixture f] [--warn] [--json]');
    // The band code must be the base branch's code, and none of it may load before this check has passed. Live runs always check; a fixture run (tests) checks only with --remote.
    if (baseCheckWanted(args)) {
      const problem = baseCodeProblem({ baseRef: readBaseRef(args, pr), remote: opt(args, '--remote') ?? 'fork' });
      if (problem) process.exit(reportBaseCode(problem, { pr, warn, json }));
    }
    const core = await import('./land-none-core.mjs');
    process.exit(core.runNoneCheck({ args, pr, head, warn, json }));
  } catch (err) {
    const message = String(err.message).split('\n')[0];
    console.log(`${warn ? 'WARNING' : 'land-none-check'}: could not determine (${message})`);
    process.exit(warn ? 0 : 2);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) await main();
