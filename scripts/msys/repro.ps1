<#
.SYNOPSIS
  Reproduce the MSYS "add_item ... failed, errno 1" cohort-init crash, and
  measure whether a mitigation changes the rate.

.WHY
  windows-platform.md recorded this crash as "not reproducible on demand" --
  synthetic bursts of N identical bash processes failed all-or-nothing and
  sporadically (48/48 failed, then 64/64 passed minutes later). That made the
  earlier warm-keeper A/B worthless: zero failures in BOTH arms proves nothing.

  Bursts of identical processes are the wrong shape. The crash was observed
  2026-07-26 while a bash cold-start happened alongside an ALREADY-RUNNING MSYS
  cohort -- a git hook chain, not a burst. This harness reproduces that shape:
  a long-lived bash holding a cohort open while short-lived bash processes
  cold-start into it.

.PARAMETER Trials
  Number of independent trials. Each trial is one long-lived bash plus -Cold
  short-lived cold starts launched against it.

.PARAMETER Cold
  Short-lived bash cold starts launched per trial.

.PARAMETER HoldSeconds
  How long the long-lived bash stays alive holding the cohort.

.PARAMETER Warm
  Start a persistent MSYS process BEFORE the trials and keep it for their whole
  duration. This is the mitigation under test: if the shared-memory region never
  becomes unowned, no cohort should have to initialize it, and the crash rate
  should drop. Run with and without to A/B.

.EXAMPLE
  pwsh -File scripts/msys/repro.ps1 -Trials 10
  pwsh -File scripts/msys/repro.ps1 -Trials 10 -Warm
#>
param(
    [int]$Trials = 10,
    [int]$Cold = 4,
    [int]$HoldSeconds = 3,
    [switch]$Warm,
    # Abort the whole run if live bash processes exceed this. See the circuit
    # breaker below for why this is not optional.
    [int]$MaxBashAlive = 25
)

. (Join-Path $PSScriptRoot '..\lib\Stop-ProcessTree.ps1')

$BashExe = "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
if (-not (Test-Path $BashExe)) {
    Write-Error "bash not found at $BashExe"
    exit 2
}

# The DLL-init failure signature. NOT a bash script error -- these strings come
# out of msys-2.0.dll before bash reads anything.
$Signature = 'fatal error - add_item|cygheap base mismatch|unable to remap'

$warmProc = $null
if ($Warm) {
    # A process that does nothing but stay alive, so the MSYS shared-memory
    # region always has an owner and never needs re-initializing by a new cohort.
    $warmProc = Start-Process -FilePath $BashExe -ArgumentList '-c', 'sleep 3600' -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "[repro] warm keeper pid=$($warmProc.Id)" -ForegroundColor DarkCyan
}

$crashed = 0
$results = @()

try {
    for ($t = 1; $t -le $Trials; $t++) {
        $outFiles = @()
        $procs = @()

        # BOTH streams must be redirected. Redirecting only stderr leaves the
        # child's stdout bound to a handle nothing drains, and the bash processes
        # block on write instead of exiting -- 48 of them piled up on the first
        # version of this harness and looked exactly like an MSYS hang. They were
        # not: they vanished the instant the parent was killed. A harness that
        # manufactures the symptom it is measuring is worse than no harness.
        $holdOut = [System.IO.Path]::GetTempFileName()
        $holdErr = [System.IO.Path]::GetTempFileName()
        $outFiles += $holdOut, $holdErr
        $procs += Start-Process -FilePath $BashExe `
            -ArgumentList '-c', "sleep $HoldSeconds; echo hold-done" `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $holdOut -RedirectStandardError $holdErr

        # Short-lived cold starts arriving while that cohort is live. Each runs a
        # NESTED bash, because the observed crash came from a hook that shells out
        # again -- the nested start is a second cold start inside the same window.
        for ($c = 1; $c -le $Cold; $c++) {
            $o = [System.IO.Path]::GetTempFileName()
            $e = [System.IO.Path]::GetTempFileName()
            $outFiles += $o, $e
            $procs += Start-Process -FilePath $BashExe `
                -ArgumentList '-c', "bash -c 'echo inner-$c'" `
                -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $o -RedirectStandardError $e
            Start-Sleep -Milliseconds 40
        }

        # A bounded wait, then force-reap the whole TREE.
        #
        # Stop-Process kills only the named pid. This harness's processes do not
        # stay a tidy list of 5: a storming trial produced 51 live bash processes,
        # 46 of them descendants this script never had a handle on, and the
        # per-pid reap sailed straight past them. Same spawn-tree leak already
        # recorded for spawnSync -- Stop-ProcessTree is the safe way to get the
        # descendants (the OS tree switch is banned: pid reuse kills live shells).
        foreach ($p in $procs) {
            if (-not $p.WaitForExit(20000)) {
                Write-Host "  [repro] pid $($p.Id) did not exit in 20s - killing tree" -ForegroundColor Yellow
                $null = Stop-ProcessTree -RootId $p.Id
            }
        }

        # Circuit breaker. Without this the harness can leave the machine with
        # dozens of blocked bash processes -- it did, twice, before this existed.
        # A measurement tool that degrades the system it measures is not a
        # measurement tool.
        #
        # The breaker stops ONLY the process trees this run started: the trial's
        # $procs and the warm keeper. It never kills a bash it did not start.
        # The live count includes peer-session shells, and a shell that merely
        # waits looks the same as a stuck one, so the count is a reason to stop,
        # not a list of targets. A process that already exited is skipped.
        $alive = @(Get-Process bash -ErrorAction SilentlyContinue)
        if ($alive.Count -gt $MaxBashAlive) {
            Write-Warning "[repro] ABORT: $($alive.Count) bash processes alive (cap $MaxBashAlive). Stopping only the process trees this run started; other bash processes are left alone."
            $own = @($procs)
            if ($warmProc) { $own += $warmProc }
            foreach ($p in $own) {
                if ($p.HasExited) { continue }
                $null = Stop-ProcessTree -RootId $p.Id
            }
            $results += [pscustomobject]@{ trial = $t; crashed = $true; aborted = $true }
            break
        }

        $text = ($outFiles | ForEach-Object { Get-Content $_ -Raw -ErrorAction SilentlyContinue }) -join "`n"
        $outFiles | ForEach-Object { Remove-Item $_ -Force -ErrorAction SilentlyContinue }

        $hit = $text -match $Signature
        if ($hit) { $crashed++ }
        $results += [pscustomobject]@{ trial = $t; crashed = $hit }
        Write-Host ("  trial {0,2}: {1}" -f $t, $(if ($hit) { 'CRASH' } else { 'ok' })) -ForegroundColor $(if ($hit) { 'Red' } else { 'DarkGray' })
    }
}
finally {
    if ($warmProc) {
        Stop-Process -Id $warmProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[repro] warm keeper stopped" -ForegroundColor DarkCyan
    }
}

$rate = if ($Trials -gt 0) { [math]::Round($crashed / $Trials, 3) } else { 0 }
[pscustomobject]@{
    arm          = if ($Warm) { 'warm-keeper' } else { 'baseline' }
    trials       = $Trials
    cold_per_trial = $Cold
    hold_seconds = $HoldSeconds
    crashed      = $crashed
    crash_rate   = $rate
} | ConvertTo-Json -Compress
