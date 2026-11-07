/**
 * Tests for scripts/worktree/orphans.mjs: the dry-run orphan folder report.
 *
 * Every test builds a fake primary under os.tmpdir(): a git repo on `main` with one commit, real `git worktree add`
 * worktrees, a node_modules junction, and orphan folders of every kind under .claude/worktrees.
 * The fake never touches the real .claude/worktrees folder of this repo.
 *
 * Time: buildReport takes `now`. A test that needs an "old" folder passes now = real now + 3 days instead of editing
 * mtimes, because the helper reads the newest mtime inside the folder.
 *
 * Cleanup rule: the test removes a junction on its own first. Only then does it recurse through the temp root it made.
 *
 * What breaks each test: a live worktree is listed as an orphan; the node_modules link or a plain file is listed as
 * an orphan; an empty or .tldr-only folder is not a candidate; a folder with data is a candidate; a young folder or a
 * folder named like an open lane is a candidate; a dirty or unmerged git orphan is a candidate; a folder with a fake
 * .git folder reports the primary repo's state; the walk follows a junction; the helper deletes or changes anything;
 * the CLI accepts a delete flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, formatReport, humanAge, humanSize, laneMatch, parseLanes, removeCommand, scanFolder } from './orphans.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'orphans.mjs');
const DAY = 24 * 3600 * 1000;

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/** A listing of every path under dir with its size and mtime. Links are listed, never followed. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = lstatSync(p);
      out.push(`${path.relative(dir, p)}|${e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file'}|${st.size}|${st.mtimeMs}`);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function dropLinks(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { try { rmdirSync(p); } catch { unlinkSync(p); } } else if (e.isDirectory()) dropLinks(p);
  }
}

/** A fake primary with the full set of folders. Returns paths and a cleanup function. */
function makeFake() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'orph-')));
  const primary = path.join(base, 'primary');
  const wt = path.join(primary, '.claude', 'worktrees');
  mkdirSync(primary, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { windowsHide: true });
  put(path.join(primary, '.gitignore'), '.claude/worktrees/\n');
  put(path.join(primary, 'README.md'), 'fake primary\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '--no-verify', '-m', 'init');
  mkdirSync(wt, { recursive: true });

  // A live worktree: must never be an orphan.
  git(primary, 'worktree', 'add', '-q', '-b', 'feat/live', path.join(wt, 'live'));
  put(path.join(wt, 'live', 'work.txt'), 'in flight\n');

  // The shared store link and a plain file: neither is an orphan.
  const store = path.join(base, 'store');
  put(path.join(store, 'canary.txt'), 'canary\n');
  symlinkSync(store, path.join(wt, 'node_modules'), 'junction');
  put(path.join(wt, 'kp.bak'), 'plain file\n');

  // Orphans without git.
  mkdirSync(path.join(wt, 'empty-old'));
  put(path.join(wt, 'tldr-only', '.tldr', 'cache.json'), '{}\n');
  put(path.join(wt, 'data-old', 'a.txt'), 'a\n');
  put(path.join(wt, 'data-old', 'sub', 'b.txt'), 'bb\n');
  mkdirSync(path.join(wt, 'lane-empty'));
  put(path.join(wt, 'has-link', 'x.txt'), 'x\n');
  symlinkSync(store, path.join(wt, 'has-link', 'inner'), 'junction');
  mkdirSync(path.join(wt, 'fake-git', '.git'), { recursive: true });

  // Orphans with their own git repo (clones of the fake primary).
  const clone = (name) => execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', primary, path.join(wt, name)], { windowsHide: true });
  clone('git-clean');
  clone('git-dirty');
  put(path.join(wt, 'git-dirty', 'new.txt'), 'untracked\n');
  clone('git-unmerged');
  put(path.join(wt, 'git-unmerged', 'more.txt'), 'more\n');
  git(path.join(wt, 'git-unmerged'), 'add', '-A');
  git(path.join(wt, 'git-unmerged'), 'commit', '-q', '--no-verify', '-m', 'unmerged work');

  // Clean status and HEAD merged into main, but the repo still holds work that only this folder has.
  clone('git-stash');
  put(path.join(wt, 'git-stash', 'README.md'), 'edited then stashed\n');
  git(path.join(wt, 'git-stash'), 'stash', 'push', '-q');
  clone('git-ignored');
  put(path.join(wt, 'git-ignored', '.git', 'info', 'exclude'), '.env\n');
  put(path.join(wt, 'git-ignored', '.env'), 'SECRET=1\n');
  clone('git-side');
  git(path.join(wt, 'git-side'), 'switch', '-q', '-c', 'side');
  put(path.join(wt, 'git-side', 'side.txt'), 'side\n');
  git(path.join(wt, 'git-side'), 'add', '-A');
  git(path.join(wt, 'git-side'), 'commit', '-q', '--no-verify', '-m', 'side work');
  git(path.join(wt, 'git-side'), 'switch', '-q', 'main');

  const cleanup = () => { dropLinks(base); rmSync(base, { recursive: true, force: true }); };
  return { base, primary, wt, store, cleanup };
}

