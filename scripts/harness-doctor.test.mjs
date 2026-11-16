// End-to-end tests for scripts/harness-doctor.mjs. Each test runs the real script as a child
// process against a temp fixture home and a temp git repo. A fixture starts clean (every check
// passes). A test breaks one thing and reads the one output line it should change.
//
// How the doctor can fail, one test each below:
//   sync cursor: missing (FAIL), stale (WARN), current (PASS)
//   sync: .sync.pending marker, fresh quarantine dirs (count), orphan worktree folder (WARN from 24 h old with its age and the orphans.mjs
//          command; younger is info; node_modules is never an orphan)
//   hooks: missing build manifest (read from the repo, not the home), dirty baseline, child script exit 1 and exit 0,
//          a missing child script (WARN, not a vacuous PASS)
//   logs: 0 / 1 / 4 rows (PASS), 3 distinct (hook, message, folder) pairs (WARN), 5 rows (FAIL), a benign "directory not found" row, the 24 h window,
//          bad JSON lines, each log's own error rule
//   review: ledger at 80% of the day cap, rows of another day, stale review count date
//   output: exit code, summary line, --json artifact, no artifact without --json
//   --out: writes the JSON to the named file (parent dir created), needs a value, works without --json
//   repo:branch: main (PASS), another branch (WARN), detached HEAD (WARN)
//   schedule:<task>: tasks.json missing / not JSON / no tasks array (WARN), a bad entry (WARN), task not registered (WARN),
//          last result outside allowedExit (FAIL), last run older than maxAgeHours (WARN), never run (info until its first scheduled
//          time, then WARN; no XML: WARN),
//          schtasks columns not found (WARN), columns in another order and quoted commas (parsed by name), skipped off Windows
//   schedule:<task> registration drift (the task XML vs tasks.json llm/wake/trigger; one row per task, folded in): llm=true but the task
//          still blocks on battery (WARN "battery"), stops on battery (WARN), wake wanted but WakeToRun absent (WARN "wake"), trigger time or
//          kind differs (WARN "trigger"), everything matches (PASS), drift plus a bad last result (FAIL stays FAIL), drift on a stale task
//          (still WARN, drift named), XML unreadable (WARN, never PASS), a non-boolean llm/wake in tasks.json (WARN), end to end drift exits 0
//   schedule:readme-tasks: README names a CCv3-* task that tasks.json lacks (FAIL, names token, line and README), only listed tasks (PASS with count),
//          a prefix of a real name or a longer name (FAIL), CCv3-1 / bare CCv3 / unprefixed names (no false hit), no README (PASS absent),
//          tasks.json not JSON (WARN)
//   blocklist:age: 1 day (PASS), 3 days exactly (PASS), 4 days (WARN), 14 days exactly (WARN), 15 days (FAIL), never committed (WARN)
//   registry:roots-exist: an active entry with a missing path (FAIL, names it), an inactive one (ignored), in-development counts as active,
//          a present path (PASS), no registry file (PASS absent), a registry that is not JSON (WARN)
//   registry:mirror-drift: the home mirror lacks a laneBoard (FAIL, names the key), a status change and a key in one copy only (FAIL),
//          the same fields spelled differently or a notes-only change (PASS), a missing copy (PASS absent), a copy that is not JSON (WARN)
//   registry:project-rows: no row (WARN), another root (WARN), the same root spelled with capitals (PASS), inactive entry (ignored),
//          database skipped / no URL / unreadable (PASS / WARN / WARN); against a real scratch database: WARN, then PASS once the row exists
//   lanes:board-columns: both columns (PASS), none (WARN, never FAIL: 0004 is not applied live yet), one of two (FAIL), no URL or unreadable (WARN);
//          against real scratch databases with and without migration 0004
//   lanes:schema: agentic_os.__migrations rows vs the journal. Skipped (PASS), no URL / unreachable / no journal / no table (WARN),
//          equal with the trigger (PASS), behind by exactly 0004 (WARN "migration 0004 not applied"), behind by more (FAIL),
//          ahead (WARN), equal but the trigger is gone (FAIL); against real scratch databases with a filled __migrations table
//   lanes:worktree-lane-mjs: no worktrees dir (PASS absent), same file with CRLF (PASS), a different file in a non-worktree or a worktree
//          that lacks main's last lane.mjs change (WARN, names it), a differing copy on a branch that has that change (info PASS)
//   lanes:shim: the home shim equals the repo shim (PASS, CRLF folded), differs / missing in home / missing in repo (WARN, never FAIL)
//   lanes:hook-client-version: both bundles carry lane.client_version (PASS); one lacks it (WARN, FAIL only when the registry has a live
//          board other than continuous-claude); a bundle missing (WARN); an inactive other board does not count
//   hooks:render-check: every lane hook of the rendered template is live with the same matcher (PASS); Stop missing (WARN naming
//          lane-board-stop-gate and apply-registrations --only); a changed matcher (WARN); a non-lane hook missing (ignored); no template / no live file (WARN)
//   hooks:dist-parity: the lane hook dists in the home equal the repo dists (PASS, CRLF folded); different / missing in either (WARN)
//   lanes:relative-path-guard: at or under the ratchet baseline (PASS); a file over it (WARN naming the file); no baseline (WARN)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, symlinkSync, rmdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from './lib/resolve-deps.mjs';
import {
  parseArgs, parseCsv, scheduleChecks, blocklistAge, registryProjectRows, laneBoardColumns, laneSchema,
  lanesShim, laneHookClientVersion, hooksRenderCheck, hooksDistParity, lanePathGuardCheck, depsHooksInstall, depsStoreLink,
  reminderSyncCheck, fleetopsSize,
} from './harness-doctor.mjs';
import { assertScratchUrl } from './coordination/scratch-db.mjs';

// Every folder this file makes. Only these are removed after the file ends, never a prefix match.
const madeTempDirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeTempDirs.push(dir);
  return dir;
};
// A locked folder must not fail a test, so a remove error is dropped.
after(() => {
  for (const dir of madeTempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leave it: a leak is better than a failed test */
    }
  }
});

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

// ---- fake `schtasks /query /tn <name> /xml` output (shape copied from a real run: CRLF doubled, WakeToRun absent when false) ----
/**
 * The Settings and Triggers the doctor compares. Defaults match a task() with no llm/wake: no start on battery, stop on battery,
 * no wake, daily 07:50. `wake: null` leaves the tag out like Windows does for false. `weekday` makes it a weekly trigger.
 * `every` (an ISO interval such as 'PT5M') makes it a repeating TimeTrigger; `duration` adds a Repetition Duration (none: repeats for ever).
 */
const taskXml = ({ disallow = true, stop = true, wake = null, time = '07:50', weekday = null, every = null, duration = null, args = null, command = 'powershell.exe', start = '2026-11-03' } = {}) => [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <Settings>',
  `    <DisallowStartIfOnBatteries>${disallow}</DisallowStartIfOnBatteries>`,
  `    <StopIfGoingOnBatteries>${stop}</StopIfGoingOnBatteries>`,
  ...(wake === null ? [] : [`    <WakeToRun>${wake}</WakeToRun>`]),
  '    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>',
  '    <StartWhenAvailable>true</StartWhenAvailable>',
  '  </Settings>',
  '  <Triggers>',
  ...(every ? [
    '    <TimeTrigger>',
    '      <Repetition>',
    `        <Interval>${every}</Interval>`,
    ...(duration ? [`        <Duration>${duration}</Duration>`] : []),
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${start}T${time}:00-06:00</StartBoundary>`,
    '    </TimeTrigger>',
  ] : [
  '    <CalendarTrigger>',
  `      <StartBoundary>${start}T${time}:00-06:00</StartBoundary>`,
  ...(weekday
    ? ['      <ScheduleByWeek>', '        <WeeksInterval>1</WeeksInterval>', `        <DaysOfWeek><${weekday} /></DaysOfWeek>`, '      </ScheduleByWeek>']
    : ['      <ScheduleByDay>', '        <DaysInterval>1</DaysInterval>', '      </ScheduleByDay>']),
  '    </CalendarTrigger>',
  ]),
  '  </Triggers>',
  ...(args === null ? [] : ['  <Actions Context="Author">', '    <Exec>', `      <Command>${command}</Command>`, `      <Arguments>${args}</Arguments>`, '    </Exec>', '  </Actions>']),
  '</Task>',
].join('\r\r\n');
/** A fake schtasks /xml: name to XML. An unknown name answers like schtasks does. */
const fakeQueryXml = (map) => (name) => (name in map ? { status: 0, stdout: map[name], stderr: '' }
  : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\r\n' });

// ---- the lane assets the five propagation checks read: the shim, the lane hook dists, a template with its live settings, the ratchet baseline ----
const LANE_DISTS = ['lane-context', 'prompt-submit', 'lane-board-republish-reminder', 'lane-board-stop-gate', 'lane-agent-tag', 'session-register'];
const laneHook = (name) => ({ type: 'command', command: 'node', timeout: 5, args: [`{{CLAUDE_HOME}}/hooks/dist/${name}.mjs`] });
const LANE_TEMPLATE = {
  hooks: {
    SessionStart: [{ hooks: [laneHook('lane-context')] }],
    PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [laneHook('lane-agent-tag')] }, { matcher: 'Bash', hooks: [laneHook('not-a-lane-hook')] }],
    PostToolUse: [
      { matcher: 'Bash|PowerShell|Artifact', hooks: [laneHook('lane-board-republish-reminder')] },
      { matcher: 'Edit|Write|Bash|PowerShell|Task|Agent', hooks: [laneHook('lane-context')] },
    ],
    Stop: [{ hooks: [laneHook('lane-board-stop-gate')] }],
  },
};
const claudeHomeOf = (home) => `${home.replace(/\\/g, '/')}/.claude`;
const templateFile = (repo) => join(repo, '.claude', 'settings.json.template');
const liveFile = (home) => join(home, '.claude', 'settings.json');
const CLIENT_BUNDLE = "await c.query(\"SELECT set_config('lane.client_version','2',false)\");\n";
const SHIM_TEXT = "// shim\nawait import('x');\n";
/** Writes a repo and a home that agree on every lane asset. A test breaks one thing. */
function seedLaneAssets(repo, home) {
  put(join(repo, '.claude', 'scripts', 'lane.mjs'), SHIM_TEXT);
  put(join(home, '.claude', 'scripts', 'lane.mjs'), SHIM_TEXT);
  for (const n of LANE_DISTS) {
    const body = `// ${n}\n${n === 'lane-context' || n === 'prompt-submit' ? CLIENT_BUNDLE : ''}`;
    put(join(repo, '.claude', 'hooks', 'dist', `${n}.mjs`), body);
    put(join(home, '.claude', 'hooks', 'dist', `${n}.mjs`), body);
  }
  const text = JSON.stringify(LANE_TEMPLATE, null, 2);
  put(templateFile(repo), text);
  put(liveFile(home), text.replace(/\{\{CLAUDE_HOME\}\}/g, claudeHomeOf(home)));
  put(join(repo, 'scripts', 'coordination', 'lane-path-guard.baseline.json'), JSON.stringify({ total: 0, files: {} }));
}

/**
 * A clean fixture: a git repo on main with a build manifest and passing check scripts, a home whose cursor equals main,
 * a fresh review count, a tasks.json with one healthy fake task, and a blocklist file committed `blocklistDaysAgo` days ago
 * (null: never committed).
 */
function fixture({ blocklistDaysAgo = 0 } = {}) {
  const root = tempDir('hdoc-');
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
  put(join(schtasks, `${TASK_NAME}.xml`), taskXml());
  seedLaneAssets(repo, home);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'init');
  if (blocklistDaysAgo !== null) commitBlocklist(repo, blocklistDaysAgo);
  put(join(home, '.claude', 'state', 'sync-cursor'), `${git(repo, 'rev-parse', 'main')}\n`);
  seedHooksInstall(repo);
  seedStoreLink(repo);
  seedTraceFresh({ repo, home });
  return { root, repo, home, schtasks };
}

/**
 * The shared store link (<repo>/.claude/worktrees/node_modules -> <repo>/.claude/hooks/node_modules), as `shared-deps.mjs --apply` makes it.
 * The link makes .claude/worktrees exist, and lanes:worktree-lane-mjs then needs the primary's lane.mjs to compare with: seed one,
 * as a real primary has it.
 */
function seedStoreLink(repo) {
  put(join(repo, 'scripts', 'coordination', 'lane.mjs'), 'console.log(1);\n');
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  symlinkSync(join(repo, '.claude', 'hooks', 'node_modules'), join(repo, '.claude', 'worktrees', 'node_modules'), 'junction');
}

/** A recent identity-probe row (repo copy) and a recent live trace row: the clean state of hooks:trace-fresh. */
function seedTraceFresh(fx) {
  // The doctor reads the hot program list from the tracer source, as a real repo has it.
  put(join(fx.repo, '.claude', 'hooks', 'src', 'lib', 'trace-boot.ts'), `export const HOT_PROGRAMS: readonly string[] = [
  'destructive-command-guard', 'identity-probe', 'msys-crash-capture',
];
`);
  put(join(fx.repo, '.claude', 'logs', 'identity-probe.jsonl'), jsonl([{ ts: iso(5 * 60000), hook: 'identity-probe' }]));
  writeTrace(fx, [{ ts: iso(5 * 60000), name: 'identity-probe', source: 'live' }]);
}

