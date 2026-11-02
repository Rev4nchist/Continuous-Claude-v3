# land-pr.ps1 must unlink every junction and symlink in a PR worktree before it removes the worktree.
# Run: pwsh -NoProfile -File scripts/github/land-pr-worktree-links.test.ps1
#
# Incident 2026-11-01 (/land 243): a gitignored node_modules junction at the worktree root pointed
# at the primary checkout's node_modules. `git worktree remove` (no --force; the worktree looked
# clean because node_modules is gitignored) followed the junction and emptied the primary
# checkout's node_modules. Git for Windows 2.47.1 does this; Remove-Item -Recurse does not.
#
# Contract under test: function Remove-WorktreeLinks in land-pr.ps1
#   Remove-WorktreeLinks -Path <dir>
#   Returns an object with: Removed (string[]), Remaining (string[]), Error (string or $null).
#   - Finds every reparse point (junction or symlink) under Path without descending into one.
#   - Deletes only the link, never the target. A link that cannot be removed goes in Remaining.
#   - Never throws. Self-contained: uses no script-level variable of land-pr.ps1.
# Wiring contract: land-pr.ps1 calls it before `git worktree remove`; when Remaining is not empty
# it keeps the worktree and prints "kept worktree X: link not removed (<link>)".
#
# Failure modes -> test:
#   cleanup deletes through the junction (target emptied)          -> F1, W1
#   the walk descends into a junction target and unlinks inside it -> F2
#   a link nested in a subfolder is missed                         -> F2
#   a file symlink is missed or its target removed                 -> F3 (skipped when symlinks are not allowed)
#   a tree with no link returns a false Removed entry or throws    -> F4
#   an unremovable link is ignored and the worktree still goes     -> F5, W2 (failure injected: see below)
#   a TRACKED symlink is unlinked, so git sees a tracked deletion
#   and refuses the removal (or a later run skips the cleanup)     -> F6, W3
#   the old unlink covered only .claude\hooks\node_modules         -> W1 (root node_modules)
#   the primary checkout is on the PR branch and the cleanup walks
#   it, unlinking junctions of other sessions' worktrees            -> W4
#
# An unremovable link cannot be made reliably: Windows ignores FILE_ATTRIBUTE_READONLY on directories.
# So the failure is injected: F5 passes -Delete a scriptblock that throws; W2 sets the test-only env var
# LAND_PR_TEST_FAIL_UNLINK, which makes land-pr.ps1 inject the same throwing unlink.
# Links are created only under the OS temp folder, never in the repo.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$script = Join-Path $here 'land-pr.ps1'