const LANES = [{ id: 'lane-empty', state: 'active' }, { id: 'other-lane', state: 'backlog' }];
const byName = (report) => Object.fromEntries(report.orphans.map((o) => [o.name, o]));
const farFuture = () => Date.now() + 3 * DAY;

test('lists only real orphans, and keeps the live worktree, the link and plain files out', () => {
  const f = makeFake();
  try {
    const r = buildReport({ root: f.primary, now: farFuture(), lanes: LANES });
    const names = r.orphans.map((o) => o.name).sort();
    assert.deepEqual(names, ['data-old', 'empty-old', 'fake-git', 'git-clean', 'git-dirty', 'git-ignored', 'git-side', 'git-stash', 'git-unmerged', 'has-link', 'lane-empty', 'tldr-only']);
    assert.ok(!names.includes('live'), 'the in-flight worktree is never an orphan');
    assert.ok(!names.includes('node_modules'));
    assert.deepEqual(r.plainFiles, ['kp.bak']);
    assert.deepEqual(r.skippedLinks, ['node_modules']);
    assert.ok(!r.orphans.some((o) => o.verdict === 'candidate' && o.name === 'live'));
  } finally { f.cleanup(); }
});

test('verdicts: empty and .tldr-only are candidates; data is kept', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(o['empty-old'].verdict, 'candidate');
    assert.equal(o['tldr-only'].verdict, 'candidate');
    assert.equal(o['data-old'].verdict, 'keep');
    assert.match(o['data-old'].reason, /has data/);
    assert.equal(o['data-old'].files, 2);
    assert.equal(o['data-old'].bytes, 5);
    assert.equal(o['data-old'].hasGit, false);
  } finally { f.cleanup(); }
});

test('a folder younger than 24 hours is kept as possibly live', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: Date.now() + 60 * 1000, lanes: LANES }));
    assert.equal(o['empty-old'].verdict, 'keep');
    assert.match(o['empty-old'].reason, /possibly live/);
    const later = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(later['empty-old'].verdict, 'candidate');
  } finally { f.cleanup(); }
});

test('a folder named like an open or active lane is kept as possibly live', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(o['lane-empty'].verdict, 'keep');
    assert.match(o['lane-empty'].reason, /possibly live/);
    assert.match(o['lane-empty'].lane, /active/);
    assert.equal(o['empty-old'].lane, 'none');
  } finally { f.cleanup(); }
});

test('a done lane does not protect a folder; an unknown lane lookup keeps every folder', () => {
  const f = makeFake();
  try {
    const done = byName(buildReport({ root: f.primary, now: farFuture(), lanes: [{ id: 'lane-empty', state: 'done' }] }));
    assert.equal(done['lane-empty'].verdict, 'candidate');
    const unknown = byName(buildReport({ root: f.primary, now: farFuture(), lanes: null }));
    assert.equal(unknown['empty-old'].lane, 'unknown');
    assert.equal(unknown['empty-old'].verdict, 'keep');
    assert.match(unknown['empty-old'].reason, /lane unknown/);
  } finally { f.cleanup(); }
});

test('git orphans: clean and merged is a candidate; dirty or unmerged is kept', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(o['git-clean'].hasGit, true);
    assert.equal(o['git-clean'].git.dirty, 0);
    assert.equal(o['git-clean'].git.merged, true);
    assert.equal(o['git-clean'].verdict, 'candidate');
    assert.equal(o['git-dirty'].git.dirty, 1);
    assert.equal(o['git-dirty'].verdict, 'keep');
    assert.match(o['git-dirty'].reason, /has data/);
    assert.equal(o['git-unmerged'].git.merged, false);
    assert.equal(o['git-unmerged'].verdict, 'keep');
    assert.match(o['git-unmerged'].reason, /has data/);
  } finally { f.cleanup(); }
});

test('git orphans holding a stash, an ignored file or an unmerged side branch are kept', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    for (const name of ['git-stash', 'git-ignored', 'git-side']) {
      assert.equal(o[name].git.dirty, 0, `${name}: status is clean`);
      assert.equal(o[name].git.merged, true, `${name}: HEAD is merged into main`);
      assert.equal(o[name].verdict, 'keep', name);
      assert.match(o[name].reason, /has data/, name);
    }
    assert.equal(o['git-stash'].git.stashes, 1);
    assert.equal(o['git-ignored'].git.ignored, 1);
    assert.equal(o['git-side'].git.unmergedBranches, 1);
    assert.equal(o['git-clean'].git.stashes, 0);
    assert.equal(o['git-clean'].git.ignored, 0);
    assert.equal(o['git-clean'].git.unmergedBranches, 0);
  } finally { f.cleanup(); }
});

test('a fake .git folder does not borrow the primary repo state', () => {
  const f = makeFake();
  try {
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(o['fake-git'].hasGit, true);
    assert.equal(o['fake-git'].git, null);
    assert.equal(o['fake-git'].verdict, 'keep');
  } finally { f.cleanup(); }
});

