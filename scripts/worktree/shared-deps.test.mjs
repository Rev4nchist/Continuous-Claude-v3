/**
 * Tests for scripts/worktree/shared-deps.mjs: the shared store link.
 *
 * Every test builds a fake primary under os.tmpdir(): a git repo with a commit, a .claude/hooks/node_modules that holds
 * .package-lock.json, a canary file and a fake package, plus nested git worktrees under .claude/worktrees/<name>.
 * The fake primary also holds committed copies of shared-deps.mjs and resolve-deps.mjs, so the CLI tests run the real
 * script as a primary and as a nested worktree.
 *
 * Cleanup rule: a link is removed on its own (rmdirSync, or unlinkSync for a POSIX symlink). Only then does rmSync
 * remove the temp root, which the test made itself. Nothing recurses through a link.
 *
 * What breaks each test: checkStore returns a wrong state; applyStore links from a worktree, replaces an occupied
 * path or follows a linked target; unlinkStore removes a real folder or the target; the link sits inside a worktree
 * folder (the canary tests); the parent walk no longer reaches the store; the CLI prints a stack or a wrong exit code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStore, checkStore, storeLinkPath, storeTargetPath, unlinkStore } from './shared-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = path.join(HERE, 'shared-deps.mjs');
const REAL_RESOLVER = path.join(HERE, '..', 'lib', 'resolve-deps.mjs');
const PKG = 'zz-shared-store-fakepkg';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
const real = (p) => realpathSync.native(p);

/** Removes one link and nothing else: rmdirSync for a junction, unlinkSync for a POSIX symlink. */
function dropLink(p) {
  if (!isLink(p)) return;
  try { rmdirSync(p); } catch { unlinkSync(p); }
}

function makeFake() {
  const root = mkdtempSync(path.join(tmpdir(), 'sdeps-'));
  const primary = path.join(root, 'primary');
  const links = [];
  const target = path.join(primary, '.claude', 'hooks', 'node_modules');
  mkdirSync(primary, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { windowsHide: true });
  put(path.join(primary, '.gitignore'), 'node_modules/\n.claude/worktrees/\n');
  put(path.join(primary, 'README.md'), 'fake primary\n');
  mkdirSync(path.join(primary, 'scripts', 'worktree'), { recursive: true });
  mkdirSync(path.join(primary, 'scripts', 'lib'), { recursive: true });
  copyFileSync(REAL_SCRIPT, path.join(primary, 'scripts', 'worktree', 'shared-deps.mjs'));
  copyFileSync(REAL_RESOLVER, path.join(primary, 'scripts', 'lib', 'resolve-deps.mjs'));
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '--no-verify', '-m', 'init');
  put(path.join(target, '.package-lock.json'), '{}\n');
  put(path.join(target, 'canary.txt'), 'canary\n');
  put(path.join(target, PKG, 'package.json'), JSON.stringify({ name: PKG, main: 'index.js' }));
  put(path.join(target, PKG, 'index.js'), 'module.exports = 1;\n');
  const addWorktree = (name) => {
    const wt = path.join(primary, '.claude', 'worktrees', name);
    git(primary, 'worktree', 'add', '-q', '-b', `zz-${name}`, wt);
    return wt;
  };
  const link = (to, at) => { symlinkSync(to, at, 'junction'); links.push(at); };
  const cleanup = () => {
    for (const l of [storeLinkPath(primary), ...links]) dropLink(l);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, primary, target, canary: path.join(target, 'canary.txt'), storeLink: storeLinkPath(primary), addWorktree, link, cleanup };
}

/** Runs fn(fake) and always cleans up. */
function withFake(fn) {
  const fake = makeFake();
  try { return fn(fake); } finally { fake.cleanup(); }
}

/** A second folder that looks like an install, used as a wrong or linked target. */
function otherInstall(fake, name) {
  const dir = path.join(fake.root, name);
  put(path.join(dir, '.package-lock.json'), '{}\n');
  return dir;
}

const cli = (cwd, ...args) => spawnSync(process.execPath, [path.join(cwd, 'scripts', 'worktree', 'shared-deps.mjs'), ...args], { encoding: 'utf8', windowsHide: true, cwd, timeout: 60000 });

