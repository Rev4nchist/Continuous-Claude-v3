<#
.SYNOPSIS
  Sample machine state to disk every N seconds so the NEXT crash leaves evidence.

.WHY
  On 2026-07-27 at 13:31:13 this box died with Kernel-Power 41 BugcheckCode=0:
  no WER 1001 event, no minidump, no WHEA hardware error, no thermal event, no
  resource-exhaustion event. It was logging normally 3.5 minutes earlier. That
  combination is unanalyzable after the fact BY DEFINITION - this class of death
  writes no dump, so there is nothing to read afterwards no matter how carefully
  you look. Seven earlier crashes were GPU bugchecks (0x116 / 0x10E) and did
  leave dumps; this one is a different animal and left nothing at all.

  The only way to learn anything about the next one is to have been writing the
  evidence down BEFORE it happens. Same principle the conflict-events lane rests
  on: a block or a stale takeover that is computed and thrown away is not
  recoverable later, and a day not instrumented is a day gone.

.THE ONE DESIGN RULE THAT MATTERS
  EVERY SAMPLE IS FLUSHED TO DISK IMMEDIATELY. AppendAllText opens, writes and
  closes per line. A buffered writer would keep the final and most interesting
  seconds in memory, where a hard hang destroys exactly the samples you wanted.
  Do not "optimize" this into a StreamWriter held open across the loop.

.WHAT IT IS NOT
  Not a fix, and not a diagnosis. It is the instrument that makes the next crash
  diagnosable. It is read-only, needs no elevation, and touches no machine state.

.USAGE
  Sample (run in background, one line every 30s):
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\machine\crash-telemetry.ps1

  Read back what the machine looked like before the last death:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\machine\crash-telemetry.ps1 -Report

.NOTES
  PowerShell 5.1 compatible on purpose - scheduled tasks on this machine run
  powershell.exe 5.1, not pwsh 7, and 5.1-only constructs have silently broken
  three wrappers here before. ASCII only for the same reason: a UTF-8 dash
  inside a double-quoted string breaks the 5.1 parser under CP1252.
#>

param(
    [switch]$Report,
    [int]$IntervalSeconds = 30,
    [int]$ReportLines = 40,
    [string]$LogDir = "$env:USERPROFILE\.claude\logs\machine-telemetry"
)

$ErrorActionPreference = 'Continue'

function Get-LogPath {
    param([datetime]$When)
    Join-Path $LogDir ("telemetry-" + $When.ToString('yyyy-MM-dd') + ".jsonl")
}

