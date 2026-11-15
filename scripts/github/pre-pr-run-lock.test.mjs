// Card coord-run-lock-and-go-row: pre-pr takes the run lock as its first step and frees it at exit.
// The runs below use a temp store (RUN_LOCK_DIR) and a temp git repo as the working folder, so no gate ever runs:
// a run that is not stopped by the lock ends at its first failing check in an empty repo, in under a second.
//
// How the call can fail, one test each, with the source change that makes it fail:
//   no call            pre-pr never asks the lock, so a refused start runs its gates anyway     (remove takeRunLock)
//   late call          the lock is asked after the first gate, so a refused start still loads the machine (call it later)
//   help takes a lock  --help or a missing body file leaves a lock behind                      (call it before the argument checks)
//   refused leaves one a refused start leaves a lock file, or a granted one is not freed at exit (skip the release)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRE_PR = resolve(HERE, 'pre-pr.mjs');

function sandbox() {
  const store = mkdtempSync(join(tmpdir(), 'prepr-lock-store-'));
  const repo = mkdtempSync(join(tmpdir(), 'prepr-lock-repo-'));
  const git = spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
  assert.equal(git.status, 0, 'git init');
  const body = join(repo, 'body.md');
  writeFileSync(body, 'Proof type: docs\n');
  return { store, repo, body };
}
// RUN_LOCK_TEST_SAMPLES gives the lock its three samples at once: no 6 second wait per run, and no dependence on the real
// memory and load of the machine. The lock prints a NOTE line when the hook is used.
const SAMPLES = JSON.stringify({ free: [8, 8, 8], load: [10, 10, 10] });
const run = (sb, args, env = {}) => spawnSync(process.execPath, [PRE_PR, ...args], {
  cwd: sb.repo, encoding: 'utf8', timeout: 120_000, env: { ...process.env, RUN_LOCK_DIR: sb.store, RUN_LOCK_TEST_SAMPLES: SAMPLES, ...env },
});
const locks = (store) => readdirSync(store).filter((f) => f.endsWith('.lock') && f !== 'gate.lock');

test('grant mode: a refused start stops before any gate, says why, and leaves no lock', () => {
  const sb = sandbox();
  writeFileSync(join(sb.store, 'MODE'), 'grant');
  writeFileSync(join(sb.store, 'last-grant.json'), JSON.stringify({ at: Date.now(), kind: 'pre-pr', pid: 1 })); // a grant a moment ago: the 2 minute spacing refuses
  const r = run(sb, ['--body', sb.body]);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 3, out);
  assert.match(out, /run-lock: WAIT .*last grant at/); // other reasons (load, slots) may come first on a busy machine
  assert.match(out, /try again after \d\d:\d\d \S+/); // the zone name comes from the system: CST, CDT, UTC or GMT+1
  assert.match(out, /NOTE samples come from RUN_LOCK_TEST_SAMPLES/, 'the hook is visible in the output');
  assert.match(out, /stopped before any gate/);
  assert.doesNotMatch(out, /git:branch|git:clean|RESULT/, 'no check ran');
  assert.equal(locks(sb.store).length, 0);
});

test('warn mode: the same refusal is only logged, the run goes on, and its lock is freed at exit', () => {
  const sb = sandbox();
  writeFileSync(join(sb.store, 'last-grant.json'), JSON.stringify({ at: Date.now(), kind: 'pre-pr', pid: 1 }));
  const r = run(sb, ['--body', sb.body]);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /run-lock: WOULD WAIT .*last grant at/);
  assert.match(out, /run-lock: GRANTED pre-pr/);
  // The run went past the lock. In an empty temp repo it ends in an error or at its first failing check: either proves it started.
  assert.match(out, /pre-pr: stopped by an error|git:branch|git:clean|RESULT/, 'the run started');
  assert.doesNotMatch(out, /stopped before any gate/);
  assert.equal(locks(sb.store).length, 0, 'the lock is freed when pre-pr exits');
  assert.match(readdirSync(sb.store).join(' '), /warn-log\.jsonl/);
});

test('a broken store (RUN_LOCK_DIR is a file) fails open: the run says so and goes on', () => {
  // Fails if takeRunLock stops catching an acquire error, or if a lock error becomes exit 3 (remove the catch).
  const sb = sandbox();
  const notAFolder = join(sb.repo, 'store-is-a-file');
  writeFileSync(notAFolder, 'not a folder');
  const r = run(sb, ['--body', sb.body], { RUN_LOCK_DIR: notAFolder });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /pre-pr: the run lock is not available .*the run goes on/);
  assert.doesNotMatch(out, /stopped before any gate/);
  // Not asserted: the exit code. pre-pr also exits 3 for its own "stopped by an error" in this empty temp repo.
  assert.match(out, /pre-pr: stopped by an error|git:branch|git:clean|RESULT/, 'the run started');
});

test('--help and a missing body file take no lock', () => {
  const sb = sandbox();
  assert.equal(run(sb, ['--help']).status, 0);
  assert.equal(run(sb, []).status, 2);
  assert.deepEqual(readdirSync(sb.store), []);
});
