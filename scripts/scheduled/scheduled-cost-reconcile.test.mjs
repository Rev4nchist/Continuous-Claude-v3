// End-to-end tests for .claude/scripts/scheduled/scheduled-cost-reconcile.ps1. Each test runs the real wrapper the way Task Scheduler
// runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against a fake repo. The fake repo holds fake copies of
// scripts/measurement/cost-reconcile.mjs and scripts/pricing/refresh-prices.mjs that record their argv, then exit with a chosen code or hang.
// No test touches the real ~/.claude, the real e2e folder, the primary checkout or the network: every run sets
// CCV3_COST_RECONCILE_REPO_ROOT and CCV3_COST_RECONCILE_LOG to temp paths.
//
// How the wrapper can fail, one test each below:
//   exit code    a reconcile warn (10) hides a price drift or a reconcile fail, or turns into 0; the code of a check is swallowed; a failing reconcile hides the price check or the other way round; the wrong one wins
//   price args   the price check runs without --check (it would EDIT prices.json and fetch for real)
//   reconcile    the reconcile gets no --since-hours 48, no --quiet, or an --out outside <repo>\.claude\cache\e2e; the extra args are lost
//   key strip    ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN reaches a check
//   timeout      a hung check is not killed, the wrapper waits past its limit, exits 0, or skips the other check
//   log          stdout and stderr of both checks do not reach the log; the finish lines lack the exit codes; the branch is missing
//   missing      a missing script gives a silent 0
//   prune        old nightly files and old logs stay for ever, young ones go, or a file with another name is touched
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, '..', '..', '.claude', 'scripts', 'scheduled', 'scheduled-cost-reconcile.ps1');
const onWindows = process.platform === 'win32';
const win = { skip: !onWindows };
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 }); });

const fake = (name) => `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.FAKE_CALL_DIR, '${name}.json'), JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, envKeys: Object.keys(process.env) }));
console.log('fake ${name} stdout line');
console.error('fake ${name} stderr line');
if (process.env.FAKE_HANG === '${name}') setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT_${name.toUpperCase()} ?? 0));
`;

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function fixture({ reconcile = true, price = true, branch = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-cost-wrapper-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'measurement'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'pricing'), { recursive: true });
  mkdirSync(join(root, 'calls'), { recursive: true });
  if (reconcile) writeFileSync(join(repo, 'scripts', 'measurement', 'cost-reconcile.mjs'), fake('reconcile'));
  if (price) writeFileSync(join(repo, 'scripts', 'pricing', 'refresh-prices.mjs'), fake('price'));
  if (branch) { git(repo, ['init', '-q', '-b', branch]); git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']); }
  return { root, repo, e2e: join(repo, '.claude', 'cache', 'e2e'), logDir: join(root, 'logs'), log: join(root, 'logs', '2026-11-08.log'), calls: join(root, 'calls') };
}

function run(fx, extraEnv = {}) {
  const env = { ...process.env, CCV3_COST_RECONCILE_REPO_ROOT: fx.repo, CCV3_COST_RECONCILE_LOG: fx.log, FAKE_CALL_DIR: fx.calls, ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const started = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '', err: r.stderr ?? '' };
}
const called = (fx, name) => JSON.parse(readFileSync(join(fx.calls, `${name}.json`), 'utf8'));

test('exit code: 0 when both pass; a failing reconcile still runs the price check; the reconcile code wins', win, () => {
  const ok = run(fixture());
  assert.equal(ok.status, 0, ok.log);
  const fx = fixture();
  const bad = run(fx, { FAKE_EXIT_RECONCILE: '1', FAKE_EXIT_PRICE: '1' });
  assert.equal(bad.status, 1, bad.log);
  assert.ok(existsSync(join(fx.calls, 'price.json')), 'the price check must run after a failing reconcile');
  const two = run(fixture(), { FAKE_EXIT_RECONCILE: '2', FAKE_EXIT_PRICE: '1' });
  assert.equal(two.status, 2, two.log);
  assert.match(two.log, /reconcile finished, exit 2\b/);
  assert.match(two.log, /price check finished, exit 1\b/);
});

test('exit code: a reconcile warn alone gives 10; a price drift or a reconcile fail wins over it', win, () => {
  const warn = run(fixture(), { FAKE_EXIT_RECONCILE: '10' });
  assert.equal(warn.status, 10, warn.log);
  const drift = run(fixture(), { FAKE_EXIT_RECONCILE: '10', FAKE_EXIT_PRICE: '1' });
  assert.equal(drift.status, 1, drift.log);
  const fail = run(fixture(), { FAKE_EXIT_RECONCILE: '1', FAKE_EXIT_PRICE: '0' });
  assert.equal(fail.status, 1, fail.log);
});

test('exit code: a price drift alone fails the wrapper', win, () => {
  const r = run(fixture(), { FAKE_EXIT_PRICE: '1' });
  assert.equal(r.status, 1, r.log);
});

