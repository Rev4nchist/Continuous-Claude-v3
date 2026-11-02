// End-to-end tests for scripts/harness-doctor.mjs. Each test runs the real script as a child
// process against a temp fixture home and a temp git repo. A fixture starts clean (every check
// passes). A test breaks one thing and reads the one output line it should change.
//
// How the doctor can fail, one test each below:
//   sync cursor: missing (FAIL), stale (WARN), current (PASS)
//   sync: .sync.pending marker, fresh quarantine dirs (count), orphan worktree folder
//   hooks: missing build manifest (read from the repo, not the home), dirty baseline, child script exit 1 and exit 0,
//          a missing child script (WARN, not a vacuous PASS)
//   logs: 0 / 1 / 4 / 5 error thresholds, the 24 h window, bad JSON lines, each log's own error rule
//   review: ledger at 80% of the day cap, rows of another day, stale review count date
//   output: exit code, summary line, --json artifact, no artifact without --json
//   --out: writes the JSON to the named file (parent dir created), needs a value, works without --json
//   repo:branch: main (PASS), another branch (WARN), detached HEAD (WARN)
//   schedule:<task>: tasks.json missing / not JSON / no tasks array (WARN), a bad entry (WARN), task not registered (WARN),
//          last result outside allowedExit (FAIL), last run older than maxAgeHours (WARN), never run (WARN),
//          schtasks columns not found (WARN), columns in another order and quoted commas (parsed by name), skipped off Windows
//   blocklist:age: 1 day (PASS), 3 days exactly (PASS), 4 days (WARN), 14 days exactly (WARN), 15 days (FAIL), never committed (WARN)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseCsv, scheduleChecks, blocklistAge } from './harness-doctor.mjs';

const DOCTOR = join(dirname(fileURLToPath(import.meta.url)), 'harness-doctor.mjs');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const daysAgoDay = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const CHECK_SCRIPTS = [['hooks', 'registration-reconcile.mjs'], ['hooks', 'hook-contract-guard.mjs'], ['settings', 'hook-parity.mjs']];
const BLOCKLIST_REL = ['.claude', 'hooks', 'src', 'shared', 'malicious-packages.json'];

