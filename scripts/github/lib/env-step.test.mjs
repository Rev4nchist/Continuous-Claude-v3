/**
 * env-step.test.mjs: the pre-pr ENV step (scripts/github/lib/env-step.mjs), on fake repos with REAL git worktrees.
 * Each test names the change that breaks it:
 *   V1 bare worktree names the missing bin    breaks if a bin in the primary is accepted for a gate run in the worktree
 *   V2 own install and the primary are quiet  breaks if the step prints for a checkout that has everything
 *   V3 pg needs the primary                   breaks if pg is judged on the own checkout only
 *   V4 scrub cli.js is made absolute          breaks if the relative node_modules path is left in the gate args
 *   V5 lockfile                               breaks if a changed lockfile passes, or if an unchanged one fails
 *   V6 drift is a NOTE                        breaks if drift becomes a FAIL, shows when the pair agrees, or loses the pair
 *   V7 childEnv                               breaks if NODE_PATH misses the primary, replaces the old value, or is set in the primary
 *   V8 envPrefix                              breaks if a missing relative import is called ENV, or a missing package is not
 *   V9 a gate with no need is untouched       breaks if gates not in GATE_NEEDS get blocked
 *   V10 app gates need the app install        breaks if a bare worktree runs the lint or typecheck gate, or the ENV line misses the lockfile install
 *   V11 the hooks store is no app install      breaks if typescript or eslint found up the walk (the shared store) satisfies an app gate
 *   V12 an app install is quiet               breaks if a worktree or the primary with the app packages still gets a line
 *   V10b the primary's app install is no help breaks if a bare worktree passes the app gates because the primary has the app packages
 *   V13 a partial app install blocks          breaks if the app packages without node_modules/.package-lock.json (an interrupted npm ci) pass
 *   V14 a stale app install after a lockfile change  breaks if an install of another app lockfile passes when the branch changes the app lockfile, or an unchanged lockfile fails
 *   V15 only the app folder counts            breaks if next or eslint-config-next in a folder above apps/agentic-os (the worktree root) satisfies an app gate
 *   V16 script mode on a full install         breaks if the script gives the app gates the root as their folder: false ENV lines and exit 1 on a full install
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_NEEDS, LOCK_TEXT, childEnv, envPrefix, envStep } from './env-step.mjs';

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
const made = [];
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** An install of the app in `dir`: the two app packages at `version`, and (unless `marker` is false) the hidden lockfile that a finished npm ci writes. */
function appInstall(dir, version, { marker = true } = {}) {
  const modules = path.join(dir, 'apps', 'agentic-os', 'node_modules');
  for (const pkg of ['next', 'eslint-config-next']) put(path.join(modules, pkg, 'package.json'), JSON.stringify({ name: pkg, version }));
  if (marker) put(path.join(modules, '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/next': { version } } }));
}

