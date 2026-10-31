// End-to-end tests for .claude/scripts/scheduled/scheduled-health-check.bat. Each test runs the real
// wrapper through cmd.exe against a fake repo whose scripts/harness-doctor.mjs records its argv and
// then exits with a chosen code or hangs. No test touches the real ~/.claude or the primary checkout:
// every run sets CCV3_HEALTH_REPO_ROOT, CCV3_HEALTH_OUT and CCV3_HEALTH_LOG to temp paths.
//
// How the wrapper can fail, one test each below:
//   exit code: the doctor's exit code is swallowed (the relaunch or the PowerShell wait returns 0)
//   arguments: the doctor misses --json, --out, --repo, or the extra args (--home for a forced failure)
//   override: the machine profile wins over CCV3_HEALTH_REPO_ROOT, so the wrong doctor runs
//   profile: the machine-profile lookup fails (a cmd quoting bug did once), so REPO_ROOT stays the bootstrap guess
//   out path: the out folder is not created, or the "-" sentinel still passes --out
//   timeout: a hung doctor is not killed, or the wrapper waits past its limit, or exits 0
//   log: output does not reach the log file; the log lacks the finish line with the exit code
//   missing doctor: exit 3 and a log line, not a silent 0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'scripts', 'scheduled', 'scheduled-health-check.bat');
const REPO_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const slash = (p) => p.split('\\').join('/'); // machine-profile.mjs prints forward slashes
const onWindows =process.platform === 'win32';

