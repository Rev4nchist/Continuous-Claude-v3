<#
.SYNOPSIS
  Daily package-blocklist update. Commits ONLY to main, in a temporary worktree.

.WHY
  scripts/scheduled-blocklist-update.bat used to run in the primary checkout and commit onto
  whatever branch was checked out. On 2026-10-09 that put an unrelated commit onto the feature
  branch feat/security-scan. This script never touches the primary checkout's branch, index or
  working tree. It does the work in a throwaway detached worktree of <Remote>/<Branch>, the same
  pattern scripts/github/land-pr.ps1 uses for its sync.

.WHAT IT DOES
  1. git fetch <Remote> <Branch>
  2. git worktree add --detach %TEMP%\blocklist-update-<pid> <Remote>/<Branch>
  3. Link the primary checkout's .claude/hooks/node_modules into the worktree (junction).
  4. node scripts/update-blocklist.mjs --apply, then npm run build in .claude/hooks.
  5. Commit malicious-packages.json and dist/package-install-guard.mjs if they changed.
  6. git push <Remote> HEAD:refs/heads/<Branch>
  7. Fast-forward local <Branch> (merge --ff-only if the primary is on it, else fetch <Branch>:<Branch>).
  8. Sync ~/.claude from the worktree (SYNC_MAIN_DETACHED=1), unless -NoSync.
  9. Always: unlink the junction, remove the worktree.

  Exit 0 = success or nothing to do. Exit 1 = a step failed (the log names it).
  Exit 2 = pushed, but local main or ~/.claude did not follow (log line [PUSHED-NOT-SYNCED]).
  PowerShell 5.1 compatible (Task Scheduler runs powershell.exe), ASCII only.
#>
param(
  [string]$RepoPath = 'C:\Users\david.hayes\continuous-claude',
  [string]$Remote = 'fork',
  [string]$Branch = 'main',
  # Updater script, relative to the worktree. Tests point this at a stub; production keeps the default.
  [string]$UpdateScript = 'scripts/update-blocklist.mjs',
  # node_modules to link into the worktree. Default: the primary checkout's.
  [string]$NodeModules = '',
  [string]$GitBash = 'C:\Users\david.hayes\AppData\Local\Programs\Git\bin\bash.exe',
  [switch]$NoSync
)

# Continue, not Stop: in Windows PowerShell 5.1 a native command's stderr becomes a terminating
# error under Stop when redirected. Every native call below checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
if (-not $NodeModules) { $NodeModules = Join-Path $RepoPath '.claude\hooks\node_modules' }
# Always the personal gh account, as the old .bat did: a GH_CONFIG_DIR inherited from the task's
# environment must not switch the account update-blocklist.mjs uses.
$env:GH_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\gh-personal'

$gitSafe = Join-Path $PSScriptRoot 'git-safe.ps1'
$wtLeaf = 'blocklist-update-' + $PID
$wt = Join-Path ([System.IO.Path]::GetTempPath()) $wtLeaf
$wtNodeModules = Join-Path $wt '.claude\hooks\node_modules'
$msgFile = Join-Path ([System.IO.Path]::GetTempPath()) ('blocklist-update-msg-' + $PID + '.txt')

function Log([string]$msg) { Write-Host ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg) }
function GitPrimary { & git -C $RepoPath @args 2>&1 | ForEach-Object { "$_" } }

