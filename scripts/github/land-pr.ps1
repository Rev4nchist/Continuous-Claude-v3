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
  1b. Pre-merge re-check (Gate C, scripts/github/land-recheck.mjs): right before the merge, re-read the
     PR and refuse (nothing merged) when the head changed, a CodeRabbit review or summary-comment edit
     is newer than the READY check, an "@coderabbitai review" request has no review after it, or the
     CodeRabbit commit status on the head is pending. A read error refuses. -IgnoreReview skips it too.
  1c. None-pick check (scripts/github/land-none-check.mjs): a review:none PR at band HIGH or CRITICAL lands only when
     Dave's own pick (his dialog or composer, not the bridge or auto-confirm) is on record for this exact head. A missing,
     stale or foreign record refuses (nothing merged). The provenance line goes into the LANDED summary. With
     -IgnoreReview the check still runs as a warning only: it prints the line or a WARNING, and the merge goes on.
  2. Merge through the REST API with sha=<head>: GitHub refuses the merge if the head moved after
     the check, so nothing unreviewed can land between check and merge (review note P35).
  3. fetch fork --prune; fast-forward local main (never a reset; refuses if main diverged).
  4. Sync ~/.claude from main (scripts/sync-to-active.sh --changed, via Git Bash). It always syncs
     from a temporary detached worktree of main and removes it afterwards. The primary checkout is
     never used or switched: another session can switch it mid-sync.
  5. Clean up: copy the worktree's gitignored .claude/cache/e2e/ to <repo>\.claudedocs\e2e-pr<N>
     (a differing file already there is never overwritten), then remove the PR's worktree (clean
     worktrees only; kept when the copy fails or conflicts; every junction and symlink in it is
     unlinked first, and a link that cannot be unlinked keeps the worktree),
     delete the local branch with -d (merged-only), delete the remote branch on fork. When the primary
  checkout is on the PR branch, it keeps the primary AND the remote branch, and prints what to do.
  Every step is idempotent: re-running after a partial failure picks up where it stopped.
  -CleanupOnly skips steps 1-2 for a PR that is already merged.
  -TestFailUnlink and -TestSwitchPrimary are TEST-ONLY switches (land-pr-worktree-links.test.ps1).
  Never use them in a real land. They replace the old LAND_PR_TEST_* env vars, which are no longer read.

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
  [switch]$NoSync,
  [switch]$TestFailUnlink,      # TEST-ONLY: every worktree unlink fails, so a test reaches the "link not removed" branch
  [switch]$TestSwitchPrimary    # TEST-ONLY: switch the primary checkout to the PR branch after the worktree step
)
$ErrorActionPreference = 'Stop'
# gh-personal routes the Rev4nchist account on machines with two GitHub logins
# (docs/github/auth-routing.md). Where it does not exist, gh's own default login is the account.
$ghPersonal = Join-Path $HOME '.config\gh-personal'
if (-not $env:GH_CONFIG_DIR -and (Test-Path $ghPersonal)) { $env:GH_CONFIG_DIR = $ghPersonal }
$gitSafe = Join-Path $RepoPath 'scripts\git-safe.ps1'
$done = [System.Collections.Generic.List[string]]::new()
function Step($msg) { Write-Host "-> $msg" }
# The one line land-none-check.mjs prints (the provenance line, or a WARNING under -IgnoreReview) goes into the LANDED summary.
function Add-NoneLine($out) {
  $line = @($out | ForEach-Object { "$_" } | Where-Object { $_ -match '^(Dave chose none at|WARNING:)' }) | Select-Object -First 1
  if ($line) { $done.Add($line) }
}
function Fail($msg) { Write-Host "STOPPED: $msg" -ForegroundColor Red; if ($done.Count) { Write-Host "Done before stopping: $($done -join '; ')" }; exit 1 }

