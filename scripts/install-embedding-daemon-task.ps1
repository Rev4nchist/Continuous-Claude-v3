<#
.SYNOPSIS
  Register the CCv3-Embedding-Daemon Windows Task Scheduler entry.

.DESCRIPTION
  Idempotent. Replaces any existing task with the same name.
  Runs the embedding daemon pre-warm at logon with a 30s delay (no admin required).
  Mirrors the CCv3-Blocklist-Update pattern documented in
  docs/hooks/package-install-guard.md.

.NOTES
  Run this script ONCE after a fresh clone. Do NOT run automatically.
  Uninstall: pwsh -File scripts/uninstall-embedding-daemon-task.ps1
             Or: schtasks /delete /tn "CCv3-Embedding-Daemon" /f
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'CCv3-Embedding-Daemon'

# Resolve absolute path to the start script (same directory as this installer)
$startScript = Join-Path $PSScriptRoot 'start-embedding-daemon.ps1'
if (-not (Test-Path $startScript)) {
    Write-Error "Start script not found at: $startScript"
    exit 1
}

Write-Host "Registering scheduled task '$taskName'..."

# Remove existing task if present (idempotent)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "  Removed existing task."
}

# Trigger: at logon for current user, 30s delay
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$trigger.Delay = 'PT30S'   # ISO 8601 duration — 30 seconds

# Action: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""

# Settings: start when available, battery-friendly
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Register as current user, Limited run level (no admin)
Register-ScheduledTask `
    -TaskName  $taskName `
    -Trigger   $trigger `
    -Action    $action `
    -Settings  $settings `
    -RunLevel  Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Task '$taskName' registered successfully."
Write-Host "  Trigger : At logon for $env:USERNAME (30s delay)"
Write-Host "  Action  : powershell.exe -File `"$startScript`""
Write-Host "  RunLevel: Limited (no admin required)"
Write-Host ""
Write-Host "The daemon will pre-warm on next login."
Write-Host "To verify: after reboot, $HOME\.claude\run\ccv3-embedding.json should appear within ~60s."
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  pwsh -File scripts\uninstall-embedding-daemon-task.ps1"
Write-Host "  schtasks /delete /tn `"$taskName`" /f"
