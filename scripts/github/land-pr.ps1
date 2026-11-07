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
  1c2. Land tap (scripts/github/land-decision.mjs): when decisions.enforce is true in <RepoPath>/review-router.config.json or in the config of the checkout this script runs from (the stricter wins), Dave's
     "Land now" or "Land when READY" answer (AskUserQuestion, ship-ask.mjs land) must be on record for this PR at this exact head.
     Nothing else lands it. It runs before the READY check, in both branches, under -IgnoreReview too. The tap is used up AFTER the merge
     succeeds. With the flag false or missing, it prints a WARNING line and does not block.
  1d. Migration gate (scripts/github/migration-gate.mjs): when the PR adds a drizzle migration, the live database
     (agentic_os.__migrations) must already have it applied. A database that is behind, or cannot be read, refuses
     (nothing merged). A PR without a new migration never needs the database. Runs under -IgnoreReview too: there is no bypass.
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

  One lander at a time: the ready check, the pre-merge re-check, the none-pick check and the migration gate run
  OUTSIDE the lock (the ready check is slow). The script takes a lock file ($env:CCV3_LAND_LOCK, else
  ~/.claude/state/land.lock) just before the merge call and holds it through the fetch, the fast-forward of main,
  the sync and the sync-cursor check. A `finally` releases it right after the cursor check, on every exit path (also
  STOPPED, an error and Ctrl-C). Cleanup (step 5) runs after the release and only ever warns.
  A second run prints "STOPPED: another land is in progress" and exits 1 before it merges anything. A lock written on
  this host is stale when its pid is gone (dead-pid) or the pid's process started after the lock's `started` (pid-reused);
  a live holder keeps its lock at any age, and an unreadable start time counts as held. A lock from another host is stale
  after 30 minutes ($env:CCV3_LAND_LOCK_STALE_MIN overrides, in minutes). An unreadable or empty lock is stale after 2
  minutes by file time. A takeover prints one line and appends it to ~/.claude/logs/land-lock.log
  ($env:CCV3_LAND_LOCK_LOG overrides). The script deletes only a lock it created.
  Both fetches in the held section retry up to 3 times, 2 seconds apart.
  After the sync (not with -NoSync) it compares ~/.claude/state/sync-cursor ($env:CCV3_SYNC_CURSOR overrides)
  with main. The lock is released first. It prints "SYNC CONFIRMED" or "NOT confirmed synced" after the LANDED
  line, and exits 1 when not confirmed: the merge has already happened by then.
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
# CCV3_DECISIONS_FILE moves the decision store (a test seam of lib/decisions.mjs). A caller must not point the land check at a fake store: drop it before any node call.
Remove-Item -LiteralPath Env:\CCV3_DECISIONS_FILE -ErrorAction SilentlyContinue
# decisions.mjs falls back to os.homedir() for the store, and node reads USERPROFILE and HOME for that. A caller must not move the store with them.
# Invoke-LandDecision sets both from the OS profile folder (not from the environment) around its node call only, then restores the caller's values.
# Git reads the same variables to find its config, so they must stay the caller's for every other call in this script.
$osProfile = [Environment]::GetFolderPath('UserProfile')
function Invoke-LandDecision([string[]]$DecisionArgs) {
  $savedProfile = $env:USERPROFILE; $savedHome = $env:HOME
  try {
    $env:USERPROFILE = $osProfile
    $env:HOME = $osProfile
    $out = node (Join-Path $PSScriptRoot 'land-decision.mjs') @DecisionArgs
    $code = $LASTEXITCODE
  } finally {
    if ($null -eq $savedProfile) { Remove-Item -LiteralPath Env:\USERPROFILE -ErrorAction SilentlyContinue } else { $env:USERPROFILE = $savedProfile }
    if ($null -eq $savedHome) { Remove-Item -LiteralPath Env:\HOME -ErrorAction SilentlyContinue } else { $env:HOME = $savedHome }
  }
  [pscustomobject]@{ Out = $out; Code = $code }
}
# gh-personal routes the Rev4nchist account on machines with two GitHub logins
# (docs/github/auth-routing.md). Where it does not exist, gh's own default login is the account.
$ghPersonal = Join-Path $HOME '.config\gh-personal'
if (-not $env:GH_CONFIG_DIR -and (Test-Path $ghPersonal)) { $env:GH_CONFIG_DIR = $ghPersonal }
$gitSafe = Join-Path $RepoPath 'scripts\git-safe.ps1'
$done = [System.Collections.Generic.List[string]]::new()
function Step($msg) { Write-Host "-> $msg" }
# The one line land-none-check.mjs prints (the provenance line, or a WARNING under -IgnoreReview) goes into the LANDED summary.
# Add-NoneLine returns $true when it found that line. Show-NoneOutput prints the output; a WARNING line is red.
function Add-NoneLine($out) {
  $line = @($out | ForEach-Object { "$_" } | Where-Object { $_ -match '^(Dave chose none at|WARNING:)' }) | Select-Object -First 1
  if ($line) { $done.Add($line) }
  return [bool]$line
}
function Show-NoneOutput($out) {
  foreach ($l in @($out | Where-Object { $null -ne $_ })) {
    if ("$l" -match '^WARNING:') { Write-Host "$l" -ForegroundColor Red } else { Write-Host "$l" }
  }
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

# ---- One-lander lock -------------------------------------------------------------------------------------------
# Taken by Hold-LandLock just before the merge call (or before step 3 when the PR is already merged), released by
# Exit-LandLock in the `finally` that closes right after the sync-cursor check. The try block below is NOT re-indented:
# 270 lines of whitespace would hide the real diff.
$lockPath = if ($env:CCV3_LAND_LOCK) { $env:CCV3_LAND_LOCK } else { Join-Path $HOME '.claude\state\land.lock' }
$lockLogPath = if ($env:CCV3_LAND_LOCK_LOG) { $env:CCV3_LAND_LOCK_LOG } else { Join-Path $HOME '.claude\logs\land-lock.log' }
$lockStaleMin = 30.0   # minutes
if ($env:CCV3_LAND_LOCK_STALE_MIN) {
  $m = 0.0
  if ([double]::TryParse($env:CCV3_LAND_LOCK_STALE_MIN, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$m) -and $m -gt 0) { $lockStaleMin = $m }
}
$lockUnreadableMin = 2.0   # an empty or unreadable lock may be a racer mid-write: stale only after this long, by file time
$lockHost = [Environment]::MachineName
$script:lockMine = $null   # what this run wrote; Exit-LandLock deletes the file only when it still holds exactly this

# The lock file as an object, or $null when it cannot be read or parsed (missing, empty, half written, held open by its writer).
function Get-LockInfo([string]$Path) {
  try {
    $o = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
    $p = [int]$o.pid
    if ($p -le 0) { throw 'no pid' }
    # ConvertFrom-Json turns an ISO string into a DateTime; normalise either form to UTC.
    $s = if ($o.started -is [datetime]) { $o.started.ToUniversalTime() }
         else { [datetime]::Parse("$($o.started)", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal) }
    [pscustomobject]@{ Pid = $p; Host = "$($o.host)"; Pr = "$($o.pr)"; Session = "$($o.session)"; Started = $s.ToString('o'); StartedUtc = $s }
  } catch { $null }
}

# State of the lock file: Free (no file), Held, Stale (with the Reason: dead-pid, pid-reused or age).
function Get-LockState([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if (-not $item) { return [pscustomobject]@{ State = 'Free'; Reason = $null; Info = $null } }
  $info = Get-LockInfo $Path
  if (-not $info) {
    $ageMin = ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalMinutes
    return [pscustomobject]@{ State = $(if ($ageMin -gt $lockUnreadableMin) { 'Stale' } else { 'Held' }); Reason = 'age'; Info = $null }
  }
  if ($info.Host -eq $lockHost) {
    # Same host: the pid decides, at any age. A hung lander keeps its lock; nobody robs it after 30 minutes.
    #   no such process                                  -> Stale (dead-pid)
    #   process started AFTER the lock's `started`       -> Stale (pid-reused: the pid now belongs to another program)
    #   process started before it                        -> Held (the real holder)
    #   start time unreadable (access denied)            -> Held (never rob a lock we cannot disprove)
    $proc = Get-Process -Id $info.Pid -ErrorAction SilentlyContinue
    if (-not $proc) { return [pscustomobject]@{ State = 'Stale'; Reason = 'dead-pid'; Info = $info } }
    $procStart = $null; try { $procStart = $proc.StartTime.ToUniversalTime() } catch { }
    if ($procStart -and $procStart -gt $info.StartedUtc.AddSeconds(2)) { return [pscustomobject]@{ State = 'Stale'; Reason = 'pid-reused'; Info = $info } }
    return [pscustomobject]@{ State = 'Held'; Reason = $null; Info = $info }
  }
  # Another host: its pid says nothing here, so only the age rule applies.
  if (([DateTime]::UtcNow - $info.StartedUtc).TotalMinutes -gt $lockStaleMin) { return [pscustomobject]@{ State = 'Stale'; Reason = 'age'; Info = $info } }
  [pscustomobject]@{ State = 'Held'; Reason = $null; Info = $info }
}

# Atomic create: exactly one of two racers gets $true. The content goes through the same stream, so the file is never
# empty for longer than the write. An existing file is an IOException; any other failure propagates.
function New-LockFile([string]$Path, [string]$Content) {
  try { $fs = [System.IO.File]::Open($Path, 'CreateNew', 'Write', 'None') } catch [System.IO.IOException] { return $false }
  try { $b = [System.Text.UTF8Encoding]::new($false).GetBytes($Content + "`n"); $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }
  $true
}

# Returns $true when this run now holds the lock. $false means someone else holds it (or took it first).
function Enter-LandLock([string]$Path, [string]$Content) {
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
  if (New-LockFile $Path $Content) { return $true }
  # A stale lock is taken over under a named mutex: two racers that both judged it stale must not both delete and create.
  # Without it, B could delete the fresh lock A just created. The OS frees the mutex if its owner dies.
  $key = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($Path).ToLowerInvariant())), 0, 8).Replace('-', '')
  $mutex = [System.Threading.Mutex]::new($false, "Global\ccv3-land-lock-$key")
  $have = $false
  try {
    try { $have = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $have = $true }
    if (-not $have) { return $false }
    $st = Get-LockState $Path
    if ($st.State -eq 'Held') { return $false }
    if ($st.State -eq 'Stale') { try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { return $false } }
    if (-not (New-LockFile $Path $Content)) { return $false }   # lost to a racer outside the mutex: treat as held
    if ($st.State -eq 'Stale') {
      $i = $st.Info
      $line = "land lock: took over stale lock (pid $(if ($i) { $i.Pid } else { '?' }), session $(if ($i -and $i.Session) { $i.Session } else { '-' }), started $(if ($i) { $i.Started } else { '?' }), reason $($st.Reason))"
      Write-Host $line
      try { [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockLogPath)); Add-Content -LiteralPath $lockLogPath -Value $line } catch { Write-Host "  could not write $lockLogPath`: $($_.Exception.Message)" }
    }
    return $true
  } finally { if ($have) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

# Take the lock or stop. Nothing is merged when this stops. A no-op when this run already holds it.
function Hold-LandLock {
  if ($script:lockMine) { return }
  $started = [DateTime]::UtcNow
  $rec = [ordered]@{ pid = $PID; host = $lockHost; pr = $Pr; started = $started.ToString('o') }
  if ($env:CLAUDE_CODE_SESSION_ID) { $rec.session = $env:CLAUDE_CODE_SESSION_ID }
  $got = $false
  # Only an explicit $true counts: a stray value in the function's output must never read as "got the lock".
  try { $v = @(Enter-LandLock $lockPath ($rec | ConvertTo-Json -Compress)) | Select-Object -Last 1; $got = ($v -is [bool]) -and $v } catch { Fail "cannot take the land lock at ${lockPath}: $($_.Exception.Message). Nothing was merged." }
  if ($got) { $script:lockMine = @{ Pid = $PID; Host = $lockHost; Started = $started }; return }
  $i = Get-LockInfo $lockPath
  $who = if ($i) { "PR $($i.Pr), pid $($i.Pid), started $($i.Started)" } else { "lock file unreadable or just written, PR ?, pid ?, started $((Get-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue).LastWriteTimeUtc.ToString('o'))" }
  Fail "another land is in progress ($who). Wait for it to finish, then run again."
}

# Delete the lock only when it still holds what this run wrote. Never throws, never exits.
function Exit-LandLock {
  $mine = $script:lockMine
  if (-not $mine) { return }
  $script:lockMine = $null
  try {
    $i = Get-LockInfo $lockPath
    if ($i -and $i.Pid -eq $mine.Pid -and $i.Host -eq $mine.Host -and [Math]::Abs(($i.StartedUtc - $mine.Started).TotalSeconds) -lt 1) {
      Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
    } else { Write-Host "  land lock: not releasing $lockPath (it no longer holds this run's record)" }
  } catch { Write-Host "  land lock: could not release ${lockPath}: $($_.Exception.Message)" }
}

# decisions.enforce of <root>/review-router.config.json. Only a literal true enforces; a missing or unreadable file is "off".
function Test-EnforceIn([string]$Root) {
  try {
    $cfg = Join-Path $Root 'review-router.config.json'
    if (-not (Test-Path -LiteralPath $cfg)) { return $false }
    return ((Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json).decisions.enforce -eq $true)
  } catch { return $false }
}
# The stricter of two roots: -RepoPath and the checkout this script runs from ($PSScriptRoot\..\..). A -RepoPath with no config, or a stale one, cannot switch the land check off.
function Test-DecisionsEnforced {
  return ((Test-EnforceIn $RepoPath) -or (Test-EnforceIn (Join-Path $PSScriptRoot '..\..')))
}

try {   # closes after the sync-cursor check, with the `finally` that releases the lock
$pull = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
if ($LASTEXITCODE) { Fail "cannot read PR #$Pr" }
$branch = $pull.head.ref; $head = $pull.head.sha

# 1-2. Ready check and head-pinned merge
if (-not $pull.merged -and -not $CleanupOnly) {
  # Land tap: Dave's answer to the Land question, for this PR at this head. No bypass: it runs before the -IgnoreReview split.
  $decisionsEnforced = Test-DecisionsEnforced
  if ($decisionsEnforced) {
    Step "land decision for #$Pr at $($head.Substring(0,7))"
    $ld = Invoke-LandDecision @('check', "$Pr", '--repo', $Repo, '--head', $head)
    $landCode = $ld.Code
    $ld.Out | Out-Host
    if ($landCode) { Fail "land decision check refused #$Pr (exit $landCode). Nothing was merged. Ask Dave the Land question (see the line above), then re-run." }
  } else {
    Write-Host "  WARNING: decisions.enforce is not true, so no land decision from Dave is required for #$Pr. Ask the Land question anyway (ship-ask.mjs land --pr $Pr)." -ForegroundColor Yellow
  }
  if (-not $IgnoreReview) {
    Step "ready check for #$Pr at $($head.Substring(0,7))"
    $skewMargin = 120  # seconds. The READY time is the local clock; GitHub stamps reviews. A fast local clock would hide a review that landed just before it. The re-check ignores CodeRabbit's automatic "Review skipped" notice on a PR with no CodeRabbit label, so that notice does not refuse inside this margin.
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
    $noneOut = node (Join-Path $PSScriptRoot 'land-none-check.mjs') $Pr --repo $Repo --head $head
    $noneCode = $LASTEXITCODE
    Show-NoneOutput $noneOut
    if ($noneCode -eq 1) { Fail "none-pick check refused #$Pr (exit 1). Nothing was merged. Call pr_checkpoint for PR #$Pr so Dave can pick again for this head, then re-run." }
    if ($noneCode) { Fail "none-pick check: could not determine; read the output above, then re-run. Nothing was merged (exit $noneCode)." }
    [void](Add-NoneLine $noneOut)
  } else {
    Write-Host "  -IgnoreReview: skipping the READY check and the pre-merge re-check"
    # Dave's own yes. The none-pick check still runs, as a warning only, so the yes is informed. It never blocks.
    Step "none-pick check for #$Pr (warning only)"
    # A launch failure (node missing) must not stop the merge under -IgnoreReview: catch it and warn below.
    try {
      $noneOut = node (Join-Path $PSScriptRoot 'land-none-check.mjs') $Pr --repo $Repo --head $head --warn
      $noneCode = $LASTEXITCODE
    } catch {
      $noneOut = @()
      $noneCode = 127
    }
    Show-NoneOutput $noneOut
    if (-not (Add-NoneLine $noneOut) -and $noneCode) {
      # --warn exits 0 on every path it reaches. A non-zero exit with no line means the helper did not run (node missing, crash).
      $notRun = "WARNING: none-pick check did not run (exit $noneCode)"
      Write-Host $notRun -ForegroundColor Red
      $done.Add($notRun)
    }
  }
  # Migration gate (scripts/github/migration-gate.mjs): a PR that adds a drizzle migration lands only after the live database
  # has applied it (apply first, then merge). It runs in BOTH branches above and has no bypass: -IgnoreReview skips the review
  # checks, not this one. It reads the database read-only; with no new migration in the PR it never needs the database.
  Step "migration gate for #$Pr"
  node (Join-Path $PSScriptRoot 'migration-gate.mjs') $head --repo-path $RepoPath --remote $Remote | Out-Host
  if ($LASTEXITCODE) { Fail "migration gate refused #$Pr (exit $LASTEXITCODE). Nothing was merged. Apply the migration to the live database (drizzle-kit migrate, after reading the SQL), then re-run." }
  # One lander at a time: every check above is read-only and runs outside the lock. From here to the sync-cursor check only one run works.
  Hold-LandLock
  Step "merging #$Pr ($Method) pinned to head $($head.Substring(0,7))"
  $res = gh api "repos/$Repo/pulls/$Pr/merge" -X PUT -f "merge_method=$Method" -f "sha=$head" 2>&1
  if ($LASTEXITCODE) {
    # A timed-out or failed call may still have merged server-side: verify before failing.
    $again = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
    if (-not $again.merged) { Fail "merge refused: $res" }
  }
  $done.Add("merged #$Pr")
  # The merge is done: use up Dave's land tap. A failure here only warns.
  if ($decisionsEnforced) {
    try { (Invoke-LandDecision @('use', "$Pr", '--repo', $Repo, '--head', $head)).Out | Out-Host } catch { Write-Host "  WARNING: could not use up the land decision: $($_.Exception.Message)" }
  }
} elseif ($pull.merged) {
  Step "#$Pr is already merged; continuing with the local steps"
}
$pull = gh api "repos/$Repo/pulls/$Pr" | ConvertFrom-Json
if (-not $pull.merged) { Fail "#$Pr is not merged; nothing to clean up" }

# 3. Fetch and fast-forward main
Hold-LandLock   # a no-op after a merge by this run; an already-merged PR (or -CleanupOnly) takes the lock here, because the sync is in the held section
# Both fetches run after the merge, so a network blip must not strand a merged PR: up to 3 retries, 2 seconds apart.
# Returns the exit code of the last attempt.
function Invoke-GitFetch([string[]]$GitArgs, [int]$Retries = 3, [int]$DelaySec = 2) {
  for ($n = 0; $n -le $Retries; $n++) {
    git -C $RepoPath @GitArgs 2>&1 | Out-Null
    $rc = $LASTEXITCODE
    if (-not $rc) { return 0 }
    if ($n -lt $Retries) { Write-Host "  git $($GitArgs -join ' ') failed (exit $rc); retry $($n + 1) of $Retries in $DelaySec s"; Start-Sleep -Seconds $DelaySec }
  }
  return $rc
}
Step "fetch $Remote --prune"
if (Invoke-GitFetch @('fetch', $Remote, '--prune')) { Fail "git fetch failed" }
$current = git -C $RepoPath rev-parse --abbrev-ref HEAD
if ($current -eq 'main') {
  git -C $RepoPath merge --ff-only "$Remote/main" 2>&1 | Out-Host
  if ($LASTEXITCODE) { Fail "local main could not fast-forward to $Remote/main (diverged, or local edits conflict). Resolve by hand." }
} else {
  # main is not checked out here: fetch into it, which only ever fast-forwards.
  if (Invoke-GitFetch @('fetch', $Remote, 'main:main')) { Fail "local main could not fast-forward to $Remote/main" }
}
$done.Add("main at $((git -C $RepoPath rev-parse --short main))")

# 4. Sync ~/.claude from a temp worktree of main
# Exit 0 from sync-to-active.sh is not proof: a run that finds the sync lock held only writes
# ~/.claude/.sync.pending and exits 0, and a run that skips also exits 0. The proof is the cursor:
# ~/.claude/state/sync-cursor must equal main's commit.
function Get-SyncStatus {
  # Never throws: a cursor that cannot be read (a directory, a locked file) is "not confirmed", with the reason, and the
  # LANDED line and the cleanup still happen. The merge is already done.
  $cursor = ''; $mainSha = ''; $err = $null
  try {
    $cursorFile = if ($env:CCV3_SYNC_CURSOR) { $env:CCV3_SYNC_CURSOR } else { Join-Path $HOME '.claude\state\sync-cursor' }
    $cursor = if (Test-Path -LiteralPath $cursorFile) { "$(Get-Content -LiteralPath $cursorFile -Raw -ErrorAction Stop)".Trim() } else { '' }
  } catch { $err = $_.Exception.Message }
  try { $mainSha = "$(git -C $RepoPath rev-parse main 2>$null)".Trim() } catch { }
  [pscustomobject]@{ Ok = [bool](-not $err -and $cursor -and $cursor -eq $mainSha); Cursor = $cursor; Main = $mainSha; Error = $err }
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
# Hard sync line: the proof is the cursor, not the exit code. Judged here, inside the held section; printed after LANDED.
$syncStatus = $null
if (-not $NoSync) {
  $syncStatus = Get-SyncStatus
  if ($syncStatus.Ok) { $done.Add('synced via temp worktree') }
}
} finally { Exit-LandLock }   # release right after the cursor check, before cleanup, on every exit path

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

# The merge and the sync are done and the lock is released. A cleanup failure (for example 'Permission denied' on a
# worktree that holds a copied node_modules) is a warning: it never changes the exit code and never blocks the next lander.
try {
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
} catch {
  # "and synced" only when the cursor check passed (not under -NoSync, not when unconfirmed).
  $cleanupWarn = "WARNING: cleanup did not finish ($($_.Exception.Message)). #$Pr is merged$(if ($syncStatus -and $syncStatus.Ok) { ' and synced' }); remove the worktree and branches by hand."
  Write-Host $cleanupWarn -ForegroundColor Yellow
  $done.Add($cleanupWarn)
}

Write-Host "LANDED #${Pr}: $($done -join '; ')" -ForegroundColor Green
if ($syncStatus) {
  $short = { param($s) if ($s) { $s.Substring(0, [Math]::Min(8, $s.Length)) } else { 'missing' } }
  if ($syncStatus.Ok) { Write-Host "SYNC CONFIRMED: cursor $(& $short $syncStatus.Cursor) equals main" -ForegroundColor Green }
  else {
    $cursorText = if ($syncStatus.Error) { "unreadable ($($syncStatus.Error))" } else { & $short $syncStatus.Cursor }
    Write-Host "NOT confirmed synced: cursor $cursorText main $(& $short $syncStatus.Main). The merge already happened; only the sync is open. Sync by hand from a detached worktree of main (SYNC_MAIN_DETACHED=1, Git Bash) before anyone else lands." -ForegroundColor Red
    exit 1
  }
}
