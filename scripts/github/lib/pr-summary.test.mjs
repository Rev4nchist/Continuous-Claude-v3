// Tests for lib/pr-summary.mjs. Run: node --test scripts/github/lib/pr-summary.test.mjs
// Real git in a temp repo; the summary file is a real file under .claude/cache/pre-pr/.
//
// How the check can fail, and the test that catches it (written before the code):
//   - a missing file passes                                                   -> PS1
//   - a missing, empty or repeated label passes                               -> PS2
//   - a summary for another branch passes                                     -> PS3
//   - a Head that is not an ancestor passes; a Head that looks like a flag is passed to git -> PS4, PS4b
//   - a summary that is more than 5 files behind passes                       -> PS5
//   - an older Head with 5 or fewer files since fails instead of a NOTE       -> PS6
//   - a Risk that is not Low, Medium or High passes                           -> PS7
//   - a long sentence, field or file fails instead of a NOTE                  -> PS8
//   - a path that is not in the diff passes unmarked, or a known path is flagged -> PS9
//   - CRLF changes the hash                                                   -> PS10
//   - the facts line differs from git numstat                                 -> PS11
//   - note mode (the default) fails a run, or fail mode does not             -> PS12
//   - an internal error throws                                                -> PS13
//   - a valid summary does not pass, or returns no hash                       -> PS14
//   - the dialog cannot read the Change sentence                              -> PS15
//   - files that a merge of the base brought in count as "changed since Head"  -> PS5b
//   - an older Head with 0 branch files since (only a base merge) gives a NOTE every run -> PS5b
//   - a bulleted or bold label line reads as a missing label                   -> PS16
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changeOf, checkSummary, hashOf, SUMMARY_REL } from './pr-summary.mjs';

const run = (cwd, args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
const sh = (cwd, ...args) => { const r = run(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const gitOf = (cwd) => (args) => run(cwd, args);

/** A repo with main (one commit) and feat/x (one commit that adds `files`). */
function makeRepo(files = { 'docs/a.md': 'one\ntwo\n' }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prsummary-'));
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'root\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'feat/x');
  commitFiles(dir, files);
  return dir;
}

function commitFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'work');
  return sh(dir, 'rev-parse', 'HEAD');
}

const headOf = (dir) => sh(dir, 'rev-parse', 'HEAD');

const FIELDS = (head, over = {}) => ({
  Branch: 'feat/x', Head: head, Base: 'main',
  Problem: 'Dave cannot see what a pull request does before it opens.',
  Change: 'Pre-pr now reads a short plain summary and prints it first.',
  'You will see': 'A new summary line at the top of the pre-pr output.',
  Risk: 'Low. The check only adds a note this week.',
  'Not included': 'The fail mode and the model-written summary.',
  ...over,
});

const textOf = (fields, eol = '\n') => `${Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(eol)}${eol}`;

function put(dir, text) {
  const file = path.join(dir, SUMMARY_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function check(dir, text, extra = {}) {
  if (text !== null) put(dir, text);
  return checkSummary({ root: dir, head: headOf(dir), branch: 'feat/x', base: 'main', git: gitOf(dir), mode: 'fail', ...extra });
}

const all = (r) => [r.result.detail, ...(r.result.notes ?? [])].join('\n');

test('PS1: a missing summary file is a FAIL in fail mode and names the path', () => {
  const dir = makeRepo();
  const r = check(dir, null);
  assert.equal(r.result.step, 'summary');
  assert.equal(r.result.status, 'FAIL');
  assert.match(all(r), /summary\.md/);
  assert.match(all(r), /paste it to Dave in chat, then run pre-pr again/, 'the refusal tells the model what to do next');
  assert.equal(r.sha, null);
});

test('PS17: the shipped config turns the summary gate on (Dave, 2026-11-07, after the headless rule check)', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../../review-router.config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.pre_pr?.summary_mode, 'fail');
});

test('PS2: a missing, an empty and a repeated label each FAIL, and the line names the label', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const missing = check(dir, textOf(FIELDS(head, { Risk: undefined })));
  assert.equal(missing.result.status, 'FAIL');
  assert.match(all(missing), /Risk/);
  const empty = check(dir, textOf(FIELDS(head, { 'Not included': '   ' })));
  assert.equal(empty.result.status, 'FAIL');
  assert.match(all(empty), /Not included/);
  const repeated = check(dir, `${textOf(FIELDS(head))}Change: a second one.\n`);
  assert.equal(repeated.result.status, 'FAIL');
  assert.match(all(repeated), /Change.*(twice|more than once|repeated)/i);
});

