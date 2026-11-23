// Tests for v710-check.mjs (rule V7.10: a head that is the GO head plus one merge of fork/main keeps the GO).
// Run: node --test scripts/coordination/v710-check.test.mjs
// Every test builds a real git repo in a temp folder: the check reads git, so a stub would test nothing.
//
// How the check can fail, and the test that catches it (written before the code):
//   main touched a card file in another place, and the check still fails the merge (the 2026-11-23 case, pre-pr.mjs on 1c814df4) -> V1
//   the old command (git diff <GO> <new> -- files) is the check, so V1 is not a real case                                           -> V1 asserts the old command prints
//   the merge changed one line the branch owns (a resolved conflict, a hand edit) and the check keeps the GO                        -> V2
//   a head that is not a merge of two parents keeps the GO                                                                         -> V3
//   a commit between the GO head and the merge (a style fix) keeps the GO: the seat must read it                                  -> V4
//   the second parent is not an ancestor of fork/main (a side branch merged in) keeps the GO                                       -> V5
//   a file that is not a card file, and not a dist counterpart, in the merge keeps the GO                                          -> V6
//   the dist files of a hook source card file fail check 2                                                                         -> V7
//   a missing argument or an unknown commit exits 0 or 1 instead of 2                                                              -> V8
//   a mismatch prints no line sets, so the seat cannot see what differs                                                            -> V2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v710Check } from './v710-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'v710-check.mjs');
const TWENTY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const SRC = '.claude/hooks/src/h.ts';
const DIST = '.claude/hooks/dist/h.mjs';
const BUILD = '.claude/hooks/dist/.build-inputs.json';

/** A temp repo with main at M0 holding a.mjs (20 lines), b.mjs, the hook source and its two dist files. */
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v710-repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  const put = (rel, lines) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), `${lines.join('\n')}\n`); };
  const edit = (rel, n, text) => { const l = [...TWENTY]; l[n - 1] = text; put(rel, l); };
  git('init', '-q', '-b', 'main');
  put('a.mjs', TWENTY);
  put('b.mjs', TWENTY);
  put(SRC, ['export const h = 1;']);
  put(DIST, ['export const h = 1;', 'export const other = 0;']);
  put(BUILD, ['{}']);
  git('add', '-A');
  git('commit', '-q', '-m', 'M0');
  const m0 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'card');
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  /** main moves to a new commit; fork/main points at it; back on the card branch. */
  const moveMain = (fn) => { git('checkout', '-q', 'main'); fn(); git('add', '-A'); git('commit', '-q', '-m', 'M1'); const m1 = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/fork/main', m1); git('checkout', '-q', 'card'); return m1; };
  git('update-ref', 'refs/remotes/fork/main', m0);
  return { dir, git, put, edit, commit, moveMain, m0, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('V1: main changed a card file in another place: the old command prints, the new check keeps the GO', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.moveMain(() => { r.edit('a.mjs', 18, 'main change at line 18'); r.put('c.mjs', ['new on main']); });
    r.git('merge', '-q', '--no-edit', 'fork/main');
    const head = r.git('rev-parse', 'HEAD');
    assert.notEqual(r.git('diff', go, head, '--', 'a.mjs'), '', 'the old check 1 fails by its letter here');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 0, res.lines.join('\n'));
  } finally { r.done(); }
});

test('V2: the merge changed one line the branch owns: the check fails and prints both line sets', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-commit', '--no-edit', 'fork/main');
    r.edit('a.mjs', 2, 'own change at line 2, edited in the merge');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'merge with a hand edit');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1);
    const text = res.lines.join('\n');
    assert.match(text, /own change at line 2\b/);
    assert.match(text, /edited in the merge/);
  } finally { r.done(); }
});

test('V3: a head that is not a merge of two parents does not keep the GO', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.edit('a.mjs', 3, 'a later commit');
    const head = r.commit('not a merge');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1);
    assert.match(res.lines.join('\n'), /two parents|not a merge/i);
  } finally { r.done(); }
});

test('V4: a style commit between the GO head and the merge needs a seat read', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.edit('a.mjs', 3, 'a style fix');
    r.commit('style');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-edit', 'fork/main');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1);
    assert.match(res.lines.join('\n'), /first parent|GO head/i);
  } finally { r.done(); }
});

