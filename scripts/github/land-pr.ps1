<#
.SYNOPSIS
  Land a PR Dave has approved: merge it, advance main, sync ~/.claude, clean up. One command.

.DESCRIPTION
  Dave walked the same 4-6 steps by hand for every PR ("merge #40", "advance main and clean up",
  "merge 43 and 44") - Opus 5.5 eval, P35. RUN THIS ONLY AFTER DAVE SAYS MERGE: the merge itself
  is his decision; this script only does the mechanics the same way every time.

  1. Ready check: scripts/github/review-status.mjs must report READY for the PR's CURRENT head
     (Greptile reviewed that exact commit, confidence >= 4, 0 unresolved threads, checks green,
     mergeable clean).
     -IgnoreReview skips this; say why in the PR when you use it.
  2. Merge through the REST API with sha=<head>: GitHub refuses the merge if the head moved after
     the check, so nothing unreviewed can land between check and merge (review note P35).
  3. fetch fork --prune; fast-forward local main (never a reset; refuses if main diverged).
  4. Sync ~/.claude from main (scripts/sync-to-active.sh --changed, via Git Bash). It always syncs
     from a temporary detached worktree of main and removes it afterwards. The primary checkout is
     never used or switched: another session can switch it mid-sync.
  5. Clean up: copy the worktree's gitignored .claude/cache/e2e/ to <repo>\.claudedocs\e2e-pr<N>
     (a differing file already there is never overwritten), then remove the PR's worktree (clean
     worktrees only; kept when the copy fails or conflicts; a node_modules junction is unlinked
     first), delete the local branch with -d (merged-only), delete the remote branch on fork.
  Every step is idempotent: re-running after a partial failure picks up where it stopped.
  -CleanupOnly skips steps 1-2 for a PR that is already merged.

.EXAMPLE
  pwsh -File scripts/github/land-pr.ps1 -Pr 45
  pwsh -File scripts/github/land-pr.ps1 -Pr 45 -Method squash
#>
#Requires -Version 7
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory)][int]$Pr,
  [string]$Repo = 'Rev4nchist/Continuous-Claude-v3',
  [string]$RepoPath = (Join-Path $env:USERPROFILE 'continuous-claude'),
  [ValidateSet('merge', 'squash', 'rebase')][string]$Method = 'merge',
  [string]$Remote = 'fork',
  [switch]$IgnoreReview,
  [switch]$CleanupOnly,
  [switch]$NoSync
)
$ErrorActionPreference = 'Stop'
# gh-personal routes the Rev4nchist account on machines with two GitHub logins
# (docs/github/auth-routing.md). Where it does not exist, gh's own default login is the account.
$ghPersonal = Join-Path $HOME '.config\gh-personal'
if (-not $env:GH_CONFIG_DIR -and (Test-Path $ghPersonal)) { $env:GH_CONFIG_DIR = $ghPersonal }
$gitSafe = Join-Path $RepoPath 'scripts\git-safe.ps1'
$done = [System.Collections.Generic.List[string]]::new()
function Step($msg) { Write-Host "-> $msg" }
function Fail($msg) { Write-Host "STOPPED: $msg" -ForegroundColor Red; if ($done.Count) { Write-Host "Done before stopping: $($done -join '; ')" }; exit 1 }

# Git Bash, never `bash` on PATH (WSL on these machines). Per-user and machine-wide installs differ.
$bashCandidates = @($env:CLAUDE_CODE_GIT_BASH_PATH)
foreach ($pair in @(@($env:LOCALAPPDATA, 'Programs\Git\bin\bash.exe'), @($env:ProgramFiles, 'Git\bin\bash.exe'), @(${env:ProgramFiles(x86)}, 'Git\bin\bash.exe'))) {
  if ($pair[0]) { $bashCandidates += Join-Path $pair[0] $pair[1] }
}
$gitBash = $bashCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $gitBash -and -not $NoSync) { Fail 'Git Bash not found (set CLAUDE_CODE_GIT_BASH_PATH). Nothing was merged.' }

