<#
.SYNOPSIS
  Land a PR Dave has approved: merge it, advance main, sync ~/.claude, clean up. One command.

.DESCRIPTION
  Dave walked the same 4-6 steps by hand for every PR ("merge #40", "advance main and clean up",
  "merge 43 and 44") - Opus 5.5 eval, P35. RUN THIS ONLY AFTER DAVE SAYS MERGE: the merge itself
  is his decision; this script only does the mechanics the same way every time.

  1. Ready check: scripts/github/coderabbit-status.mjs must report READY for the PR's CURRENT head
     (CodeRabbit reviewed that exact commit, 0 unresolved threads, checks green, mergeable clean).
     -IgnoreReview skips this; say why in the PR when you use it.
  2. Merge through the REST API with sha=<head>: GitHub refuses the merge if the head moved after
     the check, so nothing unreviewed can land between check and merge (Codex, P35).
  3. fetch fork --prune; fast-forward local main (never a reset; refuses if main diverged).
  4. Sync ~/.claude from main (scripts/sync-to-active.sh --changed, via Git Bash).
  5. Clean up: remove the PR's worktree (clean worktrees only; a node_modules junction is unlinked
     first), delete the local branch with -d (merged-only), delete the remote branch on fork.
  Every step is idempotent: re-running after a partial failure picks up where it stopped.
  -CleanupOnly skips steps 1-2 for a PR that is already merged.

.EXAMPLE
  pwsh -File scripts/github/land-pr.ps1 -Pr 45
  pwsh -File scripts/github/land-pr.ps1 -Pr 45 -Method squash
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory)][int]$Pr,
  [string]$Repo = 'Rev4nchist/Continuous-Claude-v3',
  [string]$RepoPath = 'C:\Users\david.hayes\continuous-claude',
  [ValidateSet('merge', 'squash', 'rebase')][string]$Method = 'merge',
  [string]$Remote = 'fork',
  [switch]$IgnoreReview,
  [switch]$CleanupOnly,
  [switch]$NoSync
)
$ErrorActionPreference = 'Stop'
if (-not $env:GH_CONFIG_DIR) { $env:GH_CONFIG_DIR = Join-Path $HOME '.config\gh-personal' }
$gitSafe = Join-Path $RepoPath 'scripts\git-safe.ps1'
$gitBash = 'C:\Users\david.hayes\AppData\Local\Programs\Git\bin\bash.exe'
$done = [System.Collections.Generic.List[string]]::new()
function Step($msg) { Write-Host "-> $msg" }
function Fail($msg) { Write-Host "STOPPED: $msg" -ForegroundColor Red; if ($done.Count) { Write-Host "Done before stopping: $($done -join '; ')" }; exit 1 }

$pull = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
if ($LASTEXITCODE) { Fail "cannot read PR #$Pr" }
$branch = $pull.head.ref; $head = $pull.head.sha

# 1-2. Ready check and head-pinned merge
if (-not $pull.merged -and -not $CleanupOnly) {
  if (-not $IgnoreReview) {
    Step "ready check for #$Pr at $($head.Substring(0,7))"
    node (Join-Path $PSScriptRoot 'coderabbit-status.mjs') $Pr --repo $Repo
    $ready = $LASTEXITCODE
    if ($ready -eq 1) { Fail "PR #$Pr is not ready (reasons above). Re-run after the review lands, or pass -IgnoreReview deliberately." }
    if ($ready -ne 0) { Fail "could not check PR #$Pr (coderabbit-status exit $ready). Nothing was merged." }
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

# 4. Sync ~/.claude (only from main in the primary checkout; the script refuses otherwise)
if (-not $NoSync) {
  if ($current -eq 'main') {
    Step "sync ~/.claude"
    Push-Location $RepoPath
    try { & $gitBash scripts/sync-to-active.sh --changed | Out-Host; if ($LASTEXITCODE -eq 0) { $done.Add('synced') } else { Write-Host "  sync exited $LASTEXITCODE; run it by hand" } }
    finally { Pop-Location }
  } else {
    Write-Host "  skipped sync: $RepoPath is on '$current', not main. Sync after checking out main."
  }
}

# 5. Cleanup: worktree, local branch, remote branch
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
    $junction = Join-Path $wtPath '.claude\hooks\node_modules'
    if ((Test-Path $junction) -and (Get-Item $junction -Force).LinkType -eq 'Junction') { [System.IO.Directory]::Delete($junction, $false) }
    git -C $RepoPath worktree remove $wtPath 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) { $done.Add("removed worktree $wtPath") } else { Write-Host "  could not remove worktree $wtPath" }
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