# `git worktree remove` follows a junction or symlink inside the worktree and deletes the TARGET's
# contents. On 2026-11-01 a gitignored node_modules junction (the worktree looked clean) to the
# primary checkout's node_modules emptied it. Unlink every link first. Self-contained: it uses no
# script-level variable and never throws. The walk never descends into a link, so a link inside a
# link target is not touched. Only the link goes: DirectoryInfo.Delete() on a junction or directory
# symlink calls RemoveDirectory, which leaves the target alone; a file symlink is deleted as a file.
#   -SkipPaths  full paths of links to leave alone: TRACKED symlinks. Git removes a tracked symlink as
#               a file and never follows it; unlinking it here would leave git a tracked deletion,
#               and `git worktree remove` would then refuse.
#   -Delete     the unlink, called with the FileSystemInfo. Default: its Delete(). A test passes one
#               that throws, because an unremovable link cannot be made reliably (Windows ignores
#               FILE_ATTRIBUTE_READONLY on directories).
function Remove-WorktreeLinks([string]$Path, [string[]]$SkipPaths = @(), [scriptblock]$Delete = { param($info) $info.Delete() }) {
  $removed = [System.Collections.Generic.List[string]]::new(); $remaining = [System.Collections.Generic.List[string]]::new(); $errors = [System.Collections.Generic.List[string]]::new()
  try {
    $stack = [System.Collections.Generic.Stack[string]]::new()
    $stack.Push([System.IO.Path]::GetFullPath($Path))
    $links = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
    $skip = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sp in $SkipPaths) { if ($sp) { [void]$skip.Add([System.IO.Path]::GetFullPath($sp)) } }
    while ($stack.Count) {
      $dir = $stack.Pop()
      try {
        foreach ($e in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
          if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { if (-not $skip.Contains($e.FullName)) { $links.Add($e) } }
          elseif ($e -is [System.IO.DirectoryInfo]) { $stack.Push($e.FullName) }
        }
      } catch { $errors.Add("${dir}: $($_.Exception.Message)") }
    }
    foreach ($l in $links) {
      try {
        & $Delete $l
        $l.Refresh()
        if ($l.Exists) { $remaining.Add($l.FullName) } else { $removed.Add($l.FullName) }
      } catch { $remaining.Add($l.FullName); $errors.Add("$($l.FullName): $($_.Exception.Message)") }
    }
  } catch { $errors.Add($_.Exception.Message) }
  [pscustomobject]@{
    Removed   = [string[]]$removed.ToArray()
    Remaining = [string[]]$remaining.ToArray()
    Error     = if ($errors.Count) { $errors -join '; ' } else { $null }
  }
}