/** Writes trace rows into the day file of each row's UTC date, under the home cache dir. */
function writeTrace(fx, rows) {
  const byDay = new Map();
  for (const r of rows) byDay.set(r.ts.slice(0, 10), [...(byDay.get(r.ts.slice(0, 10)) ?? []), { event: 'SessionStart', tool: null, startupMs: 30, durationMs: 10, exitCode: 0, code: 0, sessionId: 's', out: 'none', error: null, ...r }]);
  for (const [day, list] of byDay) put(join(fx.home, '.claude', 'cache', `hook-trace-${day}.jsonl`), jsonl(list));
}

/** Removes the store link (the link only, never recursive) so a test can put another state there. */
function dropStoreLink(repo) {
  const link = join(repo, '.claude', 'worktrees', 'node_modules');
  try { rmdirSync(link); } catch { unlinkSync(link); }
}

/**
 * A fake install of .claude/hooks (what `npm ci` leaves): node_modules/.package-lock.json, a stub `pg`, and the two lock
 * files with a typescript version each. Written after the commits, so git never sees it. `pg: false` leaves the stub out.
 */
function seedHooksInstall(repo, { installedTs = '5.9.3', lockTs = '5.9.3', pg = true } = {}) {
  const hooks = join(repo, '.claude', 'hooks');
  put(join(hooks, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/typescript': { version: lockTs } } }));
  put(join(hooks, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/typescript': { version: installedTs } } }));
  if (pg) {
    put(join(hooks, 'node_modules', 'pg', 'package.json'), JSON.stringify({ name: 'pg', main: 'index.js' }));
    put(join(hooks, 'node_modules', 'pg', 'index.js'), 'module.exports = {};\n');
  }
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

function run(fx, extra = [], envExtra = {}) {
  // HARNESS_DOCTOR_SCHTASKS_DIR points the doctor at fake schtasks output, so a test never reads the real Task Scheduler.
  // HARNESS_DOCTOR_NO_DB=1 keeps a test from reading whatever database the shell points at.
  // CCV3_HOOK_TRACE is dropped from the caller env: the doctor reads it (hooks:trace-fresh), so a shell that sets it must not change a test.
  // HARNESS_DOCTOR_EMBED_PRIVATE_MB likewise: the tests without the seam must read a real process.
  const { CCV3_HOOK_TRACE: _callerTrace, HARNESS_DOCTOR_EMBED_PRIVATE_MB: _callerEmbed, ...callerEnv } = process.env;
  const env = { ...callerEnv, HARNESS_DOCTOR_SCHTASKS_DIR: fx.schtasks, HARNESS_DOCTOR_NO_DB: '1', ...envExtra };
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

const ageDir = (dir, hours) => { const t = new Date(Date.now() - hours * HOUR); utimesSync(dir, t, t); };

test('a worktree folder that git does not list and is 24 h old or older is a WARN naming it, its age and the dry-run helper; a listed one is not', () => {
  const fx = fixture();
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'wt-real', join(fx.repo, '.claude', 'worktrees', 'real-one'));
  const orphan = join(fx.repo, '.claude', 'worktrees', 'orphan-one');
  mkdirSync(orphan, { recursive: true });
  ageDir(orphan, 25);
  const r = run(fx);
  assert.equal(r.checks['sync:worktrees'].status, 'WARN');
  assert.match(r.checks['sync:worktrees'].detail, /orphan-one/);
  assert.doesNotMatch(r.checks['sync:worktrees'].detail, /real-one/);
  assert.match(r.checks['sync:worktrees'].detail, /oldest 2[5-6] h/);
  assert.ok(r.checks['sync:worktrees'].detail.includes('node scripts/worktree/orphans.mjs'), r.checks['sync:worktrees'].detail);
});

test('an unlisted worktree folder under 24 h old is not a WARN (a PASS that says info and names it); the oldest orphan sets the age', () => {
  const fx = fixture();
  const wt = join(fx.repo, '.claude', 'worktrees');
  mkdirSync(join(wt, 'fresh-one'), { recursive: true });
  ageDir(join(wt, 'fresh-one'), 23);
  const young = run(fx).checks['sync:worktrees'];
  assert.equal(young.status, 'PASS', young.detail);
  assert.match(young.detail, /^info: /);
  assert.match(young.detail, /fresh-one/);
  mkdirSync(join(wt, 'old-one'), { recursive: true });
  ageDir(join(wt, 'old-one'), 50);
  const mixed = run(fx).checks['sync:worktrees'];
  assert.equal(mixed.status, 'WARN');
  assert.match(mixed.detail, /old-one/);
  assert.doesNotMatch(mixed.detail, /fresh-one/);
  assert.match(mixed.detail, /oldest 5[0-1] h/);
});

test('the shared store link node_modules is never an orphan, even when it is old', () => {
  const fx = fixture();
  const link = join(fx.repo, '.claude', 'worktrees', 'node_modules');
  const t = new Date(Date.now() - 90 * HOUR);
  utimesSync(link, t, t);
  const c = run(fx).checks['sync:worktrees'];
  assert.equal(c.status, 'PASS', c.detail);
  assert.doesNotMatch(c.detail, /node_modules/);
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
test('error rows map 0 to PASS, a repeat of one error to PASS up to 4 rows, and 5 rows to FAIL', () => {
  const expected = [[0, 'PASS'], [1, 'PASS'], [2, 'PASS'], [4, 'PASS'], [5, 'FAIL']];
  for (const [n, status] of expected) {
    const fx = fixture();
    put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl(gate(n)));
    const r = run(fx);
    assert.equal(r.checks['logs:pre-pr-gate-errors'].status, status, `${n} errors`);
  }
});

const gateAt = (n, cwdOf, error = 'spawnSync git ETIMEDOUT') => Array.from({ length: n }, (_, i) => ({ ts: iso(HOUR), hook: 'pre-pr-gate', error, cwd: cwdOf(i) }));

test('a log is a WARN at 3 distinct (hook, message, folder) pairs, not before; the same pair repeated stays below it', () => {
  const same = fixture();
  put(logPath(same, 'pre-pr-gate-errors.jsonl'), jsonl(gateAt(4, () => 'C:\\work\\a')));
  const one = run(same).checks['logs:pre-pr-gate-errors'];
  assert.equal(one.status, 'PASS', one.detail);
  assert.match(one.detail, /1 distinct/);
  const two = fixture();
  put(logPath(two, 'pre-pr-gate-errors.jsonl'), jsonl([...gateAt(1, () => 'C:\\work\\a'), ...gateAt(1, () => 'C:\\work\\b')]));
  assert.equal(run(two).checks['logs:pre-pr-gate-errors'].status, 'PASS', '2 pairs');
  const three = fixture();
  put(logPath(three, 'pre-pr-gate-errors.jsonl'), jsonl(gateAt(3, (i) => `C:\\work\\${i}`)));
  const c = run(three).checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /3 distinct/);
  const msgs = fixture();
  put(logPath(msgs, 'pre-pr-gate-errors.jsonl'), jsonl([...gateAt(1, () => 'C:\\w', 'e1'), ...gateAt(1, () => 'C:\\w', 'e2'), ...gateAt(1, () => 'C:\\w', 'e3')]));
  assert.equal(run(msgs).checks['logs:pre-pr-gate-errors'].status, 'WARN', 'three messages in one folder are three pairs');
});

test('a "directory not found" error whose path no longer exists is labelled benign and does not count; one whose path exists counts', () => {
  const gone = fixture();
  const missing = (i) => join(gone.root, 'no-such-dir', String(i));
  put(logPath(gone, 'pre-pr-gate-errors.jsonl'), jsonl(Array.from({ length: 6 }, (_, i) => ({ ts: iso(HOUR), hook: 'pre-pr-gate', error: `directory not found: ${missing(i)}`, cwd: gone.root }))));
  const benign = run(gone).checks['logs:pre-pr-gate-errors'];
  assert.equal(benign.status, 'PASS', benign.detail);
  assert.match(benign.detail, /6 benign/);
  const real = fixture();
  put(logPath(real, 'pre-pr-gate-errors.jsonl'), jsonl(Array.from({ length: 5 }, () => ({ ts: iso(HOUR), hook: 'pre-pr-gate', error: `directory not found: ${real.repo}`, cwd: real.root }))));
  const c = run(real).checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.doesNotMatch(c.detail, /benign/);
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
  const c = run(fx).checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /^2 error\(s\)/, 'only the two in-window rows count');
});

test('bad JSON lines and lines without a valid ts are skipped and counted', () => {
  const fx = fixture();
  put(logPath(fx, 'pre-pr-gate-errors.jsonl'), jsonl(['{not json', '', { error: 'no ts' }, { ts: 'yesterday-ish', error: 'bad ts' }, ...gate(1)]));
  const c = run(fx).checks['logs:pre-pr-gate-errors'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^1 error\(s\)/);
  assert.match(c.detail, /3 unparsable/);
});

test('guard-decisions counts only lines with kind error', () => {
  const fx = fixture();
  const other = Array.from({ length: 8 }, () => ({ ts: iso(HOUR), kind: 'deny', reason: 'blocked' }));
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([...other, { ts: iso(HOUR), kind: 'error', reason: 'guard crashed' }]));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^1 error\(s\)/, 'only the kind error line counts');
  assert.match(c.detail, /guard crashed/);
});

const crash = (n, hook, message, extra = {}) => Array.from({ length: n }, () => ({ ts: iso(HOUR), hook, kind: 'error', message, ...extra }));

test('guard-decisions ignores error rows tagged test or probe, and says how many', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([...crash(6, 'decision-gate', 'spawnSync git ENOENT', { source: 'probe' }), ...crash(2, 'decision-gate', 'x', { source: 'test' })]));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /^0 error\(s\)/);
  assert.match(c.detail, /8 ignored \(source is test or probe/);
});

test('guard-decisions counts a row with source live and a row with no source', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([...crash(3, 'decision-gate', 'boom', { source: 'live' }), ...crash(2, 'decision-gate', 'boom')]));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /^5 error\(s\)/);
});

test('guard-decisions counts a row with an unknown source: only test and probe are ignored', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl(crash(5, 'decision-gate', 'boom', { source: 'ci-run' })));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /^5 error\(s\)/);
});

test('guard-decisions groups by hook and message: 5 rows of one group make one entry with x5 and the hook name', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl(crash(5, 'decision-gate', 'spawnSync git ENOENT')));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /top: "decision-gate: spawnSync git ENOENT" x5/);
  assert.equal(c.detail.split('spawnSync git ENOENT').length - 1, 1, 'the group is named once');
});

test('guard-decisions keeps the same message from two hooks apart', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([...crash(2, 'decision-gate', 'boom'), ...crash(2, 'pre-pr-gate', 'boom')]));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.match(c.detail, /2 distinct/, c.detail);
  assert.match(c.detail, /x2/);
});

test('guard-decisions: 5 different live errors still FAIL', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl(['a', 'b', 'c', 'd', 'e'].flatMap((m) => crash(1, 'decision-gate', `err ${m}`))));
  const c = run(fx).checks['logs:guard-decisions'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /^5 error\(s\)/);
  assert.equal(run(fx).code, 1);
});

test('hooks.log counts level error lines and ignores info lines', () => {
  const fx = fixture();
  const info = Array.from({ length: 8 }, () => ({ ts: iso(HOUR), level: 'info', hook: 'x', msg: 'fine' }));
  put(logPath(fx, 'hooks.log'), jsonl([...info, { ts: iso(HOUR), level: 'error', hook: 'atomic-write', msg: 'write failed' }]));
  const c = run(fx).checks['logs:hooks.log'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^1 error\(s\)/, 'only the level error line counts');
  assert.match(c.detail, /write failed/);
});

test('memory-write-failures is read from the state dir', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', 'state', 'memory-write-failures.jsonl'), jsonl([{ ts: iso(HOUR), source: 'store_learning', error: 'missing metadata.source' }]));
  const c = run(fx).checks['logs:memory-write-failures'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^1 error\(s\)/);
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
  const repo = tempDir('hdoc-sched-');
  if (tasksJson !== undefined) put(join(repo, 'scripts', 'scheduled', 'tasks.json'), typeof tasksJson === 'string' ? tasksJson : JSON.stringify(tasksJson));
  return { repo };
};
// The XML query defaults to a task that matches task() exactly, so a test of the last result never reads the real Task Scheduler.
const sched = (tasks, map, extra = {}) => scheduleChecks(schedRepo({ tasks }), { platform: 'win32', query: fakeQuery(map), queryXml: fakeQueryXml({ [TASK_NAME]: taskXml() }), ...extra });
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

