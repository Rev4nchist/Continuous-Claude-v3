<#
.SYNOPSIS
  Pre-warm the CCv3 BGE embedding daemon.

.DESCRIPTION
  Checks if the daemon is already running (PID alive + responds to ping).
  If not, spawns a detached daemon process. Logs to ~/.claude/logs/.

.PARAMETER DryRun
  Parse and validate the script without spawning anything.
#>
param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Repo root resolution (portable -- no hardcoded user path)
# ---------------------------------------------------------------------------
$repoRoot = $null
if ($env:CLAUDE_PROJECT_DIR) {
    $repoRoot = $env:CLAUDE_PROJECT_DIR
} elseif ($PSScriptRoot) {
    $resolved = Resolve-Path (Join-Path $PSScriptRoot '..') -ErrorAction SilentlyContinue
    if ($resolved) { $repoRoot = $resolved.Path }
}
if (-not $repoRoot -or -not (Test-Path $repoRoot)) {
    $repoRoot = Join-Path $HOME 'continuous-claude'
}

# ---------------------------------------------------------------------------
# Logging helpers (rotate at 1 MB, keep 3 prior)
# ---------------------------------------------------------------------------
# NOTE: 2-arg Join-Path only. The 3-arg form (Join-Path $HOME '.claude' 'logs')
# is PowerShell 6+ only and CRASHES on Windows PowerShell 5.1 -- which is what
# the scheduled task invokes via powershell.exe. That crash (before the spawn)
# is why the launcher log never existed and the daemon was only ever started
# ad-hoc by hooks. Keep every Join-Path here 2-arg.
$logDir  = Join-Path (Join-Path $HOME '.claude') 'logs'
$logFile = Join-Path $logDir 'embedding-daemon-launcher.log'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $Message"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Rotate-Log {
    if (-not (Test-Path $logFile)) { return }
    if ((Get-Item $logFile).Length -lt 1MB) { return }
    for ($i = 3; $i -ge 1; $i--) {
        $src = if ($i -eq 1) { $logFile } else { "$logFile.$($i-1)" }
        $dst = "$logFile.$i"
        if (Test-Path $src) { Move-Item $src $dst -Force }
    }
}

Rotate-Log

if ($DryRun) {
    Write-Log 'DryRun flag set -- exiting without spawning.'
    exit 0
}

# ---------------------------------------------------------------------------
# Check if daemon is already alive
# ---------------------------------------------------------------------------
# Canonical, env-independent rendezvous path -- mirrors _canonical_run_dir()
# in embedding_daemon.py and RUN_DIR in embedding-client.ts. MUST NOT use
# $env:TEMP: the Python daemon resolves its discovery file via Path.home()
# (~/.claude/run), so $env:TEMP would look in the wrong directory (the
# root-cause bug). $HOME == USERPROFILE == Python Path.home() on Windows.
$runDir     = Join-Path (Join-Path $HOME '.claude') 'run'
$infoPath   = Join-Path $runDir 'ccv3-embedding.json'
$needsSpawn = $true

