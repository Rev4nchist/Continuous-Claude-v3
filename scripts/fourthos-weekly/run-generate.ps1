# run-generate.ps1 -- BOUNDED launcher for the FourthOS weekly headless claude -p.
#
# WHY THIS EXISTS. scheduled-fourthos-weekly.bat used to run the generate as a
# bare cmd pipe:  type <prompt> | call claude -p ... > <log> 2>&1
# That pipe has NO ceiling of its own. The Windows Task Scheduler
# ExecutionTimeLimit (PT2H on CCv3-FourthOS-Weekly) was the only bound, and a
# task-limit kill is the WORST way to stop this run for two measured reasons:
#
#   1. It kills the wrapper, so the FINAL registry emit never runs and the
#      pessimistic pre-emit Failed row is all the period ever gets -- no reason
#      string, no verify classification.
#   2. It does not reliably reap the process TREE on this machine. Measured
#      2026-08-28 on the sibling CCv3-Health-Check task: ExecutionTimeLimit
#      PT30M fired at 10:25, and the orphaned python child kept running and
#      wrote its report at 11:49 (duration_s=6777 vs a normal 58). Same class
#      as the spawnSync leak that stranded 29 processes on 2026-07-25.
#
# So the bound is moved INSIDE the wrapper, where a timeout is survivable: this
# script kills the tree with taskkill /T /F and returns 124 (the GNU `timeout`
# convention), the .bat carries on, and verify-run.mjs + the final emit still
# record a truthful row.
#
# Pattern copied deliberately from scripts/sync-tasks-dashboard.ps1 (the proven
# bounded launcher on this machine) rather than invented: Start-Process,
# touch .Handle so .ExitCode survives, WaitForExit(ms), taskkill /T /F,
# Stop-Process fallback.
#
# PURE ASCII, no BOM: powershell.exe 5.1 decodes this file as CP1252, and a
# UTF-8 dash inside a double-quoted string terminates the string early.
#
# Exit codes: the child's own exit code, or 124 if the ceiling fired, or 125 if
# the launch itself threw.

param(
  [Parameter(Mandatory=$true)][string]$Prompt,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][string]$AllowedTools,
  [string]$AddDir = '',
  [int]$TimeoutSec = 3600,
  [string]$Exe = 'C:\Users\david.hayes\.local\bin\claude.exe'
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $Exe)) {
  $fallback = (Get-Command claude -ErrorAction SilentlyContinue)
  if ($fallback) { $Exe = $fallback.Source }
}
if (-not (Test-Path $Prompt)) {
  Write-Output "run-generate: prompt file not found: $Prompt"
  exit 125
}

# stdout and stderr need SEPARATE redirect targets: Start-Process refuses to
# point both at one file. They are concatenated into $Out afterwards, which
# preserves the .bat's existing contract that $Out holds the full capture and
# verify-run.mjs reads its sentinel line from there.
$stamp   = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$outFile = Join-Path $env:TEMP "ccv3-fourthos-out-$stamp.txt"
$errFile = Join-Path $env:TEMP "ccv3-fourthos-err-$stamp.txt"

$argList = @('-p', '--output-format', 'text')
if ($AddDir) { $argList += @('--add-dir', $AddDir) }
$argList += @('--allowedTools', $AllowedTools)

$code = 125
try {
  $proc = Start-Process -FilePath $Exe -ArgumentList $argList `
    -RedirectStandardInput $Prompt -RedirectStandardOutput $outFile `
    -RedirectStandardError $errFile -NoNewWindow -PassThru
  # Touch .Handle so .ExitCode stays readable after exit (PS -PassThru quirk).
  $null = $proc.Handle
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    $code = 124
    Write-Output "run-generate: TIMEOUT after ${TimeoutSec}s -- killing the process TREE (pid $($proc.Id))"
    # taskkill /T (tree), NOT Stop-Process: Stop-Process kills only the named
    # process and claude's node hook children would orphan permanently.
    try { & taskkill.exe /T /F /PID $proc.Id 2>&1 | Out-Null } catch { }
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    try { $proc.WaitForExit(15000) | Out-Null } catch { }
  } else {
    $code = $proc.ExitCode
  }
} catch {
  Write-Output "run-generate: launch threw: $_"
  $code = 125
}

# Concatenate captures into the wrapper's single log file. Overwrite (not
# append): the .bat's old `>` semantics for this file are preserved, and the
# pre-emit keeps its own separate .pre-emit.txt for exactly that reason.
#
# BYTE-EXACT, not Get-Content/Set-Content. Found by the stubbed-copy probe on
# 2026-08-31: the text path decodes the child's UTF-8 bytes as CP1252 under
# powershell.exe 5.1 and writes them back mojibaked (an em dash became three
# characters in the captured prompt). The pipe this replaced was raw byte
# passthrough, so a text roundtrip is a REGRESSION the .bat never had.
# verify-run.mjs only greps ASCII sentinels so classification survived either
# way -- the damage is to the human-readable half of the log, which is the only
# record of WHY a week failed.
$bytes = New-Object System.Collections.Generic.List[byte]
foreach ($f in @($outFile, $errFile)) {
  if (Test-Path $f) {
    try { $bytes.AddRange([System.IO.File]::ReadAllBytes($f)) } catch { }
  }
}
if ($code -eq 124) {
  $tail = "`r`nfourthos-weekly: FAILED reason=generate-timeout-${TimeoutSec}s`r`n"
  $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes($tail))
}
[System.IO.File]::WriteAllBytes($Out, $bytes.ToArray())

foreach ($f in @($outFile, $errFile)) {
  Remove-Item $f -Force -ErrorAction SilentlyContinue
}

exit $code
