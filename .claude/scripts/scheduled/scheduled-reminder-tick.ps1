# Lane reminder tick (Task Scheduler: CCv3-Reminder-Tick, every 5 minutes, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window. The 2026-11-07 live test showed no flash.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs `node scripts/coordination/lane.mjs remind tick`: fire the reminders that are due, write the lane events,
# toast P0 and P1, write the heartbeat. The Notion sync is OFF until `lane.mjs remind sync on` makes the file sync-enabled in the
# state folder. While it is off, the tick never starts claude. When it is on and a row needs a Notion sync (or the Done-poll, every
# 2 hours, is due and a fired reminder is open), the tick starts ONE headless `claude -p` (at most 12 a day for this job; reminder-sync.mjs).
# tasks.json keeps llm=false for this job and sets battery=true: llm=true is for jobs that always run claude, and battery=true
# gives the same power settings (start on battery, keep running on battery).
# Orphan note: the sync kills its own claude child at 180 s. If THIS wrapper kills the tick at its limit (240 s), a claude child
# can keep running until it exits by itself (its timer died with the tick), and tick.lock stays until it is 10 minutes old.
# Then the next tick takes the lock over. The 180 s sync limit sits well below 240 s, so this happens only on a hang.
# Exit code = the tick exit code (0 ok, 2 database down or migration 0005 missing, 124 the tick ran past its limit,
# 3 lane.mjs not found).
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
# ~/.claude/scripts/scheduled/ (with reminder-toast.ps1 beside it). The task points at the installed copy.
# lane.mjs lives in the repo (scripts\coordination\) and is not synced, so this file finds the repo root first:
#   CCV3_REMINDER_REPO_ROOT (override) > machine profile REPO_ROOT > the default checkout.
#
# Environment overrides, for a test that must not touch the real ~/.claude or the primary checkout:
#   CCV3_REMINDER_REPO_ROOT   repo that holds scripts\coordination\lane.mjs
#   CCV3_REMINDER_LOG         log file path (default ~/.claude/logs/reminder-tick/<yyyy-MM-dd>.log)
#   CCV3_REMINDER_TIMEOUT_SEC tick time limit in seconds (default 240; the task limit is 5 minutes)
#   CCV3_REMINDER_EXTRA_ARGS  extra tick arguments, e.g. --dry-run --no-sync
# The tick itself also reads CCV3_REMINDER_STATE_DIR and CCV3_REMINDER_TOAST_ARGS from the environment.

$logPath = if ($env:CCV3_REMINDER_LOG) { $env:CCV3_REMINDER_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\reminder-tick\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# The repo copy of this file is three folders below the repo root. The installed copy is not.
$R = $env:CCV3_REMINDER_REPO_ROOT
if (-not $R) {
  $boot = if ($PSScriptRoot) { [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) } else { '' }
  $profileScript = if ($boot) { Join-Path $boot 'scripts\settings\machine-profile.mjs' } else { '' }
  if (-not ($profileScript -and (Test-Path $profileScript))) {
    $boot = Join-Path $env:USERPROFILE 'continuous-claude'
    $profileScript = Join-Path $boot 'scripts\settings\machine-profile.mjs'
  }
  $R = $boot
  foreach ($line in @(& $node $profileScript --export bat --quiet 2>$null)) {
    if ("$line" -match '^REPO_ROOT=(.+)$') { $R = $Matches[1].Trim() }
  }
}

$lane = Join-Path $R 'scripts\coordination\lane.mjs'
Write-Log "tick starting, repo $R"
if (-not (Test-Path -LiteralPath $lane)) {
  Write-Log "ERROR: lane.mjs not found at $lane"
  exit 3
}

# Subscription auth: an API key in the environment would switch billing for any headless run the tick starts.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
# The tick shows toasts through this script, which sits beside the wrapper.
$env:CCV3_REMINDER_TOAST_SCRIPT = Join-Path $PSScriptRoot 'reminder-toast.ps1'

$secs = 240
if ($env:CCV3_REMINDER_TIMEOUT_SEC) { $secs = [int]$env:CCV3_REMINDER_TIMEOUT_SEC }
$tickArgs = '"' + $lane + '" remind tick'
if ($env:CCV3_REMINDER_EXTRA_ARGS) { $tickArgs = $tickArgs + ' ' + $env:CCV3_REMINDER_EXTRA_ARGS }

# Bounded run. A Task Scheduler limit kill does not reap the child tree on this machine, so the limit lives here:
# wait, then kill the one child pid. Never taskkill /T. $p.Handle is read first because without it .ExitCode
# can come back empty, which would swallow the tick exit code.
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $node -ArgumentList $tickArgs -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$null = $p.Handle
if ($p.WaitForExit($secs * 1000)) {
  $rc = $p.ExitCode
} else {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Log 'TIMEOUT: tick killed'
  $rc = 124
}
foreach ($f in @($outFile, $errFile)) {
  try { Get-Content -LiteralPath $f -ErrorAction Stop | ForEach-Object { Write-Log "$_" } } catch { }
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
}
Write-Log "tick finished, exit $rc"

# Keep 14 days of dated logs. Only files named yyyy-MM-dd.log are touched.
Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit $rc