/** A primary with one commit and a bare nested worktree. The primary's hooks has a full fake install unless `install` is false. */
function fakeRepo({ install = true, lock = '{"v":1}\n', typescript = '7.0.2', app = false } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'envstep-')));
  made.push(root);
  const primary = path.join(root, 'primary');
  mkdirSync(primary);
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { windowsHide: true });
  put(path.join(primary, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
  put(path.join(primary, '.claude', 'hooks', 'package-lock.json'), lock);
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '--no-verify', '-m', 'init');
  const hooks = path.join(primary, '.claude', 'hooks');
  if (install) {
    put(path.join(hooks, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/typescript': { version: typescript } } }));
    for (const pkg of ['pg', 'vitest', 'typescript']) {
      put(path.join(hooks, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, main: 'index.js' }));
      put(path.join(hooks, 'node_modules', pkg, 'index.js'), 'module.exports = {};\n');
    }
    put(path.join(hooks, 'node_modules', '.bin', 'esbuild'), '#!/bin/sh\n');
    put(path.join(hooks, 'node_modules', '.bin', 'esbuild.cmd'), '@echo off\r\n');
    put(path.join(hooks, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
    put(path.join(hooks, 'node_modules', '.bin', 'tsc.cmd'), '@echo off\r\n');
    if (app) appInstall(primary, '1.0.0');
    put(path.join(primary, 'node_modules', '@playwright', 'test', 'package.json'), '{"name":"@playwright/test","version":"1.0.0"}');
    put(path.join(primary, 'node_modules', '@playwright', 'test', 'cli.js'), '// cli\n');
  }
  const wt = path.join(primary, '.claude', 'worktrees', 'wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'wt', wt);
  return { root, primary, wt, hooks, wtHooks: path.join(wt, '.claude', 'hooks') };
}

const gate = (id, cwd = '.', args = []) => ({ id, cmd: 'node', args, cwd, timeoutMs: 1000 });
const ALL = () => Object.keys(GATE_NEEDS).map((id) => gate(id, id.startsWith('hooks-') ? '.claude/hooks' : id.startsWith('agentic-os-') ? 'apps/agentic-os' : '.'));

test('V1: a bare worktree names the missing esbuild bin and vitest, and blocks those gates only', () => {
  const r = fakeRepo();
  const out = envStep({ root: r.wt, gates: [gate('hooks-build', '.claude/hooks'), gate('hooks-vitest', '.claude/hooks'), gate('coordination-db-tests')] });
  assert.match(out.fail, /^ENV: hooks-build needs esbuild\. Tried /);
  assert.ok(out.fail.includes(path.join(r.wtHooks, 'node_modules', '.bin')), 'names the own folder it tried');
  assert.ok(!out.fail.includes(path.join(r.hooks, 'node_modules', '.bin')), 'the primary bin is not on the walk');
  assert.match(out.fail, /This is the environment, not your change\. Fix: run `node scripts\/worktree\/shared-deps\.mjs --check` in /);
  assert.match(out.fail, /--apply` in the primary \(one shared link, never inside a worktree\)/);
  assert.match(out.fail, /Fallback only for a worktree outside the primary/);
  assert.match(out.fail, /New-Item -ItemType Junction/);
  assert.equal(out.others.length, 1);
  assert.match(out.others[0], /^ENV: hooks-vitest needs vitest\./);
  assert.deepEqual([...out.blocked].sort(), ['hooks-build', 'hooks-vitest']);
});

test('V1b: a bare worktree names the missing tsc bin and blocks hooks-tsc', () => {
  const r = fakeRepo({ install: false });
  const out = envStep({ root: r.wt, gates: [gate('hooks-tsc', '.claude/hooks')], nodePath: '' });
  assert.match(out.fail, /^ENV: hooks-tsc needs tsc\. Tried /);
  assert.ok(out.blocked.has('hooks-tsc'));
});

test('V2: the primary, and a worktree with its own install, add no line', () => {
  const r = fakeRepo({ app: true });
  const inPrimary = envStep({ root: r.primary, gates: ALL() });
  assert.equal(inPrimary.fail, null, inPrimary.fail);
  assert.equal(inPrimary.blocked.size, 0);
  assert.equal(inPrimary.note, null);
  // A worktree with its own complete install of hooks and of the app.
  appInstall(r.wt, '1.0.0');
  put(path.join(r.wtHooks, 'node_modules', '.package-lock.json'), '{}\n');
  for (const pkg of ['vitest', 'pg', 'typescript']) put(path.join(r.wtHooks, 'node_modules', pkg, 'package.json'), '{}');
  put(path.join(r.wtHooks, 'node_modules', '.bin', 'esbuild.cmd'), '@echo off\r\n');
  put(path.join(r.wtHooks, 'node_modules', '.bin', 'esbuild'), '#!/bin/sh\n');
  put(path.join(r.wtHooks, 'node_modules', '.bin', 'tsc.cmd'), '@echo off\r\n');
  put(path.join(r.wtHooks, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
  const own = envStep({ root: r.wt, gates: ALL() });
  assert.equal(own.fail, null, own.fail);
});

test('V3: pg and typescript are found through the primary from a bare worktree; nothing in either place is one FAIL', () => {
  const r = fakeRepo();
  const ok = envStep({ root: r.wt, gates: [gate('coordination-db-tests'), gate('github-tests'), gate('mods-validate')] });
  assert.equal(ok.fail, null, ok.fail);
  const none = fakeRepo({ install: false });
  const miss = envStep({ root: none.wt, gates: [gate('coordination-db-tests')], nodePath: '' }); // no ambient NODE_PATH: a shell or a pre-pr child may set one
  assert.match(miss.fail, /^ENV: coordination-db-tests needs pg\./);
  assert.ok(miss.fail.includes(path.join(none.primary, '.claude', 'hooks')), 'lists the primary folder');
});

test('V4: the scrub gate gets an absolute cli.js from the primary; a missing @playwright/test blocks it', () => {
  const r = fakeRepo();
  const rel = ['node_modules/@playwright/test/cli.js', 'test', '--config', 'x'];
  const out = envStep({ root: r.wt, gates: [gate('scrub-invariant', '.', rel)] });
  assert.equal(out.fail, null, out.fail);
  assert.equal(out.gates[0].args[0], path.join(r.primary, 'node_modules', '@playwright', 'test', 'cli.js'));
  assert.deepEqual(out.gates[0].args.slice(1), rel.slice(1));
  const none = fakeRepo({ install: false });
  assert.match(envStep({ root: none.wt, gates: [gate('scrub-invariant', '.', rel)] }).fail, /^ENV: scrub-invariant needs @playwright\/test\./);
});

test('V5: a branch that changes the hooks lockfile FAILs with its own text; an unchanged or equal one does not', () => {
  const r = fakeRepo();
  const lock = '.claude/hooks/package-lock.json';
  put(path.join(r.wtHooks, 'package-lock.json'), '{"v":2}\n');
  const changed = envStep({ root: r.wt, gates: [], changed: [lock] });
  assert.equal(changed.fail, LOCK_TEXT);
  assert.equal(changed.fail, 'ENV: this branch changes .claude/hooks/package-lock.json, so it needs its own npm ci in this worktree (Dave approves an install). The primary\'s packages would give a wrong green.');
  assert.equal(envStep({ root: r.wt, gates: [], changed: ['scripts/a.mjs'] }).fail, null, 'the diff does not touch the lock');
  put(path.join(r.wtHooks, 'package-lock.json'), '{"v":1}\n');
  assert.equal(envStep({ root: r.wt, gates: [], changed: [lock] }).fail, null, 'the lock equals the primary lock');
  assert.equal(envStep({ root: r.primary, gates: [], changed: [lock] }).fail, null, 'the primary is compared with itself');
  // Strict: an install that merely exists does not clear it. The worktree's install must match the branch's own lockfile.
  const lockV2 = JSON.stringify({ packages: { '': { devDependencies: { typescript: '7.0.2' } }, 'node_modules/typescript': { version: '7.0.2' } } });
  put(path.join(r.wtHooks, 'package-lock.json'), lockV2);
  const wtMarker = path.join(r.wtHooks, 'node_modules', '.package-lock.json');
  put(wtMarker, JSON.stringify({ packages: { 'node_modules/typescript': { version: '5.9.3' } } }));
  assert.equal(envStep({ root: r.wt, gates: [], changed: [lock] }).fail, LOCK_TEXT, 'an install of an older lockfile still FAILs');
  put(wtMarker, JSON.stringify({ packages: {} }));
  assert.equal(envStep({ root: r.wt, gates: [], changed: [lock] }).fail, LOCK_TEXT, 'a direct dependency that is not installed still FAILs');
  put(wtMarker, JSON.stringify({ packages: { 'node_modules/typescript': { version: '7.0.2' } } }));
  assert.equal(envStep({ root: r.wt, gates: [], changed: [lock] }).fail, null, 'an install that matches the branch lockfile clears it');
  // CRLF alone is not a change.
  put(path.join(r.wtHooks, 'package-lock.json'), '{"v":1}\r\n');
  assert.equal(envStep({ root: r.wt, gates: [], changed: [lock] }).fail, null);
});

test('V6: installed typescript that differs from the lock is a NOTE with the pair, never a FAIL; quiet when they agree', () => {
  const r = fakeRepo({ lock: JSON.stringify({ packages: { 'node_modules/typescript': { version: '7.0.2' } } }), typescript: '5.9.3' });
  const drift = envStep({ root: r.wt, gates: [gate('hooks-vitest', '.claude/hooks')] });
  assert.equal(drift.note, "installed typescript 5.9.3, lock says 7.0.2: run npm ci in .claude/hooks (Dave's yes)");
  const noGate = envStep({ root: r.wt, gates: [gate('coordination-tests')] });
  assert.equal(noGate.note, null, 'no gate that uses the hooks packages runs');
  const same = fakeRepo({ lock: JSON.stringify({ packages: { 'node_modules/typescript': { version: '5.9.3' } } }), typescript: '5.9.3' });
  assert.equal(envStep({ root: same.wt, gates: [gate('hooks-vitest', '.claude/hooks')] }).note, null);
});

test('V7: childEnv appends the primary node_modules to NODE_PATH in a bare worktree, and sets nothing in the primary', () => {
  const r = fakeRepo();
  assert.equal(childEnv(r.primary, { NODE_PATH: 'x' }), null);
  const old = path.join(r.root, 'old'); // no drive letter: ':' is the NODE_PATH delimiter on Linux
  const env = childEnv(r.wt, { NODE_PATH: old, KEEP: '1' });
  assert.deepEqual(env.NODE_PATH.split(path.delimiter), [old, path.join(r.hooks, 'node_modules')]);
  assert.equal(env.KEEP, '1', 'the rest of the env is kept');
  assert.deepEqual(childEnv(r.wt, {}).NODE_PATH.split(path.delimiter), [path.join(r.hooks, 'node_modules')]);
  // A partial node_modules (only .vite) is not an install: the primary is still added.
  put(path.join(r.wtHooks, 'node_modules', '.vite', 'x.json'), '{}');
  assert.ok(childEnv(r.wt, {}).NODE_PATH.includes(path.join(r.hooks, 'node_modules')));
  // An own complete install: nothing added for that folder.
  put(path.join(r.wtHooks, 'node_modules', '.package-lock.json'), '{}');
  assert.equal(childEnv(r.wt, {}), null);
});

test('V8: envPrefix calls a missing package ENV and a missing relative import a code bug', () => {
  const primary = path.join(tmpdir(), 'primary'); // an absolute path of the machine the test runs on (Windows or Linux)
  const gone = path.join(tmpdir(), 'x', 'gone.mjs');
  const here = path.join(tmpdir(), 'x', 'a.mjs');
  const info = { primary, status: 1, summary: '# fail 4' };
  const pkg = envPrefix(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from ${here}`, info);
  assert.ok(pkg.startsWith('ENV: exit 1: # fail 4. This is the environment, not your change. Fix: run `node scripts/worktree/shared-deps.mjs --check` in '), pkg);
  assert.ok(pkg.includes(path.join(primary, '.claude', 'hooks')), pkg);
  assert.match(envPrefix("Error: Cannot find module 'vitest'\ncode: 'MODULE_NOT_FOUND'", info), /^ENV: /);
  assert.equal(envPrefix(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${gone}' imported from ${here}`, info), null);
  assert.equal(envPrefix("Error: Cannot find module './gone.mjs'\ncode: 'MODULE_NOT_FOUND'", info), null);
  assert.equal(envPrefix('# fail 4\nAssertionError: expected 1', info), null);
});

test('V9: a gate that is not in GATE_NEEDS is never blocked', () => {
  const r = fakeRepo({ install: false });
  const out = envStep({ root: r.wt, gates: [gate('context-budget'), gate('coordination-tests'), gate('audit-skills')] });
  assert.equal(out.fail, null);
  assert.equal(out.blocked.size, 0);
});

const APP = 'apps/agentic-os';
const appGates = () => [gate('agentic-os-lint', APP), gate('agentic-os-typecheck', APP)];

test('V10: a bare worktree blocks both app gates with ONE ENV line that says a lockfile npm ci in this worktree fixes it', () => {
  const r = fakeRepo();
  const out = envStep({ root: r.wt, gates: appGates(), nodePath: '' });
  assert.match(out.fail, /^ENV: agentic-os-lint needs eslint-config-next\. Tried /);
  assert.ok(out.fail.includes(path.join(r.wt, APP, 'node_modules')), 'names the own app folder it tried');
  assert.match(out.fail, /This is the environment, not your change\. Fix: .*npm ci --ignore-scripts.*lockfile.*apps\/agentic-os.*this worktree/);
  assert.ok(!/shared-deps/.test(out.fail), 'the hooks store hint does not apply to the app');
  assert.equal(out.others.length, 1);
  assert.match(out.others[0], /^ENV: agentic-os-typecheck needs next\./);
  assert.deepEqual([...out.blocked].sort(), ['agentic-os-lint', 'agentic-os-typecheck']);
});

test('V11: the hooks packages up the walk (the shared store link) do not satisfy an app gate', () => {
  const r = fakeRepo();
  const store = path.join(r.primary, '.claude', 'worktrees', 'node_modules');
  for (const pkg of ['typescript', 'eslint', 'vitest']) put(path.join(store, pkg, 'package.json'), JSON.stringify({ name: pkg }));
  put(path.join(store, '.bin', 'tsc'), '#!/bin/sh\n');
  put(path.join(store, '.bin', 'tsc.cmd'), '@echo off\r\n');
  const out = envStep({ root: r.wt, gates: appGates(), nodePath: '' });
  assert.deepEqual([...out.blocked].sort(), ['agentic-os-lint', 'agentic-os-typecheck']);
});

test('V12: a worktree with its own app install, and the primary, add no line for the app gates', () => {
  const r = fakeRepo({ app: true });
  assert.equal(envStep({ root: r.primary, gates: appGates() }).fail, null);
  appInstall(r.wt, '1.0.0');
  const own = envStep({ root: r.wt, gates: appGates(), nodePath: '' });
  assert.equal(own.fail, null, own.fail);
  assert.equal(own.blocked.size, 0);
});

const APP_IDS = ['agentic-os-lint', 'agentic-os-typecheck'];

test('V10b: the primary has an app install, a bare worktree still blocks both app gates (the primary does not count)', () => {
  const r = fakeRepo({ app: true });
  const out = envStep({ root: r.wt, gates: appGates(), nodePath: '' });
  assert.deepEqual([...out.blocked].sort(), APP_IDS);
  assert.ok(out.fail.includes(path.join(r.wt, APP, 'node_modules')), 'names the own app folder it tried');
});

test('V13: the app packages without node_modules/.package-lock.json are a partial install and block; the hidden lockfile clears it', () => {
  const r = fakeRepo();
  appInstall(r.wt, '1.0.0', { marker: false });
  const partial = envStep({ root: r.wt, gates: appGates(), nodePath: '' });
  assert.deepEqual([...partial.blocked].sort(), APP_IDS);
  assert.match(partial.fail, /^ENV: agentic-os-lint needs eslint-config-next\. Tried /);
  appInstall(r.wt, '1.0.0');
  assert.equal(envStep({ root: r.wt, gates: appGates(), nodePath: '' }).fail, null);
});

test('V14: a branch that changes the app lockfile needs an install of that lockfile; an unchanged lockfile and a matching install are quiet', () => {
  const r = fakeRepo();
  const lockOf = (version) => JSON.stringify({ packages: { '': { dependencies: { next: version } }, 'node_modules/next': { version } } });
  put(path.join(r.primary, APP, 'package-lock.json'), lockOf('1.0.0'));
  put(path.join(r.wt, APP, 'package-lock.json'), lockOf('2.0.0'));
  const changed = [`${APP}/package-lock.json`];
  appInstall(r.wt, '1.0.0');
  const stale = envStep({ root: r.wt, gates: appGates(), changed, nodePath: '' });
  assert.match(stale.fail, /^ENV: this branch changes apps\/agentic-os\/package-lock\.json, so it needs its own .*npm ci.* in apps\/agentic-os of this worktree/);
  assert.equal(envStep({ root: r.wt, gates: appGates(), changed: [], nodePath: '' }).fail, null, 'the branch does not change the app lockfile');
  appInstall(r.wt, '2.0.0');
  assert.equal(envStep({ root: r.wt, gates: appGates(), changed, nodePath: '' }).fail, null, 'the install matches the lockfile');
  appInstall(r.primary, '0.0.1');
  assert.equal(envStep({ root: r.primary, gates: appGates(), changed, nodePath: '' }).fail, null, 'the primary is never judged against its own lockfile');
});

test('V15: the app packages in a folder above apps/agentic-os (the worktree root, apps) do not satisfy an app gate', () => {
  const r = fakeRepo();
  for (const dir of [r.wt, path.join(r.wt, 'apps')]) {
    for (const pkg of ['next', 'eslint-config-next']) put(path.join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg }));
    put(path.join(dir, 'node_modules', '.package-lock.json'), '{"packages":{}}');
  }
  assert.deepEqual([...envStep({ root: r.wt, gates: appGates(), nodePath: '' }).blocked].sort(), APP_IDS);
});

test('V16: the script on a checkout with every install prints env ok and exits 0 (the app gates are looked up from the app folder)', () => {
  const r = fakeRepo({ app: true });
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'env-step.mjs');
  const run = spawnSync(process.execPath, [script, '--root', r.primary], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /env ok/);
});
