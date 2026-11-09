# FleetOps timed export tick (Task Scheduler: CCv3-FleetOps-Auto, every 30 minutes, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs `node scripts/coordination/fleetops-auto-tick.mjs`: export the lane data, hash the 7 dataset files, and clear
# `pending` in refresh.json only when they match the last upload. It never starts claude and never uploads: a headless
# claude -p has no Artifact tool. An interactive session uploads (the fleetops-refresh skill). The tick does nothing at all
# until the file ~/.claude/state/fleetops-auto/auto-enabled exists.
# tasks.json keeps llm=false for this job and sets battery=true (start on battery, keep running on battery).
# Exit code = the tick exit code (0 ok or skipped, 1 error, 124 the tick ran past its limit, 3 fleetops-auto-tick.mjs not found).
# If this wrapper kills the tick at its limit (240 s), tick.lock stays until it is 10 minutes old. Then the next tick takes it over.
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at ~/.claude/scripts/scheduled/.
# fleetops-auto-tick.mjs lives in the repo (scripts\coordination\) and is not synced, so this file finds the repo root first:
#   CCV3_FLEETOPS_REPO_ROOT (override) > machine profile REPO_ROOT > the default checkout.
#
# Environment overrides, for a test that must not touch the real ~/.claude or the primary checkout:
#   CCV3_FLEETOPS_REPO_ROOT   repo that holds scripts\coordination\fleetops-auto-tick.mjs
#   CCV3_FLEETOPS_LOG         log file path (default ~/.claude/logs/CCv3-FleetOps-Auto/<yyyy-MM-dd>.log)
#   CCV3_FLEETOPS_TIMEOUT_SEC tick time limit in seconds (default 240; the task limit is 5 minutes)
#   CCV3_FLEETOPS_EXTRA_ARGS  extra tick arguments, e.g. --record-upload
# The tick itself also reads CCV3_FLEETOPS_AUTO_DIR, CCV3_LANE_DASH_DIR, CCV3_FLEETOPS_AUTO_LOG_DIR and CCV3_FLEETOPS_EXPORT_CMD.

$logPath = if ($env:CCV3_FLEETOPS_LOG) { $env:CCV3_FLEETOPS_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\CCv3-FleetOps-Auto\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# The repo copy of this file is three folders below the repo root. The installed copy is not.
$R = $env:CCV3_FLEETOPS_REPO_ROOT
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

$tickScript = Join-Path $R 'scripts\coordination\fleetops-auto-tick.mjs'
Write-Log "tick starting, repo $R"
if (-not (Test-Path -LiteralPath $tickScript)) {
  Write-Log "ERROR: fleetops-auto-tick.mjs not found at $tickScript"
  exit 3
}

# The tick starts no claude run. The key strip stays so a future change cannot bill the API key by mistake.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

$secs = 240
if ($env:CCV3_FLEETOPS_TIMEOUT_SEC) { $secs = [int]$env:CCV3_FLEETOPS_TIMEOUT_SEC }
$tickArgs = '"' + $tickScript + '"'
if ($env:CCV3_FLEETOPS_EXTRA_ARGS) { $tickArgs = $tickArgs + ' ' + $env:CCV3_FLEETOPS_EXTRA_ARGS }

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
