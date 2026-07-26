<#
.SYNOPSIS
  Run a git command, retrying only the MSYS shared-memory init crash.

.WHY
  Git for Windows runs every hook through its bundled MSYS shell. MSYS builds its
  mount table in a shared memory region exactly once per cohort of processes,
  guarded by a spinlock in shared.cc that GIVES UP AFTER 15 SECONDS. If two MSYS
  processes cold-start at about the same time and the first is slow inside that
  critical section, the second enters anyway, mountinfo.init() runs twice, and
  every process in that cohort dies with:

      *** fatal error - add_item ("\??\C:\...\Git", "/", ...) failed, errno 1

  exiting 0xC0000005 (3221225477). The crash happens during DLL init, before bash
  ever reads the hook script -- so a hook cannot retry itself, and git treats the
  dead pre-commit hook as a veto and aborts the commit. The retry has to live out
  here, wrapping git.

  Measured on this machine 2026-07-26: five commits and one push failed this way
  in a single session, every one of them succeeding on a later attempt with no
  other change. Ruled out as causes: forced ASLR (all mitigations NOTSET),
  competing MSYS runtimes (one msys-2.0.dll, 3.5.7), running AV filter drivers
  (none), and Claude Code's own hooks (0 of 146 invoke bash). The username DOES
  contain a period, which some reports blame, but that cannot be it here: bash
  succeeds the overwhelming majority of the time and a fundamental
  incompatibility would not be intermittent.

.SAFETY
  Retries ONLY on the MSYS-init signature. A real git failure -- merge conflict,
  rejected push, failing pre-commit guard, bad ref -- is returned immediately and
  untouched, because silently re-running a genuinely failing git command is how
  you turn one problem into two. Non-idempotent commands are additionally never
  retried unless the signature is present AND git produced no commit.

.EXAMPLE
  pwsh -File scripts/git-safe.ps1 -C C:\repo commit -F msg.txt
  pwsh -File scripts/git-safe.ps1 -C C:\repo push fork agentic-os
#>
# NO param() block, deliberately. Git's own flags collide with PowerShell's
# parameter binder -- `-C <repo>` was being bound as an abbreviation of a script
# parameter, and the next token ("rev-parse") was then coerced to [int] and threw.
# Using the automatic $args means every git argument passes through untouched,
# which is the whole point of a transparent wrapper. Tuning comes from env vars.
$GitArgs = $args

if (-not $GitArgs -or $GitArgs.Count -eq 0) {
    Write-Error "git-safe: no git arguments supplied."
    exit 2
}

$MaxAttempts = if ($env:GIT_SAFE_MAX_ATTEMPTS) { [int]$env:GIT_SAFE_MAX_ATTEMPTS } else { 4 }
# Backoff between attempts. The observed clear time is ~8-10s, consistent with
# waiting out the stuck cohort rather than the 15s spinlock.
$BackoffSeconds = if ($env:GIT_SAFE_BACKOFF_SECONDS) { [int]$env:GIT_SAFE_BACKOFF_SECONDS } else { 6 }
$LogPath = if ($env:GIT_SAFE_LOG) { $env:GIT_SAFE_LOG } else { "$env:USERPROFILE\.claude\logs\msys-crash.jsonl" }

# The signature of an MSYS init crash, NOT of a git error.
$MSYS_PATTERNS = @(
    'fatal error - add_item',
    'failed, errno 1',
    'cygheap base mismatch',
    'unable to remap',
    'Resource temporarily unavailable'
)
$MSYS_EXIT_CODES = @(-1073741819, 3221225477, 127, 128, 3)

function Test-MsysCrash {
    param([string]$Output, [int]$ExitCode)
    # Require the textual signature. Exit code alone is far too broad -- git uses
    # 128 for ordinary errors, so matching on code only would retry real failures.
    foreach ($p in $MSYS_PATTERNS) {
        if ($Output -match [regex]::Escape($p)) { return $true }
    }
    return $false
}

function Write-CrashLog {
    param([int]$Attempt, [int]$ExitCode, [string]$Snippet, [bool]$Recovered)
    try {
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $row = [ordered]@{
            ts        = (Get-Date).ToString('o')
            attempt   = $Attempt
            exit      = $ExitCode
            recovered = $Recovered
            argv      = ($GitArgs -join ' ')
            snippet   = $Snippet
            # Concurrency context, so we can test the cold-start-race theory
            # against real occurrences instead of synthetic bursts.
            bash_alive = (Get-Process bash -ErrorAction SilentlyContinue | Measure-Object).Count
            node_alive = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
        }
        Add-Content -Path $LogPath -Value ($row | ConvertTo-Json -Compress) -Encoding utf8
    } catch {
        # Telemetry must never be the reason a git command fails.
    }
}

$attempt = 0
while ($true) {
    $attempt++
    $output = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $text = ($output | Out-String)

    if ($code -eq 0) {
        if ($attempt -gt 1) {
            Write-CrashLog -Attempt ($attempt - 1) -ExitCode $code -Snippet 'recovered' -Recovered $true
            Write-Host "[git-safe] recovered on attempt $attempt" -ForegroundColor DarkYellow
        }
        if ($text.Trim()) { Write-Output $text.TrimEnd() }
        exit 0
    }

    if (-not (Test-MsysCrash -Output $text -ExitCode $code)) {
        # A real git failure. Surface it verbatim and do not retry.
        if ($text.Trim()) { Write-Output $text.TrimEnd() }
        exit $code
    }

    $snippet = ($text -split "`n" | Where-Object { $_ -match 'fatal error|errno' } | Select-Object -First 1)
    Write-CrashLog -Attempt $attempt -ExitCode $code -Snippet ("$snippet".Trim()) -Recovered $false

    if ($attempt -ge $MaxAttempts) {
        Write-Warning "[git-safe] MSYS init crash persisted across $MaxAttempts attempts."
        if ($text.Trim()) { Write-Output $text.TrimEnd() }
        exit $code
    }

    Write-Host "[git-safe] MSYS init crash (attempt $attempt/$MaxAttempts) - retrying in ${BackoffSeconds}s" -ForegroundColor DarkYellow
    Start-Sleep -Seconds $BackoffSeconds
}