// ---- the pinned paths ----
test('storeLinkPath and storeTargetPath are the pinned folders under the primary', () => {
  const p = path.join(tmpdir(), 'pin-primary');
  assert.equal(storeLinkPath(p), path.join(p, '.claude', 'worktrees', 'node_modules'));
  assert.equal(storeTargetPath(p), path.join(p, '.claude', 'hooks', 'node_modules'));
});

// ---- checkStore: the seven states ----
test('checkStore: absent when the target is whole and nothing sits at the link path', () => withFake((f) => {
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'absent', r.detail);
  assert.equal(r.link, f.storeLink);
  assert.equal(r.target, f.target);
  assert.equal(typeof r.detail, 'string');
}));

test('checkStore: ok when the link resolves to the target and the target holds .package-lock.json', () => withFake((f) => {
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(f.target, f.storeLink);
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'ok', r.detail);
}));

test('checkStore: dangling when the link exists and the target path is gone', () => withFake((f) => {
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(f.target, f.storeLink);
  renameSync(f.target, `${f.target}.moved`);
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'dangling', r.detail);
}));

test('checkStore: dangling when the link points at a path that does not exist', () => withFake((f) => {
  const gone = otherInstall(f, 'gone');
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(gone, f.storeLink);
  renameSync(gone, `${gone}.moved`);
  assert.equal(checkStore({ primary: f.primary }).state, 'dangling');
}));

test('checkStore: wrong-target when the link resolves somewhere else', () => withFake((f) => {
  const other = otherInstall(f, 'other');
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(other, f.storeLink);
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'wrong-target', r.detail);
}));

test('checkStore: wrong-target, not dangling, when the link goes to another folder and the target path is then gone', () => withFake((f) => {
  const other = otherInstall(f, 'other2');
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(other, f.storeLink);
  renameSync(f.target, `${f.target}.moved`);
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'wrong-target', r.detail);
}));

test('checkStore: not-a-link for a real folder at the link path', () => withFake((f) => {
  put(path.join(f.storeLink, 'x.txt'), 'x\n');
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'not-a-link', r.detail);
}));

test('checkStore: not-a-link for a real file at the link path', () => withFake((f) => {
  put(f.storeLink, 'a file\n');
  assert.equal(checkStore({ primary: f.primary }).state, 'not-a-link');
}));

test('checkStore: no-target when the target is missing', () => withFake((f) => {
  renameSync(f.target, `${f.target}.moved`);
  const r = checkStore({ primary: f.primary });
  assert.equal(r.state, 'no-target', r.detail);
}));

test('checkStore: no-target when the target has no .package-lock.json, with or without a link', () => withFake((f) => {
  unlinkSync(path.join(f.target, '.package-lock.json'));
  assert.equal(checkStore({ primary: f.primary }).state, 'no-target');
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(f.target, f.storeLink);
  assert.equal(checkStore({ primary: f.primary }).state, 'no-target');
}));

// ---- applyStore ----
test('applyStore creates the link in the primary, creating .claude/worktrees first', () => withFake((f) => {
  assert.equal(existsSync(path.dirname(f.storeLink)), false, 'fixture: the worktrees folder starts absent');
  const r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.action, 'linked');
  assert.equal(isLink(f.storeLink), true);
  assert.equal(real(f.storeLink), real(f.target));
  assert.equal(checkStore({ primary: f.primary }).state, 'ok');
  assert.equal(readFileSync(path.join(f.storeLink, 'canary.txt'), 'utf8'), 'canary\n');
}));

test('applyStore refuses from a nested worktree root and makes no link', () => withFake((f) => {
  const wt = f.addWorktree('nested');
  const r = applyStore({ primary: f.primary, root: wt });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(exists(f.storeLink), false);
  assert.equal(exists(path.join(wt, 'node_modules')), false);
}));

test('applyStore refuses when a real folder sits at the link path, and leaves it alone', () => withFake((f) => {
  put(path.join(f.storeLink, 'keep.txt'), 'keep\n');
  const r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(isLink(f.storeLink), false);
  assert.equal(readFileSync(path.join(f.storeLink, 'keep.txt'), 'utf8'), 'keep\n');
}));

test('applyStore refuses when a link already sits at the link path, even a good one', () => withFake((f) => {
  mkdirSync(path.dirname(f.storeLink), { recursive: true });
  f.link(f.target, f.storeLink);
  const r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(checkStore({ primary: f.primary }).state, 'ok');
}));

