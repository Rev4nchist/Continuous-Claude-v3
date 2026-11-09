# Nightly cost reconcile (Task Scheduler: CCv3-Cost-Reconcile, daily 23:50 local time, conhost.exe --headless powershell.exe -File <this file>).
# The task is hidden:true in tasks.json: it runs through conhost --headless so Task Scheduler opens no window.
# tasks.json also holds allowedExit [0] and warnExit [10]: the doctor shows exit 10 as a WARN, any other non-zero exit as a FAIL.
# Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# It runs two checks, one after the other. Neither one starts a model: llm=false in tasks.json.
#   1. node scripts/measurement/cost-reconcile.mjs --since-hours 48 --quiet --out <repo>\.claude\cache\e2e\<yyyy-MM-dd>-cost-reconcile-nightly.jsonl
#      The sessions of the last two days: price check, capture check, rolling-20 bands. It reads transcripts and the agent ledger state.
#      The window is 48 h, not 24 h: a missed night (StartWhenAvailable) and a session held back as active at 23:50 stay in range.
#      The rolling window takes each session id once, so the overlap adds nothing twice.
#      Population: the sessions that have a state file in ~\.claude\state\agentic-os. Headless sessions have none and are not checked.
#      It writes the e2e file above and the run-state file (.claude\cache\cost-reconcile\run-state.json) and nothing else.
#      The run-state file is state, not an artifact, so it lives outside .claude\cache\e2e. The wrapper log is the only other write.
#   2. node scripts/pricing/refresh-prices.mjs --check
#      Fetches the pricing page and compares it with prices.json. It exits 1 on drift. It never edits prices.json and never opens a PR:
#      a price change is a human review (method doc 6.3). This wrapper must never run refresh-prices.mjs without --check.
# A failure in one check does not skip the other. Exit code, first match wins:
#   a reconcile code other than 0 and 10 (a failure), else a price check code other than 0, else 10 (a reconcile warn), else 0.
#   reconcile: 0 ok, 10 ok with a warn finding, 1 a fail finding, 2 inputs unreadable or nothing to check, 124 ran past the limit, 3 script not found.
#   price check: 0 clean, 1 drift, 2 the page could not be fetched, 124 limit, 3 script not found.
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at ~/.claude/scripts/scheduled/
# (with profile-paths.ps1 beside it). The scripts live in the repo (scripts\measurement\, scripts\pricing\) and are not synced,
# so this file finds the repo root first:
#   CCV3_COST_RECONCILE_REPO_ROOT (override) > machine profile repoRoot (profile-paths.ps1) > the default checkout.
# The log names the git branch of that checkout, because a scheduled run reads whatever branch is checked out.
#
# Environment overrides, for a test that must not touch the real ~/.claude, the real e2e folder or the primary checkout:
#   CCV3_COST_RECONCILE_REPO_ROOT   repo that holds scripts\measurement\cost-reconcile.mjs and scripts\pricing\refresh-prices.mjs
#   CCV3_COST_RECONCILE_LOG         log file path (default ~/.claude/logs/cost-reconcile/<yyyy-MM-dd>.log)
#   CCV3_COST_RECONCILE_TIMEOUT_SEC time limit of each check in seconds (default 150; the task limit is 10 minutes)
#   CCV3_COST_RECONCILE_EXTRA_ARGS  extra reconcile arguments, e.g. --min-idle-min 0

$logPath = if ($env:CCV3_COST_RECONCILE_LOG) { $env:CCV3_COST_RECONCILE_LOG } else { Join-Path $env:USERPROFILE ('.claude\logs\cost-reconcile\' + (Get-Date -Format 'yyyy-MM-dd') + '.log') }
$logDir = Split-Path -Parent $logPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# Repo root: the override wins. Else the machine profile. If that checkout has no reconcile script, the default checkout.
$reconcileRel = 'scripts\measurement\cost-reconcile.mjs'
$priceRel = 'scripts\pricing\refresh-prices.mjs'
$R = $env:CCV3_COST_RECONCILE_REPO_ROOT
if (-not $R) {
  try {
    . (Join-Path $PSScriptRoot 'profile-paths.ps1')
    $R = (Get-Ccv3Paths 3>$null).RepoRoot
  } catch { $R = $null }
  if (-not ($R -and (Test-Path -LiteralPath (Join-Path $R $reconcileRel)))) { $R = Join-Path $env:USERPROFILE 'continuous-claude' }
}

$branch = 'unknown'
try { $b = (& git -C $R rev-parse --abbrev-ref HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $b) { $branch = "$b".Trim() } } catch { }
Write-Log "starting, repo $R, branch $branch"

# Subscription auth: neither check starts a model, but an API key in the environment must not reach any child.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

$secs = 150
if ($env:CCV3_COST_RECONCILE_TIMEOUT_SEC) { $secs = [int]$env:CCV3_COST_RECONCILE_TIMEOUT_SEC }

# Bounded run of one node script. A Task Scheduler limit kill does not reap the child tree on this machine, so the limit lives here:
# wait, then kill the one child pid. Never taskkill /T. $p.Handle is read first because without it .ExitCode can come back empty,
# which would swallow the exit code. Returns the exit code (3 script not found, 124 timeout).
function Invoke-Check([string]$label, [string]$script, [string]$argLine) {
  if (-not (Test-Path -LiteralPath $script)) {
    Write-Log "ERROR: $label script not found at $script"
    return 3
  }
  Write-Log "$label starting"
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $node -ArgumentList ('"' + $script + '" ' + $argLine) -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $null = $p.Handle
  if ($p.WaitForExit($secs * 1000)) {
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
  return [int]$rc
}

$e2eDir = Join-Path $R '.claude\cache\e2e'
$e2eFile = Join-Path $e2eDir ((Get-Date -Format 'yyyy-MM-dd') + '-cost-reconcile-nightly.jsonl')
$reconcileArgs = '--since-hours 48 --quiet --out "' + $e2eFile + '"'
if ($env:CCV3_COST_RECONCILE_EXTRA_ARGS) { $reconcileArgs = $reconcileArgs + ' ' + $env:CCV3_COST_RECONCILE_EXTRA_ARGS }

$rcReconcile = Invoke-Check 'reconcile' (Join-Path $R $reconcileRel) $reconcileArgs
$rcPrice = Invoke-Check 'price check' (Join-Path $R $priceRel) '--check'
# A reconcile warn (10) must not hide a price drift or a reconcile failure.
$rc = 0
if ($rcReconcile -ne 0 -and $rcReconcile -ne 10) { $rc = $rcReconcile }
elseif ($rcPrice -ne 0) { $rc = $rcPrice }
elseif ($rcReconcile -eq 10) { $rc = 10 }
Write-Log "overall exit $rc"

# Keep 14 days of dated logs and of nightly e2e files. Only files named yyyy-MM-dd.log and yyyy-MM-dd-cost-reconcile-nightly.jsonl are touched.
$cut = (Get-Date).AddDays(-14)
Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}\.log$' -and $_.LastWriteTime -lt $cut } |
  Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $e2eDir) {
  Get-ChildItem -LiteralPath $e2eDir -Filter '*-cost-reconcile-nightly.jsonl' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}-cost-reconcile-nightly\.jsonl$' -and $_.LastWriteTime -lt $cut } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
exit $rc