// ---- fake schtasks output (shape copied from a real `schtasks /query /tn <name> /v /fo csv` run) ----
const HEADERS = ['HostName', 'TaskName', 'Next Run Time', 'Status', 'Logon Mode', 'Last Run Time', 'Last Result', 'Author', 'Comment'];
const csvLine = (cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
const usTime = (msAgo) => new Date(Date.now() - msAgo).toLocaleString('en-US', { hour12: true }).replace(',', '');
/** One header row and one data row. `fields` override the defaults; `order` sets the column order. */
const taskCsv = (name, fields = {}, order = HEADERS) => {
  const row = { HostName: 'HOST', TaskName: `\\${name}`, 'Next Run Time': 'N/A', Status: 'Ready', 'Logon Mode': 'Interactive only', 'Last Run Time': usTime(HOUR), 'Last Result': '0', Author: 'a', Comment: 'x', ...fields };
  return `${csvLine(order)}\r\n${csvLine(order.map((h) => row[h] ?? ''))}\r\n`;
};
/** A fake schtasks: name to output. A name that is not in the map answers like schtasks does for an unknown task. */
const fakeQuery = (map) => (name) => (name in map ? { status: 0, stdout: map[name], stderr: '' }
  : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\r\n' });
const task = (over = {}) => ({ name: 'CCv3-Fake-Task', script: 's.bat', trigger: 'daily 07:50', execLimitMin: 10, allowedExit: [0], maxAgeHours: 48, ...over });
const TASK_NAME = 'CCv3-Fake-Task';

/**
 * A clean fixture: a git repo on main with a build manifest and passing check scripts, a home whose cursor equals main,
 * a fresh review count, a tasks.json with one healthy fake task, and a blocklist file committed `blocklistDaysAgo` days ago
 * (null: never committed).
 */
function fixture({ blocklistDaysAgo = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hdoc-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const schtasks = join(root, 'schtasks');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  put(join(repo, '.claude', 'hooks', 'registration-baseline.json'), '{}\n');
  put(join(repo, '.claude', 'hooks', 'dist', '.build-inputs.json'), '{}\n');
  for (const rel of CHECK_SCRIPTS) put(join(repo, 'scripts', ...rel), "console.log('PASS  stub'); process.exit(0);\n");
  put(join(repo, 'review-router.config.json'), JSON.stringify({ coderabbit: { reviews_7d_manual: 10, reviews_7d_manual_date: daysAgoDay(1) } }));
  put(join(repo, 'scripts', 'scheduled', 'tasks.json'), JSON.stringify({ tasks: [task()] }));
  put(join(schtasks, `${TASK_NAME}.csv`), taskCsv(TASK_NAME));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'init');
  if (blocklistDaysAgo !== null) commitBlocklist(repo, blocklistDaysAgo);
  put(join(home, '.claude', 'state', 'sync-cursor'), `${git(repo, 'rev-parse', 'main')}\n`);
  return { root, repo, home, schtasks };
}

/** Commits the blocklist file with a committer date `days` days back. */
function commitBlocklist(repo, days) {
  put(join(repo, ...BLOCKLIST_REL), '{}\n');
  const when = new Date(Date.now() - days * DAY - 60000).toISOString();
  const env = { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when };
  const base = ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  execFileSync('git', [...base, 'add', '-A'], { env, windowsHide: true });
  execFileSync('git', [...base, 'commit', '-q', '--no-verify', '-m', 'blocklist'], { env, windowsHide: true });
}

function run(fx, extra = []) {
  // HARNESS_DOCTOR_SCHTASKS_DIR points the doctor at fake schtasks output, so a test never reads the real Task Scheduler.
  const env = { ...process.env, HARNESS_DOCTOR_SCHTASKS_DIR: fx.schtasks };
  const r = spawnSync(process.execPath, [DOCTOR, '--home', fx.home, '--repo', fx.repo, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
  const lines = (r.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const checks = {};
  for (const l of lines) {
    const m = /^(PASS|WARN|FAIL)\s+(\S+)\s+(.*)$/.exec(l);
    if (m) checks[m[2]] = { status: m[1], detail: m[3] };
  }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', lines, checks };
}

const logPath = (fx, name) => join(fx.home, '.claude', 'logs', name);
const gate = (n, ago = HOUR) => Array.from({ length: n }, () => ({ ts: iso(ago), hook: 'pre-pr-gate', error: 'spawnSync git ETIMEDOUT' }));

test('a clean fixture passes every check, prints the summary line and exits 0', () => {
  const r = run(fixture());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.lines.at(-1), /^harness: \d+ pass \/ 0 warn \/ 0 fail$/);
  assert.ok(Object.keys(r.checks).length >= 14, `expected 14 or more check lines, got ${Object.keys(r.checks).length}`);
  for (const [id, c] of Object.entries(r.checks)) assert.equal(c.status, 'PASS', `${id}: ${c.detail}`);
});

// ---- sync ----
test('a missing sync cursor is a FAIL, names the file and exits 1', () => {
  const fx = fixture();
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(fx.home, '.claude', 'state', 'sync-cursor'))})`]);
  const r = run(fx);
  assert.equal(r.checks['sync:cursor'].status, 'FAIL');
  assert.match(r.checks['sync:cursor'].detail, /sync-cursor/);
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /\/ 1 fail$/);
});

test('a stale sync cursor is a WARN and exits 0', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', 'state', 'sync-cursor'), `${'a'.repeat(40)}\n`);
  const r = run(fx);
  assert.equal(r.checks['sync:cursor'].status, 'WARN');
  assert.match(r.checks['sync:cursor'].detail, /aaaaaaa/);
  assert.equal(r.code, 0);
});

test('a .sync.pending marker is a WARN', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', '.sync.pending'), '');
  const r = run(fx);
  assert.equal(r.checks['sync:pending'].status, 'WARN');
  assert.match(r.checks['sync:pending'].detail, /\.sync\.pending/);
});

test('only quarantine dirs newer than 7 days count', () => {
  const fx = fixture();
  const q = join(fx.home, '.claude', '.sync-quarantine');
  const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-120000`;
  for (const ago of [1 * DAY, 2 * DAY, 30 * DAY]) put(join(q, stamp(new Date(Date.now() - ago)), 'x.txt'), 'x');
  const r = run(fx);
  assert.equal(r.checks['sync:quarantine'].status, 'WARN');
  assert.match(r.checks['sync:quarantine'].detail, /\b2\b/);
});

test('a quarantine dir with an odd name falls back to its mtime', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', '.sync-quarantine', 'odd', 'x.txt'), 'x');
  const r = run(fx);
  assert.equal(r.checks['sync:quarantine'].status, 'WARN');
});

