# snapshot-claude.ps1 -- daily history snapshot of the active ~/.claude tree.
#
# docs/harness-strategy/README.md section 6: "~/.claude drift recurs by design...
# the fix is a scheduled snapshot commit, not a hook -- PostToolUse cannot see
# shell-copy writes." This is that scheduled snapshot. Local commit only: no
# push, no reverse sync (the ~/.claude post-commit hook is a verified no-op).
#
# Safety preflights (premortem tigers):
#   - refuses to commit if anything secret-shaped is staged (.env*, credentials,
#     *key*.json) -- resets the index and logs REFUSED
#   - refuses if the staged payload exceeds 200 MB (a gitignore regression would
#     otherwise commit gigabytes of session data)
#   - single-flight lock so an overlapping manual + scheduled run cannot race
#
# PowerShell 5.1 compatible (scheduled tasks run powershell.exe 5.1).
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File snapshot-claude.ps1

$ErrorActionPreference = 'Stop'
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$LogDir = Join-Path $ClaudeHome 'logs\claude-snapshot'
$LogFile = Join-Path $LogDir ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$LockDir = Join-Path $ClaudeHome '.snapshot.lock'
$MaxStagedBytes = 200MB

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Write-Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Output $line
}

# Single-flight lock (atomic directory create). Steal if older than 30 min.
if (Test-Path $LockDir) {
    $age = (Get-Date) - (Get-Item $LockDir).LastWriteTime
    if ($age.TotalMinutes -lt 30) {
        Write-Log "SKIP: another snapshot is running (lock held $([int]$age.TotalMinutes)m)"
        exit 0
    }
    Remove-Item -Force -Recurse $LockDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $LockDir | Out-Null

try {
    if (-not (Test-Path (Join-Path $ClaudeHome '.git'))) {
        Write-Log "ERROR: $ClaudeHome is not a git repo -- nothing to snapshot"
        exit 1
    }

    $dirty = git -C $ClaudeHome status --porcelain
    # $ErrorActionPreference does not cover native commands: a missing git or
    # unreadable repo would otherwise log CLEAN and stamp last-success forever.
    if ($LASTEXITCODE -ne 0) { Write-Log "ERROR: git status failed ($LASTEXITCODE)"; exit 1 }
    if (-not $dirty) {
        Write-Log "CLEAN: nothing to snapshot"
        Set-Content -Path (Join-Path $LogDir 'last-success.txt') -Value (Get-Date -Format 'o')
        exit 0
    }

    git -C $ClaudeHome add -A
    if ($LASTEXITCODE -ne 0) { Write-Log "ERROR: git add failed ($LASTEXITCODE)"; exit 1 }

    # Preflight 1: secret-shaped staged paths. gitignore should stop these; this
    # is the backstop for a gitignore regression. Never let them enter history.
    $staged = git -C $ClaudeHome diff --cached --name-only
    $secretHits = @($staged | Where-Object {
        $_ -match '(^|/)\.env' -or $_ -match 'credential' -or $_ -match 'key.*\.json$' -or $_ -match '\.pem$' -or
        $_ -match 'settings\.json' -or $_ -match '\.env(\.|/|$)'
    })
    if ($secretHits.Count -gt 0) {
        git -C $ClaudeHome reset | Out-Null
        Write-Log ("REFUSED: secret-shaped paths staged, index reset. Fix .gitignore. Paths: " + ($secretHits -join ', '))
        exit 1
    }

    # Preflight 2: staged payload size (sum of on-disk sizes of staged paths).
    $sizeSum = 0
    foreach ($p in $staged) {
        $full = Join-Path $ClaudeHome $p
        if (Test-Path $full -PathType Leaf) { $sizeSum += (Get-Item $full).Length }
    }
    if ($sizeSum -gt $MaxStagedBytes) {
        git -C $ClaudeHome reset | Out-Null
        Write-Log ("REFUSED: staged payload {0:N0} bytes exceeds cap {1:N0}, index reset. Check .gitignore." -f $sizeSum, $MaxStagedBytes)
        exit 1
    }

    $msg = "snapshot: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm')
    git -C $ClaudeHome commit -m $msg | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Log "ERROR: git commit failed ($LASTEXITCODE)"; exit 1 }

    $sha = git -C $ClaudeHome rev-parse --short HEAD
    Write-Log ("COMMITTED: {0} ({1} paths, {2:N0} bytes staged)" -f $sha, @($staged).Count, $sizeSum)
    Set-Content -Path (Join-Path $LogDir 'last-success.txt') -Value (Get-Date -Format 'o')
    exit 0
}
finally {
    Remove-Item -Force -Recurse $LockDir -ErrorAction SilentlyContinue
}
