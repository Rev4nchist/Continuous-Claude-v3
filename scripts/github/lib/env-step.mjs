#!/usr/bin/env node
/**
 * env-step.mjs: the pre-pr ENV step. Before the gates run, check that each gate that WILL run can find the packages it needs.
 *
 * Why: a git worktree has no node_modules. The packages live in the primary checkout. A gate that cannot find one fails with a
 * bare "# fail 4" or a stack trace, and the agent hunts a bug in code that is fine. This step names the missing package, every
 * folder it tried and the fix, in ONE line, and the gate does not run. See .claudedocs/2026-11-06-worktree-node-modules-plan.md.
 *
 * Exports (all pure or read-only; no install, no network, no link, no delete):
 *   GATE_NEEDS       gate id -> what it needs: { pkg, kind: 'bin' | 'walk' | 'dep' | 'root' }
 *   envStep(...)     { fail, others, note, blocked, gates }: the FAIL text, further FAIL texts, the drift NOTE, the gate ids that
 *                    must not run, and the gates with their paths made absolute
 *   childEnv(root)   the env of a gate child: NODE_PATH gets the primary's node_modules when this checkout has no install; or null
 *   envPrefix(...)   the ENV: text for a gate that failed with MODULE_NOT_FOUND
 *
 * Kinds of need:
 *   bin   a bin the way `npm run` finds it: walk up from the gate folder (the primary's bin does not help another folder)
 *   walk  a package from the walk up from the gate folder only (vitest.config.ts imports 'vitest/config': ESM ignores NODE_PATH)
 *   dep   a package the shared resolver finds: this checkout, the primary, then NODE_PATH (a CJS or createRequire lookup)
 *   root  a package under the root node_modules (Playwright): this checkout, then the primary
 * In the primary checkout and in CI everything is found, so the step adds no line.
 *
 * Usage as a script: node scripts/github/lib/env-step.mjs [--root <dir>]  prints the needs that this checkout cannot meet (exit 1 when any).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANCHOR_SUBDIRS, depsHint, lookupBin, lookupDep, lookupWalk, primaryRoot } from '../../lib/resolve-deps.mjs';

export const LOCK_REL = '.claude/hooks/package-lock.json';
const HOOKS_REL = '.claude/hooks';

/** What each gate needs. Gates that are not listed need nothing from node_modules. */
export const GATE_NEEDS = {
  'hooks-tsc': [{ pkg: 'tsc', kind: 'bin', from: HOOKS_REL }],
  'hooks-build': [{ pkg: 'esbuild', kind: 'bin', from: HOOKS_REL }],
  'hooks-vitest': [{ pkg: 'vitest/package.json', kind: 'walk', from: HOOKS_REL }],
  'coordination-db-tests': [{ pkg: 'pg', kind: 'dep' }],
  'github-tests': [{ pkg: 'pg', kind: 'dep' }],
  'scrub-invariant': [{ pkg: '@playwright/test/package.json', kind: 'root' }],
  'mods-validate': [{ pkg: 'typescript/package.json', kind: 'dep' }],
};

/** Gates whose result depends on the installed .claude/hooks packages: the drift NOTE is shown only when one of them runs. */
const DRIFT_GATES = ['hooks-tsc', 'hooks-build', 'hooks-vitest', 'mods-validate'];

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
/** The hash of a file with CRLF folded to LF, or null when it cannot be read. */
const hashOf = (file) => {
  try { return createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); } catch { return null; }
};
const installedMarker = (root, subdir) => path.join(root, ...subdir, 'node_modules', '.package-lock.json');
const versionIn = (file, name) => {
  try { return JSON.parse(readFileSync(file, 'utf8')).packages?.[`node_modules/${name}`]?.version ?? null; } catch { return null; }
};

