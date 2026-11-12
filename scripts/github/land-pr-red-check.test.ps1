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
#   only page 1 is read: a red run (P1) or status (P4) on page 2 is missed, or a green PR with two pages is refused (P2)
#   a failed read of page 2 does not stop the land                                         -> P3 (fail closed)
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
$runsUrl = "repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/check-runs?per_page"   # cmd.exe splits an unquoted argument at "=", so a stub sees %~2 up to "?per_page"
$statusUrl = "repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/status?per_page"

# -Id is the check-run id (a re-run has a higher id). -WorkflowRun is the Actions run id inside details_url (a re-run keeps it).
function New-Run([string]$name, [string]$status, $conclusion, [string]$app = 'github-actions', [long]$id = 1, [string]$workflowRun = '') {
  $r = @{ id = $id; name = $name; status = $status; conclusion = $conclusion; app = @{ slug = $app } }
  if ($workflowRun) { $r.details_url = "https://github.com/Rev4nchist/Continuous-Claude-v3/actions/runs/$workflowRun/job/$id" }
  $r
}

# The required CI jobs, read from review-status.mjs of this checkout with the real node (the test holds no copy of the names).
$realNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$reviewStatusUrl = ([Uri](Join-Path $PSScriptRoot 'review-status.mjs')).AbsoluteUri
$requiredNames = @('import(process.argv.at(-1)).then(m => console.log(JSON.stringify(m.REQUIRED_CHECK_RUNS)))' | & $realNode --input-type=module - $reviewStatusUrl | ConvertFrom-Json)
if ($requiredNames.Count -lt 2 -or -not $requiredNames[1]) { throw 'harness: could not read REQUIRED_CHECK_RUNS from review-status.mjs' }
# One green run of every required job (workflow run 500), except the names in -Skip.
function New-Required([string[]]$Skip = @()) {
  $i = 100
  foreach ($n in $requiredNames) { $i++; if ($n -notin $Skip) { New-Run $n 'completed' 'success' 'github-actions' $i '500' } }
}

