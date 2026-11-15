// Tests for the file lists at a sha (card sweep-pinned-own-lists). Run: node --test scripts/eval/review-eval/engine-version-lists.test.mjs
//
// The lists come from the sha, never from the checkout, when the caller passes them: (i) the module at the sha gives its own constants;
// (ii) a sha that predates the module gets the frozen baseline, the lists as first written in 9f93fe56. Each source fails closed.
// Ways it can fail: the module's own lists are ignored and the checkout's are used (EL1); a constant that is not a plain literal array is
// read anyway or skipped (EL2); a missing constant falls back in silence (EL3); a sha with no module gets the checkout lists (EL4); a
// baseline file missing at the sha is skipped (EL5); the baseline drifts from 9f93fe56 (EL6); no option changes the value (EL7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as EV from './engine-version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const MODULE = 'scripts/eval/review-eval/engine-version.mjs';
const CONFIG = 'review-router.config.json';
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CONFIG_TEXT = `${JSON.stringify({ matrix: { control_plane: ['a.mjs'], weights: { x: 1 } }, local_review: { prompt: 'p', weekly_live_cap: 100 } }, null, 2)}\n`;
const moduleText = ({ reviewer = "'own/a.mjs',\n  'own/b.mjs',", band = "'own/router.mjs'", dir = "'own/set/'" } = {}) => [
  '// a list module at an old sha',
  reviewer === null ? '' : `export const REVIEWER_SET_FILES = Object.freeze([\n  ${reviewer}\n]);`,
  dir === null ? '' : `export const REVIEWER_SET_DIR = ${dir};`,
  band === null ? '' : `export const BAND_SET_FILES = Object.freeze([${band}]);`,
  '',
].join('\n');

/** A temp repo with one commit of `files`; returns { dir, sha, git }. */
function repoWith(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ev-lists-'));
  dirs.push(dir);
  const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) run('config', k, v);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'fixture');
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
  return { dir, sha: run('rev-parse', 'HEAD').trim(), git };
}
const ownFiles = { 'own/a.mjs': 'a\n', 'own/b.mjs': 'b\n', 'own/router.mjs': 'r\n', 'own/set/x.mjs': 'x\n', 'own/set/x.test.mjs': 't\n', [CONFIG]: CONFIG_TEXT };
const baselineFiles = () => Object.fromEntries([...EV.PRE_MODULE_BASELINE.reviewerSetFiles, ...EV.PRE_MODULE_BASELINE.bandSetFiles, CONFIG].map((p) => [p, p === CONFIG ? CONFIG_TEXT : `// ${p}\n`]));

test('EL1: a sha with the module gives its own lists, and computeVersions with them reads only those files', () => {
  const r = repoWith({ [MODULE]: moduleText(), ...ownFiles });
  const lists = EV.listsAt({ sha: r.sha, git: r.git });
  assert.deepEqual(lists, { reviewerSetFiles: ['own/a.mjs', 'own/b.mjs'], bandSetFiles: ['own/router.mjs'], reviewerSetDir: 'own/set/', source: 'sha' });
  const v = EV.computeVersions({ sha: r.sha, git: r.git, lists });
  assert.deepEqual(v.reviewerFiles.map((f) => f.path), ['own/a.mjs', 'own/b.mjs', 'own/set/x.mjs']);
  assert.deepEqual(v.bandFiles.map((f) => f.path), ['own/router.mjs']);
  assert.throws(() => EV.computeVersions({ sha: r.sha, git: r.git }), /missing at/, 'the checkout lists name files this sha lacks');
});

test('EL2: a constant present at the sha but not a plain literal array is an error that names it', () => {
  for (const edit of [{ reviewer: "...BASE, 'own/a.mjs'," }, { band: "'own/router.mjs', ...more" }, { reviewer: "'own/a.mjs', `own/${x}.mjs`," }]) {
    const r = repoWith({ [MODULE]: moduleText(edit), ...ownFiles });
    assert.throws(() => EV.listsAt({ sha: r.sha, git: r.git }), /(REVIEWER_SET_FILES|BAND_SET_FILES) at [0-9a-f]{12} is not a plain literal array/, JSON.stringify(edit));
  }
  const d = repoWith({ [MODULE]: moduleText({ dir: 'DIR_FROM_ELSEWHERE' }), ...ownFiles });
  assert.throws(() => EV.listsAt({ sha: d.sha, git: d.git }), /REVIEWER_SET_DIR at [0-9a-f]{12} is not a plain string literal/);
});

