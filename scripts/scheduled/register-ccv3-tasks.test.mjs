// Tests for .claude/scripts/scheduled/register-ccv3-tasks.ps1 settings logic, by DRY RUN only.
// The test never passes -Apply, so it registers nothing. The script builds the settings object in memory
// (New-ScheduledTaskSettingsSet changes nothing on the machine) and the dry-run line prints what that object holds.
//
// How it can fail, one test each below:
//   battery: llm=true must allow start on battery and not stop on battery; llm absent or false must block (the Windows default)
//   wake: wake=true must print wake=yes, anything else wake=no
//   guard: wake=true without llm prints a [WARN] naming the task and still goes on (exit 0)
//   dry run: the output ends with the DRY RUN line, says nothing was registered, exits 0
//   -Only: a name that matches nothing is refused with exit 1
//   every Nm: "every 5m" is accepted and a battery:true task prints battery=allow with llm=false; "every 0m" and "every 1440m" are refused;
//             the existing four lines stay as they were; only a hidden:true .ps1 task runs through conhost.exe --headless
//   active copy: run from <home>scriptsscheduled with no -TasksFile, the repo tasks.json is found through CCV3_REPO_ROOT (profile-paths.ps1); a repo with no tasks.json is
//                refused with exit 1 and a message that names tasks.json (lane active-register-path)
//   real tasks.json: CCv3-Lane-Snapshot prints daily 23:55, limit 5 min, battery=allow, and the conhost --headless action (dry run, -Only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'scripts', 'scheduled', 'register-ccv3-tasks.ps1');
const TASKS = [
  { name: 'CCv3-T-Plain', script: '.claude/scripts/scheduled/a.bat', trigger: 'daily 07:50', execLimitMin: 10, allowedExit: [0], maxAgeHours: 48 },
  { name: 'CCv3-T-Llm', script: '.claude/scripts/scheduled/b.ps1', trigger: 'weekly Monday 09:20', execLimitMin: 15, allowedExit: [0], maxAgeHours: 336, llm: true, wake: false },
  { name: 'CCv3-T-LlmWake', script: '.claude/scripts/scheduled/c.bat', trigger: 'daily 08:10', execLimitMin: 20, allowedExit: [0], maxAgeHours: 48, llm: true, wake: true },
  { name: 'CCv3-T-WakeOnly', script: '.claude/scripts/scheduled/d.bat', trigger: 'daily 08:30', execLimitMin: 5, allowedExit: [0], maxAgeHours: 48, llm: false, wake: true },
  { name: 'CCv3-T-Battery', script: '.claude/scripts/scheduled/e.ps1', trigger: 'every 5m', execLimitMin: 5, allowedExit: [0], maxAgeHours: 1, llm: false, battery: true, wake: false, hidden: true },
];

function dryRun(extraArgs = [], tasks = TASKS) {
  const root = mkdtempSync(join(tmpdir(), 'reg-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
  for (const f of ['a.bat', 'b.ps1', 'c.bat', 'd.bat', 'e.ps1']) writeFileSync(join(home, 'scripts', 'scheduled', f), 'rem stub\r\n');
  const tasksFile = join(root, 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({ tasks }));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TasksFile', tasksFile, '-ClaudeHome', home, ...extraArgs],
    { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  const lines = (r.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const lineOf = (name) => lines.find((l) => l.startsWith(`${name}:`));
  return { code: r.status, lines, out: r.stdout ?? '', err: r.stderr ?? '', lineOf };
}

const win = { skip: process.platform !== 'win32' };

test('dry run: each task line shows the battery and wake settings the script would register', win, () => {
  const r = dryRun();
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.lineOf('CCv3-T-Plain'), /llm=false battery=block wake=no\]$/);
  assert.match(r.lineOf('CCv3-T-Llm'), /weekly Monday 09:20, limit 15 min, llm=true battery=allow wake=no\]$/);
  assert.match(r.lineOf('CCv3-T-LlmWake'), /llm=true battery=allow wake=yes\]$/);
  assert.match(r.lineOf('CCv3-T-WakeOnly'), /llm=false battery=block wake=yes\]$/);
});

test('dry run: wake without llm prints a WARN naming the task, and the run goes on', win, () => {
  const r = dryRun();
  const warns = r.lines.filter((l) => l.startsWith('[WARN]'));
  assert.equal(warns.length, 1, r.out);
  assert.match(warns[0], /CCv3-T-WakeOnly/);
  assert.match(warns[0], /wake/);
  assert.match(warns[0], /llm/);
  assert.equal(r.code, 0);
});

test('dry run: nothing is registered and the last line says so', win, () => {
  const r = dryRun();
  assert.match(r.lines.at(-1), /^DRY RUN: nothing changed/);
  assert.doesNotMatch(r.out, /^\s*registered/m);
});

test('-Only with a name that matches nothing is refused with exit 1', win, () => {
  const r = dryRun(['-Only', 'CCv3-No-Such-Task']);
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSED/);
});