$pull = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
if ($LASTEXITCODE) { Fail "cannot read PR #$Pr" }
$branch = $pull.head.ref; $head = $pull.head.sha

# 1-2. Ready check and head-pinned merge
if (-not $pull.merged -and -not $CleanupOnly) {
  if (-not $IgnoreReview) {
    Step "ready check for #$Pr at $($head.Substring(0,7))"
    # GitHub reports mergeable_state "unknown" for a while after the base branch moves (every PR
    # after the first in a landing run). Re-ask for up to ~90s before treating it as not ready.
    for ($try = 1; $try -le 7; $try++) {
      $statusJson = node (Join-Path $PSScriptRoot 'review-status.mjs') $Pr --repo $Repo --json
      $ready = $LASTEXITCODE
      $st = $null; try { $st = $statusJson | ConvertFrom-Json } catch { }
      if (-not $st -or $st.mergeable_state -ne 'unknown') { break }
      Write-Host "  mergeable_state is unknown; GitHub is still computing it (try $try of 7)"
      Start-Sleep -Seconds 15
    }
    if ($ready -eq 1 -and $st) { Write-Host "  not ready: $($st.reasons -join '; ')"; Fail "PR #$Pr is not ready. Re-run after the review lands, or pass -IgnoreReview deliberately." }
    # Exit 0 alone is not proof: require the JSON to say ready for THIS head commit.
    if ($ready -ne 0 -or -not $st -or $st.ready -ne $true -or $st.head -ne $head) { Fail "could not confirm PR #$Pr is ready (review-status exit $ready). Nothing was merged." }
  }
  Step "merging #$Pr ($Method) pinned to head $($head.Substring(0,7))"
  $res = gh api "repos/$Repo/pulls/$Pr/merge" -X PUT -f "merge_method=$Method" -f "sha=$head" 2>&1
  if ($LASTEXITCODE) {
    # A timed-out or failed call may still have merged server-side: verify before failing.
    $again = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
    if (-not $again.merged) { Fail "merge refused: $res" }
  }
  $done.Add("merged #$Pr")
} elseif ($pull.merged) {
  Step "#$Pr is already merged; continuing with the local steps"
}
$pull = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
if (-not $pull.merged) { Fail "#$Pr is not merged; nothing to clean up" }

# 3. Fetch and fast-forward main
Step "fetch $Remote --prune"
git -C $RepoPath fetch $Remote --prune 2>&1 | Out-Null
if ($LASTEXITCODE) { Fail "git fetch failed" }
$current = git -C $RepoPath rev-parse --abbrev-ref HEAD
if ($current -eq 'main') {
  git -C $RepoPath merge --ff-only "$Remote/main" 2>&1 | Out-Host
  if ($LASTEXITCODE) { Fail "local main could not fast-forward to $Remote/main (diverged, or local edits conflict). Resolve by hand." }
} else {
  # main is not checked out here: fetch into it, which only ever fast-forwards.
  git -C $RepoPath fetch $Remote main:main 2>&1 | Out-Null
  if ($LASTEXITCODE) { Fail "local main could not fast-forward to $Remote/main" }
}
$done.Add("main at $((git -C $RepoPath rev-parse --short main))")