/** Looks one need up. Returns { path, tried }. */
function lookupNeed(need, { root, primary, gateCwd, nodePath }) {
  const from = path.join(root, ...(need.from ?? '.').split('/'));
  if (need.kind === 'bin') return lookupBin(need.pkg, { from: gateCwd ?? from });
  if (need.kind === 'walk') return lookupWalk(need.pkg, { from: gateCwd ?? from });
  if (need.kind === 'root') {
    const anchors = samePath(root, primary) ? [root] : [root, primary];
    const hit = lookupDep(need.pkg, { repoRoot: root, anchors });
    return { path: hit.path, tried: hit.tried.map((d) => path.join(d, 'node_modules')) };
  }
  const hit = lookupDep(need.pkg, { repoRoot: root, ...(nodePath === undefined ? {} : { nodePath }) });
  return { path: hit.path, tried: hit.tried };
}

/** The one FAIL text of a gate that cannot find a package. */
export function envLine(gateId, pkg, tried, primary) {
  const name = pkg.replace(/\/package\.json$/, '');
  return `ENV: ${gateId} needs ${name}. Tried ${tried.join(', ') || '(nothing)'}. This is the environment, not your change. Fix: ${depsHint(name, tried, primary)}`;
}

export const LOCK_TEXT = 'ENV: this branch changes .claude/hooks/package-lock.json, so it needs its own npm ci in this worktree (Dave approves an install). The primary\'s packages would give a wrong green.';

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * True when this checkout's own install matches this checkout's lockfile: every installed package carries the locked version
 * (node_modules/.package-lock.json against package-lock.json) and every direct dependency is installed. Existing is not enough:
 * an install of an older lockfile would give a wrong green.
 */
export function installMatchesLock(root) {
  const hidden = readJson(installedMarker(root, ['.claude', 'hooks']));
  const lock = readJson(path.join(root, ...LOCK_REL.split('/')));
  if (!hidden?.packages || !lock?.packages) return false;
  for (const [key, entry] of Object.entries(hidden.packages)) {
    if (key !== '' && lock.packages[key]?.version !== entry?.version) return false;
  }
  const direct = { ...(lock.packages['']?.dependencies ?? {}), ...(lock.packages['']?.devDependencies ?? {}) };
  return Object.keys(direct).every((name) => hidden.packages[`node_modules/${name}`]);
}

/**
 * LOCK_TEXT when the branch changes the hooks lockfile, this checkout is not the primary, its lockfile differs from the primary's,
 * and its own install does not match its own lockfile. Strict (Dave, 11-06): it clears only after an npm ci of THIS lockfile here.
 */
function lockfileFail(root, primary, changed) {
  if (!changed.map(norm).includes(LOCK_REL)) return null;
  if (samePath(root, primary)) return null;
  const own = hashOf(path.join(root, ...LOCK_REL.split('/')));
  const theirs = hashOf(path.join(primary, ...LOCK_REL.split('/')));
  if (own === theirs) return null;
  return installMatchesLock(root) ? null : LOCK_TEXT;
}

/** The NOTE text when installed typescript differs from the lock, or null. Never a FAIL: the lock may be ahead of the install on purpose. */
function driftNote(root, primary) {
  const ownInstall = existsSync(installedMarker(root, ['.claude', 'hooks']));
  const installRoot = ownInstall ? root : primary;
  const lockFile = [root, primary].map((r) => path.join(r, ...LOCK_REL.split('/'))).find((f) => existsSync(f));
  if (!lockFile) return null;
  const have = versionIn(installedMarker(installRoot, ['.claude', 'hooks']), 'typescript');
  const want = versionIn(lockFile, 'typescript');
  if (!have || !want || have === want) return null;
  return `installed typescript ${have}, lock says ${want}: run npm ci in .claude/hooks (Dave's yes)`;
}

/** The gate with its first argument made absolute where the gate passes a repo-relative script (Playwright's cli.js). */
function absoluteArgs(gate, hit) {
  if (gate.id !== 'scrub-invariant' || !hit?.path) return gate;
  return { ...gate, args: [path.join(path.dirname(hit.path), 'cli.js'), ...gate.args.slice(1)] };
}

