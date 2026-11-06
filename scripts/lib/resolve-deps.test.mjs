/**
 * resolve-deps.test.mjs: the shared dependency resolver (scripts/lib/resolve-deps.mjs).
 *
 * Every test builds a fake primary checkout under os.tmpdir() with REAL git (git init, git worktree add), so the
 * primary found by `git rev-parse --git-common-dir` is the real thing. A fake `pg` package carries a marker string.
 * Each test names the change that breaks it:
 *   R1 own checkout hit        breaks if the own anchors stop coming first
 *   R2 primary fallback        breaks if a bare nested worktree no longer falls back to the primary
 *   R3 agentic-os anchor       breaks if the second own anchor is dropped
 *   R4 NODE_PATH only          breaks if the last NODE_PATH step is dropped
 *   R5 nothing found           breaks if the message loses the ENV: prefix, a folder or the fix
 *   R6 primary and CI          breaks if the primary checkout asks git for more than itself, or lists a folder twice
 *   R7 partial node_modules    breaks if "found" means "node_modules exists"
 *   R8 injected anchors        breaks if NODE_PATH leaks into a lookup that names its own anchors (scratch-db 'none' test)
 *   R9 primaryRoot             breaks if a worktree maps to itself
 *   R10 bin walk               breaks if a bin is found in a folder that is not on the walk
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateRoots, depsHint, lookupBin, lookupDep, primaryRoot, requireDep, resolveDep,
} from './resolve-deps.mjs';

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();

/** A fake `pg` package under <dir>/node_modules whose export carries `marker`. */
function fakePg(dir, marker) {
  put(path.join(dir, 'node_modules', 'pg', 'package.json'), JSON.stringify({ name: 'pg', version: '0.0.0', main: 'index.js' }));
  put(path.join(dir, 'node_modules', 'pg', 'index.js'), `module.exports = { marker: ${JSON.stringify(marker)} };\n`);
  put(path.join(dir, 'node_modules', '.package-lock.json'), '{}\n');
}

const made = [];
/** A primary checkout with one commit, plus a nested bare worktree at .claude/worktrees/wt. */
function fakeRepo() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'resdeps-')));
  made.push(root);
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { windowsHide: true });
  put(path.join(primary, 'README.md'), 'x\n');
  put(path.join(primary, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '--no-verify', '-m', 'init');
  const wt = path.join(primary, '.claude', 'worktrees', 'wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'wt', wt);
  return { root, primary, wt, hooks: path.join(primary, '.claude', 'hooks'), wtHooks: path.join(wt, '.claude', 'hooks') };
}

test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

test('R1: pg in the own checkout wins over the primary', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  fakePg(r.wtHooks, 'own-pg');
  assert.equal(requireDep('pg', { repoRoot: r.wt, nodePath: '' }).marker, 'own-pg');
  const hit = lookupDep('pg', { repoRoot: r.wt, nodePath: '' });
  assert.equal(hit.tried.length, 1, 'the first anchor hit, so nothing else was tried');
});

test('R2: a bare nested worktree finds pg in the primary', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  assert.equal(requireDep('pg', { repoRoot: r.wt, nodePath: '' }).marker, 'primary-pg');
  const hit = lookupDep('pg', { repoRoot: r.wt, nodePath: '' });
  assert.deepEqual(hit.tried, [r.wtHooks, path.join(r.wt, 'apps', 'agentic-os'), r.hooks], 'own hooks, own agentic-os, then the primary hooks');
  assert.equal(resolveDep('pg', { repoRoot: r.wt, nodePath: '' }), path.join(r.hooks, 'node_modules', 'pg', 'index.js'));
});

test('R3: pg under the own apps/agentic-os is found before the primary', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  fakePg(path.join(r.wt, 'apps', 'agentic-os'), 'own-agentic-pg');
  assert.equal(requireDep('pg', { repoRoot: r.wt, nodePath: '' }).marker, 'own-agentic-pg');
});

test('R4: NODE_PATH alone finds pg when no anchor has it', () => {
  const r = fakeRepo();
  const store = path.join(r.root, 'store');
  fakePg(store, 'nodepath-pg');
  const nodePath = path.join(store, 'node_modules');
  assert.equal(requireDep('pg', { repoRoot: r.wt, nodePath }).marker, 'nodepath-pg');
  assert.equal(resolveDep('pg', { repoRoot: r.wt, nodePath: '' }), null, 'with NODE_PATH empty the same lookup finds nothing');
});

