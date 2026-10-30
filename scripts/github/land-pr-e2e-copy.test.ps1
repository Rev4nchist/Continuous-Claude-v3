# land-pr.ps1 must save the PR's e2e artifacts before it removes the PR worktree.
#
# Why: step 5 removes a worktree when `git status --porcelain` is empty. That ignores gitignored
# files, and `.claude/cache/` is gitignored, so the Evidence artifacts in <worktree>/.claude/cache/e2e/
# were deleted at landing.
#
# Contract under test: function Save-E2eArtifacts in land-pr.ps1
#   Save-E2eArtifacts -Source <dir> -Destination <dir>
#   Returns an object with: Copied (int), Skipped (int), Conflicts (string[]), Error (string or $null).
#   - Copies every file under Source to the same relative path under Destination.
#   - A file that exists at the destination with the same bytes is skipped (idempotent).
#   - A file that exists at the destination with DIFFERENT bytes is a conflict: not overwritten,
#     its relative path goes in Conflicts.
#   - A missing or empty Source creates no Destination folder.
#   - A locked or unreadable file sets Error. The function never throws.
#   - The function is self-contained: it uses no script-level variable of land-pr.ps1.
# Wiring contract: the script calls it before removing the worktree, never calls Fail on it,
# removes the worktree only when Conflicts is empty and Error is $null, and otherwise prints
# "kept worktree X: e2e artifacts not saved (reason)".
# The LANDED line shows "saved N e2e files to .claudedocs\e2e-pr<N>".
#
# The test loads the one function with the PowerShell parser. It never dot-sources land-pr.ps1,
# which calls `gh api` at top level. The wiring cases run land-pr.ps1 as a child process against a
# throwaway repo, a bare repo as remote `fork`, and a stub gh.cmd first on PATH.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$script = Join-Path $here 'land-pr.ps1'