test('applyStore refuses when the target is itself a link, though checkStore still calls the link path absent', () => withFake((f) => {
  const other = otherInstall(f, 'real-install');
  put(path.join(other, PKG, 'package.json'), '{}\n');
  renameSync(f.target, `${f.target}.moved`);
  f.link(other, f.target);
  assert.equal(checkStore({ primary: f.primary }).state, 'absent');
  const r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.match(r.detail, /link/i);
  assert.equal(exists(f.storeLink), false);
}));

test('applyStore refuses when the target has no .package-lock.json, and when it is missing', () => withFake((f) => {
  unlinkSync(path.join(f.target, '.package-lock.json'));
  let r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(exists(f.storeLink), false);
  renameSync(f.target, `${f.target}.moved`);
  r = applyStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(exists(f.storeLink), false);
}));

test('applyStore refuses a root that git cannot confirm (no repo), even when root equals primary', () => withFake((f) => {
  const plain = path.join(f.root, 'plain');
  put(path.join(plain, '.claude', 'hooks', 'node_modules', '.package-lock.json'), '{}\n');
  const r = applyStore({ primary: plain, root: plain });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(exists(storeLinkPath(plain)), false);
}));

test('applyStore refuses a nested worktree root, where .git is a file, when it is also its own primary argument', () => withFake((f) => {
  const wt = f.addWorktree('filegit');
  assert.equal(lstatSync(path.join(wt, '.git')).isFile(), true, 'fixture: a worktree has a .git file');
  const r = applyStore({ primary: wt, root: wt });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(exists(storeLinkPath(wt)), false);
}));

test('unlinkStore refuses a root that git cannot confirm and keeps a link there', () => withFake((f) => {
  const plain = path.join(f.root, 'plain2');
  const target = storeTargetPath(plain);
  put(path.join(target, '.package-lock.json'), '{}\n');
  mkdirSync(path.dirname(storeLinkPath(plain)), { recursive: true });
  f.link(target, storeLinkPath(plain));
  const r = unlinkStore({ primary: plain, root: plain });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(isLink(storeLinkPath(plain)), true);
}));

test("applyStore returns 'refused' and leaves no link when the link call throws", () => withFake((f) => {
  const boom = () => { throw Object.assign(new Error('no rights'), { code: 'EPERM' }); };
  const r = applyStore({ primary: f.primary, root: f.primary, symlink: boom });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.match(r.detail, /EPERM/);
  assert.equal(exists(f.storeLink), false);
}));

// ---- unlinkStore ----
test('unlinkStore removes only the link and leaves the target and its canary', () => withFake((f) => {
  assert.equal(applyStore({ primary: f.primary, root: f.primary }).ok, true);
  const before = readFileSync(f.canary, 'utf8');
  const r = unlinkStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.action, 'unlinked');
  assert.equal(exists(f.storeLink), false);
  assert.equal(readFileSync(f.canary, 'utf8'), before);
  assert.equal(existsSync(path.join(f.target, PKG, 'index.js')), true);
  assert.equal(checkStore({ primary: f.primary }).state, 'absent');
}));

test('unlinkStore removes a dangling link too', () => withFake((f) => {
  assert.equal(applyStore({ primary: f.primary, root: f.primary }).ok, true);
  renameSync(f.target, `${f.target}.moved`);
  const r = unlinkStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.action, 'unlinked');
  assert.equal(exists(f.storeLink), false);
  assert.equal(existsSync(path.join(`${f.target}.moved`, 'canary.txt')), true);
}));

test('unlinkStore refuses a real folder at the link path and keeps its files', () => withFake((f) => {
  put(path.join(f.storeLink, 'keep.txt'), 'keep\n');
  const r = unlinkStore({ primary: f.primary, root: f.primary });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(readFileSync(path.join(f.storeLink, 'keep.txt'), 'utf8'), 'keep\n');
}));

test('unlinkStore refuses from a nested worktree root and keeps the link', () => withFake((f) => {
  assert.equal(applyStore({ primary: f.primary, root: f.primary }).ok, true);
  const wt = f.addWorktree('nested');
  const r = unlinkStore({ primary: f.primary, root: wt });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.action, 'refused');
  assert.equal(checkStore({ primary: f.primary }).state, 'ok');
}));