const FAKE_DOCTOR = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));
const outAt = process.argv.indexOf('--out');
if (process.env.FAKE_REPORT && outAt > -1) writeFileSync(process.argv[outAt + 1], process.env.FAKE_REPORT);
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function fixture({ withDoctor = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-health-wrapper-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  if (withDoctor) writeFileSync(join(repo, 'scripts', 'harness-doctor.mjs'), FAKE_DOCTOR);
  return {
    repo,
    out: join(root, 'state', 'health', 'latest.json'),
    log: join(root, 'logs', 'run.log'),
    argvFile: join(root, 'argv.json'),
  };
}

function run(fx, extraEnv = {}, wrapper = WRAPPER) {
  const env = {
    ...process.env,
    CCV3_HEALTH_REPO_ROOT: fx.repo,
    CCV3_HEALTH_OUT: fx.out,
    CCV3_HEALTH_LOG: fx.log,
    FAKE_ARGV_FILE: fx.argvFile,
    ...extraEnv,
  };
  const started = Date.now();
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const r = spawnSync(`"${wrapper}"`, [], { shell: true, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '' };
}

const doctorCall = (fx) => JSON.parse(readFileSync(fx.argvFile, 'utf8'));

test('doctor exit code passes through the relaunch and the PowerShell wait', { skip: !onWindows }, () => {
  for (const code of [0, 1, 7]) {
    const fx = fixture();
    const r = run(fx, { FAKE_EXIT: String(code) });
    assert.equal(r.status, code, `doctor exit ${code} must be the wrapper exit; log:\n${r.log}`);
    assert.match(r.log, new RegExp(`health check finished, exit ${code}\\b`));
  }
});

test('the doctor gets --json, --out, --repo and the extra args, in that order', { skip: !onWindows }, () => {
  const fx = fixture();
  const home = join(dirname(fx.repo), 'empty home');
  const r = run(fx, { CCV3_HEALTH_EXTRA_ARGS: `--home "${home}"` });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(doctorCall(fx).argv, ['--json', '--out', fx.out, '--repo', fx.repo, '--home', home]);
});

test('CCV3_HEALTH_REPO_ROOT wins over the machine profile', { skip: !onWindows }, () => {
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.ok(existsSync(fx.argvFile), 'the doctor of the fake repo must have run');
  assert.ok(r.log.includes(`repo=${fx.repo} `), `log must name the override repo:\n${r.log}`);
});

test('the out folder is created, and "-" omits --out', { skip: !onWindows }, () => {
  const made = fixture();
  assert.equal(run(made).status, 0);
  assert.ok(existsSync(dirname(made.out)), 'wrapper must create the out folder');

  const none = fixture();
  assert.equal(run(none, { CCV3_HEALTH_OUT: '-' }).status, 0);
  assert.deepEqual(doctorCall(none).argv, ['--json', '--repo', none.repo]);
});

test('a hung doctor is killed at the limit and the wrapper exits 124', { skip: !onWindows }, () => {
  const fx = fixture();
  const r = run(fx, { FAKE_HANG: '1', CCV3_HEALTH_TIMEOUT_SEC: '3' });
  assert.equal(r.status, 124, r.log);
  assert.match(r.log, /TIMEOUT: doctor killed/);
  assert.ok(r.ms < 60000, `wrapper waited ${r.ms} ms`);
  const { pid } = doctorCall(fx);
  assert.throws(() => process.kill(pid, 0), 'the hung doctor process must be dead');
});

test('a missing doctor exits 3 and says so in the log', { skip: !onWindows }, () => {
  const fx = fixture({ withDoctor: false });
  const r = run(fx);
  assert.equal(r.status, 3, r.log);
  assert.match(r.log, /ERROR: doctor not found at .*harness-doctor\.mjs/);
});

const REPORT = (status) => JSON.stringify({
  ts: new Date().toISOString(),
  summary: { pass: 0, warn: 0, fail: status === 'FAIL' ? 1 : 0 },
  checks: [{ status, section: 'hooks', check: 'build-fresh', detail: 'x' }],
});

test('a FAIL report reaches the toast script, once, and never changes the exit code', { skip: !onWindows }, () => {
  // Failure modes: the wrapper never calls health-toast.ps1 (D6 not wired); the toast step swallows or
  // replaces the doctor exit code; a PASS report toasts; the same fail set toasts twice.
  const fx = fixture();
  const state = join(dirname(fx.repo), 'toast-state.txt');
  const env = { CCV3_HEALTH_TOAST_ARGS: `-DryRun -StateFile "${state}"`, FAKE_EXIT: '1', FAKE_REPORT: REPORT('FAIL') };
  const first = run(fx, env);
  assert.equal(first.status, 1, `doctor exit 1 must survive the toast step; log:\n${first.log}`);
  assert.match(first.log, /TOAST: CCv3 harness: 1 FAIL \| hooks:build-fresh/);
  assert.ok(existsSync(state) && readFileSync(state, 'utf8').trim().length > 0, 'the fail set hash must be stored');
  const second = run(fx, env);
  assert.equal(second.status, 1);
  assert.match(second.log.split('health check starting').pop(), /NO TOAST: this fail set was already shown/);
});

test('a PASS report shows no toast and the state file stays empty', { skip: !onWindows }, () => {
  const fx = fixture();
  const state = join(dirname(fx.repo), 'toast-state.txt');
  const r = run(fx, { CCV3_HEALTH_TOAST_ARGS: `-DryRun -StateFile "${state}"`, FAKE_REPORT: REPORT('PASS') });
  assert.equal(r.status, 0, r.log);
  assert.doesNotMatch(r.log, /TOAST: CCv3/);
  assert.ok(!existsSync(state) || readFileSync(state, 'utf8').trim() === '');
});

test('with OUT "-" there is no report, so the toast step is skipped', { skip: !onWindows }, () => {
  const fx = fixture();
  const state = join(dirname(fx.repo), 'toast-state.txt');
  const r = run(fx, { CCV3_HEALTH_OUT: '-', CCV3_HEALTH_TOAST_ARGS: `-DryRun -StateFile "${state}"` });
  assert.equal(r.status, 0, r.log);
  assert.doesNotMatch(r.log, /TOAST/);
});

test('without an override the machine profile names the repo that holds the doctor', { skip: !onWindows }, () => {
  // Fixture "bootstrap" repo A holds the wrapper copy, machine-profile.mjs and a profile that points at repo B.
  // Only B has a doctor. A broken profile lookup leaves REPO_ROOT at A, so the wrapper exits 3 instead.
  const fx = fixture();
  const boot = join(dirname(fx.repo), 'boot');
  mkdirSync(join(boot, '.claude', 'scripts', 'scheduled'), { recursive: true });
  mkdirSync(join(boot, 'scripts', 'settings'), { recursive: true });
  mkdirSync(join(boot, 'machine'), { recursive: true });
  const wrapper = join(boot, '.claude', 'scripts', 'scheduled', 'scheduled-health-check.bat');
  copyFileSync(WRAPPER, wrapper);
  copyFileSync(join(REPO_SRC, 'scripts', 'settings', 'machine-profile.mjs'), join(boot, 'scripts', 'settings', 'machine-profile.mjs'));
  writeFileSync(join(boot, 'machine', 'test.json'), JSON.stringify({ id: 'test', repoRoot: slash(fx.repo) }));
  const r = run(fx, { CCV3_HEALTH_REPO_ROOT: undefined, CCV3_MACHINE_PROFILE: 'test' }, wrapper);
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(doctorCall(fx).argv.slice(-2), ['--repo', slash(fx.repo)]);
});