test('price args: the price check runs with --check and nothing else', win, () => {
  const fx = fixture();
  run(fx);
  assert.deepEqual(called(fx, 'price').argv, ['--check']);
});

test('reconcile args: last 48 hours, quiet, --out inside the repo e2e folder; extra args are appended', win, () => {
  const fx = fixture();
  run(fx, { CCV3_COST_RECONCILE_EXTRA_ARGS: '--min-idle-min 0' });
  const argv = called(fx, 'reconcile').argv;
  assert.deepEqual(argv.slice(0, 3), ['--since-hours', '48', '--quiet']);
  const out = argv[argv.indexOf('--out') + 1];
  assert.match(out, /\d{4}-\d{2}-\d{2}-cost-reconcile-nightly\.jsonl$/);
  assert.equal(dirname(out).toLowerCase(), fx.e2e.toLowerCase());
  assert.deepEqual(argv.slice(-2), ['--min-idle-min', '0']);
});

test('key strip: no API key reaches either check', win, () => {
  const fx = fixture();
  run(fx, { ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' });
  for (const name of ['reconcile', 'price']) {
    const keys = called(fx, name).envKeys;
    assert.ok(!keys.includes('ANTHROPIC_API_KEY') && !keys.includes('ANTHROPIC_AUTH_TOKEN'), `${name} saw a key`);
  }
});

test('timeout: a hung reconcile is killed, the wrapper exits 124 and still runs the price check', win, () => {
  const fx = fixture();
  const r = run(fx, { FAKE_HANG: 'reconcile', CCV3_COST_RECONCILE_TIMEOUT_SEC: '3' });
  assert.equal(r.status, 124, r.log);
  assert.ok(r.ms < 60000, `took ${r.ms} ms`);
  assert.match(r.log, /TIMEOUT: reconcile killed/);
  assert.ok(existsSync(join(fx.calls, 'price.json')));
  const pid = called(fx, 'reconcile').pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the hung child must be gone');
});

test('log: stdout and stderr of both checks, both exit codes and the branch reach the log', win, () => {
  const fx = fixture({ branch: 'feat/test-branch' });
  const r = run(fx);
  for (const name of ['reconcile', 'price']) {
    assert.match(r.log, new RegExp(`fake ${name} stdout line`));
    assert.match(r.log, new RegExp(`fake ${name} stderr line`));
  }
  assert.match(r.log, /reconcile finished, exit 0\b/);
  assert.match(r.log, /price check finished, exit 0\b/);
  assert.match(r.log, /branch feat\/test-branch/);
  assert.match(r.log, /overall exit 0/);
});

test('missing: a missing reconcile script exits 3 with a message; the price check still runs', win, () => {
  const fx = fixture({ reconcile: false });
  const r = run(fx);
  assert.equal(r.status, 3, r.log);
  assert.match(r.log, /ERROR: reconcile script not found/);
  assert.ok(existsSync(join(fx.calls, 'price.json')));
});

test('prune: nightly files and logs older than 14 days go; younger and other files stay', win, () => {
  const fx = fixture();
  mkdirSync(fx.e2e, { recursive: true });
  mkdirSync(fx.logDir, { recursive: true });
  const old = new Date(Date.now() - 20 * 86_400_000);
  const young = new Date(Date.now() - 3 * 86_400_000);
  const make = (dir, name, when) => { const p = join(dir, name); writeFileSync(p, 'x'); utimesSync(p, when, when); return p; };
  const oldNight = make(fx.e2e, '2026-10-01-cost-reconcile-nightly.jsonl', old);
  const youngNight = make(fx.e2e, '2026-11-05-cost-reconcile-nightly.jsonl', young);
  const other = make(fx.e2e, '2026-10-01-price-check.json', old);
  const oldLog = make(fx.logDir, '2026-10-01.log', old);
  const youngLog = make(fx.logDir, '2026-11-05.log', young);
  const otherLog = make(fx.logDir, 'notes.txt', old);
  run(fx);
  assert.equal(existsSync(oldNight), false);
  assert.equal(existsSync(oldLog), false);
  for (const p of [youngNight, other, youngLog, otherLog]) assert.equal(existsSync(p), true, p);
});

// ---------------------------------------------------------------- slot guard (card sched-tasks-failing-1109)
// Same cause as the lane snapshot: a missed 23:50 run starts as a catch-up in a short Modern Standby wake and the standby ends it.
// The task gets a second trigger when the machine is awake. The wrapper runs only when the last 23:50 slot has no completed run:
// marker <state>/cost-reconcile.done.json {"doneAt": "<local time>", "slot": "23:50"}. A completed run is one whose overall exit is
// not 124 (a kill) and not 3 (a script missing): a failing check (1, 2, 10) is a finished answer, and the run need not repeat it.
// How it can fail, one test each below:
//   CS1 skip       a marker newer than the last slot does not stop the run
//   CS2 first run  no marker: the run is skipped, or it finishes with no marker written
//   CS3 stale      a marker older than the last slot is treated as done
//   CS4 complete   a failing check (exit 1 or 10) writes no marker, so a finished answer is repeated at every trigger
//   CS5 killed     a killed check (124) writes a marker, so a killed night is never retried
//   CS6 force      CCV3_SLOT_FORCE=1 does not run over a fresh marker
//   CS7 on slot    the normal 23:50 run is skipped because last night's marker looks fresh
//   CS8 test safe  with only a log override the marker goes next to the log, never to ~/.claude/state
function slotFxCost() {
  const fx = fixture();
  fx.state = join(fx.root, 'slot-state');
  fx.marker = join(fx.state, 'cost-reconcile.done.json');
  return fx;
}
const slotEnvCost = (fx, now = '2026-11-22T07:40:00', more = {}) => ({ CCV3_SLOT_STATE_DIR: fx.state, CCV3_SLOT_NOW: now, ...more });
const putMarkerCost = (fx, doneAt) => { mkdirSync(fx.state, { recursive: true }); writeFileSync(fx.marker, JSON.stringify({ doneAt })); };
const ranCost = (fx) => existsSync(join(fx.calls, 'reconcile.json'));

test('CS1 a marker newer than the last 23:50 slot skips the run: no check, exit 0, a skip line in the log', win, () => {
  const fx = slotFxCost();
  putMarkerCost(fx, '2026-11-21T23:51:30');
  const r = run(fx, slotEnvCost(fx));
  assert.equal(r.status, 0, r.log);
  assert.equal(ranCost(fx), false, 'the reconcile must not run');
  assert.match(r.log, /skip: slot 23:50 .*already done/);
});

test('CS2 no marker: the run goes and writes the marker with the time of the run and the slot', win, () => {
  const fx = slotFxCost();
  const r = run(fx, slotEnvCost(fx));
  assert.equal(r.status, 0, r.log);
  assert.ok(ranCost(fx), 'the reconcile must run');
  const m = JSON.parse(readFileSync(fx.marker, 'utf8'));
  assert.equal(m.doneAt, '2026-11-22T07:40:00');
  assert.equal(m.slot, '23:50');
});

test('CS3 a marker older than the last slot does not skip the run', win, () => {
  const fx = slotFxCost();
  putMarkerCost(fx, '2026-11-21T23:49:59');
  const r = run(fx, slotEnvCost(fx));
  assert.equal(r.status, 0, r.log);
  assert.ok(ranCost(fx), 'the reconcile must run');
});

test('CS4 a failing check (exit 1 or a warn 10) is a finished answer: the marker is written and the exit code stays', win, () => {
  for (const code of ['1', '10']) {
    const fx = slotFxCost();
    const r = run(fx, slotEnvCost(fx, '2026-11-22T07:40:00', { FAKE_EXIT_RECONCILE: code }));
    assert.equal(r.status, Number(code), r.log);
    assert.equal(JSON.parse(readFileSync(fx.marker, 'utf8')).doneAt, '2026-11-22T07:40:00', `exit ${code}`);
  }
});

test('CS5 a killed check (124) writes no marker', win, () => {
  const fx = slotFxCost();
  const r = run(fx, slotEnvCost(fx, '2026-11-22T07:40:00', { FAKE_HANG: 'reconcile', CCV3_COST_RECONCILE_TIMEOUT_SEC: '2' }));
  assert.equal(r.status, 124, r.log);
  assert.equal(existsSync(fx.marker), false, 'no marker after a kill');
});

test('CS6 CCV3_SLOT_FORCE=1 runs over a fresh marker', win, () => {
  const fx = slotFxCost();
  putMarkerCost(fx, '2026-11-21T23:51:30');
  const r = run(fx, slotEnvCost(fx, '2026-11-22T07:40:00', { CCV3_SLOT_FORCE: '1' }));
  assert.equal(r.status, 0, r.log);
  assert.ok(ranCost(fx), 'the reconcile must run');
});

test('CS7 the normal 23:50 run is not skipped by last night\'s marker', win, () => {
  const fx = slotFxCost();
  putMarkerCost(fx, '2026-11-21T23:51:30');
  const r = run(fx, slotEnvCost(fx, '2026-11-22T23:50:01'));
  assert.equal(r.status, 0, r.log);
  assert.ok(ranCost(fx), 'the reconcile must run');
  assert.equal(JSON.parse(readFileSync(fx.marker, 'utf8')).doneAt, '2026-11-22T23:50:01');
});

test('CS8 with only a log override the marker goes next to the log, not to the real state folder', win, () => {
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log);
  assert.ok(existsSync(join(fx.logDir, 'slot-state', 'cost-reconcile.done.json')), 'marker next to the log');
});
