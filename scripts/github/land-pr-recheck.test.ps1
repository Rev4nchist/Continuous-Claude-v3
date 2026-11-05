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

function New-Case([string]$name, [int]$recheckExit, [string]$recheckOut, [int]$noneExit = 0, [string]$noneOut = '', [int]$gateExit = 0) {
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
  Set-Content -LiteralPath (Join-Path $stub 'gate-out.txt') -Value 'migration gate: stub answer'
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl/merge`" goto merge",
    "if `"%~1`"==`"api`" if `"%~2`"==`"$prUrl`" goto pull",
    'echo stub gh: unexpected arguments: %* 1>&2',
    'exit /b 1',
    ':merge',
    'echo merged> "%~dp0merge.flag"',
    'echo {}',
    'exit /b 0',
    ':pull',
    'if exist "%~dp0merge.flag" (type "%~dp0merged.json") else (type "%~dp0pull.json")',
    'exit /b 0')
  Set-Content -LiteralPath (Join-Path $stub 'node.cmd') -Encoding ascii -Value @(
    '@echo off',
    'echo %~1| findstr /c:"review-status" >nul && goto rs',
    'echo %~1| findstr /c:"land-recheck" >nul && goto lr',
    'echo %~1| findstr /c:"land-none-check" >nul && goto ln',
    'echo %~1| findstr /c:"migration-gate" >nul && goto mg',
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
    ':ln',
    'echo %*> "%~dp0none-args.txt"',
    'type "%~dp0none-out.txt"',
    'set /p ncode=<"%~dp0none-exit.txt"',
    'exit /b %ncode%')
  [pscustomobject]@{ Stub = $stub; Repo = $repo; Merge = (Join-Path $stub 'merge.flag'); Args = (Join-Path $stub 'recheck-args.txt'); NoneArgs = (Join-Path $stub 'none-args.txt'); GateArgs = (Join-Path $stub 'gate-args.txt') }
}

function Invoke-Land($case, [string[]]$extra = @()) {
  $env:PATH = "$($case.Stub);$oldPath"
  $found = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($found -ne (Join-Path $case.Stub 'gh.cmd')) { throw "harness: gh resolves to '$found', not the stub; stopping before any real gh call" }
  $out = & pwsh -NoProfile -File $script -Pr 7 -NoSync -RepoPath $case.Repo @extra 2>&1
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
  Check 'W5b exit 1: the message tells Dave to pick again in /pathway' ($t5a -match 'picks again')
  Check 'W5b exit 2: the message says could not determine, read the output above, then re-run' ($t5b -match 'could not determine; read the output above, then re-run' -and $t5b -notmatch 'picks again')

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
