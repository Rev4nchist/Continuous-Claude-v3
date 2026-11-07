<#
.SYNOPSIS
  Register the CCv3 scheduled tasks from scripts/scheduled/tasks.json (the single source).

.DESCRIPTION
  Reads tasks.json and, for each task, builds one scheduled-task action:
    .bat  ->  cmd.exe /c "<installed script>"
    .ps1  ->  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<installed script>"
  The script path in tasks.json is relative to the repo root. The task runs the INSTALLED copy under
  ~/.claude (the forward sync puts it there), so the job that runs is always main's version.
  The trigger ("daily HH:MM", "weekly <Day> HH:MM" or "every Nm", N from 1 to 1439: repeat every N minutes all day, for ever)
  and execLimitMin come from the file. A bad trigger fails the dry run too.
  Optional booleans set the power behaviour and the window (a missing field is false):
    llm   true -> the task starts on battery and keeps running when the laptop goes on battery.
          false -> the Windows default: no start on battery, stopped when going on battery.
    battery  true -> the same battery behaviour as llm, for a job that is not an LLM job.
    hidden   true -> a .ps1 action runs through conhost.exe --headless powershell.exe, so Task Scheduler opens no window
             (-WindowStyle Hidden still flashed one; the 2026-11-07 live test of the conhost form showed no flash).
             Only the tasks that set it change.
    wake  true -> the task wakes the laptop (WakeToRun). Use it with llm=true, or the wake does nothing on battery.
  The dry run prints llm, battery and wake for each task, read from the settings object it would register.
  Wake on battery also needs the power plan setting "Allow wake timers" to be on for battery. This script does not change it.

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
  if ($text -match '^every (\d+)m$') {
    $n = [int]$Matches[1]
    if ($n -lt 1 -or $n -gt 1439) { throw "unsupported trigger '$text': every Nm needs N from 1 to 1439" }
    # Repeat all day, for ever: a Once trigger from midnight today with an interval and NO -RepetitionDuration (an empty
    # duration repeats for ever on Windows 10 and later). Do not pass [TimeSpan]::MaxValue: its duration P99999999DT23H59M59S
    # is refused by Register-ScheduledTask as "incorrectly formatted or out of range".
    return New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $n)
  }
  throw "unsupported trigger '$text'"
}

function Get-ActionParts([string]$installed, [bool]$hidden = $false) {
  if ($installed.EndsWith('.ps1')) {
    if ($hidden) {
      # conhost --headless gives powershell.exe no console, so Task Scheduler opens no window. -WindowStyle Hidden still flashed one.
      $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
      return @($conhost, ('--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installed + '"'))
    }
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

# Power settings come from the llm and wake fields (a missing field is false). Windows defaults are no start on
# battery, stop when going on battery, no wake. An llm job must run on battery. Only wake=true wakes the laptop.
# New-ScheduledTaskSettingsSet builds an object in memory: it changes nothing, so a dry run can print what it holds.
function Get-TaskSettings($t) {
  $set = @{ ExecutionTimeLimit = (New-TimeSpan -Minutes ([int]$t.execLimitMin)); StartWhenAvailable = $true }
  if ($t.llm -eq $true -or $t.battery -eq $true) { $set.AllowStartIfOnBatteries = $true; $set.DontStopIfGoingOnBatteries = $true }
  if ($t.wake -eq $true) { $set.WakeToRun = $true }
  New-ScheduledTaskSettingsSet @set
}

foreach ($t in $tasks) {
  $installed = Get-Installed $t
  $parts = Get-ActionParts $installed ($t.hidden -eq $true)
  $trig = Get-Trigger $t.trigger   # a bad trigger fails the dry run too, not only -Apply
  $settings = Get-TaskSettings $t
  $llm = if ($t.llm -eq $true) { 'true' } else { 'false' }
  $battery = if ($settings.DisallowStartIfOnBatteries -or $settings.StopIfGoingOnBatteries) { 'block' } else { 'allow' }
  $wake = if ($settings.WakeToRun) { 'yes' } else { 'no' }
  Write-Host ("{0}: {1} {2}  [{3}, limit {4} min, llm={5} battery={6} wake={7}]" -f $t.name, $parts[0], $parts[1], $t.trigger, $t.execLimitMin, $llm, $battery, $wake)
  if ($trig.Repetition -and $trig.Repetition.Interval) { Write-Host ("  repeat: every {0}, duration '{1}'" -f $trig.Repetition.Interval, $trig.Repetition.Duration) }
  if ($t.wake -eq $true -and $t.llm -ne $true -and $t.battery -ne $true) { Write-Host "[WARN] $($t.name): wake=true needs llm=true or battery=true. A task that is blocked on battery is stopped at once, so the wake does nothing there." }
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { Write-Host "  [MISSING] $installed"; continue }
  if (-not $Apply) { continue }
  $action = New-ScheduledTaskAction -Execute $parts[0] -Argument $parts[1] -WorkingDirectory $ClaudeHome
  Register-ScheduledTask -TaskName $t.name -Action $action -Trigger (Get-Trigger $t.trigger) -Settings $settings -Force | Out-Null
  Write-Host '  registered'
}

if (-not $Apply) { Write-Host 'DRY RUN: nothing changed. Pass -Apply to register.' }
exit 0