# 4. Sync ~/.claude from a temp worktree of main
# Exit 0 from sync-to-active.sh is not proof: a run that finds the sync lock held only writes
# ~/.claude/.sync.pending and exits 0, and a run that skips also exits 0. The proof is the cursor:
# ~/.claude/state/sync-cursor must equal main's commit.
function Confirm-Synced([string]$how) {
  $cursorFile = Join-Path $HOME '.claude\state\sync-cursor'
  $cursor = if (Test-Path $cursorFile) { "$(Get-Content $cursorFile -Raw)".Trim() } else { '' }
  $mainSha = "$(git -C $RepoPath rev-parse main)".Trim()
  if ($cursor -and $cursor -eq $mainSha) { $done.Add($how); return }
  Write-Host "  NOT confirmed synced: sync cursor is '$cursor', main is '$mainSha'."
  Write-Host "  (A held sync lock only queues the sync; a skip also exits 0.) From a checkout of main, run in Git Bash: scripts/sync-to-active.sh --changed"
}
if (-not $NoSync) {
    # Always sync from a throwaway detached worktree of main, never from the primary checkout.
    # Other sessions share the primary checkout: on 2026-10-24 one switched it to a feature branch
    # mid-sync, and 8 of 10 synced hooks came from that branch while the cursor said main.
    # A worktree only this run uses cannot change under the copy. SYNC_MAIN_DETACHED=1 lets the
    # script accept a detached HEAD that sits exactly at main's commit; it then moves the sync
    # cursor like a run on main.
    # The path is unique per run: a fixed name could be left behind by a killed run and collide.
    $syncLeaf = "land-pr-sync-$Pr-$PID"
    $syncWt = Join-Path ([System.IO.Path]::GetTempPath()) $syncLeaf
    Step "sync ~/.claude through a temp worktree of main ($RepoPath stays on '$current')"
    $wtOk = $false
    try {
      git -C $RepoPath worktree prune 2>&1 | Out-Null
      git -C $RepoPath worktree add --detach $syncWt main 2>&1 | Out-Host
      if ($LASTEXITCODE) { Write-Host "  could not create the temp worktree; sync from main by hand" }
      else {
        $wtOk = $true
        Push-Location $syncWt
        try {
          $env:SYNC_MAIN_DETACHED = '1'
          $syncOut = & $gitBash scripts/sync-to-active.sh --changed
          $rc = $LASTEXITCODE
          $syncOut | Out-Host
          if ($rc -ne 0) { Write-Host "  sync exited $rc; run it by hand" }
          else {
            # main's own copy of the script decides. Show a skip line as printed, then let the cursor judge.
            $skip = $syncOut | Where-Object { "$_" -match 'Sync skipped' } | Select-Object -First 1
            if ($skip) { Write-Host "  main's sync script reported: $skip" }
            Confirm-Synced 'synced via temp worktree'
          }
        }
        finally { Remove-Item Env:\SYNC_MAIN_DETACHED -ErrorAction SilentlyContinue; Pop-Location }
      }
    }
    finally {
      if ($wtOk -or (Test-Path $syncWt)) {
        git -C $RepoPath worktree remove --force $syncWt 2>&1 | Out-Null
        if (Test-Path $syncWt) {
          # git can drop the registration and leave the directory. Delete it only when git no longer
          # lists it AND it is provably our own temp directory.
          $listed = @(git -C $RepoPath worktree list --porcelain | Where-Object { $_ -like 'worktree *' } |
            ForEach-Object { Split-Path $_.Substring(9) -Leaf }) -contains $syncLeaf
          $full = [System.IO.Path]::GetFullPath($syncWt)
          $tmpRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
          $ownsIt = $full.StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $full -Leaf).StartsWith('land-pr-sync-')
          if (-not $listed -and $ownsIt) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if (Test-Path $syncWt) { Write-Host "  could not remove temp worktree $syncWt; run: git -C $RepoPath worktree remove --force $syncWt" }
      }
    }
}

