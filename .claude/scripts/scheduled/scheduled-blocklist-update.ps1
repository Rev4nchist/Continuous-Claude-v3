<#
.SYNOPSIS
  Daily package-blocklist update. Commits ONLY to main, in a temporary worktree.

.WHY
  The old scripts/scheduled-blocklist-update.bat ran in the primary checkout and committed onto
  whatever branch was checked out. On 2026-10-09 that put an unrelated commit onto the feature
  branch feat/security-scan. This script never touches the primary checkout's branch, index or
  working tree. It does the work in a throwaway detached worktree of <Remote>/<Branch>, the same
  pattern scripts/github/land-pr.ps1 uses for its sync.

  This file lives in the repo at .claude/scripts/scheduled/. The forward sync installs it at
  ~/.claude/scripts/scheduled/, and the scheduled task runs that copy, so the job is always main's
  version. git-safe.ps1 is loaded from the temp worktree of main for the same reason.

.WHAT IT DOES
  1. git fetch <Remote> <Branch>
  2. git worktree add --detach %TEMP%\blocklist-update-<pid> <Remote>/<Branch>
  3. Link the primary checkout's .claude/hooks/node_modules into the worktree (junction).
  4. node scripts/update-blocklist.mjs --apply, then npm run build in .claude/hooks.
  5. If malicious-packages.json or dist/package-install-guard.mjs changed: commit them and
     git push <Remote> HEAD:refs/heads/<Branch>. If nothing changed, skip only this step.
     The build is slow, so <Remote>/<Branch> can move before the push. A rejected push is handled so:
     git fetch <Remote> <Branch>. If the tip did not move since this attempt started, exit 1 at once
     (not a race, no retry). If it moved, reset the temp worktree to the new tip (detached; the ignored
     node_modules junction stays) and run steps 4 and 5 again, so the commit is built from the new tip.
     At most 3 attempts; then exit 1 with the log line [PUSH-RACE] ... giving up. Never a force push.
  6. Always: advance local <Branch>. A fresh read of the checked-out branch decides how: exactly
     <Branch> -> merge --ff-only; anything else -> git fetch <Remote> <Branch>:<Branch>.
     No other branch is ever moved.
  7. Sync ~/.claude from the worktree (SYNC_MAIN_DETACHED=1), then compare ~/.claude/state/sync-cursor
     with local <Branch>. -NoSync waives only this step.
  8. Always: unlink the junction, remove the worktree.

  Steps 6 and 7 run even when nothing changed, so a run that pushed earlier but could not advance
  local main or ~/.claude catches up on the next run.

  Exit 0 = success or nothing to do. Exit 1 = a step failed (the log names it).
  Exit 2 = local main or ~/.claude did not follow the remote (log line [PUSHED-NOT-SYNCED]).
  PowerShell 5.1 compatible (Task Scheduler runs powershell.exe), ASCII only.
#>
param(
  [string]$RepoPath = '',
  [string]$Remote = 'fork',
  [string]$Branch = 'main',
  # Updater script, relative to the worktree. Tests point this at a stub; production keeps the default.
  [string]$UpdateScript = 'scripts/update-blocklist.mjs',
  # node_modules to link into the worktree. Default: the primary checkout's.
  [string]$NodeModules = '',
  [string]$GitBash = '',
  # File sync-to-active.sh writes the last synced commit to. Tests point this into %TEMP%.
  [string]$SyncCursor = '',
  # Waives only the ~/.claude sync and its cursor check. A failed local update still returns 2.
  [switch]$NoSync
)

# Continue, not Stop: in Windows PowerShell 5.1 a native command's stderr becomes a terminating
# error under Stop when redirected. Every native call below checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'profile-paths.ps1')
$paths = Get-Ccv3Paths
if (-not $RepoPath) { $RepoPath = $paths.RepoRoot }
if (-not $GitBash) { $GitBash = $paths.GitBash }
if (-not $NodeModules) { $NodeModules = Join-Path $RepoPath '.claude\hooks\node_modules' }
if (-not $SyncCursor) { $SyncCursor = Join-Path $HOME '.claude\state\sync-cursor' }
# Use the personal gh account when its own config folder exists, as the old .bat did: a GH_CONFIG_DIR
# inherited from the task's environment must not switch the account update-blocklist.mjs uses.
# When the folder is absent (a machine with one gh login), clear any inherited value so gh falls back
# to its default config instead of pointing at a missing folder.
$ghPersonal = Join-Path $env:USERPROFILE '.config\gh-personal'
if (Test-Path -LiteralPath $ghPersonal -PathType Container) { $env:GH_CONFIG_DIR = $ghPersonal }
else { Remove-Item Env:\GH_CONFIG_DIR -ErrorAction SilentlyContinue }

