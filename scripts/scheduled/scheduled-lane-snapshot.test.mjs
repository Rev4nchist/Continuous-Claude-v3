// End-to-end tests for .claude/scripts/scheduled/scheduled-lane-snapshot.ps1. Each test runs the real wrapper the way
// Task Scheduler runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against a fake repo whose
// scripts/coordination/export-dash-data.mjs records its argv, pid and environment keys, then exits with a chosen code or hangs.
// No test touches the real ~/.claude, the real export out dir, the primary checkout or a database: every run sets
// CCV3_LANE_SNAPSHOT_REPO_ROOT and CCV3_LANE_SNAPSHOT_LOG to temp paths. The one test that checks the default log
// folder points USERPROFILE at a temp folder.
//
// How the wrapper can fail, one test each below:
//   exit code    the export exit code is swallowed (the wait returns 0)            [exit 0 and 1 must pass through]
//   arguments    the export gets arguments by default (it must run bare: its default out dir), or the extra args are lost
//   key strip    ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN reaches the export
//   timeout      a hung export is not killed, the wrapper waits past its limit, or exits 0
//   log          stdout and stderr of the export do not reach the dated log; the finish line lacks the exit code
//   default log  with no log override the log is not ~/.claude/logs/lane-snapshot/<yyyy-MM-dd>.log
//   prune        dated logs older than 14 days stay for ever, a younger one is deleted, or a non-log file is touched
//   branch       the repo branch is not in the log (a scheduled run reads whatever branch is checked out)
//   missing      no export script: a clear message and a nonzero exit, not a silent 0
//   repo root    the override is ignored and the wrapper runs the machine's real checkout
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, '..', '..', '.claude', 'scripts', 'scheduled', 'scheduled-lane-snapshot.ps1');
const onWindows = process.platform === 'win32';

const FAKE_EXPORT = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_CALL_FILE, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, envKeys: Object.keys(process.env), script: process.argv[1] }));
console.log('fake export stdout line');
console.error('fake export stderr line');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function fixture({ withExport = true, branch = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-snapshot-wrapper-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'coordination'), { recursive: true });
  if (withExport) writeFileSync(join(repo, 'scripts', 'coordination', 'export-dash-data.mjs'), FAKE_EXPORT);
  if (branch) { git(repo, ['init', '-q', '-b', branch]); git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']); }
  return { root, repo, logDir: join(root, 'logs'), log: join(root, 'logs', '2026-11-07.log'), call: join(root, 'call.json') };
}

function run(fx, extraEnv = {}) {
  const env = { ...process.env, CCV3_LANE_SNAPSHOT_REPO_ROOT: fx.repo, CCV3_LANE_SNAPSHOT_LOG: fx.log, FAKE_CALL_FILE: fx.call, ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const started = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '', out: r.stdout ?? '', err: r.stderr ?? '' };
}
const called = (fx) => JSON.parse(readFileSync(fx.call, 'utf8'));
const win = { skip: !onWindows };

test('the export exit code passes through the wait: 0 and 1', win, () => {
  for (const code of [0, 1]) {
    const fx = fixture();
    const r = run(fx, { FAKE_EXIT: String(code) });
    assert.equal(r.status, code, `export exit ${code} must be the wrapper exit; log:\n${r.log}`);
    assert.match(r.log, new RegExp(`export finished, exit ${code}\\b`));
  }
});

// Task Scheduler never sets CCV3_LANE_SNAPSHOT_REPO_ROOT, so the production path is the machine profile, then the home fallback.
// Breaks if profile-paths.ps1 stops returning repoRoot from the profile, or the wrapper stops using it.
test('with no repo-root override the wrapper uses the machine profile repoRoot', win, () => {
  const fx = fixture();
  const profileName = 'snapshot-test';
  mkdirSync(join(fx.root, 'machine'), { recursive: true });
  writeFileSync(join(fx.root, 'machine', `${profileName}.json`), JSON.stringify({ repoRoot: fx.repo }));
  const r = run(fx, { CCV3_LANE_SNAPSHOT_REPO_ROOT: undefined, CCV3_REPO_ROOT: fx.root, CCV3_MACHINE_PROFILE: profileName });
  assert.equal(r.status, 0, r.log + r.err);
  assert.equal(called(fx).script.replace(/\\/g, '/').toLowerCase(), join(fx.repo, 'scripts', 'coordination', 'export-dash-data.mjs').replace(/\\/g, '/').toLowerCase());
});

// Breaks if a profile whose checkout has no export script is run as it is, instead of falling back to ~/continuous-claude.
test('with no override and a profile repoRoot that has no export, the wrapper falls back to <USERPROFILE>\\continuous-claude', win, () => {
  const fx = fixture({ withExport: false });
  const home = join(fx.root, 'home');
  const homeRepo = join(home, 'continuous-claude');
  mkdirSync(join(homeRepo, 'scripts', 'coordination'), { recursive: true });
  writeFileSync(join(homeRepo, 'scripts', 'coordination', 'export-dash-data.mjs'), FAKE_EXPORT);
  const profileName = 'snapshot-test';
  mkdirSync(join(fx.root, 'machine'), { recursive: true });
  writeFileSync(join(fx.root, 'machine', `${profileName}.json`), JSON.stringify({ repoRoot: fx.repo }));
  const r = run(fx, { CCV3_LANE_SNAPSHOT_REPO_ROOT: undefined, CCV3_REPO_ROOT: fx.root, CCV3_MACHINE_PROFILE: profileName, USERPROFILE: home });
  assert.equal(r.status, 0, r.log + r.err);
  assert.equal(called(fx).script.replace(/\\/g, '/').toLowerCase(), join(homeRepo, 'scripts', 'coordination', 'export-dash-data.mjs').replace(/\\/g, '/').toLowerCase());
});