test('PS3: a Branch that is not the branch of the run FAILs', () => {
  const dir = makeRepo();
  const r = check(dir, textOf(FIELDS(headOf(dir), { Branch: 'feat/other' })));
  assert.equal(r.result.status, 'FAIL');
  assert.match(all(r), /Branch.*feat\/other.*feat\/x/);
});

test('PS4: a Head that is not an ancestor of HEAD FAILs', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  sh(dir, 'checkout', '-q', '-b', 'side', 'main');
  const other = commitFiles(dir, { 'docs/side.md': 'side\n' });
  sh(dir, 'checkout', '-q', 'feat/x');
  const r = check(dir, textOf(FIELDS(other)));
  assert.equal(r.result.status, 'FAIL');
  assert.match(all(r), /Head.*not an ancestor/);
  assert.equal(headOf(dir), head);
});

test('PS4b: a Head that starts with a dash or is not hex FAILs without reaching git', () => {
  const dir = makeRepo();
  const calls = [];
  const git = (args) => { calls.push(args); return gitOf(dir)(args); };
  for (const bad of ['--all', 'HEAD~1', 'zzzz']) {
    const r = check(dir, textOf(FIELDS(bad)), { git });
    assert.equal(r.result.status, 'FAIL', bad);
    assert.match(all(r), /Head/, bad);
  }
  assert.ok(!calls.some((a) => a.includes('--all') || a.includes('HEAD~1') || a.includes('zzzz')), JSON.stringify(calls));
});

test('PS5: 6 files changed since Head FAIL; the line says how many', () => {
  const dir = makeRepo();
  const old = headOf(dir);
  commitFiles(dir, Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`docs/n${n}.md`, `${n}\n`])));
  const r = check(dir, textOf(FIELDS(old)));
  assert.equal(r.result.status, 'FAIL');
  assert.match(all(r), /6 files/);
});

test('PS6: an older ancestor Head with 5 files since is a NOTE, never a FAIL, even in fail mode', () => {
  const dir = makeRepo();
  const old = headOf(dir);
  commitFiles(dir, Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`docs/n${n}.md`, `${n}\n`])));
  const r = check(dir, textOf(FIELDS(old)));
  assert.equal(r.result.status, 'NOTE');
  assert.match(all(r), /older|5 files/);
});

test('PS7: a Risk that is not Low, Medium or High FAILs; each of the three passes', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const bad = check(dir, textOf(FIELDS(head, { Risk: 'Tiny. Nothing breaks.' })));
  assert.equal(bad.result.status, 'FAIL');
  assert.match(all(bad), /Risk/);
  for (const ok of ['Low', 'Medium. A hook changes.', 'High: it edits the gate.']) {
    assert.equal(check(dir, textOf(FIELDS(head, { Risk: ok }))).result.status, 'PASS', ok);
  }
});

test('PS8: a 21-word sentence, an 81-word field and a 121-word file are NOTEs, not FAILs, in fail mode', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const long = check(dir, textOf(FIELDS(head, { Problem: `${words(21)}.` })));
  assert.equal(long.result.status, 'NOTE');
  assert.match(all(long), /21 words/);
  const exact = check(dir, textOf(FIELDS(head, { Problem: `${words(20)}.` })));
  assert.equal(exact.result.status, 'PASS', 'a 20-word sentence is allowed');
  const field = check(dir, textOf(FIELDS(head, { Problem: Array.from({ length: 6 }, () => `${words(14)}.`).join(' ') })));
  assert.equal(field.result.status, 'NOTE');
  assert.match(all(field), /Problem.*80/);
  const two = () => `${words(19)}. ${words(19)}.`;
  const file = check(dir, textOf(FIELDS(head, { Problem: two(), Change: two(), 'You will see': two(), 'Not included': two(), Risk: `Low ${words(18)}. ${words(19)}.` })));
  assert.equal(file.result.status, 'NOTE');
  assert.match(all(file), /file.*120/i);
});