$wtLeaf = 'blocklist-update-' + $PID
$wt = Join-Path ([System.IO.Path]::GetTempPath()) $wtLeaf
$wtNodeModules = Join-Path $wt '.claude\hooks\node_modules'
# From the temp worktree of <Branch>, not from $PSScriptRoot: the job must not depend on which
# branch the primary checkout has.
$gitSafe = Join-Path $wt 'scripts\git-safe.ps1'
$msgFile = Join-Path ([System.IO.Path]::GetTempPath()) ('blocklist-update-msg-' + $PID + '.txt')

function Log([string]$msg) { Write-Host ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg) }
function GitPrimary { & git -C $RepoPath @args 2>&1 | ForEach-Object { "$_" } }

# One attempt in the temp worktree: update, build, and (only if the blocklist changed) commit and push.
# Returns 0 when done (pushed, or nothing to push), 1 on a failed step, $script:PushRejected when only the push failed.
$script:PushRejected = 2
function Invoke-Attempt {
  Log 'Fetching advisories from GitHub...'
  & node $UpdateScript --apply | Out-Host
  if ($LASTEXITCODE -ne 0) { Log '[ERROR] Blocklist update failed'; return 1 }

  Log 'Rebuilding hooks...'
  Push-Location (Join-Path $wt '.claude\hooks')
  try { & npm.cmd run build | Out-Host; $buildRc = $LASTEXITCODE } finally { Pop-Location }
  if ($buildRc -ne 0) { Log '[ERROR] Hook build failed'; return 1 }

  # A failed add (an index.lock, say) would leave nothing staged and read as "no changes": check it.
  # The build manifest hashes the json (write-build-inputs.mjs), so a blocklist change changes it: stage it too.
  $addOut = & git add -- .claude/hooks/src/shared/malicious-packages.json .claude/hooks/dist/package-install-guard.mjs .claude/hooks/dist/.build-inputs.json 2>&1
  if ($LASTEXITCODE -ne 0) { Log "[ERROR] git add failed: $addOut"; return 1 }
  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) { Log 'No blocklist changes detected; nothing to commit or push'; return 0 }

  Log "Committing updated blocklist to $Branch..."
  Set-Content -Path $msgFile -Value 'chore(security): daily blocklist update [automated]' -Encoding ASCII
  & $gitSafe -C $wt commit -F $msgFile | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { Log '[ERROR] Blocklist commit failed'; return 1 }
  $newSha = (git rev-parse HEAD)

  # HEAD:refs/heads/<Branch> names the target explicitly. A bare `git push fork HEAD` follows the
  # current branch, which is how this job once pushed the wrong thing. Never forced.
  & $gitSafe -C $wt push $Remote "HEAD:refs/heads/$Branch" | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { return $script:PushRejected }
  Log "Pushed $($newSha.Substring(0,7)) to $Remote/$Branch"
  return 0
}

# Fetch the remote after a rejected push and say whether it moved past $base (this attempt's start).
# Returns the new tip when it moved, 'same' when it did not, '' when the fetch or the read failed.
function Get-MovedTip([string]$base) {
  GitPrimary fetch $Remote $Branch | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { Log "[ERROR] git fetch $Remote $Branch failed after the rejected push"; return '' }
  $tip = "$(& git -C $RepoPath rev-parse "refs/remotes/$Remote/$Branch" 2>$null)".Trim()
  if (-not $tip) { Log "[ERROR] could not read $Remote/$Branch after the fetch"; return '' }
  if ($tip -eq $base) { return 'same' }
  return $tip
}