# 5. Cleanup: worktree, local branch, remote branch
# A worktree's .claude/cache/ is gitignored, so `git status --porcelain` does not see the PR's e2e
# evidence there and removing the worktree would delete it. Copy it out first. Self-contained: it
# uses no script-level variable and never throws; a failure is reported in the result.
function Save-E2eArtifacts([string]$Source, [string]$Destination) {
  $copied = 0; $skipped = 0; $conflicts = [System.Collections.Generic.List[string]]::new(); $errors = [System.Collections.Generic.List[string]]::new()
  try {
    if (Test-Path -LiteralPath $Source -PathType Container) {
      $root = (Get-Item -LiteralPath $Source).FullName.TrimEnd('\', '/')
      foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
        $rel = $file.FullName.Substring($root.Length).TrimStart('\', '/')
        try {
          $target = Join-Path $Destination $rel
          if (Test-Path -LiteralPath $target -PathType Leaf) {
            $same = ((Get-Item -LiteralPath $target).Length -eq $file.Length) -and
              ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash)
            if ($same) { $skipped++ } else { $conflicts.Add($rel) }
          } else {
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            [System.IO.File]::Copy($file.FullName, $target, $false)
            $copied++
          }
        } catch { $errors.Add("${rel}: $($_.Exception.Message)") }
      }
    }
  } catch { $errors.Add($_.Exception.Message) }
  [pscustomobject]@{
    Copied    = $copied
    Skipped   = $skipped
    Conflicts = [string[]]$conflicts.ToArray()
    Error     = if ($errors.Count) { $errors -join '; ' } else { $null }
  }
}

$wtLines = git -C $RepoPath worktree list --porcelain
$wtPath = $null
for ($i = 0; $i -lt $wtLines.Count; $i++) {
  if ($wtLines[$i] -eq "branch refs/heads/$branch") { $wtPath = ($wtLines[$i - 2] -replace '^worktree ', '') }
}
if ($wtPath) {
  $dirty = git -C $wtPath status --porcelain 2>$null
  if ($LASTEXITCODE -or $dirty) {
    Write-Host "  kept worktree $wtPath (it has uncommitted changes or cannot be read)"
  } else {
    # Save the e2e evidence before the worktree goes. The PR is already merged, so this never calls
    # Fail: any problem keeps the worktree and says why.
    $saveProblem = $null
    try {
      $e2eDest = Join-Path $RepoPath ".claudedocs\e2e-pr$Pr"
      $saved = Save-E2eArtifacts -Source (Join-Path $wtPath '.claude\cache\e2e') -Destination $e2eDest
      if ($saved.Error) { $saveProblem = $saved.Error }
      elseif ($saved.Conflicts.Count) { $saveProblem = "different files already saved in .claudedocs\e2e-pr${Pr}: $($saved.Conflicts -join ', ')" }
      elseif ($saved.Copied -gt 0) { $done.Add("saved $($saved.Copied) e2e files to .claudedocs\e2e-pr$Pr") }
    } catch { $saveProblem = $_.Exception.Message }
    if ($saveProblem) {
      Write-Host "  kept worktree $wtPath`: e2e artifacts not saved ($saveProblem)"
    } else {
      $junction = Join-Path $wtPath '.claude\hooks\node_modules'
      if ((Test-Path $junction) -and (Get-Item $junction -Force).LinkType -eq 'Junction') { [System.IO.Directory]::Delete($junction, $false) }
      git -C $RepoPath worktree remove $wtPath 2>&1 | Out-Host
      if ($LASTEXITCODE -eq 0) { $done.Add("removed worktree $wtPath") } else { Write-Host "  could not remove worktree $wtPath" }
    }
  }
}
if (git -C $RepoPath branch --list $branch) {
  git -C $RepoPath branch -d $branch 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) { $done.Add("deleted local $branch") } else { Write-Host "  kept local $branch (git branch -d refused)" }
}
$remoteRef = git -C $RepoPath ls-remote --heads $Remote $branch
if ($remoteRef) {
  pwsh -File $gitSafe -C $RepoPath push $Remote --delete $branch 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) { $done.Add("deleted $Remote/$branch") } else { Write-Host "  could not delete $Remote/$branch" }
}

Write-Host "LANDED #${Pr}: $($done -join '; ')" -ForegroundColor Green