if (Test-Path $infoPath) {
    try {
        $info    = Get-Content $infoPath -Raw | ConvertFrom-Json
        $daemonPid  = [int]$info.pid
        $daemonPort = [int]$info.port

        # PID alive?
        $existingProc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
        if ($existingProc) {
            # Daemon responds to ping? (4-byte big-endian length prefix + JSON)
            # The daemon dispatches on the "cmd" key (embedding_daemon.py:246),
            # NOT "op" -- a {"op":"ping"} frame is misread as cmd="embed" and
            # returns an error frame. Send {"cmd":"ping"} and require ok:true so
            # a husk (modelless or error-state) daemon does NOT pass as alive.
            $payload  = [System.Text.Encoding]::UTF8.GetBytes('{"cmd":"ping"}')
            $lenBytes = [System.BitConverter]::GetBytes([uint32]$payload.Length)
            if ([System.BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBytes) }
            $client    = [System.Net.Sockets.TcpClient]::new()
            $connected = $client.ConnectAsync('127.0.0.1', $daemonPort).Wait(2000)
            if ($connected) {
                $stream = $client.GetStream()
                # Bound the read the same way ConnectAsync bounds the connect.
                # Without this, a daemon that accepts the connection but stalls
                # mid-write (e.g. crashing during a cold model load) would make
                # $stream.Read block FOREVER -- the scheduled-task launcher would
                # hang and never exit. 3s is generous for a ~few-hundred-byte
                # ping reply over loopback.
                $stream.ReadTimeout = 3000
                $stream.Write($lenBytes, 0, 4)
                $stream.Write($payload,  0, $payload.Length)
                # Read the 4-byte length prefix, then the full JSON reply body.
                $hdr = New-Object byte[] 4
                try {
                    $got = $stream.Read($hdr, 0, 4)
                } catch {
                    # ReadTimeout (or transport error) -> treat as not alive.
                    $got = 0
                    Write-Log "Daemon pid=$daemonPid ping read timed out/failed -- will respawn."
                }
                if ($got -eq 4) {
                    if ([System.BitConverter]::IsLittleEndian) { [Array]::Reverse($hdr) }
                    $bodyLen = [System.BitConverter]::ToUInt32($hdr, 0)
                    if ($bodyLen -gt 0 -and $bodyLen -le 1048576) {
                        $body = New-Object byte[] $bodyLen
                        $off  = 0
                        while ($off -lt $bodyLen) {
                            $n = $stream.Read($body, $off, $bodyLen - $off)
                            if ($n -le 0) { break }
                            $off += $n
                        }
                        if ($off -eq $bodyLen) {
                            try {
                                $reply = [System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
                                if ($reply.ok -eq $true) {
                                    $needsSpawn = $false
                                    Write-Log "Daemon already running and healthy (pid=$daemonPid port=$daemonPort) -- no-op."
                                } else {
                                    Write-Log "Daemon pid=$daemonPid replied but not ok -- will respawn."
                                }
                            } catch {
                                Write-Log "Daemon pid=$daemonPid sent an unparseable ping reply -- will respawn."
                            }
                        }
                    }
                } elseif ($got -gt 0) {
                    # Partial header (1-3 bytes): a slow-but-alive daemon. Log it
                    # distinctly -- a silent fall-through here re-spawns even a
                    # healthy daemon, reintroducing the thundering-herd symptom.
                    Write-Log "Daemon pid=$daemonPid returned a partial header ($got/4 bytes) -- treating as not alive."
                }
                $client.Close()
            } else {
                $client.Close()
            }
        }
    } catch {
        Write-Log "Stale/unreadable info file -- will respawn. ($_)"
    }
}

if (-not $needsSpawn) { exit 0 }

# ---------------------------------------------------------------------------
# Spawn detached daemon
# ---------------------------------------------------------------------------
Write-Log "Spawning embedding daemon from repo root: $repoRoot"
# 2-arg Join-Path chaining only (5-arg form is PS 6+; crashes on Win PS 5.1).
$daemonScript = Join-Path (Join-Path (Join-Path (Join-Path $repoRoot 'opc') 'scripts') 'core') 'embedding_daemon.py'
if (-not (Test-Path $daemonScript)) {
    Write-Log "ERROR: daemon script not found at $daemonScript"
    exit 1
}

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName         = 'uv'
$psi.Arguments        = "run --project opc python opc/scripts/core/embedding_daemon.py --daemon"
$psi.WorkingDirectory = $repoRoot
# UseShellExecute=$true: ShellExecuteEx passes no inheritable handles, so the daemon does NOT
# inherit this script's stdout/stderr. With $false the daemon held the caller's pipe open and
# `start-embedding-daemon.ps1 | cat` (or a hook with piped stdio) hung until the daemon exited.
# CreateNoWindow is ignored under ShellExecute; WindowStyle Hidden keeps the console hidden.
$psi.UseShellExecute  = $true
$psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden

$spawnedProc = [System.Diagnostics.Process]::Start($psi)
if (-not $spawnedProc) {
    Write-Log 'ERROR: failed to start daemon process.'
    exit 1
}

Write-Log "Daemon spawned (pid=$($spawnedProc.Id)) - will be ready when $infoPath appears."
exit 0
