# Setup Task Scheduler to auto-start Claude Memory Daemon at login
# This does NOT require admin privileges for user-level tasks

$taskName = "ClaudeMemoryDaemon"
. (Join-Path $PSScriptRoot 'scheduled\profile-paths.ps1')
$paths = Get-Ccv3Paths
$scriptPath = Join-Path $paths.ClaudeHome 'scripts\start-memory-daemon.ps1'

Write-Host "Setting up Task Scheduler auto-start for Claude Memory Daemon..." -ForegroundColor Cyan

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Create the action
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

# Create the trigger (at logon for current user)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Create settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Register the task
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Auto-start Claude memory daemon at login" -Force
    Write-Host "Task scheduled successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "The memory daemon will now auto-start when you log in."
    Write-Host ""
    Write-Host "To manage:" -ForegroundColor Yellow
    Write-Host "  View:    Get-ScheduledTask -TaskName '$taskName'"
    Write-Host "  Run now: Start-ScheduledTask -TaskName '$taskName'"
    Write-Host "  Remove:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
} catch {
    Write-Host "Failed to create scheduled task: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "If access denied, try running PowerShell as Administrator" -ForegroundColor Yellow
}
