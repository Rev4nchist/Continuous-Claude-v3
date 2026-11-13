# Open-PR snapshot (Task Scheduler: CCv3-Open-PRs, every 15 minutes, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs one command with no arguments and a time limit: `node scripts\github\open-prs.mjs` (card prflow-open-prs).
# The script lists the open pull requests of the repo, runs review-status on each as a child, and writes open-prs.json to
# ~/.claude/state/lane-dash for the Fleet app. It calls no model (llm=false in tasks.json) and uploads nothing.
#
# Overlap: the named mutex Local\CCv3-Open-PRs is taken first. A second copy logs "already running, exiting" and exits 0.
# open-prs.mjs has its own lock file with a dead-pid rule, for a run that was killed or started by hand.
# Temp files: the child output is redirected into <log folder>\open-prs.<pid>.out.tmp and .err.tmp, never into %TEMP%.
# They are copied into the log and deleted.
# Time limit: CCV3_OPEN_PRS_TIMEOUT_SEC (default 540, under the 10 minute task limit). A Task Scheduler limit kill does not reap
# the child tree on this machine, so the limit lives here. On a timeout the wrapper dot-sources scripts\lib\Stop-ProcessTree.ps1
# from the repo and kills the whole tree (node, then the gh and review-status children). With no helper it kills the one pid.
# Never taskkill /T.
#
# Exit code: the exit code of open-prs.mjs. 0 = written, or skipped because a run holds the lock or the mutex.
# 10 = gh failed or hit a rate limit and the old file was kept (tasks.json warnExit [10] shows it as a doctor WARN).
# 1 = write failure. 3 = open-prs.mjs not found (nothing runs). 124 = killed at the time limit.
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at ~/.claude/scripts/scheduled/
# (with profile-paths.ps1 beside it). open-prs.mjs lives in the repo (scripts\github\) and is not synced, so this file finds the
# repo root first: CCV3_OPEN_PRS_REPO_ROOT (override) > machine profile repoRoot (profile-paths.ps1) > the default checkout.
#
# Environment overrides, for a test that must not touch the real ~/.claude, the real out folder or the primary checkout:
#   CCV3_OPEN_PRS_REPO_ROOT    repo that holds scripts\github\open-prs.mjs
#   CCV3_OPEN_PRS_LOG          log file path (default ~/.claude/logs/open-prs/<yyyy-MM-dd>.log)
#   CCV3_OPEN_PRS_TIMEOUT_SEC  time limit in seconds (default 540)
#   CCV3_OPEN_PRS_EXTRA_ARGS   extra open-prs arguments, e.g. --out <dir> --cap 5
#   CCV3_OPEN_PRS_MUTEX        mutex name (default Local\CCv3-Open-PRs). Tests set a unique name so a live run cannot block them.

$logPath = if ($env:CCV3_OPEN_PRS_LOG) { $env:CCV3_OPEN_PRS_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\open-prs\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# Overlap guard, before anything else. An abandoned mutex (the owner was killed) counts as acquired.
$mutexName = if ($env:CCV3_OPEN_PRS_MUTEX) { $env:CCV3_OPEN_PRS_MUTEX } else { 'Local\CCv3-Open-PRs' }
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) {
  Write-Log 'already running, exiting'
  exit 0
}

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# Repo root: the override wins. Else the machine profile. If that checkout has no script, the default checkout.
$scriptRel = 'scripts\github\open-prs.mjs'
$R = $env:CCV3_OPEN_PRS_REPO_ROOT
if (-not $R) {
  try {
    . (Join-Path $PSScriptRoot 'profile-paths.ps1')
    $R = (Get-Ccv3Paths 3>$null).RepoRoot
  } catch { $R = $null }
  if (-not ($R -and (Test-Path -LiteralPath (Join-Path $R $scriptRel)))) { $R = Join-Path $env:USERPROFILE 'continuous-claude' }
}

$branch = 'unknown'
try { $b = (& git -C $R rev-parse --abbrev-ref HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $b) { $branch = "$b".Trim() } } catch { }

# Subscription auth: open-prs starts no model, but an API key in the environment must not reach any child.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

# Kills the child tree: the repo helper when it exists, else the one pid. The one-pid kill also runs after the helper, as a backstop.
function Stop-Child([int]$childId) {
  $helper = Join-Path $R 'scripts\lib\Stop-ProcessTree.ps1'
  if (Test-Path -LiteralPath $helper) {
    try { . $helper; $null = Stop-ProcessTree -RootId $childId } catch { Write-Log "tree kill failed: $($_.Exception.Message)" }
  }
  Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
}

# Bounded run. $p.Handle is read first because without it .ExitCode can come back empty, which would swallow the exit code.
# Logs every output line, then "<label> finished, exit N". The rc is left in $script:boundedRc.
function Invoke-Bounded([string]$label, [string]$script, [string]$extra, [int]$limit) {
  $argText = '"' + $script + '"'
  if ($extra) { $argText = $argText + ' ' + $extra }
  $outFile = Join-Path $logDir ('open-prs.' + $PID + '.out.tmp')
  $errFile = Join-Path $logDir ('open-prs.' + $PID + '.err.tmp')
  $p = Start-Process -FilePath $node -ArgumentList $argText -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $null = $p.Handle
  if ($p.WaitForExit($limit * 1000)) {
    $rc = $p.ExitCode
  } else {
    Stop-Child $p.Id
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

$exitCode = 0
$script_ = Join-Path $R $scriptRel
try {
  Write-Log "open-prs starting, repo $R, branch $branch"
  if (-not (Test-Path -LiteralPath $script_)) {
    Write-Log "ERROR: open-prs.mjs not found at $script_"
    $exitCode = 3
  } else {
    $secs = 540
    if ($env:CCV3_OPEN_PRS_TIMEOUT_SEC) { $secs = [int]$env:CCV3_OPEN_PRS_TIMEOUT_SEC }
    Invoke-Bounded 'open-prs' $script_ $env:CCV3_OPEN_PRS_EXTRA_ARGS $secs
    $exitCode = $script:boundedRc
  }
  # Keep 14 days of dated logs. Only files named yyyy-MM-dd.log are touched.
  Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
exit $exitCode
