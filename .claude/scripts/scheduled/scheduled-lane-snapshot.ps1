# Nightly lane snapshot (Task Scheduler: CCv3-Lane-Snapshot, daily 23:55 local time, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs two commands, one after the other, each with no arguments and its own time limit:
#   1. `node scripts/coordination/export-dash-data.mjs`. The export reads the lane board (SELECT only), writes the
#      eight lane-dash JSON documents to its default folder (~/.claude/state/lane-dash) and upserts one row per
#      Chicago day into snapshots.json there. A run at 23:55 puts one row per day in the file, so the daily
#      snapshots add up.
#   2. `node scripts/coordination/export-factory-data.mjs`. It reads four local files (no database) and writes
#      factory.json to the same folder, for the Fleet app. It runs whatever the export exit code: a failed or killed
#      export is no reason to skip it.
# Neither uploads anything or calls a model: llm=false in tasks.json. tasks.json sets battery=true, so the job also
# runs on battery.
# Exit code: the export exit code when it is not 0 (1 a check failed or the database is down, 124 the export ran past
# its limit). Else 5 when the factory step failed (nonzero exit, killed at its limit, or script not found).
# Else 0. 3 = export-dash-data.mjs not found (nothing runs). tasks.json allowedExit [0] makes the health check
# report any nonzero code, so a factory failure shows without a tasks.json change.
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
# ~/.claude/scripts/scheduled/ (with profile-paths.ps1 beside it). The task points at the installed copy.
# export-dash-data.mjs lives in the repo (scripts\coordination\) and is not synced, so this file finds the repo root first:
#   CCV3_LANE_SNAPSHOT_REPO_ROOT (override) > machine profile repoRoot (profile-paths.ps1) > the default checkout.
# The log names the git branch of that checkout, because a scheduled run reads whatever branch is checked out.
#
# Environment overrides, for a test that must not touch the real ~/.claude, the real out folder or the primary checkout:
#   CCV3_LANE_SNAPSHOT_REPO_ROOT   repo that holds scripts\coordination\export-dash-data.mjs
#   CCV3_LANE_SNAPSHOT_LOG         log file path (default ~/.claude/logs/lane-snapshot/<yyyy-MM-dd>.log)
#   CCV3_LANE_SNAPSHOT_TIMEOUT_SEC export time limit in seconds (default 120; the task limit is 5 minutes)
#   CCV3_LANE_SNAPSHOT_EXTRA_ARGS  extra export arguments, e.g. --out <dir>
#   CCV3_FACTORY_TIMEOUT_SEC       factory time limit in seconds (default 60; 120 + 60 is under the 5-minute task limit)
#   CCV3_FACTORY_EXTRA_ARGS        extra factory arguments, e.g. --out <dir>

$logPath = if ($env:CCV3_LANE_SNAPSHOT_LOG) { $env:CCV3_LANE_SNAPSHOT_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\lane-snapshot\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# Repo root: the override wins. Else the machine profile. If that checkout has no export script, the default checkout.
$exportRel = 'scripts\coordination\export-dash-data.mjs'
$R = $env:CCV3_LANE_SNAPSHOT_REPO_ROOT
if (-not $R) {
  try {
    . (Join-Path $PSScriptRoot 'profile-paths.ps1')
    $R = (Get-Ccv3Paths 3>$null).RepoRoot
  } catch { $R = $null }
  if (-not ($R -and (Test-Path -LiteralPath (Join-Path $R $exportRel)))) { $R = Join-Path $env:USERPROFILE 'continuous-claude' }
}

$branch = 'unknown'
try { $b = (& git -C $R rev-parse --abbrev-ref HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $b) { $branch = "$b".Trim() } } catch { }

$export = Join-Path $R $exportRel
Write-Log "export starting, repo $R, branch $branch"
if (-not (Test-Path -LiteralPath $export)) {
  Write-Log "ERROR: export-dash-data.mjs not found at $export"
  exit 3
}

# Subscription auth: the export starts no model, but an API key in the environment must not reach any child.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

# Bounded run. A Task Scheduler limit kill does not reap the child tree on this machine, so the limit lives here:
# wait, then kill the one child pid. Never taskkill /T. $p.Handle is read first because without it .ExitCode
# can come back empty, which would swallow the exit code. Logs every output line, then "<label> finished, exit N".
# The rc is left in $script:boundedRc (a function return value would mix with any stray output).
function Invoke-Bounded([string]$label, [string]$script, [string]$extra, [int]$limit) {
  $argText = '"' + $script + '"'
  if ($extra) { $argText = $argText + ' ' + $extra }
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $node -ArgumentList $argText -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $null = $p.Handle
  if ($p.WaitForExit($limit * 1000)) {
    $rc = $p.ExitCode
  } else {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Write-Log "TIMEOUT: $label killed"
    $rc = 124
  }
  foreach ($f in @($outFile, $errFile)) {
    try { Get-Content -LiteralPath $f -ErrorAction Stop | ForEach-Object { Write-Log "$_" } } catch { }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
  Write-Log "$label finished, exit $rc"
  $script:boundedRc = $rc
}

$secs = 120
if ($env:CCV3_LANE_SNAPSHOT_TIMEOUT_SEC) { $secs = [int]$env:CCV3_LANE_SNAPSHOT_TIMEOUT_SEC }
Invoke-Bounded 'export' $export $env:CCV3_LANE_SNAPSHOT_EXTRA_ARGS $secs
$rc = $script:boundedRc

# The factory runs whatever the export exit code was (0, nonzero, or 124 after a kill): its four files need no database.
$factoryRel = 'scripts\coordination\export-factory-data.mjs'
$factory = Join-Path $R $factoryRel
$factoryRc = 0
if (Test-Path -LiteralPath $factory) {
  $fsecs = 60
  if ($env:CCV3_FACTORY_TIMEOUT_SEC) { $fsecs = [int]$env:CCV3_FACTORY_TIMEOUT_SEC }
  Write-Log 'factory starting'
  Invoke-Bounded 'factory' $factory $env:CCV3_FACTORY_EXTRA_ARGS $fsecs
  $factoryRc = $script:boundedRc
} else {
  Write-Log "ERROR: export-factory-data.mjs not found at $factory"
  $factoryRc = 5
}

# Exit: the export code when it is not 0, else 5 for a failed factory step, else 0.
$exitCode = $rc
if ($rc -eq 0 -and $factoryRc -ne 0) { $exitCode = 5 }

# Keep 14 days of dated logs. Only files named yyyy-MM-dd.log are touched.
Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit $exitCode