test('EL3: a constant absent from the module at the sha is an error, not a fall back', () => {
  for (const edit of [{ reviewer: null }, { band: null }, { dir: null }]) {
    const r = repoWith({ [MODULE]: moduleText(edit), ...ownFiles });
    assert.throws(() => EV.listsAt({ sha: r.sha, git: r.git }), /has no (REVIEWER_SET_FILES|BAND_SET_FILES|REVIEWER_SET_DIR)/, JSON.stringify(edit));
  }
});

test('EL4: a sha that predates the module gets the frozen baseline, not the checkout lists', () => {
  const r = repoWith(baselineFiles());
  const lists = EV.listsAt({ sha: r.sha, git: r.git });
  assert.equal(lists.source, 'baseline');
  assert.deepEqual(lists.reviewerSetFiles, [...EV.PRE_MODULE_BASELINE.reviewerSetFiles]);
  assert.deepEqual(lists.bandSetFiles, [...EV.PRE_MODULE_BASELINE.bandSetFiles]);
  assert.equal(lists.reviewerSetDir, EV.PRE_MODULE_BASELINE.reviewerSetDir);
  const v = EV.computeVersions({ sha: r.sha, git: r.git, lists });
  assert.deepEqual(v.bandFiles.map((f) => f.path), [...EV.PRE_MODULE_BASELINE.bandSetFiles]);
});

test('EL5: a baseline file missing at a pre-module sha is an error that names it, never a skip', () => {
  const files = baselineFiles();
  const gone = EV.PRE_MODULE_BASELINE.bandSetFiles[0];
  delete files[gone];
  const r = repoWith(files);
  assert.throws(() => EV.computeVersions({ sha: r.sha, git: r.git, lists: EV.listsAt({ sha: r.sha, git: r.git }) }), new RegExp(`missing at [0-9a-f]{40}: ${gone}`));
});

test('EL6: the frozen baseline equals the lists as first written in 9f93fe56', (t) => {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() === 'true';
  if (shallow) { t.skip('a shallow clone has no 9f93fe56: this tie runs in a full clone (pre-pr on this machine)'); return; }
  const git = (args) => { const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
  const first = EV.listsAt({ sha: EV.PRE_MODULE_BASELINE.firstSha, git });
  assert.equal(first.source, 'sha');
  assert.deepEqual(first.reviewerSetFiles, [...EV.PRE_MODULE_BASELINE.reviewerSetFiles]);
  assert.deepEqual(first.bandSetFiles, [...EV.PRE_MODULE_BASELINE.bandSetFiles]);
  assert.equal(first.reviewerSetDir, EV.PRE_MODULE_BASELINE.reviewerSetDir);
  const parent = git(['rev-parse', '--verify', '--quiet', `${EV.PRE_MODULE_BASELINE.firstSha}^:${MODULE}`]);
  assert.notEqual(parent.status, 0, '9f93fe56 is the commit that added the module');
});

test('EL7: with no lists option, computeVersions reads the checkout lists, as before', () => {
  const files = Object.fromEntries([...EV.REVIEWER_SET_FILES, ...EV.BAND_SET_FILES, CONFIG].map((p) => [p, p === CONFIG ? CONFIG_TEXT : `// ${p}\n`]));
  const r = repoWith({ [MODULE]: moduleText(), ...files });
  const plain = EV.computeVersions({ sha: r.sha, git: r.git });
  const checkout = { reviewerSetFiles: EV.REVIEWER_SET_FILES, bandSetFiles: EV.BAND_SET_FILES, reviewerSetDir: EV.REVIEWER_SET_DIR };
  assert.deepEqual(plain, EV.computeVersions({ sha: r.sha, git: r.git, lists: checkout }));
  assert.deepEqual(plain.bandFiles.map((f) => f.path), [...EV.BAND_SET_FILES].sort(), 'the module at the sha is not read without the option');
});
