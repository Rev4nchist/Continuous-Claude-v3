<#
.SYNOPSIS
  Find and kill bash processes that are stuck rather than working.

.WHY
  When MSYS cohort initialization goes wrong, the affected bash processes do not
  all die loudly. Some block, burning no CPU, and never exit. Measured
  2026-07-26: a single trial left 51 live bash processes, 46 of them untracked
  descendants, all at ~0 CPU, still there ten minutes later.

  Killing them by hand is one command, but only if you already know that is the
  problem. This script is that command, with the judgement built in.

.SAFETY
  Dry-run by default -- it prints what it would kill and exits without doing it.
  -Force is required to actually terminate anything.

  Two filters keep it off legitimate work. A process must be BOTH older than
  -OlderThanSeconds AND under -MaxCpuSeconds of CPU time. A bash process doing
  real work (a sync, a build) accumulates CPU and is left alone no matter how
  long it has been running; a genuinely blocked one has essentially none.

  Kills are tree kills (taskkill /T). Killing the parent alone leaves exactly
  the untracked descendants that made the pile-up hard to clear.

.EXAMPLE
  pwsh -File scripts/msys/reap.ps1                 # show what is stuck
  pwsh -File scripts/msys/reap.ps1 -Force          # clear it
#>
param(
    [switch]$Force,
    [int]$OlderThanSeconds = 120,
    [double]$MaxCpuSeconds = 2.0
)

$all = @(Get-Process bash -ErrorAction SilentlyContinue)
if ($all.Count -eq 0) {
    Write-Host "[reap] no bash processes running." -ForegroundColor DarkGray
    exit 0
}

$now = Get-Date
$candidates = @()
foreach ($p in $all) {
    try {
        $age = ($now - $p.StartTime).TotalSeconds
        # CPU is null for processes we cannot open; treat that as "unknown", and
        # unknown is not evidence of being stuck, so skip it.
        $cpu = $p.CPU
        if ($null -eq $cpu) { continue }
        if ($age -gt $OlderThanSeconds -and $cpu -lt $MaxCpuSeconds) {
            $candidates += [pscustomobject]@{ Id = $p.Id; AgeSeconds = [int]$age; Cpu = [math]::Round($cpu, 2) }
        }
    } catch {
        # A process that exited between the enumeration and this read is not stuck.
    }
}

Write-Host "[reap] bash alive: $($all.Count), stuck by filter (age > ${OlderThanSeconds}s AND cpu < ${MaxCpuSeconds}s): $($candidates.Count)"
if ($candidates.Count -eq 0) { exit 0 }

$candidates | Sort-Object AgeSeconds -Descending | Format-Table -AutoSize | Out-String | Write-Host

if (-not $Force) {
    Write-Host "[reap] dry run. Re-run with -Force to kill these." -ForegroundColor Yellow
    exit 0
}

$killed = 0
foreach ($c in $candidates) {
    & taskkill /PID $c.Id /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $killed++ }
}

Start-Sleep -Seconds 1
$remaining = @(Get-Process bash -ErrorAction SilentlyContinue).Count
Write-Host "[reap] killed $killed tree(s); bash alive now: $remaining" -ForegroundColor Green
