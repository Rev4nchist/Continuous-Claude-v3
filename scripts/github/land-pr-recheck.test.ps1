# Wiring test for Gate C in land-pr.ps1: the pre-merge re-check must run before the merge call.
# Run: pwsh -NoProfile -File scripts/github/land-pr-recheck.test.ps1
#
# The decision logic is tested in land-recheck.test.mjs. This file proves land-pr.ps1 calls it and obeys it.
# land-pr.ps1 runs as a child process with stub gh.cmd and node.cmd first on PATH. No real gh or review call.
#   stub node: review-status.mjs answers READY for the head; land-recheck.mjs and land-none-check.mjs answer what the case sets.
#   stub gh:   serves the PR; a PUT to .../merge writes merge.flag, so "no merge" is checkable.
# Failure modes:
#   the re-check is skipped or runs after the merge                 -> W1 (refusal must leave no merge.flag)
#   a refusal (exit 1) or a read error (exit 2) still merges        -> W1, W2
#   the re-check gets no head or READY time                         -> W3
#   a passing re-check blocks the merge                             -> W3
#   a local clock ahead of GitHub hides a review just before the READY time -> W3b (READY time backed off 120 s, margin printed)
#   -IgnoreReview runs the re-check, or does not say it is skipped  -> W4
#   land-none-check refuses (exit 1) or errs (exit 2) and the PR still merges -> W5
#   the provenance line is not printed, or is missing from the LANDED line    -> W6
#   -IgnoreReview skips the helper, or runs it without --warn, or it blocks   -> W7
#   decisions.enforce true and no land tap on record, and the PR still merges  -> WD1 (also under -IgnoreReview: WD3)
#   a passing tap is not used up, or is used up BEFORE the merge               -> WD2 (use runs after merge.flag), WD5 (a later refusal leaves the tap)
#   decisions.enforce false or missing runs the check, or prints no warning    -> WD4 (no helper call, a WARNING line, the merge goes)
#   a refusal text tells Dave to type /pathway                                 -> W5b
#   a caller-set CCV3_DECISIONS_FILE points the land check at a fake store      -> WD6 (the stub node sees the variable empty on every land-decision call)
#   a caller-set USERPROFILE or HOME moves os.homedir() and so the decision store -> WD8 (the stub node sees the real profile folder, not the caller's, on every land-decision call)
#   the USERPROFILE and HOME override stays set after the decision check, so git finds its config in the wrong home -> WD9 (gh sees the caller's values after the check), WD9b (a caller with no HOME gets none back)
#   decisions.enforce is read from -RepoPath only, so a repo with no config or a stale one skips the check -> WD7 (the script's own root decides too; the stricter wins)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'land-pr.ps1'
$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}