test('the export runs bare by default, and CCV3_LANE_SNAPSHOT_EXTRA_ARGS reaches it', win, () => {
  const fx = fixture();
  const r1 = run(fx);
  assert.equal(r1.status, 0, r1.log);
  assert.deepEqual(called(fx).argv, [], 'no --out by default: the export writes to its own default folder');
  assert.equal(called(fx).script, join(fx.repo, 'scripts', 'coordination', 'export-dash-data.mjs'));
  const fx2 = fixture();
  const r2 = run(fx2, { CCV3_LANE_SNAPSHOT_EXTRA_ARGS: `--out ${join(fx2.root, 'out')} --rules x.json` });
  assert.equal(r2.status, 0, r2.log);
  assert.deepEqual(called(fx2).argv, ['--out', join(fx2.root, 'out'), '--rules', 'x.json']);
});

test('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN never reach the export', win, () => {
  const fx = fixture();
  const r = run(fx, { ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' });
  assert.equal(r.status, 0, r.log);
  const keys = called(fx).envKeys;
  assert.ok(!keys.some((k) => /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)), keys.filter((k) => /ANTHROPIC/i.test(k)).join(','));
});

test('a hung export is killed at CCV3_LANE_SNAPSHOT_TIMEOUT_SEC and the wrapper exits 124', win, () => {
  const fx = fixture();
  const r = run(fx, { FAKE_HANG: '1', CCV3_LANE_SNAPSHOT_TIMEOUT_SEC: '3' });
  assert.equal(r.status, 124, r.log);
  assert.match(r.log, /TIMEOUT: export killed/);
  assert.ok(r.ms < 60000, `wrapper waited ${r.ms} ms`);
  assert.throws(() => process.kill(called(fx).pid, 0), 'the hung export process must be dead');
});

test('stdout and stderr of the export reach the dated log', win, () => {
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /fake export stdout line/);
  assert.match(r.log, /fake export stderr line/);
  assert.match(r.log, /export starting/);
});

test('with no log override the log is ~/.claude/logs/lane-snapshot/<yyyy-MM-dd>.log under USERPROFILE', win, () => {
  const fx = fixture();
  const fakeHome = join(fx.root, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = run(fx, { CCV3_LANE_SNAPSHOT_LOG: undefined, USERPROFILE: fakeHome });
  assert.equal(r.status, 0, r.out + r.err);
  const expected = join(fakeHome, '.claude', 'logs', 'lane-snapshot', `${day}.log`);
  assert.ok(existsSync(expected), `expected ${expected}`);
  assert.match(readFileSync(expected, 'utf8'), /export finished, exit 0/);
});

test('dated logs older than 14 days are pruned and younger ones stay', win, () => {
  const fx = fixture();
  mkdirSync(fx.logDir, { recursive: true });
  const oldLog = join(fx.logDir, '2026-10-01.log');
  const newLog = join(fx.logDir, '2026-11-01.log');
  const other = join(fx.logDir, 'notes.txt');
  for (const f of [oldLog, newLog, other]) writeFileSync(f, 'x');
  const ago = (days) => new Date(Date.now() - days * 86_400_000);
  utimesSync(oldLog, ago(15), ago(15)); utimesSync(newLog, ago(2), ago(2)); utimesSync(other, ago(40), ago(40));
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.ok(!existsSync(oldLog), 'the 15-day-old dated log must go');
  assert.ok(existsSync(newLog), 'the 2-day-old dated log must stay');
  assert.ok(existsSync(other), 'a file that is not a dated log is never touched');
});

test('the repo branch is in the log, and "unknown" when the repo is not a git repo', win, () => {
  const fx = fixture({ branch: 'feat/snapshot-test-branch' });
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /export starting, repo .*, branch feat\/snapshot-test-branch\b/);
  const fx2 = fixture();
  const r2 = run(fx2);
  assert.equal(r2.status, 0, r2.log);
  assert.match(r2.log, /branch unknown/);
});

test('a missing export script exits 3 with a clear message in the log', win, () => {
  const fx = fixture({ withExport: false });
  const r = run(fx);
  assert.equal(r.status, 3, r.log);
  assert.match(r.log, /ERROR: export-dash-data\.mjs not found at .*export-dash-data\.mjs/);
  assert.ok(!existsSync(fx.call), 'nothing may run');
});

test('CCV3_LANE_SNAPSHOT_REPO_ROOT picks the repo: the export that runs is the one under that root', win, () => {
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.ok(called(fx).script.startsWith(fx.repo), called(fx).script);
  assert.ok(r.log.includes(`repo ${fx.repo}`), r.log);
});