$fail = 0
$pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ }
  else { Write-Host "FAIL  $name"; $script:fail++ }
}
function Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
function Write-Bytes([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
  [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::UTF8.GetBytes($text))
}

# --- scratch area -------------------------------------------------------------------------------
$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ("land-pr-e2e-copy-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$oldPath = $env:PATH

function Remove-Scratch {
  # Delete only the directory this run created, and only under the temp folder.
  $full = [System.IO.Path]::GetFullPath($work)
  if ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-e2e-copy-test-')) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  # --- load Save-E2eArtifacts from land-pr.ps1 --------------------------------------------------
  $tokens = $null; $errs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errs)
  Check 'land-pr.ps1 parses' (-not $errs -or $errs.Count -eq 0)
  $fnAst = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-E2eArtifacts' }, $true) | Select-Object -First 1
  $haveFn = [bool]$fnAst
  if ($haveFn) { Invoke-Expression $fnAst.Extent.Text }

  # --- 3. function cases ------------------------------------------------------------------------
  if (-not $haveFn) {
    foreach ($n in @(
        'function: copies nested files',
        'function: second run copies 0 and skips all',
        'function: a different file at the destination is a conflict, not overwritten',
        'function: missing source creates no folder',
        'function: empty source creates no folder',
        'function: a locked file returns an error and does not throw')) {
      Check "$n -- function Save-E2eArtifacts not found in land-pr.ps1" $false
    }
  } else {
    # nested copy + idempotent second run
    $src = Join-Path $work 'f1\src'; $dst = Join-Path $work 'f1\dst'
    Write-Bytes (Join-Path $src 'a.log') 'alpha'
    Write-Bytes (Join-Path $src 'sub\deep\b.json') '{"b":2}'
    $r1 = $null; $threw = $false
    try { $r1 = Save-E2eArtifacts -Source $src -Destination $dst } catch { $threw = $true }
    Check 'function: copies nested files' (-not $threw -and $r1.Copied -eq 2 -and $r1.Skipped -eq 0 -and @($r1.Conflicts).Count -eq 0 -and $null -eq $r1.Error -and
      (Test-Path (Join-Path $dst 'sub\deep\b.json')) -and (Sha (Join-Path $dst 'a.log')) -eq (Sha (Join-Path $src 'a.log')))
    $r2 = $null; $threw = $false
    try { $r2 = Save-E2eArtifacts -Source $src -Destination $dst } catch { $threw = $true }
    Check 'function: second run copies 0 and skips all' (-not $threw -and $r2.Copied -eq 0 -and $r2.Skipped -eq 2 -and @($r2.Conflicts).Count -eq 0 -and $null -eq $r2.Error)

    # conflict
    $src = Join-Path $work 'f2\src'; $dst = Join-Path $work 'f2\dst'
    Write-Bytes (Join-Path $src 'a.log') 'from the worktree'
    Write-Bytes (Join-Path $dst 'a.log') 'already saved, different'
    $before = Sha (Join-Path $dst 'a.log')
    $r3 = $null; $threw = $false
    try { $r3 = Save-E2eArtifacts -Source $src -Destination $dst } catch { $threw = $true }
    Check 'function: a different file at the destination is a conflict, not overwritten' (-not $threw -and @($r3.Conflicts).Count -eq 1 -and "$($r3.Conflicts[0])" -match 'a\.log' -and
      (Sha (Join-Path $dst 'a.log')) -eq $before)

    # missing and empty source
    $dstM = Join-Path $work 'f3\dst'
    $r4 = $null; $threw = $false
    try { $r4 = Save-E2eArtifacts -Source (Join-Path $work 'f3\no-such-src') -Destination $dstM } catch { $threw = $true }
    Check 'function: missing source creates no folder' (-not $threw -and $r4.Copied -eq 0 -and $null -eq $r4.Error -and -not (Test-Path $dstM))
    $srcE = Join-Path $work 'f4\src'; $dstE = Join-Path $work 'f4\dst'
    New-Item -ItemType Directory -Force -Path $srcE | Out-Null
    $r5 = $null; $threw = $false
    try { $r5 = Save-E2eArtifacts -Source $srcE -Destination $dstE } catch { $threw = $true }
    Check 'function: empty source creates no folder' (-not $threw -and $r5.Copied -eq 0 -and $null -eq $r5.Error -and -not (Test-Path $dstE))

    # locked file: FileShare.None makes the read fail
    $src = Join-Path $work 'f5\src'; $dst = Join-Path $work 'f5\dst'
    Write-Bytes (Join-Path $src 'locked.log') 'held open'
    $fs = [System.IO.File]::Open((Join-Path $src 'locked.log'), [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $r6 = $null; $threw = $false
    try { $r6 = Save-E2eArtifacts -Source $src -Destination $dst } catch { $threw = $true }
    finally { $fs.Dispose() }
    Check 'function: a locked file returns an error and does not throw' (-not $threw -and $null -ne $r6 -and -not [string]::IsNullOrEmpty("$($r6.Error)"))
  }

  # --- 1-2. wiring: land-pr.ps1 as a child process ----------------------------------------------
  $repoGit = Join-Path $work 'repo'
  $bare = Join-Path $work 'fork.git'
  $stub = Join-Path $work 'stub'
  $branch = 'fix/e2e-copy-wiring'
  $env:GIT_CONFIG_GLOBAL = Join-Path $work 'empty-gitconfig'
  Set-Content -LiteralPath $env:GIT_CONFIG_GLOBAL -Value ''
  $gitq = @('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL')

  function New-Fixture([string]$name) {
    # A fresh repo on main, a bare remote `fork` that has main, one worktree on an unpushed branch
    # that holds a gitignored .claude/cache/e2e/a.log. Returns the paths.
    $repo = Join-Path $work "$name\repo"; $remote = Join-Path $work "$name\fork.git"
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    git init -q -b main $repo 2>&1 | Out-Null
    Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Value ".claude/cache/`n.claude/worktrees/`n.claudedocs/"
    Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
    git -C $repo add -A 2>&1 | Out-Null
    git -C $repo @gitq commit -q -m init 2>&1 | Out-Null
    git init -q --bare -b main $remote 2>&1 | Out-Null
    git -C $repo remote add fork $remote
    git -C $repo push -q fork main 2>&1 | Out-Null
    $wt = Join-Path $repo '.claude\worktrees\wiring'
    git -C $repo worktree add -q $wt -b $branch main 2>&1 | Out-Null
    Write-Bytes (Join-Path $wt '.claude\cache\e2e\a.log') "evidence from $name"
    [pscustomobject]@{ Repo = $repo; Worktree = $wt; Log = (Join-Path $wt '.claude\cache\e2e\a.log') }
  }

  # stub gh.cmd answers only: gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/7
  New-Item -ItemType Directory -Force -Path $stub | Out-Null
  $sha = '0123456789abcdef0123456789abcdef01234567'
  Set-Content -LiteralPath (Join-Path $stub 'pull.json') -Value (@{ merged = $true; head = @{ ref = $branch; sha = $sha } } | ConvertTo-Json -Compress)
  Set-Content -LiteralPath (Join-Path $stub 'gh.cmd') -Encoding ascii -Value @(
    '@echo off',
    'if "%~1"=="api" if "%~2"=="repos/Rev4nchist/Continuous-Claude-v3/pulls/7" goto ok',
    'echo stub gh: unexpected arguments: %* 1>&2',
    'exit /b 1',
    ':ok',
    'type "%~dp0pull.json"',
    'exit /b 0')
  $env:PATH = "$stub;$oldPath"
  # Stop before any real gh call: if PowerShell does not resolve the stub, the probe below would run the host's gh.
  $ghFound = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($ghFound -ne (Join-Path $stub 'gh.cmd')) { throw "harness: gh resolves to '$ghFound', not the stub '$stub\gh.cmd'; stopping before any real gh call" }
  $viaStub = gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/7 | ConvertFrom-Json
  Check 'harness: stub gh answers PR 7' ($viaStub.merged -eq $true -and $viaStub.head.ref -eq $branch)

  function Invoke-Land([string]$repo) {
    $out = & pwsh -NoProfile -File $script -Pr 7 -CleanupOnly -NoSync -RepoPath $repo 2>&1
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
  }

  # 1. happy path
  $fx = New-Fixture 'w1'
  $want = Sha $fx.Log
  Check 'wiring: fixture worktree is clean to git yet holds the ignored log' ((-not (git -C $fx.Worktree status --porcelain)) -and (Test-Path $fx.Log))
  $run = Invoke-Land $fx.Repo
  $savedLog = Join-Path $fx.Repo '.claudedocs\e2e-pr7\a.log'
  Check 'wiring: land-pr exits 0' ($run.Code -eq 0)
  Check 'wiring: the PR worktree is removed' (-not (Test-Path $fx.Worktree))
  Check 'wiring: a.log is saved to .claudedocs\e2e-pr7 with the same SHA-256' ((Test-Path $savedLog) -and (Sha $savedLog) -eq $want)
  Check 'wiring: LANDED line says "saved 1 e2e files to .claudedocs\e2e-pr7"' ($run.Text -match 'LANDED #7:.*saved 1 e2e files to \.claudedocs\\e2e-pr7')
  if ($fail) { Write-Host "---- w1 land-pr output ----"; Write-Host $run.Text; Write-Host "---- end ----" }

  # 2. conflict: a different a.log is already saved
  $fx2 = New-Fixture 'w2'
  $seed = Join-Path $fx2.Repo '.claudedocs\e2e-pr7\a.log'
  Write-Bytes $seed 'an older, different a.log'
  $seedSha = Sha $seed
  $run2 = Invoke-Land $fx2.Repo
  Check 'wiring conflict: land-pr exits 0' ($run2.Code -eq 0)
  Check 'wiring conflict: the PR worktree is KEPT' (Test-Path $fx2.Worktree)
  Check 'wiring conflict: the saved a.log bytes are unchanged' ((Test-Path $seed) -and (Sha $seed) -eq $seedSha)
  Check 'wiring conflict: output says "kept worktree ...: e2e artifacts not saved"' ($run2.Text -match 'kept worktree .*e2e artifacts not saved')
  Check 'wiring conflict: the ignored log is still in the kept worktree' (Test-Path $fx2.Log)
}
finally {
  $env:PATH = $oldPath
  Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
  Remove-Scratch
}

Write-Host "passed=$pass failed=$fail"
exit $fail
