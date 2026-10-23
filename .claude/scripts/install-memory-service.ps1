# Install Claude Memory Daemon as Windows Service
# Run this script as Administrator

. (Join-Path $PSScriptRoot 'scheduled\profile-paths.ps1')
$paths = Get-Ccv3Paths
$localApp = $env:LOCALAPPDATA
if (-not $localApp) { $localApp = Join-Path $paths.UserHome 'AppData\Local' }
$nssmPath = Join-Path $localApp 'Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe'
$serviceName = "ClaudeMemoryDaemon"
$pythonPath = (Get-Command python).Source
$daemonScript = Join-Path $paths.ClaudeHome 'scripts\core\core\memory_daemon.py'
$workDir = $paths.ClaudeHome

Write-Host "Installing Claude Memory Daemon as Windows Service..." -ForegroundColor Cyan
Write-Host "NSSM: $nssmPath"
Write-Host "Python: $pythonPath"
Write-Host "Daemon: $daemonScript"

# Check if service already exists
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service already exists. Removing..." -ForegroundColor Yellow
    & $nssmPath stop $serviceName 2>$null
    & $nssmPath remove $serviceName confirm
}

# Install the service
Write-Host "Installing service..."
& $nssmPath install $serviceName $pythonPath $daemonScript start

# Configure service settings
Write-Host "Configuring service..."
& $nssmPath set $serviceName AppDirectory $workDir
& $nssmPath set $serviceName Start SERVICE_AUTO_START
& $nssmPath set $serviceName DisplayName "Claude Memory Extraction Daemon"
& $nssmPath set $serviceName Description "Extracts learnings from Claude sessions for cross-session memory"

# Set environment variables for the service
& $nssmPath set $serviceName AppEnvironmentExtra "DATABASE_URL=postgresql://claude:claude_dev@localhost:5432/continuous_claude"

# Configure stdout/stderr logging
& $nssmPath set $serviceName AppStdout "$workDir\memory-daemon-stdout.log"
& $nssmPath set $serviceName AppStderr "$workDir\memory-daemon-stderr.log"
& $nssmPath set $serviceName AppRotateFiles 1
& $nssmPath set $serviceName AppRotateBytes 1048576

Write-Host "Starting service..."
& $nssmPath start $serviceName

# Verify
Start-Sleep -Seconds 2
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "Service installed and running!" -ForegroundColor Green
} else {
    Write-Host "Service may not have started. Check with: Get-Service $serviceName" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Service management commands:" -ForegroundColor Cyan
Write-Host "  Start:   & '$nssmPath' start $serviceName"
Write-Host "  Stop:    & '$nssmPath' stop $serviceName"
Write-Host "  Restart: & '$nssmPath' restart $serviceName"
Write-Host "  Remove:  & '$nssmPath' remove $serviceName confirm"