$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ('land-pr-recheck-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$oldPath = $env:PATH
# land-pr.ps1 takes a lock before the merge: point it, its log and the sync cursor at the temp folder, never at ~/.claude.
$env:CCV3_LAND_LOCK = Join-Path $work 'land.lock'; $env:CCV3_LAND_LOCK_LOG = Join-Path $work 'land-lock.log'; $env:CCV3_SYNC_CURSOR = Join-Path $work 'sync-cursor'
$sha = '0123456789abcdef0123456789abcdef01234567'
$branch = 'fix/recheck-wiring'
$prUrl = 'repos/Rev4nchist/Continuous-Claude-v3/pulls/7'

function New-Case([string]$name, [int]$recheckExit, [string]$recheckOut, [int]$noneExit = 0, [string]$noneOut = '', [int]$gateExit = 0, [string]$enforce = '', [int]$landExit = 0, [string]$ownEnforce = '') {
  # A stub dir plus a throwaway repo with a bare remote `fork`, so a merge that goes through can finish.
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
  Set-Content -LiteralPath (Join-Path $stub 'status.json') -Value (@{ ready = $true; head = $sha; mergeable_state = 'clean'; reasons = @() } | ConvertTo-Json -Compress)
  Set-Content -LiteralPath (Join-Path $stub 'recheck-exit.txt') -Value $recheckExit
  Set-Content -LiteralPath (Join-Path $stub 'recheck-out.txt') -Value $recheckOut
  Set-Content -LiteralPath (Join-Path $stub 'none-exit.txt') -Value $noneExit
  Set-Content -LiteralPath (Join-Path $stub 'none-out.txt') -Value $noneOut
  Set-Content -LiteralPath (Join-Path $stub 'gate-exit.txt') -Value $gateExit
  Set-Content -LiteralPath (Join-Path $stub 'ld-exit.txt') -Value $landExit
  Set-Content -LiteralPath (Join-Path $stub 'ld-out.txt') -Value 'REFUSED: no tap from Dave is on record for this PR at this head.'
  # decisions.enforce lives in review-router.config.json of the repo the script lands from (-RepoPath). '' writes no config file.
  if ($enforce) { Set-Content -LiteralPath (Join-Path $repo 'review-router.config.json') -Value ('{ "decisions": { "enforce": ' + $enforce + ' } }') }
  Set-Content -LiteralPath (Join-Path $stub 'gate-out.txt') -Value 'migration gate: stub answer'
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    "if `"%~1`"==`"api`" if `"%~2`"==`"repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/check-runs?per_page`" goto runs",
    "if `"%~1`"==`"api`" if `"%~2`"==`"repos/Rev4nchist/Continuous-Claude-v3/commits/$sha/status?per_page`" goto status",
    'echo stub gh: unexpected arguments: %* 1>&2',
    'exit /b 1',
    ':runs',
    'echo {"total_count":0,"check_runs":[]}',
    'exit /b 0',
    ':status',
    'echo {"state":"success","total_count":0,"statuses":[]}',
    'exit /b 0',
    ':merge',
    'echo [%USERPROFILE%][%HOME%]>> "%~dp0gh-home.txt"',
    'echo merged> "%~dp0merge.flag"',
    'echo {}',
    'exit /b 0',
    ':pull',
    'echo [%USERPROFILE%][%HOME%]>> "%~dp0gh-home.txt"',
    'if exist "%~dp0merge.flag" (type "%~dp0merged.json") else (type "%~dp0pull.json")',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"review-status" >nul && goto rs',
    'echo %~1| findstr /c:"land-recheck" >nul && goto lr',
    'echo %~1| findstr /c:"land-none-check" >nul && goto ln',
    'echo %~1| findstr /c:"migration-gate" >nul && goto mg',
    'echo %~1| findstr /c:"land-decision" >nul && goto ld',
    'echo stub node: unexpected arguments: %* 1>&2',
    'exit /b 9',
    ':rs',
    'type "%~dp0status.json"',
    'exit /b 0',
    ':lr',
    'echo %*> "%~dp0recheck-args.txt"',
    'type "%~dp0recheck-out.txt"',
    'set /p code=<"%~dp0recheck-exit.txt"',
    'exit /b %code%',
    ':mg',
    'echo %*> "%~dp0gate-args.txt"',
    'type "%~dp0gate-out.txt"',
    'set /p gcode=<"%~dp0gate-exit.txt"',
    'exit /b %gcode%',
    ':ld',
    'echo [%CCV3_DECISIONS_FILE%]>> "%~dp0ld-env.txt"',
    'echo [%USERPROFILE%][%HOME%]>> "%~dp0ld-home.txt"',
    'echo %*>> "%~dp0ld-calls.txt"',
    'if "%~2"=="use" (if exist "%~dp0merge.flag" (echo use-after-merge>> "%~dp0ld-order.txt") else (echo use-before-merge>> "%~dp0ld-order.txt"))',
    'if "%~2"=="use" exit /b 0',
    'type "%~dp0ld-out.txt"',
    'set /p lcode=<"%~dp0ld-exit.txt"',
    'exit /b %lcode%',
    ':ln',
    'echo %*> "%~dp0none-args.txt"',
    'type "%~dp0none-out.txt"',
    'set /p ncode=<"%~dp0none-exit.txt"',
    'exit /b %ncode%')
  [pscustomobject]@{ Dir = $dir; OwnEnforce = $ownEnforce; LandEnv = (Join-Path $stub 'ld-env.txt'); LandHome = (Join-Path $stub 'ld-home.txt'); GhHome = (Join-Path $stub 'gh-home.txt'); Stub = $stub; Repo = $repo; Merge = (Join-Path $stub 'merge.flag'); Args = (Join-Path $stub 'recheck-args.txt'); NoneArgs = (Join-Path $stub 'none-args.txt'); GateArgs = (Join-Path $stub 'gate-args.txt'); LandCalls = (Join-Path $stub 'ld-calls.txt'); LandOrder = (Join-Path $stub 'ld-order.txt') }
}