test('R5: nothing found throws ONE ENV error that lists every folder and the fix', () => {
  const r = fakeRepo();
  let err;
  try { requireDep('pg', { repoRoot: r.wt, nodePath: '' }); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.match(err.message, /^ENV: /);
  assert.equal(err.message.split('\n').length, 1, 'one line');
  for (const dir of [r.wtHooks, path.join(r.wt, 'apps', 'agentic-os'), r.hooks, path.join(r.primary, 'apps', 'agentic-os')]) {
    assert.ok(err.message.includes(dir), `names ${dir}`);
  }
  assert.match(err.message, /`pg`/);
  assert.match(err.message, /npm ci/);
  assert.ok(err.message.includes(`New-Item -ItemType Junction -Path .claude\\hooks\\node_modules -Target ${path.join(r.primary, '.claude', 'hooks', 'node_modules')}`));
  assert.match(err.message, /never delete a junction recursively/);
});

test('R6: the primary checkout and a plain CI checkout resolve from themselves and list no folder twice', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  assert.equal(primaryRoot(r.primary), r.primary);
  assert.equal(requireDep('pg', { repoRoot: r.primary, nodePath: '' }).marker, 'primary-pg');
  assert.equal(lookupDep('pg', { repoRoot: r.primary, nodePath: '' }).tried.length, 1);
  const none = lookupDep('nope-not-a-package', { repoRoot: r.primary, nodePath: '' });
  assert.equal(none.path, null);
  assert.equal(new Set(none.tried).size, none.tried.length, 'no repeated folder');
  assert.equal(none.tried.length, 2, 'own hooks and own agentic-os only: the primary is the checkout itself');
  // A CI checkout is a plain clone: no worktree and no sibling. A folder that is not a git repo behaves the same.
  const plain = path.join(r.root, 'plain');
  mkdirSync(plain);
  assert.equal(primaryRoot(plain), plain);
  assert.equal(candidateRoots(plain).length, 2);
});

test('R7: a partial node_modules (only .vite) is not an install and does not hide the primary', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  put(path.join(r.wtHooks, 'node_modules', '.vite', 'deps', 'x.json'), '{}\n');
  assert.equal(requireDep('pg', { repoRoot: r.wt, nodePath: '' }).marker, 'primary-pg');
  const lone = fakeRepo();
  put(path.join(lone.wtHooks, 'node_modules', '.vite', 'deps', 'x.json'), '{}\n');
  assert.equal(resolveDep('pg', { repoRoot: lone.wt, nodePath: '' }), null, 'node_modules exists, pg does not: not found');
});

test('R8: injected anchors are the whole lookup: no primary, no NODE_PATH', () => {
  const r = fakeRepo();
  fakePg(r.hooks, 'primary-pg');
  const saved = process.env.NODE_PATH;
  process.env.NODE_PATH = path.join(r.hooks, 'node_modules');
  try {
    const nowhere = path.join(r.root, 'no-such-dir', 'package.json');
    assert.equal(resolveDep('pg', { repoRoot: r.wt, anchors: [nowhere, nowhere] }), null);
    assert.throws(() => requireDep('pg', { repoRoot: r.wt, anchors: [nowhere] }), /^Error: ENV: cannot resolve the `pg` module/);
    assert.equal(requireDep('pg', { repoRoot: r.wt, anchors: [nowhere, path.join(r.hooks, 'package.json')] }).marker, 'primary-pg');
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved;
  }
});

test('R9: primaryRoot maps a worktree to the primary checkout', () => {
  const r = fakeRepo();
  assert.equal(primaryRoot(r.wt), r.primary);
  mkdirSync(path.join(r.wt, 'sub', 'deeper'), { recursive: true });
  assert.equal(primaryRoot(path.join(r.wt, 'sub', 'deeper')), r.primary, 'also from a subfolder of the worktree');
  assert.deepEqual(candidateRoots(r.wt), [r.wtHooks, path.join(r.wt, 'apps', 'agentic-os'), r.hooks, path.join(r.primary, 'apps', 'agentic-os')]);
});

test('R10: a bin is found only on the walk up from the folder, never in the primary', () => {
  const r = fakeRepo();
  put(path.join(r.hooks, 'node_modules', '.bin', 'esbuild.cmd'), '@echo off\r\n');
  put(path.join(r.hooks, 'node_modules', '.bin', 'esbuild'), '#!/bin/sh\n');
  const bare = lookupBin('esbuild', { from: r.wtHooks });
  assert.equal(bare.path, null, 'the primary bin does not help a bare worktree: npm run walks up from the gate folder only');
  assert.ok(bare.tried.includes(path.join(r.wtHooks, 'node_modules', '.bin')));
  const own = lookupBin('esbuild', { from: r.hooks });
  assert.ok(own.path && own.path.startsWith(path.join(r.hooks, 'node_modules', '.bin')));
  // A store above the worktree (the later shared-store work) is on the walk and counts.
  put(path.join(r.wt, '.claude', 'node_modules', '.bin', 'esbuild.cmd'), '@echo off\r\n');
  put(path.join(r.wt, '.claude', 'node_modules', '.bin', 'esbuild'), '#!/bin/sh\n');
  assert.ok(lookupBin('esbuild', { from: r.wtHooks }).path);
});

test('depsHint names the primary hooks folder, the npm ci line and the junction line', () => {
  const text = depsHint('pg', ['x'], 'C:\\primary');
  assert.match(text, /npm ci/);
  assert.match(text, /Dave/);
  assert.match(text, /New-Item -ItemType Junction/);
});
