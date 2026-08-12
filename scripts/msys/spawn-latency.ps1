<#
.SYNOPSIS
  Measure process-spawn latency for node and MSYS bash, serially and safely.

.WHY
  The msys-fork-storm lane has assumed a CONCURRENCY cause: two MSYS processes
  cold-starting together race the mount-table spinlock in shared.cc. But the
  crash telemetry does not behave like a race. It behaves like weather:
  2026-07-29 saw every git-safe commit crash between 08:28 and 11:29, then a
  clean window 11:33-12:21 with zero crashes across five commits, then crashing
  again from 14:30. Concurrency was not obviously different across those windows.

  The spinlock in shared.cc GIVES UP AFTER 15 SECONDS. That timeout is only
  reachable if the first process is slow inside the critical section -- so
  degraded spawn latency would MANUFACTURE the race rather than merely coincide
  with it. machine-spawn-latency-pathology already measured bare `node -e 0`
  spawn at p50 814ms and later 2,167ms against a healthy 30-80ms on this box.

  So: does spawn latency track the crash windows? This samples it without
  storming the machine -- strictly SERIAL, no bursts, no circuit breaker needed.
  That is the whole point: repro.ps1 answers "can I break it", this answers
  "what is the machine doing right now", and only the second one can be run
  safely at any time, including inside a crash window.

.USAGE
  pwsh -File scripts/msys/spawn-latency.ps1 [-N 20] [-Json <path>] [-Label <tag>]
#>
param(
    [int]$N = 20,
    [string]$Json,
    [string]$Label = 'adhoc'
)

function Measure-Spawn {
    param([string]$Name, [scriptblock]$Invoke, [int]$Count)
    $samples = New-Object System.Collections.Generic.List[double]
    $failures = 0
    for ($i = 0; $i -lt $Count; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $out = & $Invoke 2>&1 | Out-String
            $sw.Stop()
            # An MSYS init crash is not a latency sample -- it is the outcome we
            # are trying to predict. Count it, never average it in.
            if ($out -match 'fatal error - add_item|cygheap base mismatch|unable to remap') {
                $failures++
                continue
            }
            if ($LASTEXITCODE -ne 0) { $failures++; continue }
        } catch {
            $sw.Stop(); $failures++; continue
        }
        $samples.Add($sw.Elapsed.TotalMilliseconds)
    }
    $sorted = $samples | Sort-Object
    $pct = {
        param($p)
        if ($sorted.Count -eq 0) { return $null }
        $idx = [Math]::Min($sorted.Count - 1, [Math]::Floor($p * $sorted.Count))
        [Math]::Round($sorted[$idx], 1)
    }
    [pscustomobject]@{
        probe    = $Name
        n        = $Count
        ok       = $samples.Count
        crashed  = $failures
        p50      = & $pct 0.50
        p90      = & $pct 0.90
        max      = if ($sorted.Count) { [Math]::Round($sorted[-1], 1) } else { $null }
    }
}

$results = @()
$results += Measure-Spawn -Name 'node -e 0' -Count $N -Invoke { & node -e "0" }
$results += Measure-Spawn -Name 'bash -c true' -Count $N -Invoke { & bash -c "true" }
# git rev-parse is what BOTH git hooks call first, so it is the spawn that
# actually sits on the critical path of every commit in this repo.
$results += Measure-Spawn -Name 'git rev-parse' -Count $N -Invoke { & git rev-parse --show-toplevel }

$snapshot = [pscustomobject]@{
    ts         = (Get-Date).ToString('o')
    label      = $Label
    bash_alive = (Get-Process bash -ErrorAction SilentlyContinue | Measure-Object).Count
    node_alive = (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count
    probes     = $results
}

$results | Format-Table -AutoSize
"bash_alive={0}  node_alive={1}  label={2}" -f $snapshot.bash_alive, $snapshot.node_alive, $Label

# Healthy reference from machine-spawn-latency-pathology: 30-80ms for a bare
# spawn. Degraded observations there were p50 814ms and 2,167ms.
$nodeP50 = ($results | Where-Object probe -eq 'node -e 0').p50
if ($nodeP50 -ne $null) {
    $verdict = if ($nodeP50 -lt 150) { 'HEALTHY' } elseif ($nodeP50 -lt 600) { 'ELEVATED' } else { 'DEGRADED' }
    "VERDICT $verdict (node p50 ${nodeP50}ms; healthy reference 30-80ms)"
}

if ($Json) {
    $dir = Split-Path -Parent $Json
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $Json -Value ($snapshot | ConvertTo-Json -Depth 5 -Compress) -Encoding utf8
}
