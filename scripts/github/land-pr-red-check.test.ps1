# Wiring test for the red-CI-check gate in land-pr.ps1 under -IgnoreReview.
# Run: pwsh -NoProfile -File scripts/github/land-pr-red-check.test.ps1
#
# -IgnoreReview skips the review wait (READY check, pre-merge re-check). It must NEVER skip a red CI check:
# branch protection is not available on this repo (REST 403, private repo, free plan), so land-pr.ps1 is the only gate.
# land-pr.ps1 runs as a child process with stub gh.cmd and node.cmd first on PATH. No real gh, node helper or network.
#   stub gh:   serves the PR, the check runs and the commit statuses of the head; a PUT to .../merge writes merge.flag.
#   stub node: land-none-check.mjs and migration-gate.mjs answer exit 0.
# Failure modes:
#   a failed check run on the head does not stop the merge under -IgnoreReview            -> R1 (failure, timed_out, startup_failure, action_required)
#   a failed or errored commit status on the head does not stop the merge                 -> R2
#   the gate blocks a PR whose checks are green, skipped, neutral, cancelled or running   -> R3 (over-blocking)
#   the gate counts a review bot (Greptile check run, CodeRabbit status) as a CI failure  -> R4 (-IgnoreReview must still skip review results)
#   a check read that fails (gh exit 1) or is cut off (more runs than one page) merges    -> R5, R6 (fail closed)
#   the refusal does not name the red check, or does not say nothing was merged           -> R1
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'land-pr.ps1'
$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}

$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ('land-pr-red-check-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$oldPath = $env:PATH
# land-pr.ps1 takes a lock before the merge: point it, its log and the sync cursor at the temp folder, never at ~/.claude.
$env:CCV3_LAND_LOCK = Join-Path $work 'land.lock'; $env:CCV3_LAND_LOCK_LOG = Join-Path $work 'land-lock.log'; $env:CCV3_SYNC_CURSOR = Join-Path $work 'sync-cursor'
$sha = '0123456789abcdef0123456789abcdef01234567'
$branch = 'fix/red-check-wiring'
$prUrl = 'repos/Rev4nchist/Continuous-Claude-v3/pulls/7'
$runsUrl = "repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/check-runs?per_page=100"
$statusUrl = "repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/status?per_page=100"

function New-Run([string]$name, [string]$status, $conclusion, [string]$app = 'github-actions') {
  @{ id = 1; name = $name; status = $status; conclusion = $conclusion; app = @{ slug = $app } }
}

# $runs: check run objects. $statuses: commit status objects. -RunsTotal overrides total_count (a cut-off page). -RunsExit is the exit code of the check-runs read.
function New-Case([string]$name, [object[]]$runs = @(), [object[]]$statuses = @(), [int]$runsTotal = -1, [int]$runsExit = 0) {
  $dir = Join-Path $work $name; $stub = Join-Path $dir 'stub'; $repo = Join-Path $dir 'repo'; $remote = Join-Path $dir 'fork.git'
  New-Item -ItemType Directory -Force -Path $stub, $repo | Out-Null
  git init -q -b main $repo 2>&1 | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
  git -C $repo add -A 2>&1 | Out-Null
  git -C $repo -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c core.hooksPath=NUL commit -q -m init 2>&1 | Out-Null
  git init -q --bare -b main $remote 2>&1 | Out-Null
  git -C $repo remote add fork $remote
  git -C $repo push -q fork main 2>&1 | Out-Null
  $pull = { param($merged) (@{ merged = $merged; head = @{ ref = $branch; sha = $sha } } | ConvertTo-Json -Compress) }
  Set-Content -LiteralPath (Join-Path $stub 'pull.json') -Value (& $pull $false)
  Set-Content -LiteralPath (Join-Path $stub 'merged.json') -Value (& $pull $true)
  $total = if ($runsTotal -ge 0) { $runsTotal } else { $runs.Count }
  Set-Content -LiteralPath (Join-Path $stub 'runs.json') -Value (@{ total_count = $total; check_runs = @($runs) } | ConvertTo-Json -Compress -Depth 6)
  Set-Content -LiteralPath (Join-Path $stub 'runs-exit.txt') -Value $runsExit
  Set-Content -LiteralPath (Join-Path $stub 'status.json') -Value (@{ state = 'success'; total_count = $statuses.Count; statuses = @($statuses) } | ConvertTo-Json -Compress -Depth 6)
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$runsUrl`" goto runs",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$statusUrl`" goto status",
    'echo stub gh: unexpected arguments: %* 1>&2',
    'exit /b 1',
    ':merge',
    'echo merged> "%~dp0merge.flag"',
    'echo {}',
    'exit /b 0',
    ':pull',
    'if exist "%~dp0merge.flag" (type "%~dp0merged.json") else (type "%~dp0pull.json")',
    'exit /b 0',
    ':runs',
    'set /p rcode=<"%~dp0runs-exit.txt"',
    'if not "%rcode%"=="0" (echo stub gh: check-runs read failed 1>&2 & exit /b %rcode%)',
    'type "%~dp0runs.json"',
    'exit /b 0',
    ':status',
    'type "%~dp0status.json"',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"land-none-check" >nul && exit /b 0',
    'echo %~1| findstr /c:"migration-gate" >nul && exit /b 0',
    'echo stub node: unexpected arguments: %* 1>&2',
    'exit /b 9')
  [pscustomobject]@{ Dir = $dir; Stub = $stub; Repo = $repo; Merge = (Join-Path $stub 'merge.flag') }
}

