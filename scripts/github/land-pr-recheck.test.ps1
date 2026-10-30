# Wiring test for Gate C in land-pr.ps1: the pre-merge re-check must run before the merge call.
# Run: pwsh -NoProfile -File scripts/github/land-pr-recheck.test.ps1
#
# The decision logic is tested in land-recheck.test.mjs. This file proves land-pr.ps1 calls it and obeys it.
# land-pr.ps1 runs as a child process with stub gh.cmd and node.cmd first on PATH. No real gh or review call.
#   stub node: review-status.mjs answers READY for the head; land-recheck.mjs answers what the case sets.
#   stub gh:   serves the PR; a PUT to .../merge writes merge.flag, so "no merge" is checkable.
# Failure modes:
#   the re-check is skipped or runs after the merge                 -> W1 (refusal must leave no merge.flag)
#   a refusal (exit 1) or a read error (exit 2) still merges        -> W1, W2
#   the re-check gets no head or READY time                         -> W3
#   a passing re-check blocks the merge                             -> W3
#   a local clock ahead of GitHub hides a review just before the READY time -> W3b (READY time backed off 120 s, margin printed)
#   -IgnoreReview runs the re-check, or does not say it is skipped  -> W4
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
$sha = '0123456789abcdef0123456789abcdef01234567'
$branch = 'fix/recheck-wiring'
$prUrl = 'repos/Rev4nchist/Continuous-Claude-v3/pulls/7'

function New-Case([string]$name, [int]$recheckExit, [string]$recheckOut) {
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
    'echo stub node: unexpected arguments: %* 1>&2',
    'exit /b 9',
    ':rs',
    'type "%~dp0status.json"',
    'exit /b 0',
    ':lr',
    'echo %*> "%~dp0recheck-args.txt"',
    'type "%~dp0recheck-out.txt"',
    'set /p code=<"%~dp0recheck-exit.txt"',
    'exit /b %code%')
  [pscustomobject]@{ Stub = $stub; Repo = $repo; Merge = (Join-Path $stub 'merge.flag'); Args = (Join-Path $stub 'recheck-args.txt') }
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
  $args3 = if (Test-Path $c3.Args) { Get-Content -LiteralPath $c3.Args -Raw } else { '' }
  Check 'W3 quiet: the merge call was made' (Test-Path $c3.Merge)
  Check 'W3 quiet: land-pr exits 0' ($r3.Code -eq 0)
  Check 'W3 quiet: the re-check got --head <sha> and --ready-at <UTC time>' ($args3 -match "--head $sha" -and $args3 -match '--ready-at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
  # W3b: fail closed on clock skew. The READY time is backed off by 120 s, so a local clock that runs ahead cannot hide a review.
  $m3 = [regex]::Match($args3, '--ready-at (\S+)')
  $at3 = [DateTime]::MinValue
  $parsed3 = $m3.Success -and [DateTime]::TryParse($m3.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$at3)
  Check 'W3b clock margin: --ready-at is at least 119 s before the run started' ($parsed3 -and $at3 -le $t3.AddSeconds(-119))
  Check 'W3b clock margin: --ready-at is not further back than 180 s' ($parsed3 -and $at3 -ge $t3.AddSeconds(-180))
  Check 'W3b clock margin: the output states the 120 s margin' ($r3.Text -match '120 s')
  if ($fail) { Write-Host "---- w3 output ----"; Write-Host $r3.Text; Write-Host "---- end ----" }

  # W4: -IgnoreReview skips the re-check and says so
  $c4 = New-Case 'w4' 1 '  re-check: must not run'
  $r4 = Invoke-Land $c4 @('-IgnoreReview')
  Check 'W4 -IgnoreReview: the re-check did not run' (-not (Test-Path $c4.Args))
  Check 'W4 -IgnoreReview: the merge call was made' (Test-Path $c4.Merge)
  Check 'W4 -IgnoreReview: output says the review checks are skipped' ($r4.Text -match '-IgnoreReview: skipping the READY check and the pre-merge re-check')
}
finally {
  $env:PATH = $oldPath
  $full = [System.IO.Path]::GetFullPath($work)
  if ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-recheck-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "passed=$pass failed=$fail"
exit $fail