test('PS9: a backticked path that is not in the diff is a NOTE; a path in the diff, by full path or file name, is not', () => {
  const dir = makeRepo({ 'scripts/github/lib/pr-summary.mjs': 'export {};\n' });
  const head = headOf(dir);
  const ok = check(dir, textOf(FIELDS(head, { Change: 'Adds `scripts/github/lib/pr-summary.mjs` and `pr-summary.mjs` checks, run with `node --test`.' })));
  assert.equal(ok.result.status, 'PASS', all(ok));
  const unknown = check(dir, textOf(FIELDS(head, { Change: 'Edits `scripts/github/ghost.mjs` too.' })));
  assert.equal(unknown.result.status, 'NOTE');
  assert.match(all(unknown), /scripts\/github\/ghost\.mjs/);
});

test('PS10: the hash is the same for CRLF and LF text, and differs when a word changes', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const lf = check(dir, textOf(FIELDS(head), '\n'));
  const crlf = check(dir, textOf(FIELDS(head), '\r\n'));
  assert.equal(lf.sha, crlf.sha);
  assert.match(lf.sha, /^[0-9a-f]{64}$/);
  assert.equal(lf.sha, createHash('sha256').update(textOf(FIELDS(head), '\n')).digest('hex'));
  assert.equal(hashOf('a\r\nb\r\n'), hashOf('a\nb\n'));
  assert.notEqual(check(dir, textOf(FIELDS(head, { Risk: 'High' }))).sha, lf.sha);
});

test('PS11: the facts line equals the git numstat of base...HEAD (files, added, deleted)', () => {
  const dir = makeRepo({ 'docs/a.md': 'one\ntwo\nthree\n', 'src/b.txt': 'x\n' });
  commitFiles(dir, { 'docs/a.md': 'one\n', 'src/c.txt': 'y\nz\n' });
  const rows = sh(dir, 'diff', '--numstat', 'main...HEAD').split('\n').map((l) => l.split('\t'));
  const added = rows.reduce((n, r) => n + Number(r[0]), 0);
  const deleted = rows.reduce((n, r) => n + Number(r[1]), 0);
  const r = check(dir, textOf(FIELDS(headOf(dir))));
  const expected = `${rows.length} files, +${added} -${deleted}`;
  assert.equal(r.facts, expected);
  assert.match(all(r), new RegExp(expected.replace(/[+]/g, '\\+')));
  assert.equal(r.result.status, 'PASS', all(r));
});

test('PS12: with no mode the default is note: a FAIL-class problem is a NOTE and the run is not blocked; fail mode blocks', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const bad = textOf(FIELDS(head, { Branch: 'feat/other' }));
  put(dir, bad);
  const base = { root: dir, head, branch: 'feat/x', base: 'main', git: gitOf(dir) };
  assert.equal(checkSummary(base).result.status, 'NOTE');
  assert.equal(checkSummary({ ...base, mode: 'note' }).result.status, 'NOTE');
  assert.equal(checkSummary({ ...base, mode: 'fail' }).result.status, 'FAIL');
  assert.match(all(checkSummary(base)), /Branch/, 'the NOTE still names the problem');
});