test('V5: a second parent that is not an ancestor of fork/main does not keep the GO', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.git('checkout', '-q', '-b', 'side', r.m0);
    r.edit('b.mjs', 7, 'a side commit that is not on fork/main');
    r.commit('side');
    r.git('checkout', '-q', 'card');
    r.git('merge', '-q', '--no-edit', 'side');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1);
    assert.match(res.lines.join('\n'), /fork\/main/);
  } finally { r.done(); }
});

test('V6: a file that is not a card file in the merge fails check 2 and is named', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    const go = r.commit('card change');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-commit', '--no-edit', 'fork/main');
    r.put('d.mjs', ['a file the card does not own']);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'merge plus d');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1);
    assert.match(res.lines.join('\n'), /d\.mjs/);
  } finally { r.done(); }
});

test('V7: the dist files of a hook source card file pass check 2', () => {
  const r = makeRepo();
  try {
    r.put(SRC, ['export const h = 2;']);
    r.put(DIST, ['export const h = 2;']);
    r.put(BUILD, ['{"h":2}']);
    const go = r.commit('hook change and build');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-edit', 'fork/main');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: [SRC] });
    assert.equal(res.exitCode, 0, res.lines.join('\n'));
  } finally { r.done(); }
});

// ---- the CLI findings of 26d38ccb (seat ruling 2026-11-23 09:42 CST): each test below fails on that head ----
test('V9 (finding :74): --files is required: without it the check exits 2, and a card file the merge undid fails check 1', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change in a');
    r.edit('b.mjs', 2, 'own change in b');
    const go = r.commit('card changes in a and b');
    r.moveMain(() => { r.edit('b.mjs', 9, 'main change in b'); });
    r.git('merge', '-q', '--no-commit', '--no-edit', 'fork/main');
    r.put('a.mjs', TWENTY);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'merge that undoes the change in a');
    const head = r.git('rev-parse', 'HEAD');
    const without = v710Check({ cwd: r.dir, go, head });
    assert.equal(without.exitCode, 2, without.lines.join('\n'));
    assert.match(without.lines.join('\n'), /--files/);
    const withFiles = v710Check({ cwd: r.dir, go, head, files: ['a.mjs', 'b.mjs'] });
    assert.equal(withFiles.exitCode, 1, 'the undone change in a.mjs is in scope and shows');
    const cli = spawnSync(process.execPath, [SCRIPT, '--go', go, '--new', head], { cwd: r.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  } finally { r.done(); }
});

test('V10 (finding :44): a file-mode change made in the merge fails check 1', () => {
  const r = makeRepo();
  try {
    r.edit('a.mjs', 2, 'own change at line 2');
    r.git('add', '-A');
    r.git('update-index', '--chmod=+x', 'a.mjs');
    r.git('commit', '-q', '-m', 'card change with the executable bit');
    const go = r.git('rev-parse', 'HEAD');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-commit', '--no-edit', 'fork/main');
    r.git('update-index', '--chmod=-x', 'a.mjs');
    r.git('commit', '-q', '-m', 'merge that drops the executable bit');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: ['a.mjs'] });
    assert.equal(res.exitCode, 1, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /mode/);
  } finally { r.done(); }
});

test('V11 (finding :102): a permitted dist rebuild that takes in main\'s other hook keeps the GO: check 1 reads the card paths only', () => {
  const r = makeRepo();
  try {
    r.put(SRC, ['export const h = 2;']);
    r.put(DIST, ['export const h = 2;', 'export const other = 0;']);
    const go = r.commit('hook change and build');
    r.moveMain(() => { r.edit('b.mjs', 5, 'main change in b'); });
    r.git('merge', '-q', '--no-commit', '--no-edit', 'fork/main');
    r.put(DIST, ['export const h = 2;', 'export const other = 1;']);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'merge plus a rebuild that includes main\'s other hook');
    const head = r.git('rev-parse', 'HEAD');
    const res = v710Check({ cwd: r.dir, go, head, files: [SRC] });
    assert.equal(res.exitCode, 0, res.lines.join('\n'));
  } finally { r.done(); }
});

test('V8: a missing argument and an unknown commit exit 2', () => {
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', windowsHide: true });
  assert.equal(none.status, 2, none.stderr);
  const r = makeRepo();
  try {
    const bad = spawnSync(process.execPath, [SCRIPT, '--go', 'f'.repeat(40), '--new', 'e'.repeat(40), '--files', 'a.mjs'], { cwd: r.dir, encoding: 'utf8', windowsHide: true });
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  } finally { r.done(); }
});
