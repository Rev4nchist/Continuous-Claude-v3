// End-to-end tests for .claude/scripts/scheduled/scheduled-reminder-tick.ps1. Each test runs the real wrapper the way
// Task Scheduler runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against a fake repo whose
// scripts/coordination/lane.mjs records its argv, pid and environment keys, then exits with a chosen code or hangs.
// No test touches the real ~/.claude, the primary checkout or a database: every run sets CCV3_REMINDER_REPO_ROOT and
// CCV3_REMINDER_LOG to temp paths.
//
// How the wrapper can fail, one test each below:
//   exit code    the tick exit code is swallowed (the wait returns 0)               [exit 0, 1, 2, 7 must pass through]
//   arguments    `remind tick` is not what runs, or the extra args are lost
//   key strip    ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN reaches the tick (it can start a billed headless run)
//   toast env    the tick is not told where reminder-toast.ps1 is
//   timeout      a hung tick is not killed, the wrapper waits past its limit, or exits 0
//   log          stdout and stderr of the tick do not reach the dated log; the finish line lacks the exit code
//   prune        dated logs older than 14 days stay for ever, or a younger one is deleted
//   missing      no lane.mjs: exit 3 with a log line, not a silent 0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, '..', '..', '.claude', 'scripts', 'scheduled', 'scheduled-reminder-tick.ps1');
const onWindows = process.platform === 'win32';

const FAKE_LANE = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_CALL_FILE, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, envKeys: Object.keys(process.env), toast: process.env.CCV3_REMINDER_TOAST_SCRIPT ?? null }));
console.log('fake tick stdout line');
console.error('fake tick stderr line');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function fixture({ withLane = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-tick-wrapper-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'coordination'), { recursive: true });
  if (withLane) writeFileSync(join(repo, 'scripts', 'coordination', 'lane.mjs'), FAKE_LANE);
  return { root, repo, logDir: join(root, 'logs'), log: join(root, 'logs', '2026-11-07.log'), call: join(root, 'call.json') };
}

function run(fx, extraEnv = {}) {
  const env = { ...process.env, CCV3_REMINDER_REPO_ROOT: fx.repo, CCV3_REMINDER_LOG: fx.log, FAKE_CALL_FILE: fx.call, ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const started = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '', out: r.stdout ?? '', err: r.stderr ?? '' };
}
const called = (fx) => JSON.parse(readFileSync(fx.call, 'utf8'));
const win = { skip: !onWindows };

test('the tick exit code passes through the wait: 0, 1, 2, 7', win, () => {
  for (const code of [0, 1, 2, 7]) {
    const fx = fixture();
    const r = run(fx, { FAKE_EXIT: String(code) });
    assert.equal(r.status, code, `tick exit ${code} must be the wrapper exit; log:\n${r.log}`);
    assert.match(r.log, new RegExp(`tick finished, exit ${code}\\b`));
  }
});

test('the tick gets "remind tick" and the extra args, and stdout plus stderr reach the dated log', win, () => {
  const fx = fixture();
  const r = run(fx, { CCV3_REMINDER_EXTRA_ARGS: '--dry-run --no-sync' });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(called(fx).argv, ['remind', 'tick', '--dry-run', '--no-sync']);
  assert.match(r.log, /fake tick stdout line/);
  assert.match(r.log, /fake tick stderr line/);
});

test('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN never reach the tick, and it learns the toast script path', win, () => {
  const fx = fixture();
  const r = run(fx, { ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' });
  assert.equal(r.status, 0, r.log);
  const c = called(fx);
  assert.ok(!c.envKeys.some((k) => /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)), c.envKeys.filter((k) => /ANTHROPIC/i.test(k)).join(','));
  assert.equal(c.toast, join(dirname(WRAPPER), 'reminder-toast.ps1'));
  assert.ok(existsSync(c.toast), 'reminder-toast.ps1 must sit next to the wrapper');
});

test('a hung tick is killed at the limit and the wrapper exits 124', win, () => {
  const fx = fixture();
  const r = run(fx, { FAKE_HANG: '1', CCV3_REMINDER_TIMEOUT_SEC: '3' });
  assert.equal(r.status, 124, r.log);
  assert.match(r.log, /TIMEOUT: tick killed/);
  assert.ok(r.ms < 60000, `wrapper waited ${r.ms} ms`);
  assert.throws(() => process.kill(called(fx).pid, 0), 'the hung tick process must be dead');
});

test('a missing lane.mjs exits 3 and says so in the log', win, () => {
  const fx = fixture({ withLane: false });
  const r = run(fx);
  assert.equal(r.status, 3, r.log);
  assert.match(r.log, /ERROR: lane\.mjs not found at .*lane\.mjs/);
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
