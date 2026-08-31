# install-snapshot-task.ps1 -- register the daily ~/.claude snapshot commit.
# Pattern cloned from scripts/install-embedding-daemon-task.ps1 (idempotent
# Register-ScheduledTask, -RunLevel Limited, no admin needed).
#
# Install:   powershell -NoProfile -ExecutionPolicy Bypass -File install-snapshot-task.ps1
# Uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File install-snapshot-task.ps1 -Uninstall
# Fallback:  schtasks /delete /tn "CCv3-Claude-Snapshot" /f

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'CCv3-Claude-Snapshot'
$ScriptPath = Join-Path $PSScriptRoot 'snapshot-claude.ps1'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Unregistered: $TaskName"
    exit 0
}

if (-not (Test-Path $ScriptPath)) {
    Write-Error "snapshot-claude.ps1 not found at $ScriptPath"
    exit 1
}

# Idempotent: drop any existing registration first.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At '18:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Daily history snapshot commit of ~/.claude (harness-security lane, docs/harness-strategy/README.md section 6)' | Out-Null

Write-Output "Registered: $TaskName (daily 18:00, StartWhenAvailable). Verify: Get-ScheduledTask -TaskName $TaskName"
