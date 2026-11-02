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
#   an unremovable link is ignored and the worktree still goes     -> F5, W2
#   the old unlink covered only .claude\hooks\node_modules         -> W1 (root node_modules)
#
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
        'F5 function: a link that cannot be removed is reported in Remaining')) {
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

    # F5: a read-only junction makes DirectoryInfo.Delete() throw "Access denied"
    $t = Join-Path $work 'f5\target'; $wt = Join-Path $work 'f5\wt'
    Write-Bytes (Join-Path $t 'keep.txt') 'target data'
    New-Item -ItemType Directory -Force -Path $wt | Out-Null
    $stuck = Join-Path $wt 'node_modules'
    New-Junction $stuck $t
    $li = Get-Item -LiteralPath $stuck -Force
    $li.Attributes = $li.Attributes -bor [System.IO.FileAttributes]::ReadOnly
    $r = $null; $threw = $false
    try { $r = Remove-WorktreeLinks -Path $wt } catch { $threw = $true }
    Check 'F5 function: a link that cannot be removed is reported in Remaining' (-not $threw -and @($r.Remaining).Count -eq 1 -and "$($r.Remaining[0])" -like '*node_modules' -and
      (Test-Path -LiteralPath $stuck) -and (Test-Path -LiteralPath (Join-Path $t 'keep.txt')))
  }

  # --- wiring: land-pr.ps1 as a child process, worktree removed through git ------------------------
  $stub = Join-Path $work 'stub'
  $branch = 'fix/links-wiring'
  $env:GIT_CONFIG_GLOBAL = Join-Path $work 'empty-gitconfig'
  Set-Content -LiteralPath $env:GIT_CONFIG_GLOBAL -Value ''
  $gitq = @('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL')

  function New-Fixture([string]$name) {
    # A repo on main (node_modules/ gitignored, like the real repo), a bare remote `fork`, and one
    # clean worktree whose ROOT node_modules is a junction to a folder outside the repo.
    $repo = Join-Path $work "$name\repo"; $remote = Join-Path $work "$name\fork.git"; $target = Join-Path $work "$name\primary-node_modules"
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    git init -q -b main $repo 2>&1 | Out-Null
    Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Value "node_modules/`n.claude/cache/`n.claude/worktrees/`n.claudedocs/"
    Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'fixture'
    git -C $repo add -A 2>&1 | Out-Null
    git -C $repo @gitq commit -q -m init 2>&1 | Out-Null
    git init -q --bare -b main $remote 2>&1 | Out-Null
    git -C $repo remote add fork $remote
    git -C $repo push -q fork main 2>&1 | Out-Null
    $wt = Join-Path $repo '.claude\worktrees\wiring'
    git -C $repo worktree add -q $wt -b $branch main 2>&1 | Out-Null
    Write-Bytes (Join-Path $target 'pkg\index.js') 'primary checkout dependency'
    New-Junction (Join-Path $wt 'node_modules') $target
    [pscustomobject]@{ Repo = $repo; Worktree = $wt; Target = $target; TargetFile = (Join-Path $target 'pkg\index.js') }
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
  $stuck = Join-Path $fx2.Worktree 'node_modules'
  $li = Get-Item -LiteralPath $stuck -Force
  $li.Attributes = $li.Attributes -bor [System.IO.FileAttributes]::ReadOnly
  $run2 = Invoke-Land $fx2.Repo
  Check 'W2 wiring: land-pr exits 0' ($run2.Code -eq 0)
  Check 'W2 wiring: the worktree is KEPT' (Test-Path -LiteralPath $fx2.Worktree)
  Check 'W2 wiring: the target and its file survive' (Test-Path -LiteralPath $fx2.TargetFile)
  Check 'W2 wiring: output says "kept worktree ...: link not removed" and names node_modules' ($run2.Text -match 'kept worktree .*link not removed.*node_modules')
  if ($fail) { Write-Host '---- w2 land-pr output ----'; Write-Host $run2.Text; Write-Host '---- end ----' }
}
finally {
  $env:PATH = $oldPath
  Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
  Remove-Scratch
}

Write-Host "passed=$pass failed=$fail"
exit $fail