function Invoke-Body {
  Log "Starting blocklist update. Primary checkout: $RepoPath"
  $current = (git -C $RepoPath rev-parse --abbrev-ref HEAD 2>$null)
  if ($current -eq $Branch) {
    Log "Primary checkout is on '$Branch'. Only a fast-forward of '$Branch' will touch it."
  } else {
    Log "Primary checkout is on '$current'. Its branch, index and working tree are not touched."
  }

  if (-not (Test-Path (Join-Path $NodeModules 'esbuild'))) {
    Log "[ERROR] node_modules not found at $NodeModules (the hook build needs esbuild)"
    return 1
  }

  Log "Fetching $Remote/$Branch..."
  GitPrimary fetch $Remote $Branch | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { Log "[ERROR] git fetch $Remote $Branch failed"; return 1 }

  GitPrimary worktree prune | Out-Null
  $base = (git -C $RepoPath rev-parse "refs/remotes/$Remote/$Branch")
  GitPrimary worktree add --quiet --detach $wt "refs/remotes/$Remote/$Branch" | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { Log "[ERROR] could not create the temp worktree $wt"; return 1 }
  Log "Temp worktree $wt at $Remote/$Branch ($($base.Substring(0,7)))"

  New-Item -ItemType Junction -Path $wtNodeModules -Target $NodeModules | Out-Null
  if (-not (Test-Path $wtNodeModules)) { Log "[ERROR] could not link node_modules"; return 1 }

  Push-Location $wt
  try {
    Log 'Fetching advisories from GitHub...'
    & node $UpdateScript --apply | Out-Host
    if ($LASTEXITCODE -ne 0) { Log '[ERROR] Blocklist update failed'; return 1 }

    Log 'Rebuilding hooks...'
    Push-Location (Join-Path $wt '.claude\hooks')
    try { & npm.cmd run build | Out-Host; $buildRc = $LASTEXITCODE } finally { Pop-Location }
    if ($buildRc -ne 0) { Log '[ERROR] Hook build failed'; return 1 }

    # A failed add (an index.lock, say) would leave nothing staged and read as "no changes": check it.
    $addOut = & git add -- .claude/hooks/src/shared/malicious-packages.json .claude/hooks/dist/package-install-guard.mjs 2>&1
    if ($LASTEXITCODE -ne 0) { Log "[ERROR] git add failed: $addOut"; return 1 }
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Log 'No blocklist changes detected'; Log 'Blocklist update complete'; return 0 }

    Log "Committing updated blocklist to $Branch..."
    Set-Content -Path $msgFile -Value 'chore(security): daily blocklist update [automated]' -Encoding ASCII
    & $gitSafe -C $wt commit -F $msgFile | ForEach-Object { Log "  $_" }
    if ($LASTEXITCODE -ne 0) { Log '[ERROR] Blocklist commit failed'; return 1 }
    $newSha = (git rev-parse HEAD)

    # HEAD:refs/heads/<Branch> names the target explicitly. A bare `git push fork HEAD` follows the
    # current branch, which is how this job once pushed the wrong thing.
    & $gitSafe -C $wt push $Remote "HEAD:refs/heads/$Branch" | ForEach-Object { Log "  $_" }
    if ($LASTEXITCODE -ne 0) {
      Log "[ERROR] Push to $Remote/$Branch failed. The commit existed only in the temp worktree and is discarded; the next run retries."
      return 1
    }
    Log "Pushed $($newSha.Substring(0,7)) to $Remote/$Branch"
  }
  finally { Pop-Location }

  # Advance local <Branch> so the next pull is a no-op and the sync cursor can match it.
  if ($current -eq $Branch) {
    GitPrimary merge --ff-only "refs/remotes/$Remote/$Branch" | ForEach-Object { Log "  $_" }
  } else {
    GitPrimary fetch $Remote "${Branch}:${Branch}" | ForEach-Object { Log "  $_" }
  }
  $localOk = ($LASTEXITCODE -eq 0)
  if (-not $localOk) { Log "[WARN] local $Branch did not fast-forward; it is behind $Remote/$Branch. Run: git pull --ff-only on $Branch" }

  $synced = $false
  if ($NoSync) { Log 'Sync skipped (-NoSync)'; $synced = $true }
  elseif (-not $localOk) { Log "Sync skipped: local $Branch is not at the pushed commit" }
  else {
    Log 'Syncing to active directory...'
    Push-Location $wt
    try {
      # sync-to-active.sh only syncs from main. A detached HEAD exactly at local main is accepted
      # with SYNC_MAIN_DETACHED=1 (same as land-pr.ps1).
      $env:SYNC_MAIN_DETACHED = '1'
      & $GitBash scripts/sync-to-active.sh --changed | ForEach-Object { Log "  $_" }
      if ($LASTEXITCODE -ne 0) { Log "[WARN] sync exited $LASTEXITCODE; run scripts/sync-to-active.sh --changed from $Branch by hand" }
      else { $synced = $true }
    }
    finally { Remove-Item Env:\SYNC_MAIN_DETACHED -ErrorAction SilentlyContinue; Pop-Location }
  }
  # Exit 2 keeps the gap visible in Task Scheduler's Last Result: the push landed, but local
  # main or ~/.claude did not follow.
  if (-not $synced) { Log '[PUSHED-NOT-SYNCED] the commit is on the remote; local main or ~/.claude is behind'; return 2 }
  Log 'Blocklist update complete'
  return 0
}

function Remove-TempWorktree {
  if (Test-Path -LiteralPath $msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
  if (-not (Test-Path -LiteralPath $wt)) { GitPrimary worktree prune | Out-Null; return }
  # Unlink the junction FIRST. Directory.Delete without recurse removes only the link; a recursive
  # delete (or git worktree remove) through a live junction would empty the real node_modules.
  if (Test-Path -LiteralPath $wtNodeModules) {
    try { [System.IO.Directory]::Delete($wtNodeModules, $false) } catch { }
    if (Test-Path -LiteralPath $wtNodeModules) {
      Log "[WARN] could not unlink $wtNodeModules; leaving $wt in place. Remove the link, then: git -C $RepoPath worktree remove --force $wt"
      return
    }
  }
  GitPrimary worktree remove --force $wt | Out-Null
  if (Test-Path -LiteralPath $wt) {
    # git can drop the registration and leave the directory. Delete it only when git no longer
    # lists it and it is provably our own temp directory.
    $listed = @(git -C $RepoPath worktree list --porcelain | Where-Object { $_ -like 'worktree *' } |
      ForEach-Object { Split-Path $_.Substring(9) -Leaf }) -contains $wtLeaf
    $full = [System.IO.Path]::GetFullPath($wt)
    $tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $ownsIt = $full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('blocklist-update-')
    if (-not $listed -and $ownsIt) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $wt) { Log "[WARN] could not remove temp worktree $wt" } else { Log 'Temp worktree removed' }
  GitPrimary worktree prune | Out-Null
}

$rc = 1
try { $rc = @(Invoke-Body)[-1] }
catch { Log "[ERROR] $($_.Exception.Message)"; $rc = 1 }
finally { Remove-TempWorktree }
exit $rc
