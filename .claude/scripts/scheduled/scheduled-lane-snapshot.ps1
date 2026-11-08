# Nightly lane snapshot (Task Scheduler: CCv3-Lane-Snapshot, daily 23:55 local time, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs `node scripts/coordination/export-dash-data.mjs` with no arguments. The export reads the lane board
# (SELECT only), writes the seven lane-dash JSON documents to its default folder (~/.claude/state/lane-dash)
# and upserts one row per Chicago day into snapshots.json there. A run at 23:55 puts one row per day in the file,
# so the daily snapshots add up. It uploads nothing and calls no model: llm=false in tasks.json.
# tasks.json sets battery=true, so the job also runs on battery.
# Exit code = the export exit code (0 ok, 1 a check failed or the database is down, 124 the export ran past its limit,
# 3 export-dash-data.mjs not found).
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

$secs = 120
if ($env:CCV3_LANE_SNAPSHOT_TIMEOUT_SEC) { $secs = [int]$env:CCV3_LANE_SNAPSHOT_TIMEOUT_SEC }
$exportArgs = '"' + $export + '"'
if ($env:CCV3_LANE_SNAPSHOT_EXTRA_ARGS) { $exportArgs = $exportArgs + ' ' + $env:CCV3_LANE_SNAPSHOT_EXTRA_ARGS }

# Bounded run. A Task Scheduler limit kill does not reap the child tree on this machine, so the limit lives here:
# wait, then kill the one child pid. Never taskkill /T. $p.Handle is read first because without it .ExitCode
# can come back empty, which would swallow the export exit code.
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $node -ArgumentList $exportArgs -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$null = $p.Handle
if ($p.WaitForExit($secs * 1000)) {
  $rc = $p.ExitCode
} else {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Write-Log 'TIMEOUT: export killed'
  $rc = 124
}
foreach ($f in @($outFile, $errFile)) {
  try { Get-Content -LiteralPath $f -ErrorAction Stop | ForEach-Object { Write-Log "$_" } } catch { }
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
}
Write-Log "export finished, exit $rc"

# Keep 14 days of dated logs. Only files named yyyy-MM-dd.log are touched.
Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
exit $rc