test('a worktree folder that git does not list is a WARN naming it; a listed one is not', () => {
  const fx = fixture();
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'wt-real', join(fx.repo, '.claude', 'worktrees', 'real-one'));
  mkdirSync(join(fx.repo, '.claude', 'worktrees', 'orphan-one'), { recursive: true });
  const r = run(fx);
  assert.equal(r.checks['sync:worktrees'].status, 'WARN');
  assert.match(r.checks['sync:worktrees'].detail, /orphan-one/);
  assert.doesNotMatch(r.checks['sync:worktrees'].detail, /real-one/);
});

test('a --repo reached through a link still matches its listed worktrees (no false orphan)', () => {
  const fx = fixture();
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'wt-linked', join(fx.repo, '.claude', 'worktrees', 'linked-one'));
  const link = join(fx.root, 'repo-link');
  symlinkSync(fx.repo, link, 'junction');
  const r = run({ ...fx, repo: link });
  assert.equal(r.checks['sync:worktrees'].status, 'PASS', r.checks['sync:worktrees'].detail);
});

// ---- hooks ----
const slash = (p) => p.replace(/\\/g, '/');

test('a missing hook build manifest is a WARN naming the repo file and the repo fix', () => {
  const fx = fixture();
  const file = join(fx.repo, '.claude', 'hooks', 'dist', '.build-inputs.json');
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(file)})`]);
  const c = run(fx).checks['hooks:build-inputs'];
  assert.equal(c.status, 'WARN');
  assert.ok(slash(c.detail).includes(slash(file)), `names the repo file: ${c.detail}`);
  assert.match(c.detail, /sync-to-active\.sh --changed/);
  assert.doesNotMatch(c.detail, /~\/\.claude\/hooks/);
});

test('the build manifest is read from the repo: a home without one still passes', () => {
  const fx = fixture();
  assert.equal(existsSync(join(fx.home, '.claude', 'hooks', 'dist', '.build-inputs.json')), false);
  assert.equal(run(fx).checks['hooks:build-inputs'].status, 'PASS');
});

test('a missing repo check script is a WARN naming the file, not a vacuous PASS', () => {
  for (const [dir, name] of CHECK_SCRIPTS) {
    const fx = fixture();
    execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(fx.repo, 'scripts', dir, name))})`]);
    const c = run(fx).checks[`hooks:${name.replace(/\.mjs$/, '')}`];
    assert.equal(c.status, 'WARN', name);
    assert.ok(c.detail.includes(name), c.detail);
    assert.match(c.detail, /missing/);
  }
});

test('a registration baseline that git shows as changed is a WARN', () => {
  const fx = fixture();
  put(join(fx.repo, '.claude', 'hooks', 'registration-baseline.json'), '{"changed":true}\n');
  const r = run(fx);
  assert.equal(r.checks['hooks:baseline-clean'].status, 'WARN');
  assert.match(r.checks['hooks:baseline-clean'].detail, /registration-baseline\.json/);
});

test('a repo hook check that exits 1 is a FAIL and one that exits 0 is a PASS', () => {
  const fx = fixture();
  put(join(fx.repo, 'scripts', 'hooks', 'registration-reconcile.mjs'), "console.log('FAIL  registration-reconcile  2 findings'); process.exit(1);\n");
  put(join(fx.repo, 'scripts', 'hooks', 'hook-contract-guard.mjs'), "console.log('PASS  hook-contract-guard  fine'); process.exit(0);\n");
  const r = run(fx);
  assert.equal(r.checks['hooks:registration-reconcile'].status, 'FAIL');
  assert.match(r.checks['hooks:registration-reconcile'].detail, /2 findings/);
  assert.equal(r.checks['hooks:hook-contract-guard'].status, 'PASS');
  assert.equal(r.code, 1);
});

test('a repo hook check gets the fixture home, not the real one', () => {
  const fx = fixture();
  put(join(fx.repo, 'scripts', 'hooks', 'registration-reconcile.mjs'),
    "const h = (process.env.USERPROFILE || process.env.HOME).replace(/\\\\/g, '/'); console.log('home=' + h); process.exit(0);\n");
  const r = run(fx);
  assert.ok(r.checks['hooks:registration-reconcile'].detail.includes(fx.home.replace(/\\/g, '/')), r.checks['hooks:registration-reconcile'].detail);
});

