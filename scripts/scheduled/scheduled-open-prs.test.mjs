// End-to-end tests for .claude/scripts/scheduled/scheduled-open-prs.ps1 (card prflow-open-prs, design note section 4 and tests W1 to W8).
// Each test runs the real wrapper the way Task Scheduler runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against
// a fake repo whose scripts/github/open-prs.mjs records its argv, pid, environment keys and temp-file view, then exits with a chosen code
// or hangs. RED step: the wrapper does not exist yet, so each test fails on "wrapper not written". No test touches the real ~/.claude,
// the real lane-dash folder, GitHub or a database. Every run sets CCV3_OPEN_PRS_REPO_ROOT and CCV3_OPEN_PRS_LOG to temp paths and points
// TEMP and TMP at a temp folder. The test that checks the default log folder points USERPROFILE at a temp folder. No test registers a task.
//
// The wrapper contract these tests pin (the writer builds to it):
//   env: CCV3_OPEN_PRS_REPO_ROOT, CCV3_OPEN_PRS_LOG (the dated log file), CCV3_OPEN_PRS_TIMEOUT_SEC (default 540), CCV3_OPEN_PRS_EXTRA_ARGS.
//   runs `node <repo>\scripts\github\open-prs.mjs` bare, passes its exit code through, exit 3 when the script is missing, 124 on a timeout.
//   mutex Local\CCv3-Open-PRs taken first: a second copy logs "already running, exiting" and exits 0.
//   child output is redirected into <logDir>\open-prs.<pid>.out.tmp and .err.tmp (never into %TEMP%), copied into the log, then deleted.
//   on a timeout it dot-sources <repo>\scripts\lib\Stop-ProcessTree.ps1 and kills the tree; with no helper it kills the one pid.
//
// How the wrapper can fail, one test each below (the source change that breaks each test is named in its comment):
//   W1 exit code lost       W2 overlap               W3 timeout leaves children alive      W4 temp files in %TEMP%
//   W5 missing script       W6 API key to the child  W7 default log folder and prune        W8 registration (real tasks.json)
// plus: extra args, the child output in the log, the exact tasks.json entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const WRAPPER = join(ROOT, '.claude', 'scripts', 'scheduled', 'scheduled-open-prs.ps1');
const TREE_HELPER = join(ROOT, 'scripts', 'lib', 'Stop-ProcessTree.ps1');
const REGISTRAR = join(ROOT, '.claude', 'scripts', 'scheduled', 'register-ccv3-tasks.ps1');
const TASKS = join(ROOT, 'scripts', 'scheduled', 'tasks.json');
const onWindows = process.platform === 'win32';
const win = { skip: !onWindows };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = `
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const list = (d) => { try { return readdirSync(d); } catch { return []; } };
let grandchild = null;
if (process.env.FAKE_GRANDCHILD) grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid;
writeFileSync(process.env.FAKE_CALL_FILE, JSON.stringify({
  argv: process.argv.slice(2), pid: process.pid, grandchild, envKeys: Object.keys(process.env), script: process.argv[1],
  tempTmp: list(process.env.TEMP).filter((f) => /^tmp.*\\.tmp$/i.test(f)), logDirFiles: list(process.env.FAKE_LOG_DIR),
}));
console.log('fake open-prs stdout line');
console.error('fake open-prs stderr line');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else if (process.env.FAKE_WAIT_FILE) {
  const t = setInterval(() => { if (existsSync(process.env.FAKE_WAIT_FILE)) { clearInterval(t); process.exit(Number(process.env.FAKE_EXIT ?? 0)); } }, 100);
} else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function fixture({ withScript = true, withTree = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-open-prs-wrapper-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'github'), { recursive: true });
  if (withScript) writeFileSync(join(repo, 'scripts', 'github', 'open-prs.mjs'), FAKE);
  if (withTree) { mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true }); copyFileSync(TREE_HELPER, join(repo, 'scripts', 'lib', 'Stop-ProcessTree.ps1')); }
  const tempDir = join(root, 'temp');
  mkdirSync(tempDir, { recursive: true });
  const logDir = join(root, 'logs');
  // A unique mutex name per fixture: a live Local\CCv3-Open-PRs run (or another test:scripts run) must not make a test exit 0 with no child.
  const mutex = `Local\\CCv3-Open-PRs-test-${basename(root)}`;
  return { root, repo, tempDir, logDir, mutex, log: join(logDir, '2026-11-13.log'), call: join(root, 'call.json'), call2: join(root, 'call2.json') };
}

function envFor(fx, extraEnv = {}, callFile = fx.call) {
  const env = {
    ...process.env, CCV3_OPEN_PRS_REPO_ROOT: fx.repo, CCV3_OPEN_PRS_LOG: fx.log, FAKE_CALL_FILE: callFile, FAKE_LOG_DIR: fx.logDir,
    TEMP: fx.tempDir, TMP: fx.tempDir, CCV3_OPEN_PRS_MUTEX: fx.mutex, ...extraEnv,
  };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  return env;
}
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER];
const guard = () => assert.ok(existsSync(WRAPPER), `wrapper not written yet: ${WRAPPER}`);

function run(fx, extraEnv = {}) {
  guard();
  const started = Date.now();
  const r = spawnSync('powershell.exe', PS_ARGS, { env: envFor(fx, extraEnv), encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '', out: r.stdout ?? '', err: r.stderr ?? '' };
}
const called = (fx, file = fx.call) => JSON.parse(readFileSync(file, 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; }
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

test('W1 the exit code of open-prs passes through: 0 and 10', win, () => {
  // Breaks when the wait returns a fixed 0 (a gh abort with exit 10 would hide from the doctor) or maps the code.
  for (const code of [0, 10]) {
    const fx = fixture();
    const r = run(fx, { FAKE_EXIT: String(code) });
    assert.equal(r.status, code, `open-prs exit ${code} must be the wrapper exit; log:\n${r.log}\n${r.err}`);
  }
});

test('the child runs bare by default, and CCV3_OPEN_PRS_EXTRA_ARGS reaches it', win, () => {
  // Breaks when the wrapper adds arguments by default (the script has its own default out folder) or drops the extra args.
  const fx = fixture();
  const r1 = run(fx);
  assert.equal(r1.status, 0, r1.log + r1.err);
  assert.deepEqual(called(fx).argv, []);
  assert.equal(called(fx).script, join(fx.repo, 'scripts', 'github', 'open-prs.mjs'));
  const fx2 = fixture();
  const r2 = run(fx2, { CCV3_OPEN_PRS_EXTRA_ARGS: `--out "${join(fx2.root, 'out')}" --cap 5` });
  assert.equal(r2.status, 0, r2.log + r2.err);
  assert.deepEqual(called(fx2).argv, ['--out', join(fx2.root, 'out'), '--cap', '5']);
});

test('stdout and stderr of open-prs reach the dated log (a gh abort line must be readable there)', win, () => {
  // Breaks when the redirected output is not copied into the log, or the wrapper writes no log at all.
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log + r.err);
  assert.match(r.log, /fake open-prs stdout line/);
  assert.match(r.log, /fake open-prs stderr line/);
});

test('W2 a second copy while the first runs exits 0 at once, logs "already running", and starts no second child', win, async () => {
  // Breaks when the Local\\CCv3-Open-PRs mutex is missing (two runs overlap), the second exit is not 0, or the second still starts the child.
  guard();
  const fx = fixture();
  const release = join(fx.root, 'release.flag');
  const first = spawn('powershell.exe', PS_ARGS, { env: envFor(fx, { FAKE_WAIT_FILE: release, CCV3_OPEN_PRS_TIMEOUT_SEC: '120' }), windowsHide: true, stdio: 'ignore' });
  const firstExit = new Promise((res) => first.on('close', (code) => res(code)));
  try {
    assert.ok(await waitFor(() => existsSync(fx.call)), 'the first copy must start the child');
    const started = Date.now();
    const second = spawnSync('powershell.exe', PS_ARGS, { env: envFor(fx, {}, fx.call2), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const ms = Date.now() - started;
    assert.equal(second.status, 0, `second copy exit; stdout ${second.stdout} stderr ${second.stderr}`);
    assert.ok(ms < 10000, `the second copy took ${ms} ms`);
    assert.match(readFileSync(fx.log, 'utf8'), /already running, exiting/);
    assert.ok(!existsSync(fx.call2), 'the second copy must not start open-prs');
  } finally {
    writeFileSync(release, 'go');
    const code = await Promise.race([firstExit, sleep(30000).then(() => 'timeout')]);
    if (code === 'timeout') { try { killQuietly(first.pid); } catch { /* gone */ } }
    if (existsSync(fx.call)) killQuietly(called(fx).pid);
  }
});

test('W2b CCV3_OPEN_PRS_MUTEX names the mutex: a copy whose mutex is held elsewhere exits 0 at once, and a different name does not block it', win, async () => {
  // Breaks when the wrapper ignores the override and always takes Local\\CCv3-Open-PRs (a live run or a parallel test:scripts run would then decide the result).
  guard();
  const fx = fixture();
  const holdScript = '$m = New-Object System.Threading.Mutex($false, $env:HOLD_NAME); $null = $m.WaitOne(0); "held"; Start-Sleep -Seconds 60';
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', holdScript], { env: { ...process.env, HOLD_NAME: fx.mutex }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((res) => holder.stdout.once('data', res));
    const blocked = run(fx);
    assert.equal(blocked.status, 0, blocked.log + blocked.err);
    assert.match(blocked.log, /already running, exiting/);
    assert.ok(!existsSync(fx.call), 'a held mutex must stop the child');
    const free = run(fx, { CCV3_OPEN_PRS_MUTEX: `${fx.mutex}-other`, FAKE_EXIT: '10' });
    assert.equal(free.status, 10, free.log + free.err);
    assert.ok(existsSync(fx.call), 'another mutex name must let the child run');
  } finally { killQuietly(holder.pid); }
});

test('W3 a hung open-prs with a hung grandchild is killed at CCV3_OPEN_PRS_TIMEOUT_SEC: exit 124, TIMEOUT logged, both pids gone', win, async () => {
  // Breaks when only the node pid is killed (the gh or review-status grandchild lives on), the timeout is not enforced, or the code is not 124.
  guard();
  const fx = fixture();
  let info = null;
  try {
    const r = run(fx, { FAKE_HANG: '1', FAKE_GRANDCHILD: '1', CCV3_OPEN_PRS_TIMEOUT_SEC: '3' });
    info = existsSync(fx.call) ? called(fx) : null;
    assert.equal(r.status, 124, r.log + r.err);
    assert.match(r.log, /TIMEOUT/);
    assert.ok(r.ms < 60000, `wrapper waited ${r.ms} ms`);
    assert.ok(info?.pid && info?.grandchild, 'the fake must have started a child and a grandchild');
    assert.ok(await waitFor(() => !alive(info.pid) && !alive(info.grandchild), 8000), `child alive ${alive(info.pid)}, grandchild alive ${alive(info.grandchild)}`);
  } finally {
    if (info) { killQuietly(info.pid); killQuietly(info.grandchild); }
  }
});

test('W3b with no Stop-ProcessTree.ps1 in the repo the wrapper falls back to killing the one child pid: exit 124', win, async () => {
  // Breaks when a missing helper crashes the timeout path (the hung child would live on and the code would not be 124).
  guard();
  const fx = fixture({ withTree: false });
  let info = null;
  try {
    const r = run(fx, { FAKE_HANG: '1', CCV3_OPEN_PRS_TIMEOUT_SEC: '3' });
    info = existsSync(fx.call) ? called(fx) : null;
    assert.equal(r.status, 124, r.log + r.err);
    assert.match(r.log, /TIMEOUT/);
    assert.ok(info?.pid);
    assert.ok(await waitFor(() => !alive(info.pid), 8000), 'the hung child must be dead');
  } finally { if (info) killQuietly(info.pid); }
});

test('W4 no temp file in %TEMP%: the redirect files live in the log folder while it runs and are gone after', win, () => {
  // Breaks when the wrapper redirects through GetTempFileName (tmp*.tmp in %TEMP%) or leaves its redirect files behind.
  const fx = fixture();
  const r = run(fx);
  assert.equal(r.status, 0, r.log + r.err);
  const during = called(fx);
  assert.deepEqual(during.tempTmp, [], 'no tmp*.tmp in the temp folder while the child runs');
  const redirects = during.logDirFiles.filter((f) => /^open-prs\.\d+\.(out|err)\.tmp$/.test(f));
  assert.equal(redirects.length, 2, `the log folder holds the out and err redirect files while it runs: ${during.logDirFiles.join(', ')}`);
  assert.deepEqual(readdirSync(fx.logDir).filter((f) => /\.tmp$/i.test(f)), [], 'no .tmp left in the log folder');
  assert.deepEqual(readdirSync(fx.tempDir).filter((f) => /^tmp.*\.tmp$/i.test(f)), [], 'no tmp*.tmp left in the temp folder');
});

test('W5 a missing open-prs script exits 3 with an ERROR line in the log, and nothing runs', win, () => {
  // Breaks when a missing script is a silent 0 or the wrapper runs another script.
  const fx = fixture({ withScript: false });
  const r = run(fx);
  assert.equal(r.status, 3, r.log + r.err);
  assert.match(r.log, /ERROR: .*open-prs\.mjs not found at .*open-prs\.mjs/);
  assert.ok(!existsSync(fx.call));
});

test('W6 ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN never reach open-prs', win, () => {
  // Breaks when the key strip is dropped: a script that calls no model must not carry a billing key.
  const fx = fixture();
  const r = run(fx, { ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' });
  assert.equal(r.status, 0, r.log + r.err);
  const keys = called(fx).envKeys;
  assert.ok(!keys.some((k) => /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)), keys.filter((k) => /ANTHROPIC/i.test(k)).join(','));
});

test('W7 with no log override the log is <USERPROFILE>/.claude/logs/open-prs/<yyyy-MM-dd>.log', win, () => {
  // Breaks when the default log folder is another folder or the day stamp is wrong.
  const fx = fixture();
  const fakeHome = join(fx.root, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = run(fx, { CCV3_OPEN_PRS_LOG: undefined, USERPROFILE: fakeHome });
  assert.equal(r.status, 0, r.out + r.err);
  const expected = join(fakeHome, '.claude', 'logs', 'open-prs', `${day}.log`);
  assert.ok(existsSync(expected), `expected ${expected}`);
  assert.match(readFileSync(expected, 'utf8'), /fake open-prs stdout line/);
});

test('W7b dated logs older than 14 days are pruned; a younger log and a file that is not a dated log stay', win, () => {
  // Breaks when the prune is missing, is shorter than 14 days, or deletes a non-log file.
  const fx = fixture();
  mkdirSync(fx.logDir, { recursive: true });
  const oldLog = join(fx.logDir, '2026-10-01.log');
  const newLog = join(fx.logDir, '2026-11-01.log');
  const other = join(fx.logDir, 'notes.txt');
  for (const f of [oldLog, newLog, other]) writeFileSync(f, 'x');
  const ago = (days) => new Date(Date.now() - days * 86_400_000);
  utimesSync(oldLog, ago(15), ago(15)); utimesSync(newLog, ago(2), ago(2)); utimesSync(other, ago(40), ago(40));
  const r = run(fx);
  assert.equal(r.status, 0, r.log + r.err);
  assert.ok(!existsSync(oldLog), 'the 15-day-old dated log must go');
  assert.ok(existsSync(newLog), 'the 2-day-old dated log must stay');
  assert.ok(existsSync(other), 'a file that is not a dated log is never touched');
});

// ---------------------------------------------------------------- W8: registration, real tasks.json, dry run only

test('W8 dry run on the REAL tasks.json: CCv3-Open-PRs is every 15m, limit 10 min, allowed on battery, hidden through conhost --headless', win, () => {
  // Breaks when the tasks.json entry is missing or its trigger, limit, battery, wake or hidden flag differs, or the registrar adds -WindowStyle.
  const tasks = JSON.parse(readFileSync(TASKS, 'utf8')).tasks;
  const home = join(mkdtempSync(join(tmpdir(), 'reg-open-prs-')), 'home');
  mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
  for (const t of tasks) writeFileSync(join(home, 'scripts', 'scheduled', basename(t.script)), 'rem stub\r\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REGISTRAR, '-TasksFile', TASKS, '-ClaudeHome', home, '-Only', 'CCv3-Open-PRs'],
    { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.equal(r.status, 0, out);
  const lines = (r.stdout ?? '').split(/\r?\n/);
  const line = lines.find((l) => l.startsWith('CCv3-Open-PRs:'));
  assert.ok(line, out);
  const conhost = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe').toLowerCase();
  assert.ok(line.toLowerCase().startsWith(`ccv3-open-prs: ${conhost} --headless powershell.exe -noprofile -executionpolicy bypass -file "`), line);
  assert.match(line, / -File ".*scheduled-open-prs\.ps1"  \[every 15m, limit 10 min, llm=false battery=allow wake=no\]$/);
  assert.doesNotMatch(line, /WindowStyle/);
  const repeat = lines.filter((l) => /^\s+repeat:/.test(l));
  assert.equal(repeat.length, 1, out);
  assert.match(repeat[0], /repeat: every PT15M, duration ''$/);
  assert.match(out, /^DRY RUN: nothing changed/m);
});

test('W8b the tasks.json entry is exactly the seat-approved one (Q4 warnExit [10], C3 hidden, no LLM)', () => {
  // Breaks when warnExit [10] is dropped (a gh abort shows as a doctor FAIL), the entry names another script, or a flag drifts.
  const entry = JSON.parse(readFileSync(TASKS, 'utf8')).tasks.find((t) => t.name === 'CCv3-Open-PRs');
  assert.deepEqual(entry, {
    name: 'CCv3-Open-PRs', script: '.claude/scripts/scheduled/scheduled-open-prs.ps1', trigger: 'every 15m', execLimitMin: 10,
    allowedExit: [0], warnExit: [10], maxAgeHours: 1, llm: false, battery: true, hidden: true, wake: false,
  });
});