function Invoke-Land($case, [string[]]$extra = @()) {
  $env:PATH = "$($case.Stub);$oldPath"
  $found = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($found -ne (Join-Path $case.Stub 'gh.cmd')) { throw "harness: gh resolves to '$found', not the stub; stopping before any real gh call" }
  # The script runs from a copy in a temp "own root" (<case>\own\scripts\github), so the config of this checkout never decides decisions.enforce.
  $own = Join-Path $case.Dir 'own'; $ownGithub = Join-Path $own 'scripts\github'
  New-Item -ItemType Directory -Force -Path $ownGithub | Out-Null
  Copy-Item -LiteralPath $script -Destination (Join-Path $ownGithub 'land-pr.ps1') -Force
  if ($case.OwnEnforce) { Set-Content -LiteralPath (Join-Path $own 'review-router.config.json') -Value ('{ "decisions": { "enforce": ' + $case.OwnEnforce + ' } }') }
  $out = & pwsh -NoProfile -File (Join-Path $ownGithub 'land-pr.ps1') -Pr 7 -NoSync -RepoPath $case.Repo @extra 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
}

try {
  # W1: the re-check refuses (exit 1)
  $c1 = New-Case 'w1' 1 '  re-check: head changed since the READY check'
  $r1 = Invoke-Land $c1
  Check 'W1 refusal: land-pr exits non-zero' ($r1.Code -ne 0)
  Check 'W1 refusal: no merge call was made' (-not (Test-Path $c1.Merge))
  Check 'W1 refusal: output says the re-check refused and nothing was merged' ($r1.Text -match 'pre-merge re-check refused' -and $r1.Text -match 'Nothing was merged')
  Check 'W1 refusal: the re-check reason is shown' ($r1.Text -match 'head changed since the READY check')

  # W2: a read error (exit 2) refuses too
  $c2 = New-Case 'w2' 2 '  re-check: could not re-read PR #7: boom'
  $r2 = Invoke-Land $c2
  Check 'W2 read error: land-pr exits non-zero and makes no merge call' ($r2.Code -ne 0 -and -not (Test-Path $c2.Merge))

  # W3: a quiet PR merges, and the re-check got the head and the READY time
  $c3 = New-Case 'w3' 0 '  re-check: PR #7 is unchanged'
  $t3 = [DateTime]::UtcNow
  $r3 = Invoke-Land $c3
  $t3end = [DateTime]::UtcNow
  $args3 = if (Test-Path $c3.Args) { Get-Content -LiteralPath $c3.Args -Raw } else { '' }
  Check 'W3 quiet: the merge call was made' (Test-Path $c3.Merge)
  Check 'W3 quiet: land-pr exits 0' ($r3.Code -eq 0)
  Check 'W3 quiet: the re-check got --head <sha> and --ready-at <UTC time>' ($args3 -match "--head $sha" -and $args3 -match '--ready-at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
  # W3b: fail closed on clock skew. The READY time is backed off by 120 s, so a local clock that runs ahead cannot hide a review.
  $m3 = [regex]::Match($args3, '--ready-at (\S+)')
  $at3 = [DateTime]::MinValue
  $parsed3 = $m3.Success -and [DateTime]::TryParse($m3.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$at3)
  # land-pr reads its clock between $t3 and $t3end, so --ready-at must sit at least 119 s before $t3end (no timing race).
  Check 'W3b clock margin: --ready-at is at least 119 s before the run ended' ($parsed3 -and $at3 -le $t3end.AddSeconds(-119))
  Check 'W3b clock margin: --ready-at is not further back than 180 s' ($parsed3 -and $at3 -ge $t3.AddSeconds(-180))
  Check 'W3b clock margin: the output states the 120 s margin' ($r3.Text -match '120 s')
  if ($fail) { Write-Host "---- w3 output ----"; Write-Host $r3.Text; Write-Host "---- end ----" }

  # W4: -IgnoreReview skips the re-check and says so
  $c4 = New-Case 'w4' 1 '  re-check: must not run'
  $r4 = Invoke-Land $c4 @('-IgnoreReview')
  Check 'W4 -IgnoreReview: the re-check did not run' (-not (Test-Path $c4.Args))
  Check 'W4 -IgnoreReview: the merge call was made' (Test-Path $c4.Merge)
  Check 'W4 -IgnoreReview: output says the review checks are skipped' ($r4.Text -match '-IgnoreReview: skipping the READY check and the pre-merge re-check')

  # W5: land-none-check refuses (exit 1) or cannot decide (exit 2): nothing merges
  foreach ($code in 1, 2) {
    $c5 = New-Case "w5-$code" 0 '  re-check: PR #7 is unchanged' $code '  REFUSED: no record for this head'
    $r5 = Invoke-Land $c5
    Check "W5 none-check exit ${code}: land-pr exits non-zero and makes no merge call" ($r5.Code -ne 0 -and -not (Test-Path $c5.Merge))
    Check "W5 none-check exit ${code}: output shows the reason and says nothing was merged" ($r5.Text -match 'no record for this head' -and $r5.Text -match 'Nothing was merged')
  }
  # W5b: exit 1 tells Dave to pick again; exit 2 says it could not decide and tells him to read the output, not to pick again
  $c5a = New-Case 'w5a' 0 '  re-check: PR #7 is unchanged' 1 'REFUSED: no record'
  $c5b = New-Case 'w5b' 0 '  re-check: PR #7 is unchanged' 2 'land-none-check: could not determine (boom)'
  $t5a = (Invoke-Land $c5a).Text
  $t5b = (Invoke-Land $c5b).Text
  Check 'W5b exit 1: the message says to call pr_checkpoint, and names no typed command' ($t5a -match 'pr_checkpoint' -and $t5a -notmatch '/pathway' -and $t5a -notmatch '/slot pay')
  Check 'W5b exit 2: the message says could not determine, read the output above, then re-run' ($t5b -match 'could not determine; read the output above, then re-run' -and $t5b -notmatch 'pr_checkpoint')

  # W6: a passing helper prints its line, and the line is in the LANDED summary
  $line6 = 'Dave chose none at 2026-11-03 21:42 CST via dialog, head 0123456 (band HIGH, store x.json)'
  $c6 = New-Case 'w6' 0 '  re-check: PR #7 is unchanged' 0 $line6
  $r6 = Invoke-Land $c6
  $args6 = if (Test-Path $c6.NoneArgs) { Get-Content -LiteralPath $c6.NoneArgs -Raw } else { '' }
  Check 'W6 provenance: the merge call was made and land-pr exits 0' ((Test-Path $c6.Merge) -and $r6.Code -eq 0)
  Check 'W6 provenance: the helper got the PR, --head <sha> and no --warn' ($args6 -match "--head $sha" -and $args6 -notmatch '--warn')
  Check 'W6 provenance: the line is printed' ($r6.Text -match [regex]::Escape($line6))
  Check 'W6 provenance: the line is in the LANDED summary' ($r6.Text -match 'LANDED #7:[^
]*Dave chose none at 2026-11-03 21:42 CST')

  # W7: -IgnoreReview runs the helper with --warn and still merges, even when the helper refuses
  $c7 = New-Case 'w7' 1 '  re-check: must not run' 1 'WARNING: no record for this head'
  $r7 = Invoke-Land $c7 @('-IgnoreReview')
  $args7 = if (Test-Path $c7.NoneArgs) { Get-Content -LiteralPath $c7.NoneArgs -Raw } else { '' }
  Check 'W7 -IgnoreReview: the helper ran with --warn' ($args7 -match '--warn')
  Check 'W7 -IgnoreReview: the merge call was made even though the helper exited 1' ((Test-Path $c7.Merge) -and $r7.Code -eq 0)
  Check 'W7 -IgnoreReview: the warning is printed and is in the LANDED summary' ($r7.Text -match 'WARNING: no record for this head' -and $r7.Text -match 'LANDED #7:[^\r\n]*WARNING: no record for this head')
  # W7b: -IgnoreReview and the helper printed nothing and failed (it did not run): the LANDED line says so
  $c7b = New-Case 'w7b' 1 '  re-check: must not run' 3 ''
  $r7b = Invoke-Land $c7b @('-IgnoreReview')
  Check 'W7b -IgnoreReview, helper failed silently: the merge still goes and the LANDED line names the failure' ((Test-Path $c7b.Merge) -and $r7b.Text -match 'LANDED #7:[^\r\n]*WARNING: none-pick check did not run \(exit 3\)')

  # W8: the migration gate refuses (exit 1): nothing merges, with and without -IgnoreReview (it is not a review check)
  foreach ($extra in @(@(), @('-IgnoreReview'))) {
    $label = if ($extra.Count) { '-IgnoreReview' } else { 'normal' }
    $c8 = New-Case "w8-$($label.TrimStart('-'))" 0 '  re-check: PR #7 is unchanged' 0 '' 1
    $r8 = Invoke-Land $c8 $extra
    Check "W8 gate exit 1 ($label): land-pr exits non-zero and makes no merge call" ($r8.Code -ne 0 -and -not (Test-Path $c8.Merge))
    Check "W8 gate exit 1 ($label): output says the gate refused and nothing was merged" ($r8.Text -match 'migration gate refused' -and $r8.Text -match 'Nothing was merged')
    $args8 = if (Test-Path $c8.GateArgs) { Get-Content -LiteralPath $c8.GateArgs -Raw } else { '' }
    Check "W8 gate ($label): the gate got the head sha and the remote" ($args8 -match $sha -and $args8 -match '--remote fork')
  }
  # W8b: the gate passes (exit 0): the merge goes through
  $c8b = New-Case 'w8b' 0 '  re-check: PR #7 is unchanged'
  $r8b = Invoke-Land $c8b
  Check 'W8b gate exit 0: the merge call was made' ((Test-Path $c8b.Merge) -and $r8b.Code -eq 0)

  # WD1: decisions.enforce true and the land check refuses (exit 1): nothing merges, with and without -IgnoreReview
  foreach ($extra in @(@(), @('-IgnoreReview'))) {
    $label = if ($extra.Count) { 'ignore' } else { 'normal' }
    $cd1 = New-Case "wd1-$label" 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 1
    $rd1 = Invoke-Land $cd1 $extra
    Check "WD1 refusal ($label): land-pr exits non-zero and makes no merge call" ($rd1.Code -ne 0 -and -not (Test-Path $cd1.Merge))
    Check "WD1 refusal ($label): the output says nothing was merged and shows the reason" ($rd1.Text -match 'Nothing was merged' -and $rd1.Text -match 'no tap from Dave')
    $callsd1 = if (Test-Path $cd1.LandCalls) { Get-Content -LiteralPath $cd1.LandCalls -Raw } else { '' }
    Check "WD1 refusal ($label): the helper got check, the PR, the repo and --head <sha>" ($callsd1 -match 'check 7 --repo Rev4nchist/Continuous-Claude-v3' -and $callsd1 -match "--head $sha")
    Check "WD1 refusal ($label): the tap was not used up" ($callsd1 -notmatch ' use ')
  }
  # WD2: the land check passes: the merge goes, and the tap is used up after the merge call
  $cd2 = New-Case 'wd2' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 0
  $rd2 = Invoke-Land $cd2
  $orderd2 = if (Test-Path $cd2.LandOrder) { (Get-Content -LiteralPath $cd2.LandOrder -Raw).Trim() } else { '' }
  Check 'WD2 pass: the merge call was made and land-pr exits 0' ((Test-Path $cd2.Merge) -and $rd2.Code -eq 0)
  Check 'WD2 pass: the tap was used up once, after the merge' ($orderd2 -eq 'use-after-merge')
  # WD4: enforce false, and no config file at all (W1-W8 have none): no helper call, a WARNING line, the merge goes
  foreach ($mode in 'false', '') {
    $cd4 = New-Case "wd4-$(if ($mode) { $mode } else { 'none' })" 0 '  re-check: PR #7 is unchanged' 0 '' 0 $mode 1
    $rd4 = Invoke-Land $cd4
    Check "WD4 enforce '$mode': the helper was not called" (-not (Test-Path $cd4.LandCalls))
    Check "WD4 enforce '$mode': the merge goes and the output has a WARNING about the land decision" ((Test-Path $cd4.Merge) -and $rd4.Code -eq 0 -and $rd4.Text -match 'WARNING: decisions\.enforce is not true')
  }
  # WD5: enforce true, the tap passes, but the migration gate refuses: no merge, and the tap is NOT used up
  $cd5 = New-Case 'wd5' 0 '  re-check: PR #7 is unchanged' 0 '' 1 'true' 0
  $rd5 = Invoke-Land $cd5
  Check 'WD5 later refusal: no merge call, and the tap was not used up' ($rd5.Code -ne 0 -and -not (Test-Path $cd5.Merge) -and -not (Test-Path $cd5.LandOrder))

  # WD6: a caller-set CCV3_DECISIONS_FILE must not reach land-decision.mjs: the check reads the real store, never a fake one.
  $env:CCV3_DECISIONS_FILE = Join-Path $work 'fake-decisions.json'
  try {
    $cd6 = New-Case 'wd6' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 0
    $rd6 = Invoke-Land $cd6
  } finally { Remove-Item Env:\CCV3_DECISIONS_FILE -ErrorAction SilentlyContinue }
  $envd6 = if (Test-Path $cd6.LandEnv) { @(Get-Content -LiteralPath $cd6.LandEnv) } else { @() }
  Check 'WD6 seam: land-decision.mjs ran twice (check, use) and the merge went' ($envd6.Count -eq 2 -and (Test-Path $cd6.Merge) -and $rd6.Code -eq 0)
  Check 'WD6 seam: both calls saw CCV3_DECISIONS_FILE empty' (($envd6 | Where-Object { $_ -ne '[]' }).Count -eq 0)
  # WD8: a caller-set USERPROFILE or HOME must not reach land-decision.mjs: decisions.mjs falls back to os.homedir(), which reads them, so the store would move.
  $realProfile = [Environment]::GetFolderPath('UserProfile')
  $oldUp = $env:USERPROFILE; $oldHome = $env:HOME
  $env:USERPROFILE = Join-Path $work 'fake-profile'; $env:HOME = Join-Path $work 'fake-home'
  try {
    $cd8 = New-Case 'wd8' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 0
    $rd8 = Invoke-Land $cd8
  } finally { $env:USERPROFILE = $oldUp; if ($null -eq $oldHome) { Remove-Item Env:\HOME -ErrorAction SilentlyContinue } else { $env:HOME = $oldHome } }
  $homed8 = if (Test-Path $cd8.LandHome) { @(Get-Content -LiteralPath $cd8.LandHome) } else { @() }
  Check 'WD8 seam: land-decision.mjs ran twice (check, use) and the merge went' ($homed8.Count -eq 2 -and (Test-Path $cd8.Merge) -and $rd8.Code -eq 0)
  Check 'WD8 seam: both calls saw the real profile folder in USERPROFILE and HOME' (($homed8 | Where-Object { $_ -ne "[$realProfile][$realProfile]" }).Count -eq 0)
  # WD9: the override is scoped to the land-decision calls. Every later call (gh, and git, which finds its config through the same variables) keeps the caller's USERPROFILE and HOME.
  # The merge and the post-merge PR read run AFTER the decision check, so the gh stub sees what the script left in the environment.
  $fakeUp = Join-Path $work 'caller-profile'; $fakeHome = Join-Path $work 'caller-home'
  $oldUp9 = $env:USERPROFILE; $oldHome9 = $env:HOME
  $env:USERPROFILE = $fakeUp; $env:HOME = $fakeHome
  try {
    $cd9 = New-Case 'wd9' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 0
    $rd9 = Invoke-Land $cd9
  } finally { $env:USERPROFILE = $oldUp9; if ($null -eq $oldHome9) { Remove-Item Env:\HOME -ErrorAction SilentlyContinue } else { $env:HOME = $oldHome9 } }
  $ghd9 = if (Test-Path $cd9.GhHome) { @(Get-Content -LiteralPath $cd9.GhHome) } else { @() }
  Check 'WD9 restore: the merge went and gh ran after the decision check' ((Test-Path $cd9.Merge) -and $rd9.Code -eq 0 -and $ghd9.Count -ge 2)
  Check 'WD9 restore: every gh call after the decision check saw the caller USERPROFILE and HOME' (($ghd9 | Where-Object { $_ -ne "[$fakeUp][$fakeHome]" }).Count -eq 0)
  # WD9b: a caller with no HOME gets none back (the override does not leave the OS profile folder in HOME), and the decision calls still saw the real folder.
  $env:USERPROFILE = $fakeUp; Remove-Item Env:\HOME -ErrorAction SilentlyContinue
  try {
    $cd9b = New-Case 'wd9b' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 0
    $rd9b = Invoke-Land $cd9b
  } finally { $env:USERPROFILE = $oldUp9; if ($null -eq $oldHome9) { Remove-Item Env:\HOME -ErrorAction SilentlyContinue } else { $env:HOME = $oldHome9 } }
  $ghd9b = if (Test-Path $cd9b.GhHome) { @(Get-Content -LiteralPath $cd9b.GhHome) } else { @() }
  $ldd9b = if (Test-Path $cd9b.LandHome) { @(Get-Content -LiteralPath $cd9b.LandHome) } else { @() }
  Check 'WD9b restore, HOME unset: gh saw the caller USERPROFILE and an empty HOME' ($ghd9b.Count -ge 2 -and ($ghd9b | Where-Object { $_ -ne "[$fakeUp][]" }).Count -eq 0)
  Check 'WD9b restore, HOME unset: both decision calls still saw the real profile folder' ($ldd9b.Count -eq 2 -and ($ldd9b | Where-Object { $_ -ne "[$realProfile][$realProfile]" }).Count -eq 0)
  # WD7: decisions.enforce true in the script's own root enforces even when -RepoPath has no config, or a config that says false.
  foreach ($repoCfg in '', 'false') {
    $cd7 = New-Case "wd7-$(if ($repoCfg) { $repoCfg } else { 'none' })" 0 '  re-check: PR #7 is unchanged' 0 '' 0 $repoCfg 1 'true'
    $rd7 = Invoke-Land $cd7
    $callsd7 = if (Test-Path $cd7.LandCalls) { Get-Content -LiteralPath $cd7.LandCalls -Raw } else { '' }
    Check "WD7 own root true, -RepoPath config '$repoCfg': the land check ran, refused, and nothing merged" ($callsd7 -match 'check 7' -and $rd7.Code -ne 0 -and -not (Test-Path $cd7.Merge) -and $rd7.Text -match 'Nothing was merged')
  }
  # WD7b: own root false and -RepoPath true still enforces (the stricter of the two); own root false and -RepoPath missing warns and merges.
  $cd7b = New-Case 'wd7b' 0 '  re-check: PR #7 is unchanged' 0 '' 0 'true' 1 'false'
  $rd7b = Invoke-Land $cd7b
  Check 'WD7b own root false, -RepoPath true: the land check ran and refused' ((Test-Path $cd7b.LandCalls) -and $rd7b.Code -ne 0 -and -not (Test-Path $cd7b.Merge))
  $cd7c = New-Case 'wd7c' 0 '  re-check: PR #7 is unchanged' 0 '' 0 '' 1 'false'
  $rd7c = Invoke-Land $cd7c
  Check 'WD7c both off: no helper call, a WARNING, the merge goes' (-not (Test-Path $cd7c.LandCalls) -and (Test-Path $cd7c.Merge) -and $rd7c.Text -match 'WARNING: decisions\.enforce is not true')
}
finally {
  $env:PATH = $oldPath
  Remove-Item Env:\CCV3_LAND_LOCK, Env:\CCV3_LAND_LOCK_LOG, Env:\CCV3_SYNC_CURSOR -ErrorAction SilentlyContinue
  $full = [System.IO.Path]::GetFullPath($work)
  if ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-recheck-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "passed=$pass failed=$fail"
exit $fail
