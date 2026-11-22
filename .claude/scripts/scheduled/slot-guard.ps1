# Slot guard for daily scheduled wrappers (card sched-tasks-failing-1109). Dot-sourced by scheduled-lane-snapshot.ps1 and
# scheduled-cost-reconcile.ps1. Runs under Windows PowerShell 5.1: no PS7-only syntax here. ASCII only.
#
# Why: a daily task at 23:55 that the machine misses (Modern Standby) starts as a catch-up inside a short wake, and the
# standby ends it (result 267014, 0x41306). The task gets a second daily trigger at a time the machine is awake (tasks.json
# "catchUp"). Every trigger runs the same wrapper. The wrapper runs only when the most recent slot (the daily time of the main
# trigger) has no completed run:
#   marker  <state dir>\<task>.done.json  {"doneAt": "<local time>", "slot": "<HH:mm>"}
#   done    the marker doneAt is at or after the most recent slot time
#   the normal run at its own slot time is never skipped: its most recent slot is "now", and no marker is that new
#
# Environment overrides (tests, hand runs):
#   CCV3_SLOT_STATE_DIR   marker folder. Default: next to the log (<log dir>\slot-state) when a log override is set, so a test
#                         never writes to the real state; else ~\.claude\state\scheduled
#   CCV3_SLOT_NOW         "now" as a local ISO time, e.g. 2026-11-22T07:35:00
#   CCV3_SLOT_FORCE=1     run whatever the marker says (a hand test or a forced rerun)

$script:SlotCulture = [System.Globalization.CultureInfo]::InvariantCulture

function Get-SlotNow {
  if ($env:CCV3_SLOT_NOW) { return [datetime]::Parse($env:CCV3_SLOT_NOW, $script:SlotCulture) }
  return Get-Date
}

# The most recent time at or before $now whose clock reading is $hhmm.
function Get-LastSlot([datetime]$now, [string]$hhmm) {
  $t = [datetime]::ParseExact($hhmm, 'HH:mm', $script:SlotCulture)
  $slot = $now.Date.AddHours($t.Hour).AddMinutes($t.Minute)
  if ($slot -gt $now) { $slot = $slot.AddDays(-1) }
  return $slot
}

function Get-SlotStateDir([string]$logDir, [bool]$logOverride) {
  if ($env:CCV3_SLOT_STATE_DIR) { return $env:CCV3_SLOT_STATE_DIR }
  if ($logOverride) { return (Join-Path $logDir 'slot-state') }
  return (Join-Path $env:USERPROFILE '.claude\state\scheduled')
}

# The doneAt time of the marker, or $null when the file is missing, unreadable or has no usable doneAt.
function Read-SlotDoneAt([string]$marker) {
  try {
    $j = Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json
    return [datetime]::Parse([string]$j.doneAt, $script:SlotCulture)
  } catch { return $null }
}

# $true when the marker shows a completed run at or after $slot. CCV3_SLOT_FORCE=1 always gives $false.
function Test-SlotDone([string]$marker, [datetime]$slot) {
  if ($env:CCV3_SLOT_FORCE -eq '1') { return $false }
  $done = Read-SlotDoneAt $marker
  return ($null -ne $done -and $done -ge $slot)
}

function Set-SlotDone([string]$marker, [string]$hhmm, [datetime]$now) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
    $body = '{"doneAt":"' + $now.ToString('s', $script:SlotCulture) + '","slot":"' + $hhmm + '"}'
    Set-Content -LiteralPath $marker -Value $body -Encoding ASCII
  } catch { }
}
