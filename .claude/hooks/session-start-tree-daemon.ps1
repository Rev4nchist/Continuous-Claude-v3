# SessionStart Hook - Auto-start Knowledge Tree Daemon (Windows)
# Starts the tree daemon for the current project directory.

$PROJECT_DIR = $PWD.Path
$OPC_DIR = if ($env:CLAUDE_OPC_DIR) { $env:CLAUDE_OPC_DIR } else { "$env:USERPROFILE\continuous-claude\opc" }
$DAEMON_SCRIPT = Join-Path $OPC_DIR "scripts\core\tree_daemon.py"
$ERROR_LOG = Join-Path $env:USERPROFILE ".claude\hooks\errors.log"

# Skip infrastructure directory (~/.claude)
$CLAUDE_DIR = Join-Path $env:USERPROFILE ".claude"
if ($PROJECT_DIR -eq $CLAUDE_DIR -or $PROJECT_DIR.EndsWith("\.claude") -or $PROJECT_DIR.EndsWith("/.claude")) {
    Write-Output '{"result":"continue"}'
    exit 0
}

# Ensure error log directory exists
$ERROR_LOG_DIR = Split-Path $ERROR_LOG -Parent
if (-not (Test-Path $ERROR_LOG_DIR)) {
    New-Item -ItemType Directory -Path $ERROR_LOG_DIR -Force | Out-Null
}

# Check if daemon script exists
if (-not (Test-Path $DAEMON_SCRIPT)) {
    Write-Output '{"result":"continue"}'
    exit 0
}

# Check OPC directory
if (-not (Test-Path $OPC_DIR)) {
    Write-Output '{"result":"continue"}'
    exit 0
}

# Check if daemon is already running
Push-Location $OPC_DIR
try {
    $env:PYTHONPATH = "."
    $STATUS = uv run python scripts/core/tree_daemon.py --project "$PROJECT_DIR" --status 2>> $ERROR_LOG

    if ($STATUS -match "running") {
        Write-Output '{"result":"continue"}'
        exit 0
    }

    # Start daemon in background (log errors)
    Start-Process -NoNewWindow -FilePath "uv" -ArgumentList "run", "python", "scripts/core/tree_daemon.py", "--project", "$PROJECT_DIR", "--background" -RedirectStandardOutput "NUL" -RedirectStandardError $ERROR_LOG
} finally {
    Pop-Location
}

Write-Output '{"result":"continue"}'