test('dry run: every Nm with battery:true prints battery=allow while llm stays false, and the other four lines are unchanged', win, () => {
  const r = dryRun();
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.lineOf('CCv3-T-Battery'), /every 5m, limit 5 min, llm=false battery=allow wake=no]$/);
  assert.match(r.lineOf('CCv3-T-Plain'), /llm=false battery=block wake=no]$/);
  assert.match(r.lineOf('CCv3-T-WakeOnly'), /llm=false battery=block wake=yes]$/);
});

test('dry run: a task with hidden:true runs through conhost.exe --headless powershell.exe, with no -WindowStyle', win, () => {
  const r = dryRun();
  const line = r.lineOf('CCv3-T-Battery');
  const conhost = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe').toLowerCase();
  assert.ok(line.toLowerCase().startsWith(`ccv3-t-battery: ${conhost} --headless powershell.exe -noprofile -executionpolicy bypass -file "`), line);
  assert.match(line, / -File ".*e\.ps1"  \[/);
  assert.doesNotMatch(line, /WindowStyle/);
});

test('dry run: the other four tasks keep their exact actions (no conhost, no --headless, no -WindowStyle)', win, () => {
  const r = dryRun();
  assert.match(r.lineOf('CCv3-T-Plain'), /^CCv3-T-Plain: cmd\.exe \/c ".*a\.bat"  \[/);
  assert.match(r.lineOf('CCv3-T-Llm'), /^CCv3-T-Llm: powershell\.exe -NoProfile -ExecutionPolicy Bypass -File ".*b\.ps1"  \[/);
  assert.match(r.lineOf('CCv3-T-LlmWake'), /^CCv3-T-LlmWake: cmd\.exe \/c ".*c\.bat"  \[/);
  assert.match(r.lineOf('CCv3-T-WakeOnly'), /^CCv3-T-WakeOnly: cmd\.exe \/c ".*d\.bat"  \[/);
  for (const n of ['CCv3-T-Plain', 'CCv3-T-Llm', 'CCv3-T-LlmWake', 'CCv3-T-WakeOnly']) assert.doesNotMatch(r.lineOf(n), /conhost|--headless|WindowStyle/, n);
});

test('F4: an every-Nm trigger repeats for ever with NO duration (a MaxValue duration is refused by Register-ScheduledTask on current Windows)', win, () => {
  const r = dryRun();
  assert.equal(r.code, 0, r.out + r.err);
  const repeat = r.lines.filter((l) => /^\s+repeat:/.test(l));
  assert.equal(repeat.length, 1, r.out);
  assert.match(repeat[0], /repeat: every PT5M, duration ''$/, 'the trigger object the script would register has an empty duration');
  assert.doesNotMatch(r.out, /P99999999/);
});

test('dry run: a bad every Nm (0, 1440, a word) is refused before anything is registered', win, () => {
  for (const trigger of ['every 0m', 'every 1440m', 'every 5 minutes']) {
    const r = dryRun([], [{ ...TASKS[4], trigger }]);
    assert.notEqual(r.code, 0, trigger + ': ' + r.out);
    assert.doesNotMatch(r.out, /DRY RUN: nothing changed/);
  }
});

test('dry run on the REAL tasks.json: CCv3-Lane-Snapshot is daily 23:55, allowed on battery, hidden through conhost --headless', win, () => {
  const realTasks = join(dirname(SCRIPT), '..', '..', '..', 'scripts', 'scheduled', 'tasks.json');
  const tasks = JSON.parse(readFileSync(realTasks, 'utf8')).tasks;
  const home = join(mkdtempSync(join(tmpdir(), 'reg-real-')), 'home');
  mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
  for (const t of tasks) writeFileSync(join(home, 'scripts', 'scheduled', basename(t.script)), 'rem stub\r\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TasksFile', realTasks, '-ClaudeHome', home, '-Only', 'CCv3-Lane-Snapshot'],
    { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
  const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('CCv3-Lane-Snapshot:'));
  assert.ok(line, r.stdout);
  const conhost = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe').toLowerCase();
  assert.ok(line.toLowerCase().startsWith(`ccv3-lane-snapshot: ${conhost} --headless powershell.exe -noprofile -executionpolicy bypass -file "`), line);
  assert.match(line, / -File ".*scheduled-lane-snapshot\.ps1"  \[daily 23:55, limit 5 min, llm=false battery=allow wake=no\]$/);
  assert.doesNotMatch(line, /WindowStyle/);
  assert.match(r.stdout, /^DRY RUN: nothing changed/m);
});

test('dry run on the REAL tasks.json: CCv3-FleetOps-Auto is every 30m, allowed on battery, hidden through conhost --headless', win, () => {
  const realTasks = join(dirname(SCRIPT), '..', '..', '..', 'scripts', 'scheduled', 'tasks.json');
  const tasks = JSON.parse(readFileSync(realTasks, 'utf8')).tasks;
  const home = join(mkdtempSync(join(tmpdir(), 'reg-real-')), 'home');
  mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
  for (const t of tasks) writeFileSync(join(home, 'scripts', 'scheduled', basename(t.script)), 'rem stub\r\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TasksFile', realTasks, '-ClaudeHome', home, '-Only', 'CCv3-FleetOps-Auto'],
    { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
  const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('CCv3-FleetOps-Auto:'));
  assert.ok(line, r.stdout);
  const conhost = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'conhost.exe').toLowerCase();
  assert.ok(line.toLowerCase().startsWith(`ccv3-fleetops-auto: ${conhost} --headless powershell.exe -noprofile -executionpolicy bypass -file "`), line);
  assert.match(line, / -File ".*scheduled-fleetops-auto\.ps1"  \[every 30m, limit 5 min, llm=false battery=allow wake=no\]$/);
  assert.doesNotMatch(line, /WindowStyle/);
  assert.match(r.stdout, /^DRY RUN: nothing changed/m);
});

// The active copy (~/.claude/scripts/scheduled) cannot reach the repo by a relative path: scripts/scheduled/tasks.json does not sync.
function runActiveCopy(repoHasTasks, staleHomeTasks = false) {
  const root = mkdtempSync(join(tmpdir(), 'reg-active-'));
  const home = join(root, 'home');
  const active = join(home, 'scripts', 'scheduled');
  mkdirSync(active, { recursive: true });
  const here = dirname(SCRIPT);
  for (const f of ['register-ccv3-tasks.ps1', 'profile-paths.ps1']) copyFileSync(join(here, f), join(active, f));
  writeFileSync(join(active, 'a.bat'), 'rem stub\r\n');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'scheduled'), { recursive: true });
  if (repoHasTasks) writeFileSync(join(repo, 'scripts', 'scheduled', 'tasks.json'), JSON.stringify({ tasks: [TASKS[0]] }));
  // A stale file at the home-level path the old default read (<root>scriptsscheduled	asks.json, three folders above the installed copy).
  if (staleHomeTasks) {
    mkdirSync(join(root, 'scripts', 'scheduled'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'scheduled', 'tasks.json'), JSON.stringify({ tasks: [{ ...TASKS[0], name: 'CCv3-T-Stale' }] }));
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(active, 'register-ccv3-tasks.ps1'), '-ClaudeHome', home],
    { encoding: 'utf8', windowsHide: true, timeout: 90000, env: { ...process.env, CCV3_REPO_ROOT: repo, CCV3_MACHINE_PROFILE: 'no-such-profile-for-test' } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('active copy with no -TasksFile finds the repo tasks.json through profile-paths (CCV3_REPO_ROOT, no machine profile) and lists the task', win, () => {
  // Breaks if the default path stays relative to the script folder: from ~/.claude it points at ~\scripts\scheduled\tasks.json.
  const r = runActiveCopy(true);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CCv3-T-Plain:/);
  assert.match(r.out, /^DRY RUN: nothing changed/m);
});

test('active copy with no tasks.json anywhere is refused with exit 1 and names tasks.json', win, () => {
  // Breaks if the script dies with a raw Get-Content error, or goes on with an empty task list.
  const r = runActiveCopy(false);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[REFUSED\].*tasks\.json/);
});

test('active copy ignores a stale tasks.json at the home-level relative path and uses the configured repo', win, () => {
  // Breaks if the relative default is tried first from the installed copy: a stale file there would register the wrong tasks.
  const r = runActiveCopy(true, true);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CCv3-T-Plain:/);
  assert.doesNotMatch(r.out, /CCv3-T-Stale/);
});

test('dry run on the REAL tasks.json: CCv3-Blocklist-Update is daily 06:30, blocked on battery, no wake (card blocklist-commit-0630)', win, () => {
  // Breaks if the trigger goes back to 09:00: at 09:00 the bot commit moves main during the morning checks.
  const realTasks = join(dirname(SCRIPT), '..', '..', '..', 'scripts', 'scheduled', 'tasks.json');
  const tasks = JSON.parse(readFileSync(realTasks, 'utf8')).tasks;
  const root = mkdtempSync(join(tmpdir(), 'reg-real-'));
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
    for (const t of tasks) writeFileSync(join(home, 'scripts', 'scheduled', basename(t.script)), 'rem stub\r\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-TasksFile', realTasks, '-ClaudeHome', home, '-Only', 'CCv3-Blocklist-Update'],
      { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
    const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('CCv3-Blocklist-Update:'));
    assert.ok(line, r.stdout);
    assert.match(line, /^CCv3-Blocklist-Update: cmd\.exe \/c ".*scheduled-blocklist-update\.bat"  \[daily 06:30, limit 30 min, llm=false battery=block wake=no\]$/);
    assert.match(r.stdout, /^DRY RUN: nothing changed/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