# $runs: check run objects. $statuses: commit status objects. -RunsTotal overrides total_count (a cut-off page). -RunsExit is the exit code of the check-runs read.
# -Page2Runs / -Page2Statuses: a second page. A plain read gets page 1 only (as the real API does); "--paginate --slurp" gets an array of every page.
# -SlurpExit: exit code of the paginated check-runs read only (gh fails on page 2).
# -ReqOverride: the text the stub node prints for the read of the required job names (default: the real node reads review-status.mjs). -ReqExit: its exit code.
function New-Case([string]$name, [object[]]$runs = @(), [object[]]$statuses = @(), [int]$runsTotal = -1, [int]$runsExit = 0, [object[]]$page2Runs = $null, [object[]]$page2Statuses = $null, [int]$slurpExit = 0, [object]$reqOverride = $null, [int]$reqExit = 0) {   # [object]: a [string] parameter turns $null into ''
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
  $total = if ($runsTotal -ge 0) { $runsTotal } else { @($runs).Count + $(if ($null -ne $page2Runs) { @($page2Runs).Count } else { 0 }) }
  $page1 = @{ total_count = $total; check_runs = @($runs) } | ConvertTo-Json -Compress -Depth 6
  $pages = @($page1)
  if ($null -ne $page2Runs) { $pages += (@{ total_count = $total; check_runs = @($page2Runs) } | ConvertTo-Json -Compress -Depth 6) }
  Set-Content -LiteralPath (Join-Path $stub 'runs.json') -Value $page1
  Set-Content -LiteralPath (Join-Path $stub 'runs-slurp.json') -Value ('[' + ($pages -join ',') + ']')
  Set-Content -LiteralPath (Join-Path $stub 'runs-exit.txt') -Value $runsExit
  Set-Content -LiteralPath (Join-Path $stub 'slurp-exit.txt') -Value $slurpExit
  $stTotal = @($statuses).Count + $(if ($null -ne $page2Statuses) { @($page2Statuses).Count } else { 0 })
  $stPage1 = @{ state = 'success'; total_count = $stTotal; statuses = @($statuses) } | ConvertTo-Json -Compress -Depth 6
  $stPages = @($stPage1)
  if ($null -ne $page2Statuses) { $stPages += (@{ state = 'success'; total_count = $stTotal; statuses = @($page2Statuses) } | ConvertTo-Json -Compress -Depth 6) }
  Set-Content -LiteralPath (Join-Path $stub 'status.json') -Value $stPage1
  Set-Content -LiteralPath (Join-Path $stub 'status-slurp.json') -Value ('[' + ($stPages -join ',') + ']')
  if ($null -ne $reqOverride) {
    Set-Content -LiteralPath (Join-Path $stub 'req-override.txt') -Value $reqOverride
    Set-Content -LiteralPath (Join-Path $stub 'req-exit.txt') -Value $reqExit
  }
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %* >> "%~dp0calls.log"',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$runsUrl`" goto runs",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$statusUrl`" goto status",
    "if `"%~1`"==`"api`" if `"%~2`"==`"--paginate`" if `"%~3`"==`"--slurp`" if `"%~4`"==`"$runsUrl`" goto runsslurp",
    "if `"%~1`"==`"api`" if `"%~2`"==`"--paginate`" if `"%~3`"==`"--slurp`" if `"%~4`"==`"$statusUrl`" goto statusslurp",
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
    'exit /b 0',
    ':runsslurp',
    'set /p rcode=<"%~dp0runs-exit.txt"',
    'if not "%rcode%"=="0" (echo stub gh: check-runs read failed 1>&2 & exit /b %rcode%)',
    'set /p scode=<"%~dp0slurp-exit.txt"',
    'if not "%scode%"=="0" (echo stub gh: check-runs page 2 read failed 1>&2 & exit /b %scode%)',
    'type "%~dp0runs-slurp.json"',
    'exit /b 0',
    ':statusslurp',
    'type "%~dp0status-slurp.json"',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"land-none-check" >nul && exit /b 0',
    'echo %~1| findstr /c:"migration-gate" >nul && exit /b 0',
    'echo %~1| findstr /c:"input-type" >nul && goto reqlist',
    'echo stub node: unexpected arguments: %* 1>&2',
    'exit /b 9',
    # The read of the required job names (stdin script, no shell special characters in the arguments): the real node, or the override text of the case.
    ':reqlist',
    'if exist "%~dp0req-override.txt" goto reqover',
    "`"$realNode`" %*",
    'exit /b %errorlevel%',
    ':reqover',
    'type "%~dp0req-override.txt"',
    'set /p ec=<"%~dp0req-exit.txt"',
    'exit /b %ec%')
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
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'review-status.mjs') -Destination (Join-Path $ownGithub 'review-status.mjs') -Force   # the land step reads the job names from the file beside it
  $out = & pwsh -NoProfile -File (Join-Path $ownGithub 'land-pr.ps1') -Pr 7 -NoSync -IgnoreReview -RepoPath $case.Repo 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
}

try {
  # R1: a red check run blocks the land under -IgnoreReview
  foreach ($conclusion in 'failure', 'timed_out', 'startup_failure', 'action_required') {
    $c1 = New-Case "r1-$conclusion" (@(New-Required) + @((New-Run 'build' 'completed' 'success'), (New-Run 'unit-tests' 'completed' $conclusion)))
    $r1 = Invoke-Land $c1
    Check "R1 $conclusion run: land-pr exits non-zero and makes no merge call" ($r1.Code -ne 0 -and -not (Test-Path $c1.Merge))
    Check "R1 $conclusion run: output names the check and says nothing was merged" ($r1.Text -match 'unit-tests' -and $r1.Text -match 'Nothing was merged')
  }

  # R2: a failed or errored commit status blocks too
  foreach ($state in 'failure', 'error') {
    $c2 = New-Case "r2-$state" @(New-Required) @(@{ context = 'ci/legacy'; state = $state })
    $r2 = Invoke-Land $c2
    Check "R2 $state status: land-pr exits non-zero and makes no merge call" ($r2.Code -ne 0 -and -not (Test-Path $c2.Merge))
    Check "R2 $state status: output names the status and says nothing was merged" ($r2.Text -match 'ci/legacy' -and $r2.Text -match 'Nothing was merged')
  }

  # R3: green, skipped, neutral, cancelled and still-running checks do not block
  $c3 = New-Case 'r3' (@(New-Required) + @((New-Run 'build' 'completed' 'success'), (New-Run 'lint' 'completed' 'skipped'), (New-Run 'docs' 'completed' 'neutral'), (New-Run 'old' 'completed' 'cancelled'), (New-Run 'slow' 'in_progress' $null))) @(@{ context = 'ci/legacy'; state = 'success' })
  $r3 = Invoke-Land $c3
  Check 'R3 no red check: the merge call was made and land-pr exits 0' ((Test-Path $c3.Merge) -and $r3.Code -eq 0)

  # R4: review bots are review results, not CI: -IgnoreReview still skips them
  $c4 = New-Case 'r4' (@(New-Required) + @((New-Run 'build' 'completed' 'success'), (New-Run 'Greptile Review' 'completed' 'failure' 'greptile-apps'))) @(@{ context = 'CodeRabbit'; state = 'failure' })
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

  # P1: the red check run is on page 2: the land refuses and names it
  $p1 = New-Case 'p1' (@(New-Required) + @((New-Run 'build' 'completed' 'success'), (New-Run 'lint' 'completed' 'success'))) @() -1 0 @((New-Run 'unit-tests' 'completed' 'failure'))
  $rp1 = Invoke-Land $p1
  Check 'P1 red run on page 2: land-pr exits non-zero, makes no merge call, names the check and says nothing was merged' ($rp1.Code -ne 0 -and -not (Test-Path $p1.Merge) -and $rp1.Text -match 'unit-tests' -and $rp1.Text -match 'Nothing was merged')

  # P2: two pages, every check green: the check gate does not refuse
  $p2 = New-Case 'p2' (@(New-Required) + @((New-Run 'build' 'completed' 'success'), (New-Run 'lint' 'completed' 'success'))) @() -1 0 @((New-Run 'unit-tests' 'completed' 'success'))
  $rp2 = Invoke-Land $p2
  Check 'P2 green on two pages: the merge call was made and land-pr exits 0' ((Test-Path $p2.Merge) -and $rp2.Code -eq 0)

  # P3: the read of page 2 fails: fail closed
  $p3 = New-Case 'p3' @((New-Run 'build' 'completed' 'success')) @() -1 0 @((New-Run 'unit-tests' 'completed' 'success')) $null 1
  $rp3 = Invoke-Land $p3
  Check 'P3 page 2 read fails: land-pr exits non-zero, makes no merge call, says the check runs cannot be read and nothing was merged' ($rp3.Code -ne 0 -and -not (Test-Path $p3.Merge) -and $rp3.Text -match 'cannot read the check runs' -and $rp3.Text -match 'Nothing was merged')

  # P4: the red commit status is on page 2: the land refuses and names it
  $p4 = New-Case 'p4' (@(New-Required) + @((New-Run 'build' 'completed' 'success'))) @(@{ context = 'ci/ok'; state = 'success' }) -1 0 $null @(@{ context = 'ci/legacy'; state = 'failure' })
  $rp4 = Invoke-Land $p4
  Check 'P4 red status on page 2: land-pr exits non-zero, makes no merge call, names the status and says nothing was merged' ($rp4.Code -ne 0 -and -not (Test-Path $p4.Merge) -and $rp4.Text -match 'ci/legacy' -and $rp4.Text -match 'Nothing was merged')

  # M: the required CI jobs must be green on the head. The names are read from review-status.mjs at run time (no copy, no count in the land step).
  $one = $requiredNames[1]   # one job that the cases below break
  # M1: a required job has no check run at all
  $m1 = New-Case 'm1' @(New-Required @($one))
  $rm1 = Invoke-Land $m1
  Check "M1 no run of required job '$one': land-pr exits non-zero, makes no merge call, names the job as missing and says nothing was merged" ($rm1.Code -ne 0 -and -not (Test-Path $m1.Merge) -and $rm1.Text -match [regex]::Escape($one) -and $rm1.Text -match 'missing' -and $rm1.Text -match 'Nothing was merged')

  # M2, M3: a required job is queued or running
  foreach ($st in 'queued', 'in_progress') {
    $m23 = New-Case "m23-$st" (@(New-Required @($one)) + @((New-Run $one $st $null 'github-actions' 200 '500')))
    $rm23 = Invoke-Land $m23
    Check "M2/M3 required job ${st}: land-pr exits non-zero, makes no merge call, names the job as not completed" ($rm23.Code -ne 0 -and -not (Test-Path $m23.Merge) -and $rm23.Text -match [regex]::Escape($one) -and $rm23.Text -match 'not completed' -and $rm23.Text -match 'Nothing was merged')
  }

  # M4 to M6: a required job ended skipped, neutral or cancelled (the old gate counted these as fine)
  foreach ($cc in 'skipped', 'neutral', 'cancelled') {
    $m46 = New-Case "m46-$cc" (@(New-Required @($one)) + @((New-Run $one 'completed' $cc 'github-actions' 200 '500')))
    $rm46 = Invoke-Land $m46
    Check "M4-M6 required job ended ${cc}: land-pr exits non-zero, makes no merge call, names the job and the end" ($rm46.Code -ne 0 -and -not (Test-Path $m46.Merge) -and $rm46.Text -match [regex]::Escape($one) -and $rm46.Text -match "ended $cc" -and $rm46.Text -match 'Nothing was merged')
  }

  # M7: a first try that ended cancelled and a green re-run (same workflow run, higher id): the newest try counts, the land goes on
  $m7 = New-Case 'm7' (@(New-Required @($one)) + @((New-Run $one 'completed' 'cancelled' 'github-actions' 150 '500'), (New-Run $one 'completed' 'success' 'github-actions' 250 '500')))
  $rm7 = Invoke-Land $m7
  Check 'M7 cancelled first try then green re-run of the same workflow run: the merge call was made and land-pr exits 0' ((Test-Path $m7.Merge) -and $rm7.Code -eq 0)

  # M8: the same job in two workflow runs: a green run B does not hide the cancelled run A
  $m8 = New-Case 'm8' (@(New-Required @($one)) + @((New-Run $one 'completed' 'cancelled' 'github-actions' 150 '111'), (New-Run $one 'completed' 'success' 'github-actions' 250 '222')))
  $rm8 = Invoke-Land $m8
  Check 'M8 same job in two workflow runs, run A cancelled and run B green: land-pr exits non-zero and makes no merge call' ($rm8.Code -ne 0 -and -not (Test-Path $m8.Merge) -and $rm8.Text -match [regex]::Escape($one))

  # M9: a look-alike name from another app is not the required job
  $m9 = New-Case 'm9' (@(New-Required @($one)) + @((New-Run $one 'completed' 'success' 'some-other-ci' 200 '500')))
  $rm9 = Invoke-Land $m9
  Check 'M9 green run of the job name from another app: land-pr exits non-zero and makes no merge call (the job is missing)' ($rm9.Code -ne 0 -and -not (Test-Path $m9.Merge) -and $rm9.Text -match 'missing')

  # M10: every required job green and a non-required check still running: no over-block
  $m10 = New-Case 'm10' (@(New-Required) + @((New-Run 'slow-extra' 'in_progress' $null)))
  $rm10 = Invoke-Land $m10
  Check 'M10 all required jobs green, a non-required check running: the merge call was made and land-pr exits 0' ((Test-Path $m10.Merge) -and $rm10.Code -eq 0)

  # M11: the read of the job names fails: fail closed
  $m11 = New-Case 'm11' @(New-Required) @() -1 0 $null $null 0 'boom' 1
  $rm11 = Invoke-Land $m11
  Check 'M11 job-name read fails: land-pr exits non-zero, makes no merge call, says it cannot read the names and nothing was merged' ($rm11.Code -ne 0 -and -not (Test-Path $m11.Merge) -and $rm11.Text -match 'required CI job names' -and $rm11.Text -match 'Nothing was merged')

  # M12: malformed output of the read (exit 0 but not an array of one or more unique non-empty strings): fail closed
  $bad = @{ notjson = 'not json'; empty = '[]'; number = '[1]'; dup = '["ratchets","ratchets"]'; blank = '["ratchets",""]'; object = '{}' }
  foreach ($k in $bad.Keys) {
    $m12 = New-Case "m12-$k" @(New-Required) @() -1 0 $null $null 0 $bad[$k] 0
    $rm12 = Invoke-Land $m12
    Check "M12 malformed read ($k): land-pr exits non-zero, makes no merge call, says nothing was merged" ($rm12.Code -ne 0 -and -not (Test-Path $m12.Merge) -and $rm12.Text -match 'required CI job names' -and $rm12.Text -match 'Nothing was merged')
  }

  # M13: no second copy. The land step source holds no required job name and no hard-coded count of them.
  $src = Get-Content -LiteralPath $script -Raw
  $copied = @($requiredNames | Where-Object { $src -match ("['`"]" + [regex]::Escape($_) + "['`"]") })
  Check "M13 land-pr.ps1 holds no quoted required job name (found: $($copied -join ', '))" ($copied.Count -eq 0)
  Check 'M13 land-pr.ps1 holds no hard-coded count of the required jobs' ($src -notmatch '(?i)required[^\r\n]{0,40}(-eq|-ne|-lt|-gt)\s*8\b' -and $src -notmatch '\.Count\s*(-eq|-ne|-lt)\s*8\b')
  # M13b: a name the read returns that no run has: refused (the list comes from the read, not from the land step)
  $m13b = New-Case 'm13b' @(New-Required) @() -1 0 $null $null 0 ('[' + (($requiredNames + 'brand-new-job' | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']') 0
  $rm13b = Invoke-Land $m13b
  Check 'M13b a ninth job name from the read has no run: land-pr exits non-zero and names it as missing' ($rm13b.Code -ne 0 -and -not (Test-Path $m13b.Merge) -and $rm13b.Text -match 'brand-new-job' -and $rm13b.Text -match 'missing')
  # M13c: a one-name list from the read, that job green: the land goes on (no count in the land step)
  $m13c = New-Case 'm13c' @((New-Run $requiredNames[0] 'completed' 'success' 'github-actions' 101 '500')) @() -1 0 $null $null 0 ('["' + $requiredNames[0] + '"]') 0
  $rm13c = Invoke-Land $m13c
  Check 'M13c a one-name list, that job green: the merge call was made and land-pr exits 0' ((Test-Path $m13c.Merge) -and $rm13c.Code -eq 0)

  # M15: the runs are those of the head the land step merges. A green set that belongs to an older head cannot pass.
  $m15 = New-Case 'm15' @()
  $oldSha = 'fedcba9876543210fedcba9876543210fedcba98'
  Set-Content -LiteralPath (Join-Path $m15.Stub 'old-head-runs.json') -Value (@{ total_count = 8; check_runs = @(New-Required) } | ConvertTo-Json -Compress -Depth 6)
  $rm15 = Invoke-Land $m15
  $calls = if (Test-Path (Join-Path $m15.Stub 'calls.log')) { Get-Content -LiteralPath (Join-Path $m15.Stub 'calls.log') -Raw } else { '' }
  Check 'M15 the head has no runs (a green set exists only for an older head): land-pr exits non-zero, makes no merge call' ($rm15.Code -ne 0 -and -not (Test-Path $m15.Merge) -and $rm15.Text -match 'missing')
  # M16: the job name matches exactly (review-status.mjs compares exactly). A run named with other letter case is not the job.
  $caseOther = $one.Substring(0, 1).ToUpper() + $one.Substring(1)
  $m16 = New-Case 'm16' (@(New-Required @($one)) + @((New-Run $caseOther 'completed' 'success' 'github-actions' 200 '500')))
  $rm16 = Invoke-Land $m16
  Check "M16 green run named '$caseOther' for required job '$one': land-pr exits non-zero, makes no merge call, names the job as missing" ($rm16.Code -ne 0 -and -not (Test-Path $m16.Merge) -and $rm16.Text -cmatch ('required check "' + [regex]::Escape($one) + '" missing'))
  Check 'M15 the check runs were read for the head sha of the pull request and for no other sha' ($calls -match [regex]::Escape("commits/$sha/check-runs") -and $calls -notmatch $oldSha)
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
