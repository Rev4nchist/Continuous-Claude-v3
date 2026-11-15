// Tests that the sweep takes the file lists of the pinned sha, not of its checkout (card sweep-pinned-own-lists).
// Run: node --test scripts/github/local-review-sweep-own-lists.test.mjs
//
// After PR 567 the checkout lists name two files that the pin 01f63c79 lacks. With the checkout lists, proveCopy refuses the pinned copy
// and versionsAt gives a null engineVersion, so a counted run becomes rehearsal. Ways it can fail: proveCopy uses the checkout lists (SO1);
// the sweep's versions use the checkout lists (SO2); a list problem at the sha is not reported (SO3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as SWEEP from './local-review-sweep.mjs';
import * as EV from '../eval/review-eval/engine-version.mjs';

const MODULE = 'scripts/eval/review-eval/engine-version.mjs';
const CONFIG = 'review-router.config.json';
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CONFIG_TEXT = `${JSON.stringify({ matrix: { control_plane: ['a.mjs'], weights: { x: 1 } }, local_review: { prompt: 'p' } }, null, 2)}\n`;
const OWN_MODULE = "export const REVIEWER_SET_FILES = Object.freeze([\n  'own/a.mjs',\n]);\nexport const REVIEWER_SET_DIR = 'own/set/';\nexport const BAND_SET_FILES = Object.freeze(['own/router.mjs']);\n";

/** A temp repo whose one commit holds a list module naming only its own files; the copy folder holds the same files. */
function pinnedFixture({ moduleText = OWN_MODULE } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sweep-own-'));
  dirs.push(dir);
  const files = { [MODULE]: moduleText, 'own/a.mjs': 'a\n', 'own/router.mjs': 'r\n', 'own/set/x.mjs': 'x\n', [CONFIG]: CONFIG_TEXT };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) run('config', k, v);
  run('add', '-A');
  run('commit', '-q', '-m', 'pin');
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
  return { dir, sha: run('rev-parse', 'HEAD').trim(), git };
}

test('SO1: proveCopy by default proves a pinned copy against the lists of the pinned sha, not of the checkout', () => {
  const p = pinnedFixture();
  assert.equal(SWEEP.proveCopy({ dir: p.dir, sha: p.sha, git: p.git, root: p.dir }), null);
  writeFileSync(path.join(p.dir, 'own', 'router.mjs'), 'changed\n');
  assert.match(SWEEP.proveCopy({ dir: p.dir, sha: p.sha, git: p.git, root: p.dir }), /own\/router\.mjs differs from its blob/, 'a changed band file is still refused');
});

test('SO2: the sweep versions of a pinned sha come from its own lists and equal computeVersions with listsAt', () => {
  const p = pinnedFixture();
  assert.equal(typeof SWEEP.sweepVersions, 'function', 'the sweep exports the versions function its ctx uses by default');
  const v = SWEEP.sweepVersions({ sha: p.sha, root: p.dir, git: p.git });
  const want = EV.computeVersions({ sha: p.sha, git: p.git, lists: EV.listsAt({ sha: p.sha, git: p.git }) });
  assert.equal(v.engineVersion, want.engineVersion);
  assert.equal(v.bandVersion, want.bandVersion);
  assert.ok(v.engineVersion, 'a version, not null');
});

test('SO3: a list module at the sha that the sweep cannot read is named in the proveCopy problem', () => {
  const p = pinnedFixture({ moduleText: "export const REVIEWER_SET_FILES = Object.freeze([...BASE]);\nexport const REVIEWER_SET_DIR = 'own/set/';\nexport const BAND_SET_FILES = Object.freeze(['own/router.mjs']);\n" });
  assert.match(SWEEP.proveCopy({ dir: p.dir, sha: p.sha, git: p.git, root: p.dir }), /cannot list the blobs at [0-9a-f]{12}: REVIEWER_SET_FILES at [0-9a-f]{12} is not a plain literal array/);
});
