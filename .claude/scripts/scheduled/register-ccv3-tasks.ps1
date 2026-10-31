<#
.SYNOPSIS
  Register the CCv3 scheduled tasks from scripts/scheduled/tasks.json (the single source).

.DESCRIPTION
  Reads tasks.json and, for each task, builds one scheduled-task action:
    .bat  ->  cmd.exe /c "<installed script>"
    .ps1  ->  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<installed script>"
  The script path in tasks.json is relative to the repo root. The task runs the INSTALLED copy under
  ~/.claude (the forward sync puts it there), so the job that runs is always main's version.
  The trigger ("daily HH:MM" or "weekly <Day> HH:MM") and execLimitMin come from the file.

  DRY RUN BY DEFAULT: it prints each task and changes nothing. Pass -Apply to register. -Apply refuses
  (exit 1) when an installed script is missing. Use -Only <name> to register one task.
  Existing tasks of the same name are replaced (Register-ScheduledTask -Force).

  PowerShell 5.1 compatible, ASCII only.
#>
param(
  [string]$TasksFile = '',
  [string]$ClaudeHome = '',
  [string]$Only = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $env:USERPROFILE '.claude' }
if (-not $TasksFile) { $TasksFile = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'scripts\scheduled\tasks.json' }

function Get-Trigger([string]$text) {
  if ($text -match '^daily (\d{2}:\d{2})$') { return New-ScheduledTaskTrigger -Daily -At $Matches[1] }
  if ($text -match '^weekly (\w+) (\d{2}:\d{2})$') { return New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Matches[1] -At $Matches[2] }
  throw "unsupported trigger '$text'"
}

function Get-ActionParts([string]$installed) {
  if ($installed.EndsWith('.ps1')) {
    return @('powershell.exe', ('-NoProfile -ExecutionPolicy Bypass -File "' + $installed + '"'))
  }
  return @('cmd.exe', ('/c "' + $installed + '"'))
}

$tasks = @((Get-Content -LiteralPath $TasksFile -Raw | ConvertFrom-Json).tasks)
if ($Only) { $tasks = @($tasks | Where-Object { $_.name -eq $Only }) }
if ($tasks.Count -eq 0) { Write-Host '[REFUSED] no task matches'; exit 1 }

function Get-Installed($t) {
  $rel = ([string]$t.script) -replace '^\.claude[\\/]', ''
  Join-Path $ClaudeHome ($rel -replace '/', '\')
}

# Check every installed script first, so -Apply never registers some tasks and then refuses.
$missing = @($tasks | Where-Object { -not (Test-Path -LiteralPath (Get-Installed $_) -PathType Leaf) }).Count
if ($Apply -and $missing -gt 0) {
  foreach ($t in $tasks) { $p = Get-Installed $t; if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Write-Host "[MISSING] $p" } }
  Write-Host "[REFUSED] $missing installed script(s) missing. Run the forward sync first. Nothing registered."
  exit 1
}

foreach ($t in $tasks) {
  $installed = Get-Installed $t
  $parts = Get-ActionParts $installed
  Write-Host ("{0}: {1} {2}  [{3}, limit {4} min]" -f $t.name, $parts[0], $parts[1], $t.trigger, $t.execLimitMin)
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { Write-Host "  [MISSING] $installed"; continue }
  if (-not $Apply) { continue }
  $action = New-ScheduledTaskAction -Execute $parts[0] -Argument $parts[1] -WorkingDirectory $ClaudeHome
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes ([int]$t.execLimitMin)) -StartWhenAvailable
  Register-ScheduledTask -TaskName $t.name -Action $action -Trigger (Get-Trigger $t.trigger) -Settings $settings -Force | Out-Null
  Write-Host '  registered'
}

if (-not $Apply) { Write-Host 'DRY RUN: nothing changed. Pass -Apply to register.' }
exit 0