test('a last result in warnExit is a WARN naming the result; a warnExit that is not an integer array is a WARN on the entry', () => {
  const warn = only(sched([task({ warnExit: [10] })], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '10' }) }));
  assert.equal(warn.status, 'WARN');
  assert.match(warn.detail, /\b10\b.*warnExit/);
  const fail = only(sched([task({ warnExit: [10] })], { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '1' }) }));
  assert.equal(fail.status, 'FAIL');
  const bad = only(sched([task({ warnExit: 10 })], { [TASK_NAME]: taskCsv(TASK_NAME) }));
  assert.equal(bad.status, 'WARN');
  assert.match(bad.detail, /warnExit/);
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

// Real data of 2026-11-07 (Saturday): both RuleRouter tasks never ran. Audit: weekly Monday 09:07, start boundary 2026-11-03 (a Tuesday).
// Review: weekly Monday 09:20, start boundary 2026-11-05 (a Thursday). The first Monday fire after each boundary is 2026-11-09.
const NEVER_RAN = { 'Last Run Time': 'N/A', 'Last Result': '267011' };
const localMs = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const neverRan = (t, xml, now) => only(sched([t], { [TASK_NAME]: taskCsv(TASK_NAME, NEVER_RAN) }, { queryXml: fakeQueryXml({ [TASK_NAME]: xml }), now }));
const auditTask = task({ trigger: 'weekly Monday 09:07' });
const auditXml = taskXml({ weekday: 'Monday', time: '09:07', start: '2026-11-03' });
const reviewTask = task({ trigger: 'weekly Monday 09:20' });
const reviewXml = taskXml({ weekday: 'Monday', time: '09:20', start: '2026-11-05' });

test('a weekly task that never ran is info (a PASS) until its first scheduled time has passed: the two RuleRouter tasks on Saturday 2026-11-07', () => {
  const sat = localMs(2026, 11, 7, 12, 0);
  for (const [t, xml, first] of [[auditTask, auditXml, '2026-11-09 09:07'], [reviewTask, reviewXml, '2026-11-09 09:20']]) {
    const c = neverRan(t, xml, sat);
    assert.equal(c.status, 'PASS', c.detail);
    assert.match(c.detail, /^info: /);
    assert.match(c.detail, /not due yet/);
    assert.ok(c.detail.includes(first), c.detail);
  }
});

test('a weekly task that never ran is a WARN once the first Monday fire has passed, and not a minute before', () => {
  assert.equal(neverRan(auditTask, auditXml, localMs(2026, 11, 9, 9, 6)).status, 'PASS', 'one minute before 09:07');
  const after = neverRan(auditTask, auditXml, localMs(2026, 11, 9, 9, 8));
  assert.equal(after.status, 'WARN', after.detail);
  assert.match(after.detail, /never ran/);
  assert.equal(neverRan(reviewTask, reviewXml, localMs(2026, 11, 9, 9, 19)).status, 'PASS');
  assert.equal(neverRan(reviewTask, reviewXml, localMs(2026, 11, 9, 9, 21)).status, 'WARN');
  assert.equal(neverRan(auditTask, auditXml, localMs(2026, 11, 12, 12, 0)).status, 'WARN', 'later in the week');
});

test('a task that never ran with a daily or repeating trigger, or one with no readable XML, is judged from its start boundary (or stays a WARN)', () => {
  const daily = taskXml({ time: '07:50', start: '2026-11-10' });
  assert.equal(neverRan(task(), daily, localMs(2026, 11, 7, 12, 0)).status, 'PASS', 'start boundary in the future');
  assert.equal(neverRan(task(), daily, localMs(2026, 11, 10, 7, 51)).status, 'WARN', 'start boundary passed');
  const every = taskXml({ every: 'PT5M', time: '07:50', start: '2026-11-10' });
  assert.equal(neverRan(task({ trigger: 'every 5m' }), every, localMs(2026, 11, 7, 12, 0)).status, 'PASS');
  const noXml = only(sched([task()], { [TASK_NAME]: taskCsv(TASK_NAME, NEVER_RAN) }, { queryXml: null, now: localMs(2026, 11, 7, 12, 0) }));
  assert.equal(noXml.status, 'WARN', 'without the XML the doctor cannot tell, so it warns as before');
  assert.equal(neverRan(task(), 'not xml at all', localMs(2026, 11, 7, 12, 0)).status, 'WARN');
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

// ---- schedule:readme-tasks (the README must name only tasks that tasks.json lists) ----
const readmeOf = (fx) => join(fx.repo, 'docs', 'harness-strategy', 'README.md');
const READMEcheck = 'schedule:readme-tasks';

test('a README that names a CCv3 task missing from tasks.json is a FAIL naming the token, the line and the README, and exits 1', () => {
  const fx = fixture();
  put(readmeOf(fx), 'Intro line.\nThe `CCv3-Claude-Snapshot` task runs daily.\n');
  const r = run(fx);
  const c = r.checks[READMEcheck];
  assert.equal(c.status, 'FAIL', r.stdout);
  assert.match(c.detail, /CCv3-Claude-Snapshot/);
  assert.match(c.detail, /line 2\)/);
  assert.ok(c.detail.includes(readmeOf(fx)), c.detail);
  assert.equal(r.code, 1);
});

test('a README that names only tasks in tasks.json is a PASS that reports the count', () => {
  const fx = fixture();
  put(readmeOf(fx), `The \`${TASK_NAME}\` task runs daily. It is the same \`${TASK_NAME}\`.\n`);
  const r = run(fx);
  assert.equal(r.checks[READMEcheck].status, 'PASS', r.checks[READMEcheck].detail);
  assert.match(r.checks[READMEcheck].detail, /^2 task name\(s\)/);
  assert.equal(r.code, 0, r.stdout);
});

test('a task name that is only a prefix of a real task is still a FAIL (positive control)', () => {
  const fx = fixture();
  put(readmeOf(fx), 'The CCv3-Fake task runs daily.\n');
  const c = run(fx).checks[READMEcheck];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /CCv3-Fake \(line 1\)/);
  put(readmeOf(fx), `The ${TASK_NAME}-2 task runs daily.\n`);
  assert.equal(run(fx).checks[READMEcheck].status, 'FAIL');
  put(readmeOf(fx), `The ${TASK_NAME}_v2 task runs daily.\n`);
  assert.equal(run(fx).checks[READMEcheck].status, 'FAIL', 'an underscore suffix is part of the name');
});

test('words that only look like task names are no false hit: CCv3-1, bare CCv3, Lane-Snapshot, a retired name without the prefix', () => {
  const fx = fixture();
  put(readmeOf(fx), 'See CCv3-1 and CCv3. The Lane-Snapshot and Reminder-Tick tasks are real. The Claude snapshot task is retired.\n');
  const c = run(fx).checks[READMEcheck];
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /^0 task name/);
});

test('a task name that differs only in case is still the listed task (schtasks ignores case)', () => {
  const fx = fixture();
  put(readmeOf(fx), `The ${TASK_NAME.toLowerCase()} task runs daily.\n`);
  const c = run(fx).checks[READMEcheck];
  assert.equal(c.status, 'PASS', c.detail);
});

test('no README is a PASS (absent), not a crash', () => {
  const c = run(fixture()).checks[READMEcheck];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /absent/);
});

test('a tasks.json that is not JSON makes the README check a WARN, never a PASS', () => {
  const fx = fixture();
  put(readmeOf(fx), `The ${TASK_NAME} task runs daily.\n`);
  put(join(fx.repo, 'scripts', 'scheduled', 'tasks.json'), '{nope');
  const c = run(fx).checks[READMEcheck];
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /tasks\.json/);
});

// ---- schedule: registration drift (task XML vs tasks.json llm / wake / trigger) ----
const csvOk = { [TASK_NAME]: taskCsv(TASK_NAME) };
const driftOf = (t, xml, map = csvOk) => only(sched([t], map, { queryXml: fakeQueryXml({ [TASK_NAME]: xml }) }));

