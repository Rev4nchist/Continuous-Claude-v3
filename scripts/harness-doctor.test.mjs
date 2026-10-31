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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** A clean fixture: a git repo on main with a build manifest and passing check scripts, a home whose cursor equals main, a fresh review count. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hdoc-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  put(join(repo, '.claude', 'hooks', 'registration-baseline.json'), '{}\n');
  put(join(repo, '.claude', 'hooks', 'dist', '.build-inputs.json'), '{}\n');
  for (const rel of CHECK_SCRIPTS) put(join(repo, 'scripts', ...rel), "console.log('PASS  stub'); process.exit(0);\n");
  put(join(repo, 'review-router.config.json'), JSON.stringify({ coderabbit: { reviews_7d_manual: 10, reviews_7d_manual_date: daysAgoDay(1) } }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'init');
  put(join(home, '.claude', 'state', 'sync-cursor'), `${git(repo, 'rev-parse', 'main')}\n`);
  return { root, repo, home };
}

function run(fx, extra = []) {
  const r = spawnSync(process.execPath, [DOCTOR, '--home', fx.home, '--repo', fx.repo, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
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
