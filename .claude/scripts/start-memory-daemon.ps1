# Start Claude Memory Daemon (for Task Scheduler or manual use)
$env:DATABASE_URL = "postgresql://claude:claude_dev@localhost:5432/continuous_claude"
. (Join-Path $PSScriptRoot 'scheduled\profile-paths.ps1')
$paths = Get-Ccv3Paths
$daemonScript = Join-Path $paths.ClaudeHome 'scripts\core\core\memory_daemon.py'

# Check if already running
$status = python $daemonScript status 2>&1
if ($status -match "Running: Yes") {
    Write-Host "Memory daemon already running"
    exit 0
}

# Start the daemon
python $daemonScript start
