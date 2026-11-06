<#
.SYNOPSIS
  List bash processes that look stuck. Never kills anything.

.WHY
  When MSYS cohort initialization goes wrong, the affected bash processes do
  not all die loudly. Some block, burning no CPU, and never exit. Measured
  2026-07-26: a single trial left 51 live bash processes, 46 of them untracked
  descendants, all at ~0 CPU, still there ten minutes later.

  This script shows which bash processes match that shape. It is a report, not
  a cleanup.

.SAFETY
  List-only. The script has no kill path. The old force switch was retired on
  2026-11-05, and passing it fails with an unknown-parameter error.

  The filter is weak. A process is listed when it is BOTH older than
  -OlderThanSeconds AND under -MaxCpuSeconds of CPU time. The filter cannot
  tell a stuck shell from a live peer-session shell. A shell that waits on a
  child that does the work also sits at ~0 CPU, and it is listed too. It also
  sees only bash.exe, never sh.exe or other MSYS binaries. Read the output as
  incomplete and as a list of suspects, never as proof.

  Before any manual kill, check the owner of each PID by its parent chain
  (and its CreationDate, because PIDs are reused). Kill only a leaf orphan, by
  explicit PID. See docs/windows/msys-fork-storm-investigation.md and
  .claude/docs/windows/platform-notes.md.

.EXAMPLE
  pwsh -File scripts/msys/reap.ps1                       # list what looks stuck
  pwsh -File scripts/msys/reap.ps1 -OlderThanSeconds 600 # a stricter age cut
#>
# CmdletBinding makes an unknown parameter such as the retired force switch an error.
# Without it, PowerShell puts the unknown name into $args and the script runs.
[CmdletBinding()]
param(
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

Write-Host "[reap] bash alive: $($all.Count), suspects by filter (age > ${OlderThanSeconds}s AND cpu < ${MaxCpuSeconds}s): $($candidates.Count)"
if ($candidates.Count -eq 0) { exit 0 }

$candidates | Sort-Object AgeSeconds -Descending | Format-Table -AutoSize | Out-String | Write-Host

Write-Host "[reap] list only. Nothing was killed. Verify the owner of each PID by its parent chain before any manual kill." -ForegroundColor Yellow
exit 0