$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}
function Write-Bytes([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
  [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::UTF8.GetBytes($text))
}
function New-Junction([string]$link, [string]$target) {
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

$tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tmpRoot ('land-pr-links-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$oldPath = $env:PATH

function Remove-Scratch {
  # Unlink every link first so the recursive delete below cannot reach a target. Only this run's folder.
  $full = [System.IO.Path]::GetFullPath($work)
  if (-not ($full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-links-test-'))) { return }
  $stack = [System.Collections.Generic.Stack[string]]::new(); $stack.Push($full)
  while ($stack.Count) {
    $dir = $stack.Pop()
    foreach ($e in @([System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos())) {
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        try { $e.Attributes = $e.Attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly) } catch { }
        if ($e -is [System.IO.DirectoryInfo]) { try { $e.Delete() } catch { } } else { try { $e.Delete() } catch { } }
      } elseif ($e -is [System.IO.DirectoryInfo]) { $stack.Push($e.FullName) }
    }
  }
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  # --- load Remove-WorktreeLinks from land-pr.ps1 -------------------------------------------------
  $tokens = $null; $errs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errs)
  Check 'land-pr.ps1 parses' (-not $errs -or $errs.Count -eq 0)
  $fnAst = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Remove-WorktreeLinks' }, $true) | Select-Object -First 1
  $haveFn = [bool]$fnAst
  if ($haveFn) { Invoke-Expression $fnAst.Extent.Text }

  if (-not $haveFn) {
    foreach ($n in @(
        'F1 function: a junction is unlinked and its target survives',
        'F2 function: the walk does not descend into a junction target; a nested link is unlinked',
        'F3 function: a file symlink is unlinked and its target survives',
        'F4 function: a tree with no link returns nothing and does not throw',
        'F5 function: a link that cannot be removed is reported in Remaining',
        'F6 function: a link in -SkipPaths is left alone and not reported')) {
      Check "$n -- function Remove-WorktreeLinks not found in land-pr.ps1" $false
    }
  } else {
    # F1
    $t = Join-Path $work 'f1\target'; $wt = Join-Path $work 'f1\wt'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    Write-Bytes (Join-Path $wt 'src.txt') 'tracked'
    New-Junction (Join-Path $wt 'node_modules') $t
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt } catch { $threw = $true }
    Check 'F1 function: a junction is unlinked and its target survives' (-not $threw -and @($r.Removed).Count -eq 1 -and @($r.Remaining).Count -eq 0 -and $null -eq $r.Error -and
      -not (Test-Path -LiteralPath (Join-Path $wt 'node_modules')) -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')) -and (Test-Path -LiteralPath (Join-Path $wt 'src.txt')))

    # F2: a junction INSIDE the target points at a third folder. A walk that follows links would unlink it.
    $other = Join-Path $work 'f2\other'; $t = Join-Path $work 'f2\target'; $wt = Join-Path $work 'f2\wt'
    Write-Bytes (Join-Path $other 'o.txt') 'other data'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    New-Junction (Join-Path $t 'inner-link') $other
    Write-Bytes (Join-Path $wt 'a\b\x.txt') 'x'
    New-Junction (Join-Path $wt 'node_modules') $t
    New-Junction (Join-Path $wt 'a\b\deep-link') $other
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt } catch { $threw = $true }
    Check 'F2 function: the walk does not descend into a junction target; a nested link is unlinked' (-not $threw -and @($r.Removed).Count -eq 2 -and @($r.Remaining).Count -eq 0 -and
      -not (Test-Path -LiteralPath (Join-Path $wt 'node_modules')) -and -not (Test-Path -LiteralPath (Join-Path $wt 'a\b\deep-link')) -and
      (Test-Path -LiteralPath (Join-Path $t 'inner-link')) -and (Test-Path -LiteralPath (Join-Path $other 'o.txt')) -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')))

    # F3: file symlink (needs Developer Mode or elevation; skipped with a reason when not allowed)
    $t = Join-Path $work 'f3\target'; $wt = Join-Path $work 'f3\wt'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    New-Item -ItemType Directory -Force -Path $wt | Out-Null
    $symOk = $true
    try { New-Item -ItemType SymbolicLink -Path (Join-Path $wt 'link.txt') -Target (Join-Path $t 'keep.txt') -ErrorAction Stop | Out-Null } catch { $symOk = $false }
    if ($symOk) {
      $r = $null; $threw = $false
      try { $r = Remove-WorktreeLinks -Path $wt } catch { $threw = $true }
      Check 'F3 function: a file symlink is unlinked and its target survives' (-not $threw -and @($r.Removed).Count -eq 1 -and -not (Test-Path -LiteralPath (Join-Path $wt 'link.txt')) -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')))
    } else { Write-Host 'SKIP  F3 function: this account cannot create symlinks (no Developer Mode or elevation)' }

    # F4
    $wt = Join-Path $work 'f4\wt'
    Write-Bytes (Join-Path $wt 'a\b.txt') 'plain'
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt } catch { $threw = $true }
    Check 'F4 function: a tree with no link returns nothing and does not throw' (-not $threw -and @($r.Removed).Count -eq 0 -and @($r.Remaining).Count -eq 0 -and $null -eq $r.Error -and (Test-Path -LiteralPath (Join-Path $wt 'a\b.txt')))

    # F5: inject a failing unlink. The link and its target must stay, and the link is named in Remaining.
    $t = Join-Path $work 'f5\target'; $wt = Join-Path $work 'f5\wt'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    New-Item -ItemType Directory -Force -Path $wt | Out-Null
    $stuck = Join-Path $wt 'node_modules'
    New-Junction $stuck $t
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt -Delete { param($info) throw 'injected unlink failure' } } catch { $threw = $true }
    Check 'F5 function: a link that cannot be removed is reported in Remaining' (-not $threw -and @($r.Remaining).Count -eq 1 -and "$($r.Remaining[0])" -like '*node_modules' -and @($r.Removed).Count -eq 0 -and
      "$($r.Error)" -match 'injected unlink failure' -and (Test-Path -LiteralPath $stuck) -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')))

    # F6: a path in -SkipPaths (a tracked link; git removes it) is not touched; another link still goes.
    $t = Join-Path $work 'f6\target'; $wt = Join-Path $work 'f6\wt'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    New-Item -ItemType Directory -Force -Path $wt | Out-Null
    $kept = Join-Path $wt 'tracked-dir-link'; $gone = Join-Path $wt 'node_modules'
    New-Junction $kept $t; New-Junction $gone $t
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt -SkipPaths @($kept.ToUpperInvariant()) } catch { $threw = $true }
    Check 'F6 function: a link in -SkipPaths is left alone and not reported' (-not $threw -and (Test-Path -LiteralPath $kept) -and -not (Test-Path -LiteralPath $gone) -and
      @($r.Removed).Count -eq 1 -and @($r.Remaining).Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')))
  }

  # --- wiring: land-pr.ps1 as a child process, worktree removed through git ------------------------
  $stub = Join-Path $work 'stub'
  $branch = 'fix/links-wiring'
  $env:GIT_CONFIG_GLOBAL = Join-Path $work 'empty-gitconfig'
  Set-Content -LiteralPath $env:GIT_CONFIG_GLOBAL -Value ''
  $gitq = @('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL')

  function New-Fixture([string]$name, [switch]$TrackedLinks) {
    # A repo on main (node_modules/ gitignored, like the real repo), a bare remote `fork`, and one
    # clean worktree whose ROOT node_modules is a junction to a folder outside the repo.
    $repo = Join-Path $work "$name\repo"; $remote = Join-Path $work "$name\fork.git"; $target = Join-Path $work "$name\primary-node_modules"
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    git init -q -b main $repo 2>&1 | Out-Null
    Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Value "node_modules/`n.claude/cache/`n.claude/worktrees/`n.claudedocs/"
    Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
    $extDir = Join-Path $work "$name\tracked-dir-target"
    if ($TrackedLinks) {
      # Real tracked symlinks (mode 120000): one to a file, one to a folder outside the repo.
      Write-Bytes (Join-Path $extDir 'ext.txt') 'outside the repo'
      git -C $repo config core.symlinks true
      New-Item -ItemType SymbolicLink -Path (Join-Path $repo 'tracked-file-link') -Target 'README.md' | Out-Null
      New-Item -ItemType SymbolicLink -Path (Join-Path $repo 'tracked-dir-link') -Target $extDir | Out-Null
    }
    git -C $repo add -A 2>&1 | Out-Null
    git -C $repo @gitq commit -q -m init 2>&1 | Out-Null
    git init -q --bare -b main $remote 2>&1 | Out-Null
    git -C $repo remote add fork $remote
    git -C $repo push -q fork main 2>&1 | Out-Null
    $wt = Join-Path $repo '.claude\worktrees\wiring'
    git -C $repo worktree add -q $wt -b $branch main 2>&1 | Out-Null
    Write-Bytes (Join-Path $target 'pkg\index.js') 'primary checkout dependency'
    New-Junction (Join-Path $wt 'node_modules') $target
    [pscustomobject]@{ Repo = $repo; Worktree = $wt; Target = $target; TargetFile = (Join-Path $target 'pkg\index.js'); ExtFile = (Join-Path $extDir 'ext.txt') }
  }

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
  $ghFound = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($ghFound -ne (Join-Path $stub 'gh.cmd')) { throw "harness: gh resolves to '$ghFound', not the stub '$stub\gh.cmd'; stopping before any real gh call" }

  function Invoke-Land([string]$repo) {
    $out = & pwsh -NoProfile -File $script -Pr 7 -CleanupOnly -NoSync -RepoPath $repo 2>&1
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) }
  }

  # W1: the incident. Clean worktree, root node_modules junction to a folder with data.
  $fx = New-Fixture 'w1'
  Check 'W1 harness: the fixture worktree is clean to git yet holds the junction' ((-not (git -C $fx.Worktree status --porcelain)) -and (Test-Path -LiteralPath (Join-Path $fx.Worktree 'node_modules')))
  $run = Invoke-Land $fx.Repo
  Check 'W1 wiring: land-pr exits 0' ($run.Code -eq 0)
  Check 'W1 wiring: the junction TARGET and its file survive the cleanup' ((Test-Path -LiteralPath $fx.Target) -and (Test-Path -LiteralPath $fx.TargetFile))
  Check 'W1 wiring: the PR worktree is removed' (-not (Test-Path -LiteralPath $fx.Worktree))
  Check 'W1 wiring: LANDED line says the worktree was removed' ($run.Text -match 'LANDED #7:.*removed worktree')
  if ($fail) { Write-Host '---- w1 land-pr output ----'; Write-Host $run.Text; Write-Host '---- end ----' }

  # W2: a link that cannot be unlinked keeps the worktree and is named.
  $fx2 = New-Fixture 'w2'
  $env:LAND_PR_TEST_FAIL_UNLINK = '1'   # test-only: land-pr.ps1 injects an unlink that throws
  try { $run2 = Invoke-Land $fx2.Repo } finally { Remove-Item Env:\LAND_PR_TEST_FAIL_UNLINK -ErrorAction SilentlyContinue }
  Check 'W2 wiring: land-pr exits 0' ($run2.Code -eq 0)
  Check 'W2 wiring: the worktree is KEPT' (Test-Path -LiteralPath $fx2.Worktree)
  Check 'W2 wiring: the target and its file survive' (Test-Path -LiteralPath $fx2.TargetFile)
  Check 'W2 wiring: output says "kept worktree ...: link not removed" and names node_modules' ($run2.Text -match 'kept worktree .*link not removed.*node_modules')
  if ($fail) { Write-Host '---- w2 land-pr output ----'; Write-Host $run2.Text; Write-Host '---- end ----' }

  # W3: a TRACKED symlink (git removes it as a file, never follows it) plus the ignored junction.
  $fx3 = $null; $symOk3 = $true
  try { $fx3 = New-Fixture 'w3' -TrackedLinks } catch { $symOk3 = $false }
  if ($symOk3 -and $fx3) {
    $modes = @(git -C $fx3.Repo ls-files -s | Where-Object { $_ -match '^120000 ' })
    $linkInWt = Join-Path $fx3.Worktree 'tracked-dir-link'
    Check 'W3 harness: two tracked symlinks exist and the worktree holds real links' ($modes.Count -eq 2 -and ((Get-Item -LiteralPath $linkInWt -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and -not (git -C $fx3.Worktree status --porcelain))
    $run3 = Invoke-Land $fx3.Repo
    Check 'W3 wiring: land-pr exits 0' ($run3.Code -eq 0)
    Check 'W3 wiring: the PR worktree is removed (git was not left with a tracked deletion)' (-not (Test-Path -LiteralPath $fx3.Worktree))
    Check 'W3 wiring: the junction target and the tracked dir symlink target survive' ((Test-Path -LiteralPath $fx3.TargetFile) -and (Test-Path -LiteralPath $fx3.ExtFile))
    Check 'W3 wiring: LANDED line says the worktree was removed' ($run3.Text -match 'LANDED #7:.*removed worktree')
    if ($fail) { Write-Host '---- w3 land-pr output ----'; Write-Host $run3.Text; Write-Host '---- end ----' }
  } else { Write-Host 'SKIP  W3: this account cannot create tracked symlinks (no Developer Mode or elevation)' }

  # W4: the PRIMARY checkout is on the PR branch. Its worktree entry is the main one: land-pr must not
  # walk it, or it unlinks the junctions of other sessions' worktrees that sit under .claude\worktrees.
  $fx4 = New-Fixture 'w4'
  [System.IO.DirectoryInfo]::new((Join-Path $fx4.Worktree 'node_modules')).Delete()   # unlink only; keeps the target
  git -C $fx4.Repo worktree remove $fx4.Worktree 2>&1 | Out-Null
  git -C $fx4.Repo checkout -q $branch 2>&1 | Out-Null
  $sibling = Join-Path $fx4.Repo '.claude\worktrees\sibling'
  git -C $fx4.Repo worktree add -q $sibling -b other/sibling main 2>&1 | Out-Null
  $siblingLink = Join-Path $sibling 'node_modules'
  New-Junction $siblingLink $fx4.Target
  git -C $fx4.Repo push -q fork $branch 2>&1 | Out-Null   # the PR branch exists on the remote, as it does after a real PR
  Check 'W4 harness: the primary is on the PR branch and a sibling worktree holds a junction' (((git -C $fx4.Repo branch --show-current) -eq $branch) -and (Test-Path -LiteralPath $siblingLink))
  # land-pr deletes the remote branch through <repo>\scripts\git-safe.ps1. Give the fixture a real copy, or the delete would fail and the check below could not tell a skip from a failure.
  New-Item -ItemType Directory -Force -Path (Join-Path $fx4.Repo 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $here '..\git-safe.ps1') -Destination (Join-Path $fx4.Repo 'scripts\git-safe.ps1')
  Check 'W4 harness: the PR branch exists on the remote before the run' ([bool](git -C $fx4.Repo ls-remote --heads fork $branch))
  $run4 = Invoke-Land $fx4.Repo
  Check 'W4 wiring: land-pr exits 0' ($run4.Code -eq 0)
  Check 'W4 wiring: the sibling worktree junction is intact' (Test-Path -LiteralPath $siblingLink)
  Check 'W4 wiring: the junction target and its file survive' ((Test-Path -LiteralPath $fx4.Target) -and (Test-Path -LiteralPath $fx4.TargetFile))
  Check 'W4 wiring: output says "kept primary checkout" (the guard message is present)' ($run4.Text -match 'kept primary checkout')
  Check 'W4 wiring: the primary checkout is not reported as removed or unlinked' ($run4.Text -notmatch 'unlinked \d+ link' -and $run4.Text -notmatch 'removed worktree')
  # The primary stays on a branch that git branch -d refuses to delete. Deleting the remote branch would
  # leave the primary on a branch that no longer exists on the remote. Keep it and tell Dave what to do.
  Check 'W4 wiring: the remote branch still exists (the primary is on it)' ([bool](git -C $fx4.Repo ls-remote --heads fork $branch))
  Check 'W4 wiring: output tells Dave to switch the primary to main and delete the branch' ($run4.Text -match "kept fork/$([regex]::Escape($branch)).*switch the primary to main and delete the branch")
  Check 'W4 wiring: the remote delete is not reported' ($run4.Text -notmatch 'deleted fork/')
  if ($fail) { Write-Host '---- w4 land-pr output ----'; Write-Host $run4.Text; Write-Host '---- end ----' }

  # W5: the primary is on main when land-pr starts, then another session switches it to the PR branch. The
  # remote delete must re-read the primary's branch and keep the remote branch.
  $fx5 = New-Fixture 'w5'
  git -C $fx5.Repo push -q fork $branch 2>&1 | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fx5.Repo 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $here '..\git-safe.ps1') -Destination (Join-Path $fx5.Repo 'scripts\git-safe.ps1')
  Check 'W5 harness: the primary is on main and the PR branch exists on the remote' (((git -C $fx5.Repo branch --show-current) -eq 'main') -and [bool](git -C $fx5.Repo ls-remote --heads fork $branch))
  $env:LAND_PR_TEST_SWITCH_PRIMARY = '1'   # test-only: land-pr.ps1 switches the primary to the branch after the worktree step
  try { $run5 = Invoke-Land $fx5.Repo } finally { Remove-Item Env:\LAND_PR_TEST_SWITCH_PRIMARY -ErrorAction SilentlyContinue }
  Check 'W5 wiring: land-pr exits 0 and the primary was switched to the PR branch' ($run5.Code -eq 0 -and ((git -C $fx5.Repo branch --show-current) -eq $branch))
  Check 'W5 wiring: the remote branch still exists' ([bool](git -C $fx5.Repo ls-remote --heads fork $branch))
  Check 'W5 wiring: output says the remote branch is kept and no remote delete is reported' ($run5.Text -match "kept fork/$([regex]::Escape($branch))" -and $run5.Text -notmatch 'deleted fork/')
  if ($fail) { Write-Host '---- w5 land-pr output ----'; Write-Host $run5.Text; Write-Host '---- end ----' }
}
finally {
  $env:PATH = $oldPath
  Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
  Remove-Scratch
}

Write-Host "passed=$pass failed=$fail"
exit $fail
