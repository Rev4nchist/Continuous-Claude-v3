#!/usr/bin/env node
/**
 * resolve-deps.mjs: one lookup for the packages that live only in the PRIMARY checkout's node_modules.
 *
 * Why: the dependencies of the repo scripts (`pg`, `esbuild`, `typescript`, `vitest`) are installed in
 * <primary>/.claude/hooks and <primary>/apps/agentic-os. A git worktree has no node_modules (gitignored), and Node
 * never walks from <primary>/.claude/worktrees/<name> into <primary>/.claude/hooks/node_modules. About 21 scripts each
 * carried their own createRequire lookup that tried only their own checkout. This is the one copy.
 *
 * Lookup order for a package (lookupDep, resolveDep, requireDep):
 *   1. <repo>/.claude/hooks, then <repo>/apps/agentic-os   (the own checkout)
 *   2. the same two folders under the primary checkout     (found with git rev-parse --git-common-dir)
 *   3. NODE_PATH                                           (each entry, as a node_modules folder)
 * In the primary checkout and in CI the primary is the checkout itself, so step 1 hits first and nothing changes.
 * `anchors` (package.json paths or folders) replace the whole order: a caller that names its own anchors gets
 * those and nothing else. scratch-db.test.mjs relies on that to simulate "pg is in none".
 * A package is found only when it RESOLVES. A folder named node_modules is never proof: a partial
 * node_modules/.vite can exist alone.
 *
 * A bin is different: `npm run` finds a bin by walking up from the gate folder, so lookupBin walks up from `from`
 * and never looks in the primary.
 *
 * A miss throws ONE Error whose message starts with `ENV:`: the package, every folder tried and the fix.
 * Importing this file does nothing: no I/O and no child process until a function is called.
 *
 * Usage as a script: node scripts/lib/resolve-deps.mjs <package> [--repo <dir>]   prints the resolved path, exit 1 on a miss.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The two folders under a checkout where a package.json with dependencies lives. */
export const ANCHOR_SUBDIRS = [['.claude', 'hooks'], ['apps', 'agentic-os']];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_CHECKOUT = path.resolve(HERE, '..', '..');

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/**
 * The primary checkout of the repo that holds `from`: the folder that holds the shared .git. A plain checkout (the
 * primary, a CI clone) maps to itself. A folder that is not a git repo, or a failed git call, maps to itself.
 */