# Full paths of the tracked symlinks (mode 120000) in a worktree. Git removes these itself.
# Self-contained, never throws; Error is set when git cannot answer, and the caller keeps the worktree.
function Get-TrackedSymlinkPaths([string]$Worktree) {
  $paths = [System.Collections.Generic.List[string]]::new(); $err = $null
  try {
    $raw = (git -C $Worktree ls-files -s -z 2>$null) -join ''
    if ($LASTEXITCODE) { $err = "git ls-files exited $LASTEXITCODE" }
    else {
      foreach ($rec in ($raw -split "`0")) {
        if ($rec -match '^120000 [0-9a-f]+ \d\t(.+)$') { $paths.Add([System.IO.Path]::GetFullPath((Join-Path $Worktree $Matches[1]))) }
      }
    }
  } catch { $err = $_.Exception.Message }
  [pscustomobject]@{ Paths = [string[]]$paths.ToArray(); Error = $err }
}

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
    $skewMargin = 120  # seconds. The READY time is the local clock; GitHub stamps reviews. A fast local clock would hide a review that landed just before it.
    Write-Host "  clock margin: the re-check treats anything CodeRabbit did in the $skewMargin s before the READY check as new"
    # GitHub reports mergeable_state "unknown" for a while after the base branch moves (every PR
    # after the first in a landing run). Re-ask for up to ~90s before treating it as not ready.
    for ($try = 1; $try -le 7; $try++) {
      # The last attempt's start, backed off by the margin and taken before review-status reads: Gate C refuses anything CodeRabbit did after it.
      $readyAt = [DateTime]::UtcNow.AddSeconds(-$skewMargin).ToString('o')
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
    # Gate C: re-read the PR right before the merge. Fails closed: a changed head, a CodeRabbit review or summary edit
    # since the READY check, a review request still in flight, or a pending CodeRabbit status refuses the merge.
    Step "pre-merge re-check for #$Pr"
    node (Join-Path $PSScriptRoot 'land-recheck.mjs') $Pr --repo $Repo --head $head --ready-at $readyAt | Out-Host
    if ($LASTEXITCODE) { Fail "pre-merge re-check refused #$Pr (exit $LASTEXITCODE). Nothing was merged. Read what changed, then re-run." }
    # None-pick check: a review:none PR at HIGH or CRITICAL needs Dave's own pick on record for this head. Fails closed.
    Step "none-pick check for #$Pr"
    $noneOut = node (Join-Path $PSScriptRoot 'land-none-check.mjs') $Pr --repo $Repo --head $head 2>&1
    $noneCode = $LASTEXITCODE
    $noneOut | Out-Host
    if ($noneCode) { Fail "none-pick check refused #$Pr (exit $noneCode). Nothing was merged. Dave picks again in /pathway for this head, then re-run." }
    Add-NoneLine $noneOut
  } else {
    Write-Host "  -IgnoreReview: skipping the READY check and the pre-merge re-check"
    # Dave's own yes. The none-pick check still runs, as a warning only, so the yes is informed. It never blocks.
    Step "none-pick check for #$Pr (warning only)"
    $noneOut = node (Join-Path $PSScriptRoot 'land-none-check.mjs') $Pr --repo $Repo --head $head --warn 2>&1
    $noneOut | Out-Host
    Add-NoneLine $noneOut
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
        # The sync script makes no link here, but --force deletes through one, so unlink first.
        # A link that stays keeps the temp worktree: no removal and no --force hint.
        $syncLinks = if (Test-Path -LiteralPath $syncWt) { Remove-WorktreeLinks -Path $syncWt } else { $null }
        if ($syncLinks -and ($syncLinks.Remaining.Count -or $syncLinks.Error)) {
          $syncNamed = if ($syncLinks.Remaining.Count) { $syncLinks.Remaining -join ', ' } else { $syncLinks.Error }
          Write-Host "  kept temp worktree $syncWt`: link not removed ($syncNamed)"
        } else {
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
$wtPath = $null; $primaryOnBranch = $false
for ($i = 0; $i -lt $wtLines.Count; $i++) {
  if ($wtLines[$i] -eq "branch refs/heads/$branch") { $wtPath = ($wtLines[$i - 2] -replace '^worktree ', '') }
}
# The first porcelain entry is the primary checkout. Never walk or remove it: its tree holds the
# junctions of other sessions' worktrees (.claude\worktrees\*), and git cannot remove a main worktree.
$mainWt = @($wtLines | Where-Object { $_ -like 'worktree *' } | Select-Object -First 1)
$normWt = { param($p) [IO.Path]::GetFullPath(($p -replace '^worktree ', '')).TrimEnd('\', '/') }
if ($wtPath -and $mainWt.Count -and ((& $normWt $wtPath) -ieq (& $normWt $mainWt[0]))) {
  Write-Host "  kept primary checkout $wtPath (it is on $branch; no link cleanup, no removal)"
  $wtPath = $null
  $primaryOnBranch = $true
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
      # Unlink every junction and symlink first; git would delete through them (see Remove-WorktreeLinks).
      # Tracked symlinks are left to git (it removes them as files). -TestFailUnlink is
      # TEST-ONLY: when set, every unlink fails, so a test can reach the "link not removed" branch.
      $tracked = Get-TrackedSymlinkPaths -Worktree $wtPath
      $failUnlink = { param($info) throw 'unlink failure injected by -TestFailUnlink' }
      $links = if ($tracked.Error) { [pscustomobject]@{ Removed = @(); Remaining = @(); Error = "cannot list tracked symlinks: $($tracked.Error)" } }
        elseif ($TestFailUnlink) { Remove-WorktreeLinks -Path $wtPath -SkipPaths $tracked.Paths -Delete $failUnlink }
        else { Remove-WorktreeLinks -Path $wtPath -SkipPaths $tracked.Paths }
      if ($links.Remaining.Count -or $links.Error) {
        $named = if ($links.Remaining.Count) { $links.Remaining -join ', ' } else { $links.Error }
        Write-Host "  kept worktree $wtPath`: link not removed ($named)"
      } else {
        if ($links.Removed.Count) { $done.Add("unlinked $($links.Removed.Count) link(s) in the worktree") }
        git -C $RepoPath worktree remove $wtPath 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) { $done.Add("removed worktree $wtPath") } else { Write-Host "  could not remove worktree $wtPath" }
      }
    }
  }
}
if ($TestSwitchPrimary) { git -C $RepoPath checkout -q $branch 2>&1 | Out-Null }   # TEST-ONLY: another session switches the primary here
if (git -C $RepoPath branch --list $branch) {
  git -C $RepoPath branch -d $branch 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) { $done.Add("deleted local $branch") } else { Write-Host "  kept local $branch (git branch -d refused)" }
}
$remoteRef = git -C $RepoPath ls-remote --heads $Remote $branch
# Re-read the primary's branch: another session may have switched it to $branch since the first check.
if ((git -C $RepoPath branch --show-current) -eq $branch) { $primaryOnBranch = $true }
if ($remoteRef -and $primaryOnBranch) {
  # git branch -d refuses a checked-out branch. Deleting the remote one would leave the primary on a branch the remote no longer has.
  Write-Host "  kept $Remote/$branch (the primary checkout is on it): switch the primary to main and delete the branch: git switch main; git branch -d $branch; git push $Remote --delete $branch"
} elseif ($remoteRef) {
  pwsh -File $gitSafe -C $RepoPath push $Remote --delete $branch 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) { $done.Add("deleted $Remote/$branch") } else { Write-Host "  could not delete $Remote/$branch" }
}

Write-Host "LANDED #${Pr}: $($done -join '; ')" -ForegroundColor Green
