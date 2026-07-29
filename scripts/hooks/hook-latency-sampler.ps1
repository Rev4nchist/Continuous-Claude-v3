<#
.SYNOPSIS
  Sample REAL hook processes while genuine turns happen. Step 6 of the repair plan.

.WHY THIS EXISTS
  Every prior per-hook latency number in this investigation was taken by piping a
  synthetic payload -- `tool_name:"__probe__"` -- straight into a dist bundle. That
  trips each hook's first guard, so the measurement captured the cost of a hook
  DECIDING NOT TO RUN. It was reported as per-turn cost, and the conclusions drawn
  from it ("~1.15s per Bash call", "97% is five hooks") were refuted on exactly
  that basis. A no-op-payload latency assertion is explicitly rejected by the plan.

  This watches the hooks Claude Code actually spawns, on actual tool calls, with
  whatever payload the harness really sends.

.HOW IT MEASURES, AND WHAT THAT IS WORTH
  Win32_ProcessStartTrace needs elevation and we do not have it, so this polls.
  Two consequences, both reported rather than hidden:

    START is EXACT      -- taken from the OS (Process.StartTime), not from when
                           the sampler noticed.
    END is BOUNDED      -- we know the process was alive at lastSeen and gone by
                           the next poll, so duration is [lastSeen-start,
                           polledGone-start]. Both bounds are emitted.
    SHORT HOOKS CAN BE  -- anything that starts and exits entirely between two
    MISSED ENTIRELY        polls is invisible. So the fan-out counts here are
                           LOWER BOUNDS on how many hooks fired, never upper.

  CommandLine costs a CIM query, so it is fetched ONCE per new pid and cached.
  The liveness loop itself uses Get-Process, which is cheap enough to poll hard.

.PARAMETER Seconds     how long to sample
.PARAMETER OutFile     JSONL output, one record per observed process
.PARAMETER IntervalMs  target poll interval
#>
param(
  [int]$Seconds = 180,
  [string]$OutFile = "$env:TEMP\hook-latency-samples.jsonl",
  [int]$IntervalMs = 15
)

$ErrorActionPreference = 'SilentlyContinue'
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

# pid -> record
$seen = @{}
$deadline = (Get-Date).AddSeconds($Seconds)
$polls = 0
$startedAt = Get-Date

function Resolve-HookName([string]$cmdline) {
  if (-not $cmdline) { return $null }
  # dist bundles, and the python braintrust hook (5 of the 86 registrations)
  if ($cmdline -match '([A-Za-z0-9._-]+)\.mjs') { return $Matches[1] }
  if ($cmdline -match 'braintrust_hooks\.py\s+(\w+)') { return "braintrust_hooks:$($Matches[1])" }
  if ($cmdline -match '([A-Za-z0-9._-]+)\.py') { return $Matches[1] }
  return $null
}

while ((Get-Date) -lt $deadline) {
  $polls++
  $now = Get-Date
  $live = @{}

  foreach ($p in Get-Process -Name node, python -ErrorAction SilentlyContinue) {
    $live[$p.Id] = $true
    if (-not $seen.ContainsKey($p.Id)) {
      # one CIM hit per NEW pid only
      $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
      $cmd = $ci.CommandLine
      $hook = Resolve-HookName $cmd
      # Hoisted: `try` is a statement, not an expression, so it cannot live
      # inside a hashtable literal. StartTime throws for processes we cannot
      # open; falling back to `now` makes that record a lower bound, not a lie.
      $st = $now
      try { if ($p.StartTime) { $st = $p.StartTime } } catch { $st = $now }
      $shortCmd = $null
      if ($cmd) { $shortCmd = $cmd.Substring(0, [Math]::Min(220, $cmd.Length)) }
      $seen[$p.Id] = [pscustomobject]@{
        pid       = $p.Id
        hook      = $hook
        isHook    = [bool]$hook
        cmd       = $shortCmd
        start     = $st
        lastSeen  = $now
        gone      = $null
        emitted   = $false
      }
    } else {
      $seen[$p.Id].lastSeen = $now
    }
  }

  # anything we were tracking that is no longer live has exited
  foreach ($k in @($seen.Keys)) {
    $r = $seen[$k]
    if (-not $live.ContainsKey($k) -and -not $r.emitted) {
      $r.gone = $now
      $r.emitted = $true
      if ($r.isHook) {
        $lower = ($r.lastSeen - $r.start).TotalMilliseconds
        $upper = ($r.gone - $r.start).TotalMilliseconds
        ([pscustomobject]@{
          pid        = $r.pid
          hook       = $r.hook
          startIso   = $r.start.ToString('o')
          ms_lower   = [Math]::Round($lower, 1)
          ms_upper   = [Math]::Round($upper, 1)
          cmd        = $r.cmd
        } | ConvertTo-Json -Compress) | Add-Content -Path $OutFile
      }
    }
  }

  Start-Sleep -Milliseconds $IntervalMs
}

# flush anything still running at the deadline (partial, marked as such)
foreach ($k in @($seen.Keys)) {
  $r = $seen[$k]
  if (-not $r.emitted -and $r.isHook) {
    ([pscustomobject]@{
      pid = $r.pid; hook = $r.hook; startIso = $r.start.ToString('o')
      ms_lower = [Math]::Round((($r.lastSeen - $r.start).TotalMilliseconds), 1)
      ms_upper = $null; cmd = $r.cmd; stillRunningAtEnd = $true
    } | ConvertTo-Json -Compress) | Add-Content -Path $OutFile
  }
}

$elapsed = ((Get-Date) - $startedAt).TotalSeconds
$hookProcs = ($seen.Values | Where-Object { $_.isHook }).Count
Write-Output "sampler done: ${elapsed}s, $polls polls (~$([Math]::Round($elapsed*1000/$polls,1))ms actual interval), $($seen.Count) processes seen, $hookProcs were hooks -> $OutFile"