// ---- logs ----
test('error counts map 0 to PASS, 1 to 4 to WARN and 5 to FAIL', () => {
  const expected = [[0, 'PASS'], [1, 'WARN'], [4, 'WARN'], [5, 'FAIL']];
  for (const [n, status] of expected) {
    const fx = fixture();
    put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl(gate(n)));
    const r = run(fx);
    assert.equal(r.checks['logs:pre-pr-gate-errors'].status, status, `${n} errors`);
  }
});

test('a log FAIL exits 1 and names the top message and the file', () => {
  const fx = fixture();
  put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl([...gate(4), { ts: iso(HOUR), hook: 'pre-pr-gate', error: 'rare one' }, ...gate(2)]));
  const r = run(fx);
  const c = r.checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'FAIL');
  assert.match(c.detail, /ETIMEDOUT/);
  assert.match(c.detail, /pre-pr-gate-errors\.jsonl/);
  assert.equal(r.code, 1);
});

test('errors older than 24 hours are not counted', () => {
  const fx = fixture();
  put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl([...gate(9, 25 * HOUR), ...gate(2, 23 * HOUR)]));
  assert.equal(run(fx).checks['logs:pre-pr-gate-errors'].status, 'WARN');
});

test('bad JSON lines and lines without a valid ts are skipped and counted', () => {
  const fx = fixture();
  put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl(['{not json', '', { error: 'no ts' }, { ts: 'yesterday-ish', error: 'bad ts' }, ...gate(1)]));
  const c = run(fx).checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /3 unparsable/);
});

test('guard-decisions counts only lines with kind error', () => {
  const fx = fixture();
  const other = Array.from({ length: 8 }, () => ({ ts: iso(HOUR), kind: 'deny', reason: 'blocked' }));
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([...other, { ts: iso(HOUR), kind: 'error', reason: 'guard crashed' }]));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /guard crashed/);
});

test('hooks.log counts level error lines and ignores info lines', () => {
  const fx = fixture();
  const info = Array.from({ length: 8 }, () => ({ ts: iso(HOUR), level: 'info', hook: 'x', msg: 'fine' }));
  put(logPath(fx, 'hooks.log'), jsonl([...info, { ts: iso(HOUR), level: 'error', hook: 'atomic-write', msg: 'write failed' }]));
  const c = run(fx).checks['logs:hooks.log'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /write failed/);
});

test('memory-write-failures is read from the state dir', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', 'state', 'memory-write-failures.jsonl'), jsonl([{ ts: iso(HOUR), source: 'store_learning', error: 'missing metadata.source' }]));
  const c = run(fx).checks['logs:memory-write-failures'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /missing metadata\.source/);
});

test('an absent log is a PASS that says absent', () => {
  const c = run(fixture()).checks['logs:hooks.log'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /absent/);
});

// ---- review ----
const ledger = (fx, rows) => put(join(fx.home, '.claude', 'state', 'coderabbit-paid.jsonl'), jsonl(rows));
const row = (cost, date = chicagoToday()) => ({ ts: iso(HOUR), date, pr: 1, head: 'a'.repeat(40), files: 1, cost, session: 's' });

test('a paid total at 80% of the $15 day cap is a WARN; below it is a PASS', () => {
  const fx = fixture();
  ledger(fx, [row(6), row(6)]);
  const warn = run(fx).checks['review:cr-paid-cap'];
  assert.equal(warn.status, 'WARN');
  assert.match(warn.detail, /12\.00/);
  ledger(fx, [row(6), row(5.75)]);
  assert.equal(run(fx).checks['review:cr-paid-cap'].status, 'PASS');
});

test('CLI spend rows (kind cli) do not count toward the $15 PR day cap: the two caps stay separate', () => {
  const fx = fixture();
  ledger(fx, [row(6), row(6), { ...row(3), kind: 'cli', pr: undefined, branch: 'b' }]);
  const c = run(fx).checks['review:cr-paid-cap'];
  assert.match(c.detail, /12\.00/, 'only the PR rows are summed');
  assert.equal(c.status, 'WARN');
  ledger(fx, [row(5), { ...row(9), kind: 'cli', pr: undefined, branch: 'b' }]);
  assert.equal(run(fx).checks['review:cr-paid-cap'].status, 'PASS', '$5 of PR rows is under 80%');
});