test('PS13: an internal error (git throws, readFile throws something odd) is a NOTE and never throws', () => {
  const dir = makeRepo();
  put(dir, textOf(FIELDS(headOf(dir))));
  const boom = () => { throw new Error('git exploded'); };
  const r = checkSummary({ root: dir, head: headOf(dir), branch: 'feat/x', base: 'main', git: boom, mode: 'fail' });
  assert.equal(r.result.step, 'summary');
  assert.equal(r.result.status, 'NOTE');
  assert.match(all(r), /internal error.*git exploded/);
  const r2 = checkSummary({ root: dir, head: headOf(dir), branch: 'feat/x', base: 'main', git: gitOf(dir), readFile: () => { throw 'plain string'; }, mode: 'fail' });
  assert.ok(['NOTE', 'FAIL'].includes(r2.result.status));
  assert.doesNotThrow(() => checkSummary({}));
});

test('PS18: ok is true when the summary has no FAIL-class problem (PASS, an older Head, a long sentence) and false when it has one, even in note mode', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  assert.equal(check(dir, textOf(FIELDS(head))).ok, true, 'a clean summary');
  assert.equal(check(dir, textOf(FIELDS(head, { Problem: 'word '.repeat(25).trim() + '.' }))).ok, true, 'a long sentence is only a NOTE');
  commitFiles(dir, { 'docs/n1.md': '1\n' });
  const older = check(dir, textOf(FIELDS(head)));
  assert.equal(older.result.status, 'NOTE', 'an older Head with 1 own file is a NOTE');
  assert.equal(older.ok, true, 'an older Head still names a real summary of this branch');
  assert.equal(check(dir, textOf(FIELDS(head, { Branch: 'feat/other' })), { mode: 'note' }).ok, false, 'a leftover file from another branch, shown as a NOTE in note mode');
  assert.equal(check(dir, null, { mode: 'note' }).ok, false, 'no file');
});

test('PS14: a valid summary passes in fail mode, returns the hash of the file, and the line shows the facts', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const text = textOf(FIELDS(head));
  const r = check(dir, text);
  assert.equal(r.result.status, 'PASS', all(r));
  assert.equal(r.sha, createHash('sha256').update(text).digest('hex'));
  assert.match(r.result.detail, /1 file, \+2 -0/);
});

test('PS15: changeOf returns the Change sentence, or null', () => {
  assert.equal(changeOf(textOf(FIELDS('abc1234'))), 'Pre-pr now reads a short plain summary and prints it first.');
  assert.equal(changeOf('Problem: x\n'), null);
  assert.equal(changeOf(null), null);
  assert.equal(changeOf('Change:   \n'), null);
});

test('PS5b: files that a merge of the base brought in do not count as changed since Head', () => {
  const dir = makeRepo();
  const old = headOf(dir);
  sh(dir, 'checkout', '-q', 'main');
  commitFiles(dir, Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`base/m${n}.md`, `${n}\n`])));
  sh(dir, 'checkout', '-q', 'feat/x');
  sh(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const r = check(dir, textOf(FIELDS(old)));
  assert.equal(r.result.status, 'PASS', 'a base merge alone gives no NOTE: ' + all(r));
  assert.doesNotMatch(all(r), /stale|6 files changed since|older/);
  commitFiles(dir, Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`docs/own${n}.md`, `${n}\n`])));
  const own = check(dir, textOf(FIELDS(old)));
  assert.equal(own.result.status, 'FAIL', 'the branch own files still count');
  assert.match(all(own), /\d+ files changed since/);
});

test('PS16: a label line written as a markdown bullet or in bold still reads as that label', () => {
  const dir = makeRepo();
  const head = headOf(dir);
  const plain = textOf(FIELDS(head));
  const bullets = plain.split('\n').filter(Boolean).map((l) => `- ${l}`).join('\n');
  const bold = plain.split('\n').filter(Boolean).map((l) => l.replace(/^([^:]+):/, '**$1:**')).join('\n');
  for (const [name, text] of [['bullets', bullets], ['bold', bold]]) {
    const r = check(dir, text);
    assert.equal(r.result.status, 'PASS', `${name}: ${all(r)}`);
    assert.equal(changeOf(text), 'Pre-pr now reads a short plain summary and prints it first.', name);
  }
});
