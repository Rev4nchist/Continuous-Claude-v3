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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'scripts', 'scheduled', 'register-ccv3-tasks.ps1');
const TASKS = [
  { name: 'CCv3-T-Plain', script: '.claude/scripts/scheduled/a.bat', trigger: 'daily 07:50', execLimitMin: 10, allowedExit: [0], maxAgeHours: 48 },
  { name: 'CCv3-T-Llm', script: '.claude/scripts/scheduled/b.ps1', trigger: 'weekly Monday 09:20', execLimitMin: 15, allowedExit: [0], maxAgeHours: 336, llm: true, wake: false },
  { name: 'CCv3-T-LlmWake', script: '.claude/scripts/scheduled/c.bat', trigger: 'daily 08:10', execLimitMin: 20, allowedExit: [0], maxAgeHours: 48, llm: true, wake: true },
  { name: 'CCv3-T-WakeOnly', script: '.claude/scripts/scheduled/d.bat', trigger: 'daily 08:30', execLimitMin: 5, allowedExit: [0], maxAgeHours: 48, llm: false, wake: true },
];

function dryRun(extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'reg-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'scripts', 'scheduled'), { recursive: true });
  for (const f of ['a.bat', 'b.ps1', 'c.bat', 'd.bat']) writeFileSync(join(home, 'scripts', 'scheduled', f), 'rem stub\r\n');
  const tasksFile = join(root, 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify({ tasks: TASKS }));
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