test('ledger rows of another day do not count and a bad ledger line is reported', () => {
  const fx = fixture();
  ledger(fx, [row(14, '2020-01-01'), '{broken', row(1)]);
  const c = run(fx).checks['review:cr-paid-cap'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /1\.00/);
  assert.match(c.detail, /1 unparsable/);
});

test('a review count read more than 7 days ago is a WARN', () => {
  const fx = fixture();
  put(join(fx.repo, 'review-router.config.json'), JSON.stringify({ coderabbit: { reviews_7d_manual: 50, reviews_7d_manual_date: daysAgoDay(9) } }));
  const c = run(fx).checks['review:reviews-7d'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /review-router\.config\.json/);
});

test('a missing review-router config is a WARN', () => {
  const fx = fixture();
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(fx.repo, 'review-router.config.json'))})`]);
  assert.equal(run(fx).checks['review:reviews-7d'].status, 'WARN');
});

// ---- repo:branch ----
test('repo:branch is a PASS on main, a WARN naming the branch on another branch, a WARN on a detached HEAD', () => {
  const fx = fixture();
  assert.equal(run(fx).checks['repo:branch'].status, 'PASS');
  git(fx.repo, 'checkout', '-q', '-b', 'feat/other');
  const other = run(fx).checks['repo:branch'];
  assert.equal(other.status, 'WARN');
  assert.match(other.detail, /feat\/other/);
  git(fx.repo, 'checkout', '-q', '--detach');
  const det = run(fx).checks['repo:branch'];
  assert.equal(det.status, 'WARN');
  assert.match(det.detail, /detached/);
});

// ---- schedule (the real scheduleChecks with a fake schtasks) ----
const schedRepo = (tasksJson) => {
  const repo = mkdtempSync(join(tmpdir(), 'hdoc-sched-'));
  if (tasksJson !== undefined) put(join(repo, 'scripts', 'scheduled', 'tasks.json'), typeof tasksJson === 'string' ? tasksJson : JSON.stringify(tasksJson));
  return { repo };
};
const sched = (tasks, map, extra = {}) => scheduleChecks(schedRepo({ tasks }), { platform: 'win32', query: fakeQuery(map), ...extra });
const only = (checks) => { assert.equal(checks.length, 1, JSON.stringify(checks)); return checks[0]; };

test('parseCsv reads quoted commas, doubled quotes and CRLF line ends', () => {
  const rows = parseCsv('"a","b, c","say ""hi"""\r\n"1","2","3"\r\n');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
});

test('a missing tasks.json is one WARN naming the file, not a crash', () => {
  const c = only(scheduleChecks(schedRepo(), { platform: 'win32', query: fakeQuery({}) }));
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /tasks\.json/);
});

test('a tasks.json that is not JSON, or has no tasks array, is a WARN', () => {
  assert.equal(only(scheduleChecks(schedRepo('{nope'), { platform: 'win32', query: fakeQuery({}) })).status, 'WARN');
  assert.equal(only(scheduleChecks(schedRepo({ nothing: [] }), { platform: 'win32', query: fakeQuery({}) })).status, 'WARN');
});

test('a registered task with an allowed result and a fresh run is a PASS named schedule:<task>', () => {
  const c = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME) }));
  assert.equal(c.status, 'PASS', c.detail);
  assert.equal(`${c.section}:${c.check}`, `schedule:${TASK_NAME}`);
});

test('a task that schtasks does not know is a WARN that says not registered', () => {
  const c = only(sched([task()], {}));
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /not registered/);
});

test('a last result outside allowedExit is a FAIL naming the result; one inside allowedExit is a PASS', () => {
  const bad = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '1' }) }));
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.detail, /\b1\b/);
  const ok = only(sched([task({ allowedExit: [0, 1] })], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '1' }) }));
  assert.equal(ok.status, 'PASS');
});

test('a last run older than maxAgeHours is a WARN; one inside it is a PASS', () => {
  const stale = only(sched([task({ maxAgeHours: 48 })], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Run Time': usTime(49 * HOUR) }) }));
  assert.equal(stale.status, 'WARN');
  assert.match(stale.detail, /48/);
  const fresh = only(sched([task({ maxAgeHours: 48 })], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Run Time': usTime(47 * HOUR) }) }));
  assert.equal(fresh.status, 'PASS');
});

test('a task that never ran (N/A, or result 267011) is a WARN', () => {
  for (const f of [{ 'Last Run Time': 'N/A', 'Last Result': '267011' }, { 'Last Run Time': '11/30/1999 12:00:00 AM', 'Last Result': '267011' }, { 'Last Run Time': 'N/A' }]) {
    const c = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, f) }));
    assert.equal(c.status, 'WARN', JSON.stringify(f));
    assert.match(c.detail, /never ran/);
  }
});

test('a task that is running now (result 267009) is not judged by its result', () => {
  const c = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '267009' }) }));
  assert.equal(c.status, 'PASS', c.detail);
});

test('columns are found by header name: another column order and a quoted-comma field still parse', () => {
  const order = ['Last Result', 'Comment', 'Last Run Time', 'TaskName', 'HostName'];
  const fail = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '5', Comment: 'a, "b", c' }, order) }));
  assert.equal(fail.status, 'FAIL');
  assert.match(fail.detail, /\b5\b/);
  const pass = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, { Comment: 'a, "b", c' }, order) }));
  assert.equal(pass.status, 'PASS', pass.detail);
});

test('headers the doctor cannot find (another Windows language) are a WARN naming them, not a crash or a PASS', () => {
  const order = ['HostName', 'TaskName', 'Letzte Laufzeit', 'Letztes Ergebnis'];
  const c = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Letzte Laufzeit': 'x', 'Letztes Ergebnis': '0' }, order) }));
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /Last Run Time/);
});

test('a task entry with a missing or wrong field is a WARN naming it; the other entries are still checked', () => {
  const broken = { name: 'CCv3-Broken', script: 's.bat', trigger: 'daily', execLimitMin: 5 };
  const checks = sched([broken, task()], { [TASK_NAME]: taskCsv(TASK_NAME) });
  assert.equal(checks.length, 2);
  assert.equal(checks[0].status, 'WARN');
  assert.match(checks[0].detail, /allowedExit/);
  assert.match(checks[0].check, /CCv3-Broken/);
  assert.equal(checks[1].status, 'PASS');
});

test('off Windows the schedule check is a PASS that says skipped and runs no query', () => {
  let calls = 0;
  const c = only(scheduleChecks(schedRepo({ tasks: [task()] }), { platform: 'linux', query: () => { calls++; return { status: 0, stdout: '', stderr: '' }; } }));
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /skipped/);
  assert.equal(calls, 0);
});

test('a schtasks that cannot start is a WARN', () => {
  const c = only(scheduleChecks(schedRepo({ tasks: [task()] }), { platform: 'win32', query: () => ({ error: 'spawn schtasks ENOENT' }) }));
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /ENOENT/);
});

test('end to end: a task with no schtasks output is a WARN and a bad last result is a FAIL with exit 1', () => {
  const fx = fixture();
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(fx.schtasks, `${TASK_NAME}.csv`))})`]);
  const warn = run(fx);
  assert.equal(warn.checks[`schedule:${TASK_NAME}`].status, 'WARN');
  assert.equal(warn.code, 0);
  put(join(fx.schtasks, `${TASK_NAME}.csv`), taskCsv(TASK_NAME, { 'Last Result': '1' }));
  const fail = run(fx);
  assert.equal(fail.checks[`schedule:${TASK_NAME}`].status, 'FAIL');
  assert.equal(fail.code, 1);
});