test('drift: llm=true but the task still does not start on battery is a WARN naming battery', () => {
  const c = driftOf(task({ llm: true }), taskXml({ disallow: true, stop: false }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /battery/);
});

test('drift: llm=true but the task stops when the laptop goes on battery is a WARN naming battery', () => {
  const c = driftOf(task({ llm: true }), taskXml({ disallow: false, stop: true }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /battery/);
});

test('drift: wake=true but WakeToRun is absent (Windows leaves the tag out for false) is a WARN naming wake', () => {
  const c = driftOf(task({ llm: true, wake: true }), taskXml({ disallow: false, stop: false, wake: null }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /wake/);
});

test('drift: wake=false but WakeToRun is true is a WARN naming wake', () => {
  const c = driftOf(task(), taskXml({ wake: true }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /wake/);
});

test('drift: a trigger time or kind that differs from tasks.json is a WARN naming trigger', () => {
  const time = driftOf(task({ trigger: 'daily 09:00' }), taskXml({ time: '07:50' }));
  assert.equal(time.status, 'WARN', time.detail);
  assert.match(time.detail, /trigger/);
  const kind = driftOf(task({ trigger: 'weekly Monday 07:50' }), taskXml({ time: '07:50' }));
  assert.equal(kind.status, 'WARN', kind.detail);
  assert.match(kind.detail, /trigger/);
  const day = driftOf(task({ trigger: 'weekly Monday 09:20' }), taskXml({ time: '09:20', weekday: 'Tuesday' }));
  assert.equal(day.status, 'WARN', day.detail);
  assert.match(day.detail, /trigger/);
});

test('drift: a task that matches tasks.json on battery, wake and trigger is a PASS (daily and weekly, llm and not)', () => {
  const cases = [
    [task(), taskXml()],
    [task({ llm: false, wake: false }), taskXml({ disallow: true, stop: true, wake: false })],
    [task({ llm: true }), taskXml({ disallow: false, stop: false })],
    [task({ llm: true, wake: true }), taskXml({ disallow: false, stop: false, wake: true })],
    [task({ trigger: 'weekly Monday 09:20', llm: true }), taskXml({ disallow: false, stop: false, time: '09:20', weekday: 'Monday' })],
  ];
  for (const [t, xml] of cases) assert.equal(driftOf(t, xml).status, 'PASS', JSON.stringify(t));
});

test('drift: battery:true with llm false on an every-5-minutes task matches an XML that allows battery and repeats every PT5M (PASS)', () => {
  const t = task({ trigger: 'every 5m', llm: false, battery: true });
  assert.equal(driftOf(t, taskXml({ disallow: false, stop: false, every: 'PT5M' })).status, 'PASS');
  assert.equal(driftOf(task({ trigger: 'every 60m', battery: true }), taskXml({ disallow: false, stop: false, every: 'PT1H' })).status, 'PASS', 'PT1H is every 60m');
  assert.equal(driftOf(t, taskXml({ disallow: false, stop: false, every: 'PT5M', duration: 'P1D' })).status, 'PASS', 'a one-day repetition is accepted');
});

test('drift: an every-5-minutes task whose XML repeats every PT15M is a WARN naming trigger', () => {
  const c = driftOf(task({ trigger: 'every 5m', battery: true }), taskXml({ disallow: false, stop: false, every: 'PT15M' }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /trigger/);
});

test('drift: an every-5-minutes task whose XML is a daily trigger is a WARN naming trigger', () => {
  const c = driftOf(task({ trigger: 'every 5m', battery: true }), taskXml({ disallow: false, stop: false }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /trigger/);
});

test('drift: battery:true but the XML still blocks start and stops on battery is a WARN naming battery and the field', () => {
  const c = driftOf(task({ trigger: 'every 5m', battery: true }), taskXml({ disallow: true, stop: true, every: 'PT5M' }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /battery/);
  assert.match(c.detail, /battery=true/);
});

test('drift: a repetition that stops after under one day (Duration PT1H) is a WARN naming trigger', () => {
  const c = driftOf(task({ trigger: 'every 5m', battery: true }), taskXml({ disallow: false, stop: false, every: 'PT5M', duration: 'PT1H' }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /trigger/);
  assert.match(c.detail, /PT1H/);
});

const PS_ARGS = '-NoProfile -ExecutionPolicy Bypass -File &quot;C:\\x\\t.ps1&quot;';
const PS_ARGS_OLD = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;C:\\x\\t.ps1&quot;';
const CONHOST = 'C:\\Windows\\System32\\conhost.exe';
const HEADLESS_ARGS = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File &quot;C:\\x\\t.ps1&quot;';
const hiddenTask = (over = {}) => task({ trigger: 'every 5m', battery: true, hidden: true, ...over });
const hiddenXml = (args, command = 'powershell.exe') => taskXml({ disallow: false, stop: false, every: 'PT5M', args, command });

test('hidden:true and the registered action is the plain powershell form is a WARN naming hidden', () => {
  const c = driftOf(hiddenTask(), hiddenXml(PS_ARGS));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /hidden/);
});

test('hidden:true and the registered action is the old -WindowStyle Hidden powershell form is a WARN naming hidden', () => {
  const c = driftOf(hiddenTask(), hiddenXml(PS_ARGS_OLD));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /hidden/);
});

test('hidden:true and the registered action is conhost.exe --headless powershell.exe is a PASS', () => {
  assert.equal(driftOf(hiddenTask(), hiddenXml(HEADLESS_ARGS, CONHOST)).status, 'PASS');
});

test('hidden:true and conhost.exe without --headless first is a WARN naming hidden and --headless', () => {
  const noFlag = driftOf(hiddenTask(), hiddenXml(PS_ARGS, CONHOST));
  assert.equal(noFlag.status, 'WARN', noFlag.detail);
  assert.match(noFlag.detail, /hidden/);
  assert.match(noFlag.detail, /--headless/);
  const late = driftOf(hiddenTask(), hiddenXml('powershell.exe --headless -NoProfile', CONHOST));
  assert.equal(late.status, 'WARN', late.detail);
});

test('hidden not set but the registered action is conhost --headless is a WARN; no Arguments in the XML is not judged', () => {
  const c = driftOf(task({ trigger: 'every 5m', battery: true }), hiddenXml(HEADLESS_ARGS, CONHOST));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /hidden/);
  assert.equal(driftOf(hiddenTask(), hiddenXml(null)).status, 'PASS', 'an XML with no action block is not compared');
});

test('hidden not set and the registered action is the plain powershell form is a PASS', () => {
  assert.equal(driftOf(task({ trigger: 'every 5m', battery: true }), hiddenXml(PS_ARGS)).status, 'PASS');
});

test('F15: a tasks.json entry with hidden that is not true or false is a WARN on its own row', () => {
  const c = only(sched([task({ hidden: 'yes' })], csvOk));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /hidden is not true or false/);
});

// ---- F8: the Notion sync of the reminder tick must be visible when it keeps failing ----
// The sync switch is the file ~/.claude/state/reminders/sync-enabled. The helper turns it on unless told not to.
const reminderHome = (state, { syncOn = true } = {}) => {
  const home = tempDir('rem-home-');
  if (syncOn) put(join(home, '.claude', 'state', 'reminders', 'sync-enabled'), 'on');
  if (state !== undefined) put(join(home, '.claude', 'state', 'reminders', 'latest.json'), typeof state === 'string' ? state : JSON.stringify(state));
  return { home };
};

test('F8: reminderSyncCheck is a PASS with no heartbeat, a healthy one, or a sync that has not run', () => {
  assert.equal(reminderSyncCheck(reminderHome()).status, 'PASS');
  assert.equal(reminderSyncCheck(reminderHome({ lastSyncOk: true, failCount: 0, ranAt: iso(1000) })).status, 'PASS');
  assert.equal(reminderSyncCheck(reminderHome({ lastSyncOk: null, failCount: 0 })).status, 'PASS');
});

test('F8: reminderSyncCheck WARNs when the last sync failed, naming the error and the time, and when failCount is 3 or more', () => {
  const ranAt = '2026-11-07T15:00:00.000Z';
  const failed = reminderSyncCheck(reminderHome({ lastSyncOk: false, failCount: 1, lastError: 'headless daily cap reached', ranAt }));
  assert.equal(failed.status, 'WARN', failed.detail);
  assert.match(failed.detail, /headless daily cap reached/);
  assert.match(failed.detail, /2026-11-07T15:00:00/);
  const stuck = reminderSyncCheck(reminderHome({ lastSyncOk: true, failCount: 3, ranAt }));
  assert.equal(stuck.status, 'WARN', stuck.detail);
  assert.match(stuck.detail, /3/);
  assert.equal(reminderSyncCheck(reminderHome('{broken')).status, 'WARN');
});

test('sync switch: with the sync off the check is a PASS that says "sync off", whatever the heartbeat holds', () => {
  const failing = { lastSyncOk: false, failCount: 5, lastError: 'old failure', ranAt: iso(1000) };
  for (const state of [undefined, failing, '{broken']) {
    const c = reminderSyncCheck(reminderHome(state, { syncOn: false }));
    assert.equal(c.status, 'PASS', c.detail);
    assert.match(c.detail, /sync off/);
  }
  assert.equal(reminderSyncCheck(reminderHome(failing)).status, 'WARN', 'the same heartbeat WARNs once the sync is on');
});

test('F8: the doctor run carries the reminder sync row in the schedule section', () => {
  const { home } = reminderHome({ lastSyncOk: false, failCount: 4, lastError: 'x', ranAt: iso(1000) });
  const c = reminderSyncCheck({ home });
  assert.equal(c.section, 'schedule');
  assert.equal(c.check, 'reminder-sync');
});

test('drift: battery false with llm false still wants battery blocked, so the old tasks do not drift', () => {
  assert.equal(driftOf(task({ battery: false }), taskXml()).status, 'PASS');
  const c = driftOf(task({ battery: false }), taskXml({ disallow: false, stop: false }));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /battery/);
});

test('a tasks.json entry with battery that is not true or false is a WARN on its own row', () => {
  const c = only(sched([task({ battery: 'yes' })], csvOk));
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /battery is not true or false/);
});

test('drift: a bad last result stays a FAIL and a stale task stays a WARN, and both still name the drift', () => {
  const drifted = taskXml({ disallow: true, stop: false });
  const fail = driftOf(task({ llm: true }), drifted, { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Result': '1' }) });
  assert.equal(fail.status, 'FAIL');
  assert.match(fail.detail, /battery/);
  const stale = driftOf(task({ llm: true }), drifted, { [TASK_NAME]: taskCsv(TASK_NAME, { 'Last Run Time': usTime(49 * HOUR) }) });
  assert.equal(stale.status, 'WARN');
  assert.match(stale.detail, /battery/);
  assert.match(stale.detail, /48/);
});

test('drift: task XML that cannot be read or has no Settings is a WARN, never a PASS', () => {
  const missing = only(sched([task()], csvOk, { queryXml: fakeQueryXml({}) }));
  assert.equal(missing.status, 'WARN', missing.detail);
  assert.match(missing.detail, /xml/i);
  const garbage = driftOf(task(), 'not xml at all');
  assert.equal(garbage.status, 'WARN', garbage.detail);
  const broken = only(sched([task()], csvOk, { queryXml: () => ({ error: 'spawn schtasks ENOENT' }) }));
  assert.equal(broken.status, 'WARN');
  assert.match(broken.detail, /ENOENT/);
});

test('drift: an llm or wake that is not true/false in tasks.json is a WARN naming the field; no XML query runs for it', () => {
  let calls = 0;
  const queryXml = () => { calls++; return { status: 0, stdout: taskXml(), stderr: '' }; };
  for (const [field, value] of [['llm', 'yes'], ['wake', 1]]) {
    const c = only(sched([task({ [field]: value })], csvOk, { queryXml }));
    assert.equal(c.status, 'WARN');
    assert.match(c.detail, new RegExp(field));
  }
  assert.equal(calls, 0);
});

test('end to end: a task registered with the wrong battery and wake settings is a WARN on its own row and exits 0', () => {
  const fx = fixture();
  put(join(fx.repo, 'scripts', 'scheduled', 'tasks.json'), JSON.stringify({ tasks: [task({ llm: true, wake: true })] }));
  put(join(fx.schtasks, `${TASK_NAME}.xml`), taskXml({ disallow: true, stop: true, wake: null }));
  const r = run(fx);
  const c = r.checks[`schedule:${TASK_NAME}`];
  assert.equal(c.status, 'WARN', r.stdout);
  assert.match(c.detail, /battery/);
  assert.match(c.detail, /wake/);
  assert.equal(r.code, 0, 'drift must not fail the doctor');
  put(join(fx.schtasks, `${TASK_NAME}.xml`), taskXml({ disallow: false, stop: false, wake: true }));
  assert.equal(run(fx).checks[`schedule:${TASK_NAME}`].status, 'PASS');
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

// ---- registry and lanes ----
const writeRegistry = (fx, projects) => put(join(fx.home, '.claude', 'project-registry.json'), JSON.stringify({ version: '1.0', projects }));
const entry = (key, path, status = 'active') => ({ name: key, key, path, status });
const fwd = (p) => p.replace(/\\/g, '/');
const goneDir = (fx, name) => fwd(join(fx.root, 'no-such-folder', name));
const HERE_TEST = dirname(fileURLToPath(import.meta.url));

test('registry:roots-exist is a FAIL naming each active entry whose path is missing, and exits 1', () => {
  const fx = fixture();
  const real = join(fx.root, 'real');
  mkdirSync(real);
  writeRegistry(fx, [entry('here', fwd(real)), entry('gone-one', goneDir(fx, 'one')), entry('gone-two', goneDir(fx, 'two'))]);
  const r = run(fx);
  const c = r.checks['registry:roots-exist'];
  assert.equal(c.status, 'FAIL', r.stdout);
  assert.match(c.detail, /2 non-inactive registry root\(s\) missing/);
  assert.ok(c.detail.includes('gone-one (') && c.detail.includes('gone-two ('), c.detail);
  assert.ok(!c.detail.includes('here ('), 'an existing root must not be named');
  assert.ok(c.detail.includes(join(fx.home, '.claude', 'project-registry.json')), 'the detail names the registry file');
  assert.equal(r.code, 1);
});

test('registry:roots-exist ignores an inactive entry and counts in-development as active', () => {
  const fx = fixture();
  const real = join(fx.root, 'real');
  mkdirSync(real);
  writeRegistry(fx, [entry('here', fwd(real)), entry('old', goneDir(fx, 'old'), 'inactive')]);
  assert.equal(run(fx).checks['registry:roots-exist'].status, 'PASS');
  writeRegistry(fx, [entry('here', fwd(real)), entry('dev', goneDir(fx, 'dev'), 'in-development')]);
  const c = run(fx).checks['registry:roots-exist'];
  assert.equal(c.status, 'FAIL');
  assert.ok(c.detail.includes('dev ('), c.detail);
});

test('registry:roots-exist is a PASS that says absent without a registry file, and a WARN for one that is not JSON', () => {
  const fx = fixture();
  const c = run(fx).checks['registry:roots-exist'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^absent: /);
  put(join(fx.home, '.claude', 'project-registry.json'), '{ not json');
  const bad = run(fx).checks['registry:roots-exist'];
  assert.equal(bad.status, 'WARN');
  assert.match(bad.detail, /not valid JSON/);
});

// registry:mirror-drift. CodeRabbit PR 297: a stale home mirror gives a nested app the wrong lane board. Each test breaks one thing
// and reads this one line; each fails if the check stops comparing that field or stops reading the repo copy.
const writeRepoRegistry = (fx, projects) => put(join(fx.repo, '.claude', 'project-registry.json'), JSON.stringify({ version: '1.0', projects }));
const board = (key, path, laneBoard, status = 'active') => ({ ...entry(key, path, status), ...(laneBoard ? { laneBoard } : {}) });

test('registry:mirror-drift is a FAIL naming the key when the home mirror lacks a laneBoard the repo copy has, and exits 1', () => {
  const fx = fixture();
  const real = fwd(join(fx.root, 'real'));
  mkdirSync(real);
  writeRepoRegistry(fx, [board('main', real, 'main'), board('nested', real + '/apps/nested', 'main')]);
  writeRegistry(fx, [board('main', real, 'main'), board('nested', real + '/apps/nested')]);
  const r = run(fx);
  const c = r.checks['registry:mirror-drift'];
  assert.equal(c.status, 'FAIL', r.stdout);
  assert.ok(c.detail.includes('nested: board repo=main mirror=nested'), c.detail);
  assert.ok(!c.detail.includes('main: '), 'a matching key is not named');
  assert.match(c.detail, /sync-to-active/);
  assert.equal(r.code, 1);
});

test('registry:mirror-drift is a FAIL for a status change and for a key in only one copy', () => {
  const fx = fixture();
  const real = fwd(join(fx.root, 'real'));
  mkdirSync(real);
  writeRepoRegistry(fx, [board('dead', real, null, 'inactive'), board('fresh', real)]);
  writeRegistry(fx, [board('dead', real), board('stale-only', real)]);
  const c = run(fx).checks['registry:mirror-drift'];
  assert.equal(c.status, 'FAIL');
  assert.ok(c.detail.includes('dead: status repo=inactive mirror=active'), c.detail);
  assert.ok(c.detail.includes('fresh: only in the repo copy') && c.detail.includes('stale-only: only in the mirror'), c.detail);
});

test('registry:mirror-drift is a PASS when the board fields agree, even if a path is spelled differently or notes differ', () => {
  const fx = fixture();
  const real = fwd(join(fx.root, 'real'));
  mkdirSync(real);
  writeRepoRegistry(fx, [board('main', real, 'main')]);
  writeRegistry(fx, [{ ...board('main', real.toUpperCase().replace(/\//g, '\\'), 'main'), notes: 'mirror only' }]);
  const c = run(fx).checks['registry:mirror-drift'];
  assert.equal(c.status, 'PASS', c.detail);
});

test('registry:mirror-drift is a PASS that says absent when a copy is missing, and a WARN when one is not JSON', () => {
  const fx = fixture();
  const real = fwd(join(fx.root, 'real'));
  mkdirSync(real);
  const none = run(fx).checks['registry:mirror-drift'];
  assert.equal(none.status, 'PASS');
  assert.match(none.detail, /^absent: /);
  writeRepoRegistry(fx, [board('main', real, 'main')]);
  assert.match(run(fx).checks['registry:mirror-drift'].detail, /^absent: /, 'the home mirror is missing: roots-exist reports that');
  writeRegistry(fx, [board('main', real, 'main')]);
  put(join(fx.repo, '.claude', 'project-registry.json'), '{ not json');
  const bad = run(fx).checks['registry:mirror-drift'];
  assert.equal(bad.status, 'WARN');
  assert.match(bad.detail, /not valid JSON/);
});

test('registry:project-rows: a missing row and a different root are WARNs naming the key; the same root in another spelling is a PASS', () => {
  const fx = fixture();
  const dir = fwd(join(fx.root, 'Proj Dir'));
  mkdirSync(dir);
  writeRegistry(fx, [entry('same', dir), entry('moved', dir), entry('nowhere', dir), entry('old', dir, 'inactive')]);
  const o = { home: fx.home };
  const same = { key: 'same', root_path: dir.toUpperCase().replace(/\//g, '\\'), status: 'active' }; // capitals and backslashes: one root once folded
  const moved = { key: 'moved', root_path: 'c:/somewhere/else', status: 'active' };
  const c = registryProjectRows(o, { facts: { columns: 2, projects: [same, moved] } });
  assert.equal(c.status, 'WARN');
  assert.match(c.detail, /2 registry key\(s\) differ/);
  assert.ok(c.detail.includes('moved: row has c:/somewhere/else'), c.detail);
  assert.ok(c.detail.includes('nowhere: no project row'), c.detail);
  assert.ok(!c.detail.includes('same:') && !c.detail.includes('old:'), 'a matching key and an inactive key are not drift');
  const ok = registryProjectRows(o, { facts: { columns: 2, projects: [same, { ...same, key: 'moved' }, { ...same, key: 'nowhere' }] } });
  assert.equal(ok.status, 'PASS', ok.detail);
});

test('registry:project-rows and lanes:board-columns: skipped, no URL and an unreadable database', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('a', fwd(fx.root))]);
  const o = { home: fx.home };
  assert.equal(registryProjectRows(o, { facts: { skipped: true } }).status, 'PASS');
  assert.equal(laneBoardColumns(o, { facts: { skipped: true } }).status, 'PASS');
  for (const facts of [{ noUrl: true }, { error: 'connect ECONNREFUSED' }]) {
    assert.equal(registryProjectRows(o, { facts }).status, 'WARN');
    assert.equal(laneBoardColumns(o, { facts }).status, 'WARN');
  }
  assert.match(laneBoardColumns(o, { facts: { error: 'connect ECONNREFUSED' } }).detail, /ECONNREFUSED/);
  assert.equal(registryProjectRows(o, { facts: { columns: 2, projectsError: 'relation does not exist' } }).status, 'WARN');
});

test('lanes:board-columns: both columns PASS, none is a WARN that never fails the doctor, one of two is a FAIL', () => {
  assert.equal(laneBoardColumns({}, { facts: { columns: 2 } }).status, 'PASS');
  const none = laneBoardColumns({}, { facts: { columns: 0 } });
  assert.equal(none.status, 'WARN');
  assert.match(none.detail, /migration 0004 not applied/);
  const half = laneBoardColumns({}, { facts: { columns: 1 } });
  assert.equal(half.status, 'FAIL');
  assert.match(half.detail, /half applied/);
});

test('end to end: with no database URL in the environment the two database checks are WARNs, not a crash and not a PASS', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('a', fwd(fx.root))]);
  const r = run(fx, [], { HARNESS_DOCTOR_NO_DB: '', CONTINUOUS_CLAUDE_DB_URL: '', DATABASE_URL: '', OPC_POSTGRES_URL: '' });
  assert.equal(r.checks['lanes:schema'].status, 'WARN', r.stdout);
  assert.match(r.checks['lanes:schema'].detail, /no database URL/);
  assert.equal(r.checks['lanes:board-columns'].status, 'WARN', r.stdout);
  assert.match(r.checks['lanes:board-columns'].detail, /no database URL/);
  assert.equal(r.checks['registry:project-rows'].status, 'WARN');
  assert.equal(r.code, 0, 'a WARN never exits 1');
});

const TAGS4 = ['0000_a', '0001_b', '0002_c', '0003_d'];
const TAGS5 = [...TAGS4, '0004_per_project_lanes'];
const journal = (tags) => ({ tags });

test('lanes:schema: skipped is a PASS; no URL, an unreachable database, a missing journal and a missing table are WARNs, never FAILs', () => {
  assert.equal(laneSchema({}, { facts: { skipped: true } }).status, 'PASS');
  assert.equal(laneSchema({}, { facts: { noUrl: true } }).status, 'WARN');
  const down = laneSchema({}, { facts: { error: 'connect ECONNREFUSED' } });
  assert.equal(down.status, 'WARN');
  assert.match(down.detail, /ECONNREFUSED/);
  const noJournal = laneSchema({ repo: join(tmpdir(), 'hdoc-no-such-repo') }, { facts: { columns: 2, migrations: 5, trigger: 1 } });
  assert.equal(noJournal.status, 'WARN');
  assert.match(noJournal.detail, /_journal\.json/);
  const noTable = laneSchema({}, { facts: { migrationsError: 'agentic_os.__migrations does not exist' }, journal: journal(TAGS5) });
  assert.equal(noTable.status, 'WARN');
  assert.match(noTable.detail, /__migrations/);
});

test('lanes:schema: equal with the trigger is a PASS; behind by exactly 0004 is a WARN that says so; behind by more is a FAIL', () => {
  const ok = laneSchema({}, { facts: { migrations: 5, trigger: 1 }, journal: journal(TAGS5) });
  assert.equal(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /5 of 5/);
  const just0004 = laneSchema({}, { facts: { migrations: 4, trigger: 0 }, journal: journal(TAGS5) });
  assert.equal(just0004.status, 'WARN');
  assert.match(just0004.detail, /migration 0004 not applied/);
  const more = laneSchema({}, { facts: { migrations: 3, trigger: 0 }, journal: journal(TAGS5) });
  assert.equal(more.status, 'FAIL');
  assert.match(more.detail, /3 migrations applied, the journal lists 5/);
  const otherGap = laneSchema({}, { facts: { migrations: 5, trigger: 1 }, journal: journal([...TAGS5, '0005_next']) });
  assert.equal(otherGap.status, 'FAIL', 'a gap of one that is not 0004 is a FAIL');
});

test('lanes:schema: the trigger is required once the journal lists 0004; without 0004 in the journal it is not', () => {
  const gone = laneSchema({}, { facts: { migrations: 5, trigger: 0 }, journal: journal(TAGS5) });
  assert.equal(gone.status, 'FAIL');
  assert.match(gone.detail, /lane_guard_foreign_board/);
  const main = laneSchema({}, { facts: { migrations: 4, trigger: 0 }, journal: journal(TAGS4) });
  assert.equal(main.status, 'PASS', main.detail);
  const ahead = laneSchema({}, { facts: { migrations: 5, trigger: 1 }, journal: journal(TAGS4) });
  assert.equal(ahead.status, 'WARN');
  assert.match(ahead.detail, /behind the database/);
});

test('lanes:schema end to end against scratch databases: 5 rows and the trigger PASS; 4 rows without 0004 WARN and exit 0; no table WARN', async (t) => {
  const url4 = scratchDb(4);
  const url3 = scratchDb(3);
  try {
    if (!url4 || !url3) { t.skip('no scratch database could be created'); return; }
    const fx = fixture();
    put(join(fx.repo, 'apps', 'agentic-os', 'drizzle', 'meta', '_journal.json'), JSON.stringify({ entries: TAGS5.map((tag) => ({ tag })) }));
    const { Client } = requireDep('pg', { repoRoot: join(HERE_TEST, '..') });
    const fill = async (url, rows) => {
      const c = new Client({ connectionString: assertScratchUrl(url) && url });
      await c.connect();
      try {
        await c.query('CREATE TABLE agentic_os.__migrations (id serial primary key, hash text, created_at bigint)');
        for (let i = 0; i < rows; i++) await c.query('INSERT INTO agentic_os.__migrations (hash, created_at) VALUES ($1, $2)', [`h${i}`, i]);
      } finally { await c.end(); }
    };
    const noTable = run(fx, [], dbEnv(url4));
    assert.equal(noTable.checks['lanes:schema'].status, 'WARN', noTable.stdout);
    assert.match(noTable.checks['lanes:schema'].detail, /__migrations/);
    await fill(url4, 5);
    await fill(url3, 4);
    const ok = run(fx, [], dbEnv(url4));
    assert.equal(ok.checks['lanes:schema'].status, 'PASS', ok.checks['lanes:schema'].detail);
    assert.match(ok.checks['lanes:schema'].detail, /trigger lane_guard_foreign_board present/);
    const behind = run(fx, [], dbEnv(url3));
    assert.equal(behind.checks['lanes:schema'].status, 'WARN', behind.checks['lanes:schema'].detail);
    assert.match(behind.checks['lanes:schema'].detail, /migration 0004 not applied/);
    assert.equal(behind.code, 0, 'a database that lacks 0004 must not fail the doctor');
  } finally {
    if (url4) dropScratch(url4);
    if (url3) dropScratch(url3);
  }
});

test('lanes:worktree-lane-mjs: no worktrees dir is a PASS that says absent; the same file with CRLF matches; a different file is a WARN naming the worktree', () => {
  const fx = fixture();
  const rel = ['scripts', 'coordination', 'lane.mjs'];
  put(join(fx.repo, ...rel), 'console.log(1);\nconsole.log(2);\n');
  dropStoreLink(fx.repo);
  rmdirSync(join(fx.repo, '.claude', 'worktrees')); // the fixture's store link made this folder; the test starts with none
  const absentLine = run(fx).checks['lanes:worktree-lane-mjs'];
  assert.equal(absentLine.status, 'PASS');
  assert.match(absentLine.detail, /^absent: /);
  const wt = join(fx.repo, '.claude', 'worktrees');
  put(join(wt, 'same-crlf', ...rel), 'console.log(1);\r\nconsole.log(2);\r\n');
  const same = run(fx).checks['lanes:worktree-lane-mjs'];
  assert.equal(same.status, 'PASS', same.detail);
  assert.match(same.detail, /all 1 worktree lane\.mjs copies match/);
  put(join(wt, 'old-copy', ...rel), 'console.log(1);\n');
  put(join(wt, 'no-lane-file', 'README.md'), 'x');
  const differ = run(fx).checks['lanes:worktree-lane-mjs'];
  assert.equal(differ.status, 'WARN');
  assert.match(differ.detail, /1 worktree\(s\)/);
  assert.ok(differ.detail.includes('old-copy') && !differ.detail.includes('same-crlf') && !differ.detail.includes('no-lane-file'), differ.detail);
  assert.match(differ.detail, /not a git worktree/, 'a folder git does not know cannot be judged, so it still warns');
});

test('lanes:worktree-lane-mjs: a git worktree that lacks main\'s last lane.mjs change is a WARN; one that has it and differs is info (a PASS)', () => {
  const fx = fixture();
  const rel = ['scripts', 'coordination', 'lane.mjs'];
  const main = join(fx.repo, ...rel);
  const wt = join(fx.repo, '.claude', 'worktrees');
  put(main, '// lane v1\n');
  git(fx.repo, 'add', '--', 'scripts/coordination/lane.mjs');
  git(fx.repo, 'commit', '-q', '--no-verify', '-m', 'lane v1');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'old-branch', join(wt, 'stale-one'));
  put(main, '// lane v2\n');
  git(fx.repo, 'add', '--', 'scripts/coordination/lane.mjs');
  git(fx.repo, 'commit', '-q', '--no-verify', '-m', 'lane v2');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'feat/ahead', join(wt, 'feature-one'));
  put(join(wt, 'feature-one', ...rel), '// lane v3, a feature edit\n');
  const info = run(fx).checks['lanes:worktree-lane-mjs'];
  assert.equal(info.status, 'WARN', info.detail);
  assert.ok(info.detail.includes('stale-one'), info.detail);
  assert.doesNotMatch(info.detail.split('; ')[0], /feature-one/, 'the WARN list names only the stale worktree');
  git(fx.repo, 'worktree', 'remove', '--force', join(wt, 'stale-one'));
  const feature = run(fx).checks['lanes:worktree-lane-mjs'];
  assert.equal(feature.status, 'PASS', feature.detail);
  assert.match(feature.detail, /^info: /);
  assert.ok(feature.detail.includes('feature-one'), feature.detail);
});

// ---- the database checks against real scratch databases (skipped when none can be made) ----
const SCRATCH = join(HERE_TEST, 'coordination', 'scratch-db.mjs');
function scratchDb(through) {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', String(through)], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status !== 0) return null;
  const { url } = JSON.parse(r.stdout);
  assertScratchUrl(url);
  return url;
}
const dropScratch = (url) => { assertScratchUrl(url); spawnSync(process.execPath, [SCRATCH, 'drop', url], { encoding: 'utf8', windowsHide: true }); };
const dbEnv = (url) => { assertScratchUrl(url); return { HARNESS_DOCTOR_NO_DB: '', CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url }; };

test('end to end against scratch databases: board-columns and project-rows read the real tables', async (t) => {
  const url4 = scratchDb(4);
  const url3 = scratchDb(3);
  try {
    if (!url4 || !url3) { t.skip('no scratch database could be created'); return; }
    const fx = fixture();
    const dir = fwd(join(fx.root, 'boardroot'));
    mkdirSync(dir);
    writeRegistry(fx, [entry('zz-doctor-a', dir)]);
    const before = run(fx, [], dbEnv(url4)).checks;
    assert.equal(before['lanes:board-columns'].status, 'PASS', before['lanes:board-columns'].detail);
    assert.equal(before['registry:project-rows'].status, 'WARN');
    assert.match(before['registry:project-rows'].detail, /zz-doctor-a: no project row/);

    const { Client } = requireDep('pg', { repoRoot: join(HERE_TEST, '..') });
    const c = new Client({ connectionString: url4 });
    await c.connect();
    try {
      await c.query(`INSERT INTO agentic_os.project (key, display_name, root_path, root_path_norm, status) VALUES ($1,$1,$2,$3,'active')`,
        ['zz-doctor-a', dir, dir.toLowerCase()]);
    } finally { await c.end(); }
    const after = run(fx, [], dbEnv(url4)).checks;
    assert.equal(after['registry:project-rows'].status, 'PASS', after['registry:project-rows'].detail);

    const old = run(fx, [], dbEnv(url3));
    assert.equal(old.checks['lanes:board-columns'].status, 'WARN');
    assert.match(old.checks['lanes:board-columns'].detail, /migration 0004 not applied/);
    assert.equal(old.code, 0, 'an unmigrated database must not fail the doctor');
  } finally {
    if (url4) dropScratch(url4);
    if (url3) dropScratch(url3);
  }
});

// ---- the five propagation checks (shim, hook client version, render check, dist parity, relative-path guard) ----
const homeDist = (fx, n) => join(fx.home, '.claude', 'hooks', 'dist', `${n}.mjs`);
const repoDist = (fx, n) => join(fx.repo, '.claude', 'hooks', 'dist', `${n}.mjs`);
const rm = (f) => execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(f)})`]);
const liveDoc = (fx) => JSON.parse(readFileSync(liveFile(fx.home), 'utf8'));
const putLive = (fx, doc) => put(liveFile(fx.home), JSON.stringify(doc, null, 2));

test('a clean fixture passes the five propagation checks end to end', () => {
  const r = run(fixture());
  for (const id of ['lanes:shim', 'lanes:hook-client-version', 'hooks:render-check', 'hooks:dist-parity', 'lanes:relative-path-guard']) {
    assert.ok(r.checks[id], `${id} is missing from the output`);
    assert.equal(r.checks[id].status, 'PASS', `${id}: ${r.checks[id].detail}`);
  }
});

test('lanes:shim is a PASS when the home shim equals the repo shim, even with CRLF line ends', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', 'scripts', 'lane.mjs'), SHIM_TEXT.replace(/\n/g, '\r\n'));
  assert.equal(lanesShim({ home: fx.home, repo: fx.repo }).status, 'PASS');
});

test('lanes:shim is a WARN, never a FAIL: missing in the home, different from the repo, missing in the repo', () => {
  const fx = fixture();
  put(join(fx.home, '.claude', 'scripts', 'lane.mjs'), '// an older shim\n');
  const differ = lanesShim({ home: fx.home, repo: fx.repo });
  assert.equal(differ.status, 'WARN');
  assert.match(differ.detail, /differs/);
  assert.match(differ.detail, /sync-to-active\.sh --changed/);
  rm(join(fx.home, '.claude', 'scripts', 'lane.mjs'));
  const none = lanesShim({ home: fx.home, repo: fx.repo });
  assert.equal(none.status, 'WARN');
  assert.ok(none.detail.includes(fwd(join(fx.home, '.claude', 'scripts', 'lane.mjs'))), none.detail);
  rm(join(fx.repo, '.claude', 'scripts', 'lane.mjs'));
  assert.equal(lanesShim({ home: fx.home, repo: fx.repo }).status, 'WARN');
});

test('lanes:hook-client-version: both bundles carry lane.client_version is a PASS', () => {
  const fx = fixture();
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'PASS', r.detail);
});

test('lanes:hook-client-version: a bundle without the string is a WARN while only continuous-claude has a board', () => {
  const fx = fixture();
  put(homeDist(fx, 'lane-context'), '// old build\n');
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lane-context\.mjs/);
  assert.doesNotMatch(r.detail, /prompt-submit\.mjs/);
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), { ...entry('agentic-os', fwd(fx.repo) + '/apps/x', 'in-development'), laneBoard: 'continuous-claude' }]);
  assert.equal(laneHookClientVersion({ home: fx.home, repo: fx.repo }).status, 'WARN');
});

test('lanes:hook-client-version: FAIL only when a live board other than continuous-claude exists and a bundle lacks the string', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), entry('zz-second', fwd(join(fx.root, 'second')))]);
  assert.equal(laneHookClientVersion({ home: fx.home, repo: fx.repo }).status, 'PASS', 'the string is present: a second board is safe');
  put(homeDist(fx, 'prompt-submit'), '// old build\n');
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /prompt-submit\.mjs/);
  assert.match(r.detail, /42501/);
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), entry('zz-second', fwd(join(fx.root, 'second')), 'inactive')]);
  assert.equal(laneHookClientVersion({ home: fx.home, repo: fx.repo }).status, 'WARN', 'an inactive board does not count');
});

test('lanes:hook-client-version: a bundle that is not there is a WARN, never a FAIL', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), entry('zz-second', fwd(join(fx.root, 'second')))]);
  rm(homeDist(fx, 'lane-context'));
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lane-context\.mjs/);
});

test('hooks:render-check is a PASS when every lane hook of the rendered template is live with the same matcher', () => {
  const fx = fixture();
  const r = hooksRenderCheck({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'PASS', r.detail);
});

test('hooks:render-check: a missing Stop registration is a WARN that names lane-board-stop-gate and the apply-registrations fix', () => {
  const fx = fixture();
  const doc = liveDoc(fx);
  delete doc.hooks.Stop;
  putLive(fx, doc);
  const r = hooksRenderCheck({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lane-board-stop-gate/);
  assert.match(r.detail, /Stop/);
  assert.match(r.detail, /apply-registrations\.mjs --only lane-board-stop-gate/);
  assert.match(r.detail, /dry run/i);
});

test('hooks:render-check: a lane hook on another matcher is a WARN naming the hook', () => {
  const fx = fixture();
  const doc = liveDoc(fx);
  doc.hooks.PostToolUse.find((g) => g.matcher === 'Edit|Write|Bash|PowerShell|Task|Agent').matcher = 'Edit|Write|Bash|PowerShell|Task';
  putLive(fx, doc);
  const r = hooksRenderCheck({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lane-context/);
  assert.match(r.detail, /PostToolUse/);
});

test('hooks:render-check ignores a hook that is not a lane hook, and never FAILs when an input is absent', () => {
  const fx = fixture();
  const doc = liveDoc(fx);
  doc.hooks.PreToolUse = doc.hooks.PreToolUse.filter((g) => g.matcher !== 'Bash');
  putLive(fx, doc);
  assert.equal(hooksRenderCheck({ home: fx.home, repo: fx.repo }).status, 'PASS', 'a missing non-lane hook is not this check');
  rm(liveFile(fx.home));
  const noLive = hooksRenderCheck({ home: fx.home, repo: fx.repo });
  assert.equal(noLive.status, 'WARN');
  assert.match(noLive.detail, /settings\.json/);
  rm(templateFile(fx.repo));
  const noTemplate = hooksRenderCheck({ home: fx.home, repo: fx.repo });
  assert.equal(noTemplate.status, 'WARN');
  assert.match(noTemplate.detail, /settings\.json\.template/);
});

test('hooks:render-check: a live settings file that is not JSON is a WARN, not a crash', () => {
  const fx = fixture();
  put(liveFile(fx.home), '{ not json');
  assert.equal(hooksRenderCheck({ home: fx.home, repo: fx.repo }).status, 'WARN');
});

test('hooks:dist-parity is a PASS when the home lane dists equal the repo dists, CRLF folded', () => {
  const fx = fixture();
  put(homeDist(fx, 'lane-agent-tag'), '// lane-agent-tag\r\n');
  const r = hooksDistParity({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'PASS', r.detail);
});

test('hooks:dist-parity is a WARN naming each lane dist that differs or is missing in the home or the repo', () => {
  const fx = fixture();
  put(homeDist(fx, 'lane-board-stop-gate'), '// an older build\n');
  rm(homeDist(fx, 'lane-agent-tag'));
  const r = hooksDistParity({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lane-board-stop-gate/);
  assert.match(r.detail, /lane-agent-tag/);
  assert.doesNotMatch(r.detail, /lane-context/);
  assert.match(r.detail, /sync-to-active\.sh --changed/);
  rm(repoDist(fx, 'lane-context'));
  const noRepo = hooksDistParity({ home: fx.home, repo: fx.repo });
  assert.equal(noRepo.status, 'WARN');
  assert.match(noRepo.detail, /lane-context/);
});

test('lanes:relative-path-guard is a PASS at the baseline and names the count', () => {
  const fx = fixture();
  put(join(fx.repo, 'CLAUDE.md'), 'run node scripts/coordination/lane.mjs board\n');
  put(join(fx.repo, 'scripts', 'coordination', 'lane-path-guard.baseline.json'), JSON.stringify({ files: { 'CLAUDE.md': 2 } }));
  const r = lanePathGuardCheck({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'PASS', r.detail);
  assert.match(r.detail, /1 bare/);
});

test('lanes:relative-path-guard is a WARN naming a file over its baseline, and a WARN without a baseline file', () => {
  const fx = fixture();
  put(join(fx.repo, 'CLAUDE.md'), 'node scripts/coordination/lane.mjs board\nnode scripts/coordination/lane.mjs next\n');
  const over = lanePathGuardCheck({ home: fx.home, repo: fx.repo });
  assert.equal(over.status, 'WARN');
  assert.match(over.detail, /CLAUDE\.md/);
  assert.match(over.detail, /2 .*baseline 0/);
  rm(join(fx.repo, 'scripts', 'coordination', 'lane-path-guard.baseline.json'));
  const none = lanePathGuardCheck({ home: fx.home, repo: fx.repo });
  assert.equal(none.status, 'WARN');
  assert.match(none.detail, /baseline/);
});

test('end to end: breaking each asset moves only its own check, and the doctor still exits 0 with no second board', () => {
  const fx = fixture();
  const doc = liveDoc(fx);
  delete doc.hooks.Stop;
  putLive(fx, doc);
  put(homeDist(fx, 'lane-context'), '// old\n');
  rm(join(fx.home, '.claude', 'scripts', 'lane.mjs'));
  const r = run(fx);
  assert.equal(r.checks['hooks:render-check'].status, 'WARN');
  assert.equal(r.checks['hooks:dist-parity'].status, 'WARN');
  assert.equal(r.checks['lanes:shim'].status, 'WARN');
  assert.equal(r.checks['lanes:hook-client-version'].status, 'WARN');
  assert.equal(r.checks['lanes:relative-path-guard'].status, 'PASS');
  assert.equal(r.code, 0, r.stdout);
});

// Finding 2 (PR2 review): a second active board while the live lane-context hook cannot set lane.client_version. The check above
// already covers prompt-submit; these two pin the lane-context bundle itself and the missing-bundle wording.
test('lanes:hook-client-version: a lane-context bundle without the string FAILs and names the second board when the registry has two active boards', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), entry('zz-second', fwd(join(fx.root, 'second')))]);
  put(homeDist(fx, 'lane-context'), '// old build\n');
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /lane-context\.mjs/);
  assert.match(r.detail, /zz-second/);
});

test('lanes:hook-client-version: a missing bundle with a second active board stays a WARN but does not say a second board is fine', () => {
  const fx = fixture();
  writeRegistry(fx, [entry('continuous-claude', fwd(fx.repo)), entry('zz-second', fwd(join(fx.root, 'second')))]);
  rm(homeDist(fx, 'lane-context'));
  const r = laneHookClientVersion({ home: fx.home, repo: fx.repo });
  assert.equal(r.status, 'WARN');
  assert.doesNotMatch(r.detail, /fine while only/);
  assert.match(r.detail, /zz-second/);
});

// registry:artifact-url (PR C). A board's phone page is the laneArtifact url on its own registry entry. The hooks nag for that
// page, so a bad url nags for nothing, and one url on two boards lets one publish clear both boards' pending files.
// Each test breaks one rule and reads this one line; each fails if the check stops judging that rule.
const PAGE_A = 'https://claude.ai/artifact/PageA_1-x';
const PAGE_B = 'https://claude.ai/artifact/PageB_2-y';
const DEFAULT_PAGE = 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid';
const withPage = (key, laneArtifact, extra = {}) => ({ ...entry(key, fwd(join(tmpdir(), `hdoc-no-${key}`))), laneArtifact, ...extra });
const artifactCheck = (projects) => {
  const fx = fixture();
  writeRegistry(fx, projects);
  const r = run(fx);
  return { c: r.checks['registry:artifact-url'], r };
};

test('registry:artifact-url with no laneArtifact anywhere is a PASS that reports 0 boards, so it is not vacuous', () => {
  const { c } = artifactCheck([entry('a', fwd(tmpdir())), entry('b', fwd(tmpdir()))]);
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /\b0 boards with a phone page/);
});

test('registry:artifact-url with two boards on different good urls is a PASS that counts 2', () => {
  const { c } = artifactCheck([withPage('one', PAGE_A), withPage('two', PAGE_B)]);
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /\b2 boards with a phone page/);
});

test('registry:artifact-url is a FAIL when two boards share one url, and exits 1', () => {
  const { c, r } = artifactCheck([withPage('one', PAGE_A), withPage('two', PAGE_A)]);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.ok(c.detail.includes('one') && c.detail.includes('two'), c.detail);
  assert.match(c.detail, /duplicate|same/i);
  assert.equal(r.code, 1);
});

test('registry:artifact-url is a FAIL for a url that is not the strict claude.ai artifact shape, naming the key', () => {
  for (const bad of ['http://claude.ai/artifact/x1', 'https://claude.ai/artifact/x1/extra', 'https://claude.ai/artifact/x1?y=1', 'https://evil.example/artifact/x1', 'https://claude.ai/artifact/']) {
    const { c } = artifactCheck([withPage('one', bad)]);
    assert.equal(c.status, 'FAIL', `${bad}: ${c.detail}`);
    assert.ok(c.detail.includes('one'), c.detail);
  }
});

test('registry:artifact-url is a FAIL when a board uses the default board page', () => {
  const { c } = artifactCheck([withPage('one', DEFAULT_PAGE)]);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /default board/);
});

test('registry:artifact-url is a WARN for a laneArtifact on a nested entry (laneBoard names another board)', () => {
  const { c } = artifactCheck([withPage('one', PAGE_A), withPage('inner', PAGE_B, { laneBoard: 'one' })]);
  assert.equal(c.status, 'WARN', c.detail);
  assert.ok(c.detail.includes('inner'), c.detail);
  assert.match(c.detail, /nested/);
});

test('registry:artifact-url ignores an inactive entry, so a dead board cannot fail the doctor', () => {
  const { c } = artifactCheck([withPage('gone', 'not a url', { status: 'inactive' }), withPage('one', PAGE_A)]);
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /\b1 boards with a phone page/);
});

test('registry:artifact-url is a PASS that says absent without a registry file', () => {
  const c = run(fixture()).checks['registry:artifact-url'];
  assert.equal(c.status, 'PASS');
  assert.match(c.detail, /^absent: /);
});

// ---- deps:hooks-install: the primary checkout holds the one install of .claude/hooks ----
// Each test names what breaks it: the lookup moves off the primary (D4), "installed" is judged by node_modules alone (D2, D3),
// the version pair is lost (D5), or the lock drift becomes a FAIL (D5).
test('deps:hooks-install passes on a clean fixture and says what it found', () => {
  const c = run(fixture()).checks['deps:hooks-install'];
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /pg/);
});

test('deps:hooks-install FAILs when the primary has no node_modules, and names the fix', () => {
  const fx = fixture();
  const bare = join(fx.root, 'bare');
  mkdirSync(bare);
  execFileSync('git', ['init', '-q', '-b', 'main', bare], { windowsHide: true });
  const c = depsHooksInstall({ repo: bare });
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /node_modules/);
  assert.match(c.detail, /npm ci/);
});

test('deps:hooks-install FAILs when node_modules holds only a partial install and no pg (a lone .vite folder is not an install)', () => {
  const fx = fixture();
  const lone = join(fx.root, 'lone');
  put(join(lone, '.claude', 'hooks', 'node_modules', '.vite', 'deps', 'x.json'), '{}\n');
  execFileSync('git', ['init', '-q', '-b', 'main', lone], { windowsHide: true });
  const noCanary = depsHooksInstall({ repo: lone });
  assert.equal(noCanary.status, 'FAIL', noCanary.detail);
  seedHooksInstall(lone, { pg: false });
  const noPg = depsHooksInstall({ repo: lone });
  assert.equal(noPg.status, 'FAIL', noPg.detail);
  assert.match(noPg.detail, /pg/);
});

test('deps:hooks-install judges the PRIMARY: a bare worktree of a good primary passes', () => {
  const fx = fixture();
  const wt = join(fx.root, 'wt');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'zz-wt', wt);
  const c = depsHooksInstall({ repo: wt });
  assert.equal(c.status, 'PASS', c.detail);
  assert.ok(c.detail.includes(join(fx.repo, '.claude', 'hooks')), c.detail);
});

test('deps:hooks-install WARNs with the version pair when installed typescript differs from the lock, never a FAIL', () => {
  const fx = fixture();
  seedHooksInstall(fx.repo, { installedTs: '5.9.3', lockTs: '7.0.2' });
  const c = run(fx).checks['deps:hooks-install'];
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /installed typescript 5\.9\.3, lock says 7\.0\.2/);
  assert.match(c.detail, /npm ci/);
  seedHooksInstall(fx.repo, { installedTs: '7.0.2', lockTs: '7.0.2' });
  assert.equal(run(fx).checks['deps:hooks-install'].status, 'PASS');
});

// ---- deps:store-link: the shared store link <primary>/.claude/worktrees/node_modules -> <primary>/.claude/hooks/node_modules ----
// Each test names what breaks it: a state maps to the wrong status, the check runs on a broken install, or the doctor
// stops reading the PRIMARY.
test('deps:store-link PASSes when the link resolves to the primary hooks install', () => {
  const c = run(fixture()).checks['deps:store-link'];
  assert.equal(c.status, 'PASS', c?.detail);
});

test('deps:store-link WARNs with the apply command when the link is absent', () => {
  const fx = fixture();
  dropStoreLink(fx.repo);
  const r = run(fx);
  const c = r.checks['deps:store-link'];
  assert.equal(c.status, 'WARN', c.detail);
  assert.ok(c.detail.includes("no shared store link: run node scripts/worktree/shared-deps.mjs --apply in the primary (needs Dave's yes)"), c.detail);
  assert.equal(r.code, 0, 'a WARN never fails the doctor');
});

test('deps:store-link FAILs when the link is dangling', () => {
  const fx = fixture();
  dropStoreLink(fx.repo);
  const gone = join(fx.root, 'gone');
  put(join(gone, 'x.txt'), 'x\n');
  symlinkSync(gone, join(fx.repo, '.claude', 'worktrees', 'node_modules'), 'junction');
  renameSync(gone, join(fx.root, 'gone-moved'));
  const r = run(fx);
  assert.equal(r.checks['deps:store-link'].status, 'FAIL', r.checks['deps:store-link'].detail);
  assert.match(r.checks['deps:store-link'].detail, /dangling/);
  assert.ok(r.checks['deps:store-link'].detail.includes("run node scripts/worktree/shared-deps.mjs --unlink then --apply in the primary (Dave's yes)"), r.checks['deps:store-link'].detail);
  assert.equal(r.code, 1);
});

test('deps:store-link FAILs when the link resolves somewhere else', () => {
  const fx = fixture();
  dropStoreLink(fx.repo);
  const other = join(fx.root, 'other');
  put(join(other, '.package-lock.json'), '{}\n');
  symlinkSync(other, join(fx.repo, '.claude', 'worktrees', 'node_modules'), 'junction');
  const c = run(fx).checks['deps:store-link'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /wrong-target/);
  assert.ok(c.detail.includes("--unlink then --apply in the primary (Dave's yes)"), c.detail);
});

test('deps:store-link FAILs when a real folder sits at the link path', () => {
  const fx = fixture();
  dropStoreLink(fx.repo);
  put(join(fx.repo, '.claude', 'worktrees', 'node_modules', 'x.txt'), 'x\n');
  const c = run(fx).checks['deps:store-link'];
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /not-a-link/);
  assert.match(c.detail, /ask Dave, do not delete it/);
  assert.doesNotMatch(c.detail, /--unlink/, 'a real folder is never unlinked');
});

test('deps:store-link does not run when the hooks install is incomplete', () => {
  const fx = fixture();
  dropStoreLink(fx.repo);
  renameSync(join(fx.repo, '.claude', 'hooks', 'node_modules', '.package-lock.json'), join(fx.root, 'lock-moved.json'));
  const r = run(fx);
  assert.equal(r.checks['deps:hooks-install'].status, 'FAIL');
  assert.equal(r.checks['deps:store-link'], undefined, 'no store-link line on a broken install');
});

test('deps:store-link judges the PRIMARY: a bare worktree of a primary with the link passes', () => {
  const fx = fixture();
  const wt = join(fx.root, 'wt2');
  git(fx.repo, 'worktree', 'add', '-q', '-b', 'zz-wt2', wt);
  assert.equal(depsStoreLink({ repo: wt }).status, 'PASS');
});

// ---- hooks:trace-fresh ----
// How the check can fail, one test each below:
//   activity and no day file (FAIL, names both files); activity and a live row (PASS); only test or probe rows after activity (FAIL);
//   a live row more than 30 min older than the newest activity (FAIL), 29 min older (PASS); neither activity file (WARN, never a vacuous PASS);
//   mode file off (WARN); the identity-probe row read from the HOME instead of the repo (it must be the repo copy);
//   guard-decisions as the second signal (live rows count, test and probe rows do not).
const traceCheck = (fx) => run(fx).checks['hooks:trace-fresh'];
const probeFile = (fx) => join(fx.repo, '.claude', 'logs', 'identity-probe.jsonl');
const dropTrace = (fx) => rmSync(join(fx.home, '.claude', 'cache'), { recursive: true, force: true });

test('hooks:trace-fresh is FAIL when there is recent activity and no trace day file, and names the trace dir and the activity file', () => {
  const fx = fixture();
  dropTrace(fx);
  const r = run(fx);
  const c = r.checks['hooks:trace-fresh'];
  assert.equal(c.status, 'FAIL', c?.detail);
  assert.ok(c.detail.includes('identity-probe.jsonl'), c.detail);
  assert.ok(c.detail.replace(/\\/g, '/').includes('/.claude/cache'), c.detail);
  assert.equal(r.code, 1);
});

test('hooks:trace-fresh is PASS with recent activity and a recent live trace row, and says so', () => {
  const c = traceCheck(fixture());
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, /live/);
});

test('hooks:trace-fresh is a FAIL that names the file, not a crash, when a day file cannot be read', () => {
  const fx = fixture();
  dropTrace(fx);
  // A directory with a day-file name: the stat works and the read throws EISDIR (a stand-in for a file pruned or locked mid-run).
  const day = `hook-trace-${new Date().toISOString().slice(0, 10)}.jsonl`;
  mkdirSync(join(fx.home, '.claude', 'cache', day), { recursive: true });
  const r = run(fx);
  const c = r.checks['hooks:trace-fresh'];
  assert.ok(c, 'the check must still report');
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /cannot read/i);
  assert.ok(c.detail.includes(day), c.detail);
});

test('hooks:trace-fresh is FAIL when only test or probe rows follow the activity', () => {
  const fx = fixture();
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(60000), name: 'x', source: 'test' }, { ts: iso(30000), name: 'y', source: 'probe' }]);
  const c = traceCheck(fx);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /live/);
});

test('hooks:trace-fresh is FAIL when the newest live row is more than 30 min older than the newest activity, and PASS at 29 min', () => {
  const fx = fixture();
  put(probeFile(fx), jsonl([{ ts: iso(60000), hook: 'identity-probe' }]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(60000 + 31 * 60000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'FAIL');
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(60000 + 29 * 60000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'PASS');
});

test('hooks:trace-fresh is a WARN, not a PASS, when neither activity file exists', () => {
  const fx = fixture();
  rmSync(probeFile(fx));
  const c = traceCheck(fx);
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /no activity signal/);
});

test('hooks:trace-fresh reads identity-probe.jsonl from the REPO, not the home', () => {
  const fx = fixture();
  rmSync(probeFile(fx));
  put(join(fx.home, '.claude', 'logs', 'identity-probe.jsonl'), jsonl([{ ts: iso(60000), hook: 'identity-probe' }]));
  dropTrace(fx);
  const c = traceCheck(fx);
  assert.equal(c.status, 'WARN', `a home copy must not count as activity: ${c.detail}`);
});

test('hooks:trace-fresh uses guard-decisions.jsonl as the second signal, and ignores its test and probe rows', () => {
  const fx = fixture();
  rmSync(probeFile(fx));
  dropTrace(fx);
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([{ ts: iso(60000), hook: 'g', kind: 'deny', decision: 'deny', source: 'test' }]));
  assert.equal(traceCheck(fx).status, 'WARN', 'a test row is not activity');
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([{ ts: iso(60000), hook: 'g', kind: 'deny', decision: 'deny', source: 'live' }]));
  assert.equal(traceCheck(fx).status, 'FAIL', 'a live guard row is activity, and there is no day file');
  writeTrace(fx, [{ ts: iso(30000), name: 'g', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'PASS');
});

test('hooks:trace-fresh is a WARN when the mode file says off, and a missing mode file is not a WARN', () => {
  const fx = fixture();
  assert.equal(traceCheck(fx).status, 'PASS', 'a missing mode file means hot');
  put(join(fx.home, '.claude', 'state', 'hook-trace-mode'), 'off\n');
  const c = traceCheck(fx);
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /off/);
});

// ---- hooks:trace-fresh, review fixes 2026-11-09 ----
// How each can fail, one test each:
//   a guard-decisions row of a hot program is the newest activity and only other names have live rows (the gap hides) -> FAIL naming the hook;
//   the same, with a live row of that name (PASS); a cold hook's guard row asks for no per-name row (PASS);
//   identity-probe activity needs a live row named identity-probe;
//   a repo-dist run (source probe) is no live row; activity older than 6 h with a day file is info: idle (PASS), with no day file stays FAIL;
//   CCV3_HOOK_TRACE=0 in <home>/.claude/settings.json or in the process env is the same off WARN as the mode file.
const HOUR_MS = 60 * 60 * 1000;
const guardRow = (hook, msAgo) => ({ ts: iso(msAgo), hook, kind: 'deny', decision: 'deny', source: 'live' });

test('hooks:trace-fresh is FAIL when the newest activity is a hot guard and only other hooks wrote live rows, and names the guard', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([guardRow('destructive-command-guard', 60000)]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(30000), name: 'session-register', source: 'live' }, { ts: iso(40000), name: 'identity-probe', source: 'live' }]);
  const c = traceCheck(fx);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /destructive-command-guard/);
});

test('hooks:trace-fresh is PASS when that hot guard has a live row within 30 min of its activity', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([guardRow('destructive-command-guard', 60000)]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(60000 + 29 * 60000), name: 'destructive-command-guard', source: 'live' }, { ts: iso(30000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'PASS');
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(60000 + 31 * 60000), name: 'destructive-command-guard', source: 'live' }, { ts: iso(30000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'FAIL', 'a row of that name 31 min older is too old');
});

test('hooks:trace-fresh asks no per-name row for a guard that is not a hot program', () => {
  const fx = fixture();
  put(logPath(fx, 'guard-decisions.jsonl'), jsonl([guardRow('tldr-read-enforcer', 60000)]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(30000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'PASS');
});

test('hooks:trace-fresh needs a live row named identity-probe when identity-probe is the newest activity', () => {
  const fx = fixture();
  put(probeFile(fx), jsonl([{ ts: iso(60000), hook: 'identity-probe' }]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(30000), name: 'session-register', source: 'live' }]);
  const c = traceCheck(fx);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /identity-probe/);
  writeTrace(fx, [{ ts: iso(30000), name: 'session-register', source: 'live' }, { ts: iso(45000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'PASS');
});

test('hooks:trace-fresh does not count a repo-dist run: it writes source probe, so only probe rows after activity is FAIL', () => {
  const fx = fixture();
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(30000), name: 'identity-probe', source: 'probe' }, { ts: iso(20000), name: 'destructive-command-guard', source: 'probe' }]);
  const c = traceCheck(fx);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.match(c.detail, /live/);
});

test('hooks:trace-fresh is a PASS that starts with info: idle when the newest activity is more than 6 h old and a day file exists', () => {
  const fx = fixture();
  put(probeFile(fx), jsonl([{ ts: iso(7 * HOUR_MS), hook: 'identity-probe' }]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(8 * HOUR_MS), name: 'session-register', source: 'live' }]);
  const c = traceCheck(fx);
  assert.equal(c.status, 'PASS', c.detail);
  assert.ok(c.detail.startsWith('info: idle'), c.detail);
});

test('hooks:trace-fresh stays FAIL for old activity when no day file exists', () => {
  const fx = fixture();
  put(probeFile(fx), jsonl([{ ts: iso(7 * HOUR_MS), hook: 'identity-probe' }]));
  dropTrace(fx);
  const c = traceCheck(fx);
  assert.equal(c.status, 'FAIL', c.detail);
  assert.ok(!c.detail.startsWith('info: idle'), c.detail);
});

test('hooks:trace-fresh is not idle at 5 h: the stale trace is still a FAIL', () => {
  const fx = fixture();
  put(probeFile(fx), jsonl([{ ts: iso(5 * HOUR_MS), hook: 'identity-probe' }]));
  dropTrace(fx);
  writeTrace(fx, [{ ts: iso(5 * HOUR_MS + 40 * 60000), name: 'identity-probe', source: 'live' }]);
  assert.equal(traceCheck(fx).status, 'FAIL');
});

test('hooks:trace-fresh is the off WARN when CCV3_HOOK_TRACE is 0 in <home>/.claude/settings.json', () => {
  const fx = fixture();
  dropTrace(fx);
  put(liveFile(fx.home), JSON.stringify({ env: { CCV3_HOOK_TRACE: '0' } }));
  const c = traceCheck(fx);
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /off/);
  assert.match(c.detail, /CCV3_HOOK_TRACE/);
});

test('hooks:trace-fresh tests do not depend on the caller env: CCV3_HOOK_TRACE=0 in the test process does not turn the clean fixture into a WARN', () => {
  const had = Object.hasOwn(process.env, 'CCV3_HOOK_TRACE');
  const before = process.env.CCV3_HOOK_TRACE;
  process.env.CCV3_HOOK_TRACE = '0';
  try {
    const c = traceCheck(fixture());
    assert.equal(c.status, 'PASS', c.detail);
  } finally {
    if (had) process.env.CCV3_HOOK_TRACE = before; else delete process.env.CCV3_HOOK_TRACE;
  }
});

test('hooks:trace-fresh is the off WARN when CCV3_HOOK_TRACE is 0 in the process env, and a settings.json with another value is not', () => {
  const fx = fixture();
  dropTrace(fx);
  const c = run(fx, [], { CCV3_HOOK_TRACE: '0' }).checks['hooks:trace-fresh'];
  assert.equal(c.status, 'WARN', c.detail);
  assert.match(c.detail, /off/);
  put(liveFile(fx.home), JSON.stringify({ env: { CCV3_HOOK_TRACE: '1' } }));
  assert.equal(traceCheck(fx).status, 'FAIL', 'value 1 is not off: no day file is a FAIL again');
});

// ---- fleetops export size (fleetops-lanes-file-size part 2)
const dashHome = (files = {}) => {
  const home = tempDir('dash-home-');
  for (const [name, body] of Object.entries(files)) put(join(home, '.claude', 'state', 'lane-dash', name), typeof body === 'string' ? body : JSON.stringify(body));
  return { home };
};

test('fleetopsSize: PASS with no export, with no size recorded, or under 75%', () => {
  // Breaks if a machine with no export, or an old refresh.json, shows a false warning.
  assert.equal(fleetopsSize(dashHome()).status, 'PASS');
  assert.equal(fleetopsSize(dashHome({ 'refresh.json': { pending: true } })).status, 'PASS');
  assert.equal(fleetopsSize(dashHome({ 'refresh.json': { largest_doc: { name: 'lanes.json', bytes: 77346, pct: 30 } } })).status, 'PASS');
});

test('fleetopsSize: WARN at 75% of the limit or more, and names the file', () => {
  // Breaks if the early warning does not reach the doctor line.
  const r = fleetopsSize(dashHome({ 'refresh.json': { largest_doc: { name: 'lanes.json', bytes: 200000, pct: 76 } } }));
  assert.equal(r.status, 'WARN');
  assert.match(r.detail, /lanes\.json.*200000.*76%/);
});

test('fleetopsSize: FAIL when the last export stopped on the size limit; WARN for another failed check', () => {
  // Breaks if a stopped export (no new data on the dashboard) is not a FAIL.
  const size = fleetopsSize(dashHome({ 'export-error.json': { at: '2026-11-13T18:00:00Z', reason: 'size', problems: ['lanes.json is 300000 bytes, over the 262144 byte (256 KB) cap'] } }));
  assert.equal(size.status, 'FAIL');
  assert.match(size.detail, /limit/);
  const other = fleetopsSize(dashHome({ 'export-error.json': { at: '2026-11-13T18:00:00Z', reason: 'checks', problems: ['open count'] } }));
  assert.equal(other.status, 'WARN');
});

test('fleetopsSize: a file that does not parse is a WARN, not a crash', () => {
  // Breaks if a half-written file throws and hides the other doctor checks.
  assert.equal(fleetopsSize(dashHome({ 'refresh.json': '{not json' })).status, 'WARN');
});

// ---- memory (embedding-daemon-commit-leak, 2026-11-13) ----
const embedInfo = (fx, body) => put(join(fx.home, '.claude', 'run', 'ccv3-embedding.json'), typeof body === 'string' ? body : JSON.stringify(body));

test('memory:embedding-daemon is a PASS that says info when no daemon runs (no discovery file)', () => {
  const r = run(fixture());
  assert.equal(r.checks['memory:embedding-daemon']?.status, 'PASS');
  assert.match(r.checks['memory:embedding-daemon'].detail, /^info: no daemon runs/);
});

test('memory:embedding-daemon: under 4096 MB PASS, from 4096 WARN, from 8192 FAIL (exit 1); the detail names the pid and the size', () => {
  const fx = fixture();
  embedInfo(fx, { pid: 4242, port: 1 });
  for (const [mb, status, code] of [['3000', 'PASS', 0], ['4096', 'WARN', 0], ['8191', 'WARN', 0], ['8192', 'FAIL', 1], ['97300', 'FAIL', 1]]) {
    const r = run(fx, [], { HARNESS_DOCTOR_EMBED_PRIVATE_MB: mb });
    const c = r.checks['memory:embedding-daemon'];
    assert.equal(c?.status, status, `${mb} MB: ${c?.detail}`);
    assert.match(c.detail, new RegExp(`pid 4242 holds ${mb} MB`));
    assert.equal(r.code, code, `${mb} MB exit code`);
  }
});

test('memory:embedding-daemon: a stale file (pid gone) is a PASS info; a bad file or pid is a WARN; an unreadable size is a WARN', () => {
  const fx = fixture();
  embedInfo(fx, { pid: 4242 });
  assert.match(run(fx, [], { HARNESS_DOCTOR_EMBED_PRIVATE_MB: 'gone' }).checks['memory:embedding-daemon'].detail, /^info: pid 4242 .* does not run/);
  const reused = run(fx, [], { HARNESS_DOCTOR_EMBED_PRIVATE_MB: 'other' }).checks['memory:embedding-daemon'];
  assert.equal(reused.status, 'PASS', 'a pid reused by a process that is not python is a stale file, not a leak');
  assert.match(reused.detail, /^info: pid 4242 .* is not a python process now/);
  assert.equal(run(fx, [], { HARNESS_DOCTOR_EMBED_PRIVATE_MB: 'x' }).checks['memory:embedding-daemon'].status, 'WARN');
  for (const body of ['not json', { pid: 'a; Stop-Process 1' }, { pid: -1 }, {}]) {
    embedInfo(fx, body);
    const c = run(fx, [], { HARNESS_DOCTOR_EMBED_PRIVATE_MB: '10' }).checks['memory:embedding-daemon'];
    assert.equal(c.status, 'WARN', JSON.stringify(body));
  }
});

test('memory:embedding-daemon reads a real process without the seam (Windows): a pid that is not python is a stale file', { skip: process.platform !== 'win32' }, () => {
  const fx = fixture();
  embedInfo(fx, { pid: process.pid }); // this node test runner
  const c = run(fx).checks['memory:embedding-daemon'];
  assert.equal(c.status, 'PASS', c.detail);
  assert.match(c.detail, new RegExp(`^info: pid ${process.pid} .* is not a python process now`));
});

// The first real python.exe on PATH (Windows `where`; not the WindowsApps store alias), or null: the test then skips.
const realPython = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const all = execFileSync('where', ['python'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((s) => s.trim());
    return all.find((p) => p && /\.exe$/i.test(p) && !/WindowsApps/i.test(p) && existsSync(p)) ?? null;
  } catch { return null; }
})();

test('memory:embedding-daemon reads a real python process without the seam (Windows): a small one is under the limits', { skip: process.platform !== 'win32' || !realPython }, () => {
  const child = spawn(realPython, ['-c', 'import time; time.sleep(60)'], { stdio: 'ignore', windowsHide: true });
  try {
    const fx = fixture();
    embedInfo(fx, { pid: child.pid });
    const c = run(fx).checks['memory:embedding-daemon'];
    assert.equal(c.status, 'PASS', c.detail);
    assert.match(c.detail, new RegExp(`pid ${child.pid} holds \\d+ MB`));
  } finally {
    child.kill(); // only our own child
  }
});