# Run the attempt in the temp worktree, at most $maxAttempts times. Returns 0 on success, 1 on a failed step.
# A rejected push is retried only when $Remote/$Branch moved meanwhile (the slow build lets it): the worktree is
# reset to the new tip and the update and build run again, so the commit is made from the tip's own source
# and dist. No rebase, no cherry-pick, no force. The ignored node_modules junction survives the reset
# (never git clean -x here).
function Update-AndPush {
  $maxAttempts = 3
  Push-Location $wt
  try {
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
      $base = "$(& git rev-parse HEAD)".Trim()
      $rc = @(Invoke-Attempt)[-1]
      if ($rc -eq 0) { return 0 }
      if ($rc -ne $script:PushRejected) { return 1 }
      $tip = @(Get-MovedTip $base)[-1]
      if (-not $tip) { return 1 }
      if ($tip -eq 'same') {
        Log "[ERROR] Push to $Remote/$Branch failed and $Remote/$Branch did not move, so this is not a race. The commit existed only in the temp worktree and is discarded; the next run retries."
        return 1
      }
      if ($attempt -eq $maxAttempts) {
        Log "[PUSH-RACE] $Remote/$Branch moved on each of $maxAttempts attempts; giving up. The next run retries."
        return 1
      }
      Log "[PUSH-RACE] $Remote/$Branch moved to $($tip.Substring(0,7)); rebuilding on the new tip (attempt $($attempt + 1) of $maxAttempts)"
      & git reset --hard --quiet $tip 2>&1 | ForEach-Object { Log "  $_" }
      if ($LASTEXITCODE -ne 0) { Log "[ERROR] could not reset the temp worktree to $tip"; return 1 }
    }
    return 1
  }
  finally { Pop-Location }
}

# Advance local <Branch> to <Remote>/<Branch>. Decided from a fresh read of the checked-out branch,
# taken immediately before acting: the fetch and build above are slow and the primary checkout can
# change meanwhile. Returns $true when local <Branch> followed.
function Update-LocalBranch {
  $now = "$(& git -C $RepoPath symbolic-ref --quiet --short HEAD 2>$null)".Trim()
  if ($now -eq $Branch) {
    Log "Primary checkout is on '$Branch': fast-forwarding it."
    GitPrimary merge --ff-only "refs/remotes/$Remote/$Branch" | ForEach-Object { Log "  $_" }
  } else {
    if (-not $now) { $now = '(detached)' }
    Log "Primary checkout is on '$now': updating the '$Branch' ref only. Its branch, index and working tree are not touched."
    GitPrimary fetch $Remote "${Branch}:${Branch}" | ForEach-Object { Log "  $_" }
  }
  if ($LASTEXITCODE -ne 0) {
    Log "[WARN] local $Branch did not fast-forward; it is behind $Remote/$Branch. Run: git pull --ff-only on $Branch"
    return $false
  }
  return $true
}

# Run sync-to-active.sh from the temp worktree, then confirm with the cursor. Exit 0 from the
# script is not proof: it exits 0 when it skips (local main moved past the worktree) or when it
# finds the sync lock held. The proof is ~/.claude/state/sync-cursor equal to local <Branch>.
function Sync-Active {
  Log 'Syncing to active directory...'
  Push-Location $wt
  try {
    # sync-to-active.sh only syncs from main. A detached HEAD exactly at local main is accepted
    # with SYNC_MAIN_DETACHED=1 (same as land-pr.ps1).
    $env:SYNC_MAIN_DETACHED = '1'
    & $GitBash scripts/sync-to-active.sh --changed | ForEach-Object { Log "  $_" }
    if ($LASTEXITCODE -ne 0) {
      Log "[WARN] sync exited $LASTEXITCODE; run scripts/sync-to-active.sh --changed from $Branch by hand"
      return $false
    }
  }
  finally { Remove-Item Env:\SYNC_MAIN_DETACHED -ErrorAction SilentlyContinue; Pop-Location }
  $cursor = if (Test-Path -LiteralPath $SyncCursor) { "$(Get-Content -LiteralPath $SyncCursor -Raw)".Trim() } else { '' }
  $head = "$(& git -C $RepoPath rev-parse "refs/heads/$Branch" 2>$null)".Trim()
  if ($cursor -and $cursor -eq $head) { return $true }
  Log "[WARN] sync exited 0 but the cursor is '$cursor' and local $Branch is '$head'. The sync skipped, or another push landed meanwhile."
  return $false
}

function Invoke-Body {
  Log "Starting blocklist update. Primary checkout: $RepoPath"

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

  $rc = @(Update-AndPush)[-1]
  if ($rc -ne 0) { return 1 }

  # Always runs, also when nothing changed: it catches up a run that pushed but did not follow.
  $followed = @(Update-LocalBranch)[-1]
  $synced = $followed
  if ($followed) {
    if ($NoSync) { Log 'Sync skipped (-NoSync)' }
    else { $synced = @(Sync-Active)[-1] }
  } else {
    Log "Sync skipped: local $Branch is not at $Remote/$Branch"
  }
  # Exit 2 keeps the gap visible in Task Scheduler's Last Result: the remote is current, but local
  # main or ~/.claude did not follow.
  if (-not $synced) { Log '[PUSHED-NOT-SYNCED] the remote is current; local main or ~/.claude is behind'; return 2 }
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