/**
 * Checks every gate that will run. `gates` is the gatesFor() list, `changed` the changed paths.
 * Returns { fail, others, note, blocked, gates }:
 *   fail     the first FAIL text, or null (the lockfile text comes before any gate text)
 *   others   the further FAIL texts, for the notes of the one FAIL line
 *   note     the drift NOTE text, or null
 *   blocked  Set of gate ids that must not run (their need is missing)
 *   gates    the gates, with the scrub gate's cli.js made absolute
 */
export function envStep({ root, gates, changed = [], nodePath }) {
  const primary = primaryRoot(root);
  const texts = [];
  const lock = lockfileFail(root, primary, changed);
  if (lock) texts.push(lock);
  const blocked = new Set();
  const fixed = gates.map((gate) => {
    let out = gate;
    for (const need of GATE_NEEDS[gate.id] ?? []) {
      const hit = lookupNeed(need, { root, primary, nodePath, gateCwd: path.join(root, gate.cwd ?? '.') });
      if (hit.path) { out = absoluteArgs(out, hit); continue; }
      blocked.add(gate.id);
      texts.push(envLine(gate.id, need.pkg, hit.tried, primary));
    }
    return out;
  });
  const driftRelevant = gates.some((g) => DRIFT_GATES.includes(g.id));
  return { fail: texts[0] ?? null, others: texts.slice(1), note: driftRelevant ? driftNote(root, primary) : null, blocked, gates: fixed };
}

/**
 * The env of a gate child, or null when it needs none. A checkout that is not the primary and has no complete install in
 * .claude/hooks or apps/agentic-os gets the primary's node_modules on NODE_PATH, appended to any NODE_PATH already set.
 * That serves CommonJS and createRequire lookups of `pg` in the gate's child. It does not serve an ESM import (see 'walk').
 */
export function childEnv(root, env = process.env) {
  const primary = primaryRoot(root);
  if (samePath(primary, root)) return null;
  const add = ANCHOR_SUBDIRS
    .filter((sub) => !existsSync(installedMarker(root, sub)) && existsSync(path.join(primary, ...sub, 'node_modules')))
    .map((sub) => path.join(primary, ...sub, 'node_modules'));
  if (add.length === 0) return null;
  const existing = String(env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean);
  return { ...env, NODE_PATH: [...existing, ...add.filter((a) => !existing.includes(a))].join(path.delimiter) };
}

const MISSING = /Cannot find (?:module|package) '([^']+)'/;
const MISSING_CODE = /\b(?:ERR_)?MODULE_NOT_FOUND\b/;

/**
 * The ENV: detail for a gate that failed because a module was missing, or null when the output shows no missing module. A
 * relative or absolute path that is missing is a code bug (a bad import in the branch), not the environment: null.
 */
export function envPrefix(output, { primary, status, summary }) {
  const text = String(output ?? '');
  if (!MISSING_CODE.test(text) && !MISSING.test(text)) return null;
  const name = MISSING.exec(text)?.[1];
  if (name && /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|file:)/.test(name)) return null;
  return `ENV: exit ${status}: ${summary}. This is the environment, not your change. Fix: ${depsHint(name ?? 'the missing package', [], primary)}`;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node scripts/github/lib/env-step.mjs [--root <dir>]\nLists the gate needs (pg, esbuild, vitest, playwright, typescript) that this checkout cannot meet. Exit 1 when any is missing.\n');
    return 0;
  }
  const i = argv.indexOf('--root');
  const root = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
  const gates = Object.keys(GATE_NEEDS).map((id) => ({ id, cwd: id.startsWith('hooks-') ? HOOKS_REL : '.', args: [] }));
  const r = envStep({ root, gates });
  for (const text of [r.fail, ...r.others].filter(Boolean)) process.stdout.write(`${text}\n`);
  if (r.note) process.stdout.write(`NOTE ${r.note}\n`);
  if (!r.fail) process.stdout.write(`env ok: ${gates.length} gate needs met in ${root}\n`);
  return r.fail ? 1 : 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