export function primaryRoot(from) {
  const start = path.resolve(from);
  // --path-format=absolute (git 2.31+): from a subfolder of a linked worktree the plain form can print a wrong relative path.
  const ask = (args) => spawnSync('git', ['-C', start, 'rev-parse', ...args, '--git-common-dir'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  let r = ask(['--path-format=absolute']);
  if (r.status !== 0) r = ask([]);
  const common = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return common ? path.resolve(start, common, '..') : start;
}

const anchorDirs = (root) => ANCHOR_SUBDIRS.map((parts) => path.join(path.resolve(root), ...parts));

/** The anchor folders in lookup order: the own checkout's two, then the primary's two (none when they are the same checkout). */
export function candidateRoots(repoRoot = OWN_CHECKOUT) {
  const primary = primaryRoot(repoRoot);
  return samePath(primary, repoRoot) ? anchorDirs(repoRoot) : [...anchorDirs(repoRoot), ...anchorDirs(primary)];
}

const asDir = (anchor) => (path.basename(anchor) === 'package.json' ? path.dirname(anchor) : path.resolve(anchor));

function resolveFrom(name, dir) {
  try { return createRequire(pathToFileURL(path.join(dir, 'package.json'))).resolve(name); } catch { return null; }
}

/** A NODE_PATH entry is a node_modules folder itself: the package sits straight under it. */
function resolveInNodePath(name, entry) {
  const candidate = path.join(entry, name);
  if (!existsSync(candidate)) return null;
  try { return createRequire(import.meta.url).resolve(candidate); } catch { return null; }
}

const splitNodePath = (value) => String(value ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);

/**
 * Looks `name` up. Returns { path, tried, nodePath }: the resolved file or null, every folder tried in order, and the
 * NODE_PATH entries that were searched. Never throws. opts: { repoRoot, anchors, nodePath }.
 */
export function lookupDep(name, opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot ?? OWN_CHECKOUT);
  const tried = [];
  const nodePath = splitNodePath(opts.nodePath ?? (opts.anchors ? '' : process.env.NODE_PATH));
  const search = (dirs) => {
    for (const dir of dirs) {
      tried.push(dir);
      const found = resolveFrom(name, dir);
      if (found) return found;
    }
    return null;
  };
  let found = null;
  if (opts.anchors) found = search(opts.anchors.map(asDir));
  else {
    found = search(anchorDirs(repoRoot));
    // The git call is the slow part: skip it when the own checkout already answered.
    if (!found) {
      const primary = primaryRoot(repoRoot);
      if (!samePath(primary, repoRoot)) found = search(anchorDirs(primary));
    }
  }
  for (const entry of found ? [] : nodePath) {
    tried.push(entry);
    found = resolveInNodePath(name, entry);
    if (found) break;
  }
  return { path: found, tried, nodePath };
}

/** The resolved file of `name`, or null. */
export function resolveDep(name, opts = {}) {
  return lookupDep(name, opts).path;
}

/**
 * The fix text of an ENV message. The shared store does not exist yet, so the two ways are the install in the
 * primary and the hand junction for one worktree. The junction needs no recursive delete, ever: land-pr unlinks it.
 */
export function depsHint(name, tried = [], primary = '<primary>') {
  const hooks = path.join(primary, '.claude', 'hooks');
  const store = path.join(hooks, 'node_modules');
  return `run \`npm ci\` in ${hooks} (needs Dave's yes). In a worktree you can instead link the primary's packages: `
    + `New-Item -ItemType Junction -Path .claude\\hooks\\node_modules -Target ${store} `
    + '(never delete a junction recursively; land-pr unlinks it)';
}

/** The one ENV Error for a package that was not found. `lookup` is the lookupDep result. */
export function envError(name, lookup, primary) {
  const where = [...lookup.tried];
  const np = lookup.nodePath.length ? '' : ' NODE_PATH is empty.';
  const err = new Error(`ENV: cannot resolve the \`${name}\` module. Tried ${where.join(', ') || '(nothing)'}.${np} This is the environment, not your change. Fix: ${depsHint(name, lookup.tried, primary)}`);
  err.code = 'ENV_DEP_MISSING';
  err.tried = lookup.tried;
  return err;
}

/** Loads `name` from the first place that has it. A miss throws the one ENV error. opts as lookupDep. */
export function requireDep(name, opts = {}) {
  const lookup = lookupDep(name, opts);
  if (lookup.path) return createRequire(import.meta.url)(lookup.path);
  throw envError(name, lookup, primaryRoot(opts.repoRoot ?? OWN_CHECKOUT));
}

/**
 * A bin the way `npm run` finds it: <dir>/node_modules/.bin/<name> (and .cmd on Windows) in `from` and every parent folder.
 * Returns { path, tried }. The primary checkout is not searched: its bin does not reach a gate run in another folder.
 */
export function lookupBin(name, { from = process.cwd(), platform = process.platform } = {}) {
  const tried = [];
  const files = platform === 'win32' ? [`${name}.cmd`, name] : [name];
  let dir = path.resolve(from);
  for (;;) {
    const bin = path.join(dir, 'node_modules', '.bin');
    tried.push(bin);
    const hit = files.map((f) => path.join(bin, f)).find((f) => existsSync(f));
    if (hit) return { path: hit, tried };
    const up = path.dirname(dir);
    if (up === dir) return { path: null, tried };
    dir = up;
  }
}

/**
 * A package that must come from the walk up from `from` and nowhere else: an ESM import (vitest.config.ts imports
 * 'vitest/config') ignores NODE_PATH and the primary. Returns { path, tried }.
 */
export function lookupWalk(name, { from = process.cwd() } = {}) {
  const tried = [];
  let dir = path.resolve(from);
  for (;;) {
    const folder = path.join(dir, 'node_modules');
    tried.push(folder);
    const file = path.join(folder, ...name.split('/'));
    if (existsSync(file)) return { path: file, tried };
    const up = path.dirname(dir);
    if (up === dir) return { path: null, tried };
    dir = up;
  }
}

function main(argv) {
  const name = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--repo');
  if (argv.includes('--help') || argv.includes('-h') || !name) {
    process.stdout.write('usage: node scripts/lib/resolve-deps.mjs <package> [--repo <dir>]\nPrints the resolved path of a package from the own checkout, the primary checkout or NODE_PATH. Exit 1 when it is not found.\n');
    return 0;
  }
  const i = argv.indexOf('--repo');
  const repoRoot = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : OWN_CHECKOUT;
  const lookup = lookupDep(name, { repoRoot });
  if (lookup.path) { process.stdout.write(`${lookup.path}\n`); return 0; }
  process.stderr.write(`${envError(name, lookup, primaryRoot(repoRoot)).message}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