test('the scan never descends into a junction, and a folder holding one is kept', () => {
  const f = makeFake();
  try {
    const s = scanFolder(path.join(f.wt, 'has-link'));
    assert.equal(s.files, 1, 'the canary behind the link is not counted');
    assert.equal(s.links, 1);
    const o = byName(buildReport({ root: f.primary, now: farFuture(), lanes: LANES }));
    assert.equal(o['has-link'].verdict, 'keep');
    assert.match(o['has-link'].reason, /link/);
    assert.ok(exists(path.join(f.store, 'canary.txt')));
  } finally { f.cleanup(); }
});

test('only candidates get a manual command, and it is text only', () => {
  const f = makeFake();
  try {
    const r = buildReport({ root: f.primary, now: farFuture(), lanes: LANES });
    const text = formatReport(r);
    const cands = r.orphans.filter((o) => o.verdict === 'candidate').map((o) => o.name).sort();
    assert.deepEqual(cands, ['empty-old', 'git-clean', 'tldr-only']);
    for (const name of cands) assert.ok(text.includes(removeCommand(path.join(f.wt, name))), name);
    assert.ok(!text.includes(removeCommand(path.join(f.wt, 'data-old'))));
    assert.match(text, /3 candidate/);
    assert.match(text, /never runs/i);
    assert.match(removeCommand("C:\\a'b"), /Remove-Item -LiteralPath 'C:\\a''b' -Recurse -Force/);
    // PowerShell also reads the curly quotes U+2018 to U+201B as quotes inside a single-quoted string.
    assert.equal(
      removeCommand('C:\\a\u2019b\u2018c\u201Ad\u201Be'),
      "Remove-Item -LiteralPath 'C:\\a\u2019\u2019b\u2018\u2018c\u201A\u201Ad\u201B\u201Be' -Recurse -Force",
    );
  } finally { f.cleanup(); }
});

test('no delete: the report changes nothing, in-process and through the CLI', () => {
  const f = makeFake();
  try {
    const before = snapshot(f.base);
    buildReport({ root: f.primary, now: farFuture(), lanes: LANES });
    assert.deepEqual(snapshot(f.base), before, 'in-process run');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', f.primary, '--no-lanes'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /orphan folder/);
    assert.match(r.stdout, /lane: unknown/);
    assert.deepEqual(snapshot(f.base), before, 'CLI run');
    assert.deepEqual(readdirSync(f.wt).sort(), [...readdirSync(f.wt)].sort());
    assert.ok(exists(path.join(f.wt, 'empty-old')));
  } finally { f.cleanup(); }
});

test('the CLI has no delete flag and exits 2 on one', () => {
  const f = makeFake();
  try {
    const before = snapshot(f.base);
    for (const flag of ['--delete', '--remove', '--force', '--apply', '--yes']) {
      const r = spawnSync(process.execPath, [SCRIPT, '--root', f.primary, flag], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, /usage/);
    }
    assert.deepEqual(snapshot(f.base), before);
  } finally { f.cleanup(); }
});

test('the source has no call that removes, moves or writes a file', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  for (const word of ['rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'writeFileSync', 'appendFileSync', 'truncateSync', 'copyFileSync', 'symlinkSync', 'mkdirSync', 'fs.rm', 'fs.unlink', 'fs.rmdir', 'promises', 'rimraf', 'Remove-Item -Path', '--delete']) {
    assert.ok(!src.includes(word), `orphans.mjs must not contain ${word}`);
  }
  assert.ok(!/\bexec\b|\bshell\s*:\s*true/.test(src), 'no shell');
});

test('--json prints the report as JSON; --lanes-file feeds the lane lookup', () => {
  const f = makeFake();
  try {
    const lanesFile = path.join(f.base, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify({ lanes: LANES }));
    const r = spawnSync(process.execPath, [SCRIPT, '--root', f.primary, '--lanes-file', lanesFile, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.orphans.find((o) => o.name === 'lane-empty').verdict, 'keep');
    assert.equal(j.orphans.find((o) => o.name === 'live'), undefined);
  } finally { f.cleanup(); }
});

test('helpers: parseLanes, laneMatch, humanAge, humanSize', () => {
  assert.equal(parseLanes('not json'), null);
  assert.equal(parseLanes('warning line\n{"lanes":[{"id":"a","state":"ready"}]}').length, 1);
  assert.equal(parseLanes('{"nope":1}'), null);
  assert.equal(laneMatch(null, 'a'), 'unknown');
  assert.equal(laneMatch([{ id: 'a', state: 'ready' }], 'b'), 'none');
  assert.match(laneMatch([{ id: 'a', state: 'ready' }], 'a'), /ready/);
  assert.equal(humanAge(30 * 60 * 1000), '30m');
  assert.equal(humanAge(5 * 3600 * 1000 + 60000), '5h');
  assert.equal(humanAge(3 * DAY + 4 * 3600 * 1000), '3d 4h');
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(6.7 * 1024 * 1024), '6.7 MB');
});