function Invoke-Land($case) {
  $env:PATH = "$($case.Stub);$oldPath"
  $found = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($found -ne (Join-Path $case.Stub 'gh.cmd')) { throw "harness: gh resolves to '$found', not the stub; stopping before any real gh call" }
  # The script runs from a copy in a temp "own root", so the decisions.enforce of this checkout never applies.
  $own = Join-Path $case.Dir 'own'; $ownGithub = Join-Path $own 'scripts\github'
  New-Item -ItemType Directory -Force -Path $ownGithub | Out-Null
  Copy-Item -LiteralPath $script -Destination (Join-Path $ownGithub 'land-pr.ps1') -Force
  $out = & pwsh -NoProfile -File (Join-Path $ownGithub 'land-pr.ps1') -Pr 7 -NoSync -IgnoreReview -RepoPath $case.Repo 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
}

try {
  # R1: a red check run blocks the land under -IgnoreReview
  foreach ($conclusion in 'failure', 'timed_out', 'startup_failure', 'action_required') {
    $c1 = New-Case "r1-$conclusion" @((New-Run 'build' 'completed' 'success'), (New-Run 'unit-tests' 'completed' $conclusion))
    $r1 = Invoke-Land $c1
    Check "R1 $conclusion run: land-pr exits non-zero and makes no merge call" ($r1.Code -ne 0 -and -not (Test-Path $c1.Merge))
    Check "R1 $conclusion run: output names the check and says nothing was merged" ($r1.Text -match 'unit-tests' -and $r1.Text -match 'Nothing was merged')
  }

  # R2: a failed or errored commit status blocks too
  foreach ($state in 'failure', 'error') {
    $c2 = New-Case "r2-$state" @() @(@{ context = 'ci/legacy'; state = $state })
    $r2 = Invoke-Land $c2
    Check "R2 $state status: land-pr exits non-zero and makes no merge call" ($r2.Code -ne 0 -and -not (Test-Path $c2.Merge))
    Check "R2 $state status: output names the status and says nothing was merged" ($r2.Text -match 'ci/legacy' -and $r2.Text -match 'Nothing was merged')
  }

  # R3: green, skipped, neutral, cancelled and still-running checks do not block
  $c3 = New-Case 'r3' @((New-Run 'build' 'completed' 'success'), (New-Run 'lint' 'completed' 'skipped'), (New-Run 'docs' 'completed' 'neutral'), (New-Run 'old' 'completed' 'cancelled'), (New-Run 'slow' 'in_progress' $null)) @(@{ context = 'ci/legacy'; state = 'success' })
  $r3 = Invoke-Land $c3
  Check 'R3 no red check: the merge call was made and land-pr exits 0' ((Test-Path $c3.Merge) -and $r3.Code -eq 0)

  # R4: review bots are review results, not CI: -IgnoreReview still skips them
  $c4 = New-Case 'r4' @((New-Run 'build' 'completed' 'success'), (New-Run 'Greptile Review' 'completed' 'failure' 'greptile-apps')) @(@{ context = 'CodeRabbit'; state = 'failure' })
  $r4 = Invoke-Land $c4
  Check 'R4 review bots: a failed Greptile check and CodeRabbit status do not block under -IgnoreReview' ((Test-Path $c4.Merge) -and $r4.Code -eq 0)

  # R5: the check read fails: fail closed
  $c5 = New-Case 'r5' @() @() -1 1
  $r5 = Invoke-Land $c5
  Check 'R5 read error: land-pr exits non-zero, makes no merge call, says nothing was merged' ($r5.Code -ne 0 -and -not (Test-Path $c5.Merge) -and $r5.Text -match 'Nothing was merged')

  # R6: more runs than the page holds: fail closed
  $c6 = New-Case 'r6' @((New-Run 'build' 'completed' 'success')) @() 150
  $r6 = Invoke-Land $c6
  Check 'R6 cut-off page: land-pr exits non-zero and makes no merge call' ($r6.Code -ne 0 -and -not (Test-Path $c6.Merge))
}
finally {
  $env:PATH = $oldPath
  Remove-Item Env:\CCV3_LAND_LOCK, Env:\CCV3_LAND_LOCK_LOG, Env:\CCV3_SYNC_CURSOR -ErrorAction SilentlyContinue
  $full = [System.IO.Path]::GetFullPath($work)
  if ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-red-check-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "passed=$pass failed=$fail"
exit $fail
