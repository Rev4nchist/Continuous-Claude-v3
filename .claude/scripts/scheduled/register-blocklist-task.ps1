<#
.SYNOPSIS
  Point the CCv3-Blocklist-Update scheduled task at the installed copy of the job.

.DESCRIPTION
  Run this ONCE, after the forward sync has installed scheduled-blocklist-update.bat at
  $env:USERPROFILE\.claude\scripts\scheduled\. It
    1. refuses (exit 1) if that .bat does not exist, so the task never points at a missing file;
    2. exports the task's current XML to a timestamped backup under $env:USERPROFILE\.claude\state\;
    3. sets the task action to: cmd.exe /c "<BatPath>", working directory $env:USERPROFILE\.claude.
  The trigger (daily 09:00) and the principal (current user) are not touched.

  -WhatIf prints what would change and changes nothing, not even the backup file.
  Restore: schtasks /create /tn CCv3-Blocklist-Update /xml <backup file> /f

  PowerShell 5.1 compatible, ASCII only.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'CCv3-Blocklist-Update',
  [string]$BatPath = '',
  [string]$WorkingDirectory = '',
  [string]$BackupDir = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-paths.ps1')
$paths = Get-Ccv3Paths
if (-not $BatPath) { $BatPath = Join-Path $paths.ClaudeHome 'scripts\scheduled\scheduled-blocklist-update.bat' }
if (-not $WorkingDirectory) { $WorkingDirectory = $paths.ClaudeHome }
if (-not $BackupDir) { $BackupDir = Join-Path $paths.ClaudeHome 'state' }

if (-not (Test-Path -LiteralPath $BatPath -PathType Leaf)) {
  Write-Host "[REFUSED] $BatPath does not exist. Merge the change to main and run the forward sync first (scripts/sync-to-active.sh --changed). The task is unchanged."
  exit 1
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "[REFUSED] scheduled task '$TaskName' does not exist. Nothing to change."
  exit 1
}

$oldAction = $task.Actions | Select-Object -First 1
$newArgs = '/c "' + $BatPath + '"'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupDir ($TaskName + '-' + $stamp + '.xml')

Write-Host "Task:      $TaskName (user $($task.Principal.UserId); trigger and user stay as they are)"
foreach ($trg in $task.Triggers) { Write-Host "Trigger:   starts $($trg.StartBoundary), every $($trg.DaysInterval) day(s) (unchanged)" }
Write-Host "Backup:    $backup"
Write-Host "Old:       $($oldAction.Execute) $($oldAction.Arguments)  [dir $($oldAction.WorkingDirectory)]"
Write-Host "New:       cmd.exe $newArgs  [dir $WorkingDirectory]"

if ($PSCmdlet.ShouldProcess($TaskName, "back up to $backup, then set action to cmd.exe $newArgs")) {
  if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
  $xml = Export-ScheduledTask -TaskName $TaskName
  Set-Content -LiteralPath $backup -Value $xml -Encoding Unicode
  if (-not (Test-Path -LiteralPath $backup)) { Write-Host "[ERROR] backup was not written; task unchanged"; exit 1 }
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $newArgs -WorkingDirectory $WorkingDirectory
  Set-ScheduledTask -TaskName $TaskName -Action $action | Out-Null
  $now = (Get-ScheduledTask -TaskName $TaskName).Actions | Select-Object -First 1
  Write-Host "Done. Task now runs: $($now.Execute) $($now.Arguments)  [dir $($now.WorkingDirectory)]"
}
exit 0