// ---- blocklist:age ----
test('blocklist:age is PASS up to 3 days, WARN over 3, FAIL over 14, by the last commit that touched the file', () => {
  const expected = [[1, 'PASS', 0], [4, 'WARN', 0], [15, 'FAIL', 1]];
  for (const [days, status, code] of expected) {
    const r = run(fixture({ blocklistDaysAgo: days }));
    assert.equal(r.checks['blocklist:age'].status, status, `${days} days: ${r.checks['blocklist:age'].detail}`);
    assert.equal(r.code, code, `${days} days`);
  }
});

test('blocklist:age names the file and the age in days', () => {
  const c = run(fixture({ blocklistDaysAgo: 15 })).checks['blocklist:age'];
  assert.match(c.detail, /malicious-packages\.json/);
  assert.match(c.detail, /15\.\d day/);
});

test('blocklist:age edges: exactly 3 days is a PASS and exactly 14 days is a WARN (over means strictly over)', () => {
  const at = (days) => blocklistAge({ repo: 'r' }, { now: 1e12, lastCommit: () => ({ sec: (1e12 - days * DAY) / 1000, sha: 'abc1234' }) });
  assert.equal(at(3).status, 'PASS');
  assert.equal(at(14).status, 'WARN');
  assert.equal(at(14.01).status, 'FAIL');
});