# ---------------------------------------------------------------- REPORT MODE
if ($Report) {
    if (-not (Test-Path $LogDir)) {
        Write-Output "No telemetry directory yet: $LogDir"
        Write-Output "Nothing has been sampled. Start the sampler first."
        exit 0
    }

    $files = Get-ChildItem $LogDir -Filter 'telemetry-*.jsonl' -ErrorAction SilentlyContinue | Sort-Object Name
    if (-not $files) { Write-Output "No telemetry files in $LogDir"; exit 0 }

    Write-Output "=== BOOT HISTORY (a gap in samples that spans a boot IS the crash) ==="
    Get-WinEvent -FilterHashtable @{LogName='System'; Id=6008; StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue |
        ForEach-Object { "  UNEXPECTED SHUTDOWN :: " + ($_.Message -replace '\s+', ' ') }

    $os = Get-CimInstance Win32_OperatingSystem
    Write-Output ("  current boot        :: " + $os.LastBootUpTime)

    Write-Output ""
    Write-Output "=== LAST $ReportLines SAMPLES ==="
    $all = @()
    foreach ($f in $files) { $all += Get-Content $f.FullName -ErrorAction SilentlyContinue }
    $tail = $all | Select-Object -Last $ReportLines

    $prev = $null
    foreach ($line in $tail) {
        $o = $null
        try { $o = $line | ConvertFrom-Json } catch { continue }
        if (-not $o) { continue }

        # Marker rows carry no metrics. Render them as markers rather than as a
        # row of blanks - in a forensic file an ambiguous line is worse than none,
        # and "sampler restarted" vs "machine came back" is exactly the
        # distinction someone reading this after a crash needs to make.
        if ($o.event) {
            Write-Output ("  {0}  [{1}]{2}" -f ([datetime]$o.ts).ToString('MM-dd HH:mm:ss'), $o.event,
                $(if ($o.boot) { "  boot=" + ([datetime]$o.boot).ToString('MM-dd HH:mm:ss') } else { "  " + $o.msg }))
            $prev = $o
            continue
        }

        # A gap much larger than the sample interval is where the machine stopped
        # being able to write. That boundary is the whole point of this file.
        if ($prev) {
            $gap = ([datetime]$o.ts - [datetime]$prev.ts).TotalSeconds
            if ($gap -gt ($IntervalSeconds * 3)) {
                Write-Output ("  *** GAP OF " + [math]::Round($gap) + "s -- machine stopped sampling here ***")
            }
        }
        Write-Output ("  {0}  cpu={1,3}%  freeGB={2,5}  procs={3,4}  node={4,3} bash={5,3} git={6,3}  pwr={7}  top={8}" -f `
            ([datetime]$o.ts).ToString('MM-dd HH:mm:ss'), $o.cpuPct, $o.freeGB, $o.procCount,
            $o.nodeCount, $o.bashCount, $o.gitCount, $o.power, $o.topProc)
        $prev = $o
    }

    Write-Output ""
    Write-Output "=== HOW TO READ THIS ==="
    Write-Output "  Find the GAP line. The samples immediately BEFORE it are the last known"
    Write-Output "  state of the machine. Rising cpuPct, falling freeGB, or a climbing"
    Write-Output "  node/bash/git count in those final samples points at resource pressure."
    Write-Output "  Flat, healthy numbers right up to the gap point AWAY from load and"
    Write-Output "  toward a power or firmware level event."
    exit 0
}

# ---------------------------------------------------------------- SAMPLE MODE
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

Write-Output "crash-telemetry sampling every ${IntervalSeconds}s"
Write-Output "  -> $(Get-LogPath (Get-Date))"
Write-Output "  Ctrl-C to stop. Each line is flushed immediately."

# Marker so a reader can tell "sampler restarted" from "machine came back".
$startRow = [ordered]@{
    ts    = (Get-Date).ToString('o')
    event = 'sampler_start'
    boot  = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
}
[System.IO.File]::AppendAllText((Get-LogPath (Get-Date)), (($startRow | ConvertTo-Json -Compress) + "`n"))

while ($true) {
    $now = Get-Date
    try {
        $os   = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
        $cpu  = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
        $procs = Get-Process -ErrorAction SilentlyContinue
        $top  = $procs | Sort-Object WorkingSet64 -Descending | Select-Object -First 3

        $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        # BatteryStatus 2 == running on AC. Anything else means it is on battery,
        # which matters: a machine that dies on battery is a different story.
        $power = 'unknown'
        if ($bat) { if ($bat.BatteryStatus -eq 2) { $power = "AC/$($bat.EstimatedChargeRemaining)%" } else { $power = "BATT/$($bat.EstimatedChargeRemaining)%" } }

        $tempC = $null
        try {
            $tz = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1
            if ($tz) { $tempC = [math]::Round(($tz.CurrentTemperature / 10) - 273.15, 1) }
        } catch { $tempC = $null }

        $row = [ordered]@{
            ts         = $now.ToString('o')
            cpuPct     = [int]$cpu
            freeGB     = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
            totalGB    = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
            commitGB   = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB, 2)
            procCount  = @($procs).Count
            nodeCount  = @($procs | Where-Object { $_.Name -eq 'node' }).Count
            bashCount  = @($procs | Where-Object { $_.Name -eq 'bash' }).Count
            gitCount   = @($procs | Where-Object { $_.Name -like 'git*' }).Count
            handleSum  = ($procs | Measure-Object -Property HandleCount -Sum).Sum
            power      = $power
            tempC      = $tempC
            topProc    = (($top | ForEach-Object { "$($_.Name):$([math]::Round($_.WorkingSet64/1GB,2))G" }) -join ',')
        }

        # Flush per line. See the design rule in the header: this is deliberate.
        [System.IO.File]::AppendAllText((Get-LogPath $now), (($row | ConvertTo-Json -Compress) + "`n"))
    }
    catch {
        # A sampling failure must never kill the sampler - a dead instrument
        # tells you nothing, and it fails silently, which is worse.
        try {
            $err = [ordered]@{ ts = $now.ToString('o'); event = 'sample_error'; msg = $_.Exception.Message }
            [System.IO.File]::AppendAllText((Get-LogPath $now), (($err | ConvertTo-Json -Compress) + "`n"))
        } catch { }
    }

    Start-Sleep -Seconds $IntervalSeconds
}