// ---- the canary and the parent walk ----
test('the canary survives git worktree remove and git worktree remove --force of nested worktrees', () => withFake((f) => {
  assert.equal(applyStore({ primary: f.primary, root: f.primary }).ok, true);
  const a = f.addWorktree('plain');
  const b = f.addWorktree('forced');
  assert.equal(existsSync(path.join(a, 'README.md')), true);
  git(f.primary, 'worktree', 'remove', a);
  assert.equal(existsSync(a), false, 'the worktree is gone');
  assert.equal(readFileSync(f.canary, 'utf8'), 'canary\n', 'canary after plain remove');
  assert.equal(checkStore({ primary: f.primary }).state, 'ok');
  put(path.join(b, 'dirty.txt'), 'untracked\n');
  git(f.primary, 'worktree', 'remove', '--force', b);
  assert.equal(existsSync(b), false);
  assert.equal(readFileSync(f.canary, 'utf8'), 'canary\n', 'canary after forced remove');
  assert.equal(existsSync(path.join(f.target, PKG, 'index.js')), true);
  assert.equal(checkStore({ primary: f.primary }).state, 'ok');
}));

test('a package in the target resolves from a nested worktree folder only through the link (parent walk)', () => withFake((f) => {
  const wt = f.addWorktree('walker');
  const from = createRequire(path.join(wt, '.claude', 'hooks', 'x.js'));
  assert.throws(() => from.resolve(PKG), { code: 'MODULE_NOT_FOUND' }, 'no link yet: the walk must miss');
  assert.equal(applyStore({ primary: f.primary, root: f.primary }).ok, true);
  const again = createRequire(path.join(wt, '.claude', 'hooks', 'y.js'));
  assert.equal(real(again.resolve(PKG)), real(path.join(f.target, PKG, 'index.js')));
}));

// ---- the CLI, run as the real script inside the fake primary ----
test('CLI: --help exits 0 and names the flags', () => withFake((f) => {
  const r = cli(f.primary, '--help');
  assert.equal(r.status, 0, r.stderr);
  for (const flag of ['--check', '--apply', '--unlink']) assert.ok(r.stdout.includes(flag), r.stdout);
}));

test('CLI: no args exits 2 with one short usage message and no stack', () => withFake((f) => {
  const r = cli(f.primary);
  assert.equal(r.status, 2);
  const text = `${r.stdout}${r.stderr}`;
  assert.match(text, /usage/i);
  assert.doesNotMatch(text, /\n\s+at /);
  assert.ok(text.trim().split(/\r?\n/).length <= 3, text);
}));

test('CLI: an unknown flag exits 2 with no stack', () => withFake((f) => {
  const r = cli(f.primary, '--nope');
  assert.equal(r.status, 2);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\n\s+at /);
}));

test('CLI: --check, --apply and --unlink in the primary, and the worktree copy refuses to change anything', () => withFake((f) => {
  let r = cli(f.primary, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^STORE absent: /, r.stdout);
  assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, 'one line');
  const wt = f.addWorktree('cli');
  assert.equal(existsSync(path.join(wt, 'scripts', 'worktree', 'shared-deps.mjs')), true, 'the worktree holds its own committed copy');
  r = cli(wt, '--apply');
  assert.notEqual(r.status, 0, 'apply from a worktree must refuse');
  assert.equal(exists(f.storeLink), false);
  r = cli(f.primary, '--apply');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(isLink(f.storeLink), true);
  r = cli(f.primary, '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^STORE ok/);
  r = cli(wt, '--check');
  assert.equal(r.status, 0, 'a worktree can check the primary store');
  r = cli(wt, '--unlink');
  assert.notEqual(r.status, 0, 'unlink from a worktree must refuse');
  assert.equal(isLink(f.storeLink), true);
  r = cli(f.primary, '--unlink');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(exists(f.storeLink), false);
  assert.equal(readFileSync(f.canary, 'utf8'), 'canary\n');
}));

test('CLI: --check prints one STORE line with the state when the link is dangling', () => withFake((f) => {
  assert.equal(cli(f.primary, '--apply').status, 0);
  renameSync(f.target, `${f.target}.moved`);
  const r = cli(f.primary, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^STORE dangling: /);
}));