test('blocklist:age is a WARN when no commit touched the file', () => {
  const c = run(fixture({ blocklistDaysAgo: null })).checks['blocklist:age'];
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /no commit/);
});

// ---- --out ----
test('parseArgs reads --out as a resolved path and rejects --out without a value', () => {
  assert.equal(parseArgs(['--out', 'x.json']).out, join(process.cwd(), 'x.json'));
  assert.equal(parseArgs([]).out, null);
  assert.throws(() => parseArgs(['--out']), /--out needs a file/);
});

test('--out writes the JSON result to the named file, creates its parent dirs, and needs no --json', () => {
  const fx = fixture();
  const out = join(fx.root, 'a', 'b', 'latest.json');
  const r = run(fx, ['--out', out]);
  assert.ok(existsSync(out), `missing ${out}\n${r.stdout}${r.stderr}`);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.summary.fail, 0);
  assert.ok(j.checks.length >= 14);
  assert.ok(j.checks.some((c) => c.section === 'schedule' && c.check === TASK_NAME));
  assert.equal(existsSync(join(fx.repo, '.claude', 'cache', 'e2e')), false, '--out alone must not write the default artifact');
});

test('--out and --json together write both files', () => {
  const fx = fixture();
  const out = join(fx.root, 'both.json');
  run(fx, ['--json', '--out', out]);
  assert.ok(existsSync(out));
  assert.ok(existsSync(join(fx.repo, '.claude', 'cache', 'e2e')));
});

test('an --out file that cannot be written exits 2 and says so, after the check lines', () => {
  const fx = fixture();
  put(join(fx.root, 'blocker'), 'a file, not a dir');
  const r = run(fx, ['--out', join(fx.root, 'blocker', 'x.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot write/);
  assert.match(r.lines.at(-1), /^harness: /);
});

test('a failed --json artifact write still writes --out, then exits 2', () => {
  // The scheduled wrapper passes both. latest.json feeds the session-start line, so it must not depend on the repo cache.
  const fx = fixture();
  put(join(fx.repo, '.claude', 'cache'), 'a file, not a dir');
  const out = join(fx.root, 'latest.json');
  const r = run(fx, ['--json', '--out', out]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot write/);
  assert.ok(existsSync(out), `--out was skipped after the --json write failed\n${r.stderr}`);
});

// ---- output ----
test('--json writes the artifact under the repo; a plain run writes nothing', () => {
  const fx = fixture();
  const dir = join(fx.repo, '.claude', 'cache', 'e2e');
  run(fx);
  assert.equal(existsSync(dir), false, 'a plain run must not write');
  const r = run(fx, ['--json']);
  const day = new Date();
  const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}-harness-doctor.json`;
  const file = join(dir, name);
  assert.ok(existsSync(file), `missing ${file}\n${r.stdout}${r.stderr}`);
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(j.summary.fail, 0);
  assert.ok(j.checks.length >= 14);
  assert.ok(j.checks.every((c) => c.status && c.section && c.check && c.detail !== undefined));
});

test('a file under the home is never changed by a run', () => {
  const fx = fixture();
  const f = join(fx.home, '.claude', 'state', 'sync-cursor');
  const old = new Date(Date.now() - 5 * DAY);
  utimesSync(f, old, old);
  const before = readFileSync(f, 'utf8');
  run(fx, ['--json']);
  assert.equal(readFileSync(f, 'utf8'), before);
  assert.equal(Math.round(new Date(execFileSync(process.execPath, ['-e', `console.log(require('fs').statSync(${JSON.stringify(f)}).mtime.toISOString())`], { encoding: 'utf8' }).trim()).getTime() / 1000), Math.round(old.getTime() / 1000));
});
